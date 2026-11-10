/**
 * `/v1` 控制面：鉴权 + 路由骨架（方案 §七 / 实施阶段 3.1）。
 *
 * ⚠️ **不复用 `server.js:169` 的 `auth()`**：那道是面板共享密钥（X-Roost-Token），
 * 扩展拿的是 Bearer 客户端令牌。两种身份、两种授权面，混在一起等于给扩展
 * 发了一把能开面板的钥匙。本模块由 `createInboundServer` 在 `/v1/` 前缀上
 * **早于** `auth()` 分发，因此 `/inbound` 与面板 API 的鉴权完全不受影响。
 *
 * 只做骨架：11 条端点的**业务实现**由 `hooks` 注入（3.3 / 阶段 4 / 面板），
 * 本模块负责 401 / 403 / 429 / 幂等 / 审计 / scope 硬隔离，未提供 hook 时
 * 明确返回 501 而不是假装成功。
 *
 * 零外部依赖；`dir` / `now` / `auditFn` / `clientStore` 均可注入，测试不碰真实家目录。
 */

import { audit as auditDefault } from './audit.js';
import { createClientStore } from './ext-registry.js';

/** §七 端点表实际列出的 scope（文字写「7 个」，表格是 9 个，按表格为准）。 */
export const V1_SCOPES = [
  'message:write', 'say:write', 'state:read', 'context:read',
  'memory:read', 'memory:write', 'proactive:write', 'session:write', 'prompt:write',
  // §7 表格没给 agent.* 定 scope，但「只要令牌有效就能开独立会话」会把
  // 最小授权架空（独立会话还不受 quota / 能力页拦截）。这里补一个专用 scope，
  // 由阶段 5.2 面板发放客户端令牌时授予；扩展令牌一律拿不到。
  'agent:write',
];

const WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const IDEMPOTENT_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENT_MAX = 500;

/**
 * 路由表。key 是 `METHOD /v1/xxx`；`scope:null` 表示只要令牌有效。
 * `agent.*` 四条单独走 `hooks.agent`（SSE 要自己写响应）。
 */
export const V1_ROUTES = {
  'GET /v1/whoami': { scope: null, hook: null },
  'POST /v1/message': { scope: 'message:write', hook: 'message' },
  'POST /v1/say': { scope: 'say:write', hook: 'say' },
  'GET /v1/state': { scope: 'state:read', hook: 'state' },
  'GET /v1/mood': { scope: 'state:read', hook: 'mood' },
  'GET /v1/context': { scope: 'context:read', hook: 'context' },
  'GET /v1/memory': { scope: 'memory:read', hook: 'memory.read' },
  'POST /v1/memory': { scope: 'memory:write', hook: 'memory.write' },
  'POST /v1/memory/ext.add': { scope: 'memory:write', hook: 'memory.ext.add' },
  'POST /v1/proactive': { scope: 'proactive:write', hook: 'proactive' },
  'POST /v1/session.ensure': { scope: 'session:write', hook: 'session.ensure' },
  'POST /v1/session.configure': { scope: 'prompt:write', hook: 'session.configure' },
  'POST /v1/agent.new': { scope: 'agent:write', hook: 'agent' },
  'POST /v1/agent.prompt': { scope: 'agent:write', hook: 'agent' },
  'POST /v1/agent.close': { scope: 'agent:write', hook: 'agent' },
  'GET /v1/agent.list': { scope: 'agent:write', hook: 'agent' },
};

/** `agent.*` 不能被扩展令牌调用：scope 硬隔离（§5.4）。 */
const EXT_ONLY_DENY = new Set([
  'POST /v1/agent.new', 'POST /v1/agent.prompt',
  'POST /v1/agent.close', 'GET /v1/agent.list', 'POST /v1/say',
]);

function bearerOf(req) {
  const raw = req?.headers?.authorization;
  if (typeof raw !== 'string') return '';
  const m = /^Bearer\s+([^\s]+)$/i.exec(raw.trim());
  return m ? m[1] : '';
}

