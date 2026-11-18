/**
 * chatId → DSH 会话 的映射。
 *
 * 为什么一个 QQ 会话对应一个 DSH 会话：上下文天然隔离。
 * 张三在群里说的话不该出现在李四的私聊里，两个群的氛围也不一样。
 *
 * 存盘是必要的：DSH 重启后会话还在，映射丢了就等于所有人的上下文都断了。
 *
 * ## 为什么不是「直接 writeFileSync 整份」
 *
 * 这份文件至少有三种写者：
 *   1. 本进程的 `set()` / `remove()` / `patch()`
 *   2. 「一键改写 / 一键回退」（`rewrite.js`）——直接整份改写后调 `reload()`
 *   3. 用户手工编辑
 *
 * 原来的写法是「内存整份覆盖磁盘」，第 1 种和第 2 种撞上时后写的会把前一个抹掉；
 * 而且 `JSON.parse` 失败被 `catch {}` 吞掉，等于「文件损坏 → 内存当空 → 下次写盘
 * 把整个文件覆盖成空」，用户看到的是「所有人的上下文突然断了」，日志里一个字都没有。
 *
 * 现在的做法：写前重读磁盘做合并、原子替换、删除记墓碑、损坏先备份再降级。
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
import { dirname, join } from 'node:path';

/**
 * 墓碑的兜底存活时长。
 *
 * 正常路径下墓碑**落盘成功就清掉**（见 `save()`）；这个 TTL 只防「写盘一直失败时
 * 墓碑无限增长」，不是主要的失效机制。
 */
const TOMB_TTL_MS = 10 * 60 * 1000;

/** 损坏备份最多留几份：反复用同一个坏文件启动时别把目录堆满 */
const CORRUPT_KEEP = 3;

/**
 * 会话映射的键：`sessionKey` 是正解，缺了才退回 `chatId`。
 *
 * **手写的 chat 字面量常常漏 `sessionKey`**（主动搭话、巩固、自测、系统窗口
 * 都是这么写出来的）。少了它，`sessions.get(undefined)` 一律命中同一个键 ——
 * 落盘后键名就是字符串 `"undefined"`，于是「刷B站」「她的短记」「主动搭话」
 * 全挤在同一个 DSH 会话里：短记窗口里冒出主动搭话的整段提示词，就是这条路。
 *
 * 所以这里统一收口：谁都能少写，但到这里一定会变成唯一且稳定的键。
 */
export function chatSessionKey(chat) {
  return String(chat?.sessionKey || chat?.chatId || '').trim();
}

