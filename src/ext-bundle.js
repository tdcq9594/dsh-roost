/**
 * 扩展分发包：目录哈希 + tar.gz 解包（零依赖）
 * ==========================================
 *
 * 为什么自己写而不是引依赖：本仓 `src` 只用 node 内置模块（见 package.json
 * 的零依赖约束）。市场要做的两件事恰好都能用内置能力完成：
 *
 *   · 目录哈希 —— `crypto` + `fs`；算法必须与插件仓 `scripts/hashdir.mjs`、
 *     框架仓 `src/hashdir.js` **逐字节一致**，否则索引由一边生成、另一边校验，
 *     所有用户安装都会 `sha256` 不匹配。契约由 `test/ext-bundle.test.js` 的
 *     固定夹具哈希守住（值是用插件仓脚本算出来的，断言在 `test/ext-market.test.js`
 *     的 G6-1；本文件不单独建测试文件）。
 *   · tar.gz 解包 —— `zlib.gunzipSync` + 手写 ustar 头解析。GitHub 的
 *     codeload tar.gz 是标准 ustar，只用到普通文件与目录两种条目。
 *
 * 安全边界（与 `ext-registry.js` 的 id 校验同等重要）：
 *   · 拒绝绝对路径、盘符、`..` 段 —— 解包不能写到目标目录之外；
 *   · 只写普通文件，符号链接 / 硬链接 / 设备文件一律跳过（tar 的 type 非 0/48）；
 *   · 解包结果先落在调用方给的**暂存目录**，校验哈希通过后才由 `registry.install`
 *     原子 rename 上位。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/** 不参与哈希的东西：依赖目录、缓存、VCS/IDE 元数据（每台机器都不一样） */
const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git', '.idea', '.vscode']);
const SKIP_FILES = new Set(['.deps.json', '.DS_Store', 'Thumbs.db']);

/** 文本文件 CRLF 折成 LF；二进制原样（判定依据同 git：有没有 NUL 字节） */
function normalize(buf) {
  if (buf.includes(0)) return buf;
  if (!buf.includes(0x0d)) return buf;
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

async function collect(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.isDirectory()) {
        if (SKIP_DIRS.has(it.name)) continue;
        await walk(path.join(dir, it.name), prefix ? `${prefix}/${it.name}` : it.name);
      } else if (it.isFile()) {
        if (SKIP_FILES.has(it.name)) continue;
        out.push(prefix ? `${prefix}/${it.name}` : it.name);
      }
      // 符号链接一律跳过：可能指向仓库外，内容不稳定
    }
  };
  await walk(root, '');
  return out.sort();
}

/**
 * 目录内容哈希。**不要改这里的拼接格式**：`rel\0len\0content\0` 是三方共用契约。
 */
export async function hashDir(dir) {
  const files = await collect(dir);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    const buf = normalize(await fsp.readFile(path.join(dir, rel)));
    h.update(rel);
    h.update('\0');
    h.update(String(buf.length));
    h.update('\0');
    h.update(buf);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Windows 保留设备名：建出来是特殊设备，不能当普通文件写。只在 win32 上拒，
 * Linux / macOS 上 `aux.js` 是完全合法的名字。 */
const IS_WIN = process.platform === 'win32';
const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

/**
 * 解包时允许的相对路径。
 *
 * 拒：绝对路径 / 盘符 / `..` 段 / 空段 / Windows 保留设备名 / 段尾点或空格
 * （`.. ` 在 Win32 上不会被归一化，会建出字面异常目录）。
 */
export function safeRelPath(rel) {
  const s = String(rel ?? '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') return false;
    if (seg === '..') return false;
    if (IS_WIN && WIN_RESERVED.test(seg)) return false;
    /** 尾点 / 尾空格跨平台都拒：保证同一个包在 Windows 与 Linux 上落出同样的结构。 */
    if (/[. ]$/.test(seg)) return false;
  }
  return true;
}

/**
 * 手写 ustar 解析：返回 `Map<相对路径, Buffer>`。
 *
 * 只认普通文件（type `0` / `\0` / `'0'`）与目录（type `5`，跳过）。
 * 长路径用 ustar 的 `prefix` 字段拼接；GNU 的 `L` 扩展不处理——
 * GitHub codeload 产出的就是 ustar，遇到不认识的就跳过，不猜。
 */
