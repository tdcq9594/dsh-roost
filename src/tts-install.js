/**
 * 本地语音引擎的一键安装。
 *
 * 装什么：
 *   1. `sherpa-onnx-node` + 当前平台的预编译包（共约 23MB，npm 上的 tgz）
 *   2. 中文模型（aishell3 约 30MB，sherpa 官方 release 的 tar.bz2）
 *
 * 为什么不用 npm 装依赖：
 *   插件目录归 DSH 的插件管理器管，更新插件时 `node_modules` 会被覆盖，
 *   用户装的 23MB 原生模块会莫名其妙消失。所以全部落到**数据目录**：
 *     dataDir/tts-runtime/node_modules   —— 引擎
 *     dataDir/tts-models/<模型>          —— 模型
 *   删这两个目录就是卸载，和插件生命周期完全解耦。
 *
 * 为什么用系统 tar：
 *   模型只有 tar.bz2，而 Node 内置的 zlib 不支持 bzip2。为解压引入
 *   `unbzip2-stream` + `tar-fs` 会打破这个插件「零依赖」的前提。
 *   Windows 10 1803+ / Linux / macOS 都自带 tar（bsdtar 或 GNU tar），
 *   实测解 30MB 模型 4 秒。找不到 tar 时明确告诉用户，不假装能装。
 */

import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { SHERPA_MODELS } from './tts.js';

const execFileAsync = promisify(execFile);

/**
 * 引擎版本固定。跟着 latest 走等于把「上游发新版」变成用户的安装失败。
 *
 * 2.0.1 默认用 external buffer 返回音频，在长驻进程里会被 Node 拒绝
 * （`External buffers are not allowed`）。`src/tts.js` 已经显式传
 * `enableExternalBuffer: false` 关掉它——**这两处是绑定的**：
 * 谁把那个参数删了，这个版本就会在用户机器上每句都失败。
 */
export const SHERPA_NODE_VERSION = '2.0.1';

/** npm 包 → 平台包。sherpa 的预编译模块按平台分包，装错平台等于装了个不能加载的壳 */
const PLATFORM_PACKAGES = {
  'win32-x64': 'sherpa-onnx-win-x64',
  'win32-arm64': 'sherpa-onnx-win-arm64',
  'linux-x64': 'sherpa-onnx-linux-x64',
  'linux-arm64': 'sherpa-onnx-linux-arm64',
  'darwin-x64': 'sherpa-onnx-darwin-x64',
  'darwin-arm64': 'sherpa-onnx-darwin-arm64',
};

/** 下载时的分片大小计数用不上，但进度要按「已下载字节 / 总字节」算，所以留一个常量注释 */
const PHASE = {
  IDLE: 'idle',
  ENGINE: 'engine',
  MODEL: 'model',
  DONE: 'done',
  ERROR: 'error',
};

function platformPackage() {
  return PLATFORM_PACKAGES[`${process.platform}-${process.arch}`] || '';
}

