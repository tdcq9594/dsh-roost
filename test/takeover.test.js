// 收窄版接管（A4）：只准改 seeds，白名单外一律拒，带冷却与变更历史。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTakeoverStore, TAKEOVER_KEYS } from '../src/takeover.js';

const mk = (cooldownMin = 60) => {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-'));
  return { dir, s: createTakeoverStore({ file: join(dir, 'takeover.json'), cooldownMin }) };
};

test('默认关、只认 seeds 一个键', () => {
  const { dir, s } = mk();
  try {
    assert.equal(s.status().on, false);
    assert.deepEqual(TAKEOVER_KEYS, ['seeds']);
    const r = s.propose('seeds', ['试试']);
    assert.equal(r.ok, false, '没开不许改');
    assert.match(r.why, /没开/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('白名单外字段一律拒（权限/配置/工具不给她碰）', () => {
  const { dir, s } = mk();
  try {
    s.setOn(true);
    for (const key of ['allowAct', 'permissions', 'tools', 'constraintRules', 'speakUp']) {
      const r = s.propose(key, ['x']);
      assert.equal(r.ok, false, `${key} 必须拒`);
      assert.match(r.why, /不许她改/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('开了之后能改 seeds，带形状钳制与变更历史', () => {
  const { dir, s } = mk();
  try {
    s.setOn(true);
    const r = s.propose('seeds', [' 学做饭 ', '', 'x'.repeat(300)], 1000);
    assert.equal(r.ok, true);
    assert.deepEqual(r.patch.seeds, ['学做饭', 'x'.repeat(200)]);
    const st = s.status();
    assert.equal(st.lastAt, 1000);
    assert.equal(st.history.length, 1);
    assert.deepEqual(st.history[0].after, r.patch.seeds);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('冷却：改完立刻再改被拦，关掉再开也还留 lastAt', () => {
  const { dir, s } = mk(60);
  try {
    s.setOn(true);
    assert.equal(s.propose('seeds', ['一'], 1000).ok, true);
    const second = s.propose('seeds', ['二'], 1000 + 30 * 60_000);
    assert.equal(second.ok, false);
    assert.match(second.why, /冷却/);
    s.setOn(false); s.setOn(true);
    assert.equal(s.propose('seeds', ['三'], 1000 + 30 * 60_000).ok, false, '开关不重置冷却');
    assert.equal(s.propose('seeds', ['四'], 1000 + 61 * 60_000).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
