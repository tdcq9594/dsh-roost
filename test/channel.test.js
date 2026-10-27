// 第 7 期（抽象）：通道能力表 / 发送 / 注册方式归一。
//
// 这一层最容易"抽了但没接"（上一轮 `journal.clearChat` 就是死函数）。
// 所以测试不只验形状，还要验**真的被调用、真的挡住了不该发的**。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QQ_CAPABILITIES,
  can,
  createQqChannel,
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

/** 记下请求的假 fetch */
function spyFetch({ ok = true, body = { ok: true }, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, payload: init?.body ? JSON.parse(init.body) : null });
    return { ok, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test('通道：正常发送会打到 ai-chat 的 /send，并带上场景', async () => {
  const f = spyFetch();
  const ch = createQqChannel({ baseUrl: () => 'http://127.0.0.1:15207/', keyQuery: () => '?key=k', fetchImpl: f });
  const r = await ch.send({ scene: 'c2c', target: 'u1', text: '在吗' });
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/api\/plugins\/ai-chat\/r\/send\?key=k$/);
  assert.equal(f.calls[0].payload.scene, 'c2c');
  assert.equal(f.calls[0].payload.target, 'u1');
});

test('通道：缺 target 或空文本，本地就挡掉，不发请求', async () => {
  const f = spyFetch();
  const ch = createQqChannel({ baseUrl: () => 'http://x', fetchImpl: f });
  assert.equal((await ch.send({ target: '', text: 'x' })).ok, false);
  assert.equal((await ch.send({ target: 'u1', text: '   ' })).ok, false);
  assert.equal(f.calls.length, 0);
});

test('通道：群里没有 group_push 授权就不发（官方硬前置）', async () => {
  const f = spyFetch();
  const ch = createQqChannel({ baseUrl: () => 'http://x', fetchImpl: f });
  const r = await ch.send({ scene: 'group', target: 'g1', text: '你好', hasGroupAuthz: false });
  assert.equal(r.ok, false);
  assert.match(r.message, /授权/);
  assert.equal(f.calls.length, 0, '没授权连请求都不该发出去');
});

test('通道：网络异常标记成 network，方便上层区分"对方拒绝"', async () => {
  const ch = createQqChannel({
    baseUrl: () => 'http://x',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const r = await ch.send({ target: 'u1', text: '嗨' });
  assert.equal(r.ok, false);
  assert.equal(r.network, true);
});

test('通道：对方回了非 JSON 也要说清楚，不能静默', async () => {
  const ch = createQqChannel({
    baseUrl: () => 'http://x',
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => null }),
  });
  const r = await ch.send({ target: 'u1', text: '嗨' });
  assert.equal(r.ok, false);
  assert.match(r.message, /500/);
});

test('假通道：把发出去的东西记下来（测试里一个字节都不出机器）', async () => {
  const ch = createFakeChannel();
  await ch.send({ scene: 'group', target: 'g1', text: '嗨' });
  assert.equal(ch.sent.length, 1);
  assert.equal(ch.sent[0].target, 'g1');
});

test('通道注册表：按配置选，选不到要说清楚', () => {
  const a = createFakeChannel();
  const reg = createChannelRegistry({ impls: { qq: a }, pick: () => 'qq' });
  assert.equal(reg.active(), a);
  assert.deepEqual(reg.names(), ['qq']);
  assert.equal(reg.get('不存在'), null);
  assert.ok(reg.describe().qq.text);
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
