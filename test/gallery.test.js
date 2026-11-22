import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGallery, lineOf, INDEX_VERSION } from '../src/gallery.js';

/** 临时数据目录 + 一个假表情库（只提供 snapshot / dir） */
function env({ items = [], now } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'roost-gallery-'));
  const root = join(dataDir, 'stickers');
  mkdirSync(root, { recursive: true });

  let list = items.slice();
  const fake = {
    snapshot: () => ({ items: list, cats: [], roots: [root] }),
    dir: () => root,
  };
  const g = createGallery({ dataDir, stickers: fake, now: now ?? (() => 1_700_000_000_000) });
  return {
    dataDir,
    root,
    gallery: g,
    setItems(next) { list = next.slice(); },
    cleanup() { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} },
  };
}

/** 造一张图并返回它该出现在 snapshot 里的样子 */
function makeImage(root, rel, content = 'pixels') {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  const parts = rel.replace(/\\/g, '/').split('/');
  return {
    file: parts[parts.length - 1],
    path: p,
    rel,
    cat: parts.length > 1 ? parts[0] : '',
    tags: [],
    usage: '',
    size: Buffer.byteLength(content),
    mtime: 0,
    root,
  };
}

test('首次同步按序号入库，seq 从 1 开始且不重复', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    const b = makeImage(e.root, '开心/b.png', 'BBB');
    e.setItems([a, b]);
    const r = e.gallery.sync({});
    assert.equal(r.added, 2);
    const list = e.gallery.list({}, {});
    assert.equal(list.items.length, 2);
    const seqs = list.items.map((x) => x.seq).sort((x, y) => x - y);
    assert.deepEqual(seqs, [1, 2]);
  } finally { e.cleanup(); }
});

test('同一内容换个路径是同一张图，序号不变', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'SAME');
    e.setItems([a]);
    e.gallery.sync({});
    const seq = e.gallery.list({}, {}).items[0].seq;

    /** 复制一份到别的分类：内容一样，应该还是那个序号 */
    const dup = makeImage(e.root, '搞笑/copy.png', 'SAME');
    e.setItems([dup]);
    e.gallery.sync({});
    const list = e.gallery.list({}, {});
    assert.equal(list.items.length, 1, '内容相同不该变成两条');
    assert.equal(list.items[0].seq, seq);
    assert.equal(list.items[0].cat, '搞笑', '路径变了要跟着更新');
  } finally { e.cleanup(); }
});

test('工具返回值不含路径，只有序号和描述', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, '开心/a.png', 'X')]);
    const r = e.gallery.list({}, {});
    const raw = JSON.stringify(r);
    assert.ok(!raw.includes(e.root), '返回值里不能出现真实路径');
    assert.ok(r.text.includes('#1'));
  } finally { e.cleanup(); }
});

test('edit 改标注并落盘；身份字段改不动', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'X')]);
    e.gallery.sync({});
    const r = e.gallery.edit(1, {
      name: '猫猫震惊',
      meaning: '一脸不敢相信',
      tags: ['猫', '震惊'],
      scenes: '听到离谱的事',
      /** 这些必须被忽略：改了就等于伪造一张不存在的图 */
      seq: 99,
      path: '/etc/passwd',
      bytes: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.item.seq, 1);
    assert.equal(r.item.name, '猫猫震惊');
    assert.deepEqual(r.item.tags, ['猫', '震惊']);
    assert.ok(!JSON.stringify(r.item).includes('passwd'));

    /** 重新加载（模拟重启）后还在 */
    const img = makeImage(e.root, 'a.png', 'X');
    const g2 = createGallery({
      dataDir: e.dataDir,
      stickers: { snapshot: () => ({ items: [img] }), dir: () => e.root },
    });
    const again = g2.list({}, {});
    assert.equal(again.items[0].name, '猫猫震惊');
    assert.equal(again.items[0].meaning, '一脸不敢相信');
  } finally { e.cleanup(); }
});

