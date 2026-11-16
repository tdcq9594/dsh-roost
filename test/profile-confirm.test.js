/**
 * 改资料的「私聊主人确认」。
 *
 * 主路径是**按钮**（`action.type: 1` 回调型），所以这一组守的是：
 *   · 私聊出去的那条消息确实带两颗回调按钮，data 能解回 `{t:'pf',n,v}`
 *   · 点「确认改」才批，点「不用了」只取消，不执行
 *   · 拿不到点击者身份 / 点击者不是主人 → 一律不认（fail-closed）
 *   · 同时只挂一条：新请求顶掉旧的，旧卡片的 nonce 立刻失效
 *   · 文本兜底只剩「确认」「不用」两个字面，不再认「好 / 行 / 确定 / ok」
 *
 * 跑法：node --test test/profile-confirm.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProfileConfirm, isConfirmWord, buildConfirmKeyboard,
  CONFIRM_TTL_MS, CONFIRM_BUTTON_TAG,
} from '../src/profile-confirm.js';
import { decodeButtonData } from '../src/roost-interaction.js';

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

/** 从发出去的那条消息里取出按钮的 nonce 与回传值 */
function buttonsOf(msg) {
  const rows = msg?.keyboard?.content?.rows ?? [];
  return rows.flatMap((r) => r.buttons ?? []).map((b) => ({
    label: b.render_data?.label,
    type: b.action?.type,
    clickLimit: b.action?.click_limit,
    group: b.group_id,
    ...decodeButtonData(b.action?.data),
  }));
}

test('A1 发起：私聊主人一条带两颗回调按钮的 markdown', async () => {
  const { c, sent } = setup();
  const r = await c.ask({ kind: 'sign', payload: { text: '今天想安静一点' }, summary: '「今天想安静一点」' });
  assert.equal(r.ok, true);
  assert.equal('code' in r, false, '不再发码');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].scene, 'c2c');
  assert.equal(sent[0].target, 'owner-openid');
  assert.equal(sent[0].markdown, true, '按钮要挂在 markdown 消息上');
  assert.match(sent[0].text, /今天想安静一点/);
  /**
   * 正文必须同时说明「按钮」和「打字怎么回」。
   *
   * `channel.js` 在 markdown 被 4xx 拒时会降级成纯文本重发，而降级那条路
   * **不带 keyboard**。只写「点下面的按钮」的话，按钮没了以后主人看到的是
   * 一句让他点不存在的东西的话，文本兜底又只认「确认」「不用」。
   */
  assert.match(sent[0].text, /按钮/, '要告诉主人怎么点');
  assert.match(sent[0].text, /确认/, '按钮显示不出来时要知道回什么');
  assert.match(sent[0].text, /不用/, '也要知道怎么拒绝');

  const btns = buttonsOf(sent[0]);
  assert.equal(btns.length, 2, '确认 + 不用');
  for (const b of btns) {
    assert.equal(b.type, 1, '必须是回调型，指令型不产生 INTERACTION');
    assert.equal(b.clickLimit, 1, '点过要变灰，防连点走两条路径');
    assert.equal(b.t, CONFIRM_BUTTON_TAG);
    assert.ok(b.n, 'nonce 不能空');
    assert.equal(b.group, `pf-${b.n}`, '同组按钮才能互斥变灰');
  }
  assert.deepEqual(btns.map((b) => b.v), ['y', 'n']);
  assert.equal(c.hasPending(), true);
});

test('A2 同一类还有未过期的请求 → 复用，不重复打扰', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  const b = await c.ask({ kind: 'name', payload: { name: '小绿' }, summary: '改成「小绿」' });
  assert.equal(b.reused, true);
  assert.equal(sent.length, 1, '只该发一条私聊');
});

test('A2b 不同类的新请求顶掉旧的 —— 旧卡片的 nonce 立刻失效', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  const oldNonce = buttonsOf(sent[0])[0].n;
  await c.ask({ kind: 'avatar', payload: { src: { url: 'https://x' } }, summary: '一张图' });
  assert.equal(c.list().length, 1, '同时只挂一条');
  assert.equal(c.list()[0].kind, 'avatar');

  const stale = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n: oldNonce, v: 'y' }),
    operatorId: 'owner-openid',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true, '旧卡片点了只回一句失效，不能改到新请求上');
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

