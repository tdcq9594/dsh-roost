/**
 * 自驱 · 排程层（P1）——移植自 aurabot-beta `src/autotelic/schedule.js`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 回答：**她什么时候自己醒来琢磨事**。
 * 以前只有 `heartbeatMin` 定间隔——机械得像闹钟；这一层换成「醒着窗口内随机间隔 +
 * 主人回话时段轻推 + 当日额度」，更像她自己的作息。
 *
 * 复用 purpose-schedule 的时段与直方图函数（同口径，不重复实现）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  inQuietHours, quietEndAfter, nextDayStartAfter, bestReplyHourShift,
} from './purpose-schedule.js';

const MINUTE = 60 * 1000;

const clampInt = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/** 配置归一化：醒着窗口/间隔/每日轮次/点火冷却。 */
export function scheduleConfig(s = {}) {
  return {
    enabled: s.enabled !== false,
    awakeFrom: clampInt(s.awakeFrom, 8, 0, 24),
    awakeTo: clampInt(s.awakeTo, 23, 0, 24),
    minIntervalMinutes: clampInt(s.minIntervalMinutes, 90, 5, 2880),
    maxIntervalMinutes: clampInt(s.maxIntervalMinutes, 240, 5, 2880),
    maxPerDay: clampInt(s.maxPerDay, 3, 0, 20),
    igniteCooldownMinutes: clampInt(s.igniteCooldownMinutes, 45, 1, 720),
  };
}

/** 安静窗口 = 醒着窗口的补集（start === end 视为不启用）。 */
export function quietOf(cfg) {
  return { quietStart: `${String(cfg.awakeTo).padStart(2, '0')}:00`, quietEnd: `${String(cfg.awakeFrom).padStart(2, '0')}:00` };
}

/**
 * 纯函数：从 now 排下一次定时回味。
 * 间隔在 [min, max] 随机；回话直方图样本 ≥5 时向高回话小时轻推（≤3h）；
 * 落在安静时段就推到安静结束 + 0~20 分钟抖动；当日额度用尽推到次日起点。
 */
export function computeNextFire({ now, cfg, lastRunAt = 0, countToday = 0, replyHours = [], random = Math.random } = {}) {
  const qcfg = quietOf(cfg);
  const minMs = cfg.minIntervalMinutes * MINUTE;
  const maxMs = Math.max(minMs, cfg.maxIntervalMinutes * MINUTE);
  let at;
  if (cfg.maxPerDay > 0 && countToday >= cfg.maxPerDay) {
    at = nextDayStartAfter(now, qcfg);
  } else if (lastRunAt > 0) {
    at = lastRunAt + Math.round(minMs + random() * (maxMs - minMs));
    /** 停机很久：别攒一堆补发，只补一枪 */
    if (at < now + 2 * MINUTE) at = now + 2 * MINUTE;
  } else {
    at = now + Math.max(MINUTE, Math.round(minMs / 2));
  }
  const shift = bestReplyHourShift(at, replyHours);
  if (shift > 0) at += shift;
  if (inQuietHours(at, qcfg)) at = quietEndAfter(at, qcfg) + Math.round(random() * 20 * MINUTE);
  return at;
}

/**
 * 造排程器（内存态或落盘）。
 * @param {object} o
 * @param {()=>object} o.settings 读配置（scheduleConfig 形状）
 * @param {string|(()=>string)} [o.file] 状态文件；不传=内存态
 * @param {(reason:string, meta:object)=>Promise<any>} o.run 一轮回味入口
 * @param {()=>number} [o.now]
 * @param {()=>number} [o.random]
 * @param {object} [o.hooks] { read, write, onError }
 */
