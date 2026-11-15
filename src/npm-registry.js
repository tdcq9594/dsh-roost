/**
 * npm 源（registry）解析
 * ======================
 *
 * 这个插件**自己零依赖**，但装别人的东西时要走 npm：
 *   · 宿主级共享依赖（ffmpeg / qrcode）→ 真跑 `npm install`
 *   · 语音引擎（sherpa / 微软朗读）→ 直接下 npm 的 tgz 包
 *
 * 两条路都容易在国内卡住，而卡住的表现完全不同：
 *   · `npm install` 会读 `.npmrc` / `npm_config_registry`，用户配过就好；
 *   · **tgz 直链不经过 npm**，环境变量对它一点用没有——50 多 MB 硬下
 *     registry.npmjs.org，超时了只能干瞪眼。
 *
 * 所以这里提供两样东西：
 *   `registryArgs()`       给 `npm install` 拼 `--registry`（显式、可预测）
 *   `downloadRegistries()` 给直链下载一份可轮询的候选源（官方失败换镜像）
 *
 * 解析优先级（高 → 低）：
 *   1. `override`（面板里配的 `update.registry`）
 *   2. 环境变量 `npm_config_registry`
 *   3. `~/.npmrc` / 当前目录 `.npmrc` 的 `registry=`
 *   4. 官方源
 *
 * **默认永远官方源**：不猜、不测速。装依赖本来就慢，不该再叠一层不确定性。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 官方源。**不带尾斜杠**：拼 URL 时统一按「没有尾斜杠」处理 */
export const OFFICIAL = 'https://registry.npmjs.org';

/** 国内最常用的镜像。同步有分钟级延迟，但直连快得多 */
export const NPM_MIRROR = 'https://registry.npmmirror.com';

/** 面板下拉框用的预设 */
export const PRESETS = [
  { id: 'official', name: 'npm 官方源', url: OFFICIAL, note: '默认。直连 registry.npmjs.org' },
  { id: 'npmmirror', name: 'npmmirror 镜像（阿里）', url: NPM_MIRROR, note: '国内直连快，与官方有分钟级同步延迟' },
  { id: 'custom', name: '自定义', url: '', note: '公司内网源 / 自建 registry，必须 http(s)' },
];

/**
 * 规范化一个 registry 地址：补协议、去尾斜杠、只认 http(s)。
 * 认不出来返回空串（调用方按「没配」处理，不抛）。
 */
export function normRegistry(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return withProto.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** 从 .npmrc 文本里挑出 `registry=` 那一行 */
function parseNpmrc(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith(';')) continue;
    const m = l.match(/^registry\s*=\s*(.+)$/i);
    if (!m) continue;
    const url = normRegistry(String(m[1]).replace(/^["']|["']$/g, ''));
    if (url) return url;
  }
  return '';
}

/** `.npmrc` 只读一次：进程生命周期里它不该变 */
let npmrcCache; // undefined = 没读过；'' = 读过了但没有
function npmrcRegistry() {
  if (npmrcCache !== undefined) return npmrcCache;
  /** 顺序对齐 npm 自己：项目级覆盖用户级 */
  for (const f of [join(process.cwd(), '.npmrc'), join(homedir(), '.npmrc')]) {
    try {
      const url = parseNpmrc(readFileSync(f, 'utf8'));
      if (url) {
        npmrcCache = url;
        return url;
      }
    } catch {
      // 没有这个文件很正常
    }
  }
  npmrcCache = '';
  return '';
}

/** 测试用：丢掉 .npmrc 缓存 */
export function resetRegistryCache() {
  npmrcCache = undefined;
}

/**
 * 算出这次该用哪个 registry。
 *
 * @param {{override?: string}} [o] `override` 来自配置里的 `update.registry`
 * @returns {{url: string, source: 'explicit'|'env'|'npmrc'|'default'}}
 */
export function resolveRegistry({ override } = {}) {
  const own = normRegistry(override);
  if (own) return { url: own, source: 'explicit' };

  const env = normRegistry(process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY);
  if (env) return { url: env, source: 'env' };

  const rc = npmrcRegistry();
  if (rc) return { url: rc, source: 'npmrc' };

  return { url: OFFICIAL, source: 'default' };
}

/**
 * 给 `npm install` 拼 `--registry` 参数。
 *
 * **官方源时不传**：那说明用户什么都没配，让 npm 走它自己的默认逻辑
 * （还会读 `.npmrc` 里的 scoped registry），少一处可能打架的地方。
 *
 * @param {{override?: string}} [o]
 * @returns {string[]}
 */
export function registryArgs(o) {
  const r = resolveRegistry(o);
  return r.source === 'default' ? [] : [`--registry=${r.url}`];
}

/**
 * 直链下载（tgz）用的候选源，按尝试顺序。
 *
 * 用户配的源优先，然后官方，最后镜像兜底。直链下载绕过了 npm，
 * 所以必须由我们自己准备这份列表。
 *
 * @param {{override?: string}} [o]
 * @returns {string[]}
 */
export function downloadRegistries(o) {
  const r = resolveRegistry(o);
  return [...new Set([r.url, OFFICIAL, NPM_MIRROR].filter(Boolean))];
}

/**
 * npm 包的 tgz 直链。
 *
 * scoped 包（`@scope/name`）的 tarball 文件名**不带 scope**：
 *   https://registry.npmjs.org/@scope/name/-/name-1.0.0.tgz
 */
export function tgzUrl(name, version, registry = OFFICIAL) {
  const base = normRegistry(registry) || OFFICIAL;
  const full = String(name);
  const short = full.includes('/') ? full.split('/').pop() : full;
  return `${base}/${full}/-/${short}-${version}.tgz`;
}
