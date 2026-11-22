/**
 * AI 图库：给每张图一个**短序号**，让模型用得上、改得动、存得进。
 *
 * ## 为什么不能直接用 `stickers.js`
 *
 * `stickers.js` 是**文件视角**：扫目录、拼提示词、挑图时给绝对路径。它解决
 * 「模型不知道有哪些图」，但解决不了三件事：
 *
 *   1. 路径抄写易错。`D:\表情\开心\熊猫大笑 (2).png` 这种名字，模型抄错一个
 *      字符就是「图没发出去」，而界面上看不出发生过什么。
 *   2. 没有「这张图是什么意思」。文件名不是描述，`1.png` 更是零信息。
 *   3. 模型不能往里加图、不能改标注。它只能用现有资产，不能养自己的库。
 *
 * 所以这一层加的是**序号 + 可读描述 + 可写**：
 *
 *   · 序号（`#3`）是模型唯一需要抄的东西，短到不会错；
 *   · `name / meaning / tags / scenes / avoid` 是它判断「该不该发这张」的依据；
 *   · 出站写 `<<image: #3>>`，宿主自己把 `#3` 换成真实路径——
 *     **模型从头到尾看不到路径，也看不到 URL**。
 *
 * ## 身份用内容哈希，不用路径
 *
 * 同一张图可能改名、可能从 `开心/` 挪到 `搞笑/`、可能被复制成两份。按路径
 * 记身份会产生三条记录、三个序号，模型看到三张「一样但不一样」的图。
 * 按内容的 sha256 记身份，这些情况自动归一；内容真变了（P过、改过）就是新图，
 * 拿新序号——这也是用户期望的语义。
 *
 * ## 与另外两套标注的关系
 *
 * 项目里已经有两套标注：宿主的 `.tags` 侧车（路径为键）与表情标注扩展的
 * `annotations.json`（sha256 为键）。再建一套 index 就是三套。
 *
 * 处置：**index 是唯一真相，但 `tags` / `scenes` 两项以侧车为准**——
 *   · 入库时读侧车当初始值（用户手写的场合说明不能丢）；
 *   · AI/面板改了标注，回写侧车；
 *   · 反过来，侧车被别处改了（表情库页改标签、补标签、用户手动编辑），
 *     下一轮 `sync()` 采回来。
 *
 * 为什么这两项能「以侧车为准」而不打架：改它们的三条路全都先写侧车
 * （`edit()` 自己就写），所以侧车永远不会比索引旧。而 `name / meaning / avoid`
 * 侧车格式里没有位置，只能留在 index——这才是「index 是唯一真相」的范围。
 *
 * 表情标注扩展的 `annotations.json` **只读**（`gallery-annotations.js`）：
 * 它的键也是内容 sha256、字段名也一致，所以新图入库时拿它的标注当初始值，
 * 已经标过的图不用再花钱让 AI 看一遍。但**绝不回写**——那是另一个进程在写的
 * 文件，两边都写就是抢，谁最后落盘谁赢，用户会看到标注随机丢失。
 * 同理，已经入库的记录不会被它回填：图库这边改过的不许被顶回旧值。
 *
 * ## 为什么回收站是标记不是目录
 *
 * `stickers.js` 把**一级子目录当分类**注入提示词。建一个 `.trash/` 或
 * `回收站/` 目录，模型就会看到一个叫「回收站」的分类，还可能从里面挑图发出去。
 * 所以回收站只能是记录上的 `trash: true`，文件原地不动。
 */

import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync, statSync,
  unlinkSync,
} from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';

import { writeSidecar, SIDECAR } from './sticker-manage.js';
import { dimsOf, dimsOfPath } from './image-size.js';

/** 索引格式版本。字段变了就 +1，老文件整份弃用（重建比迁移省事） */
export const INDEX_VERSION = 1;

/** 一次最多列几条给模型。太多会吃掉答复的注意力，30 条已经够挑 */
export const MAX_LIST = 30;

/**
 * 注入系统提示词的固定说明。
 *
 * **只写规则、不写清单**：清单要调 `gallery_list` 去拿。把清单写进提示词的话，
 * 每加一张图就换掉整段系统前缀，prompt 缓存全失效（`stickers.js` 里分类模式
 * 那段注释算过这笔账）。这段是固定的几十个字，加图不加字。
 *
 * 但**必须有**：不告诉模型「图有编号」，它就不会去调 `gallery_list`，
 * 四个工具全变死代码——这个项目已经在这件事上踩过一次
 * （见 `tools.js` 头注释「功能写好了没人调 = 死代码」）。
 *
 * ## 两种来源必须分开说（2026-11-22 修）
 *
 * 旧文案是一句「**发图时**不要写文件路径，也不要写网址」。它想说的是「图库里
 * 的图别抄路径」，但写在「发图时」这个总前提下面，把另一条合法用法一起禁掉了：
 * 主人说「把刚才那个文件发我」，模型手上只有 `D:\out\报表.xlsx` 旁边那张
 * `D:\out\chart.png`，按这句话它就不敢写路径，只能回一句「我发不了文件」。
 *
 * 现在按**来源**分两条：图库里的图写序号（宿主知道真路径），系统上的文件写
 * 路径（模型手上就是它）。两者宿主都认，不冲突。
 *
 * ## 尺寸为什么也要教
 *
 * QQ 的 markdown 图片语法带尺寸位，不给就由宿主兜底（等比缩到 480 宽）。模型
 * 不知道这件事时，两个后果都很难看：想强调的图被缩得看不清，或者把 1000×300
 * 的长条也按 480 宽发出去（在手机上是一条细线）。清单里带原图宽高（`lineOf`），
 * 这里教怎么写，它就能自己决定放多大。
 */
export const GALLERY_HINT = [
  '【图库】你的图有一个带序号的图库，每张图都有编号、名字、原图尺寸和「什么场合用」。',
  '想看有哪些图：调 gallery_list（可以指定分类，也可以只看没见过的）；'
    + '每行文件名后面那个「宽×高」就是原图尺寸。',
  '不确定某张图到底画了什么、或者想问它某个细节：调 gallery_show 看一眼——它是真的看图，不是靠文件名猜。',
  '发图：**图库里的图只写序号**——`<<image: #3>>`（图和文字同一条）或 `<<image-alone: #3>>`（单独一条）。'
    + '图库的真路径你看不到也不用知道，宿主会换。',
  '**系统上的文件**（主人要的截图、报表、你自己生成的图）反过来，直接写路径：'
    + '`<<image: D:/out/chart.png>>` 或 `<<image-alone: /home/user/a.png>>`——路径和序号都认。',
  '**`<<image:>>` 是行内插图，不另起一行**：图就嵌在你写它的那个位置，和左右文字排在同一段里。'
    + '但图的**高度**会决定这一行有多高——写 200 高，整行就被撑到 200，文字被推到图的上下方，'
    + '看上去像「图和字分成两行」，其实是一行被撑开了。想让它像小表情那样夹在字中间，'
    + '就把高度压到一行文字那么高（`|x14` 左右，见下）。'
    + '`<<image-alone:>>` 是单独一条消息，没有这个问题。',
  '发图带上显示大小：末尾加 `|宽x高`，没写的另一边按原图比例自动补。按用途挑：',
  '　· 和文字齐平、像个小表情：`|x14`（约等于一行汉字的高度；**这只是参考值，可以微调**，'
    + '差一两像素肉眼看不出来，觉得偏大就 12、偏小就 16）；',
  '　· 略大一点的贴纸感：`|x48` 到 `|x72`；',
  '　· 正常表情包：`|160x` 到 `|240x`；',
  '　· 截图、要看清细节的图：`|480x` 到 `|600x`。',
  '只写宽用 `|240x`（最省事，比例不会错），只写高用 `|x14`；'
    + '要特意变形（压扁、拉长）就两个都写：`|320x200`。',
  '不写尺寸也发得出去，但两条路不一样：`<<image:>>` 不写由宿主按原图等比缩到 480 宽（小图不放大）；'
    + '`<<image-alone:>>` 不写就是原图富媒体消息，尺寸完全不受控，长图会铺满好几屏——单独发图尤其要写。',
  '看到想留的图用 gallery_save 存进来：刚收到的图填 last，本地文件填路径，网上的图填 http(s) 链接；'
    + '整理已有的图用 gallery_edit（改名字/含义/场合）和 gallery_remove（撤下来）。',
].join('\n');

/** `gallery_list` 一次最多返回多少行（模型显式要多也不行，防它一口气要 500 条） */
const MAX_LIST_CAP = 60;

