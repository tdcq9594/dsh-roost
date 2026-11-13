/**
 * 5.12 表情库管理：分页、补标签、批量删除、后台任务进度。
 * ====================================================
 *
 * `stickers.js` 只负责「让模型知道有哪些图」（扫目录 → 提示词 → 挑图），
 * 这一层负责**人对库的操作**。分开的理由很实在：前者每轮对话都在跑，
 * 必须快、只读、有缓存；后者是低频手动动作，要写盘、要报进度、要能取消。
 * 混在一起会让「面板点一下补标签」和「每轮注入提示词」互相拖累。
 *
 * 四条安全线：
 *
 *   1. **只认库内的文件。** 删图和写标签都先 `basename()` 再去重拼路径，
 *      最后确认结果还在 `dirs` 之下。`../../memory.json` 这种名字一律无效。
 *   2. **补标签只补不改。** 已有侧车里的标签原样保留，只追加缺的；用户手写的
 *      说明（`;` 之后那段）一个字都不动——那是人写给模型看的场合说明。
 *   3. **删除是真删。** 没有回收站可退，所以接口要求显式列表 + `confirm`，
 *      并且**一次最多 50 张**（一次删几百张多半是误触）。
 *   4. **任务在内存里。** 进度不落盘：DSH 重启后任务没了，重新点一次就行。
 *      落盘反而会留下「上次那个任务到底跑完没有」的悬案。
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, basename, extname, resolve as resolvePath, sep } from 'node:path';

/** 侧车文件后缀，与 `stickers.js` 的 SIDECAR 一致 */
export const SIDECAR = '.tags';
/** 一张图最多几个标签：再多对选题没帮助，只占提示词 */
export const MAX_TAGS = 6;
/** 一次批删的上限：再多多半是误触，让人分批来 */
export const MAX_DELETE = 50;
/** 分页默认每页多少张 */
export const PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 120;

/** 分类模式下「未分类」的名字，与 stickers.js 对齐 */
const UNCATEGORIZED = '未分类';

/**
 * 标签分隔符。和 `stickers.js` 的 `TAG_SEP` 保持一致的语义，
 * 但不 import 它：那边是给「文件名 → 标签」用的，这边要处理侧车里
 * 用逗号/顿号写的串，规则更宽一点。
 */
const TAG_SPLIT = /[,，、;；\s]+/;

/** 纯数字 / 单字符 / 序号（`(1)`、`2`）不是标签 */
const isNoise = (s) => !s || /^\d+$/.test(s) || /^[（(]\d+[)）]$/.test(s) || [...s].length > 12;

/**
 * 分类字段兼容：`stickers.js` 的 items 用 `cat`，这里内部统一叫 `category`。
 * 两个都认，避免调用方为了分页再映射一遍（映射漏字段就是另一种 bug）。
 */
const catOf = (it) => String(it?.category ?? it?.cat ?? UNCATEGORIZED);

/**
 * 把文件路径解析成「库内的相对位置」，越界返回 null。
 *
 * 这是所有写操作的入口守卫：`file` 来自前端，可能是 `../../x`、
 * 也可能是绝对路径。先 `basename` 砍掉目录部分，再拼到每个 root 上试，
 * 只有真实存在且**解析后仍在 root 下**的才算数。
 *
 * @param {string[]} dirs 表情库的根目录
 * @param {string} file 前端给的文件名（可以带子目录，如 `开心/a.png`）
 * @returns {{root:string, rel:string, abs:string, category:string, name:string}|null}
 */
export function locate(dirs, file) {
  const raw = String(file ?? '').replace(/\\/g, '/').trim();
  if (!raw || raw.includes('\0')) return null;

  /** 只允许「分类/文件名」这一层结构，更深的子目录不支持（扫也只扫一层） */
  const parts = raw.split('/').filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0 || parts.length > 2) return null;
  const name = basename(parts[parts.length - 1]);
  if (!name || name !== parts[parts.length - 1]) return null;

  /**
   * 有没有**真实的分类子目录**：看路径有几段，**绝不能看分类名叫什么**。
   *
   * 2026-11-14 真机 bug：「同步缓存图」会在库里建一个真名叫 `未分类` 的子目录，
   * 而 `未分类` 同时是「根目录的图」的显示名。以前这里写
   * `category === UNCATEGORIZED ? '' : category`，于是 `未分类/缓存.jpg`
   * 被拼成 `<root>/缓存.jpg` —— 文件明明在，`existsSync` 却为假，
   * 表现为「列表里看得见、缩略图是破图、删也删不掉」。
   * 显示名和目录名是两件事，别拿一个去判另一个。
   */
  const hasCat = parts.length === 2;
  const category = hasCat ? parts[0] : UNCATEGORIZED;
  for (const root of Array.isArray(dirs) ? dirs : []) {
    const r = resolvePath(String(root || ''));
    const abs = resolvePath(join(r, hasCat ? parts[0] : '', name));
    /** 关键：`startsWith(r + sep)` 而不是 `startsWith(r)`——后者会把 `/a/bc` 认成在 `/a/b` 下 */
    if (!abs.startsWith(r.endsWith(sep) ? r : r + sep)) continue;
    if (!existsSync(abs)) continue;
    return { root: r, rel: hasCat ? `${parts[0]}/${name}` : name, abs, category, name };
  }
  return null;
}

