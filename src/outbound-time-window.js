/** 出站策略的时间窗工具——移植自 aurabot-beta src/core/time-window.js。MIT, (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。 */
// 日窗口工具：统一「某个时刻在不在窗口内」和「下一个窗口起点」的判断。
//
// 主动搭话的醒着时间、B 站 / QQ 空间的定时任务、空间日记的发布时间窗都用这一套，
// 避免各处各写一份、跨天区间（例如 9:00 到凌晨 3:00）被当成「全天」或「永远不在」。
//
// 约定（与 proactive-policy 原来的「全天」口径一致）：
//   · from === to（0:00 与 24:00 视为同一端点）：全天（24 小时都算在窗口内）
//   · from < to：[from, to)，当天窗口
//   · from > to：跨天窗口 [from, 24) ∪ [0, to)
// 小时窗口用本地时区（0–24）；分钟窗口用一天内的分钟数（0–1440，24:00 = 1440）。
// 24:00 只在「窗口终点」出现时按 0:00 处理，所以 9:00–24:00 就是到当天结束，不是全天。

const DAY_MINUTES = 1440
const DAY_HOURS = 24

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const mod = (value, base) => ((value % base) + base) % base
const pad2 = (value) => String(value).padStart(2, '0')

/** 是不是全天窗口（from === to，0:00 与 24:00 等价）。 */
export function isFullDayWindow(from, to) {
  return mod(Math.round(num(from, 0)), DAY_HOURS) === mod(Math.round(num(to, DAY_HOURS)), DAY_HOURS)
}

/** 小时窗口是否包含 at（只看本地小时，分钟忽略；跨天区间自动绕回）。 */
export function inHourWindow(at, from, to) {
  const f = mod(Math.round(num(from, 0)), DAY_HOURS)
  const t = mod(Math.round(num(to, DAY_HOURS)), DAY_HOURS)
  if (f === t) return true
  const h = new Date(at).getHours()
  return f < t ? h >= f && h < t : h >= f || h < t
}

/** 下一个窗口开始时刻（严格晚于 at，本地时区整点）。 */
export function nextWindowStart(at, from) {
  const f = mod(Math.round(num(from, 0)), DAY_HOURS)
  const d = new Date(at)
  d.setHours(f, 0, 0, 0)
  while (d.getTime() <= at) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/**
 * 醒着窗口的补集（安静时段），返回 'HH:00' 字符串。
 * 全天窗口返回 00:00–00:00（与引擎约定一致：start === end 视为不启用安静时段）。
 */
export function quietWindowOf(from, to) {
  if (isFullDayWindow(from, to)) return { quietStart: '00:00', quietEnd: '00:00' }
  const f = mod(Math.round(num(from, 0)), DAY_HOURS)
  const t = mod(Math.round(num(to, DAY_HOURS)), DAY_HOURS)
  return { quietStart: `${pad2(t)}:00`, quietEnd: `${pad2(f)}:00` }
}

/** 分钟窗口是否包含 minuteOfDay（0–1440；from === to 视为全天）。 */
export function inMinuteWindow(minuteOfDay, fromMin, toMin) {
  const f = mod(num(fromMin, 0), DAY_MINUTES)
  const t = mod(num(toMin, 0), DAY_MINUTES)
  const m = mod(num(minuteOfDay, 0), DAY_MINUTES)
  if (f === t) return true
  return f < t ? m >= f && m < t : m >= f || m < t
}

/** 分钟窗口跨度（跨天自动绕回；from === to 为全天 1440 分钟）。 */
export function windowMinutes(fromMin, toMin) {
  const f = mod(num(fromMin, 0), DAY_MINUTES)
  const t = mod(num(toMin, 0), DAY_MINUTES)
  if (f === t) return DAY_MINUTES
  return t > f ? t - f : DAY_MINUTES - f + t
}