export function createSessions({ dataDir, log = () => {} }) {
  const file = join(dataDir, 'sessions.json');

  let map = { chats: {} };

  /**
   * chatId → 删除时刻。
   *
   * 只用来挡「写前合并」：`remove()` 之后磁盘上还有旧记录，合并时若不排除这个键，
   * 刚删掉的会话会被磁盘版本原样捞回来。
   *
   * **不拦显式 `set()`**——「清上下文」之后同一个会话必然要重新绑定，
   * 墓碑若连显式写入也拦，等于把「清上下文」变成「永久断链」。
   */
  const tombs = new Map();

  /**
   * 读磁盘，三态返回：
   *   - `null`      确实没有这个文件（首次启动）
   *   - `undefined` 文件在但坏了（解析失败 / 结构不对 / 读不动）
   *   - `object`    正常
   *
   * 三态是必须的：老写法把「没有」和「坏了」都当空，坏了的那次还会被下一次写盘
   * 覆盖成空文件，等于把还能人工抢救的数据直接删了。
   */
  function readDisk() {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      /** 只有 ENOENT 才是「确实没有」；EACCES / EIO 之类一律按「不清楚」处理 */
      return e.code === 'ENOENT' ? null : undefined;
    }
    try {
      const raw = JSON.parse(text);
      const ok =
        raw &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        raw.chats &&
        typeof raw.chats === 'object' &&
        !Array.isArray(raw.chats);
      return ok ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /** 坏文件先另存一份再降级：不备份的话，下一次写盘就把原文件彻底覆盖了 */
  function quarantine() {
    try {
      const bak = `${file}.corrupted.${Date.now()}`;
      copyFileSync(file, bak);
      /** 只留最近 CORRUPT_KEEP 份（文件名里是等长毫秒时间戳，字典序即时间序） */
      const olds = readdirSync(dirname(file))
        .filter((n) => n.startsWith('sessions.json.corrupted.'))
        .sort()
        .slice(0, -CORRUPT_KEEP);
      for (const n of olds) {
        try {
          unlinkSync(join(dirname(file), n));
        } catch {
          /* 删不掉就算了，不能因为清理失败把启动搞挂 */
        }
      }
      log(`会话映射损坏（解析失败或结构不对），已备份到 ${bak}`);
    } catch (e) {
      log(`会话映射损坏，备份也失败：${e.message}`);
    }
  }

  function load() {
    const disk = readDisk();
    if (disk === undefined) {
      quarantine();
      map = { chats: {} };
      return;
    }
    map = disk ?? { chats: {} };
  }
  load();

  function save() {
    const now = Date.now();
    /** TTL 兜底：写盘长期失败时别让 tombs 无限长 */
    for (const [k, ts] of tombs) if (now - ts > TOMB_TTL_MS) tombs.delete(k);

    try {
      mkdirSync(dirname(file), { recursive: true });

      const disk = readDisk();

      /**
       * **保留 `chats` 之外的顶层字段**。
       *
       * 扩展机制（v1.1.0 已落地）规划了往这份文件里加
       * `overrides[chatId]`。只写 `{ chats }` 会把它静默抹掉——而且是在
       * 「保存会话映射」这种看不出来会动配置的时机上抹掉。
       */
      const merged = { ...(disk && typeof disk === 'object' ? disk : {}), chats: {} };

      /** 磁盘打底：别的写者（一键改写/回退、手工编辑）新增的键不能被我们抹掉 */
      if (disk?.chats) {
        for (const [k, v] of Object.entries(disk.chats)) merged.chats[k] = v;
      }

      /**
       * 内存覆盖：这些键我们是权威。
       *
       * 注意**不能用真值判断**跳过——`host.js` 会 `set(chatId, '')` 建
       * 「只登记不绑定」的条目（空 sessionId 意味着下一条消息要新建会话），
       * 用 `if (v.sessionId)` 过滤会把这些条目在第一次写盘时全部丢掉。
       */
      for (const [k, v] of Object.entries(map.chats)) merged.chats[k] = v;

      /** 墓碑：显式删掉的键不许被磁盘上的旧版本复活 */
      for (const k of tombs.keys()) delete merged.chats[k];

      /** 随机 tmp 名：固定 `file + '.tmp'` 只防断电半文件，不防两个写者互盖 */
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
      renameSync(tmp, file);

      /**
       * **落盘成功就清墓碑**：墓碑的语义是「还没写下去的删除意图」，写完即失效。
       *
       * 不清的话，TTL 之内任何一次 `save()` 都会把这个键再从磁盘删一遍——
       * 另一个写者（面板 / 一键改写）刚合法重建的同名会话会被我们无声删掉。
       * 只有写盘失败（下面的 catch）才保留墓碑，留给下次重试。
       */
      tombs.clear();

      /**
       * **不把 merged 回写进 `map`**：`size` / `list()` 的语义是「本进程管过的会话」
       * （概览页的 `chats:` 统计的就是这个数）。回写会把它变成「文件里的条数」，
       * 把另一个写者新增的键也算进来。合并结果只用于落盘，不影响内存视图。
       */
    } catch (e) {
      log(`会话映射写盘失败：${e.message}`);
    }
  }

  /** 删一条内存记录 + 记墓碑。所有删除路径都必须走这里，否则会被写前合并捞回来 */
  function drop(chatId) {
    delete map.chats[chatId];
    tombs.set(chatId, Date.now());
  }

  return {
    /**
     * 重新读盘。
     *
     * 「一键改写 / 一键回退」会直接覆盖 `sessions.json`。这份映射在内存里
     * 是一份常驻副本，不重载的话下一次 `set()` 会把旧映射写回去，
     * 把刚恢复的文件盖掉。
     *
     * 这是**权威重置**：外部整份改写后磁盘就是真相，墓碑要一并清掉，
     * 否则旧墓碑会继续压制文件里刚写进来的键。
     */
    reload() {
      tombs.clear();
      load();
    },

    /** 取这个会话的 DSH 会话 id；没有就返回空串 */
    get(chatId, aliases = []) {
      const e = map.chats[chatId];
      if (e?.sessionId) return e.sessionId;
      /** 只绑定不改写时，旧会话还在旧 openid 键下面 */
      for (const k of Array.isArray(aliases) ? aliases : []) {
        const old = map.chats[k];
        if (old?.sessionId) return old.sessionId;
      }
      return '';
    },

    /** 整条记录（title/kind/preset），给「名字变了要改标题」用 */
    entry(chatId) {
      return map.chats[chatId] || null;
    },

    /**
     * 记下来。
     *
     * `kind` 是群/私聊（'group' / 'c2c'）。**必须有它**——
     * QQ 官方事件里群名是空的（只有 openid），取不到群名就回退成发消息那个人的昵称。
     * 结果群和私聊的 title 长得一模一样，面板上的会话下拉两行显示同一个名字，
     * 用户根本分不出哪个是群。存了 kind，前端就能标出「群」「私聊」。
     *
     * 第一行撤销墓碑是刻意的：显式绑定意味着「这个 chatId 现在要有记录了」，
     * 不能让之前的 `remove()` 继续压制它。
     */
    set(chatId, sessionId, { preset = '', title = '', kind = '' } = {}) {
      /**
       * **空键一律不写。** 写下去就会变成 `"undefined"` / `"null"` / `""` 这种
       * 谁都能命中的公共槽位，而症状（两个功能共用一个 DSH 会话）要到很久以后
       * 才看得出来。宁可这一轮不绑定，也不污染整份映射。
       */
      if (!chatId) {
        log(`sessions.set 收到空键（sessionId=${sessionId}，title=${title || '—'}），已忽略`);
        return;
      }
      tombs.delete(chatId);
      map.chats[chatId] = { sessionId: String(sessionId), preset, title, kind, at: Date.now() };
      save();
    },

    /** 丢掉映射（下一轮会新建会话）。DSH 那边的会话不会被删，只是不再关联 */
    remove(chatId) {
      drop(chatId);
      save();
    },

    /**
     * 只补字段，不动 sessionId。
     *
     * 为什么需要：早期版本 `set()` 没传 `title`，那些老映射的标题一直是空的，
     * 面板上就显示成一串 openid 短码（私聊尤其明显，因为群还有个群名兜着）。
     * 每次收到消息时顺手补一次，不用等用户手动清映射。
     */
    patch(chatId, fields = {}) {
      const e = map.chats[chatId];
      if (!e) return false;
      let dirty = false;
      for (const k of ['title', 'kind', 'preset']) {
        const v = fields[k];
        if (v && !e[k]) {
          e[k] = String(v);
          dirty = true;
        }
      }
      if (dirty) save();
      return dirty;
    },

    /** 取一条完整记录（没有就返回 null） */
    getEntry(chatId) {
      const e = map.chats[chatId];
      return e ? { chatId, ...e } : null;
    },

    /** 清掉映射里所有指向某个会话的记录（会话被删/失效时用） */
    forgetSession(sessionId) {
      let n = 0;
      for (const [chatId, e] of Object.entries(map.chats)) {
        if (e.sessionId === sessionId) {
          drop(chatId);
          n += 1;
        }
      }
      if (n) save();
      return n;
    },

    get size() {
      return Object.keys(map.chats).length;
    },

    /** 给面板看 */
    list() {
      return Object.entries(map.chats).map(([chatId, e]) => ({ chatId, ...e }));
    },
  };
}
