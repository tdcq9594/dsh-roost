// 上游错误分类 + 插件层补重试
//
// 背景（真实事故，2026-10-27）：
//   DSH 调 DeepSeek 网关，502 连挂两轮。DSH 自己重试 5 次全失败后，
//   turn/end 的 reason 是 { kind:'error', error:{ message:'...', code:'SERVER', status:502 } }。
//   插件没处理这个 kind，结果一坨 JSON 原文被回进 QQ 群。
//
// 同一时刻**用户自己的 DSH 会话也在 502**（最多的那个挂了 63 次），
// 所以这是网关侧的问题，不是插件请求体、也不是「间隔太短」的问题。
//
// 这里锁三件事：
//   1. 502/429/超时 认得出是 upstream（能对人话说）
//   2. upstream 会在插件层重投一轮，其它 kind 不重投（重投只会刷屏）
//   3. **吐过字就不重投**——重投会让人收到两条半截话

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTurnRunner, classifyReason, textOf } from '../src/turn.js';
import { DEFAULTS } from '../src/config.js';

/* ---------------- 分类 ---------------- */

test('分类：502 认成 upstream，状态码带出来', () => {
  const r = classifyReason({
    kind: 'error',
    error: { message: 'DeepSeek Messages request failed (502)', code: 'SERVER', status: 502 },
  });
  assert.equal(r.kind, 'upstream');
  assert.equal(r.status, 502);
  assert.equal(r.code, 'SERVER');
});

test('分类：429 限流也算 upstream', () => {
  const r = classifyReason({ kind: 'error', error: { code: 'RATE_LIMIT', status: 429 } });
  assert.equal(r.kind, 'upstream');
});

test('分类：TIMEOUT / TRANSPORT 也算 upstream', () => {
  assert.equal(classifyReason({ kind: 'error', error: { code: 'TIMEOUT' } }).kind, 'upstream');
  assert.equal(classifyReason({ kind: 'error', error: { code: 'TRANSPORT' } }).kind, 'upstream');
});

test('分类：没有 status 但 code 是 SERVER 也算 upstream', () => {
  assert.equal(classifyReason({ kind: 'error', error: { code: 'SERVER' } }).kind, 'upstream');
});

test('分类：普通 error 不乱认成 upstream', () => {
  const r = classifyReason({ kind: 'error', error: { code: 'BAD_REQUEST', status: 400 } });
  assert.equal(r.kind, 'error');
});

test('分类：blocked 就是 blocked，不能被吞成 upstream', () => {
  assert.equal(classifyReason({ kind: 'blocked' }).kind, 'blocked');
});

test('分类：completed 还是 completed', () => {
  assert.equal(classifyReason({ kind: 'completed' }).kind, 'completed');
});

/* ---------------- 重试 ---------------- */

/** 造一个假的 ctx，能往 session 推事件 */
function fakeDsh() {
  const handlers = [];
  const ctx = {
    on: (name, fn) => {
      handlers.push({ name, fn });
      return () => {};
    },
    sessions: { flush: async () => {} },
  };
  const emit = (session, event) => {
    for (const h of handlers) if (h.name === 'session/event') h.fn(session, event);
  };
  return { ctx, emit };
}

/**
 * 造一个 agent：每次 followup 按脚本回事件。
 *
 * emit 直接绑在 agent 上，不走全局变量——避免「定时器触发时
 * 全局钩子已经被还原」这种时序坑。
 *
 * 脚本元素是**函数**：`fn(turn) => 事件数组`，turn 是本次投递的轮次。
 *
 * @param {Array<Function>} script 第 n 次投递要发的事件
 */
function agentFor(session, script, emit) {
  let n = 0;
  return {
    session,
    followup: async () => {
      n += 1;
      const turn = n;
      const make = script[Math.min(n - 1, script.length - 1)] || (() => []);
      const events = make(turn) || [];
      setTimeout(() => {
        for (const e of events) emit(session, e);
      }, 5);
    },
    get count() {
      return n;
    },
  };
}

/**
 * 保活句柄。
 *
 * 插件里的定时器都 `unref()` 了（不让插件拖住进程退出），
 * 但这也意味着测试里事件循环会「什么都不剩就结束」——
 * 表现为 `Promise resolution is still pending but the event loop has already resolved`。
 *
 * 生产环境有 HTTP server 监听，进程不会退出，所以没事；
 * 测试里自己拿一个 ref 的定时器顶着。
 */
function keepAlive() {
  const t = setInterval(() => {}, 50);
  return () => clearInterval(t);
}

test('重试：upstream 失败后自动重投一轮并成功', async () => {
  const { ctx, emit } = fakeDsh();
  const alive = keepAlive();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 'r1' };
  const agent = agentFor(
    session,
    [
      // 第一轮：上游 502
      (t) => [{ type: 'turn/end', data: { turn: t, reason: { kind: 'error', error: { code: 'SERVER', status: 502 } } } }],
      // 第二轮：正常
      (t) => [
        { type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: '缓过来了' }] } } },
        { type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } },
      ],
    ],
    emit,
  );

  const reply = await runner.run(agent, '在吗');
  assert.equal(reply, '缓过来了');
  assert.equal(agent.count, 2, '应该重投了一次');
  runner.dispose();
  alive();
});

