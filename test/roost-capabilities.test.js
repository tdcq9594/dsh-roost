// 能力协商：框架版本不同、插件热重载，方法表会变。宿主不能把方法名写死。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCapabilityClient, READONLY_METHODS, PRIVILEGED_METHODS,
} from '../src/roost-capabilities.js';

const CAPS = [
  { name: 'runtime.status', scope: 'read', desc: '状态' },
  { name: 'config.set', scope: 'manage', desc: '改配置' },
  { name: 'qq.call', scope: 'manage', desc: '反射官方 API' },
  { name: 'tool.roll_dice', scope: 'message', desc: '[插件工具·dice] 掷骰子', parameters: { type: 'object', properties: { sides: { type: 'integer' } }, required: ['sides'] } },
];

function make(over = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (method === 'system.capabilities') return over.list ?? CAPS;
    return { ok: true, method, params };
  };
  return { calls, caps: createCapabilityClient({ rpc }) };
}

test('能力表：拉一次就能列出内置只读能力与插件工具', async () => {
  const { caps } = make();
  const list = await caps.refresh();
  assert.equal(list.length, 4);
  assert.equal(caps.has('runtime.status'), true);
  assert.equal(caps.has('tool.roll_dice'), true);
  assert.equal(caps.dynamic().length, 1);
  assert.equal(caps.available().some((m) => m.name === 'runtime.status'), true);
  assert.equal(caps.available().some((m) => m.name === 'config.set'), false, '管理面不进 AI 白名单');
  assert.match(caps.signature(), /tool\.roll_dice:message/);
});

test('能力调用：只读方法原样透传，插件工具包成 {args}', async () => {
  const { calls, caps } = make();
  await caps.refresh();
  await caps.call('runtime.status', {});
  await caps.call('tool.roll_dice', { sides: 6 });
  assert.deepEqual(calls[1], ['runtime.status', {}]);
  assert.deepEqual(calls[2], ['tool.roll_dice', { args: { sides: 6 } }]);
});

test('能力调用：写方法 / 管理面 / 反射一律拒绝，不存在的方法给可执行的提示', async () => {
  const { caps } = make();
  await caps.refresh();
  for (const name of ['config.set', 'qq.call', 'plugin.install', 'msg.send', 'tool.not_there']) {
    await assert.rejects(caps.call(name, {}), /不允许/);
  }
  assert.equal(caps.allowed('tool.not_there'), false, '没在能力表里的插件工具不能被猜名字调');
  /** 白名单里但框架版本较旧没有的，给「先刷新能力表」的可执行提示 */
  const old = make({ list: [] });
  await old.caps.refresh();
  await assert.rejects(old.caps.call('runtime.status', {}), /框架没有这个能力/);
});

test('能力表：刷新失败保留旧清单并记下原因，不抛到调用方', async () => {
  let fail = false;
  const caps = createCapabilityClient({
    rpc: async (m) => {
      if (m === 'system.capabilities') {
        if (fail) throw new Error('框架没连上');
        return CAPS;
      }
      return { ok: true };
    },
  });
  await caps.refresh();
  fail = true;
  let err = null;
  try { await caps.refresh(); } catch (e) { err = e; caps.noteError(e); }
  assert.match(err.message, /没连上/);
  assert.equal(caps.list().length, 4, '旧清单还在');
  assert.match(caps.lastError(), /没连上/);
});

test('白名单：敏感只读方法单独标出来，供工具层按档位拦', () => {
  assert.ok(PRIVILEGED_METHODS.includes('runtime.logs'));
  assert.ok(PRIVILEGED_METHODS.includes('plugin.dashboard'));
  assert.ok(READONLY_METHODS.length >= 20);
  assert.ok(READONLY_METHODS.every((m) => m.name && m.desc));
});
