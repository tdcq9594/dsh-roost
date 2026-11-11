/**
 * 本体自更新（dsh-roost 更新自己）。
 *
 * 核心结论：**不自己调 pnpm、不自己改 node_modules**。
 * DSH 有一个 `pluginManager` 服务，`installBundle(spec, options)` 就是现成的
 * 安全自更新原语——失败/取消时它会**把 `package.json` 和 `pnpm-lock.yaml`
 * 恢复原样**，还带 `requestId` 可取消、`waitForInstall` 可恢复。
 * 自更新最容易出事的地方就是"改到一半坏了怎么回滚"，这块已经有人做完了。
 *
 * `pluginManager` **不写进 `inject`**：老版本 DSH 没这个服务，写进 inject 会让
 * 插件直接激活失败。用 `ctx.get()` 拿，拿不到就降级成"只显示当前版本"。
 *
 * 另外要挡住一个坑：开发时 `node_modules/dsh-roost` 是指向源码目录的**符号链接**。
 * 这时候跑 installBundle，pnpm 会把链接换成真实目录 —— 开发链路直接断掉。
 * 所以第一步永远是判断"我是怎么装的"。
 */

import { readFileSync, writeFileSync, existsSync, renameSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { compareVersion } from './version.js';

export { compareVersion };

/** 只更新这一个包。面板不接受任意包名，否则这里就成了"任意装包"的洞 */
export const PKG = 'dsh-roost';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * 24 小时冷却：pnpm 10.16+ 的 `minimumReleaseAge` 默认 1440 分钟。
 * 刚发的版本别人装不上，pnpm 会**降级**装一个满 24 小时的旧版（不报错）。
 * 这个常量只用来算"还差多久"和判断要不要提示。
 */
const MIN_AGE_MS = 24 * 3600_000;

/**
 * DSH 的 `ChangeResult.application` 取值。
 *
 * **没有 `success`。** 真实的成功值是 `applied`；`restart-required`（装好了但要重启）
 * 和 `overridden`（被别的组合包接管）同样属于成功。
 * 以前这里拿 `'success'` 判，于是**每一次成功都被判成失败**——
 * 面板永远显示「更新失败，本地什么都没动」，而实际上文件已经换好了。
 */
const APP_OK = new Set(['applied', 'restart-required', 'overridden', 'success']);

/**
 * `result.error.code` → 人话。
 *
 * 这批键名来自 DSH `pluginManager` 的返回 schema（`@deepseek-ai/dsh-plugin-manager`），
 * **不是 `packageResult.code`**——那个字段不存在，读它永远拿到 undefined，
 * 于是所有失败都落到兜底文案，用户看不出任何可行动的信息。
 */
const FAIL_TEXT = {
  'already-installed': '这一版已经装过了（DSH 在热更新模式下会拒绝重装同一个包）。重启 DSH 再看版本；要换别的版本得先卸载。',
  'invalid-spec': '版本号不合法，可能是 registry 返回了脏数据。稍后重试，或去 DSH 插件管理里手动更新。',
  'incompatible-version': '这个版本要求更高版本的 DSH，当前装不了。先升级 DSH。',
  'management-required': '这个 DSH 没给插件管理权限。去 DSH 设置里打开后重试。',
  unaddressable: '包地址解析不出来（registry 或 spec 有问题）。',
  'unknown-plugin': '找不到这个插件（可能已下架）。',
  'ambiguous-install': '有多个同名来源，DSH 不确定装哪个。去 DSH 插件管理里手动指定。',
  'not-bundle': '这个包不是 DSH 插件包（没有 bundle 声明）。',
  'not-removable': '这个包不能卸载（它承载着插件管理），所以装不了别的版本。',
  'stop-profile': 'DSH 正在停止或重启，等它起来再试。',
  'bundle-in-use': '这个包正在被使用，先停掉相关插件。',
  'stale-approval': '构建许可过期了，再点一次即可。',
  'operation-error': '安装过程报错，具体看下面的诊断。',
  cancelled: '已取消，本地什么都没动。',
};

/** `installBundle` 的另一种返回：`{ status:'refused', problem, reason }` */
const REFUSE_TEXT = {
  network: '连不上 registry（或这个 spec 的下载主机）。检查网络、代理，或在设置里换个源。',
  'not-found': 'registry 上没有这个版本（可能刚发布还没同步）。过几分钟再试。',
  'not-a-package': '拉下来的东西不是 npm 包。',
  'not-a-bundle': '这个包不是 DSH 插件包（没有 bundle 声明）。',
  'invalid-spec': FAIL_TEXT['invalid-spec'],
  'already-installed': FAIL_TEXT['already-installed'],
  unknown: 'DSH 拒绝了这次安装，原因不明，见下面的诊断。',
};

/**
 * `packageResult.kind` → 人话。
 *
 * 这是**用户唯一能据此自查**的信息：断网、没权限、磁盘满，处理方式完全不同。
 */
const KIND_TEXT = {
  network: '网络问题（连不上 registry 或下载源）',
  timeout: '卡住超时（包管理器长时间没有输出）',
  integrity: '下载内容校验不通过（缓存坏了，或源被篡改）',
  'pnpm-missing': '找不到 pnpm',
  'not-found': 'registry 上没有这个版本',
  'no-matching-version': '没有匹配的版本（可能被 24 小时冷却挡住）',
  'disk-full': '磁盘空间不足',
  permission: '没有写权限（node_modules 或缓存目录）',
  'build-blocked': '安装脚本被拦（build 未批准）',
  unknown: '包管理器报错',
};

export function humanFail(code, extra = {}) {
  const { kind, failedAt, diagnostic } = extra;
  const base = FAIL_TEXT[code] || REFUSE_TEXT[code]
    || (code
      ? `更新失败（${code}），本地什么都没动。去 DSH 插件管理里手动更新试试。`
      : '更新失败，本地什么都没动。去 DSH 插件管理里手动更新试试。');

  const bits = [base];
  /**
   * 分类比错误码更接近"我该做什么"：`operation-error` 只能说明"报错了"，
   * 而 `kind: network` 能让人立刻想到代理。
   */
  if (kind && KIND_TEXT[kind] && !base.includes(KIND_TEXT[kind])) bits.push(`原因：${KIND_TEXT[kind]}。`);
  if (failedAt === 'registry') bits.push('（卡在 registry）');
  else if (failedAt === 'spec-host') bits.push('（卡在下载主机）');
  /** 诊断是 pnpm 原文，可能很长；toast 只放一句，完整内容走 detail */
  if (diagnostic && !code) bits.push(diagnostic.slice(0, 120));
  return bits.join(' ');
}

/** 「发布 30 分钟前」这种人话 */
export function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚发布';
  if (m < 60) return `发布 ${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `发布 ${h} 小时前`;
  return `发布 ${Math.floor(h / 24)} 天前`;
}

/**
 * 把 `dsh-roost@<version>` 写进 `pnpm-workspace.yaml` 的豁免列表。
 *
 * **按行改，不解析重排。** 那个文件里有注释、有别的键，用 YAML 库
 * 读出来再写回去会丢注释、重排缩进——改一个我们自己包的豁免项，
 * 顺手把用户整个文件重写一遍，风险不对等。
 *
 * 规则：清掉旧的 `dsh-roost@…` 条目（不然越攒越长，本机已经堆了 17 个），
 * 只留最新那一条；**别的包的条目一个不动**。
 *
 * @returns {{text: string, changed: boolean, reason?: string}}
 */
export function patchExclude(text, pkg, version) {
  const entry = `${pkg}@${version}`;
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);

  let keyAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(lines[i])) { keyAt = i; break; }
  }

  // 没有这个键：整块追加到末尾
  if (keyAt < 0) {
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('minimumReleaseAgeExclude:', `  - ${entry}`, '');
    return { text: out.join('\n'), changed: true };
  }

  /**
   * 收集这个键下面的列表项。
   *
   * 列表项 = `  - xxx`；遇到空行或非列表行就认为这一块结束。
   * 缩进用两空格——跟 pnpm 自己写出来的一致。
   */
  const items = [];
  let end = keyAt + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') break;
    if (!/^\s*-\s/.test(l)) break;
    items.push({ at: end, value: l.replace(/^\s*-\s*/, '').trim() });
    end++;
  }

  const keep = items.filter((it) => !it.value.startsWith(`${pkg}@`) && it.value !== pkg);
  const out = [
    ...lines.slice(0, keyAt + 1),
    `  - ${entry}`,
    ...keep.map((it) => `  - ${it.value}`),
    ...lines.slice(end),
  ];
  const next = out.join('\n');
  return { text: next, changed: next !== src };
}

/**
 * 从当前文件位置往上找 DSH 的 profile 目录（`pnpm-workspace.yaml` 所在处）。
 *
 * 为什么不硬编码 `~/.dsh/profiles/desktop`：DSH 有多个 profile，
 * 用户也可能装到别的地方。往上找是唯一不猜的办法。
 * 找不到才退回默认路径（至少比什么都不做强）。
 */
export function findProfileDir(startDir) {
  let p = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(p, 'pnpm-workspace.yaml'))) return p;
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return join(homedir(), '.dsh', 'profiles', 'desktop');
}

/**
 * 判断自己是怎么装的。
 *
 * - `linked`  符号链接 / Windows junction（开发模式）→ **自更新必须禁用**
 * - `real`    真实目录（npm 装的）→ 可以更新
 * - `unknown` 找不到 → 不给更新按钮，只显示版本
 *
 * ⚠️ **不要先用 `existsSync()` 判存在**（2026-11-12 实测）：Windows 的 junction
 * 在某些环境里 `existsSync` 返回 false —— 它走 `stat`、会跟随链接，链接目标
 * 一旦被策略挡住就抛 UNKNOWN；而 `lstat` 明明看得见这个链接。先判 `existsSync`
 * 的后果是「明明是链接装法，却判成 unknown」，`linked` 这条防线等于没设。
 * 直接 `lstat`：拿得到就按 isSymbolicLink 分类，拿不到（ENOENT / 权限）才当未知。
 */
export function installKind(profileDir) {
  const p = join(profileDir, 'node_modules', PKG);
  try {
    return lstatSync(p).isSymbolicLink() ? 'linked' : 'real';
  } catch {
    return 'unknown';
  }
}

/**
 * @param {object} opts
 * @param {object} opts.ctx           DSH 的 ctx（用 `ctx.get('pluginManager')`）
 * @param {string} [opts.registry]    配置里的 registry，空就用 DSH 的 / 官方
 * @param {string} [opts.profileDir]  覆盖 profile 目录（测试用）
 * @param {Function} [opts.fetchImpl]
 * @param {(m:string)=>void} [opts.log]
 */
export function createUpdater({ ctx, registry, profileDir, fetchImpl = globalThis.fetch, log = () => {} }) {
  const own = (() => {
    try {
      return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();

  const profile = () => profileDir ?? findProfileDir(import.meta.dirname);
  const kind = () => installKind(profile());

  /**
   * 磁盘上**已经装着的**版本（≠ 正在运行的版本）。
   *
   * `own` 是模块加载时读的一次快照：装完新版不重启，它永远不会变。
   * 拿它判断"要不要装/还有没有新版"，会让按钮在更新成功后继续挂着，
   * 用户再点一次就撞上 `already-installed`。
   */
  function installedVersion() {
    try {
      const p = join(profile(), 'node_modules', PKG, 'package.json');
      return JSON.parse(readFileSync(p, 'utf8')).version || '';
    } catch {
      return '';
    }
  }

  const pm = () => {
    try {
      return ctx?.get?.('pluginManager') ?? null;
    } catch {
      return null;
    }
  };

  /**
   * registry：配置 > DSH 自己的 registries() > 官方。
   *
   * **必须 await。** `pluginManager.registries()` 的签名是
   * `async registries(): Promise<PluginRegistries>`，返回值由 remote 层包成
   * `{ ok, value: { registry, fallbackRegistries, resolved } }`。
   * 以前这里当同步数组取（`Array.isArray(...)`），Promise 永远不是数组、
   * `r.registries` 也永远不存在——于是**不管用户配了什么镜像，都退回官方
   * registry.npmjs.org**，国内 8 秒超时几乎必挂。
   *
   * 形状在 DSH 几个版本间飘过（数组 / `{registries}` / `{ok,value}`），
   * 所以几种都认，认不出再用官方。
   */
  async function registryUrl() {
    if (registry) return String(registry).replace(/\/+$/, '');
    try {
      let r = await pm()?.registries?.();
      // remote 包装层：{ ok, value }
      if (r && typeof r === 'object' && 'ok' in r) {
        if (!r.ok) return DEFAULT_REGISTRY;
        r = r.value;
      }
      const pick = (v) => (typeof v === 'string' && v ? String(v).replace(/\/+$/, '') : '');
      if (typeof r === 'string') return pick(r) || DEFAULT_REGISTRY;
      if (Array.isArray(r)) {
        const first = r[0];
        const url = typeof first === 'string' ? first : first?.url || first?.registry;
        if (pick(url)) return pick(url);
        return DEFAULT_REGISTRY;
      }
      if (r && typeof r === 'object') {
        // PluginRegistries：{ registry, fallbackRegistries, resolved }
        const direct = pick(r.registry) || pick(r.registries?.[0]?.url) || pick(r.resolved);
        if (direct) return direct;
        const arr = Array.isArray(r.registries) ? r.registries
          : Array.isArray(r.fallbackRegistries) ? r.fallbackRegistries : [];
        const first = arr[0];
        const url = typeof first === 'string' ? first : first?.url || first?.registry;
        if (pick(url)) return pick(url);
      }
    } catch {}
    return DEFAULT_REGISTRY;
  }

  /**
   * 查最新版。
   *
   * 拉**整份 packument**而不是 `/latest`：`/latest` 只给版本号，而我们要
   * 顺手读 `time` 算「发布多久了」——24 小时冷却期内点更新是白点，得提前说。
   * 只查一次，两个信息都拿到。
   */
  async function check() {
    const reg = await registryUrl();
    const url = `${reg}/${PKG}`;
    let latest = '';
    let publishedAt = 0;
    let err = '';
    try {
      /**
       * 必须拉**完整 packument**（application/json）。
       *
       * npm 的简版元数据 application/vnd.npm.install-v1+json 只有
       * name / dist-tags / versions / modified，**不带 time**；
       * 之前用简版取 `j.time[latest]` 永远是 undefined → publishedAt=0
       * → age=NaN → cooling 恒 false，冷却警告和「立即安装」按钮都不渲染，
       * 24 小时豁免在生产环境一次都没生效过。
       *
       * 完整 packument 更大：保留 8 秒超时；失败时退回简版只拿 latest，
       * 发布时间标成「未知」（coolingUnknown），而不是假装不在冷却期。
       */
      const getPackument = async (accept, timeoutMs) => {
        const res = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      let j;
      try {
        j = await getPackument('application/json', 8000);
      } catch (e) {
        log(`完整 packument 拉取失败（${e.message}），退回简版元数据（拿不到发布时间）`);
        j = await getPackument('application/vnd.npm.install-v1+json', 4000);
      }
      latest = String(j?.['dist-tags']?.latest ?? '');
      const t = j?.time?.[latest];
      publishedAt = t ? Date.parse(t) || 0 : 0;
    } catch (e) {
      // 更新是低频操作，失败就如实说，不闷头重试——重试只会让人多等十几秒
      err = e.message;
      log(`查最新版失败（${url}）：${e.message}`);
    }

    const age = publishedAt ? Date.now() - publishedAt : NaN;
    const ageKnown = Number.isFinite(age);
    /** 拿不到发布时间 ≠ 不在冷却期：三态处理，别让「立即安装」出口凭空消失 */
    const coolingUnknown = !ageKnown;
    const cooling = ageKnown && age < MIN_AGE_MS;
    // 按分钟取整再拆小时：Math.ceil 到小时会把 23 小时 04 分说成「还差 24 小时满 24 小时」
    const leftMin = cooling ? Math.ceil((MIN_AGE_MS - age) / 60_000) : 0;
    const leftH = Math.floor(leftMin / 60);
    const leftM = leftMin % 60;
    const k = kind();
    /** 磁盘上装着的版本；读不到就退回运行中版本（测试环境没有真实 node_modules） */
    const installed = installedVersion();
    const base = installed || own;
    return {
      ok: true,
      own,
      installed,
      latest,
      registry: reg,
      error: err,
      kind: k,
      // 只有真实目录才给更新按钮；符号链接会把开发链路搞断
      // 不只看有没有这个服务，还要看它到底有没有 installBundle——
      // 两个条件不一致会让面板显示一个点了没反应的按钮
      canSelf: k === 'real' && typeof pm()?.installBundle === 'function',
      /**
       * 比的是**磁盘上那份**，不是运行中那份。
       *
       * 比运行中版本的话，装完新版不重启就永远"有更新"，
       * 按钮一直挂着，用户再点一次必然撞 already-installed。
       */
      hasUpdate: latest ? compareVersion(latest, base) > 0 : false,
      /** 查不到最新版（网络/registry 挂了）。面板据此给一个「按 latest 试装」的出口 */
      unknownLatest: Boolean(err && !latest),
      /** 装好了但还没重启：磁盘版本 ≠ 运行中版本 */
      pendingRestart: Boolean(installed && compareVersion(installed, own) > 0),
      publishedAt,
      ageMs: ageKnown ? age : null,
      ageText: ageKnown ? ageText(age) : '',
      // 不满 24 小时：pnpm 可能降级装旧版，得提前告诉用户
      cooling,
      /** 发布时间未知（简版元数据 / 时间字段缺失）：仍允许走豁免，不冒充「已过冷却期」 */
      coolingUnknown,
      coolingLeftText: cooling
        ? `还差 ${leftH} 小时${leftM ? ` ${leftM} 分钟` : ''}满 24 小时`
        : '',
      hasManager: typeof pm()?.installBundle === 'function',
    };
  }

  /**
   * 让 pnpm 跳过本包的 24 小时冷却。
   *
   * 只改 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 里的一条豁免项，
   * 写之前备份。**只对 dsh-roost 生效**——放开成"任意包"就等于给面板
   * 开了一个"给任何包跳过防投毒保护"的洞。
   */
  function exempt(version) {
    const f = join(profile(), 'pnpm-workspace.yaml');
    if (!existsSync(f)) throw new Error(`找不到 ${f}，没法加豁免（可能不是 pnpm 装的）`);
    const before = readFileSync(f, 'utf8');
    const r = patchExclude(before, PKG, version);
    if (!r.changed) return { changed: false, file: f };
    const bak = `${f}.roost-bak`;
    writeFileSync(bak, before, 'utf8');
    // 原子写：半截 yaml 会让 pnpm 之后所有操作都失败
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, r.text, 'utf8');
    renameSync(tmp, f);
    return { changed: true, file: f, backup: bak };
  }

  /**
   * 执行自更新。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.fresh] 不等 24 小时（先写豁免项）
   */
  async function self({ fresh = false } = {}) {
    const k = kind();
    if (k === 'linked') {
      return {
        ok: false,
        code: 'linked',
        message: '这台机器上 dsh-roost 是符号链接（开发模式），自更新会把链接换成真实目录、'
          + '改源码就不再生效了。开发机请直接重启 DSH。',
      };
    }
    if (k === 'unknown') {
      return { ok: false, code: 'unknown', message: '找不到已安装的 dsh-roost 目录，无法自更新。' };
    }
    const manager = pm();
    if (!manager?.installBundle) {
      return { ok: false, code: 'no-manager', message: '这个 DSH 版本没有 pluginManager 服务，请在 DSH 插件管理里手动更新。' };
    }

    const info = await check();
    /**
     * 查不到最新版**不再直接阻断**。
     *
     * `check()` 只是前置判断：它去拉 registry 的 packument，8 秒超时，
     * 国内直连或挂代理的环境经常失败。而真正安装时 pnpm 自己会解析
     * `dsh-roost@latest`，根本不需要我们先知道版本号。
     * 以前这里一失败就 return，于是"网断了"和"其实能装"变成同一句
     * 「查不到最新版」，用户连试都试不了。
     */
    const unknownLatest = Boolean(info.error && !info.latest);
    if (unknownLatest) log(`查不到最新版（${info.error}），仍尝试按 latest 标签安装`);

    /**
     * 已经装上最新版：不再装第二次。
     *
     * 用 `installed`（磁盘）判断，不是 `own`（运行中）——装完没重启时后者还是旧值，
     * 会重复调 installBundle，然后被 DSH 以 already-installed 拒掉。
     */
    if (!unknownLatest && !info.hasUpdate) {
      return {
        ok: true,
        already: true,
        version: info.installed || own,
        message: info.pendingRestart
          ? `已经装好 v${info.installed}，重启 DSH 生效。`
          : `已经是最新版（v${own}）`,
      };
    }

    let exemption = null;
    // 冷却期内、或发布时间未知，都允许走豁免；后者正是简版元数据把 cooling
    // 恒判成 false 时唯一能装上新版的路。
    if (fresh && (info.cooling || info.coolingUnknown) && info.latest) {
      try {
        exemption = exempt(info.latest);
      } catch (e) {
        // 加不上豁免不是致命错误：继续装，pnpm 会降级并如实报告版本
        log(`加豁免失败：${e.message}`);
      }
    }

    const requestId = `roost-self-${Date.now()}`;
    /** 版本号未知时交给 pnpm 解析 latest tag */
    const spec = unknownLatest ? `${PKG}@latest` : `${PKG}@${info.latest}`;
    let result;
    try {
      result = await manager.installBundle(spec, { saveExact: true, requestId });
    } catch (e) {
      return { ok: false, code: 'throw', message: `更新失败：${e.message}（本地什么都没动）` };
    }

    /**
     * DSH 的返回有**两种形态**，都必须认：
     *
     *   ChangeResult { changed, application, restartReason?, error?, packageResult?, bundle?, … }
     *   { status: 'refused', problem, reason }        ← 连 pnpm 都没跑就被拒
     *
     * 以前只认 `application === 'success'`（这个值不存在）并去读
     * `packageResult.code`（这个字段也不存在），结果**每一次成功都被报成失败**，
     * 真正的错误码也全被丢掉，用户只能看到兜底文案。
     */
    const app = result?.application;
    const refused = result?.status === 'refused';
    const errCode = result?.error?.code || (refused ? result?.problem : '') || '';
    /** 给人看的细节：错误码之外还有 pnpm 的分类、原文和日志路径 */
    const detail = {
      code: errCode,
      diagnostic: result?.error?.diagnostic || (refused ? result?.reason : '') || '',
      kind: result?.packageResult?.kind || '',
      failedAt: result?.failedAt || '',
      exitCode: result?.packageResult?.exitCode ?? null,
      timedOut: Boolean(result?.packageResult?.timedOut),
      logPath: result?.packageResult?.logPath || '',
      // pnpm 输出可能很长；只带前 400 字，够定位又不会把响应撑大
      output: String(result?.packageResult?.output || '').slice(0, 400),
    };

    if (app === 'cancelled') {
      return { ok: false, code: 'cancelled', message: humanFail('cancelled'), detail };
    }
    if (refused || app === 'failed' || (result?.error && !APP_OK.has(app))) {
      return {
        ok: false,
        code: errCode || 'failed',
        message: humanFail(errCode, detail),
        detail,
        raw: result,
      };
    }
    if (!APP_OK.has(app)) {
      /**
       * 拿不到 `application`：可能是更老的 DSH，或返回结构又变了。
       * **不能当成功**——那样用户会以为装好了，重启后还是旧版。
       */
      return {
        ok: false,
        code: 'unexpected',
        message: '更新返回了看不懂的结果，本地可能没动。去 DSH 插件管理里看一眼版本。',
        detail,
        raw: result,
      };
    }

    /**
     * 核对**实际装到的**版本：优先读磁盘，其次信 installBundle 的返回。
     *
     * 旧写法拿 `info.latest`（请求的版本）兜底 `got`，等于自己骗自己：
     * pnpm 被 24 小时冷却挡住时会静默保留旧版、且返回里未必有 version，
     * 兜底成请求版本后 downgraded 恒为 false → 用户看到「已装 v1.0.0」，
     * 重启后还是 0.13.0。写进磁盘的那份才是事实。
     */
    const reported = String(result?.bundle?.version || result?.version || '').replace(/^v/i, '');
    const onDisk = String(installedVersion() || '').replace(/^v/i, '');
    const got = onDisk || reported;
    const wanted = info.latest || reported;
    /** 两个来源都没版本号：不能报「已装 vX」，如实说没核对到 */
    const unverified = !got;
    // 只有两边都有版本号才谈得上"降级"
    const downgraded = Boolean(wanted && got && compareVersion(got, wanted) < 0);
    /** `restart-required` / `overridden` 都表示"现在还没生效" */
    const needRestart = app === 'restart-required' || app === 'overridden'
      || Boolean(result?.restartReason) || result?.changed === true;
    return {
      ok: true,
      version: got,
      wanted,
      downgraded,
      unverified,
      exemption,
      application: app,
      restartReason: result?.restartReason || '',
      message: downgraded
        ? `已装 v${got}，不是最新的 v${wanted}——因为新版本发布不满 24 小时，pnpm 降级了。`
          + '可以点「立即安装（不等 24 小时）」，或明天再更新。'
        : unverified
          ? '安装已返回成功，但没能核对到实际装到的版本。重启 DSH 后到「设置 → 更新」看版本号；'
            + '如果仍是旧版，点「立即安装（不等 24 小时）」。'
          // toast 是纯文本，别在这里写 markdown 星号（会原样显示出来）
          : unknownLatest
            // 版本号是 pnpm 解析出来的；这次没查到"最新"，就别编一个数字
            ? `已装 ${got ? 'v' + got : '最新版'}，重启 DSH 才生效（没查到版本号，按 latest 标签装的）。`
            : `已装 v${got}，重启 DSH 才生效。`,
      restart: needRestart,
      unknownLatest,
    };
  }

  return { own: () => own, installedVersion, check, self, exempt, profileDir: profile, kind, registryUrl };
}
