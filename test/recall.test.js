import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchWithShortContext, recallRow } from '../src/recall.js';

const row = (id, score, why = '关键词') => ({ id, score, why, text: `原文 ${id}` });

/** 假 journal：记下每次检索的词，按词返回预设结果 */
function fakeJournal(byQuery) {
  const calls = [];
  return {
    calls,
    async search(q, opts) {
      calls.push({ q, limit: opts?.limit });
      return (byQuery[q] || []).slice(0, opts?.limit ?? 3);
    },
  };
}

test('D4：短句 + 上一句 + 主结果不足，才补搜一次', async () => {
  const j = fakeJournal({
    '嗯': [row('a', 0.016)],
    '刚才那个游戏挺好玩的 嗯': [row('a', 0.016), row('b', 0.015), row('c', 0.014)],
  });
  const r = await searchWithShortContext(j, '嗯', { limit: 3 }, '刚才那个游戏挺好玩的');
  assert.equal(j.calls.length, 2, '短句该补搜一次');
  assert.equal(j.calls[1].q, '刚才那个游戏挺好玩的 嗯');
  assert.equal(r.shortPhrase, true);
  assert.equal(r.usedPrev, true);
  assert.deepEqual(r.hits.map((h) => h.id), ['a', 'b', 'c'], '去重后按原顺序补位');
});

test('D4：补进来的条目分数原样保留（RRF 名次分上绝不乘系数）', async () => {
  const j = fakeJournal({
    '嗯': [row('a', 0.0161)],
    '上一句 嗯': [row('b', 0.0158)],
  });
  const r = await searchWithShortContext(j, '嗯', { limit: 3 }, '上一句');
  assert.equal(r.hits[1].score, 0.0158, '乘了 0.6 这里就会变');
  assert.ok(r.hits[0].score > r.hits[1].score, '原分顺序不该被反转');
});

test('D4：长句 / 主结果已满 / 没有上一句，都不补搜', async () => {
  for (const [q, first, prev] of [
    ['这句话已经超过十二个字了应该自己就够检索了', [row('a', 0.016)], '上一句'],
    ['嗯', [row('a', 0.016), row('b', 0.015), row('c', 0.014)], '上一句'],
    ['嗯', [row('a', 0.016)], ''],
  ]) {
    const j = fakeJournal({ [q]: first });
    const r = await searchWithShortContext(j, q, { limit: 3 }, prev);
    assert.equal(j.calls.length, 1, `${q} 不该补搜`);
    assert.equal(r.usedPrev, false);
  }
});

test('D4：补搜抛错时由调用方兜底，这里不吞异常也不伪造命中', async () => {
  const j = {
    calls: 0,
    async search() {
      this.calls += 1;
      if (this.calls > 1) throw new Error('第二次检索挂了');
      return [row('a', 0.016)];
    },
  };
  await assert.rejects(() => searchWithShortContext(j, '嗯', { limit: 3 }, '上一句'), /挂了/);
});

test('D3：召回日志行只有结构化字段，绝不存正文（含检索词）', () => {
  const q = '主人说他花生过敏千万别忘';
  const r = recallRow('g1', q, [row('j1', 0.016, '关键词+向量#1')], { shortPhrase: false, usedPrev: true });
  const s = JSON.stringify(r);
  assert.ok(!s.includes(q), '检索词不能进日志');
  assert.ok(!s.includes('原文'), '命中日记的正文不能进日志');
  assert.equal(r.queryLen, [...q].length);
  assert.equal(r.shown, 1);
  assert.equal(r.usedPrev, true);
  assert.deepEqual(r.items, [{ id: 'j1', score: 0.016, why: '关键词+向量#1' }]);
});

test('D3：空结果也要留一行（排查「她为什么没想起」全靠它）', () => {
  const r = recallRow('g1', '嗯', [], { shortPhrase: true });
  assert.equal(r.shown, 0);
  assert.deepEqual(r.items, []);
  assert.equal(r.shortPhrase, true);
});

test('去重：同一句内容被写成两条 id 时只留先到的（分高的在前）', async () => {
  const j = fakeJournal({
    q: [
      { id: 'a', score: 0.9, text: '同一句话' },
      { id: 'b', score: 0.8, text: '同一 句话' },
      { id: 'c', score: 0.7, text: '另一句' },
    ],
  });
  const r = await searchWithShortContext(j, 'q', { limit: 3 });

  assert.equal(r.hits.length, 2);
  assert.equal(r.hits[0].id, 'a');
  assert.equal(r.hits[1].id, 'c');
});

test('去重：空白差异算同一句，不同内容不能误合并', async () => {
  const j = fakeJournal({
    q: [
      { id: 'a', score: 0.9, text: '她 喜欢 猫' },
      { id: 'b', score: 0.8, text: '她喜欢猫' },
      { id: 'c', score: 0.7, text: '她喜欢狗' },
    ],
  });
  const r = await searchWithShortContext(j, 'q', { limit: 3 });

  assert.equal(r.hits.length, 2);
  assert.deepEqual(r.hits.map((h) => h.id), ['a', 'c']);
});

test('去重：重复项不能把结果挤到 limit 以下（检索层要多取候选）', async () => {
  const j = fakeJournal({
    q: [
      { id: 'a', score: 0.9, text: '同一句' },
      { id: 'b', score: 0.8, text: '同一句' },
      { id: 'c', score: 0.7, text: '第二句' },
      { id: 'd', score: 0.6, text: '第三句' },
      { id: 'e', score: 0.5, text: '第四句' },
    ],
  });
  const r = await searchWithShortContext(j, 'q', { limit: 3 });

  assert.equal(r.hits.length, 3);
  assert.deepEqual(r.hits.map((h) => h.id), ['a', 'c', 'd']);
});

test('去重：digest 行 text 是空串时按 digest 去重（用 ?? 会整类漏掉）', async () => {
  const j = fakeJournal({
    q: [
      { id: 'a', score: 0.9, text: '', digest: '同一段摘要' },
      { id: 'b', score: 0.8, text: '', digest: '同一段摘要' },
    ],
  });
  const r = await searchWithShortContext(j, 'q', { limit: 3 });

  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].id, 'a');
});

test('去重：主结果重复导致不足时仍触发短句补检索', async () => {
  const j = fakeJournal({
    '嗯': [
      { id: 'a', score: 0.9, text: '同一句' },
      { id: 'b', score: 0.8, text: '同一句' },
    ],
    '上一句 嗯': [
      { id: 'a', score: 0.9, text: '同一句' },
      { id: 'b', score: 0.8, text: '同一句' },
      { id: 'c', score: 0.7, text: '补充' },
    ],
  });
  const r = await searchWithShortContext(j, '嗯', { limit: 3 }, '上一句');

  assert.equal(r.usedPrev, true);
  assert.deepEqual(r.hits.map((h) => h.id), ['a', 'c']);
});
