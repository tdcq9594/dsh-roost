/**
 * C1 素材范围（审查 §11）：主动消息也要进 journal，但用独立 kind。
 *
 * 背景：报告 §15-C1 假设「主动消息已进 journal」，实际只有被动回复写
 * `role='bot'`；`sendOut` 只记 events / closing.pending。于是 C1 的
 * `recentBot` 看不到自己上次主动说过什么，主动搭话之间互相重复防不住。
 *
 * 修法（方案 A）：`sendOut` 明确送达后写 `kind='proactive'` 的 bot 行；
 * C1 取数时 `chat` + `proactive` 合并；凌晨巩固只取 `kind='chat'`，
 * 所以主动话不会被提炼成事实/摘要。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('接线：sendOut 只在明确送达时写 proactive，C1 取数合并两个 kind', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const at = src.indexOf('const sendOut = async');
  assert.ok(at > 0, '没找到 sendOut');
  const block = src.slice(at, src.indexOf('return r;', at));
  assert.match(block, /r\?\.ok && !r\.pending/, 'pending 不能写：还没确定送到，写了就是「她以为说过」');
  assert.match(block, /kind: 'proactive'/);
  assert.match(block, /journalAdd\(/, '要复用写日记的关口（剥标记 + 记忆开关）');
  /** 取数已抽到 `wake-context.js`（纯函数，有真库测试），host 只负责调用 */
  assert.match(src, /wakeContext\(/, 'host 要走统一的取数函数');
  const wc = readFileSync(new URL('../src/wake-context.js', import.meta.url), 'utf8');
  assert.match(wc, /'chat'/, 'C1 仍要取对话原文');
  assert.match(wc, /'proactive'/, 'C1 必须同时取主动话，否则防复读仍然看不到');
});

test('巩固只取 kind=chat，主动话不会被提炼成事实/摘要', () => {
  const src = readFileSync(new URL('../src/consolidate.js', import.meta.url), 'utf8');
  assert.ok(src.includes("r.kind === 'chat' && r.role === 'user'"), '用户素材只认 chat');
  assert.ok(src.includes("r.role === 'bot' && r.kind === 'chat'"), 'bot 回声只认 chat');
});
