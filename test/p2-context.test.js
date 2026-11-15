/**
 * P2 三项：引用媒体摘要 / BMP 分层 / 显式引用回复
 * ==============================================
 *
 * 三项都刻意做成「默认零变化」，所以测试里「不带新特征时和以前一样」
 * 比「带新特征时生效」更重要。
 *
 * 跑法：node --test test/p2-context.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeQuoteAttachments, renderInbound, clipQuote,
} from '../src/inbound.js';
import { buildRendered, guessMime, sniffImageType } from '../src/roost-payload.js';
import { parseOutboundActions, createActionRunner } from '../src/outbound-actions.js';

/* ---------------- 1. 引用媒体摘要 ---------------- */

const quoteEls = (attachments) => ({
  elements: [{ type: 'quote', content: '你看这个', msgIdx: 'REFIDX_1', attachments }],
});

test('引用里带图：补上结构化摘要，并如实说看不到内容', () => {
  const evt = quoteEls([{
    type: 'image', filename: 'cat.png', width: 320, height: 240, size: 20480, contentType: 'image/png',
  }]);
  const lines = describeQuoteAttachments(evt);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /引用的消息里有张图/);
  assert.match(lines[0], /cat\.png/);
  assert.match(lines[0], /320×240/);
  assert.match(lines[0], /20KB/);
  assert.match(lines[0], /我看不到图的内容/, '不能谎称能看到');
});

test('引用里带语音：ASR 有就给文字，没有就说明没转出', () => {
  const withAsr = describeQuoteAttachments(quoteEls([{ type: 'voice', asrText: '明天见' }]));
  assert.match(withAsr[0], /转成文字是：明天见/);
  const noAsr = describeQuoteAttachments(quoteEls([{ type: 'voice', asrText: '' }]));
  assert.match(noAsr[0], /没转出文字/);
});

test('引用里带视频/文件/未知类型都有一句人话', () => {
  const lines = describeQuoteAttachments(quoteEls([
    { type: 'video', filename: 'a.mp4' },
    { type: 'file', filename: 'report.pdf', size: 1024 },
    { type: 'other', contentType: 'application/zip', filename: 'x.zip' },
  ]));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /视频.*a\.mp4/);
  assert.match(lines[1], /文件：report\.pdf/);
  assert.match(lines[2], /application\/zip/);
});

test('没有 quote 元素 / 元素没附件 → 空数组（默认零变化）', () => {
  assert.deepEqual(describeQuoteAttachments({}), []);
  assert.deepEqual(describeQuoteAttachments({ elements: [{ type: 'text' }] }), []);
  assert.deepEqual(describeQuoteAttachments(quoteEls([])), []);
  assert.deepEqual(describeQuoteAttachments({ elements: null }), []);
});

test('两条渲染路径逐字一致（带引用附件时也必须一致）', () => {
  const long = '引'.repeat(2500);
  for (const evt of [{ quoted: long }, { quoted: '在吗', ...quoteEls([{ type: 'image', filename: 'a.png' }]) }]) {
    const viaFallback = renderInbound({ ...evt, text: '在吗' });
    const viaRendered = buildRendered(evt, '在吗');
    assert.equal(viaFallback, viaRendered);
  }
  /** 引用正文仍按 2000 截断，摘要不该把正文撑回去 */
  const out = buildRendered({ quoted: long, ...quoteEls([{ type: 'image' }]) }, '在吗');
  assert.ok(out.includes('…'));
  assert.ok(!out.includes('引'.repeat(2001)));
});

test('journal-bridge 的 quotedOf 不受影响（引用正文仍可反解）', () => {
  assert.equal(clipQuote('短引用'), '短引用');
  assert.match(renderInbound({ quoted: '原话' }), /（引用了这句：原话）/);
});

/* ---------------- 2. BMP 分层 ---------------- */

const bmp = () => Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(20)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

test('sniffImageType 认 BMP，guessMime 仍不认（模型白名单不变）', () => {
  assert.equal(sniffImageType(bmp()), 'image/bmp');
  assert.equal(guessMime(bmp(), 'image/png'), 'image/png', '原行为保留：认不出就退声明');
  assert.equal(guessMime(bmp(), ''), '');
});

test('sniffImageType 对四种受支持格式与 guessMime 一致', () => {
  assert.equal(sniffImageType(png()), 'image/png');
  assert.equal(sniffImageType(png()), guessMime(png(), ''));
  assert.equal(sniffImageType(Buffer.alloc(0)), '');
  assert.equal(sniffImageType(null), '');
});

test('BMP 落盘项：data 空 + unsupported 标记，下游不会喂模型', async () => {
  const { createPayloadBuilder } = await import('../src/roost-payload.js');
  const evt = {
    msgId: 'm1', eventId: 'e1', chat: { chatId: 'c1', kind: 'c2c' },
    sender: { openid: 'u1' }, at: Date.now(), content: '',
    attachments: [{ type: 'image', url: 'https://example.test/a.png', contentType: 'image/png' }],
  };
  const build = createPayloadBuilder({
    rpc: async () => ({ ok: true }),
    fetchImpl: async () => ({
      ok: true, status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => bmp().buffer.slice(bmp().byteOffset, bmp().byteOffset + bmp().byteLength),
    }),
    log: () => {},
  });
  const p = await build(evt);
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].unsupported, true);
  assert.equal(p.images[0].data, '', '空 data：turn.js / ext-llm 会自然跳过');
  assert.equal(p.images[0].mediaType, 'image/bmp');
  assert.match(p.images[0].name, /\.bmp$/, '落盘后缀校正了');
  assert.equal(p.images[0].index, 0, 'index 仍占位，配对不错位');
  assert.match(p.rendered, /BMP/);
  assert.match(p.rendered, /转成 PNG \/ JPG 重发/);
});

/* ---------------- 3. 显式引用回复 ---------------- */

function fakeChannel() {
  const calls = [];
  return {
    calls,
    async send(p) { calls.push(p); return { ok: true, id: 'm1' }; },
  };
}

test('不写 <<quote:>> 时 messageReference 是 null（默认零变化）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '普通回复', target: 'c1', replyTo: 'REFIDX_9' });
  assert.equal(ch.calls[0].messageReference, null);
});

test('<<quote: 索引>> 显式挂引用', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '回你 <<quote: REFIDX_7>>', target: 'c1' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_7' });
  assert.doesNotMatch(ch.calls[0].text, /<</, '标记要摘干净');
});

test('<<quote:>> 留空时退回入站 replyTo', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '回你 <<quote:>>', target: 'c1', replyTo: 'REFIDX_3' });
  assert.deepEqual(ch.calls[0].messageReference, { message_id: 'REFIDX_3' });
});

test('既没索引也没 replyTo：降级普通回复并留日志', async () => {
  const ch = fakeChannel();
  const logs = [];
  const run = createActionRunner({ channel: () => ch, log: (m) => logs.push(m) });
  await run({ text: '回你 <<quote:>>', target: 'c1' });
  assert.equal(ch.calls[0].messageReference, null);
  assert.ok(logs.some((m) => /没给索引/.test(m)));
});

test('parseOutboundActions 把 quote 单独摘出，不被通用兜底吃掉', () => {
  const { text, actions } = parseOutboundActions('好 <<quote: A>> <<pick: B|b>>');
  assert.doesNotMatch(text, /<</);
  assert.deepEqual(actions.map((a) => a.type), ['pick', 'quote']);
});
