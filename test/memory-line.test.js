import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryLine, memoryLines } from '../src/memory-line.js';

const row = (o = {}) => ({
  id: 'x1',
  at: Date.parse('2026-11-03T10:00:00'),
  chatId: 'g1',
  sender: '小明',
  role: 'user',
  kind: 'chat',
  digest: null,
  text: '主人说下周三前给答复',
  ...o,
});

test('D5：时间 / 出处 / 「当时：」三段都在，正文还在', () => {
  const s = memoryLine(row(), { bucket: 'owner', chatId: 'g1' });
  assert.match(s, /^· 2026-11-03 · 这个群 · 当时：/);
  assert.match(s, /主人说下周三前给答复$/);
});

test('D5：owner 档才带说话人，member 档不出现名字', () => {
  const owner = memoryLine(row(), { bucket: 'owner', chatId: 'g1' });
  assert.match(owner, /小明说：/);
  for (const b of ['member', 'social', 'admin', undefined]) {
    const s = memoryLine(row(), { bucket: b, chatId: 'g1' });
    assert.ok(!s.includes('小明'), `档位 ${String(b)} 漏了 sender：${s}`);
  }
  assert.ok(!memoryLine(row(), { chatId: 'g1' }).includes('小明'), '不传 bucket 默认最保守');
});

test('D5：跨群标「别处」，没有 chatId 标「通用」', () => {
  assert.match(memoryLine(row(), { chatId: 'g2' }), /· 别处 ·/);
  assert.match(memoryLine(row({ chatId: '' }), { chatId: 'g1' }), /· 通用 ·/);
});

test('D5：她说过的行标「你说过」，且不再带 sender', () => {
  const s = memoryLine(row({ role: 'bot' }), { bucket: 'owner', chatId: 'g1' });
  assert.match(s, /这个群·你说过 · 当时：/);
  assert.ok(!s.includes('小明'));
});

test('D5：摘要优先用 digest，超长按 60 字裁', () => {
  const s = memoryLine(row({ digest: '改口了' }), { chatId: 'g1' });
  assert.match(s, /当时：改口了$/);
  assert.ok(!s.includes('主人说下周三'));
  const long = memoryLine(row({ text: '啊'.repeat(100) }), { chatId: 'g1' });
  assert.equal([...long].length, '· 2026-11-03 · 这个群 · 当时：'.length + 60);
  assert.ok(long.endsWith('…'));
});

test('D5：坏输入不抛错，空行被 memoryLines 滤掉', () => {
  assert.equal(memoryLine(null), '');
  assert.equal(memoryLine({}), '');
  assert.equal(memoryLine(row({ at: NaN, chatId: 'g1' })).startsWith('· ·'), false, '没时间就不写空日期');
  assert.deepEqual(memoryLines([row(), null, { at: 1 }], { chatId: 'g1' }).length, 1);
  assert.deepEqual(memoryLines(null), []);
});
