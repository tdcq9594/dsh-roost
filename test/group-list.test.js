/**
 * 「选一个群」的候选合并：已配置的 + 收到过消息的。
 *
 * 这一层单独抽出来是为了能测——它决定下拉里能看到什么，
 * 而 QQ 官方只给 openid，用户根本没法手填验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeGroupCandidates } from '../src/group-list.js';

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
    { chatId: 'AAA', name: '摸鱼群', source: 'seen' },
    { chatId: 'BBB', name: '测试群', source: 'seen' },
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
  assert.deepEqual(out, [{ chatId: 'AAA', name: 'a', source: 'awake' }]);
});

test('框架返回的群 id 带空格也能对上', () => {
  const out = mergeGroupCandidates([{ chatId: 'AAA', name: '配过的' }], [{ openid: ' AAA ', name: 'x' }]);
  assert.equal(out.length, 1, '同一个群不能出现两次');
});
