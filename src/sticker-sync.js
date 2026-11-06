/**
 * 缓存图 → 表情包库：把 `<数据目录>/images/` 里「像表情包」的图搬成「未分类」。
 *
 * ## 为什么不做内容识别
 *
 * 打标签要模型看得见图。实际权限是 `permissions: { owner: 'all', member: 'chat' }`，
 * `chat` 档的 allow 里没有 `read_image`（见 client 的档位表），所以：
 *
 *   - 主人说话那一轮（owner=all）看得见，能标；
 *   - **群成员说话那一轮（member=chat）看不见**，只有正文里一行本地路径。
 *
 * 群里绝大多数消息是后者。要覆盖它们，要么给群里每个人开放读本地文件，
 * 要么改 ai-chat 的消息入口让图提前下来——两样都不划算。
 *
 * 所以这里只做**搬运**，判断标准退回到「尺寸像不像表情包」：
 * 实测 21 张缓存里，边长 ≤1024 + 长宽比 ≤1.8 能干净切掉 2560×1600 截图、
 * 1920×1080 壁纸、1469×161 长条，留下 12 张 240×240 / 500×500 / 1000×1000
 * 这类真正的表情包。
 *
 * 代价写在明处：搬进来的图**没有语义标签**，模型不知道图里是什么，
 * 清单里只显示「缓存同步，等待分类」。真正让它们可用的一步是用户自己
 * 把它们拖进 `开心/`、`无语/` 这类目录——**目录名就是唯一的语义**。
 */

import {
  readdirSync, statSync, copyFileSync, mkdirSync, existsSync,
  writeFileSync, readFileSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join, extname } from 'node:path';

import { UNCATEGORIZED } from './stickers.js';

/** 认的图片格式，跟 stickers.js 的 OK_EXT 保持一致 */
const OK_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** 筛选默认值。都能在面板弹窗里改（写进 `stickers.sync`） */
export const SYNC_DEFAULTS = {
  /** 长边上限。超过基本是截图/壁纸，不是表情 */
  maxEdge: 1024,
  /** 长宽比上限。截图和「聊天记录长条图」都远大于这个 */
  maxRatio: 1.8,
  minBytes: 5 * 1024,
  maxBytes: 1024 * 1024,
};

/** 入库文件名前缀。序号补零，`缓存_0001.gif` 用户一眼能认出来 */
const PREFIX = '缓存';

/**
 * 只读文件头（前 64KB）就能拿到宽高——项目是零依赖，没有 sharp，
 * 全部靠手解 PNG/GIF/JPEG/WebP 的固定偏移。
 *
 * 读不出尺寸不报错，返回 0：调用方按「体积过关就放行」处理，
 * 因为 WebP/BMP 的偏移各版本有差异，为了一个边缘格式卡死整批不值得。
 */
export function dimsOf(buf) {
  if (!buf || buf.length < 24) return { w: 0, h: 0 };
  /** PNG：89 50 4E 47，IHDR 的宽高在 16 / 20，大端 */
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  /** GIF：GIF8，逻辑屏幕描述符在 6 / 8，小端 */
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  /** JPEG：扫到 SOF0/SOF2 才拿到宽高（段里高在前、宽在后） */
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  /** WebP：RIFF....WEBP + 变体标记 */
  if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
    }
  }
  return { w: 0, h: 0 };
}

/** 头 64KB。JPEG 的 SOF 段一般在头几百字节内，够用 */
function headOf(p, n = 64 * 1024) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(n);
    const len = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, len);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/** 单张判定。返回 reason 是为了让面板能说清「为什么跳过这张」 */
export function judge(item, cfg = {}) {
  const c = { ...SYNC_DEFAULTS, ...cfg };
  const size = Number(item.size) || 0;
  if (size < c.minBytes) return { ok: false, reason: `太小（${(size / 1024).toFixed(0)}KB）` };
  if (size > c.maxBytes) return { ok: false, reason: `太大（${(size / 1024 / 1024).toFixed(1)}MB）` };

  const w = Number(item.w) || 0;
  const h = Number(item.h) || 0;
  /** 读不出尺寸：格式太边缘，按体积放行——宁可多收一张，也别把 WebP 全挡掉 */
  if (!w || !h) return { ok: true, reason: '' };

  const edge = Math.max(w, h);
  /**
   * 先比长宽比，再比边长。
   *
   * 顺序有讲究：`1469×161` 两种都超标，但「太长（9.1:1）」比
   * 「边长 1469×161」更能让人一眼知道为什么被跳过。
   */
  const ratio = edge / Math.min(w, h);
  if (ratio > c.maxRatio) return { ok: false, reason: `太长（${ratio.toFixed(1)}:1）` };
  if (edge > c.maxEdge) return { ok: false, reason: `边长 ${w}×${h}` };
  return { ok: true, reason: '' };
}

