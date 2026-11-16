/**
 * 扩展「会改变什么」一组（自我表达提议 / 群管 / 语音）
 *
 * 这一组每个都会留下痕迹，所以用例的重点不是「能不能成功」，而是
 * **该拒的都拒了、该拦的都在调底层之前拦**：
 *   · 提议改资料只能「提议」，不能直接写；
 *   · 禁言 / 踢人没有 `confirm: true` 一律不动手；
 *   · 语音只合成，不发出去。
 *
 * 跑法：node --test test/ext-act.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExtAct, MAX_GROUP_TARGETS, MAX_MUTE_SECONDS, MAX_GROUP_ID,
} from '../src/ext-act.js';
import { MAX_NAME_LEN, MAX_DESC_LEN } from '../src/profile-tool.js';

function build({
  ask, groupAdmin, synth, persona = null, cfg = {}, roost = null,
} = {}) {
  const asks = [];
  const groupCalls = [];
  const logs = [];
  const api = createExtAct({
    ask: async (req) => {
      asks.push(req);
      return ask ? ask(req) : { ok: true };
    },
    groupAdminOf: () => ({
      info: async (gid) => { groupCalls.push(['info', gid]); return { ok: true, members: 3 }; },
      mute: async (a) => { groupCalls.push(['mute', a]); return { ok: true }; },
      kick: async (a) => { groupCalls.push(['kick', a]); return { ok: true }; },
      ...(groupAdmin || {}),
    }),
    ttsOf: () => ({
      synthesize: synth ?? (async () => ({ audio: Buffer.from('abc'), contentType: 'audio/mpeg' })),
    }),
    roostOf: () => roost ?? { rpc: async () => ({ ok: true }) },
    cfgOf: () => cfg,
    personaOf: () => persona,
    log: (m) => logs.push(m),
  });
  return { api, asks, groupCalls, logs };
}

/* ── self.propose ────────────────────────────────────────────────────── */

test('A1 propose：kind 不认识 / value 空 都拒', async () => {
  const { api, asks } = build();
  assert.equal((await api['self.propose']({ body: { kind: 'mood', value: 'x' } })).status, 400);
  assert.equal((await api['self.propose']({ body: { kind: 'name' } })).status, 400);
  assert.deepEqual(asks, [], '校验没过就不该去打扰主人');
});

test('A2 propose：昵称/签名超长按各自的限拒掉', async () => {
  const { api } = build();
  const longName = '名'.repeat(MAX_NAME_LEN + 1);
  assert.equal((await api['self.propose']({ body: { kind: 'name', value: longName } })).status, 400);

  const longSign = '签'.repeat(MAX_DESC_LEN + 1);
  assert.equal((await api['self.propose']({ body: { kind: 'sign', value: longSign } })).status, 400);

  assert.equal((await api['self.propose']({ body: { kind: 'sign', value: '签'.repeat(MAX_DESC_LEN) } })).status, 200);
});

test('A3 propose：头像只收 http(s)，本机路径不收', async () => {
  const { api, asks } = build();
  for (const bad of ['ftp://x/a.png', 'C:\\a.png', '/etc/passwd', 'data:text/plain,x']) {
    assert.equal((await api['self.propose']({ body: { kind: 'avatar', value: bad } })).status, 400, bad);
  }
  assert.deepEqual(asks, []);
  assert.equal((await api['self.propose']({ body: { kind: 'avatar', value: 'https://x/a.png' } })).status, 200);
});

test('A4 propose：人格卡写了 selfName 时，改昵称在提议阶段就拦（别等主人点完才失败）', async () => {
  const { api, asks } = build({ persona: { selfName: '若叶睦' } });
  const r = await api['self.propose']({ body: { kind: 'name', value: '小美' } });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /若叶睦/);
  assert.deepEqual(asks, [], '拦在提议阶段，主人不会收到一张注定失败的确认卡');

  /** 签名不受 selfName 影响 */
  assert.equal((await api['self.propose']({ body: { kind: 'sign', value: '你好' } })).status, 200);
});

