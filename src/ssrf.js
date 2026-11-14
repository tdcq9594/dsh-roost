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

export function isLoopbackHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || loopbackIp(h);
}

/**
 * 同步检查。返回 URL 对象，不合法直接抛。
 * @param {string} raw
 * @param {{allowLoopback?:boolean, allowHosts?:string[], allowPorts?:number[]}} opts
 */
export function checkUrlSync(raw, { allowLoopback = false, allowHosts = [], allowPorts = null } = {}) {
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
  if (allowHosts.some((h) => String(h).toLowerCase() === host)) return u;
  if (isIP(host)) {
    if (isPrivateIp(host) && !(allowLoopback && loopbackIp(host))) {
      throw new Error('不许访问内网 / 回环地址');
    }
  } else if (isLoopbackHost(host) && !allowLoopback) {
    throw new Error('不许访问本机回环地址');
  }
  return u;
}

/** 异步：解析 DNS 后逐 IP 校验，挡 DNS rebinding */
export async function assertSafeUrl(raw, opts = {}) {
  const u = checkUrlSync(raw, opts);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  /** 显式 allowHosts 是主人自己列的白名单，优先级最高 */
  if ((opts.allowHosts || []).some((h) => String(h).toLowerCase() === host.toLowerCase())) return u.href;
  /**
   * 纵深防御：字面 IP 再判一次私有，不把安全全押在 checkUrlSync 一处。
   * 以前这里是 `if (isIP(host)) return u.href` 直接放行，同步校验一旦
   * 有漏网（如 ::ffff: 十六进制组）就整个失守。
   */
  if (isIP(host)) {
    if (isPrivateIp(host) && !(opts.allowLoopback && loopbackIp(host))) {
      throw new Error('不许访问内网 / 回环地址');
    }
    return u.href;
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`域名解析失败：${e.message}`);
  }
  if (!addrs.length) throw new Error('域名没有解析结果');
  for (const { address } of addrs) {
    const loopback = address === '127.0.0.1' || address === '::1';
    if (isPrivateIp(address) && !(opts.allowLoopback && loopback)) {
      throw new Error(`域名解析到内网地址 ${address}，拒绝访问`);
    }
  }
  return u.href;
}
