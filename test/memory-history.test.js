// B1 历史说法 + 证据投影：只读、不造因果链、多轮 supersede 的完整性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectEvidence, historyOf, listSuperseded } from '../src/memory-history.js';
import { createMemory } from '../src/memory.js';
import { OP_SCOPE } from '../src/ext-quick-scopes.js';

const DAY = 86_400_000;

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-hist-'));
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  return { dir, done: () => {
    if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
  } };
}

/* ---------------- 证据投影 ---------------- */

test('H-1 projectEvidence：新引文 / 老摘要都认，不编造 journalId', () => {
  const rows = projectEvidence({ evidence: [
    { kind: 'retain', quote: '他说周三出发', journalId: 'j1', at: 1000 },
    { kind: 'consolidate', detail: '归纳：爱旅行', at: 2000 },
    { kind: 'bad', at: 3000 },
    { detail: '', at: 4000 },
  ] });
  assert.equal(rows.length, 2, '空 evidence 不进投影');
  assert.equal(rows[0].hasQuote, true);
  assert.equal(rows[0].quote, '他说周三出发');
  assert.equal(rows[0].journalId, 'j1');
  assert.equal(rows[1].hasQuote, false, '老摘要不算引文');
  assert.equal(rows[1].quote, '归纳：爱旅行');
  assert.equal(rows[1].journalId, '');
  assert.deepEqual(projectEvidence(null), []);
});

/* ---------------- 历史推断（纯函数，人造 rows） ---------------- */

test('H-2 historyOf：按 until 配对此前说法，如实标 inferred/adjacent，不宣称因果', () => {
  const t = Date.now();
  const rows = [
    { text: '主人住在杭州', id: 'a1', at: t - DAY, until: t, evidence: [{ detail: '旧引文', at: t - DAY }] },
    { text: '主人住在杭州市', id: 'a2', at: t, until: null, evidence: [{ quote: '新引文', journalId: 'j2', at: t }] },
    { text: '完全不相关的一句话', id: 'b1', at: t, until: t },
  ];
  const got = historyOf(rows, 'a2', { now: t });
  assert.equal(got.found, true);
  assert.equal(got.text, '主人住在杭州市');
  assert.equal(got.evidence[0].quote, '新引文');
  assert.equal(got.earlier.length, 1, '不相关的不会被算成此前说法');
  assert.equal(got.earlier[0].text, '主人住在杭州');
  assert.equal(got.earlier[0].inferred, true, '没有指针，必须标推断');
  assert.equal(got.earlier[0].adjacent, true, 'until 与 at 同一时刻 → 时间相邻');
  assert.equal(got.earlier[0].evidence[0].quote, '旧引文');
  assert.match(got.note, /推断.*不等于因果演变链/, '文案不能冒充 Hindsight 的快照链');
  assert.equal(historyOf(rows, '不存在', { now: t }), null);
});

test('H-3 historyOf：矛盾的两条不配对（沿用 supersede 的非矛盾判据）', () => {
  const t = Date.now();
  const rows = [
    { text: '主人对花生不过敏', at: t - DAY, until: t },
    { text: '主人对花生过敏', at: t, until: null },
  ];
  const got = historyOf(rows, '主人对花生过敏', { now: t });
  assert.equal(got.earlier.length, 0, 'supersede 本就不会拿"不过敏/过敏"互相取代');
});

test('H-4 listSuperseded：按 until 降序，纯函数不改输入', () => {
  const rows = [
    { text: 'a', until: 100 },
    { text: 'b', until: 300 },
    { text: 'c', until: 200 },
    { text: 'd', until: 0 },
  ];
  const snap = JSON.stringify(rows);
  assert.deepEqual(listSuperseded(rows).map((x) => x.text), ['b', 'c', 'a']);
  assert.equal(JSON.stringify(rows), snap);
});

/* ---------------- 真库链路：多轮 supersede --------------- */

test('H-5 真库三轮取代：历史条目全在，逐条可查证据与推断', async () => {
  const { dir, done } = boot();
  try {
    const m = createMemory();
    /**
     * supersede 是**宁漏不误**的字面判据：相似度 <0.75 不取代，
     * 而且已打 until 的旧条目会被跳过（不会形成 A→B→C 的链）。
     * 这正是"不能宣称演变链"的代码事实——测试照实断言，不编链。
     */
    m.add('g1', '他住在杭州滨江区', 'global', { at: 1000, evidence: [{ detail: '第一次说的', at: 1000 }] });
    m.add('g1', '他住在杭州滨江', 'global', { at: 2000 });
    m.add('g1', '他住在杭州市滨江区', 'global', { at: 3000 });
    const before = readFileSync(join(dir, 'memory.json'), 'utf8');
    const full = m.listFull('g1');
    const hist = listSuperseded(full.global);
    assert.equal(hist.length, 1, '只有相似度够的那对被取代；已取代的不会被再次取代成链');
    assert.equal(hist[0].text, '他住在杭州滨江区');
    /** 取代者是第二句（at=2000 = 历史条目的 until，相似度 0.857）；第三句跟历史只有 0.667，配不上 */
    const live = full.global.find((x) => !x.until && x.text === '他住在杭州滨江');
    assert.ok(live, '取代者是活的');
    const detail = historyOf(full.global, live.id, { now: 3000 });
    assert.equal(detail.found, true);
    assert.ok(detail.earlier.length >= 1, '至少推断出一条此前说法');
    for (const e of detail.earlier) {
      assert.equal(e.inferred, true);
      assert.ok(e.until > 0, '此前说法必须真被取代过');
    }
    /** 只读：查完盘上字节不变 */
    assert.equal(readFileSync(join(dir, 'memory.json'), 'utf8'), before, '历史查询不得写盘');
  } finally { done(); }
});

test('H-6 quick op 登记为 memory:read（只读展示，不抬权）', () => {
  assert.equal(OP_SCOPE['memory.history'], 'memory:read');
});
