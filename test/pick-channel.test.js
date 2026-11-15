/**
 * E3：回调型按钮（`<<pick: 标签|值>>`）
 * ====================================
 *
 * 钉住四件会「悄悄坏掉」的事：
 *   1. 现有 `<<button:>>` 必须仍是 `action.type: 2`，一个字都不能变
 *   2. pick 生成的必须是 `type: 1` + group_id + click_limit + visited_label
 *   3. 两种按钮同轮出现时要合并且不撞 id，不能丢任何一方
 *   4. 旧卡片 / 伪造值 / 错会话 / 非授权点击都要静默失效
 *
 * 跑法：node --test test/pick-channel.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOutboundActions, parseButton, buildKeyboard, parsePick,
  buildPickKeyboard, combineKeyboards, createActionRunner,
} from '../src/outbound-actions.js';
import { createPickChannel } from '../src/pick-channel.js';
import { decodeButtonData, createInteractionRouter } from '../src/roost-interaction.js';

function fakeChannel() {
  const calls = [];
  return {
    calls,
    async send(p) { calls.push(['send', p]); return { ok: true, id: `m${calls.length}` }; },
  };
}

/** 造一条能被 pickChannel.handle 吃的解析结果 */
function click(nonce, value, over = {}) {
  return {
    event: 'INTERACTION_CREATE', id: 'i-1', type: 11,
    buttonData: JSON.stringify({ t: 'pick', n: nonce, v: value }),
    buttonId: 'btn-1', operatorId: 'OWNER', chatId: 'chat-1', scene: 'c2c',
    ...over,
  };
}

/* ---------------- 解析与键盘形状 ---------------- */

test('parsePick 解析 标签|值，沿用 button 的长度上限', () => {
  assert.deepEqual(parsePick('同意 | yes'), { label: '同意', value: 'yes' });
  assert.deepEqual(parsePick('只给标签'), { label: '只给标签', value: '只给标签' });
  assert.equal(parsePick(''), null);
  assert.equal(parsePick('   '), null);
});

test('parseOutboundActions 把 pick 单独摘出来，不混进 button', () => {
  const { text, actions } = parseOutboundActions('选一个 <<pick: 同意|yes>> <<pick: 拒绝|no>> <<button: 再来|/again>>');
  assert.doesNotMatch(text, /<</);
  assert.equal(actions.filter((a) => a.type === 'pick').length, 2);
  assert.equal(actions.filter((a) => a.type === 'button').length, 1, '通用兜底不能把 pick 吃掉');
});

test('代码块里的 <<pick:>> 不执行（模型讲解写法时不误发按钮）', () => {
  const { text, actions } = parseOutboundActions('`<<pick: A|a>>` 和真的 <<pick: B|b>>');
  assert.equal(actions.filter((a) => a.type === 'pick').length, 1);
  assert.match(text, /<<pick: A\|a>>/);
});

test('buildPickKeyboard：type 1 / 同组 group_id / click_limit 1 / visited_label', () => {
  const kb = buildPickKeyboard([{ label: '同意', value: 'yes' }, { label: '拒绝', value: 'no' }], 'NONCE1');
  const buttons = kb.content.rows.flatMap((r) => r.buttons);
  assert.equal(buttons.length, 2);
  for (const b of buttons) {
    assert.equal(b.action.type, 1, '回调型');
    assert.equal(b.action.click_limit, 1);
    assert.equal(b.group_id, 'pick-NONCE1', '同组互斥');
    assert.equal(b.render_data.visited_label, '✓ 已选');
    const d = decodeButtonData(b.action.data);
    assert.equal(d.t, 'pick');
    assert.equal(d.n, 'NONCE1');
  }
  assert.deepEqual(buttons.map((b) => decodeButtonData(b.action.data).v), ['yes', 'no']);
});

test('现有 buildKeyboard 仍是 type 2（一个字都没动）', () => {
  const kb = buildKeyboard([{ label: '再来', data: '/again' }]);
  const b = kb.content.rows[0].buttons[0];
  assert.equal(b.action.type, 2);
  assert.equal(b.action.data, '/again');
  assert.equal(b.group_id, undefined, '指令型不该有 group_id');
});

