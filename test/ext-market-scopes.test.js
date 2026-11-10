/**
 * 市场安装的权限确认（阶段 8）。
 *
 * 一键装**不能顺带把授权也点了**：清单索要 `say:write` / `proactive:write`
 * 这类会对外说话的 scope 时，`install()` 必须回 `needs_scope_confirm`，
 * 只有面板显式带 `confirmScopes:true` 才真装。
 *
 * 跑法：node --test test/ext-market-scopes.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtMarket } from '../src/ext-market.js';
import {
  createExtRegistry, createClientStore, createExtSecrets, MANIFEST_FILE,
} from '../src/ext-registry.js';
import { hashDir } from '../src/ext-bundle.js';

function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-market-scopes-'));
  return d;
}

const HOMES = [];
test.after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});

const manifestOf = (id, extra = {}) => ({
  api: 1, kind: 'dsh-extension', id, serverName: id,
  name: `扩展${id}`, description: '说明', transport: 'stdio',
  command: 'node', args: ['server.mjs'], ...extra,
});

/** 造一份「分发包目录」并算出它的目录哈希（与索引里的 sha256 对齐）。 */
async function treeOf(id, extra = {}) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-tree-'));
  HOMES.push(d);
  fs.writeFileSync(join(d, MANIFEST_FILE), `${JSON.stringify(manifestOf(id, extra), null, 2)}\n`, 'utf8');
  fs.writeFileSync(join(d, 'server.mjs'), '// server\n', 'utf8');
  return { dir: d, sha: await hashDir(d) };
}

async function rig(id, extra = {}) {
  const home = tmpHome();
  HOMES.push(home);
  const tree = await treeOf(id, extra);
  const clientStore = createClientStore({ dir: home });
  const secrets = createExtSecrets({ dir: home });
  const registry = createExtRegistry({ dir: home, secrets, clientStore });
  const market = createExtMarket({
    dir: home,
    registry,
    clientStore,
    fetchText: async () => JSON.stringify({
      repo: 'o/r',
      plugins: [{ id, kind: 'dsh-extension', path: `plugins/${id}`, sha256: tree.sha }],
    }),
    download: async (_entry, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(tree.dir, dest, { recursive: true });
    },
    log: { info: () => {}, warn: () => {} },
  });
  return { home, market, registry, clientStore, secrets };
}

test('M-S1 索要敏感 scope 时拒绝安装并报出要授什么', async () => {
  const r = await rig('bili', { scopes: ['memory:write', 'say:write'] });
  const out = await r.market.install('bili');
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'needs_scope_confirm');
  assert.deepEqual(out.scopes, ['say:write']);
  assert.match(out.message, /say:write/);
  // 关键：没确认就**一个文件都没落**
  assert.equal(r.registry.read('bili'), null);
  assert.equal(r.clientStore.get('ext:bili'), null);
});

test('M-S2 只有安全 scope 时不打扰，直接装并落默认权限', async () => {
  const r = await rig('douyu', { scopes: ['memory:write', 'state:read'] });
  const out = await r.market.install('douyu');
  assert.equal(out.ok, true);
  assert.deepEqual(r.clientStore.get('ext:douyu').scopes, ['memory:write', 'state:read']);
});

test('M-S3 confirmScopes:true 才真装，且令牌带上被确认的 scope', async () => {
  const r = await rig('probe', { scopes: ['memory:write', 'state:read', 'proactive:write'] });
  const out = await r.market.install('probe', { confirmScopes: true });
  assert.equal(out.ok, true);
  assert.deepEqual(
    r.clientStore.get('ext:probe').scopes,
    ['memory:write', 'state:read', 'proactive:write'],
  );
});

test('M-S4 清单没写 scopes 的老扩展照常装，拿默认权限（不能因为新规则装不上）', async () => {
  const r = await rig('legacy');
  const out = await r.market.install('legacy');
  assert.equal(out.ok, true);
  assert.deepEqual(r.clientStore.get('ext:legacy').scopes, ['memory:write', 'state:read']);
});
