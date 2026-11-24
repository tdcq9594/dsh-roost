/**
 * 扩展市场：索引 → 下载校验 → 原子落位 → 权限初始化 → 受管块同步
 * =================================================================
 *
 * 复用插件仓的 `index.json`（方案 §8「不新建仓库」），但**不复用框架仓的
 * `market.js` 进程**：那个模块跑在 qq-bot-roost 里、装的是框架插件；扩展要装到
 * dsh-roost 自己的 `<dataDir>/extensions/`，跨进程。这里只抄它的形态
 * （安全 URL 校验 / 索引结构 / 更新按哈希判），落位全部走阶段 1 的
 * `ext-registry.install()` —— 那份已经有原子 rename、foreign 保护、`.source.json`。
 *
 * 五条硬约束：
 *   1. 索引地址只允许 https（本机回环可 http），`file://` / 内网一律拒；
 *   2. 下载后先算目录哈希，与索引的 `sha256` 比对，不一致不落位；
 *   3. 先写暂存目录，校验通过才 `registry.install()` 原子上位；
 *   4. `revoked` 条目拒装；已装实例由 `revoke()` 加 `forceDeny`（跨档硬否决）；
 *   5. 受管块由 `ext-patch.js` 生成，只含引用名与固定 `command`，
 *      **不接受扩展仓下发的任何 `env` / `!!js` / YAML tag**（§8.2 第 3 条）。
 */
import fs from 'node:fs';
import { isIP } from 'node:net';
import { assertSafeUrl } from './ssrf.js';
import { join } from 'node:path';

import { dataDir } from './config.js';
import { EXT_ID_RE, MANIFEST_FILE, sensitiveScopesOf } from './ext-registry.js';
import { hashDir, extractTarGz, pickSubtree, writeFiles, rmrfSync } from './ext-bundle.js';
import { normalizeTags, categoryOf, filterMarketRows, facetsOf, phaseView } from './market-browse.js';
import { deriveTier, riskLines, installNotice } from './ext-tier.js';
import { EXT_REPO, giteeRepoOf } from './repo.js';

/** 读一份 JSON：读不到返回 null（清单损坏时按「没有 scope 声明」处理，不崩）。 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export const EXT_KIND = 'dsh-extension';
/** 官方插件仓。GitHub 与 Gitee 的 owner 不同，换算见 ./repo.js */
export const DEFAULT_EXT_REPO = EXT_REPO;
export const DEFAULT_EXT_INDEX_URL = `https://raw.githubusercontent.com/${DEFAULT_EXT_REPO}/main/index.json`;

function isLoopbackHost(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * 索引地址白名单。`file://` 会让本地文件变成「远程索引」，内网 http 可被
 * 中间人替换成任意 `command` —— 默认两者都拒。本机回环留给测试与自建镜像。
 *
 * **内网 http 镜像要显式放行**（`allowPrivate`，来自 `security.ssrf.allowPrivate`）：
 * 自建镜像多半是 `http://192.168.x.x/index.json`，一路 https 强求等于把这个
 * 用法堵死。放行之后**运行期仍由 `ssrf.js` 逐 IP 校验**（`marketGuardOpts`
 * 已经把 allowPrivate 传下去了），所以这里只是「静态白名单」这一层松口，
 * 不是把 SSRF 防护整个关掉。
 *
 * @param {string} raw
 * @param {{allowPrivate?:boolean}} [o]
 */
export function assertSafeIndexUrl(raw, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('索引地址不是合法 URL'); }
  if (u.protocol === 'https:') return u.href;
  if (u.protocol !== 'http:') throw new Error('索引地址必须是 http(s)');
  if (isLoopbackHost(u.hostname)) return u.href;
  if (allowPrivate) return u.href;
  throw new Error('索引地址必须是 https（或本机回环 http）；要用内网 http 镜像，先在「安全 → 网络访问」里打开「允许访问内网」');
}

/**
 * 一条索引记录是不是 DSH 扩展。
 *
 * 优先认 `kind`。过渡期兼容：索引还没按 kind 升级时，扩展条目没有 `version`
 * 且带 `transport` —— 用这个特征认，避免「索引没重签就一个扩展都看不到」。
 */
export function isExtensionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === EXT_KIND) return true;
  return !entry.kind && typeof entry.transport === 'string' && !entry.version;
}

export function pickExtensions(index) {
  const list = Array.isArray(index?.plugins) ? index.plugins : [];
  return list.filter(isExtensionEntry);
}

/**
 * 索引条目声明的「各族哈希」。
 *
 * 2026-11-22 的坑：索引按 algo2（排除文档）重算，运行中的 1.4.0 还按 algo1
 * 校验，带 README 的包一律 sha256 不匹配。插件仓现在双写：
 *   · `sha256`    —— algo1，老版本 1.4.0 认这个，保证旧用户装得上；
 *   · `sha256_v2` —— algo2，新版本优先用这个，文档/运行时状态不进指纹。
 * 旧索引只有 `sha256` 且值是 algo2，新安装器两个算法都算一遍、认任一匹配，
 * 过渡期不会把用户卡在「索引刚换、客户端还没升」的窗口里。
 */
