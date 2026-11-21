// 第 6 期（压缩）：占用读取 / 阈值 / 开场 / 换会话。
//
// 最要紧的一条断言：**换会话失败时映射必须不变**。
// 映射错了下一句会进到刚被换掉的旧窗口，等于白压 —— 而且现象是静默的。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readPressure,
  readUsage,
  shouldCompact,
  thresholdFor,
  buildOpening,
  createCompact,
  makeOpening,
  compactCfgOf,
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

/* ---------------- 缓存命中 ---------------- */

test('压缩：从投影里读 tokenUsage，算出缓存命中率', () => {
  const v = {
    values: {
      t: {
        tokenUsage: {
          uncachedInputTokens: 100,
          cacheReadTokens: 800,
          cacheWriteTokens: 100,
          outputTokens: 50,
        },
      },
    },
  };
  const u = readUsage(v);
  assert.equal(u.uncached, 100);
  assert.equal(u.cacheRead, 800);
  assert.equal(u.cacheWrite, 100);
  assert.equal(u.output, 50);
  assert.equal(u.billed, 1000, '分母是三个互不重叠的计费桶之和');
  assert.equal(u.cacheHit, 80);
});

/**
 * 0 是合法值（新会话还没发过请求），不能像 pressure 那样把 0 当"没有"。
 * 拿 0 当分母就是 NaN，界面上显示成"命中率 —"，看起来像没数据。
 */
test('压缩：还没发过请求时命中率是 null，不是 NaN', () => {
  const u = readUsage({
    t: {
      tokenUsage: {
        uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      },
    },
  });
  assert.equal(u.billed, 0);
  assert.equal(u.cacheHit, null, '0/0 要给 null，不能给 NaN');
});

test('压缩：投影里没有 tokenUsage 时给空值，不抛错', () => {
  assert.equal(readUsage(null).cacheHit, null);
  assert.equal(readUsage({}).cacheHit, null);
  assert.equal(readUsage({ values: { inbox: {} } }).cacheHit, null);
  assert.equal(readUsage('字符串').cacheHit, null);
});

test('压缩：压力和用量在同一次扫描里各取各的（不互相串）', () => {
  const v = {
    a: { contextPressure: { pressureTokens: 500, contextWindow: 1000 } },
    b: { tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 1, cacheWriteTokens: 0 } },
  };
  assert.equal(readPressure(v).percent, 50);
  assert.equal(readUsage(v).cacheHit, 100);
});

/* ---------------- 阈值 ---------------- */

test('压缩：群聊与私聊用不同阈值（不再一刀切 25%）', () => {
  // 私聊 75%
  assert.equal(shouldCompact({ percent: 75, scene: 'c2c', cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: 74.9, scene: 'c2c', cfg: DEFAULTS }).compact, false);
  // 群聊 85%
  assert.equal(shouldCompact({ percent: 85, scene: 'group', cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: 84, scene: 'group', cfg: DEFAULTS }).compact, false);
  // 同一个占用值在两种场景下结论不同——这正是拆档的意义
  assert.equal(shouldCompact({ percent: 80, scene: 'c2c', cfg: DEFAULTS }).compact, true);
  assert.equal(shouldCompact({ percent: 80, scene: 'group', cfg: DEFAULTS }).compact, false);
});

/**
 * 阈值必须比 60/40 高一截。
 *
 * 60/40 那两档压得太勤：每次换会话 prompt cache 整段失效，
 * 而换来的只是"上下文短一点"。对照 `qq-dsh-bridge` 实测
 * （阈值 15% → 95%，单步 45–55 秒 → 3–4 秒），压得越勤越慢。
 */
test('压缩：阈值抬到 85/75，不再刚过半就换会话', () => {
  assert.equal(thresholdFor({}, 'group'), 85);
  assert.equal(thresholdFor({}, 'c2c'), 75);
  assert.equal(shouldCompact({ percent: 50, scene: 'c2c', cfg: DEFAULTS }).compact, false);
  assert.equal(shouldCompact({ percent: 60, scene: 'group', cfg: DEFAULTS }).compact, false);
});

/**
 * 有人会写 `0.75` 想表达 75%。
 *
 * 不认分数的话阈值就成了 0.75%——**每轮都压**，而日志上写着
 * 「占用 12% ≥ 0.75%」，看起来还挺合理，查起来极难。
 */
