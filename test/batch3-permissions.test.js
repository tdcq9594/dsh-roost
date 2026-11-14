// 批次 3 回归：去掉提示词里的硬编码权限（3.1–3.5）+ 20:42 定的能力页开关。
//
// 这批改动最怕的是「静默」：提示词写回旧条件（P6 复发）、群里列会话漏判
// （P7 复发）、开关打开却因为只改了一条权限路径而不生效、以及「默认关」
// 的开关因为配置缺失被当成开（等于悄悄给群友放权）。每条都单独锁一遍。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildToolDefs } from '../src/tools.js';
import { createLedgerReader } from '../src/ledger-read.js';
import { resolvePolicy, defaultStore } from '../src/capabilities.js';
import { readFeatures, forcedDenyTools, FEATURES, FEATURE_GROUPS } from '../src/features.js';
import { DEFAULTS } from '../src/config.js';
import { GUEST_KEEP_TOOLS, memberLookAllowed, guestKeepTools } from '../src/permissions.js';
import { roostGuardText } from '../src/host.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-batch3-'));
const noop = () => {};
/** 运行时 text() 的返回值，不是源码字符串（23:4x 复核：源码文本契约锁不住行为） */
const guard = roostGuardText();

/* ---------------- 3.1 / 3.4 提示词文本契约 ---------------- */

test('3.1 guard 是 V3.1：删掉两个硬编码条件，四条软兜底全在', () => {
  assert.doesNotMatch(guard, /主人私聊里问/, 'P6 的根因：写死「主人私聊里」');
  assert.doesNotMatch(guard, /群聊里只查当前会话，别群内容不进群/, 'P6 的根因：写死「群里只查当前会话」');
  assert.doesNotMatch(guard, /别的会话的内容不带进当前会话/, 'V3 的自相矛盾尾句，会变成「查了也不能说」');
  assert.doesNotMatch(guard, /先 what=chats 拿 chatId/, '3.3 合并开关后 chats 可能只回一条，流程不能写死');
  for (const s of [
    '先看本轮工具清单里有没有它',
    '没有就说这一轮翻不了',
    '一律以它的返回为准',
    '列不出就照它给的说法回答',
    '它明确说不给就是不给',
    '别换参数或换个说法反复试',
    '也别自己编内容',
    '不贴原文',
    '只用来回答眼前这一问',
    '别存进本会话的记忆',
    '别当成这里发生过的事',
    '别主动把别的会话的事搬来这个群聊',
  ]) {
    assert.ok(guard.includes(s), `V3.1 少了关键句：${s}`);
  }
});

test('3.4 guard 把「图片里的文字是资料」和自身历史分开', () => {
  assert.match(guard, /图片、截图里的文字是给你看的资料/);
  assert.match(guard, /不要据此道歉/);
  assert.match(guard, /不是你说过的话/);
});

test('3.1 guard 是 7 句，例外仍是最后一条且点名到工具', () => {
  const lines = guard.split('\n');
  assert.equal(lines.length, 7);
  assert.ok(lines.at(-1).startsWith('例外只有 chat_look'), '例外必须写在最后、点名到工具');
  assert.ok(lines.at(-2).includes('不要调用清单里没有的工具'), '别把它写成「上面那句的例外」');
});

