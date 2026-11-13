// setup.js 的行为测试：Roost 安装探测与启动探活。
//
// 移除 ai-chat 之后，setup 只负责「装 Roost、拉起来、打开面板」；
// 以前那三个改 ai-chat 配置的函数（installPlugin / configurePlugin /
// syncDshUrl）连同它们的跳过原因判定一起删掉了，端口同步由外接协议自己读租约。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSetup } from '../src/setup.js';

/** 造一份「看起来像 Roost」的目录，够 looksLikeRoost() 认就行 */
function makeRoost({ port = 15210 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-setup-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.js'), '// stub\n', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qq-bot-roost', version: '0.8.6' }), 'utf8');
  // portOf() 读的是 <roost>/data/ports.json 的 roost 槽位
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'ports.json'), JSON.stringify({ roost: { want: port, actual: port } }), 'utf8');
  return dir;
}

function makeSetup(dir, { token = '' } = {}) {
  const cfg = { server: { port: 17321, token }, setup: { roostDir: dir, version: 'v0.8.6' } };
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

/**
 * 面板的正常应答。
 *
 * 形状照 `/healthz` 来（`{ok, bots, online, total}`）——`isRunning()` 现在探的
 * 就是这个端点。只回 `{ok:true}` 的假响应会被当成「端口上是别的服务」，
 * 于是所有「Roost 在跑」的用例都会退化成 `roost-down`。
 */
const okRes = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true, bots: [], online: 0, total: 0, ...body }),
});

/**
 * 移除 ai-chat 的守卫：三个专用函数必须从 setup 实例上消失。
 * 用实例而不是源码字符串断言——实例是运行时真正暴露给 host.js / pairing 的东西。
 */
test('移除 ai-chat：setup 不再暴露装插件 / 写配置 / 同步地址三个函数', () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  for (const fn of ['installPlugin', 'configurePlugin', 'syncDshUrl']) {
    assert.equal(fn in setup, false, `${fn} 不该还在导出里`);
    assert.equal(typeof setup[fn], 'undefined');
  }
  // 通用能力一个都不能少：配对与向导都依赖 detect / api / start / stop
  for (const fn of ['detect', 'api', 'start', 'stop', 'install', 'qrStart', 'qrPoll', 'webuiUrl']) {
    assert.equal(typeof setup[fn], 'function', `${fn} 是通用能力，不能跟着一起删`);
  }
});

test('移除 ai-chat：detect 不再探测 ai-chat 插件，Roost 探测照常', async () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  await withFetch(async () => okRes({}), async () => {
    const st = await setup.detect();
    assert.equal(st.installed, true);
    assert.equal('pluginInstalled' in st, false);
    assert.equal('pluginConfigured' in st, false);
    assert.equal('pluginConfig' in st, false);
    assert.ok(Array.isArray(st.bots));
    assert.equal(typeof st.hasBot, 'boolean');
    assert.equal(typeof st.hasCreds, 'boolean');
  });
});

/* ---------------- 启动：不许拉出第二个 Roost ---------------- */

/**
 * 这一整段防的是一个真实事故：用户只配了一个机器人，点「启动」却报
 * 「AppID 1903571103 已有实例在运行（PID 2816）」。
 *
 * 根因不是机器人配重了，是 **dsh-roost 又 spawn 了一个 Roost 进程**：
 * 旧实现探活探错了地方（`/api/status` 配了密钥就恒 401），判成「没在跑」，
 * 于是拉第二个；第二个 claim 同一个 AppID 失败，留下一个「面板能开、
 * 机器人连不上」的半死进程。
 */

const waitPid = async (pid, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
};

test('启动: 探活走 /healthz（配了访问密钥也不会误判成没在跑）', async () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  const seen = [];
  const offline503 = {
    ok: false,
    status: 503,
    text: async () =>
      JSON.stringify({ ok: false, bots: [{ id: 'main', state: 'offline' }], online: 0, total: 1 }),
  };
  await withFetch(
    async (url) => {
      seen.push(String(url));
      return offline503;
    },
    async () => {
      const r = await setup.start();
      assert.ok(
        seen.some((u) => u.includes('/healthz')),
        `必须探 /healthz，实际探了：${seen.join(', ')}`,
      );
      assert.ok(!seen.some((u) => u.includes('/api/status')), '/api/status 配了密钥就恒 401');
      assert.equal(r.ok, true);
      assert.match(r.message, /已经在跑/, '503 说明面板活着，不能当成没在跑');
    },
  );
});

test('启动: 实例表里还有活着的 Roost 就不 spawn 第二个', async () => {
  const dir = makeRoost();
  // 起一个真进程冒充「已经在跑的 Roost」，写进它自己的实例表
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const alive = child.pid ? await waitPid(child.pid) : false;
  try {
    if (!alive) return; // 环境起不来子进程，跳过（CI 上极少见）
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(
      join(dir, 'data', 'instances.json'),
      JSON.stringify({ '1903571103': { pid: child.pid, at: Date.now() } }),
      'utf8',
    );
    const setup = makeSetup(dir);
    // 端口上没人（fetch 一律 ECONNREFUSED），只能靠实例表拦住
    await withFetch(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      async () => {
        await assert.rejects(
          () => setup.start(),
          (e) => {
            assert.match(e.message, /已经有一个 Roost 在跑/, '必须拒绝，不能再拉一个');
            assert.match(e.message, /实例锁/, '要告诉用户去哪清记录');
            return true;
          },
        );
      },
    );
  } finally {
    try {
      child.kill();
    } catch {}
  }
});

