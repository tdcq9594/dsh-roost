/**
 * 本地 ONNX embedding（照抄 Hindsight `OnnxEmbeddings._encode_batch`）。
 *
 * 模型：multilingual-e5-small（384 维，中文可用），由 onnx-model-install 下载到
 * `<dataDir>/onnx-models/e5-small/`；运行时由 onnx-install 装到
 * `<dataDir>/onnx-runtime/node_modules/`。
 *
 * 算法出处（hindsight-api-slim/.../engine/embeddings.py:724-803）：
 *   1. tokenizer 编码（padding + truncation + attention_mask）
 *   2. ONNX session.run 拿 token embeddings（3D: [batch, seq, hidden]）
 *   3. **mean pooling**：按 attention_mask 加权求和除以有效 token 数
 *   4. **L2 normalize**：除以向量模长（norm=0 时用 1，防除零）
 *
 * 为什么拆成纯函数 `poolAndNormalize`：pooling/normalize 是最容易写错、
 * 又最该被测试锁死的一段——注入数组就能测，不用真模型、不用真 ONNX。
 *
 * 与 `embed.js` 的关系：这里只提供"本地能不能用 + 算向量"，
 * `embed.js` 负责按配置在本地/HTTP 之间选路。上层接口一致（Float32Array）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** e5 系列的非对称前缀：查询加 "query: "、文档加 "passage: "（Hindsight 默认） */
export const QUERY_PREFIX = 'query: ';
export const PASSAGE_PREFIX = 'passage: ';
const MAX_TOKENS = 512;

/**
 * mean pooling + L2 normalize。纯函数，输入都是普通数组/类数组。
 *
 * @param {Array<Array<number>>} tokenVecs 一条文本的 token 向量序列 [seq][hidden]
 * @param {Array<number>|null} mask 对应的 attention_mask（缺了当全 1）
 * @returns {Float32Array} 归一化后的一条向量
 */
export function poolAndNormalize(tokenVecs, mask = null, { normalized = true } = {}) {
  const rows = Array.isArray(tokenVecs) ? tokenVecs : [];
  if (!rows.length) return new Float32Array(0);
  const dim = rows[0]?.length || 0;
  if (!dim) return new Float32Array(0);

  const weights = rows.map((_, i) => (Array.isArray(mask) && mask.length > i ? Number(mask[i]) || 0 : 1));
  const out = new Array(dim).fill(0);
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const w = weights[i];
    if (!w) continue;
    count += w;
    const row = rows[i];
    for (let j = 0; j < dim; j += 1) out[j] += (Number(row?.[j]) || 0) * w;
  }
  const denom = count > 1e-9 ? count : 1e-9;
  for (let j = 0; j < dim; j += 1) out[j] /= denom;

  if (normalized) {
    let normSq = 0;
    for (let j = 0; j < dim; j += 1) normSq += out[j] * out[j];
    const norm = Math.sqrt(normSq);
    const d = norm > 0 ? norm : 1;
    for (let j = 0; j < dim; j += 1) out[j] /= d;
  }
  return Float32Array.from(out);
}

/**
 * 按文本长度分组 batch（Hindsight 的做法：同批补齐会浪费，短句抱团）。
 * 返回原始下标的分组数组，调用方按组跑 forward 再填回。
 */
export function batchByLength(texts, batchSize = 16) {
  const order = [...texts.keys()].sort((a, b) => String(texts[b] || '').length - String(texts[a] || '').length);
  const groups = [];
  for (let i = 0; i < order.length; i += batchSize) groups.push(order.slice(i, i + batchSize));
  return groups;
}

/**
 * 默认 session 加载器：从数据目录用 createRequire 加载 onnxruntime-node
 * （同 tts.js 的 sherpa 加载范式，不经 DSH 插件管理器）。
 */
async function defaultLoadSession(runtimeDir, modelPath) {
  const req = createRequire(join(runtimeDir, 'noop.cjs'));
  const ort = req('onnxruntime-node');
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
  /** Tensor 构造器在 ort 顶层（不在 session.constructor 上），附挂着给 encodeBatch 用 */
  session.ort = ort;
  return session;
}