test('A5 菜单不在确认范围（它一秒能改回来，不该走这套）', async () => {
  const { c } = setup();
  const r = await c.ask({ kind: 'menu', payload: {}, summary: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.message, /不需要确认/);
  assert.equal(c.hasPending(), false);
});

test('B1 点「确认改」→ 批，请求移除', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'sign', payload: { text: '新简介' }, summary: '「新简介」' });
  const yes = buttonsOf(sent[0])[0];
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n: yes.n, v: 'y' }),
    operatorId: 'owner-openid',
  });
  assert.equal(r.ok, true);
  assert.equal(r.approve, true);
  assert.equal(r.kind, 'sign');
  assert.deepEqual(r.payload, { text: '新简介' });
  assert.equal(c.hasPending(), false, '结算即作废，不能重复执行');
});

test('B2 点「不用了」→ 只取消，不执行', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  const no = buttonsOf(sent[0])[1];
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n: no.n, v: 'n' }),
    operatorId: 'owner-openid',
  });
  assert.equal(r.ok, true);
  assert.equal(r.approve, false, '取消不是批准');
  assert.equal(c.hasPending(), false);
});

test('B3 别的通道的按钮 → 不归我管（返回 null 让路由继续往下）', async () => {
  const { c } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  assert.equal(c.handleInteraction({ buttonData: JSON.stringify({ t: 'pick', n: 'x', v: '1' }) }), null);
  assert.equal(c.handleInteraction({ buttonData: 'not json' }), null);
  assert.equal(c.handleInteraction({}), null);
});

test('B4 伪造的按钮值不认', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  const n = buttonsOf(sent[0])[0].n;
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n, v: 'maybe' }),
    operatorId: 'owner-openid',
  });
  assert.equal(r.ok, false);
  assert.equal(c.hasPending(), true, '没批也没取消，请求还在');
});

test('B5 拿不到点击者身份 → fail-closed，不批', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'avatar', payload: {}, summary: '图' });
  const n = buttonsOf(sent[0])[0].n;
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n, v: 'y' }),
    operatorId: '',
  });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(c.hasPending(), true);
});

test('B5b 只给了 chatId 且就是主人 → 照样算（官方不同事件给的字段不一样）', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  const n = buttonsOf(sent[0])[0].n;
  /**
   * c2c 的交互回调可能只带 `chat_id` 不带 `user_openid`。只认 operatorId
   * 的话，字段一换名字所有按钮都会被静默拒掉（「点了没反应」）。
   */
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n, v: 'y' }),
    chatId: 'owner-openid',
  });
  assert.equal(r.ok, true);
  assert.equal(r.approve, true);
  assert.equal(r.operatorId, 'owner-openid', '没 operatorId 时用 chatId 顶上');
});

test('B6 别人点的按钮不算数', async () => {
  const { c, sent } = setup();
  await c.ask({ kind: 'avatar', payload: {}, summary: '图' });
  const n = buttonsOf(sent[0])[0].n;
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n, v: 'y' }),
    operatorId: 'somebody-else',
  });
  assert.equal(r.ok, false);
  assert.equal(r.denied, true);
  assert.equal(c.hasPending(), true);
});

test('B7 过期的按钮 → 回失效，不执行', async () => {
  const { c, sent, t } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  const n = buttonsOf(sent[0])[0].n;
  t.now += CONFIRM_TTL_MS + 1;
  const r = c.handleInteraction({
    buttonData: JSON.stringify({ t: CONFIRM_BUTTON_TAG, n, v: 'y' }),
    operatorId: 'owner-openid',
  });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
});

