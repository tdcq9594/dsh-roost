import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, readdirSync } from 'node:fs';
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

/**
 * 网址**不在这里下载**。
 *
 * 拉外链要先过 SSRF 判断（`remote-image.js`），那是异步 + 网络；这一层保持
 * 同步，调用方必须先把字节下下来再交 `buf`。这条测试守的是那个分工：谁要是
 * 图省事把网址直接透传进来，会得到一条明确的报错，而不是一条「找不到文件」
 * 让人去查路径。
 */
test('save 拒绝没下载过的网址（下载归 remote-image.js，这一层只收字节）', () => {
  const e = env();
  try {
    const r = e.gallery.save({ from: 'https://example.com/a.png' }, {});
    assert.equal(r.ok, false);
    assert.match(r.message, /网址要先下载/);
  } finally { e.cleanup(); }
});

test('save 收调用方给的字节（网址那条路就是这么进来的）', () => {
  const e = env();
  try {
    const buf = Buffer.from('PNG-BYTES');
    const r = e.gallery.save({ from: 'https://example.com/a.png', buf, ext: '.png', src: 'url', name: '网图' }, {});
    assert.equal(r.ok, true);
    assert.equal(r.item.file, '网图.png');
    assert.equal(e.gallery.rows({})[0].src, 'url', '来源要标成 url，面板/排障能看出这张是从网上来的');
    /** 二次入库同一张：幂等，返回原序号 */
    const again = e.gallery.save({ from: 'https://other.example/b.png', buf, ext: '.png', src: 'url' }, {});
    assert.equal(again.dup, true);
    assert.equal(again.seq, r.seq);
  } finally { e.cleanup(); }
});

/**
 * `fileName` 和 `name` 必须分开。
 *
 * 从网址入库时会拿 URL 末段当磁盘文件名。如果那也写进 `name`（标注），
 * `pending()` 会认为这张图「已经有名字」→「让 AI 整理」永远不会碰它，
 * 图库里堆一堆 `cat-404.png` 但没有任何描述。
 */
test('save：fileName 只决定磁盘文件名，不算标注', () => {
  const e = env();
  try {
    const r = e.gallery.save(
      { from: 'https://x.example/cat-404.png', buf: Buffer.from('PNG-BYTES'), ext: '.png', fileName: 'cat-404', src: 'url' },
      {},
    );
    assert.equal(r.ok, true);
    assert.equal(r.item.file, 'cat-404.png');
    assert.equal(r.item.name, '', '文件名不能自动变成标注');
    assert.equal(e.gallery.pending({}).length, 1, '没标注的图要留在「让 AI 整理」的待办里');
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

/**
 * `all` = 「全部重做」。
 *
 * 为什么要有：整理是增量的，只挑 name 和 meaning 都为空的。描述写歪了、
 * 标签全是文件名拆出来的词、换了更会看图的模型——这些情况增量永远够不着，
 * 用户只能一张张手改。全量重来时仍然跳过停用和回收站（那是不该花钱的两类）。
 */
test('pending({ all }) 把已标注的也叫回来，但仍跳过停用的', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'A'), makeImage(e.root, 'b.png', 'B')]);
    e.gallery.sync({});
    e.gallery.edit(1, { name: '甲', meaning: '写好了' });

    assert.equal(e.gallery.pending().length, 1, '增量只给没描述的');
    assert.equal(e.gallery.pending({ all: true }).length, 2, '全部重做要把已标注的也算上');

    e.gallery.edit(2, { enabled: false });
    const all = e.gallery.pending({ all: true });
    assert.equal(all.length, 1, '停用的不该被全部重做翻出来烧钱');
    assert.equal(all[0].seq, 1);
  } finally { e.cleanup(); }
});

test('pending 默认一次给 200 张，不再卡在 40', () => {
  const e = env();
  try {
    const items = [];
    /** 内容必须各不相同：图库按 sha256 去重 */
    for (let i = 1; i <= 45; i += 1) items.push(makeImage(e.root, `p${i}.png`, `content-${i}`));
    e.setItems(items);
    e.gallery.sync({});

    /**
     * 45 张一轮跑完。原来默认 40，用户有 108 张待办就得不理解地点三次，
     * 每次还弹一遍「开始整理 40 张」——看起来像功能坏了。
     */
    assert.equal(e.gallery.pending().length, 45, '默认不该再截到 40');
    assert.equal(e.gallery.pending({ limit: 3 }).length, 3, '显式 limit 仍然生效');
  } finally { e.cleanup(); }
});

