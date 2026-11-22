/**
 * 贴表情的判定逻辑。
 *
 * 这个模块的风险非常具体：它**会真往用户私聊里发图**。所以每一道门闸
 * 都要有测试踩住——少一道就是一个半夜发图、或者一天贴三十次的 bug，
 * 而在本地开发时几乎不可能自然复现（要等定时器、要等隔天）。
 *
 * 所有测试都把 `now` / `roll` 注进去，不依赖真实时间，也不掷真骰子。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldPost, inAwakeWindow, POST_DEFAULTS } from '../src/sticker-post.js';

/** 2026-11-22 是周六，取一个下午三点：既不在免打扰时段外，也不是跨日边界 */
const NOON = new Date(2026, 10, 22, 15, 0, 0).getTime();

const on = (over = {}) => ({ ...POST_DEFAULTS, enabled: true, ...over });
/** 掷骰子永远命中（0 一定小于任何正概率） */
const always = () => 0;
/** 掷骰子永远不命中 */
const never = () => 0.999999;

test('贴表情：关着就一次都不判定', () => {
  const r = shouldPost({ cfg: { ...POST_DEFAULTS, enabled: false }, now: NOON, roll: always });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'off');
});

test('贴表情：免打扰时段不贴（半夜三点）', () => {
  const three = new Date(2026, 10, 22, 3, 0, 0).getTime();
  const r = shouldPost({ cfg: on(), now: three, roll: always });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quiet');
});

test('贴表情：当天次数用完就不贴，哪怕骰子必中', () => {
  const r = shouldPost({
    cfg: on({ maxPerDay: 3 }),
    state: { day: '2026-11-22', count: 3, lastAt: 0 },
    now: NOON,
    roll: always,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'daily');
});

test('贴表情：换了一天，次数重新算', () => {
  const r = shouldPost({
    cfg: on({ maxPerDay: 3 }),
    /** 昨天的 3 次不该压今天的额度 */
    state: { day: '2026-11-21', count: 3, lastAt: NOON - 24 * 3600_000 },
    now: NOON,
    roll: always,
  });
  assert.equal(r.ok, true);
});

test('贴表情：两次没隔够时间就不贴', () => {
  const r = shouldPost({
    cfg: on({ minGapMinutes: 90 }),
    state: { day: '2026-11-22', count: 1, lastAt: NOON - 30 * 60_000 },
    now: NOON,
    roll: always,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gap');
});

test('贴表情：间隔够了才继续判定', () => {
  const r = shouldPost({
    cfg: on({ minGapMinutes: 90 }),
    state: { day: '2026-11-22', count: 1, lastAt: NOON - 120 * 60_000 },
    now: NOON,
    roll: always,
  });
  assert.equal(r.ok, true);
});

test('贴表情：心情系数——心情好概率高，心情差几乎为零', () => {
  const base = on({ chance: 0.25, moodWeight: true });
  /** 一般心情（0）：0.25 × 0.5 = 0.125 */
  const mid = shouldPost({ cfg: base, now: NOON, valence: 0, roll: () => 0.13 });
  assert.equal(mid.ok, false, '0.13 已经超过 0.125，不该贴');
  const mid2 = shouldPost({ cfg: base, now: NOON, valence: 0, roll: () => 0.12 });
  assert.equal(mid2.ok, true, '0.12 在 0.125 以内，应该贴');

  /** 心情差（-0.5）：0.25 × 0 = 0，再小的骰子也过不了 */
  const sad = shouldPost({ cfg: base, now: NOON, valence: -0.5, roll: () => 0 });
  assert.equal(sad.ok, false);
  assert.equal(sad.reason, 'luck');

  /** 心情好（+0.5）：0.25 × 1 = 0.25 */
  const happy = shouldPost({ cfg: base, now: NOON, valence: 0.5, roll: () => 0.24 });
  assert.equal(happy.ok, true);
});

test('贴表情：关掉心情系数就是纯基础概率', () => {
  const cfg = on({ chance: 0.25, moodWeight: false });
  /** 心情再差也不打折 */
  const r = shouldPost({ cfg, now: NOON, valence: -1, roll: () => 0.2 });
  assert.equal(r.ok, true);
});

test('贴表情：概率永远落在 0~1，心情爆表也不会超过 100%', () => {
  const cfg = on({ chance: 1, moodWeight: true });
  const r = shouldPost({ cfg, now: NOON, valence: 1, roll: never });
  /** 1 × (0.5 + 1) = 1.5，被 clamp 到 1；never() 返回 0.999999 < 1，仍然命中 */
  assert.equal(r.ok, true);
  assert.equal(r.chance, 1);
});

test('免打扰时段：跨夜写法（22 点到次日 6 点）', () => {
  assert.equal(inAwakeWindow(23, 22, 6), true);
  assert.equal(inAwakeWindow(3, 22, 6), true);
  assert.equal(inAwakeWindow(12, 22, 6), false);
  /** 不跨夜 */
  assert.equal(inAwakeWindow(10, 9, 23), true);
  assert.equal(inAwakeWindow(8, 9, 23), false);
  /** 起止相同视为不禁 */
  assert.equal(inAwakeWindow(4, 0, 0), true);
});
