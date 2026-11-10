#!/usr/bin/env node
/**
 * 最小 stdio MCP server（零依赖）
 * ==============================
 *
 * MCP 的 stdio transport 就是「一行一个 JSON-RPC 消息」。宿主（DSH）用受管块
 * 里的 `command` / `args` 拉起这个进程，通过 stdin / stdout 说话。
 *
 * 这个示例只做三件事：`initialize` / `tools/list` / `tools/call`。
 * 真正的扩展可以换成任意语言、任意 SDK —— 宿主只看协议，不看实现。
 */
import process from 'node:process';

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

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function handle(msg) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hello-stdio', version: '1.0.0' },
      },
    });
  }

  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    if (params?.name !== 'hello') {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `没有工具 ${params?.name}` } });
    }
    const who = String(params?.arguments?.name ?? '世界');
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `你好，${who}` }] },
    });
  }

  // 通知（没有 id）不回复；未知请求给标准错误
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `没有方法 ${method}` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* 坏行忽略：真实 server 也不该因为一行垃圾就退出 */
    }
  }
});
process.stdin.on('end', () => process.exit(0));
