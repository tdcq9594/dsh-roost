// 4.5 人格隔离：归属策略 + store 层键映射。
//
// 重点钉住三件最容易「以为生效其实没生效」的事：
//   1. 关闭隔离时参数逐字不变（升级前后行为一致）
//   2. 开启后写入走物理键、读取按策略带旧键，账号别名一个不丢
//   3. 没选归属策略时不许开（把选择权留给使用者）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEGACY_POLICIES, SCOPE_JOIN,
  scopeKey, unscopeKey, legacyKeysFor, createOwnership, createPersonaScope,
} from '../src/persona-scope.js';

const CHAT = 'AAAA1111BBBB2222CCCC3333DDDD4444';

/** 造一个记录所有调用参数的假 store，方法签名与真实模块一致 */
function fakeStore(names) {
  const calls = [];
  const store = {};
  for (const n of names) store[n] = (...args) => { calls.push({ n, args }); return { ok: true, args }; };
  return { store, calls };
}

function scope({ enabled = true, policy = 'shared', owner = '', byChat = {}, personaId = 'default' } = {}) {
  return createPersonaScope({
    cfgOf: () => ({ persona: { scope: { enabled } } }),
    personaOf: () => personaId,
    ownership: { get: () => ({ policy, owner, byChat, marks: {} }), save: () => ({ ok: true }) },
  });
}

test('物理键：关闭时原样、开启时加人格后缀、可还原', () => {
  assert.equal(scopeKey(CHAT, 'default', false), CHAT);
  assert.equal(scopeKey(CHAT, '', true), CHAT, '没认出人格时不该乱分键');
  const k = scopeKey(CHAT, 'lazycat', true);
  assert.equal(k, CHAT + SCOPE_JOIN + 'lazycat');
  assert.equal(scopeKey(k, 'other', true), k, '已经是物理键不能再套一层');
  assert.equal(unscopeKey(k), CHAT);
  assert.equal(unscopeKey(CHAT), CHAT);
});

test('归属策略：A 全可见 / B 只有指定人格 / C 按会话 / 没选一律不放行', () => {
  const base = { chatId: CHAT, personaId: 'lazycat', enabled: true };
  assert.deepEqual(legacyKeysFor({ ...base, policy: 'shared' }), [CHAT]);
  assert.deepEqual(legacyKeysFor({ ...base, policy: 'owner', owner: 'lazycat' }), [CHAT]);
  assert.deepEqual(legacyKeysFor({ ...base, policy: 'owner', owner: 'default' }), []);
  assert.deepEqual(legacyKeysFor({ ...base, policy: 'perChat', byChat: { [CHAT]: 'lazycat' } }), [CHAT]);
  assert.deepEqual(legacyKeysFor({ ...base, policy: 'perChat', byChat: { [CHAT]: 'default' } }), []);
  assert.deepEqual(legacyKeysFor({ ...base, policy: '' }), [], '没选策略不能默认共享');
  assert.deepEqual(legacyKeysFor({ ...base, policy: 'shared', enabled: false }), []);
  assert.deepEqual(LEGACY_POLICIES, ['shared', 'owner', 'perChat']);
});

test('没选归属策略时，就算开了开关也不启用（选择权不代劳）', () => {
  const s = scope({ enabled: true, policy: '' });
  assert.equal(s.state().wanted, true);
  assert.equal(s.state().enabled, false, '没选策略不许生效');
  assert.equal(s.scopeKey(CHAT), CHAT);
});

test('包装：关闭隔离时参数逐字透传，一个字段都不改', () => {
  const s = scope({ enabled: false });
  const { store, calls } = fakeStore(['list', 'add', 'recent', 'nowEdges', 'get', 'set']);
  const m = s.wrapMemory(store);
  const j = s.wrapJournal(store);
  const g = s.wrapGraph(store);
  const ss = s.wrapSessions(store);
  m.list(CHAT, ['10001', 'OLDOPENID']);
  m.add(CHAT, '主人住在杭州', 'global', {});
  j.recent(CHAT, 10, 'chat', ['10001']);
  g.nowEdges({ chatId: CHAT, limit: 20, aliases: ['10001'] });
  ss.set(CHAT, 's1', { title: '倦飞之鸟' });
  assert.equal(calls.length, 5);
  assert.equal(calls[0].args[0], CHAT);
  assert.deepEqual(calls[0].args[1], ['10001', 'OLDOPENID']);
  assert.equal(calls[1].args[0], CHAT);
  assert.equal(calls[2].args[0], CHAT);
  assert.equal(calls[3].args[0].chatId, CHAT);
  assert.equal(calls[4].args[0], CHAT);
});

