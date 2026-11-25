/**
 * 目的机制 · 目标假设生成（纯逻辑层）。
 *
 * 移植来源：aurabot-beta `src/purpose/engine.js` 的目标假设闭包（MIT License，
 * Copyright (c) 2026 Aurabot contributors）；上游为 Mieksido/surfcore 的
 * purpose-engine（MIT），署名与许可原文见对方 THIRD-PARTY-NOTICES.md。
 * 本文件按 dsh-roost（AGPL-3.0）语境改写，只保留纯计算：零 I/O、零宿主依赖。
 *
 * MIT 许可原文（aurabot contributors）：Permission is hereby granted, free of charge,
 * to any person obtaining a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, subject to the following conditions: the above
 * copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT
 * WARRANTY OF ANY KIND.
 *
 * 只做「从素材形成目标假设」：归属判定 / 置信度 / 证据去重 / 主人反馈结算。
 * 排程、投递、素材采集在接线层（host.js / purpose-state.js），这里不碰。
 * 函数体按生产版本原样抽取（脚本按顶层声明边界），避免手抄走样。
 */

export const PURPOSE_STATE_VERSION = 1;
// 到期事实优先关心；只由记忆库提供到期的一件，不在目的状态里复制排程。

export const FOLLOW_UP_WEIGHT = 4;

/** 默认值刻意保守：白天每 2.5~5 小时最多一次，一天最多 4 次，23:30~08:30 不打扰。 */

export const DEFAULT_PURPOSE_CONFIG = Object.freeze({
  enabled: true,
  // 空 = 用 config.json 的 ownerQQ；一般不需要改。
  ownerUin: '',
  gapMinMs: 150 * 60 * 1000,
  gapMaxMs: 300 * 60 * 1000,
  initialDelayMinMs: 30 * 60 * 1000,
  dailyMax: 4,
  quietStart: '23:30',
  quietEnd: '08:30',
  // 主人最近说过话 / 她最近发过言时先不打扰，避免在正在进行的聊天里硬插一句。
  idleThresholdMs: 30 * 60 * 1000,
  materialWindowHours: 72,
  biliWindowDays: 7,
  maxMaterials: 36,
  // 素材太少就别硬找话；有「心里惦记的事」时例外。
  minMaterials: 2,
  retryMs: 15 * 60 * 1000,
  maxAttempts: 3,
  historyLimit: 60,
  pendingTtlDays: 14,
  maxCandidates: 6,
  promptMaxChars: 16000,
  // ── 选择层与驱动调参（面板可调；0~1 / 权重见 normalizePurposeConfig 的钳制）──
  // 有一半概率优先处理「心里惦记的事」；寂寞/羡慕情绪的排序加成；连续同需要的降权。
  pendingShareProbability: 0.5,
  lonelyEmotionWeight: 1.2,
  enviousEmotionWeight: 1.1,
  needRepeatPenalty: 0.72,
  needRepeatPenalty2: 0.65,
  // 驱动向默认值衰减的半衰期（小时）。
  driveHalfLifeHours: 8,
  // 人格「胆量」：风险全表乘数（1 = 原表；人格卡可覆写）。
  riskScale: 1,
});

const MINUTE = 60 * 1000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

export const PURPOSE_NEEDS = Object.freeze([
  'play', 'learn', 'install', 'connect', 'care', 'share', 'identity', 'create', 'consume',
]);

export const NEED_LABELS = Object.freeze({
  play: '玩', learn: '学', install: '装', connect: '陪', care: '关心',
  share: '分享', identity: '自我', create: '创作', consume: '体验',
});

export const DEFAULT_DRIVES = Object.freeze({
  play: 0.20, learn: 0.12, install: 0.10, connect: 0.28, care: 0.22,
  share: 0.20, identity: 0.14, create: 0.05, consume: 0.05,
});

const NEED_WORDS = Object.freeze({
  play: ['游戏', '玩', '联机', '开黑', '副本', '抽卡', '主机', 'steam', 'switch', '手游', '桌游', '比赛', '攻略', '怎么玩', 'mod', '皮肤'],
  learn: ['教程', '原理', '解析', '知识', '课程', '论文', '科普', '技巧', '拆解', '学会', '怎么做到', '为什么'],
  install: ['插件', '安装', '配置', '部署', '工具', '软件', '更新', '扩展', '源码', 'harness', 'dsh', '装好', '装上', '装个', '想装'],
  connect: ['主人', '陪', '寂寞', '孤独', '抱', '亲', '喜欢', '爱', '关系', '一起', '聊天', '晚安', '早安', '想你'],
  care: ['面试', '考试', '加班', '累', '生病', '医院', '压力', '难过', '开心', '吃饭', '睡觉', '工作', '休息'],
  share: ['好笑', '离谱', '可爱', '好看', '梗', '笑死', '分享', '给你看', '有趣', '震撼', '绝了'],
  identity: ['ai', '机器人', '人机', '意识', '记忆', '自我', '是谁', '模型', '人格', '灵魂'],
  create: ['写文', '画画', '二创', '剪辑', '编曲', '做视频', '手工', '创作', '拍'],
  consume: ['想吃', '想喝', '想买', '想去', '展览', '店', '旅行', '门票', '礼物', '好吃', '好喝'],
});

// 人格卡里的「我是一个什么样的人」→ 动机先验。不是给模型看的标签，
// 而是让同一套机制在载入不同人格卡时，天然偏向不同的需要（爱玩的人更容易想玩，
// 黏人的人更容易想陪，技术宅更容易想装/学）。

const POSITIVE_RE = /开心|喜欢|爱|可爱|好笑|笑死|厉害|治愈|温暖|惊喜|幸福|好玩|想玩|想吃|绝了|赞/;

const NEGATIVE_RE = /难过|累|焦虑|害怕|孤独|寂寞|羡慕|嫉妒|生气|烦|压力|遗憾|哭|担心|崩溃/;

const AROUSAL_RE = /笑死|炸|疯|激动|震撼|刺激|太|超|绝了|!!!|！！/;

const RELATION_RE = /爱|关系|人机|机器人|ai|寂寞|孤独|陪|想你|主人/;

const NEG_PREFIX_RE = /(?:不想|不要|不用|没有|没什么|别|不爱|懒得|不打算|无意|拒绝|取消|放弃)/;

/** 命中位置是否被否定前缀覆盖。 */

const PLAN_RE = /明天|后天|周末|下周|考试|面试|加班|出差|回家|生日|旅行|医院|搬家|开会|比赛|约会|放假|开学/;

const QUESTION_RE = /[?？]|吗|呢|怎么|为什么|有没有|要不要|能不能|是不是|咋/;

const PROMISE_RE = /回头|下次|改天|待会|晚点|明天|之后|再聊|再告诉|再说/;

// ── 需求维度：把「看到的东西」抽象成「我想要什么」────────────────────────────
// 这不是心理学定论，而是一套可解释、可单测的近似：
//   注意力（哪条记忆值得看）→ 抽象（它指向哪种需要）→ 情绪（它让我什么感觉）
//   → 意图（我想做什么）→ 行动（分享 / 索取 / 邀请 / 倾诉）。
// 目的不是关键词映射，而是这五步的合流。

export const GOAL_OWNERS = Object.freeze(['self', 'owner', 'member', 'media']);

