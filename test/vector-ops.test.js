import test from 'node:test';
import assert from 'node:assert/strict';

import { TEST_TEXT, testResult, rebuildBatch } from '../src/vector-ops.js';

test('TEST_TEXT 是固定测试句（对齐对方 vectorTest 默认文本）', () => {
  assert.equal(TEST_TEXT, '今天想吃白米饭');
});

test('testResult：真向量回 dims/ms，空向量回失败提示', () => {
  assert.deepEqual(testResult([1, 2, 3], 12), { ok: true, dims: 3, ms: 12 });
  const bad = testResult(null, 5);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /没有返回向量/);
  assert.equal(testResult([1], -1).ms, 0);
});

test('rebuildBatch：正常批量补算，setVec 带 model 指纹', async () => {
  const rows = [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }];
  const calls = [];
  const embed = { many: async (texts) => { calls.push(texts); return [[1, 2], [3, 4]]; } };
  const setVec = (id, vec, model) => calls.push([id, vec, model]);
  const r = await rebuildBatch({ rows, embed, setVec, model: 'local:e5-small' });
  assert.deepEqual(r, { done: 2, failed: 0 });
  assert.deepEqual(calls[0], ['甲', '乙']);
  assert.deepEqual(calls[1], ['a', [1, 2], 'local:e5-small']);
  assert.deepEqual(calls[2], ['b', [3, 4], 'local:e5-small']);
});

test('rebuildBatch：embed 长度不一致 = 整批作废，不写半批', async () => {
  const rows = [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }];
  const written = [];
  const embed = { many: async () => [[1, 2]] }; // 只回一条
  const r = await rebuildBatch({ rows, embed, setVec: (...a) => written.push(a), model: 'm' });
  assert.deepEqual(r, { done: 0, failed: 2 });
  assert.equal(written.length, 0, '一条都不写');
});

test('rebuildBatch：embed 抛错 / 无 embed / 脏行容错', async () => {
  const rows = [{ id: 'a', text: '甲' }, null, { id: '', text: 'x' }, { id: 'b', text: '' }];
  const r1 = await rebuildBatch({ rows, embed: { many: async () => { throw new Error('boom'); } }, setVec: () => {}, model: 'm' });
  assert.deepEqual(r1, { done: 0, failed: 1 });
  const r2 = await rebuildBatch({ rows: [{ id: 'a', text: '甲' }], embed: null, setVec: () => {}, model: 'm' });
  assert.equal(r2.failed, 1);
  const r3 = await rebuildBatch({ rows: [], embed: {}, setVec: () => {}, model: 'm' });
  assert.deepEqual(r3, { done: 0, failed: 0 });
});

test('rebuildBatch：部分空向量只写有效行', async () => {
  const rows = [{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }];
  const written = [];
  const embed = { many: async () => [[1, 2], null] };
  const r = await rebuildBatch({ rows, embed, setVec: (...a) => written.push(a), model: 'm' });
  assert.deepEqual(r, { done: 1, failed: 1 });
  assert.equal(written.length, 1);
});
