/**
 * 历史说法 + 证据投影（阶段 3，只读）
 * ==========================================
 *
 * Hindsight 的 `/memories/{id}/history` 是**双时态快照序列**（valid_from /
 * valid_until），每条快照名正言顺地是"同一条记忆的上一版"。
 * 我们不一样：facts 是字符串数组，`supersede()` 只给旧条目的 meta 打
 * `until`，**没有指向新条目的指针**（核对结论，见归档方案 B1）。
 *
 * 所以这里不宣称"演变链"——那是撒谎。我们做的是：
 *   1. 按 `until` 找出被取代过的旧说法（真事实，板上钉钉）；
 *   2. 用与 `supersede()` **同一套判据**（相似度 + 非矛盾 + 时间相邻）
 *      把旧说法跟当前条目做**推断配对**，并明确标 `inferred: true`；
 *   3. 证据只做只读投影，不改存储、不新建 observation 实体
 *      （evidence 已经内嵌 quote/journalId，再建一份就是双份真相）。
 *
 * 核对补记：Hindsight 的 `ObservationEvidence{quote,relevance}` 是**死代码**
 * （全仓只有定义处引用），它线上 based_on 只有 id/text/type/context。
 * 我方的 quote 是巩固期真写进 evidence 的，属超出对方的能力——保留，
 * 但不宣称"对齐它的 observations 证据模型"。
 *
 * 纯函数：输入 listFull 的一层数组，输出可展示结构，不读文件、不碰 store。
 */

import { conflicting, similarityOf } from './memory.js';

/** 与 memory.js 的 SUPERSEDE_SIM 同值——配对判据必须跟写入侧一致 */
const PAIR_SIM = 0.75;
/** 配对的时间窗：supersede 时旧条目的 until = 新条目的 at，同一瞬间 */
const PAIR_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 历史最多投影几条，免得一个词把整个库都算成"相关" */
const HISTORY_LIMIT = 20;

/**
 * 证据投影：把一条事实内嵌的 evidence 映射成统一展示形状。
 *
 * 两种历史形态都要认：
 *   · 新：{quote, journalId, at, kind} —— 可核验引文
 *   · 老：{detail, at, kind}          —— 巩固期只留短摘要
 * 不编造 journalId：没有就是空串，面板据此不显示"回查原文"。
 */
export function projectEvidence(fact) {
  const raw = Array.isArray(fact?.evidence) ? fact.evidence : [];
  return raw
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      kind: String(e.kind ?? 'retain').slice(0, 24),
      quote: String(e.quote ?? e.detail ?? '').slice(0, 200),
      journalId: String(e.journalId ?? ''),
      at: Number(e.at) > 0 ? Number(e.at) : 0,
      /** 有 quote 才算"引文"；只有 detail 的是摘要，面板文案要分开 */
      hasQuote: typeof e.quote === 'string' && e.quote.length > 0,
    }))
    .filter((x) => x.quote);
}

/**
 * 按 id 或正文定位一条事实。跟 editFact/findFact 同口径（面板给的是 id）。
 */
function locate(rows, key) {
  const k = String(key ?? '').trim();
  if (!k) return null;
  return (Array.isArray(rows) ? rows : []).find((r) => r?.text === k || r?.id === k) || null;
}

/**
 * 推断"这条事实之前是怎么说的"。
 *
 * @param {Array} rows listFull(chatId, aliases)[scope] —— 一层事实（已带 until/evidence）
 * @param {string} key 事实 id 或正文
 * @param {{now?:number, limit?:number, windowMs?:number}} [opts]
 * @returns {{found:boolean, text:string, at:number, until:number|null,
 *            earlier:Array, evidence:Array, note:string}|null}
 *
 * `earlier` 每项：{text, id, until, at, evidence, similarity, inferred:true}
 *  —— 都是**真被取代过**的条目（until>0），相似度只是"大概率是它的上一版"，
 *     没有指针就不写死因果，UI 文案统一用"此前说法"。
 */
export function historyOf(rows, key, opts = {}) {
  const cur = locate(rows, key);
  if (!cur) return null;
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : PAIR_WINDOW_MS;
  const limit = Math.min(HISTORY_LIMIT, Math.max(1, Number(opts.limit) || HISTORY_LIMIT));
  /** 当前条目的锚点：活条目用它的 at（取代发生在这一刻）；历史条目用它的 until */
  const anchor = Number(cur.until) > 0 ? Number(cur.until) : Number(cur.at) || now;
  const text = String(cur.text ?? '');

  const earlier = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r !== cur && Number(r.until) > 0 && String(r.text ?? '') !== text)
    .map((r) => {
      const other = String(r.text ?? '');
      const sim = similarityOf(other, text);
      return { row: r, sim, gap: Math.abs(Number(r.until) - anchor) };
    })
    /** 同一批 supersede 的判据：相似 + 不矛盾；时间只是排序权重，不是硬门槛 */
    .filter((x) => x.sim >= PAIR_SIM && !conflicting(x.row.text, text))
    .sort((a, b) => (a.gap - b.gap) || (b.sim - a.sim))
    .slice(0, limit)
    .map(({ row, sim, gap }) => ({
      text: String(row.text ?? ''),
      id: String(row.id ?? ''),
      until: Number(row.until),
      at: Number(row.at) || 0,
      evidence: projectEvidence(row),
      trend: String(row.trend ?? ''),
      /** 时间落在配对窗内 = 同一轮取代的可能性更高；窗外也可能相关，只是弱 */
      adjacent: gap <= windowMs,
      similarity: Number(sim.toFixed(3)),
      inferred: true,
    }));

  return {
    found: true,
    text,
    id: String(cur.id ?? ''),
    at: Number(cur.at) || 0,
    until: Number(cur.until) > 0 ? Number(cur.until) : null,
    /** 当前条目的证据引文（只读投影，老库没有就是 []） */
    evidence: projectEvidence(cur),
    confidence: Number(cur.confidence ?? 1),
    proofs: Number(cur.proofs) || 0,
    trend: String(cur.trend ?? ''),
    earlier,
    note: earlier.length
      ? '此前说法按相似度与时间相邻推断（没有任何"谁取代谁"的指针），仅供核对，不等于因果演变链。'
      : '没有找到可推断的此前说法。',
  };
}

/**
 * 全层历史视图：把这一层所有被取代过的条目列出来（不配对、不推断）。
 * 给面板"历史"折叠区用——那是板上钉钉的事实，比推断配对更可信。
 */
export function listSuperseded(rows, opts = {}) {
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number(r.until) > 0)
    .slice()
    .sort((a, b) => Number(b.until) - Number(a.until))
    .slice(0, limit)
    .map((r) => ({
      text: String(r.text ?? ''),
      id: String(r.id ?? ''),
      until: Number(r.until),
      at: Number(r.at) || 0,
      evidence: projectEvidence(r),
      trend: String(r.trend ?? ''),
    }));
}