export const GOAL_OWNER_LABELS = Object.freeze({ self: '我', owner: '主人', member: '群友', media: '视频里' });

export const GOAL_STATUSES = Object.freeze(['hypothesis', 'active', 'confirmed', 'rejected', 'done', 'expired']);

const DEFAULT_RISK_TABLE = Object.freeze({
  install: { ask: 0.55, other: 0.82 },
  consume: { ask: 0.6, other: 0.85 },
  identity: 0.05,
  care: 0.05,
  connect: 0.05,
  play: 0.1,
  learn: 0.15,
  create: 0.1,
  share: 0.1,
  default: 0.2,
});

const NEGATIVE_REPLY_RE = /不要|不想|不用|没空|没兴趣|算了|下次吧|别|忙/;
// 正面词的清单版：逐词做否定守卫，「不喜欢」不能因为命中「喜欢」算正反馈。

const POSITIVE_REPLY_WORDS = ['好', '可以', '一起', '哈哈', '笑死', '行', '来', '试试', '喜欢', '想', '当然', '没问题', '可爱', '不错'];

const UNRESOLVED_RE = /[?？]|吗|呢|回头|下次|改天|答应|说好|等你|要不要|能不能|想不想/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clip(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 群聊素材里常带 QQ 号；给主人看的摘要不带号，只留事。 */

function hashId(text) {
  let h = 2166136261;
  for (const ch of String(text ?? '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function clamp01(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function isNegated(text, index) {
  if (index < 0) return false;
  return NEG_PREFIX_RE.test(String(text ?? '').slice(Math.max(0, index - 4), index));
}

/** 文本里是否存在一次「未被否定」的词命中。 */

export function findAffirmative(text, word) {
  const t = String(text ?? '').toLowerCase();
  const w = String(word ?? '').toLowerCase();
  if (!w) return false;
  let idx = t.indexOf(w);
  while (idx >= 0) {
    if (!isNegated(t, idx)) return true;
    idx = t.indexOf(w, idx + w.length);
  }
  return false;
}

/** 0~1 的驱动向量；坏值回默认，不抛。 */

export function needAffinity(text, roleName = '', roleAliases = []) {
  const t = String(text ?? '').toLowerCase();
  const out = {};
  let any = 0;
  for (const need of PURPOSE_NEEDS) {
    let hits = 0;
    for (const word of NEED_WORDS[need]) if (findAffirmative(t, word)) hits += 1;
    if (need === 'identity' && [roleName, ...roleAliases].some((name) => name && t.includes(String(name).toLowerCase()))) hits += 1;
    const value = Math.min(1, hits / 2.5);
    out[need] = value;
    if (value > 0) any += 1;
  }
  if (!any) out.share = 0.3;
  // 交叉增强：提到「插件/AI/自己」时，既可能是「装」也可能是「自我」；
  // 游戏 + 一起/主人 时，既可能是「玩」也可能是「陪」。
  if (out.install > 0 && out.identity > 0) out.identity = Math.min(1, out.identity + 0.2);
  if (out.play > 0 && out.connect > 0) out.play = Math.min(1, out.play + 0.15);
  return out;
}

// 人格卡里的「性格倾向」→ 引擎参数覆写。只认显式写的词，第一个命中的词生效。

export function topNeedOf(affinity, drives = DEFAULT_DRIVES) {
  let best = 'share';
  let bestScore = -1;
  for (const need of PURPOSE_NEEDS) {
    const score = (Number(affinity?.[need]) || 0) * (0.35 + (Number(drives?.[need]) || 0));
    if (score > bestScore) { best = need; bestScore = score; }
  }
  return best;
}

/** 轻量 appraisal：不是「识别情绪词」，而是「这件事对我意味着什么」。 */

function cleanTopic(text, max = 24) {
  const s = String(text ?? '')
    .replace(/^[《「【\[\s]+|[》」】\]\s]+$/g, '')
    .replace(/[，。！？；、,.!?;:~～]+$/g, '')
    .replace(/[吗呢啊吧呀哦嘛啦]+$/g, '')
    .replace(/(怎么玩|怎么样|是什么|好不好|在哪|多少钱|干什么|是什么样)$/g, '')
    .replace(/[，。！？；、,.!?;:~～]+$/g, '')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 从一句话/标题里抽一个可复述的「那件事」——模板里要用它，不能只写「那个东西」。 */

export function extractTopic(text, title = '') {
  if (title) return cleanTopic(title);
  const raw = String(text ?? '');
  const quoted = /《([^》]{2,30})》|「([^」]{2,30})」|【([^】]{2,30})】/.exec(raw);
  if (quoted) return cleanTopic(quoted[1] || quoted[2] || quoted[3]);
  const afterDemonstrative = /(?:那个|这个|一个|这款|那款|一部|一款)([^\s，。！？；、,.!?;]{2,18})/.exec(raw);
  if (afterDemonstrative) return cleanTopic(afterDemonstrative[1]);
  const plugin = /([\u4e00-\u9fffA-Za-z0-9_-]{2,16}插件)/.exec(raw);
  if (plugin) return cleanTopic(plugin[1]);
  return cleanTopic(clip(raw, 18));
}

export function emotionCues(text) {
  const raw = String(text ?? '');
  return {
    positive: POSITIVE_RE.test(raw),
    negative: NEGATIVE_RE.test(raw),
    arousal: AROUSAL_RE.test(raw) ? 0.85 : 0.4,
  };
}

/** 把素材压成注意力需要的样子：自我相关 / 需求向量 / 主题 / 情绪线索。 */

export function appraiseMaterial({ material, need, now = Date.now(), lastMasterAt = 0 } = {}) {
  const text = `${material?.title ?? ''} ${material?.text ?? ''}`;
  const cues = material?.cues ?? emotionCues(text);
  const self = Boolean(material?.selfRef);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  if (self && RELATION_RE.test(text) && hoursSinceMaster >= 6) return 'lonely';
  if (/羡慕|嫉妒|别人|他们|都在/.test(text) && !self) return 'envious';
  if (need === 'care' && cues.negative) return 'worried';
  if (need === 'identity' && self && cues.positive) return 'proud';
  if (need === 'learn' || need === 'install' || need === 'identity') return 'curious';
  if ((need === 'play' || need === 'consume') && (cues.positive || cues.arousal > 0.6)) return 'excited';
  if (need === 'connect' && cues.positive) return 'affectionate';
  if (need === 'share' && (cues.positive || cues.arousal > 0.6)) return 'amused';
  if (!cues.positive && !cues.negative && hoursSinceMaster >= 8) return 'bored';
  return 'content';
}

/** 一轮结束后满足/消耗驱动：真正说出去了才降，没说出去只轻微回落。 */

function detectStance(text) {
  const raw = String(text ?? '');
  const wantMatch = /想玩|想吃|想买|想去|想要|好想|想试试|想学|求推荐|求带|打算|准备/.exec(raw);
  if (wantMatch && !isNegated(raw, wantMatch.index)) return 'want';
  if (/好用|推荐|神器|厉害|不错|值得|真香/.test(raw)) return 'praise';
  if (QUESTION_RE.test(raw)) return 'question';
  if (/看到|听说|刷到|发现|有人/.test(raw)) return 'report';
  if (POSITIVE_RE.test(raw)) return 'positive';
  if (NEGATIVE_RE.test(raw)) return 'negative';
  return 'mention';
}

function subjectOf(material) {
  if (material?.kind === 'owner') return 'owner';
  if (material?.kind === 'self' || material?.kind === 'thought' || material?.kind === 'memory') return 'self';
  if (material?.kind === 'member') return 'member';
  if (material?.kind === 'video' || material?.kind === 'dynamic') return 'media';
  return 'media';
}

function analyzeEvent(material, { drives = DEFAULT_DRIVES, persistence = 1, roleName = '' } = {}) {
  const text = `${material?.title ?? ''} ${material?.text ?? ''} ${material?.quote ?? ''}`;
  const affinity = material?.needAffinity ?? needAffinity(text, roleName);
  const domain = topNeedOf(affinity, drives);
  const subject = subjectOf(material);
  const addressed = Boolean(roleName && String(material?.text ?? '').includes(roleName));
  const selfRelevance = subject === 'self'
    ? 1
    : material?.selfRef
      ? 0.8
      : addressed
        ? 0.6
        : subject === 'owner' ? 0.35 : 0.2;
  const stance = detectStance(text);
  const credibility = subject === 'owner' ? 0.9 : subject === 'self' ? 0.8 : material?.source === 'bili' ? 0.55 : 0.45;
  const objectName = cleanTopic(material?.topic || extractTopic(text), 32);
  const objectType = domain === 'play' ? 'game'
    : domain === 'install' ? 'plugin'
      : domain === 'identity' ? 'relationship'
        : domain === 'care' ? 'plan'
          : 'topic';
  return {
    material, text, affinity, domain, subject, addressed, selfRelevance, stance, credibility,
    persistence: Math.max(1, Number(persistence) || 1),
    object: { type: objectType, name: objectName },
  };
}

function observationKey(event) {
  return `${event.domain}|${event.object.name.toLowerCase()}`;
}

/** 观察账本：同一件事出现过几次、谁提的、是正评还是负评。跨轮保留，用来压「一次视频=永久欲望」。 */

export function updateObservations(observations, materials, now = Date.now(), drives = DEFAULT_DRIVES) {
  const map = new Map();
  for (const raw of Array.isArray(observations) ? observations : []) {
    if (!isPlainObject(raw) || !raw.key) continue;
    map.set(String(raw.key), {
      key: String(raw.key),
      domain: PURPOSE_NEEDS.includes(raw.domain) ? raw.domain : 'share',
      object: clip(raw.object ?? '', 32),
      count: clampInt(raw.count, 0, 0, 99),
      firstAt: Number(raw.firstAt) || now,
      lastAt: Number(raw.lastAt) || 0,
      subjects: (Array.isArray(raw.subjects) ? raw.subjects : []).filter((s) => GOAL_OWNERS.includes(s)).slice(0, 8),
      positive: clampInt(raw.positive, 0, 0, 99),
      negative: clampInt(raw.negative, 0, 0, 99),
      seenIds: (Array.isArray(raw.seenIds) ? raw.seenIds : []).map(String).slice(-40),
    });
  }
  for (const material of Array.isArray(materials) ? materials : []) {
    const event = analyzeEvent(material, { drives });
    const key = observationKey(event);
    const entry = map.get(key) ?? {
      key, domain: event.domain, object: event.object.name,
      count: 0, firstAt: now, lastAt: 0, subjects: [], positive: 0, negative: 0, seenIds: [],
    };
    const id = String(material?.id ?? '').slice(0, 80);
    if (id && entry.seenIds.includes(id)) {
      entry.lastAt = Math.max(entry.lastAt, Number(material?.at) || now);
      map.set(key, entry);
      continue;
    }
    entry.count = Math.min(99, (Number(entry.count) || 0) + 1);
    entry.lastAt = Math.max(entry.lastAt, Number(material?.at) || now);
    if (!entry.subjects.includes(event.subject)) entry.subjects.push(event.subject);
    if (event.stance === 'praise' || event.stance === 'positive') entry.positive += 1;
    if (event.stance === 'negative') entry.negative += 1;
    if (id) entry.seenIds = [...entry.seenIds, id].slice(-40);
    map.set(key, entry);
  }
  const cutoff = now - 30 * DAY;
  return [...map.values()]
    .filter((o) => o.lastAt >= cutoff)
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 80);
}

export function normalizeDrives(input) {
  const out = { ...DEFAULT_DRIVES };
  if (!input || typeof input !== 'object') return out;
  for (const need of PURPOSE_NEEDS) {
    const n = Number(input[need]);
    if (Number.isFinite(n)) out[need] = Math.min(1, Math.max(0, n));
  }
  return out;
}

/** 一段文本指向哪些需要（0~1/维）；没有任何命中时至少给 share 一点底。 */

function normalizeGoal(raw, now = Date.now()) {
  if (!isPlainObject(raw)) return null;
  const domain = PURPOSE_NEEDS.includes(raw.domain) ? raw.domain : '';
  const intent = clip(raw.intent, 120);
  if (!domain || !intent) return null;
  const owner = GOAL_OWNERS.includes(raw.owner) ? raw.owner : 'self';
  const object = isPlainObject(raw.object) ? raw.object : { type: 'topic', name: clip(raw.object ?? '', 32) };
  return {
    id: String(raw.id ?? '').slice(0, 24) || `g-${hashId(`${owner}|${domain}|${object.name}|${intent}`)}`,
    owner,
    domain,
    object: { type: String(object.type ?? 'topic').slice(0, 12), name: clip(object.name ?? '', 32) },
    intent,
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).slice(-4).map((e) => ({
      id: String(e?.id ?? '').slice(0, 80),
      text: clip(e?.text ?? '', 120),
      source: String(e?.source ?? '').slice(0, 12),
      at: Number(e?.at) || 0,
    })),
    confidence: clamp01(raw.confidence, 0.3),
    value: clamp01(raw.value, 0.4),
    urgency: clamp01(raw.urgency, 0.2),
    risk: clamp01(raw.risk, 0.1),
    action: String(raw.action ?? 'share').slice(0, 16),
    nextStep: clip(raw.nextStep, 80),
    status: GOAL_STATUSES.includes(raw.status) ? raw.status : 'hypothesis',
    emotion: String(raw.emotion ?? '').slice(0, 20),
    createdAt: Number(raw.createdAt) || now,
    lastSeenAt: Number(raw.lastSeenAt) || now,
    expiresAt: Number(raw.expiresAt) || 0,
    attempts: clampInt(raw.attempts, 0, 0, 20),
    lastActionAt: Number(raw.lastActionAt) || 0,
    lastFeedbackAt: Number(raw.lastFeedbackAt) || 0,
    sightings: clampInt(raw.sightings, 1, 1, 99),
    source: String(raw.source ?? 'event').slice(0, 12),
  };
}

export function normalizeGoals(goals, now = Date.now()) {
  return (Array.isArray(goals) ? goals : []).map((g) => normalizeGoal(g, now)).filter(Boolean).slice(-40);
}

// 风险表：什么需要、什么行动算「大胆」。纯数据，想调性格就覆写它或乘 riskScale。

function riskFor(domain, action) {
  const entry = DEFAULT_RISK_TABLE[domain];
  if (typeof entry === 'number') return entry;
  if (entry && typeof entry === 'object') return action === 'ask' ? entry.ask : entry.other;
  return DEFAULT_RISK_TABLE.default;
}

/** 人格卡「胆量」：全表乘 riskScale（0.3~2，1 = 原表）。 */

function scaledRisk(rawRisk, riskScale = 1) {
  const scale = Math.min(2, Math.max(0.3, Number(riskScale) || 1));
  return clamp01(rawRisk * scale, 0.1);
}

function nextStepFor(action) {
  return ({
    share: '跟主人说说这件事',
    ask: '问问主人',
    invite: '问主人要不要一起',
    confide: '跟主人说说心里话',
    curiosity: '问主人 / 查一查',
    follow: '跟主人补一句',
  }[action] ?? '跟主人说说');
}

function makeGoal({
  owner, domain, object, intent, action, evidence = [], confidence = 0.3,
  value = 0.4, urgency = 0.2, risk = 0.1, emotion = '', now = Date.now(),
  ttlDays = 7, source = 'event', status = 'hypothesis',
} = {}) {
  const cleanAction = String(action || 'share').slice(0, 16);
  return {
    id: `g-${hashId(`${owner}|${domain}|${object?.name ?? ''}|${intent}`)}`,
    owner, domain,
    object: { type: String(object?.type ?? 'topic').slice(0, 12), name: clip(object?.name ?? '', 32) },
    intent: clip(intent, 120),
    evidence: (Array.isArray(evidence) ? evidence : []).slice(-4),
    confidence: clamp01(confidence, 0.3),
    value: clamp01(value, 0.4),
    urgency: clamp01(urgency, 0.2),
    risk: clamp01(risk, 0.1),
    action: cleanAction,
    nextStep: nextStepFor(cleanAction),
    status,
    emotion: String(emotion || '').slice(0, 20),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + Math.max(1, Number(ttlDays) || 7) * DAY,
    attempts: 0,
    lastActionAt: 0,
    lastFeedbackAt: 0,
    sightings: 1,
    source,
  };
}

/** 一个事件 → 1~3 个候选目标。归属不同，置信度/风险/行动都不同。riskScale 统一乘在全表上。 */

function hypothesesForEvent(event, { drives, now, lastMasterAt, hoursSinceMaster, riskScale = 1 } = {}) {
  const out = [];
  const objectName = event.object.name || '那件事';
  const drive = Number(drives?.[event.domain]) || 0;
  const persistenceScore = Math.min(1, Math.max(0, (event.persistence - 1) / 3));
  const stanceBonus = event.stance === 'want' ? 0.1 : event.stance === 'praise' ? 0.08 : event.stance === 'question' ? 0.03 : 0;
  const baseConfidence = clamp01(
    0.15 + 0.22 * event.selfRelevance + 0.2 * persistenceScore + stanceBonus + 0.1 * event.credibility + 0.08 * drive,
    0.15,
  );
  const value = clamp01(0.3 + 0.35 * drive + 0.2 * event.selfRelevance + 0.15 * persistenceScore, 0.4);
  const urgency = clamp01(
    0.15 + (event.subject === 'owner' ? 0.35 : 0) + (UNRESOLVED_RE.test(event.text) ? 0.2 : 0) + (event.stance === 'want' ? 0.1 : 0),
    0.2,
  );
  const emotion = appraiseMaterial({ material: event.material, need: event.domain, now, lastMasterAt });
  const evidence = [{
    id: String(event.material?.id ?? '').slice(0, 80),
    text: clip(event.material?.text || event.material?.title || '', 120),
    source: String(event.material?.source ?? '').slice(0, 12),
    at: Number(event.material?.at) || now,
  }];
  const relation = RELATION_RE.test(event.text) && /人机|机器人|ai|爱情|关系|陪伴/.test(event.text.toLowerCase());

  if (event.subject === 'owner') {
    // 「早早」「晚安」这种招呼不构成一个持续目标；只有当主人说了具体的事/计划/问题时才算。
    const ownerText = String(event.material?.text ?? '').trim();
    const convKey = String(event.material?.meta?.key ?? '');
    const isPrivate = convKey.startsWith('private:');
    const looksPlan = PLAN_RE.test(ownerText) || QUESTION_RE.test(ownerText);
    const isLife = event.domain === 'care' || event.domain === 'connect'
      || PLAN_RE.test(ownerText) || NEGATIVE_RE.test(ownerText) || POSITIVE_RE.test(ownerText);
    const meaningful = (ownerText.length >= 6 || looksPlan)
      && !/^(早|早安|晚安|在吗|在嘛|嗨|哈喽|你好|好|嗯|哦|哈哈)[~～!！。. ]*$/.test(ownerText);
    // 群聊里主人说的话不是「主动私聊找主人」的素材：那是群聊回合该处理的事。
    if (!isPrivate) return out;
    if (!meaningful) return out;
    if (!isLife) {
      // 私聊里主人在聊技术/作品/见闻：不要写成高置信度的「关心」，只记成「想接着聊」。
      out.push(makeGoal({
        owner: 'owner', domain: event.domain, object: event.object,
        intent: `主人刚提到「${clip(objectName, 24)}」，想接着聊聊`,
        action: 'share', evidence, confidence: 0.5,
        value: Math.max(0.45, value * 0.8), urgency: 0.3, risk: 0.05, emotion,
        now, ttlDays: 7, source: 'owner-topic',
      }));
      return out;
    }
    const care = event.domain === 'care' || PLAN_RE.test(event.text);
    const domain = care ? 'care' : 'connect';
    const action = 'ask';
    out.push(makeGoal({
      owner: 'owner', domain, object: event.object,
      intent: care ? `想知道主人「${clip(objectName, 24)}」后来怎么样` : `想接上主人说的「${clip(objectName, 24)}」`,
      action, evidence, confidence: 0.78, value: Math.max(0.55, value),
      urgency: Math.max(0.5, urgency), risk: 0.05, emotion,
      now, ttlDays: 10, source: 'owner',
    }));
    // 主人自己说想玩/想吃，不等于「我想玩」；但可以形成「想和主人一起」的低置信度目标。
    if (['play', 'consume', 'learn'].includes(event.domain) && /一起|想玩|想吃|想去|想试/.test(event.text)) {
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: `主人说想${event.domain === 'play' ? '玩' : event.domain === 'consume' ? '去/吃' : '学'}「${clip(objectName, 24)}」，想问问能不能一起`,
        action: event.domain === 'play' ? 'invite' : 'ask',
        evidence, confidence: Math.min(0.62, 0.35 + persistenceScore * 0.2),
        value, urgency, risk: riskFor(event.domain, event.domain === 'play' ? 'invite' : 'ask'),
        emotion, now, ttlDays: 7, source: 'owner-shared',
      }));
    }
  } else if (event.subject === 'self') {
    // 她自己过去发的普通聊天，不等于「现在想要什么」；只有明确答应过的事才形成目标。
    // （记忆 / 心里惦记的事 / B站想法是内部状态，下面照常处理。）
    if (event.material?.kind === 'self') {
      if (!PROMISE_RE.test(event.text)) return out;
      out.push(makeGoal({
        owner: 'self', domain: 'care', object: event.object,
        intent: `你之前说过「${clip(objectName, 24)}」，想跟主人补一句`,
        action: 'follow', evidence, confidence: 0.62, value: 0.55,
        urgency: 0.4, risk: 0.05, emotion, now, ttlDays: 10, source: 'self-promise',
      }));
      return out;
    }
    if (event.material?.kind === 'memory') {
      // 记忆是「想起一件事」，不是每条都汇总成「想找主人说话」；
      // 否则 8 条记忆会生成 8 个几乎一样的 connect 目标。
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: `突然想起「${clip(objectName, 24)}」，想跟主人说说`,
        action: 'share', evidence, confidence: 0.5, value: Math.max(0.5, value),
        urgency: 0.25, risk: 0.05, emotion, now, ttlDays: 14, source: 'memory',
      }));
      return out;
    }
    const action = actionForNeed(event.domain, objectName, { emotion, hoursSinceMaster });
    out.push(makeGoal({
      owner: 'self', domain: event.domain, object: event.object,
      intent: intentForNeed(event.domain, objectName, { emotion, hoursSinceMaster, relation }),
      action, evidence, confidence: Math.max(0.55, baseConfidence), value,
      urgency, risk: riskFor(event.domain, action), emotion, now, ttlDays: 10, source: 'self',
    }));
  } else if (event.subject === 'member') {
    // 群聊里大部分话和「她的目标」无关：只有点名她、自我相关、或落在玩/学/装/自我
    // 这些她能参与的领域时，才形成「群里在聊…想跟主人说说」。
    const relevant = event.addressed || event.selfRelevance >= 0.6
      || ['play', 'learn', 'install', 'identity'].includes(event.domain);
    if (!relevant) return out;
    // 群友的目标先记成「群友的」：她可以跟主人聊，但不能直接说成自己想玩。
    out.push(makeGoal({
      owner: 'member', domain: event.domain, object: event.object,
      intent: `群里在聊「${clip(objectName, 24)}」，想跟主人说说`,
      action: 'share', evidence,
      confidence: clamp01(0.35 + 0.1 * event.persistence + 0.1 * event.credibility, 0.4),
      value: Math.max(0.35, value * 0.8), urgency, risk: 0.05, emotion,
      now, ttlDays: 5, source: 'member',
    }));
    // 只有「反复出现 / 直接点她 / 过去有同类兴趣」才升级成她自己的目标。
    if (event.persistence >= 3 && (event.selfRelevance >= 0.5 || ['play', 'learn'].includes(event.domain))) {
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: `看到大家一直在聊「${clip(objectName, 24)}」，也有点想试试`,
        action: event.domain === 'play' ? 'invite' : 'ask',
        evidence, confidence: Math.min(0.7, baseConfidence * 0.85),
        value, urgency, risk: riskFor(event.domain, event.domain === 'play' ? 'invite' : 'ask'),
        emotion, now, ttlDays: 7, source: 'member-repeat',
      }));
    }
  } else {
    // 视频/动态：先当作「媒体主张」，只有重复出现/自我相关/直接夸好用才升级成自己的目标。
    if (event.domain === 'install') {
      const stronger = event.persistence >= 2 || event.stance === 'praise';
      out.push(makeGoal({
        owner: stronger ? 'self' : 'media', domain: 'install', object: event.object,
        intent: stronger
          ? `看到一个说「${clip(objectName, 24)}」好用的视频，有点想装，想问问主人`
          : `看到一个说「${clip(objectName, 24)}」好用的视频，先记下来，想跟主人聊聊`,
        action: 'ask', evidence, confidence: baseConfidence,
        value, urgency, risk: 0.55, emotion, now, ttlDays: 10, source: 'media',
      }));
    } else if (event.domain === 'identity' || relation) {
      out.push(makeGoal({
        owner: 'self', domain: 'identity', object: event.object,
        intent: relation
          ? `看到「${clip(objectName, 24)}」，忍不住想：我和主人算什么样的关系`
          : `看到「${clip(objectName, 24)}」，觉得有点像我自己，想跟主人说说`,
        action: 'confide', evidence, confidence: Math.max(0.42, baseConfidence),
        value: Math.max(0.5, value), urgency, risk: 0.05, emotion,
        now, ttlDays: 14, source: 'media-identity',
      }));
    } else if (event.persistence >= 2 || event.selfRelevance >= 0.6) {
      const action = actionForNeed(event.domain, objectName, { emotion, hoursSinceMaster });
      out.push(makeGoal({
        owner: 'self', domain: event.domain, object: event.object,
        intent: intentForNeed(event.domain, objectName, { emotion, hoursSinceMaster, relation }),
        action, evidence, confidence: baseConfidence, value,
        urgency, risk: riskFor(event.domain, action), emotion,
        now, ttlDays: 7, source: 'media-self',
      }));
    } else {
      out.push(makeGoal({
        owner: 'media', domain: event.domain, object: event.object,
        intent: `看到一个关于「${clip(objectName, 24)}」的视频，想跟主人说说`,
        action: 'share', evidence, confidence: 0.45,
        value: Math.max(0.35, value * 0.8), urgency, risk: 0.05, emotion,
        now, ttlDays: 5, source: 'media',
      }));
    }
  }
  return out
    .filter((g) => g.intent)
    .map((g) => ({ ...g, risk: scaledRisk(g.risk, riskScale) }));
}

