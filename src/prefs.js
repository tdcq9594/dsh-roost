/**
 * 用户态偏好：`personas/.prefs.json`。
 *
 * 和 `.catalog.json` 的区别
 * -------------------------
 * catalog 是**派生**的（内容变了就重算，丢了能重建）；
 * 这里存的是**用户自己的东西**：收藏、置顶、分组、使用次数、删除墓碑。
 * 丢了就真丢了，所以：
 *   · 写之前先备份成 `.prefs.bak`；
 *   · 一键更新（sync）**永远不碰这个文件**。
 *
 * 为什么不做成 `.synced.json` 的一部分：那个文件按 id 记「上次同步时的 sha」，
 * 每次同步都会整份重写；把偏好混进去，迟早被某次同步顺手清掉。
 */

import {
  readFileSync, writeFileSync, mkdirSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';

const SCHEMA = 1;

/** 缺字段时按这个补。数组/对象都给新实例，别让调用方改到常量 */
function empty() {
  return {
    schema: SCHEMA,
    deleted: [],      // 删掉的内置人格 id（seed 跳过它们）
    fav: [],          // 收藏
    pinned: [],       // 置顶
    folders: {},      // { 分组名: [id] }，虚拟分组，不落磁盘目录
    usage: {},        // { id: { lastUsedAt, useCount } }
    installedAs: {},  // { repoId: localId }，撞名改名安装时用
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const asArr = (v) => (Array.isArray(v) ? v : []);

/**
 * @param {object} opts
 * @param {() => string} opts.dir  人格目录（`<数据目录>/personas`）
 * @param {(m: string) => void} [opts.log]
 */
export function createPrefs({ dir, log = () => {} }) {
  const file = () => join(dir(), '.prefs.json');
  const bak = () => join(dir(), '.prefs.bak');

  function normalize(j) {
    const base = empty();
    if (!isObj(j)) return base;
    return {
      schema: SCHEMA,
      deleted: [...new Set(asArr(j.deleted).map(String))],
      fav: [...new Set(asArr(j.fav).map(String))],
      pinned: [...new Set(asArr(j.pinned).map(String))],
      folders: isObj(j.folders) ? j.folders : {},
      usage: isObj(j.usage) ? j.usage : {},
      installedAs: isObj(j.installedAs) ? j.installedAs : {},
    };
  }

  /**
   * 读。坏了返回默认值，**不抛错**——偏好丢了顶多收藏没了，
   * 抛出去会让插件起不来，代价不对等。
   */
  function read() {
    try {
      return normalize(JSON.parse(readFileSync(file(), 'utf8')));
    } catch {
      return empty();
    }
  }

  /**
   * 整份写。写之前把旧文件复制成 `.prefs.bak`（只留一份，够回滚一次）。
   */
  function save(next) {
    const clean = normalize(next);
    try {
      mkdirSync(dir(), { recursive: true });
      /**
       * 只在旧文件**能解析**时才留备份。
       *
       * 无条件复制的话，一次损坏（写到一半断电、磁盘满）会把唯一的回滚副本
       * 盖成坏内容——`.bak` 本来是最后一道保险，不能跟着一起坏。
       */
      let prev = null;
      try { prev = readFileSync(file(), 'utf8'); } catch {}
      if (prev !== null) {
        try {
          JSON.parse(prev);
          writeFileSync(bak(), prev, 'utf8');
        } catch {}
      }
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
      renameSync(tmp, file());
    } catch (e) {
      log(`写人格偏好失败：${e.message}`);
    }
    return clean;
  }

  /**
   * 改几个键，其它不动。
   *
   * 数组是**整体替换**（收藏列表要么给你新的，要么别动），对象是**浅合并一层**
   * （`{usage:{a:…}}` 不会把 b 的记录冲掉）。
   */
  function patch(p) {
    const cur = read();
    const next = { ...cur };
    for (const [k, v] of Object.entries(p || {})) {
      if (isObj(v) && isObj(cur[k])) next[k] = { ...cur[k], ...v };
      else if (Array.isArray(v)) next[k] = v;
      else if (v !== undefined) next[k] = v;
    }
    return save(next);
  }

  return { read, save, patch, file, bak };
}
