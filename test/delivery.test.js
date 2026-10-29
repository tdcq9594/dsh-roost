// 投递终态跟踪（`src/delivery.js`）的测试。
//
// 这块最容易出的错是**把「问不到」当成「没发出去」**：一条其实已经送达的
// 消息被记成失败，重发一次用户就收到两条。所以断言基本都在盯
// 「什么情况下不该结案」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDeliveryTrack, TTL_MS, KEEP_MS, MAX_ITEMS } from '../src/delivery.js';
import { createFakeChannel } from '../src/channel.js';

const DAY = 86_400_000;

function rig({ states = {}, failWith = '', pending = true, t = 1_700_000_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-deliv-'));
  const file = join(dir, 'delivery.json');
  const ch = createFakeChannel({ states, failWith, pending });
  let clock = t;
  const logs = [];
  const track = createDeliveryTrack({
    file,
    channelOf: () => ch,
    now: () => clock,
    log: (m) => logs.push(m),
  });
  return {
    file,
    ch,
    track,
    logs,
    tick: (ms) => { clock += ms; },
    at: () => clock,
    raw: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}

/* ---------------- 登记 ---------------- */

test('登记：缺 requestId 不记（不然查询会查一堆空 id）', () => {
  const { track, file } = rig();
  assert.equal(track.note({ requestId: '' }), false);
  assert.equal(track.note({}), false);
  assert.equal(track.pending().length, 0);
  assert.equal(existsSync(file), false, '什么都没登记就不该创建文件');
});

test('登记：记下场景、目标、摘要，状态是等待', () => {
  const { track } = rig();
  track.note({ requestId: 'r1', scene: 'group', target: 'g1', text: '在吗' });
  const [x] = track.pending();
  assert.equal(x.requestId, 'r1');
  assert.equal(x.scene, 'group');
  assert.equal(x.target, 'g1');
  assert.equal(x.state, 'waiting');
  assert.equal(x.text, '在吗');
});

test('登记：同一个 id 登记两次只有一条（重试不该变两条）', () => {
  const { track } = rig();
  track.note({ requestId: 'r1', target: 'g1' });
  track.note({ requestId: 'r1', target: 'g1' });
  assert.equal(track.list().length, 1);
});

test('登记：摘要截断，不存全文', () => {
  const { track } = rig();
  track.note({ requestId: 'r1', text: 'x'.repeat(500) });
  assert.ok(track.get('r1').text.length <= 60, String(track.get('r1').text.length));
});

/* ---------------- 查询与结案 ---------------- */

test('查询：sent 就结案，日志里说一声', async () => {
  const { track, logs } = rig({ states: { r1: 'sent' } });
  track.note({ requestId: 'r1', target: 'g1' });
  const r = await track.resolve();
  assert.equal(r.settled.length, 1);
  assert.equal(track.get('r1').state, 'sent');
  assert.ok(logs.some((m) => m.includes('→ sent')), logs.join(' | '));
});

test('查询：还在审核就继续等，不算结案', async () => {
  const { track } = rig({ states: { r1: 'audited' } });
  track.note({ requestId: 'r1' });
  const r = await track.resolve();
  assert.equal(r.settled.length, 0);
  assert.equal(track.get('r1').state, 'waiting');
  assert.equal(r.still, 1);
});

test('查询：审核驳回是 failed，带上原因码', async () => {
  const { track } = rig({ states: { r1: { state: 'failed', code: 'audit-reject', parts: 1 } } });
  track.note({ requestId: 'r1' });
  await track.resolve();
  assert.equal(track.get('r1').state, 'failed');
  assert.equal(track.get('r1').code, 'audit-reject');
});

test('查询：unknown 单独记，不能和 failed 混（一个能重发一个不能）', async () => {
  const { track } = rig({ states: { r1: 'unknown' } });
  track.note({ requestId: 'r1' });
  await track.resolve();
  assert.equal(track.get('r1').state, 'unknown');
});

test('查询：账本里没有这条 → gone，放弃跟踪', async () => {
  const { track } = rig({ states: {} });
  track.note({ requestId: 'r-nope' });
  const r = await track.resolve();
  assert.equal(track.get('r-nope').state, 'gone');
  assert.equal(r.settled.length, 1);
  // 再查也不会重复结案
  const again = await track.resolve();
  assert.equal(again.checked, 0, 'gone 之后不该再查');
});

test('查询：网络挂了保持等待，绝不记成失败', async () => {
  // 这是这块最重要的断言：查不到 ≠ 没发出去。
  // 记成 failed 就会被重发，用户收到两条一样的消息。
  const dir = mkdtempSync(join(tmpdir(), 'roost-deliv-'));
  const track = createDeliveryTrack({
    file: join(dir, 'delivery.json'),
    channelOf: () => ({
      async delivery() { throw new Error('ECONNREFUSED'); },
    }),
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  track.note({ requestId: 'r1' });
  const r = await track.resolve();
  assert.equal(r.settled.length, 0);
  assert.equal(track.get('r1').state, 'waiting');
});

test('查询：通道不支持查询就跳过，条目留着等人看', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-deliv-'));
  const track = createDeliveryTrack({
    file: join(dir, 'delivery.json'),
    channelOf: () => ({ name: 'old', async send() { return { ok: true }; } }),
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  track.note({ requestId: 'r1' });
  const r = await track.resolve();
  assert.equal(r.skipped, true);
  assert.equal(r.still, 1, '老通道也不能把这些条目丢掉');
  assert.equal(track.get('r1').state, 'waiting');
});

test('查询：一次最多查 limit 条，先查最老的', async () => {
  const { track, tick } = rig({ states: {} });
  for (let i = 0; i < 5; i++) {
    track.note({ requestId: `r${i}` });
    tick(1000);
  }
  // 让前三条有结果，后两条查不到
  const r = await track.resolve({ limit: 3 });
  assert.equal(r.checked, 3);
  // 最老的三条被查了 → 变成 gone
  assert.equal(track.get('r0').state, 'gone');
  assert.equal(track.get('r2').state, 'gone');
  assert.equal(track.get('r3').state, 'waiting', '超出的不该被查');
});

/* ---------------- nextState 单测（结案判断只有这一处） ---------------- */

test('nextState：这几种都必须结案', () => {
  const { track } = rig();
  assert.equal(track.nextState({ ok: true, state: 'sent' }).settled, true);
  assert.equal(track.nextState({ ok: true, state: 'failed' }).settled, true);
  assert.equal(track.nextState({ ok: true, state: 'unknown' }).settled, true);
  assert.equal(track.nextState({ ok: false, gone: true }).settled, true);
});

test('nextState：这几种必须保持等待', () => {
  const { track } = rig();
  assert.equal(track.nextState({ ok: false, message: '连不上' }, 'waiting').state, 'waiting');
  assert.equal(track.nextState({ ok: true, state: 'pending' }).state, 'waiting');
  assert.equal(track.nextState({ ok: true, state: 'audited' }).state, 'waiting');
  assert.equal(track.nextState({ ok: true, state: '什么鬼' }).state, 'waiting');
  assert.equal(track.nextState(null, 'waiting').state, 'waiting');
});

/* ---------------- 过期与上限 ---------------- */

test('过期：还在等的 3 天后不再等', () => {
  const { track, tick } = rig();
  track.note({ requestId: 'r1' });
  tick(TTL_MS - 1000);
  track.prune();
  assert.equal(track.pending().length, 1, '没到 3 天要留着');

  tick(2000);
  track.prune();
  assert.equal(track.pending().length, 0, '过了 3 天就该丢掉');
});

test('过期：有结果的留 2 天给人回看', async () => {
  const { track, tick } = rig({ states: { r1: 'sent' } });
  track.note({ requestId: 'r1' });
  await track.resolve();
  assert.equal(track.get('r1').state, 'sent');

  tick(KEEP_MS - 1000);
  track.prune();
  assert.ok(track.get('r1'), '2 天内要能回看');

  tick(2000);
  track.prune();
  assert.equal(track.get('r1'), null, '超过 2 天清掉');
});

test('上限：条目再多也不超过 MAX_ITEMS', () => {
  const { track, tick } = rig();
  for (let i = 0; i < MAX_ITEMS + 20; i++) {
    track.note({ requestId: `r${i}` });
    tick(1);
  }
  assert.ok(track.list().length <= MAX_ITEMS, String(track.list().length));
  // 砍的是最老的，最新的还在
  assert.ok(track.get(`r${MAX_ITEMS + 19}`), '最新的不该被砍');
});

/* ---------------- 存盘 ---------------- */

test('存盘：重开还在（不是只活在内存里）', async () => {
  const { track, file } = rig({ states: { r1: 'sent' } });
  track.note({ requestId: 'r1', target: 'g1', text: '在吗' });
  await track.resolve();

  const again = createDeliveryTrack({ file, channelOf: () => null, now: () => 1_700_000_000_000, log: () => {} });
  assert.equal(again.get('r1').state, 'sent');
  assert.equal(again.get('r1').text, '在吗');
});

test('存盘：文件坏了不该把插件带崩', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-deliv-'));
  const file = join(dir, 'delivery.json');
  writeFileSync(file, '{ 这不是 json', 'utf8');
  const track = createDeliveryTrack({ file, channelOf: () => null, now: () => 1, log: () => {} });
  assert.deepEqual(track.list(), []);
  assert.equal(track.note({ requestId: 'r1' }), true, '坏文件之后还能继续记');
});

test('存盘：条目字段被裁过，不会把脏数据带回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-deliv-'));
  const file = join(dir, 'delivery.json');
  writeFileSync(
    file,
    JSON.stringify({
      items: [
        { requestId: 'ok', scene: 'group', target: 'g1', at: 5, state: 'sent' },
        { requestId: '', scene: 'group' },          // 空 id 丢掉
        { scene: 'group', target: 'g2' },            // 没 id 丢掉
        null,                                        // 垃圾丢掉
        { requestId: 'weird', scene: '什么', state: '???' },
      ],
    }),
    'utf8',
  );
  const track = createDeliveryTrack({ file, channelOf: () => null, now: () => 1, log: () => {} });
  const ids = track.list().map((x) => x.requestId).sort();
  assert.deepEqual(ids, ['ok', 'weird']);
  assert.equal(track.get('weird').scene, 'c2c', '认不出的场景退回私聊');
});

/* ---------------- 与发送链路串起来 ---------------- */

test('串联：发一条进审核 → 登记 → 过一阵查到 sent', async () => {
  const { track, ch, tick } = rig();
  const r = await ch.send({ scene: 'group', target: 'g1', text: '在吗', requestId: 'sp-1' });
  assert.equal(r.pending, true, 'fake 通道默认回 pending');
  assert.equal(r.requestId, 'sp-1');

  track.note({ requestId: r.requestId, scene: r.scene, target: r.target, text: '在吗' });
  assert.equal(track.pending().length, 1);

  // 审核通过
  ch.ledger.set('sp-1', { state: 'sent', parts: 1 });
  await track.resolve();
  assert.equal(track.get('sp-1').state, 'sent');
  assert.equal(track.isSent('sp-1'), true);
  assert.equal(track.pending().length, 0);
  assert.equal(track.stats().by.sent, 1);
  tick(1);
});
