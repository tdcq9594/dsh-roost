// 框架 / ai-chat 的版本对照。
//
// 这块只做提示，但它错了会误导用户去重装东西，所以三种情况都要钉住：
// 有更新 / 已最新 / 查不到（网络抖动不能变成「有更新」或抛异常）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDepsCheck, readPluginVersion } from '../src/deps.js';

/** 造一个装了 ai-chat 的假框架目录 */
function fakeInstall({ version = '4.3.21', asPackageJson = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-deps-'));
  const p = path.join(dir, 'plugins', 'ai-chat');
  fs.mkdirSync(p, { recursive: true });
  if (asPackageJson) {
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ version }), 'utf8');
  } else {
    fs.writeFileSync(path.join(p, 'index.js'), `export default {\n  version: '${version}',\n}\n`, 'utf8');
  }
  return dir;
}

/** 假 fetch：GitHub 的 302 跳转 + 插件索引两条路 */
function fakeFetch({ fwTag = 'v0.9.10', pluginVersion = '4.3.22', fail = false } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('网络不通');
    if (String(url).includes('/releases/latest')) {
      return { status: 302, headers: { get: () => `https://github.com/x/y/releases/tag/${fwTag}` } };
    }
    if (String(url).includes('raw.githubusercontent.com')) {
      return { ok: true, json: async () => ({ plugins: [{ id: 'ai-chat', version: pluginVersion }] }) };
    }
    throw new Error('意外的地址 ' + url);
  };
  f.calls = calls;
  return f;
}

const detectOf = (dir, version = '0.9.9') => async () => ({ dir, version, installed: true });

test('版本对照：两边都有新版', async () => {
  const dir = fakeInstall({ version: '4.3.21' });
  const d = createDepsCheck({ detect: detectOf(dir), fetchImpl: fakeFetch(), now: () => 1000 });
  const r = await d.check();

  assert.equal(r.framework.installed, '0.9.9');
  assert.equal(r.framework.latest, '0.9.10');
  assert.equal(r.framework.hasUpdate, true);
  assert.equal(r.plugin.installed, '4.3.21');
  assert.equal(r.plugin.latest, '4.3.22');
  assert.equal(r.plugin.hasUpdate, true);
});

test('版本对照：已是最新时不报更新', async () => {
  const dir = fakeInstall({ version: '4.3.22' });
  const d = createDepsCheck({
    detect: detectOf(dir, '0.9.10'),
    fetchImpl: fakeFetch({ fwTag: 'v0.9.10', pluginVersion: '4.3.22' }),
    now: () => 1000,
  });
  const r = await d.check();

  assert.equal(r.framework.hasUpdate, false);
  assert.equal(r.plugin.hasUpdate, false);
});

test('版本对照：装的是更新的版本（本地领先）不报「有更新」', async () => {
  const dir = fakeInstall({ version: '4.4.0' });
  const d = createDepsCheck({ detect: detectOf(dir, '0.9.10'), fetchImpl: fakeFetch(), now: () => 1000 });
  const r = await d.check();
  assert.equal(r.plugin.hasUpdate, false, '本地比索引新时不能提示更新');
});

test('版本对照：查不到最新版只写 error，不抛也不当成有更新', async () => {
  const dir = fakeInstall();
  const d = createDepsCheck({ detect: detectOf(dir), fetchImpl: fakeFetch({ fail: true }), now: () => 1000 });
  const r = await d.check();

  assert.equal(r.ok, true);
  assert.equal(r.framework.hasUpdate, false);
  assert.ok(r.framework.error, '要带错误原因');
  assert.equal(r.plugin.hasUpdate, false);
  assert.ok(r.plugin.error);
});

test('版本对照：没装插件时 installed 为空，不报更新', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-deps-empty-'));
  const d = createDepsCheck({ detect: detectOf(dir, ''), fetchImpl: fakeFetch(), now: () => 1000 });
  const r = await d.check();

  assert.equal(r.framework.installed, '');
  assert.equal(r.framework.hasUpdate, false, '不知道当前版本就不能说「有更新」');
  assert.equal(r.plugin.installed, '');
  assert.equal(r.plugin.hasUpdate, false);
});

test('版本对照：半小时内走缓存，force 才重新查', async () => {
  const dir = fakeInstall();
  let t = 1000;
  const f = fakeFetch();
  const d = createDepsCheck({ detect: detectOf(dir), fetchImpl: f, now: () => t });

  await d.check();
  const first = f.calls.length;
  assert.ok(first > 0);

  t += 60_000;
  await d.check();
  assert.equal(f.calls.length, first, '缓存期内不该再打网络');

  t += 31 * 60_000;
  await d.check();
  assert.ok(f.calls.length > first, '过期后要重新查');

  const before = f.calls.length;
  await d.check({ force: true });
  assert.ok(f.calls.length > before, 'force 必须绕过缓存');
});

test('插件版本：index.js 优先，缺失时退回 package.json', () => {
  const a = fakeInstall({ version: '4.3.21' });
  assert.equal(readPluginVersion(a), '4.3.21');

  const b = fakeInstall({ version: '9.9.9', asPackageJson: true });
  assert.equal(readPluginVersion(b), '9.9.9');

  assert.equal(readPluginVersion(''), '');
  assert.equal(readPluginVersion(path.join(os.tmpdir(), '不存在的目录')), '');
});
