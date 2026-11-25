/**
 * 目的引擎的持久化状态（阶段 1：只建数据层，不做算法）。
 * ======================================================
 *
 * 为什么先建文件、不先写引擎：aurabot 的 purpose 九维驱力 / 观察账 / 目标假设
 * 六态 / 确认反馈全靠一份能回滚、能验形状的状态撑着。我方过去把这类东西散在
 * prompt 和临时变量里，重启就没了，也就无从谈「目标假设随主人反馈变化」。
 *
 * 本模块只负责**怎么存**，不负责**怎么算**：
 *   · 四块：`drives`（九维驱力当前值）/ `observations`（观察账）/ `goals`（目标假设）/ `feedback`（确认反馈）；
 *   · 写前留 `.prev` 快照（只一份），照 `memory.js` 的口径——快照失败不拦正本；
 *   · 坏文件降级为空，不让一份写坏的状态让整个宿主启动失败；
 *   · 形状归一化：读进来什么都可能，出去的一定是这四块的合法结构。
 *
 * 阶段 3 才接算法与面板，本阶段只保证「有地方存、存得稳、退得回」。
 */

import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic.js';

export const STATE_FILE = 'purpose-state.json';
export const DRIVE_KEYS = Object.freeze([
  'play', 'learn', 'install', 'connect', 'care', 'share', 'identity', 'create', 'consume',
]);
export const GOAL_STATUSES = Object.freeze([
  'hypothesis', 'active', 'confirmed', 'rejected', 'done', 'expired',
]);
export const GOAL_OWNERS = Object.freeze(['self', 'owner', 'member', 'media']);
export const FEEDBACK_KINDS = Object.freeze(['confirmed', 'rejected', 'ignored']);

/** 九驱力出厂值：与 aurabot DEFAULT_DRIVES 同口径，只作为缺失时的兜底 */
export const DEFAULT_DRIVES = Object.freeze({
  play: 0.20, learn: 0.12, install: 0.10, connect: 0.28, care: 0.22,
  share: 0.20, identity: 0.14, create: 0.05, consume: 0.05,
});

const num01 = (v, dflt = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
};

/** 归一化驱力：缺失键补默认值，越界夹紧，未知键丢掉（防写坏配置撑爆面板） */
export function normalizeDrives(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of DRIVE_KEYS) out[k] = num01(r[k], DEFAULT_DRIVES[k]);
  return out;
}

/**
 * 目标假设形状。**必须与 purpose-engine 的 normalizeGoal 同口径**——
 * 之前这里缺 `domain`，而引擎 `normalizeGoal` 硬要求 domain+intent 否则 return null，
 * 导致本模块存的目标喂进引擎全被静默丢弃（阶段 3 B1）。字段对齐，老数据缺 domain
 * 时兜底为 `connect` 并标 `legacyDomain:true`，不静默丢失。
 */
const normalizeGoal = (g = {}) => {
  const domain = DRIVE_KEYS.includes(g?.domain) ? g.domain : 'connect';
  const legacyDomain = !DRIVE_KEYS.includes(g?.domain);
  const evidenceIds = Array.isArray(g?.evidenceIds)
    ? g.evidenceIds.map((x) => String(x ?? '').slice(0, 120)).filter(Boolean).slice(0, 50)
    : [];
  return {
    id: String(g?.id ?? '').slice(0, 120),
    owner: GOAL_OWNERS.includes(g?.owner) ? g.owner : 'self',
    status: GOAL_STATUSES.includes(g?.status) ? g.status : 'hypothesis',
    /** 引擎必需：domain 缺失会让 normalizeGoal 丢弃整条目标 */
    domain,
    object: g?.object && typeof g.object === 'object'
      ? { type: String(g.object.type ?? 'topic').slice(0, 12), name: String(g.object.name ?? '').slice(0, 32) }
      : { type: 'topic', name: String(g?.object ?? '').slice(0, 32) },
    intent: String(g?.intent ?? '').slice(0, 300),
    confidence: num01(g?.confidence),
    value: num01(g?.value),
    urgency: num01(g?.urgency),
    risk: num01(g?.risk),
    action: String(g?.action ?? 'share').slice(0, 16),
    nextStep: String(g?.nextStep ?? '').slice(0, 80),
    /** 引擎 evidence 是 {id,text,source,at}[]；本地 evidenceIds 转成它，双向保留 */
    evidence: Array.isArray(g?.evidence)
      ? g.evidence.slice(-4).map((e) => ({
        id: String(e?.id ?? '').slice(0, 80),
        text: String(e?.text ?? '').slice(0, 120),
        source: String(e?.source ?? '').slice(0, 12),
        at: Number(e?.at) || 0,
      }))
      : evidenceIds.slice(-4).map((id) => ({ id, text: '', source: '', at: 0 })),
    evidenceIds,
    createdAt: Number(g?.createdAt) || 0,
    lastSeenAt: Number(g?.lastSeenAt) || 0,
    expiresAt: Number(g?.expiresAt) || 0,
    attempts: Math.min(20, Math.max(0, Number(g?.attempts) || 0)),
    sightings: Math.min(99, Math.max(1, Number(g?.sightings) || 1)),
    source: String(g?.source ?? 'event').slice(0, 12),
    at: Number(g?.at) || 0,
    /** 老数据缺 domain 时的标记，面板可提示「这条是升级前存的」 */
    ...(legacyDomain ? { legacyDomain: true } : {}),
  };
};

