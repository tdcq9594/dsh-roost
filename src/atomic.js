/**
 * 原子写：**随机 tmp 名 + rename**。
 *
 * ## 为什么要统一
 *
 * 全仓原来有二十多份手写的「`.tmp` + `rename`」，写法各不相同，其中大半用的是
 * **固定 tmp 名**（`${file}.tmp`）。固定名只防「断电留半个文件」，**不防两个
 * 写者互盖**——两个写者同时 `writeFileSync` 同一个 tmp，后一个把前一个的内容
 * 顶掉，先完成的那次 `rename` 就把别人的半成品扶正了。`sessions.js` /
 * `delivery.js` / `pending-opening.js` 的注释里已经点过这件事，但只在三处修了。
 *
 * 这里统一成一份：随机 tmp 名 + 失败清 tmp + 可选 mode。
 *
 * ## 不是「写数据库」
 *
 * `rename` 在同一个文件系统上是原子的，所以**读到的永远是完整的旧版或完整的
 * 新版**。但没有 fsync，断电时「rename 已生效、内容还在页缓存」仍可能丢——
 * 那是另一层问题（代价是每次写都要等磁盘），本仓的数据都是可重建的状态，
 * 不值这个价。
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** 临时文件名带进程号 + 随机段：同进程并发、多进程共用目录都不会撞 */
function tmpNameOf(file) {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
}

/**
 * 原子写一个文件。
 *
 * @param {string} file 目标路径
 * @param {string|Buffer} data 已经序列化好的内容
 * @param {object} [opts]
 * @param {number} [opts.mode] 文件权限（如 `0o600`）；Windows 忽略
 * @param {boolean} [opts.mkdir] 是否自动建父目录，默认 true
 * @returns {string} 目标路径
 */
export function writeFileAtomic(file, data, { mode, mkdir = true } = {}) {
  if (mkdir) fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = tmpNameOf(file);
  try {
    fs.writeFileSync(tmp, data, mode ? { encoding: 'utf8', mode } : 'utf8');
    /**
     * Windows 会忽略 `mode`，POSIX 上 `writeFileSync` 又受 umask 影响，
     * 所以显式再 chmod 一次；失败不算错误（FAT / 网络盘不支持）。
     */
    if (mode) {
      try {
        fs.chmodSync(tmp, mode);
      } catch {}
    }
    fs.renameSync(tmp, file);
    return file;
  } catch (e) {
    /** 写一半失败：tmp 留在目录里会被备份 / 扫描器当成真文件，清掉 */
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw e;
  }
}

/**
 * 原子写 JSON。
 *
 * `indent` / `newline` 显式给：仓里两种格式都有（`JSON.stringify(x)` 紧凑、
 * `+ '\n'` 结尾），迁就现状比统一格式更重要——统一格式会让所有落盘文件在
 * 用户机器上无谓地重写一遍。
 *
 * @param {string} file
 * @param {any} value
 * @param {object} [opts] 除 `indent` / `newline` 外同 `writeFileAtomic`
 */
export function writeJsonAtomic(file, value, { indent = 2, newline = false, ...opts } = {}) {
  const text = JSON.stringify(value, null, indent) + (newline ? '\n' : '');
  return writeFileAtomic(file, text, opts);
}
