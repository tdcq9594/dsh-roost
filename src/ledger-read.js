/**
 * 账本只读视图
 * ============
 *
 * 给 `chat_look` 工具用：让模型按需翻「谁在哪个群说过什么」。
 *
 * ## 为什么直接开库，不走 HTTP
 *
 * ai-chat 暴露的五条路由里没有「按会话取最近 N 条」和「列活跃会话」
 * （`/r/context` 只吃 `aroundId`）。为两个只读查询新开路由，还得跟着
 * ai-chat 一起发版，不如直接开库。
 *
 * ## 为什么只读
 *
 * `ledger.append()` 是框架的私有路径（插件拿到的是 `readOnlyLedger`）。
 * 这里再开一个读写连接，等于把那条边界又破一次——所以 `readOnly: true`，
 * 而且只 SELECT。
 *
 * ## 两个库不在同一个目录
 *
 *   journal.sqlite  →  dataDir()（默认 `~/.dsh/dsh-roost/`）
 *   events.db       →  `<roost 安装目录>/data/bots/<botId>/events.db`
 *
 * 这个文件只管后者。找不到库就返回空，不抛错——工具是增强，
 * 不能因为账本没开就让整轮对话挂掉。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 与 `config.js` 的 `dataDir()` 保持一致，但不建目录（只读工具不该写盘） */
function dataDir() {
  return process.env.DSH_ROOST_DATA || join(homedir(), '.dsh', 'dsh-roost');
}

/**
 * 找账本文件。
 *
 * botId 不写在配置里——`setup.js:364` 列 `data/bots/` 时就是按目录名认的，
 * 而且把 `main` 排在最前。这里照同一个规则，免得两处判断不一致。
 *
 * @param {object} o
 * @param {string} o.roostDir 框架安装目录（`cfg.setup.roostDir`）
 * @returns {string} 账本路径，找不到返回空串
 */
export function resolveLedgerFile({ roostDir = '' } = {}) {
  const base = String(roostDir || '').trim() || join(dataDir(), 'roost');
  const bots = join(base, 'data', 'bots');
  try {
    if (!existsSync(bots)) return '';
    const ids = readdirSync(bots);
    if (!ids.length) return '';
    const id = ids.includes('main') ? 'main' : ids.slice().sort()[0];
    const file = join(bots, id, 'events.db');
    return existsSync(file) ? file : '';
  } catch {
    return '';
  }
}

/**
 * 洗一遍正文。
 *
 * 实测账本 `content` 里有两类脏东西：
 *   · 表情是 `<faceType=1,faceId="124",ext="...">`（全库唯一带尖括号的形态）
 *   · 纯图/纯 @ 的 `content` 是空串（29/447），内容在 `payload` 里
 *
 * **不要按 `<@...>` 去洗**：@ 在入库前就被 `message.js` 的 `stripMention()`
 * 剥掉了，账本列里根本没有，写了是空转。
 */
function textOf(row) {
  const raw = String(row?.content ?? '');
  // 表情标记连内容一起去掉：ext 里是 base64，模型看了只会更困惑
  let t = raw.replace(/<faceType=[^>]*>/g, '').trim();
  if (!t && raw) t = '（表情）';
  if (t) return t;
  // 只有空正文时才解析 payload（6.5% 的行），别为常态付这个成本
  try {
    const p = JSON.parse(String(row?.payload ?? '{}'));
    if (Array.isArray(p?.attachments) && p.attachments.length) return '（图片/文件）';
    if (Array.isArray(p?.mentions) && p.mentions.length) return '（@某人）';
  } catch {}
  return '（空）';
}

