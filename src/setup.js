/**
 * 一键流程：装 Roost、配 ai-chat、拉起来、打开面板。
 *
 * 为什么能做成一键：Roost 是**零依赖**的——没有 npm install，没有编译，
 * 解压出来 `node src/main.js` 就能跑。所以「装」就是下载 + 解压两步。
 *
 * 有三件事**没法自动**，流程里会明确告诉用户：
 *   1. AppID / AppSecret —— 得去开放平台自己拿
 *   2. 开放平台里开「接收所有消息」—— 网页操作，接口改不了
 *   3. 机器人要先进群 —— 得有人拉它
 *
 * 这三步之外的都能点一下搞定。
 */

import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';

const REPO = 'tdcq9594/qq-bot-roost';

/** 国内优先 Gitee，失败再试 GitHub */
const SOURCES = (v) => [
  `https://gitee.com/${REPO}/repository/archive/${v}.zip`,
  `https://codeload.github.com/${REPO}/zip/refs/tags/${v}`,
];

/** 跑个命令，返回 {code, out} */
function run(cmd, args, opts = {}) {  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: -1, out: '', err: e.message });
    }
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * 解压 zip。
 *
 * 现代系统上 `tar -xf` 就能解 zip（bsdtar），所以先试它；
 * 不行再试 unzip / PowerShell。三个都失败才报错，并把三条错误一起给出来，
 * 免得用户只看到「解压失败」不知道怎么办。
 */
