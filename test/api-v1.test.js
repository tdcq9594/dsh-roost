/**
 * 阶段 3.1 / 3.2：`/v1` 骨架与方案 L 令牌链路（门 G3 的鉴权 / 幂等 / 吊销部分）。
 *
 * 用真实 `createClientStore` + `createExtSecrets` + 临时 dataDir，端到端验证
 * 「只存 hash、明文只在 secrets、缺值 401、轮换旧令牌失效」；不碰真实家目录。
 *
 * 跑法：node --test test/api-v1.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { createApiV1, V1_ROUTES, V1_SCOPES } from '../src/api-v1.js';
import { createClientStore, createExtSecrets, createExtRegistry, EXT_KIND } from '../src/ext-registry.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-api-v1-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

/** 造一个已装扩展（阶段 1 的落位另有测试，这里直接摆目录）。 */
function seedExtension(dir, id = 'bili', over = {}) {
  const ext = join(dir, 'extensions', id);
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(join(ext, 'plugin.json'), JSON.stringify({
    api: 1, kind: EXT_KIND, id, name: `扩展 ${id}`, description: 'd',
    transport: 'stdio', command: 'node', args: ['./server.mjs'], serverName: id, ...over,
  }, null, 2), 'utf8');
  return ext;
}

function fixture(t, over = {}) {
  const dir = tmpHome(t);
  const store = createClientStore({ dir });
  const secrets = createExtSecrets({ dir });
  seedExtension(dir);
  const issued = secrets.issue('bili', store);
  const audits = [];
  const warns = [];
  const api = createApiV1({
    dir, clientStore: store, auditFn: (e) => audits.push(e),
    log: { warn: (m) => warns.push(m) }, hooks: {}, now: () => 1_700_000_000_000,
    ...over,
  });
  return { dir, store, secrets, issued, audits, warns, api };
}

/** 带 `hooks.agent` 的 api：验授权客户端确实能走到独立会话入口（不直调 handleHook）。 */
function createApiV1ForAgent(f) {
  return createApiV1({
    dir: f.dir, clientStore: f.store, auditFn: (e) => f.audits.push(e),
    log: { warn: (m) => f.warns.push(m) }, now: () => 1_700_000_000_000,
    hooks: { agent: async () => ({ status: 200, body: { ok: true, sessionId: 's1' } }) },
  });
}

function call(api, method, path, { token, body = {}, headers = {} } = {}) {
  const req = { method, url: `http://127.0.0.1${path}`, headers: { ...headers } };
  if (token) req.headers.authorization = `Bearer ${token}`;
  const res = { headersSent: false, writableEnded: false, headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  const send = (code, data) => { res.status = code; res.body = data; return res; };
  const readJson = async () => ({ value: body });
  const url = new URL(req.url, 'http://127.0.0.1');
  return api.handle(req, res, url, { send, readJson }).then(() => res);
}

// ---------------------------------------------------------------- 3.1 鉴权骨架

test('G3-1 401：无 Bearer / 错令牌 / 已禁用客户端，且记 ext.auth_failed 审计', async (t) => {
  const f = fixture(t);
  assert.equal((await call(f.api, 'GET', '/v1/whoami')).status, 401);
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: 'wrong' })).status, 401);
  assert.ok(f.audits.some((a) => a.op === 'ext.auth_failed'));
  const c = f.store.get('ext:bili');
  f.store.add({ ...c, enabled: false });
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: f.issued.token })).status, 401);
});

test('G3-2 403：scope 不足 / 扩展令牌调 agent.* 与 say 被硬隔离', async (t) => {
  const f = fixture(t);
  assert.equal((await call(f.api, 'POST', '/v1/say', { token: f.issued.token })).status, 403);
  assert.equal((await call(f.api, 'POST', '/v1/agent.new', { token: f.issued.token })).status, 403);
  assert.equal((await call(f.api, 'GET', '/v1/state', { token: f.issued.token })).status, 403);
  // 非扩展客户端拿到对应 scope 后可以调用，说明按 scope 判定而非一刀切。
  const other = f.secrets.issue('other', f.store);
  f.store.add({ ...f.store.get('ext:other'), extId: null, scopes: ['state:read'] });
  assert.equal((await call(f.api, 'GET', '/v1/state', { token: other.token })).status, 501);
});

test('G3-3 429：同一客户端每分钟 120 次，第 121 次被挡并给 retry-after', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 120; i++) {
    assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: f.issued.token })).status, 200);
  }
  const last = await call(f.api, 'GET', '/v1/whoami', { token: f.issued.token });
  assert.equal(last.status, 429);
  assert.equal(last.headers['retry-after'], '60');
});

test('G3-2b agent.* 必须 agent:write：零 scope 客户端被挡，授权客户端才进 hook', async (t) => {
  const f = fixture(t);
  const { createHash } = await import('node:crypto');
  const weak = 'weak-client-token';
  f.store.add({ id: 'weak', name: '只读客户端', hash: createHash('sha256').update(weak).digest('hex'), scopes: ['state:read'], enabled: true });
  assert.equal((await call(f.api, 'POST', '/v1/agent.new', { token: weak })).status, 403);
  assert.equal((await call(f.api, 'GET', '/v1/agent.list', { token: weak })).status, 403);
  assert.equal((await call(f.api, 'POST', '/v1/agent.new', { token: f.issued.token })).status, 403, '扩展令牌纵深防御');

  const strong = 'agent-client-token';
  f.store.add({ id: 'agent-client', name: '裁判客户端', hash: createHash('sha256').update(strong).digest('hex'), scopes: ['agent:write'], enabled: true });
  const api = createApiV1ForAgent(f);
  assert.equal((await call(api, 'POST', '/v1/agent.new', { token: strong, body: { clientId: 'game' } })).status, 200);
});

