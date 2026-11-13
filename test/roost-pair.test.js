// 一键直连：全程走 Roost 面板 API，不碰它的配置文件。
//
// 重点验三件事：
//   1. 密钥**由插件生成**，不许用户手填（也不会每次配对都换一个把在用的客户端踢掉）
//   2. 端口从返回的 `state.port` 读，不按公式自己算（端口被占时框架会顺延）
//   3. 失败要说清卡在哪一步（`step`），面板据此给不同的下一步

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPairing } from '../src/roost-pair.js';

/** 假服务端「生成」出来的密钥。真实实现是 `randomUUID()` 去掉横线 */
const SERVER_TOKEN = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const OWN_TOKEN = 'old-token-1234567890abcdef';

/**
 * 假 setup：只实现 pairing 用到的两个方法。
 *
 * `host` 覆盖 GET /api/host 的返回，`put` 覆盖 PUT 的返回。
 */
function fakeSetup({ installed = true, running = true, host = {}, put = {} } = {}) {
  const calls = [];
  const base = {
    cfg: { enabled: false, port: 0, tokenSet: false, token: '', scopes: ['read', 'message'] },
    deps: { ready: true, missing: [] },
    state: { state: 'idle', port: 0 },
  };
  return {
    calls,
    async detect() {
      return { installed, running, version: '1.0.14' };
    },
    async api(path, init = {}) {
      const method = init.method || 'GET';
      calls.push([path, method, init.body ? JSON.parse(init.body) : null]);
      if (path === '/api/host' && method === 'GET') {
        return { ...base, ...host, cfg: { ...base.cfg, ...(host.cfg || {}) }, deps: { ...base.deps, ...(host.deps || {}) } };
      }
      if (path === '/api/onebot/deps/install') return { ok: true };
      if (path === '/api/host' && method === 'PUT') {
        const body = init.body ? JSON.parse(init.body) : {};
        /**
         * 真实行为：`token: 'auto'` 时服务端生成，**只在这个响应里回传一次**。
         * `GET` 那边永远不回传明文（测试里也照实不返回）。
         */
        return {
          ok: true,
          state: { state: 'running', port: 6801 },
          ...(body.token === 'auto' ? { token: SERVER_TOKEN } : {}),
          ...put,
        };
      }
      throw new Error(`没预料到的请求：${method} ${path}`);
    },
  };
}

const CFG = () => ({
  roostHost: { vision: true, decide: { mode: 'ai' }, merge: { waitSec: 2 } },
  channel: { current: 'qq' },
});

test('探测：没装 Roost 时如实说，不抛错（面板一打开就调它）', async () => {
  const p = createPairing({ setup: fakeSetup({ installed: false }), cfgOf: () => ({}), setCfg: () => {} });
  const r = await p.inspect();
  assert.equal(r.ok, true);
  assert.equal(r.step, 'no-roost');
  assert.match(r.text, /还没装 Roost/);
});

test('探测：装了但没跑，指向启动那一步', async () => {
  const p = createPairing({ setup: fakeSetup({ running: false }), cfgOf: () => ({}), setCfg: () => {} });
  const r = await p.inspect();
  assert.equal(r.step, 'no-run');
});

test('探测：协议开着但这边没配对，能分辨出来', async () => {
  const setup = fakeSetup({ host: { cfg: { enabled: true, tokenSet: true } } });
  const p = createPairing({ setup, cfgOf: CFG, setCfg: () => {} });
  const r = await p.inspect();
  assert.equal(r.step, 'no-self');
});

