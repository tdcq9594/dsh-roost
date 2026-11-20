// 日记的可信度列（fact/hearsay/guess）。
//
// 三条硬约束：
//   1. 默认 fact **不落盘**：老库每一行 status 都是空串，升级前后字节一致；
//   2. 读取时空串归一成 fact，调用方永远拿到三档之一；
//   3. `insertRaw`（备份还原）必须保留 status，不能被洗成 fact。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'journal-status-'));

function make() {
  return createJournal({ file: join(tmp(), 'j.sqlite') });
}

test('日记：默认 fact，hearsay 能落盘并读回', () => {
  const j = make();
  j.add({ id: 'a', at: 1, chatId: 'c1', text: '甲说乙喜欢猫', status: 'hearsay' });
  j.add({ id: 'b', at: 2, chatId: 'c1', text: '乙住在杭州' });

  assert.equal(j.get('a').status, 'hearsay');
  assert.equal(j.get('b').status, 'fact');
});

test('日记：guess 也能落盘（三档不是两档）', () => {
  const j = make();
  j.add({ id: 'a', at: 1, text: '她可能喜欢猫', status: 'guess' });
  assert.equal(j.get('a').status, 'guess');
});

test('日记：非法 status 一律当 fact（不能把脏值带进注入）', () => {
  const j = make();
  j.add({ id: 'a', at: 1, text: 'x', status: 'rumor' });
  assert.equal(j.get('a').status, 'fact');
});

test('日记：insertRaw 保留 status（备份还原不能洗掉可信度）', () => {
  const j = make();
  j.insertRaw({ id: 'a', at: 1, text: 'x', status: 'guess' });
  assert.equal(j.get('a').status, 'guess');
});

test('日记：老数据没有 status 字段时按 fact 读', () => {
  const j = make();
  j.insertRaw({ id: 'a', at: 1, text: '老库里的行' });
  assert.equal(j.get('a').status, 'fact');
});

test('日记：JSONL 后端 fact 不落盘、hearsay 落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-jsonl-'));
  const file = join(dir, 'j.sqlite');
  /** 用目录占住 sqlite 文件名：DatabaseSync 打不开，createJournal 会退回 JSONL */
  mkdirSync(file);

  const j = createJournal({ file });
  j.add({ id: 'a', at: 1, text: '甲说乙喜欢猫', status: 'hearsay' });
  j.add({ id: 'b', at: 2, text: '乙住在杭州' });

  const lines = readFileSync(join(dir, 'j.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === 'a').status, 'hearsay');
  /** fact 是默认值：落盘时删掉，升级前后字节不变 */
  assert.equal(lines.find((l) => l.id === 'b').status, undefined);
  assert.equal(j.get('a').status, 'hearsay');
  assert.equal(j.get('b').status, 'fact');
});

test('日记：对外 touch 传 at 时按历史时刻记访问', () => {
  const j = make();
  j.add({ id: 'a', at: 1, text: 'x' });

  j.touch(['a'], 1_800_000_000_000);
  const r = j.get('a');
  assert.equal(r.accessed, 1);
  assert.equal(r.lastAccess, 1_800_000_000_000);
});
