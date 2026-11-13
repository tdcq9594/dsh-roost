// 5.8 测试版通道：按 latest / beta 挑版本，beta 没发布时回落。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pickChannel } from '../src/update.js';

test('pickChannel：稳定版选 latest，测试版选 beta', () => {
  const r = { latest: '1.2.0', beta: '1.3.0-beta.2', publishedAt: 100, betaPublishedAt: 200 };
  assert.deepEqual(pickChannel({ ...r, channel: 'latest' }), { version: '1.2.0', publishedAt: 100, channel: 'latest' });
  assert.deepEqual(pickChannel({ ...r, channel: 'beta' }), { version: '1.3.0-beta.2', publishedAt: 200, channel: 'beta' });
});

test('pickChannel：beta 没发布时回落 latest，不能显示成「已是最新」', () => {
  const r = { latest: '1.2.0', beta: '', publishedAt: 100, betaPublishedAt: 0 };
  const got = pickChannel({ ...r, channel: 'beta' });
  assert.equal(got.version, '1.2.0');
  assert.equal(got.channel, 'latest', '回落时要标成 latest');
});

test('pickChannel：beta 有版本但没发布时间时用 latest 的时间', () => {
  const got = pickChannel({ latest: '1.2.0', beta: '1.3.0-beta.1', publishedAt: 100, betaPublishedAt: 0, channel: 'beta' });
  assert.equal(got.version, '1.3.0-beta.1');
  assert.equal(got.publishedAt, 100);
});

test('通道名是 beta 而不是 next：远端读 dist-tags.beta，别再留旧标签', () => {
  const update = readFileSync(new URL('../src/update.js', import.meta.url), 'utf8');
  assert.ok(update.includes("['dist-tags']?.beta"), '要读 beta 标签');
  assert.equal(update.includes("['dist-tags']?.next"), false, '不许再读 next');
  assert.ok(update.includes("channel === 'beta'"), '纯函数按 beta 判断');
  const config = readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.ok(config.includes('`beta` = 测试版'), '配置注释要对齐');
});

test('配置与面板：默认稳定版，更新页能切通道', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("h('option', { value: 'beta' }, '测试版 beta')"), '更新页要有通道选项');
  assert.equal(client.includes("'测试版 next'"), false, '旧文案要清掉');
  assert.ok(client.includes("localStorage.setItem('roost.update.channel'"), '切换要记住');
  assert.ok(client.includes("'/update/check' + qs"), '请求要带通道');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.ok(host.includes("channelOf: () => cfg.update?.channel || 'latest'"), '后端默认按配置');
  assert.ok(host.includes("searchParams.get('channel')"), '路由要认 query 里的通道');
});

test('配置默认：update.channel = latest', async () => {
  const { DEFAULTS } = await import('../src/config.js');
  assert.equal(DEFAULTS.update?.channel, 'latest');
});
