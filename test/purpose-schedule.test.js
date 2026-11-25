// 目的引擎排程层：安静时段、下一次时刻、tick 判定、次数记账。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateKey, parseClock, inQuietHours, quietEndAfter, nextDayStartAfter,
  ensurePurposeDay, ensurePurposeSchedule, recordOwnerReplyHours,
  bestReplyHourShift, bestReplyWeekdayShift, planNextFire, evaluatePurposeTick,
  markPurposeDelivered, markPurposeSkip,
} from '../src/purpose-schedule.js';
import { DEFAULT_PURPOSE_CONFIG as CFG } from '../src/purpose-engine.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 造一个本地时间（避免 UTC 偏移干扰断言） */
const at = (h, m = 0, day = 15) => new Date(2026, 0, day, h, m, 0, 0).getTime();

test('parseClock：合法值归一化，非法回退', () => {
  assert.deepEqual(parseClock('8:05'), { hh: 8, mm: 5, text: '08:05' });
  assert.equal(parseClock('23:30').text, '23:30');
  assert.equal(parseClock('25:00', '08:30').text, '08:30', '越界回退');
  assert.equal(parseClock('abc', '09:15').text, '09:15');
});

test('inQuietHours：跨午夜正确（23:30-08:30）', () => {
  assert.equal(inQuietHours(at(23, 45), CFG), true, '23:45 在安静时段');
  assert.equal(inQuietHours(at(3, 0), CFG), true, '凌晨 3 点在');
  assert.equal(inQuietHours(at(8, 29), CFG), true, '8:29 还在');
  assert.equal(inQuietHours(at(8, 30), CFG), false, '8:30 已结束');
  assert.equal(inQuietHours(at(12, 0), CFG), false, '中午不在');
  /** 起止相同 = 不启用 */
  assert.equal(inQuietHours(at(3, 0), { ...CFG, quietStart: '08:00', quietEnd: '08:00' }), false);
});

test('quietEndAfter / nextDayStartAfter：严格晚于 now', () => {
  const t = at(23, 45);
  const end = quietEndAfter(t, CFG);
  assert.ok(end > t);
  assert.equal(new Date(end).getHours(), 8);
  assert.equal(new Date(end).getDate(), 16, '跨到第二天');

  const next = nextDayStartAfter(at(12, 0), CFG);
  assert.ok(next > at(12, 0));
});

test('ensurePurposeDay：跨天清零次数', () => {
  const s = { day: localDateKey(at(10)), countToday: 3 };
  ensurePurposeDay(s, at(11));
  assert.equal(s.countToday, 3, '同一天不清');
  ensurePurposeDay(s, at(10, 0, 16));
  assert.equal(s.countToday, 0, '换天清零');
});

test('planNextFire：间隔落在 gapMin~gapMax 内', () => {
  const now = at(12);
  const next = planNextFire({ now, config: { ...CFG, quietStart: '23:30', quietEnd: '08:30' }, lastRunAt: now, random: () => 0.5 });
  const gap = next - now;
  assert.ok(gap >= CFG.gapMinMs && gap <= CFG.gapMaxMs + HOUR, `间隔 ${gap} 越界`);
});

test('planNextFire：到当日上限就推到下一天', () => {
  const now = at(12);
  const next = planNextFire({ now, config: { ...CFG, dailyMax: 2 }, lastRunAt: now, countToday: 2, random: () => 0.5 });
  assert.ok(next >= nextDayStartAfter(now, CFG) - MINUTE, '该推到明天');
});

test('planNextFire：停机很久只补一枪（2 分钟后）', () => {
  const now = at(12);
  const next = planNextFire({ now, config: CFG, lastRunAt: now - 10 * HOUR, random: () => 0 });
  assert.ok(next >= now + 2 * MINUTE - 1, '不能立刻补发');
  assert.ok(next < now + 3 * HOUR, '也不该拖太久');
});

