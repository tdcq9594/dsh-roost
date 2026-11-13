/**
 * 可选依赖 `ws`：查状态 / 给框架装 / 加载
 * =====================================
 *
 * 事件流有两条等价通道：`GET /events`（SSE）和 `GET /ws`（双向帧）。
 * 只用 SSE 时**一个依赖都不需要**——这是默认路径，也是「零依赖」的含义。
 * 装了 `ws` 就能走 WS：延迟更低、能双向、对反向代理更友好。
 *
 * ## 装到**框架**那边，不装到这边
 *
 * `ws` 是 Roost 框架的依赖（它自己的 `/ws` 双向通道也要用，OneBot 兼容层
 * 也用同一份），装在 `<roost>/data/deps/ext/node_modules/ws`。dsh-roost 与它
 * 同机直连，所以：
 *
 *   · 查/装都走**框架自己的面板接口**（`POST /api/ext/deps/install`；
 *     老框架只有 `/api/onebot/deps/install`，会自动回退），
 *     装完它还会自动重配所有 host，框架的 `/ws` 立刻可用；
 *   · 目录先看 `data/deps/ext`（1.0.15 起），没有再退回
 *     `data/deps/onebot`（老的 OneBot 专用目录，升级时没搬过来的机器）；
 *   · 加载时直接 require 那一份，**不在插件侧再存一份**——两份各自升级会
 *     出现「版本不一致、行为对不上」的怪状态。
 *
 * 这也是「一键直连时顺带装」的实现：顺带装的是框架的依赖。
 *
 * ## 三条硬原则（与框架侧 `ext-deps.js` 一致）
 *
 *   1. **包名白名单**：只认 `ws`。面板传来的任意包名等于把弱口令升级成 RCE。
 *   2. **不自动装、不自动升级**：只在用户点「一键直连 / 一键安装」时动手。
 *   3. **装不上不影响任何功能**：SSE 照旧可用，只是没有 WS。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 唯一允许安装的包 */
export const WS_PACKAGE = 'ws';
/** 与框架侧白名单保持同一版本范围：锁主版本，留补丁位 */
export const WS_RANGE = '^8.18.0';

/**
 * @param {object} o
 * @param {(m:string)=>void} [o.log]
 */
export function createWsDeps({ log = () => {} } = {}) {
  /**
   * 框架依赖目录。**两个候选**：
   *   · `data/deps/ext`    —— 1.0.15 起，宿主协议与 OneBot 共用；
   *   · `data/deps/onebot` —— 旧目录，只在老框架 / 还没迁移的机器上存在。
   * 先看新目录，没有再回退旧的；两边都在时以新目录为准。
   */
  const depsRoots = (roostDir) => {
    const base = join(String(roostDir || '').trim(), 'data', 'deps');
    return [join(base, 'ext'), join(base, 'onebot')];
  };
  const pickRoot = (roostDir) => {
    const [ext, legacy] = depsRoots(roostDir);
    if (existsSync(ext)) return ext;
    if (existsSync(legacy)) return legacy;
    return ext;
  };
  const depsRoot = (roostDir) => pickRoot(roostDir);
  const pkgPathIn = (root) => join(root, 'node_modules', WS_PACKAGE, 'package.json');
  const pkgPath = (roostDir) => pkgPathIn(depsRoot(roostDir));

  /**
   * 框架那份装没装。**不抛错**——面板一打开就调它，没装也要如实回。
   *
   * @param {string} roostDir 框架安装目录
   */
  function status(roostDir) {
    const root = depsRoot(roostDir);
    const installed = Boolean(String(roostDir || '').trim()) && existsSync(pkgPath(roostDir));
    let version = '';
    if (installed) {
      try {
        version = String(JSON.parse(readFileSync(pkgPath(roostDir), 'utf8')).version ?? '');
      } catch {
        version = '';
      }
    }
    return {
      ok: true,
      package: WS_PACKAGE,
      range: WS_RANGE,
      /** 装在哪（面板上显示给用户看） */
      dir: root,
      installed,
      version,
      /** 文件在就算可用；版本读不出来只是没法显示版本号 */
      usable: installed,
    };
  }

  /**
   * 从框架的依赖目录加载。没装返回 null（调用方自动走 SSE）。
   *
   * @param {string} roostDir 框架安装目录
   */
  function load(roostDir) {
    if (!String(roostDir || '').trim()) return null;
    if (!existsSync(pkgPath(roostDir))) return null;
    try {
      const req = createRequire(join(depsRoot(roostDir), 'package.json'));
      const m = req(WS_PACKAGE);
      return m?.WebSocket ? m : { WebSocket: m?.default ?? m };
    } catch (e) {
      log(`加载框架的 ws 失败：${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * 给框架装 `ws`。走框架自己的面板接口，装完它会重配所有 host。
   *
   * @param {object} o
   * @param {(path:string, init?:object)=>Promise<any>} o.api  `setup.api`
   * @param {string} o.roostDir
   * @returns {Promise<{ok:boolean, mode:string, version?:string, message:string}>}
   */
  async function installToRoost({ api, roostDir }) {
    if (!String(roostDir || '').trim()) {
      return { ok: false, mode: 'failed', message: '还没找到 Roost 安装目录，先在接入页装好并启动' };
    }
    const before = status(roostDir);
    if (before.installed) {
      return {
        ok: true,
        mode: 'reuse',
        version: before.version,
        message: `框架已装 ws${before.version ? ` v${before.version}` : ''}，直接复用`,
      };
    }

    const body = JSON.stringify({ packages: [WS_PACKAGE] });
    let r;
    try {
      r = await api('/api/ext/deps/install', { method: 'POST', body });
    } catch (e) {
      /**
       * 老框架没有 `/api/ext/deps/*`（1.0.14 及之前叫 `/api/onebot/deps/*`）。
       * 只在「404 / 没有这个地址」时回退，别的错误（400 白名单、装失败）
       * 直接报出来，避免把真原因盖掉。
       */
      const msg = String(e?.message ?? e);
      if (!/404|not_found|没有这个地址/i.test(msg)) {
        return { ok: false, mode: 'failed', message: `给框架装 ws 失败：${msg}（不影响使用，事件会走 SSE）` };
      }
      try {
        r = await api('/api/onebot/deps/install', { method: 'POST', body });
      } catch (e2) {
        return {
          ok: false,
          mode: 'failed',
          message: `给框架装 ws 失败：${e2?.message ?? e2}（不影响使用，事件会走 SSE）`,
        };
      }
    }

    /**
     * 框架返回 `ok:false` 也算失败，但要把它给的原因带出来——
     * 常见是没网、没有 npm、镜像坏了，用户需要知道该修哪一个。
     */
    if (r?.ok === false) {
      return {
        ok: false,
        mode: 'failed',
        message: `给框架装 ws 失败：${r?.error || '原因不明'}（不影响使用，事件会走 SSE）`,
      };
    }

    /** 装完复查：文件真的在了才算成功，不能只信接口回 ok */
    const after = status(roostDir);
    if (!after.installed) {
      return {
        ok: false,
        mode: 'failed',
        message: '框架说装好了，但目录里没找到 ws（可能只下了一半）。不影响使用，事件会走 SSE',
      };
    }
    log(`已给框架装好 ws${after.version ? ` v${after.version}` : ''}`);
    return {
      ok: true,
      mode: 'installed',
      version: after.version,
      message: `已给框架装好 ws${after.version ? ` v${after.version}` : ''}，事件流可以走 WS`,
    };
  }

  return { status, load, installToRoost, depsRoot };
}
