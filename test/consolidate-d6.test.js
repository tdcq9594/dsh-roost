// D6：consolidate 的旧记忆比对（op=add/update/outdated）
//
// 最容易静默出错的几处：老字符串格式被当成坏数据丢掉、old 定位到多条时
// 误作废一条无关的、preview 说能作废但真实护栏不敢、dry 偷偷写了盘。
// 这里用**真实的 memory / journal**（不是全假 stub）盯这四件事。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import { createMemory } from '../src/memory.js';
import {
  createConsolidate, buildPrompt, yesterdayOf,
  normalizeAgreement, planAgreementOp, MAX_PROMPT_FACTS, pickRows,
} from '../src/consolidate.js';

const noop = () => {};

function scene({ plan = {}, withGenerate = true, dry = false, seedFacts = [], now = Date.now(), breakSupersede = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-d6-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;

  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '说好了周末不排会' });

  const m = createMemory();
  for (const f of seedFacts) m.add('g1', f.text, f.scope || 'chat', f.opts || {});
  /** 造「预览说能作废、真实护栏却拒绝」的裂缝，验证退化路径 */
  if (breakSupersede) m.supersede = () => ({ ok: false, why: '测试护栏拒绝' });

  const prompts = [];
  const generate = withGenerate
    ? async (p) => { prompts.push(p); return JSON.stringify(plan); }
    : null;
  const c = createConsolidate({
    journal: j, graph: null, memory: m, generate,
    aliasesOf: () => [], log: noop, now: () => now,
  });
  return {
    m, j, c, day, prompts,
    run: (o = {}) => c.run({ day, dry, ...o }),
    facts: () => m.listFull('g1', []).chat,
    done: () => {
      try { j.close(); } catch {}
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
    },
  };
}

const oldFact = { text: '约定：周末不排会' };

/* ---------------- 纯函数 ---------------- */

test('D6：老的字符串 agreements 继续按新增；三态对象归一化', () => {
  /** `status` 是 2026-11-18 新增：老输出没有这个键 → 默认 fact，行为不变 */
  assert.deepEqual(normalizeAgreement('明天买牛奶'),
    { text: '明天买牛奶', op: 'add', old: '', status: 'fact' });
  assert.deepEqual(normalizeAgreement({ text: '改成周六', op: 'update', old: '周末' }),
    { text: '改成周六', op: 'update', old: '周末', status: 'fact' });
  assert.deepEqual(normalizeAgreement({ text: '不用了', op: 'outdated', old: '周末' }),
    { text: '不用了', op: 'outdated', old: '周末', status: 'fact' });
  /** 只有 hearsay 被认；别的值（含模型瞎写）一律退回 fact，不静默降级 */
  assert.equal(normalizeAgreement({ text: '张三说出差', status: 'hearsay' }).status, 'hearsay');
  assert.equal(normalizeAgreement({ text: '张三说出差', status: 'guess' }).status, 'fact');
  assert.equal(normalizeAgreement('明天买牛奶').status, 'fact');
  /** 缺定位词不许让模型去「作废某条旧约定」 */
  assert.equal(normalizeAgreement({ text: '改成周六', op: 'update' }).op, 'add');
  assert.equal(normalizeAgreement({ text: '改成周六', op: 'bogus', old: '周末' }).op, 'add');
  assert.equal(normalizeAgreement(null).text, '');
});

test('D6：old 命中 0 条 / 多条都不猜，一律退化成新增', () => {
  const item = { text: '改成周六下午', op: 'update', old: '周末' };
  assert.equal(planAgreementOp(item, []).will, 'add');
  assert.equal(planAgreementOp(item, [oldFact]).will, 'supersede');
  const many = planAgreementOp(item, [oldFact, { text: '约定：周末补个会' }]);
  assert.equal(many.will, 'add');
  assert.equal(many.candidates.length, 2);
  /** 已作废的历史不该再被当活事实定位 */
  assert.equal(planAgreementOp(item, [{ ...oldFact, until: 123 }]).will, 'add');
});