test('一键：由服务端生成密钥、开监听，并把地址写回自己的配置', async () => {
  const setup = fakeSetup();
  let saved = null;
  const p = createPairing({ setup, cfgOf: CFG, setCfg: (patch) => { saved = patch; } });

  const r = await p.enable();
  assert.equal(r.ok, true);
  assert.equal(r.port, 6801, '端口从 state 里读，不是自己按公式算');
  assert.equal(r.url, 'http://127.0.0.1:6801');
  assert.equal(r.token, SERVER_TOKEN, '密钥由服务端生成，明文只在这次响应里出现');

  const put = setup.calls.find((c) => c[0] === '/api/host' && c[1] === 'PUT');
  assert.equal(put[2].enabled, true);
  assert.equal(put[2].token, 'auto', '只说「给我一个」，明文不经过客户端的请求体');
  assert.deepEqual(put[2].scopes, ['read', 'message'], '默认能收能发，但不给改配置的权限');
  assert.equal(put[2].port, 0, '端口交给框架按 botId 分配');

  assert.equal(saved.roostHost.url, 'http://127.0.0.1:6801');
  assert.equal(saved.roostHost.token, SERVER_TOKEN, '存下来的就是服务端回传那个');
  assert.equal(saved.roostHost.enabled, true);
  assert.equal(saved.channel.current, 'roost', '两个开关一起写，别出现「收得到发不出」');
  assert.equal(saved.roostHost.decide.mode, 'ai', '浅合并也不能把 decide 冲掉');
  assert.equal(saved.roostHost.merge.waitSec, 2);
});

test('一键：GET 拿不到明文时，沿用自己配置里那份（别把在用的客户端踢下线）', async () => {
  const setup = fakeSetup();
  const p = createPairing({
    setup,
    /** 注意：`GET /api/host` 不再回 token，所以「沿用」只能靠本插件自己存的那份 */
    cfgOf: () => ({ roostHost: { token: OWN_TOKEN }, channel: { current: 'qq' } }),
    setCfg: () => {},
  });
  const r = await p.enable();
  assert.equal(r.token, OWN_TOKEN);
  const put = setup.calls.find((c) => c[0] === '/api/host' && c[1] === 'PUT');
  assert.equal(put[2].token, OWN_TOKEN, '沿用就别让服务端再生成，否则在用的客户端全掉线');
});

test('一键：框架缺 ws 也不装依赖，直接开监听（我们只读 SSE）', async () => {
  /**
   * 我们走 POST /rpc + GET /events（SSE），Node 22 自带 fetch 就够，
   * 一个依赖都不需要。框架的 /ws 是给别的客户端用的可选通道——
   * 为了它去拉 ws，等于让我们替别人的通道付成本。
   */
  const setup = fakeSetup({ host: { deps: { ready: false, missing: ['ws'] } } });
  const p = createPairing({ setup, cfgOf: CFG, setCfg: () => {} });
  await p.enable();
  assert.equal(
    setup.calls.some((c) => c[0] === '/api/onebot/deps/install'),
    false,
    '不该再为 /ws 去装 ws',
  );
  const put = setup.calls.find((c) => c[0] === '/api/host' && c[1] === 'PUT');
  assert.ok(put, '缺 ws 也必须照常开监听');
  assert.equal(put[2].enabled, true);
});

test('一键：顺带准备 ws，复用框架那份时不重复安装', async () => {
  const setup = fakeSetup();
  let called = 0;
  const p = createPairing({
    setup, cfgOf: CFG, setCfg: () => {},
    ensureWs: async () => { called += 1; return { ok: true, mode: 'reuse', version: '8.18.0' }; },
  });
  const r = await p.enable();
  assert.equal(called, 1, '一键直连要顺带准备一次');
  assert.equal(r.ws.mode, 'reuse');
  assert.equal(
    setup.calls.some((c) => c[0] === '/api/onebot/deps/install'),
    false,
    '不该去动框架的依赖',
  );
});

test('一键：ws 装失败也照样连上，只是事件走 SSE', async () => {
  const setup = fakeSetup();
  const p = createPairing({
    setup, cfgOf: CFG, setCfg: () => {},
    ensureWs: async () => { throw new Error('没网'); },
  });
  const r = await p.enable();
  assert.equal(r.ok, true, '依赖装不上不能阻塞配对');
  assert.equal(r.ws.ok, false);
  assert.equal(r.ws.mode, 'failed');
  assert.match(r.ws.message, /没网/);
  assert.ok(r.url, '该配好的还是配好了');
});

