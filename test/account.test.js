// 账号迁移：扫描 + 绑定的纯逻辑。
//
// 这一页最容易出的错不是崩，而是**静默漏键**：
// 某个旧 openid 明明有记忆，却没出现在待迁移列表里，用户永远看不到它，
// 换机器人之后那段记忆就再也没人认得。所以这里重点测「该出现的出现了」。
//
// 另一半是 `uinFromKey`：它必须和 roost `src/identity.js` 的判定完全一致，
// 否则会出现「这边说没绑定、那边说已绑定」的鬼打墙——列表里一直有它，
// 点绑定又报冲突。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAccount, uinFromKey, isValidUin } from '../src/account.js';

const OPENID = 'AAAA1111BBBB2222CCCC3333DDDD4444';

/** 造一个最小可用的 account，四个依赖都能单独喂 */
function make({ mem = [], jr = [], gr = [], sess = {}, api = null } = {}) {
  const calls = [];
  const acc = createAccount({
    memory: { scanKeys: () => mem },
    journal: { scanChats: () => jr },
    graph: { scanChats: () => gr },
    sessions: {
      entry: (k) => sess[k] || null,
    },
    setup: {
      api: async (path, init) => {
        calls.push({ path, init });
        if (!api) throw new Error('连不上');
        return api(path, init);
      },
    },
  });
  return { acc, calls };
}

/* ---------------- uinFromKey ---------------- */

test('uinFromKey：整串 32 位 hex 是 openid，不是号码', () => {
  assert.equal(uinFromKey(OPENID), '');
  assert.equal(uinFromKey('aaaa1111bbbb2222cccc3333dddd4444'), '', '小写同样要认');
});

test('uinFromKey：纯号码能认出来', () => {
  assert.equal(uinFromKey('10001'), '10001');
  assert.equal(uinFromKey('763366431'), '763366431');
  assert.equal(uinFromKey('  10001  '), '10001', '两头空白要吃掉');
});

test('uinFromKey：老键里的号码能抠出来（和 roost 的四种形态对齐）', () => {
  assert.equal(uinFromKey('aiocqhttp:GroupMessage:763366431'), '763366431');
  assert.equal(uinFromKey('group_763366431'), '763366431');
  assert.equal(uinFromKey('user-10001'), '10001');
  assert.equal(uinFromKey('aiocqhttp:FriendMessage:10001'), '10001');
  assert.equal(uinFromKey(12345), '12345', '数字进来也要认');
});

test('uinFromKey：号码后面跟 openid 的**故意**不认', () => {
  /**
   * 这条容易看反：`10001:<openid>` 里明明有号码，为什么返回空？
   *
   * 因为一旦命中 openid 段就说明这个键是「openid 为主」的形态，
   * 前面的数字多半是 `c2c` 这类标签而不是号码。往前猜错了会把
   * 一堆不相干的人绑到同一个号码下面。roost 那边就是这么定的，
   * 两边必须一致——不一致会出现「这边说没绑、那边说已绑」的鬼打墙。
   */
  assert.equal(uinFromKey(`10001:${OPENID}`), '');
  assert.equal(uinFromKey(`c2c:10001:${OPENID}`), '');
  assert.equal(uinFromKey(`group:${OPENID}`), '');
});

test('uinFromKey：空值 / 超长 / 乱码一律返回空', () => {
  assert.equal(uinFromKey(''), '');
  assert.equal(uinFromKey(null), '');
  assert.equal(uinFromKey(undefined), '');
  assert.equal(uinFromKey('abc'), '', '太短，不是号码');
  assert.equal(uinFromKey('1234'), '', '4 位不够');
  assert.equal(uinFromKey('x'.repeat(80)), '', '超长直接放弃');
});

test('isValidUin：和 uinFromKey 用同一套规则', () => {
  assert.equal(isValidUin('10001'), true);
  assert.equal(isValidUin('763366431'), true);
  assert.equal(isValidUin('01234'), false, '不能 0 开头');
  assert.equal(isValidUin('10001 '), true, 'trim 后合法');
  assert.equal(isValidUin(''), false);
});

/* ---------------- scan ---------------- */

