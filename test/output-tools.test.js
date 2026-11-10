/**
 * 输出通道硬保证的回归测试。
 *
 * 2026-11-10 私聊实测：主人要求「一次多发几条」，被动回话轮里
 * `qq_send` 被整批收走，后续几轮也没回来；模型仍按提示词连调两次，
 * 撞 `unknown tool` 后退回正文，只发出一条合并的话。
 *
 * 要盯死的是：**档位 / 人格 / 群覆盖算出来的收走清单，不许把发言出口收掉**；
 * 只有「调用方明确点名」（主动轮）和「用户主动关功能开关」两种来源允许收。
 *
 * 跑法：node --test test/output-tools.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { protectOutputTools, shouldHideOutputPrompt, toolWasDenied, OUTPUT_TOOLS, AWAKE_DENY_TOOLS } from '../src/permissions.js';
import { resolvePolicy } from '../src/capabilities.js';

/** dsh-roost 自己注册的全部 7 个工具 */
const PLUGIN_TOOLS = [
  'chat_look', 'memory_note', 'memory_search', 'qq_close', 'qq_send', 'qq_send_file', 'sticker_pick',
];

test('被动回话轮：人格 tools:[] 也不许收走 qq_send / qq_close', () => {
  const got = protectOutputTools(PLUGIN_TOOLS);
  for (const n of OUTPUT_TOOLS) assert.ok(!got.includes(n), `${n} 不该被收走`);
  assert.deepEqual(got.sort(), [
    'chat_look', 'memory_note', 'memory_search', 'qq_send_file', 'sticker_pick',
  ]);
});

test('主动轮：denyExtra 明确点名时允许收走输出通道', () => {
  const got = protectOutputTools(PLUGIN_TOOLS, { denyExtra: AWAKE_DENY_TOOLS });
  for (const n of AWAKE_DENY_TOOLS) assert.ok(got.includes(n), `${n} 该被收走`);
});

test('用户主动关掉「分段说话」：forceDeny 点名时允许收走', () => {
  const got = protectOutputTools(PLUGIN_TOOLS, { forceDeny: ['qq_send', 'qq_close', 'qq_send_file'] });
  for (const n of OUTPUT_TOOLS) assert.ok(got.includes(n), `${n} 该被收走`);
});

test('forceDeny 只点了一个名字时，另一个输出通道仍然保住', () => {
  const got = protectOutputTools(PLUGIN_TOOLS, { forceDeny: ['qq_send'] });
  assert.ok(got.includes('qq_send'));
  assert.ok(!got.includes('qq_close'), 'qq_close 没被点名，不许顺手收走');
});

test('deny 里只有输出通道时返回空数组（调用方据此判 nothing）', () => {
  assert.deepEqual(protectOutputTools(['qq_send', 'qq_close']), []);
});

test('空 / 脏入参不炸，也不改原数组', () => {
  const src = [...PLUGIN_TOOLS];
  const got = protectOutputTools(src);
  assert.deepEqual(src, PLUGIN_TOOLS, '入参不能被改');
  assert.notEqual(got, src);
  assert.deepEqual(protectOutputTools([]), []);
  assert.deepEqual(protectOutputTools(null), []);
});

test('接真实能力策略：owner + 人格 tools:[] 叠加 AWAKE_DENY 后仍保住输出通道', () => {
  const store = {
    version: 1,
    newTools: 'owner-only',
    defaults: { owner: { allow: ['*'] } },
    groups: {}, chats: {}, skills: { mode: 'self', defaults: {} },
    seen: { tools: {} }, features: {},
  };
  const r = resolvePolicy({
    pool: [...PLUGIN_TOOLS, 'edit', 'read'],
    bucket: 'owner',
    chatId: '',
    personaTools: [],
    store,
    forceDeny: [],
  });
  assert.equal(r.ok, true);
  const protectedDeny = protectOutputTools(r.deny, { denyExtra: [], forceDeny: [] });
  assert.ok(!protectedDeny.includes('qq_send'));
  assert.ok(!protectedDeny.includes('qq_close'));
  assert.ok(protectedDeny.includes('memory_search'), '能力类工具照常收走');
});

/* ---------------- 提示词判据：工具被收走时必须闭嘴 ---------------- */

test('提示词：qq_send 或 qq_close 任一被收走都要整块闭嘴', () => {
  assert.equal(shouldHideOutputPrompt(new Set(['qq_send'])), true);
  assert.equal(shouldHideOutputPrompt(['qq_close']), true);
  assert.equal(shouldHideOutputPrompt(new Set(['qq_send', 'memory_search'])), true);
});

test('提示词：只收能力类工具时发言方式照常注入', () => {
  assert.equal(shouldHideOutputPrompt(new Set(['memory_search', 'chat_look'])), false);
  assert.equal(shouldHideOutputPrompt(new Set()), false);
});

test('提示词：单独关掉发文件不闭嘴，但必须摘掉提到文件工具的两处', () => {
  const denied = new Set(['qq_send_file']);
  assert.equal(shouldHideOutputPrompt(denied), false, '分段发言要留着');
  assert.equal(toolWasDenied(denied, 'qq_send_file'), true, '工具清单那半句和「要发文件就调」那条都得去掉');
  assert.equal(toolWasDenied(denied, 'qq_send'), false, '不能顺手把文字发言也隐掉');
});

test('工具逐条判定：Set / 数组 / 脏入参都稳定', () => {
  assert.equal(toolWasDenied(new Set(['qq_send_file']), 'qq_send_file'), true);
  assert.equal(toolWasDenied(['qq_send_file'], 'qq_send_file'), true);
  assert.equal(toolWasDenied(new Set(['qq_send']), 'qq_send_file'), false);
  for (const v of [null, undefined, {}, 'qq_send_file', 42]) {
    assert.equal(toolWasDenied(v, 'qq_send_file'), false);
  }
});

test('提示词：空 / 脏入参一律按「不闭嘴」处理，不抛异常', () => {
  for (const v of [null, undefined, {}, 'qq_send', 42]) {
    assert.equal(shouldHideOutputPrompt(v), false);
  }
});
