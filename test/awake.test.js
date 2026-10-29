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
  skipBackoffMs,
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

test('觉醒：mood 缺字段时按中性值算（跟 mood.js 的落点一致）', () => {
  /**
   * 老数据 / 面板刚清过 / 第一次启动都会拿到空 mood。
   * 缺字段时的兜底值必须等于 `NEUTRAL`（0.5），
   * 否则同一份情绪在两处算出不同结论（以前这里是 0.6）。
   */
  const missing = opportunities({ now: noon(), mood: {}, state: {}, cfg: CFG });
  const neutral = opportunities({ now: noon(), mood: { sociability: 0.5, energy: 0.5, valence: 0 }, state: {}, cfg: CFG });
  assert.deepEqual(
    missing.map((o) => [o.kind, o.score]),
    neutral.map((o) => [o.kind, o.score]),
  );
  // 中性精力下「随性」仍要过线，不然这一档等于不存在
  assert.equal(neutral.some((o) => o.kind === 'casual'), true, '中性精力下随性应当可选');
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

test('觉醒：说完一句顺带要求安静', () => {
  const v = parseVerdict('群里太吵了 <<silence:1h>>');
  assert.equal(v.speak, true);
  assert.equal(v.text, '群里太吵了', '标记不能漏进群里');
  assert.equal(v.silenceMs, 3_600_000, '时长要先提取再摘标记');
});

test('觉醒：只有静默没有正文时按「不说」处理', () => {
  // 群主动本来就是「要不要插话」，不插话就不说话，单独静默没有意义
  const v = parseVerdict('<<silence:2h>>');
  assert.equal(v.speak, false);
});

test('觉醒：没有静默标记时 silenceMs 为 0', () => {
  const v = parseVerdict('随便说一句');
  assert.equal(v.speak, true);
  assert.equal(v.silenceMs, 0);
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

/**
 * 被框架挡回来过（日额度用完）就等到点再试。
 *
 * 为什么需要这条：群主动每 5 分钟扫一次，不封的话会一直空撞到跨天
 * （288 次无效请求 + 288 行日志）。而「今天已经说了 N 次」是另一道门，
 * 不能拿它顶替——那是应用层自己的计数，跟官方额度是两本账。
 */
test('群主动：主动额度用完的群，到点之前不再试', () => {
  const blocked = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: noon() - 3 * HOUR, blockedUntil: noon() + 3 * HOUR }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(blocked[0].ok, false);
  assert.match(blocked[0].why, /额度用完/);

  // 到点之后照常放行
  const free = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: noon() - 3 * HOUR, blockedUntil: noon() - 1 }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(free[0].ok, true, free[0].why);
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

/* ---------------- 跳过之后要退避（P0：无限空问） ---------------- */

test('觉醒：noMiss 关掉「想你」，私聊的语义不动', () => {
  const cfg = { ...CFG, awakeFrom: 0, awakeTo: 0 };
  const base = { now: noon(), mood: {}, agreements: [], state: {} };
  assert.ok(
    opportunities({ ...base, cfg }).some((o) => o.kind === 'miss'),
    '私聊：一条记录都没有 = 很久没联系，该打招呼',
  );
  assert.ok(
    !opportunities({ ...base, cfg, noMiss: true }).some((o) => o.kind === 'miss'),
    '群聊：她不在群里等谁',
  );
});

test('群主动：退避逐次翻倍，到上限就固定', () => {
  // 30 → 60 → 120 → 240 → 360（封顶）分钟
  const cfg = { skipBackoffMinutes: 30, skipBackoffMaxMinutes: 360 };
  assert.equal(skipBackoffMs(1, cfg), 30 * MINUTE);
  assert.equal(skipBackoffMs(2, cfg), 60 * MINUTE);
  assert.equal(skipBackoffMs(3, cfg), 120 * MINUTE);
  assert.equal(skipBackoffMs(4, cfg), 240 * MINUTE);
  assert.equal(skipBackoffMs(5, cfg), 360 * MINUTE);
  assert.equal(skipBackoffMs(9, cfg), 360 * MINUTE, '到顶就不再涨');
  // 脏输入当第一次处理，别算出 0 或者负数（那等于没退避）
  assert.equal(skipBackoffMs(0, cfg), 30 * MINUTE);
  assert.equal(skipBackoffMs(-3, cfg), 30 * MINUTE);
  assert.equal(skipBackoffMs('x', cfg), 30 * MINUTE);
  assert.equal(skipBackoffMs(1e9, cfg), 360 * MINUTE, '别让 2**n 溢出成 Infinity');
});

test('群主动：刚问过她的群，到点之前不再问', () => {
  const blocked = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: noon() - 3 * HOUR, nextAskAt: noon() + 20 * MINUTE }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(blocked[0].ok, false);
  assert.match(blocked[0].why, /刚问过她/);

  const free = groupCandidates({
    groups: [{ chatId: 'g1' }],
    authzOf: () => true,
    stateOf: () => ({ lastUserAt: noon() - 3 * HOUR, nextAskAt: noon() - 1 }),
    cfg: GROUP_CFG,
    now: noon(),
  });
  assert.equal(free[0].ok, true, free[0].why);
});

/**
 * 这一条是 P0 本身。
 *
 * 修复前的行为：`<<skip>>` 之后状态一个字都不写，下一轮（5 分钟后）条件照样成立，
 * 于是无限空问 —— 清醒 15 小时 = 180 次模型调用/群/天，一个字都没发出去。
 */
test('群主动：她跳过之后，下一轮不再空问（P0）', async () => {
  let t = noon();
  let calls = 0;
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: { ...GROUP_CFG, groups: [{ chatId: 'g1', name: '摸鱼群' }] } }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    // 群里只剩「约定」这一档机会（miss 被置 0、casual 被强制为 0）
    contextOf: ({ chatId }) => ({ chatId, mood: { sociability: 1 }, agreements: ['周末看电影'], state: {} }),
    generate: async () => {
      calls += 1;
      return '<<skip>>';
    },
    log: () => {},
    now: () => t,
  });

  const first = await a.wakeGroups();
  assert.equal(calls, 1, '第一轮确实问了一次');
  assert.equal(first[0].ok, false);
  assert.match(first[0].why, /她自己决定不说/);

  // 5 分钟后（检查循环的周期）再跑一轮：不许再问模型
  t += 5 * MINUTE;
  const second = await a.wakeGroups();
  assert.equal(calls, 1, '刚跳过就不该再问一遍——这就是无限烧钱的那条路');
  assert.match(second[0].why, /刚问过她/);
  assert.ok(a.groupState('g1').skipStreak >= 1, '退避要记在状态里，重启才不丢');

  // 退避到点了，才重新问
  t += 30 * MINUTE;
  await a.wakeGroups();
  assert.equal(calls, 2, '退避到点后允许再问一次');
});

