/**
 * 目的引擎 · 选择层（P0 第四批）——移植自 aurabot-beta `src/purpose/engine.js:2149-2320`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 这一层回答：**这一轮到底说什么**。输入是候选（目标假设/种子/惦记的事），
 * 输出是选中的那一条 + 给模型看的候选清单。
 *
 * 排序不是纯随机，四层调权叠在一起：
 *   ① 目标假设：置信度/价值抬高，风险压低（高风险不会因为「想说」就排前面）
 *   ② 驱动：当前越缺哪个需要，对应候选越容易中
 *   ③ 情绪：寂寞/羡慕再推一把（权重可配）
 *   ④ 轮换：连续同需要/同类型降权，避免把人设聊成单曲循环
 * 最后按「同需要最多 2 个、同目标归属最多 2 个」去重，防止提示词被 6 条一样的占满。
 */
import {
  PURPOSE_NEEDS, DEFAULT_DRIVES, DEFAULT_PURPOSE_CONFIG, NEED_LABELS, ACTION_LABELS,
  DEFAULT_EMOTIONS, normalizeDrives, needAffinity, appraiseMaterial, emotionCues,
  emotionProfile, emotionLabelFor, resolveEmotion, topNeedOf, kindForAction, actionForNeed,
  clamp01, goalToCandidate,
} from './purpose-engine.js';
import { textSimilarity, isDuplicateText, hashId } from './purpose-settle.js';

const clip = (text, max = 120) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const HOUR = 3600_000;

/**
 * 选一个目的。
 * @returns {{purpose: object|null, candidates: object[], fromPending: boolean}}
 */
