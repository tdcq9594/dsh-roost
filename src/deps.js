/**
 * 框架版本对照（只提示，不代劳）。
 *
 * 放在「接入」页：框架老到没有外接协议时，直连会直接起不来，
 * 用户看不出原因，只能靠面板主动提示「先升级」。
 *
 * 移除 ai-chat 之后不再查任何插件版本——那一层已经不存在了，
 * 查它只会多打一次 GitHub 并在面板上显示一行永远「没装」的东西。
 *
 * **不替用户更新**：框架是 tar 包解压，覆盖前要不要备份、解到哪个目录，
 * 用户得自己决定。这里只把「当前 vs 最新」摆出来。
 *
 * 宿主自己的自更新是另一套（`update.js`，走 DSH 的 pluginManager）。
 */

import { compareVersion } from './version.js';

const FW_REPO = 'tdcq9594/qq-bot-roost';

/** 查一次缓存半小时：面板每次打开都打一遍 GitHub 没必要，也容易撞限额 */
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 6000;

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

const pack = (id, name, installed, r) => {
  const latest = String(r?.latest || '');
  const hasUpdate = Boolean(installed && latest) && compareVersion(latest, installed) > 0;
  return { id, name, installed, latest, hasUpdate, error: r?.error || '' };
};

/**
 * @param {object} o
 * @param {() => Promise<object>} o.detect   setup.detect()，给 version
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

      const installedFw = String(s?.version || '');
      const fw = await latestFramework(fetchImpl);

      const value = {
        ok: true,
        at: now(),
        framework: pack('qq-bot-roost', '框架', installedFw, fw),
      };
      cache = { at: now(), value };
      return value;
    },

  };
}