test('停用的图不进「让 AI 整理」的待办（一张一次模型调用，别为不用的图花钱）', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'A'), makeImage(e.root, 'b.png', 'B')]);
    e.gallery.sync({});
    assert.equal(e.gallery.pending().length, 2);

    e.gallery.edit(1, { enabled: false });
    const left = e.gallery.pending();
    assert.equal(left.length, 1);
    assert.equal(left[0].seq, 2, '停用那张不该再被拿去问模型');

    /** 启用之后要能自己回到待办里，不需要用户记得再点一次「整理」 */
    e.gallery.edit(1, { enabled: true });
    assert.equal(e.gallery.pending().length, 2);
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

test('改分类会真挪文件：下一轮同步不会把编辑撤销', () => {
  const e = env();
  try {
    const it = makeImage(e.root, '开心/a.png', 'AAA');
    e.setItems([it]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    const r = e.gallery.edit(seq, { cat: '搞笑' });
    assert.equal(r.ok, true);

    const moved = join(e.root, '搞笑', 'a.png');
    assert.ok(existsSync(moved), '文件要真的挪到新分类目录');
    assert.equal(existsSync(it.path), false, '旧位置不该还留着');

    /**
     * 关键回归：`sync()` 每轮拿**磁盘目录名**覆盖 `rec.cat`。只改索引不搬文件
     * 的话，这里会看到分类被顶回「开心」——用户会以为「改了没生效」。
     */
    e.setItems([{ ...it, path: moved, file: 'a.png', cat: '搞笑', rel: '搞笑/a.png' }]);
    e.gallery.sync({});
    const row = e.gallery.rows({})[0];
    assert.equal(row.cat, '搞笑');
    assert.equal(row.rel, '搞笑/a.png');
  } finally { e.cleanup() }
});

test('改分类同时把侧车带走（否则新位置读不到旧标签）', () => {
  const e = env();
  try {
    const it = makeImage(e.root, '开心/b.png', 'BBB');
    e.setItems([it]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;
    e.gallery.edit(seq, { tags: ['开心'], scenes: '夸人时' });

    const before = `${it.path}.tags`;
    assert.ok(existsSync(before), '侧车先写在旧位置');

    e.gallery.edit(seq, { cat: '搞笑' });
    assert.equal(existsSync(before), false, '旧侧车不能留在原地变孤儿');
    assert.ok(existsSync(join(e.root, '搞笑', 'b.png.tags')), '侧车要跟着图走');
  } finally { e.cleanup() }
});

test('停用的图发不出去——不是只从清单里消失', () => {
  const e = env();
  try {
    const it = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([it]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    assert.ok(e.gallery.pathOf(seq, {}), '没停用时能发');

    e.gallery.edit(seq, { enabled: false });
    assert.equal(e.gallery.list({}, {}).items.length, 0, '清单里看不到');
    /**
     * 模型从历史里记得这个序号，`<<image: #N>>` 照样会来解析。
     * 面板上写着「停用」、群里却出现了那张图，是最难解释的那种不一致。
     */
    assert.equal(e.gallery.pathOf(seq, {}), '', '停用了就绝不能发出去');
  } finally { e.cleanup() }
});

test('单张图这次读不出字节，不能被标成「已消失」', () => {
  const e = env();
  try {
    const it = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([it]);
    e.gallery.sync({});
    assert.equal(e.gallery.rows({}).length, 1);

    /**
     * 造一个「路径还在、字节读不出来」的状态：把文件换成同名目录。
     * `readFileSync` 会抛 EISDIR —— 和 Windows 上杀软占着文件同类。
     * `mtime` 必须换一个值，否则 `shaOf` 的 `path|mtime|size` 缓存会直接命中。
     */
    rmSync(it.path);
    mkdirSync(it.path);
    e.setItems([{ ...it, mtime: 999 }]);

    const r = e.gallery.sync({});
    assert.equal(r.missing, 0, '不能记成缺失');
    assert.equal(e.gallery.rows({}).length, 1, '也不该从面板上消失');
    assert.ok(e.gallery.pathOf(e.gallery.rows({})[0].seq, {}), '这张仍然可发');
  } finally { e.cleanup() }
});

test('改分类不会把图搬到别的根目录（多目录配置）', () => {
  const e = env();
  try {
    /** 第二个根：和 `dir()` 返回的第一个根不是同一处 */
    const rootB = join(e.dataDir, 'stickers-b');
    const it = makeImage(rootB, '开心/b.png', 'BBB');
    e.setItems([it]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    assert.equal(e.gallery.edit(seq, { cat: '搞笑' }).ok, true);
    assert.ok(existsSync(join(rootB, '搞笑', 'b.png')), '要留在原来的根里');
    assert.equal(existsSync(join(e.root, '搞笑', 'b.png')), false, '不能被搬到第一个根');
  } finally { e.cleanup() }
});

test('一次同时改名字和分类：两件都生效，分类是真挪', () => {
  const e = env();
  try {
    const it = makeImage(e.root, '开心/a.png', 'AAA');
    e.setItems([it]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    const r = e.gallery.edit(seq, { cat: '搞笑', name: '熊猫大笑', tags: ['开心'] });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(e.root, '搞笑', 'a.png')));
    assert.equal(r.item.cat, '搞笑');
    assert.equal(r.item.name, '熊猫大笑');
    assert.deepEqual(r.item.tags, ['开心'], '标签要和搬移一起落地');
  } finally { e.cleanup() }
});

test('面板要能看见「停用」：rows 吐 enabled、stats 数得出来', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    const b = makeImage(e.root, 'b.png', 'BBB');
    e.setItems([a, b]);
    e.gallery.sync({});
    const [r1] = e.gallery.rows({});
    assert.equal(r1.enabled, true, '默认是启用的');

    e.gallery.edit(r1.seq, { enabled: false });
    const row = e.gallery.rows({}).find((r) => r.seq === r1.seq);
    /**
     * `pathOf` 已经会挡住停用的图（发不出去）。面板拿不到这个字段的话，
     * 那张图和正常的没区别——用户只会觉得「她怎么从来不发这张」。
     */
    assert.equal(row.enabled, false);
    assert.equal(e.gallery.stats().paused, 1);
    assert.equal(e.gallery.stats().total, 2, '停用不等于消失，总数还是 2');
  } finally { e.cleanup() }
});

test('分类名带 `../` 不能把图挪出图库（`clamp` 挡不住分隔符）', () => {
  const e = env();
  try {
    const it = makeImage(e.root, '开心/a.png', 'AAA');
    e.setItems([it]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    /**
     * `clamp` 只折叠空白、按字数截断——`../../evil` 会原样拼进
     * `join(root, cat)`。模型在提示词里看到「往上两级」这种话，或者用户
     * 手输分类时带了斜杠，图就被搬到库外目录，面板上还显示「改成功了」。
     */
    const r = e.gallery.edit(seq, { cat: '../../evil' });
    assert.equal(r.ok, true, '净化后按「未分类」处理，不该整次失败');

    const escaped = join(e.root, '..', '..', 'evil');
    assert.equal(existsSync(escaped), false, '库外不能建出目录');
    /** 净化掉分隔符后剩 `evil`（点被去掉），落在根目录下 */
    assert.ok(existsSync(join(e.root, 'evil', 'a.png')) || existsSync(join(e.root, 'a.png')), '文件要还在库里');
    assert.equal(e.gallery.rows({})[0].cat.includes('/'), false);
    assert.equal(e.gallery.rows({})[0].cat.includes('..'), false);
  } finally { e.cleanup(); }
});

test('存图时分类名同样净化：不能把新图写到库外', () => {
  const e = env();
  try {
    const src = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([src]);
    const r = e.gallery.save({ from: src.path, cat: '../../outside' });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(e.root, '..', '..', 'outside')), false, '库外不能有目录');
    /** `safeRow` 故意不吐 path（工具返回值不能带路径），落盘位置从 `rows()` 查 */
    const row = e.gallery.rows({}).find((x) => x.seq === r.seq);
    assert.ok(row.path.startsWith(e.root), '落盘路径必须在图库根之内');
    assert.equal(row.cat, 'outside', '分隔符与 `..` 被剥掉，剩一个正常分类名');
  } finally { e.cleanup(); }
});

