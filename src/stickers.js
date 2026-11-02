/**
 * 表情包库。
 *
 * 思路：**不发明新机制**。我们已经能让模型发图（`<<image: 路径>>`），
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

/** 扫一层或两层：根目录的图 + 一级子目录当分类 */
function scan(root, { maxBytes, maxScan = MAX_SCAN } = {}) {
  const items = [];
  const cats = [];
  const skipped = [];
  let truncated = false;
  let scanned = 0;
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return { items, cats, skipped, truncated };
  }

  const addFile = (dir, name, cat) => {
    /** 先看是不是图，再判上限——不然第 1001 个如果是 `_desc.txt`，会被误报成「还有更多图」 */
    if (!OK_EXT.has(extname(name).toLowerCase())) return false;
    /**
     * 到上限就停，但**继续数下去会置 `truncated`**——这样提示词能说
     * 「还有更多」，而不是让用户以为库就这么点。
     */
    if (scanned >= maxScan) {
      truncated = true;
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
      skipped.push(name);
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
      tags: side?.tags?.length ? side.tags : fromName,
      usage: side?.usage || '',
      size: st.size,
      mtime: st.mtimeMs,
    });
    scanned++;
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

  /** 自然序：`1.png, 2.png, 10.png`。以前用裸 localeCompare 会排成 1、10、2 */
  const cmp = (a, b) => a.localeCompare(b, 'zh', { numeric: true });
  items.sort((a, b) => cmp(a.rel, b.rel));
  cats.sort((a, b) => cmp(a.name, b.name));
  return { items, cats, skipped, truncated };
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

  const dirOf = (cfg = {}) => cfg.dir || join(dataDir, 'stickers');

  /** 目录（首次会建出来，用户往里丢图就行） */
  const dir = (cfg) => {
    const d = dirOf(cfg);
    try {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    } catch (e) {
      log(`表情包目录建不出来：${e.message}`);
    }
    return d;
  };

  const snapshot = (cfg = {}) => {
    const root = dir(cfg);
    const maxBytes = Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : MAX_BYTES;
    const key = `${root}|${maxBytes}|${maxScan}`;
    if (cacheMs > 0 && cache && cache.key === key && now() - cache.at < cacheMs) {
      return cache.value;
    }
    const value = { root, ...scan(root, { maxBytes, maxScan }) };

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
    const { root, items, cats, truncated } = snapshot(cfg);
    if (!items.length) return '';

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
        `【表情包】根目录 ${root}，按分类存放：`,
        ...lines,
        truncated ? `（图太多，这次只扫了前 ${items.length} 张，各分类的数目可能偏小）` : '',
        '要发图时先调 sticker_pick(category) 拿具体文件路径，再输出 <<image: 该路径>>。',
        '图片标记写在**回复正文**里发——放进 qq_send 的参数不会发图。',
        '没有合适的分类就别发——不要为了配图硬凑。',
      ].filter(Boolean).join('\n');
    }

    const shown = items.slice(0, MAX_LIST);
    const more = items.length - shown.length;
    return [
      `【表情包】目录 ${root}（${items.length} 张）`,
      ...shown.map((s) => `- ${s.file}（${describe(s)}）`),
      more > 0 ? `…还有 ${more} 张没列出来（按文件名排序取前 ${MAX_LIST} 张）` : '',
      truncated ? `（图太多，这次只扫了前 ${items.length} 张；没扫到的不会出现在清单里）` : '',
      '要发表情时用 <<image: <上面的目录>\\文件名>>，例如：',
      `<<image: ${join(root, shown[0].file)}>>`,
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
      .map((s) => ({ s, last: used.get(s.rel) || 0, heavy: s.size > SOFT_BYTES ? 1 : 0 }))
      .sort((a, b) => a.heavy - b.heavy || a.last - b.last)
      .slice(0, n)
      .map((x) => x.s);

    for (const s of picked) used.set(s.rel, t);

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

  return { dir, list, categories, prompt, pick, resolve, snapshot, tagsOf };
}