function hhmm(at) {
  const d = new Date(Number(at) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {object} o
 * @param {() => string} o.roostDirOf 取框架安装目录（活引用，改配置不重启）
 * @param {(msg:string)=>void} [o.log]
 */
export function createLedgerReader({ roostDirOf = () => '', log = () => {} } = {}) {
  let db = null;
  let file = '';
  let broken = false;
  /** 老库可能没有引用两列；判一次缓存住，别每轮都跑 PRAGMA */
  let refCols = null;

  /**
   * `quoted` / `ref_msg_idx` 是账本 v3 才有的列。
   *
   * 直接写进 SELECT 的话，老 `events.db` 会抛 `no such column`，被下面
   * `recent()` 的 catch 吞成 `return []` —— 表现为 `chat_look` 突然
   * 一条都查不到，而且没有任何报错。照 `journal.js:298` 的先例按列判。
   */
  function hasRefCols() {
    const d = open();
    if (!d) return false;
    if (refCols !== null) return refCols;
    try {
      const cols = new Set(d.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
      refCols = cols.has('quoted') && cols.has('ref_msg_idx');
    } catch {
      refCols = false;
    }
    return refCols;
  }

  function open() {
    if (db || broken) return db;
    file = resolveLedgerFile({ roostDir: roostDirOf() });
    if (!file) {
      broken = true;
      return null;
    }
    const sqlite = process.getBuiltinModule?.('node:sqlite');
    if (!sqlite?.DatabaseSync) {
      broken = true;
      return null;
    }
    try {
      /**
       * 只读打开 WAL 库：真机实测可行（框架进程正持有 WAL，这边照样能读）。
       * 打不开就永久标记 broken——每轮都重试只会每轮都打一条 warn。
       */
      db = new sqlite.DatabaseSync(file, { readOnly: true });
    } catch (e) {
      broken = true;
      log(`账本打不开（${file}）：${e.message}`);
      db = null;
    }
    return db;
  }

  return {
    available: () => Boolean(open()),

    file: () => file || resolveLedgerFile({ roostDir: roostDirOf() }),

    /**
     * 某会话最近 N 条，**正序**返回（老的在前）。
     *
     * `beforeSeq` 是游标：传上一页最小的 seq，取更老的一页。
     * 注意返回正序之后，「下一页」的游标是 `items[0].seq` 而不是最后一条。
     */
    recent({ chatId, limit = 20, beforeSeq = 0 } = {}) {
      const d = open();
      if (!d || !chatId) return [];
      const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const before = Number(beforeSeq) || 0;
      const withRefs = hasRefCols();
      try {
        const rows = d
          .prepare(
            `SELECT seq, kind, chat_id, user_name, content, payload, at, time_basis${withRefs ? ', quoted, ref_msg_idx' : ''}
               FROM events
              WHERE chat_id = ? AND time_basis != 'unknown'
                ${before > 0 ? 'AND seq < ?' : ''}
              ORDER BY seq DESC
              LIMIT ?`,
          )
          .all(...(before > 0 ? [chatId, before, lim] : [chatId, lim]));
        return rows.reverse().map((r) => ({
          seq: Number(r.seq),
          at: Number(r.at),
          time: hhmm(r.at),
          who: String(r.user_name ?? '') || '（未知）',
          text: textOf(r),
          kind: String(r.kind ?? ''),
          /** L1 引用精确作废要用的两个字段；老库缺列时整组不出现，别塞 undefined */
          ...(withRefs ? {
            quoted: String(r.quoted ?? ''),
            refMsgIdx: String(r.ref_msg_idx ?? ''),
          } : {}),
        }));
      } catch (e) {
        log(`账本查询失败：${e.message}`);
        return [];
      }
    },

    /**
     * 最近活跃的会话列表。
     *
     * 群名不从这里出——`sessions.json` 里有（`QQ · roost交流群`），
     * 由调用方补，账本只负责「有哪些 chatId、各多少条、最后什么时候」。
     */
    chats({ limit = 10, onlyChatId = '' } = {}) {
      const d = open();
      if (!d) return [];
      const lim = Math.min(Math.max(Number(limit) || 10, 1), 30);
      /**
       * `onlyChatId`（3.3 两开关合并）：群里且 `crossChatInGroup=false` 时，
       * `chat_look` 只列当前会话。必须在 SQL 里过滤——调用方拿到的是
       * 「最近 12 个活跃会话」，当前会话不在前 12 条时再 filter 就会得到空清单。
       */
      const only = String(onlyChatId || '').trim();
      try {
        return d
          .prepare(
            `SELECT chat_id, kind, COUNT(*) n, MAX(at) last_at
               FROM events
              WHERE time_basis != 'unknown'${only ? ' AND chat_id = ?' : ''}
              GROUP BY chat_id, kind
              ORDER BY last_at DESC
              LIMIT ?`,
          )
          .all(...(only ? [only, lim] : [lim]))
          .map((r) => ({
            chatId: String(r.chat_id ?? ''),
            kind: String(r.kind ?? ''),
            count: Number(r.n ?? 0),
            lastAt: Number(r.last_at ?? 0),
          }));
      } catch (e) {
        log(`账本会话列表失败：${e.message}`);
        return [];
      }
    },

    close() {
      try {
        db?.close?.();
      } catch {}
      db = null;
    },
  };
}