export function untar(buf) {
  const out = new Map();
  let off = 0;
  while (off + 512 <= buf.length) {
    const nameRaw = buf.toString('utf8', off, off + 100);
    const name = nameRaw.replace(/\0.*$/, '').trim();
    if (!name) {
      // 全零块 = 归档结束
      off += 512;
      continue;
    }
    /**
     * **只能接受非负八进制。**
     *
     * 旧写法 `parseInt(sizeStr, 8) || 0` 只兜住 NaN，兜不住负数：`-1000`（八进制
     * = -512）会让 `512 + ceil(-512/512)*512 = 0`，`off` 永不前进 → 同步死循环，
     * 把宿主事件循环整个卡住（QQ / 面板 / `/v1` 全停）。`untar` 是在 `/quick`
     * 的 async handler 里同步跑的，所以这不是「坏包自己报错」，是把宿主拖死。
     */
    const sizeStr = buf.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim();
    const size = /^[0-7]{1,11}$/.test(sizeStr) ? Number.parseInt(sizeStr, 8) : 0;
    const type = buf[off + 156];
    const prefixRaw = buf.toString('utf8', off + 345, off + 500).replace(/\0.*$/, '').trim();
    const full = prefixRaw ? `${prefixRaw}/${name}` : name;
    const data = buf.subarray(off + 512, off + 512 + size);

    const isFile = type === 0 || type === 0x30 /* '0' */;
    const isDir = type === 0x35 /* '5' */;
    if (isFile && safeRelPath(full)) out.set(full, Buffer.from(data));
    else if (isDir) { /* 目录由写文件时按需创建，不入表 */ }
    // 其余类型（符号链接 2 / 硬链接 1 / 设备 3,4 / pax x,g）一律跳过

    /** 前进保证 + 越界保护：`next <= off` 一律终止，绝不靠「相信包是好的」。 */
    const next = off + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next <= off || off + 512 + size > buf.length) break;
    off = next;
  }
  return out;
}

/**
 * tar.gz → `Map<rel, Buffer>`，并**剥掉一层顶层目录**。
 *
 * GitHub codeload 的包顶层是 `<repo>-<ref>/`，扩展目录在它下面
 * （如 `qq-bot-roost-plugins-main/plugins/bili/`）。剥一层后再按 `path` 取子树。
 */
export function extractTarGz(gz, { strip = 1, maxBytes = 64 * 1024 * 1024 } = {}) {
  // 上限防 zip bomb：解压后超过 64 MB 直接抛，不让宿主内存被吃满。
  const raw = untar(gunzipSync(gz, { maxOutputLength: maxBytes }));
  if (!strip) return raw;
  const out = new Map();
  for (const [rel, buf] of raw) {
    const parts = rel.split('/');
    if (parts.length <= strip) continue;
    out.set(parts.slice(strip).join('/'), buf);
  }
  return out;
}

/** 从解包结果里取 `prefix` 子树，并把前缀从路径里去掉。 */
export function pickSubtree(files, prefix = '') {
  const p = String(prefix ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const out = new Map();
  for (const [rel, buf] of files) {
    if (!p) { out.set(rel, buf); continue; }
    if (rel === p) continue;
    if (rel.startsWith(`${p}/`)) out.set(rel.slice(p.length + 1), buf);
  }
  return out;
}

/**
 * 安全落盘：每个相对路径都过 `safeRelPath`，任何一条不合规就整体拒绝。
 *
 * 「整体拒绝」是刻意的：一半写进去的目录会被扫描器当成已装扩展，
 * 而缺文件的表现是 MCP 起来就退出，比直接报错难查得多。
 */
export async function writeFiles(root, files, { rejectSkips = false } = {}) {
  for (const rel of files.keys()) {
    if (!safeRelPath(rel)) throw new Error(`分发包里含非法路径：${rel}`);
    /**
     * `rejectSkips` 是市场安装专用：`hashDir` 不算 `node_modules` / `__pycache__`
     * 这些目录，如果它们仍被写盘，就可以「被哈希的文件一个不改、只往跳过目录里塞
     * 可执行内容」，索引 sha256 照样对得上 —— 校验形同虚设。
     * 扩展不该自带依赖目录，遇到就整体拒装。
     */
    if (rejectSkips) {
      const segs = rel.replace(/\\/g, '/').split('/');
      const bad = segs.some((s) => SKIP_DIRS.has(s)) || SKIP_FILES.has(segs[segs.length - 1]);
      if (bad) throw new Error(`分发包里含不参与哈希的路径，拒绝安装：${rel}`);
    }
  }
  await fsp.mkdir(root, { recursive: true });
  for (const [rel, buf] of files) {
    const dest = path.join(root, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    // 随机临时名：分发包里真有个 `x.part` 时，不会被同目录 `x` 的临时文件覆盖。
    const tmp = `${dest}.${randomBytes(4).toString('hex')}.part`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, dest);
  }
  return files.size;
}

/** 同步版清理：给失败回滚用（调用方在同步上下文里）。 */
export function rmrfSync(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 已删 */ }
}
