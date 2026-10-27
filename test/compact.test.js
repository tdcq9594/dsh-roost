// 第 6 期（压缩）：占用读取 / 阈值 / 开场 / 换会话。
//
// 最要紧的一条断言：**换会话失败时映射必须不变**。
// 映射错了下一句会进到刚被换掉的旧窗口，等于白压 —— 而且现象是静默的。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readPressure,
  shouldCompact,
  thresholdFor,
  buildOpening,
  createCompact,
  DEFAULTS,
} from '../src/compact.js';

const HOUR = 3_600_000;

/* ---------------- 占用读取 ---------------- */

test('压缩：能从投影里找到 contextPressure（按字段名找，不写死路径）', () => {
  const v = {
    asOfSeq: 42,
    values: { turn: { contextPressure: { pressureTokens: 1000, projectedTokens: 2000, contextWindow: 10000 } } },
  };
  const p = readPressure(v);
  assert.equal(p.tokens, 1000);
  assert.equal(p.projected, 2000);
  assert.equal(p.window, 10000);
  assert.equal(p.percent, 20, '优先用 projected 算');
});

test('压缩：投影里没有这个字段时给空值，不抛错', () => {
  assert.equal(readPressure(null).percent, null);
  assert.equal(readPressure({}).percent, null);
  assert.equal(readPressure({ values: { inbox: {} } }).percent, null);
  assert.equal(readPressure('字符串').percent, null);
});

test('压缩：只有 pressureTokens 时也能算', () => {
  const p = readPressure({ x: { contextPressure: { pressureTokens: 500, contextWindow: 1000 } } });
  assert.equal(p.percent, 50);
});

test('压缩：容量缺失时百分比为空（不能拿 0 当分母）', () => {
  const p = readPressure({ x: { contextPressure: { pressureTokens: 500 } } });
  assert.equal(p.percent, null);
});

test('压缩：环状对象不会把扫描卡死', () => {
  const a = { contextPressure: { pressureTokens: 1, contextWindow: 2 } };
  a.self = a;
  assert.equal(readPressure(a).percent, 50);
});

/* ---------------- 阈值 ---------------- */

test('压缩：群聊与私聊用不同阈值（不再一刀切 25%）', () => {
  // 私聊 40%
  assert.equal(shouldCompact({ percent: 40, scene: 'c2c', cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: 39.9, scene: 'c2c', cfg: DEFAULTS }).compact, false);
  // 群聊 60%
  assert.equal(shouldCompact({ percent: 60, scene: 'group', cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: 59, scene: 'group', cfg: DEFAULTS }).compact, false);
  // 同一个占用值在两种场景下结论不同——这正是拆档的意义
  assert.equal(shouldCompact({ percent: 45, scene: 'c2c', cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: 45, scene: 'group', cfg: DEFAULTS }).compact, false);
});

test('压缩：旧配置里写了 atPercent 就以它为准（不破坏已有部署）', () => {
  assert.equal(thresholdFor({ atPercent: 25 }, 'group'), 25);
  assert.equal(shouldCompact({ percent: 25, scene: 'group', cfg: { atPercent: 25 } }).compact, true);
});

test('压缩：阈值 25% 这条老线不再触发（避免刚聊两句就换会话）', () => {
  assert.equal(shouldCompact({ percent: 25, scene: 'c2c', cfg: DEFAULTS }).compact, false);
});

test('压缩：拿不到用量时按轮数兜底（没上报不等于没涨）', () => {
  assert.equal(shouldCompact({ percent: null, turnsSince: 40, cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: null, turnsSince: 39, cfg: DEFAULTS }).compact, false);
  // 有百分比时轮数不参与
  assert.equal(shouldCompact({ percent: 5, turnsSince: 999, cfg: DEFAULTS }).compact, false);
});

test('压缩：关掉就完全不压', () => {
  assert.equal(shouldCompact({ percent: 99, cfg: { enabled: false } }).compact, false);
});

/* ---------------- 开场 ---------------- */

