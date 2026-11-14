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
  // 最小授权架空（独立会话还不受 quota / 能力页拦截）。这里补一个专用 scope。
  //
  // 6.x 起它**可以发给扩展**（面板装扩展时勾选）：`llm.vision` 也用它——
  // 都是「让模型跑一次，消耗你的额度」。边界由端点自己收窄：
  // agent.* 只开不带工具的干净会话，llm.vision 只把一批图换一段文字。
  'agent:write',
];

/** 这些数字导出给 `ext-docs.js` 生成文档：改常量文档就跟着变，`--check` 会抓到没重跑。 */
export const WINDOW_MS = 60_000;
export const RATE_LIMIT = 120;
export const IDEMPOTENT_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENT_MAX = 500;
/** 请求体上限（字节）。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 路由表。key 是 `METHOD /v1/xxx`；`scope:null` 表示只要令牌有效。
 * `agent.*` 四条单独走 `hooks.agent`（SSE 要自己写响应）。
 */
export const V1_ROUTES = {
  'GET /v1/whoami': { scope: null, hook: null },
  'POST /v1/message': { scope: 'message:write', hook: 'message' },
  /**
   * 扩展**直接往会话发东西**：文本 / 文件 / 官方图文卡片，不跑模型。
   *
   * 为什么不复用 `/v1/message`：那条是「把一句话送进入站链路、跑完一轮模型」，
   * 文件是这一轮的副产品；而扩展画完图、刷完 B 站要的是「把这张图/这张卡片
   * 直接发出去」，不该为此再跑一轮对话（费钱、还可能被模型改写成别的话）。
   *
   * 也不复用 `/v1/say`：那个只能发文本，加 `files` / `card` 会让「说一句话」
   * 这个语义变得含糊——发卡片时正文是空的，叫「say」名不副实。
   *
   * scope 复用 `message:write` 而不新开：它做的还是「往会话里送东西」，
   * 新开 scope 只会让已装的扩展重新走一遍敏感授权确认，收益为零。
   */
  'POST /v1/send': { scope: 'message:write', hook: 'send' },
  'POST /v1/say': { scope: 'say:write', hook: 'say' },
  'GET /v1/state': { scope: 'state:read', hook: 'state' },
  'GET /v1/mood': { scope: 'state:read', hook: 'mood' },
  'GET /v1/context': { scope: 'context:read', hook: 'context' },
  'GET /v1/memory': { scope: 'memory:read', hook: 'memory.read' },
  'POST /v1/memory': { scope: 'memory:write', hook: 'memory.write' },
  'POST /v1/memory/ext.add': { scope: 'memory:write', hook: 'memory.ext.add' },
  'POST /v1/proactive': { scope: 'proactive:write', hook: 'proactive' },
  /**
   * 扩展投递一条**素材**，由宿主排队、过门闸、让模型组织语言后主动发出。
   * 不新开 scope：`proactive:write` 本来就是「主动开口」的敏感权限，装扩展时
   * 主人已经确认过；再开一个只会让所有存量扩展重新走一遍授权，收益为零。
   */
  'POST /v1/proactive/submit': { scope: 'proactive:write', hook: 'proactive.submit' },
  /**
   * 扩展页面按钮的动作队列。
   *
   * 复用 `state:read`：读动作不改变任何宿主状态，真正做事的是扩展自己；
   * 新开 scope 会让所有存量扩展重走一遍授权，收益为零（与 proactive 同理）。
   */
  'GET /v1/ext-ui/actions': { scope: 'state:read', hook: 'ext-ui.actions' },
  'POST /v1/session.ensure': { scope: 'session:write', hook: 'session.ensure' },
  'POST /v1/session.configure': { scope: 'prompt:write', hook: 'session.configure' },
  'POST /v1/agent.new': { scope: 'agent:write', hook: 'agent' },
  'POST /v1/agent.prompt': { scope: 'agent:write', hook: 'agent' },
  'POST /v1/agent.close': { scope: 'agent:write', hook: 'agent' },
  /**
   * 看一眼外部图片（扩展抽的视频帧）换一段文字。
   *
   * scope 复用 `agent:write`：对用户来说都是「让模型干活、烧额度」，
   * 新开一个 scope 只会让已装的扩展多一次敏感授权确认，收益为零。
   */
  'POST /v1/llm.vision': { scope: 'agent:write', hook: 'llm.vision' },
  'GET /v1/agent.list': { scope: 'agent:write', hook: 'agent' },
};

