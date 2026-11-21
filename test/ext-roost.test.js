/**
 * 扩展 ↔ 框架直连协议（roost-host/1）转发
 * ========================================
 *
 * 重点不是「端点能返回」，而是四条不能破的边界：
 *  1. 白名单：写 / 管理面（`config.set` / `plugin.install` / `qq.call`）绝不开放；
 *  2. 能力表：框架没有的方法不能转发，否则返回的是 404 而不是空结果；
 *  3. 目标：`owner` 由宿主解析成 openid，扩展拿不到也不该自己拿到；
 *  4. `msg.send` 参数收窄：不许带 msgId / eventId 蹭被动回复窗口，不许自报 requestId。
 *
 * 跑法：node --test test/ext-roost.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyRoostCall, resolveExtTarget, narrowMsgSend, isOwnerAlias,
  EXT_ROOST_READONLY, EXT_ROOST_SEND,
} from '../src/ext-roost.js';
import { createExtApiHooks } from '../src/ext-api-hooks.js';
import { V1_ROUTES, V1_IMPLEMENTED_HOOKS, isRouteImplemented } from '../src/api-v1.js';

/** 假能力表：`has()` 只认列出来的方法 */
function caps(names = ['runtime.status', 'plugin.list', 'tool.hello.say', 'msg.send']) {
  const set = new Set(names);
  return {
    has: (n) => set.has(n),
    list: () => names.map((name) => ({
      name, scope: name.startsWith('tool.') ? 'message' : 'read',
      desc: `${name} 的说明`, parameters: null,
    })),
    lastAt: () => 1234,
  };
}

/** 造一套 hooks，把 rpc 调用全记下来 */
function rig(over = {}) {
  const calls = { rpc: [], chSend: [], authz: [] };
  const hooks = createExtApiHooks({
    cfgOf: () => ({ speakUp: { enabled: true, chatId: 'u1' } }),
    moodOf: () => ({}),
    moodTextOf: () => '',
    memoryOf: () => ({
      hasAuthz: (id, scope) => { calls.authz.push([id, scope]); return over.authz === true; },
    }),
    journalOf: () => ({ recent: () => [] }),
    aliasesOf: () => [],
    channelOf: () => ({
      get: () => ({ send: async (p) => { calls.chSend.push(p); return { ok: true, id: 'm1' }; } }),
    }),
    dataDirOf: () => '',
    setupOf: () => ({ roostOwner: () => 'owner-openid', ownersConfigured: true }),
    roostOf: () => ({
      connected: over.connected !== false,
      /** 用 === undefined 判缺省：显式传 null 表示「没连上」，不能回退成默认表 */
      caps: over.caps === undefined ? caps() : over.caps,
      rpc: async (m, p) => { calls.rpc.push([m, p]); return over.rpcResult ?? { ok: true, from: 'framework' }; },
    }),
    ownerOf: () => 'owner-openid',
    resolveRecentGroupOf: async () => over.recentGroup ?? '',
    log: () => {},
  });
  return { hooks, calls };
}

// ---------------------------------------------------------------- 路由接线

test('两个协议端点都接线了，且文档生成用的 hook 名单对得上', () => {
  assert.equal(V1_ROUTES['GET /v1/roost.capabilities'].scope, 'state:read');
  assert.equal(V1_ROUTES['POST /v1/roost.call'].scope, 'message:write');
  assert.equal(V1_ROUTES['POST /v1/roost.read'].scope, 'state:read');
  assert.equal(isRouteImplemented('GET /v1/roost.capabilities'), true);
  assert.equal(isRouteImplemented('POST /v1/roost.call'), true);
  assert.equal(isRouteImplemented('POST /v1/roost.read'), true);
  assert.ok(V1_IMPLEMENTED_HOOKS.includes('roost.capabilities'));
  assert.ok(V1_IMPLEMENTED_HOOKS.includes('roost.call'));
  assert.ok(V1_IMPLEMENTED_HOOKS.includes('roost.read'));
});

// ---------------------------------------------------------------- 白名单