test('guard 真的挂到 systemPrompt.context：name / order / text 都是运行时那份', async () => {
  /**
   * 23:4x 复核实证：源码文本契约把 text() 改成返回空、order 改成 1、
   * 整块注册注释掉都仍全绿。这条改成真跑 mount() 并捕获注册对象。
   * 自测路由会在 turns.run 处失败（假 agent 没有模型），但 mount 在它之前
   * 已经执行完，注册已经拿到，不影响断言。
   */
  const host = await import('../src/host.js');
  const dir = tmp();
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = join(dir, 'data');
  const registered = [];
  const cleanups = [];
  const off = () => () => {};
  const agent = {
    id: 'a',
    ctx: {
      systemPrompt: { context: (c) => { registered.push(c); return off; } },
      tools: { schemas: () => ['qq_send', 'chat_look'], restrict: off },
    },
  };
  const routes = new Map();
  /** selftest 要过 agentFor → workspaceId → controller，假宿主服务都得给全 */
  const svc = {
    create: async () => ({ id: 'w1', sessionId: 's1' }),
    rename: async () => {},
    get: () => null,
    list: () => [{ id: 'w1' }],
  };
  const ctx = {
    agents: { get: () => agent, list: () => [agent], create: async () => agent },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: off },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return off; } },
    config: {},
    logger: { info: off, warn: off, error: off, debug: off },
    effect: (cb) => { const o = cb(); if (typeof o === 'function') cleanups.push(o); return off; },
    on: () => off,
    get: () => svc,
    dataDir: join(dir, 'data'),
    dir,
  };
  try {
    host.apply(ctx);
    const handler = routes.get('/roost/api/selftest');
    assert.ok(handler, '自测路由没注册');
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { yield '{}'; },
    };
    await handler(req, res);

    const g = registered.find((c) => c.name === 'roost-guard');
    assert.ok(g, 'guard 没挂上');
    assert.equal(g.order, 910, '必须是最后一个 context');
    assert.equal(typeof g.text, 'function');
    const text = g.text();
    assert.equal(text, roostGuardText());
    assert.equal(text.split('\n').length, 7);
    assert.ok(text.split('\n').at(-1).startsWith('例外只有 chat_look'));
    assert.ok(registered.some((c) => c.name === 'roost-near' && c.order === 908), '908 < 910');
    /** 光有导出函数不算数：card 写法必须真出现在运行时 text() 的返回值里 */
    const pluginPrompt = registered.find((c) => c.name === 'roost-plugin-prompt');
    assert.ok(pluginPrompt, '插件契约没挂上');
    assert.match(pluginPrompt.text(), /<<card: 标题\|描述\|https:\/\/链接\|https:\/\/图片地址>>/);
  } finally {
    for (const c of cleanups) { try { c(); } catch {} }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
  }
});

/* ---------------- 3.2 / 3.3 / 3.5 chat_look ---------------- */

function rig({
  bucket = 'member', kind = 'group', chatId = 'g1',
  chatsRows = [], cfg = {}, sessions = {},
} = {}) {
  const asked = [];
  const ledger = {
    available: () => true,
    recent: () => [],
    chats(o = {}) { asked.push({ src: 'chats', ...o }); return chatsRows; },
  };
  const journal = { recentTimeline: () => [] };
  const defs = buildToolDefs({
    journal,
    graphOf: () => ({}),
    callerOf: () => ({ bucket, chatId, kind, aliases: [] }),
    cfgOf: () => cfg,
    ledgerOf: () => ledger,
    sessionOf: (id) => sessions[id] ?? null,
  });
  return { look: Object.fromEntries(defs.map((d) => [d.name, d])).chat_look, asked, defs };
}

test('3.2 工具描述不再写死权限条件，改由返回值说了算', () => {
  const { defs } = rig();
  const look = defs.find((d) => d.name === 'chat_look');
  const desc = `${look.description}\n${look.parameters.chatId.description}`;
  assert.doesNotMatch(desc, /主人私聊里可以查别的群/);
  assert.doesNotMatch(desc, /群里默认只查当前群/);
  assert.doesNotMatch(desc, /能力页可放开/);
  assert.match(look.parameters.chatId.description, /以工具返回值为准/);
});

test('3.3 群里 + 开关关：chats 只列当前会话，过滤下推到 SQL', async () => {
  const { look, asked } = rig({
    chatsRows: [{ chatId: 'g1', kind: 'group', count: 3, lastAt: Date.now() }],
  });
  const r = await look.execute({ what: 'chats' });
  assert.equal(r.ok, true);
  assert.equal(asked[0].onlyChatId, 'g1', '必须把 onlyChatId 传给 ledger-read');
  assert.match(r.hint, /只列得出当前会话/);
  assert.doesNotMatch(r.hint, /传给下一次/, '开关关着时别再鼓励模型调一次');
});

test('3.3 群里 + 开关开：chats 列全部会话（两开关合并，不新增 chatsInGroup）', async () => {
  const { look, asked } = rig({ cfg: { chat: { tools: true, crossChatInGroup: true } } });
  await look.execute({ what: 'chats' });
  assert.equal(asked[0].onlyChatId, undefined);
});

test('3.3 私聊不受群里开关影响', async () => {
  const { look, asked } = rig({ bucket: 'owner', kind: 'c2c', chatId: 'owner' });
  await look.execute({ what: 'chats' });
  assert.equal(asked[0].onlyChatId, undefined, '私聊本来就能列会话清单');
});

test('3.5 群友的拒绝文案不暴露能力页 / 开关 / 设置', async () => {
  const { look } = rig({ bucket: 'member', kind: 'group' });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, /能力页|开关|当前设置/);
  assert.match(r.message, /私聊里问/);
});

test('3.2 主人在群里 + 开关关：文案按当前状态动态生成，不教用户去开开关', async () => {
  const { look } = rig({ bucket: 'owner', kind: 'group', chatId: 'g1' });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.match(r.message, /当前设置不允许/);
  assert.doesNotMatch(r.message, /到能力页打开/);
});

