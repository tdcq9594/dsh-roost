// 审计日志的单测。
//
// 这一层坏了不会报错：文件写不进去就静默跳过（故意的），所以只能靠断言
// 落盘内容来证明「真的记下来了」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-audit-'));
process.env.DSH_ROOST_DATA = dir;

const { audit, peerSummary } = await import('../src/audit.js');

test('审计：写一行 JSONL，含时间/操作/会话/身份', () => {
  audit({ op: 'memory.mute', chatId: 'g1', peer: 'owner', peerId: 'abcd1234' });
  const file = path.join(dir, 'audit.log');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.op, 'memory.mute');
  assert.equal(row.chatId, 'g1');
  assert.equal(row.peer, 'owner');
  assert.equal(row.peerId, 'abcd1234');
  assert.equal(typeof row.at, 'number');
  assert.ok(row.at > 1_600_000_000_000, '时间戳应该是毫秒');
});

test('审计：多次写是追加，不覆盖', () => {
  audit({ op: 'persona.set', chatId: 'g2' });
  const lines = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).op, 'persona.set');
});

test('审计：不记参数内容（避免把用户原文写进日志）', () => {
  audit({ op: 'memory.clear', chatId: 'g3', arg: '这句话不该出现' });
  const last = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n').at(-1);
  assert.equal(last.includes('这句话不该出现'), false);
});

test('peerSummary：principal 缺席按 owner（与 fence 一致）', () => {
  assert.deepEqual(peerSummary(null), { kind: 'unknown', id: '' });
  assert.deepEqual(peerSummary({ id: 'op-1234567890' }), { kind: 'owner', id: 'op-12345' });
  assert.deepEqual(peerSummary({ id: 'u1', principal: { kind: 'guest' } }), { kind: 'guest', id: 'u1' });
});