test('只读能力、tool.* 与 msg.send 放行；写/管理面一律拒绝', () => {
  assert.deepEqual(classifyRoostCall('runtime.status'), { ok: true, kind: 'readonly' });
  assert.deepEqual(classifyRoostCall('tool.hello.say'), { ok: true, kind: 'tool' });
  assert.deepEqual(classifyRoostCall('msg.send'), { ok: true, kind: 'send' });

  for (const bad of ['config.set', 'plugin.install', 'plugin.enable', 'qq.call', 'msg.retract', 'gate.set', 'system.hello.x']) {
    assert.equal(classifyRoostCall(bad).ok, false, `${bad} 不该对扩展开放`);
  }
  /** 主人专属的只读项也不能从这条路绕过去 */
  for (const p of ['runtime.logs', 'plugin.dashboard', 'config.get']) {
    assert.equal(classifyRoostCall(p).ok, false, `${p} 是主人/管理员专属`);
  }
  assert.equal(EXT_ROOST_READONLY.includes('config.get'), false);
  assert.ok(EXT_ROOST_READONLY.includes('plugin.list'));
  assert.ok(EXT_ROOST_SEND.includes('msg.send'));
});

test('名字不合法 / 空 / 过长 / 原型链键都要挡在转发之前', () => {
  for (const bad of ['', '  ', 'tool.', '__proto__', 'constructor', 'hasOwnProperty', 'a'.repeat(200), 'msg send', 'x;DROP']) {
    assert.equal(classifyRoostCall(bad).ok, false, `${JSON.stringify(bad)} 该被挡下`);
  }
});

test('框架能力表里没有的方法不转发（老版本 / 插件已卸载）', () => {
  const c = caps(['runtime.status']);
  assert.equal(classifyRoostCall('ledger.stats', c).ok, false);
  assert.equal(classifyRoostCall('tool.gone', c).ok, false);
  assert.equal(classifyRoostCall('runtime.status', c).ok, true);
  /** 没连上时 caps 为 null：方法名合法就先放行，rpc 自己会报 503 */
  assert.equal(classifyRoostCall('runtime.status', null).ok, true);
});

// ---------------------------------------------------------------- 目标解析

test('owner 别名由宿主解析，扩展拿不到 openid；空 target 默认报错', () => {
  assert.ok(isOwnerAlias('owner'));
  assert.ok(isOwnerAlias('PRIVATE'));
  assert.deepEqual(resolveExtTarget('owner', { ownerOf: () => 'u-123' }), {
    ok: true, scene: 'c2c', target: 'u-123', ownerAlias: true,
  });
  assert.equal(resolveExtTarget('', { ownerOf: () => 'u-123' }).ok, false);
  assert.deepEqual(resolveExtTarget('', { ownerOf: () => 'u-123', allowEmpty: true }), {
    ok: true, scene: 'c2c', target: 'u-123', ownerAlias: true,
  });
  /** 宿主没配主人时不能瞎发 */
  assert.equal(resolveExtTarget('owner', { ownerOf: () => '' }).ok, false);
});

test('group: 前缀与裸 openid 保持既有语义', () => {
  assert.deepEqual(resolveExtTarget('group:g-openid', {}), {
    ok: true, scene: 'group', target: 'g-openid', ownerAlias: false,
  });
  assert.deepEqual(resolveExtTarget('raw-id', { scene: 'group' }), {
    ok: true, scene: 'group', target: 'raw-id', ownerAlias: false,
  });
  assert.equal(resolveExtTarget('recent', {}).ok, false, '没给解析器就别认 recent');
  assert.equal(resolveExtTarget('recent', { resolveRecentGroup: async () => 'g' }).recent, true);
});

// ---------------------------------------------------------------- 参数收窄