/** 单条描述最多几个字。描述是给模型读的，一段话就够，长文反而稀释信号 */
const MAX_TEXT = 60;

/** 30 天。「最近用过」的窗口，和 `judge.mjs` 的候选公式同口径 */
const FRESH_DAYS = 30;

/**
 * 序号 → 索引行。**不含 path，不含 media**。
 *
 * 工具返回值直接进模型上下文，里面出现任何路径或 URL 都等于把内部结构
 * 交给它，它迟早会抄进正文。要路径的只有出站解析那一步，走 `pathOf()`。
 */
const safeRow = (rec) => ({
  seq: rec.seq,
  file: rec.file,
  cat: rec.cat || '',
  name: rec.name || '',
  meaning: rec.meaning || '',
  tags: Array.isArray(rec.tags) ? rec.tags : [],
  scenes: rec.scenes || '',
  avoid: rec.avoid || '',
  hits: Number(rec.hits) || 0,
  bytes: Number(rec.bytes) || 0,
  /**
   * 原图宽高。给模型看的意义：**它得知道这张能不能放大、会不会压扁**。
   *
   * 发图时可以带尺寸（`<<image: #3|320x200>>`），只给一个数时另一半按原图
   * 比例补。模型不知道原大小的话，「这张是 200×200 的方图」和「这张是
   * 1000×300 的长条」在它眼里一样——于是要么全写同一个尺寸把长条压成方块，
   * 要么不敢写、全靠宿主缩到 480 宽。
   *
   * 读不出来是 0（旧索引还没补、或格式不认），清单里就不显示尺寸。
   */
  w: Number(rec.w) || 0,
  h: Number(rec.h) || 0,
  trash: rec.trash === true,
  /**
   * 固定 = 线上副本永不被自动清理。常用的图（口头禅、招牌表情）钉住之后，
   * 配额满了也只会淘汰没钉的那些，不会「发着发着发现那张最常发的没了」。
   */
  pinned: rec.pinned === true,
  /**
   * 线上（官方素材池）有没有副本。
   *
   * 给模型看的意义：同一张图第二次发不用再传一遍，也不占新配额。它不需要
   * 知道 imageId / URL，只要知道「这张已经在线上」就够了。
   */
  online: !!(rec.remote && rec.remote.imageId),
});

/**
 * 一行清单：`#3  开心_001.png  320×240  熊猫大笑 · 笑得很夸张 · 夸人、接玩笑`
 *
 * 四段各有分工：序号是模型要抄的，文件名是它向人提及时用的，尺寸是它决定
 * 「怎么显示」的依据（见 `safeRow` 的 `w/h`），描述是它判断该不该发的依据。
 * 缺哪段就跳过哪段，不留空占位（`· ·` 很干扰阅读）。
 */
export function lineOf(rec) {
  const bits = [];
  if (rec.name) bits.push(rec.name);
  if (rec.meaning) bits.push(rec.meaning);
  const rest = [rec.scenes, Array.isArray(rec.tags) ? rec.tags.join('/') : ''].filter(Boolean);
  if (rest.length) bits.push(rest.join(' · '));
  const w = Math.floor(Number(rec.w) || 0);
  const h = Math.floor(Number(rec.h) || 0);
  const size = w > 0 && h > 0 ? `  ${w}×${h}` : '';
  return `#${rec.seq}  ${rec.file}${size}${bits.length ? `  ${bits.join(' · ')}` : '  未标注'}`;
}

/** 截断到 MAX_TEXT，超了加省略号。中文按字算，别用字节 */
const clamp = (s, max = MAX_TEXT) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return [...v].length > max ? `${[...v].slice(0, max).join('')}…` : v;
};

/**
 * @param {object} o
 * @param {string} o.dataDir 数据根目录，索引落在 `<dataDir>/gallery/index.json`
 * @param {object} [o.stickers] `createStickers()` 的实例，负责「有哪些文件」
 * @param {(m:string)=>void} [o.log]
 * @param {() => number} [o.now] 注入时钟，测试用
 */
