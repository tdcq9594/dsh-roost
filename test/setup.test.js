// setup.js 的行为测试：Roost 安装探测与启动探活。
//
// 移除 ai-chat 之后，setup 只负责「装 Roost、拉起来、打开面板」；
// 以前那三个改 ai-chat 配置的函数（installPlugin / configurePlugin /
// syncDshUrl）连同它们的跳过原因判定一起删掉了，端口同步由外接协议自己读租约。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  createSetup, healthDirHash, instanceAlive,
  assertCanWipe, keepListOf, KEEPABLE,
} from '../src/setup.js';

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

function makeSetup(dir, { token = '', installer = null, dataDir = null, setCfg = null } = {}) {
  const cfg = { server: { port: 17321, token }, setup: { roostDir: dir, version: 'v0.8.6' } };
  return createSetup({
    cfgOf: () => cfg,
    setCfg: setCfg || (() => {}),
    dataDir: dataDir ? () => dataDir : () => dir,
    log: () => {},
    installer,
  });
}

/**
 * 卸载要真删目录，所以测试里的 `dataDir` 必须**不是**被删的那个
 * （assertCanWipe 明确拒绝「DSH 数据目录」）。给一份独立临时目录。
 */
const spareDataDir = () => mkdtempSync(join(tmpdir(), 'dsh-data-'));

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

/* ---------- 身份校验：端口上那份 Roost 必须属于配置目录 ---------- */

test('身份指纹：与框架同口径（sha256 前 12 位），路径写法不干扰', () => {
  const p = join(tmpdir(), 'roost-identity-a');
  const h = healthDirHash(p);
  assert.match(h, /^[a-f0-9]{12}$/);
  assert.equal(h, healthDirHash(p + '/'), '尾斜杠不该改变身份');
  assert.equal(h, healthDirHash(join(p, '.')), '/. 不该改变身份');
  assert.notEqual(h, healthDirHash(join(tmpdir(), 'roost-identity-b')), '不同目录必须不同');
  if (process.platform === 'win32') {
    const lower = p.replace(/^([A-Z]):/, (_, drive) => drive.toLowerCase() + ':');
    assert.equal(h, healthDirHash(lower), '盘符大小写不该改变身份');
  }
});

test('探活: 另一目录的 Roost 占着端口，不算本目录在跑', async () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  const foreignHash = healthDirHash(join(dir, 'another-roost'));
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true, bots: [{ id: 'main', state: 'online' }], online: 1, total: 1,
          pid: 424242, dirHash: foreignHash,
        }),
    }),
    async () => {
      assert.equal(await setup.isRunning(), false, 'dirHash 不匹配必须判没跑');
    },
  );
});

test('探活: 本目录的 Roost 带正确 dirHash，算在跑', async () => {
  const dir = makeRoost();
  const setup = makeSetup(dir);
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true, bots: [{ id: 'main', state: 'online' }], online: 1, total: 1,
          pid: 424242, dirHash: healthDirHash(dir),
        }),
    }),
    async () => {
      assert.equal(await setup.isRunning(), true);
    },
  );
});

test('探活: 老框架没有 dirHash，pid 不在本目录实例表里就不认', async () => {
  const dir = makeRoost();
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'instances.json'),
    JSON.stringify({ 1: { pid: 999999999, at: Date.now() } }),
    'utf8',
  );
  const setup = makeSetup(dir);
  await withFetch(
    async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true, bots: [{ id: 'main', state: 'online' }], online: 1, total: 1,
          pid: 123456789, // 不在实例表里 —— 端口上是别家的老框架
        }),
    }),
    async () => {
      assert.equal(await setup.isRunning(), false);
    },
  );
});

