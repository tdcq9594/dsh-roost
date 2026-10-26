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
// ⚠️ 群聊默认也给本地工具（shell / 文件），这是明确选的配置。
//    意味着群里任何人都能通过对话读这台机器的文件、执行命令。
//    config.json 里 `chat.toolsInGroup` 改成 false 可以关掉。

import { loadConfig, saveConfig, publicConfig, dataDir } from './config.js';
import { createSessions } from './sessions.js';
import { createTurnRunner } from './turn.js';
import { createInboundServer, postReply } from './server.js';
import { renderInbound, chatOf } from './inbound.js';

export const name = 'roost';

/** agents / sessions 拿会话；systemPrompt 注人格；webServer 给面板接口 */
export const inject = ['agents', 'sessions', 'systemPrompt', 'webServer'];

const API = '/roost/api';

/** 群聊里要收走的工具（toolsInGroup=false 时生效） */
const GROUP_DENY = ['bash', 'pwsh', 'shell', 'fs', 'fs-search', 'fs_search', 'web', 'web-fetch'];

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

  /** 已经挂过人格/工具限制的 agent，避免每轮重复挂 */
  const mounted = new WeakSet();
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

  /** 挂人格；群聊且关了工具时收走本地工具 */
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

    if (chat.kind !== 'c2c' && cfg.chat.toolsInGroup === false) {
      try {
        offs.push(agent.ctx.tools.restrict({ deny: GROUP_DENY }));
      } catch (e) {
        log.warn('收走群聊本地工具失败：', e.message);
      }
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
    try {
      const { agent, sessionId } = await agentFor(chat);
      mount(agent, chat);

      const text = renderInbound(payload);
      const reply = await turns.run(agent, text, {
        source: { kind: 'roost', chatId: chat.chatId, msgId: payload.id },
      });

      await postReply(payload, reply, true);
      lastTurn = { at: Date.now(), chatId: chat.chatId, ms: Date.now() - started, ok: true, len: reply.length };
      log.info(
        `${chat.chatId.slice(0, 8)} 会话 ${sessionId.slice(-8)} 回了 ${reply.length} 字 · ${Date.now() - started}ms`,
      );
    } catch (e) {
      lastTurn = { at: Date.now(), chatId: chat.chatId, ms: Date.now() - started, ok: false, error: e?.message ?? String(e) };
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
          toolsInGroup: cfg.chat.toolsInGroup !== false,
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
