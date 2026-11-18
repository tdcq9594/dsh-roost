// 第 7 期（抽象）：通道能力表 / 发送 / 注册方式归一。
//
// 这一层最容易"抽了但没接"（上一轮 `journal.clearChat` 就是死函数）。
// 所以测试不只验形状，还要验**真的被调用、真的挡住了不该发的**。

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  QQ_CAPABILITIES,
  QQ_FALLBACKS,
  can,
  downgrade,
  createFakeChannel,
  createChannelRegistry,
  createRoostHostChannel,
} from '../src/channel.js';
import {
  normalizeStatus,
  createQrRegistration,
  createManualRegistration,
  createRegistrationRegistry,
  REG_STATUS,
} from '../src/registration.js';

/* ---------------- 能力表 ---------------- */

test('能力表：官方没有的必须如实写 false（上层据此不调）', () => {
  assert.equal(QQ_CAPABILITIES.poke, false);
  assert.equal(QQ_CAPABILITIES.forward, false);
  assert.equal(QQ_CAPABILITIES.space, false);
  assert.equal(QQ_CAPABILITIES.history, false);
});

test('能力表：带场景的能力（流式只支持单聊）', () => {
  assert.equal(can(QQ_CAPABILITIES, 'stream', 'c2c'), true);
  assert.equal(can(QQ_CAPABILITIES, 'stream', 'group'), false);
  assert.equal(can(QQ_CAPABILITIES, 'markdown', 'group'), true);
});

test('能力表：不存在的名字判 false，不抛错', () => {
  assert.equal(can(QQ_CAPABILITIES, '拍一拍'), false);
  assert.equal(can(null, 'text'), false);
});

/* ---------------- 发送 ---------------- */

/**
 * ai-chat 通道已整体移除。这里不用「测它不存在」这种空断言，
 * 而是钉住两件事：
 *   1. 通道模块只暴露直连实现（源码里不再有 ai-chat 的任何路由）；
 *   2. 老配置残留 `qq` 时，注册表仍能拿到唯一实现——升级不会变哑巴。
 */
test('移除 ai-chat：通道源码里不再有中间层的 /r/* 路由', () => {
  const src = readFileSync(new URL('../src/channel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /api\/plugins\/ai-chat/);
  assert.doesNotMatch(src, /createQqChannel/);
  assert.doesNotMatch(src, /\/r\/(send|delivery|status|reply)/);
});

test('移除 ai-chat：默认通道是 roost，老配置的 qq 会回退到唯一实现', () => {
  const only = createFakeChannel();
  const reg = createChannelRegistry({ impls: { roost: only } });
  assert.equal(reg.active(), only, '不带 pick 时默认 roost');
  assert.equal(reg.get('qq'), only, '老配置残留 qq 也不能返回 null');
  assert.deepEqual(reg.names(), ['roost']);
});

test('假通道：把发出去的东西记下来（测试里一个字节都不出机器）', async () => {
  const ch = createFakeChannel();
  await ch.send({ scene: 'group', target: 'g1', text: '嗨' });
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].target, 'g1');
});

test('通道注册表：按配置选；多实现时选不到要说清楚', () => {
  const a = createFakeChannel();
  const b = createFakeChannel();
  const reg = createChannelRegistry({ impls: { roost: a, other: b }, pick: () => 'roost' });
  assert.equal(reg.active(), a);
  assert.equal(reg.get('other'), b);
  assert.deepEqual(reg.names(), ['roost', 'other']);
  assert.equal(reg.get('不存在'), null, '两个以上实现时不能瞎猜');
  assert.ok(reg.describe().roost.text);
});

/* ---------------- 注册方式 ---------------- */

test('注册：状态归一只认四种', () => {
  for (const s of REG_STATUS) assert.ok(REG_STATUS.includes(normalizeStatus(s)));
  assert.equal(normalizeStatus('SUCCESS'), 'done');
  assert.equal(normalizeStatus(1), 'done');
  assert.equal(normalizeStatus('expired'), 'expired');
  assert.equal(normalizeStatus('???'), 'pending', '认不出来按 pending，别让用户以为失败了');
});

test('扫码注册：start 拿到 taskId 才算成功', async () => {
  const impl = createQrRegistration({ setup: { qrStart: async () => ({ taskId: 't1', qrUrl: 'u' }) } });
  const r = await impl.start();
  assert.equal(r.ok, true);
  assert.equal(r.taskId, 't1');
});