export function entryHashes(entry) {
  const out = { legacy: '', current: '' };
  const v1 = String(entry?.sha256 ?? '').toLowerCase();
  const v2 = String(entry?.sha256_v2 ?? '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(v1)) out.legacy = v1;
  if (/^[0-9a-f]{64}$/.test(v2)) out.current = v2;
  return out;
}

/** 用于展示 / 更新判定的权威哈希：新字段在就用新的，否则退回老字段。 */
function entryHash(entry) {
  const { legacy, current } = entryHashes(entry);
  return current || legacy;
}

/**
 * 已装实例记录的 sha256 是否等于索引声明的**任一算法**结果。
 *
 * 老版本 1.4.0 装扩展时 `.source.sha256` 记的是 algo1 值；索引双写后权威值
 * 变成 algo2。两个哈希是针对同一份磁盘内容算的，不该因为算法换代就误判成
 * 「有新版 / 需要重装」——用户装的代码一个字都没变。
 */
function installedMatchesDeclared(installed, entry) {
  const sha = String(installed ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) return false;
  const { legacy, current } = entryHashes(entry);
  return sha === current || sha === legacy;
}

/** 撤回：顶层 `revoked:[id]`，或条目上 `revoked:true` / `revoked:[version]`。 */
export function isRevoked(index, entry) {
  const top = Array.isArray(index?.revoked) ? index.revoked : [];
  if (top.includes(entry?.id)) return true;
  const r = entry?.revoked;
  if (r === true) return true;
  if (Array.isArray(r) && r.includes(entry?.version)) return true;
  return false;
}

/**
 * 索引与分发包的**来源**。
 *
 * 为什么要有这个：`raw.githubusercontent.com` 与 `codeload.github.com` 在国内
 * 经常被重置（面板报「连接被重置」），而市场读的就是这两个域名。我们自己一直在
 * 同步 Gitee 镜像，同一个 `index.json` 两边字节数完全一致（实测 14981），
 * 归档结构也一样是「单层顶层目录」——所以换源只是换两个 URL，不用改下载逻辑。
 *
 *   · `github` 默认，官方源
 *   · `gitee`  镜像源（同一份仓库，`raw` 会 302 到 `raw.giteeusercontent.com`）
 *   · `custom` 自建镜像 / 内网源，地址由用户填（仍要过 `assertSafeIndexUrl`）
 */
export const MARKET_SOURCES = ['github', 'gitee', 'custom'];

/**
 * 覆盖 / 删除手写目录的整目录备份，默认保留天数。
 * 与 `config.extensions.backupKeepDays` 的默认值一致；配置读不到时退回它。
 */
export const BACKUP_KEEP_DEFAULT_DAYS = 7;

/** 仓库 slug（`owner/repo`）与分支 → 索引地址 */
export function indexUrlFor({ source = 'github', indexUrl = '', repo = '', branch = 'main' } = {}) {
  const src = MARKET_SOURCES.includes(source) ? source : 'github';
  if (src === 'custom') return String(indexUrl ?? '').trim();
  if (!repo) return DEFAULT_EXT_INDEX_URL;
  const ref = encodeURIComponent(branch || 'main');
  return src === 'gitee'
    ? `https://gitee.com/${giteeRepoOf(repo)}/raw/${ref}/index.json`
    : `https://raw.githubusercontent.com/${repo}/${ref}/index.json`;
}

/** 仓库 slug 与分支 → 整仓归档地址（两边都是「单层顶层目录」的 tar.gz） */
function tarballUrl(repo, branch = 'main', source = 'github') {
  const ref = encodeURIComponent(branch || 'main');
  return source === 'gitee'
    ? `https://gitee.com/${giteeRepoOf(repo)}/repository/archive/${ref}.tar.gz`
    : `https://codeload.github.com/${repo}/tar.gz/refs/heads/${ref}`;
}

/** 允许的分发包主机：与索引一样属于供应链入口，不能放开到任意 https。 */
const TARBALL_HOSTS = new Set(['codeload.github.com', 'github.com', 'objects.githubusercontent.com', 'gitee.com']);

/**
 * 代码里写死、不归攻击者控制的供应链主机。它们的 DNS 结果**不参与**
 * 逐 IP 网段校验（别的检查照旧）：
 *
 *   · 这几个域名不存在 rebinding 的余地——谁也没法把
 *     `raw.githubusercontent.com` 指到自己内网；
 *   · 但 Clash / mihomo 的 fake-ip 模式默认把 `198.18.0.0/16` 当假地址池，
 *     这些域名会被解析成 `198.18.x.x`，逐 IP 校验把它当保留段拒掉，
 *     结果「挂了代理的正常用户」插件市场永远打不开（1.3.1 实测报错：
 *     `域名解析到内网地址 198.18.0.32，拒绝访问`）。
 *
 * 官方实现（openclaw 的 `ssrf-guard.ts`）也是同样的取舍：QQ 官方域名白名单免解析。
 */
const TRUSTED_HOSTS = ['raw.githubusercontent.com', 'github.com', 'codeload.github.com',
  'objects.githubusercontent.com',
  /** Gitee 镜像：`raw` 会 302 到 `raw.giteeusercontent.com`，两个都要认 */
  'gitee.com', 'raw.giteeusercontent.com'];

/**
 * 把 `config.security.ssrf` 翻成 `assertSafeUrl` 的选项。
 *
 * 1.3.1 的两个字段是**死配置**：`allowPrivate` / `allowHosts` 写进 config 后
 * 没有任何一处读它，面板上「显式放行的域名：N 个」读的是个没人用的字段。
 * 这里补上接线，同时做三道收窄：
 *   · 字面 IP 不进白名单（白名单是「哪个域名可以访问」，不是「哪个 IP」）；
 *   · 索引主机只在它是域名时才当可信（本机镜像走 `allowLoopback`）；
 *   · `allowPrivate` 只放开局域网私有段，回环 / 云元数据 / 保留段仍由
 *     `ssrf.js` 的 `blockedIp` 拦。
 */
export function marketGuardOpts(ssrfCfg, indexUrl = DEFAULT_EXT_INDEX_URL) {
  const cfg = ssrfCfg && typeof ssrfCfg === 'object' ? ssrfCfg : {};
  const allowHosts = (Array.isArray(cfg.allowHosts) ? cfg.allowHosts : [])
    .map((h) => String(h ?? '').trim().toLowerCase())
    .filter((h) => h && !isIP(h));
  const trustedHosts = [...TRUSTED_HOSTS];
  try {
    const h = new URL(String(indexUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h && !isIP(h) && !trustedHosts.includes(h)) trustedHosts.push(h);
  } catch {
    /** indexUrl 不合法时由 assertSafeIndexUrl 报错，这里不抢跑 */
  }
  return { allowPrivate: cfg.allowPrivate === true, allowHosts, trustedHosts };
}

export function assertSafeTarballUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('分发包地址不是合法 URL'); }
  if (u.protocol !== 'https:') throw new Error('分发包地址必须是 https');
  if (!TARBALL_HOSTS.has(u.hostname)) throw new Error(`分发包主机不在白名单：${u.hostname}`);
  return u.href;
}

/**
 * 把 undici 的 `TypeError: fetch failed` 翻成人能看的错误。
 *
 * 面板以前原样显示 `fetch failed` —— 那是 undici 的兜底文案，真正的原因在
 * `e.cause.code` 里（ENOTFOUND / ECONNREFUSED / ETIMEDOUT / 证书类…）。
 * 四个英文单词既没说是 DNS 还是代理，也没说下一步做什么，用户只能猜。
 *
 * 顺带说清一件事：Node 的 `fetch` **不读** `HTTP_PROXY` / `HTTPS_PROXY`。
 * 只开了系统代理的机器上，浏览器能打开 `raw.githubusercontent.com`，
 * 这里照样 `ECONNREFUSED` —— 不是配置错了，是根本没走代理。
 */
