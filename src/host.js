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
import { mkdirSync } from 'node:fs';
import { loadConfig, saveConfig, publicConfig, dataDir } from './config.js';
import { createSessions } from './sessions.js';
import { createTurnRunner } from './turn.js';
import { createInboundServer, postReply } from './server.js';
import { renderInbound, chatOf, speakerTag } from './inbound.js';
import { bucketOf, modeFor, describeSpeaker, rulesFor, planGuestTools } from './permissions.js';
import { createSetup } from './setup.js';
import { createMemory } from './memory.js';
import { createJournal } from './journal.js';
import { createGraph } from './graph.js';
import { createConsolidate } from './consolidate.js';
import { createEmbedder } from './embed.js';
import { createMood, parseMoodMark } from './mood.js';
import { createClosing, parseClose, acceptClose } from './closing.js';
import { createPersonas, legacyPersonaText } from './personas.js';
import { createPersonaRepo } from './persona-repo.js';
import { createUpdater } from './update.js';
import { createStickers } from './stickers.js';
import { registerMemoryTools } from './tools.js';
import { registerQqTools, buildAtPrefix } from './qq-tools.js';
import { createSpeakUp } from './speakup.js';
import { createAwake, readAgreements, groupCandidates } from './awake.js';
import { createCompact } from './compact.js';
import { createQqChannel, createChannelRegistry } from './channel.js';
import { createQrRegistration, createManualRegistration, createRegistrationRegistry } from './registration.js';
import { createLease, candidates } from './lease.js';
import { createSyncRetry } from './sync-retry.js';

export const name = 'roost';

/** agents / sessions 拿会话；systemPrompt 注人格；webServer 给面板接口 */
export const inject = ['agents', 'sessions', 'systemPrompt', 'webServer'];

const API = '/roost/api';

/**
 * 老会话没有 `kind` 字段，但有 preset。
 *
 * preset 是按群/私聊分的（roost-social 走群里的规则、roost-private 走私聊的），
 * 所以它能反推出 kind——用来给存量会话补上标签，不至于下拉里还是分不清。
 */
