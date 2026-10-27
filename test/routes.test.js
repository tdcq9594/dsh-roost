// 宿主路由级测试：真的把 apply() 跑起来、真的打 /roost/api/*。
//
// 为什么需要这一层：前面那些测试都是纯函数，测不到"接没接上"。
// 上一轮 `journal.clearChat` 就是功能写好了、没人调——纯函数测试全绿，
// 但那条路根本没通。这里专治这一类。
//
// 关键技巧：`ctx.effect` 有 label，第一条是"收消息服务"（会真 bind 端口）。
// 假 ctx 跳过它、只跑第二条（面板接口），于是路由注册了、端口没起。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const noop = () => () => {};

/**
 * 造一个假 ctx 并把 host 跑起来。
 * @param {object} cfgPatch 写进 config.json 的覆盖项
 */
async function bootHost(cfgPatch = {}, seed = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-routes-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfgPatch), 'utf8');
  // 塞几条真实事实，才能区分"关掉了"和"本来就是空的"
  if (seed.memory) {
    writeFileSync(join(dir, 'memory.json'), JSON.stringify(seed.memory), 'utf8');
  }
  // host 里的 dataDir() 读这个环境变量，必须在 import 之前设
  process.env.DSH_ROOST_DATA = dir;

  const routes = new Map();
  const logs = [];
  const fakeCtx = {
    agents: {
      get: () => null,
      create: async () => ({ id: 'a1', ctx: { systemPrompt: { context: noop }, tools: {} } }),
      list: () => [],
    },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's1' }) },
    systemPrompt: { context: () => noop },
    webServer: {
      register: (r) => {
        routes.set(r.path, r.handler);
        return noop;
      },
    },
    config: {},
    logger: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} },
    effect: (cb, label) => {
      // 跳过会 bind 端口的那条，否则测试进程吊着不放
      if (String(label).includes('收消息服务')) return noop;
      const off = cb();
      return typeof off === 'function' ? off : noop;
    },
    on: () => noop,
  };

  // 每次 boot 都重新 import，让 config 缓存跟着新的 DSH_ROOST_DATA 走
  const url = new URL('../src/host.js', import.meta.url);
  url.searchParams.set('t', String(Date.now()) + Math.random());
  const host = await import(url.href);
  const off = host.apply(fakeCtx);

  const call = async (path, { method = 'GET', body = null } = {}) => {
    const handler = routes.get('/roost/api' + path.split('?')[0]);
    if (!handler) throw new Error(`路由没注册：${path}`);
    let out = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(s) {
        out = s;
      },
    };
    const req = {
      url: path,
      method,
      [Symbol.asyncIterator]: async function* () {
        if (body) yield Buffer.from(JSON.stringify(body));
      },
    };
    await handler(req, res);
    return { status: res.statusCode, json: out ? JSON.parse(out) : null };
  };

  return { dir, routes, call, off, logs };
}

test('路由：apply 之后面板接口都在', async () => {
  const { routes, off } = await bootHost();
  for (const p of ['/roost/api/memory', '/roost/api/mind', '/roost/api/journal', '/roost/api/graph',
    '/roost/api/awake', '/roost/api/compact', '/roost/api/channels', '/roost/api/registrations']) {
    assert.ok(routes.has(p), `缺路由 ${p}`);
  }
  off?.();
});

const SEED = { memory: { global: ['主人住在杭州'], chats: { g1: ['这群管张三叫鱼头'] }, personas: {} } };

test('路由：memory.enabled=false 时 /mind 的记忆块是空的', async () => {
  const { call, off } = await bootHost({ memory: { enabled: false } }, SEED);
  const r = await call('/mind');
  assert.equal(r.status, 200);
  assert.equal(r.json.memoryText, '', '关掉记忆就必须一个字都不注入');
  off?.();
});

test('路由：memory.enabled 开着时同一份数据会注入（对照组）', async () => {
  const { call, off } = await bootHost({}, SEED);
  const r = await call('/mind');
  assert.equal(r.status, 200);
  assert.ok(r.json.memoryText.length > 0, '开着就必须注入，否则这个开关测不出东西');
  assert.match(r.json.memoryText, /主人住在杭州/);
  off?.();
});

test('路由：/channels 的能力表说清楚哪些平台没有', async () => {
  const { call, off } = await bootHost();
  const r = await call('/channels');
  assert.equal(r.json.ok, true);
  const caps = r.json.capabilities.qq;
  assert.equal(caps.poke, false);
  assert.equal(caps.stream, 'c2c');
  off?.();
});

test('路由：/compact 给出的阈值跟场景走', async () => {
  const { call, off } = await bootHost();
  const r = await call('/compact');
  assert.equal(r.status, 200);
  // 没有会话时占用读不到，但阈值字段要能看见
  assert.equal(typeof r.json.cfg.atPercentGroup, 'number');
  assert.equal(typeof r.json.cfg.atPercentC2C, 'number');
  off?.();
});

test('路由：/registrations 列出两种接入方式', async () => {
  const { call, off } = await bootHost();
  const r = await call('/registrations');
  assert.deepEqual(r.json.list.map((x) => x.name), ['qr', 'manual']);
  off?.();
});