/**
 * 把用户填的一段文本变成**能当文件名/目录名**的一段。
 *
 * 挡住的东西（依次）：
 *   · 路径分隔符 —— 填 `开心/搞笑` 时会变成目录套目录，直接删掉分隔符；
 *   · Windows 非法字符 `:*?"<>|` 和控制字符；
 *   · `..` —— 首尾的点全部削掉，`..` 会先被折成一个 `.` 再削成空串；
 *   · 保留名 `CON/PRN/NUL/COM1…` —— Windows 上建不出来，直接算无效。
 *
 * 返回空串 = 这段不能用，调用方回落默认值。
 */
export function safeSeg(s, { max = 40 } = {}) {
  const BAD = /[\\/:*?"<>|\u0000-\u001f]/g;
  let v = String(s ?? '').replace(BAD, '').replace(/\.{2,}/g, '');
  v = v.replace(/^[\s.]+|[\s.]+$/g, '');
  if (!v) return '';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(v)) return '';
  return v.slice(0, max);
}

/**
 * 标签 → 文件名里的词。
 *
 * 分隔符跟 `stickers.js` 的 `tagsOf` 对齐（`_ - 空格 括号 顿号 逗号`），
 * 这样回读时拆得回来：`开心_猫.jpg` → 标签「开心」「猫」。
 */
export function tagWords(s, { max = 4 } = {}) {
  return String(s ?? '')
    .split(/[\s,，、_\-()（）·]+/)
    .map((x) => safeSeg(x, { max: 12 }))
    .filter(Boolean)
    .slice(0, max);
}

/** 目标目录里下一个不冲突的文件名：`开心_猫.jpg` → `开心_猫_2.jpg` → `_3` */
function nextFree(dir, base, ext) {
  let name = `${base}${ext}`;
  let i = 1;
  while (existsSync(join(dir, name))) {
    i += 1;
    name = `${base}_${i}${ext}`;
  }
  return name;
}

/**
 * @param {object} o
 * @param {string} o.dataDir 数据根目录（缓存图在它下面的 images/）
 * @param {object} o.stickers `createStickers()` 的实例（用来取目标目录）
 * @param {(m:string)=>void} [o.log]
 */
