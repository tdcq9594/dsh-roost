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
import { assertSafeUrl } from './ssrf.js';
import { join } from 'node:path';

import { dataDir } from './config.js';
import { EXT_ID_RE, MANIFEST_FILE, sensitiveScopesOf } from './ext-registry.js';
import { hashDir, extractTarGz, pickSubtree, writeFiles, rmrfSync } from './ext-bundle.js';

/** 读一份 JSON：读不到返回 null（清单损坏时按「没有 scope 声明」处理，不崩）。 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export const EXT_KIND = 'dsh-extension';
export const DEFAULT_EXT_INDEX_URL = 'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost-plugins/main/index.json';

function isLoopbackHost(host) {
  const h = String(host ?? '').replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * 索引地址白名单。`file://` 会让本地文件变成「远程索引」，内网 http 可被
 * 中间人替换成任意 `command` —— 两者都拒。本机回环留给测试与自建镜像。
 */
export function assertSafeIndexUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('索引地址不是合法 URL'); }
  if (u.protocol === 'https:') return u.href;
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return u.href;
  throw new Error('索引地址必须是 https（或本机回环 http）');
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

/** 撤回：顶层 `revoked:[id]`，或条目上 `revoked:true` / `revoked:[version]`。 */
export function isRevoked(index, entry) {
  const top = Array.isArray(index?.revoked) ? index.revoked : [];
  if (top.includes(entry?.id)) return true;
  const r = entry?.revoked;
  if (r === true) return true;
  if (Array.isArray(r) && r.includes(entry?.version)) return true;
  return false;
}

function tarballUrl(repo, branch = 'main') {
  return `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`;
}

/** 允许的分发包主机：与索引一样属于供应链入口，不能放开到任意 https。 */
const TARBALL_HOSTS = new Set(['codeload.github.com', 'github.com', 'objects.githubusercontent.com']);

export function assertSafeTarballUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('分发包地址不是合法 URL'); }
  if (u.protocol !== 'https:') throw new Error('分发包地址必须是 https');
  if (!TARBALL_HOSTS.has(u.hostname)) throw new Error(`分发包主机不在白名单：${u.hostname}`);
  return u.href;
}

async function defaultFetchText(url) {
  /**
   * 5.11：主机白名单只挡了「字面地址」，挡不住域名解析到 127.0.0.1 /
   * 169.254.169.254（DNS rebinding）。出站前逐 IP 再校一次。
   * 索引允许本机回环 http（自建镜像），与 assertSafeIndexUrl 口径一致。
   */
  await assertSafeUrl(url, { allowLoopback: true });
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`拉索引失败：HTTP ${res.status}`);
  return await res.text();
}