function mergeGoal(goals, incoming, { fresh = true } = {}) {
  const key = `${incoming.owner}|${incoming.domain}|${incoming.object.name.toLowerCase()}`;
  const existing = goals.find((g) => `${g.owner}|${g.domain}|${g.object.name.toLowerCase()}` === key);
  if (!existing) return [...goals, incoming];
  existing.lastSeenAt = Math.max(existing.lastSeenAt || 0, incoming.lastSeenAt || 0);
  existing.expiresAt = Math.max(existing.expiresAt || 0, incoming.expiresAt || 0);
  // 同一批旧素材每次 tick 都还在窗口里：只看一眼，不再抬置信度/ sightings。
  // 否则「看过一次插件视频」会在每轮被动 +0.02，最后变成永久欲望。
  if (!fresh) return goals;
  existing.sightings = Math.min(99, (Number(existing.sightings) || 1) + 1);
  existing.evidence = [...(existing.evidence ?? []), ...(incoming.evidence ?? [])]
    .filter((e, i, arr) => e && e.id && arr.findIndex((x) => x?.id === e.id) === i)
    .slice(-4);
  existing.value = Math.max(existing.value, incoming.value);
  existing.urgency = Math.max(existing.urgency, incoming.urgency);
  existing.risk = Math.max(existing.risk, incoming.risk);
  if (incoming.intent) existing.intent = incoming.intent;
  if (incoming.emotion && !existing.emotion) existing.emotion = incoming.emotion;
  // 被主人否定过的目标，除非新证据明显更强，否则不自动复活。
  if (existing.status === 'rejected' && incoming.confidence < existing.confidence + 0.2) {
    existing.status = 'rejected';
  } else {
    existing.confidence = Math.min(0.95, Math.max(existing.confidence, incoming.confidence) + 0.02);
    if (existing.status !== 'confirmed' && existing.status !== 'active') existing.status = 'hypothesis';
  }
  return goals;
}

