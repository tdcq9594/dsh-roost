// dsh-roost · 宿主半边（DSH 插件入口）
//
// 角色：**被 ai-chat 推消息的宿主**，不碰 QQ。
//
//   QQ ⇄ Roost 内核 ⇄ ai-chat 插件 ⇄ POST /inbound ⇄ 本插件 ⇄ DSH 会话
//                                  ⇄ POST /reply  ⇄
//
// 收消息、整形、发消息、切段、防吵都在 ai-chat 那边；这边只做三件事：
//   1. 起一个固定端口的 HTTP 服务，等 ai-chat 推消息
//   2. 把消息喂给对应的 DSH 会话，等 AI 说完
//   3. 把回复发回 ai-chat 给的地址
//
// ⚠️ 权限按**每一条消息**判定：主人、管理员、普通成员拿到的工具不一样，
//    认不出身份的一律只给聊天。表在 config.json 的 `permissions` 里。

import { loadConfig, saveConfig, publicConfig, dataDir } from './config.js';
import { createSessions } from './sessions.js';
import { createTurnRunner } from './turn.js';
import { createInboundServer, postReply } from './server.js';
import { renderInbound, chatOf } from './inbound.js';
import { bucketOf, modeFor, describeSpeaker, rulesFor, LOCAL_TOOLS } from './permissions.js';

export const name = 'roost';

/** agents / sessions 拿会话；systemPrompt 注人格；webServer 给面板接口 */
export const inject = ['agents', 'sessions', 'systemPrompt', 'webServer'];

const API = '/roost/api';

function makeLogger(ctx) {
  const L = ctx.logger ?? console;
  const wrap = (fn) => (...args) => {
    try {
      ;(typeof fn === 'function' ? fn : console.log).apply(L, args);
    } catch {}
  };
  return { info: wrap(L.info), warn: wrap(L.warn), error: wrap(L.error), debug: wrap(L.debug) };
}

