/**
 * 收消息的 HTTP 服务。
 *
 * ai-chat 插件把消息 POST 到 `/inbound`，然后**等我们回调它**。
 * 所以这里必须：收到就立刻 200，不能等 AI 想完再回——
 * 它等的是 `/reply` 那个请求，不是这个响应。
 *
 * 为什么自己起 server 而不用 `ctx.webServer`：
 * DSH 面板端口是随机的，ai-chat 需要一个**固定地址**才找得到宿主。
 */

import { createServer } from 'node:http';

/** 只允许回调本机地址——防止 payload 里的 reply.url 被拿来当 SSRF 跳板 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 连接失败的 errno 翻成人话。
 *
 * 为什么要翻：`fetch` 抛出来的 `message` 永远只是 `fetch failed`，
 * 真正的原因藏在 `cause.code` 里。不翻的话模型只能瞎猜——实测它会
 * 告诉用户「网络没通，等会儿再试」，而真相通常是**对面那个端口没人听**
 * （插件面板地址配错、或者插件进程已经退了）。这两种情况的处置完全相反：
 * 一个是等，一个是去改配置。
 */
const CONNECT_ERR = {
  ECONNREFUSED: '那个端口没人监听',
  ECONNRESET: '连接被对面掐断',
  ETIMEDOUT: '连接超时',
  EHOSTUNREACH: '主机不可达',
  ENOTFOUND: '主机名解析不到',
  EAI_AGAIN: 'DNS 暂时查不到',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
};

/**
 * 把回复送回 ai-chat。
 *
 * @param {object} payload 收到的 inbound
 * @param {string} text 回复正文
 * @param {boolean} [done] false 表示「还有后续」
 */
export async function postReply(payload, text, done = true) {
  const url = payload?.reply?.url;
  const token = payload?.reply?.token;
  if (!url) throw new Error('payload 里没有回话地址');
  if (!token) throw new Error('payload 里没有回话令牌');

  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`回话地址不合法：${url}`);
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`回话地址不在本机（${u.hostname}），拒绝发送`);
  }

  /**
   * 只报 `host:port`，不报整条 URL。
   *
   * 地址是本机回环，本身不敏感；但路径里带着插件内部路由，
   * 这段话会原样进模型的工具结果、再被它复述给用户，越短越好。
   */
  const where = `${u.hostname}:${u.port || '80'}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: payload.id, token, text, done }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    /**
     * 超时不是「连不上」，得分开说：超时说明对面**接了**但不回
     * （插件卡住、或者它正忙着等另一个宿主），改配置没用。
     */
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`回话通道 ${where} 15 秒没响应（对面接了但不回，可能是插件卡住了）`);
    }
    const code = e?.cause?.code || e?.cause?.errno || e?.code || '';
    /**
     * `bad port` 是 fetch 规范自带的黑名单（1、7、9、25…），
     * 还没出门就拒了。这不是网络问题，是地址本身不能用。
     */
    const why = CONNECT_ERR[code] || (/bad port/i.test(e?.cause?.message || '') ? '端口被 fetch 规范禁用' : '');
    throw new Error(
      `回话通道连不上（${where}）${code ? `：${code}` : ''}${why ? `，${why}` : ''}。`
        + '多半是插件那边的「面板地址」填错了，或者插件进程已经退出',
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`回话被拒（HTTP ${res.status}）${detail ? `：${detail.slice(0, 120)}` : ''}`);
  }
  return true;
}

/**
 * 起服务。
 *
 * @param {object} p
 * @param {number} p.port
 * @param {string} [p.token] 共享密钥；空表示不校验
 * @param {(payload:object)=>void} p.onInbound 收到消息（不要 await，别拖住响应）
 * @param {(msg:string)=>void} [p.log]
 */
export function createInboundServer({ port, ports, token = '', onInbound, onListening, log = () => {} }) {
  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      } catch {}
    };

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return send(400, { ok: false, error: '地址不合法' });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return send(200, { ok: true, plugin: 'dsh-roost' });
    }

    if (url.pathname !== '/inbound' || req.method !== 'POST') {
      return send(404, { ok: false, error: '没有这个地址' });
    }

    // 鉴权：配了密钥就必须带对
    if (token) {
      const given = req.headers['x-roost-token'];
      if (given !== token) {
        log('inbound 鉴权失败：密钥不对');
        return send(401, { ok: false, error: '共享密钥不对' });
      }
    }

    // 读 body（限 1MB，正常消息远小于这个）
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1024 * 1024) {
          return send(413, { ok: false, error: '消息太大了' });
        }
      }
    } catch (e) {
      return send(400, { ok: false, error: `读请求失败：${e.message}` });
    }

    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return send(400, { ok: false, error: '不是合法 JSON' });
    }
    if (!payload?.id || !payload?.reply?.url) {
      return send(400, { ok: false, error: '缺 id 或 reply.url' });
    }

    // 先回 200，再去跑 AI——不能让 ai-chat 等
    send(200, { ok: true });
    try {
      onInbound(payload);
    } catch (e) {
      log(`处理 inbound 失败：${e?.message ?? e}`);
    }
  });

  /**
   * 端口被占就往后试下一个。
   *
   * 之前只试一个端口，被占就彻底没人听了——ai-chat 推过来全是 fetch failed，
   * 而面板只说「宿主没在听」，看不出原因。DSH 重载插件时旧 server 还占着端口，
   * 这个场景太常见了，必须能自己绕过去。
   *
   * `ports` 是候选列表（[want, want+1, ...]），`port` 是兼容旧调用的单端口写法。
   */
  const tries = (Array.isArray(ports) && ports.length ? ports : [port]).filter(Boolean);
  let idx = 0;
  let current = tries[0];

  server.lastError = '';
  server.actualPort = 0;

  const listenNext = () => {
    current = tries[idx];
    if (current == null) {
      server.lastError = `端口 ${tries[0]}–${tries[tries.length - 1]} 全被占了`;
      log(server.lastError);
      return;
    }
    server.listen(current, '127.0.0.1');
  };

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      server.lastError = `端口 ${current} 被占用`;
      log(`端口 ${current} 被占用，试下一个`);
      idx += 1;
      // listen 失败后 server 可以再 listen 一次
      setTimeout(listenNext, 0);
      return;
    }
    server.lastError = e.message || String(e);
    log(`服务出错：${e.message}`);
  });

  server.on('listening', () => {
    server.lastError = '';
    server.actualPort = current;
    log(
      `监听 127.0.0.1:${current}${token ? '（需要共享密钥）' : '（未设密钥，仅本机可访问）'}`
      + (current !== tries[0] ? `　← 配置里写的是 ${tries[0]}，那个被占了` : ''),
    );
    onListening?.(current);
  });

  listenNext();

  return {
    server,
    port,
    /** 实际 bind 成功的端口（可能和配置的不一样） */
    actualPort: () => server.actualPort,
    close() {
      try {
        server.close();
      } catch {}
    },
  };
}