/**
 * 真框架（1.1.12）的 `/healthz` 只有 {ok,bots,online,total,uptime}——**既不带 pid
 * 也不带 dirHash**。以前 pidInLocalInstances 在「实例表非空 + pid 缺失」时返回 false，
 * 于是明明 online 也被判「没在跑」：面板永远不显示已启动，一键启动按钮也变不成关闭。
 * 这两条把「无 pid 放过」钉死，同时保住「带了 pid 但对不上就不认」的旧行为。
 */
test('探活: 真框架 healthz 无 pid 无 dirHash + 实例表有记录，机器人 online 必须算在跑', async () => {
  const dir = makeRoost();
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'instances.json'),
    JSON.stringify({ 102056878: { pid: 41840, at: Date.now() } }),
    'utf8',
  );
  const setup = makeSetup(dir);
  /** 真框架的响应体：刻意不放 pid / dirHash（照 web/server.js:1214 的形状） */
  await withFetch(async () => okRes({ bots: [{ id: 'main', state: 'online' }], online: 1, total: 1, uptime: 42 }), async () => {
    assert.equal(await setup.isRunning(), true, '无 pid 无从校验身份时必须放过，不能误判没跑');
  });
});

test('探活: 带了 pid 但不在本目录实例表里，仍然不认', async () => {
  const dir = makeRoost();
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'instances.json'),
    JSON.stringify({ 102056878: { pid: 999999999, at: Date.now() } }),
    'utf8',
  );
  const setup = makeSetup(dir);
  await withFetch(async () => okRes({ bots: [{ id: 'main', state: 'online' }], online: 1, total: 1, pid: 123456789 }), async () => {
    assert.equal(await setup.isRunning(), false, '明确带了对不上的 pid 仍要拒绝');
  });
});

test('探活: pid 给了但不是合法整数，不能当成「缺失」放过', async () => {
  const dir = makeRoost();
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'instances.json'), JSON.stringify({ 1: { pid: 999999999, at: Date.now() } }), 'utf8');
  const setup = makeSetup(dir);
  for (const bad of ['123456789', 0, -1, 1.5]) {
    await withFetch(async () => okRes({ bots: [{ id: 'main', state: 'online' }], online: 1, total: 1, pid: bad }), async () => {
      assert.equal(await setup.isRunning(), false, `pid=${JSON.stringify(bad)} 是无效身份，不能放过`);
    });
  }
});

test('实例判活: 心跳停跳时 PID 被复用也不认', () => {
  const dir = makeRoost();
  const beat = 'a'.repeat(20) + '.beat';
  const rec = { pid: 424242, beat, at: Date.now() };
  /** 没心跳文件 = 明确停跳；PID 就算还在（被复用）也不认 */
  assert.equal(instanceAlive(rec, dir, () => true), false);

  const file = join(dir, 'data', 'instance-beats', beat);
  mkdirSync(join(dir, 'data', 'instance-beats'), { recursive: true });
  writeFileSync(file, '{}', 'utf8');
  assert.equal(instanceAlive(rec, dir, () => true), true, '心跳新鲜 + PID 在 = 活');

  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  assert.equal(instanceAlive(rec, dir, () => true), false, '心跳过期，PID 在也不认');

  assert.equal(instanceAlive({ pid: 424242 }, dir, () => true), true, '老记录没有 beat，退回 PID 判活');
});

/* ---------------- 卸载 / 卸载重装 ---------------- */

/**
 * 一份带全部数据块的 Roost：卸载逻辑要看的是「哪几块留下了」，
 * 所以每个块都塞一个能认出来的文件。
 */
function makeFullRoost() {
  const dir = makeRoost();
  for (const [name, file] of [
    ['config', 'bots/main.json'],
    ['data', 'sessions.json'],
    ['plugins', 'hello.js'],
    ['logs', 'run.log'],
  ]) {
    const p = join(dir, name, file);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, `kept:${name}`, 'utf8');
  }
  /** 纯程序文件：卸载后必须消失 */
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'manual.md'), 'doc', 'utf8');
  writeFileSync(join(dir, 'README.md'), '# roost', 'utf8');
  return dir;
}

