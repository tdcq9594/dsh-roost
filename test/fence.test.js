// 面板 API 栅栏的单测：判定表逐格验证。
//
// 这一层的错法都很安静：放行多了是"看起来能用但谁都能调"，放行少了是
// "整个面板 403" —— 两种都不会在别的测试里冒出来。所以这里把每一格都钉住，
// 尤其是三处别人踩过的坑：principal 缺席、栅栏抛错、降级只出声一次。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFence, localRejection, headerOf, PEER } from '../src/fence.js';

/** 造一个像样的请求：回环 Host + 同源标记 */
const req = (headers = {}) => ({
  headers: { host: '127.0.0.1:17321', 'sec-fetch-site': 'same-origin', ...headers },
});

test('栅栏：没有 connection 服务时退回本地判定（能拦、也不会全拒）', () => {
  const fence = createFence({});
  assert.equal(fence(req()), null, '同源回环请求要放行，否则整个面板 403');
  assert.equal(fence(req({ 'sec-fetch-site': 'cross-site' }))?.status, 403);
  assert.equal(fence(req({ origin: 'https://evil.com' }))?.status, 403, 'Origin 与 Host 不同源');
  assert.equal(fence(req({ origin: 'http://127.0.0.1:17321' })), null, '同源 Origin 要放过');
});

test('栅栏：本地判定里 Host 缺失与畸形一样拒（DNS rebinding 只剩这道）', () => {
  assert.equal(localRejection({ headers: {} })?.status, 403);
  assert.equal(localRejection({ headers: { host: 'a b c' } })?.status, 403);
  assert.equal(localRejection({ headers: { host: '[::1]:17321' } }), null, 'IPv6 回环要认');
  assert.equal(localRejection({ headers: { host: 'localhost:17321' } }), null);
  assert.equal(localRejection({ headers: { host: '192.168.1.9:17321' } })?.status, 403, '局域网地址不在默认允许里');
});

test('栅栏：admit 交回拒绝码就按码拒', () => {
  const fence = createFence({ connection: () => ({ admit: () => ({ rejection: 401 }) }) });
  assert.equal(fence(req())?.status, 401);
  assert.equal(fence(req())?.why.includes('登录'), true, '401 的文案要说"去 DSH 面板操作"');
});

test('栅栏：principal 缺席要放行（老宿主没有这个字段）', () => {
  /**
   * 0.2.0-rc.2 的 admit 直接交 OperatorPeer，字段只有 id/ctx/scope。
   * 写成"没有 principal 就当非 owner"，会把每一次合法的 GUI 请求都 403。
   */
  const fence = createFence({ connection: () => ({ admit: () => ({ peer: { id: 'op' } }) }) });
  assert.equal(fence(req()), null, '没有 principal 也要放行');
});

test('栅栏：principal 在场但不是 owner 才拒', () => {
  const guest = createFence({
    connection: () => ({ admit: () => ({ peer: { principal: { kind: 'guest' } } }) }),
  });
  assert.equal(guest(req())?.status, 403);
  const owner = createFence({
    connection: () => ({ admit: () => ({ peer: { principal: { kind: 'owner' } } }) }),
  });
  assert.equal(owner(req()), null);
});

test('栅栏：admit 返回 undefined 时继续试 requestRejection', () => {
  const fence = createFence({
    connection: () => ({ admit: () => undefined, requestRejection: () => 403 }),
  });
  assert.equal(fence(req())?.status, 403, 'admit 不认得这次请求，不能当放行');
});

test('栅栏：宿主栅栏在岗且没拒，就不再叠加本地判定', () => {
  /**
   * 宿主的 trustedHosts 插件拿不到（局域网/反代声明过谁）。
   * 通过之后再拿本地规则判一遍，会把宿主允许的来源误杀。
   */
  const fence = createFence({
    connection: () => ({ requestRejection: () => undefined }),
  });
  assert.equal(fence(req({ host: '10.0.0.5:3080' })), null, '宿主已放行的 Host 不要再用回环规则否定');
});

test('栅栏：栅栏自己抛异常按 403 处理（不能当成放行）', () => {
  const fence = createFence({
    connection: () => ({
      admit: () => {
        throw new Error('boom');
      },
    }),
  });
  assert.equal(fence(req())?.status, 403, 'fail-closed：旧实现把异常读成"没被拒"是后门');
});

test('栅栏：降级只出声一次，别每次请求刷一行', () => {
  const lines = [];
  const fence = createFence({ log: (m) => lines.push(m) });
  fence(req());
  fence(req());
  fence(req());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /降级为本地判定/);
});

test('栅栏：headerOf 兼容数组头', () => {
  assert.equal(headerOf({ headers: { host: ['a', 'b'] } }, 'host'), 'a');
  assert.equal(headerOf({ headers: {} }, 'host'), '');
  assert.equal(headerOf({}, 'host'), '');
});

test('栅栏：把 Peer 挂到 req 上，handler 才有服务端身份可用', () => {
  const peer = { id: 'op-123', principal: { kind: 'owner' } };
  const fence = createFence({ connection: () => ({ admit: () => ({ peer }) }) });
  const r = req();
  assert.equal(fence(r), null);
  assert.equal(r[PEER], peer, '授权要用宿主交回的 Peer，不能用请求体里的 actor');
});

test('栅栏：isDegraded 反映「有没有会话鉴权」', () => {
  const degraded = createFence({});
  degraded(req());
  assert.equal(degraded.isDegraded(), true, '没有 connection 服务 = 只剩本地判定');

  const ok = createFence({ connection: () => ({ admit: () => ({ peer: { id: 'x' } }) }) });
  ok(req());
  assert.equal(ok.isDegraded(), false);
});
