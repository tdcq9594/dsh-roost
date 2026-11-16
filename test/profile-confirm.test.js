/**
 * 改资料的「私聊主人确认」。
 *
 * 这一组守的是**误确认**而不是流程能不能走通：
 *   · 主人一句「好」不该把头像换掉（必须先有码）
 *   · 码必须是完整出现的 4 位数字（12345 不能命中 1234）
 *   · 群里有人猜到码也不能替他确认（那条在 host 里判 chat.kind，这里只保证
 *     `take` 本身不认人，调用方必须自己卡会话）
 *
 * 跑法：node --test test/profile-confirm.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createProfileConfirm, CONFIRM_TTL_MS } from '../src/profile-confirm.js';

function setup({ owner = 'owner-openid', now = 1_000_000, fail = null } = {}) {
  const sent = [];
  const t = { now };
  const c = createProfileConfirm({
    send: async (p) => {
      if (fail) throw new Error(fail);
      sent.push(p);
      return { ok: true };
    },
    ownerOf: () => owner,
    now: () => t.now,
    log: () => {},
  });
  return { c, sent, t };
}

test('A1 发起：私聊主人、返回 4 位码、进入待确认', async () => {
  const { c, sent } = setup();
  const r = await c.ask({ kind: 'sign', payload: { text: '今天想安静一点' }, summary: '「今天想安静一点」' });
  assert.equal(r.ok, true);
  assert.match(r.code, /^\d{4}$/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].scene, 'c2c');
  assert.equal(sent[0].target, 'owner-openid');
  assert.match(sent[0].text, /今天想安静一点/);
  assert.match(sent[0].text, new RegExp(r.code), '消息里必须带码');
  assert.equal(c.hasPending(), true);
});

test('A2 同一类还有未过期的请求 → 复用，不重复打扰', async () => {
  const { c, sent } = setup();
  const a = await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  const b = await c.ask({ kind: 'name', payload: { name: '小绿' }, summary: '改成「小绿」' });
  assert.equal(a.code, b.code);
  assert.equal(b.reused, true);
  assert.equal(sent.length, 1, '只该发一条私聊');
});

test('A3 没配主人地址 → 拒，不静默', async () => {
  const { c, sent } = setup({ owner: '' });
  const r = await c.ask({ kind: 'avatar', payload: {}, summary: '一张图' });
  assert.equal(r.ok, false);
  assert.match(r.message, /主人/);
  assert.equal(sent.length, 0);
});

test('A4 发不出去 → 拒，且不留 pending（否则主人永远收不到）', async () => {
  const { c } = setup({ fail: '额度用完了' });
  const r = await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: '「x」' });
  assert.equal(r.ok, false);
  assert.match(r.message, /额度用完了/);
  assert.equal(c.hasPending(), false);
});

test('T1 主人回码 → 取出请求并移除', async () => {
  const { c } = setup();
  const { code } = await c.ask({ kind: 'sign', payload: { text: '新简介' }, summary: '「新简介」' });
  const req = c.take(`确认 ${code}`);
  assert.ok(req);
  assert.equal(req.kind, 'sign');
  assert.deepEqual(req.payload, { text: '新简介' });
  assert.equal(c.hasPending(), false, '拿出来就作废，不能重复执行');
});

test('T2 只回「好」不命中 —— 必须先有码', async () => {
  const { c } = setup();
  await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  assert.equal(c.take('好'), null);
  assert.equal(c.take('可以，那你继续'), null);
  assert.equal(c.hasPending(), true, '没确认就还挂着');
});

test('T3 码必须是完整数字：12345 不能命中 1234', async () => {
  const { c } = setup();
  /** 反复发起直到拿到一个能和 12345 撞的码，避免依赖随机 */
  let code = '';
  for (let i = 0; i < 60 && !code; i += 1) {
    const r = await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
    if (r.reused) break;
    if (/^\d{4}$/.test(r.code)) { code = r.code; }
  }
  assert.ok(code, '应该拿到一个码');
  assert.equal(c.take(`${code}5`), null, '前缀相同的 5 位数不算确认');
  assert.equal(c.take(`${code}0`), null, '后缀相同的 5 位数不算确认');
  assert.ok(c.take(`确认 ${code} 吧`), '前后带中文可以');
});

test('T4 「不用」取消最近一条，返回被取消的请求', async () => {
  const { c } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  const got = c.cancelLatest('不用了');
  assert.ok(got);
  assert.equal(c.hasPending(), false);
});

test('T5 不是取消词就不动 pending', async () => {
  const { c } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  assert.equal(c.cancelLatest('今天天气不错'), null);
  assert.equal(c.hasPending(), true);
});

test('E1 超过有效期自动作废', async () => {
  const { c, t } = setup();
  const { code } = await c.ask({ kind: 'avatar', payload: { src: { url: 'https://x' } }, summary: '一张图' });
  t.now += CONFIRM_TTL_MS + 1;
  assert.equal(c.hasPending(), false);
  assert.equal(c.take(`确认 ${code}`), null);
});

test('L1 list 只给码与摘要，不带 payload', async () => {
  const { c } = setup();
  await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  const list = c.list();
  assert.equal(list.length, 1);
  assert.equal('payload' in list[0], false);
  assert.equal(list[0].kind, 'name');
});

test('A5 菜单不在确认范围（它一秒能改回来，不该走这套）', async () => {
  const { c } = setup();
  const r = await c.ask({ kind: 'menu', payload: {}, summary: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.message, /不需要确认/);
  assert.equal(c.hasPending(), false);
});
