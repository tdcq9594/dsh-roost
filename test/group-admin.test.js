import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGroupAdmin, normalizeTargets, reasonText,
  MAX_BATCH, MAX_MUTE_SEC, DAILY_LIMITS,
} from '../src/group-admin.js';

/**
 * 这一层不重写业务，只负责三件事：收窄参数、翻译结果、留痕计数。
 * 所以用例也都盯这三件，**不测官方接口本身**（那是 bot 侧的事）。
 */

const make = (reply = () => ({ ok: true })) => {
  const calls = [];
  const audits = [];
  const adm = createGroupAdmin({
    rpc: async (m, p) => {
      calls.push([m, p]);
      return reply(m, p);
    },
    audit: (e) => audits.push(e),
    now: () => Date.parse('2026-11-13T05:00:00Z'),
  });
  return { adm, calls, audits };
};

test('normalizeTargets：去空、去重、保序，也吃单个字符串', () => {
  assert.deepEqual(normalizeTargets(['a', ' a ', '', null, 'b', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeTargets('a'), ['a']);
  assert.deepEqual(normalizeTargets(undefined), []);
});

test('reasonText：认得的原因给人话，认不得的原样吐回去', () => {
  assert.match(reasonText('need_invite'), /内邀/);
  assert.match(reasonText('not_admin'), /管理员/);
  assert.equal(reasonText('weird', '兜底'), '兜底');
});

test('info：缺群号直接拒，不打协议', async () => {
  const { adm, calls } = make();
  const r = await adm.info('');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_params');
  assert.equal(calls.length, 0);
});

test('info：正常返回，并带上今天已用次数', async () => {
  const { adm } = make(() => ({ groupOpenid: 'g1', name: '斗罗内测', canManage: true, role: 'admin', invited: true }));
  const r = await adm.info('g1');
  assert.equal(r.ok, true);
  assert.equal(r.name, '斗罗内测');
  assert.equal(r.canManage, true);
  assert.deepEqual(r.used, { mute: 0, kick: 0, join: 0 });
});

test('mute：超 20 人 / 超 30 天 本地先拦，不打协议', async () => {
  const { adm, calls } = make();
  const many = await adm.mute({ groupId: 'g1', targets: Array.from({ length: MAX_BATCH + 1 }, (_, i) => `u${i}`), seconds: 60 });
  assert.equal(many.reason, 'too_many');
  const long = await adm.mute({ groupId: 'g1', targets: ['u1'], seconds: MAX_MUTE_SEC + 1 });
  assert.equal(long.reason, 'too_long');
  assert.equal(calls.length, 0);
});

test('mute：正常走通，计数 +1，审计记一行', async () => {
  const { adm, calls, audits } = make();
  const r = await adm.mute({ groupId: 'g1', targets: ['u1', 'u2'], seconds: 600 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.targets, ['u1', 'u2']);
  assert.equal(calls[0][0], 'group.mute');
  assert.equal(calls[0][1].seconds, 600);
  assert.equal(adm.usedOf('mute'), 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].op, 'group.mute');
  assert.match(audits[0].note, /禁言 600s/);
});

test('mute：协议说 need_invite，原样透传，且不计数', async () => {
  const { adm, audits } = make(() => ({ ok: false, reason: 'need_invite' }));
  const r = await adm.mute({ groupId: 'g1', targets: ['u1'], seconds: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'need_invite');
  assert.match(r.message, /内邀/);
  assert.equal(adm.usedOf('mute'), 0, '失败不该占额度');
  assert.match(audits[0].note, /失败/);
});

test('mute：到日上限就拒，不打协议', async () => {
  const { adm } = make();
  for (let i = 0; i < DAILY_LIMITS.mute; i++) {
    await adm.mute({ groupId: 'g1', targets: [`u${i}`], seconds: 60 });
  }
  const calls = [];
  const adm2 = createGroupAdmin({
    rpc: async (m, p) => { calls.push([m, p]); return { ok: true }; },
    now: () => Date.parse('2026-11-13T05:00:00Z'),
  });
  // 上面那轮不共享状态，这里再从零打满一次，确认第 N+1 次被拦
  for (let i = 0; i < DAILY_LIMITS.mute; i++) {
    await adm2.mute({ groupId: 'g1', targets: [`u${i}`], seconds: 60 });
  }
  const before = calls.length;
  const r = await adm2.mute({ groupId: 'g1', targets: ['ux'], seconds: 60 });
  assert.equal(r.reason, 'daily_limit');
  assert.equal(calls.length, before);
});

test('kick：need_invite 带人话提示；正常带 addToBlacklist', async () => {
  const { adm, calls } = make(() => ({ ok: false, reason: 'need_invite' }));
  const bad = await adm.kick({ groupId: 'g1', targets: ['u1'] });
  assert.equal(bad.reason, 'need_invite');

  const ok = make();
  const r = await ok.adm.kick({ groupId: 'g1', targets: ['u1'], addToBlacklist: true });
  assert.equal(r.ok, true);
  assert.equal(ok.calls[0][0], 'group.kick');
  assert.equal(ok.calls[0][1].addToBlacklist, true);
});

test('join：list 不计数；approve 缺参数拒掉', async () => {
  const { adm, calls } = make(() => ({ ok: true, requests: [{ member_openid: 'u1', join_request_id: 'r1' }] }));
  const listed = await adm.join({ groupId: 'g1', action: 'list' });
  assert.equal(listed.ok, true);
  assert.equal(adm.usedOf('join'), 0, '只看不占额度');

  const bad = await adm.join({ groupId: 'g1', action: 'approve' });
  assert.equal(bad.reason, 'bad_params');
  assert.equal(calls.filter((c) => c[1].action !== 'list').length, 0);
});

test('join：approve 正常，计数 +1，审计带 peerId', async () => {
  const { adm, audits } = make();
  const r = await adm.join({ groupId: 'g1', action: 'approve', memberOpenid: 'u1', joinRequestId: 'r1' });
  assert.equal(r.ok, true);
  assert.equal(adm.usedOf('join'), 1);
  assert.equal(audits[0].peerId, 'u1');
});

test('协议抛错：包成 ok:false，带 code 让面板区分网络/权限', async () => {
  const adm = createGroupAdmin({
    rpc: async () => { throw Object.assign(new Error('连不上'), { code: 'NETWORK' }); },
  });
  const r = await adm.info('g1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NETWORK');
});
