#!/usr/bin/env node
/**
 * 最小 streamable-http MCP server（零依赖）
 * ======================================
 *
 * HTTP 形态**没有可接管的子进程**，所以宿主不往里注入令牌（方案 §5.4 第 6 条）：
 * 需要身份就由用户自己把令牌配进这个进程的启动环境。
 *
 * 协议与 stdio 完全一样，只是传输从「一行一个 JSON-RPC」换成「POST 一个 JSON」。
 * 端口读 `PORT`，默认 17999（与 `plugin.json` 的 `url` 对齐）。
 */
import http from 'node:http';

const TOOLS = [
  {
    name: 'hello',
    description: '按名字打招呼',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要打招呼的人' } },
    },
  },
];

function handle(msg) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hello-http', version: '1.0.0' },
      },
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    if (params?.name !== 'hello') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `没有工具 ${params?.name}` } };
    }
    const who = String(params?.arguments?.name ?? '世界');
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `你好，${who}` }] } };
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `没有方法 ${method}` } };
  return null;
}

const PORT = Number(process.env.PORT || 17999);

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
    return;
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw || '{}'); } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
      return;
    }
    const out = handle(msg);
    if (!out) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hello-http 在 http://127.0.0.1:${PORT}/mcp`);
});
