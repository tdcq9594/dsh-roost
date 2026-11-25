// 自驱刊物：反思文本、每日一页（含强制段落）、做梦产出、daily/dreams 存取。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dayKey, reflectionText, writeReflection, reviewDue,
  buildDailyPage, dreamDue, distillDream, createJournal,
} from '../src/autotelic-reflect.js';

test('dayKey：YYYY-MM-DD', () => {
  assert.match(dayKey(new Date('2026-01-15T10:00:00Z').getTime()), /^\d{4}-\d{2}-\d{2}$/);
});

test('reflectionText：教训优先，没教训用假设', () => {
  const task = { title: '整理笔记', status: 'done' };
  const withLesson = reflectionText(task, { lesson: '下次先分类', evidence: '翻了三遍', hypothesis: '笔记太乱' });
  assert.match(withLesson, /下次先分类/);
  assert.match(withLesson, /依据：翻了三遍/);
  const noLesson = reflectionText(task, { hypothesis: '笔记太乱' });
  assert.match(noLesson, /当初想：笔记太乱/);
});

test('writeReflection：写进长期记忆，memory 没开静默跳过', () => {
  let got = null;
  const ok = writeReflection({ addEvent: (e) => { got = e; return { id: 'm1' }; } },
    { title: '整理笔记', status: 'done' }, { lesson: '下次先分类' });
  assert.equal(ok.ok, true);
  assert.deepEqual(got.tags, ['自驱', '反思']);
  assert.equal(writeReflection(null, { title: 'x', status: 'done' }).ok, false);
});

test('reviewDue：到点 / 攒够件数 / 已写过', () => {
  const at = new Date('2026-01-15T23:10:00').getTime();
  assert.equal(reviewDue({ settings: { dailyReviewHour: 23 }, at }).due, true);
  assert.equal(reviewDue({ settings: { dailyReviewHour: 23 }, at, writtenToday: true }).due, false);
  assert.equal(reviewDue({ settings: { minBatchForReview: 3 }, tasks: [], closedToday: 3 }).due, true);
  assert.equal(reviewDue({ settings: {}, tasks: [], closedToday: 0 }).due, false);
});

test('buildDailyPage：强制含「今天没敢说的」段，任务按账本口径', () => {
  const page = buildDailyPage({
    date: '2026-01-15',
    tasks: [
      { title: '整理笔记', status: 'done' },
      { title: '修 bug', status: 'blocked', why: '没法复现' },
    ],
    actionsToday: 5,
    hushText: '',
  });
  assert.match(page, /今天没敢说的/);
  assert.match(page, /（今天没什么没敢说的。）/);
  assert.match(page, /「整理笔记」→ 办成/);
  assert.match(page, /「修 bug」→ 卡住/);
  assert.match(page, /全天动作 5 次/);
});

test('dreamDue：窗口内为真，留空关闭，一天一次', () => {
  const at = new Date('2026-01-15T03:30:00').getTime();
  assert.equal(dreamDue({ settings: { dreamFrom: '03:00', dreamTo: '05:00' }, at }), true);
  assert.equal(dreamDue({ settings: { dreamFrom: '', dreamTo: '' }, at }), false);
  assert.equal(dreamDue({ settings: { dreamFrom: '03:00', dreamTo: '05:00' }, at, doneToday: true }), false);
});

test('distillDream：模型文本够 3 条就用它，否则模板回退', () => {
  const fromModel = distillDream({ tasks: [], modelText: '- 一条\n- 二条\n- 三条' });
  assert.deepEqual(fromModel, ['一条', '二条', '三条']);
  const fallback = distillDream({ tasks: [
    { title: '没办成的事', status: 'blocked', why: '缺工具' },
    { title: '办成的事', status: 'done' },
  ], auditToday: 4 });
  assert.ok(fallback.length >= 3);
  assert.ok(fallback.some((x) => x.includes('缺工具')));
});

test('createJournal：daily/dreams 分目录，列最近 N 天倒序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-'));
  try {
    const j = createJournal(dir);
    assert.equal(j.write('daily', '2026-01-14', '第一页'), true);
    assert.equal(j.write('daily', '2026-01-15', '第二页'), true);
    assert.equal(j.write('dreams', '2026-01-15', '一个梦'), true);
    assert.equal(j.exists('daily', '2026-01-14'), true);
    assert.equal(j.read('daily', '2026-01-14'), '第一页');
    const daily = j.list('daily', 7);
    assert.deepEqual(daily.map((x) => x.day), ['2026-01-15', '2026-01-14']);
    assert.equal(j.list('dreams', 7)[0].text, '一个梦');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