/** 读侧车：返回 `{tags, note}`。`note` 是 `;` 之后那段场合说明 */
export function readSidecar(abs) {
  const f = `${abs}${SIDECAR}`;
  if (!existsSync(f)) return { tags: [], note: '' };
  try {
    const text = readFileSync(f, 'utf8').trim();
    const i = text.search(/[;；]/);
    const head = i >= 0 ? text.slice(0, i) : text;
    const note = i >= 0 ? text.slice(i + 1).trim() : '';
    return {
      tags: head.split(TAG_SPLIT).map((s) => s.trim()).filter((s) => !isNoise(s)),
      note,
    };
  } catch {
    /** 读坏当没有：补标签不该因为一个坏侧车就整个任务失败 */
    return { tags: [], note: '' };
  }
}

/** 写侧车：`标签1, 标签2; 场合说明`。空标签 + 空说明就删掉文件 */
export function writeSidecar(abs, tags, note = '') {
  const f = `${abs}${SIDECAR}`;
  const clean = [...new Set((Array.isArray(tags) ? tags : []).map((s) => String(s).trim()).filter((s) => !isNoise(s)))].slice(0, MAX_TAGS);
  const n = String(note ?? '').trim();
  if (!clean.length && !n) {
    if (existsSync(f)) unlinkSync(f);
    return { ok: true, tags: [], note: '' };
  }
  writeFileSync(f, `${clean.join(', ')}${n ? `; ${n}` : ''}\n`, 'utf8');
  return { ok: true, tags: clean, note: n };
}

/**
 * 规则补标签：**不调模型**。
 *
 * 名字叫「补」不叫「AI 生成」：真正有价值的那部分信息（这张图属于哪个分类、
 * 文件名里有什么词）本来就是确定的，用规则算比问模型更准、更快、还免费。
 * 模型能补的只有「图里画了什么」，那需要视觉能力，而且一张一张跑几十次
 * 调用既慢又贵——真要做也该是用户显式点「用模型看一遍」的独立动作，
 * 不是默认路径。
 *
 * 补的来源，按可信度排：
 *   1. 分类名（`开心/熊猫.png` 的「开心」）——人分过类，最可信；
 *   2. 文件名拆出来的词；
 *   3. 已有的侧车标签（保留，不重复加）。
 */
export function suggestTags({ file = '', category = '', existing = [] } = {}) {
  const fromName = basename(String(file), extname(String(file)))
    .split(/[_\-—\s()（）·、,，.]+/)
    .map((s) => s.trim());
  const cat = String(category || '').trim();
  const base = (Array.isArray(existing) ? existing : []).map((s) => String(s).trim()).filter(Boolean);

  const out = [];
  const push = (t) => {
    const s = String(t ?? '').trim();
    if (isNoise(s) || out.includes(s)) return;
    out.push(s);
  };
  /** 已有标签排前面：用户的写法优先，新补的只往后加 */
  base.forEach(push);
  if (cat && cat !== UNCATEGORIZED) push(cat);
  fromName.forEach(push);

  return {
    tags: out.slice(0, MAX_TAGS),
    /** 这次新加了哪些（前端标绿用） */
    added: out.slice(base.length, MAX_TAGS),
  };
}

/**
 * 分页。
 *
 * 排序固定「分类 → 文件名」，不按时间：表情库是**资产库**，不是信息流。
 * 按时间排会让用户每次打开顺序都不一样，找图只能靠搜。
 */
export function pageOf(items, { page = 1, size = PAGE_SIZE, category = '', q = '' } = {}) {
  const all = (Array.isArray(items) ? items : []).filter((it) => {
    if (category && catOf(it) !== category) return false;
    const kw = String(q ?? '').trim().toLowerCase();
    if (!kw) return true;
    const hay = [it?.file, it?.rel, catOf(it), ...(it?.tags || [])].join(' ').toLowerCase();
    return hay.includes(kw);
  });

  all.sort((a, b) => {
    const c = catOf(a).localeCompare(catOf(b), 'zh');
    if (c !== 0) return c;
    return String(a?.file ?? '').localeCompare(String(b?.file ?? ''), 'zh');
  });

  const n = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(size) || PAGE_SIZE));
  const pages = Math.max(1, Math.ceil(all.length / n));
  const p = Math.min(pages, Math.max(1, Number(page) || 1));
  return {
    items: all.slice((p - 1) * n, p * n),
    page: p,
    size: n,
    total: all.length,
    pages,
    filtered: all.length,
  };
}

