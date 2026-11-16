// 「搜聊天记录」的权限收窄（纯函数）。
//
// 这类判断写错**不会报错**，只会静默多给一点——所以每个档位都要钉死：
//   · 主人 / 管理员 → 能看别人的消息；
//   · 其他人 → 只能看自己的，但**允许跨会话**（主人 2026-11-16 定）；
//   · 拿不到身份 → `selfOpenid` 为空，调用方必须拒绝（不能退化成「搜全部」）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchScopeOf, SEARCH_PRIVILEGED } from '../src/search-scope.js';

test('档位表：只有 owner / admin 能看别人的消息', () => {
  assert.deepEqual(SEARCH_PRIVILEGED, ['owner', 'admin']);
});

test('主人：可以看别人的消息，不做 openid 收窄', () => {
  const sc = searchScopeOf({ bucket: 'owner', senderId: 'ME' });
  assert.equal(sc.privileged, true);
  assert.equal(sc.selfOpenid, '', '特权档不收窄');
  assert.equal(sc.ignorePerson, false, '主人能按昵称查别人');
});

test('管理员：同主人', () => {
  const sc = searchScopeOf({ bucket: 'admin', senderId: 'ME' });
  assert.equal(sc.privileged, true);
  assert.equal(sc.selfOpenid, '');
});

test('普通成员：只能看自己的，person 被忽略', () => {
  const sc = searchScopeOf({ bucket: 'member', senderId: 'ME' });
  assert.equal(sc.privileged, false);
  assert.equal(sc.selfOpenid, 'ME');
  assert.equal(sc.ignorePerson, true);
});

test('未知身份（陌生人）：同样只给「自己的」（虽然通常没有 ID）', () => {
  const sc = searchScopeOf({ bucket: 'unknown', senderId: 'X1' });
  assert.equal(sc.privileged, false);
  assert.equal(sc.selfOpenid, 'X1');
});

test('跨会话：不再有 lockChatId —— 会话不受限，受限的是「谁的消息」', () => {
  const sc = searchScopeOf({ bucket: 'member', senderId: 'ME', chatId: 'G1' });
  assert.equal('lockChatId' in sc, false);
});

test('拿不到身份：selfOpenid 为空，调用方必须拒', () => {
  assert.equal(searchScopeOf({ bucket: 'member' }).selfOpenid, '');
  assert.equal(searchScopeOf({}).privileged, false);
  assert.equal(searchScopeOf({}).selfOpenid, '');
});

test('openid 兜底：只有 openid 没有 senderId 时也用得上', () => {
  assert.equal(searchScopeOf({ bucket: 'member', openid: 'O1' }).selfOpenid, 'O1');
});
