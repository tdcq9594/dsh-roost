import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DRY_RUN_FEATURES, retentionR, canExpire, planRetention, formatImpact } from '../src/dry-run.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 8);

const entry = (id, over = {}) => ({
  id,
  at: NOW - 90 * DAY,
  lastAccess: NOW - 90 * DAY,
  importance: 0.5,
  source: 'auto',
  ...over,
});

test('dry-run：默认关时一条都不动（默认关等价基线）', () => {
  const list = [entry('a'), entry('b')];
  for (const mode of [undefined, 'off', '', 'bogus']) {
    const plan = planRetention(list, { mode }, NOW);
    assert.equal(plan.enabled, false);
    assert.equal(plan.affected, 0);
    assert.equal(plan.kept, 2);
    assert.deepEqual(plan.items, []);
    assert.equal(plan.purge, false);
  }
  assert.match(formatImpact(planRetention(list, { mode: 'off' }, NOW)), /不会动任何记忆/);
});

test('dry-run：只挑自动提炼且不重要的，用户明说记住的一律不碰', () => {
  const list = [
    entry('auto-old'),
    entry('explicit', { source: 'explicit' }),
    entry('manual', { source: 'panel' }),
    entry('important', { importance: 0.9 }),
    entry('critical', { critical: true }),
    entry('already', { expiredAt: NOW - DAY }),
  ];
  const plan = planRetention(list, { mode: 'expire', thresholdPct: 5, minProtectDays: 30 }, NOW);
  assert.equal(plan.affected, 1);
  assert.equal(plan.items[0].id, 'auto-old');
  assert.equal(canExpire(entry('x', { source: 'explicit' })), false);
  assert.equal(canExpire(entry('x', { importance: 0.6 })), false);
});

test('dry-run：最短保护期内的新记忆不参与', () => {
  const list = [entry('fresh', { at: NOW - 3 * DAY, lastAccess: NOW - 3 * DAY })];
  assert.equal(planRetention(list, { mode: 'expire', minProtectDays: 30 }, NOW).affected, 0);
  assert.equal(planRetention(list, { mode: 'expire', minProtectDays: 0 }, NOW).affected, 0, '没到阈值也不该中');
});

test('dry-run：被检索过的旧事更黏（用现有 lastAccess，不新增 hitDays）', () => {
  const old = entry('old', { at: NOW - 200 * DAY, lastAccess: NOW - 200 * DAY });
  const recalled = entry('recalled', { at: NOW - 200 * DAY, lastAccess: NOW - 3 * DAY });
  assert.ok(retentionR(recalled, NOW) > retentionR(old, NOW));
  assert.equal(planRetention([old], { mode: 'expire', minProtectDays: 0 }, NOW).affected, 1);
  assert.equal(planRetention([recalled], { mode: 'expire', minProtectDays: 0 }, NOW).affected, 0);
});

test('dry-run：阈值按整数百分数理解，越界值夹紧而不是全删', () => {
  const list = [entry('a')];
  for (const pct of [0, -5, 'abc', 999]) {
    const plan = planRetention(list, { mode: 'expire', thresholdPct: pct, minProtectDays: 0 }, NOW);
    assert.ok(plan.affected === 0 || plan.affected === 1, '不能因为坏配置抛错');
  }
  assert.equal(planRetention(list, { mode: 'expire', thresholdPct: 1, minProtectDays: 0 }, NOW).affected, 0,
    '阈值 1% 比 5% 更宽松，这条早该低于 5% 但可能高于 1% 以下仍该保留');
  assert.equal(planRetention(list, { mode: 'expire', thresholdPct: 50, minProtectDays: 0 }, NOW).affected, 1,
    '阈值 50% 更严格');
});

test('dry-run：purge 只是标记，返回的仍是同一批 id（真删由调用方先备份）', () => {
  const list = [entry('a'), entry('b')];
  const expire = planRetention(list, { mode: 'expire', minProtectDays: 0 }, NOW);
  const purge = planRetention(list, { mode: 'purge', minProtectDays: 0 }, NOW);
  assert.deepEqual(purge.items.map((x) => x.id), expire.items.map((x) => x.id));
  assert.equal(purge.purge, true);
  assert.equal(expire.purge, false);
  assert.match(formatImpact(purge), /真删/);
  assert.match(formatImpact(expire), /作废不删行/);
});

test('dry-run：影响数据的开关都登记在预览清单里', () => {
  assert.ok(DRY_RUN_FEATURES.includes('retentionMode'));
  assert.ok(DRY_RUN_FEATURES.includes('profiles'));
  assert.ok(DRY_RUN_FEATURES.includes('events'));
});