/* ---------------- 线上副本（官方素材池那份）+ 固定 ---------------- */

test('线上副本：记下来、读得回、清单里看得见 online', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'AAA')]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    assert.equal(e.gallery.remoteOf(seq), null, '没传过就是 null');
    assert.equal(e.gallery.rows({})[0].online, false);
    assert.equal(e.gallery.stats().online, 0);

    e.gallery.markRemote(seq, { imageId: 'img-1', url: 'qqbot-media://abc', ttl: 3600, at: 5000 });
    const r = e.gallery.remoteOf(seq);
    assert.equal(r.imageId, 'img-1');
    assert.equal(r.url, 'qqbot-media://abc');
    /** ttl=3600 秒 → 过期时间 = 5000 + 3600000；调用方拿它判断「还敢不敢复用」 */
    assert.equal(r.expireAt, 5000 + 3_600_000);

    assert.equal(e.gallery.rows({})[0].online, true, '工具返回值里要能看见');
    assert.equal(e.gallery.stats().online, 1);
  } finally { e.cleanup(); }
});

test('线上副本没了（被删/过期）：映射清掉，下次发图才会重传', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'AAA')]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;
    e.gallery.markRemote(seq, { imageId: 'img-1', url: 'qqbot-media://abc' });

    assert.equal(e.gallery.dropRemote('img-1'), true);
    /**
     * 不清的话下次 `<<image: #3>>` 会拿失效引用去发：群里没图，日志只有
     * 「发送失败」，用户和排查的人都看不出是素材被回收了。
     */
    assert.equal(e.gallery.remoteOf(seq), null);
    assert.equal(e.gallery.rows({})[0].online, false);
    assert.deepEqual(e.gallery.onlineIndex(), {});
  } finally { e.cleanup(); }
});

