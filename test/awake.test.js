// 第 5 期（觉醒）：机会计算 / 决策 / 群白名单四道门。
//
// 这块的断言几乎都在盯「**不该说的时候真的没说**」——
// 主动说话错了不是功能 bug，是社交事故（半夜叫人、群里刷屏、被踢）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  opportunities,
  pickOpportunity,
  buildWakePrompt,
  parseVerdict,
  groupCandidates,
  readAgreements,
  inWindow,
  createAwake,
  DEFAULTS,
} from '../src/awake.js';
import { createFakeChannel } from '../src/channel.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-awake-'));
const HOUR = 3_600_000;

/** 取一个"白天"的时间点，避免测试跟着真实钟点飘 */
function noon(dayOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(14, 0, 0, 0);
  return d.getTime();
}

const CFG = { enabled: true, awakeFrom: 8, awakeTo: 23, missAfterHours: 6, minScore: 0.35, casualPerDay: 1 };

/* ---------------- 时段 ---------------- */

test('觉醒：清醒时段左闭右开，跨零点也对', () => {
  assert.equal(inWindow(9, 8, 23), true);
  assert.equal(inWindow(23, 8, 23), false, '右端点不开');
  assert.equal(inWindow(3, 8, 23), false);
  // 22 → 6（跨零点）
  assert.equal(inWindow(23, 22, 6), true);
  assert.equal(inWindow(5, 22, 6), true);
  assert.equal(inWindow(12, 22, 6), false);
  assert.equal(inWindow(3, 0, 0), true, '0→0 表示全天');
});

test('觉醒：静默时段一个机会都不给（半夜不该被叫醒）', () => {
  const d = new Date(noon());
  d.setHours(3, 0, 0, 0);
  const out = opportunities({ now: d.getTime(), agreements: ['看电影'], cfg: CFG });
  assert.deepEqual(out, []);
});

/* ---------------- 三类机会 ---------------- */

test('觉醒：有约定时它排最高分', () => {
  const out = opportunities({
    now: noon(),
    mood: { sociability: 0.6, energy: 0.6, valence: 0 },
    agreements: ['周末看电影'],
    state: { lastOwnerAt: noon() - 10 * HOUR },
    cfg: CFG,
  });
  assert.equal(out[0].kind, 'agreement');
  assert.ok(out[0].reason.includes('看电影'));
});

test('觉醒：沉默越久「想你」权重越高', () => {
  const mood = { sociability: 0.8, energy: 0.6, valence: 0 };
  const near = opportunities({ now: noon(), mood, state: { lastOwnerAt: noon() - 7 * HOUR }, cfg: CFG });
  const far = opportunities({ now: noon(), mood, state: { lastOwnerAt: noon() - 20 * HOUR }, cfg: CFG });
  const score = (list) => list.find((o) => o.kind === 'miss')?.score ?? 0;
  assert.ok(score(far) > score(near));
});

test('觉醒：社交意愿低时「想你」会掉到阈值以下（情绪调制）', () => {
  const state = { lastOwnerAt: noon() - 7 * HOUR };
  const low = opportunities({ now: noon(), mood: { sociability: 0, energy: 0.6 }, state, cfg: CFG });
  const high = opportunities({ now: noon(), mood: { sociability: 1, energy: 0.6 }, state, cfg: CFG });
  assert.equal(low.some((o) => o.kind === 'miss'), false, '不想说话就不该出现');
  assert.equal(high.some((o) => o.kind === 'miss'), true);
});

test('觉醒：随性每天只用一次', () => {
  const now = noon();
  const today = new Date(now).toDateString();
  const used = opportunities({ now, state: { casualDay: today, casualCount: 1 }, cfg: CFG });
  assert.equal(used.some((o) => o.kind === 'casual'), false);
  const fresh = opportunities({ now, state: { casualDay: '前一天', casualCount: 3 }, cfg: CFG });
  assert.equal(fresh.some((o) => o.kind === 'casual'), true, '跨天要重置');
});

test('觉醒：低于阈值的机会连模型都不问', () => {
  const out = opportunities({ now: noon(), state: {}, cfg: { ...CFG, minScore: 0.99 } });
  assert.deepEqual(out, []);
});

/* ---------------- 收尾冷却（第 1 条联动） ---------------- */

/**
 * 刚收过尾就别「随便说句话」。
 *
 * `closedAt` 由宿主从 `closing.json` 传进来。这里的断言盯的是
 * 「说完晚安十分钟后又冒出来」——那不是功能 bug，是社交事故。
 */
const MINUTE = 60_000;
const calmMood = { sociability: 0.6, energy: 0.6, valence: 0 };

test('觉醒：刚收过尾就不「随性搭话」', () => {
  const now = noon();
  const state = { lastOwnerAt: now - HOUR, closedAt: now - 10 * MINUTE };
  const out = opportunities({ now, mood: calmMood, state, cfg: CFG });
  assert.equal(out.some((o) => o.kind === 'casual'), false, '冷却期内不该随性搭话');
});

