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

/**
 * 调用形状：`createActionRunner()` 返回的是**函数**，不是 `{ run }`。
 *
 * 2026-11-13 09:26 实机：外接协议那条路的每一句回话都炸
 * `outActions.run is not a function`（发送链第一行就没过去），而 `qq_send` /
 * `/v1/message` 两条路正常 —— 它们用的是别的调用点，所以只有「直连回话」全挂。
 * 这类错 `node --check` 看不出来，静态钉一下比等着线上复现便宜。
 */
test('调用形状：createActionRunner 的结果要直接调用，不能取 .run', () => {
  /** 注释里会写 `outActions.run(...)` 举反例，只看代码行 */
  const code = lines.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
  const bad = code.findIndex((l) => /outActions\.run\s*\(/.test(l));
  assert.equal(bad, -1, '写成了 outActions.run(...)，应直接 outActions(...)');
  assert.ok(
    code.some((l) => /outActions\(\{/.test(l)),
    '找不到 outActions({...}) 的调用点，发送链可能被改坏了',
  );
});

/**
 * 字段名：框架推来的**原始事件**里发件人是 `sender.openid`，
 * 只有内部 payload 才拍平成 `sender.id`（roost-payload.js 造的）。
 *
 * 2026-11-13 审计：`deliverBatch` 的 `senderId` 写成 `sender.id` 恒为 `''`，
 * `quota.charge()` 于是退回 `id || target`——「语音条按人算」静默变成
 * 「按会话算」，不报错、不看代码发现不了。
 */
test('字段名：原始事件的发件人要用 sender.openid（payload 才是 sender.id）', () => {
  assert.ok(
    /senderId:\s*String\(last\?\.sender\?\.openid/.test(SRC),
    'deliverBatch 的 senderId 必须取 last.sender.openid',
  );
  assert.ok(
    !/senderId:\s*String\(last\?\.sender\?\.id/.test(SRC),
    '原始事件上没有 sender.id，取它只会得到空串',
  );
});

/**
 * 链路上的错误必须走 `notePathError()`（进环形缓冲 + 带 stack），
 * 不能退回「只打一行 warn」——那正是两条「全绿但不回话」藏了半天的地方。
 */
test('链路错误：入队 / 处理消息 / 回话 / 丢弃 四个阶段都接错误环', () => {
  for (const stage of ['入队', '处理消息', '回话', '丢弃消息']) {
    assert.match(SRC, new RegExp(`notePathError\\('${stage}'`), `${stage} 阶段没接 notePathError`);
  }
  assert.ok(
    /pathErrors\.slice\(-5\)/.test(SRC) && /pathErrorCount/.test(SRC),
    '/status 要把 pathErrors 与 pathErrorCount 暴露出去，否则面板还是看不见',
  );
});
