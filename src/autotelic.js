/**
 * 自驱引擎（实验，默认关）
 * ======================
 *
 * 一句话：给她**一间自己的屋子**（独立会话）、**一本别人代记的账**
 * （`autotelic-ledger.js` 的哈希链）、**一条自己想做的事**（立项），
 * 以及**一道动手前的闸**（频率 / 时段 / 是否允许动手 / 连续失败自动卡住）。
 *
 * ## 为什么默认全关
 *
 * 这是本项目里唯一「没人叫她、她自己决定要做事」的模块。和「授权分级」铁律
 * 的冲突点很具体：无人值守时的工具调用，出了事没有人在场喊停。所以：
 *
 *   · `enabled` 默认 false —— 不开就一行代码都不跑；
 *   · `allowAct` 默认 false —— 开了也只是「想」，不调工具；
 *   · `maxPerDay` 默认 2、连续失败 `failLimit` 次自动卡住 `stuckHours` 小时；
 *   · **绝不往主人私聊推**：所有产物只落账本与面板，发消息仍走主动搭话那条
 *     有人工开关的路（C3）。
 *
 * ## 和 aurabot 那份方案（AUTOTELIC-PLAN v3）的关系
 *
 * 借的是**形态**：机械账本、独立会话、立项 → 推进 → 复盘、失败两次卡住。
 * 不照搬的是实现：那份方案跑在 Cordis 上（`hub.js` / `cordis.patch.yml` /
 * `presetId`），我们是 DSH 插件，会话走 `ctx.agents.create()`，
 * 工具收放走能力页那套。所以这里只有我们自己用得上的那部分。
 *
 * 另有两条**刻意不做**：
 *   · 不做「她自己改频率」的自动调参（`tune` 这个 kind 留着给以后，
 *     现在只有账本能记，没有代码会自己调）；
 *   · 不做「自己写代码 / 跑 Python」。那两件要单独设计沙箱，不该顺手带进来。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { writeJsonAtomic } from './atomic.js';
import { parseConstraintRules, check as constraintCheck } from './autotelic-constraint.js';

import {
  appendLedger, readLedger, verifyChain, dayStats, ledgerPath, GENESIS,
} from './autotelic-ledger.js';
import { readDreamSeeds } from './dream.js';

export const STATE_FILE = 'autotelic-state.json';

/**
 * 配置默认值。**每一项的默认都是「不动」**：
 * 关着、不动手、一天最多两次、失败两次停半天、安静时段 0–0（= 不设）。
 */
export const AUTOTELIC_DEFAULTS = {
  enabled: false,
  /** 允许调工具。false = 只能想（prompt 里也明确禁止动手） */
  allowAct: false,
  /** 一天最多推进几次（立项不算次数，推进才算） */
  maxPerDay: 2,
  /** 连续失败几次自动卡住 */
  failLimit: 2,
  /** 卡住多久（小时） */
  stuckHours: 12,
  /** 心跳间隔（分钟）。0 = 不自动跑，只能手动 */
  heartbeatMin: 0,
  /** 安静时段：起止相同 = 不设 */
  quietStartHour: 0,
  quietEndHour: 0,
  /** 每次推进最多让它输出多少字（防止一口气写几千字烧钱） */
  maxOutputChars: 1200,
  /** 种子：她可以琢磨的方向。空 = 不立项 */
  seeds: [],
  /** 阶段 1：与 config.js DEFAULTS 同形状；normalizeCfg 的 clamp 默认值从这里取 */
  constraintRules: '',
  autoConfirmOwner: false,
  confirmWindowMinutes: 720,
  responseWindowHours: 48,
  chillParkThreshold: 3,
  maxSteps: 8,
  intentMaxInputTokens: 8192,
  intentMaxOutputTokens: 1024,
  gateMaxInputTokens: 4096,
  gateMaxOutputTokens: 512,
  reviewMaxInputTokens: 4096,
  reviewMaxOutputTokens: 512,
};