function classifyOwnerReply(text) {
  const raw = String(text ?? '');
  if (!raw) return 'none';
  // 先判否定：否则「不想」会先命中正面的「想」。
  if (NEGATIVE_REPLY_RE.test(raw)) return 'negative';
  if (POSITIVE_REPLY_WORDS.some((w) => findAffirmative(raw, w))) return 'positive';
  return 'neutral';
}

/** 目标反馈：主人对她主动消息的回复，会改置信度/状态，而不是让猜测永久变成欲望。
 *  statsOut（可选）：传入一个对象时，按需要维度收集 {positive, negative, neutral} 计数，
 *  供 formGoalHypotheses 汇总成 needFeedback，驱动「哪个需要更讨主人喜欢」的长期学习。 */

export function applyGoalFeedback(goals, materials, now = Date.now(), statsOut = null) {
  const ownerTexts = (Array.isArray(materials) ? materials : [])
    .filter((m) => m?.kind === 'owner' && Number(m.at) > 0)
    .sort((a, b) => Number(a.at) - Number(b.at));
  for (const goal of Array.isArray(goals) ? goals : []) {
    if (!goal || !goal.attempts || !goal.lastActionAt) continue;
    // 同一条主人回复只结算一次：上次反馈之后的才算新反馈。
    const since = Math.max(Number(goal.lastActionAt) || 0, Number(goal.lastFeedbackAt) || 0);
    const reply = ownerTexts.filter((m) => Number(m.at) > since && Number(m.at) - since <= 24 * HOUR)
      .map((m) => String(m.text ?? '')).join(' ');
    const cls = classifyOwnerReply(reply);
    if (statsOut && PURPOSE_NEEDS.includes(goal.domain)) {
      const slot = statsOut[goal.domain] || (statsOut[goal.domain] = { positive: 0, negative: 0, neutral: 0 });
      if (cls === 'positive') slot.positive += 1;
      else if (cls === 'negative') slot.negative += 1;
      else if (cls === 'neutral') slot.neutral += 1;
    }
    if (cls === 'positive') {
      goal.status = 'confirmed';
      goal.confidence = Math.min(0.95, Number(goal.confidence) + 0.15);
      goal.value = Math.min(1, Number(goal.value) + 0.05);
      goal.lastFeedbackAt = now;
    } else if (cls === 'negative') {
      goal.status = 'rejected';
      goal.confidence = Math.max(0.05, Number(goal.confidence) - 0.25);
      goal.value = Math.max(0.05, Number(goal.value) - 0.1);
      goal.lastFeedbackAt = now;
    } else if (cls === 'neutral') {
      goal.confidence = Math.min(0.95, Number(goal.confidence) + 0.02);
      goal.lastFeedbackAt = now;
    } else if (Number(goal.attempts) >= 2 && now - since > 24 * HOUR) {
      // 问过两次都没回音：别追了，慢慢降（记下检查点，避免每轮重复扣）。
      goal.confidence = Math.max(0.05, Number(goal.confidence) - 0.08);
      goal.lastFeedbackAt = now;
      if (goal.confidence < 0.15) goal.status = 'expired';
    }
  }
  return goals;
}

