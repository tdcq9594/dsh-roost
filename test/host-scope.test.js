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

/**
 * 开火时机：能力表不能**开机预打**。
 *
 * 2026-11-13 10:10:26：DSH 刚重启，Roost 还在起，`caps = createCapabilityClient()`
 * 后面紧跟的 `refreshCaps()` 一枪打在空端口上，面板留下一句「连不上 roost
 * （那个端口没人监听）」——看着像配对坏了，其实几秒后 `onState('online')`
 * 会自己补上。所以：构造时只给 `ready` 判据，第一次拉取交给 online。
 */
test('开火时机：能力表只由链路触发，构造完不许立刻 refreshCaps()', () => {
  assert.match(
    SRC,
    /ready:\s*\(\)\s*=>\s*roostRef\?\.connected/,
    'createCapabilityClient 必须拿到 ready 判据，否则链路没通也会去打 6807',
  );
  assert.ok(
    !/caps\s*=\s*createCapabilityClient\(\{[\s\S]{0,500}?\}\);\s*\r?\n\s*refreshCaps\(\);/m.test(SRC),
    'caps 构造完不能立刻 refreshCaps()：那一刻 Roost 往往还没监听 6807',
  );
  assert.match(
    SRC,
    /** online 分支里除了补拉能力表，还会上报扩展清单，所以按块匹配 */
    /if \(state === 'online'\)[\s\S]{0,400}?refreshCaps\(\)/,
    'online 进线时必须补拉一次',
  );
  assert.match(SRC, /reportExtCatalog\(\)/, 'online 时还要把扩展能力清单报给框架（反向联动）');
  assert.match(SRC, /caps\.refresh\(\{ force: true \}\)/, '面板手动刷新要走 force，否则离线时一律静默跳过');
});

/**
 * 接线：排队壳拿到的必须是**字符串 chatId**，且排队键要能区分「回给谁」与
 * 「谁在同一个会话里」。
 *
 * 2026-11 实机形态：`host` 把返回对象的 `chatOf` 直接传进 `chatIdOf`，
 * `String(对象)` 恒为 `"[object Object]"` —— 全进程一条队列，第三个会话的
 * 消息被「上一条还在想」拒掉且不重试。单测里的桩返回字符串，所以全绿。
 */
test('接线：inboundShell 的 chatIdOf 必须返回字符串，且排队键用 sessionKey', () => {
  const start = SRC.indexOf('const inboundShell = createInboundShell({');
  assert.ok(start > 0, '找不到 inboundShell 的创建');
  const block = SRC.slice(start, SRC.indexOf('});', start));

  assert.match(
    block,
    /chatIdOf:\s*\(p\)\s*=>\s*chatOf\(p\)\.chatId/,
    'chatIdOf 必须取 .chatId（直接把 chatOf 传进去会变成 [object Object]）',
  );
  assert.ok(
    !/chatIdOf:\s*chatOf\b/.test(block),
    '不许把返回对象的 chatOf 直接当 chatIdOf 传',
  );
  assert.match(
    block,
    /keyOf:\s*\(p\)\s*=>/,
    '频道里多个子频道共用一个会话，排队键必须是 sessionKey（缺省会按 chatId 分成多条 lane）',
  );
  assert.match(block, /c\.sessionKey\s*\|\|\s*c\.chatId/, 'keyOf 要回落到 chatId');
});

/**
 * 开场：必须「先看后删」。
 *
 * 以前在调模型**之前** `take()`，那一轮一失败开场就永久没了，而 `rounds`
 * 已经加过 —— 下一条成功的消息既没有开场也没有自述，表现是「压缩完她突然
 * 失忆」。现在 `get()` 拼进 prompt、`turns.run` 成功后才 `clear()`。
 */
