/**
 * 头像本地缓存
 * ============
 *
 * 为什么要缓存、为什么给模型的是**路径**而不是 URL：
 *   ① 模型是文本的，读不出 URL 里有什么；但一句「头像 C:\...\a.jpg」能直接
 *      当图片发出去（`<<image: 路径>>`），也能被视觉工具读；
 *   ② qlogo 的地址带一次性 `key` / `kti`，放一会儿或换个来源就 403，
 *      写进 markdown 给别人看等于给个坏链；
 *   ③ 同一个人的头像在群里每轮都要提，每次现下就是白白多打一次公网。
 *
 * 缓存策略（主人 2026-11-16 定）：
 *   · **同一个 openid 在 TTL 内不重复下载**，哪怕 URL 变了也不下 —— qlogo
 *     每次下发的 key 都不一样，按 URL 比对等于「每次都失效」；
 *   · 到期后**惰性更新**：下一次用到这个人才重下，不做后台轮询；
 *   · 模型主动查资料（`qq_who`）时带 `force`，那一次必须拿最新的。
 *
 * 文件名用 openid 的 sha1 前 20 位：openid 本身能当文件名，但会暴露在
 * 「列个目录」这种操作里，而且大小写敏感性不同平台不一致。扩展名按
 * `content-type` 决定（qlogo 给 jpeg）；同一 key 换格式时旧文件删掉。
 *
 * 失败一律不抛：头像只是锦上添花，拿不到就返回上一个可用文件或空串。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 默认 24 小时。头像不是身份信息，更新不频繁，一天一次足够。 */
export const AVATAR_TTL_MS = 24 * 3600_000;

/**
 * @param {object} o
 * @param {string} o.dir       缓存目录（绝对路径）
 * @param {number} [o.ttlMs]   多久算过期
 * @param {number} [o.timeoutMs] 单次下载超时
 * @param {(msg:string)=>void} [o.log]
 */
export function createAvatarCache({ dir, ttlMs = AVATAR_TTL_MS, timeoutMs = 5000, log = () => {} } = {}) {
  const root = String(dir || '').trim();
  /** key -> { file, at }（at 取文件 mtime，重启后不用另存索引） */
  const mem = new Map();
  /** 同一个人并发请求只下一次 */
  const inflight = new Map();

  const keyOf = (openid) => createHash('sha1').update(String(openid)).digest('hex').slice(0, 20);
  const abs = (file) => path.join(root, file);

  /** 找这个人已有的缓存文件（内存 miss 时扫一次目录） */
  async function locate(key) {
    const hit = mem.get(key);
    if (hit) return hit;
    const names = await fs.readdir(root).catch(() => []);
    const file = names.find((n) => n.startsWith(`${key}.`) && !n.endsWith('.tmp'));
    if (!file) return null;
    const st = await fs.stat(abs(file)).catch(() => null);
    if (!st) return null;
    const rec = { file, at: st.mtimeMs };
    mem.set(key, rec);
    return rec;
  }

  async function download(key, url) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      const r = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { accept: 'image/*' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = EXT_BY_TYPE[type] || 'jpg';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error('响应是空的');

      await fs.mkdir(root, { recursive: true });
      const name = `${key}.${ext}`;
      /** 先写临时文件再 rename：进程被杀时不会留半张图给下一次读 */
      const tmp = path.join(root, `.${key}.${process.pid}.tmp`);
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, abs(name));

      /** 同 key 的旧格式文件删掉，免得目录里两份、模型拿到过期的那份 */
      const names = await fs.readdir(root).catch(() => []);
      for (const n of names) {
        if (n !== name && n.startsWith(`${key}.`) && !n.endsWith('.tmp')) {
          await fs.unlink(abs(n)).catch(() => {});
        }
      }

      const st = await fs.stat(abs(name)).catch(() => null);
      mem.set(key, { file: name, at: st?.mtimeMs || Date.now() });
      return abs(name);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 拿某个人的头像本地路径。
   *
   * @param {object} o
   * @param {string} o.openid
   * @param {string} [o.url]   平台给的头像原图地址（没有就只用缓存）
   * @param {boolean} [o.force] true = 无视 TTL 重下（模型主动查资料时用）
   * @returns {Promise<string>} 绝对路径；拿不到是空串
   */
  async function pathOf({ openid, url, force = false } = {}) {
    if (!root) return '';
    const id = String(openid || '').trim();
    if (!id) return '';
    const key = keyOf(id);
    const hit = await locate(key);
    const old = hit ? abs(hit.file) : '';

    /**
     * **`hit.at` 要取整再比。**
     *
     * `statSync().mtimeMs` 是浮点（Linux 上带亚毫秒精度，比如 `1763000000000.7`），
     * 而 `Date.now()` 只有整毫秒。同一毫秒内写完再读，`Date.now() - at` 会是
     * **负数**，于是 `负数 < ttlMs(0)` 成立——`ttlMs: 0`（每次都该重下）被当成
     * 命中，`force` 之外的「过期刷新」也会被推迟不到 1 ms。
     *
     * 这不是理论问题：CI 上「过期后自然重新下载」那条用例就因此随机只打了一次
     * 图床（Node 22 过、Node 24 挂）。取整之后语义是精确的「已过多少整毫秒」。
     */
    const aged = Date.now() - Math.floor(hit?.at ?? 0);
    if (hit && !force && aged < ttlMs) return old;

    const src = String(url || '').trim();
    /** 没有新地址：有旧图就给旧的（force 也没得更） */
    if (!src) return old;

    if (inflight.has(key)) return inflight.get(key);
    const job = download(key, src)
      .catch((e) => {
        log(`头像缓存失败（${id.slice(0, 8)}…）：${e?.message ?? e}`);
        return old;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  /** 测试/维护用：把内存索引丢掉（下次会重新扫目录） */
  function reset() {
    mem.clear();
  }

  return { pathOf, reset, dir: root, ttlMs };
}
