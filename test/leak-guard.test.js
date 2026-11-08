/**
 * 出站防复读（leak-guard 低配版）。
 *
 * 锁四件事：整段复述要删、正常回复不能误删、短句不参与、部分重合不误伤。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeForGuard, shingles, stripLeak } from '../src/leak-guard.js';

const BLOCK = '主人住在杭州，喜欢下雨天在家写代码，讨厌被打扰';

test('归一化：空白 / 标点 / 零宽 / Markdown 都剥掉', () => {
  const a = normalizeForGuard('主人 住在**杭州**，\u200b喜欢');
  const b = normalizeForGuard('主人住在杭州喜欢');
  assert.equal(a, b);
  assert.equal(normalizeForGuard('`代码` 和 ```块```'), '和');
});

test('指纹：短于 20 字没有 shingle，长文本有', () => {
  assert.equal(shingles('短句').size, 0);
  assert.ok(shingles(BLOCK).size > 0);
});

test('整段复述注入块：整句删掉', () => {
  const out = `你的设定是：${BLOCK}。`;
  const r = stripLeak(out, [BLOCK]);
  assert.equal(r.removed, 1, JSON.stringify(r));
  assert.equal(r.text, '');
});

test('正常回复：一个字都不删', () => {
  const out = '今天杭州下雨了，你带伞了吗？';
  const r = stripLeak(out, [BLOCK]);
  assert.equal(r.removed, 0);
  assert.equal(r.text, out);
});

test('短句（<20 字）不参与比对，不会误删', () => {
  const r = stripLeak('好的。', [BLOCK]);
  assert.equal(r.removed, 0);
  assert.equal(r.text, '好的。');
});

test('部分重合但不到 60%：保留', () => {
  /** 只有开头一小段重合，后面是别的内容 */
  const out = '主人住在杭州这件事我记着呢，不过今天想聊点别的，你最近在忙什么呀？';
  const r = stripLeak(out, [BLOCK]);
  assert.equal(r.removed, 0, JSON.stringify(r));
});

test('多句里只删命中的那句，其余保留', () => {
  const out = `好的呀。${BLOCK}。那今天想聊什么？`;
  const r = stripLeak(out, [BLOCK]);
  assert.equal(r.removed, 1);
  assert.ok(r.text.includes('好的呀'));
  assert.ok(r.text.includes('那今天想聊什么'));
  assert.ok(!r.text.includes('讨厌被打扰'));
});

test('没有注入块 / 空文本：原样返回', () => {
  assert.deepEqual(stripLeak('随便说说', []), { text: '随便说说', removed: 0 });
  assert.deepEqual(stripLeak('', [BLOCK]), { text: '', removed: 0 });
});
