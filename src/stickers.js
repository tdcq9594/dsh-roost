/**
 * 表情包库。
 *
 * 思路：**不发明新机制**。发图就两种标记：正文里 `<<image: 路径>>`（图文同条），
 * 或 `<<image-alone: 路径>>`（单独发一条图），
 * 缺的只是「它不知道有哪些图可用、也不知道这些图是什么意思」。所以这个模块只做两件事——
 * 扫一遍目录，把**分类**写进提示词；模型要发时，由 `sticker_pick` 工具给真实路径。
 *
 * ## 两种形态，按目录结构自动切换
 *
 * ① **平铺**（所有图都在根目录）：逐图清单，文件名即标签。
 *    这是老用户已有的样子，也是「只有几张图」时最省事的方式。
 *
 * ② **分类**（一级子目录当分类）：只列分类名、张数和一句说明，具体文件由工具给。
 *    图一多，逐图清单会吃掉几千字提示词，而且加一张图就换掉整个系统提示词前缀
 *    （缓存全失效）。分类清单几十字，加图不影响前缀。
 *
 * ## 标签从哪来
 *
 * 优先级：侧车文件 > 文件名。
 *
 * 侧车文件就是同名 + `.tags`，一行写完：
 *
 *     开心, 猫; 有人装可爱时
 *     ↑标签     ↑场合（`;` 之后都算场合）
 *
 * 为什么要侧车：文件名是**已经存在的资产**，用户不该为了给机器看而重命名。
 * 而且中文文件名没有分隔符时根本拆不出词（`熊猫开心.png` 只能得到一个整串标签），
 * 靠猜永远猜不准，不如给一个「写一句就行」的口子。
 *
 * 文件名兜底仍保留：`开心_猫.png` → 开心、猫（老习惯继续能用）。
 *
 * ## 多个目录（`dir` 是数组时）
 *
 * 攒图的人通常已经有好几个目录（手机同步、下载、旧版备份），让他把图都搬到一起
 * 不现实。所以 `stickers.dir` 允许写成数组，多个目录**合并成一个库**：
 * 同名分类相加计数，「未分类」也相加。
 *
 * 为什么不按目录分开成「库A / 库B」让模型选：那是把用户的目录结构泄漏给模型，
 * 模型每轮都要先问「你从哪个盘找」，而且同一个「开心」在两个盘里会让它纠结。
 * 目录是用户的组织方式，不该变成模型的决策负担。
 */

import { readdirSync, statSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const OK_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 一次最多列几个（列太多会吃掉提示词预算） */
export const MAX_LIST = 40;

/**
 * 官方硬限：超过 200MB 的图，连分片上传也发不出去（见框架 `src/api.js` 的
 * `MEDIA_HARD_LIMIT`）。这种图**不进清单**——让它出现在候选里，只是让模型
 * 去挑一个必然报错的答案。
 */
export const MAX_BYTES = 200 * 1024 * 1024;

/**
 * 官方软限：超过它的图会被框架降级成「文件」发送（`MEDIA_SOFT_LIMIT`），
 * 群里看到的是一个附件、不是一个表情。仍然发得出去，所以**不拦**，
 * 只把这件事告诉模型（`pick()` 的 `degrade`）。
 */
export const SOFT_BYTES = 20 * 1024 * 1024;

/** 分类模式下每类最多列几个文件名当示例（模型不调工具时的兜底） */
const SAMPLES_PER_CAT = 3;

/**
 * 一次扫描最多认多少张图。
 *
 * 提示词每轮都要取一次清单（服务端 3 秒缓存），而扫描是**同步 IO**：
 * 实测 4000 个文件要 400ms，这 400ms 会把整个事件循环卡住——消息处理、
 * 面板接口全跟着排队。旧版只扫一层没这么明显，一旦有人把几千张壁纸
 * 丢进来就会踩到。
 *
 * 1000 是折中：正常表情库（几十到几百张）完全够，最坏 ~100ms。
 * 超出的部分不静默吞掉——清单里会写「还有更多」。
 */
export const MAX_SCAN = 1000;

/** 根目录那批图的「分类名」。用户不建子目录时，它们就是全部 */
export const UNCATEGORIZED = '未分类';

/** 分类目录里的说明文件。`_desc.txt` 记事本能直接编辑，`.desc` 是顺手兼容 */
const DESC_FILES = ['_desc.txt', '.desc'];

/** 侧车标签：与图片同名再加这个后缀 */
const SIDECAR = '.tags';

/**
 * 标签分隔符：把用户各种命名习惯都算上。
 *
 * 括号和序号必须处理——`联动壁纸 (1).png` 是从「复制粘贴」来的，
 * 以前 `(1)` 会被当成一个正经标签写进提示词，模型看到就是一张叫「(1)」的图。
 */
const TAG_SEP = /[_\-\s()（）·、,，.]+/;

/** 标签最多几个（再多对选题没帮助，只占字数） */
const MAX_TAGS = 4;

/**
 * 从文件名拆标签：`开心_猫-2.png` → ['开心', '猫']
 * 括号、顿号、逗号都当分隔符，纯数字（序号）丢掉。
 */
export function tagsOf(file) {
  const name = basename(file, extname(file));
  return name
    .split(TAG_SEP)
    .map((s) => s.trim())
    .filter((s) => s && !/^\d+$/.test(s))
    .slice(0, MAX_TAGS);
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch {
    return '';
  }
}

/**
 * 解析侧车文件：`标签, 标签; 场合` → `{ tags, usage }`
 *
 * 只写场合不写标签也行（以 `;` 开头），此时标签走文件名兜底。
 */
export function parseSidecar(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const cut = s.search(/[;；]/);
  const head = cut >= 0 ? s.slice(0, cut) : s;
  const usage = cut >= 0 ? s.slice(cut + 1).trim() : '';
  const tags = head
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, MAX_TAGS + 2);
  if (!tags.length && !usage) return null;
  return { tags, usage };
}

