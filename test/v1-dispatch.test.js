/**
 * 阶段 3.1 / 门 G3 的 `/inbound` 回归：真起一次 `createInboundServer`，
 * 验证 `/v1` 分发**早于** `auth()`，且既有 `/inbound` 与面板共享密钥一行未变。
 *
 * 跑法：node --test test/v1-dispatch.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createInboundServer } from '../src/server.js';
import { createApiV1 } from '../src/api-v1.js';
import { createClientStore } from '../src/ext-registry.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-v1-dispatch-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

const get = async (port, path, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (port, path, body, headers = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('G3-22 /v1 走在 auth() 之前；/inbound 与面板共享密钥原样回归', async (t) => {
  const dir = tmpHome(t);
  const store = createClientStore({ dir });
  const api = createApiV1({
    dir, clientStore: store, auditFn: () => {},
    hooks: { agent: async ({ key }) => ({ status: 200, body: { ok: true, key } }) },
  });
  const hash = createHash('sha256').update('abc').digest('hex');
  store.add({ id: 'panel-client', name: '测试客户端', hash, scopes: ['agent:write'], enabled: true });

  let inboundCalls = 0;
  const port = 23000 + Math.floor(Math.random() * 9000);
  const inst = createInboundServer({
    port,
    ports: [port, port + 1, port + 2],
    token: 'panel-secret',
    onInbound: () => { inboundCalls++; },
    onV1: (req, res, url, helpers) => api.handle(req, res, url, helpers),
    log: () => {},
  });
  t.after(() => { try { inst.server.close(); } catch { /* 已关 */ } });
  if (!inst.server.listening) {
    await new Promise((resolve, reject) => {
      inst.server.once('listening', resolve);
      inst.server.once('error', reject);
    });
  }
  const actual = inst.server.address().port;

  // ① /v1 不带面板 X-Roost-Token，只带 Bearer → 200，证明没被 auth() 挡。
  const ok = await get(actual, '/v1/whoami', { authorization: 'Bearer abc' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.id, 'panel-client');

  // ② /v1 缺 Bearer → 401（api-v1 自己鉴权），且没有误用面板密钥放行。
  const noAuth = await get(actual, '/v1/whoami', { 'x-roost-token': 'panel-secret' });
  assert.equal(noAuth.status, 401);

  // ②b 授权客户端经真实 HTTP 走到 agent hook（不直调 handleHook）。
  const agentNew = await post(actual, '/v1/agent.new', { clientId: 'game' }, { authorization: 'Bearer abc' });
  assert.equal(agentNew.status, 200, JSON.stringify(agentNew.body));
  assert.equal(agentNew.body.key, 'POST /v1/agent.new');
  // 低权客户端没有 agent:write，必须 403（最小授权不能被架空）。
  const weakHash = createHash('sha256').update('weak').digest('hex');
  store.add({ id: 'weak', name: '只读', hash: weakHash, scopes: ['state:read'], enabled: true });
  assert.equal((await post(actual, '/v1/agent.new', {}, { authorization: 'Bearer weak' })).status, 403);

  // ③ 既有 /inbound：缺面板密钥仍 401；带密钥 + 合法 payload 仍 200 且先回后跑。
  const payload = { id: 'msg-1', reply: { url: 'http://127.0.0.1:1/reply' } };
  assert.equal((await post(actual, '/inbound', payload)).status, 401);
  const inbound = await post(actual, '/inbound', payload, { 'x-roost-token': 'panel-secret' });
  assert.equal(inbound.status, 200);
  assert.equal(inbound.body.ok, true);
  assert.equal(inboundCalls, 1);

  // ④ /health 保持原样，不要求任何密钥。
  assert.equal((await get(actual, '/health')).body.plugin, 'dsh-roost');
});