test('B8 buildConfirmKeyboard：没 nonce 就不给键盘（否则按钮点了没处结算）', () => {
  assert.equal(buildConfirmKeyboard(''), null);
  const kb = buildConfirmKeyboard('abc');
  assert.equal(kb.content.rows[0].buttons[0].group_id, 'pf-abc');
  /**
   * `style` 只有 0（灰）/ 1（蓝）两个合法值。
   *
   * 踩过一次：写成 `2` 想区分危险操作，平台不认这个值，**整条消息被拒**——
   * 表现是「点了改资料，主人什么都没收到」，而不是「按钮颜色不对」。
   */
  for (const b of kb.content.rows[0].buttons) {
    assert.ok([0, 1].includes(b.render_data.style), `style 只能 0 或 1，实际 ${b.render_data.style}`);
  }
});

test('T1 文本兜底：只认「确认」两个字面', async () => {
  const { c } = setup();
  await c.ask({ kind: 'sign', payload: { text: '新简介' }, summary: '「新简介」' });
  const req = c.take('确认');
  assert.ok(req);
  assert.equal(req.kind, 'sign');
  assert.deepEqual(req.payload, { text: '新简介' });
  assert.equal(c.hasPending(), false, '拿出来就作废，不能重复执行');
});

test('T2 同义词不再算数（这就是「不再模糊匹配」）', async () => {
  const { c } = setup();
  await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  for (const s of ['好', '行', '可以', '嗯', '确定', '同意', '批准', 'ok', '好，改吧', '可以，改']) {
    assert.equal(c.take(s), null, `不该认：${s}`);
  }
  assert.equal(c.hasPending(), true, '没确认就还挂着');
  assert.ok(c.take('确认'), '只有这两个字算');
});

test('T3 isConfirmWord 收窄到字面等值', () => {
  for (const s of ['确认', '确认！', '确认。', ' 确认 ', '确认…']) {
    assert.equal(isConfirmWord(s), true, `该认：${s}`);
  }
  for (const s of [
    '好', '行', '嗯', '可以', '确定', '同意', '批准', '没问题', 'ok', 'OK！',
    '改吧', '就这么改', '好，改吧', '行，换', '随便', '', '确认一下她刚才说的',
    '可以改天再说', '好换个话题',
  ]) {
    assert.equal(isConfirmWord(s), false, `不该认：${s}`);
  }
});

test('T4 文本兜底「不用」取消最近一条', async () => {
  const { c } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  assert.ok(c.cancelLatest('不用'));
  assert.equal(c.hasPending(), false);
});

test('T5 不是取消词就不动 pending', async () => {
  const { c } = setup();
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  assert.equal(c.cancelLatest('今天天气不错'), null);
  assert.equal(c.cancelLatest('不用了'), null, '同义词也收窄了，只认「不用」');
  assert.equal(c.hasPending(), true);
});

test('T6 新请求发送失败时，旧的 pending 不该被顶掉', async () => {
  let fail = false;
  const c = createProfileConfirm({
    send: async () => {
      if (fail) throw new Error('额度用完了');
      return { ok: true };
    },
    ownerOf: () => 'owner-openid',
    now: () => 1_000_000,
    log: () => {},
  });
  await c.ask({ kind: 'sign', payload: { text: 'x' }, summary: 'x' });
  fail = true;
  const r = await c.ask({ kind: 'avatar', payload: {}, summary: '图' });
  assert.equal(r.ok, false);
  assert.equal(c.list().length, 1);
  assert.equal(c.list()[0].kind, 'sign', '旧请求还在，等主人点按钮');
});

test('E1 超过有效期自动作废', async () => {
  const { c, t } = setup();
  await c.ask({ kind: 'avatar', payload: { src: { url: 'https://x' } }, summary: '一张图' });
  t.now += CONFIRM_TTL_MS + 1;
  assert.equal(c.hasPending(), false);
  assert.equal(c.take('确认'), null);
});

test('L1 list 只给类与摘要，不带 payload / nonce', async () => {
  const { c } = setup();
  await c.ask({ kind: 'name', payload: { name: '小蓝' }, summary: '改成「小蓝」' });
  const list = c.list();
  assert.equal(list.length, 1);
  assert.equal('payload' in list[0], false);
  assert.equal('nonce' in list[0], false);
  assert.equal(list[0].kind, 'name');
});
