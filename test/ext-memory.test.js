/**
 * 阶段 4.2 / 门 G4：ACL、private 双条件、两个写入口、清空契约、工具接线。
 *
 * 跑法：node --test test/ext-memory.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createExtMemoryStore } from '../src/ext-memory-store.js';
import {
  createExtMemory, DEFAULT_EXT_ACL, canReadExt, canWriteExt, isPrivateContext, renderToolJson,
} from '../src/ext-memory.js';
import { buildToolDefs } from '../src/tools.js';
import { truncateToolContent, TOOL_OUTPUT_BYTE_LIMIT } from '../src/ext-usage.js';
import { createApiV1 } from '../src/api-v1.js';
import { createClientStore } from '../src/ext-registry.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-mem2-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function make(t, over = {}) {
  const dir = tmpHome(t);
  const warns = [];
  const log = { warn: (m) => warns.push(m), info: () => {} };
  const store = createExtMemoryStore({ dir, log });
  const ext = createExtMemory({
    store, log, installedIds: () => ['bili', 'douyu', 'secret-ext'],
    acl: {
      ...DEFAULT_EXT_ACL,
      perExt: { 'secret-ext': { private: true } },
    },
    ...over,
  });
  return { dir, warns, store, ext };
}

test('G4-12 ACL：owner/admin 可读写，member 只读不可写，unknown 全禁', () => {
  assert.equal(canReadExt({ extId: 'bili', bucket: 'owner' }), true);
  assert.equal(canWriteExt({ extId: 'bili', bucket: 'owner' }), true);
  assert.equal(canReadExt({ extId: 'bili', bucket: 'admin' }), true);
  assert.equal(canWriteExt({ extId: 'bili', bucket: 'admin' }), true);
  assert.equal(canReadExt({ extId: 'bili', bucket: 'member' }), true);
  assert.equal(canWriteExt({ extId: 'bili', bucket: 'member' }), false);
  assert.equal(canReadExt({ extId: 'bili', bucket: 'unknown' }), false);
  assert.equal(canWriteExt({ extId: 'bili', bucket: 'unknown' }), false);
});

test('G4-13 private 双条件：私聊 + owner/admin 才可见私密命名空间', (t) => {
  assert.equal(isPrivateContext({ bucket: 'owner', kind: 'c2c' }), true);
  assert.equal(isPrivateContext({ bucket: 'admin', kind: 'c2c' }), true);
  assert.equal(isPrivateContext({ bucket: 'owner', kind: 'group' }), false, '主人在群里说话是公开的');
  assert.equal(isPrivateContext({ bucket: 'member', kind: 'c2c' }), false);
  const { ext } = make(t);
  assert.equal(canReadExt({ extId: 'secret-ext', bucket: 'owner', kind: 'group', acl: ext.acl }), false);
  assert.equal(canReadExt({ extId: 'secret-ext', bucket: 'owner', kind: 'c2c', acl: ext.acl }), true);
  assert.equal(canReadExt({ extId: 'secret-ext', bucket: 'member', kind: 'c2c', acl: ext.acl }), false);
  assert.deepEqual(ext.visibleExtIds({ bucket: 'owner', kind: 'group' }), ['bili', 'douyu']);
  assert.deepEqual(ext.visibleExtIds({ bucket: 'member', kind: 'c2c' }), ['bili', 'douyu']);
});

test('G4-14 后台写：extId 由令牌定，body 自报被忽略并记 warn', async (t) => {
  const { ext, store, warns } = make(t);
  const r = await ext.writeFromApi({ extId: 'bili', fact: '后台写的一条', body: { extId: 'evil-other' } });
  assert.equal(r.ok, true);
  assert.equal(r.extId, 'bili');
  assert.deepEqual(store.list('bili').map((x) => x.text), ['后台写的一条']);
  assert.ok(warns.some((m) => m.includes('忽略请求体里的 extId')));
  assert.equal((await ext.writeFromApi({ fact: 'x' })).ok, false);
});

test('G4-15 模型写：档位 ACL 与 quota 两道都在写盘之前', async (t) => {
  const deniedQuota = { charge: () => ({ ok: false, message: '次数用完了' }) };
  const { ext, store } = make(t, { quota: deniedQuota });
  assert.equal((await ext.writeFromTool({ extId: 'bili', fact: 'x', caller: { bucket: 'member' } })).reason, 'acl');
  assert.equal((await ext.writeFromTool({ extId: 'bili', fact: 'x', caller: { bucket: 'unknown' } })).reason, 'acl');
  assert.equal((await ext.writeFromTool({ extId: 'bili', fact: 'x', caller: { bucket: 'owner' } })).reason, 'quota');
  assert.equal(store.list('bili').length, 0, '被拒的两次一次都不能写盘');

  const ok = make(t, { quota: { charge: () => ({ ok: true }) } });
  const r = await ok.ext.writeFromTool({ extId: 'bili', fact: '主人写的', caller: { bucket: 'owner', kind: 'group' } });
  assert.equal(r.ok, true);
  assert.deepEqual(ok.store.list('bili').map((x) => x.text), ['主人写的']);
});

test('G4-16 两个写入口并发：api 10 + tool 10 全在，不丢更新', async (t) => {
  const { ext, store } = make(t, { quota: { charge: () => ({ ok: true }) } });
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(ext.writeFromApi({ extId: 'bili', fact: `api-${i}` }));
    jobs.push(ext.writeFromTool({ extId: 'bili', fact: `tool-${i}`, caller: { bucket: 'owner', kind: 'group' } }));
  }
  await Promise.all(jobs);
  assert.equal(store.list('bili').length, 20);
});

test('G4-17 清空契约：清本会话 / 彻底删不动 ext，全局清尊重 onClear', async (t) => {
  const { ext, store } = make(t);
  await store.add('bili', { text: 'a' });
  await store.add('douyu', { text: 'b' });
  await store.setMeta('douyu', { onClear: 'clear' });
  assert.equal((await ext.onClear('memory.clear')).touched, false);
  assert.equal((await ext.onClear('memory.purge')).touched, false);
  assert.equal(store.list('bili').length, 1);
  const g = await ext.onClear('memory.clearGlobal');
  assert.deepEqual({ cleared: g.cleared, kept: g.kept }, { cleared: 1, kept: 1 });
  assert.equal(store.list('bili').length, 1, 'keep 的扩展要留下');
  assert.equal(store.stats().douyu, undefined);
});

test('G5-20 阶段 5 面板清空入口：onClear 接 opts，clearAllFromPanel 只碰 ext 文件', async (t) => {
  const { ext, store } = make(t);
  await store.add('bili', { text: 'a' });
  await store.setMeta('bili', { onClear: 'clear' });
  /** 不传 opts 或显式 false 时，行为与阶段 4 完全一致。 */
  assert.equal((await ext.onClear('memory.clear')).touched, false);
  assert.equal((await ext.onClear('memory.purge', { clearExtMemory: false })).touched, false);
  assert.equal(store.list('bili').length, 1);
  /** 勾了「一并清除」才真清，且尊重 onClear=keep 的保留。 */
  assert.equal((await ext.onClear('memory.clear', { clearExtMemory: true })).cleared, 1);
  assert.equal(store.list('bili').length, 0);
  await store.add('douyu', { text: 'b' });
  await store.setMeta('douyu', { onClear: 'keep' });
  const r = await ext.clearAllFromPanel();
  assert.deepEqual({ cleared: r.cleared, kept: r.kept }, { cleared: 0, kept: 1 });
  assert.equal(store.list('douyu').length, 1, 'keep 的扩展不能被面板入口绕过');
});

