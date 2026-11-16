/**
 * `qq_menu`：菜单读改写 + 挑格 + 校验。
 *
 * 这一组测的都是**离线可测的那部分**：假 rpc、临时目录，不碰真机器人。
 * 之所以能这么测，是因为副作用全从 `buildMenuTool` 的参数注入进来。
 *
 * 守的重点是两条「会真的弄坏主人东西」的行为：
 *   1. 覆盖式写入时必须把别人的项原样带回去（否则整个菜单被清空）
 *   2. 认不出自己那一格时**不许追加**（追加会一路漂移到满 10 项、永久哑掉）
 *
 * 跑法：node --test test/menu-tool.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractMenuItems, pickMenuSlot, validateMenuText, applyMenuSlot,
  createSlotStore, buildMenuTool, buildMenuPrompt, restoreMenuSlot,
  MAX_MENU_ITEMS, MAX_MENU_TEXT,
} from '../src/menu-tool.js';
import { createHistory } from '../src/self-expression.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-menu-'));
  /** Windows 上刚写完的文件偶尔还占着句柄，直接 rm 会 ENOTEMPTY —— 不是被测代码的问题 */
  return { dir, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

/**
 * 假协议：只认 getGlobalMenu / setGlobalMenu。
 *
 * **必须是有状态的**：写入真的会替换掉菜单，下次读要能读到。
 * 无状态的假实现会让「第二次改」看起来像「那一格被人删了」——
 * 那是假实现的毛病，不是被测代码的（E7 踩过）。
 */
function fakeRpc({ items = [], failSet = null } = {}) {
  const calls = [];
  let cur = items.map((x) => ({ ...x }));
  const fn = async (m, params = {}) => {
    calls.push({ m, params });
    if (params.method === 'getGlobalMenu') return { items: cur.map((x) => ({ ...x })) };
    if (params.method === 'setGlobalMenu') {
      if (failSet) throw new Error(failSet);
      cur = (params.args?.[0] || []).map((x) => ({ ...x }));
      return {};
    }
    throw new Error('unexpected method ' + m);
  };
  fn.calls = calls;
  fn.items = () => cur.map((x) => ({ ...x }));
  return fn;
}

function makeTool({ dir, items = [], failSet = null, cfg = {}, rpc: rpcIn = null }) {
  const rpc = rpcIn || fakeRpc({ items, failSet });
  const slots = createSlotStore({ dataDir: () => dir });
  const history = createHistory({ dataDir: () => dir });
  const tool = buildMenuTool({
    rpc,
    cfgOf: () => ({ selfExpression: { menu: { enabled: true, cooldownMin: 0, ...cfg } } }),
    slots,
    history,
    sidOf: () => 'sid-1',
    now: () => 1_000_000,
  });
  return { tool, rpc, slots, history };
}

/* ---------------- 纯函数 ---------------- */

test('M1 extractMenuItems 认三种形状，认不出回 null', () => {
  assert.deepEqual(extractMenuItems({ items: [1] }), [1]);
  assert.deepEqual(extractMenuItems({ menu: { items: [2] } }), [2]);
  assert.deepEqual(extractMenuItems({ data: { items: [3] } }), [3]);
  assert.equal(extractMenuItems({}), null);
  assert.equal(extractMenuItems(null), null);
  /** 空数组是合法菜单，不能跟「没看懂」混为一谈 */
  assert.deepEqual(extractMenuItems({ items: [] }), []);
});

test('S1 记录命中（索引与名字都对得上）', () => {
  const items = [{ name: '帮助' }, { name: '·有点闷' }];
  assert.deepEqual(pickMenuSlot(items, { index: 1, name: '·有点闷' }), { index: 1, mode: 'saved' });
});

test('S2 记录失效但还有唯一的「·」项 → 用前缀认', () => {
  const items = [{ name: '帮助' }, { name: '·换了个说法' }];
  assert.deepEqual(pickMenuSlot(items, { index: 1, name: '·有点闷' }), { index: 1, mode: 'marker' });
});

test('S2b 记录失效且没有任何「·」项 → 拒绝，绝不追加（否则菜单会被一格一格撑满）', () => {
  const items = [{ name: '帮助' }, { name: '心情' }];
  const r = pickMenuSlot(items, { index: 1, name: '·有点闷' });
  assert.ok(r.error, '记过但找不到了，必须拒而不是补一格');
  assert.match(r.error, /不在了/);
});

test('S2c 没记过（首次）才算追加 —— 与 S2b 的区别只有这一条', () => {
  const items = [{ name: '帮助' }, { name: '心情' }];
  assert.deepEqual(pickMenuSlot(items, null), { index: 2, mode: 'append' });
});

test('S3 多个「·」项：不猜，报错', () => {
  const items = [{ name: '·甲' }, { name: '·乙' }];
  const r = pickMenuSlot(items, null);
  assert.ok(r.error, '多个标记项必须拒绝而不是挑第一个');
  assert.match(r.error, /分不清/);
});

test('S4 空菜单 → 追加（首次）', () => {
  assert.deepEqual(pickMenuSlot([], null), { index: 0, mode: 'append' });
});

test('S5 菜单满 10 项且没有她的格 → 拒绝，不许硬挤', () => {
  const items = Array.from({ length: MAX_MENU_ITEMS }, (_, i) => ({ name: `项${i}` }));
  const r = pickMenuSlot(items, null);
  assert.ok(r.error);
  assert.match(r.error, /满/);
});

test('T1 文本校验：空 / 超长 / 只有符号', () => {
  assert.equal(validateMenuText('').ok, false);
  assert.equal(validateMenuText('   ').ok, false);
  assert.equal(validateMenuText('·').ok, false);
  assert.equal(validateMenuText('·  ·').ok, false);
  const long = '一'.repeat(MAX_MENU_TEXT + 1);
  const r = validateMenuText(long);
  assert.equal(r.ok, false);
  assert.match(r.message, /最多/);
  assert.deepEqual(validateMenuText('  今天  有点闷 '), { ok: true, text: '今天 有点闷' });
});

test('T2 emoji 按码点算长度（别被 UTF-16 骗）', () => {
  /** '🌧' 是代理对，但只算 1 个字；12 个刚好在边界内 */
  const ok = validateMenuText('🌧'.repeat(MAX_MENU_TEXT));
  assert.equal(ok.ok, true);
  const no = validateMenuText('🌧'.repeat(MAX_MENU_TEXT + 1));
  assert.equal(no.ok, false);
});

test('A1 改自己那一格时，别人的项原样保留', () => {
  const items = [
    { name: '帮助', type: 'send_message', send_message: '怎么用' },
    { name: '·有点闷', type: 'send_message', send_message: '在的' },
    { name: '官网', type: 'link', link: 'https://example.com' },
  ];
  const r = applyMenuSlot(items, 1, { text: '·想聊这个' });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].name, '帮助');
  assert.equal(r.items[2].link, 'https://example.com');
  /** 没给 say 就沿用原来的载荷，别把「点一下发什么」弄丢 */
  assert.equal(r.items[1].send_message, '在的');
  assert.equal(r.items[1].name, '·想聊这个');
});

