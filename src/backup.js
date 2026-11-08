/**
 * 一键备份：把数据目录打包成 zip，换电脑时导入，下次启动才换上。
 * ==========================================================
 *
 * ZIP 编码思路来自调研对象 aurabot 的 `src/core/backup.js`（零依赖：
 * `node:zlib` 的 `crc32` / `deflateRawSync` / `inflateRawSync` + 手写
 * local/central/EOCD 头）。我们不引第三方依赖，也不搬它那套 sessions /
 * 市场模块 / workspaceDir 恢复 —— 我们只有一个数据目录。
 *
 * 三条硬规矩（报告 §12.1-A2、交接 §3③）：
 *
 * 1. **恢复不能在运行中做**。插件内存里的配置和状态随时会写回去，把刚
 *    恢复的文件盖掉。所以导入只解到 `.restore/`，`applyPendingRestore()`
 *    必须在 `host.apply()` 里、`loadConfig()` **之前**调用。
 * 2. **被换掉的文件挪到 `backups/pre-restore-<时间戳>/`**，随时能找回，
 *    不删。SQLite 的 `-wal` / `-shm` 也要一起挪：只换主库、留着旧 WAL，
 *    启动时 SQLite 会把旧事务重放到新库上（aurabot 同款坑）。
 * 3. **SQLite 用一致性快照**。运行中直接 copy `journal.sqlite` 可能拿到
 *    写了一半的页；这里用只读连接 `VACUUM INTO` 到临时文件再读，快照
 *    自带已提交数据。快照失败就整份备份失败，不交半成品。
 *
 * 包里不装 logs / 缓存 / 备份自身 / node_modules（见 SKIP），也不装
 * `*.sqlite-wal` / `*.sqlite-shm`（数据已在快照里，带上反而危险）。
 */

import {
  closeSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync, writeSync,
} from 'node:fs';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MANIFEST = 'dsh-roost-backup.json';
export const SCHEMA = 1;
export const APP = 'dsh-roost';
export const BACKUP_PREFIX = 'dsh-roost-backup-';

const MAX_ZIP = 0xfffffff0;               // 没做 zip64，超过 4GB 明确报错
const MAX_FILE = 2 ** 31 - 1;            // Buffer / readFileSync 的边界
const DEFLATE_MAX = 64 * 1024 * 1024;    // 再大的单文件直接 store，别占满内存
const MAX_FILES = 20000;
const MAX_UNPACKED = 512 * 1024 * 1024;  // 解包总量上限，挡 zip 炸弹
const STORE_EXT = /\.(png|jpe?g|gif|webp|mp3|mp4|m4a|ogg|opus|webm|zip|7z|rar|pth|index|onnx|safetensors|wav|bin)$/i;

/** 不进备份的东西：备份自身、恢复暂存、日志、缓存、依赖。 */
const SKIP = ['backups', '.restore', '.restore-pending.json', 'logs', 'tmp', 'voice-cache', 'archive-cache'];

/**
 * 例外：D11 `purge` 留下的行级备份要**进统一包格式**（§3③），否则换电脑
 * 时带不走「真删之前那份原文」。只放行这一个形状，`backups/` 下别的一律
 * 拒绝，免得恢复包能覆盖掉备份目录里的任意文件。
 */
const RETENTION_BACKUP = /^backups\/pre-retention-[\w.-]+\.json$/;
export const isRetentionBackup = (name) => RETENTION_BACKUP.test(`backups/${name}`);

