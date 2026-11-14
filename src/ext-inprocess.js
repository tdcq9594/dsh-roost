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

/** id -> { mtime, mod, actions, actionsMtime, ctx } */
const cache = new Map();

export function clearInProcessCache(id) {
  if (id) cache.delete(id);
  else cache.clear();
}

/**
 * 每个扩展一份**活对象**：配置与密钥都写进同一个引用里。
 *
 * 为什么不能每次新建：`createActions()` 只在文件 mtime 变化时调用一次
 * （重建 api 客户端要重新握手，不能每点一次按钮就建一遍）。如果工厂
 * 拿的是「创建那一刻的 config」，面板上改了设置，按钮用的还是旧值——
 * 表现就是「设置改了没反应，得重启」。
 *
 * 所以工厂拿到的是引用，之后每次调用前原地更新内容。扩展代码里
 * 只要写 `config.xxx`（而不是在创建时把值抠出来存成局部变量），
 * 读到的就永远是最新值。
 */
function ctxOf(id) {
  let c = cache.get(id);
  if (!c) {
    c = { mtime: 0, mod: null, actions: null, actionsMtime: 0, ctx: { config: {}, secrets: {}, env: {} } };
    cache.set(id, c);
  }
  return c;
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
 * 把日志适配成**函数**再交给扩展。
 *
 * 宿主内部的 `log` 是对象（`{ info, warn, debug }`），但扩展作者看到
 * `createActions({ log })` 只会当函数用（`log('xxx')`）。这个边界两侧的
 * 约定不一致，2026-11-14 因此连犯两次同样的错：动作一提交就
 * `log is not a function`，面板显示「没提交上」。
 *
 * 与其在每个调用点记得包一层，不如在**唯一的入口**处适配一次——
 * 扩展永远拿到函数，宿主内部继续用对象。
 */
function asLog(v) {
  if (typeof v === 'function') return v;
  if (v && typeof v.warn === 'function') return (m) => v.warn(m);
  if (v && typeof v.info === 'function') return (m) => v.info(m);
  return () => {};
}

/**
 * 跑一个动作。
 *
 * @returns {Promise<{handled:boolean, result?:any, reason?:string}>}
 *   `handled:false` 表示这个动作模块没实现（或没导出 createActions），
 *   调用方应当回落到 MCP 队列 —— 两种形态可以混着用。
 */
export async function runInProcessAction({
  id, root, entry, action, payload = null,
  config = {}, secrets = {}, env = {}, log = () => {}, timeoutMs = 30_000,
  /** 宿主内部「系统会话轮次」：让进程内扩展像 aurabot 那样直接跑一轮模型 */
  systemTurn = null,
} = {}) {
  if (!id || !root || !entry) return { handled: false, reason: '缺参数' };
  const { mod, mtime } = await loadModule({ id, root, entry });
  const factory = mod?.createActions ?? mod?.default?.createActions;
  if (typeof factory !== 'function') return { handled: false, reason: '入口没有导出 createActions' };

  const rec = ctxOf(id);
  /**
   * **原地更新**，不是替换引用：工厂可能持有 `config` 这个对象，
   * 换引用等于它手里那个还是旧的。先清空再赋值，删掉的键也能同步消失
   * （否则「取消勾选某个项」之后旧值会一直留着）。
   */
  for (const k of Object.keys(rec.ctx.config)) delete rec.ctx.config[k];
  Object.assign(rec.ctx.config, config || {});
  for (const k of Object.keys(rec.ctx.secrets)) delete rec.ctx.secrets[k];
  Object.assign(rec.ctx.secrets, secrets || {});
  /**
   * 一小撮宿主侧信息：模块跑在宿主进程里，拿不到注入给 MCP 子进程的那份
   * env（`ROOST_DEPS_DIR` 就是典型——共享依赖路径只有宿主自己知道）。
   */
  for (const k of Object.keys(rec.ctx.env)) delete rec.ctx.env[k];
  Object.assign(rec.ctx.env, env || {});

  /** actions 也按 mtime 缓存：每次点击都重建 api 客户端会重复握手 */
  let actions = rec.actionsMtime === mtime ? rec.actions : null;
  if (!actions) {
    actions = await factory({
      config: rec.ctx.config,
      /** 明文密钥只在这个边界内出现：模块跑在宿主进程里，本来就读得到存储文件 */
      secrets: rec.ctx.secrets,
      env: rec.ctx.env,
      log: asLog(log),
      id,
      systemTurn,
    });
    if (!actions || typeof actions !== 'object') return { handled: false, reason: 'createActions 没返回对象' };
  }
  rec.mtime = mtime;
  rec.mod = mod;
  rec.actions = actions;
  rec.actionsMtime = mtime;

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
