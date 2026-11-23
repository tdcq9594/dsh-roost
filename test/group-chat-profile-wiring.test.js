/**
 * 阶段6 接线测试：chatprofile.save/clear 在真 host 跑通 + memory 快照带出群印象。
 * 钉住阶段1 的 config 作用域错同类问题 + scope fail-closed。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-chatp-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17333 } }), 'utf8');
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
  const host = await import(`../src/host.js?cp=${Date.now()}-${Math.random()}`);
  host.apply(ctx);
  const call = async (path, body, method = 'POST') => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = JSON.parse(s); } };
    const req = { method, url: path, headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const h = routes.get(path) || routes.get(path.split('?')[0]);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res.body;
  };
  return {
    quick: (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg }),
    call,
    chatProfiles: () => {
      try { return JSON.parse(readFileSync(join(data, 'chat-profiles.json'), 'utf8')); } catch { return []; }
    },
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('quick(chatprofile.save/clear) 真 host 跑通', async () => {
  const b = await boot();
  try {
    let r = await b.quick('chatprofile.save', { chatId: 'g1', vibe: '热闹', topics: '聊球', impression: '友善' });
    assert.equal(r.ok, true, `保存失败：${r.message}`);
    assert.equal(b.chatProfiles()[0].vibe, '热闹');
    r = await b.quick('chatprofile.clear', { chatId: 'g1' });
    assert.equal(r.ok, true);
    assert.equal(b.chatProfiles().length, 0);
  } finally { b.done(); }
});

test('memory 快照带出 chatProfiles', async () => {
  const b = await boot();
  try {
    await b.quick('chatprofile.save', { chatId: 'g1', vibe: '安静' });
    const r = await b.call('/roost/api/memory?chatId=', null, 'GET');
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.chatProfiles));
    assert.equal(r.chatProfiles[0].chatId, 'g1');
    assert.equal(r.chatProfiles[0].vibe, '安静');
  } finally { b.done(); }
});

test('scopeOfOp 认得两个新 op（fail-closed）', async () => {
  const { scopeOfOp } = await import('../src/ext-quick-scopes.js');
  for (const op of ['chatprofile.save', 'chatprofile.clear']) {
    const s = scopeOfOp(op);
    assert.equal(s.ok, true, `${op} 没登记 scope`);
    assert.equal(s.scope, 'prompt:write');
  }
});