/** 假安装器：不联网，只写回「装好了」的最小结构 */
function fakeInstaller({ version = '9.9.9' } = {}) {
  return ({ dir }) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.js'), `// fresh ${version}\n`, 'utf8');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'qq-bot-roost', version }), 'utf8');
    return { ok: true };
  };
}

const leftoversOf = (dir) => readdirSync(join(dir, '..'))
  .filter((n) => n.startsWith(`${dir.split(/[\\/]/).pop()}.old-`));

test('保留项: 不传 = 全保留，非法名一律拒', () => {
  assert.deepEqual(keepListOf(undefined), KEEPABLE);
  assert.deepEqual(keepListOf([]), [], '空数组 = 一项都不留');
  assert.deepEqual(keepListOf(['data', 'data']), ['data'], '去重');
  assert.deepEqual(keepListOf('config'), ['config'], '单个字符串也认');
  assert.throws(() => keepListOf(['src']), /不认识/);
  assert.throws(() => keepListOf(['..']), /不认识/);
});

test('删除闸门: 不像 Roost / 盘根 / 家目录 / DSH 数据目录 / .git 全部拒', () => {
  const dir = makeRoost();
  const data = spareDataDir();

  assert.equal(assertCanWipe(dir, { dataDir: data, home: join(data, 'home') }), dir, '正常目录放过');

  const empty = mkdtempSync(join(tmpdir(), 'not-roost-'));
  assert.throws(() => assertCanWipe(empty, { dataDir: data }), /不像 Roost/);

  assert.throws(() => assertCanWipe(process.platform === 'win32' ? 'C://' : '/', { dataDir: data }), /根目录|不存在|不像 Roost/);

  /** 家目录本身：哪怕它碰巧长得像 Roost 也不许删 */
  const fakeHome = makeRoost();
  assert.throws(() => assertCanWipe(fakeHome, { dataDir: data, home: fakeHome }), /家目录/);

  /** 家目录的上层：删了会把家目录一起带走 */
  const parentRoost = makeRoost();
  assert.throws(
    () => assertCanWipe(parentRoost, { dataDir: data, home: join(parentRoost, 'sub', 'user') }),
    /家目录/,
  );

  /** DSH 数据目录：删 Roost 不能顺手把插件自己的数据带走 */
  const dshDir = makeRoost();
  assert.throws(() => assertCanWipe(dshDir, { dataDir: dshDir }), /DSH/);
  assert.throws(() => assertCanWipe(dshDir, { dataDir: join(dshDir, 'data') }), /DSH/, '数据目录在下层也算');

  /** 源码检出：删了会丢本地提交 */
  const gitDir = makeRoost();
  mkdirSync(join(gitDir, '.git'), { recursive: true });
  assert.throws(() => assertCanWipe(gitDir, { dataDir: data }), /\.git/);
});

test('卸载重装: 默认全保留，只换程序文件', async () => {
  const dir = makeFullRoost();
  const setup = makeSetup(dir, { installer: fakeInstaller(), dataDir: spareDataDir() });

  const r = await setup.reinstall();
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept.sort(), [...KEEPABLE].sort(), '默认一项都不丢');
  assert.equal(r.version, '9.9.9');

  for (const [name, file] of [
    ['config', 'bots/main.json'],
    ['data', 'sessions.json'],
    ['plugins', 'hello.js'],
    ['logs', 'run.log'],
  ]) {
    assert.equal(readFileSync(join(dir, name, file), 'utf8'), `kept:${name}`, `${name} 必须原样还在`);
  }
  assert.equal(existsSync(join(dir, 'docs')), false, '旧程序文件要清掉');
  assert.equal(existsSync(join(dir, 'README.md')), false);
  assert.match(readFileSync(join(dir, 'src', 'main.js'), 'utf8'), /fresh 9\.9\.9/);
  assert.deepEqual(leftoversOf(dir), [], '旧目录要删干净，别在桌面留一排 .old-');
});