/** 归一化整份状态：无论磁盘上是什么，出去都是四块合法结构 */
export function normalizeState(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const int = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const str = (v, max = 120) => String(v ?? '').slice(0, max);
  const counts = (v, len) => {
    const out = new Array(len).fill(0);
    if (Array.isArray(v)) for (let i = 0; i < len; i += 1) { const n = Number(v[i]); if (Number.isFinite(n) && n > 0) out[i] = Math.min(9999, Math.round(n)); }
    return out;
  };
  return {
    drives: normalizeDrives(r.drives),
    observations: Array.isArray(r.observations)
      ? r.observations.slice(-500).map((o) => ({
        key: String(o?.key ?? '').slice(0, 120),
        count: Math.max(0, Number(o?.count) || 0),
        seenIds: Array.isArray(o?.seenIds) ? o.seenIds.map((x) => String(x ?? '').slice(0, 120)).slice(0, 200) : [],
        at: Number(o?.at) || 0,
      }))
      : [],
    goals: Array.isArray(r.goals) ? r.goals.slice(-200).map(normalizeGoal) : [],
    feedback: Array.isArray(r.feedback)
      ? r.feedback.slice(-500).map((f) => ({
        kind: FEEDBACK_KINDS.includes(f?.kind) ? f.kind : 'ignored',
        goalId: String(f?.goalId ?? '').slice(0, 120),
        note: String(f?.note ?? '').slice(0, 300),
        at: Number(f?.at) || 0,
      }))
      : [],
    /**
     * 排程与历史（P0 第六批补）：早期 normalizeState 只存了上面 4 块，
     * 运行时要的 day/countToday/nextFireAt/history/pending 全被洗掉——
     * 状态根本存不住，tick 每轮都像第一次启动。这里与对方字段逐项对齐。
     */
    version: Number(r.version) || 1,
    day: str(r.day, 10),
    countToday: int(r.countToday),
    lastRunAt: int(r.lastRunAt),
    lastAttemptAt: int(r.lastAttemptAt),
    lastSentAt: int(r.lastSentAt),
    lastOutcome: str(r.lastOutcome, 24),
    lastPurpose: str(r.lastPurpose, 120),
    lastText: str(r.lastText, 200),
    nextFireAt: int(r.nextFireAt),
    attempts: int(r.attempts),
    drivesAt: int(r.drivesAt),
    replyHours: counts(r.replyHours, 24),
    replyWeekday: counts(r.replyWeekday, 7),
    replyHoursSeen: Array.isArray(r.replyHoursSeen) ? r.replyHoursSeen.map(String).slice(-200) : [],
    needFeedback: r.needFeedback && typeof r.needFeedback === 'object' && !Array.isArray(r.needFeedback) ? r.needFeedback : {},
    lastEmotion: str(r.lastEmotion, 24),
    lastEmotionText: str(r.lastEmotionText, 30),
    lastGoalId: str(r.lastGoalId, 24),
    lastMaterialCount: int(r.lastMaterialCount),
    lastCandidateCount: int(r.lastCandidateCount),
    pending: Array.isArray(r.pending) ? r.pending.slice(-20).map((p) => ({
      id: str(p?.id, 40), text: str(p?.text, 120), kind: str(p?.kind, 20),
      need: str(p?.need, 20), action: str(p?.action, 20), emotion: str(p?.emotion, 20),
      source: str(p?.source, 20), createdAt: int(p?.createdAt), expiresAt: int(p?.expiresAt), hits: int(p?.hits),
    })) : [],
    history: Array.isArray(r.history) ? r.history.slice(-60).map((h) => ({
      at: int(h?.at), outcome: str(h?.outcome, 24), kind: str(h?.kind, 20),
      need: str(h?.need, 20), action: str(h?.action, 20), emotion: str(h?.emotion, 20),
      purpose: str(h?.purpose, 120), text: str(h?.text, 200), planned: str(h?.planned, 120),
      sourceId: str(h?.sourceId, 80), goalId: str(h?.goalId, 24),
      goalOwner: str(h?.goalOwner, 20), confidence: h?.confidence ?? null,
    })) : [],
    lastSkip: r.lastSkip && typeof r.lastSkip === 'object' ? { at: int(r.lastSkip.at), reason: str(r.lastSkip.reason, 80) } : null,
    /**
     * 朋友分区（P3）：每个朋友一套独立排程/历史/待续，互不影响、也不占主人额度。
     * 结构 { [openid]: {同上面全部字段} }；这里只做浅归一化，深字段按需在 runner 里补。
     */
    friends: r.friends && typeof r.friends === 'object' && !Array.isArray(r.friends)
      ? Object.fromEntries(Object.entries(r.friends).slice(0, 20).map(([k, v]) => [
        str(k, 40),
        {
          day: str(v?.day, 10), countToday: int(v?.countToday), lastRunAt: int(v?.lastRunAt),
          nextFireAt: int(v?.nextFireAt), attempts: int(v?.attempts), lastOutcome: str(v?.lastOutcome, 24),
          lastPurpose: str(v?.lastPurpose, 120), lastText: str(v?.lastText, 200),
          drives: normalizeDrives(v?.drives), drivesAt: int(v?.drivesAt),
          goals: Array.isArray(v?.goals) ? v.goals.slice(-50).map(normalizeGoal) : [],
          observations: Array.isArray(v?.observations) ? v.observations.slice(-200) : [],
          pending: Array.isArray(v?.pending) ? v.pending.slice(-10) : [],
          history: Array.isArray(v?.history) ? v.history.slice(-30) : [],
          lastSkip: v?.lastSkip || null,
        },
      ]))
      : {},
  };
}

