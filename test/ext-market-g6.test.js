/**
 * 门 G6：一键装 → 受管块生效 → 五档可用 → 卸载不误删 → 撤回自动 deny
 * ==================================================================
 *
 * 与 `ext-market.test.js` 的分工：那份用假 extGroups / extPatch 验**编排逻辑**；
 * 这份用**真实模块**（registry / extGroups / extPatch / capStore / extPanel）
 * 验门 G6 的端到端结果，唯一被替换的是「下载」与「索引拉取」（不联网）。
 *
 * 跑法：node --test test/ext-market-g6.test.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtRegistry, createClientStore, SOURCE_FILE, MANIFEST_FILE } from '../src/ext-registry.js';
import { createExtGroups } from '../src/ext-groups.js';
import { createExtPatch, BLOCK_BEGIN, BLOCK_END } from '../src/ext-patch.js';
import { createCapabilityStore } from '../src/capability-store.js';
import { createExtMarket } from '../src/ext-market.js';
import { createExtPanel } from '../src/ext-panel.js';
import { defaultStore, resolvePolicy } from '../src/capabilities.js';
import { GUEST_KEEP_TOOLS } from '../src/permissions.js';
import { hashDir } from '../src/ext-bundle.js';

const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-g6-'));
  HOMES.push(d);
  return d;
}

function manifest(id, extra = {}) {
  return {
    api: 1, kind: 'dsh-extension', id, serverName: id,
    name: `扩展${id}`, description: `${id} 的说明`, transport: 'stdio',
    command: 'node', args: ['server.mjs'], ...extra,
  };
}
function filesFor(id) {
  return { 'plugin.json': `${JSON.stringify(manifest(id), null, 2)}\n`, 'server.mjs': '// server\n' };
}
function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
}
async function shaFor(id) {
  const d = tmpHome();
  writeTree(d, filesFor(id));
  return hashDir(d);
}

/** 全套真实模块。profileDir 里给一个空的 cordis.patch.yml。 */
async function rig(rows, indexExtra = {}) {
  const dir = tmpHome();
  const profileDir = join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');

  const registry = createExtRegistry({ dir });
  const extGroups = createExtGroups({ dir });
  const extPatch = createExtPatch({ dir, profileDir, apiUrl: 'http://127.0.0.1:17321/v1' });
  const capStore = createCapabilityStore({ dir });
  const market = createExtMarket({
    dir, registry, extGroups, extPatch, capStore,
    fetchText: async () => JSON.stringify({ schema: 1, repo: 'o/r', branch: 'main', plugins: rows, ...indexExtra }),
    download: async (entry, dest) => writeTree(dest, filesFor(entry.id)),
    log: { info: () => {}, warn: () => {} },
  });
  return { dir, profileDir, registry, extGroups, extPatch, capStore, market };
}

const readYml = (r) => fs.readFileSync(join(r.profileDir, 'cordis.patch.yml'), 'utf8');
// 阶段 1 把 `ext-groups.json` 放在 `extensions/` 下（与扩展目录平级），
// 不在数据根 —— 这样 E4 备份整目录走一遍就带上了。
const readGroups = (r) => JSON.parse(fs.readFileSync(join(r.dir, 'extensions', 'ext-groups.json'), 'utf8'));

test('G6-A 一键装：受管块真写进 cordis.patch.yml，且零明文零表达式', async () => {
  const sha = await shaFor('bili');
  const r = await rig([{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: sha }]);
  const out = await r.market.install('bili');
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(out.warnings, [], '真实模块下两个后置步骤都该成功');

  const yml = readYml(r);
  assert.ok(yml.includes(BLOCK_BEGIN) && yml.includes(BLOCK_END), '受管块标记要在');
  assert.match(yml, /id: mcp-bili/);
  assert.match(yml, /src\/ext-launcher\.mjs/);
  assert.match(yml, /ROOST_API_URL: 'http:\/\/127\.0\.0\.1:17321\/v1'/);
  assert.match(yml, /ROOST_EXT_ID: 'bili'/);
  assert.ok(!yml.includes('!!js'), '受管块不能有任何 YAML 表达式');
  assert.ok(!yml.includes('${'), '受管块不能有任何模板引用');
  assert.ok(!/token/i.test(yml), '受管块不能出现令牌字样');
});

test('G6-B 权限两条路径：未启用能力页只写 ext-groups.json，不创建 capabilities.json', async () => {
  const sha = await shaFor('bili');
  const r = await rig([{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: sha }]);
  await r.market.install('bili');
  assert.equal(fs.existsSync(join(r.dir, 'capabilities.json')), false, '§4.2：不存在就不创建');
  const g = readGroups(r);
  assert.deepEqual(g.groups.ext_bili.match, ['mcp__bili__*']);
  assert.ok(g.memberAllow.includes('group:ext_bili'));
  assert.ok(g.adminAllow.includes('ext_memory_note'));
});