export function describeFetchError(e, { url = '', timeoutMs = 0 } = {}) {
  const cause = e?.cause ?? null;
  const code = String(cause?.code ?? cause?.errno ?? '').trim();
  let host = '';
  try { host = new URL(String(url)).host; } catch { /* 地址本身不合法时就不提主机 */ }
  const at = host ? `（${host}）` : '';

  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return `请求超时${at}：${Math.round(timeoutMs / 1000)} 秒内没有响应`;
  }

  switch (code) {
    case 'ENOTFOUND':
      return `域名解析不出来${at}：DNS 失败，检查网络或 hosts`;
    case 'EAI_AGAIN':
      return `DNS 查询超时${at}：网络抖动，重试一次通常就好`;
    case 'ECONNREFUSED':
      return `连接被拒绝${at}：本机代理没开，或者端口不对（Node 的 fetch 不读系统代理设置）`;
    case 'ECONNRESET':
      return `连接被重置${at}：代理或防火墙中断了这次请求`;
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return `连接超时${at}：网络不通，或者需要代理（Node 的 fetch 不读系统代理设置）`;
    case 'UND_ERR_HEADERS_TIMEOUT':
      return `等响应头超时${at}：对方太慢，或者链路被卡住`;
    case 'UND_ERR_SOCKET':
      return `连接被对端关闭${at}：长连接失效，重试一次通常就好`;
    case 'CERT_HAS_EXPIRED':
      return `TLS 证书过期${at}：可能有中间人代理`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `TLS 证书不可信${at}：可能有中间人代理`;
    default:
      break;
  }
  const detail = code || String(e?.message ?? e ?? '').trim() || '未知原因';
  return `网络请求失败${at}：${detail}`;
}

/**
 * 出站拉取：网络错误重试一次，HTTP 层错误不重试。
 *
 * 为什么重试只给网络错误：`ECONNRESET` / `UND_ERR_SOCKET` 多半是复用的长连接
 * 已经死了，换一条新的就好；而 4xx 是地址或权限问题、5xx 重试一次也一样，
 * 重试只会让用户多等一轮还看到同一个错。
 *
 * @param {string} url
 * @param {object} [guard] `marketGuardOpts()` 的结果
 * @param {{retry?:number, timeoutMs?:number, fetchImpl?:Function, waitFn?:Function}} [o]
 */