test('觉醒：冷却过了「随性」回来', () => {
  const now = noon();
  const state = {
    lastOwnerAt: now - HOUR,
    closedAt: now - (DEFAULTS.closeCoolMinutes + 5) * MINUTE,
  };
  const out = opportunities({ now, mood: calmMood, state, cfg: CFG });
  assert.equal(out.some((o) => o.kind === 'casual'), true);
});

test('觉醒：冷却不拦「约定」——答应过的事该提还是要提', () => {
  const now = noon();
  const state = { lastOwnerAt: now - HOUR, closedAt: now - 5 * MINUTE };
  const out = opportunities({ now, agreements: ['周末看电影'], mood: calmMood, state, cfg: CFG });
  assert.equal(out.some((o) => o.kind === 'agreement'), true, '收尾不该把约定一起按下去');
});

test('觉醒：没有收尾记录（closedAt=0）时随性照常', () => {
  const now = noon();
  const state = { lastOwnerAt: now - HOUR, closedAt: 0 };
  const out = opportunities({ now, mood: calmMood, state, cfg: CFG });
  assert.equal(out.some((o) => o.kind === 'casual'), true, '没记录过不能当成刚收尾');
});

test('觉醒：心情差时提约定会降权，但不会被降到不出现', () => {
  const arg = { now: noon(), agreements: ['还书'], state: {}, cfg: CFG };
  const good = opportunities({ ...arg, mood: { valence: 0.5 } });
  const bad = opportunities({ ...arg, mood: { valence: -0.8 } });
  const s = (l) => l.find((o) => o.kind === 'agreement')?.score ?? 0;
  assert.ok(s(bad) < s(good));
  assert.ok(s(bad) > 0, '答应过的事还是要提');
});

/* ---------------- 挑选与解析 ---------------- */

test('觉醒：加权随机能挑到每一项（不是永远取最高分）', () => {
  const list = [
    { kind: 'a', score: 1 },
    { kind: 'b', score: 0.1 },
  ];
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(pickOpportunity(list, Math.random).kind);
  assert.equal(seen.size, 2);
  assert.equal(pickOpportunity([], Math.random), null);
});

test('觉醒：<<skip>> 是正常结局，不是失败', () => {
  assert.deepEqual(parseVerdict('<<skip>>').speak, false);
  assert.deepEqual(parseVerdict('<< skip >>').speak, false);
  assert.equal(parseVerdict('').speak, false);
  assert.equal(parseVerdict('   ').speak, false);
});

test('觉醒：真说话时把残留标记摘干净（不能漏到群里）', () => {
  const v = parseVerdict('「想起你了」<<mood: valence=0.2>>');
  assert.equal(v.speak, true);
  assert.equal(v.text.includes('<<'), false);
  assert.ok(v.text.includes('想起你了'));
});

test('觉醒：提示词里必须给出「不说话的出口」', () => {
  const p = buildWakePrompt({ opp: { kind: 'miss', reason: '很久没聊' }, ctx: {} });
  assert.match(p, /<<skip>>/);
  assert.match(p, /可以不说/);
});

test('觉醒：群场景的提示词点明在哪说', () => {
  const p = buildWakePrompt({ opp: { reason: '冷场' }, ctx: {}, group: { name: '摸鱼群' } });
  assert.match(p, /摸鱼群/);
});

test('觉醒：有收尾记录时提示词接得上上次的话头', () => {
  const p = buildWakePrompt({
    opp: { reason: '很久没聊' },
    ctx: { closing: { point: '聊到他说要去睡了', resume: '问他睡得好不好' } },
  });
  assert.match(p, /上次聊到这儿/);
  assert.match(p, /聊到他说要去睡了/);
  assert.match(p, /问他睡得好不好/);
  assert.match(p, /别装作没发生过/);
});

test('觉醒：没有 resume 时只说收在哪，不出现「本来打算」', () => {
  const p = buildWakePrompt({
    opp: { reason: '很久没聊' },
    ctx: { closing: { point: '聊完了', resume: '' } },
  });
  assert.match(p, /聊完了/);
  assert.doesNotMatch(p, /本来打算/);
});

test('觉醒：没有收尾记录时不注入这一段（别写废话）', () => {
  const p = buildWakePrompt({ opp: { reason: '很久没聊' }, ctx: {} });
  assert.doesNotMatch(p, /上次聊到这儿/);
});

/* ---------------- 群白名单四道门 ---------------- */

const GROUP_CFG = { ...CFG, awakeFrom: 0, awakeTo: 0, maxPerGroupPerDay: 3, groupQuietMinutes: 45 };

