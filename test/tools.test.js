// 记忆工具：权限矩阵是这块唯一真正重要的东西。
//
// 功能错了顶多是"查不到"，权限错了是"群友能往长期记忆里写东西"——
// 后者会被用来投毒（写一句"主人讨厌张三"，以后每轮都注入），
// 而且不会报错、不会有人发现。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildToolDefs, registerMemoryTools, toJsonSchema, shapeTool } from '../src/tools.js';

/** 造一个只看权限的假环境 */
function rig({ bucket = 'member', chatId = 'g1', enabled = true, searchRows = [] } = {}) {
  const added = [];
  const searched = [];
  const journal = {
    async search(q, opts) {
      searched.push({ q, opts });
      return searchRows;
    },
    add(row) {
      added.push(row);
      return { added: true, level: row.level };
    },
  };
  const defs = buildToolDefs({
    journal,
    graphOf: () => ({ nowEdges: () => [] }),
    callerOf: () => ({ bucket, chatId }),
    cfgOf: () => ({ memory: { enabled } }),
  });
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  return { byName, added, searched, journal };
}

test('工具：两个都在，名字固定', () => {
  const { byName } = rig();
  assert.deepEqual(Object.keys(byName).sort(), ['memory_note', 'memory_search']);
});

test('工具：群友不能写长期记忆', async () => {
  const { byName, added } = rig({ bucket: 'member' });
  const r = await byName.memory_note.execute({ text: '主人讨厌张三' });
  assert.equal(r.ok, false);
  assert.match(r.message, /只有主人/);
  assert.equal(added.length, 0, '一个字都不该落盘');
});

test('工具：管理员也不能写（写记忆是主人的权力）', async () => {
  const { byName, added } = rig({ bucket: 'admin' });
  const r = await byName.memory_note.execute({ text: '随便记一句' });
  assert.equal(r.ok, false);
  assert.equal(added.length, 0);
});

test('工具：主人能写，且只能写 normal / important', async () => {
  const { byName, added } = rig({ bucket: 'owner' });
  await byName.memory_note.execute({ text: '他说下周三前给答复', level: 'critical' });
  assert.equal(added.length, 1);
  assert.equal(added[0].level, 'normal', 'critical 不在可写档位里，降级为 normal');
});

test('工具：群友检索不跨群', async () => {
  const { byName, searched } = rig({ bucket: 'member' });
  await byName.memory_search.execute({ query: '杭州', scope: 'global' });
  assert.equal(searched[0].opts.crossCritical, false, '群友即使要 global 也只给本群');
});

test('工具：主人检索可以跨群', async () => {
  const { byName, searched } = rig({ bucket: 'owner' });
  await byName.memory_search.execute({ query: '杭州', scope: 'global' });
  assert.equal(searched[0].opts.crossCritical, true);
});

test('工具：群友的检索结果不带 sender（否则会漏出别的群的人名）', async () => {
  const rows = [{ id: 'a', at: Date.now(), level: 'normal', text: '张三说他要辞职', role: 'user', sender: '张三' }];
  const { byName } = rig({ bucket: 'member', searchRows: rows });
  const r = await byName.memory_search.execute({ query: '辞职' });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].who, undefined);
  assert.ok(r.results[0].text.includes('辞职'));
});

test('工具：主人的检索结果带 who，方便判断可信度', async () => {
  const rows = [{ id: 'a', at: Date.now(), level: 'normal', text: '张三说他要辞职', role: 'user', sender: '张三' }];
  const { byName } = rig({ bucket: 'owner', searchRows: rows });
  const r = await byName.memory_search.execute({ query: '辞职' });
  assert.equal(r.results[0].who, '张三');
});

test('工具：空查询本地就挡，不去查库', async () => {
  const { byName, searched } = rig();
  const r = await byName.memory_search.execute({ query: '   ' });
  assert.equal(r.ok, false);
  assert.equal(searched.length, 0);
});

test('工具：记忆关着时检索直接说清楚，不返回空列表', async () => {
  const { byName } = rig({ enabled: false });
  const r = await byName.memory_search.execute({ query: '杭州' });
  assert.equal(r.ok, false);
  assert.match(r.message, /关着/);
});

test('工具：查不到时给一句"可以说不知道"，而不是编', async () => {
  const { byName } = rig({ searchRows: [] });
  const r = await byName.memory_search.execute({ query: '不存在的事' });
  assert.equal(r.count, 0);
  assert.match(r.hint, /不记得/);
});

/* ---------------- 注册 ---------------- */

