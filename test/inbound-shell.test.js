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
    chatIdOf: (p) => p?.chat?.chatId ?? '',
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
    chatIdOf: (p) => p.chat.chatId,
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
    chatIdOf: (p) => p.chat.chatId,
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
    chatIdOf: (p) => p.chat.chatId,
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
    chatIdOf: (p) => p.chat.chatId,
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

/**
 * 2026-11 线上形态：`host` 把返回**对象**的 `chatOf` 当 `chatIdOf` 传进来。
 * `String(对象)` 恒为 `"[object Object]"` → 全进程一条 lane，第三个会话的
 * 消息被「上一条还在想」拒掉且不重试；`isBusy(真实 chatId)` 还恒为 false，
 * 「主人正在聊就别插话」一起失效。
 *
 * 这条用例的桩**故意返回对象**，锁住「对象也不能把会话挤成一条」。
 */
test('薄壳：chatIdOf 返回对象时按 .chatId 兜底，会话之间不互相堵', async (t) => {
  const logs = [];
  const q = createTurnQueue({ now: () => 1_000_000, unref: false, minBudgetMs: 0, maxPending: 1 });
  /** 用例里的 handleTurn 永不结束，收尾必须清；放 t.after 里，断言失败也能清掉 */
  t.after(() => q.dispose());
  /** 永不结束：把 lane 占住，模拟「上一条还在想」 */
  const shell = createInboundShell({
    q,
    chatIdOf: (p) => ({ chatId: p.chat.chatId, sessionKey: p.chat.chatId }),
    handleTurn: () => new Promise(() => {}),
    postReply: async () => {},
    log: (m) => logs.push(m),
  });

  for (const id of ['u1', 'u2', 'u3']) shell.onInbound(payload('m-' + id, id));

  const stats = q.stats();
  assert.equal(stats.lanes, 3, `三个会话应该是三条 lane，实际 ${stats.lanes}`);
  assert.equal(stats.busy, 3, '三条都在跑');
  assert.equal(q.isBusy('u1'), true, 'isBusy 必须认得真实 chatId');
  assert.equal(logs.filter((m) => m.includes('对象形式')).length, 1, '只报一次，不刷屏');
});

test('薄壳：同一个会话仍然只有一条 lane（兜底不能把隔离搞丢）', async (t) => {
  const q = createTurnQueue({ now: () => 1_000_000, unref: false, minBudgetMs: 0, maxPending: 1 });
  t.after(() => q.dispose());
  const shell = createInboundShell({
    q,
    chatIdOf: (p) => ({ chatId: p.chat.chatId }),
    handleTurn: () => new Promise(() => {}),
    postReply: async () => {},
    log: () => {},
  });
  shell.onInbound(payload('m1', 'g1'));
  shell.onInbound(payload('m2', 'g1'));
  assert.equal(q.stats().lanes, 1, '同一会话共用一个 lane');
});

/**
 * 频道：同一 guild 的多个子频道共用一个 DSH 会话（`sessions` 按 sessionKey 存）。
 * 排队键要是按 chatId 分，它们各占一条 lane 并发跑，撞上 turn 的 busy 锁——
 * 后一条被回「上一条还在想」且不重试，等于丢消息。
 */
test('薄壳：频道子频道按 sessionKey 共用一条 lane', async (t) => {
  const q = createTurnQueue({ now: () => 1_000_000, unref: false, minBudgetMs: 0, maxPending: 1 });
  t.after(() => q.dispose());
  const shell = createInboundShell({
    q,
    chatIdOf: (p) => p.chat.chatId,
    keyOf: (p) => p.chat.sessionKey || p.chat.chatId,
    handleTurn: () => new Promise(() => {}),
    postReply: async () => {},
    log: () => {},
  });

  const guild = (id, ch) => ({
    id,
    chat: { chatId: ch, kind: 'guild', sessionKey: 'guild:g1' },
    reply: { expiresAt: 1_000_000 + 180_000 },
  });
  shell.onInbound(guild('m1', 'ch-A'));
  shell.onInbound(guild('m2', 'ch-B'));

  assert.equal(q.stats().lanes, 1, '同一个 guild 的子频道必须共用一条 lane');
});

test('薄壳：没有 chatId 的消息要留一条日志（限频）', () => {
  const logs = [];
  const q = createTurnQueue({ now: () => 1_000_000, unref: false, minBudgetMs: 0 });
  const shell = createInboundShell({
    q,
    chatIdOf: () => '',
    handleTurn: async () => {},
    postReply: async () => {},
    now: () => 1_000_000,
    log: (m) => logs.push(m),
  });
  shell.onInbound({ id: 'x' });
  shell.onInbound({ id: 'y' });
  assert.equal(logs.filter((m) => m.includes('没有 chatId')).length, 1, '同类日志一分钟一条');
  q.dispose();
});
