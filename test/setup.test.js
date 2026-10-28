// setup.js 的「跳过原因」测试。
//
// 这一段的核心是一句话：**跳过有很多种，只有「Roost 还没起来」值得重试。**
//
// 以前 `syncDshUrl` 只返回一个 `skipped: true`，调用方分不清「等两秒就好」
// 和「用户压根没在用 DSH」，于是一律当作「不用管」——跳过一次就再也不试。
// 后果就是：dsh-roost 比 Roost 先起来时端口永远同步不过去，面板一直红着
// 让用户「去接入第 5 步重新写一次」，而这件事它自己明明能做。
//
// 所以这里逐个盯住每种 reason，防止以后有人又把它们合并成一个布尔。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSetup } from '../src/setup.js';

/** 造一份「看起来像 Roost」的目录，够 looksLikeRoost() 认就行 */
function makeRoost({ port = 15210, aiChat = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-setup-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.js'), '// stub\n', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qq-bot-roost', version: '0.8.6' }), 'utf8');
  // portOf() 读的是 <roost>/data/ports.json 的 roost 槽位
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'ports.json'), JSON.stringify({ roost: { want: port, actual: port } }), 'utf8');
  if (aiChat) {
    mkdirSync(join(dir, 'config', 'bots', 'main', 'plugins'), { recursive: true });
    writeFileSync(
      join(dir, 'config', 'bots', 'main', 'plugins', 'ai-chat.json'),
      JSON.stringify(aiChat),
      'utf8',
    );
  }
  return dir;
}

function makeSetup(dir) {
  const cfg = { server: { port: 17321 }, setup: { roostDir: dir, version: 'v0.8.6' } };
  return createSetup({ cfgOf: () => cfg, setCfg: () => {}, dataDir: () => dir, log: () => {} });
}

/** 换掉 globalThis.fetch，跑完还原 */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const okRes = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('同步：Roost 没跑时返回 roost-down，调用方才知道该重试', async () => {
  const dir = makeRoost({ aiChat: { adapter: 'dsh', dshUrl: 'http://127.0.0.1:17322' } });
  const setup = makeSetup(dir);
  await withFetch(
    async () => { throw new Error('ECONNREFUSED'); },
    async () => {
      const r = await setup.syncDshUrl();
      assert.equal(r.ok, true, '不算失败');
      assert.equal(r.skipped, true);
      assert.equal(r.reason, 'roost-down', '这一种必须能被认出来，否则没人重试');
    },
  );
});

test('同步：Roost 在跑但没装 ai-chat → no-config', async () => {
  const dir = makeRoost({ aiChat: null });
  const setup = makeSetup(dir);
  await withFetch(
    async () => okRes({ ok: true }),
    async () => {
      const r = await setup.syncDshUrl();
      assert.equal(r.skipped, true);
      assert.equal(r.reason, 'no-config');
    },
  );
});

test('同步：ai-chat 没在用 DSH → not-dsh，不该硬改也不该重试', async () => {
  const dir = makeRoost({ aiChat: { adapter: 'local' } });
  const setup = makeSetup(dir);
  await withFetch(
    async () => okRes({ ok: true }),
    async () => {
      const r = await setup.syncDshUrl();
      assert.equal(r.skipped, true);
      assert.equal(r.reason, 'not-dsh');
    },
  );
});

test('同步：已经是当前端口 → 不算跳过，也不发 PUT', async () => {
  const dir = makeRoost({ aiChat: { adapter: 'dsh', dshUrl: 'http://127.0.0.1:17321' } });
  const setup = makeSetup(dir);
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET' });
      return okRes({ ok: true });
    },
    async () => {
      const r = await setup.syncDshUrl();
      assert.equal(r.skipped, undefined);
      assert.equal(r.ok, true);
      assert.equal(calls.filter((c) => c.method === 'PUT').length, 0, '一样就不该写');
    },
  );
});

