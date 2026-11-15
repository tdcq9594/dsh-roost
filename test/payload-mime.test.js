// 图片真实类型判定（对照方案 C 批）：文件头优先、声明兜底。
// 背景：QQ 网关把发上来的图片统一标成 image/png，content_type 不可信。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessMime } from '../src/roost-payload.js';

/** 造够 12 字节的「文件头 + 填充」 */
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
const gif = () => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(10)]);
const webp = () =>
  Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(4)]);
/** 认不出的 12 字节 */
const unknown = () => Buffer.concat([Buffer.from('ZZZZ', 'latin1'), Buffer.alloc(8)]);

test('M1 声明 png、实际是 GIF → 按 GIF', () => {
  assert.equal(guessMime(gif(), 'image/png'), 'image/gif');
});

test('M2 声明 png、实际是 JPEG → 按 JPEG', () => {
  assert.equal(guessMime(jpeg(), 'image/png'), 'image/jpeg');
});

test('M3 声明 png、实际是 WEBP → 按 WEBP', () => {
  assert.equal(guessMime(webp(), 'image/png'), 'image/webp');
});

test('M4 没有声明也能认出四格式', () => {
  assert.equal(guessMime(png(), ''), 'image/png');
  assert.equal(guessMime(gif(), ''), 'image/gif');
  assert.equal(guessMime(jpeg(), ''), 'image/jpeg');
  assert.equal(guessMime(webp(), ''), 'image/webp');
});

test('M5 声明里带 charset 也能认（按分号切）', () => {
  assert.equal(guessMime(Buffer.alloc(0), 'image/png; charset=binary'), 'image/png');
});

test('M6 认不出的字节退回声明；声明也不在白名单就是空', () => {
  assert.equal(guessMime(unknown(), 'image/png'), 'image/png');
  assert.equal(guessMime(unknown(), 'image/bmp'), '');
  assert.equal(guessMime(unknown(), 'text/plain'), '');
  assert.equal(guessMime(unknown(), ''), '');
});

test('M7 太短的 buffer 不嗅、直接退回声明（别误杀极小图）', () => {
  const tiny = Buffer.from([0xff, 0xd8]);
  assert.equal(guessMime(tiny, 'image/jpeg'), 'image/jpeg');
  assert.equal(guessMime(tiny, ''), '');
});

test('M8 空 buffer / null 不抛', () => {
  assert.equal(guessMime(Buffer.alloc(0), 'image/gif'), 'image/gif');
  assert.equal(guessMime(null, 'image/gif'), 'image/gif');
  assert.equal(guessMime(null, ''), '');
});