test('G4-18 搜索范围：默认只可见 / all:true 全搜 / extId 限定', async (t) => {
  const { ext, store } = make(t);
  await store.add('bili', { text: '番剧 更新' });
  await store.add('secret-ext', { text: '番剧 私密' });
  const owner = { bucket: 'owner', kind: 'group' };
  assert.equal(ext.search({ query: '番剧', caller: owner }).results.length, 1, '私密命名空间在群里不可见');
  assert.equal(ext.search({ query: '番剧', extId: 'bili', caller: owner }).results.length, 1);
  assert.equal(ext.search({ query: '番剧', caller: { bucket: 'unknown' } }).results.length, 0);
  assert.equal(ext.search({ query: '番剧', caller: { bucket: 'unknown' } }).reason, 'no_visible_namespace');

  // P0 回归：all:true 只放宽检索范围，绝不能放宽命名空间 ACL / private 双条件。
  assert.equal(ext.search({ query: '番剧', all: true, caller: owner }).results.length, 1, '群里 all:true 仍读不到私密');
  assert.equal(ext.search({ query: '番剧', all: true, extId: 'secret-ext', caller: owner }).results.length, 0);
  assert.equal(ext.search({ query: '番剧', all: true, caller: { bucket: 'unknown' } }).results.length, 0);
  assert.equal(ext.search({ query: '番剧', all: true, caller: { bucket: 'owner', kind: 'c2c' } }).results.length, 2, '私聊 owner 才全见');
});

