// 批次 2 的 L3 语义兜底（00:5x 补做）回归。
//
// L1 引用精确作废 / L2 显式改口句式在写日记那条热链路上就能确定性命中；
// L3 只补「改口句指不出具体旧约定、L2 因此没敢作废」的残余：凌晨巩固时
// 让模型在同一轮调用里判一次，把被推翻的旧约定**标失效而不是删掉**。
//
// 这组测试盯的是会静默出错的地方：误作废新约定、一次作废多条、
// dry 写盘、机械模式硬调模型、模型抽风把整轮巩固带崩。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import { createConsolidate, l3Candidates, buildPrompt, yesterdayOf } from '../src/consolidate.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-l3-'));
const noop = () => {};

/** 两条高等级约定 + 一条 normal 改口句，贴近真机 P4 的残余形态 */
function rows(base) {
  return [
    { id: 'old', at: base, role: 'user', kind: 'chat', level: 'critical', text: '以后每句话都要配表情包' },
    { id: 'mid', at: base + 1000, role: 'user', kind: 'chat', level: 'normal', text: '你就不用了' },
    { id: 'new', at: base + 3000, role: 'user', kind: 'chat', level: 'important', text: '明天提醒我买牛奶' },
  ];
}

function scene({
  list, plan = {}, planText = '', withGenerate = true, throws = false,
  now = Date.now(), dry = false,
} = {}) {
  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite'), log: noop });
  (list ?? rows(base)).forEach((r, i) => {
    j.add({ at: base + i * 1000, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', ...r });
  });
  const prompts = [];
  const generate = withGenerate
    ? async (p) => {
      prompts.push(p);
      if (throws) throw new Error('offline');
      return planText || JSON.stringify(plan);
    }
    : null;
  const c = createConsolidate({
    journal: j,
    graph: null,
    memory: { add: () => true },
    generate,
    log: noop,
    now: () => now,
  });
  return { j, c, day, base, prompts, run: (o = {}) => c.run({ day, dry, ...o }) };
}

/* ---------------- 候选集与提示词（纯函数） ---------------- */

test('L3 候选：≥2 条高等级 user 行才成立，改口句给时间上界', () => {
  const base = Date.parse('2026-11-05T10:00:00');
  const r = l3Candidates(rows(base));
  assert.ok(r, '两条 high 应该成立');
  assert.deepEqual(r.ids, ['old', 'new']);
  assert.equal(r.before, base + 1000, '取最早那条改口句的时间');
  assert.ok(r.lines.some((l) => l.startsWith('[old]')));
  assert.ok(r.lines.some((l) => l.includes('（改口）')));
});

test('L3 候选：只有 1 条高等级行 → 不判，不打扰模型', () => {
  const base = Date.parse('2026-11-05T10:00:00');
  assert.equal(l3Candidates(rows(base).filter((r) => r.id !== 'new')), null);
  assert.equal(l3Candidates([]), null);
});

test('L3 候选：身份事实 / 改口句 / 失效行 / bot 行 / normal / 摘要都不进候选', () => {
  const base = Date.parse('2026-11-05T10:00:00');
  const mixed = [
    { id: 'a', at: base, role: 'user', kind: 'chat', level: 'critical', text: '我叫小明' },
    { id: 'b', at: base + 1, role: 'user', kind: 'chat', level: 'critical', text: '别再发图了' },
    { id: 'c', at: base + 2, role: 'user', kind: 'chat', level: 'critical', text: '旧约定', invalidAt: 123 },
    { id: 'd', at: base + 3, role: 'bot', kind: 'chat', level: 'critical', text: '好的' },
    { id: 'e', at: base + 4, role: 'user', kind: 'digest', level: 'critical', text: '摘要' },
    { id: 'f', at: base + 5, role: 'user', kind: 'chat', level: 'normal', text: '嗯' },
  ];
  assert.equal(l3Candidates(mixed), null, '一条合格的都没有');
  const one = l3Candidates([
    ...mixed,
    { id: 'g', at: base + 6, role: 'user', kind: 'chat', level: 'important', text: '每句带图' },
    { id: 'h', at: base + 7, role: 'user', kind: 'chat', level: 'critical', text: '别再带图了' },
  ]);
  assert.equal(one, null, '只有 g 合格（h 是改口句）→ 仍不足 2 条');
  const two = l3Candidates([
    ...mixed,
    { id: 'g', at: base + 6, role: 'user', kind: 'chat', level: 'important', text: '每句带图' },
    { id: 'i', at: base + 7, role: 'user', kind: 'chat', level: 'critical', text: '每句带语音' },
  ]);
  assert.deepEqual(two.ids, ['g', 'i']);
  assert.equal(two.before, base + 1, 'b 是改口句，给时间上界');
});

test('L3 提示词：候选成立才加第 7 项与 revoked 键', () => {
  const item = [{ line: '[a] 10:00 甲(critical): 每句带图' }];
  const withRev = buildPrompt({ day: '2026-11-05', chatName: 'g1', items: item, revocation: { ids: ['a'], before: 0, lines: ['[a] …'] } });
  assert.match(withRev, /7\. revoked/);
  assert.match(withRev, /"revoked":\[\]/);
  assert.match(withRev, /需要判定的重要记录/);

  const plain = buildPrompt({ day: '2026-11-05', chatName: 'g1', items: item });
  assert.doesNotMatch(plain, /revoked/, '条件不成立时模型连这个选项都看不到');
});

/* ---------------- 真库集成 ---------------- */

test('L3：模型点名旧约定 → 标失效、留原文、带 supersededBy、离开注入集', async () => {
  const s = scene({ plan: { summary: '聊了配图的事', revoked: ['old'] } });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(r.revoked, 1);

  const gone = s.j.get('old');
  assert.ok(gone.invalidAt > 0, '失效时刻写上了');
  assert.equal(gone.supersededBy, `consolidate:${s.day}`);
  assert.equal(gone.text, '以后每句话都要配表情包', '原文不许删/不许抹');
  assert.ok(!s.j.top('g1', { limit: 20 }).some((x) => x.id === 'old'), '失效行不再进注入集');
  assert.equal(s.j.get('new').invalidAt, 0, '新约定仍在');
  assert.equal(s.j.invalidated({ chatId: 'g1' })[0].id, 'old', '能查回来做溯源');
});

test('L3：dry 只算不写盘', async () => {
  const s = scene({ plan: { revoked: ['old'] }, dry: true });
  const r = await s.run();
  assert.equal(r.dry, true);
  assert.equal(r.revoked, 1, '计数照给');
  assert.equal(s.j.get('old').invalidAt, 0, '库里不能真的失效');
  assert.equal(s.j.invalidated({ chatId: 'g1' }).length, 0);
});

test('L3：机械巩固（generate 为空）跳过语义判定，不硬调模型', async () => {
  const s = scene({ withGenerate: false, plan: { revoked: ['old'] } });
  const r = await s.run();
  assert.equal(r.mode, 'mechanical');
  assert.equal(r.revoked, 0);
  assert.equal(s.j.get('old').invalidAt, 0);
});

test('L3：只有 1 条高等级行时，即使模型硬给 revoked 也不作废', async () => {
  const s = scene({
    list: [{ id: 'old', level: 'critical', text: '每句带图' }],
    plan: { revoked: ['old'] },
  });
  const r = await s.run();
  assert.equal(r.revoked, 0);
  assert.equal(s.j.get('old').invalidAt, 0);
  assert.doesNotMatch(s.prompts[0], /revoked/);
});

test('L3：模型点名候选集之外的 id → 不作废', async () => {
  const s = scene({ plan: { revoked: ['day:x:g1', '不存在'] } });
  const r = await s.run();
  assert.equal(r.revoked, 0);
  assert.equal(s.j.get('old').invalidAt, 0);
});

test('L3：改口句之后的新约定不许被作废（时间上界）', async () => {
  const s = scene({ plan: { revoked: ['new'] } });
  const r = await s.run();
  assert.equal(r.revoked, 0, 'new 比改口句晚，只能作废更早的');
  assert.equal(s.j.get('new').invalidAt, 0);
});

test('L3：模型一次点名两条，也只作废一条', async () => {
  const s = scene({ plan: { revoked: ['old', 'new'] } });
  const r = await s.run();
  assert.equal(r.revoked, 1);
  assert.ok(s.j.get('old').invalidAt > 0);
  assert.equal(s.j.get('new').invalidAt, 0);
});

test('L3：模型输出不是 JSON → 不作废，整轮巩固照常成功', async () => {
  const s = scene({ planText: '我觉得 old 该作废吧' });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(r.revoked, 0);
  assert.ok(r.errors.some((e) => e.includes('解析失败')));
  assert.ok(s.j.get(`day:${s.day}:g1`), '摘要照样落盘');
});

test('L3：调模型抛错 → 其它巩固动作不受影响', async () => {
  const s = scene({ throws: true });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(r.revoked, 0);
  assert.ok(r.errors.some((e) => e.includes('调模型失败')));
  assert.ok(s.j.get(`day:${s.day}:g1`), '机械摘要照样落盘');
});

test('P0 回归：时间上界排除客套与 bot 行，取最后一条真改口', () => {
  const base = Date.parse('2026-11-05T10:00:00');
  const r = l3Candidates([
    { id: 'polite', at: base, role: 'user', kind: 'chat', level: 'normal', text: '不用了谢谢' },
    { id: 'botline', at: base + 500, role: 'bot', kind: 'chat', level: 'normal', text: '好的，别再发图了' },
    { id: 'a', at: base + 1000, role: 'user', kind: 'chat', level: 'critical', text: '每句配表情包' },
    { id: 'b', at: base + 2000, role: 'user', kind: 'chat', level: 'important', text: '每句带语音' },
    { id: 'revoke', at: base + 3000, role: 'user', kind: 'chat', level: 'normal', text: '你就不用了' },
  ]);
  assert.ok(r);
  assert.equal(r.before, base + 3000, '更早的客套与 bot 回声都不能压低上界');
  assert.deepEqual(r.ids, ['a', 'b']);
  assert.equal(r.lines.filter((l) => l.includes('（改口）')).length, 1);
});

test('P0 回归（真库）：当天更早有无关客套 / bot 回声，仍能作废真约定', async () => {
  const s = scene({
    list: [
      { id: 'polite', level: 'normal', text: '不用了谢谢' },
      { id: 'botline', level: 'normal', role: 'bot', text: '好的，别再发图了' },
      { id: 'old', level: 'critical', text: '以后每句话都要配表情包' },
      { id: 'revoke', level: 'normal', text: '你就不用了' },
      { id: 'new', level: 'important', text: '明天提醒我买牛奶' },
    ],
    plan: { revoked: ['old'] },
  });
  const r = await s.run();
  assert.equal(r.revoked, 1, '更早的客套不该让 L3 静默失效');
  assert.ok(s.j.get('old').invalidAt > 0);
  assert.equal(s.j.get('new').invalidAt, 0, '改口之后的新约定仍被挡');
});

test('L3：两条候选都在上界之前、模型点名 2 条，也只作废 1 条', async () => {
  const s = scene({
    list: [
      { id: 'a', level: 'critical', text: '每句配表情包' },
      { id: 'b', level: 'important', text: '每句带语音' },
      { id: 'revoke', level: 'normal', text: '你就不用了' },
    ],
    plan: { revoked: ['a', 'b'] },
  });
  const r = await s.run();
  assert.equal(r.revoked, 1, '这条单独锁「最多 1 条」，不能靠 before 重叠');
  assert.ok(s.j.get('a').invalidAt > 0);
  assert.equal(s.j.get('b').invalidAt, 0);
});

test('L3：新增判定不改变既有验收计数与动作', async () => {
  const s = scene({
    plan: {
      summary: '一天一句',
      ranks: [['mid', 'important']],
      compress: [{ id: 'mid', digest: '改口了' }],
      agreements: ['明天买牛奶'],
      closed: [],
      revoked: ['old'],
    },
  });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(r.ranked, 1);
  assert.equal(r.compressed, 1);
  assert.equal(r.agreements, 1);
  assert.equal(r.revoked, 1);
  assert.equal(s.j.get(`day:${s.day}:g1`).text, '一天一句');
});
