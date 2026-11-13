/**
 * 5.6 扩展市场：搜索 / 分类 / 能力标签 / 安装进度。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeTags, categoryOf, filterMarketRows, facetsOf,
  MARKET_PHASES, PHASE_LABELS, phaseView,
} from '../src/market-browse.js';
import { createExtMarket } from '../src/ext-market.js';

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const ROWS = [
  { id: 'ai-chat', name: 'AI 对话', description: '接进群聊的大模型', author: 'tdcq9594', category: 'AI', tags: ['AI', '对话', 'LLM'], commands: ['ai'] },
  { id: 'bili', name: 'B站解析', description: '把视频链接转成卡片', author: 'someone', category: '视频', tags: ['视频', '工具'] },
  { id: 'dice', name: '掷骰子', description: '群里掷骰', author: 'tdcq9594', category: '工具', tags: ['工具', '入门'] },
  { id: 'bare', name: '无标签', description: '什么都没写', category: '其它', tags: [] },
];

test('标签归一 / 主分类：兼容数组、逗号串、缺字段', () => {
  assert.deepEqual(normalizeTags({ tags: ['AI', ' AI ', '', null] }), ['AI']);
  assert.deepEqual(normalizeTags({ tags: 'AI, 对话，LLM' }), ['AI', '对话', 'LLM']);
  assert.deepEqual(normalizeTags({}), []);
  assert.equal(categoryOf({ tags: ['AI', 'LLM'] }), 'AI');
  assert.equal(categoryOf({ category: '自定义类', tags: ['AI'] }), '自定义类', '索引将来有 category 就优先');
  assert.equal(categoryOf({}), '其它');
});

test('搜索命中 id / 名字 / 描述 / 作者 / 标签 / 命令，大小写不敏感', () => {
  assert.deepEqual(filterMarketRows(ROWS, { q: 'AI' }).map((r) => r.id), ['ai-chat']);
  assert.equal(filterMarketRows(ROWS, { q: '视频' }).length, 1);
  assert.equal(filterMarketRows(ROWS, { q: 'tdcq9594' }).length, 2);
  assert.deepEqual(filterMarketRows(ROWS, { q: 'llm' }).map((r) => r.id), ['ai-chat']);
  assert.deepEqual(filterMarketRows(ROWS, { q: '/ai' }).map((r) => r.id), [], '命令不在这份样例里');
  assert.equal(filterMarketRows(ROWS, { q: '  ' }).length, ROWS.length, '空串 = 不筛');
});

test('分类 / 标签 / 组合筛选，且能列出可选项', () => {
  assert.deepEqual(filterMarketRows(ROWS, { category: '工具' }).map((r) => r.id), ['dice']);
  assert.deepEqual(filterMarketRows(ROWS, { tag: '工具' }).map((r) => r.id), ['bili', 'dice']);
  assert.deepEqual(filterMarketRows(ROWS, { category: '视频', tag: '工具' }).map((r) => r.id), ['bili']);
  assert.deepEqual(filterMarketRows(ROWS, { q: '骰', tag: '入门' }).map((r) => r.id), ['dice']);
  assert.deepEqual(filterMarketRows(ROWS, { category: '不存在的类' }), []);
  const f = facetsOf(ROWS);
  assert.deepEqual(f.categories.map((x) => x.value).sort(), ['AI', '其它', '工具', '视频'].sort());
  assert.equal(f.tags.find((x) => x.value === '工具').count, 2);
  assert.deepEqual(facetsOf(null), { categories: [], tags: [] });
});

test('阶段百分比单调、中文标签齐、未知阶段当 idle', () => {
  assert.ok(MARKET_PHASES.index < MARKET_PHASES.download);
  assert.ok(MARKET_PHASES.download < MARKET_PHASES.verify);
  assert.ok(MARKET_PHASES.verify < MARKET_PHASES.install);
  assert.ok(MARKET_PHASES.install < MARKET_PHASES.finalize);
  assert.equal(MARKET_PHASES.done, 100);
  for (const phase of Object.keys(MARKET_PHASES)) assert.ok(PHASE_LABELS[phase], `${phase} 要有中文标签`);
  assert.equal(phaseView({ phase: 'verify' }).percent, 65);
  assert.equal(phaseView({ phase: 'verify' }).label, '校验哈希');
  assert.equal(phaseView({ phase: '乱写的' }).phase, 'idle');
  assert.ok(phaseView({ phase: 'done' }).percent <= 100);
});

/** 最小 rig：list 只用 registry.list，安装用慢 download 观察中间阶段 */
function rig(rows, { download } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-market-'));
  return createExtMarket({
    dir,
    registry: { list: () => [], install: () => ({ ok: true }), isForeign: () => false },
    fetchText: async () => JSON.stringify({ schema: 1, repo: 'o/r', branch: 'main', plugins: rows }),
    download: download || (async () => 0),
    log: { info: () => {}, warn: () => {} },
  });
}

