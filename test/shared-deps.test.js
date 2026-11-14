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
import { join } from 'node:path';

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
