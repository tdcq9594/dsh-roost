// 换人格提示：每个会话各提示一次，且只提示一次。
//
// 关键回归：原来用**全局单变量** lastHit 记「这一轮注入过没有」。
// 两个会话交错时，A 的轮末会把 B 的记录抹掉，于是两边 5 分钟内每轮都重复提示——
// 用户看到的是模型每隔一句就回「好的我换了」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSwitchNote } from '../src/switch-note.js';

test('换人格提示：同一会话只出现一轮', () => {
  const n = createSwitchNote();
  n.set('毒舌群友');
  assert.match(n.text('A'), /毒舌群友/);
  n.consume('A');
  assert.equal(n.text('A'), '');
});

test('换人格提示：两个会话交错时各拿一次，第二轮都不再出现', () => {
  const n = createSwitchNote();
  n.set('毒舌群友');

  assert.ok(n.text('A'), 'A 首轮要有');
  assert.ok(n.text('B'), 'B 首轮要有');
  n.consume('A');
  n.consume('B');

  assert.equal(n.text('A'), '', 'A 第二轮不该再有（旧实现这里会重复）');
  assert.equal(n.text('B'), '', 'B 第二轮不该再有');
});

test('换人格提示：没注入过就不算消费，下一轮还能补上', () => {
  const n = createSwitchNote();
  n.set('古风书生');
  // 被 keywordNote 抢先：这一轮没取，直接轮末
  n.consume('A');
  assert.ok(n.text('A'), '没注入过就不该被标记为已提示');
});

test('换人格提示：超过 TTL 自动失效', () => {
  let t = 1_000_000;
  const n = createSwitchNote({ ttlMs: 1000, now: () => t });
  n.set('极简');
  assert.ok(n.text('A'));
  t += 1001;
  assert.equal(n.text('A'), '', '过期后整条提示作废');
  assert.equal(n.peek(), null, '过期要真的清掉，不能只是返回空串');

  // 过期后再换一次人格，应该照常工作
  n.set('古风书生');
  assert.match(n.text('A'), /古风书生/);
});

test('换人格提示：再换一次会覆盖旧的已提示记录', () => {
  const n = createSwitchNote();
  n.set('第一个');
  assert.ok(n.text('A'));
  n.consume('A');
  n.set('第二个');
  assert.match(n.text('A'), /第二个/, '换了新的人格要重新提示');
});

test('换人格提示：空 label 不产生提示', () => {
  const n = createSwitchNote();
  n.set('');
  assert.equal(n.text('A'), '');
  assert.equal(n.peek(), null);
});
