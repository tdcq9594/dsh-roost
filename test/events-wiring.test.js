/**
 * D8 接线的集成测试：确认 host.js 真的把事件层挂上了。
 *
 * 注入内容本身在 events.test.js 用纯函数锁死；这里盯的是「开关能开、
 * 面板能看、能清、清记忆时不会把经历留在盘上」四件事。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

async function boot({ enabled = false, seed = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-events-wiring-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({ events: { enabled } }), 'utf8');
  writeFileSync(join(data, 'events.json'), JSON.stringify(seed), 'utf8');

  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = typeof cb === 'function' ? cb() : null;
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?events=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body, method = 'POST') => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      method,
      url: path,
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); },
    };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res;
  };
  const quick = (op, arg) => call('/roost/api/quick', { op, arg });
  const file = join(data, 'events.json');
  return {
    quick, call, file, data,
    read: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
    },
  };
}

const freshRow = () => ({ at: Date.now(), kind: 'proactive', scene: 'c2c', chatId: '', count: 1 });

test('D8：开关已上线 —— 能力页看得见，patch 不再被 staged 拒', async (t) => {
  const b = await boot();
  t.after(b.done);
  const all = await b.quick('features.get');
  assert.equal(all.body.ok, true);
  assert.ok(all.body.features.some((f) => f.id === 'events'));
  const p = await b.quick('features.patch', { id: 'events', on: true });
  assert.equal(p.body.ok, true, `patch 被拒：${p.body.message}`);
  assert.equal(p.body.on, true);
});

test('D8：/memory 返回可查看的经历，关着也能看（旧数据才清得掉）', async (t) => {
  const b = await boot({ seed: [freshRow()] });
  t.after(b.done);
  const r = await b.call('/roost/api/memory', null, 'GET');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(r.body.eventsEnabled, false);
  assert.equal(r.body.events.length, 1);
  assert.equal(r.body.events[0].label, '主动找过你');
  assert.equal(r.body.events[0].where, '私聊');
  assert.ok(!('text' in r.body.events[0]), '面板数据里不该带正文');
});

test('D8：独立清空入口能清盘；memory.clear 也连带清', async (t) => {
  const one = await boot({ enabled: true, seed: [freshRow()] });
  t.after(one.done);
  const r = await one.quick('events.clear');
  assert.equal(r.body.ok, true);
  assert.deepEqual(one.read(), [], 'events.json 真的空了');

  const two = await boot({ enabled: true, seed: [freshRow(), freshRow()] });
  t.after(two.done);
  const c = await two.call('/roost/api/quick', { op: 'memory.clear', chatId: 'g1' });
  assert.equal(c.body.ok, true, c.body.message);
  assert.deepEqual(two.read(), [], '清记忆不把经历留成第二份档案');
});
