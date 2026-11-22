/**
 * 贴表情：她**主动**往会话里发一张图库里的图。
 *
 * ## 为什么默认关、默认只私聊
 *
 * 这是整个插件里唯一「没人问她、她自己往外发图片」的行为。群里主动贴图
 * 在别人看来就是刷屏，而且占官方主动消息额度（20 条/分、每群 1000 条/天）。
 * 主动搭话（`speakup.js`）已经定了「只在私聊」这条线，这里沿用。
 *
 * ## 概率不是独立掷骰子
 *
 * `chance × (0.5 + valence)`：心情好（valence > 0）时更容易贴，心情差时
 * 几乎不贴。`mood.js` 那三个数一直只用来「注入语气」，没接到任何行为上——
 * 这是第一处真正用它做决策的地方。
 *
 * 门闸顺序按「越便宜越先判」排：开关 → 时段 → 当日次数 → 间隔 → 概率。
 * 概率放最后，因为它是唯一带随机性的：先掷骰子再查配额，会让人误以为
 * 「今天还能贴 3 次」，实际每次都在掷。
 *
 * ## 和主动搭话是两本账
 *
 * `speakup` 记的是「今天主动说了几句话」，这里记的是「今天贴了几张图」。
 * 合成一本的话，贴一张图会把「我还想跟你说句话」的额度吃掉。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 默认配置。`config.js` 里有一份同样的默认值，这里兜底是为了单测能脱离配置跑 */
export const POST_DEFAULTS = {
  enabled: false,
  onlyPrivate: true,
  chance: 0.25,
  maxPerDay: 3,
  minGapMinutes: 90,
  moodWeight: true,
  onlyDescribed: true,
  awakeFrom: 9,
  awakeTo: 23,
};

/** 调度间隔：十分钟看一次。比 speakup 密，因为每次都要重新掷骰子 */
const TICK_MS = 10 * 60_000;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

/** 本地日期键，用来判「今天」翻页。用 UTC 的话东八区早上 8 点才算新的一天 */
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 时段判断。`from > to` 视为跨夜（22 点到次日 6 点）。
 *
 * 和 `speakup.js` 的 `inAwakeWindow` 同一套语义，但没复用它：
 * 那个函数的参数是 (hour, from, to)，看着一样，实际上 speakup 的默认值
 * 和这里不同（那边 8-23，这边 9-23）。复用一个「看起来一样」的函数，
 * 以后改一边就会悄悄改掉另一边。
 */
export function inAwakeWindow(hour, from, to) {
  const h = Number(hour);
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(h) || !Number.isFinite(a) || !Number.isFinite(b)) return true;
  if (a === b) return true;
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}

/**
 * 该不该贴。**纯函数**，随机源从外面传（`roll`），所以能精确测。
 *
 * @param {object} o
 * @param {object} [o.cfg]     `stickers.post` 段
 * @param {object} [o.state]   `{ day, count, lastAt }`
 * @param {number} [o.now]
 * @param {number} [o.valence] -1~1，心情好坏
 * @param {() => number} [o.roll]
 * @returns {{ ok: boolean, reason?: string, chance?: number }}
 */
export function shouldPost({ cfg = {}, state = {}, now = Date.now(), valence = 0, roll = Math.random } = {}) {
  const c = { ...POST_DEFAULTS, ...cfg };
  if (c.enabled !== true) return { ok: false, reason: 'off' };

  const hour = new Date(now).getHours();
  if (!inAwakeWindow(hour, c.awakeFrom, c.awakeTo)) return { ok: false, reason: 'quiet' };

  const day = dayKey(now);
  const count = state?.day === day ? Number(state.count) || 0 : 0;
  if (count >= Math.max(1, Number(c.maxPerDay) || 3)) return { ok: false, reason: 'daily' };

  const lastAt = Number(state?.lastAt) || 0;
  const gapMs = Math.max(0, Number(c.minGapMinutes) || 0) * 60_000;
  if (lastAt && now - lastAt < gapMs) return { ok: false, reason: 'gap' };

  /**
   * 心情系数。开：`chance × (0.5 + valence)`——`valence = 0` 时是一半，
   * 这是有意的：心情数据大多是中性（0），不折半的话「心情系数」等于没开。
   *
   * 关：**直接用 `chance`**，不再乘那个 0.5。第一版这里两种分支共用
   * `(0.5 + v)`，于是「关掉心情系数」等于「永远按心情最差算」——
   * 界面上关了一个开关，实际概率掉一半，没有任何地方会提示。
   */
  const chance = c.moodWeight
    ? clamp((Number(c.chance) || 0) * (0.5 + clamp(valence, -1, 1)), 0, 1)
    : clamp(Number(c.chance) || 0, 0, 1);
  if (roll() >= chance) return { ok: false, reason: 'luck', chance };
  return { ok: true, chance };
}