test('扫码注册：框架没给 taskId 要明确报错', async () => {
  const impl = createQrRegistration({ setup: { qrStart: async () => ({ qrUrl: 'u' }) } });
  const r = await impl.start();
  assert.equal(r.ok, false);
  assert.match(r.message, /taskId/);
});

test('扫码注册：done 但缺凭证算 error（凭证只在这一刻能拿到）', async () => {
  const impl = createQrRegistration({
    setup: { qrPoll: async () => ({ status: 'done', appId: 'a' }) },
  });
  const r = await impl.poll('t1');
  assert.equal(r.status, 'error');
  assert.equal(r.ok, false);
});

test('扫码注册：pending 原样透传，不算错', async () => {
  const impl = createQrRegistration({ setup: { qrPoll: async () => ({ status: 'pending' }) } });
  const r = await impl.poll('t1');
  assert.equal(r.status, 'pending');
  assert.equal(r.ok, true);
});

test('扫码注册：缺 taskId 直接拒，不去打框架', async () => {
  let called = 0;
  const impl = createQrRegistration({
    setup: {
      qrPoll: async () => {
        called += 1;
        return { status: 'pending' };
      },
    },
  });
  const r = await impl.poll('');
  assert.equal(r.status, 'error');
  assert.equal(called, 0);
});

test('手动注册：两个凭证缺一个就拒', async () => {
  const impl = createManualRegistration({});
  assert.equal((await impl.submit({ appId: 'a' })).ok, false);
  assert.equal((await impl.submit({ appId: 'a', appSecret: 'b' })).ok, true);
});

test('注册注册表：两种方式都在，能列出、能按配置选', () => {
  const qr = createQrRegistration({ setup: { qrStart: async () => ({}) } });
  const manual = createManualRegistration({});
  const reg = createRegistrationRegistry({ impls: [qr, manual], pick: () => 'manual' });
  assert.deepEqual(reg.list().map((x) => x.name), ['qr', 'manual']);
  assert.equal(reg.active(), manual);
  assert.equal(reg.get('qr'), qr);
});

/* ---------------- 降级路径（第 3 批 E4） ---------------- */

test('降级：能力可用就原样返回', () => {
  assert.equal(downgrade(QQ_CAPABILITIES, 'markdown', 'group'), 'markdown');
  assert.equal(downgrade(QQ_CAPABILITIES, 'text', 'c2c'), 'text');
});

test('降级：markdown 用不了时退成 text（而不是什么都不发）', () => {
  const caps = { ...QQ_CAPABILITIES, markdown: false };
  assert.equal(downgrade(caps, 'markdown', 'group'), 'text');
});

test('降级：流式在群里不可用 → 退成 text', () => {
  // stream 是 'c2c'，在群场景下 can() 判 false
  assert.equal(downgrade(QQ_CAPABILITIES, 'stream', 'group'), 'text');
  assert.equal(downgrade(QQ_CAPABILITIES, 'stream', 'c2c'), 'stream');
});

test('降级：撤回退成 none，明确返回 null 而不是硬发', () => {
  assert.equal(downgrade(QQ_CAPABILITIES, 'retract', 'group', { retract: 'none' }), null);
});

test('降级：退到底也没有可用能力时返回 null', () => {
  const caps = { text: false };
  assert.equal(downgrade(caps, 'markdown'), null);
});

test('降级：降级链不会成环（自引用配置也不会卡死）', () => {
  const caps = {};
  assert.equal(downgrade(caps, 'a', 'c2c', { a: 'b', b: 'a' }), null);
});

/* ---------------- 3.7：事件被动回复（event_id） ---------------- */

test('3.7：只有 event_id 的事件能走被动回复（不占主动额度）', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false });

  await ch.send({ target: 'u9', text: '欢迎加入', eventId: 'evt_xxx' });
  assert.equal(calls[0][0], 'msg.send');
  assert.equal(calls[0][1].eventId, 'evt_xxx');
  assert.equal(calls[0][1].msgId, undefined, '没有 msgId 就不该带');

  /** 两个都有：msgId 优先（官方对消息事件的被动窗口更稳） */
  await ch.send({ target: 'u9', text: '在', msgId: 'm_77', eventId: 'evt_xxx' });
  assert.equal(calls[1][1].msgId, 'm_77');
  assert.equal(calls[1][1].eventId, undefined);

  /** 什么都没有 = 主动消息，不带被动参数 */
  await ch.send({ target: 'u9', text: '主动说一句' });
  assert.equal(calls[2][1].msgId, undefined);
  assert.equal(calls[2][1].eventId, undefined);
});

