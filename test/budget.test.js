// 注入预算的测试
//
// 这段逻辑不报错、不抛异常，只会"悄悄多给一点"或"悄悄砍错一块"——
// 两种都得靠断言看。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitBudget, clipForBudget } from '../src/budget.js';

test('预算：装得下就全留，顺序不变', () => {
  const out = fitBudget(['甲', '乙', '丙'], 100);
  assert.equal(out, '甲\n\n乙\n\n丙');
});

test('预算：空块不占地方', () => {
  const out = fitBudget(['甲', '', null, undefined, '乙'], 100);
  assert.equal(out, '甲\n\n乙');
});

test('预算：超了先砍后面的，前面的整块留着', () => {
  const a = 'a'.repeat(50);
  const b = 'b'.repeat(50);
  const c = 'c'.repeat(50);
  const out = fitBudget([a, b, c], 120, '\n');
  assert.ok(out.startsWith(a), '第一块要完整');
  assert.ok(out.includes(b), '第二块也要完整');
  assert.ok(out.endsWith('…'), '第三块被截断，要留省略号');
  assert.ok(!out.includes(c), '第三块不能整块塞进去');
  assert.ok(out.length <= 120);
});

test('预算：截断处留一个省略号（模型得知道这里被截了）', () => {
  const out = fitBudget(['x'.repeat(100)], 40);
  assert.equal(out.length, 40);
  assert.ok(out.endsWith('…'));
});

test('预算：输出不会超过上限（连接符也算字）', () => {
  const secs = ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)];
  for (const sep of ['\n', '\n\n']) {
    for (const max of [100, 250, 500, 601]) {
      const out = fitBudget(secs, max, sep);
      assert.ok(out.length <= max, `max=${max} sep=${JSON.stringify(sep)} 实际 ${out.length}`);
    }
  }
});

test('预算：连接符换掉不改变块内容', () => {
  const out = fitBudget(['甲', '乙'], 100, '\n');
  assert.equal(out, '甲\n乙');
});

test('预算：上限为 0 或负数时什么都不给（不能吐半句）', () => {
  assert.equal(fitBudget(['甲'], 0), '');
  assert.equal(fitBudget(['甲'], -5), '');
});

// ---- 半代理对（aurabot #151：切开 emoji → 之后所有模型请求 400，她不再回话）----

test('预算：截断正落在 emoji 中间时，不能留下孤立代理字符', () => {
  const emoji = '😀'; // 占 2 个码元
  const text = 'a'.repeat(9) + emoji + 'b'.repeat(20);
  // max=11 → 截前 10 个码元，正好把 emoji 的高代理留下、低代理切掉
  const out = fitBudget([text], 11);
  assert.ok(out.isWellFormed(), '输出不能带孤立代理字符');
  assert.ok(out.endsWith('…'), '被截了要留省略号');
  assert.ok(out.length <= 11);
  assert.ok(!out.includes(emoji), '截断处那个 emoji 要么完整保留、要么整个丢掉');
});

test('预算：截断处 emoji 放得下就完整保留', () => {
  const emoji = '😀';
  const text = 'a'.repeat(9) + emoji + 'b'.repeat(20);
  const out = fitBudget([text], 12); // 截前 11 个码元 = 9 个 a + 完整 emoji
  assert.ok(out.includes(emoji), '完整的 emoji 别丢');
  assert.ok(out.isWellFormed());
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 12);
});

test('预算：装得下的 emoji 原样保留', () => {
  const text = '甲😀乙';
  assert.equal(fitBudget([text], 20), text);
});

test('预算：输入本身就带孤立代理字符也会清掉', () => {
  const bad = '甲\uD83D乙'; // 孤立高代理
  const out = fitBudget([bad], 20);
  assert.ok(out.isWellFormed());
  assert.equal(out, '甲乙');
});

test('预算：含 emoji 时输出仍不超过上限，且处处 well-formed', () => {
  const secs = ['甲😀'.repeat(40), '乙🎉'.repeat(40), '丙'.repeat(30)];
  for (const sep of ['\n', '\n\n']) {
    for (const max of [11, 12, 13, 20, 100, 250, 500]) {
      const out = fitBudget(secs, max, sep);
      assert.ok(out.length <= max, `max=${max} sep=${JSON.stringify(sep)} 实际 ${out.length}`);
      assert.ok(out.isWellFormed(), `max=${max} 出现孤立代理字符`);
    }
  }
});

test('clipForBudget：按码元截断、按码点让位，room 为 0 时给空', () => {
  assert.equal(clipForBudget('abc', 0), '');
  assert.equal(clipForBudget('abc', -1), '');
  assert.equal(clipForBudget('abc', 10), 'abc');
  assert.equal(clipForBudget('a😀b', 2), 'a'); // 第 2 个码元是高位代理 → 退一位
  assert.equal(clipForBudget('a😀b', 3), 'a😀');
});
