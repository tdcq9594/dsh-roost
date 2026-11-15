/**
 * 更新已装扩展时的「暂停 → 等目录释放 → 落位 → 恢复」编排。
 *
 * 背景（2026-11-15 实机）：Windows 上扩展子进程的 cwd 就是
 * `<dataDir>/extensions/<id>/`，`registry.install()` 的原子 rename 会拿到
 * EBUSY。落位前先摘掉该扩展的受管块条目，让 DSH 自己 dispose 连接；
 * 无论成功失败都必须把受管块写回，绝不能把扩展留在离线状态。
 *
 * 这里不真起子进程占目录，而是打桩 `registry.install()` 返回带 `code`
 * 的占用错误 —— 能精确控制「第几次成功」，也不依赖真机 HMR 时序。
 *
 * 更新类用例一律带 `force: true`：夹具两次装的是同一份模板、目录哈希相同，
 * 会被「已是最新版」短路挡掉，而这些用例要测的是短路之后的落位编排。
 * 短路与 force 本身另见 `ext-market-idempotent.test.js`。
 *
 * 跑法：node --test test/ext-market-pause.test.js
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtRegistry, MANIFEST_FILE } from '../src/ext-registry.js';
import { createExtMarket } from '../src/ext-market.js';
import { hashDir } from '../src/ext-bundle.js';

const HOMES = [];
after(() => {
  for (const d of HOMES) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});
function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-pause-'));
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

async function rig({ id = 'bili', extra = {}, busyCode = 'EBUSY', pauseTimeoutMs = 5_000 } = {}) {
  const dir = tmpHome();
  const real = createExtRegistry({ dir });
  const sha = await (async () => {
    const d = tmpHome();
    writeTree(d, filesFor(id, extra));
    return hashDir(d);
  })();
  const blocks = [];
  const ctl = { renderCalls: 0, installCalls: 0, waits: 0, throwOn: [], busyRemaining: 0, busyCode };
  const extPatch = {
    render: (ids, o) => {
      ctl.renderCalls++;
      blocks.push({ ids: [...ids], apply: o.apply });
      if (ctl.throwOn.includes(ctl.renderCalls)) throw new Error('受管块写盘失败');
      return { written: true, ids };
    },
  };
  /** 包装真实 registry，只拦截 install 以模拟目录被占用 */
  const registry = {
    ...real,
    list: () => real.list(),
    install: (staging, opts) => {
      ctl.installCalls++;
      if (ctl.busyRemaining > 0) {
        ctl.busyRemaining--;
        return { ok: false, reason: '落位失败，已回滚：目录被占用', code: ctl.busyCode };
      }
      return real.install(staging, opts);
    },
  };
  const market = createExtMarket({
    dir, registry, extPatch,
    fetchText: async () => JSON.stringify({
      schema: 1, repo: 'o/r', branch: 'main',
      plugins: [{ id, kind: 'dsh-extension', path: `plugins/${id}`, sha256: sha }],
    }),
    download: async (entry, dest) => { writeTree(dest, filesFor(entry.id, extra)); },
    pauseTimeoutMs,
    wait: async () => { ctl.waits++; },
    log: { info: () => {}, warn: () => {} },
  });
  return { dir, real, registry, market, blocks, ctl, sha };
}

/** 先装一版，清掉记录，让后续断言只看「更新」这一次 */
async function preinstall(r, id = 'bili') {
  const first = await r.market.install(id);
  assert.equal(first.ok, true, first.message);
  r.blocks.length = 0;
  r.ctl.renderCalls = 0;
  r.ctl.installCalls = 0;
  r.ctl.waits = 0;
  r.ctl.busyRemaining = 0;
}

// ---------------------------------------------------------------- 暂停 / 恢复

test('P1 新装不暂停：受管块只写一次，且含目标 id', async () => {
  const r = await rig();
  const out = await r.market.install('bili');
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(r.blocks, [{ ids: ['bili'], apply: true }]);
  assert.equal(r.ctl.installCalls, 1);
});

test('P2 更新已装 stdio 扩展：先摘受管块、落位后写回', async () => {
  const r = await rig();
  await preinstall(r);
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.deepEqual(r.blocks, [
    { ids: [], apply: true },       // 摘掉 mcp-bili，DSH 释放目录
    { ids: ['bili'], apply: true }, // 写回 = 恢复连接
  ], '受管块必须恰好两次：摘除 + 恢复');
  assert.equal(r.ctl.installCalls, 1);
  assert.ok(r.real.read('bili'), '原扩展仍在（回滚干净）');
});