test('A5 propose：成功时明确说「已发出请求」，不是「已改」', async () => {
  const { api, asks } = build();
  const r = await api['self.propose']({ body: { kind: 'name', value: '小美' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.pending, true);
  assert.equal(r.body.reused, false);
  assert.deepEqual(asks[0].payload, { name: '小美' });
  assert.match(asks[0].summary, /小美/);
});

test('A6 propose：同类请求已挂着时复用，不重复私聊主人', async () => {
  const { api } = build({ ask: () => ({ ok: true, reused: true }) });
  const r = await api['self.propose']({ body: { kind: 'sign', value: '新签名' } });
  assert.equal(r.body.reused, true);
  assert.match(r.body.message, /没有重复发/);
});

test('A7 propose：确认通道说不行 → 400 带原因', async () => {
  const { api } = build({ ask: () => ({ ok: false, message: '没配主人的私聊地址，没法发起确认。' }) });
  const r = await api['self.propose']({ body: { kind: 'sign', value: 'x' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /没配主人/);
});

/* ── group.mute ──────────────────────────────────────────────────────── */

test('A8 mute：没有 confirm:true 一律不动手', async () => {
  const { api, groupCalls } = build();
  const r = await api['group.mute']({ body: { groupId: 'g1', targets: ['u1'], seconds: 60 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'need_confirm');
  assert.deepEqual(groupCalls, []);
});

test('A9 mute：缺 groupId / targets 空 / 超上限 / seconds 越界 都拒', async () => {
  const { api, groupCalls } = build();
  const base = { groupId: 'g1', confirm: true };

  assert.equal((await api['group.mute']({ body: { targets: ['u'], seconds: 60, confirm: true } })).status, 400, '缺 groupId');
  assert.equal((await api['group.mute']({ body: { ...base, targets: [], seconds: 60 } })).status, 400, 'targets 空');

  const tooMany = Array.from({ length: MAX_GROUP_TARGETS + 1 }, (_, i) => `u${i}`);
  assert.equal((await api['group.mute']({ body: { ...base, targets: tooMany, seconds: 60 } })).status, 400);
  assert.equal((await api['group.mute']({ body: { ...base, targets: ['u'], seconds: MAX_MUTE_SECONDS + 1 } })).status, 400);
  assert.equal((await api['group.mute']({ body: { ...base, targets: ['u'], seconds: 1.5 } })).status, 400);
  assert.deepEqual(groupCalls, []);
});

test('A10 mute：seconds:0 是解除禁言，也要 confirm', async () => {
  const { api, groupCalls } = build();
  assert.equal((await api['group.mute']({ body: { groupId: 'g1', targets: ['u1'], seconds: 0 } })).status, 400);
  const ok = await api['group.mute']({ body: { groupId: 'g1', targets: ['u1'], seconds: 0, confirm: true } });
  assert.equal(ok.status, 200);
  assert.equal(groupCalls[0][1].seconds, 0);
});

test('A11 mute：底层 ok:false 原样透出，不粉饰成成功', async () => {
  const { api } = build({ groupAdmin: { mute: async () => ({ ok: false, reason: 'not_admin', message: '她不是管理员' }) } });
  const r = await api['group.mute']({ body: { groupId: 'g1', targets: ['u1'], seconds: 60, confirm: true } });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'not_admin');
});

/* ── group.kick ──────────────────────────────────────────────────────── */

test('A12 kick：没有 confirm 不动手；成功时 addToBlacklist 透传', async () => {
  const { api, groupCalls } = build();
  assert.equal((await api['group.kick']({ body: { groupId: 'g1', targets: ['u1'] } })).status, 400);
  assert.deepEqual(groupCalls, []);

  const ok = await api['group.kick']({
    body: { groupId: 'g1', targets: ['u1'], addToBlacklist: true, confirm: true },
  });
  assert.equal(ok.status, 200);
  assert.equal(groupCalls[0][1].addToBlacklist, true);
});

test('A13 kick：addToBlacklist 只认 true，别的值一律当 false', async () => {
  const { api, groupCalls } = build();
  await api['group.kick']({ body: { groupId: 'g1', targets: ['u1'], addToBlacklist: 'yes', confirm: true } });
  assert.equal(groupCalls[0][1].addToBlacklist, false);
});

/* ── group.info ──────────────────────────────────────────────────────── */

test('A14 info：缺 groupId 400；成功透出底层结果', async () => {
  const { api, groupCalls } = build();
  assert.equal((await api['group.info']({ query: {} })).status, 400);
  const r = await api['group.info']({ query: { groupId: 'g1' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.members, 3);
  assert.deepEqual(groupCalls, [['info', 'g1']]);
});

/* ── tts.speak ───────────────────────────────────────────────────────── */

test('A15 tts：缺 text 400；超长 413；成功回 base64 字节', async () => {
  const { api } = build();
  assert.equal((await api['tts.speak']({ body: {} })).status, 400);

  const long = await api['tts.speak']({ body: { text: '字'.repeat(501) } });
  assert.equal(long.status, 413);
  assert.equal(long.body.error, 'text_too_long');

  const ok = await api['tts.speak']({ body: { text: '你好呀' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.audio, Buffer.from('abc').toString('base64'));
  assert.equal(ok.body.contentType, 'audio/mpeg');
  assert.match(ok.body.message, /自己决定怎么发/, '要写清「只合成不发」');
});

test('A16 tts：合成失败透传 status / code，不吞成 500', async () => {
  const { api } = build({
    synth: async () => {
      throw Object.assign(new Error('没配语音服务'), { status: 503, code: 'tts_unavailable' });
    },
  });
  const r = await api['tts.speak']({ body: { text: '你好' } });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'tts_unavailable');
});

test('A17 tts：emoji 超长要报 413，不能切一半再合成', async () => {
  const { api } = build();
  /** 600 个 emoji = 1200 个 UTF-16 码元。按 `.slice` 截会切出半个代理对 */
  const r = await api['tts.speak']({ body: { text: '😺'.repeat(600) } });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'text_too_long');
});

test('A18 mute/kick：异常长的 openid 直接拒，不截短了去匹配别人', async () => {
  const { api, groupCalls } = build();
  const long = 'u'.repeat(201);
  for (const ep of ['group.mute', 'group.kick']) {
    const body = ep === 'group.mute'
      ? { groupId: 'g1', targets: [long], seconds: 60, confirm: true }
      : { groupId: 'g1', targets: [long], confirm: true };
    const r = await api[ep]({ body });
    assert.equal(r.status, 400, ep);
    assert.match(r.body.message, /异常的 openid/);
  }
  assert.deepEqual(groupCalls, []);
});

test('A19 propose：头像地址过长要拒（地址没有内置长度校验）', async () => {
  const { api } = build();
  const r = await api['self.propose']({ body: { kind: 'avatar', value: `https://x/${'a'.repeat(2000)}` } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /太长了/);
});

test('A20 groupId 超长要报错，不能截短了动到另一个群', async () => {
  const { api, groupCalls } = build();
  const long = 'g'.repeat(MAX_GROUP_ID + 1);
  assert.equal((await api['group.info']({ query: { groupId: long } })).status, 400);
  assert.equal((await api['group.mute']({ body: { groupId: long, targets: ['u'], seconds: 60, confirm: true } })).status, 400);
  assert.equal((await api['group.kick']({ body: { groupId: long, targets: ['u'], confirm: true } })).status, 400);
  assert.deepEqual(groupCalls, []);
});

test('A21 构造时缺依赖要立刻炸', () => {
  assert.throws(() => createExtAct({}), /ask/);
  assert.throws(() => createExtAct({ ask: () => {} }), /groupAdminOf/);
  assert.throws(() => createExtAct({ ask: () => {}, groupAdminOf: () => ({}) }), /ttsOf/);
});
