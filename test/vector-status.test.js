/**
 * 3.4 向量/重排状态投影（只读纯函数）。
 * 核心断言：开关开了模型没装好要说清卡在哪，不能静默显示"已开"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vectorStatus } from '../src/vector-status.js';

test('默认：向量未启用，走纯关键词', () => {
  const r = vectorStatus({});
  assert.equal(r.vector.enabled, false);
  assert.equal(r.vector.mode, 'off');
  assert.equal(r.rerank.mode, 'off');
  assert.match(r.summary, /纯关键词/);
  assert.deepEqual(r.warnings, []);
});

test('本地向量装好并开启：mode=local', () => {
  const r = vectorStatus({ embedEnabled: true, embedModelId: 'local', localEmbedWanted: true, localEmbedReady: true });
  assert.equal(r.vector.mode, 'local');
  assert.match(r.summary, /本地/);
  assert.deepEqual(r.warnings, []);
});

test('远程向量配好：mode=remote', () => {
  const r = vectorStatus({ embedEnabled: true, embedModelId: 'http:bge-m3', remoteConfigured: true });
  assert.equal(r.vector.mode, 'remote');
  assert.match(r.summary, /远程/);
});

test('本地开关开了但模型没装好：明确告警，不假装生效', () => {
  const r = vectorStatus({ localEmbedWanted: true, localEmbedReady: false });
  assert.equal(r.vector.enabled, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /没装好.*回落纯关键词/);
  assert.match(r.warnings[0], /e5-small/);
});

test('重排开但本地模型没装好：告警回落规则重排', () => {
  const r = vectorStatus({ rerankEnabled: true, localRerankReady: false });
  assert.equal(r.rerank.mode, 'rule');
  assert.ok(r.warnings.some((w) => /hs-rerank-1/.test(w)));
});

test('重排本地模型就绪：mode=local，无告警', () => {
  const r = vectorStatus({ rerankEnabled: true, localRerankReady: true });
  assert.equal(r.rerank.mode, 'local');
  assert.deepEqual(r.warnings, []);
});

test('纯函数不改入参', () => {
  const s = { embedEnabled: true, embedModelId: 'local' };
  const snap = JSON.stringify(s);
  vectorStatus(s);
  assert.equal(JSON.stringify(s), snap);
});

test('G2：索引进度四字段（dims/indexed/total/lastError），缺省为 0 兼容老调用', () => {
  const r = vectorStatus({ dims: 384, indexed: 10, total: 100, lastError: 'boom' });
  assert.equal(r.vector.dims, 384);
  assert.equal(r.vector.indexed, 10);
  assert.equal(r.vector.total, 100);
  assert.equal(r.vector.lastError, 'boom');
  const old = vectorStatus({});
  assert.equal(old.vector.dims, 0);
  assert.equal(old.vector.indexed, 0);
  assert.equal(old.vector.lastError, '');
});
