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

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { dataDir } from './config.js';

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
    desc: '生成二维码（扫码登录）',
  },
});

const FFMPEG = '@ffmpeg-installer/ffmpeg';

/** 装在哪：跟着宿主数据目录，升级/卸载扩展都不动它 */
export function depsDir() {
  return join(dataDir(), 'deps');
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
 * 当前状态。**同步**：只读文件，面板可以随便问。
 *
 * `ready` 只由**必需项**决定；目前白名单里全是可选（用到才装），
 * 所以 `ready` 恒为 true，面板按 `packages[].available` 逐项显示。
 */
export function status() {
  const packages = {};
  for (const [name, meta] of Object.entries(WHITELIST)) {
    const version = installedVersion(name);
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
      range: meta.range,
      size: meta.size,
      desc: meta.desc,
    };
  }
  return { dir: depsDir(), ffmpeg: ffmpegBinary(), packages };
}

/** 安装串行化：连点「一键安装」不该起两个 npm 互相踩目录 */
let chain = Promise.resolve();
/** 同一个包正在装：后来者等同一份结果，不重复下载 */
const inflight = new Map();

/**
 * 安装白名单里的包。
 *
 * 返回 `{ ok, name, path, message, skipped }`，**不抛**：装失败的原因要原样
 * 带回面板，抛出去只会变成一句「500 内部错误」。
 */
export function install(name = FFMPEG, { log = () => {}, timeoutMs = 300_000 } = {}) {
  const pkg = String(name ?? '').trim();
  if (!Object.hasOwn(WHITELIST, pkg)) {
    return Promise.resolve({ ok: false, name: pkg, message: `不在白名单里：${pkg || '(空)'}` });
  }

  /** 已经能用就不跑 npm：这是最省事、也最不容易出错的「重装」 */
  if (pkg === FFMPEG && ffmpegBinary({ fresh: true })) {
    return Promise.resolve({ ok: true, name: pkg, path: ffmpegBinary(), skipped: true, message: '已经装好了' });
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
    log(`开始安装共享依赖 ${pkg}（${WHITELIST[pkg].size}）→ ${dir}`);
    return await new Promise((resolve) => {
      execFile(
        npm,
        /**
         * `--ignore-scripts`：安装期不许执行任何包自带的脚本。
         * 白名单里的包都是静态二进制，不需要脚本；开着它就等于
         * 把「面板点一下」变成「机器上跑任意 postinstall」。
         */
        ['install', pkg, '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'],
        {
          cwd: dir,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          /**
           * Windows 必须走 shell：Node 20 起 `execFile('npm.cmd')` 会直接
           * `EINVAL`（不能 spawn 批处理，除非过 shell）。参数里没有空格，
           * 拼进命令行是安全的；路径走 `cwd`，不参与拼接。
           */
          shell: process.platform === 'win32',
        },
        (err, _stdout, stderr) => {
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
          resolve({ ok: true, name: pkg, path: bin, message: '装好了' });
        },
      );
    });
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
