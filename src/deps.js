/**
 * 框架 / ai-chat 插件的版本对照（只提示，不代劳）。
 *
 * 为什么放在「接入」页：这两样版本错配是「面板看着正常、群里不吭声」的常见原因——
 * 框架老到不认 `msg.groupName`，群标题就只能是「群 xxxxxx」；插件老到还在拿
 * 发送者昵称当群名。用户看不出来，只能靠面板主动提示。
 *
 * **不替用户更新**：
 *   · 框架是 tar 包解压，覆盖前要不要备份、解到哪个目录，用户得自己决定；
 *   · 插件在 Roost 面板的「插件 → 市场」里点更新，那边有 sha 校验和回滚。
 * 这里只把「当前 vs 最新」摆出来，并说清下一步去哪儿。
 *
 * 宿主自己的自更新是另一套（`update.js`，走 DSH 的 pluginManager）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersion } from './version.js';

const FW_REPO = 'tdcq9594/qq-bot-roost';
const PLUGIN_INDEX =
  'https://raw.githubusercontent.com/tdcq9594/qq-bot-roost-plugins/main/index.json';

/** 查一次缓存半小时：面板每次打开都打一遍 GitHub 没必要，也容易撞限额 */
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 6000;

/** 从插件目录读 ai-chat 的版本：先看 index.js，再看 package.json */
export function readPluginVersion(dir) {
  if (!dir) return '';
  const base = join(dir, 'plugins', 'ai-chat');
  try {
    const s = readFileSync(join(base, 'index.js'), 'utf8');
    const m = s.match(/^\s*version:\s*['"]([^'"]+)['"]/m);
    if (m) return m[1];
  } catch {
    /* 没装或读不了 */
  }
  try {
    return String(JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
}

/**
 * 框架最新版：先走 `releases/latest` 的 302 跳转（不占 API 限额），
 * 拿不到再退回 API。两条都失败就返回 error，不抛。
 */
async function latestFramework(fetchImpl) {
  try {
    const r = await fetchImpl(`https://github.com/${FW_REPO}/releases/latest`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const loc = String(r?.headers?.get?.('location') || '');
    const tag = loc.split('/').filter(Boolean).pop() || '';
    if (/^v?\d+\.\d+\.\d+/.test(tag)) return { latest: tag.replace(/^v/, '') };
  } catch {
    /* 继续走 API */
  }

  try {
    const r = await fetchImpl(`https://api.github.com/repos/${FW_REPO}/releases/latest`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const j = await r.json();
    const tag = String(j?.tag_name || '').replace(/^v/, '');
    if (/^\d+\.\d+\.\d+/.test(tag)) return { latest: tag };
    return { latest: '', error: '仓库里还没有已发布的版本' };
  } catch (e) {
    return { latest: '', error: e?.message || '查不到最新版' };
  }
}

/** 插件最新版：读插件仓库的索引（和 Roost 市场同一个源） */
async function latestPlugin(fetchImpl) {
  try {
    const r = await fetchImpl(PLUGIN_INDEX, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r && r.ok === false) throw new Error(`HTTP ${r.status || '?'}`);
    const j = await r.json();
    const p = (j?.plugins || []).find((x) => x.id === 'ai-chat');
    if (!p?.version) return { latest: '', error: '插件索引里没有 ai-chat' };
    return { latest: String(p.version) };
  } catch (e) {
    return { latest: '', error: e?.message || '查不到最新版' };
  }
}

const pack = (id, name, installed, r) => {
  const latest = String(r?.latest || '');
  const hasUpdate = Boolean(installed && latest) && compareVersion(latest, installed) > 0;
  return { id, name, installed, latest, hasUpdate, error: r?.error || '' };
};

/**
 * @param {object} o
 * @param {() => Promise<object>} o.detect   setup.detect()，给 dir / version / pluginInstalled
 * @param {Function} [o.fetchImpl]
 * @param {() => number} [o.now]
 * @param {(m:string)=>void} [o.log]
 */
export function createDepsCheck({ detect, fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  let cache = null;

  return {
    async check({ force = false } = {}) {
      if (!force && cache && now() - cache.at < TTL_MS) return cache.value;

      const s = await Promise.resolve()
        .then(() => detect())
        .catch((e) => {
          log(`读安装状态失败：${e.message}`);
          return {};
        });

      const dir = String(s?.dir || '');
      const installedFw = String(s?.version || '');
      const installedPlugin = readPluginVersion(dir);

      const [fw, pl] = await Promise.all([latestFramework(fetchImpl), latestPlugin(fetchImpl)]);

      const value = {
        ok: true,
        at: now(),
        framework: pack('qq-bot-roost', '框架', installedFw, fw),
        plugin: pack('ai-chat', 'ai-chat 插件', installedPlugin, pl),
      };
      cache = { at: now(), value };
      return value;
    },
  };
}