export function createPurposeState({ dir = '', log = () => {} } = {}) {
  const file = () => join(dir, STATE_FILE);
  let cache = null;

  function read({ fresh = false } = {}) {
    if (cache && !fresh) return cache;
    let raw = null;
    if (existsSync(file())) {
      try {
        raw = JSON.parse(readFileSync(file(), 'utf8'));
      } catch (e) {
        log(`目的状态读失败，按空状态继续：${e?.message || e}`);
        raw = null;
      }
    }
    cache = normalizeState(raw);
    return cache;
  }

  function write(mutator) {
    const cur = read({ fresh: true });
    const next = normalizeState(typeof mutator === 'function' ? mutator(cur) : mutator);
    /** 写前快照：只留一份 .prev，失败不拦正本（照 memory.js） */
    try {
      if (existsSync(file())) copyFileSync(file(), `${file()}.prev`);
    } catch { /* 保险失败不挡主流程 */ }
    try {
      writeJsonAtomic(file(), next, { newline: true });
      cache = next;
      return { ok: true, state: next };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }

  return {
    file,
    read,
    write,
    /** 回滚到上一版：没有 .prev 就如实说没有，不假装成功 */
    rollback() {
      const prev = `${file()}.prev`;
      if (!existsSync(prev)) return { ok: false, reason: '没有上一版快照' };
      try {
        const next = normalizeState(JSON.parse(readFileSync(prev, 'utf8')));
        writeJsonAtomic(file(), next, { newline: true });
        cache = next;
        return { ok: true, state: next };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
      }
    },
    reload: () => read({ fresh: true }),
  };
}