export function createGallery({ dataDir, stickers = null, log = () => {}, now = Date.now, externalOf = null } = {}) {
  const dir = join(dataDir, 'gallery');
  const indexPath = join(dir, 'index.json');
  /**
   * 缩略图缓存目录：`<数据目录>/gallery/thumbs/<内容哈希>.jpg`。
   *
   * 键用内容哈希而不是序号：序号会回收、图片会被替换，而哈希天然随内容变。
   * 图库这里不解码图片（零依赖，没有 sharp/jimp），缩略图由**面板**生成后
   * 回传——浏览器有 `createImageBitmap` 的降采样解码，比服务端硬解码还省。
   * 服务端只负责存和发，外加「只认识图库里真有的那张图」这一层校验。
   */
  const thumbDir = join(dir, 'thumbs');
  const thumbPathOf = (sha) => join(thumbDir, `${sha}.jpg`);
  const hasThumb = (sha) => Boolean(sha) && existsSync(thumbPathOf(sha));
  const dropThumb = (sha) => {
    if (!sha) return;
    const p = thumbPathOf(sha);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* 删不掉只是多占几十 KB */ }
  };

  /**
   * 扫一遍缩略图目录，删掉不再对应任何记录的 jpg。
   *
   * 正常路径下 `purge` / `forgetPaths` 会当场删缓存，但有两种情况会留孤儿：
   *   · 索引版本升级（`INDEX_VERSION` 变了整份重建，旧 sha 的缩略图全成孤儿）；
   *   · 用户手改 / 删了 `index.json`。
   * 几十 KB 一个，几百张也就几 MB，但**孤儿永远不会被替换**，只会越积越多。
   *
   * 只在 `sync` 真有新增图时扫（见调用处）：那是唯一能产生孤儿形态变化的时机，
   * 而 readdir 一个目录的成本远小于每轮都扫。
   */
  const sweepThumbs = () => {
    if (!existsSync(thumbDir)) return 0;
    const keep = new Set(Object.keys(load().items));
    let n = 0;
    for (const f of readdirSync(thumbDir)) {
      if (!f.endsWith('.jpg')) continue;
      if (keep.has(f.slice(0, -4))) continue;
      try { unlinkSync(join(thumbDir, f)); n += 1; } catch { /* 下次再试 */ }
    }
    return n;
  };

  /**
   * 内容哈希缓存：`路径|mtime|大小` → sha256。
   *
   * 每张图都要读全文件算哈希，几百张就是几百次读盘。而**绝大多数图一辈子
   * 不变**，`mtime+size` 一变就当新文件重算，够准确。上限 4000 条，超了整体
   * 清空——这个缓存丢了只是慢一次，不需要淘汰策略。
   */
  const hashCache = new Map();

  /** 内存里的索引。`null` = 还没读盘 */
  let st = null;
  /** 有未落盘的改动 */
  let dirty = false;
  /** seq → 记录，脏了就置空重建 */
  let seqMap = null;

  const load = () => {
    if (st) return st;
    try {
      const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (raw && raw.version === INDEX_VERSION && raw.items && typeof raw.items === 'object') {
        st = { version: INDEX_VERSION, seq: Number(raw.seq) || 1, items: raw.items };
        return st;
      }
      /**
       * 版本对不上就整份弃用。
       *
       * 迁移代码是最容易留下永久技术债的东西，而这里的全部数据都能从磁盘
       * 重新扫出来（标注会丢，但标注本来也是新功能）——重建比写迁移划算。
       */
      log(`图库索引版本不符（${raw?.version}），按空库重建`);
    } catch {
      /** 文件不存在 / JSON 坏了：都当空库。第一次运行走的就是这条路 */
    }
    st = { version: INDEX_VERSION, seq: 1, items: {} };
    return st;
  };

  /** seq → sha 的倒排。存在文件里是为了人能看懂，运行时用内存 Map 更快 */
  const seqIndexOf = (s) => {
    const out = {};
    for (const [sha, rec] of Object.entries(s.items)) out[String(rec.seq)] = sha;
    return out;
  };

  /**
   * 落盘。**先写临时文件再改名**：直接覆盖的话，写到一半断电会留下半截 JSON，
   * 下次启动整库读不出来——几百张图的标注一次全丢。
   */
  const flush = () => {
    if (!dirty) return;
    try {
      mkdirSync(dir, { recursive: true });
      const s = load();
      const tmp = `${indexPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...s, seqIndex: seqIndexOf(s) }, null, 2), 'utf8');
      renameSync(tmp, indexPath);
      dirty = false;
    } catch (e) {
      log(`图库索引写盘失败：${e?.message ?? e}`);
    }
  };

  const shaOf = (path, size, mtime) => {
    const key = `${path}|${mtime}|${size}`;
    const hit = hashCache.get(key);
    if (hit) return hit;
    try {
      const sha = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (hashCache.size > 4000) hashCache.clear();
      hashCache.set(key, sha);
      return sha;
    } catch {
      /** 读不了（占用 / 权限 / 刚被删）：这张本次不入库，下次扫到了再说 */
      return '';
    }
  };

  /**
   * 路径 → 原图宽高。读不出来是 `{0,0}`，调用方按「不知道」处理。
   *
   * 只读文件头 64KB（`image-size.js` 的 `dimsOfPath`），代价和一次 `stat` 同级。
   * **不做缓存**：调用点只有「新记录入库」和「老记录补字段」，两者都只发生
   * 一次；每轮都读的场合是零。
   */
  const sizeOfPath = (p) => dimsOfPath(p);

  const bySeq = (seq) => {
    const s = load();
    if (!seqMap) {
      seqMap = new Map();
      for (const [sha, rec] of Object.entries(s.items)) seqMap.set(rec.seq, sha);
    }
    const sha = seqMap.get(Number(seq));
    if (!sha) return null;
    return { sha, rec: s.items[sha] };
  };

  /** 改过就置脏：seqMap 与磁盘内容都得跟着变 */
  const touch = () => {
    dirty = true;
    seqMap = null;
  };

  /**
   * 把「磁盘上有什么」合并进索引。
   *
   * 幂等：反复调用只有第一次会新增。**不删除消失的记录**——图被挪走时
   * 记录留着（标 `missing`），用户挪回来序号还是原来那个。删记录会让
   * 序号空洞化，而模型记着 `#12` 时图库却说「没有 12 号」，比留着更困惑。
   */
  const sync = (cfg = {}) => {
    if (!stickers) return { added: 0, total: 0, missing: 0 };
    const s = load();
    let snap;
    try {
      snap = stickers.snapshot(cfg);
    } catch (e) {
      log(`图库同步失败：${e?.message ?? e}`);
      return { added: 0, total: Object.keys(s.items).length, missing: 0 };
    }

    const alive = new Set();
    /**
     * 读不出字节的文件（被占用 / 杀软正在扫 / 权限）。
     *
     * 它们**不是**「已删除」，只是这一轮算不出哈希——所以既不算活，也绝不能
     * 标成 `missing`。标错一次的表现是：那张图当场发不出去（`pathOf` 见到
     * `missing` 就返回空串），而文件明明还在。Windows 上杀软扫大图很常见。
     */
    const unreadable = new Set();
    /**
     * 路径 → 已有记录的 sha。读不出字节时靠它在「不重算哈希」的前提下认出
     * 「这是哪条记录」，从而把它排除在 `missing` 判定之外。每轮现建，条目数
     * 和图库张数同级（几百），代价可忽略。
     */
    const knownByPath = new Map();
    for (const [sha, rec] of Object.entries(s.items)) {
      if (rec.path) knownByPath.set(rec.path, sha);
    }
    let added = 0;

    /**
     * 表情标注扩展的标注表（只读）。**每轮同步读一次**，不是每张图读一次；
     * 内部按文件 mtime 缓存，没变就不重读。
     *
     * 用它的时机只有一个：新建记录时当初始值。已经在图库里的记录**绝不**
     * 拿它回填——那会把用户在图库里改过的标注顶回旧值（扩展那边不会知道
     * 这里改过）。宁可少补一次，也不能覆盖。
     */
    let extBySha = null;
    if (typeof externalOf === 'function') {
      try {
        extBySha = externalOf()?.bySha ?? null;
      } catch (e) {
        /** 扩展的文件坏了 / 权限不对：跳过，不影响本家同步 */
        log(`表情标注扩展的标注没用上：${e?.message ?? e}`);
        extBySha = null;
      }
    }

    for (const it of snap.items ?? []) {
      const sha = shaOf(it.path, it.size, it.mtime);
      if (!sha) {
        /**
         * 这一轮算不出哈希，但**不代表文件没了**。按路径找回原记录、加进
         * `unreadable`，下面标 `missing` 时整条跳过——它既不算活也不算死，
         * 保持上一轮的状态。
         *
         * 为什么非这么处理：`shaOf` 读失败也返回空串，和「文件不存在」共用一个
         * 返回值。如果不区分，一次瞬时读失败就会让那张图当场发不出去
         * （`pathOf` 见 `missing` 返回空串），而文件明明还在。Windows 上杀软
         * 扫大图、同步盘正上传，都会造成这一两秒的占用。
         */
        const prevSha = knownByPath.get(it.path);
        if (prevSha) unreadable.add(prevSha);
        continue;
      }
      alive.add(sha);
      const prev = s.items[sha];

      if (!prev) {
        const ext = extBySha?.get(sha) ?? null;
        const dims = sizeOfPath(it.path);
        s.items[sha] = {
          seq: s.seq++,
          file: it.file,
          cat: it.cat || '',
          path: it.path,
          /** 库内相对位置（显示用；取图走 `/gallery/file?seq=N`，见 `filePath`） */
          rel: it.rel || '',
          /**
           * `name` 空着等 AI 或用户填。
           * 文件名当 name 没意义（`1.png` 当名字等于没名字），宁可显示「未标注」
           * ——那是个明确信号：这里缺东西，值得补。
           *
           * 但有别的来源就先采：侧车（用户手写）> 标注扩展（用户标过）> 空。
           */
          name: ext?.name || '',
          meaning: ext?.meaning || '',
          /** 侧车标签是用户手写的，拿来当初始值最合适（见文件头「两套标注」） */
          tags: Array.isArray(it.tags) && it.tags.length
            ? it.tags.slice(0, 6)
            : (Array.isArray(ext?.tags) ? ext.tags.slice(0, 6) : []),
          scenes: it.usage || ext?.scenes || '',
          avoid: ext?.avoid || '',
          enabled: true,
          bytes: it.size,
          /** 原图宽高。模型靠它决定发图时怎么写尺寸（见 `safeRow` 的 `w/h`） */
          w: dims.w,
          h: dims.h,
          at: now(),
          usedAt: 0,
          hits: 0,
          /** 标出来源，面板/排障时能一眼看出「这描述哪来的」 */
          src: ext ? 'annotations' : 'scan',
          trash: false,
          missing: false,
        };
        added += 1;
        touch();
        continue;
      }

      /**
       * 同一张图换了位置 / 文件名 / 分类：跟着更新，**序号不动**。
       *
       * `rel` 一起跟着改，但它**只用于显示和侧车定位，不再当取图依据**。
       * `stickers.snapshot()` 在库里存在一个真名叫 `未分类/` 的目录时，会把
       * **根目录**那些图的 `rel` 改写成 `未分类/xxx`（为了让 `pick('未分类')`
       * 一起挑到）。因此按 `rel` 拼 `/stickers/file?path=` 会 404——面板上
       * 是一张破图，显示「图片过大会看不到」，其实是路径错了。
       * 面板显示走 `/gallery/file?seq=N`（见 `filePath`）。
       */
      let changed = false;
      if (prev.path !== it.path) { prev.path = it.path; changed = true; }
      if (prev.file !== it.file) { prev.file = it.file; changed = true; }
      if ((prev.rel || '') !== (it.rel || '')) { prev.rel = it.rel || ''; changed = true; }
      if ((prev.cat || '') !== (it.cat || '')) { prev.cat = it.cat || ''; changed = true; }
      if (prev.bytes !== it.size) { prev.bytes = it.size; changed = true; }
      if (prev.missing) { prev.missing = false; changed = true; }

      /**
       * 老索引没有 `w/h`（这个字段是后加的）。**不 bump `INDEX_VERSION`**：
       * 那会让整库重建、所有标注一次丢光，只为一个能现场算出来的字段不值得。
       *
       * 补一次就够：尺寸跟着**内容**走，而内容一变 sha 就变、记录就是新的了；
       * 换路径 / 改名 / 换分类都不会改内容，也就不会改尺寸。
       */
      if (!(Number(prev.w) > 0) || !(Number(prev.h) > 0)) {
        const dims = sizeOfPath(it.path);
        if (dims.w > 0 && dims.h > 0) {
          prev.w = dims.w;
          prev.h = dims.h;
          changed = true;
        }
      }

      /**
       * ## 侧车是 `tags` / `scenes` 的唯一真相
       *
       * 这两项有三个地方能改：面板、`gallery_edit` 工具、以及表情库那边的
       * 「改标签 / 补标签」。前两条都经 `edit()` **回写侧车**，最后一条直接
       * 写侧车——所以「以侧车为准」对三方都成立，不需要双向合并。
       *
       * 以前只做「索引空了才采」，后果很具体：补标签（规则、免费）写完
       * 200 张侧车，图库这边一张都没变，那 200 张仍然躺在「让 AI 整理」的
       * 待办里，再花 200 次视觉调用描述一遍。两份标注互不认账。
       *
       * 判据用 `sidecarTags` 而不是 `sidecar`：只写了场合说明的侧车会让
       * `tags` 退回文件名拆词，拿它覆盖等于把 AI 写过的标签冲掉。
       */
      if (it.sidecarTags && Array.isArray(it.tags) && it.tags.length) {
        const tags = it.tags.slice(0, 6);
        if (JSON.stringify(prev.tags || []) !== JSON.stringify(tags)) {
          prev.tags = tags;
          changed = true;
        }
      } else if (!it.sidecar && (!prev.tags || !prev.tags.length) && Array.isArray(it.tags) && it.tags.length) {
        /**
         * 没有侧车时才拿文件名拆出来的词兜底。
         *
         * 有侧车却没写标签（只写了一句话的场合说明）就**不兜底**：那说明用户
         * 已经动过这张图，文件名拆出来的「a」「(1)」不是他要的标签。
         */
        prev.tags = it.tags.slice(0, 6);
        changed = true;
      }
      /**
       * 场合：**只在侧车真的写了说明时采**（`it.usage` 非空）。
       *
       * 不能按「侧车存在就以它为准」处理空串：侧车可能只写了标签（`猫`，没有
       * `; 场合`），而这条记录的 `scenes` 是从表情标注扩展的 `annotations.json`
       * 补进来的。把空串采过来，等于用「侧车没写」覆盖掉「别处写过」。
       * 空值分不清「用户刚清空」和「这里从来没有」，就不动它。
       */
      if (it.sidecar && it.usage) {
        const scenes = String(it.usage);
        if ((prev.scenes || '') !== scenes) {
          prev.scenes = scenes;
          changed = true;
        }
      }
      if (changed) touch();
    }

    /**
     * 文件消失了的记录**留着**、只标 `missing`（见上面 `sync` 的说明）。
     * 反过来也成立：文件又出现了，`missing` 要摘掉，否则它永远不再进清单。
     *
     * **有目录读不出来时一律不标 missing。** 目录被临时移走、网络盘掉线、
     * 权限一夜之间变了，都会让 `snapshot` 返回空清单——那时候全库标 missing，
     * 模型立刻「一张图都没有」，比晚几秒发现图被删糟得多。宁可留着旧记录。
     */
    let missing = 0;
    const blind = Array.isArray(snap.missing) && snap.missing.length > 0;
    if (blind) log(`图库同步时 ${snap.missing.length} 个目录读不到，本次不标记缺失`);
    if (unreadable.size) log(`图库同步时 ${unreadable.size} 张图这次读不出字节（被占用？），本次不标记缺失`);
    for (const [sha, rec] of Object.entries(s.items)) {
      if (blind) break;
      /** 读不出字节的那些：这一轮不给它下结论（见上面 `unreadable` 的说明） */
      if (unreadable.has(sha)) continue;
      const isGone = !alive.has(sha);
      if (Boolean(rec.missing) !== isGone) {
        rec.missing = isGone;
        if (isGone) missing += 1;
        touch();
      } else if (isGone) {
        missing += 1;
      }
    }

    flush();
    /** 有新增图才扫孤儿缩略图：索引重建 / 手改 index 之后不留下永远对不上的缓存 */
    if (added > 0) {
      try { sweepThumbs(); } catch { /* 扫不动只是多占几十 KB，不影响同步结果 */ }
    }
    return { added, total: Object.keys(s.items).length, missing };
  };

  /**
   * 候选排序：热度优先、最近用过的往后放。
   *
   * 和表情标注扩展的公式同口径（`judge.mjs`：标签命中 +3、最近用过 -2）——
   * 目的是**别连着两轮给同一张**。`hits*2` 让常用的自然浮上来，
   * 「刚用过 -3」压住刷屏。
   */
  const scoreOf = (rec, t = now()) => {
    const hits = Number(rec.hits) || 0;
    const fresh = rec.usedAt && t - rec.usedAt < FRESH_DAYS * 86400_000 ? 3 : 0;
    return hits * 2 - fresh;
  };

  /**
   * 列清单。`cat` 过滤分类，`fresh` 只要没用过的。
   *
   * @returns {{ok:true, items:Array, total:number, cats:Array<{name:string,count:number}>, text:string}}
   */
  const list = (cfg = {}, { cat = '', n = MAX_LIST, fresh = false } = {}) => {
    sync(cfg);
    const s = load();
    const want = String(cat ?? '').trim();

    const all = Object.values(s.items)
      .filter((r) => !r.trash && !r.missing && r.enabled !== false)
      .filter((r) => !want || (r.cat || '') === want)
      .filter((r) => !fresh || !r.usedAt);

    all.sort((a, b) => scoreOf(b) - scoreOf(a) || a.seq - b.seq);

    const cap = Math.max(1, Math.min(Number(n) || MAX_LIST, MAX_LIST_CAP));
    const shown = all.slice(0, cap);

    /**
     * 分类统计按**全库**算，不按过滤后的结果算。
     *
     * 模型问「有哪些分类」时想看的是整库结构；如果按 `cat` 过滤后统计，
     * 结果里永远只有它刚才问的那一个分类，等于没回答。
     */
    const byCat = new Map();
    for (const r of Object.values(s.items)) {
      if (r.trash || r.missing || r.enabled === false) continue;
      const c = r.cat || UNCAT();
      byCat.set(c, (byCat.get(c) || 0) + 1);
    }
    const cats = [...byCat.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      ok: true,
      items: shown.map(safeRow),
      total: all.length,
      cats,
      text: [
        ...shown.map((r) => lineOf(r)),
        all.length > shown.length ? `（共 ${all.length} 张，只列了前 ${shown.length} 张）` : '',
        `共 ${all.length} 张；分类：${cats.length ? cats.map((c) => `${c.name} ${c.count}`).join(' / ') : '（都未分类）'}`,
      ].filter(Boolean).join('\n'),
    };
  };

  /** 「未分类」的显示名，与 `stickers.js` 保持一致 */
  const UNCAT = () => '未分类';

  /**
   * 序号 → 真实路径。**出站解析专用，绝不出现在工具返回值里**。
   *
   * 已进回收站 / 文件已消失 / 被 `gallery_edit` 关掉的返回空串，调用方按
   * 「发不出去」处理并记日志——绝不能把 `#3` 这串原样发进群里。
   *
   * `enabled === false` 也必须挡在这一层。它原来只影响 `list()`，模型从历史里
   * 记得序号就能照发——面板上那张图明明已经「停用」，群里却出现，是最难解释的
   * 那种不一致。
   */
  const pathOf = (seq, cfg = {}) => {
    sync(cfg);
    const hit = bySeq(seq);
    if (!hit) return '';
    const { rec } = hit;
    if (rec.trash || rec.missing || rec.enabled === false) return '';
    if (!rec.path || !existsSync(rec.path)) return '';
    return rec.path;
  };

  /**
   * 记一次使用。`hits` 是"被选中并真的发出去"的次数，不是"被列出来"。
   *
   * 存 index 不存 sessions.json：那张表是整条覆盖写（`sessions.set()` 全量
   * 替换），热度字段混进去会被别的更新顺手抹掉。
   */
  const markUsed = (seq) => {
    const hit = bySeq(seq);
    if (!hit) return false;
    const { rec } = hit;
    rec.hits = (Number(rec.hits) || 0) + 1;
    rec.usedAt = now();
    touch();
    flush();
    return true;
  };

  /**
   * ## 线上副本（官方素材池里的那一份）
   *
   * 图库有两种存放位置，不是「本地 + 临时车道」：
   *
   *   · **本地**：源文件在表情目录，`sha256` 是主键，永远是真相；
   *   · **线上**：官方机器人级图床（`/v2/media-images`，100 张共享配额）。
   *     发图时把本地那份传上去，拿 `qqbot-media://` 引用发出去。
   *
   * 线上那份**默认留着**（框架 `media.markdownImage` 的默认语义就是「可复用、
   * 默认保留」）。留着的好处是同一张图第二次发不用重传——省几秒、也省一次
   * 配额占用。**「传完就删」只是一种模式**（配额紧张时省配额），不是唯一正确
   * 做法；本文件把它做成可配的 `keepUploads`。
   *
   * 映射存在索引里而不是另外一张表：`imageId` 是这张图在线上那次上传的
   * 身份，跟着记录走最自然；记录被彻底删掉时映射一起消失，不会留下悬空引用。
   */

  /** 这张图的线上副本（没传过 / 传过但被删了 → null） */
  const remoteOf = (seq) => {
    const hit = bySeq(seq);
    const r = hit?.rec?.remote;
    if (!r || !r.imageId) return null;
    const at = Number(r.at) || 0;
    const ttl = Number(r.ttl) || 0;
    return {
      imageId: r.imageId,
      url: r.url || '',
      at,
      /**
       * 什么时候过期：官方给 `ttl` 才估得出来，没给就是 `0`（不知道）。
       *
       * 调用方拿它决定「还敢不敢复用」——拿一个马上失效的 `qqbot-media://`
       * 去发，结果是群里没图、日志只有一句「发送失败」。
       */
      expireAt: ttl > 0 ? at + ttl * 1000 : 0,
    };
  };

  /**
   * 记下「这张图已经传到线上」。
   *
   * `url` 是 `qqbot-media://` 引用（长期有效，可写进下一条消息）；`ttl` 是
   * 官方给的存活秒数，留着给面板判断「是不是快到期了」，不影响复用。
   */
  const markRemote = (seq, info = {}) => {
    const imageId = String(info.imageId ?? '').trim();
    if (!imageId) return false;
    const hit = bySeq(seq);
    if (!hit) return false;
    hit.rec.remote = {
      imageId,
      url: String(info.url ?? ''),
      at: Number(info.at) || now(),
      ttl: Number(info.ttl) || 0,
    };
    touch();
    flush();
    return true;
  };

  /**
   * 线上那份没了（面板删了素材 / 平台按有效期回收）→ 清掉映射。
   *
   * **不清的话后果很具体**：下次 `<<image: #3>>` 会拿一个已经失效的
   * `qqbot-media://` 去发，平台报错、群里没图，而日志只说「发送失败」。
   */
  const dropRemote = (imageId) => {
    const id = String(imageId ?? '').trim();
    if (!id) return false;
    const s = load();
    let touchedAny = false;
    for (const rec of Object.values(s.items)) {
      if (rec?.remote?.imageId !== id) continue;
      delete rec.remote;
      touchedAny = true;
    }
    if (touchedAny) {
      touch();
      flush();
    }
    return touchedAny;
  };

  /** `imageId → seq`：面板把池子里的素材对回图库序号（认不出的就是别人传的） */
  const onlineIndex = () => {
    const s = load();
    const out = {};
    for (const rec of Object.values(s.items)) {
      const id = rec?.remote?.imageId;
      if (id) out[id] = rec.seq;
    }
    return out;
  };

  /**
   * 配额清理用的候选清单：**已经是线上副本的那些图**，最该走的排在最前。
   *
   * 排序口径是「**最久没动过的先走**」（`lastUsed` 升序），不是「先传的先走」：
   *
   *   · 一张经常被发的图，即使传得早也不该因为「老」被淘汰；
   *   · 从没被发过的图 `lastUsed` 就等于上传时间，于是「最先过期」的自然
   *     排在最前——和官方按 `expires_at` 回收的先后一致；
   *   · 用户问「为什么删了这张」时，答案是「它最久没被用过」，一句话能说清。
   *
   * 常用的图靠 `pinned` 挡，不靠排序；混在一起会让用户算不清「为什么这张
   * 留下来了」。
   */
  const onlineRows = () => {
    const s = load();
    const out = [];
    for (const rec of Object.values(s.items)) {
      if (!rec?.remote?.imageId) continue;
      /**
       * 回收站里的也进来：那张已经不发了，线上副本白占一格配额，最该先走。
       * 恢复之后第一次发会重新上传，代价只是一次传输。
       */
      const at = Number(rec.remote.at) || 0;
      const usedAt = Number(rec.usedAt) || 0;
      out.push({
        seq: rec.seq,
        imageId: rec.remote.imageId,
        at,
        usedAt,
        /**
         * 「最后一次被动过」：发过就按 `usedAt`，从没发过就按上传时间。
         * 两者取最大——只用 `at` 会把「传得早但天天发」的图排到最前面，
         * 只用 `usedAt` 会让从没发过的图（`usedAt=0`）全部并列排最前。
         */
        lastUsed: Math.max(at, usedAt),
        pinned: rec.pinned === true,
      });
    }
    return out.sort((a, b) => a.lastUsed - b.lastUsed || a.seq - b.seq);
  };

  /** 这张图是不是被钉住了（配额清理的豁免名单） */
  const isPinned = (seq) => {
    const hit = bySeq(seq);
    return hit?.rec?.pinned === true;
  };

  /**
   * 把记录对应的文件真挪到新分类目录，并同步 `path` / `file` / `cat`。
   *
   * **只改 `rec.cat` 是不行的**：`sync()` 每轮都拿磁盘上的目录名覆盖 `rec.cat`，
   * 下一次同步就把这次编辑静默撤销；中间那几秒 `rel` 还指向不存在的路径，
   * 面板缩略图直接 404。工具描述写的是「把放错分类的挪过去」——那就得真挪。
   *
   * 叫 `moveToCat` 而不是 `rename`：它同时负责侧车跟随与扫描缓存失效，不是
   * 单纯的 `renameSync` 包装。
   *
   * @returns {{ok:boolean, message?:string}} 失败时调用方**不要**改 `rec.cat`，
   *   否则会出现「索引说在新分类、文件还在旧分类」的分裂状态。
   */
  const moveToCat = (rec, cat) => {
    if (!rec.path) return { ok: false, message: '这条记录没有文件路径（可能还没扫到）' };
    /**
     * 这条记录**当前所在的那个根**，从 `path` 反推，不能用 `pickSaveRoot()`。
     *
     * `pickSaveRoot()` 给的是配置里的第一个根；图可能躺在第二个根里（多目录
     * 配置的常见用法：一个自用、一个收图）。拿第一个根当目标，等于「改个分类
     * 把文件搬到了另一块磁盘」，用户会看到图从自己那个目录里凭空消失。
     *
     * `stickers.js` 只扫一层，所以路径形状是确定的：带分类的记录是
     * `<根>/<分类>/<文件>`，没分类的是 `<根>/<文件>`。
     */
    const parent = dirname(rec.path);
    const curCat = rec.cat || '';
    const root = (curCat && basename(parent) === curCat) ? dirname(parent) : parent;
    const target = uniquePath(join(cat ? join(root, cat) : root, rec.file || basename(rec.path)));
    if (target === rec.path) { rec.cat = cat; return { ok: true }; }

    try {
      mkdirSync(dirname(target), { recursive: true });
      try {
        renameSync(rec.path, target);
      } catch (e) {
        /**
         * 跨盘 rename 会抛 `EXDEV`（表情库在 D 盘、临时目录在 C 盘之类）。
         * 复制再删等价，只是慢一点；两条都失败才真算失败。
         */
        if (e?.code !== 'EXDEV') throw e;
        copyFileSync(rec.path, target);
        unlinkSync(rec.path);
      }
    } catch (e) {
      return { ok: false, message: `挪到「${cat || UNCAT()}」失败：${e?.message ?? e}` };
    }

    /**
     * 侧车跟着走。`stickers.js` 按**路径**找侧车（`${abs}.tags`），不搬就等于
     * 把用户手写的标签留在旧目录，新位置的图变成「未标注」。
     */
    try {
      const from = `${rec.path}${SIDECAR}`;
      if (existsSync(from)) renameSync(from, `${target}${SIDECAR}`);
    } catch (e) {
      log(`侧车没跟着挪（${rec.file}）：${e?.message ?? e}`);
    }

    rec.path = target;
    rec.file = basename(target);
    rec.cat = cat;
    /** 提示词里的分类是扫描结果，挪完不清缓存最多还差 3 秒 */
    stickers?.invalidate?.();
    return { ok: true };
  };

  /**
   * 改标注。
   *
   * 只认白名单字段：`seq / path / bytes / at` 这些是**身份与事实**，改了就等于
   * 伪造一张不存在的图。`trash` 走 `remove()`，这里也不收。
   *
   * @returns {{ok:boolean, item?:object, message?:string}}
   */
  const edit = (seq, patch = {}) => {
    const hit = bySeq(seq);
    if (!hit) return { ok: false, message: `没有 ${seq} 号` };
    const { rec } = hit;

    const str = (v, max = MAX_TEXT) => clamp(v, max);
    const touched = [];
    const set = (k, v) => { rec[k] = v; touched.push(k); };

    /**
     * **分类放最前面**：它是唯一会失败的一步（文件被占用、跨盘、目标目录建不出来），
     * 放在其它字段之后的话，失败时前面的 `name / tags` 已经改进内存里的 `rec` 了，
     * 而这条 `return` 不会 `flush()`——改动留在内存里，等下一次谁触发落盘就
     * 悄悄写进去。用户看到「挪分类失败」，但名字其实已经被改了。
     */
    if (patch.cat !== undefined) {
      /** 和 `save()` 用同一个净化：分类名直接拼路径，`clamp` 挡不住 `../` */
      const want = safeCat(patch.cat);
      /** 分类没变就别动文件：`edit({cat: 原值})` 不该产生一次磁盘搬移 */
      if (want !== (rec.cat || '')) {
        const moved = moveToCat(rec, want);
        if (!moved.ok) return { ok: false, message: moved.message };
      }
      /** 走到这里说明意图是「改分类」，哪怕 `moveToCat` 判定文件已在目标位置 */
      touched.push('cat');
    }
    if (patch.name !== undefined) set('name', str(patch.name, 20));
    if (patch.meaning !== undefined) set('meaning', str(patch.meaning, 80));
    if (patch.scenes !== undefined) set('scenes', str(patch.scenes, 60));
    if (patch.avoid !== undefined) set('avoid', str(patch.avoid, 40));
    if (patch.enabled !== undefined) set('enabled', patch.enabled !== false);
    /**
     * 固定：只影响「配额满时自动淘汰」，不影响能不能发。
     * 和 `enabled` 是两个维度——停用是「别发这张」，固定是「别删这张」。
     */
    if (patch.pinned !== undefined) set('pinned', patch.pinned === true);
    if (patch.tags !== undefined) {
      const tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags).split(/[,，、\s]+/))
        .map((t) => String(t ?? '').trim())
        .filter(Boolean)
        .slice(0, 6);
      set('tags', tags);
    }
    if (!touched.length) return { ok: false, message: '没有可改的字段' };

    /**
     * 回写侧车，只写 `.tags` 装得下的两个字段（标签 + 场合）。
     *
     * `name / meaning / avoid` 侧车格式里没有位置，只能留在 index——这就是
     * 「index 是唯一真相」的含义：侧车是它的一份投影，不是对等的另一份。
     * 写失败不影响 index 已改的事实，只记日志：用户看到的还是改过的结果。
     */
    if (touched.includes('tags') || touched.includes('scenes')) {
      try {
        writeSidecar(rec.path, rec.tags, rec.scenes);
        /** 侧车变了要立刻失效扫描缓存，否则提示词最多还拿着旧标签 3 秒 */
        stickers?.invalidate?.();
      } catch (e) {
        log(`侧车回写失败（${rec.file}）：${e?.message ?? e}`);
      }
    }

    touch();
    flush();
    return { ok: true, item: safeRow(rec) };
  };

  /**
   * 移入回收站。**不物理删**，文件原地不动（见文件头最后一段）。
   *
   * 真删只留给人：面板的删除按钮本来就是真删，那条路不需要这里再给一次。
   */
  const remove = (seq) => {
    const hit = bySeq(seq);
    if (!hit) return { ok: false, message: `没有 ${seq} 号` };
    hit.rec.trash = true;
    touch();
    flush();
    return { ok: true, item: safeRow(hit.rec) };
  };

  /** 从回收站拿回来 */
  const restore = (seq) => {
    const hit = bySeq(seq);
    if (!hit) return { ok: false, message: `没有 ${seq} 号` };
    hit.rec.trash = false;
    touch();
    flush();
    return { ok: true, item: safeRow(hit.rec) };
  };

  /** 路径比较用的键：Windows 不区分大小写，盘符大小写不一致很常见 */
  const pathKey = (p) => {
    const v = String(p ?? '');
    return process.platform === 'win32' ? v.toLowerCase() : v;
  };

  /**
   * 丢掉某个路径的哈希缓存。
   *
   * **不丢会被自己的缓存复活**：`hashCache` 的键是 `路径|mtime|size`，文件真删
   * 之后那一条还在，下一次 `sync()` 直接从缓存拿到哈希——于是「磁盘上已经没有
   * 这张图」这件事被缓存盖住，记录又被当成新图建回来，`missing` 还是 `false`。
   * 表现是面板上删掉的图过一会儿自己回来了，而且删不掉。
   */
  const dropHashOf = (path) => {
    const pre = `${path}|`;
    for (const k of [...hashCache.keys()]) if (k.startsWith(pre)) hashCache.delete(k);
  };

  /**
   * 文件**已经被删掉了**（面板批量真删、或用户自己在资源管理器里清了）：
   * 把这些路径的记录一并忘掉。
   *
   * 为什么不留给 `sync()` 标 `missing`：`missing` 是给「暂时找不到、挪回来
   * 还能用」准备的（网盘掉线、图被挪走）。真正删掉的文件留在索引里就是幽灵
   * ——用户在图库面板上明明删过一遍，回收站里却还躺着一张永远恢复不了的记录。
   *
   * **按绝对路径匹配，不按 `rel`**：多根配置下两个根可能都有 `开心/1.png`，
   * 按相对名匹配会把另一个盘上那张还在的图一起忘掉。
   */
  const forgetPaths = (paths = []) => {
    const want = new Set((Array.isArray(paths) ? paths : []).map(pathKey).filter(Boolean));
    if (!want.size) return 0;
    const s = load();
    let n = 0;
    for (const [sha, rec] of Object.entries(s.items)) {
      if (!want.has(pathKey(rec.path))) continue;
      dropHashOf(String(rec.path || ''));
      dropThumb(sha);
      delete s.items[sha];
      n += 1;
    }
    if (n) {
      touch();
      flush();
    }
    return n;
  };

  /**
   * 彻底删掉一张：删文件（含侧车）+ 删记录。回收站里的「彻底删除」走这条。
   *
   * 只有这里会删记录，别的路径都只标 `trash`——序号因此可能出现空洞，那是
   * 用户明确说「不要了」的代价；留着记录反而让回收站永远清不空。
   */
  const purge = (seq) => {
    const hit = bySeq(seq);
    if (!hit) return { ok: false, message: `没有 ${seq} 号` };
    const { sha, rec } = hit;
    const path = String(rec.path || '');
    if (path) {
      for (const p of [path, `${path}${SIDECAR}`]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch (e) {
          /** 删不掉（Windows 占用 / 权限）就别删记录：留一条能再过一次的记录，
           *  比「文件还在、图库说没了」好 */
          return { ok: false, message: `删不掉这个文件：${e?.message ?? e}` };
        }
      }
      /** 缓存不清，下一次 sync 会用它把记录原样建回来（见 `dropHashOf`） */
      dropHashOf(path);
    }
    delete load().items[sha];
    touch();
    flush();
    /** 目录里少了一张：提示词的分类计数要重算 */
    stickers?.invalidate?.();
    dropThumb(sha);
    return { ok: true };
  };

  /**
   * 按序号取原图绝对路径（面板显示用），没有就 null。
   *
   * **不认 `rel`**：`stickers.snapshot()` 在库里存在一个真名叫 `未分类/` 的
   * 目录时，会把**根目录**那些图的 `rel` 改写成 `未分类/xxx`（`stickers.js`
   * 的归并逻辑，本意是让根目录散图能跟 `未分类` 一起被 `pick()` 挑到）。
   * 那是显示层的归并，不是真实位置——照它取图一律 404，面板上就是破图。
   * 序号 → 记录 → `path`（同步时记的绝对路径）+ 存在性判断，才是准的；
   * 数字序号也不给路径穿越留任何口子。
   */
  const filePath = (seq) => {
    const hit = bySeq(seq);
    if (!hit) return null;
    const p = String(hit.rec.path || '');
    if (!p) return null;
    /**
     * `isFile()` 而不是 `existsSync()`：记录里的路径如果被换成同名**目录**
     * （用户手动改建、解压覆盖），`createReadStream` 会 EISDIR，而路由那边
     * 一旦没接住 'error' 就是 uncaughtException。这里直接判成「没有这张图」。
     */
    try {
      return statSync(p).isFile() ? p : null;
    } catch {
      return null;
    }
  };

  /**
   * 这个序号有没有缩略图缓存，有就返回绝对路径。
   *
   * 只按序号查，**不接受前端给路径**：序号 → 记录 → sha → 固定文件名，
   * 中间没有任何一段是外部输入拼出来的，天然没有路径穿越。
   */
  const thumbPath = (seq) => {
    const hit = bySeq(seq);
    if (!hit) return null;
    const p = thumbPathOf(hit.sha);
    return existsSync(p) ? p : null;
  };

  /**
   * 存一张缩略图（面板用 `createImageBitmap` 降采样后回传的 JPEG）。
   *
   * 为什么缩略图在浏览器生成：项目零依赖，服务端没有能解码 PNG 的库。
   * 浏览器这边 `createImageBitmap(blob, {resizeWidth})` 在**解码阶段**就降采样，
   * 24MB / 5120×2880 的壁纸不会真的按原尺寸进内存——比服务端硬解码还省。
   * 服务端只做三件事：认序号、挡体积、落盘。
   */
  const saveThumb = (seq, buf) => {
    const hit = bySeq(seq);
    if (!hit) return { ok: false, message: `没有 ${seq} 号` };
    if (!buf || !buf.length) return { ok: false, message: '空的' };
    /** 320px 宽、q0.8 的 JPEG 通常 10~40KB；给到 400KB 已经很宽松 */
    if (buf.length > 400 * 1024) return { ok: false, message: '缩略图太大（超过 400KB）' };
    try {
      mkdirSync(thumbDir, { recursive: true });
      writeFileSync(thumbPathOf(hit.sha), buf);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: String(e?.message || e) };
    }
  };

  /**
   * 存一张图进库。
   *
   * 来源三种：
   *   · `last` —— 最近一条**入站消息**里的图（`turn.js` 已落到 `<data>/images/`）
   *   · 本地路径 —— 主人或 AI 手上的文件
   *   · `o.buf` —— 调用方**已经把字节拿到手**了（网址下载走这条）。
   *
   * 网址为什么不在这一层下载：拉外链要先防 SSRF（`127.0.0.1`、`169.254.*`、
   * 内网段），那套判断放在 `remote-image.js` 里单独测。这一层保持**纯同步**，
   * 不碰网络——否则每个调用点都要变成 async，测试也得跟着变成异步。
   *
   * **幂等**：同一张图已在库里就返回原序号，不新建。模型会重复保存同一张图
   * （它不记得上次存过），不幂等的话库里很快堆满一模一样的副本。
   */
  const save = (o = {}, cfg = {}) => {
    const from = String(o.from ?? '').trim();
    const injected = Buffer.isBuffer(o.buf) ? o.buf : null;
    if (!from && !injected) {
      return { ok: false, message: '要说明图从哪来：from="last"、一个本地文件路径，或一个图片网址' };
    }
    if (!injected && /^https?:\/\//i.test(from)) {
      /**
       * 走到这里说明调用方没先下载就把它交进来了。明确报错而不是偷偷把网址
       * 当文件名——那样 `existsSync` 会失败，报「找不到这个文件」，用户会
       * 以为自己路径写错了。
       */
      return { ok: false, message: '网址要先下载：宿主那边负责取图，这一层只收字节' };
    }

    /** 本地源文件（`copyFileSync` 用）。走 `o.buf` 时为 null */
    let src = '';
    if (!injected) {
      if (from === 'last') {
        src = latestInboundImage();
        if (!src) return { ok: false, message: '最近没有收到图片（10 分钟内）' };
      } else {
        src = from;
        if (!existsSync(src)) return { ok: false, message: `找不到这个文件：${from}` };
      }
    }

    let buf = injected;
    if (!buf) {
      try {
        buf = readFileSync(src);
      } catch (e) {
        return { ok: false, message: `读不了这个文件：${e?.message ?? e}` };
      }
    }
    if (!buf.length) return { ok: false, message: '这个文件是空的' };
    const sha = createHash('sha256').update(buf).digest('hex');

    /** 已在库里（哪怕被扔进回收站）：把序号还给模型，顺便从回收站捞回来 */
    const exist = load().items[sha];
    if (exist) {
      if (exist.trash) { exist.trash = false; touch(); flush(); }
      return {
        ok: true,
        seq: exist.seq,
        dup: true,
        item: safeRow(exist),
        message: `这张图库里已经有了，是 #${exist.seq}`,
      };
    }

    /** 落到表情库第一个根目录，分类给了就进子目录 */
    const root = pickSaveRoot(cfg);
    /**
     * 扩展名的三个来源，优先级从高到低：
     *   · `o.ext` —— 网址那条路按**魔数**认出来的（最可信，URL 后缀经常是假的）；
     *   · 源文件后缀；
     *   · `.png` 兜底。
     */
    const ext = String(o.ext || '').toLowerCase() || (src ? extname(src).toLowerCase() : '') || '.png';
    /** 分类名会拼进路径，必须过 `safeCat`（见该函数注释：`clamp` 挡不住 `../`） */
    const cat = safeCat(o.cat);
    const stem = src ? basename(src, extname(src)) : '';
    /**
     * 落盘用的文件名，和记录上的 `name`（标注）**是两件事**。
     *
     * `o.fileName` 给的是「这张图在磁盘上叫什么」，比如从网址里取出来的
     * `cat-404.png`；`o.name` 是给模型看的短名。混用会让「自动取了个文件名」
     * 等于「已经标注过了」——`pending()` 只挑 name 和 meaning 都为空的图，
     * 拿文件名当 name 会让这些图再也不会被「让 AI 整理」碰到。
     */
    const base = safeFileName(o.name) || safeFileName(o.fileName) || safeFileName(stem) || `gallery_${Date.now().toString(36)}`;
    const target = uniquePath(join(cat ? join(root, cat) : root, `${base}${ext}`));

    try {
      mkdirSync(dirname(target), { recursive: true });
      /** 有源文件就复制（保留原样的字节与时间），没有就写调用方给的字节 */
      if (src) copyFileSync(src, target);
      else writeFileSync(target, buf);
    } catch (e) {
      return { ok: false, message: `复制失败：${e?.message ?? e}` };
    }

    const s = load();
    /**
     * 尺寸直接用手上这份字节算，**不回读刚落盘的文件**：字节是现成的，
     * 读一遍磁盘只是多一次 IO；而且刚写完的文件在 Windows 上偶尔还被占用。
     */
    const dims = dimsOf(buf);
    const rec = {
      seq: s.seq++,
      file: basename(target),
      cat,
      path: target,
      name: clamp(o.name, 20),
      meaning: clamp(o.meaning, 80),
      tags: (Array.isArray(o.tags) ? o.tags : String(o.tags ?? '').split(/[,，、\s]+/))
        .map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 6),
      scenes: clamp(o.scenes, 60),
      avoid: clamp(o.avoid, 40),
      enabled: true,
      /** 新图不固定：用户觉得常用再去面板（或让 AI）钉住 */
      pinned: o.pinned === true,
      bytes: buf.length,
      w: dims.w,
      h: dims.h,
      at: now(),
      usedAt: 0,
      hits: 0,
      /**
       * 来源标记（面板/排障用）：`inbound` 刚收到的、`upload` 本地文件、
       * `url` 从网址取的、`annotations` 只补了标注没进过库。
       * 调用方可以显式指定，方便区分「从哪儿来的」。
       */
      src: String(o.src || '') || (from === 'last' ? 'inbound' : 'upload'),
      trash: false,
      missing: false,
    };
    s.items[sha] = rec;
    hashCache.set(`${target}|${statSync(target).mtimeMs}|${buf.length}`, sha);
    touch();
    flush();
    /** 新文件刚进表情目录：不清缓存的话，这 3 秒内 `stickers.prompt` 里还没有它 */
    stickers?.invalidate?.();
    log(`图库新增 #${rec.seq}：${rec.file}（来源 ${rec.src}）`);
    return { ok: true, seq: rec.seq, item: safeRow(rec) };
  };

  /** 存图落在哪个根：配置了多个根时用第一个（那是用户最常丢图的目录） */
  const pickSaveRoot = (cfg = {}) => {
    try {
      const r = stickers?.dir?.(cfg);
      if (r) return r;
    } catch { /* 没有 stickers 就退回 dataDir 下 */ }
    return join(dataDir, 'stickers');
  };

  /**
   * 最近一张入站图。
   *
   * `turn.js` 的落盘文件名是 sha1 前 16 位，没有时间信息，只能靠 mtime 挑最新。
   * 10 分钟窗口：超过这个时间的「最新图」其实是上一次对话的，保存它几乎肯定
   * 不是用户此刻想要的——**明确失败**比悄悄存错图好。
   */
  const latestInboundImage = () => {
    const d = join(dataDir, 'images');
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return '';
    }
    let best = '';
    let bestAt = 0;
    const cutoff = now() - 10 * 60_000;
    for (const n of names) {
      if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(n)) continue;
      const p = join(d, n);
      try {
        const s = statSync(p);
        if (!s.isFile() || s.mtimeMs < cutoff) continue;
        if (s.mtimeMs > bestAt) { bestAt = s.mtimeMs; best = p; }
      } catch { /* 刚被删 / 占用，跳过 */ }
    }
    return best;
  };

  /** 面板/统计用的总览 */
  const stats = () => {
    const s = load();
    const all = Object.values(s.items);
    const live = all.filter((r) => !r.trash && !r.missing);
    return {
      total: live.length,
      trash: all.filter((r) => r.trash).length,
      missing: all.filter((r) => r.missing && !r.trash).length,
      untagged: live.filter((r) => !r.meaning && !r.name).length,
      /** 被 `gallery_edit` 设成 `enabled=0` 的：还在库里，但发不出去 */
      paused: live.filter((r) => r.enabled === false).length,
      /** 钉住的：配额满时自动清理不碰它们 */
      pinned: live.filter((r) => r.pinned === true).length,
      /** 已传到官方素材池（线上有副本）的张数 */
      online: live.filter((r) => r.remote && r.remote.imageId).length,
      /** 下一个可用号，面板显示「已发到 #12」让人心里有数 */
      nextSeq: s.seq,
      bytes: live.reduce((n, r) => n + (Number(r.bytes) || 0), 0),
    };
  };

  /**
   * 「让 AI 整理」要处理哪些图：**默认只给缺描述的**。
   *
   * 几百张全跑一遍就是几百次视觉调用，第二次点应该秒完成。所以这一步的产出
   * 是「待办清单」，不是「全部清单」。
   *
   * `all` 是「全部重做」：标签起错了、描述不准、模型换了，靠增量永远修不好
   * （它只挑 name 和 meaning 都为空的）。抄 aurabot 的 `captionTargets({all})`：
   * 全库重来，但仍然跳过回收站、丢了的文件、以及用户明确停用的。
   */
  const pending = ({ limit = 200, all = false, seqs = null } = {}) => {
    /**
     * `seqs` = 用户手选的那几张（面板「整理所选」）。
     *
     * 三者和 `all` 的差别：
     *   · 增量（默认）—— 只挑 name 和 meaning 都为空的；
     *   · `all`     —— 全库重来，但跳过停用的（那是「这钱我不该花」）；
     *   · `seqs`    —— **照单执行**，带名字带描述也重跑，停用的也跑。
     *
     * 为什么 `seqs` 反而最宽松：用户是一张张点出来的，点之前就知道自己选了哪张。
     * 这时候再拿「已有描述」或「已停用」去挡，表现就是「我明明选了它，它
     * 一动不动」——把选择权给了人又偷偷收回去，比不给更气人。
     *
     * 只留一条硬约束：`trash` / `missing` 不要。前者面板不给入口，后者根本没文件，
     * 跑起来必然失败。
     */
    const want = Array.isArray(seqs) && seqs.length
      ? new Set(seqs.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))
      : null;
    const s = load();
    return Object.entries(s.items)
      .filter(([, r]) => {
        if (r.trash || r.missing) return false;
        if (want) return want.has(Number(r.seq));
        /**
         * 停用的（`enabled === false`）不进待办。
         *
         * 「让 AI 整理」是**一张一次模型调用**，最贵的那条路。用户明确说了
         * 「这张暂时不用」，还花钱去给它写描述，写完了也没人看得见——
         * 等哪天真启用再说，那时它自然会重新出现在待办里。`all` 也一样：
         * 全部重做只扩大「哪些算缺描述」，不该顺手把停用的也翻出来烧钱。
         */
        if (r.enabled === false) return false;
        return all || (!r.meaning && !r.name);
      })
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, Math.max(1, Number(limit) || 200))
      .map(([sha, r]) => ({ sha, seq: r.seq, path: r.path, file: r.file }));
  };

  /**
   * 面板「图库」页要的完整行（含 path，**只给面板，不给模型**）。
   *
   * 两种口径必须分得开：
   *   · `trashOnly` —— **只看回收站**。面板的「回收站」分区用它，
   *     混进正常图片的话那个分区就只是图片区的一份复制，用户点过去会以为
   *     「回收站里什么都没有」（实际是显示错了内容），还会给没撤下的图
   *     画一个点了没反应的「恢复」。
   *   · `includeTrash` —— 图片**加上**回收站。排障、统计这类「全都看」的场合用。
   *
   * `missing`（文件已经不在了）两边都不出现：它既不是能发的图，也不是用户
   * 主动撤下的。清这种记录走 `forgetPaths` / `purge`，不该让用户以为还能恢复。
   */
  const rows = ({ includeTrash = false, trashOnly = false } = {}) => {
    const s = load();
    return Object.entries(s.items)
      .filter(([, r]) => {
        if (r.missing) return false;
        if (trashOnly) return r.trash === true;
        return includeTrash || r.trash !== true;
      })
      .sort((a, b) => a[1].seq - b[1].seq)
      .map(([sha, r]) => ({
        ...safeRow(r),
        /**
         * 库内相对位置。**只给显示和侧车用，别拿它取图。**
         *
         * 快照在有真 `未分类/` 目录时会把根目录图的 `rel` 改成 `未分类/xxx`，
         * 照它请求 `/stickers/file` 会 404。面板显示一律走 `/gallery/file?seq=N`。
         */
        rel: r.rel || (r.cat ? `${r.cat}/${r.file}` : r.file),
        /**
         * 面板缩略图缓存有没有这一张。
         *
         * 有就直接请求 `/gallery/thumb?seq=N`（几十 KB），没有才回退原图。
         * 24MB 的壁纸一次性铺满一屏会把面板拖死，这条字段是分流的依据。
         */
        thumb: hasThumb(sha),
        path: r.path,
        missing: r.missing === true,
        /**
         * 面板必须知道「这张被停了」。
         *
         * `pathOf()` 现在真的会挡住 `enabled === false`（AI 用 `gallery_edit`
         * 的 `enabled=0` 能设），但 `rows()` 原来不吐这个字段——面板上那张图
         * 和正常的没区别，用户会一直奇怪「为什么她从来不发这张」。
         * 不放进 `safeRow`：那是给模型的，清单里本来就过滤掉了停用的行。
         */
        enabled: r.enabled !== false,
        src: r.src,
        at: r.at,
        usedAt: r.usedAt,
      }));
  };

  return {
    dir, indexPath,
    sync, list, pathOf, markUsed, edit, remove, restore, save, stats, pending, rows,
    /** 文件被删之后清记录：`forgetPaths` 只忘记录，`purge` 连文件一起删 */
    forgetPaths, purge,
    /** 线上副本（官方素材池）的映射：查 / 记 / 清 / 反查序号 */
    remoteOf, markRemote, dropRemote, onlineIndex, onlineRows, isPinned,
    /** 缩略图缓存：查路径 / 存一张（面板生成后回传） */
    thumbPath, saveThumb, thumbDir,
    /** 面板按序号取原图（不用 `rel`，见 `filePath` 的注释） */
    filePath,
    /** 测试与面板用：把内存里的索引交出去（只读快照） */
    dump: () => JSON.parse(JSON.stringify(load())),
    /** 资源释放无关紧要（纯同步 IO），留个口子给测试重置 */
    reset: () => { st = null; seqMap = null; dirty = false; hashCache.clear(); },
  };
}

