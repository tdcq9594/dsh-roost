// A3 事实标签：老库逐字不变、四处白名单回环、any/all 过滤、人格隔离物理化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeTags, matchTags, tagPatternMatch, tagHistogram, TAG_MAX_LEN, TAG_MAX_COUNT,
} from '../src/tags.js';
import { createMemory } from '../src/memory.js';
import { normalizeEntry } from '../src/dry-run.js';
import { restoreRetentionRows } from '../src/backup.js';
import { createPersonaScope, PLAN } from '../src/persona-scope.js';

function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-tags-'));
  const prev = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  return { dir, done: () => { if (prev === undefined) delete process.env.DSH_ROOST_DATA; else process.env.DSH_ROOST_DATA = prev; } };
}

/* ---------------- 纯函数 ---------------- */

test('T-1 normalizeTags：trim / 去空 / 限长 / 大小写不敏感去重 / 上限', () => {
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags('work'), []);
  assert.deepEqual(normalizeTags(['  work ', '', '  ', 'WORK', 'home', 'Home', 'x'.repeat(TAG_MAX_LEN + 10)]),
    ['work', 'home', 'x'.repeat(TAG_MAX_LEN)]);
  const many = Array.from({ length: TAG_MAX_COUNT + 5 }, (_, i) => `t${i}`);
  assert.equal(normalizeTags(many).length, TAG_MAX_COUNT);
});

test('T-2 matchTags：空 wanted 恒 true（防注入路径全灭），any/all 与大小写', () => {
  assert.equal(matchTags(['work'], []), true, '不传标签=不过滤');
  assert.equal(matchTags([], undefined), true);
  assert.equal(matchTags(['work', 'home'], ['WORK']), true, 'any 默认，大小写不敏感');
  assert.equal(matchTags(['work'], ['work', 'home'], 'any'), true);
  assert.equal(matchTags(['work'], ['work', 'home'], 'all'), false);
  assert.equal(matchTags(['work', 'HOME'], ['work', 'home'], 'all'), true);
  assert.equal(matchTags([], ['work']), false);
});

test('T-3 tagPatternMatch：包含与 * 通配（大小写不敏感）', () => {
  assert.equal(tagPatternMatch('user:alice', ''), true);
  assert.equal(tagPatternMatch('user:alice', 'ALICE'), true);
  assert.equal(tagPatternMatch('user:alice', 'user:*'), true);
  assert.equal(tagPatternMatch('role-admin', '*-admin'), true);
  assert.equal(tagPatternMatch('user:alice', 'home:*'), false);
});

test('T-4 tagHistogram：count 降序 / tag 升序 / 通配 / 分页，输入是纯的', () => {
  const rows = [
    { tags: ['work', 'home'] },
    { tags: ['WORK', 'urgent'] },
    { tags: ['home'] },
    { tags: [] },
  ];
  const snapshot = JSON.stringify(rows);
  const h = tagHistogram(rows);
  assert.deepEqual(h.items.map((x) => x.tag), ['home', 'work', 'urgent'], '同 count 时 tag 升序');
  assert.deepEqual(h.items.map((x) => x.count), [2, 2, 1]);
  assert.equal(h.total, 3);
  assert.deepEqual(tagHistogram(rows, { pattern: 'h*' }).items.map((x) => x.tag), ['home']);
  assert.deepEqual(tagHistogram(rows, { limit: 1, offset: 1 }).items.map((x) => x.tag), ['work']);
  assert.equal(tagHistogram(rows, { limit: 0 }).items.length, 0, 'limit=0 是显式不返回，不是缺省');
  /** 大小写去重按小写比，但展示保留首次出现的原样（同 Hindsight） */
  assert.deepEqual(tagHistogram([{ tags: ['Home', 'home'] }]).items, [{ tag: 'Home', count: 1 }]);
  assert.equal(JSON.stringify(rows), snapshot, '纯函数不改输入');
});

/* ---------------- 存储层 ---------------- */

test('T-5 add 落盘 tags，老库不传则不写字段（逐字节不变）', async () => {
  const { dir, done } = boot();
  try {
    const m = createMemory();
    assert.equal(m.add('g1', '老库一句话', 'global'), true);
    const before = readFileSync(join(dir, 'memory.json'), 'utf8');
    assert.ok(!before.includes('"tags"'), '老库新增事实不带 tags 字段');

    assert.equal(m.add('g1', '主人喜欢跑步', 'global', { tags: ['健康', 'Habit'] }), true);
    const after = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    assert.deepEqual(after.meta.global['主人喜欢跑步'].tags, ['健康', 'Habit']);
    const f = m.listFull('g1').global.find((x) => x.text === '主人喜欢跑步');
    assert.deepEqual(f.tags, ['健康', 'Habit']);
    assert.deepEqual(m.listFull('g1').global.find((x) => x.text === '老库一句话').tags, []);

    /** 重提一次：没给 tags 就保留；给了空数组就清空 */
    m.add('g1', '主人喜欢跑步', 'global');
    assert.deepEqual(m.listFull('g1').global.find((x) => x.text === '主人喜欢跑步').tags, ['健康', 'Habit']);
    m.add('g1', '主人喜欢跑步', 'global', { tags: [] });
    assert.deepEqual(m.listFull('g1').global.find((x) => x.text === '主人喜欢跑步').tags, []);
  } finally { done(); }
});