test('A2 给了 say 就一起改', () => {
  const items = [{ name: '·旧', type: 'send_message', send_message: '旧话' }];
  const r = applyMenuSlot(items, 0, { text: '·新', say: '新话' });
  assert.equal(r.items[0].send_message, '新话');
});

test('A3 不是 send_message 类型 → 拒绝（改名字会把用途弄坏）', () => {
  const items = [{ name: '官网', type: 'link', link: 'https://x' }];
  const r = applyMenuSlot(items, 0, { text: '·官网' });
  assert.equal(r.ok, false);
  assert.match(r.message, /link/);
});

test('A4 追加时带默认载荷', () => {
  const r = applyMenuSlot([], 0, { text: '·有点闷' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items[0], { name: '·有点闷', type: 'send_message', send_message: '在的' });
});

test('A5 重建时丢掉 GET 回来的未知字段', () => {
  const items = [{ name: '帮助', type: 'send_message', send_message: 'x', menu_id: 'abc', extra: 1 }];
  const r = applyMenuSlot(items, 0, { text: '·新' });
  assert.equal('menu_id' in r.items[0], false);
  assert.equal('extra' in r.items[0], false);
});

/* ---------------- 工具行为 ---------------- */

test('E1 不传 text = 只读，不发写请求', async () => {
  const { dir, done } = fresh();
  try {
    const { tool, rpc } = makeTool({ dir, items: [{ name: '·有点闷', type: 'send_message', send_message: '在' }] });
    const r = await tool.execute({});
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'read');
    assert.equal(r.now, '·有点闷');
    assert.equal(rpc.calls.length, 1);
    assert.equal(rpc.calls[0].params.method, 'getGlobalMenu');
  } finally { done(); }
});