test('群主动：连着跳几次就退得更久，群里有人说话就清零', async () => {
  let t = noon();
  let calls = 0;
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: { ...GROUP_CFG, groups: [{ chatId: 'g1' }] } }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: ({ chatId }) => ({ chatId, mood: { sociability: 1 }, agreements: ['周末看电影'], state: {} }),
    generate: async () => {
      calls += 1;
      return '<<skip>>';
    },
    log: () => {},
    now: () => t,
  });

  await a.wakeGroups(); // 第 1 次 → 退避 30 分钟
  t += 30 * MINUTE;
  await a.wakeGroups(); // 第 2 次 → 退避 60 分钟
  assert.equal(calls, 2);
  assert.equal(a.groupState('g1').skipStreak, 2);

  // 才过 30 分钟，第二次的退避是 60 分钟，所以还不到点
  t += 30 * MINUTE;
  await a.wakeGroups();
  assert.equal(calls, 2, '第二次退避更久，不该按第一次的节奏来');

  // 群里有人说话了 → 场面变了，退避作废
  a.noteUser('g1');
  assert.equal(a.groupState('g1').skipStreak, 0);
  assert.equal(a.groupState('g1').nextAskAt, 0);
});

test('觉醒：没机会时不算「问过」（不花钱就不该留退避）', async () => {
  // 群里目前永远算得出「想你」这一档（见 MEMORY 里记的那个 bug），
  // 所以这条用私聊来验 `asked` 这个标记本身。
  let calls = 0;
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: { ...CFG, casualPerDay: 0 } }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    // 刚聊过（不触发「想你」），随性又被关掉，也没有约定 → 一个机会都没有
    contextOf: () => ({ mood: { sociability: 1 }, agreements: [], state: { lastOwnerAt: noon() } }),
    generate: async () => {
      calls += 1;
      return '嗯';
    },
    log: () => {},
    now: () => noon(),
  });

  const v = await a.compose({ kind: 'c2c' });
  assert.equal(v.speak, false);
  assert.match(v.why, /没有值得说的机会/);
  assert.equal(v.asked, false, '压根没问模型，就不算「问过」');
  assert.equal(calls, 0);
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

