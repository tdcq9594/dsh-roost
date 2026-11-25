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
 * 合并批的出处必须补全（2026-11-25 实机）。
 *
 * `deliverBatch` 用 `merged = {...last}` 造 payload，`roost-payload.js` 的
 * `eventIds: [evt?.eventId]` 于是只带**最后一条**；而 `batchOf()` 明明手里
 * 有整批 `items`（attachments / elements / senders 都合过了），出处却漏了。
 *
 * 后果不是「少记一个 id」这么轻：
 *   · 「刚才说到」的缺口判据 = 账本 `id` 减日记 `event_ids`，同批其余几条被
 *     判成「模型没见过」，每轮补进注入块、跟正文一字不差地重复；
 *   · 事实的 `src.eventIds` 只剩一条，`/r/context` 追不回同批原文。
 */
test('合并批：payload.eventIds 要带上整批，不只是最后一条', () => {
  const start = SRC.indexOf('if (batch.count > 1) {');
  assert.ok(start > 0, '找不到 deliverBatch 里的合并批分支');
  const end = SRC.indexOf('const quiet = guestQuietSkip', start);
  assert.ok(end > start, '找不到合并批分支的结束位置');
  const block = SRC.slice(start, end);
  assert.match(block, /batch\.items/, '要从 batch.items 取整批的 eventId');
  assert.match(block, /payload\.eventIds\s*=/, '要回写 payload.eventIds');
  assert.doesNotMatch(
    block,
    /payload\.id\s*=/,
    'payload.id 必须保持最后一条：被动回复窗口、日记主键、幂等都靠它',
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
  assert.match(
    SRC,
    /onReady:\s*\(\)\s*=>\s*\{[\s\S]{0,200}?reportExtCatalog\(\)/,
    '扩展清单改在真连通（onReady）时上报，不再挂 onState online',
  );
  assert.doesNotMatch(
    SRC,
    /if \(state === 'online'\) \{[^}]*reportExtCatalog\(\)/,
    'onState online 不能再上报：pump 在连接建立前就置 online，失败重连会刷框架日志',
  );
  assert.match(SRC, /sig === lastCatalogSig/, '清单签名没变时不重复 RPC');
  assert.match(SRC, /catalogInFlight/, '并发上报要挡住，不能让一次抖动打出多条');
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
  /**
   * 锚点跟着 2026-11-22 的改动走了：`guardOutbound` 现在要带上本轮 chat
   * （leak-guard 只比对本会话的静态段，读全局会话会把别群的内容当复读删）。
   * 这里锁的仍是「主回复必须接住返回值」，不是那串参数本身。
   */
  const mainAt = SRC.indexOf('const sent = await postReply(payload, guardOutbound(reply, chat)');
  assert.ok(mainAt > 0, '主回复要接返回值');
  const mainBlock = SRC.slice(mainAt, mainAt + 1200);
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

/**
 * 「彻底删除 / 清空本会话」必须连压缩开场一起清（2026-11 复核）。
 *
 * 开场正文存在内存里（`set()` 写正文，重建结果也会缓存）。日记清了、
 * 开场还在，下一条消息照样把「刚才说到」里那几句**用户刚删掉的原话**
 * 拼进 prompt，而这一轮的回复又写回日记——删掉的内容绕一圈又回来了。
 */
test('接线：清记忆 / 彻底删除都要清掉压缩开场', () => {
  const clearCase = SRC.indexOf("case 'memory.clear': {");
  const purgeCase = SRC.indexOf("case 'memory.purge': {");
  assert.ok(clearCase > 0 && purgeCase > 0, '两个 case 都要在');

  const clearBlock = SRC.slice(clearCase, purgeCase);
  const purgeEnd = SRC.indexOf("case 'memory.clearGlobal'", purgeCase);
  const purgeBlock = SRC.slice(purgeCase, purgeEnd > purgeCase ? purgeEnd : purgeCase + 4000);

  assert.match(clearBlock, /pendingOpening\.clear\(chatId\)/, 'memory.clear 要清开场');
  assert.match(purgeBlock, /pendingOpening\.clear\(chatId\)/, 'memory.purge 要清开场');
});

/**
 * 主回复没发出去时，**文件那件事仍要写日记**。
 *
 * 文件是在 `fileOf` 里当场发成功的，失败的只有正文。整条都不写的话，
 * 她下一轮完全不记得发过这份文件，可能再发一遍。
 */
test('接线：主回复失败时 fileNote 仍要单独落日记', () => {
  const at = SRC.indexOf('主回复没发出去');
  assert.ok(at > 0, '找不到主回复失败分支');
  const block = SRC.slice(at, at + 500);
  assert.match(block, /if \(fileNote\) journalAdd\(/, '失败分支要把文件那件事记下来');
});

/**
 * teardown 之后在飞的投递回查不许再写已关闭的 journal。
 *
 * `timers.clearAll()` 拦不住已经发出的异步回调；`journal.close()` 只把
 * `db` 置 null，回调里的 `add()` 会**把库重新打开**，句柄再也关不掉。
 */
test('接线：teardown 之后投递回查要放弃', () => {
  const at = SRC.indexOf('const deliveryTick = () => {');
  assert.ok(at > 0, '找不到 deliveryTick');
  const block = SRC.slice(at, at + 1400);
  assert.match(block, /if \(disposed\) return;/, 'tick 入口要判 disposed');
  assert.match(block, /\.then\(\(r\) => \{\s*if \(disposed\) return;/, '回调回来也要判');
});

/**
 * 「彻底删除 / 清空」要把**所有还留着原文的地方**清干净（2026-11 复核）。
 *
 * `closing.json` 存「上次这段聊到：…」的摘要和私聊里那句没回的话（120 字原话），
 * `delivery.json` 存发出去的正文（60 / 1000 字）。它们每轮 / 每次结案都会被读出来用，
 * 只清日记等于「删了正文还留着摘要」。
 */
test('接线：清记忆 / 彻底删除要连 closing 与 delivery 一起清', () => {
  const clearCase = SRC.indexOf("case 'memory.clear': {");
  const purgeCase = SRC.indexOf("case 'memory.purge': {");
  const clearBlock = SRC.slice(clearCase, purgeCase);
  const purgeEnd = SRC.indexOf("case 'memory.clearGlobal'", purgeCase);
  const purgeBlock = SRC.slice(purgeCase, purgeEnd > purgeCase ? purgeEnd : purgeCase + 4000);

  for (const [name, block] of [['memory.clear', clearBlock], ['memory.purge', purgeBlock]]) {
    /** 三处都要**带别名**：换过机器人的会话散在多个 openid 下 */
    assert.match(block, /closing\.clear\(chatId,\s*aliasesOf\(chatId\)\)/, `${name} 要清收尾摘要（带别名）`);
    assert.match(block, /closing\.clearPending\(chatId,\s*aliasesOf\(chatId\)\)/, `${name} 要清「没回的那句话」（带别名）`);
    assert.match(block, /deliveryTrack\.clearChat\(chatId,\s*aliasesOf\(chatId\)/, `${name} 要清投递账本里的正文（带别名）`);
  }
});

/**
 * 清空记忆后，待审核的那条**结案时不许把原文补回日记**（2026-11 复核）。
 *
 * 判据是账本上的 `cleared` 标记，**不能**用「账本里还有没有这条」：
 * `resolve()` 返回前会 `prune()` 掉超过 2 天的结案条目，那是正常 TTL 回收，
 * 按存在性判会把该补的那行也一起跳过。
 */
test('接线：投递结案补日记要认 cleared 标记', () => {
  const at = SRC.indexOf('for (const it of r.settled || [])');
  assert.ok(at > 0, '找不到 settled 循环');
  const block = SRC.slice(at, at + 1200);
  assert.match(block, /if \(it\.cleared\) continue;/, '要认 cleared');
  assert.equal(
    /deliveryTrack\.get\(it\.requestId\)/.test(block),
    false,
    '不能用「账本里还有没有」判：prune 会把正常的也算成被清掉',
  );
});

/**
 * 面板 API 拒绝 opaque origin（2026-11-21）。
 *
 * 沙箱 iframe / `data:` / `file:` 页面发来的请求带 `Origin: null`。它们读不到
 * 响应，但**请求照样会到达服务器并执行**——`/quick` 是 POST，只判「是不是主人」
 * 挡不住（CSRF 形态）。`/ext-pages` 必须豁免：沙箱页面要能取自己目录下的 JSON。
 */
test('接线：面板 API 拒绝 Origin: null，/ext-pages 豁免', () => {
  const at = SRC.indexOf("const route = (path, handler");
  assert.ok(at > 0, '找不到 route()');
  const block = SRC.slice(at, at + 1600);

  assert.match(block, /req\.headers\?\.origin === 'null'/, '要判 Origin: null');
  assert.match(block, /if \(!skipFence && req\.headers\?\.origin === 'null'\)/, '只在走栅栏的路由上拦');
  /** 顺序：Origin 判断必须在 fence 之前，否则栅栏先放行了 */
  assert.ok(
    block.indexOf("origin === 'null'") < block.indexOf('fence(req)'),
    'Origin 判断要在 fence 之前',
  );
  /** /ext-pages 走 skipFence，天然豁免（路由体很长，窗口要够大） */
  const ep = SRC.indexOf("route('/ext-pages'");
  assert.ok(ep > 0, '找不到 /ext-pages');
  assert.match(SRC.slice(ep, ep + 9000), /skipFence: true/, '/ext-pages 要标 skipFence');
});

/**
 * `/ext-pages` 要先验清单指纹再发文件（2026-11-21）。
 */
test('接线：/ext-pages 先验指纹', () => {
  const at = SRC.indexOf("route('/ext-pages'");
  assert.ok(at > 0, '找不到 /ext-pages');
  const block = SRC.slice(at, at + 1200);
  assert.match(block, /manifestStateOf\?\.\(id\)/, '要查指纹');
  assert.ok(
    block.indexOf('manifestStateOf') < block.indexOf('normalizeUiSpec'),
    '指纹要在发文件之前判',
  );
});

/**
 * 扩展页面转发的 `/quick` 要过判权（2026-11-21）。
 *
 * `viaExt` 只认父窗口填的：页面在沙箱里，`postMessage` 载荷里的同名字段
 * 会被父窗口丢掉。判据是**令牌上实际授予的 scope**，不是清单声明——
 * 主人收回过 scope 时立刻生效。
 */
test('接线：/quick 用 guardQuickCall 判扩展页面的调用', () => {
  const at = SRC.indexOf("route('/quick'");
  assert.ok(at > 0, '找不到 /quick');
  const block = SRC.slice(at, at + 2600);

  assert.match(block, /const viaExt = String\(body\?\.viaExt \|\| ''\)\.trim\(\)/, '要读 viaExt');
  /** 面板要显式带 @panel：不能把「没带」当成面板（漏传就是全权） */
  assert.match(block, /if \(viaExt !== PANEL_MARK\)/, '面板标记要显式判');
  assert.equal(/if \(viaExt\) \{/.test(block), false, '不能「带了才判、不带就放行」');
  assert.match(block, /guardQuickCall\(\{ op, arg, viaExt/, '要过判权');
  assert.match(block, /extClientStore\?\.get\?\.\(/, '按扩展 id 取令牌记录');
  assert.match(block, /extClientStore/, '判据取自令牌存储');
  assert.match(block, /\.scopes/, '读令牌上的 scopes');
  assert.ok(
    block.indexOf('guardQuickCall') < block.indexOf('switch (op)'),
    '判权要在 switch 之前（否则已经执行了）',
  );
});

/**
 * `/ext-pages` 要带沙箱头、放行自己目录的 JSON、并注入垫片（2026-11-21）。
 */
test('接线：/ext-pages 带 CSP 沙箱 + CORS + 垫片注入', () => {
  const at = SRC.indexOf("route('/ext-pages'");
  const block = SRC.slice(at, at + 7000);

  assert.match(block, /content-security-policy': 'sandbox allow-scripts/, '要发 CSP 沙箱');
  assert.match(block, /access-control-allow-origin': 'null'/, '只放行 opaque origin');
  assert.equal(/access-control-allow-origin': '\*'/.test(block), false, '不能写 *（任何网页都能读 localhost）');
  assert.match(block, /injectShim\(buf\.toString\('utf8'\)\)/, 'HTML 要注入垫片');
  assert.ok(
    block.indexOf('injectShim') < block.indexOf('res.end(buf)'),
    '注入要在发送之前',
  );
});

/**
 * 2026-11-23 实机：点「记忆统计」报 `config is not defined`。
 *
 * host 的配置变量叫 `cfg`（`let cfg = loadConfig()`），我在 stats.snapshot 里
 * 顺手写成 `config?.usage?.pricing` —— 语法合法、node --check 过、纯函数单测
 * 全绿（stats-snapshot.test.js 根本不经过 host），只有真点按钮才 ReferenceError。
 * 这类作用域错跟上面 onInbound 那条是同一类，照例静态钉住。
 */
test('作用域：新增 quick op 里不能出现未定义的 config（要用 cfg）', () => {
  const lines = SRC.split(/\r?\n/);
  const bad = [];
  for (const [i, line] of lines.entries()) {
    /** 只看代码行，注释里举例的 config 不算 */
    if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
    if (/\bconfig\s*\?/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
  }
  assert.deepEqual(bad, [], `发现 config?. 误用（host 里变量是 cfg）：\n${bad.join('\n')}`);
  /** 同时确认 stats.snapshot 确实用了 cfg 读 pricing（防止两条都被删掉蒙混过关） */
  const atStats = lines.findIndex((l) => l.trim() === "case 'stats.snapshot': {");
  assert.ok(atStats >= 0, '找不到 stats.snapshot op');
  const block = lines.slice(atStats, atStats + 30).join('\n');
  assert.match(block, /pricing:\s*cfg\?\.usage\?\.pricing/, '统计快照要用 cfg 读定价');
});

/**
 * 2026-11-23：心智模型模型模式从"双重闸"简化为面板单一开关。
 * 双重闸（config + 调用方 useModel）实测没人能开——面板从不传 useModel，
 * 配置开着也走不到模型分支。现在面板 checkbox 直接写 config，后端只读它。
 */
test('接线：mind.refresh 用单一配置开关，不再要求 arg.useModel', () => {
  const at = lines.findIndex((l) => l.trim() === "case 'mind.refresh': {");
  assert.ok(at >= 0, '找不到 mind.refresh op');
  const block = lines.slice(at, at + 30).join('\n');
  assert.match(block, /cfg\.memory\?\.mindModel\?\.modelRefresh === true/, '要读面板开关');
  assert.doesNotMatch(block, /arg\?\.useModel/, '不能再靠调用方传 useModel（面板从不传）');
});
