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
 * 处置：**index 是唯一真相，侧车只在两个方向同步一次**——
 *   · 入库时读侧车当初始值（用户手写的场合说明不能丢）；
 *   · AI/面板改了标注，回写侧车（`stickers.js` 每轮从侧车生成清单，
 *     不写回去它就会拿着旧标签去猜）。
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
 */
export const GALLERY_HINT = [
  '【图库】你的图有一个带序号的图库，每张图都有编号、名字和「什么场合用」。',
  '想看有哪些图：调 gallery_list（可以指定分类，也可以只看没见过的）。',
  '不确定某张图到底画了什么、或者想问它某个细节：调 gallery_show 看一眼——它是真的看图，不是靠文件名猜。',
  '发图时只写序号：`<<image: #3>>`（图和文字同一条）或 `<<image-alone: #3>>`（单独一条）。',
  '**发图时**不要写文件路径，也不要写网址——宿主会把序号换成图。序号写错这张就不发，'
    + '不会把奇怪的字符串发进群里。',
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
  trash: rec.trash === true,
});

/**
 * 一行清单：`#3  开心_001.png  熊猫大笑 · 笑得很夸张 · 夸人、接玩笑`
 *
 * 三段各有分工：序号是模型要抄的，文件名是它向人提及时用的，描述是它
 * 判断该不该发的依据。缺哪段就跳过哪段，不留空占位（`· ·` 很干扰阅读）。
 */
export function lineOf(rec) {
  const bits = [];
  if (rec.name) bits.push(rec.name);
  if (rec.meaning) bits.push(rec.meaning);
  const rest = [rec.scenes, Array.isArray(rec.tags) ? rec.tags.join('/') : ''].filter(Boolean);
  if (rest.length) bits.push(rest.join(' · '));
  return `#${rec.seq}  ${rec.file}${bits.length ? `  ${bits.join(' · ')}` : '  未标注'}`;
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
        s.items[sha] = {
          seq: s.seq++,
          file: it.file,
          cat: it.cat || '',
          path: it.path,
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

      /** 同一张图换了位置 / 文件名 / 分类：跟着更新，**序号不动** */
      let changed = false;
      if (prev.path !== it.path) { prev.path = it.path; changed = true; }
      if (prev.file !== it.file) { prev.file = it.file; changed = true; }
      if ((prev.cat || '') !== (it.cat || '')) { prev.cat = it.cat || ''; changed = true; }
      if (prev.bytes !== it.size) { prev.bytes = it.size; changed = true; }
      if (prev.missing) { prev.missing = false; changed = true; }

      /**
       * 侧车只在**图库这边还是空**的时候采。一旦 AI 或用户改过，就以后者为准
       * ——否则下次扫盘会把 AI 刚写的描述用侧车的旧值覆盖回去，表现为
       * 「改了没生效」。
       */
      if (!prev.scenes && it.usage) { prev.scenes = it.usage; changed = true; }
      if ((!prev.tags || !prev.tags.length) && Array.isArray(it.tags) && it.tags.length) {
        prev.tags = it.tags.slice(0, 6);
        changed = true;
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

    if (patch.name !== undefined) set('name', str(patch.name, 20));
    if (patch.meaning !== undefined) set('meaning', str(patch.meaning, 80));
    if (patch.scenes !== undefined) set('scenes', str(patch.scenes, 60));
    if (patch.avoid !== undefined) set('avoid', str(patch.avoid, 40));
    if (patch.cat !== undefined) {
      const want = str(patch.cat, 12);
      /** 分类没变就别动文件：`edit({cat: 原值})` 不该产生一次磁盘搬移 */
      if (want !== (rec.cat || '')) {
        const moved = moveToCat(rec, want);
        if (!moved.ok) return { ok: false, message: moved.message };
        touched.push('cat');
      }
    }
    if (patch.enabled !== undefined) set('enabled', patch.enabled !== false);
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
    const cat = clamp(o.cat, 12);
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
      bytes: buf.length,
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
      /** 下一个可用号，面板显示「已发到 #12」让人心里有数 */
      nextSeq: s.seq,
      bytes: live.reduce((n, r) => n + (Number(r.bytes) || 0), 0),
    };
  };

  /**
   * 「让 AI 整理」要处理哪些图：**只给缺描述的**。
   *
   * 几百张全跑一遍就是几百次视觉调用，第二次点应该秒完成。所以这一步的产出
   * 是「待办清单」，不是「全部清单」。
   */
  const pending = ({ limit = 40 } = {}) => {
    const s = load();
    return Object.entries(s.items)
      .filter(([, r]) => !r.trash && !r.missing && !r.meaning && !r.name)
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, Math.max(1, Number(limit) || 40))
      .map(([sha, r]) => ({ sha, seq: r.seq, path: r.path, file: r.file }));
  };

  /** 面板「图库」页要的完整行（含 path，**只给面板，不给模型**） */
  const rows = ({ includeTrash = false } = {}) => {
    const s = load();
    return Object.values(s.items)
      .filter((r) => includeTrash || (!r.trash && !r.missing))
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({
        ...safeRow(r),
        /**
         * `rel` 是 `/stickers/file` 认的形状（`分类/文件名`）。面板画缩略图要用它：
         * 那个接口按相对位置在库里定位并做越界校验，不认绝对路径。
         */
        rel: r.cat ? `${r.cat}/${r.file}` : r.file,
        path: r.path,
        missing: r.missing === true,
        src: r.src,
        at: r.at,
        usedAt: r.usedAt,
      }));
  };

  return {
    dir, indexPath,
    sync, list, pathOf, markUsed, edit, remove, restore, save, stats, pending, rows,
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