/** 默认下载：GitHub codeload 的 tar.gz → 剥顶层 → 取 `entry.path` 子树 → 安全落盘。 */
async function defaultDownload(entry, dest, { repo, branch } = {}) {
  const raw = entry.tarball || (repo ? tarballUrl(repo, branch) : '');
  if (!raw) throw new Error('索引条目缺 tarball，且索引里没有 repo 可拼下载地址');
  const url = assertSafeTarballUrl(raw);
  await assertSafeUrl(url);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下载分发包失败：HTTP ${res.status}`);
  /**
   * `redirect:'follow'` 只校验首跳；白名单主机自己 302 到别处就绕过了。
   * 拿最终 URL 再校一次（codeload → objects.githubusercontent.com 在白名单内）。
   */
  const finalUrl = res.url || url;
  assertSafeTarballUrl(finalUrl);
  const files = pickSubtree(extractTarGz(Buffer.from(await res.arrayBuffer()), { strip: 1 }), entry.path || '');
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
  fetchText = defaultFetchText,
  download = defaultDownload,
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
  log = () => {},
  now = () => Date.now(),
  ttlMs = 5 * 60_000,
} = {}) {
  if (!registry || typeof registry.install !== 'function') {
    throw new Error('createExtMarket 需要 registry');
  }
  const tmpRoot = join(dir, '.market-tmp');
  let cache = null;

  async function index({ refresh = false } = {}) {
    const t = now();
    if (!refresh && cache && t - cache.at < ttlMs) return cache.value;
    const url = assertSafeIndexUrl(indexUrl);
    const text = await fetchText(url);
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

  /** 市场列表：把索引与本地状态并成一行一扩展，面板直接用。 */
  async function list({ refresh = false } = {}) {
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
      return {
        id: e.id,
        name: e.name ?? e.id,
        description: e.shortDesc ?? e.description ?? '',
        version: e.version ? String(e.version) : '',
        sha256: e.sha256 ? String(e.sha256) : '',
        path: e.path ? String(e.path) : '',
        transport: e.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        author: e.author ? String(e.author) : '',
        verified: e.verified ? String(e.verified) : '',
        installed: Boolean(mine),
        foreign: Boolean(mine?.foreign),
        updateAvailable: Boolean(mine && e.sha256 && installedHash && installedHash !== e.sha256),
        revoked: isRevoked(idx, e),
        label: isRevoked(idx, e) ? '已撤回，拒绝安装' : '',
      };
    });
    return { ok: true, rows, repo: idx.repo ?? '', branch: idx.branch ?? 'main' };
  }

  /**
   * 安装一条。顺序固定：撤回 → foreign → 下载 → 哈希 → 落位 → 权限 → 受管块。
   * 后两步失败不回滚扩展本体（已经装好了，删掉反而更糟），以 `warnings` 返回。
   */
  async function install(id, { confirmScopes = false } = {}) {
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
      return { ok: false, reason: 'foreign', message: `${key} 是用户手写的扩展，拒绝覆盖；要接管请先手动删掉该目录` };
    }

    const staging = join(tmpRoot, key);
    rmrfSync(staging);
    try {
      /**
       * **必须有 sha256。** 缺了就无法校验内容，等于「索引说什么就装什么」；
       * `build-index.mjs` 对扩展一定会算哈希，所以拒掉不会误伤合法条目。
       */
      const want = String(entry.sha256 ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('索引条目缺 sha256，拒绝安装（无法校验内容）');
      await download(entry, staging, { repo: idx.repo, branch: idx.branch ?? 'main' });
      const got = await hashDir(staging);
      if (got !== want) {
        throw new Error(`目录哈希与索引不一致（索引 ${want.slice(0, 12)}…，实际 ${got.slice(0, 12)}…）`);
      }
      /**
       * 敏感 scope 必须主人确认。
       *
       * 清单是扩展作者写的，索要 `say:write` / `proactive:write` 就等于
       * 「装上后能以机器人身份往外说话」。一键装不能顺带把授权也点了 ——
       * 这里在落位前拦一道，把要授什么原样报给面板。
       */
      const staged = readJson(join(staging, MANIFEST_FILE));
      const sens = sensitiveScopesOf(staged);
      if (sens.length && confirmScopes !== true) {
        return {
          ok: false,
          reason: 'needs_scope_confirm',
          scopes: sens,
          message: `扩展「${key}」索要这些权限：${sens.join('、')}；确认后才安装`,
        };
      }

      const r = registry.install(staging, {
        source: {
          repo: idx.repo ?? '',
          branch: idx.branch ?? 'main',
          path: entry.path ?? '',
          sha256: entry.sha256 ?? '',
          installedAt: now(),
        },
      });
      if (!r.ok) throw new Error(r.reason || '落位失败');

      const warnings = [];
      if (extGroups) {
        try { extGroups.add(key, { label: entry.name ?? key, capStore }); }
        catch (e) { warnings.push(`权限组初始化失败：${e?.message ?? e}`); }
      }
      if (extPatch) {
        try { syncBlock(); }
        catch (e) { warnings.push(`受管块未写入：${e?.message ?? e}`); }
      }
      log.info?.(`已安装扩展 ${key}${warnings.length ? `（${warnings.length} 项待处理）` : ''}`);
      return {
        ok: true, id: key, warnings,
        message: warnings.length ? `已安装，但有 ${warnings.length} 项没接上：${warnings[0]}` : '已安装，下一条消息生效',
      };
    } catch (e) {
      return { ok: false, reason: 'install_failed', message: `安装失败：${e?.message ?? e}` };
    } finally {
      rmrfSync(staging);
    }
  }

  /** 受管块按「当前已装 id」整块重算，不是增量追加 —— 卸载后不留悬空条目。 */
  function syncBlock() {
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
      .filter((x) => EXT_ID_RE.test(x));
    return extPatch.render(ids, { apply: true });
  }

  function remove(id) {
    const key = String(id ?? '');
    if (!EXT_ID_RE.test(key)) return { ok: false, reason: 'bad_id', message: '扩展 id 不合法' };
    const r = registry.remove(key);
    if (!r.ok) return r;
    const warnings = [];
    if (extGroups) {
      try { extGroups.remove(key, { capStore }); }
      catch (e) { warnings.push(`权限组清理失败：${e?.message ?? e}`); }
    }
    try { syncBlock(); }
    catch (e) { warnings.push(`受管块未同步：${e?.message ?? e}`); }
    return { ok: true, id: key, warnings, message: warnings.length ? `已卸载，但有 ${warnings.length} 项没清干净` : '已卸载' };
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
      if (e.sha256 && cur && String(e.sha256).toLowerCase() !== String(cur).toLowerCase()) {
        rows.push({ id: e.id, name: e.name ?? e.id, sha256: String(e.sha256), installed: cur });
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

  return { dir, tmpRoot, indexUrl, index, list, install, remove, detectUpdates, revoke, syncBlock, clearCache };
}