test('3.7：media.send（语音/文件）同样支持 event_id', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm2' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false });
  await ch.sendVoice({ target: 'u9', dataBase64: 'AAAA', eventId: 'evt_v' });
  assert.equal(calls[0][0], 'media.send');
  assert.equal(calls[0][1].eventId, 'evt_v');
  await ch.sendFile({ target: 'u9', path: 'D:/tmp/a.png', eventId: 'evt_f' });
  assert.equal(calls[1][1].eventId, 'evt_f');
});

/* ---------------- 超长正文：主动通道没有分段，只能截断 ---------------- */

test('超长正文会被截断（平台单条上限内，不整条发出去被拒）', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm3' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });

  /** 2000 字，中间有句号：应该在句号处切，不留半句话 */
  const long = `${'这是一句话。'.repeat(300)}`;  /** 1800 字，超过 1500 */
  const r = await ch.send({ target: 'u9', text: long });
  assert.equal(r.ok, true);
  const sent = calls[0][1].content;
  assert.ok(sent.length <= 1501, `截断后应 ≤1501（含省略号），实际 ${sent.length}`);
  assert.ok(sent.endsWith('…'), '截断要有省略号，让人知道不是讲完了');
  assert.ok(sent.startsWith('这是一句话。'), '开头不能被切掉');
});

test('刚好在上限内不截断，也不加省略号', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm4' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });
  const exact = 'a'.repeat(1500);
  await ch.send({ target: 'u9', text: exact });
  assert.equal(calls[0][1].content.length, 1500);
  assert.ok(!calls[0][1].content.endsWith('…'));
});

test('没有句子边界时退回硬切，长度仍然受控', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm5' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });
  await ch.send({ target: 'u9', text: 'x'.repeat(5000) });
  assert.ok(calls[0][1].content.length <= 1501, '硬切也要落在上限内');
});

/* ---------------- 试运行：四条出站路唯一的汇合点 ---------------- */

/**
 * 试运行**只能**拦在 `channel.send`。
 *
 * 主动消息走 `sendOut`，主回复走 `outActions` 的裸通道，`qq_send` 与扩展
 * `/v1/message` 走 `postReply`——四条路最后都掉进这个 `send`。放 `sendOut`
 * 只能拦住主动的那一条，被动回复会照发，试运行等于假话。
 */
test('试运行：一条 rpc 都不打，但返回足够让上游照常记账', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1', requestId: 'r1' }; } };
  let dry = true;
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, dryRunOf: () => dry, log: () => {} });

  /** 被动回复形态（带 msgId）——这正是放 sendOut 会漏掉的那条 */
  const r = await ch.send({ target: 'u9', text: '在呢', msgId: 'm_7' });
  assert.equal(r.ok, true, 'ok 必须为真：上游 sendOut 靠 ok && !pending 记账');
  assert.equal(r.pending, false, 'pending 为假，投递账本才不会多一条假记录');
  assert.equal(r.dryRun, true);
  assert.equal(r.scene, 'c2c');
  assert.equal(r.target, 'u9');
  assert.ok(r.requestId, '下游记账要用它当幂等键');
  assert.deepEqual(calls, [], '试运行不许打任何 rpc');

  /** 带静默的也一样：`gate.silence` 是服务端状态，试运行不该改 */
  const r2 = await ch.send({ target: 'u9', text: '', silenceMs: 60_000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.silentOnly, true, '只有静默没正文时，语义要保留');
  assert.deepEqual(calls, [], '试运行也不许设静默');

  /** 关掉就照常发 */
  dry = false;
  await ch.send({ target: 'u9', text: '在呢' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'msg.send');
});

test('试运行：缺省（不传 dryRunOf）行为完全不变', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });
  const r = await ch.send({ target: 'u9', text: '在呢' });
  assert.equal(r.dryRun, undefined, '没开试运行就不该带这个标记');
  assert.equal(calls.length, 1);
});

/* ---------------- 总开关：在途那一轮也要拦 ---------------- */

