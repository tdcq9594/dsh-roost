// 目的引擎素材接线：形状映射与归属标注。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPurposeMaterials } from '../src/purpose-collect.js';

const T = 1_700_000_000_000;

test('素材映射：主人私聊标 private:、bot 归 self、群友归 member', () => {
  const rows = [
    { id: 'a', at: T, chatId: 'owner-u', role: 'user', sender: '主人', text: '我明天要去医院复查' },
    { id: 'b', at: T + 1, chatId: 'owner-u', role: 'bot', text: '好的，记得带医保卡' },
    { id: 'c', at: T + 2, chatId: 'group-1', role: 'user', sender: '小离', text: '那个养鱼游戏怎么玩' },
  ];
  const out = collectPurposeMaterials({ journalRows: rows, ownerChatId: 'owner-u', now: T });
  assert.equal(out.length, 3);
  const owner = out.find((x) => x.id === 'a');
  assert.equal(owner.kind, 'owner');
  assert.equal(owner.who, '主人');
  assert.match(owner.meta.key, /^private:/, 'owner 分支硬要求 private: 前缀');
  assert.equal(out.find((x) => x.id === 'b').kind, 'self');
  assert.equal(out.find((x) => x.id === 'c').kind, 'member');
});

test('素材映射：短文本丢弃、同 id 去重、按时间倒序、限条数', () => {
  const rows = [
    { id: 'x', at: T, text: '嗯' }, // <2 字
    { id: 'y', at: T + 1, text: '第一条消息' },
    { id: 'y', at: T + 2, text: '重复 id' },
    { id: 'z', at: T + 3, text: '第三条消息' },
  ];
  const out = collectPurposeMaterials({ journalRows: rows, limit: 1, now: T });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'z', '按时间倒序取最新');
  const all = collectPurposeMaterials({ journalRows: rows, now: T });
  assert.equal(all.length, 2, '短文本与重复 id 都被丢掉');
});
