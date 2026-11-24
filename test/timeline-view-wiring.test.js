/**
 * G4 接线测试：memory.timeline 在真 host 里能跑通（阶段1 教训——纯函数过≠host 作用域过）。
 * seed journal 的 digest 行 + impressions，走 quick 通道验证数据源/facets/分页/scope/审计排除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../src/journal.js';
import { scopeOfOp } from '../src/ext-quick-scopes.js';

const noop = () => () => {};
const NOW = Date.now();

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-timeline-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];

  // digest 两群 + 一条普通 chat 行（不该进时间轴）
  const j = createJournal({ file: join(data, 'journal.sqlite'), log: noop });
  j.add({ id: 'd1', at: NOW - 3000, day: '2026-11-20', chatId: 'g1', role: 'digest', kind: 'digest', level: 'important', text: '群里聊了量子力学' });
  j.add({ id: 'd2', at: NOW - 2000, day: '2026-11-19', chatId: 'g2', role: 'digest', kind: 'digest', level: 'important', text: '群里看了电影' });
  j.add({ id: 'd3', at: NOW - 1000, day: '2026-11-18', chatId: 'g1', role: 'digest', kind: 'digest', level: 'important', text: '聊了养猫' });
  j.add({ id: 'chat1', at: NOW, day: '2026-11-21', chatId: 'g1', role: 'user', kind: 'chat', level: 'normal', text: '普通对话不该进时间轴' });
  j.close();

  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17337 }, memory: {} }), 'utf8');
  writeFileSync(join(data, 'memory.json'), JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} }, personas: {}, authz: {} }), 'utf8');
  writeFileSync(join(data, 'impressions.json'), JSON.stringify({
    imps: [
      { id: 'imp:1', text: '对方很细心', at: NOW - 2500, chatId: 'g1', hits: 1, crystallizedAt: 0, sourceKey: 'gist:g1' },
      { id: 'imp:2', text: '已结晶的旧印象', at: NOW - 4000, chatId: 'g2', hits: 3, crystallizedAt: NOW - 100, sourceKey: 'gist:g2' },
    ],
    done: {},
  }), 'utf8');

  const routes = new Map();
  const auditWrites = [];
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { const off = typeof cb === 'function' ? cb() : null; if (typeof off === 'function') cleanups.push(off); return noop; },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?tl=${Date.now()}-${Math.random()}`);
  host.apply(ctx);
  const call = async (path, body, method = 'POST') => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = JSON.parse(s); } };
    const req = { method, url: path, headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res.body;
  };
  return {
    data,
    quick: (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg }),
    call,
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('quick(memory.timeline)：digest + 未结晶印象进轴，普通 chat 行/已结晶印象排除', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('memory.timeline', {});
  assert.equal(r.ok, true, `op 返回失败：${r.message}`);
  // 按 at 降序：d3(NOW-1s) > d2(NOW-2s) > imp:1(NOW-2.5s) > d1(NOW-3s)
  assert.deepEqual(r.list.map((x) => x.id), ['d3', 'd2', 'imp:1', 'd1']);
  assert.equal(r.total, 4);
  assert.equal(r.hasMore, false);
  assert.ok(!r.list.some((x) => x.id === 'chat1'), '普通对话不进时间轴');
  assert.ok(!r.list.some((x) => x.id === 'imp:2'), '已结晶印象不进时间轴');
});

test('quick(memory.timeline)：过滤 + facets 基于完整轴 + 分页', async (t) => {
  const b = await boot();
  t.after(b.done);
  const g1 = await b.quick('memory.timeline', { chatId: 'g1' });
  assert.deepEqual(g1.list.map((x) => x.id), ['d3', 'imp:1', 'd1']);
  assert.deepEqual(g1.facets.chats, ['g1', 'g2'], '选 g1 后 g2 仍在 facets 选项里');
  const paged = await b.quick('memory.timeline', { limit: 2, offset: 1 });
  assert.deepEqual(paged.list.map((x) => x.id), ['d2', 'imp:1']);
  assert.equal(paged.total, 4);
  assert.equal(paged.hasMore, true);
  const byKind = await b.quick('memory.timeline', { kind: 'digest' });
  assert.deepEqual(byKind.list.map((x) => x.id), ['d3', 'd2', 'd1']);
});

test('quick(memory.timeline)：纯读不写盘（文件字节不变）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const before = readFileSync(join(b.data, 'impressions.json'), 'utf8');
  const r = await b.quick('memory.timeline', { q: '猫' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.list.map((x) => x.id), ['d3']);
  assert.equal(readFileSync(join(b.data, 'impressions.json'), 'utf8'), before, '读时间轴不改印象文件');
});

test('scope + 审计：memory.timeline = state:read 且排除审计噪音', () => {
  assert.equal(scopeOfOp('memory.timeline')?.scope, 'state:read');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(host, /&& op !== 'memory\.timeline'\)/, 'memory.timeline 在审计排除列表里');
});