/**
 * **已接线**的 hook 名单。
 *
 * 这份常量有两个用途，缺一个就会漂：
 *  1. `ext-docs.js` 按它给端点表标「可用 / 501 未接线」——没有这一列，文档
 *     会把 10 条恒 501 的端点写得和可用端点一模一样，第三方照着做必然踩空；
 *  2. `createApiV1()` 启动时按它反查 `hooks` 实参，声明实现了却没传实现就 warn。
 *
 * ⚠️ 加 hook 时**三处一起改**：`V1_ROUTES`、这里的名单、`host.js` 的 `hooks`，
 * 并同步 `test/api-v1.test.js` 的 501 清单快照 —— 漏一处测试会红。
 */
export const V1_IMPLEMENTED_HOOKS = Object.freeze([
  'agent', 'memory.ext.add', 'llm.vision',
  'message', 'send', 'say', 'state', 'mood', 'context',
  'memory.read', 'memory.write', 'proactive', 'proactive.submit', 'session.ensure',
  'ext-ui.actions',
]);

/**
 * **设计上不开放**给扩展的端点（不是「还没做」）。
 *
 * `session.configure` 能改人格与模型 —— 等于让扩展改机器人的行为方式。
 * 收益（扩展替用户省一次点击）与风险（人格被改写、模型被换掉）不成比例，
 * 所以明确不开放，面板与文档都按「设计不开放」展示，避免被当成待办。
 */
export const V1_DESIGNED_OFF = Object.freeze(['POST /v1/session.configure']);

/** 不依赖 hook、在 `handle()` 里内联实现的端点。 */
export const V1_BUILTIN_ROUTES = Object.freeze(['GET /v1/whoami']);

/** 这条路由现在会不会真的执行业务（false = 恒回 501）。 */
export function isRouteImplemented(key) {
  const route = V1_ROUTES[key];
  if (!route) return false;
  if (V1_BUILTIN_ROUTES.includes(key)) return true;
  return Boolean(route.hook) && V1_IMPLEMENTED_HOOKS.includes(route.hook);
}

/** 这条路由是「设计上不开放」，而不是「尚未实现」。 */
export function isRouteDesignedOff(key) {
  return V1_DESIGNED_OFF.includes(key);
}

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

  /**
   * 声明与实参对账：`V1_IMPLEMENTED_HOOKS` 是对外承诺（文档按它标「可用」），
   * 实参才是真行为。声明了却没传 → 文档说能用、实际 501，这类偏差最难查。
   * 反过来多传不算错（可能在做灰度），但也不许悄悄少传。
   */
  for (const name of V1_IMPLEMENTED_HOOKS) {
    if (typeof hooks[name] !== 'function') {
      log.warn?.(`/v1 声明已实现 hook「${name}」但没有传入实现，相关端点会回 501`);
    }
  }

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
      const parsed = await readJson(MAX_BODY_BYTES);
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
      /**
       * `query` 必须一起交给 hook：`GET /v1/context?chatId=g1` 这类端点没有
       * body，只传 `body` 会让它们永远判「缺 chatId」回 400 —— 而且错得很像
       * 「参数没写对」，实际是实现漏了一层。
       */
      const query = Object.fromEntries(url.searchParams ?? []);
      // `agent.prompt` 是 SSE：hook 自己写响应头与流，本模块不 send JSON。
      const out = await hook({ key, pathname, method: req.method, body: payload, query, client, req, res, send });
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