test('edit 把标签和场合回写侧车（stickers 每轮从侧车生成清单）', () => {
  const e = env();
  try {
    const img = makeImage(e.root, 'a.png', 'X');
    e.setItems([img]);
    e.gallery.sync({});
    e.gallery.edit(1, { tags: ['猫', '无语'], scenes: '被问到蠢问题' });
    const side = readFileSync(`${img.path}.tags`, 'utf8').trim();
    assert.equal(side, '猫, 无语; 被问到蠢问题');
  } finally { e.cleanup(); }
});

test('回收站用标记不用目录：文件不动、清单里消失、pathOf 拒绝', () => {
  const e = env();
  try {
    const img = makeImage(e.root, 'a.png', 'X');
    e.setItems([img]);
    e.gallery.sync({});
    assert.equal(e.gallery.pathOf(1, {}), img.path);

    e.gallery.remove(1);
    assert.ok(existsSync(img.path), '文件不能被删');
    assert.equal(e.gallery.pathOf(1, {}), '', '进回收站的不能再发出去');
    assert.equal(e.gallery.list({}, {}).items.length, 0);
    assert.equal(e.gallery.stats().trash, 1);

    e.gallery.restore(1);
    assert.equal(e.gallery.list({}, {}).items.length, 1);
  } finally { e.cleanup(); }
});

test('pathOf 对不存在的号、文件已消失都返回空串', () => {
  const e = env();
  try {
    const img = makeImage(e.root, 'a.png', 'X');
    e.setItems([img]);
    e.gallery.sync({});
    assert.equal(e.gallery.pathOf(999, {}), '');
    rmSync(img.path);
    assert.equal(e.gallery.pathOf(1, {}), '', '文件没了就不能给路径，否则发送才报错');
  } finally { e.cleanup(); }
});

test('save 入库并幂等：同一张存两次拿到同一个序号', () => {
  const e = env();
  try {
    const src = join(e.root, 'incoming.png');
    writeFileSync(src, 'NEW');
    const a = e.gallery.save({ from: src, name: '新图', cat: '开心' }, {});
    assert.equal(a.ok, true);
    assert.equal(a.seq, 1);
    assert.ok(a.item.file.endsWith('.png'));

    const b = e.gallery.save({ from: src }, {});
    assert.equal(b.ok, true);
    assert.equal(b.seq, 1, '重复保存必须返回原序号');
    assert.equal(b.dup, true);
    assert.equal(e.gallery.stats().total, 1);
  } finally { e.cleanup(); }
});

test('save 拒绝网址（首版不拉外链，SSRF 防护没做就不开口子）', () => {
  const e = env();
  try {
    const r = e.gallery.save({ from: 'https://example.com/a.png' }, {});
    assert.equal(r.ok, false);
    assert.match(r.message, /暂不支持/);
  } finally { e.cleanup(); }
});

test('save 清理文件名里的路径分隔符，落点仍在库内', () => {
  const e = env();
  try {
    const src = join(e.root, 'x.png');
    writeFileSync(src, 'ZZZ');
    const r = e.gallery.save({ from: src, name: '../../逃逸' }, {});
    assert.equal(r.ok, true);
    const rec = e.gallery.rows()[0];
    assert.ok(rec.path.startsWith(e.root), '不能写到库外');
    assert.ok(!rec.file.includes('..'));
  } finally { e.cleanup(); }
});

test('save 通过 from=last 认最近一张入站图，过期的不认', () => {
  const now = 1_700_000_000_000;
  const e = env({ now: () => now });
  try {
    const inbound = join(e.dataDir, 'images');
    mkdirSync(inbound, { recursive: true });
    const f = join(inbound, 'abc.png');
    writeFileSync(f, 'IN');
    const old = (now - 3_600_000) / 1000;
    utimesSync(f, old, old);

    const r = e.gallery.save({ from: 'last' }, {});
    assert.equal(r.ok, false, '一小时前的图不该被当成「刚收到的」');
    assert.match(r.message, /最近没有收到图片/);

    const fresh = now / 1000;
    utimesSync(f, fresh, fresh);
    const r2 = e.gallery.save({ from: 'last' }, {});
    assert.equal(r2.ok, true);
  } finally { e.cleanup(); }
});