test('P3 落位遇 EBUSY 会重试，占用解除后成功', async () => {
  const r = await rig();
  await preinstall(r);
  r.ctl.busyRemaining = 2; // 更新的前两次落位仍被占用
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(r.ctl.installCalls, 3, '两次占用 + 一次成功');
  assert.equal(r.ctl.waits, 2, '两次占用各等一轮');
  assert.deepEqual(r.blocks.at(-1), { ids: ['bili'], apply: true }, '成功后仍要写回受管块');
});

test('P4 一直占用到超时：返回 ext_busy、原扩展完好、受管块已恢复', async () => {
  const r = await rig({ pauseTimeoutMs: 0 });
  await preinstall(r);
  r.ctl.busyRemaining = 999;
  const before = fs.readFileSync(join(r.real.pathOf('bili'), MANIFEST_FILE), 'utf8');
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'ext_busy');
  assert.match(out.message, /重启 DSH/);
  assert.equal(fs.readFileSync(join(r.real.pathOf('bili'), MANIFEST_FILE), 'utf8'), before,
    '超时不能碰原扩展目录');
  assert.deepEqual(r.blocks.at(-1), { ids: ['bili'], apply: true }, '失败也必须恢复受管块');
  assert.equal(fs.existsSync(join(r.dir, '.market-tmp', 'bili')), false, '暂存目录要清掉');
});

test('P5 非占用类落位错误不重试，原样失败', async () => {
  const r = await rig({ busyCode: 'EINVAL' });
  await preinstall(r);
  r.ctl.busyRemaining = 1;
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'install_failed');
  assert.equal(r.ctl.installCalls, 1, 'EINVAL 不该被当成占用重试');
  assert.equal(r.ctl.waits, 0);
  assert.deepEqual(r.blocks.at(-1), { ids: ['bili'], apply: true }, '失败也要恢复');
});

test('P6 摘除受管块失败：不落位、目录零改动，仍兜底恢复', async () => {
  const r = await rig();
  await preinstall(r);
  const before = fs.readFileSync(join(r.real.pathOf('bili'), MANIFEST_FILE), 'utf8');
  r.ctl.throwOn = [1]; // 更新的第一次 render（摘除）抛错
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, false);
  assert.equal(r.ctl.installCalls, 0, '摘除失败就不该动扩展目录');
  assert.equal(fs.readFileSync(join(r.real.pathOf('bili'), MANIFEST_FILE), 'utf8'), before);
  assert.deepEqual(r.blocks.at(-1), { ids: ['bili'], apply: true }, '兜底恢复必须发生');
});

test('P7 写回失败时由 finally 兜底恢复，并把风险写进 warnings', async () => {
  const r = await rig();
  await preinstall(r);
  r.ctl.throwOn = [2]; // 摘除成功，finalize 写回失败
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.ok(out.warnings.some((w) => /受管块未写入/.test(w)));
  assert.deepEqual(r.blocks.at(-1), { ids: ['bili'], apply: true }, 'finally 必须再试一次写回');
  assert.equal(r.ctl.renderCalls, 3, '摘除 + 写回失败 + 兜底恢复');
});

// ---------------------------------------------------------------- 不该暂停的形态

test('P8 手写目录（foreign）不暂停，直接拒绝覆盖', async () => {
  const r = await rig();
  writeTree(r.real.pathOf('bili'), filesFor('bili')); // 无 .source.json
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.reason, 'foreign');
  assert.deepEqual(r.blocks, [], 'foreign 连受管块都不该碰');
  assert.equal(r.ctl.installCalls, 0);
});

test('P9 streamable-http 更新不暂停：没有可 dispose 的宿主子进程', async () => {
  const r = await rig({ extra: {
    transport: 'streamable-http',
    url: 'http://127.0.0.1:17999/mcp',
    command: undefined, args: undefined, // http 形态没有可接管的子进程
  } });
  await preinstall(r);
  const out = await r.market.install('bili', { force: true });
  assert.equal(out.ok, true, out.message);
  assert.equal(r.ctl.renderCalls, 1, 'http 形态不该触发摘除 / 恢复两次写盘');
  assert.deepEqual(r.blocks, [{ ids: [], apply: true }], 'streamable-http 本来就不进受管块');
  assert.equal(r.ctl.installCalls, 1);
});
