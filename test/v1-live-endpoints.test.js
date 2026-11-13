/**
 * 端到端：真起 `createInboundServer`，把 16 条 `/v1` 端点全打一遍。
 *
 * 这条测试的目的是锁住**文档状态列 == 真实行为**：
 *   · 标 ✅ 的必须是 2xx（或 4xx = 参数/权限问题，不是「没实现」）；
 *   · 标 ⛔ / 🚫 的必须是 501。
 *
 * 上一轮就是这里出的问题：`API.md` 把 16 条写得一模一样，实际 10 条恒 501。
 *
 * 跑法：node --test test/v1-live-endpoints.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { createInboundServer } from '../src/server.js';
import {
  createApiV1, V1_ROUTES, V1_SCOPES, isRouteImplemented, isRouteDesignedOff,
} from '../src/api-v1.js';
import { createClientStore } from '../src/ext-registry.js';
import { createExtApiHooks } from '../src/ext-api-hooks.js';

function tmpHome() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-v1-live-'));
  return d;
}

test('全部端点：已实现的不是 501，未实现/不开放的才是 501', async (t) => {
  const dir = tmpHome();
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });

  const store = createClientStore({ dir });
  const token = 'live-endpoint-token-1234567890';
  store.add({
    id: 'probe', name: '探针',
    hash: createHash('sha256').update(token).digest('hex'),
    scopes: [...V1_SCOPES], enabled: true,
  });

  // 全套假依赖：这条测试验的是「接线 + 鉴权 + 状态码」，不是宿主内部逻辑。
  const hooks = createExtApiHooks({
    cfgOf: () => ({ speakUp: { enabled: false, chatId: 'u1' } }),
    moodOf: () => ({ valence: 0, energy: 0.5 }),
    moodTextOf: () => '平静',
    memoryOf: () => ({
      listRanked: () => ({ global: [], chat: [] }),
      add: () => true,
      hasAuthz: () => true,
    }),
    journalOf: () => ({ recent: () => [] }),
    aliasesOf: () => [],
    channelOf: () => ({ get: () => ({ send: async () => ({ ok: true, id: 'm1' }) }) }),
    speakUpOf: () => ({ state: () => ({}), fire: async () => ({ ok: true }) }),
    agentFor: async () => ({ agent: {} }),
    mount: () => {},
    onInbound: () => {},
    bucketOfFn: () => 'member',
    lastBucketOf: () => '',
    setupOf: () => ({ roostOwner: () => '', ownersConfigured: false }),
  });

  const api = createApiV1({
    dir, clientStore: store, auditFn: () => {},
    hooks: {
      // 真实宿主里这两个由 agentV1 / extMemory 提供，这里给占位
      agent: async () => ({ status: 200, body: { ok: true, sessions: [] } }),
      'memory.ext.add': async () => ({ status: 200, body: { ok: true } }),
      ...hooks,
    },
  });

  const port = 34000 + Math.floor(Math.random() * 2000);
  const inst = createInboundServer({
    port, ports: [port, port + 1, port + 2], token: '',
    onInbound: () => {}, onV1: (req, res, url, h) => api.handle(req, res, url, h), log: () => {},
  });
  t.after(() => { try { inst.server.close(); } catch { /* 已关 */ } });
  await new Promise((r) => { if (inst.server.listening) return r(); inst.server.once('listening', r); });
  const at = inst.actualPort();

  const rows = [];
  for (const [key] of Object.entries(V1_ROUTES)) {
    const [method, path] = key.split(' ');
    // GET 端点的参数只能走 query（没有 body），这也是被测行为的一部分
    const qs = method === 'GET' ? '?chatId=g1' : '';
    const res = await fetch(`http://127.0.0.1:${at}${path}${qs}`, {
      method,
      headers: method === 'POST'
        ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
        : { authorization: `Bearer ${token}` },
      body: method === 'POST' ? JSON.stringify({ chatId: 'g1', target: 'g1', text: '你好', fact: '哦' }) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    rows.push({ key, status: res.status, error: body.error ?? '' });
  }

  const not501 = rows.filter((r) => r.status !== 501);
  const only501 = rows.filter((r) => r.status === 501);

  // 1) 已实现的端点一条都不许是 501
  for (const key of Object.keys(V1_ROUTES).filter((k) => isRouteImplemented(k))) {
    const hit = rows.find((r) => r.key === key);
    assert.notEqual(hit.status, 501, `${key} 文档说可用，实际 501`);
  }

  // 2) 未实现 / 设计不开放的必须恰好是 501
  const expect501 = Object.keys(V1_ROUTES)
    .filter((k) => !isRouteImplemented(k))
    .sort();
  assert.deepEqual(only501.map((r) => r.key).sort(), expect501, '501 的端点集合与实现状态不一致');

  // 3) 设计不开放的单独确认一次（避免将来被顺手实现又忘了改文档）
  for (const key of Object.keys(V1_ROUTES).filter((k) => isRouteDesignedOff(k))) {
    const hit = rows.find((r) => r.key === key);
    assert.equal(hit.status, 501, `${key} 声明为「设计不开放」，不该有实现`);
  }

  // 4) 只读端点必须真的回 200（不是 4xx 蒙混过关）
  for (const key of ['GET /v1/state', 'GET /v1/mood', 'GET /v1/context', 'GET /v1/memory']) {
    const hit = rows.find((r) => r.key === key);
    assert.equal(hit.status, 200, `${key} 应是 200，实际 ${hit.status} ${hit.error}`);
  }

  /**
   * 不写死数字：端点会一直加，写死「15」的结果就是每加一条端点都要改一次
   * 测试（而且改的人往往只是把数字 +1，并没有真的验过）。
   * 判据改成「非 501 的数量 === 声明已实现的数量」，加端点自动跟上。
   */
  const implemented = Object.keys(V1_ROUTES).filter((k) => isRouteImplemented(k)).length;
  assert.equal(not501.length, implemented, `非 501 的端点数应等于已实现数 ${implemented}，实际 ${not501.length}`);
});
