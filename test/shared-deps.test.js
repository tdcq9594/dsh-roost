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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

/* ---------------- 功能包：自动查找与扩展目录（2026-11-22） ---------------- */

/**
 * 造一个「像被 npm 装过」的包：目录 + package.json + **能 require 的入口**。
 *
 * 只写 package.json 不够——`load()` 会真的去 require 那个入口，文件不在就
 * 变成「装了但加载失败」，测出来的结论会和真实环境不一样（真实装好的包
 * 入口一定在）。
 */
function fakePkg(root, name, version) {
  const p = join(root, 'node_modules', name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  writeFileSync(join(p, 'index.js'), `module.exports = { ver: ${JSON.stringify(version)} };\n`);
  return p;
}

/**
 * 白名单本身的自检：**每条都得是「真装了会有人用」的东西**。
 *
 * 这条曾经断言 `jimp` 在名单里、归 `image` 组。问题是那三件事（感知哈希去重 /
 * 缩略图 / 拼长图）一件都没实现，`load()` 全仓没有调用方——面板给出一个 15MB
 * 的「安装」按钮，点完什么都不变。测试当时护着的是「广告位别被删」。
 *
 * 现在改成护着**该有的形状**：元数据齐全、版本不许放 `latest`（白名单是靠
 * 人工核对过 postinstall 的，`latest` 等于放弃这个保证）。
 */
test('白名单：元数据齐全、版本锁范围而不是 latest', async () => {
  const d = await fresh();
  const names = Object.keys(d.WHITELIST);
  assert.ok(names.length > 0, '一条都没有，面板就没东西可装');
  for (const name of names) {
    const m = d.WHITELIST[name];
    assert.ok(m.range && m.range !== 'latest', `${name}：range 不能是 latest`);
    assert.ok(m.size, `${name}：缺 size，面板显示不出「要下多少」`);
    assert.ok(m.group, `${name}：缺 group，面板分不了组`);
    assert.ok(m.desc, `${name}：缺 desc，用户不知道装它干嘛`);
  }
});

test('注入扩展目录：自动找到、能加载、安装直接复用（不再下一遍 15MB）', sandbox(async (dir) => {
  const d = await fresh();
  const extRoot = join(dir, 'extensions', 'ext-a');
  fakePkg(extRoot, 'qrcode', '9.9.9');

  assert.equal(d.setExtDirs([{ id: 'ext-a', dir: extRoot }]), 1);

  const hit = d.findPackage('qrcode');
  assert.equal(hit.kind, 'ext');
  assert.equal(hit.id, 'ext-a');
  assert.equal(hit.version, '9.9.9');

  const s = d.scan();
  assert.equal(s.packages.qrcode.found.label, '扩展 ext-a');
  assert.equal(s.packages.qrcode.removable, false, '扩展那份不归面板删');

  const mod = await d.load('qrcode', { fresh: true });
  assert.equal(mod.ver, '9.9.9', 'load 必须能从扩展目录解析出来');

  const r = await d.install('qrcode');
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true, '该复用而不是下载');
  assert.equal(r.source, 'ext');
}));

test('卸载扩展那份：拒绝，并说清它在哪个目录', sandbox(async (dir) => {
  const d = await fresh();
  const extRoot = join(dir, 'extensions', 'ext-a');
  const p = fakePkg(extRoot, 'qrcode', '9.9.9');
  d.setExtDirs([{ id: 'ext-a', dir: extRoot }]);

  const r = d.remove('qrcode');
  assert.equal(r.ok, false);
  assert.match(r.message, /扩展 ext-a/);
  assert.ok(existsSync(p), '替扩展删依赖会把扩展弄坏，必须原样留着');
}));

