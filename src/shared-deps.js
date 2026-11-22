/**
 * 宿主级共享依赖（`deps/`）
 * ============================================================
 *
 * 有些依赖不是某个扩展私有的：`ffmpeg` 既能给 B 站扩展抽帧，也能给
 * 以后的语音转码、图片处理用。让每个扩展各装一份 62 MB，是纯粹的浪费，
 * 而且用户点三次「一键安装」就得等三遍。
 *
 * 所以装在这里：`<dataDir>/deps/`，跟着宿主数据目录走——
 *
 *   · 升级扩展不丢（扩展目录会被覆盖，宿主数据目录不会）；
 *   · 卸载扩展不删（别的扩展还要用）；
 *   · 一份装了全部复用（框架自己的功能也走 `ffmpegBinary()`）。
 *
 * 两个必须记住的坑：
 *
 *   1. **主包只有 24 KB 胶水代码**。62 MB 的 `ffmpeg.exe` 在同版本的
 *      平台子包（`@ffmpeg-installer/win32-x64`）里。`--omit=optional`、
 *      杀毒隔离、装到一半断电，都会留下「主包在、二进制没了」的半坏状态。
 *      所以判定「能不能用」永远以**可执行文件在不在**为准，不看
 *      `require.resolve`。
 *   2. **只装白名单**。面板上能点的东西如果能让机器执行任意包，那面板
 *      被改一下就等于交出了整台机器。白名单是这条链路的唯一闸门。
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join, delimiter, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { dataDir } from './config.js';
import { registryArgs } from './npm-registry.js';
import { installFromMirror } from './mirror-deps.js';

/**
 * 本模块所在目录（`src/`）。宿主自己的 `node_modules` 在它的上一级。
 *
 * 用 `import.meta.url` 而不是 `process.cwd()`：宿主可能被 DSH 从任意工作目录
 * 启动，`cwd()` 指向用户的项目目录，拿它拼 `node_modules` 会去翻错地方。
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = dirname(SRC_DIR);

/**
 * 允许安装的包。加新包前先想清楚：它有没有 postinstall 脚本？
 * 会不会在安装时执行任意代码？有脚本的一律不要——`--ignore-scripts`
 * 装不上，去掉 `--ignore-scripts` 就等于让 npm 跑别人的代码。
 *
 * `@ffmpeg-installer/*` 的平台子包把静态二进制直接打进 tarball，
 * 没有 postinstall，所以能安全地装在 `--ignore-scripts` 下。
 */
export const WHITELIST = Object.freeze({
  '@ffmpeg-installer/ffmpeg': {
    range: '^1.1.0',
    size: '~62MB',
    group: 'media',
    desc: '视频抽帧、音频转码',
  },
  /**
   * 二维码生成（B 站扫码登录用）。纯 JS、无安装脚本，`--ignore-scripts`
   * 装得上；用的是 `create()` 只取位矩阵，不碰它画图那部分。
   *
   * 扩展那边是「装了就优先用、没装就用内置兜底」，所以这个包缺失不会
   * 让扫码不可用，只是版本上限低一些。
   */
  qrcode: {
    range: '^1.5.4',
    size: '~1.6MB（含传递依赖）',
    group: 'misc',
    desc: '生成二维码（扫码登录）',
  },
  /**
   * ## 为什么这里没有 `jimp`
   *
   * 曾经加过（`^1.6.1`，约 15MB / 27 个子包），描述里写着「解锁感知哈希去重 /
   * 真缩略图 / 拼长图」。但那三件**一件都没实现**：`load()` 在宿主里没有调用方，
   * 两仓 grep `jimp` 也找不到消费者。
   *
   * 一个 15MB 的「安装」按钮，点完什么都不变，是最伤信任的那类假功能——用户
   * 会以为「装了就有的能力没生效」，然后来找人问。所以整条撤掉。
   *
   * **要加回来，先让消费者落地**（图库的去重/缩略图/拼图），再把这行加回去，
   * 并同时补上「没装时怎么降级」的测试。顺序反了就是又一次广告位。
   */
});

const FFMPEG = '@ffmpeg-installer/ffmpeg';

/** 装在哪：跟着宿主数据目录，升级/卸载扩展都不动它 */
export function depsDir() {
  return join(dataDir(), 'deps');
}