test('D6：旧事实进 prompt 不超过 10 条，且把三态说明带上', () => {
  const facts = Array.from({ length: 15 }, (_, i) => `事实 ${i}`);
  const p = buildPrompt({ day: '2026-11-07', chatName: 'g1', items: [{ line: '[a] 一句话' }], facts });
  assert.ok(p.includes('[10] 事实 9'));
  assert.ok(!p.includes('[11]'), `最多 ${MAX_PROMPT_FACTS} 条`);
  assert.ok(p.includes('op=update'));
  assert.ok(p.includes('op=outdated'));
  assert.ok(p.includes('old 找不到、或匹配到多条时我不会猜'));
  /** 没有旧事实时不该多塞一个空标题，前缀保持稳定 */
  const plain = buildPrompt({ day: '2026-11-07', chatName: 'g1', items: [{ line: '[a] 一句话' }] });
  assert.ok(!plain.includes('你已经记得的事'));
});

/* ---------------- 真实落盘 ---------------- */

test('D6：老格式的字符串约定照旧写进 facts', async (t) => {
  const s = scene({ plan: { agreements: ['明天买牛奶'] } });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.agreements, 1);
  assert.ok(s.facts().some((f) => f.text === '约定：明天买牛奶' && !f.until));
  assert.equal(r.fallback, 0);
});

test('D6：update 唯一定位 → 旧的打 until 留库，新的活事实记入', async (t) => {
  const s = scene({
    seedFacts: [oldFact],
    plan: { agreements: [{ text: '周末改成周六下午', op: 'update', old: '周末不排会' }] },
  });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.updated, 1);
  assert.equal(r.agreements, 1);
  const facts = s.facts();
  assert.ok(facts.find((f) => f.text === oldFact.text)?.until > 0, '旧约定作废但没删行');
  assert.ok(facts.some((f) => f.text === '约定：周末改成周六下午' && !f.until));
  assert.ok(s.prompts[0].includes(oldFact.text), '旧事实真的进了 prompt，模型才有的对照');
});

test('D6：old 匹配多条 → 预览就判「不猜」，两条都留着，只多记一条', async (t) => {
  const s = scene({
    seedFacts: [oldFact, { text: '约定：周末补个会' }],
    plan: { agreements: [{ text: '周末改成周六下午', op: 'update', old: '周末' }] },
  });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.fallback, 0, '预览阶段就退化成新增，根本没走到 supersede');
  const facts = s.facts();
  assert.equal(facts.filter((f) => f.until > 0).length, 0, '一条都不该被误作废');
  assert.equal(facts.length, 3);
  assert.equal(r.agreementOps[0].will, 'add');
  assert.match(r.agreementOps[0].reason, /匹配 2 条.*不猜/);
});

test('D6：预览说能作废、真实护栏却拒绝 → 退化成新增，绝不误作废', async (t) => {
  const s = scene({
    breakSupersede: true,
    seedFacts: [oldFact],
    plan: { agreements: [{ text: '改成周六下午', op: 'update', old: '周末不排会' }] },
  });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.fallback, 1);
  assert.equal(r.updated, 0);
  assert.equal(r.agreements, 1, '照旧记下新约定');
  assert.equal(s.facts().filter((f) => f.until > 0).length, 0);
  assert.equal(r.agreementOps[0].will, 'add', '明细要回写成实际处置，不能留着过时的预览');
  assert.match(r.agreementOps[0].reason, /护栏拦下：测试护栏拒绝/);
});

test('D6：outdated 只作废不新增', async (t) => {
  const s = scene({
    seedFacts: [oldFact],
    plan: { agreements: [{ text: '不排会这事算了', op: 'outdated', old: '周末不排会' }] },
  });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.outdated, 1);
  assert.equal(r.agreements, 0);
  const facts = s.facts();
  assert.equal(facts.length, 1);
  assert.ok(facts[0].until > 0);
});

test('D6：dry-run 列出每条处置明细，且一个字都不写盘', async (t) => {
  const s = scene({
    dry: true,
    seedFacts: [oldFact],
    plan: { agreements: [
      '明天买牛奶',
      { text: '改成周六下午', op: 'update', old: '周末不排会' },
      { text: '找不到', op: 'outdated', old: '根本没这条' },
    ] },
  });
  t.after(s.done);
  const before = JSON.stringify(s.facts());
  const r = await s.run();
  assert.equal(r.dry, true);
  assert.equal(r.agreementOps.length, 3);
  assert.deepEqual(r.agreementOps.map((x) => x.will), ['add', 'supersede', 'add']);
  assert.match(r.agreementOps[1].reason, /唯一定位/);
  assert.match(r.agreementOps[2].reason, /不猜/);
  assert.equal(JSON.stringify(s.facts()), before, 'dry 不许碰 memory.json');
  assert.equal(r.outdated, 0, 'dry 不执行作废');
});

