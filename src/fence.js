/**
 * 面板 API 的请求栅栏。
 *
 * 为什么必须有：`dsh-host-webserver` **没有全局中间件**，宿主那套
 * Host/Origin 栅栏 + 浏览器会话鉴权只包在它自己注册的路由上
 * （`dsh-client-connection` 的 register/upgrade、`dsh-api-gateway`、
 * `dsh-host-open-in-app`）。插件用 `kind: 'exact'` 注册的路由完全不过闸——
 * 任何能连上端口的人都能读日记、删记忆、改配置。生态的既定约定是
 * **每个注册方自己调 `connection.admit(req)`**（`requestRejection(req)`
 * 是它只取状态码的那层包装）。
 *
 * 判定顺序（照 `ouli-1242/dsh-plugin-tool-management` 的 http-fence 与
 * `dsh-whale-widget` 的实战写法，两家都踩过坑）：
 *   1. `admit()` 在就用它 —— 它额外交回 Peer，才回答得了"调用方是不是 owner"；
 *   2. 只有 `requestRejection()` 就用它（拿不到 Peer，只能判"拦不拦"）；
 *   3. 两个都不在（老宿主 / 非 web 组合）→ 本地最小判定，**并且要出声**；
 *   4. 任何一步抛异常 → 403（fail-closed），不能当成放行。
 *
 * 三条硬约束，都是别人踩出来的：
 *   · `principal` **缺席要放行**：0.2.0-rc.2 的 OperatorPeer 没有这个字段，
 *     判成"非 owner"会把每一次合法的 GUI 请求都 403；
 *   · 宿主栅栏在岗且没拒 → **不要再叠加**本地判定：宿主的 trustedHosts
 *     插件拿不到，重复判定只会更松或更严，都不对；
 *   · 降级必须可见：静默回退会让用户以为浏览器鉴权还在。
 */

/** 回环 Host：localhost / [::1] / 127.0.0.0-8 */
const LOOPBACK = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/i;

/**
 * 宿主交回的 Peer，挂在 req 上给 handler 用。
 *
 * 为什么用 Symbol：这是插件自己的元数据，不该出现在任何序列化结果里，
 * 也不该和 req 上已有的字段撞名。
 */
export const PEER = Symbol.for('roost.peer');

/** 取一个请求头（Node 的 http 头可能是数组） */
export function headerOf(req, name) {
  const v = req?.headers?.[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * 宿主栅栏不在场时的本地最小判定。
 *
 * 能挡的是"其他网页打本机接口"这一类：Host 必须是回环（DNS rebinding 里
 * 攻击者唯一伪造不了的头）、跨站标记一律拒、Origin 必须与 Host 同源。
 * 挡不住的是"本机任意进程直接 curl" —— 那需要会话凭证，本地链没有。
 *
 * @returns {null | {status: number, why: string}} null = 放行
 */
export function localRejection(req) {
  const raw = headerOf(req, 'host');
  let host;
  try {
    host = new URL(`http://${raw}`);
  } catch {
    /** 缺 Host 与畸形 Host 一样拒：浏览器一定会发 Host，没有就不是页面来的 */
    return { status: 403, why: 'Host 头缺失或无法解析' };
  }
  if (!LOOPBACK.test(host.hostname)) {
    return { status: 403, why: 'Host 必须是本机回环地址（防 DNS rebinding）' };
  }
  if (String(headerOf(req, 'sec-fetch-site')).toLowerCase() === 'cross-site') {
    return { status: 403, why: '跨站请求被拒' };
  }
  const origin = headerOf(req, 'origin');
  if (origin) {
    try {
      if (new URL(origin).host !== host.host) return { status: 403, why: 'Origin 与 Host 不同源' };
    } catch {
      return { status: 403, why: 'Origin 头无法解析' };
    }
  }
  return null;
}

/** 拒绝文案：401 是"没登录"，403 是"来源不对"，别混着说 */
function reasonOf(status) {
  return status === 401
    ? '需要先登录 DSH：请从 DSH 打开的面板里操作'
    : '请求不是发往本机面板的同源请求，已拒绝';
}

/**
 * 造一个栅栏函数。
 *
 * @param {object} o
 * @param {() => object | null} [o.connection] 每次请求现取 `ctx.get('connection')`
 *   —— 服务可能在 apply 之后才挂上，也可能整场都没有。
 * @param {(m: string) => void} [o.log] 降级时出声（只出一次）
 * @returns {(req: object) => null | {status: number, why: string}}
 */
export function createFence({ connection, log = () => {} } = {}) {
  let degraded = false;

  const readConn = () => {
    try {
      return typeof connection === 'function' ? connection() : connection;
    } catch {
      return null;
    }
  };

  const fence = function (req) {
    const conn = readConn();

    try {
      if (typeof conn?.admit === 'function') {
        const admission = conn.admit(req);
        /**
         * `undefined` 表示这道实现不认得这次请求（老宿主的 admit 可能返回空），
         * 那就往下试 `requestRejection`，而不是当成放行。
         */
        if (admission !== undefined) {
          degraded = false;
          if (admission && typeof admission === 'object' && 'rejection' in admission) {
            const status = Number(admission.rejection) || 403;
            return { status, why: reasonOf(status) };
          }
          /**
           * Peer 有没有 `principal` 随宿主版本变：0.2.0-rc.2 直接交 OperatorPeer，
           * 它的字段只有 id/ctx/scope。所以"缺席"是**正常**的，按 owner 放行；
           * 只有在场且明确不是 owner 才拒。
           */
          const kind = admission?.peer?.principal?.kind;
          if (kind !== undefined && kind !== 'owner') {
            return { status: 403, why: '调用方不是本机所有者' };
          }

          /**
           * 把 Peer 留给 handler。**授权判断用它，不要用请求体里的 `actor`**
           * ——那个字段是调用方自己填的，写 `{bucket:'owner'}` 就能自称主人。
           */
          if (admission?.peer) {
            try {
              req[PEER] = admission.peer;
            } catch {
              // 冻结对象等极端情况：拿不到 Peer 不影响放行，只是审计少一条身份
            }
          }
          return null;
        }
      }

      if (typeof conn?.requestRejection === 'function') {
        const code = conn.requestRejection(req);
        degraded = false;
        if (typeof code === 'number' && code > 0) return { status: code, why: reasonOf(code) };
        /** 栅栏在岗且没给拒绝码 = 已通过；不再叠加本地判定 */
        return null;
      }
    } catch (e) {
      /**
       * 栅栏自己抛错时**不能**当成放行。旧实现用 `return false` 把异常读成
       * "没被拒"，等于给了一个静默放行的后门。
       */
      return { status: 403, why: `请求栅栏异常，按拒绝处理：${e?.message ?? e}` };
    }

    if (!degraded) {
      degraded = true;
      log(
        conn
          ? '面板 API：宿主 connection 服务没有 admit / requestRejection，已降级为本地判定（只校验回环 Host 与同源，没有浏览器会话鉴权）'
          : '面板 API：宿主没有 connection 服务，已降级为本地判定（只校验回环 Host 与同源，没有浏览器会话鉴权）',
      );
    }
    return localRejection(req);
  };

  /**
   * 当前是否处于降级状态：宿主没有 `connection` 服务，只剩「回环 Host + 同源」
   * 这道本地判定，**没有浏览器会话鉴权**。面板要据此提示用户。
   */
  fence.isDegraded = () => degraded;

  return fence;
}