test('G3-4 requestId 幂等：重复请求不重复执行 hook，返回首次结果', async (t) => {
  let calls = 0;
  const f = fixture(t, { hooks: { memory: { }, 'memory.ext.add': async () => { calls++; return { body: { ok: true, n: calls } }; } } });
  const a = await call(f.api, 'POST', '/v1/memory/ext.add', { token: f.issued.token, body: { requestId: 'r-1', fact: 'x' } });
  const b = await call(f.api, 'POST', '/v1/memory/ext.add', { token: f.issued.token, body: { requestId: 'r-1', fact: 'x' } });
  assert.equal(a.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(b.body, a.body);
});

test('G3-5 whoami 不回显 hash / 明文；未知路径 404；未接线 hook 明确 501', async (t) => {
  const f = fixture(t);
  const ok = await call(f.api, 'GET', '/v1/whoami', { token: f.issued.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.id, 'ext:bili');
  assert.ok(!JSON.stringify(ok.body).includes(f.issued.hash));
  assert.ok(!JSON.stringify(ok.body).includes(f.issued.token));
  assert.equal((await call(f.api, 'GET', '/v1/nope', { token: f.issued.token })).status, 404);
  assert.equal((await call(f.api, 'GET', '/v1/memory', { token: f.issued.token })).status, 403, '缺 memory:read');
  assert.equal(V1_SCOPES.length, 10, '§七 表格 9 个 + agent:write（独立会话专用授权）');
  assert.ok(V1_ROUTES['POST /v1/message']);
});

test('G3-6 extId 从令牌读：body 传 extId 被忽略并记 warn', async (t) => {
  let got = null;
  const f = fixture(t, { hooks: { 'memory.ext.add': async ({ body }) => { got = body; return { body: { ok: true } }; } } });
  await call(f.api, 'POST', '/v1/memory/ext.add', {
    token: f.issued.token, body: { extId: 'evil-other', fact: 'x' },
  });
  assert.equal(got.extId, 'bili');
  assert.ok(f.warns.some((m) => m.includes('忽略请求体里的 extId')));
});

// ---------------------------------------------------------------- 3.2 令牌链路

test('G3-7 api.clients 只存 hash；明文只在 secrets/<id>.json', (t) => {
  const f = fixture(t);
  const raw = fs.readFileSync(f.store.file, 'utf8');
  assert.ok(raw.includes(f.issued.hash));
  assert.ok(!raw.includes(f.issued.token));
  const secretPath = join(f.dir, 'secrets', 'bili.json');
  const sec = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
  assert.equal(sec.token, f.issued.token);
  assert.equal(sec.ref, 'ROOST_EXT_BILI_TOKEN');
  assert.equal(f.store.get('ext:bili').scopes.join(), 'memory:write');
});

test('G3-8 吊销生效；轮换后旧令牌 401、新令牌可用', async (t) => {
  const f = fixture(t);
  const rotated = f.secrets.rotate('bili', f.store);
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: f.issued.token })).status, 401);
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: rotated.token })).status, 200);
  f.secrets.revoke('bili', f.store);
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: rotated.token })).status, 401);
  assert.equal(fs.existsSync(join(f.dir, 'secrets', 'bili.json')), false);
});

test('G3-9 备份还原缺失自动重建：hash 变化、旧令牌失效', async (t) => {
  const f = fixture(t);
  fs.rmSync(join(f.dir, 'secrets', 'bili.json'));
  const rebuilt = f.secrets.ensure('bili', f.store);
  assert.equal(rebuilt.regenerated, true);
  assert.notEqual(rebuilt.hash, f.issued.hash);
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: f.issued.token })).status, 401);
  assert.equal((await call(f.api, 'GET', '/v1/whoami', { token: rebuilt.token })).status, 200);
  assert.equal(f.secrets.ensure('bili', f.store).regenerated, false);
});

test('G3-10 install 自动发令牌、remove 自动吊销（ext-registry 接线）', (t) => {
  const dir = tmpHome(t);
  const src = join(dir, 'bili');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(join(src, 'plugin.json'), JSON.stringify({
    api: 1, kind: EXT_KIND, id: 'bili', name: 'B', description: 'd',
    transport: 'stdio', command: 'node', args: ['./s.mjs'], serverName: 'bili',
  }), 'utf8');
  const store = createClientStore({ dir });
  const secrets = createExtSecrets({ dir });
  const reg = createExtRegistry({ dir, secrets, clientStore: store });
  const r = reg.install(src, { source: { repo: 'market' } });
  assert.equal(r.ok, true);
  assert.equal(r.tokenIssued, true);
  assert.ok(store.get('ext:bili'));
  assert.ok(secrets.read('bili').token);
  assert.equal(reg.remove('bili').ok, true);
  assert.equal(store.get('ext:bili'), null);
  assert.equal(secrets.read('bili'), null);
});
