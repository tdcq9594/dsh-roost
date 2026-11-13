/**
 * 可选依赖 ws：**装在框架那边**，插件侧不存第二份。
 *
 * 三个必须钉住的性质：
 *   1. 框架已有 → 直接复用，不去调安装接口（不重复下载）
 *   2. 框架没有 → 调框架的 `/api/ext/deps/install`（老框架回退旧路径），且只传 ws
 *   3. 装失败 / 目录没有 ws → 如实报失败，绝不谎报成功
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWsDeps, WS_PACKAGE } from '../src/ws-deps.js';

/** 造一个「框架目录」，可选地把 ws 装上 */
function fakeRoost({ wsVersion = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-wsdeps-'));
  if (wsVersion) {
    const p = join(dir, 'data', 'deps', 'onebot', 'node_modules', WS_PACKAGE);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name: WS_PACKAGE, version: wsVersion }), 'utf8');
    writeFileSync(join(p, 'index.js'), 'module.exports = { WebSocket: class {} };\n', 'utf8');
  }
  return dir;
}

test('状态：框架没装时说清楚，且不抛错', () => {
  const d = createWsDeps({});
  const st = d.status(fakeRoost());
  assert.equal(st.installed, false);
  assert.equal(st.usable, false);
  assert.equal(st.version, '');
  const empty = d.status('');
  assert.equal(empty.installed, false, '空目录也要能安全调用');
  assert.equal(empty.usable, false);
});

test('状态：框架装了就读出版本', () => {
  const d = createWsDeps({});
  const st = d.status(fakeRoost({ wsVersion: '8.18.0' }));
  assert.equal(st.installed, true);
  assert.equal(st.usable, true);
  assert.equal(st.version, '8.18.0');
});

test('安装：框架已有 ws 就直接复用，一次接口都不打', async () => {
  const calls = [];
  const d = createWsDeps({});
  const r = await d.installToRoost({
    api: async (p) => { calls.push(p); return { ok: true }; },
    roostDir: fakeRoost({ wsVersion: '8.18.0' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'reuse');
  assert.equal(calls.length, 0, '已有就不该再装一遍');
});

test('安装：框架没有就调框架接口，且只传 ws', async () => {
  const calls = [];
  const dir = fakeRoost();
  const d = createWsDeps({});
  const r = await d.installToRoost({
    api: async (p, init) => {
      calls.push([p, init]);
      // 模拟框架真的装上了
      const ws = join(dir, 'data', 'deps', 'onebot', 'node_modules', WS_PACKAGE);
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'package.json'), JSON.stringify({ version: '8.18.0' }), 'utf8');
      return { ok: true };
    },
    roostDir: dir,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/ext/deps/install');
  assert.deepEqual(JSON.parse(calls[0][1].body).packages, ['ws'], '白名单只放 ws');
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'installed');
  assert.equal(r.version, '8.18.0');
});

test('安装：框架回 ok:false 要如实报失败并带原因', async () => {
  const d = createWsDeps({});
  const r = await d.installToRoost({
    api: async () => ({ ok: false, error: '没网' }),
    roostDir: fakeRoost(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'failed');
  assert.match(r.message, /没网/);
  assert.match(r.message, /SSE/, '要告诉用户不影响使用');
});

test('安装：接口说成功但目录里没有 ws，不能谎报成功', async () => {
  const d = createWsDeps({});
  const r = await d.installToRoost({
    api: async () => ({ ok: true }),
    roostDir: fakeRoost(),
  });
  assert.equal(r.ok, false, '装完必须复查文件真的在');
  assert.match(r.message, /没找到 ws/);
});

test('安装：没有框架目录时给出可执行的下一步', async () => {
  const d = createWsDeps({});
  const r = await d.installToRoost({ api: async () => ({ ok: true }), roostDir: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /安装目录/);
});

test('加载：框架没装返回 null（调用方走 SSE），装了能拿到 WebSocket', () => {
  const d = createWsDeps({});
  assert.equal(d.load(fakeRoost()), null);
  const mod = d.load(fakeRoost({ wsVersion: '8.18.0' }));
  assert.equal(typeof mod?.WebSocket, 'function');
});

/**
 * 老框架（1.0.14 及之前）只有 `/api/onebot/deps/install`。
 * 新客户端先打新路径，404 再回退——不能因为改了个名字就让还在用老框架的人装不上。
 */
test('安装：新接口 404 时回退旧路径（老框架仍能装）', async () => {
  const calls = [];
  const dir = fakeRoost();
  const d = createWsDeps({});
  const r = await d.installToRoost({
    api: async (p) => {
      calls.push(p);
      if (p === '/api/ext/deps/install') throw new Error('HTTP 404 not_found 没有这个地址');
      const ws = join(dir, 'data', 'deps', 'onebot', 'node_modules', WS_PACKAGE);
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'package.json'), JSON.stringify({ version: '8.18.0' }), 'utf8');
      return { ok: true };
    },
    roostDir: dir,
  });
  assert.deepEqual(calls, ['/api/ext/deps/install', '/api/onebot/deps/install']);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'installed');
});