test('list 支持分类过滤、fresh 只看没用过的、条数有上限', () => {
  const e = env();
  try {
    e.setItems([
      makeImage(e.root, '开心/a.png', 'A'),
      makeImage(e.root, '开心/b.png', 'B'),
      makeImage(e.root, '无语/c.png', 'C'),
    ]);
    e.gallery.sync({});
    assert.equal(e.gallery.list({}, { cat: '开心' }).items.length, 2);
    assert.equal(e.gallery.list({}, { n: 2 }).items.length, 2);
    assert.equal(e.gallery.list({}, { n: 999 }).items.length, 3, '不能超过库里的数量');

    e.gallery.markUsed(1);
    assert.equal(e.gallery.list({}, { fresh: true }).items.length, 2);
    /** 分类统计按全库算，不按过滤后算 */
    const one = e.gallery.list({}, { cat: '无语' });
    assert.equal(one.cats.length, 2);
  } finally { e.cleanup(); }
});

test('markUsed 累加热度并让用过的那张排到后面', () => {
  const e = env();
  try {
    e.setItems([
      makeImage(e.root, 'a.png', 'A'),
      makeImage(e.root, 'b.png', 'B'),
    ]);
    e.gallery.sync({});
    const before = e.gallery.list({}, {}).items.map((x) => x.seq);
    assert.deepEqual(before, [1, 2]);

    e.gallery.markUsed(1);
    const after = e.gallery.list({}, {}).items.map((x) => x.seq);
    assert.deepEqual(after, [2, 1], '刚用过的那张要往后排，避免连着发同一张');
    assert.equal(e.gallery.list({}, {}).items.find((x) => x.seq === 1).hits, 1);
  } finally { e.cleanup(); }
});

test('侧车只在图库为空时当初始值，不覆盖已经写过的描述', () => {
  const e = env();
  try {
    const img = makeImage(e.root, 'a.png', 'X');
    img.tags = ['侧车标签'];
    img.usage = '侧车场合';
    e.setItems([img]);
    e.gallery.sync({});
    let rec = e.gallery.list({}, {}).items[0];
    assert.deepEqual(rec.tags, ['侧车标签']);
    assert.equal(rec.scenes, '侧车场合');

    e.gallery.edit(1, { scenes: '我改过的场合' });
    /** 用户/模型改过之后，再扫一次也不能被侧车旧值顶回去 */
    e.gallery.sync({});
    rec = e.gallery.list({}, {}).items[0];
    assert.equal(rec.scenes, '我改过的场合');
  } finally { e.cleanup(); }
});

test('文件消失标 missing 并退出清单；文件回来就恢复', () => {
  const e = env();
  try {
    const img = makeImage(e.root, 'a.png', 'X');
    e.setItems([img]);
    e.gallery.sync({});
    assert.equal(e.gallery.stats().total, 1);

    rmSync(img.path);
    e.setItems([]);
    e.gallery.sync({});
    assert.equal(e.gallery.list({}, {}).items.length, 0);
    assert.equal(e.gallery.stats().missing, 1);

    /** 同一个文件重新写回来：内容一样 → 还是原来的序号 */
    writeFileSync(img.path, 'X');
    e.setItems([img]);
    e.gallery.sync({});
    assert.equal(e.gallery.list({}, {}).items[0].seq, 1);
    assert.equal(e.gallery.stats().missing, 0);
  } finally { e.cleanup(); }
});

test('索引文件坏了按空库重建，不把整库卡死', () => {
  const e = env();
  try {
    mkdirSync(join(e.dataDir, 'gallery'), { recursive: true });
    writeFileSync(join(e.dataDir, 'gallery', 'index.json'), '{"version":1,"items":{');
    e.setItems([makeImage(e.root, 'a.png', 'X')]);
    e.gallery.sync({});
    assert.equal(e.gallery.list({}, {}).items.length, 1);
  } finally { e.cleanup(); }
});

test('索引里带 seqIndex，人能看懂哪个号对应哪张', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'X')]);
    e.gallery.sync({});
    const raw = JSON.parse(readFileSync(join(e.dataDir, 'gallery', 'index.json'), 'utf8'));
    assert.equal(raw.version, INDEX_VERSION);
    assert.equal(Object.keys(raw.items).length, 1);
    assert.equal(raw.seqIndex['1'], Object.keys(raw.items)[0]);
  } finally { e.cleanup(); }
});

