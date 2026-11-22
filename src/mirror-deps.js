/**
 * 依赖的备选下载源 —— 市场仓的 `deps/`
 * ====================================
 *
 * `shared-deps.js` 的白名单里有三个包：`@ffmpeg-installer/ffmpeg`、`qrcode`、
 * （历史遗留）`jimp`。它们平时都走 `npm install`，而 npm 这条路会坏：
 * 用户机器上没装 npm、公司网拦了 registry、源超时到 300 秒、装完 `require`
 * 起来还是报错。这时回到我们自己的市场仓取包，**直接解包、不经过 npm**。
 *
 * ## 两种条目
 *
 *   · **单包**（`ws` / `silk-wasm`）—— 零依赖，一个 tarball 解出来就能用；
 *   · **bundle**（`qrcode`）—— 带传递依赖的整棵树（29 个包），必须逐个解包
 *     **平铺**进同一个 `node_modules/`，那正是 npm 的 hoisted 布局。
 *
 * ## 不镜像 ffmpeg
 *
 * 它是 8 个平台子包、全平台上百 MB、GPL/LGPL 系要连带源码获取方式。所以
 * 镜像里没有它，`install()` 失败时会在文案里引导用户用系统那份
 * （`shared-deps.systemFfmpeg()` 一直在扫 PATH）。
 *
 * ## 信任链
 *
 * 地址由**市场索引地址**推导（同一个 host、同一个 repo），不另外接受用户
 * 输入；`path` 里出现 `.` / `..` 一律不认。包内容按索引里的 `sha256` 校验，
 * 索引走的是 `ext-market` 那套（https/回环 + SSRF 逐 IP 校验）。
 * **先解到内存、全部校验通过才落盘**——任何一包坏了都保证一个字节没写进去。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeUrl } from './ssrf.js';
import { extractTarGz, writeFiles } from './ext-bundle.js';
import { defaultFetchText } from './ext-market.js';

/**
 * 单个 tgz 的上限。
 *
 * `qrcode` 树里最大的是 `pngjs`（195KB），16MB 足够宽松；设上限是因为索引
 * 也是网络内容，一个被改过的 `size` 不该让宿主把内存吃满。
 */
const MAX_TGZ_BYTES = 16 * 1024 * 1024;

/**
 * 版本是否满足 `range`。
 *
 * 只支持白名单里实际用到的两种写法：`^X.Y.Z`（锁主版本）与精确 `X.Y.Z`。
 * 刻意不引 semver——宿主自己零依赖，而白名单是手写常量，多带一个解析器
 * 只为了算 `^` 不值得。`~` / `>=` / `||` / 预发布版都没实现，写进白名单就会
 * 被当成「不满足」而跳过（安全的一侧）。
 *
 * @param {string} version 实际版本，如 `1.5.4`
 * @param {string} range 期望范围，如 `^1.5.4`
 * @returns {boolean}
 */
export function satisfiesRange(version, range) {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  const r = /^(\^)?(\d+)\.(\d+)\.(\d+)$/.exec(String(range ?? '').trim());
  if (!v || !r) return false;
  /** 全转成数字再比：match 数组里是字符串，`8 !== '8'` 会让所有判断恒假 */
  const va = Number(v[1]);
  const vi = Number(v[2]);
  const vp = Number(v[3]);
  const caret = r[1] === '^';
  const ra = Number(r[2]);
  const ri = Number(r[3]);
  const rp = Number(r[4]);
  if (!caret) return va === ra && vi === ri && vp === rp;
  if (va !== ra) return false;
  /** `^0.x.y` 在 semver 里连次版本一起锁（`^0.2.0` 不含 `0.3.0`） */
  if (va === 0) return vi === ri && vp >= rp;
  return vi > ri || (vi === ri && vp >= rp);
}

/**
 * 由市场索引地址推出包地址。
 *
 * 例：`https://raw.githubusercontent.com/o/r/main/index.json` +
 * `deps/ws-8.23.0.tgz` → `.../main/deps/ws-8.23.0.tgz`
 * Gitee 的 `https://gitee.com/o/r/raw/main/index.json` 同理（换源不用改逻辑）。
 *
 * @param {string} indexUrl
 * @param {string} rel 索引里的 `path`（相对仓库根）
 * @returns {string} 拼不出合法地址时返回空串
 */
