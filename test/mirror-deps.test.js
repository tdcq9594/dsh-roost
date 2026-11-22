/**
 * 依赖备选源（市场仓 `deps/`）的护栏测试。
 *
 * 这条路的定位是「npm 彻底不行时的最后一根绳」，所以测的重点不是
 * 「能不能装上」（那是功能），而是：
 *   · 版本不对**不许硬装**（装了旧版会让面板说已装、API 却不兼容）；
 *   · sha256 不对**一个字节都不许落地**；
 *   · bundle 里任何一个包坏了，整棵树都不许留下半成品；
 *   · 包名不符不许装（否则 A 包内容会被当成 B 包）；
 *   · 地址只能由市场索引推导，不能变成任意下载入口。
 *
 * 下载用注入的 `fetcher` 喂现打的 tar.gz，不碰网络。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  satisfiesRange, depUrlOf, installOneFromMirror, installBundleFromMirror, installFromMirror,
} from '../src/mirror-deps.js';

/* ---------------------------- 造 npm 包 ---------------------------- */

/** 512 字节 tar 头 + 内容（补到 512 的倍数）；只造普通文件 */
function tarEntry(name, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([h, padded]);
}

/** npm 包结构：所有文件在 `package/` 下（`extractTarGz(strip:1)` 会剥掉） */
function npmTgz(pkg, files = { 'index.js': 'module.exports = 1;\n' }) {
  const entries = [
    tarEntry('package/package.json', JSON.stringify(pkg)),
    ...Object.entries(files).map(([n, c]) => tarEntry(`package/${n}`, c)),
  ];
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'dsh-mirror-'));

const INDEX_URL = 'https://raw.githubusercontent.com/roost-qq/qq-bot-roost-plugins/main/index.json';

/** 按 URL 分派的假下载器：返回对应的 tgz 字节 */
function fetcherOf(map) {
  return async (url) => {
    for (const [suffix, buf] of Object.entries(map)) {
      if (url.endsWith(suffix)) return buf;
    }
    throw new Error(`未预期的 URL：${url}`);
  };
}

const exists = (p) => fs.access(p).then(() => true, () => false);

/* ---------------------------- 版本判定 ---------------------------- */

test('版本：^X.Y.Z 锁主版本，但不许低于下界', () => {
  assert.equal(satisfiesRange('1.5.4', '^1.5.4'), true);
  assert.equal(satisfiesRange('1.9.0', '^1.5.4'), true, '同主版本、更高次版本要放行');
  assert.equal(satisfiesRange('1.5.3', '^1.5.4'), false, '比下界老的不许装');
  assert.equal(satisfiesRange('2.0.0', '^1.5.4'), false, '跨主版本不许装');
});

test('版本：^0.x.y 连次版本一起锁；精确写法只认同一个版本', () => {
  assert.equal(satisfiesRange('0.2.3', '^0.2.0'), true);
  assert.equal(satisfiesRange('0.3.0', '^0.2.0'), false);
  assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
  assert.equal(satisfiesRange('1.2.4', '1.2.3'), false);
});

test('版本：认不出的写法一律 false（宁可不装）', () => {
  for (const bad of [['1.0.0', '~1.0.0'], ['1.0.0', '>=1.0.0'], ['', ''], ['1.0.0', '*']]) {
    assert.equal(satisfiesRange(...bad), false, `${bad.join(' / ')} 不该判为满足`);
  }
});

/* ---------------------------- 地址推导 ---------------------------- */

test('地址：索引地址 → 包地址（GitHub / Gitee 同一套逻辑）', () => {
  assert.equal(
    depUrlOf(INDEX_URL, 'deps/ws-8.23.0.tgz'),
    'https://raw.githubusercontent.com/roost-qq/qq-bot-roost-plugins/main/deps/ws-8.23.0.tgz',
  );
  assert.equal(
    depUrlOf('https://gitee.com/roost-qq/qq-bot-roost-plugins/raw/main/index.json', 'deps/qrcode/a.tgz'),
    'https://gitee.com/roost-qq/qq-bot-roost-plugins/raw/main/deps/qrcode/a.tgz',
  );
  assert.equal(depUrlOf('not a url', 'deps/a.tgz'), '');
});

test('地址：路径里的 . / .. 段一律不认（不能靠索引跳出仓目录）', () => {
  for (const bad of ['../x.tgz', 'deps/../../x.tgz', './x.tgz', '', '/']) {
    assert.equal(depUrlOf(INDEX_URL, bad), '', `${JSON.stringify(bad)} 不该拼出地址`);
  }
});

/* ---------------------------- 单包 ---------------------------- */

test('单包：校验通过后解到 node_modules/<名字>', async () => {
  const tgz = npmTgz({ name: 'qrcode', version: '1.5.4' });
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'qrcode', version: '1.5.4', path: 'deps/qrcode.tgz', sha256: sha256(tgz),
  }, dest, { fetcher: async () => tgz });
  assert.equal(r.ok, true, r.error);
  assert.equal(await fs.readFile(path.join(dest, 'node_modules/qrcode/index.js'), 'utf8'), 'module.exports = 1;\n');
  await fs.rm(dest, { recursive: true, force: true });
});

test('单包：sha256 不符时一个字节都不落地', async () => {
  const tgz = npmTgz({ name: 'qrcode', version: '1.5.4' });
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'qrcode', version: '1.5.4', path: 'deps/qrcode.tgz', sha256: 'f'.repeat(64),
  }, dest, { fetcher: async () => tgz });
  assert.equal(r.ok, false);
  assert.match(r.error, /sha256/);
  assert.equal(await exists(path.join(dest, 'node_modules')), false);
  await fs.rm(dest, { recursive: true, force: true });
});

