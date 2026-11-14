// A3 面板「听语音」卡的数据源：只记语音、只留内存、不落盘。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAsrRecent } from '../src/asr-recent.js';

const voice = (text, chatId = 'OPENID_1234567890') => ({
  chat: { chatId },
  attachments: [{ type: 'voice', asrText: text }],
});

test('note：只认 voice 附件，图片/视频/文件都不进读数', () => {
  const r = createAsrRecent();
  r.note({ chat: { chatId: 'C1' }, attachments: [
    { type: 'image', url: 'http://x/a.png' },
    { type: 'video' },
    { type: 'file', filename: 'a.zip' },
  ] });
  assert.deepEqual(r.list(), []);

  r.note(voice('今天天气不错'));
  const rows = r.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '今天天气不错');
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].chatId, '1234567890', 'chatId 只留后 10 位，不把完整 openid 铺到面板');
});

test('note：没转出文字也要记一条 ok:false，否则「她没听清」查不到', () => {
  const r = createAsrRecent();
  r.note(voice('   '));
  r.note({ chat: { chatId: 'C2' }, attachments: [{ type: 'voice' }] });
  const rows = r.list();
  assert.equal(rows.length, 2);
  assert.equal(rows.every((x) => x.ok === false), true);
  assert.equal(rows.every((x) => x.text === ''), true);
});

test('note：一条消息里多段语音各记一条；list 新的在前且返回副本', () => {
  let t = 1000;
  const r = createAsrRecent({ now: () => ++t });
  r.note({ chat: { chatId: 'C' }, attachments: [
    { type: 'voice', asrText: '第一句' },
    { type: 'voice', asrText: '第二句' },
  ] });
  const rows = r.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, '第二句');
  assert.equal(rows[1].text, '第一句');
  rows[0].text = '改过了';
  assert.equal(r.list()[0].text, '第二句', 'list 要给副本，调用方改不动内部');
});

test('note：正文截断到 120 字，但 chars 记原长；最多留 20 条', () => {
  const long = '啊'.repeat(300);
  const r = createAsrRecent();
  r.note(voice(long));
  assert.equal(r.list()[0].text.length, 120);
  assert.equal(r.list()[0].chars, 300);

  for (let i = 0; i < 30; i++) r.note(voice('第' + i + '句'));
  const rows = r.list();
  assert.equal(rows.length, 20);
  assert.equal(rows[0].text, '第29句', '最旧那几条被挤掉，最新还在');
});

test('模块不碰文件系统：不写盘、不进记忆库', () => {
  const src = readFileSync(new URL('../src/asr-recent.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|mkdirSync|readFileSync/);
  assert.doesNotMatch(src, /journal|memory|fetch\(/);
});

test('热路径防御：畸形附件只跳过自己，合法语音照记，绝不抛到消息链路', () => {
  const r = createAsrRecent();
  const badType = {};
  Object.defineProperty(badType, 'type', { get() { throw new Error('type getter boom') }, enumerable: true });
  const badText = { type: 'voice' };
  Object.defineProperty(badText, 'asrText', { get() { throw new Error('asrText getter boom') }, enumerable: true });
  const badToString = { type: 'voice', asrText: { toString() { throw new Error('toString boom') } } };
  assert.doesNotThrow(() => r.note({ chat: { chatId: 'C' }, attachments: [
    badType, badText, { type: 'voice', asrText: '正常这句要留下' }, null, badToString,
  ] }));
  assert.deepEqual(r.list().map((x) => x.text), ['正常这句要留下']);
});

test('热路径防御：Proxy 数组的迭代器抛错也兜得住（for...of 外层）', () => {
  const r = createAsrRecent();
  const arr = [{ type: 'voice', asrText: '本来能记' }];
  const trapped = new Proxy(arr, {
    get(target, key) {
      if (key === Symbol.iterator) throw new Error('iterator boom');
      return Reflect.get(target, key);
    },
  });
  assert.doesNotThrow(() => r.note({ chat: { chatId: 'C' }, attachments: trapped }));
  assert.equal(r.list().length, 0, '迭代器读不到就整条放弃，绝不冒泡');
  /* 兜完之后正常 payload 仍要能记，try 不能把后续调用卡死 */
  r.note(voice('后面这句照记'));
  assert.equal(r.list()[0].text, '后面这句照记');
});

test('热路径防御：payload 自己的 getter 抛错也不能冒泡', () => {
  const r = createAsrRecent();
  assert.doesNotThrow(() => r.note({ get attachments() { throw new Error('boom') } }));
  assert.equal(r.list().length, 0, 'attachments 读不到就整条放弃，别硬凑');
  assert.doesNotThrow(() => r.note({ get chat() { throw new Error('boom') }, attachments: [{ type: 'voice', asrText: '还在' }] }));
  assert.equal(r.list().length, 1, 'chat 读不到只丢会话后缀，转写读数仍可用');
  assert.equal(r.list()[0].chatId, '');
});
