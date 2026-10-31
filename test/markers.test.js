// 动作标记的语法层测试。
//
// 这一层错了不会报错，只会「群里多出一行 <<remember：...>>」——
// 用户会以为机器人坏了，而开发这边什么日志都没有。
// 2026-10-31 实测：全角冒号、缺闭合两种写法都会原样漏出，所以逐格钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { markerRe, stripUnclosed, stripUnknown, VALUE_MARKERS } from '../src/markers.js';

/** 复刻 host.js 里的执行顺序：先摘已知标记，再兜底，最后清未闭合 */
function pipeline(text) {
  let out = String(text ?? '');
  for (const name of VALUE_MARKERS) out = out.replace(markerRe(name), '');
  out = stripUnknown(out);
  out = stripUnclosed(out);
  return out.trim();
}

test('标记：半角冒号能匹配', () => {
  const m = [...'<<remember: 花生过敏>>'.matchAll(markerRe('remember'))];
  assert.equal(m.length, 1);
  assert.equal(m[0][1].trim(), '花生过敏');
});

test('标记：全角冒号也要认（中文输入法很容易打出来）', () => {
  const m = [...'<<remember：花生过敏>>'.matchAll(markerRe('remember'))];
  assert.equal(m.length, 1);
  assert.equal(m[0][1].trim(), '花生过敏');
});

test('标记：大小写不敏感', () => {
  const m = [...'<<REMEMBER: x>>'.matchAll(markerRe('remember'))];
  assert.equal(m.length, 1);
});

test('标记：值可以跨行', () => {
  const m = [...'<<remember: 第一行\n第二行>>'.matchAll(markerRe('remember'))];
  assert.equal(m.length, 1);
  assert.match(m[0][1], /第二行/);
});

test('标记：remember 不会误吃 remember-here', () => {
  const text = '<<remember-here: 群内梗>>';
  assert.equal(text.replace(markerRe('remember'), ''), text, 'remember 的正则不该命中 -here');
  assert.equal(text.replace(markerRe('remember-here'), ''), '');
});

test('未闭合：截断的标记吞到行尾，不留给用户', () => {
  assert.equal(stripUnclosed('<<remember: 花生过敏'), '');
  assert.equal(stripUnclosed('<<remember：花生过敏'), '');
  assert.equal(stripUnclosed('前面的话 <<remember: 后面没了'), '前面的话 ');
});

test('未闭合：不碰下游负责的标记和正文里的尖括号', () => {
  assert.equal(stripUnclosed('<<image: a.png'), '<<image: a.png', 'image 归 ai-chat 处理');
  assert.equal(stripUnclosed('1 < 2 且 3 > 2'), '1 < 2 且 3 > 2');
});

test('兜底：未知标记摘掉，下游标记原样保留', () => {
  assert.equal(stripUnknown('<<unknown: x>>'), '');
  assert.equal(stripUnknown('<<unknown：x>>'), '', '全角冒号也要摘');
  for (const keep of ['image', 'voice', 'button', 'say', 'silence']) {
    const s = `<<${keep}: v>>`;
    assert.equal(stripUnknown(s), s, `${keep} 必须留给 ai-chat`);
  }
});

test('整条链路：三种已知漏法都不再漏', () => {
  assert.equal(pipeline('<<remember：花生过敏>>'), '');
  assert.equal(pipeline('<<remember: 花生过敏'), '');
  assert.equal(pipeline('好的，我记住了 <<remember: 花生过敏>> 下次注意'), '好的，我记住了  下次注意');
});

test('整条链路：正常正文一个字都不能少', () => {
  const say = '她今天说 << 这个符号 >> 用来表示强调，不是标记。';
  assert.equal(pipeline(say), say);
});
