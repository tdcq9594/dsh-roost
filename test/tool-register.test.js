/**
 * 注册链路：工具到底有没有进 `ctx.tools`。
 *
 * 为什么单独测这一层：`buildXxxTool()` 的用例再多，也只证明「造得出来」。
 * 真正决定「模型能不能看到这个工具」的是注册这一段——它的失败被 `mount()`
 * 用 `log.warn` 兜住，界面上什么都不显示，表现是「她根本不知道有这个能力」，
 * 而日志里只有一行警告。这层以前没有用例。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerMenuTool, createSlotStore } from '../src/menu-tool.js';
import { registerProfileTools } from '../src/profile-tool.js';
import { createHistory, normalizeSelfExpression } from '../src/self-expression.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-reg-'));
  return {
    dir,
    done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/** 假 agent：只提供 `ctx.tools.register`，把拿到的东西记下来 */
function fakeAgent() {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: {
        register(tool) {
          registered.push(tool);
          return () => {}; // off
        },
      },
    },
  };
}

function deps(dir) {
  return {
    rpc: async () => ({}),
    cfgOf: () => ({ selfExpression: normalizeSelfExpression({}) }),
    slots: createSlotStore({ dataDir: () => dir }),
    history: createHistory({ dataDir: () => dir }),
    callerOf: () => ({ sid: 's1', bucket: 'owner', senderId: 'u1', kind: 'c2c' }),
    personaOf: () => ({ id: 'main', selfName: '' }),
    syncPersonaName: () => {},
    audit: () => {},
    log: () => {},
  };
}

test('N1 注册菜单工具：名字是 qq_menu，且真的调了 register', async () => {
  const { dir, done } = fresh();
  try {
    const agent = fakeAgent();
    const r = await registerMenuTool({ agent, ...deps(dir) });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.names, ['qq_menu']);
    assert.equal(agent.registered.length, 1);
    assert.equal(agent.registered[0].name, 'qq_menu');
    assert.equal(typeof agent.registered[0].execute, 'function');
  } finally { done(); }
});

test('N2 注册资料工具：三个都进 schema（这是「模型看不看得见」的关键一步）', async () => {
  const { dir, done } = fresh();
  try {
    const agent = fakeAgent();
    const r = await registerProfileTools({ agent, kinds: ['sign', 'name', 'avatar'], ...deps(dir) });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.names, ['qq_sign', 'qq_name', 'qq_avatar']);
    assert.deepEqual(agent.registered.map((t) => t.name), ['qq_sign', 'qq_name', 'qq_avatar']);
    for (const t of agent.registered) {
      assert.equal(t.parameters?.type, 'object', `${t.name} 的参数要是 JSON Schema`);
      assert.ok(t.parameters?.properties, `${t.name} 的 properties 不能空`);
    }
  } finally { done(); }
});

test('N3 只开一项时只注册那一项（关掉的不是「拒绝调用」，是根本不出现）', async () => {
  const { dir, done } = fresh();
  try {
    const agent = fakeAgent();
    const r = await registerProfileTools({ agent, kinds: ['sign'], ...deps(dir) });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.names, ['qq_sign']);
    assert.equal(agent.registered.length, 1, '关掉的工具不许占位');
  } finally { done(); }
});

test('N4 没有 tools.register（版本差异）→ 明确回失败，不抛', async () => {
  const { dir, done } = fresh();
  try {
    const r = await registerMenuTool({ agent: { ctx: {} }, ...deps(dir) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /register/);
  } finally { done(); }
});

test('N5 register 抛异常 → 包成 ok:false，带工具名', async () => {
  const { dir, done } = fresh();
  try {
    const agent = { ctx: { tools: { register() { throw new Error('duplicate tool name'); } } } };
    const r = await registerMenuTool({ agent, ...deps(dir) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /qq_menu/);
    assert.match(r.reason, /duplicate/);
  } finally { done(); }
});
