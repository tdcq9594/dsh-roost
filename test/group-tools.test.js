import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupToolDefs } from '../src/group-tools.js';

/**
 * 这一层是「模型手上的群管」。
 *
 * 重点不是功能，而是**边界**：
 *   · 只读的群状态谁都能问；
 *   · 写动作只有主人能用；
 *   · 踢人**故意不给模型**（不可逆），这条要钉死，别哪天顺手加上。
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

const defs = (ctx) => buildGroupToolDefs({ groupOf: () => ctx.admin, callerOf: () => ctx.caller });
const tool = (ctx, name) => defs(ctx).find((d) => d.name === name);

const owner = { bucket: 'owner', chatId: 'g1', kind: 'group' };
const member = { bucket: 'member', chatId: 'g1', kind: 'group' };

test('只给三个工具，且**没有踢人**（不可逆，只留面板）', () => {
  const { admin } = makeAdmin();
  const names = buildGroupToolDefs({ groupOf: () => admin, callerOf: () => owner }).map((d) => d.name);
  assert.deepEqual(names.sort(), ['qq_group_info', 'qq_join_request', 'qq_mute']);
  assert.ok(!names.includes('qq_kick'), '踢人不能出现在模型手里');
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
