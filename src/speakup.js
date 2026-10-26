/**
 * 主动搭话：主人一阵子没找你，你主动在私聊里说句话。
 *
 * 照 Aurabot（`features/companion.js`）的做法，几条关键设计都是抄的：
 *
 *   1. **只在私聊，不在群里**——群里主动说话就是骚扰
 *   2. **随机间隔**，不是固定周期——固定周期一眼就是机器人
 *   3. **免打扰时段**——半夜三点找你聊天是灾难
 *   4. **只看私聊冷场**——群里再热闹，只要你没私聊她，她照样来找你
 *   5. **追问只追一次**——上次主动说了你没理，就不再追，免得像催债
 *   6. **首次只排期不触发**——不能让 DSH 一启动就收到一句「在吗」
 *
 * 我们自己加一条：**每日上限**。官方主动消息有配额（20 条/分、每群 1000 条/天），
 * 而且这是私聊，多了比不说更烦。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MINUTE = 60_000;

/** 默认配置 */
export const DEFAULTS = {
  enabled: false,
  /** 主人私聊的 openid。空 = 不工作（不知道怎么发） */
  chatId: '',
  /** 免打扰：只在 [awakeFrom, awakeTo) 之间说话，小时 */
  awakeFrom: 8,
  awakeTo: 23,
  /** 随机间隔范围（分钟）。太小会烦，太大会忘 */
  minIntervalMinutes: 180,
  maxIntervalMinutes: 480,
  /** 每天最多主动几次 */
  maxPerDay: 3,
  /** 给 AI 的指令 */
  prompt:
    '主人有一阵子没找你了。主动发一条私聊消息给他，简短、自然，像朋友随口搭话。'
    + '不要问「在吗」，不要解释你为什么突然说话，不要提这是定时任务。一句话就够。',
};

/** 这一小时在不在清醒时段内（跨零点也支持，比如 22 → 6） */
export function inAwakeWindow(hour, from, to) {
  if (from === to) return true; // 全天
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * 该不该现在说话。
 *
 * 抽成纯函数是为了能测——时间相关的逻辑最容易写错，
 * 而它错了的表现是「半夜三点被机器人叫醒」，代价太大。
 *
 * @param {object} state { nextAt, todayCount, day, lastOwnerAt, lastBotAt }
 * @param {object} cfg
 * @param {number} now
 * @returns {{fire:boolean, why:string}}
 */
export function shouldFire(state, cfg, now) {
  if (!cfg.enabled) return { fire: false, why: '没开' };
  if (!cfg.chatId) return { fire: false, why: '没配 chatId' };

  const hour = new Date(now).getHours();
  if (!inAwakeWindow(hour, cfg.awakeFrom, cfg.awakeTo)) {
    return { fire: false, why: `免打扰（${cfg.awakeFrom}–${cfg.awakeTo} 点）` };
  }

  // 跨天了就把计数归零
  const day = new Date(now).toDateString();
  const count = state.day === day ? state.todayCount || 0 : 0;
  if (count >= (cfg.maxPerDay ?? DEFAULTS.maxPerDay)) {
    return { fire: false, why: `今天已经说了 ${count} 次` };
  }

  // 主人刚说过话，不用主动
  if (state.lastOwnerAt && now - state.lastOwnerAt < (cfg.minIntervalMinutes ?? 180) * MINUTE) {
    return { fire: false, why: '主人刚说过话' };
  }

  if (!state.nextAt || now < state.nextAt) {
    return { fire: false, why: '还没到时间' };
  }

  return { fire: true, why: '到点了' };
}

/** 下一次什么时候（在 [min, max] 之间随机） */
export function scheduleNext(cfg, now = Date.now()) {
  const min = Math.max(1, cfg.minIntervalMinutes ?? DEFAULTS.minIntervalMinutes);
  const max = Math.max(min, cfg.maxIntervalMinutes ?? DEFAULTS.maxIntervalMinutes);
  return now + (min + Math.random() * (max - min)) * MINUTE;
}

export function createSpeakUp({ dataDir, cfgOf, generate, send, log = () => {} }) {
  const file = () => join(dataDir, 'speakup.json');

  let state = { nextAt: 0, todayCount: 0, day: '', lastOwnerAt: 0, lastBotAt: 0, lastText: '' };
  try {
    state = { ...state, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {}

  function save() {
    try {
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(state), 'utf8');
    } catch (e) {
      log(`主动搭话状态存不下来：${e.message}`);
    }
  }

  /** 收到主人的消息时调一下，用来算冷场 */
  function noteOwner(chatId) {
    const cfg = { ...DEFAULTS, ...(cfgOf().speakUp ?? {}) };
    if (!cfg.chatId || chatId !== cfg.chatId) return;
    state.lastOwnerAt = Date.now();
    // 主人回来了，重新排期
    state.nextAt = scheduleNext(cfg);
    save();
  }

  async function fire(reason = '定时') {
    const cfg = { ...DEFAULTS, ...(cfgOf().speakUp ?? {}) };
    try {
      const text = String((await generate(cfg.prompt)) ?? '').trim();
      if (!text) return { ok: false, message: 'AI 没说话' };

      const r = await send({ scene: 'c2c', target: cfg.chatId, text });
      if (!r?.ok) return { ok: false, message: r?.message || '发失败' };

      state.lastBotAt = Date.now();
      state.lastText = text.slice(0, 100);
      state.todayCount = (state.day === new Date().toDateString() ? state.todayCount : 0) + 1;
      state.day = new Date().toDateString();
      state.nextAt = scheduleNext(cfg);
      save();

      log(`主动找主人说话了（${reason}）：${text.slice(0, 40)}`);
      return { ok: true, text };
    } catch (e) {
      log(`主动搭话失败：${e?.message ?? e}`);
      // 失败了也排下一次，不然会每分钟重试一次
      state.nextAt = scheduleNext(cfg);
      save();
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  /** 每分钟跑一次 */
  async function tick(now = Date.now()) {
    const cfg = { ...DEFAULTS, ...(cfgOf().speakUp ?? {}) };
    if (!cfg.enabled || !cfg.chatId) return { ok: false, why: '没开' };

    // 第一次只排期，不触发——不能让 DSH 一启动就发一句「在吗」
    if (!state.nextAt) {
      state.nextAt = scheduleNext(cfg, now);
      save();
      return { ok: false, why: '首次排期' };
    }

    const d = shouldFire(state, cfg, now);
    if (!d.fire) return { ok: false, why: d.why };
    return fire('定时');
  }

  return {
    tick,
    fire,
    noteOwner,
    state: () => ({ ...state }),
  };
}
