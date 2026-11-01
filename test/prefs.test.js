/**
 * 用户态偏好（.prefs.json）的测试。
 *
 * 盯两件事：
 *   1. **坏文件不能让插件起不来**——偏好丢了顶多收藏没了，抛错是灾难；
 *   2. **写之前要留 .bak**——它是「同步永不碰」的那份数据，得能回滚一次。
 *
 * 跑法：node --test test/prefs.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPrefs } from '../src/prefs.js';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-prefs-'));
  return { dir, p: createPrefs({ dir: () => dir }), done: () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} } };
}

test('偏好：没有文件时给默认值（空数组 / 空对象，不是 undefined）', () => {
  const { p, done } = fresh();
  try {
    const r = p.read();
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.fav, []);
    assert.deepEqual(r.pinned, []);
    assert.deepEqual(r.folders, {});
    assert.deepEqual(r.usage, {});
    assert.deepEqual(r.installedAs, {});
  } finally {
    done();
  }
});

test('偏好：patch 只改给定的键，其它不动', () => {
  const { p, done } = fresh();
  try {
    p.patch({ fav: ['a'], pinned: ['b'] });
    const r = p.patch({ fav: ['a', 'c'] });
    assert.deepEqual(r.fav, ['a', 'c'], '数组整体替换');
    assert.deepEqual(r.pinned, ['b'], '没给的键不许动');
  } finally {
    done();
  }
});

test('偏好：对象是浅合并一层（写 usage.a 不会冲掉 usage.b）', () => {
  const { p, done } = fresh();
  try {
    p.patch({ usage: { a: { useCount: 1 } } });
    const r = p.patch({ usage: { b: { useCount: 2 } } });
    assert.equal(r.usage.a.useCount, 1);
    assert.equal(r.usage.b.useCount, 2);
  } finally {
    done();
  }
});

test('偏好：文件坏掉时返回默认值，不抛错', () => {
  const { dir, p, done } = fresh();
  try {
    writeFileSync(join(dir, '.prefs.json'), 'not json at all', 'utf8');
    assert.doesNotThrow(() => p.read());
    assert.deepEqual(p.read().deleted, []);
  } finally {
    done();
  }
});

test('偏好：写之前留一份 .prefs.bak（能回滚一次）', () => {
  const { dir, p, done } = fresh();
  try {
    p.patch({ fav: ['a'] });
    assert.equal(existsSync(join(dir, '.prefs.bak')), false, '第一次写没有旧文件，不该有 bak');

    p.patch({ fav: ['b'] });
    assert.ok(existsSync(join(dir, '.prefs.bak')), '第二次写要把上一份留成 bak');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.prefs.bak'), 'utf8')).fav, ['a']);
  } finally {
    done();
  }
});

test('偏好：坏文件不会把 .bak 盖成坏内容（最后一道保险不能跟着坏）', () => {
  const { dir, p, done } = fresh();
  try {
    p.patch({ fav: ['a'] });
    p.patch({ fav: ['b'] }); // 此时 bak 里是 ['a']
    writeFileSync(join(dir, '.prefs.json'), '{"fav":[', 'utf8'); // 模拟写一半断电
    p.patch({ fav: ['c'] });

    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.prefs.bak'), 'utf8')).fav, ['a'], '.bak 被坏内容盖掉了');
    assert.deepEqual(p.read().fav, ['c'], '坏文件按默认值处理后仍能继续写');
  } finally {
    done();
  }
});

test('偏好：deleted / installedAs 能持久化（墓碑和撞名映射都靠它）', () => {
  const { dir, p, done } = fresh();
  try {
    p.patch({ deleted: ['fatfish'], installedAs: { fatfish: 'tdcq__fatfish' } });
    const again = createPrefs({ dir: () => dir });
    assert.deepEqual(again.read().deleted, ['fatfish']);
    assert.equal(again.read().installedAs.fatfish, 'tdcq__fatfish');
  } finally {
    done();
  }
});
