// 入站整形：发送者标签（`[昵称 (openid)] `）。
//
// 这个标签存在的唯一理由是**让模型能 @ 人**——官方群聊 @ 只认
// `<qqbot-at-user id="member_openid" />`，没有 openid 就永远 @ 不到。
// 所以断言盯两件事：该有的时候必须有，不该有的时候绝不能有
// （私聊多一段 id 是白烧 token，昵称里混进 `]` 会把标签结构搞坏）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  speakerTag, chatOf, normalizeKind, isPrivateKind, sceneOfKind, presetOfKind,
} from '../src/inbound.js';

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

/**
 * 多人批次不套外层标签。
 *
 * 那种正文长这样（ai-chat 拼的）：
 *   小明(A1B2…)：在吗
 *   小红(ZZ99…)：问你个事
 * 外面再套一个 `[小红 (ZZ99…)]` 就等于说整段都是小红说的。
 */
test('标签：多人批次不套外层标签（每条已自带 id）', () => {
  const payload = {
    sender: { id: OPENID, name: '小红' },
    batch: { multi: true, count: 2 },
  };
  assert.equal(speakerTag(payload, { kind: 'group' }), '');
});

/* ---------------- QQ 频道四态（2026-11-15） ---------------- */

test('四态映射：guild 归多人、dm 归一对一，人设不串场', () => {
  assert.equal(normalizeKind('guild'), 'guild');
  assert.equal(normalizeKind('dm'), 'dm');
  assert.equal(sceneOfKind('guild'), 'group');
  assert.equal(presetOfKind('guild'), 'roost-social');
  assert.equal(sceneOfKind('dm'), 'c2c');
  assert.equal(presetOfKind('dm'), 'roost-private');
  assert.equal(isPrivateKind('dm'), true);
  assert.equal(isPrivateKind('guild'), false);
  /** 未知值仍按群聊兜底，老事件不受影响 */
  assert.equal(normalizeKind(undefined), 'group');
  assert.equal(normalizeKind('group'), 'group');
  assert.equal(normalizeKind('c2c'), 'c2c');
});

test('chatOf：子频道事件带频道维度，私信会话的 group 不当频道 ID', () => {
  const g = chatOf({
    chat: { chatId: 'CH1', kind: 'guild', groupId: 'CH1', guildId: 'G1', channelId: 'CH1' },
  });
  assert.equal(g.kind, 'guild');
  assert.equal(g.scene, 'group');
  assert.equal(g.guildId, 'G1');
  assert.equal(g.channelId, 'CH1');
  assert.equal(g.preset, 'roost-social');

  const d = chatOf({
    chat: { chatId: 'DM9', kind: 'dm', groupId: 'DM9', channelId: 'CH9' },
  });
  assert.equal(d.kind, 'dm');
  assert.equal(d.scene, 'c2c');
  assert.equal(d.preset, 'roost-private');
  assert.equal(d.guildId, '', 'dm 的 group 是私信会话 id，不是真正的频道 ID');
  assert.equal(d.channelId, 'CH9');
});

test('说话人标签：子频道要给 openid，频道私信不给', () => {
  const payload = { sender: { id: OPENID, name: '小明' } };
  /** 频道要多带一层子频道标识（同一 guild 共用一个会话，AI 得能分辨版块） */
  assert.ok(speakerTag(payload, { kind: 'guild', channelId: 'CH1' }).startsWith('[子频道 CH1] [小明 '));
  assert.equal(speakerTag(payload, { kind: 'dm' }), '');
  /** 没 openid / 多人批次也别把子频道标识丢了 */
  assert.equal(speakerTag({ sender: {} }, { kind: 'guild', channelId: 'CH1' }), '[子频道 CH1] ');
  assert.equal(speakerTag({ batch: { multi: true }, sender: {} }, { kind: 'guild', channelId: 'CH1' }), '[子频道 CH1] ');
});

/* ---------------- 会话归属：一个频道一个会话 ---------------- */

test('sessionKey：同频道不同子频道共用一个会话，群聊/单聊保持原键', () => {
  const base = (chatId, channelId, kind = 'guild', guildId = 'G1') => chatOf({
    chat: { chatId, channelId, kind, guildId, groupId: chatId },
  });
  assert.equal(base('CH1', 'CH1').sessionKey, 'guild:G1');
  assert.equal(base('CH2', 'CH2').sessionKey, 'guild:G1', '同频道不同子频道要合并');
  assert.equal(base('CH1', 'CH1', 'guild', 'G2').sessionKey, 'guild:G2', '不同频道要分开');
  assert.equal(chatOf({ chat: { chatId: 'G1', kind: 'group' } }).sessionKey, 'G1', '老群聊会话一条不丢');
  assert.equal(chatOf({ chat: { chatId: 'U1', kind: 'c2c' } }).sessionKey, 'U1', '老单聊会话一条不丢');
  assert.equal(chatOf({ chat: { chatId: 'DM9', kind: 'dm' } }).sessionKey, 'dm:DM9', '频道私信独立');
  /** 出站 target 绝不能被改 */
  assert.equal(base('CH1', 'CH1').chatId, 'CH1');
  assert.equal(base('CH2', 'CH2').channelId, 'CH2');
});

