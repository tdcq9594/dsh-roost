/**
 * 共享依赖：白名单是唯一闸门，二进制的存在性是唯一判据。
 *
 * 这里不测「真装一遍」——62 MB 的下载不该进单测。测的是：
 *   · 白名单外的名字**装不了**（这是安全边界，不是便利性）；
 *   · 目录/状态结构稳定，面板读得到 `dir` 与 `ffmpeg`；
 *   · 空目录下判定为「没有」，且不会因为主包胶水代码在就误报「能用」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

/** 每个用例一个独立数据目录：`dataDir()` 每次都读环境变量，改了立刻生效 */
function sandbox(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deps-'));
    const old = process.env.DSH_ROOST_DATA;
    process.env.DSH_ROOST_DATA = dir;
    try {
      await fn(dir);
    } finally {
      if (old === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = old;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** 模块级缓存会跨用例留存，每次都要带 fresh 重新看盘 */
async function fresh() {
  const m = await import(`../src/shared-deps.js?t=${Date.now()}${Math.random()}`);
  return m;
}

test('白名单外一律拒绝，不跑 npm', sandbox(async () => {
  const d = await fresh();
  const r = await d.install('left-pad');
  assert.equal(r.ok, false);
  assert.match(r.message, /不在白名单/);
}));

test('白名单是冻结的：运行时改不动', async () => {
  const d = await fresh();
  assert.throws(() => {
    'use strict';
    d.WHITELIST['evil'] = { range: '^1.0.0' };
  }, TypeError);
  assert.equal(d.WHITELIST.evil, undefined);
});

test('空目录：状态为不可用，路径是数据目录下的 deps/', sandbox(async (dir) => {
  const d = await fresh();
  const s = d.status();
  assert.equal(s.ffmpeg, '');
  assert.equal(s.dir, join(dir, 'deps'));
  assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].available, false);
  assert.equal(d.hasFfmpeg(), false);
}));

test('只有主包胶水、没有平台二进制 → 仍然判定不可用', sandbox(async (dir) => {
  const d = await fresh();
  const pkg = join(dir, 'deps', 'node_modules', '@ffmpeg-installer', 'ffmpeg');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@ffmpeg-installer/ffmpeg', version: '1.1.0' }));
  const s = d.status();
  /** 版本号在 ≠ 能用：62MB 的 exe 在平台子包里，这是最容易误判的一处 */
  assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].version, '1.1.0');
  assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].available, false);
  assert.equal(d.hasFfmpeg(), false);
}));

test('平台二进制就位 → 判定可用，并给出绝对路径', sandbox(async (dir) => {
  const d = await fresh();
  const plat = process.platform === 'win32'
    ? `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'darwin'
      ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  const base = join(dir, 'deps', 'node_modules', '@ffmpeg-installer', plat);
  mkdirSync(base, { recursive: true });
  const exe = join(base, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  writeFileSync(exe, '');

  const s = d.status();
  assert.equal(s.ffmpeg, exe);
  assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].available, true);
  assert.equal(d.hasFfmpeg(), true);
}));

test('用户自定义数据目录时，装的位置与受管块注入的值一致', sandbox(async (dir) => {
  const d = await fresh();
  const { renderEntry } = await import('../src/ext-patch.js');

  /** 1. 装的位置跟着 dataDir 走 */
  assert.equal(d.depsDir(), join(dir, 'deps'));

  /**
   * 2. 受管块注入的 `ROOST_DEPS_DIR` 必须**同一个值**。
   *
   * 这两处一旦漂移，扩展就会去一个空目录里找 ffmpeg，表现是
   * 「面板上装好了、扩展说没装」。`createExtPatch` 的默认值是
   * `join(dir, 'deps')`，而 `dir` 传的就是 `dataDir()`。
   */
  const block = renderEntry('demo', { apiUrl: 'http://127.0.0.1:1/v1', dir });
  const m = block.match(/ROOST_DEPS_DIR: '([^']+)'/);
  assert.ok(m, '受管块里必须有 ROOST_DEPS_DIR');
  assert.equal(m[1].replace(/\\/g, '/'), join(dir, 'deps').replace(/\\/g, '/'));
}));

/* ---------------- 系统 PATH 上的 ffmpeg ---------------- */

/**
 * 造一个「PATH 上有 ffmpeg」的环境：临时目录里放一个同名空文件。
 *
 * 真实场景是用户用 apt / brew / choco / scoop 装过系统级 ffmpeg，
 * 这时再下 62MB 的 npm 包纯属浪费——以前完全看不出这件事，
 * 面板上永远显示「未安装」，点了就下一遍。
 */
function withFfmpegOnPath(fn) {
  return async () => {
    const bin = mkdtempSync(join(tmpdir(), 'dsh-ffbin-'));
    const exe = join(bin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    writeFileSync(exe, '');
    const oldPath = process.env.PATH;
    const oldPathWin = process.env.Path;
    process.env.PATH = `${bin}${delimiter}${oldPath || ''}`;
    process.env.Path = process.env.PATH;
    try {
      await fn(bin, exe);
    } finally {
      process.env.PATH = oldPath;
      if (oldPathWin === undefined) delete process.env.Path;
      else process.env.Path = oldPathWin;
      rmSync(bin, { recursive: true, force: true });
    }
  };
}

test('系统 PATH 上有 ffmpeg：能找出来，且不算「宿主装好的那份」', sandbox(async () => {
  await withFfmpegOnPath(async (_bin, exe) => {
    const d = await fresh();
    assert.equal(d.systemFfmpeg({ fresh: true }), exe);
    /** 系统那份不并进受管状态：面板的「一键安装」按 available 显示 */
    const s = d.status();
    assert.equal(s.ffmpeg, '', '受管目录里还是没有');
    assert.equal(s.systemFfmpeg, exe);
    assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].available, false);
    assert.equal(s.packages['@ffmpeg-installer/ffmpeg'].system, exe);
  })();
}));

test('系统已有 ffmpeg：默认仍然装到共享目录（扩展只认 ROOST_DEPS_DIR）', sandbox(async () => {
  await withFfmpegOnPath(async (_bin, exe) => {
    const d = await fresh();
    /**
     * 默认不跳过：扩展通过受管块里的 `ROOST_DEPS_DIR` 找二进制，
     * 系统 PATH 上那份它们看不见。跳过会变成「面板说装好了、扩展说没装」。
     * 这里只验「系统那份能被看见」，不真的跑 npm。
     */
    const r = d.resolveFfmpeg({ fresh: true });
    assert.equal(r.source, 'system');
    assert.equal(r.path, exe);
    assert.equal(d.hasFfmpeg(), false, '受管那份还是没装');
  })();
}));

test('系统已有 ffmpeg + 调用方明确要用系统的：跳过下载', sandbox(async () => {
  await withFfmpegOnPath(async (_bin, exe) => {
    const d = await fresh();
    const r = await d.install('@ffmpeg-installer/ffmpeg', { preferSystem: true });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.source, 'system');
    assert.equal(r.path, exe);
    assert.match(r.message, /系统里已有/);
  })();
}));

test('已经装好的纯 JS 包：预检直接复用，不再跑一遍 npm', sandbox(async (dir) => {
  const d = await fresh();
  const p = join(dir, 'deps', 'node_modules', 'qrcode');
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'qrcode', version: '1.5.4' }));

  const r = await d.install('qrcode');
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.source, 'managed');
}));