/**
 * 已安装扩展的目录（宿主启动时、以及每次装/卸扩展后注入）。
 *
 * **为什么不在本模块里直接去问 `ext-registry`**：那会让「依赖」这一层依赖
 * 「扩展注册表」，而注册表自己要用 config、要读磁盘清单；哪天注册表也想
 * 用一下 ffmpeg，就成了循环依赖。所以走注入——谁手里有清单，谁告诉我。
 *
 * 每项 `{ id, dir }`（`dir` 是扩展根目录）。扩展可能以两种布局放依赖：
 *   · `<dir>/node_modules/<pkg>`      —— 扩展自带 package.json，框架装好的
 *   · `<dir>/deps/node_modules/<pkg>` —— 宿主注入 `ROOST_DEPS_DIR` 的那份
 */
let extDirs = [];

/** 找过的结论缓存：面板可能每秒问一次，别反复读盘 */
const foundCache = new Map();

/** 已加载的模块（`remove()` 之后要清，否则「卸载了还能用」） */
const loaded = new Map();

/** 从任意目录解析包用；不占用宿主自己的模块查找路径 */
const reqAny = createRequire(import.meta.url);

/**
 * 注入已安装扩展目录，返回生效条数。
 *
 * 传 `[]` / `null` 表示清空。**目录变了必须清缓存**——否则「在扩展 A 里
 * 找到过 jimp」这个结论会一直留着，卸载 A 之后仍然说「有」。
 */
export function setExtDirs(list) {
  extDirs = (Array.isArray(list) ? list : [])
    .map((x) => ({ id: String(x?.id ?? '').trim(), dir: String(x?.dir ?? '').trim() }))
    .filter((x) => x.id && x.dir);
  foundCache.clear();
  loaded.clear();
  return extDirs.length;
}

/** 当前注入的扩展目录（面板要显示「这些目录也找过了」） */
export function extDirsSnapshot() {
  return extDirs.map((x) => ({ ...x }));
}

/**
 * 所有可能装着包的根目录，**顺序即优先级**。
 *
 * 共享目录优先：那是面板装的地方，用户以为「装在这里」。扩展目录排后面
 * 只作兜底复用，为的是「明明扩展里已经有一份，别再让用户下一遍 15MB」。
 * 宿主自身排最后：那条只在开发机（仓库根跑过 npm i）上才可能命中。
 */
function candidateDirs() {
  const out = [{ kind: 'shared', id: '', dir: depsDir(), label: '共享依赖目录' }];
  for (const e of extDirs) {
    out.push({ kind: 'ext', id: e.id, dir: e.dir, label: `扩展 ${e.id}` });
    out.push({ kind: 'ext', id: e.id, dir: join(e.dir, 'deps'), label: `扩展 ${e.id} / deps` });
  }
  out.push({ kind: 'host', id: '', dir: HOST_ROOT, label: '宿主自身' });
  return out;
}

/**
 * 某个根目录下这个包在不在：在就返回版本号，不在返回空串。
 *
 * **只认「能读出 version 的 package.json」**，不认目录存在就算。装到一半
 * 断电、杀毒隔离都会留下空壳目录；把它判成「已装」比判成「没装」更害人
 * ——用户点安装没反应，因为面板以为已经好了。
 */
