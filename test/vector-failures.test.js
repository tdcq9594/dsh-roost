// 向量失败上报（跟进 #527）：最近一次失败的落盘与降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordVectorFailure, lastVectorFailure, FAILURE_FILE } from '../src/vector-failures.js';

/** 用 DSH_ROOST_DATA 隔离到临时目录（dataDir 读这个环境变量） */
const withDir = (fn) => {
  const d = mkdtempSync(join(tmpdir(), 'vec-fail-'));
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = d;
  try { return fn(d); } finally {
    if (old === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = old;
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
};

test('失败记录：写入后能读回，只留最近一次', () => withDir((d) => {
  assert.equal(lastVectorFailure(), null, '没有文件时当没失败过');
  recordVectorFailure('remote', '向量接口 500');
  const first = lastVectorFailure();
  assert.equal(first.source, 'remote');
  assert.match(first.message, /500/);
  assert.ok(first.at > 0);
  recordVectorFailure('local-load', 'onnx 模型缺失');
  assert.equal(lastVectorFailure().source, 'local-load', '只留最近一次');
}));

test('坏文件降级为空，不让诊断把宿主拖崩', () => withDir((d) => {
  writeFileSync(join(d, FAILURE_FILE), '{坏 JSON', 'utf8');
  assert.equal(lastVectorFailure(), null);
}));
