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
