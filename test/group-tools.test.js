import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupToolDefs } from '../src/group-tools.js';

/**
 * 这一层是「模型手上的群管」。
 *
 * 重点不是功能，而是**边界**：
 *   · 只读的群状态谁都能问；
 *   · 写动作只有主人能用；
 *   · 踢人**故意不给模型**（不可逆），这条要钉死，别哪天顺手加上；
 *   · 群聊摘要（C5-1）只在主人私聊、且目标只能是群——群里回复人人看得见。
 */

const makeAdmin = (over = {}) => {
  const calls = [];
  return {
    calls,
    admin: {
      async info(gid) {
        calls.push(['info', gid]);
        return over.info ?? { ok: true, name: '斗罗内测', role: 'admin', canManage: true, invited: true, memberCount: 9 };
      },
      async mute(a) {
        calls.push(['mute', a]);
        return over.mute ?? { ok: true, seconds: a.seconds, targets: a.targets };
      },
      async join(a) {
        calls.push(['join', a]);
        return over.join ?? { ok: true, requests: [{ member_openid: 'u1', join_request_id: 'r1' }] };
      },
    },
  };
};

const defs = (ctx) => buildGroupToolDefs({
  groupOf: () => ctx.admin,
  callerOf: () => ctx.caller,
  ledgerOf: () => ctx.ledger || null,
  sessionOf: ctx.sessionOf || (() => null),
  cfgOf: () => ctx.cfg || {},
});
const tool = (ctx, name) => defs(ctx).find((d) => d.name === name);

const owner = { bucket: 'owner', chatId: 'g1', kind: 'group' };
const member = { bucket: 'member', chatId: 'g1', kind: 'group' };

/** 账本夹具：recent 是正序（老在前），和 ledger-read.js 一致 */
const makeLedger = (rows = []) => ({
  available: () => true,
  recent: ({ limit }) => rows.slice(-limit),
});
const groupSession = (id) => ({ chatId: id, kind: 'group', title: 'QQ · 斗罗内测' });
const ownerPrivate = { bucket: 'owner', chatId: 'U_OWNER', kind: 'c2c' };

test('只给四个工具，且**没有踢人**（不可逆，只留面板）', () => {
  const { admin } = makeAdmin();
  const names = buildGroupToolDefs({ groupOf: () => admin, callerOf: () => owner }).map((d) => d.name);
  assert.deepEqual(names.sort(), ['qq_group_brief', 'qq_group_info', 'qq_join_request', 'qq_mute']);
  assert.ok(!names.includes('qq_kick'), '踢人不能出现在模型手里');
  assert.ok(names.includes('qq_group_info') && names.includes('qq_mute') && names.includes('qq_join_request'),
    '2.2b 只增不减：原三个工具一个都不能丢');
});

test('qq_group_info：没连上框架时说清原因，不抛错', async () => {
  const t = tool({ admin: null, caller: member }, 'qq_group_info');
  const r = await t.execute({});
  assert.equal(r.ok, false);
  assert.match(r.message, /还没连上/);
});

test('qq_group_info：私聊里又没给 groupId 时拒绝', async () => {
  const { admin } = makeAdmin();
  const t = tool({ admin, caller: { bucket: 'owner', chatId: 'u1', kind: 'c2c' } }, 'qq_group_info');
  const r = await t.execute({});
  assert.equal(r.ok, false);
  assert.match(r.message, /不是群聊/);
});

test('qq_group_info：普通群友也能问（只读）', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: member }, 'qq_group_info');
  const r = await t.execute({});
  assert.equal(r.ok, true);
  assert.equal(r.name, '斗罗内测');
  assert.equal(r.canManage, true);
  assert.equal(r.role, 'admin');
});

test('qq_mute：非主人直接拒，一次都不调后端', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: member }, 'qq_mute');
  const r = await t.execute({ memberOpenids: 'u1', seconds: 60 });
  assert.equal(r.ok, false);
  assert.match(r.message, /只有主人/);
  assert.equal(ctx.calls.length, 0);
});

test('qq_mute：主人正常执行，多个 openid 会被拆开', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: owner }, 'qq_mute');
  const r = await t.execute({ memberOpenids: 'u1, u2\nu3', seconds: 600 });
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.calls[0][1].targets, ['u1', 'u2', 'u3']);
  assert.equal(r.seconds, 600);
  assert.match(r.note, /已禁言 3 人/);
});

test('qq_mute：解禁（seconds=0）文案是「已解禁」', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: owner }, 'qq_mute');
  const r = await t.execute({ memberOpenids: 'u1', seconds: 0 });
  assert.equal(r.ok, true);
  assert.match(r.note, /已解禁/);
});

test('qq_mute：私聊里没 groupId 时拒绝（别把她自己那个单聊当成群）', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: { bucket: 'owner', chatId: 'u1', kind: 'c2c' } }, 'qq_mute');
  const r = await t.execute({ memberOpenids: 'u1', seconds: 60 });
  assert.equal(r.ok, false);
  assert.equal(ctx.calls.length, 0);
});

