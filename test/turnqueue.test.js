// 排队：并发度必须恒为 1，且「后来的不许丢」。
//
// 这块最怕的两种错：
//   ① 并发度 > 1 —— 等于没排队，`memState` / `lastTurn` 互相覆盖；
//   ② 队列永远不释放 —— 一个卡死拖死整个群，只能重启插件。
// 所以每条边界单独锁一遍。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnQueue } from '../src/turnqueue.js';

/** 假时钟 + 手动控制的任务 */
function rig(opts = {}) {
  let t = 1_000_000;
  const q = createTurnQueue({
    /** 测试里不 unref：否则没有别的活任务时看门狗定时器永远不触发 */
    unref: false,
    now: () => t,
    minBudgetMs: 30_000,
    capMs: 60_000,
    maxPending: 2,
    ...opts,
  });
  const tick = (ms) => {
    t += ms;
  };
  return { q, tick, now: () => t };
}

/** 造一个「跑完由我决定」的任务 */
function deferred() {
  let release;
  let reject;
  const promise = new Promise((res, rej) => {
    release = res;
    reject = rej;
  });
  let started = 0;
  return {
    task: async () => {
      started += 1;
      return promise;
    },
    release,
    reject,
    get started() {
      return started;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test('排队：空闲时立刻执行，不排', async () => {
  const { q } = rig();
  let ran = 0;
  const r = q.push('g1', async () => {
    ran += 1;
  });
  assert.equal(r.accepted, true);
  assert.equal(r.queued, false);
  await r.promise;
  assert.equal(ran, 1);
  q.dispose();
});

test('排队：同一会话并发度恒为 1，按 FIFO 依次跑', async () => {
  const { q } = rig();
  const order = [];
  let running = 0;
  let peak = 0;
  const mk = (name) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, 5));
    order.push(`end:${name}`);
    running -= 1;
  };
  const a = q.push('g1', mk('a'));
  const b = q.push('g1', mk('b'));
  const c = q.push('g1', mk('c'));
  assert.equal(a.queued, false);
  assert.equal(b.queued, true);
  assert.equal(c.queued, true);
  await Promise.all([a.promise, b.promise, c.promise]);
  assert.equal(peak, 1, '同一时刻只能有一个任务在跑');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  q.dispose();
});

test('排队：不同会话互不影响', async () => {
  const { q } = rig();
  const d1 = deferred();
  const d2 = deferred();
  const a = q.push('g1', d1.task);
  const b = q.push('g2', d2.task);
  assert.equal(a.queued, false);
  assert.equal(b.queued, false, '两个会话应该各自立刻开跑');
  d1.release();
  d2.release();
  await Promise.all([a.promise, b.promise]);
  q.dispose();
});

test('排队：队列满 → full，且那条不执行', async () => {
  const { q } = rig({ maxPending: 1 });
  const d = deferred();
  const first = q.push('g1', d.task);
  const second = q.push('g1', async () => {});
  const third = q.push('g1', async () => {});
  assert.equal(first.queued, false);
  assert.equal(second.queued, true);
  assert.equal(third.accepted, false);
  assert.equal(third.reason, 'full');
  d.release();
  await first.promise;
  await second.promise;
  q.dispose();
});

test('排队：预算不够时直接拒，不排队', async () => {
  const { q, now } = rig();
  const d = deferred();
  const first = q.push('g1', d.task);
  // 只剩 10 秒，低于 30 秒的最小预算
  const r = q.push('g1', async () => {}, { deadline: now() + 10_000 });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'expired');
  d.release();
  await first.promise;
  q.dispose();
});

test('排队：排队期间过窗口 → 出队时丢弃，不跑', async () => {
  const { q, tick, now } = rig();
  const d = deferred();
  let secondRan = false;
  const first = q.push('g1', d.task);
  const second = q.push('g1', async () => {
    secondRan = true;
  }, { deadline: now() + 40_000 });
  assert.equal(second.queued, true);

  // 跑着的时候时间过去了 20 秒 → 剩 20 秒 < 30 秒预算
  tick(20_000);
  d.release();
  await first.promise;
  const r = await second.promise;
  assert.equal(secondRan, false, '过窗口的不该跑');
  assert.equal(r.reason, 'expired');
  q.dispose();
});

test('排队：任务抛错不会卡死队列', async () => {
  const { q } = rig();
  const a = q.push('g1', async () => {
    throw new Error('boom');
  });
  const b = q.push('g1', async () => {});
  await a.promise;
  const rb = await b.promise;
  assert.equal(rb.ok, true, '前一个失败不影响后一个');
  q.dispose();
});

test('排队：看门狗到点强放槽位，晚到的完成不会二次释放', async () => {
  const { q } = rig({ capMs: 50 });
  const stuck = deferred();
  const a = q.push('g1', stuck.task);
  const b = q.push('g1', async () => {});
  const ra = await a.promise;
  assert.equal(ra.ok, false);
  assert.equal(ra.reason, 'timeout');
  const rb = await b.promise;
  assert.equal(rb.ok, true, '强放之后下一条要能跑');

  // 原来那条这时才返回：不该再动队列
  stuck.release();
  await flush();
  assert.equal(q.stats().busy, 0);
  q.dispose();
});

test('排队：钉住表 —— 同一个 chatId 的 key 变了，仍然进同一条队列', async () => {
  let sessionId = '';
  const { q } = rig({ resolveKey: () => sessionId || 'g1' });
  const d = deferred();
  const a = q.push('g1', d.task);
  assert.equal(a.queued, false);

  /** 模拟 agentFor 在建会话之后才把 sid 写上 */
  sessionId = 'sid-1';

  const b = q.push('g1', async () => {});
  assert.equal(b.queued, true, 'key 变了也必须排在同一条队列里，否则首轮分叉');

  d.release();
  await a.promise;
  await b.promise;
  q.dispose();
});

test('排队：队列排空后才解除钉住', async () => {
  let n = 0;
  const { q } = rig({ resolveKey: () => `k${++n}` });
  const a = q.push('g1', async () => {});
  await a.promise;
  // 排空之后重新解析，应该拿到新的 key（说明钉住被清掉了）
  const b = q.push('g1', async () => {});
  assert.equal(b.queued, false);
  await b.promise;
  q.dispose();
});

test('排队：isBusy 只看在跑的，不看排队的', async () => {
  const { q } = rig();
  const d = deferred();
  const a = q.push('g1', d.task);
  assert.equal(q.isBusy('g1'), true);
  assert.equal(q.isBusy('g2'), false);
  d.release();
  await a.promise;
  assert.equal(q.isBusy('g1'), false);
  q.dispose();
});

test('排队：dispose 清定时器并放弃排队项', async () => {
  const { q } = rig();
  const d = deferred();
  q.push('g1', d.task);
  const b = q.push('g1', async () => {});
  q.dispose();
  const rb = await b.promise;
  assert.equal(rb.reason, 'disposed');
  assert.equal(q.stats().pending, 0);
  assert.equal(q.push('g1', async () => {}).accepted, false, 'dispose 之后不再接受');
});