test('扫描：三个来源合并成一个键，条数各归各的', async () => {
  const { acc } = make({
    mem: [{ chatId: OPENID, facts: 2 }],
    jr: [{ chatId: OPENID, journal: 37 }],
    gr: [{ chatId: OPENID, edges: 5, episodes: 9 }],
    api: () => ({ items: [{ query: { openid: OPENID }, bound: false }] }),
  });
  const r = await acc.scan();
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].facts, 2);
  assert.equal(r.items[0].journal, 37);
  assert.equal(r.items[0].edges, 5);
  assert.equal(r.items[0].episodes, 9);
  assert.equal(r.items[0].bound, null);
});

test('扫描：键里已有号码的不算待迁移（本来就对上了）', async () => {
  const { acc } = make({
    mem: [{ chatId: '10001', facts: 3 }, { chatId: OPENID, facts: 1 }],
    api: () => ({ items: [{ query: { openid: OPENID }, bound: false }] }),
  });
  const r = await acc.scan();
  assert.deepEqual(r.items.map((x) => x.key), [OPENID], '10001 这种键不该出现在列表里');
});

test('扫描：只有某一个来源有数据，另外两列是 null 而不是 0', async () => {
  /**
   * `null` 和 `0` 在界面上是两件事：`null` 渲染成「—」（这一路打不开），
   * `0` 渲染成「0」（确实没有）。混成 0 会让用户以为日记真的空了。
   */
  const { acc } = make({
    mem: [{ chatId: OPENID, facts: 4 }],
    api: () => ({ items: [{ query: { openid: OPENID }, bound: false }] }),
  });
  const r = await acc.scan();
  assert.equal(r.items[0].journal, null);
  assert.equal(r.items[0].edges, null);
});

test('扫描：有记忆的排在前面（没记忆的绑不绑都无所谓）', async () => {
  const A = 'AAAA1111BBBB2222CCCC3333DDDD4444';
  const B = 'BBBB2222CCCC3333DDDD4444EEEE5555';
  const { acc } = make({
    mem: [{ chatId: A, facts: 0 }],
    jr: [{ chatId: B, journal: 30 }],
    api: () => ({ items: [] }),
  });
  const r = await acc.scan();
  assert.deepEqual(r.items.map((x) => x.key), [B, A]);
});

test('扫描：类型从 sessions.json 来，没有就留空（不猜）', async () => {
  const A = 'AAAA1111BBBB2222CCCC3333DDDD4444';
  const B = 'BBBB2222CCCC3333DDDD4444EEEE5555';
  const { acc } = make({
    mem: [{ chatId: A, facts: 1 }, { chatId: B, facts: 1 }],
    sess: { [A]: { title: '倦飞之鸟', kind: 'c2c' } },
    api: () => ({ items: [] }),
  });
  const r = await acc.scan();
  const a = r.items.find((x) => x.key === A);
  const b = r.items.find((x) => x.key === B);
  assert.equal(a.kind, 'c2c');
  assert.equal(a.title, '倦飞之鸟');
  assert.equal(b.kind, '', '没有会话记录就留空，让用户选');
  assert.equal(b.title, '');
});

test('扫描：已绑过的带上 bound，界面据此挪到下半区', async () => {
  const { acc } = make({
    mem: [{ chatId: OPENID, facts: 1 }],
    api: () => ({
      items: [{ query: { openid: OPENID }, bound: true, kind: 'user', uin: '10001', identityId: 'u:10001' }],
    }),
  });
  const r = await acc.scan();
  assert.deepEqual(r.items[0].bound, { kind: 'user', uin: '10001', identityId: 'u:10001' });
});

test('扫描：roost 连不上时仍然返回列表，只是 roost.ok=false', async () => {
  const { acc } = make({
    mem: [{ chatId: OPENID, facts: 1 }],
    api: null, // 抛「连不上」
  });
  const r = await acc.scan();
  assert.equal(r.ok, true, '扫描本身不能失败');
  assert.equal(r.roost.ok, false);
  assert.match(r.roost.error, /连不上/);
  assert.equal(r.items.length, 1, '上半区照样要能看');
  assert.equal(r.items[0].bound, null);
});

test('扫描：roost 版本太旧（404）要说人话，不是抛 HTTP 404', async () => {
  const { acc } = make({
    mem: [{ chatId: OPENID, facts: 1 }],
    api: () => {
      const e = new Error('HTTP 404');
      e.status = 404;
      throw e;
    },
  });
  const r = await acc.scan();
  assert.match(r.roost.error, /版本太旧/);
});

