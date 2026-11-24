/**
 * G8 注入热度：被注入 prompt 的 facts 涨 hitDays 的五层防护（纯函数，不写盘）。
 *
 * 对齐 aurabot touch() 的限流刹车（memory.js:1372-1455），但只做"记热度"，
 * 不做升档——core 升档仍由 evidence 账本独占（主人 2026-11-24 定的双信号分工：
 * hitDays 喂抗遗忘/亮度/权重，evidence 独占升档）。
 *
 * 五层落点：
 *   1. 预览不加深 —— 本模块只由真实注入路径 memoryStatic 调；面板只读预览走
 *      memoryDynamic，天然不碰这里（接线层保证，不是本模块的事）。
 *   2. 自然日去重 —— lastHitDay 记本地日，同一天只涨一次 hitDays。
 *   3. 封顶 —— hitDays 硬上限 40（对齐对方 hitDaysCap；τ 里再用 min(10) 饱和）。
 *   4. 慢涨 —— 不在本模块：τ 的 strength=1+min(10,hitDays) 天然平滑，无 tier 跳变。
 *   5. 最近注入排除 —— 记最近 window 轮注入过的正文，窗口内不再计热（防同一条霸榜）。
 *      对齐对方 recentEvents(24h,4) 排除；我方按轮数而非小时（无 per-event 时间锚）。
 */

export const HIT_DAY_CAP = 40;
export const DEFAULT_RECENT_WINDOW = 4;

/** 本地日历日（凌晨巩固时 UTC 还在昨天，不能用 toISOString） */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 算本轮该给哪些事实涨热度。
 *
 * @param {object} input
 *   injected: string[]  本轮真实注入的 facts 正文（来自 listRanked）
 *   heat: Record<text, {hitDays, lastHitDay, lastHit}>  现有热度账（按正文 key）
 *   recent: string[]  最近 window 轮已注入过的正文（新的在前）
 * @param {object} opts { now, window }
 * @returns { updates: [{text, hitDays, lastHitDay, lastHit}], recent: string[], changed: boolean }
 *   updates 只含"真正涨了"的条目；调用方据此写回 memory meta。
 */
export function planHeat(input = {}, opts = {}) {
  const now = Number(opts.now) > 0 ? Number(opts.now) : Date.now();
  const window = Math.max(1, Math.trunc(Number(opts.window) || DEFAULT_RECENT_WINDOW));
  const today = dayKey(now);
  const injected = Array.isArray(input?.injected) ? input.injected : [];
  const heat = input?.heat && typeof input.heat === 'object' && !Array.isArray(input.heat) ? input.heat : {};
  const recent = Array.isArray(input?.recent) ? input.recent.filter((x) => typeof x === 'string') : [];

  /** 第 5 层：最近 window 轮注入过的，本轮不计热（防霸榜） */
  const recentlyShown = new Set(recent.slice(0, window));
  const updates = [];
  for (const raw of new Set(injected.filter((x) => typeof x === 'string' && x))) {
    if (recentlyShown.has(raw)) continue;
    const prev = heat[raw] && typeof heat[raw] === 'object' ? heat[raw] : {};
    /** 第 2 层：同一自然日只算一次 */
    if (prev.lastHitDay === today) continue;
    const hitDays = Math.min(HIT_DAY_CAP, (Math.max(0, Number(prev.hitDays) || 0)) + 1);
    updates.push({ text: raw, hitDays, lastHitDay: today, lastHit: now });
  }

  /** 新 recent：本轮注入的插到最前，去重后截到 window */
  const nextRecent = [...new Set([...injected.filter((x) => typeof x === 'string' && x), ...recent])].slice(0, window);
  return { updates, recent: nextRecent, changed: updates.length > 0 || nextRecent.join('\0') !== recent.join('\0') };
}
