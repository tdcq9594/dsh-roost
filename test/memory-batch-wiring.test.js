/**
 * G8 批量复习/改档 op 接线（真 host）：走 quick 通道，验证作用域/上限/写入效果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scopeOfOp } from '../src/ext-quick-scopes.js';

const noop = () => () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-batch-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  const now = Date.now();
  writeFileSync(join(data, 'memory.json'), JSON.stringify({
    global: ['事实甲', '事实乙', '事实丙'],
    chats: {},
    meta: {
      global: {
        事实甲: { w: 1, at: now - 10 * 86400e3, tier: 'short' },
        事实乙: { w: 1, at: now - 10 * 86400e3, tier: 'long' },
        事实丙: { w: 1, at: now - 10 * 86400e3, tier: 'long' },
      },
      chats: {},
    },
    personas: {}, authz: {}, schemaVersion: 2,
  }), 'utf8');
  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17343 }, memory: { capacity: 40 } }), 'utf8');
  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { const off = typeof cb === 'function' ? cb() : null; if (typeof off === 'function') cleanups.push(off); return noop; },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?batch=${Date.now()}-${Math.random()}`);
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
    data,
    quick: (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg }),
    meta: () => JSON.parse(readFileSync(join(data, 'memory.json'), 'utf8')).meta.global,
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('G8 reviewMany：批量刷 reviewedAt，不存在的 id 静默跳过', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('memory.reviewMany', { ids: ['事实甲', '事实乙', '不存在'], scope: 'global' });
  assert.equal(r.ok, true);
  assert.equal(r.done, 2);
  assert.deepEqual(r.failed, ['不存在']);
  assert.ok(b.meta()['事实甲'].reviewedAt > 0, '复习时间写入');
  assert.ok(b.meta()['事实乙'].reviewedAt > 0);
  assert.equal(b.meta()['事实丙'].reviewedAt, undefined, '没点的不受影响');
});

test('G8 tierMany：批量改档，层级白名单生效', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('memory.tierMany', { ids: ['事实甲', '事实乙'], tier: 'core', scope: 'global' });
  assert.equal(r.ok, true);
  assert.equal(r.done, 2);
  assert.equal(b.meta()['事实甲'].tier, 'core');
  assert.equal(b.meta()['事实乙'].tier, 'core');
  const bad = await b.quick('memory.tierMany', { ids: ['事实丙'], tier: 'bogus', scope: 'global' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /short/);
});

test('G8 批量 op 上限 200 + scope 登记 memory:write', async (t) => {
  const b = await boot();
  t.after(b.done);
  const ids = Array.from({ length: 250 }, (_, i) => `假事实${i}`);
  const r = await b.quick('memory.reviewMany', { ids, scope: 'global' });
  assert.equal(r.ok, false, '全是不存在的 id，超过 200 的被截断后仍全失败');
  assert.equal(r.done, 0);
  assert.equal(r.failed.length, 200, '上限 200');
  assert.equal(scopeOfOp('memory.reviewMany').scope, 'memory:write');
  assert.equal(scopeOfOp('memory.tierMany').scope, 'memory:write');
});
