/**
 * roost 外接协议客户端（HTTP RPC + SSE）
 * ======================================
 *
 * 直连 roost 框架的 `roost-host/1` 协议，不再经过 ai-chat 中间层。
 *
 * ## 为什么是 HTTP + SSE，不是 WebSocket
 *
 * 协议里两种通道能力**完全一样**：同一套方法表、同一条事件流、同一个 seq
 * 补拉语义。这边选 HTTP 的理由：
 *
 *   · **零依赖**。dsh-roost 一直是 `dependencies: {}`，为一个通道引 `ws` 不值；
 *     Node 22 自带的 fetch 就能读 SSE。
 *   · QQ 消息是低频的（每秒几条已经算多），每次 RPC 一个 HTTP 请求完全够。
 *   · 断线补拉本来就是 SSE 的强项（`?since=`）。
 *
 * ## 重连与补拉
 *
 * 记住最后一个 `seq`，重连时带 `?since=`，服务端从环形缓冲补发。
 * 差太多时服务端发一条 `gap` 帧 —— **丢消息必须让上层知道**，不能静默续上，
 * 否则记忆和对话历史会悄悄缺一段，而且事后查不出来。
 *
 * ## token 放 header 不放 query
 *
 * 协议两种都认（`?access_token=` 与 `Authorization: Bearer`）。用 header 是
 * 因为 URL 会进反向代理日志、也会进我们自己的错误信息，而错误信息会被模型
 * 复述给用户。
 */

/** 重连退避。最后两档是「对面可能关了」的节奏，别 1 秒一次打一晚上 */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

/** RPC 默认超时。媒体上传类方法自己会传更长的值 */
const RPC_TIMEOUT_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * 探「我们真正要连的对端」还在不在。
 *
 * 连接循环以前问的是 `setup.isRunning()`——那是 Roost **面板**（15210）的
 * `/healthz`，只有 1.5 秒超时，还要先走一遍端口发现。可这条循环要连的其实是
 * **外接协议**（6807）。面板探活一旦慢/失败，哪怕 6807 好好的，客户端也会一直
 * 挂在 `waiting`，一条消息都收不到；而面板「测试连接」照样是绿的——它只打一次
 * `/rpc`，不订阅事件流。这种「全都显示正常但消息不进来」的状态最难排查。
 *
 * 所以先问外接协议自己的 `/health`：免 token、本机、就是最终要连的那个地址。
 * 不通才说明框架真没起来，调用方可以再退回去问面板，保留原来的 `waiting` 语义。
 *
 * @param {{url?:string, fetchImpl?:typeof fetch, timeoutMs?:number}} o
 * @returns {Promise<boolean>}
 */
