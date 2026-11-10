/**
 * 扩展记忆：独立目录分文件（方案 §5.1 / 实施阶段 4.1）。
 *
 * `<dataDir>/ext-memory/<extId>.json`，一个扩展一个文件：
 *   `{ version:1, rows:[{ text, w, at, until, src, expiredBy }], meta:{ archivedAt?, onClear?, maxRows? } }`
 *
 * 三条硬约束：
 *  1. **`.<extId>.<rand>.tmp` + rename 原子写**，绝不用固定 `.tmp` 名 ——
 *     `/v1/memory/ext.add` 与模型 `ext_memory_note` 同 extId 并发时会撞临时文件；
 *  2. 同一 extId 的「读 → 改 → 写」走**进程内串行队列**（`withQueue`），否则
 *     两个写各读一份旧数据、后写覆盖前写，条目静默丢失；
 *  3. 读坏按空文件处理并记 warn（fail-open —— 这是记忆不是权限，不能因为一个
 *     坏 JSON 让整个 QQ 会话不回话）。
 *
 * `listRanked()` 不会读本目录（§5.2）：扩展记忆**默认全局可调取但不自动注入**，
 * 只在 `ext_memory_search` 被模型主动调用时按需进候选池（`recall.js`）。
 * `memory.js` 的 9 处与 `backup.js:505` 一律不改（v3.4 已作废）。
 *
 * 零外部依赖；`dir` / `now` / `log` 可注入，测试不碰真实家目录。
 */

import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { dataDir } from './config.js';

export const EXT_MEMORY_DIR = 'ext-memory';
export const DEFAULT_MAX_ROWS = 200;
export const MAX_FILE_BYTES = 256 * 1024;
const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

const bytesOf = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

function emptyData() {
  return { version: 1, rows: [], meta: {} };
}

/** 读坏 fail-open：返回空数据 + warn，绝不抛给会话。 */
function readData(file, log, label) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rows)) return emptyData();
    return {
      version: 1,
      rows: raw.rows.filter((r) => r && typeof r === 'object'),
      meta: raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta) ? raw.meta : {},
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') log.warn?.(`扩展记忆 ${label} 读坏，按空处理：${e?.message ?? e}`);
    return emptyData();
  }
}

/**
 * 按 w 淘汰，但**未超限时不重排**：每轮 add 都全量排序会把插入顺序打乱，
 * 面板按时间看记忆时就会莫名其妙。`at` 一律原样保留。
 */
function trimRows(rows, maxRows) {
  const cap = Math.max(1, maxRows);
  if (rows.length <= cap && bytesOf(JSON.stringify({ version: 1, rows, meta: {} })) <= MAX_FILE_BYTES) {
    return rows;
  }
  const byWeight = [...rows].sort((a, b) => (Number(b.w) || 0) - (Number(a.w) || 0));
  const keep = new Set(byWeight.slice(0, cap));
  let out = rows.filter((r) => keep.has(r));
  while (out.length > 1 && bytesOf(JSON.stringify({ version: 1, rows: out, meta: {} })) > MAX_FILE_BYTES) {
    out = out.slice(0, out.length - 1);
  }
  return out;
}

