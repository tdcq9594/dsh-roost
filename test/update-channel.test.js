// 5.8 测试版通道：按 latest / next 挑版本，next 没发布时回落。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pickChannel } from '../src/update.js';

test('pickChannel：稳定版选 latest，测试版选 next', () => {
  const r = { latest: '1.2.0', next: '1.3.0-next.2', publishedAt: 100, nextPublishedAt: 200 };
  assert.deepEqual(pickChannel({ ...r, channel: 'latest' }), { version: '1.2.0', publishedAt: 100, channel: 'latest' });
  assert.deepEqual(pickChannel({ ...r, channel: 'next' }), { version: '1.3.0-next.2', publishedAt: 200, channel: 'next' });
});

test('pickChannel：next 没发布时回落 latest，不能显示成「已是最新」', () => {
  const r = { latest: '1.2.0', next: '', publishedAt: 100, nextPublishedAt: 0 };
  const got = pickChannel({ ...r, channel: 'next' });
  assert.equal(got.version, '1.2.0');
  assert.equal(got.channel, 'latest', '回落时要标成 latest');
});

test('pickChannel：next 有版本但没发布时间时用 latest 的时间', () => {
  const got = pickChannel({ latest: '1.2.0', next: '1.3.0-next.1', publishedAt: 100, nextPublishedAt: 0, channel: 'next' });
  assert.equal(got.version, '1.3.0-next.1');
  assert.equal(got.publishedAt, 100);
});

test('配置与面板：默认稳定版，更新页能切通道', () => {
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  assert.ok(client.includes("h('option', { value: 'next' }, '测试版 next')"), '更新页要有通道选项');
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
