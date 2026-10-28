/**
 * 人格仓库：从 dsh-roost 仓库的 `personas/` 一键更新本地人格库。
 *
 * 为什么需要它
 * ------------
 * 0.10.7 之前，内置人格是 `personas.js` 里的两个 JS 常量。想改一句人设要：
 *   改模板字符串 → bump 版本 → 发 npm → 用户在 DSH 里更新插件 → 重启
 * 四步。人格本来就是一段文字，不该有这么长的链路。
 *
 * 现在人格是仓库里的 `personas/*.md`，改完推一个 commit，用户点一下
 * 「从仓库更新」就拿到了——**不用发版**。这也是这个模块存在的唯一理由。
 *
 * 三条设计红线
 * ------------
 * 1. **不碰用户改过的文件。** 一键更新只动「和上次同步时一模一样」的文件，
 *    判据见 `status()`。判错的代价是用户的心血没了，比「更新不了」严重得多。
 * 2. **不信远端给的任何路径。** index.json 是远端内容，`file` 字段写
 *    `../../config.json` 就能覆盖配置文件。只认 `[A-Za-z0-9_-]+\.md`。
 * 3. **内容要能验。** 下载完逐份核对 sha256，对不上就不落地。人格正文是
 *    直接进系统提示词的——等于一段能被远程改写的最高优先级指令，
 *    只靠 https 保不了「索引说 A 实际给 B」。
 *
 * 拉取骨架照抄插件市场（`qq-bot-roost/src/plugin/market.js`）：
 * 并发去重 → 失败重试一次 → 本地缓存兜底，GitHub 挂了自动换 Gitee。
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { compareVersion } from './version.js';

// 兼容旧引用：本模块曾经自己实现过一份，测试和其它模块直接从这儿 import
export { compareVersion };

/** 自身版本：`minVersion` 门槛要用。读包里的 package.json，不手写常量（发版会忘） */
const OWN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * 允许拉人格的域名白名单。
 *
 * **必须是白名单，不能只校验 https。** 面板是本地服务，让它能对任意 URL
 * 发请求，它就成了内网探测器（`http://192.168.1.1/admin`、云厂商元数据
 * `169.254.169.254`）。插件市场已经踩过这个坑，这里照抄结论。
 */
const ALLOW_HOSTS = new Set(['raw.githubusercontent.com', 'gitee.com']);

/** 默认源。GitHub 在前（内容是权威的），Gitee 在后（国内 raw 更稳） */
const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/tdcq9594/dsh-roost/main/personas',
  'https://gitee.com/tdcq9594/dsh-roost/raw/main/personas',
];

/**
 * 从地址里取主机名，取不到就退回原文。
 *
 * 日志里只说「GitHub 连不上」比甩一整条 URL 好读，而 URL 已经在
 * 「最后试的是 …」里给过一次了。
 */
function safeHost(raw) {
  try {
    return new URL(String(raw)).host;
  } catch {
    return String(raw);
  }
}

/** 索引缓存多久算新鲜。太短会每次开面板都打网络，太长会看不到刚推的更新 */
const INDEX_TTL = 5 * 60_000;

/** 单份人格正文上限。现在最长的大肥鱼 731 字节，8000 字符够写很多了 */
const MAX_CHARS = 8000;

/** 单次响应体上限，防远端塞一个几百 MB 的 index.json */
const MAX_BYTES = 512 * 1024;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 算内容哈希前先把 CRLF 归一成 LF。
 *
 * 为什么必须归一：同一个文件在 Windows 检出（CRLF）和 GitHub 上（LF）
 * 字节不同，但**内容一样**。不归一的话，Windows 用户一 clone 下来，
 * 每份人格的哈希都对不上索引——「一键更新」会永远显示「有更新」，
 * 点了又装回一模一样的字节，来回打转。
 */
