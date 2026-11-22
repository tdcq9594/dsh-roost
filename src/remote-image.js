/**
 * 从网址取一张图进图库 —— **带 SSRF 防护的那一种**。
 *
 * ## 为什么不能直接 `fetch(url)`
 *
 * 这个函数的输入来自模型。模型可以被一张图、一句话、一段群聊说服，去请求
 * `http://127.0.0.1:8080/admin`、`http://169.254.169.254/latest/meta-data/`
 * 或者路由器后台。拿到的东西会被存进图库、再进提示词——等于给了模型一条
 * 「读内网」的通道，而且我们从日志里完全看不出异常。
 *
 * 所以这里的判断顺序是**先验目的地、再连**，而且连的时候钉住已经验过的 IP：
 *
 *   1. 只认 `http` / `https`，只认 80 / 443 端口（内网服务大多在别的端口）；
 *   2. 不许带账号密码（`http://user:pass@host/` 里的 `@` 常被用来骗解析）；
 *   3. 域名做 DNS 解析，**任何一条** A/AAAA 落在私有段就整条拒掉
 *      ——不能只查第一条，因为轮询 DNS 可以混一个内网地址进来；
 *   4. 真正连接时用 `lookup` 钩子把地址钉死成刚才验过的那一个
 *      ——否则「验的时候是公网、连的时候变内网」（DNS rebinding）就绕过去了；
 *   5. 重定向**手动跟**，每一跳重新走 1–4（能跳到内网的正是重定向）；
 *   6. 收流时按字节封顶，超了立刻断——不封顶等于让人往磁盘里灌东西；
 *   7. 落地前验魔数，认不出是图片就拒。**不认 `Content-Type`**：它由服务器
 *      随口写，而魔数改不了。
 *
 * ## 为什么端口白名单这么窄
 *
 * 允许任意端口 = 允许模型扫内网端口（`http://10.0.0.1:6379/` 之类的响应差异
 * 就是信息）。图片 CDN 基本都在 80/443，收窄的代价极小。
 */

import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

/** 单张上限。官方素材池单图也是 10MB，这里留一点余量给 base64 膨胀 */
export const MAX_BYTES = 8 * 1024 * 1024;

/** 最多跟几跳。正常图床 1 跳（http→https 或加 CDN 前缀） */
export const MAX_REDIRECTS = 3;

/** 整条链路的超时。慢到 12 秒的图床基本是挂了，等它不如让模型换个源 */
export const TIMEOUT_MS = 12_000;

/** 只认这两个端口 */
const ALLOWED_PORTS = new Set(['', '80', '443']);

/**
 * 私有 / 保留地址段。
 *
 * 用 `net.BlockList` 而不是自己算位运算：位运算写错一位就是漏一个段，
 * 而漏掉的那一段通常正好是云厂商的元数据服务。
 */
const V4_BLOCKED = new BlockList();
for (const [base, prefix] of [
  ['0.0.0.0', 8], // 本网络
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // CGNAT，云上常用来放内部服务
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含 169.254.169.254 元数据）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档段
  ['192.88.99.0', 24], // 6to4 中继
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档段
  ['203.0.113.0', 24], // 文档段
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留 + 广播
]) {
  V4_BLOCKED.addSubnet(base, prefix, 'ipv4');
}

const V6_BLOCKED = new BlockList();
for (const [base, prefix] of [
  ['::', 128], // 未指定
  ['::1', 128], // 回环
  ['fc00::', 7], // 唯一本地（私有）
  ['fe80::', 10], // 链路本地
  ['ff00::', 8], // 组播
  ['2001:db8::', 32], // 文档段
]) {
  V6_BLOCKED.addSubnet(base, prefix, 'ipv6');
}

/**
 * 这个地址能不能连。
 *
 * 默认拒绝：认不出的写法（带 zone id 的 `fe80::1%eth0`、畸形串）一律算危险。
 * 这是**唯一**该 fail-closed 的地方——放行一个认不出的地址，等于前面所有
 * 判断都白写。
 */
export function isForbiddenAddress(ip) {
  const s = String(ip ?? '').trim().toLowerCase();
  if (!s) return true;
  /**
   * IPv4-mapped（`::ffff:127.0.0.1`）一律拒。
   *
   * 不逐个换算成 v4 再判：换算代码自己就是一处风险，而这种写法在真实图床上
   * 根本不会出现——它唯一的用途就是绕过只看前缀的过滤。
   */
  if (s.startsWith('::ffff:') || s.startsWith('::ffff')) return true;
  const kind = isIP(s);
  if (kind === 4) return V4_BLOCKED.check(s, 'ipv4');
  if (kind === 6) return V6_BLOCKED.check(s, 'ipv6');
  return true;
}