test('combineKeyboards 合并两种按钮并重排 id，不丢任何一方', () => {
  const a = buildKeyboard([{ label: '再来', data: '/again' }]);
  const b = buildPickKeyboard([{ label: '同意', value: 'yes' }], 'N1');
  const kb = combineKeyboards([a, b]);
  const all = kb.content.rows.flatMap((r) => r.buttons);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x) => x.id), ['1', '2'], 'id 不能撞');
  assert.equal(all[0].action.type, 2);
  assert.equal(all[1].action.type, 1);
  assert.equal(combineKeyboards([null, null]), null);
});

test('没有 nonce 时不生成回调按钮（不产生孤儿回调）', () => {
  assert.equal(buildPickKeyboard([{ label: 'A', value: 'a' }], ''), null);
  assert.equal(buildPickKeyboard([], 'N1'), null);
});

/* ---------------- 通道结算 ---------------- */

test('arm → handle 结算一次，onPick 与 promise 都拿到值', async () => {
  const picks = createPickChannel();
  const got = [];
  const { nonce, promise } = picks.arm({
    values: ['yes', 'no'], chatId: 'chat-1', allowed: ['OWNER'],
    onPick: (r) => got.push(r),
  });
  assert.equal(picks.size, 1);
  assert.equal(picks.handle(click(nonce, 'yes')), true);
  const r = await promise;
  assert.equal(r.value, 'yes');
  assert.equal(r.operatorId, 'OWNER');
  assert.equal(got.length, 1);
  assert.equal(picks.size, 0, '结算完立刻删');
});

test('重复点击 / 旧卡片：第二次静默失效', () => {
  const picks = createPickChannel();
  const { nonce } = picks.arm({ values: ['yes'], chatId: 'chat-1' });
  assert.equal(picks.handle(click(nonce, 'yes')), true);
  assert.equal(picks.handle(click(nonce, 'yes')), false);
  assert.equal(picks.handle(click('OLD-NONCE', 'yes')), false);
});

test('伪造不在选项里的值被拒', () => {
  const picks = createPickChannel();
  const { nonce } = picks.arm({ values: ['yes', 'no'], chatId: 'chat-1' });
  assert.equal(picks.handle(click(nonce, '/rm -rf /')), false);
  assert.equal(picks.size, 1, '不结算，挂起保留');
});

test('错会话点击被拒（A 群的卡片不能批准 B 群的事）', () => {
  const picks = createPickChannel();
  const { nonce } = picks.arm({ values: ['yes'], chatId: 'chat-1' });
  assert.equal(picks.handle(click(nonce, 'yes', { chatId: 'chat-2' })), false);
  assert.equal(picks.size, 1);
});

test('白名单模式 fail-closed：非授权人、身份缺失都静默丢弃', () => {
  const picks = createPickChannel();
  const { nonce } = picks.arm({ values: ['yes'], chatId: 'chat-1', allowed: ['OWNER'] });
  assert.equal(picks.handle(click(nonce, 'yes', { operatorId: 'STRANGER' })), false);
  assert.equal(picks.handle(click(nonce, 'yes', { operatorId: '' })), false);
  assert.equal(picks.size, 1);
  assert.equal(picks.handle(click(nonce, 'yes')), true, '授权人仍然能点');
});

test('没传 allowed 时不额外收紧，与现有指令按钮口径一致', () => {
  const picks = createPickChannel();
  const { nonce } = picks.arm({ values: ['yes'], chatId: 'chat-1' });
  assert.equal(picks.handle(click(nonce, 'yes', { operatorId: 'ANYONE' })), true);
});

test('非 pick 通道的按钮交回路由（返回 false），不误吞', () => {
  const picks = createPickChannel();
  const { nonce } = picks.arm({ values: ['yes'] });
  assert.equal(picks.handle(click(nonce, 'yes', { buttonData: '{"t":"other"}' })), false);
  assert.equal(picks.size, 1);
});