test('扫描：空库返回空列表，不炸', async () => {
  const { acc } = make({ api: () => ({ items: [] }) });
  const r = await acc.scan();
  assert.deepEqual(r.items, []);
  assert.equal(r.ok, true);
});

test('扫描：memory/journal/graph 里任一个抛异常，其余照常', async () => {
  const acc = createAccount({
    memory: { scanKeys: () => [{ chatId: OPENID, facts: 2 }] },
    journal: { scanChats: () => { throw new Error('sqlite 打不开'); } },
    graph: { scanChats: () => [{ chatId: OPENID, edges: 1, episodes: 0 }] },
    sessions: { entry: () => null },
    setup: { api: async () => ({ items: [] }) },
  });
  const r = await acc.scan();
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].facts, 2);
  assert.equal(r.items[0].journal, null, '坏掉的那一路是 null');
  assert.equal(r.items[0].edges, 1, '好的那一路照样有数');
});

test('扫描：反查是批量分片（不能一次塞 2000 条给 roost）', async () => {
  const keys = Array.from({ length: 1200 }, (_, i) => `${String(i).padStart(4, '0')}${'A'.repeat(28)}`);
  let maxChunk = 0;
  const acc = createAccount({
    memory: { scanKeys: () => keys.map((chatId) => ({ chatId, facts: 1 })) },
    journal: { scanChats: () => [] },
    graph: { scanChats: () => [] },
    sessions: { entry: () => null },
    setup: {
      api: async (path, init) => {
        const body = JSON.parse(init.body);
        maxChunk = Math.max(maxChunk, body.items.length);
        return { items: body.items.map((it) => ({ query: it, bound: false })) };
      },
    },
  });
  await acc.scan();
  assert.ok(maxChunk <= 500, `每片不能超过 500，实际 ${maxChunk}`);
});

/* ---------------- bind ---------------- */

test('绑定：号码不合法就地拦掉，不打 roost', async () => {
  const { acc, calls } = make({ api: () => ({ ok: true }) });
  const r = await acc.bind({ kind: 'user', uin: '01234', openid: OPENID });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID');
  assert.equal(calls.length, 0, '不该发出请求');
});

