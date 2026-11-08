import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEvents, EVENT_TTL_MS, EVENT_LABELS, shouldInjectEvents } from '../src/events.js';

const T0 = Date.parse('2026-11-08T10:00:00');

function fresh({ now, max, ttlMs, seed } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-events-'));
  const file = join(dir, 'events.json');
  if (seed) writeFileSync(file, JSON.stringify(seed), 'utf8');
  let t = T0;
  const clock = now || (() => t);
  const ev = createEvents({ file, max, ttlMs, now: clock, log: () => {} });
  return { ev, file, advance: (ms) => { t += ms; }, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('D8：只认白名单动作，自由文本/正文字段一律不落盘', () => {
  const { ev, read } = fresh();
  ev.push({ kind: 'proactive', text: '主人我今天特别想你，还喝了奶茶', title: '秘密', chatId: 'g1' });
  ev.push({ kind: '偷偷塞的', text: '不该记住' });
  const rows = read();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'proactive');
  assert.ok(!('text' in rows[0]) && !('title' in rows[0]));
  assert.ok(!JSON.stringify(rows).includes('奶茶'));
  assert.ok(!JSON.stringify(rows).includes('秘密'));
  assert.equal(ev.size, 1);
});

test('D8：ring 上限 100，最旧的先走', () => {
  const { ev, read } = fresh({ max: 5 });
  for (let i = 0; i < 9; i += 1) ev.push({ kind: 'file', count: i + 1 });
  const rows = read();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].count, 5);
  assert.equal(rows[4].count, 9);
});

test('D8：真 TTL —— 过期行从盘上删掉，不是注入时假装看不见', () => {
  const { ev, advance, read } = fresh();
  ev.push({ kind: 'proactive' });
  advance(EVENT_TTL_MS + 1000);
  ev.push({ kind: 'file' });
  const rows = read();
  assert.equal(rows.length, 1, '过期那条被物理删掉');
  assert.equal(rows[0].kind, 'file');
  assert.equal(ev.recent().length, 1);
  assert.ok(!ev.text().includes('主动找过你'));
});

test('D8：陈旧文件第一次 load 就清过期行并回写', () => {
  const seed = [
    { at: T0 - EVENT_TTL_MS - 1, kind: 'proactive', scene: 'c2c', count: 1 },
    { at: T0 - 1000, kind: 'voice', scene: 'c2c', count: 1 },
    { at: 0, kind: 'file', scene: 'c2c', count: 1 },
  ];
  const { ev, read } = fresh({ seed });
  assert.equal(ev.size, 1);
  assert.equal(read().length, 1, '回写过，盘上也只剩一条');
  assert.match(ev.text(), /发过一段语音/);
});

test('D8：注入块带今天/昨天、场合与次数，空时返回空串', () => {
  const { ev, advance } = fresh();
  assert.equal(ev.text(), '');
  ev.push({ kind: 'image', scene: 'group', count: 3 });
  const s = ev.text();
  assert.match(s, /^【最近做过的事】\n/);
  assert.match(s, /今天 10:00 在群里发过一张图（3 次）/);
  advance(24 * 3_600_000 - 2000); // 还没到 24h，但已跨过零点
  assert.match(ev.text(), /昨天 10:00/, '跨零点标昨天，不写成今天');
});

test('D8：clear 清空并落盘；坏文件当空处理', () => {
  const { ev, read } = fresh();
  ev.push({ kind: 'file' });
  ev.clear();
  assert.equal(ev.size, 0);
  assert.deepEqual(read(), []);

  const dir = mkdtempSync(join(tmpdir(), 'roost-events-'));
  const file = join(dir, 'events.json');
  writeFileSync(file, '{ 坏掉的 json', 'utf8');
  const broken = createEvents({ file, now: () => T0, log: () => {} });
  assert.equal(broken.size, 0);
  broken.push({ kind: 'proactive' });
  assert.equal(broken.size, 1, '坏文件之后照样能写');
});

test('D8：动作表覆盖报告里的四类，全都有人话', () => {
  for (const k of ['proactive', 'file', 'image', 'voice']) {
    assert.ok(EVENT_LABELS[k], `${k} 缺人话`);
  }
});

test('D8 注入闸门：只有「开着 + owner + 私聊」三个条件同时成立', () => {
  assert.equal(shouldInjectEvents({ enabled: true, bucket: 'owner', kind: 'c2c' }), true);
  assert.equal(shouldInjectEvents({ enabled: false, bucket: 'owner', kind: 'c2c' }), false, '默认关必须一个字都不注入');
  assert.equal(shouldInjectEvents({ enabled: true, bucket: 'member', kind: 'c2c' }), false);
  assert.equal(shouldInjectEvents({ enabled: true, bucket: 'owner', kind: 'group' }), false);
  assert.equal(shouldInjectEvents(), false, '缺参数按最保守算');
});
