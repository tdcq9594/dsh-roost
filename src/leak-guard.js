/**
 * 出站防复读（leak-guard 低配版）
 * ==============================
 *
 * 场景：用户问「你还记得吗 / 你的设定是什么」，模型把**注入块**（记忆、
 * 档案、规则）整段当成自己的话背出来——人格卡被背出等于提示词泄露。
 *
 * 低配版只做三件（报告 §4 的建议）：
 *   1. 固定注入块的归一化指纹（20 字滑窗）；
 *   2. 出站文本按句切开，逐句比对；
 *   3. 命中比例 ≥ 60% 才删——避免一句话里碰巧有 20 字重合就整句没了。
 *
 * 刻意不做：18 字第二档 shingle、主人私聊豁免、日志里的拦截率统计面板。
 * 默认关（`config.leakGuard.enabled`），观察一段时间再决定要不要常开。
 */

/** 归一化：去代码/链接/图片/Markdown 符号/空白/零宽/标点 */
export function normalizeForGuard(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>|\\-]/g, '')
    .replace(/[\s\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

/** 20 字滑窗指纹 */
export function shingles(text, n = 20) {
  const s = normalizeForGuard(text);
  const out = new Set();
  if (s.length < n) return out;
  for (let i = 0; i + n <= s.length; i += 1) out.add(s.slice(i, i + n));
  return out;
}

/**
 * 删掉出站文本里复述注入块的句子。
 *
 * @param {string} outText 她准备发出去的话
 * @param {string[]} blocks 本轮注入的原文（记忆块 / 档案 / 规则）
 * @returns {{text:string, removed:number}} `removed` 是删掉的句数
 */
export function stripLeak(outText, blocks, { n = 20, ratio = 0.6 } = {}) {
  const text = String(outText ?? '');
  if (!text) return { text: '', removed: 0 };
  const prints = new Set();
  for (const b of Array.isArray(blocks) ? blocks : []) {
    for (const g of shingles(b, n)) prints.add(g);
  }
  if (!prints.size) return { text, removed: 0 };

  /** 按句末标点/换行切，保留分隔符（split 用后行断言） */
  const parts = text.split(/(?<=[。！？!?\n])/);
  let removed = 0;
  const kept = parts.filter((p) => {
    const gs = shingles(p, n);
    if (!gs.size) return true;
    let hit = 0;
    for (const g of gs) if (prints.has(g)) hit += 1;
    /**
     * 两个比例取大：
     *   · `hit/gs.size` = 这句里有多少是注入块的内容；
     *   · `hit/prints.size` = 注入块有多少被这句复述了。
     * 只用前者的话，「你的设定是：<整段记忆>」这种句子因为多了几个字
     * 就被稀释到 60% 以下、删不掉——而那正是最典型的泄露形态。
     */
    const cover = Math.max(hit / gs.size, hit / prints.size);
    if (cover >= ratio) { removed += 1; return false; }
    return true;
  });
  return {
    text: kept.join('').replace(/\n{3,}/g, '\n\n').trim(),
    removed,
  };
}
