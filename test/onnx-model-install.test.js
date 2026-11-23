import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createModelInstaller } from '../src/onnx-model-install.js';
import { EMBED_MODEL_ID, EMBED_FILES, HF_REGISTRIES, hfFileUrl } from '../src/onnx-install.js';

const dataDirOf = () => mkdtempSync(join(tmpdir(), 'roost-model-'));
test('模型常量对齐 Hindsight：e5-small + 三个文件', () => {
  assert.equal(EMBED_MODEL_ID, 'intfloat/multilingual-e5-small');
  assert.deepEqual(EMBED_FILES.map(([r]) => r), ['onnx/model.onnx', 'tokenizer.json', 'tokenizer_config.json']);
  assert.deepEqual([...HF_REGISTRIES], ['https://hf-mirror.com', 'https://huggingface.co']);
});

test('hfFileUrl：镜像与官方都能拼，路径含 model id 与文件名', () => {
  assert.equal(
    hfFileUrl(EMBED_MODEL_ID, 'tokenizer.json', 'https://hf-mirror.com'),
    `https://hf-mirror.com/${EMBED_MODEL_ID}/resolve/main/tokenizer.json`,
  );
});

test('ready：三文件缺一不可；paths 给全路径', () => {
  const dir = dataDirOf();
  const inst = createModelInstaller({ dataDir: () => dir });
  assert.equal(inst.ready(), false);
  assert.equal(inst.modelId(), EMBED_MODEL_ID);
  const p = inst.paths();
  assert.equal(p['tokenizer.json'], join(dir, 'onnx-models', 'e5-small', 'tokenizer.json'));
  mkdirSync(join(dir, 'onnx-models', 'e5-small'), { recursive: true });
  for (const [, name] of EMBED_FILES) writeFileSync(join(dir, 'onnx-models', 'e5-small', name), 'x');
  assert.equal(inst.ready(), true);
});

test('start 正在跑时 busy；cancel 后是「已取消」不是失败', async () => {
  const dir = dataDirOf();
  const hang = (_url, opts) => new Promise((_res, rej) => {
    opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const inst = createModelInstaller({ dataDir: () => dir, fetchImpl: hang });
  assert.equal(inst.start().ok, true);
  assert.equal(inst.start().reason, 'busy');
  for (let i = 0; i < 500 && !/下载/.test(inst.status().message); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(inst.cancel().ok, true);
  for (let i = 0; i < 500 && inst.status().running; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const st = inst.status();
  assert.equal(st.running, false);
  assert.equal(st.error, '');
  assert.match(st.message, /取消/);
});

test('uninstall：删模型目录，不碰运行时；运行中拒绝', async () => {
  const dir = dataDirOf();
  const hangFetch = (_url, opts) => new Promise((_res, rej) => {
    opts?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const inst = createModelInstaller({
    dataDir: () => dir,
    fetchImpl: hangFetch,
  });
  const modelPath = join(dir, 'onnx-models', 'e5-small');
  mkdirSync(modelPath, { recursive: true });
  writeFileSync(join(modelPath, 'model.onnx'), 'x');
  /** 运行时目录在旁边，卸载模型不该删它 */
  const runtime = join(dir, 'onnx-runtime', 'node_modules');
  mkdirSync(runtime, { recursive: true });

  inst.start();
  assert.equal(inst.uninstall().reason, 'busy');
  for (let i = 0; i < 500 && !/下载/.test(inst.status().message); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  inst.cancel();
  for (let i = 0; i < 500 && inst.status().running; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(inst.uninstall().ok, true);
  assert.equal(existsSync(modelPath), false);
  assert.equal(existsSync(runtime), true, '运行时目录不能跟着删');
});

test('usage：没装时 0 字节', () => {
  const inst = createModelInstaller({ dataDir: () => dataDirOf() });
  assert.equal(inst.usage().bytes, 0);
});