/**
 * 端口漂移：Roost 的 `listenWithFallback` 会在配置端口被占时往后顺延，
 * 实际端口记在 `data/ports.json`。这时**只探配置端口就探空**，接着三处一起错：
 * `start()` 以为没在跑、`stop()` 回「已停止」但其实没停、`createBot()` 跳过重启
 * 导致新加的机器人永远不上线。
 *
 * 所以探活要按「配置端口 → 租约实际端口 → 兜底」依次试。
 */
test('启动: 端口被占漂到 +1 时，探活要能找到（不能判成没在跑）', async () => {
  const want = 15231;
  const actual = 15232;
  const dir = makeRoost({ port: want });
  // Roost 自己的全局配置写了 want，但实际漂到了 actual
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'bot.json'), JSON.stringify({ webui: { port: want } }), 'utf8');
  writeFileSync(
    join(dir, 'data', 'ports.json'),
    // pid 用本进程：actualOf 会校验写租约的进程还活着
    JSON.stringify({ roost: { want, actual, pid: process.pid } }),
    'utf8',
  );

  const setup = makeSetup(dir);
  const seen = [];
  const health = (online) => ({
    ok: online > 0,
    status: online > 0 ? 200 : 503,
    text: async () => JSON.stringify({ ok: online > 0, bots: [{ id: 'main', state: 'online' }], online, total: 1 }),
  });

  await withFetch(
    async (url) => {
      const u = String(url);
      seen.push(u);
      // 只有漂过去的那个端口上有面板，配置端口上什么都不在
      if (u.includes(`:${actual}/`)) return health(1);
      throw new Error('ECONNREFUSED');
    },
    async () => {
      const r = await setup.start();
      assert.equal(r.ok, true, r.message);
      assert.match(r.message, /已经在跑/, '面板在 actual 上活着，不能判成没在跑');
      assert.ok(
        seen.some((u) => u.includes(`:${want}/healthz`)),
        `配置端口也要试一次：${seen.join(', ')}`,
      );
      assert.ok(
        seen.some((u) => u.includes(`:${actual}/healthz`)),
        `必须试到租约里的实际端口：${seen.join(', ')}`,
      );
    },
  );
});

/**
 * 启动时机器人已经 `error`：立刻返回，别空转到 20 秒。
 *
 * 2026-11-13 实机：宿主重启后旧 Roost 留下一条**残留心跳**（进程已死、
 * 心跳文件还在 30 秒租约内），新进程认领 AppID 被拦住 → `main` 直接 error。
 * 面板 1 秒就起来了，可 `startVerdict` 只认「至少一只 online」，于是一路空转
 * 到第 40 次轮询，20 秒后才给一句「去面板看日志里的报错」——原因明明就在
 * `/healthz` 里（框架从那天起会把 `error` 字段带出来）。
 *
 * 这里钉两件事：① 带原因立刻返回 ② 耗时远小于 20 秒。
 */
test('启动: 机器人报错时立刻返回并带上真实原因（不再空转 20 秒）', async () => {
  const dir = makeRoost();
  // 真起一个不退出的子进程，冒充「面板起来了、机器人连不上」的 Roost
  writeFileSync(join(dir, 'src', 'main.js'), 'setInterval(() => {}, 1000);\n', 'utf8');
  const setup = makeSetup(dir);

  const reason = 'AppID 102056878 已被PID 28256占用';
  const errored = {
    ok: false,
    status: 503,
    text: async () =>
      JSON.stringify({
        ok: false,
        bots: [{ id: 'main', state: 'error', error: reason }],
        online: 0,
        total: 1,
      }),
  };

  const started = Date.now();
  /**
   * 第一次探活要「没人应答」（等价于真实现场：面板还没起来就 spawn 了），
   * 之后才应答成「面板在、机器人 error」。全应答 503 的话 `isRunning()` 会先
   * 认定「已经在跑」直接返回，走不到启动轮询这条路径。
   */
  let probes = 0;
  try {
    await withFetch(
      async () => {
        probes += 1;
        if (probes <= 2) throw new Error('ECONNREFUSED');
        return errored;
      },
      async () => {
        const r = await setup.start();
        const spent = Date.now() - started;
        assert.equal(r.ok, false, '机器人没上线，不能报成功');
        assert.match(r.message, /102056878/, '要把 /healthz 带回的原因说出来');
        assert.match(r.message, /占用/, '原因要原样带出来，别只说「去面板看日志」');
        assert.ok(spent < 8000, `空转了 ${spent}ms，应当立刻返回（旧实现要等满 20 秒）`);
      },
    );
  } finally {
    await setup.stop().catch(() => {});
  }
});
