// 引用正文长度（对照方案 D 批）：上限 2000、两处调用必须同口径。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUOTE_MAX_CHARS, clipQuote, renderInbound } from '../src/inbound.js';
import { buildRendered } from '../src/roost-payload.js';

test('Q1 上限是 2000', () => {
  assert.equal(QUOTE_MAX_CHARS, 2000);
});

test('Q2 短引用原样返回，不加省略号', () => {
  assert.equal(clipQuote('好呀，那我每次说话都带张图'), '好呀，那我每次说话都带张图');
});

test('Q3 正好 2000 字不截断', () => {
  const s = 'a'.repeat(2000);
  assert.equal(clipQuote(s), s);
  assert.equal(clipQuote(s).length, 2000);
});

test('Q4 超过 2000 字截断并加省略号', () => {
  const s = 'a'.repeat(2500);
  const out = clipQuote(s);
  assert.equal(out.length, 2001, '2000 字 + 省略号');
  assert.ok(out.endsWith('…'));
  assert.equal(out.slice(0, 2000), s.slice(0, 2000));
});

test('Q5 null / undefined / 非字符串不抛', () => {
  assert.equal(clipQuote(null), '');
  assert.equal(clipQuote(undefined), '');
  assert.equal(clipQuote(123), '123');
});

test('Q6 两条渲染路径的截图口径一致（都走 clipQuote）', () => {
  const long = '引'.repeat(2500);
  const viaFallback = renderInbound({ quoted: long, text: '在吗' });
  const viaRendered = buildRendered({ quoted: long }, '在吗');
  /** 两条路径都该把引用截到 2000 + 省略号 */
  for (const [name, out] of [
    ['renderInbound', viaFallback],
    ['buildRendered', viaRendered],
  ]) {
    assert.ok(out.includes('引用了这句'), `${name} 要带上引用`);
    assert.ok(out.includes('…'), `${name} 要带截断省略号`);
    assert.ok(!out.includes('引'.repeat(2001)), `${name} 不能超过 2000 字`);
  }
  assert.equal(viaFallback, viaRendered, '两条路径输出应完全一致');
});

test('Q7 500 字左右的长引用现在完整保留（老实现会截掉后半句）', () => {
  const s = `${'甲'.repeat(600)}`;
  assert.equal(clipQuote(s), s, '600 字不该再被截');
});
