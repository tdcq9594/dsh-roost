// 5.12 表情库管理：越界防护、只补不改、真删可报、任务分片。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  locate, readSidecar, writeSidecar, suggestTags, pageOf, removeFiles,
  createTagJob, statsOf, MAX_DELETE, MAX_TAGS,
} from '../src/sticker-manage.js';

/** 建一个临时表情库：根目录 + 一个分类目录 + 几张图 */
function makeLib() {
  const root = mkdtempSync(join(tmpdir(), 'roost-sticker-'));
  mkdirSync(join(root, '开心'), { recursive: true });
  writeFileSync(join(root, '熊猫_笑.png'), 'a');
  writeFileSync(join(root, '开心', '猫.png'), 'b');
  writeFileSync(join(root, '开心', '狗.gif'), 'c');
  return root;
}

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ } };

test('locate：正常路径解析出分类与相对路径', () => {
  const root = makeLib();
  try {
    const a = locate([root], '开心/猫.png');
    assert.equal(a.category, '开心');
    assert.equal(a.rel, '开心/猫.png');
    assert.ok(a.abs.endsWith('猫.png'));

    const b = locate([root], '熊猫_笑.png');
    assert.equal(b.category, '未分类');
    assert.equal(b.rel, '熊猫_笑.png');
  } finally { cleanup(root); }
});

test('locate：越界、绝对路径、深层目录、不存在的文件一律 null', () => {
  const root = makeLib();
  try {
    for (const bad of ['../../memory.json', '..\\..\\x.png', '/etc/passwd', 'a/b/c.png', '不存在.png', '']) {
      assert.equal(locate([root], bad), null, `${bad} 不该被认成库内文件`);
    }
  } finally { cleanup(root); }
});

test('locate：多个目录时逐个找，命中哪个都能删', () => {
  const a = makeLib();
  const b = makeLib();
  try {
    const hit = locate([a, b], '开心/狗.gif');
    assert.ok(hit, '第二个目录里也该找得到');
    assert.ok([a, b].includes(hit.root));
  } finally { cleanup(a); cleanup(b); }
});

test('侧车：写进去能读回来，场合说明原样保留', () => {
  const root = makeLib();
  try {
    const { abs } = locate([root], '开心/猫.png');
    writeSidecar(abs, ['开心', '猫'], '有人装可爱时');
    const got = readSidecar(abs);
    assert.deepEqual(got.tags, ['开心', '猫']);
    assert.equal(got.note, '有人装可爱时');
    assert.equal(readFileSync(`${abs}.tags`, 'utf8').trim(), '开心, 猫; 有人装可爱时');
  } finally { cleanup(root); }
});

test('侧车：标签清空且没说明时删文件，不留空壳', () => {
  const root = makeLib();
  try {
    const { abs } = locate([root], '开心/猫.png');
    writeSidecar(abs, ['猫']);
    assert.equal(existsSync(`${abs}.tags`), true);
    writeSidecar(abs, [], '');
    assert.equal(existsSync(`${abs}.tags`), false, '空侧车要删掉，否则同名图会继承旧标签');
  } finally { cleanup(root); }
});

test('侧车：纯数字与序号不算标签', () => {
  const root = makeLib();
  try {
    const { abs } = locate([root], '开心/猫.png');
    writeFileSync(`${abs}.tags`, '1, 2, 猫, (3), 开心');
    assert.deepEqual(readSidecar(abs).tags, ['猫', '开心']);
  } finally { cleanup(root); }
});

test('补标签：分类名 + 文件名 + 已有标签，去重且不超上限', () => {
  const r = suggestTags({ file: '熊猫_笑.png', category: '开心', existing: ['可爱'] });
  assert.equal(r.tags[0], '可爱', '已有标签排最前，用户的写法优先');
  assert.ok(r.tags.includes('开心'), '分类名是人分过的，最可信');
  assert.ok(r.tags.includes('熊猫'));
  assert.ok(r.tags.includes('笑'));
  assert.ok(r.tags.length <= MAX_TAGS);
  assert.deepEqual(r.added, r.tags.filter((t) => t !== '可爱'), 'added 只算新补的');

  const noise = suggestTags({ file: '(1).png', category: '未分类' });
  assert.deepEqual(noise.tags, [], '纯序号文件名补不出标签');
});