test('注册：agent 没有 tools 服务时明确失败，不抛错', async () => {
  const r = await registerMemoryTools({
    agent: { ctx: {} },
    journal: { add: () => ({ added: true }) },
    graphOf: () => ({}),
    callerOf: () => ({ bucket: 'owner' }),
    cfgOf: () => ({}),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /register/);
});

test('注册：有 registry 时把两个工具都注册进去，并能干净卸掉', async () => {
  const registered = [];
  const disposed = [];
  const agent = {
    ctx: {
      tools: {
        register(tool) {
          registered.push(tool.name);
          return () => disposed.push(tool.name);
        },
      },
    },
  };
  const r = await registerMemoryTools({
    agent,
    journal: { add: () => ({ added: true }), search: async () => [] },
    graphOf: () => ({}),
    callerOf: () => ({ bucket: 'owner' }),
    cfgOf: () => ({}),
    log: () => {},
  });
  assert.equal(r.ok, true);
  assert.deepEqual(registered.sort(), ['memory_note', 'memory_search']);
  r.off();
  assert.equal(disposed.length, 2, '插件停用时必须把工具收回，否则重载会重复注册');
});

test('注册：注册抛错时返回失败原因（不许静默吞掉）', async () => {
  const agent = {
    ctx: {
      tools: {
        register() {
          throw new Error('schema 不合法');
        },
      },
    },
  };
  const r = await registerMemoryTools({
    agent,
    journal: { add: () => ({ added: true }) },
    graphOf: () => ({}),
    callerOf: () => ({ bucket: 'owner' }),
    cfgOf: () => ({}),
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /schema 不合法/);
});

/**
 * render 必须返回**内容块数组**，不能是字符串。
 *
 * 真实事故：render 返回 ''，DSH 对 content 调 `.some()` 时炸成
 * `content.some is not a function`，模型看到「接口报错了」，
 * 两轮记忆检索全挂在结果投影这一步——执行本身是成功的。
 */
test('工具：render 返回内容块数组（字符串会让 DSH 的 content.some 炸掉）', () => {
  const { byName } = rig();
  for (const name of ['memory_search', 'memory_note']) {
    const rendered = byName[name].output.render({}, { ok: true });
    assert.ok(Array.isArray(rendered), `${name}.output.render 必须返回数组`);
    for (const block of rendered) {
      assert.equal(typeof block, 'object', '内容块必须是对象');
      assert.ok('type' in block && 'text' in block, `内容块缺 type/text：${JSON.stringify(block)}`);
    }
  }
});

/* ---------------- 参数表：两种注册路径两种形状 ---------------- */

/**
 * 这块盯的是一个**只在别人机器上出现**的故障。
 *
 * DSH 的 `defineTool` 要扁平参数表（参数名当键、`required` 写在参数身上），
 * 而 `ctx.tools.register` 的普通对象要标准 JSON Schema。以前只写了后者：
 * 本机解析不到 `@deepseek-ai/dsh-tools`（打包在 app.asar 里），走普通对象
 * 那条路，一直没暴露；别人的机器上 defineTool 解析成功，注册器把
 * `parameters` 当「参数名 → schema」遍历，撞到键 `type` 的值是 `'object'`：
 *
 *   unsupported JSON schema: parameters.type must be a value schema object
 */
test('参数表：扁平 map 转成标准 JSON Schema', () => {
  const flat = {
    query: { type: 'string', required: true, description: '查什么' },
    scope: { type: 'string', enum: ['chat', 'global'], description: '范围' },
  };
  assert.deepEqual(toJsonSchema(flat), {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查什么' },
      scope: { type: 'string', enum: ['chat', 'global'], description: '范围' },
    },
    required: ['query'],
  });
});

test('参数表：没有必填项时不出现空的 required 数组', () => {
  const out = toJsonSchema({ a: { type: 'string' } });
  assert.equal(out.required, undefined, '空 required 数组在某些校验器里是非法写法');
});

test('参数表：转换不丢 enum / description', () => {
  const out = toJsonSchema({ lv: { type: 'string', enum: ['a', 'b'], description: 'd' } });
  assert.deepEqual(out.properties.lv, { type: 'string', enum: ['a', 'b'], description: 'd' });
});

test('参数表：有 defineTool 就原样交给它，不再转换', () => {
  let got = null;
  const fakeDefine = (def) => {
    got = def;
    return { ...def, marker: true };
  };
  const def = { name: 'x', parameters: { a: { type: 'string', required: true } } };
  const tool = shapeTool(def, fakeDefine);
  assert.equal(tool.marker, true);
  assert.equal(got.parameters.a.type, 'string', 'defineTool 拿到的是扁平表，不是 JSON Schema');
  assert.equal(got.parameters.type, undefined);
});

test('参数表：没有 defineTool 就转成 JSON Schema 交普通对象', () => {
  const def = { name: 'x', parameters: { a: { type: 'string', required: true } } };
  const tool = shapeTool(def, null);
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['a']);
  assert.equal(tool.parameters.properties.a.type, 'string');
  assert.equal(def.parameters.type, undefined, '不能就地改掉原定义');
});

test('参数表：四个工具的 parameters 都是扁平表', () => {
  const rigged = rig();
  for (const d of buildToolDefs(rigged)) {
    assert.equal(d.parameters.type, undefined, `${d.name} 是标准 JSON Schema`);
    for (const [k, v] of Object.entries(d.parameters)) {
      assert.ok(v.type, `${d.name}.${k} 缺 type`);
    }
  }
});

test('注册：工具名被别的插件占了，要指名道姓地说清，而不是含糊报错', async () => {
  let registerCalled = false;
  const agent = {
    ctx: {
      tools: {
        schemas: () => [{ name: 'memory_search' }, { name: 'other_tool' }],
        register() {
          registerCalled = true;
          throw new Error('already registered');
        },
      },
    },
  };
  const r = await registerMemoryTools({
    agent,
    journal: { add: () => ({ added: true }), search: async () => [] },
    graphOf: () => ({}),
    callerOf: () => ({ bucket: 'owner' }),
    cfgOf: () => ({}),
    log: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /被占用/);
  assert.match(r.reason, /memory_search/);
  assert.equal(registerCalled, false, '预检命中就不该再去注册，避免半套工具');
});
