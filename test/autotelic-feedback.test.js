// 自驱反馈回路：整文件移植自 aurabot feedback.js，按对方口径验核心行为。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedback } from '../src/autotelic-feedback.js';

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
