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
  indexUrlFor, assertSafeTarballUrl, MARKET_SOURCES, DEFAULT_EXT_REPO, DEFAULT_EXT_INDEX_URL,
} from '../src/ext-market.js';
import { FW_REPO, EXT_REPO, PERSONA_REPO, GITEE_PERSONA_REPO, giteeRepoOf } from '../src/repo.js';
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
    assert.throws(() => assertSafeIndexUrl(bad), /https|http\(s\)|合法 URL/);
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
    /** 想控节奏（测 busy）或换实现时由 `opts.download` 覆盖 */
    download: opts.download
      ?? (async (entry, dest) => { writeTree(dest, filesFor(entry.id)); return Object.keys(FILES).length; }),
    extGroups: { add: (id, o) => groups.push({ id, ...o }), remove: (id) => groups.push({ remove: id }) },
    extPatch: { render: (ids, o) => { blocks.push({ ids, ...o }); return { written: true, ids }; } },
    capStore: opts.capStore ?? null,
    /** 配置 getter（数据源 / 备份保留天数），默认「没配」 */
    marketCfg: opts.marketCfg ?? (() => ({})),
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
  /**
   * 默认仍然拒（不给「随手一点就覆盖用户文件」的后门）。
   * 2026-11-16 起放行条件是**显式 takeOver + 先整目录备份**，
   * 所以文案从「请先手动删掉该目录」改成指路 takeOver。
   */
  assert.match(out.message, /takeOver|备份/);
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

/* ---------------- 数据源（github / gitee / custom） ---------------- */

/**
 * 用户反馈：「市场还不能自选数据来源 github、gitee 或者自选吗」。
 *
 * 背景：`raw.githubusercontent.com` 与 `codeload.github.com` 在国内经常被重置，
 * 面板报「连接被重置」；而 Gitee 是同一份仓库的镜像——索引字节数实测完全一致
 * （14981），归档结构也一样是「单层顶层目录」，所以换源只换两个 URL。
 */
test('数据源：三种预设解析出的索引地址', () => {
  assert.equal(FW_REPO, 'roost-qq/qq-bot-roost');
  assert.equal(EXT_REPO, 'roost-qq/qq-bot-roost-plugins');
  assert.equal(PERSONA_REPO, 'roost-qq/dsh-roost-personas');
  assert.equal(giteeRepoOf(EXT_REPO), 'tdcq9594/qq-bot-roost-plugins');
  assert.equal(giteeRepoOf('a/b'), 'a/b');
  assert.equal(GITEE_PERSONA_REPO, 'tdcq9594/dsh-roost-personas');
  assert.deepEqual(MARKET_SOURCES, ['github', 'gitee', 'custom']);
  assert.equal(
    indexUrlFor({ source: 'github', repo: DEFAULT_EXT_REPO }),
    DEFAULT_EXT_INDEX_URL,
  );
  assert.equal(
    indexUrlFor({ source: 'gitee', repo: DEFAULT_EXT_REPO }),
    'https://gitee.com/tdcq9594/qq-bot-roost-plugins/raw/main/index.json',
  );
  assert.equal(
    indexUrlFor({ source: 'custom', indexUrl: 'https://mirror.example/ext/index.json' }),
    'https://mirror.example/ext/index.json',
  );
  /** 认不出的值退回官方源，不能让一个错字变成「索引地址为空」 */
  assert.equal(indexUrlFor({ source: 'gihub', repo: DEFAULT_EXT_REPO }), DEFAULT_EXT_INDEX_URL);
});

test('数据源：Gitee 的整仓归档在分发包白名单里', () => {
  /** 换源要能真的装下来：分发包主机白名单得认 gitee.com，否则列表能拉、安装被拒 */
  assert.equal(
    assertSafeTarballUrl('https://gitee.com/tdcq9594/qq-bot-roost-plugins/repository/archive/main.tar.gz'),
    'https://gitee.com/tdcq9594/qq-bot-roost-plugins/repository/archive/main.tar.gz',
  );
  /** 别的域名照样拒，换源不是放开白名单 */
  assert.throws(() => assertSafeTarballUrl('https://evil.example/x.tar.gz'), /白名单/);
});

