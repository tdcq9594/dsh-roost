/**
 * 人格目录（catalog）：`personas/` 的派生索引。
 *
 * 为什么需要
 * ----------
 * 人格一多（几百份），每次开面板都 `readdir + 逐个 readFileSync + parsePersona` 就太贵；
 * 而 `resolve()` 每轮对话要拿正文，`status()` 又要判断「本地这份改过没有」，
 * 三处都在重复读同一批文件。
 *
 * 这里把「文件 → 元数据」算一次、存成 `personas/.catalog.json`，之后只对
 * **变过的文件**重新读。catalog 是**纯派生**：删掉能一键重建，任何
 * 「只能从 catalog 恢复」的状态都是设计错误。
 *
 * 一条踩过的坑
 * ------------
 * **不能用「目录 mtime 没变就直接返回」来省事。** 改文件内容不会改父目录的 mtime
 * （只有新建/删除/改名会），于是用户用编辑器改完人格，catalog 会一直返回旧数据——
 * 直接违反 `personas.js` 开头那句「Markdown 谁都能改，改完下一轮就生效」。
 * 所以这里**每次都 stat 每个文件**（300 次 stat 约 1–3 ms），只对变过的才读正文。
 */

import {
  readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 算内容哈希前把 CRLF 归一成 LF。
 *
 * 和 `persona-repo.js` / `build-persona-index.mjs` 必须是同一套规则：同一个文件
 * 在 Windows 检出是 CRLF、在 GitHub 上是 LF，字节不同但内容一样。不归一的话，
 * Windows 用户每次都会被判成「改过」，一键更新永远跳过他的文件。
 */
export const hashText = (text) => sha256(Buffer.from(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8'));

/**
 * catalog 的结构版本。
 *
 * **改了 `parsePersona` 的输出字段（新增 front matter、改 tags 规则）就要 bump 它。**
 * 因为增量复用的判据是「文件 mtime+size 没变」——解析规则变了但文件没变时，
 * 老用户磁盘上的 catalog 会一直返回旧元数据，直到那个文件被碰一下。
 * bump 之后 `readDisk()` 直接判结构不符、整份重建。
 */
const SCHEMA = 3;

/**
 * @param {object} opts
 * @param {() => string} opts.dir    人格目录（`<数据目录>/personas`）
 * @param {(id: string, raw: string) => {name?: string, tags?: string[]}} opts.parse
 *   解析 front matter。**由调用方注入**，避免 catalog 反向依赖 personas.js（循环引用）。
 * @param {(m: string) => void} [opts.log]
 */
export function createCatalog({ dir, parse, log = () => {} }) {
  const file = () => join(dir(), '.catalog.json');

  /** @type {{schema:number, items:Record<string,object>, files:Record<string,object>}|null} */
  let data = null;

  function empty() {
    return { schema: SCHEMA, items: {}, files: {} };
  }

  /**
   * 读磁盘上的 catalog。
   *
   * 结构不对就当没有——**不抛错**。catalog 坏了最坏是重扫一遍，
   * 而抛出去会让整个插件加载失败，代价完全不对等。
   */
  function readDisk() {
    try {
      const j = JSON.parse(readFileSync(file(), 'utf8'));
      if (!j || typeof j !== 'object' || j.schema !== SCHEMA) return null;
      if (!j.items || typeof j.items !== 'object') return null;
      if (!j.files || typeof j.files !== 'object') return null;
      /**
       * 文件名要过白名单。
       *
       * catalog 是本地文件，但它是**可以手改的**：`file: "../../config.json"`
       * 就能让 `parsedOf()` 读到目录外的东西，再顺着 `resolve()` 进系统提示词。
       * 一条正则的成本，换掉这个可能性。
       */
      const safe = /^[A-Za-z0-9_-]+\.md$/;
      for (const name of Object.keys(j.files)) if (!safe.test(name)) return null;
      for (const [id, rec] of Object.entries(j.items)) {
        if (!rec || rec.id !== id || !safe.test(String(rec.file ?? ''))) return null;
      }
      return j;
    } catch {
      return null;
    }
  }

  function ensure() {
    if (!data) data = readDisk() || empty();
    return data;
  }

  /** 原子写：先 `.tmp` 再 rename。半截 JSON 比没有更糟（下次读会崩） */
  function write(next) {
    try {
      mkdirSync(dir(), { recursive: true });
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      renameSync(tmp, file());
    } catch (e) {
      log(`写人格目录失败：${e.message}`);
    }
  }

  /**
   * 扫一遍目录，返回 `{items, files}`。
   *
   * - `items`：按 id 索引的元数据（列表、查询、resolve 都用它）
   * - `files`：按文件名索引的 `{id, mtimeMs, size, sha256}`，用来判断「这份变过没有」
   *
   * @param {boolean} [force] 忽略缓存，全部重读（面板「重建目录」用）
   */
  function scan(force = false) {
    const cur = ensure();

    let names;
    try {
      names = readdirSync(dir()).filter((n) => n.endsWith('.md'));
    } catch (e) {
      /**
       * **目录读不到 ≠ 目录为空。**
       *
       * 如果读失败时当成空目录，下面的「删除检测」会把现有条目全算成已删除，
       * 于是把 catalog 写成一个空文件——面板瞬间显示 0 个人格（.md 其实还在）。
       * 只有「目录不存在」才是首次运行，那种情况才当成空。
       */
      if (existsSync(dir())) {
        log(`读人格目录失败：${e.message}`);
        return cur; // 保持上一次的结果，不写盘
      }
      names = [];
    }

    const items = {};
    const files = {};
    // 没有 catalog 文件（首次运行）也算「变了」：要把目录建出来并写一份，
    // 否则空目录时 `changed` 永远是 false，`personas/` 都不会被创建。
    let changed = Boolean(force) || !existsSync(file());

    for (const name of names) {
      let st;
      try {
        st = statSync(join(dir(), name));
      } catch {
        continue; // 扫描过程中被删了，跳过
      }

      const old = cur.files[name];
      if (!force && old && old.mtimeMs === st.mtimeMs && old.size === st.size && cur.items[old.id]) {
        // 没变：直接复用，**不读文件**
        files[name] = old;
        items[old.id] = cur.items[old.id];
        continue;
      }

      let raw = '';
      try {
        raw = readFileSync(join(dir(), name), 'utf8');
      } catch (e) {
        /**
         * **读失败 ≠ 文件被删。**
         *
         * Windows 上编辑器保存、杀软扫描都会短暂锁住文件；这时候如果当成
         * 「已删除」，这个人格会从列表里消失、`status()` 变 `missing`，
         * 而此时点一键更新就会「无备份直接覆盖」。
         * 只有 ENOENT 才算真删；其它错误保留上一次的条目。
         */
        if (e.code !== 'ENOENT' && old && cur.items[old.id]) {
          files[name] = old;
          items[old.id] = cur.items[old.id];
          log(`读人格文件失败（先按旧值处理）：${name}：${e.message}`);
        }
        continue;
      }

      const id = name.slice(0, -3);
      let meta;
      try {
        meta = parse(id, raw) || {};
      } catch {
        // 单份解析失败不该让整个目录塌掉
        meta = {};
      }

      const rec = {
        id,
        file: name,
        // 0.11：label 是显示名；name 保留同值，给还没改的老消费方
        label: meta.label || meta.name || id,
        name: meta.label || meta.name || id,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        // 人格级工具限制：null = 不限制，[] = 一个都不给，[a,b] = 只给这些
        tools: Array.isArray(meta.tools) ? meta.tools : null,
        // 字数用**整份原文**长度（CRLF 归一后），跟 personas/index.json 的口径一致。
        // 用 body.length 会明显偏小（不含示例和世界书）；不归一的话，Windows 用户
        // 用记事本存一次，sha 判「没改」、字数却凭空多出「行数」个字符。
        chars: raw.replace(/\r\n/g, '\n').length,
        sha256: hashText(raw),
        /** 文件 mtime：治理页判断「刚装的别急着建议删」，必须在 rec 上，不能在 files 上 */
        mtimeMs: st.mtimeMs,
      };
      items[id] = rec;
      files[name] = { id, mtimeMs: st.mtimeMs, size: st.size, sha256: rec.sha256 };
      changed = true;
    }

    // 已删除的文件要从 items 里摘掉
    for (const name of Object.keys(cur.files)) {
      if (!files[name]) changed = true;
    }

    const next = { schema: SCHEMA, items, files };
    data = next;
    if (changed) write(next);
    return next;
  }

  return {
    scan,

    /** 按 id 取元数据；没有返回 null */
    get(id) {
      return scan().items[id] || null;
    },

    /** 列表用（不含正文）。排序交给调用方——default 置顶是 UI 的事 */
    list() {
      return Object.values(scan().items);
    },

    /**
     * 丢掉内存里的副本，下次从磁盘重读。
     *
     * 注意它**不是**「强制重扫」——`scan()` 本来每次都逐文件 stat，
     * 这里只是让下一次别复用内存里那份（写操作后调用，避免读到刚被自己改过的旧快照）。
     */
    invalidate() {
      data = null;
    },

    /** 面板「重建目录」：全部重读并写回 */
    rebuild() {
      return scan(true);
    },

    /** 给测试/排障用 */
    file,
  };
}
