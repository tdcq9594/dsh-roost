/**
 * 外接协议交互事件：剥层解析 + 路由
 * =================================
 *
 * 钉住两件最容易错的事：
 *   1. button_data 在 notice.data.data.resolved.button_data（少剥一层就收不到）
 *   2. E2 阶段没有注册处理器时，命中事件必须**静默**，不能改任何现有行为
 *
 * 跑法：node --test test/roost-interaction.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInteractionNotice, decodeButtonData, encodeButtonData,
  createInteractionRouter,
} from '../src/roost-interaction.js';

/** 造一条完整链路上的 notice 帧：{at, event, data:d} */
function notice(buttonData, extra = {}) {
  return {
    at: Date.now(),
    event: 'INTERACTION_CREATE',
    data: {
      id: 'i-1',
      type: 11,
      group_openid: 'GROUP-OPENID',
      ...extra,
      data: {
        resolved: {
          button_data: buttonData,
          button_id: 'btn-1',
          group_member_openid: 'MEMBER-OPENID',
        },
      },
    },
  };
}

test('从完整的 notice 帧里剥出 button_data / 点击者 / 会话', () => {
  const p = parseInteractionNotice(notice('{"t":"pick","n":"n1","v":"yes"}'));
  assert.equal(p.event, 'INTERACTION_CREATE');
  assert.equal(p.id, 'i-1');
  assert.equal(p.type, 11);
  assert.equal(p.buttonData, '{"t":"pick","n":"n1","v":"yes"}');
  assert.equal(p.buttonId, 'btn-1');
  assert.equal(p.operatorId, 'MEMBER-OPENID');
  assert.equal(p.chatId, 'GROUP-OPENID');
  assert.equal(p.scene, 'group');
});

test('私聊事件没有 group_openid 时落到 c2c，点击者取 user_openid', () => {
  const d = notice('');
  delete d.data.group_openid;
  delete d.data.data.resolved.group_member_openid;
  d.data.data.resolved.user_openid = 'USER-OPENID';
  const p = parseInteractionNotice(d);
  assert.equal(p.scene, 'c2c');
  assert.equal(p.operatorId, 'USER-OPENID');
});

test('不是 INTERACTION_CREATE / 结构不对时返回 null', () => {
  assert.equal(parseInteractionNotice(null), null);
  assert.equal(parseInteractionNotice({ event: 'GROUP_MSG_RECEIVE', data: {} }), null);
  assert.equal(parseInteractionNotice({ event: 'INTERACTION_CREATE' }), null);
  assert.equal(parseInteractionNotice({ event: 'INTERACTION_CREATE', data: 'str' }), null);
});

test('decodeButtonData：缺 t / 非法 JSON / 数组 都拒绝', () => {
  assert.equal(decodeButtonData(''), null);
  assert.equal(decodeButtonData('not json'), null);
  assert.equal(decodeButtonData('{"n":"x"}'), null);
  assert.equal(decodeButtonData('[1,2]'), null);
  assert.deepEqual(decodeButtonData('{"t":"pick","n":"n1","v":"yes"}'), {
    t: 'pick', n: 'n1', v: 'yes', raw: { t: 'pick', n: 'n1', v: 'yes' },
  });
  assert.equal(decodeButtonData('{"t":"pick","v":0}').v, '0', '0 不能被当成空');
});

test('encode/decode 往返', () => {
  const data = { t: 'pick', n: 'abc123', v: '选项 A' };
  assert.deepEqual(decodeButtonData(encodeButtonData(data)).raw, data);
});

test('E2 纯加法：没注册处理器时命中也静默，返回 false', () => {
  const seen = [];
  const r = createInteractionRouter({ debug: (m) => seen.push(m) });
  assert.equal(r.size, 0);
  assert.equal(r.dispatch(notice('{"t":"pick","n":"n1","v":"1"}')), false);
  assert.equal(seen.length, 1, '只留一条可排查的 debug');
});

test('注册后按解析结果分发；处理返回 false 视为未命中', () => {
  const got = [];
  const r = createInteractionRouter();
  r.register((p) => { got.push(p.buttonData); return true; });
  assert.equal(r.size, 1);
  assert.equal(r.dispatch(notice('{"t":"pick","n":"n1","v":"1"}')), true);
  assert.equal(got[0], '{"t":"pick","n":"n1","v":"1"}');
  r.reset();
  assert.equal(r.size, 0);
});

test('处理器抛错被吞掉，不会打断 SSE 事件流', () => {
  const errs = [];
  const r = createInteractionRouter({ log: (m) => errs.push(m) });
  r.register(() => { throw new Error('boom'); });
  assert.equal(r.dispatch(notice('{"t":"pick"}')), false);
  assert.equal(errs.length, 1);
});

test('注册非函数直接报错，避免悄悄变成「永远没处理器」', () => {
  const r = createInteractionRouter();
  assert.throws(() => r.register(null), TypeError);
});
