// 注入预算的测试
//
// 这段逻辑不报错、不抛异常，只会"悄悄多给一点"或"悄悄砍错一块"——
// 两种都得靠断言看。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitBudget } from '../src/budget.js';

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
