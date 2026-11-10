/**
 * 阶段 6 / 门 G6：市场安装专项
 *
 * 覆盖：目录哈希与插件仓脚本的契约值、tar.gz 解包与路径穿越防护、
 * 索引 URL 白名单、扩展条目识别与撤回判定、安装编排（哈希校验 / foreign /
 * revoked / 权限初始化 / 受管块）、卸载、按哈希判更新、撤回联动 forceDeny。
 *
 * 跑法：node --test test/ext-market.test.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { createExtRegistry, SOURCE_FILE, MANIFEST_FILE } from '../src/ext-registry.js';
import {
  createExtMarket, assertSafeIndexUrl, isExtensionEntry, pickExtensions, isRevoked,
} from '../src/ext-market.js';
import {
  hashDir, untar, extractTarGz, pickSubtree, safeRelPath, writeFiles,
} from '../src/ext-bundle.js';

const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-market-'));
  HOMES.push(d);
  return d;
}

function manifest(id, extra = {}) {
  return {
    api: 1, kind: 'dsh-extension', id, serverName: id,
    name: `扩展${id}`, description: '说明', transport: 'stdio',
    command: 'node', args: ['server.mjs'], ...extra,
  };
}

/** 手写 ustar 头：只够测试用（mode/mtime 固定，checksum 按规范算）。 */
function tarHeader(name, size, { prefix = '', type = '0' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  h.write('0000644\0', 100, 8);
  h.write('0000000\0', 108, 8);
  h.write('0000000\0', 116, 8);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  h.write('00000000000\0', 136, 12);
  h.write('        ', 148, 8);
  h.write(type, 156, 1);
  h.write('ustar\0', 257, 6);
  h.write('00', 263, 2);
  if (prefix) h.write(prefix.slice(0, 155), 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

function makeTar(files) {
  const parts = [];
  for (const [rel, content] of Object.entries(files)) {
    const buf = Buffer.from(content, 'utf8');
    const norm = rel.replace(/\\/g, '/');
    let name = norm;
    let prefix = '';
    if (Buffer.byteLength(norm) > 100) {
      const segs = norm.split('/');
      prefix = segs.slice(0, -1).join('/');
      name = segs.at(-1);
    }
    parts.push(tarHeader(name, buf.length, { prefix }), buf, Buffer.alloc((512 - (buf.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
}

// ---------------------------------------------------------------- ext-bundle

test('G6-1 目录哈希与插件仓 hashdir.mjs 同值（三方契约）', async () => {
  const d = tmpHome();
  writeTree(d, {
    'a.txt': 'hello\n',
    'sub/b.txt': 'world\r\n',
    'node_modules/x.js': 'skip\n',
    '.DS_Store': 'meta\n',
  });
  // 期望值由插件仓 scripts/hashdir.mjs 对同一夹具算出；两份实现漂移即红。
  assert.equal(await hashDir(d), 'ef4635c55daa711eb072ee741c6f86313945e8dd8a300581acbfc8ef95f9b791');
});

test('G6-2 tar.gz 解包：剥顶层、取子树、长路径 prefix 也认', () => {
  const long = `repo-main/plugins/ext/${'d'.repeat(60)}/${'f'.repeat(40)}.json`;
  const gz = gzipSync(makeTar({
    'repo-main/plugins/ext/plugin.json': '{"id":"ext"}',
    'repo-main/plugins/ext/sub/x.txt': 'xxx',
    'repo-main/plugins/other/y.txt': 'yyy',
    [long]: '{}',
  }));
  const files = extractTarGz(gz, { strip: 1 });
  assert.ok(files.has('plugins/ext/plugin.json'));
  assert.ok(files.has(long.replace('repo-main/', '')), 'ustar prefix 长路径要能解出来');
  const sub = pickSubtree(files, 'plugins/ext');
  assert.deepEqual([...sub.keys()].sort(), [`${'d'.repeat(60)}/${'f'.repeat(40)}.json`, 'plugin.json', 'sub/x.txt']);
  assert.equal(sub.get('plugin.json').toString('utf8'), '{"id":"ext"}');
});

test('G6-3 untar 不认符号链接；safeRelPath 挡住穿越与绝对路径', () => {
  const tar = makeTar({ 'repo-main/a.txt': 'a' });
  // 手工塞一个符号链接条目：type '2'。untar 不看链接目标，按 type 直接跳过。
  const link = tarHeader('repo-main/evil', 0, { type: '2' });
  const mixed = Buffer.concat([tar.subarray(0, tar.length - 1024), link, Buffer.alloc(1024)]);
  const files = untar(mixed);
  assert.ok(files.has('repo-main/a.txt'));
  assert.equal(files.has('repo-main/evil'), false, '符号链接一律跳过');

  assert.equal(safeRelPath('a/b.txt'), true);
  assert.equal(safeRelPath('../evil'), false);
  assert.equal(safeRelPath('/etc/passwd'), false);
  assert.equal(safeRelPath('C:\\Windows\\x'), false);
  assert.equal(safeRelPath('a/../../b'), false);
});

test('G6-4 writeFiles 遇非法路径整体拒绝，不写半个目录', async () => {
  const d = tmpHome();
  const dest = join(d, 'out');
  await assert.rejects(
    () => writeFiles(dest, new Map([['ok.txt', Buffer.from('x')], ['../evil.txt', Buffer.from('y')]])),
    /非法路径/,
  );
  assert.equal(fs.existsSync(join(dest, 'ok.txt')), false, '先校验后落盘，不能留半截');
});

test('G6-4b 负 size 不能把 untar 卡死（拖动整个宿主事件循环的那种）', () => {
  const bad = (sizeField) => {
    const h = Buffer.alloc(512);
    // 名字故意用穿越路径：同时验证「不卡死」和「穿越被拒」，断言 0 才有信息量。
    h.write('../evil', 0, 100, 'utf8');
    h.write('0000644\0', 100, 8);
    h.write(sizeField, 124, 12);
    h.write('0', 156, 1);
    h.write('ustar\0', 257, 6);
    return Buffer.concat([h, Buffer.alloc(1024)]);
  };
  // -1000（八进制 = -512）在旧实现里让 off 不前进 → 死循环。这里必须立即返回空表。
  assert.equal(untar(bad('-1000 ')).size, 0);
  assert.equal(untar(bad('-1001 ')).size, 0);
  assert.equal(untar(bad('-2000 ')).size, 0);
  assert.equal(untar(bad('zzzzzzz ')).size, 0, '非法八进制当 0，不能崩');
});

test('G6-4c 市场落盘拒绝「不参与哈希」的目录，否则 sha256 可绕过', async () => {
  const d = tmpHome();
  const dest = join(d, 'out');
  await assert.rejects(
    () => writeFiles(dest, new Map([['node_modules/x.js', Buffer.from('payload')]]), { rejectSkips: true }),
    /不参与哈希/,
  );
  await assert.rejects(
    () => writeFiles(dest, new Map([['__pycache__/m.pyc', Buffer.from('x')]]), { rejectSkips: true }),
    /不参与哈希/,
  );
  // 不带 rejectSkips 时保持原行为（普通落盘用途）
  const n = await writeFiles(dest, new Map([['a.txt', Buffer.from('a')]]));
  assert.equal(n, 1);
});

// ---------------------------------------------------------------- 索引与条目

test('G6-5 索引 URL 白名单：https / 本机回环 http 通过，其余拒', () => {
  assert.match(assertSafeIndexUrl('https://example.com/index.json'), /^https:/);
  assert.match(assertSafeIndexUrl('http://127.0.0.1:8080/index.json'), /^http:\/\/127\.0\.0\.1/);
  assert.match(assertSafeIndexUrl('http://localhost/i.json'), /^http:\/\/localhost/);
  for (const bad of ['http://example.com/i.json', 'file:///etc/passwd', 'ftp://x/y', 'not a url']) {
    assert.throws(() => assertSafeIndexUrl(bad), /https|合法 URL/);
  }
});

test('G6-6 扩展条目识别：kind 优先，过渡期按 transport 特征兼容', () => {
  const idx = {
    plugins: [
      { id: 'a', kind: 'dsh-extension', transport: 'stdio' },
      { id: 'b', transport: 'stdio' },                 // 未升级的过渡期索引
      { id: 'c', version: '1.0.0', runtime: 'python' }, // 普通框架插件
      { id: 'd', version: '1.0.0', transport: 'stdio' }, // 有 version 的插件，不认
    ],
  };
  assert.deepEqual(pickExtensions(idx).map((x) => x.id), ['a', 'b']);
  assert.equal(isExtensionEntry(null), false);
  assert.equal(isExtensionEntry({ id: 'x', kind: 'other' }), false);
});

test('G6-7 撤回认定：顶层 revoked / 条目 true / 版本数组', () => {
  assert.equal(isRevoked({ revoked: ['a'] }, { id: 'a' }), true);
  assert.equal(isRevoked({}, { id: 'a', revoked: true }), true);
  assert.equal(isRevoked({}, { id: 'a', version: '1.0.0', revoked: ['1.0.0'] }), true);
  assert.equal(isRevoked({ revoked: ['b'] }, { id: 'a', version: '1.0.0', revoked: ['2.0.0'] }), false);
});

// ---------------------------------------------------------------- 安装编排

const FILES = { 'plugin.json': '', 'server.mjs': '// server\n' };

function filesFor(id) {
  return { 'plugin.json': `${JSON.stringify(manifest(id), null, 2)}\n`, 'server.mjs': '// server\n' };
}

async function shaFor(id) {
  const d = tmpHome();
  writeTree(d, filesFor(id));
  return hashDir(d);
}

function fakeIndex(rows, extra = {}) {
  return JSON.stringify({ schema: 1, repo: 'o/r', branch: 'main', plugins: rows, ...extra });
}

function rig({ rows, indexExtra = {}, opts = {} } = {}) {
  const dir = tmpHome();
  const registry = createExtRegistry({ dir });
  const groups = [];
  const blocks = [];
  const market = createExtMarket({
    dir, registry,
    fetchText: async () => fakeIndex(rows, indexExtra),
    download: async (entry, dest) => { writeTree(dest, filesFor(entry.id)); return Object.keys(FILES).length; },
    extGroups: { add: (id, o) => groups.push({ id, ...o }), remove: (id) => groups.push({ remove: id }) },
    extPatch: { render: (ids, o) => { blocks.push({ ids, ...o }); return { written: true, ids }; } },
    capStore: opts.capStore ?? null,
    log: { info: () => {}, warn: () => {} },
  });
  return { dir, registry, market, groups, blocks };
}

test('G6-8 一键装：哈希校验 → 原子落位 → .source.json → 权限组 → 受管块', async () => {
  const sha = await shaFor('bili');
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: sha }] });
  const out = await r.market.install('bili');
  assert.equal(out.ok, true, out.message);
  assert.equal(r.registry.read('bili')?.id, 'bili');
  const src = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), SOURCE_FILE), 'utf8'));
  assert.equal(src.sha256, sha, '来源标记要记索引哈希，供更新检测');
  assert.equal(src.repo, 'o/r');
  assert.equal(src.path, 'plugins/bili');
  assert.deepEqual(r.groups, [{ id: 'bili', label: 'B站', capStore: null }], '安装即初始化权限');
  assert.deepEqual(r.blocks, [{ ids: ['bili'], apply: true }], '受管块按已装 id 整块重算');
  assert.equal(fs.existsSync(join(r.dir, '.market-tmp', 'bili')), false, '暂存目录要清掉');
});