test('配额清理顺序：最久没动过的先走，最近发过的排最后', () => {
  const e = env();
  try {
    e.setItems([
      makeImage(e.root, 'a.png', 'A'),
      makeImage(e.root, 'b.png', 'B'),
      makeImage(e.root, 'c.png', 'C'),
    ]);
    e.gallery.sync({});
    const [s1, s2, s3] = e.gallery.rows({}).map((r) => r.seq);

    e.gallery.markRemote(s1, { imageId: 'i1', url: 'qqbot-media://1', at: 1000 });
    e.gallery.markRemote(s2, { imageId: 'i2', url: 'qqbot-media://2', at: 2000 });
    e.gallery.markRemote(s3, { imageId: 'i3', url: 'qqbot-media://3', at: 3000 });
    /** `now()` 固定在一个很大的值：发过一次的图 lastUsed 就远大于「只上传没发过」 */
    e.gallery.markUsed(s3);

    const order = e.gallery.onlineRows().map((x) => x.imageId);
    /**
     * `s3` 传得最晚、而且最近刚发过 —— 它必须排在最后。
     * 只用上传时间排序的话它会排中间，等于「常用的图反而先被淘汰」。
     */
    assert.deepEqual(order, ['i1', 'i2', 'i3']);
  } finally { e.cleanup(); }
});

