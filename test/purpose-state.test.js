// 目的引擎状态层：四块形状、原子写、快照回滚、坏文件降级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPurposeState, normalizeState, normalizeDrives, DEFAULT_DRIVES,
  DRIVE_KEYS, GOAL_STATUSES, STATE_FILE,
} from '../src/purpose-state.js';

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ } };
const tmp = () => mkdtempSync(join(tmpdir(), 'roost-purpose-'));

test('驱力归一化：九键齐全、越界夹紧、未知键丢掉', () => {
  const d = normalizeDrives({ play: 5, care: -1, identity: 0.4, bogus: 1 });
  assert.equal(Object.keys(d).length, 9);
  assert.equal(d.play, 1);
  assert.equal(d.care, 0);
  assert.equal(d.identity, 0.4);
  assert.equal('bogus' in d, false);
  assert.deepEqual(Object.keys(normalizeDrives()), DRIVE_KEYS.slice());
});

test('整份归一化：目标四归属六态、证据 id 保留、坏字段降级', () => {
  const s = normalizeState({
    drives: { play: 0.9 },
    goals: [{ id: 'g1', owner: 'owner', status: 'active', evidenceIds: ['w1', 42, ''] }],
    feedback: [{ kind: 'confirmed', goalId: 'g1' }],
    observations: [{ key: '玩', count: 2 }],
  });
  assert.equal(s.drives.play, 0.9);
  assert.equal(s.drives.learn, DEFAULT_DRIVES.learn);
  assert.equal(s.goals[0].owner, 'owner');
  assert.ok(GOAL_STATUSES.includes(s.goals[0].status));
  assert.deepEqual(s.goals[0].evidenceIds, ['w1', '42']);
  assert.equal(s.feedback[0].kind, 'confirmed');
});

test('写盘 + 快照回滚：.prev 只留上一版，回滚真把状态退回去', () => {
  const dir = tmp();
  try {
    const p = createPurposeState({ dir });
    assert.equal(p.write((s) => { s.drives.play = 0.8; return s; }).ok, true);
    assert.equal(existsSync(join(dir, STATE_FILE)), true, '首次写前没有 .prev 也照写');
    assert.equal(p.write((s) => { s.drives.play = 0.2; return s; }).ok, true);
    assert.equal(existsSync(join(dir, `${STATE_FILE}.prev`)), true);
    assert.equal(p.read().drives.play, 0.2);
    const r = p.rollback();
    assert.equal(r.ok, true);
    assert.equal(p.read().drives.play, 0.8, '回滚要拿回上一版，不是当前版');
  } finally { cleanup(dir); }
});

test('坏文件降级为空状态，不让宿主启动失败', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, STATE_FILE), '{ 这不是 JSON', 'utf8');
    const p = createPurposeState({ dir });
    const s = p.read();
    assert.equal(Object.keys(s.drives).length, 9);
    assert.deepEqual(s.goals, []);
  } finally { cleanup(dir); }
});
