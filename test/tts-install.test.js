import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTtsInstaller, platformPackage } from '../src/tts-install.js';

/**
 * 安装器靠系统 tar 解压，所以这些用例只在有 tar 的机器上跑。
 * 没有 tar 时直接 skip——测试不该因为「这台机器没装 tar」变红，
 * 那属于环境问题，不是代码问题。
 */
function hasTar() {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TAR = hasTar();

/**
 * 测试造包时也要躲开 GNU tar 在 Windows 上的 `C:` 陷阱——
 * 和生产代码里 `untar()` 的 `--force-local` 是同一个原因。
 */
const GNU_TAR = (() => {
  try {
    return /GNU tar/i.test(execFileSync('tar', ['--version'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
})();
const tarArgs = (args) => (GNU_TAR && process.platform === 'win32' ? ['--force-local', ...args] : args);

/** 造一个 npm 风格的 tgz：解出来是 package/xxx */
function makeNpmTgz(dir, name, files) {
  const src = join(dir, `src-${name}`);
  mkdirSync(join(src, 'package'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(src, 'package', file), content);
  }
  const out = join(dir, `${name}.tgz`);
  execFileSync('tar', tarArgs(['-czf', out, '-C', src, 'package']));
  return out;
}

/** 造一个模型包：解出来是 vits-icefall-zh-aishell3/ */
function makeModelTar(dir) {
  const src = join(dir, 'src-model');
  const inner = join(src, 'vits-icefall-zh-aishell3');
  mkdirSync(inner, { recursive: true });
  for (const f of ['model.onnx', 'tokens.txt', 'lexicon.txt']) {
    writeFileSync(join(inner, f), `fake-${f}`);
  }
  const out = join(dir, 'model.tar.bz2');
  execFileSync('tar', tarArgs(['-cjf', out, '-C', src, 'vits-icefall-zh-aishell3']));
  return out;
}

/** 用本地文件冒充 registry 和 GitHub 的响应 */
function fakeFetch(map) {
  const calls = [];
  const impl = async (url) => {
    const key = Object.keys(map).find((k) => String(url).includes(k));
    calls.push(String(url));
    if (!key) return new Response('not found', { status: 404 });
    const body = readFileSync(map[key]);
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  };
  impl.calls = calls;
  return impl;
}

const waitIdle = async (installer, timeoutMs = 20_000) => {
  const start = Date.now();
  while (installer.status().running) {
    if (Date.now() - start > timeoutMs) throw new Error('安装超时');
    await new Promise((r) => setTimeout(r, 50));
  }
  return installer.status();
};

test('安装器：不认识的模型直接拒绝，不建目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-inst-'));
  const installer = createTtsInstaller({ dataDir: () => dir });
  const r = installer.start('nope');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown_model');
  assert.equal(installer.status().running, false);
  assert.equal(existsSync(join(dir, 'tts-runtime')), false);
});

test('安装器：正在装时第二次点击返回 busy，不并发写同一个目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-inst-'));
  const installer = createTtsInstaller({ dataDir: () => dir, fetchImpl: () => new Promise(() => {}) });
  assert.equal(installer.start('aishell3').ok, true);
  const again = installer.start('aishell3');
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'busy');
  installer.cancel();
});