export async function defaultFetchText(url, guard = {}, {
  retry = 1, timeoutMs = 30_000, fetchImpl = fetch,
  waitFn = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  /**
   * 5.11：主机白名单只挡了「字面地址」，挡不住域名解析到 127.0.0.1 /
   * 169.254.169.254（DNS rebinding）。出站前逐 IP 再校一次。
   * 索引允许本机回环 http（自建镜像），与 assertSafeIndexUrl 口径一致。
   */
  await assertSafeUrl(url, { allowLoopback: true, ...guard });

  let last = null;
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`拉索引失败：HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      /** HTTP 状态码是明确的答复，重试没有意义；只有「没连上」才值得再来一次 */
      if (/^拉索引失败：HTTP /.test(String(e?.message ?? ''))) break;
      if (attempt < retry) await waitFn(400);
    }
  }
  throw new Error(describeFetchError(last, { url, timeoutMs }));
}

/** 给进度文案用：字节数说人话，别把 12345678 直接糊到面板上。 */
export function formatBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/** 默认下载：GitHub codeload 的 tar.gz → 剥顶层 → 取 `entry.path` 子树 → 安全落盘。 */
async function defaultDownload(entry, dest, { repo, branch, source = 'github', guard = {}, onProgress = null } = {}) {
  const raw = entry.tarball || (repo ? tarballUrl(repo, branch, source) : '');
  if (!raw) throw new Error('索引条目缺 tarball，且索引里没有 repo 可拼下载地址');
  const url = assertSafeTarballUrl(raw);
  /**
   * 分发包同样要过统一校验。`assertSafeTarballUrl` 已经把主机锁在
   * `TARBALL_HOSTS` 内，这里补的是 DNS 那一层（同样受 fake-ip 影响）。
   */
  await assertSafeUrl(url, guard);
  /** 下载失败同样要把 `fetch failed` 翻成人话——60 秒的等待换四个英文单词太亏 */
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new Error(describeFetchError(e, { url, timeoutMs: 60_000 }));
  }
  if (!res.ok) throw new Error(`下载分发包失败：HTTP ${res.status}`);
  /**
   * `redirect:'follow'` 只校验首跳；白名单主机自己 302 到别处就绕过了。
   * 拿最终 URL 再校一次（codeload → objects.githubusercontent.com 在白名单内）。
   */
  const finalUrl = res.url || url;
  assertSafeTarballUrl(finalUrl);
  /**
   * 整仓 tar.gz 动辄几十秒，一口气 `arrayBuffer()` 会让进度条一直停在
   * 「正在下载扩展包」像死机。改成按块读、每 256 KB 报一次字节数；
   * 没有可读流（部分测试 / 自定义运行时）时退回一次性读，行为不变。
   */
  const total = Number(res.headers?.get?.('content-length')) || 0;
  const chunks = [];
  let got = 0;
  let lastReport = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      chunks.push(buf);
      got += buf.length;
      if (got - lastReport >= 256 * 1024) {
        lastReport = got;
        onProgress?.(got, total);
      }
    }
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    chunks.push(buf);
    got = buf.length;
  }
  onProgress?.(got, total);
  const files = pickSubtree(extractTarGz(Buffer.concat(chunks), { strip: 1 }), entry.path || '');
  if (!files.size) throw new Error(`分发包里找不到 ${entry.path || '(根目录)'}`);
  // rejectSkips：跳过目录不参与哈希，就绝不能落盘，否则 sha256 白算。
  await writeFiles(dest, files, { rejectSkips: true });
  return files.size;
}

/**
 * @param {object} o
 * @param {string} [o.dir]           数据目录（暂存目录在它下面的 `.market-tmp/`）
 * @param {string} [o.indexUrl]
 * @param {object} o.registry        createExtRegistry() 实例
 * @param {object} [o.extGroups]     createExtGroups() 实例（安装即初始化权限）
 * @param {object} [o.extPatch]      createExtPatch() 实例（受管块）
 * @param {object} [o.capStore]      createCapabilityStore() 实例（撤回联动）
 */
export function createExtMarket({
  dir = dataDir(),
  indexUrl = DEFAULT_EXT_INDEX_URL,
  /**
   * 数据源：`{ source: 'github' | 'gitee' | 'custom', indexUrl: '自建地址' }`。
   * 传 getter 而不是值——面板上换源不该要求重启进程。
   * 显式传了 `indexUrl` 参数（测试 / 内嵌）时以那个为准。
   */
  marketCfg = () => ({}),
  /** `null` = 用默认实现（带 SSRF 校验）；注入自定义实现时校验由调用方负责 */
  fetchText = null,
  download = null,
  /**
   * `config.security.ssrf`：可以是对象，也可以是 getter（配置热更新后即时生效）。
   * 不传 = 按 1.3.1 的老口径（只放行本机回环）。
   */
  ssrf = {},
  /**
   * 索引验签钩子（`({url, text}) => {ok, why}`）。
   *
   * 默认 `null` = 不验签。方案 §10.1 6.3 要求「全量 `sign-index --verify` →
   * **单独问主人** → 打开 `EMBEDDED_ENFORCE`」，在那之前不自行加验签拦截；
   * 这里先把接线点留好：6.3 打开时注入一个复用框架 `trust.js` 同算法的验签器，
   * 失败即拒装。当前不注入 = 只靠 https + sha256 两道，属已知边界（台账已记）。
   */
  verifyIndex = null,
  registry,
  extGroups = null,
  extPatch = null,
  capStore = null,
  /**
   * 更新已装扩展时，等 DSH 释放扩展目录的最长时间（ms）。
   * Windows 上扩展子进程的 cwd 就在 `<dataDir>/extensions/<id>/`，
   * `registry.install()` 的原子 rename 会拿到 EBUSY；摘掉受管块后 DSH
   * 需要一点时间 dispose 连接。超时不硬杀进程（官方 dsh-mcp-client 默认
   * 500ms 自动重连，杀掉只会撞进落位窗口），而是保留原扩展、如实报错。
   */
  pauseTimeoutMs = 5_000,
  /** 可注入的等待函数：测试不必真等 5 秒 */
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  now = () => Date.now(),
  ttlMs = 5 * 60_000,
} = {}) {
  if (!registry || typeof registry.install !== 'function') {
    throw new Error('createExtMarket 需要 registry');
  }
  const readSsrf = typeof ssrf === 'function' ? ssrf : () => ssrf;
  /**
   * 现读配置，**读不到就当没配**。
   *
   * 这是运行期高频路径（面板 status、每次出站都走），而 `marketCfg` 由宿主注入、
   * 里面读的是还没完全初始化的 `cfg` 闭包。它抛一次，面板整个扩展页就报错，
   * 而这里的信息（用哪个源）本来就有安全的默认值——吞掉比炸掉合理。
   */
  const marketCfgNow = () => {
    try { return marketCfg() || {}; } catch { return {}; }
  };
  /**
   * 当前数据源。每次调用现读配置：面板上换源立刻生效，不用重启。
   * 显式传了 `indexUrl` 参数（测试 / 内嵌）时那个说了算，不受 source 影响。
   */
  const sourceNow = () => {
    const s = String(marketCfgNow().source ?? '').trim();
    return MARKET_SOURCES.includes(s) ? s : 'github';
  };
  const indexUrlNow = () => {
    if (indexUrl && indexUrl !== DEFAULT_EXT_INDEX_URL) return indexUrl;
    return indexUrlFor({
      source: sourceNow(),
      indexUrl: marketCfgNow().indexUrl,
      repo: DEFAULT_EXT_REPO,
      branch: 'main',
    }) || DEFAULT_EXT_INDEX_URL;
  };
  /** 面板用：当前生效的是哪一源、解析出的地址是什么 */
  const sourceInfo = () => ({
    ok: true,
    source: sourceNow(),
    sources: MARKET_SOURCES,
    indexUrl: indexUrlNow(),
    /** 自建源才有意义；预设源这里是空串，面板据此决定要不要显示输入框 */
    customUrl: String(marketCfgNow().indexUrl ?? ''),
  });

  /** 每次出站都重算：面板改了 SSRF 白名单 / 换了源都不该要求重启进程 */
  const guardNow = () => marketGuardOpts(readSsrf(), indexUrlNow());
  const fetchIndex = fetchText ?? ((url) => defaultFetchText(url, guardNow()));
  const downloadPkg = download
    ?? ((entry, dest, opts) => defaultDownload(entry, dest, { ...opts, guard: guardNow() }));
  const tmpRoot = join(dir, '.market-tmp');
  /**
   * 正在装 / 卸的扩展 id。
   *
   * 没有这道闸时，面板连点两下「安装」会同时进 `installInner`：两条流程
   * 抢同一个 `tmpRoot/<id>` 暂存目录（后一个的 `rmrfSync` 会把前一个正在写的
   * 文件删掉），落位后还会各写一遍受管块。表现是随机的「哈希不符」或者
   * 「装完扩展起不来」——比直接说「正在装，等它跑完」糟得多。
   *
   * 锁是**进程内**的：跨进程（多开 DSH）仍需靠 `registry.install` 的原子 rename 兜底。
   */
  const running = new Set();
  let cache = null;

  /**
   * 5.6 安装进度：下载 + 校验是几秒到几十秒的黑盒，面板要能说清「到哪一步了」。
   * 进度存在进程内存里，面板轮询 `progress()`；不落盘、不进日志、不影响安装结果。
   */
  let progressState = phaseView(null);
  const setPhase = (phase, message = '', id = '') => {
    progressState = phaseView({ phase, message, id, at: now() });
  };
  const progress = () => ({ ok: true, ...progressState });

  async function index({ refresh = false } = {}) {
    const t = now();
    if (!refresh && cache && t - cache.at < ttlMs) return cache.value;
    const url = assertSafeIndexUrl(indexUrlNow(), { allowPrivate: readSsrf()?.allowPrivate === true });
    const text = await fetchIndex(url);
    if (typeof verifyIndex === 'function') {
      const v = await verifyIndex({ url, text });
      if (!v?.ok) throw new Error(`索引验签未通过：${v?.why ?? '签名缺失或不匹配'}`);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('索引不是合法 JSON'); }
    if (!data || !Array.isArray(data.plugins)) throw new Error('索引缺 plugins 数组');
    cache = { at: t, value: data };
    return data;
  }

  const localById = () => new Map(registry.list().map((e) => [e.id, e]));

  /** 市场列表：把索引与本地状态并成一行一扩展，面板直接用。
   * 5.6：搜索 / 分类 / 标签都在这一层筛，面板不再自己写一份筛选规则。 */
  async function list({ refresh = false, q = '', category = '', tag = '' } = {}) {
    const idx = await index({ refresh });
    const local = localById();
    /**
     * 已装实例被索引标成 `revoked` 时**自动**加 forceDeny（幂等）。
     * 只在 list 里打标记不动手，等于「面板说撤回了、工具还能调」——
     * §8.3 明确要防的就是这个。能力页未启用时 revoke 自己会返回 no-op。
     */
    for (const e of pickExtensions(idx)) {
      if (local.get(e.id) && isRevoked(idx, e)) {
        try { revoke(e.id, { reason: '索引标记 revoked' }); } catch { /* 旁路 */ }
      }
    }
    const rows = pickExtensions(idx).map((e) => {
      const mine = local.get(e.id);
      const installedHash = mine?.source?.sha256 ?? '';
      const declaredHash = entryHash(e);
      /**
       * 等级由索引里的原始声明现算：作者不能在清单里自填等级。
       * verified 也只认索引（build-index 从维护者的 verified.json 灌入），
       * 审核过的扩展在这里就要按 L2 封顶，和安装确认算出同一个等级。
       */
      const tier = deriveTier(e, { verified: e.verified });
      return {
        id: e.id,
        name: e.name ?? e.id,
        description: e.shortDesc ?? e.description ?? '',
        version: e.version ? String(e.version) : '',
        sha256: declaredHash,
        path: e.path ? String(e.path) : '',
        transport: e.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        author: e.author ? String(e.author) : '',
        /** 5.6：分类取首个标签（索引将来有 category 就听它的），标签全量带回去 */
        tags: normalizeTags(e),
        category: categoryOf(e),
        commands: Array.isArray(e.commands) ? e.commands.map(String).slice(0, 12) : [],
        runtime: e.runtime ? String(e.runtime) : '',
        verified: e.verified ? String(e.verified) : '',
        installed: Boolean(mine),
        foreign: Boolean(mine?.foreign),
        updateAvailable: Boolean(mine && declaredHash && installedHash && !installedMatchesDeclared(installedHash, e)),
        revoked: isRevoked(idx, e),
        label: isRevoked(idx, e) ? '已撤回，拒绝安装' : '',
        /** 市场卡片徽章 + 风险明细（主人 2026-11-14 要求「按权限等级明确告知风险」） */
        tier: tier.id, tierLabel: tier.label, tierColor: tier.color,
        tierSummary: tier.summary, risks: riskLines(tier),
        scopes: tier.scopes, overrides: tier.overrides,
        form: tier.form, formLabel: tier.formLabel,
      };
    });
    return {
      ok: true,
      rows: filterMarketRows(rows, { q, category, tag }),
      /** 筛选前的总数与可选值，面板才有得写「显示 N / M 条」和下拉 */
      total: rows.length,
      facets: facetsOf(rows),
      repo: idx.repo ?? '', branch: idx.branch ?? 'main',
    };
  }

  /**
   * 安装一条。顺序固定：撤回 → foreign → 下载 → 哈希 → 落位 → 权限 → 受管块。
   * 后两步失败不回滚扩展本体（已经装好了，删掉反而更糟），以 `warnings` 返回。
   */
  /**
   * 落位重试：只重试「目录被占用」，其余错误原样返回。
   *
   * 判据用 `registry.install()` 的真实结果，不猜「DSH 是否已经释放目录」——
   * HMR 在真机 desktop 上没有实测保证，假设它生效会在目录还被占着时继续
   * 往下走。`registry.install()` 失败自带回滚（原目录不动），所以重试安全。
   */
  async function installWithBusyRetry(staging, source, key, { intervalMs = 200, takeOver = false } = {}) {
    const deadline = now() + pauseTimeoutMs;
    for (;;) {
      const r = registry.install(staging, { source, takeOver });
      if (r.ok) return r;
      const busy = r.code === 'EBUSY' || r.code === 'EPERM' || r.code === 'EACCES';
      if (!busy) return r;
      if (now() >= deadline) {
        return {
          ok: false, reason: 'ext_busy',
          message: `扩展仍在运行，DSH 未及时释放目录（${pauseTimeoutMs / 1000}s 内一直被占用）；原扩展已保留，请重启 DSH 后重试`,
        };
      }
      setPhase('pause', '正在等待扩展释放目录', key);
      await wait(intervalMs);
    }
  }

  /**
   * 5.6：包一层统一收尾。installInner 里失败分支很多（索引失败 / 已撤回 /
   * foreign / 哈希不符 / 要确认权限…），在外面统一设终态，进度条不会卡在
   * 「下载中」不动。
   */
  async function install(id, opts = {}) {
    const key = String(id ?? '');
    /** 同 id 已经在装：直接拒，别让两条流程抢同一个暂存目录 */
    if (running.has(key)) {
      return {
        ok: false, reason: 'busy',
        message: `「${key}」正在安装，等这一轮跑完再点（面板上的进度条就是它）`,
      };
    }
    running.add(key);
    try {
      setPhase('index', '正在准备安装', key);
      const r = await installInner(key, opts);
      if (r?.ok) setPhase('done', r.message || '已安装', key);
      else if (r?.reason === 'needs_scope_confirm' || r?.reason === 'needs_tier_confirm') setPhase('confirm', r.message || '等待确认权限', key);
      else setPhase('failed', r?.message || '安装失败', key);
      return r;
    } finally {
      running.delete(key);
    }
  }

  /**
   * 覆盖 / 删除「用户手写」目录之前**整目录备份**。
   *
   * 为什么必须备份：那类目录里的东西不是我们装的，可能是人家手写的代码，
   * 也可能是运行时数据（`imagegen` 的 `gallery.json` 就是画作库索引）。
   * 删了/覆盖了就真没了。
   *
   * 放在 `data/backups/ext-<id>-<时间>/`：和 `data/` 其它东西同级，
   * 用户找得到、也不受扩展目录清理影响。备份失败**一律中止**，宁可这次
   * 操作不做，也不要在没有退路的情况下覆盖。
   */
  /**
   * 备份保留天数。配置读不到 / 不合法就按默认 7 天——**这里不能报错也不能清成
   * 「永久保留」**：漏清一次不会坏事，但一个坏配置把退路全删光就不可逆了。
   * `<= 0` 是唯一表示「永久保留」的值（用户显式要的）。
   */
  function backupKeepDaysNow() {
    const raw = Number(marketCfgNow().backupKeepDays);
    if (!Number.isFinite(raw)) return BACKUP_KEEP_DEFAULT_DAYS;
    return raw;
  }

  /**
   * 清掉过期的自动备份。
   *
   * 只认 `ext-<id>-YYYYMMDD-HHMMSS` 这个格式（我们自己写的），**其它目录一律不碰**
   * ——`backups/` 就在 `data/` 下面，用户很可能也往里放东西。时间从**目录名**解析
   * 而不是 mtime：`cpSync` 出来又搬过一次的目录，mtime 会被改写。
   *
   * 删除失败只记 warn：清理是收尾动作，不能因为它让这次安装 / 卸载失败。
   */
  function pruneBackups() {
    const keep = backupKeepDaysNow();
    if (!(keep > 0)) return { removed: 0 };
    const root = join(dir, 'backups');
    let names = [];
    try { names = fs.readdirSync(root); } catch { return { removed: 0 }; }
    const cutoff = now() - keep * 24 * 3600 * 1000;
    let removed = 0;
    for (const name of names) {
      const m = /^ext-(.+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
      if (!m) continue;
      const at = new Date(
        Number(m[2]), Number(m[3]) - 1, Number(m[4]),
        Number(m[5]), Number(m[6]), Number(m[7]),
      ).getTime();
      if (!Number.isFinite(at) || at >= cutoff) continue;
      try { rmrfSync(join(root, name)); removed += 1; }
      catch (e) { log.warn?.(`[ext-market] 旧备份清不掉（${name}）：${e?.message ?? e}`); }
    }
    if (removed) log.info?.(`[ext-market] 已清理 ${removed} 份过期备份（保留 ${keep} 天）`);
    return { removed };
  }

  function backupForeign(id) {
    const src = registry.pathOf(id);
    if (!fs.existsSync(src)) return '';
    const root = join(dir, 'backups');
    const d = new Date(now());
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const dest = join(root, `ext-${id}-${stamp}`);
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    /**
     * 备份成功之后再清旧的：先删后拷的顺序，万一拷贝失败会连退路一起没了。
     */
    pruneBackups();
    return dest;
  }

  async function installInner(id, { confirmScopes = false, confirmTier, force = false, takeOver = false } = {}) {
    const key = String(id ?? '');
    if (!EXT_ID_RE.test(key)) return { ok: false, reason: 'bad_id', message: '扩展 id 不合法' };

    let idx;
    try { idx = await index({ refresh: true }); }
    catch (e) { return { ok: false, reason: 'index_failed', message: `索引拉取失败：${e?.message ?? e}` }; }

    const entry = pickExtensions(idx).find((e) => e.id === key);
    if (!entry) return { ok: false, reason: 'not_found', message: `索引里没有扩展 ${key}` };
    if (isRevoked(idx, entry)) return { ok: false, reason: 'revoked', message: `${key} 已被撤回，拒绝安装` };
    /**
     * 用户手写目录**一律拒**，不给 force 后门：阶段 1 复核时已经把
     * `registry.install()` 的 force 口子删了（市场一旦能给，就等于开了
     * 覆盖用户文件的后门）。要接管就由用户自己删目录，那是他看得见的动作。
     */
    if (registry.isForeign(key)) {
      /**
       * 用户手写目录默认拒。带 `takeOver` 才放行，而且**先整目录备份**。
       *
       * 为什么改口（原注释写的是「一律拒，不给 force 后门」）：判据只看有没有
       * `.source.json`，而整目录拷进来（或手工解压）的**官方扩展**同样没有那个
       * 文件——用户会看到「有卸载按钮却没有、也换不成官方版」。真正的风险是
       * 覆盖掉用户手写的东西，那个风险靠**备份 + 面板二次确认**兜，不靠让人
       * 自己去文件管理器删目录（那才是最容易误删的动作）。
       */
      if (!takeOver) {
        return { ok: false, reason: 'foreign', message: `${key} 是用户手写的扩展，拒绝覆盖；要替换成官方版请确认后用 takeOver（会先备份）` };
      }
      try { backupForeign(key); }
      catch (e) { return { ok: false, reason: 'backup_failed', message: `备份失败，没有覆盖：${e?.message ?? e}` }; }
    }
    /**
     * 已是最新版就直接收工。以前「重装」会把整仓 tar.gz 再下一遍、重新落位、
     * 还轮换一次令牌（旧令牌立刻 401），用户切个页签回来再点一下就白挨这些。
     *
     * 判据与 `list()` 的 `updateAvailable` 同源：`.source.json` 里的目录哈希
     * 对索引声明的 sha256。`force` 是**唯一**绕过口子，留给「目录疑似坏了，
     * 想照着索引重新铺一遍」的场景，前端必须二次确认才给。
     * 短路不跳过撤回 / foreign / 哈希校验 —— 它只是不重复下载与落位。
     */
    const wantSha = entryHash(entry);
    const installedSha = typeof registry.list === 'function'
      ? String(registry.list().find((x) => x.id === key)?.source?.sha256 ?? '').toLowerCase()
      : '';
    if (!force && /^[0-9a-f]{64}$/.test(wantSha) && installedMatchesDeclared(installedSha, entry)) {
      return {
        ok: true, id: key, alreadyLatest: true,
        message: `扩展「${key}」已是最新版（${wantSha.slice(0, 12)}…），无需重复安装`,
      };
    }

    setPhase('download', '正在下载扩展包', key);
    const staging = join(tmpRoot, key);
    rmrfSync(staging);
    const warnings = [];
    /** 只要摘过受管块，任何出口（含抛错）都必须写回，绝不能把扩展留在离线状态 */
    let needsResume = false;
    const resume = () => {
      if (!needsResume) return;
      needsResume = false;
      setPhase('resume', '正在恢复扩展连接', key);
      try { syncBlock(); }
      catch (e) { warnings.push(`扩展连接未能自动恢复（${e?.message ?? e}）：请重载 DSH 或手动同步受管块`); }
    };
    try {
      /**
       * **必须有一个合法 sha256。** 缺了就无法校验内容，等于「索引说什么就装什么」；
       * `build-index.mjs` 对扩展一定会算哈希，所以拒掉不会误伤合法条目。
       */
      const { legacy, current } = entryHashes(entry);
      const want = current || legacy;
      if (!want) throw new Error('索引条目缺 sha256，拒绝安装（无法校验内容）');
      await downloadPkg(entry, staging, {
        repo: idx.repo,
        branch: idx.branch ?? 'main',
        /** 换源：Gitee 镜像的归档地址与 codeload 不同，但结构一样（单层顶层目录） */
        source: sourceNow(),
        /** 按字节回报，进度条不再几十秒一动不动像卡死 */
        onProgress: (got, total) => setPhase('download',
          `已下载 ${formatBytes(got)}${total ? ` / ${formatBytes(total)}` : ''}`, key),
      });
      setPhase('verify', '正在校验目录哈希', key);
      /** 先按新算法算；索引只有老字段时再按 algo1 算一遍，兼容旧镜像与 1.4.0 的索引。 */
      const gotNew = await hashDir(staging);
      let verifiedHash = '';
      if (gotNew === current || gotNew === legacy) {
        verifiedHash = gotNew;
      } else if (legacy) {
        const gotOld = await hashDir(staging, { algo: 1 });
        if (gotOld === legacy) verifiedHash = gotOld;
      }
      if (!verifiedHash) {
        throw new Error(`目录哈希与索引不一致（索引 ${want.slice(0, 12)}…，实际 ${gotNew.slice(0, 12)}…）`);
      }
      /**
       * 分级确认（2026-11-14 全放开配套）。
       *
       * 以前只把「敏感 scope 的英文名字」列出来，主人根本看不出
       * `agent:write` 意味着「会烧模型额度」。现在按 L0–L3 现算等级，
       * 逐条给人话后果（Chrome 权限警告那套），L3 额外说明「停用才能恢复」。
       *
       * 兼容：`confirmScopes:true` 仍是唯一必填确认，旧前端零改动可用；
       * 前端若传 `confirmTier`，L3 会再要求明确确认到该等级。
       */
      setPhase('scopes', '正在检查权限声明', key);
      const staged = readJson(join(staging, MANIFEST_FILE));
      const sens = sensitiveScopesOf(staged);
      /** 审核状态只从索引条目取（清单自填不认），和市场卡片算同一个等级 */
      const derived = deriveTier(staged, { verified: entry.verified });
      if ((derived.level >= 2 || sens.length) && confirmScopes !== true) {
        return {
          ok: false,
          reason: 'needs_scope_confirm',
          scopes: sens,
          tier: derived.id, tierLabel: derived.label, tierColor: derived.color,
          confirm: derived.confirm, risks: riskLines(derived),
          overrides: derived.overrides, form: derived.form,
          message: installNotice(derived, { name: entry.name ?? key }),
        };
      }
      if (confirmTier !== undefined && derived.level >= 3 && String(confirmTier) !== derived.id) {
        return {
          ok: false, reason: 'needs_tier_confirm', tier: derived.id,
          message: `扩展「${key}」是 ${derived.id}（${derived.label}）等级，需要明确确认后才能安装。${derived.summary}`,
        };
      }

      /**
       * 更新已装且正在运行的 stdio 扩展：落位前先摘掉它的受管块条目，
       * 让 DSH 自己 dispose 连接、放开目录。Windows 上扩展子进程的 cwd
       * 就是 `<dataDir>/extensions/<id>/`，不松开目录 rename 必然 EBUSY。
       * 新装 / 手写目录 / streamable-http 都不碰配置。
       */
      const local = typeof registry.list === 'function'
        ? registry.list().find((x) => x.id === key) : null;
      const needPause = Boolean(extPatch && local && !local.foreign
        && (local.manifest?.transport ?? 'stdio') === 'stdio');
      if (needPause) {
        setPhase('pause', '正在暂停扩展连接', key);
        needsResume = true;          // 先置位：render 半途抛错也要兜底恢复
        syncBlock({ exclude: key }); // ext-patch 自带备份 + 写后校验 + 逐字节回滚
      }

      setPhase('install', '正在落位', key);
      const source = {
        repo: idx.repo ?? '',
        branch: idx.branch ?? 'main',
        path: entry.path ?? '',
        sha256: verifiedHash,
        /**
         * 审核状态跟着落盘（只从索引取，不认清单自填）。已装页要复算同一个
         * 等级，缺了它的话「市场 L2、已装页 L3」又会对不上。
         */
        verified: entry.verified ?? '',
        installedAt: now(),
      };
      const r = await installWithBusyRetry(staging, source, key, { takeOver });
      if (!r.ok) {
        if (r.reason === 'ext_busy') return { ok: false, reason: r.reason, message: r.message, warnings };
        throw new Error(r.reason || '落位失败');
      }

      setPhase('finalize', '正在写权限组与受管块', key);
      if (extGroups) {
        try { extGroups.add(key, { label: entry.name ?? key, capStore }); }
        catch (e) { warnings.push(`权限组初始化失败：${e?.message ?? e}`); }
      }
      if (extPatch) {
        /** 写回完整受管块 = 恢复连接，DSH 重新拉起扩展时读到的是新代码 */
        if (needPause) setPhase('resume', '正在恢复扩展连接', key);
        try { syncBlock(); needsResume = false; }
        catch (e) { warnings.push(`受管块未写入：${e?.message ?? e}`); }
      } else {
        needsResume = false;
      }
      log.info?.(`已安装扩展 ${key}${warnings.length ? `（${warnings.length} 项待处理）` : ''}`);
      return {
        ok: true, id: key, warnings,
        message: warnings.length ? `已安装，但有 ${warnings.length} 项没接上：${warnings[0]}` : '已安装，下一条消息生效',
      };
    } catch (e) {
      /** 安装失败必须进日志环：面板只拿得到返回值，用户点一次就忘，报错却要能事后追。 */
      log.error?.(`安装扩展 ${key} 失败：${e?.message ?? e}`);
      return { ok: false, reason: 'install_failed', message: `安装失败：${e?.message ?? e}`, warnings };
    } finally {
      resume();                    // 幂等：正常路径已写回就不再动
      rmrfSync(staging);
    }
  }

  /**
   * 受管块按「当前已装 id」整块重算，不是增量追加 —— 卸载后不留悬空条目。
   *
   * `exclude` 只给更新流程用：落位前临时摘掉目标扩展的 `mcp-<id>` 条目，
   * 让 DSH 自己 dispose 连接、放开目录。不传时与旧行为完全一致。
   */
  function syncBlock({ exclude = '' } = {}) {
    if (!extPatch) return null;
    /**
     * 只给**市场装的**扩展写受管块。用户手写目录没有 secrets、也没经过
     * 索引校验，写进去只会让 DSH 拉起一个必然 401 的进程；§8.3 对手写的
     * 定位是「只读、面板不能卸」，不是代管。需要代管由用户自己加块。
     */
    const ids = registry.list()
      .filter((x) => !x.foreign)
      /**
       * **只给 stdio 形态写受管块。**
       *
       * `streamable-http` 没有可接管的子进程（方案 §5.4 第 6 条：不由宿主注入、
       * 只给配置片段）。写进受管块会生成 `command: node … ext-launcher.mjs`，
       * 而 launcher 读到 `transport: 'streamable-http'` 直接 `exit 1` ——
       * 面板显示「已装」，DSH 那边永远拉不起来，且 `failOnStartupError:false`
       * 让这个失败只落在日志里。
       */
      .filter((x) => (x.manifest?.transport ?? 'stdio') === 'stdio')
      .map((x) => x.id)
      .filter((x) => EXT_ID_RE.test(x) && x !== exclude);
    return extPatch.render(ids, { apply: true });
  }

  function remove(id, { force = false } = {}) {
    const key = String(id ?? '');
    if (!EXT_ID_RE.test(key)) return { ok: false, reason: 'bad_id', message: '扩展 id 不合法' };
    /**
     * 正在装同一个 id 时不许卸：卸载会删目录，而安装流程可能刚把暂存目录
     * rename 上来，两边撞在一起的结果是「装了一半的扩展 + 一条写坏的受管块」。
     */
    if (running.has(key)) {
      return { ok: false, reason: 'busy', message: `「${key}」正在安装，等这一轮跑完再卸载` };
    }
    /**
     * 手写目录：**先备份再删**。不备份就直接删，等于让「点错一下」变成
     * 不可恢复的丢代码。
     */
    let backup = '';
    if (registry.isForeign(key)) {
      if (!force) {
        return {
          ok: false, reason: 'foreign',
          message: `${key} 是用户手写的扩展；确认要删就带 force（会先备份到 data/backups/）`,
        };
      }
      try { backup = backupForeign(key); }
      catch (e) { return { ok: false, reason: 'backup_failed', message: `备份失败，没有删除：${e?.message ?? e}` }; }
    }
    running.add(key);
    try {
      const r = registry.remove(key, { force });
      if (!r.ok) return r;
      const warnings = [];
      if (extGroups) {
        try { extGroups.remove(key, { capStore }); }
        catch (e) { warnings.push(`权限组清理失败：${e?.message ?? e}`); }
      }
      try { syncBlock(); }
      catch (e) { warnings.push(`受管块未同步：${e?.message ?? e}`); }
      /**
       * `registry.remove()` 在 Windows 上可能回 `partial`：文件已删、目录被扩展
       * 进程占着。那个提示必须原样透到面板，不能在这里被一句「已卸载」盖掉——
       * 用户得知道目录还在、以及令牌其实已经吊销了。
       */
      const backupNote = backup ? `（原目录备份在 ${backup}）` : '';
      const base = r.partial ? `${r.message}${backupNote}` : (backup ? `已卸载${backupNote}` : '已卸载');
      const message = warnings.length ? `${base}；另有 ${warnings.length} 项没清干净` : base;
      return { ok: true, id: key, warnings, backup, partial: Boolean(r.partial), message };
    } finally {
      running.delete(key);
    }
  }

  /** 按目录哈希判更新（扩展没有 version 契约）。 */
  async function detectUpdates() {
    let idx;
    try { idx = await index({ refresh: true }); }
    catch (e) { return { ok: false, reason: 'index_failed', rows: [], message: `索引拉取失败：${e?.message ?? e}` }; }
    const local = localById();
    const rows = [];
    for (const e of pickExtensions(idx)) {
      const mine = local.get(e.id);
      if (!mine) continue;
      if (isRevoked(idx, e)) { try { revoke(e.id, { reason: '索引标记 revoked' }); } catch { /* 旁路 */ } continue; }
      const cur = mine.source?.sha256 ?? '';
      const declared = entryHash(e);
      if (declared && cur && !installedMatchesDeclared(cur, e)) {
        rows.push({ id: e.id, name: e.name ?? e.id, sha256: declared, installed: cur });
      }
    }
    return { ok: true, rows };
  }

  /**
   * 撤回联动：把 `mcp__<id>__*` 写进 `forceDeny`（阶段 1 的 C′ 支持通配且持久化）。
   *
   * 能力页未启用时**不写** `capabilities.json`（§4.2 两条路径：不存在就不创建）。
   * 这时旧规则本来就不给非 owner 扩展工具，已经在跑的也被 `GUEST_KEEP_TOOLS`
   * 白名单挡着；用户启用能力页时`ext-groups` 的合并会再走一遍。
   */
  function revoke(id, { reason = '索引标记 revoked' } = {}) {
    const key = String(id ?? '');
    if (!EXT_ID_RE.test(key)) return { ok: false, reason: 'bad_id', message: '扩展 id 不合法' };
    if (!capStore?.enabled?.()) {
      return {
        ok: false, reason: 'capabilities_disabled',
        message: '能力页未启用：旧规则下扩展工具本来就不给非 owner，启用后会自动拦',
      };
    }
    const cur = capStore.get();
    const before = Array.isArray(cur?.forceDeny) ? cur.forceDeny : [];
    const rule = `mcp__${key}__*`;
    /** 已经拦着就什么都不做：`list()` 每次开面板都会调到这里，别每次都重写 capabilities.json。 */
    if (before.includes(rule)) return { ok: true, id: key, forceDeny: before, unchanged: true, message: `${rule} 已在跨档硬否决里` };
    const forceDeny = [...before, rule];
    capStore.patch({ forceDeny });
    log.warn?.(`扩展 ${key} 已被撤回（${reason}），已加入 forceDeny`);
    return { ok: true, id: key, forceDeny, message: `已把 mcp__${key}__* 加入跨档硬否决` };
  }

  /** 索引缓存的旁路清理，测试与面板「强制刷新」用。 */
  function clearCache() { cache = null; }

  /**
   * 有安装 / 卸载正在跑？
   *
   * 换源、改 SSRF 白名单这类**全局**操作要拿它避让：安装流程会分好几次读
   * `sourceNow()`（拉索引一次、拼 tarball 地址一次、报进度又一次），中途换源
   * 就会出现「索引来自 A 源、包从 B 源下」的混搭。哈希校验能兜住坏包，但报错
   * 信息会指向莫名其妙的地方，不如直接说「等这一轮跑完」。
   */
  function busy() { return running.size > 0; }

  return {
    dir, tmpRoot,
    /** 见上：换源 / 改全局设置前先问一句 */
    busy,
    /**
     * **getter，不是快照**。面板上换源之后不该要求重启进程，而这个字段早期
     * 是创建时算一次就固定下来的——换完源再读它，拿到的还是旧地址。
     * 现在每次读都按当前配置重算，和 `sourceInfo()` 同源。
     */
    get indexUrl() { return indexUrlNow(); },
    index, list, install, progress,
    sourceInfo,
    remove, detectUpdates, revoke, syncBlock, clearCache,
  };
}