test('lineOf 缺字段时不留空占位', () => {
  assert.equal(lineOf({ seq: 3, file: 'a.png', name: '', meaning: '', tags: [], scenes: '' }), '#3  a.png  未标注');
  assert.equal(
    lineOf({ seq: 7, file: 'b.png', name: '猫', meaning: '无语', tags: ['笑'], scenes: '接梗' }),
    '#7  b.png  猫 · 无语 · 接梗 · 笑',
  );
});

test('pending 只给缺描述的，按序号排', () => {
  const e = env();
  try {
    e.setItems([
      makeImage(e.root, 'a.png', 'A'),
      makeImage(e.root, 'b.png', 'B'),
    ]);
    e.gallery.sync({});
    assert.equal(e.gallery.pending().length, 2);
    e.gallery.edit(1, { meaning: '写好了' });
    const left = e.gallery.pending();
    assert.equal(left.length, 1);
    assert.equal(left[0].seq, 2);
  } finally { e.cleanup(); }
});

/* ---------------- 与表情标注扩展的对接（只补位，不覆盖） ---------------- */

/**
 * 扩展（`sticker-reply`）用同一个东西当键——内容 sha256，字段名也一模一样。
 * 所以已经标过的图不该在图库里显示成「未描述」，否则用户以为白标了，
 * 「让 AI 整理」还会重复花钱去问同一张图。
 */
test('外部标注：新入库的图带上扩展标过的名字与含义', () => {
  const e = env();
  try {
    const it = makeImage(e.root, '开心/a.png', 'AAA');
    /** 用真正的 sha 当键，模拟扩展那边已经标过这张图 */
    const sha = createHash('sha256').update(readFileSync(it.path)).digest('hex');
    e.setItems([it]);

    const g = createGallery({
      dataDir: e.dataDir,
      stickers: { snapshot: () => ({ items: [it], cats: [], roots: [e.root] }), dir: () => e.root },
      externalOf: () => ({
        bySha: new Map([[sha, { name: '眨眼玫瑰', meaning: '叼着玫瑰使眼色', tags: ['撩'], scenes: '打趣', avoid: '正式场合' }]]),
        path: 'x',
      }),
    });
    g.sync({});
    const row = g.rows({})[0];
    assert.equal(row.name, '眨眼玫瑰');
    assert.equal(row.meaning, '叼着玫瑰使眼色');
    assert.equal(row.scenes, '打趣');
    assert.equal(row.src, 'annotations', '来源要标出来，排障时能看出描述哪来的');
  } finally { e.cleanup() }
});

test('外部标注：已经入库的记录不会被回填（用户在图库里改过的不许被顶回去）', () => {
  const e = env();
  try {
    const it = makeImage(e.root, '开心/b.png', 'BBB');
    e.setItems([it]);
    /** 第一轮没有扩展标注：入库时是空的 */
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;
    e.gallery.edit(seq, { name: '我自己改的名字' });

    /** 第二轮扩展那边有标注了——也不该覆盖 */
    const g2 = createGallery({
      dataDir: e.dataDir,
      stickers: { snapshot: () => ({ items: [it], cats: [], roots: [e.root] }), dir: () => e.root },
      externalOf: () => {
        const sha = createHash('sha256').update(readFileSync(it.path)).digest('hex');
        return { bySha: new Map([[sha, { name: '扩展的旧名字', meaning: '扩展的旧含义' }]]), path: 'x' };
      },
    });
    g2.sync({});
    assert.equal(g2.rows({})[0].name, '我自己改的名字');
  } finally { e.cleanup() }
});

test('外部标注：扩展抛错不影响本家同步', () => {
  const e = env();
  try {
    const it = makeImage(e.root, 'c.png', 'CCC');
    const g = createGallery({
      dataDir: e.dataDir,
      stickers: { snapshot: () => ({ items: [it], cats: [], roots: [e.root] }), dir: () => e.root },
      externalOf: () => { throw new Error('文件坏了') },
      log: () => {},
    });
    const r = g.sync({});
    assert.equal(r.added, 1, '扩展的锅不该让图库一张都扫不进来');
    assert.equal(g.rows({})[0].name, '');
  } finally { e.cleanup() }
});
