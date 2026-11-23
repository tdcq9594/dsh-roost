/**
 * 3.4 接线测试：memory.vector.status 在真 host 里能跑通。
 * 阶段1 教训——纯函数单测过 ≠ host 作用域过（config is not defined）。
 * 这里实际 boot host、走 quick 通道，钉住新 op 不报作用域错、返回结构对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-vecstat-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17329 } }), 'utf8');
  const routes = new Map();
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
  const host = await import(`../src/host.js?vs=${Date.now()}-${Math.random()}`);
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

test('quick(memory.vector.status) 真 host 跑通，默认向量未启用', async () => {
  const b = await boot();
  try {
    const r = await b.quick('memory.vector.status');
    assert.equal(r.ok, true, `op 返回失败：${r.message}`);
    assert.equal(r.vector.enabled, false);
    assert.equal(r.vector.mode, 'off');
    assert.equal(r.rerank.mode, 'off');
    assert.match(r.summary, /纯关键词/);
    assert.ok(Array.isArray(r.warnings));
  } finally {
    b.done();
  }
});

test('/memory/recall-preview 返回结构化 projection（对齐对面 assoc/preview）', async () => {
  const b = await boot();
  try {
    const r = await b.call('/roost/api/memory/recall-preview', { text: '随便一句话', chatId: '' });
    assert.equal(r.ok, true, `预览失败：${r.message}`);
    assert.ok(r.projection, '缺结构化投影字段');
    assert.ok(Array.isArray(r.projection.items));
    assert.ok(r.projection.counts && 'direct' in r.projection.counts && 'hop1' in r.projection.counts);
    assert.equal(r.projection.counts.direct + r.projection.counts.hop1, r.projection.items.length);
  } finally {
    b.done();
  }
});

test('scopeOfOp 认得 memory.vector.status（fail-closed 不误伤）', async () => {
  const { scopeOfOp } = await import('../src/ext-quick-scopes.js');
  const s = scopeOfOp('memory.vector.status');
  assert.equal(s.ok, true);
  assert.equal(s.scope, 'state:read');
});
