/**
 * 能力策略的测试。
 *
 * 盯的是三件**会静默出错**的事：
 *  1. deny 里出现 pool 之外的名字 → `tools.restrict` 整批拒绝，限制从来没生效（0.10.10 事故重演）。
 *  2. 钉住项被用户配置抹掉 → 机器人变哑巴或失忆，而不是报错。
 *  3. `seen` 第一次生成时把所有工具当成「新增」→ 一升级就弹「新增 34 个能力」。
 *
 * 跑法：node --test test/capabilities.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultStore,
  normalizeStore,
  matchPattern,
  expandAllow,
  accumulateAllow,
  resolvePolicy,
  diffSeen,
  touchSeen,
  dangerOf,
  PINNED_KEEP,
} from '../src/capabilities.js';

/** 一份贴近真实的 pool：包含 preset 工具、宿主插件工具、MCP、自有工具 */
const POOL = [
  'edit',
  'read',
  'write',
  'pwsh',
  'memory_search',
  'memory_note',
  'qq_send',
  'qq_close',
  'sticker_pick',
  'gh_repo',
  'gh_search',
  'pr_create',
  'ops_bash',
  'ops_read_files',
  'mcp__graphflow__gf_read',
  'mcp__graphflow__gf_exec',
];

test('matchPattern：`*` 必须跨下划线，否则 mcp__*__*_exec 永远不生效', () => {
  assert.equal(matchPattern('mcp__graphflow__gf_exec', 'mcp__*__*_exec'), true);
  assert.equal(matchPattern('gh_repo', 'gh_*'), true);
  assert.equal(matchPattern('gh_repo', 'pr_*'), false);
  assert.equal(matchPattern('edit', 'edit'), true);
  assert.equal(matchPattern('edit', '*'), true);
  assert.equal(matchPattern('editx', 'edit'), false);
});

test('expandAllow：`*` 展开成整个 pool，不吞掉 pool 之外的东西', () => {
  const r = expandAllow(['*'], POOL);
  assert.equal(r.allow.size, POOL.length);
  for (const n of POOL) assert.ok(r.allow.has(n), n);
});

test('expandAllow：group: 分组按 match 展开；不存在的组要 warn 而不是静默', () => {
  const store = defaultStore();
  const r = expandAllow(['group:github'], POOL, store.groups);
  assert.deepEqual([...r.allow].sort(), ['gh_repo', 'gh_search', 'pr_create']);

  const bad = expandAllow(['group:nope'], POOL, store.groups);
  assert.equal(bad.allow.size, 0);
  assert.match(bad.warnings.join(), /nope/);
});

test('resolvePolicy：member 档白名单之外一律 deny，且 deny 全部来自 pool', () => {
  const r = resolvePolicy({ pool: POOL, bucket: 'member', store: defaultStore() });
  assert.equal(r.ok, true);

  const allowSet = new Set(r.allow);
  for (const n of POOL) {
    assert.equal(!allowSet.has(n), r.deny.includes(n), `${n} 的归属不一致`);
  }
  // 核心不变量：deny 里绝不允许出现 pool 没有的名字
  for (const n of r.deny) assert.ok(POOL.includes(n), `deny 里混进了 pool 外的 ${n}`);
});

test('resolvePolicy：只说不出话的那两个是硬钉，删不掉', () => {
  /**
   * `PINNED_KEEP` 只留 `qq_send` / `qq_close`。
   *
   * 以前 `memory_search` / `memory_note` 也在这张表里，后果是**档位的 deny 永远无效**：
   * 无论怎么配，「不让助手翻记忆」都会被钉回来，页面上还看不出区别。
   *
   * 判据改成「没了它是不是完全说不出话」：记忆没了只是不记得你，那是用户的选择。
   */
  const store = defaultStore();
  store.defaults.member.allow = ['qq_send']; // 故意不写记忆
  const r = resolvePolicy({ pool: POOL, bucket: 'member', store });

  for (const n of PINNED_KEEP) {
    if (POOL.includes(n)) assert.ok(r.allow.includes(n), `${n} 是硬钉，必须回来`);
  }
  assert.ok(!r.deny.includes('qq_send'), '硬钉不允许出现在 deny 里');
  assert.ok(!r.allow.includes('memory_search'), '记忆不是硬钉，用户没给就是没给');
});

test('resolvePolicy：`skill` 在自管模式下必须被 deny（避免与自管技能目录重复）', () => {
  const pool = [...POOL, 'skill'];
  const r = resolvePolicy({ pool, bucket: 'owner', store: defaultStore() });
  assert.ok(r.deny.includes('skill'));

  const native = defaultStore();
  native.skills.mode = 'native';
  const r2 = resolvePolicy({ pool, bucket: 'owner', store: native });
  assert.ok(!r2.deny.includes('skill'));
});

