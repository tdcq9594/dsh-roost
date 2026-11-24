/**
 * 阶段8：facts 因果链真指针。
 * 老库推断路径由 memory-history.test.js 钉住不动；这里钉新库写指针 +
 * 四处白名单回环 + history 的 linked 模式。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, factIdOf } from '../src/memory.js';
import { historyOf } from '../src/memory-history.js';
import { restoreRetentionRows } from '../src/backup.js';
import { normalizeEntry } from '../src/dry-run.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-causal-'));
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  const file = join(dir, 'memory.json');
  writeFileSync(file, JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} }, personas: {}, authz: {} }), 'utf8');
  return {
    dir, file,
    done: () => {
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

test('supersede 给旧条目写 supersededBy = 新条目稳定 id', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.add('', '主人住在杭州市', 'global', { status: 'fact' });
    const raw = JSON.parse(readFileSync(f.file, 'utf8'));
    const oldMeta = raw.meta.global['主人住在杭州'];
    assert.equal(typeof oldMeta.until, 'number', '旧条目应有 until');
    assert.equal(oldMeta.supersededBy, factIdOf('主人住在杭州市'), '应指向新条目 id');
  } finally { f.done(); }
});

test('historyOf：有指针 = linked 真链（inferred:false），不再靠猜', () => {
  const rows = [
    { id: factIdOf('主人住在杭州'), text: '主人住在杭州', until: 2000, at: 1000, supersededBy: factIdOf('主人住在杭州市') },
    { id: factIdOf('主人住在杭州市'), text: '主人住在杭州市', at: 2000 },
  ];
  const got = historyOf(rows, factIdOf('主人住在杭州市'), { now: 3000 });
  assert.equal(got.mode, 'linked');
  assert.equal(got.earlier.length, 1);
  assert.equal(got.earlier[0].inferred, false);
  assert.equal(got.earlier[0].text, '主人住在杭州');
  assert.match(got.note, /确凿/);
});

test('historyOf：老库无指针仍走 inferred（不回归 memory-history.test.js 的口径）', () => {
  const rows = [
    { id: 'a', text: '主人住在杭州', until: 2000, at: 1000 },
    { id: 'b', text: '主人住在杭州市', at: 2000 },
  ];
  const got = historyOf(rows, 'b', { now: 3000 });
  assert.equal(got.mode, 'inferred');
  assert.equal(got.earlier[0].inferred, true);
  assert.match(got.note, /不等于因果/);
});

test('四处白名单：entries/insertRaw/backup/dry-run 都保 supersededBy', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => 1000, log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.add('', '主人住在杭州市', 'global', { status: 'fact' });
    const entries = m.retention.entries();
    const row = entries.find((e) => e.text === '主人住在杭州');
    assert.equal(row.supersededBy, factIdOf('主人住在杭州市'), 'retention.entries 要导出');

    // dry-run normalizeEntry（target='facts'）
    const norm = normalizeEntry({ ...row }, 'facts');
    assert.equal(norm.supersededBy, row.supersededBy, 'dry-run 白名单要保');

    // backup restoreRetentionRows：捕获 insertRaw 收到的 row
    let inserted = null;
    const fakeMemory = { retention: { entries: () => [] }, insertRaw: (r) => { inserted = r; return true; } };
    restoreRetentionRows({ payload: { facts: [row], journal: [] }, memory: fakeMemory, journal: {} });
    assert.equal(inserted?.supersededBy, row.supersededBy, 'backup 白名单要保');

    // insertRaw 落盘
    const f2 = fresh();
    try {
      const m2 = createMemory({ now: () => 1000, log: () => {} });
      m2.insertRaw(row);
      const raw = JSON.parse(readFileSync(f2.file, 'utf8'));
      assert.equal(raw.meta.global['主人住在杭州'].supersededBy, row.supersededBy, 'insertRaw 要落盘');
    } finally { f2.done(); }
  } finally { f.done(); }
});

test('G8 四处白名单：entries/normalizeEntry/backup/insertRaw 都保注入热度字段', () => {
  const f = fresh();
  try {
    const m = createMemory({ now: () => Date.parse('2026-11-24T12:00:00'), log: () => {} });
    m.add('', '主人住在杭州', 'global', { status: 'fact' });
    m.bumpHeat([{ text: '主人住在杭州', hitDays: 7, lastHitDay: '2026-11-24', lastHit: 1700000000000 }]);

    // 1) retention.entries 导出
    const row = m.retention.entries().find((e) => e.text === '主人住在杭州');
    assert.equal(row.hitDays, 7, 'entries 导出 hitDays');
    assert.equal(row.lastHitDay, '2026-11-24');
    assert.equal(row.lastHit, 1700000000000);

    // 2) dry-run normalizeEntry 保
    const norm = normalizeEntry({ ...row }, 'facts');
    assert.equal(norm.hitDays, 7, 'dry-run 白名单保 hitDays');
    assert.equal(norm.lastHitDay, '2026-11-24');
    assert.equal(norm.lastHit, 1700000000000);

    // 3) backup restoreRetentionRows 保
    let inserted = null;
    const fakeMemory = { retention: { entries: () => [] }, insertRaw: (r) => { inserted = r; return true; } };
    restoreRetentionRows({ payload: { facts: [row], journal: [] }, memory: fakeMemory, journal: {} });
    assert.equal(inserted?.hitDays, 7, 'backup 白名单保 hitDays');
    assert.equal(inserted?.lastHitDay, '2026-11-24');
    assert.equal(inserted?.lastHit, 1700000000000);

    // 4) insertRaw 落盘
    const f2 = fresh();
    try {
      const m2 = createMemory({ now: () => 1000, log: () => {} });
      m2.insertRaw(row);
      const raw = JSON.parse(readFileSync(f2.file, 'utf8'));
      const meta = raw.meta.global['主人住在杭州'];
      assert.equal(meta.hitDays, 7, 'insertRaw 落盘 hitDays');
      assert.equal(meta.lastHitDay, '2026-11-24');
      assert.equal(meta.lastHit, 1700000000000);
    } finally { f2.done(); }
  } finally { f.done(); }
});