test('开场：带上最近原话（不然「刚才那个」指代会断）', () => {
  const s = buildOpening({
    recent: [{ role: 'user', sender: '张三', at: Date.now(), text: '我说的那个方案' }],
  });
  assert.match(s, /刚才说到/);
  assert.match(s, /我说的那个方案/);
});

test('开场：明说这是接着聊，且不许提「摘要」', () => {
  const s = buildOpening({ recent: [], digests: [{ at: Date.now(), text: '聊了搬家' }] });
  assert.match(s, /接着/);
  assert.match(s, /不要说"根据摘要"/);
  // 正文里不能出现"以下是摘要"这种会让模型复述的话
  assert.doesNotMatch(s, /以上是摘要|以下是摘要/);
});

test('开场：带日期和没办完的约定', () => {
  const s = buildOpening({
    digests: [{ at: Date.parse('2026-10-26T10:00:00'), text: '聊了搬家' }],
    agreements: ['周末看电影'],
  });
  assert.match(s, /2026-10-26/);
  assert.match(s, /周末看电影/);
});

test('开场：什么数据都没有也能给出可用的一段（不能是空串）', () => {
  const s = buildOpening({});
  assert.ok(s.length > 10);
  assert.match(s, /接着/);
});

/* ---------------- 换会话 ---------------- */

function fakeRig({ failCreate = false } = {}) {
  const map = new Map([['g1', 'old-sid']]);
  const made = [];
  const openings = [];
  const controller = {
    async create({ workspaceId, agentPreset }) {
      if (failCreate) throw new Error('建会话失败');
      const sid = `new-${made.length + 1}`;
      made.push({ sid, workspaceId, agentPreset });
      return { sessionId: sid };
    },
    async rename() {
      return {};
    },
    async projections() {
      // 45% 占用：过了私聊的 40%，没过群聊的 60%
      return { values: { t: { contextPressure: { projectedTokens: 450, contextWindow: 1000 } } } };
    },
  };
  const sessions = {
    get: (c) => map.get(c) || '',
    set: (c, s) => map.set(c, s),
  };
  const journal = {
    digests: () => [{ at: Date.now(), text: '聊了搬家' }],
    recent: () => [{ role: 'user', sender: '张三', at: Date.now(), text: '那个方案' }],
  };
  const compact = createCompact({
    controllerOf: () => controller,
    workspaceIdOf: async () => 'ws-1',
    sessions,
    journal,
    agreementsOf: () => ['周末看电影'],
    onOpening: (chatId, text) => openings.push({ chatId, text }),
    log: () => {},
    cfgOf: () => ({ compact: DEFAULTS }),
    now: () => Date.now(),
  });
  return { compact, map, made, openings };
}

