// 行动单执行器 createExecV5：整文件移植自 aurabot exec.js，验核心行为闭环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecV5 } from '../src/autotelic-exec.js';

const base = (steps, extra = {}) => ({
  id: 't-1', intent: '整理笔记', tag: '未完成', steps,
  budget: { maxSteps: 4, timeoutMs: 5000 }, ownerSide: false, ...extra,
});

test('硬禁区：任一步命中 → 整单 rejected，一步都不执行', async () => {
  let called = 0;
  const ex = createExecV5({
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  const r = await ex.run(base([
    { desc: '读笔记', level: 'read-only' },
    { desc: '修改 host.json 里的端口', level: 'write-data' },
  ]));
  assert.equal(r.status, 'rejected');
  assert.equal(called, 0, '禁区单不许执行任何一步');
});

test('read-only 正常执行到 done', async () => {
  const ex = createExecV5({
    hooks: { execStep: async () => ({ ok: true, observation: '读完了' }) },
    log: {},
  });
  const r = await ex.run(base([{ desc: '读一遍笔记', level: 'read-only' }]));
  assert.equal(r.status, 'done');
  assert.ok(r.results && r.results.length >= 1);
});

test('touch-owner 默认排队等确认，不直接动手', async () => {
  let called = 0;
  const ex = createExecV5({
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  const ticket = base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true });
  const r = await ex.run(ticket);
  assert.equal(r.status, 'queued');
  assert.equal(called, 0, '没确认前一步都不能跑');
  assert.ok(ex.pendingList().some((x) => x.ticketId === 't-1' || x.id === 't-1'), '进待确认队列');
});

test('autoConfirmOwner 豁免：配置打开后 touch-owner 直接执行', async () => {
  let called = 0;
  const ex = createExecV5({
    settings: () => ({ autoConfirmOwner: true }),
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  const r = await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  assert.equal(r.status, 'done');
  assert.ok(called > 0);
});

test('确认后执行、取消不执行', async () => {
  let called = 0;
  const ex = createExecV5({
    hooks: { execStep: async () => { called++; return { ok: true, observation: 'done' }; } },
    log: {},
  });
  await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  const cancelled = ex.cancel('t-1');
  assert.equal(cancelled.status, 'aborted');
  assert.equal(called, 0);
  await ex.run(base([{ desc: '给主人发一句问候', level: 'touch-owner' }], { ownerSide: true }));
  const confirmed = await ex.confirm('t-1');
  assert.equal(confirmed.status, 'done');
  assert.ok(called > 0);
});
