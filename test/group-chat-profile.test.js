/**
 * 阶段6 群印象档案：按群存气氛/常聊什么/印象，仿 profiles.js 范式。
 * 对齐 aurabot s.chats['group:<id>'] + /chats/save。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGroupChatProfiles, normalizeChatPatch, clip, VIBE_MAX, TOPICS_MAX } from '../src/group-chat-profile.js';

function fresh(seed = []) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-chatprof-'));
  const file = join(dir, 'chat-profiles.json');
  writeFileSync(file, JSON.stringify(seed), 'utf8');
  return {
    file,
    store: () => createGroupChatProfiles({ file, now: () => 1700000000000 }),
    done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

test('normalizeChatPatch：三字段定长、空 patch 报错', () => {
  const r = normalizeChatPatch({ vibe: '热闹', topics: '球, 饭', impression: '友善' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { vibe: '热闹', topics: '球, 饭', impression: '友善' });
  assert.equal(normalizeChatPatch({}).ok, false);
  assert.equal(normalizeChatPatch({ vibe: 'x'.repeat(VIBE_MAX + 10) }).patch.vibe.length, VIBE_MAX);
  assert.ok(TOPICS_MAX > VIBE_MAX);
  assert.equal(clip('ab😀cd', 3), 'ab😀'); // 按码点截，不切 emoji
});

test('save 新建与更新，chatId 归一（大小写）', () => {
  const f = fresh();
  try {
    const p = f.store();
    assert.equal(p.save('Group:123', { vibe: '热闹' }).ok, true);
    assert.equal(p.save('group:123', { topics: '聊球' }).ok, true);
    const all = p.recent(0);
    assert.equal(all.length, 1); // 同一个群
    assert.equal(all[0].vibe, '热闹'); // 更新不覆盖没给的字段
    assert.equal(all[0].topics, '聊球');
  } finally { f.done(); }
});

test('get / clear / text', () => {
  const f = fresh();
  try {
    const p = f.store();
    p.save('g1', { vibe: '安静', topics: '看书', impression: '都很有礼貌' });
    assert.equal(p.get('g1').vibe, '安静');
    assert.match(p.text({ chatId: 'g1' }), /安静/);
    assert.match(p.text({ chatId: 'g1' }), /常聊：看书/);
    assert.equal(p.text({ chatId: 'nope' }), '');
    assert.equal(p.clear('g1'), true);
    assert.equal(p.get('g1'), null);
  } finally { f.done(); }
});

test('持久化 + 空 patch 不写盘', () => {
  const f = fresh();
  try {
    const p = f.store();
    p.save('g1', { vibe: '活跃' });
    assert.equal(p.save('g1', {}).ok, false);
    const row = f.store().get('g1');
    assert.equal(row.vibe, '活跃');
    const raw = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(raw[0].chatId, 'g1');
  } finally { f.done(); }
});
