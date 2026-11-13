/**
 * 4.6 互动召回 `is_wakeup`（单聊）。
 *
 * ## 官方口径（2026-11-13 用户给的 QQ 开放平台文档截图，按原文实现）
 *
 * > 互动召回消息：在用户主动与机器人对话之后，机器人在未来 30 天内可下发
 * > 互动召回消息给用户（消息类型与当前机器人拥有的消息类型权限一致），
 * > 每个周期内可下发一条。分别为：**当天、1–3 天、3–7 天、7–30 天**，
 * > 合计 4 个周期。在发消息接口中使用 `is_wakeup` 字段声明使用该能力。
 *
 * 三个容易做错、且做出去就是违规的地方：
 *
 * 1. **周期不是等分的**。不是「30 天 / 4 = 每 7.5 天一条」，是四个不等长
 *    窗口，而且是相对**用户最后一次互动**算的，不是按自然月/绝对时间切。
 * 2. **超过 30 天就完全没有额度**。没有互动就没有窗口，不能靠时钟一直
 *    开新周期——那会变成无限制主动推送。
 * 3. **用户再说话会开启新一轮 30 天窗口**。所以账本要记 anchor（这次
 *    窗口从哪次互动起算），anchor 变了就是新一轮，四个窗口重新可用。
 *
 * ## 为什么单独一本账
 *
 * 主动搭话（speakUp）按天算「每日 3 次」，互动召回按「一次互动后 30 天内
 * 4 个窗口各 1 条」。混在一本账里，要么搭话把召回额度吃光，要么召回让
 * 搭话一天少一次。这里只管「这个 anchor 的这个窗口发没发过」。
 *
 * ## 默认关
 *
 * 没人让机器人主动找人之前，不该凭空多一条消息。`wakeup.enabled` 默认
 * false，升级前后行为一模一样。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { beijingParts } from './offpeak.js';

export const WAKEUP_DEFAULTS = Object.freeze({
  enabled: false,
  /** 多久没互动才算「久不说话」。默认 72h，所以实际只会命中 3–7 天 / 7–30 天两个窗口；
   *  调小到 1 就能覆盖「当天」和「1–3 天」，由主人自己决定 */
  idleHours: 72,
  /** 官方硬上限，不许配置放宽 */
  windowDays: 30,
  /** 只在白天发（北京时间） */
  awakeFrom: 9,
  awakeTo: 22,
});

const DAY = 86_400_000;

/** 官方四个窗口：左闭右开，单位天。30 天之外没有额度 */
export const WAKEUP_WINDOWS = Object.freeze([
  { id: 0, label: '当天', from: 0, to: 1 },
  { id: 1, label: '1–3 天', from: 1, to: 3 },
  { id: 2, label: '3–7 天', from: 3, to: 7 },
  { id: 3, label: '7–30 天', from: 7, to: 30 },
]);

/**
 * 落在哪个窗口（纯函数，导出给测试）。
 *
 * @returns {{within:boolean, cycle:number, label:string, days:number, anchor:number}}
 */
export function wakeupCycleOf(now = Date.now(), lastActiveAt = 0) {
  const anchor = Number(lastActiveAt) || 0;
  const days = anchor ? Math.max(0, (Number(now) - anchor) / DAY) : Infinity;
  const hit = WAKEUP_WINDOWS.find((w) => days >= w.from && days < w.to);
  return {
    within: Boolean(hit),
    cycle: hit ? hit.id : -1,
    label: hit ? hit.label : anchor ? '超出 30 天窗口' : '还没互动过',
    days: Number.isFinite(days) ? Number(days.toFixed(3)) : -1,
    anchor,
  };
}

/**
 * 该不该发这一条（纯函数，导出给测试）。
 *
 * 顺序刻意按「最便宜的判断先做」：关着就不算窗口、没互动过就不发、
 * 超 30 天不发、没到静默时长不发、夜里不发、这个窗口发过就不发。
 * 只有全过了才轮到跑模型（那一步最贵）。
 *
 * `used` 是账本行：`{ anchor, cycle, at }`。只认**同一个 anchor** 的记录；
 * anchor 变了说明用户又说话了，是新一轮 30 天窗口。
 */
export function wakeupPlan({
  now = Date.now(),
  lastActiveAt = 0,
  used = [],
  cfg = {},
} = {}) {
  const c = { ...WAKEUP_DEFAULTS, ...(cfg || {}) };
  const info = wakeupCycleOf(now, lastActiveAt);
  const done = (why) => ({ fire: false, why, ...info, idleHours: 0 });
  if (c.enabled !== true) return done('互动召回没开');
  if (!info.anchor) return done('用户还没主动说过话，没有窗口');
  if (!info.within) return done('超出官方 30 天窗口，不能发');
  const idle = (Number(now) - info.anchor) / 3_600_000;
  if (idle < Number(c.idleHours)) return done(`才 ${Math.round(idle)} 小时没说话，没到 ${c.idleHours} 小时`);
  const { hour } = beijingParts(now);
  const from = Number(c.awakeFrom), to = Number(c.awakeTo);
  if (hour < from || hour >= to) return done(`北京时间 ${hour} 点，不在 ${from}–${to} 点`);
  const rows = Array.isArray(used) ? used : [];
  if (rows.some((x) => Number(x?.anchor) === info.anchor && Number(x?.cycle) === info.cycle)) {
    return done(`「${info.label}」这一档已经召回过了（同一个窗口只发 1 条）`);
  }
  return { fire: true, why: `距上次互动 ${Math.round(idle)} 小时，落在「${info.label}」窗口`, ...info, idleHours: Math.round(idle) };
}

/**
 * 账本：`<dataDir>/wakeup.json`。
 * 一行 = 某次互动（anchor）的某个窗口发过一条；最多留最近 32 行，
 * 够覆盖 8 轮互动 × 4 窗口，又不会无限涨。
 */
export function createWakeupLedger({ file, log = () => {} } = {}) {
  let rows = [];
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      rows = Array.isArray(raw?.rows)
        ? raw.rows.filter((x) => x && Number(x.anchor) > 0 && Number(x.cycle) >= 0)
        : [];
    }
  } catch (e) {
    log(`互动召回账本读不出来，按空账继续：${e.message}`);
    rows = [];
  }
  const save = () => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows }, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      log(`互动召回账本写盘失败：${e.message}`);
    }
  };
  return {
    used: () => rows.slice(),
    mark(anchor, cycle, extra = {}) {
      const a = Number(anchor), c = Number(cycle);
      if (!a || c < 0 || c > 3) return false;
      if (rows.some((x) => Number(x.anchor) === a && Number(x.cycle) === c)) return false;
      rows.push({ anchor: a, cycle: c, at: Date.now(), ...extra });
      rows = rows.slice(-32);
      save();
      return true;
    },
    clear() { rows = []; save(); },
  };
}