test('包装：开启 A 共享后写入走物理键，读取带旧键且账号别名不丢', () => {
  const s = scope({ enabled: true, policy: 'shared', personaId: 'lazycat' });
  const { store, calls } = fakeStore(['list', 'add', 'hasAuthz', 'recent', 'nowEdges', 'addEdge', 'get']);
  const m = s.wrapMemory(store);
  const j = s.wrapJournal(store);
  const g = s.wrapGraph(store);
  const ss = s.wrapSessions(store);
  const phys = CHAT + SCOPE_JOIN + 'lazycat';

  m.list(CHAT, ['10001', 'OLDOPENID']);
  assert.equal(calls[0].args[0], phys, '读取主键要是物理键');
  assert.deepEqual(calls[0].args[1], ['10001', 'OLDOPENID', CHAT], '账号别名保留，共享旧键追加在后面');

  m.add(CHAT, '主人怕花生', 'global', {});
  assert.equal(calls[1].args[0], phys, '新事实只写当前人格');
  m.hasAuthz(CHAT, 'group_push', ['10001']);
  assert.equal(calls[2].args[0], phys);
  assert.deepEqual(calls[2].args[2], ['10001', CHAT], 'hasAuthz 的别名在第 3 个参数，不能塞错位置');

  j.recent(CHAT, 10, 'chat', ['10001']);
  assert.equal(calls[3].args[0], phys);
  assert.deepEqual(calls[3].args[3], ['10001', CHAT]);
  j.add({ chatId: CHAT, text: '今天聊了搬家' });
  assert.equal(calls[4].args[0].chatId, phys, 'journal.add 是对象参数，也要换');

  g.nowEdges({ chatId: CHAT, limit: 20, aliases: ['10001'] });
  assert.equal(calls[5].args[0].chatId, phys);
  assert.deepEqual(calls[5].args[0].aliases, ['10001', CHAT]);
  g.addEdge({ src: '阿岚', dst: '猫', rel: '喜欢', chatId: CHAT });
  assert.equal(calls[6].args[0].chatId, phys);

  ss.get(CHAT);
  assert.equal(calls[7].args[0], phys, '会话键也要分人格');
});

test('包装：B 模式下非归属人格完全读不到旧记忆，但仍保留账号别名', () => {
  const s = scope({ enabled: true, policy: 'owner', owner: 'default', personaId: 'lazycat' });
  const { store, calls } = fakeStore(['list']);
  s.wrapMemory(store).list(CHAT, ['10001']);
  assert.equal(calls[0].args[0], CHAT + SCOPE_JOIN + 'lazycat');
  assert.deepEqual(calls[0].args[1], ['10001'], '旧键不放行，账号别名照留');

  const owner = scope({ enabled: true, policy: 'owner', owner: 'lazycat', personaId: 'lazycat' });
  const b = fakeStore(['list']);
  owner.wrapMemory(b.store).list(CHAT, ['10001']);
  assert.deepEqual(b.calls[0].args[1], ['10001', CHAT], '归属人格读得到旧记忆');
});

test('包装：删除只删当前人格的键，不跨到共享键', () => {
  const s = scope({ enabled: true, policy: 'shared', personaId: 'lazycat' });
  const { store, calls } = fakeStore(['remove', 'clearChat']);
  const m = s.wrapMemory(store);
  m.remove(CHAT, '花生', ['10001']);
  assert.equal(calls[0].args[0], CHAT + SCOPE_JOIN + 'lazycat');
  assert.deepEqual(calls[0].args[2], ['10001'], '不追加共享键，删不掉别人的记忆');
  m.clearChat(CHAT, ['10001']);
  assert.deepEqual(calls[1].args[1], ['10001']);
});

