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

/**
 * 扩展记忆的**按需候选池**（方案 §5.1 / §5.2 / 实施阶段 4.1）。
 *
 * 只在 `ext_memory_search` 被模型主动调用时才读 `ext-memory/`；
 * `listRanked()` 的自动注入永远不碰这里 —— 一个刷 B 站扩展攒几千条视频
 * 记录，不能把它们塞进每轮 prompt 冲垮人格记忆。
 *
 * 「默认范围」和「可见性」是两个维度（§5.4 / §9-#23）：
 *   · `visibleExtIds` 由 `ext-memory.js` 的 ACL 算出，是**硬过滤**，任何情况下
 *     都不得被 `all:true` 跳过 —— private 双条件与 `read:[]` 是隐私边界，
 *     不是一个检索参数能放宽的「范围」；
 *   · `all` 只表示调用方请求跨命名空间检索，不改变可见集；
 *   · 传 `extId` 则限定单个命名空间，且它必须仍在可见集内。
 *
 * 纯函数：store 只被调 `listAll()`，不写盘、不缓存，测试可用假 store。
 */
export function extMemoryCandidates(store, {
  query = '', extId = '', all = false, visibleExtIds = null, limit = 5, maxChars = 120,
} = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q || !store || typeof store.listAll !== 'function') return [];
  const words = q.split(/\s+/).filter(Boolean);
  // `all` 不参与这句：可见性是 ACL 的硬上限，不是检索范围开关。
  // ⚠️ 不传 `visibleExtIds` 时本函数不过滤命名空间，因此**只能由
  // `ext-memory.js` 的 `search()` 调用**（它永远传可见集并再做一次 ACL 兜底）。
  // 别把本纯函数当成新入口直接暴露给模型 / HTTP，否则 private 命名空间会漏出去。
  const visible = Array.isArray(visibleExtIds) ? new Set(visibleExtIds) : null;
  const target = extId ? String(extId) : '';

  const out = [];
  for (const pool of store.listAll({ includeArchived: false })) {
    if (target && pool.extId !== target) continue;
    if (visible && !visible.has(pool.extId)) continue;
    for (const row of pool.rows || []) {
      const text = String(row.text ?? '');
      const lower = text.toLowerCase();
      if (!words.some((w) => lower.includes(w))) continue;
      out.push({
        extId: pool.extId,
        text: `[${pool.extId}] ${[...text].slice(0, maxChars).join('')}`,
        w: Number(row.w) || 0,
        at: row.at ?? 0,
        src: row.src ?? `ext:${pool.extId}`,
      });
    }
  }
  return out.sort((a, b) => b.w - a.w || b.at - a.at).slice(0, Math.max(1, limit));
}