test('压缩：阈值写成 0.75 要按 75% 理解（不能变成 0.75%）', () => {
  assert.equal(thresholdFor({ atPercentC2C: 0.75 }, 'c2c'), 75);
  assert.equal(thresholdFor({ atPercentGroup: 0.8 }, 'group'), 80);
  assert.equal(shouldCompact({ percent: 12, scene: 'c2c', cfg: { atPercentC2C: 0.75 } }).compact, false);
});

test('压缩：阈值被夹在 [10, 95]（太低等于不停换会话，太高来不及）', () => {
  assert.equal(thresholdFor({ atPercentC2C: 1 }, 'c2c'), 10, '1% 要抬到 10%');
  assert.equal(thresholdFor({ atPercentC2C: 99 }, 'c2c'), 95);
  assert.equal(thresholdFor({ atPercentC2C: 0 }, 'c2c'), 75, '0 = 没配，用默认');
  assert.equal(thresholdFor({ atPercentC2C: 'abc' }, 'c2c'), 75, '乱写也别把压缩弄死');
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

function fakeRig({ failCreate = false, percent = 80, usage = null, applyModelOf } = {}) {
  const map = new Map([['g1', 'old-sid']]);
  const made = [];
  const openings = [];
  /** 新会话套默认模型的调用记录 */
  const modelCalls = [];
  /** rename 过的标题（换会话时的标题靠它验） */
  const renamed = [];
  const controller = {
    async create({ workspaceId, agentPreset }) {
      if (failCreate) throw new Error('建会话失败');
      const sid = `new-${made.length + 1}`;
      made.push({ sid, workspaceId, agentPreset });
      return { sessionId: sid };
    },
    async rename({ sessionId, title }) {
      renamed.push({ sessionId, title });
      return {};
    },
    async projections() {
      // 默认 80%：过了私聊的 75%，没过群聊的 85%——正好能验分档
      const v = {
        values: {
          t: {
            contextPressure: { projectedTokens: percent * 10, contextWindow: 1000 },
            tokenUsage: usage ?? {
              uncachedInputTokens: 200,
              cacheReadTokens: 700,
              cacheWriteTokens: 100,
              outputTokens: 50,
            },
          },
        },
      };
      return v;
    },
  };
  /** compact 传给 sessions.set 的第三个参数（title / kind / preset） */
  const meta = [];
  const sessions = {
    get: (c) => map.get(c) || '',
    set: (c, s, m) => {
      map.set(c, s);
      if (m) meta.push(m);
    },
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
    applyModelOf: async (sid) => {
      modelCalls.push(sid);
      if (applyModelOf) await applyModelOf(sid);
    },
    log: () => {},
    cfgOf: () => ({ compact: DEFAULTS }),
    now: () => Date.now(),
  });
  return { compact, map, made, openings, modelCalls, renamed, meta };
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
  assert.equal(c1.compacted, true, '80% ≥ 75%（私聊）应该压');
  assert.equal(map.get('g1'), 'new-1');

  // 再压一次：刚换过，轮数归零，且投影仍报 80% → 会再压。
  // 这里验的是"不会抛错"，真实使用中轮数归零 + 新会话占用低，自然不会再触发。
  const c2 = await compact.maybe('g1', { preset: 'roost-social' });
  assert.equal(typeof c2.compacted, 'boolean');
});

test('压缩：同一个占用值，群里不压、私聊压', async () => {
  const { compact } = fakeRig();
  const c2c = await compact.maybe('g1', { kind: 'c2c' });
  assert.equal(c2c.compacted, true, '80% ≥ 75%');
  const g = await compact.maybe('g1', { kind: 'group' });
  assert.equal(g.compacted, false, '80% < 85%，群里还能再撑一会儿');
});

/**
 * 压之前那一秒的缓存命中率必须记下来。
 *
 * `tokenUsage` 是**按会话累计**的，压完就是新会话、从零开始——
 * "压之后"永远拿不到，所以这个数一旦漏记就没有第二次机会。
 * 它也是判断阈值该往上还是往下调的唯一依据。
 */
