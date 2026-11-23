import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createOnnxInstaller, ONNX_NODE_VERSION, ONNX_COMMON_VERSION, TOKENIZERS_VERSION, ONNX_PACKAGES,
} from '../src/onnx-install.js';
import { tgzUrl } from '../src/npm-registry.js';

const dataDirOf = () => mkdtempSync(join(tmpdir(), 'roost-onnx-'));

test('ONNX 版本固定，三个包都声明（不跟 latest）', () => {
  assert.match(ONNX_NODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(ONNX_COMMON_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(TOKENIZERS_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(ONNX_PACKAGES.map(([n]) => n), [
    'onnxruntime-common', 'onnxruntime-node', '@huggingface/tokenizers',
  ]);
});

test('npm tgz URL 用现成的 tgzUrl（不另造）：非 scoped 直链', () => {
  const url = tgzUrl('onnxruntime-node', ONNX_NODE_VERSION, 'https://registry.npmjs.org');
  assert.equal(url, `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNX_NODE_VERSION}.tgz`);
});

test('ready：没装时 false；有包目录 + bin 时 true；probe 优先', () => {
  const dir = dataDirOf();
  const inst = createOnnxInstaller({ dataDir: () => dir });
  assert.equal(inst.ready(), false, '空目录不该说装好了');

  const pkg = join(dir, 'onnx-runtime', 'node_modules', 'onnxruntime-node', 'bin');
  mkdirSync(pkg, { recursive: true });
  assert.equal(inst.ready(), true, '包目录 + bin 在就算装好（默认判据）');

  let probed = 0;
  const inst2 = createOnnxInstaller({
    dataDir: () => dir,
    probe: () => { probed += 1; return false; },
  });
  assert.equal(inst2.ready(), false, 'probe 说没好就没好');
  assert.equal(probed, 1, 'probe 真被调用（不是只看目录）');
});

test('runtimeDir：落到数据目录的 onnx-runtime（插件更新冲不掉）', () => {
  const dir = dataDirOf();
  const inst = createOnnxInstaller({ dataDir: () => dir });
  assert.equal(inst.runtimeDir(), join(dir, 'onnx-runtime'));
});

test('start 正在跑时第二次返回 busy，不并发', async () => {
  const dir = dataDirOf();
  /** 假下载：侦听 signal（真实 fetch 的契约），不真下东西 */
  const hang = (_url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const inst = createOnnxInstaller({
    dataDir: () => dir,
    fetchImpl: hang,
  });
  const first = inst.start();
  assert.equal(first.ok, true);
  assert.equal(inst.status().running, true);
  const second = inst.start();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  inst.cancel();
});

test('cancel 后状态是「已取消」不是失败，且 error 为空', async () => {
  const dir = dataDirOf();
  const hangFetch = (_url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const inst = createOnnxInstaller({
    dataDir: () => dir,
    fetchImpl: hangFetch,
  });
  inst.start();
  /** 轮询到真的进入下载（fetch 已拿到 signal）再取消，不靠 sleep 猜时序 */
  for (let i = 0; i < 500 && !/下载 onnxruntime/.test(inst.status().message); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.match(inst.status().message, /下载 onnxruntime/, '测试前置：已进入 fetch');
  assert.equal(inst.cancel().ok, true);
  await new Promise((r) => setImmediate(r));
  const st = inst.status();
  assert.equal(st.running, false);
  assert.equal(st.error, '', '取消不写红字');
  assert.match(st.message, /取消/);
});

test('uninstall：删掉 onnx-runtime，状态归零；运行中拒绝', async () => {
  const dir = dataDirOf();
  const hangFetch = (_url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const inst = createOnnxInstaller({
    dataDir: () => dir,
    fetchImpl: hangFetch,
  });
  const pkg = join(dir, 'onnx-runtime', 'node_modules', 'onnxruntime-node', 'bin');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'dummy.node'), 'x');
  assert.equal(inst.ready(), true);

  inst.start();
  assert.equal(inst.uninstall().reason, 'busy', '装的时候不许卸');
  for (let i = 0; i < 500 && !/下载 onnxruntime/.test(inst.status().message); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  inst.cancel();
  for (let i = 0; i < 500 && inst.status().running; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(inst.uninstall().ok, true);
  assert.equal(existsSync(join(dir, 'onnx-runtime')), false, '目录删干净');
  assert.equal(inst.ready(), false);
  const st = inst.status();
  assert.equal(st.phase, 'idle');
  assert.equal(st.received, 0);
});

test('status 带百分比：字节已知时算出来，未知时 0', () => {
  const dir = dataDirOf();
  const inst = createOnnxInstaller({ dataDir: () => dir });
  assert.equal(inst.status().percent, 0);
});

test('usage：没装时 0 字节', () => {
  const dir = dataDirOf();
  const inst = createOnnxInstaller({ dataDir: () => dir });
  assert.equal(inst.usage().bytes, 0);
});
