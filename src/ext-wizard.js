/**
 * 5.9 新建扩展向导：填几个字段，生成一份能直接跑起来的扩展骨架。
 * ============================================================
 *
 * 只生成**两种形态**：`stdio`（宿主拉起子进程）和 `streamable-http`（扩展自己
 * 起端口）。这两种正好覆盖 `examples/` 里的两个 hello 样例，生成结果与样例
 * 同构——用户看完文档想动手时，拿到的不是另一套写法。
 *
 * 三条设计取舍：
 *
 *   1. **只生成零依赖代码。** MCP 的 stdio 传输就是「一行一个 JSON-RPC」，
 *      http 就是「POST 一个 JSON」，用 `node:http` 和 `process.stdin` 就能跑，
 *      不需要装 SDK。用户装 SDK 也行，但骨架必须开箱能跑——否则「生成了但
 *      起不来」比不生成更让人困惑。
 *   2. **`plugin.json` 一律走 `validateManifest()` 的字段名**，不自己发明。
 *      生成完 host 会立刻用注册器校验一遍，字段写错当场报，不留到用户重启才发现。
 *   3. **不写 `.source.json`。** 那个文件是「市场装的」标记，写了等于告诉
 *      注册器「这是市场的扩展」，将来市场里出现同名 id 时更新会拒绝覆盖。
 *      向导生成的是**用户自己的**扩展，必须能被当成手写件。
 */

import { EXT_ID_RE, EXT_DEFAULT_SCOPES } from './ext-registry.js';

export const WIZARD_TRANSPORTS = ['stdio', 'streamable-http'];

/** 工具名上限：MCP 客户端会把它拼进 `mcp__<server>__<tool>`，太长会被截断 */
export const MAX_TOOLS = 30;
export const MAX_NAME_LEN = 64;
export const MAX_DESC_LEN = 200;

/** 工具名允许的字符：MCP 里是标识符，带空格/中文会装不上 */
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * 归一化工具声明。
 *
 * 返回 `{ ok, tools, errors }` 而不是直接抛：向导要一次把**所有**写错的字段
 * 都标红，让用户一趟改完；抛异常只能报第一个。
 */
export function normalizeTools(list) {
  const arr = Array.isArray(list) ? list : [];
  const tools = [];
  const errors = [];
  const seen = new Set();

  for (const [i, raw] of arr.entries()) {
    const name = str(raw?.name, MAX_NAME_LEN);
    const description = str(raw?.description, MAX_DESC_LEN);
    /** 整行都空的当「用户加了一行没填」，静默跳过，不报错 */
    if (!name && !description) continue;
    if (!name) {
      errors.push(`第 ${i + 1} 个工具没填名字`);
      continue;
    }
    if (!TOOL_NAME_RE.test(name)) {
      errors.push(`工具名「${name}」不合法：只能用字母开头，字母 / 数字 / 下划线 / 横线，最多 64 位`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`工具名「${name}」重复了`);
      continue;
    }
    seen.add(name);
    tools.push({ name, description: description || name });
  }

  if (tools.length > MAX_TOOLS) {
    errors.push(`工具最多 ${MAX_TOOLS} 个，现在有 ${tools.length} 个`);
  }
  return { ok: errors.length === 0, tools, errors };
}

/** 生成 plugin.json 的对象形态（导出给测试直接断言字段） */
export function buildManifest(spec = {}, tools = []) {
  const id = str(spec.id, 32);
  const transport = WIZARD_TRANSPORTS.includes(spec.transport) ? spec.transport : 'stdio';
  const name = str(spec.name, 60) || id;
  const base = {
    api: 1,
    kind: 'dsh-extension',
    id,
    serverName: id,
    name,
    description: str(spec.description, MAX_DESC_LEN) || `${name}（向导生成）`,
    usage: str(spec.usage, 400) || `让模型能调 ${name} 提供的 ${tools.length} 个工具`,
    transport,
  };

  if (transport === 'stdio') {
    base.command = 'node';
    base.args = ['server.mjs'];
  } else {
    const port = Number(spec.port);
    /** 端口只做范围校验，不查占用：生成时没起服务，查了也不准 */
    const safePort = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 18080;
    base.url = `http://127.0.0.1:${safePort}/mcp`;
  }

  base.mounts = ['*'];
  base.memory = {
    writeTarget: `ext:${id}`,
    visibility: 'all',
    onClear: 'keep',
    maxRows: 100,
  };
  /**
   * `scopes` 显式写默认值而不是省略：省略时注册器也会补成默认，但用户打开
   * `plugin.json` 看不到自己拿到了什么权限。写出来，改的时候才知道改哪里。
   */
  base.scopes = [...EXT_DEFAULT_SCOPES];
  return base;
}

