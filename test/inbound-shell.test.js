// 入站薄壳：排队/回话这几条分支必须锁死。
//
// 这块最容易出的错是「静默」——把消息丢了还不吭声，或者把「排满了」
// 记成「这一轮失败了」。两条都在这里单独锁一遍。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnQueue } from '../src/turnqueue.js';
import { createInboundShell } from '../src/inbound-shell.js';

function rig({ queue = {}, replies = [], handled = [] } = {}) {
  let t = 1_000_000;
  const q = createTurnQueue({ now: () => t, unref: false, minBudgetMs: 30_000, ...queue });
  const shell = createInboundShell({
    q,
    chatOf: (p) => p?.chat?.chatId ?? '',
    now: () => t,
    handleTurn: async (p) => {
      handled.push(p.id);
    },
    postReply: async (_p, text) => {
      replies.push(text);
    },
  });
  return { q, shell, replies, handled, tick: (ms) => (t += ms), now: () => t };
}

const payload = (id, chatId = 'g1', extra = {}) => ({
  id,
  chat: { chatId, kind: 'group' },
  reply: { url: 'http://127.0.0.1/x', token: 't', expiresAt: 1_000_000 + 180_000 },
  ...extra,
});

const flush = () => new Promise((r) => setImmediate(r));

test('薄壳：空闲时直接跑，不回话', async () => {
  const { shell, replies, handled } = rig();
  shell.onInbound(payload('m1'));
  await flush();
  assert.deepEqual(handled, ['m1']);
  assert.deepEqual(replies, []);
});

test('薄壳：没 chatId 直接忽略（和以前一致）', async () => {
  const { shell, handled, replies } = rig();
  shell.onInbound({ id: 'x', chat: {} });
  await flush();
  assert.deepEqual(handled, []);
  assert.deepEqual(replies, []);
});

test('薄壳：忙时入队，不吭声；轮到就跑', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const handled = [];
  const replies = [];
  const q = createTurnQueue({ now: () => 1_000_000, unref: false });
  const shell = createInboundShell({
    q,
    chatOf: (p) => p.chat.chatId,
    now: () => 1_000_000,
    handleTurn: async (p) => {
      handled.push(p.id);
      if (p.id === 'm1') await gate;
    },
    postReply: async (_p, text) => replies.push(text),
  });

  shell.onInbound(payload('m1'));
  shell.onInbound(payload('m2'));
  await flush();
  assert.deepEqual(handled, ['m1'], 'm2 还在排队，不该开始');
  assert.deepEqual(replies, [], '入队不吭声');

  release();
  await flush();
  await flush();
  assert.deepEqual(handled, ['m1', 'm2']);
  assert.deepEqual(replies, []);
});

test('薄壳：队列满 → 回旧文案，且不进 handleTurn', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const handled = [];
  const replies = [];
  const q = createTurnQueue({ now: () => 1_000_000, unref: false, maxPending: 1 });
  const shell = createInboundShell({
    q,
    chatOf: (p) => p.chat.chatId,
    now: () => 1_000_000,
    handleTurn: async (p) => {
      handled.push(p.id);
      if (p.id === 'm1') await gate;
    },
    postReply: async (_p, text) => replies.push(text),
  });

  shell.onInbound(payload('m1'));
  shell.onInbound(payload('m2'));
  shell.onInbound(payload('m3')); // 队列只有 1 个位，这条被拒
  await flush();
  assert.deepEqual(handled, ['m1']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /上一条还在想/);
  release();
});

test('薄壳：预算不够 → 回「没赶上」，且不进 handleTurn', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const handled = [];
  const replies = [];
  const q = createTurnQueue({ now: () => 1_000_000, unref: false });
  const shell = createInboundShell({
    q,
    chatOf: (p) => p.chat.chatId,
    now: () => 1_000_000,
    handleTurn: async (p) => {
      handled.push(p.id);
      if (p.id === 'm1') await gate;
    },
    postReply: async (_p, text) => replies.push(text),
  });

  shell.onInbound(payload('m1'));
  /** 只剩 5 秒，低于 30 秒最小预算 */
  shell.onInbound(payload('m2', 'g1', { reply: { expiresAt: 1_000_000 + 5_000 } }));
  await flush();
  assert.deepEqual(handled, ['m1']);
  assert.match(replies[0] ?? '', /没赶上/);
  release();
});

test('薄壳：没有 expiresAt 时按 180 秒兜底，不当成「已过期」', async () => {
  const { shell, handled, replies } = rig();
  shell.onInbound({ id: 'm1', chat: { chatId: 'g1' } });
  await flush();
  assert.deepEqual(handled, ['m1']);
  assert.deepEqual(replies, []);
});

test('薄壳：回话失败不影响别的', async () => {
  const q = createTurnQueue({ now: () => 1_000_000, unref: false, maxPending: 0 });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const shell = createInboundShell({
    q,
    chatOf: (p) => p.chat.chatId,
    now: () => 1_000_000,
    handleTurn: async () => {
      await gate;
    },
    postReply: async () => {
      throw new Error('通道死了');
    },
  });
  shell.onInbound(payload('m1'));
  shell.onInbound(payload('m2')); // 队列关着 + 忙 → 直接回话 → 抛错
  await flush();
  release();
  await flush();
  // 没有 unhandled rejection 就算过
});