test('固定：改了能读回、能进 stats、配额清理候选里排不掉它', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'A'), makeImage(e.root, 'b.png', 'B')]);
    e.gallery.sync({});
    const [s1, s2] = e.gallery.rows({}).map((r) => r.seq);
    e.gallery.markRemote(s1, { imageId: 'i1', url: 'qqbot-media://1', at: 1000 });
    e.gallery.markRemote(s2, { imageId: 'i2', url: 'qqbot-media://2', at: 2000 });

    assert.equal(e.gallery.isPinned(s2), false, '默认不固定');
    assert.equal(e.gallery.edit(s2, { pinned: true }).ok, true);
    assert.equal(e.gallery.isPinned(s2), true);
    assert.equal(e.gallery.rows({}).find((r) => r.seq === s2).pinned, true);
    assert.equal(e.gallery.stats().pinned, 1);

    /** 宿主侧就是这么筛候选的：钉住的直接不参与淘汰 */
    const victims = e.gallery.onlineRows().filter((x) => !x.pinned).map((x) => x.imageId);
    assert.deepEqual(victims, ['i1']);

    /** 取消固定之后要能回来，否则「钉错了」就没救 */
    e.gallery.edit(s2, { pinned: false });
    assert.deepEqual(e.gallery.onlineRows().filter((x) => !x.pinned).map((x) => x.imageId), ['i1', 'i2']);
  } finally { e.cleanup(); }
});

test('固定和停用是两个维度：停用 ≠ 固定，互不覆盖', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'A')]);
    e.gallery.sync({});
    const seq = e.gallery.rows({})[0].seq;

    e.gallery.edit(seq, { enabled: false, pinned: true });
    const row = e.gallery.rows({})[0];
    assert.equal(row.enabled, false, '不发');
    assert.equal(row.pinned, true, '但也不删');

    /** 只改 enabled 不能顺手把 pinned 清掉 */
    e.gallery.edit(seq, { enabled: true });
    assert.equal(e.gallery.rows({})[0].pinned, true);
  } finally { e.cleanup(); }
});

/* ---------------- 合并「表情库 / 图库」之后新增的口径 ---------------- */

test('侧车改了标签和场合，下一轮同步认账（补标签之后图库不能还说未标注）', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});
    assert.deepEqual(e.gallery.list({}, {}).items[0].tags, [], '入库时没标签');

    /**
     * 面板「补标签」/ 表情库那边改标签写的都是侧车，图库下一轮要采回来。
     * 以前只做「索引空了才采」，补完 200 张这里一张都不变。
     */
    e.setItems([{ ...a, tags: ['猫', '无语'], usage: '被问到蠢问题', sidecar: true, sidecarTags: true }]);
    e.gallery.sync({});
    const row = e.gallery.list({}, {}).items[0];
    assert.deepEqual(row.tags, ['猫', '无语']);
    assert.equal(row.scenes, '被问到蠢问题');
  } finally { e.cleanup(); }
});

test('只写了场合说明的侧车不冲掉 AI 写的标签', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});
    e.gallery.edit(1, { tags: ['AI 标过'] });

    /**
     * 用户后来又手写了一句场合（`; 有人装可爱时`），侧车里的 tags 为空。
     * 这时 `stickers.snapshot` 的 `tags` 会退回文件名拆词——拿它覆盖
     * 等于把 AI 的标签冲成「a」，所以判据必须是 `sidecarTags`。
     */
    e.setItems([{
      ...a, tags: ['a'], usage: '有人装可爱时', sidecar: true, sidecarTags: false,
    }]);
    e.gallery.sync({});
    const row = e.gallery.list({}, {}).items[0];
    assert.deepEqual(row.tags, ['AI 标过'], '标签要留着');
    assert.equal(row.scenes, '有人装可爱时', '场合要跟着侧车');
  } finally { e.cleanup(); }
});

test('彻底删除：文件、侧车、记录一起没，序号不再存在', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});
    writeFileSync(`${a.path}.tags`, '猫\n', 'utf8');

    const r = e.gallery.purge(1);
    assert.equal(r.ok, true);
    assert.equal(existsSync(a.path), false, '文件要删掉');
    assert.equal(existsSync(`${a.path}.tags`), false, '侧车要一起删');
    assert.equal(e.gallery.pathOf(1), '', '序号不该再解析出路径');
    assert.equal(Object.keys(e.gallery.dump().items).length, 0, '记录也要删');
  } finally { e.cleanup(); }
});

