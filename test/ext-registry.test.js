/**
 * 扩展清单与原子落位（实施阶段 1.1 / 验收 8a）。
 *
 * 盯的是会静默出错的四件：
 *  1. `serverName !== id` → 工具名 / section 名 / 组名三套推导错位；
 *  2. 含短横线的 id 拼进 REF 会被官方 `credentialRef()` 拒绝；
 *  3. 点开头的暂存目录被扫描器当成已装扩展；
 *  4. 市场安装覆盖用户手写目录（foreign 保护），或落位失败没回滚。
 *
 * 跑法：node --test test/ext-registry.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  EXT_ID_RE,
  EXT_KIND,
  credentialRef,
  validateManifest,
  createExtRegistry,
  extensionsDir,
  secretsDir,
} from '../src/ext-registry.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-registry-'));
  // 照 test/mood.test.js 的写法：Windows 上 rmSync 偶发 ENOTEMPTY，
  // 那是文件句柄没释放，与被测代码无关，不能把通过的用例判红。
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function manifest(id = 'bili', over = {}) {
  return {
    api: 1,
    kind: EXT_KIND,
    id,
    name: '刷 B 站',
    description: '读取 B 站动态与视频信息',
    version: '1.0.0',
    transport: 'stdio',
    command: 'node',
    args: ['./server.mjs'],
    serverName: id,
    ...over,
  };
}

/** 造一个「发布结构」的源目录：目录名 = id，内含 plugin.json。 */
function staged(t, id, over = {}) {
  const home = tmpHome(t);
  const src = join(home, id);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(join(src, 'plugin.json'), JSON.stringify(manifest(id, over), null, 2));
  fs.writeFileSync(join(src, 'server.mjs'), '// fake server\n');
  return { home, src };
}

test('id 正则：小写开头、2–32 字符、不许大写/下划线/斜杠', () => {
  for (const good of ['ab', 'bili', 'bili-helper', 'a1234567890123456789012345678901']) {
    assert.equal(EXT_ID_RE.test(good), true, good);
  }
  for (const bad of ['a', 'A', 'bili_helper', 'bili/../x', '-bili', 'bili.Helper', '', 'a'.repeat(33)]) {
    assert.equal(EXT_ID_RE.test(bad), false, bad);
  }
});

test('REF 规范化：短横线转下划线，符合官方 REF_PATTERN', () => {
  assert.equal(credentialRef('bili'), 'ROOST_EXT_BILI_TOKEN');
  assert.equal(credentialRef('bili-helper'), 'ROOST_EXT_BILI_HELPER_TOKEN');
  assert.equal(credentialRef('bili-helper'), credentialRef('bili_helper'.replace('_', '-')));
  assert.notEqual(credentialRef('a-b'), credentialRef('ab'));
  assert.match(credentialRef('bili-helper'), /^[A-Za-z_][A-Za-z0-9_]*$/);
});

test('清单校验：serverName 必须等于 id，缺字段/env 键/公网 url 都拒绝', () => {
  assert.equal(validateManifest(manifest()).ok, true);
  assert.match(validateManifest(manifest('bili', { serverName: 'other' })).errors.join(), /serverName/);
  assert.match(validateManifest(manifest('bili', { name: '' })).errors.join(), /name/);
  assert.match(validateManifest(manifest('bili', { kind: 'dsh-plugin' })).errors.join(), /kind/);
  assert.match(validateManifest(manifest('bili', { env: { TOKEN: 'x' } })).errors.join(), /env/);
  assert.match(validateManifest(manifest('bili', { id: 'Bili', serverName: 'Bili' })).errors.join(), /id 不合法/);
  const http = manifest('bili', { transport: 'streamable-http', url: 'https://example.com/mcp' });
  assert.match(validateManifest(http).errors.join(), /回环/);
  const loop = manifest('bili', { transport: 'streamable-http', url: 'http://127.0.0.1:8080/mcp' });
  assert.equal(validateManifest(loop).ok, true);
});

test('install：原子落位 + .source.json + 可重复安装（幂等覆盖）', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  const r = reg.install(src, { source: { repo: 'qq-bot-roost-plugins', version: '1.0.0' } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.existsSync(join(extensionsDir(home), 'bili', '.source.json')), true);
  assert.equal(reg.read('bili').serverName, 'bili');
  assert.deepEqual(reg.list().map((x) => x.id), ['bili']);
  assert.equal(reg.list()[0].foreign, false);

  const again = reg.install(src, { source: { repo: 'qq-bot-roost-plugins', version: '1.0.1' } });
  assert.equal(again.ok, true, again.reason);
  assert.equal(reg.sourceOf('bili').version, '1.0.1');
  assert.deepEqual(reg.list().map((x) => x.id), ['bili']);
});

