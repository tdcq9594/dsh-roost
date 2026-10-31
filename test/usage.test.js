// 用量记账的单测。
//
// 这块最容易错的是「把累计读数当增量」——数字会指数膨胀，而面板上看起来
// 只是"有点高"，没人会怀疑。所以每条断言都在盯**差值**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUsage } from '../src/usage.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-usage-'));
  return { dir, file: path.join(dir, 'usage.json'), u: createUsage({ file: path.join(dir, 'usage.json') }) };
}

const u1 = (uncached = 100, cacheRead = 900, cacheWrite = 0, output = 50) => ({ uncached, cacheRead, cacheWrite, output });

test('增量：第二次只记差值，不是把累计值再加一遍', () => {
  const { u } = fresh();
  u.record({ chatId: 'g1', usage: u1(100) });
  u.record({ chatId: 'g1', usage: u1(160) });
  const s = u.summary({ days: 1 });
  assert.equal(s.total.uncached, 160, '累计 100 + 增量 60');
  assert.equal(s.total.turns, 2);
});

test('压缩后累计归零：这一轮按全量记，不能变负', () => {
  const { u } = fresh();
  u.record({ chatId: 'g1', usage: u1(1000) });
  // 换了会话，累计从 0 重新开始
  u.record({ chatId: 'g1', usage: u1(30) });
  const s = u.summary({ days: 1 });
  assert.equal(s.total.uncached, 1030, '1000 + 30');
  assert.ok(s.total.uncached > 0);
});

test('读数全 0 时不记账（还没回报过 usage）', () => {
  const { u } = fresh();
  assert.equal(u.record({ chatId: 'g1', usage: u1(0, 0, 0, 0) }), false);
  assert.equal(u.summary({ days: 1 }).total.turns, 0);
});

test('按天分桶：按日历天补齐，没数据的天补零', () => {
  const { u } = fresh();
  const d1 = new Date('2026-10-30T10:00:00').getTime();
  const d2 = new Date('2026-10-31T10:00:00').getTime();
  u.record({ chatId: 'g1', at: d1, usage: u1(100) });
  u.record({ chatId: 'g1', at: d2, usage: u1(200) }); // 跨天：读数没归零，按增量 100

  const s = u.summary({ days: 7, now: d2 });
  assert.equal(s.days.length, 7, '固定 7 个日历天，不是"7 个有数据的天"');
  assert.equal(s.days.at(-1).day, '2026-10-31');
  const byDay = Object.fromEntries(s.days.map((d) => [d.day, d]));
  assert.equal(byDay['2026-10-30'].uncached, 100);
  assert.equal(byDay['2026-10-31'].uncached, 100);
  assert.equal(byDay['2026-10-29'].uncached, 0, '空白的天补零');
});

test('重启后不重复计数：读数要落盘', () => {
  const { file, u } = fresh();
  u.record({ chatId: 'g1', usage: u1(100) });
  // 模拟重启：同一个文件新实例，会话累计继续往上走
  const again = createUsage({ file });
  again.record({ chatId: 'g1', usage: u1(150) });
  assert.equal(again.summary({ days: 1 }).total.uncached, 150, '不能把 100 再记一遍');
});

test('读数没动 = 这一轮没调模型，不计轮数', () => {
  const { u } = fresh();
  u.record({ chatId: 'g1', usage: u1(100) });
  assert.equal(u.record({ chatId: 'g1', usage: u1(100) }), false);
  assert.equal(u.summary({ days: 1 }).total.turns, 1);
});

test('按会话汇总：谁最费一眼看出来', () => {
  const { u } = fresh();
  u.record({ chatId: 'small', usage: u1(100) });
  u.record({ chatId: 'big', usage: u1(5000) });
  const s = u.summary({ days: 1 });
  assert.equal(s.chats.big.uncached, 5000);
  assert.equal(s.chats.small.uncached, 100);
  assert.ok(s.chats.big.uncached > s.chats.small.uncached, '按 token 比大小');
});

test('命中率：三个计费桶之和做分母（和 compact 同一口径）', () => {
  const { u } = fresh();
  u.record({ chatId: 'g1', usage: u1(100, 900, 0) });
  const s = u.summary({ days: 1 });
  assert.equal(s.total.cacheHit, 90);
});

test('落盘后重新加载还在', () => {
  const { file, u } = fresh();
  u.record({ chatId: 'g1', usage: u1(123) });
  const again = createUsage({ file });
  assert.equal(again.summary({ days: 1 }).total.uncached, 123);
});