export function selectPurpose({
  seeds = [],
  goals = [],
  pending = [],
  history = [],
  config = DEFAULT_PURPOSE_CONFIG,
  drives = DEFAULT_DRIVES,
  now = Date.now(),
  lastMasterAt = 0,
  random = Math.random,
  emotions = DEFAULT_EMOTIONS,
} = {}) {
  const recent = (Array.isArray(history) ? history : []).slice(-10);
  const query = normalizeDrives(drives);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  const candidates = [];

  const add = (item, weight, fromPending) => {
    const text = clip(item?.text, 120);
    if (!text) return;
    const followUp = item?.kind === 'memory-follow-up';
    if (!followUp && isDuplicateText(text, recent)) return;
    /** 同一个目标已经主动说过：就算换了措辞也不重复。 */
    if (item?.goalId && recent.some((h) => h && h.goalId === item.goalId)) return;
    /** 同一件 B站视频 / 同一条记忆已经用过：换一个，别复读。 */
    if (!followUp && item?.sourceId && recent.some((h) => h && h.sourceId && h.sourceId === item.sourceId)) return;
    if (candidates.some((c) => textSimilarity(c.text, text) >= 0.8)) return;
    const needAff = item.needAffinity || needAffinity(text);
    const need = PURPOSE_NEEDS.includes(item.need) ? item.need : topNeedOf(needAff, query);
    const rawEmotion = item.emotion || appraiseMaterial({
      material: { text, title: '', selfRef: Boolean(item.selfRef), cues: emotionCues(text), needAffinity: needAff },
      need,
      now,
      lastMasterAt,
    });
    /** 写死的情绪键可能已被用户删掉：映射到最接近的一项，一项都没有才留空。 */
    const emotion = resolveEmotion(emotions, rawEmotion) || '';
    let action = item.action || actionForNeed(need, item.topic || '', { emotion, hoursSinceMaster });
    /** 高风险目标只能「问」或「说」，不能默认替她做（装/买/联系别人）。 */
    if ((Number(item.risk) || 0) >= 0.5 && !['ask', 'share'].includes(action)) action = 'ask';
    candidates.push({
      id: item.id || `candidate-${hashId(text)}`,
      kind: String(item.kind || kindForAction(action, need)).slice(0, 20),
      need,
      needLabel: NEED_LABELS[need] || need,
      action: ACTION_LABELS[action] ? action : 'share',
      actionLabel: ACTION_LABELS[action] || ACTION_LABELS.share,
      emotion,
      emotionLabel: emotionLabelFor(emotions, emotion),
      emotionProfile: emotionProfile(emotion, emotions),
      topic: String(item.topic || '').slice(0, 40),
      text,
      source: String(item.source || '').slice(0, 20),
      sourceId: String(item.sourceId || '').slice(0, 80),
      at: Number(item.at) || 0,
      weight: Math.max(0.1, Number(weight) || 1),
      evidence: clip(item.evidence || '', 120),
      fromPending: Boolean(fromPending),
      goalId: item.goalId || '',
      goalOwner: item.goalOwner || '',
      goalOwnerLabel: item.goalOwnerLabel || '',
      confidence: Number.isFinite(Number(item.confidence)) ? clamp01(item.confidence, 0) : null,
      risk: Number.isFinite(Number(item.risk)) ? clamp01(item.risk, 0) : null,
      value: Number.isFinite(Number(item.value)) ? clamp01(item.value, 0) : null,
      nextStep: String(item.nextStep || '').slice(0, 80),
    });
  };

  for (const goal of Array.isArray(goals) ? goals : []) {
    /** 被拒绝/已完成/过期的目标不再主动提；新证据会把 rejected 重新变回 hypothesis。 */
    if (!goal || ['rejected', 'done', 'expired'].includes(goal.status)) continue;
    const candidate = goalToCandidate(goal);
    if (candidate) add(candidate, 1, false);
  }
  for (const seed of Array.isArray(seeds) ? seeds : []) add(seed, seed?.weight ?? 1, false);
  for (const p of Array.isArray(pending) ? pending : []) add(p, (Number(p?.weight) || 1) + 0.35, true);

  /** 驱动越高的需要越容易中；寂寞/羡慕再推一把。 */
  for (const c of candidates) {
    if (c.goalId) {
      c.weight *= 0.55 + (c.confidence ?? 0.3) * 0.7 + (c.value ?? 0.4) * 0.35 - (c.risk ?? 0.1) * 0.25;
    }
    c.weight *= 0.65 + 0.55 * (query[c.need] ?? 0);
    if (c.emotion === 'lonely') c.weight *= config.lonelyEmotionWeight;
    if (c.emotion === 'envious') c.weight *= config.enviousEmotionWeight;
  }

  /** 需要轮换：连续两次都在「陪」/「玩」，第三次先换一个维度。 */
  const lastNeeds = recent.map((h) => h?.need).filter(Boolean);
  for (const c of candidates) {
    if (lastNeeds.slice(-3).includes(c.need)) c.weight *= config.needRepeatPenalty;
    if (lastNeeds.slice(-2).length === 2 && lastNeeds.slice(-2).every((n) => n === c.need)) c.weight *= config.needRepeatPenalty2;
  }

  /** 连续分享/连续索取都容易腻：按最近 3 次的类型轻轻调权。 */
  const lastKinds = recent.slice(-3).map((h) => String(h?.kind || ''));
  const shares = lastKinds.filter((k) => k === 'share').length;
  const asks = lastKinds.filter((k) => k === 'ask' || k === 'curiosity').length;
  for (const c of candidates) {
    if (shares >= 2 && c.kind !== 'share') c.weight *= 1.35;
    if (asks >= 2 && ['share', 'care', 'follow-up'].includes(c.kind)) c.weight *= 1.2;
  }

  candidates.sort((a, b) => b.weight - a.weight);
  /** 候选去重：同需要最多 2 个、同目标归属最多 2 个。 */
  const maxCandidates = Math.max(3, Number(config.maxCandidates) || 6);
  const diverse = [];
  const byNeed = new Map();
  const byOwner = new Map();
  for (const c of candidates) {
    const needCount = byNeed.get(c.need) || 0;
    const ownerCount = c.goalOwner ? (byOwner.get(c.goalOwner) || 0) : 0;
    if (needCount >= 2) continue;
    if (c.goalOwner && ownerCount >= 2) continue;
    diverse.push(c);
    byNeed.set(c.need, needCount + 1);
    if (c.goalOwner) byOwner.set(c.goalOwner, ownerCount + 1);
    if (diverse.length >= maxCandidates) break;
  }
  if (diverse.length < 3) {
    for (const c of candidates) {
      if (diverse.includes(c)) continue;
      diverse.push(c);
      if (diverse.length >= 3) break;
    }
  }
  const top = diverse;
  if (!top.length) return { purpose: null, candidates: [], fromPending: false };

  /** 惦记的事优先：跟进类候选直接胜出。 */
  const followUp = top.find((c) => c.kind === 'memory-follow-up');
  if (followUp) return { purpose: followUp, candidates: top, fromPending: false };

  /** 有一半概率先处理「心里惦记着的事」（人也会先把没说完的话说完）。 */
  const pendingTop = top.filter((c) => c.fromPending);
  if (pendingTop.length && random() < config.pendingShareProbability) {
    return { purpose: pendingTop[0], candidates: top, fromPending: true };
  }
  const total = top.reduce((sum, c) => sum + c.weight, 0);
  let roll = random() * total;
  for (const c of top) {
    roll -= c.weight;
    if (roll <= 0) return { purpose: c, candidates: top, fromPending: Boolean(c.fromPending) };
  }
  return { purpose: top[0], candidates: top, fromPending: Boolean(top[0].fromPending) };
}
