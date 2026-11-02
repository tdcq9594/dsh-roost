// 工具 schema 必须落在 DSH 支持的子集里，否则**注册即被拒**。
//
// 新版 DSH 对「裸 JSON Schema」有一道严格子集校验：凡是 `type: 'object'` 的
// 节点，`additionalProperties` 必须显式写成布尔值。缺了会抛
//
//   unsupported JSON schema: schema.additionalProperties must be explicitly true or false
//
// 而 `registerMemoryTools` 是**第一个失败就 return**，所以面板上只看得到
// `memory_search` 挂了，其余工具的名字根本不会出现——很容易误判成
// 「只有记忆工具坏了」，其实是同一份 schema 写法全都缺。
//
// 2026-11-02 线上踩到：本机 `import('@deepseek-ai/dsh-tools')` 解析不到
// （那个包打包在 DSH 的 app.asar 里），一直走普通对象那条路，没暴露；
// 别人的机器上 defineTool 解析成功，一注册就炸。
//
// 这条测试不针对某一个工具，而是把所有工具定义**真的构建出来**再遍历一遍：
// 以后谁加新工具忘了写这个字段，`node --test` 直接红，不用等用户报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildToolDefs, toJsonSchema } from '../src/tools.js';
import { buildQqToolDefs } from '../src/qq-tools.js';
import { buildStickerToolDefs } from '../src/sticker-tools.js';

/**
 * 把三类工具都造出来。
 *
 * 参数全给最小可用的假实现——这条测试只看**形状**，不看行为。
 * 但每个回调都得给：少给一个，对应工具就不会注册，于是它被静默跳过，
 * 测试照样绿（假绿）。所以下面还有一条专门断言「工具数量对得上」。
 */
function allToolDefs() {
  const caller = () => ({ bucket: 'owner', chatId: 'G1' });
  return [
    ...buildToolDefs({
      journal: {},
      graphOf: () => ({}),
      callerOf: caller,
      cfgOf: () => ({}),
    }),
    ...buildQqToolDefs({
      callerOf: caller,
      sendOf: async () => ({}),
      closeOf: async () => ({}),
      fileOf: async () => ({}),
      cfgOf: () => ({}),
      stateOf: () => ({ parts: 0 }),
    }),
    ...buildStickerToolDefs({ pickOf: async () => ({}) }),
  ];
}

/**
 * 递归找出「`type: 'object'` 但 `additionalProperties` 不是显式布尔」的节点。
 *
 * 判据逐字照抄 DSH 那边的校验：`Object.hasOwn` + `typeof === 'boolean'`。
 * 用 `'additionalProperties' in schema` 判断是不够的——继承来的属性也会命中，
 * 那样会漏掉真正缺字段的情况。
 */
function offenders(schema, path = 'schema', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => offenders(s, `${path}[${i}]`, out));
    return out;
  }
  if (schema.type === 'object') {
    const ok =
      Object.hasOwn(schema, 'additionalProperties') &&
      typeof schema.additionalProperties === 'boolean';
    if (!ok) out.push(path);
  }
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties') continue;
    // `properties` 是个「名字 → 子 schema」的映射，不是 schema 本身，
    // 直接递归进去按对象处理会把它自己当成一个 object 节点来判
    if (k === 'properties' && v && typeof v === 'object') {
      for (const [name, sub] of Object.entries(v)) offenders(sub, `${path}.properties.${name}`, out);
      continue;
    }
    offenders(v, `${path}.${k}`, out);
  }
  return out;
}

test('工具 schema：能造出全部 6 个工具', () => {
  const defs = allToolDefs();
  const names = defs.map((d) => d.name).sort();
  assert.deepEqual(
    names,
    ['memory_note', 'memory_search', 'qq_close', 'qq_send', 'qq_send_file', 'sticker_pick'],
    '少一个就说明某个回调没给全，下面那条 schema 检查会因此少查一个工具（假绿）',
  );
});

test('工具 schema：output.schema 的每个 object 节点都显式声明 additionalProperties', () => {
  const bad = [];
  for (const d of allToolDefs()) {
    const v = offenders(d.output?.schema, `${d.name}.output.schema`);
    if (v.length) bad.push(...v);
  }
  assert.deepEqual(bad, [], `这些节点缺 additionalProperties，注册会被拒：\n${bad.join('\n')}`);
});

test('工具 schema：toJsonSchema 产出的 object 节点也合规（普通对象注册路径）', () => {
  const bad = [];
  for (const d of allToolDefs()) {
    const v = offenders(toJsonSchema(d.parameters), `${d.name}.parameters`);
    if (v.length) bad.push(...v);
  }
  assert.deepEqual(bad, [], `这些节点缺 additionalProperties，普通对象那条路会被拒：\n${bad.join('\n')}`);
});

/**
 * **审查器自己的自测。**
 *
 * 上面三条全靠 `offenders()` 找问题。如果它写错了（比如判断条件写反、
 * 或者把 `properties` 当普通对象递归进去），它就会永远返回空数组，
 * 三条测试全部假绿——而假的绿灯比没有测试更糟，它让人以为这块有人守。
 *
 * 所以喂它两个已知答案的 schema：一个缺字段必须被报出来，一个齐全必须干净。
 */
test('工具 schema：审查器能真的抓到缺字段（防止自己写错导致假绿）', () => {
  assert.deepEqual(
    offenders({ type: 'object', properties: {} }, 'x'),
    ['x'],
    '缺 additionalProperties 的 object 必须被报出来',
  );
  assert.deepEqual(
    offenders(
      { type: 'object', additionalProperties: false, properties: { a: { type: 'object' } } },
      'x',
    ),
    ['x.properties.a'],
    '嵌套在 properties 里的 object 也要能抓到，并给出可定位的路径（外层故意写全，只验嵌套）',
  );
  assert.deepEqual(
    offenders({ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, 'x'),
    [],
    '写全了的不能误报',
  );
  assert.deepEqual(
    offenders({ type: 'object', additionalProperties: 'true' }, 'x'),
    ['x'],
    '字符串 "true" 不算——DSH 判的是 typeof === boolean',
  );
});
