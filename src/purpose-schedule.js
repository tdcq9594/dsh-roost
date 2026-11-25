/**
 * 目的引擎 · 排程层（P0 第一批）——移植自 aurabot-beta `src/purpose/engine.js`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 这一层回答一个问题：**「下一次什么时候该主动找主人」**。
 * 它只做纯计算与状态迁移，不读大文件、不调模型——所以可以单测、可以在每次 tick 上跑。
 *
 * 分档（与对方一致）：
 *   · `planNextFire`：算下一次的时刻（间隔随机 + 时段学习 + 星期学习 + 避开安静时段）
 *   · `evaluatePurposeTick`：每次 tick 判定「现在能不能跑」，不能跑就给出下次重试时刻
 *   · `markPurposeDelivered` / `markPurposeSkip`：占次数 / 记跳过原因
 *
 * 依赖 `purpose-engine.js` 的 DEFAULT_PURPOSE_CONFIG（字段已与对方逐项对齐）。
 */
import { DEFAULT_PURPOSE_CONFIG } from './purpose-engine.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const clip = (text, max = 120) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** 本地日期键 YYYY-MM-DD（不用 toISOString：那是 UTC，凌晨会算成前一天）。 */
export function localDateKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const clockText = (hh, mm) => `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;

/** `"8:00"` / `"08:00"` → `{ hh, mm, text }`；非法值回退 fallback。 */
export function parseClock(value, fallback = '08:00') {
  const pick = (raw) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    return { hh, mm };
  };
  const parsed = pick(value) ?? pick(fallback) ?? { hh: 8, mm: 0 };
  return { ...parsed, text: clockText(parsed.hh, parsed.mm) };
}

const minutesOfDay = (at) => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};

/** 安静时段是否包含 now；quietStart === quietEnd 视为不启用。 */
export function inQuietHours(now, config = DEFAULT_PURPOSE_CONFIG) {
  const start = parseClock(config.quietStart, '23:30');
  const end = parseClock(config.quietEnd, '08:30');
  if (start.text === end.text) return false;
  const s = start.hh * 60 + start.mm;
  const e = end.hh * 60 + end.mm;
  const m = minutesOfDay(now);
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

/** 下一个「安静结束」时刻（严格晚于 now）。 */
export function quietEndAfter(now, config = DEFAULT_PURPOSE_CONFIG) {
  const end = parseClock(config.quietEnd, '08:30');
  const d = new Date(now);
  d.setHours(end.hh, end.mm, 0, 0);
  while (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 下一天的起点（安静结束优先；没设安静时段就取次日 00:05）。 */
export function nextDayStartAfter(now, config = DEFAULT_PURPOSE_CONFIG) {
  const start = parseClock(config.quietStart, '23:30');
  const end = parseClock(config.quietEnd, '08:30');
  if (start.text !== end.text) return quietEndAfter(now, config);
  const d = new Date(now);
  d.setHours(0, 5, 0, 0);
  while (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 跨天清零当日次数（状态里 day 变了就重置）。 */
export function ensurePurposeDay(state, now = Date.now()) {
  const day = localDateKey(now);
  if (state.day !== day) {
    state.day = day;
    state.countToday = 0;
  }
  return state;
}

/** 首次启动 / 状态里没有 nextFireAt 时，排一个初始延迟（落在安静时段就推到安静结束）。 */
export function ensurePurposeSchedule(state, { now = Date.now(), config = DEFAULT_PURPOSE_CONFIG, random = Math.random } = {}) {
  if (!state.nextFireAt) {
    let at = now + Math.max(MINUTE, Math.min(config.initialDelayMinMs, config.gapMinMs));
    const shift = bestReplyHourShift(at, state.replyHours);
    if (shift > 0) at += shift;
    if (inQuietHours(at, config)) at = quietEndAfter(at, config) + Math.round(random() * 20 * MINUTE);
    state.nextFireAt = at;
  }
  return state;
}

const normalizeCounts = (raw, len) => {
  const out = new Array(len).fill(0);
  if (Array.isArray(raw)) {
    for (let i = 0; i < len; i += 1) {
      const n = Number(raw[i]);
      if (Number.isFinite(n) && n > 0) out[i] = Math.min(9999, Math.round(n));
    }
  }
  return out;
};

const normalizeReplyHours = (raw) => normalizeCounts(raw, 24);

/** 把素材里主人的私聊发言时刻记进 24 小时 × 星期直方图（按素材 id 去重）。 */
export function recordOwnerReplyHours(state, materials, now = Date.now()) {
  const hist = normalizeReplyHours(state.replyHours);
  const week = normalizeCounts(state.replyWeekday, 7);
  const seen = new Set(Array.isArray(state.replyHoursSeen) ? state.replyHoursSeen.map(String) : []);
  let changed = false;
  for (const m of Array.isArray(materials) ? materials : []) {
    if (m?.kind !== 'owner') continue;
    const at = Number(m.at) || 0;
    if (!at || at > now) continue;
    const id = String(m.id ?? '') || `t:${at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const d = new Date(at);
    hist[d.getHours()] += 1;
    week[d.getDay()] += 1;
    changed = true;
  }
  if (changed) {
    state.replyHours = hist;
    state.replyWeekday = week;
    state.replyHoursSeen = [...seen].slice(-200);
  }
  return state;
}