test('重试：blocked 不重投', async () => {
  const { ctx, emit } = fakeDsh();
  const alive = keepAlive();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 'r2' };
  const agent = agentFor(session, [(t) => [{ type: 'turn/end', data: { turn: t, reason: { kind: 'blocked' } } }]], emit);

  await assert.rejects(() => runner.run(agent, '在吗'), (e) => e.kind === 'blocked');
  assert.equal(agent.count, 1, 'blocked 不该重投');
  runner.dispose();
  alive();
});

test('重试：upstream 一直失败时，错误消息里没有 JSON 原文', async () => {
  const { ctx, emit } = fakeDsh();
  const alive = keepAlive();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 'r3' };
  const agent = agentFor(
    session,
    [
      (t) => [
        {
          type: 'turn/end',
          data: {
            turn: t,
            reason: { kind: 'error', error: { message: 'DeepSeek Messages request failed (502)', code: 'SERVER', status: 502 } },
          },
        },
      ],
    ],
    emit,
  );

  await assert.rejects(
    () => runner.run(agent, '在吗'),
    (e) => {
      assert.equal(e.kind, 'upstream');
      assert.equal(e.status, 502);
      // 关键：不能把 {"kind":"error",...} 糊出去
      assert.ok(!e.message.includes('"kind"'), `消息里不该有 JSON 原文：${e.message}`);
      assert.match(e.message, /模型服务/);
      return true;
    },
  );
  assert.equal(agent.count, 2, '默认补一次重试');
  runner.dispose();
  alive();
});

/**
 * **最关键的一条：吐过字就不重投。**
 *
 * 上游报错有两种位置：
 *   - 请求刚发出去就 502 → 一个字没吐 → 重投安全
 *   - 吐了一半才断 → 已经说出去一半 → 重投等于让人收到两条半截话
 */
test('重试：这一轮已经吐过字就不重投（避免重复回复）', async () => {
  const { ctx, emit } = fakeDsh();
  const alive = keepAlive();
  const runner = createTurnRunner({ ctx, timeoutSec: 5 });
  const session = { id: 'r5' };
  const agent = agentFor(
    session,
    [
      (t) => [
        // 先吐半句，再报上游错误
        { type: 'assistant/message', data: { turn: t, message: { content: [{ type: 'text', text: '我觉得' }] } } },
        { type: 'turn/end', data: { turn: t, reason: { kind: 'error', error: { code: 'SERVER', status: 502 } } } },
      ],
    ],
    emit,
  );

  await assert.rejects(() => runner.run(agent, '在吗'), (e) => e.kind === 'upstream');
  assert.equal(agent.count, 1, '吐过字就不该重投');
  runner.dispose();
  alive();
});

test('重试：重投前会看总时限，剩不够就不投', async () => {
  const { ctx, emit } = fakeDsh();
  // budgetSec 给 1 秒，delayMs 给 3000 —— 必然不够
  const alive = keepAlive();
  const runner = createTurnRunner({
    ctx,
    timeoutSec: 5,
    upstreamRetry: { enabled: true, attempts: 1, delayMs: 3000, budgetSec: 1 },
  });
  const session = { id: 'r6' };
  const agent = agentFor(
    session,
    [(t) => [{ type: 'turn/end', data: { turn: t, reason: { kind: 'error', error: { code: 'SERVER', status: 502 } } } }]],
    emit,
  );

  await assert.rejects(() => runner.run(agent, '在吗'), (e) => e.kind === 'upstream');
  assert.equal(agent.count, 1, '总时限不够，不该重投');
  runner.dispose();
  alive();
});

test('重试：关掉配置就不重投', async () => {
  const { ctx, emit } = fakeDsh();
  const alive = keepAlive();
  const runner = createTurnRunner({
    ctx,
    timeoutSec: 5,
    upstreamRetry: { enabled: false, attempts: 1, delayMs: 10, budgetSec: 170 },
  });
  const session = { id: 'r7' };
  const agent = agentFor(
    session,
    [(t) => [{ type: 'turn/end', data: { turn: t, reason: { kind: 'error', error: { code: 'SERVER', status: 502 } } } }]],
    emit,
  );

  await assert.rejects(() => runner.run(agent, '在吗'), (e) => e.kind === 'upstream');
  assert.equal(agent.count, 1, '关掉了就不该重投');
  runner.dispose();
  alive();
});

/* ---------------- 配置 ---------------- */

test('配置：上游重试默认开着，补一次', () => {
  assert.equal(DEFAULTS.chat.upstreamRetry.enabled, true);
  assert.equal(DEFAULTS.chat.upstreamRetry.attempts, 1);
});

test('配置：总时限比 ai-chat 的 180 秒短', () => {
  assert.ok(
    DEFAULTS.chat.upstreamRetry.budgetSec < 180,
    `总时限 ${DEFAULTS.chat.upstreamRetry.budgetSec}s 必须小于 ai-chat 的 180s 等待`,
  );
});

test('取文本：只拼 text 块', () => {
  const msg = { content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: '世界' }] };
  assert.equal(textOf(msg), '你好\n世界');
});
