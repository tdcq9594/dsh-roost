/**
 * Token 折算金额（3.1，C1-2 + B15）。
 *
 * 三个刻意的选择：
 *
 * 1. **只内置核过官方定价页的 DeepSeek**（2026-11-13 核
 *    api-docs.deepseek.com/zh-cn/quick_start/pricing）。其它厂商标「未定价」，
 *    **不猜折扣**——aurabot 内置 33 条 × 7.2 折，那个 7.2 是猜的；
 *    宁可显示未定价，也不给假数字（和账本 unknown 不重发是同一个态度）。
 * 2. **峰谷两档就是 DeepSeek 官方的两档**：高峰 = 北京时间工作日
 *    （不含法定节假日）9–12 / 14–18；空闲价 = 高峰的一半。
 *    档位判定复用 `offpeak.js` 的 `priceTierOf`（同一份节假日表、
 *    同一个函数）——错峰调度和账单金额不两套真相。
 * 3. **cacheWrite（缓存写入）按未命中价计**：DeepSeek 的计费口径里
 *    没有「缓存写入」这一档，写进缓存的输入就是未命中的输入。
 *
 * 价格会过期。覆盖口在 `config.usage.pricing`：键是「模型名含这个子串」
 * （小写包含匹配），值同内置行；面板写「价格以官网为准」。
 */

/** 元 / 百万 tokens。来源见文件头注 */
export const PRICING_BUILTIN = Object.freeze({
  'deepseek-v4-pro': Object.freeze({
    label: 'DeepSeek V4 Pro',
    peak: Object.freeze({ uncached: 9.0, cacheRead: 0.30, cacheWrite: 9.0, output: 27.0 }),
    idle: Object.freeze({ uncached: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 }),
  }),
  'deepseek': Object.freeze({
    label: 'DeepSeek',
    peak: Object.freeze({ uncached: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 }),
    idle: Object.freeze({ uncached: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }),
  }),
});

const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);

/**
 * 按模型名找价目行。子串匹配、**最长的键优先**
 * （`deepseek-v4-pro` 必须赢过 `deepseek`，不然 pro 会按 flash 价算）。
 *
 * @param {string} model 模型名（如 `deepseek-flash`、`deepseek-v4-pro`）
 * @param {object|null} [userPricing] config.usage.pricing，浅合并进内置表
 * @returns {{key:string,label?:string,peak:object,idle:object}|null} 找不到 = 未定价
 */
export function priceRowFor(model, userPricing = null) {
  const s = String(model ?? '').toLowerCase();
  if (!s) return null;
  const table = {
    ...PRICING_BUILTIN,
    ...(userPricing && typeof userPricing === 'object' && !Array.isArray(userPricing) ? userPricing : {}),
  };
  const key = Object.keys(table)
    .filter((k) => s.includes(String(k).toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const row = table[key];
  if (!row || typeof row !== 'object') return null;
  return { key, ...row };
}

/**
 * 一桶 token 折成金额。
 *
 * @param {{uncached?:number, cacheRead?:number, cacheWrite?:number, output?:number}} tokens
 * @param {object} row priceRowFor 的返回
 * @param {'peak'|'idle'} tier 这桶 token 发生在哪个档
 * @returns {{yuan:number, tier:string}|null}
 */
export function costOf(tokens, row, tier = 'idle') {
  if (!row) return null;
  const p = tier === 'peak' ? row.peak : row.idle;
  if (!p) return null;
  const t = tokens ?? {};
  const yuan =
    ((num(t.uncached) + num(t.cacheWrite)) * num(p.uncached)
      + num(t.cacheRead) * num(p.cacheRead)
      + num(t.output) * num(p.output)) / 1e6;
  return { yuan: Number(yuan.toFixed(6)), tier };
}

/**
 * 一批「分模型 × 分档」的 token 桶折成金额（usage.summary 用）。
 *
 * @param {Record<string, Record<'peak'|'idle', object>>} models
 * @param {object|null} pricing config.usage.pricing
 * @returns {{yuan:number, priced:boolean, unpricedTokens:number, byModel:object}}
 *   `priced`：有没有哪怕一笔可折算的（决定面板显示金额还是「未定价」）；
 *   `unpricedTokens`：未定价模型的 token 数（含升级前没有分档的历史），
 *   如实报数量，不猜价格。
 */
export function costOfModels(models, pricing = null) {
  const out = { yuan: 0, priced: false, unpricedTokens: 0, byModel: {} };
  if (!models || typeof models !== 'object') return out;
  for (const [model, tiers] of Object.entries(models)) {
    const row = priceRowFor(model, pricing);
    for (const [tier, t] of Object.entries(tiers || {})) {
      const toks = num(t?.uncached) + num(t?.cacheRead) + num(t?.cacheWrite) + num(t?.output);
      if (!toks) continue;
      if (!row || (tier !== 'peak' && tier !== 'idle')) {
        out.unpricedTokens += toks;
        continue;
      }
      const c = costOf(t, row, tier);
      if (!c) { out.unpricedTokens += toks; continue; }
      out.yuan += c.yuan;
      out.priced = true;
      const bm = (out.byModel[model] = out.byModel[model] || { yuan: 0, tokens: 0 });
      bm.yuan += c.yuan;
      bm.tokens += toks;
    }
  }
  out.yuan = Number(out.yuan.toFixed(2));
  for (const bm of Object.values(out.byModel)) bm.yuan = Number(bm.yuan.toFixed(2));
  return out;
}
