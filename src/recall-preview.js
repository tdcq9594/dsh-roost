/**
 * 3.4 召回预览（只读投影）。
 *
 * 对齐 aurabot `/memory/assoc/preview`：给她一句话，看"她会想起哪几条、
 * 第几跳、为什么"。我方底层走现成的 `recallFor(q,{dry:true})`（四路 RRF
 * + 实体联想 + 重排，且不 touch），本模块只把结果**投影**成可读结构，
 * 不改检索、不碰存储、不写盘。
 *
 * 为什么单独成模块：host 里的 quick op 不该塞投影逻辑；纯函数好单测。
 *
 * hop 口径（G11 升级，仍然诚实）：
 *   · hop 0 = 直接命中（关键词/向量/时间/保底，无 via）。
 *   · hop 1 = 实体的直接关联日记（linkedJournalIds，entityWeights 缺省 0.5）。
 *   · hop 2 = **实体邻接联想**（adjacentJournalIds，entityWeights=0.3）：
 *     图 SQL 是 entity→edge→邻居 entity→edge→episode 的两跳遍历，是真二跳，
 *     所以标 hop2 不是编造。via 是起点实体名（经「X」联想）。
 *   · 没有 hop3+：我方图遍历到二跳为止，不编造三跳假装对齐对方 A→B→C→D。
 *   · 0.3 权重只在 dry 预览由 recallFor 带出（entityWeights），正常召回不带。
 *   · why 字符串（journal.search 产出）按 '+' 拆成数组，保留原文。
 */

/** 从 journal.search 的 why 文本里抽"经「X」联想"（实体联想的 via） */
export function viaOf(why = '') {
  const m = String(why || '').match(/经「([^」]+)」联想/);
  return m ? m[1] : '';
}

/** why 字符串拆成来源数组；空串给空数组，不塞占位 */
export function reasonsOf(why = '') {
  return String(why || '').split('+').map((s) => s.trim()).filter(Boolean);
}

/**
 * 把 dry 召回结果投影成预览行。
 *
 * @param {object} preview recallFor(q,{dry:true}) 的返回 { hits, rec, entities, temporal }
 * @param {object} opts
 *   @param {number} opts.limit 最多几条（对方默认 6）
 * @returns {{items:Array, counts:object, direct:number, hop1:number, total:number}}
 */
export function projectRecallPreview(preview = {}, { limit = 6 } = {}) {
  const hits = Array.isArray(preview?.hits) ? preview.hits : [];
  const cap = Math.max(1, Math.trunc(Number(limit) || 6));
  /** dry 预览带出的实体路权重：0.3=邻接二跳，其余=直接关联一跳 */
  const weights = preview?.entityWeights && typeof preview.entityWeights === 'object' ? preview.entityWeights : {};
  const items = hits.filter((h) => h && typeof h === 'object').slice(0, cap).map((h) => {
    const why = String(h?.why || '');
    const via = viaOf(why);
    const id = String(h?.id ?? '');
    /** 只有带 via（实体路）且权重是 0.3 才标二跳；否则 via=实体名但权重缺省=一跳 */
    const isAdjacent = Boolean(via) && Math.abs(Number(weights[id]) - 0.3) < 1e-6;
    const hop = !via ? 0 : isAdjacent ? 2 : 1;
    const reasons = reasonsOf(why);
    if (isAdjacent && !reasons.some((r) => r.includes('2 跳'))) reasons.push(`联想·2 跳（经「${via}」）`);
    return {
      id,
      text: String(h?.text ?? h?.digest ?? '').slice(0, 80),
      score: Math.round(Number(h?.score) * 100) / 100 || 0,
      hop,
      via,
      why: reasons,
    };
  });
  const count = (hop) => items.filter((r) => r.hop === hop).length;
  const direct = count(0);
  const hop1 = count(1);
  const hop2 = count(2);
  return {
    items,
    counts: { direct, hop1, hop2 },
    direct,
    hop1,
    hop2,
    total: items.length,
  };
}
