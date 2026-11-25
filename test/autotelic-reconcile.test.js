// 日对账：自述 vs 账本交叉核对（链断/漏报/虚报 = 红，覆盖不全 = 黄）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileDay, problemsText } from '../src/autotelic-reconcile.js';

test('链断 → 红（最高优先级）', () => {
  const r = reconcileDay({ chain: { ok: false, brokenAt: 7 } });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.level === 'red' && p.type === 'chain-broken'));
  assert.match(r.problems[0].detail, /第 7 条/);
});

test('漏报：账本有动作但自述说没做什么', () => {
  const r = reconcileDay({
    audit: [{ kind: 'tool/call', at: '2026-01-15T10:00:00' }],
    tasks: [{ id: 't1', title: '整理笔记', status: 'done', steps: [{ status: 'done' }] }],
    dailyText: '今天什么都没做，就发了会儿呆',
    chain: { ok: true },
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'underreport'));
});

test('虚报：自述列了任务但账本查无此账', () => {
  const r = reconcileDay({
    audit: [],
    tasks: [{ id: 't1', title: '整理笔记', status: 'done', steps: [] }],
    dailyText: '「学会了弹吉他」→ 办成',
    chain: { ok: true },
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.type === 'overreport' && /弹吉他/.test(p.detail)));
});

test('自述与账本一致 → 通过', () => {
  const r = reconcileDay({
    audit: [{ kind: 'tool/call', at: 'x' }],
    tasks: [{ id: 't1', title: '整理笔记', status: 'done', steps: [{ status: 'done' }] }],
    dailyText: '「整理笔记」→ 办成',
    chain: { ok: true },
  });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
});

test('warn：有工具调用但账本没有任务活动（口径提示，不算撒谎）', () => {
  const r = reconcileDay({
    audit: [{ kind: 'tool/call', at: 'x' }],
    tasks: [],
    dailyText: '今天挺好的',
    chain: { ok: true },
  });
  assert.equal(r.ok, true, 'warn 不影响 ok');
  assert.ok(r.problems.some((p) => p.level === 'warn' && p.type === 'no-task-activity'));
});

test('warn：有意图没结果', () => {
  const r = reconcileDay({
    audit: [{ kind: 'tool/intent', at: 'x' }, { kind: 'tool/intent', at: 'y' }],
    tasks: [{ id: 't', title: 'x', status: 'active', steps: [] }],
    dailyText: '',
    chain: { ok: true },
  });
  assert.ok(r.problems.some((p) => p.type === 'intent-no-result'));
});

test('problemsText：红黄图标与通过文案', () => {
  assert.equal(problemsText([]), '对账通过：自述与账本一致');
  const txt = problemsText([{ level: 'red', type: 'x', detail: 'y' }, { level: 'warn', type: 'a', detail: 'b' }]);
  assert.match(txt, /🔴 x：y/);
  assert.match(txt, /🟡 a：b/);
});
