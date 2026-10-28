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
 * `ManagementFailure.code` → 人话。
 *
 * 直接把 code 抛给用户没人看得懂，而这几种是**用户能自己动手解决**的，
 * 必须说清下一步做什么。没列到的走兜底（附原始 code，方便搜）。
 */
const FAIL_TEXT = {
  'invalid-spec': '版本号不合法，可能是 registry 返回了脏数据。稍后重试，或去 DSH 插件管理里手动更新。',
  'already-installed': '已经是这个版本了（DSH 在热更新模式下重装同一个包会被拒）。重启 DSH 再看版本。',
  'registry-unreachable': '连不上 registry。检查网络，或在设置里换个源。',
  'cancelled': '已取消，本地什么都没动。',
};

export function humanFail(code) {
  if (!code) return '更新失败，本地什么都没动。去 DSH 插件管理里手动更新试试。';
  if (FAIL_TEXT[code]) return FAIL_TEXT[code];
  return `更新失败（${code}），本地什么都没动。去 DSH 插件管理里手动更新试试。`;
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
 * - `linked`  符号链接（开发模式）→ **自更新必须禁用**
 * - `real`    真实目录（npm 装的）→ 可以更新
 * - `unknown` 找不到 → 不给更新按钮，只显示版本
 */
export function installKind(profileDir) {
  const p = join(profileDir, 'node_modules', PKG);
  try {
    if (!existsSync(p)) return 'unknown';
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
  const pm = () => {
    try {
      return ctx?.get?.('pluginManager') ?? null;
    } catch {
      return null;
    }
  };

  /** registry：配置 > DSH 自己的 registries() > 官方。形状不明确，所以防着取 */
  function registryUrl() {
    if (registry) return String(registry).replace(/\/+$/, '');
    try {
      const r = pm()?.registries?.();
      const arr = Array.isArray(r) ? r : Array.isArray(r?.registries) ? r.registries : [];
      const first = arr[0];
      const url = typeof first === 'string' ? first : first?.url || first?.registry;
      if (url) return String(url).replace(/\/+$/, '');
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
    const reg = registryUrl();
    const url = `${reg}/${PKG}`;
    let latest = '';
    let publishedAt = 0;
    let err = '';
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      latest = String(j?.['dist-tags']?.latest ?? '');
      const t = j?.time?.[latest];
      publishedAt = t ? Date.parse(t) || 0 : 0;
    } catch (e) {
      // 更新是低频操作，失败就如实说，不闷头重试——重试只会让人多等十几秒
      err = e.message;
      log(`查最新版失败（${url}）：${e.message}`);
    }

    const age = publishedAt ? Date.now() - publishedAt : NaN;
    const k = kind();
    return {
      ok: true,
      own,
      latest,
      registry: reg,
      error: err,
      kind: k,
      // 只有真实目录才给更新按钮；符号链接会把开发链路搞断
      // 不只看有没有这个服务，还要看它到底有没有 installBundle——
      // 两个条件不一致会让面板显示一个点了没反应的按钮
      canSelf: k === 'real' && typeof pm()?.installBundle === 'function',
      hasUpdate: latest ? compareVersion(latest, own) > 0 : false,
      publishedAt,
      ageMs: Number.isFinite(age) ? age : null,
      ageText: Number.isFinite(age) ? ageText(age) : '',
      // 不满 24 小时：pnpm 可能降级装旧版，得提前告诉用户
      cooling: Number.isFinite(age) ? age < MIN_AGE_MS : false,
      coolingLeftText: Number.isFinite(age) && age < MIN_AGE_MS
        ? `还差 ${Math.ceil((MIN_AGE_MS - age) / 3600_000)} 小时满 24 小时`
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
    if (info.error && !info.latest) return { ok: false, code: 'registry', message: `查不到最新版：${info.error}` };
    if (!info.hasUpdate) return { ok: true, already: true, version: own, message: `已经是最新版（v${own}）` };

    let exemption = null;
    if (fresh && info.cooling) {
      try {
        exemption = exempt(info.latest);
      } catch (e) {
        // 加不上豁免不是致命错误：继续装，pnpm 会降级并如实报告版本
        log(`加豁免失败：${e.message}`);
      }
    }

    const requestId = `roost-self-${Date.now()}`;
    let result;
    try {
      result = await manager.installBundle(`${PKG}@${info.latest}`, { saveExact: true, requestId });
    } catch (e) {
      return { ok: false, code: 'throw', message: `更新失败：${e.message}（本地什么都没动）` };
    }

    const app = result?.application;
    if (app === 'cancelled') return { ok: false, code: 'cancelled', message: humanFail('cancelled') };
    if (app !== 'success') {
      const code = result?.packageResult?.code || result?.code || '';
      return { ok: false, code: code || 'failed', message: humanFail(code), raw: result };
    }

    /**
     * 核对**实际装到的**版本。
     *
     * 请求 0.10.7 却装到 0.10.6 只有一种原因：24 小时冷却让 pnpm 降级了。
     * 这种情况必须明说——不然用户看到"更新成功"、重启后版本没变，只会以为坏了。
     */
    const got = String(result?.version ?? '').replace(/^v/i, '') || info.latest;
    const downgraded = compareVersion(got, info.latest) < 0;
    return {
      ok: true,
      version: got,
      wanted: info.latest,
      downgraded,
      exemption,
      message: downgraded
        ? `已装 v${got}，不是最新的 v${info.latest}——因为新版本发布不满 24 小时，pnpm 降级了。`
          + '可以点「立即安装（不等 24 小时）」，或明天再更新。'
        : `已装 v${got}，**重启 DSH 才生效**。`,
      restart: true,
    };
  }

  return { own: () => own, check, self, exempt, profileDir: profile, kind, registryUrl };
}
