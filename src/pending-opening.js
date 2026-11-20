/**
 * 压缩开场的持久化暂存。
 *
 * 为什么需要：`compact.js` 的顺序是「建新会话 → 落映射 → 交开场」。
 * 映射落在 `sessions.json`（持久），开场原来只放在 `host.js` 的内存 Map
 * （`pendingOpening`）。如果进程在两者之间退出——重启、崩溃、面板重载——
 * 映射已经指向新会话，开场却没了：下一条消息进新窗口，模型没有
 * 「接着上面聊」的上下文，表现就是「她突然失忆」。
 *
 * 所以开场要跟映射一样落盘，并且**消费即删**：它是短命的交接条，
 * 不是记忆。留 24 小时是兜底（压缩后一直没人说话），过期就丢。
 *
 * 文件独立于 `sessions.json`：映射文件会被一键改写/回退、面板读取，
 * 往里塞聊天正文既扩大隐私面，也容易被别的写者覆盖。
 *
 * ## 盘上**只存指针**（2026-11 改）
 *
 * 开场正文是 `makeOpening()` 从日记（`journal.recent` / `digests`）+ 约定
 * **确定性重建**出来的，不是模型输出，所以盘上没必要再存一份：
 *
 *     { "version": 2, "chats": { "<chatId>": { "at": 1712345678901 } } }
 *
 * 两个原因：
 *   1. **隐私面**。以前 `opening-pending.json` 和 `.corrupted.*` 备份里都有
 *      最近几条原话的摘要。用户「清空记忆」把日记抹掉之后，这些文件还留着
 *      一份聊天片段，最多留 24 小时（备份 7 天）——那是个真的漏。
 *      存指针之后，日记一清，重建自然为空。
 *   2. **不重复**。同一段话在日记里已经有一份，再复制到第二个文件、再复制到
 *      备份里，只是让「删干净」变难。
 *
 * 代价：重启后拼出来的开场与压缩那一刻**不是逐字相同**（这几天新说的话会
 * 一起进去）。这不影响「接着上面聊」的语义，反而更新。
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';

/** 同时最多暂存几条：正常只会有一两条，50 是防异常路径无限堆 */
const MAX_ENTRIES = 50;

/** 未消费的兜底存活时长：压缩后一天没人说话，开场已经没有意义了 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** 损坏备份最多留几份 */
const CORRUPT_KEEP = 3;

/** 盘上格式版本。1（带 `text`）仍能读，读进来只留 `at` */
const DISK_VERSION = 2;

/**
 * @param {object} o
 * @param {string} o.file
 * @param {(m: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {(chatId: string, entry: { at: number }) => string} [o.rebuild]
 *   重启后拿不到内存里的正文时用它重建（`compact.js` 的 `makeOpening()`）。
 *   抛错按「没有开场」处理——宁可少一段开场，也不能让收消息的路径炸掉。
 */
