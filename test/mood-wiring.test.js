/**
 * 心情接线的集成测试：光测纯函数不够，得确认 host.js 真的挂上了。
 *
 * 跑法：node --test test/mood-wiring.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

async function boot({ effects = false, valence = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-mood-wiring-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  /** host 会起好几个 setInterval，不收 effect 的 off，node --test 永远退不出去 */
  const cleanups = [];
  writeFileSync(join(data, 'config.json'), JSON.stringify({ mood: { effects } }), 'utf8');
  writeFileSync(join(data, 'mood.json'), JSON.stringify({
    valence, energy: 0.5, sociability: 0.5, updatedAt: Date.now(), reasonAt: 0, reason: '',
  }), 'utf8');

  const routes = new Map();
  const contexts = [];
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: {
      context: (def) => { contexts.push(def); return noop; },
    },
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
  const host = await import(`../src/host.js?wiring=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (body) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body); },
    };
    await routes.get('/roost/api/quick')(req, res);
    return res;
  };
  return {
    call, contexts, data, dir,
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
    },
  };
}

test('心情开关已上线：features.get 里能看见，patch 不再被 staged 拒', async (t) => {
  const b = await boot();
  t.after(b.done);
  const { call } = b;
  const all = await call({ op: 'features.get' });
  assert.equal(all.body.ok, true);
  assert.ok(all.body.features.some((f) => f.id === 'moodEffects'));
  /** quick 的参数统一放在 arg 里（host.test.js 同款），放顶层会读成空 id */
  const p = await call({ op: 'features.patch', arg: { id: 'moodEffects', on: true } });
  assert.equal(p.body.ok, true, `patch 被拒：${p.body.message}`);
  assert.equal(p.body.on, true);
});

/**
 * B2/B3 的语气与行为提示组合在 `mood-observe.test.js` / `mood.test.js` 里
 * 用纯函数锁死。情绪块挂在 `mount(agent, chat)` 内，假 ctx 到不了那一层，
 * 这里不伪造一个 mount —— 那只会测到测试自己的脚手架。
 */

test('B4/D3：两个日志入口都能读能清，心情历史清空不动当前心情', async (t) => {
  const b = await boot();
  t.after(b.done);
  const { call } = b;
  const log = await call({ op: 'recall.log', limit: 5 });
  assert.equal(log.body.ok, true);
  assert.ok(Array.isArray(log.body.rows));

  const clear = await call({ op: 'mood.history.clear' });
  assert.equal(clear.body.ok, true);
  assert.match(clear.body.message, /当前心情没动/);
});

test('memory.clear 会连带清掉召回日志（不把排障记录留成第二份档案）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const { call, data } = b;
  /** 先造一条召回日志 */
  const ringFile = join(data, 'recall-log.json');
  writeFileSync(ringFile, JSON.stringify([{ at: Date.now(), chatId: 'g1', shown: 0, items: [] }]), 'utf8');
  const r = await call({ op: 'memory.clear', chatId: 'g1' });
  assert.equal(r.body.ok, true);
  if (existsSync(ringFile)) {
    assert.deepEqual(JSON.parse(readFileSync(ringFile, 'utf8')), []);
  }
});