test('归属账本：落盘可回读、非法策略不入库、可整份覆盖改主意', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ownership-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'persona-ownership.json');
  const a = createOwnership({ file });
  assert.deepEqual(a.get().policy, '');
  assert.equal(a.save({ policy: '乱写' }).policy, '', '非法策略不入库');
  assert.equal(a.save({ policy: 'perChat', byChat: { [CHAT]: 'lazycat' }, owner: 'lazycat' }).ok, true);
  assert.ok(existsSync(file));
  const b = createOwnership({ file });
  assert.equal(b.get().policy, 'perChat');
  assert.equal(b.get().byChat[CHAT], 'lazycat');
  /** 改主意：换策略不需要 rekey，旧数据一个字节没动 */
  assert.equal(b.save({ policy: 'shared' }).ok, true);
  assert.equal(createOwnership({ file }).get().policy, 'shared');
  assert.equal(createOwnership({ file }).get().byChat[CHAT], 'lazycat', '没传的段保留');
});

/** 路由层：真的把 host 跑起来，验证「没选策略不许开」这条硬约束 */
globalThis.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
const noop = () => () => {};

async function bootHost() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-scope-host-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({}), 'utf8');
  process.env.DSH_ROOST_DATA = dir;
  const routes = new Map();
  const fakeCtx = {
    agents: { get: () => null, create: async () => ({ id: 'a1', ctx: { systemPrompt: { context: noop }, tools: {} } }), list: () => [] },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's1' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect: (cb, label) => {
      if (String(label).includes('收消息服务')) return noop;
      const off = cb();
      return typeof off === 'function' ? off : noop;
    },
    on: () => noop,
  };
  const url = new URL('../src/host.js', import.meta.url);
  url.searchParams.set('t', String(Date.now()) + Math.random());
  const host = await import(url.href);
  const off = host.apply(fakeCtx);
  const call = async (path, { method = 'GET', body = null } = {}) => {
    const handler = routes.get('/roost/api' + path.split('?')[0]);
    if (!handler) throw new Error(`路由没注册：${path}`);
    let out = '';
    const res = { statusCode: 0, setHeader() {}, end(v) { out = v; } };
    const req = {
      url: path, method,
      headers: { host: '127.0.0.1:17321', 'sec-fetch-site': 'same-origin' },
      [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); },
    };
    await handler(req, res);
    return { status: res.statusCode, json: out ? JSON.parse(out) : null };
  };
  return { call, off, routes };
}

test('路由：/persona/scope 默认关、三个策略都列出来，代码不代选', async () => {
  const { call, off, routes } = await bootHost();
  assert.ok(routes.has('/roost/api/persona/scope'));
  assert.ok(routes.has('/roost/api/persona/scope/save'));
  const r = await call('/persona/scope');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false, '默认必须关');
  assert.equal(r.json.policy, '', '不能由代码代选一个策略');
  assert.deepEqual(r.json.policies.map((x) => x.id), ['shared', 'owner', 'perChat']);
  off?.();
});

test('路由：没选策略 / 选了 B 却没指定人格，都不许开启', async () => {
  const { call, off } = await bootHost();
  const a = await call('/persona/scope/save', { method: 'POST', body: { enabled: true, policy: '' } });
  assert.equal(a.status, 400);
  assert.equal(a.json.ok, false);
  assert.match(a.json.message, /先选一个/);

  const b = await call('/persona/scope/save', { method: 'POST', body: { enabled: true, policy: 'owner', owner: '' } });
  assert.equal(b.status, 400);
  assert.match(b.json.message, /指定是哪个人格/);
  off?.();
});

test('路由：选了 A 才真的开启；关掉开关即回退，不删任何数据', async () => {
  const { call, off } = await bootHost();
  const on = await call('/persona/scope/save', { method: 'POST', body: { enabled: true, policy: 'shared' } });
  assert.equal(on.json.ok, true);
  assert.equal(on.json.enabled, true);
  const st = await call('/persona/scope');
  assert.equal(st.json.enabled, true);
  assert.equal(st.json.policy, 'shared');
  const offState = await call('/persona/scope/save', { method: 'POST', body: { enabled: false, policy: 'shared' } });
  assert.equal(offState.json.enabled, false, '关掉就回到原来的行为');
  off?.();
});


