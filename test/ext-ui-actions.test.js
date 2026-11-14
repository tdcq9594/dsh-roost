// 扩展页面按钮的动作队列：排队、去重、过期、按扩展隔离、读即消费。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUiActionQueue, ACTION_TTL_MS, MAX_PER_EXT } from '../src/ext-ui-actions.js';

const queueAt = (t0 = 1_000_000) => {
  let t = t0;
  return {
    q: createUiActionQueue({ now: () => t }),
    tick: (ms) => { t += ms; },
    now: () => t,
  };
};

test('入队后能取到，取一次就清空（读即消费）', () => {
  const { q } = queueAt();
  const r = q.push('bili', 'refresh_hot');
  assert.equal(r.ok, true);
  assert.equal(r.pending, 1);

  const a = q.take('bili');
  assert.equal(a.ok, true);
  assert.equal(a.actions.length, 1);
  assert.equal(a.actions[0].action, 'refresh_hot');
  assert.match(a.actions[0].nonce, /^[0-9a-f-]{36}$/);

  const b = q.take('bili');
  assert.equal(b.actions.length, 0, '取过之后不能重复执行同一个点击');
});

test('同一个动作连点只留一条，不同的动作各留一条', () => {
  const { q } = queueAt();
  assert.equal(q.push('bili', 'feed_now').ok, true);
  const dup = q.push('bili', 'feed_now');
  assert.equal(dup.ok, true);
  assert.equal(dup.deduped, true);
  assert.equal(q.push('bili', 'refresh_hot').ok, true);

  const a = q.take('bili');
  assert.deepEqual(a.actions.map((x) => x.action), ['feed_now', 'refresh_hot']);
});

test('按扩展隔离：取不到别的扩展的动作', () => {
  const { q } = queueAt();
  q.push('bili', 'feed_now');
  q.push('other', 'do_thing');

  assert.deepEqual(q.take('other').actions.map((x) => x.action), ['do_thing']);
  assert.deepEqual(q.take('bili').actions.map((x) => x.action), ['feed_now']);
});

test('过期动作取不出来，也不会被算成待处理', () => {
  const { q, tick } = queueAt();
  q.push('bili', 'feed_now');
  tick(ACTION_TTL_MS + 1);

  const a = q.take('bili');
  assert.equal(a.actions.length, 0, '离线一小时后上线不该补跑攒下来的点击');
  assert.equal(a.dropped, 1);
  assert.equal(q.peek('bili').pending, 0);
});

test('单个扩展堆积有上限，避免被反复点击撑大', () => {
  const { q } = queueAt();
  for (let i = 0; i < MAX_PER_EXT; i++) {
    assert.equal(q.push('bili', `act_${i}`).ok, true);
  }
  const over = q.push('bili', 'act_over');
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'busy');
});

test('空 id / 空动作直接拒，不产生半个条目', () => {
  const { q } = queueAt();
  assert.equal(q.push('', 'feed_now').ok, false);
  assert.equal(q.push('bili', '').ok, false);
  assert.equal(q.total(), 0);
});

test('动作可以带一小段参数（弹幕表单），取值原样带回', () => {
  const { q } = queueAt();
  const r = q.push('bili', 'danmaku_send', { bvid: 'BV1xx411c7mD', text: '好看', seconds: 12 });
  assert.equal(r.ok, true);
  const a = q.take('bili');
  assert.deepEqual(a.actions[0].payload, { bvid: 'BV1xx411c7mD', text: '好看', seconds: 12 });

  /** 没参数时显式给 null，别让扩展拿到 undefined 和老版本不兼容 */
  q.push('bili', 'feed_now');
  assert.equal(q.take('bili').actions[0].payload, null);
});

test('动作参数太大或不是对象，直接拒', () => {
  const { q } = queueAt();
  assert.equal(q.push('bili', 'x', 'abc').ok, false);
  assert.equal(q.push('bili', 'x', [1, 2]).ok, false);
  assert.equal(q.push('bili', 'x', { big: 'a'.repeat(3000) }).ok, false);
});

test('peek 不消费，clear 能一次清掉', () => {
  const { q } = queueAt();
  q.push('bili', 'feed_now');
  assert.equal(q.peek('bili').pending, 1);
  assert.equal(q.peek('bili').pending, 1, 'peek 不能把队列读空');
  assert.equal(q.clear('bili').cleared, 1);
  assert.equal(q.take('bili').actions.length, 0);
});