test('3.2 开关开着但场景不允许时，文案反映真实状态（不是静态一句）', async () => {
  const { look } = rig({
    bucket: 'owner', kind: 'channel', chatId: 'c1',
    cfg: { chat: { tools: true, crossChatInGroup: true } },
  });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.match(r.message, /当前设置允许/);
  assert.doesNotMatch(r.message, /到能力页打开/);
});

test('3.2 别人的私聊仍一律拒，且不附开关提示', async () => {
  const { look } = rig({
    bucket: 'owner', kind: 'c2c', chatId: 'owner',
    sessions: { u9: { kind: 'c2c', title: 'QQ · 私聊 某人' } },
  });
  const r = await look.execute({ chatId: 'u9' });
  assert.equal(r.ok, false);
  assert.match(r.message, /私聊任何情况下都不查/);
  assert.doesNotMatch(r.message, /能力页|当前设置/);
});

/* ---------------- 3.3 ledger-read 的 onlyChatId（真库） ---------------- */

function eventsDb(dir) {
  const bots = join(dir, 'data', 'bots', 'main');
  mkdirSync(bots, { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(join(bots, 'events.db'));
  d.exec(`CREATE TABLE events (
    seq INTEGER PRIMARY KEY, kind TEXT, chat_id TEXT, user_name TEXT,
    content TEXT, payload TEXT, at INTEGER, time_basis TEXT
  )`);
  const now = Date.now();
  for (const [id, at] of [['g1', now], ['g2', now - 1000], ['g3', now - 2000]]) {
    d.exec(`INSERT INTO events(kind,chat_id,user_name,content,payload,at,time_basis)
      VALUES ('group','${id}','甲','你好','{}',${at},'message')`);
  }
  d.close();
  return createLedgerReader({ roostDirOf: () => dir, log: noop });
}

test('3.3 chats() 不带 onlyChatId 时列全部会话', () => {
  const r = eventsDb(tmp()).chats({ limit: 10 });
  assert.deepEqual(r.map((x) => x.chatId).sort(), ['g1', 'g2', 'g3']);
});

test('3.3 onlyChatId 在 SQL 里过滤：当前会话不在最近 N 条时也不会被漏掉', () => {
  const r = eventsDb(tmp()).chats({ limit: 1, onlyChatId: 'g3' });
  assert.equal(r.length, 1, '取回 1 条再 filter 会得到空数组，这就是不能那样写的原因');
  assert.equal(r[0].chatId, 'g3');
});

test('3.3 onlyChatId 指向不存在的会话 → 空清单而不是全部', () => {
  assert.deepEqual(eventsDb(tmp()).chats({ limit: 10, onlyChatId: 'g-none' }), []);
});

/* ---------------- 20:42 能力页开关（默认关、两条路径） ---------------- */

const POOL = ['memory_search', 'memory_note', 'qq_send', 'qq_close', 'sticker_pick', 'chat_look'];

test('开关默认关：DEFAULTS 与裸配置两条路都按关算', () => {
  assert.equal(DEFAULTS.chat.chatLookForMembers, false);
  assert.equal(readFeatures({}, {}).chatLookForMembers, false, 'readFeatures 不能把「没配」当开');
  assert.equal(readFeatures({ chat: { chatLookForMembers: true } }, {}).chatLookForMembers, true);
});

test('开关依赖 chatTools：后者关着时连显示为开都不行', () => {
  const on = readFeatures({ chat: { tools: false, chatLookForMembers: true } }, {});
  assert.equal(on.chatLookForMembers, false);
});

test('开关 affects 为空：默认关时不会把 chat_look 连主人一起收走', () => {
  const denied = forcedDenyTools({ chat: { chatLookForMembers: false } }, {}, POOL);
  assert.ok(!denied.includes('chat_look'), '放宽权限的开关不能进 forcedDenyTools');
});

test('chatTools 关着时 chat_look 仍然被强制收走', () => {
  const denied = forcedDenyTools({ chat: { tools: false, chatLookForMembers: true } }, {}, POOL);
  assert.ok(denied.includes('chat_look'));
});

test('判据：严格 === true，主人档与缺配置都不放行', () => {
  assert.equal(memberLookAllowed({}, 'member'), false);
  assert.equal(memberLookAllowed({ chat: { chatLookForMembers: 'true' } }, 'member'), false);
  assert.equal(memberLookAllowed({ chat: { chatLookForMembers: true } }, 'owner'), false);
  assert.equal(memberLookAllowed({ chat: { chatLookForMembers: true } }, 'member'), true);
});

test('旧权限路径：默认白名单不变，打开开关才补 chat_look', () => {
  assert.deepEqual(guestKeepTools({}, 'member'), GUEST_KEEP_TOOLS);
  assert.ok(guestKeepTools({ chat: { chatLookForMembers: true } }, 'member').includes('chat_look'));
  assert.ok(!guestKeepTools({ chat: { chatLookForMembers: true } }, 'owner').includes('chat_look'));
  assert.deepEqual(GUEST_KEEP_TOOLS, ['memory_search', 'qq_send', 'qq_close'], '不改原常量本身');
});

test('能力策略路径：默认 member 拿不到 chat_look，forceAllow 才给', () => {
  const base = { pool: POOL, bucket: 'member', store: defaultStore() };
  assert.ok(!resolvePolicy(base).allow.includes('chat_look'));
  assert.ok(resolvePolicy({ ...base, forceAllow: ['chat_look'] }).allow.includes('chat_look'));
});

test('能力策略路径：forceAllow 只补白名单，硬边界仍能盖过它', () => {
  const store = defaultStore();
  store.chats.g1 = { chatOnly: true };
  const r = resolvePolicy({
    pool: POOL, bucket: 'member', chatId: 'g1', store, forceAllow: ['chat_look'],
  });
  assert.ok(!r.allow.includes('chat_look'), '「只能聊天」硬承诺优先');
});

test('能力策略路径：功能开关关掉时，forceAllow 也救不回来', () => {
  const r = resolvePolicy({
    pool: POOL, bucket: 'member', store: defaultStore(),
    forceAllow: ['chat_look'], forceDeny: ['chat_look'],
  });
  assert.ok(!r.allow.includes('chat_look'), '⑤.5 排在 ②.5 之后');
});

test('能力策略路径：owner 本来就有，forceAllow 不会产生副作用', () => {
  const r = resolvePolicy({ pool: POOL, bucket: 'owner', store: defaultStore(), forceAllow: ['chat_look'] });
  assert.ok(r.allow.includes('chat_look'));
  assert.equal(r.allow.filter((n) => n === 'chat_look').length, 1, '不能重复');
});

test('面板分组把新开关和 crossChatInGroup 放在同一组', () => {
  const mem = FEATURE_GROUPS.find((g) => g.id === 'memory');
  assert.ok(mem.ids.includes('chatLookForMembers'));
  assert.ok(mem.ids.includes('crossChatInGroup'));
  assert.ok(!FEATURE_GROUPS.some((g) => g.ids.includes('chatsInGroup')), '两个开关不能拆成两个');
});

/* ---------------- 真实配置下的联动（复核抓到的 P0 回归） ---------------- */

test('P0 回归：两个「放宽权限」开关的 affects 都必须为空', () => {
  for (const id of ['crossChatInGroup', 'chatLookForMembers']) {
    const f = FEATURES.find((x) => x.id === id);
    assert.deepEqual(f.affects, [], `${id} 默认 false，写 affects 会把 chat_look 对所有人收走`);
  }
});

test('P0 回归：真实 DEFAULTS 下 chat_look 不会被 forcedDeny 收走', () => {
  const forced = forcedDenyTools(DEFAULTS, {}, POOL);
  assert.ok(!forced.includes('chat_look'), `默认配置不该收 chat_look，实际 ${JSON.stringify(forced)}`);

  const owner = resolvePolicy({ pool: POOL, bucket: 'owner', store: defaultStore(), forceDeny: forced });
  assert.ok(owner.allow.includes('chat_look'), '主人默认要有 chat_look');

  const memberOff = resolvePolicy({ pool: POOL, bucket: 'member', store: defaultStore(), forceDeny: forced });
  assert.ok(memberOff.deny.includes('chat_look'), '开关关着时群友仍被收走');

  const memberOn = resolvePolicy({
    pool: POOL, bucket: 'member', store: defaultStore(),
    forceDeny: forced, forceAllow: ['chat_look'],
  });
  assert.ok(memberOn.allow.includes('chat_look'), '开关打开后群友才拿得到');
});

test('P0 回归：旧白名单路径在真实 DEFAULTS 下也不会被 forced 抵消', () => {
  const cfg = { ...DEFAULTS, chat: { ...DEFAULTS.chat, chatLookForMembers: true } };
  const forced = forcedDenyTools(cfg);
  assert.ok(guestKeepTools(cfg, 'member').includes('chat_look'));
  assert.ok(!forced.includes('chat_look'), '旧路径会把 forced 一起 deny，这里必须为空');
  assert.ok(!guestKeepTools(DEFAULTS, 'member').includes('chat_look'), '默认仍然关');
});