test('planNextFire：落点撞安静时段就推到结束之后', () => {
  const now = at(22, 50);
  const next = planNextFire({ now, config: { ...CFG, gapMinMs: 60 * MINUTE, gapMaxMs: 60 * MINUTE }, lastRunAt: now, random: () => 0 });
  assert.equal(inQuietHours(next, CFG), false, '算出来的时刻不能在安静时段');
});

test('bestReplyHourShift：样本 <5 不偏置', () => {
  assert.equal(bestReplyHourShift(at(12), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]), 0);
});

test('bestReplyHourShift：明显高密度才推', () => {
  const hist = new Array(24).fill(0);
  hist[10] = 50; hist[12] = 2;
  const shift = bestReplyHourShift(at(9, 30), hist);
  assert.ok(shift > 0, '应往 10 点推');
});

test('bestReplyWeekdayShift：样本不足或只挤一天都不偏置', () => {
  assert.equal(bestReplyWeekdayShift(at(12), [1, 0, 0, 0, 0, 0, 0]), 0, '样本 <7');
  assert.equal(bestReplyWeekdayShift(at(12), [20, 0, 0, 0, 0, 0, 0]), 0, '非零桶 <2');
});

test('evaluatePurposeTick：闸门顺序与 nextFireAt', () => {
  const now = at(12);
  const base = { day: localDateKey(now), countToday: 0, nextFireAt: 0 };
  assert.equal(evaluatePurposeTick({ now, config: CFG, state: { ...base }, env: {} }).action, 'run');
  assert.equal(evaluatePurposeTick({ now, config: CFG, state: { ...base }, env: { enabled: false } }).reason, 'disabled');
  assert.equal(evaluatePurposeTick({ now, config: CFG, state: { ...base }, env: { paused: true } }).reason, 'paused');
  assert.equal(evaluatePurposeTick({ now, config: CFG, state: { ...base }, env: { busy: true } }).reason, 'busy');
  /** 未到点 */
  const waiting = evaluatePurposeTick({ now, config: CFG, state: { ...base, nextFireAt: now + HOUR }, env: {} });
  assert.equal(waiting.reason, 'waiting');
  /** 主人刚说过话 */
  const active = evaluatePurposeTick({ now, config: CFG, state: { ...base }, env: { ownerIdleMs: 5 * MINUTE } });
  assert.equal(active.reason, 'owner-active');
  /** 安静时段 */
  const quiet = evaluatePurposeTick({ now: at(2), config: CFG, state: { day: localDateKey(at(2)), countToday: 0 }, env: {} });
  assert.equal(quiet.reason, 'quiet');
  /** 当日上限 */
  const maxed = evaluatePurposeTick({ now, config: { ...CFG, dailyMax: 1 }, state: { ...base, countToday: 1 }, env: {} });
  assert.equal(maxed.reason, 'daily-max');
});

test('markPurposeDelivered / markPurposeSkip：次数与原因', () => {
  const s = { day: localDateKey(at(12)), countToday: 0, attempts: 0 };
  markPurposeDelivered(s, { now: at(12), planned: { text: '问她吃了没' } });
  assert.equal(s.countToday, 1);
  assert.equal(s.lastOutcome, 'pending');
  assert.equal(s.lastPurpose, '问她吃了没');

  markPurposeSkip(s, { now: at(12), reason: 'materials', nextFireAt: at(13) });
  assert.equal(s.lastSkip.reason, 'materials');
  assert.equal(s.nextFireAt, at(13));
});

test('recordOwnerReplyHours：只记 owner、按 id 去重', () => {
  const s = {};
  const materials = [
    { id: 'a', kind: 'owner', at: at(10) },
    { id: 'b', kind: 'member', at: at(11) },
    { id: 'a', kind: 'owner', at: at(10) },
  ];
  recordOwnerReplyHours(s, materials, at(12));
  assert.equal(s.replyHours[10], 1, 'owner 记一次');
  assert.equal(s.replyHours[11], 0, '群友不记');
  recordOwnerReplyHours(s, materials, at(12));
  assert.equal(s.replyHours[10], 1, '重复调用不重复记');
});
