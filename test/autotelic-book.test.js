// 自驱任务账本：活跃上限、动作预算、步数上限、失败升级、重启恢复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBook, MAX_ACTIVE, TASK_STATUSES } from '../src/autotelic-book.js';

const mk = (file = '', over = {}) => createBook({ file, now: () => 1000, ...over });

test('addTask：title/reason 必填，缺一拒', () => {
  const b = mk();
  assert.equal(b.addTask({ title: '', reason: 'x' }).ok, false);
  assert.equal(b.addTask({ title: 'x', reason: '' }).ok, false);
  const r = b.addTask({ title: '整理笔记', reason: '笔记太乱了' });
  assert.equal(r.ok, true);
  assert.equal(r.task.status, 'active');
  assert.ok(r.task.steps.length >= 1, '至少要有一步');
});

test('addTask：活跃上限满时拒绝', () => {
  const b = mk('', { maxActive: 2 });
  b.addTask({ title: 'a', reason: 'r1' });
  b.addTask({ title: 'b', reason: 'r2' });
  const third = b.addTask({ title: 'c', reason: 'r3' });
  assert.equal(third.ok, false);
  assert.match(third.why, /活跃任务已满/);
  assert.equal(b.activeCount(), 2);
});

test('动作预算：一小时内超上限就拒绝立项', () => {
  const b = mk('', { actionsPerHour: 3, maxActive: 99 });
  b.recordAction(); b.recordAction(); b.recordAction();
  assert.equal(b.actionsInLastHour(), 3);
  const r = b.addTask({ title: 'x', reason: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.why, /动作预算到顶/);
});

test('步数上限：超过 maxSteps 拒绝开新步', () => {
  const b = mk('', { maxSteps: 1 });
  const { task } = b.addTask({ title: 't', reason: 'r', todos: [{ desc: 'a', level: 'L0' }, { desc: 'b', level: 'L0' }] });
  assert.equal(b.beginStep(task.id).ok, true);
  b.endStep(task.id, { ok: true });
  const second = b.beginStep(task.id);
  assert.equal(second.ok, false, '超过 maxSteps 不该再开');
});

test('失败两次任务变 blocked', () => {
  const b = mk();
  const { task } = b.addTask({ title: 't', reason: 'r', todos: [{ desc: 'a', level: 'L0' }] });
  b.beginStep(task.id);
  b.endStep(task.id, { ok: false, why: '第一次失败' });
  b.beginStep(task.id);
  const r = b.endStep(task.id, { ok: false, why: '第二次失败' });
  assert.equal(r.taskStatus, 'blocked');
  assert.match(b.list()[0].why, /失败 2 次/);
});

test('全部步完成 → 任务 done', () => {
  const b = mk();
  const { task } = b.addTask({ title: 't', reason: 'r', todos: [{ desc: 'a', level: 'L0' }] });
  b.beginStep(task.id);
  const r = b.endStep(task.id, { ok: true });
  assert.equal(r.taskStatus, 'done');
});

test('releaseStep：瞬态失败退回 pending，不占失败计数', () => {
  const b = mk();
  const { task } = b.addTask({ title: 't', reason: 'r', todos: [{ desc: 'a', level: 'L0' }] });
  b.beginStep(task.id);
  b.releaseStep(task.id, '后台会话冷却');
  const t = b.list()[0];
  assert.equal(t.steps[0].status, 'pending');
  assert.equal(t.steps[0].attempts, 0, '退回时把 attempts 退掉');
  assert.equal(t.status, 'active');
});

test('重启恢复：在途的步改判 failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  try {
    const file = join(dir, 'ledger.json');
    writeFileSync(file, JSON.stringify({
      tasks: [{ id: 't1', title: 'x', reason: 'y', status: 'active', createdAt: 1, updatedAt: 1, steps: [{ desc: 'a', status: 'running', attempts: 1 }] }],
      actions: [], ticks: [], lastTick: null, screenVetoes: [],
    }), 'utf8');
    const b = createBook({ file, now: () => 1000 });
    const t = b.list()[0];
    assert.equal(t.steps[0].status, 'failed', '在途改判 failed');
    assert.match(t.note, /待重试/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('落盘与重读：任务能存住', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk2-'));
  try {
    const file = join(dir, 'ledger.json');
    const b = createBook({ file, now: () => 1000 });
    b.addTask({ title: '持久化测试', reason: '要能存住' });
    const b2 = createBook({ file, now: () => 1000 });
    assert.equal(b2.list().length, 1);
    assert.equal(b2.list()[0].title, '持久化测试');
    assert.ok(readFileSync(file, 'utf8').includes('持久化测试'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('常量：状态闭集与活跃上限', () => {
  assert.deepEqual([...TASK_STATUSES], ['active', 'done', 'failed', 'blocked', 'abandoned']);
  assert.equal(MAX_ACTIVE, 8);
});

test('maxTasksActive（P3）：运行时改上限立即生效', () => {
  const b = mk('', { maxActive: 2 });
  b.addTask({ title: 'a', reason: 'r1' });
  b.addTask({ title: 'b', reason: 'r2' });
  assert.equal(b.addTask({ title: 'c', reason: 'r3' }).ok, false, '上限 2 时第三个被拒');

  assert.equal(b.setMaxActive(3), 3, '运行时抬到 3');
  assert.equal(b.addTask({ title: 'c', reason: 'r3' }).ok, true, '第三个现在能立');

  b.setMaxActive(1);
  assert.equal(b.maxActiveOf(), 1);
  /** pruneLedger 兜底：活跃超过新上限时最老的让位 */
  assert.equal(b.activeCount(), 1, '活跃数被压回 1');
});
