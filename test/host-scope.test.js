// 入站链路的作用域守卫。
//
// 2026-11-13 实机踩到：`onInbound` 是 `startServer()` 的**局部函数**，而
// `deliverBatch()`（外接协议收到消息那条路，11-12 加的）在 apply 作用域里调它。
// 结果每条消息都抛 `onInbound is not defined`，又被 `roostMerger.onFlush` 的
// `.catch()` 吞成一行 warn —— 面板全绿、事件流也通、`/health` 的 connections=1，
// 就是一句话都不回。排查时最费时间的地方在于：没有任何一个测试覆盖到「真发一条
// 消息」这条路，而 `node --check` 也完全看不出问题（语法合法，只是作用域错了）。
//
// 这条测试不解析 AST（host.js 里模板字符串带 `${}`，手写扫描器更容易写错），
// 只钉一个**结构性事实**：两者都在 apply 作用域，`onInbound` 必须出现在
// `startServer()` 之前。反过来说，只要 `function startServer()` 先出现，
// 后面任何 2 空格缩进的 `function onInbound` 就必然被它包进去了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'src', 'host.js'), 'utf8');
const lines = SRC.split(/\r?\n/);
const at = (needle) => lines.findIndex((l) => l.trimStart() === needle);

test('作用域：onInbound 不能落在 startServer() 里面', () => {
  const onInbound = at('function onInbound(payload) {');
  const startServer = at('function startServer() {');
  assert.ok(onInbound >= 0, '找不到 onInbound 的定义');
  assert.ok(startServer >= 0, '找不到 startServer 的定义');
  assert.ok(
    onInbound < startServer,
    `onInbound 在第 ${onInbound + 1} 行、startServer 在第 ${startServer + 1} 行：` +
      '前者被后者包住了，deliverBatch() 调它就会 ReferenceError',
  );
});

test('作用域：inboundShell / turnQueue 也在 apply 作用域（不随 startServer 重建）', () => {
  const shell = at('const inboundShell = createInboundShell({');
  const queue = at('turnQueue = createTurnQueue({');
  const startServer = at('function startServer() {');
  assert.ok(shell >= 0 && queue >= 0, '找不到 inboundShell / turnQueue 的创建');
  assert.ok(
    shell < startServer,
    `inboundShell 在第 ${shell + 1} 行、startServer 在第 ${startServer + 1} 行：` +
      '每次重启监听都会重建一份队列，正在排的 turn 会被丢掉',
  );
  assert.ok(
    queue < startServer,
    `turnQueue 在第 ${queue + 1} 行、startServer 在第 ${startServer + 1} 行：同上`,
  );
});
