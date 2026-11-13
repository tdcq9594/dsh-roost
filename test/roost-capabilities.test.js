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

/**
 * 开火时机：链路没通时不要打这一枪。
 *
 * 2026-11-13 10:10:26 实机日志：
 *   `[roost-capabilities] 能力表刷新失败（保留旧清单）：连不上 roost
 *    (http://127.0.0.1:6807)（那个端口没人监听：外接协议没开，或端口填错了）`
 * 那会儿 DSH 刚重启、Roost 还在起（`autoStart=false`），这一枪是**开机预打**
 * 打的空枪：看着像配对坏了，其实只是时序，几秒后 `online` 会自己补上。
 *
 * 跳过时**不能记成错误**，否则面板上还是会挂着一条假告警。
 */
test('开火时机：链路没通时 refresh 跳过、不发请求、不记错误', async () => {
  let linked = false;
  const calls = [];
  const caps = createCapabilityClient({
    rpc: async (m) => {
      calls.push(m);
      return CAPS;
    },
    ready: () => linked,
  });

  assert.equal(await caps.refresh(), null, '没通应当返回 null 而不是抛错或空清单');
  assert.deepEqual(calls, [], '没通就不该发 system.capabilities');
  assert.equal(caps.lastError(), '', '跳过不是失败，lastError 必须保持空');

  linked = true;
  const list = await caps.refresh();
  assert.equal(list.length, 4, '通了之后第一次拉取就要拿到全表');
  assert.deepEqual(calls, ['system.capabilities']);
});

test('开火时机：手动刷新（force）在链路没通时照样打一枪，把原因交给人看', async () => {
  let calls = 0;
  const caps = createCapabilityClient({
    rpc: async () => {
      calls += 1;
      throw new Error('连不上 roost (http://127.0.0.1:6807)');
    },
    ready: () => false,
  });

  await assert.rejects(caps.refresh({ force: true }), /连不上 roost/);
  assert.equal(calls, 1, '人明确点了刷新，就要真去打一枪');
});