/** 路径安全：只允许 `a/b/c.json` 这种相对 POSIX 路径。 */
export function safeRel(rel) {
  if (!rel || typeof rel !== 'string') return false;
  if (rel.includes('\\') || rel.includes('\0') || rel.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(rel)) return false;
  /** Windows 文件名禁用字符；`data/aa:b.txt` 会在 NTFS 上写进备用数据流，内容凭空消失 */
  if (/[<>:"|?*\x00-\x1f]/.test(rel)) return false;
  return rel.split('/').every((s) => s && s !== '.' && s !== '..');
}

/** 跳过规则同时用于打包与解包，防止有人往包里塞 `backups/` 覆盖掉备份。 */
export function shouldSkip(rel) {
  if (RETENTION_BACKUP.test(rel)) return false; // 行级备份是唯一放行的备份目录条目
  if (SKIP.some((s) => rel === s || rel.startsWith(s + '/'))) return true;
  if (rel.split('/').includes('node_modules')) return true;
  if (rel.endsWith('.tmp') || rel.endsWith('.sqlite-wal') || rel.endsWith('.sqlite-shm')) return true;
  return false;
}

const dirOf = (root) => join(root, 'backups');
const stageDir = (root) => join(root, '.restore');
const pendingFile = (root) => join(root, '.restore-pending.json');

/** 遍历数据目录，返回 POSIX 相对路径（不跟随符号链接）。 */
function walk(root, rel = '', out = []) {
  for (const item of readdirSync(join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${item.name}` : item.name;
    if (shouldSkip(next)) continue;
    if (item.isSymbolicLink()) continue;
    const full = join(root, ...next.split('/'));
    if (item.isDirectory()) walk(root, next, out);
    else if (item.isFile() && statSync(full).size <= MAX_FILE) out.push({ rel: next, full });
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  const walkFiles = (d, rel = '') => {
    for (const item of readdirSync(join(d, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) walkFiles(d, next);
      else if (item.isFile()) out.push(next);
    }
  };
  if (existsSync(dir)) walkFiles(dir);
  return out;
}

/** rename 失败（跨盘）时退化成 copy + 删；两边都建好父目录。 */
function move(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/** DOS 时间戳：ZIP 头里存的是本地时间，不是 UTC。 */
const dosTime = (d) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

function localHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(0x0800, 6);     // 文件名 UTF-8
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(e.time, 10);
  h.writeUInt16LE(e.date, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(e.packed, 18);
  h.writeUInt32LE(e.size, 22);
  h.writeUInt16LE(name.length, 26);
  return Buffer.concat([h, name]);
}

function centralHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(e.packed, 20);
  h.writeUInt32LE(e.size, 24);
  h.writeUInt16LE(name.length, 28);
  h.writeUInt32LE(e.offset, 42);
  return Buffer.concat([h, name]);
}

/**
 * SQLite 的一致性快照：只读打开源库，`VACUUM INTO` 到临时文件再读回来。
 * 目标文件必须不存在，所以每次用随机名；读完立刻删。
 * 没有 node:sqlite（Node 22.0~22.4 的老版本）时返回 null，由调用方决定
 * 是报错还是照旧复制 —— 这里选择报错，因为半份备份比没有备份更危险。
 */
function sqliteSnapshot(file) {
  const { DatabaseSync } = process.getBuiltinModule?.('node:sqlite') || {};
  if (!DatabaseSync) throw new Error(`当前 Node 没有 node:sqlite，无法给 ${basename(file)} 做一致性快照`);
  const out = join(tmpdir(), `dsh-roost-snap-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${out.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  } finally {
    try { db.close(); } catch {}
  }
  try {
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * 打包数据目录。
 * @param {{root:string, out?:string, now?:Date, version?:string}} opts
 *        out 默认为 `<root>/backups/`，CLI 可指向别处；now 供测试固定时间戳。
 * @returns {{file:string, name:string, files:number, bytes:number, skipped:string[], manifest:object}}
 */
export function createBackup({ root, out, now = new Date(), version = '', log = () => {} } = {}) {
  if (!root) throw new Error('没给数据目录');
  const dest = out || dirOf(root);
  mkdirSync(dest, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  let name = `${BACKUP_PREFIX}${stamp}.zip`;
  /** 同一分钟导出两次别互相覆盖（改名而非覆盖，备份永远不删旧文件） */
  if (existsSync(join(dest, name))) {
    let n = 2;
    while (existsSync(join(dest, `${BACKUP_PREFIX}${stamp}-${n}.zip`))) n += 1;
    name = `${BACKUP_PREFIX}${stamp}-${n}.zip`;
  }
  const final = join(dest, name);
  const tmp = `${final}.tmp`;

  const items = walk(root);
  /** `backups/` 被整段跳过，但行级备份要单独收进包（不递归备份目录）。 */
  try {
    const bdir = dirOf(root);
    for (const n of readdirSync(bdir)) {
      if (!isRetentionBackup(n)) continue;
      const full = join(bdir, n);
      if (statSync(full).isFile()) items.push({ rel: `backups/${n}`, full });
    }
  } catch {}
  const fh = openSync(tmp, 'w');
  const entries = [];
  const skipped = [];
  const snapshots = [];
  let offset = 0;
  let bytes = 0;

  const put = (entryName, data, at) => {
    const method = data.length <= DEFLATE_MAX && !STORE_EXT.test(entryName) ? 8 : 0;
    const body = method === 8 ? deflateRawSync(data) : data;
    const { time, date } = dosTime(at);
    const e = {
      name: entryName, method, time, date, crc: crc32(data),
      packed: body.length, size: data.length, offset,
    };
    const head = localHeader(e);
    if (offset + head.length + body.length > MAX_ZIP) throw new Error('数据超过 4GB，一个备份放不下');
    writeSync(fh, head);
    writeSync(fh, body);
    offset += head.length + body.length;
    entries.push(e);
  };

  try {
    for (const { rel, full } of items) {
      try {
        const st = statSync(full);
        let data;
        if (rel.endsWith('.sqlite')) {
          data = sqliteSnapshot(full);
          snapshots.push(rel);
        } else {
          data = readFileSync(full);
        }
        put(`data/${rel}`, data, st.mtime);
        bytes += data.length;
      } catch (e) {
        // 文件正被占用/删掉、或 SQLite 快照失败：记下来，不静默跳过
        skipped.push(rel);
        log(`备份跳过 ${rel}：${e?.message ?? e}`);
      }
    }
    if (skipped.length) throw new Error(`这些文件没能打包，备份已取消：${skipped.join('、')}`);
    if (entries.length + 1 > MAX_FILES || entries.length + 1 > 0xffff) throw new Error('文件太多，一个备份放不下');

    const manifest = {
      schema: SCHEMA, app: APP, version,
      createdAt: now.toISOString(), dataDir: resolve(root), home: homedir(),
      platform: process.platform, files: entries.length, bytes,
      snapshots, skipped,
    };
    put(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), now);
    const central = Buffer.concat(entries.map(centralHeader));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    writeSync(fh, Buffer.concat([central, end]));
    closeSync(fh);
    renameSync(tmp, final);
    return { file: final, name, files: manifest.files, bytes, skipped, snapshots, manifest };
  } catch (e) {
    try { closeSync(fh); } catch {}
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** 读 zip 的中央目录：只看文件尾，不把整份备份读进内存。 */
function readEntries(fh, size) {
  const tailLen = Math.min(size, 22 + 65535);
  const tail = Buffer.alloc(tailLen);
  readSync(fh, tail, 0, tailLen, size - tailLen);
  let end = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('不是有效的备份文件（找不到 zip 目录）');
  const count = tail.readUInt16LE(end + 10);
  const dirSize = tail.readUInt32LE(end + 12);
  const dirOffset = tail.readUInt32LE(end + 16);
  if (count > MAX_FILES || dirSize > size - dirOffset) throw new Error('备份文件的目录太大，已拒绝');
  const dir = Buffer.alloc(dirSize);
  readSync(fh, dir, 0, dirSize, dirOffset);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new Error('备份文件的目录损坏');
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    entries.push({
      method: dir.readUInt16LE(p + 10),
      crc: dir.readUInt32LE(p + 16),
      packed: dir.readUInt32LE(p + 20),
      size: dir.readUInt32LE(p + 24),
      offset: dir.readUInt32LE(p + 42),
      name: dir.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(fh, e) {
  const head = Buffer.alloc(30);
  readSync(fh, head, 0, 30, e.offset);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`备份文件损坏：${e.name}`);
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (start + e.packed > fstatSync(fh).size) throw new Error(`备份文件被截断：${e.name}`);
  const raw = Buffer.alloc(e.packed);
  readSync(fh, raw, 0, e.packed, start);
  if (e.method !== 0 && e.method !== 8) throw new Error(`备份文件用了不支持的压缩方式：${e.name}`);
  const data = e.method === 8
    ? inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) })
    : raw;
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`备份文件校验失败：${e.name}`);
  return data;
}

/**
 * 校验备份并**只**解到 `.restore/`，下次启动才换上去。
 * 这个函数绝不碰现有的数据文件 —— 运行中调用也安全。
 * @param {{zip:string, root:string}} opts
 */
export function stageRestore({ zip, root, now = new Date() } = {}) {
  if (!zip || !root) throw new Error('没给备份文件或数据目录');
  const size = statSync(zip).size;
  const fh = openSync(zip, 'r');
  const stage = stageDir(root);
  try {
    const entries = readEntries(fh, size);
    const head = entries.find((e) => e.name === MANIFEST);
    if (!head) throw new Error('这不是 dsh-roost 的备份文件');
    const manifest = JSON.parse(readEntry(fh, head).toString('utf8'));
    if (manifest.schema !== SCHEMA || manifest.app !== APP) throw new Error('这个备份的格式认不出来，先更新插件');

    // 先全部校验完、解到暂存；任何一条坏掉都不留下半份 .restore/
    rmSync(stage, { recursive: true, force: true });
    rmSync(pendingFile(root), { force: true });
    mkdirSync(stage, { recursive: true });
    let files = 0;
    let unpacked = 0;
    for (const e of entries) {
      if (e.name === MANIFEST) continue;
      if (!e.name.startsWith('data/')) throw new Error(`备份里有不认识的条目：${e.name}`);
      const rel = e.name.slice(5);
      if (!safeRel(rel) || shouldSkip(rel)) throw new Error(`备份里有不安全的路径：${rel}`);
      unpacked += e.size;
      if (unpacked > MAX_UNPACKED) throw new Error('备份解压后太大，已拒绝');
      const dest = resolve(stage, ...rel.split('/'));
      if (!dest.startsWith(resolve(stage) + sep)) throw new Error(`备份里有不安全的路径：${rel}`);
      const data = readEntry(fh, e);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      files += 1;
    }
    if (!existsSync(join(stage, 'config.json'))) throw new Error('备份里没有 config.json');
    const info = {
      at: now.getTime(), files, createdAt: manifest.createdAt, version: manifest.version,
      dataDir: manifest.dataDir, home: manifest.home, platform: manifest.platform,
      snapshots: manifest.snapshots || [],
    };
    writeFileSync(pendingFile(root), JSON.stringify(info, null, 2), 'utf8');
    return { ok: true, files, info, manifest };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(pendingFile(root), { force: true });
    throw e;
  } finally {
    try { closeSync(fh); } catch {}
  }
}

/** 有没有待应用的恢复（面板可以显示「下次启动生效」）。 */
export function pendingRestore(root) {
  try { return JSON.parse(readFileSync(pendingFile(root), 'utf8')); } catch { return null; }
}

/** 取消待应用的恢复，不动任何现有数据。 */
export function cancelRestore(root) {
  rmSync(stageDir(root), { recursive: true, force: true });
  rmSync(pendingFile(root), { force: true });
}

/**
 * **启动时、读配置之前**调用：把 `.restore/` 换上去。
 * 被换掉的文件（含 SQLite 的 -wal/-shm）挪到 `backups/pre-restore-<时间戳>/`。
 * @returns {{applied:number, kept:string|null}}
 */
export function applyPendingRestore({ root, now = Date.now() } = {}) {
  if (!root) throw new Error('没给数据目录');
  const pending = pendingRestore(root);
  if (!pending) return { applied: 0, kept: null };
  const stage = stageDir(root);
  if (!existsSync(stage)) { rmSync(pendingFile(root), { force: true }); return { applied: 0, kept: null }; }

  const keep = join(dirOf(root), `pre-restore-${now}`);
  const files = listFiles(stage).map((rel) => relative(stage, join(stage, ...rel.split('/'))).split(sep).join('/'));
  const moved = new Set();
  const keepOld = (rel) => {
    if (moved.has(rel)) return;
    moved.add(rel);
    const cur = join(root, ...rel.split('/'));
    if (existsSync(cur) && lstatSync(cur).isFile()) move(cur, join(keep, ...rel.split('/')));
  };

  for (const rel of files) {
    keepOld(rel);
    /** 旧 WAL/SHM 不能留：SQLite 会把旧事务重放到刚换上的新库 */
    if (rel.endsWith('.sqlite')) {
      keepOld(`${rel}-wal`);
      keepOld(`${rel}-shm`);
    }
  }
  for (const rel of files) {
    const from = join(stage, ...rel.split('/'));
    const to = join(root, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    move(from, to);
  }

  /**
   * 配置里可能写着旧机器的数据目录绝对路径（tts 安装目录、模型路径等）。
   * 只把「旧数据目录」这段换成这台机器的路径，别动别的内容；JSON 字符串
   * 里的反斜杠要按转义后的形式替换，用 JSON.stringify 取字面量片段。
   */
  const config = join(root, 'config.json');
  if (pending.dataDir && resolve(pending.dataDir) !== resolve(root) && existsSync(config)) {
    const esc = (s) => JSON.stringify(s).slice(1, -1);
    const raw = readFileSync(config, 'utf8');
    const old = esc(pending.dataDir);
    if (raw.includes(old)) writeFileSync(config, raw.replaceAll(old, esc(resolve(root))), 'utf8');
  }

  rmSync(stage, { recursive: true, force: true });
  rmSync(pendingFile(root), { force: true });
  return { applied: files.length, kept: moved.size ? keep : null };
}

/** 备份清单：完整包 + D11 purge 的行级备份，供面板只读展示。 */
export function listBackups(root) {
  const dir = dirOf(root);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isFile()) continue;
    const kind = name.startsWith(BACKUP_PREFIX) && name.endsWith('.zip')
      ? 'full'
      : name.startsWith('pre-retention-') && name.endsWith('.json') ? 'retention' : null;
    if (!kind) continue;
    const st = statSync(full);
    out.push({ name, kind, bytes: st.size, at: st.mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * D11 `purge` 备份的**行级还原**（§3③）。
 *
 * 和整包恢复是两件事：这里只把 `pre-retention-*.json` 里带原文的行插回去，
 * 不碰配置、不覆盖别的文件。抽成纯函数是为了能拿假 store 直接测，
 * 不用起整个 host。
 *
 * 三条硬要求：
 *  · **原样插回** —— 走 store 的 `insertRaw()`，不调用 `memory.add()` /
 *    `journal.add()`：前者会触发 `supersede()` 顺手作废相似事实，后者会
 *    重算 `level`/`keepUntil` 并丢掉 `accessed`/`invalidAt`/`vec`。
 *  · **幂等** —— 同一份重复还原、或目标行已经存在，都只报 `skipped`。
 *  · 重复还原不重开 sweep 由调用方（host）负责，这里不碰配置。
 *
 * @returns {{facts:number, journal:number, skipped:number}}
 */
export function restoreRetentionRows({ payload, memory, journal }) {
  const facts = Array.isArray(payload?.facts) ? payload.facts : [];
  const rows = Array.isArray(payload?.journal) ? payload.journal : [];
  const existing = new Set(
    (memory.retention?.entries?.() || []).map((e) => JSON.stringify([
      String(e.scope || 'global'), String(e.chatId || ''), String(e.text ?? e.id ?? ''),
    ])),
  );
  const seenFacts = new Set();
  const seenRows = new Set();
  let insertedFacts = 0;
  let insertedRows = 0;
  let skipped = 0;

  for (const raw of facts) {
    const row = {
      scope: raw.scope === 'chat' ? 'chat' : 'global',
      chatId: String(raw.chatId || ''),
      text: String(raw.text ?? raw.id ?? ''),
      w: Number(raw.w) || 1,
      at: Number(raw.at) || 0,
      src: raw.src ?? null,
      until: Number(raw.until) || 0,
      expiredBy: String(raw.expiredBy || ''),
    };
    if (!row.text) { skipped += 1; continue; }
    const key = JSON.stringify([row.scope, row.chatId, row.text]);
    if (seenFacts.has(key) || existing.has(key)) { skipped += 1; continue; }
    seenFacts.add(key);
    if (memory.insertRaw?.(row)) insertedFacts += 1;
    else skipped += 1;
  }

  for (const raw of rows) {
    const id = String(raw?.id ?? '');
    if (!id || seenRows.has(id)) { skipped += 1; continue; }
    seenRows.add(id);
    if (journal.get?.(id)) { skipped += 1; continue; }
    /** 整行照抄：`normRow()` 会认蛇形/驼峰两套字段名，保留全部状态 */
    if (journal.insertRaw?.({ ...raw, id })) insertedRows += 1;
    else skipped += 1;
  }

  return { facts: insertedFacts, journal: insertedRows, skipped };
}