/* ---------------- D1 前置分流 ---------------- */

test('D1：pickRows 默认不筛；skipChatter 只筛极短闲聊；原文不受影响', () => {
  const rows = [
    { id: 'a', at: 1, role: 'user', level: 'normal', text: '嗯嗯' },
    { id: 'b', at: 2, role: 'user', level: 'normal', text: '我养了只猫' },
    { id: 'c', at: 3, role: 'user', level: 'important', text: '好' },
    { id: 'd', at: 4, role: 'user', level: 'normal', text: '哈哈' },
  ];
  const all = pickRows(rows);
  assert.equal(all.length, 4, '默认不筛，行为不变');
  const skipped = pickRows(rows, { skipChatter: true });
  assert.deepEqual(skipped.map((x) => x.row.id), ['b', 'c'],
    '纯语气词("嗯嗯"/"哈哈") 被筛掉；有信息的短句和 important 都留');
});

test('D1：整批都是极短闲聊时不调模型（省一次调用）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-chatter-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const day = yesterdayOf(Date.now());
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '嗯' });
  j.add({ id: 'b', at: base + 1000, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '哦' });
  let called = 0;
  const c = createConsolidate({
    journal: j, graph: null, memory: createMemory(),
    generate: async () => { called += 1; return '{}'; },
    aliasesOf: () => [], log: noop, now: () => Date.now(),
  });
  await c.run({ day });
  assert.equal(called, 0, '全是极短闲聊，不该调模型');
  try { j.close(); } catch {}
  if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = oldEnv;
});

/* ---------------- 向量补算（PR#41 漏掉的整步） ---------------- */

test('巩固会补算日记向量并落库（之前 journal.vec 永远是 NULL）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-vecfill-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const day = yesterdayOf(Date.now());
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '今天聊了搬家的事' });

  /** 假 embedder：固定 4 维向量 + 模型指纹 */
  let manyCalls = 0;
  const fakeEmbed = {
    enabled: () => true,
    modelId: () => 'local:test',
    many: async (texts) => { manyCalls += 1; return texts.map(() => [1, 0, 0, 0]); },
  };
  const c = createConsolidate({
    journal: j, graph: null, memory: createMemory(), generate: null,
    aliasesOf: () => [], log: noop, now: () => Date.now(), embed: fakeEmbed,
  });
  const r = await c.run({ day });
  assert.ok(manyCalls >= 1, '巩固要真的调 embed.many 补向量');
  assert.ok(r.needVec >= 1, `至少补了原始日记那条（实际 ${r.needVec}）`);
  const row = j.withVec({ chatId: 'g1', model: 'local:test' })[0];
  assert.ok(row, '补的向量要能被同模型的 withVec 读到');
  /** 换个模型指纹就读不到了（同维度也不混用） */
  assert.equal(j.withVec({ chatId: 'g1', model: 'http:other' }).length, 0, '换模型后旧向量不参与');

  try { j.close(); } catch {}
  if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = oldEnv;
});

test('巩固会重算"换过模型"的旧向量（否则它们被检索排除却永不更新）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-reembed-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const day = yesterdayOf(Date.now());
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '这条是旧模型算的向量' });
  /** 同维度、不同模型：cosine 能算但语义错位，必须重算 */
  j.setVec('a', [9, 9, 9, 9], 'http:old-model');

  const seen = [];
  const fakeEmbed = {
    enabled: () => true,
    modelId: () => 'local:test',
    many: async (texts) => { seen.push(...texts); return texts.map(() => [1, 0, 0, 0]); },
  };
  const c = createConsolidate({
    journal: j, graph: null, memory: createMemory(), generate: null,
    aliasesOf: () => [], log: noop, now: () => Date.now(), embed: fakeEmbed,
  });
  await c.run({ day });

  assert.ok(seen.some((t) => t.includes('旧模型算的向量')), '旧模型的行要重新送去算向量');
  const row = j.get('a');
  assert.equal(row.vecModel, 'local:test', '模型指纹要更新成当前模型');
  assert.deepEqual(Array.from(j.vecOf(row) || []), [1, 0, 0, 0], '向量要真的被覆盖');

  try { j.close(); } catch {}
  if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = oldEnv;
});

