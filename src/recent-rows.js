/**
 * 【刚才说到】的取数合并。
 *
 * 这块要同时满足两个要求，任何一个没做到都会在真机上看得见：
 *
 *   ① **条数要够**。`recall.recentLimit` 默认 8，指的是「应该给她 8 条」，
 *      不是「最多 8 条」。2026-11-25 实测：群里这一轮只缺 1 条，注入块就
 *      真的只有 1 条——模型看到一行「· 某某：【表情: 惊讶】」，根本不知道
 *      上下文是什么，「那个」「上面说的」全成了空指代。
 *
 *   ② **不许和本轮正文重复**。写日记在前（`host.js` 的 `journalAdd`）、
 *      拼注入在后（`memoryDynamic`），所以「日记最近 8 条」的第一条**永远**
 *      是本轮刚写进去的那句；合并批还有个更糟的：一次进来两条消息，日记只
 *      记到最后一条的 eventId，另一条被当成缺口又补一遍。
 *
 * 两条来源的分工：
 *   · `gap`（账本有、日记 eventIds 没有）——她真没见过的。**优先**，因为
 *     这部分模型上下文里确实没有。
 *   · `journalRows`（日记最近几条）——已经见过，只用来把条数补到 `limit`，
 *     顺带给指代锚点。
 *
 * 合并后按时间正序返回：注入块读起来必须是时间顺序，否则「刚才」就成了乱的。
 */

/** 压掉空白再比：账本原文与拼进正文的那份，只差渲染出来的换行和缩进 */
export const normText = (s) => String(s ?? '').replace(/\s+/g, '');

/**
 * 少于这个字数不参与原文去重。
 *
 * 「在」「？」「好」这类撞上纯属巧合——群里十个人都发「好」，拿它去剔
 * 只会把真正的上下文剔掉。宁可多重复一条短语，也别丢一条有用的。
 */
export const DEDUP_MIN_CHARS = 4;

/**
 * 这句是不是已经在本轮正文里了。
 *
 * @param {string} text 候选行的原文
 * @param {string} bodyNorm **已经压过空白**的本轮正文（见 `normText`）
 */
export function inBody(text, bodyNorm) {
  if (!bodyNorm) return false;
  const t = normText(text);
  if (t.length < DEDUP_MIN_CHARS) return false;
  return bodyNorm.includes(t);
}

/**
 * 合并缺口与日记，凑到 `limit` 条。
 *
 * @param {object[]} [gap] 缺口行，**正序**（`ledgerRead.gap()` 的原样）
 * @param {object[]} [journalRows] 日记行，**倒序**（`journal.recent()` 的原样）
 * @param {number} [limit] 目标条数（`recall.recentLimit`，0 = 整块不要）
 * @param {string} [bodyText] 本轮要投喂的正文，用来剔重复
 * @returns {object[]} 正序（老的在前），最多 `limit` 条
 */
export function mergeRecentRows({ gap = [], journalRows = [], limit = 8, bodyText = '' } = {}) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0));
  if (!max) return [];
  const bodyNorm = normText(bodyText);
  /**
   * 去重键用「时间 + 原文」而不是 eventId：日记行没有 eventId（只有
   * `eventIds` 数组，且合并批那条本来就不全），账本行有；两边凑不出一个
   * 共同键。时间和原文同时相同，才是同一条。
   */
  const seen = new Set();
  const take = (r) => {
    if (!r) return false;
    if (inBody(r.text, bodyNorm)) return false;
    const key = `${Number(r.at) || 0}|${normText(r.text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  /**
   * 缺口先全过一遍再截断：`gap` 是正序，缺口比 `limit` 多时该丢的是**最老**
   * 那几条（模型对「刚才」最敏感），所以不能在攒够 `limit` 条时就提前返回。
   */
  const picked = [];
  for (const r of Array.isArray(gap) ? gap : []) if (take(r)) picked.push(r);
  /** 缺口自己就够数：日记不用再查（调用方据 `gap.length >= limit` 省一次查询） */
  if (picked.length >= max) return picked.slice(-max);
  /**
   * 补足：日记是**倒序**（新→旧），从最近的往回拿；已经被缺口拿走的同一条
   * 会被 `take` 的 seen 挡掉。
   */
  for (const r of Array.isArray(journalRows) ? journalRows : []) {
    if (picked.length >= max) break;
    if (take(r)) picked.push(r);
  }
  return picked.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}