/** 对抗性测试后补：PLAN 里的方法名必须在真实 store 上存在，不许再写想象中的名字 */
test('规则表对照真实 store：没有凭空的方法名', async () => {
  const { PLAN } = await import('../src/persona-scope.js');
  const { createMemory } = await import('../src/memory.js');
  const { createSessions } = await import('../src/sessions.js');
  const { createJournal } = await import('../src/journal.js');
  const { createGraph } = await import('../src/graph.js');
  const dir = mkdtempSync(join(tmpdir(), 'roost-plan-real-'));
  mkdirSync(dir, { recursive: true });
  const stores = {
    memory: createMemory(),
    journal: createJournal({ file: join(dir, 'journal.sqlite'), log: () => {} }),
    graph: createGraph({ file: join(dir, 'graph.sqlite'), log: () => {} }),
    sessions: createSessions({ dataDir: dir, log: () => {} }),
  };
  for (const [kind, rules] of Object.entries(PLAN)) {
    const missing = Object.keys(rules).filter((n) => typeof stores[kind]?.[n] !== 'function');
    assert.deepEqual(missing, [], `${kind} 的规则表里有真实 store 不存在的方法：${missing.join('、')}`);
  }
  try { stores.journal.close?.(); stores.graph.close?.(); } catch {}
});