test('单包：包名不符拒装', async () => {
  const tgz = npmTgz({ name: 'evil', version: '1.5.4' });
  const dest = await tmpDir();
  const r = await installOneFromMirror(INDEX_URL, {
    name: 'qrcode', version: '1.5.4', path: 'deps/qrcode.tgz', sha256: sha256(tgz),
  }, dest, { fetcher: async () => tgz });
  assert.equal(r.ok, false);
  assert.match(r.error, /包名不符/);
  await fs.rm(dest, { recursive: true, force: true });
});

/* ---------------------------- bundle ---------------------------- */

test('bundle：整棵树平铺进同一个 node_modules', async () => {
  const qr = npmTgz({ name: 'qrcode', version: '1.5.4' });
  const yargs = npmTgz({ name: 'yargs', version: '15.4.1' }, { 'index.js': 'module.exports = "y";\n' });
  const dest = await tmpDir();
  const r = await installBundleFromMirror(INDEX_URL, {
    name: 'qrcode',
    version: '1.5.4',
    packages: [
      { name: 'qrcode', version: '1.5.4', path: 'deps/qrcode/qrcode.tgz', sha256: sha256(qr) },
      { name: 'yargs', version: '15.4.1', path: 'deps/qrcode/yargs.tgz', sha256: sha256(yargs) },
    ],
  }, dest, { fetcher: fetcherOf({ 'qrcode.tgz': qr, 'yargs.tgz': yargs }) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.count, 2);
  assert.equal(await exists(path.join(dest, 'node_modules/qrcode/package.json')), true);
  assert.equal(await fs.readFile(path.join(dest, 'node_modules/yargs/index.js'), 'utf8'), 'module.exports = "y";\n');
  await fs.rm(dest, { recursive: true, force: true });
});

test('bundle：中间某个包坏了，整棵树都不落地', async () => {
  const qr = npmTgz({ name: 'qrcode', version: '1.5.4' });
  const yargs = npmTgz({ name: 'yargs', version: '15.4.1' });
  const dest = await tmpDir();
  const r = await installBundleFromMirror(INDEX_URL, {
    name: 'qrcode',
    version: '1.5.4',
    packages: [
      { name: 'qrcode', version: '1.5.4', path: 'deps/qrcode/qrcode.tgz', sha256: sha256(qr) },
      /** 第二个包的 sha256 是假的：前面那个也不许留下 */
      { name: 'yargs', version: '15.4.1', path: 'deps/qrcode/yargs.tgz', sha256: 'f'.repeat(64) },
    ],
  }, dest, { fetcher: fetcherOf({ 'qrcode.tgz': qr, 'yargs.tgz': yargs }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /yargs/);
  assert.equal(await exists(path.join(dest, 'node_modules')), false, '半成品比「什么都没装」更难查');
  await fs.rm(dest, { recursive: true, force: true });
});

/* ---------------------------- 批量 ---------------------------- */

test('批量：版本不在范围里跳过并说明原因', async () => {
  const tgz = npmTgz({ name: 'qrcode', version: '1.4.0' });
  const dest = await tmpDir();
  const out = await installFromMirror({
    names: ['qrcode'],
    whitelist: { qrcode: { range: '^1.5.4' } },
    dir: dest,
    indexUrl: INDEX_URL,
    entries: [{ name: 'qrcode', version: '1.4.0', path: 'deps/q.tgz', sha256: sha256(tgz) }],
    fetcher: async () => tgz,
  });
  assert.deepEqual(out.installed, []);
  assert.match(out.errors.join(' '), /不满足 \^1\.5\.4/);
  await fs.rm(dest, { recursive: true, force: true });
});

test('批量：镜像里没有的包进 absent，和「装失败」分开', async () => {
  const dest = await tmpDir();
  const out = await installFromMirror({
    names: ['qrcode', '@ffmpeg-installer/ffmpeg'],
    whitelist: { qrcode: { range: '^1.5.4' }, '@ffmpeg-installer/ffmpeg': { range: '^1.1.0' } },
    dir: dest,
    indexUrl: INDEX_URL,
    entries: [],
    fetcher: async () => Buffer.alloc(0),
  });
  assert.deepEqual(out.installed, []);
  assert.deepEqual(out.absent, ['qrcode', '@ffmpeg-installer/ffmpeg']);
  assert.deepEqual(out.errors, [], '「镜像里没有」不是安装失败');
  await fs.rm(dest, { recursive: true, force: true });
});

test('批量：bundle 条目按 kind 记账，面板能说清装了几个', async () => {
  const a = npmTgz({ name: 'qrcode', version: '1.5.4' });
  const b = npmTgz({ name: 'pngjs', version: '5.0.0' }, { 'index.js': 'module.exports = "p";\n' });
  const dest = await tmpDir();
  const out = await installFromMirror({
    names: ['qrcode'],
    whitelist: { qrcode: { range: '^1.5.4' } },
    dir: dest,
    indexUrl: INDEX_URL,
    entries: [{
      name: 'qrcode',
      version: '1.5.4',
      kind: 'bundle',
      packages: [
        { name: 'qrcode', version: '1.5.4', path: 'deps/qrcode/q.tgz', sha256: sha256(a) },
        { name: 'pngjs', version: '5.0.0', path: 'deps/qrcode/p.tgz', sha256: sha256(b) },
      ],
    }],
    fetcher: fetcherOf({ 'q.tgz': a, 'p.tgz': b }),
  });
  assert.deepEqual(out.installed, [{ name: 'qrcode', version: '1.5.4', kind: 'bundle', count: 2 }]);
  await fs.rm(dest, { recursive: true, force: true });
});
