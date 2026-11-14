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

import {
  createApiV1, V1_ROUTES, V1_SCOPES, V1_IMPLEMENTED_HOOKS, V1_BUILTIN_ROUTES,
  V1_DESIGNED_OFF, isRouteImplemented, isRouteDesignedOff,
} from '../src/api-v1.js';
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

test('G3-2 403：scope 不足 / 扩展令牌调 /v1/say 仍被硬隔离', async (t) => {
  const f = fixture(t);
  assert.equal((await call(f.api, 'POST', '/v1/say', { token: f.issued.token })).status, 403);
  /**
   * 2026-11-14 起 `agent.*` 不再被 EXT_ONLY_DENY 一刀切挡下，改由
   * `agent:write` scope 把关。fixture 的默认 scopes 只有
   * `memory:write / state:read`，所以这里仍是 403 —— 但原因是缺 scope。
   */
  assert.equal((await call(f.api, 'POST', '/v1/agent.new', { token: f.issued.token })).status, 403);
  /**
   * 阶段 8 起扩展令牌默认带 `state:read`（读状态心情是安全能力），
   * 所以 `/v1/state` 不再被 403 拦；这里 501 是因为本测试的 fixture
   * 只传了部分 hook —— 真实宿主里是 200。关键断言是：**不是 403**。
   */
  const st = await call(f.api, 'GET', '/v1/state', { token: f.issued.token });
  assert.notEqual(st.status, 403, '默认 scope 含 state:read，不该再被拒');
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
  const strong = 'agent-client-token';
  f.store.add({ id: 'agent-client', name: '裁判客户端', hash: createHash('sha256').update(strong).digest('hex'), scopes: ['agent:write'], enabled: true });
  const api = createApiV1ForAgent(f);
  assert.equal((await call(api, 'POST', '/v1/agent.new', { token: strong, body: { clientId: 'game' } })).status, 200);

  /**
   * 2026-11-14 主人授权放宽的回归守门：扩展令牌只要显式拿到
   * `agent:write`，也要能开独立会话（bili 手动刷走的就是这条）。
   * 少了这条，以后有人把 EXT_ONLY_DENY 加回去会静默变回「点了没反应」。
   */
  const ext = f.store.get('ext:bili');
  f.store.add({ ...ext, scopes: [...(ext.scopes || []), 'agent:write'] });
  assert.equal(
    (await call(api, 'POST', '/v1/agent.new', { token: f.issued.token, body: { clientId: 'bili' } })).status,
    200,
    '拿到 agent:write 的扩展令牌必须能开独立会话',
  );

  /**
   * 全放开守门：以前 `/v1/say` 因为「是扩展令牌」被 EXT_ONLY_DENY 一刀切
   * 挡下，现在只要有 `say:write` 就该进 hook（fixture hooks 为空 → 501，
   * 关键是**不能是 403**）。防止以后有人把硬隔离加回来而没人发现。
   */
  const ext2 = f.store.get('ext:bili');
  f.store.add({ ...ext2, scopes: [...(ext2.scopes || []), 'say:write'] });
  const say = await call(f.api, 'POST', '/v1/say', { token: f.issued.token });
  assert.notEqual(say.status, 403, '扩展令牌不该再被身份硬隔离挡下');
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
  assert.equal(V1_SCOPES.length, 11, '§七 表格 9 个 + agent:write + core:write（2026-11-14 全放开）');
  assert.ok(V1_SCOPES.includes('core:write'), '最高等级能力要在 scope 表里才能被清单声明');
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
  // 默认 scope：写自己记忆 + 读状态（阶段 8 起的策略）
  assert.equal(f.store.get('ext:bili').scopes.join(), 'memory:write,state:read');
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

/**
 * 自查补的守卫：**文档说的「可用」必须等于真实行为**。
 *
 * 之前 `docs/API.md` 把 16 条端点写得一模一样，而实际只有 5 条能跑、10 条恒回
 * 501。第三方照着文档开发，写完才发现一半端点不通。这条断言把「未接线清单」
 * 钉成快照：接一条就少一条，测试会红，逼着同步文档与 `V1_IMPLEMENTED_HOOKS`。
 */
test('自查：未接线端点清单是硬快照（只剩设计上不开放的 session.configure）', () => {
  const notReady = Object.keys(V1_ROUTES).filter((k) => !isRouteImplemented(k)).sort();
  assert.deepEqual(notReady, [
    'POST /v1/session.configure',
  ], '接线一条就更新这份快照，并重跑 build-ext-docs');

  /**
   * 2026-11-14 全放开：不再有「设计上永久不开放」的端点。安全边界改由
   * 清单静态声明 + 安装时分级告知（ext-tier.js L0–L3）。
   * `session.configure` 仍留在 notReady 快照里，那只是「还没接线」，不是被封禁。
   */
  assert.deepEqual([...V1_DESIGNED_OFF], []);
  assert.equal(isRouteDesignedOff('POST /v1/session.configure'), false);

  // 已实现的 hook 必须真在路由表里被用到，不能是死名单
  for (const name of V1_IMPLEMENTED_HOOKS) {
    assert.ok(
      Object.values(V1_ROUTES).some((r) => r.hook === name),
      `V1_IMPLEMENTED_HOOKS 里的「${name}」没有任何路由在用`,
    );
  }
  // 内置路由不能靠 hook 蒙混
  for (const key of V1_BUILTIN_ROUTES) {
    assert.ok(key in V1_ROUTES, `V1_BUILTIN_ROUTES 里的「${key}」不在路由表`);
    assert.equal(V1_ROUTES[key].hook, null, `内置路由「${key}」不该声明 hook`);
  }
  // 每条未实现的路由都必须有 hook 名（否则是漏写了路由定义，不是「未接线」）
  for (const key of notReady) {
    assert.ok(V1_ROUTES[key].hook, `${key} 既没实现也没 hook 名，路由表定义不完整`);
  }
});

test('自查：声明已实现但没传 hook 时要有 warn（不静默降级成 501）', (t) => {
  const warns = [];
  createApiV1({
    dir: tmpHome(t),
    clientStore: null,
    auditFn: () => {},
    hooks: {}, // 一个都不传
    log: { warn: (m) => warns.push(m) },
  });
  for (const name of V1_IMPLEMENTED_HOOKS) {
    assert.ok(warns.some((w) => w.includes(name)), `缺 hook「${name}」没告警：${warns.join(' | ')}`);
  }
});