test('接线：开场先 get 后 clear，不许在模型调用前 take', () => {
  assert.ok(
    !/pendingOpening\.take\(/.test(SRC),
    'host 里不该再出现 pendingOpening.take（先删再返回，失败就找不回来了）',
  );
  const getAt = SRC.indexOf('pendingOpening.get(chat.chatId)');
  const runAt = SRC.indexOf('const rawReply = await turns.run(');
  const clearAt = SRC.indexOf('pendingOpening.clear(chat.chatId)');
  assert.ok(getAt > 0 && runAt > 0 && clearAt > 0, '三处都要在');
  assert.ok(getAt < runAt, 'get 在模型调用之前（要拼进 prompt）');
  assert.ok(clearAt > runAt, 'clear 在模型调用成功之后');
});

/**
 * 彻底删除：两个 store 都要带别名。
 *
 * 换过机器人的会话在库里散在多个 openid 下，只删当前键等于删一半——
 * 旧键下的日记正文和 `episode.text` 原样留着、还能被检索到。
 */
test('接线：memory.purge 要带 aliasesOf 删日记与图谱', () => {
  assert.match(
    SRC,
    /journal\.purgeChat\(chatId,\s*aliasesOf\(chatId\)\)/,
    '彻底删日记必须带别名键',
  );
  assert.match(
    SRC,
    /graph\.purgeChat\?\.\(chatId,\s*aliasesOf\(chatId\)\)/,
    '清图谱也必须带别名键',
  );
});

/**
 * 发送失败不能记账（2026-11 审查）。
 *
 * 出站层失败**只回 `{ok:false}`、不抛异常**，所以三处都必须看返回值：
 * 主回复（失败仍写日记 → 下一轮拿没发出去的话当既定事实）、`qq_send`
 * （失败仍 `parts += 1` → 主回复分支不再发正文，话彻底消失）、
 * `qq_send_file`（失败仍占名额与配额）。
 */
test('接线：三处发送都要判 ok===false', () => {
  const mainAt = SRC.indexOf('const sent = await postReply(payload, guardOutbound(reply)');
  assert.ok(mainAt > 0, '主回复要接返回值');
  const mainBlock = SRC.slice(mainAt, mainAt + 600);
  assert.ok(
    mainBlock.includes('sent?.ok === false'),
    '主回复没判失败分支',
  );
  assert.ok(
    mainBlock.indexOf('sent?.ok === false') < mainBlock.indexOf('journalAdd(payload, chat, journalText'),
    '日记必须在「发送成功」之后写',
  );

  /**
   * `qq_send`：失败必须 `return { ok:false }` 且**排在 `st2.parts += 1` 之前**。
   * 只看「有没有那段文案」不够——文案会改，顺序才是语义。
   */
  const sendFailAt = SRC.indexOf('return { ok: false, message: `这句没发出去');
  assert.ok(sendFailAt > 0, 'qq_send 失败没回 ok:false');
  /** 失败返回**之后**最近的那次 `st2.parts += 1`（文件里还有别处也累加） */
  const partsAt = SRC.indexOf('st2.parts += 1', sendFailAt);
  assert.ok(partsAt > 0, '失败分支后面没有段数累加，说明 qq_send 那段结构变了');
  assert.ok(sendFailAt < partsAt, '失败分支必须在累加段数之前 return');
  /** 文件失败在 `filesOk` 里（正文空串时 `ok` 恒 true），必须一并判并回滚 */
  const fileFailAt = SRC.indexOf('sent?.filesOk === false');
  assert.ok(fileFailAt > 0, 'qq_send_file 要判 filesOk');
  const rollbackAt = SRC.indexOf('turnSt.files -= 1', fileFailAt);
  assert.ok(rollbackAt > 0, 'qq_send_file 失败要回滚 files');
  assert.ok(rollbackAt - fileFailAt < 800, '回滚要在失败分支里，不能隔太远');
  assert.ok(SRC.indexOf('q.undo?.()', fileFailAt) < rollbackAt + 400, '配额也要回滚');
});

/**
 * 过审送达的主动消息要补写日记。
 *
 * 进审核时 `sendOut` 因为 `pending` 跳过 journalAdd；十分钟后结案成 `sent`，
 * 以前只打一行日志——那句话永远不进日记，下一轮容易再说一遍。
 */
test('接线：投递结案成 sent 时要补写日记', () => {
  const at = SRC.indexOf('for (const it of r.settled || [])');
  assert.ok(at > 0, '找不到 settled 的处理循环');
  const block = SRC.slice(at, at + 900);
  assert.ok(block.includes("it.state !== 'sent'"), '只处理 sent');
  assert.ok(block.includes('journalAdd('), '要真的写日记');
  assert.ok(block.includes('delivery:${it.requestId}'), '行 id 要用 requestId 保证幂等');
});
