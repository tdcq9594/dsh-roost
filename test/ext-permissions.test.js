/**
 * 阶段 1.3 / 门 G1：方案 C′ 权限内核 + 8b 影子组主落点。
 *
 * 盯的是方案 §4.2 用产品真实 `resolvePolicy` 复现过的四条失败路径，
 * 加上「启用能力页后扩展静默断档」这个 P0：
 *  1. `group:ext_*` 引用展开后逃过 deny；
 *  2. `forceDeny` 通配被 `poolSet.has()` 预筛丢掉、且没有持久化位置；
 *  3. 低档 deny 连坐高档 / `newTools:'nobody'` 倒挂；
 *  4. 影子组没合进 `init(seed)` → 启用后 `mcp__bili__feed` 对 member 静默 deny。
 *
 * 跑法：node --test test/ext-permissions.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { defaultStore, normalizeStore, resolvePolicy } from '../src/capabilities.js';
import { createCapabilityStore } from '../src/capability-store.js';
import { GUEST_KEEP_TOOLS } from '../src/permissions.js';
import { createExtGroups } from '../src/ext-groups.js';
import { shouldSkip } from '../src/backup.js';

const POOL = [
  'mcp__bili__feed', 'mcp__bili__search', 'ext_memory_note',
  'chat_look', 'qq_send', 'qq_close', 'edit',
];

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-perm-'));
  // 同 test/mood.test.js：Windows 的 rmSync 偶发 ENOTEMPTY 不算测试失败。
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function extStore() {
  const s = defaultStore();
  s.groups.ext_bili = { match: ['mcp__bili__*'], label: '刷 B 站' };
  s.defaults.member.allow = ['group:ext_bili', 'chat_look', 'qq_send'];
  s.defaults.admin.allow = ['group:ext_bili', 'qq_send'];
  return s;
}

test('C′ ①：member.deny 通配在 group: 展开后生效，且不连坐 owner/admin', () => {
  const s = extStore();
  s.defaults.member.deny = ['mcp__bili__*'];
  const member = resolvePolicy({ pool: POOL, bucket: 'member', store: s });
  assert.ok(!member.allow.includes('mcp__bili__feed'), '展开后的最终工具名要被挡住');
  assert.ok(member.allow.includes('chat_look'), '没被 deny 的保留');

  for (const b of ['owner', 'admin']) {
    const r = resolvePolicy({ pool: POOL, bucket: b, store: s });
    assert.ok(r.allow.includes('mcp__bili__feed'), `${b} 不该被 member.deny 连坐`);
  }
});

test('C′ ②：forceDeny 通配跨档硬否决，且能写进 capabilities.json 持久化', (t) => {
  const s = extStore();
  for (const b of ['owner', 'admin', 'member', 'unknown']) {
    const r = resolvePolicy({ pool: POOL, bucket: b, store: s, forceDeny: ['mcp__bili__*'] });
    assert.ok(!r.allow.includes('mcp__bili__feed'), `${b} 也要被硬否决`);
  }
  // 字面名仍然有效
  const lit = resolvePolicy({ pool: POOL, bucket: 'owner', store: s, forceDeny: ['mcp__bili__feed'] });
  assert.ok(!lit.allow.includes('mcp__bili__feed'));
  assert.ok(lit.allow.includes('mcp__bili__search'));

  // 持久化：normalizeStore 白名单放行 + createCapabilityStore 落盘再读回
  s.forceDeny = ['mcp__bili__*'];
  const dir = tmpHome(t);
  const store = createCapabilityStore({ dir });
  store.write(s);
  assert.deepEqual(store.get().forceDeny, ['mcp__bili__*']);
  const r = resolvePolicy({ pool: POOL, bucket: 'owner', store: store.get(), forceDeny: store.get().forceDeny });
  assert.ok(!r.allow.includes('mcp__bili__feed'));
  assert.equal(normalizeStore({ forceDeny: 'bad' }).forceDeny.length, 0, '坏值退回空数组');
});

test('C′ ③：群 allowAdd 不能绕过 deny（统一判定必须排在所有 allow 来源之后）', () => {
  const s = extStore();
  s.defaults.member.allow = ['*'];
  s.chats.G1 = { allowAdd: ['mcp__bili__feed'], deny: ['mcp__bili__*'] };
  const r = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G1', store: s });
  assert.ok(!r.allow.includes('mcp__bili__feed'), 'deny 不被 allowAdd 覆盖');
  assert.ok(r.allow.includes('edit'));
});

test('C′ ④：newTools=nobody 在 seen 已建立时不倒挂；群级 deny 仍支持通配', () => {
  const s = extStore();
  s.newTools = 'nobody';
  s.seen = { tools: { mcp__bili__feed: 1, qq_send: 1 }, skills: {}, lastScan: 0 };
  const owner = resolvePolicy({ pool: POOL, bucket: 'owner', store: s });
  const member = resolvePolicy({ pool: POOL, bucket: 'member', store: s });
  assert.ok(owner.allow.includes('mcp__bili__feed'), '主人仍能用见过的工具');
  assert.ok(!member.allow.includes('edit'), '群成员没有反超');

  /**
   * 既有边界（不是本轮引入，也不在本轮修）：`seen.tools` 为空且用
   * defaultStore 原样白名单时，owner 的 `*` 被 nobody 收窄成只剩钉住的
   * 发言工具，member 的字明白名单反而保留 memory_search / sticker_pick。
   * 用 `git show HEAD:src/capabilities.js` 跑同一场景，改前改后输出完全一致：
   *   owner  = ["qq_close","qq_send"]
   *   member = ["memory_search","qq_close","qq_send","sticker_pick"]
   * 门 G1 的「不倒挂」按「本轮改动未引入新倒挂」验收；修复属 §9-#24 的
   * 独立改动，会动到既有权限语义，需单独决定，不在阶段 1 顺手做。
   */
  const bare = defaultStore();
  bare.newTools = 'nobody';
  bare.seen = { tools: {}, skills: {}, lastScan: 0 };
  // defaultStore 的 member 白名单含 memory_search / sticker_pick，POOL 要带上它们才看得到边界
  const BARE_POOL = [...POOL, 'memory_search', 'sticker_pick'];
  const bareOwner = resolvePolicy({ pool: BARE_POOL, bucket: 'owner', store: bare });
  const bareMember = resolvePolicy({ pool: BARE_POOL, bucket: 'member', store: bare });
  assert.deepEqual(bareOwner.allow, ['qq_close', 'qq_send'], '与改前一致：既有边界');
  assert.ok(bareMember.allow.includes('memory_search'), '与改前一致：既有边界');

  const g = extStore();
  g.defaults.member.allow = ['*'];
  g.chats.G1 = { deny: ['mcp__*'] };
  const rg = resolvePolicy({ pool: POOL, bucket: 'member', chatId: 'G1', store: g });
  assert.ok(!rg.allow.some((n) => n.startsWith('mcp__')));
});

