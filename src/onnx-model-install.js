/**
 * 本地 embedding 模型下载器（multilingual-e5-small，中文可用，384 维）。
 *
 * 为什么和 `onnx-install.js` 分开：那边装的是**运行时**（onnxruntime-node，
 * 从 npm），这边装的是**模型权重 + tokenizer**（从 HuggingFace）。两个源、
 * 两套换源策略、两个安装按钮，混在一个状态机里只会互相占用 busy。
 *
 * 下载范式照抄 `tts-install.js`：候选源顺序尝试、失败清半成品、
 * 先落 `.tmp` 全部成功再 rename 顶替（中途取消用户的旧模型还在）。
 *
 * 模型选型的出处：`hindsight-api-slim/.../config.py` 的
 * `DEFAULT_EMBEDDINGS_ONNX_MODEL_ID = "intfloat/multilingual-e5-small"`，
 * `ONNX_FILE = "onnx/model.onnx"`。抄成熟项目的默认，不自己挑。
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  EMBED_FILES, EMBED_MODEL_ID, HF_REGISTRIES, RERANK_FILES, RERANK_MODEL_ID, hfFileUrl,
} from './onnx-install.js';

const PHASE = Object.freeze({ IDLE: 'idle', DOWNLOAD: 'download', DONE: 'done', ERROR: 'error' });

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

export function createModelInstaller({
  dataDir = () => '',
  fetchImpl = (...args) => fetch(...args),
  log = () => {},
  /** HuggingFace 源覆盖：传数组换顺序（如用户自己有镜像），默认 hf-mirror → 官方 */
  registries = () => HF_REGISTRIES,
  /**
   * 模型规格。默认 e5-small（老调用方不传，行为不变）；rerank 传自己的一套。
   * 每个模型一个 installer 实例、各自状态机与目录，互不占用 busy。
   */
  modelId = EMBED_MODEL_ID,
  dirName = 'e5-small',
  files = EMBED_FILES,
  label = '本地 embedding 模型（e5-small）',
} = {}) {
  let state = {
    running: false, phase: PHASE.IDLE,
    received: 0, total: 0, message: '', error: '',
    startedAt: 0, finishedAt: 0,
  };
  let controller = null;

  const modelDir = () => join(dataDir(), 'onnx-models', dirName);
  /**
   * 下载暂存目录：**必须是 modelDir 的兄弟，不能放它里面**。
   *
   * 收尾是 `rmSync(target)` 再 `renameSync(tmp, target)`；tmp 要是在 target 内部，
   * rmSync 会把它一起删掉，rename 必然 ENOENT——模型下完一百多 MB 才失败，
   * 而且旧模型已经被删了。单测只覆盖 ready/busy/cancel，抓不到这条。
   */
  const tmpDir = () => join(dataDir(), 'onnx-models', `.tmp-${dirName}`);

  function snapshot() {
    const percent = state.total > 0
      ? Math.max(0, Math.min(100, Math.round((state.received / state.total) * 100)))
      : 0;
    return { ...state, percent };
  }
  const set = (patch) => { state = { ...state, ...patch }; };

  /** 三个文件都在才算装好（光有 model.onnx 没 tokenizer 照样跑不了） */
  function ready() {
    return files.every(([, name]) => existsSync(join(modelDir(), name)));
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

  /** 候选源顺序尝试，失败清半成品（同 onnx-install / tts-install） */
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
          log(`模型下载失败，换源重试：${host}`);
        }
        await download(url, dest, signal);
        if (i > 0) log(`模型换源成功：${host}`);
        return url;
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e;
        lastErr = e;
        rmSync(dest, { force: true });
      }
    }
    throw lastErr ?? new Error('所有下载源都失败了');
  }

  /** 装模型。先落 .tmp，三个文件齐了再整体 rename 顶替 */
  async function run(signal) {
    const tmp = tmpDir();
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    const regs = registries();
    const sources = Array.isArray(regs) && regs.length ? regs : HF_REGISTRIES;
    for (const [remote, name] of files) {
      set({ phase: PHASE.DOWNLOAD, message: `下载 ${name}…`, received: 0, total: 0 });
      const dest = join(tmp, name);
      const urls = sources.map((r) => hfFileUrl(modelId, remote, r));
      await downloadFromAny(urls, dest, signal);
      /** 空文件不算装好（hf-mirror 偶尔返回 0 字节，实测踩到过） */
      if (!existsSync(dest) || !statSync(dest).size) throw new Error(`${name} 下载为空，换个源再试`);
    }

    /** 同上：下载完/解压中点取消，不能在 aborted 后删旧装新还报"装好了" */
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const target = modelDir();
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
    set({ phase: PHASE.DONE, message: `装好了：${label}`, running: false, finishedAt: Date.now() });
    log('本地 embedding 模型安装完成');
  }

  return {
    ready,
    status: snapshot,
    modelDir,
    modelId: () => modelId,

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
        if (!aborted) log(`本地 embedding 模型安装失败：${e?.message || e}`);
        rmSync(tmpDir(), { recursive: true, force: true });
        controller = null;
      });
      return { ok: true, started: true };
    },

    cancel() {
      if (!state.running) return { ok: false, reason: 'idle' };
      controller?.abort();
      return { ok: true };
    },

    /** 只删自己装的模型目录，不碰运行时 */
    uninstall() {
      if (state.running) return { ok: false, reason: 'busy', message: '安装进行中，先取消再卸载' };
      rmSync(modelDir(), { recursive: true, force: true });
      state = { ...state, phase: PHASE.IDLE, message: '', error: '', received: 0, total: 0 };
      return { ok: true };
    },

    /** 模型文件就绪后，local-embed.js 用这里拿路径 */
    paths() {
      const dir = modelDir();
      return Object.fromEntries(files.map(([remote, name]) => [remote, join(dir, name)]));
    },

    usage() {
      return { bytes: dirSize(modelDir()) };
    },
  };
}