test('安装器：完整装一遍，引擎和模型都落在数据目录', { skip: !TAR && '本机没有 tar' }, async () => {
  /**
   * 平台包名必须问安装器要，不能写死。
   *
   * 这里原来写的是 `sherpa-onnx-win-x64`——在 Windows 上跑得好好的，
   * 到了 Linux CI 上安装器请求的是 `sherpa-onnx-linux-x64`，桩里没有
   * 对应条目，于是下载 404，整个 job 变红（2026-11-04）。
   */
  const platformPkg = platformPackage();
  if (!platformPkg) return; // 这个平台没有预编译包，跳过

  const dir = mkdtempSync(join(tmpdir(), 'roost-inst-'));
  const work = mkdtempSync(join(tmpdir(), 'roost-pkg-'));
  const nodeTgz = makeNpmTgz(work, 'sherpa-onnx-node', { 'sherpa-onnx.js': 'module.exports={};\n' });
  const platformTgz = makeNpmTgz(work, platformPkg, { 'index.js': 'module.exports={};\n' });
  const modelTar = makeModelTar(work);

  const fetchImpl = fakeFetch({
    'sherpa-onnx-node/-/sherpa-onnx-node': nodeTgz,
    [`${platformPkg}/-/${platformPkg}`]: platformTgz,
    'vits-icefall-zh-aishell3.tar.bz2': modelTar,
  });

  const installer = createTtsInstaller({ dataDir: () => dir, fetchImpl });
  assert.equal(installer.start('aishell3').ok, true);
  const state = await waitIdle(installer);

  assert.equal(state.phase, 'done', state.error || state.message);
  assert.equal(state.error, '');

  // 引擎：两个包都解到 node_modules 下，且没有残留的 .tmp
  assert.equal(existsSync(join(dir, 'tts-runtime', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js')), true);
  assert.equal(existsSync(join(dir, 'tts-runtime', 'node_modules', platformPkg, 'index.js')), true);
  assert.equal(existsSync(join(dir, 'tts-runtime', '.tmp')), false);

  // 模型：目录名必须和 tts.js 里登记的 dir 一致，否则合成时找不到
  const modelDir = join(dir, 'tts-models', 'vits-icefall-zh-aishell3');
  assert.equal(readFileSync(join(modelDir, 'model.onnx'), 'utf8'), 'fake-model.onnx');
  assert.equal(existsSync(join(dir, 'tts-models', '.tmp')), false);

  // 占用统计能读出来（面板要显示）
  const usage = installer.usage('aishell3');
  assert.ok(usage.engine > 0);
  assert.ok(usage.model > 0);
});

test('安装器：下载失败时报错并清掉半成品，不留几十 MB 垃圾', { skip: !TAR && '本机没有 tar' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-inst-'));
  const work = mkdtempSync(join(tmpdir(), 'roost-pkg-'));
  const nodeTgz = makeNpmTgz(work, 'sherpa-onnx-node', { 'sherpa-onnx.js': 'x' });

  const fetchImpl = fakeFetch({
    'sherpa-onnx-node/-/sherpa-onnx-node': nodeTgz,
    // 平台包故意不给 → 404
  });

  const installer = createTtsInstaller({ dataDir: () => dir, fetchImpl });
  installer.start('aishell3');
  const state = await waitIdle(installer);

  assert.equal(state.phase, 'error');
  assert.match(state.error, /下载失败/);
  assert.equal(existsSync(join(dir, 'tts-runtime', '.tmp')), false);
  assert.equal(existsSync(join(dir, 'tts-runtime', 'node_modules')), false);
});

test('安装器：取消后不再继续，状态是「已取消」而不是失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-inst-'));
  /**
   * 假 fetch 必须**尊重 signal**：真实的 fetch 被 abort 会 reject，
   * 假的要是不管 signal，取消就永远落不下来，测出来的「卡住」是假的。
   */
  const hangingFetch = (_url, init) => new Promise((_, reject) => {
    const bail = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    };
    if (init?.signal?.aborted) return bail();
    init?.signal?.addEventListener('abort', bail);
  });
  const installer = createTtsInstaller({ dataDir: () => dir, fetchImpl: hangingFetch });
  installer.start('aishell3');
  assert.equal(installer.status().running, true);
  assert.equal(installer.cancel().ok, true);
  // 取消要穿过「找 tar」这一步才落地，等它自己停
  return waitIdle(installer, 5000).then((s) => {
    assert.equal(s.running, false);
    assert.equal(s.message, '已取消');
    assert.equal(s.error, '');
    /** 取消不是失败：面板要显示「已取消」，不该是红字报错 */
    assert.equal(s.phase, 'idle');
  });
});

test('卸载：删掉引擎和模型目录，配置不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-inst-'));
  const modelDir = join(dir, 'tts-models', 'vits-icefall-zh-aishell3');
  mkdirSync(modelDir, { recursive: true });
  mkdirSync(join(dir, 'tts-runtime', 'node_modules'), { recursive: true });
  writeFileSync(join(modelDir, 'model.onnx'), 'x');

  const installer = createTtsInstaller({ dataDir: () => dir });
  assert.equal(installer.uninstall('aishell3').ok, true);
  assert.equal(existsSync(join(dir, 'tts-runtime')), false);
  assert.equal(existsSync(modelDir), false);
});
