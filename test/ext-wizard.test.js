// 5.9 扩展向导：字段校验 + 生成的骨架**真能跑起来**（不是只生成文件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildExtension, normalizeTools, buildManifest, WIZARD_TRANSPORTS } from '../src/ext-wizard.js';
import { validateManifest } from '../src/ext-registry.js';

/** 把生成结果落到临时目录，返回目录路径 */
function materialize(result) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-wizard-'));
  for (const f of result.files) writeFileSync(join(dir, f.path), f.content, 'utf8');
  return dir;
}

/** 起一个 stdio server，发一条 JSON-RPC，收一行响应 */
function rpcOnce(dir, msg, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error(`等响应超时；stderr=${err.slice(0, 300)}`));
    }, timeout);
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (c) => { err += c; });
    p.stdout.on('data', (c) => {
      out += c;
      const i = out.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      const line = out.slice(0, i);
      p.kill();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`回的不是 JSON：${line.slice(0, 200)}`));
      }
    });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.stdin.write(`${JSON.stringify(msg)}\n`);
  });
}

test('id 校验：中文 / 大写 / 太短 / 带下划线都不行', () => {
  for (const id of ['天气', 'Weather', 'a', 'weather_lite', 'weather lite']) {
    const r = buildExtension({ id, tools: [{ name: 't', description: 'x' }] });
    assert.equal(r.ok, false, `${id} 应该被拒`);
    assert.match(r.errors.join('；'), /扩展 id/);
  }
});

test('id 合法时通过，且不生成 .source.json（那是市场装的标记）', () => {
  const r = buildExtension({ id: 'weather-lite', name: '天气', tools: [{ name: 'forecast', description: '查天气' }] });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(r.files.map((f) => f.path), ['plugin.json', 'server.mjs']);
  assert.equal(existsSync(join(materialize(r), '.source.json')), false);
});

test('工具名：中文 / 空格 / 重复 / 超量都要报出来，而且一次报全', () => {
  const bad = normalizeTools([
    { name: '查天气' },
    { name: 'has space' },
    { name: 'dup' },
    { name: 'dup' },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.tools.length, 1, '只有 dup 的第一个是合法的');
  assert.equal(bad.errors.length, 3);

  const many = normalizeTools(Array.from({ length: 31 }, (_, i) => ({ name: `t${i}` })));
  assert.match(many.errors.join('；'), /工具最多 30 个/);
});

test('空行静默跳过，不算错', () => {
  const r = normalizeTools([{ name: '', description: '' }, { name: 'ok' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tools.map((t) => t.name), ['ok']);
});

test('一个工具都没有：允许生成，但警告「模型看不到任何能力」', () => {
  const r = buildExtension({ id: 'empty-one', tools: [] });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join('；'), /一个工具都没声明/);
});

test('stdio 清单：command/args 齐全、没有 url，且能过 validateManifest', () => {
  const r = buildExtension({
    id: 'weather-lite', name: '天气', description: '查天气', usage: '问天气时用',
    transport: 'stdio', tools: [{ name: 'forecast', description: '查某地天气' }],
  });
  assert.equal(r.manifest.transport, 'stdio');
  assert.equal(r.manifest.command, 'node');
  assert.deepEqual(r.manifest.args, ['server.mjs']);
  assert.equal(r.manifest.url, undefined);
  assert.deepEqual(r.manifest.mounts, ['*']);
  assert.equal(r.manifest.memory.writeTarget, 'ext:weather-lite');
  assert.ok(Array.isArray(r.manifest.scopes) && r.manifest.scopes.length, 'scopes 要显式写出来');

  /** 真的过一遍注册器的校验，别只对字段名 */
  const v = validateManifest(JSON.parse(r.files[0].content), { expectedId: 'weather-lite' });
  assert.equal(v.ok, true, v.reason || '清单没通过校验');
});

test('http 清单：url 带端口，端口乱填回落到 18080', () => {
  const ok = buildManifest({ id: 'x-http', transport: 'streamable-http', port: 18999 }, []);
  assert.equal(ok.url, 'http://127.0.0.1:18999/mcp');
  assert.equal(ok.command, undefined);

  const bad = buildManifest({ id: 'x-http', transport: 'streamable-http', port: 80 }, []);
  assert.equal(bad.url, 'http://127.0.0.1:18080/mcp', '1024 以下是特权端口，回落到默认');

  const v = validateManifest(bad, { expectedId: 'x-http' });
  assert.equal(v.ok, true, v.reason || 'http 清单没通过校验');
});

test('传输方式只认两种，乱填按 stdio', () => {
  assert.deepEqual(WIZARD_TRANSPORTS, ['stdio', 'streamable-http']);
  const r = buildExtension({ id: 'weird-one', transport: 'websocket', tools: [{ name: 't' }] });
  assert.equal(r.transport, 'stdio');
  assert.equal(r.manifest.command, 'node');
});

test('生成的 stdio server 真能跑：initialize / tools/list / tools/call', async () => {
  const r = buildExtension({
    id: 'weather-lite', name: '天气',
    tools: [{ name: 'forecast', description: '查某地天气' }, { name: 'alert', description: '有没有预警' }],
  });
  const dir = materialize(r);
  try {
    const init = await rpcOnce(dir, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    assert.equal(init.result.serverInfo.name, 'weather-lite');
    assert.equal(init.result.capabilities.tools !== undefined, true);

    const list = await rpcOnce(dir, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((t) => t.name), ['forecast', 'alert']);
    assert.equal(list.result.tools[0].inputSchema.type, 'object');

    const call = await rpcOnce(dir, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'forecast', arguments: { city: '杭州' } },
    });
    assert.match(call.result.content[0].text, /forecast 还没实现/);
    assert.match(call.result.content[0].text, /杭州/, '参数要透传进占位文本，方便验证接线');

    const miss = await rpcOnce(dir, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' },
    });
    assert.equal(miss.error.code, -32602);

    const unknown = await rpcOnce(dir, { jsonrpc: '2.0', id: 5, method: 'nope/nope' });
    assert.equal(unknown.error.code, -32601);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  }
});

test('生成的 http server 语法正确（起得来就说明能解析）', async () => {
  const r = buildExtension({
    id: 'http-one', transport: 'streamable-http', port: 18123,
    tools: [{ name: 'ping', description: 'ping 一下' }],
  });
  assert.equal(r.ok, true, r.errors.join('；'));
  const dir = materialize(r);
  try {
    /** 只做语法检查：`node --check` 不执行，端口不会被占用 */
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['--check', 'server.mjs'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (c) => { err += c; });
      p.on('close', (c) => resolve({ code: c, err }));
    });
    assert.equal(code.code, 0, `server.mjs 语法错误：${code.err.slice(0, 300)}`);
    assert.match(r.files[1].content, /127\.0\.0\.1/, '只监听回环，别往 0.0.0.0 上开');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  }
});