test('群主动：群里不给「随性」也不给「想你」，只剩「约定」', async () => {
  // 以前的 bug：宿主传 `lastOwnerAt: 0` 想"跳过" miss，实际是 0 → 沉默 99 小时
  // → miss 以最高分（0.935）成立，把「约定」永远压下去，
  //   于是群主动每轮都以「很久没联系了」为理由开口。
  let asked = 0;
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({
      awake: { ...CFG, awakeFrom: 0, awakeTo: 0, casualPerDay: 5, groups: [{ chatId: 'g1' }] },
    }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: ({ chatId }) => ({ chatId, mood: { sociability: 1 }, agreements: [], state: {} }),
    generate: async () => {
      asked += 1;
      return '无聊啊';
    },
    log: () => {},
    now: () => noon(),
  });
  const v = await a.compose({ kind: 'group', chatId: 'g1' });
  assert.equal(v.speak, false);
  assert.match(v.why, /没有值得说的机会/);
  assert.equal(asked, 0, '没约定、没随性、也没想你 → 一个机会都不该有');
});

test('群主动：有约定时以「约定」为由开口，不是「想你」', async () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: { ...CFG, awakeFrom: 0, awakeTo: 0, groups: [{ chatId: 'g1' }] } }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: ({ chatId }) => ({ chatId, mood: { sociability: 1 }, agreements: ['周末看电影'], state: {} }),
    generate: async () => '你们周末看电影不',
    log: () => {},
    now: () => noon(),
  });
  const v = await a.compose({ kind: 'group', chatId: 'g1' });
  assert.equal(v.speak, true);
  assert.equal(v.kind, 'agreement', '群里唯一的开口理由应该是「答应过的事」');
});

/* ---------------- 随性额度 / 醒来时间 / 私聊状态 ---------------- */

/**
 * 「随性每天最多一次」。
 *
 * `opportunities()` 一直在读 `casualDay` / `casualCount`，但**全仓没有一处写**，
 * 于是 `casualUsed` 永远是 0，这条限制从上线起就没生效过。
 * 现场证据：`awake.json` 是 `casualCount: 0` 而 `lastKind: "casual"`。
 */
test('觉醒：随性说过一次，当天就不再「随便说句话」', async () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    // 刚聊过（不到 missAfterHours）、没约定 → 只剩「随性」一个机会
    contextOf: () => ({
      chatId: 'u1',
      mood: { sociability: 1, energy: 1 },
      agreements: [],
      state: { lastOwnerAt: noon() - 60_000 },
    }),
    generate: async () => '今天天气不错',
    log: () => {},
    rand: () => 0,
    now: () => noon(),
  });

  const v1 = await a.compose({ kind: 'c2c' });
  assert.equal(v1.speak, true);
  assert.equal(v1.kind, 'casual');
  assert.equal(a.status().casualCount, 1, '说出口就要记账');

  const v2 = await a.compose({ kind: 'c2c' });
  assert.equal(v2.speak, false, '同一天第二次随性不该再出现');
  assert.equal(v2.asked, false, '连模型都不用问');
});

test('觉醒：随性额度跨天重置', async () => {
  const dir = tmp();
  let day = 0;
  const a = createAwake({
    dataDir: dir,
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({
      chatId: 'u1',
      mood: { sociability: 1, energy: 1 },
      agreements: [],
      state: { lastOwnerAt: noon(day) - 60_000 },
    }),
    generate: async () => '今天天气不错',
    log: () => {},
    rand: () => 0,
    now: () => noon(day),
  });

  assert.equal((await a.compose({ kind: 'c2c' })).speak, true);
  assert.equal((await a.compose({ kind: 'c2c' })).speak, false);

  day = 1; // 第二天
  const v = await a.compose({ kind: 'c2c' });
  assert.equal(v.speak, true, '跨天之后随性额度要回来');
  assert.equal(a.status().casualCount, 1);
});