test('resolvePolicy：群覆盖是增量，且 deny 优先于 allowAdd', () => {
  const store = defaultStore();
  store.chats['G1'] = { label: '测试群', allowAdd: ['group:github'], deny: ['gh_repo'] };

  const base = resolvePolicy({ pool: POOL, bucket: 'member', store });
  const inChat = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G1', store });

  assert.ok(!base.allow.includes('gh_search'), '没覆盖时群友不该有 gh_search');
  assert.ok(inChat.allow.includes('gh_search'), '覆盖后应当拿到 gh_search');
  assert.ok(!inChat.allow.includes('gh_repo'), 'deny 优先于 allowAdd');
});

test('resolvePolicy：群的「只能聊天」是硬承诺，不受 member 档改成全权影响', () => {
  const store = defaultStore();
  store.defaults.member.allow = ['*']; // 用户把群成员放开了
  store.chats.G2 = { label: '公开群', chatOnly: true };

  const inGroup = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G2', store });
  assert.ok(inGroup.ok);
  assert.ok(inGroup.allow.includes('qq_send'), '必须还能回话');
  assert.ok(!inGroup.allow.includes('ops_bash'), '「只能聊天」不该被默认档位的 * 带开');
  assert.ok(!inGroup.allow.includes('gh_repo'));
  assert.ok(!inGroup.allow.includes('edit'));

  // 别的群照旧走默认（这里是 *）
  const other = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G3', store });
  assert.ok(other.allow.includes('ops_bash'));
});

test('resolvePolicy：人格只能收窄，不能放宽', () => {
  const store = defaultStore();
  store.defaults.member.allow = ['*'];
  const r = resolvePolicy({ pool: POOL, bucket: 'member', store, personaTools: ['read', 'memory_*'] });

  assert.ok(r.allow.includes('read'));
  assert.ok(r.allow.includes('memory_search'));
  assert.ok(!r.allow.includes('ops_bash'), '人格没允许的工具不该因为 allow=* 漏出去');
});

test('resolvePolicy：人格写 `tools: []` 是「一个都不许用」，不是「没声明」', () => {
  /**
   * 2026-11-05 的回归：`personaToolsFor()` 用 `[]` 表示全禁，
   * `planPersonaTools()` 也是这么读的，只有 `resolvePolicy()` 里写成了
   * `Array.isArray(x) && x.length` —— 于是「人格明确不许用工具」这张卡
   * 拿到了整档默认权限，主人档是 `*`，那就是全放开。
   */
  const store = defaultStore();
  const r = resolvePolicy({ pool: POOL, bucket: 'owner', store, personaTools: [] });
  assert.deepEqual(r.allow, ['qq_close', 'qq_send'], '只剩钉住的发言能力');

  const none = resolvePolicy({ pool: POOL, bucket: 'owner', store, personaTools: null });
  assert.ok(none.allow.includes('edit'), 'null 才是「没声明」，那种情况不参与');
});

test('accumulateAllow：`allow: []` 是「这一档清零」，不是「没写」', () => {
  /**
   * 这两种形态混掉的话，面板上给继承档取消一个工具写进去的空数组
   * 会被当成「没写」继续继承，勾选框变空、权限一点没变。
   */
  const store = defaultStore();
  store.defaults.manager = { allow: [] };

  assert.deepEqual(accumulateAllow(store, 'manager').from, [], '空数组不贡献也不往下继承');
  const r = resolvePolicy({ pool: POOL, bucket: 'manager', store });
  assert.deepEqual(r.allow, ['qq_close', 'qq_send']);
});

test('accumulateAllow：没写 allow 要继承，只写 deny 也要生效', () => {
  const store = defaultStore();
  delete store.defaults.manager.allow;
  store.defaults.helper = { deny: ['memory_search'] };

  const acc = accumulateAllow(store, 'helper');
  assert.ok(acc.allow.includes('qq_send'), '没写的档跟着低档走');
  assert.deepEqual(acc.deny, ['memory_search'], '只写 deny 的档也要把 deny 收进来');

  const r = resolvePolicy({ pool: POOL, bucket: 'helper', store });
  assert.ok(!r.allow.includes('memory_search'), 'deny 要盖住低档的 allow');
});

test('群覆盖：`chats[x].deny` 支持通配，和 allowAdd 对齐', () => {
  const store = defaultStore();
  store.defaults.member.allow = ['*'];
  store.chats = { G1: { deny: ['gh_*', 'mcp__*'] } };

  const r = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G1', store });
  assert.ok(!r.allow.some((n) => n.startsWith('gh_')), 'gh_* 要真的禁掉，不能只认字面名');
  assert.ok(!r.allow.some((n) => n.startsWith('mcp__')));
  assert.ok(r.allow.includes('edit'), '没被命中的要留着');
});

