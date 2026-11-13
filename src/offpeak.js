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
 * 3.2 加了第二种模式：`mode: 'official'`，按 **DeepSeek 官方峰时**判——
 *   北京时间周一至周五（不含法定节假日）9:00–12:00、14:00–18:00 为高峰，
 *   其余（含周末、法定节假日全天）为空闲。空闲判据与计价档位是同一份
 *   （`priceTierOf`），后台错峰和账单金额不会各说各话。
 *   安静期判据在两种模式下都成立——「没人在聊」是本地实据，不跟官方表走。
 *
 * 默认等价：`mode: 'self'` 时行为与 3.2 之前逐字节一致。
 */
export const OFFPEAK_DEFAULTS = Object.freeze({ startHour: 0, endHour: 6, quietMinutes: 20 });

/**
 * 中国法定节假日表（3.2）。
 *
 * 来源：国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04 发布）。
 * `holidays` 是放假的日期（全天空闲），`workdays` 是调休上班的周末
 * （那一天按工作日判，进峰时窗口）。
 *
 * **表只含核过源的 2026 年**。没核过源的年份宁可不猜——错表比没表危险，
 * 没表时回退成「只看周末/工作日」，高峰最多多算几小时；
 * 错表会把真正的节假日当高峰（多花钱）或反过来。新年份由 `config.offpeak.holidays`
 * 覆盖，键结构与本表一致。
 */
export const CN_HOLIDAY_TABLE = Object.freeze({
  2026: Object.freeze({
    holidays: Object.freeze([
      '2026-01-01', '2026-01-02', '2026-01-03',
      ...['2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23'],
      '2026-04-04', '2026-04-05', '2026-04-06',
      ...['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'],
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      ...['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'],
    ]),
    workdays: Object.freeze([
      '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
    ]),
  }),
});

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
 *          endHour?:number, quietMinutes?:number, mode?:string, holidays?:object|null}} o
 *   `lastActiveAt` = 最近一次收到消息的时间戳；0 / 不传表示「没有活跃记录」，
 *   此时安静期判据不成立，只按时间窗口判（宁可保守，也别把「不知道」
 *   当成「没人」而在高峰期跑重活）。
 *   `mode`: 'self'（默认，原判据）| 'official'（官方峰时）。
 *   `holidays`: 用户覆盖的节假日表，结构同 `CN_HOLIDAY_TABLE`。
 */
export function offpeakState({
  now = Date.now(),
  lastActiveAt = 0,
  startHour = OFFPEAK_DEFAULTS.startHour,
  endHour = OFFPEAK_DEFAULTS.endHour,
  quietMinutes = OFFPEAK_DEFAULTS.quietMinutes,
  mode = 'self',
  holidays = null,
} = {}) {
  const t = Number(now) || Date.now();
  const hour = new Date(t).getHours();
  const mins = Math.max(0, Number(quietMinutes) || 0);
  const last = Number(lastActiveAt) || 0;
  const quiet = mins > 0 && last > 0 && (t - last) >= mins * MINUTE;
  const base = { hour, quiet, quietMinutes: mins, startHour: clampHour(startHour), endHour: clampHour(endHour), mode };
  if (mode === 'official') {
    const bj = beijingParts(t);
    const peak = officialIsPeak(bj, mergedTable(holidays));
    if (quiet) return { ...base, bjDate: bj.date, bjHour: bj.hour, offpeak: true, reason: '安静期' };
    if (!peak) return { ...base, bjDate: bj.date, bjHour: bj.hour, offpeak: true, reason: '官方空闲时段' };
    return { ...base, bjDate: bj.date, bjHour: bj.hour, offpeak: false, reason: '官方高峰' };
  }
  if (hourIsOffpeak(hour, startHour, endHour)) return { ...base, offpeak: true, reason: '谷时窗口' };
  if (quiet) return { ...base, offpeak: true, reason: '安静期' };
  return { ...base, offpeak: false, reason: '高峰' };
}

/** 给重后台任务用：非谷时返回 true，调用方自己决定推迟还是降级 */
export function shouldDeferHeavy(state) {
  return !state?.offpeak;
}

/* ============ 官方峰时判据（3.2，DeepSeek 官方口径） ============ */

const WEEKDAY_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * 把时间戳换成北京时间的 { date, hour, weekday }。
 *
 * 官方峰时写的是北京时间，机器可能在任何时区——必须用带时区的
 * 格式化取数，不能拿本地 `getHours()` 硬套。
 * `hour % 24` 防个别 ICU 把午夜输出成 '24'。
 */
export function beijingParts(t = Date.now()) {
  const d = new Date(Number(t) || Date.now());
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour) % 24,
    weekday: WEEKDAY_NUM[p.weekday] ?? d.getDay(),
  };
}

/** 用户传的覆盖表（对象，键是年份）浅合并进内置表；传了哪年用哪年 */
function mergedTable(holidays) {
  if (!holidays || typeof holidays !== 'object' || Array.isArray(holidays)) return CN_HOLIDAY_TABLE;
  return { ...CN_HOLIDAY_TABLE, ...holidays };
}

/**
 * 官方口径：这一刻是不是高峰。
 *
 * 优先级：节假日（全天空闲）> 调休上班日（按工作日判）> 周末（全天空闲）
 * > 工作日 9–12 / 14–18 高峰，其余空闲。表里没有的年份退回「只看周末」。
 */
export function officialIsPeak({ date, hour, weekday }, table = CN_HOLIDAY_TABLE) {
  const t = table && typeof table === 'object' ? table : {};
  const year = Number(String(date ?? '').slice(0, 4));
  const y = year ? t[year] : null;
  if (y?.holidays?.includes(date)) return false;
  const weekend = weekday === 0 || weekday === 6;
  if (weekend && !y?.workdays?.includes(date)) return false;
  const h = Number(hour) % 24;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 计价档位（3.1 用）：'peak' 高峰价 / 'idle' 空闲价。
 * 与错峰判据同一份表、同一个函数——账单和调度不能两套真相。
 */
export function priceTierOf({ now = Date.now(), holidays = null } = {}) {
  const bj = beijingParts(now);
  return officialIsPeak(bj, mergedTable(holidays)) ? 'peak' : 'idle';
}