/* ---------------- E2 待跟进：巩固时自动提炼 ---------------- */

test('E2：约定上的 followUp 只在合法时保留，没有就不加键（老输出形状不变）', () => {
  assert.deepEqual(normalizeAgreement('明天买牛奶'),
    { text: '明天买牛奶', op: 'add', old: '', status: 'fact' });
  const a = normalizeAgreement({ text: '下周三前给他答复', followUp: { inDays: 4, question: '问一句答复' } });
  assert.deepEqual(a.followUp, { inDays: 4, question: '问一句答复' });
  /** 借鉴口径：必须有明确问题才问；模型漏填 question 时用约定文本兜底，不留空串 */
  const noQ = normalizeAgreement({ text: '下周三前给他答复', followUp: { inDays: 4 } });
  assert.ok(noQ.followUp.question.includes('下周三前给他答复'), 'question 空时按约定文本兜底');
  assert.ok(noQ.followUp.question.length > 0, '兜底后一定非空，注入端才认');
  assert.equal(normalizeAgreement({ text: 'x', followUp: { inDays: 0 } }).followUp, undefined, 'inDays=0 当没写');
  assert.equal(normalizeAgreement({ text: 'x', followUp: { inDays: 9999 } }).followUp, undefined, '离谱的当没写');
  assert.equal('followUp' in normalizeAgreement('明天买牛奶'), false, '没有时连键都不出现');
});

test('E2：开关关着时 prompt 完全不提 followUp；开着才教', async () => {
  const mk = async (enabled) => {
    const dir = mkdtempSync(join(tmpdir(), `roost-fu-${enabled ? 'on' : 'off'}-`));
    const data = join(dir, 'data');
    mkdirSync(data, { recursive: true });
    const oldEnv = process.env.DSH_ROOST_DATA;
    process.env.DSH_ROOST_DATA = data;
    const day = yesterdayOf(Date.now());
    const base = Date.parse(`${day}T10:00:00`);
    const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
    j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '他答应下周三前给我答复' });
    let seen = '';
    const c = createConsolidate({
      journal: j, graph: null, memory: createMemory(),
      generate: async (p) => { seen = p; return '{}'; },
      aliasesOf: () => [], log: noop, now: () => Date.now(), followUpEnabled: enabled,
    });
    await c.run({ day });
    try { j.close(); } catch {}
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = oldEnv;
    return seen;
  };
  const off = await mk(false);
  const on = await mk(true);
  assert.ok(!off.includes('followUp'), '关着时 prompt 里不该出现 followUp');
  assert.ok(on.includes('"followUp"'), '开着时要给出形状');
  assert.ok(on.includes('inDays'), '要说明 inDays 从今天算');
});

test('E2：巩固把约定上的 followUp 真挂到那条约定上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-fu-apply-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const day = yesterdayOf(Date.now());
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'a', at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '他答应下周三前给我答复' });

  const memory = createMemory();
  const c = createConsolidate({
    journal: j, graph: null, memory,
    generate: async () => JSON.stringify({
      summary: '他答应下周三前给答复',
      agreements: [{ text: '下周三前给他答复', followUp: { inDays: 4, question: '问一句答复给了没' } }],
    }),
    aliasesOf: () => [], log: noop, now: () => Date.now(), followUpEnabled: true,
  });
  const r = await c.run({ day });
  assert.equal(r.followUps, 1, '统计里要算一条');

  /** 用未来的时间点看它是不是真到期了 */
  const due = memory.dueFollowUps('g1', [], { at: Date.now() + 5 * 86400000 });
  assert.equal(due.length, 1, '到期该被捞出来');
  assert.equal(due[0].question, '问一句答复给了没');
  assert.match(due[0].text, /^约定：下周三前给他答复/, '挂在那条约定上');

  try { j.close(); } catch {}
  if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = oldEnv;
});
