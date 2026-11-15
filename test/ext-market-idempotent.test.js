/**
 * 「已是最新版」短路 / force 强制重装 / 更新时复用令牌 / 下载进度心跳。
 *
 * 背景（2026-11-15 实机）：bili 升到 0.11.8 后，切页签回来按钮变成「重装」
 * 却仍可点；后端没有短路，点一次就重下整仓 tar.gz、重新落位，还把令牌
 * 换掉导致运行中的扩展进程 401。这套用例盯的就是别再退回去。
 *
 * 跑法：node --test test/ext-market-idempotent.test.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  createExtRegistry, createExtSecrets, createClientStore, normalizeScopes,
} from '../src/ext-registry.js';
import { createExtMarket, formatBytes } from '../src/ext-market.js';
import { hashDir } from '../src/ext-bundle.js';

const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-idem-'));
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
function filesFor(id, extra = {}) {
  return {
    'plugin.json': `${JSON.stringify(manifest(id, extra), null, 2)}\n`,
    'server.mjs': '// server\n',
  };
}
function writeTree(root, files) {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
}

async function rig({ extra = {}, useDefaultDownload = false } = {}) {
  const dir = tmpHome();
  const secrets = createExtSecrets({ dir });
  const clientStore = createClientStore({ dir });
  const registry = createExtRegistry({ dir, secrets, clientStore });
  // 目录名必须是 id：registry.install 会拿 basename 当 expectedId 校验清单
  const tpl = join(tmpHome(), 'bili');
  writeTree(tpl, filesFor('bili', extra));
  const sha = await hashDir(tpl);

  /** 索引可变：同一个 rig 里先正常装，再模拟「索引换了 / 缺 sha / 被撤回」 */
  let idx = {
    schema: 1, repo: 'o/r', branch: 'main',
    plugins: [{ id: 'bili', kind: 'dsh-extension', path: 'plugins/bili', sha256: sha }],
  };
  const setIndex = (patch) => { idx = { ...idx, ...patch }; };
  const setEntry = (patch) => { idx = { ...idx, plugins: [{ ...idx.plugins[0], ...patch }] }; };

  const ctl = { downloadCalls: 0, installCalls: 0, renderCalls: 0, progressAtDownload: null };
  const wrapped = {
    ...registry,
    list: () => registry.list(),
    install: (staging, opts) => { ctl.installCalls++; return registry.install(staging, opts); },
  };
  const extPatch = {
    render: (ids) => { ctl.renderCalls++; return { written: true, ids }; },
  };
  const holder = {};
  const market = createExtMarket({
    dir, registry: wrapped, extPatch,
    fetchText: async () => JSON.stringify(idx),
    ...(useDefaultDownload ? {} : {
      download: async (entry, dest, opts) => {
        ctl.downloadCalls++;
        writeTree(dest, filesFor(entry.id, extra));
        opts?.onProgress?.(1536 * 1024, 4 * 1024 * 1024);
        ctl.progressAtDownload = holder.market.progress();
      },
    }),
    log: { info: () => {}, warn: () => {} },
  });
  holder.market = market;
  return { dir, sha, market, registry, secrets, clientStore, ctl, setIndex, setEntry, tpl, holder };
}

async function preinstall(r, opts = {}) {
  const first = await r.market.install('bili', opts);
  assert.equal(first.ok, true, first.message);
  assert.equal(first.alreadyLatest, undefined, '新装不该被短路');
  r.ctl.downloadCalls = 0;
  r.ctl.installCalls = 0;
  r.ctl.renderCalls = 0;
}

// ---------------------------------------------------------------- 已是最新版

test('I1 哈希一致时直接收工：不下载、不落位、不写受管块', async () => {
  const r = await rig();
  await preinstall(r);
  const out = await r.market.install('bili');
  assert.equal(out.ok, true);
  assert.equal(out.alreadyLatest, true);
  assert.match(out.message, /已是最新版/);
  assert.equal(r.ctl.downloadCalls, 0, '整仓 tar.gz 不该再下一遍');
  assert.equal(r.ctl.installCalls, 0, '不该动扩展目录');
  assert.equal(r.ctl.renderCalls, 0, '不该重启扩展连接');
  assert.equal(r.market.progress().phase, 'done', '进度条要收尾，不能停在 download');
});

