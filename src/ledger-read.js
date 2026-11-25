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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 与 `config.js` 的 `dataDir()` 保持一致，但不建目录（只读工具不该写盘） */
function dataDir() {
  return process.env.DSH_ROOST_DATA || join(homedir(), '.dsh', 'dsh-roost');
}

/**
 * 找账本文件 + 它的 botId + 框架根目录。
 *
 * botId 不写在配置里——`setup.js:364` 列 `data/bots/` 时就是按目录名认的，
 * 而且把 `main` 排在最前。这里照同一个规则，免得两处判断不一致。
 *
 * **为什么要把 botId 一起返回**：`events_timeline` 索引的前缀是
 * `(bot_id, chat_id, ...)`（`events-schema.js:45`）。`chat_look` 是用户手动
 * 触发、一次扫全表无所谓；但「缺口补齐」每轮 @ 都要跑一次，不带 bot_id
 * 就是每轮全表扫描。目录名本来就是 botId，顺手带出去零成本。
 *
 * `base` 一起带出去是为了读同目录下的 `config/bots/<botId>.json`（命令前缀），
 * 别让调用方再把这份路径拼接逻辑抄一遍。
 *
 * @param {object} o
 * @param {string} o.roostDir 框架安装目录（`cfg.setup.roostDir`）
 * @returns {{file:string, botId:string, base:string}} 找不到时 file/botId 是空串
 */
export function resolveLedger({ roostDir = '' } = {}) {
  const base = String(roostDir || '').trim() || join(dataDir(), 'roost');
  const bots = join(base, 'data', 'bots');
  try {
    if (!existsSync(bots)) return { file: '', botId: '', base };
    const ids = readdirSync(bots);
    if (!ids.length) return { file: '', botId: '', base };
    const id = ids.includes('main') ? 'main' : ids.slice().sort()[0];
    const file = join(bots, id, 'events.db');
    return existsSync(file) ? { file, botId: id, base } : { file: '', botId: '', base };
  } catch {
    return { file: '', botId: '', base };
  }
}

/**
 * 只要路径。保留这个导出是因为 `chat_look` 的错误文案和面板都用它，
 * 改成返回对象会牵连一串调用方。
 *
 * @param {object} o
 * @param {string} o.roostDir 框架安装目录（`cfg.setup.roostDir`）
 * @returns {string} 账本路径，找不到返回空串
 */
