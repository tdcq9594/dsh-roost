/**
 * 人格目录（catalog）的测试。
 *
 * 盯的是三件会让「改完人格不生效」的事：
 *   1. **增量失效**——改过的文件没被重读，列表里还是旧名字；
 *   2. **外部编辑漏检**——用户用编辑器改完，catalog 还以为没变；
 *   3. **字数口径**——用 body 长度而不是原文长度，面板上会看到两个数字。
 *
 * 跑法：node --test test/catalog.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, utimesSync, existsSync, renameSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCatalog, hashText } from '../src/catalog.js';
import { parsePersona } from '../src/personas.js';

function fresh(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-cat-'));
  mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(join(dir, n), t, 'utf8');
  return { dir, done: () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} } };
}

const cat = (dir, parse = parsePersona) => createCatalog({ dir: () => dir, parse });

test('目录：扫出所有 md，chars 是整份原文长度（不是 body）', () => {
  const { dir, done } = fresh({
    'a.md': '---\nname: 甲\n---\n正文\n\n## 说话示例\n甲：在\n',
    'b.md': '---\nname: 乙\n---\n只有一句。',
  });
  try {
    const items = cat(dir).scan().items;
    assert.equal(Object.keys(items).length, 2);
    assert.equal(items.a.name, '甲');
    assert.equal(items.a.chars, readFileSync(join(dir, 'a.md'), 'utf8').length);
    assert.ok(items.a.chars > parsePersona('a', readFileSync(join(dir, 'a.md'), 'utf8')).body.length,
      '原文长度要包含示例段，body 不含');
  } finally {
    done();
  }
});

test('目录：没变的文件不重读（第二次扫描 0 次解析）', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\n甲', 'b.md': '---\nname: 乙\n---\n乙' });
  try {
    const calls = [];
    const c = createCatalog({
      dir: () => dir,
      parse: (id, raw) => { calls.push(id); return parsePersona(id, raw); },
    });
    c.scan();
    assert.deepEqual(calls.sort(), ['a', 'b'], '首次要解析两份');

    calls.length = 0;
    c.scan();
    assert.deepEqual(calls, [], '没变就一份都不该重读');
  } finally {
    done();
  }
});

test('目录：外部编辑（同长度、不经 save）也能发现——这条正是「目录 mtime 早退」会漏的', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\nAAAA' });
  try {
    const c = cat(dir);
    assert.equal(c.scan().items.a.name, '甲');

    // 长度完全一样，只有内容变；再把 mtime 往后推，模拟编辑器保存
    writeFileSync(join(dir, 'a.md'), '---\nname: 乙\n---\nBBBB', 'utf8');
    const t = new Date(Date.now() + 2000);
    utimesSync(join(dir, 'a.md'), t, t);

    assert.equal(c.scan().items.a.name, '乙', '改文件内容不改父目录 mtime，必须逐文件 stat');
  } finally {
    done();
  }
});

test('目录：文件删掉之后要从列表里消失', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\n甲', 'b.md': '---\nname: 乙\n---\n乙' });
  try {
    const c = cat(dir);
    assert.equal(Object.keys(c.scan().items).length, 2);
    unlinkSync(join(dir, 'b.md'));
    assert.deepEqual(Object.keys(c.scan().items), ['a']);
  } finally {
    done();
  }
});

test('目录：.catalog.json 坏掉时自动重建，不抛错', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\n甲' });
  try {
    const c = cat(dir);
    c.scan(); // 写出正常的 catalog
    writeFileSync(join(dir, '.catalog.json'), '{ 这不是 JSON', 'utf8');

    const c2 = cat(dir);
    const items = c2.scan().items;
    assert.equal(items.a.name, '甲', '坏了要能重建，而不是让插件起不来');
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, '.catalog.json'), 'utf8')), '重建后应写回合法 JSON');
  } finally {
    done();
  }
});

test('目录：CRLF 和 LF 的 sha 一样（Windows 检出不该被判成改过）', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\n第一行\n第二行\n' });
  try {
    const c = cat(dir);
    const first = c.scan().items.a;
    const lf = first.sha256;
    writeFileSync(join(dir, 'a.md'), '---\nname: 甲\n---\n第一行\r\n第二行\r\n', 'utf8');
    const crlf = c.scan().items.a;
    assert.equal(crlf.sha256, lf);
    assert.equal(lf, hashText('---\nname: 甲\n---\n第一行\n第二行\n'));
    // 字数也要归一：否则 sha 说「没改」，面板却显示多了几个字
    assert.equal(crlf.chars, first.chars, 'CRLF 不该让字数变大');
  } finally {
    done();
  }
});

test('目录：没有变化时不重写 .catalog.json（别每次扫描都写盘）', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\n甲' });
  try {
    const c = cat(dir);
    c.scan();
    const f = join(dir, '.catalog.json');
    const before = statSync(f).mtimeMs;
    c.scan();
    c.scan();
    assert.equal(statSync(f).mtimeMs, before, '没变就不该写盘');
  } finally {
    done();
  }
});

test('目录：空目录也能扫（首次运行，personas/ 还不存在）', () => {
  const dir = join(tmpdir(), 'roost-cat-none-' + Date.now());
  try {
    assert.deepEqual(cat(dir).scan().items, {});
    assert.ok(existsSync(dir), '扫描会把目录建出来，seed 才有地方写');
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('目录：读失败（不是「空目录」）要保留上一次结果，不能把 catalog 清空', () => {
  const { dir, done } = fresh({ 'a.md': '---\nname: 甲\n---\n甲' });
  const aside = dir + '-aside';
  try {
    const c = cat(dir);
    assert.equal(c.scan().items.a.name, '甲');

    // 把目录挪走、在同名路径放一个普通文件：readdir 会抛 ENOTDIR/EPERM
    renameSync(dir, aside);
    writeFileSync(dir, 'x', 'utf8');

    const after = c.scan();
    assert.equal(after.items.a?.name, '甲', '读失败时不能当成「全删了」');

    // 磁盘上的 catalog 也不该被写成空（文件跟着目录挪到了 aside 下）
    const onDisk = JSON.parse(readFileSync(join(aside, '.catalog.json'), 'utf8'));
    assert.equal(onDisk.items.a.name, '甲');
  } finally {
    try { rmSync(dir, { force: true }); } catch {}
    try { renameSync(aside, dir); } catch {}
    done();
  }
});

test('目录：路径本身是个文件时不抛错（插件不能因为目录坏了起不来）', () => {
  const base = mkdtempSync(join(tmpdir(), 'roost-cat-file-'));
  const notDir = join(base, 'not-a-dir');
  try {
    writeFileSync(notDir, 'x', 'utf8');
    const c = createCatalog({ dir: () => notDir, parse: parsePersona });
    assert.doesNotThrow(() => c.scan());
    assert.deepEqual(c.scan().items, {});
  } finally {
    try { rmSync(base, { recursive: true, force: true }); } catch {}
  }
});