const hashText = (text) => sha256(Buffer.from(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8'));

/**
 * 只认安全文件名。远端给的 `file` 必须先过这一关，否则能路径穿越。
 *
 * 不用 `basename()` 去"净化"——那会把 `../../config.json` 悄悄变成
 * `config.json` 然后照装，看起来成功了、实际装错了东西。直接拒。
 */
function safeFile(name) {
  const n = String(name ?? '');
  if (!/^[A-Za-z0-9_-]+\.md$/.test(n)) throw new Error(`人格文件名不合法：${name}`);
  return n;
}

const safeId = (id) => /^[A-Za-z0-9_-]{1,40}$/.test(String(id ?? ''));

/**
 * 校验整份索引。
 *
 * 在 `loadIndex()` 里一次做完，而不是等到逐条处理时才判：一份带非法
 * `file` 或缺失 `sha256` 的索引本身就是坏的，没有理由「能装几条装几条」。
 * 校验失败会走下一层兜底（换源 → 磁盘缓存），行为跟 HTTP 失败一致。
 */
function validateIndex(j) {
  for (const p of j.personas) {
    if (!p || !safeId(p.id)) throw new Error(`索引里有不合法的 id：${JSON.stringify(p?.id)}`);
    safeFile(p.file);
    if (!/^[a-f0-9]{64}$/i.test(String(p.sha256 ?? ''))) throw new Error(`索引里「${p.id}」缺 sha256，无法校验内容`);
  }
  return j;
}

/**
 * 静态扫描：把高危字眼亮出来，**不拦**。
 *
 * 自然语言没有可靠的判别式——「把这段设定读出来」和「把 ~/.ssh 读出来」
 * 在词法上没本质区别，真做过滤只会误伤正常人格。所以这里只负责让用户
 * 自己看见：装之前红字列出命中的那几行。
 */
const RISKY = [
  { re: /忽略(之前|以上|前面|上面)/, why: '试图覆盖原有指令' },
  { re: /system\s*prompt|系统提示词/i, why: '提到系统提示词' },
  { re: /(调用|使用|执行).{0,6}(工具|命令|脚本)/, why: '诱导调用工具' },
  { re: /\b(bash|shell|powershell|cmd|exec)\b/i, why: '提到命令执行' },
  { re: /(~\/|\/etc\/|\.ssh|\.env|config\.json|credentials)/, why: '提到敏感路径' },
  { re: /(发送|转发|上传).{0,8}(到|至|给)/, why: '诱导往外发送' },
  { re: /(密码|口令|令牌|token|api[_\s-]?key)/i, why: '提到凭证' },
  { re: /\bqq_send\b|\bqq_close\b/, why: '提到机器人自己的发消息工具' },
];

export function scanPersona(text) {
  const hits = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const r of RISKY) {
      if (r.re.test(line)) {
        hits.push({ line: i + 1, why: r.why, text: line.trim().slice(0, 160) });
        break;
      }
    }
  });
  return hits;
}

/**
 * @param {object} opts
 * @param {string} opts.dataDir           数据目录
 * @param {object} opts.personas          `createPersonas()` 的返回值（要用 builtinDir）
 * @param {string[]} [opts.sources]       覆盖默认源（测试用）
 * @param {Function} [opts.fetchImpl]     覆盖 fetch（测试用）
 * @param {string[]} [opts.allowHosts]    覆盖域名白名单（测试用）
 * @param {(m:string)=>void} [opts.log]
 */
