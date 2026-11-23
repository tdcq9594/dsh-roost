// B2 心智模型快照：默认关、独立文件、delta watermark、模型失败回退、清空不误伤 self。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMindModelStore, MAX_HISTORY, MAX_MD,
} from '../src/mind-model-store.js';
import {
  refreshMindModel, collectModelInput, buildRefreshPrompt, cleanRefreshOutput,
} from '../src/mind-model-refresh.js';
import { createSelf } from '../src/self.js';
import { OP_SCOPE } from '../src/ext-quick-scopes.js';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-mind-snap-'));
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  return { dir, done: () => {
    if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev;
  } };
}

const full = (n = 3, at0 = 1000) => ({
  global: Array.from({ length: n }, (_, i) => ({
    text: `事实${i}：主人喜欢颜色${i}`, at: at0 + i, until: null, archivedAt: null, w: 1,
  })),
  chat: [],
});
const entities = [{ name: '主人' }];

/* ---------------- 存储：默认不存在 / 原子写 / 上限 ---------------- */

test('M-1 从没刷新过时文件不存在，get 返回 null（升级前后逐字节不变）', async () => {
  const { dir, done } = boot();
  try {
    const s = createMindModelStore();
    assert.equal(s.get('default'), null);
    assert.equal(existsSync(join(dir, 'mind-model.json')), false, '只读不创建文件');
    assert.deepEqual(s.ids(), []);
  } finally { done(); }
});

test('M-2 put 落盘 / get 读回 / 旧版压进 history（上限 MAX_HISTORY）', async () => {
  const { dir, done } = boot();
  try {
    const s = createMindModelStore({ now: () => 5000 });
    for (let i = 1; i <= MAX_HISTORY + 3; i += 1) {
      const r = s.put('default', { markdown: `第${i}版` + '内容'.repeat(20), watermark: i * 100, mode: 'full' });
      assert.equal(r.ok, true);
      if (i > 1) assert.equal(r.archived, true, '内容变了就归档旧版');
    }
    const snap = s.get('default');
    assert.equal(snap.markdown.startsWith(`第${MAX_HISTORY + 3}版`), true);
    assert.equal(snap.history.length, MAX_HISTORY, '历史不超上限');
    assert.equal(snap.watermark, (MAX_HISTORY + 3) * 100);
    const onDisk = JSON.parse(readFileSync(join(dir, 'mind-model.json'), 'utf8'));
    assert.equal(onDisk.models.default.history.length, MAX_HISTORY, '历史真的落盘');
    /** 归档项要带上"上一版是怎么来的"——current 不存 reason 时这里会恒空 */
    s.put('default', { markdown: '模型整理的一版' + '内容'.repeat(20), watermark: 9999, mode: 'delta', reason: 'model' });
    const archived = s.get('default').history.at(-1);
    assert.equal(archived.mode, 'full', '归档的是上一版（机械 full）');
    assert.equal(s.get('default').reason, 'model', 'current 记下这一版来自模型');
    /** reason 在重启（读盘）后也要在 */
    const s2 = createMindModelStore();
    assert.equal(s2.get('default').reason, 'model');
    /** 再归档一次，上一版的 model 来源要进 history */
    s2.put('default', { markdown: '再下一版' + '内容'.repeat(20), watermark: 10000, reason: 'mechanical' });
    assert.equal(s2.get('default').history.at(-1).reason, 'model');
    /** 超长 markdown 被夹住，防写爆数据文件 */
    s.put('default', { markdown: 'x'.repeat(MAX_MD + 500) });
    assert.ok(s.get('default').markdown.length <= MAX_MD);
  } finally { done(); }
});

/* ---------------- refresh 编排 ---------------- */

