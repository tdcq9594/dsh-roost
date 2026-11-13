/**
 * 一键流程：装 Roost、拉起来、打开面板、接好外接协议。
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

import { spawn, execFileSync } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createLease } from './lease.js';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';

const REPO = 'tdcq9594/qq-bot-roost';

/**
 * 下载源，**按可用性排序**。
 *
 * 三条都是实测出来的，不是猜的：
 *
 * 1. **tag 带 `v` 前缀**——仓库里打的是 `v0.8.6`，拼成 `0.8.6` 会 404。
 *    一键安装之前一直失败就是这个原因（Gitee 和 GitHub 都 404）。
 * 2. **npm 放第二**——它的地址用纯版本号（没有 v），registry 比 codeload 稳。
 *    实测 codeload 对「用 Git Data API 造的 tag」会返回 404，哪怕 tag 确实存在。
 * 3. GitHub 放最后——留着兜底，但它目前对这个仓库不可靠。
 */
const SOURCES = (v) => [
  { url: `https://gitee.com/${REPO}/repository/archive/v${v}.zip`, kind: 'zip' },
  { url: `https://registry.npmjs.org/qq-bot-roost/-/qq-bot-roost-${v}.tgz`, kind: 'tgz' },
  { url: `https://codeload.github.com/${REPO}/zip/refs/tags/v${v}`, kind: 'zip' },
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
async function unzip(zipPath, dest, kind = 'zip') {
  const tries = [];

  /**
   * npm 的包是 `.tgz`（gzip tar），不是 zip。
   * `tar -xzf` 各平台都有（Windows 10+ 自带 bsdtar），所以单独走一条就行。
   */
  if (kind === 'tgz') {
    tries.push(['tar', ['-xzf', zipPath, '-C', dest]]);
  } else if (process.platform === 'win32') {
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

/**
 * 进程还在不在。
 *
 * 只看存在性，不问「是不是本框架」「有没有权限」——实例表里的 pid 是当年
 * claim 那个进程自己写的，它还活着就说明那条记录仍然有效。EPERM 表示进程
 * 存在但没权限发信号（别的用户开的），一样算活着。
 */
function alivePid(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function createSetup({ cfgOf, setCfg, dataDir, log = () => {} }) {
  /** 我们自己拉起来的那个进程。DSH 重启后为 null，但 Roost 可能还在跑 */
  let child = null;
  let busy = '';
  /**
   * 上一次探活**真的应答了**的端口。
   *
   * 只用来让 `api()` / `webuiUrl()` 跟着探活结果走：Roost 的端口可能因为被占
   * 而漂到 `want+1`，这时配置端口上什么都没有，但面板其实活在另一个端口上。
   * 没探到东西时置回 null，退回「按配置算」。
   */
  let activePort = null;

  /**
   * 当前在用的 Roost 目录。
   *
   * **不再死认配置**：用户会移动目录（配置指着桌面、实际在别处）。
   * 这里走 resolveRoostDir()，端口、密钥、插件配置全都跟着真实安装位置。
   */
  const dirOf = () => resolveRoostDir().dir || join(dataDir(), 'roost');
  const versionOf = () => cfgOf().setup.version || 'v0.8.1';

  /** 比大小用的：把 "0.10.2" 拆成 [0,10,2] */
  const parseVer = (s) =>
    String(s || '')
      .replace(/^v/i, '')
      .split('.')
      .map((x) => Number(x.replace(/\D.*$/, '')) || 0);

  const newer = (a, b) => {
    const x = parseVer(a);
    const y = parseVer(b);
    for (let i = 0; i < 3; i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    }
    return 0;
  };

  /**
   * 问一次「现在最新是哪个版本」，**不要写死在配置里**。
   *
   * 为什么必须动态问：`setup.version` 是人手填的，发版时忘了改就会一直装旧版
   * （0.8.1 那个默认值就陈旧了很久，新机器装上去还带着一堆已修的 bug）。
   *
   * 顺序：npm → Gitee tags → 配置里那个。
   * npm 放第一是因为 `latest` 这个 dist-tag 是发布时明确指定的，
   * 而 Gitee tags 只能按版本号猜最大值（万一打了个预发布 tag 就会选错）。
   */
  async function resolveLatest() {
    const pick = (list) => list.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(newer).pop() || '';

    try {
      const r = await fetch('https://registry.npmjs.org/qq-bot-roost/latest', {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const j = await r.json();
        const v = String(j?.version || '');
        if (/^\d+\.\d+\.\d+$/.test(v)) return { version: v, from: 'npm' };
      }
    } catch {
      /* 问不到就换下一个源 */
    }

    try {
      const r = await fetch(`https://gitee.com/api/v5/repos/${REPO}/tags`, {
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const arr = await r.json();
        const v = pick((Array.isArray(arr) ? arr : []).map((t) => String(t?.name || '').replace(/^v/i, '')));
        if (v) return { version: v, from: 'gitee' };
      }
    } catch {
      /* 同上 */
    }

    return { version: versionOf().replace(/^v/i, ''), from: 'config' };
  }

  /** Roost 自己的全局配置（端口、密钥都在里面） */
  function roostGlobal() {
    try {
      return JSON.parse(readFileSync(join(dirOf(), 'config', 'bot.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Roost 面板的实际端口。
   *
   * 先看租约：Roost 端口被占时会自己换一个并写进租约，
   * 配置里的 webui.port 是「意愿」，不能直接当现实用。
   * 租约没有（旧版本 / 没换过）才退回配置值。
   */
  /**
   * dsh-roost 眼里「Roost 面板在哪」。
   *
   * **顺序必须和 Roost 自己一致：配置端口优先。**
   *
   * Roost 启动时从 `webui.port` 开始往后顺延找空位（`listenWithFallback`），
   * 它**从不读** `ports.json`；而这里原来是 `actual` 优先。两边各看各的后果是：
   * Roost 干净地回到配置端口，dsh-roost 还在旧 `actual` 上探 → 探空 →
   * 判定「没在跑」→ 再 spawn 一个 → 第二个进程 claim 同一个 AppID 失败。
   * 这就是「只配了一个机器人，却说已有实例在运行」的由来。
   *
   * `actual` 只在「配置里根本没写端口」时兜底，且它自己也会校验写入者的
   * pid 是否还活着（见 `lease.js` 的 `actualOf`）。
   *
   * 兜底值用 15207：Roost 主仓 2026-10-22（`f77121f`）把默认端口从 8080 改成了
   * 15207，这里之前没跟。配置里写了 port 就走不到这一档，只有「配置完全没有
   * webui.port」时才会用到——那种情况下 Roost 自己用的就是 15207。
   */
  function portOf() {
    const cfgPort = Number(roostGlobal().webui?.port) || 0;
    if (cfgPort > 0) return cfgPort;
    const leased = createLease({ file: join(dirOf(), 'data', 'ports.json') }).actualOf('roost');
    return leased || 15207;
  }

  /**
   * 探活时要**依次试**的端口。
   *
   * 只探「配置端口」不够：Roost 启动时从 `webui.port` 往后顺延找空位
   * （`listenWithFallback`），端口被占就漂到 +1 / +2。那一刻配置端口上什么也
   * 没有，探空 → 判定「没在跑」，接着三处一起出错：
   *   · `start()` 以为没在跑（还好有 instances.json 拦着，不至于再拉一个）
   *   · `stop()` 直接回「已停止」——**其实一个进程都没停**
   *   · `createBot()` 跳过重启 —— 新加的机器人永远不上线，界面上还说「配置好了」
   *
   * 所以按「配置端口 → 租约里记的实际端口 → 兜底」的顺序都探一遍，谁先应答算谁的。
   */
  function portCandidates() {
    const out = [];
    const push = (n) => {
      const v = Number(n);
      if (Number.isInteger(v) && v > 0 && v < 65536 && !out.includes(v)) out.push(v);
    };
    push(roostGlobal().webui?.port);
    try {
      // actualOf 内部会校验写租约的进程还活着（死进程留下的端口不算数）
      push(createLease({ file: join(dirOf(), 'data', 'ports.json') }).actualOf('roost'));
    } catch {}
    push(15207);
    return out;
  }
  function keyOf() {
    return String(roostGlobal().webui?.accessKey || '');
  }

  /**
   * Roost 那边认定的**主人 openid**（主动搭话要发给谁）。
   *
   * 为什么要读它：`speakUp.chatId` 是 dsh-roost 自己的一份配置，而
   * Roost 早就有一份更权威的——`<roost>/config/bots/<bot>.json` 的
   * `owners`。两边各填一次，必然出现「Roost 认得主人、DSH 这边说没配」
   * 的场面，而用户根本没有理由知道要填两遍。
   *
   * 位置是 `config/bots/*.json`，不是 `config/bot.json`：全局那份没有
   * `owners`，主人是**按 bot** 配的（一个 bot 一个 appId，主人也可能不同）。
   * 多个 bot 时优先 `main`。
   *
   * 缓存 5 秒：面板会轮询 `/speakup`，每次轮询都去 readdir + 读文件没必要；
   * 但也不能永久缓存——用户在 Roost 面板上加了主人，这边应该很快跟上。
   */
  let ownerCache = { at: 0, id: '' };
  function roostOwner() {
    const now = Date.now();
    if (ownerCache.at && now - ownerCache.at < 5_000) return ownerCache.id;

    let id = '';
    try {
      const base = join(dirOf(), 'config', 'bots');
      const files = readdirSync(base)
        .filter((f) => f.endsWith('.json'))
        .sort((a, b) => (a === 'main.json' ? -1 : b === 'main.json' ? 1 : a.localeCompare(b)));
      for (const f of files) {
        const c = JSON.parse(readFileSync(join(base, f), 'utf8'));
        const first = String(c?.owners?.[0] || '').trim();
        if (first) {
          id = first;
          break;
        }
      }
    } catch {
      /* 没装、没权限、格式不对 → 当作没有，让上层退回别的来源 */
    }
    ownerCache = { at: now, id };
    return id;
  }
  function baseUrl() {
    return `http://127.0.0.1:${activePort || portOf()}`;
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
    if (!res.ok) {
      const err = new Error(json?.error || json?.message || `HTTP ${res.status}`);
      /**
       * 状态码和响应体都带上。
       *
       * 只留一句 message 的话，调用方没法区分「409 这个 openid 已经绑给别人了」
       * 和「500 服务端炸了」——而这两者要做的事完全不同（前者问要不要改绑，
       * 后者只能报错）。`owner` 这类字段也只有带上 body 才拿得到。
       */
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /** 是不是在跑（直接问它自己） */
  /* ---------------- 定位 Roost 安装目录 ---------------- */

  /**
   * 这个目录是不是一份 Roost？
   *
   * 认三个特征，命中任意两个就算——只看 `package.json` 的话，
   * 用户改过名字（或从压缩包解出来）就认不出了。
   */
  function looksLikeRoost(dir) {
    if (!dir) return false;
    try {
      if (!existsSync(join(dir, 'src', 'main.js'))) return false;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      return pkg?.name === 'qq-bot-roost' || existsSync(join(dir, 'plugins'));
    } catch {
      return false;
    }
  }

  /**
   * 找到真正在用的那份 Roost。
   *
   * **只在没配的时候自动找。** 用户明确配了路径就认他配的——
   * 猜错了比不猜更糟（会把端口、密钥、插件配置全指向另一份实例，
   * 而且看起来一切正常）。配了但不像 Roost 时，如实返回 `dirOk: false`，
   * 让面板提示「路径不对，去设置里改」，而不是偷偷换一个。
   */
  function resolveRoostDir() {
    const configured = String(cfgOf().setup.roostDir || '').trim();
    if (configured) {
      return looksLikeRoost(configured)
        ? { dir: configured, how: '配置' }
        : { dir: configured, how: '配置的路径不是一份 Roost（缺 src/main.js 或 package.json）' };
    }

    const home = process.env.USERPROFILE || process.env.HOME || '';
    const candidates = [
      join(dataDir(), 'roost'),
      join(home, 'Desktop', 'qq-bot-roost'),
      join(home, 'qq-bot-roost'),
    ];
    for (const c of candidates) {
      if (looksLikeRoost(c)) {
        return { dir: c, how: c === join(dataDir(), 'roost') ? '一键安装目录' : '自动找到' };
      }
    }
    return { dir: join(dataDir(), 'roost'), how: '没配，也没找到现成的' };
  }

  /**
   * 问面板「你和你的机器人怎么样了」。
   *
   * **探 `/healthz`，不是 `/api/status`。** 面板设了访问密钥（`webui.accessKey`）
   * 之后，`/api/status` 走统一鉴权，不带 key 恒 401 ——「在跑」被判成「没在跑」，
   * 于是又 spawn 第二个。`/healthz` 在鉴权判断之前就应答（`server.js` 里它排在
   * `authorized()` 调用前面），专门用于探活。
   *
   * 返回 `{ok, bots:[{id,state}], online, total}`：
   *   · 面板活着、机器人也上线 → 200
   *   · 面板活着、机器人全掉线 → **503**（进程仍在！不能当「没在跑」）
   *   · 端口上是别的服务 / 连不上 → null
   *
   * 所以判定「在跑」是「拿到合法 body」，不是「HTTP 200」。
   */
  async function panelHealth() {
    for (const port of portCandidates()) {
      const body = await healthAt(port);
      if (body) {
        /**
         * 记下**真正应答的那个端口**，`api()` / `webuiUrl()` 之后都跟着它走。
         * 不记的话：Roost 漂到 15208、配置写 15207，探活能通过，但后面调
         * `/api/*` 仍然往 15207 发，全变成「没应答」。
         */
        activePort = port;
        return body;
      }
    }
    activePort = null;
    return null;
  }

  /** 问某个端口上的面板。应答了但不是本框架的东西（没有 bots 字段）返回 null */
  async function healthAt(port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (r.status !== 200 && r.status !== 503) return null;
      /**
       * 用 `text()` + JSON.parse，不用 `json()`：测试里替换掉的 fetch 假响应
       * 往往只实现 text()，调 json() 会直接 TypeError，症状是「Roost 明明在跑
       * 却判成 roost-down」——排查起来完全指不到这里。
       */
      const raw = await r.text().catch(() => '');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {}
      // 端口被别的 HTTP 服务占着时会返回别的 JSON，靠 bots 字段认出来
      return body && Array.isArray(body.bots) ? body : null;
    } catch {
      return null;
    }
  }

  /** 面板进程还活着吗（机器人上没上线不影响这个判断） */
  async function isRunning() {
    return (await panelHealth()) !== null;
  }

  /**
   * 把 `/healthz` 的结果翻译成「启动成没成功」。
   *
   * 三种情况：
   *   · 一只机器人都没配 → 算起来了。全新安装还没填 AppID 时没有「上线」可言，
   *     不这么判的话新用户会卡满 20 秒再收到一句莫名其妙的失败。
   *   · 至少一只是 online → 算起来了。
   *   · 面板在、机器人全掉线 → **不算起来**。这正是以前被放过的那种半死状态：
   *     面板能开，用户以为好了，其实机器人在哪都收不到消息。
   */
  function startVerdict(h) {
    if (!h.total) return { done: true, message: `起来了：${webuiUrl()}（还没配机器人）` };
    if (h.online > 0) return { done: true, message: `起来了：${webuiUrl()}（${h.online}/${h.total} 已上线）` };
    /**
     * 一只都没上线。分两种，别混成一句「去面板看日志」：
     *
     *   · 有机器人已经 `error` → 它不会再自愈（框架里 error 是终止态，
     *     没有自动重连），再等也是空等。把 `/healthz` 带回来的原因直接说出去
     *     （比如「AppID 102056878 已被 PID 28256 占用」）。
     *   · 还在 `starting` → 只是慢，继续轮询到 20 秒上限。
     */
    const dead = (Array.isArray(h.bots) ? h.bots : []).filter((b) => b?.state === 'error');
    if (dead.length) {
      const why = [...new Set(dead.map((b) => String(b?.error ?? '').trim()).filter(Boolean))]
        .slice(0, 2)
        .join('；');
      return {
        done: false,
        fail: true,
        message: why
          ? `面板起来了（${webuiUrl()}），但机器人没连上：${why}`
          : `面板起来了（${webuiUrl()}），但 ${dead.length} 只机器人报错退出——去面板看日志`,
      };
    }
    return {
      done: false,
      message: `面板起来了（${webuiUrl()}），但 ${h.total} 只机器人一只都没连上——去面板看日志里的报错`,
    };
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
    /**
     * **主人设了没有。**
     *
     * `owners` 是**每个 bot 一份**（`config/bots/<id>.json`），不是全局的——
     * 我一开始以为在 `config/bot.json` 里，找了半天。
     *
     * 面板上「主人与群组」那块改的就是这里，所以这个状态直接读磁盘最准。
     * 任一 bot 有主人就算设了——用户装一个机器人就够用了。
     */
    let ownerCount = 0;
    try {
      const bd = join(dir, 'config', 'bots');
      if (existsSync(bd)) {
        bots = readdirSync(bd)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              const j = JSON.parse(readFileSync(join(bd, f), 'utf8'));
              const owners = Array.isArray(j.owners) ? j.owners : [];
              ownerCount += owners.length;
              return {
                id: j.id || f.replace(/\.json$/, ''),
                name: j.name || '',
                appId: j.appId || '',
                ownerCount: owners.length,
              };
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    } catch {}

    return {
      dir,
      dirHow: resolveRoostDir().how,
      dirOk: looksLikeRoost(dir),
      version,
      installed,
      running,
      port: portOf(),
      accessKeySet: Boolean(keyOf()),
      webui: webuiUrl(),
      bots,
      /**
       * 有没有 bot **条目**。
       *
       * ⚠️ 别拿它判断「配好了没有」——全新装好的 Roost 本来就带一个
       * 「默认机器人（无 AppID）」，所以这个值一开始就是 true。
       * 判断凭证齐不齐要用下面的 `hasCreds`。
       */
      hasBot: bots.length > 0,
      /** 至少有一个 bot 真的填了 AppID */
      hasCreds: bots.some((b) => String(b?.appId || '').trim()),
      /** 主人在 Roost 面板里设了没有（读 config/bots/<id>.json 的 owners） */
      ownersConfigured: ownerCount > 0,
      ownerCount,
      /** 本插件固定服务的地址（/v1 控制面、TTS）。直连不需要对方来推消息 */
      dshUrl: `http://127.0.0.1:${cfgOf().server.port}`,
      /** 启动 DSH 时是否自动拉起 Roost（面板开关的状态来源） */
      roostAutoStart: Boolean(cfgOf().roostHost?.autoStart),
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

      /**
       * 装哪个版本：**自动问最新**，不用配置里那个手填的。
       * 配置里的值只在问不到时兜底（比如整台机器断网）。
       */
      const target = await resolveLatest();
      log(`目标版本 ${target.version}（来源：${target.from}）`);

      // 1) 下载（Gitee → npm → GitHub，见 SOURCES）
      let lastErr = null;
      let kind = 'zip';
      for (const src of SOURCES(target.version)) {
        try {
          log(`下载 ${src.url}`);
          const res = await fetch(src.url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
          kind = src.kind;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          log(`下载失败（${src.url}）：${e.message}`);
        }
      }
      if (lastErr) {
        throw new Error(
          `下载失败：${lastErr.message}。可以手动下载 ${target.version} 解压到 ${dir}`,
        );
      }

      // 2) 解压
      await unzip(tmp, stage, kind);

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
  async function createBot(opts = {}) {
    if (busy) throw new Error(`正在${busy}，等它完成`);
    busy = '写机器人配置';
    try {
      return await createBotOnce(opts);
    } finally {
      busy = '';
    }
  }

  async function createBotOnce({ name = 'main', appId, appSecret }) {
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

    /**
     * 写完要**重启 Roost** 才生效。
     *
     * 框架只在启动时读 `config/bots/*.json`，不重启的话新凭证根本没被加载，
     * 用户会看到「配置好了」但群里一点反应都没有——这种"成功了却没生效"
     * 比直接报错更难查。
     *
     * 重启失败不算致命：配置已经落盘，用户手动重启也能好，所以只记日志。
     */
    let restarted = false;
    try {
      if (await isRunning()) {
        // 走 *Once：createBot 自己占着 busy，再过一次闸门会撞上它自己
        await stopOnce();
        await startOnce();
        restarted = true;
        log('已重启 Roost，新凭证生效');
      }
    } catch (e) {
      log(`保存后重启失败（配置已写入，手动重启也能生效）：${e?.message ?? e}`);
    }

    return {
      ok: true,
      message: restarted ? `机器人 ${name} 配置好了，Roost 已重启` : `机器人 ${name} 配置好了`,
      webui: webuiUrl(),
      restarted,
    };
  }

  /* ---------------- 起停 ---------------- */

  /**
   * 读 Roost 自己的实例表，找出「还在跑、且不是我这个进程」的 Roost。
   *
   * **为什么用实例表而不是 HTTP 探活**：端口可能刚改过、可能被别的程序占着、
   * 密钥可能刚设置过——探不通不等于没在跑。而实例表是 Roost 自己写的，
   * 里面记的 pid 还活着，就说明那个 Roost 真的在跑。这条判断不依赖网络。
   *
   * @returns {Array<{appId:string, pid:number}>} 可能为空
   */
  function liveRoostPids() {
    let data;
    try {
      data = JSON.parse(readFileSync(join(dirOf(), 'data', 'instances.json'), 'utf8'));
    } catch {
      return []; // 没这个文件、或写坏了 —— 当作没有实例
    }
    if (!data || typeof data !== 'object') return [];
    const out = [];
    for (const [appId, rec] of Object.entries(data)) {
      const pid = Number(rec?.pid);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (alivePid(pid)) out.push({ appId, pid });
    }
    return out;
  }

  /** 杀掉我们自己拉起来的进程。停不掉也不抛——调用方本来就在错误路径上 */
  function killChild() {
    if (!child) return;
    try {
      child.kill();
    } catch {}
    child = null;
  }

  /**
   * 启动。外面这层只管并发闸门：连点两下「启动」不该 spawn 出两个进程。
   */
  async function start() {
    if (busy) throw new Error(`正在${busy}，等它完成`);
    busy = '启动';
    try {
      return await startOnce();
    } finally {
      busy = '';
    }
  }

  /**
   * 真正的一次启动。**成功判据分三层**，不再是「面板能开就算起来了」：
   *
   *   ① 起之前：实例表里还有活着的 Roost → 直接拒绝，**不 spawn**。
   *      这道最可靠：不看端口、不看密钥，只问进程。
   *   ② 起来了：面板应答，**且**机器人至少一只 online（或根本没配机器人）。
   *   ③ 面板在、机器人全掉线：**保留进程**，返回 `ok:false` 说明原因。
   *      不 kill 是因为面板正是用户唯一的排查入口，杀掉等于把线索一起删了。
   *
   * 只有「20 秒内面板一次都没应答」才 kill：那种进程要么卡在启动里、
   * 要么端口都没绑上，留着只占端口，而且用户拿它没办法（`--no-open` 没有控制台）。
   */
  async function startOnce() {
    if (await isRunning()) return { ok: true, message: '已经在跑了' };
    if (!existsSync(join(dirOf(), 'src', 'main.js'))) throw new Error('还没装，先点安装');

    const live = liveRoostPids();
    if (live.length) {
      const who = live.map((x) => `PID ${x.pid}（AppID ${x.appId}）`).join('、');
      throw new Error(
        `已经有一个 Roost 在跑：${who}。先停掉它再启动；面板「设置 → 实例锁」能看到详情并清理残留记录`,
      );
    }

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
    let panel = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!child) throw new Error('Roost 启动后马上退出了。看它的日志：可能缺 AppID/AppSecret，或端口被占');
      panel = await panelHealth();
      if (!panel) continue;
      const verdict = startVerdict(panel);
      if (verdict.done) return { ok: true, message: verdict.message };
      /**
       * 机器人已经 `error` 就**立刻返回**，不要等满 20 秒。
       *
       * 框架里 `error` 是终止态（没有自动重连），等下去只是空转：面板显示
       * 「起来了」，用户却要盯着转圈 20 秒才收到一句「去面板看日志」。
       * 2026-11-13 实机：实例锁被上一条残留记录占着，spawn 后 6 秒就 error，
       * 却硬等到第 40 次轮询才报错。现在把原因（`/healthz` 的 `error` 字段）
       * 一起带出来，用户能直接看到「AppID 被 PID xxx 占用」。
       */
      if (verdict.fail) return { ok: false, message: verdict.message };
    }

    if (!panel) {
      killChild();
      throw new Error('等了 20 秒面板还没起来，进程已结束。去目录里手动跑 node src/main.js 看报什么错');
    }
    // 面板活着，机器人没连上：留着进程，把状态如实返回
    const verdict = startVerdict(panel);
    return { ok: false, message: verdict.message };
  }

  /** 停一个进程。**跨平台差别很大**，见下面两条注释 */
  function termPid(pid) {
    if (process.platform === 'win32') {
      /**
       * Windows 上没有 POSIX 信号：`process.kill(pid, 'SIGTERM')` 的 signal 参数
       * 会被忽略，直接强杀（等同 SIGKILL）——Roost 来不及 releaseInstance，
       * 留下一堆脏记录。所以先发 `taskkill`（不带 /F，等于请它自己关）。
       * 控制台程序大多不响应，抛错是正常的，交给强杀兜底。
       */
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore', timeout: 5000 });
      } catch {}
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      log(`停 PID ${pid} 失败：${e.message}`);
    }
  }

  /** 强杀。Unix 上给 SIGKILL，Windows 用 taskkill /F */
  function forceKillPid(pid) {
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
      } catch {}
      return;
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }

  /**
   * 停止。
   *
   * 以前只 kill 自己手里的 `child`。可是 DSH 重启之后那个变量是 null，
   * 而 Roost 还在跑 —— 于是提示「请到它的控制台关掉」，可 `--no-open` 起的
   * 进程**根本没有控制台**，用户被卡在死循环里。现在补一条：手里没有 child、
   * 但面板确实活着时，按实例表里的 pid 去停。
   */
  async function stop() {
    if (busy) throw new Error(`正在${busy}，等它完成`);
    busy = '停止';
    try {
      return await stopOnce();
    } finally {
      busy = '';
    }
  }

  /** 停止的实际动作。`createBot` 重启时直接用这个，不能再过闸门（会撞上它自己的 busy） */
  async function stopOnce() {
    killChild();
    if (!(await isRunning())) return { ok: true, message: '已停止' };

    /**
     * 先礼后兵：SIGTERM / taskkill（不带 /F）→ 等 3 秒 → 还活着就强杀。
     *
     * 为什么不直接强杀：Roost 收到优雅终止会 releaseInstance、把 instances.json
     * 写干净。强杀会留下「PID xxx 还占着这个 AppID」的脏记录——那正是这次
     * 那个莫名其妙的 PID 的成因之一。脏记录虽然会在下次启动时被剪掉，
     * 但面板上看着就像有个幽灵进程。
     */
    const targets = liveRoostPids();
    for (const { pid } of targets) termPid(pid);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isRunning())) return { ok: true, message: '已停止' };
    }

    for (const { pid } of liveRoostPids()) forceKillPid(pid);
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isRunning())) return { ok: true, message: '已停止（进程没响应退出请求，已强制结束）' };
    }

    const left = liveRoostPids().map((x) => `PID ${x.pid}`).join('、');
    return {
      ok: false,
      message: left
        ? `停不下来：${left} 还活着。可能是别的用户开的，或者需要管理员权限`
        : '面板还在应答，但实例表里没有对应记录。它可能是别的程序占着这个端口',
    };
  }

  /**
   * 扫码建机器人：**转发给框架**，不在插件里重实现。
   *
   * 框架面板有 `/api/bots/qr/start` 和 `/api/bots/qr/poll`，
   * 协议、bindKey、解密、二维码全在那边。这里只做透传——
   * 一份实现两处用，插件不用跟着改协议（也不该存 bindKey）。
   *
   * 前提：Roost 得在跑（框架 0.8.4+ 才有这两个接口）。
   */
  async function qrStart() {
    if (!(await isRunning())) throw new Error('Roost 没在跑，先启动（扫码要用它的接口）');
    return api('/api/bots/qr/start', { method: 'POST', body: '{}' });
  }

  async function qrPoll(taskId) {
    if (!(await isRunning())) throw new Error('Roost 没在跑，先启动');
    if (!taskId) throw new Error('缺 taskId');
    return api('/api/bots/qr/poll', { method: 'POST', body: JSON.stringify({ taskId }) });
  }

  return {
    detect,
    /** 面板探活：外接协议客户端据此决定「要不要现在就去连」 */
    isRunning,
    qrStart,
    qrPoll,
    install,
    setDir,
    createBot,
    start,
    stop,
    webuiUrl,
    /** 面板根地址（不带 key），拼别的接口用 */
    baseUrl,
    /**
     * 带 key 请求 Roost 面板 API。
     *
     * 暴露出去是为了「账号迁移」页（`src/account.js`）——
     * 它要代理 `/api/identity/*` 和 `/api/bots`。这些请求必须带上 key，
     * 而 key 只在这边有；让调用方自己拼 URL 迟早会漏掉鉴权。
     */
    api,
    /** Roost 配置里的主人 openid（主动搭话的收件人）。空 = 那边也没配 */
    roostOwner,
    /** 面板密钥的 query 片段，没有就是空串 */
    keyQuery: () => (keyOf() ? `?key=${encodeURIComponent(keyOf())}` : ''),
    get busy() {
      return busy;
    },
  };
}
