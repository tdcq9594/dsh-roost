import test from 'node:test';
import assert from 'node:assert/strict';
import { planHeat, dayKey, HIT_DAY_CAP } from '../src/memory-heat.js';

const NOW = Date.parse('2026-11-24T12:00:00');

test('G8 第2层自然日去重：同一天注入多次只涨一次', () => {
  const first = planHeat({ injected: ['事实A'], heat: {}, recent: [] }, { now: NOW });
  assert.equal(first.updates.length, 1);
  assert.equal(first.updates[0].hitDays, 1);
  const heat = { '事实A': first.updates[0] };
  const second = planHeat({ injected: ['事实A'], heat, recent: first.recent }, { now: NOW + 3600e3 });
  assert.equal(second.updates.length, 0, '同一天不再涨');
});

test('G8 跨天再涨 + 封顶 40', () => {
  const nextDay = NOW + 86400e3;
  const r = planHeat({ injected: ['事实A'], heat: { '事实A': { hitDays: HIT_DAY_CAP, lastHitDay: '2026-11-20', lastHit: NOW - 4 * 86400e3 } }, recent: [] }, { now: nextDay });
  assert.equal(r.updates[0].hitDays, HIT_DAY_CAP, '封顶不超 40');
  const almost = planHeat({ injected: ['事实B'], heat: { '事实B': { hitDays: 39, lastHitDay: '2026-11-20' } }, recent: [] }, { now: nextDay });
  assert.equal(almost.updates[0].hitDays, 40);
});

test('G8 第5层最近注入排除：窗口内重复注入不计热（防霸榜）', () => {
  const r1 = planHeat({ injected: ['事实A'], heat: {}, recent: [] }, { now: NOW, window: 2 });
  // 下一轮（不同天）A 仍在 recent 窗口里 → 不计热
  const nextDay = NOW + 86400e3;
  const r2 = planHeat({ injected: ['事实A'], heat: { '事实A': r1.updates[0] }, recent: r1.recent }, { now: nextDay, window: 2 });
  assert.equal(r2.updates.length, 0, '最近注入过的本轮不计热');
  // 再过一轮，A 被挤出窗口 → 可以计热
  const day3 = nextDay + 86400e3;
  const r3 = planHeat({ injected: ['事实A'], heat: { '事实A': r1.updates[0] }, recent: [] }, { now: day3, window: 2 });
  assert.equal(r3.updates.length, 1, '挤出窗口后可再计热');
});

test('G8 recent 记账去重 + 截断到 window', () => {
  const r = planHeat({ injected: ['A', 'B', 'C'], heat: {}, recent: ['D', 'E'] }, { now: NOW, window: 3 });
  assert.deepEqual(r.recent, ['A', 'B', 'C'], '本轮注入的在前，截到 window');
});

test('G8 脏数据容错：空输入/非数组/坏 heat 不崩', () => {
  assert.deepEqual(planHeat({}, { now: NOW }).updates, []);
  const r = planHeat({ injected: [null, '', 123, '有效'], heat: { '有效': '坏值' }, recent: null }, { now: NOW });
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].text, '有效');
});

test('G8 dayKey 本地日（不用 UTC）', () => {
  const d = new Date(2026, 10, 24, 1, 0, 0); // 本地凌晨 1 点
  assert.equal(dayKey(d.getTime()), '2026-11-24');
});