test('qq_join_request：列表任何人都能看（给主人汇报用）', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: member }, 'qq_join_request');
  const r = await t.execute({ action: 'list' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.equal(ctx.calls[0][1].action, 'list');
});

test('qq_join_request：approve 非主人被拒', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: member }, 'qq_join_request');
  const r = await t.execute({ action: 'approve', memberOpenid: 'u1', joinRequestId: 'r1' });
  assert.equal(r.ok, false);
  assert.match(r.message, /只有主人/);
  assert.equal(ctx.calls.length, 0);
});

test('qq_join_request：主人 approve 成功', async () => {
  const ctx = makeAdmin();
  const t = tool({ admin: ctx.admin, caller: owner }, 'qq_join_request');
  const r = await t.execute({ action: 'approve', memberOpenid: 'u1', joinRequestId: 'r1' });
  assert.equal(r.ok, true);
  assert.match(r.note, /已通过/);
});

test('后端返回的失败原因（need_invite）会带 reason 给模型', async () => {
  const ctx = makeAdmin({ mute: { ok: false, reason: 'need_invite', message: '群管内邀没开' } });
  const t = tool({ admin: ctx.admin, caller: owner }, 'qq_mute');
  const r = await t.execute({ memberOpenids: 'u1', seconds: 60 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'need_invite');
  assert.match(r.message, /内邀/);
});

/* ---------------- C5-1 主人私聊·群聊摘要 ---------------- */

const briefCtx = (over = {}) => ({
  admin: null,
  caller: ownerPrivate,
  ledger: makeLedger([
    { time: '10:01', who: '唐三', text: '今天打不打' },
    { time: '10:02', who: '小舞', text: '打啊' },
    { time: '10:03', who: '唐三', text: '那就八点' },
  ]),
  sessionOf: groupSession,
  ...over,
});

test('qq_group_brief：普通群友、主人在群里，一律拒（回复人人看得见）', async () => {
  for (const caller of [member, owner, { bucket: 'owner', chatId: 'g1', kind: 'channel' }]) {
    const t = tool(briefCtx({ caller }), 'qq_group_brief');
    const r = await t.execute({ groupId: 'G_1' });
    assert.equal(r.ok, false, `${caller.bucket}/${caller.kind} 不该能查`);
    assert.match(r.message, /只能主人在私聊里查/);
  }
});

test('qq_group_brief：不给 groupId / 目标不是群 / 会话不存在，各有各的说法', async () => {
  const t = tool(briefCtx(), 'qq_group_brief');
  assert.match((await t.execute({})).message, /要给出群 openid/);
  const priv = tool(briefCtx({ sessionOf: () => ({ kind: 'c2c', title: 'QQ · 某人的私聊' }) }), 'qq_group_brief');
  assert.match((await priv.execute({ groupId: 'U_SOMEONE' })).message, /别人的私聊/);
  const missing = tool(briefCtx({ sessionOf: () => null }), 'qq_group_brief');
  assert.match((await missing.execute({ groupId: 'G_404' })).message, /找不到这个会话/);
});

test('qq_group_brief：账本没开时说清原因，不冒充「群里没人说话」', async () => {
  const off = { available: () => false, recent: () => [] };
  const t = tool(briefCtx({ ledger: off }), 'qq_group_brief');
  const r = await t.execute({ groupId: 'G_1' });
  assert.equal(r.ok, false);
  assert.match(r.message, /账本没开/);
});

test('qq_group_brief：按人聚合 + 时间段 + 只给主人，条数受配置与 50 上限管', async () => {
  const t = tool(briefCtx({ cfg: { group: { briefMaxItems: 2 } } }), 'qq_group_brief');
  const r = await t.execute({ groupId: 'G_1' });
  assert.equal(r.ok, true);
  assert.equal(r.name, '斗罗内测');
  assert.equal(r.audience, '只给主人');
  assert.equal(r.count, 2, '默认跟随 group.briefMaxItems');
  assert.equal(r.from, '10:02');
  assert.equal(r.to, '10:03');
  assert.deepEqual(r.people.map((p) => [p.who, p.count]), [['小舞', 1], ['唐三', 1]]);
  assert.equal(r.items[0].who, '小舞');

  const all = await t.execute({ groupId: 'G_1', limit: 999 });
  assert.equal(all.count, 3);
  assert.deepEqual(all.people.map((p) => [p.who, p.count]), [['唐三', 2], ['小舞', 1]]);
  assert.equal(all.people[0].last, '那就八点');
});

test('qq_group_brief：账本空时给出空态提示，不抛错', async () => {
  const t = tool(briefCtx({ ledger: makeLedger([]) }), 'qq_group_brief');
  const r = await t.execute({ groupId: 'G_1' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.people, []);
  assert.match(r.hint, /没有记录/);
});