export function createStickerSync({ dataDir, stickers, log = () => {} }) {
  const cacheDir = () => join(dataDir, 'images');

  /**
   * 目标目录 = 第一个表情包目录下的 `未分类/`。
   *
   * 用**真目录**而不是把图丢在根目录：根目录那批图在提示词里是「未分类（N 张）」
   * 的虚拟分类，同时又是平铺模式的来源（逐图列文件名，最吃预算）。
   * 建一个实体目录之后它就成了正经分类，用户把图拖进 `开心/` 就分好类了，
   * 根目录也不会攒一堆没名字的图。
   *
   * `create` 默认 false：**只看一眼不该在盘上建目录**。以前 preview 也建，
   * 结果是用户点开弹窗又关掉，`未分类/` 已经悄悄出现了。
   */
  const targetDir = (cfg = {}, { create = false } = {}) => {
    const d = join(stickers.dir(cfg), UNCATEGORIZED);
    if (create) {
      try {
        if (!existsSync(d)) mkdirSync(d, { recursive: true });
      } catch (e) {
        log(`未分类目录建不出来：${e.message}`);
      }
    }
    return d;
  };

  /**
   * 记账文件。键是**缓存文件名**本身——它已经是 sha1 前 16 位，
   * 天然唯一，不用再算一遍哈希。
   */
  const ledgerPath = () => join(dataDir, 'stickers', '.synced.json');

  const readLedger = () => {
    try {
      const j = JSON.parse(readFileSync(ledgerPath(), 'utf8'));
      return j && typeof j.done === 'object' && j.done ? j.done : {};
    } catch {
      return {};
    }
  };

  const writeLedger = (done) => {
    try {
      mkdirSync(join(dataDir, 'stickers'), { recursive: true });
      writeFileSync(ledgerPath(), JSON.stringify({ done, at: Date.now() }, null, 2));
    } catch (e) {
      /** 账本写不进去只影响「下次会重复同步」，不该让整次操作失败 */
      log(`同步账本写不进去：${e.message}`);
    }
  };

  /** 扫一遍缓存，逐张判定。`dir` 是目标目录（= 表情包目录下的 `未分类/`） */
  const preview = (cfg = {}) => {
    const dir = targetDir(cfg);
    const done = readLedger();
    const items = [];
    let names = [];
    try {
      names = readdirSync(cacheDir());
    } catch {
      return { ok: false, dir, items, total: 0, willSync: 0, skipped: 0, message: '还没有缓存图（没人发过图片）' };
    }

    names.sort();
    for (const name of names) {
      if (!OK_EXT.has(extname(name).toLowerCase())) continue;
      const p = join(cacheDir(), name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const row = { name, path: p, size: st.size, w: 0, h: 0, ok: false, reason: '' };
      if (done[name]) {
        row.reason = '已同步过';
        items.push(row);
        continue;
      }
      const head = headOf(p);
      if (head) {
        const d = dimsOf(head);
        row.w = d.w;
        row.h = d.h;
      }
      Object.assign(row, judge(row, cfg?.sync || {}));
      items.push(row);
    }

    const willSync = items.filter((x) => x.ok).length;
    return { ok: true, dir, items, total: items.length, willSync, skipped: items.length - willSync };
  };

  /**
   * 真正复制。
   *
   * **复制而不是移动**：`images/` 里的路径还被历史对话上下文引用着
   * （模型当时看到的是那个路径），移走就等于让旧引用全部失效。
   * 表情包一般几百 KB，多一份不心疼。
   *
   * @param {object} cfg `stickers` 段
   * @param {object} [o]
   * @param {Array<{name:string, folder?:string, tags?:string}>} [o.picks]
   *        逐张的去向。`folder` 空 = `未分类`；`tags` 空 = 文件名用 `缓存`。
   * @param {string[]} [o.names] 老调用：只给名字，等于「全部进未分类、不打标签」
   */
  const apply = (cfg = {}, { names = [], picks = [] } = {}) => {
    const p = preview(cfg);
    if (!p.ok) return { ok: false, message: p.message || '没有可同步的图' };

    /**
     * `picks` 是白名单语义：非空就只处理列出来的那些，哪怕它「太长」。
     * 用户已经看过预览、还勾了，说明他知道自己在做什么。
     */
    const byName = new Map(p.items.map((x) => [x.name, x]));
    const wanted = picks.length
      ? picks
      : (Array.isArray(names) ? names : []).map((n) => ({ name: n }));
    const picked = wanted.length
      ? wanted.map((w) => ({ ...w, row: byName.get(String(w?.name || '')) })).filter((w) => w.row)
      : p.items.filter((x) => x.ok).map((x) => ({ name: x.name, row: x }));

    const rootDir = stickers.dir(cfg);
    const done = readLedger();
    const copied = [];
    const failed = [];
    /** 每个分类收了几张：面板 toast 用「8 张进未分类、4 张进开心」这种说法 */
    const folders = {};

    for (const it of picked) {
      if (it.row.reason.includes('已同步')) continue;

      /**
       * 没填文件夹就进 `未分类`。这也是**用户唯一需要记住的规则**：
       * 什么都不填 = 老规矩；填了才分流。
       */
      const folder = safeSeg(it.folder) || UNCATEGORIZED;
      const dir = join(rootDir, folder);
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        failed.push({ name: it.name, error: `建目录失败：${e.message}` });
        continue;
      }

      const tags = tagWords(it.tags);
      /** 有标签就用标签当文件名——文件名本身就是标签，比只写侧车更直观 */
      const base = tags.length ? tags.join('_') : PREFIX;
      const ext = extname(it.name).toLowerCase();
      const target = nextFree(dir, base, ext);

      try {
        copyFileSync(it.row.path, join(dir, target));
        try {
          /**
           * 侧车**总是**写：文件名能表达的只是标签，侧车还能放「场合」，
           * 而且以后用户手动改名也不会把语义一起改掉。
           * 没标签时退回原来那句「等待分类」。
           */
          writeFileSync(join(dir, target + '.tags'), tags.length ? tags.join(', ') : '; 缓存同步，等待分类');
        } catch {}
        done[it.name] = `${folder}/${target}`;
        folders[folder] = (folders[folder] || 0) + 1;
        copied.push({ from: it.name, to: target, folder });
      } catch (e) {
        failed.push({ name: it.name, error: e.message });
      }
    }

    if (copied.length) writeLedger(done);
    return {
      ok: true,
      dir: p.dir,
      copied: copied.length,
      failed,
      folders,
      names: copied.map((c) => c.to),
    };
  };

  /** 清空账本：删过图之后想让它们重新同步一次 */
  const reset = () => {
    writeLedger({});
    return { ok: true };
  };

  return { preview, apply, reset, ledgerPath };
}