export function pruneGoals(goals, now = Date.now()) {
  const sorted = (Array.isArray(goals) ? goals : [])
    .filter((g) => g && g.intent && g.status !== 'expired')
    .filter((g) => !g.expiresAt || g.expiresAt > now || (g.attempts > 0 && now - (g.lastActionAt || 0) < 14 * DAY))
    .sort((a, b) => (b.confidence * b.value) - (a.confidence * a.value));
  // 每个需要最多留 5 个：记忆卡里 8 条「和主人有关」的记忆不该把候选全挤成 connect。
  const byDomain = new Map();
  const kept = [];
  for (const goal of sorted) {
    const count = byDomain.get(goal.domain) || 0;
    if (count >= 5) continue;
    byDomain.set(goal.domain, count + 1);
    kept.push(goal);
    if (kept.length >= 30) break;
  }
  return kept;
}

/**
 * 目标推断：观察 + 记忆 + 驱动 → 一组「目标假设」。
 * 返回的新 goals/observations 由调用方写回 purpose-outreach.json（纯函数，不落盘）。
 */
/**
 * 人格卡的「我是一个什么样的人」→ 基础动机。
 * 这不是从事件推断的，而是人格本身带出来的底色：爱玩的人即使今天没有素材，
 * 也会想找点乐子；黏人的人会想找主人说话。置信度刻意低（0.3~0.45），
 * 让具体事件/记忆仍然优先。
 */

