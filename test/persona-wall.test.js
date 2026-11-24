/**
 * 阶段6 人物墙管理深度：profiles 数据模型扩展。
 * 对齐 aurabot /persona/person/save 的字段与护栏，但复用我方现有字段
 * （impression/tips/dislikes），只新增 tags/alias/noMemory。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfiles, normalizePersonTags, PERSON_TAGS_MAX } from '../src/profiles.js';

function fresh(seed = []) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-personwall-'));
  const file = join(dir, 'profiles.json');
  writeFileSync(file, JSON.stringify(seed), 'utf8');
  return {
    file,
    store: () => createProfiles({ file, now: () => 1700000000000 }),
    done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

const SEED = [{ key: 'u123', name: '小明', impression: '爱打球', tips: '聊球他话多', dislikes: '', at: 1, hits: 3 }];

test('normalizePersonTags：规范化与护栏', () => {
  assert.deepEqual(normalizePersonTags(['喜欢', '  猫  ']), { ok: true, tags: ['喜欢', '猫'] });
  assert.deepEqual(normalizePersonTags('喜欢,猫'), { ok: true, tags: ['喜欢', '猫'] });
  assert.equal(normalizePersonTags(['喜欢', '喜欢']).ok, false);
  assert.equal(normalizePersonTags(['喜欢', '讨厌']).ok, false);
  assert.equal(normalizePersonTags(['讨厌'], { isOwner: true }).ok, false);
  assert.equal(normalizePersonTags(['讨厌'], { isOwner: false }).ok, true);
  assert.equal(normalizePersonTags(Array(PERSON_TAGS_MAX + 1).fill('x')).ok, false);
  assert.equal(normalizePersonTags(['这是一个超长的标签']).ok, false);
});

test('edit：只覆盖给定字段，模型字段原样留', () => {
  const f = fresh(SEED);
  try {
    const p = f.store();
    const r = p.edit('u123', { impression: '爱打篮球', tags: ['喜欢', '球友'] });
    assert.equal(r.ok, true);
    const row = p.recent(0)[0];
    assert.equal(row.impression, '爱打篮球');
    assert.equal(row.tips, '聊球他话多'); // 没给的字段留着
    assert.deepEqual(row.tags, ['喜欢', '球友']);
    assert.equal(row.tagsBy, 'owner');
  } finally { f.done(); }
});

test('edit：空 patch 不写盘；不存在的人报错', () => {
  const f = fresh(SEED);
  try {
    const p = f.store();
    assert.equal(p.edit('u123', {}).ok, false);
    assert.equal(p.edit('nobody', { impression: 'x' }).ok, false);
  } finally { f.done(); }
});

test('edit：标签护栏生效（重复/互斥/主人）', () => {
  const f = fresh(SEED);
  try {
    const p = f.store();
    assert.match(p.edit('u123', { tags: ['喜欢', '讨厌'] }).message, /不能同时/);
    assert.match(p.edit('u123', { tags: ['讨厌'] }, { isOwner: true }).message, /主人/);
  } finally { f.done(); }
});

test('edit/setNoMemory 当场作废渲染缓存：改完立刻生效不等跨天', () => {
  const f = fresh(SEED);
  try {
    const p = f.store();
    const before = p.text({ enabled: true, day: '2026-01-01' });
    assert.match(before, /爱打球/);
    p.edit('u123', { impression: '改过了' });
    const after = p.text({ enabled: true, day: '2026-01-01' });
    assert.match(after, /改过了/);
    assert.doesNotMatch(after, /爱打球/);
    p.setNoMemory('u123', true);
    assert.equal(p.recent(0)[0].noMemory, true);
    p.setNoMemory('u123', false);
    assert.equal(p.recent(0)[0].noMemory, undefined);
  } finally { f.done(); }
});

test('edit 写盘持久化（新 store 实例读回）', () => {
  const f = fresh(SEED);
  try {
    f.store().edit('u123', { alias: '小明明', tags: ['球友'] });
    const row = f.store().recent(0)[0];
    assert.equal(row.alias, '小明明');
    assert.deepEqual(row.tags, ['球友']);
    const raw = JSON.parse(readFileSync(f.file, 'utf8'));
    assert.equal(raw[0].tagsBy, 'owner');
  } finally { f.done(); }
});

test('G7：edit 支持 style/persona 独立维度，字数上限对齐对方 40', () => {
  const f = fresh([{ key: 'u1', name: '小明', impression: '爱打球', at: 1 }]);
  try {
    const p = f.store();
    const r = p.edit('u1', { style: '说话直来直去', persona: '急性子但热心' });
    assert.equal(r.ok, true, r.message);
    const row = p.recent()[0];
    assert.equal(row.style, '说话直来直去');
    assert.equal(row.persona, '急性子但热心');
    // 超长截断到 40 码点
    const long = '字'.repeat(60);
    p.edit('u1', { style: long });
    assert.equal(Array.from(p.recent()[0].style).length, 40);
    // 只改 style 不丢 persona
    assert.equal(p.recent()[0].persona, '急性子但热心');
  } finally { f.done(); }
});

test('G7：note 可记 style/persona，空串不覆盖；render 注入稳定段', () => {
  const f = fresh();
  try {
    const p = f.store();
    p.note({ who: '小明', openid: 'u2', impression: '爱打球', style: '话少', persona: '沉稳' });
    let row = p.recent()[0];
    assert.equal(row.style, '话少');
    assert.equal(row.persona, '沉稳');
    p.note({ who: '小明', openid: 'u2', style: '' }); // 空串不覆盖
    row = p.recent()[0];
    assert.equal(row.style, '话少');
    assert.match(p.text(), /性格：沉稳/);
    assert.match(p.text(), /说话方式：话少/);
  } finally { f.done(); }
});

test('G7：handle 沿用 tips，不另造同义字段（对方 handle≈我方 tips）', () => {
  const f = fresh([{ key: 'u3', name: '小红', tips: '先给结论', at: 1 }]);
  try {
    const p = f.store();
    assert.equal(p.recent()[0].tips, '先给结论');
    // edit 里 tips 仍可改（handle 语义由它承载）
    assert.equal(p.edit('u3', { tips: '喜欢被夸' }).ok, true);
    assert.equal(p.recent()[0].tips, '喜欢被夸');
  } finally { f.done(); }
});