test('G6-8b 索引条目缺 sha256：拒绝安装，不能「索引说什么就装什么」', async () => {
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili' }] });
  const out = await r.market.install('bili');
  assert.equal(out.ok, false);
  assert.match(out.message, /缺 sha256/);
  assert.equal(r.registry.read('bili'), null);
});

test('G6-9 哈希不匹配：拒绝落位，扩展目录不存在', async () => {
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: 'f'.repeat(64) }] });
  const out = await r.market.install('bili');
  assert.equal(out.ok, false);
  assert.match(out.message, /目录哈希与索引不一致/);
  assert.equal(r.registry.read('bili'), null);
  assert.equal(fs.existsSync(r.registry.pathOf('bili')), false);
});

test('G6-10 撤回条目拒装；foreign 目录一律拒，市场没有 force 后门', async () => {
  const sha = await shaFor('bili');
  const revoked = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }], indexExtra: { revoked: ['bili'] } });
  assert.equal((await revoked.market.install('bili')).reason, 'revoked');

  const foreign = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  // 造一个用户手写目录（无 .source.json）
  fs.mkdirSync(foreign.registry.pathOf('bili'), { recursive: true });
  const own = `${JSON.stringify(manifest('bili'))}\n`;
  fs.writeFileSync(join(foreign.registry.pathOf('bili'), MANIFEST_FILE), own, 'utf8');
  assert.equal(foreign.registry.isForeign('bili'), true);
  const out = await foreign.market.install('bili');
  assert.equal(out.reason, 'foreign');
  assert.match(out.message, /手动删掉/);
  assert.equal(fs.readFileSync(join(foreign.registry.pathOf('bili'), MANIFEST_FILE), 'utf8'), own,
    '用户手写清单一字节都不能被市场改');
});

