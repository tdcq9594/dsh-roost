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
import { createJournal } from './journal.js';
import { createGraph } from './graph.js';
import { createConsolidate } from './consolidate.js';
import { createEmbedder } from './embed.js';
import { createMood } from './mood.js';
import { createPersonas } from './personas.js';
import { createStickers } from './stickers.js';
import { createSpeakUp } from './speakup.js';
import { createAwake, readAgreements, groupCandidates } from './awake.js';
import { createCompact } from './compact.js';
import { createQqChannel, createChannelRegistry } from './channel.js';
import { createQrRegistration, createManualRegistration, createRegistrationRegistry } from './registration.js';
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
      journal.add({
        // 没有 msg_id 时给空串，journal 内部会生成随机 id（宁可重复也不丢）
        id: base ? `${base}${role === 'bot' ? ':bot' : ''}` : '',
        at: Date.now(),
        chatId: chat.chatId,
        sender: role === 'bot' ? '' : String(payload?.sender?.name ?? '').trim(),
        role,
        text,
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
      return {
        chatId: cid,
        name: kind === 'group' ? cfg.awake?.groups?.find?.((g) => g.chatId === chatId)?.name || '' : '',
        hour: new Date().getHours(),
        mood: { valence: m.valence, energy: m.energy, sociability: m.sociability },
        agreements: readAgreements({ memory, graph, chatId: cid }),
        recent: journal
          .recent(cid, 4)
          .reverse()
          .map((r) => `${r.role === 'bot' ? '你' : r.sender || '对方'}：${String(r.digest || r.text).slice(0, 60)}`),
        state: { lastOwnerAt: speakUp.state?.().lastOwnerAt || 0 },
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
  function memoryText(override = null) {
    /**
     * **关掉记忆时一个字都不注入。**
     *
     * 写日记、巩固、检索三条路径早就各自挡过了，漏的正是"注入"这一条：
     * facts、日记摘要、图谱照样每轮进 system prompt，用户以为自己关掉了。
     * Open WebUI 踩过同一个坑（PR #30228：关掉 Memories 只隐藏了功能，
     * 已保存的记忆仍被加进每一次 chat 的 system prompt）。
     */
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

    /** 刚才说到：最近三条原话，保住指代 */
    let recentSec = '';
    try {
      const recent = journal.recent(chatId, 3).reverse();
      if (recent.length) {
        recentSec = `【刚才说到】\n${recent
          .map((r) => `· ${r.role === 'bot' ? '你' : r.sender || '对方'}：${clip(r.text, 40)}`)
          .join('\n')}`;
      }
    } catch {}

    /** 这一句检索到的旧事（onInbound 里已经查好） */
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

    const sections = deep
      ? [rules, factsGlobal, factsChat, digestSec, topSec, graphSec, recentSec, hitSec, idxSec]
      : [rules, factsGlobal, factsChat, recentSec, hitSec, idxSec];

    const body = fitBudget(sections, deep ? MEMORY_DEEP_MAX : MEMORY_MAX);
    // 一句都没有（新装的、什么都没聊过）就别占地方
    return body.replace(rules, '').trim() ? body : '';
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
      const s = String(v || '').trim();
      if (s) {
        // 支持 `valence=-0.3, reason=被凶了`；只有一段文字时当原因处理
        const kv = {};
        for (const part of s.split(/[,，;；]/)) {
          const m = part.match(/^\s*(valence|energy|sociability|reason)\s*[=:：]\s*(.+)$/i);
          if (m) kv[m[1].toLowerCase()] = m[2].trim();
          else if (!kv.reason) kv.reason = part.trim();
        }
        mood.set({
          valence: kv.valence != null ? Number(kv.valence) : undefined,
          energy: kv.energy != null ? Number(kv.energy) : undefined,
          sociability: kv.sociability != null ? Number(kv.sociability) : undefined,
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
              PERSONA_BASE,
              override ? `（本群临时人设）\n${override}` : persona.body,
              /**
               * 示例对话：比形容词准得多。
               * 放在性格后面读，作为"她平时具体怎么说话"的锚。
               */
              persona.demos ? `【她平时这么说话】\n${persona.demos}` : '',
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

      /**
       * 有人说话 → 觉醒那边记一笔。
       *
       * 私聊用来算"多久没聊"，群里用来算"冷场多久了"（C7 的插话前提）。
       * 放在这里而不是通道层：通道层不知道谁是"用户"。
       */
      awake.noteUser(chat.chatId);

      let text = renderInbound(payload);

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
          hits = await journal.search(text, { chatId: chat.chatId, limit: Number(cfg.memory?.hits) || 3 });
        } catch (e) {
          log.warn(`日记检索失败（不影响这轮）：${e.message}`);
        }
      }
      memState.set(chat.chatId, { deep, hits, round: mr.n, at: Date.now() });

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

      /** 她说的那句也进日记——不然日记只剩对方一个人的独白 */
      journalAdd(payload, chat, reply, 'bot');

      await postReply(payload, reply, true);

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
              // 解绑 = 下一条消息开新会话，旧会话还留着可以回溯
              sessions.set(chatId, '', {});
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
       */
      route('/mood', async (req, res) => {
        if (req.method === 'GET') return send(res, 200, { ok: true, ...mood.get() });
        const body = await readBody(req);
        if (body?.feedback) mood.feedback(String(body.feedback));
        send(res, 200, { ok: true, ...mood.get() });
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
        const chatId = lastScene?.chatId || '';
        const facts = memory.list(chatId);

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
          scene: lastScene
            ? { kind: lastScene.kind, name: lastScene.name, chatId: lastScene.chatId, at: lastScene.at }
            : null,
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
        const chatId = lastScene?.chatId || '';
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
          memoryText: mtext,
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