function kindFromPreset(preset) {
  if (preset === 'roost-social') return 'group';
  if (preset === 'roost-private') return 'c2c';
  return '';
}

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

  /**
   * 把日志参数拼成一行。
   *
   * 以前 `log.warn` 只取**第一个**参数，多传的直接丢掉。于是调用处写着
   * `log.warn('收走本地工具失败：', e.message)`——看起来完全正常，
   * 面板上却是「收走本地工具失败：」后面一片空白，等于什么都没说
   * （2026-10-28 实测，7 个调用点全踩了这个坑）。
   *
   * 与其把那 7 处逐个改成模板字符串（下次还会有人这么写），不如让这层
   * 跟 `console` 一样收可变参数。Error 取 message（有 stack 就用 stack，
   * 排查时能直接看到是哪一行），对象退化成 JSON。
   */
  const fmtLog = (a) => {
    if (a instanceof Error) return a.stack || a.message || String(a);
    if (a && typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return String(a ?? '');
  };
  const joinLog = (args) => args.map(fmtLog).filter(Boolean).join(' ');

  // 包一层：所有走 log.* 的都同时进面板日志
  const log = {
    debug: raw.debug,
    info: (...a) => { const m = joinLog(a); raw.info(m); addLog('info', 'core', m); },
    warn: (...a) => { const m = joinLog(a); raw.warn(m); addLog('warn', 'core', m); },
    error: (...a) => { const m = joinLog(a); raw.error(m); addLog('error', 'core', m); },
  };

  /**
   * 群友这一轮允许保留的工具。
   *
   * **白名单而不是黑名单**，这是关键。原来这里写死了一张黑名单：
   * `['bash','pwsh','shell','fs','fs-search','fs_search','web','web-fetch']`
   * ——按 OneBot 时代的想象写的。这版 DSH 里这些名字一个都不存在，
   * 而 `tools.restrict()` **会校验名字**，只要有一个对不上就整批拒绝：
   *
   *     tools.restrict() names unknown global tools "bash", "shell", …
   *
   * 结果是每次群友说话都失败一次，**权限从来没真正收住过**
   * （2026-10-28 面板日志实锤，之前一直被日志层吞掉看不见）。
   *
   * 黑名单还有第二个毛病：DSH 每加一个新工具就漏一个，而漏掉的正好是
   * 没人想起来补的那个。改成白名单 + fail-closed 之后，新工具默认是收走的。
   *
   * 名单本身在 `permissions.js` 的 `GUEST_KEEP_TOOLS`，算法在 `planGuestTools()`。
   */
  function restrictGuestTools(agent) {
    const t = agent?.ctx?.tools;
    if (!t || typeof t.restrict !== 'function') {
      return { ok: false, reason: '这个 agent 的 tools 服务没有 restrict（版本差异）' };
    }

    const plan = planGuestTools(t);
    if (!plan.ok) return plan;

    try {
      return { ok: true, off: t.restrict({ deny: plan.deny }), names: plan.deny };
    } catch (e) {
      return { ok: false, reason: `${e?.message || e}（清单：${plan.deny.join('、')}）` };
    }
  }
  let cfg = loadConfig();

  const sessions = createSessions({ dataDir: dataDir(), log: (m) => log.warn(m) });
  const turns = createTurnRunner({ ctx, log, timeoutSec: cfg.chat.turnTimeoutSec });

  /** 人格库：正文在 personas/*.md 里，配置只记用哪个 */
  const personas = createPersonas({ dataDir: dataDir(), log: (m) => log.warn(m) });

  /**
   * 人格仓库：从 dsh-roost 仓库的 `personas/` 一键更新本地人格库。
   *
   * 单独一个模块而不是塞进 `personas.js`：一个只管「本地文件怎么读写」，
   * 一个只管「怎么从网上拿」，混在一起以后想换源、加缓存策略都要动读写逻辑。
   * `sources` 允许配置覆盖，是为了国内用户能换镜像（跟插件市场一个思路）。
   */
  const personaRepo = createPersonaRepo({
    dataDir: dataDir(),
    personas,
    sources: cfg.persona?.repo?.sources,
    log: (m) => log.warn(m),
    // 换源成功这类「不是错误」的消息走 info：国内 GitHub 常年连不上，
    // 全打成 warn 的话面板上永远是两条红字，看着像功能坏了
    note: (m) => log.info(m),
  });

  /**
   * 本体自更新。
   *
   * `ctx` 传进去是为了 `ctx.get('pluginManager')`——**不能写进 inject**：
   * 老版本 DSH 没这个服务，写进 inject 会让插件直接激活失败，
   * 而 `ctx.get()` 拿不到只是"这个版本不支持自更新"。
   */
  const updater = createUpdater({
    ctx,
    registry: cfg.update?.registry,
    log: (m) => log.warn(m),
  });

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
    /**
     * 第 5 期起，这里不再是"照着固定 prompt 说一句"，而是**先问她要不要说**。
     *
     * 返回 `<<skip>>` 就是她的答案：不想说。`speakup.js` 认得这个标记，
     * 会当作正常结局重新排期、不占今日额度（`awake.enabled=false` 时退回老行为）。
     */
    generate: async (prompt) => {
      const a = { ...(cfg.awake ?? {}) };
      if (a.enabled === false) {
        const chat = { kind: 'c2c', chatId: cfg.speakUp?.chatId || 'speakup', name: '主动搭话', preset: 'roost-private' };
        const { agent } = await agentFor(chat);
        mount(agent, chat);
        return turns.run(agent, prompt, { source: { kind: 'roost-speakup' } });
      }
      const v = await awake.compose({ kind: 'c2c' });
      return v.speak ? v.text : '<<skip>>';
    },
    /** 发送统一走通道层，不再各处自己 fetch */
    send: async (payload) => channels.active().send(payload),
  });

  /** 一键流程：装 Roost、配插件、起停、打开面板 */
  const setup = createSetup({
    cfgOf: () => cfg,
    // 面板改配置时要同时更新这里的 cfg 引用，否则下次 detect 还是旧路径
    setCfg: (patch) => (cfg = saveConfig(patch)),
    /**
     * 传**函数**，不是 `dataDir()` 的返回值。
     *
     * `setup.js` 里是 `join(dataDir(), 'roost')` 这么用的（116/206/212/215 行），
     * 传字符串就抛 `dataDir is not a function`。这条只在「`setup.roostDir` 空着」
     * 时才走到——也就是全新用户第一次打开面板：/setup 直接 500，
     * 一键装也跟着抛。本机因为手填了 roostDir 提前 return，一直没暴露。
     */
    dataDir,
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

  /**
   * 公共行为基线。
   *
   * 为什么不写进每个人格文件：人格文件只管"这个人什么性格"，
   * "怎么说话才不讨厌"是所有人共用的。写 6 遍必然漂移——
   * 事实是上一版只有 default.md 有这几条，其余 5 个都缺。
   *
   * （这几条原本在 ai-chat 的 systemPrompt 里，那个配置项删掉之后
   *  就该落到这儿，否则换个人格就变成话痨/爱编。）
   */
  const PERSONA_BASE =
    '说话简短口语化，通常两三句话；不确定就直说不确定，不要编；' +
    '不用「作为 AI」「作为一个语言模型」这类说法。';

  let server = null;
  /** 最近一轮的耗时与结果，面板上显示用 */
  let lastTurn = null;

  /** 最近一次的场景快照：给 roost-scene 和 /mind 调试接口用 */
  let lastScene = null;

  /** 这一轮用户说的话（截断），世界书按它匹配触发词 */
  let lastMsgText = '';

  /** 动态块的字数硬上限（token 预算的粗护栏，先粗后细） */
  const SCENE_MAX = 240;
  /** 平时的记忆预算（只放检索命中 + 最近说的） */
  const MEMORY_MAX = 600;
  /**
   * 每 15 轮那次**全量**重注的预算。
   *
   * 比平时大一倍是刻意的：它 15 轮才来一次，摊下来每轮不到 80 字，
   * 比"每轮都给全量"便宜一个数量级，却能在上下文被压掉之后把细节铺回来。
   */
  const MEMORY_DEEP_MAX = 1200;

  const memory = createMemory();
  const mood = createMood();
  /** 对话收尾（只私聊）：记「收在哪 / 下次怎么接」，给下一轮和主动搭话用 */
  const closing = createClosing(() => cfg.closing);

  /* ---------------- 日记 / 图谱 / 巩固 ---------------- */

  /** 向量（可选）。没配 `memory.embedding` 时 enabled() 是 false，检索自动只用关键词 */
  const embedder = createEmbedder({
    cfgOf: () => cfg.memory?.embedding,
    log: (m) => log.warn(m),
  });

  /**
   * 日记：每次对话落一条，遗忘靠压缩不是删除。
   *
   * 为什么和 facts 分两个存储：facts 是"提炼过的结论"（几十条），
   * 日记是"发生过什么"（成千条，要检索）。混在 memory.json 里，
   * 一个是文件会无限长，另一个是每轮读全量会拖慢。
   */
  const journal = createJournal({
    file: join(dataDir(), 'journal.sqlite'),
    embed: embedder,
    log: (m) => log.warn(m),
  });

  /**
   * 知识图谱：三表 + 双时态。
   *
   * 抽错不怕——原始片段在 episode 表里，能重建。
   */
  const graph = createGraph({
    file: join(dataDir(), 'graph.sqlite'),
    log: (m) => log.warn(m),
  });

  /**
   * 每轮记忆注入用的临时状态：deep（这次要不要全量）+ hits（这一句检索到什么）。
   *
   * 为什么放这儿而不是现算：`systemPrompt.context` 的 text() 是**同步**的，
   * 而检索要 async（可能还要调向量接口）。所以检索在 onInbound 里先做好，
   * text() 只负责读。
   */
  const memState = new Map();

  /**
   * 每个会话聊到第几轮了 —— 用来算"这次要不要全量重注记忆"。
   *
   * 放内存不落盘：重启后从 1 重新数，第一次必然全量，
   * 这反而是对的（新进程没有上下文，正需要铺一次）。
   */
  const rounds = new Map();

  /**
   * 往日记里落一条。**任何失败都不许影响这一轮对话。**
   *
   * 日记是"第二天还是同一个人"的基础，但它坏了不该让人连话都说不了。
   */
  function journalAdd(payload, chat, text, role) {
    if (cfg.memory?.enabled === false) return;
    try {
      const base = String(payload?.id ?? '').trim();
      /**
       * 这一轮对应事件账本里的哪几条（场景片段，阶段 4）。
       *
       * 合并窗口攒过几句时是多条——一批消息合成一轮对话，出处也该是这一批。
       * 没开事件账本时这个数组是空的，日记照写，只是以后查不回原文。
       */
      const eventIds = (Array.isArray(payload?.eventIds) ? payload.eventIds : [])
        .map(String)
        .filter(Boolean);
      journal.add({
        // 没有 msg_id 时给空串，journal 内部会生成随机 id（宁可重复也不丢）
        id: base ? `${base}${role === 'bot' ? ':bot' : ''}` : '',
        at: Date.now(),
        chatId: chat.chatId,
        sender: role === 'bot' ? '' : String(payload?.sender?.name ?? '').trim(),
        role,
        text,
        eventIds,
        /**
         * 原文快照。**存的是整段，不是逐条**——合并批的正文已经被拼成一段，
         * 拆不回原来那几条。快照的用途是「events 7 天后删了还能看到当时说了什么」，
         * 整段正好满足；要逐条回看原文，用 `eventIds` 调 `/r/context`。
         */
        evidence: eventIds.length
          ? [{
              eventId: eventIds[eventIds.length - 1],
              at: Date.now(),
              sender: role === 'bot' ? 'bot' : String(payload?.sender?.name ?? '').trim(),
              excerpt: String(text ?? '').slice(0, 200),
            }]
          : [],
      });
    } catch (e) {
      log.warn(`日记没写进去（不影响这轮）：${e.message}`);
    }
  }

  /**
   * 巩固：凌晨把昨天消化掉。
   *
   * 它要调模型，所以 `generate` 复用 DSH 会话（跟主动搭话同一套办法）——
   * 单独一个内部会话，不碰任何 QQ 会话的上下文。
   */
  const consolidate = createConsolidate({
    journal,
    graph,
    memory,
    log: (m) => log.info(m),
    generate: async (prompt) => {
      const chat = {
        kind: 'c2c',
        chatId: cfg.memory?.consolidateChat || 'consolidate',
        name: '巩固',
        preset: 'roost-private',
      };
      const { agent } = await agentFor(chat);
      mount(agent, chat);
      return turns.run(agent, prompt, { source: { kind: 'roost-consolidate' } });
    },
  });

  /**
   * 凌晨巩固的检查循环。
   *
   * 为什么不用 DSH 的 `ctx.schedule`：那是**提醒**服务——它会在 DSH 界面上
   * 建一个用户可见的定时任务卡，到点把一句 prompt 投进某个会话。
   * 那是给"明早九点提醒我开会"用的，不是给内部维护任务用的。
   * 巩固是无人值守的后台活，塞进去会在用户的任务列表里凭空多出一条
   * 他从来没建过的提醒。所以这里用进程内定时器 + 自查"该跑没跑"。
   *
   * 十分钟一次、只在过了巩固点钟且昨天的摘要还不存在时才动，
   * 所以平时它只是个空转的判断（一次查库，几十微秒）。
   */
  const consolidateTick = async () => {
    if (cfg.memory?.enabled === false) return;
    try {
      const hour = Number(cfg.memory?.consolidateHour) || 4;
      const day = consolidate.dueDay({ hour });
      if (!day) return;
      log.info(`巩固定时器：开始处理 ${day}`);
      const r = await consolidate.run({ day });
      if (r.ok) {
        log.info(
          `巩固 ${day} 完成：${r.chats} 个会话、评级 ${r.ranked}、压缩 ${r.compressed}、` +
            `三元组 ${r.triples}、约定 ${r.agreements}、摘要 ${r.digests}（${r.mode}）`,
        );
      } else {
        log.warn(`巩固 ${day} 没跑成：${r.reason}`);
      }
    } catch (e) {
      log.warn(`巩固出错：${e?.message ?? e}`);
    }
  };

  /**
   * 取邻文（阶段 4 的桥 2）：把 `eventId` 换成原文和前后文。
   *
   * 事件账本在框架侧（A 侧），这边只有 id，只能回去问。
   * **失败一律返回 null**——拿不到原文是「少一点上下文」，不该让检索整个失败。
   * 超过保留期（默认 7 天）时框架那边会返回 `gone: true`，这里同样当 null。
   */
  async function contextOf(eventId, { before = 2, after = 2 } = {}) {
    const id = String(eventId ?? '').trim();
    if (!id) return null;
    try {
      const base = String(setup.baseUrl() || '').replace(/\/+$/, '');
      if (!base) return null;
      const url =
        `${base}/api/plugins/ai-chat/r/context?aroundId=${encodeURIComponent(id)}`
        + `&before=${Number(before) || 0}&after=${Number(after) || 0}${setup.keyQuery()}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body = await r.json().catch(() => null);
      return body?.ok ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * 启动 60 秒后先补跑一次（多半是昨天关机错过了四点），
   * 之后每十分钟看一眼。两个都 unref：不能因为定时器让进程退不出去。
   */
  const consolidateBoot = setTimeout(() => consolidateTick(), 60_000);
  consolidateBoot.unref?.();
  const consolidateTimer = setInterval(() => consolidateTick(), 10 * 60_000);
  consolidateTimer.unref?.();

  /* ---------------- 通道 / 注册方式 / 觉醒 / 压缩 ---------------- */

  /**
   * 通道注册表。
   *
   * 现在只有 QQ 一个实现（走 ai-chat 的 `/send`），抽这一层是为了
   * 第 5 期的"主动说话"和面板的"发测试消息"共用一条路径，
   * 而不是各自 fetch 一遍。以后接别的平台，注册进来即可。
   */
  const channels = createChannelRegistry({
    impls: {
      qq: createQqChannel({
        baseUrl: () => setup.baseUrl(),
        keyQuery: () => setup.keyQuery(),
        log: (m) => log.warn(m),
      }),
    },
    pick: () => cfg.channel?.current || 'qq',
    log: (m) => log.warn(m),
  });

  /**
   * 注册方式注册表（C4）。
   *
   * 扫码是**一个实现**，不是唯一的做法。手动填 AppID/Secret 也注册进来，
   * 这样"选一种方式接入"这件事在代码里有形状，不是写死的一个分支。
   */
  const registrations = createRegistrationRegistry({
    impls: [
      createQrRegistration({ setup }),
      createManualRegistration({
        submit: async ({ appId, appSecret }) => {
          const r = await setup.createBot({ name: 'main', appId, appSecret });
          return r ?? { ok: true };
        },
      }),
    ],
    pick: () => cfg.setup?.registration || 'qr',
    log: (m) => log.warn(m),
  });

  /** 压缩后要拼在下一条用户消息前面的开场白 */
  const pendingOpening = new Map();

  /**
   * 觉醒（第 5 期）：只决定"要不要说、说什么"，排期仍归 speakup。
   *
   * `contextOf` 是唯一的上下文入口——决策层不自己去翻文件，
   * 所有输入从一个口子进来，测试时塞假数据就行。
   */
  const awake = createAwake({
    dataDir: dataDir(),
    cfgOf: () => cfg,
    channelOf: () => channels.active(),
    log: (m) => log.info(m),
    authzOf: (chatId) => memory.hasAuthz(chatId, 'group_push'),
    contextOf: ({ kind, chatId = '' } = {}) => {
      const cid = chatId || cfg.speakUp?.chatId || '';
      const m = mood.get();
      /**
       * 收尾记录只读一次，两个地方用：
       *   · `state.closedAt`  → 刚说完晚安别又冒出来（冷却）
       *   · `closing`         → 主动搭话能接上「上次聊到哪儿」
       */
      const closed = closing.get(cid);
      return {
        chatId: cid,
        name: kind === 'group' ? cfg.awake?.groups?.find?.((g) => g.chatId === chatId)?.name || '' : '',
        hour: new Date().getHours(),
        mood: { valence: m.valence, energy: m.energy, sociability: m.sociability },
        /** 语气指令版的心情（`moodText` 在 awake 里早就有引用，一直没人传） */
        moodText: mood.text(),
        /** 这个人格习惯怎么开口：主动搭话时用来锚语气，不必逐字照抄 */
        opener: personas.resolve(cid, cfg.persona).firstMes || '',
        agreements: readAgreements({ memory, graph, chatId: cid }),
        recent: journal
          .recent(cid, 4)
          .reverse()
          .map((r) => `${r.role === 'bot' ? '你' : r.sender || '对方'}：${String(r.digest || r.text).slice(0, 60)}`),
        state: {
          lastOwnerAt: speakUp.state?.().lastOwnerAt || 0,
          /**
           * 刚收过尾的时间戳（0 = 没有记录）。给「随性搭话」踩刹车用：
           * 说完晚安 90 分钟内不该又冒出来。**不影响「约定」**——
           * 答应过的事该提还是要提。
           */
          closedAt: closed?.at || 0,
        },
        /** 上次收在哪：主动搭话时用来接上话头，别装作没发生过 */
        closing: closed ? { point: closed.point, resume: closed.resume } : null,
      };
    },
    /** 觉醒要用"她的嘴"问，所以借 speakup 那个内部会话，不新开一个 */
    generate: async (prompt) => {
      const chat = { kind: 'c2c', chatId: cfg.speakUp?.chatId || 'speakup', name: '主动搭话', preset: 'roost-private' };
      const { agent } = await agentFor(chat);
      mount(agent, chat);
      return turns.run(agent, prompt, { source: { kind: 'roost-awake' } });
    },
  });

  /**
   * 压缩（第 6 期）：上下文到阈值 → 开新会话 + 摘要开场，旧会话保留。
   *
   * 开场不单独跑一轮模型，而是交给宿主在下一条消息前拼进去：
   * 少一次调用，也不会出现"她先回一句'好的我了解了'"这种尴尬开场。
   */
  const compact = createCompact({
    controllerOf: () => controller(),
    workspaceIdOf: () => workspaceId(),
    sessions,
    journal,
    agreementsOf: (chatId) => readAgreements({ memory, graph, chatId }),
    onOpening: (chatId, text) => {
      if (text) pendingOpening.set(chatId, text);
    },
    log: (m) => log.info(m),
    cfgOf: () => cfg,
  });

  /**
   * 群主动的检查循环（C7）。
   *
   * 五分钟一次，比私聊稀疏得多——群里插话的成本高，不值得每分钟算一遍。
   * 白名单为空时 `wakeGroups` 第一行就返回，等于零开销。
   */
  const groupTimer = setInterval(() => {
    if (cfg.awake?.enabled === false) return;
    awake.wakeGroups().catch((e) => log.warn(`群主动失败：${e?.message ?? e}`));
  }, 5 * 60_000);
  groupTimer.unref?.();

  /**
   * 群白名单的逐项判定（面板要看"这个群为什么不能主动"）。
   *
   * 判据和真正发消息时**用同一个函数**——面板说"可以"、实际却不发，
   * 这种不一致最难查。
   */
  const groupCandidatesView = () =>
    groupCandidates({
      groups: cfg.awake?.groups || [],
      authzOf: (chatId) => memory.hasAuthz(chatId, 'group_push'),
      stateOf: (chatId) => awake.groupState(chatId),
      cfg: cfg.awake || {},
    });



  /**
   * 按优先级把若干块塞进预算：**前面的先留，后面的先砍**。
   *
   * 为什么不是"整段截断"：动态块每轮都注入，写多了直接吃 token。
   * 一刀切会把最要紧的那块也切掉一半；按优先级砍，至少保住重要的。
   */
  function fitBudget(sections, max) {
    const out = [];
    let used = 0;
    for (const s of sections) {
      const text = String(s || '');
      if (!text) continue;
      const room = max - used;
      if (room <= 0) break;
      if (text.length <= room) {
        out.push(text);
        used += text.length;
      } else {
        out.push(text.slice(0, Math.max(0, room - 1)) + '…');
        break;
      }
    }
    return out.join('\n\n');
  }

  /**
   * 日记总条数的缓存。
   *
   * `stats()` 每次要跑 7 条 COUNT。这个数只是拿来给模型一句"你有本日记，
   * 记着多少条"的索引，不需要秒级准确——一分钟刷一次足够，
   * 免得每轮五次数据库往返。
   */
  let statCache = { at: 0, v: null };
  function journalStat() {
    /**
     * 关掉记忆时连库都不查。
     *
     * 只挡"注入"不挡"查库"的话，关掉记忆每轮还要跑 7 条 COUNT——
     * 用户看不出区别，但那是白花的 I/O。
     */
    if (cfg.memory?.enabled === false) return null;
    const t = Date.now();
    if (statCache.v && t - statCache.at < 60_000) return statCache.v;
    try {
      statCache = { at: t, v: journal.stats() };
    } catch {
      statCache = { at: t, v: null };
    }
    return statCache.v;
  }

  const dayStr = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /**
   * 记忆块：两层 facts + 日记摘要 + 重要记忆 + 图谱 + 这一句检索到的旧事。
   *
   * 三档强度，按**每轮都付**的代价定的：
   *   · 平时：规则 + 少量 facts + 刚才说到 + 检索命中 + 一行日记索引
   *   · 每 15 轮（deep）：把 facts 全量、日记摘要、TopK、图谱一次铺满
   * 为什么不全量每轮：`systemPrompt.context` 每个请求都重发，
   * 600 字全量乘 15 轮等于白烧十几倍 token（实证里"人设/记忆每 15 轮重注"就是这个意思）。
   *
   * 两条不能动的：
   *   1. **串场规则排第一**，预算不够时它不能被砍掉——A 群的梗拿到 B 群说，
   *      比"记不住"严重得多。
   *   2. **「刚才说到」必须留着**。上下文一压缩，「那个」「上面说的第二个」
   *      就没了指代对象；把最近两三条原话（截短）铺在这儿，指代才连得上。
   */
  /**
   * **稳定段**：规则 / facts / 摘要 / TopK / 图谱。进 system prompt。
   *
   * 为什么单独拆出来（第 3 批 C2）：system prompt 里的内容**每个请求都要重发**，
   * 而且一变就让整段 prompt cache 失效。这一段只在"巩固之后"或"每 15 轮深度重注"
   * 时才变——天级/十几轮级的变化，前缀基本稳定，缓存能复用。
   *
   * Claude Code 把"压缩后前缀仍可复用"当招牌特性，Qvink 专门做"冻结注入点"，
   * 都是为了这件事。反过来看，把每轮都变的检索命中塞进 system prompt，
   * 等于每轮主动作废一次缓存。
   */
  function memoryStatic(override = null) {
    if (cfg.memory?.enabled === false) return '';
    const chatId = lastScene?.chatId || '';
    const m = memory.list(chatId);
    const st = memState.get(chatId) || {};
    const deep = typeof override === 'boolean' ? override : Boolean(st.deep);

    const rules = '记着的事可以拿来用，但**只在这个群发生过的事别拿到别处说**；判断不了就当作不知道。';
    const lines = (arr) => arr.map((f) => `· ${f}`).join('\n');

    // 平时只给最近的几条（数组是追加序，所以取尾部）；深度时才全量
    const factsGlobal = m.global.length
      ? `【你记得的事（通用）】\n${lines(deep ? m.global : m.global.slice(-6))}`
      : '';
    const factsChat = m.chat.length
      ? `【这个群特有的事】\n${lines(deep ? m.chat : m.chat.slice(-3))}`
      : '';

    let digestSec = '';
    let topSec = '';
    let graphSec = '';
    if (deep) {
      try {
        const ds = journal.digests(chatId, 5);
        if (ds.length) {
          digestSec = `【这几天】\n${ds
            .reverse()
            .map((d) => `· ${dayStr(d.at)} ${d.text}`)
            .join('\n')}`;
        }
        const top = journal.top(chatId, { limit: cfg.memory?.topK || 6 });
        if (top.length) {
          topSec = `【记得比较深的】\n${top.map((r) => `· ${clip(r.digest || r.text, 60)}`).join('\n')}`;
        }
        const g = graph.text({ chatId, max: 240 });
        if (g) graphSec = `【关系】\n${g}`;
      } catch (e) {
        log.debug(`取记忆深度块失败：${e.message}`);
      }
    }

    const sections = deep
      ? [rules, factsGlobal, factsChat, digestSec, topSec, graphSec]
      : [rules, factsGlobal, factsChat];

    const body = fitBudget(sections, deep ? MEMORY_DEEP_MAX : MEMORY_MAX);
    // 一句都没有（新装的、什么都没聊过）就别占地方
    return body.replace(rules, '').trim() ? body : '';
  }

  /**
   * **易变段**：刚才说到 / 这一句命中 / 日记条数索引。拼进**用户消息**。
   *
   * 每轮都会变，所以不能进 system prompt——放用户消息里同样是注入，
   * 但不影响 system 前缀的缓存，也不占"系统提示"的位置。
   * 走的是和压缩开场同一个位置（`onInbound` 里拼在正文前）。
   *
   * 「刚才说到」必须留着：上下文一压缩，`那个`/`上面第二个` 就没了指代对象。
   */
  function memoryDynamic() {
    if (cfg.memory?.enabled === false) return '';
    const chatId = lastScene?.chatId || '';
    const st = memState.get(chatId) || {};

    let recentSec = '';
    try {
      const recent = journal.recent(chatId, 3).reverse();
      if (recent.length) {
        recentSec = `【刚才说到】\n${recent
          .map((r) => `· ${r.role === 'bot' ? '你' : r.sender || '对方'}：${clip(r.text, 40)}`)
          .join('\n')}`;
      }
    } catch {}

    let hitSec = '';
    if (st.hits?.length) {
      hitSec = `【可能有关的旧事】\n${st.hits
        .map((r) => `· ${dayStr(r.at)} ${clip(r.digest || r.text, 60)}`)
        .join('\n')}`;
    }

    /** 一行索引：让她知道"还有东西在，只是没铺开"（对照表 1.14） */
    let idxSec = '';
    const st2 = journalStat();
    if (st2?.total) {
      idxSec = `（还有一本日记，记着 ${st2.total} 条，最早到 ${dayStr(st2.firstAt || Date.now())}；翻细节时按需要回忆）`;
    }

    return [recentSec, hitSec, idxSec].filter(Boolean).join('\n');
  }

  /** 两段拼起来（调试接口和面板用；真正注入是分开走的，别在这里合并回去） */
  function memoryText(override = null) {
    return [memoryStatic(override), memoryDynamic()].filter(Boolean).join('\n\n');
  }

  /**
   * 把回复里的记忆标记摘出来执行，返回干净文本。
   *
   * 标记是模型写在回复里的，所以只能等回复到手再处理。
   * 摘干净再发出去——群里不该看到 `<<remember: ...>>`。
   */
  function applyMemoryMarkers(text, chatId, said = '', kind = 'group') {
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
      /**
       * **日记也要清。**
       *
       * 只清 facts 的话会出现："她说清了这个群的记忆，可我一问上周的事她又答上来了"——
       * 因为日记里原文还在，检索照样命中。用户要的"清掉"是清干净。
       * `journal.clearChat` 抹正文但不删行：时间线仍连续（哪天真有纠纷能看出
       * "这天有过东西，是被人清掉的"），内容本身已经没了。
       */
      try {
        journal.clearChat(chatId);
      } catch (e) {
        log.warn(`清日记失败：${e.message}`);
      }
      touched = '清了这个群的记忆和人设';
      return '';
    });

    out = out.replace(/<<mood:\s*([\s\S]*?)>>/gi, (_, v) => {
      /**
       * 解析交给 `parseMoodMark`，别在这里自己按逗号切。
       *
       * 按逗号切的后果：`reason=被凶了，有点难受` 被切成两段，
       * 第二段没有 key 而 reason 已经有值 → 直接丢掉，原因只剩「被凶了」。
       */
      const kv = parseMoodMark(v);
      if (Object.keys(kv).length) {
        mood.set({
          valence: kv.valence,
          energy: kv.energy,
          sociability: kv.sociability,
          reason: kv.reason,
        });
        touched = '情绪变了';
      }
      return '';
    });

    out = out.replace(/<<forget:\s*([\s\S]*?)>>/gi, (_, v) => {
      const word = String(v || '').trim();
      /**
       * 两边都要忘。
       *
       * 只删 facts 不删日记，会出现"她嘴上说不记得了，一检索又想起来"——
       * 用户说"别记这个"要的是真的不存在，所以日记里那几条正文也抹掉
       * （`journal.forget` 是抹正文不删行，时间线还连着）。
       */
      const n = memory.remove(chatId, word);
      let j = 0;
      try {
        j = journal.forget({ chatId, word });
      } catch (e) {
        log.warn(`日记遗忘失败：${e.message}`);
      }
      if (n || j) touched = `忘掉了 ${n + j} 条`;
      return '';
    });

    /**
     * 对话收尾（`<<close: 收在哪 | 下次怎么接>>`）。
     *
     * **不发消息、不动记忆**，只把"这段聊到哪结束"记下来，给两处用：
     *   · 下一轮进来的提示词（`roost-closing`）——接得上，不用重新自我介绍
     *   · 主动搭话的刹车（`awake.js`）——刚说完晚安不该十分钟后又冒出来
     *
     * 三条拒绝，任何一条命中都不收尾（**标记照样摘掉**，不能漏给用户看）：
     *   1. 群聊——群里没有"聊完"这回事，一直有人说话
     *   2. 没写"收在哪"——空收尾对下一轮毫无价值
     *   3. 对方这一轮还在提问——问题没答完就退场，是最让人恼火的一种
     *
     * 注意**不要求**收尾必须带正文：`qq_close_conversation` 本来就是
     * "不说话地退场"，说完晚安、下一轮只留一个 close 标记是正确的用法。
     */
    out = out.replace(/<<close:\s*([\s\S]*?)>>/gi, (_, v) => {
      const { point, resume } = parseClose(v);
      const gate = acceptClose({ point, kind, said });
      if (!gate.ok) {
        /**
         * 「对方还在提问」用 info：它意味着她问题没答完就想跑，
         * 是唯一值得事后翻日志的一种；另外两条（群聊 / 空收尾）是常态。
         */
        if (gate.why.includes('提问')) log.info(`收尾被忽略：${gate.why}`);
        else log.debug(`收尾被忽略：${gate.why}`);
        return '';
      }
      const r = closing.set(chatId, { point, resume, kind });
      if (r.ok) touched = `收尾：${point}`;
      else log.debug(`收尾没记上：${r.why}`);
      return '';
    });

    /**
     * 兜底：任何剩下的 `<<名字>>` / `<<名字: 值>>` 都当标记摘掉。
     *
     * 标记协议是**两个仓库各自实现**的（这里是这套正则，ai-chat 的 `parseActions`
     * 是另一套）。哪一边加了新标记、另一边没跟上，标记就会原样进群——
     * `mood` 已经这么漏过一次（写进 `qq_send` 参数里，工具通道直接 `postReply`）。
     * 只匹配「字母开头 + 可选冒号值」的形状，不会误伤正文里的尖括号。
     */
    out = out.replace(/<<[a-z][a-z-]{0,20}(?::[^<>]{0,2000})?>>/gi, '');

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

  /**
   * QQ 会话用的工作区 id。
   *
   * 默认给机器人**单开一个工作区**（`<数据目录>/workspace`），不和日常会话
   * 混在默认工作区里。DSH 的 `workspaceController.create({ path })` 按目录
   * 幂等建（已存在就返回原 id），所以这里可以每次都调、不用自己缓存。
   *
   * `workspace.dir` 三个取值：
   *   · 空 / 未设 → <数据目录>/workspace
   *   · `__default__` → 退回 DSH 默认工作区（老行为）
   *   · 其它 → 就当作目录路径用
   */
  async function workspaceId() {
    const want = cfg.workspace?.dir ?? '';

    if (want !== '__default__') {
      const dir = want ? String(want) : join(dataDir(), 'workspace');
      const wc = ctx.get('workspaceController');
      if (wc?.create) {
        try {
          mkdirSync(dir, { recursive: true });
          const r = await wc.create({ path: dir });
          const id = r?.workspace?.workspaceId;
          if (id) return id;
        } catch (e) {
          log.warn(`单开工作区失败（${e.message}），退回默认工作区`);
        }
      }
    }

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
    sessions.set(chat.chatId, newSid, { preset: chat.preset, title: chat.name, kind: chat.kind });
    log.info(`为 ${chat.chatId} 新建 DSH 会话 ${newSid.slice(-8)}（${chat.preset}）`);
    return { agent: await resolveAgent(newSid), sessionId: newSid };
  }

  /** 记忆工具的注册结果（面板要能看见"装上了没"，别静默失败） */
  const toolState = { ok: false, names: [], reason: '还没挂' };

  /**
   * 本轮 QQ 动作工具的用量：`sessionId → { parts, texts, closed }`。
   *
   * 为什么按 sessionId 而不是 chatId：一个 agent 就是一个会话，
   * 而工具拿到的 `agent` 是固定的，只有 session.id 能对上"这一轮"。
   *
   * 为什么需要它：模型调了 `qq_send` 之后，这一轮的正文**不能再发一遍**，
   * 否则同一句话会重复两次。所以 turn 开始前清零、结束后按 `parts` 决定要不要 postReply。
   */
  const qqTurn = new Map();

  /** QQ 动作工具的注册结果 */
  const qqToolState = { ok: false, names: [], reason: '还没挂' };

  /**
   * 挂人格 + 权限上下文（每个 agent 只挂一次，内容每轮现读）
   */
  function mount(agent, chat) {
    if (mounted.has(agent)) return;
    const offs = [];

    /**
     * 记忆工具（第 2 批 M2）：给她两把"拉"的手。
     *
     * 挂在这里而不是插件的 ctx：`agent.ctx.tools` 是每轮都在用的那个
     * （restrict 也走它），而插件的 inject 里没有 tools 服务——
     * 往 inject 里加一个不存在的服务会让整个插件激活失败。
     *
     * 权限不在这里判：注册是一次性的，而"这一句是谁说的"每轮变，
     * 所以档位检查放在工具 execute 里（见 tools.js）。
     */
    if (cfg.memory?.enabled !== false && cfg.memory?.tools !== false) {
      const sidFor = () => agent?.session?.id;
      registerMemoryTools({
        agent,
        journal,
        graphOf: () => graph,
        callerOf: () => {
          const cur = sidFor() ? speaker.get(sidFor()) : null;
          return { bucket: cur?.bucket, chatId: cur?.payload?.chat?.chatId || chat.chatId || '' };
        },
        cfgOf: () => cfg,
        /**
         * 场景片段（阶段 4）：检索命中后拿原文和前后文。
         * 传 null 就是「没有这条桥」，检索照常返回摘要，只是不带邻文。
         */
        contextOf,
        log: (m) => log.warn(m),
      })
        .then((r) => {
          toolState.ok = r.ok;
          toolState.names = r.names;
          toolState.reason = r.reason || '';
          if (r.ok) log.info(`记忆工具已挂上：${r.names.join('、')}（${r.mode}）`);
          else log.warn(`记忆工具没挂上：${r.reason}`);
          if (r.off) mountOffs.push(r.off);
        })
        .catch((e) => {
          toolState.reason = e?.message ?? String(e);
          log.warn(`记忆工具挂载异常：${toolState.reason}`);
        });
    }

    /**
     * QQ 动作工具（`qq_send` / `qq_close`）：让她自己决定说几句、什么时候退场。
     *
     * 挂载方式跟记忆工具一样，但**发送走被动回复**（`postReply(..., done:false)`）
     * 而不是主动接口——正处在"对方刚说完话"的 5 分钟窗口里，
     * 主动消息既浪费配额（20 条/分），群里还可能因为没 `group_push` 授权直接被拒。
     */
    if (cfg.qqTools?.enabled !== false) {
      const sidFor = () => agent?.session?.id;
      /**
       * 这一轮是谁在说。工具 execute 时才读，不烤进定义——
       * 注册是一次性的，而"这一句是谁说的"每轮都变。
       */
      const cur = () => {
        const sid = sidFor();
        const s = sid ? speaker.get(sid) : null;
        return {
          sid: sid || '',
          payload: s?.payload || null,
          bucket: s?.bucket || '',
          chatId: s?.payload?.chat?.chatId || chat.chatId || '',
          kind: chat.kind,
          said: String(s?.payload?.text ?? ''),
        };
      };

      registerQqTools({
        agent,
        callerOf: () => {
          const c = cur();
          return { ...c, hasPayload: Boolean(c.payload) };
        },
        sendOf: async (raw, opts = {}) => {
          const c = cur();
          if (!c.payload) return { ok: false, message: '这一轮没有可回话的消息' };

          /**
           * **工具参数里的标记也要摘掉。**
           *
           * 这是 0.10.4 加 `qq_send` 时漏掉的一条路：正文会过
           * `applyMemoryMarkers`，但工具参数是**直接 postReply 原文**。
           * 模型只要把 `<<mood: valence=-0.3>>` 写进 `qq_send`，
           * 结果就是「情绪没改，标记原样发到群里」——两头都错。
           *
           * 复用同一个函数而不是另写一份清理：标记的语义不该因为
           * 它出现在正文还是工具参数里而不同。
           */
          const { text, touched } = applyMemoryMarkers(raw, c.chatId, c.said, c.kind);
          if (touched) log.info(`工具发言里的标记已执行：${touched}`);
          if (!text) {
            /**
             * 整段都是标记，没有可发的内容。
             * 不静默成功——不然模型会以为发出去了，实际什么都没说。
             */
            return { ok: false, message: '这段话里只有标记，没有可发出去的内容' };
          }

          /**
           * @ 前缀由**宿主**拼，模型只负责说「@ 谁」。
           *
           * 模型自己写 `<qqbot-at-user id="…"/>` 的问题是抄错不报错：
           * openid 是二十多位随机串，错一位官方照样 200，只是没 @ 到人。
           * 放这儿还有一个好处——所有拒绝理由都能通过 `note` 回给模型，
           * 它下一句就知道该怎么改，而不是一直发没效果的消息。
           */
          const st = qqTurn.get(c.sid) || { parts: 0 };
          const at = buildAtPrefix({
            at: opts.at,
            kind: c.kind,
            /**
             * 通道有没有开 markdown 只有 ai-chat 知道，它会在 payload 里带
             * `channel.markdown`。老版本不带 → 按默认 true（跟 ai-chat 默认一致）。
             */
            markdown: c.payload?.channel?.markdown !== false,
            parts: st.parts,
            senderId: String(c.payload?.sender?.id ?? ''),
            senderName: String(c.payload?.sender?.name ?? ''),
          });
          if (at.note) log.info(`@ 没挂上：${at.note}`);

          await postReply(c.payload, at.prefix ? at.prefix + text : text, false);
          /**
           * 记下这一轮发了什么：turn 结束时要拿它写日记，并且决定正文不再重发。
           *
           * 存的是**不带 @ 标签的原文**——日记里塞 `<qqbot-at-user>` 是脏数据，
           * 检索和摘要都会把它当正文。
           */
          const st2 = qqTurn.get(c.sid);
          if (st2) {
            st2.parts += 1;
            st2.texts.push(text);
          }
          return { ok: true, note: at.note };
        },
        closeOf: ({ chatId, point, resume, kind }) => {
          const r = closing.set(chatId, { point, resume, kind });
          /** 记下"这一轮她收尾了"：只收尾不说话时要用它回 `<skip>`，而不是回空串 */
          if (r.ok) {
            const st = qqTurn.get(cur().sid);
            if (st) st.closed = true;
          }
          return r;
        },
        cfgOf: () => cfg,
        stateOf: () => qqTurn.get(sidFor()) || { parts: 0 },
        log: (m) => log.warn(m),
      })
        .then((r) => {
          qqToolState.ok = r.ok;
          qqToolState.names = r.names;
          qqToolState.reason = r.reason || '';
          if (r.ok) log.info(`QQ 工具已挂上：${r.names.join('、')}（${r.mode}）`);
          else log.warn(`QQ 工具没挂上：${r.reason}`);
          if (r.off) mountOffs.push(r.off);
        })
        .catch((e) => {
          qqToolState.reason = e?.message ?? String(e);
          log.warn(`QQ 工具挂载异常：${qqToolState.reason}`);
        });
    }

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

            /**
             * 世界书：**命中关键词才注入**。
             *
             * 抄的是 SillyTavern 角色卡的 character_book。
             * 为什么比全量注入好：人格里的背景设定（在哪工作、养了什么）
             * 大部分轮次根本用不上，全塞进去白吃 token 还稀释重点。
             * 这里只在这一轮提到相关词时才带出来。
             */
            const hits = (persona.lore || []).filter((l) =>
              l.keys.some((k) => k && lastMsgText.includes(k)),
            );

            return [
              `你现在叫「${persona.name}」。`,
              PERSONA_BASE,
              override ? `（本群临时人设）\n${override}` : persona.body,
              /**
               * 示例对话：比形容词准得多。
               * 放在性格后面读，作为"她平时具体怎么说话"的锚。
               */
              persona.demos ? `【她平时这么说话】\n${persona.demos}` : '',
              hits.length ? `【跟这会儿有关的事】\n${hits.map((h) => `· ${h.text}`).join('\n')}` : '',
              extra,
              /**
               * 旧字段 `persona.text`：**只在人格文件读不出正文时**兜底。
               * 判据和原因都写在 `legacyPersonaText` 里（踩过的坑：
               * 无条件追加会让「换人格」看起来没生效）。
               */
              legacyPersonaText(persona, p.text),
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
     * 发言方式（第 1 条工具化）：告诉模型「说话要走工具」。
     *
     * 为什么必须写：工具挂上之后，**调了 `qq_send` 正文就不再发**（防重复）。
     * 模型如果不知道这条，会既调工具又写正文——然后发现只有一段到了，
     * 或者反过来，以为写了正文就够了、结果一个字都没发出去。
     *
     * 只在工具真挂上时才注入：没挂上却告诉它有，它就会一直调一个不存在的工具。
     */
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-qq-tools',
          order: 907,
          text: () => {
            if (!qqToolState.ok) return '';
            return [
              '【发言方式】',
              '你手上有两个工具：`qq_send`（发一段话）和 `qq_close`（给这段对话收尾）。',
              '· 想说话就调 `qq_send`，调几次由你定（一轮最多 3 段）。**别把要发的话写进正文**。',
              '· 调过 `qq_send` 之后，你回复的正文**不会**再发出去——正文只当思考用。',
              '· 聊到自然结束、对方要走的时候，用 `qq_close` 记一句「收在哪 / 下次怎么接」，然后可以不说话。',
              '· 一个工具都不调时，正文会照常发出去（旧方式）。**不要又调工具又写正文**，那样只算一次。',
            ].join('\n');
          },
        }),
      );
    } catch (e) {
      log.debug('挂发言方式失败：', e.message);
    }

    /**
     * **近处指令**（SillyTavern `post_history_instructions` 的近似）。
     *
     * 那张角色卡里有一段指令放在对话历史**之后**，比 system 更「近」，
     * 模型更难忽略。DSH 没给「历史之后」的注入点，我们能做的只有把 order 排到最后，
     * 至少在 system 块里离历史最近。
     *
     * 解决的是真问题：聊到几十轮以后人设被历史冲淡，说话开始像通用助手。
     */
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-near',
          order: 908,
          text: () => {
            const p = cfg.persona;
            const persona = personas.resolve(chat.chatId, p);
            return [
              `别忘了你是谁：${persona.name}。`,
              '上面那些历史是发生过的事，不是你说话的方式——别聊着聊着变成通用助手。',
              p.near || '',
            ]
              .filter(Boolean)
              .join('');
          },
        }),
      );
    } catch (e) {
      log.debug('挂近处指令失败：', e.message);
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
          /**
           * 只放**稳定段**（规则 / facts / 摘要 / TopK / 图谱）。
           *
           * 易变段（刚才说到 / 命中 / 条数）走 `memoryDynamic()` 拼进用户消息，
           * 否则 system prompt 每轮都不一样，prompt cache 轮轮作废。
           * `freezeSystem: false` 可以退回旧行为（全塞 system prompt）。
           */
          text: () => (cfg.memory?.freezeSystem === false ? memoryText() : memoryStatic()),
        }),
      );
    } catch (e) {
      log.warn('挂记忆提示失败：', e.message);
    }

    /**
     * **情绪**：order 904，记忆之后、身份之前。
     * 注入的是**语气指令**，不是数字——数字会让它像在演。
     */
    try {
      offs.push(
        agent.ctx.systemPrompt.context({
          name: 'roost-mood',
          order: 904,
          text: () => mood.text(),
        }),
      );
    } catch (e) {
      log.warn('挂情绪提示失败：', e.message);
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
      // 有人来找，精力和社交意愿回升（不衰减的话会越聊越冷）
      mood.touched();

      /**
       * 顺手补老映射的标题。
       *
       * 早期版本 `sessions.set` 没传 `title`，那些会话在面板上一直显示
       * openid 短码（私聊最明显——群还有群名兜着，私聊就只剩一串乱码）。
       * 这里不新建映射、不改 sessionId，只把空字段补上。
       */
      sessions.patch(chat.chatId, { title: chat.name, kind: chat.kind, preset: chat.preset });

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
          // 白名单在 permissions.js 的 GUEST_KEEP_TOOLS，算法在 planGuestTools()
          const r = restrictGuestTools(agent);
          if (r.ok) restore = r.off;
          else log.warn(`收走本地工具失败：${r.reason}。这一轮群友会拿到完整本地工具`);
        } catch (e) {
          log.warn(`收走本地工具失败：${e?.message || e}。这一轮群友会拿到完整本地工具`);
        }
      }

      /**
       * 有人说话 → 觉醒那边记一笔。
       *
       * 私聊用来算"多久没聊"，群里用来算"冷场多久了"（C7 的插话前提）。
       * 放在这里而不是通道层：通道层不知道谁是"用户"。
       */
      awake.noteUser(chat.chatId);

      let text = renderInbound(payload);

      /**
       * 用户原话的副本。发送者标签要贴在**它**前面，而不是整段正文最前面。
       *
       * 下面还会往 text 前面拼开场白、动态记忆、收尾语境——标签要是放在
       * 最前面，语义就变成「这堆上下文是谁说的」，而不是「这句话是谁说的」。
       */
      const said = text;

      /**
       * 这一轮用户说了什么：世界书按它匹配触发词。
       *
       * **必须放在 `text` 声明之后**——放到场景快照那里会踩 TDZ：
       * `Cannot access 'text' before initialization`，整个插件挂掉、DSH 起不来。
       */
      lastMsgText = String(text || '').slice(0, 2000);

      /**
       * 刚压缩过的话，这一轮的正文前面要带上开场白。
       *
       * 为什么拼在用户消息里而不是单独发一条：单独发会多跑一轮模型，
       * 而且她会先回一句"好的我了解了"——最像机器人的那种开场。
       * 拼进来等于"用户说完，顺带把上文递过去"，历史里也只占一条。
       */
      const opening = pendingOpening.get(chat.chatId);
      if (opening) {
        pendingOpening.delete(chat.chatId);
        text = `${opening}\n\n${text}`;
        log.info(`压缩后的第一条消息带上了开场白（${opening.length} 字）`);
      }

      /**
       * 落一条日记（用户这边）。
       *
       * 用 `payload.id` 当主键：合并窗口 + 重试会让同一条消息来两次，
       * 按 msg_id 去重才不会写出两条（对照表 12.4）。
       *
       * 放在调模型**之前**：即使这一轮请求失败了，"他说过这句话"这件事
       * 仍然发生过，不记就永远丢了。
       */
      journalAdd(payload, chat, text, 'user');

      /**
       * 决定这一轮记忆注入的强度，并先把检索做好。
       *
       * 为什么检索要在这儿做：`systemPrompt.context` 的 text() 是同步的，
       * 检索要 async（可能还要调向量接口）。这轮真正读注入内容是在
       * turns.run 里面，所以只要在那之前把结果放进 memState 就行。
       */
      const mr = rounds.get(chat.chatId) || { n: 0, lastDeep: -999 };
      mr.n += 1;
      const every = Math.max(1, Number(cfg.memory?.deepEvery) || 15);
      const deep = mr.n === 1 || mr.n - mr.lastDeep >= every;
      if (deep) mr.lastDeep = mr.n;
      rounds.set(chat.chatId, mr);

      let hits = [];
      if (cfg.memory?.enabled !== false) {
        try {
          /**
           * 第三路（M3）：查询里提到的实体，把相关日记拉进来。
           *
           * 为什么只在关键词之外再补这一路：问"张三最近在忙什么"时，
           * 字面命中经常很差（日记里写的是"他"），但图谱里
           * "张三—工作在→某公司"是现成的。实体路只给 0.5 权重，
           * 不会盖过关键词命中。
           */
          let entIds = [];
          try {
            const named = graph
              .entities({ chatId: chat.chatId, limit: 40 })
              .filter((e) => e.name && e.name.length >= 2 && text.includes(e.name));
            entIds = named.flatMap((e) => graph.linkedJournalIds(e.name, { chatId: chat.chatId, limit: 5 }));
          } catch (e) {
            log.debug(`实体路跳过：${e.message}`);
          }
          hits = await journal.search(text, {
            chatId: chat.chatId,
            limit: Number(cfg.memory?.hits) || 3,
            entityJournalIds: entIds,
          });
        } catch (e) {
          log.warn(`日记检索失败（不影响这轮）：${e.message}`);
        }
      }
      memState.set(chat.chatId, { deep, hits, round: mr.n, at: Date.now() });

      /**
       * 易变段拼进这一轮的正文（第 3 批 C2）。
       *
       * 为什么放这儿：`memState` 刚写好，动态段才有"这一句命中了什么"可读。
       * 为什么不放 system prompt：它每轮都变，会把 system 前缀的缓存废掉。
       */
      if (cfg.memory?.freezeSystem !== false) {
        const dyn = memoryDynamic();
        if (dyn) text = `${dyn}\n\n${text}`;
      }

      /**
       * 上次收在哪（第 1 条：对话收尾）。
       *
       * **拼正文，不进 system**：它每轮都可能变（这一轮聊完就更新），
       * 放 system 会把前缀缓存整段废掉。跟上面的动态段一个道理。
       *
       * 放最前面而不是最后：它是"这段聊天的语境"，要先知道接着什么聊，
       * 再看对方这句话。
       */
      const closeText = closing.text(chat.chatId);
      if (closeText) text = `${closeText}\n\n${text}`;

      /**
       * 群聊：给这一句贴上发送者标签 `[昵称 (openid)] `。
       *
       * 放在这儿而不是 `renderInbound` 里，是因为上面已经用它写过日记、
       * 做过检索（`journalAdd` / `journal.search`）——openid 进了 FTS 索引
       * 就是纯噪音，还会让「刚才说到」里冒出一串乱码。
       *
       * `endsWith` 是防御：哪天有人在原话后面追加内容，标签就会贴到错位置，
       * 那种情况宁可不加（模型少一个 openid 而已，不会说错话）。
       */
      const tag = speakerTag(payload, chat);
      if (tag) {
        if (text.endsWith(said)) {
          text = text.slice(0, text.length - said.length) + tag + said;
        } else {
          log.warn('发送者标签没贴上（正文尾部不是原话），这一轮模型拿不到 openid');
        }
      }

      /**
       * 清掉上一轮的 QQ 工具用量。
       *
       * **必须在 run 之前清**：`qq_send` 是在 run 期间被调用的，
       * 如果等 run 回来再清，就把这一轮刚记下的段数一起抹了。
       */
      const sidTurn = agent?.session?.id || '';
      if (sidTurn) qqTurn.set(sidTurn, { parts: 0, texts: [], closed: false });

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
      const { text: reply, touched } = applyMemoryMarkers(
        rawReply,
        chat.chatId,
        String(payload?.text ?? ''),
        chat.kind,
      );
      if (touched) log.info(`记忆：${touched}`);

      /** 这一轮模型自己发了几段（用 `qq_send` 的话） */
      const used = sidTurn ? qqTurn.get(sidTurn) : null;

      /**
       * 她说的那句。用**实际发出去的内容**：模型走工具时正文只是思考过程，
       * 拿正文写日记会把"她说了什么"记成一段没发出去的草稿。
       *
       * 注意这里只是**取**，不是**记**——记要等发出去之后（见下面）。
       */
      const spoken = used?.texts?.length ? used.texts.join('\n') : reply;

      /**
       * 回话。
       *
       * **模型走工具发过就不再发正文**：`qq_send` 已经把话送进 ai-chat 的
       * parts 里了（`done:false` 累积），这里只需要用一个空文本 + `done:true`
       * 把事件收掉——否则同一句话会重复两遍。
       *
       * 空文本不会增加 part（`bridge.handleReply` 里 `if (text)` 才 push），
       * 所以之前发的几段会原样交回去。
       *
       * **日记放在发送成功之后**。原来是先记后发，于是回话通道断掉的时候
       * 日记里照样留下「我说过这句话」——下一轮拼【刚才说到】就会把它捞出来，
       * 她拿一句**根本没发出去**的话当既定事实继续聊。线上真发生过：
       * 通道死了三轮，她连着三轮跟自己的失败记录对话。
       */
      if (used?.parts > 0) {
        // 分几段发的每一段都已经单独发成功过了（`qq_send` 一次一成功），
        // 这里的空文本只是收尾——收尾失败也不影响"话已经说出去了"。
        journalAdd(payload, chat, spoken, 'bot');
        await postReply(payload, '', true);
      } else if (used?.closed && !reply) {
        /**
         * 只收尾、不说话 —— 回 `<skip>` 让 ai-chat 安静结束。
         *
         * 为什么不能回空字符串：`adapter/host.js` 里 `if (!r?.text?.trim()) throw`
         * 会把它当成「宿主回了空内容」，用户看到的是「出错了」，
         * 而其实她只是把话说完就退场了——这是**正常结局**。
         *
         * `<skip>` 是 ai-chat 的私有约定（`decide.js` 的 `SKIP_MARK`），
         * 这里硬编码是**设计内的耦合**：dsh-roost 本来就是 ai-chat 的宿主，
         * 标记契约也一直由它经 system prompt 传下来。
         *
         * 这一支不写日记：她一个字都没说。
         */
        await postReply(payload, '<skip>', true);
      } else {
        await postReply(payload, reply, true);
        journalAdd(payload, chat, spoken, 'bot');
      }

      /**
       * 上下文压缩（第 6 期）：到阈值就开新会话 + 摘要开场。
       *
       * **放在回话之后**：压缩会改 `chatId → sessionId` 映射，
       * 边回边说等于把话说进一个刚被换掉的窗口。回完再换，下一句才进新窗口。
       * 压失败只记日志——它是优化，不该影响对话。
       */
      compact.noteTurn(chat.chatId);
      try {
        const cp = await compact.maybe(chat.chatId, chat);
        if (cp.compacted) log.info(`上下文压缩完成（${cp.trigger}）`);
      } catch (e) {
        log.warn(`上下文压缩失败（不影响对话）：${e?.message ?? e}`);
      }

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
      /**
       * 日志里也别糊 JSON。
       *
       * 上游错误的原始 reason 是一坨 `{"kind":"error","error":{...}}`，
       * 打出来占一行又看不懂。日志只留状态码和一句人话，
       * 完整 reason 要看就去 DSH 自己的日志里查。
       */
      log.warn(
        e?.kind === 'upstream'
          ? `处理 ${chat.chatId.slice(0, 8)} 失败：模型服务不可用（${e.status || '?'}）`
          : `处理 ${chat.chatId.slice(0, 8)} 失败：${e?.message ?? e}`,
      );

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
          sessions.set(chat.chatId, '', { preset: chat.preset, title: chat.name, kind: chat.kind });
          log.warn(`会话被归档或需要人工处理，已解绑 ${chat.chatId.slice(0, 8)}，下一条开新会话`);
        } catch {}
      }

      /**
       * **出错也要回话**。
       *
       * 不回的话 ai-chat 那边会一直等到 180 秒超时，用户看到的是
       * 「宿主没回话」——比「这边出了点问题：xxx」难受得多。
       *
       * 话术按 kind 分：上游挂了要说「等会儿」，会话归档了要说「重说一遍」，
       * 其余才报具体错。**不要把内部 JSON 原文糊到群里**——
       * 用户看不懂「{"kind":"error","error":{...}}」，只会觉得机器人坏了。
       */
      const friendly =
        e?.kind === 'busy'
          ? '上一条还在想，稍等一下。'
          : e?.kind === 'timeout'
            ? '想太久了，先算了。'
            : e?.kind === 'blocked'
              ? '这条对话在 DSH 里被归档了，我开个新的——再说一遍就行。'
              : e?.kind === 'upstream'
                ? '模型服务那边暂时抽风了，等会儿再问我一次。'
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
    // 重启会重新 bind，端口可能又变；旧端口的重试队列必须作废，
    // 否则它会把 ai-chat 改回一个已经没人听的端口
    clearSyncRetry();

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
        // syncAdapterPort 自己会吞错并排队重试（Roost 可能还没起来），
        // 这里不用再接 catch——接了只会多一条误导人的「通知失败」
        void syncAdapterPort(actual);
      },
    });
  }

  /**
   * 同步 ai-chat 地址的重试队列。
   *
   * 为什么要重试：dsh-roost 常常比 Roost 先起，那一刻 `isRunning()` 是 false，
   * `syncDshUrl` 只能跳过。以前跳过一次就再也不管了——于是端口换过、
   * ai-chat 还指着旧地址，面板一直红着说「去第 5 步重新写一次」。
   * 这件事它自己就能做完，没理由让用户跑一趟。
   *
   * 退避节奏和「不叠加 / 可作废」这些性质在 `sync-retry.js` 里，那边有测试。
   */
  const syncRetry = createSyncRetry({
    log: (m) => log.warn(m),
    run: (actual) => { void syncAdapterPort(actual); },
  });

  function clearSyncRetry() {
    syncRetry.reset();
  }

  /**
   * 把 ai-chat 的 dshUrl 指到实际端口。只在它已经配过 DSH 时改。
   *
   * `skipped + reason === 'roost-down'` 会自己排队再试，其它情况（没装、
   * 没在用 DSH、已经是当前端口）就到此为止——那几种重试一万次也没用。
   */
  async function syncAdapterPort(actual) {
    try {
      const r = await setup.syncDshUrl(actual);
      if (r?.skipped && r.reason === 'roost-down') {
        syncRetry.schedule(actual);
        return r;
      }
      if (r && !r.ok) {
        log.warn(`ai-chat 的地址没同步：${r.message}`);
        // Roost 起来了但 PUT 失败（比如插件正被重载），也值得再试几次
        syncRetry.schedule(actual);
        return r;
      }
      // 成功或「本来就不用改」，都不用再试了
      clearSyncRetry();
      return r;
    } catch (e) {
      log.warn(`ai-chat 的地址没同步：${e?.message ?? e}`);
      syncRetry.schedule(actual);
      return { ok: false, message: String(e?.message ?? e) };
    }
  }

  ctx.effect(() => {
    startServer();
    return () => {
      server?.close();
      server = null;
      clearSyncRetry();
      turns.dispose();
    };
  }, 'dsh-roost: 收消息服务');

  /**
   * 群成员进出：**记进日记**，不直接说话。
   *
   * 框架本来就会把非消息事件派给监听器（`bot.js` 里按事件名分发），
   * 只是一直没人监听——所以这个订阅位是空的。
   *
   * 为什么只记不说：主动打招呼很容易变成骚扰，而且群里新人多的时候会刷屏。
   * 记进日记后，觉醒（awake）在"有没有必要开口"时能看到它，
   * 要不要打招呼由那一层按概率和授权决定。
   */
  ctx.effect(() => {
    const offs = [];
    const onMember = (kind) => async (d) => {
      try {
        const gid = String(d?.group_openid || '');
        const openid = String(d?.member_openid || d?.op_member_openid || '');
        if (!gid) return;
        journal.add({
          id: `evt-${kind}-${openid || 'x'}-${Date.now()}`,
          at: Date.now(),
          chatId: gid,
          sender: openid,
          role: 'system',
          text: kind === 'add' ? '有新人入群' : '有人退群或被移出',
          level: 'normal',
          kind: 'event',
        });
      } catch (e) {
        log.warn(`群成员事件记录失败：${e?.message ?? e}`);
      }
    };
    try {
      offs.push(ctx.on?.('GROUP_MEMBER_ADD', onMember('add')));
      offs.push(ctx.on?.('GROUP_MEMBER_REMOVE', onMember('remove')));
    } catch (e) {
      log.warn(`订阅群成员事件失败：${e?.message ?? e}`);
    }
    return () => {
      for (const off of offs) {
        try {
          off?.();
        } catch {
          /* 取消订阅失败无所谓 */
        }
      }
    };
  }, 'dsh-roost: 群成员事件');

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
          mood: mood.get(),
        }),
      ),

      /**
       * 心智状态调试接口。
       *
       * 情绪/记忆都是看不见的状态，没有这个接口，
       * 改完只能凭感觉判断好像有点不一样——既调不准也回不了滚。
       */
      /**
       * 快捷操作：面板/按钮点完由 ai-chat 转发到这里执行。
       *
       * **两道鉴权，这是第二道。** ai-chat 那边已经按 sender 拦过一次，
       * 但这里必须再校验 `actor.bucket`——不能只信转发方，
       * 以后要是有别的调用方接进来，鉴权不能只有一道。
       *
       * 只有 owner(主人) / admin(管理) 能改设置。
       * 消息反馈（点赞点踩）和授权不走这里，那些是"表达态度"，谁都能做。
       */
      route('/quick', async (req, res) => {
        const body = await readBody(req);
        const actor = body?.actor ?? {};
        const bucket = String(actor.bucket || 'unknown');
        if (bucket !== 'owner' && bucket !== 'admin') {
          return send(res, 403, { ok: false, message: '只有主人或管理员能改设置' });
        }

        const chatId = String(body?.chatId || lastScene?.chatId || '');
        const op = String(body?.op || '');
        const arg = body?.arg;

        try {
          switch (op) {
            case 'persona.set':
              memory.setPersonaOverride(chatId, String(arg ?? ''));
              return send(res, 200, { ok: true, message: arg ? '这个群的人设换了' : '回到默认人格' });

            case 'memory.list':
              return send(res, 200, { ok: true, chatId, ...memory.list(chatId) });

            /**
             * 删一条（按关键词，两层都搜）。
             *
             * 之前只有 `memory.clear`（整层清空），面板上「她记错了」只能全清，
             * 代价太大——用户宁可忍着不改。按关键词删才是日常要用的那个。
             */
            case 'memory.remove': {
              const word = String(arg ?? '').trim();
              if (!word) return send(res, 400, { ok: false, message: '要删哪条？给个关键词' });
              const n = memory.remove(chatId, word);
              /**
               * 日记同删。
               *
               * 这是「她记错了」在面板上的入口。只删 facts 不删日记，
               * 用户改完再问一句，她又能从日记里把那条翻出来——
               * 用户看到的是"改了没用"，比没改更糟。
               */
              let j = 0;
              try {
                j = journal.forget({ chatId, word });
              } catch (e) {
                log.warn(`日记遗忘失败：${e.message}`);
              }
              const total = n + j;
              return send(res, 200, {
                ok: true,
                removed: total,
                facts: n,
                journal: j,
                message: total ? `忘了 ${total} 条` : '没找到匹配的记忆',
              });
            }

            case 'memory.clear': {
              memory.clearChat(chatId);
              let j = 0;
              try {
                j = journal.clearChat(chatId);
              } catch (e) {
                log.warn(`清日记失败：${e.message}`);
              }
              return send(res, 200, {
                ok: true,
                journal: j,
                message: `这个群的记忆清了（含日记 ${j} 条，通用记忆没动）`,
              });
            }

            case 'memory.clearGlobal':
              memory.clearGlobal();
              return send(res, 200, { ok: true, message: '通用记忆清空了' });

            case 'context.clear':
              /**
               * 解绑 = 下一条消息开新会话，旧会话还留着可以回溯。
               *
               * **保留 preset/title/kind**：只清 sessionId。
               * 全清的话，面板的会话下拉会先变成一排空标题，
               * 等下一条消息来了才恢复——中间那一小段很难看。
               */
              {
                const old = sessions.list().find((c) => c.chatId === chatId) || {};
                sessions.set(chatId, '', { preset: old.preset || '', title: old.title || '', kind: old.kind || '' });
              }
              return send(res, 200, { ok: true, message: '上下文清了，下一条重新开始' });

            default:
              return send(res, 400, { ok: false, message: `不认识的快捷操作：${op}` });
          }
        } catch (e) {
          return send(res, 500, { ok: false, message: e.message });
        }
      }),

      /**
       * 记录授权（c2c_push / group_push）。
       * **不鉴权**——授权是用户处置自己的权利；但必须记，群主动靠它。
       */
      route('/authz', async (req, res) => {
        const body = await readBody(req);
        const chatId = String(body?.chatId || '').trim();
        const scope = String(body?.scope || '').trim();
        if (!chatId || !scope) return send(res, 400, { ok: false, message: '缺 chatId 或 scope' });
        memory.setAuthz(chatId, scope, { type: body?.type, optScene: body?.optScene });
        log.info(`授权记录 ${scope} @ ${chatId}`);
        send(res, 200, { ok: true });
      }),

      /**
       * 点赞/点踩（interaction type 13）。
       * **不鉴权**——这是表达态度，谁都能点。
       * 这是 doc2 说的「被对待的反馈」最直接的来源。
       *
       * `applied` 必须如实回给调用方：面板以前发的是 `up`/`down`，
       * 而这里只认 `LIKE`/`UNLIKE`，结果**按钮点了没反应，界面还弹"记了个赞"**。
       * 现在两边都归一化（`normalizeFeedback`），认不出来就明说没生效。
       */
      route('/mood', async (req, res) => {
        if (req.method === 'GET') return send(res, 200, { ok: true, ...mood.get() });
        const body = await readBody(req);
        const raw = body?.feedback;
        if (raw == null) return send(res, 400, { ok: false, message: '缺 feedback' });
        const r = mood.feedback(String(raw));
        if (!r.applied) {
          log.warn(`不认识的反馈：${String(raw).slice(0, 20)}（只认 like/unlike/up/down）`);
          return send(res, 400, { ok: false, message: `不认识的反馈：${String(raw).slice(0, 20)}`, ...mood.get() });
        }
        send(res, 200, { ok: true, applied: true, ...r });
      }),

      /**
       * 记忆三层：facts（跨群/本群）+ 日记（摘要/重要/最近）+ 图谱（实体/关系）。
       *
       * 授权和人格覆盖一起返回，是为了**别再开新路由**：面板要回答的三个问题
       * （她什么状态 / 她记得什么 / 她能做什么）都落在这一份快照里，
       * 一次请求拿全，少一个会 404 的地方。
       *
       * 三层都给是为了**能查**：串场、记错、忘不掉，这三类问题
       * 光看 facts 是判断不了的，得能看见日记和图。
       */
      route('/memory', (req, res) => {
        /**
         * 「本群」到底指哪个群，必须能指定、也必须能显示出来。
         *
         * 原来这里是 `lastScene?.chatId || ''`：面板永远只看**最近说话的那个会话**，
         * 用户改不了；一个会话都还没进来时拿到空串，而空串那一层是写不进去的
         * （`memory.add` 没 chatId 直接返回 false）——界面却照样显示「本群」。
         * 结果就是「我在哪一层记的？」和「记了却没记住」。
         *
         * 现在：`?chatId=` 优先，没给才退回最近那个；同时把**所有会话**和
         * 这个 chatId 对应的名字一起返回，前端才能让人选、也才敢说「本群」是谁。
         */
        const url = new URL(req.url || '/', 'http://x');
        const asked = String(url.searchParams.get('chatId') || '').trim();
        const chatId = asked || lastScene?.chatId || '';
        const facts = memory.list(chatId);

        /** 会话清单：chatId + 能看懂的标题（群名 / 私聊昵称） */
        const chats = sessions
          .list()
          .map((c) => ({
            chatId: c.chatId,
            title: String(c.title || ''),
            preset: String(c.preset || ''),
            /**
             * 群还是私聊。
             *
             * 没有它，下拉里群和私聊会长得一模一样——
             * 群名在 QQ 那边取不到（官方只有 openid），ai-chat 就回退成
             * 发消息那个人的昵称，于是两边 title 都是同一个人名。
             */
            kind: String(c.kind || kindFromPreset(c.preset)),
            at: c.at,
          }))
          .sort((a, b) => (b.at || 0) - (a.at || 0));

        /**
         * 当前这个 chatId 是谁。
         * 最近说话的那个有准确名字（`lastScene.name`）；别的是从会话表里的 title 取，
         * 取不到就只剩短码——宁可显示短码，也不能再拿「本群」两个字糊过去。
         */
        const hit = chats.find((c) => c.chatId === chatId);
        const scene = chatId
          ? {
              chatId,
              kind: lastScene?.chatId === chatId ? lastScene.kind : (hit?.kind || ''),
              name: (lastScene?.chatId === chatId ? lastScene.name : hit?.title) || '',
              at: lastScene?.chatId === chatId ? lastScene.at : hit?.at || 0,
            }
          : null;

        let jr = null;
        try {
          jr = {
            backend: journal.backend(),
            stats: journalStat(),
            /** 每天的摘要（巩固产出的那种一句话） */
            digests: journal.digests(chatId, 7).map((d) => ({ at: d.at, day: d.day, text: d.text })),
            /** 重要记忆 TopK（重要性×衰减+访问频率） */
            top: journal
              .top(chatId, { limit: Number(cfg.memory?.topK) || 6 })
              .map((r) => ({
                id: r.id,
                at: r.at,
                level: r.level,
                text: clip(r.digest || r.text, 80),
                score: Number(r.score.toFixed(3)),
                accessed: r.accessed,
              })),
            /** 最近说的几条（含原文，方便看"她到底记得什么"） */
            recent: journal.recent(chatId, 10).map((r) => ({
              id: r.id,
              at: r.at,
              level: r.level,
              role: r.role,
              sender: r.sender,
              text: clip(r.text, 120),
              digest: r.digest,
            })),
          };
        } catch (e) {
          jr = { error: e.message };
        }

        let gp = null;
        try {
          gp = {
            stats: graph.stats(),
            /** 现在的实体（人/地点/东西） */
            entities: graph.entities({ chatId, limit: 20 }),
            /** 现在还成立的关系（双时态里 valid_to IS NULL 的那些） */
            edges: graph.nowEdges({ chatId, limit: 20 }),
          };
        } catch (e) {
          gp = { error: e.message };
        }

        send(res, 200, {
          ok: true,
          chatId,
          scene,
          /** 可以切换的会话；空数组 = 还没有任何群/私聊说过话 */
          chats,
          ...facts,
          // 显式再给一份带名字的，前端读 facts.global 比读 global 清楚
          facts: { global: facts.global, chat: facts.chat },
          journal: jr,
          graph: gp,
          authz: memory.authz(chatId),
          personaOverride: memory.getPersonaOverride(chatId),
        });
      }),

      /**
       * 日记：查 / 搜 / 忘。
       *
       * 单开一条路由而不是塞进 /memory，是因为搜索要带关键词、
       * 遗忘是写操作，语义和"看一眼状态"不一样。
       */
      route('/journal', async (req, res) => {
        const url = new URL(req.url || '/', 'http://x');
        const chatId = String(url.searchParams.get('chatId') || lastScene?.chatId || '');
        const q = String(url.searchParams.get('q') || '').trim();

        if (req.method === 'GET') {
          try {
            if (q) {
              const rows = await journal.search(q, { chatId, limit: Number(url.searchParams.get('limit')) || 8 });
              return send(res, 200, {
                ok: true,
                q,
                backend: journal.backend(),
                results: rows.map((r) => ({
                  id: r.id,
                  at: r.at,
                  level: r.level,
                  text: clip(r.text, 200),
                  digest: r.digest,
                  score: Number(r.score.toFixed(4)),
                  why: r.why,
                })),
              });
            }
            return send(res, 200, {
              ok: true,
              backend: journal.backend(),
              stats: journalStat(),
              recent: journal.recent(chatId, 20),
              digests: journal.digests(chatId, 7),
            });
          } catch (e) {
            return send(res, 500, { ok: false, message: e.message });
          }
        }

        const body = await readBody(req);
        const word = String(body?.word ?? '').trim();
        if (!word) return send(res, 400, { ok: false, message: '要忘哪件事？给个关键词' });
        const n = journal.forget({ chatId: String(body?.chatId || chatId), word });
        return send(res, 200, { ok: true, removed: n, message: n ? `忘掉了 ${n} 条` : '日记里没有匹配的' });
      }),

      /** 图谱：实体 / 现在的关系 / 已经结束的关系（双时态的两面都给人看） */
      route('/graph', (req, res) => {
        // 和 /memory 一样：能指定看哪个会话，别死盯「最近说话的那个」
        const u = new URL(req.url || '/', 'http://x');
        const chatId = String(u.searchParams.get('chatId') || '').trim() || lastScene?.chatId || '';
        try {
          send(res, 200, {
            ok: true,
            chatId,
            stats: graph.stats(),
            entities: graph.entities({ chatId, limit: 50 }),
            edges: graph.nowEdges({ chatId, limit: 50 }),
            ended: graph.endedEdges({ chatId, limit: 20 }),
          });
        } catch (e) {
          send(res, 500, { ok: false, message: e.message });
        }
      }),

      /**
       * 巩固：GET 看状态，POST 手动跑（调试/补跑用）。
       *
       * 手动入口是必要的：凌晨那次如果因为进程没开而错过，
       * 得有个地方能立刻补，而不是等到明天。
       */
      route('/consolidate', async (req, res) => {
        if (req.method === 'GET') {
          return send(res, 200, {
            ok: true,
            last: consolidate.status(),
            due: consolidate.dueDay({ hour: Number(cfg.memory?.consolidateHour) || 4 }),
            hour: Number(cfg.memory?.consolidateHour) || 4,
          });
        }
        const body = await readBody(req);
        const r = await consolidate.run({ day: String(body?.day || ''), dry: Boolean(body?.dry) });
        return send(res, 200, r);
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
        const chatId = lastScene?.chatId || '';
        const st = memState.get(chatId) || {};
        /**
         * `?deep=1` / `?light=1` 强制指定注入强度。
         *
         * 为什么需要：平时 15 轮才深度重注一次，想看"全量长什么样"
         * 得等半天。"她怎么突然忘了"这类问题也全靠这个能一眼看清
         * 当前那一轮拿到的是哪一档。
         */
        const url = new URL(req.url || '/', 'http://x');
        const forced = url.searchParams.get('deep') === '1' ? true : url.searchParams.get('light') === '1' ? false : null;
        const mtext = memoryText(forced);
        const deep = forced === null ? Boolean(st.deep) : forced;
        send(res, 200, {
          ok: true,
          scene: lastScene
            ? { ...lastScene, text }
            : null,
          lastTurn,
          budgets: {
            scene: { max: SCENE_MAX, len: text.length },
            memory: {
              max: deep ? MEMORY_DEEP_MAX : MEMORY_MAX,
              len: mtext.length,
              /**
               * 拆开看：`static` 进 system prompt（稳定，可缓存）；
               * `dynamic` 拼进用户消息（每轮变，不污染缓存）。
               * 调注入时最常见的误解是"记忆没生效"，其实是它搬到动态段去了。
               */
              staticLen: memoryStatic(forced).length,
              dynamicLen: memoryDynamic().length,
              freezeSystem: cfg.memory?.freezeSystem !== false,
              /**
               * 这一轮是"平时"还是"全量重注"，以及为什么。
               * 调注入时最常问的就是"为什么她突然忘了" ——
               * 先看这里是不是刚好卡在两个 deep 之间。
               */
              deep,
              round: st.round ?? 0,
              deepEvery: Number(cfg.memory?.deepEvery) || 15,
              hits: (st.hits || []).map((r) => ({ at: r.at, why: r.why, text: clip(r.digest || r.text, 60) })),
            },
          },
          memory: memory.list(chatId),
          journal: journalStat(),
          graph: graph.stats(),
          /** 记忆工具装上了没——静默失败最难查，面板必须看得见 */
          tools: { ...toolState },
          /** QQ 动作工具（qq_send / qq_close）装上了没，同样要看得见 */
          qqTools: { ...qqToolState },
          /** 分开给：调注入时最常搞混的就是"这段到底进 system 还是进用户消息" */
          memoryStaticText: memoryStatic(forced),
          memoryDynamicText: memoryDynamic(),
          memoryText: mtext,
        });
      }),

      route('/chats', (req, res) => send(res, 200, { ok: true, chats: sessions.list() })),

      /**
       * 对话收尾（只私聊）。面板「记忆」页底部用。
       *
       * 为什么给面板看：收尾是**静默发生**的——模型写个标记就没了，
       * 用户只会感觉到"她今天话变少了"。不给看的话，出了问题只能翻日志。
       */
      route('/closing', (req, res) =>
        send(res, 200, {
          ok: true,
          cfg: cfg.closing,
          stat: closing.stat(),
          chats: closing.list(),
        }),
      ),

      route('/closing/clear', async (req, res) => {
        const b = await readBody(req);
        const chatId = String(b.chatId ?? '');
        if (!chatId) return send(res, 400, { ok: false, message: '缺 chatId' });
        const done = closing.clear(chatId);
        return send(res, 200, { ok: true, message: done ? '清掉了' : '本来就没有' });
      }),

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
      /**
       * 扫码改走**注册表**（C4）。
       *
       * 行为完全不变（`createQrRegistration` 内部就是包着 `setup.qrStart/qrPoll`），
       * 变化在于：以后加别的接入方式，这两条路由不用再动一次。
       * 上一轮的教训是"抽象写好了但没人调"（`journal.clearChat` 成了死函数），
       * 所以这里直接把唯一实现接上，不留空壳。
       */
      route('/setup/qr/start', async (req, res) => {
        const impl = registrations.active();
        if (!impl) return send(res, 500, { ok: false, message: '没有可用的注册方式' });
        const r = await impl.start();
        return send(res, r.ok ? 200 : 502, r);
      }),

      route('/setup/qr/poll', async (req, res) => {
        const body = await readBody(req);
        const impl = registrations.active();
        if (!impl) return send(res, 500, { ok: false, message: '没有可用的注册方式' });
        const r = await impl.poll(String(body.taskId ?? '').trim());
        return send(res, r.status === 'error' ? 502 : 200, r);
      }),

      /** 有哪些接入方式、各自叫什么（面板据此渲染选择项，不必知道有哪几个） */
      route('/registrations', (req, res) =>
        send(res, 200, {
          ok: true,
          current: cfg.setup?.registration || 'qr',
          list: registrations.list(),
          statuses: ['pending', 'done', 'expired', 'error'],
        }),
      ),

      /** 通道能力表：面板上让人一眼看出"这个平台能干什么、不能干什么" */
      route('/channels', (req, res) =>
        send(res, 200, {
          ok: true,
          current: cfg.channel?.current || 'qq',
          names: channels.names(),
          capabilities: channels.describe(),
          /** 能力用不了时退成什么——上层不该自己判"平台不支持怎么办" */
          fallbacks: channels.active()?.fallbacks ?? {},
        }),
      ),

      /**
       * 觉醒状态：为什么说 / 为什么没说。
       *
       * "她怎么不主动"和"她怎么老说话"这两类问题，光看日志判断不了——
       * 得能看见"当前算出来有哪些机会、各多少分"。
       */
      route('/awake', async (req, res) => {
        if (req.method === 'GET') {
          const st = awake.status();
          const groups = groupCandidatesView();
          return send(res, 200, { ok: true, ...st, groups });
        }
        const body = await readBody(req);
        try {
          if (body?.target === 'group') {
            const r = await awake.wakeGroups();
            return send(res, 200, { ok: true, results: r });
          }
          const v = await awake.compose({ kind: 'c2c' });
          if (!v.speak) return send(res, 200, { ok: true, spoke: false, why: v.why, kind: v.kind });
          const sent = await channels.active().send({ scene: 'c2c', target: cfg.speakUp?.chatId || '', text: v.text });
          return send(res, 200, { ok: Boolean(sent?.ok), spoke: Boolean(sent?.ok), text: v.text, message: sent?.message });
        } catch (e) {
          return send(res, 500, { ok: false, message: e.message });
        }
      }),

      /**
       * 上下文压缩：GET 看占用与阈值，POST 手动压一次（调试/救急用）。
       *
       * 手动入口必要：阈值配高了会把窗口撑爆，配低了会频繁换会话，
       * 调参数时得能立刻看到"当前多少"并手动压一次验证效果。
       */
      route('/compact', async (req, res) => {
        const chatId = lastScene?.chatId || '';
        if (req.method === 'GET') {
          const p = await compact.pressure(chatId);
          return send(res, 200, { ok: true, chatId, pressure: p, ...compact.status() });
        }
        const body = await readBody(req);
        const target = String(body?.chatId || chatId);
        if (!target) return send(res, 400, { ok: false, message: '缺 chatId' });
        const r = await compact.compact(target, {
          kind: lastScene?.kind,
          name: lastScene?.name,
          preset: lastScene?.kind === 'c2c' ? 'roost-private' : 'roost-social',
        });
        return send(res, r.ok ? 200 : 500, r);
      }),

      route('/setup/start', (req, res) => setup.start().then((r) => send(res, 200, r))),
      route('/setup/stop', (req, res) => setup.stop().then((r) => send(res, 200, r))),
      route('/setup/plugin', (req, res) => setup.installPlugin().then((r) => send(res, 200, r))),
      // 传实际监听的端口：端口被占会顺延，写配置值的话 ai-chat 会连到错的端口
      route('/setup/configure', (req, res) =>
        setup.configurePlugin(server?.actualPort?.() || undefined).then((r) => send(res, 200, r))),

      /**
       * 只改「ai-chat 的 DSH 地址」，别的都不动。
       *
       * 和 `/setup/configure` 的区别：那个会把 adapter 也改成 dsh、顺便写
       * publicUrl 和 decide，等于重新配一遍。用户在面板上看到地址对不上时，
       * 想要的是「就改这一行」，不是「把插件配置重刷一遍」。
       *
       * 自动重试已经在跑了（`syncRetry.schedule`），这个路由是给人一个
       * **立刻生效**的按钮——不用等退避，也不用跑去「接入」第 5 步。
       */
      route('/setup/sync', async (req, res) => {
        const r = await syncAdapterPort(server?.actualPort?.() || undefined);
        if (r?.ok && !r.skipped) addLog('info', 'core', `ai-chat 的地址已对齐：${r.message}`);
        return send(res, 200, r ?? { ok: false, message: '没有返回结果' });
      }),

      route('/setup/webui', (req, res) => send(res, 200, { ok: true, url: setup.webuiUrl() })),

      route('/speakup', (req, res) =>
        send(res, 200, { ok: true, state: speakUp.state(), cfg: cfg.speakUp }),
      ),

      route('/speakup/fire', async (req, res) => send(res, 200, await speakUp.fire('手动'))),

      route('/stickers', (req, res) =>
        send(res, 200, { ok: true, dir: stickers.dir(cfg.stickers), items: stickers.list(cfg.stickers) }),
      ),

      route('/personas', (req, res) => send(res, 200, { ok: true, personas: personas.list(), current: cfg.persona?.current || 'default', byChat: cfg.persona?.byChat || {} })),

      /**
       * 读一个人格的正文。
       *
       * 为什么要单开：`/personas` 的列表只给 id/名字/字数（列表不需要几百字正文），
       * 而编辑必须拿到 raw。没有这条路由，面板上就只能"选人格"不能"改人格"——
       * 于是"后端能存、前端改不了"，功能半截。
       */
      route('/personas/read', (req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        const id = String(u.searchParams.get('id') || '').trim();
        if (!id) return send(res, 400, { ok: false, message: '缺 id' });
        const p = personas.read(id);
        if (!p) return send(res, 404, { ok: false, message: `没有「${id}」这个人格` });
        return send(res, 200, { ok: true, id, name: p.name, raw: p.raw });
      }),

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

      /**
       * 人格仓库：列清单 + 每个条目在本地的状态。
       *
       * `?force=1` 绕过 5 分钟缓存。为什么需要：用户刚在 GitHub 上推了一份人格，
       * 回面板点刷新却还是旧清单，会以为没推上去。
       */
      route('/personas/repo', async (req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        try {
          const r = await personaRepo.list({ force: u.searchParams.get('force') === '1' });
          return send(res, 200, r);
        } catch (e) {
          return send(res, 502, { ok: false, message: e.message });
        }
      }),

      /** 预览一份人格的正文（只读，不落盘）。装之前得先能读——人格是要读的，光看标签决定不了 */
      route('/personas/repo/preview', async (req, res) => {
        const u = new URL(req.url || '/', 'http://x');
        const id = String(u.searchParams.get('id') || '').trim();
        if (!id) return send(res, 400, { ok: false, message: '缺 id' });
        try {
          return send(res, 200, await personaRepo.preview(id));
        } catch (e) {
          return send(res, 404, { ok: false, message: e.message });
        }
      }),

      /**
       * 一键更新人格库。
       *
       * 只动「没被用户改过」的文件——判据在 `persona-repo.js:status()`。
       * 返回报告而不是抛错：单个文件失败不该让整批停下。
       */
      route('/personas/sync', async (req, res) => {
        try {
          const r = await personaRepo.sync();
          if (r.ok && r.updated.length) {
            addLog('info', 'persona', `人格库更新 ${r.updated.length} 个：${r.updated.map((x) => x.name).join('、')}`);
          }
          return send(res, r.ok ? 200 : 500, r);
        } catch (e) {
          addLog('error', 'persona', `人格库更新失败：${e.message}`);
          return send(res, 502, { ok: false, message: e.message });
        }
      }),

      /** 单个强制恢复官方版本（覆盖前自动备份到 `personas/.backup/<时间戳>/`） */
      route('/personas/restore', async (req, res) => {
        const b = await readBody(req);
        if (!b.id) return send(res, 400, { ok: false, message: '缺 id' });
        try {
          const r = await personaRepo.restore(String(b.id));
          addLog('info', 'persona', `已恢复官方人格：${r.name || b.id}`);
          return send(res, r.ok ? 200 : 500, r);
        } catch (e) {
          return send(res, 502, { ok: false, message: e.message });
        }
      }),

      /**
       * 查有没有新版本。
       *
       * 只读，不改任何东西。失败也返回 200（`error` 字段里带原因）——
       * 断网是常态，前端要能照常显示「当前版本 + 查不到最新版」，
       * 而不是整块变成错误页。
       */
      route('/update/check', async (req, res) => {
        try {
          return send(res, 200, await updater.check());
        } catch (e) {
          return send(res, 200, { ok: false, own: updater.own(), error: e.message, canSelf: false, hasUpdate: false });
        }
      }),

      /**
       * 执行自更新。
       *
       * `{ fresh: true }` = 「立即安装（不等 24 小时）」：先往
       * `pnpm-workspace.yaml` 写一条只对 dsh-roost 生效的豁免，再装。
       *
       * 为什么这条要单独一个按钮：pnpm 的 24 小时冷却会把刚发的版本
       * **降级**成旧版（不报错），我们每次发版都在和这个窗口赛跑。
       * 但它只对本包开放——做成通用入口就等于给面板开了一个
       * 「给任何包跳过防投毒保护」的洞。
       */
      route('/update/self', async (req, res) => {
        const b = await readBody(req);
        try {
          const r = await updater.self({ fresh: Boolean(b?.fresh) });
          addLog(r.ok ? 'info' : 'warn', 'update', r.message || `自更新：${r.code || r.version || ''}`);
          return send(res, 200, r);
        } catch (e) {
          addLog('error', 'update', `自更新异常：${e.message}`);
          return send(res, 500, { ok: false, message: e.message });
        }
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
      clearInterval(groupTimer);
      clearTimeout(consolidateBoot);
      clearInterval(consolidateTimer);
      /**
       * 数据库连接也要关。
       *
       * 插件重载时会重新 apply，旧的连接不关，WAL 文件会越积越多，
       * Windows 上还会因为文件句柄没释放导致下一次打不开。
       */
      try {
        journal.close();
      } catch {}
      try {
        graph.close();
      } catch {}
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