test('G6-11 bad_id / not_found 明确失败，不去拉索引也能先挡 id', async () => {
  const r = rig({ rows: [] });
  assert.equal((await r.market.install('../evil')).reason, 'bad_id');
  assert.equal((await r.market.install('nope')).reason, 'not_found');
});

test('G6-12 卸载：删目录 + 清权限组 + 受管块重算不留悬空条目', async () => {
  const sha = await shaFor('bili');
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  await r.market.install('bili');
  r.blocks.length = 0;
  const out = r.market.remove('bili');
  assert.equal(out.ok, true);
  assert.equal(r.registry.read('bili'), null);
  assert.equal(fs.existsSync(r.registry.pathOf('bili')), false);
  assert.ok(r.groups.some((g) => g.remove === 'bili'));
  assert.deepEqual(r.blocks, [{ ids: [], apply: true }], '卸载后受管块应为空');
});

test('G6-13 更新按目录哈希判，不看 version', async () => {
  const sha = await shaFor('bili');
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  await r.market.install('bili');
  const same = await r.market.detectUpdates();
  assert.deepEqual(same.rows, [], '哈希一致 = 无更新');
  // 装一版，然后手工把来源哈希改成旧值，模拟「本地是旧版、索引已换新哈希」
  const r2 = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  await r2.market.install('bili');
  const srcPath = join(r2.registry.pathOf('bili'), SOURCE_FILE);
  fs.writeFileSync(srcPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(srcPath, 'utf8')), sha256: 'a'.repeat(64) }), 'utf8');
  const up = await r2.market.detectUpdates();
  assert.equal(up.rows.length, 1);
  assert.equal(up.rows[0].id, 'bili');
  assert.equal(up.rows[0].sha256, sha, '更新判定比的是索引当前哈希');
});