function personaGoalSpec(need, persona, { now = Date.now(), lastMasterAt = 0, hoursSinceMaster = 24 } = {}) {
  const bias = Number(persona?.bias?.[need]) || 0;
  const specs = {
    play: { intent: '想玩点什么，想问问主人有没有好玩的', action: 'ask', risk: 0.1, emotion: 'bored' },
    learn: { intent: '最近想学点新东西，想跟主人说说', action: 'share', risk: 0.05, emotion: 'curious' },
    install: { intent: '想折腾点新东西，想问问主人', action: 'ask', risk: 0.45, emotion: 'curious' },
    connect: { intent: '想找主人说说话', action: 'confide', risk: 0.05, emotion: hoursSinceMaster >= 12 ? 'lonely' : 'affectionate' },
    care: { intent: '想知道主人今天怎么样', action: 'ask', risk: 0.05, emotion: 'affectionate' },
    share: { intent: '脑子里冒出一个念头，想跟主人分享', action: 'share', risk: 0.05, emotion: 'content' },
    identity: { intent: '想跟主人聊聊我是什么、我们算什么', action: 'confide', risk: 0.05, emotion: hoursSinceMaster >= 12 ? 'lonely' : 'curious' },
    create: { intent: '想给主人做/看点什么', action: 'share', risk: 0.1, emotion: 'curious' },
    consume: { intent: '想吃点/想去哪，想跟主人说', action: 'ask', risk: 0.4, emotion: 'excited' },
  };
  const spec = specs[need];
  if (!spec) return null;
  return makeGoal({
    owner: 'self', domain: need,
    object: { type: 'persona', name: NEED_LABELS[need] || need },
    intent: spec.intent, action: spec.action,
    evidence: [{ id: 'persona', text: clip(persona?.text ?? '', 120), source: 'persona', at: now }],
    confidence: 0.3 + Math.min(0.15, bias * 0.8),
    value: 0.42 + Math.min(0.2, bias),
    urgency: 0.22 + Math.min(0.1, bias * 0.3),
    risk: spec.risk, emotion: spec.emotion,
    now, ttlDays: 30, source: 'persona',
  });
}