async function unzip(zipPath, dest) {
  const tries = [];

  if (process.platform === 'win32') {
    tries.push(['tar', ['-xf', zipPath, '-C', dest]]);
    tries.push([
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force`],
    ]);
  } else {
    tries.push(['tar', ['-xf', zipPath, '-C', dest]]);
    tries.push(['unzip', ['-q', zipPath, '-d', dest]]);
  }

  const errs = [];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args);
    if (r.code === 0) return;
    errs.push(`${cmd}: ${(r.err || r.out || '').trim().split('\n')[0] || `退出码 ${r.code}`}`);
  }
  throw new Error(`解压失败（${errs.join('；')}）。可以手动下载解压到目标目录`);
}

/**
 * 挑一个空着的面板端口。
 *
 * 不写死 8080：那是最容易被别的程序占掉的端口（一堆本地服务都用它）。
 * 从 8080 往上试，第一个能 bind 的就用。这样装完直接能打开，
 * 不会出现「装好了但面板打不开」。
 */
function pickPort(start = 8080, tries = 20) {
  return new Promise((resolve) => {
    let port = start;
    const attempt = () => {
      if (port >= start + tries) return resolve(start); // 都占着就还回原值，让用户自己改
      const srv = createNetServer();
      srv.once('error', () => {
        port += 1;
        attempt();
      });
      srv.once('listening', () => {
        srv.close(() => resolve(port));
      });
      srv.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

export function createSetup({ cfgOf, setCfg, dataDir, log = () => {} }) {
  /** 我们自己拉起来的那个进程。DSH 重启后为 null，但 Roost 可能还在跑 */
  let child = null;
  let busy = '';

  const dirOf = () => cfgOf().setup.roostDir || join(dataDir(), 'roost');
  const versionOf = () => cfgOf().setup.version || 'v0.8.1';

  /** Roost 自己的全局配置（端口、密钥都在里面） */
  function roostGlobal() {
    try {
      return JSON.parse(readFileSync(join(dirOf(), 'config', 'bot.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  function portOf() {
    return Number(roostGlobal().webui?.port) || 8080;
  }
  function keyOf() {
    return String(roostGlobal().webui?.accessKey || '');
  }
  function baseUrl() {
    return `http://127.0.0.1:${portOf()}`;
  }
  function webuiUrl() {
    const k = keyOf();
    return `${baseUrl()}/${k ? `?key=${encodeURIComponent(k)}` : ''}`;
  }

  /** 带 key 请求 Roost 的面板 API */
  async function api(path, init = {}) {
    const k = keyOf();
    const url = `${baseUrl()}${path}${k ? `${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(k)}` : ''}`;
    const res = await fetch(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
    return json;
  }

  /** 是不是在跑（直接问它自己） */
  async function isRunning() {
    try {
      const r = await fetch(`${baseUrl()}/api/status`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /* ---------------- 检测 ---------------- */

  async function detect() {
    const dir = dirOf();
    const installed = existsSync(join(dir, 'src', 'main.js'));

    let version = '';
    if (installed) {
      try {
        version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? '';
      } catch {}
    }

    const running = installed ? await isRunning() : false;

    /**
     * 机器人列表和插件是否装了，都**直接看磁盘**。
     *
     * 走 API 更准，但 Roost 没起来时没有 API——而这两件事恰恰是
     * 「还没起来」阶段用户最需要看到的反馈（填完 AppID 那一步要立刻变绿）。
     */
    let bots = [];
    try {
      const bd = join(dir, 'config', 'bots');
      if (existsSync(bd)) {
        bots = readdirSync(bd)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              const j = JSON.parse(readFileSync(join(bd, f), 'utf8'));
              return { id: j.id || f.replace(/\.json$/, ''), name: j.name || '', appId: j.appId || '' };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    } catch {}

    const pluginInstalled = installed && existsSync(join(dir, 'plugins', 'ai-chat', 'index.js'));

    let pluginConfig = null;
    if (running) {
      try {
        const pl = await api('/api/plugins');
        const arr = pl?.plugins ?? pl ?? [];
        const one = Array.isArray(arr) ? arr.find((p) => p.id === 'ai-chat') : null;
        pluginConfig = one?.config ?? null;
      } catch {}
    }

    const configured = Boolean(pluginConfig && pluginConfig.adapter === 'dsh');

    return {
      dir,
      version,
      installed,
      running,
      port: portOf(),
      accessKeySet: Boolean(keyOf()),
      webui: webuiUrl(),
      bots,
      hasBot: bots.length > 0,
      pluginInstalled,
      pluginConfigured: configured,
      pluginConfig: pluginConfig
        ? { adapter: pluginConfig.adapter, dshUrl: pluginConfig.dshUrl, publicUrl: pluginConfig.publicUrl, apiKey: pluginConfig.apiKey ? '******' : '' }
        : null,
      dshUrl: `http://127.0.0.1:${cfgOf().server.port}`,
      busy,
    };
  }

  /* ---------------- 绑定已有安装 ---------------- */

  /**
   * 已经自己装过 Roost 的人，不用再下一份。
   *
   * 只认「目录里有 src/main.js」——这是 Roost 的入口，有它就说明是个能跑的安装，
   * 比让用户对着文档猜「我装的是不是对的」靠谱。
   */
  function setDir(input) {
    const dir = String(input ?? '').trim().replace(/^["']|["']$/g, '').replace(/[/\\]+$/, '');
    if (!dir) throw new Error('路径不能为空');
    if (!existsSync(join(dir, 'src', 'main.js'))) {
      throw new Error(`这个目录不像 Roost（没找到 src/main.js）：${dir}`);
    }
    setCfg({ setup: { roostDir: dir } });
    log(`已绑定已有安装：${dir}`);
    return { ok: true, message: '已绑定', dir };
  }

  /* ---------------- 装 ---------------- */

  async function install() {
    if (busy) throw new Error(`正在${busy}，等它完成`);
    busy = '安装';
    const dir = dirOf();
    const tmp = join(tmpdir(), `roost-${Date.now()}.zip`);
    const stage = join(tmpdir(), `roost-stage-${Date.now()}`);

    try {
      if (existsSync(join(dir, 'src', 'main.js'))) {
        return { ok: true, message: '已经装好了，跳过' };
      }
      mkdirSync(stage, { recursive: true });

      // 1) 下载（Gitee 优先，国内快）
      let lastErr = null;
      for (const url of SOURCES(versionOf())) {
        try {
          log(`下载 ${url}`);
          const res = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          log(`下载失败（${url}）：${e.message}`);
        }
      }
      if (lastErr) throw new Error(`下载失败：${lastErr.message}。可以手动下载 ${versionOf()} 解压到 ${dir}`);

      // 2) 解压
      await unzip(tmp, stage);

      // 3) zip 里有一层同名目录，把内容提到目标位置
      const entries = readdirSync(stage);
      const inner = entries.length === 1 ? join(stage, entries[0]) : stage;
      mkdirSync(dir, { recursive: true });
      cpSync(inner, dir, { recursive: true });

      if (!existsSync(join(dir, 'src', 'main.js'))) {
        throw new Error('解压完了但没找到 src/main.js，包结构可能变了');
      }

      log(`已安装到 ${dir}`);
      return { ok: true, message: `装好了：${dir}` };
    } finally {
      busy = '';
      try {
        rmSync(tmp, { force: true });
        rmSync(stage, { recursive: true, force: true });
      } catch {}
    }
  }

  /* ---------------- 建机器人 ---------------- */

  /**
   * 写机器人配置。
   *
   * 直接写文件而不是调 API：Roost 启动时**必须有至少一个机器人**，
   * 没有就直接退出——所以这时候还没有 API 可调。
   * 只写必需的几个字段，其余由 Roost 自己跟默认值合并。
   */
  async function createBot({ name = 'main', appId, appSecret }) {
    if (!appId || !appSecret) throw new Error('AppID 和 AppSecret 都要填');
    const dir = dirOf();
    const botsDir = join(dir, 'config', 'bots');
    mkdirSync(botsDir, { recursive: true });
    const file = join(botsDir, `${name}.json`);
    const cfg = { id: name, name, appId: String(appId).trim(), appSecret: String(appSecret).trim(), enabled: true };
    writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');

    // 面板配置：给个默认端口，已经有的端口不覆盖（用户可能改过）
    const g = join(dir, 'config', 'bot.json');
    mkdirSync(join(dir, 'config'), { recursive: true });
    let global = {};
    try {
      global = JSON.parse(readFileSync(g, 'utf8'));
    } catch {}
    global.webui = { openBrowser: false, ...(global.webui || {}) };
    // 没有就挑一个空着的（8080 常被别的本地服务占掉）
    if (!global.webui.port) global.webui.port = await pickPort();
    writeFileSync(g, JSON.stringify(global, null, 2), 'utf8');

    log(`已写入机器人配置 ${file}`);
    return { ok: true, message: `机器人 ${name} 配置好了`, webui: webuiUrl() };
  }

  /* ---------------- 起停 ---------------- */

  async function start() {
    if (await isRunning()) return { ok: true, message: '已经在跑了' };
    if (!existsSync(join(dirOf(), 'src', 'main.js'))) throw new Error('还没装，先点安装');

    const dir = dirOf();
    child = spawn(process.execPath, ['src/main.js', '--serve', '--no-open'], {
      cwd: dir,
      env: { ...process.env, ROOST_HOME: dir },
      stdio: 'ignore',
      detached: false,
    });
    child.on('exit', (code) => {
      log(`Roost 进程退出（${code}）`);
      child = null;
    });

    // 等它起来（最多 20 秒）
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await isRunning()) return { ok: true, message: `起来了：${webuiUrl()}` };
      if (!child) throw new Error('Roost 启动后马上退出了。看它的日志：可能缺 AppID/AppSecret，或端口被占');
    }
    throw new Error('等了 20 秒还没起来，去目录里手动跑 node src/main.js 看看报什么错');
  }

  async function stop() {
    if (child) {
      try {
        child.kill();
      } catch {}
      child = null;
    }
    // 不是我们拉起来的（比如用户自己开的），只能提示
    if (await isRunning()) return { ok: false, message: '这不是本插件启动的进程，请到它的控制台关掉' };
    return { ok: true, message: '已停止' };
  }

  /* ---------------- 装插件 + 配好 ---------------- */

  async function installPlugin() {
    if (!(await isRunning())) throw new Error('Roost 没在跑，先启动');
    const pl = await api('/api/plugins');
    const arr = pl?.plugins ?? pl ?? [];
    if (Array.isArray(arr) && arr.some((p) => p.id === 'ai-chat')) {
      return { ok: true, message: 'ai-chat 已经装了' };
    }
    await api('/api/market/install', { method: 'POST', body: JSON.stringify({ id: 'ai-chat' }) });
    return { ok: true, message: 'ai-chat 装好了' };
  }

  /**
   * 把 ai-chat 配成「交给 DSH」。
   *
   * 只改这几个字段，别的（人格、模型、冷却）保持默认——用户之后在面板里改。
   * 特别是 **apiKey 不动**：直连模型的密钥跟这条链路无关。
   */
  async function configurePlugin() {
    if (!(await isRunning())) throw new Error('Roost 没在跑，先启动');
    const patch = {
      adapter: 'dsh',
      dshUrl: `http://127.0.0.1:${cfgOf().server.port}`,
      publicUrl: baseUrl(),
      // 交给 DSH 之后，本插件说了算，别让 AI 再按「只在被 @ 时说话」缩着
      decide: 'ai',
    };
    await api('/api/plugins/ai-chat/config', { method: 'PUT', body: JSON.stringify(patch) });
    return { ok: true, message: 'ai-chat 已切到 DSH 适配器', patch };
  }

  return {
    detect,
    install,
    setDir,
    createBot,
    start,
    stop,
    installPlugin,
    configurePlugin,
    webuiUrl,
    get busy() {
      return busy;
    },
  };
}
