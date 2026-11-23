import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { poolAndNormalize, batchByLength, createLocalEmbedder, QUERY_PREFIX, PASSAGE_PREFIX } from '../src/local-embed.js';

const dataDirOf = () => mkdtempSync(join(tmpdir(), 'roost-localembed-'));
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('poolAndNormalize：mask 屏蔽 padding，输出 L2 归一化', () => {
  const v = poolAndNormalize([[3, 4], [100, 100]], [1, 0]);
  assert.equal(v.length, 2);
  /** 只有第一条计入，[3,4] 归一化后 [0.6,0.8] */
  assert.ok(close(v[0], 0.6), `v0=${v[0]}`);
  assert.ok(close(v[1], 0.8), `v1=${v[1]}`);
  assert.ok(close(Math.hypot(v[0], v[1]), 1), '模长=1');
});

test('poolAndNormalize：没有 mask 时全 1 计入；全 mask=0 也不除零', () => {
  const a = poolAndNormalize([[1, 0], [0, 1]]);
  assert.ok(close(a[0], Math.SQRT1_2));
  assert.ok(close(a[1], Math.SQRT1_2));
  const b = poolAndNormalize([[5, 5]], [0]);
  assert.ok(Number.isFinite(b[0]) && Number.isFinite(b[1]), '全屏蔽不该出 NaN');
});

test('poolAndNormalize：normalized=false 时只做平均不归一化', () => {
  const v = poolAndNormalize([[3, 4]], [1], { normalized: false });
  assert.ok(close(v[0], 3) && close(v[1], 4));
});

test('batchByLength：长句在前、短句抱团，下标不丢', () => {
  const g = batchByLength(['a', 'abcdefghij', 'abc', 'ab'], 2);
  assert.deepEqual(g.flat().sort(), [0, 1, 2, 3]);
  assert.equal(g[0][0], 1, '最长的排第一组');
});

test('前缀对齐 Hindsight：查询 query: / 文档 passage:', () => {
  assert.equal(QUERY_PREFIX, 'query: ');
  assert.equal(PASSAGE_PREFIX, 'passage: ');
});

test('createLocalEmbedder：没模型文件时 enabled=false，many 返回 null', async () => {
  const dir = dataDirOf();
  const inst = createLocalEmbedder({ dataDir: () => dir });
  assert.equal(inst.enabled(), false);
  assert.equal(inst.minScore(), 0.4);
  assert.equal(await inst.many(['你好']), null, '没模型就回落关键词，不报错');
});

test('createLocalEmbedder：注入假 session/tokenizer，端到端算中文向量', async () => {
  const dir = dataDirOf();
  const md = join(dir, 'onnx-models', 'e5-small');
  mkdirSync(md, { recursive: true });
  writeFileSync(join(md, 'model.onnx'), 'x');
  writeFileSync(join(md, 'tokenizer.json'), '{}');

  /** 假 tokenizer：每个字一个 id（这里只验数据流，不验真实分词） */
  const fakeTokenizer = {
    encode(text) {
      const ids = [...text].map((c) => c.charCodeAt(0) % 100 + 1);
      return { ids, attention_mask: ids.map(() => 1) };
    },
  };
  /** 假 session：按输入张量形状回一段可预测的 [batch,seq,hidden] */
  const fakeOrt = { Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } } };
  let lastFeeds = null;
  const fakeSession = {
    ort: fakeOrt,
    /** 真实 onnxruntime-node 是 inputNames 属性（没有 getInputs()），E2E 抓到过这个坑 */
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    async run(feeds) {
      lastFeeds = feeds;
      const [b, s] = feeds.input_ids.dims;
      const hidden = 3;
      const data = new Float32Array(b * s * hidden);
      for (let i = 0; i < b * s; i += 1) for (let j = 0; j < hidden; j += 1) data[i * hidden + j] = j + 1;
      return { last_hidden_state: { data } };
    },
  };

  const inst = createLocalEmbedder({
    dataDir: () => dir,
    loadSession: async () => fakeSession,
    loadTokenizer: () => fakeTokenizer,
  });
  assert.equal(inst.enabled(), true);
  const vecs = await inst.many(['主人住在杭州', '嗯']);
  assert.equal(vecs.length, 2);
  assert.equal(vecs[0].length, 3);
  /** 每个 token 的向量都是 [1,2,3]，mean pool 后归一化 → [1,2,3]/√14 */
  assert.ok(close(vecs[0][0], 1 / Math.sqrt(14)), `v=${[...vecs[0]]}`);
  assert.ok(close(vecs[1][2], 3 / Math.sqrt(14)));
  /** 回归：模型声明了 token_type_ids 就必须喂，否则真 E2E 会报 missing in feeds */
  assert.deepEqual(Object.keys(lastFeeds).sort(), ['attention_mask', 'input_ids', 'token_type_ids']);
  const single = await inst.one('你好');
  assert.equal(single.length, 3);
});

