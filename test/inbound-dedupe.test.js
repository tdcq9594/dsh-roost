/**
 * 入站去重（2026-11-26）
 * ======================
 *
 * 背景：一条「你是谁」在模型上下文里出现三次。根因是官方重推经协议层放大；
 * 框架侧已修，这里是 dsh-roost 的纵深防御（旧框架 / 多连接 / 补拉重放）。
 *
 * 钉住的边界：
 *   · eventId 优先，重推时同一个 id；
 *   · 没有 eventId 时用 chatId + msgId；
 *   · 两个都没有 → 不去重（不能拿假键吞消息）；
 *   · TTL 过期后可再次处理；
 *   · 上限淘汰最旧，长跑进程不涨内存；
 *   · **同一个人真的连发两句相同的话**（不同 msgId）不能被吞。
 *
 * 跑法：node --test test/inbound-dedupe.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createInboundDedupe } from '../src/inbound-dedupe.js';

const evt = (o = {}) => ({
  eventId: 'evt-1',
  msgId: 'msg-1',
  chat: { chatId: 'group-1' },
  content: '你是谁',
  ...o,
});

test('同一个 eventId：第二次就是重复', () => {
  const d = createInboundDedupe();
  assert.equal(d.isDuplicate(evt()), false);
  assert.equal(d.isDuplicate(evt()), true);
  assert.equal(d.isDuplicate(evt()), true);
});

test('不同 eventId：各自独立，哪怕正文一模一样', () => {
  const d = createInboundDedupe();
  assert.equal(d.isDuplicate(evt({ eventId: 'evt-1', msgId: 'msg-1' })), false);
  assert.equal(d.isDuplicate(evt({ eventId: 'evt-2', msgId: 'msg-2' })), false);
});

test('没有 eventId 时退回 chatId + msgId；换群不算同一条', () => {
  const d = createInboundDedupe();
  const a = evt({ eventId: '', msgId: 'm-9', chat: { chatId: 'g-1' } });
  assert.equal(d.isDuplicate(a), false);
  assert.equal(d.isDuplicate(a), true, '同群同 msgId = 重推');
  assert.equal(
    d.isDuplicate(evt({ eventId: '', msgId: 'm-9', chat: { chatId: 'g-2' } })),
    false,
    '不同群的同号 msgId 不是同一条',
  );
});

test('两个 id 都没有：不去重，不能吞消息', () => {
  const d = createInboundDedupe();
  const noId = evt({ eventId: '', msgId: '' });
  assert.equal(d.isDuplicate(noId), false);
  assert.equal(d.isDuplicate(noId), false);
  assert.equal(d.size, 0);
});

test('TTL 过期后，同一个 eventId 可以再次处理', () => {
  let t = 1_000_000;
  const d = createInboundDedupe({ ttlMs: 1000, now: () => t });
  assert.equal(d.isDuplicate(evt()), false);
  assert.equal(d.isDuplicate(evt()), true);
  t += 1001;
  assert.equal(d.isDuplicate(evt()), false, '超过窗口应当放行');
});

test('上限淘汰最旧，size 不无限涨', () => {
  const d = createInboundDedupe({ max: 3 });
  for (let i = 0; i < 10; i += 1) {
    d.isDuplicate(evt({ eventId: `e-${i}`, msgId: `m-${i}` }));
  }
  assert.equal(d.size, 3);
  /** 最新的三条还在，同一条仍是重复 */
  assert.equal(d.isDuplicate(evt({ eventId: 'e-9', msgId: 'm-9' })), true);
});

test('clear 后重新计数', () => {
  const d = createInboundDedupe();
  d.isDuplicate(evt());
  assert.equal(d.isDuplicate(evt()), true);
  d.clear();
  assert.equal(d.size, 0);
  assert.equal(d.isDuplicate(evt()), false);
});

/* ---------- 接线：模块写得再对，host.js 没调也白搭 ---------- */

test('接线：deliverFromRoost 入口先判重，且在 decider 之前', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const at = src.indexOf('function deliverFromRoost(evt) {');
  assert.ok(at > 0, '找不到 deliverFromRoost');

  const body = src.slice(at, at + 1500);
  const dup = body.indexOf('inboundDedupe.isDuplicate(evt)');
  const decide = body.indexOf('roostDecider.check(evt)');
  assert.ok(dup > 0, '入口必须调用 inboundDedupe.isDuplicate');
  assert.ok(decide > 0, '找不到 roostDecider.check');
  /** 放到 decider 之后就晚了：旁听会写日记、判定会推觉醒，重复已经发生 */
  assert.ok(dup < decide, '判重必须在 roostDecider.check 之前');
});
