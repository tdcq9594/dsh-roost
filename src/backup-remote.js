/**
 * 4.3 定时备份 + 4.4 加密云备份。
 *
 * 三条硬边界（§0.8-8 / 路线图批次 4 验收）：
 *  1. **先加密再推**：记忆里有隐私，私有仓也会被误设成公开；
 *     AES-256-GCM，密钥从 passphrase 派生（scrypt + 随机盐）。
 *     passphrase 没配就拒推——不推明文，也不默默跳过，如实报原因。
 *  2. **Gitee 硬校验 `private === true`**：不能只靠用户勾选，
 *     推前拉一次仓库元数据，公开仓直接拒绝（验收硬闸）。
 *  3. **失败要说清是鉴权失败还是网络失败**：`reason` 分
 *     auth / public / too_large / config / network / upstream，
 *     面板按 reason 给不同指引，不一句「备份失败」糊过去。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** 加密产物魔数 + 版本（8 字节，后面 salt/iv/tag 的偏移都按它算）。解包时靠它区分「加密备份」和普通 zip */
const MAGIC = Buffer.from('ROOSTE1\u0001');

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/* ---------------- 4.3 定时判定（纯函数） ---------------- */

/**
 * 今天到没到备份点。按**本地时区**的日历天判断——和凌晨巩固同一口径，
 * 用户在哪个时区，「每天一次」就是他那个时区的一天。
 *
 * `lastAt` 取最近一份完整备份的落盘时间（文件 mtime），重启不丢状态。
 */
export function scheduleDue({ lastAt = 0, hour = 4, now = Date.now() } = {}) {
  const t = Number(now) || Date.now();
  const d = new Date(t);
  /** `hour: 0` 是合法配置（凌晨零点），不能用 || 兜底——那会把它吞成默认 4 点 */
  const hRaw = Number(hour);
  const h = Math.max(0, Math.min(23, Math.trunc(Number.isFinite(hRaw) ? hRaw : 4)));
  const day = d.toDateString();
  const last = num(lastAt);
  const lastDay = last ? new Date(last).toDateString() : '';
  return day !== lastDay && d.getHours() >= h;
}

/* ---------------- 4.4 加密（AES-256-GCM） ---------------- */

/**
 * 加密一份 zip。产物结构：MAGIC(8) + salt(16) + iv(12) + tag(16) + body。
 * scrypt 派生密钥（N=16384 默认档，一次性后台任务不差这点时间）。
 */
export function encryptBuffer(buf, passphrase) {
  const p = String(passphrase ?? '');
  if (!p) throw new Error('passphrase 没配——不推明文，也不默默跳过');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(p, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), body]);
}