test('超时结算为 null，定时器不吊住进程', async () => {
  let fired = null;
  const picks = createPickChannel({
    setTimeoutFn: (fn) => { fired = fn; return { unref() {} }; },
    clearTimeoutFn: () => {},
  });
  const { promise } = picks.arm({ values: ['yes'] });
  assert.ok(fired, '装了定时器');
  fired();
  assert.equal(await promise, null);
  assert.equal(picks.size, 0);
});

test('cancelChat 清掉该会话所有挂起项', async () => {
  const picks = createPickChannel({ setTimeoutFn: () => null, clearTimeoutFn: () => {} });
  picks.arm({ values: ['a'], chatId: 'chat-1' });
  picks.arm({ values: ['b'], chatId: 'chat-1' });
  picks.arm({ values: ['c'], chatId: 'chat-2' });
  assert.equal(picks.cancelChat('chat-1'), 2);
  assert.equal(picks.size, 1);
  picks.clear();
  assert.equal(picks.size, 0);
});

test('超过 MAX_PENDING 淘汰最旧的一组', () => {
  const picks = createPickChannel({ setTimeoutFn: () => null, clearTimeoutFn: () => {} });
  for (let i = 0; i < 34; i++) picks.arm({ values: ['a'] });
  assert.equal(picks.size, 32);
});

/* ---------------- 端到端：runner + router ---------------- */

test('端到端：<<pick:>> 发出 type:1 按钮 → INTERACTION_CREATE → 结算', async () => {
  const ch = fakeChannel();
  const picks = createPickChannel();
  const router = createInteractionRouter();
  router.register((parsed) => picks.handle(parsed));
  const got = [];
  const run = createActionRunner({ channel: () => ch, picks, onPick: (r) => got.push(r.value) });

  await run({ text: '要发吗？ <<pick: 发|yes>> <<pick: 不发|no>>', target: 'chat-1', scene: 'c2c' });
  const sent = ch.calls.find((c) => c[0] === 'send')[1];
  const btns = sent.keyboard.content.rows.flatMap((r) => r.buttons);
  assert.equal(btns.length, 2);
  assert.equal(btns[0].action.type, 1);
  const nonce = decodeButtonData(btns[0].action.data).n;
  assert.ok(nonce);
  assert.equal(picks.size, 1);

  assert.equal(router.dispatch({
    event: 'INTERACTION_CREATE',
    data: {
      id: 'i-1', type: 11, user_openid: 'SOMEONE',
      data: { resolved: { button_data: btns[1].action.data } },
    },
  }), true);
  assert.deepEqual(got, ['no']);
  assert.equal(picks.size, 0);
});

test('端到端：同轮 button + pick 共存，两种按钮都在且 id 不撞', async () => {
  const ch = fakeChannel();
  const picks = createPickChannel();
  const run = createActionRunner({ channel: () => ch, picks });
  /** 正文不能空：现有 runner 在「摘完标记只剩空白」时本就不发消息 */
  await run({ text: '选一个吧 <<button: 再来|/again>> <<pick: 同意|yes>>', target: 'chat-1' });
  const sent = ch.calls.find((c) => c[0] === 'send')[1];
  const all = sent.keyboard.content.rows.flatMap((r) => r.buttons);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((b) => b.action.type), [2, 1]);
  assert.deepEqual(all.map((b) => b.id), ['1', '2']);
});

test('没注入 picks 时 <<pick:>> 只摘掉不发按钮（纯加法降级）', async () => {
  const ch = fakeChannel();
  const logs = [];
  const run = createActionRunner({ channel: () => ch, log: (m) => logs.push(m) });
  await run({ text: '选 <<pick: A|a>>', target: 'chat-1' });
  const sent = ch.calls.find((c) => c[0] === 'send')[1];
  assert.equal(sent.keyboard, null);
  assert.doesNotMatch(sent.text, /<</);
  assert.ok(logs.some((m) => /没接回调通道/.test(m)));
});