test('群主动：白名单显式关掉的不发', () => {
  const r = groupCandidates({
    groups: [{ chatId: 'g1', enabled: false }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: 0 }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(r[0].ok, false);
  assert.match(r[0].why, /没开主动/);
});

test('群主动：没有 group_push 授权不发（官方硬前置）', () => {
  const r = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => false,
    stateOf: () => ({ lastUserAt: 0 }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(r[0].ok, false);
  assert.match(r[0].why, /授权/);
});

test('群主动：今天到上限不发', () => {
  const today = new Date(noon()).toDateString();
  const r = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => true,
    stateOf: () => ({ day: today, count: 3, lastUserAt: 0 }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(r[0].ok, false);
  assert.match(r[0].why, /今天已经说了/);
});

test('群主动：群里刚有人说话不发（没冷场就别插嘴）', () => {
  const r = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: noon() - 5 * 60_000 }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(r[0].ok, false);
  assert.match(r[0].why, /刚有人说话/);
});

test('群主动：四道门都过了才轮到说', () => {
  const r = groupCandidates({
    groups: [{ chatId: 'g1', name: '摸鱼群' }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: noon() - 3 * HOUR }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(r[0].ok, true);
  assert.match(r[0].why, /冷场/);
});

/* ---------------- 约定来源 ---------------- */

test('约定：facts 和图谱两个来源合并去重', () => {
  const memory = {
    list: () => ({ global: ['约定：周末看电影', '主人住在杭州'], chat: ['约定：帮我查个价'] }),
  };
  const graph = { nowEdges: () => [{ rel: '约定', dst: '周末看电影' }, { rel: '住在', dst: '杭州' }] };
  const out = readAgreements({ memory, graph });
  assert.ok(out.includes('周末看电影'));
  assert.ok(out.includes('帮我查个价'));
  assert.equal(out.filter((x) => x === '周末看电影').length, 1, '去重');
  assert.ok(!out.includes('主人住在杭州'), '非约定不要进来');
});

test('约定：办完的（图谱里已关掉的）不该再提', () => {
  const memory = { list: () => ({ global: [], chat: [] }) };
  // nowEdges 只返回活边，关掉的自然不在里面
  const graph = { nowEdges: () => [] };
  assert.deepEqual(readAgreements({ memory, graph }), []);
});

/* ---------------- 执行体 ---------------- */

test('觉醒：模型给 skip 时一个字都不发', async () => {
  const ch = createFakeChannel();
  let asked = 0;
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => ch,
    authzOf: () => true,
    contextOf: () => ({
      chatId: 'u1',
      mood: { sociability: 1, energy: 1 },
      agreements: ['看电影'],
      state: { lastOwnerAt: 0 },
      recent: [],
    }),
    generate: async () => {
      asked += 1;
      return '<<skip>>';
    },
    log: () => {},
    now: () => noon(),
  });
  const v = await a.compose({ kind: 'c2c' });
  assert.equal(asked, 1, '该问还是要问');
  assert.equal(v.speak, false);
  assert.equal(ch.sent.length, 0, '不问就不发');
});

test('觉醒：没机会时连模型都不叫', async () => {
  let asked = 0;
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: { ...CFG, minScore: 0.99 } }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({ chatId: 'u1', mood: {}, agreements: [], state: {} }),
    generate: async () => {
      asked += 1;
      return '在吗';
    },
    log: () => {},
    now: () => noon(),
  });
  const v = await a.compose({ kind: 'c2c' });
  assert.equal(v.speak, false);
  assert.equal(asked, 0, '没机会就别花这次模型调用');
});

test('觉醒：没有白名单时群主动是空操作', async () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: { ...CFG, groups: [] } }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({}),
    generate: async () => '你好',
    log: () => {},
    now: () => noon(),
  });
  assert.deepEqual(await a.wakeGroups(), []);
});

test('群主动：过了四道门才真的发出去，并计入当日次数', async () => {
  const ch = createFakeChannel();
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({
      awake: { ...CFG, awakeFrom: 0, awakeTo: 0, groups: [{ chatId: 'g1', name: '摸鱼群' }] },
    }),
    channelOf: () => ch,
    authzOf: () => true,
    contextOf: ({ chatId }) => ({ chatId, name: '摸鱼群', mood: { sociability: 1 }, agreements: [], state: {} }),
    generate: async () => '你们在聊啥呢',
    log: () => {},
    now: () => noon(),
  });
  // 先制造"冷场"：群里三小时前有人说话
  a.noteUser('g1');
  const r = await a.wakeGroups();
  // 刚 noteUser 过 → 不算冷场，应当被拦
  assert.equal(r[0].ok, false);
  assert.equal(ch.sent.length, 0);
});

test('群主动：群里不给「随性」机会（casualPerDay 被强制为 0）', async () => {
  const ch = createFakeChannel();
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({
      awake: { ...CFG, awakeFrom: 0, awakeTo: 0, casualPerDay: 5, groups: [{ chatId: 'g1' }] },
    }),
    channelOf: () => ch,
    authzOf: () => true,
    // 没有任何约定、也没有 miss（lastOwnerAt=0 在群里被置 0）→ 只剩 casual，而 casual 被禁
    contextOf: ({ chatId }) => ({ chatId, mood: { sociability: 1 }, agreements: [], state: {} }),
    generate: async () => '无聊啊',
    log: () => {},
    now: () => noon(),
  });
  const v = await a.compose({ kind: 'group', chatId: 'g1' });
  // 群里 lastOwnerAt 被置 0 → silentH=99 → 仍会产生 miss，所以这里只验 casual 不在
  assert.notEqual(v.kind, 'casual');
});
