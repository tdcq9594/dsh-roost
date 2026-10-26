// Roost 客户端：订阅消息事件 + 调官方能力。
//
// 两条通道（对应 Roost v0.8 计划里的 P1）：
//   ① GET  /api/stream?key=…      SSE，推 `message` 事件
//   ② POST /api/qq/call           { bot, method, args } → 任意官方接口
//      GET  /api/qq/capabilities   能力清单（哪些方法能调）
//
// 为什么要 `/api/qq/call` 这种通用通道而不是每个接口一条路由：
// Roost 已经封装了官方 47 个接口（src/endpoints.js），
// 一个个映射成 REST 既维护不动，也会漏掉以后新增的。
// 通用通道 + 白名单，官方加接口时 Roost 那边加一行、这边立刻能调。
//
// 本文件不依赖 DSH，可单独跑（`node src/roost.js` 自测连通性）。

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30000;

export class RoostClient {
  /**
   * @param {object} p
   * @param {string} p.baseUrl      如 http://127.0.0.1:8080
   * @param {string} [p.accessKey]  面板访问密钥（webui.accessKey）
   * @param {string} [p.bot]        多机器人时指定看哪个，空=全部
   * @param {(msg:object)=>void} [p.onMessage]
   * @param {(ev:string,data:any)=>void} [p.onEvent]  其它事件（hello/log/status）
   * @param {(err:Error)=>void} [p.onError]
   */
  constructor({ baseUrl, accessKey = '', bot = '', onMessage, onEvent, onError }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.accessKey = accessKey;
    this.bot = bot;
    this.onMessage = onMessage;
    this.onEvent = onEvent;
    this.onError = onError;

    this.abort = null;
    this.retry = RECONNECT_MIN;
    this.stopped = false;
    this.connected = false;
    this.caps = null;
  }

  /** 鉴权查询串。EventSource 传不了 header，所以统一用 ?key= */
  #qs(extra = {}) {
    const q = new URLSearchParams(extra);
    if (this.accessKey) q.set('key', this.accessKey);
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  /* ---------------- ① 事件下行 ---------------- */

  start() {
    if (this.stopped) return;
    this.#loop().catch((e) => this.onError?.(e));
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    this.connected = false;
  }

  async #loop() {
    while (!this.stopped) {
      try {
        await this.#once();
        // 正常结束（服务端重启）也要重连
        this.retry = RECONNECT_MIN;
      } catch (e) {
        this.connected = false;
        if (this.stopped) return;
        this.onError?.(e);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.retry));
      this.retry = Math.min(this.retry * 2, RECONNECT_MAX);
    }
  }

  /** 连一次，读到断为止 */
  async #once() {
    this.abort = new AbortController();
    const res = await fetch(`${this.baseUrl}/api/stream${this.#qs()}`, {
      signal: this.abort.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!res.ok) throw new Error(`连 Roost 面板失败：HTTP ${res.status}`);
    if (!res.body) throw new Error('Roost 面板没有返回事件流');

    this.connected = true;
    this.retry = RECONNECT_MIN;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE：空行分隔一条消息
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.#dispatch(raw);
      }
    }
    this.connected = false;
  }

  #dispatch(raw) {
    let event = 'message';
    const data = [];
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;

    let payload;
    try {
      payload = JSON.parse(data.join('\n'));
    } catch {
      return; // 非 JSON 的日志行，忽略
    }

    if (event === 'message') {
      // 多机器人时只关心配的那个
      if (this.bot && payload.botId && payload.botId !== this.bot) return;
      this.onMessage?.(payload);
    } else {
      this.onEvent?.(event, payload);
    }
  }

  /* ---------------- ② 能力上行 ---------------- */

  /**
   * 调一个官方接口。
   *
   * @param {string} method QQApi 上的方法名，如 'sendGroup'、'createPanel'
   * @param {object} args   原样透传（驼峰字段，跟 QQApi 一致）
   * @param {object} [opts] { bot, confirm } 危险操作要 confirm:true
   * @returns {Promise<any>} 官方返回的原始 JSON
   */
  async call(method, args = {}, opts = {}) {
    const body = { method, args, bot: opts.bot || this.bot || undefined };
    if (opts.confirm) body.confirm = true;

    const res = await fetch(`${this.baseUrl}/api/qq/call${this.#qs()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });

    const text = await res.text();
    let j = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Roost 返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
    }

    if (!res.ok || j?.ok === false) {
      const err = new Error(j?.error || `调用 ${method} 失败：HTTP ${res.status}`);
      err.code = j?.code;
      err.status = res.status;
      throw err;
    }
    return j?.result ?? j;
  }

  /** 能力清单。AI 想知道「官方还有什么能调」时查它。 */
  async capabilities() {
    if (this.caps) return this.caps;
    const res = await fetch(`${this.baseUrl}/api/qq/capabilities${this.#qs()}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`取能力清单失败：HTTP ${res.status}`);
    this.caps = await res.json();
    return this.caps;
  }
}

/* ---------------- 直接跑这个文件时：自测连通性 ---------------- */

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const baseUrl = process.env.ROOST_URL || 'http://127.0.0.1:8080';
  const accessKey = process.env.ROOST_KEY || '';
  const c = new RoostClient({
    baseUrl,
    accessKey,
    onMessage: (m) => console.log('[message]', m.chatId, m.userName, m.content),
    onEvent: (e, d) => console.log(`[${e}]`, JSON.stringify(d).slice(0, 120)),
    onError: (e) => console.error('[err]', e.message),
  });
  c.start();
  c.capabilities()
    .then((caps) => console.log(`能力清单：${Array.isArray(caps) ? caps.length : '?'} 条`))
    .catch((e) => console.error('[caps]', e.message));
  console.log(`连 ${baseUrl} … Ctrl+C 退出`);
}
