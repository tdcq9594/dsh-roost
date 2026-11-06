// 缓存图 → 表情包「未分类」的同步。
//
// 这里挡的是**误伤**：把 1920×1080 壁纸、2560×1600 截图、1469×161 长条
// 收进表情包库，表现是模型挑图时配一张截图到群里。那种错只能在聊天记录里发现。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStickers, UNCATEGORIZED } from '../src/stickers.js';
import { createStickerSync, dimsOf, judge, SYNC_DEFAULTS } from '../src/sticker-sync.js';

/** 造一个只有头部正确的 PNG：宽高能被 dimsOf 读出来，体积按需要填充 */
function png(w, h, bytes) {
  const b = Buffer.alloc(Math.max(bytes, 33), 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function gif(w, h, bytes) {
  const b = Buffer.alloc(Math.max(bytes, 13), 0);
  b.write('GIF89a', 0);
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

/** 建一个数据目录：files 是「缓存文件名 → Buffer」 */
function makeCache(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sync-'));
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  for (const [name, buf] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, 'images', name), buf);
  }
  const stickers = createStickers({ dataDir: root, cacheMs: 0 });
  const sync = createStickerSync({ dataDir: root, stickers });
  return { root, stickers, sync };
}

test('读图片头：PNG / GIF / 认不出的格式', () => {
  assert.deepEqual(dimsOf(png(240, 240, 64)), { w: 240, h: 240 });
  assert.deepEqual(dimsOf(gif(500, 320, 64)), { w: 500, h: 320 });
  // 读不出来不抛错：WebP/BMP 的偏移各版本有差异，卡在这里会整批同步失败
  assert.deepEqual(dimsOf(Buffer.from('not an image at all')), { w: 0, h: 0 });
  assert.deepEqual(dimsOf(Buffer.alloc(4)), { w: 0, h: 0 });
});

test('判定：截图、壁纸、长条图都要挡住', () => {
  const ok = (x) => assert.equal(judge(x).ok, true, JSON.stringify(x));
  const no = (x) => assert.equal(judge(x).ok, false, JSON.stringify(x));

  ok({ size: 100 * 1024, w: 240, h: 240 });   // 标准表情包尺寸
  ok({ size: 300 * 1024, w: 1000, h: 1000 });
  ok({ size: 50 * 1024, w: 664, h: 588 });

  no({ size: 300 * 1024, w: 1920, h: 1080 }); // 壁纸
  no({ size: 600 * 1024, w: 2560, h: 1600 }); // 截图
  no({ size: 30 * 1024, w: 1469, h: 161 });   // 聊天记录长条
  no({ size: 2 * 1024, w: 240, h: 240 });     // 太小
  no({ size: 3 * 1024 * 1024, w: 240, h: 240 }); // 太大
  // 读不出尺寸的按体积放行——宁可多收一张，也别把 WebP 全挡掉
  ok({ size: 100 * 1024, w: 0, h: 0 });
});

test('预览：筛出来的和跳过的一目了然', () => {
  const { sync } = makeCache({
    'aa11.png': png(240, 240, 100 * 1024),
    'bb22.png': png(1920, 1080, 300 * 1024),
    'cc33.gif': gif(300, 300, 80 * 1024),
    'dd44.png': png(1469, 161, 30 * 1024),
    'note.txt': Buffer.from('不是图'),
  });
  const p = sync.preview({});
  assert.equal(p.ok, true);
  assert.equal(p.total, 4, '非图片文件不该进清单');
  assert.equal(p.willSync, 2);
  assert.equal(p.skipped, 2);

  const byName = Object.fromEntries(p.items.map((x) => [x.name, x]));
  assert.equal(byName['bb22.png'].ok, false);
  assert.ok(byName['bb22.png'].reason.includes('边长'), byName['bb22.png'].reason);
  assert.ok(byName['dd44.png'].reason.includes('太长'), byName['dd44.png'].reason);
  // 目标是表情包目录下的「未分类」，不是根目录
  assert.ok(p.dir.endsWith(UNCATEGORIZED), p.dir);
});

test('同步：复制进「未分类」，写侧车，记账', () => {
  const { sync, stickers } = makeCache({
    'aa11.png': png(240, 240, 100 * 1024),
    'cc33.gif': gif(300, 300, 80 * 1024),
  });
  const r = sync.apply({});
  assert.equal(r.ok, true);
  assert.equal(r.copied, 2);

  const dir = path.join(stickers.dir({}), UNCATEGORIZED);
  const files = fs.readdirSync(dir).sort();
  // 没填标签 → 用「缓存」当文件名；扩展名不同所以不撞
  assert.deepEqual(files, ['缓存.gif', '缓存.gif.tags', '缓存.png', '缓存.png.tags']);

  // 侧车只写场合、不写标签：文件名里的「缓存」对模型没有意义
  const tags = fs.readFileSync(path.join(dir, '缓存.png.tags'), 'utf8');
  assert.ok(tags.startsWith(';'), tags);

  // 副本和源文件字节一致
  assert.deepEqual(
    fs.readFileSync(path.join(dir, '缓存.png')),
    fs.readFileSync(path.join(stickers.dir({}), '..', 'images', 'aa11.png')),
  );
});

test('同步：已同步过的不再重复，列表里标出来', () => {
  const { sync } = makeCache({ 'aa11.png': png(240, 240, 100 * 1024) });
  assert.equal(sync.apply({}).copied, 1);

  const p2 = sync.preview({});
  assert.equal(p2.willSync, 0);
  assert.equal(p2.items[0].reason, '已同步过');

  assert.equal(sync.apply({}).copied, 0, '第二次不该再复制一份');

  // 删掉账本之后能重新同步（用户想重来一次）
  sync.reset();
  assert.equal(sync.preview({}).willSync, 1);
});

test('同步：勾选的是白名单，本该跳过的也能手动收', () => {
  const { sync, stickers } = makeCache({
    'aa11.png': png(240, 240, 100 * 1024),
    'bb22.png': png(1920, 1080, 300 * 1024),
  });
  // 只勾那张「太大了」的：用户看过预览，他知道这是一张想要的大图
  const r = sync.apply({}, { names: ['bb22.png'] });
  assert.equal(r.copied, 1);
  const dir = path.join(stickers.dir({}), UNCATEGORIZED);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.endsWith('.tags')), ['缓存.png']);
});

