// 表情标注扩展（`sticker-reply`）的只读对接。
//
// 这一层最容易出的错不是「读不到」，而是**读错人**：把别处的 JSON 当成标注、
// 把旧格式（文件名当键）混进来、把坏文件当成空表然后把用户标注当没标过。
// 所以测试的重点是「什么不该读进来」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  externalAnnotationPaths,
  readExternalAnnotations,
  createExternalAnnotations,
} from '../src/gallery-annotations.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function mkRoot() {
  return mkdtempSync(join(tmpdir(), 'roost-ann-'));
}

/** 在数据根下造一个「已安装扩展」的标注文件，返回文件路径 */
function writeAnnotations(root, images) {
  const dir = join(root, 'extension-data', 'sticker-reply');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'annotations.json');
  writeFileSync(p, JSON.stringify({ version: 1, images }), 'utf8');
  return p;
}

/* ---------------- 路径 ---------------- */

test('路径：launcher 的上一级排第一，其次 roost 数据目录，最后 ~/.dsh', () => {
  const paths = externalAnnotationPaths({
    launcherDir: 'C:/Users/x/.dsh/dsh-roost',
    roostDataDir: 'C:/Users/x/.dsh/dsh-roost',
  });
  assert.equal(paths[0], join('C:/Users/x/.dsh', 'extension-data', 'sticker-reply', 'annotations.json'));
  /** 两个来源算出同一个根：要去重，否则每次都要对同一路径 stat 两遍 */
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(
    paths.slice(0, 2),
    [paths[0], join(homedir(), '.dsh', 'extension-data', 'sticker-reply', 'annotations.json')],
    '第二条应该直接是 ~/.dsh 的兜底，说明重复的 launcher 路径被去掉了',
  );
});

test('路径：没给 launcher 时用 roost 数据目录的上一级', () => {
  const paths = externalAnnotationPaths({ roostDataDir: join('D:', 'custom', 'roost-data') });
  assert.equal(paths[0], join('D:', 'custom', 'extension-data', 'sticker-reply', 'annotations.json'));
});

/* ---------------- 读取 ---------------- */

test('读取：键必须是 64 位 hex（旧格式用文件名当键，混进来会串图）', () => {
  const root = mkRoot();
  const p = writeAnnotations(root, {
    [SHA_A]: { name: '眨眼', meaning: '眨眼卖萌' },
    'call_1nEY.jpg': { name: '文件名当键的旧数据', meaning: '不该读进来' },
  });
  const r = readExternalAnnotations({ paths: [p] });
  assert.equal(r.path, p);
  assert.equal(r.bySha.size, 1);
  assert.equal(r.bySha.get(SHA_A).name, '眨眼');
});

test('读取：字段归一——非字符串丢掉、tags 只留字符串、超长截断', () => {
  const root = mkRoot();
  const p = writeAnnotations(root, {
    [SHA_A]: {
      name: 123,
      meaning: '  有空格要 trim  ',
      tags: ['开心', 42, '', null, '  得意  '],
      scenes: { not: 'a string' },
      avoid: '别在正式场合发',
      extra: '以后加的字段不该漏进 index',
    },
  });
  const row = readExternalAnnotations({ paths: [p] }).bySha.get(SHA_A);
  assert.equal(row.name, '');
  assert.equal(row.meaning, '有空格要 trim');
  assert.deepEqual(row.tags, ['开心', '得意']);
  assert.equal(row.scenes, '');
  assert.equal(row.avoid, '别在正式场合发');
  assert.equal(row.extra, undefined, '字段白名单之外的一律不进 index');
});

test('读取：整条全空的记录跳过（否则图库会以为「这张已经有描述」）', () => {
  const root = mkRoot();
  const p = writeAnnotations(root, {
    [SHA_A]: { name: '', meaning: '', tags: [], scenes: '', avoid: '' },
    [SHA_B]: { meaning: '只有含义也算' },
  });
  const r = readExternalAnnotations({ paths: [p] });
  assert.equal(r.bySha.has(SHA_A), false);
  assert.equal(r.bySha.has(SHA_B), true);
});

test('读取：坏 JSON 不抛、记一行、继续看下一个候选', () => {
  const root = mkRoot();
  const dir = join(root, 'extension-data', 'sticker-reply');
  mkdirSync(dir, { recursive: true });
  const broken = join(dir, 'annotations.json');
  writeFileSync(broken, '{坏掉的', 'utf8');

  const logs = [];
  const r = readExternalAnnotations({ paths: [broken], log: (m) => logs.push(m) });
  assert.equal(r.bySha.size, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /读不了/);
});

test('读取：候选按顺序找，第一个存在且能解析的胜出', () => {
  const root = mkRoot();
  const p = writeAnnotations(root, { [SHA_A]: { name: '在扩展目录' } });
  const r = readExternalAnnotations({
    paths: [join(root, '不存在', 'annotations.json'), p],
  });
  assert.equal(r.path, p);
  assert.equal(r.bySha.get(SHA_A).name, '在扩展目录');
});

test('读取：一个候选都没有时返回空表，不报错', () => {
  const r = readExternalAnnotations({ paths: [join(mkRoot(), 'nothing.json')] });
  assert.equal(r.bySha.size, 0);
  assert.equal(r.path, '');
});

/* ---------------- 缓存 ---------------- */

test('缓存：文件没变不重读，mtime 变了立刻重读', () => {
  const root = mkRoot();
  const p = writeAnnotations(root, { [SHA_A]: { name: '第一版' } });
  const current = createExternalAnnotations({ roostDataDir: join(root, 'dsh-roost') });

  /**
   * `roostDataDir` 是 `<root>/dsh-roost`，上一级就是 `root`，
   * 正好对上 `writeAnnotations` 造的 `<root>/extension-data/...`。
   */
  const first = current();
  assert.equal(first.bySha.get(SHA_A)?.name, '第一版');

  /** 第二次：文件没动，不该产生任何读取（用日志计数当"重读"的探针不成立，
      所以直接验结果对象是不是同一个引用——缓存命中就该复用） */
  const again = current();
  assert.equal(again, first, '没变就该返回同一个对象，别每次都重建 Map');

  /** 改内容 + 把 mtime 往后推（同一毫秒内写完 mtime 可能不变，测试会飘） */
  writeFileSync(p, JSON.stringify({ version: 1, images: { [SHA_A]: { name: '第二版' } } }), 'utf8');
  const st = statSync(p);
  utimesSync(p, st.atime, new Date(st.mtimeMs + 2000));
  const third = current();
  assert.notEqual(third, first);
  assert.equal(third.bySha.get(SHA_A).name, '第二版');
});

test('缓存：扩展还没装时每次重试候选（装完立刻生效）', () => {
  const root = mkRoot();
  const current = createExternalAnnotations({ roostDataDir: join(root, 'dsh-roost') });
  assert.equal(current().bySha.size, 0);

  /** 模拟「刚装好扩展」——下一次调用就该看得见，不用重启 */
  writeAnnotations(root, { [SHA_A]: { name: '装完就有了' } });
  assert.equal(current().bySha.get(SHA_A)?.name, '装完就有了');
});