test('msg.send 只保留安全参数：msgId / eventId / requestId / isWakeup 全被丢掉', () => {
  const r = narrowMsgSend({
    content: '你好', chatId: '别人', kind: 'group',
    msgId: 'steal-passive-window', eventId: 'evt', requestId: 'fake-ledger',
    isWakeup: true, msgSeq: 7, clientMsgId: 'x',
  }, { scene: 'c2c', target: 'owner-openid' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, { kind: 'c2c', chatId: 'owner-openid', content: '你好' });
});

test('卡片消息正文必须为空，字段裁剪到官方四项', () => {
  const r = narrowMsgSend({
    content: '这句该被丢掉',
    card: { title: '标题', description: '描述', url: 'https://bili.video/BV1', picUrl: 'https://i.jpg', evil: 'x' },
  }, { scene: 'c2c', target: 'owner-openid' });
  assert.equal(r.ok, true);
  assert.equal(r.params.content, '');
  assert.deepEqual(Object.keys(r.params.card), ['title', 'description', 'url', 'picUrl']);
});

test('没有内容 / 没有目标都要拒绝，不能发空消息', () => {
  assert.equal(narrowMsgSend({}, { scene: 'c2c', target: 'u' }).ok, false);
  assert.equal(narrowMsgSend({ content: 'x' }, { scene: 'c2c', target: '' }).ok, false);
});

// ---------------------------------------------------------------- hooks 集成

test('roost.capabilities 只列可扩展调用的能力，不列写/管理面', async () => {
  const { hooks } = rig();
  const r = await hooks['roost.capabilities']({ query: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tools.map((m) => m.name), ['tool.hello.say']);
  assert.ok(r.body.readonly.some((m) => m.name === 'runtime.status'));
  assert.equal(r.body.readonly.some((m) => m.name === 'config.get'), false);
  assert.deepEqual(r.body.send, ['msg.send']);
  assert.equal(r.body.connected, true);
});

test('没连上协议时 capabilities 回 503，不假装是空清单', async () => {
  const { hooks } = rig({ caps: null });
  const r = await hooks['roost.capabilities']({ query: {} });
  assert.equal(r.status, 503);
});

test('roost.read 转只读能力：state:read 就够，参数原样透传', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.read']({ body: { method: 'runtime.status', params: { verbose: 1 } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.from, 'framework');
  assert.deepEqual(calls.rpc[0], ['runtime.status', { verbose: 1 }]);
});

test('roost.read 拒绝 msg.send / tool.*，且不转发', async () => {
  const { hooks, calls } = rig();
  const send = await hooks['roost.read']({
    body: { method: 'msg.send', params: { target: 'owner', text: 'x' } },
  });
  assert.equal(send.status, 403);
  const tool = await hooks['roost.read']({ body: { method: 'tool.hello.say', params: {} } });
  assert.equal(tool.status, 403);
  assert.equal(calls.rpc.length, 0);
});

test('roost.call 转只读能力：参数原样透传', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.call']({ body: { method: 'runtime.status', params: { verbose: 1 } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.from, 'framework');
  assert.deepEqual(calls.rpc[0], ['runtime.status', { verbose: 1 }]);
});

test('roost.call 转插件工具：协议约定把参数包成 { args }', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.call']({ body: { method: 'tool.hello.say', params: { text: '你好' } } });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.rpc[0], ['tool.hello.say', { args: { text: '你好' } }]);
});

test('roost.call 转 msg.send：owner 由宿主解析，危险参数被丢掉', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.call']({ body: {
    method: 'msg.send',
    params: { target: 'owner', content: '刷到一个好视频', msgId: 'steal', requestId: 'fake' },
  } });
  assert.equal(r.status, 200);
  const [method, params] = calls.rpc[0];
  assert.equal(method, 'msg.send');
  assert.equal(params.kind, 'c2c');
  assert.equal(params.chatId, 'owner-openid');
  assert.equal(params.content, '刷到一个好视频');
  assert.match(params.requestId, /^ext-.+-[0-9a-f]{8}-[0-9a-f]{4}-/, '宿主代生成幂等键，扩展不许自报');
});

test('roost.call 的幂等键由宿主生成，扩展自报的不算数', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.call']({ body: {
    method: 'msg.send',
    params: { target: 'owner', content: 'hi', requestId: 'fake-fixed-id' },
  }, client: { extId: 'bili' } });
  assert.equal(r.status, 200);
  const params = calls.rpc[0][1];
  assert.notEqual(params.requestId, 'fake-fixed-id', '不能让扩展顶掉投递账本的键');
  assert.match(params.requestId, /^ext-bili-[0-9a-f]{8}-/);
});

test('roost.call 的卡片也要过 tuwen 校验，不能靠协议直通绕过去', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.call']({ body: {
    method: 'msg.send',
    params: { target: 'owner', card: { title: '标题', description: '描述', url: 'http://非https', picUrl: 'x' } },
  } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /https/);
  assert.equal(calls.rpc.length, 0);
});

test('roost.call 发群要先查 group_push 授权', async () => {
  const { hooks, calls } = rig({ authz: false });
  const r = await hooks['roost.call']({ body: {
    method: 'msg.send', params: { target: 'group:g1', content: 'hi' },
  } });
  assert.equal(r.status, 403);
  assert.equal(calls.rpc.length, 0, '没授权就不该真发出去');
  assert.deepEqual(calls.authz[0], ['g1', 'group_push']);
});

test('roost.call 拒绝写方法，且不会真的转发', async () => {
  const { hooks, calls } = rig();
  const r = await hooks['roost.call']({ body: { method: 'config.set', params: { owners: ['hacker'] } } });
  assert.equal(r.status, 403);
  assert.equal(calls.rpc.length, 0);
});

