// 框架版本对照。
//
// 这块只做提示，但它错了会误导用户去重装东西，所以三种情况都要钉住：
// 有更新 / 已最新 / 查不到（网络抖动不能变成「有更新」或抛异常）。
//
// 移除 ai-chat 之后只查框架一个组件：插件索引那条请求必须彻底消失，
// 否则面板上会多一行永远「没装」的 ai-chat，还白打一次 GitHub。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDepsCheck } from '../src/deps.js';

/** 假 fetch：GitHub 的 302 跳转 + API 兜底两条路 */
function fakeFetch({ fwTag = 'v0.9.10', fail = false } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('网络不通');
    if (String(url).includes('api.github.com')) {
      return { json: async () => ({ tag_name: fwTag }) };
    }
    if (String(url).includes('/releases/latest')) {
      return { status: 302, headers: { get: () => `https://github.com/x/y/releases/tag/${fwTag}` } };
    }
    throw new Error('意外的地址 ' + url);
  };
  f.calls = calls;
  return f;
}

const detectOf = (version = '0.9.9') => async () => ({ version, installed: true });

test('版本对照：有新版时报更新', async () => {
  const f = fakeFetch();
  const d = createDepsCheck({ detect: detectOf(), fetchImpl: f, now: () => 1000 });
  const r = await d.check();

  assert.equal(r.ok, true);
  assert.equal(r.framework.installed, '0.9.9');
  assert.equal(r.framework.latest, '0.9.10');
  assert.equal(r.framework.hasUpdate, true);
});

test('移除 ai-chat：不再请求插件索引，返回值里没有 plugin 段', async () => {
  const f = fakeFetch();
  const d = createDepsCheck({ detect: detectOf(), fetchImpl: f, now: () => 1000 });
  const r = await d.check();

  assert.equal('plugin' in r, false);
  assert.equal(f.calls.some((u) => u.includes('raw.githubusercontent.com')), false,
    '插件索引不该再发请求');
  assert.equal(f.calls.every((u) => u.includes('github.com/tdcq9594/qq-bot-roost') ||
    u.includes('api.github.com')), true);
});

test('版本对照：已是最新时不报更新', async () => {
  const d = createDepsCheck({
    detect: detectOf('0.9.10'), fetchImpl: fakeFetch({ fwTag: 'v0.9.10' }), now: () => 1000,
  });
  assert.equal((await d.check()).framework.hasUpdate, false);
});

test('版本对照：本地领先时不报「有更新」', async () => {
  const d = createDepsCheck({
    detect: detectOf('9.9.9'), fetchImpl: fakeFetch(), now: () => 1000,
  });
  assert.equal((await d.check()).framework.hasUpdate, false);
});

test('版本对照：302 拿不到时退回 API，仍能查到版本', async () => {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.github.com')) return { json: async () => ({ tag_name: 'v0.9.11' }) };
    return { status: 200, headers: { get: () => '' } };
  };
  const d = createDepsCheck({ detect: detectOf(), fetchImpl: f, now: () => 1000 });
  const r = await d.check();
  assert.equal(r.framework.latest, '0.9.11');
  assert.equal(calls.some((u) => u.includes('api.github.com')), true);
});

test('版本对照：查不到最新版只写 error，不抛也不当成有更新', async () => {
  const d = createDepsCheck({
    detect: detectOf(), fetchImpl: fakeFetch({ fail: true }), now: () => 1000,
  });
  const r = await d.check();

  assert.equal(r.ok, true);
  assert.equal(r.framework.hasUpdate, false);
  assert.ok(r.framework.error, '要带错误原因');
});

test('版本对照：没装框架时 installed 为空，不报更新', async () => {
  const d = createDepsCheck({
    detect: detectOf(''), fetchImpl: fakeFetch(), now: () => 1000,
  });
  const r = await d.check();
  assert.equal(r.framework.installed, '');
  assert.equal(r.framework.hasUpdate, false, '不知道当前版本就不能说「有更新」');
});

test('版本对照：半小时内走缓存，force 才重新查', async () => {
  let t = 1000;
  const f = fakeFetch();
  const d = createDepsCheck({ detect: detectOf(), fetchImpl: f, now: () => t });

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
