/**
 * 【刚才说到】的取数合并（`src/recent-rows.js`）。
 *
 * 三个要求，每条错一次都会在真机上看得见（2026-11-25 那次）：
 *   · 条数要凑到 `recentLimit`（默认 8），不是「缺口有几条就给几条」；
 *   · 不许跟本轮正文重复（写日记在前、拼注入在后，最近一条永远是本轮这句）；
 *   · 顺序要按时间正序，否则「刚才」读起来是乱的。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRecentRows, inBody, normText, DEDUP_MIN_CHARS } from '../src/recent-rows.js';

const T = 1_700_000_000_000;
/** 账本缺口行（正序，老的在前） */
const g = (i, text, at) => ({ seq: i, eventId: `ev-${i}`, at: at ?? T + i * 1000, who: '群友', text });
/** 日记行（`journal.recent` 的原样：倒序，新的在前） */
const j = (text, at, role = 'user') => ({ id: `j-${at}`, at, role, sender: '群友', text });

test('缺口自己够数：不再查日记，直接给最近 limit 条', () => {
  const gap = [1, 2, 3, 4].map((i) => g(i, `第${i}句`));
  const rows = mergeRecentRows({ gap, limit: 2, journalRows: [j('日记里的话', T - 1000)] });
  assert.deepEqual(rows.map((r) => r.text), ['第3句', '第4句'], '取最近的，且保持正序');
});

test('缺口不足：用日记补到 limit（这才是默认 8 条该有的样子）', () => {
  const gap = [g(1, '缺口一', T + 5000)];
  const journalRows = [j('日记一', T + 4000), j('日记二', T + 3000), j('日记三', T + 2000)];
  const rows = mergeRecentRows({ gap, journalRows, limit: 4 });
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.text),
    ['日记三', '日记二', '日记一', '缺口一'],
    '合并后按时间正序（老的在前）',
  );
});

test('缺口 + 日记足够时按 limit 截断，且截掉的是最老的', () => {
  const gap = [g(1, '缺口一', T + 5000)];
  const journalRows = [j('日记一', T + 4000), j('日记二', T + 3000)];
  const rows = mergeRecentRows({ gap, journalRows, limit: 2 });
  assert.deepEqual(rows.map((r) => r.text), ['日记一', '缺口一']);
});

test('与正文重复的剔掉：日记那条就是本轮刚写的', () => {
  const body = '卡利渚-没头脑(653DD)：【表情: 惊讶】 倦飞之鸟(QQ 2014)：【表情: OK】';
  const gap = [g(1, '【表情: 惊讶】', T + 1000)];
  const journalRows = [
    j('卡利渚-没头脑(653DD)：【表情: 惊讶】 倦飞之鸟(QQ 2014)：【表情: OK】', T + 1000),
    j('晚上好', T - 1000),
  ];
  const rows = mergeRecentRows({ gap, journalRows, limit: 5, bodyText: body });
  assert.deepEqual(rows.map((r) => r.text), ['晚上好'], '缺口那条和正文一字不差，两句都得剔');
});

test('空白差异不影响去重（压掉空白再比）', () => {
  const body = '嗯\n\n我 觉得  可以';
  assert.equal(inBody('嗯 我觉得可以', normText(body)), true);
  assert.equal(inBody('我觉得不行', normText(body)), false);
});

test('短句不参与去重：「在」「？」撞上纯属巧合', () => {
  const body = '在 吗 ？';
  const short = '在';
  assert.ok(short.length < DEDUP_MIN_CHARS);
  assert.equal(inBody(short, normText(body)), false, '短句必须留着，别把上下文剔光');
});

test('缺口与日记指向同一条时只留一份', () => {
  const same = { at: T + 1000, text: '同一句话' };
  const rows = mergeRecentRows({
    gap: [{ ...same, seq: 1, who: '群友' }],
    journalRows: [{ ...same, role: 'user', sender: '群友' }],
    limit: 8,
  });
  assert.equal(rows.length, 1);
});

test('limit = 0 时整块不要（配置里的总开关）', () => {
  assert.deepEqual(mergeRecentRows({ gap: [g(1, '有话')], limit: 0 }), []);
});

test('两条来源都空时返回空数组，不抛', () => {
  assert.deepEqual(mergeRecentRows({}), []);
  assert.deepEqual(mergeRecentRows({ gap: null, journalRows: undefined, limit: 8 }), []);
});