test('压缩：记下压之前的缓存命中率（调阈值的唯一依据）', async () => {
  const { compact } = fakeRig({
    usage: { uncachedInputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 100, outputTokens: 50 },
  });
  const r = await compact.maybe('g1', {});
  assert.equal(r.compacted, true);
  // 700 / (200 + 700 + 100) = 70%
  assert.equal(Math.round(r.cacheHit), 70);

  const st = compact.status();
  assert.equal(st.history.length, 1);
  assert.equal(Math.round(st.history[0].cacheHit), 70);
  assert.equal(Math.round(st.history[0].percent), 80);
  assert.equal(st.history[0].tokens, 1000, '记的是三个计费桶之和');
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

/* ---------------- 换会话：套默认模型 / 标题 ---------------- */

test('压缩：换会话后套一次默认模型（否则压缩完第一轮报没模型）', async () => {
  const { compact, modelCalls } = fakeRig();
  const r = await compact.compact('g1', { preset: 'roost-social', name: '摸鱼群' });
  assert.equal(r.ok, true);
  assert.deepEqual(modelCalls, ['new-1'], '必须给新会话套模型，且只套一次');
});

test('压缩：套模型失败不能把压缩整件事搞砸', async () => {
  const { compact, map, modelCalls } = fakeRig({
    applyModelOf: async () => { throw new Error('宿主没暴露 selectModel'); },
  });
  const r = await compact.compact('g1', { preset: 'roost-social', name: '摸鱼群' });
  assert.equal(r.ok, true, '套模型失败只是记日志');
  assert.equal(modelCalls.length, 1);
  assert.equal(map.get('g1'), 'new-1', '映射照样要指向新会话');
});

test('压缩：续会话标题带「（续）」，且手动压缩（chat 没有 chatId）也能拿到尾号', async () => {
  const { compact, renamed } = fakeRig();
  // 手动压缩路由传的就是这三个字段，没有 chatId
  await compact.compact('g1', { kind: 'group', name: '', preset: 'roost-social' });
  assert.equal(renamed[0].title, 'QQ · 群 g1（续）', '尾号必须来自 chatId 参数，不能是空的');
});

test('压缩：有名字时标题用名字，不吃哨兵名', async () => {
  const { compact, renamed } = fakeRig();
  await compact.compact('g1', { kind: 'c2c', name: '主动搭话', preset: 'roost-private' });
  assert.ok(!renamed[0].title.includes('主动搭话'), '哨兵名不能进标题');
  assert.ok(renamed[0].title.includes('私聊'), '按 kind 走私聊兜底');
});


test('压缩：换会话后 kind 要一起存（丢了面板分不出群/私聊）', async () => {
  const { compact, meta } = fakeRig();
  await compact.compact('g1', { kind: 'group', name: '摸鱼群', preset: 'roost-social' });
  assert.equal(meta.length, 1);
  assert.equal(meta[0].kind, 'group', 'sessions.set 必须带上 kind');
  assert.equal(meta[0].title, 'QQ · 摸鱼群（续）');
});

/* ---------------- 开场重建：配额归一化只有一个出口 ---------------- */

/**
 * 2026-11 踩过：`host.js` 的 `rebuildOpening` 直接把**整份** `cfg` 传给
 * `makeOpening`，而它读的是扁平的 `keepDigests` —— 那在 `cfg.compact` 下面。
 * 后果不是报错，是**静默取默认**：`keepDigests` 变 `undefined`，
 * `journal.digests` 回 5 条，`buildOpening` 再 `slice(-3)`，
 * 「这几天」从最新 3 条变成最旧 3 条。
 *
 * 所以归一化只留 `compactCfgOf()` 一个出口，下面三条钉住它。
 */
function fakeJournal({ rows = [], digests = [] } = {}) {
  const calls = { recent: [], digests: [] };
  return {
    calls,
    recent(chatId, n, kind, aliases) {
      calls.recent.push({ chatId, n, kind, aliases });
      return rows;
    },
    digests(chatId, n, aliases) {
      calls.digests.push({ chatId, n, aliases });
      return digests;
    },
  };
}

test('开场重建：compactCfgOf 把 cfg.compact 摊平，缺的字段回默认', () => {
  const flat = compactCfgOf(() => ({ compact: { keepDigests: 7 } }))();
  assert.equal(flat.keepDigests, 7, '配了的要生效');
  assert.equal(flat.keepRecentUser, DEFAULTS.keepRecentUser, '没配的回默认');
  assert.equal(flat.keepRecentBot, DEFAULTS.keepRecentBot);
  assert.equal(flat.enabled, DEFAULTS.enabled);
  /** cfgOf 返回空 / undefined 也不能炸 */
  assert.equal(compactCfgOf(() => undefined)().keepDigests, DEFAULTS.keepDigests);
  assert.equal(compactCfgOf()().keepDigests, DEFAULTS.keepDigests);
});

test('开场重建：摘要条数按配置传下去，不是 undefined', () => {
  const j = fakeJournal({ digests: [{ at: 1, text: 'd1' }] });
  makeOpening({ journal: j, cfgOf: compactCfgOf(() => ({ compact: { keepDigests: 7 } })) })('g1');
  assert.equal(j.calls.digests[0].n, 7, '必须是有值的数字；undefined 会让 journal 用 5 条兜底');
  assert.equal(j.calls.digests[0].chatId, 'g1');
});

test('开场重建：用户 / 她的条数配额按配置生效', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ role: 'user', sender: '主人', text: `u${i}`, at: i });
  for (let i = 0; i < 5; i += 1) rows.push({ role: 'bot', text: `b${i}`, at: 100 + i });
  const j = fakeJournal({ rows });
  const text = makeOpening({
    journal: j,
    cfgOf: compactCfgOf(() => ({ compact: { keepRecentUser: 4, keepRecentBot: 2 } })),
  })('g1');
  assert.equal(j.calls.recent[0].n, 40, '一次多取一些再按角色分');
  const userLines = text.split('\n').filter((l) => l.includes('主人（')).length;
  const botLines = text.split('\n').filter((l) => l.includes('你（')).length;
  assert.equal(userLines, 4, `用户原话 4 条，实际 ${userLines}`);
  assert.equal(botLines, 2, `她的话 2 条，实际 ${botLines}`);
});