test('绑定：缺 openid 就地拦掉', async () => {
  const { acc, calls } = make({ api: () => ({ ok: true }) });
  const r = await acc.bind({ kind: 'group', uin: '763366431', openid: '' });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('绑定：类型必须显式给，缺省/乱写一律拒（不能静默当人）', async () => {
  /**
   * 以前是 `kind === 'group' ? 'group' : 'user'`——缺省就静默当人。
   * 面板拦住了，但 `/account/bind` 是公开路由，直接 POST 就能绕过去。
   * 猜错的代价是把群记忆绑到 QQ号 下面，界面完全看不出来。
   */
  for (const bad of ['', undefined, 'GROUP', 'c2c_typo', '人']) {
    const { acc, calls } = make({ api: () => ({ ok: true }) });
    const r = await acc.bind({ kind: bad, uin: '10001', openid: OPENID });
    assert.equal(r.ok, false, `kind=${JSON.stringify(bad)} 不该通过`);
    assert.equal(r.code, 'INVALID');
    assert.equal(calls.length, 0, '不该发出请求');
  }
});

test('绑定：group / user / c2c 三种写法都认', async () => {
  for (const [input, want] of [['group', 'group'], ['user', 'user'], ['c2c', 'user']]) {
    const { acc, calls } = make({ api: () => ({ ok: true, uin: '10001' }) });
    const r = await acc.bind({ kind: input, uin: '10001', openid: OPENID });
    assert.equal(r.ok, true, `kind=${input} 应该通过`);
    assert.equal(JSON.parse(calls[0].init.body).kind, want, `kind=${input} 应映射成 ${want}`);
  }
});

test('绑定：409 要带回 owner，界面才能问「从谁改绑到谁」', async () => {
  const { acc } = make({
    api: () => {
      const e = new Error('这个 openid 已经绑到 QQ号 10002 了');
      e.status = 409;
      e.body = { code: 'CONFLICT', owner: '10002' };
      throw e;
    },
  });
  const r = await acc.bind({ kind: 'user', uin: '10001', openid: OPENID });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.equal(r.owner, '10002');
});

test('绑定：500 之类的普通失败不能被当成冲突（否则界面会问要不要改绑）', async () => {
  const { acc } = make({
    api: () => {
      const e = new Error('boom');
      e.status = 500;
      throw e;
    },
  });
  const r = await acc.bind({ kind: 'user', uin: '10001', openid: OPENID });
  assert.equal(r.code, 'ERROR');
});

test('绑定：force 会原样带给 roost', async () => {
  const { acc, calls } = make({ api: () => ({ ok: true, uin: '10001' }) });
  await acc.bind({ kind: 'user', uin: '10001', openid: OPENID, force: true });
  assert.equal(JSON.parse(calls[0].init.body).force, true);
});

test('绑定：botId 会带上（换机器人时要记到对的鸟名下）', async () => {
  const { acc, calls } = make({ api: () => ({ ok: true, uin: '10001' }) });
  await acc.bind({ kind: 'user', uin: '10001', openid: OPENID, botId: 'jfzn' });
  assert.equal(JSON.parse(calls[0].init.body).botId, 'jfzn');
});

/* ---------------- boundList / bots ---------------- */

test('已绑定：代理 roost 的 /api/identity，连不上就空表 + 原因', async () => {
  const { acc } = make({ api: null });
  const r = await acc.boundList();
  assert.equal(r.ok, false);
  assert.deepEqual(r.users, []);
  assert.match(r.error, /连不上/);
});

test('机器人：代理 /api/bots', async () => {
  const { acc, calls } = make({ api: () => ({ bots: [{ id: 'main' }], current: 'main' }) });
  const r = await acc.bots();
  assert.equal(r.ok, true);
  assert.equal(r.current, 'main');
  assert.equal(calls[0].path, '/api/bots');
});

/* ---------------- 批量追加 / 群成员 / 昵称候选 ---------------- */

const OTHER = 'CCCC3333DDDD4444EEEE5555FFFF6666';
const THIRD = 'DDDD4444EEEE5555FFFF6666AAAA7777';

function makeExtras({ identity = {}, bindResults = null } = {}) {
  const calls = [];
  let binds = 0;
  const acc = createAccount({
    memory: { scanKeys: () => [{ chatId: OPENID, facts: 2 }, { chatId: OTHER, facts: 1 }] },
    journal: { scanChats: () => [] },
    graph: { scanChats: () => [] },
    sessions: { entry: () => null },
    setup: {
      api: async (path, init) => {
        calls.push({ path, init });
        if (path.startsWith('/api/identity?')) return identity;
        if (path === '/api/identity/resolve') return { items: [] };
        if (path === '/api/identity/bind') {
          const hit = Array.isArray(bindResults) ? bindResults[binds++] : null;
          if (hit?.fail) {
            const e = new Error(hit.error || '冲突');
            e.status = 409;
            e.body = { code: 'CONFLICT', owner: hit.owner || '' };
            throw e;
          }
          return { ok: true, uin: '10001' };
        }
        return {};
      },
    },
  });
  return { acc, calls };
}

test('群成员：代理 roost 的未识别用户，字段映射正确', async () => {
  const { acc, calls } = makeExtras({
    identity: {
      users: [], groups: [], bot: 'main', botName: '主鸟',
      unresolved: {
        users: [{ userId: OPENID, name: '小明', chatId: 'g1', scope: 'group', lastSeen: 123 }],
        groups: [{ groupOpenid: OTHER, name: '栖·开发群' }],
      },
    },
  });
  const r = await acc.people();
  assert.equal(r.ok, true);
  assert.equal(r.users.length, 1);
  assert.equal(r.users[0].openid, OPENID);
  assert.equal(r.users[0].name, '小明');
  assert.equal(r.groups[0].name, '栖·开发群');
  assert.equal(r.bot, 'main');
  assert.ok(calls[0].path.startsWith('/api/identity?'));
});

test('群成员：roost 连不上时给原因，不白屏', async () => {
  const acc = createAccount({
    setup: { api: async () => { throw new Error('fetch failed'); } },
  });
  const r = await acc.people();
  assert.equal(r.ok, false);
  assert.match(r.error, /连不上 Roost/);
  assert.deepEqual(r.users, []);
});

test('批量追加：成功和失败分开报，不影响其它条', async () => {
  const { acc, calls } = makeExtras({
    bindResults: [{}, { fail: true, error: '已经绑到 20002 了', owner: '20002' }, {}],
  });
  const r = await acc.batchAttach({
    kind: 'user', uin: '10001', openids: [OPENID, OTHER, THIRD, OPENID, ''],
  });
  assert.equal(r.ok, true);
  assert.equal(r.done.length, 2, '去重后三个有效键，两条成功');
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].owner, '20002', '冲突的 owner 要带回去，界面才能问要不要改绑');
  assert.equal(calls.filter((c) => c.path === '/api/identity/bind').length, 3, '空串和重复不该发请求');
});

