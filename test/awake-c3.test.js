/**
 * 阶段 6c：C3 主人回复反馈闭环。
 *
 * 最容易静默出错的几处：权重乘在过阈值之后（等于没生效）、
 * 「不要/不好」被当成正反馈、同一条回复结算两次、
 * 升级上来的老 awake.json 没有 settled 字段却被当成「没回音」降权。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyOwnerReply, adjustKindWeights, defaultKindWeights,
  opportunities, createAwake,
  KIND_WEIGHT_MIN, KIND_WEIGHT_MAX, NO_REPLY_PENALTY,
} from '../src/awake.js';
import { createFakeChannel } from '../src/channel.js';

const NOON = (() => { const d = new Date(); d.setHours(14, 0, 0, 0); return d.getTime(); })();
const CFG = { enabled: true, awakeFrom: 0, awakeTo: 0, missAfterHours: 6, minScore: 0.35, casualPerDay: 1 };

/* ---------------- 纯函数 ---------------- */

test('C3：中文否定先判，「不要 / 不好」不能被当成正反馈', () => {
  assert.equal(classifyOwnerReply('好棒！谢谢'), 'positive');
  assert.equal(classifyOwnerReply('哈哈有意思'), 'positive');
  assert.equal(classifyOwnerReply('好'), 'positive');
  assert.equal(classifyOwnerReply('不要了'), 'negative');
  assert.equal(classifyOwnerReply('别发了，有点烦'), 'negative');
  assert.equal(classifyOwnerReply('行了，别说了'), 'negative');
  assert.equal(classifyOwnerReply('嗯'), 'neutral');
  assert.equal(classifyOwnerReply(''), 'neutral');
  assert.equal(classifyOwnerReply('明天降温记得加衣'), 'neutral');
});

test('C3：权重只动被反馈的那一类，夹在 [0.5, 1.5]', () => {
  const w = defaultKindWeights();
  assert.deepEqual(w, { agreement: 1, miss: 1, casual: 1 });
  const up = adjustKindWeights(w, 'casual', 0.05);
  assert.equal(up.casual, 1.05);
  assert.equal(up.agreement, 1);
  assert.equal(adjustKindWeights(w, 'nope', 0.05).casual, 1);
  let hi = w;
  for (let i = 0; i < 30; i += 1) hi = adjustKindWeights(hi, 'miss', 0.05);
  assert.equal(hi.miss, KIND_WEIGHT_MAX);
  let lo = w;
  for (let i = 0; i < 30; i += 1) lo = adjustKindWeights(lo, 'miss', -0.05);
  assert.equal(lo.miss, KIND_WEIGHT_MIN);
  /** 老盘只有一类的残缺对象也要能补齐 */
  assert.deepEqual(adjustKindWeights({ casual: 1.2 }, 'agreement', 0.05),
    { agreement: 1.05, miss: 1, casual: 1.2 });
});

const BASE = { now: NOON, mood: { energy: 0.5, sociability: 0.5 }, agreements: [], state: { lastOwnerAt: NOON }, cfg: {} };

test('C3：权重乘在过阈值之前，默认全 1 时机会分逐字节不变', () => {
  const plain = opportunities(BASE);
  assert.deepEqual(opportunities({ ...BASE, weights: defaultKindWeights() }), plain);
  const casual = plain.find((o) => o.kind === 'casual');
  assert.ok(casual);

  const up = opportunities({ ...BASE, weights: { casual: 1.5 } }).find((o) => o.kind === 'casual');
  assert.ok(up.score > casual.score);

  const down = opportunities({ ...BASE, weights: { casual: 0.5 } });
  assert.equal(down.find((o) => o.kind === 'casual'), undefined,
    '0.39 × 0.5 = 0.195 < minScore，被降权的机会就该不再出现');
});

/* ---------------- 真状态接线 ---------------- */