test('标签：单条批次仍然要标签（batch 存在但 multi 是假）', () => {
  const payload = {
    sender: { id: OPENID, name: '小明' },
    batch: { multi: false, count: 1 },
  };
  assert.equal(speakerTag(payload, { kind: 'group' }), `[小明 (${OPENID})] `);
});

/* ---------------- 身份：QQ号 / 群号 ---------------- */

/**
 * 绑过号码之后，标签里**号码排在 openid 前面**。
 *
 * openid 是每个 AppID 一套的，换机器人就全变；号码不会。
 * openid 仍然要留着——官方 @ 人只认它。
 */
test('标签：有 QQ号 时写成「昵称 (QQ 号码 / openid)」', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小明', uin: '10001' } }, { kind: 'group' });
  assert.equal(tag, `[小明 (QQ 10001 / ${OPENID})] `);
});

test('标签：号码里混进非数字要清掉（不能拼出坏标签）', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小明', uin: '10 00-1]' } }, { kind: 'group' });
  assert.equal(tag, `[小明 (QQ 10001 / ${OPENID})] `);
});

test('标签：号码清空了就退回纯 openid（不留 `QQ / id` 这种半截）', () => {
  const tag = speakerTag({ sender: { id: OPENID, name: '小明', uin: 'abc' } }, { kind: 'group' });
  assert.equal(tag, `[小明 (${OPENID})] `);
});

test('chatOf：没绑定时不产生任何多余字段值（老行为逐字不变）', () => {
  const c = chatOf({ chat: { kind: 'group', chatId: OPENID, groupId: 'G', name: '摸鱼群' } });
  assert.equal(c.uin, '');
  assert.equal(c.groupUin, '');
  assert.equal(c.identityId, '');
  assert.deepEqual(c.aliases, []);
  // 老字段一个都不能动
  assert.equal(c.kind, 'group');
  assert.equal(c.chatId, OPENID);
  assert.equal(c.groupId, 'G');
  assert.equal(c.name, '摸鱼群');
  assert.equal(c.preset, 'roost-social');
});

test('chatOf：带号码、别名、稳定 id', () => {
  const c = chatOf({
    chat: {
      kind: 'group',
      chatId: OPENID,
      uin: '10001',
      groupUin: '763366431',
      aliases: ['763366431', 'OLDOPENIDOLDOPENIDOLDOPENIDOLD12'],
    },
  });
  assert.equal(c.uin, '10001');
  assert.equal(c.groupUin, '763366431');
  // 群会话的稳定 id 用群号，不是说话人的号码
  assert.equal(c.identityId, 'g:763366431');
  assert.deepEqual(c.aliases, ['763366431', 'OLDOPENIDOLDOPENIDOLDOPENIDOLD12']);
});

test('chatOf：私聊的稳定 id 用对方 QQ号', () => {
  const c = chatOf({ chat: { kind: 'c2c', chatId: OPENID, uin: '10001' } });
  assert.equal(c.identityId, 'u:10001');
  assert.equal(c.preset, 'roost-private');
});

test('chatOf：别名里排除当前 chatId（重复读一遍没意义）', () => {
  const c = chatOf({ chat: { kind: 'group', chatId: OPENID, aliases: [OPENID, '763366431'] } });
  assert.deepEqual(c.aliases, ['763366431']);
});

test('chatOf：别名里的空串 / 空白要丢掉', () => {
  const c = chatOf({ chat: { kind: 'group', chatId: OPENID, aliases: ['', '  ', null, '763366431'] } });
  assert.deepEqual(c.aliases, ['763366431']);
});

test('chatOf：aliases 不是数组时当空（老宿主可能传字符串）', () => {
  assert.deepEqual(chatOf({ chat: { kind: 'group', chatId: OPENID, aliases: '763366431' } }).aliases, []);
  assert.deepEqual(chatOf({}).aliases, []);
});

test('chatOf：号码只认数字（防脏数据混进键）', () => {
  const c = chatOf({ chat: { kind: 'group', chatId: OPENID, groupUin: ' 76-33 66431 ' } });
  assert.equal(c.groupUin, '763366431');
  assert.equal(c.identityId, 'g:763366431');
});