/** 按魔数认图。认不出就是 null——**不信 `Content-Type`** */
export function sniffImage(buf) {
  if (!buf || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: '.gif' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  /** BMP 头：`BM` + 两个保留字段为 0。只认 `BM` 太松（有些文本文件也这么开头） */
  if (buf[0] === 0x42 && buf[1] === 0x4d && buf[6] === 0 && buf[7] === 0 && buf[8] === 0 && buf[9] === 0) {
    return { mime: 'image/bmp', ext: '.bmp' };
  }
  return null;
}

/** 解析并做「不看 DNS 就能判」的那几项检查 */
function checkUrl(raw, { anyPort = false } = {}) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return { ok: false, message: '这个网址看不懂，要 `https://…` 这样开头的完整地址' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: `只支持 http/https，不支持 ${u.protocol.replace(':', '')}` };
  }
  if (u.username || u.password) {
    return { ok: false, message: '网址里不要带账号密码' };
  }
  /**
   * `anyPort` 只给测试用（本地服务器监听随机端口）。宿主永远不传——
   * 放开任意端口等于把内网端口扫描能力交给模型。
   */
  if (!anyPort && !ALLOWED_PORTS.has(u.port)) {
    return { ok: false, message: `只支持 80 / 443 端口，不支持 ${u.port}` };
  }
  if (!u.hostname) return { ok: false, message: '这个网址没有主机名' };
  return { ok: true, url: u };
}

const lookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, list) => {
      if (err) reject(err);
      else resolve(Array.isArray(list) ? list : []);
    });
  });

/**
 * 验目的地。返回钉住用的 `{address, family}`。
 *
 * 域名解析出多条记录时**逐条**验：任何一条私有就整条拒。轮询 DNS 完全可以
 * 把一条内网地址混进来，只验第一条等于没验。
 */
async function resolveTarget(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const lit = isIP(host);
  if (lit) {
    if (isForbiddenAddress(host)) {
      return { ok: false, message: '这个地址是本机或内网，不取' };
    }
    return { ok: true, address: host, family: lit };
  }
  let list;
  try {
    list = await lookupAll(host);
  } catch (e) {
    return { ok: false, message: `解析不了这个域名（${e?.code || e?.message || '未知'}）` };
  }
  if (!list.length) return { ok: false, message: '这个域名没有解析结果' };
  for (const one of list) {
    if (isForbiddenAddress(one.address)) {
      return { ok: false, message: '这个域名指向本机或内网，不取' };
    }
  }
  return { ok: true, address: list[0].address, family: list[0].family };
}

/**
 * 把连接钉在验过的那个 IP 上。
 *
 * Node 只拿这个回调去解析、Host 头与 TLS SNI 仍按原来的域名走，所以既能防
 * DNS rebinding，又不会因为 IP 直连被虚拟主机或 CDN 拒掉。
 */
const pinnedLookup = (address, family) => (hostname, options, cb) => {
  /** 老签名 `(hostname, cb)` */
  if (typeof options === 'function') return options(null, address, family);
  /** 新签名在 `all: true` 时要求返回数组 */
  if (options && options.all) return cb(null, [{ address, family }]);
  return cb(null, address, family);
};

