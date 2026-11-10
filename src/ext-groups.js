/**
 * 影子权限组（方案 §4.2 / 实施阶段 1.3）。
 *
 * `capabilities.json` **不存在**时，安装扩展绝不能创建它 —— 那等于替用户
 * 启用能力页，把「全放开」切成白名单，与「默认全局可调取」正好相反。
 * 所以这份 `ext-groups.json` 是纯声明，不参与运行期判定；等用户在面板点
 * 「启用能力页」时，由 `host.js` 的 `capabilities.init` handler 把它合进
 * `init(seed)` 的 seed（**主落点，见 §10.9 的 21/21 实证**）。
 *
 * 双写一致性（§4.2）：
 *   · 安装期文件锁，30s 未释放视为 stale 可抢占；
 *   · 启用时校验所有 `group:ext_*` 引用都有定义，缺了报悬空组而不是静默丢权限；
 *   · 备份还原只带回其中一个文件时，以用户手改的 `capabilities.json` 为准，
 *     影子组**只补缺失项**、绝不覆盖用户收紧过的配置。
 */

import fs from 'node:fs';
import { join } from 'node:path';

import { dataDir } from './config.js';
import { extensionsDir } from './ext-registry.js';

export const GROUPS_FILE = 'ext-groups.json';
export const LOCK_FILE = '.ext-groups.lock';
export const STALE_MS = 30_000;

