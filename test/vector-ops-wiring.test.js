/**
 * G2 接线测试：memory.vector.test / rebuild 真挂在 host 上，无模型时明确报错（不静默），
 * status 带 indexed/total 索引进度，scope 登记正确。
 * 阶段1 教训——纯函数单测过 ≠ host 作用域过，这里真 boot + quick 通道。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scopeOfOp } from '../src/ext-quick-scopes.js';

const noop = () => () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-vecops-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17351 } }), 'utf8');
  writeFileSync(join(data, 'memory.json'), JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} }, personas: {}, authz: {} }), 'utf8');
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
  const host = await import(`../src/host.js?vo=${Date.now()}-${Math.random()}`);
  host.apply(ctx);
  const call = async (path, body) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = JSON.parse(s); } };
    const req = { method: 'POST', url: path, headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res.body;
  };
  return {
    quick: (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg }),
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
    },
  };
}

test('memory.vector.status 带 indexed/total 索引进度（真 host）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('memory.vector.status', {});
  assert.equal(r.ok, true, r.message);
  assert.equal(r.vector.enabled, false, '默认关');
  assert.ok(Number.isFinite(r.vector.indexed), 'indexed 是数字');
  assert.ok(Number.isFinite(r.vector.total), 'total 是数字');
  assert.ok(Number.isFinite(r.vector.dims), 'dims 字段存在');
});

test('memory.vector.test 无模型时明确报错，不静默', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('memory.vector.test', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /向量没启用|没就绪|测试不了/);
});

test('memory.vector.rebuild 无模型时明确报错，不静默', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('memory.vector.rebuild', {});
  assert.equal(r.ok, false);
  assert.match(r.message, /向量没启用|没就绪|无法重建/);
});

test('scope 登记：test 只读、rebuild 写（fail-closed）', () => {
  assert.equal(scopeOfOp('memory.vector.status').scope, 'state:read');
  assert.equal(scopeOfOp('memory.vector.test').scope, 'state:read');
  assert.equal(scopeOfOp('memory.vector.rebuild').scope, 'memory:write');
});