/** 允许出现在 `tune` 里的键（现在没有自动调参，留给以后收口） */
export const TUNABLE = Object.freeze(['maxPerDay', 'heartbeatMin', 'quietStartHour', 'quietEndHour']);

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const clampInt = (v, min, max, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** 读配置段并夹紧到合法范围。配置写坏了不该让引擎崩，也不该让它跑飞 */
export function normalizeCfg(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const seeds = (Array.isArray(r.seeds) ? r.seeds : [])
    .map((s) => String(s ?? '').trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 20);
  return {
    enabled: r.enabled === true,
    allowAct: r.allowAct === true,
    maxPerDay: clampInt(r.maxPerDay, 0, 24, AUTOTELIC_DEFAULTS.maxPerDay),
    failLimit: clampInt(r.failLimit, 1, 10, AUTOTELIC_DEFAULTS.failLimit),
    stuckHours: clampInt(r.stuckHours, 1, 168, AUTOTELIC_DEFAULTS.stuckHours),
    heartbeatMin: clampInt(r.heartbeatMin, 0, 720, AUTOTELIC_DEFAULTS.heartbeatMin),
    quietStartHour: clampInt(r.quietStartHour, 0, 23, 0),
    quietEndHour: clampInt(r.quietEndHour, 0, 23, 0),
    maxOutputChars: clampInt(r.maxOutputChars, 100, 4000, AUTOTELIC_DEFAULTS.maxOutputChars),
    seeds,
    /** 阶段 1：约束 / 反馈 / 预算。默认仍全关，夹紧范围防止写坏配置让引擎跑飞 */
    constraintRules: String(r.constraintRules ?? '').slice(0, 2000),
    autoConfirmOwner: r.autoConfirmOwner === true,
    confirmWindowMinutes: clampInt(r.confirmWindowMinutes, 5, 10080, AUTOTELIC_DEFAULTS.confirmWindowMinutes),
    responseWindowHours: clampInt(r.responseWindowHours, 1, 168, AUTOTELIC_DEFAULTS.responseWindowHours),
    chillParkThreshold: clampInt(r.chillParkThreshold, 1, 10, AUTOTELIC_DEFAULTS.chillParkThreshold),
    maxSteps: clampInt(r.maxSteps, 1, 32, AUTOTELIC_DEFAULTS.maxSteps),
    intentMaxInputTokens: clampInt(r.intentMaxInputTokens, 512, 65536, AUTOTELIC_DEFAULTS.intentMaxInputTokens),
    intentMaxOutputTokens: clampInt(r.intentMaxOutputTokens, 128, 8192, AUTOTELIC_DEFAULTS.intentMaxOutputTokens),
    gateMaxInputTokens: clampInt(r.gateMaxInputTokens, 512, 65536, AUTOTELIC_DEFAULTS.gateMaxInputTokens),
    gateMaxOutputTokens: clampInt(r.gateMaxOutputTokens, 128, 8192, AUTOTELIC_DEFAULTS.gateMaxOutputTokens),
    reviewMaxInputTokens: clampInt(r.reviewMaxInputTokens, 512, 65536, AUTOTELIC_DEFAULTS.reviewMaxInputTokens),
    reviewMaxOutputTokens: clampInt(r.reviewMaxOutputTokens, 128, 8192, AUTOTELIC_DEFAULTS.reviewMaxOutputTokens),
  };
}

/** 安静时段：起止相同 = 关闭；跨零点（22→7）也要对 */
export function inQuietHours(cfg, hour = new Date().getHours()) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const a = Number(cfg?.quietStartHour) || 0;
  const b = Number(cfg?.quietEndHour) || 0;
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * 能力状态条（阶段 0）：把「为什么现在跑不了 / 能跑到哪一步」翻成人话。
 *
 * 口径必须是真的，不能写成「授权门放行」——核对过宿主接线：
 *   · `allowAct` 只改 prompt 措辞（`buildStepPrompt`），不是工具闸门；
 *     `run()` 收到它也没转交给任何围栏，真正的工具门禁是宿主全局
 *     `tools.guard`（危险命令无 QQ 确认窗口时直接拒绝），那层不在本模块里。
 *   · 所以这里只说「prompt 允不允许用工具」，外加一句全局守卫仍生效的提醒。
 *   · 能否立项 / 推进看 `canRun`（总闸、卡住、时段、额度、种子）。
 *
 * @returns {{ok:boolean, headline:string, tool:string, note:string, lines:string[]}}
 */
export function describeCapability({ enabled = false, allowAct = false, canRun = {} } = {}) {
  const g = canRun && typeof canRun === 'object' ? canRun : {};
  const ready = Boolean(enabled && g.ok !== false);
  const headline = !enabled
    ? '总开关关着：这一轮不会跑'
    : g.ok === false
      ? String(g.reason || '现在不满足启动条件')
      : '可以立项 / 推进';
  const tool = allowAct
    ? 'prompt 允许用工具，但危险命令仍由宿主全局守卫拦截'
    : 'prompt 禁止用工具（只能想）';
  const note = '「允许动手」只是措辞开关，不是授权闸门；无人轮次不会往主人私聊推。';
  return {
    ok: ready,
    headline,
    tool,
    note,
    lines: [headline, tool, note],
  };
}

/**
 * 好奇分：**决定先琢磨哪一件**。
 *
 * 只看三个可解释的因子，不搞玄学权重：
 *   · 多久没碰过（越久越想）—— `ageDays`
 *   · 被搁置过几次（提过又放下说明它在心里挂着）—— `deferred`
 *   · 有没有做过（做过的降权，避免反复嚼同一件事）—— `doneCount`
 *
 * 结果夹在 0–1。分数只用来**排序**，不写进任何结论性描述——
 * 一个 0.73 分的项目不比 0.68 分的「更值得做」，只是先看它。
 */
export function scoreCuriosity({ ageDays = 0, deferred = 0, doneCount = 0 } = {}) {
  const age = Math.max(0, Number(ageDays) || 0);
  const def = Math.max(0, Number(deferred) || 0);
  const done = Math.max(0, Number(doneCount) || 0);
  /** 新鲜度：7 天内快速上升，之后饱和（1 - e^(-d/7)） */
  const fresh = 1 - Math.exp(-age / 7);
  const stuck = Math.min(1, def / 3);
  const fatigue = Math.min(0.6, done * 0.2);
  const raw = 0.55 * fresh + 0.45 * stuck - fatigue;
  return Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
}

/**
 * 从种子里挑一个立项。
 *
 * @param {Array<{text:string, at?:number, deferred?:number, doneCount?:number}>} seeds
 * @param {{history?:Array, now?:number}} opts `history` 是账本里已有记录，用来看做过几次
 * @returns {{ok:boolean, project?:object, rejected:Array<{text:string, reason:string}>}}
 */
export function pickProject(seeds = [], { history = [], now = Date.now() } = {}) {
  const list = (Array.isArray(seeds) ? seeds : []).filter((s) => s && String(s.text ?? s).trim());
  if (!list.length) {
    return { ok: false, rejected: [], reason: '没有种子。先在面板上写几个想让她琢磨的方向' };
  }

  const rejected = [];
  const scored = [];
  for (const s of list) {
    const text = String(s.text ?? s).trim();
    const rows = (Array.isArray(history) ? history : []).filter((r) => String(r?.payload?.project ?? '') === text);
    const steps = rows.filter((r) => r.kind === 'step').length;
    /** 最近一次被碰的时间：种子自己的时间与账本里同名项目的记录取最大 */
    const times = [Number(s.at) || 0, ...rows.map((r) => Number(r.at) || 0)].filter(Boolean);
    const at = times.length ? Math.max(...times) : 0;
    const ageDays = at ? Math.max(0, (now - at) / DAY_MS) : 0;
    const score = scoreCuriosity({ ageDays, deferred: Number(s.deferred) || 0, doneCount: steps });
    /** 做满 3 次的先放着：不是不能做，是这一轮轮不到它 */
    if (steps >= 3) {
      rejected.push({ text, reason: `已经推进过 ${steps} 次，先放着` });
      continue;
    }
    scored.push({ text, score, steps });
  }

  if (!scored.length) return { ok: false, rejected, reason: '所有种子都推进过至少 3 次了，换点新的' };
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  return {
    ok: true,
    project: { id: `p-${randomUUID().slice(0, 8)}`, text: top.text, score: top.score, steps: top.steps },
    rejected,
  };
}

/** 立项后的推进 prompt。**明确禁止动手**（除非 allowAct） */
export function buildStepPrompt({ project, allowAct = false, lastNote = '', constraints = [] } = {}) {
  const lines = [
    '这是你自己的时间。没人跟你说话，你也不需要回谁。',
    `你在琢磨这件事：${String(project ?? '').trim()}`,
  ];
  if (lastNote) lines.push(`上一轮你想到了：${String(lastNote).slice(0, 400)}`);
  /**
   * 主人约束真正注入 prompt（阶段 3 B2）：此前 constraintLines 只被 status 展示，
   * 写了约束不拦任何东西。这里是**软约束**（模型应遵循），代码硬否决在阶段 4
   * 的三段决策里做——面板文案已如实标注，不再谎称「硬否决已生效」。
   */
  if (Array.isArray(constraints) && constraints.length) {
    lines.push('主人定下的硬规矩（违反即为错，宁可不做也别碰）：');
    for (const c of constraints.slice(0, 50)) lines.push(`- ${String(c).slice(0, 200)}`);
  }
  lines.push('');
  if (allowAct) {
    lines.push('可以动手：需要查资料就用工具查，但**不要发任何 QQ 消息**，不要改主人的任何配置或记忆。');
  } else {
    lines.push('这一轮**只能想，不能动手**：不要调用任何工具，也不要假装自己查到了什么。');
  }
  lines.push('用三五句话说清：现在想到哪了、下一步打算做什么。不要客套，不要总结自己是谁。');
  return lines.join('\n');
}

/**
 * 会话隔离（阶段 1）：每个项目一个独立会话，不再全挤在 `autotelic-main`。
 *
 * 为什么必须拆：同一个 sessionId 下，上一个项目的心得会污染下一个项目，
 * 「她在想什么」变成一锅粥；账本记了不同的 project，会话却还是同一条，对不上账。
 * 用项目 id 派生，稳定可复现（同一个项目重启后仍回到自己的会话）。
 * 老项目没有 id 时回落到固定会话，保证旧 state 不会突然断片。
 */
export function sessionIdFor(projectId = '') {
  const id = String(projectId || '').trim().slice(0, 80);
  return id ? `autotelic-${id}` : 'autotelic-main';
}

/**
 * 约束前置（阶段 1）：把主人写的强制规则拆成逐行，交调用方在候选生成前
 * 做硬否决。这里只做**文本归一化**，不在 prompt 里让模型自己判断——
 * 模型自判等于没约束。真正的否决点在阶段 4 的三段决策，本阶段先把数据与
 * 入口备好，并让 gate 在约束存在时把它连同 canRun 一起报给面板。
 */
export function constraintLines(rules = '') {
  return String(rules ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * 引擎主体。
 *
 * `run(prompt, { sessionId })` 由宿主注入：建/复用独立会话跑一轮，返回文本。
 * 不注入就没法推进（`think` 仍可用），这样单元测试不需要真会话。
 */
export function createAutotelic({
  dir = '', cfgOf = () => ({}), run = null, log = () => {}, now = () => Date.now(),
  /**
   * 决策审计日志（阶段 4，可选注入）：{ append(phase, round, payload) }。
   * 不注入就不写——老调用方/测试零影响；宿主注入 createDecisionLog 后，
   * 立项/推进会各落一行，模型回包作为 payload 原样进哈希链。
   */
  decisionLog = null,
  /**
   * 三段决策运行时（阶段 4，可选注入）：{ decideRound(opts) } = createPlanner()。
   * 不注入就没有 decide() 能力，老调用方零影响。
   */
  planner = null,
} = {}) {
  /** 决策阶段落账：写失败不阻断业务（审计是旁路，与主账本 appendLedger 的语义一致） */
  const noteDecision = async (phase, payload) => {
    if (!decisionLog || typeof decisionLog.append !== 'function') return;
    try { await decisionLog.append(phase, Number(payload.round) || 0, payload); }
    catch (e) { log(`决策审计写入失败（不影响本轮）：${e?.message || e}`); }
  };
  const stateFile = () => join(dir, STATE_FILE);
  const file = () => ledgerPath(dir);

  let state = loadState();
  function loadState() {
    try {
      const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
      return {
        project: raw?.project && typeof raw.project === 'object' ? raw.project : null,
        failures: Number(raw?.failures) || 0,
        stuckUntil: Number(raw?.stuckUntil) || 0,
        lastTickAt: Number(raw?.lastTickAt) || 0,
        lastNote: String(raw?.lastNote ?? '').slice(0, 400),
      };
    } catch {
      return { project: null, failures: 0, stuckUntil: 0, lastTickAt: 0, lastNote: '' };
    }
  }
  function saveState() {
    try {
      writeJsonAtomic(stateFile(), state, { newline: true });
    } catch (e) {
      log(`自驱状态写盘失败：${e?.message || e}`);
    }
  }

  const cfg = () => normalizeCfg(cfgOf());
  const ledger = () => readLedger(file(), { limit: 5000 });

  /** 今天推进了几次 */
  function stepsToday(rows, t = now()) {
    const day = new Date(t).toISOString().slice(0, 10);
    return rows.filter((r) => r.kind === 'step'
      && new Date(Number(r.at) || 0).toISOString().slice(0, 10) === day).length;
  }

  /**
   * 现在能不能跑。
   *
   * 顺序本身就是语义：先看总开关，再看卡住，再看时段，再看额度。
   * 报错要带**具体原因**——「没反应」是最难查的状态。
   */
  function gate(t = now()) {
    const c = cfg();
    if (!c.enabled) return { ok: false, reason: '自驱引擎没开（默认关）' };
    if (state.stuckUntil && t < state.stuckUntil) {
      const left = Math.ceil((state.stuckUntil - t) / HOUR_MS);
      return { ok: false, reason: `连续失败后卡住了，还有约 ${left} 小时` };
    }
    if (inQuietHours(c, new Date(t).getHours())) return { ok: false, reason: '现在是安静时段' };
    const rows = ledger().rows;
    const today = stepsToday(rows, t);
    if (c.maxPerDay > 0 && today >= c.maxPerDay) {
      return { ok: false, reason: `今天已经推进 ${today} 次，上限 ${c.maxPerDay}` };
    }
    if (!c.seeds.length) return { ok: false, reason: '没有种子' };
    return { ok: true };
  }

  /** 面板：状态一眼看完 */
  function status() {
    const c = cfg();
    const { rows, badLines, total } = ledger();
    const chain = verifyChain(rows);
    const t = now();
    const canRun = gate(t);
    return {
      ok: true,
      enabled: c.enabled,
      allowAct: c.allowAct,
      cfg: c,
      /** 能力状态条：把「为什么现在跑不了 / 能跑到哪一步」说清楚，不谎称有授权闸门 */
      capability: describeCapability({ enabled: c.enabled, allowAct: c.allowAct, canRun }),
      /** 约束前置的数据已就位；真正的硬否决在阶段 4 的三段决策，这里先让条数可见 */
      constraints: constraintLines(c.constraintRules),
      project: state.project,
      lastNote: state.lastNote,
      failures: state.failures,
      stuckUntil: state.stuckUntil,
      stuck: Boolean(state.stuckUntil && t < state.stuckUntil),
      lastTickAt: state.lastTickAt,
      today: dayStats(rows, new Date(t).toISOString().slice(0, 10)),
      ledger: {
        total,
        read: rows.length,
        badLines,
        chain,
        /** 断链时直接把断点说清楚，别只报「坏了」 */
        brokenAt: chain.ok ? 0 : chain.brokenAt,
        brokenReason: chain.ok ? '' : chain.reason,
      },
      canRun,
    };
  }

  /** 预览：会选哪个、哪些被否掉、为什么 */
  function preview() {
    const c = cfg();
    const { rows } = ledger();
    /**
     * 种子的两个来源：配置里手写的 + 最近几天梦里写的「明天想做的事」。
     * 梦那边默认关，关着时 `readDreamSeeds()` 恒为空——这里行为不变。
     * 只读，不改 autotelic 的任何开关：想让它真立项，还得自己把自驱打开。
     */
    const seeds = [...new Set([...(Array.isArray(c.seeds) ? c.seeds : []), ...readDreamSeeds(3)])];
    const picked = pickProject(seeds.map((text) => ({ text })), { history: rows, now: now() });
    return { ok: true, ...picked, seeds, canRun: gate(now()) };
  }

  /** 立项：只记账，不跑模型 */
  function think({ manual = false } = {}) {
    const g = gate(now());
    if (!g.ok) {
      appendLedger(file(), { kind: 'deny', payload: { by: manual ? 'manual' : 'tick' }, note: g.reason, at: now() });
      return { ok: false, reason: g.reason };
    }
    const p = preview();
    if (!p.ok) {
      appendLedger(file(), { kind: 'deny', payload: { by: manual ? 'manual' : 'tick' }, note: p.reason, at: now() });
      return { ok: false, reason: p.reason };
    }
    /**
     * 约束前置硬否决（阶段 4）：主人写的强制规则在代码层机械核对，触犯即 reject，
     * 不交给模型自判（§3.7 裁决二）。constraintCheck 读 title/reason/tag/want，
     * 这里把立项候选的 text 映射成 title。B2 的「硬否决」至此真正落地。
     */
    const c = cfg();
    const rules = parseConstraintRules(c.constraintRules || '').rules;
    if (rules.length) {
      const verdict = constraintCheck(rules, { title: p.project.text, reason: p.project.text, tag: '立项' });
      if (verdict.vetoed) {
        const why = `触犯主人约束：${verdict.hits.map((h) => h.text).join('；')}`;
        appendLedger(file(), {
          kind: 'deny', payload: { by: manual ? 'manual' : 'tick', constraint: true },
          note: why, at: now(), verdict: 'reject', tag: '立项',
        });
        return { ok: false, reason: why };
      }
    }
    state.project = p.project;
    state.lastNote = '';
    state.lastTickAt = now();
    saveState();
    appendLedger(file(), {
      kind: manual ? 'manual' : 'project',
      payload: { project: p.project.text, score: p.project.score, steps: p.project.steps },
      note: manual ? '面板手动立项' : '自动立项',
      at: now(),
      /** 阶段 1：立项就能追到会话与出处，梦种子也进账（此前梦种子只读不记） */
      sessionId: sessionIdFor(p.project.id),
      tag: '立项',
      verdict: 'pass',
      source: manual ? 'panel' : 'auto',
      evidence: [{ id: p.project.id, text: p.project.text, source: 'seed' }],
    });
    /** 决策审计：立项这一阶段原样落账（哈希链由注入方保证，模型改不了） */
    void noteDecision('intent', {
      project: p.project.text, score: p.project.score,
      rejected: p.rejected?.length || 0, round: Number(state.project?.steps) || 0,
    });
    return { ok: true, project: p.project, rejected: p.rejected };
  }

  /**
   * 推进一步。
   *
   * 失败不抛：计进 `failures`，达到上限记一条 `stuck` 并设卡住时间。
   * **失败也要进账本**——只记成功的话，账本会看起来一帆风顺，那是假账。
   */
  async function step({ manual = false } = {}) {
    const t0 = now();
    const g = gate(t0);
    if (!g.ok) {
      appendLedger(file(), { kind: 'deny', payload: { by: manual ? 'manual' : 'tick' }, note: g.reason, at: t0 });
      return { ok: false, reason: g.reason };
    }
    if (typeof run !== 'function') return { ok: false, reason: '宿主没接上会话，推不了' };
    if (!state.project) {
      const r = think({ manual });
      if (!r.ok) return r;
    }

    const c = cfg();
    const prompt = buildStepPrompt({
      project: state.project.text, allowAct: c.allowAct, lastNote: state.lastNote,
      constraints: constraintLines(c.constraintRules),
    });
    /** 每个项目一个会话：host.js 的 run() 已按传入的 sessionId 建/复用会话 */
    const sid = sessionIdFor(state.project.id);

    try {
      const text = await run(prompt, { sessionId: sid, allowAct: c.allowAct });
      const out = String(text ?? '').slice(0, c.maxOutputChars).trim();
      state.failures = 0;
      state.lastNote = out.slice(0, 400);
      state.lastTickAt = now();
      saveState();
      appendLedger(file(), {
        kind: 'step',
        payload: {
          project: state.project.text,
          chars: out.length,
          allowAct: c.allowAct,
          by: manual ? 'manual' : 'tick',
        },
        note: out,
        at: now(),
        sessionId: sid,
        tag: '推进',
        verdict: 'pass',
        source: manual ? 'panel' : 'tick',
      });
      void noteDecision('review', {
        project: state.project.text, chars: out.length, verdict: 'pass',
        round: Number(state.project.steps) || 0,
      });
      return { ok: true, text: out, project: state.project };
    } catch (e) {
      state.failures += 1;
      const limit = c.failLimit;
      const stuck = state.failures >= limit;
      if (stuck) state.stuckUntil = now() + c.stuckHours * HOUR_MS;
      saveState();
      appendLedger(file(), {
        kind: stuck ? 'stuck' : 'step',
        payload: { project: state.project.text, failed: true, failures: state.failures, by: manual ? 'manual' : 'tick' },
        note: String(e?.message || e).slice(0, 500),
        at: now(),
        sessionId: sid,
        tag: '推进',
        verdict: stuck ? 'park' : 'reject',
        source: manual ? 'panel' : 'tick',
      });
      return {
        ok: false,
        reason: stuck
          ? `连续失败 ${state.failures} 次，卡住 ${c.stuckHours} 小时：${e?.message || e}`
          : `这一轮失败了（第 ${state.failures} 次）：${e?.message || e}`,
      };
    }
  }

  /**
   * 心跳：自动判断该不该跑。
   *
   * `heartbeatMin = 0` 时**什么都不做**——手动模式，只能从面板点。
   * 这是默认值，所以「装了插件她就自己在后台跑」这件事不会发生。
   */
  async function tick() {
    const c = cfg();
    if (!c.enabled || c.heartbeatMin <= 0) return { ok: false, reason: '没开自动心跳' };
    const t = now();
    if (state.lastTickAt && t - state.lastTickAt < c.heartbeatMin * 60_000) {
      return { ok: false, reason: '还没到下一次心跳' };
    }
    const g = gate(t);
    if (!g.ok) return { ok: false, reason: g.reason };
    return state.project ? step({ manual: false }) : think({ manual: false });
  }

  /** 每日复盘：把今天的账本收成一段人话（不调模型，纯统计） */
  function review() {
    const t = now();
    const day = new Date(t).toISOString().slice(0, 10);
    const { rows } = ledger();
    const st = dayStats(rows, day);
    const todayRows = rows.filter((r) => new Date(Number(r.at) || 0).toISOString().slice(0, 10) === day);
    const projects = todayRows.filter((r) => r.kind === 'project' || r.kind === 'manual').map((r) => r.payload?.project).filter(Boolean);
    const notes = todayRows.filter((r) => r.kind === 'step' && !r.payload?.failed).map((r) => r.note).filter(Boolean);
    const lines = [
      `${day}：立项 ${st.projects} 次，推进 ${st.steps} 次，被拦 ${st.denies} 次。`,
    ];
    if (projects.length) lines.push(`今天想的是：${[...new Set(projects)].join('、')}`);
    if (notes.length) lines.push(`想到的：${notes.map((n) => n.slice(0, 120)).join(' / ')}`);
    if (!st.total) lines.push('今天什么都没做——没开、没到点，或者没种子。');
    const text = lines.join('\n');
    if (st.total) appendLedger(file(), { kind: 'review', payload: { day, ...st }, note: text.slice(0, 800), at: t });
    return { ok: true, day, stats: st, text };
  }

  /** 面板上的「最近账本」 */
  function recent(limit = 30) {
    const { rows } = ledger();
    const n = Math.min(200, Math.max(1, Number(limit) || 30));
    return { ok: true, rows: rows.slice(-n).reverse() };
  }

  /**
   * 三段决策（阶段 4）：意图生成 → 四态把关 → 行动单。
   * 观察窗来自我方账本 recent——每条带 id/at 的账本行就是一个观察，
   * 喂给 parseIntents 做「无出处候选作废」的硬校验（阶段 3 已抽）。
   * 没注入 planner 时明确说不可用，不静默退化成老立项（那会让人以为三段决策生效了）。
   */
  async function decide({ round = 0, maxObservations = 12 } = {}) {
    if (!planner || typeof planner.decideRound !== 'function') {
      return { ok: false, outcome: 'error', error: '三段决策未接线（planner 未注入）' };
    }
    const c = cfg();
    /** recent() 返回 {ok, rows}，不是裸数组——面板 showLedger 也是取 .rows */
    const rows = recent(maxObservations).rows.map((r) => ({
      id: String(r.id ?? r.at),
      at: Number(r.at) || 0,
      source: r.kind === 'deny' ? 'constraint' : 'ledger',
      text: String(r.note || r.payload?.project || r.payload?.text || '').slice(0, 200),
    })).filter((o) => o.text);
    const r = await planner.decideRound({
      round,
      persona: { summary: '', instinctExtra: '' },
      constraintRulesText: constraintLines(c.constraintRules).map((x) => `- ${x}`).join('\n'),
      observations: rows,
      ticketBudget: { maxSteps: 4, timeoutMs: 120_000 },
    });
    return { ok: r.outcome !== 'error', ...r };
  }

  return {
    status, preview, think, step, tick, review, recent, decide,
    /** 测试与「重新读配置」用 */
    reload: () => { state = loadState(); return status(); },
    gate,
  };
}