export function createSchedule({
  settings = () => ({}), file = '', run, now = () => Date.now(), random = Math.random, hooks = {},
} = {}) {
  let inFlight = false;
  let lastIgniteAt = 0;
  let state = null;
  const fileOf = () => (typeof file === 'function' ? file() : file);
  const dayKeyOf = (t) => new Date(t).toDateString();

  function load(nowMs = now()) {
    const f = fileOf();
    if (!f) {
      /** 内存态：只初始化一次，绝不用空态覆盖内存里的账 */
      if (!state) state = {};
    } else {
      let raw = null;
      try {
        if (hooks.read) raw = hooks.read(f);
        else if (existsSync(f)) raw = JSON.parse(readFileSync(f, 'utf8'));
      } catch { raw = null; }
      state = raw && typeof raw === 'object' ? raw : {};
    }
    if (state.day !== dayKeyOf(nowMs)) {
      state.day = dayKeyOf(nowMs);
      state.countToday = 0;
    }
    state.lastRunAt = Number(state.lastRunAt) || 0;
    state.nextFireAt = Number(state.nextFireAt) || 0;
    state.countToday = Number(state.countToday) || 0;
    state.replyHours = Array.isArray(state.replyHours) && state.replyHours.length === 24 ? state.replyHours : new Array(24).fill(0);
    state.replyHoursSeen = Array.isArray(state.replyHoursSeen) ? state.replyHoursSeen : [];
    return state;
  }
  const save = () => {
    const f = fileOf();
    if (!f) return;
    try {
      if (hooks.write) hooks.write(f, state);
      else writeFileSync(f, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) { hooks.onError?.(e); }
  };

  /** 主人回话时刻直方图（24 桶，按 id 去重）。 */
  function recordReply(at, id = '') {
    load();
    const t = Number(at) || 0;
    if (!t || t > now()) return;
    const key = String(id || `t:${t}`);
    if (state.replyHoursSeen.includes(key)) return;
    state.replyHoursSeen.push(key);
    state.replyHoursSeen = state.replyHoursSeen.slice(-200);
    state.replyHours[new Date(t).getHours()] += 1;
    save();
  }

  /** 每分钟调用：到点就跑一轮，防重入。 */
  async function tick() {
    if (inFlight) return { ran: false, why: 'in-flight' };
    const t = now();
    load(t);
    const cfg = scheduleConfig(settings());
    if (!cfg.enabled) return { ran: false, why: 'disabled' };
    if (inQuietHours(t, quietOf(cfg))) {
      if (!state.nextFireAt) { state.nextFireAt = quietEndAfter(t, quietOf(cfg)); save(); }
      return { ran: false, why: 'quiet' };
    }
    if (state.nextFireAt && t < state.nextFireAt) return { ran: false, why: 'waiting', nextFireAt: state.nextFireAt };
    inFlight = true;
    try {
      /**
       * 先排下次、再跑（P1 修复）：次数**等 run 真跑完才加**。
       * 以前是先 `countToday += 1` 再 run——run 抛错时额度白扣一次，
       * 一天几次失败就把自动节奏耗光了。
       */
      const nextCount = state.countToday + 1;
      state.lastRunAt = t;
      state.nextFireAt = computeNextFire({ now: t, cfg, lastRunAt: t, countToday: nextCount, replyHours: state.replyHours, random });
      save();
      const r = await run?.('schedule', { at: t });
      state.countToday = nextCount;
      save();
      return { ran: true, result: r, nextFireAt: state.nextFireAt };
    } catch (e) {
      hooks.onError?.(e);
      return { ran: false, why: `error:${e?.message || e}` };
    } finally {
      inFlight = false;
    }
  }

  /** 心念点火（事件驱动，带冷却）：想立刻回味一次时用。 */
  async function ignite(reason = 'ignite') {
    const cfg = scheduleConfig(settings());
    const t = now();
    if (t - lastIgniteAt < cfg.igniteCooldownMinutes * MINUTE) {
      return { ran: false, why: 'cooldown', retryAt: lastIgniteAt + cfg.igniteCooldownMinutes * MINUTE };
    }
    lastIgniteAt = t;
    return tick() || run?.(reason, { at: t });
  }

  function view(t = now()) {
    load(t);
    const cfg = scheduleConfig(settings());
    return {
      enabled: cfg.enabled,
      nextFireAt: state.nextFireAt || 0,
      lastRunAt: state.lastRunAt || 0,
      countToday: state.countToday || 0,
      maxPerDay: cfg.maxPerDay,
      awakeFrom: cfg.awakeFrom,
      awakeTo: cfg.awakeTo,
      quietNow: inQuietHours(t, quietOf(cfg)),
      replyHours: state.replyHours,
    };
  }

  return { tick, ignite, recordReply, view, load, _state: () => state };
}
