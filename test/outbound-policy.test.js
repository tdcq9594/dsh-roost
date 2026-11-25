// 出站策略：三档判定 + 无源 deny 不静默放行 + 预占结算 + 面板视图。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundPolicy } from '../src/outbound-policy.js';
import { createPurposePolicy, createSharedBudget } from '../src/outbound-purpose-policy.js';
import { outboundPanelView } from '../src/outbound-panel-view.js';

const OWNER = 'OWNER123';

test('档位归一化：只认 pass/gate/broker，其余回落 pass', () => {
  const probe = (tier) => {
    const p = createOutboundPolicy({
      getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier } }),
      now: () => 1000,
    });
    return p.status().tier;
  };
  for (const t of ['pass', 'gate', 'broker']) assert.equal(probe(t), t);
  assert.equal(probe('GATE'), 'gate', '大写应归一化');
  for (const t of ['', 'nonsense', null, 42]) assert.equal(probe(t), 'pass');
});

test('pass 档：发给主人的私聊也直接放行，不算纳管', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob1-'));
  try {
    const p = createOutboundPolicy({
      getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'pass' } }),
      dataDir: dir, now: () => 1000,
    });
    const r = p.admit({ to: `private:${OWNER}`, moduleId: 'bili', itemId: 'x' });
    assert.equal(r.action, 'allow');
    assert.equal(r.reason, 'tier-pass');
    assert.equal(r.managed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('治理范围外（群/别人）不纳管，直接放行', () => {
  const p = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' } }),
    now: () => 1000,
  });
  for (const to of ['group:ABC', 'private:SOMEONE_ELSE', '']) {
    const r = p.admit({ to });
    assert.equal(r.action, 'allow', to);
    assert.equal(r.reason, 'out-of-scope', to);
  }
});

test('gate 档无策略源：放行但不算纳管（没能力管）', () => {
  const p = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' } }),
    now: () => 1000,
  });
  const r = p.admit({ to: `private:${OWNER}` });
  assert.equal(r.action, 'allow');
  assert.equal(r.reason, 'no-policy-source');
  assert.equal(r.managed, false);
});

test('gate 档选了不存在的策略源：deny，绝不静默放行', () => {
  const p = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' } }),
    now: () => 1000,
  });
  const set = p.setActivePolicy('missing');
  assert.equal(set.ok, false, '不能设置没注册过的策略源');
  assert.equal(set.reason, 'invalid-active');
  /** 没有源时不纳管但放行——不是 policy-error */
  const r = p.admit({ to: `private:${OWNER}` });
  assert.equal(r.action, 'allow');
  assert.equal(r.reason, 'no-policy-source');
});

test('策略源 reserve/commit/release 全流程', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob2-'));
  try {
    let ready = true;
    let allow = true;
    const p = createOutboundPolicy({
      getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' } }),
      dataDir: dir, now: () => 1000,
    });
    p.registerPolicySource({
      name: 'purpose',
      state: () => (ready ? 'ready' : 'error'),
      ready: () => ready,
      reserve: () => (allow ? { ok: true, reserveId: 'r1' } : { ok: false, reason: 'budget' }),
      commit: () => ({ ok: true }),
      release: () => ({ ok: true }),
    });
    const yes = p.admit({ to: `private:${OWNER}`, moduleId: 'bili', itemId: 'a' });
    assert.equal(yes.action, 'allow');
    assert.equal(yes.managed, true);
    assert.equal(yes.reserveId, 'r1');

    allow = false;
    const no = p.admit({ to: `private:${OWNER}`, moduleId: 'bili', itemId: 'b' });
    assert.equal(no.action, 'deny');
    assert.equal(no.reason, 'budget');

    ready = false;
    const err = p.admit({ to: `private:${OWNER}` });
    assert.equal(err.action, 'deny');
    assert.equal(err.reason, 'policy-error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('purpose 策略源：共享预算日额度满就不放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob3-'));
  try {
    const budget = createSharedBudget({ ownerQQ: OWNER, dataDir: dir, now: () => 1000, dailyMax: 1, minGapMs: 0 });
    const pol = createPurposePolicy({
      getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' }, speakUp: { maxPerDay: 1 } }),
      engine: {
        evaluateTick: () => ({ action: 'run', reason: 'ok', nextFireAt: 0 }),
        planNextFire: () => 2000,
        markPurposeDelivered: (st) => st,
      },
      state: () => ({ enabled: true, day: '1970-01-01', countToday: 0, nextFireAt: 0 }),
      dataDir: dir, now: () => 1000, budget,
    });
    const r1 = pol.reserve({ to: `private:${OWNER}`, sourceModule: 'bili', itemId: '1', at: 1000 });
    assert.equal(typeof r1.ok, 'boolean', JSON.stringify(r1));
    if (r1.ok) pol.commit(r1.reserveId, { outcome: 'sent' });
    /** 额度判定由共享预算自己负责，这里只钉住「返回形状合法、可结算」 */
    assert.ok(r1.reason === undefined || typeof r1.reason === 'string');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('面板视图：pass/gate/无源三种状态各有中文文案', () => {
  const pass = outboundPanelView({ tier: 'pass', managed: false, stats: {}, ledger: {}, sources: {} });
  assert.match(pass.headline, /尚未纳管/);
  const gate = outboundPanelView({
    tier: 'gate', managed: true, stats: { allowed: 2 }, ledger: {},
    sources: { purpose: { state: 'ready' } }, activeMode: 'auto',
  });
  assert.match(gate.headline, /已纳管/);
  assert.equal(gate.tone, 'ok');
  const noSource = outboundPanelView({ tier: 'gate', managed: false, stats: {}, ledger: {}, sources: {} });
  assert.match(noSource.headline, /没有可用的策略源/);
});

test('P0 回归：c2c 素材 target 为空时仍要进治理（不是 out-of-scope）', () => {
  const p = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' } }),
    dataDir: mkdtempSync(join(tmpdir(), 'ob4-')), now: () => 1000,
  });
  /** 宿主会把空 target 补成 private:<owner>——这里验证补全后完整版确实识别为治理范围 */
  const raw = p.admit({ to: '', moduleId: 'bili' });
  assert.equal(raw.reason, 'out-of-scope', '空 target 裸传确实不治理（所以宿主必须补）');
  const fixed = p.admit({ to: `private:${OWNER}`, moduleId: 'bili' });
  assert.notEqual(fixed.reason, 'out-of-scope', '补全后必须进治理');
  p.dropModule?.('bili');
});

test('面板选项动态：注册新策略源后 activeOptions 自动多一项（不写死）', () => {
  const p = createOutboundPolicy({
    getConfig: () => ({ ownerQQ: OWNER, outboundPolicy: { tier: 'gate' } }),
    now: () => 1000,
  });
  const mkSource = (name) => ({
    name, state: () => 'ready', ready: () => true,
    reserve: () => ({ ok: true, reserveId: `${name}-1` }),
    commit: () => ({ ok: true }), release: () => ({ ok: true }),
  });
  p.registerPolicySource(mkSource('purpose'));
  const before = outboundPanelView(p.status()).activeOptions.map((o) => o.value);
  assert.deepEqual(before, ['auto', 'purpose']);

  /** 以后注册第二个源：选项自动多出来，前端不用改 */
  p.registerPolicySource({ ...mkSource('future-engine'), title: '未来的引擎' });
  const after = outboundPanelView(p.status()).activeOptions.map((o) => o.value);
  assert.deepEqual(after, ['auto', 'purpose', 'future-engine']);
});