export function createExtMemoryStore({ dir = dataDir(), log = () => {}, now = () => Date.now() } = {}) {
  const root = join(dir, EXT_MEMORY_DIR);
  /** extId -> 该扩展写队列的最后一个 Promise */
  const queues = new Map();

  const fileOf = (id) => join(root, `${id}.json`);
  const validId = (id) => {
    if (!EXT_ID_RE.test(String(id ?? ''))) throw new Error(`扩展 id 不合法：${id}`);
    return String(id);
  };

  function withQueue(id, fn) {
    const key = validId(id);
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    const cleanup = () => { if (queues.get(key) === next) queues.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  }

  function writeAtomic(id, data) {
    fs.mkdirSync(root, { recursive: true });
    // 随机后缀是并发安全的关键，不是装饰（§5.1:488）。
    const tmp = join(root, `.${id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    const text = `${JSON.stringify(data, null, 2)}\n`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, fileOf(id));
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 已不存在 */ }
      throw e;
    }
  }

  function ids() {
    let names;
    try { names = fs.readdirSync(root); } catch { return []; }
    return names.filter((n) => n.endsWith('.json') && !n.startsWith('.') && EXT_ID_RE.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5)).sort();
  }

  /** 检索可见行：archived / 已过期的行一律不参与（§5.7 / §5.1 `expire()`）。 */
  function visibleRows(data, { includeArchived = false } = {}) {
    if (!includeArchived && data.meta.archivedAt) return [];
    // 提一次：注入的 now() 若不稳定，逐行取会让同一批行的过期判定不一致。
    const t = now();
    return data.rows.filter((r) => !r.expiredBy && !(r.until && Number(r.until) < t));
  }

  return {
    root,
    fileOf,
    ids,
    /** 单扩展可读行。 */
    list(id, opts = {}) {
      const key = validId(id);
      return visibleRows(readData(fileOf(key), log, key), opts);
    },
    /** 全部扩展的可读行，只供 `ext_memory_search` 按需用，不参与自动注入。 */
    listAll(opts = {}) {
      const out = [];
      for (const id of ids()) {
        const data = readData(fileOf(id), log, id);
        out.push({ extId: id, rows: visibleRows(data, opts), meta: data.meta });
      }
      return out;
    },
    /**
     * 追加 + 去重：同 extId 同正文视为同一条，命中就 `w+1`。
     * 整个读改写都在该 extId 的队列里，两个写入口并发不会丢更新。
     */
    add(id, { text, src = '', at = now(), w = 1, until = 0 } = {}) {
      const key = validId(id);
      const body = String(text ?? '').trim();
      if (!body) return Promise.resolve({ ok: false, reason: '空记忆' });
      return withQueue(key, () => {
        const data = readData(fileOf(key), log, key);
        const dup = data.rows.find((r) => String(r.text) === body && !r.expiredBy);
        if (dup) {
          dup.w = (Number(dup.w) || 0) + 1;
          dup.at = at;
          if (until) dup.until = until;
        } else {
          data.rows.push({ text: body.slice(0, 500), w: Number.isFinite(Number(w)) ? Number(w) : 1, at, until, src: src || `ext:${key}` });
        }
        const maxRows = Math.max(1, Number(data.meta.maxRows) || DEFAULT_MAX_ROWS);
        data.rows = trimRows(data.rows, maxRows);
        // 单文件超 256 KB 先压缩（trimRows 已按 w 保高弃低），再落盘。
        while (data.rows.length > 1 && bytesOf(JSON.stringify(data)) > MAX_FILE_BYTES) {
          data.rows = data.rows.slice(0, data.rows.length - 1);
        }
        writeAtomic(key, data);
        return { ok: true, extId: key, total: data.rows.length, deduped: !!dup };
      });
    },
    remove(id, predicate) {
      const key = validId(id);
      if (typeof predicate !== 'function') return Promise.resolve({ ok: false, reason: '缺删选条件' });
      return withQueue(key, () => {
        const data = readData(fileOf(key), log, key);
        const before = data.rows.length;
        data.rows = data.rows.filter((r) => !predicate(r));
        writeAtomic(key, data);
        return { ok: true, extId: key, removed: before - data.rows.length };
      });
    },
    /** 面板「扩展记忆」分组：删单文件。 */
    clear(id) {
      const key = validId(id);
      return withQueue(key, () => {
        try { fs.rmSync(fileOf(key), { force: true }); } catch { /* 已删 */ }
        return { ok: true, extId: key };
      });
    },
    /**
     * 全局清空（§5.6）：默认**清空 ext-memory/*.json，但尊重 onClear:'keep'**。
     * `respectOnClear:false` 时强制全清（面板「彻底删」可显式传）。
     */
    async clearAll({ respectOnClear = true } = {}) {
      const all = ids();
      // 每个 id 都排进自己的写队列：否则「全局清空」和并发的 add 竞争时，
      // pending 写会在清空完成后把整个命名空间重建出来（复核实跑复现）。
      const jobs = all.map((id) => withQueue(id, () => {
        const data = readData(fileOf(id), log, id);
        if (respectOnClear && (data.meta.onClear ?? 'keep') === 'keep') return 0;
        try { fs.rmSync(fileOf(id), { force: true }); return 1; } catch { return 0; }
      }));
      const results = await Promise.all(jobs);
      const cleared = results.reduce((a, b) => a + b, 0);
      return { ok: true, cleared, kept: all.length - cleared };
    },
    /** 与 D11 同语义：过期的行标 expiredBy，不物理删，面板可回溯。 */
    async expire(at = now()) {
      const jobs = ids().map((id) => withQueue(id, () => {
        const data = readData(fileOf(id), log, id);
        let n = 0;
        for (const r of data.rows) {
          if (!r.expiredBy && r.until && Number(r.until) < at) { r.expiredBy = 'expire'; n++; }
        }
        if (n) writeAtomic(id, data);
        return n;
      }));
      const counts = await Promise.all(jobs);
      return { ok: true, expired: counts.reduce((a, b) => a + b, 0) };
    },
    /** 卸载扩展不等于清记忆：标 archivedAt，之后不参与检索（§5.7）。 */
    archive(id) {
      const key = validId(id);
      return withQueue(key, () => {
        const data = readData(fileOf(key), log, key);
        data.meta.archivedAt = now();
        writeAtomic(key, data);
        return { ok: true, extId: key, archivedAt: data.meta.archivedAt };
      });
    },
    setMeta(id, patch = {}) {
      const key = validId(id);
      return withQueue(key, () => {
        const data = readData(fileOf(key), log, key);
        data.meta = { ...data.meta, ...patch };
        writeAtomic(key, data);
        return { ok: true, extId: key, meta: data.meta };
      });
    },
    stats() {
      const out = {};
      for (const id of ids()) {
        let bytes = 0;
        try { bytes = fs.statSync(fileOf(id)).size; } catch { /* 已删 */ }
        const data = readData(fileOf(id), log, id);
        out[id] = {
          rows: visibleRows(data).length, totalRows: data.rows.length, bytes,
          archivedAt: data.meta.archivedAt ?? null,
          onClear: data.meta.onClear ?? 'keep',
          maxRows: Number(data.meta.maxRows) || DEFAULT_MAX_ROWS,
        };
      }
      return out;
    },
  };
}
