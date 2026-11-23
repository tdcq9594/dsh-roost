import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseTemporal, cnNumber, temporalLabel } from '../src/temporal.js';

/** 固定一个周三，避免今天星期几影响「上周」断言 */
const NOW = new Date(2026, 10, 18, 15, 0, 0).getTime(); // 2026-11-18
const DAY = 86_400_000;
const ymd = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('cnNumber：阿拉伯数字 / 中文数字 / 十一 二十 / 半', () => {
  assert.equal(cnNumber('3'), 3);
  assert.equal(cnNumber('三'), 3);
  assert.equal(cnNumber('十一'), 11);
  assert.equal(cnNumber('二十'), 20);
  assert.equal(cnNumber('半'), 0.5);
  assert.equal(cnNumber('乱七八糟'), null);
});

test('解析不出时间词返回 null（只增不减：行为不变）', () => {
  assert.equal(parseTemporal('上次说的那个约定', NOW), null);
  assert.equal(parseTemporal('', NOW), null);
  assert.equal(temporalLabel(null), '');
});

test('今天/昨天/前天：当天零点起 24 小时', () => {
  const t = parseTemporal('今天聊的那件事', NOW);
  assert.equal(t.label, '今天');
  assert.equal(ymd(t.from), '2026-11-18');
  assert.equal(ymd(t.to), '2026-11-19');
  assert.equal(t.rest.trim(), '聊的那件事', '时间词要从查询里去掉');
  assert.equal(ymd(parseTemporal('昨天搬家', NOW).from), '2026-11-17');
  assert.equal(ymd(parseTemporal('前天买的', NOW).from), '2026-11-16');
});

test('上周：上周一到本周一（周一为起点）', () => {
  const t = parseTemporal('上周说的约定', NOW);
  assert.equal(t.label, '上周');
  assert.equal(ymd(t.from), '2026-11-09');
  assert.equal(ymd(t.to), '2026-11-16');
});

test('上个月 / 去年：整月整年', () => {
  const m = parseTemporal('上个月搬家那次', NOW);
  assert.equal(ymd(m.from), '2026-10-01');
  assert.equal(ymd(m.to), '2026-11-01');
  const y = parseTemporal('去年过年', NOW);
  assert.equal(ymd(y.from), '2025-01-01');
  assert.equal(ymd(y.to), '2026-01-01');
});

test('绝对年月：2024年3月 / 2024年', () => {
  const m = parseTemporal('2024年3月那次', NOW);
  assert.equal(ymd(m.from), '2024-03-01');
  assert.equal(ymd(m.to), '2024-04-01');
  assert.equal(ymd(parseTemporal('2023年的事', NOW).to), '2024-01-01');
});

test('N天前 / N周前 / N个月前 / 最近N天', () => {
  assert.equal(ymd(parseTemporal('三天前说的', NOW).from), '2026-11-15');
  assert.equal(ymd(parseTemporal('两周前的事', NOW).from), '2026-11-04');
  assert.equal(ymd(parseTemporal('两个月前的事', NOW).from), '2026-09-01');
  assert.equal(ymd(parseTemporal('两个月前的事', NOW).to), '2026-10-01');
  const r = parseTemporal('最近7天的对话', NOW);
  assert.equal(r.label, '最近7天');
  assert.equal(r.to, NOW + 1, '「至今」要含今天全天');
  assert.ok(r.from < r.to);
});

test('多个时间词取先命中的具体规则；区间必须 from<to', () => {
  const t = parseTemporal('上周三说的，其实是2024年3月', NOW);
  assert.ok(t);
  assert.ok(t.from < t.to);
});

test('接线：recallFor 解析时间词并把范围传给检索，预览能显示', () => {
  const path = new URL('../src/host.js', import.meta.url)
  const host = readFileSync(path, 'utf8')
  assert.match(host, /parseTemporal\(q\)/, '召回主链路要解析时间词')
  assert.match(host, /from: temporal\?\.from \|\| 0/, '时间窗下界要传给 journal.search')
  assert.match(host, /to: temporal\?\.to \|\| 0/, '时间窗上界要传给 journal.search')
  assert.match(host, /searchWithShortContext\(journal, searchQ/, '关键词检索要用去掉时间词的查询')
  assert.match(host, /temporal: r\.temporal \|\| null/, '预览要回传时间定位结果')

  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /时间定位：认出/, '预览面板要显示解析出的时间窗')
})

test('「N天前至今」要含今天：to 必须晚于今天的任一时点', () => {
  const t = parseTemporal('三天前说的', NOW);
  assert.ok(t.to > NOW, 'to 要是 now+1，不能是今天零点（否则今天全天被排除）');
  /** 今天早上 10 点的日记应该落在窗内 */
  const thisMorning = new Date(2026, 10, 18, 10, 0, 0).getTime();
  assert.ok(thisMorning >= t.from && thisMorning < t.to, '今天早上说的要能命中');
});
