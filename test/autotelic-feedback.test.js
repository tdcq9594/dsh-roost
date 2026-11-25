// 自驱反馈回路：整文件移植自 aurabot feedback.js，按对方口径验核心行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedback } from '../src/autotelic-feedback.js';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test('纠偏：别再做→抑制表硬排除(权重0)；多干这种→偏好抬权重', () => {
  let clock = 1_000_000;
  const fb = createFeedback({ now: () => clock });
  fb.ingestCorrection('别再做这种发链接的事了', { tags: ['share-link'] });
  assert.equal(fb.isSuppressed('share-link'), true);
  assert.equal(fb.weightOf('share-link'), 0, '抑制表硬排除');

  fb.ingestCorrection('这种整理笔记的事多干点', { tags: ['note-keep'] });
  const w1 = fb.weightOf('note-keep');
  fb.ingestCorrection('笔记多干', { tags: ['note-keep'] });
  assert.ok(fb.weightOf('note-keep') >= w1, '偏好累加不降');
});

test('冷度：ignored 抬冷度、park 90 天、mention 解 park', () => {
  const t0 = 1_000_000;
  let clock = t0;
  const fb = createFeedback({ now: () => clock });
  for (let i = 0; i < 3; i++) {
    fb.recordDelivery({ id: `d${i}`, tag: 'share-link', at: clock + i });
    fb.recordResponse(`d${i}`, 'ignored', clock + i);
  }
  clock += DAY;
  assert.equal(fb.weightOf('share-link', clock), 0, 'park 中权重 0');
  assert.ok(fb.parkInfo('share-link'), '有 park 记录');
  fb.resume('share-link', 'mention', clock);
  assert.ok(fb.weightOf('share-link', clock) > 0, 'mention 解 park 后恢复');
});

test('24h 同 tag 频控：记过发言后能读出时刻', () => {
  let clock = 1_000_000;
  const fb = createFeedback({ now: () => clock });
  fb.recordSpoke('note', clock);
  assert.equal(fb.lastSpokeOf('note'), clock);
});

test('熔断：连续全灭/叫停到阈值 → 静默一轮 + 待检视', () => {
  let clock = 1_000_000;
  const fb = createFeedback({ now: () => clock });
  for (let i = 0; i < 3; i++) fb.recordRound({ dead: true, at: clock + i });
  assert.equal(fb.isSilent(clock + 3), true, '熔断静默');
  assert.equal(fb.needsReview(), true, '标记待检视');
  fb.clearReview();
  assert.equal(fb.needsReview(), false);
});

test('tick 写放大（P2）：稳态下不落盘，只有状态真变才写', async () => {
  const { createFeedback } = await import('../src/autotelic-feedback.js');
  const dir = mkdtempSync(join(tmpdir(), 'fb-'));
  try {
    const file = join(dir, 'feedback.json');
    const fb = createFeedback({ file, settings: () => ({ responseWindowHours: 48 }), log: {} });
    const t0 = Date.now();
    // 造一条 chill（模拟曾 ignored 过）
    fb.recordDelivery({ id: 'a', tag: 'x', text: 'hi', at: t0 });
    fb.recordResponse('a', 'ignored', t0);
    fb.tick(t0);
    const first = readFileSync(file, 'utf8');
    const mtime1 = statSync(file).mtimeMs;
    // 1 分钟后（dt<1h）：值不变 → 不该写盘（内容与 mtime 都不该动）
    const r2 = fb.tick(t0 + 60_000);
    assert.equal(r2.expired, 0);
    assert.equal(readFileSync(file, 'utf8'), first, '稳态 tick 不该改文件内容');
    assert.equal(statSync(file).mtimeMs, mtime1, '稳态 tick 不该重写文件（mtime 不变）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tick 到期窗口（P2）：真的过期才落盘并记 ignored', async () => {
  const { createFeedback } = await import('../src/autotelic-feedback.js');
  const dir = mkdtempSync(join(tmpdir(), 'fb2-'));
  try {
    const file = join(dir, 'feedback.json');
    const fb = createFeedback({ file, settings: () => ({ responseWindowHours: 48 }), log: {} });
    const t0 = Date.now();
    fb.recordDelivery({ id: 'b', tag: 'y', text: 'hi', at: t0 });
    const r = fb.tick(t0 + 49 * 3600_000);
    assert.equal(r.expired, 1, '超过 48h 要记一次 ignored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tick 写盘（P3-C）：冷度归零后不再每小时写盘', async () => {
  const { createFeedback } = await import('../src/autotelic-feedback.js');
  const dir = mkdtempSync(join(tmpdir(), 'fb3-'));
  try {
    const file = join(dir, 'feedback.json');
    const fb = createFeedback({ file, settings: () => ({ responseWindowHours: 48 }), log: {} });
    const t0 = Date.now();
    // replied 抵扣把冷度打到 0
    fb.recordDelivery({ id: 'c', tag: 'z', text: 'hi', at: t0 });
    fb.recordResponse('c', 'replied', t0);
    fb.tick(t0);
    const before = readFileSync(file, 'utf8');
    const m0 = statSync(file).mtimeMs;
    // 前进 10 小时，分 10 次 tick（每次都跨 1h）
    for (let h = 1; h <= 10; h += 1) fb.tick(t0 + h * 3600_000);
    assert.equal(readFileSync(file, 'utf8'), before, '零冷度条目不该因时间推进而改写');
    assert.equal(statSync(file).mtimeMs, m0, 'mtime 也不该变');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
