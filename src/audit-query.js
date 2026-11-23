/**
 * 审计日志只读查询（A1）
 * ====================
 *
 * 对齐 Hindsight `/audit-logs` 的**查询形态**（action/时间/filter + limit/offset
 * 分页 + 倒序），但落在我方形态里：读 `<数据目录>/audit.log` 的末尾窗口，
 * 纯函数、不写盘、不新增存储、不给扩展（`/v1`）开端点。
 *
 * 为什么不直接读全文件：`audit.log` 不做轮转，长期运行可能很大。
 * `ext-panel.js` 的 `readAuditTail()` 已经用「只读末尾 256 KB」判定凭据状态，
 * 这里沿用同一个口径——**查询是排查用的，不是全量归档**，超长日志只看最近一段。
 *
 * 防御：写侧 `audit.js` 已经白名单字段 + `redactText` 脱敏，但历史日志可能
 * 是旧版本写的（没脱敏）、或有人手工塞了东西进来。读侧**再脱敏一次**——
 * 面板一旦把原文显示出来就收不回去了，宁可多抹一遍。
 *
 * 不改 `audit.js` 的行为：写侧逐字不变，本模块纯读。
 */

import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { redactText } from './redact.js';

/** 与 ext-panel.js 的 TAIL_BYTES 同口径：一次滚动窗口够排查了 */
export const TAIL_BYTES = 256 * 1024;

/** 单次最多返回多少条——和 Hindsight 的 limit 上限 500 对齐，但默认更小 */
export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 50;

/** 白名单字段，和 audit.js 的写侧白名单一致；读侧只透出这些，多一个都不给 */
const FIELDS = ['at', 'op', 'chatId', 'peer', 'peerId', 'note'];

/**
 * 读文件末尾一段（`ext-panel.js:577` readAuditTail 的同款实现，抽成纯函数以便测试）。
 *
 * @param {string} file
 * @param {number} tailBytes
 * @returns {string}
 */
function readTail(file, tailBytes = TAIL_BYTES) {
  let fd = null;
  try {
    const st = statSync(file);
    const start = Math.max(0, st.size - tailBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8');
    // 从中间截断时第一行多半是半截 JSON，丢掉
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return ''; // 没有审计文件 = 没有事件，不是错误
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* 已关 */ } }
  }
}

/**
 * 把一行 JSON 归一成可返回的行：白名单字段 + 读侧再脱敏 + 类型收敛。
 * 坏行返回 null（日志里可能有手工塞的东西，不该让整个查询挂掉）。
 *
 * @param {string} line
 * @returns {object|null}
 */
function normalizeLine(line) {
  if (!line) return null;
  let row = null;
  try { row = JSON.parse(line); } catch { return null; }
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const out = { at: Number(row.at) || 0 };
  for (const k of FIELDS) {
    if (k === 'at' || row[k] === undefined || row[k] === '') continue;
    const v = row[k];
    out[k] = typeof v === 'string' ? redactText(v) : v;
  }
  return out;
}

/**
 * 查询审计日志（最新在前）。
 *
 * @param {{since?:number, until?:number, op?:string, chatId?:string,
 *          limit?:number, offset?:number, file?:string}} [opts]
 *   - `since` / `until`：毫秒时间戳（和 write 侧的 `at` 同单位），左闭右开；
 *     Hindsight 用 ISO 字符串，我方全链路都是毫秒，不引入第二种时间格式。
 *   - `op` / `chatId`：精确匹配（小写归一化只用于 op 前缀，正文原样）；
 *     空串 = 不过滤。
 *   - `limit` / `offset`：分页，limit 夹在 [1, MAX_LIMIT]。
 *   - `file`：注入文件路径，测试用；不传走 dataDir()/audit.log。
 * @returns {{rows:Array, total:number, scanned:number, truncated:boolean, error?:string}}
 *   total = **本次窗口内**过滤后的总数（不是全文件总数——只看了末尾，不能撒谎说全量）。
 */
export function queryAudit(opts = {}) {
  const since = Number(opts.since) > 0 ? Number(opts.since) : 0;
  const until = Number(opts.until) > 0 ? Number(opts.until) : 0;
  const op = String(opts.op ?? '').trim();
  const chatId = String(opts.chatId ?? '').trim();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const file = String(opts.file ?? '') || join(dataDir(), 'audit.log');
  let text = '';
  try { text = readTail(file); } catch (e) {
    return { rows: [], total: 0, scanned: 0, truncated: false, error: String(e?.message ?? e) };
  }
  if (!text) return { rows: [], total: 0, scanned: 0, truncated: false };

  const lines = text.split(/\r?\n/);
  const matched = [];
  let scanned = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const row = normalizeLine(lines[i]);
    if (!row) continue;
    scanned += 1;
    if (since && row.at < since) continue;
    if (until && row.at >= until) continue;
    if (op && String(row.op ?? '') !== op) continue;
    if (chatId && String(row.chatId ?? '') !== chatId) continue;
    matched.push(row);
  }
  return {
    rows: matched.slice(offset, offset + limit),
    total: matched.length,
    scanned,
    // 文件比窗口大 = 老日志看不到，明说，别让用户以为查到了全部
    truncated: (() => {
      try { return statSync(file).size > TAIL_BYTES; } catch { return false; }
    })(),
  };
}