test('一键：没给 ensureWs 也不报错（纯 SSE 环境）', async () => {
  const p = createPairing({ setup: fakeSetup(), cfgOf: CFG, setCfg: () => {} });
  const r = await p.enable();
  assert.equal(r.ok, true);
  assert.equal(r.ws, null);
});

test('一键：rotate 时强制换新密钥，旧的立刻失效', async () => {
  const setup = fakeSetup();
  const p = createPairing({
    setup,
    cfgOf: () => ({ roostHost: { token: OWN_TOKEN }, channel: { current: 'qq' } }),
    setCfg: () => {},
  });
  const r = await p.enable({ rotate: true });
  assert.notEqual(r.token, OWN_TOKEN, 'rotate 就是要换掉它');
  assert.equal(r.token, SERVER_TOKEN);
  const put = setup.calls.find((c) => c[0] === '/api/host' && c[1] === 'PUT');
  assert.equal(put[2].token, 'auto', '换新也是让服务端生成');
});

test('一键：Roost 没在跑就明确拒绝，一个字都不往配置里写', async () => {
  const p = createPairing({
    setup: fakeSetup({ running: false }),
    cfgOf: CFG,
    setCfg: () => { throw new Error('不该写配置'); },
  });
  await assert.rejects(() => p.enable(), (e) => e.step === 'no-run');
});

test('一键：拿不到端口时报清楚，而不是给一个连不上的地址', async () => {
  const setup = fakeSetup({ put: { state: { state: 'running', port: 0 } } });
  let wrote = 0;
  const p = createPairing({ setup, cfgOf: CFG, setCfg: () => { wrote += 1; } });
  await assert.rejects(() => p.enable(), /拿不到监听端口/);
  assert.equal(wrote, 0, '没端口就别写配置，否则会去连一个没人听的端口');
});

test('关掉：通道恒为 roost（不能切回已移除的 qq），地址和密钥保留', async () => {
  const setup = fakeSetup();
  let saved = null;
  const p = createPairing({
    setup,
    cfgOf: () => ({
      roostHost: { enabled: true, url: 'http://127.0.0.1:6801', token: 'tk-1234567890abcdef' },
      channel: { current: 'roost' },
    }),
    setCfg: (patch) => { saved = patch; },
  });
  const r = await p.disable();
  assert.equal(r.ok, true);
  assert.equal(saved.roostHost.enabled, false);
  assert.equal(saved.roostHost.url, 'http://127.0.0.1:6801', '下次再开不用重新配对');
  assert.equal(saved.channel.current, 'roost', '不能把通道写回已移除的 qq 实现');
  const put = setup.calls.find((c) => c[0] === '/api/host' && c[1] === 'PUT');
  assert.equal(put[2].enabled, false);
});

test('关掉：Roost 面板连不上也要把本地开关关掉（否则本地以为还在直连）', async () => {
  const setup = {
    async detect() { return { installed: true, running: true }; },
    async api() { throw new Error('面板没响应'); },
  };
  let saved = null;
  const p = createPairing({
    setup,
    cfgOf: () => ({ roostHost: { enabled: true }, channel: { current: 'roost' } }),
    setCfg: (patch) => { saved = patch; },
  });
  const r = await p.disable();
  assert.ok(r.warning, '要说清对面没关成');
  assert.equal(saved.roostHost.enabled, false);
});