export function createPendingOpenings({
  file,
  log = () => {},
  now = () => Date.now(),
  rebuild = null,
} = {}) {
  /**
   * chatId → { text?, at }。
   *
   * `text` **只在内存里**（本次进程 `set` 过的那些）；从盘上读回来的条目
   * 只有 `at`，正文靠 `rebuild` 现拼。
   *
   * **必须无原型**：`{}` 上的 `__proto__` 是 setter，`set('__proto__', x)`
   * 会改掉原型而不是落一条记录——`size` 仍是 0，但 `get('__proto__')`
   * 又能从原型链上读回 payload，等于一个不落盘、也删不掉的幽灵条目。
   */
  let map = Object.create(null);
  /**
   * 读盘遇到 ENOENT 之外的错误（EACCES/EISDIR/IO）时置位。
   *
   * 这时**不能**把 map 当空、更不能让下一次 set 用空表覆盖整份文件：
   * 一次瞬时读故障就会把所有待交开场抹掉。宁可这一轮不写，等下次启动恢复。
   */
  let ioFailed = false;

  function readDisk() {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      ioFailed = true;
      return undefined;
    }
    try {
      const raw = JSON.parse(text);
      const ok =
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        raw.chats &&
        typeof raw.chats === 'object' &&
        /** 数组也是 object：漏了它会让 map 变成数组，字符串键被 JSON.stringify 丢弃 */
        !Array.isArray(raw.chats);
      return ok ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /** 坏文件先备份再降级：不能让下一次写盘把还能抢救的内容覆盖掉 */
  function quarantine() {
    try {
      const bak = `${file}.corrupted.${Date.now()}`;
      copyFileSync(file, bak);
      const prefix = `${basename(file)}.corrupted.`;
      const all = readdirSync(dirname(file))
        .filter((n) => n.startsWith(prefix))
        .sort();
      /**
       * 备份也要有 TTL：只限份数的话，一个反复损坏的文件会每月留下 3 份，
       * 一年就是 36 份含聊天片段的小文件。超过 7 天的直接清掉。
       */
      const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
      for (const n of all) {
        const ts = Number(n.slice(prefix.length));
        if (Number.isFinite(ts) && ts >= cutoff) continue;
        try {
          unlinkSync(`${dirname(file)}/${n}`);
        } catch {
          /* 清理失败不能拦住启动 */
        }
      }
      const olds = readdirSync(dirname(file))
        .filter((n) => n.startsWith(prefix))
        .sort()
        .slice(0, -CORRUPT_KEEP);
      for (const n of olds) {
        try {
          unlinkSync(`${dirname(file)}/${n}`);
        } catch {
          /* 清理失败不能拦住启动 */
        }
      }
      log(`压缩开场暂存损坏，已备份到 ${bak}`);
    } catch (e) {
      log(`压缩开场暂存损坏，备份也失败：${e.message}`);
    }
  }

  function load() {
    const disk = readDisk();
    if (ioFailed) {
      /** 读不了不等于没有：保持空视图但禁止写，避免覆盖盘上还能救的内容 */
      map = Object.create(null);
      log('压缩开场暂存读取失败（非 ENOENT），本次不写入，等下次启动恢复');
      return;
    }
    if (disk === undefined) {
      quarantine();
      map = Object.create(null);
      return;
    }
    /**
     * 逐键拷进无原型对象，不能直接 `map = disk.chats`：
     * 那样从盘上读回的 `__proto__` 键又会变成原型链上的幽灵。
     *
     * **只取 `at`**：旧格式（v1）的条目里带 `text`，那是聊天原文，读进来
     * 就不再往外写了——下次 `save()` 落盘时自动瘦成指针，等于顺手做了迁移。
     */
    const next = Object.create(null);
    for (const [k, v] of Object.entries(disk?.chats ?? {})) {
      const at = Number(v?.at);
      next[k] = { at: Number.isFinite(at) ? at : 0 };
    }
    map = next;
  }

  /**
   * 取正文：内存里有就用内存的，没有就现拼。
   *
   * 重建抛错按「没有开场」处理——这条路径在收消息的主链路上，一段开场
   * 比不上「消息能正常回」重要。
   */
  function resolveText(chatId, entry) {
    if (entry && typeof entry.text === 'string') return entry.text;
    if (typeof rebuild !== 'function') return '';
    try {
      const t = rebuild(chatId, { at: Number(entry?.at) || 0 });
      return typeof t === 'string' ? t : '';
    } catch (e) {
      log(`压缩开场重建失败（按没有开场处理）：${e?.message ?? e}`);
      return '';
    }
  }

  /** 丢掉过期条目；返回是否有改动 */
  function prune() {
    const t = now();
    let dirty = false;
    for (const [k, v] of Object.entries(map)) {
      if (!v || t - Number(v.at || 0) > TTL_MS) {
        delete map[k];
        dirty = true;
      }
    }
    return dirty;
  }

  function save() {
    /** 读盘失败过：这一轮不写，避免用空表覆盖盘上还能救的内容 */
    if (ioFailed) return false;
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      /**
       * **只落指针**（`{ at }`），正文一律不上盘：见文件头「盘上只存指针」。
       * 这里显式重建一份 map，不要图省事直接 `JSON.stringify({ chats: map })`
       * ——那会把内存里的 `text` 一起写出去，等于把刚拆掉的隐私面又装回去。
       */
      const pointers = Object.create(null);
      for (const [k, v] of Object.entries(map)) pointers[k] = { at: Number(v?.at) || 0 };
      const body = JSON.stringify({ version: DISK_VERSION, chats: pointers }, null, 2);
      /** 随机 tmp 名：固定 `.tmp` 只防断电半文件，不防两个写者互盖 */
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, file);
      return true;
    } catch (e) {
      /** 失败要把 tmp 删掉，否则持续失败会在目录里堆一串半文件 */
      try {
        unlinkSync(tmp);
      } catch {
        /* 删不掉就算了，不能因为清理失败把主流程搞挂 */
      }
      log(`压缩开场暂存写盘失败：${e.message}`);
      return false;
    }
  }

  load();
  if (prune()) save();

  return {
    /** 记下开场（覆盖同会话的旧值） */
    set(chatId, text) {
      if (!chatId || !text) return;
      /**
       * **读盘失败也要写内存**：save() 会因 ioFailed 拒绝落盘，但本进程
       * 下一条消息还能拿到这段开场。直接 return 会让「读失败」升级成
       * 「当场失忆」——比改动前的纯内存 Map 更糟。
       */
      prune();
      map[chatId] = { text: String(text), at: now() };
      /** 超过上限先丢最旧的，防异常路径把盘撑大 */
      const keys = Object.keys(map);
      if (keys.length > MAX_ENTRIES) {
        keys
          .sort((a, b) => Number(map[a].at || 0) - Number(map[b].at || 0))
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach((k) => delete map[k]);
      }
      save();
    },

    /** 看一眼，不消费 */
    get(chatId) {
      if (prune()) save();
      const entry = map[chatId];
      return entry ? resolveText(chatId, entry) : '';
    },

    /**
     * 取走并删除。
     *
     * 先删内存再落盘：即使写盘失败，本进程也不会重复注入；
     * 重启后最多重复一次开场，比「开场丢了」可接受。
     *
     * 正文为空也照样删指针：留着一个拼不出内容的指针没有意义，下次还得
     * 白重建一遍。
     */
    take(chatId) {
      if (prune()) save();
      const entry = map[chatId];
      if (!entry) return '';
      const text = resolveText(chatId, entry);
      delete map[chatId];
      save();
      return text;
    },

    get size() {
      return Object.keys(map).length;
    },
  };
}