test('G6-C 启用后五档可用：group:ext_bili 真存在，member 能调扩展工具', async () => {
  const sha = await shaFor('bili');
  const r = await rig([{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: sha }]);
  await r.market.install('bili');

  // 复刻 host.js 的 capabilities.init handler（阶段 1 的主落点）
  const parts = r.extGroups.seedParts();
  const seed = { defaults: {} };
  for (const b of ['owner', 'admin', 'member', 'unknown']) seed.defaults[b] = { allow: [...GUEST_KEEP_TOOLS] };
  seed.groups = { ...defaultStore().groups, ...parts.groups };
  for (const ref of parts.memberAllow) if (!seed.defaults.member.allow.includes(ref)) seed.defaults.member.allow.push(ref);
  for (const t of parts.adminAllow) if (!seed.defaults.admin.allow.includes(t)) seed.defaults.admin.allow.push(t);
  r.capStore.init(seed);

  const store = r.capStore.get();
  assert.ok(store.groups.ext_bili, 'group:ext_bili 必须真的存在');
  const pool = ['mcp__bili__feed', 'mcp__bili__search', 'qq_send', 'memory_search'];
  const member = resolvePolicy({ pool, bucket: 'member', store });
  assert.ok(member.allow.includes('mcp__bili__feed'), '群成员装完就能调');
  assert.ok(member.allow.includes('mcp__bili__search'));
  const unknown = resolvePolicy({ pool, bucket: 'unknown', store });
  assert.ok(!unknown.allow.includes('mcp__bili__feed'), 'unknown 档不给扩展工具');
});

test('G6-D 卸载不误删：另一个扩展的目录 / 权限组 / 受管块条目都还在', async () => {
  const shaB = await shaFor('bili');
  const shaD = await shaFor('douyu');
  const r = await rig([
    { id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: shaB },
    { id: 'douyu', kind: 'dsh-extension', name: '斗鱼', path: 'plugins/douyu', sha256: shaD },
  ]);
  assert.equal((await r.market.install('bili')).ok, true);
  assert.equal((await r.market.install('douyu')).ok, true);
  assert.match(readYml(r), /id: mcp-douyu/);

  const out = r.market.remove('bili');
  assert.equal(out.ok, true, out.message);
  assert.equal(r.registry.read('bili'), null);
  assert.ok(r.registry.read('douyu'), '另一个扩展不能被连坐删掉');
  const g = readGroups(r);
  assert.equal(g.groups.ext_bili, undefined);
  assert.ok(g.groups.ext_douyu, '另一个扩展的权限组要留着');
  assert.ok(!g.memberAllow.includes('group:ext_bili'));
  assert.ok(g.memberAllow.includes('group:ext_douyu'));
  const yml = readYml(r);
  assert.ok(!yml.includes('mcp-bili'), '受管块要按当前 id 重算，不留悬空条目');
  assert.match(yml, /id: mcp-douyu/);
});

test('G6-E 撤回自动 deny：通配 forceDeny 挡住该扩展，不误伤另一个', async () => {
  const shaB = await shaFor('bili');
  const shaD = await shaFor('douyu');
  const r = await rig([
    { id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: shaB },
    { id: 'douyu', kind: 'dsh-extension', name: '斗鱼', path: 'plugins/douyu', sha256: shaD },
  ]);
  await r.market.install('bili');
  await r.market.install('douyu');
  const parts = r.extGroups.seedParts();
  const seed = { defaults: {}, groups: { ...defaultStore().groups, ...parts.groups } };
  for (const b of ['owner', 'admin', 'member', 'unknown']) seed.defaults[b] = { allow: [...GUEST_KEEP_TOOLS] };
  for (const ref of parts.memberAllow) seed.defaults.member.allow.push(ref);
  r.capStore.init(seed);

  const out = r.market.revoke('bili', { reason: '测试撤回' });
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(out.forceDeny, ['mcp__bili__*']);

  const store = r.capStore.get();
  const pool = ['mcp__bili__feed', 'mcp__douyu__feed', 'qq_send'];
  const owner = resolvePolicy({ pool, bucket: 'owner', store, forceDeny: store.forceDeny });
  assert.ok(!owner.allow.includes('mcp__bili__feed'), '撤回后连主人也不能调');
  assert.ok(owner.allow.includes('mcp__douyu__feed'), '不能误伤另一个扩展');
});

