/**
 * G8 老库一次性适配（schema v1→v2）：给 fact meta 补注入热度字段。
 * 核心护栏：①不推算历史（全给 0/空）②幂等 ③老库只读不改盘、migrateIfNeeded 才落盘
 * ④高版本文件不降级 ⑤字段在四处白名单往返不丢。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, MEMORY_SCHEMA_VERSION } from '../src/memory.js';

const noop = () => {};
function fresh(raw) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-schema-v2-'));
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  if (raw !== undefined) writeFileSync(join(dir, 'memory.json'), JSON.stringify(raw), 'utf8');
  return {
    dir,
    memory: () => createMemory({ log: noop, now: () => Date.parse('2026-11-24T12:00:00') }),
    done: () => {
      if (old === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = old;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** 一份典型 v1 老库：有 meta，但没有热度字段 */
const V1 = {
  global: ['主人住杭州', '重要的事'],
  chats: { g1: ['群里聊游戏'] },
  meta: {
    global: {
      '主人住杭州': { w: 2, at: 1700000000000 },
      '重要的事': { w: 1, at: 1700000000000, reviewedAt: 1700000100000 },
    },
    chats: { g1: { '群里聊游戏': { w: 1, at: 1700000000000 } } },
  },
  personas: {}, authz: {},
};

test('v1 老库 migrateIfNeeded：补 hitDays=0/lastHitDay=""/lastHit=0，不推算历史', () => {
  const f = fresh(V1);
  try {
    const m = f.memory();
    const r = m.migrateIfNeeded();
    assert.equal(r.migrated, true, '首次应迁移落盘');
    const disk = JSON.parse(readFileSync(join(f.dir, 'memory.json'), 'utf8'));
    assert.equal(disk.schemaVersion, 2, '落盘打 v2 标记');
    for (const text of ['主人住杭州', '重要的事']) {
      const x = disk.meta.global[text];
      assert.equal(x.hitDays, 0, `${text} hitDays 补 0`);
      assert.equal(x.lastHitDay, '');
      assert.equal(x.lastHit, 0);
      assert.equal(x.w, V1.meta.global[text].w, '原有字段不动');
    }
    assert.equal(disk.meta.chats.g1['群里聊游戏'].hitDays, 0, 'chat scope 也补');
  } finally { f.done(); }
});

test('幂等：schemaVersion=2 的库不再迁移，逐字节不变', () => {
  const v2 = { ...V1, schemaVersion: 2, meta: { ...V1.meta, global: { '主人住杭州': { w: 2, at: 1700000000000, hitDays: 3, lastHitDay: '2026-11-20', lastHit: 111 } } } };
  const f = fresh(v2);
  try {
    const before = readFileSync(join(f.dir, 'memory.json'), 'utf8');
    const m = f.memory();
    assert.equal(m.migrateIfNeeded().migrated, false, 'v2 不迁移');
    assert.equal(readFileSync(join(f.dir, 'memory.json'), 'utf8'), before, '不写盘，逐字节不变');
    assert.equal(m.heatOf(['主人住杭州'])['主人住杭州'].hitDays, 3, '已有热度不被覆盖');
  } finally { f.done(); }
});

test('新装空库：migrateIfNeeded 不误写、schemaVersion 正常', () => {
  const f = fresh();
  try {
    const m = f.memory();
    assert.equal(m.migrateIfNeeded().migrated, false, '无老库可读，不做迁移');
    m.add('g1', '新事实');
    const disk = JSON.parse(readFileSync(join(f.dir, 'memory.json'), 'utf8'));
    assert.equal(disk.schemaVersion, 2, '首次写入就是 v2');
    assert.equal(disk.meta.global['新事实'].hitDays, undefined, '新事实没有热度字段（等真实注入才涨）');
  } finally { f.done(); }
});

test('高版本文件不被降级（v99 隔离，migrate 不碰）', () => {
  const f = fresh({ ...V1, schemaVersion: 99 });
  try {
    const before = readFileSync(join(f.dir, 'memory.json'), 'utf8');
    const m = f.memory();
    assert.equal(m.migrateIfNeeded().migrated, false);
    assert.equal(readFileSync(join(f.dir, 'memory.json'), 'utf8'), before, '高版本原样保留');
  } finally { f.done(); }
});

test('v1 无 meta 的极老库：迁移不崩，不凭空造 meta 键', () => {
  const f = fresh({ global: ['一句话'], chats: {}, personas: {}, authz: {} });
  try {
    const m = f.memory();
    assert.equal(m.migrateIfNeeded().migrated, true);
    const disk = JSON.parse(readFileSync(join(f.dir, 'memory.json'), 'utf8'));
    assert.equal(disk.schemaVersion, 2);
    assert.equal(disk.meta?.global?.['一句话'], undefined, '没有 meta 就不造');
  } finally { f.done(); }
});

test('bumpHeat 写回的热度在 migrate 后仍可读（heatOf 往返）', () => {
  const f = fresh(V1);
  try {
    const m = f.memory();
    m.migrateIfNeeded();
    const n = m.bumpHeat([{ text: '主人住杭州', hitDays: 5, lastHitDay: '2026-11-24', lastHit: 1700000000000 }]);
    assert.equal(n, 1, '只写存在的正文');
    assert.equal(m.bumpHeat([{ text: '不存在的事实', hitDays: 9, lastHitDay: 'x', lastHit: 1 }]), 0, '不存在的正文不写');
    const heat = m.heatOf(['主人住杭州']);
    assert.equal(heat['主人住杭州'].hitDays, 5);
    assert.equal(heat['主人住杭州'].lastHitDay, '2026-11-24');
  } finally { f.done(); }
});
