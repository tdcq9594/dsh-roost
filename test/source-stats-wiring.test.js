/**
 * G10 来源统计接线测试：确认 stats.sources 真挂在 host 上、
 * 读得到扩展记忆的 src 分组、纯读不写盘、scope 登记且排除审计噪音。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scopeOfOp } from '../src/ext-quick-scopes.js';

const noop = () => {};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-srcstat-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];

  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17341 }, memory: {} }), 'utf8');
  writeFileSync(join(data, 'memory.json'), JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} }, personas: {}, authz: {} }), 'utf8');
  // seed 两个扩展记忆文件：bili 两条 src=ext:bili，song 一条无 src（用 extId 兜底）
  mkdirSync(join(data, 'ext-memory'), { recursive: true });
  writeFileSync(join(data, 'ext-memory', 'bili.json'), JSON.stringify({
    version: 1, rows: [
      { text: '看了个视频', src: 'ext:bili', w: 1, at: 1000, until: 0, expiredBy: '' },
      { text: '又看一个', src: 'ext:bili', w: 1, at: 2000, until: 0, expiredBy: '' },
    ], meta: {},
  }), 'utf8');
  writeFileSync(join(data, 'ext-memory', 'song.json'), JSON.stringify({
    version: 1, rows: [{ text: '唱了首歌', w: 1, at: 3000, until: 0, expiredBy: '' }], meta: {},
  }), 'utf8');

  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { if (typeof cb === 'function') { const off = cb(); if (typeof off === 'function') cleanups.push(off); } return noop; },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?srcstat=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = JSON.parse(s); } };
    const req = { method: 'POST', url: path, headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res.body;
  };
  const quick = (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg });
  return {
    quick, data,
    extFiles: () => [readFileSync(join(data, 'ext-memory', 'bili.json'), 'utf8'), readFileSync(join(data, 'ext-memory', 'song.json'), 'utf8')],
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('stats.sources 真 host 返回按来源分组的统计（含扩展记忆）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('stats.sources', {});
  assert.equal(r.ok, true, r.message);
  assert.match(r.note, /不是社交平台来源/);
  const bili = r.sources.find((x) => x.source === 'ext:bili');
  assert.ok(bili, '有 ext:bili 来源');
  assert.equal(bili.extFacts, 2);
  assert.equal(bili.total, 2);
  const song = r.sources.find((x) => x.source === 'ext:song');
  assert.equal(song.extFacts, 1, '无 src 的用 extId 兜底');
});

test('stats.sources 纯读不写盘', async (t) => {
  const b = await boot();
  t.after(b.done);
  const before = b.extFiles();
  await b.quick('stats.sources', {});
  assert.deepEqual(b.extFiles(), before, '扩展记忆文件一个字节未动');
});

test('scope 登记：stats.sources = state:read', () => {
  assert.equal(scopeOfOp('stats.sources').scope, 'state:read');
});

test('审计排除：stats.sources 纯读不写审计噪音', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const m = src.match(/if \(op && op !== 'memory\.list'[\s\S]*?\) audit\(\{ op,/);
  assert.ok(m, '找到审计条件');
  assert.match(m[0], /op !== 'stats\.sources'/, '纯读来源统计排除审计');
});
