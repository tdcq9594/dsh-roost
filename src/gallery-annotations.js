/**
 * 表情标注扩展（`sticker-reply`）的**只读**对接。
 *
 * 那个扩展用**内容 sha256 当键**，字段是 `name / meaning / tags / scenes /
 * avoid`——和我们图库的键与字段完全对得上，所以这一层不需要转换，只需要读。
 *
 * ## 为什么只读
 *
 * 那是**另一个进程**（框架插件）在写的文件。我们去写就等于两个进程抢同一份
 * JSON：各读各的副本、各自落盘，谁最后写谁赢，用户会看到标注随机丢失或回滚。
 * 图库的 index 才是这边的事实来源，这里只在「一张图还没有任何描述」时补位。
 *
 * ## 路径
 *
 * 按 DSH 的数据根推，三个候选依次试（第一个能读到整份 JSON 的胜出）：
 *
 *   1. `ROOST_LAUNCHER_DIR` 的上一级 —— 扩展自己就是这么算的
 *      （`sticker-reply/lib/shared.mjs:dshDataDir`），最可信；
 *   2. roost 数据目录的上一级 —— 默认 `~/.dsh/dsh-roost` → `~/.dsh`；
 *   3. `~/.dsh` 兜底 —— 环境变量都没设时（手动跑、单测）。
 *
 * 全都读不到就静默返回空表：**没装那个扩展是常态**，不该在日志里喊。
 * 文件坏了也只记一行：它自己会在下次写入时备份并重建，轮不到我们操心。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 扩展 id = 它在 `extension-data/` 下的目录名 */
export const EXTERNAL_EXT_ID = 'sticker-reply';

/** 字段白名单：只取我们认识的，扩展以后加字段也不会漏进 index */
const FIELDS = Object.freeze(['name', 'meaning', 'tags', 'scenes', 'avoid']);

/**
 * 候选路径（去重、保序）。
 *
 * @param {{launcherDir?:string, roostDataDir?:string}} [o]
 * @returns {string[]}
 */
export function externalAnnotationPaths({ launcherDir = '', roostDataDir = '' } = {}) {
  const roots = [];
  const launch = String(launcherDir || '').trim();
  if (launch) roots.push(dirname(launch));
  const rd = String(roostDataDir || '').trim();
  if (rd) roots.push(dirname(rd));
  roots.push(join(homedir(), '.dsh'));

  const out = [];
  for (const r of roots) {
    const p = join(r, 'extension-data', EXTERNAL_EXT_ID, 'annotations.json');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** 值归一：字符串截断、数组只留字符串、对象一律丢掉 */
function pick(ann) {
  const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const tags = Array.isArray(ann?.tags)
    ? ann.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 24)).slice(0, 8)
    : [];
  return {
    name: s(ann?.name, 60),
    meaning: s(ann?.meaning, 300),
    tags,
    scenes: s(ann?.scenes, 200),
    avoid: s(ann?.avoid, 200),
  };
}

/**
 * 读扩展的标注表。
 *
 * @param {{paths?:string[], log?:Function}} [o]
 * @returns {{bySha: Map<string, object>, path: string}}
 *   `bySha` 的键是小写 sha256；`path` 是真正读到的那个文件（没读到为空串）。
 */
export function readExternalAnnotations({ paths = [], log = () => {} } = {}) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      /** 半个 JSON / 手改坏了：跳过。*别*顺手删它——那是人家的数据 */
      log(`表情标注扩展的文件读不了（${p}）：${e?.message ?? e}`);
      continue;
    }
    const images = raw?.images;
    if (!images || typeof images !== 'object' || Array.isArray(images)) continue;

    const bySha = new Map();
    for (const [sha, ann] of Object.entries(images)) {
      /** 键必须是 64 位十六进制：扩展里还有以文件名为键的旧数据，混进来会串图 */
      if (!/^[0-9a-f]{64}$/i.test(sha)) continue;
      if (!ann || typeof ann !== 'object' || Array.isArray(ann)) continue;
      const row = pick(ann);
      /** 全空的记录没有价值，还会让图库误以为「这张已经有描述了」 */
      if (!row.name && !row.meaning && !row.tags.length && !row.scenes && !row.avoid) continue;
      bySha.set(sha.toLowerCase(), row);
    }
    return { bySha, path: p };
  }
  return { bySha: new Map(), path: '' };
}

/**
 * 给宿主用的便捷封装：路径算好、**按文件 mtime 缓存**。
 *
 * 图库同步是同步函数、每轮可能跑一次，每次都 readFileSync 一个几百 KB 的 JSON
 * 不划算。文件 mtime 没变就复用上次的结果；变了才重读。
 *
 * @param {{launcherDir?:string, roostDataDir?:string, log?:Function}} [o]
 * @returns {() => {bySha: Map<string, object>, path: string}}
 */
export function createExternalAnnotations({
  launcherDir = '', roostDataDir = '', log = () => {},
} = {}) {
  const paths = externalAnnotationPaths({
    launcherDir: launcherDir || process.env.ROOST_LAUNCHER_DIR,
    roostDataDir,
  });
  let cached = { bySha: new Map(), path: '' };
  let stamp = '';

  return function current() {
    /**
     * 指纹用 `mtimeMs + size`，**不要为了算指纹去把文件读一遍**——那就等于
     * 没缓存。`mtimeMs` 是毫秒级，扩展写完立刻读也能分辨。
     *
     * 还没找到文件时 stamp 留空，每次都会重试一遍候选（扩展可能刚装好）；
     * 那只是几次 `statSync`，够便宜。
     */
    let key = 'missing';
    for (const p of paths) {
      try {
        const st = statSync(p);
        key = `${p}|${st.mtimeMs}|${st.size}`;
      } catch { continue; }
      break;
    }
    if (key !== 'missing' && key === stamp) return cached;
    stamp = key;
    cached = readExternalAnnotations({ paths, log });
    return cached;
  };
}

export const EXTERNAL_FIELDS = FIELDS;
