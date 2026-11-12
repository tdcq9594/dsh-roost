/**
 * 固定回环服务：`/v1` 控制面、TTS、能力探测、健康检查。
 *
 * 以前这里还接 ai-chat 推来的 `/inbound`（收到就 200，AI 想完再回调它的
 * `/reply`）。移除 ai-chat 之后那条链路没有了：消息由框架外接协议的事件流
 * 直接送进 `onInbound`，扩展投递 `/v1/message` 也是同进程调用。
 *
 * 仍然自己起 server 而不用 `ctx.webServer`：DSH 面板端口是随机的，
 * 扩展和 TTS 需要一个**固定地址**才找得到宿主。
 */

import { createServer } from 'node:http';

/**
 * 把这一轮的回复发出去。
 *
 * 直连之后回复走 `payload.__channel.send`（同进程通道，由入站 payload 构造时
 * 注入），扩展投递 `/v1/message` 也走同一条。**不接受外部传 URL**——
 * 回话地址一旦可控就是 SSRF 面，所以这里只认函数、不认地址。
 *
 * `extra` 一起转交：`extra.requestId` 是框架投递账本的幂等键，丢了这条回复
 * 就查不到终态；`extra.files` 是这一轮要发的文件，由通道自己上传。
 *
 * @param {object} payload 入站 payload
 * @param {string} text 回复正文
 * @param {boolean} [done] 保留参数以兼容既有调用点，直连下不参与判断
 * @param {object} [extra]
 */
export async function postReply(payload, text, done = true, extra = {}) {
  const send = payload?.__channel?.send;
  if (typeof send !== 'function') {
    throw new Error('payload 里没有回话通道（消息必须经外接协议或 /v1 入站）');
  }
  return await send(String(text ?? ''), extra);
}

/**
 * 起服务。
 *
 * @param {object} p
 * @param {number} p.port
 * @param {string} [p.token] 共享密钥；空表示不校验
 * @param {(msg:string)=>void} [p.log]
 */
export function createInboundServer({
  port, ports, token = '', onTts, onTtsStatus, onListening, onV1, log = () => {},
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
     * 面板 API 的分支一行未动。
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

    // 没有 /inbound 了：消息从框架外接协议的事件流进来，不靠 HTTP 推
    return send(404, { ok: false, error: 'not_found', message: '没有这个地址' });
  });

  /**
   * 端口被占就往后试下一个。
   *
   * 之前只试一个端口，被占就彻底没人听了——扩展和 TTS 全是 fetch failed，
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
