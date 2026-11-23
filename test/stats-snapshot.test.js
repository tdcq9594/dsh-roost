// A2 记忆统计快照的单测：真行为，不断言源码文本。
// 纯函数——输入已读好的数据，输出聚合；不碰 sqlite、不碰数据目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { statsSnapshot, alignDays, dayOf } = await import('../src/stats-snapshot.js');

const NOW = new Date('2026-11-23T12:00:00').getTime();

test('A2-1 空库给一张全 0 的卡，不是 NaN / 报错', () => {
  const s = statsSnapshot({ now: NOW });
  assert.equal(s.facts.total, 0);
  assert.equal(s.facts.live, 0);
  assert.equal(s.journal.compressionRate, 0);
  assert.equal(s.graph.entities, 0);
  assert.equal(s.usage.turns, 0);
  assert.equal(s.usage.cacheHit, null);
  assert.equal(s.timeseries.length, 7);
  assert.ok(s.timeseries.every((d) => d.count === 0));
});

test('A2-2 facts 只数活条目，按 tier/status 分层', () => {
  const s = statsSnapshot({
    global: [
      { text: 'a', tier: 'long', status: 'fact' },
      { text: 'b', tier: 'short', status: 'hearsay' },
      { text: 'c', tier: 'long', status: 'fact', until: 123 },
      { text: 'd', tier: 'long', status: 'fact', archivedAt: 456 },
      { text: 'e', tier: 'long', status: 'fact', directive: true, proofs: 2 },
    ],
    chat: [{ text: 'f', tier: 'long', status: 'guess' }],
    now: NOW,
  });
  assert.equal(s.facts.total, 6, '存储总数含历史');
  assert.equal(s.facts.live, 4, '被取代/归档不算"她记得的事"');
  assert.equal(s.facts.global, 5);
  assert.equal(s.facts.chat, 1);
  assert.deepEqual(s.facts.byTier, { long: 3, short: 1 });
  assert.deepEqual(s.facts.byStatus, { fact: 2, hearsay: 1, guess: 1 });
  assert.equal(s.facts.directives, 1);
  assert.equal(s.facts.withEvidence, 1);
});

test('A2-3 journal 压缩率、graph 边数、usage 账都来自传入快照', () => {
  const s = statsSnapshot({
    journal: { total: 100, compressed: 25, critical: 5, withVec: 10 },
    graph: { enabled: true, entities: 8, edges: 12, ended: 3 },
    usage: { total: { turns: 4, cacheRead: 60, cacheWrite: 10, uncached: 30, output: 20, cacheHit: 60 }, cost: { yuan: 1.23 } },
    now: NOW,
  });
  assert.equal(s.journal.compressionRate, 0.25);
  assert.equal(s.graph.edges, 12, '只数有效边，和 graph.stats() 同口径');
  assert.equal(s.usage.cacheHit, 60);
  assert.equal(s.usage.cost.yuan, 1.23);
});

test('A2-4 按天时序补齐空白天、对齐窗口', () => {
  const rows = [
    { day: '2026-11-23', count: 3 },
    { day: '2026-11-20', count: 2 },
    { day: 'not-a-day', count: 99 },
  ];
  const out = alignDays(rows, { days: 5, now: NOW });
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((r) => r.day), ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
  assert.deepEqual(out.map((r) => r.count), [0, 2, 0, 0, 3]);
  assert.equal(dayOf(NOW), '2026-11-23');
});

test('A2-5 period：0/缺省走默认 7，上限夹到 400，输入是纯的', () => {
  assert.equal(statsSnapshot({ period: 0, now: NOW }).timeseries.length, 7, '0 = 没传，走默认');
  assert.equal(statsSnapshot({ period: 1, now: NOW }).timeseries.length, 1);
  assert.equal(statsSnapshot({ period: 9999, now: NOW }).period, 400);
  const input = { global: [{ text: 'x' }], days: [{ day: '2026-11-23', count: 1 }] };
  const before = JSON.stringify(input);
  statsSnapshot({ ...input, now: NOW });
  assert.equal(JSON.stringify(input), before, '不修改入参');
});