export async function protocolAlive({ url = '', fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (!base) return false;
  try {
    const r = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return Boolean(r?.ok);
  } catch {
    return false;
  }
}

/**
 * 默认的 ws 加载器：**动态 import，装没装都不影响启动**。
 *
 * `ws` 是 `optionalDependencies`——npm 装失败也照常完成安装，
 * 所以这里必须把「模块不存在」当成正常情况，而不是错误。
 */
async function defaultLoadWs() {
  try {
    const m = await import('ws');
    return m?.WebSocket ?? m?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string|(()=>string)} o.baseUrl 例如 `http://127.0.0.1:6801`；传函数则每次现读
 * @param {string|(()=>string)} [o.token] 外接页里配的 token
 * @param {(data:object, frame:object)=>void} [o.onMessage]    message 事件
 * @param {(data:object, frame:object)=>void} [o.onNotice]     其他事件（入群、审核结果…）
 * @param {(frame:object)=>void} [o.onGap]                     补拉缺口
 * @param {(state:string, detail:string)=>void} [o.onState]    连接状态变化
 * @param {(m:string)=>void} [o.log]
 * @param {typeof fetch} [o.fetchImpl] 测试替换用
 * @param {'auto'|'sse'|'ws'} [o.transport] 事件通道；RPC 恒走 HTTP
 * @param {Function} [o.loadWs] 测试注入：返回 ws 模块（默认动态 import）
 */
export function createRoostHost({
  baseUrl = () => '',
  token = () => '',
  onMessage = () => {},
  onNotice = () => {},
  onGap = () => {},
  onState = () => {},
  log = () => {},
  fetchImpl = fetch,
  transport = 'auto',
  loadWs = defaultLoadWs,
  /** 降级后多久重试 WS；测试可压小，生产用默认 5 分钟 */
  wsRetryCooldownMs = 5 * 60_000,
  /**
   * 连之前先问一句「对端现在能连吗」。返回 false 就**不去撞**，
   * 状态挂 `waiting` 等它起来——框架没启动时反复 fetch 只会刷一屏
   * `fetch failed`，既不解决问题也看不出真原因。
   */
  canConnect = null,
  /** 对端没起来时多久问一次（默认 15 秒，够快又不吵） */
  waitPollMs = 15_000,
} = {}) {
  let seq = 0;
  let state = 'idle';
  /**
   * 实际在用哪条事件通道。
   * `auto` 下 WS 连不上会一次性降级成 SSE 并**记在这里**，避免每次重连都先撞一遍。
   */
  let activeTransport = '';
  /** ws 模块缓存：`undefined` 未试过、`null` 不可用、对象=可用 */
  let wsModule;
  /**
   * 降级到 SSE 后的**冷却截止时间**。
   *
   * 启动顺序经常是「插件先起、框架后起」，那一次 WS 必然失败。
   * 如果因此永久放弃 WS，用户明明装了 ws 也永远用不上——所以降级只维持
   * 一段时间，过了就在下次重连时再试一次 WS。
   */
  let wsRetryAt = 0;
  /** 冷却到点主动断开 SSE 用的定时器，以及「这次断开是为了重试」的标记 */
  let wsRetryTimer = null;
  let retryNow = false;
  /** 降级冷却：框架刚起来时端口可能还在绑，5 分钟足够它稳定 */
  const WS_RETRY_COOLDOWN_MS = Math.max(0, Number(wsRetryCooldownMs) || 0);
  let lastError = '';
  let ctrl = null;
  let running = false;
  let attempt = 0;
  let rpcSeq = 0;
  let welcome = null;
  let lastAt = 0;
  let frames = 0;
  /** 当前 WS 连接（stop 时要主动关，否则会挂着） */
  let wsClient = null;

  const base = () => String(typeof baseUrl === 'function' ? baseUrl() : baseUrl || '').replace(/\/+$/, '');
  const tok = () => String(typeof token === 'function' ? token() : token || '').trim();
  const authHeaders = () => (tok() ? { authorization: `Bearer ${tok()}` } : {});

  function setState(next, detail = '') {
    if (next === state && detail === lastError) return;
    state = next;
    lastError = detail;
    try {
      onState(next, detail);
    } catch (e) {
      log(`onState 回调抛错（已吞）：${e?.message ?? e}`);
    }
  }

  /**
   * 调一个方法。成功返回 `data`，失败抛带 `code` 的 Error。
   *
   * 协议的错误码原样带出来（`NO_SCOPE` / `NOT_READY` / `BAD_PARAMS`…），
   * 上层据此区分「权限没开」「机器人没连上」和「参数写错了」——
   * 这三种情况的处置完全不同，混成一句「调用失败」等于没报错。
   *
   * @param {string} method
   * @param {object} [params]
   * @param {{timeout?:number}} [opts]
   */
  async function rpc(method, params = {}, { timeout = RPC_TIMEOUT_MS } = {}) {
    const b = base();
    if (!b) throw Object.assign(new Error('还没配置 roost 外接地址'), { code: 'NO_ADDR' });
    const id = `c${++rpcSeq}`;
    let res;
    try {
      res = await fetchImpl(`${b}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id, method, params: params ?? {} }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      /**
       * 连接失败单独包一层。`fetch` 的 message 永远只是 `fetch failed`，
       * 真正原因在 `cause.code` 里，不翻的话排查只能靠猜。
       */
      const reason = e?.cause?.code || e?.name || '';
      const hint = reason === 'ECONNREFUSED' ? '（那个端口没人监听：外接协议没开，或端口填错了）' : '';
      throw Object.assign(new Error(`连不上 roost（${b}）${hint}`), { code: 'NETWORK', cause: e });
    }
    const body = await res.json().catch(() => null);
    if (!body) {
      throw Object.assign(new Error(`roost 没回 JSON（HTTP ${res.status}）`), {
        code: 'BAD_RESPONSE', http: res.status,
      });
    }
    if (body.ok === false) {
      const e = new Error(body?.error?.message || `HTTP ${res.status}`);
      e.code = body?.error?.code || '';
      e.http = res.status;
      throw e;
    }
    return body.data;
  }

  /** 解析一个 SSE 块：只认 `data:`，注释行（心跳保活）直接跳过 */
  function handleBlock(raw) {
    let data = '';
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('data:')) data += line.slice(5).trimStart();
    }
    if (!data) return;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      log('事件帧不是合法 JSON（已跳过）');
      return;
    }
    dispatch(frame);
  }

  /** WS 帧是裸 JSON（没有 `data:` 前缀），和 SSE 共用一个 dispatch */
  function handleJson(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return;
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      log('WS 帧不是合法 JSON（已跳过）');
      return;
    }
    dispatch(frame);
  }

  function dispatch(frame) {
    if (!frame || typeof frame !== 'object') return;
    frames += 1;
    lastAt = Date.now();
    /** seq 只增不减：补拉和实时推送会混在一起，取大的那个才不会倒退 */
    if (Number.isFinite(frame.seq) && frame.seq > seq) seq = frame.seq;

    if (frame.type === 'welcome') {
      welcome = frame;
      setState('online');
      return;
    }
    if (frame.type === 'heartbeat') return;
    if (frame.type === 'gap') {
      try {
        onGap(frame);
      } catch (e) {
        log(`onGap 回调抛错（已吞）：${e?.message ?? e}`);
      }
      return;
    }
    if (frame.type !== 'event') return;

    try {
      if (frame.event === 'message') onMessage(frame.data, frame);
      else onNotice(frame.data ?? { event: frame.event, data: frame.data }, frame);
    } catch (e) {
      /**
       * 单条事件处理失败**不能**把事件流带崩——那样后面所有消息都收不到了。
       * 记日志、继续读下一条。
       */
      log(`处理事件 ${frame.event} 出错（已吞）：${e?.message ?? e}`);
    }
  }

  /** 加载可选依赖 `ws`，结果缓存（`null` = 本进程内确认不可用） */
  async function ensureWs() {
    if (wsModule !== undefined) return wsModule;
    try {
      const m = await loadWs();
      const WS = m?.WebSocket ?? m ?? null;
      wsModule = WS ? { WebSocket: WS } : null;
      if (!wsModule) log('没装可选依赖 ws，事件流用 HTTP + SSE');
    } catch (e) {
      wsModule = null;
      log(`加载 ws 失败（改用 SSE）：${e?.message ?? e}`);
    }
    return wsModule;
  }

  /**
   * 用 WS 收事件。返回的 Promise 在**连接关闭时 resolve**、握手/鉴权失败时 reject。
   *
   * 心跳由 ws 库自动处理（服务端 ping，客户端自动 pong），这里不用手写。
   */
  async function pumpWs(WebSocket) {
    const b = base();
    /** http→ws、https→wss；`since` 带上才能补拉断线期间的事件 */
    const url = `${b.replace(/^http/i, 'ws')}/ws?since=${seq}`;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, arg) => {
        if (settled) return;
        settled = true;
        wsClient = null;
        fn(arg);
      };
      let ws;
      try {
        ws = new WebSocket(url, { headers: { ...authHeaders() } });
      } catch (e) {
        return done(reject, e);
      }
      wsClient = ws;
      ws.on('open', () => {
        attempt = 0;
        activeTransport = 'ws';
        wsRetryAt = 0;
        /**
         * 框架协议要求客户端连上后**先发 hello**（带 since）：服务端是在收到
         * hello/req 时才 `attach()` + `sinks.set()` + 回 welcome 的（见框架
         * `src/host/server.js` 的 `wss.on('connection')`）。
         *
         * 以前这里什么都不发，只把状态置成在线：TCP 连接确实建了，但服务端
         * 的订阅表里根本没有这个客户端 —— 于是一条事件都收不到、`/health`
         * 的 connections 恒为 0，而面板显示「已连接」、向导测试也绿。
         * SSE 分支是连上就注册，所以只有走 WS 时会静默失联。
         */
        try {
          ws.send(JSON.stringify({
            type: 'hello', protocol: 1, client: 'dsh-roost', since: seq,
          }));
        } catch (e) {
          log(`WS hello 发送失败：${e?.message ?? e}`);
        }
        setState('online');
      });
      ws.on('message', (data) => {
        try {
          handleJson(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
        } catch (e) {
          log(`处理 WS 帧出错（已吞）：${e?.message ?? e}`);
        }
      });
      /**
       * `unexpected-response` 是 ws 库对「握手被拒」的回调。
       * 401/403 要单独标出来，让上层停止重连而不是一直撞。
       */
      ws.on('unexpected-response', (_req, res) => {
        const status = Number(res?.statusCode) || 0;
        const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : 'HTTP';
        done(reject, Object.assign(new Error(`WS 事件流被拒（HTTP ${status}）`), { code, status }));
      });
      ws.on('error', (e) => done(reject, e));
      ws.on('close', () => done(resolve, undefined));
    });
  }

  async function readStream(stream) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          handleBlock(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 已经断了，取消失败无所谓 */
      }
    }
  }

  async function pump() {
    while (running) {
      const b = base();
      if (!b) {
        setState('error', '还没配置 roost 外接地址');
        await sleep(BACKOFF_MS.at(-1));
        continue;
      }

      /**
       * 对端没启动就别连。
       *
       * `waiting` 和 `error` 要分开：前者是「还没轮到它」，用户只要启动 Roost
       * 就会自己好；后者才是「连了但失败」，需要看原因。混成一句 `fetch failed`
       * 的话，用户会去查网络和端口，而真相只是框架没开。
       */
      if (typeof canConnect === 'function') {
        let ok = true;
        try {
          ok = await canConnect();
        } catch {
          /** 探活本身失败也当作「没就绪」，不要因此把状态打成 error */
          ok = false;
        }
        if (!ok) {
          setState('waiting', 'Roost 没在运行，等它启动后自动连');
          await sleep(waitPollMs);
          continue;
        }
      }

      /**
       * 先按配置决定用哪条事件通道。
       *
       * `auto` 下只要 WS 还没被证伪就优先 WS（延迟低、双向），
       * 一旦连不上就**本进程内改判 SSE**，不会每次重连都先撞一次。
       */
      const wsCooling = activeTransport === 'sse' && Date.now() < wsRetryAt;
      const wantWs = transport === 'ws' || (transport === 'auto' && !wsCooling);
      if (wantWs) {
        const mod = await ensureWs();
        if (mod?.WebSocket) {
          try {
            if (attempt === 0) setState(seq ? 'online' : 'connecting');
            await pumpWs(mod.WebSocket);
            if (!running) break;
            setState('reconnecting', 'WS 被服务端关闭');
          } catch (e) {
            if (!running) break;
            if (e?.code === 'UNAUTHORIZED') {
              setState('error', 'token 不对（外接页里复制的那串），已停止重连');
              running = false;
              break;
            }
            if (transport === 'auto') {
              wsRetryAt = Date.now() + WS_RETRY_COOLDOWN_MS;
              log(`WS 事件流暂时不可用（${e?.message ?? e}），先走 HTTP + SSE，`
                + `${Math.round(WS_RETRY_COOLDOWN_MS / 60_000)} 分钟后重试 WS`);
              activeTransport = 'sse';
              /**
               * SSE 稳定时不会自己重连，光有冷却时间永远等不到重试。
               * 到点主动断开一次，让 pump 重新判断通道——这是「装了就一定用上」的关键。
               */
              if (wsRetryTimer) clearTimeout(wsRetryTimer);
              wsRetryTimer = setTimeout(() => {
                if (!running || activeTransport !== 'sse') return;
                log('WS 冷却结束，断开 SSE 重试一次');
                retryNow = true;
                try { ctrl?.abort(); } catch { /* 已经断了 */ }
              }, WS_RETRY_COOLDOWN_MS);
              wsRetryTimer.unref?.();
            } else {
              setState('error', e?.message ?? String(e));
            }
          }
          /** 还在 WS 模式（或 ws 强制模式失败）→ 走退避，不往下走 SSE */
          if (activeTransport !== 'sse') {
            const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
            attempt += 1;
            await sleep(wait);
            continue;
          }
        } else if (transport === 'ws') {
          setState('error', '配置要求用 WS，但没装可选依赖 ws（npm i ws 或改成 auto）');
          running = false;
          break;
        }
      }

      try {
        if (attempt === 0) setState(seq ? 'online' : 'connecting');
        activeTransport = 'sse';
        ctrl = new AbortController();
        const res = await fetchImpl(`${b}/events?since=${seq}`, {
          headers: { accept: 'text/event-stream', ...authHeaders() },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const code = res.status === 401 || res.status === 403 ? 'UNAUTHORIZED' : 'HTTP';
          throw Object.assign(new Error(`事件流被拒（HTTP ${res.status}）`), { code });
        }
        attempt = 0;
        setState('online');
        await readStream(res.body);
        if (!running) break;
        setState('reconnecting', '事件流被服务端关闭');
      } catch (e) {
        if (!running) break;
        /**
         * 鉴权失败不重试：token 错了重连一万次也还是错，只会把日志刷满。
         * 明确停下来，让面板上「连接状态」显示真实原因。
         */
        if (e?.code === 'UNAUTHORIZED') {
          setState('error', 'token 不对（外接页里复制的那串），已停止重连');
          running = false;
          break;
        }
        if (e?.name === 'AbortError') {
          /** 主动断开是为了重试 WS：不算错误，直接进下一轮 */
          if (retryNow) {
            retryNow = false;
            continue;
          }
          break;
        }
        setState('error', e?.message ?? String(e));
      }
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      await sleep(wait);
    }
  }

  return {
    rpc,
    /** 开始收事件。重复调用无害 */
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      pump().catch((e) => setState('error', e?.message ?? String(e)));
    },
    stop() {
      running = false;
      try {
        ctrl?.abort();
      } catch {
        /* 没连上时 abort 一个未开始的控制器会抛，忽略 */
      }
      /** WS 也要主动关：只置 running=false 的话连接会挂到对端超时 */
      try {
        wsClient?.close?.();
      } catch {
        /* 已经断了 */
      }
      wsClient = null;
      if (wsRetryTimer) {
        clearTimeout(wsRetryTimer);
        wsRetryTimer = null;
      }
      retryNow = false;
      setState('stopped');
    },
    /** 手动改起点。面板「重连」和测试用；正常重连靠内部的 seq */
    resetSeq(n) {
      seq = Math.max(0, Number(n) || 0);
    },
    status() {
      return {
        state,
        seq,
        /** 实际在用的通道：`ws` / `sse`；还没连上时给配置意图 */
        transport: activeTransport || (transport === 'ws' ? 'ws' : 'sse'),
        /** 配置值，面板可显示「自动（当前 WS）」 */
        transportPref: transport,
        lastError,
        frames,
        lastAt,
        bot: welcome?.bot ?? null,
        methods: Array.isArray(welcome?.methods) ? welcome.methods.length : 0,
      };
    },
    get connected() {
      return state === 'online';
    },
  };
}
