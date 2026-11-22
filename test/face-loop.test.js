// 表情双向闭环：入站 `<faceType=…>` → `【表情: 名字】`，出站 `【表情: 名字】` → `0x14` + id。
//
// 为什么要专门一个文件：这条链横跨三层（合并器 / 通道 / 码表），
// 单测只测码表会漏掉「接了但没生效」。所以最后一组走完整 `send()`，
// 验的是「真的把控制字符拼进了 content」，而不是「函数返回值对」。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FACE_IDS, FACE_NAMES, FACE_PREFIX, decodeFaceTags, encodeFaceTags,
} from '../src/face-table.js';
import { textOf } from '../src/roost-merge.js';
import { createRoostHostChannel } from '../src/channel.js';

/* ---------------- 码表 ---------------- */

test('码表：名字与 id 双向一致，没有重复 id', () => {
  const names = Object.keys(FACE_IDS);
  assert.ok(names.length >= 180, `条目太少（${names.length}），可能是提取时截断了`);
  assert.equal(Object.keys(FACE_NAMES).length, names.length, '反向表大小应与正向一致');
  for (const [name, id] of Object.entries(FACE_IDS)) {
    assert.equal(FACE_NAMES[id], name, `${name}(${id}) 反查不一致`);
  }
  assert.equal(FACE_PREFIX, 0x14, '0x14 是 QQ 私有区起始，改了整条链都不成立');
});

test('码表：最常用的几个必须对得上（错一个就是发错表情）', () => {
  assert.equal(FACE_IDS['呲牙'], 0);
  assert.equal(FACE_IDS['微笑'], 23);
  assert.equal(FACE_IDS['发怒'], 24);
});

/* ---------------- 入站 ---------------- */

test('入站：新格式带 ext，解不出文字就查表', () => {
  assert.equal(
    decodeFaceTags('哈哈<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'),
    '哈哈【表情: 呲牙】',
    'ext 是 {"text":""}，应退回码表',
  );
});

test('入站：老格式没有 ext 也要认', () => {
  assert.equal(decodeFaceTags('<faceType=1,faceId="23">'), '【表情: 微笑】');
});

test('入站：ext.text 优先于码表（官方改过 id 含义时以它为准）', () => {
  const ext = Buffer.from(JSON.stringify({ text: '坏笑' })).toString('base64');
  assert.equal(
    decodeFaceTags(`<faceType=6,faceId="0",ext="${ext}">`),
    '【表情: 坏笑】',
    'id=0 本来是「呲牙」，ext 说坏笑就该用坏笑',
  );
});

test('入站：属性顺序不同、未知 id 都不能漏', () => {
  assert.equal(decodeFaceTags('<faceId="23",faceType=1>'), '【表情: 微笑】', '顺序变了也要认');
  assert.equal(decodeFaceTags('<faceType=6,faceId="99999">'), '【表情】', '查不到给无名字，不留原文');
});

test('入站：一条消息多个表情逐个转', () => {
  assert.equal(
    decodeFaceTags('<faceType=1,faceId="0"><faceType=1,faceId="23">'),
    '【表情: 呲牙】【表情: 微笑】',
  );
});

test('入站：没有表情的正文一个字都不能动', () => {
  const s = '这 < 那，还有 [方括号] 和 <@某人>';
  assert.equal(decodeFaceTags(s), s);
});

/* ---------------- 出站 ---------------- */

test('出站：命中名字拼成控制字符（0x14 + id）', () => {
  const got = encodeFaceTags('笑死【表情: 呲牙】真的');
  assert.equal(got, `笑死${String.fromCharCode(0x14, 0)}真的`);
  assert.deepEqual([...got].map((c) => c.charCodeAt(0)), [31505, 27515, 20, 0, 30495, 30340]);
});

