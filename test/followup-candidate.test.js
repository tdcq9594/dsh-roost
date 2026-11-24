// 到期跟进 → 独立主动候选（阶段 5）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFollowUpCandidates } from '../src/followup-candidate.js';

test('只有带 question 的到期项才成候选，按到期时间排序', () => {
  const rows = [
    { text: '体检结果', question: '上次体检怎么样了', at: 2000, tries: 1, chatId: 'u1' },
    { text: '没问题的记忆', question: '', at: 1000, tries: 0, chatId: 'u1' },
    { text: '养鱼游戏', question: '那个游戏后来装了吗', at: 1000, tries: 0, chatId: 'u1' },
  ];
  const out = buildFollowUpCandidates(rows);
  assert.equal(out.length, 2, '空 question 被过滤');
  assert.equal(out[0].text, '养鱼游戏', '先到期的排前');
  assert.equal(out[0].kind, 'follow-up');
  assert.match(out[0].id, /^follow:/);
});

test('同 chat 同 text 去重；空输入安全', () => {
  const rows = [
    { text: '体检', question: '怎么样了', at: 1000, chatId: 'u1' },
    { text: '体检', question: '后来呢', at: 2000, chatId: 'u1' },
  ];
  assert.equal(buildFollowUpCandidates(rows).length, 1);
  assert.deepEqual(buildFollowUpCandidates(null), []);
  assert.deepEqual(buildFollowUpCandidates(), []);
});
