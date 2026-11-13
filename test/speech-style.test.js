// 5.10 说话方式提炼：统计要对，措辞不能变成「请模仿口音」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeStyle, styleTextOf, styleMemoryEntry, MIN_SAMPLES, MIN_PARTICLE_COUNT,
} from '../src/speech-style.js';

/** 造 n 条「主人说的话」 */
const say = (arr) => arr.map((text) => ({ text, role: 'user', at: 1 }));

test('样本不够就明说，不硬凑结论', () => {
  const r = analyzeStyle(say(['在吗', '嗯']));
  assert.equal(r.ok, false);
  assert.equal(r.samples, 2);
  assert.match(r.reason, new RegExp(`至少要 ${MIN_SAMPLES} 条`));
  assert.equal(r.styleText, '');
});

test('只统计 role=user 的：她自己的回复不能学（否则自问自答）', () => {
  const rows = [
    ...say(Array.from({ length: 20 }, () => '好呀')),
    ...Array.from({ length: 20 }, () => ({ text: '好的主人我这就去办', role: 'assistant' })),
  ];
  const r = analyzeStyle(rows);
  assert.equal(r.ok, true);
  assert.equal(r.samples, 20, 'assistant 的行不该进样本');
  assert.equal(r.avgLen, 2);
});

test('按消息 id 去重：同一条重试入库只算一次，同一句话说十遍照算十次', () => {
  const dup = Array.from({ length: 30 }, (_, i) => ({ id: 'm1', text: '就是说嘛', role: 'user' }));
  const r1 = analyzeStyle(dup);
  assert.equal(r1.samples, 1, '同一个 msgId 只留一条');
  assert.equal(r1.ok, false, '去重后不足 20 条，就该报样本不够');

  /** 没 id 时不去重：「好呀」说十遍正是习惯信号，抹掉就没法统计了 */
  const same = Array.from({ length: 25 }, () => ({ text: '好呀', role: 'user' }));
  const r2 = analyzeStyle(same);
  assert.equal(r2.ok, true);
  assert.equal(r2.samples, 25);
});

test('平均句长与短句比例按字符算，emoji 不占两位', () => {
  const rows = say([
    ...Array.from({ length: 10 }, () => '好'),
    ...Array.from({ length: 10 }, () => '😀😀😀😀😀'),
  ]);
  const r = analyzeStyle(rows);
  assert.equal(r.ok, true);
  assert.equal(r.avgLen, 3, '「好」1 字 + 5 个 emoji 5 字，均值 3');
  assert.equal(r.shortRatio, 1, '两种都不超过 10 字');
});

test('口头禅要够次数才入选，低频偶发不算', () => {
  const rows = say([
    ...Array.from({ length: 8 }, () => '就是说嘛今天真热'),
    ...Array.from({ length: 8 }, () => '就是说嘛好累啊'),
    ...Array.from({ length: 6 }, () => '行吧行吧'),
    '绝绝子', // 只出现一次
  ]);
  const r = analyzeStyle(rows);
  assert.equal(r.ok, true);
  const words = r.particles.map((x) => x.w);
  assert.ok(words.some((w) => w.includes('就是说')), `该抓到「就是说」，实际：${words.join(',')}`);
  assert.equal(words.includes('绝绝子'), false, '只出现一次的不算口头禅');
  assert.ok(r.particles.every((x) => x.n >= MIN_PARTICLE_COUNT));
});

test('子串互相包含时只留长的，别在列表里复读', () => {
  const rows = say(Array.from({ length: 10 }, () => '就是说嘛，这也太离谱了'));
  const r = analyzeStyle(rows);
  const words = r.particles.map((x) => x.w);
  const overlapping = words.filter((a) => words.some((b) => b !== a && b.includes(a)));
  assert.deepEqual(overlapping, [], `不该有互相包含的条目：${words.join(',')}`);
});

test('停用词压得住：「我们」「这个」不算个人习惯', () => {
  const rows = say(Array.from({ length: 30 }, () => '我们这个真的可以'));
  const r = analyzeStyle(rows);
  const words = r.particles.map((x) => x.w);
  for (const stop of ['我们', '这个', '可以']) {
    assert.equal(words.includes(stop), false, `「${stop}」是语言本身，不是口头禅`);
  }
});

test('标点习惯：不加句号、爱用波浪号要分别统计', () => {
  const rows = say([
    ...Array.from({ length: 10 }, () => '好的呀~'),
    ...Array.from({ length: 10 }, () => '那就这样吧'),
  ]);
  const r = analyzeStyle(rows);
  assert.equal(r.punct.periodRatio, 0, '一条都没加句号');
  assert.equal(r.punct.tildeRatio, 0.5);
});

test('表情统计：只留前几个，按次数排', () => {
  const rows = say([
    ...Array.from({ length: 10 }, () => '笑死😂'),
    ...Array.from({ length: 5 }, () => '好😅'),
    ...Array.from({ length: 5 }, () => '行'),
  ]);
  const r = analyzeStyle(rows);
  assert.equal(r.emoji[0].e, '😂');
  assert.equal(r.emoji[0].n, 10);
});

test('styleText 是「他习惯…」的统计结论，不是「请模仿」', () => {
  const r = analyzeStyle(say([
    ...Array.from({ length: 15 }, () => '好呀~'),
    ...Array.from({ length: 10 }, () => '就是说嘛'),
  ]));
  assert.match(r.styleText, /说话方式（从 25 条私聊里统计）/);
  assert.match(r.styleText, /口头禅/);
  assert.match(r.styleText, /不要逐字照抄/);
  assert.equal(/请模仿|模仿以下|扮演/.test(r.styleText), false, '措辞不能诱导模型演口音');
});

test('styleTextOf：长句 / 加句号 / 感叹号 各自说得出来', () => {
  const t = styleTextOf({
    samples: 100, avgLen: 30, shortRatio: 0.1,
    particles: [], punct: { periodRatio: 0.9, exclaimRatio: 0.4, questionRatio: 0.35 }, emoji: [],
  });
  assert.match(t, /句子偏长，平均 30 字/);
  assert.match(t, /习惯给每句话加句号/);
  assert.match(t, /感叹号用得多/);
  assert.match(t, /爱反问/);
});

test('写进记忆的条目是 w=2 的手记，scope 跟着会话走', () => {
  const r = analyzeStyle(say(Array.from({ length: 20 }, () => '好呀')));
  const e = styleMemoryEntry(r, { at: 1234, chatId: 'u1' });
  assert.equal(e.w, 2, 'w=2 才不会被保留策略当低价值事实清掉');
  assert.equal(e.at, 1234);
  assert.equal(e.scope, 'chat:u1');
  assert.equal(e.src.speechStyle, true);
  assert.equal(e.src.manual, false, '不是手记，别冒充用户明说的');

  assert.equal(styleMemoryEntry({ ok: false }), null, '没算出来就什么都不写');
});

test('样本偏少时给警告，但仍然出结论', () => {
  const r = analyzeStyle(say(Array.from({ length: 21 }, () => '好呀')));
  assert.equal(r.ok, true);
  assert.match(r.warnings.join('；'), /样本只有 21 条/);
});
