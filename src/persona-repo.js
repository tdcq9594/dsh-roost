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
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { compareVersion } from './version.js';
// 哈希规则只能有一个定义处：这里、catalog、构建脚本必须算出一模一样的 sha256，
// 否则 Windows 检出（CRLF）会被判成「改过」，一键更新永远跳过用户文件。
import { hashText } from './catalog.js';

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

/** 单份人格 / 未知响应的上限 */
const MAX_BYTES = 512 * 1024;
/** 索引和 pack 各有各的上限：**不要**把全局常量抬到 8 MB，那等于允许一个 8 MB 的 index.json 通过 */
const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const PACK_MAX_BYTES = 8 * 1024 * 1024;

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

  async function getText(url, { maxBytes = MAX_BYTES } = {}) {
    const u = assertSafeUrl(url).href;
    if (inflight.has(u)) return inflight.get(u);
    const job = (async () => {
      const res = await fetchImpl(u, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': `dsh-roost/${OWN_VERSION}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`响应过大（${Buffer.byteLength(text, 'utf8')} 字节，上限 ${maxBytes}）`);
      return text;
    })().finally(() => inflight.delete(u));
    inflight.set(u, job);
    return job;
  }

  /** pack 分片路径：只允许 `packs/<名字>.jsonl`，同样防路径穿越 */
  function safePackFile(name) {
    const s = String(name || '');
    if (!/^packs\/[A-Za-z0-9_-]+\.jsonl$/.test(s)) throw new Error(`pack 文件名不合法：${s}`);
    return s;
  }

  /**
   * 拉一个 pack 分片，解析成 `id → 原文`。
   *
   * 逐行 JSONL；坏行跳过（不因为一行脏数据把整片废掉）。
   * 里面的正文仍然要逐份验 sha256——pack 只是省请求数，不是信任来源。
   */
  async function fetchPack(index, n) {
    const meta = (index.packs || []).find((p) => Number(p.n) === Number(n));
    if (!meta) return null;
    const txt = await getText(`${index.base}/${safePackFile(meta.file)}`, { maxBytes: PACK_MAX_BYTES });
    const map = new Map();
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o?.id && typeof o.text === 'string') map.set(String(o.id), o.text);
      } catch {}
    }
    return map;
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
    /**
     * 报给人看的源名去重。
     *
     * `failed` 是按**尝试次数**记的（一个源要试 2 次），直接 map 出主机名会得到
     * 「raw.githubusercontent.com、raw.githubusercontent.com 连不上」——
     * 用户会以为配了两个 GitHub 源。同一个源试几次都只算一个。
     */
    const failedHosts = () => [...new Set(failed.map((f) => f.host))];
    for (const base of baseList()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const url = `${base}/index.json`;
        try {
          const txt = await getText(url, { maxBytes: INDEX_MAX_BYTES });
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
            note(`人格索引：${failedHosts().join('、')} 连不上，已改用 ${new URL(base).host}`);
          }
          return indexCache;
        } catch (e) {
          failed.push({ base, url, host: safeHost(base), why: e?.message || String(e) });
        }
      }
    }

    const cached = readCache();
    if (cached) {
      // 有缓存就还能用，但必须让人知道「这份是旧的」。同样按源去重
      const detail = [...new Map(failed.map((f) => [f.host, f])).values()]
        .map((f) => `${f.host}：${f.why}`)
        .join('；');
      log(`拉人格索引全失败（${detail}），先用本地缓存（${cached.personas?.length ?? 0} 份）`);
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
   * 包内 `personas/index.json` 的 `file → sha256` 映射。
   *
   * 为什么用它：判断「本地这份有没有被改过」需要「官方那份长什么样」。
   * 以前是逐个文件读出来算 hash——300 份就是 300 次读 + 300 次 sha256。
   * 而 `personas/index.json` 本来就随 npm 包发布（`package.json` 的 `files`
   * 含 `personas`），里面已经有每份的 sha256，读一次建个 map 就够。
   *
   * 读不到（测试里的假 builtinDir、打包漏了）返回 null，调用方回退到算 hash。
   */
  let bundledMap;
  let bundledTried = false;
  function bundledShas() {
    if (bundledTried) return bundledMap;
    bundledTried = true;
    try {
      const root = personas?.builtinDir?.();
      if (!root) return (bundledMap = null);
      const j = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
      const m = new Map();
      for (const p of j?.personas ?? []) {
        if (p?.file && p?.sha256) m.set(p.file, p.sha256);
      }
      bundledMap = m.size ? m : null;
    } catch {
      bundledMap = null;
    }
    return bundledMap;
  }

  /**
   * 头部里有没有显式写 `tools`（`Tools:`、缩进也认）。
   *
   * 不能用 `parsePersona().tools === null` 判断——「没写」和「写了 null」
   * 解析出来都是 null，而这两者对安装器意味着完全不同的动作。
   */
  function toolsDeclared(text) {
    const m = String(text).match(/^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
    if (!m) return false;
    return /^\s*tools\s*:/im.test(m[1]);
  }

  /**
   * 补 `tools: []`，但**只在明确要求时**补。
   *
   * 三种调用方，三种语义：
   *   · `install()`——市场单条安装，`force = !isBuiltin(本地文件名)`：内置人格不补
   *     （包自带的那几份靠索引/文件识别，补成 `[]` 会把小栖的工具全收走）；
   *   · `sync()` / `restore()`——`force = 非内置 或 本地本来就声明了 tools`：
   *     **保留**，别把装的时候补的 `[]` 洗回 `null`（全开）；
   *   · 本地没有 tools 的（内置/老文件）——一个字节都不动。
   *
   * 补写会改变文件内容，所以 `.synced` 必须同时记 `localSha`。
   */
  function withToolsDefault(text, force) {
    if (!force) return { text, injected: false };
    if (toolsDeclared(text)) return { text, injected: false };

    const m = String(text).match(/^(\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
    if (m) {
      // 注意要接回匹配之后的原文：只拼 m[1..3] 会把正文整段丢掉
      // 换行符跟着文件走，别给 CRLF 文件塞一行 LF（混合换行虽然能解析，但看着别扭）
      const eol = m[1].includes('\r\n') ? '\r\n' : '\n';
      return { text: m[1] + m[2] + eol + 'tools: []' + m[3] + String(text).slice(m[0].length), injected: true };
    }

    // 空头 / 头没闭合：插在开头那行之后，别把原文顶掉
    const first = String(text).match(/^(\s*---[ \t]*\r?\n)/);
    if (first) {
      const eol = first[1].includes('\r\n') ? '\r\n' : '\n';
      return { text: first[1] + 'tools: []' + eol + String(text).slice(first[1].length), injected: true };
    }

    return { text: '---\ntools: []\n---\n' + String(text), injected: true };
  }

  /**
   * 这份是不是「包内自带的」。
   *
   * 两个判据，缺一不可：
   *   · 包内 `index.json` 里有它；
   *   · 或者包内目录里确实躺着这个文件（开发态新加了 `.md` 但忘了重跑索引）。
   * 只看 index 的话，忘了跑索引时内置人格会被当成市场人格补 `tools: []`，
   * 直接把小栖的工具全收走。
   */
  function isBuiltin(file) {
    const bmap = bundledShas();
    if (bmap?.has(file)) return true;
    const root = personas?.builtinDir?.();
    return Boolean(root && existsSync(join(root, file)));
  }

  /** 本地这份有没有声明 tools（sync/restore 靠它决定要不要保留） */
  function localDeclaresTools(id, file, inst) {
    const p = join(dir(), localNameFor(id, file, inst));
    if (!existsSync(p)) return false;
    try {
      return toolsDeclared(readFileSync(p, 'utf8'));
    } catch {
      return false;
    }
  }

  /** 仓库 id 在本地对应哪个文件名（撞名安装时和仓库里的 `file` 不一样） */
  function localNameFor(id, file, inst) {
    return `${inst?.[id] || String(file).replace(/\.md$/i, '')}.md`;
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
    const bmap = bundledShas();
    /**
     * 墓碑：用户主动删掉的人格。
     *
     * 它们和一键更新里「没装过」的 `missing` 不是一回事：
     * `missing` 该装，`deleted` 不该自动装回来（否则「删掉」这个动作永远不成立）。
     * 想恢复得点「恢复」，那条路会顺手把墓碑清掉。
     */
    const tombstones = new Set(personas?.prefs?.read?.().deleted ?? []);
    /** 撞名安装的映射：仓库 id → 本地 id */
    const inst = personas?.prefs?.read?.().installedAs ?? {};
    /**
     * **一次扫描拿快照，之后全是查表。**
     *
     * 注意别写成 `personas.catalog.get(p.id)`：那个方法内部每次都会重新
     * scan 整个目录（N 次 stat），放进 map 里就是 O(N²)——300 份实测 2.8 秒，
     * 比它替换掉的「每条读两次文件」还慢一个数量级。
     */
    const items = personas?.catalog?.scan ? personas.catalog.scan().items : null;
    return index.personas.map((p) => {
      const file = safeFile(p.file);
      /**
       * 本地条目按**文件名**查，不按 `p.id`。
       *
       * catalog 的 key 是文件名去掉 `.md`（`catalog.js` 里 `id = name.slice(0,-3)`），
       * 而索引里的 `id` 和 `file` 是两回事——`validateIndex` 没强制
       * `file === id + '.md'`。按 id 查的话，上游哪天把 file 改成 `a-v2.md`，
       * 这份人格就会永远显示「未安装」，每次同步都重装一遍。
       * 撞名安装过的，还要再经 `installedAs` 映射到本地文件名。
       */
      const localId = inst[p.id] ?? file.slice(0, -3);
      const item = items ? (items[localId] ?? null) : null;
      /**
       * 本地这份的 sha / 字数从 catalog 拿，**不再逐个文件读**。
       *
       * `items === null` 说明调用方塞了一个没有 catalog 的假 personas
       * （只可能出现在测试里），退回读文件，行为与旧版一致。
       */
      const local = items
        ? (item ? item.sha256 : null)
        : (existsSync(join(dir(), file)) ? hashText(readFileSync(join(dir(), file), 'utf8')) : null);
      const rec = synced[p.id];
      /**
       * 包内索引里查不到这一条时，**回退去算那份文件的 hash**。
       *
       * 开发态常见：新加了 `.md` 但忘了跑 `build-persona-index.mjs`，
       * 索引里就没有它。此时如果直接当「没有基准」，本地这份会被判成
       * `modified`，一键更新从此永远跳过它——比多读一次文件贵得多。
       */
      const bundled = bmap?.get(file) ?? bundledSha(file);

      let state;
      if (local === null) {
        /**
         * 墓碑可能记的是仓库 id，也可能是本地 id（撞名安装后删的是 `repo__a`）。
         * 两个都查，否则撞名装过的人格删掉后会被判成 `missing`，一键更新立刻装回。
         */
        const gone = tombstones.has(p.id) || (inst[p.id] && tombstones.has(inst[p.id]));
        state = gone ? 'deleted' : 'missing';
      }
      else if (local === p.sha256) state = 'same';
      /**
       * 装的时候补过 `tools: []`，文件内容就和索引里的 sha 对不上了。
       * `localSha` 记的是「我们写下去的那一版」——但**还要看它对应哪个仓库版本**：
       * `rec.sha256` 是装的时候那份原文的 sha，只有它还等于当前 `p.sha256` 时，
       * `localSha` 一致才算「已是最新」；仓库更新过就得落到 `update`。
       * 少了后半个条件，补过 tools 的人格会永远显示最新、再也更新不了。
       */
      else if (rec && local === rec.localSha) state = rec.sha256 === p.sha256 ? 'same' : 'update';
      else if (rec?.sha256 === local || bundled === local) state = 'update';
      /**
       * 内置人格、**没有 `.synced`**（老用户从没用过一键更新）：本地那份就是
       * 包自带的旧版，不是用户改的。判成 `modified` 会让它永远收不到更新，
       * 面板还会长期挂着「你改过」。
       * 有 `.synced` 却对不上的，仍然算 `modified`——那是真的改过。
       */
      else state = bundled && !rec ? 'update' : 'modified';

      return {
        id: p.id,
        label: p.label || p.name,
        name: p.label || p.name,
        tags: p.tags ?? [],
        file,
        chars: p.chars ?? p.bytes ?? 0,
        state,
        // 面板要显示「我的版本 / 仓库版本」的差别，只给字数不够直观
        localChars: items
          ? (item ? item.chars : 0)
          : (local === null ? 0 : readFileSync(join(dir(), file), 'utf8').length),
      };
    });
  }

  /* ---------------- 备份 ---------------- */

  /**
   * 备份实现挪到了 `personas.js`。
   *
   * 理由：**删除也要备份**（自己写的人格不在仓库里，删错就真没了），
   * 而删除发生在 personas 那边。两条路径必须共用同一份规则，
   * 否则 `.backup/` 会长成两种样子（目录名、保留数量、文件命名都会飘）。
   */
  function backup(id, file) {
    return personas?.backup ? personas.backup(id, file) : '';
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
        /**
         * 「有几个该更新」的角标。
         *
         * **不含 `deleted`**：用户主动删掉的不该一直顶着角标催他，
         * 否则那个数字永远清不掉，等于变相骚扰。
         */
        pending: rows.filter((x) => x.state !== 'same' && x.state !== 'deleted').length,
        /** 用户删过的（可恢复）。面板用它显示「有 N 个你删过的人格」 */
        deleted: rows.filter((x) => x.state === 'deleted').length,
      };
    },

    /** 预览一份人格的正文（只读，不落盘） */
    async preview(id) {
      const index = await loadIndex();
      const p = index.personas.find((x) => x.id === id);
      if (!p) throw new Error(`仓库里没有「${id}」这个人格`);
      const text = await getText(`${index.base}/${safeFile(p.file)}`);
      return { ok: true, id: p.id, label: p.label || p.name, name: p.label || p.name, text, chars: text.length, risky: scanPersona(text) };
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
      /** 用户主动删过的：不自动装回来，只报告，让他自己决定 */
      const skippedDeleted = [];
      // 一次建表，循环里别再 `index.personas.find`（那是 O(N²)，纯属白烧）
      const byId = new Map(index.personas.map((p) => [p.id, p]));
      const inst = personas?.prefs?.read?.().installedAs ?? {};
      const bmap = bundledShas();

      /**
       * 装 5 个以上走 pack：每片一次请求，而不是每份一次。
       * 1–4 个仍逐条——为 2 份人格拉一个分片不划算。
       */
      const todo = rows.filter((r) => r.state === 'missing' || r.state === 'update');
      const packTexts = new Map();
      if (todo.length >= 5 && Array.isArray(index.packs) && index.packs.length) {
        const need = new Set(todo.map((r) => byId.get(r.id)?.pack).filter((n) => Number.isInteger(n)));
        for (const n of need) {
          try {
            const m = await fetchPack(index, n);
            if (m) for (const [id, t] of m) packTexts.set(id, t);
          } catch (e) {
            log(`pack p${n} 拉取失败，回退逐条：${e.message}`);
          }
        }
      }

      for (const r of rows) {
        if (r.state === 'deleted') {
          skippedDeleted.push({ id: r.id, name: r.name });
          continue;
        }
        if (r.state === 'same') {
          /**
           * 顺手补记 `.synced`：内容和仓库一模一样，那就没必要记成"改过"。
           * 老用户第一次点一键更新时全靠这一步，否则下一轮仓库一更新，
           * 这些文件就会被判成 `modified` 而永远更新不了。
           */
          if (!synced[r.id]) synced[r.id] = { sha256: byId.get(r.id)?.sha256 ?? '', syncedAt: Date.now() };
          continue;
        }
        if (r.state === 'modified') {
          untouched.push({ id: r.id, name: r.name, why: '你改过这份，不动它' });
          continue;
        }

        const p = byId.get(r.id);
        try {
          const fetchOne = () => getText(`${index.base}/${safeFile(p.file)}`);
          let text = packTexts.get(r.id);
          let fromPack = Boolean(text);
          if (!text) text = await fetchOne();
          /**
           * 分片可能是旧的（索引更新了、packs 忘了重跑，或 CDN 缓存）。
           * 这种情况要**回退逐条**，不能把整批记成失败——逐条路径拿到的是对的。
           */
          if (fromPack && (text.length > MAX_CHARS || hashText(text) !== p.sha256)) {
            log(`分片内容与索引不一致（${r.id}），回退逐条`);
            text = await fetchOne();
            fromPack = false;
          }
          if (text.length > MAX_CHARS) throw new Error(`正文 ${text.length} 字，超过 ${MAX_CHARS} 字上限`);
          const got = hashText(text);
          if (got !== p.sha256) {
            throw new Error(`内容校验失败（索引说 ${String(p.sha256).slice(0, 8)}…，实际 ${got.slice(0, 8)}…）`);
          }
          const localName = localNameFor(r.id, r.file, inst);
          const { text: out, injected } = withToolsDefault(text, !isBuiltin(r.file) || localDeclaresTools(r.id, r.file, inst));
          if (r.state === 'update') backup(r.id, localName);
          writeAtomic(join(dir(), localName), out);
          personas?.catalog?.invalidate?.();
          // localSha 记「写下去的那一版」：补过 tools 之后它和索引 sha 不同
          synced[r.id] = { sha256: got, localSha: hashText(out), syncedAt: Date.now() };
          updated.push({ id: r.id, name: r.name, risky: scanPersona(out), injected });
        } catch (e) {
          failed.push({ id: r.id, name: r.name, why: e.message });
        }
      }

      saveSynced(synced);
      log(`人格更新：成功 ${updated.length}、跳过 ${untouched.length}、失败 ${failed.length}`
        + (skippedDeleted.length ? `、你删过 ${skippedDeleted.length}` : ''));
      return {
        ok: failed.length === 0,
        updated,
        untouched,
        failed,
        /** 你删过的：报告出来但不装，面板可以提示「要恢复吗」 */
        deleted: skippedDeleted,
        pending: status(index).filter((x) => x.state !== 'same' && x.state !== 'deleted').length,
      };
    },

    /**
     * 把人格文件里废弃的 `name:` 改名为 `label:`（0.11 迁移）。
     *
     * 只动这一行，其它字节原样保留；改前备份。
     * 按来源决定要不要改：
     *   · 内置且没改过   → 改，并把「写下去的那一版」记进 `.synced.localSha`；
     *   · 市场装的且没改过 → 改，更新 `rec.localSha`；
     *   · 用户自己写的   → 改（没有 sha 语义）；
     *   · **改过的一律不碰**——迁移永远不覆盖用户的编辑。
     *
     * 不清的话 `name` 会被当成 label 一直显示；清错了则会让人格集体变成
     * 「你改过」、从此收不到更新。所以判据必须按来源分开。
     */
    migrateNameField() {
      let files = [];
      try {
        files = readdirSync(dir()).filter((f) => f.endsWith('.md'));
      } catch {
        return { renamed: [], skipped: [] };
      }

      const synced = readSynced();
      /** 撞名安装的：本地 id → 仓库 id。`.synced` 是按仓库 id 存的 */
      const inst = personas?.prefs?.read?.().installedAs ?? {};
      const renamed = [];
      const skipped = [];

      for (const file of files) {
        const id = file.slice(0, -3);
        const repoId = Object.keys(inst).find((k) => inst[k] === id) ?? id;
        const p = join(dir(), file);
        let text;
        try {
          text = readFileSync(p, 'utf8');
        } catch {
          continue;
        }

        const m = String(text).match(/^(\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
        if (!m) continue;
        const header = m[2];
        if (!/^[ \t]*name[ \t]*:/im.test(header)) continue;

        const localSha = hashText(text);
        const rec = synced[repoId];
        const builtin = isBuiltin(file);

        /**
         * 内置人格也要认 `rec`：被「一键更新」升到比包内新的版本后，
         * 本地 sha 不等于包内 sha，但那不是用户手改的——按 `rec` 判它是我们写的。
         */
        let allowed = false;
        /**
         * 内置人格只认两种「没改过」：和包内 sha 一致，或 `.synced` 记录对得上。
         *
         * **没有 `.synced` 的旧版不迁移**：分不清「老包自带的」和「用户改过的」，
         * 迁移只改一行也会动用户的文件。这类文件的状态会被判成 `update`，
         * 用户点一次「一键更新」就换成新的 label 版本（会先备份），不需要迁移插手。
         */
        if (builtin) allowed = localSha === bundledSha(file) || localSha === rec?.localSha || localSha === rec?.sha256;
        else if (rec) allowed = localSha === rec.localSha || localSha === rec.sha256;
        else allowed = true; // 自己写的，没有 sha 语义

        if (!allowed) {
          skipped.push({ id, why: '你改过这份' });
          continue;
        }

        try {
          const eol = header.includes('\r\n') ? '\r\n' : '\n';
          const hasLabel = /^[ \t]*label[ \t]*:/im.test(header);
          const newHeader = hasLabel
            ? header.split(/\r?\n/).filter((l) => !/^[ \t]*name[ \t]*:/i.test(l)).join(eol)
            // g 标志：万一头部有两行 name，一次改完，别让下次启动再改一遍
            : header.replace(/^([ \t]*)name([ \t]*):/gim, '$1label$2:');

          const out = m[1] + newHeader + m[3] + String(text).slice(m[0].length);
          if (out === text) continue;

          backup(id, file);
          writeAtomic(p, out);

          if (builtin || rec) {
            /**
             * 没有 `rec` 时（老用户的内置人格），把**写下去的这一版**当基准：
             * 内容和新包一致 → `same`；不一致（比如 fatfish 正文这次改过）
             * → `update`，用户点一下就能拿到新正文。
             * 不能拿包内 sha 当基准——那会把旧正文谎报成「已是最新」。
             */
            const newSha = hashText(out);
            synced[repoId] = {
              ...(rec || {}),
              sha256: rec?.sha256 ?? newSha,
              localSha: newSha,
              syncedAt: Date.now(),
            };
          }
          renamed.push({ id });
          // 每成功一份就落盘：中途失败不会留下「文件改了、记录没改」的半迁移状态
          if (builtin || rec) saveSynced(synced);
        } catch (e) {
          skipped.push({ id, why: e.message });
        }
      }

      if (renamed.length) {
        try {
          saveSynced(synced);
        } catch {}
        personas?.catalog?.invalidate?.();
      }
      return { renamed, skipped };
    },

    /**
     * 打完标签后刷新 `.synced.localSha`。
     *
     * 标签是元数据，用户不会预期「加了个标签就从此收不到更新」。
     * 不刷新的话 `status()` 立刻判 `modified`，`sync()` 永远跳过这份。
     */
    refreshLocalSha(ids) {
      const synced = readSynced();
      const inst = personas?.prefs?.read?.().installedAs ?? {};
      let changed = false;
      for (const id of ids || []) {
        const rec = synced[id];
        if (!rec) continue;
        const p = join(dir(), localNameFor(id, `${id}.md`, inst));
        if (!existsSync(p)) continue;
        const sha = hashText(readFileSync(p, 'utf8'));
        if (rec.localSha !== sha) {
          synced[id] = { ...rec, localSha: sha };
          changed = true;
        }
      }
      if (changed) saveSynced(synced);
      return changed;
    },

    /**
     * 装单个（市场用）。
     *
     * 和 `sync()` 的三点区别：
     *   · 只装一个；
     *   · **不覆盖用户改过的**（有同步记录但内容对不上 → 直接拒绝）；
     *   · 撞名时改名而不是覆盖（用户自己写了个同名人格）。
     *
     * 写盘前给市场人格补 `tools: []`，并把「写下去的那一版」记进 `localSha`。
     */
    async install(id) {
      const index = await loadIndex({ force: true });
      const g = this.gate(index);
      if (!g.ok) return { ok: false, skipped: true, why: g.why };
      const p = index.personas.find((x) => x.id === id);
      if (!p) throw new Error(`仓库里没有「${id}」这个人格`);

      const file = safeFile(p.file);
      const synced = readSynced();
      const prefsNow = personas?.prefs?.read?.() ?? {};
      const inst = prefsNow.installedAs ?? {};
      let localName = localNameFor(id, file, inst);
      const readLocal = () => (existsSync(join(dir(), localName)) ? hashText(readFileSync(join(dir(), localName), 'utf8')) : null);
      let localSha = readLocal();

      if (localSha) {
        const rec = synced[id];
        /** 已经是当前仓库版本（或我们为当前版本写下去的那版）→ 不用再装 */
        const upToDate = localSha === p.sha256
          || (rec && localSha === rec.localSha && rec.sha256 === p.sha256);
        if (upToDate) return { ok: true, already: true, id, name: p.name };
        if (rec) {
          /**
           * 有同步记录：内容对得上「我们写过的某一版」= 只是仓库更新了，继续装；
           * 对不上 = 用户改过，绝不覆盖。
           */
          if (localSha !== rec.sha256 && localSha !== rec.localSha) {
            return { ok: false, why: '你改过这份，先自己处理（或点「恢复官方」）' };
          }
        } else {
          /**
           * 没有同步记录、内容又不同。先排除「这本来就是我们的那份」：
           *   · 内置人格本地是 npm 带的旧版 → 和包内那份 sha 一致，正常覆盖；
           *   · 用户改过的内置人格 → 拒绝；
           *   · 其余才算撞名（用户自己写的同名人格）→ 换名，绝不覆盖。
           *
           * **必须同时要求 `p.id === 文件名主干`**：市场条目的 `file` 可以随便写，
           * 一条 `id: evil, file: default.md` 会命中「和包内 sha 一致」，
           * 把内置人格覆盖掉，而且因为文件名叫 default.md 还被当成内置、不补 tools。
           */
          const samePersona = p.id === String(file).replace(/\.md$/i, '');
          if (samePersona && localSha === bundledSha(file)) {
            // ours：继续往下装（会先备份）
          } else if (samePersona && isBuiltin(file)) {
            return { ok: false, why: '你改过这份，先自己处理（或点「恢复官方」）' };
          } else {
            const stem = localName.replace(/\.md$/i, '');
            const slug = String(p.authorSlug || '').replace(/[^A-Za-z0-9_-]/g, '')
              || hashText(String(p.author || p.id)).slice(0, 6);
            let n = 1;
            do {
              localName = `${slug}__${stem}${n > 1 ? '-' + n : ''}.md`;
              n += 1;
            } while (existsSync(join(dir(), localName)) && n < 50);
            if (n >= 50) throw new Error('同名人格太多了，换不出可用的文件名');
            localSha = readLocal();
          }
        }
      }

      const text = await getText(`${index.base}/${file}`);
      if (text.length > MAX_CHARS) throw new Error(`正文 ${text.length} 字，超过 ${MAX_CHARS} 字上限`);
      const got = hashText(text);
      if (got !== p.sha256) throw new Error(`内容校验失败（索引说 ${String(p.sha256).slice(0, 8)}…，实际 ${got.slice(0, 8)}…）`);

      /**
       * 补不补 `tools: []` 看**本地文件名**，不看仓库里的 `file`。
       * 撞名安装后本地叫 `slug__default.md`，它已经不是内置那份了，
       * 必须补；只看 `file` 的话会漏掉，等于绕过安全默认。
       */
      const { text: out, injected } = withToolsDefault(text, !isBuiltin(localName));
      backup(id, localName);
      writeAtomic(join(dir(), localName), out);
      synced[id] = { sha256: got, localSha: hashText(out), syncedAt: Date.now() };
      saveSynced(synced);
      personas?.catalog?.invalidate?.();

      const localId = localName.replace(/\.md$/i, '');
      if (localId !== String(file).replace(/\.md$/i, '')) {
        personas.prefs.patch({ installedAs: { [id]: localId } });
      }
      /** 装回来 = 当没删过，墓碑一起清掉（仓库 id 和本地 id 都可能是墓碑） */
      const gone = [...new Set([id, localId, inst[id]].filter(Boolean))];
      if (gone.some((x) => prefsNow.deleted?.includes(x))) {
        personas.prefs.patch({ deleted: prefsNow.deleted.filter((x) => !gone.includes(x)) });
      }

      return { ok: true, id, name: p.name, localId, injected, risky: scanPersona(out) };
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
      const inst = personas?.prefs?.read?.().installedAs ?? {};
      const localName = localNameFor(id, file, inst);
      const text = await getText(`${index.base}/${file}`);
      const got = hashText(text);
      if (got !== p.sha256) throw new Error(`内容校验失败（索引说 ${String(p.sha256).slice(0, 8)}…，实际 ${got.slice(0, 8)}…）`);

      const { text: out, injected } = withToolsDefault(text, !isBuiltin(file) || localDeclaresTools(id, file, inst));
      const saved = backup(id, localName);
      writeAtomic(join(dir(), localName), out);
      personas?.catalog?.invalidate?.();
      const synced = readSynced();
      synced[id] = { sha256: got, localSha: hashText(out), syncedAt: Date.now() };
      saveSynced(synced);

      /**
       * 恢复成功要把墓碑清掉。
       *
       * 不清的话：文件虽然回来了，但下次 `seed()` 仍会跳过它，
       * 而且一旦文件再丢（比如用户又误删一次别的），行为会变得很难解释。
       * 「恢复」的语义就是「当没删过」。
       */
      try {
        const p2 = personas?.prefs?.read?.();
        /** 墓碑可能记在仓库 id、本地 id（撞名安装）两个地方，一起清 */
        const gone = [...new Set([id, String(localName).replace(/\.md$/i, ''), inst[id]].filter(Boolean))];
        if (gone.some((x) => p2?.deleted?.includes(x))) {
          personas.prefs.patch({ deleted: p2.deleted.filter((x) => !gone.includes(x)) });
        }
      } catch {}

      return { ok: true, id, name: p.name, backup: saved, risky: scanPersona(out), injected };
    },
  };
}
