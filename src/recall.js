/**
 * 日记检索的「短句补检索」与召回日志行（调研报告 D3 / D4）。
 *
 * 抽出来的原因：这两件事都挂在 `host.js` 的记忆检索那一大段里，
 * 埋进去就只能靠端到端跑一轮才验得到；抽成纯函数后，假 journal
 * 就能把「补位不加权」「不存正文」两条锁死。
 */

/**
 * 短句（<12 字）连上一句再搜一次，主结果不足时按**原分补位**。
 *
 * 为什么不乘 0.6：`journal.search()` 是 RRF k=60 名次融合，相邻名次的
 * 分差只有 1.6%，任何系数都会反转顺序。补进来的条目保留自己在第二次
 * 检索里的分数，只去重、不改名次。
 *
 * @param {{search:(q:string,opts:object)=>Promise<Array<object>>}} journal
 * @param {string} q 这一轮的用户原话
 * @param {object} opts 传给 journal.search 的选项（含 limit）
 * @param {string} prev 这个会话上一句用户原话（没有就传空串）
 */
export async function searchWithShortContext(journal, q, opts = {}, prev = '') {
  const query = String(q ?? '');
  const shortPhrase = [...query].length < 12;
  const limit = Number(opts.limit) || 3;
  let hits = await journal.search(query, opts);
  let usedPrev = false;

  if (shortPhrase && prev && hits.length < limit) {
    const more = await journal.search(`${prev} ${query}`, opts);
    const seen = new Set(hits.map((h) => h.id));
    const extra = more.filter((h) => !seen.has(h.id));
    if (extra.length) usedPrev = true;
    hits = [...hits, ...extra].slice(0, limit);
  }

  return { hits: hits || [], shortPhrase, usedPrev };
}

/**
 * 召回日志的一行。**绝不存正文**：连检索词都只留长度。
 *
 * 面板要回答的是「她刚才想起了哪几条、为什么」，不是「当时聊了什么」——
 * 后者已经在日记里，再抄一份就变成第二个记忆库。
 */
export function recallRow(chatId, q, hits, { shortPhrase = false, usedPrev = false } = {}) {
  return {
    chatId: String(chatId ?? ''),
    queryLen: [...String(q ?? '')].length,
    shortPhrase,
    usedPrev,
    shown: (hits || []).length,
    items: (hits || []).map((h) => ({ id: h.id, score: h.score, why: h.why })),
  };
}