test('roost.call 框架侧报错回 502，不把异常当成功', async () => {
  const { hooks } = rig({ rpcResult: null });
  /** 单独造一个会抛的 rpc */
  const h = createExtApiHooks({
    cfgOf: () => ({}), moodOf: () => ({}), moodTextOf: () => '',
    memoryOf: () => ({ hasAuthz: () => true }), journalOf: () => ({ recent: () => [] }),
    aliasesOf: () => [], channelOf: () => ({ get: () => ({}) }), dataDirOf: () => '',
    roostOf: () => ({ connected: true, caps: caps(), rpc: async () => { throw new Error('框架 offline'); } }),
    ownerOf: () => 'u1', log: () => {},
  });
  const r = await h['roost.call']({ body: { method: 'runtime.status' } });
  assert.equal(r.status, 502);
  assert.match(r.body.message, /框架 offline/);
});

test('/v1/send 的 owner 别名直接走通道层发出去，不经过模型', async () => {
  const { hooks, calls } = rig();
  const r = await hooks.send({ body: { target: 'owner', text: '一张卡片的说明' }, client: { extId: 'bili' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(calls.chSend[0].target, 'owner-openid');
  assert.equal(calls.chSend[0].text, '一张卡片的说明');
});

test('/v1/send 的卡片直发：四个字段原样进通道，不跑模型', async () => {
  const { hooks, calls } = rig();
  const card = { title: '标题', description: '描述', url: 'https://bili.video/BV1', picUrl: 'https://i.jpg' };
  const r = await hooks.send({ body: { target: 'owner', card }, client: { extId: 'bili' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.card.ok, true);
  assert.deepEqual(calls.chSend[0].card, card);
});

test('/v1/send 保持旧行为：不填 target 仍然报错', async () => {
  const { hooks, calls } = rig();
  const r = await hooks.send({ body: { text: 'hello' }, client: {} });
  assert.equal(r.status, 400);
  assert.equal(calls.chSend.length, 0);
});

/**
 * 「只读」不等于「可以给扩展」（2026-11 复核）。
 *
 * `roost.read` 只要 `state:read`，而它在**默认 scope** 里——安装时不需要
 * 主人确认。如果身份 / 账本 / 投递这些也在放行名单里，任何装上的扩展都能
 * 按 chatId 读**任意会话的消息原文**、拿 openid ↔ QQ 号 ↔ 群号的映射。
 * 它们在 `roost.read` 出现之前走 `roost.call`（要求 `message:write`，敏感、
 * 安装时二次确认），门槛不该因为拆了个只读端点就降到零。
 */
test('白名单：身份 / 账本 / 投递这类隐私只读不开放给扩展', () => {
  const forbidden = [
    'identity.list', 'identity.resolve',
    'ledger.recent', 'ledger.timeline', 'ledger.stats',
    'msg.get', 'delivery.recent', 'delivery.get',
    'roles.resolve', 'reach.get', 'quota.get',
  ];
  for (const m of forbidden) {
    assert.equal(EXT_ROOST_READONLY.includes(m), false, `${m} 不该在扩展只读白名单里`);
  }
  /** 无害的那些要留着，别一刀切把功能关死 */
  for (const m of ['runtime.status', 'system.hello', 'plugin.list', 'group.info']) {
    assert.equal(EXT_ROOST_READONLY.includes(m), true, `${m} 应该仍然可用`);
  }
});

/**
 * 收紧 `roost.read` **不能把 `roost.call` 一起关掉**（2026-11 复核）。
 *
 * 身份 / 账本 / 投递这些方法本来就要 `message:write` 这道门槛；拆出只读端点
 * 的正确做法是「默认权限够不着，敏感权限仍然够得着」，而不是从白名单里删掉。
 */
test('白名单：roost.call（message:write）仍可调身份 / 账本 / 投递', () => {
  const caps = { has: () => true, list: () => [] };
  for (const m of ['delivery.get', 'msg.get', 'identity.resolve', 'ledger.timeline', 'quota.get']) {
    const r = classifyRoostCall(m, caps);
    assert.equal(r.ok, true, `roost.call 应该仍能调 ${m}`);
    assert.equal(r.kind, 'readonly');
  }
});

test('白名单：roost.read 拒绝这些，并且提示改用 roost.call', () => {
  const caps = { has: () => true, list: () => [] };
  const r = classifyRoostCall('delivery.get', caps, { surface: 'read' });
  assert.equal(r.ok, false);
  assert.match(r.why, /roost\.call/, '要给可操作的提示，不能只说「不存在」');
  /** 无害的只读在 read 面照常放行 */
  assert.equal(classifyRoostCall('runtime.status', caps, { surface: 'read' }).ok, true);
});
