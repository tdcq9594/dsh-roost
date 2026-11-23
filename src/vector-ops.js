/**
 * G2 向量运维：test（连通性）+ rebuild（重建索引）的编排逻辑。
 *
 * status 已有 `vector-status.js`（阶段5，本模块不重复造）。
 * 这里只放两个写/发请求的动作；纯函数部分可单测，存储动作由 host 注入。
 *
 * 对齐 aurabot：
 *   - vectorTest：真发一条短文本到 embedding，返回 dims/ms，不写索引。
 *   - vectorRebuild：reset（清向量索引）+ sync（重新补算）。
 *     我方没有独立向量索引表，向量存在 journal 行 `vec` 字段；
 *     所以 rebuild = 分批重新 embed + setVec，不动 assoc（我方无独立 assoc 表）。
 *
 * 安全：rebuild 必须分批、失败不写半批；不碰 journal 正文，只改 vec 列。
 */
export const TEST_TEXT = '今天想吃白米饭';

/** test 结果：真向量回 dims/ms，空向量回失败提示（对齐对方 test 返回） */
export function testResult(vec, ms) {
  const dims = Array.isArray(vec) ? vec.length : 0;
  return {
    ok: dims > 0,
    dims,
    ms: Math.max(0, Number(ms) || 0),
    ...(dims > 0 ? {} : { message: '没有返回向量（检查模型是否装好、服务地址与 Key）' }),
  };
}

/**
 * rebuild 一批：把 noVec() 拿到的行交给 embedder 补算，成功才 setVec。
 * 返回 { done, failed }。纯编排，具体 noVec/embed/setVec 由 host 注入。
 *
 * 关键（对齐 consolidate 的踩坑）：
 *   - 传 model 指纹给 noVec，连"有向量但模型不符"的也重算（换模型后旧向量失效）；
 *   - embed.many 返回长度必须与 pending 一致才写（否则整批不写，防半批错位）；
 *   - setVec 带 model 指纹落库。
 */
export async function rebuildBatch({ rows, embed, setVec, model }) {
  const pending = Array.isArray(rows) ? rows.filter((r) => r && r.id && String(r.text || '').trim()) : [];
  if (!pending.length) return { done: 0, failed: 0 };
  if (typeof embed?.many !== 'function' || typeof setVec !== 'function') return { done: 0, failed: pending.length };
  let vecs = null;
  try {
    vecs = await embed.many(pending.map((r) => String(r.text || '')));
  } catch {
    return { done: 0, failed: pending.length };
  }
  /** 长度不一致 = 整批作废，绝不写半批（向量和正文错位比没有向量更糟） */
  if (!Array.isArray(vecs) || vecs.length !== pending.length) {
    return { done: 0, failed: pending.length };
  }
  let done = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (Array.isArray(vecs[i]) && vecs[i].length) {
      try { setVec(pending[i].id, vecs[i], model); done++; } catch { failed++; }
    } else failed++;
  }
  return { done, failed };
}
