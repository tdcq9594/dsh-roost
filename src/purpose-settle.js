/**
 * 目的引擎 · 状态结算层（P0 第二批）——移植自 aurabot-beta `src/purpose/engine.js`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 这一层回答：**一轮跑完之后，状态怎么变**。
 *   · `applyPurposeOutcome`：sent/silent/failed 三态结算（目标置信度、驱力满足、待续账、历史、下次时刻）
 *   · `satisfyDrives` / `applyFeelingDeltas`：驱力满足与模型自报感受
 *   · `addPendingPurpose` / `resolvePendingPurpose`：「心里还惦记着」的账
 *   · `parsePurposeMemo`：从回合回执里解析【目的】【状态】【待续】等内部备忘
 *
 * 依赖第一批 `purpose-schedule.js`（planNextFire/ensurePurposeDay/clip）与
 * `purpose-engine.js`（DEFAULT_PURPOSE_CONFIG/PURPOSE_NEEDS/normalizeDrives）。
 */
import { DEFAULT_PURPOSE_CONFIG, PURPOSE_NEEDS, normalizeDrives } from './purpose-engine.js';
import { planNextFire, ensurePurposeDay, clip } from './purpose-schedule.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** FNV-1a 短哈希：给待续条目生成稳定 id。 */
function hashId(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 中文双字 + 英文词袋，用于相似度。 */
function tokenSet(text) {
  const s = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const set = new Set();
  for (const part of s.split(/\s+/)) {
    if (!part) continue;
    if (/^[a-z0-9]{2,}$/.test(part)) set.add(part);
    for (let i = 0; i + 1 < part.length; i += 1) set.add(part.slice(i, i + 2));
  }
  return set;
}

/** 中文双字 + 英文词袋的 Jaccard；0~1。 */
export function textSimilarity(a, b) {
  const A = tokenSet(a);
  const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 这段话是不是已经说过了（和最近的 purpose/planned/text 比）。 */
export function isDuplicateText(text, history = [], threshold = 0.55) {
  const target = String(text ?? '').trim();
  if (!target) return true;
  for (const h of history) {
    if (!h) continue;
    if (textSimilarity(target, h.purpose || '') >= threshold) return true;
    if (textSimilarity(target, h.planned || '') >= threshold) return true;
    if (h.text && textSimilarity(target, h.text) >= threshold) return true;
  }
  return false;
}

/** 驱力满足：真发出去了对应需要才降，没发出去只轻微回落。 */
export function satisfyDrives(drives, { need = '', action = '', outcome = 'sent' } = {}) {
  const next = normalizeDrives(drives);
  if (outcome === 'sent') {
    if (need && next[need] != null) next[need] *= 0.45;
    if (action === 'confide' || need === 'connect') next.connect *= 0.55;
    next.share *= 0.9;
  } else if (outcome === 'silent') {
    if (need && next[need] != null) next[need] *= 0.85;
  }
  return next;
}

/** 模型自报的感受增量（【感受】段），叠加在满足衰减之后。 */
export function applyFeelingDeltas(drives, deltas = {}) {
  const next = normalizeDrives(drives);
  for (const need of PURPOSE_NEEDS) {
    const d = Number(deltas?.[need]);
    if (Number.isFinite(d)) next[need] = Math.min(1, Math.max(0, next[need] + d));
  }
  return next;
}

/**
 * 从回合最后的内部备忘里解析目的。
 *
 * **本仓精简版**：只解析【目的】【类型】【状态】【待续】【需求】【情绪】，
 * 【感受】段暂不解析（`feelings` 恒为 null）——它依赖心情模块的 parseFeelings，
 * 属后续批次。其余口径与对方一致（含裸标签与 JSON 两种兜底）。
 */
export function parsePurposeMemo(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const grab = (label) => {
    const re = new RegExp(`[【\\[]${label}[】\\]]\\s*[:：]?\\s*([^\\n【\\[]{0,160})`);
    const m = re.exec(raw);
    return m ? m[1].trim() : '';
  };
  const purpose = grab('目的');
  const kindRaw = grab('类型');
  const statusRaw = grab('状态');
  const followUp = grab('待续');
  const needRaw = grab('需求');
  const emotionRaw = grab('情绪');
  const kindMap = { 分享: 'share', 索取: 'ask', 关心: 'care', 好奇: 'curiosity', 追问: 'follow-up' };
  const needMap = {
    玩: 'play', 学: 'learn', 装: 'install', 陪: 'connect', 关心: 'care',
    分享: 'share', 自我: 'identity', 身份: 'identity', 创作: 'create', 体验: 'consume',
    play: 'play', learn: 'learn', install: 'install', connect: 'connect', care: 'care',
    share: 'share', identity: 'identity', create: 'create', consume: 'consume',
  };
  const actionMap = { share: 'share', ask: 'ask', care: 'ask', curiosity: 'curiosity', 'follow-up': 'follow' };
  const status = /跳过/.test(statusRaw) ? '跳过' : /待续/.test(statusRaw) ? '待续' : /完成/.test(statusRaw) ? '完成' : '';
  let purposeText = purpose;
  let kindText = kindRaw;
  let statusText = statusRaw;
  let followUpText = followUp;
  let needText = needRaw;
  let emotionTextRaw = emotionRaw;
  if (!purposeText && !kindText && !statusText) {
    /** 兜底①：模型忘了写【】，但按「目的：…」这种裸标签行写了。 */
    const loosePurpose = /^\s*目的\s*[:：]\s*([^\n【\[]{2,120})/m.exec(raw);
    const looseStatus = /^\s*状态\s*[:：]\s*([^\n【\[]{0,20})/m.exec(raw);
    const looseFollowUp = /^\s*待续\s*[:：]\s*([^\n【\[]{0,120})/m.exec(raw);
    if (loosePurpose) purposeText = loosePurpose[1].trim();
    if (looseStatus) statusText = looseStatus[1].trim();
    if (looseFollowUp) followUpText = looseFollowUp[1].trim();
    /** 兜底②：回执是一段 JSON（中文键或英文键都认）。 */
    if (!purposeText) {
      const jsonMatch = /\{[^{}]{0,800}\}/.exec(raw);
      if (jsonMatch) {
        try {
          const obj = JSON.parse(jsonMatch[0]);
          const pick = (...keys) => {
            for (const k of keys) if (typeof obj?.[k] === 'string' && obj[k].trim()) return obj[k].trim();
            return '';
          };
          purposeText = pick('目的', 'purpose');
          statusText = statusText || pick('状态', 'status');
          followUpText = followUpText || pick('待续', 'followUp', 'follow_up');
          needText = needText || pick('需求', 'need');
          kindText = kindText || pick('类型', 'kind');
          emotionTextRaw = emotionTextRaw || pick('情绪', 'emotion');
        } catch {
          // 不是合法 JSON 就当没有，继续走空判断。
        }
      }
    }
  }
  const kind = kindMap[kindText] || (kindText ? 'share' : '');
  const need = needMap[String(needText).trim().slice(0, 2)] || needMap[String(needText).trim()] || '';
  const statusFinal = /跳过/.test(statusText) ? '跳过' : /待续/.test(statusText) ? '待续' : /完成/.test(statusText) ? '完成' : '';
  if (!purposeText && !kind && !statusFinal) return null;
  return {
    purpose: clip(purposeText, 120),
    kind: kind || 'share',
    need: need || '',
    action: actionMap[kind] || '',
    emotionText: clip(emotionTextRaw, 30),
    status: statusFinal || '完成',
    followUp: followUpText === '无' ? '' : clip(followUpText, 120),
    /** 精简版：感受解析留待后续批次 */
    feelings: null,
    memoLoose: Boolean(!purpose && !kindRaw && !status && (purposeText || statusText)),
  };
}

/** 记一条「心里还惦记着」；同义条目累加 hits 而不是重复堆。 */
export function addPendingPurpose(state, {
  text = '',
  kind = 'curiosity',
  need = '',
  action = '',
  emotion = '',
  now = Date.now(),
  config = DEFAULT_PURPOSE_CONFIG,
} = {}) {
  const clean = clip(text, 120);
  if (!clean || clean === '无') return null;
  const existing = (Array.isArray(state.pending) ? state.pending : [])
    .find((p) => textSimilarity(p.text, clean) >= 0.7);
  if (existing) {
    existing.hits = Math.min(99, (Number(existing.hits) || 0) + 1);
    existing.createdAt = existing.createdAt || now;
    if (need) existing.need = need;
    if (action) existing.action = action;
    if (emotion) existing.emotion = emotion;
    return existing;
  }
  const ttl = Math.max(1, Number(config.pendingTtlDays) || DEFAULT_PURPOSE_CONFIG.pendingTtlDays) * DAY;
  const entry = {
    id: `p-${hashId(clean)}`,
    text: clean,
    kind: kind || 'curiosity',
    need: PURPOSE_NEEDS.includes(need) ? need : '',
    action: String(action || '').slice(0, 20),
    emotion: String(emotion || '').slice(0, 20),
    source: 'memo',
    createdAt: now,
    expiresAt: now + ttl,
    hits: 0,
  };
  state.pending = [...(Array.isArray(state.pending) ? state.pending : []), entry].slice(-12);
  return entry;
}

/** 这件事推进过了：从待续账里摘掉最像的那条。 */
export function resolvePendingPurpose(state, text = '') {
  const clean = String(text ?? '').trim();
  if (!clean) return null;
  const list = Array.isArray(state.pending) ? state.pending : [];
  let best = null;
  let bestScore = 0;
  for (const p of list) {
    const score = textSimilarity(p.text, clean);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  if (best && bestScore >= 0.5) {
    state.pending = list.filter((p) => p !== best);
    return best;
  }
  return null;
}

/** 过期清理：待续条目按 TTL 淘汰，历史只留最近 N 条。 */
export function prunePurposeState(state, { now = Date.now(), config = DEFAULT_PURPOSE_CONFIG } = {}) {
  const ttlMs = Math.max(1, Number(config.pendingTtlDays) || DEFAULT_PURPOSE_CONFIG.pendingTtlDays) * DAY;
  state.pending = (Array.isArray(state.pending) ? state.pending : [])
    .filter((p) => p && p.text && (!p.expiresAt || Number(p.expiresAt) > now))
    .map((p) => ({ ...p, expiresAt: Number(p.expiresAt) || now + ttlMs }))
    .slice(-20);
  const limit = Math.max(10, Number(config.historyLimit) || DEFAULT_PURPOSE_CONFIG.historyLimit);
  state.history = (Array.isArray(state.history) ? state.history : []).slice(-limit);
  return state;
}

/**
 * 一轮结束后的状态迁移。
 * outcome: sent（真发出）/ silent（她选择不发）/ failed（投递或回合出错）/ delivery-failed
 */
export function applyPurposeOutcome(state, {
  now = Date.now(),
  config = DEFAULT_PURPOSE_CONFIG,
  outcome = 'sent',
  text = '',
  memo = null,
  planned = null,
  random = Math.random,
} = {}) {
  ensurePurposeDay(state, now);
  state.lastRunAt = now;
  state.lastOutcome = String(outcome ?? 'sent').slice(0, 24);
  state.lastPurpose = clip(memo?.purpose || planned?.text || state.lastPurpose || '', 120);
  state.lastText = clip(text || state.lastText || '', 200);
  const need = PURPOSE_NEEDS.includes(memo?.need) ? memo.need : (PURPOSE_NEEDS.includes(planned?.need) ? planned.need : '');
  const action = memo?.action || planned?.action || '';
  const emotion = memo?.emotionText ? '' : (planned?.emotion || '');
  state.lastEmotion = String(emotion || planned?.emotion || state.lastEmotion || '').slice(0, 24);
  state.lastEmotionText = clip(memo?.emotionText || state.lastEmotionText || '', 30);
  /**
   * 目标假设记账：这次主动说了/没说，都会影响下一次的置信度。
   * 心情向量不在这里结算（下沉到心情模块），与对方 2026-11-17 的口径一致。
   */
  const goalId = String(planned?.goalId || '').slice(0, 24);
  const goal = goalId ? (Array.isArray(state.goals) ? state.goals : []).find((g) => g?.id === goalId) : null;
  state.lastGoalId = goalId;
  if (goal && (state.lastOutcome === 'sent' || state.lastOutcome === 'silent')) {
    goal.attempts = Math.min(20, (Number(goal.attempts) || 0) + 1);
    goal.lastActionAt = now;
    if (state.lastOutcome === 'sent') {
      if (goal.status === 'hypothesis') goal.status = 'active';
      goal.confidence = Math.min(0.95, (Number(goal.confidence) || 0.3) + 0.03);
    } else {
      goal.confidence = Math.max(0.05, (Number(goal.confidence) || 0.3) - 0.03);
    }
  }
  state.drives = satisfyDrives(state.drives, { need, action, outcome: state.lastOutcome });
  state.drivesAt = now;
  if (memo?.feelings?.drives) {
    state.drives = applyFeelingDeltas(state.drives, memo.feelings.drives);
    state.drivesAt = now;
  }
  if (state.lastOutcome === 'sent') {
    state.lastSentAt = now;
    state.attempts = 0;
    /** 发出去了但备忘标记待续：记一条「心里还惦记着」，下次优先接着问。 */
    if (memo?.status === '待续') {
      addPendingPurpose(state, {
        text: memo.followUp && memo.followUp !== '无' ? memo.followUp : (memo.purpose || ''),
        kind: memo.kind || 'curiosity',
        need: need || planned?.need || '',
        action: action || planned?.action || '',
        emotion: emotion || planned?.emotion || '',
        now,
        config,
      });
    } else if (memo?.status === '完成') {
      resolvePendingPurpose(state, memo.purpose || '');
    } else if (planned?.fromPending && planned?.text) {
      /** 没写备忘，但这次本来就是接着「惦记的事」说的：默认这件事已经推进过一轮。 */
      resolvePendingPurpose(state, planned.text);
    }
  } else if (state.lastOutcome === 'silent') {
    state.attempts = 0;
    if (memo?.status === '待续') {
      addPendingPurpose(state, {
        text: memo.followUp && memo.followUp !== '无' ? memo.followUp : (memo.purpose || ''),
        kind: memo.kind || 'curiosity',
        need: need || planned?.need || '',
        action: action || planned?.action || '',
        emotion: emotion || planned?.emotion || '',
        now,
        config,
      });
    }
  }

  state.history.push({
    at: now,
    outcome: state.lastOutcome,
    kind: clip(memo?.kind || planned?.kind || '', 20),
    need,
    action,
    emotion: emotion || planned?.emotion || '',
    purpose: state.lastPurpose,
    text: state.lastText,
    planned: clip(planned?.text || '', 120),
    sourceId: clip(planned?.sourceId || '', 80),
    goalId,
    goalOwner: goal?.owner || planned?.goalOwner || '',
    confidence: goal?.confidence ?? planned?.confidence ?? null,
  });

  const retry = state.lastOutcome !== 'sent' && state.lastOutcome !== 'silent'
    && Number(state.attempts) < Number(config.maxAttempts);
  state.nextFireAt = retry
    ? now + Math.max(MINUTE, Number(config.retryMs) || DEFAULT_PURPOSE_CONFIG.retryMs)
    : planNextFire({ now, config, lastRunAt: now, countToday: state.countToday, replyHours: state.replyHours, replyWeekday: state.replyWeekday, random });
  prunePurposeState(state, { now, config });
  return state;
}

export { isPlainObject, hashId };
