/**
 * 5.11 安全防护之二：出站 URL 统一 SSRF 校验。
 *
 * 项目里能发 URL 的地方不止一处（扩展市场索引/分发包、embedding 服务、
 * 语音服务、生图/ASR 的素材地址）。以前只有 `assertSafeIndexUrl` 挡了
 * 「https 或本机回环」，但**没有做 DNS 解析后的逐 IP 检查**——
 * 一个指向公网的域名可以解析到 127.0.0.1 / 169.254.169.254（元数据服务），
 * 这就是 DNS rebinding。
 *
 * 两层：
 *   · checkUrlSync  → 协议 / 凭据 / 端口 / 字面 IP，同步，零 IO
 *   · assertSafeUrl → 再解析 DNS，逐 IP 判私有/回环/保留，异步
 *
 * 默认全拒内网。用户自建服务（比如本机 embedding）需要显式
 * `allowLoopback` 或把域名列进 `allowHosts`，不能靠「看起来是本机」猜。
 *
 * 1.3.2 补的三个口子（都是 1.3.1 实践里撞出来的，不再靠猜）：
 *   · `allowPrivate` —— 面板「安全防护」的内网放行开关。只放开局域网私有段
 *     （10/8、172.16/12、192.168/16、100.64/10、fc00::/7），回环、云元数据
 *     （169.254）、保留段（198.18 等）照旧拦；
 *   · `trustedHosts` —— 代码里写死的供应链主机（插件市场索引 / 分发包）
 *     跳过 DNS 逐 IP 校验：它们不归攻击者控制，而 Clash 的 fake-ip 会把它们
 *     解析成 198.18.x.x，逐 IP 校验会把「挂了代理的正常用户」全拦死；
 *   · `allowHosts` 不再豁免字面内网 IP —— 白名单是「哪个域名可以访问」，
 *     不是「哪个 IP 可以访问」。1.3.1 里它排在字面 IP 判定之前，
 *     `allowHosts:['127.0.0.1']` 就能整道绕过。
 */

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const DEFAULT_PORTS = [80, 443, 8080, 8443];

/**
 * 把 IPv4-mapped IPv6 还原成点分 IPv4；不是映射地址返回 ''。
 *
 * `new URL` 会把 `http://[::ffff:127.0.0.1]/` 规范成 `::ffff:7f00:1`
 *（点分 → 十六进制组），所以两种写法都得认。2026-11-14 对抗测试实测
 * `::ffff:7f00:1` / `::ffff:a9fe:a9fe`（云元数据 169.254.169.254）/
 * `::ffff:a00:1`（10.0.0.1）三种都能绕过旧版校验。
 */
function mappedV4(ip) {
  const s = String(ip ?? '').toLowerCase();
  const m = /^::ffff:(.+)$/.exec(s);
  if (!m) return '';
  const rest = m[1];
  if (isIP(rest) === 4) return rest;
  const parts = rest.split(':').filter(Boolean);
  if (parts.length === 2 && parts.every((p) => /^[0-9a-f]{1,4}$/i.test(p))) {
    const hi = parseInt(parts[0], 16);
    const lo = parseInt(parts[1], 16);
    return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
  }
  return '';
}

/** 含 IPv4-mapped 形式的回环判定，给 allowLoopback 用 */
function loopbackIp(ip) {
  const s = String(ip ?? '').toLowerCase();
  return s === '127.0.0.1' || s === '::1' || mappedV4(s) === '127.0.0.1';
}

/** IPv4 / IPv6 的私有、回环、链路本地、保留、组播地址 */
export function isPrivateIp(ip) {
  const s = String(ip ?? '').toLowerCase().split('%')[0];
  if (!s) return true; // 空地址一律当不安全
  if (isIP(s) === 4) {
    const p = s.split('.').map(Number);
    const [a, b] = p;
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)                 // 链路本地 / 云元数据
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)       // CGNAT
      || (a === 192 && b === 0 && p[2] === 0)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;                                // 组播 + 保留
  }
  if (isIP(s) === 6) {
    if (s === '::' || s === '::1') return true;
    /**
     * IPv4-mapped IPv6：点分与十六进制组都还原成 IPv4 再判。
     * 认不出来的 `::ffff:` 一律按私有处理（fail-closed），别再放行。
     */
    if (s.startsWith('::ffff:')) {
      const v4 = mappedV4(s);
      return v4 ? isPrivateIp(v4) : true;
    }
    const head = s.split(':')[0];
    if (/^f[cd]/.test(head)) return true;          // fc00::/7 唯一本地
    if (/^fe[89ab]/.test(head)) return true;       // fe80::/10 链路本地
    return false;
  }
  return false;
}

/**
 * 只判「局域网私有段」：`10/8`、`172.16/12`、`192.168/16`、`100.64/10`（CGNAT，
 * Tailscale / ZeroTier 都落在这段）、IPv6 `fc00::/7`。
 *
 * 和 `isPrivateIp` 的区别是**不含**回环、链路本地（`169.254`，云元数据）、
 * 保留段（`198.18`）、组播——`allowPrivate` 只该放开「我自建的内网服务」，
 * 不该顺带放开「模型能读云元数据、能打本机端口」。
 */