test('G6-F 真实市场装的扩展：编辑 usage 使清单 sha256 失效并标注', async () => {
  const sha = await shaFor('bili');
  const r = await rig([{ id: 'bili', kind: 'dsh-extension', name: 'B站', path: 'plugins/bili', sha256: sha }]);
  await r.market.install('bili');
  const src = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), SOURCE_FILE), 'utf8'));
  assert.equal(src.sha256, sha, '市场安装必须记来源哈希');

  const clientStore = createClientStore({ dir: r.dir });
  const panel = createExtPanel({ dir: r.dir, registry: r.registry, clientStore, capStore: r.capStore, cfg: {} });
  const saved = panel.saveUsage('bili', '市场装的也能改说明');
  assert.equal(saved.invalidated, true);
  assert.match(saved.label, /已本地修改/);
  const disk = JSON.parse(fs.readFileSync(join(r.registry.pathOf('bili'), MANIFEST_FILE), 'utf8'));
  assert.equal(disk.sha256, null);
  assert.equal(disk.locallyModified, true);
  assert.equal(r.registry.read('bili')?.usage, '市场装的也能改说明', 'sha256 置空不能让清单读不出来');
  assert.equal(panel.usageRows().rows.find((x) => x.id === 'bili').sha256Valid, false);
});

test('G6-H 受管块只写市场装的：用户手写目录不进块', async () => {
  const sha = await shaFor('bili');
  const r = await rig([{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }]);
  fs.mkdirSync(r.registry.pathOf('handmade'), { recursive: true });
  fs.writeFileSync(join(r.registry.pathOf('handmade'), MANIFEST_FILE), `${JSON.stringify(manifest('handmade'))}\n`, 'utf8');
  assert.equal(r.registry.isForeign('handmade'), true);

  await r.market.install('bili');
  const yml = readYml(r);
  assert.match(yml, /id: mcp-bili/);
  assert.ok(!yml.includes('mcp-handmade'),
    '手写目录没有 secrets，写进受管块只会让 DSH 拉起一个必然 401 的进程；需要代管由用户自己加');
});

test('G6-I streamable-http 扩展不进受管块（没有可接管的子进程）', async () => {
  const shaS = await shaFor('bili');
  // http 形态的夹具：transport + url，其余同 stdio
  const httpFiles = {
    'plugin.json': `${JSON.stringify({
      ...manifest('hello-http'), transport: 'streamable-http', url: 'http://127.0.0.1:17999/mcp', command: undefined, args: undefined,
    }, null, 2)}\n`,
    'server.mjs': '// http\n',
  };
  const httpShaDir = tmpHome();
  writeTree(httpShaDir, httpFiles);
  const shaH = await hashDir(httpShaDir);

  const dir = tmpHome();
  const profileDir = join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  const registry = createExtRegistry({ dir });
  const extGroups = createExtGroups({ dir });
  const extPatch = createExtPatch({ dir, profileDir, apiUrl: 'http://127.0.0.1:17321/v1' });
  const market = createExtMarket({
    dir, registry, extGroups, extPatch,
    fetchText: async () => JSON.stringify({
      repo: 'o/r',
      plugins: [
        { id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: shaS, transport: 'stdio' },
        { id: 'hello-http', kind: 'dsh-extension', path: 'plugins/hello-http', sha256: shaH, transport: 'streamable-http' },
      ],
    }),
    download: async (entry, dest) => writeTree(dest, entry.id === 'hello-http' ? httpFiles : filesFor(entry.id)),
    log: { info: () => {}, warn: () => {} },
  });
  assert.equal((await market.install('bili')).ok, true);
  assert.equal((await market.install('hello-http')).ok, true);

  const yml = fs.readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.match(yml, /id: mcp-bili/, 'stdio 扩展要进受管块');
  assert.ok(!yml.includes('mcp-hello-http'),
    'http 形态写进受管块会让 launcher 直接 exit 1（transport 不是 stdio），必须只给配置片段');
  // 但扩展本身要装好，面板能看到
  assert.ok(registry.read('hello-http'));
});

test('G6-G revoked 条目拒装，且不留下暂存目录', async () => {
  const sha = await shaFor('bili');
  const r = await rig([{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }], { revoked: ['bili'] });
  const out = await r.market.install('bili');
  assert.equal(out.reason, 'revoked');
  assert.equal(fs.existsSync(r.registry.pathOf('bili')), false);
  assert.equal(fs.existsSync(join(r.dir, '.market-tmp', 'bili')), false);
  assert.equal(readYml(r).includes(BLOCK_BEGIN), false, '拒装不能留下受管块条目');
});