test('批量追加：没勾任何 openid 直接拒', async () => {
  const { acc, calls } = makeExtras();
  const r = await acc.batchAttach({ kind: 'user', uin: '10001', openids: [] });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('昵称候选：只提示，绝不自动绑定', async () => {
  const { acc, calls } = makeExtras({
    identity: {
      users: [{ uin: '10001', name: '小明', claims: [] }],
      groups: [{ groupUin: '763366431', name: '栖·开发群', claims: [] }],
      unresolved: { users: [{ userId: OPENID, name: '小明' }], groups: [] },
    },
  });
  const r = await acc.suggest();
  assert.equal(r.ok, true);
  assert.match(r.note, /必须人工确认/);
  const hit = r.items.find((x) => x.key === OPENID);
  assert.ok(hit, '同名应该给出候选');
  assert.ok(hit.candidates.some((c) => c.uin === '10001'));
  assert.equal(calls.some((c) => c.path === '/api/identity/bind'), false, '候选人绝不自动提交绑定');
});

test('昵称候选：会话标题里的「QQ · 」前缀要归一化', async () => {
  const acc = createAccount({
    memory: { scanKeys: () => [{ chatId: OPENID, facts: 1 }] },
    journal: { scanChats: () => [] },
    graph: { scanChats: () => [] },
    sessions: { entry: (k) => (k === OPENID ? { title: 'QQ · 小明', kind: 'c2c' } : null) },
    setup: {
      api: async (path) => {
        if (path.startsWith('/api/identity?')) {
          return { users: [{ uin: '10001', name: '小明', claims: [] }], groups: [], unresolved: { users: [], groups: [] } };
        }
        if (path === '/api/identity/resolve') return { items: [] };
        return {};
      },
    },
  });
  const r = await acc.suggest();
  assert.ok(r.items.some((x) => x.key === OPENID && x.candidates.some((c) => c.uin === '10001')));
});

test('群成员：roost 返回格式不对时兜成空表，不能报成「连不上」', async () => {
  /**
   * 以前 `(r?.unresolved?.users ?? []).map(...)` 在 users 是字符串、
   * 或数组里混了 null 时抛 TypeError，被外层 catch 成
   * 「连不上 Roost：...map is not a function」——roost 明明活得好好的。
   */
  const bads = [
    'oops',
    { unresolved: { users: 'oops' } },
    { unresolved: { users: [null, 42, { userId: OPENID, name: '小明' }] } },
    {},
  ];
  for (const bad of bads) {
    const { acc } = makeExtras({ identity: bad });
    // eslint-disable-next-line no-await-in-loop
    const r = await acc.people();
    assert.equal(r.ok, true, `不该报错：${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(r.users));
    assert.ok(Array.isArray(r.groups));
    assert.ok(r.users.every((u) => u.openid), '没有 openid 的条目要滤掉');
  }
});

test('昵称候选：私聊键不会给出群号候选（类型已知时必须过滤，不只是排序）', async () => {
  const acc = createAccount({
    memory: { scanKeys: () => [{ chatId: OPENID, facts: 1 }] },
    journal: { scanChats: () => [] },
    graph: { scanChats: () => [] },
    /** 会话记录说这是私聊 */
    sessions: { entry: (k) => (k === OPENID ? { title: '栖·开发群', kind: 'c2c' } : null) },
    setup: {
      api: async (path) => {
        if (path.startsWith('/api/identity?')) {
          return {
            users: [],
            groups: [{ groupUin: '763366431', name: '栖·开发群', claims: [] }],
            unresolved: { users: [], groups: [] },
          };
        }
        if (path === '/api/identity/resolve') return { items: [] };
        return {};
      },
    },
  });
  const r = await acc.suggest();
  assert.equal(r.ok, true);
  assert.equal(
    r.items.some((x) => x.key === OPENID && x.candidates.some((c) => c.kind === 'group')),
    false,
    '私聊会话不该被建议绑成群号',
  );
});