test('G4-19 截断复用 2.2：工具 render 单块合法 JSON，替换交给全局 waterfall', () => {
  const payload = { results: Array.from({ length: 200 }, (_, i) => `第${i}条`.repeat(40)) };
  const blocks = renderToolJson({}, payload);
  assert.equal(blocks.length, 1, '不在工具层重复截断');
  assert.deepEqual(JSON.parse(blocks[0].text), payload, '首块必须是完整合法 JSON');
  // 2.2 的纯函数由 host.js 注册的 tools/post-execute waterfall 全局调用。
  const cut = truncateToolContent(blocks, TOOL_OUTPUT_BYTE_LIMIT);
  assert.equal(cut.truncated, true);
  const total = cut.content.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0);
  assert.ok(total <= TOOL_OUTPUT_BYTE_LIMIT, `实际 ${total} 字节`);
  assert.match(cut.content.at(-1).text, /已截断/);
});

test('G4-20 tools.js 接线：注入 extMemory 才多两个工具，未注入形状不变', () => {
  const base = { journal: {}, graphOf: () => null, callerOf: () => ({}), cfgOf: () => ({}) };
  const before = buildToolDefs(base).map((d) => d.name);
  assert.ok(!before.includes('ext_memory_search'));
  const { ext } = make({ after: () => {} });
  const after = buildToolDefs({ ...base, extMemory: ext }).map((d) => d.name);
  assert.ok(after.includes('ext_memory_search'));
  assert.ok(after.includes('ext_memory_note'));
  assert.deepEqual(after.slice(0, before.length), before, '既有工具顺序不变');
  const defs = buildToolDefs({ ...base, extMemory: ext });
  const rendered = defs.find((d) => d.name === 'ext_memory_search').output.render({}, { ok: true });
  assert.ok(Array.isArray(rendered), 'render 必须返回内容块数组');
  assert.equal(rendered[0].type, 'text');
});

test('G4-21 端到端 /v1/memory/ext.add：令牌定 extId、忽略 body、落盘', async (t) => {
  const dir = tmpHome(t);
  const warns = [];
  const store = createExtMemoryStore({ dir });
  const ext = createExtMemory({ store, installedIds: () => ['bili'] });
  const clients = createClientStore({ dir });
  const { createHash } = await import('node:crypto');
  const token = 'ext-token-1';
  clients.add({
    id: 'ext:bili', name: 'bili', extId: 'bili', scopes: ['memory:write'], enabled: true,
    hash: createHash('sha256').update(token).digest('hex'),
  });
  const api = createApiV1({
    dir, clientStore: clients, auditFn: () => {},
    log: { warn: (m) => warns.push(m) },
    hooks: {
      'memory.ext.add': async ({ body }) => ({ status: 200, body: await ext.writeFromApi({ extId: body.extId, fact: body.fact, body }) }),
    },
  });
  const req = { method: 'POST', url: 'http://127.0.0.1/v1/memory/ext.add', headers: { authorization: `Bearer ${token}` } };
  const res = { headersSent: false, writableEnded: false, setHeader() {} };
  let out = null;
  const send = (code, body) => { out = { code, body }; return res; };
  const readJson = async () => ({ value: { extId: 'evil-other', fact: '来自扩展后台', requestId: 'r1' } });
  await api.handle(req, res, new URL(req.url), { send, readJson });
  assert.equal(out.code, 200);
  assert.equal(out.body.ok, true);
  assert.deepEqual(store.list('bili').map((x) => x.text), ['来自扩展后台']);
  assert.ok(warns.some((m) => m.includes('忽略请求体里的 extId')));
});