test('I2 force 才真正重装：下载 + 落位 + 暂停恢复都走一遍', async () => {
  const r = await rig();
  await preinstall(r);
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.alreadyLatest, undefined);
  assert.equal(r.ctl.downloadCalls, 1);
  assert.equal(r.ctl.installCalls, 1);
  assert.ok(r.ctl.renderCalls >= 2, '更新要摘除 + 恢复受管块');
  assert.ok(r.registry.read('bili'), '扩展目录仍在');
});

test('I3 索引 sha 变了就是真更新，不短路', async () => {
  const r = await rig();
  await preinstall(r);
  r.setEntry({ sha256: 'e'.repeat(64) });
  const out = await r.market.install('bili');
  assert.equal(out.alreadyLatest, undefined, '哈希不同不能短路');
  assert.equal(r.ctl.downloadCalls, 1, '要真的去下载校验');
  assert.equal(out.ok, false, '夹具里下载内容仍是旧哈希，校验必然拦下');
  assert.match(out.message, /哈希与索引不一致/);
});

test('I4 索引缺 sha256 时短路失效，在下载前就按「无法校验」拒绝', async () => {
  const r = await rig();
  await preinstall(r);
  r.setEntry({ sha256: '' });
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, false);
  assert.equal(out.alreadyLatest, undefined, '缺哈希不能当成「已是最新版」');
  assert.equal(r.ctl.downloadCalls, 0, 'sha 校验在下载之前，连包都不该拉');
  assert.match(out.message, /缺 sha256/);
});

test('I5 foreign 手写目录：force 也拒，短路不绕过保护', async () => {
  const r = await rig();
  writeTree(r.registry.pathOf('bili'), filesFor('bili')); // 无 .source.json
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.reason, 'foreign');
  assert.equal(r.ctl.installCalls, 0);
});

test('I6 撤回判定优先于短路：被撤回的已装扩展不能说「已是最新版」', async () => {
  const r = await rig();
  await preinstall(r);
  r.setIndex({ revoked: ['bili'] });
  const out = await r.market.install('bili');
  assert.equal(out.reason, 'revoked');
  assert.equal(r.ctl.downloadCalls, 0);
});

// ---------------------------------------------------------------- 令牌复用

test('I7 更新复用旧令牌：hash 不变，旧 token 仍可 verify', async () => {
  const r = await rig();
  await preinstall(r);
  const token = r.secrets.read('bili')?.token;
  const before = r.clientStore.get('ext:bili');
  assert.ok(token && before?.hash, '新装要签发过令牌');

  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(r.secrets.read('bili')?.token, token, '更新不该换 token');
  assert.equal(r.clientStore.get('ext:bili').hash, before.hash, 'hash 不能变');
  assert.ok(r.clientStore.verify(token), '旧令牌必须仍然有效，否则运行中的扩展立刻 401');
});

test('I8 secrets.sync 只同步 scopes，不换凭据', async () => {
  const dir = tmpHome();
  const secrets = createExtSecrets({ dir });
  const store = createClientStore({ dir });
  const first = secrets.issue('bili', store, { scopes: ['memory:write'] });
  const r = secrets.sync('bili', store, { scopes: ['say:write'] });
  assert.equal(r.reused, true);
  assert.equal(r.token, first.token);
  assert.equal(r.hash, first.hash);
  assert.deepEqual(r.client.scopes, normalizeScopes(['say:write']), '新清单的权限要生效');
  assert.equal(r.client.createdAt, first.client.createdAt, '不该把客户端记录当新建的');
  assert.ok(store.verify(first.token));
});

test('I9 状态对不上时 sync 退回 issue 自愈（不复用坏凭据）', async () => {
  const dir = tmpHome();
  const secrets = createExtSecrets({ dir });
  const store = createClientStore({ dir });
  const first = secrets.issue('bili', store, { scopes: [] });

  // ① secret 文件丢了（备份还原场景）
  fs.rmSync(secrets.fileOf('bili'), { force: true });
  let r = secrets.sync('bili', store, { scopes: [] });
  assert.equal(r.reused, false);
  assert.notEqual(r.token, first.token);
  assert.ok(store.verify(r.token));

  // ② secret 在、但 api-clients 的 hash 被人改坏了
  store.rotate('ext:bili', '0'.repeat(64));
  r = secrets.sync('bili', store, { scopes: [] });
  assert.equal(r.reused, false, 'hash 对不上不能复用');
  assert.ok(store.verify(r.token), '要重新签发到可用状态');
});