/**
 * 基于直方图给候选时刻找更好的落点：只在 +0~maxShift 内向后找，
 * 且只有某小时的回复密度明显更高（>1.1×）才移过去；样本 <5 条时不偏置。
 */
export function bestReplyHourShift(at, replyHours = [], { maxShiftMs = 3 * HOUR } = {}) {
  const hist = normalizeReplyHours(replyHours);
  const total = hist.reduce((s, v) => s + v, 0);
  if (total < 5) return 0;
  const score = (t) => hist[new Date(t).getHours()] / total;
  let best = 0;
  let bestScore = score(at);
  for (let off = 15 * MINUTE; off <= maxShiftMs; off += 15 * MINUTE) {
    const s = score(at + off);
    if (s > bestScore * 1.1) { bestScore = s; best = off; }
  }
  return best;
}

/**
 * 星期分桶：今天不是主人常回话的日子，就往未来 7 天里第一个高回流日挪。
 * 样本 <7 条不偏置；今天已是高回流日（≥最佳日 50%）不动；
 * 非零桶 <2 也不偏置（样本全挤在某一天不代表「只在那天回话」）。
 */
export function bestReplyWeekdayShift(at, replyWeekday = [], { minSamples = 7 } = {}) {
  const hist = normalizeCounts(replyWeekday, 7);
  const total = hist.reduce((s, v) => s + v, 0);
  if (total < minSamples) return 0;
  const days = hist.filter((v) => v > 0).length;
  if (days < 2) return 0;
  const best = Math.max(...hist);
  if (best <= 0) return 0;
  const cur = hist[new Date(at).getDay()];
  if (cur >= best * 0.5) return 0;
  for (let add = 1; add <= 7; add += 1) {
    const t = new Date(at);
    t.setDate(t.getDate() + add);
    if (hist[t.getDay()] >= best * 0.8) return t.getTime() - at;
  }
  return 0;
}

/**
 * 下一次该在什么时候主动找主人。
 * · 距上次「真正完成」至少 gapMin~gapMax；
 * · 停机很久后只补一枪（2 分钟后），不连着补；
 * · 有回复时段直方图时，向主人更可能在线的小时轻推（最多 3 小时）；
 * · 星期分桶再往主人常回话的日子轻推（最多 7 天）；
 * · 算出来落在安静时段就推到安静结束 + 0~20 分钟抖动。
 */