export function resolveLedgerFile({ roostDir = '' } = {}) {
  return resolveLedger({ roostDir }).file;
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
 * 一条命令发出去、插件多久之内回话算「被它触发的」。
 *
 * 取 20 秒：菜单、骰子这类都是秒回；`ai-chat` 那种慢的走 host 协议，
 * 本来就不在下表的剔除范围里。窗口再放大只会把「插件主动推送恰好撞上
 * 某人发言」误判成触发。
 */
const TRIGGER_WINDOW_MS = 20000;

/**
 * 一行账本能当上下文吗：`'in'` 真人说的 / `'self'` 她自己说的 / `'other'` 其余。
 *
 * **两处共用**：缺口补齐（`gap`）和 `chat_look` 翻记录（`recent`）。
 * 以前只有前者过滤，结果是两条路给模型看到的世界不一样——同一段聊天，
 * 补齐块里干净，翻记录里混着菜单和别的插件的回复，模型对「刚才谁说了什么」
 * 会得出两种结论。判据只维护这一份。
 *
 * 账本里同一个群混着四类行，只有前两类能当上下文：
 *
 *   ① **真人从 QQ 说的**：`source='gateway'` / `'webhook'`。
 *      别的入口写进来的不算——`mock` / `dev` 是面板和命令行注入，
 *      `import` 是补录，都不是「刚才群里有人这么说」。
 *   ② **自有协议说的**：`plugin='host'`（`source` 也是 `'host'`）。
 *      看着像「她自己的话」，所以才要能看见——但只认这一条路径。
 *
 * 其余一律 `'other'`：
 *   · `source='plugin'` —— 框架其他插件（echo、ai-chat、菜单…）发的。
 *     群里有人触发了别的插件，那句回复**不是她说的**，进来会被模型
 *     当成「你」或者「群友」，两种都错；
 *   · `source='onebot'` —— OneBot 客户端代发，同样不是自有协议；
 *   · `source='api'` —— 框架内部直连兜底，不属于任何一条对外路径；
 *   · `source=''` 且没有 `user_name` —— 老路径 / 框架菜单 / 更早的插件消息。
 *     v4 注释写明「空串表示不知道，不代表入站」，不知道就不当上下文。
 *
 * 多插件合并的出站（`plugin='host,echo'`）也是 `'other'`：正文是几段拼起来的，
 * 留下就等于把别人的话算到她头上。宁可少一句自己的话——但它含 `host`，
 * 说明这条消息她也回了，所以**不构成「只触发了别的插件」**（见 `isPluginReply`）。
 *
 * 老库降级（列是后来才加的）：
 *   · 只有 `plugin`（v3）：认 `plugin='host'` 和「`plugin` 空且有 `user_name`」；
 *   · 连 `plugin` 都没有（v1/v2）：只剩 `user_name` 能判，**出站全部 `'other'`**。
 *     宁可这一版看不见「自己说过什么」，也不把别的插件的回复冒充成她的话。
 *     这种库只可能是升级前的尾巴，账本滚动删除后会自然消失。
 *
 * @param {any} r 账本原始行
 * @param {{plugin:boolean, source:boolean}} out 老库缺哪些列
 * @returns {'in'|'self'|'other'}
 */
function classifyRow(r, out) {
  const plugin = String(r?.plugin ?? '');
  const source = String(r?.source ?? '');
  const name = String(r?.user_name ?? '').trim();
  if (!out.plugin) return name ? 'in' : 'other';
  if (plugin === 'host') return 'self';
  if (plugin) return 'other';
  if (!out.source) return name ? 'in' : 'other';
  if (source === 'gateway' || source === 'webhook') return 'in';
  /** `source` 空 + 有名字 = 早于 v4 的入站（老库里入站的 source 是空串） */
  return source === '' && name ? 'in' : 'other';
}

/**
 * 这行是「别的插件在回话」吗——命令剔除要用的参照。
 *
 * 要求 `plugin` 非空且**不含 `host`**：`host,echo` 合并出站说明她也回了，
 * 那条命令不该被当成「只给别的插件的指令」。
 */
function isPluginReply(r) {
  const plugin = String(r?.plugin ?? '');
  if (!plugin) return false;
  return !plugin.split(',').some((p) => p.trim() === 'host');
}

/**
 * 命令前缀。
 *
 * 只从框架配置读（`config/bots/<botId>.json` 的 `commandPrefix`），
 * 默认 `/`。读不到就降级成 `/`——这个值是**唯一的兜底**，不能空：
 * 空串会让 `startsWith('')` 恒真，把所有真人消息都判成命令。
 *
 * 不跟着热更新：一个进程生命周期内读一次。前缀改动本来就要重启框架才生效，
 * 这里跟着重启走不会不一致。
 *
 * @param {string} base 框架安装目录
 * @param {string} id botId（`data/bots/` 的目录名，也是配置文件名）
 */
function commandPrefixOf(base, id) {
  try {
    const c = JSON.parse(readFileSync(join(base, 'config', 'bots', `${id}.json`), 'utf8'));
    const p = String(c?.commandPrefix ?? '').trim();
    return p || '/';
  } catch {
    return '/';
  }
}

/**
 * 白名单 + 命令剔除，**按正序**（老的在前）处理。
 *
 * 命令剔除的判据：这条入站以命令前缀开头，且它**确实被别的插件回过**——
 * 两种证据，优先用前者：
 *
 *   ① **精确**（账本 v5 起）：别家插件的出站行 `reply_to` 等于这条命令的
 *      `msg_id`。这是「谁答了谁」的硬链接，不依赖时间先后；
 *   ② **相邻**（老行没有 `reply_to` 时的退路）：紧邻的下一条是别的插件的
 *      回复，且时间差在 `TRIGGER_WINDOW_MS` 内。
 *
 * 只在**没有精确证据**时才靠相邻猜，而且下一条若自己带着 `reply_to`，
 * 说明它回的是别的消息（AI 慢回复中间插进别人发言，正是当初猜错的场景），
 * 这时相邻证据不成立。
 *
 * 为什么只剔命令：`/help`、`/roll` 这种在群里不是对话内容，剔掉零损失；
 * 而普通聊天哪怕顺带被别的插件回了一句，那句话仍然是群友说的，剔掉反而
 * 破坏上下文。真实账本里就有这种例子——`ai-chat` 慢回复紧跟在一条无关
 * 发言后面，只按「紧邻」判会把那条说话带走。
 *
 * 判不清一律**留**：命令后面跟的是真人发言 / 系统事件 / 超出窗口，都不剔。
 *
 * @param {any[]} rows 正序原始行（同一会话）
 * @param {{plugin:boolean, source:boolean}} out 老库缺哪些列
 * @param {string} prefix 命令前缀（保证非空）
 * @param {boolean} [withLink] 行里带不带 `msg_id` / `reply_to`
 */
function pickContextRows(rows, out, prefix, withLink = false) {
  /** 别的插件精确回过的消息（官方 `msg_id`），一次扫完，别在循环里找 */
  const answered = new Set();
  if (withLink) {
    for (const r of rows) {
      if (!isPluginReply(r)) continue;
      const to = String(r.reply_to ?? '').trim();
      if (to) answered.add(to);
    }
  }
  const keep = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const cls = classifyRow(r, out);
    if (cls === 'other') continue;
    if (cls === 'in' && String(r.content ?? '').startsWith(prefix) && triggeredByPlugin(rows, i, answered, withLink)) {
      continue;
    }
    keep.push(r);
  }
  return keep;
}