test('G6-14 撤回联动：能力页启用时写 forceDeny 通配；未启用时不创建配置文件', async () => {
  const patches = [];
  const capStore = {
    enabled: () => true,
    get: () => ({ forceDeny: ['mcp__old__*'] }),
    patch: (o) => { patches.push(o); return { ...o }; },
  };
  const r = rig({ rows: [], opts: { capStore } });
  const out = r.market.revoke('bili');
  assert.equal(out.ok, true);
  assert.deepEqual(patches[0].forceDeny, ['mcp__old__*', 'mcp__bili__*']);
  assert.match(out.message, /跨档硬否决/);

  const disabled = rig({ rows: [], opts: { capStore: { enabled: () => false } } });
  const no = disabled.market.revoke('bili');
  assert.equal(no.ok, false);
  assert.equal(no.reason, 'capabilities_disabled');
});

test('G6-15 市场列表：装没装、有没有更新、是否撤回，一行说完', async () => {
  const sha = await shaFor('bili');
  const r = rig({
    rows: [
      { id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: sha },
      { id: 'douyu', kind: 'dsh-extension', name: '斗鱼', path: 'plugins/douyu', sha256: 'd'.repeat(64), revoked: true },
      { id: 'skip', version: '1.0.0', runtime: 'python' },
    ],
  });
  await r.market.install('bili');
  const list = await r.market.list({ refresh: true });
  assert.equal(list.rows.length, 2, '普通框架插件不能出现在扩展市场里');
  const bili = list.rows.find((x) => x.id === 'bili');
  assert.equal(bili.installed, true);
  assert.equal(bili.updateAvailable, false);
  assert.equal(bili.revoked, false);
  const douyu = list.rows.find((x) => x.id === 'douyu');
  assert.equal(douyu.installed, false);
  assert.equal(douyu.revoked, true);
  assert.match(douyu.label, /已撤回/);
  assert.equal(list.repo, 'o/r');
});

test('G6-16 验签钩子：注入后验不过即拒装；默认不注入 = 不验（6.3 才开）', async () => {
  const sha = await shaFor('bili');
  const dir = tmpHome();
  const registry = createExtRegistry({ dir });
  const rows = [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }];
  let calls = 0;
  const market = createExtMarket({
    dir, registry,
    fetchText: async () => fakeIndex(rows),
    download: async (entry, dest) => { writeTree(dest, filesFor(entry.id)); },
    verifyIndex: async ({ text }) => { calls++; return { ok: false, why: '签名与内容不匹配' }; },
    log: { info: () => {}, warn: () => {} },
  });
  const out = await market.install('bili');
  assert.equal(out.ok, false);
  assert.match(out.message, /索引验签未通过/);
  assert.equal(calls, 1);
  assert.equal(registry.read('bili'), null);
});
