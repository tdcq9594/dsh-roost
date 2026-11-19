// 对外静默窗口 + 醒着窗口的 24 点边界。
//
// 这组用例钉三件「不报错、不白屏，只是行为悄悄变了」的事：
//   1. 窗口按分钟判、跨夜照常，留空/填坏一律不启用（fail-open）；
//   2. **主人豁免的判据是 `bucket`**，而 bucket 只有宿主拿到 payload 之后才有。
//      所以判定不在 `roostDecider`（同步、只有 openid）里，而在 `deliverBatch`
//      的 `onInbound` 之前——这条用例测的就是那个纯函数。
//   3. `awakeTo=24` 的语义锁死（8–24 = 只放行 8 点之后）。**复核结论**：
//      我们原来的实现就已经是对的（`hour < 24` 那几个字符是冗余、不是错），
//      这一组用例是防御性的——将来谁把 `to` 改成 `hour <= to` 或先 `%24`
//      再判相等，这里会立刻红。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guestQuietActive, guestQuietSkip, resolveGroupPolicy } from '../src/roost-decide.js';
import { inWindow } from '../src/awake.js';

const at = (h, m = 0) => new Date(2026, 10, 19, h, m, 0).getTime();
const QUIET = { guestQuietFrom: '22:00', guestQuietTo: '07:00' };

/* ------------------------------------------------------------------ */
/* 纯函数：窗口判定                                                     */
/* ------------------------------------------------------------------ */

test('guestQuietActive：跨夜窗口按分钟判，边界左闭右开', () => {
  assert.equal(guestQuietActive(at(22, 0), '22:00', '07:00'), true, '起点算在内');
  assert.equal(guestQuietActive(at(23, 30), '22:00', '07:00'), true);
  assert.equal(guestQuietActive(at(3, 0), '22:00', '07:00'), true);
  assert.equal(guestQuietActive(at(6, 59), '22:00', '07:00'), true);
  assert.equal(guestQuietActive(at(7, 0), '22:00', '07:00'), false, '终点不算');
  assert.equal(guestQuietActive(at(12, 0), '22:00', '07:00'), false);
  assert.equal(guestQuietActive(at(21, 59), '22:00', '07:00'), false);
});

test('guestQuietActive：半小时边界精确生效（整点比较会漏）', () => {
  assert.equal(guestQuietActive(at(1, 29), '01:30', '08:00'), false);
  assert.equal(guestQuietActive(at(1, 30), '01:30', '08:00'), true);
  assert.equal(guestQuietActive(at(7, 59), '01:30', '08:00'), true);
  assert.equal(guestQuietActive(at(8, 0), '01:30', '08:00'), false);
});

test('guestQuietActive：没填 / 填坏 / 起止相同 一律不启用', () => {
  const bad = [
    ['', ''], [null, undefined], ['22:00', ''], ['abc', '07:00'],
    ['22:00', '22:00'], ['25:00', '07:00'], ['22:70', '07:00'],
  ];
  for (const [f, t] of bad) {
    assert.equal(guestQuietActive(at(3, 0), f, t), false, `${f}–${t} 不该生效`);
  }
});

/* ------------------------------------------------------------------ */
/* 拦截判定：主人豁免看 bucket                                          */
/* ------------------------------------------------------------------ */

test('guestQuietSkip：窗口内非主人被拦，主人放行', () => {
  assert.deepEqual(guestQuietSkip(at(23, 0), QUIET, 'member').skip, true);
  assert.deepEqual(guestQuietSkip(at(23, 0), QUIET, 'owner').skip, false);
});

test('guestQuietSkip：管理员/群管也拦（只有主人叫得醒，这是语义不是口误）', () => {
  for (const b of ['admin', 'manager', 'helper', 'unknown', '']) {
    assert.equal(guestQuietSkip(at(3, 0), QUIET, b).skip, true, `${b} 在窗口内也该被拦`);
  }
});

test('guestQuietSkip：私聊不受影响（一对一是用户专门找她，不该被拦）', () => {
  assert.equal(guestQuietSkip(at(23, 0), QUIET, 'member', 'c2c').skip, false);
  assert.equal(guestQuietSkip(at(23, 0), QUIET, 'member', 'dm').skip, false);
  assert.equal(guestQuietSkip(at(23, 0), QUIET, 'member', 'group').skip, true, '群里照拦');
});

test('guestQuietSkip：窗口外谁都不拦', () => {
  assert.equal(guestQuietSkip(at(12, 0), QUIET, 'member').skip, false);
  assert.equal(guestQuietSkip(at(7, 0), QUIET, 'member').skip, false, '终点之后放行');
});

test('guestQuietSkip：没配置 / 只配一半 / 填坏，都不拦（fail-open）', () => {
  for (const d of [{}, { guestQuietFrom: '22:00' }, { guestQuietTo: '07:00' }, { guestQuietFrom: 'x', guestQuietTo: 'y' }, null]) {
    assert.equal(guestQuietSkip(at(3, 0), d, 'member').skip, false, JSON.stringify(d));
  }
});

test('guestQuietSkip：reason 里带出窗口，排障时能直接看到是哪一段', () => {
  const v = guestQuietSkip(at(23, 0), QUIET, 'member');
  assert.match(v.reason, /对外静默/);
  assert.match(v.reason, /22:00–07:00/);
});

test('guestQuietSkip：单群覆写能单独关掉窗口（走 resolveGroupPolicy）', () => {
  const cfg = {
    roostHost: { decide: { ...QUIET } },
    group: { overrides: { QUIET_OFF: { guestQuietFrom: '', guestQuietTo: '' } } },
  };
  assert.equal(guestQuietSkip(at(23, 0), resolveGroupPolicy(cfg, 'QUIET_OFF').decide, 'member').skip, false);
  assert.equal(guestQuietSkip(at(23, 0), resolveGroupPolicy(cfg, 'OTHER').decide, 'member').skip, true);
});

/* ------------------------------------------------------------------ */
/* G3：awakeTo=24 不能被当成全天                                        */
/* ------------------------------------------------------------------ */

test('inWindow：8–24 只放行 8 点之后，不是全天', () => {
  assert.equal(inWindow(8, 8, 24), true);
  assert.equal(inWindow(23, 8, 24), true);
  assert.equal(inWindow(7, 8, 24), false, '8–24 放行的是 8 点之后，不是全天');
  assert.equal(inWindow(0, 8, 24), false);
});

test('inWindow：0–24 仍是全天，24–8 等价于 0–8', () => {
  assert.equal(inWindow(3, 0, 24), true);
  assert.equal(inWindow(0, 24, 8), true);
  assert.equal(inWindow(7, 24, 8), true);
  assert.equal(inWindow(8, 24, 8), false);
});

test('inWindow：字符串数字也认（手改 config.json 会写成 "8"）', () => {
  assert.equal(inWindow(9, '8', '24'), true);
  assert.equal(inWindow(7, '8', '24'), false);
  assert.equal(inWindow(9, '8', '8'), true, '起止相同 = 全天');
});