test('「只能聊天」管得住群友，管不住主人', () => {
  /**
   * 这条硬承诺要防的是「群成员档被改成全权之后连带放开公开群」，
   * 不是防主人。主人自己在这个群里也只能聊天、非得私聊才能干活，
   * 属于莫名其妙——而且他会以为自己配错了。
   */
  const store = defaultStore();
  store.chats = { G1: { chatOnly: true } };

  const member = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G1', store });
  assert.ok(!member.allow.includes('edit'), '群友只能聊天');

  const owner = resolvePolicy({ pool: POOL, bucket: 'owner', chatId: 'G1', store });
  assert.ok(owner.allow.includes('edit'), '主人照常');
});

test('resolvePolicy：newTools=nobody 时 `*` 不含未见过的工具', () => {
  const store = defaultStore();
  store.newTools = 'nobody';
  store.seen.tools = { edit: 1, read: 1, qq_send: 1, memory_search: 1, memory_note: 1 };

  const r = resolvePolicy({ pool: POOL, bucket: 'owner', store });
  assert.ok(r.allow.includes('edit'));
  assert.ok(!r.allow.includes('gh_repo'), '没见过的新工具不该被 `*` 自动放行');
});

test('resolvePolicy：配置里已失效的名字进 removed，不进 deny', () => {
  const store = defaultStore();
  store.defaults.member.allow = ['ghost_tool', 'qq_send'];

  const r = resolvePolicy({ pool: POOL, bucket: 'member', store });
  assert.deepEqual(r.removed, ['ghost_tool']);
  assert.ok(!r.deny.includes('ghost_tool'));
});

test('resolvePolicy：pool 为空时明确失败，不装作收住了', () => {
  const r = resolvePolicy({ pool: [], bucket: 'member', store: defaultStore() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /清单/);
});

test('diffSeen：第一次没有快照时不能把全部当成新增', () => {
  const first = diffSeen({}, POOL);
  assert.equal(first.initialized, false);
  assert.equal(first.added.length, POOL.length);

  const second = diffSeen(touchSeen({}, POOL, 1000), POOL);
  assert.equal(second.initialized, true);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.gone, []);
});

test('diffSeen：池子里少了一个工具要能报出来', () => {
  const seen = touchSeen({}, POOL, 1000);
  const d = diffSeen(seen, POOL.filter((n) => n !== 'ops_bash'));
  assert.deepEqual(d.gone, ['ops_bash']);
  assert.deepEqual(d.added, []);
});

test('touchSeen：已有的保留首次见到的时间，新增的补时间', () => {
  const a = touchSeen({}, ['edit'], 100);
  const b = touchSeen(a, ['edit', 'read'], 200);
  assert.equal(b.edit, 100);
  assert.equal(b.read, 200);
});

test('normalizeStore：坏输入退回默认值，不抛', () => {
  for (const bad of [null, undefined, 42, 'x', [], { defaults: 'nope' }]) {
    const s = normalizeStore(bad);
    assert.equal(s.version, 1);
    assert.ok(Array.isArray(s.defaults.owner.allow));
  }
  const s = normalizeStore({ defaults: { member: { allow: 'not-array' } } });
  assert.ok(Array.isArray(s.defaults.member.allow));
});

test('dangerOf：exec 这类比 edit 更危险的动作必须命中', () => {
  const s = defaultStore();
  assert.equal(dangerOf('mcp__graphflow__gf_exec', s), 'mcp__*__*_exec');
  assert.equal(dangerOf('edit', s), 'edit');
  assert.equal(dangerOf('gh_search', s), '');
});

/* ---------------- 五档继承（对齐框架 0/1/2/3） ---------------- */

test('档位：五档对齐框架的 0 主人 / 1 管理员 / 2 群管 / 3 助手', async () => {
  const { BUCKETS, BUCKET_ORDER, EDITABLE_BUCKETS, LEVEL_TO_BUCKET } = await import('../src/capabilities.js');
  assert.deepEqual(BUCKETS, ['owner', 'admin', 'manager', 'helper', 'member', 'unknown']);
  assert.deepEqual(BUCKET_ORDER, BUCKETS, '顺序必须是权限从高到低，accumulateAllow 靠它切片');
  assert.ok(!EDITABLE_BUCKETS.includes('unknown'), '兜底档不可配');
  assert.equal(LEVEL_TO_BUCKET[2], 'manager');
  assert.equal(LEVEL_TO_BUCKET[3], 'helper');
});