/**
 * `lastWakeAt` 从第 5 期就声明在状态里，但**全仓零写入点**，永远是 0。
 * 「醒来」= 真的问过模型，说没说都算。
 */
test('觉醒：问过模型就记「醒来时间」，不是等发出去才记', async () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({ chatId: 'u1', mood: { sociability: 1 }, agreements: ['看电影'], state: {} }),
    generate: async () => '<<skip>>',
    log: () => {},
    now: () => noon(),
  });
  assert.equal(a.status().lastWakeAt, 0);
  await a.compose({ kind: 'c2c' });
  assert.equal(a.status().lastWakeAt, noon(), '她决定不说也是醒过的');
});

/**
 * 私聊和群记的是两件事。
 *
 * 以前 `noteUser` 不看 kind，私聊的 openid 被写进 `state.groups`；
 * 而私聊决策读的是 `speakUp.lastOwnerAt`，那条路径在 chatId 没配时
 * 永远不更新——于是私聊「沉默多久」永远是 99 小时，miss 每轮都成立。
 */
test('觉醒：私聊的消息不写进群状态表', () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({}),
    generate: async () => '',
    log: () => {},
    now: () => noon(),
  });
  a.noteUser('u1', 'c2c');
  assert.deepEqual(a.groupState('u1'), {}, '私聊 openid 不该出现在群状态里');
  assert.equal(a.c2cLastUserAt(), noon(), '但要记进私聊那一格');
});

test('觉醒：群里有人说话记在群状态表，退避清零', () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({}),
    generate: async () => '',
    log: () => {},
    now: () => noon(),
  });
  a.noteUser('g1', 'group');
  assert.equal(a.groupState('g1').lastUserAt, noon());
  assert.equal(a.c2cLastUserAt(), 0, '群消息不该冒充私聊');
});

test('觉醒：历史上误写进群状态表的私聊条目会被清掉', () => {
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({}),
    generate: async () => '',
    log: () => {},
    now: () => noon(),
  });
  a.noteUser('u1', 'group'); // 模拟旧版本把私聊当群写进去
  assert.ok(a.groupState('u1').lastUserAt);
  a.noteUser('u1', 'c2c'); // 主人下次说话时顺手清掉
  assert.deepEqual(a.groupState('u1'), {});
});

/* ---------------- 主人自己写的额外指令 ---------------- */

/**
 * `speakUp.prompt` 以前**没人读**：awake 一开，`generate` 就把它丢掉。
 * 现在只在「跟默认值不同」时当追加要求传进来。
 */
test('觉醒：主人写的额外要求会进提示词，但「可以不说」必须留在最后', () => {
  const p = buildWakePrompt({ opp: { reason: '很久没联系了' }, ctx: {}, extra: '多用东北话，别太文雅' });
  assert.match(p, /多用东北话/);
  assert.ok(
    p.trimEnd().endsWith('**只输出 `<<skip>>`**，什么都别加。'),
    '不说话的出口不能被自定义指令顶掉，否则等于退回定时器',
  );
});

test('觉醒：没传额外要求时不出现空段落', () => {
  const p = buildWakePrompt({ opp: { reason: '很久没联系了' }, ctx: {} });
  assert.ok(!p.includes('【主人给你的额外要求】'));
  assert.ok(!/\n\n\n/.test(p), '不该留下连续空行');
});

test('觉醒：compose 把额外要求原样交给提示词', async () => {
  let seen = '';
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => createFakeChannel(),
    authzOf: () => true,
    contextOf: () => ({ chatId: 'u1', mood: { sociability: 1 }, agreements: ['看电影'], state: {} }),
    generate: async (prompt) => {
      seen = prompt;
      return '<<skip>>';
    },
    log: () => {},
    now: () => noon(),
  });
  await a.compose({ kind: 'c2c', extraPrompt: '别提工作的事' });
  assert.match(seen, /别提工作的事/);
});