test('开场重建：与 buildOpening 直接拼出来的完全一致（同一份规则）', () => {
  const digests = [{ at: 1, text: 'd1' }, { at: 2, text: 'd2' }, { at: 3, text: 'd3' }, { at: 4, text: 'd4' }];
  const rows = [
    { role: 'user', sender: '主人', text: 'u1', at: 10 },
    { role: 'bot', text: 'b1', at: 11 },
  ];
  const j = fakeJournal({ rows, digests });
  const now = 5_000;
  const viaMake = makeOpening({ journal: j, cfgOf: compactCfgOf(() => ({})), now: () => now })('g1');
  const direct = buildOpening({ digests, recent: rows, agreements: [], now });
  assert.equal(viaMake, direct);
});

test('开场重建：host.js 的接线必须过 compactCfgOf（源码级，挡住回退）', async () => {
  const { readFileSync } = await import('node:fs');
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const at = host.indexOf('const rebuildOpening = makeOpening(');
  assert.ok(at > 0, '没找到 rebuildOpening 的构造，变量名可能改了');
  const block = host.slice(at, host.indexOf('});', at));
  assert.match(block, /cfgOf:\s*compactCfgOf\(/, 'rebuildOpening 的 cfgOf 必须过 compactCfgOf');
  /**
   * 直接写 `cfgOf: () => cfg` 就是那个 bug 的形状：`keepDigests` 取到
   * `undefined`，摘要从最新 3 条变最旧 3 条，而且**不报错**。
   */
  assert.ok(!/cfgOf:\s*\(\)\s*=>\s*cfg\b/.test(block), '不许把整份 cfg 直接递进去');
});

/**
 * 重建开场时「一点料都没有」要回空串（2026-11 复核）。
 *
 * `buildOpening({})` 保留骨架是有意的（压缩那一刻总要给模型一句话），
 * 但**重建**路径不同：日记被「彻底删除」或 7 天滚动清掉之后，
 * 骨架会被判真、消费掉指针、注入给模型——模型看到「接着上面」却没有「上面」。
 */
test('开场：重建路径没有料时回空串（不注入无内容的骨架）', () => {
  const mk = makeOpening({
    journal: { recent: () => [], digests: () => [] },
    agreementsOf: () => [],
  });
  assert.equal(mk('g1'), '', '三样都空 → 空串（`pending-opening` 据此删指针但不注入）');

  /** 有料时照常拼 */
  const mk2 = makeOpening({
    journal: {
      recent: () => [{ at: Date.now(), role: 'user', sender: '主人', text: '在吗' }],
      digests: () => [],
    },
    agreementsOf: () => [],
  });
  assert.match(mk2('g1'), /刚才说到/);
});