test('档位：没写 allow 的档继承所有更低的档', async () => {
  const { accumulateAllow } = await import('../src/capabilities.js');
  const store = defaultStore();

  // 默认：manager / helper 没写 allow
  const mgr = accumulateAllow(store, 'manager');
  assert.ok(mgr.allow.includes('memory_search'));
  assert.ok(mgr.allow.includes('qq_send'));
  assert.ok(!mgr.allow.includes('memory_note'), '群管不该凭空拿到管理员的 memory_note');

  // 写成增量：给群管单独多一个 memory_note，它也继承群成员的
  store.defaults.manager = { allow: ['memory_note'] };
  const mgr2 = accumulateAllow(store, 'manager');
  assert.ok(mgr2.allow.includes('memory_note'));
  assert.ok(mgr2.allow.includes('memory_search'), '继承部分不能丢');
});

test('档位：高位的档不会漏给低位（主人的 * 不会流到群成员）', async () => {
  /**
   * 这是继承最容易写反的地方：`slice(idx)` 如果写成 `slice(0, idx+1)`，
   * 主人的 `*` 会往下漏，全群直接全权——而且不报错。
   */
  const store = defaultStore();
  const owner = resolvePolicy({ pool: POOL, bucket: 'owner', store });
  const member = resolvePolicy({ pool: POOL, bucket: 'member', store });

  assert.equal(owner.allow.length, POOL.filter((n) => !PINNED_KEEP.includes(n) || true).length - (owner.deny || []).length + 0, '主人不该被收走东西');
  assert.ok(owner.allow.includes('edit'), '主人该能改文件');
  assert.ok(!member.allow.includes('edit'), '群成员不该拿到主人的能力');
});

test('档位：deny 盖住低档的 allow（「助手」是外部人员，不给翻记忆）', async () => {
  const store = defaultStore();
  store.defaults.member = { allow: ['memory_search', 'qq_send'] };
  store.defaults.helper = { deny: ['memory_search'] };

  const h = resolvePolicy({ pool: POOL, bucket: 'helper', store });
  assert.ok(!h.allow.includes('memory_search'), 'deny 必须盖住来自 member 的 allow');
  assert.ok(h.allow.includes('qq_send'), '别的低档权限要留着');

  const m = resolvePolicy({ pool: POOL, bucket: 'member', store });
  assert.ok(m.allow.includes('memory_search'), '低档自己不受影响');
});

test('档位：存量文件（没有群管/助手两档）跑出来不能放大权限', () => {
  /**
   * 老版本的 `capabilities.json` 长这样：只有 owner/admin/member/unknown，
   * 而且数组写的是「完整清单」不是「增量」。
   *
   * 新代码把它们当增量用，**结果必须完全一样**——否则升级那一刻
   * 所有群成员的权限都会被静默放大，而主人什么都不知道。
   */
  const old = {
    version: 1,
    defaults: {
      owner: { allow: ['*'] },
      admin: { allow: ['memory_search', 'memory_note', 'qq_send', 'sticker_pick'] },
      member: { allow: ['memory_search', 'qq_send', 'sticker_pick'] },
      unknown: { allow: ['qq_send'] },
    },
  };

  const a = resolvePolicy({ pool: POOL, bucket: 'admin', store: old });
  for (const n of ['memory_search', 'memory_note', 'qq_send', 'sticker_pick']) {
    assert.ok(a.allow.includes(n), `管理员丢了 ${n}`);
  }
  assert.ok(!a.allow.includes('edit'), '管理员不该凭空拿到文件工具');

  const m = resolvePolicy({ pool: POOL, bucket: 'member', store: old });
  assert.ok(m.allow.includes('memory_search'));
  assert.ok(!m.allow.includes('memory_note'), '群成员不该跟着管理员拿到 memory_note');
  assert.ok(!m.allow.includes('edit'));

  // 新增的两档应该是「跟群成员一样」，不是「什么都没有」，也不是「全给」
  const mgr = resolvePolicy({ pool: POOL, bucket: 'manager', store: old });
  assert.deepEqual(mgr.allow.slice().sort(), m.allow.slice().sort(), '群管默认等于群成员');
  const h = resolvePolicy({ pool: POOL, bucket: 'helper', store: old });
  assert.deepEqual(h.allow.slice().sort(), m.allow.slice().sort());
});

test('档位：坏文件不能让主人丢掉 *（这是最贵的一次降权）', () => {
  /**
   * `{defaults:'nope'}` 这种坏输入下，如果不退回默认值，
   * owner 会变成空对象 → 继承低档 → 没有 `*` → 主人静默失去全权。
   */
  const bad = normalizeStore({ defaults: 'nope' });
  assert.ok(Array.isArray(bad.defaults.owner.allow), 'owner 必须退回默认的 *');
  assert.ok(bad.defaults.owner.allow.includes('*'));
});