test('T-6 editFact 打标签/清空，复用写入口不改 personaScope PLAN', async () => {
  const { done } = boot();
  try {
    const m = createMemory();
    m.add('g1', '住在杭州', 'global');
    const r = m.editFact('g1', 'global', '住在杭州', { tags: ['城市', 'home'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.tags, ['城市', 'home']);
    assert.deepEqual(m.listFull('g1').global.find((x) => x.text === '住在杭州').tags, ['城市', 'home']);
    m.editFact('g1', 'global', '住在杭州', { tags: [] });
    assert.deepEqual(m.listFull('g1').global.find((x) => x.text === '住在杭州').tags, []);
    /** 不新增 store 方法 —— PLAN 无需登记新项 */
    assert.equal(PLAN.memory.editFact[2], 'write');
  } finally { done(); }
});

test('T-7 listFull / listRanked 的 any/all 过滤，默认逐字不变', async () => {
  const { done } = boot();
  try {
    const m = createMemory();
    m.add('g1', '工作日要早起', 'global', { tags: ['work', 'habit'] });
    m.add('g1', '周末睡懒觉', 'global', { tags: ['rest'] });
    m.add('g1', '没有标签的一句', 'global');

    assert.equal(m.listFull('g1').global.length, 3, '默认不过滤');
    assert.equal(m.listRanked('g1').global.length, 3, '注入路径默认不过滤');
    assert.deepEqual(m.listFull('g1', [], { tags: ['WORK'] }).global.map((x) => x.text), ['工作日要早起']);
    assert.equal(m.listFull('g1', [], { tags: ['work', 'rest'], tagsMode: 'all' }).global.length, 0);
    assert.equal(m.listFull('g1', [], { tags: ['work', 'habit'], tagsMode: 'all' }).global.length, 1);
    assert.deepEqual(m.listRanked('g1', [], { tags: ['rest'] }).global, ['周末睡懒觉']);
    assert.equal(m.listRanked('g1', [], { tags: ['nope'] }).global.length, 0);
  } finally { done(); }
});

test('T-8 四处白名单回环：打标签 → 清理导出 → dry-run → 备份还原 → 标签仍在', async () => {
  const { dir, done } = boot();
  try {
    const m1 = createMemory();
    m1.add('g1', '带标签的事实', 'global', { tags: ['work'] });
    const entries = m1.retention.entries();
    assert.deepEqual(entries[0].tags, ['work'], 'entries 导出标签');
    const normalized = entries.map((e) => normalizeEntry(e, 'facts', e.chatId));
    assert.deepEqual(normalized[0].tags, ['work'], 'dry-run 归一化不吞标签');

    const result = restoreRetentionRows({
      payload: { facts: normalized, journal: [] },
      memory: m1, journal: { get: () => null, insertRaw: () => true },
    });
    assert.equal(result.facts, 0, '同库已存在，跳过（不重复插入）');

    /** 换一个空目录还原（同目录会读到 m1 已写的数据，insertRaw 判重复直接跳过） */
    const dir2 = mkdtempSync(join(tmpdir(), 'roost-tags-restore-'));
    process.env.DSH_ROOST_DATA = dir2;
    const m2 = createMemory();
    const r2 = restoreRetentionRows({
      payload: { facts: normalized, journal: [] },
      memory: m2, journal: { get: () => null, insertRaw: () => true },
    });
    assert.equal(r2.facts, 1, '一条事实还原');
    const restored = m2.listFull('g1').global.find((x) => x.text === '带标签的事实');
    assert.deepEqual(restored.tags, ['work'], '还原后标签不丢');
    const onDisk = JSON.parse(readFileSync(join(dir2, 'memory.json'), 'utf8'));
    assert.deepEqual(onDisk.meta.global['带标签的事实'].tags, ['work'], '标签真的落盘了');
  } finally { done(); }
});

test('T-9 personaScope：人格隔离开启后标签写到物理键，按逻辑键可读', async () => {
  const { dir, done } = boot();
  try {
    const scope = createPersonaScope({
      cfgOf: () => ({ persona: { scope: { enabled: true } } }),
      personaOf: (id) => (String(id) === 'g1' ? 'alice' : ''),
      ownership: { get: () => ({ policy: 'shared', owner: '', byChat: {}, marks: {} }), save: () => ({ ok: true }) },
    });
    const m = scope.wrapMemory(createMemory());
    m.add('g1', '爱丽丝的喜好', 'chat', { tags: ['alice'] });
    m.editFact('g1', 'chat', '爱丽丝的喜好', { tags: ['alice', 'music'] });
    const got = m.listFull('g1').chat.find((x) => x.text === '爱丽丝的喜好');
    assert.deepEqual(got?.tags, ['alice', 'music'], '隔离开启后仍按逻辑键打到同一条');
    const onDisk = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    const phys = scope.scopeKey('g1');
    assert.deepEqual(onDisk.meta.chats?.[phys]?.['爱丽丝的喜好']?.tags, ['alice', 'music'], '落在物理键下');
    assert.ok(!onDisk.chats?.g1, '不落在逻辑键下');
  } finally { done(); }
});
