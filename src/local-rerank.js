/**
 * 本地 cross-encoder rerank（照抄 Hindsight `OnnxCrossEncoder._score_batch`）。
 *
 * 模型：hindsight-ai/hs-rerank-1（默认，Hindsight 的 DEFAULT_RERANKER_LOCAL_MODEL），
 * 由 onnx-model-install 下载到 `<dataDir>/onnx-models/hs-rerank-1/`；
 * 运行时复用 onnx-install 的 `<dataDir>/onnx-runtime/node_modules/`。
 *
 * 算法出处（cross_encoder.py:2146-2172）：
 *   1. tokenizer 把 (query, doc) 编成一对：encode(query, {text_pair: doc})
 *   2. ONNX session.run 拿 logits（[batch] 或 [batch,2]）
 *   3. 1 个 logit 直接取；2 个 logit 取 logits[:,1] - logits[:,0]（log-odds）
 *   4. 下游统一 sigmoid 归一到 0..1
 *
 * 与 rerank.js 的关系：这里只提供"给 query + candidates 打 relevance 分"，
 * `rerank.js` 负责按分数重排。上层接口与 vectorRerank 一致（返回分数数组）。
 *
 * 实测关键点（E2E 抓到过，别再踩）：
 *   · onnxruntime-node 输入名是 `session.inputNames` 属性，不是 getInputs()
 *   · int64 张量必须 BigInt64Array
 *   · JS tokenizers pair 编码是 encode(text, {text_pair})
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { RERANK_MODEL_ID } from './onnx-install.js';

const MAX_TOKENS = 512;

/** sigmoid：把 logit 压到 0..1（Hindsight 下游统一做） */
export function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/**
 * logits → 每对的相关性分数（纯函数，可单测）。
 * 1 个 logit 直接用；2 个 logit 取 log-odds；其他维度当坏数据丢掉。
 */
export function reduceLogits(logits, pairCount) {
  if (!Number.isFinite(pairCount) || pairCount <= 0) return [];
  const flat = Array.from(logits || []);
  if (flat.length === pairCount) return flat;
  if (flat.length === pairCount * 2) {
    const out = [];
    for (let i = 0; i < pairCount; i += 1) out.push(Number(flat[i * 2 + 1]) - Number(flat[i * 2]));
    return out;
  }
  return [];
}

function defaultLoadSession(runtimeDir, modelPath) {
  const req = createRequire(join(runtimeDir, 'noop.cjs'));
  const ort = req('onnxruntime-node');
  /** 同步 create 在新版返回 Promise，用不了就同步拿；这里统一当 Promise 用 await */
  return Promise.resolve(ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] }))
    .then((session) => { session.ort = ort; return session; });
}

function defaultLoadTokenizer(runtimeDir, modelDir) {
  const req = createRequire(join(runtimeDir, 'noop.cjs'));
  const { Tokenizer } = req('@huggingface/tokenizers');
  const json = JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8'));
  let config = {};
  try { config = JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')); } catch {}
  return new Tokenizer(json, config);
}

export function createLocalReranker({
  dataDir,
  loadSession = defaultLoadSession,
  loadTokenizer = defaultLoadTokenizer,
  log = () => {},
} = {}) {
  const runtimeDir = () => join(dataDir(), 'onnx-runtime');
  const modelDir = () => join(dataDir(), 'onnx-models', 'hs-rerank-1');

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
      session = await loadSession(runtimeDir(), join(modelDir(), 'model.onnx'));
      tokenizer = loadTokenizer(runtimeDir(), modelDir());
      return true;
    } catch (e) {
      loadError = String(e?.message || e);
      log(`本地 rerank 加载失败：${loadError}`);
      return false;
    }
  }

  /** 跑一个 batch 的 (query,doc) 对，返回原始 log-odds 分数 */
  async function scoreBatch(pairs, signal) {
    const ort = session.ort;
    if (!ort?.Tensor) throw new Error('ONNX 运行时没挂 Tensor 构造器');
    const inputNames = Array.isArray(session.inputNames)
      ? session.inputNames
      : (session.getInputs?.() || []).map((x) => x.name);
    const idsName = inputNames.find((n) => /input_ids|ids/.test(n)) || 'input_ids';
    const maskName = inputNames.find((n) => /attention_mask|mask/.test(n)) || 'attention_mask';
    const typeName = inputNames.find((n) => /token_type/.test(n));

    const encoded = pairs.map(([q, d]) => tokenizer.encode(
      String(q ?? '').slice(0, 400),
      { text_pair: String(d ?? '').slice(0, 2000), truncation: true, max_length: MAX_TOKENS },
    ));
    const maxLen = Math.max(...encoded.map((e) => e.ids.length));
    const pad = (arr) => {
      const a = [...arr];
      while (a.length < maxLen) a.push(0);
      return a;
    };
    const padIds = encoded.map((e) => pad(e.ids));
    const padMask = encoded.map((e) => pad(e.attention_mask || e.ids.map(() => 1)));
    /** int64 必须 BigInt64Array（实测） */
    const toTensor = (rows) => new ort.Tensor('int64', BigInt64Array.from(rows.flat().map((x) => BigInt(Number(x) || 0))), [rows.length, maxLen]);
    const feeds = { [idsName]: toTensor(padIds) };
    if (maskName) feeds[maskName] = toTensor(padMask);
    /** cross-encoder 的 token_type_ids：tokenizer 没给就填 0（Hindsight 同款） */
    if (typeName) {
      const types = encoded.map((e) => pad(Array.isArray(e.type_ids) ? e.type_ids : []));
      feeds[typeName] = toTensor(types);
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    const outputs = await session.run(feeds);
    const logits = outputs[Object.keys(outputs)[0]]?.data;
    if (!logits) throw new Error('rerank 模型没有输出');
    return reduceLogits(logits, pairs.length);
  }

  return {
    ready,
    modelId: () => RERANK_MODEL_ID,

    /**
     * 给 query 和候选文本打分，返回与 texts 等长的 0..1 分数数组（sigmoid 后）。
     * 不可用返回 null，让 rerank.js 回落规则/向量。
     */
    async score(query, texts, opts = {}) {
      const list = (texts || []).map((t) => String(t ?? ''));
      if (!list.length) return [];
      if (!ready() || !(await ensure())) return null;
      try {
        const pairs = list.map((t) => [String(query ?? ''), t]);
        /** 按长度分组，同批补齐不浪费（Hindsight 同款） */
        const order = [...pairs.keys()].sort((a, b) => (pairs[b][0].length + pairs[b][1].length) - (pairs[a][0].length + pairs[a][1].length));
        const out = new Array(pairs.length);
        for (let i = 0; i < order.length; i += 16) {
          const group = order.slice(i, i + 16);
          const scores = await scoreBatch(group.map((k) => pairs[k]), opts.signal);
          group.forEach((idx, k) => { out[idx] = sigmoid(scores[k] ?? 0); });
        }
        return out;
      } catch (e) {
        log(`本地 rerank 算不出来：${e?.message || e}`);
        return null;
      }
    },
  };
}