export function depUrlOf(indexUrl, rel) {
  try {
    const base = new URL(indexUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') return '';
    const clean = String(rel ?? '').replace(/^\/+/, '');
    /** 索引里写 `../../x` 就能跳出仓目录：这条路是「装依赖」，不该被带去任意路径 */
    if (!clean || clean.split('/').some((seg) => seg === '.' || seg === '..')) return '';
    const dir = base.pathname.replace(/[^/]*$/, '');
    base.pathname = dir + clean;
    return base.toString();
  } catch {
    return '';
  }
}

/**
 * 下载一个 tgz 的字节。走 SSRF 校验（索引与包都可能是自建镜像）。
 *
 * @param {string} url
 * @param {object} [guard] `assertSafeUrl` 的选项（`allowPrivate` / `allowHosts` / `trustedHosts`）
 * @returns {Promise<Buffer>}
 */
async function fetchTgz(url, guard = {}) {
  /** 与索引同口径：自建镜像多半是本机回环 http，`allowLoopback` 是有意的 */
  await assertSafeUrl(url, { allowLoopback: true, ...guard });
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_TGZ_BYTES) throw new Error(`包太大（${len} 字节），拒绝下载`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TGZ_BYTES) throw new Error(`包太大（${buf.length} 字节），拒绝下载`);
  return buf;
}

/**
 * 解一个 npm 包：剥掉唯一的顶层目录，校验 `package.json` 的 `name`。
 *
 * 名字必须对得上：索引说装 A、包里是 B，等于把 B 的内容当成 A 装上了。
 *
 * @param {Buffer} gz
 * @param {string} expect 期望的包名
 * @returns {Map<string, Buffer>}
 */
function unpackNpmTgz(gz, expect) {
  const files = extractTarGz(gz, { strip: 1, maxBytes: MAX_TGZ_BYTES * 4 });
  const pkgRaw = files.get('package.json');
  if (!pkgRaw) throw new Error(`${expect}：包里没有 package.json（不是 npm 包？）`);
  let real = '';
  try {
    real = String(JSON.parse(pkgRaw.toString('utf8'))?.name ?? '');
  } catch {
    throw new Error(`${expect}：package.json 解不开`);
  }
  if (real !== expect) throw new Error(`包名不符：索引是 ${expect}，包里是 ${real || '(空)'}`);
  return files;
}

/** 一个包解出来后的暂存：**全部校验通过才落盘** */
async function commitPackage(root, name, files) {
  const target = path.join(root, 'node_modules', ...String(name).split('/'));
  await fs.rm(target, { recursive: true, force: true });
  await writeFiles(target, files);
}

/**
 * 拉一次市场索引，取出 `deps` 列表。
 *
 * 不做缓存：这是写路径（要装东西），缓存会让刚刷新过镜像的索引读到旧 sha256，
 * 然后稳定地校验失败，看起来像「镜像坏了」。
 *
 * @param {string} indexUrl
 * @param {{guard?:object, fetchText?:Function}} [o]
 * @returns {Promise<{entries:Array<object>, error:string}>}
 */
export async function listMirrorDeps(indexUrl, { guard = {}, fetchText = defaultFetchText } = {}) {
  try {
    const text = await fetchText(indexUrl, guard);
    const j = JSON.parse(String(text));
    const list = Array.isArray(j?.deps) ? j.deps : [];
    const entries = list.filter((d) => d?.name && d?.version
      && (Array.isArray(d.packages) ? d.packages.length > 0 : Boolean(d.path)));
    return { entries, error: '' };
  } catch (e) {
    return { entries: [], error: `读市场索引失败：${String(e?.message ?? e)}` };
  }
}

/**
 * 装一个**单包**条目（零依赖）。
 *
 * @param {string} indexUrl
 * @param {object} entry 索引里的 `deps` 记录
 * @param {string} dir 数据目录（下面有 `node_modules`）
 * @param {{guard?:object, fetcher?:Function}} [o]
 * @returns {Promise<{ok:boolean, error:string}>}
 */
