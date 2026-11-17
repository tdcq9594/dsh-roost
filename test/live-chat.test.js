// 「每轮刷新挂到 agent 上的 chat」——修的是 PR #5 那个 bug：
// 群里换个人说话，`persona.bySender` 仍套第一个人的人格。
//
// 这段逻辑原来在 `mount()` 闭包里，假 ctx 到不了那一层，只有真机才验得出来。
// 抽成 `refreshLiveChat()` 就是为了在这里钉住三件事：值对齐、**形状也对齐**
// （新 chat 没有的键要删）、冻结场景只退化不抛。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refreshLiveChat } from '../src/live-chat.js';

const chat = (senderId, extra = {}) => ({
  kind: 'group',
  chatId: 'GROUP_OPENID',
  sessionKey: 'guild:763366431',
  senderId,
  name: '摸鱼群',
  ...extra,
});

test('刷新：换人说话后 senderId 跟着当轮走（本 bug 的正题）', () => {
  const first = chat('ALICE');
  assert.equal(refreshLiveChat(first, chat('BOB')), true);
  assert.equal(first.senderId, 'BOB', '首挂对象被原地更新，闭包读到的才是当轮的发送者');
  assert.equal(first.chatId, 'GROUP_OPENID', '会话 id 没变就别动');
});

test('刷新：kind / chatId 也跟着换（频道聚合成一个会话时 chatId 每轮不同）', () => {
  const first = chat('ALICE');
  refreshLiveChat(first, { ...chat('ALICE'), chatId: 'CHANNEL_B', kind: 'guild' });
  assert.equal(first.chatId, 'CHANNEL_B');
  assert.equal(first.kind, 'guild');
});

test('刷新：形状对齐——新 chat 没有的键要删掉，别把上一轮的发送者留给这一轮', () => {
  const first = chat('ALICE', { uin: '10001', aliases: ['OLD_OPENID'] });
  // 手写的 chat 字面量：主动搭话那种，只有 kind / chatId / sessionKey / name / preset
  refreshLiveChat(first, { kind: 'c2c', chatId: 'OWNER', sessionKey: 'OWNER', name: '主动搭话' });
  assert.equal(first.kind, 'c2c');
  assert.equal(first.chatId, 'OWNER');
  /**
   * 这一句是这次修的要点：`senderId` 删掉，`personaCfgFor(chat)` 才会回落到
   * 「按会话 / 全局」；留着就等于「按人指定的人格」也管到她自己主动开口那一轮。
   */
  assert.equal('senderId' in first, false, '没有真人说话的轮次就该没有 senderId');
  assert.equal(Object.hasOwn(first, 'uin'), false);
  assert.deepEqual(Object.keys(first).sort(), ['chatId', 'kind', 'name', 'sessionKey'].sort(), '形状应当等于 next');
});

test('刷新：形状对齐也要能往回长（字面量先挂、真实消息后到）', () => {
  const first = { kind: 'c2c', chatId: 'OWNER', sessionKey: 'OWNER', name: '主动搭话' };
  refreshLiveChat(first, chat('ALICE', { uin: '10001' }));
  assert.equal(first.senderId, 'ALICE');
  assert.equal(first.uin, '10001');
  assert.deepEqual(Object.keys(first).sort(), Object.keys(chat('ALICE', { uin: '10001' })).sort());
});

test('刷新：同一个对象、空值都不该抛，也不该被当成失败', () => {
  const same = chat('ALICE');
  assert.equal(refreshLiveChat(same, same), true, '同一对象等于已经是最新的');
  assert.equal(refreshLiveChat(same, null), true);
  assert.equal(refreshLiveChat(null, chat('BOB')), true);
  assert.equal(same.senderId, 'ALICE', '空 next 不该改动任何东西');
});

test('刷新：目标被冻结时返回 false，由调用方按旧值继续，不炸整轮', () => {
  const frozen = Object.freeze(chat('ALICE', { uin: '10001' }));
  // 这一轮既要删键（uin）又要覆盖值（senderId），两条路都被冻结挡住
  assert.equal(refreshLiveChat(frozen, { kind: 'c2c', chatId: 'GROUP_OPENID', sessionKey: 'guild:763366431', name: '主动搭话' }), false);
  assert.equal(frozen.senderId, 'ALICE');
  assert.equal(frozen.uin, '10001', '删键失败之后不该删掉一半');
});

test('刷新：只读属性也只退化、不抛', () => {
  const sealed = chat('ALICE');
  Object.defineProperty(sealed, 'senderId', { value: 'ALICE', writable: false, enumerable: true });
  assert.equal(refreshLiveChat(sealed, chat('BOB')), false);
  assert.equal(sealed.senderId, 'ALICE');
});