test('forgetPaths 只忘指定路径的记录：多根下同名的另一张不受影响', () => {
  const e = env();
  const rootB = join(e.dataDir, 'stickers-b');
  mkdirSync(rootB, { recursive: true });
  try {
    const a = makeImage(e.root, '开心/1.png', 'AAA');
    const b = makeImage(rootB, '开心/1.png', 'BBB');
    e.setItems([a, b]);
    e.gallery.sync({});
    assert.equal(e.gallery.rows({}).length, 2);

    /** 面板按绝对路径清理：`rel` 在多根配置下会重名，不能当键 */
    assert.equal(e.gallery.forgetPaths([a.path]), 1);
    const left = e.gallery.rows({});
    assert.equal(left.length, 1);
    assert.equal(left[0].path, b.path, '另一块盘上那张要留着');
  } finally { e.cleanup(); }
});

/* ---------------- 缩略图缓存（面板生成，服务端只存发） ---------------- */

test('缩略图：存完之后 rows 标 thumb，thumbPath 按序号取得到', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});

    assert.equal(e.gallery.rows({})[0].thumb, false, '一开始没有');
    assert.equal(e.gallery.thumbPath(1), null);

    const r = e.gallery.saveThumb(1, Buffer.from('fake-jpeg-bytes'));
    assert.equal(r.ok, true);
    assert.equal(e.gallery.rows({})[0].thumb, true, '存完就要标出来，面板才走缓存');
    assert.ok(existsSync(e.gallery.thumbPath(1)), '文件要真落盘');
    assert.equal(e.gallery.thumbPath(1).endsWith('.jpg'), true);
  } finally { e.cleanup(); }
});

test('缩略图：没有这张图 / 空内容都拒，不落盘', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});

    assert.equal(e.gallery.saveThumb(999, Buffer.from('x')).ok, false, '序号不存在要拒');
    assert.equal(e.gallery.saveThumb(1, Buffer.alloc(0)).ok, false, '空内容要拒');
    assert.equal(e.gallery.rows({})[0].thumb, false);
  } finally { e.cleanup(); }
});

test('缩略图：超过 400KB 拒收——前端压错了不该把数据目录塞满', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});
    const big = Buffer.alloc(401 * 1024, 1);
    const r = e.gallery.saveThumb(1, big);
    assert.equal(r.ok, false);
    assert.match(r.message, /太大/);
    assert.equal(e.gallery.thumbPath(1), null);
  } finally { e.cleanup(); }
});

test('缩略图：彻底删除和忘记录都会清缓存（不留孤儿文件）', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    const b = makeImage(e.root, 'b.png', 'BBB');
    e.setItems([a, b]);
    e.gallery.sync({});
    e.gallery.saveThumb(1, Buffer.from('t1'));
    e.gallery.saveThumb(2, Buffer.from('t2'));

    e.gallery.purge(1);
    assert.equal(e.gallery.thumbPath(1), null, '记录没了，缓存也得走');

    e.gallery.forgetPaths([b.path]);
    assert.equal(e.gallery.rows({}).length, 0);
    /** 目录里不该剩任何 .jpg：键是内容哈希，记录一没就再也对不上了 */
    const left = readdirSync(e.gallery.thumbDir).filter((f) => f.endsWith('.jpg'));
    assert.deepEqual(left, []);
  } finally { e.cleanup(); }
});


test('filePath 按序号取原图：rel 被快照污染成「未分类/…」也照样取得到', () => {
  const e = env();
  try {
    /**
     * 真实场景（2026-11-22 主人报障）：库里既有根目录的图，又有一个真名叫
     * `未分类/` 的子目录。`stickers.snapshot()` 会把**根目录**那些图的
     * `rel` 改写成 `未分类/海妖.png`（为了 `pick('未分类')` 能一起挑到），
     * 但文件其实在根目录 —— 照 rel 取图就是 404，面板上显示成破图。
     */
    const a = makeImage(e.root, '海妖.png', 'AAA');
    a.rel = '未分类/海妖.png';
    a.cat = '未分类';
    e.setItems([a]);
    e.gallery.sync({});

    const seq = e.gallery.rows({})[0].seq;
    assert.equal(e.gallery.filePath(seq), a.path, '要按 path 取，不能按 rel');
    assert.equal(existsSync(e.gallery.filePath(seq)), true);
  } finally { e.cleanup(); }
});