test('数据源：sourceInfo 现读配置，换源不用重启', async (t) => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-market-src-'));
  HOMES.push(d);
  const registry = createExtRegistry({ dir: d });
  let src = 'github';
  let custom = '';
  const m = createExtMarket({
    dir: d, registry,
    fetchText: async () => JSON.stringify({ schema: 1, repo: DEFAULT_EXT_REPO, branch: 'main', plugins: [] }),
    marketCfg: () => ({ source: src, indexUrl: custom }),
  });

  assert.equal(m.sourceInfo().source, 'github');
  assert.match(m.sourceInfo().indexUrl, /raw\.githubusercontent\.com/);

  src = 'gitee';
  assert.equal(m.sourceInfo().source, 'gitee');
  assert.match(m.sourceInfo().indexUrl, /gitee\.com\/.*\/raw\/main\/index\.json/);

  src = 'custom';
  custom = 'https://mirror.example/index.json';
  assert.equal(m.sourceInfo().indexUrl, 'https://mirror.example/index.json');
  assert.equal(m.sourceInfo().customUrl, 'https://mirror.example/index.json');
});

test('数据源：市场和 sourceInfo 同源，换源后读 indexUrl 拿到的是**新**地址', () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-market-src-'));
  HOMES.push(d);
  const registry = createExtRegistry({ dir: d });
  let src = 'github';
  const m = createExtMarket({
    dir: d, registry,
    fetchText: async () => JSON.stringify({ schema: 1, repo: DEFAULT_EXT_REPO, branch: 'main', plugins: [] }),
    marketCfg: () => ({ source: src, indexUrl: '' }),
  });
  /**
   * 这个字段早期是创建时算一次的快照：面板换完源再读它，拿到的还是旧地址。
   * 现在必须和 `sourceInfo()` 同源（getter），否则「换源不用重启」这条承诺
   * 只在面板那一处成立，别处读到的是陈旧值。
   */
  assert.match(m.indexUrl, /raw\.githubusercontent\.com/);
  src = 'gitee';
  assert.match(m.indexUrl, /gitee\.com/);
  assert.equal(m.indexUrl, m.sourceInfo().indexUrl);
});

test('数据源：配置 getter 抛错时退回官方源，不能把面板打崩', () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-market-src-'));
  HOMES.push(d);
  const registry = createExtRegistry({ dir: d });
  const m = createExtMarket({
    dir: d, registry,
    fetchText: async () => JSON.stringify({ schema: 1, repo: DEFAULT_EXT_REPO, branch: 'main', plugins: [] }),
    /** 宿主注入的 getter 读的是还没初始化完的 cfg 闭包，抛错是有可能的 */
    marketCfg: () => { throw new Error('cfg 还没就绪'); },
  });
  const info = m.sourceInfo();
  assert.equal(info.source, 'github', '读不到就按官方源，不能把扩展页打成 500');
  assert.match(info.indexUrl, /raw\.githubusercontent\.com/);
  assert.equal(info.customUrl, '');
});

/**
 * 内网 http 镜像要能放行，但**必须显式打开**开关。
 *
 * 自建镜像多半是 `http://192.168.x.x/index.json`；一路强求 https 等于把这个
 * 用法堵死。放开之后运行期仍由 `ssrf.js` 逐 IP 校验（`marketGuardOpts` 已经
 * 把 allowPrivate 传下去了），所以这里只是静态白名单这一层松口。
 */
test('数据源：内网 http 镜像默认拒，打开 allowPrivate 才放行', () => {
  const lan = 'http://192.168.1.9/ext/index.json';
  assert.throws(() => assertSafeIndexUrl(lan), /https|允许访问内网/);
  assert.equal(assertSafeIndexUrl(lan, { allowPrivate: true }), lan);

  /** 本机回环不用开开关（自建 / 测试常用） */
  assert.equal(assertSafeIndexUrl('http://127.0.0.1:8080/i.json'), 'http://127.0.0.1:8080/i.json');

  /** `file://` 就算开了 allowPrivate 也不许——本地文件不能变成「远程索引」 */
  assert.throws(() => assertSafeIndexUrl('file:///etc/passwd', { allowPrivate: true }), /http/);
});

/**
 * 用户手写目录：**能替换、能卸载，但都必须先整目录备份**。
 *
 * 起因是用户截图：`imagegen` 是整目录拷进来的（没有 `.source.json`），被判成
 * 「用户手写」→ 卸载按钮没有、装官方版的按钮也是禁用 + 「不覆盖」，卡死。
 * 判据只看来源标记、不看内容，而**运行时数据**（`gallery.json`）又让「内容
 * 一致」永远不成立，所以不能靠哈希判等，只能给显式动作 + 备份兜底。
 */