function emptyState() {
  return { version: 1, groups: {}, memberAllow: [], adminAllow: [] };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

const groupKey = (id) => `ext_${id}`;
const groupRef = (id) => `group:ext_${id}`;

export function createExtGroups({ dir = dataDir(), log = () => {} } = {}) {
  const root = extensionsDir(dir);
  const file = join(root, GROUPS_FILE);
  const lockFile = join(dir, LOCK_FILE);

  function read() {
    const raw = readJson(file);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
    return {
      version: 1,
      groups: raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups) ? raw.groups : {},
      memberAllow: Array.isArray(raw.memberAllow) ? raw.memberAllow.filter((x) => typeof x === 'string') : [],
      adminAllow: Array.isArray(raw.adminAllow) ? raw.adminAllow.filter((x) => typeof x === 'string') : [],
    };
  }

  function writeUnlocked(state) {
    fs.mkdirSync(root, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return state;
  }

  /** 同步文件锁：`wx` 独占创建；stale 可抢占；持锁区间只包读→合并→写。 */
  function withLock(fn) {
    fs.mkdirSync(dir, { recursive: true });
    // nonce 用来认自己的锁：被别人判 stale 抢占后，finally 不能删掉新持锁者的锁。
    const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let got = false;
    for (let i = 0; i < 30 && !got; i++) {
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), nonce }), { flag: 'wx' });
        got = true;
      } catch (e) {
        if (e?.code !== 'EEXIST') throw e;
        const prev = readJson(lockFile);
        if (!prev || !Number.isFinite(prev.at) || Date.now() - prev.at > STALE_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
        const until = Date.now() + 20;
        while (Date.now() < until) { /* 同步短等，不引依赖 */ }
      }
    }
    if (!got) throw new Error('拿不到 .ext-groups.lock（并发安装太多）');
    try {
      return fn();
    } finally {
      const cur = readJson(lockFile);
      if (cur?.nonce === nonce) fs.rmSync(lockFile, { force: true });
    }
  }

  /** 给 seed / 已启用策略用的三个片段。 */
  function seedParts() {
    const s = read();
    return { groups: { ...s.groups }, memberAllow: [...s.memberAllow], adminAllow: [...s.adminAllow] };
  }

  /**
   * 安装一个扩展：写影子组，并在 `capabilities.json` 已存在时**只追加**。
   * 不传 capStore 就只写影子文件（阶段 1 的纯逻辑用法）。
   */
  function add(id, { label = '', capStore = null, adminTools = ['ext_memory_note'] } = {}) {
    if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new Error(`扩展 id 不合法：${id}`);
    return withLock(() => {
      const s = read();
      s.groups[groupKey(id)] = { match: [`mcp__${id}__*`], label: label || id };
      for (const ref of [groupRef(id)]) if (!s.memberAllow.includes(ref)) s.memberAllow.push(ref);
      for (const t of adminTools) if (!s.adminAllow.includes(t)) s.adminAllow.push(t);
      writeUnlocked(s);
      if (capStore?.enabled?.()) syncToCapabilities(capStore, s);
      return s;
    });
  }

  /** 卸载：按 `ext_<id>` 精确移除，不误删用户手写的同名项。 */
  function remove(id, { capStore = null } = {}) {
    return withLock(() => {
      const s = read();
      /** 只认 `add()` 真正写进去过的字面工具名，不按前缀扫用户的配置。 */
      const priorAdminTools = [...s.adminAllow];
      delete s.groups[groupKey(id)];
      s.memberAllow = s.memberAllow.filter((x) => x !== groupRef(id));
      /**
       * `ext_memory_note` 是宿主工具，多个扩展共用一份写权限。
       * 只在**最后一个扩展卸完**时清掉，否则卸掉其中一个会让剩下的扩展
       * 也写不了记忆。§4.2:428 要求「卸载不留悬空配置」，落到这里就是这个语义。
       */
      const lastOne = Object.keys(s.groups).length === 0;
      if (lastOne) s.adminAllow = [];
      writeUnlocked(s);
      if (capStore?.enabled?.()) {
        const cur = capStore.get();
        const groups = { ...cur.groups };
        delete groups[groupKey(id)];
        const defaults = { ...cur.defaults };
        /**
         * 两条硬约束（第二轮独立复核抓到过，别再改回去）：
         *  1. **只碰本来就有 `allow` 数组的档**。`manager` / `helper` 的 `{}`
         *     表示「继承低档」，写成 `{allow:[]}` 会断链、权限静默清零，
         *     而且 `capStore.write()` 会把 `[]` 原样持久化，重启也不恢复。
         *  2. **只删确切字面名**，不用 `/^ext_/` 前缀 —— 用户手写的
         *     `ext_my_custom_tool` 和方案预留的 `ext_memory_search` 都不能被
         *     扩展卸载顺手删掉。
         */
        if (Array.isArray(defaults.member?.allow)) {
          defaults.member = {
            ...defaults.member,
            allow: defaults.member.allow.filter((x) => x !== groupRef(id)),
          };
        }
        if (Array.isArray(defaults.admin?.allow)) {
          const drop = new Set([groupRef(id), ...(lastOne ? priorAdminTools : [])]);
          defaults.admin = {
            ...defaults.admin,
            allow: defaults.admin.allow.filter((x) => !drop.has(x)),
          };
        }
        capStore.patch({ groups, defaults });
      }
      return s;
    });
  }

  /** 已启用时双写：只追加组和引用，不覆盖用户手改项。 */
  function syncToCapabilities(capStore, state = read()) {
    const cur = capStore.get();
    const groups = { ...state.groups, ...cur.groups }; // 用户手改优先
    const defaults = { ...cur.defaults };
    const append = (bucket, items) => {
      const one = defaults[bucket] || {};
      const allow = Array.isArray(one.allow) ? [...one.allow] : [];
      for (const x of items) if (!allow.includes(x)) allow.push(x);
      defaults[bucket] = { ...one, allow };
    };
    append('member', state.memberAllow);
    append('admin', state.adminAllow);
    capStore.patch({ groups, defaults });
    return capStore.get();
  }

  /** 悬空引用检查：有 `group:ext_*` 却缺定义 = 启用后静默丢权限。 */
  function validateReferences(store) {
    const missing = [];
    if (!store?.defaults) return { ok: true, missing };
    for (const [bucket, one] of Object.entries(store.defaults)) {
      for (const item of Array.isArray(one?.allow) ? one.allow : []) {
        if (typeof item === 'string' && item.startsWith('group:ext_')) {
          const key = item.slice('group:'.length);
          if (!store.groups || !store.groups[key]) missing.push(`${bucket}: ${item}`);
        }
      }
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * 备份还原后的对账：以 `capabilities.json` 为准，影子组只补缺失项。
   * 返回可直接交给 `capStore.patch()` 的顶层对象；没有缺失就返回 null（不写盘）。
   */
  function reconcile(store) {
    const s = read();
    if (!Object.keys(s.groups).length && !s.memberAllow.length && !s.adminAllow.length) return null;
    const patchObj = {};
    let changed = false;

    const groups = { ...(store.groups || {}) };
    for (const [k, v] of Object.entries(s.groups)) {
      if (!Object.hasOwn(groups, k)) { groups[k] = v; changed = true; }
    }
    if (changed) patchObj.groups = groups;

    const defaults = { ...(store.defaults || {}) };
    const append = (bucket, items) => {
      const one = defaults[bucket] || {};
      const allow = Array.isArray(one.allow) ? [...one.allow] : [];
      let dirty = false;
      for (const x of items) if (!allow.includes(x)) { allow.push(x); dirty = true; }
      if (dirty) { defaults[bucket] = { ...one, allow }; patchObj.defaults = defaults; changed = true; }
    };
    append('member', s.memberAllow);
    append('admin', s.adminAllow);

    return changed ? patchObj : null;
  }

  return { dir, file, lockFile, read, seedParts, add, remove, syncToCapabilities, validateReferences, reconcile, withLock };
}