test('E2 首次写：追加一格、落 slot、留历史', async () => {
  const { dir, done } = fresh();
  try {
    const { tool, rpc, slots, history } = makeTool({ dir, items: [{ name: '帮助', type: 'send_message' }] });
    const r = await tool.execute({ text: '·有点闷' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'append');
    const set = rpc.calls.find((c) => c.params.method === 'setGlobalMenu');
    assert.ok(set, '必须真的写回去');
    assert.equal(set.params.args[0].length, 2, '别人的项要带上');
    assert.equal(set.params.args[0][0].name, '帮助');
    assert.deepEqual(slots.read(), { index: 1, name: '·有点闷', type: 'send_message' });
    const rows = history.read();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'menu');
    assert.equal(rows[0].ok, true);
    assert.equal(rows[0].before, null, '首次没有旧值');
  } finally { done(); }
});

test('E3 已有记录时改同一格，不动别人', async () => {
  const { dir, done } = fresh();
  try {
    const items = [{ name: '帮助', type: 'send_message' }, { name: '·旧说法', type: 'send_message' }];
    const { tool, rpc, history } = makeTool({ dir, items });
    /** 先手动种一个记录，模拟「她之前改过」 */
    createSlotStore({ dataDir: () => dir }).write({ index: 1, name: '·旧说法', type: 'send_message' });
    const r = await tool.execute({ text: '·新说法' });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'saved');
    const set = rpc.calls.find((c) => c.params.method === 'setGlobalMenu');
    assert.equal(set.params.args[0][0].name, '帮助');
    assert.equal(set.params.args[0][1].name, '·新说法');
    const row = history.read()[0];
    assert.equal(row.before.name, '·旧说法', '回滚要能看到旧值');
    assert.equal(row.after.name, '·新说法');
  } finally { done(); }
});

test('E4 写失败：留失败历史、不写 slot', async () => {
  const { dir, done } = fresh();
  try {
    const { tool, slots, history } = makeTool({ dir, items: [{ name: '·旧' }], failSet: '平台拒了' });
    const r = await tool.execute({ text: '·新' });
    assert.equal(r.ok, false);
    assert.match(r.message, /平台拒了/);
    assert.equal(slots.read(), null, '失败不该把 slot 记成新的');
    assert.equal(history.read()[0].ok, false);
  } finally { done(); }
});

test('E5 enabled:false 时直接拒，连读都不读', async () => {
  const { dir, done } = fresh();
  try {
    const { tool, rpc } = makeTool({ dir, cfg: { enabled: false } });
    const r = await tool.execute({ text: '·想改' });
    assert.equal(r.ok, false);
    assert.equal(rpc.calls.length, 0);
  } finally { done(); }
});

test('E6 冷却没过 → 拒；冷却 0 不检查', async () => {
  const { dir, done } = fresh();
  try {
    const { tool, history } = makeTool({ dir, items: [{ name: '·旧' }], cfg: { cooldownMin: 30 } });
    history.push({ kind: 'menu', at: 1_000_000 - 60_000, before: null, after: { name: '·旧' } });
    const r = await tool.execute({ text: '·新' });
    assert.equal(r.ok, false);
    assert.match(r.message, /还要等/);
  } finally { done(); }
});

test('E7 同一会话 10 秒内第二次写被挡（防连调）', async () => {
  const { dir, done } = fresh();
  try {
    let t = 2_000_000;
    const slots = createSlotStore({ dataDir: () => dir });
    const history = createHistory({ dataDir: () => dir });
    const tool = buildMenuTool({
      rpc: fakeRpc({ items: [{ name: '帮助', type: 'send_message' }] }),
      cfgOf: () => ({ selfExpression: { menu: { enabled: true, cooldownMin: 0 } } }),
      slots, history, sidOf: () => 'sid-1', now: () => t,
    });
    const first = await tool.execute({ text: '·一' });
    assert.equal(first.ok, true);
    t += 3000;
    const second = await tool.execute({ text: '·二' });
    assert.equal(second.ok, false);
    assert.match(second.message, /这一轮/);
  } finally { done(); }
});

