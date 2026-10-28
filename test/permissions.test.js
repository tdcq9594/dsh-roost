/**
 * 权限档位 → 工具收走的测试。
 *
 * 盯的是一个**看不见的** bug：`tools.restrict({ deny })` 会校验工具名，
 * 只要有一个名字不存在就整批拒绝（`names unknown global tools …`）。
 * 我们之前写死的 `['bash','pwsh','shell','fs',…]` 是按 OneBot 时代想象的，
 * 这版 DSH 里一个都没有——于是「群友只能用聊天」这条硬限制**从来没生效过**，
 * 而且失败被日志层吞掉，面板上只剩一个空白的冒号。
 *
 * 所以这里测的不是「名字对不对」（那是 DSH 的事），而是：
 * 清单必须来自 DSH、白名单之外一律收走、读不到清单要**明说没收成**而不是装作收住了。
 *
 * 跑法：node --test test/permissions.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planGuestTools, GUEST_KEEP_TOOLS } from '../src/permissions.js';

/** 这版 DSH 真实报出来的全局工具（2026-10-28 面板日志里抄的） */
const REAL_TOOLS = [
  'edit', 'list_mcp_resource_templates', 'list_mcp_resources', 'load_workspace_dependencies',
  'mcp__graphflow__gf_edit', 'mcp__graphflow__gf_exec', 'mcp__graphflow__gf_macro',
  'mcp__graphflow__gf_read', 'ops_read_files', 'pwd', 'read', 'read_image',
  'read_mcp_resource', 'working_directory', 'write',
];

const fakeTools = (names) => ({ schemas: () => names.map((name) => ({ name })) });

test('真实清单：除了白名单全收走', () => {
  const plan = planGuestTools(fakeTools(REAL_TOOLS));
  assert.equal(plan.ok, true);
  for (const n of REAL_TOOLS) assert.ok(plan.deny.includes(n), `${n} 应该被收走`);
  assert.equal(plan.deny.length, REAL_TOOLS.length);
});

test('白名单里的工具不会被收走', () => {
  const all = [...REAL_TOOLS, ...GUEST_KEEP_TOOLS];
  const plan = planGuestTools(fakeTools(all));
  assert.equal(plan.ok, true);
  for (const n of GUEST_KEEP_TOOLS) assert.ok(!plan.deny.includes(n), `${n} 不该被收走`);
});

test('自己注册的工具只要不在白名单里，一样收走', () => {
  // memory_note 是写长期记忆的，给群友等于允许往记忆里投毒
  const plan = planGuestTools(fakeTools([...REAL_TOOLS, 'memory_note']));
  assert.equal(plan.ok, true);
  assert.ok(plan.deny.includes('memory_note'));
});

test('DSH 以后加了新工具，默认也是收走的（fail-closed）', () => {
  const plan = planGuestTools(fakeTools([...REAL_TOOLS, 'some_new_shell_tool']));
  assert.equal(plan.ok, true);
  assert.ok(plan.deny.includes('some_new_shell_tool'));
});

test('旧黑名单那串名字：现在一个都不会出现在 deny 里', () => {
  // 这些名字 DSH 根本没有，硬塞进去会让 restrict 整批抛错
  const plan = planGuestTools(fakeTools(REAL_TOOLS));
  for (const n of ['bash', 'pwsh', 'shell', 'fs', 'fs-search', 'fs_search', 'web', 'web-fetch']) {
    assert.ok(!plan.deny.includes(n), `${n} 不该出现——DSH 没有这个工具`);
  }
});

test('没有 schemas()：明说收不成，不装作收住了', () => {
  assert.equal(planGuestTools({ restrict() {} }).ok, false);
  assert.match(planGuestTools({ restrict() {} }).reason, /schemas/);
});

test('schemas() 抛错：给出原因', () => {
  const plan = planGuestTools({ schemas() { throw new Error('服务没就绪'); } });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /服务没就绪/);
});

test('清单是空的：明说没收成', () => {
  const plan = planGuestTools(fakeTools([]));
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /空/);
});

test('清单里全是白名单：没有可收的，也明说', () => {
  const plan = planGuestTools(fakeTools([...GUEST_KEEP_TOOLS]));
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /白名单/);
});

test('schemas() 返回的不是数组也不炸', () => {
  const plan = planGuestTools({ schemas: () => null });
  assert.equal(plan.ok, false);
});

test('工具项没有 name 的会被跳过，不会算出空字符串', () => {
  const plan = planGuestTools({ schemas: () => [{ name: 'write' }, {}, null, { name: '' }] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.deny, ['write']);
});

test('兼容 { tool: { name } } 这种包装', () => {
  const plan = planGuestTools({ schemas: () => [{ tool: { name: 'edit' } }] });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.deny, ['edit']);
});

test('可以自己传白名单（给以后别的档位用）', () => {
  const plan = planGuestTools(fakeTools(['edit', 'read', 'pwd']), ['read']);
  assert.deepEqual(plan.deny, ['edit', 'pwd']);
});