test('压缩：压一次 = 新建同 preset 会话 + 映射改指向 + 交出开场', async () => {
  const { compact, map, made, openings } = fakeRig();
  const r = await compact.compact('g1', { preset: 'roost-social', name: '摸鱼群' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'old-sid');
  assert.equal(made[0].agentPreset, 'roost-social');
  assert.equal(map.get('g1'), 'new-1', '映射要指向新会话');
  assert.equal(openings.length, 1);
  assert.match(openings[0].text, /接着/);
});

test('压缩：建会话失败时映射一点都不许动', async () => {
  const { compact, map, openings } = fakeRig({ failCreate: true });
  const r = await compact.compact('g1', { preset: 'roost-social' });
  assert.equal(r.ok, false);
  assert.equal(map.get('g1'), 'old-sid', '失败必须保持原映射，否则下一句进错窗口');
  assert.equal(openings.length, 0);
});

test('压缩：没有 DSH 会话时不压', async () => {
  const { compact } = fakeRig();
  const r = await compact.compact('不存在的会话');
  assert.equal(r.ok, false);
  assert.match(r.why, /还没有/);
});

test('压缩：到阈值时 maybe 会自动压，没到就不动', async () => {
  const { compact, map } = fakeRig();
  const c1 = await compact.maybe('g1', { preset: 'roost-social' });
  assert.equal(c1.compacted, true, '30% ≥ 25% 应该压');
  assert.equal(map.get('g1'), 'new-1');

  // 再压一次：刚换过，轮数归零，且投影仍报 30% → 会再压。
  // 这里验的是"不会抛错"，真实使用中轮数归零 + 新会话占用低，自然不会再触发。
  const c2 = await compact.maybe('g1', { preset: 'roost-social' });
  assert.equal(typeof c2.compacted, 'boolean');
});

test('压缩：读占用失败不影响对话（maybe 返回未压而不是抛错）', async () => {
  const rig = fakeRig();
  const broken = createCompact({
    controllerOf: () => ({
      async create() {
        throw new Error('不该被调用');
      },
      async projections() {
        throw new Error('读不了');
      },
    }),
    workspaceIdOf: async () => 'ws',
    sessions: rig.map,
    journal: { digests: () => [], recent: () => [] },
    agreementsOf: () => [],
    log: () => {},
    cfgOf: () => ({ compact: DEFAULTS }),
  });
  const r = await broken.maybe('g1', {});
  assert.equal(r.compacted, false);
});

/* ---------------- 开场配额（第 3 批 C4） ---------------- */

test('开场：用户消息多留、她自己的少留', async () => {
  const map = new Map([['g1', 'old-sid']]);
  const openings = [];
  // 30 条里 20 条用户、10 条她自己的，交错排布
  const pool = [];
  for (let i = 0; i < 30; i += 1) {
    pool.push({
      id: `r${i}`,
      at: Date.now() - (30 - i) * 1000,
      role: i % 3 === 0 ? 'bot' : 'user',
      sender: i % 3 === 0 ? '' : `人${i}`,
      text: i % 3 === 0 ? `她说的第${i}句` : `用户说的第${i}句`,
    });
  }
  const compact = createCompact({
    controllerOf: () => ({
      async create() {
        return { sessionId: 'new-1' };
      },
      async rename() {
        return {};
      },
    }),
    workspaceIdOf: async () => 'ws',
    sessions: { get: (c) => map.get(c) || '', set: (c, s) => map.set(c, s) },
    journal: { digests: () => [], recent: () => pool },
    agreementsOf: () => [],
    onOpening: (_c, t) => openings.push(t),
    log: () => {},
    cfgOf: () => ({ compact: DEFAULTS }),
  });
  const r = await compact.compact('g1', { preset: 'roost-social' });
  assert.equal(r.ok, true);
  const text = openings[0];
  const userLines = (text.match(/用户说的第/g) || []).length;
  const botLines = (text.match(/她说的第/g) || []).length;
  assert.ok(userLines <= DEFAULTS.keepRecentUser, `用户话不该超过 ${DEFAULTS.keepRecentUser} 条，实际 ${userLines}`);
  assert.ok(botLines <= DEFAULTS.keepRecentBot, `她的话不该超过 ${DEFAULTS.keepRecentBot} 条，实际 ${botLines}`);
  assert.ok(userLines > botLines, '用户原话要比她自己的多——指代都在用户话里');
});

test('开场：配额可配（配置改了要真的生效）', async () => {
  const map = new Map([['g1', 'old-sid']]);
  const openings = [];
  const pool = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    at: Date.now() - (12 - i) * 1000,
    role: i % 2 === 0 ? 'bot' : 'user',
    sender: '张三',
    text: `第${i}句`,
  }));
  const compact = createCompact({
    controllerOf: () => ({ async create() { return { sessionId: 'n' }; }, async rename() { return {}; } }),
    workspaceIdOf: async () => 'ws',
    sessions: { get: (c) => map.get(c) || '', set: (c, s) => map.set(c, s) },
    journal: { digests: () => [], recent: () => pool },
    agreementsOf: () => [],
    onOpening: (_c, t) => openings.push(t),
    log: () => {},
    cfgOf: () => ({ compact: { ...DEFAULTS, keepRecentUser: 2, keepRecentBot: 1 } }),
  });
  await compact.compact('g1', {});
  const lines = (openings[0].match(/· /g) || []).length;
  assert.ok(lines <= 3, `按配置最多 3 条，实际 ${lines}`);
});
