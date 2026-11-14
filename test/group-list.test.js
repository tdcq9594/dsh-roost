/**
 * 「选一个群」的候选合并：已配置的 + 收到过消息的。
 *
 * 这一层单独抽出来是为了能测——它决定下拉里能看到什么，
 * 而 QQ 官方只给 openid，用户根本没法手填验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeGroupCandidates, localGroupCandidates, mergeSeenGroups } from '../src/group-list.js';

test('两边都空：空表（面板会提示「让群里有人说句话」）', () => {
  assert.deepEqual(mergeGroupCandidates([], []), []);
  assert.deepEqual(mergeGroupCandidates(undefined, undefined), []);
});

test('只有收到过消息的群：按框架给的顺序原样列出', () => {
  const out = mergeGroupCandidates([], [
    { openid: 'AAA', name: '摸鱼群' },
    { openid: 'BBB', name: '测试群' },
  ]);
  assert.deepEqual(out, [
    { chatId: 'AAA', name: '摸鱼群', source: 'seen', lastSeenAt: 0 },
    { chatId: 'BBB', name: '测试群', source: 'seen', lastSeenAt: 0 },
  ]);
});

test('已配置的排前面，第二处只补缺', () => {
  const out = mergeGroupCandidates(
    [{ chatId: 'BBB', name: '我配过的名字' }],
    [{ openid: 'AAA', name: '摸鱼群' }, { openid: 'BBB', name: '框架学到的名字' }],
  );
  assert.deepEqual(out.map((x) => x.chatId), ['BBB', 'AAA'], '配过的在前，新群在后');
  assert.equal(out[0].name, '我配过的名字', '不覆盖用户自己起的名字');
  assert.equal(out[0].source, 'awake');
});

test('已配置但没名字：用框架学到的名字补上', () => {
  const out = mergeGroupCandidates(
    [{ chatId: 'AAA', name: '' }],
    [{ openid: 'AAA', name: '摸鱼群' }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '摸鱼群', '空名字要补，否则下拉只剩 openid');
  assert.equal(out[0].source, 'awake', '来源仍算已配置');
});

test('脏数据：空 id / 空白 / 重复都过滤掉', () => {
  const out = mergeGroupCandidates(
    [{ chatId: '  ', name: 'x' }, { chatId: 'AAA', name: 'a' }, { chatId: 'AAA', name: 'b' }],
    [{ openid: '', name: 'y' }, null, { openid: ' AAA ', name: '' }],
  );
  assert.deepEqual(out, [{ chatId: 'AAA', name: 'a', source: 'awake', lastSeenAt: 0 }]);
});

test('框架返回的群 id 带空格也能对上', () => {
  const out = mergeGroupCandidates([{ chatId: 'AAA', name: '配过的' }], [{ openid: ' AAA ', name: 'x' }]);
  assert.equal(out.length, 1, '同一个群不能出现两次');
});

test('最近活跃时间：已配置的群从「见过消息」那边补上，不会被 0 覆盖', () => {
  const out = mergeGroupCandidates(
    [{ chatId: 'AAA', name: '配过的', lastSeenAt: 0 }],
    [{ openid: 'AAA', name: '', lastSeenAt: 1730000000000 }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].lastSeenAt, 1730000000000, '没时间的要从框架那边补');
  assert.equal(out[0].name, '配过的', '名字仍以用户配的为准');
});

test('两边都有时间时保留已配置的那份', () => {
  const out = mergeGroupCandidates(
    [{ chatId: 'AAA', name: 'a', lastSeenAt: 200 }],
    [{ openid: 'AAA', name: 'b', lastSeenAt: 100 }],
  );
  assert.equal(out[0].lastSeenAt, 200);
});

test('时间字段缺失 / 非法一律当 0，不产生 NaN', () => {
  const out = mergeGroupCandidates(
    [{ chatId: 'AAA', name: 'a', lastSeenAt: '不是数字' }],
    [{ openid: 'BBB', name: 'b', lastSeenAt: -5 }],
  );
  assert.deepEqual(out.map((x) => x.lastSeenAt), [0, 0]);
});

/* -------------------- 本地会话表：框架没开也能列群 -------------------- */

test('localGroupCandidates：只认 kind=group，剥掉 QQ 前缀，拿觉醒里的活跃时间', () => {
  const list = [
    { chatId: 'GROUP_A', kind: 'group', title: 'QQ · roost交流群', at: 100 },
    { chatId: 'GROUP_B', kind: 'group', title: 'QQ · 机器人测试', at: 200 },
    { chatId: 'PRIVATE', kind: 'c2c', title: 'QQ · 私聊 FC7BB5', at: 300 },
  ];
  const stateOf = (id) => ({ lastUserAt: id === 'GROUP_A' ? 1730000000000 : 0 });
  const out = localGroupCandidates(list, stateOf);
  assert.deepEqual(out, [
    { openid: 'GROUP_A', name: 'roost交流群', lastSeenAt: 1730000000000 },
    { openid: 'GROUP_B', name: '机器人测试', lastSeenAt: 200 },
  ]);
});

test('localGroupCandidates：私聊一律不进下拉（推错到人比不推更糟）', () => {
  const out = localGroupCandidates([
    { chatId: 'A', kind: 'c2c', title: 'QQ · 私聊', at: 1 },
    { chatId: 'B', kind: '', title: '早期没写 kind', at: 2 },
    { chatId: ' ', kind: 'group', title: '空 id', at: 3 },
  ]);
  assert.deepEqual(out, []);
});

test('localGroupCandidates：群状态查询抛错不影响其它群', () => {
  const out = localGroupCandidates(
    [{ chatId: 'A', kind: 'group', title: '群 A', at: 9 }],
    () => { throw new Error('状态文件坏了'); },
  );
  assert.deepEqual(out, [{ openid: 'A', name: '群 A', lastSeenAt: 9 }]);
});

test('mergeSeenGroups：本地优先，框架那份只补缺、不覆盖名字', () => {
  const out = mergeSeenGroups(
    [{ openid: 'A', name: '本地学到的名', lastSeenAt: 100 }],
    [{ openid: 'A', name: '框架的名', lastSeenAt: 999 }, { openid: 'B', name: '框架独有', lastSeenAt: 50 }],
  );
  assert.deepEqual(out, [
    { openid: 'A', name: '本地学到的名', lastSeenAt: 100 },
    { openid: 'B', name: '框架独有', lastSeenAt: 50 },
  ]);
});

test('mergeSeenGroups：本地没活跃时间时，框架的能补上', () => {
  const out = mergeSeenGroups(
    [{ openid: 'A', name: '群 A', lastSeenAt: 0 }],
    [{ openid: 'A', name: '', lastSeenAt: 1730000000000 }],
  );
  assert.equal(out[0].lastSeenAt, 1730000000000);
  assert.equal(out[0].name, '群 A');
});

test('端到端：框架完全离线，下拉依然列得出收到过消息的群', () => {
  /** 这就是「选群没看到选项」的复现：remote 为空，旧实现只能给出空表 */
  const local = localGroupCandidates(
    [{ chatId: 'F1F759AD2BC4BCC6624AFAB5219FDD94', kind: 'group', title: 'QQ · roost交流群', at: 1 }],
    () => ({ lastUserAt: 1794537832155 }),
  );
  const groups = mergeGroupCandidates([], mergeSeenGroups(local, []));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].chatId, 'F1F759AD2BC4BCC6624AFAB5219FDD94');
  assert.equal(groups[0].name, 'roost交流群');
  assert.equal(groups[0].lastSeenAt, 1794537832155);
});