test('createLocalEmbedder：session 加载失败时 many 返回 null，不抛', async () => {
  const dir = dataDirOf();
  const md = join(dir, 'onnx-models', 'e5-small');
  mkdirSync(md, { recursive: true });
  writeFileSync(join(md, 'model.onnx'), 'x');
  writeFileSync(join(md, 'tokenizer.json'), '{}');
  const inst = createLocalEmbedder({
    dataDir: () => dir,
    loadSession: () => { throw new Error('模拟加载失败'); },
    loadTokenizer: () => ({}),
    log: () => {},
  });
  assert.equal(await inst.many(['你好']), null);
});

/* ---------------- embed.js 的本地分支（localOf getter） ---------------- */

test('embed.js：localOf 返回可用本地模型时优先用它，不碰 HTTP', async () => {
  const { createEmbedder } = await import('../src/embed.js');
  let httpCalled = false;
  const fakeLocal = {
    enabled: () => true,
    minScore: () => 0.33,
    many: async (texts) => texts.map(() => Float32Array.from([1, 0])),
    one: async () => Float32Array.from([1, 0]),
  };
  const embed = createEmbedder({
    /** 配了 HTTP 端点，但本地优先——http 不该被调用 */
    cfgOf: () => ({ model: 'x', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }),
    localOf: () => fakeLocal,
    fetchImpl: (() => { httpCalled = true; throw new Error('不该走 HTTP'); }),
    log: () => {},
  });
  assert.equal(embed.enabled(), true);
  assert.equal(embed.minScore(), 0.33);
  const vecs = await embed.many(['你好', '在吗']);
  assert.equal(vecs.length, 2);
  assert.equal(httpCalled, false, '本地可用时不该发 HTTP');
});

test('embed.js：localOf 没开时回落 HTTP 配置；都没配就安静返回 null', async () => {
  const { createEmbedder } = await import('../src/embed.js');
  const localOff = { enabled: () => false, minScore: () => 0.4, many: async () => null, one: async () => null };
  const noHttp = createEmbedder({ cfgOf: () => null, localOf: () => localOff });
  assert.equal(noHttp.enabled(), false);
  assert.equal(await noHttp.many(['x']), null);
  assert.equal(await noHttp.one('x'), null);
  /** localOf 关、HTTP 配着：enabled 仍 true，minScore 用 HTTP 的 */
  const withHttp = createEmbedder({
    cfgOf: () => ({ model: 'x', baseUrl: 'http://x/v1', minScore: 0.5 }),
    localOf: () => localOff,
  });
  assert.equal(withHttp.enabled(), true);
  assert.equal(withHttp.minScore(), 0.5);
});

test('embed.js：配置了 localOf 但开关中途关掉，下一轮就回落（getter 生效）', async () => {
  const { createEmbedder } = await import('../src/embed.js');
  let on = true;
  const fakeLocal = { enabled: () => on, minScore: () => 0.4, many: async () => [Float32Array.from([1])], one: async () => Float32Array.from([1]) };
  const embed = createEmbedder({ cfgOf: () => null, localOf: () => (on ? fakeLocal : null) });
  assert.equal(embed.enabled(), true);
  on = false;
  assert.equal(embed.enabled(), false, 'getter 每轮现读，开关关了立刻生效');
});
