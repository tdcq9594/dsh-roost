/**
 * 通用 ONNX 运行时的一键安装（本地 embedding / rerank / decide 模型的前置）。
 *
 * 装什么：
 *   onnxruntime-node@1.31.1 + onnxruntime-common@1.31.1（CPU 推理）
 *
 * 为什么手工下 tgz 解压，而不是 `npm install`：
 *   1. 插件目录归 DSH 插件管理器管，更新插件时 node_modules 会被覆盖——
 *      所以全部落到**数据目录** `dataDir/onnx-runtime/node_modules`，
 *      删这个目录就是卸载，和插件生命周期解耦（同 tts-install.js 的套路）。
 *   2. `onnxruntime-node` 有 postinstall(`node ./script/install`)，但那个脚本
 *      只下载**因过大不入 registry 的 CUDA EP**；CPU 核心二进制已经打包在
 *      tgz 里（bin/napi-v6/<platform>/<arch>/ 下的 .node + dll/so）。
 *      手工解压天然跳过 postinstall，CPU 推理完整可用——因此不违反
 *      `shared-deps.js`「有 postinstall 脚本的一律不要」的硬规矩。
 *
 * 为什么不现在就装 embedding 模型：
 *   模型权重和 tokenizer 不在 npm 包里、要从 HuggingFace 单独下（走 hf-mirror），
 *   那是下一步的事。这一步只把**运行时**装好并验证能加载。
 *
 * 平台：onnxruntime-node 单包自带全平台 CPU 二进制（win/linux/mac × x64/arm64），
 * 无需平台子包改名——比 sherpa 还省一步。NAPI-v6 稳定 ABI，不随 Node 版本重编译。
 */

import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { downloadRegistries, tgzUrl } from './npm-registry.js';

const execFileAsync = promisify(execFile);

/** 版本固定：跟着 latest 走等于把「上游发新版」变成用户的安装失败 */
export const ONNX_NODE_VERSION = '1.31.1';
export const ONNX_COMMON_VERSION = '1.31.1';

/** 版本固定：跟 latest 走等于把「上游发新版」变成用户的安装失败 */
export const TOKENIZERS_VERSION = '0.2.0';

/**
 * 要装的三个包（名字 + 版本）。
 *   onnxruntime-node 依赖 common；tokenizers 是纯 JS/WASM（8.3kB gzip，
 *   无 postinstall），用来读 HuggingFace 的 tokenizer.json 做中文分词。
 */
export const ONNX_PACKAGES = Object.freeze([
  ['onnxruntime-common', ONNX_COMMON_VERSION],
  ['onnxruntime-node', ONNX_NODE_VERSION],
  ['@huggingface/tokenizers', TOKENIZERS_VERSION],
]);

const PHASE = Object.freeze({
  IDLE: 'idle',
  DOWNLOAD: 'download',
  EXTRACT: 'extract',
  DONE: 'done',
  ERROR: 'error',
});

/**
 * 本地 embedding 模型。照抄 Hindsight 的默认 ONNX 配置
 * （`DEFAULT_EMBEDDINGS_ONNX_MODEL_ID = intfloat/multilingual-e5-small`），
 * 多语言、中文可用、384 维。三个文件缺一不可：
 *   model.onnx           ONNX 权重（~118MB）
 *   tokenizer.json      分词器（~17MB，多语言词表大）
 *   tokenizer_config.json 分词器元数据（~450B）
 *
 * 模型/分词器**不在 npm 包里**，走 HuggingFace 下载；国内走 hf-mirror。
 */
export const EMBED_MODEL_ID = 'intfloat/multilingual-e5-small';
export const EMBED_FILES = Object.freeze([
  ['onnx/model.onnx', 'model.onnx'],
  ['tokenizer.json', 'tokenizer.json'],
  ['tokenizer_config.json', 'tokenizer_config.json'],
]);
/** HuggingFace 下载源（国内镜像优先，官方兜底）——沿用 tts-install 的多源换源思路 */
export const HF_REGISTRIES = Object.freeze([
  'https://hf-mirror.com',
  'https://huggingface.co',
]);

