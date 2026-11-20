// 压缩开场的持久化暂存。
//
// 最要紧的两条：**重启后开场还在**（否则映射指向新会话、开场没了 = 失忆），
// 以及**取走即删**（否则同一段开场会被重复拼进每一轮）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPendingOpenings } from '../src/pending-opening.js';

const HOUR = 3_600_000;

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'pending-opening-')), 'opening-pending.json');
}

test('开场：set 之后 get 得到，take 之后就没有了', () => {
  const p = createPendingOpenings({ file: tmpFile() });
  p.set('c1', '（接着上面继续聊）');
  assert.equal(p.get('c1'), '（接着上面继续聊）');
  assert.equal(p.take('c1'), '（接着上面继续聊）');
  assert.equal(p.get('c1'), '');
  assert.equal(p.size, 0);
});

test('开场：重启后还在（映射已落盘、开场不能只活在内存里）', () => {
  const file = tmpFile();
  createPendingOpenings({ file }).set('c1', '开场 A');

  const again = createPendingOpenings({ file });
  assert.equal(again.get('c1'), '开场 A');
});

test('开场：取走之后重启不再出现（不能重复拼开场）', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', '开场 A');
  assert.equal(p.take('c1'), '开场 A');

  assert.equal(createPendingOpenings({ file }).get('c1'), '');
});

test('开场：不同会话互不覆盖', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', 'A');
  p.set('c2', 'B');
  assert.equal(p.get('c1'), 'A');
  assert.equal(p.get('c2'), 'B');
});

test('开场：同一会话重复 set 以最后一次为准', () => {
  const p = createPendingOpenings({ file: tmpFile() });
  p.set('c1', '旧');
  p.set('c1', '新');
  assert.equal(p.get('c1'), '新');
});

test('开场：空键/空文本不写（避免污染公共槽位）', () => {
  const p = createPendingOpenings({ file: tmpFile() });
  p.set('', 'x');
  p.set('c1', '');
  assert.equal(p.size, 0);
});

test('开场：超过 24 小时未消费就丢弃', () => {
  const file = tmpFile();
  let t = 1_000_000;
  const p = createPendingOpenings({ file, now: () => t });
  p.set('c1', '旧开场');
  t += 25 * HOUR;

  const again = createPendingOpenings({ file, now: () => t });
  assert.equal(again.get('c1'), '');
});

test('开场：损坏文件不抛错，且先备份再降级', () => {
  const file = tmpFile();
  writeFileSync(file, '{ 这不是 JSON', 'utf8');

  const p = createPendingOpenings({ file });
  assert.equal(p.size, 0);
  const baks = readdirSync(join(file, '..')).filter((n) => n.includes('.corrupted.'));
  assert.equal(baks.length, 1);
});

test('开场：写盘是完整 JSON（不会留下半份文件）', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', '开场');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.chats.c1.text, '开场');
});

test('开场：超过上限时淘汰最旧的，不无限增长', () => {
  const file = tmpFile();
  let t = 1_000_000;
  const p = createPendingOpenings({ file, now: () => t });
  for (let i = 0; i < 60; i += 1) {
    t += 1;
    p.set(`c${i}`, `开场 ${i}`);
  }
  assert.equal(p.size, 50);
  assert.equal(p.get('c0'), '');
  assert.equal(p.get('c59'), '开场 59');
});

test('开场：盘上是 {"chats":[]} 时不能静默永久失忆', () => {
  const file = tmpFile();
  writeFileSync(file, '{"chats":[]}', 'utf8');

  const p = createPendingOpenings({ file });
  p.set('c1', '开场 A');
  /** 数组也是 object：漏判会让 map 变数组，字符串键被 JSON.stringify 丢掉 */
  assert.equal(createPendingOpenings({ file }).get('c1'), '开场 A');
});

test('开场：损坏备份最多留 3 份（不能每次启动都新增）', () => {
  const file = tmpFile();
  writeFileSync(file, '坏文件', 'utf8');
  for (let i = 0; i < 6; i += 1) createPendingOpenings({ file });

  const baks = readdirSync(join(file, '..')).filter((n) => n.includes('.corrupted.'));
  assert.ok(baks.length <= 3, `备份 ${baks.length} 份，应 ≤3`);
});

test('开场：旧格式里 text 是数字时，take 也返回字符串', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ chats: { c1: { text: 123, at: Date.now() } } }), 'utf8');

  const p = createPendingOpenings({ file });
  assert.equal(p.take('c1'), '123');
});

test('开场：读盘失败时仍写内存（不能把读故障升级成当场失忆）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pending-opening-')), 'opening-pending.json');
  /** 用目录占住文件名：readFileSync 会报 EISDIR，触发 ioFailed */
  mkdirSync(file);

  const p = createPendingOpenings({ file });
  p.set('c1', '开场 A');
  assert.equal(p.get('c1'), '开场 A');
  assert.equal(p.take('c1'), '开场 A');
});

test('开场：__proto__ 当普通键处理，不能变成原型上的幽灵条目', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('__proto__', 'payload');

  assert.equal(p.size, 1);
  assert.equal(p.get('__proto__'), 'payload');
  /** 重启读回也不能走原型链 */
  assert.equal(createPendingOpenings({ file }).get('__proto__'), 'payload');
  assert.equal(p.take('__proto__'), 'payload');
  assert.equal(p.size, 0);
});

test('开场：文件损坏降级后，__proto__ 也不能变幽灵', () => {
  const file = tmpFile();
  writeFileSync(file, '这不是 JSON', 'utf8');

  const p = createPendingOpenings({ file });
  p.set('__proto__', 'GHOST');
  assert.equal(p.size, 1);
  assert.equal(p.get('__proto__'), 'GHOST');
  assert.equal(p.take('__proto__'), 'GHOST');
});
