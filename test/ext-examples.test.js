/**
 * 阶段 7 / 门 G7：文档自举 + 两个示例真跑通
 *
 * 跑法：node --test test/ext-examples.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest, MANIFEST_FILE } from '../src/ext-registry.js';
import { checkDocs, API_DOC } from '../src/ext-docs.js';
import { V1_ROUTES } from '../src/api-v1.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(ROOT, 'examples');
const DOCS = join(ROOT, 'docs');
const VERSION = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '';

function manifestOf(name) {
  return JSON.parse(fs.readFileSync(join(EXAMPLES, name, MANIFEST_FILE), 'utf8'));
}

/** 起一个 stdio 示例，按 id 等响应。 */
function spawnStdio(dir) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });

  let seq = 0;
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => rej(new Error(`等 ${method} 响应超时；stderr=${stderr.slice(0, 200)}`)), 8000);
    waiters.set(id, (m) => { clearTimeout(timer); res(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

  const stop = () => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.once('exit', () => res());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } res(); }, 1500);
  });

  return { child, call, stop };
}

async function waitPort(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`端口 ${port} 没起来`);
}

test('G7-3 文档自举：--check 与磁盘一致，端点表覆盖全部 /v1 路由', () => {
  assert.deepEqual(checkDocs({ docsDir: DOCS, version: VERSION }), [], '文档与源码不一致，跑 scripts/build-ext-docs.mjs');
  const md = fs.readFileSync(join(DOCS, API_DOC), 'utf8');
  for (const key of Object.keys(V1_ROUTES)) {
    const path = key.split(' ')[1];
    assert.ok(md.includes(`\`${path}\``), `API.md 缺端点 ${key}`);
  }
  assert.ok(md.includes('extId') && md.includes('令牌'), 'API.md 要写清来源不可自报');
  assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(md), '文档里不能出现疑似密钥');
});

test('G7-4 两个示例的 plugin.json 都过真实清单校验', () => {
  for (const id of ['hello-stdio', 'hello-http']) {
    const v = validateManifest(manifestOf(id), { expectedId: id });
    assert.equal(v.ok, true, `${id}: ${v.errors?.join('；')}`);
    assert.equal(v.manifest.kind, 'dsh-extension');
  }
  assert.equal(manifestOf('hello-http').transport, 'streamable-http');
  assert.equal(manifestOf('hello-stdio').transport, 'stdio');
});

test('G7-5 stdio 示例真跑：initialize / tools/list / tools/call 全通', async (t) => {
  const dir = join(EXAMPLES, 'hello-stdio');
  const s = spawnStdio(dir);
  t.after(() => s.stop());
  const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
  assert.equal(init.result.serverInfo.name, 'hello-stdio');
  assert.ok(init.result.capabilities.tools);

  const list = await s.call('tools/list');
  assert.deepEqual(list.result.tools.map((x) => x.name), ['hello']);

  const hit = await s.call('tools/call', { name: 'hello', arguments: { name: '栖' } });
  assert.equal(hit.result.content[0].text, '你好，栖');

  const miss = await s.call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(miss.error.code, -32602);
});

test('G7-6 streamable-http 示例真跑：同一套 JSON-RPC 换成 POST', async (t) => {
  const dir = join(EXAMPLES, 'hello-http');
  const port = 17998;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port) },
  });
  t.after(() => new Promise((res) => {
    if (child.exitCode !== null) return res();
    child.once('exit', () => res());
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退 */ } res(); }, 1500);
  }));

  await waitPort(port);
  const post = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'hello-http');

  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.json.result.tools.map((x) => x.name), ['hello']);

  const hit = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hello', arguments: { name: 'HTTP' } } });
  assert.equal(hit.json.result.content[0].text, '你好，HTTP');
});
