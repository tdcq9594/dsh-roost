import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sigmoid, reduceLogits, createLocalReranker } from '../src/local-rerank.js';

const dataDirOf = () => mkdtempSync(join(tmpdir(), 'roost-rerank-'));
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('sigmoid：0 → 0.5，正负对称，夹紧在 0..1', () => {
  assert.ok(close(sigmoid(0), 0.5));
  assert.ok(close(sigmoid(10) + sigmoid(-10), 1), '对称');
  assert.ok(sigmoid(1000) <= 1 && sigmoid(1000) > 0.99, '浮点下溢时正好 1 也算对');
});

test('reduceLogits：1 个 logit 直取；2 个取 log-odds；维度不对丢掉', () => {
  assert.deepEqual(reduceLogits([0.1, 0.9, -0.3], 3), [0.1, 0.9, -0.3]);
  assert.deepEqual(reduceLogits([1, 3, 2, 5], 2), [2, 3], '3-1=2, 5-2=3');
  assert.deepEqual(reduceLogits([1, 2, 3], 2), [], '维度不匹配');
});

test('ready：两个文件都在才算好', () => {
  const dir = dataDirOf();
  const inst = createLocalReranker({ dataDir: () => dir });
  assert.equal(inst.ready(), false);
  const md = join(dir, 'onnx-models', 'hs-rerank-1');
  mkdirSync(md, { recursive: true });
  writeFileSync(join(md, 'model.onnx'), 'x');
  assert.equal(inst.ready(), false, '只有模型没 tokenizer 不算好');
  writeFileSync(join(md, 'tokenizer.json'), '{}');
  assert.equal(inst.ready(), true);
});

test('score：注入假 session/tokenizer，log-odds 经 sigmoid 变成 0..1 分数', async () => {
  const dir = dataDirOf();
  const md = join(dir, 'onnx-models', 'hs-rerank-1');
  mkdirSync(md, { recursive: true });
  writeFileSync(join(md, 'model.onnx'), 'x');
  writeFileSync(join(md, 'tokenizer.json'), '{}');

  let lastFeeds = null;
  const ort = { Tensor: class { constructor(t, d, dims) { Object.assign(this, { type: t, data: d, dims }); } } };
  const fakeTokenizer = {
    encode(text, opts) {
      const ids = [...String(text)].map((c) => c.charCodeAt(0) % 100 + 1);
      const pair = [...String(opts?.text_pair || '')].map((c) => c.charCodeAt(0) % 50 + 1);
      return { ids: [...ids, ...pair], attention_mask: [...ids, ...pair].map(() => 1) };
    },
  };
  const session = {
    ort,
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    async run(feeds) {
      lastFeeds = feeds;
      const [b] = feeds.input_ids.dims;
      /** 每个 pair 给 [neg, pos] 两个 logit，pos 越大越相关；按 doc 长度制造差异 */
      const data = new Float32Array(b * 2);
      /** 越靠前的候选给越高 log-odds（模拟"第一个最相关"） */
      for (let i = 0; i < b; i += 1) { data[i * 2] = 0; data[i * 2 + 1] = b - i; }
      return { logits: { data } };
    },
  };

  const inst = createLocalReranker({
    dataDir: () => dir,
    loadSession: async () => session,
    loadTokenizer: () => fakeTokenizer,
  });
  const scores = await inst.score('住在杭州', ['杭州是住处', '天气不错', '无关']);
  assert.equal(scores.length, 3);
  assert.ok(scores[0] > scores[1] && scores[1] > scores[2], '分数按 log-odds 递增');
  assert.ok(scores.every((s) => s >= 0 && s <= 1 && Number.isFinite(s)), '都在 0..1');
  assert.deepEqual(Object.keys(lastFeeds).sort(), ['attention_mask', 'input_ids', 'token_type_ids']);
});

test('score：没模型时返回 null，不抛', async () => {
  const inst = createLocalReranker({ dataDir: () => dataDirOf() });
  assert.equal(await inst.score('q', ['a']), null);
});