/** 生成 stdio 形态的 server.mjs */
function stdioServer(id, tools) {
  return `#!/usr/bin/env node
/**
 * ${id} · MCP server（stdio，零依赖）
 *
 * 宿主（DSH）会按 plugin.json 的 command / args 拉起这个进程，
 * 通过 stdin / stdout 说话：**一行一个 JSON-RPC 消息**。
 *
 * 改哪里：
 *   · 工具清单在下面的 TOOLS；
 *   · 工具怎么干活在 handle() 的 \`tools/call\` 分支——现在每个工具都只回一句
 *     占位文本，把它换成真实现即可；
 *   · 需要参数就在 inputSchema.properties 里加字段（模型靠它填参数）。
 */
import process from 'node:process';

const TOOLS = ${JSON.stringify(tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: {} },
  })), null, 2)};

const send = (msg) => process.stdout.write(\`\${JSON.stringify(msg)}\\n\`);

function handle(msg) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '${id}', version: '0.1.0' },
      },
    });
  }

  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }

  if (method === 'tools/call') {
    const hit = TOOLS.find((t) => t.name === params?.name);
    if (!hit) {
      return send({ jsonrpc: '2.0', id, error: { code: -32602, message: \`没有工具 \${params?.name}\` } });
    }
    /** TODO：这里换成真实现。params.arguments 是模型填的参数 */
    return send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: \`\${hit.name} 还没实现，收到参数：\${JSON.stringify(params?.arguments ?? {})}\` }] },
    });
  }

  /** 通知（没有 id）不回复；未知请求给标准错误 */
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: \`没有方法 \${method}\` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
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
`;
}

/** 生成 streamable-http 形态的 server.mjs */
function httpServer(id, tools, port) {
  return `#!/usr/bin/env node
/**
 * ${id} · MCP server（streamable-http，零依赖）
 *
 * HTTP 形态**没有可接管的子进程**，所以宿主不往里注入令牌：需要身份就自己
 * 从环境变量读。协议和 stdio 完全一样，只是传输从「一行一个 JSON-RPC」
 * 换成「POST 一个 JSON」。
 *
 * 改哪里：
 *   · 工具清单在 TOOLS；
 *   · 真实现写在 handle() 的 \`tools/call\` 分支；
 *   · 端口读 PORT，默认 ${port}（与 plugin.json 的 url 对齐）。
 */
import http from 'node:http';

const TOOLS = ${JSON.stringify(tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: {} },
  })), null, 2)};

function handle(msg) {
  const { id, method, params } = msg ?? {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '${id}', version: '0.1.0' },
      },
    };
  }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const hit = TOOLS.find((t) => t.name === params?.name);
    if (!hit) return { jsonrpc: '2.0', id, error: { code: -32602, message: \`没有工具 \${params?.name}\` } };
    /** TODO：这里换成真实现 */
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: \`\${hit.name} 还没实现，收到参数：\${JSON.stringify(params?.arguments ?? {})}\` }] },
    };
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: \`没有方法 \${method}\` } };
  return null;
}

const PORT = Number(process.env.PORT || ${port});

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
    /** 通知没有响应体：202 空回，符合 streamable-http 的约定 */
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
  console.log(\`${id} 在 http://127.0.0.1:\${PORT}/mcp\`);
});
`;
}

/**
 * 生成整份骨架（纯函数，不碰磁盘）。
 *
 * @param {{id:string,name?:string,description?:string,usage?:string,
 *          transport?:string,port?:number,tools?:Array}} spec
 * @returns {{ok:boolean, id:string, transport:string, files:Array<{path:string,content:string}>,
 *            manifest:object|null, errors:string[], warnings:string[]}}
 */
export function buildExtension(spec = {}) {
  const id = str(spec.id, 32);
  const errors = [];
  const warnings = [];

  if (!id) errors.push('没填扩展 id');
  else if (!EXT_ID_RE.test(id)) {
    errors.push('扩展 id 只能用小写字母开头，小写字母 / 数字 / 横线，2–32 位（比如 weather-lite）');
  }

  const transport = WIZARD_TRANSPORTS.includes(spec.transport) ? spec.transport : 'stdio';
  const t = normalizeTools(spec.tools);
  errors.push(...t.errors);

  if (!t.tools.length) warnings.push('一个工具都没声明——扩展装上后模型看不到任何能力，先跑通链路也可以这样');

  if (errors.length) {
    return { ok: false, id, transport, files: [], manifest: null, errors, warnings };
  }

  const manifest = buildManifest({ ...spec, id, transport }, t.tools);
  const files = [
    { path: 'plugin.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];
  if (transport === 'stdio') {
    files.push({ path: 'server.mjs', content: stdioServer(id, t.tools) });
  } else {
    const port = Number(String(manifest.url).match(/:(\d+)\//)?.[1]) || 18080;
    files.push({ path: 'server.mjs', content: httpServer(id, t.tools, port) });
    warnings.push(`HTTP 形态要自己把服务跑起来（${manifest.url}），宿主不会替你启动`);
  }

  return { ok: true, id, transport, files, manifest, errors, warnings };
}

/** 生成完给人看的一句话（面板 toast 用） */
export function formatScaffold(result) {
  if (!result?.ok) return result?.errors?.join('；') || '生成失败';
  const what = result.transport === 'stdio' ? 'stdio（宿主拉起子进程）' : 'streamable-http（自己起端口）';
  return `已生成 ${result.id}：${result.files.length} 个文件，形态 ${what}`;
}
