import test from 'node:test';
import assert from 'node:assert/strict';

import { UNKNOWN_SOURCE, sourceLabel, sourcesOf, sourceStats } from '../src/source-stats.js';

test('sourceLabel：ext:<id> 取 id，有映射用映射，空兜底未知', () => {
  assert.equal(sourceLabel('ext:bili-mod'), 'bili-mod');
  assert.equal(sourceLabel('ext:bili-mod', { 'bili-mod': 'B站扩展' }), 'B站扩展');
  assert.equal(sourceLabel('panel'), '面板手记');
  assert.equal(sourceLabel(''), '来源未知');
  assert.equal(sourceLabel(null), '来源未知');
});

test('sourcesOf：src 优先，其次 extId，兜底 unknown', () => {
  assert.deepEqual(sourcesOf({ src: 'ext:x', extId: 'y' }), ['ext:x']);
  assert.deepEqual(sourcesOf({ extId: 'z' }), ['ext:z']);
  assert.deepEqual(sourcesOf({}), [UNKNOWN_SOURCE]);
  assert.deepEqual(sourcesOf(null), [UNKNOWN_SOURCE]);
});

test('sourceStats：扩展记忆按来源计 extFacts，计数与 total 一致', () => {
  const extRows = [
    { extId: 'bili', rows: [{ text: '看了个视频', src: 'ext:bili' }, { text: '又看一个', src: 'ext:bili' }] },
    { extId: 'song', rows: [{ text: '唱了首歌' }] }, // 无 src → 用 extId
  ];
  const out = sourceStats({ extRows });
  const bili = out.find((x) => x.source === 'ext:bili');
  assert.equal(bili.extFacts, 2);
  assert.equal(bili.total, 2);
  assert.equal(bili.label, 'bili');
  const song = out.find((x) => x.source === 'ext:song');
  assert.equal(song.extFacts, 1);
});

test('sourceStats：journal 分 episodes/digest，空文本不计', () => {
  const journals = [
    { kind: 'chat', role: 'user', text: '聊了什么' },
    { kind: 'chat', role: 'bot', text: '回了什么' },
    { kind: 'digest', role: 'digest', text: '那天的摘要' },
    { kind: 'chat', text: '   ' },
  ];
  const out = sourceStats({ journals });
  const qq = out.find((x) => x.source === UNKNOWN_SOURCE);
  assert.equal(qq.episodes, 2);
  assert.equal(qq.digest, 1);
  assert.equal(qq.total, 3);
});

test('sourceStats：空输入返回空数组，不抛错', () => {
  assert.deepEqual(sourceStats(), []);
  assert.deepEqual(sourceStats({ extRows: null, journals: null }), []);
});

test('sourceStats：脏数据容错（null 组/非数组 rows/null 行）', () => {
  const out = sourceStats({
    extRows: [null, { extId: 'x', rows: null }, { extId: 'y', rows: [null, { text: 'ok' }] }],
    journals: [null, { text: 'hello', kind: 'chat' }],
  });
  assert.ok(out.length >= 2);
  assert.ok(out.every((x) => x.total > 0), '不产生 0 条的空行');
});

test('sourceStats：按 source 名排序，传 labels 覆盖显示名', () => {
  const extRows = [
    { extId: 'z', rows: [{ text: 'a' }] },
    { extId: 'a', rows: [{ text: 'b' }] },
  ];
  const out = sourceStats({ extRows, labels: { a: '甲扩展' } });
  assert.deepEqual(out.map((x) => x.source), ['ext:a', 'ext:z']);
  assert.equal(out[0].label, '甲扩展');
});

test('sourceStats：不修改入参（纯函数）', () => {
  const extRows = [{ extId: 'x', rows: [{ text: 'a', src: 'ext:x' }] }];
  const before = JSON.stringify(extRows);
  sourceStats({ extRows });
  assert.equal(JSON.stringify(extRows), before);
});
