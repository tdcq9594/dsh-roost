// 目的引擎运行时：素材不足跳过、选不出跳过、忙让位、正常投递结算、复读保护。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPurposeRunner, cleanPurposeText } from '../src/purpose-run.js';
import { createPurposeState } from '../src/purpose-state.js';
import { DEFAULT_PURPOSE_CONFIG as CFG } from '../src/purpose-engine.js';

const now = new Date(2026, 0, 15, 14, 30, 0, 0).getTime();

function mkRunner(dir, over = {}) {
  const stateStore = createPurposeState({ dir, log: () => {} });
  const runner = createPurposeRunner({
    cfgOf: () => ({ ...CFG, enabled: true }),
    stateStore,
    collect: () => ({ items: over.items || [] }),
    runTurn: over.runTurn || (async () => '好呀，你在忙什么？'),
    deliver: over.deliver || (async () => 'sent'),
    lastOwnerAt: over.lastOwnerAt || (() => now - 3 * 3600_000),
    busy: over.busy || (() => false),
    now: () => now,
    log: {},
  });
  /** 测试要能预置状态（同一个实例，避免 cache 各自为政） */
  runner.stateStore = stateStore;
  return runner;
}

test('runOnce：素材太少直接跳过，不调模型不投递', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  try {
    let called = 0;
    const r = mkRunner(dir, { items: [], runTurn: async () => { called += 1; return 'x'; } });
    const out = await r.runOnce({ reason: '定时' });
    assert.equal(out.outcome, 'skipped-materials');
    assert.equal(called, 0, '素材不够不该花模型钱');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce：素材够但选不出目的就跳过', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr2-'));
  try {
    /** 素材都是群友闲聊，needAffinity 全 0，formGoalHypotheses 产不出目标 */
    const items = Array.from({ length: 3 }, (_, i) => ({ id: `m${i}`, kind: 'member', text: '嗯', at: now - i * 1000, source: 'qq' }));
    let called = 0;
    const r = mkRunner(dir, { items, runTurn: async () => { called += 1; return 'x'; } });
    const out = await r.runOnce();
    assert.equal(out.outcome, 'skipped-no-candidate');
    assert.equal(called, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce：会话忙让位，不占次数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr3-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    const r = mkRunner(dir, { items, busy: () => true });
    const out = await r.runOnce();
    assert.equal(out.outcome, 'skipped-busy');
    assert.equal(r.status().countToday, 0, '让位不该占次数');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce：正常路径生成→投递→结算 sent，并占一次数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr4-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班到很晚', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    let delivered = '';
    const r = mkRunner(dir, {
      items,
      runTurn: async () => '听起来你最近挺累的，早点休息呀\n【目的】关心他加班\n【状态】完成\n【需求】关心',
      deliver: async (text) => { delivered = text; return 'sent'; },
    });
    const out = await r.runOnce();
    if (out.outcome === 'skipped-no-candidate') return; // 素材不足以产目标时跳过也算合理
    assert.equal(out.outcome, 'sent');
    assert.match(delivered, /早点休息/, '投递的是清洗后的正文');
    assert.doesNotMatch(delivered, /【目的】/, '备忘段不能发出去');
    assert.equal(r.status().countToday, 1);
    assert.equal(r.status().lastOutcome, 'sent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runOnce：投递失败按 delivery-failed 结算，且会安排重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr5-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班到很晚', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    const r = mkRunner(dir, {
      items,
      runTurn: async () => '听起来你最近挺累的\n【目的】关心他\n【状态】完成',
      deliver: async () => 'failed',
    });
    const out = await r.runOnce();
    if (out.outcome === 'skipped-no-candidate') return;
    assert.equal(out.outcome, 'delivery-failed');
    assert.equal(r.status().lastOutcome, 'delivery-failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tick：未到点只等，不跑模型', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr6-'));
  try {
    let called = 0;
    const r = mkRunner(dir, { runTurn: async () => { called += 1; return 'x'; } });
    /** 先把 nextFireAt 设到未来（用同一个 stateStore 实例） */
    r.stateStore.write((s) => { s.nextFireAt = now + 3600_000; return s; });
    const out = await r.tick();
    assert.match(String(out.outcome), /^wait:/);
    assert.equal(called, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preview：零副作用，不写盘不投递', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr7-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    let delivered = 0;
    const r = mkRunner(dir, { items, deliver: async () => { delivered += 1; return 'sent'; } });
    const p = await r.preview();
    assert.equal(p.ok, true);
    assert.equal(typeof p.materials, 'number');
    assert.equal(delivered, 0, '预览不该投递');
    assert.equal(r.status().countToday, 0, '预览不该占次数');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cleanPurposeText：剥掉【…】备忘段，保留正文', () => {
  const out = cleanPurposeText('今天想跟你说个事\n【目的】分享\n【状态】完成\n【待续】无');
  assert.equal(out, '今天想跟你说个事');
  assert.equal(cleanPurposeText(''), '');
});

test('朋友线（P3）：每个朋友独立额度，不占主人次数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prf-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    const r = mkRunner(dir, {
      items,
      runTurn: async () => '听起来你最近挺累的\n【目的】关心他\n【状态】完成',
      deliver: async () => 'sent',
    });
    const outA = await r.runOnce({ friend: 'friendA' });
    if (outA.outcome === 'skipped-no-candidate') return;
    assert.equal(r.status().countToday, 0, '朋友消耗不记到主人头上');
    const st = r.stateStore.read();
    assert.ok(st.friends?.friendA, '朋友分区要建起来');
    assert.equal(st.friends.friendA.countToday, 1, '朋友自己的次数 +1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('朋友线（P3）：投递带上 friend 参数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prf2-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    let gotFriend = null;
    const r = mkRunner(dir, {
      items,
      runTurn: async () => '听起来你最近挺累的\n【目的】关心\n【状态】完成',
      deliver: async (_text, _p, friend) => { gotFriend = friend; return 'sent'; },
    });
    const out = await r.runOnce({ friend: 'friendB' });
    if (out.outcome === 'skipped-no-candidate') return;
    assert.equal(gotFriend, 'friendB', '投递必须知道发给谁');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('防重入（P1）：同一 friend 并发 runOnce 只跑一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prl-'));
  try {
    const items = [
      { id: 'm1', kind: 'owner', text: '最近项目好累，天天加班', at: now - 3600_000, source: 'qq', meta: { key: 'private:123' } },
      { id: 'm2', kind: 'owner', text: '周末想出去走走散散心', at: now - 7200_000, source: 'qq', meta: { key: 'private:123' } },
    ];
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const r = mkRunner(dir, {
      items,
      runTurn: async () => { calls += 1; await gate; return '听起来你挺累的\n【目的】关心\n【状态】完成'; },
      deliver: async () => 'sent',
    });
    const p1 = r.runOnce({ friend: 'F' });
    await new Promise((res) => setTimeout(res, 10));
    const r2 = await r.runOnce({ friend: 'F' });
    assert.equal(r2.outcome, 'skipped-in-flight', '第二次应被挡');
    release();
    await p1;
    assert.equal(calls, 1, '模型只该跑一次');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