test('共享目录优先于扩展目录；删掉共享那份后自动回落扩展那份', sandbox(async (dir) => {
  const d = await fresh();
  const extRoot = join(dir, 'extensions', 'ext-a');
  fakePkg(extRoot, 'qrcode', '9.9.9');
  fakePkg(join(dir, 'deps'), 'qrcode', '1.5.4');
  d.setExtDirs([{ id: 'ext-a', dir: extRoot }]);

  const hit = d.findPackage('qrcode', { fresh: true });
  assert.equal(hit.kind, 'shared', '共享目录是面板装的地方，必须优先');
  assert.equal(hit.version, '1.5.4');
  assert.equal(d.scan().packages.qrcode.removable, true);

  assert.equal(d.remove('qrcode').ok, true);

  const back = d.findPackage('qrcode', { fresh: true });
  assert.equal(back.kind, 'ext', '删完不能变成「没有」，扩展那份还是能用');
}));

test('清空扩展目录：查找缓存必须一起失效', sandbox(async (dir) => {
  const d = await fresh();
  const extRoot = join(dir, 'extensions', 'ext-a');
  fakePkg(extRoot, 'qrcode', '9.9.9');
  d.setExtDirs([{ id: 'ext-a', dir: extRoot }]);
  assert.equal(d.findPackage('qrcode').kind, 'ext');

  d.setExtDirs([]);
  assert.equal(d.findPackage('qrcode'), null, '卸载扩展后不能还记着「有」');
  assert.equal(d.extDirsSnapshot().length, 0);
}));

test('白名单外 / 空名字：一律 null（别拿它当通用文件探测器）', sandbox(async () => {
  const d = await fresh();
  assert.equal(d.findPackage('../../etc/passwd'), null);
  assert.equal(d.findPackage('shell'), null);
  assert.equal(d.findPackage(''), null);
  assert.equal(await d.load('shell'), null);
  assert.equal(d.remove('shell').ok, false);
}));

test('包在但入口坏掉：load 返回 null，不抛给调用方', sandbox(async (dir) => {
  const d = await fresh();
  const extRoot = join(dir, 'extensions', 'ext-b');
  const p = join(extRoot, 'node_modules', 'qrcode');
  mkdirSync(p, { recursive: true });
  /** 有 package.json（所以算「装了」），但 main 指向不存在的文件 */
  writeFileSync(join(p, 'package.json'), JSON.stringify({ name: 'qrcode', version: '0.0.1', main: 'nope.js' }));
  d.setExtDirs([{ id: 'ext-b', dir: extRoot }]);

  assert.equal(d.findPackage('qrcode', { fresh: true }).version, '0.0.1');
  assert.equal(await d.load('qrcode', { fresh: true }), null, '坏了就当没有，别让图库整条链崩');
}));

/* ---------------- 其他运行时目录：只读列出 ---------------- */

test('runtimeScan：能列出别的运行时装了什么，@scope 要展开一层', sandbox(async (dir) => {
  const d = await fresh();
  const tts = join(dir, 'tts-runtime');
  const scoped = join(tts, 'node_modules', '@sherpa', 'engine');
  mkdirSync(scoped, { recursive: true });
  writeFileSync(join(scoped, 'package.json'), JSON.stringify({ name: '@sherpa/engine', version: '1.0.0' }));

  const r = d.runtimeScan([
    { id: 'tts', label: '语音引擎', dir: tts },
    { id: 'none', label: '没装的那个', dir: join(dir, 'nope') },
  ]);

  assert.equal(r[0].exists, true);
  assert.deepEqual(r[0].packages, ['@sherpa/engine'], '不展开的话只会看到 @sherpa，没有信息量');
  assert.equal(r[1].exists, false);
  assert.deepEqual(r[1].packages, []);
}));

test('runtimeScan：空 / null / 脏数据都不抛', async () => {
  const d = await fresh();
  assert.deepEqual(d.runtimeScan(), []);
  assert.deepEqual(d.runtimeScan(null), []);
  assert.equal(d.runtimeScan([{}])[0].exists, false);
  assert.equal(d.runtimeScan([{}])[0].dir, '');
});
