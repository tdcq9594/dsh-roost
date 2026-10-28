// QQ 动作工具（`qq_send` / `qq_close`）的测试。
//
// 这两个工具出错的表现都是**社交事故**：段数没上限就是刷屏，
// 收尾判错就是「问题没答完就跑了」。所以断言盯拒绝路径，不盯成功路径的措辞。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQqToolDefs, MAX_PARTS } from '../src/qq-tools.js';

/**
 * 造一套工具，返回 { send, close } 和记账用的箱子。
 *
 * @param {object} [o]
 */
function make({ kind = 'c2c', said = '', hasPayload = true, maxParts = MAX_PARTS, sendFails = false } = {}) {
  const box = { sent: [], parts: 0, closed: false, closedWith: null };

  const defs = buildQqToolDefs({
    callerOf: () => ({
      chatId: 'u1',
      kind,
      said,
      hasPayload,
      bucket: 'owner',
    }),
    sendOf: async (text) => {
      if (sendFails) return { ok: false, message: '通道断了' };
      box.sent.push(text);
      box.parts += 1;
      return { ok: true };
    },
    closeOf: (r) => {
      box.closed = true;
      box.closedWith = r;
      return { ok: true, why: r.point };
    },
    cfgOf: () => ({ qqTools: { maxParts } }),
    stateOf: () => ({ parts: box.parts }),
  });

  const by = (n) => defs.find((d) => d.name === n);
  return { box, send: by('qq_send'), close: by('qq_close'), defs };
}

/* ---------------- 形状 ---------------- */

test('工具：两个都注册了，名字对', () => {
  const { defs } = make();
  assert.deepEqual(defs.map((d) => d.name).sort(), ['qq_close', 'qq_send']);
});

test('工具：都有 parameters 和 execute', () => {
  const { defs } = make();
  for (const d of defs) {
    assert.equal(typeof d.execute, 'function', `${d.name} 缺 execute`);
    assert.equal(d.parameters?.type, 'object', `${d.name} 缺 parameters`);
    assert.ok(d.description, `${d.name} 缺 description`);
  }
});

/**
 * `output.render` 必须返回**内容块数组**。
 *
 * 返回字符串会让 DSH 的 `content.some()` 炸成
 * `content.some is not a function`，模型看到的是「接口报错了」。
 * 0.9.x 两轮检索全挂在这，所以这条必须有测试。
 */
test('工具：output.render 返回内容块数组，不是字符串', () => {
  const { defs } = make();
  for (const d of defs) {
    const out = d.output.render({}, { ok: true });
    assert.ok(Array.isArray(out), `${d.name} 的 render 不是数组`);
    assert.equal(out[0]?.type, 'text');
    assert.equal(typeof out[0]?.text, 'string');
  }
});

/* ---------------- qq_send ---------------- */

test('qq_send：正常发一段', async () => {
  const { send, box } = make();
  const r = await send.execute({ text: '在的' });
  assert.equal(r.ok, true);
  assert.equal(r.part, 1);
  assert.deepEqual(box.sent, ['在的']);
});

test('qq_send：空文本不发', async () => {
  const { send, box } = make();
  const r = await send.execute({ text: '   ' });
  assert.equal(r.ok, false);
  assert.equal(box.sent.length, 0);
});

test('qq_send：超过上限就拒，并说清还剩几段', async () => {
  const { send, box } = make({ maxParts: 2 });
  await send.execute({ text: '一' });
  await send.execute({ text: '二' });
  const r = await send.execute({ text: '三' });
  assert.equal(r.ok, false);
  assert.match(r.message, /上限 2 段/);
  assert.equal(box.sent.length, 2, '超限那次不该发出去');
});

test('qq_send：这一轮没有 payload 时拒（不该发生，但别静默）', async () => {
  const { send, box } = make({ hasPayload: false });
  const r = await send.execute({ text: '喂' });
  assert.equal(r.ok, false);
  assert.equal(box.sent.length, 0);
});

test('qq_send：底层发送失败要把原因带出去', async () => {
  const { send } = make({ sendFails: true });
  const r = await send.execute({ text: '喂' });
  assert.equal(r.ok, false);
  assert.match(r.message, /通道断了/);
});

test('qq_send：maxParts 配成 0 或负数时退回默认值（不能变成"永远发不出去"）', async () => {
  const { send, box } = make({ maxParts: 0 });
  const r = await send.execute({ text: '一' });
  assert.equal(r.ok, true);
  assert.equal(box.sent.length, 1);
});

/* ---------------- qq_close ---------------- */

test('qq_close：私聊正常收尾', async () => {
  const { close, box } = make({ said: '我先去睡啦' });
  const r = await close.execute({ point: '聊到他要睡了', resume: '明天问他睡得好不好' });
  assert.equal(r.ok, true);
  assert.equal(box.closed, true);
  assert.equal(box.closedWith.point, '聊到他要睡了');
  assert.equal(box.closedWith.resume, '明天问他睡得好不好');
});

test('qq_close：群聊拒绝（跟标记那条路共用同一个判断）', async () => {
  const { close, box } = make({ kind: 'group' });
  const r = await close.execute({ point: '群里聊完了' });
  assert.equal(r.ok, false);
  assert.equal(box.closed, false);
});

test('qq_close：对方还在提问时拒绝', async () => {
  const { close, box } = make({ said: '这个报错怎么修？' });
  const r = await close.execute({ point: '聊到报错' });
  assert.equal(r.ok, false);
  assert.match(r.message, /提问/);
  assert.equal(box.closed, false);
});

test('qq_close：没写「收在哪」拒绝', async () => {
  const { close, box } = make();
  const r = await close.execute({ point: '  ' });
  assert.equal(r.ok, false);
  assert.equal(box.closed, false);
});

test('qq_close：resume 可以不给', async () => {
  const { close, box } = make();
  const r = await close.execute({ point: '聊完了' });
  assert.equal(r.ok, true);
  assert.equal(box.closedWith.resume, '');
});
