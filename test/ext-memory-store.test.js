/**
 * 阶段 4.1 / 门 G4：分文件存储、并发写不丢更新、清空契约与按需候选池。
 *
 * 跑法：node --test test/ext-memory-store.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtMemoryStore, DEFAULT_MAX_ROWS } from '../src/ext-memory-store.js';
import { extMemoryCandidates } from '../src/recall.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-mem-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function make(t, over = {}) {
  const dir = tmpHome(t);
  const warns = [];
  const store = createExtMemoryStore({ dir, log: { warn: (m) => warns.push(m) }, now: () => 1000, ...over });
  return { dir, warns, store };
}

test('G4-1 每扩展一文件、原子写无残留 tmp、字段沿用 fact 形状', async (t) => {
  const { dir, store } = make(t);
  await store.add('bili', { text: '主人喜欢看番', src: 'ext:bili', w: 2 });
  await store.add('douyu', { text: '另一个扩展' });
  const f1 = join(dir, 'ext-memory', 'bili.json');
  assert.equal(fs.existsSync(f1), true);
  assert.equal(fs.existsSync(join(dir, 'ext-memory', 'douyu.json')), true);
  const data = JSON.parse(fs.readFileSync(f1, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.rows[0].text, '主人喜欢看番');
  assert.equal(data.rows[0].w, 2);
  assert.equal(data.rows[0].src, 'ext:bili');
  assert.deepEqual(fs.readdirSync(join(dir, 'ext-memory')).filter((n) => n.startsWith('.')), [], 'rename 后不留点开头暂存文件');
});

test('G4-2 并发写不丢更新：同 extId 20 次并发，20 行全在', async (t) => {
  const { store } = make(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.add('bili', { text: `第 ${i} 条` })));
  const rows = store.list('bili');
  assert.equal(rows.length, 20, `实际 ${rows.length} 行`);
  assert.equal(new Set(rows.map((r) => r.text)).size, 20);
});

test('G4-3 两个写入口并发也不丢：/v1 与模型写各 10 次', async (t) => {
  const { store } = make(t);
  const api = Array.from({ length: 10 }, (_, i) => store.add('bili', { text: `api-${i}` }));
  const tool = Array.from({ length: 10 }, (_, i) => store.add('bili', { text: `tool-${i}` }));
  await Promise.all([...api, ...tool]);
  assert.equal(store.list('bili').length, 20);
});

test('G4-4 去重按同 extId 同正文，命中 w+1；空文本不写', async (t) => {
  const { store } = make(t);
  await store.add('bili', { text: '同一句' });
  const again = await store.add('bili', { text: '同一句' });
  assert.equal(again.deduped, true);
  assert.equal(store.list('bili').length, 1);
  assert.equal(store.list('bili')[0].w, 2);
  assert.equal((await store.add('bili', { text: '   ' })).ok, false);
});

test('G4-5 读坏 fail-open：不抛、按空处理、记 warn', async (t) => {
  const { dir, warns, store } = make(t);
  await store.add('bili', { text: 'x' });
  fs.writeFileSync(join(dir, 'ext-memory', 'bili.json'), '{ 坏 JSON', 'utf8');
  assert.deepEqual(store.list('bili'), []);
  assert.ok(warns.some((m) => m.includes('读坏')));
});

test('G4-6 maxRows 按 w 淘汰、默认 200；单文件上限不越界', async (t) => {
  const { store } = make(t);
  await store.setMeta('bili', { maxRows: 3 });
  for (let i = 0; i < 6; i++) await store.add('bili', { text: `r${i}`, w: i });
  const rows = store.list('bili');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.text).sort(), ['r3', 'r4', 'r5'], '保留高权重');
  assert.equal(DEFAULT_MAX_ROWS, 200);
});

test('G4-7 expire 标 expiredBy、archivedAt 不参与检索', async (t) => {
  const { dir, store } = make(t, { now: () => 5000 });
  await store.add('bili', { text: '会过期', until: 2000 });
  await store.add('bili', { text: '长期' });
  const r = await store.expire(5000);
  assert.equal(r.expired, 1);
  assert.deepEqual(store.list('bili').map((x) => x.text), ['长期']);
  const raw = JSON.parse(fs.readFileSync(join(dir, 'ext-memory', 'bili.json'), 'utf8'));
  assert.equal(raw.rows.find((x) => x.text === '会过期').expiredBy, 'expire');
  await store.archive('bili');
  assert.deepEqual(store.list('bili'), []);
  assert.equal(store.listAll({ includeArchived: true })[0].rows.length, 1);
});

test('G4-8 clearAll 尊重 onClear：默认 keep 保留，设 clear 才删', async (t) => {
  const { dir, store } = make(t);
  await store.add('bili', { text: 'a' });
  await store.add('douyu', { text: 'b' });
  await store.setMeta('douyu', { onClear: 'clear' });
  const r = await store.clearAll({ respectOnClear: true });
  assert.deepEqual({ cleared: r.cleared, kept: r.kept }, { cleared: 1, kept: 1 });
  assert.equal(fs.existsSync(join(dir, 'ext-memory', 'bili.json')), true);
  assert.equal(fs.existsSync(join(dir, 'ext-memory', 'douyu.json')), false);
  assert.equal(store.clear('bili') instanceof Promise, true);
  await store.clear('bili');
  assert.equal(store.stats().bili, undefined);
});

test('G4-9 stats 给面板条数 / 字节 / onClear；remove 按条件删', async (t) => {
  const { store } = make(t);
  await store.add('bili', { text: 'a' });
  await store.add('bili', { text: 'b' });
  const s = store.stats().bili;
  assert.equal(s.rows, 2);
  assert.ok(s.bytes > 0);
  assert.equal(s.onClear, 'keep');
  const r = await store.remove('bili', (row) => row.text === 'a');
  assert.equal(r.removed, 1);
  assert.deepEqual(store.list('bili').map((x) => x.text), ['b']);
});

test('G4-10 候选池：默认只搜可见命名空间，all:true 才全搜，命中带 [extId]', async (t) => {
  const { store } = make(t);
  await store.add('bili', { text: '番剧 更新 提醒' });
  await store.add('douyu', { text: '番剧 直播 记录' });
  const visible = extMemoryCandidates(store, { query: '番剧', visibleExtIds: ['bili'] });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].extId, 'bili');
  assert.match(visible[0].text, /^\[bili\]/);
  assert.equal(extMemoryCandidates(store, { query: '番剧', all: true }).length, 2);
  assert.equal(extMemoryCandidates(store, { query: '番剧', all: true, visibleExtIds: ['bili'] }).length, 1,
    'all 只放宽范围，不能跳过 ACL 可见集');
  assert.equal(extMemoryCandidates(store, { query: '番剧', extId: 'douyu', all: true }).length, 1);
  assert.deepEqual(extMemoryCandidates(store, { query: '' }), []);
});

test('G4-11 listRanked 不读 ext-memory/：静态约束 + 候选池按需', (t) => {
  const memorySrc = fs.readFileSync(new URL('../src/memory.js', import.meta.url), 'utf8');
  assert.ok(!memorySrc.includes('ext-memory'), 'memory.js 不得引用 ext-memory 目录');
  const recallSrc = fs.readFileSync(new URL('../src/recall.js', import.meta.url), 'utf8');
  assert.ok(recallSrc.includes('extMemoryCandidates'), '按需候选池必须落在 recall.js');
  let reads = 0;
  const fake = { listAll: () => { reads++; return []; } };
  assert.equal(reads, 0, '不调用就不读盘（不参与自动注入）');
  extMemoryCandidates(fake, { query: 'x' });
  assert.equal(reads, 1);
});
