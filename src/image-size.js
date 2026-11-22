/**
 * 图片宽高的零依赖读取。
 *
 * ## 为什么要单独一个模块
 *
 * 同一段解码逻辑原来只活在 `sticker-sync.js` 里（判断「像不像表情包」用）。
 * 现在多两个消费方：
 *
 *   · `gallery.js` —— 入库时把原图尺寸记进索引，`gallery_list` 才能告诉模型
 *     「这张是 320×240」，它才知道该不该放大、能不能当长图发；
 *   · `outbound-actions.js` —— 模型写 `<<image: #3|320x>>`（只给宽）时，
 *     高得按真实比例算出来，否则只能猜一个比例把图压变形。
 *
 * 三处各抄一份的话，哪天补了 BMP 或修了 WebP 的偏移，必然只改到一份——
 * 于是「同一张图在清单里是 320×240、发出去却按另一个比例缩放」。
 *
 * 项目零依赖，没有 sharp/jimp，全部靠手解文件头的固定偏移。读不出来不报错，
 * 返回 `0/0`，调用方按「不知道尺寸」处理（不猜比例）。
 */

import { openSync, readSync, closeSync } from 'node:fs';

/**
 * 从字节里读宽高。
 *
 * @param {Buffer|null} buf 文件头（前 64KB 足够；JPEG 要扫到 SOF 段）
 * @returns {{w:number,h:number}} 读不出时两项都是 0
 */
export function dimsOf(buf) {
  if (!buf || buf.length < 24) return { w: 0, h: 0 };
  /** PNG：89 50 4E 47，IHDR 的宽高在 16 / 20，大端 */
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  /** GIF：GIF8，逻辑屏幕描述符在 6 / 8，小端 */
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  /** JPEG：扫到 SOF0/SOF2 才拿到宽高（段里高在前、宽在后） */
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  /** WebP：RIFF....WEBP + 变体标记 */
  if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >>> 14) & 0x3fff) + 1 };
    }
  }
  return { w: 0, h: 0 };
}

/**
 * 只读文件头。头 64KB 够用：JPEG 的 SOF 段一般在头几百字节内。
 *
 * 同步读是刻意的：调用方（索引同步、出站补尺寸）都在这条同步链上，
 * 改成 async 要把整条路径翻一遍，而读 64KB 的代价比一次 await 还小。
 *
 * @returns {Buffer|null} 读不了（占用 / 权限 / 已删）返回 null
 */
export function headOf(p, n = 64 * 1024) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(n);
    const len = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, len);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 关不掉不影响结果 */ }
  }
}

/**
 * 路径 → 宽高。文件读不了时返回 `{w:0,h:0}`，**不抛错**。
 *
 * @param {string} p
 * @returns {{w:number,h:number}}
 */
export function dimsOfPath(p) {
  const head = headOf(p);
  return head ? dimsOf(head) : { w: 0, h: 0 };
}