/**
 * @param {object} o
 * @param {string} o.dataDir  数据根目录（记账文件放 `<dataDir>/stickers/post-state.json`）
 * @param {() => object} o.cfgOf
 * @param {(cfg:object) => ({seq:number, path:string, name?:string}|null)} o.pickSticker
 * @param {(pick:object, cfg:object) => Promise<{ok:boolean, message?:string}>} o.sendSticker
 * @param {() => number} [o.valenceOf]
 * @param {(m:string)=>void} [o.log]
 * @param {() => number} [o.now]
 * @param {() => number} [o.roll]
 */
export function createStickerPost({
  dataDir,
  cfgOf = () => ({}),
  pickSticker = () => null,
  sendSticker = async () => ({ ok: false, message: '没有发送通道' }),
  valenceOf = () => 0,
  log = () => {},
  now = () => Date.now(),
  roll = Math.random,
} = {}) {
  const statePath = () => join(dataDir, 'stickers', 'post-state.json');

  const readState = () => {
    try {
      const j = JSON.parse(readFileSync(statePath(), 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  };

  const writeState = (s) => {
    try {
      mkdirSync(dirname(statePath()), { recursive: true });
      writeFileSync(statePath(), JSON.stringify(s, null, 2));
    } catch (e) {
      /** 记不上账只影响「今天多贴一张」，不值得让这次发送算失败 */
      log(`贴表情记账写不进去：${e?.message ?? e}`);
    }
  };

  let timer = null;
  let last = null;

  const tick = async () => {
    const cfg = cfgOf() || {};
    const state = readState();
    const verdict = shouldPost({ cfg, state, now: now(), valence: valenceOf(), roll });
    if (!verdict.ok) {
      last = { at: now(), ...verdict };
      return last;
    }

    const pick = pickSticker(cfg);
    if (!pick?.path) {
      last = { at: now(), ok: false, reason: 'no-pick' };
      return last;
    }

    const r = await sendSticker(pick, cfg);
    if (!r?.ok) {
      /**
       * 发失败**不记账**：占额度的话，网络抖一下就白白少一次机会；
       * 不占的话如果对方一直失败，会每十分钟试一次——但那是故障状态，
       * 日志里看得见，比静默扣光额度好。
       */
      log(`贴表情没发出去（#${pick.seq}）：${r?.message || '未知原因'}`);
      last = { at: now(), ok: false, reason: 'send', message: r?.message || '' };
      return last;
    }

    const day = dayKey(now());
    writeState({
      day,
      count: (state?.day === day ? Number(state.count) || 0 : 0) + 1,
      lastAt: now(),
    });
    log(`贴了一张表情（#${pick.seq} ${pick.name || ''}）`);
    last = { at: now(), ok: true, seq: pick.seq, name: pick.name || '' };
    return last;
  };

  return {
    /**
     * 开始调度。
     *
     * **不立刻 tick**：和 speakup 的「首次只排期不触发」同一条规矩——
     * DSH 一启动就收到一张莫名其妙的表情，比不发更糟。
     */
    start() {
      if (timer) return;
      timer = setInterval(() => { tick().catch((e) => log(`贴表情出错：${e?.message ?? e}`)); }, TICK_MS);
      /** 别让这个定时器把进程钉住不让退出（测试 / CLI 单跑时很要紧） */
      if (typeof timer?.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    /** 面板「刚才贴了没」用；也方便排障 */
    last: () => last,
    shouldPost,
  };
}