export function apply(ctx) {
  const log = makeLogger(ctx);
  let cfg = loadConfig();

  const sessions = createSessions({ dataDir: dataDir(), log: (m) => log.warn(m) });
  const turns = createTurnRunner({ ctx, log, timeoutSec: cfg.chat.turnTimeoutSec });

  /** 已经挂过人格/权限上下文的 agent，避免每轮重复挂 */
  const mounted = new WeakSet();

  /**
   * 当前这一轮是谁在说话。
   *
   * 为什么要一张表而不是直接塞进提示词：`systemPrompt.context` 是**注册一次、
   * 每轮现读**的，所以这里放一个可变状态，text() 里读最新值就行。
   * 同一会话的轮次是串行的（turn.js 有 busy 锁），不会有并发覆盖。
   *
   * @type {Map<string, {payload:object, bucket:string}>}
   */
  const speaker = new Map();

  let server = null;
  /** 最近一轮的耗时与结果，面板上显示用 */
  let lastTurn = null;

  /* ---------------- 宿主服务 ---------------- */

  function controller() {
    const c = ctx.get('sessionController');
    if (!c) throw new Error('宿主没有 sessionController（需要 DSH 桌面版 / Web 组合）');
    return c;
  }

  /** 给 QQ 会话找个 DSH 工作区。没有登记过就取第一个 */
  async function workspaceId() {
    const reg = ctx.get('workspaceRegistry');
    try {
      const list = (await reg?.list?.()) ?? [];
      if (list.length) return list[0].id;
    } catch {}
    throw new Error('宿主里没有可用工作区，先在 DSH 里打开一个项目');
  }

  async function resolveAgent(sid) {
    const live = ctx.agents.get(sid) || ctx.agents.get('session-' + sid);
    if (live) return live;
    const r = await controller().resolveAgent(sid);
    if (r?.agent) return r.agent;
    throw new Error(r?.error?.message || '恢复 DSH 会话失败');
  }

  /** 拿到这个 QQ 会话对应的活 agent（没有就建） */
  async function agentFor(chat) {
    const sid = sessions.get(chat.chatId);

    if (sid) {
      try {
        return { agent: await resolveAgent(sid), sessionId: sid };
      } catch (e) {
        log.warn(`${chat.chatId}：旧会话 ${sid.slice(-8)} 拉不起来了（${e.message}），重建`);
        sessions.remove(chat.chatId);
      }
    }

    const r = await controller().create({ workspaceId: await workspaceId(), agentPreset: chat.preset });
    const newSid = String(r.sessionId);
    try {
      await controller().rename({ sessionId: newSid, title: `QQ · ${chat.name || chat.chatId}` });
    } catch {}
    sessions.set(chat.chatId, newSid, { preset: chat.preset, title: chat.name });
    log.info(`为 ${chat.chatId} 新建 DSH 会话 ${newSid.slice(-8)}（${chat.preset}）`);
    return { agent: await resolveAgent(newSid), sessionId: newSid };
  }

  /** 挂人格 + 权限上下文（每个 agent 只挂一次，内容每轮现读） */
  function mount(agent, chat) {
    if (mounted.has(agent)) return;
    const offs = [];

    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-persona',
          order: 905,
          text: () => {
            const p = cfg.persona;
            const extra = chat.kind === 'c2c' ? p.rulesPrivate : p.rulesSocial;
            return [`你现在叫「${p.name}」。`, p.text, extra].filter(Boolean).join('\n');
          },
        }),
      );
    } catch (e) {
      log.debug('挂人格失败：', e.message);
    }

    /**
     * 每轮告诉 AI：这句话是谁说的、他能让你干到什么程度。
     *
     * 这是**软提醒**，硬限制在 onInbound 里（按档位收工具）。
     * 两层都要：工具没收干净时软提醒还在；模型被说服时硬限制还在。
     */
    const sid = agent?.session?.id;
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-permission',
          order: 906,
          text: () => {
            const cur = sid ? speaker.get(sid) : null;
            if (!cur) return '';
            return `${describeSpeaker(cur.payload, cur.bucket)}\n${rulesFor(cur.bucket)}`;
          },
        }),
      );
    } catch (e) {
      log.warn('挂权限上下文失败：', e.message);
    }

    mounted.add(agent);
    ctx.onTeardown?.(() => {
      for (const off of offs) {
        try {
          off?.();
        } catch {}
      }
    });
  }

  /* ---------------- 收消息 → 跑一轮 → 回话 ---------------- */

  async function onInbound(payload) {
    const chat = chatOf(payload);
    if (!chat.chatId) {
      log.warn('收到没有 chatId 的消息，忽略');
      return;
    }

    const started = Date.now();
    /** 这一句是谁说的、他能让 AI 干到什么程度 */
    const bucket = bucketOf(payload);
    let sid = '';
    let restore = null;

    try {
      const { agent, sessionId } = await agentFor(chat);
      sid = sessionId;
      mount(agent, chat);

      // 告诉 AI 谁在说话（软提醒，每轮现读）
      speaker.set(sid, { payload, bucket });

      /**
       * 硬限制：按档位收走本地工具。
       *
       * 只在「这一档不该用工具」时挂 restrict，轮末释放——
       * 所以同一个群里主人问完、路人接着问，权限是逐条生效的，
       * 不像 Aurabot 那样整群一个档位。
       */
      const mode = modeFor(bucket, cfg.permissions);
      if (mode === 'chat') {
        try {
          restore = agent.ctx.tools.restrict({ deny: LOCAL_TOOLS });
        } catch (e) {
          log.warn('收走本地工具失败：', e.message);
        }
      }

      const text = renderInbound(payload);
      const reply = await turns.run(agent, text, {
        source: { kind: 'roost', chatId: chat.chatId, msgId: payload.id },
      });

      await postReply(payload, reply, true);
      lastTurn = {
        at: Date.now(),
        chatId: chat.chatId,
        bucket,
        mode,
        ms: Date.now() - started,
        ok: true,
        len: reply.length,
      };
      log.info(
        `${chat.chatId.slice(0, 8)} 会话 ${sessionId.slice(-8)} [${bucket}/${mode}] 回了 ${reply.length} 字 · ${Date.now() - started}ms`,
      );
    } catch (e) {
      lastTurn = {
        at: Date.now(),
        chatId: chat.chatId,
        bucket,
        ms: Date.now() - started,
        ok: false,
        error: e?.message ?? String(e),
      };
      log.warn(`处理 ${chat.chatId.slice(0, 8)} 失败：${e?.message ?? e}`);

      /**
       * **出错也要回话**。
       *
       * 不回的话 ai-chat 那边会一直等到 180 秒超时，用户看到的是
       * 「宿主没回话」——比「这边出了点问题：xxx」难受得多。
       */
      const friendly =
        e?.kind === 'busy'
          ? '上一条还在想，稍等一下。'
          : e?.kind === 'timeout'
            ? '想太久了，先算了。'
            : `这边出了点问题：${e?.message ?? e}`;
      await postReply(payload, friendly, true).catch((err) => log.warn(`回话失败：${err.message}`));
    } finally {
      // 工具权限和「谁在说话」都要还原，别串到下一轮
      try {
        restore?.();
      } catch {}
      if (sid) speaker.delete(sid);
    }
  }

  /* ---------------- 起停 ---------------- */

  function startServer() {
    server?.close();
    server = createInboundServer({
      port: cfg.server.port,
      token: cfg.server.token,
      onInbound,
      log: (m) => log.info(m),
    });
  }

  ctx.effect(() => {
    startServer();
    return () => {
      server?.close();
      server = null;
      turns.dispose();
    };
  }, 'dsh-roost: 收消息服务');

  /* ---------------- 面板接口 ---------------- */

  ctx.effect(() => {
    const send = (res, code, body) => {
      try {
        res.statusCode = code;
        res.setHeader?.('content-type', 'application/json; charset=utf-8');
        res.setHeader?.('cache-control', 'no-store');
        res.end?.(JSON.stringify(body));
      } catch {}
    };

    const readBody = async (req) => {
      let s = '';
      try {
        for await (const c of req) s += c;
      } catch {}
      try {
        return JSON.parse(s || '{}');
      } catch {
        return {};
      }
    };

    const route = (path, handler) =>
      ctx.webServer.register({
        kind: 'exact',
        path: API + path,
        handler: (req, res) =>
          Promise.resolve(handler(req, res)).catch((e) => send(res, 500, { ok: false, message: e.message })),
      });

    const offs = [
      route('/status', (req, res) =>
        send(res, 200, {
          ok: true,
          listening: Boolean(server),
          port: cfg.server.port,
          tokenSet: Boolean(cfg.server.token),
          chats: sessions.size,
          waiting: turns.waiting,
          permissions: cfg.permissions,
          lastTurn,
        }),
      ),

      route('/chats', (req, res) => send(res, 200, { ok: true, chats: sessions.list() })),

      route('/chats/clear', async (req, res) => {
        const b = await readBody(req);
        const chatId = String(b.chatId ?? '');
        if (!chatId) return send(res, 400, { ok: false, message: '缺 chatId' });
        sessions.remove(chatId);
        return send(res, 200, { ok: true, message: '已清掉映射，下一句会新建会话' });
      }),

      route('/config', async (req, res) => {
        if (req.method === 'GET') return send(res, 200, { ok: true, config: publicConfig(cfg) });
        const body = await readBody(req);
        // 面板拿到的是打码后的密钥，原样提交回来时别把真密钥冲掉
        if (body?.server?.token === '******') delete body.server.token;
        cfg = saveConfig(body);
        // 端口/密钥变了要重起服务；人格和开关下一轮自然生效
        startServer();
        return send(res, 200, { ok: true, config: publicConfig(cfg), message: '已保存，服务已重载' });
      }),
    ];

    return () => {
      for (const off of offs) {
        try {
          off?.();
        } catch {}
      }
    };
  }, 'dsh-roost: 面板接口');
}