function scene({ file = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-c3-'));
  if (file) writeFileSync(join(dir, 'awake.json'), JSON.stringify(file), 'utf8');
  let clock = NOON;
  let calls = 0;
  const a = createAwake({
    dataDir: dir,
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({
      chatId: 'u1', mood: { sociability: 1, energy: 1 },
      agreements: ['周末看电影'], state: { lastOwnerAt: 0 },
      recent: [], recentBot: [],
    }),
    generate: async () => { calls += 1; return '明天降温记得加衣'; },
    log: () => {},
    now: () => clock,
    rand: () => 0,
  });
  return {
    a,
    calls: () => calls,
    advance: (ms) => { clock += ms; },
    state: () => JSON.parse(readFileSync(join(dir, 'awake.json'), 'utf8')),
  };
}

test('C3：默认没有任何反馈时权重恒为 1，行为不变', async () => {
  const s = scene();
  assert.deepEqual(s.a.status().kindWeights, defaultKindWeights());
  const v = await s.a.compose({ kind: 'c2c' });
  assert.equal(v.speak, true);
  assert.deepEqual(s.state().kindWeights, defaultKindWeights(), '光是说过一次不该改权重');
});

test('C3：官方点赞点踩直接结算；同一条回复只算一次', async () => {
  const s = scene();
  await s.a.compose({ kind: 'c2c' });
  assert.equal(s.state().lastWakeKind, 'agreement');

  assert.equal(s.a.feedback({ positive: true }), true);
  assert.equal(s.state().kindWeights.agreement, 1.05);
  assert.equal(s.a.feedback({ positive: true, kind: 'bogus' }), false, '不认识的 kind 不该写盘');

  /** 先点了赞、又回一句「好呀」，5 分钟内不再 ±0.05 */
  assert.equal(s.a.noteOwnerReply('好呀'), 'positive');
  assert.equal(s.state().kindWeights.agreement, 1.05);

  s.advance(6 * 60_000);
  assert.equal(s.a.noteOwnerReply('别发了'), 'negative');
  assert.equal(s.state().kindWeights.agreement, 1);
});

test('C3：文本分类作补充，中性只算「有回音」', async () => {
  const s = scene();
  await s.a.compose({ kind: 'c2c' });
  assert.equal(s.a.noteOwnerReply('太棒了哈哈'), 'positive');
  assert.equal(s.state().kindWeights.agreement, 1.05);
  assert.equal(s.state().noReplyStreak, 0);
  assert.equal(s.state().settled, true);

  s.advance(6 * 60_000);
  await s.a.compose({ kind: 'c2c' });
  assert.equal(s.a.noteOwnerReply('嗯，看到了'), 'neutral');
  assert.equal(s.state().kindWeights.agreement, 1.05, '中性不动权重');
  assert.equal(s.state().settled, true);
});

test('C3：连续两次主动没人回 → 该类权重降 0.08', async () => {
  const s = scene();
  await s.a.compose({ kind: 'c2c' });            // 第 1 次说出去，待结算
  await s.a.compose({ kind: 'c2c' });            // settle → streak 1
  assert.equal(s.state().noReplyStreak, 1);
  assert.equal(s.state().kindWeights.agreement, 1, '一次没回音不降权');

  await s.a.compose({ kind: 'c2c' });            // settle → streak 2
  assert.equal(s.state().noReplyStreak, 2);
  assert.equal(s.state().kindWeights.agreement, Number((1 - NO_REPLY_PENALTY).toFixed(3)));

  /** 主人终于回了 → 计数清零，不再继续降 */
  s.advance(6 * 60_000);
  s.a.noteOwnerReply('刚忙完');
  assert.equal(s.state().noReplyStreak, 0);
  const before = s.state().kindWeights.agreement;
  await s.a.compose({ kind: 'c2c' });
  await s.a.compose({ kind: 'c2c' });
  assert.equal(s.state().kindWeights.agreement, before, '已经结算过，不该重复扣');
});

test('C3：老 awake.json 没有 settled 字段，升级后不被误判成「没回音」', async () => {
  const s = scene({ file: { groups: {}, c2c: { lastUserAt: 0 }, lastKind: 'casual' } });
  await s.a.compose({ kind: 'c2c' });
  assert.deepEqual(s.state().kindWeights, defaultKindWeights());
  await s.a.compose({ kind: 'c2c' });
  assert.deepEqual(s.state().kindWeights || defaultKindWeights(), defaultKindWeights(),
    '老状态里没这个字段也不该凭空扣权重');
});

test('C3：群主动不记 lastWakeKind，免得误伤私聊权重', async () => {
  const s = scene();
  const v = await s.a.compose({ kind: 'group', chatId: 'g1' });
  assert.equal(v.asked, true);
  assert.equal(s.state().lastWakeKind, '');
  assert.equal(s.state().settled, true);
});