export function planNextFire({
  now = Date.now(),
  config = DEFAULT_PURPOSE_CONFIG,
  lastRunAt = 0,
  countToday = 0,
  replyHours = [],
  replyWeekday = [],
  random = Math.random,
} = {}) {
  const min = Math.max(5 * MINUTE, Number(config.gapMinMs) || DEFAULT_PURPOSE_CONFIG.gapMinMs);
  const max = Math.max(min, Number(config.gapMaxMs) || min);
  const gap = Math.round(min + random() * (max - min));
  let at;
  if (config.dailyMax > 0 && countToday >= config.dailyMax) {
    at = nextDayStartAfter(now, config);
  } else if (lastRunAt > 0) {
    at = lastRunAt + gap;
    if (at < now + 2 * MINUTE) at = now + 2 * MINUTE;
  } else {
    at = now + Math.max(MINUTE, Math.min(config.initialDelayMinMs, min));
  }
  const shift = bestReplyHourShift(at, replyHours);
  if (shift > 0) at += shift;
  const dayShift = bestReplyWeekdayShift(at, replyWeekday);
  if (dayShift > 0) at += dayShift;
  if (inQuietHours(at, config)) at = quietEndAfter(at, config) + Math.round(random() * 20 * MINUTE);
  return at;
}

const waitUntil = (at, reason) => ({ action: 'wait', reason, nextFireAt: Math.max(0, Math.round(at)) });

/**
 * 每次 tick 的判定：能不能现在主动找主人。
 * env 由接线层提供（都是便宜的状态，不读大文件）：
 *   enabled / modeOk / dshReady / paused / ownerAllowed / busy / friendOk / budgetBlocked / ownerIdleMs
 */
export function evaluatePurposeTick({ now = Date.now(), config = DEFAULT_PURPOSE_CONFIG, state, env = {}, random = Math.random } = {}) {
  ensurePurposeDay(state, now);
  if (!config.enabled || env.enabled === false) return waitUntil(0, 'disabled');
  if (env.modeOk === false) return waitUntil(now + 5 * MINUTE, 'mode');
  if (env.dshReady === false) return waitUntil(now + 5 * MINUTE, 'dsh');
  if (env.paused === true) return waitUntil(now + 10 * MINUTE, 'paused');
  if (env.ownerAllowed === false) return waitUntil(now + HOUR, 'owner-not-allowed');
  if (inQuietHours(now, config)) {
    /** 安静时段不在每次 tick 上抖动（否则状态文件每分钟都在变）；到点后由 planNextFire 再加随机。 */
    return waitUntil(quietEndAfter(now, config), 'quiet');
  }
  if (config.dailyMax > 0 && state.countToday >= config.dailyMax) {
    return waitUntil(nextDayStartAfter(now, config), 'daily-max');
  }
  if (state.nextFireAt && now < state.nextFireAt) return waitUntil(state.nextFireAt, 'waiting');
  if (env.busy === true) return waitUntil(now + 5 * MINUTE, 'busy');
  const idle = Number(env.ownerIdleMs);
  if (Number.isFinite(idle) && idle >= 0 && idle < config.idleThresholdMs) {
    const remain = Math.max(MINUTE, config.idleThresholdMs - idle);
    return waitUntil(now + Math.min(30 * MINUTE, remain), 'owner-active');
  }
  if (env.friendOk === false) return waitUntil(now + 6 * HOUR, 'not-friend');
  if (env.budgetBlocked === true) return waitUntil(now + 30 * MINUTE, 'budget');
  return { action: 'run', reason: 'due', nextFireAt: now };
}

/** 投递出去就先占今日次数（不管最后她有没有发消息，模型回合已经花钱了）。 */
export function markPurposeDelivered(state, { now = Date.now(), planned = null } = {}) {
  ensurePurposeDay(state, now);
  state.countToday += 1;
  state.lastAttemptAt = now;
  state.attempts = (Number(state.attempts) || 0) + 1;
  state.lastOutcome = 'pending';
  if (planned?.text) state.lastPurpose = clip(planned.text, 120);
  return state;
}

/** 记一次「这轮跳过了」及原因，并安排下次。 */
export function markPurposeSkip(state, { now = Date.now(), reason = '', nextFireAt = 0 } = {}) {
  state.lastSkip = { at: now, reason: String(reason ?? '').slice(0, 80) };
  if (nextFireAt > 0) state.nextFireAt = nextFireAt;
  return state;
}

export { MINUTE, HOUR, clampInt, clip };
