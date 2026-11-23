/**
 * 记忆：**两层，存在 dsh-roost 这边**。
 *
 * 为什么不在 ai-chat：
 *   1. 情绪要调制记忆（心情差记得更牢），两者必须同处一地
 *   2. 记忆的抽取/摘要/评分都要调模型，ai-chat 4.0.0 之后调不了模型
 *   3. 日记/图谱/向量最终都落在这边，facts 不该另起一处
 *
 * 两层：
 *   global —— 跨群共享（他是谁、经历过什么、约定过什么）
 *   chat   —— 这个群特有（梗、绰号、小圈子关系），**不串场**
 *
 * 存储：`<数据目录>/memory.json`，原子写（.tmp + rename）。形状：
 *
 *   {
 *     "global": ["主人住在杭州"],                 ← 事实正文，**永远是字符串数组**
 *     "chats":  { "g1": ["这个群管阿离叫小离"] },
 *     "meta":   { "global": { "主人住在杭州": { "w": 2, "at": 1750000000000, "src": {...},
 *                                              "until": 1750000000000 } },
 *                 "chats":  { "g1": { "…": {…} } } },
 *     "personas": {...}, "authz": {...}
 *   }
 *
 * `until` 有值 = 这条说法**被后来的说法取代了**（「搬到上海」之后的「住在杭州」）。
 * 不删，只打时间戳，和 `graph.js` 的双时态一个路子：注入只取活的，
 * 面板还看得见历史。没有 `until` 的老数据一律当活的。
 *
 * 为什么权重和出处**另开 meta，不把 facts 变成对象数组**：
 *   老版本的 `load()` 只认字符串（`filter(x => typeof x === 'string')`），
 *   一旦把 `global` 写成 `[{text:…}]`，降级回旧版就会**静默丢掉全部事实**——
 *   文件还在、内容也在，只是看不见。meta 是并行字段，老版本忽略它照常工作。
 *   代价是元数据以**文本**为 key：同一句话在不同群共用一份。
 *   实际无影响——文本相同就是同一条事实，而且我们从不改写已存的文本。
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

import { writeJsonAtomic } from './atomic.js';

/** 一条最多 200 字，每层最多 40 条（比原来的 20 条放宽，跨群后量会涨） */
const FACT_MAX = 200;
const FACTS_MAX = 40;

/**
 * 记忆文件的 schema 版本（A1，对齐 aurabot 的版本化迁移）。
 *
 * 为什么需要：记忆是全系统唯一的"她记得什么"真相源，以前只有原子改名
 * （写不坏），但没有版本——升级加了字段后，老库/新库混在一起没法校验，
 * 也没法在迁移前留一份可回滚的快照。
 *
 * 约定：
 *   · 老文件没有 `schemaVersion` → 当 v1 读（老库逐字节兼容，不强制升级）
 *   · 下次 save() 时打上当前版本（懒升级，不惊动只读启动）
 *   · 文件版本 > 当前支持 → 隔离（quarantine）+ 空视图，绝不写回
 *   · 迁移函数从 v1 逐级跑上来，每级只做一件事
 */
export const MEMORY_SCHEMA_VERSION = 1;
/** v(n) → v(n+1)：入参是整份对象，返回迁移后的对象；保持纯函数便于单测 */
const SCHEMA_MIGRATIONS = Object.freeze({
  // 1: (raw) => ({ ...raw, newField: default }),  // 将来加字段时在这里追加
});
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(
  [1, ...Object.keys(SCHEMA_MIGRATIONS).map(Number)],
);

/** 权重的天花板：同一件事被反复提到会加分，但别让它无限涨 */
const W_MAX = 5;
/** 重复被提到 / 被用到时加多少 */
const W_BUMP = 0.5;
/** 用户（或她自己）明确说「记住」的权重；巩固抽出来的按 1 算 */
export const W_EXPLICIT = 2;
/** 权重的时间半衰期（天）：30 天没被提到的，分量减半 */
const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * 一条事实「该不该留」的分数：重要度 × 时间衰减。
 *
 * 没有元数据（老数据）时按 `w=1`、不衰减算 —— 于是全部同分，淘汰退化成
 * 「最旧的先走」，**跟加权重之前的行为完全一致**。
 * 这是刻意的：升级不该悄悄改变已有库的淘汰顺序。
 *
 * 被取代的说法（有 `until`）打个折：它们**不参与注入**，却仍占那 40 个
 * 名额。不打折的话，一条 w=2 的旧说法会长期压着新事实，把活的名额挤掉。
 */
export function scoreOfFact(meta, now = Date.now()) {
  /** 自动权重（被反复提到）与手动重要度取大者；pin=0 时就是原来的 w */
  const autoW = Number(meta?.w) > 0 ? Number(meta.w) : 1;
  const pin = clamp01(meta?.pin);
  const w = Math.max(autoW, pin > 0 ? 1 + pin * (W_MAX - 1) : 0);
  /** 复习把衰减起点拉回 reviewedAt；老数据没有这个字段时 start === at */
  const start = Math.max(Number(meta?.at) || 0, Number(meta?.reviewedAt) || 0);
  const days = start ? Math.max(0, (now - start) / DAY_MS) : 0;
  const tier = FACT_TIERS.includes(meta?.tier) ? meta.tier : 'long';
  const base = tier === 'core' ? w : w * 0.5 ** (days / (HALF_LIFE_DAYS * (TIER_DECAY[tier] || 1)));
  let score = meta?.until ? base * HISTORY_WEIGHT : base;
  if (meta?.archivedAt) score *= ARCHIVE_WEIGHT;
  return score;
}

/**
 * 取代判定的相似度阈值（字符二元组 Jaccard）。
 *
 * 0.75 是**保守**值，只在"同一句话改了个尾巴"时触发：
 *   「主人住在杭州」vs「主人住在杭州市」         → 0.83 ✓ 取代
 *   「主人对花生过敏」vs「主人对花生过敏，严重」  → 0.75 ✓ 取代
 *   「主人养了猫」vs「主人养了狗」               → 0.43 ✗ 两条都留
 *   「主人在杭州工作」vs「主人住在杭州」          → 0.50 ✗ 两件事
 *
 * 宁可漏判（两条都留着，模型自己挑），不要误判（把不同的事当成改口抹掉）。
 */
const SUPERSEDE_SIM = 0.75;
/** 太短的文本不做取代判定：两三个字的二元组太少，比例没有意义 */
const SUPERSEDE_MIN_LEN = 4;
/** 已取代（历史）的分数折扣，见 `scoreOfFact` */
const HISTORY_WEIGHT = 0.5;

/* ---------------- 记忆数据扩展（2026-11-13） ----------------
 * 主人要求「记忆的数据能扩展就扩展」：给每条事实加可选元数据，让编辑文字 /
 * 改重要度 / 复习 / 层级 / 归档恢复都能真正落地，而不是因为数据模型不同
 * 就只做加删。
 *
 * 三条硬约束：
 *   1. 老库逐字不变：所有新字段都是可选，没有它们时 scoreOfFact 的结果
 *      、注入顺序、淘汰顺序与扩展前完全一致（有对照测试）。
 *   2. 稳定 id 由正文派生，不写进内存盘格式 —— 加事实那条路径一个字节
 *      都不改，也不会破坏已有的深等于断言。
 *   3. 自动权重 w（被反复提到）与手动重要度 pin 分开，不混成一个数。
 */
export const FACT_TIERS = Object.freeze(['short', 'long', 'core']);
/** short 衰减更快、core 不衰减；long 就是原来的 30 天 */
export const TIER_DECAY = Object.freeze({ short: 0.5, long: 1, core: 0 });
/** 归档的条目不注入，但留在库里可恢复；和 until 一样占名额时打折 */
export const ARCHIVE_WEIGHT = 0.25;

/**
 * B1 自动升档（对齐 aurabot growTier，但信号不同）：
 *   aurabot 用 hitDays（被检索命中的天数）；我们**故意不记 accessed**
 *   （"注入即加冕"——见上面 listRanked 的注释），所以改用 evidence 条数：
 *   每一条独立证据就是一次真实确认，不是"被自己读到"的假信号。
 *
 * 规则：short→long 需 2 条证据或 w≥2；long→core 需 4 条证据或 w≥4。
 * core 永不降级（aurabot 的 strongerTier 语义——永久层只升不降）。
 * 纯函数：不写盘，调用方在写入路径决定何时落。
 */
export function growTier(meta) {
  const cur = FACT_TIERS.includes(meta?.tier) ? meta.tier : 'long';
  if (cur === 'core') return 'core';
  const ev = Array.isArray(meta?.evidence) ? meta.evidence.length : 0;
  const w = Number(meta?.w) > 0 ? Number(meta.w) : 1;
  if (cur === 'short' && (ev >= 2 || w >= 2)) return 'long';
  if (cur === 'long' && (ev >= 4 || w >= 4)) return 'core';
  return cur;
}

/* ---------------- 可信度分级（2026-11-18） ----------------
 * 修的问题：群聊里"张三说他下周三出差"这种**转述**，和主人亲口说的
 * "我下周三出差"以前在库里长得一模一样，同样的 `w`、同样进 system 常驻。
 * 转述被当成铁律讲给主人听，是记忆系统最伤信任的一种错。
 *
 * 三档（`meta[正文].status`，旁路字段）：
 *   fact     本人说的 / 手记 / 模型标记 —— **老数据没有这个字段，一律按 fact**
 *   hearsay  听人转述的 —— 照常注入，但渲染时标「（听说的）」
 *   guess    模型推测的 —— **不注入**，留在库里给面板看
 *
 * 为什么是"标注"而不是"降权"：淘汰（每层配额 + 总量 40 条）与排序共用
 * `scoreOfFact`，动 `w` 等于让转述优先被静默删掉——用户只会看到"她忘事了"。
 * 只在排序处打折又违背 `listRanked` 注释里那条「留得下必须看得见」。
 *
 * 为什么不硬拦"转述不许取代本人陈述"：模型把真实改口（"我搬到上海了"）
 * 误标成 hearsay 时，旧事实就永远改不掉，两条矛盾长期并存——比被顶掉更糟。
 * 所以只拦**跨级顶替**（低可信度不许关掉高可信度），同级允许。
 */