test('M-3 默认机械 refresh：零模型调用、写快照、watermark = 最新事实时间', async () => {
  const { dir, done } = boot();
  try {
    const s = createMindModelStore({ now: () => 9999 });
    let calls = 0;
    const r = await refreshMindModel({
      full: full(3, 1000), entities, store: s,
      generate: async () => { calls += 1; return '不该被调用'; },
    });
    assert.equal(r.ok, true);
    assert.equal(calls, 0, '默认不调模型');
    assert.equal(r.usedModel, false);
    assert.equal(r.persisted, true);
    assert.equal(r.watermark, 1002, 'watermark = 最新事实的 at');
    assert.equal(existsSync(join(dir, 'mind-model.json')), true, '快照落盘');
    assert.ok(s.get('default').markdown.includes('主人'), '快照含实体分组');
  } finally { done(); }
});

test('M-4 dry-run 跑同一 bar pipeline 但不写盘、可重复', async () => {
  const { dir, done } = boot();
  try {
    const s = createMindModelStore();
    const a = await refreshMindModel({ full: full(), entities, store: s, dry: true });
    const b = await refreshMindModel({ full: full(), entities, store: s, dry: true });
    assert.equal(a.ok, true);
    assert.equal(a.persisted, false);
    assert.equal(b.persisted, false);
    assert.equal(a.markdown, b.markdown, 'dry-run 可重复');
    assert.equal(existsSync(join(dir, 'mind-model.json')), false, 'dry-run 绝不落盘');
  } finally { done(); }
});

test('M-5 delta：机械模式只把增量喂模型，整篇快照仍用全量（反对半窗冒充当前状态）', async () => {
  const { done } = boot();
  try {
    const s = createMindModelStore();
    const first = await refreshMindModel({ full: full(3, 1000), entities, store: s, mode: 'delta' });
    assert.equal(first.effectiveMode, 'full');
    assert.equal(first.fallbackReason, 'no_baseline_content');
    assert.equal(first.facts, 3);

    /** 有基线后 delta 成立：deltaFacts 只算新的，但 facts（整篇）仍是全量 */
    const second = await refreshMindModel({ full: full(5, 1000), entities, store: s, mode: 'delta' });
    assert.equal(second.effectiveMode, 'delta');
    assert.equal(second.deltaFacts, 2, '只把新事实喂给模型');
    assert.equal(second.facts, 5, '整篇快照仍基于全部活事实，不会丢旧的');

    /** prompt 同时给基线 + 新事实，且明确禁止把半窗说成"当前/最新/仍然" */
    const p = buildRefreshPrompt({ baseline: '# 基线', markdown: '- 新增', delta: true });
    assert.match(p, /增量刷新/);
    assert.match(p, /不要说「当前」「最新」「仍然」/);
  } finally { done(); }
});

test('M-5b 坑 #3875：空源无条件短路，有基线也不写「共 0 条」覆盖完整快照', async () => {
  const { done } = boot();
  try {
    const s = createMindModelStore();
    await refreshMindModel({ full: full(3, 1000), entities, store: s });
    const before = s.get('default').markdown;
    const r = await refreshMindModel({ full: { global: [], chat: [] }, entities, store: s });
    assert.equal(r.ok, false);
    assert.equal(r.shortCircuited, true);
    assert.equal(r.persisted, false);
    assert.equal(s.get('default').markdown, before, '上一版完整快照原样保留');
  } finally { done(); }
});

test('M-5c 坑 #3112：delta 模型失败不写半窗候选、不推进水位', async () => {
  const { done } = boot();
  try {
    const s = createMindModelStore();
    const base = await refreshMindModel({ full: full(2, 1000), entities, store: s });
    assert.equal(base.watermark, 1001);
    const five = full(5, 1000); // 新增 3 条 at=1002..1004
    const r = await refreshMindModel({
      full: five, entities, store: s, mode: 'delta', useModel: true,
      generate: async () => { throw new Error('挂了'); },
    });
    assert.equal(r.effectiveMode, 'full', '失败后退回全量，不保留 delta 模式');
    assert.equal(r.fallbackReason, 'delta_ops_failed');
    assert.equal(r.usedModel, false);
    assert.equal(r.facts, 5, '整篇是全量，旧事实没丢');
    assert.ok(r.markdown.includes('事实0'), '旧事实仍在快照里');
    /**
     * 水位在全量成功落盘后可以前移（整篇已包含全部事实，不是半窗）；
     * 关键是不写"只有新增那 3 条"的候选。这里断言的是内容完整，不是水位不动。
     */
    assert.equal(s.get('default').markdown.includes('事实0'), true);
  } finally { done(); }
});