function npmTgz(name, version) {
  return `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
}

/**
 * 找 tar，并记住它是不是 GNU tar。
 *
 * Windows 上有个坑：GNU tar 会把 `-C C:\path` 里的 `C:` 当成**远程主机名**
 * （rsh 语法的老习惯），直接报 `Cannot connect to C: resolve failed`。
 * 系统自带的 `System32\tar.exe` 是 bsdtar，没有这个毛病，所以 Windows
 * 上优先用它；只有在退回 GNU tar 时才补 `--force-local`。
 */
async function resolveTar() {
  const winTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const candidates = process.platform === 'win32' ? [winTar, 'tar'] : ['tar'];
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 10_000 });
      return { bin, gnu: /GNU tar/i.test(String(stdout)) };
    } catch {}
  }
  return null;
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        try { total += statSync(p).size; } catch {}
      }
    }
  }
  return total;
}

export function createTtsInstaller({
  dataDir = () => '',
  fetchImpl = (...args) => fetch(...args),
  log = () => {},
  onDone = () => {},
} = {}) {
  /** 同一时间只允许一个安装任务：两个并发下载会往同一个目录里写 */
  let state = {
    running: false,
    phase: PHASE.IDLE,
    model: '',
    received: 0,
    total: 0,
    message: '',
    error: '',
    startedAt: 0,
    finishedAt: 0,
  };
  let controller = null;

  const runtimeDir = () => join(dataDir(), 'tts-runtime');
  const modelsRoot = () => join(dataDir(), 'tts-models');

  function snapshot() {
    const percent = state.total > 0
      ? Math.max(0, Math.min(100, Math.round((state.received / state.total) * 100)))
      : 0;
    return { ...state, percent };
  }

  function set(patch) {
    state = { ...state, ...patch };
  }

  async function download(url, dest, signal) {
    /**
     * 取消可能发生在**上一个步骤**里（比如解压引擎时点了取消），
     * 那时 signal 已经 aborted，再发请求就白下几十 MB。
     */
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const res = await fetchImpl(url, { redirect: 'follow', signal });
    if (!res?.ok) {
      throw new Error(`下载失败（HTTP ${Number(res?.status) || 0}）`);
    }
    const declared = Number(res.headers?.get?.('content-length') || 0);
    if (declared > 0) set({ total: state.total + declared });
    mkdirSync(dirname(dest), { recursive: true });

    const counter = new Transform({
      transform(chunk, _enc, cb) {
        set({ received: state.received + chunk.length });
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest), { signal });
  }

  /**
   * 解压。
   *
   * 这里**不传** tar 的 `--exclude`：GNU tar 认 `--exclude=xxx`，但 Windows
   * 自带的 bsdtar 会把它当成要解的文件名（实测报 `Failed to open
   * '--exclude=rule.far'`）。生产环境优先用 bsdtar、测试环境是 GNU tar，
   * 这种传参差异只会在用户机器上炸。模型包整包解开，一个文件不少。
   */
  async function untar(tar, file, dest, flag) {
    mkdirSync(dest, { recursive: true });
    /**
     * GNU tar 在 Windows 上必须带 `--force-local`，否则 `-C C:\...` 会被
     * 当成 `主机:路径`（见 resolveTar 的注释）。bsdtar 不认这个参数，
     * 所以只在确认是 GNU 时加。
     */
    const args = [
      ...(tar.gnu && process.platform === 'win32' ? ['--force-local'] : []),
      flag,
      file,
      '-C',
      dest,
    ];
    await execFileAsync(tar.bin, args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  }

  /**
   * 装引擎。
   *
   * 先解到 `.tmp`，全部成功再 rename 顶替。中途失败或取消时，用户原来的
   * 可用版本还在——不会出现「点了一下取消，结果语音从能用到不能用」。
   */
  async function installEngine(tar, signal) {
    const pkg = platformPackage();
    if (!pkg) throw new Error(`这个平台（${process.platform}-${process.arch}）没有预编译的语音引擎`);

    set({ phase: PHASE.ENGINE, message: '下载语音引擎…', received: 0, total: 0 });
    const tmp = join(runtimeDir(), '.tmp');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    const packages = [
      ['sherpa-onnx-node', SHERPA_NODE_VERSION],
      [pkg, SHERPA_NODE_VERSION],
    ];
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });
    for (const [name, version] of packages) {
      const tgz = join(tmp, `${name}.tgz`);
      /** 每个包单独算进度，不然第二个包一上来就显示 100% */
      set({ received: 0, total: 0, message: `下载 ${name}…` });
      await download(npmTgz(name, version), tgz, signal);
      set({ phase: PHASE.ENGINE, message: `解压 ${name}…` });
      await untar(tar, tgz, tmp, '-xzf');
      // npm 的 tgz 里统一是 `package/`，解出来要改名成包名
      const unpacked = join(tmp, 'package');
      if (!existsSync(unpacked)) throw new Error(`${name} 压缩包结构不对（没有 package 目录）`);
      renameSync(unpacked, join(tmp, 'node_modules', name));
    }

    const target = join(runtimeDir(), 'node_modules');
    rmSync(target, { recursive: true, force: true });
    renameSync(join(tmp, 'node_modules'), target);
    rmSync(tmp, { recursive: true, force: true });
  }

  async function installModel(tar, key, signal) {
    const spec = SHERPA_MODELS[key];
    if (!spec) throw new Error(`不认识的模型：${key}`);

    set({ phase: PHASE.MODEL, message: `下载模型 ${spec.label}…`, received: 0, total: 0 });
    const tmp = join(modelsRoot(), '.tmp');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    const archive = join(tmp, `${spec.dir}.tar.bz2`);
    await download(spec.url, archive, signal);
    set({ phase: PHASE.MODEL, message: '解压模型（解压后约 204MB，稍等）…' });
    await untar(tar, archive, tmp, '-xjf');

    const unpacked = join(tmp, spec.dir);
    if (!existsSync(unpacked)) throw new Error('模型压缩包结构不对（没找到模型目录）');
    const missing = spec.required.filter((f) => !existsSync(join(unpacked, f)));
    if (missing.length) throw new Error(`模型文件不全：缺 ${missing.join('、')}`);

    const target = join(modelsRoot(), spec.dir);
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
    rmSync(tmp, { recursive: true, force: true });
  }

  async function run(key, signal) {
    const tar = await resolveTar();
    if (!tar) {
      throw new Error('系统里找不到 tar 命令，没法解压。请手动下载模型解压到 tts-models 目录，或在有 tar 的环境里安装');
    }
    await installEngine(tar, signal);
    await installModel(tar, key, signal);
    set({
      phase: PHASE.DONE,
      message: `装好了：${SHERPA_MODELS[key].label}`,
      running: false,
      finishedAt: Date.now(),
    });
    log(`本地语音安装完成：${key}`);
    /**
     * 装完立刻预热。加载模型要 5 秒，趁用户还在看「装好了」那一行，
     * 先把模型读进内存，第一次真说话就不用等。
     */
    try {
      onDone(key);
    } catch {}
  }

  return {
    /** 开始装。返回是否真的启动了——已经在跑时不重复启动 */
    start(key = 'aishell3') {
      if (state.running) return { ok: false, reason: 'busy', message: '已经有安装任务在跑' };
      if (!SHERPA_MODELS[key]) return { ok: false, reason: 'unknown_model', message: `不认识的模型：${key}` };

      controller = new AbortController();
      state = {
        running: true,
        phase: PHASE.ENGINE,
        model: key,
        received: 0,
        total: 0,
        message: '准备中…',
        error: '',
        startedAt: Date.now(),
        finishedAt: 0,
      };

      run(key, controller.signal).catch((e) => {
        const aborted = controller?.signal?.aborted;
        set({
          running: false,
          /** 取消不是失败：面板该显示「已取消」，不是红字报错 */
          phase: aborted ? PHASE.IDLE : PHASE.ERROR,
          error: aborted ? '' : String(e?.message || e),
          message: aborted ? '已取消' : '安装失败',
          finishedAt: Date.now(),
        });
        if (!aborted) log(`本地语音安装失败：${e?.message || e}`);
        // 半成品留着没用，而且占几十 MB
        for (const d of [join(runtimeDir(), '.tmp'), join(modelsRoot(), '.tmp')]) {
          rmSync(d, { recursive: true, force: true });
        }
        controller = null;
      });

      return { ok: true, started: true, model: key };
    },

    cancel() {
      if (!state.running) return { ok: false, reason: 'idle' };
      controller?.abort();
      return { ok: true };
    },

    status: snapshot,

    /** 卸载：删引擎和模型目录。只删自己装的那两个路径 */
    uninstall(key = 'aishell3') {
      if (state.running) return { ok: false, reason: 'busy', message: '安装进行中，先取消再卸载' };
      const spec = SHERPA_MODELS[key];
      const dirs = [runtimeDir()];
      if (spec) dirs.push(join(modelsRoot(), spec.dir));
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
      state = { ...state, phase: PHASE.IDLE, message: '', error: '', received: 0, total: 0 };
      return { ok: true };
    },

    /** 面板显示「已占多少磁盘」用 */
    usage(key = 'aishell3') {
      const spec = SHERPA_MODELS[key];
      const engine = dirSize(runtimeDir());
      const model = spec ? dirSize(join(modelsRoot(), spec.dir)) : 0;
      return { engine, model, total: engine + model };
    },
  };
}
