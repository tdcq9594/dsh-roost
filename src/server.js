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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: payload.id, token, text, done }),
    signal: AbortSignal.timeout(15000),
  });

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
export function createInboundServer({ port, token = '', onInbound, log = () => {} }) {
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
   * 把最后一次错误挂在 server 上。
   *
   * 光打日志不够——面板只说「宿主没在听」，用户不知道是端口被占还是别的原因。
   * 记下来，/status 带出去，概览直接显示。
   */
  server.lastError = '';
  server.on('error', (e) => {
    server.lastError = e.code === 'EADDRINUSE' ? `端口 ${port} 被占用` : (e.message || String(e));
    if (e.code === 'EADDRINUSE') {
      log(`端口 ${port} 被占用了。改 config.json 里的 server.port，或关掉占用它的程序`);
    } else {
      log(`服务出错：${e.message}`);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    server.lastError = '';
    log(`监听 127.0.0.1:${port}${token ? '（需要共享密钥）' : '（未设密钥，仅本机可访问）'}`);
  });

  return {
    server,
    port,
    close() {
      try {
        server.close();
      } catch {}
    },
  };
}
