/**
 * 进程内扩展模块（`ui.runtime: "inprocess"`）
 * ============================================================
 *
 * MCP 扩展是独立子进程，宿主没有它的句柄，按钮动作只能「排队 + 扩展来取」。
 * 这条路径对「刷新热门」「检查登录」这种点击即用的小动作太重了。
 *
 * 所以给扩展第二种形态：提供一个 `.mjs`，宿主 `import()` 进来，直接调它
 * 导出的 `createActions({ config, log, id })` 返回的函数。零 IPC，返回值
 * 原样回给面板，点了就有结果。
 *
 * 边界（与 `ext-ui.js` 的声明式界面不同，这里**真的会执行扩展代码**）：
 *   · 只在扩展目录内找入口，`../` 一律拒；
 *   · 模块缓存按 mtime 失效，改完文件不需要重启宿主；
 *   · 动作超时兜底，避免一个死循环把面板请求挂住；
 *   · 模块跑在宿主进程里，能拿到 `process` / `fs` —— 这是形态本身的代价，
 *     靠上架审核兜，不是这里能「校验」掉的。
 */

import { statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** id -> { mtime, mod, actions, actionsMtime } */
const cache = new Map();

export function clearInProcessCache(id) {
  if (id) cache.delete(id);
  else cache.clear();
}

function safeJoin(root, entry) {
  const base = resolve(root);
  const abs = resolve(base, entry);
  const back = relative(base, abs);
  if (!back || back === '..' || back.startsWith(`..${sep}`)) {
    throw new Error('入口文件必须在扩展目录内');
  }
  return abs;
}

async function loadModule({ id, root, entry }) {
  const abs = safeJoin(root, entry);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`读不到入口文件 ${entry}`);
  }
  if (!st.isFile()) throw new Error(`${entry} 不是文件`);

  const hit = cache.get(id);
  if (hit && hit.mtime === st.mtimeMs) return { mod: hit.mod, mtime: st.mtimeMs, hit };
  const mod = await import(pathToFileURL(abs).href);
  return { mod, mtime: st.mtimeMs, hit };
}

/**
 * 跑一个动作。
 *
 * @returns {Promise<{handled:boolean, result?:any, reason?:string}>}
 *   `handled:false` 表示这个动作模块没实现（或没导出 createActions），
 *   调用方应当回落到 MCP 队列 —— 两种形态可以混着用。
 */
export async function runInProcessAction({
  id, root, entry, action, payload = null, config = {}, log = () => {}, timeoutMs = 30_000,
} = {}) {
  if (!id || !root || !entry) return { handled: false, reason: '缺参数' };
  const { mod, mtime, hit } = await loadModule({ id, root, entry });
  const factory = mod?.createActions ?? mod?.default?.createActions;
  if (typeof factory !== 'function') return { handled: false, reason: '入口没有导出 createActions' };

  /** actions 也按 mtime 缓存：每次点击都重建 api 客户端会重复握手 */
  let actions = hit && hit.actionsMtime === mtime ? hit.actions : null;
  if (!actions) {
    actions = await factory({ config: config || {}, log, id });
    if (!actions || typeof actions !== 'object') return { handled: false, reason: 'createActions 没返回对象' };
  }
  cache.set(id, { mtime, mod, actions, actionsMtime: mtime });

  const fn = actions[action];
  if (typeof fn !== 'function') return { handled: false };

  let timer = null;
  try {
    const out = await Promise.race([
      Promise.resolve().then(() => fn(payload ?? {})),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`动作 ${action} 超过 ${Math.round(timeoutMs / 1000)} 秒没返回`)), timeoutMs);
      }),
    ]);
    return { handled: true, result: out };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