/**
 * 这条命令是不是「发出去就是给别的插件用的」。
 *
 * @param {any[]} rows 正序原始行
 * @param {number} i 命令所在下标
 * @param {Set<string>} answered 被别的插件精确回过的 `msg_id`
 * @param {boolean} withLink 行里带不带 `reply_to`
 */
function triggeredByPlugin(rows, i, answered, withLink) {
  const r = rows[i];
  const id = String(r.msg_id ?? '').trim();
  if (withLink && id && answered.has(id)) return true;
  const next = rows[i + 1];
  if (!next || !isPluginReply(next)) return false;
  if (Number(next.at) - Number(r.at) > TRIGGER_WINDOW_MS) return false;
  /**
   * 下一行自己带着「回谁」，说明它答的是另一条——相邻只是巧合。
   * 没有 `reply_to` 列的老库只能跳过这条判断。
   */
  if (withLink && String(next.reply_to ?? '').trim()) return false;
  return true;
}

/**
 * @param {object} o
 * @param {() => string} o.roostDirOf 取框架安装目录（活引用，改配置不重启）
 * @param {(msg:string)=>void} [o.log]
 */
export function createLedgerReader({ roostDirOf = () => '', log = () => {} } = {}) {
  let db = null;
  let file = '';
  /** 目录名就是 botId，`events_timeline` 索引的前缀（见 `resolveLedger`） */
  let botId = '';
  let broken = false;
  /** 老库可能没有引用两列；判一次缓存住，别每轮都跑 PRAGMA */
  let refCols = null;
  /** 出站判据要用的 `plugin` / `source` 也是后来才加的列，同样判一次 */
  let outCols = null;
  /**
   * `msg_id` 从 v1 就有，但 `reply_to` 是账本 v5 才加的。两者都在才能做
   * 「哪条命令被别的插件回过」的精确对账，缺一列退回相邻猜。
   *
   * `null` = 还没判；判过就缓存（每轮都 PRAGMA 不值当）。
   */
  let linkCols = null;
  /** 命令前缀，`open()` 时从框架配置读一次（默认 `/`） */
  let prefix = '/';

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

  /**
   * `plugin`（v3）/ `source`（v4）是后加的列，老库没有。
   *
   * 它们决定「这条是不是机器人自己发的」：出站的 `plugin` 非空
   * （`host` / `ai-chat` …），`source` 是 `plugin`/`host`/`onebot`。
   * 老库退回「`user_name` 为空即出站」——`outbound.js` 写死
   * `userId:''`、`userName:''`，这条退路对老数据同样成立。
   */
  function hasOutCols() {
    const d = open();
    if (!d) return { plugin: false, source: false };
    if (outCols !== null) return outCols;
    try {
      const cols = new Set(d.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
      outCols = { plugin: cols.has('plugin'), source: cols.has('source') };
    } catch {
      outCols = { plugin: false, source: false };
    }
    return outCols;
  }

  /**
   * `msg_id` / `reply_to` 都在，才能把「别家插件的出站」精确对到它回复的那条。
   *
   * `reply_to` 是账本 v5 才加的（框架 `feat/ledger-reply-link`），此前只有
   * 相邻关系可猜。极简假库（`revocation.test.js`）连 `msg_id` 都没有，
   * 所以按列判、缺了就走相邻退路，别硬查。
   */
  function hasLinkCols() {
    const d = open();
    if (!d) return false;
    if (linkCols !== null) return linkCols;
    try {
      const cols = new Set(d.prepare('PRAGMA table_info(events)').all().map((c) => c.name));
      linkCols = cols.has('msg_id') && cols.has('reply_to');
    } catch {
      linkCols = false;
    }
    return linkCols;
  }

  function open() {
    if (db || broken) return db;
    const found = resolveLedger({ roostDir: roostDirOf() });
    file = found.file;
    botId = found.botId;
    /** 命令前缀跟着库一起定：`/help` 这类消息要不要剔，全看它 */
    prefix = commandPrefixOf(found.base, botId);
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

  /**
   * 取一段「能给模型看」的账本：按 seq 倒序多取，逐行判来源 / 剔命令，
   * 凑够 `limit` 条或翻到账本开头为止。`recent()` 和 `gap()` 共用。
   *
   * **为什么不能把过滤全塞进 SQL**：命令剔除要看「这条命令是不是被别的插件
   * 回过」——精确判据是别家出站行的 `reply_to`，那一行本身会被白名单剔掉；
   * 老库的退路还要看「紧邻的下一条」，同样依赖被剔掉的行。判据没了，功能
   * 就成了摆设。所以 SQL 只做跟关联无关的粗筛（`time_basis` /
   * `kind != 'notice'`），来源判定和命令剔除都在 `pickContextRows()` 里按正序做。
   *
   * `kind != 'notice'` 必须在 SQL 里：频道事件夹在命令和插件回复中间的话，
   * 相邻退路的「下一条」就不再是插件回复，那条命令会留在上下文里。
   * 精确判据（`reply_to`）不受它影响，但老库还得靠这条。
   *
   * @param {object} o
   * @param {string} o.chatId
   * @param {number} o.limit 要几条「能用的」行
   * @param {number} [o.beforeSeq] 游标：只看比它更老的
   * @param {boolean} [o.withBot] 带 `bot_id` 走 `events_timeline` 索引
   */
  function readContext({ chatId, limit, beforeSeq = 0, withBot = false }) {
    const d = open();
    const out = hasOutCols();
    const withRefs = hasRefCols();
    const withLink = hasLinkCols();
    if (!d || !chatId || (withBot && !botId)) return { rows: [], withRefs, out, withLink };
    const lim = Math.min(Math.max(Number(limit) || 20, 1), withBot ? 100 : 50);
    const cols = 'seq, kind, chat_id, user_name, content, payload, at, time_basis'
      + (withRefs ? ', quoted, ref_msg_idx' : '')
      + (out.plugin ? ', plugin' : '')
      + (out.source ? ', source' : '');
    /**
     * `msg_id` 两种场合要：精确命令剔除拿它跟别家出站的 `reply_to` 配对。
     * **别无条件加**：`recent()` 的调用方有些跑在「极简假库」上
     * （`revocation.test.js` 只建了读正文必需的列），多查一列就是
     * `no such column`，被 catch 吞成空数组。
     *
     * `id` 只有 `gap()` 要（`withBot`），而且必须带着——见下面的说明。
     */
    const extra = withBot ? 'seq, id, msg_id,' : 'seq, msg_id,';
    const selectCols = (withBot || withLink)
      ? cols.replace('seq,', extra).concat(withLink ? ', reply_to' : '')
      : cols;
    const scope = withBot ? 'bot_id = ? AND chat_id = ?' : 'chat_id = ?';
    let before = Number(beforeSeq) || 0;
    /** 正序（老的在前）：命令剔除要看「紧邻的下一条」，必须按时间顺序排 */
    let all = [];
    try {
      for (let round = 0; round < 3; round += 1) {
        /**
         * 多取三倍：白名单会剔掉出站和别的插件的话，命令剔除又会带走一批
         * `/命令`。真实账本里这个比例不到一半，三倍足够一轮收工。
         */
        const batch = Math.min(Math.max(lim * 3, 30), 200);
        const rows = d
          .prepare(
            `SELECT ${selectCols}
               FROM events
              WHERE ${scope} AND time_basis != 'unknown' AND kind != 'notice'
                ${before > 0 ? 'AND seq < ?' : ''}
              ORDER BY seq DESC
              LIMIT ?`,
          )
          .all(...(withBot
            ? (before > 0 ? [botId, chatId, before, batch] : [botId, chatId, batch])
            : (before > 0 ? [chatId, before, batch] : [chatId, batch])));
        if (!rows.length) break;
        rows.reverse();
        all = rows.concat(all);
        /** 本批最老那条的 seq，下一轮从这里往前翻 */
        before = Number(rows[0].seq);
        if (pickContextRows(all, out, prefix, withLink).length >= lim) break;
        /** 没取满 = 账本没有更早的了 */
        if (rows.length < batch) break;
      }
      return { rows: pickContextRows(all, out, prefix, withLink).slice(-lim), withRefs, out, withLink };
    } catch (e) {
      log(`账本查询失败：${e.message}`);
      return { rows: [], withRefs, out, withLink };
    }
  }

  return {
    available: () => Boolean(open()),

    file: () => file || resolveLedgerFile({ roostDir: roostDirOf() }),

    /**
     * 某会话最近 N 条，**正序**返回（老的在前）。
     *
     * `beforeSeq` 是游标：传上一页最小的 seq，取更老的一页。
     * 注意返回正序之后，「下一页」的游标是 `items[0].seq` 而不是最后一条。
     *
     * 和 `gap()` 共用同一套判据（`pickContextRows`）。以前这里什么都返回，
     * 模型翻出来的「最近 5 条」里混着框架菜单、别的插件的回复、频道事件，
     * `who` 一律「（未知）」——既占字数，又让它把自己的话或者别人插件的
     * 回复安到群友头上。
     */
    recent({ chatId, limit = 20, beforeSeq = 0 } = {}) {
      const { rows, withRefs, out } = readContext({ chatId, limit, beforeSeq });
      return rows.map((r) => ({
        seq: Number(r.seq),
        at: Number(r.at),
        time: hhmm(r.at),
        who: String(r.user_name ?? '') || '（未知）',
        text: textOf(r),
        kind: String(r.kind ?? ''),
        /**
         * 自有协议发的（白名单里只剩 `plugin='host'`）。
         * 调用方要把它渲染成「你」——`user_name` 是空的，不替它署名
         * 就是一行「（未知）：…」，模型会把自己刚说的话当成群友说的。
         */
        self: Boolean(out.plugin && String(r.plugin ?? '') === 'host'),
        /** L1 引用精确作废要用的两个字段；老库缺列时整组不出现，别塞 undefined */
        ...(withRefs ? {
          quoted: String(r.quoted ?? ''),
          refMsgIdx: String(r.ref_msg_idx ?? ''),
        } : {}),
      }));
    },

    /**
     * 取某会话最近 N 条**原始行**，给「缺口补齐」对账用。
     *
     * 和 `recent()` 的差别：
     *   · 带 `bot_id` 走 `events_timeline` 索引（每轮都会跑，不能全表扫）；
     *   · 带 `eventId` —— 调用方拿它跟 `journal` 的 `eventIds` 求差集，
     *     差出来的就是「模型没见过的」；
     *   · 带 `self` —— 自有协议发的那些也要算进上下文（渲染成「你：」），
     *     但它们同样是「缺口」的一部分，不能只补别人的话。
     *
     * **对账键是 `eventId`（`events.id`），不是 `msgId`**：`journal.event_ids`
     * 里存的是框架给的 `msg.eventId`，而那个值来自
     * `bot.js:1145` 的 `msg.eventId = rec.id`——即账本主键 `crypto.randomUUID()`
     * （`ledger.js:233`）。`msg_id` 是 QQ 官方的 `ROBOT1.0_…`，两个集合
     * 永不相交，拿 `msgId` 比会让每一条都算「没见过」，每轮把最近几条账本
     * 当缺口重塞一遍（包括正在回的那句，账本在 dispatch 时就落了）。
     *
     * 来源白名单和命令剔除与 `recent()` **完全一致**（`pickContextRows`）：
     * 两条路要是判得不一样，同一个群在补齐块里和在翻记录里就是两个世界。
     *
     * 正序返回（老的在前），和 `recent()` 一致。**不做去重**：合并批、重投
     * 的重复行由调用方按 `eventId` 排掉，这里只管把账本原样交出去。
     */
    gap({ chatId, limit = 30 } = {}) {
      const { rows, withRefs, out } = readContext({ chatId, limit, withBot: true });
      return rows.map((r) => {
        const sender = String(r.user_name ?? '').trim();
        /**
         * 到这里的行只剩两类，`self` 只可能是「自有协议发的」：
         * `plugin='host'` 是宿主固定署名（`host/dispatch.js` 的
         * `HOST_PLUGIN`），不接受插件自报名覆盖。
         */
        const self = Boolean(out.plugin && String(r.plugin ?? '') === 'host');
        return {
          seq: Number(r.seq),
          eventId: String(r.id ?? ''),
          msgId: String(r.msg_id ?? ''),
          at: Number(r.at),
          time: hhmm(r.at),
          who: sender || '（未知）',
          text: textOf(r),
          self,
          kind: String(r.kind ?? ''),
          ...(withRefs ? {
            quoted: String(r.quoted ?? ''),
            refMsgIdx: String(r.ref_msg_idx ?? ''),
          } : {}),
        };
      });
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