test('8b 主落点：影子组合进 seed 后，启用能力页不再断档（P1 断档复现对照）', (t) => {
  const dir = tmpHome(t);
  const shadow = createExtGroups({ dir });
  shadow.add('bili', { label: '刷 B 站' });
  const capStore = createCapabilityStore({ dir });

  // 复刻 host.js 的 `capabilities.init` seed 构造（cfg.permissions 全空 = 保守配置）
  const makeSeed = (withShadow) => {
    const seed = { defaults: {} };
    for (const b of ['owner', 'admin', 'member', 'unknown']) {
      seed.defaults[b] = { allow: [...GUEST_KEEP_TOOLS] };
    }
    if (withShadow) {
      const s = shadow.seedParts();
      seed.groups = { ...defaultStore().groups, ...s.groups };
      for (const ref of s.memberAllow) if (!seed.defaults.member.allow.includes(ref)) seed.defaults.member.allow.push(ref);
      for (const t of s.adminAllow) if (!seed.defaults.admin.allow.includes(t)) seed.defaults.admin.allow.push(t);
    }
    return seed;
  };

  // 对照：不改 seed（现状）→ member 静默 deny，且不报「分组不存在」
  const broken = capStore.init(makeSeed(false));
  const before = resolvePolicy({ pool: POOL, bucket: 'member', store: broken });
  assert.ok(!before.allow.includes('mcp__bili__feed'), '断档复现');
  assert.equal(before.warnings.some((w) => /分组.*不存在/.test(w)), false);

  // 删掉文件重新启用，走合并后的 seed
  fs.rmSync(join(dir, 'capabilities.json'));
  const fixed = capStore.init(makeSeed(true));
  assert.ok(fixed.groups.ext_bili, '影子组定义要进 store');
  for (const g of ['mcp', 'files', 'ops', 'github']) {
    assert.ok(fixed.groups[g], `默认组 ${g} 不能被整块冲掉`);
  }
  assert.ok(fixed.defaults.member.allow.includes('group:ext_bili'));
  assert.ok(fixed.defaults.member.allow.includes('memory_search'), 'GUEST_KEEP_TOOLS 不能丢');
  assert.ok(fixed.defaults.admin.allow.includes('ext_memory_note'));

  const after = resolvePolicy({ pool: POOL, bucket: 'member', store: fixed });
  assert.ok(after.allow.includes('mcp__bili__feed'), 'member 能用扩展工具');
  const unknown = resolvePolicy({ pool: POOL, bucket: 'unknown', store: fixed });
  assert.ok(!unknown.allow.includes('mcp__bili__feed'), 'unknown 不给扩展组');
  assert.equal(shadow.validateReferences(fixed).ok, true);
});