test('漏网方法补全：search / forget / top / recentTimeline / endedEdges 都要物理化 + 带旧键', () => {
  const s = scope({ enabled: true, policy: 'shared', personaId: 'lazycat' });
  const names = ['recentTimeline', 'top', 'search', 'forget', 'invalidated',
    'endedEdges', 'text', 'suppressed', 'hasActive', 'linkedJournalIds',
    'add', 'addEdge', 'suppressEdge', 'addEpisode'];
  const { store, calls } = fakeStore(names);
  const phys = CHAT + SCOPE_JOIN + 'lazycat';
  const wrapped = s.wrapJournal(store);
  const g = s.wrapGraph(store);
  /** 共用同一个 fakeStore，分开调用后按调用序号核对 */
  wrapped.recentTimeline(CHAT, { limit: 20, aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[0].args[0], phys, 'recentTimeline 的第一个参数是 chatId 字符串，不能漏');
  assert.deepEqual(calls[0].args[1].aliases, ['ACCOUNT_ALIAS', CHAT]);

  wrapped.top(CHAT, { limit: 6, aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[1].args[0], phys, 'top 同上');
  assert.deepEqual(calls[1].args[1].aliases, ['ACCOUNT_ALIAS', CHAT]);

  wrapped.search('花生', { chatId: CHAT, limit: 10, aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[2].args[1].chatId, phys);
  assert.deepEqual(calls[2].args[1].aliases, ['ACCOUNT_ALIAS', CHAT]);

  wrapped.forget({ chatId: CHAT, word: '花生', aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[3].args[0].chatId, phys);
  assert.deepEqual(calls[3].args[0].aliases, ['ACCOUNT_ALIAS'], '删除类不跨共享键');

  wrapped.add({ chatId: CHAT, text: '今天聊了搬家' });
  assert.equal(calls[4].args[0].chatId, phys, '日记写入必须落物理键（第一版漏的就是这条）');

  g.endedEdges({ chatId: CHAT, limit: 20, aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[5].args[0].chatId, phys);
  assert.deepEqual(calls[5].args[0].aliases, ['ACCOUNT_ALIAS', CHAT]);

  g.hasActive('阿岚', '喜欢', { chatId: CHAT, aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[6].args[2].chatId, phys, 'hasActive 的对象参数在第 3 位');

  g.linkedJournalIds('阿岚', { chatId: CHAT, aliases: ['ACCOUNT_ALIAS'] });
  assert.equal(calls[7].args[1].chatId, phys);

  g.addEdge({ src: '阿岚', dst: '猫', rel: '喜欢', chatId: CHAT });
  assert.equal(calls[8].args[0].chatId, phys);
});

test('人格按 chatId 查表：并发两轮不串味，后台 chatId 自动落共享键', () => {
  const byChat = new Map([['g1', 'pA'], ['g2', 'pB']]);
  const s = createPersonaScope({
    cfgOf: () => ({ persona: { scope: { enabled: true } } }),
    personaOf: (id) => byChat.get(String(id)) || '',
    ownership: { get: () => ({ policy: 'shared', owner: '', byChat: {}, marks: {} }), save: () => ({ ok: true }) },
  });
  const { store, calls } = fakeStore(['list']);
  const m = s.wrapMemory(store);
  m.list('g1', []);
  m.list('g2', []);
  m.list('consolidate', []);
  assert.equal(calls[0].args[0], 'g1::p:pA');
  assert.equal(calls[1].args[0], 'g2::p:pB', '不能把 B 群写成 A 群的人格');
  assert.equal(calls[2].args[0], 'consolidate', '后台会话不在映射里 → 共享键');
});

test('B 模式没指定 owner：就算账本被手工写坏也不生效（第二道闸）', () => {
  const s = createPersonaScope({
    cfgOf: () => ({ persona: { scope: { enabled: true } } }),
    personaOf: () => 'lazycat',
    ownership: { get: () => ({ policy: 'owner', owner: '', byChat: {}, marks: {} }), save: () => ({ ok: true }) },
  });
  assert.equal(s.state().enabled, false, 'owner 为空不能让旧记忆整体消失');
});


test('账号迁移扫描：物理键还原合并，面板不出现 ::p: 内部记号', async () => {
  const { createAccount } = await import('../src/account.js');
  const acct = createAccount({
    memory: { scanKeys: () => [
      { chatId: 'AAA::p:lazycat', facts: 3 },
      { chatId: 'AAA::p:other', facts: 5 },
      { chatId: 'AAA', facts: 2 },
      { chatId: 'BBB', facts: 1 },
    ] },
    journal: { scanChats: () => [{ chatId: 'AAA::p:lazycat', journal: 7 }] },
    graph: { scanChats: () => [{ chatId: 'AAA::p:other', edges: 2, episodes: 1 }] },
    sessions: { entry: () => null },
  });
  const r = await acct.scan();
  assert.equal(r.items.some((x) => String(x.key).includes('::p:')), false, '不能把物理键吐给面板');
  const aaa = r.items.find((x) => x.key === 'AAA');
  assert.ok(aaa, '三个物理/逻辑键应合并成一条');
  assert.equal(aaa.facts, 5, '合并取最大值，不能把共享记忆重复相加');
  assert.equal(aaa.journal, 7);
  assert.equal(aaa.edges, 2);
  assert.equal(r.items.length, 2, 'AAA 与 BBB 两条');
});

test('一键改写计划：物理键计数能被 openid 查到（不再恒为 0）', async () => {
  const { createRewriter } = await import('../src/rewrite.js');
  const prev = process.env.DSH_ROOST_DATA;
  const dir = mkdtempSync(join(tmpdir(), 'roost-rewrite-scope-'));
  mkdirSync(dir, { recursive: true });
  process.env.DSH_ROOST_DATA = dir;
  try {
    const rw = createRewriter({
      memory: { scanKeys: () => [{ chatId: 'AAA::p:lazycat', facts: 4 }, { chatId: 'AAA::p:other', facts: 2 }] },
      journal: { scanChats: () => [{ chatId: 'AAA::p:lazycat', journal: 9 }] },
      graph: { scanChats: () => [{ chatId: 'AAA::p:other', edges: 3, episodes: 1 }] },
      sessions: { entry: () => null },
      boundList: async () => ({ ok: true, users: [{ uin: '10001', claims: [{ openid: 'AAA', state: 'active' }] }], groups: [] }),
      backupRoot: join(dir, 'backups'),
    });
    const plan = await rw.plan({ uins: ['10001'] });
    assert.equal(plan.ok, true);
    const row = plan.items[0].keys[0];
    assert.equal(row.key, 'AAA');
    assert.equal(row.facts, 4, '取最大，不重复计数');
    assert.equal(row.journal, 9);
    assert.equal(row.edges, 3);
  } finally {
    if (prev === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = prev;
  }
});
