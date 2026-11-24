import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTimeline, normalizeTimelineRows } from '../src/timeline-view.js';

const DIGESTS = [
  { id: 'd1', text: '今天聊了量子力学', at: 3000, day: '2026-11-20', chatId: 'g1', level: 'important' },
  { id: 'd2', text: '今天看了电影', at: 2000, day: '2026-11-19', chatId: 'g2', level: 'important' },
  { id: 'd3', text: '聊了养猫的事', at: 1000, day: '2026-11-18', chatId: 'g1', level: 'important' },
];
const IMPS = [
  { id: 'i1', text: '对方很细心', at: 2500, chatId: 'g1', hits: 3, crystallizedAt: 0 },
  { id: 'i2', text: '对方爱晚睡', at: 1500, chatId: 'g2', hits: 1, crystallizedAt: 999 }, // 已结晶，排除
];

test('G4：数据源 = digest + 印象，按 at 降序，已结晶印象排除', () => {
  const r = projectTimeline({ digestRows: DIGESTS, impressions: IMPS });
  assert.equal(r.list.length, 4); // 3 digest + 1 未结晶印象
  assert.deepEqual(r.list.map((x) => x.id), ['d1', 'i1', 'd2', 'd3']);
  assert.ok(!r.list.some((x) => x.id === 'i2'));
});

test('G4：五维过滤——kind/chatId/level/q 生效，about 无数据不报错', () => {
  const input = { digestRows: DIGESTS, impressions: IMPS };
  assert.deepEqual(projectTimeline(input, { kind: 'impression' }).list.map((x) => x.id), ['i1']);
  assert.deepEqual(projectTimeline(input, { chatId: 'g2' }).list.map((x) => x.id), ['d2']);
  assert.deepEqual(projectTimeline(input, { level: 'important' }).list.map((x) => x.id), ['d1', 'd2', 'd3']);
  assert.deepEqual(projectTimeline(input, { q: '猫' }).list.map((x) => x.id), ['d3']);
  assert.equal(projectTimeline(input, { about: '某人' }).total, 4, 'about 无数据不影响结果');
});

test('G4：facets 基于完整时间轴，不受当前筛选影响（对方刻意设计）', () => {
  const input = { digestRows: DIGESTS, impressions: IMPS };
  const all = projectTimeline(input);
  assert.deepEqual(all.facets.chats, ['g1', 'g2']);
  assert.deepEqual(all.facets.levels, ['important']);
  assert.deepEqual(all.facets.kinds, ['digest', 'impression']);
  const filtered = projectTimeline(input, { chatId: 'g1' });
  assert.deepEqual(filtered.facets.chats, ['g1', 'g2'], '选了 g1，g2 仍在 facets 选项里');
  assert.equal(filtered.total, 3, 'g1 下 d1/d3 两条 digest + i1 一条印象');
});

test('G4：分页 limit/offset/total/hasMore', () => {
  const input = { digestRows: DIGESTS, impressions: IMPS };
  const p1 = projectTimeline(input, { limit: 2 });
  assert.equal(p1.list.length, 2);
  assert.equal(p1.total, 4);
  assert.equal(p1.hasMore, true);
  const p2 = projectTimeline(input, { limit: 2, offset: 2 });
  assert.deepEqual(p2.list.map((x) => x.id), ['d2', 'd3']);
  assert.equal(p2.hasMore, false);
  const capped = projectTimeline(input, { limit: 999 });
  assert.equal(capped.list.length, 4, 'limit 上限 200 不误伤小数据');
});

test('G4：脏数据容错——失效行/抹除/空文本/坏 at 排除', () => {
  const rows = normalizeTimelineRows([
    null,
    { id: 'ok', text: '有效', at: 100 },
    { id: 'bad1', text: '失效', invalidAt: 123, at: 100 },
    { id: 'bad2', text: '（已按用户要求遗忘）', at: 100 },
    { id: 'bad3', text: '', at: 100 },
    { id: 'bad4', text: '坏时间', at: 'not-a-number' }, // at=0 保留但排最后
  ], [null, { text: '' }, { id: 'i-ok', text: '印象', at: 200 }]);
  // normalize 只归一不过滤顺序（排序在 projectTimeline）：digest 行先、印象行后
  assert.deepEqual(rows.map((x) => x.id), ['ok', 'bad4', 'i-ok']);
});

test('G4：空数据返回结构完整', () => {
  const r = projectTimeline({});
  assert.deepEqual(r.list, []);
  assert.equal(r.total, 0);
  assert.equal(r.hasMore, false);
  assert.deepEqual(r.facets, { chats: [], levels: [], kinds: [] });
});

test('G4：不修改入参', () => {
  const rows = DIGESTS.map((x) => ({ ...x }));
  const imps = IMPS.map((x) => ({ ...x }));
  const snapshot = JSON.stringify({ rows, imps });
  projectTimeline({ digestRows: rows, impressions: imps });
  assert.equal(JSON.stringify({ rows, imps }), snapshot);
});
