// 小黄脸：入站 `<faceType=…>` → `【表情: 名字】`，出站 `【表情: 名字】` → 删掉。
//
// **出站不发小黄脸**（2026-11-22 定）：`0x14 + id` 只有手机 QQ 认，PC 把它画成
// 豆腐块，markdown 通道两端都吞控制字符。既然不知道对方用什么设备看，发出去
// 就是"要么空气、要么乱码"，索性整个不做——但模型仍可能从旧历史/记忆里学到
// 这个语法，所以出站必须把标记清干净（不留文字、也不留控制字符）。
//
// 为什么要专门一个文件：这条链横跨三层（合并器 / 通道 / 码表），单测只测码表
// 会漏掉「接了但没生效」。所以最后一组走完整 `send()`，验的是 final content。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACE_IDS, FACE_NAMES, decodeFaceTags, stripFaceMarks,
} from '../src/face-table.js';
import { textOf } from '../src/roost-merge.js';
import { createRoostHostChannel } from '../src/channel.js';

/* ---------------- 码表 ---------------- */

test('码表：名字与 id 双向一致，没有重复 id', () => {
  const names = Object.keys(FACE_IDS);
  assert.ok(names.length >= 280, `条目太少（${names.length}），可能是提取时截断了`);
  assert.equal(Object.keys(FACE_NAMES).length, names.length, '反向表大小应与正向一致');
  for (const [name, id] of Object.entries(FACE_IDS)) {
    assert.equal(FACE_NAMES[id], name, `${name}(${id}) 反查不一致`);
  }
});

// 下面这些是从真实账本入站样本里反解出来的（`<faceId="187",ext="幽灵">` 一类），
// 是平台事实。**改码表前先看这里**：2026-11-22 之前老经典表情段整段用了
// 「面板顺序号」，102 条错位（惊讶写成 33、流汗写成 2），就是被这组样本抓出来的。
// 最后 4 条（481/489/496/498）NapCat 表里没有，是运行账本里真实抓到后补的。
test('码表：真实入站样本逐条对齐（平台事实，别再凭记忆改）', () => {
  const samples = [
    [0, '惊讶'], [3, '发呆'], [5, '流泪'], [27, '流汗'], [124, '好'],
    [178, '斜眼笑'], [182, '笑哭'], [187, '幽灵'], [262, '脑阔疼'],
    [264, '捂脸'], [265, '辣眼睛'], [272, '呵呵哒'], [298, '元宝'],
    [319, '比心'], [343, '我方了'], [344, '大怨种'], [427, '偷感'],
    [481, '学习'], [489, '知识增加'], [496, '阴晴圆缺'], [498, '中!'],
  ];
  for (const [id, name] of samples) {
    assert.equal(FACE_NAMES[id], name, `faceId=${id} 应为「${name}」`);
  }
});

/* ---------------- 入站 ---------------- */

test('入站：新格式带 ext，解不出文字就查表', () => {
  assert.equal(
    decodeFaceTags('哈哈<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'),
    '哈哈【表情: 惊讶】',
    'ext 是 {"text":""}，应退回码表',
  );
});

test('入站：老格式没有 ext 也要认', () => {
  assert.equal(decodeFaceTags('<faceType=1,faceId="14">'), '【表情: 微笑】');
});

test('入站：ext.text 优先于码表（官方改过 id 含义时以它为准）', () => {
  const ext = Buffer.from(JSON.stringify({ text: '坏笑' })).toString('base64');
  assert.equal(
    decodeFaceTags(`<faceType=6,faceId="0",ext="${ext}">`),
    '【表情: 坏笑】',
    'id=0 查表是「惊讶」，ext 说坏笑就该用坏笑',
  );
});

test('入站：属性顺序不同、未知 id 都不能漏', () => {
  assert.equal(decodeFaceTags('<faceId="14",faceType=1>'), '【表情: 微笑】', '顺序变了也要认');
  assert.equal(decodeFaceTags('<faceType=6,faceId="99999">'), '【表情】', '查不到给无名字，不留原文');
});

test('入站：一条消息多个表情逐个转', () => {
  assert.equal(
    decodeFaceTags('<faceType=1,faceId="0"><faceType=1,faceId="14">'),
    '【表情: 惊讶】【表情: 微笑】',
  );
});

test('入站：没有表情的正文一个字都不能动', () => {
  const s = '这 < 那，还有 [方括号] 和 <@某人>';
  assert.equal(decodeFaceTags(s), s);
});

/* ---------------- 出站：剥离标记 ---------------- */

test('出站：标记从正文里删掉，不留文字也不留控制字符', () => {
  const got = stripFaceMarks('笑死【表情: 呲牙】真的');
  assert.equal(got, '笑死真的');
  assert.ok(!got.includes('\u0014'), '0x14 在 PC 上是豆腐块，一个都不能留');
});

test('出站：名字不认识的标记一样删（模型可能自己编一个）', () => {
  assert.equal(stripFaceMarks('a【表情: 不存在的脸】b'), 'ab');
});

test('出站：全角冒号、多余空格也要认', () => {
  assert.equal(stripFaceMarks('嗯【表情：微笑】好'), '嗯好');
  assert.equal(stripFaceMarks('嗯【表情   :   微笑】好'), '嗯好');
});

test('出站：【表情】不带名字不删（那是入站查不到时的兜底，不是可执行标记）', () => {
  assert.equal(stripFaceMarks('嗯【表情】'), '嗯【表情】');
});

test('出站：截断把标记切成半截时，残片也要清掉', () => {
  assert.equal(stripFaceMarks('说话【表情: 呲'), '说话', '没有收尾】的半截标记');
});

test('出站：正文中间的正常文字不受影响', () => {
  const s = '她说"真【厉害】"，我【服了】';
  assert.equal(stripFaceMarks(s), s, '【…】不带「表情:」前缀就不该动');
});

test('出站：连续多个标记一起清', () => {
  assert.equal(stripFaceMarks('【表情: 微笑】【表情: 呲牙】'), '');
});

/* ---------------- 集成：入站 ---------------- */

test('合并器：纯表情消息不会变成空正文（否则模型收到空白）', () => {
  const evt = { content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">' };
  assert.equal(textOf(evt), '【表情: 惊讶】');
});

test('合并器：表情夹在文字里照常拼接', () => {
  assert.equal(textOf({ content: '早<faceType=1,faceId="14">' }), '早【表情: 微笑】');
});

/* ---------------- 集成：出站 ---------------- */

test('通道 send：正文里的标记被删干净，发出去的 content 里没有 0x14', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });

  const r = await ch.send({ target: 'u9', text: '好耶【表情: 呲牙】' });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], 'msg.send');
  assert.equal(calls[0][1].content, '好耶');
  assert.ok(!calls[0][1].content.includes('\u0014'));
});

test('通道 send：只剩标记时视为没有内容，不发一条空消息', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });

  const r = await ch.send({ target: 'u9', text: '【表情: 微笑】' });
  assert.equal(r.ok, false);
  assert.match(r.message, /没有内容可发/);
  assert.equal(calls.length, 0, '不该真的打 rpc');
});

test('通道 send：试运行不打 rpc', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({
    host, markdownEnabled: () => false, log: () => {}, dryRunOf: () => true,
  });
  const r = await ch.send({ target: 'u9', text: '嗯【表情: 微笑】' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(calls.length, 0);
});