export const hfFileUrl = (modelId, file, registry = HF_REGISTRIES[0]) =>
  `${registry}/${modelId}/resolve/main/${file}`;

/**
 * 本地 rerank 模型。抄 Hindsight 默认 `DEFAULT_RERANKER_LOCAL_MODEL =
 * "hindsight-ai/hs-rerank-1"`；cross-encoder，pair(query,doc) → logit。
 * 模型 160MB + tokenizer 34MB（比 embedding 的 470MB 轻）。
 */
export const RERANK_MODEL_ID = 'hindsight-ai/hs-rerank-1';
export const RERANK_FILES = Object.freeze([
  ['onnx/model.onnx', 'model.onnx'],
  ['tokenizer.json', 'tokenizer.json'],
  ['tokenizer_config.json', 'tokenizer_config.json'],
]);

/** 找 tar：Windows 优先系统自带 bsdtar（-C C:\ 不会当成远程主机），退回 GNU 补 --force-local */
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
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += statSync(p).size; } catch {} }
    }
  }
  return total;
}

export function createOnnxInstaller({
  dataDir = () => '',
  fetchImpl = (...args) => fetch(...args),
  log = () => {},
  /**
   * npm 源覆盖值（配置里的 `update.registry`），传函数以便中途改配置生效。
   * 115MB 的包在国内经常超时，多给几次换镜像机会。
   */
  registry = () => '',
  /**
   * 探测加载是否成功。生产传 createRequire 版；测试注入假函数。
   * 返回 true = 能加载。默认按包路径存在与否粗判。
   */
  probe = null,
} = {}) {
  let state = {
    running: false, phase: PHASE.IDLE,
    received: 0, total: 0, message: '', error: '',
    startedAt: 0, finishedAt: 0,
  };
  let controller = null;

  const runtimeDir = () => join(dataDir(), 'onnx-runtime');
  const nodeModules = () => join(runtimeDir(), 'node_modules');

  function snapshot() {
    const percent = state.total > 0
      ? Math.max(0, Math.min(100, Math.round((state.received / state.total) * 100)))
      : 0;
    return { ...state, percent };
  }
  const set = (patch) => { state = { ...state, ...patch }; };

  /** 装好没有：onnxruntime-node 的 binding 在才算（不光看目录） */
  function ready() {
    const pkg = join(nodeModules(), 'onnxruntime-node');
    if (!existsSync(pkg)) return false;
    if (typeof probe === 'function') {
      try { return Boolean(probe(join(runtimeDir(), 'noop.cjs'))); } catch { return false; }
    }
    return existsSync(join(pkg, 'bin'));
  }

  async function download(url, dest, signal) {
    if (signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const res = await fetchImpl(url, { redirect: 'follow', signal });
    if (!res?.ok) throw new Error(`下载失败（HTTP ${Number(res?.status) || 0}）`);
    const declared = Number(res.headers?.get?.('content-length') || 0);
    if (declared > 0) set({ total: state.total + declared });
    mkdirSync(dirname(dest), { recursive: true });
    const counter = new Transform({
      transform(chunk, _enc, cb) { set({ received: state.received + chunk.length }); cb(null, chunk); },
    });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest), { signal });
  }

  const candidates = (name, version) =>
    downloadRegistries({ override: registry() }).map((r) => tgzUrl(name, version, r));

  /** 按候选源顺序下载，前一个失败换下一个；失败清半成品（同 tts-install） */
  async function downloadFromAny(urls, dest, signal) {
    const list = urls.filter(Boolean);
    let lastErr = null;
    for (let i = 0; i < list.length; i += 1) {
      const url = list[i];
      let host = url;
      try { host = new URL(url).host; } catch {}
      try {
        if (i > 0) {
          set({ received: 0, total: 0, message: `换源重试（${host}）…` });
          log(`下载失败，换源重试：${host}`);
        }
        await download(url, dest, signal);
        if (i > 0) log(`换源成功：${host}`);
        return url;
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        lastErr = e;
        rmSync(dest, { force: true });
      }
    }
    throw lastErr ?? new Error('所有下载源都失败了');
  }

  async function untar(tar, file, dest) {
    mkdirSync(dest, { recursive: true });
    const args = [
      ...(tar.gnu && process.platform === 'win32' ? ['--force-local'] : []),
      '-xzf', file, '-C', dest,
    ];
    await execFileAsync(tar.bin, args, { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  }

  /**
   * 装运行时。先解到 `.tmp`，全部成功再 rename 顶替——
   * 中途失败/取消时用户原来的版本还在，不会「点一下取消就从能用变不能用」。
   */
  async function run(signal) {
    const tar = await resolveTar();
    if (!tar) throw new Error('系统里找不到 tar 命令，没法解压运行时');

    const tmp = join(runtimeDir(), '.tmp');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });

    for (const [name, version] of ONNX_PACKAGES) {
      set({ phase: PHASE.DOWNLOAD, message: `下载 ${name}…`, received: 0, total: 0 });
      /** scoped 包名带 `/`，不能当文件名——照 tts-install 的 edge 分支替换掉 */
      const tgz = join(tmp, `${name.replace(/[\\/@]/g, '_')}.tgz`);
      await downloadFromAny(candidates(name, version), tgz, signal);

      set({ phase: PHASE.EXTRACT, message: `解压 ${name}…` });
      await untar(tar, tgz, tmp);
      const unpacked = join(tmp, 'package');
      if (!existsSync(unpacked)) throw new Error(`${name} 压缩包结构不对（没有 package 目录）`);
      /** scoped 包落到 node_modules/@scope/name，父目录要先建（同 tts-install edge） */
      const dest = join(tmp, 'node_modules', ...name.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(unpacked, dest);
      rmSync(tgz, { force: true });
    }

    const target = nodeModules();
    rmSync(target, { recursive: true, force: true });
    renameSync(join(tmp, 'node_modules'), target);
    rmSync(tmp, { recursive: true, force: true });

    set({ phase: PHASE.DONE, message: '装好了：ONNX 运行时（CPU）', running: false, finishedAt: Date.now() });
    log('ONNX 运行时安装完成');
  }

  return {
    ready,
    status: snapshot,

    start() {
      if (state.running) return { ok: false, reason: 'busy', message: '已经有安装任务在跑' };
      controller = new AbortController();
      state = {
        running: true, phase: PHASE.DOWNLOAD,
        received: 0, total: 0, message: '准备中…', error: '',
        startedAt: Date.now(), finishedAt: 0,
      };
      run(controller.signal).catch((e) => {
        const aborted = controller?.signal?.aborted;
        set({
          running: false,
          phase: aborted ? PHASE.IDLE : PHASE.ERROR,
          error: aborted ? '' : String(e?.message || e),
          message: aborted ? '已取消' : '安装失败',
          finishedAt: Date.now(),
        });
        if (!aborted) log(`ONNX 运行时安装失败：${e?.message || e}`);
        rmSync(join(runtimeDir(), '.tmp'), { recursive: true, force: true });
        controller = null;
      });
      return { ok: true, started: true };
    },

    cancel() {
      if (!state.running) return { ok: false, reason: 'idle' };
      controller?.abort();
      return { ok: true };
    },

    /** 只删自己装的那个目录 */
    uninstall() {
      if (state.running) return { ok: false, reason: 'busy', message: '安装进行中，先取消再卸载' };
      rmSync(runtimeDir(), { recursive: true, force: true });
      state = { ...state, phase: PHASE.IDLE, message: '', error: '', received: 0, total: 0 };
      return { ok: true };
    },

    /** 面板显示「已占多少磁盘」 */
    usage() {
      const bytes = dirSize(runtimeDir());
      return { bytes };
    },

    /** 给 createRequire 用的目录（加载 onnxruntime-node 从这里解析） */
    runtimeDir,
  };
}