export function isLanIp(ip) {
  const s = String(ip ?? '').toLowerCase().split('%')[0];
  if (!s) return false;
  if (isIP(s) === 4) {
    const [a, b] = s.split('.').map(Number);
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(s) === 6) {
    if (s.startsWith('::ffff:')) {
      const v4 = mappedV4(s);
      return v4 ? isLanIp(v4) : false;
    }
    return /^f[cd]/.test(s.split(':')[0]);
  }
  return false;
}

/**
 * 「这个地址该拦吗」的唯一裁决点，`checkUrlSync` 与 `assertSafeUrl` 都走它。
 *
 * 默认（两项都没开）= 不安全段全拒，和 1.3.1 之前的实际行为一致；
 * 两个开关各自只放开一类，互不代偿：
 *   · `allowLoopback` → 只放开 `127.0.0.1` / `::1`（本机面板、自建 embedding）
 *   · `allowPrivate`  → 只放开 `isLanIp` 那几段（自建内网服务）
 */
export function blockedIp(ip, { allowPrivate = false, allowLoopback = false } = {}) {
  if (!isPrivateIp(ip)) return false;
  if (allowLoopback && loopbackIp(ip)) return false;
  if (allowPrivate && isLanIp(ip)) return false;
  return true;
}

export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || loopbackIp(h);
}

/**
 * 同步检查。返回 URL 对象，不合法直接抛。
 *
 * `allowHosts` 仍然收着（调用方在传），但**不再豁免字面内网 IP**：
 * 白名单是「这个域名可以访问」，不是「这个 IP 可以访问」。1.3.1 里
 * 白名单命中的分支排在字面 IP 判定之前，等于 `allowHosts:['127.0.0.1']`
 * 就能绕过整道闸——宿主是主人自己写的，可扩展和模型给的值不是。
 * @param {string} raw
 * @param {{allowLoopback?:boolean, allowPrivate?:boolean, allowHosts?:string[], allowPorts?:number[]}} opts
 */
export function checkUrlSync(raw, {
  allowLoopback = false, allowPrivate = false, allowHosts = [], allowPorts = null,
} = {}) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw new Error('不是合法 URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只许 http/https，收到 ${u.protocol}`);
  }
  if (u.username || u.password) throw new Error('URL 里不许带账号密码');
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  const ports = allowPorts || DEFAULT_PORTS;
  if (!ports.includes(port)) throw new Error(`端口 ${port} 不在白名单`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (blockedIp(host, { allowPrivate, allowLoopback })) {
      throw new Error('不许访问内网 / 回环地址');
    }
    return u;
  }
  if (isLoopbackHost(host) && !allowLoopback) {
    throw new Error('不许访问本机回环地址');
  }
  return u;
}

/** 主机是否在白名单里（大小写 / 空白都归一化，列表里混进 null 也不炸） */
function hostIn(host, list) {
  const h = String(host ?? '').toLowerCase();
  if (!h) return false;
  return (Array.isArray(list) ? list : []).some((x) => String(x ?? '').trim().toLowerCase() === h);
}

/**
 * 异步：解析 DNS 后逐 IP 校验，挡 DNS rebinding。
 *
 * `trustedHosts` 是「代码里写死、不归攻击者控制」的供应链入口
 * （插件市场的索引 / 分发包主机）。它们只跳过 DNS 逐 IP 这一层，
 * 协议、端口、凭据、字面 IP 仍由 `checkUrlSync` 判。
 *
 * 为什么必须有这一层：Clash / mihomo 的 fake-ip 模式默认把
 * `198.18.0.0/16` 当假地址池，任何域名都解析成 `198.18.x.x`；
 * 逐 IP 校验会把它当保留段拒掉，于是「挂了代理的正常用户」插件市场
 * 永远打不开（2026-11-15 报错实录：`域名解析到内网地址 198.18.0.32`）。
 */
export async function assertSafeUrl(raw, opts = {}) {
  const u = checkUrlSync(raw, opts);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const allowPrivate = opts.allowPrivate === true;
  const allowLoopback = opts.allowLoopback === true;
  /** 主人显式列的域名：跳过 DNS 校验（自建服务 / fake-ip 代理下的自救手段） */
  if (hostIn(host, opts.allowHosts)) return u.href;
  /**
   * 纵深防御：字面 IP 再判一次私有，不把安全全押在 checkUrlSync 一处。
   * 以前这里是 `if (isIP(host)) return u.href` 直接放行，同步校验一旦
   * 有漏网（如 ::ffff: 十六进制组）就整个失守。
   */
  if (isIP(host)) {
    if (blockedIp(host, { allowPrivate, allowLoopback })) {
      throw new Error('不许访问内网 / 回环地址');
    }
    return u.href;
  }
  /** 可信供应链主机：见函数注释，不走 DNS 判定 */
  if (hostIn(host, opts.trustedHosts)) return u.href;
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`域名解析失败：${e.message}`);
  }
  if (!addrs.length) throw new Error('域名没有解析结果');
  for (const { address } of addrs) {
    if (blockedIp(address, { allowPrivate, allowLoopback })) {
      throw new Error(`域名解析到内网地址 ${address}，拒绝访问`);
    }
  }
  return u.href;
}
