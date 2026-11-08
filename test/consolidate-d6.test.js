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
  normalizeAgreement, planAgreementOp, MAX_PROMPT_FACTS,
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
  assert.deepEqual(normalizeAgreement('明天买牛奶'), { text: '明天买牛奶', op: 'add', old: '' });
  assert.deepEqual(normalizeAgreement({ text: '改成周六', op: 'update', old: '周末' }),
    { text: '改成周六', op: 'update', old: '周末' });
  assert.deepEqual(normalizeAgreement({ text: '不用了', op: 'outdated', old: '周末' }),
    { text: '不用了', op: 'outdated', old: '周末' });
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
