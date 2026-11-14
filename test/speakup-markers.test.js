/**
 * 主动消息里的**下游标记**必须留给 `outbound-actions.js`。
 *
 * 回归背景：`speakup.js` 以前在 send 之前 `replace(/<<[^>]*>>/g, '')`，
 * 一刀把所有标记抹平 —— 于是「让 ta 主动发图文卡片 / 发张截图 / 发语音」
 * 全部无效，看起来像「主动消息不支持富文本」，实际是这一行吃掉了标记。
 * 被动回复那条链路没有这行，所以聊天里一直正常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSpeakUp } from '../src/speakup.js';

function make(raw) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-speakup-'));
  const calls = [];
  const su = createSpeakUp({
    dataDir: dir,
    cfgOf: () => ({ prompt: '说点什么', chatId: 'u1', awake: {} }),
    ownerOf: () => 'u1',
    generate: async () => raw,
    send: async (x) => { calls.push(x); return { ok: true, id: 'm1' }; },
    log: () => {},
  });
  return { su, calls, dir };
}

test('卡片标记原样交给下游（不在 speakup 里被抹掉）', async (t) => {
  const { su, calls, dir } = make('这个视频好看 <<card: 猫|一只猫|https://www.bilibili.com/video/BV1xx411c7mD|https://i0.hdslb.com/a.jpg>>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await su.fire('测试', { target: 'u1' });
  assert.equal(r.ok, true, r.why);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /<<card:/, '卡片必须活着到 outbound');
  assert.match(calls[0].text, /这个视频好看/, '正文也在');
});

test('只有卡片没有正文：仍然算「有内容」，不会被判成空', async (t) => {
  const { su, calls, dir } = make('<<card: 猫|一只猫|https://www.bilibili.com/video/BV1xx411c7mD|https://i0.hdslb.com/a.jpg>>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await su.fire('测试', { target: 'u1' });
  assert.equal(r.ok, true, '只发卡片不该被当成「去掉标记后没内容」');
  assert.equal(calls.length, 1);
});

test('图片标记也保留（发截图那条路）', async (t) => {
  const { su, calls, dir } = make('给你看这个 <<image-alone: C:/tmp/shots/BV1xx411c7mD-20.jpg>>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await su.fire('测试', { target: 'u1' });
  assert.equal(r.ok, true);
  assert.match(calls[0].text, /<<image-alone:/);
});

test('silence 仍然由 speakup 自己摘掉，并作为 silenceMs 往下传', async (t) => {
  const { su, calls, dir } = make('嗯 <<silence: 30m>>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await su.fire('测试', { target: 'u1' });
  assert.equal(r.ok, true);
  assert.equal(/<<silence/i.test(calls[0].text), false, 'silence 不该留在正文里');
  assert.ok(Number(calls[0].silenceMs) >= 30 * 60_000, '时长要传给下游');
});

test('纯 <<skip>> 依然是她不说话（不算失败、不发送）', async (t) => {
  const { su, calls, dir } = make('<<skip>>');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await su.fire('测试', { target: 'u1' });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
});