test('install：覆盖更新要保住用户在面板里填的 config.json', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.install(src, { source: { repo: 'm', version: '0.1.0' } }).ok, true);

  /**
   * 配置是**用户数据**不是发布物：安装走的是「旧目录 rename 成 .old 再删」，
   * 不显式抢救就等于「更新一次设置全丢」。
   */
  const cfgFile = join(extensionsDir(home), 'bili', 'config.json');
  fs.writeFileSync(cfgFile, `${JSON.stringify({ defaultLimit: 3 }, null, 2)}\n`, 'utf8');

  assert.equal(reg.install(src, { source: { repo: 'm', version: '0.1.1' } }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).defaultLimit, 3, '更新后设置应保留');
  assert.equal(reg.sourceOf('bili').version, '0.1.1', '扩展本体仍是新版本');
});

test('空目录（卸载残留）不算用户手写：能重新安装，也能被卸载', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  /**
   * 复现：Windows 上 rmSync 遇到被占用的子进程句柄，会删内容留空目录。
   * 旧判据把它当「用户手写」→ 更新与卸载双双被拒，面板上扩展还消失了。
   */
  const empty = join(extensionsDir(home), 'bili');
  fs.mkdirSync(empty, { recursive: true });

  assert.equal(reg.isForeign('bili'), false, '空目录不该被当成用户手写');
  assert.deepEqual(reg.list().map((x) => x.id), [], '空目录不该出现在已装列表里');

  const r = reg.install(src, { source: { repo: 'm', version: '0.1.1' } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(reg.isForeign('bili'), false);
  assert.equal(reg.read('bili')?.id, 'bili', '安装应该接管这个空目录');

  // 卸掉之后目录应当整个消失，不留残骸
  assert.equal(reg.remove('bili').ok, true);
  assert.equal(fs.existsSync(empty), false);
});

test('用户手写目录（有 plugin.json 但没有 .source.json）仍然只读', (t) => {
  const home = tmpHome(t);
  const dir = join(extensionsDir(home), 'hand-written');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest('hand-written'), null, 2));
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.isForeign('hand-written'), true);
});

test('foreign 保护：用户手写目录（无 .source.json）拒绝覆盖与卸载，不给 force 后门', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.install(src).ok, true);
  assert.equal(reg.isForeign('bili'), true);
  fs.writeFileSync(join(reg.pathOf('bili'), 'my-note.txt'), '用户自己写的内容');

  const blocked = reg.install(src, { source: { repo: 'market' } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /用户手写/);
  assert.equal(fs.existsSync(join(reg.pathOf('bili'), '.source.json')), false);
  assert.equal(reg.remove('bili').ok, false);
  assert.equal(fs.readFileSync(join(reg.pathOf('bili'), 'my-note.txt'), 'utf8'), '用户自己写的内容', '用户文件一个字节都没动');
});

test('落位失败回滚：坏清单不产生已装扩展，点目录被清掉', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.install(src, { source: { repo: 'test' } }).ok, true);

  fs.writeFileSync(join(src, 'plugin.json'), JSON.stringify(manifest('bili', { serverName: 'wrong' })));
  const bad = reg.install(src, { source: { repo: 'market' } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /serverName/);
  assert.equal(reg.read('bili').serverName, 'bili', '已装的那份不受影响');
  assert.equal(fs.existsSync(join(extensionsDir(home), '.bili.installing')), false);
  assert.equal(fs.existsSync(join(extensionsDir(home), '.bili.old')), false);
});

test('list 跳过点开头暂存目录与坏清单目录', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  reg.install(src);
  const root = extensionsDir(home);
  fs.mkdirSync(join(root, '.bili.installing'));
  fs.mkdirSync(join(root, '.bili.old'));
  fs.mkdirSync(join(root, 'broken'));
  fs.writeFileSync(join(root, 'broken', 'plugin.json'), '{ this is not json');

  assert.deepEqual(reg.list().map((x) => x.id), ['bili']);
});

test('上次失败残留的 .old 会先恢复，不会被当垃圾清掉', (t) => {
  const { home, src } = staged(t, 'bili');
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.install(src, { source: { repo: 'test' } }).ok, true);
  const dest = reg.pathOf('bili');
  const old = join(extensionsDir(home), '.bili.old');
  fs.renameSync(dest, old); // 模拟上次「rename 之后」双重故障残留
  fs.writeFileSync(join(old, 'keep.txt'), '原扩展内容');

  const r = reg.install(src, { source: { repo: 'test' } });
  assert.equal(r.ok, true, r.reason);
  assert.equal(fs.existsSync(old), false, '残留被消费掉');
  assert.equal(reg.read('bili').serverName, 'bili');
  assert.deepEqual(reg.list().map((x) => x.id), ['bili']);
});

test('目录派生：extensions / secrets 都在注入的 dataDir 下，不依赖真实家目录', (t) => {
  const home = tmpHome(t);
  assert.equal(extensionsDir(home), join(home, 'extensions'));
  assert.equal(secretsDir(home), join(home, 'secrets'));
  const reg = createExtRegistry({ dir: home });
  assert.equal(reg.root, join(home, 'extensions'));
  assert.deepEqual(reg.list(), []);
});
