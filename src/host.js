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

import { join } from 'node:path';
import { loadConfig, saveConfig, publicConfig, dataDir } from './config.js';
import { createSessions } from './sessions.js';
import { createTurnRunner } from './turn.js';
import { createInboundServer, postReply } from './server.js';
import { renderInbound, chatOf } from './inbound.js';
import { bucketOf, modeFor, describeSpeaker, rulesFor, LOCAL_TOOLS } from './permissions.js';
import { createSetup } from './setup.js';
import { createMemory } from './memory.js';
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

  /** 最近一次的场景快照：给 roost-scene 和 /mind 调试接口用 */
  let lastScene = null;

  /** 动态块的字数硬上限（token 预算的粗护栏，先粗后细） */
  const SCENE_MAX = 240;
  const MEMORY_MAX = 600;

  const memory = createMemory();

  /**
   * 记忆块：两层分开标，并给一句"能不能说"的规则。
   *
   * 记忆跨群之后，最大的风险是串场——A 群的内部梗拿到 B 群说。
   * 所以这里不只给内容，还要给边界。
   */
  function memoryText() {
    const chatId = lastScene?.chatId || '';
    const m = memory.list(chatId);
    if (!m.global.length && !m.chat.length) return '';
    const parts = [];
    if (m.global.length) parts.push(`【你记得的事（通用）】\n${m.global.map((f) => `· ${f}`).join('\n')}`);
    if (m.chat.length) parts.push(`【这个群特有的事】\n${m.chat.map((f) => `· ${f}`).join('\n')}`);
    parts.push('记着的事可以拿来用，但**只在这个群发生过的事别拿到别处说**；判断不了就当作不知道。');
    return clip(parts.join('\n\n'), MEMORY_MAX);
  }

  /**
   * 把回复里的记忆标记摘出来执行，返回干净文本。
   *
   * 标记是模型写在回复里的，所以只能等回复到手再处理。
   * 摘干净再发出去——群里不该看到 `<<remember: ...>>`。
   */
  function applyMemoryMarkers(text, chatId) {
    let out = String(text ?? '');
    let touched = '';

    out = out.replace(/<<remember-here:\s*([\s\S]*?)>>/gi, (_, v) => {
      const f = String(v || '').trim();
      if (f) {
        memory.add(chatId, f, 'chat');
        touched = '记住了（只这个群）';
      }
      return '';
    });

    out = out.replace(/<<remember:\s*([\s\S]*?)>>/gi, (_, v) => {
      const f = String(v || '').trim();
      if (f) {
        memory.add(chatId, f, 'global');
        touched = '记住了';
      }
      return '';
    });

    out = out.replace(/<<persona:\s*([\s\S]*?)>>/gi, (_, v) => {
      const t = String(v || '').trim();
      if (t) {
        memory.setPersonaOverride(chatId, t);
        touched = '人设改了（只这个群）';
      }
      return '';
    });

    out = out.replace(/<<clear>>/gi, () => {
      memory.clearChat(chatId);
      memory.setPersonaOverride(chatId, '');
      touched = '清了这个群的记忆和人设';
      return '';
    });

    out = out.replace(/<<forget:\s*([\s\S]*?)>>/gi, (_, v) => {
      const n = memory.remove(chatId, String(v || '').trim());
      if (n) touched = `忘掉了 ${n} 条`;
      return '';
    });

    return { text: out.trim(), touched };
  }


  /** 裁到上限，超了加省略号 */
  function clip(text, max) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
  }

  /**
   * 场景块：告诉模型「你现在在哪、跟谁说话」。
   *
   * 官方**没有群号**，只有群 openid（每个机器人独立、不可读），
   * 所以标识用「群名 + openid 前 8 位」，不要写"群号 xxx"。
   */
  function sceneText() {
    const s = lastScene;
    if (!s) return '';
    const isGroup = s.kind === 'group';
    const parts = [
      isGroup
        ? `你现在在 QQ 群${s.name ? `「${s.name}」` : ''}里说话（群标识 ${s.idShort}）。这是群聊，不是私聊。`
        : `你现在在和${s.name ? `「${s.name}」` : '对方'}私聊（标识 ${s.idShort}）。`,
    ];
    if (s.sender) parts.push(`刚说话的是「${s.sender}」${s.bucket ? `（${s.bucket}）` : ''}。`);
    if (isGroup) parts.push('群里可能还有别人在聊，不必每句都接；接不上就不说。');
    return clip(parts.join(''), SCENE_MAX);
  }

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
            // 按群覆盖优先（模型用 <<persona:>> 写的），没有才用文件里那个人格
            const override = memory.getPersonaOverride(chat.chatId);
            const extra = chat.kind === 'c2c' ? p.rulesPrivate : p.rulesSocial;
            return [
              `你现在叫「${persona.name}」。`,
              override ? `（本群临时人设）\n${override}` : persona.body,
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
     * **场景**：告诉 AI「你现在在哪个群 / 这是私聊 / 刚说话的是谁」。
     *
     * 为什么需要：`chat.name` 一直传给了宿主，但从来没进过提示词——
     * 于是模型根本不知道自己在一个群里，也不知道对面是谁。
     * 表现就是「对谁都一个腔调」，像客服。
     *
     * 注意：官方**没有群号**，只有群 openid（每个机器人独立、不可读）。
     * 所以这里只能给「群名 + openid 前 8 位」当标识，别写成"群号 123456"。
     *
     * order 902：在表情包之后、身份之前。场景是"当下"，不该压过身份。
     */
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-scene',
          order: 902,
          text: () => sceneText(),
        }),
      );
    } catch (e) {
      log.warn('挂场景提示失败：', e.message);
    }

    /**
     * **记忆**：order 903，紧跟场景。
     *
     * 记忆已经从 ai-chat 挪到这边了——情绪要调制它、抽取要调模型，
     * 两者必须同处一地。ai-chat 那边只留通道，不再存记忆。
     */
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-memory',
          order: 903,
          text: () => memoryText(),
        }),
      );
    } catch (e) {
      log.warn('挂记忆提示失败：', e.message);
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
      // 场景快照：roost-scene 和 /mind 都读它
      lastScene = {
        at: Date.now(),
        kind: chat.kind,
        chatId: chat.chatId,
        name: String(chat.name || '').trim(),
        idShort: String(chat.chatId || '').slice(0, 8),
        sender: String(payload?.sender?.name || '').trim(),
        bucket,
      };

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
      const rawReply = await turns.run(agent, text, {
        source: { kind: 'roost', chatId: chat.chatId, msgId: payload.id },
        // 插件下载好的图片块，让模型真的看得见图
        images: payload.images ?? [],
      });

      /**
       * 记忆标记在这里处理，**不在 ai-chat 那边**。
       *
       * 记忆已经归 dsh-roost 了（情绪要调制它、抽取要调模型），
       * 所以「模型说记住了什么」也该由这边落盘，然后把标记从回复里摘掉，
       * 发到群里的就是干净的一句话。
       */
      const { text: reply, touched } = applyMemoryMarkers(rawReply, chat.chatId);
      if (touched) log.info(`记忆：${touched}`);

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
       * **会话被归档了要自动恢复。**
       *
       * 主人把 DSH 里的对话归档之后，我们还在往那个会话里推消息——
       * DSH 直接判 `requires_action`（turn/end 的 kind 是 blocked），
       * 表现就是「这一轮没正常结束（blocked）」，而且会一直失败。
       *
       * 这里把绑定清掉（sessionId 置空），下一条消息会自动开新会话。
       */
      if (e?.kind === 'blocked') {
        try {
          sessions.set(chat.chatId, '', { preset: chat.preset, title: chat.name });
          log.warn(`会话被归档或需要人工处理，已解绑 ${chat.chatId.slice(0, 8)}，下一条开新会话`);
        } catch {}
      }

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
            : e?.kind === 'blocked'
              ? '这条对话在 DSH 里被归档了，我开个新的——再说一遍就行。'
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

    /**
     * 注册一条路由。
     *
     * **单条失败不能拖死整个插件**：如果上一次激活的清理没跑干净
     * （0.5.5 那个 bug 就是），DSH 会在这里抛
     * `duplicate exact route "..."`，整个 apply 直接中断——
     * 于是连收消息服务都起不来，17321 根本没人听。
     *
     * 现在改成：这条注册不上就跳过并记日志，其余照常。
     * 代价是那一两个接口 404，但插件整体能起来，比全死强。
     */
    const route = (path, handler) => {
      try {
        return ctx.webServer.register({
          kind: 'exact',
          path: API + path,
          handler: (req, res) =>
            Promise.resolve(handler(req, res)).catch((e) => send(res, 500, { ok: false, message: e.message })),
        });
      } catch (e) {
        log.warn(`路由 ${path} 没注册上（可能上次激活没清理干净，重启 DSH 可解决）：${e?.message ?? e}`);
        return () => {};
      }
    };

    const offs = [
      route('/status', (req, res) =>
        send(res, 200, {
          ok: true,
          /**
           * 这里 `server` 是 createInboundServer 返回的**包装对象**，
           * 不是 net.Server——真正的 server 在 `server.server` 里。
           * 之前写成 `server?.listening` 永远是 undefined，
           * 于是日志说「监听成功」、红条却说「端口没起来」，自相矛盾。
           */
          listening: Boolean(server?.server?.listening),
          serverError: server?.lastError || '',
          wantPort: cfg.server.port,
          // actualPort 是个函数，忘了加括号会得到「函数本身」（JSON 里直接消失）
          actualPort: server?.actualPort?.() ?? 0,
          port: cfg.server.port,
          tokenSet: Boolean(cfg.server.token),
          chats: sessions.size,
          waiting: turns.waiting,
          permissions: cfg.permissions,
          lastTurn,
        }),
      ),

      /**
       * 心智状态调试接口。
       *
       * 情绪/记忆都是看不见的状态，没有这个接口，
       * 改完只能凭感觉判断好像有点不一样——既调不准也回不了滚。
       */
      /** 记忆：查看 / 手动加 / 从旧版导入 */
      route('/memory', (req, res) => {
        const chatId = lastScene?.chatId || '';
        send(res, 200, { ok: true, chatId, ...memory.list(chatId) });
      }),

      route('/memory/add', async (req, res) => {
        const body = await readBody(req);
        const fact = String(body.fact ?? '').trim();
        if (!fact) return send(res, 400, { ok: false, message: '缺 fact' });
        memory.add(String(body.chatId ?? lastScene?.chatId ?? ''), fact, body.scope === 'chat' ? 'chat' : 'global');
        send(res, 200, { ok: true });
      }),

      /**
       * 从旧版导入：记忆以前放在 ai-chat 的 storage 里，
       * 升级后要搬过来，别让用户白记。幂等，重复导不会重复。
       */
      route('/memory/import', async (req, res) => {
        const body = await readBody(req);
        const n = memory.import(body ?? {});
        log.info(`从旧版导入记忆 ${n} 条`);
        send(res, 200, { ok: true, imported: n });
      }),

      route('/mind', (req, res) => {
        const text = sceneText();
        send(res, 200, {
          ok: true,
          scene: lastScene
            ? { ...lastScene, text }
            : null,
          lastTurn,
          budgets: { sceneMax: SCENE_MAX, sceneLen: text.length },
        });
      }),

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

      // 扫码建机器人：转发给框架（协议/密钥/二维码都在那边，这里不重实现）
      route('/setup/qr/start', (req, res) =>
        setup.qrStart().then((r) => send(res, 200, { ok: true, ...r })).catch((e) => send(res, 502, { ok: false, message: e.message })),
      ),
      route('/setup/qr/poll', async (req, res) => {
        const body = await readBody(req);
        try {
          const r = await setup.qrPoll(String(body.taskId ?? '').trim());
          send(res, 200, { ok: true, ...r });
        } catch (e) {
          send(res, 502, { ok: false, message: e.message });
        }
      }),

      route('/setup/start', (req, res) => setup.start().then((r) => send(res, 200, r))),
      route('/setup/stop', (req, res) => setup.stop().then((r) => send(res, 200, r))),
      route('/setup/plugin', (req, res) => setup.installPlugin().then((r) => send(res, 200, r))),
      // 传实际监听的端口：端口被占会顺延，写配置值的话 ai-chat 会连到错的端口
      route('/setup/configure', (req, res) =>
        setup.configurePlugin(server?.actualPort?.() || undefined).then((r) => send(res, 200, r))),

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
      /**
       * **两条都要清。**
       *
       * `offs` 是 `route()` 的返回值——也就是 `ctx.webServer.register()` 返回的
       * **取消订阅函数**。之前我误以为它是「路由表」，把这段删了，
       * 结果重载后同一路径注册两次，DSH 直接拒绝激活：
       *   `webserver: duplicate exact route "/roost/api/status"`
       * `mountOffs` 是 mount() 挂上去的权限上下文，也要一起清。
       */
      for (const off of [...offs, ...mountOffs]) {
        try {
          off?.();
        } catch {}
      }
      mountOffs.length = 0;
    };
  }, 'dsh-roost: 面板接口');
}
