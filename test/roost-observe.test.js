// 只旁听：evt → journalAdd 的字段整形。
// 这里最容易犯的错是把 evt.sender.openid 写成 payload.sender.openid；
// journal 只认 sender.id，写错会变成「每句话都没有发送者」。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { observeFieldsOf } from '../src/roost-observe.js';

test('旁听字段：evt 的 openid / msgId / eventId 映射到 journalAdd 需要的形状', () => {
  const f = observeFieldsOf({
    chat: { chatId: 'G_1', groupAliases: ['G_OLD'] },
    sender: { openid: 'U_1', name: '群友', uin: '10001' },
    content: '你们在聊什么',
    msgId: 'M_1',
    eventId: 'E_1',
  });
  assert.equal(f.chat.chatId, 'G_1');
  assert.equal(f.chat.kind, 'group');
  assert.deepEqual(f.chat.aliases, ['G_OLD']);
  assert.equal(f.payload.id, 'M_1');
  assert.deepEqual(f.payload.eventIds, ['E_1']);
  assert.equal(f.payload.sender.id, 'U_1');
  assert.equal(f.payload.sender.name, '群友');
  assert.equal(f.payload.sender.uin, '10001');
  assert.equal(f.text, '你们在聊什么');
});

test('旁听字段：没有 chatId / 空文字时返回 null，不写空日记', () => {
  assert.equal(observeFieldsOf({ chat: {}, content: 'hi' }), null);
  assert.equal(observeFieldsOf({ chat: { chatId: 'G' }, content: '   ' }), null);
  assert.equal(observeFieldsOf(null), null);
});

test('旁听字段：纯语音没有正文时用附件转写，别当成空消息漏记', () => {
  /**
   * 判定侧用 `saidOf`（正文或 asrText），旁听侧以前只读 `content`：
   * 同一条语音，判定认为有内容，日记却写空被丢掉。两边必须同一份。
   */
  const f = observeFieldsOf({
    chat: { chatId: 'G' },
    sender: { openid: 'U' },
    content: '',
    attachments: [{ type: 'audio', asrText: '  今晚吃什么  ' }],
    msgId: 'M_VOICE',
  });
  assert.equal(f.text, '今晚吃什么');
});

test('旁听字段：eventId 缺失时降级用 msgId，eventIds 为空数组', () => {
  const f = observeFieldsOf({
    chat: { chatId: 'G' },
    sender: { openid: 'U' },
    content: '一条消息',
    msgId: 'M_ONLY',
  });
  assert.equal(f.payload.id, 'M_ONLY');
  assert.deepEqual(f.payload.eventIds, []);
});
