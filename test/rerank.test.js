// 重排候选（Reranker）：默认关、规则可测、向量不可用要回落、别把召回带崩。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RERANK_DEFAULTS, keywordScore, freshness, ruleRerank, vectorRerank, rerankHits,
} from '../src/rerank.js';

const NOW = Date.UTC(2026, 10, 13, 6);
const DAY = 86_400_000;

const hits = [
  { id: 'a', text: '今天聊了搬家的事', at: NOW - DAY },
  { id: 'b', text: '猫粮买错了牌子', at: NOW - 20 * DAY },
  { id: 'c', text: '搬家那天下了雨', at: NOW - 2 * DAY },
];

test('关键词命中率：全中 1、不沾边 0、空查询 0', () => {
  assert.equal(keywordScore('搬家', '今天聊了搬家的事'), 1);
  assert.equal(keywordScore('搬家', '猫粮买错了牌子'), 0);
  assert.equal(keywordScore('', '随便什么'), 0);
  const half = keywordScore('搬家下雨', '搬家那天');
  assert.ok(half > 0 && half < 1, `部分命中应在 0–1 之间：${half}`);
});

test('新鲜度：今天 1、7 天前 0.5、越久越小，没时间给 0.3', () => {
  assert.equal(freshness(NOW, NOW), 1);
  assert.ok(Math.abs(freshness(NOW - 7 * DAY, NOW) - 0.5) < 1e-9);
  assert.ok(freshness(NOW - 60 * DAY, NOW) < freshness(NOW - 7 * DAY, NOW));
  assert.equal(freshness(0, NOW), 0.3);
});

test('规则重排：相关的那条被提到前面，且是稳定排序', () => {
  const out = ruleRerank('搬家', hits, { now: NOW, weight: 0.8 });
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'a', `最相关的应排第一：${out.map((x) => x.id)}`);
  /** 同样输入必须同样输出（不依赖随机/时间） */
  assert.deepEqual(ruleRerank('搬家', hits, { now: NOW, weight: 0.8 }).map((x) => x.id), out.map((x) => x.id));
  /** 空查询不该改变顺序（没有相关性信号，只按原名次） */
  assert.deepEqual(ruleRerank('', hits, { now: NOW, weight: 0.8 }).map((x) => x.id), ['a', 'b', 'c']);
});

test('重排入口：默认关时原样返回，开了走规则模式', async () => {
  const off = await rerankHits('搬家', hits, { cfg: {}, now: NOW });
  assert.equal(off.mode, 'off');
  assert.deepEqual(off.hits.map((x) => x.id), ['a', 'b', 'c']);

  const on = await rerankHits('搬家', hits, { cfg: { recall: { rerank: { enabled: true, useVector: false } } }, now: NOW });
  assert.equal(on.mode, 'rule');
  assert.equal(on.hits[0].id, 'a');

  /** 只有一条时不折腾 */
  const one = await rerankHits('搬家', [hits[0]], { cfg: { recall: { rerank: { enabled: true } } }, now: NOW });
  assert.equal(one.mode, 'off');
});

test('向量模式：有 embedder 走余弦；算不出来回落规则，绝不抛', async () => {
  const embedder = {
    enabled: () => true,
    one: async () => [1, 0, 0],
    many: async (texts) => texts.map((t) => (t.includes('搬家') ? [1, 0, 0] : [0, 1, 0])),
  };
  const out = await rerankHits('搬家', hits, {
    cfg: { recall: { rerank: { enabled: true, useVector: true, weight: 0.9 } } },
    embedder, now: NOW,
  });
  assert.equal(out.mode, 'vector');
  assert.equal(out.hits[0].id, 'a');

  const broken = { enabled: () => true, one: async () => { throw new Error('服务挂了'); }, many: async () => [] };
  const fallback = await rerankHits('搬家', hits, {
    cfg: { recall: { rerank: { enabled: true, useVector: true } } }, embedder: broken, now: NOW,
  });
  assert.equal(fallback.mode, 'rule', '向量挂了要回落规则，不能让召回失败');

  const noVec = await vectorRerank('搬家', hits, { embedder: { enabled: () => false } });
  assert.equal(noVec, null, '没开向量就返回 null');
});

test('配置默认值：默认关、权重 0.6、允许向量', () => {
  assert.equal(RERANK_DEFAULTS.enabled, false);
  assert.equal(RERANK_DEFAULTS.weight, 0.6);
  assert.equal(RERANK_DEFAULTS.useVector, true);
});

test('本地模式：配了 localReranker 走 cross-encoder，优先级高于向量', async () => {
  const hits = [
    { text: '无关的一条', at: NOW },
    { text: '主人搬到上海了', at: NOW },
  ];
  let called = 0;
  const fakeLocal = {
    ready: () => true,
    score: async (q, texts) => { called += 1; return texts.map((t) => (t.includes('上海') ? 0.95 : 0.1)); },
  };
  const out = await rerankHits('搬哪', hits, {
    cfg: { recall: { rerank: { enabled: true, useLocal: true } } },
    localReranker: fakeLocal,
    embedder: { enabled: () => true, one: async () => { throw new Error('不该走向量'); } },
    now: NOW,
  });
  assert.equal(called, 1);
  assert.equal(out.mode, 'local');
  assert.ok(out.hits[0].text.includes('上海'), 'cross-encoder 分高的排前面');
});

test('本地模式：模型没装好 / 算不出来时回落向量或规则，不抛', async () => {
  const hits = [{ text: '搬家', at: NOW }, { text: '天气', at: NOW }];
  const notReady = { ready: () => false, score: async () => null };
  const out = await rerankHits('搬哪', hits, {
    cfg: { recall: { rerank: { enabled: true, useLocal: true, useVector: false } } },
    localReranker: notReady,
    now: NOW,
  });
  assert.equal(out.mode, 'rule', '本地没好就回落规则');

  const broken = { ready: () => true, score: async () => { throw new Error('模拟失败'); } };
  const out2 = await rerankHits('搬哪', hits, {
    cfg: { recall: { rerank: { enabled: true, useLocal: true, useVector: false } } },
    localReranker: broken,
    now: NOW,
  });
  assert.equal(out2.mode, 'rule', '本地抛错也回落，不让召回崩');
});

test('只开 useLocal（没开 enabled 总闸）也要真重排——面板文案就是这么承诺的', async () => {
  const hits = [
    { text: '无关的一条', at: NOW },
    { text: '主人搬到上海了', at: NOW },
  ];
  const fakeLocal = {
    ready: () => true,
    score: async (q, texts) => texts.map((t) => (t.includes('上海') ? 0.95 : 0.1)),
  };
  const out = await rerankHits('搬哪', hits, {
    cfg: { recall: { rerank: { useLocal: true } } },
    localReranker: fakeLocal,
    now: NOW,
  });
  assert.equal(out.mode, 'local', 'useLocal 就该隐含 enabled');
  assert.ok(out.hits[0].text.includes('上海'));
});