/** 文件名清理：去掉路径分隔符与控制字符，防 `../` 与保留名 */
function safeFileName(s) {
  const v = String(s ?? '').trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return [...v].slice(0, 40).join('');
}

/**
 * 分类名清理。**分类名会直接拼进路径**（`<根>/<分类>/<文件>`），所以它必须
 * 和文件名一样严。
 *
 * 原来这里用的是 `clamp`——只折叠空白、按字数截断，分隔符原样留着。于是
 * `cat: '../../evil'` 会变成 `join(root, '../../evil')`：`mkdirSync` 在图库
 * 外面建目录、`renameSync` 把图挪过去。模型手一抖（或提示词里出现「往上两级」
 * 这种话）就能把用户的图搬出库外，而且面板上看是「分类改成功了」。
 *
 * 返回空串 = 当「未分类」处理，不报错：分类写坏不该让整次编辑失败。
 */
function safeCat(s) {
  const v = String(s ?? '').trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!v) return '';
  /** Windows 上建不出来的保留名，当分类用只会得到「挪失败」 */
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v)) return '';
  return [...v].slice(0, 12).join('');
}

/** 同名就加 `_2`、`_3`…… 不问用户，也不覆盖已有文件 */
function uniquePath(p) {
  if (!existsSync(p)) return p;
  const ext = extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 2; i < 100; i += 1) {
    const next = `${base}_${i}${ext}`;
    if (!existsSync(next)) return next;
  }
  return `${base}_${Date.now().toString(36)}${ext}`;
}