export function createApiV1({
  dir,
  log = () => {},
  hooks = {},
  auditFn = auditDefault,
  clientStore = null,
  now = () => Date.now(),
  /** 阶段 5 诊断页：接入层的拒绝事件；不传就是空操作，既有调用方零影响。 */
  onReject = () => {},
} = {}) {
  const store = clientStore ?? createClientStore({ dir });
  const hits = new Map();      // clientId -> number[]（滑动窗口时间戳）
  const seen = new Map();      // `${clientId}:${requestId}` -> {status, body, at}

  const note = (op, result) => {
    try { auditFn({ op: `v1.${op}`, note: String(result).slice(0, 40) }); } catch { /* 审计不能拖垮请求 */ }
  };

  /** 诊断页是旁路：记不上也不能让鉴权结果变形。 */
  const reject = (entry) => {
    try { onReject({ layer: 'fence', ...entry }); } catch { /* 旁路 */ }
  };

  function rateOk(clientId, t) {
    const arr = (hits.get(clientId) ?? []).filter((x) => t - x < WINDOW_MS);
    if (arr.length >= RATE_LIMIT) { hits.set(clientId, arr); return false; }
    arr.push(t);
    hits.set(clientId, arr);
    return true;
  }

  function cacheGet(key, t) {
    const row = seen.get(key);
    if (!row) return null;
    if (t - row.at > IDEMPOTENT_TTL_MS) { seen.delete(key); return null; }
    // LRU：命中后挪到队尾
    seen.delete(key);
    seen.set(key, row);
    return row;
  }

  function cachePut(key, status, body, t) {
    seen.set(key, { status, body, at: t });
    while (seen.size > IDEMPOTENT_MAX) seen.delete(seen.keys().next().value);
  }

  /**
   * 分发入口。`helpers.send(code, body)` 与 `helpers.readJson(limit)` 由
   * `createInboundServer` 提供，保证响应头 / body 大小限制与既有端点一致。
   */
  async function handle(req, res, url, helpers = {}) {
    const { send, readJson } = helpers;
    const pathname = url?.pathname ?? new URL(req.url, 'http://127.0.0.1').pathname;
    const key = `${req.method} ${pathname}`;
    const route = V1_ROUTES[key];
    const t = now();

    if (!route) return send(404, { ok: false, error: 'not_found', message: '没有这个 /v1 端点' });

    const token = bearerOf(req);
    const client = token ? store.verify(token) : null;
    if (!client || client.enabled === false) {
      // 缺值 / 失效：不是静默失联，审计里留一条，面板据此显示「扩展鉴权失败」。
      note('auth_failed', key);
      try { auditFn({ op: 'ext.auth_failed', note: key.slice(0, 40) }); } catch { /* 同上 */ }
      reject({ tool: key, bucket: 'unknown', rule: 'Bearer 令牌无效或已吊销（401）' });
      return send(401, { ok: false, error: 'unauthorized', message: '客户端令牌无效或已吊销' });
    }
    if (client.extId && EXT_ONLY_DENY.has(key)) {
      note('forbidden', key);
      reject({ tool: key, bucket: 'ext', rule: `扩展令牌被 EXT_ONLY_DENY 挡下（403）：${key}` });
      return send(403, { ok: false, error: 'forbidden', message: '扩展令牌不能调用该端点' });
    }
    if (route.scope && !client.scopes?.includes(route.scope)) {
      note('forbidden', key);
      reject({ tool: key, bucket: client.id, rule: `缺少 scope：${route.scope}（403）` });
      return send(403, { ok: false, error: 'forbidden', message: `缺少 scope：${route.scope}` });
    }
    let body = {};
    if (req.method === 'POST') {
      const parsed = await readJson(1024 * 1024);
      if (parsed?.error === 'too_large') return send(413, { ok: false, error: 'request_too_large' });
      if (parsed?.error) return send(400, { ok: false, error: 'invalid_json' });
      body = parsed?.value ?? {};
    }

    const requestId = typeof body.requestId === 'string' && body.requestId
      ? body.requestId
      : (typeof req.headers?.['x-request-id'] === 'string' ? req.headers['x-request-id'] : '');
    const idemKey = requestId ? `${client.id}:${requestId}` : '';
    // 幂等短路排在限频之前：重复投递不该再占一次 120/min 配额。
    if (idemKey) {
      const cached = cacheGet(idemKey, t);
      if (cached) {
        note('idempotent_hit', key);
        return send(cached.status, cached.body);
      }
    }

    if (!rateOk(client.id, t)) {
      note('rate_limited', key);
      reject({ tool: key, bucket: client.id, rule: '每客户端每分钟 120 次（429）' });
      if (res?.setHeader) res.setHeader('retry-after', '60');
      return send(429, { ok: false, error: 'rate_limited', message: '每客户端每分钟 120 次' });
    }

    // `/v1/whoami` 是唯一不需要 hook 的端点，且绝不回显 hash / 明文。
    if (key === 'GET /v1/whoami') {
      const out = { ok: true, id: client.id, name: client.name ?? '', scopes: client.scopes ?? [], extId: client.extId ?? null };
      if (idemKey) cachePut(idemKey, 200, out, t);
      note('whoami', 'ok');
      return send(200, out);
    }

    const hook = hooks[route.hook];
    if (typeof hook !== 'function') {
      note('not_implemented', key);
      return send(501, { ok: false, error: 'not_implemented', message: '该端点业务实现尚未接线' });
    }

    // 来源不可自报（§5.4 F9）：extId 一律从令牌记录读，body 传了忽略并记 warn。
    let payload = body;
    if (key === 'POST /v1/memory/ext.add') {
      if (Object.hasOwn(body, 'extId')) log.warn?.('extId 由令牌绑定，忽略请求体里的 extId');
      payload = { ...body, extId: client.extId ?? null };
      if (!payload.extId) return send(403, { ok: false, error: 'forbidden', message: '该客户端未绑定扩展' });
    }

    try {
      // `agent.prompt` 是 SSE：hook 自己写响应头与流，本模块不 send JSON。
      const out = await hook({ key, pathname, method: req.method, body: payload, client, req, res, send });
      if (res?.writableEnded || res?.headersSent) return;
      const status = Number(out?.status) || 200;
      const data = out?.body ?? { ok: true };
      if (idemKey) cachePut(idemKey, status, data, t);
      note(key.replace(/[^\w./-]/g, '').slice(5), status === 200 ? 'ok' : `status_${status}`);
      return send(status, data);
    } catch (e) {
      note('handler_error', key);
      log.warn?.(`/v1 ${key} 处理失败：${e?.message ?? e}`);
      return send(500, { ok: false, error: 'handler_error', message: String(e?.message ?? e).slice(0, 200) });
    }
  }

  return {
    handle,
    store,
    routes: V1_ROUTES,
    stats: () => ({ rateEntries: hits.size, idempotentEntries: seen.size }),
  };
}