/**
 * 批量删除。**真删，没有回收站。**
 *
 * 返回逐条结果而不是「成功/失败」：一次删 20 张里有一张被占用（Windows 上
 * 常见）时，用户需要知道是哪一张，而不是笼统地「部分失败」。
 *
 * @param {string[]} dirs
 * @param {string[]} files 前端给的相对路径
 * @param {{confirm?:boolean}} [opts]
 */
export function removeFiles(dirs, files, opts = {}) {
  if (opts.confirm !== true) {
    return { ok: false, error: 'need_confirm', message: '删除不可恢复，需要显式确认', removed: [], failed: [] };
  }
  const list = [...new Set((Array.isArray(files) ? files : []).map(String))].filter(Boolean);
  if (!list.length) return { ok: false, error: 'empty', message: '没选要删的图', removed: [], failed: [] };
  if (list.length > MAX_DELETE) {
    return {
      ok: false, error: 'too_many',
      message: `一次最多删 ${MAX_DELETE} 张（这次 ${list.length} 张），分批来吧`,
      removed: [], failed: [],
    };
  }

  const removed = [];
  const failed = [];
  for (const f of list) {
    const hit = locate(dirs, f);
    if (!hit) {
      failed.push({ file: f, reason: '不在表情库里（可能已被移动或删除）' });
      continue;
    }
    try {
      unlinkSync(hit.abs);
      /** 侧车一起删：图没了还留着标签文件，下次同名图会被套上旧标签 */
      const side = `${hit.abs}${SIDECAR}`;
      if (existsSync(side)) {
        try { unlinkSync(side); } catch { /* 侧车删不掉不影响图已删的事实 */ }
      }
      removed.push(hit.rel);
    } catch (e) {
      failed.push({ file: f, reason: String(e?.message || e) });
    }
  }
  return {
    ok: failed.length === 0,
    removed,
    failed,
    message: failed.length
      ? `删了 ${removed.length} 张，${failed.length} 张没删掉`
      : `删了 ${removed.length} 张`,
  };
}

/**
 * 补标签任务：分片跑，能报进度、能取消。
 *
 * 为什么不做成一次跑完：几百张图逐个写侧车是同步 IO，一次跑完会把事件循环
 * 卡住好几秒，面板卡着转圈、消息也回不了。分片（每 tick 20 张）让出控制权，
 * 进度条才有意义。
 *
 * 为什么状态在内存：见文件头第 4 条。任务丢了最多重点一次，比留下
 * 「上次那个到底跑完没有」的悬案好。
 */
export function createTagJob({ items = [], worker, chunk = 20, log = () => {} } = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  const state = {
    id: `job-${Date.now().toString(36)}`,
    total: list.length,
    done: 0,
    failed: 0,
    /**
     * 一创建就算「在跑」：任务已经排上队，只是还没到第一个 tick。
     * 初始 false 的话，面板/轮询在第一片跑完前会看到「已结束、0%」，
     * 前端据此 break 就永远等不到结果（2026-11-14 实测踩到）。
     */
    running: true,
    cancelled: false,
    startedAt: Date.now(),
    finishedAt: 0,
    errors: [],
  };

  return {
    get id() { return state.id; },
    /** 跑一片。返回进度快照；`running:false` 表示已经结束 */
    tick() {
      if (state.cancelled) {
        state.running = false;
        return { ...state, errors: state.errors.slice(0, 10) };
      }
      state.running = true;
      const end = Math.min(list.length, state.done + Math.max(1, Number(chunk) || 20));
      for (let i = state.done; i < end; i += 1) {
        try {
          worker(list[i]);
        } catch (e) {
          state.failed += 1;
          /** 只留前 10 条错误：几百条同样的「文件被占用」没有信息量 */
          if (state.errors.length < 10) state.errors.push({ file: list[i]?.file ?? '', reason: String(e?.message || e) });
          log(`补标签失败 ${list[i]?.file ?? ''}：${e?.message || e}`);
        }
      }
      state.done = end;
      if (state.done >= list.length) {
        state.running = false;
        state.finishedAt = Date.now();
      }
      return { ...state, errors: state.errors.slice(0, 10) };
    },
    progress() {
      return {
        ...state,
        errors: state.errors.slice(0, 10),
        /** 百分比给进度条用，避免前端各算一遍 */
        percent: state.total ? Math.round((state.done / state.total) * 100) : 100,
      };
    },
    cancel() {
      state.cancelled = true;
      state.running = false;
      return this.progress();
    },
  };
}

/** 库的统计：面板顶部那几个数字 */
export function statsOf(items) {
  const list = Array.isArray(items) ? items : [];
  const byCat = new Map();
  let bytes = 0;
  let tagged = 0;
  for (const it of list) {
    const c = catOf(it);
    byCat.set(c, (byCat.get(c) || 0) + 1);
    bytes += Number(it?.size) || 0;
    if (Array.isArray(it?.tags) && it.tags.length) tagged += 1;
  }
  return {
    total: list.length,
    tagged,
    untagged: list.length - tagged,
    bytes,
    categories: [...byCat.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}

/** 文件大小格式化，面板上直接显示 */
export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