test('分页：默认排序稳定（分类 → 文件名），页码越界夹回', () => {
  const items = [
    { file: 'b.png', category: '开心', tags: [] },
    { file: 'a.png', category: '开心', tags: [] },
    { file: 'z.png', category: '未分类', tags: [] },
    { file: 'c.png', category: '生气', tags: [] },
  ];
  const p1 = pageOf(items, { page: 1, size: 2 });
  assert.equal(p1.total, 4);
  assert.equal(p1.pages, 2);
  assert.deepEqual(p1.items.map((x) => x.file), ['a.png', 'b.png'], '同一分类内按文件名');

  const over = pageOf(items, { page: 99, size: 2 });
  assert.equal(over.page, 2, '页码超了夹到最后一页');
});

test('分页：按分类筛 + 关键词搜标签', () => {
  const items = [
    { file: 'a.png', category: '开心', tags: ['笑'] },
    { file: 'b.png', category: '生气', tags: ['怒'] },
  ];
  assert.equal(pageOf(items, { category: '开心' }).total, 1);
  assert.equal(pageOf(items, { q: '怒' }).total, 1);
  assert.equal(pageOf(items, { q: '不存在' }).total, 0);
});

test('批删：没有 confirm 一律不删', () => {
  const root = makeLib();
  try {
    const r = removeFiles([root], ['开心/猫.png'], {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'need_confirm');
    assert.equal(existsSync(join(root, '开心', '猫.png')), true, '文件必须还在');
  } finally { cleanup(root); }
});

test('批删：真删图 + 侧车，越界的记失败但不影响其他', () => {
  const root = makeLib();
  try {
    const { abs } = locate([root], '开心/猫.png');
    writeSidecar(abs, ['猫']);
    assert.equal(existsSync(`${abs}.tags`), true);

    const r = removeFiles([root], ['开心/猫.png', '../escape.png'], { confirm: true });
    assert.equal(existsSync(abs), false, '图要真删');
    assert.equal(existsSync(`${abs}.tags`), false, '侧车要一起删');
    assert.deepEqual(r.removed, ['开心/猫.png']);
    assert.equal(r.failed.length, 1);
    assert.equal(r.ok, false, '有失败就不算全成功');
  } finally { cleanup(root); }
});

test('批删：超过上限直接拒，不动任何文件', () => {
  const root = makeLib();
  try {
    const many = Array.from({ length: MAX_DELETE + 1 }, (_, i) => `x${i}.png`);
    const r = removeFiles([root], many, { confirm: true });
    assert.equal(r.error, 'too_many');
    assert.equal(existsSync(join(root, '熊猫_笑.png')), true);
  } finally { cleanup(root); }
});

test('任务：分片跑完，进度单调，失败计数不中断', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ file: `f${i}.png` }));
  const seen = [];
  const job = createTagJob({
    items,
    chunk: 10,
    worker: (it) => {
      if (it.file === 'f3.png') throw new Error('文件被占用');
      seen.push(it.file);
    },
  });

  const s1 = job.tick();
  assert.equal(s1.done, 10);
  assert.equal(s1.running, true);
  assert.equal(s1.failed, 1);
  assert.equal(s1.errors.length, 1);

  job.tick();
  const s3 = job.tick();
  assert.equal(s3.done, 25);
  assert.equal(s3.running, false);
  assert.equal(seen.length, 24, '失败的那条不进成功列表');
  assert.equal(job.progress().percent, 100);
});

test('任务：取消后不再推进', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ file: `f${i}.png` }));
  const job = createTagJob({ items, chunk: 10, worker: () => {} });
  job.tick();
  const p = job.cancel();
  assert.equal(p.cancelled, true);
  assert.equal(p.running, false);
  const after = job.tick();
  assert.equal(after.done, 10, '取消之后一张都不该再处理');
});

test('统计：总数 / 已打标签 / 未打标签 / 分类分布', () => {
  const s = statsOf([
    { file: 'a.png', category: '开心', tags: ['笑'], size: 100 },
    { file: 'b.png', category: '开心', tags: [], size: 200 },
    { file: 'c.png', category: '生气', tags: ['怒'], size: 0 },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.tagged, 2);
  assert.equal(s.untagged, 1);
  assert.equal(s.bytes, 300);
  assert.deepEqual(s.categories[0], { name: '开心', count: 2 });
});
