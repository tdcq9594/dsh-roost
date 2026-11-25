// 自驱排程层：醒着窗口、随机间隔、每日额度、回话直方图轻推、防重入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduleConfig, quietOf, computeNextFire, createSchedule } from '../src/autotelic-schedule.js';

const MINUTE = 60_000;
const at = (h, m = 0) => new Date(2026, 0, 15, h, m, 0, 0).getTime();

test('scheduleConfig：夹紧非法值', () => {
  const c = scheduleConfig({ awakeFrom: -5, awakeTo: 99, minIntervalMinutes: 1, maxIntervalMinutes: 99999, maxPerDay: 50 });
  assert.equal(c.awakeFrom, 0);
  assert.equal(c.awakeTo, 24);
  assert.equal(c.minIntervalMinutes, 5);
  assert.equal(c.maxIntervalMinutes, 2880);
  assert.equal(c.maxPerDay, 20);
});

test('quietOf：安静窗口是醒着窗口的补集', () => {
  const q = quietOf({ awakeFrom: 8, awakeTo: 23 });
  assert.equal(q.quietStart, '23:00');
  assert.equal(q.quietEnd, '08:00');
});

test('computeNextFire：间隔落在 min~max 内', () => {
  const cfg = scheduleConfig({ minIntervalMinutes: 60, maxIntervalMinutes: 120 });
  const now = at(12);
  const next = computeNextFire({ now, cfg, lastRunAt: now, random: () => 0.5 });
  const gap = next - now;
  assert.ok(gap >= 60 * MINUTE && gap <= 120 * MINUTE + 3 * 3600_000, `间隔 ${gap}`);
});

test('computeNextFire：到当日额度推到次日', () => {
  const cfg = scheduleConfig({ maxPerDay: 2, minIntervalMinutes: 60, maxIntervalMinutes: 60 });
  const now = at(12);
  const next = computeNextFire({ now, cfg, lastRunAt: now, countToday: 2, random: () => 0 });
  assert.ok(next > now + 12 * 3600_000, '该推到明天');
});

test('computeNextFire：停机很久只补一枪（2 分钟后）', () => {
  const cfg = scheduleConfig({ minIntervalMinutes: 90, maxIntervalMinutes: 240 });
  const now = at(12);
  const next = computeNextFire({ now, cfg, lastRunAt: now - 10 * 3600_000, random: () => 0 });
  assert.ok(next >= now + 2 * MINUTE - 1);
  assert.ok(next < now + 3 * 3600_000);
});

test('createSchedule：未到点只等，不跑 run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch-'));
  try {
    let ran = 0;
    const sch = createSchedule({
      settings: () => ({ minIntervalMinutes: 90, maxIntervalMinutes: 240 }),
      file: join(dir, 's.json'),
      run: async () => { ran += 1; },
      now: () => at(12),
      random: () => 0.5,
    });
    /** 先跑一次让它排下次 */
    const r1 = await sch.tick();
    assert.equal(r1.ran, true);
    const r2 = await sch.tick();
    assert.equal(r2.ran, false);
    assert.equal(r2.why, 'waiting');
    assert.equal(ran, 1, '未到点不该再跑');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSchedule：安静时段不跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch2-'));
  try {
    let ran = 0;
    const sch = createSchedule({
      settings: () => ({ awakeFrom: 8, awakeTo: 23 }),
      file: join(dir, 's.json'),
      run: async () => { ran += 1; },
      now: () => at(2), // 凌晨 2 点，安静时段
    });
    const r = await sch.tick();
    assert.equal(r.ran, false);
    assert.equal(r.why, 'quiet');
    assert.equal(ran, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSchedule：防重入——并发 tick 只跑一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch3-'));
  try {
    let ran = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const sch = createSchedule({
      settings: () => ({ minIntervalMinutes: 5, maxIntervalMinutes: 5 }),
      file: join(dir, 's.json'),
      run: async () => { ran += 1; await gate; },
      now: () => at(12),
    });
    const p1 = sch.tick();
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await sch.tick();
    assert.equal(r2.ran, false);
    assert.equal(r2.why, 'in-flight');
    release();
    await p1;
    assert.equal(ran, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSchedule：recordReply 记直方图并去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch4-'));
  try {
    const sch = createSchedule({
      settings: () => ({}), file: join(dir, 's.json'), run: async () => {}, now: () => at(13),
    });
    sch.recordReply(at(10), 'm1');
    sch.recordReply(at(10), 'm1');
    const v = sch.view();
    assert.equal(v.replyHours[10], 1, '同 id 只记一次');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createSchedule：ignite 有冷却', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch5-'));
  try {
    let ran = 0;
    const sch = createSchedule({
      settings: () => ({ igniteCooldownMinutes: 45, minIntervalMinutes: 5, maxIntervalMinutes: 5 }),
      file: join(dir, 's.json'), run: async () => { ran += 1; }, now: () => at(12),
    });
    const a = await sch.ignite();
    const b = await sch.ignite();
    assert.equal(b.ran, false);
    assert.equal(b.why, 'cooldown');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('额度（P1）：run 抛错不扣当日次数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch6-'));
  try {
    const sch = createSchedule({
      settings: () => ({ minIntervalMinutes: 5, maxIntervalMinutes: 5 }),
      file: join(dir, 's.json'),
      run: async () => { throw new Error('模型挂了'); },
      now: () => at(12),
    });
    const r = await sch.tick();
    assert.equal(r.ran, false);
    assert.equal(sch.view().countToday, 0, '失败不该吃掉额度');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('额度（P1）：run 成功才计次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sch7-'));
  try {
    const sch = createSchedule({
      settings: () => ({ minIntervalMinutes: 5, maxIntervalMinutes: 5 }),
      file: join(dir, 's.json'),
      run: async () => ({ ok: true }),
      now: () => at(12),
    });
    await sch.tick();
    assert.equal(sch.view().countToday, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