test('foreign：takeOver 才允许替换，且替换前整目录备份到 data/backups/', async () => {
  const sha = await shaFor('bili');
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  const dir = r.registry.pathOf('bili');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest('bili'))}\n`, 'utf8');
  /** 运行时数据：备份必须把它一起带走 */
  fs.writeFileSync(join(dir, 'gallery.json'), '{"items":[1]}', 'utf8');

  const out = await r.market.install('bili', { takeOver: true });
  assert.equal(out.ok, true, out.message);

  const bk = fs.readdirSync(join(r.dir, 'backups')).filter((n) => n.startsWith('ext-bili-'));
  assert.equal(bk.length, 1, '要留一份备份');
  assert.equal(
    fs.readFileSync(join(r.dir, 'backups', bk[0], 'gallery.json'), 'utf8'),
    '{"items":[1]}',
    '运行时数据要一起备份（删了就没了）',
  );
  /** 替换后是受管扩展：有了 .source.json，不再是 foreign */
  assert.equal(r.registry.isForeign('bili'), false);
});

test('foreign：不带 force 拒绝卸载，带 force 才删且先备份', async () => {
  const sha = await shaFor('bili');
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  const dir = r.registry.pathOf('bili');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest('bili'))}\n`, 'utf8');

  const denied = r.market.remove('bili');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'foreign');
  assert.equal(fs.existsSync(dir), true, '没确认就不许删');

  const ok = r.market.remove('bili', { force: true });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.readdirSync(join(r.dir, 'backups')).some((n) => n.startsWith('ext-bili-')), '删前要备份');
});

/**
 * 备份保留 7 天。
 *
 * 手写目录常常带 `node_modules`，一次备份几十上百 MB；无限堆几个月能把盘吃干净。
 * 但 `backups/` 就在 `data/` 下面，用户很可能也往里放东西——所以**只清我们
 * 自己写的 `ext-<id>-YYYYMMDD-HHMMSS` 格式**，别的目录一律不碰。
 * 时间从**目录名**解析而不是 mtime：拷贝过 / 搬过的目录 mtime 会变。
 */
test('备份：默认保留 7 天，过期的自动清、非本格式的目录不碰', async () => {
  const sha = await shaFor('bili');
  const r = rig({ rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }] });
  const dir = r.registry.pathOf('bili');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest('bili'))}\n`, 'utf8');

  const bk = join(r.dir, 'backups');
  fs.mkdirSync(join(bk, 'ext-bili-20200101-000000'), { recursive: true });  // 早就过期
  fs.mkdirSync(join(bk, 'user-notes'), { recursive: true });                // 用户自己的，不是我们的格式
  fs.writeFileSync(join(bk, 'user-notes', 'a.txt'), 'keep me', 'utf8');

  const out = await r.market.install('bili', { takeOver: true });
  assert.equal(out.ok, true, out.message);

  const names = fs.readdirSync(bk);
  assert.equal(names.includes('ext-bili-20200101-000000'), false, '过期备份要清掉');
  assert.equal(names.includes('user-notes'), true, '不是我们造的目录绝不能动');
  assert.equal(fs.readFileSync(join(bk, 'user-notes', 'a.txt'), 'utf8'), 'keep me');
  assert.equal(names.filter((n) => /^ext-bili-\d{8}-\d{6}$/.test(n)).length, 1, '这次的新备份要在');
});

test('备份：backupKeepDays=0 表示永久保留（显式要留证据的人）', async () => {
  const sha = await shaFor('bili');
  const r = rig({
    rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }],
    opts: { marketCfg: () => ({ backupKeepDays: 0 }) },
  });
  const dir = r.registry.pathOf('bili');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest('bili'))}\n`, 'utf8');
  const bk = join(r.dir, 'backups');
  fs.mkdirSync(join(bk, 'ext-bili-20200101-000000'), { recursive: true });

  const out = await r.market.install('bili', { takeOver: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(fs.readdirSync(bk).includes('ext-bili-20200101-000000'), true, '0 = 不清');
});

/**
 * `busy()`：换源、改 SSRF 白名单这类**全局**操作要靠它避让。
 * 安装流程会分好几次读当前源（拉索引 / 拼 tarball / 报进度），中途换源就成了
 * 「索引来自 A 源、包从 B 源下」。哈希能兜住坏包，但报错会指错方向。
 */
test('busy：安装进行中为真，这一轮跑完为假', async () => {
  const sha = await shaFor('bili');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = rig({
    rows: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }],
    opts: {
      download: async (entry, dest) => {
        await gate;                                    // 挂在这里，模拟「正在下载」
        writeTree(dest, filesFor(entry.id));
        return Object.keys(FILES).length;
      },
    },
  });

  assert.equal(r.market.busy(), false, '闲的时候不能误报，否则面板永远换不了源');
  const p = r.market.install('bili');
  /** `running.add()` 在第一个 await 之前同步执行，所以这一刻已经在装 */
  assert.equal(r.market.busy(), true);

  release();
  const out = await p;
  assert.equal(out.ok, true, out.message);
  assert.equal(r.market.busy(), false, '跑完要放行');
});
