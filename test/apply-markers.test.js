// 标记**执行**的测试（阶段 8 拆出来的第一个域）。
//
// 以前这段是 host.js 里的内联函数，闭包引用 memory/journal/self/closing/mood，
// 想测就得把整个宿主拉起来 —— 于是它一直没测试。现在依赖从参数进来，
// 给几个假对象就能验证「标记真的产生了副作用」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMarkerApplier } from '../src/apply-markers.js';
import { W_EXPLICIT } from '../src/memory.js';

/** 造一套只会记账的假依赖 */
function rig() {
  const calls = [];
  const rec = (name) => (...args) => {
    calls.push([name, ...args]);
    return undefined;
  };
  const memory = {
    add: rec('memory.add'),
    remove: () => {
      calls.push(['memory.remove']);
      return 1;
    },
    supersede: (chatId, needle) => {
      calls.push(['memory.supersede', needle]);
      return { ok: true, text: needle, scope: 'global' };
    },
    setPersonaOverride: rec('memory.setPersonaOverride'),
    clearChat: rec('memory.clearChat'),
  };
  const journal = { forget: () => (calls.push(['journal.forget']), 2), clearChat: rec('journal.clearChat') };
  const self = { forget: () => (calls.push(['self.forget']), 1) };
  const closing = { set: () => (calls.push(['closing.set']), { ok: true }) };
  const mood = { set: (v) => calls.push(['mood.set', v]) };

  // log 是 logger 对象（host 里就是这么用的），不是函数
  const log = { debug: () => {}, info: () => {}, warn: () => {} };
  const apply = createMarkerApplier({ memory, journal, self, closing, mood, log });
  return { apply, calls, names: () => calls.map((c) => c[0]) };
}

test('remember：写进跨群层，用高权重', () => {
  const { apply, calls } = rig();
  const r = apply('好 <<remember: 主人花生过敏>>', 'g1');
  assert.equal(r.text, '好');
  const add = calls.find((c) => c[0] === 'memory.add');
  assert.deepEqual(add.slice(1, 4), ['g1', '主人花生过敏', 'global']);
  assert.equal(add[4].w, W_EXPLICIT, '明确要求记的要用高权重');
  assert.equal(r.touched, '记住了');
});

test('remember-here：只写本群', () => {
  const { apply, calls } = rig();
  apply('<<remember-here: 群梗>>', 'g1');
  const add = calls.find((c) => c[0] === 'memory.add');
  assert.equal(add[3], 'chat');
  assert.equal(add[2], '群梗');
});

test('replace：先定位旧说法，再记新的', () => {
  const { apply, calls } = rig();
  const r = apply('<<replace: 住在杭州 | 搬到上海>>', 'g1');
  assert.equal(calls.find((c) => c[0] === 'memory.supersede')[1], '住在杭州', '要拿旧说法去定位');
  const add = calls.find((c) => c[0] === 'memory.add');
  assert.equal(add[2], '搬到上海');
  assert.equal(r.text, '');
});

test('replace：格式不对时只提示，不写任何东西', () => {
  const { apply, calls } = rig();
  const r = apply('<<replace: 没有分隔符>>', 'g1');
  assert.equal(calls.length, 0, '格式错不该产生副作用');
  assert.match(r.touched, /旧说法 \| 新说法/);
  assert.equal(r.text, '');
});

test('forget：三层都要忘（facts / 日记 / 自述）', () => {
  const { apply, names, calls } = rig();
  const r = apply('<<forget: 花生>>', 'g1');
  assert.deepEqual(names(), ['memory.remove', 'journal.forget', 'self.forget']);
  assert.match(r.touched, /忘掉了 4 条/, '1+2+1');
  assert.ok(calls.length >= 3);
});

test('persona / clear / mood 各走各的', () => {
  const a = rig();
  a.apply('<<persona: 毒舌>>', 'g1');
  assert.ok(a.names().includes('memory.setPersonaOverride'));

  const b = rig();
  b.apply('<<clear>>', 'g1');
  assert.deepEqual(b.names(), ['memory.clearChat', 'memory.setPersonaOverride', 'journal.clearChat']);

  const c = rig();
  c.apply('<<mood: valence=-0.3, reason=被凶了>>', 'g1');
  const set = c.calls.find((x) => x[0] === 'mood.set');
  assert.equal(set[1].valence, -0.3);
  assert.equal(set[1].reason, '被凶了');
});

test('close：群聊不收尾，但标记照样摘掉', () => {
  const g = rig();
  const r = g.apply('<<close: 聊到这儿 | 明天接着>>', 'g1', '', 'group');
  assert.equal(g.names().includes('closing.set'), false, '群里没有"聊完"这回事');
  assert.equal(r.text, '');
});

test('没有标记时一个字都不动', () => {
  const { apply, calls } = rig();
  const text = '今天天气不错，1 < 2 且 3 > 2';
  const r = apply(text, 'g1');
  assert.equal(r.text, text);
  assert.equal(calls.length, 0);
  assert.equal(r.touched, '');
});

test('未知标记要摘掉，不能漏给用户', () => {
  const { apply } = rig();
  assert.equal(apply('前 <<unknown: x>> 后', 'g1').text, '前  后');
});