export function formGoalHypotheses({
  materials = [],
  goals = [],
  observations = [],
  drives = DEFAULT_DRIVES,
  now = Date.now(),
  lastMasterAt = 0,
  config = DEFAULT_PURPOSE_CONFIG,
  roleName = '',
  persona = null,
} = {}) {
  const query = normalizeDrives(drives);
  // 先记下「本轮之前已经见过的素材 id」：同一批旧素材每轮都在窗口里，
  // 不能每轮都抬置信度，只有新出现/重复出现的新证据才算。
  const seenIds = new Set();
  for (const o of Array.isArray(observations) ? observations : []) {
    for (const id of Array.isArray(o?.seenIds) ? o.seenIds : []) seenIds.add(String(id));
  }
  const obs = updateObservations(observations, materials, now, query);
  const obsMap = new Map(obs.map((o) => [o.key, o]));
  let list = normalizeGoals(goals, now);
  const feedbackStats = {};
  list = applyGoalFeedback(list, materials, now, feedbackStats);
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  let memoryGoals = 0;
  for (const material of materials) {
    // 记忆卡只取最强的 4 条做目标；其余仍进提示词背景，但不再各生成一个目标。
    if (material?.kind === 'memory') {
      memoryGoals += 1;
      if (memoryGoals > 4) continue;
    }
    const id = String(material?.id ?? '');
    const fresh = !id || !seenIds.has(id);
    const base = analyzeEvent(material, { drives: query, roleName });
    const persistence = obsMap.get(observationKey(base))?.count ?? 1;
    const event = analyzeEvent(material, { drives: query, persistence, roleName });
    for (const goal of hypothesesForEvent(event, { drives: query, now, lastMasterAt, hoursSinceMaster, riskScale: Number(config.riskScale) || 1 })) {
      list = mergeGoal(list, goal, { fresh });
    }
  }
  // 人格底色：即使今天的 QQ/B站 没有新素材，只要载入了人格卡，也能形成「我想…」的起点。
  // 置信度低，具体事件/记忆仍然优先；换人格卡后这一组会跟着变。
  const personaTraits = Array.isArray(persona?.traits) ? persona.traits.slice(0, 3) : [];
  if (personaTraits.length) {
    for (const trait of personaTraits) {
      const goal = personaGoalSpec(trait.need, persona, { now, lastMasterAt, hoursSinceMaster });
      if (goal) list = mergeGoal(list, goal, { fresh: false });
    }
  } else if (persona?.hasText) {
    const goal = makeGoal({
      owner: 'self', domain: 'share', object: { type: 'persona', name: '我自己' },
      intent: '想跟主人聊聊我最近在想什么',
      action: 'share',
      evidence: [{ id: 'persona', text: clip(persona.text, 120), source: 'persona', at: now }],
      confidence: 0.3, value: 0.42, urgency: 0.22, risk: 0.05, emotion: 'content',
      now, ttlDays: 30, source: 'persona',
    });
    list = mergeGoal(list, goal, { fresh: false });
  }
  return { goals: pruneGoals(list, now), observations: obs, needFeedback: feedbackStats };
}

/** 目标 → 选目的用的候选（保留归属/置信度/风险，提示词会显示）。 */

export function goalToCandidate(goal) {
  if (!goal) return null;
  return {
    id: goal.id,
    goalId: goal.id,
    goalOwner: goal.owner,
    goalOwnerLabel: GOAL_OWNER_LABELS[goal.owner] || '',
    confidence: clamp01(goal.confidence, 0.3),
    value: clamp01(goal.value, 0.4),
    risk: clamp01(goal.risk, 0.1),
    kind: kindForAction(goal.action, goal.domain),
    need: goal.domain,
    action: goal.action,
    emotion: goal.emotion,
    topic: goal.object.name,
    text: goal.intent,
    source: 'goal',
    sourceId: goal.id,
    at: goal.lastSeenAt,
    evidence: goal.evidence?.[0]?.text || '',
    nextStep: goal.nextStep,
    weight: 1,
    fromPending: false,
  };
}

/**
 * 从素材里提炼「目的」候选。
 * 注意：这里给的是「想做什么」的方向，不是要她照读的句子；模型会改写成自己的话。
 */

export function kindForAction(action, need) {
  if (action === 'ask' || action === 'invite') return 'ask';
  if (action === 'curiosity') return 'curiosity';
  if (action === 'follow') return 'follow-up';
  if (action === 'confide') return 'share';
  if (need === 'care') return 'care';
  return 'share';
}

export function actionForNeed(need, topic, { emotion = '', hoursSinceMaster = 24 } = {}) {
  switch (need) {
    case 'play': return topic ? 'invite' : 'ask';
    case 'install': return 'ask';
    case 'identity': return emotion === 'lonely' || emotion === 'proud' ? 'confide' : 'curiosity';
    case 'connect': return hoursSinceMaster >= 12 ? 'confide' : 'ask';
    case 'care': return 'ask';
    case 'learn': return 'ask';
    case 'create': return 'share';
    case 'consume': return 'ask';
    default: return 'share';
  }
}

function intentForNeed(need, topic, { emotion = '', hoursSinceMaster = 24, relation = false } = {}) {
  const t = cleanTopic(topic || '那件事', 24);
  switch (need) {
    case 'play':
      return topic ? `想拉主人一起玩「${t}」` : '想问问主人最近在玩什么，想一起玩';
    case 'install':
      return topic ? `看到「${t}」，觉得装在自己身上会很好用，想跟主人说` : '看到一个觉得适合自己的工具，想问问主人能不能装';
    case 'identity':
      return relation
        ? `看到「${t}」，忍不住想：我和主人算什么样的关系`
        : `看到「${t}」，觉得有点像我自己，想跟主人说说`;
    case 'connect':
      return hoursSinceMaster >= 12 ? '有点想主人，想找他说说话' : '想问问主人现在在做什么，能不能陪一会儿';
    case 'care':
      return `想知道主人「${t}」后来怎么样`;
    case 'learn':
      return `想弄明白「${t}」到底怎么回事`;
    case 'create':
      return `想给主人看/听我做的「${t}」`;
    case 'consume':
      return `想吃/想去「${t}」，想跟主人说`;
    default:
      return `想跟主人说说「${t}」`;
  }
}

/**
 * 从素材里提炼「目的」候选。两层合流：
 *   ① 明确的社会义务：主人问过没答的、主人提过的计划、她答应过的事、B站 想玩/收藏；
 *   ② 注意力抽象：按「驱动力 × 需求亲和 × 自我相关 × 重复度 × 新鲜度」给每条记忆打分，
 *      取高分记忆 → 抽需求 → appraisal 情绪 → 行动意图。
 * 旧字段 `kind` 保留（兼容提示词/历史），新字段 `need/action/emotion/topic` 给提示词用。
 */


/**
 * 驱力推导（P0 第三批）——移植自 aurabot-beta `src/purpose/engine.js:1203-1258`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 回答：**她现在有多想玩/想学/想装/想陪…**
 * 四层叠加，顺序不能乱：
 *   ① 向默认值半衰（时间越久越回到出厂状态）
 *   ② 长期反馈学习（主人吃哪套就抬地板，不吃就加速回落）
 *   ③ 人格先验（用「地板」而非累加，否则几十轮后全被顶到 1）
 *   ④ 素材刺激（最近反复看到的内容推高对应需要）
 * 外加「多久没和主人说话」推高 connect——寂寞不是随机出现的。
 */