/** 默认 tokenizer 加载器：@huggingface/tokenizers 零依赖，直接吃 tokenizer.json */
function defaultLoadTokenizer(runtimeDir, modelDir) {
  const req = createRequire(join(runtimeDir, 'noop.cjs'));
  const { Tokenizer } = req('@huggingface/tokenizers');
  const json = JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8'));
  let config = {};
  try { config = JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')); } catch {}
  return new Tokenizer(json, config);
}

/**
 * @param {object} o
 * @param {()=>string} o.dataDir
 * @param {Function} [o.loadSession] 注入以便测试；默认从 onnx-runtime 加载
 * @param {Function} [o.loadTokenizer] 注入以便测试
 * @param {Function} [o.log]
 */
export function createLocalEmbedder({
  dataDir,
  loadSession = defaultLoadSession,
  loadTokenizer = defaultLoadTokenizer,
  log = () => {},
} = {}) {
  const runtimeDir = () => join(dataDir(), 'onnx-runtime');
  const modelDir = () => join(dataDir(), 'onnx-models', 'e5-small');

  let session = null;
  let tokenizer = null;
  let loadError = '';

  function ready() {
    return existsSync(join(modelDir(), 'model.onnx')) && existsSync(join(modelDir(), 'tokenizer.json'));
  }

  async function ensure() {
    if (session && tokenizer) return true;
    if (loadError) return false;
    try {
      /** InferenceSession.create 是异步的——必须 await，否则拿到 Promise 当 session 用 */
      session = await loadSession(runtimeDir(), join(modelDir(), 'model.onnx'));
      tokenizer = loadTokenizer(runtimeDir(), modelDir());
      return true;
    } catch (e) {
      loadError = String(e?.message || e);
      log(`本地 embedding 加载失败：${loadError}`);
      return false;
    }
  }

  /** 跑一个 batch：tokenize → ONNX forward → mean pool + normalize。返回这些下标的向量 */
  async function encodeBatch(texts, indices, signal) {
    const encoded = indices.map((i) => tokenizer.encode(
      texts[i].length > 200 ? texts[i].slice(0, 200) : texts[i],
      { padding: true, truncation: true, max_length: MAX_TOKENS },
    ));
    /** JS tokenizers 的 encode 返回 {ids, attention_mask}；按 ONNX 输入名喂张量 */
    const ort = session.ort;
    if (!ort?.Tensor) throw new Error('ONNX 运行时没挂 Tensor 构造器（loadSession 不兼容）');
    /**
     * 输入名从 `session.inputNames` 读（onnxruntime-node 真实 API，实测）。
     * Hindsight 是 Python 版才有 getInputs()，JS 版没有——别照抄它那个。
     */
    const inputNames = Array.isArray(session.inputNames)
      ? session.inputNames
      : (session.getInputs?.() || []).map((x) => x.name);
    const idsName = inputNames.find((n) => /input_ids|ids/.test(n)) || 'input_ids';
    const maskName = inputNames.find((n) => /attention_mask|mask/.test(n)) || 'attention_mask';
    /** e5-small 实测需要 token_type_ids；模型声明了就一定要喂，否则 session.run 报错 */
    const typeName = inputNames.find((n) => /token_type/.test(n));
    const maxLen = Math.max(...encoded.map((e) => e.ids.length));
    const pad = (arr) => {
      const a = [...arr];
      while (a.length < maxLen) a.push(0);
      return a;
    };
    const padIds = encoded.map((e) => pad(e.ids));
    const padMask = encoded.map((e) => pad(e.attention_mask || e.ids.map(() => 1)));
    /** onnxruntime-node 的 int64 张量数据**必须是 BigInt64Array**（实测，普通 number 数组会拒） */
    const toTensor = (rows) => new ort.Tensor('int64', BigInt64Array.from(rows.flat().map((x) => BigInt(Number(x) || 0))), [rows.length, maxLen]);
    const feeds = { [idsName]: toTensor(padIds) };
    if (maskName) feeds[maskName] = toTensor(padMask);
    if (typeName) feeds[typeName] = toTensor(encoded.map(() => pad([])));
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    const outputs = await session.run(feeds);
    const first = outputs[Object.keys(outputs)[0]]?.data;
    if (!first) throw new Error('ONNX 模型没有输出');
    const hidden = Math.floor(first.length / (encoded.length * maxLen));
    if (!hidden) throw new Error('ONNX 输出维度不对');

    return encoded.map((_, k) => {
      const rows = [];
      for (let s = 0; s < maxLen; s += 1) {
        const start = (k * maxLen + s) * hidden;
        rows.push(Array.from(first.slice(start, start + hidden)));
      }
      return poolAndNormalize(rows, padMask[k]);
    });
  }

  return {
    ready,
    enabled: () => ready(),
    minScore: () => 0.4,

    /** 本地算向量；不可用返回 null（让调用方回落关键词，同 embed.js 的契约） */
    async many(texts, opts = {}) {
      const list = (texts || []).map((t) => String(t ?? ''));
      if (!list.length) return [];
      if (!ready() || !(await ensure())) return null;
      try {
        const out = new Array(list.length);
        for (const group of batchByLength(list, 16)) {
          const vecs = await encodeBatch(list, group, opts.signal);
          group.forEach((idx, k) => { out[idx] = vecs[k]; });
        }
        return out;
      } catch (e) {
        log(`本地向量算不出来：${e?.message || e}`);
        return null;
      }
    },

    async one(text, opts = {}) {
      const r = await this.many([text], opts);
      return r?.[0] ?? null;
    },
  };
}