test('E8 读回来的结构看不懂时明确拒绝，不当成空菜单覆盖', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = async () => ({ something: 'else' });
    const { tool } = makeTool({ dir, rpc });
    const r = await tool.execute({ text: '·新' });
    assert.equal(r.ok, false);
    assert.match(r.message, /看不懂/);
  } finally { done(); }
});

test('E9 多个「·」项时拒绝写（不猜）', async () => {
  const { dir, done } = fresh();
  try {
    const { tool, rpc } = makeTool({ dir, items: [{ name: '·甲' }, { name: '·乙' }] });
    const r = await tool.execute({ text: '·丙' });
    assert.equal(r.ok, false);
    assert.equal(rpc.calls.filter((c) => c.params.method === 'setGlobalMenu').length, 0);
  } finally { done(); }
});

/* ---------------- 提示词 ---------------- */

test('P1 提示词只在开启时给；配了冷却才提冷却', () => {
  assert.equal(buildMenuPrompt({ enabled: false }), '');
  const plain = buildMenuPrompt({ enabled: true, cooldownMin: 0 });
  assert.ok(plain.includes('菜单'));
  assert.equal(/分钟/.test(plain), false, '没配冷却就不该出现分钟');
  const withCd = buildMenuPrompt({ enabled: true, cooldownMin: 30 });
  assert.match(withCd, /30 分钟/);
});

test('P2 slot 文件坏了当没有，不影响改菜单', async () => {
  const { dir, done } = fresh();
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'menu-slot.json'), '{bad json', 'utf8');
    const slots = createSlotStore({ dataDir: () => dir });
    assert.equal(slots.read(), null);
    assert.ok(readFileSync(join(dir, 'menu-slot.json'), 'utf8').length > 0);
  } finally { done(); }
});

/* ---------------- 回滚 ---------------- */

test('RM1 回滚那一格：按位置覆盖，别人的项不动', async () => {
  const { dir, done } = fresh();
  try {
    const items = [
      { name: '帮助', type: 'send_message', send_message: '怎么用' },
      { name: '·新说法', type: 'send_message', send_message: '现在的话' },
    ];
    const rpc = fakeRpc({ items });
    const slots = createSlotStore({ dataDir: () => dir });
    const r = await restoreMenuSlot({
      rpc, slots,
      before: { index: 1, name: '·旧说法', type: 'send_message', send_message: '旧的话' },
    });
    assert.equal(r.ok, true);
    const after = rpc.items();
    assert.equal(after[0].name, '帮助', '别人那一格必须原样');
    assert.equal(after[1].name, '·旧说法');
    assert.equal(after[1].send_message, '旧的话');
    assert.deepEqual(slots.read(), { index: 1, name: '·旧说法', type: 'send_message' });
  } finally { done(); }
});

test('RM2 位置越界 → 拒（不「就近找一格」顶替）', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ items: [{ name: '帮助', type: 'send_message' }] });
    const slots = createSlotStore({ dataDir: () => dir });
    const r = await restoreMenuSlot({
      rpc, slots, before: { index: 3, name: '·旧', type: 'send_message' },
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /不在了/);
  } finally { done(); }
});

test('RM3 那一格被换成了 link 类型 → 拒', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ items: [{ name: '官网', type: 'link', link: 'https://x' }] });
    const slots = createSlotStore({ dataDir: () => dir });
    const r = await restoreMenuSlot({
      rpc, slots, before: { index: 0, name: '·旧', type: 'send_message' },
    });
    assert.equal(r.ok, false);
    assert.match(r.message, /link/);
  } finally { done(); }
});

test('RM4 没有 before 的名字 → 拒', async () => {
  const { dir, done } = fresh();
  try {
    const rpc = fakeRpc({ items: [] });
    const slots = createSlotStore({ dataDir: () => dir });
    const r = await restoreMenuSlot({ rpc, slots, before: null });
    assert.equal(r.ok, false);
  } finally { done(); }
});
