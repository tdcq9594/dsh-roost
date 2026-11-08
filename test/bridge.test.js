/**
 * 对外联动（实验）：别的 DSH 插件拿到的 API 只做转发，不另开一条发送路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBridge } from '../src/bridge.js';

test('send 走 sendOut，只回精简结果', async () => {
  const seen = [];
  const bridge = createBridge({
    sendOut: async (p) => { seen.push(p); return { ok: true, pending: true, requestId: 'sp-1' }; },
  });
  const r = await bridge.send({ scene: 'c2c', target: 'u1', text: 'hi' });
  assert.equal(seen.length, 1);
  assert.deepEqual(r, { ok: true, pending: true, requestId: 'sp-1' });
});

test('status 读失败返回空对象，不把异常抛给别的插件', () => {
  const bridge = createBridge({
    sendOut: async () => ({}),
    statusOf: () => { throw new Error('boom'); },
    log: () => {},
  });
  assert.deepEqual(bridge.status(), {});
});

test('status 正常时原样返回', () => {
  const bridge = createBridge({
    sendOut: async () => ({}),
    statusOf: () => ({ chatId: 'g1' }),
  });
  assert.deepEqual(bridge.status(), { chatId: 'g1' });
});

test('没有 sendOut 直接拒绝（避免建出一个发不出消息的空壳）', () => {
  assert.throws(() => createBridge({}), /sendOut/);
});

test('接口版本号存在（消费方按它判能力）', () => {
  assert.equal(createBridge({ sendOut: async () => ({}) }).api, 1);
});