test('出站：名字对不上就整段删掉，并回报给调用方', () => {
  const missed = [];
  const got = encodeFaceTags('a【表情: 不存在的脸】b', (n) => missed.push(n));
  assert.equal(got, 'ab', '绝不能把【表情: …】原样发进群');
  assert.deepEqual(missed, ['不存在的脸']);
});

test('出站：【表情】不带名字不转（那是入站查不到时的兜底）', () => {
  assert.equal(encodeFaceTags('嗯【表情】'), '嗯【表情】');
});

test('出站：截断把标记切成半截时，残片要清掉', () => {
  assert.equal(encodeFaceTags('说话【表情: 呲'), '说话', '没有收尾】的半截标记');
});

test('出站：正文中间的正常文字不受影响', () => {
  const s = '她说"真【厉害】"，我【服了】';
  assert.equal(encodeFaceTags(s), s, '【…】不带「表情:」前缀就不该动');
});

/* ---------------- 集成：入站 ---------------- */

test('合并器：纯表情消息不会变成空正文（否则模型收到空白）', () => {
  const evt = { content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">' };
  assert.equal(textOf(evt), '【表情: 呲牙】');
});

test('合并器：表情夹在文字里照常拼接', () => {
  assert.equal(textOf({ content: '早<faceType=1,faceId="23">' }), '早【表情: 微笑】');
});

/* ---------------- 集成：出站 ---------------- */

test('通道 send：正文里的表情标记真的变成控制字符发出', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });

  const r = await ch.send({ target: 'u9', text: '好耶【表情: 呲牙】' });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], 'msg.send');
  assert.equal(calls[0][1].content, `好耶${String.fromCharCode(0x14, 0)}`);
});

test('通道 send：试运行也要先编码（日志里的字数才是真会发出去的长度）', async () => {
  const logs = [];
  const host = { rpc: async () => ({ id: 'm1' }) };
  const ch = createRoostHostChannel({
    host, markdownEnabled: () => false, log: (m) => logs.push(m), dryRunOf: () => true,
  });
  const r = await ch.send({ target: 'u9', text: '【表情: 微笑】' });
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true, '试运行不该真的打 rpc');
  /** 7 个字的表情标记编码后只剩 2 个码元；日志按编码后的长度报，才对得上实际发出去的内容 */
  assert.ok(logs.some((m) => m.includes('（2 字）')), `试运行日志应报编码后的长度，实际：${logs.join(' | ')}`);
});

// ── 夹小黄脸的提示词 ─────────────────────────────────────────
//
// 出站编码器（`encodeFaceTags`）早就能把 `【表情: 微笑】` 变成真表情，
// 但提示词里从来没教过这个语法——功能一直是空转的。这一段补的就是那句话，
// 所以测试要钉住「教了语法」和「举的例子全都发得出去」。

test('小黄脸提示词：教了标记语法，且只给表里真有的名字', async () => {
  const { faceHint, FACE_IDS, POPULAR_FACES } = await import('../src/face-table.js');
  const hint = faceHint();
  assert.ok(hint.includes('【表情:'), '必须出现那个标记的写法，否则模型学不会');
  assert.ok(hint.includes('最多带一两个'), '要限次数，不然每句尾巴都挂一个');

  /** 每个列出来的名字都得能编码，否则模型照着写会被整段删掉 */
  const listed = POPULAR_FACES.filter((n) => hint.includes(n));
  assert.ok(listed.length >= 20, `名单太短（${listed.length}）`);
  for (const n of listed) {
    assert.ok(Object.hasOwn(FACE_IDS, n), `${n} 不在码表里，写进提示词就是骗模型`);
  }
});

test('小黄脸提示词：max 能收窄名单', async () => {
  const { faceHint } = await import('../src/face-table.js');
  const short = faceHint({ max: 3 });
  const { POPULAR_FACES } = await import('../src/face-table.js');
  const hit = POPULAR_FACES.filter((n) => short.includes(n));
  assert.equal(hit.length, 3);
});