const ENTRY = (over = {}) => ({
  id: 'ai-chat', kind: 'dsh-extension', name: 'AI 对话',
  description: '接进群聊的大模型', tags: ['AI', '对话'],
  path: 'plugins/ai-chat', sha256: 'a'.repeat(64), ...over,
});

test('list()：默认全量，筛选后 rows 变但 total 与 facets 不变', async () => {
  const m = rig([ENTRY(), ENTRY({ id: 'bili', name: 'B站解析', tags: ['视频', '工具'] })]);
  const all = await m.list();
  assert.equal(all.rows.length, 2);
  assert.equal(all.total, 2);
  assert.deepEqual(all.rows[0].tags, ['AI', '对话']);
  assert.equal(all.rows[0].category, 'AI');
  assert.ok(all.facets.categories.some((c) => c.value === '视频'));

  const byQ = await m.list({ q: 'B站' });
  assert.deepEqual(byQ.rows.map((r) => r.id), ['bili']);
  assert.equal(byQ.total, 2, 'total 是筛选前的总数，面板才写得对「显示 N / M 条」');
  assert.deepEqual(byQ.facets, all.facets, '可选项不该随搜索词变少');

  const byTag = await m.list({ tag: '工具' });
  assert.deepEqual(byTag.rows.map((r) => r.id), ['bili']);
  const none = await m.list({ q: '根本没有' });
  assert.deepEqual(none.rows, []);
  assert.equal(none.total, 2);
});

test('progress()：初始 idle，安装中能读到 download，收尾不卡在中间阶段', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const m = rig([ENTRY()], { download: async () => { await gate; return 0; } });
  assert.equal((await m.progress()).phase, 'idle');

  const pending = m.install('ai-chat');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal((await m.progress()).phase, 'download', '下载时面板要看到「下载扩展包」');
  assert.equal((await m.progress()).id, 'ai-chat');
  release();
  await pending;
  const done = await m.progress();
  assert.ok(['done', 'failed'].includes(done.phase), '收尾必须是终态');
  assert.equal(done.percent, 100);

  /** 坏 id 也要有终态，进度条不能一直转 */
  const before = await m.install('!bad id');
  assert.equal(before.ok, false);
  assert.equal((await m.progress()).phase, 'failed');
});

test('接线：quick op 传筛选条件 + 进度轮询，面板四项控件都在', () => {
  const host = src('src/host.js');
  assert.ok(host.includes("case 'extensions.market.progress'"), '要有只读进度 op');
  assert.ok(host.includes('q: String(arg?.q'), 'list 要接搜索');
  assert.ok(host.includes('category: String(arg?.category'), 'list 要接分类');
  assert.ok(host.includes('tag: String(arg?.tag'), 'list 要接标签');

  const client = src('client/client.js');
  assert.ok(client.includes("EXT_POST('extensions.market.progress'"), '面板要轮询进度');
  assert.ok(client.includes('搜名字 / id / 描述 / 标签 / 作者'), '要有搜索框');
  assert.ok(client.includes('全部分类'), '要有分类下拉');
  assert.ok(client.includes("只看「${t}」标签"), '标签要可点筛选');
  assert.ok(client.includes('marketProgress.percent'), '要有进度条');
  assert.ok(client.includes('显示 ${(market.rows || []).length} / ${market.total ?? 0} 条'), '要有筛选计数');
});