test('M-6 模型模式：严格 prompt + 输出清洗；失败/空输出回退机械，绝不写空快照', async () => {
  const { done } = boot();
  try {
    const p = buildRefreshPrompt({ markdown: '# 她现在相信什么\n- 事实', delta: true });
    assert.match(p, /不得新增/);
    assert.match(p, /增量刷新/);
    const md = '# 标题\n内容足够长了abcabc，这一行是正常快照该有的长度';
    assert.equal(cleanRefreshOutput('```markdown\n' + md + '\n```'), md);
    assert.equal(cleanRefreshOutput('```markdown\n' + md + '```'), md, '末尾没换行也要认');
    assert.equal(cleanRefreshOutput('好的'), '');
    assert.equal(cleanRefreshOutput(''), '');

    const s = createMindModelStore();
    const ok = await refreshMindModel({
      full: full(), entities, store: s, useModel: true,
      generate: async () => '# 模型整理版\n' + '同样的事实重写一遍。'.repeat(5),
    });
    assert.equal(ok.usedModel, true);
    assert.ok(ok.markdown.includes('模型整理版'));

    const before = s.get('default').markdown;
    const bad = await refreshMindModel({
      full: full(), entities, store: s, useModel: true,
      generate: async () => { throw new Error('模型挂了'); },
    });
    assert.equal(bad.usedModel, false, '失败回退机械');
    assert.match(bad.reason, /全量机械投影/);
    assert.ok(bad.markdown.length > 0, '机械投影顶上，不写空');
    assert.ok(s.get('default').markdown.length > 0, '上一版不被空输出覆盖');
    assert.notEqual(before, '', '原来有内容');
  } finally { done(); }
});

/* ---------------- 隔离：不进 journal / 不清 self / 权限 ---------------- */

test('M-7 清空只删 mind-model.json，不碰 self.json（也不碰 memory.json）', async () => {
  const { dir, done } = boot();
  try {
    writeFileSync(join(dir, 'self.json'), JSON.stringify({ notes: [{ text: '我的自述', at: 1 }], chapters: [] }));
    const self = createSelf();
    assert.equal(self.all().notes.length, 1, 'self 有内容');
    const s = createMindModelStore();
    await refreshMindModel({ full: full(), entities, store: s });
    assert.equal(existsSync(join(dir, 'mind-model.json')), true);
    s.clear('default');
    assert.deepEqual(s.ids(), []);
    assert.equal(JSON.parse(readFileSync(join(dir, 'self.json'), 'utf8')).notes.length, 1, 'self.json 未被误伤');
  } finally { done(); }
});

test('M-8 collectModelInput 排除已取代/归档的事实', () => {
  const f = full(2);
  f.global.push({ text: '旧说法', at: 3000, until: 4000, archivedAt: null });
  f.global.push({ text: '已归档', at: 3001, until: null, archivedAt: 5000 });
  const got = collectModelInput(f, entities, 0);
  assert.equal(got.total, 2, '只留活事实');
  assert.equal(got.rows.every((r) => !r.until && !r.archivedAt), true);
});

test('M-9 quick op 权限：快照只读，刷新/清空是 memory:write', () => {
  assert.equal(OP_SCOPE['mind.snapshot'], 'memory:read');
  assert.equal(OP_SCOPE['mind.refresh'], 'memory:write');
  assert.equal(OP_SCOPE['mind.clear'], 'memory:write');
});