/** 一行描述：`开心/猫；有人装可爱时`。模型就是靠这一行判断该不该用 */
function describe(s) {
  const tags = (s.tags || []).join('/');
  if (tags && s.usage) return `${tags}；${s.usage}`;
  if (tags) return tags;
  if (s.usage) return s.usage;
  return '未标注';
}

/**
 * 扫一层或两层：根目录的图 + 一级子目录当分类。
 *
 * `limit` 是**本次调用**的硬上限（多根时由上层按比例分配），`state` 是跨根共享的
 * 计数器——扫描预算必须整体算，否则每个根各自扫满 1000 张，`MAX_SCAN` 就形同虚设。
 */
function scan(root, { maxBytes, limit = MAX_SCAN, state = { scanned: 0, truncated: false } } = {}) {
  const items = [];
  const cats = [];
  const skipped = [];
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    /** 目录不存在/没权限。交给上层报给面板——在这里静默成「0 张」，用户永远猜不到原因 */
    return { items, cats, skipped, missing: true };
  }

  const addFile = (dir, name, cat) => {
    /** 先看是不是图，再判上限——不然第 1001 个如果是 `_desc.txt`，会被误报成「还有更多图」 */
    if (!OK_EXT.has(extname(name).toLowerCase())) return false;
    /**
     * 到上限就停，但**继续数下去会置 `truncated`**——这样提示词能说
     * 「还有更多」，而不是让用户以为库就这么点。
     */
    if (state.scanned >= limit) {
      state.truncated = true;
      return false;
    }
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;
    if (maxBytes && st.size > maxBytes) {
      skipped.push(cat ? `${cat}/${name}` : name);
      return false;
    }
    /**
     * 侧车文件先判存在再读。
     *
     * 直接「读失败就 catch」也能跑，但那是**拿异常做控制流**：40 张图就是 40 次
     * 抛异常，几百张时每次扫盘都要付出这个代价。existsSync 一次系统调用更便宜。
     */
    const sidePath = p + SIDECAR;
    const side = existsSync(sidePath) ? parseSidecar(readText(sidePath)) : null;
    const fromName = tagsOf(name);
    items.push({
      file: name,
      path: p,
      rel: cat ? `${cat}/${name}` : name,
      cat,
      /** 这张图属于哪个根目录。多根时 `rel` 可能重名，靠它区分并回显路径 */
      root,
      tags: side?.tags?.length ? side.tags : fromName,
      usage: side?.usage || '',
      size: st.size,
      mtime: st.mtimeMs,
    });
    state.scanned++;
    return true;
  };

  for (const n of names) {
    const p = join(root, n);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile()) {
      addFile(root, n, '');
      continue;
    }
    /** 只认一级子目录当分类；隐藏目录和更深的层级都不参与，免得出现「分类套分类」 */
    if (!st.isDirectory() || n.startsWith('.')) continue;
    const desc = DESC_FILES.map((f) => readText(join(p, f))).find(Boolean) || '';
    let count = 0;
    try {
      for (const f of readdirSync(p)) if (addFile(p, f, n)) count++;
    } catch {
      /* 目录刚被删掉之类，跳过 */
    }
    if (count > 0) cats.push({ name: n, count, desc, dir: p });
  }

  /**
   * 子目录里有个真的叫「未分类」的：根目录那批散图**归它**。
   *
   * 不归的话会两头落空——提示词那边因为「已经有同名分类」而不单列根目录的图
   * （见 prompt 里的例外），而分类清单只数目录里的文件，结果是根目录那些图
   * 在清单里**彻底消失**：模型挑不到，用户也看不出少了什么。
   *
   * 语义上也该合并：用户建 `未分类/` 的意图本来就是「这些是还没分好的」，
   * 根目录的散图正是同一批东西。归进去之后 `pick('未分类')` 也能一起挑到。
   */
  const uncat = cats.find((c) => c.name === UNCATEGORIZED);
  if (uncat) {
    for (const it of items) {
      if (it.cat) continue;
      it.cat = UNCATEGORIZED;
      it.rel = `${UNCATEGORIZED}/${it.file}`;
      uncat.count += 1;
    }
  }

  /** 自然序：`1.png, 2.png, 10.png`。以前用裸 localeCompare 会排成 1、10、2 */
  const cmp = (a, b) => a.localeCompare(b, 'zh', { numeric: true });
  items.sort((a, b) => cmp(a.rel, b.rel));
  cats.sort((a, b) => cmp(a.name, b.name));
  return { items, cats, skipped, missing: false };
}

