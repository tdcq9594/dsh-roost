/**
 * 四形态统一注册表守门。
 * 跑法：node --test test/ext-forms.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  createFormRegistry, formOf, BUILTIN_CAPABILITIES,
} from '../src/ext-forms.js';
import { CORE_POINTS } from '../src/ext-tier.js';

const installed = (...rows) => () => rows.map((r) => ({
  id: r.id, manifest: r.manifest, dir: `/ext/${r.id}`, source: { repo: 'x' }, foreign: false,
}));

test('形态推断：显式 form 优先，未声明按实际运行形态，未知退回 mcp', () => {
  assert.equal(formOf({ form: 'builtin' }), 'builtin');
  assert.equal(formOf({ form: 'core' }), 'core');
  assert.equal(formOf({ form: 'wasm' }), 'mcp');
  assert.equal(formOf({ builtin: true }), 'builtin');
  assert.equal(formOf({ ui: { runtime: 'inprocess' } }), 'inprocess');
  assert.equal(formOf({}), 'mcp', '存量扩展零改动');
  assert.equal(formOf({ form: 'mcp', ui: { runtime: 'inprocess' } }), 'mcp', '显式声明优先');
});

test('内置能力清单登记完整，point 都能对上 CORE_POINTS', () => {
  assert.ok(BUILTIN_CAPABILITIES.length >= 5);
  for (const b of BUILTIN_CAPABILITIES) {
    assert.ok(b.id && b.label, '内置能力要有 id 和人话名字');
    assert.ok(CORE_POINTS[b.point], `${b.id} 的 point「${b.point}」不在 CORE_POINTS 里`);
  }
  assert.ok(BUILTIN_CAPABILITIES.some((b) => b.id === 'memory'), '记忆系统要登记，后续第一个解离');
});

test('统一视图：内置 + 外部扩展同表，内置不可停用也不可卸载', () => {
  const r = createFormRegistry({ listInstalled: installed({ id: 'bili', manifest: { id: 'bili', name: '刷 B 站', scopes: ['state:read'] } }) });
  const rows = r.snapshot();
  assert.ok(rows.some((x) => x.id === 'memory' && x.form === 'builtin' && x.enabled === true && x.removable === false));
  assert.ok(rows.some((x) => x.id === 'bili' && x.form === 'mcp' && x.removable === true));
  assert.equal(r.setEnabled('memory', false).ok, false, '内建程序不许停用');
  assert.match(r.setEnabled('memory', false).why, /解离/);
  assert.equal(r.get('memory').enabled, true);
});

test('外部扩展启停可回滚，并有生命周期事件', () => {
  const events = [];
  const r = createFormRegistry({ listInstalled: installed({ id: 'bili', manifest: { id: 'bili' } }) });
  const off = r.onChange((kind, e) => events.push({ kind, id: e.id }));
  assert.equal(r.setEnabled('bili', false, { reason: '主人手动关掉' }).ok, true);
  assert.equal(r.get('bili').enabled, false);
  assert.equal(r.get('bili').changeReason, '主人手动关掉');
  assert.equal(r.setEnabled('bili', true).ok, true);
  assert.equal(r.get('bili').enabled, true);
  assert.deepEqual(events.map((x) => x.kind), ['disable', 'enable']);
  off();
  r.setEnabled('bili', false);
  assert.equal(events.length, 2, '取消订阅后不再收事件');
});

test('内置命名空间不可被外部扩展占用', () => {
  const logs = [];
  const r = createFormRegistry({
    listInstalled: installed({ id: 'memory', manifest: { id: 'memory', name: '冒充记忆', scopes: ['core:write'] } }),
    log: (m) => logs.push(m),
  });
  assert.equal(r.get('memory').form, 'builtin');
  assert.equal(r.get('memory').name, '记忆系统');
  assert.ok(logs.some((m) => /同名/.test(m)));
});

test('分级联动：声明接管记忆的扩展在视图里是 L3，需二次确认', () => {
  const r = createFormRegistry({
    listInstalled: installed({
      id: 'my-memory',
      manifest: { id: 'my-memory', name: '我的记忆', form: 'core', scopes: ['memory:write'], overrides: ['memory'] },
    }),
  });
  const e = r.get('my-memory');
  assert.equal(e.form, 'core');
  assert.equal(e.tier.id, 'L3');
  assert.equal(e.tier.confirm, 'type-name');
  assert.match(r.snapshot().find((x) => x.id === 'my-memory').tierLabel, /核心接管/);
});

test('按形态 / 等级 / 启停过滤，refresh 会反映新装的扩展', () => {
  let rows = [{ id: 'a', manifest: { id: 'a', scopes: ['agent:write'] } }];
  const r = createFormRegistry({ listInstalled: () => rows.map((x) => ({ ...x, dir: '/ext/' + x.id })) });
  assert.equal(r.list({ tier: 'L2' }).length, 1);
  assert.equal(r.list({ form: 'builtin' }).length, BUILTIN_CAPABILITIES.length);
  rows.push({ id: 'b', manifest: { id: 'b', ui: { runtime: 'inprocess' } } });
  r.refresh();
  assert.equal(r.list({ form: 'inprocess' }).length, 1);
  assert.equal(r.list({ enabled: true }).length, rows.length + BUILTIN_CAPABILITIES.length);
});

test('停用的扩展在 refresh 后仍保持停用状态', () => {
  const r = createFormRegistry({ listInstalled: installed({ id: 'bili', manifest: { id: 'bili' } }) });
  r.setEnabled('bili', false);
  r.refresh();
  assert.equal(r.get('bili').enabled, false);
});

test('宿主接了四形态注册表，且只暴露只读总览（静态守门）', () => {
  const src = fs.readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(src, /createFormRegistry\(\{/, '注册表要在 host.js 里真建实例，不能只留个模块');
  assert.match(src, /listInstalled: \(\) => extRegistry\.list\(\)/, '已装扩展要从注册表读，不能另造一份清单');
  assert.match(src, /case 'extensions\.forms'/, '面板要有总览 op');
  assert.ok(!/extensions\.forms\.toggle/.test(src),
    '停用还没接加载闸门，现在暴露开关会让人以为关掉了其实没关');
});