/** 解密（手动恢复云备份时用）。passphrase 错 = GCM tag 校验失败，如实报 */
export function decryptBuffer(enc, passphrase) {
  if (!Buffer.isBuffer(enc) || enc.length < 8 + 16 + 12 + 16) {
    throw new Error('不是本工具产出的加密备份');
  }
  if (!enc.subarray(0, 8).equals(MAGIC)) throw new Error('缺少 ROOSTE1 魔数——这不是加密备份');
  const salt = enc.subarray(8, 24);
  const iv = enc.subarray(24, 36);
  const tag = enc.subarray(36, 52);
  const body = enc.subarray(52);
  const key = scryptSync(String(passphrase ?? ''), salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ---------------- 4.4 推送（Gitee / WebDAV） ---------------- */

/**
 * 远端配置的**结构校验**。reason: 'config' = 让用户去补配置，不是去重试。
 */
function remoteReady(remote) {
  const r = remote || {};
  if (r.kind !== 'gitee' && r.kind !== 'webdav') {
    return { ok: false, reason: 'config', message: '没选远端（Gitee / WebDAV）' };
  }
  if (!String(r.passphrase ?? '')) {
    return { ok: false, reason: 'config', message: '加密口令（passphrase）没配——先加密再推，不推明文' };
  }
  if (r.kind === 'gitee') {
    const g = r.gitee || {};
    if (!String(g.owner ?? '') || !String(g.repo ?? '') || !String(g.token ?? '')) {
      return { ok: false, reason: 'config', message: 'Gitee 配置缺 owner / repo / token' };
    }
  } else {
    const w = r.webdav || {};
    if (!String(w.url ?? '')) return { ok: false, reason: 'config', message: 'WebDAV 没填地址' };
  }
  return { ok: true };
}

/**
 * 推送一份（已加密的）备份。
 *
 * @param {object} o
 * @param {Buffer} o.buf 备份内容（本函数内部加密，调用方给原始 zip）
 * @param {string} o.name 备份文件名（带时间戳，远端同名即同文件）
 * @param {object} o.remote config.backup.remote
 * @param {(url:string, opts?:object)=>Promise} [o.fetchImpl] 注入测试
 * @returns {{ok:boolean, reason?:string, message:string, bytes?:number}}
 */
export async function pushBackup({ buf, name, remote, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const ready = remoteReady(remote);
  if (!ready.ok) return { ok: false, ...ready };
  const r = remote;
  const max = num(r.maxBytes) || 209_715_200; // 默认 200MB：记忆库+表情可能几百 MB，上限挡住再谈
  if (buf.length > max) {
    return {
      ok: false, reason: 'too_large',
      message: `备份 ${(buf.length / 1048576).toFixed(1)}MB 超过上限 ${(max / 1048576).toFixed(0)}MB——先把记忆/表情瘦身，或调大 backup.remote.maxBytes`,
      bytes: buf.length,
    };
  }
  let enc;
  try {
    enc = encryptBuffer(buf, r.passphrase);
  } catch (e) {
    return { ok: false, reason: 'config', message: e.message };
  }
  const kind = r.kind;
  try {
    if (kind === 'gitee') return await pushGitee({ enc, name, r, fetchImpl, log });
    return await pushWebdav({ enc, name, r, fetchImpl, log });
  } catch (e) {
    /** fetch 抛错（DNS/超时/连接被拒）= 网络层，别和鉴权失败混成一团 */
    return { ok: false, reason: 'network', message: `网络失败：${e.message}` };
  }
}

async function pushGitee({ enc, name, r, fetchImpl, log }) {
  const g = r.gitee;
  const owner = encodeURIComponent(String(g.owner));
  const repo = encodeURIComponent(String(g.repo));
  const token = encodeURIComponent(String(g.token));
  const path = encodeURIComponent(`dsh-roost-backups/${name}.enc`);
  /**
   * 硬闸：推前查仓库可见性。私有校验是「推前拉元数据」，不是信用户勾选——
   * 公开仓 = 全量泄露，这一步拒绝时宁可报错也不推。
   */
  const meta = await fetchImpl(`https://gitee.com/api/v5/repos/${owner}/${repo}?access_token=${token}`);
  if (!meta.ok) {
    return {
      ok: false, reason: 'auth',
      message: `仓库信息查不到（HTTP ${meta.status}）——多半是 token 失效、没权限，或 owner/repo 写错了`,
    };
  }
  let info = {};
  try { info = await meta.json(); } catch { /* 拿不到 JSON 按公开处理更保守 */ }
  if (info.private !== true) {
    return {
      ok: false, reason: 'public',
      message: '这个仓库是公开的——记忆里有隐私，公开仓等于全量泄露，已拒绝推送。到 Gitee 把仓库设为私有后再试。',
    };
  }
  const put = await fetchImpl(`https://gitee.com/api/v5/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      access_token: String(g.token),
      content: enc.toString('base64'),
      message: `dsh-roost 加密备份 ${name}`,
      branch: String(g.branch || 'master'),
    }),
  });
  if (!put.ok) {
    const isAuth = put.status === 401 || put.status === 403;
    return {
      ok: false, reason: isAuth ? 'auth' : 'upstream',
      message: `Gitee 上传失败（HTTP ${put.status}）${isAuth ? '——token 无权写这个仓库' : ''}`,
    };
  }
  log(`云备份已推到 Gitee：${name}.enc（加密 ${(enc.length / 1048576).toFixed(1)}MB）`);
  return { ok: true, message: '已加密推送到 Gitee', bytes: enc.length };
}

async function pushWebdav({ enc, name, r, fetchImpl, log }) {
  const w = r.webdav;
  const url = String(w.url).replace(/\/+$/, '') + `/dsh-roost-backups/${encodeURIComponent(name)}.enc`;
  const auth = Buffer.from(`${String(w.user ?? '')}:${String(w.pass ?? '')}`).toString('base64');
  const put = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/octet-stream',
      'content-length': String(enc.length),
    },
    body: enc,
  });
  if (!put.ok) {
    const isAuth = put.status === 401 || put.status === 403;
    return {
      ok: false, reason: isAuth ? 'auth' : 'upstream',
      message: `WebDAV 上传失败（HTTP ${put.status}）${isAuth ? '——账号或密码不对' : '——服务器返回错误，检查地址与目录权限'}`,
    };
  }
  log(`云备份已推到 WebDAV：${name}.enc（加密 ${(enc.length / 1048576).toFixed(1)}MB）`);
  return { ok: true, message: '已加密推送到 WebDAV', bytes: enc.length };
}