/**
 * @param {object} o
 * @param {string} o.dataDir 数据根目录（表情包默认在它下面的 stickers/）
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.cacheMs] 扫描结果缓存时长。提示词每一轮都会取一次，
 *        而扫盘 + 读侧车不该每轮都做。默认 3 秒：用户改完文件几乎立刻生效，
 *        又足够挡住一轮对话里的多次调用。测试传 0 关掉。
 * @param {() => number} [o.now] 注入时钟，测试用
 */
export function createStickers({ dataDir, log = () => {}, cacheMs = 3000, maxScan = MAX_SCAN, now = Date.now } = {}) {
  /** 这张图最近被给出去过的时间：同图不连发靠它，只在内存里，重启就清空 */
  const used = new Map();
  let cache = null;
  /** 上次报过「有图被跳过」的那批文件名。提示词每轮都会扫，同一批不该反复刷日志 */
  let lastSkipped = '';

  /** 默认目录：没配 `dir` 时用它，也是**唯一**会自动创建的目录 */
  const defaultDir = join(dataDir, 'stickers');

  /** 默认目录首次被用到时建出来（用户往里丢图就行） */
  const ensureDefault = () => {
    try {
      if (!existsSync(defaultDir)) mkdirSync(defaultDir, { recursive: true });
    } catch (e) {
      log(`表情包目录建不出来：${e.message}`);
    }
  };

  /**
   * 配置里的 `dir` → 干净的绝对路径数组。
   *
   * 接受字符串或数组，去空串、去重（Windows 不区分大小写，按小写比）。
   * 空配置回落到默认目录——**只有它会自动创建**：用户手填的路径应当已经存在，
   * 替他建目录等于在他盘上凭空造东西，填错盘符（`D:\png`）时尤其糟。
   */
  const rootsOf = (cfg = {}) => {
    const raw = cfg?.dir;
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const foldCase = process.platform === 'win32';
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      const s = String(x ?? '').trim();
      if (!s) continue;
      const k = foldCase ? s.toLowerCase() : s;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    if (!out.length) {
      ensureDefault();
      out.push(defaultDir);
    }
    return out;
  };

  /** 所有根目录。`dir()` 只给首个——老调用方只关心「往哪丢图」 */
  const dirs = (cfg) => rootsOf(cfg);
  const dir = (cfg) => rootsOf(cfg)[0];

  const snapshot = (cfg = {}) => {
    const roots = rootsOf(cfg);
    const maxBytes = Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : MAX_BYTES;
    const key = `${roots.join('|')}|${maxBytes}|${maxScan}`;
    if (cacheMs > 0 && cache && cache.key === key && now() - cache.at < cacheMs) {
      return cache.value;
    }

    /**
     * 预算按根均分（`剩余预算 / 剩余根数`，至少 1）。
     *
     * 不能给每个根都发满 `MAX_SCAN`：4000 张的目录排在第一位时，后面的目录一张
     * 都扫不到，面板写着「共 1000 张」而他刚加的那个目录是 0 张——没法解释。
     * 均分保证每个目录都能露头；前一个没用满时，后面的份额自动变大。
     */
    const state = { scanned: 0, truncated: false };
    const items = [];
    const skipped = [];
    const missing = [];
    /** 同名分类跨根合并：两个盘都放了 `开心/`，模型只该看到一个「开心」 */
    const catMap = new Map();

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const share = Math.max(1, Math.ceil((maxScan - state.scanned) / (roots.length - i)));
      const r = scan(root, { maxBytes, limit: state.scanned + share, state });
      if (r.missing) {
        missing.push(root);
        continue;
      }
      items.push(...r.items);
      skipped.push(...r.skipped);
      for (const c of r.cats) {
        const prev = catMap.get(c.name);
        if (prev) {
          prev.count += c.count;
          prev.dirs.push(c.dir);
          /** 说明取先到的非空那份：两处都有 `_desc.txt` 时，以先配的目录为准 */
          if (!prev.desc && c.desc) prev.desc = c.desc;
        } else {
          catMap.set(c.name, { ...c, dirs: [c.dir] });
        }
      }
    }

    /**
     * 合并后要整体重排：每个根内部已排过，但拼起来是「根A全部 + 根B全部」。
     * 第二键用 root，让同名 rel 的两张按目录稳定排列（不然顺序看遍历运气）。
     */
    const cmp = (a, b) => a.localeCompare(b, 'zh', { numeric: true });
    items.sort((a, b) => cmp(a.rel, b.rel) || cmp(a.root, b.root));

    const value = {
      /** 首个根目录。老代码（和只认单目录的调用方）还在读这个字段 */
      root: roots[0],
      roots,
      items,
      cats: [...catMap.values()].sort((a, b) => cmp(a.name, b.name)),
      skipped,
      missing,
      truncated: state.truncated,
    };

    /**
     * 「有图被跳过」只在**这批文件名变了**的时候报一次。
     *
     * 提示词每轮都会取一次快照，缓存过期就要重扫；如果把日志写在扫描里，
     * 一张 300MB 的图会让这条 warn 每 3 秒刷一次，真正有用的日志全被冲掉。
     */
    const sig = value.skipped.join('|');
    if (sig && sig !== lastSkipped) {
      lastSkipped = sig;
      log(`表情包跳过了 ${value.skipped.length} 张超过 ${Math.round(maxBytes / 1024 / 1024)}MB 的图：`
        + value.skipped.slice(0, 3).join('、'));
    } else if (!sig) {
      lastSkipped = '';
    }

    cache = { key, at: now(), value };
    return value;
  };

  /** 扫一遍，返回 [{file, path, rel, cat, tags, usage, size, mtime}] */
  const list = (cfg = {}, { max = MAX_LIST } = {}) => snapshot(cfg).items.slice(0, max);

  /** 分类清单：[{name, count, desc, dir}]。空分类不出现 */
  const categories = (cfg = {}) => snapshot(cfg).cats;

  /**
   * 拼给模型看的一段清单。
   *
   * **平铺**时逐图列（图少，这是最有效的）；
   * **有分类**时只列分类，具体文件交给 `sticker_pick`——路径不进提示词，
   * 加图也不会换掉系统提示词前缀（缓存不失效）。
   */
  const prompt = (cfg = {}) => {
    if (cfg.enabled === false) return '';
    const { root, roots, items, cats, truncated } = snapshot(cfg);
    if (!items.length) return '';

    /**
     * 多目录时的抬头：**逐个列出**，不能只写第一个。
     * 少了哪一行，模型就会以为图都在第一个目录里，拼出来的路径直接找不到文件。
     */
    const multi = roots.length > 1;
    const rootLines = multi ? roots.map((r) => `- ${r}`).join('\n') : '';

    if (cats.length) {
      /**
       * 分类模式。
       *
       * 每类除了名字和张数，还列**最多 3 个文件名**。为什么留着文件名：
       * 工具挂不上（DSH 版本差异）或者模型就是不肯调工具时，它是唯一还能
       * 让模型拼出 `<<image: 路径>>` 的线索。没有这个兜底，分类模式在
       * 工具失效时会变成「一张图都发不出去」——比不分类更糟。
       *
       * 根目录那批图也要列成「未分类」：用户建了 `开心/` 之后，
       * 原来平铺的图不会自动搬进去，不列就等于**凭空消失**。
       */
      const samples = (cat) => items.filter((s) => s.cat === cat).slice(0, SAMPLES_PER_CAT)
        .map((s) => s.file).join('、');
      const rootList = items.filter((s) => !s.cat);
      const lines = cats.map((c) => {
        const head = `- ${c.name}（${c.count} 张）${c.desc ? '：' + c.desc : ''}`;
        const ex = samples(c.name);
        return ex ? `${head}；例：${ex}` : head;
      });
      /**
       * 根目录那批图单列一行「未分类」。
       *
       * 例外：用户真的建了一个叫「未分类」的目录时不再单列——否则清单里会出现
       * 两行同名的「未分类」，模型没法判断该往哪边找。
       */
      if (rootList.length && !cats.some((c) => c.name === UNCATEGORIZED)) {
        const ex = rootList.slice(0, SAMPLES_PER_CAT).map((s) => s.file).join('、');
        lines.push(`- ${UNCATEGORIZED}（${rootList.length} 张）${ex ? '；例：' + ex : ''}`);
      }
      return [
        multi
          ? `【表情包】${roots.length} 个目录合并成一个库：\n${rootLines}\n按分类存放：`
          : `【表情包】根目录 ${root}，按分类存放：`,
        ...lines,
        truncated ? `（图太多，这次只扫了前 ${items.length} 张，各分类的数目可能偏小）` : '',
        '要发图时先调 sticker_pick(category) 拿具体文件路径。两种发法按场景选：',
        '· 单独发一条图（常见于表情包）：写 <<image-alone: 该路径>>，文字照常写在自己的回复里。',
        '· 图和文字在同一条消息里：把 <<image: 该路径>> 写在正文对应位置，图片就显示在那一句。',
        '不要写模式后缀，框架会自己判断怎么发。',
        '图片不要放进 qq_send 的参数——那条通道只发文字，图片语法会原样变成文本。',
        '没有合适的分类就别发——不要为了配图硬凑。',
      ].filter(Boolean).join('\n');
    }

    const shown = items.slice(0, MAX_LIST);
    const more = items.length - shown.length;
    return [
      multi
        ? `【表情包】${roots.length} 个目录合并成一个库（共 ${items.length} 张）：\n${rootLines}`
        : `【表情包】目录 ${root}（${items.length} 张）`,
      ...shown.map((s) => `- ${s.file}（${describe(s)}）`),
      more > 0 ? `…还有 ${more} 张没列出来（按文件名排序取前 ${MAX_LIST} 张）` : '',
      truncated ? `（图太多，这次只扫了前 ${items.length} 张；没扫到的不会出现在清单里）` : '',
      '要发表情时两种写法按场景选，路径是完整路径：',
      /** 用 item 自己的 path，不拼 root——多目录时 `join(第一个根, 文件名)` 会指到不存在的文件 */
      `单独发一条图：<<image-alone: ${shown[0].path}>>`,
      `图和文字同一条：<<image: ${shown[0].path}>>`,
      '后者写在哪句就显示在哪儿；前后都有文字时会夹在同一条消息中间。',
      '不要放进 qq_send 的参数——那条通道只发文字。',
      '没有合适的就别发。',
    ].filter(Boolean).join('\n');
  };

  /**
   * 挑几张图给模型。`sticker_pick` 工具的实现体。
   *
   * 顺序按「最久没被给过」优先，所以同一张图不会连着出现两次——
   * 不这样做的话模型连着两轮问「开心的」，拿到的永远是同一张。
   *
   * @param {object} cfg
   * @param {{category?:string, limit?:number}} [o]
   * @returns {{ok:boolean, category?:string, items?:Array, categories?:string[], message?:string}}
   */
  const pick = (cfg = {}, { category = '', limit = 1 } = {}) => {
    const { items, cats } = snapshot(cfg);
    const want = String(category ?? '').trim();
    const rootItems = items.filter((s) => !s.cat);
    /** 「未分类」在目录里没有对应文件夹，但对模型是个正经分类名，要能选 */
    const names = [...cats.map((c) => c.name), ...(rootItems.length ? [UNCATEGORIZED] : [])];

    let pool = items;
    let catName = '';

    if (want) {
      /**
       * 顺序：精确分类 → 「未分类」→ 包含匹配。
       *
       * 「未分类」排在模糊匹配之前，是因为模糊那条用了 `want.includes(c.name)`：
       * 用户如果建了个叫「分类」的目录，`want='未分类'` 会先被它吃掉。
       */
      const exact = cats.find((c) => c.name === want);
      if (exact) {
        catName = exact.name;
        pool = items.filter((s) => s.cat === exact.name);
      } else if (want === UNCATEGORIZED && rootItems.length) {
        catName = UNCATEGORIZED;
        pool = rootItems;
      } else {
        /** 模型偶尔会把分类名写长（「开心的表情」），包含匹配兜住 */
        const fuzzy = cats.find((c) => c.name.includes(want) || want.includes(c.name));
        if (!fuzzy) {
          const all = names.length ? names.join('、') : '（还没有分类，图都放在根目录）';
          return { ok: false, message: `没有「${want}」这个分类。现有分类：${all}`, categories: names };
        }
        catName = fuzzy.name;
        pool = items.filter((s) => s.cat === fuzzy.name);
      }
    } else if (cats.length) {
      /** 没指定分类、但库里有分类：不要静默退回「全库随机」，让模型自己点名 */
      return {
        ok: false,
        message: `这个库按分类存放，要先选一个分类：${names.join('、')}`,
        categories: names,
      };
    }

    if (!pool.length) return { ok: false, message: '这一类里没有能用的图', categories: names };

    const n = Math.max(1, Math.min(Number(limit) || 1, 3));
    const t = now();
    const picked = pool
      /**
       * 排序：**能正常发的排前面**，再按「最久没给过」。
       *
       * 超过软限的图仍留在库里（用户可能就是想发那张），但只有在没有更合适的
       * 时候才给出去——否则模型第一眼就拿到一张「发出去会变成文件」的图，
       * 要么发个附件、要么反复纠结。
       */
      /**
       * 「刚给过」的键是**绝对路径**，不是 `rel`。
       * 多个目录里都有 `开心/1.png` 时，用 `rel` 会把两张完全不同的图当成同一张，
       * 于是「避开上一张」失效，群里连发两张看起来一样的图。
       */
      .map((s) => ({ s, last: used.get(s.path) || 0, heavy: s.size > SOFT_BYTES ? 1 : 0 }))
      .sort((a, b) => a.heavy - b.heavy || a.last - b.last)
      .slice(0, n)
      .map((x) => x.s);

    for (const s of picked) used.set(s.path, t);

    return {
      ok: true,
      category: catName || UNCATEGORIZED,
      items: picked.map((s) => ({
        path: s.path,
        file: s.file,
        tags: s.tags,
        usage: s.usage,
        /** 提醒模型：超过软限的图会被发成文件，不是表情气泡 */
        degrade: s.size > SOFT_BYTES,
      })),
    };
  };

  /**
   * 把 `表情:标签` / 文件名解析成本地路径。
   *
   * 匹配分级：**标签全等 > 前缀 > 子串**。以前只有子串匹配，
   * 查「心」会同时命中「开心」「伤心」，命中几个都一样算一分，选谁全看遍历顺序。
   */
  const resolve = (cfg = {}, want) => {
    const q = String(want ?? '').trim();
    if (!q) return null;
    const { items } = snapshot(cfg);

    const byName = items.find((s) => s.file === q || s.file === `${q}.png` || s.file === `${q}.gif`);
    if (byName) return byName.path;

    const m = q.match(/^表情[:：]\s*(.+)$/);
    if (!m) return null;
    const keys = m[1].split(/[\s,，/]+/).filter(Boolean);
    if (!keys.length) return null;

    let best = null;
    let bestScore = 0;
    for (const s of items) {
      let score = 0;
      for (const k of keys) {
        if (s.tags.some((t) => t === k)) score += 3;
        else if (s.tags.some((t) => t.startsWith(k))) score += 2;
        else if (s.tags.some((t) => t.includes(k))) score += 1;
      }
      if (score > bestScore) {
        best = s;
        bestScore = score;
      }
    }
    return best ? best.path : null;
  };

  return { dir, dirs, list, categories, prompt, pick, resolve, snapshot, tagsOf };
}