/**
 * `judge()` 拦新消息，`sendOut()` 拦主动发送，两者都盖不住「模型已经在跑、
 * 主人才把总开关关掉」——那一轮跑完仍会走到 `send`，把话发出去。
 *
 * 这条测的就是那个时间窗：只判总开关、不判试运行；返回 `ok:false`，
 * 因为关掉期间不该写记忆 / 日记 / 惦记。
 */
test('总开关：关着时连被动回复也不发，且不带 ok', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  let off = true;
  const ch = createRoostHostChannel({
    host, markdownEnabled: () => false, masterOffOf: () => off, log: () => {},
  });

  /** 被动回复形态：这条不经过 `sendOut`，是 `judge()` 之后才关的开关 */
  const r = await ch.send({ target: 'u9', text: '在呢', msgId: 'm_7' });
  assert.equal(r.ok, false, 'ok 必须为假：关掉期间不记账');
  assert.equal(r.code, 'disabled', '上游靠这个 code 区分「没发」和「发失败」');
  assert.deepEqual(calls, [], '总开关关着不许打任何 rpc');

  /** 带静默的也一样：`gate.silence` 是服务端状态，关着时不该改 */
  await ch.send({ target: 'u9', text: '', silenceMs: 60_000 });
  assert.deepEqual(calls, [], '总开关关着也不许设静默');

  off = false;
  const r2 = await ch.send({ target: 'u9', text: '在呢', msgId: 'm_7' });
  assert.equal(r2.ok, true);
  assert.equal(calls.length, 1, '开关一开立刻恢复，不用重启');
  assert.equal(calls[0][0], 'msg.send');
});

test('总开关：缺省（不传 masterOffOf）不影响任何发送', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const ch = createRoostHostChannel({ host, markdownEnabled: () => false, log: () => {} });
  const r = await ch.send({ target: 'u9', text: '在呢' });
  assert.equal(r.ok, true);
  assert.equal(r.code, undefined, '没传判据就该照常发，不能平白多一个 disabled');
  assert.equal(calls.length, 1);
});

/* ---------------- 文件 / 语音：另一条 rpc，也要判 ---------------- */

/**
 * `<<file:>>` / `<<image>>` / `<<voice:>>` / `<<say>>` 走的是 `media.send`，
 * 不经过上面的 `send`。只拦 `send` 的后果是「试运行开着、文件语音照样真发」，
 * 以及「总开关关着、在途那一轮的附件照样出去」。
 */
test('试运行 / 总开关：文件和语音同样拦在 rpc 之前', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  let dry = false;
  let off = false;
  const ch = createRoostHostChannel({
    host, markdownEnabled: () => false,
    dryRunOf: () => dry, masterOffOf: () => off, log: () => {},
  });

  /** 正常：两条都真打 media.send */
  assert.equal((await ch.sendFile({ target: 'u9', path: '/tmp/a.pdf' })).ok, true);
  assert.equal((await ch.sendVoice({ target: 'u9', path: '/tmp/a.silk' })).ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ['media.send', 'media.send']);
  calls.length = 0;

  /** 试运行：`ok:true` 让出站动作层照常 onSent，但一条 rpc 都不打 */
  dry = true;
  const f = await ch.sendFile({ target: 'u9', path: '/tmp/a.pdf' });
  assert.equal(f.ok, true, '试运行要返回 ok，否则出站动作层会记成发失败');
  assert.equal(f.dryRun, true);
  assert.equal(f.pending, false);
  const v = await ch.sendVoice({ target: 'u9', path: '/tmp/a.silk' });
  assert.equal(v.ok, true);
  assert.equal(v.dryRun, true);
  assert.deepEqual(calls, [], '试运行不许发文件 / 语音');
  dry = false;

  /** 总开关关：`ok:false` + `disabled`，关掉期间不留记账 */
  off = true;
  const f2 = await ch.sendFile({ target: 'u9', path: '/tmp/a.pdf' });
  assert.equal(f2.ok, false);
  assert.equal(f2.code, 'disabled');
  const v2 = await ch.sendVoice({ target: 'u9', path: '/tmp/a.silk' });
  assert.equal(v2.ok, false);
  assert.equal(v2.code, 'disabled');
  assert.deepEqual(calls, [], '总开关关着不许发文件 / 语音');

  /** 开回来立刻恢复 */
  off = false;
  await ch.sendFile({ target: 'u9', path: '/tmp/a.pdf' });
  assert.equal(calls.length, 1);
});