test('I10 新装签发、更新复用的标记不撒谎', async () => {
  const r = await rig();
  const fresh = r.registry.install(r.tpl, { source: { sha256: r.sha } });
  assert.equal(fresh.ok, true, fresh.reason);
  assert.equal(fresh.tokenIssued, true);
  assert.equal(fresh.tokenReused, false);

  const again = r.registry.install(r.tpl, { source: { sha256: r.sha } });
  assert.equal(again.ok, true, again.reason);
  assert.equal(again.tokenIssued, false);
  assert.equal(again.tokenReused, true);
});

// ---------------------------------------------------------------- 下载进度

test('I11 formatBytes 说人话', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1536 * 1024), '1.5 MB');
  assert.equal(formatBytes(undefined), '0 B');
});

test('I12 下载阶段的字节数会进进度文案，不再一动不动像卡死', async () => {
  const r = await rig();
  const out = await r.market.install('bili');
  assert.equal(out.ok, true, out.message);
  assert.equal(r.ctl.progressAtDownload?.phase, 'download');
  assert.match(r.ctl.progressAtDownload?.message ?? '', /已下载 1\.5 MB \/ 4\.0 MB/);
});

test('I15 强制重装 + 敏感权限：确认之后 force 仍在，第二次请求不被短路吃掉', async () => {
  const r = await rig({ extra: { scopes: ['say:write'] } });
  await preinstall(r, { confirmScopes: true });

  // 模拟前端第一次点击：只带 force → 后端先要授权
  const ask = await r.market.install('bili', { force: true });
  assert.equal(ask.reason, 'needs_scope_confirm');

  // 模拟「授权并安装」：confirmScopeAct 把 ask.extra 一起发回来
  const out = await r.market.install('bili', { force: true, confirmScopes: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(out.alreadyLatest, undefined, 'force 不能被短路覆盖');
  assert.equal(r.ctl.installCalls, 1, '只有确认后那一次真的落位');
  /**
   * 下载是两次：判 `needs_scope_confirm` 需要先解出暂存清单，所以第一次请求
   * 就已经下过一份；确认后的重试不复用暂存目录，会再下一次整仓 tar.gz。
   * 慢网络下这个重复开销仍在（本轮没动它，属已知的后续优化点）。
   */
  assert.equal(r.ctl.downloadCalls, 2);
});

const ROOT = new URL('..', import.meta.url);
const src = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

test('I13b 接线：force 从按钮 → 确认弹窗 → 宿主 → 市场，一路不丢', () => {
  const client = src('client/client.js');
  assert.ok(client.includes("confirmLabel: '确认强制重装'"), '「重装」必须二次确认');
  assert.ok(client.includes('{ force: true }'), '确认后才带 force');
  assert.ok(client.includes('...(ask.extra || {})'), '授权弹窗要透传 force');
  assert.ok(client.includes('const marketAct = async (op, id, extra = {})'), 'marketAct 要收 extra');
  assert.ok(client.includes('marketProgress.percent'), '进度条仍在');

  const host = src('src/host.js');
  assert.ok(host.includes('arg?.force === true'), '宿主只认显式 true，别把任意值当授权');

  const market = src('src/ext-market.js');
  assert.ok(market.includes('alreadyLatest: true'), '后端要有短路返回');
  assert.ok(market.includes('formatBytes(got)'), '下载进度要按字节回报');
});

test('I13 默认下载按块回报：流式读取时进度会更新', async () => {
  const r = await rig({ useDefaultDownload: true });
  const holder = r.holder;
  const snaps = [];
  const realFetch = globalThis.fetch;
  const url = 'https://codeload.github.com/o/r/tar.gz/refs/heads/main';
  globalThis.fetch = async () => {
    let n = 0;
    return {
      ok: true, status: 200, url,
      headers: { get: (k) => (k === 'content-length' ? String(3 * 200 * 1024) : null) },
      body: {
        getReader: () => ({
          read: async () => {
            snaps.push(holder.market.progress());
            n++;
            // 全是零字节，不是合法 tar.gz；校验阶段会抛，这里只关心进度心跳
            return n <= 3 ? { done: false, value: new Uint8Array(200 * 1024) } : { done: true };
          },
          cancel: async () => {},
        }),
      },
    };
  };
  try {
    const out = await r.market.install('bili');
    assert.equal(out.ok, false, '假包不可能通过校验');
    assert.ok(snaps.some((s) => s.phase === 'download' && /已下载/.test(s.message)),
      '流式下载期间至少要回报一次字节数');
  } finally {
    globalThis.fetch = realFetch;
  }
});
