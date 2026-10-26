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
import { createSetup } from './setup.js';
import { createPersonas } from './personas.js';
import { createStickers } from './stickers.js';
import { createSpeakUp } from './speakup.js';
import { createLease, candidates } from './lease.js';

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
  /**
   * 最近的动静，面板「日志」页读它。
   *
   * 内存环形缓冲就够：用户要看的是「刚才那条为什么没回」，
   * 不是三个月前的审计记录。完整日志还在 DSH 自己的日志里。
   */
  const logs = [];
  function addLog(level, area, text) {
    logs.push({ time: new Date().toTimeString().slice(0, 8), at: Date.now(), level, area, text: String(text) });
    if (logs.length > 400) logs.shift();
  }

  const raw = makeLogger(ctx);
  // 包一层：所有走 log.* 的都同时进面板日志
  const log = {
    debug: raw.debug,
    info: (m) => { raw.info(m); addLog('info', 'core', m); },
    warn: (m) => { raw.warn(m); addLog('warn', 'core', m); },
    error: (m) => { raw.error(m); addLog('error', 'core', m); },
  };
  let cfg = loadConfig();

  const sessions = createSessions({ dataDir: dataDir(), log: (m) => log.warn(m) });
  const turns = createTurnRunner({ ctx, log, timeoutSec: cfg.chat.turnTimeoutSec });

  /** 人格库：正文在 personas/*.md 里，配置只记用哪个 */
  const personas = createPersonas({ dataDir: dataDir(), log: (m) => log.warn(m) });

  /** 表情包：只做「把清单写进提示词」，发图复用已有的 <<image:>> */
  const stickers = createStickers({ dataDir: dataDir(), log: (m) => log.warn(m) });

  /**
   * 主动搭话：算好「该说话了」→ 跑一轮 DSH 生成一句 → 让 ai-chat 发出去。
   *
   * 为什么发消息要绕一圈找 ai-chat：主动消息只能由持有 QQ 连接的一方发，
   * dsh-roost 没有 api。所以 ai-chat 开了 `POST /send`，这里去调它。
   */
  const speakUp = createSpeakUp({
    dataDir: dataDir(),
    cfgOf: () => cfg,
    log: (m) => log.info(m),
    generate: async (prompt) => {
      const chat = { kind: 'c2c', chatId: cfg.speakUp?.chatId || 'speakup', name: '主动搭话', preset: 'roost-private' };
      const { agent } = await agentFor(chat);
      mount(agent, chat);
      return turns.run(agent, prompt, { source: { kind: 'roost-speakup' } });
    },
    send: async (payload) => {
      const url = `${setup.baseUrl()}/api/plugins/ai-chat/r/send${setup.keyQuery()}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      return r.json().catch(() => ({ ok: false, message: 'ai-chat 没回话' }));
    },
  });

  /** 一键流程：装 Roost、配插件、起停、打开面板 */
  const setup = createSetup({
    cfgOf: () => cfg,
    // 面板改配置时要同时更新这里的 cfg 引用，否则下次 detect 还是旧路径
    setCfg: (patch) => (cfg = saveConfig(patch)),
    dataDir: dataDir(),
    log: (m) => log.info(m),
  });

  /** 每分钟问一次「该说话了吗」。unref 是为了不拖住进程退出 */
  const speakTimer = setInterval(() => speakUp.tick().catch(() => {}), 60_000);
  speakTimer.unref?.();

  /** 已经挂过人格/权限上下文的 agent，避免每轮重复挂 */
  /** 端口租约：跟 Roost 互通「实际在哪个端口」 */
  const lease = createLease({ file: join(dataDir(), 'ports.json'), log: (m) => log.warn(m) });

  const mounted = new WeakSet();
  /** mount() 挂上去的取消函数。不能在 mount 里调 ctx.onTeardown，见下面注释 */
  const mountOffs = [];

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
            /**
             * 人格正文在文件里（`personas/*.md`），配置只记「用哪个」。
             * 按群覆盖 > 全局当前 > default；指定的文件被删了会静默回退。
             */
            const persona = personas.resolve(chat.chatId, p);
            const extra = chat.kind === 'c2c' ? p.rulesPrivate : p.rulesSocial;
            return [
              `你现在叫「${persona.name}」。`,
              persona.body,
              extra,
              p.text, // 旧配置里的追加内容，留着兼容
            ]
              .filter(Boolean)
              .join('\n');
          },
        }),
      );
    } catch (e) {
      log.debug('挂人格失败：', e.message);
    }

    /**
     * 插件推过来的系统提示词。
     *
     * **必须用**：动作标记（skip / remember / image / button）的契约写在里面，
     * 宿主自己另写一份人格就等于让这些标记全部失效。
     * 之前就是这个 bug——DSH 模式下模型完全不知道有标记可用。
     *
     * order 900：排在人格（905）前面，先立规矩再谈性格。
     */
    const sid0 = agent?.session?.id;
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-plugin-prompt',
          order: 900,
          text: () => {
            const cur = sid0 ? speaker.get(sid0) : null;
            return cur?.system ? String(cur.system) : '';
          },
        }),
      );
    } catch (e) {
      log.warn('挂插件提示词失败：', e.message);
    }

    /** 表情包清单：让 AI 知道有哪些图可用（没有图就不注入） */
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-stickers',
          order: 901,
          text: () => stickers.prompt(cfg.stickers),
        }),
      );
    } catch (e) {
      log.warn('挂表情包清单失败：', e.message);
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
    /**
     * **不能在这里调 `ctx.onTeardown`。**
     *
     * mount() 是收到消息时才惰性跑的（新会话的第一句），
     * 而 DSH 只允许在**插件激活阶段**访问这些能力。在消息处理里碰它会被拒：
     * 「cannot get property onTeardown without inject」——
     * 而且这个异常会把整条消息吞掉，表现是「每个新会话第一句都不回」。
     *
     * 改成把取消函数收进 mountOffs，由激活时注册的清理统一处理。
     */
    mountOffs.push(...offs);
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

      // 主人自己说话了 → 主动搭话重新排期
      if (chat.kind === 'c2c') speakUp.noteOwner(chat.chatId);

      // 告诉 AI 谁在说话（软提醒，每轮现读）
      speaker.set(sid, { payload, bucket, system: payload.system || '' });

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
        // 插件下载好的图片块，让模型真的看得见图
        images: payload.images ?? [],
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

    /**
     * 候选端口：配置里的 → 上次实际用的 → 往后 +1 一直到 +20。
     *
     * 「上次实际用的」放前面，是为了重启后尽量落回同一个端口——
     * 用户可能在书签/反代里记着它。
     */
    const want = cfg.server.port;
    const list = candidates(want, lease.actualOf('dsh'));

    server = createInboundServer({
      port: want,
      ports: list,
      token: cfg.server.token,
      onInbound,
      log: (m) => log.info(m),
      /**
       * bind 成功后：写租约 + 同步 ai-chat。
       *
       * ai-chat 在 Roost 进程里，它读不到租约，只能被主动通知——
       * 不通知的话它还往旧端口推，connection refused，两边都不报错。
       */
      onListening: (actual) => {
        lease.claim('dsh', { want, actual });
        if (actual !== want) log.warn(`dsh-roost 换到 ${actual}（${want} 被占），正在通知 ai-chat`);
        syncAdapterPort(actual).catch((e) => log.warn(`通知 ai-chat 失败：${e.message}`));
      },
    });
  }

  /** 把 ai-chat 的 dshUrl 指到实际端口。只在它已经配过 DSH 时改 */
  async function syncAdapterPort(actual) {
    try {
      const r = await setup.syncDshUrl(actual);
      if (r && !r.ok && !r.skipped) log.warn(`ai-chat 的地址没同步：${r.message}`);
    } catch (e) {
      log.warn(`ai-chat 的地址没同步：${e?.message ?? e}`);
    }
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
        /**
         * body 是 undefined 时必须兜一个 {}。
         *
         * `JSON.stringify(undefined)` 返回 undefined，`res.end(undefined)` 写出**空 body**，
         * 前端 `r.json()` 就会报 `Unexpected end of JSON input`——
         * 表现是「连不上插件」，但其实是某个接口少返回了一个值。
         */
        res.end?.(JSON.stringify(body === undefined ? { ok: true } : body));
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
          listening: Boolean(server?.listening),
          serverError: server?.lastError || '',
          wantPort: cfg.server.port,
          actualPort: server?.actualPort || 0,
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
        const beforePort = cfg.server.port;
        cfg = saveConfig(body);
        // 端口/密钥变了要重起服务；人格和开关下一轮自然生效
        startServer();

        /**
         * 端口变了必须回头改 ai-chat 的 DSH 地址。
         *
         * 不改的话：我们监听新端口，ai-chat 还往旧端口推 —— connection refused，
         * 而且两边都不报错，表现就是「突然不回话了」。这种静默断链最坑。
         */
        let syncNote = '';
        if (cfg.server.port !== beforePort) {
          const r = await setup.syncDshUrl();
          syncNote = r?.ok
            ? (r.skipped ? '' : '；' + r.message)
            : '；但 ai-chat 没同步（' + (r?.message || '未知') + '）';
        }

        return send(res, 200, { ok: true, config: publicConfig(cfg), message: '已保存，服务已重载' + syncNote });
      }),
      /**
       * 一键流程的接口。
       *
       * 都是「跑一个动作，返回结果」，没有状态机——每一步都能单独重试，
       * 用户跳着点也不会把东西搞坏（每步自己先检测前置条件）。
       */
      route('/setup', (req, res) => setup.detect().then((s) => send(res, 200, { ok: true, ...s }))),

      route('/setup/install', (req, res) => setup.install().then((r) => send(res, 200, r))),

      route('/setup/dir', async (req, res) => {
        const b = await readBody(req);
        return send(res, 200, setup.setDir(b.dir));
      }),

      route('/setup/bot', async (req, res) => {
        const b = await readBody(req);
        return send(res, 200, await setup.createBot(b));
      }),

      route('/setup/start', (req, res) => setup.start().then((r) => send(res, 200, r))),
      route('/setup/stop', (req, res) => setup.stop().then((r) => send(res, 200, r))),
      route('/setup/plugin', (req, res) => setup.installPlugin().then((r) => send(res, 200, r))),
      route('/setup/configure', (req, res) => setup.configurePlugin().then((r) => send(res, 200, r))),

      route('/setup/webui', (req, res) => send(res, 200, { ok: true, url: setup.webuiUrl() })),

      route('/speakup', (req, res) =>
        send(res, 200, { ok: true, state: speakUp.state(), cfg: cfg.speakUp }),
      ),

      route('/speakup/fire', async (req, res) => send(res, 200, await speakUp.fire('手动'))),

      route('/stickers', (req, res) =>
        send(res, 200, { ok: true, dir: stickers.dir(cfg.stickers), items: stickers.list(cfg.stickers) }),
      ),

      route('/personas', (req, res) => send(res, 200, { ok: true, personas: personas.list(), current: cfg.persona?.current || 'default', byChat: cfg.persona?.byChat || {} })),

      route('/personas/save', async (req, res) => {
        const b = await readBody(req);
        if (!b.id) return send(res, 400, { ok: false, message: '缺 id' });
        personas.save(b.id, b.raw ?? '');
        return send(res, 200, { ok: true, message: '已保存', id: b.id });
      }),

      route('/personas/remove', async (req, res) => {
        const b = await readBody(req);
        return send(res, 200, { ok: true, ...personas.remove(b.id) });
      }),

      route('/logs', (req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        const limit = Math.min(400, Number(u.searchParams.get('limit')) || 200);
        const level = u.searchParams.get('level') || '';
        const items = level ? logs.filter((e) => e.level === level) : logs;
        return send(res, 200, { ok: true, entries: items.slice(-limit) });
      }),

      /**
       * 自测：不经过 QQ，直接跑一轮 DSH 对话。
       *
       * 验的是链路里最容易坏的那段——会话能不能建、AI 能不能回、
       * 回复能不能取到。QQ 那半边（收消息、发消息）它测不到，
       * 那部分出问题会在日志里看到。
       */
      route('/selftest', async (req, res) => {
        const started = Date.now();
        try {
          const chat = { kind: 'c2c', chatId: 'selftest', name: '自测', preset: 'roost-private' };
          const { agent } = await agentFor(chat);
          mount(agent, chat);
          const reply = await turns.run(agent, '这是一条自测消息。请用一句话回答：你收到我了吗？', {
            source: { kind: 'roost-selftest' },
          });
          addLog('info', 'selftest', `自测通过：${reply.slice(0, 80)}`);
          return send(res, 200, { ok: true, reply, ms: Date.now() - started });
        } catch (e) {
          addLog('error', 'selftest', `自测失败：${e?.message ?? e}`);
          return send(res, 500, { ok: false, message: e?.message ?? String(e), ms: Date.now() - started });
        }
      }),
    ];

    return () => {
      clearInterval(speakTimer);
      // offs 是路由表（不是函数）；真正要取消的是 mount() 挂上去的那些上下文
      for (const off of mountOffs) {
        try {
          off?.();
        } catch {}
      }
    };
  }, 'dsh-roost: 面板接口');
}
