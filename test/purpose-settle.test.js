// 目的引擎结算层：三态结算、驱力满足、待续账、备忘解析。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  textSimilarity, isDuplicateText, satisfyDrives, applyFeelingDeltas,
  parsePurposeMemo, addPendingPurpose, resolvePendingPurpose, prunePurposeState, applyPurposeOutcome,
} from '../src/purpose-settle.js';
import { DEFAULT_PURPOSE_CONFIG as CFG, DEFAULT_DRIVES } from '../src/purpose-engine.js';

const at = (h = 12, m = 0) => new Date(2026, 0, 15, h, m, 0, 0).getTime();

test('textSimilarity：中文双字 Jaccard，无关文本为 0', () => {
  assert.ok(textSimilarity('今天吃了拉面', '今天吃了拉面') === 1);
  assert.ok(textSimilarity('今天吃了拉面', '今天吃了火锅') > 0.4);
  assert.equal(textSimilarity('今天吃面', '完全不同的内容'), 0);
  assert.equal(textSimilarity('', 'x'), 0);
});

test('isDuplicateText：和历史的 purpose/planned/text 任一相似即重复', () => {
  const h = [{ purpose: '问他周末去哪玩' }];
  assert.equal(isDuplicateText('问他周末去哪玩', h), true);
  assert.equal(isDuplicateText('今天天气不错', h), false);
});

test('satisfyDrives：sent 才大幅降，silent 轻微降，failed 不动', () => {
  const before = { ...DEFAULT_DRIVES, play: 0.8 };
  const sent = satisfyDrives(before, { need: 'play', outcome: 'sent' });
  assert.ok(sent.play < 0.4, 'sent 后 play 大幅降');
  const silent = satisfyDrives(before, { need: 'play', outcome: 'silent' });
  assert.ok(silent.play > 0.6 && silent.play < 0.8, 'silent 只轻微降');
  const failed = satisfyDrives(before, { need: 'play', outcome: 'failed' });
  assert.equal(failed.play, 0.8, 'failed 不降');
});

test('applyFeelingDeltas：按需要叠加并钳到 0~1', () => {
  const d = applyFeelingDeltas({ ...DEFAULT_DRIVES, play: 0.9 }, { play: 0.5 });
  assert.equal(d.play, 1, '封顶 1');
  const d2 = applyFeelingDeltas({ ...DEFAULT_DRIVES, play: 0.1 }, { play: -0.5 });
  assert.equal(d2.play, 0, '托底 0');
});

test('parsePurposeMemo：解析【目的】【状态】【待续】【需求】', () => {
  const raw = '好的\n【目的】问他周末去不去爬山\n【类型】好奇\n【状态】待续\n【待续】他还没回我\n【需求】陪\n【情绪】期待';
  const m = parsePurposeMemo(raw);
  assert.equal(m.purpose, '问他周末去不去爬山');
  assert.equal(m.kind, 'curiosity');
  assert.equal(m.status, '待续');
  assert.equal(m.followUp, '他还没回我');
  assert.equal(m.need, 'connect');
  assert.equal(m.feelings, null, '精简版不解析感受');
});

test('parsePurposeMemo：裸标签与 JSON 两种兜底', () => {
  assert.equal(parsePurposeMemo('目的：问他在干嘛\n状态：完成').purpose, '问他在干嘛');
  const j = parsePurposeMemo('{"目的":"分享一个视频","状态":"完成"}');
  assert.equal(j.purpose, '分享一个视频');
  assert.equal(parsePurposeMemo('完全无关的一段话'), null);
});

test('addPendingPurpose / resolvePendingPurpose：同义累加，推进后摘掉', () => {
  const s = { pending: [] };
  addPendingPurpose(s, { text: '问他周末去哪玩', now: at() });
  addPendingPurpose(s, { text: '问他周末去哪玩呀', now: at() });
  assert.equal(s.pending.length, 1, '同义不重复堆');
  assert.ok(s.pending[0].hits >= 1);
  const r = resolvePendingPurpose(s, '问他周末去哪玩');
  assert.ok(r, '应能摘掉');
  assert.equal(s.pending.length, 0);
});

test('prunePurposeState：过期待续与超长历史被裁', () => {
  const s = {
    pending: [{ text: 'a', expiresAt: 1 }, { text: 'b', expiresAt: at() + 100000 }],
    history: new Array(100).fill({ at: 1 }),
  };
  prunePurposeState(s, { now: at(), config: { ...CFG, historyLimit: 20 } });
  assert.equal(s.pending.length, 1, '过期条目被淘汰');
  assert.equal(s.history.length, 20, '历史只留 20 条');
});

test('applyPurposeOutcome：sent 结算置信度、驱力、历史与下次时刻', () => {
  const s = {
    day: '2026-01-15', countToday: 1, attempts: 0,
    drives: { ...DEFAULT_DRIVES, play: 0.8 },
    goals: [{ id: 'g1', status: 'hypothesis', confidence: 0.3, owner: 'owner' }],
    pending: [], history: [],
  };
  applyPurposeOutcome(s, {
    now: at(), config: CFG, outcome: 'sent', text: '问他周末去不去爬山',
    memo: { purpose: '问他周末去不去爬山', need: 'play', status: '完成', kind: 'share' },
    planned: { text: '问他周末去不去爬山', goalId: 'g1' },
  });
  assert.equal(s.lastOutcome, 'sent');
  assert.equal(s.goals[0].status, 'active', 'hypothesis → active');
  assert.ok(s.goals[0].confidence > 0.3, '置信度上升');
  assert.ok(s.drives.play < 0.4, '驱力被满足');
  assert.equal(s.history.length, 1);
  assert.ok(s.nextFireAt > at(), '排了下次');
});

test('applyPurposeOutcome：failed 会按 retryMs 重试，次数到顶才排下一次', () => {
  /** attempts 由 markPurposeDelivered 加（投递即占次数），结算层只读它 */
  const s = { day: '2026-01-15', countToday: 1, attempts: 1, drives: { ...DEFAULT_DRIVES }, pending: [], history: [] };
  applyPurposeOutcome(s, { now: at(), config: { ...CFG, maxAttempts: 3, retryMs: 15 * 60000 }, outcome: 'failed' });
  assert.equal(s.nextFireAt, at() + 15 * 60000, '未到上限按 retryMs 重试');

  const s2 = { day: '2026-01-15', countToday: 1, attempts: 3, drives: { ...DEFAULT_DRIVES }, pending: [], history: [] };
  applyPurposeOutcome(s2, { now: at(), config: { ...CFG, maxAttempts: 3 }, outcome: 'failed' });
  assert.ok(s2.nextFireAt > at() + 15 * 60000, '到上限后走正常排程');
});
