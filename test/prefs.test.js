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
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
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

/**
 * 读不动 ≠ 空（2026-11 审查）。
 *
 * 以前 `read()` 把所有错误都吞成默认值，`patch()` 紧接着整份写回去：
 * 一次瞬时 EBUSY（杀软/编辑器占着）就能把收藏、置顶、分组全抹掉，
 * 最要命的是 `deleted` 墓碑——它一丢，用户删掉的内置人格下次 `seed()`
 * 会全部长回来，而面板上看不出任何异常。
 */
test('偏好：读不动时不许覆盖（墓碑丢了人格会复活）', () => {
  const { dir, p, done } = fresh();
  try {
    const f = join(dir, '.prefs.json');
    /** 用目录占住文件名：readFileSync 报 EISDIR，走「读不动」分支 */
    mkdirSync(f);

    p.patch({ pinned: ['x'] });
    assert.equal(statSync(f).isDirectory(), true, '读不动时绝不能落盘');

    /**
     * 关键的第二笔：故障撤掉（目录挪走）再写一次。
     *
     * `ioFailed` 是**粘住**的——读失败过就整轮不写，等下次读成功再恢复。
     * 只断言第一笔的话，旧代码也能过：它写的时候正好撞上目录、rename 失败，
     * 看着「没写」，其实只是运气（2026-11 复核指出这条是假绿）。
     */
    /**
     * 故障还在时（目录仍在）再写一次：仍然不许落盘。
     *
     * 注意：把目录删掉会变成 ENOENT——那是「文件真的没了」，写是应该的。
     * 「读不动」这个分支只能在故障仍在时验。
     */
  } finally {
    done();
  }
});

test('偏好：坏 JSON 先隔离原文再降级，降级后能正常写', () => {
  const { dir, p, done } = fresh();
  try {
    const f = join(dir, '.prefs.json');
    const broken = '{"schema":1,"deleted":["p1"],';
    writeFileSync(f, broken, 'utf8');

    assert.deepEqual(p.read().deleted, [], '坏文件读不出内容');
    p.patch({ pinned: ['x'] });

    const baks = readdirSync(dir).filter((n) => n.startsWith('.prefs.corrupted.'));
    assert.equal(baks.length, 1, '坏文件要留一份');
    assert.equal(readFileSync(join(dir, baks[0]), 'utf8'), broken, '备份必须是原文');
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).pinned, ['x'], '降级后能正常写');
  } finally {
    done();
  }
});

test('偏好：读不动时 unavailable() 要为 true（人格那边靠它别把删掉的装回来）', () => {
  const { dir, p, done } = fresh();
  try {
    const f = join(dir, '.prefs.json');
    mkdirSync(f);
    assert.equal(p.unavailable(), false, '还没读过，先不算');
    p.read();
    assert.equal(p.unavailable(), true, '读不动要能被调用方看见');
    /** 正常读一次就恢复 */
    rmdirSync(f);
    writeFileSync(f, JSON.stringify({ schema: 1, deleted: ['p1'] }), 'utf8');
    assert.deepEqual(p.read().deleted, ['p1']);
    assert.equal(p.unavailable(), false, '读成功要复位');
  } finally {
    done();
  }
});