/** 发一次请求，拿到 `{status, headers, body}`。body 按字节封顶 */
function requestOnce(u, { address, family, maxBytes, timeoutMs, log }) {
  return new Promise((resolve) => {
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const req = mod.request(
      u,
      {
        method: 'GET',
        /**
         * `servername` 显式给：钉住 IP 之后，有些实现会拿 IP 当 SNI，
         * 而按域名分服的 CDN 会因此回一个 421 或直接断连。只有 HTTPS 认这个键。
         */
        ...(u.protocol === 'https:' ? { servername: u.hostname.replace(/^\[|\]$/g, '') } : {}),
        lookup: pinnedLookup(address, family),
        headers: {
          /** 有些图床没有 UA 就回 403 */
          'user-agent': 'Mozilla/5.0 (compatible; dsh-roost-gallery/1.0)',
          accept: 'image/*,*/*;q=0.5',
        },
      },
      (res) => {
        const status = Number(res.statusCode) || 0;
        const headers = res.headers || {};
        const loc = headers.location;
        /** 重定向不读 body：那可能是几个 GB 的 404 页面 */
        if (status >= 300 && status < 400 && loc) {
          res.resume();
          return done({ ok: true, status, headers, body: null, redirect: String(loc) });
        }
        if (status !== 200) {
          res.resume();
          return done({ ok: false, message: `对方返回 ${status || '未知状态'}` });
        }
        const declared = Number(headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return done({ ok: false, message: `图太大（${Math.round(declared / 1024)} KB，上限 ${Math.round(maxBytes / 1024)} KB）` });
        }
        const chunks = [];
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          /**
           * 超了要**主动断**，不能只停止收集：不停的话对方会一直推，
           * 这一轮的连接与带宽就一直被占着。
           */
          if (got > maxBytes) {
            res.destroy();
            done({ ok: false, message: `图太大（超过 ${Math.round(maxBytes / 1024)} KB）` });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => done({ ok: true, status, headers, body: Buffer.concat(chunks) }));
        res.on('error', (e) => done({ ok: false, message: `读取失败：${e?.message ?? e}` }));
      },
    );

    req.on('error', (e) => done({ ok: false, message: `连不上：${e?.code || e?.message || e}` }));
    /** 空闲超时；再加一个整链路的硬超时，防「一直滴几字节」 */
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done({ ok: false, message: `对方 ${Math.round(timeoutMs / 1000)} 秒没响应` });
    });
    const hard = setTimeout(() => {
      req.destroy();
      done({ ok: false, message: `取图超时（${Math.round(timeoutMs / 1000)} 秒）` });
    }, timeoutMs);
    hard.unref?.();
    req.on('close', () => clearTimeout(hard));
    req.end();
  });
}

/**
 * 取一张图。
 *
 * @param {string} rawUrl
 * @param {{maxBytes?:number, timeoutMs?:number, log?:Function, allowPrivateForTests?:boolean}} [o]
 * @returns {Promise<{ok:true, buf:Buffer, mime:string, ext:string, url:string, bytes:number}
 *   | {ok:false, message:string}>}
 */
export async function fetchImage(rawUrl, {
  maxBytes = MAX_BYTES, timeoutMs = TIMEOUT_MS, log = () => {},
  /**
   * **只给测试用**，宿主里任何调用都不许传。
   *
   * 没有它就没法验「超限截断 / 重定向跟几跳 / 非图拒绝」——那几条只能对着
   * 一个本地服务器跑。名字写成这样是为了让 code review 一眼看出不对劲。
   */
  allowPrivateForTests = false,
} = {}) {
  const first = checkUrl(rawUrl, { anyPort: allowPrivateForTests });
  if (!first.ok) return first;

  let u = first.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let target;
    if (allowPrivateForTests) {
      const host = u.hostname.replace(/^\[|\]$/g, '');
      target = { ok: true, address: host, family: isIP(host) || 4 };
    } else {
      target = await resolveTarget(u);
      if (!target.ok) return target;
    }

    const r = await requestOnce(u, {
      address: target.address, family: target.family, maxBytes, timeoutMs, log,
    });
    if (!r.ok) return r;

    if (r.redirect) {
      let next;
      try {
        next = new URL(r.redirect, u);
      } catch {
        return { ok: false, message: '对方给了一个看不懂的跳转地址' };
      }
      const re = checkUrl(next.href, { anyPort: allowPrivateForTests });
      if (!re.ok) return { ok: false, message: `跳转到了不允许的地址：${re.message}` };
      log(`取图跳转：${u.host} → ${next.host}`);
      u = re.url;
      continue;
    }

    const ct = String(r.headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('text/html')) {
      return { ok: false, message: '这个网址返回的是网页，不是图片' };
    }
    const buf = r.body || Buffer.alloc(0);
    if (!buf.length) return { ok: false, message: '对方返回了空内容' };
    const kind = sniffImage(buf);
    if (!kind) return { ok: false, message: '这个地址不是图片（认不出图片格式）' };
    return { ok: true, buf, mime: kind.mime, ext: kind.ext, url: u.href, bytes: buf.length };
  }
  return { ok: false, message: `跳转太多次（超过 ${MAX_REDIRECTS} 次）` };
}