export const FACT_STATUSES = Object.freeze(['fact', 'hearsay', 'guess']);
/** 数字越大越可信；只在"跨级顶替"时用，不参与打分 */
const STATUS_RANK = Object.freeze({ fact: 2, hearsay: 1, guess: 0 });
/** 拦截时给调用方/面板看的说法 */
const STATUS_LABEL = Object.freeze({ fact: '本人说的', hearsay: '听说的', guess: '猜的' });

/** 归一化：不认识的值 / 老数据没有 → fact（保守：宁可当真，也不静默丢一条） */
export function statusOf(meta) {
  const s = meta?.status;
  return FACT_STATUSES.includes(s) ? s : 'fact';
}

/**
 * 取两者里更可信的那个；用于"重提一次"时不降级、确认时可以升级。
 *
 * `a` 是**库里已有的值**：没有 status 的老数据按 `fact` 算（和 `statusOf`
 * 同一口径）。这一点不能省——`addInto` 的「又提了一次」分支没有跨级顶替
 * 护栏，若这里把 `undefined` 当成"空"再返回 `b`，一条老事实遇上一字不差的
 * 转述就会被静默降级成 `hearsay`，注入时还带上「（听说的）」，与"重提一次
 * 不降级"正好相反。`b` 不传 = 没表态，保持原样。
 */
export function strongerStatus(a, b) {
  const x = statusOf({ status: a });
  const y = FACT_STATUSES.includes(b) ? b : '';
  if (!y) return x;
  return STATUS_RANK[y] > STATUS_RANK[x] ? y : x;
}

/** 低可信度不许取代高可信度；同级 / 升级都允许 */
export function canSupersede(nextStatus, oldStatus) {
  return STATUS_RANK[statusOf({ status: nextStatus })] >= STATUS_RANK[statusOf({ status: oldStatus })];
}

/* ---------------- 证据账本（2026-11-23，P0） ---------------- */

/**
 * 一条信念的"证据强度"，与 `w`（重要性）、`accessed`（被想起次数）**三者正交**。
 *
 * 为什么不合并：`w` 是"这事多重要"，`accessed` 是"被检索到几次"（检索效用），
 * 而 `confidence` 是"有几条独立证据撑着"（认知强度）。一条被反复提起的
 * 转述（accessed 高、confidence 低）和一条主人强调过三次的事（都高）不是一回事。
 * 合并成一个数＝让频次冒充证据——`scoreOf` 防的"永久加冕"会换个名字复发。
 *
 * 存 `meta[正文]` 的三个旁路字段，**全部默认值不落盘**：
 *   proofs     独立证据条数（默认 0）
 *   evidence   出处摘要数组（默认 []，每条 {kind,at,detail}，detail 只留短句不抄原文）
 *   confidence 0..1 信念强度（默认 1，满信念；老库/普通事实字节不变）
 *
 * 为什么默认 confidence=1 而不是 0.5：老数据没有这个字段，一律当"我就是这么记的"
 * 的满信念；只有明确传来 weaken/contradict 才往下调。这样升级是纯增量。
 */
export const EVIDENCE_RELATIONS = Object.freeze(['reinforce', 'weaken', 'contradict', 'neutral']);
/**
 * 证据趋势的档位。照搬 Hindsight `engine/reflect/observations.py` 的 Trend，
 * 不改阈值、不改窗口——对面踩过坑的取舍直接用，别自己设计。
 */
export const EVIDENCE_TRENDS = Object.freeze(['new', 'strengthening', 'stable', 'weakening', 'stale']);
const ALPHA = 0.25;
const EVIDENCE_MAX = 12;
const TREND_RECENT_DAYS = 30;
const TREND_OLD_DAYS = 90;

/** 归一化：老数据没有这些字段时给默认，不写回盘 */
/* ---------------- 双时态 + 记忆种类（A2，对齐 Hindsight 的 world/experience/observation） ---------------- */

/**
 * 一条事实"是什么种类"。照 Hindsight `retain/types.py` 的三分：
 *   world       客观事实（"他住在杭州"）——默认，老库一律当这个
 *   experience  亲历（"我上周搬到杭州"）——是第一人称经历
 *   observation 观察/判断（"他好像喜欢杭州"）——带主观色彩，容易被推翻
 *
 * 为什么分开：三种的可信度演化规则不同（observation 最脆，world 最稳），
 * 而且检索时可以按种类过滤。默认 world 保证老库逐字节不变。
 */
export const FACT_KINDS = Object.freeze(['world', 'experience', 'observation']);

/** 归一化种类；非法/缺省一律 world（老库兼容） */
export function kindOf(meta) {
  const k = String(meta?.kind ?? '');
  return FACT_KINDS.includes(k) ? k : 'world';
}

/**
 * 双时态：
 *   at          = 陈述/记录时间（这条记忆**什么时候进的库**）——所有旧逻辑都用它
 *   occurredAt  = 事发时间（这件事**实际什么时候发生的**）——可选，老库没有
 *
 * Hindsight 把这两个分开（occurred_start/end vs mentioned_at），因为
 * "上周说的那场三年前的搬家"里，两个时间差了三年。我们让 occurredAt
 * 可选、缺省回退到 at——这样老逻辑不用改，新能力只在有值时生效。
 */
