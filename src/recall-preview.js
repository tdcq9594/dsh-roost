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
 * hop 口径（诚实，别吹）：
 *   · 我方实体路只有一跳邻接（recallFor 里 entityWeights=0.3 那批），
 *     没有对方 assoc 的 A→B→C 多跳。所以 hop 只标 0（直接）/1（经实体联想），
 *     counts 里也只有 direct/hop1——不编造 hop2/hop3 去假装对齐。
 *   · why 字符串（journal.search 产出）按 '+' 拆成数组，保留"向量#N/关键词/
 *     经「X」联想/那段时间/保底"这些原文，用户能看懂每条为什么被想起。
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
  const items = hits.filter((h) => h && typeof h === 'object').slice(0, cap).map((h) => {
    const why = String(h?.why || '');
    const via = viaOf(why);
    return {
      id: String(h?.id ?? ''),
      text: String(h?.text ?? h?.digest ?? '').slice(0, 80),
      score: Math.round(Number(h?.score) * 100) / 100 || 0,
      hop: via ? 1 : 0,
      via,
      why: reasonsOf(why),
    };
  });
  const direct = items.filter((r) => r.hop === 0).length;
  const hop1 = items.length - direct;
  return {
    items,
    counts: { direct, hop1 },
    direct,
    hop1,
    total: items.length,
  };
}
