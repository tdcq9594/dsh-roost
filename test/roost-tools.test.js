// 方案 A 的宿主侧：框架插件工具必须能被模型发现并调用，且权限不放大。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoostToolDefs, registerRoostTools } from '../src/roost-tools.js';
import { READONLY_METHODS } from '../src/roost-capabilities.js';

const DYNAMIC = [
  { name: 'tool.roll_dice', scope: 'message', desc: '[插件工具·dice] 掷骰子', parameters: { type: 'object', properties: { sides: { type: 'integer' } }, required: ['sides'] } },
];

function fakeCaps(over = {}) {
  const calls = [];
  return {
    calls,
    list: () => READONLY_METHODS.map((m) => ({ name: m.name, scope: 'read', desc: m.desc })).concat(DYNAMIC),
    available: () => READONLY_METHODS,
    dynamic: () => DYNAMIC,
    async call(name, params) {
      calls.push([name, params]);
      if (over.fail) throw new Error(over.fail);
      return { ok: true, name, params };
    },
  };
}

function defs(opts = {}) {
  const caps = opts.caps ?? fakeCaps();
  const map = new Map(buildRoostToolDefs({ caps, callerOf: () => ({ bucket: opts.bucket ?? 'member' }) })
    .map((d) => [d.name, d]));
  return { caps, map };
}

test('工具定义：四个工具都在，参数是 DSH 的扁平表形状', () => {
  const { map } = defs();
  assert.deepEqual([...map.keys()], ['roost_tools', 'roost_tool', 'roost_status', 'roost_delivery']);
  assert.equal(map.get('roost_tool').parameters.name.required, true);
  assert.equal(map.get('roost_tool').parameters.args.type, 'object');
  assert.equal(map.get('roost_tool').parameters.args.additionalProperties, true, '嵌套 object 必须显式声明');
});

test('roost_tools：列出内置只读能力与插件工具（带参数说明），可按名字过滤', async () => {
  const { map } = defs();
  const all = await map.get('roost_tools').execute({});
  assert.equal(all.ok, true);
  assert.equal(all.connected, true);
  assert.ok(all.builtin.some((m) => m.name === 'runtime.status'));
  assert.ok(!all.builtin.some((m) => m.name === 'config.set'));
  assert.equal(all.pluginTools[0].name, 'tool.roll_dice');
  assert.equal(all.pluginTools[0].parameters.required[0], 'sides');
  const filtered = await map.get('roost_tools').execute({ filter: 'delivery' });
  assert.ok(filtered.builtin.every((m) => m.name.includes('delivery')));
});

test('roost_tool：插件工具按名字调用，参数原样带过去', async () => {
  const { caps, map } = defs();
  const r = await map.get('roost_tool').execute({ name: 'tool.roll_dice', args: { sides: 20 } });
  assert.equal(r.ok, true);
  assert.deepEqual(caps.calls[0], ['tool.roll_dice', { sides: 20 }]);
});

test('roost_tool：敏感只读能力只给 owner/admin，普通成员被挡在调用之前', async () => {
  const { caps, map } = defs({ bucket: 'member' });
  const denied = await map.get('roost_tool').execute({ name: 'runtime.logs', args: {} });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /只有主人或管理员/);
  assert.equal(caps.calls.length, 0, '不该真的打到框架');

  const { map: owner } = defs({ bucket: 'owner' });
  const ok = await owner.get('roost_tool').execute({ name: 'runtime.logs', args: { limit: 5 } });
  assert.equal(ok.ok, true);
});

test('roost_tool：写方法被能力层拒绝，工具回结构化失败而不是抛异常', async () => {
  const caps = {
    ...fakeCaps(),
    call: async (name) => { throw new Error(`不允许通过 AI 工具调用 ${name}`); },
  };
  const { map } = defs({ caps });
  const r = await map.get('roost_tool').execute({ name: 'config.set', args: {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /不允许/);
});

test('roost_status / roost_delivery：单项失败不影响其它项，且带 limit 上限', async () => {
  const { caps, map } = defs();
  const st = await map.get('roost_status').execute({});
  assert.equal(st.ok, true);
  assert.deepEqual(caps.calls.map((c) => c[0]), ['runtime.status', 'gate.get']);
  const dl = await map.get('roost_delivery').execute({ limit: 99999 });
  assert.equal(dl.ok, true);
  assert.equal(caps.calls.at(-1)[1].limit, 200);
});

test('注册：四个工具真的挂到 agent，off 能整组撤销；没有 registry 时明说原因', async () => {
  const registered = [];
  const registry = {
    register(def) {
      registered.push(def);
      return () => { const i = registered.indexOf(def); if (i >= 0) registered.splice(i, 1); };
    },
  };
  const r = await registerRoostTools({ agent: { ctx: { tools: registry } }, caps: fakeCaps() });
  assert.equal(r.ok, true);
  assert.equal(registered.length, 4);
  r.off();
  assert.equal(registered.length, 0);

  const no = await registerRoostTools({ agent: { ctx: {} }, caps: fakeCaps() });
  assert.equal(no.ok, false);
  assert.match(no.reason, /没有 register/);
});
