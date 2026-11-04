/**
 * `capabilities.json` 的读写。
 *
 * 三件事，都围绕「别让配置文件把机器人弄坏」：
 *   · **不存在就不启用**——老用户装上新版本，行为必须和以前一模一样。
 *   · 读坏了退回默认值，不抛（策略文件是用户可以手改的）。
 *   · 每轮观察 pool，但**只有真变化时才落盘**（热路径不做无谓 IO）。
 *
 * 纯逻辑在 `capabilities.js`，这里只负责文件和缓存。
 */

import fs from 'node:fs';
import { join } from 'node:path';

import { normalizeStore, defaultStore, diffSeen, touchSeen } from './capabilities.js';

export function createCapabilityStore({ dir, log = () => {} }) {
  const file = join(dir, 'capabilities.json');

  /** @type {{raw:object|null, mtime:number}} */
  let cache = { raw: null, mtime: -1 };
  /** 本次进程里新看到、还没被面板消费的工具名 */
  let pending = { added: [], gone: [] };

  function statMtime() {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return -1;
    }
  }

  function readRaw() {
    const m = statMtime();
    if (m < 0) {
      cache = { raw: null, mtime: -1 };
      return null;
    }
    if (cache.raw && cache.mtime === m) return cache.raw;

    try {
      const txt = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(txt);
      cache = { raw: obj && typeof obj === 'object' ? obj : null, mtime: m };
      return cache.raw;
    } catch (e) {
      log.warn?.(`capabilities.json 读不动（按默认策略跑）：${e?.message || e}`);
      cache = { raw: null, mtime: m };
      return null;
    }
  }

  /**
   * 启用的判据是**文件存在**，不是配置项。
   *
   * 这样老用户升级后什么都不用做：没有这个文件 → 完全走旧逻辑 →
   * 行为与升级前一致。要在面板上点「启用」时才创建文件。
   */
  function enabled() {
    return statMtime() >= 0;
  }

  /** 规范化后的策略；文件不存在时返回默认值（但调用方应先用 enabled() 判断） */
  function get() {
    return normalizeStore(readRaw());
  }

  function write(store) {
    const tmp = `${file}.tmp`;
    const body = JSON.stringify(normalizeStore(store), null, 2) + '\n';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    cache = { raw: JSON.parse(body), mtime: statMtime() };
    return normalizeStore(cache.raw);
  }

  /** 开一份新的：以当前 raw（可能没有）为基线，写盘即启用 */
  function init(seed = null) {
    if (enabled()) return get();
    const base = seed && typeof seed === 'object' ? { ...defaultStore(), ...seed } : defaultStore();
    return write(base);
  }

  /**
   * 增量改。`patch` 是浅合并（顶层键），深层改动由调用方给完整子对象。
   * 不做深合并是故意的：`defaults.member.allow` 这种数组合并语义说不清，
   * 让调用方传完整值，比猜它的意图安全。
   */
  function patch(patchObj = {}) {
    const cur = get();
    const next = { ...cur, ...patchObj };
    return write(next);
  }

  /**
   * 每轮观察一次 pool：更新 `seen`，算出「新增 / 失效」。
   *
   * 只在真的出现变化时才落盘——群聊一轮几百毫秒，没必要为了没变的东西写文件。
   * 返回值给调用方打日志用，不参与决策。
   */
  function observe(pool = [], now = Date.now()) {
    if (!enabled()) return { added: [], gone: [], skipped: true };
    if (!Array.isArray(pool) || !pool.length) return { added: [], gone: [], skipped: true };

    const cur = get();
    const d = diffSeen(cur.seen?.tools, pool);

    /**
     * 第一次（`seen` 空）：只写基线，**不报新增**。
     *
     * 少了这一步会两头错：不写基线 → 永远停在「第一次」，以后新增一个也报不出来；
     * 报了新增 → 老用户一升级就弹「新增 34 个能力」。
     */
    if (!d.initialized) {
      try {
        write({
          ...cur,
          seen: { ...cur.seen, tools: touchSeen(cur.seen?.tools, pool, now), lastScan: now },
        });
      } catch (e) {
        log.warn?.(`capabilities.json 写不动：${e?.message || e}`);
      }
      return { added: [], gone: [], baseline: true };
    }

    const added = d.added;
    const gone = d.gone;

    if (added.length || gone.length) {
      pending = {
        added: [...new Set([...pending.added, ...added])],
        gone: [...new Set([...pending.gone, ...gone])],
      };
    }

    /**
     * **新增和失效都要落盘**。
     *
     * 2026-11-05 之前这里只判 `added.length`，`gone` 只进内存里的 `pending`。
     * 后果是 `seen` 里那个键永远不删，于是下一轮又算出同一个 `gone`，
     * 再塞回 `pending` —— 用户点「我知道了」清空，说一句话又冒出来，
     * 永远清不掉。
     *
     * 代价：如果某个工具只是**临时**没挂上（插件重载中途），删掉快照后
     * 它回来时会报一次「新增」。这个方向可以接受——多报一次新增无害，
     * 而「永远清不掉的失效提示」会让人直接无视整条提示栏。
     */
    if (added.length || gone.length) {
      const tools = { ...(cur.seen?.tools || {}) };
      for (const n of gone) delete tools[n];
      const next = {
        ...cur,
        seen: { ...cur.seen, tools: touchSeen(tools, pool, now), lastScan: now },
      };
      try {
        write(next);
      } catch (e) {
        log.warn?.(`capabilities.json 写不动：${e?.message || e}`);
      }
    }

    return { added, gone };
  }

  /** 面板读一次就走，读完整包（含 pending） */
  function snapshot() {
    const store = get();
    const out = { enabled: enabled(), store, pending: { added: [...pending.added], gone: [...pending.gone] } };
    pending = { added: [], gone: [] };
    return out;
  }

  /** 面板上「我看到了」——清 pending，不改策略 */
  function ack() {
    pending = { added: [], gone: [] };
    return { ok: true };
  }

  return { file, enabled, get, init, patch, write, observe, snapshot, ack };
}