function versionAt(dir, name) {
  try {
    return String(JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/**
 * 找包：返回第一个装着它的根目录。
 *
 * @param {string} name 必须在 WHITELIST 里（不在的一律 null，防止拿它当通用文件探测器）
 * @param {{fresh?: boolean}} [o] `fresh` 跳过缓存（刚装/刚卸完用）
 * @returns {{kind:'shared'|'ext'|'host', id:string, dir:string, label:string,
 *            version:string, path:string}|null}
 */
export function findPackage(name, { fresh = false } = {}) {
  const pkg = String(name ?? '').trim();
  if (!Object.hasOwn(WHITELIST, pkg)) return null;
  if (!fresh && foundCache.has(pkg)) return foundCache.get(pkg);

  let hit = null;
  for (const c of candidateDirs()) {
    const version = versionAt(c.dir, pkg);
    if (!version) continue;
    hit = { ...c, version, path: join(c.dir, 'node_modules', pkg) };
    break;
  }
  foundCache.set(pkg, hit);
  return hit;
}

/**
 * 扫描全部白名单包 × 全部候选目录。
 *
 * **给面板画图用**，不是给程序判断用的：程序判断「能不能用」请走
 * `findPackage()` / `load()`，那两处有同一套优先级和缓存。
 */
export function scan() {
  const dirs = candidateDirs().map((c) => ({ kind: c.kind, id: c.id, dir: c.dir, label: c.label }));
  const packages = {};
  for (const [name, meta] of Object.entries(WHITELIST)) {
    foundCache.delete(name);
    const hits = [];
    for (const c of dirs) {
      const version = versionAt(c.dir, name);
      if (version) hits.push({ ...c, version });
    }
    packages[name] = {
      ...meta,
      found: hits[0] ?? null,
      hits,
      /**
       * 只有共享目录那份归面板管。扩展目录/host 目录里的是别人的，
       * 面板只能显示「在那儿有一份」，不能替它删。
       */
      removable: hits.some((x) => x.kind === 'shared'),
    };
  }
  return { dir: depsDir(), dirs, packages };
}

/**
 * 加载一个白名单包。**没装、装了但加载失败，都返回 `null`，绝不抛。**
 *
 * 调用方一律按「缺这个能力」降级——图库少了 jimp 只是不做去重和缩略图，
 * 不该让整个面板或一条消息处理崩掉。这也是 `bot/src/ext-deps.js:566` 的姿势。
 *
 * 解析用 `reqAny.resolve(pkg, { paths: [命中目录] })`：**从包实际所在的目录
 * 往上找 node_modules**，而不是靠宿主自己的模块路径。否则「扩展目录里有一份」
 * 这种情况永远加载不到——那正是本函数支持多目录的意义。
 */
export async function load(name, { fresh = false } = {}) {
  const pkg = String(name ?? '').trim();
  if (!Object.hasOwn(WHITELIST, pkg)) return null;
  if (!fresh && loaded.has(pkg)) return loaded.get(pkg);
  loaded.delete(pkg);

  const hit = findPackage(pkg, { fresh });
  if (!hit) {
    loaded.set(pkg, null);
    return null;
  }

  let mod = null;
  try {
    const abs = reqAny.resolve(pkg, { paths: [hit.dir] });
    try {
      mod = reqAny(abs);
    } catch (e) {
      const code = String(e?.code ?? '');
      if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE') {
        /* 双格式包（jimp 就是）也可能只给了 import 入口，这时按 ESM 再试一次 */
        mod = await import(pathToFileURL(abs).href);
      } else {
        throw e;
      }
    }
  } catch {
    /* 静默：本模块没有日志通道，而「加载失败」的语义就是「当作没有」。
       真要排查的话，面板的「功能包」页会显示它到底在哪、版本多少。 */
    mod = null;
  }
  loaded.set(pkg, mod);
  return mod;
}

/**
 * 扫「别的运行时目录」——**只读，不装不卸**。
 *
 * 宿主有些依赖不走白名单：语音引擎装在自己的 `dataDir/tts-runtime`、
 * 微软那套在线 TTS 装在自己的 `dataDir/tts-edge`，各有各的安装器与进度条
 * （`tts-install.js`）。把它们硬塞进这里的安装流程，等于两套 npm 逻辑
 * 互相踩，还会让「谁在装」有两个真相。
 *
 * 所以功能包页只把它们**列出来**：有这个目录、里面有哪些包、去哪管。
 * 这样用户在一页里能看全「本体到底装了什么」，但动手还是回各自的页面。
 *
 * @param {{id:string,label:string,dir:string}[]} list 由 host 决定要看哪些目录
 */
export function runtimeScan(list = []) {
  return (Array.isArray(list) ? list : []).map((x) => {
    const dir = String(x?.dir ?? '');
    const nm = join(dir, 'node_modules');
    /** 顶层条目；`@scope` 展开一层，否则只会看到 `@sherpa` 这种没信息量的名字 */
    const names = [];
    try {
      for (const e of readdirSync(nm, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.name.startsWith('@') && e.isDirectory()) {
          try {
            for (const s of readdirSync(join(nm, e.name), { withFileTypes: true })) {
              if (s.isDirectory() && !s.name.startsWith('.')) names.push(`${e.name}/${s.name}`);
            }
          } catch { /* 权限/竞态：跳过这一个 scope */ }
          continue;
        }
        if (e.isDirectory()) names.push(e.name);
        if (names.length >= 20) break;
      }
    } catch { /* 目录不存在 = 没装，正常 */ }
    return {
      id: String(x?.id ?? ''),
      label: String(x?.label ?? ''),
      dir,
      exists: names.length > 0,
      packages: names.slice(0, 20),
    };
  });
}

/**
 * 卸载共享目录里的包。
 *
 * **只删共享目录那一份**。如果包只存在于扩展目录，返回失败并说明它在哪——
 * 那是扩展自己的依赖，面板替它删会把扩展弄坏。`name` 必须先过白名单，
 * 这样拼路径时不可能出现 `../`。
 */
export function remove(name) {
  const pkg = String(name ?? '').trim();
  if (!Object.hasOwn(WHITELIST, pkg)) {
    return { ok: false, name: pkg, message: `不在白名单里：${pkg || '(空)'}` };
  }
  if (!versionAt(depsDir(), pkg)) {
    const elsewhere = findPackage(pkg, { fresh: true });
    return {
      ok: false,
      name: pkg,
      message: elsewhere
        ? `共享目录里没有，但「${elsewhere.label}」里有一份（${elsewhere.version}）。那份不归面板管，要删得去那个目录`
        : '共享目录里没有装这个包',
    };
  }

  try {
    rmSync(join(depsDir(), 'node_modules', pkg), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, name: pkg, message: `删除失败：${e?.message ?? e}（可能正被占用，重启宿主后再试）` };
  }

  /**
   * 从 `package.json` 里摘掉。不摘的话下次装别的包时 npm 会按这份清单把它
   * 装回来——用户会看到「卸载了，刷新又有了」这种鬼故事。
   */
  try {
    const file = join(depsDir(), 'package.json');
    const cur = JSON.parse(readFileSync(file, 'utf8'));
    if (cur?.dependencies && Object.hasOwn(cur.dependencies, pkg)) {
      delete cur.dependencies[pkg];
      writeFileSync(file, `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
    }
  } catch { /* 手装的包没有 package.json，很正常 */ }

  resetCache();
  return { ok: true, name: pkg, message: '已卸载' };
}

/** 平台子包目录名；不认识的平台返回空串 */
function platformDir() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  return '';
}

/**
 * ffmpeg 可执行文件的绝对路径；没装 / 平台不认识返回空串。
 *
 * **不 spawn**：面板每秒都可能问一次状态，起进程太贵。
 * 「能不能真跑」由第一次真正用到它的时候暴露。
 *
 * @param {{fresh?: boolean}} [o] `fresh` 丢掉缓存重看磁盘（刚装完用）
 */
let ffmpegCache; // undefined=没查过；''=没有；string=路径
export function ffmpegBinary({ fresh = false } = {}) {
  if (fresh) ffmpegCache = undefined;
  if (ffmpegCache !== undefined) return ffmpegCache;

  const plat = platformDir();
  if (!plat) {
    ffmpegCache = '';
    return ffmpegCache;
  }
  const base = join(depsDir(), 'node_modules', '@ffmpeg-installer', plat);
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const p = join(base, exe);
  ffmpegCache = existsSync(p) ? p : '';
  return ffmpegCache;
}

/** 已装包读到版本；没装返回空串 */
function installedVersion(name) {
  const file = join(depsDir(), 'node_modules', name, 'package.json');
  try {
    return String(JSON.parse(readFileSync(file, 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/**
 * 系统 PATH 上的 ffmpeg；没有返回空串。
 *
 * 用户很可能已经用 apt / brew / choco / scoop 装过系统级 ffmpeg，
 * 再为它下 62MB 的 npm 包纯属浪费。这里只**扫 PATH 目录**看可执行文件
 * 在不在，不 spawn——面板随时可能问状态，起进程太贵。
 *
 * @param {{fresh?: boolean}} [o]
 * @returns {string}
 */
let systemFfmpegCache; // undefined=没查过；''=没有；string=路径
export function systemFfmpeg({ fresh = false } = {}) {
  if (fresh) systemFfmpegCache = undefined;
  if (systemFfmpegCache !== undefined) return systemFfmpegCache;

  const names = process.platform === 'win32'
    ? ['ffmpeg.exe', 'ffmpeg.cmd', 'ffmpeg.bat']
    : ['ffmpeg'];
  const dirs = String(process.env.PATH || process.env.Path || '')
    .split(delimiter)
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

  for (const d of dirs) {
    for (const n of names) {
      const p = join(d, n);
      if (existsSync(p)) {
        systemFfmpegCache = p;
        return p;
      }
    }
  }
  systemFfmpegCache = '';
  return '';
}

/**
 * 这次该用哪个 ffmpeg：**装好的那份优先，其次系统 PATH**。
 *
 * 装好的那份是平台子包里的静态二进制，版本行为都确定；系统那份不可控但
 * 能省 62MB。调用方要的是「能转码就行」，两份都算数。
 *
 * @param {{fresh?: boolean}} [o]
 * @returns {{path: string, source: 'managed'|'system'|''}}
 */
export function resolveFfmpeg({ fresh = false } = {}) {
  const own = ffmpegBinary({ fresh });
  if (own) return { path: own, source: 'managed' };
  const sys = systemFfmpeg({ fresh });
  if (sys) return { path: sys, source: 'system' };
  return { path: '', source: '' };
}

/**
 * 当前正在装的那个包。
 *
 * **为什么放在模块里而不是让面板自己算时间**：`install()` 是一次
 * 几十秒到几分钟的 npm 调用，面板那边只能靠「点了之后过了多久」猜。
 * 用户在装到一半时刷新页面、或者干脆去点别的卡片再回来，前端那个
 * 计时器就没了——于是「明明在装，界面却写着没装」，再点一次等于
 * 排进第二次安装。状态放这里，谁问都答同一个真相。
 *
 * `step` 由 npm 的 stdout 推进一步（下载 / 解包 / 完成），目前只是
 * 大致阶段，够让用户看出「在动」。
 */
let current = null;

/**
 * 当前状态。**同步**：只读文件，面板可以随便问。
 *
 * `ready` 只由**必需项**决定；目前白名单里全是可选（用到才装），
 * 所以 `ready` 恒为 true，面板按 `packages[].available` 逐项显示。
 */
export function status() {
  const s = scan();
  const packages = {};
  for (const [name, info] of Object.entries(s.packages)) {
    /** 版本来自「第一个命中」，不是只看共享目录——扩展里那份也算能用 */
    const version = info.found?.version ?? '';
    const binary = name === FFMPEG ? ffmpegBinary({ fresh: true }) : '';
    /**
     * **以二进制为准**，不看版本号：包目录在、`package.json` 也在、
     * 但 exe 被删了（杀毒隔离 / 装一半断了），这时版本号会骗人说「装了」。
     * 反过来手动拷一份 exe 进来、没有主包 package.json，也应该判可用。
     */
    packages[name] = {
      version,
      available: name === FFMPEG ? Boolean(binary) : Boolean(version),
      binary,
      /**
       * 系统 PATH 上那份 ffmpeg（**不并进 `available`**）。
       *
       * `available` 的语义是「宿主装好的那份能不能用」，面板的「一键安装」
       * 按钮按它显示；把系统那份混进去会让按钮显示「已装好」，而装的目录
       * 里其实什么都没有。系统那份单独给，面板可以据此提示「不用再下 62MB」。
       */
      system: name === FFMPEG ? systemFfmpeg() : '',
      range: info.range,
      size: info.size,
      /** 面板按它分组（image / media / misc），新增包忘了写就落 misc */
      group: info.group ?? 'misc',
      desc: info.desc,
      /**
       * 2026-11-22：**这个包是在哪个目录找到的**。
       *
       * 面板必须显示它，否则用户看到「已装」却不知道装在哪、能不能卸。
       * `removable` 只在共享目录里有时为真——扩展目录那份是扩展的，
       * 面板只能显示、不能删。
       */
      found: info.found,
      hits: info.hits,
      removable: info.removable,
    };
  }
  return {
    dir: s.dir,
    /** 这次扫过的全部根目录，面板列出来让用户知道「自动查找」找过哪儿 */
    dirs: s.dirs,
    /** 已注入的扩展目录（`setExtDirs` 那份） */
    extDirs: extDirsSnapshot(),
    ffmpeg: ffmpegBinary(),
    /** 系统里那份 ffmpeg 的路径；没有就是空串 */
    systemFfmpeg: systemFfmpeg(),
    packages,
    /** 正在装：`{ name, startedAt, elapsedMs, step }`；没在装就是 null */
    installing: current
      ? { ...current, elapsedMs: Math.max(0, Date.now() - current.startedAt) }
      : null,
  };
}

/** 安装串行化：连点「一键安装」不该起两个 npm 互相踩目录 */
let chain = Promise.resolve();
/** 同一个包正在装：后来者等同一份结果，不重复下载 */
const inflight = new Map();

/**
 * npm 子进程的环境。
 *
 * 继承 `process.env`（npm 要读一大堆自己的配置：代理、缓存目录、userconfig…），
 * 但**摘掉本进程的密钥**——装依赖的子进程没理由看到 QQ AppSecret 或面板口令。
 * 以前这里是裸继承，等于把宿主进程的整个环境交给一个要联网的工具。
 *
 * 用「摘掉」而不是白名单：白名单一旦漏掉一个 `npm_config_*`，
 * 表现是「用户配了代理/源却不生效」，那种问题极难排查。
 */
function npmEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(QQ_|ROOST_SECRET|ROOST_TOKEN|ROOST_PANEL)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * ffmpeg 装不上时补的一句引导。
 *
 * 它**不进镜像**（8 个平台子包、全平台上百 MB、GPL 再分发要带源码获取方式），
 * 所以镜像回退对它注定是「absent」。面板上只剩「安装失败：<npm 原始原因>」
 * 时用户不知道该往哪走——这里有系统那份就告诉他能直接用，没有就告诉他怎么装。
 *
 * @param {string} pkg
 * @returns {string} 以「。」开头，直接拼在失败文案末尾
 */
function ffmpegHint(pkg) {
  if (pkg !== FFMPEG) return '';
  const sys = systemFfmpeg({ fresh: true });
  return sys
    ? `。系统里已有 ffmpeg（${sys}），可以在面板上选「用系统那份」跳过下载`
    : '。可以先用包管理器装一个系统 ffmpeg（apt / brew / choco），宿主会用它';
}

/**
 * 安装白名单里的包。
 *
 * 返回 `{ ok, name, path, message, skipped }`，**不抛**：装失败的原因要原样
 * 带回面板，抛出去只会变成一句「500 内部错误」。
 *
 * @param {string} [name]
 * @param {{log?: Function, timeoutMs?: number, registry?: string, preferSystem?: boolean,
 *   indexUrl?: string, guard?: object}} [o]
 *   `registry` 来自配置 `update.registry`，空则由 npm-registry 自己解析；
 *   `preferSystem` 为真时，系统 PATH 上已有 ffmpeg 就直接复用、不下载；
 *   `indexUrl` 是当前生效的市场索引地址（npm 失败时从这里取内置包），
 *   `guard` 是同一套 SSRF 选项（自建镜像要能放行内网/回环）。
 */
export function install(name = FFMPEG, {
  log = () => {},
  timeoutMs = 300_000,
  registry = '',
  preferSystem = false,
  indexUrl = '',
  guard = {},
} = {}) {
  const pkg = String(name ?? '').trim();
  if (!Object.hasOwn(WHITELIST, pkg)) {
    return Promise.resolve({ ok: false, name: pkg, message: `不在白名单里：${pkg || '(空)'}` });
  }

  /**
   * **自动查找优先于下载**（2026-11-22）。
   *
   * 如果这个包已经躺在某个扩展目录里（扩展自带 `package.json`，由框架装好的），
   * 就直接复用那一份，不再下一遍 15MB——`load()` 本来就会去那些目录找，
   * 所以「复用」是可用的，不是自欺欺人。
   *
   * **ffmpeg 例外**：它能不能用取决于平台子包里的可执行文件，而
   * `ffmpegBinary()` 只认共享目录；判成「扩展里有」会让面板显示已装、
   * 实际却找不到 exe。所以 ffmpeg 一律走原来的二进制判定。
   */
  if (pkg !== FFMPEG) {
    const reused = findPackage(pkg, { fresh: true });
    if (reused && reused.kind !== 'shared') {
      return Promise.resolve({
        ok: true,
        name: pkg,
        path: reused.path,
        skipped: true,
        source: reused.kind,
        message: `「${reused.label}」里已有一份 ${reused.version}，直接复用，不再下载`,
      });
    }
  }

  /**
   * 已经能用就不跑 npm：这是最省事、也最不容易出错的「重装」。
   */
  if (pkg === FFMPEG) {
    const own = ffmpegBinary({ fresh: true });
    if (own) {
      return Promise.resolve({ ok: true, name: pkg, path: own, skipped: true, source: 'managed', message: '已经装好了' });
    }
    /**
     * 系统 PATH 上那份 ffmpeg：**只有调用方明确说「用系统的」才跳过安装**。
     *
     * 默认不跳过是有原因的：扩展是通过受管块里的 `ROOST_DEPS_DIR` 找
     * `<deps>/node_modules/@ffmpeg-installer/<plat>/ffmpeg.exe` 的，
     * 那是扩展和宿主之间唯一的约定。系统 PATH 上的那份它们看不见，
     * 直接跳过会让「面板说装好了、扩展说没装」——比多下 62MB 难查得多。
     *
     * 想让宿主自己省下这 62MB，把 `preferSystem` 打开（面板以后可以给个开关），
     * 但那时扩展得自己会找 PATH，不能只认 `ROOST_DEPS_DIR`。
     */
    const sys = systemFfmpeg({ fresh: true });
    if (sys && preferSystem) {
      return Promise.resolve({
        ok: true, name: pkg, path: sys, skipped: true, source: 'system',
        message: `系统里已有 ffmpeg（${sys}），按你的选择直接复用，不再下载 62MB`,
      });
    }
    if (sys) {
      log(`系统里已有 ffmpeg（${sys}），但仍会装一份到共享目录：扩展只认 ROOST_DEPS_DIR`);
    }
  } else if (installedVersion(pkg)) {
    /**
     * 纯 JS 包（qrcode）以前没有预检：每次点安装都跑一遍 npm，白等几十秒。
     * 目录里已经有就直接复用。
     */
    return Promise.resolve({
      ok: true, name: pkg, path: join(depsDir(), 'node_modules', pkg), skipped: true, source: 'managed',
      message: '已经装好了',
    });
  }
  if (inflight.has(pkg)) return inflight.get(pkg);

  const run = async () => {
    const dir = depsDir();
    try {
      mkdirSync(dir, { recursive: true });
      /**
       * npm 需要一个 package.json 才当项目目录用。**合并已有依赖**：
       * npm 7+ 会按这份清单 prune，只写本次这个包的话，先装的别的包
       * 会在下次安装时被静默删掉。
       */
      const file = join(dir, 'package.json');
      let cur = {};
      try {
        cur = JSON.parse(readFileSync(file, 'utf8'));
      } catch { /* 首次安装：没有旧文件很正常 */ }
      const deps = {};
      for (const [k, v] of Object.entries(cur?.dependencies ?? {})) {
        if (Object.hasOwn(WHITELIST, k)) deps[k] = String(v);
      }
      deps[pkg] = WHITELIST[pkg].range;
      writeFileSync(
        file,
        `${JSON.stringify({ name: 'dsh-roost-deps', private: true, dependencies: deps }, null, 2)}\n`,
        'utf8',
      );
    } catch (e) {
      return { ok: false, name: pkg, message: `准备目录失败：${e?.message ?? e}` };
    }

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    /**
     * 源：配置里的 `update.registry` > 环境变量 > `.npmrc` > 官方。
     * 解析到官方时不加参数，参数与以前完全一致。
     */
    const regArgs = registryArgs({ override: registry });
    log(`开始安装共享依赖 ${pkg}（${WHITELIST[pkg].size}）→ ${dir}${regArgs.length ? `，源 ${regArgs[0].replace('--registry=', '')}` : ''}`);
    /**
     * 心跳：面板靠 `status().installing` 显示「已等待 N 秒」。
     *
     * npm 在这里几乎没有可读的阶段输出（`--loglevel=error`），所以
     * 「进度」只能是**时间 + 一行最后输出**。这不精确，但足以区分
     * 「在装」和「没动」——用户要的就是这个。
     */
    current = { name: pkg, startedAt: Date.now(), step: '' };
    const npmResult = await new Promise((resolve) => {
      const child = execFile(
        npm,
        /**
         * `--ignore-scripts`：安装期不许执行任何包自带的脚本。
         * 白名单里的包都是静态二进制，不需要脚本；开着它就等于
         * 把「面板点一下」变成「机器上跑任意 postinstall」。
         */
        ['install', pkg, ...regArgs, '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'],
        {
          cwd: dir,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          /** 继承环境但摘掉本进程密钥，见 `npmEnv()` */
          env: npmEnv(),
          /**
           * Windows 必须走 shell：Node 20 起 `execFile('npm.cmd')` 会直接
           * `EINVAL`（不能 spawn 批处理，除非过 shell）。参数里没有空格，
           * 拼进命令行是安全的；路径走 `cwd`，不参与拼接。
           */
          shell: process.platform === 'win32',
        },
        (err, _stdout, stderr) => {
          current = null;
          if (err) {
            const why = String(stderr || err.message || '').replace(/\s+/g, ' ').trim().slice(0, 400);
            log(`共享依赖安装失败：${why}`);
            return resolve({ ok: false, name: pkg, message: `安装失败：${why || '未知原因'}` });
          }
          const bin = pkg === FFMPEG ? ffmpegBinary({ fresh: true }) : '';
          if (pkg === FFMPEG && !bin) {
            return resolve({
              ok: false, name: pkg,
              message: '装完了但没找到 ffmpeg 可执行文件（平台子包可能没装上）',
            });
          }
          log(`共享依赖已就绪：${pkg}${bin ? ` → ${bin}` : ''}`);
          /** 装完必须让「在哪找到 / 加载过什么」的缓存失效，否则面板仍说没装 */
          foundCache.delete(pkg);
          loaded.delete(pkg);
          resolve({ ok: true, name: pkg, path: bin, message: '装好了' });
        },
      );
      /** 只留最后一行非空输出给面板看；`current` 可能已被上面的回调清掉 */
      const keep = (buf) => {
        const last = String(buf || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
        if (last && current && current.name === pkg) current.step = last.slice(0, 120);
      };
      child?.stdout?.on?.('data', keep);
      child?.stderr?.on?.('data', keep);
    });

    if (npmResult.ok) return npmResult;

    /**
     * ## npm 失败之后：市场仓的 `deps/`
     *
     * 这条路**完全不碰 npm**，所以「没装 npm」「registry 被墙」「装完
     * require 起来还是报错」这三种都救得回来。镜像里只有解包就能跑的包
     * （`qrcode` / `ws` / `silk-wasm`）；**没有 ffmpeg**（8 个平台子包、
     * 上百 MB、GPL 再分发），那个只能引导用户用系统那份。
     *
     * 没给 `indexUrl` 就不试（老调用方 / 单测），保持原来的行为。
     */
    if (!indexUrl) return npmResult;

    log(`npm 装不上 ${pkg}，改试市场内置包`);
    const m = await installFromMirror({
      names: [pkg],
      whitelist: WHITELIST,
      dir,
      indexUrl,
      guard,
    });
    if (m.installed.length) {
      const hit = m.installed[0];
      /** 装完必须让「在哪找到 / 加载过什么」的缓存失效，否则面板仍说没装 */
      foundCache.delete(pkg);
      loaded.delete(pkg);
      resetCache();
      log(`市场内置包装好了：${pkg}@${hit.version}`);
      return {
        ok: true,
        name: pkg,
        source: 'mirror',
        mirror: hit,
        message: `npm 装不上（${String(npmResult.message ?? '').replace(/^安装失败：/, '')}），已改用市场内置包 ${pkg}@${hit.version}`,
      };
    }

    /**
     * 镜像也没有 / 版本太旧 / 校验失败：**两边的理由都要带给面板**。
     * 只留一句「安装失败」，用户就失去了「换源再试」还是「装系统版」的判断依据。
     */
    const mirrorWhy = [
      ...m.errors,
      ...m.absent.map((n) => `市场镜像里没有 ${n}`),
    ].join('；');
    return {
      ok: false,
      name: pkg,
      message: `${npmResult.message}${mirrorWhy ? `；${mirrorWhy}` : ''}${ffmpegHint(pkg)}`,
    };
  };

  const task = chain.then(run, run).finally(() => inflight.delete(pkg));
  /** 失败不把链条卡死：下一次调用照样能跑 */
  chain = task.then(() => undefined, () => undefined);
  inflight.set(pkg, task);
  return task;
}

/** 给宿主内部用的便捷判断：ffmpeg 能不能用（以后语音转码、图片处理都能调） */
export function hasFfmpeg() {
  return Boolean(ffmpegBinary());
}

/**
 * 清全部缓存：模块、查找结论、ffmpeg 两条路径判定。
 *
 * `install()` / `remove()` 之后必须调。**只清自己那份没用**：Node 的
 * `require.cache` 还拿着旧模块，表现是「卸载了但还能加载」——面板上
 * 点了卸载、功能照旧可用，用户会以为是按钮坏了。
 */
export function resetCache() {
  loaded.clear();
  foundCache.clear();
  ffmpegCache = undefined;
  systemFfmpegCache = undefined;
  try {
    /**
     * 只删**共享目录下**的模块缓存，不整个清空、也不碰扩展目录那份：
     * 宿主自己有模块在跑，清一片会牵连无关代码；而扩展的依赖归扩展管。
     */
    const root = depsDir();
    for (const key of Object.keys(reqAny.cache ?? {})) {
      if (key.startsWith(root)) delete reqAny.cache[key];
    }
  } catch { /* 缓存结构变化不该让卸载失败 */ }
}
