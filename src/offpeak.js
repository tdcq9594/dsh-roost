/**
 * D10 offpeak：**重后台任务的峰谷判据**。
 *
 * 报告 §15.1-D 把这项标成「优先级最低、可做可不做」——我们的按天巩固
 * 固定在凌晨 4 点（`config.js` 的 `consolidateHour`），D11 的自动淡出也挂在
 * 同一次巩固上，重活本来就集中在谷时，**调度层面已经满足**。
 *
 * 所以这里不新增定时器、不改 `consolidateTick` 的执行条件，只把这条
 * 隐式约定**显式化成一个可测、可复用的判据**：
 *   · 阶段 7 的 E5 慢工具 / E4 备份要错峰时，直接 `shouldDeferHeavy()`；
 *   · `journal.vacuum()` 的注释写着「只能在没人在聊的时候跑」（锁库几秒），
 *     真要收紧就在这里接一行，不必另写一套时间判断。
 *
 * 两条判据（任一成立即谷）：
 *   1. 本地小时落在 `[startHour, endHour)`，支持跨午夜（22→6）；
 *   2. 距最近一次 inbound 超过 `quietMinutes`（安静期）。
 * `startHour === endHour` 视为**空窗口**（没有谷时），不擅自当成「全天放行」。
 *
 * 默认等价：本模块只读时间，不写盘、不调模型、不改任何调度。
 */
export const OFFPEAK_DEFAULTS = Object.freeze({ startHour: 0, endHour: 6, quietMinutes: 20 });

const MINUTE = 60_000;

function clampHour(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return 0;
  return Math.min(23, Math.max(0, Math.trunc(n)));
}

/** 小时是否落在谷时窗口里；start > end 表示跨午夜 */
export function hourIsOffpeak(hour, startHour = OFFPEAK_DEFAULTS.startHour, endHour = OFFPEAK_DEFAULTS.endHour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  const s = clampHour(startHour);
  const e = clampHour(endHour);
  if (s === e) return false;
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

/**
 * @param {{now?:number, lastActiveAt?:number, startHour?:number,
 *          endHour?:number, quietMinutes?:number}} o
 *   `lastActiveAt` = 最近一次收到消息的时间戳；0 / 不传表示「没有活跃记录」，
 *   此时安静期判据不成立，只按时间窗口判（宁可保守，也别把「不知道」
 *   当成「没人」而在高峰期跑重活）。
 */
export function offpeakState({
  now = Date.now(),
  lastActiveAt = 0,
  startHour = OFFPEAK_DEFAULTS.startHour,
  endHour = OFFPEAK_DEFAULTS.endHour,
  quietMinutes = OFFPEAK_DEFAULTS.quietMinutes,
} = {}) {
  const t = Number(now) || Date.now();
  const hour = new Date(t).getHours();
  const mins = Math.max(0, Number(quietMinutes) || 0);
  const last = Number(lastActiveAt) || 0;
  const quiet = mins > 0 && last > 0 && (t - last) >= mins * MINUTE;
  const base = { hour, quiet, quietMinutes: mins, startHour: clampHour(startHour), endHour: clampHour(endHour) };
  if (hourIsOffpeak(hour, startHour, endHour)) return { ...base, offpeak: true, reason: '谷时窗口' };
  if (quiet) return { ...base, offpeak: true, reason: '安静期' };
  return { ...base, offpeak: false, reason: '高峰' };
}

/** 给重后台任务用：非谷时返回 true，调用方自己决定推迟还是降级 */
export function shouldDeferHeavy(state) {
  return !state?.offpeak;
}