test('影子组：双写只追加、卸载精确移除、reconcile 只补缺失不覆盖用户收紧', (t) => {
  const dir = tmpHome(t);
  const shadow = createExtGroups({ dir });
  const capStore = createCapabilityStore({ dir });

  capStore.write(defaultStore());
  shadow.add('bili', { capStore });
  assert.ok(capStore.get().groups.ext_bili);
  assert.ok(capStore.get().defaults.member.allow.includes('group:ext_bili'));

  // 用户手动收紧：删掉组引用，reconcile 只补回来，但不碰别的配置
  const cur = capStore.get();
  const defaults = {
    ...cur.defaults,
    member: { ...cur.defaults.member, allow: cur.defaults.member.allow.filter((x) => x !== 'group:ext_bili'), deny: ['edit'] },
  };
  capStore.patch({ defaults });
  assert.ok(!capStore.get().defaults.member.allow.includes('group:ext_bili'));

  const fix = shadow.reconcile(capStore.get());
  assert.ok(fix && fix.defaults);
  capStore.patch(fix);
  const after = capStore.get();
  assert.ok(after.defaults.member.allow.includes('group:ext_bili'), '缺失的引用补回来');
  assert.deepEqual(after.defaults.member.deny, ['edit'], '用户收紧的 deny 不被覆盖');
  assert.equal(shadow.reconcile(after), null, '没有缺失就不写盘');

  shadow.remove('bili', { capStore });
  assert.equal(capStore.get().groups.ext_bili, undefined);
  assert.ok(!capStore.get().defaults.member.allow.includes('group:ext_bili'));
  assert.ok(!capStore.get().defaults.admin.allow.includes('ext_memory_note'), '最后一个扩展卸完要清写工具');
  assert.deepEqual(shadow.read().adminAllow, [], '影子组也不留悬空工具');
  assert.ok(capStore.get().groups.mcp, '卸载不能误删默认组');
});

test('P0 回归：卸载不破坏继承档、不误删用户手写的 ext_ 工具', (t) => {
  const dir = tmpHome(t);
  const shadow = createExtGroups({ dir });
  const capStore = createCapabilityStore({ dir });
  const pool = [...POOL, 'memory_search', 'sticker_pick', 'ext_my_custom_tool'];

  const base = defaultStore();
  base.defaults.member.allow = [...base.defaults.member.allow, 'ext_my_custom_tool'];
  base.defaults.admin.allow = [...base.defaults.admin.allow, 'ext_my_custom_tool'];
  capStore.write(base);
  assert.deepEqual(capStore.get().defaults.manager, {}, 'manager 的 {} 表示继承低档');
  const mgrBefore = resolvePolicy({ pool, bucket: 'manager', store: capStore.get() }).allow;
  assert.ok(mgrBefore.includes('memory_search'));

  shadow.add('bili', { capStore });
  shadow.add('weather', { capStore });
  shadow.remove('bili', { capStore }); // 非最后一个也不能破坏
  assert.deepEqual(capStore.get().defaults.manager, {}, '{} 不能被写成 {allow:[]}（会断链、权限清零且持久化）');
  assert.deepEqual(capStore.get().defaults.helper, {});
  assert.ok(capStore.get().defaults.member.allow.includes('ext_my_custom_tool'));

  shadow.remove('weather', { capStore }); // 最后一个
  for (const b of ['member', 'admin']) {
    assert.ok(capStore.get().defaults[b].allow.includes('ext_my_custom_tool'), `${b} 的用户手写工具不能被前缀误删`);
  }
  assert.ok(!capStore.get().defaults.admin.allow.includes('ext_memory_note'), '自己写进去的宿主工具仍要清');
  assert.deepEqual(capStore.get().defaults.manager, {});
  assert.deepEqual(resolvePolicy({ pool, bucket: 'manager', store: capStore.get() }).allow, mgrBefore, 'manager 档权限不因卸载而变化');
});

test('影子组：多扩展时卸一个不清共享写工具，卸完最后一个才清', (t) => {
  const dir = tmpHome(t);
  const shadow = createExtGroups({ dir });
  shadow.add('bili');
  shadow.add('weather');
  shadow.remove('bili');
  assert.deepEqual(shadow.read().adminAllow, ['ext_memory_note'], '还剩 weather，写工具保留');
  shadow.remove('weather');
  assert.deepEqual(shadow.read().adminAllow, [], '全卸完才清');
});

test('影子组：悬空引用能被检出来；并发持锁串行', (t) => {
  const dir = tmpHome(t);
  const shadow = createExtGroups({ dir });
  const bad = defaultStore();
  bad.defaults.member.allow = ['group:ext_ghost'];
  assert.equal(shadow.validateReferences(bad).ok, false);

  for (let i = 0; i < 5; i++) shadow.add(`ext${i}`.toLowerCase());
  const s = shadow.read();
  assert.equal(Object.keys(s.groups).length, 5);
  assert.equal(fs.existsSync(shadow.lockFile), false, '锁必须被释放');
});

test('E4 备份排除：secrets / .installing / .old 不进包，正常扩展清单进包', () => {
  assert.equal(shouldSkip('secrets/bili.json'), true);
  assert.equal(shouldSkip('secrets'), true);
  assert.equal(shouldSkip('extensions/.bili.installing/plugin.json'), true);
  assert.equal(shouldSkip('extensions/.bili.old/plugin.json'), true);
  assert.equal(shouldSkip('extensions/bili/plugin.json'), false);
  assert.equal(shouldSkip('ext-groups.json'), false);
  assert.equal(shouldSkip('capabilities.json'), false);
});