export async function installOneFromMirror(indexUrl, entry, dir, o = {}) {
  const url = depUrlOf(indexUrl, entry.path);
  if (!url) return { ok: false, error: `镜像地址拼不出来（索引 ${indexUrl}）` };
  try {
    const buf = await (o.fetcher ?? ((u) => fetchTgz(u, o.guard)))(url);
    if (entry.sha256) {
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== entry.sha256) throw new Error(`sha256 不符（期望 ${entry.sha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
    }
    const files = unpackNpmTgz(buf, entry.name);
    await commitPackage(dir, entry.name, files);
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 装一个 **bundle** 条目（带传递依赖的整棵树）。
 *
 * 两阶段：先把所有子包下载、校验、解开，**全部通过之后**才逐个落盘。
 * 一阶段落盘的话，第 28 个包校验失败会留下半个 `node_modules`——那种状态
 * 比「什么都没装」更难查（有的模块能 require、有的不能）。
 *
 * @param {string} indexUrl
 * @param {object} entry `{ name, version, packages:[{name,version,path,sha256}] }`
 * @param {string} dir
 * @param {{guard?:object, fetcher?:Function}} [o]
 * @returns {Promise<{ok:boolean, error:string, count:number}>}
 */
export async function installBundleFromMirror(indexUrl, entry, dir, o = {}) {
  const list = Array.isArray(entry.packages) ? entry.packages : [];
  if (!list.length) return { ok: false, error: `${entry.name}：bundle 里没有包`, count: 0 };
  try {
    const staged = [];
    for (const p of list) {
      const url = depUrlOf(indexUrl, p.path);
      if (!url) throw new Error(`${p.name}：镜像地址拼不出来`);
      const buf = await (o.fetcher ?? ((u) => fetchTgz(u, o.guard)))(url);
      if (p.sha256) {
        const sha = createHash('sha256').update(buf).digest('hex');
        if (sha !== p.sha256) {
          throw new Error(`${p.name}：sha256 不符（期望 ${p.sha256.slice(0, 12)}…）`);
        }
      }
      staged.push({ name: p.name, files: unpackNpmTgz(buf, p.name) });
    }
    for (const s of staged) await commitPackage(dir, s.name, s.files);
    return { ok: true, error: '', count: staged.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), count: 0 };
  }
}

/**
 * 一次装多个：只装 `names` 里、索引里有的、版本满足 range 的。
 *
 * @param {object} p
 * @param {string[]} p.names 包名（已过白名单）
 * @param {Record<string, {range:string}>} p.whitelist 包名 → 版本范围
 * @param {string} p.dir 数据目录（`<dataDir>/deps`）
 * @param {string} p.indexUrl 市场索引地址
 * @param {object} [p.guard] SSRF 选项
 * @param {Array<object>} [p.entries] 直接给索引条目（单测用）
 * @param {Function} [p.fetcher] 替换下载（单测用）
 * @returns {Promise<{installed:Array<object>, errors:string[], absent:string[]}>}
 */
export async function installFromMirror({
  names, whitelist, dir, indexUrl, guard = {}, entries: given, fetcher,
}) {
  const out = { installed: [], errors: [], absent: [] };
  const { entries, error } = given
    ? { entries: given, error: '' }
    : await listMirrorDeps(indexUrl, { guard });
  if (error) {
    out.errors.push(error);
    return out;
  }

  for (const name of names) {
    const entry = entries.find((d) => d.name === name);
    if (!entry) {
      out.absent.push(name);
      continue;
    }
    const range = whitelist?.[name]?.range;
    if (range && !satisfiesRange(entry.version, range)) {
      out.errors.push(`镜像里的 ${name} 是 ${entry.version}，不满足 ${range}（镜像该刷新了），已跳过`);
      continue;
    }
    if (Array.isArray(entry.packages)) {
      const r = await installBundleFromMirror(indexUrl, entry, dir, { guard, fetcher });
      if (r.ok) out.installed.push({ name, version: entry.version, kind: 'bundle', count: r.count });
      else out.errors.push(`${name}：${r.error}`);
      continue;
    }
    const r = await installOneFromMirror(indexUrl, entry, dir, { guard, fetcher });
    if (r.ok) out.installed.push({ name, version: entry.version });
    else out.errors.push(`${name}：${r.error}`);
  }
  return out;
}