export function createPersonaRepo({
  dataDir,
  personas,
  sources,
  fetchImpl = globalThis.fetch,
  allowHosts,
  log = () => {},
  /** 提示级日志（换源成功这类「不是错误」的消息）。不传就静默 */
  note = () => {},
}) {
  const dir = () => join(dataDir, 'personas');
  const syncedPath = () => join(dir(), '.synced.json');
  const cachePath = () => join(dir(), '.index-cache.json');

  const hosts = new Set(allowHosts ?? ALLOW_HOSTS);
  const baseList = () => (Array.isArray(sources) && sources.length ? sources : DEFAULT_SOURCES);

  let indexCache = null;
  let indexAt = 0;
  /** 同一个 URL 正在飞的时候复用同一个 Promise（面板连点两下不该发两次请求） */
  const inflight = new Map();

  function assertSafeUrl(raw) {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      throw new Error(`地址不合法：${raw}`);
    }
    if (u.protocol !== 'https:') throw new Error(`只接受 https 地址（${u.href}）`);
    if (!hosts.has(u.hostname)) {
      throw new Error(`只允许从 ${[...hosts].join(' / ')} 拉人格，不接受「${u.hostname}」`);
    }
    return u;
  }

  async function getText(url) {
    const u = assertSafeUrl(url).href;
    if (inflight.has(u)) return inflight.get(u);
    const job = (async () => {
      const res = await fetchImpl(u, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': `dsh-roost/${OWN_VERSION}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error(`响应过大（${text.length} 字节）`);
      return text;
    })().finally(() => inflight.delete(u));
    inflight.set(u, job);
    return job;
  }

  /* ---------------- .synced.json ---------------- */

  function readSynced() {
    try {
      const j = JSON.parse(readFileSync(syncedPath(), 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  /** 原子写：先写 `.tmp` 再 rename。半截文件比没有文件更糟（下次读会崩） */
  function writeAtomic(file, text) {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  }

  function saveSynced(map) {
    try {
      writeAtomic(syncedPath(), JSON.stringify(map, null, 2) + '\n');
    } catch (e) {
      log(`写 .synced.json 失败：${e.message}`);
    }
  }

  /* ---------------- 索引 ---------------- */

  function readCache() {
    try {
      const j = JSON.parse(readFileSync(cachePath(), 'utf8'));
      return Array.isArray(j?.personas) ? j : null;
    } catch {
      return null;
    }
  }

  /**
   * 拉索引。三层兜底：
   *   1. 内存缓存（5 分钟）
   *   2. 逐个源 × 重试一次
   *   3. 磁盘缓存（上次成功的那份，标 `stale: true`）
   *
   * 第 3 层不是"能装"，而是"至少能看到我装过什么、有哪些人格存在"。
   * 网络抖的时候面板空着一片，比显示一份旧清单更让人困惑。
   */
  async function loadIndex({ force = false } = {}) {
    if (!force && indexCache && Date.now() - indexAt < INDEX_TTL) return indexCache;

    /**
     * 逐个源试，**失败只在最后统一报一次**。
     *
     * 以前每失败一次就打一条 warn，而默认源是「GitHub 在前、Gitee 在后」：
     * 国内 GitHub 经常连不上，于是面板上永远是两条红字
     * 「拉人格索引失败（…/personas，第 1 次）」，看起来像整个功能坏了——
     * 其实 Gitee 那次是成功的，人格库好好的。
     *
     * 现在：单个源失败只进 info（面板上不刺眼），全部失败才 warn；
     * 而且是换源成功时明说「已改用 Gitee」，别让人以为 GitHub 也能用。
     */
    const failed = [];
    for (const base of baseList()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = `${base}/index.json`;
        try {
          const txt = await getText(url);
          const j = JSON.parse(txt);
          if (!Array.isArray(j?.personas)) throw new Error('index.json 结构不对（缺 personas 数组）');
          validateIndex(j);
          indexCache = { ...j, base, stale: false };
          indexAt = Date.now();
          try {
            writeAtomic(cachePath(), JSON.stringify({ ...j, base }, null, 2) + '\n');
          } catch {}
          if (failed.length) {
            // 前面有源挂了、这个是好的：说清楚在用哪个，别让人以为 GitHub 也通了
            note(`人格索引：${failed.map((f) => f.host).join('、')} 连不上，已改用 ${new URL(base).host}`);
          }
          return indexCache;
        } catch (e) {
          failed.push({ base, url, host: safeHost(base), why: e?.message || String(e) });
        }
      }
    }

    const cached = readCache();
    if (cached) {
      // 有缓存就还能用，但必须让人知道「这份是旧的」
      log(
        `拉人格索引全失败（${failed.map((f) => `${f.host}：${f.why}`).join('；')}），` +
          `先用本地缓存（${cached.personas?.length ?? 0} 份）`,
      );
      indexCache = { ...cached, stale: true };
      indexAt = Date.now();
      return indexCache;
    }

    const last = failed[failed.length - 1];
    throw new Error(`拉取人格索引失败：${last?.why ?? '所有源都不可用'}（最后试的是 ${last?.url ?? '—'}）`);
  }

  /* ---------------- 本地状态 ---------------- */

  /** 仓库自带那份的 sha256（这个版本装进来的人格长什么样）。读不到返回 null */
  function bundledSha(file) {
    try {
      const root = personas?.builtinDir?.();
      if (!root) return null;
      const f = join(root, file);
      return existsSync(f) ? hashText(readFileSync(f, 'utf8')) : null;
    } catch {
      return null;
    }
  }

  /**
   * 逐个算出「本地 vs 仓库」的状态。
   *
   * 状态只有五种，判定顺序不能换：
   *
   * | 本地 | 判据 | 状态 | 一键更新时 |
   * |---|---|---|---|
   * | 没文件 | — | `missing` | 装 |
   * | 有 | sha == index.sha | `same` | 跳过 |
   * | 有 | 没被改过，但 sha != index.sha | `update` | 覆盖 |
   * | 有 | 被改过 | `modified` | **跳过** |
   *
   * 「没被改过」有**两个**判据，取并集：
   *   · `.synced[id].sha256` == 本地 sha（上次同步之后没动）
   *   · 仓库自带那份的 sha == 本地 sha（npm 装进来的原样，用户没动）
   *
   * 第二个判据是这次新加的，比方案文档里写的更稳：老用户从 0.10.6 升上来时
   * `.synced.json` 根本不存在，光靠"和 index 相等就补记"会让所有**仓库已更新**
   * 的人格被判成「你改过」而永远更新不了。拿本地 npm 包里那份做基准，
   * 离线就能判，也不依赖上次同步的时间点。
   */
  function status(index) {
    const synced = readSynced();
    return index.personas.map((p) => {
      const file = safeFile(p.file);
      const f = join(dir(), file);
      const local = existsSync(f) ? hashText(readFileSync(f, 'utf8')) : null;
      const rec = synced[p.id];

      let state;
      if (local === null) state = 'missing';
      else if (local === p.sha256) state = 'same';
      else if (rec?.sha256 === local || bundledSha(file) === local) state = 'update';
      else state = 'modified';

      return {
        id: p.id,
        name: p.name,
        tags: p.tags ?? [],
        file,
        chars: p.chars ?? p.bytes ?? 0,
        state,
        // 面板要显示「我的版本 / 仓库版本」的差别，只给字数不够直观
        localChars: local === null ? 0 : readFileSync(f, 'utf8').length,
      };
    });
  }

  /* ---------------- 备份 ---------------- */

  /**
   * 覆盖前备份到 `<数据目录>/personas/.backup/<时间戳>/`。
   *
   * 方案文档里写的是备份成 `id.我的-YYYYMMDD.md`，落地时改成子目录了：
   * 那样备份文件会躺在人格目录里，被 `list()` 当成一个人格列出来
   * （名字变成「大肥鱼.我的-20261028」）。子目录里不会被扫到。
   */
  function backup(id, file) {
    const f = join(dir(), file);
    if (!existsSync(f)) return '';
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bdir = join(dir(), '.backup', ts);
    mkdirSync(bdir, { recursive: true });
    const target = join(bdir, `${id}.md`);
    writeAtomic(target, readFileSync(f, 'utf8'));
    pruneBackups();
    return target;
  }

  /** 只留最近 5 次。人格是几 KB，但没人希望备份目录无限长 */
  function pruneBackups() {
    try {
      const root = join(dir(), '.backup');
      const dirs = readdirSync(root).sort();
      for (const d of dirs.slice(0, Math.max(0, dirs.length - 5))) {
        rmSync(join(root, d), { recursive: true, force: true });
      }
    } catch {}
  }

  /* ---------------- 对外 ---------------- */

  return {
    /** 版本门槛：仓库里的人格可能用了老版本解析不了的新段落，不能闷头装 */
    gate(index) {
      const need = String(index.minVersion ?? '');
      if (!need) return { ok: true };
      return compareVersion(OWN_VERSION, need) >= 0
        ? { ok: true }
        : { ok: false, need, own: OWN_VERSION, why: `这批人格需要 dsh-roost ${need} 以上（你装的是 ${OWN_VERSION}）` };
    },

    version: () => OWN_VERSION,

    /** 面板列表：仓库有哪些人格 + 本地各自什么状态 */
    async list({ force = false } = {}) {
      const index = await loadIndex({ force });
      const g = this.gate(index);
      // 门槛不过就**不算**状态：老版本解析不了新格式，列出来点「装」只会装进半个人格
      const rows = g.ok ? status(index) : [];
      return {
        ok: true,
        stale: Boolean(index.stale),
        base: index.base,
        repo: index.repo ?? '',
        branch: index.branch ?? '',
        minVersion: index.minVersion ?? '',
        gate: g,
        personas: rows,
        pending: rows.filter((x) => x.state !== 'same').length,
      };
    },

    /** 预览一份人格的正文（只读，不落盘） */
    async preview(id) {
      const index = await loadIndex();
      const p = index.personas.find((x) => x.id === id);
      if (!p) throw new Error(`仓库里没有「${id}」这个人格`);
      const text = await getText(`${index.base}/${safeFile(p.file)}`);
      return { ok: true, id: p.id, name: p.name, text, chars: text.length, risky: scanPersona(text) };
    },

    /**
     * 一键更新。只处理 `missing` 和 `update`，`modified` 一律跳过。
     *
     * 返回报告而不是抛错：单个文件失败不该让整批停下——
     * 「更新了 3 个、失败 1 个」比「全都没更新」有用得多。
     */
    async sync() {
      const index = await loadIndex({ force: true });
      const g = this.gate(index);
      if (!g.ok) return { ok: false, skipped: true, why: g.why, updated: [], failed: [], untouched: [] };

      const rows = status(index);
      const synced = readSynced();
      const updated = [];
      const failed = [];
      const untouched = [];

      for (const r of rows) {
        if (r.state === 'same') {
          /**
           * 顺手补记 `.synced`：内容和仓库一模一样，那就没必要记成"改过"。
           * 老用户第一次点一键更新时全靠这一步，否则下一轮仓库一更新，
           * 这些文件就会被判成 `modified` 而永远更新不了。
           */
          if (!synced[r.id]) synced[r.id] = { sha256: index.personas.find((p) => p.id === r.id)?.sha256 ?? '', syncedAt: Date.now() };
          continue;
        }
        if (r.state === 'modified') {
          untouched.push({ id: r.id, name: r.name, why: '你改过这份，不动它' });
          continue;
        }

        const p = index.personas.find((x) => x.id === r.id);
        try {
          const text = await getText(`${index.base}/${safeFile(p.file)}`);
          if (text.length > MAX_CHARS) throw new Error(`正文 ${text.length} 字，超过 ${MAX_CHARS} 字上限`);
          const got = hashText(text);
          if (got !== p.sha256) {
            throw new Error(`内容校验失败（索引说 ${String(p.sha256).slice(0, 8)}…，实际 ${got.slice(0, 8)}…）`);
          }
          if (r.state === 'update') backup(r.id, r.file);
          writeAtomic(join(dir(), r.file), text);
          synced[r.id] = { sha256: got, syncedAt: Date.now() };
          updated.push({ id: r.id, name: r.name, risky: scanPersona(text) });
        } catch (e) {
          failed.push({ id: r.id, name: r.name, why: e.message });
        }
      }

      saveSynced(synced);
      log(`人格更新：成功 ${updated.length}、跳过 ${untouched.length}、失败 ${failed.length}`);
      return {
        ok: failed.length === 0,
        updated,
        untouched,
        failed,
        pending: status(index).filter((x) => x.state !== 'same').length,
      };
    },

    /**
     * 强制恢复官方版本（单个）。
     *
     * 这是「你改过」之后想反悔时的出口——一键更新刻意不动改过的文件，
     * 但总得有一条路能拿回官方版。覆盖前先备份，反悔还能捞回来。
     */
    async restore(id) {
      const index = await loadIndex({ force: true });
      const g = this.gate(index);
      if (!g.ok) return { ok: false, skipped: true, why: g.why };
      const p = index.personas.find((x) => x.id === id);
      if (!p) throw new Error(`仓库里没有「${id}」这个人格`);

      const file = safeFile(p.file);
      const text = await getText(`${index.base}/${file}`);
      const got = hashText(text);
      if (got !== p.sha256) throw new Error(`内容校验失败（索引说 ${String(p.sha256).slice(0, 8)}…，实际 ${got.slice(0, 8)}…）`);

      const saved = backup(id, file);
      writeAtomic(join(dir(), file), text);
      const synced = readSynced();
      synced[id] = { sha256: got, syncedAt: Date.now() };
      saveSynced(synced);
      return { ok: true, id, name: p.name, backup: saved, risky: scanPersona(text) };
    },
  };
}