test('同步：端口变了就 PUT 一次，并说清从哪改到哪', async () => {
  const dir = makeRoost({ aiChat: { adapter: 'dsh', dshUrl: 'http://127.0.0.1:17322' } });
  const setup = makeSetup(dir);
  const puts = [];
  await withFetch(
    async (url, init) => {
      if (init?.method === 'PUT') {
        puts.push({ url: String(url), body: JSON.parse(init.body) });
        return okRes({ ok: true, config: { adapter: 'dsh', dshUrl: 'http://127.0.0.1:17321' } });
      }
      return okRes({ ok: true });
    },
    async () => {
      const r = await setup.syncDshUrl();
      assert.equal(r.ok, true);
      assert.equal(r.from, 'http://127.0.0.1:17322');
      assert.equal(r.to, 'http://127.0.0.1:17321');
      assert.equal(puts.length, 1);
      assert.equal(puts[0].body.dshUrl, 'http://127.0.0.1:17321');
      assert.ok(puts[0].url.includes('/api/plugins/ai-chat/config'));
    },
  );
});

test('同步：传了实际端口就用传的，不用配置值', async () => {
  const dir = makeRoost({ aiChat: { adapter: 'dsh', dshUrl: 'http://127.0.0.1:17322' } });
  const setup = makeSetup(dir);
  const puts = [];
  await withFetch(
    async (url, init) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(init.body));
      return okRes({ ok: true, config: {} });
    },
    async () => {
      await setup.syncDshUrl(17325);
      assert.equal(puts.length, 1);
      assert.equal(puts[0].dshUrl, 'http://127.0.0.1:17325', '被占顺延后要写实际端口');
    },
  );
});

/* ---------------- 装插件：失败了不许说「装好了」 ---------------- */

/**
 * 真事：对方在没装 Node.js 的机器上点第 4 步，面板显示「ai-chat 装好了」，
 * 但第 5 步怎么都过不去——因为插件加载失败（语音依赖要 npm），
 * 而 `installPlugin()` 没看返回里的 `errors`。
 *
 * 装失败和装成功是两件事，不能都给一句「装好了」。
 */
function roostStub({ errors = [] } = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/api/status')) return okRes({ ok: true });
    if (u.includes('/api/market/install')) {
      return okRes({ ok: true, id: 'ai-chat', added: [], removed: [], errors });
    }
    if (u.includes('/api/plugins')) return okRes({ plugins: [] });
    return okRes({ ok: true });
  };
}

test('装插件：插件加载失败时要如实报错，不能回「装好了」', async () => {
  const dir = makeRoost({ aiChat: null });
  const setup = makeSetup(dir);
  await withFetch(roostStub({ errors: [{ id: 'ai-chat', error: '这个插件需要 npm 安装依赖，但系统里找不到 npm' }] }), async () => {
    await assert.rejects(
      () => setup.installPlugin(),
      (e) => {
        assert.match(e.message, /没加载起来/, '要明说「装好了但没跑起来」');
        assert.match(e.message, /找不到 npm/, '原始原因要带出来，不然没法排查');
        assert.match(e.message, /重启 Roost/, '要给下一步动作');
        return true;
      },
    );
  });
});

test('装插件：没报错就正常回「装好了」', async () => {
  const dir = makeRoost({ aiChat: null });
  const setup = makeSetup(dir);
  await withFetch(roostStub({ errors: [] }), async () => {
    const r = await setup.installPlugin();
    assert.equal(r.ok, true);
    assert.match(r.message, /装好了/);
  });
});

test('装插件：别的插件加载失败不该算到 ai-chat 头上', async () => {
  const dir = makeRoost({ aiChat: null });
  const setup = makeSetup(dir);
  await withFetch(roostStub({ errors: [{ id: 'kun', error: '别的东西炸了' }] }), async () => {
    const r = await setup.installPlugin();
    assert.equal(r.ok, true, 'kun 失败跟这一步无关');
  });
});
