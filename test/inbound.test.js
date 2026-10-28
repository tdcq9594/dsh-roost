// 入站整形：发送者标签（`[昵称 (openid)] `）。
//
// 这个标签存在的唯一理由是**让模型能 @ 人**——官方群聊 @ 只认
// `<qqbot-at-user id="member_openid" />`，没有 openid 就永远 @ 不到。
// 所以断言盯两件事：该有的时候必须有，不该有的时候绝不能有
// （私聊多一段 id 是白烧 token，昵称里混进 `]` 会把标签结构搞坏）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { speakerTag } from '../src/inbound.js';

const OPENID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

test('标签：群聊带上昵称和 openid', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小明' } }, { kind: 'group' });
  assert.equal(tag, `[小明 (${OPENID})] `);
});

test('标签：私聊不给（只有一个人，给了也没用）', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小明' } }, { kind: 'c2c' });
  assert.equal(tag, '');
});

test('标签：没 openid 就不加（半截标签比没有更糟）', () => {
  const tag = speakerTag({ sender: { name: '小明' } }, { kind: 'group' });
  assert.equal(tag, '');
});

test('标签：昵称里带括号会破坏结构，必须清洗', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小]明(测试)' } }, { kind: 'group' });
  assert.equal(tag, `[小 明 测试 (${OPENID})] `);
  assert.ok(!tag.slice(0, tag.indexOf(' (')).includes(']'), '昵称里不该残留 ]');
});

test('标签：没昵称时用 openid 前 6 位当名字', () => {
  const tag = speakerTag({ sender: { id: OPENID } }, { kind: 'group' });
  assert.equal(tag, `[A1B2C3 (${OPENID})] `);
});

test('标签：昵称过长截断（不占满上下文）', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '一'.repeat(60) } }, { kind: 'group' });
  assert.equal(tag, `[${'一'.repeat(24)} (${OPENID})] `);
});

test('标签：chat 缺省时按群聊处理（宁可多给）', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小明' } }, undefined);
  assert.ok(tag.startsWith('[小明 '));
});

test('标签：昵称里的换行会被压掉（否则一条消息被劈成两行）', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小\n明' } }, { kind: 'group' });
  assert.ok(!tag.includes('\n'), '标签里不能有换行');
});
