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
export async function postReply(payload, text, done = true, extra = {}) {
  const url = payload?.reply?.url;
  const token = payload?.reply?.token;

  /**
   * 没有回话地址时的回退：`/v1/message` 投递的消息来自扩展，它没有 ai-chat 的
   * 回话窗口（`payload.reply` 是空的），但**回复仍要送回同一个 target**。
   * 调用方在 payload 里放一个 `__channel.send(text)`，这里转交给它。
   *
   * 这个分支只在该函数存在时生效，正常入站（有 `reply.url`）一行都不变。
   * 也刻意**不接受**外部传 URL —— `reply.url` 是 HTTP 地址，外部可控就是 SSRF 面。
   */
  if (!url) {
    const send = payload?.__channel?.send;
    /**
     * `extra` 一起转交：`extra.requestId` 是框架投递账本的幂等键，丢了这条回复
     * 就查不到终态（`/r/delivery` 永远空）。`done` 不传 —— 扩展的回复是一次性投递。
     */
    if (typeof send === 'function') return await send(String(text ?? ''), extra);
    throw new Error('payload 里没有回话地址');
  }
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
      body: JSON.stringify({
        id: payload.id,
        token,
        text,
        done,
        /**
         * 投递账本的幂等键（阶段 5）。框架拿它做「同一条不重复发」。
         * 空串不传——没有 id 时行为完全不变。
         */
        ...(extra?.requestId ? { requestId: String(extra.requestId) } : {}),
        /**
         * 要发出去的文件（绝对路径）。
         *
         * **跟 `text` 分开走**：这里只把路径交给 ai-chat 攒着，真正的上传和
         * 发送由它在**这一轮结束后**做（那时它手上还有 `msg` 对象，能走被动
         * 回复带 `msg_id`，不消耗主动额度）。所以这一段请求仍然很快，
         * 不会被几 MB 的上传拖到 15 秒超时。
         *
         * 空数组不传——保持报文和老版本完全一致。
         */
        ...(Array.isArray(extra?.files) && extra.files.length
          ? { files: extra.files.map(String).filter(Boolean) }
          : {}),
      }),
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
export function createInboundServer({
  port, ports, token = '', onInbound, onTts, onTtsStatus, onListening, onV1, log = () => {},
}) {
  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      try {
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(JSON.stringify(body));
      } catch {}
    };

    const readJson = async (limit) => {
      const chunks = [];
      let bytes = 0;
      try {
        for await (const chunk of req) {
          const b = Buffer.from(chunk);
          bytes += b.length;
          if (bytes > limit) return { error: 'too_large' };
          chunks.push(b);
        }
      } catch {
        return { error: 'read_failed' };
      }
      try {
        return { value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
      } catch {
        return { error: 'invalid_json' };
      }
    };

    const auth = () => {
      if (!token) return true;
      if (req.headers['x-roost-token'] === token) return true;
      log('固定服务鉴权失败：密钥不对');
      send(401, { ok: false, error: 'unauthorized', message: '共享密钥不对' });
      return false;
    };

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return send(400, { ok: false, error: 'bad_url', message: '地址不合法' });
    }

    if (url.pathname === '/health' && req.method === 'GET') {
      return send(200, { ok: true, plugin: 'dsh-roost' });
    }

    /**
     * `/v1` 控制面（阶段 3.1）。**必须排在 `auth()` 之前**：扩展用的是 Bearer
     * 客户端令牌，不是面板的 X-Roost-Token 共享密钥；拿共享密钥去验扩展会
     * 401，反过来把扩展令牌放行到面板接口更糟。鉴权全在 `api-v1.js` 内。
     * `/inbound` 与面板 API 的分支一行未动。
     */
    if (url.pathname.startsWith('/v1/') && typeof onV1 === 'function') {
      try {
        return await onV1(req, res, url, { send, readJson });
      } catch (e) {
        log(`/v1 分发异常：${e?.message ?? e}`);
        return send(500, { ok: false, error: 'v1_dispatch_error' });
      }
    }

    if (url.pathname === '/capabilities' && req.method === 'GET') {
      if (!auth()) return;
      try {
        const tts = await onTtsStatus?.() ?? { enabled: false, configured: false };
        return send(200, { ok: true, tts });
      } catch {
        return send(200, { ok: true, tts: { enabled: false, configured: false, reason: 'status_unavailable' } });
      }
    }

    if (url.pathname === '/tts' && req.method === 'POST') {
      if (!auth()) return;
      const parsed = await readJson(64 * 1024);
      if (parsed.error === 'too_large') return send(413, { ok: false, error: 'request_too_large', message: '语音请求太大' });
      if (parsed.error === 'read_failed') return send(400, { ok: false, error: 'request_read_failed', message: '读取语音请求失败' });
      if (parsed.error) return send(400, { ok: false, error: 'invalid_json', message: '不是合法 JSON' });
      const text = typeof parsed.value?.text === 'string' ? parsed.value.text : '';
      if (!text.trim()) return send(400, { ok: false, error: 'empty_text', message: '缺少待合成文本' });
      if (typeof onTts !== 'function') return send(503, { ok: false, error: 'tts_unavailable', message: '语音服务未就绪' });

      try {
        const result = await onTts(text);
        const audio = Buffer.from(result?.audio ?? []);
        const contentType = String(result?.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
        if (!audio.length || !contentType.startsWith('audio/')) {
          return send(502, { ok: false, error: 'invalid_audio_response', message: '语音服务返回内容无效' });
        }
        res.writeHead(200, {
          'content-type': contentType,
          'content-length': String(audio.length),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return res.end(audio);
      } catch (e) {
        const status = Number(e?.status) || 502;
        const code = String(e?.code || 'upstream_error').replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'upstream_error';
        return send(status, { ok: false, error: code, message: String(e?.message || '语音合成失败') });
      }
    }

    if (url.pathname !== '/inbound' || req.method !== 'POST') {
      return send(404, { ok: false, error: 'not_found', message: '没有这个地址' });
    }
    if (!auth()) return;

    // 读 body（限 1MB，正常消息远小于这个）
    const parsed = await readJson(1024 * 1024);
    if (parsed.error === 'too_large') return send(413, { ok: false, error: '消息太大了' });
    if (parsed.error === 'read_failed') return send(400, { ok: false, error: '读请求失败' });
    if (parsed.error) return send(400, { ok: false, error: '不是合法 JSON' });
    const payload = parsed.value;
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
