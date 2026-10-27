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

export function createSetup({ cfgOf, setCfg, dataDir, log = () => {} }) {
  /** 我们自己拉起来的那个进程。DSH 重启后为 null，但 Roost 可能还在跑 */
  let child = null;
  let busy = '';

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
  function portOf() {
    const leased = createLease({ file: join(dirOf(), 'data', 'ports.json') }).actualOf('roost');
    return leased || Number(roostGlobal().webui?.port) || 8080;
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
   * 从磁盘读某个插件的配置。
   *
   * 为什么要读文件：Roost 的 `/api/plugins/<id>/config` **只实现了 PUT，GET 返回 404**，
   * 列表接口又**不带 config**。所以除了翻磁盘没别的可靠来源。
   * 位置是 **`<roost>/config/bots/<bot>/plugins/<id>.json`**
   * （老版本可能在 `data/bots/...`，两个都试），多个 bot 时优先 main。
   */
  function readPluginConfigFromDisk(id) {
    const { dir } = resolveRoostDir();
    if (!dir) return null;
    /**
     * 配置在 `config/bots/...` 下（loader.js 的 paths.pluginConfig）。
     * 我第一版写成 `data/bots/...` —— 结果明明切换成功了也读不到，
     * 白让用户以为没生效。老版本可能用 data/，两个都试。
     */
    for (const root of ['config', 'data']) {
      const botsDir = join(dir, root, 'bots');
      let botIds = [];
      try {
        botIds = readdirSync(botsDir);
      } catch {
        continue;
      }
      // main 排前面
      botIds.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : 0));
      for (const bot of botIds) {
        try {
          const p = join(botsDir, bot, 'plugins', `${id}.json`);
          if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
        } catch {}
      }
    }
    return null;
  }

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

    const pluginInstalled = installed && existsSync(join(dir, 'plugins', 'ai-chat', 'index.js'));

    let pluginConfig = null;
    if (running) {
      /**
       * 读插件配置有三条路，按可靠程度排：
       *
       * 1. `GET /api/plugins/<id>/config` —— **Roost 只实现了 PUT，GET 是 404**，
       *    试一下就行，将来支持了自动用上。
       * 2. **直接读磁盘**：`<roost>/data/bots/<bot>/plugins/<id>.json`。
       *    这是权威来源，面板上看到的就是它。
       * 3. 列表接口 —— 它**不带 config**，只能算兜底。
       *
       * 之前只走第 3 条，等于永远读不到 adapter，所以「切成功了却一直不显示完成」。
       */
      try {
        const one = await api('/api/plugins/ai-chat/config');
        pluginConfig = one?.config ?? one ?? null;
      } catch {}

      if (!pluginConfig) pluginConfig = readPluginConfigFromDisk('ai-chat');

      if (!pluginConfig) {
        try {
          const pl = await api('/api/plugins');
          const arr = pl?.plugins ?? pl ?? [];
          const one = Array.isArray(arr) ? arr.find((p) => p.id === 'ai-chat') : null;
          pluginConfig = one?.config ?? null;
        } catch {}
      }
    }

    const configured = Boolean(pluginConfig && pluginConfig.adapter === 'dsh');

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
      pluginInstalled,
      pluginConfigured: configured,
      pluginConfig: pluginConfig
        ? {
            adapter: pluginConfig.adapter,
            dshUrl: pluginConfig.dshUrl,
            publicUrl: pluginConfig.publicUrl,
            apiKey: pluginConfig.apiKey ? '******' : '',
            /**
             * 只读地把它露出来：功能页要显示「语音条开没开」。
             *
             * 音色本来就只能在这边填（ai-chat 的配置），面板能读到状态就不用
             * 再写一段「去插件设置里填 xxx」的跨插件教程——那种指引最容易过期。
             */
            ttsVoice: pluginConfig.ttsVoice ?? '',
          }
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
        await stop();
        await start();
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
  /**
   * 把 ai-chat 的「DSH 地址」同步成当前端口。
   *
   * **为什么需要**：用户在设置里改了 `server.port`，服务重起后监听新端口，
   * 但 ai-chat 那边还指着旧端口——消息推过来全是 connection refused，
   * 而且没有任何报错提示。这是个静默断链，必须主动补。
   *
   * 只在 ai-chat 已经配过（adapter=dsh 或有 dshUrl）时才改，
   * 不擅自把一个没配过的插件改成 DSH 模式。
   */
  async function syncDshUrl(portOverride) {
    // 传了端口就用传的（实际 bind 成功的那个），否则用配置里的
    const want = `http://127.0.0.1:${portOverride || cfgOf().server.port}`;

    /**
     * Roost 没跑就**不算失败**，直接跳过。
     *
     * 启动瞬间两边谁先起来不确定，dsh-roost 常常先起——
     * 那时候 Roost 还没监听，这里报「没同步」只会让用户以为出了问题。
     * 等 Roost 起来后再点第 5 步、或者下次保存配置时自然会同步。
     */
    if (!(await isRunning())) {
      return { ok: true, skipped: true, message: 'Roost 还没起来，等它起来再说' };
    }

    /**
     * 读当前配置**必须翻磁盘**，不能 GET。
     *
     * Roost 的 `/api/plugins/<id>/config` **只实现了 PUT，GET 返回 404**，
     * 之前这里用 GET，一抛错就 return「ai-chat 没在跑，跳过同步」——
     * 于是端口换了却永远同步不过去，面板红字一直说「对不上」。
     */
    const cur = readPluginConfigFromDisk('ai-chat');
    if (!cur) return { ok: true, skipped: true, message: '还没读到 ai-chat 的配置（可能还没装）' };
    if (cur.adapter !== 'dsh' && !cur.dshUrl) return { ok: true, skipped: true, message: 'ai-chat 没在用 DSH，不用改' };
    if (cur.dshUrl === want) return { ok: true, message: '已经是当前端口' };

    await api('/api/plugins/ai-chat/config', { method: 'PUT', body: JSON.stringify({ dshUrl: want }) });
    return { ok: true, message: `ai-chat 的 DSH 地址已改成 ${want}`, from: cur.dshUrl, to: want };
  }

  async function configurePlugin(portOverride) {
    if (!(await isRunning())) throw new Error('Roost 没在跑，先启动');
    const patch = {
      adapter: 'dsh',
      // 用**实际**监听的端口，不是配置里的——端口被占时会顺延，
      // 写成配置值的话 ai-chat 会一直往那个连不上的端口推
      dshUrl: `http://127.0.0.1:${portOverride || cfgOf().server.port}`,
      publicUrl: baseUrl(),
      // 交给 DSH 之后，本插件说了算，别让 AI 再按「只在被 @ 时说话」缩着
      decide: 'ai',
    };
    /**
     * 写完之后**用 PUT 的返回核对**。
     *
     * 不能再去 GET 一遍：Roost 的 `/api/plugins/<id>/config` **只实现了 PUT**，
     * GET 是 404 —— 之前就是因此误判成「写进去了但读回来是空」，
     * 其实早就写成功了。PUT 的响应里带着合并后的完整 config，够用来核对。
     */
    const res = await api('/api/plugins/ai-chat/config', { method: 'PUT', body: JSON.stringify(patch) });
    const back = res?.config ?? null;
    const actual = back?.adapter;
    if (back && actual !== 'dsh') {
      throw new Error(
        `写进去了但返回的 adapter=${actual ?? '空'}。`
        + '可能这个版本的 ai-chat 配置里没有 adapter 这一项，去 Roost 面板 → 插件 → ai-chat → 设置里手动改一下。',
      );
    }

    return {
      ok: true,
      message: `ai-chat 已切到 DSH 适配器（dshUrl=${back?.dshUrl || patch.dshUrl}）`,
      patch,
      config: back ? { adapter: back.adapter, dshUrl: back.dshUrl } : null,
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
    qrStart,
    qrPoll,
    install,
    syncDshUrl,
    setDir,
    createBot,
    start,
    stop,
    installPlugin,
    configurePlugin,
    webuiUrl,
    /** 面板根地址（不带 key），拼别的接口用 */
    baseUrl,
    /** 面板密钥的 query 片段，没有就是空串 */
    keyQuery: () => (keyOf() ? `?key=${encodeURIComponent(keyOf())}` : ''),
    get busy() {
      return busy;
    },
  };
}