test('filePath：序号不存在或文件已被删都返回 null，不给调用方一个假路径', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});
    assert.equal(e.gallery.filePath(999), null);
    /** 文件被外部删掉但还没 sync：照 null 处理，路由回 404 而不是 500 */
    rmSync(a.path);
    assert.equal(e.gallery.filePath(1), null);
  } finally { e.cleanup(); }
});

test('孤儿缩略图：下次同步有新增图时被清掉，正常那张留着', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});
    e.gallery.saveThumb(1, Buffer.from('t'));

    /** 手塞一个对不上任何记录的（模拟索引重建 / 手改 index.json 留下的） */
    writeFileSync(join(e.gallery.thumbDir, 'deadbeef.jpg'), 'x');

    const b = makeImage(e.root, 'b.png', 'BBB');
    e.setItems([a, b]);
    e.gallery.sync({});

    assert.equal(existsSync(join(e.gallery.thumbDir, 'deadbeef.jpg')), false, '孤儿要清');
    assert.ok(existsSync(e.gallery.thumbPath(1)), '图还在，缩略图不能跟着没');
  } finally { e.cleanup(); }
});

test('filePath：原路径变成一个同名目录时判「没有这张图」，不让读流出 EISDIR', () => {
  const e = env();
  try {
    const a = makeImage(e.root, 'a.png', 'AAA');
    e.setItems([a]);
    e.gallery.sync({});

    /** 用户手动改建 / 解压覆盖：`a.png` 现在是个目录 */
    rmSync(a.path, { force: true });
    mkdirSync(a.path, { recursive: true });

    assert.equal(e.gallery.filePath(1), null);
  } finally { e.cleanup(); }
});

test('pending 传 seqs 时照单执行：带描述、已停用的也跑', () => {
  const e = env();
  try {
    e.setItems([
      makeImage(e.root, 'a.png', 'A'),
      makeImage(e.root, 'b.png', 'B'),
      makeImage(e.root, 'c.png', 'C'),
    ]);
    e.gallery.sync({});
    const rows = e.gallery.rows({});
    const [a, b, c] = rows.map((r) => r.seq);

    /** 给 a 写上描述 + 停用 b：这两种在增量/全量里都会被过滤，手选必须穿过 */
    e.gallery.edit(a, { name: '猫猫', meaning: '一只猫' });
    e.gallery.edit(b, { enabled: 0 });

    const picked = e.gallery.pending({ seqs: [a, b] });
    assert.deepEqual(picked.map((x) => x.seq), [a, b], '选中的要一张不少，且不被增量规则过滤');
    assert.ok(!picked.some((x) => x.seq === c), '没选中的不能混进来');

    /** 增量仍然只挑没描述的 */
    const inc = e.gallery.pending({});
    assert.ok(!inc.some((x) => x.seq === a), '增量不该再挑已有描述的');
  } finally { e.cleanup(); }
});

test('pending 的 seqs 里混进垃圾值只忽略，不整批失败', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'A'), makeImage(e.root, 'b.png', 'B')]);
    e.gallery.sync({});
    const [a] = e.gallery.rows({}).map((r) => r.seq);
    /** 前端可能传来字符串数字、0、负数、NaN，甚至非数组 */
    const r1 = e.gallery.pending({ seqs: [String(a), 0, -1, 'x', null] });
    assert.deepEqual(r1.map((x) => x.seq), [a], '只有真序号留下');
    assert.equal(e.gallery.pending({ seqs: [] }).length, 2, '空数组 = 没指定，走增量');
    assert.equal(e.gallery.pending({ seqs: 'nope' }).length, 2, '非数组也不该抛');
  } finally { e.cleanup(); }
});

test('pending 的 seqs 里放回收站中的图：不收，免得拿没有语义的东西去烧调用', () => {
  const e = env();
  try {
    e.setItems([makeImage(e.root, 'a.png', 'A'), makeImage(e.root, 'b.png', 'B')]);
    e.gallery.sync({});
    const [a, b] = e.gallery.rows({}).map((r) => r.seq);
    e.gallery.remove(b);
    const r = e.gallery.pending({ seqs: [a, b] });
    assert.deepEqual(r.map((x) => x.seq), [a]);
  } finally { e.cleanup(); }
});