test('同步：填了标签就用它当文件名，填了文件夹就进那个分类', () => {
  const { sync, stickers } = makeCache({
    'aa11.png': png(240, 240, 100 * 1024),
    'bb22.png': png(500, 500, 90 * 1024),
    'cc33.gif': gif(300, 300, 80 * 1024),
  });
  const r = sync.apply({}, {
    picks: [
      { name: 'aa11.png', folder: '开心', tags: '开心, 猫' },
      { name: 'bb22.png', folder: '无语', tags: '' },
      { name: 'cc33.gif', folder: '', tags: '' },
    ],
  });
  assert.equal(r.copied, 3);
  assert.deepEqual(r.folders, { 开心: 1, 无语: 1, 未分类: 1 });

  const root = stickers.dir({});
  // 标签 → 文件名（下划线连接，能被 tagsOf 拆回来）
  const happy = fs.readdirSync(path.join(root, '开心')).filter((f) => !f.endsWith('.tags'));
  assert.deepEqual(happy, ['开心_猫.png']);
  assert.equal(fs.readFileSync(path.join(root, '开心', '开心_猫.png.tags'), 'utf8'), '开心, 猫');

  // 只填文件夹不填标签 → 还是「缓存」这个名字
  const bored = fs.readdirSync(path.join(root, '无语')).filter((f) => !f.endsWith('.tags'));
  assert.deepEqual(bored, ['缓存.png']);

  // 两个都不填 → 未分类
  const none = fs.readdirSync(path.join(root, UNCATEGORIZED)).filter((f) => !f.endsWith('.tags'));
  assert.deepEqual(none, ['缓存.gif']);
});

test('同步：文件夹和标签里的非法字符被削掉，不会写穿路径', () => {
  const { sync, stickers } = makeCache({ 'aa11.png': png(240, 240, 100 * 1024) });
  const r = sync.apply({}, {
    // `../` 想跳出表情包目录；`:` `?` 在 Windows 上直接建不出来
    picks: [{ name: 'aa11.png', folder: '../../逃出去', tags: '开心:猫?/../x' }],
  });
  assert.equal(r.copied, 1);

  const root = stickers.dir({});
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  // 斜杠被删掉，点被削掉，最后只剩「逃出去」这一层，且一定在 stickers 下
  assert.deepEqual(dirs, ['逃出去'], JSON.stringify(dirs));
  const files = fs.readdirSync(path.join(root, '逃出去')).filter((f) => !f.endsWith('.tags'));
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes(':') && !files[0].includes('?'), files[0]);
  assert.ok(fs.existsSync(path.join(root, '逃出去', files[0])), '名字必须落在目标目录里');
});

test('同步：同名文件自动加序号，不覆盖已有文件', () => {
  const { sync, stickers } = makeCache({ 'aa11.png': png(240, 240, 100 * 1024) });
  const dir = path.join(stickers.dir({}), UNCATEGORIZED);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '缓存.png'), 'old');

  sync.apply({});
  const names = fs.readdirSync(dir).filter((f) => !f.endsWith('.tags')).sort();
  assert.deepEqual(names, ['缓存.png', '缓存_2.png']);
  assert.equal(fs.readFileSync(path.join(dir, '缓存.png'), 'utf8'), 'old', '老文件不能被覆盖');
});

test('同步：没有缓存目录时说人话，不是空结果', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-sync-empty-'));
  const stickers = createStickers({ dataDir: root, cacheMs: 0 });
  const sync = createStickerSync({ dataDir: root, stickers });
  const p = sync.preview({});
  assert.equal(p.ok, false);
  assert.ok(p.message.includes('缓存'), p.message);
});

test('同步：筛选阈值可以调，调了就生效', () => {
  const { sync } = makeCache({ 'aa11.png': png(600, 600, 100 * 1024) });
  assert.equal(sync.preview({}).willSync, 1);
  assert.equal(sync.preview({ sync: { ...SYNC_DEFAULTS, maxEdge: 500 } }).willSync, 0);
});
