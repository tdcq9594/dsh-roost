// 四段耗时的计算。边界比正例重要：缺时间点、时钟回拨都会算出负数或天文数字。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentsOf } from '../src/timing.js';

test('正常：三段各归各位', () => {
  const p = { t: { recv: 1000, start: 1012 } };
  const seg = segmentsOf(p, 1030, 2000);
  assert.deepEqual(seg, { queue: 12, prep: 18, gen: 970 });
});

test('老插件不带时间点：前两段给 null，不给 0', () => {
  const seg = segmentsOf({}, 1030, 2000);
  assert.equal(seg.queue, null);
  assert.equal(seg.prep, null);
  assert.equal(seg.gen, 970, '生成这一段宿主自己能算，不受影响');
});

test('只带了 start：queue 给 null，prep 照算', () => {
  const seg = segmentsOf({ t: { start: 1012 } }, 1030, 2000);
  assert.equal(seg.queue, null);
  assert.equal(seg.prep, 18);
});

test('时钟回拨：负值夹到 0，不输出 -3ms', () => {
  const p = { t: { recv: 1012, start: 1009 } }; // 插件机器比内核慢 3ms
  const seg = segmentsOf(p, 1005, 2000);        // 宿主又比插件慢
  assert.equal(seg.queue, 0);
  assert.equal(seg.prep, 0);
  assert.ok(seg.gen >= 0);
});

test('垃圾值当没有：字符串、NaN、负数', () => {
  for (const t of [{ recv: 'abc', start: 'x' }, { recv: NaN, start: NaN }, { recv: -1, start: -1 }]) {
    const seg = segmentsOf({ t }, 1000, 2000);
    assert.equal(seg.queue, null, JSON.stringify(t));
    assert.equal(seg.prep, null, JSON.stringify(t));
  }
});
