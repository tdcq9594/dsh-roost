// 写日记的测试（阶段 8 拆出来的第二个域）。
//
// 以前这块也没测过。它的错法很安静：日记写进去了但出处丢了、
// 或者关掉记忆的群还在照记——面板上看不出来，只有事后查不到原文时才发现。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJournalBridge } from '../src/journal-bridge.js';

function rig({ off = false, throwOnAdd = false } = {}) {
  const added = [];
  const warns = [];
  const journal = {
    add: (row) => {
      if (throwOnAdd) throw new Error('磁盘满了');
      added.push(row);
      return { added: true };
    },
  };
  const log = { debug() {}, info() {}, warn: (m) => warns.push(m) };
  const bridge = createJournalBridge({ journal, memoryOff: () => off, log });
  return { bridge, added, warns };
}

test('正常写一条：id 带角色后缀，出处在 evidence 里', () => {
  const { bridge, added } = rig();
  bridge.add(
    { id: 'msg-1', sender: { name: '小明' }, eventIds: ['ev-1'] },
    { chatId: 'g1' },
    '在吗',
    'user',
  );
  assert.equal(added.length, 1);
  const row = added[0];
  assert.equal(row.id, 'msg-1');
  assert.equal(row.chatId, 'g1');
  assert.equal(row.role, 'user');
  assert.equal(row.sender, '小明');
  assert.deepEqual(row.eventIds, ['ev-1']);
  assert.equal(row.evidence.length, 1);
  assert.equal(row.evidence[0].eventId, 'ev-1');
  assert.equal(row.evidence[0].sender, '小明');
});

test('机器人自己的回复：id 加 :bot 后缀，sender 留空', () => {
  const { bridge, added } = rig();
  bridge.add({ id: 'msg-1', eventIds: ['ev-1'] }, { chatId: 'g1' }, '好呀', 'bot');
  assert.equal(added[0].id, 'msg-1:bot');
  assert.equal(added[0].sender, '');
  assert.equal(added[0].evidence[0].sender, 'bot');
});

test('没有 msg_id：id 给空串，让 journal 自己生成（宁可重复也不丢）', () => {
  const { bridge, added } = rig();
  bridge.add({ eventIds: [] }, { chatId: 'g1' }, 'hi', 'user');
  assert.equal(added[0].id, '');
  assert.deepEqual(added[0].eventIds, []);
  assert.deepEqual(added[0].evidence, [], '没有出处就不编一个');
});

test('一个批次多条事件：eventIds 全留，快照只取最后一条', () => {
  const { bridge, added } = rig();
  bridge.add(
    { id: 'm', eventIds: ['ev-1', 'ev-2', 'ev-3'], sender: { name: '甲' } },
    { chatId: 'g1' },
    '一句话',
    'user',
  );
  assert.deepEqual(added[0].eventIds, ['ev-1', 'ev-2', 'ev-3']);
  assert.equal(added[0].evidence.length, 1);
  assert.equal(added[0].evidence[0].eventId, 'ev-3');
});

test('快照里的原文截到 200 字', () => {
  const { bridge, added } = rig();
  bridge.add({ id: 'm', eventIds: ['ev-1'] }, { chatId: 'g1' }, 'x'.repeat(500), 'user');
  assert.equal(added[0].evidence[0].excerpt.length, 200);
});

test('关掉记忆的会话：一个字都不写', () => {
  const { bridge, added } = rig({ off: true });
  bridge.add({ id: 'm', eventIds: [] }, { chatId: 'g1' }, 'hi', 'user');
  assert.equal(added.length, 0);
});

test('journal 抛错不炸这一轮，但要留一条 warn', () => {
  const { bridge, warns } = rig({ throwOnAdd: true });
  assert.doesNotThrow(() => bridge.add({ id: 'm' }, { chatId: 'g1' }, 'hi', 'user'));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /日记没写进去/);
});