test('卸载重装: 只勾 config 时 data / plugins / logs 一起没', async () => {
  const dir = makeFullRoost();
  const setup = makeSetup(dir, { installer: fakeInstaller(), dataDir: spareDataDir() });

  const r = await setup.reinstall({ keep: ['config'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, ['config']);
  assert.equal(readFileSync(join(dir, 'config', 'bots', 'main.json'), 'utf8'), 'kept:config');
  for (const name of ['data', 'plugins', 'logs']) {
    assert.equal(existsSync(join(dir, name)), false, `${name} 没勾，必须删掉`);
  }
  assert.match(r.message, /凭证还在/, '留了 config 就是凭证还在，别吓得让人重扫码');

  /** 反过来：不留 config 时必须明确说要重新扫码，不然用户装完发现机器人哑了 */
  const dir2 = makeFullRoost();
  const s2 = makeSetup(dir2, { installer: fakeInstaller(), dataDir: spareDataDir() });
  const r2 = await s2.reinstall({ keep: ['data'] });
  assert.match(r2.message, /重新扫码/);
});

test('卸载重装: 安装失败要回滚成原来那份，不能留半成品', async () => {
  const dir = makeFullRoost();
  const setup = makeSetup(dir, {
    installer: () => { throw new Error('下载失败：HTTP 502'); },
    dataDir: spareDataDir(),
  });

  await assert.rejects(() => setup.reinstall({ keep: ['data'] }), /重装失败.*旧安装已恢复/s);
  assert.equal(readFileSync(join(dir, 'src', 'main.js'), 'utf8'), '// stub\n', '旧程序必须回来');
  assert.equal(readFileSync(join(dir, 'config', 'bots', 'main.json'), 'utf8'), 'kept:config', '回滚后数据也在');
  assert.deepEqual(leftoversOf(dir), [], '回滚后不留 .old-');
});

test('只卸载: 勾中的块留在原位，程序文件清掉，不留旧目录', async () => {
  const dir = makeFullRoost();
  const setup = makeSetup(dir, { dataDir: spareDataDir() });

  const r = await setup.uninstall({ keep: ['data', 'plugins'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, ['data', 'plugins']);
  assert.equal(existsSync(join(dir, 'src', 'main.js')), false, '程序要卸掉');
  assert.equal(readFileSync(join(dir, 'data', 'sessions.json'), 'utf8'), 'kept:data');
  assert.equal(existsSync(join(dir, 'config')), false, '没勾 config 就不留');
  assert.equal(existsSync(join(dir, 'logs')), false);
  assert.deepEqual(leftoversOf(dir), []);
});

test('只卸载: 一项都不勾就是清空，目录还在（之后能原地装回去）', async () => {
  const dir = makeFullRoost();
  const setup = makeSetup(dir, { dataDir: spareDataDir() });

  const r = await setup.uninstall({ keep: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.kept, []);
  assert.equal(existsSync(dir), true, '目录本身要留着，s.dir 还要能显示');
  assert.deepEqual(readdirSync(dir), [], '里面什么都别剩');
});

test('卸载 / 重装: 关不掉 Roost 时一个文件都不动', async () => {
  const dir = makeFullRoost();
  /** 面板一直应答「在跑」，实例表里没有 pid → stopOnce 认为停不下来 */
  const setup = makeSetup(dir, { dataDir: spareDataDir(), installer: fakeInstaller() });
  await withFetch(async () => okRes({ bots: [], online: 0, total: 0 }), async () => {
    await assert.rejects(() => setup.reinstall({ keep: [] }), /停不下来/);
  });
  assert.equal(readFileSync(join(dir, 'src', 'main.js'), 'utf8'), '// stub\n', '没停下就不能动文件');
  assert.equal(readFileSync(join(dir, 'config', 'bots', 'main.json'), 'utf8'), 'kept:config');
});