export function occurredOf(meta, fallback) {
  const t = Number(meta?.occurredAt);
  if (Number.isFinite(t) && t > 0) return t;
  /** 没给 fallback 时自动回退到 meta.at——"没写事发时间"就是"事发即记录" */
  const f = fallback === undefined ? Number(meta?.at) : Number(fallback);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

export function evidenceOf(meta) {
  const raw = Array.isArray(meta?.evidence) ? meta.evidence : [];
  return {
    proofs: Math.max(0, Number(meta?.proofs) || 0),
    evidence: raw.slice(0, EVIDENCE_MAX),
    confidence: clamp01(meta?.confidence ?? 1),
  };
}

/**
 * 四档证据关系 → 新的证据强度。纯函数，可单测。
 *
 * reinforce +α / weaken −α / contradict −2α / neutral 不动；全部夹在 [0,1]。
 * `proofs` 只在带来新出处时 +1（`evidence` 有内容），neutral 不算新证据。
 *
 * 这里**不改 status、不改 w**：跨级顶替护栏（`canSupersede`）仍由 `addInto` 守，
 * 证据只影响置信度，不动"谁能关掉谁"——否则信源判断会被绕过。
 */
export function applyEvidence(prev, relation, item = null) {
  const cur = evidenceOf(prev);
  const rel = EVIDENCE_RELATIONS.includes(relation) ? relation : 'neutral';
  const delta = rel === 'reinforce' ? ALPHA : rel === 'weaken' ? -ALPHA : rel === 'contradict' ? -2 * ALPHA : 0;
  const withItem = item && typeof item === 'object' && Object.keys(item).length > 0;
  const evidence = withItem
    ? [...cur.evidence, { ...item, at: Number(item.at) > 0 ? Number(item.at) : Date.now() }].slice(-EVIDENCE_MAX)
    : cur.evidence;
  return {
    proofs: cur.proofs + (withItem ? 1 : 0),
    evidence,
    confidence: clamp01(cur.confidence + delta),
  };
}

/**
 * 证据趋势：由证据时间戳分布**算出来**，不是谁判定的动作。
 *
 * 逐行照搬 Hindsight `compute_trend()`（30/90 天窗口、密度比 1.5 / 0.5）：
 *   没有近期证据 → stale；全在近期 → new；近期密度是早期的 1.5 倍以上 →
 *   strengthening；不到一半 → weakening；其余 stable。
 *
 * 为什么这样就能解"weaken 没有调用方"：旧证据自然变稀疏，趋势自己会掉，
 * 不需要有人显式调用 weaken。这是对面成熟的地方——bet on it，不自己设计。
 *
 * 纯函数，不写盘、不依赖模型。`confidence` 是显式判定信号（对标它的 opinion
 * 网络），`trend` 是算出来的观察信号（对标 observation 网络），两者正交并存。
 */
export function trendOf(evidence, now = Date.now(), { recentDays = TREND_RECENT_DAYS, oldDays = TREND_OLD_DAYS } = {}) {
  const rows = Array.isArray(evidence) ? evidence : [];
  if (!rows.length) return 'stale';
  const ts = rows.map((e) => Number(e?.at) || 0).filter((n) => n > 0);
  if (!ts.length) return 'stale';
  const nowMs = Number(now) > 0 ? Number(now) : Date.now();
  const recentCut = nowMs - recentDays * DAY_MS;
  const oldCut = nowMs - oldDays * DAY_MS;
  const recent = ts.filter((t) => t > recentCut);
  const old = ts.filter((t) => t < oldCut);
  const middle = ts.filter((t) => t >= oldCut && t <= recentCut);
  if (!recent.length) return 'stale';
  if (!old.length && !middle.length) return 'new';
  const recentDensity = recentDays > 0 ? recent.length / recentDays : 0;
  const olderPeriod = oldDays - recentDays;
  const olderDensity = olderPeriod > 0 ? (old.length + middle.length) / olderPeriod : 0;
  if (!olderDensity) return 'new';
  const ratio = recentDensity / olderDensity;
  if (ratio > 1.5) return 'strengthening';
  if (ratio < 0.5) return 'weakening';
  return 'stable';
}

/** 把算出的证据字段写进 meta；默认值删掉不落盘（老库字节一致） */
function writeEvidence(meta, next) {
  if (next.proofs > 0) meta.proofs = next.proofs; else delete meta.proofs;
  if (next.evidence.length) meta.evidence = next.evidence; else delete meta.evidence;
  if (next.confidence < 1) meta.confidence = next.confidence; else delete meta.confidence;
  return meta;
}

/** 正文 → 稳定短 id（djb2）；同一句话永远同一个 id，编辑后自然换新 id */
export function factIdOf(text) {
  let h = 5381;
  const str = String(text ?? '');
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `f${(h >>> 0).toString(36)}`;
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 面板星图用的清晰度：0.15–1，复习会把衰减起点拉回来 */
export function brightnessOf(meta, now = Date.now()) {
  const w = Math.max(1, Number(meta?.w) || 1, 1 + (clamp01(meta?.pin) * (W_MAX - 1)));
  const start = Math.max(Number(meta?.at) || 0, Number(meta?.reviewedAt) || 0);
  const days = start ? Math.max(0, (now - start) / DAY_MS) : 0;
  const tier = FACT_TIERS.includes(meta?.tier) ? meta.tier : 'long';
  const decay = tier === 'core' ? 1 : 0.5 ** (days / (HALF_LIFE_DAYS * (TIER_DECAY[tier] || 1)));
  const b = 0.15 + 0.85 * Math.min(1, w / W_MAX) * decay;
  return Math.round(b * 1000) / 1000;
}

/**
 * 字符二元组。
 *
 * 中文没有空格，按字切比按词切稳 —— 不需要分词表，也不受"未登录词"影响。
 * 代价是它只看字面：语义改口（「搬到上海」vs「住在杭州」）它抓不到，
 * 那类要靠模型判定，别指望调阈值调出来。
 */
export function bigramsOf(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

/**
 * 两句话是不是「互相矛盾」——字面很像但意思相反，不能当改口取代掉。
 *
 * `similarityOf` 只看字符二元组，看不出「过敏 / 不过敏」和
 * 「3 栋 / 4 栋」这种一个字的差别。相似度越高越危险：恰恰是这类
 * 句子会越过 0.75 阈值，把旧事实误标成历史，留下一条错的事实。
 *
 * 只查两件零成本的事：否定词个数、数字序列。宁可漏判（继续让模型
 * 用 `<<replace>>` 显式改口），也不能把相反的意思合成一条。
 */
const NEG_WORDS = /[不没无非未勿否别]/g;
export function conflicting(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  const nx = (x.match(NEG_WORDS) || []).length;
  const ny = (y.match(NEG_WORDS) || []).length;
  if (nx !== ny) return true;
  const dx = x.match(/\d+(?:\.\d+)?/g) || [];
  const dy = y.match(/\d+(?:\.\d+)?/g) || [];
  if (dx.length !== dy.length) return true;
  return dx.some((n, i) => n !== dy[i]);
}

/** 两句话有多像（0~1）。Jaccard：不看顺序、不看长度 */
export function similarityOf(a, b) {
  const A = bigramsOf(a);
  const B = bigramsOf(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/**
 * 事实的出处，**统一在这里收口**。
 *
 * 为什么要一个收口函数：`src` 是从消息 payload 来的（`payload.id` / `payload.eventIds`），
 * 一路写进 `memory.json` 长期存着。不收口的话，一个畸形 payload 就能把
 * 几千个 event id 灌进每条事实里，文件悄悄涨到几十 MB，而没有任何一处会报错。
 *
 * 形状（都可有可无，全空就当没有出处）：
 *   journalId  这一轮对应的日记行 id（= 消息 id），拿它调 `/r/context?aroundId=` 能翻回原文
 *   eventIds   事件账本里的那几条（合并批是多条）
 *   at         记下这条的时间
 *   manual     面板上手动记的（人手写的，没有消息来源）
 *   by         谁记的（现在只有 'owner'）
 *   speaker    这句话是谁说的（巩固时从 `[id] 时间 某人(level): text` 里带出来）。
 *              **只记来源，不参与可信度判定**——status 在 `meta[正文].status`，
 *              免得同一个事实有两份真相；留着它是为了以后能重判（模型标错了，
 *              还能凭说话人重新算一次，而不是无从下手）。
 *
 * @returns {object|null} 清理过的出处；没有任何有效字段时返回 null（不存 `{}`）
 */
export function normalizeSrc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};

  const s = (v, max) => {
    const t = String(v ?? '').trim().slice(0, max);
    return t || '';
  };

  const journalId = s(raw.journalId, 120);
  if (journalId) out.journalId = journalId;

  if (Array.isArray(raw.eventIds)) {
    const ids = [...new Set(raw.eventIds.map((x) => s(x, 120)).filter(Boolean))].slice(0, 50);
    if (ids.length) out.eventIds = ids;
  }

  const at = Number(raw.at);
  if (Number.isFinite(at) && at > 0) out.at = at;

  if (raw.manual === true) out.manual = true;
  const by = s(raw.by, 20);
  if (by) out.by = by;
  const speaker = s(raw.speaker, 40);
  if (speaker) out.speaker = speaker;

  return Object.keys(out).length ? out : null;
}

/**
 * 合并「当前会话键 + 别名键」的聊天层事实。
 *
 * 别名是什么：这个群 / 这个人的**号码**，以及它名下**所有** openid
 * （含以前那只机器人给的）。openid 换机器人就变，旧记忆还在旧键下面——
 * 不多试几个键，换一次机器人记忆就等于丢了。存量数据一个字节都不动。
 *
 * 三条规矩：
 *   1. **当前键排在最前**，同一条事实在两处都有时用当前键的元数据（更新的）
 *   2. `fromAlias` 标出「这条是从别的键读来的」——它们不参与时间衰减，
 *      否则几十天前的老事实一上来就被 0.5^(天数/30) 打到看不见，
 *      「能读到」等于白搭
 *   3. 空键、非字符串一律跳过（脏数据不该让整个记忆读不出来）
 */
function collectChat(m, chatId, aliases) {
  const keys = chatKeys(chatId, aliases);
  const list = [];
  const meta = {};
  const fromAlias = new Set();
  const seen = new Set();

  for (const [i, k] of keys.entries()) {
    const arr = m.chats?.[k];
    if (!Array.isArray(arr)) continue;
    const mm = m.meta?.chats?.[k] ?? {};
    for (const text of arr) {
      if (typeof text !== 'string' || !text || seen.has(text)) continue;
      seen.add(text);
      list.push(text);
      if (mm[text]) meta[text] = mm[text];
      if (i > 0) fromAlias.add(text);
    }
  }
  return { list, meta, fromAlias };
}

/**
 * 当前键 + 别名，去重、去空、**当前键永远排第一**。
 *
 * 读写两条路都要用它。只给读路径用是这个功能最容易犯的错：
 * 读的时候把旧键的事读出来了（面板上看得见、提示词里也注入了），
 * 用户说「忘掉这个」却只删当前键——删完再读，那条还在。
 * `journal.js` 里那句注释说得很准：「用户说忘掉三个月前那件事，
 * 实际没忘，是最不能接受的一种失败」。
 */
function chatKeys(chatId, aliases) {
  const out = [];
  const seen = new Set();
  for (const k of [chatId, ...(Array.isArray(aliases) ? aliases : [])]) {
    const s = String(k ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * 从**别名键**读来的事实的分数：**衰减最多打一次对折**。
 *
 * 为什么不能直接用 `scoreOfFact`：别名键里的都是换机器人之前的老事实，
 * 90 天前记的分数只剩 0.125，`slice(0, 3)` 永远轮不到——「能读到」等于白搭。
 *
 * 为什么也不能干脆不衰减：那样一条 `w=1` 的老事实分数正好是 1，
 * 而刚记的那条是 `1 × 0.5^(几毫秒/30天) ≈ 0.999999999`，
 * 老事实会以 1e-9 之差赢过刚说的话。所以给个**下限**而不是豁免：
 * 重要的老事（w 高）照样能浮上来，同权重的仍然让位给新的。
 */
function scoreOfAliasFact(meta, now = Date.now()) {
  const at = Number(meta?.at) || 0;
  /**
   * **没有 `at` 的老数据按「很老」算，不能按「刚记的」算。**
   *
   * 早期版本的 facts 只有字符串、没有 meta。直接 `scoreOfFact(undefined)`
   * 会返回 1，而刚记的那条是 `1 × 0.5^(几毫秒/30天) ≈ 0.999999999`——
   * 于是「一条不知道多久以前的老事实」以 1e-9 之差压过刚说的话。
   * 而老数据恰恰最可能没有 meta。
   */
  if (!at) return scoreOfFact({ ...meta, at: now - HALF_LIFE_DAYS * DAY_MS }, now);
  const days = Math.max(0, (now - at) / DAY_MS);
  const capped = Math.min(days, HALF_LIFE_DAYS);
  return scoreOfFact({ ...meta, at: now - capped * DAY_MS }, now);
}

export function createMemory({ now = () => Date.now(), capacityOf = null, log = () => {} } = {}) {
  const file = () => join(dataDir(), 'memory.json');
  let cache = null;
  /**
   * 读盘遇到 ENOENT 之外的错误（EBUSY / EACCES / EIO）时置位。
   *
   * 这时**不能**把内存当空、更不能让下一次 `save()` 用空表覆盖整份文件：
   * Windows 上杀软、编辑器、OneDrive 短暂占用都会给 EBUSY，一次瞬时故障
   * 就会把 facts / personas / authz 全抹掉（表现是「重启一次记忆就没了」，
   * 而且没有任何报错）。宁可这一轮不写，等下次启动恢复。
   *
   * 与 `pending-opening.js` 同一套处理：读不动 ≠ 空。
   */
  let ioFailed = false;
  /** 上次尝试重读的时刻：读失败后按 5 秒节流重试，别每次访问都去撞坏路径 */
  let lastRetryAt = 0;
  const RETRY_MS = 5_000;

  /**
   * 坏文件先留一份再降级。
   *
   * 只留最近 3 份：一个反复损坏的文件不该每月堆 3 份含聊天原文的小文件。
   */
  function quarantine(text, why) {
    try {
      const dir = dataDir();
      const base = 'memory.json';
      const bak = join(dir, `${base}.corrupted.${Date.now()}`);
      writeFileSync(bak, text, 'utf8');
      const prefix = `${base}.corrupted.`;
      const all = readdirSync(dir).filter((n) => n.startsWith(prefix)).sort();
      for (const n of all.slice(0, -3)) {
        try {
          unlinkSync(join(dir, n));
        } catch {
          /* 清理失败不能拦住启动 */
        }
      }
      log(`记忆文件${why}，已备份到 ${bak}，按空记忆继续`);
    } catch (e) {
      log(`记忆文件${why}，备份也失败：${e?.message ?? e}`);
    }
  }

  /**
   * 把盘上的原始对象拍成内存形状。
   *
   * **从 `raw` 展开**，不是从空对象重建：以前这里是
   * `cache = { global, chats, personas }`，白名单漏了 `authz`——重启后读不到
   * 授权，而下一次 `save()` 还会把盘上那段**抹掉**，表现是「重启一次群主动
   * 就永久失效」。展开 raw 之后，别处写进来的字段都不会被白名单吃掉。
   */
  /**
   * 版本校验 + 逐级迁移。返回迁移后的对象，或 null（版本过高/非法，调用方隔离）。
   * 无 schemaVersion 的老库当 v1——这是"只增不减"的底线。
   */
  function migrateSchema(raw) {
    const v = raw.schemaVersion === undefined ? 1 : Number(raw.schemaVersion);
    if (!Number.isInteger(v) || v < 1) return null;
    /** 高版本文件绝不能读：用旧代码写回去会静默丢掉新版本字段 */
    if (v > MEMORY_SCHEMA_VERSION) return null;
    let out = { ...raw };
    for (let from = v; from < MEMORY_SCHEMA_VERSION; from += 1) {
      const step = SCHEMA_MIGRATIONS[from];
      if (typeof step !== 'function') return null;
      out = step(out) || out;
    }
    out.schemaVersion = MEMORY_SCHEMA_VERSION;
    return out;
  }

  function normalizeMemory(raw) {
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    return {
      ...raw,
      global: Array.isArray(raw.global) ? raw.global.filter((x) => typeof x === 'string' && x) : [],
      /** 数组也是 object：漏判会让字符串键在 `JSON.stringify` 时被丢掉 */
      chats: raw.chats && typeof raw.chats === 'object' && !Array.isArray(raw.chats) ? raw.chats : {},
      meta: {
        global: meta.global && typeof meta.global === 'object' ? meta.global : {},
        /** 数组也是 object：留着数组会让 `meta.chats[chatId]` 恒为 undefined，权重/有效期一起失效 */
        chats: meta.chats && typeof meta.chats === 'object' && !Array.isArray(meta.chats)
          ? meta.chats
          : {},
      },
      /**
       * 按群的人设覆盖（模型用 `<<persona: 内容>>` 写）。
       *
       * 为什么放这儿：人格以前在 ai-chat 有一份 500 字的碎文本，
       * 跟这边的 `personas/*.md` 打架。现在只留一处——
       * 覆盖优先于 personas 文件，清掉就回到文件里那个人格。
       */
      personas: raw.personas && typeof raw.personas === 'object' && !Array.isArray(raw.personas)
        ? raw.personas
        : {},
    };
  }

  function load() {
    if (cache && !ioFailed) return cache;
    /**
     * 读失败过：**不能就此永久放弃**。
     *
     * 只认一次失败的话，一次瞬时 EBUSY 会让整个进程再也读不到、也再也不写
     * （`ioFailed` 挡住 `save()`），表现是「记忆突然全空、怎么改都不落盘」。
     * 按 5 秒节流重试：锁一解除就自己恢复；网络盘上也不至于每次访问都卡几秒。
     */
    if (ioFailed) {
      if (now() - lastRetryAt < RETRY_MS) return cache || normalizeMemory({});
      lastRetryAt = now();
    }

    let text;
    try {
      text = readFileSync(file(), 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT') {
        /** 首次运行：空记忆是**真的**空，可以写 */
        ioFailed = false;
        cache = normalizeMemory({});
        return cache;
      }
      /** 读不动 ≠ 空：给空视图但禁止落盘，别把盘上还能救的内容盖掉 */
      ioFailed = true;
      lastRetryAt = now();
      log(`记忆读取失败（${e?.code || e?.message}），本次不写入，稍后自动重试`);
      cache = cache || normalizeMemory({});
      return cache;
    }

    let raw;
    try {
      raw = JSON.parse(text) || {};
    } catch (e) {
      quarantine(text, `不是合法 JSON（${e?.message ?? e}）`);
      ioFailed = false;
      cache = normalizeMemory({});
      return cache;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      quarantine(text, '顶层不是对象');
      ioFailed = false;
      cache = normalizeMemory({});
      return cache;
    }
    /** schema 版本校验：高版本/非法版本隔离，老库无版本按 v1 迁移上来 */
    const migrated = migrateSchema(raw);
    if (!migrated) {
      quarantine(text, `schema 版本不认识（${String(raw.schemaVersion)}，支持 1..${MEMORY_SCHEMA_VERSION}）`);
      ioFailed = false;
      cache = normalizeMemory({});
      return cache;
    }
    /** 读成功了：解除禁令（可能是从上次的故障里恢复） */
    ioFailed = false;
    cache = normalizeMemory(migrated);
    return cache;
  }

  function save() {
    const m = load();
    /** 读盘失败过：这一轮绝不写，避免用空表覆盖盘上还能救的内容 */
    if (ioFailed) return false;
    try {
      /**
       * 写前留一份快照（只留一份 .prev），回滚/迁移出错时能拿回上一版。
       * 首次运行（文件还不存在）没有可快照的内容，跳过。
       * 快照失败不拦住正常写——它是保险，不是命门。
       */
      try {
        if (existsSync(file())) copyFileSync(file(), `${file()}.prev`);
      } catch { /* 快照写不下去也要继续写正本 */ }
      /** 老库/首次运行没有版本字段，写盘时补上（懒升级，只读启动不惊动） */
      writeJsonAtomic(file(), { ...m, schemaVersion: MEMORY_SCHEMA_VERSION });
      return true;
    } catch {
      /* 写不进去就算了，不能因为存记忆把这一轮弄挂 */
      return false;
    }
  }

  const clean = (f) => String(f ?? '').trim().slice(0, FACT_MAX);

  /**
   * 往一层里放一条，必要时按分数淘汰。
   *
   * @param {string[]} list
   * @param {object} metaMap 这一层的元数据（会被就地修改）
   * @param {string} fact
   * @param {{w?:number, src?:object, at?:number}} [opts]
   * @returns {string[]} 新的列表
   */
  function addInto(list, metaMap, fact, opts = {}) {
    const f = clean(fact);
    if (!f) return list;
    const t = Number(opts.at) > 0 ? Number(opts.at) : now();
    const old = metaMap[f];
    // 收口在这里：所有写入路径（模型标记、面板手记、以后新增的）都过一遍
    const src = normalizeSrc(opts.src);
    /**
     * 调用方不传 = **没表态**（不是"说这是真的"）。
     *
     * 区分这两种很重要：老调用点、`<<remember>>`、面板手记都不传，
     * 它们不该把一条"听说的"顺手升成事实；只有显式传 `status:'fact'`
     * （= 又一次亲口确认）才允许升级。
     */
    const nextStatus = FACT_STATUSES.includes(opts.status) ? opts.status : '';

    /**
     * 同槽位取代：这次记的和某条旧说法几乎是同一句，就给旧的打 `until`。
     *
     * 为什么要有：没有它，「主人住在杭州」和「主人住在杭州市」会同时留在
     * 库里、同时注入，白占两个名额，模型还得自己挑一条。
     *
     * 判定**故意用字面相似度**、不调模型：
     *   · 它只抓"同一句改了个尾巴"这一类，抓不到「搬到上海」那种语义改口
     *     —— 那是另一件事，要模型判定，不是调阈值能解决的；
     *   · 好处是零成本、可测、当场生效，而且宁漏不误（阈值 0.75）。
     *
     * 旧条目**不删**，只打时间戳（和 `graph.js` 的双时态一个路子）：
     * 面板还看得见历史，注入只取活的。
     */
    const supersede = () => {
      if (f.length < SUPERSEDE_MIN_LEN) return;
      for (const other of list) {
        if (other === f) continue;
        const om = metaMap[other];
        if (om?.until) continue; // 已经是历史了，不重复打
        if (other.length < SUPERSEDE_MIN_LEN) continue;
        if (similarityOf(other, f) < SUPERSEDE_SIM) continue;
        if (conflicting(other, f)) continue; // 过敏 / 不过敏、3 栋 / 4 栋：不是改口，都留着
        /**
         * 跨级顶替护栏：听说的关不掉本人说的、猜的谁都关不掉。
         *
         * 为什么只拦跨级：模型把真实改口（"我搬到上海了"）误标成 hearsay 时，
         * 硬拦会让旧事实**永远改不掉**，两条矛盾长期并存——比被顶掉更糟。
         * 同级的照旧取代，人工入口（`<<remember>>`、面板手记）恒为 fact。
         */
        if (!canSupersede(nextStatus, om?.status)) continue;
        metaMap[other] = { ...om, until: t };
      }
    };

    if (list.includes(f)) {
      /**
       * 又提了一次同一件事 —— 加权重，不加条目。
       *
       * 反复被提到的才是他真正在意的事。这比单纯按时间排队更接近人怎么记东西：
       * 「我生日是三月五号」被说过五次，不该因为今天新记了五条杂事就被挤掉。
       *
       * 如果这条**自己**已经是历史（被后来的说法取代过），这次重提就是
       * 重新确认 —— 把 `until` 清掉，让它回到活的那一批。
       */
      const next = {
        ...old,
        w: Math.min(W_MAX, (Number(old?.w) > 0 ? Number(old.w) : 1) + W_BUMP),
        at: t,
        src: src || old?.src || null,
        /** 重提一次不降级（听说的再听一遍还是听说的）；明确说了一次算确认，可升到 fact */
        status: strongerStatus(old?.status, nextStatus),
      };
      if (next.until) next.until = null;
      /**
       * 双时态：重提不改"这是什么种类 / 事发何时"——它们是事实的属性，
       * 不是每次陈述的属性。只在原来缺失时补一次（老库升级）。
       */
      if (!FACT_KINDS.includes(next.kind) && FACT_KINDS.includes(opts.kind)) next.kind = opts.kind;
      if (!Number.isFinite(Number(next.occurredAt)) && Number(opts.occurredAt) > 0) next.occurredAt = Number(opts.occurredAt);
      /** 显式指令重提仍是指令（不会因为再提一次就降级成普通事实） */
      if (opts.directive === true) next.directive = true;
      /**
       * 重提＝一次 reinforce 证据。调用方给了 `opts.evidence`（出处摘要）才累计；
       * 老调用点不传，行为与字节都不变。跨级顶替护栏不受影响——证据只动
       * confidence，不动 status（`canSupersede` 仍在 supersede() 里守）。
       */
      if (opts.evidence) {
        writeEvidence(next, applyEvidence(old, 'reinforce', opts.evidence));
        /**
         * B1 自动升档：证据够了就往深一级走（short→long→core）。
         * 只在真有证据写进来时判——老调用点不传 evidence，这一行不执行，
         * 行为与字节都不变；也不会出现"被注入就升档"的加冕。
         */
        const grown = growTier(next);
        if (grown !== (FACT_TIERS.includes(next.tier) ? next.tier : 'long')) next.tier = grown;
      }
      /** fact 是默认值，不落盘——老库、普通事实的字节与升级前完全一致 */
      if (next.status === 'fact') delete next.status;
      metaMap[f] = next;
      supersede();
      return list;
    }

    list.push(f);
    /** 面板「加一颗」可以直接给重要度与层级（可选；老调用方不传，行为不变） */
    const fresh = {
      w: Number(opts.w) > 0 ? Number(opts.w) : 1, at: t, src,
      ...(opts.pin !== undefined ? { pin: clamp01(opts.pin) } : {}),
      ...(FACT_TIERS.includes(opts.tier) ? { tier: opts.tier } : {}),
      ...(nextStatus && nextStatus !== 'fact' ? { status: nextStatus } : {}),
      /** 双时态：只在调用方明确给时才落盘，老调用方字节不变 */
      ...(FACT_KINDS.includes(opts.kind) && opts.kind !== 'world' ? { kind: opts.kind } : {}),
      ...(Number(opts.occurredAt) > 0 ? { occurredAt: Number(opts.occurredAt) } : {}),
      /** E1 显式指令："记住不要做X"当硬规则注入，不混在普通事实里被淘汰 */
      ...(opts.directive === true ? { directive: true } : {}),
    };
    /** 新建就带出处＝第一条证据；老调用点不传 evidence，这一行是空操作 */
    if (opts.evidence) writeEvidence(fresh, applyEvidence({}, 'reinforce', opts.evidence));
    metaMap[f] = fresh;
    supersede();

    /**
     * 容量（面板「记忆库」可调）。
     *
     * `total` 是总条数上限（默认还是 40，与升级前一致）；
     * `perTier` 是每层额外配额（short/long/core），0 或不填 = 不限。
     * 先按层裁超额的，再按总数裁——这样「临时」那层不会把长期的全挤掉。
     */
    let cap = {};
    try { cap = capacityOf?.() || {}; } catch { cap = {}; }
    const total = Number(cap.total) > 0 ? Math.max(1, Math.floor(Number(cap.total))) : FACTS_MAX;
    const perTier = cap.perTier && typeof cap.perTier === 'object' ? cap.perTier : {};
    let kept = list;
    for (const [tier, quota] of Object.entries(perTier)) {
      const q = Math.floor(Number(quota)) || 0;
      if (q <= 0) continue;
      const inTier = kept.filter((x) => (FACT_TIERS.includes(metaMap[x]?.tier) ? metaMap[x].tier : 'long') === tier);
      if (inTier.length <= q) continue;
      const ranked = inTier
        .map((x, i) => ({ x, i, s: scoreOfFact(metaMap[x], t) }))
        .sort((a, b) => b.s - a.s || b.i - a.i);
      const drop = new Set(ranked.slice(q).map((r) => r.x));
      for (const x of drop) delete metaMap[x];
      kept = kept.filter((x) => !drop.has(x));
    }
    if (kept.length <= total) return kept;

    /**
     * 超了：按分数留前 40 条，同分时**新的优先**。
     *
     * 同分新的优先，是为了让没有元数据的老库表现跟以前（FIFO）一模一样——
     * 升级不该顺手把人家存了很久的事换一批。
     */
    const scored = kept
      .map((text, i) => ({ text, i, s: scoreOfFact(metaMap[text], t) }))
      .sort((a, b) => b.s - a.s || b.i - a.i);
    const keep = new Set(scored.slice(0, total).map((x) => x.text));
    for (const text of kept) if (!keep.has(text)) delete metaMap[text];
    return kept.filter((text) => keep.has(text));
  }

  /**
   * D11 retention：按 (scope, chatId, 正文) 精确定位一条事实。
   *
   * 不复用 `supersede()` / `remove()`：前者按关键词 `includes` 找、命中多条
   * 就「不猜」返回失败，拿完整正文当 needle 还会误伤「约定：A」与「约定：A 补充」；
   * 后者是关键词抹除，两个后端都按覆盖率删，同样会误伤。dry-run 已经算出
   * 精确的三元组，这里只认完全相等。
   */
  function locateFact(m, it) {
    const scope = String(it?.scope || 'global');
    const chatId = String(it?.chatId || '');
    const text = String(it?.text ?? it?.id ?? '');
    if (!text) return null;
    if (scope === 'chat') {
      if (!chatId) return null;
      const list = m.chats?.[chatId];
      const mm = m.meta.chats?.[chatId];
      if (!Array.isArray(list) || !mm || !list.includes(text)) return null;
      return { list, mm, text };
    }
    if (!Array.isArray(m.global) || !m.global.includes(text)) return null;
    return { list: m.global, mm: m.meta.global, text };
  }

  return {
    /**
     * 丢掉内存缓存，下次读盘重来。
     *
     * 「一键改写 / 一键回退」会直接覆盖 `memory.json`。不清缓存的话，
     * 下一次 `save()` 会把内存里那份旧数据原样写回去，把刚恢复的文件又盖掉——
     * 用户点了「回退」，看起来成功了，一刷新数据还是改写后的。
     */
    reload() {
      cache = null;
      /**
       * 也要清掉读失败标记：`reload()` 就是「请重新读一次盘」的显式请求
       * （一键改写 / 一键回退之后必调）。不清的话，之前一次瞬时读故障会让
       * 后面所有 `save()` 继续被拒——用户点了回退，看着成功，实际没落盘。
       */
      ioFailed = false;
    },

    /**
     * 读两层（正文）。签名不变——注入路径和面板都按字符串用。
     *
     * **只返回活的**：被取代的说法（`meta.until` 有值）不进这里。
     * 默认安全优先 —— 谁拿 `list()` 去拼提示词都不会把历史说法带进去。
     * 要看历史的用 `listFull()`。
     *
     * `aliases` 是这个会话的备用键（号码 + 该号码名下的所有 openid）。
     * 换机器人之后旧事实在旧键下面，靠它才读得到；不传就是老行为。
     */
    list(chatId, aliases = []) {
      const m = load();
      const c = collectChat(m, chatId, aliases);
      const alive = (arr, mm) =>
        (Array.isArray(arr) ? arr : []).filter((text) => !mm?.[text]?.until && !mm?.[text]?.archivedAt);
      return {
        global: alive(m.global, m.meta.global),
        chat: alive(c.list, c.meta),
      };
    },

    /**
     * 按「重要度 × 时间衰减」排序的正文，**注入用这个**。
     *
     * 为什么不能再用 `list().slice(-N)`：数组是插入序，取尾部等于取
     * "最近记的"，跟权重毫无关系。一条被反复强调（w=5）的事只要最近
     * 没人再提，就永久沉在数组前段——平时那 6 个名额永远轮不到它，
     * 只有每 15 轮的 deep 才可能露一次。权重于是只服务于淘汰，
     * "记得牢"的那半根本没接上。
     *
     * 排序键和 `addInto` 的淘汰排序**必须一致**（`b.s - a.s || b.i - a.i`）：
     * 否则"留得下"和"看得见"是两套口径，会出现"它还在库里，但你永远
     * 看不到它"这种最难查的状态。
     *
     * 深度重注（deep）也用这个顺序，但**不截断**：全量照给，只是让
     * `fitBudget` 万一要砍时，砍掉的是分数低的尾巴而不是最新的几条。
     *
     * 历史（`until`）不参与排序：它不注入，排进来只会白占名额。
     * `guess`（猜的）同理不注入。
     *
     * @param {{annotate?:boolean}} [opts] `annotate:true` 时给 `hearsay` 加「（听说的）」后缀，
     *   只在拼提示词时用；其它调用方要原文
     */
    listRanked(chatId, aliases = [], opts = {}) {
      const annotate = opts?.annotate === true;
      const m = load();
      const t = now();
      /**
       * 从别名键读来的事实用 `scoreOfAliasFact`：衰减最多打一次对折。
       *
       * 完全按天数衰减，90 天前的老事只剩 0.125，`slice(0, 3)` 永远轮不到；
       * 完全不衰减，又会以浮点误差赢过刚说的话。所以给下限，不给奖励。
       *
       * 排序三层：
       *   1. 分数高的先
       *   2. **同分时当前键优先**——这一层必须显式写，不能靠下标：
       *      下标是插入序，别名的下标更大，`b.i - a.i` 会让别名反赢
       *   3. 同一组里同分新的优先（老行为，升级不该换一批）
       */
      const rank = (list, mm, noDecay) =>
        (Array.isArray(list) ? list : [])
          /**
           * `guess`（模型猜的）不参与注入，但**留在库里**给面板看。
           *
           * 这里必须是**黑名单**（`!== 'guess'`），不能写白名单（`=== 'fact'`）：
           * 老库一条 status 都没有，白名单会把它们一次性全滤掉——升级即失忆。
           */
          .filter((text) => !mm?.[text]?.until && !mm?.[text]?.archivedAt
            && statusOf(mm?.[text]) !== 'guess')
          .map((text, i) => {
            const meta = mm?.[text];
            const alias = Boolean(noDecay?.has(text));
            const s = alias ? scoreOfAliasFact(meta, t) : scoreOfFact(meta, t);
            return { text, i, s, alias, st: statusOf(meta) };
          })
          .sort((a, b) => b.s - a.s || (a.alias === b.alias ? b.i - a.i : a.alias ? 1 : -1))
          /**
           * 「（听说的）」是**可选**的渲染标注，默认不加：
           * `listRanked` 还被扩展读接口和巩固的对照清单用着，那些地方要的是原文。
           * 只有真正拼进提示词的 `memoryStatic` 才传 `annotate: true`。
           */
          .map((x) => (annotate && x.st === 'hearsay' ? `${x.text}（听说的）` : x.text));
      const c = collectChat(m, chatId, aliases);
      return {
        global: rank(m.global, m.meta.global, null),
        chat: rank(c.list, c.meta, c.fromAlias),
      };
    },

    /**
     * 带权重、出处和**历史**的版本（面板、调试用）。
     *
     * 单独开一个方法而不是让 `list()` 返回对象：`list()` 有四处调用点，
     * 全都要跟着改的话，漏一处就是「注入里出现 `[object Object]`」。
     *
     * `until` 有值 = 这条被后来的说法取代了，仍然留着但不注入。
     */
    listFull(chatId, aliases = []) {
      const m = load();
      const one = (list, mm) =>
        (Array.isArray(list) ? list : []).map((text) => {
          const x = mm?.[text] || {};
          return {
            text,
            id: factIdOf(text),
            w: Number(x.w) > 0 ? Number(x.w) : 1,
            at: Number(x.at) || 0,
            src: x.src || null,
            until: Number(x.until) > 0 ? Number(x.until) : null,
            /**
             * 可信度：面板据此标「听说的 / 猜的」。
             * 老数据没有这个字段，`statusOf` 一律给 `fact`——不写回磁盘。
             * `speaker` 从出处里取，只作展示/以后重判用，不参与打分。
             */
            status: statusOf(x),
            speaker: String(x.src?.speaker ?? ''),
            /** 以下都是可选扩展字段，老库没有时给默认，不写回磁盘 */
            tier: FACT_TIERS.includes(x.tier) ? x.tier : 'long',
            /** A2 双时态：种类 + 事发时间（缺省回退到 at，老库表现不变） */
            kind: kindOf(x),
            occurredAt: occurredOf(x, Number(x.at) || 0),
            /** E1 显式指令：面板/注入都要认得出 */
            directive: x.directive === true,
            pin: clamp01(x.pin),
            archivedAt: Number(x.archivedAt) > 0 ? Number(x.archivedAt) : null,
            reviewedAt: Number(x.reviewedAt) > 0 ? Number(x.reviewedAt) : null,
            brightness: brightnessOf(x, Date.now()),
            /** 证据账本：老库给默认（0 条 / 满信念），不写回盘 */
            ...evidenceOf(x),
            /** 趋势是算出来的（对标 Hindsight 的 computed_field），不存在盘上 */
            trend: trendOf(evidenceOf(x).evidence),
          };
        });
      const c = collectChat(m, chatId, aliases);
      return {
        global: one(m.global, m.meta.global),
        chat: one(c.list, c.meta),
      };
    },

    /**
     * 给一条已存在的记忆记一次证据判定（显式入口，供巩固 / 未来的 decide 模型用）。
     *
     * 为什么单独开方法而不是塞进 `add()`：`weaken` / `contradict` 要改的是
     * **已有**信念的置信度，不是新记一条事实。走 `add()` 会触发 supersede/
     * 容量淘汰那一整套，语义不对。这里只按 (scope,chatId,正文) 精确定位一条，
     * 改证据字段，不动 w / status / until。
     *
     * 同样守跨级护栏的定位口径：只认完全相等，不猜、不模糊匹配（同 locateFact）。
     *
     * @returns {{ok:boolean, why?:string, confidence?:number, proofs?:number}}
     */
    recordEvidence(chatId, text, relation, evidence = null, scope = 'global') {
      const m = load();
      const hit = locateFact(m, { scope, chatId, text });
      if (!hit) return { ok: false, why: 'not_found' };
      if (!EVIDENCE_RELATIONS.includes(relation)) return { ok: false, why: 'bad_relation' };
      const next = applyEvidence(hit.mm[hit.text], relation, evidence);
      writeEvidence(hit.mm[hit.text], next);
      /** B1：巩固证据够了也升档（同一口径，不只在 add 路径生效） */
      const target = hit.mm[hit.text];
      const grown = growTier(target);
      if (grown !== (FACT_TIERS.includes(target.tier) ? target.tier : 'long')) target.tier = grown;
      save();
      return { ok: true, confidence: next.confidence, proofs: next.proofs };
    },

    /**
     * 记一条。
     *
     * @param {'global'|'chat'} scope 默认 global —— 用户说"记住 XX"多半是关于他自己
     * @param {{w?:number, status?:'fact'|'hearsay'|'guess', src?:{journalId?:string, eventIds?:string[], speaker?:string, at?:number}, at?:number, evidence?:{kind?:string,detail?:string,at?:number}}} [opts]
     *   `status` 不传 = `fact`（手记、`<<remember>>`、老调用点都是这一档）
     *   `evidence` 传了才累计证据账本（重提=reinforce），老调用点不传行为不变
     */
    add(chatId, fact, scope = 'global', opts = {}) {
      const m = load();
      if (scope === 'chat') {
        if (!chatId) return false;
        const cur = Array.isArray(m.chats[chatId]) ? m.chats[chatId] : [];
        const mm = (m.meta.chats[chatId] = m.meta.chats[chatId] || {});
        m.chats[chatId] = addInto(cur, mm, fact, opts);
      } else {
        m.global = addInto(m.global, m.meta.global, fact, opts);
      }
      /**
       * **把落盘结果如实回给调用方**（2026-11 复核）。
       *
       * `save()` 在读盘失败（`ioFailed`）或写不进去时返回 false。以前这里
       * 无条件 `return true`：工具回「记住了」、面板回 `ok:true`，可 5 秒后
       * 重读成功时 `cache` 会被盘上内容整体替换——那条事实**内存和磁盘都没了**，
       * 而模型以为记住了。
       */
      return save();
    },

    /**
     * 这里原本有个 `touch()`：注入进提示词、这一轮又确实回了话，就给
     * 这条事实 +0.5 权重。**故意删掉的，别加回来。**
     *
     * 两个理由：
     *   1. 它从写下来那天起就**没有任何生产调用点**（只有测试调过），
     *      注释却写得像在生效 —— 比没有这个方法更误导。
     *   2. 语义现在是错的。`listRanked` 让"被注入"直接影响"下次还注不注"，
     *      再叠一层"被注入就加分"，就是注入即加冕：越常被注入的越容易被
     *      注入，列表冻结，再也换不出一批新的。
     *
     * 同一个坑在日记那边踩过并锁死了：`journal.js` 的 `accessed`
     * **只由检索写入，自动注入不算**，`test/memory.test.js` 有断言。
     * facts 走同一条结论 —— **自己读到、自己整理，不强化**。
     */

    /**
     * 把「旧说法」标记为已被取代（打 `until`），**不删除**。
     *
     * 和 `remove` 的区别：remove 是「这件事不许存在」（连日记一起抹），
     * supersede 是「这件事过时了」——面板还看得见历史，注入只取活的。
     *
     * 为什么需要它：`addInto` 里的同槽位取代只认**字面相似**（0.75），
     * 抓不到「住在杭州」→「搬到上海」这种语义改口。那条路径上模型给不了
     * 帮助（它不知道哪条旧的），所以给一个**显式**入口：
     * 模型说「改成 X，旧的用 Y 找」，这里按 Y 去定位。
     *
     * 定位规则：
     *   · 只搜**活着的**（已经有 `until` 的不再参与，避免连环替换）
     *   · 命中 0 条 → 不猜，返回失败让调用方决定（通常是"只记新的"）
     *   · 命中多条 → 也不猜，把候选带回去；猜错等于关掉一条无关的记忆
     *
     * @param {string} chatId
     * @param {string} needle 旧说法里的片段
     * @param {{at?:number}} [opts]
     * @returns {{ok:boolean, text?:string, scope?:string, why?:string, candidates?:string[]}}
     */
    supersede(chatId, needle, opts = {}) {
      const w = String(needle ?? '').trim();
      if (!w) return { ok: false, why: '要替换的旧说法不能为空' };
      const m = load();
      const at = Number(opts.at) > 0 ? Number(opts.at) : now();

      const pools = [{ scope: 'global', list: m.global, mm: m.meta.global }];
      if (chatId && m.chats?.[chatId]) {
        m.meta.chats[chatId] = m.meta.chats[chatId] || {};
        pools.push({ scope: 'chat', list: m.chats[chatId], mm: m.meta.chats[chatId] });
      }

      const hits = [];
      for (const p of pools) {
        for (const text of Array.isArray(p.list) ? p.list : []) {
          if (p.mm?.[text]?.until) continue;
          if (String(text).includes(w)) hits.push({ scope: p.scope, text, mm: p.mm });
        }
      }

      if (!hits.length) return { ok: false, why: `没找到包含「${w}」的活事实`, candidates: [] };
      if (hits.length > 1) {
        return {
          ok: false,
          why: `「${w}」匹配到 ${hits.length} 条，说具体一点`,
          candidates: hits.map((h) => h.text),
        };
      }

      const h = hits[0];
      /**
       * 跨级顶替护栏（和 `addInto` 里那条同一口径）。
       *
       * 约定更新是**唯一**会走到这里的自动化路径：巩固可能把一条"听说的"
       * 当成 update 递进来。放它过去，主人亲口说的事就被一句转述关掉了。
       * 拦下来时上层（`consolidate.js`）会退化成新增，不丢新信息。
       *
       * @param {{at?:number, status?:string}} [opts]
       */
      if (!canSupersede(opts.status, h.mm[h.text]?.status)) {
        const was = statusOf({ status: h.mm[h.text]?.status });
        return {
          ok: false,
          why: `「${h.text}」是${STATUS_LABEL[was]}，这次只有${STATUS_LABEL[statusOf({ status: opts.status })]}，不能顶掉它`,
          candidates: [h.text],
        };
      }
      h.mm[h.text] = { ...(h.mm[h.text] ?? {}), until: at };
      save();
      return { ok: true, text: h.text, scope: h.scope };
    },

    /**
     * 按关键词删，两层都搜；返回删掉几条。
     *
     * `aliases` 必须传：读的时候把别名键的事读出来了，删的时候只删当前键，
     * 就会出现「说了忘掉、下一条又想起来了」——用户会以为她故意装傻。
     */
    remove(chatId, word, aliases = []) {
      const w = String(word ?? '').trim();
      if (!w) return 0;
      const m = load();
      let n = 0;

      /** 删正文的同时删元数据 —— 不然再记一次同样的内容会"继承"旧权重 */
      const drop = (list, mm) => {
        const gone = list.filter((f) => f.includes(w));
        for (const f of gone) delete mm[f];
        return list.filter((f) => !f.includes(w));
      };

      const g0 = m.global.length;
      m.global = drop(m.global, m.meta.global);
      n += g0 - m.global.length;

      for (const k of chatId ? chatKeys(chatId, aliases) : []) {
        if (!Array.isArray(m.chats[k])) continue;
        const c0 = m.chats[k].length;
        m.chats[k] = drop(m.chats[k], (m.meta.chats[k] = m.meta.chats[k] || {}));
        n += c0 - m.chats[k].length;
      }
      if (n) save();
      return n;
    },

    /**
     * 清本群层，不动全局。
     *
     * 别名键一起清：「这个群忘了」是**对这个人/这个群**说的，
     * 不是对某个 openid 说的。留一半下来只会让下一条消息又想起来。
     */
    clearChat(chatId, aliases = []) {
      const m = load();
      let dirty = false;
      for (const k of chatId ? chatKeys(chatId, aliases) : []) {
        if (m.chats[k]) {
          delete m.chats[k];
          dirty = true;
        }
        if (m.meta.chats[k]) {
          delete m.meta.chats[k];
          dirty = true;
        }
      }
      if (dirty) save();
    },

    /** 清全局（等于让它忘掉所有跨群的事） */
    clearGlobal() {
      const m = load();
      m.global = [];
      m.meta.global = {};
      save();
    },

    /**
     * 编辑一条事实（唯一的写入口，供面板 /memory/fact 用）。
     *
     * 定位只认**完全相等**的正文或它派生出的 id，不做关键词模糊匹配 ——
     * D11 retention 那条踩过坑：用正文当 needle 去 `includes` 会误伤
     * 「约定：A」与「约定：A 补充」。
     *
     * `patch` 白名单：text / pin / tier / reviewedAt / archivedAt。
     * 改正文时把 meta 键一起搬过去（w、at、src、until、pin、tier
     * 一个不丢），否则编辑一次就把权重和出处洗掉了。
     */
    editFact(chatId, scope, key, patch = {}, aliases = []) {
      const m = load();
      const k = String(key ?? '').trim();
      if (!k) return { ok: false, message: '没给要改哪条事实' };
      const pairs = scope === 'global'
        ? [[m.global, m.meta.global, 'global']]
        : (chatId ? [chatId, ...(Array.isArray(aliases) ? aliases : [])] : [])
            .map((c) => [m.chats[c], m.meta.chats[c], c]);
      let hit = null;
      for (const [list, mm, c] of pairs) {
        if (!Array.isArray(list) || !mm) continue;
        const text = list.find((t) => t === k || factIdOf(t) === k);
        if (text) { hit = { list, mm, text, chatId: c }; break; }
      }
      if (!hit) return { ok: false, message: '没找到这条事实（可能已删或换了会话）' };
      const { list, mm, text } = hit;
      let nextText = text;
      if (patch.text !== undefined) {
        nextText = String(patch.text ?? '').trim();
        if (!nextText) return { ok: false, message: '内容不能为空' };
        if (nextText !== text && list.includes(nextText)) return { ok: false, message: '已经有一模一样的一句了' };
      }
      if (patch.tier !== undefined && !FACT_TIERS.includes(patch.tier)) {
        return { ok: false, message: '层级只能是 short / long / core' };
      }
      const meta = { ...(mm[text] || {}) };
      if (patch.pin !== undefined) meta.pin = clamp01(patch.pin);
      if (patch.tier !== undefined) meta.tier = patch.tier;
      if (patch.reviewedAt !== undefined) {
        meta.reviewedAt = Number(patch.reviewedAt) > 0 ? Number(patch.reviewedAt) : Date.now();
      }
      if (patch.archivedAt !== undefined) {
        const v = Number(patch.archivedAt);
        if (v > 0) meta.archivedAt = v;
        else delete meta.archivedAt;
      }
      if (nextText !== text) {
        list[list.indexOf(text)] = nextText;
        delete mm[text];
        mm[nextText] = meta;
      } else {
        mm[text] = meta;
      }
      save();
      return {
        ok: true, text: nextText, id: factIdOf(nextText),
        tier: meta.tier || 'long', pin: meta.pin || 0,
        archivedAt: meta.archivedAt || null,
        brightness: brightnessOf(meta),
      };
    },

    /**
     * 这个群的人设覆盖（没有就返回空串，回落到 personas/*.md）。
     *
     * 别名键也看：换机器人之后如果只在旧键下指定过人格，不带别名就会
     * 「群里突然变回默认人格」——用户完全不知道是自己换机器人换出来的。
     */
    getPersonaOverride(chatId, aliases = []) {
      if (!chatId) return '';
      const m = load();
      for (const k of chatKeys(chatId, aliases)) {
        const t = String(m.personas?.[k]?.text ?? '');
        if (t) return t;
      }
      return '';
    },

    /** 设/清这个群的人设覆盖。传空串就是清掉。 */
    setPersonaOverride(chatId, text) {
      if (!chatId) return;
      const m = load();
      const t = String(text ?? '').trim().slice(0, 500);
      if (!t) delete m.personas[chatId];
      else m.personas[chatId] = { text: t, at: Date.now() };
      save();
    },

    /**
     * 记一条授权（`c2c_push` / `group_push`）。
     *
     * 为什么要记：**群主动消息必须有 `group_push` 授权**，
     * 这是比限频更根本的前置。没这条记录，C7 群聊主动一发就失败。
     */
    setAuthz(chatId, scope, extra = {}) {
      if (!chatId || !scope) return;
      const m = load();
      if (!m.authz || typeof m.authz !== 'object') m.authz = {};
      m.authz[chatId] = { scope, at: Date.now(), ...extra };
      save();
    },

    /**
     * 查这个会话有没有某个授权。
     *
     * 别名键任一有就算有。不这么做的后果很具体：旧机器人时期群授权过
     * `group_push`，换机器人后 chatId 变了 → 恒 false → **这个群永久不主动说话**，
     * 而面板上看不出任何异常。迁移页特意把「只授权过、一句话没记」的键
     * 也列出来让人绑，就是为这一步铺路——绑完这里还读不到，那页就白做了。
     */
    hasAuthz(chatId, scope, aliases = []) {
      const m = load();
      for (const k of chatKeys(chatId, aliases)) {
        const a = m.authz?.[k];
        if (a && (!scope || a.scope === scope)) return true;
      }
      return false;
    },

    /**
     * 这个会话的授权记录，给面板看。
     *
     * 以前只有 `hasAuthz` 这种问句形式，面板拿不到「是什么授权、什么时候给的」，
     * 于是群主动搭话的门槛在界面上完全看不见——用户只知道「群里她不说话」。
     */
    authz(chatId) {
      const m = load();
      const a = chatId ? m.authz?.[chatId] : null;
      if (!a) return null;
      return { scope: String(a.scope || ''), at: Number(a.at || 0), type: a.type, optScene: a.optScene };
    },

    /**
     * 把这份文件里出现过的**所有会话键**列出来（「账号迁移」页扫描用）。
     *
     * 扫四个地方，不是只扫 `chats`：
     *   · `chats`       —— 事实正文
     *   · `meta.chats`  —— 只有元数据、正文被清空过的残留
     *   · `personas`    —— 按群的人设覆盖
     *   · `authz`       —— 主动消息授权
     *
     * 后两个经常是**唯一**留痕的地方：一个群可能只授权过、一句话没记，
     * 只扫 `chats` 就会漏掉它，换机器人之后那条授权再也对不上，
     * 表现是「群里她突然不主动说话了」——很难归因。
     *
     * 只读，不改文件。
     */
    scanKeys() {
      const m = load();
      const out = new Map();
      const touch = (k) => {
        const key = String(k || '');
        if (!key) return;
        if (!out.has(key)) out.set(key, 0);
      };
      for (const [k, v] of Object.entries(m.chats || {})) {
        touch(k);
        out.set(k, out.get(k) + (Array.isArray(v) ? v.length : 0));
      }
      for (const k of Object.keys(m.meta?.chats || {})) touch(k);
      for (const k of Object.keys(m.personas || {})) touch(k);
      for (const k of Object.keys(m.authz || {})) touch(k);
      return [...out].map(([chatId, facts]) => ({ chatId, facts }));
    },

    /**
     * 从旧版本（记忆还放在 ai-chat 时）导入。
     * 幂等：重复导入不会产生重复条目（addInto 会去重）。
     */
    import({ global: g = [], chats = {} } = {}) {
      const m = load();
      let n = 0;
      for (const f of Array.isArray(g) ? g : []) {
        const before = m.global.length;
        m.global = addInto(m.global, m.meta.global, f);
        if (m.global.length > before) n += 1;
      }
      for (const [cid, list] of Object.entries(chats ?? {})) {
        if (!cid || !Array.isArray(list)) continue;
        const cur = Array.isArray(m.chats[cid]) ? m.chats[cid] : [];
        const mm = (m.meta.chats[cid] = m.meta.chats[cid] || {});
        for (const f of list) {
          const before = cur.length;
          const next = addInto(cur, mm, f);
          if (next.length > before) n += 1;
          m.chats[cid] = next;
        }
      }
      save();
      return n;
    },

    /**
     * D11 retention 专用接口（阶段 4c）。
     *
     * 作废复用现成的 `until`（注入只取活条目），另加 `expiredBy='retention'`
     * 标明来源：恢复时只清自己打过的，不能把「被新说法取代」的历史也放回来。
     * 所有方法**只在真有改动时才 save()**——默认状态下不写盘，这是
     * §3⑤「默认关输出逐字节一致」的一部分。
     */
    retention: {
      /** 全库条目（含已作废的），给 dry-run 收集用。只读 */
      entries() {
        const m = load();
        const out = [];
        const push = (scope, chatId, list, mm) => {
          for (const text of Array.isArray(list) ? list : []) {
            const x = mm?.[text] || {};
            out.push({
              id: text,
              text,
              scope,
              chatId,
              at: Number(x.at) || 0,
              w: Number(x.w) > 0 ? Number(x.w) : 1,
              src: x.src || null,
              until: Number(x.until) > 0 ? Number(x.until) : 0,
              expiredBy: String(x.expiredBy || ''),
              /**
               * 下面这几个字段**必须一起导出**，否则「清理 → 后悔 → 还原」
               * 会把它们全丢掉：`insertRaw()` 只重建它认识的那几个键。
               * 丢了 `status` 的后果最直接——一条「听说的」还原回来变成
               * 「本人说的」，注入时不再带后缀，还挡得住同级取代。
               */
              status: statusOf(x),
              tier: FACT_TIERS.includes(x.tier) ? x.tier : 'long',
              /** A2 双时态：同 status 的教训——不导出，清理→还原就把它们抹掉 */
              kind: kindOf(x),
              occurredAt: occurredOf(x, Number(x.at) || 0),
              directive: x.directive === true,
              pin: clamp01(x.pin),
              reviewedAt: Number(x.reviewedAt) > 0 ? Number(x.reviewedAt) : 0,
              archivedAt: Number(x.archivedAt) > 0 ? Number(x.archivedAt) : 0,
              /** 证据账本三个字段：漏一个，清理→还原就把证据抹掉（同 status 的教训） */
              ...evidenceOf(x),
            });
          }
        };
        push('global', '', m.global, m.meta.global);
        for (const [cid, list] of Object.entries(m.chats || {})) {
          push('chat', cid, list, m.meta.chats?.[cid]);
        }
        return out;
      },

      /** 作废：打 until，不删行。返回实际作废条数 */
      expire(items, at = now()) {
        const m = load();
        const t = Number(at) > 0 ? Number(at) : now();
        let n = 0;
        for (const it of Array.isArray(items) ? items : []) {
          const hit = locateFact(m, it);
          if (!hit || hit.mm[hit.text]?.until) continue;
          hit.mm[hit.text] = { ...(hit.mm[hit.text] || {}), until: t, expiredBy: 'retention' };
          n += 1;
        }
        if (n) save();
        return n;
      },

      /** 恢复：只清本功能打过的标记。items 为空 = 全部恢复 */
      restore(items) {
        const m = load();
        const want = Array.isArray(items) && items.length
          ? new Set(items.map((x) => JSON.stringify([
            String(x.scope || 'global'), String(x.chatId || ''), String(x.text ?? x.id ?? ''),
          ])))
          : null;
        let n = 0;
        const each = (scope, chatId, list, mm) => {
          for (const text of Array.isArray(list) ? list : []) {
            const x = mm?.[text];
            if (!x || x.expiredBy !== 'retention' || !x.until) continue;
            if (want && !want.has(JSON.stringify([scope, chatId, text]))) continue;
            const next = { ...x };
            delete next.until;
            delete next.expiredBy;
            mm[text] = next;
            n += 1;
          }
        };
        each('global', '', m.global, m.meta.global);
        for (const [cid, list] of Object.entries(m.chats || {})) {
          each('chat', cid, list, m.meta.chats?.[cid]);
        }
        if (n) save();
        return n;
      },

      /** 真删行（purge）：调用方必须先备份。返回实际删掉条数 */
      purge(items) {
        const m = load();
        let n = 0;
        for (const it of Array.isArray(items) ? items : []) {
          const hit = locateFact(m, it);
          if (!hit) continue;
          const idx = hit.list.indexOf(hit.text);
          if (idx < 0) continue;
          hit.list.splice(idx, 1);
          delete hit.mm[hit.text];
          n += 1;
        }
        if (n) save();
        return n;
      },

      /** 面板「已过期」：本功能作废过的条目 */
      expired() {
        return this.entries().filter((e) => e.expiredBy === 'retention' && e.until > 0);
      },
    },

    /**
     * E4 / D11 备份还原：**原样插回**一条事实。
     *
     * 绝对不能走 `add()`：它会先跑 `addInto()` 的 `supersede()`，字面相似度
     * 过 0.75 就给别的活事实打 `until` —— 还原一条旧事实会顺手作废另一条
     * 无关的（交接 §3③）。这里直接写回 `list` + `meta`，保留 `w/at/src/until`
     * 与作废来源。按 `(scope, chatId, 正文)` 判重，重复还原不产生第二行。
     */
    insertRaw(row) {
      const m = load();
      const scope = row?.scope === 'chat' ? 'chat' : 'global';
      const cid = String(row?.chatId || '');
      const text = String(row?.text ?? '');
      if (!text) return false;
      const list = scope === 'global' ? m.global : (m.chats[cid] || (m.chats[cid] = []));
      const mm = scope === 'global' ? m.meta.global : (m.meta.chats[cid] || (m.meta.chats[cid] = {}));
      if (list.includes(text)) return false;
      const meta = { w: Number(row.w) || 1, at: Number(row.at) || 0 };
      if (row.src != null) meta.src = row.src;
      if (Number(row.until) > 0) meta.until = Number(row.until);
      if (row.expiredBy) meta.expiredBy = String(row.expiredBy);
      /**
       * 原样插回**必须带上这几个**。`insertRaw` 是 retention 还原的落点，
       * 它不经过 `addInto`，字段少一个就静默退回默认值——最刺眼的是
       * `status`：「听说的」还原成「本人说的」，面板上没有任何痕迹。
       * 默认值照 `addInto` 的口径不落盘（fact / long / 0），
       * 这样老库还原回来仍是逐字节一样的文件。
       */
      if (FACT_STATUSES.includes(row.status) && row.status !== 'fact') meta.status = row.status;
      if (FACT_TIERS.includes(row.tier) && row.tier !== 'long') meta.tier = row.tier;
      /** A2 双时态：默认 world / 无 occurredAt 不落盘，老库还原逐字节一致 */
      if (FACT_KINDS.includes(row.kind) && row.kind !== 'world') meta.kind = row.kind;
      if (Number(row.occurredAt) > 0) meta.occurredAt = Number(row.occurredAt);
      if (row.directive === true) meta.directive = true;
      if (Number(row.pin) > 0) meta.pin = clamp01(row.pin);
      if (Number(row.reviewedAt) > 0) meta.reviewedAt = Number(row.reviewedAt);
      if (Number(row.archivedAt) > 0) meta.archivedAt = Number(row.archivedAt);
      /** 证据账本：默认值不落盘，还原后与升级前的老库逐字节一致 */
      writeEvidence(meta, evidenceOf(row));
      list.push(text);
      mm[text] = meta;
      /** 同 `add()`：还原进内存但没落盘，要如实回 false（备份还原靠它判断） */
      return save();
    },
  };
}