test('测一下：地址能连上就报往返耗时', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/health') {
      res.end(JSON.stringify({ app: 'roost-host', ok: true, connections: 1 }));
      return;
    }
    res.end(JSON.stringify({ id: 'pair-test', ok: true, data: { pong: Date.now() } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const p = createPairing({
      setup: fakeSetup(),
      cfgOf: () => ({ roostHost: { url: `http://127.0.0.1:${port}`, token: 'tk' } }),
      setCfg: () => {},
    });
    const r = await p.test();
    assert.equal(r.ok, true);
    assert.ok(r.ms >= 0);
    assert.deepEqual(r.stream, { ok: true, connections: 1 }, '订阅数要带出来，面板才知道事件流通没通');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/**
 * 「向导全绿、消息进不来」的回归：RPC 通 ≠ 事件流订阅上了。
 *
 * `system.ping` 走 HTTP `/rpc`，消息走 `/events` / `/ws` 长连接，两条路完全独立。
 * 2026-11-13 实机就卡在这里：ping 绿、`connections` 恒 0，测试却报通。
 */
test('测一下：ping 通但事件流没订阅（connections=0）要如实标出来', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/health') {
      res.end(JSON.stringify({ app: 'roost-host', ok: true, connections: 0 }));
      return;
    }
    res.end(JSON.stringify({ id: 'pair-test', ok: true, data: { pong: 1 } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const p = createPairing({
      setup: fakeSetup(),
      cfgOf: () => ({ roostHost: { url: `http://127.0.0.1:${port}`, token: 'tk' } }),
      setCfg: () => {},
    });
    const r = await p.test();
    assert.equal(r.ok, true, 'RPC 确实通了，这一项不能判失败');
    assert.deepEqual(r.stream, { ok: false, connections: 0 });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/** 老框架没有 `/health`：给 `null`（自检不了），不能假装通过、也不能报错 */
test('测一下：没有 /health 的旧框架 → stream 为 null，不假装通过', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(404).end('nope'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'pair-test', ok: true, data: { pong: 1 } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const p = createPairing({
      setup: fakeSetup(),
      cfgOf: () => ({ roostHost: { url: `http://127.0.0.1:${port}` } }),
      setCfg: () => {},
    });
    const r = await p.test();
    assert.equal(r.ok, true);
    assert.equal(r.stream, null);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('测一下：没配地址时直接说清楚', async () => {
  const p = createPairing({ setup: fakeSetup(), cfgOf: () => ({ roostHost: {} }), setCfg: () => {} });
  await assert.rejects(() => p.test(), /还没配对/);
});

/* ------------------------------------------------------------------ */
/* 版本兼容：旧版没有 /api/host                                        */
/* ------------------------------------------------------------------ */

const legacySetup = () => ({
  async detect() { return { installed: true, running: true, version: '1.0.14' }; },
  async api() { throw Object.assign(new Error('接口不存在'), { status: 404 }); },
});

test('探测：旧版 Roost 要报「该升级」，不能报成「连不上面板」', async () => {
  const p = createPairing({ setup: legacySetup(), cfgOf: () => ({}), setCfg: () => {} });
  const r = await p.inspect();
  assert.equal(r.step, 'old-roost');
  assert.equal(r.legacy, true);
  assert.match(r.text, /更新到最新版/);
  assert.doesNotMatch(r.text, /连不上/);
});

test('一键：旧版上点直连，报版本问题而不是网络问题', async () => {
  let wrote = 0;
  const p = createPairing({ setup: legacySetup(), cfgOf: () => ({}), setCfg: () => { wrote += 1; } });
  await assert.rejects(
    () => p.enable(),
    (e) => e.step === 'old-roost' && /更新到最新版/.test(e.message) && /1\.0\.14/.test(e.message),
  );
  assert.equal(wrote, 0, '版本不对时一个字都不该往配置里写');
});

test('探测：真连不上（非 404）仍然报网络，别把网络问题说成版本问题', async () => {
  const setup = {
    async detect() { return { installed: true, running: true }; },
    async api() { throw new Error('connect ECONNREFUSED 127.0.0.1:17321'); },
  };
  const p = createPairing({ setup, cfgOf: () => ({}), setCfg: () => {} });
  const r = await p.inspect();
  assert.equal(r.step, 'no-panel');
  assert.equal(r.legacy, false);
});
