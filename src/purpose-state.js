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

const normalizeGoal = (g = {}) => ({
  id: String(g?.id ?? '').slice(0, 120),
  owner: GOAL_OWNERS.includes(g?.owner) ? g.owner : 'self',
  status: GOAL_STATUSES.includes(g?.status) ? g.status : 'hypothesis',
  intent: String(g?.intent ?? '').slice(0, 300),
  confidence: num01(g?.confidence),
  value: num01(g?.value),
  urgency: num01(g?.urgency),
  risk: num01(g?.risk),
  at: Number(g?.at) || 0,
  /** 证据 id 列表：阶段 3 用它做「无出处不立项」的硬校验 */
  evidenceIds: Array.isArray(g?.evidenceIds)
    ? g.evidenceIds.map((x) => String(x ?? '').slice(0, 120)).filter(Boolean).slice(0, 50)
    : [],
});

/** 归一化整份状态：无论磁盘上是什么，出去都是四块合法结构 */
export function normalizeState(raw = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
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
