/**
 * 重排候选（Reranker）——对齐 aurabot 记忆页的「重排候选（可选）」。
 *
 * ## 为什么要重排
 *
 * 召回是 RRF 名次融合：哪一路排前面就算赢，但它**不知道这句话跟内容到底
 * 有多贴**。典型翻车是「短句 + 同一个人名」：三路各推一条，融合后的第一名
 * 可能只是恰好在那一路排第一。
 *
 * 重排就是拿 query 和候选正文再算一次相关性，按「原名次 + 相关性」混排。
 *
 * ## 两种模式（有向量优先）
 *
 *   · vector：配置了 embedding 就用余弦相似度（语义级，能认出「搬家」≈「换住处」）
 *   · rule  ：没配向量就退化成确定性规则——字符二元组命中率 + 时间新鲜度
 *
 * 规则模式**不调模型**，所以它是可测的、每轮零成本的；但它只看字面，
 * 语义改口抓不到。面板上要写清楚这个区别，不能让人以为「开了就是语义重排」。
 *
 * ## 默认关
 *
 * 重排会改变注入顺序，等于改变她「先想起什么」。默认关着，
 * 升级前后召回结果逐字一致。
 */

const DAY_MS = 86_400_000;

export const RERANK_DEFAULTS = Object.freeze({
  enabled: false,
  /** 相关性在最终分里占多少；剩下给原名次 */
  weight: 0.6,
  /** 配了向量就用向量，配了但算不出来会回落规则 */
  useVector: true,
});

/** 字符二元组（与 memory.js 的 bigramsOf 同一套思路，避免两处口径不一致） */
function bigramsOf(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

/** query 的二元组有多少比例出现在正文里（0–1） */
export function keywordScore(query, text) {
  const q = bigramsOf(query);
  if (!q.size) return 0;
  const t = bigramsOf(text);
  if (!t.size) return 0;
  let hit = 0;
  for (const g of q) if (t.has(g)) hit += 1;
  return hit / q.size;
}

/** 时间新鲜度：今天 1，7 天前 0.5，30 天前 ~0.19 */
export function freshness(at, now = Date.now()) {
  const t = Number(at) || 0;
  if (!t) return 0.3;
  const days = Math.max(0, (now - t) / DAY_MS);
  return 1 / (1 + days / 7);
}

const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
};

/** 按「原名次 + 相关性」混排；同分保留原顺序（稳定） */
function mix(hits, rel, weight) {
  const w = Math.max(0, Math.min(1, Number(weight) || 0));
  return hits
    .map((h, i) => ({
      h, i,
      final: (1 - w) * (1 / (i + 1)) + w * (Number(rel[i]) || 0),
    }))
    .sort((a, b) => b.final - a.final || a.i - b.i)
    .map((x) => x.h);
}

/**
 * 规则重排（纯函数，导出给测试）。
 * @param {string} query
 * @param {Array<{text?:string,digest?:string,at?:number}>} hits
 */
export function ruleRerank(query, hits, { now = Date.now(), weight = RERANK_DEFAULTS.weight } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length < 2) return list.slice();
  /** 没有检索词就没有相关性信号，别拿新鲜度瞎排（那会变成按时间重排） */
  if (!String(query ?? '').trim()) return list.slice();
  const rel = list.map((h) => {
    const text = String(h?.text ?? h?.digest ?? '');
    /** 关键词占七成、新鲜度三成：宁可按内容相关，也不要把旧的全压下去 */
    return 0.7 * keywordScore(query, text) + 0.3 * freshness(h?.at, now);
  });
  return mix(list, rel, weight);
}

/**
 * 向量重排。embedder 没配 / 算不出来返回 null，让调用方回落规则。
 * @param {{enabled?:Function, one?:Function, many?:Function}} embedder
 */
export async function vectorRerank(query, hits, { embedder, weight = RERANK_DEFAULTS.weight } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length < 2 || !embedder || typeof embedder.many !== 'function') return null;
  if (typeof embedder.enabled === 'function' && !embedder.enabled()) return null;
  const texts = list.map((h) => String(h?.text ?? h?.digest ?? '').slice(0, 800));
  const qv = await embedder.one(String(query ?? ''));
  if (!Array.isArray(qv) || !qv.length) return null;
  const vecs = await embedder.many(texts);
  if (!Array.isArray(vecs) || vecs.length !== texts.length) return null;
  const rel = vecs.map((v) => Math.max(0, cosine(qv, v)));
  return mix(list, rel, weight);
}

/**
 * 统一入口：关着就原样返回，开着按可用能力选模式。
 * @returns {{hits:Array, mode:'off'|'rule'|'vector'}}
 */
export async function rerankHits(query, hits, { cfg = {}, embedder = null, now = Date.now() } = {}) {
  const c = { ...RERANK_DEFAULTS, ...(cfg?.recall?.rerank || {}) };
  const list = Array.isArray(hits) ? hits : [];
  if (c.enabled !== true || list.length < 2) return { hits: list, mode: 'off' };
  if (c.useVector !== false) {
    try {
      const out = await vectorRerank(query, list, { embedder, weight: c.weight });
      if (out) return { hits: out, mode: 'vector' };
    } catch {
      /* 向量服务抖了就回落规则，别让召回整轮失败 */
    }
  }
  return { hits: ruleRerank(query, list, { now, weight: c.weight }), mode: 'rule' };
}