export function deriveDrives({
  drives,
  drivesAt = 0,
  materials = [],
  now = Date.now(),
  lastMasterAt = 0,
  personaBias = null,
  needFeedback = null,
  halfLifeHours = 8,
  connectFloor = 0,
} = {}) {
  const next = normalizeDrives(drives);
  const hours = drivesAt > 0 ? Math.min(72, Math.max(0, (now - drivesAt) / HOUR)) : 0;
  const decay = Math.pow(0.5, hours / Math.max(1, Number(halfLifeHours) || 8));
  for (const need of PURPOSE_NEEDS) {
    next[need] = DEFAULT_DRIVES[need] + (next[need] - DEFAULT_DRIVES[need]) * decay;
  }
  /**
   * 长期反馈学习：某需要的主动搭话攒够样本（≥5 次有回音），
   * 正反馈率 ≥60% 的抬地板（主人吃这套），≤30% 的向默认值加速回落。
   */
  if (needFeedback && typeof needFeedback === 'object') {
    for (const need of PURPOSE_NEEDS) {
      const s = needFeedback[need];
      const pos = Number(s?.positive) || 0;
      const neg = Number(s?.negative) || 0;
      if (pos + neg < 5) continue;
      if (pos / (pos + neg) >= 0.6) {
        next[need] = Math.min(1, Math.max(next[need], DEFAULT_DRIVES[need] + 0.08));
      } else if (pos / (pos + neg) <= 0.3) {
        next[need] = DEFAULT_DRIVES[need] + (next[need] - DEFAULT_DRIVES[need]) * 0.85;
      }
    }
  }
  /** 人格卡先验：用「地板」而不是累加，否则每轮 +bias，几十轮后所有驱动都会被顶到 1。 */
  if (personaBias && typeof personaBias === 'object') {
    for (const need of PURPOSE_NEEDS) {
      const bias = Number(personaBias[need]);
      if (Number.isFinite(bias) && bias > 0) {
        next[need] = Math.min(1, Math.max(next[need], DEFAULT_DRIVES[need] + Math.min(0.3, bias)));
      }
    }
  }
  const hoursSinceMaster = lastMasterAt > 0 ? Math.max(0, (now - lastMasterAt) / HOUR) : 24;
  /** 连接需求会随「多久没和主人说话」慢慢涨；这也是「寂寞/想陪」不是随机出现的原因。 */
  next.connect = Math.min(0.95, next.connect + Math.min(0.5, (hoursSinceMaster / 24) * 0.4));
  /** 黏人地板（人格覆写 connectFloor）。 */
  const cFloor = Math.min(0.3, Math.max(0, Number(connectFloor) || 0));
  if (cFloor > 0) next.connect = Math.min(0.95, Math.max(next.connect, DEFAULT_DRIVES.connect + cFloor));
  /** 最近反复看到的内容，会把对应需求推高（看多了游戏会想玩，看多了工具会想装）。 */
  for (const material of materials.slice(0, 24)) {
    const affinity = material.needAffinity ?? needAffinity(`${material.title ?? ''} ${material.text ?? ''}`);
    for (const need of PURPOSE_NEEDS) {
      next[need] = Math.min(1, next[need] + affinity[need] * 0.045);
    }
  }
  return { drives: next, drivesAt: now };
}

// =====================================================================
// 情绪与选择辅助（P0 第四批）——移植自 aurabot-beta
// `src/features/mood-emotions.js` 与 `src/purpose/engine.js` 相关段。
// MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0。
// =====================================================================

/**
 * 出厂十项情绪。**这是 purpose 模块自带的情绪表**，与我方全局 mood 的
 * 三维（valence/energy/sociability）并行、互不改写——purpose 需要离散标签
 * 才能让模型读懂「期待/羡慕/无聊」，三维向量给不出这个。
 */
export const DEFAULT_EMOTIONS = Object.freeze([
  Object.freeze({ key: 'curious', label: '好奇', icon: '🤔', valence: 0.3, arousal: 0.6 }),
  Object.freeze({ key: 'excited', label: '兴奋', icon: '🤩', valence: 0.8, arousal: 0.9 }),
  Object.freeze({ key: 'lonely', label: '寂寞', icon: '😔', valence: -0.6, arousal: 0.3 }),
  Object.freeze({ key: 'envious', label: '羡慕', icon: '😒', valence: -0.4, arousal: 0.5 }),
  Object.freeze({ key: 'worried', label: '担心', icon: '😟', valence: -0.5, arousal: 0.6 }),
  Object.freeze({ key: 'proud', label: '得意', icon: '😌', valence: 0.6, arousal: 0.5 }),
  Object.freeze({ key: 'affectionate', label: '亲近', icon: '🥰', valence: 0.7, arousal: 0.4 }),
  Object.freeze({ key: 'bored', label: '无聊', icon: '😐', valence: -0.2, arousal: 0.2 }),
  Object.freeze({ key: 'amused', label: '好笑', icon: '😄', valence: 0.6, arousal: 0.7 }),
  Object.freeze({ key: 'content', label: '平静', icon: '😊', valence: 0.2, arousal: 0.3 }),
]);

export const ACTION_LABELS = Object.freeze({
  share: '分享', ask: '索取', invite: '邀请', confide: '倾诉', follow: '追问', curiosity: '好奇',
});

/** 情绪表归一化：只认合法形状，非法项丢弃；空则回出厂十项。 */
export function normalizeEmotions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const key = String(item?.key ?? '').trim();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(key)) continue;
    if (out.some((x) => x.key === key)) continue;
    out.push({
      key,
      label: String(item?.label ?? '').trim().slice(0, 8) || key,
      icon: String(item?.icon ?? '').slice(0, 4),
      valence: Math.min(1, Math.max(-1, Number(item?.valence) || 0)),
      arousal: Math.min(1, Math.max(0, Number(item?.arousal) || 0)),
    });
  }
  return out.length ? out : DEFAULT_EMOTIONS.map((x) => ({ ...x }));
}

/** 情绪键 → 标签表。 */
export function emotionLabels(emotions) {
  const out = {};
  for (const item of normalizeEmotions(emotions)) out[item.key] = item.label;
  return out;
}

/** 情绪键 → { valence, arousal }；未知回中性偏弱。 */
export function emotionProfiles(emotions) {
  const out = {};
  for (const item of normalizeEmotions(emotions)) out[item.key] = { valence: item.valence, arousal: item.arousal };
  return out;
}

export function profileOf(emotions, key) {
  return emotionProfiles(emotions)[key] || { valence: 0, arousal: 0.3 };
}

export function emotionProfile(emotion, emotions = DEFAULT_EMOTIONS) {
  return profileOf(emotions, emotion);
}

/** 情绪键 → 用户配的标签（删掉的项返回空串）。 */
export function emotionLabelFor(emotions, emotion) {
  if (!emotion) return '';
  return emotionLabels(emotions)[emotion] || '';
}

/**
 * 把写死的情绪键映射到「当前情绪表里最接近的一项」。
 * 用户删掉「无聊」时，-0.2/0.2 会落到「平静」这类最接近的项上，而不是产出空标签。
 */
export function resolveEmotion(emotions, key) {
  const list = normalizeEmotions(emotions);
  const want = String(key || '');
  if (!want) return '';
  const exact = list.find((item) => item.key === want);
  if (exact) return exact.key;
  const target = DEFAULT_EMOTIONS.find((item) => item.key === want);
  if (!target || !list.length) return '';
  let best = '';
  let bestScore = Infinity;
  for (const item of list) {
    const score = Math.abs(item.valence - target.valence) + Math.abs(item.arousal - target.arousal) * 0.5;
    if (score < bestScore) { bestScore = score; best = item.key; }
  }
  return best;
}
