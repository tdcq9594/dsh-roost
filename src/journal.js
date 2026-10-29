/**
 * 日记：**每一次对话都留一条**，分三级，遗忘靠压缩而不是删除。
 *
 * 为什么要有日记（而不是只有 facts）：
 *   facts 是"提炼过的结论"，一两天只有几条；日记是"发生过什么"。
 *   大肥鱼那条实证说的就是这个——「没有日记的 AI 第二天醒来是另一个人」。
 *   换了模型、换了窗口，facts 还在但语气、梗、上下文全断了。
 *
 * 三级与寿命：
 *   critical  非常重要 → **永不压**（用户明确要求记住的、名字/住处这类身份事实）
 *   important 重要     → 留 21 天，到期**压成一句**，原文仍留在库里
 *   normal    普通     → 留 3 天，到期压成半句
 *
 * **铁律：遗忘 = 压缩 + 降权，不是删除。**
 *   所以 `text` 永远存原文、永不改写；压缩只写 `digest`，
 *   注入时优先用 digest（省 token），检索时原文照样能命中。
 *   这样「一周后问上周说过的事」答得上来——这正是验收第 3 条。
 *   唯一的例外是用户明说「别记这个」：那是**指令**不是自然衰减，
 *   `forget()` 会真的把内容抹掉（见该函数注释）。
 *
 * 存储：优先 `<数据目录>/journal.sqlite`（node:sqlite 内置，框架零依赖原则不能破）。
 *   实测 Node 22.22 的 node:sqlite 带 FTS5，但 `unicode61` 不切中文、
 *   `trigram` 又不吃 2 字词，所以索引列存的是**预先切好的二元组**（见 tokenize.js）。
 *   没有 node:sqlite（Node 22.0~22.4）时回落到 JSONL 追加 + 内存索引，
 *   功能一样、检索退化为线性扫描——日记这条线不能因为环境差异就断掉。
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  indexText,
  indexTerms,
  queryTerms,
  matchExpr,
  passesCoverage,
  coverage,
} from './tokenize.js';

export const LEVELS = ['critical', 'important', 'normal'];

/**
 * 抹除后留在行上的占位符。
 *
 * 抽成常量而不是各处写字面量：这两个值同时是**「这一行不再承载信息」的判据**
 * （`digests()` 靠它跳过被抹掉的摘要）。写死字符串的话，改一处忘一处，
 * 表现是「忘了但摘要里还看得见」——正是它们要防的那种漏。
 */
export const ERASED = '（已按用户要求遗忘）';
export const CLEARED = '（已清空）';

/** 注入排序用的等级权重（1.7：重要性 × 衰减 + 访问频率） */
const LEVEL_W = { critical: 3, important: 2, normal: 1 };

const DAY = 86_400_000;

/** 到期天数：普通 3 天、重要 21 天。critical 不进这个表 */
export const DEFAULT_KEEP_DAYS = { normal: 3, important: 21 };

/**
 * 判级规则。
 *
 * 为什么先用规则判、而不是白天就调模型：每条消息都调一次模型打分，
 * 成本比聊天本身还高。规则的准确率够用了——它只负责**粗分**，
 * 每天凌晨巩固时再让模型复核一遍（那时一次调用能看一天的量）。
 */
const RE_CRITICAL = [
  /记住|记牢|别忘|不要忘|千万别忘|一定要记|必须记|最重要/,
  /我叫|我的名字|我姓|名字是|我住|我家在|我老家|生日是|我生日|我电话|我手机|我邮箱|我微信/,
];
const RE_IMPORTANT = [
  /说好|约定|答应|约好|下次|明天|后天|大后天|周末|提醒我|见面|碰头|别迟到/,
  /我喜欢|我讨厌|我不喜欢|我最爱|我最怕|我想要|我希望|我打算|我准备/,
  /帮我看|帮我查|能不能帮|可以帮|拜托/,
];
const RE_FEELING = /开心|高兴|兴奋|爽|难受|难过|伤心|烦|郁闷|累死|好累|生气|气死|害怕|紧张|烦死/;

/**
 * 粗判一条日记的等级。
 *
 * `role === 'bot'` 的话降一档：AI 自己说的话不该比用户说的话更重要，
 * 否则日记里全是她的独白，注入时把用户的事实挤掉。
 */
export function classify(text, { role = 'user' } = {}) {
  const s = String(text ?? '');
  if (!s.trim()) return 'normal';

  let level = 'normal';
  if (RE_CRITICAL.some((re) => re.test(s))) level = 'critical';
  else if (RE_IMPORTANT.some((re) => re.test(s))) level = 'important';
  else if (RE_FEELING.test(s)) level = 'important';
  else if (s.length >= 40) level = 'important';

  if (role === 'bot') {
    // 短回复（"嗯""好"）不值得占坑
    if (s.length < 8) return 'normal';
    if (level === 'critical') level = 'important';
    else if (level === 'important') level = 'normal';
  }
  return level;
}

/** 本地时区的日期串。按天分组要用本地时间，UTC 会让凌晨的对话落到前一天 */
export function dayOf(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 当天 00:00 的本地时间戳 */
export function startOfDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0).getTime();
}

/**
 * 一条日记的"该不该被注入"的分值。
 *
 * 重要性 × 时间衰减 + 访问频率，压过的再打六折：
 *   · 半衰期取 30 天——一个月前的重要事还留三成，不会突然消失
 *   · access 用 log1p 压一下，免得一条被反复搜到的旧事永远霸榜
 *
 * **访问加分自己也衰减（45 天半衰期）**。不衰减的话它是永久加冕：
 * access 封顶 1.5，而重要性衰减到地板只降到 0.35×2=0.70，
 * 于是「一年前被搜到 20 次」的旧事 = 0.70+1.5 = 2.20，
 * 永远压过任何新鲜的重要记忆（2.00）——注入列表就此冻结，再也换不出一批新的。
 * 45 天比记忆本身的 30 天慢：被想起来过的事，确实该更黏一点。
 *
 * 注意 `accessed` **只由检索写入**。自动注入（top）不算"被想起"——
 * 那是系统自己挑的，让它计数等于注入得越勤越霸榜，上面那条会原样复发。
 */
export function scoreOf(row, now = Date.now()) {
  const w = LEVEL_W[row.level] ?? 1;
  const at = Number(row.at || 0);
  const ageDays = Math.max(0, (now - at) / DAY);
  const decay = Math.exp(-ageDays / 30);

  const accessed = Number(row.accessed || 0);
  let access = 0;
  if (accessed > 0) {
    const last = Math.max(Number(row.lastAccess || 0), at);
    const sinceDays = Math.max(0, (now - last) / DAY);
    access = Math.min(1.5, Math.log1p(accessed) / 2) * Math.exp(-sinceDays / 45);
  }

  let s = w * (0.35 + 0.65 * decay) + access;
  if (row.digest) s *= 0.6;
  return s;
}

/* ---------------- 存储层 ---------------- */

function ensureDir(file) {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {}
}

/**
 * FTS 批量删除。
 *
 * 为什么不是逐条 `DELETE FROM journal_fts WHERE jid=?`：FTS5 每删一行都要
 * 定位并重写索引段，实测 5000 条要 **1268ms**（而 UPDATE 5000 行只要 12ms）。
 * 拼成一条 `IN (...)` 是 **9ms**——差两个数量级，用户点「清空」时体感完全不同。
 *
 * 分 500 一批：SQLite 的变量上限默认 32766，切小一点更稳，也不影响速度。
 */
function deleteFtsMany(d, ids) {
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    d.prepare(`DELETE FROM journal_fts WHERE jid IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
  }
}

/** 一行的标准形状。上层只认这个，两种后端都产出它 */
function normRow(r) {
  return {
    id: String(r.id),
    at: Number(r.at),
    day: String(r.day),
    chatId: String(r.chat_id ?? r.chatId ?? ''),
    sender: String(r.sender ?? ''),
    role: String(r.role ?? 'user'),
    text: String(r.text ?? ''),
    level: LEVELS.includes(r.level) ? r.level : 'normal',
    kind: String(r.kind ?? 'chat'),
    digest: r.digest == null ? null : String(r.digest),
    keepUntil: Number(r.keep_until ?? r.keepUntil ?? 0),
    accessed: Number(r.accessed ?? 0),
    lastAccess: Number(r.last_access ?? r.lastAccess ?? 0),
    vec: r.vec ?? null,
    /** 这条记忆从哪几条消息来（阶段 4）。解析失败当空数组，不让坏数据拖垮整行 */
    eventIds: parseList(r.event_ids ?? r.eventIds),
    /** 原文快照 `[{eventId, at, sender, excerpt}]`，events 删了它也还在 */
    evidence: parseList(r.evidence),
  };
}

/** JSON 列解析：坏数据返回空数组，不抛 */
function parseList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try {
    const out = JSON.parse(v);
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/**
 * SQLite 后端。
 *
 * 懒打开：只有真正读写时才建库建表。否则插件一激活就动磁盘，
 * 干跑（scripts/dry-run.mjs）和只读启动都会平白留下文件。
 */
function createSqliteStore(file, log) {
  let db = null;
  let broken = false;
  /**
   * 有没有「删过行、但还没 VACUUM」。
   *
   * VACUUM 会把整个库重写一遍，几万条时要锁几秒——**不能放在用户点按钮的
   * 那条路上**（`DatabaseSync` 是同步 API，阻塞事件循环 = QQ 消息全卡住）。
   * 所以这里只记一个标记，真正的压缩交给巩固的定时器（每十分钟一轮）做。
   *
   * **标记必须落盘**：它原来只是闭包变量，进程一重启就没了。而重启
   * （DSH 更新、手动重载）比重启前那十分钟更常见——用户点了「彻底删除」，
   * 十分钟内重启一次，VACUUM 就永远不会跑，库里那些页一直留着原文，
   * 面板上却已经说"十分钟内自动压掉"。
   * 用同目录一个空文件当标记：写一次、压完删掉，跨进程有效。
   */
  const vacuumMark = `${file}.vacuum`;
  let needVacuum = existsSync(vacuumMark);

  /** 记下"删过行、待压库"：内存 + 落盘各一份，后者跨重启 */
  function markVacuum() {
    if (needVacuum) return;
    needVacuum = true;
    try {
      ensureDir(vacuumMark);
      writeFileSync(vacuumMark, String(Date.now()), 'utf8');
    } catch {}
  }

  function open() {
    if (db || broken) return db;
    try {
      ensureDir(file);
      // 延迟 require：没有这个模块时要在 catch 里回落，不能在顶层 import 就炸
      const { DatabaseSync } = process.getBuiltinModule
        ? process.getBuiltinModule('node:sqlite')
        : { DatabaseSync: null };
      if (!DatabaseSync) throw new Error('当前 Node 没有 node:sqlite');
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS journal (
          id TEXT PRIMARY KEY,
          at INTEGER NOT NULL,
          day TEXT NOT NULL,
          chat_id TEXT NOT NULL DEFAULT '',
          sender TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'user',
          text TEXT NOT NULL,
          level TEXT NOT NULL DEFAULT 'normal',
          kind TEXT NOT NULL DEFAULT 'chat',
          digest TEXT,
          keep_until INTEGER NOT NULL DEFAULT 0,
          accessed INTEGER NOT NULL DEFAULT 0,
          last_access INTEGER NOT NULL DEFAULT 0,
          vec BLOB,
          -- 场景片段（阶段 4）：这条记忆是从哪几条消息来的，以及原文快照
          event_ids TEXT,
          evidence TEXT
        );
        CREATE INDEX IF NOT EXISTS journal_day ON journal(day);
        CREATE INDEX IF NOT EXISTS journal_chat ON journal(chat_id, at);
      `);
      /**
       * 老库补列。
       *
       * `CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做，所以加列必须
       * 单独走 `ALTER TABLE`。不补的话，老用户的库上 insert 会直接报
       * 「no such column」，而新装的人是好的——这种只影响升级用户的错最难查。
       */
      const cols = new Set(db.prepare('PRAGMA table_info(journal)').all().map((c) => c.name));
      if (!cols.has('event_ids')) db.exec('ALTER TABLE journal ADD COLUMN event_ids TEXT');
      if (!cols.has('evidence')) db.exec('ALTER TABLE journal ADD COLUMN evidence TEXT');
      /**
       * FTS5 单独一张表而不是 external content：
       * external content 要靠触发器同步，改一行忘了同步就静默不一致。
       * 这里多存一份切好的词，换来"怎么写都不会错"。
       */
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS journal_fts USING fts5(jid UNINDEXED, tok, tokenize='unicode61')`);
      return db;
    } catch (e) {
      broken = true;
      db = null;
      log(`日记退回 JSONL：${e.message}`);
      return null;
    }
  }

  return {
    kind: 'sqlite',
    open,

    insert(row) {
      const d = open();
      if (!d) return null;
      const r = d
        .prepare(
          `INSERT INTO journal(id,at,day,chat_id,sender,role,text,level,kind,digest,keep_until,vec,event_ids,evidence)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          row.id,
          row.at,
          row.day,
          row.chatId,
          row.sender,
          row.role,
          row.text,
          row.level,
          row.kind,
          row.digest ?? null,
          row.keepUntil ?? 0,
          row.vec ?? null,
          row.eventIds?.length ? JSON.stringify(row.eventIds) : null,
          row.evidence?.length ? JSON.stringify(row.evidence) : null,
        );
      if (!r.changes) return false; // 幂等：同一条消息写了两次
      d.prepare('INSERT INTO journal_fts(jid, tok) VALUES (?,?)').run(row.id, indexText(row.text));
      return true;
    },

    get(id) {
      const d = open();
      if (!d) return null;
      const r = d.prepare('SELECT * FROM journal WHERE id=?').get(id);
      return r ? normRow(r) : null;
    },

    update(id, patch) {
      const d = open();
      if (!d) return false;
      const cols = [];
      const vals = [];
      const map = {
        level: 'level',
        digest: 'digest',
        keepUntil: 'keep_until',
        accessed: 'accessed',
        lastAccess: 'last_access',
        vec: 'vec',
        text: 'text',
      };
      for (const [k, col] of Object.entries(map)) {
        if (patch[k] === undefined) continue;
        cols.push(`${col}=?`);
        vals.push(patch[k]);
      }
      if (!cols.length) return false;
      vals.push(id);
      d.prepare(`UPDATE journal SET ${cols.join(',')} WHERE id=?`).run(...vals);
      /**
       * 文本被抹掉（用户说"别记这个"）时必须同步删索引，
       * 否则 FTS 里还留着原文的词，搜得到一条空记录。
       */
      if (patch.text !== undefined) {
        d.prepare('DELETE FROM journal_fts WHERE jid=?').run(id);
        if (String(patch.text).trim()) {
          d.prepare('INSERT INTO journal_fts(jid, tok) VALUES (?,?)').run(id, indexText(patch.text));
        }
      }
      return true;
    },

    /**
     * 批量抹正文（`forget` 的落点）：置占位符 + 清摘要 + 清原文快照/向量 + 降级，一个事务。
     *
     * 为什么不让上层循环调 `update()`：那样每行 3 条语句、各自一个隐式事务，
     * 实测 5000 条要 4.9 秒。`DatabaseSync` 是同步 API，这几秒里事件循环停着，
     * QQ 消息、心跳、面板请求全卡住——用户点一下「清空」就像插件死了。
     * 同一个循环包进事务后是毫秒级（实测 5000 条 50ms 左右）。
     *
     * **`evidence` 和 `vec` 必须一起清**：正文抹成占位符，可
     *   · `evidence` 里存着原文快照（`[{excerpt}]`），
     *   · `vec` 是原文算出来的向量，语义检索照样能命中这一行。
     * 留着任何一个，都是"忘了个正文、原文还在库里"。
     *
     * @param {string[]} ids 要抹的行
     * @returns {number} 实际抹掉几条
     */
    erase(ids) {
      const d = open();
      if (!d || !Array.isArray(ids) || !ids.length) return 0;
      const upd = d.prepare(
        'UPDATE journal SET text=?, digest=NULL, level=?, evidence=NULL, vec=NULL WHERE id=?',
      );
      let n = 0;
      d.exec('BEGIN');
      try {
        /**
         * 索引只删不回填。
         *
         * 以前这里会把占位符再写进 FTS，于是「遗忘」「清空」这两个词
         * 能搜出一堆占位符——既没意义，又让人以为"忘了的记录还在"。
         * 抹掉的行就该搜不到，`byDay` / `digests` 本来就按正文跳过它们。
         */
        deleteFtsMany(d, ids);
        for (const id of ids) n += Number(upd.run(ERASED, 'normal', id).changes || 0);
        d.exec('COMMIT');
      } catch (e) {
        try {
          d.exec('ROLLBACK');
        } catch {}
        throw e;
      }
      return n;
    },

    /** 抹掉某个会话的全部正文（`clearChat` 的落点）：行留着，时间线不断 */
    clearChat(chatId) {
      const d = open();
      if (!d) return 0;
      const ids = d.prepare('SELECT id FROM journal WHERE chat_id=?').all(chatId).map((r) => String(r.id));
      if (!ids.length) return 0;
      /** 同 `erase`：正文、摘要、原文快照、向量一起清，索引只删不回填 */
      const upd = d.prepare(
        'UPDATE journal SET text=?, digest=NULL, level=?, evidence=NULL, vec=NULL WHERE id=?',
      );
      d.exec('BEGIN');
      try {
        deleteFtsMany(d, ids);
        for (const id of ids) upd.run(CLEARED, 'normal', id);
        d.exec('COMMIT');
      } catch (e) {
        try {
          d.exec('ROLLBACK');
        } catch {}
        throw e;
      }
      return ids.length;
    },

    /**
     * **精确删一条**：行和 FTS 一起删。
     *
     * 面板点某一条的「忘」走这里，不再拿正文前几个字当关键词去猜。
     * 关键词是"批量入口"（用户说「忘掉小美」），单条删除必须有确定的 id——
     * 靠覆盖率匹配删单条，实测会把「生日是三月**五**号」和
     * 「生日是三月**六**号」一起抹掉（`MIN_COVERAGE` 只有 0.34）。
     */
    remove(id) {
      const d = open();
      if (!d) return false;
      let changed = 0;
      d.exec('BEGIN');
      try {
        d.prepare('DELETE FROM journal_fts WHERE jid=?').run(id);
        changed = Number(d.prepare('DELETE FROM journal WHERE id=?').run(id).changes || 0);
        d.exec('COMMIT');
      } catch (e) {
        try {
          d.exec('ROLLBACK');
        } catch {}
        throw e;
      }
      /** 行没了但页还在：让巩固时的 `vacuum()` 顺手压掉（和 purgeChat 同一档） */
      if (changed) markVacuum();
      return Boolean(changed);
    },

    recent(chatId, n, kind = 'chat') {
      const d = open();
      if (!d) return [];
      const sql = chatId
        ? 'SELECT * FROM journal WHERE chat_id=? AND kind=? ORDER BY at DESC LIMIT ?'
        : 'SELECT * FROM journal WHERE kind=? ORDER BY at DESC LIMIT ?';
      const args = chatId ? [chatId, kind, n] : [kind, n];
      return d.prepare(sql).all(...args).map(normRow);
    },

    /**
     * 某一天的全部记录（巩固按天取料）。
     *
     * **抹除过的行不返回。** 行还在库里（时间线连续），但它已经没有内容了：
     * 喂给巩固只会让模型把「（已按用户要求遗忘）」当成一句用户原话，
     * 进而抽出「主人—说过→ 已按用户要求遗忘」这种三元组。
     * 用户上午要求忘掉的事，凌晨被巩固重新「记住」，是最难解释的一种复活。
     */
    byDay(day) {
      const d = open();
      if (!d) return [];
      return d
        .prepare('SELECT * FROM journal WHERE day=? AND text<>? AND text<>? ORDER BY at')
        .all(day, ERASED, CLEARED)
        .map(normRow);
    },

    /**
     * 某个会话的日记。
     *
     * `limit` 传 **0 或负数表示不限**——「按关键词抹掉」「清空这个会话」
     * 这类操作必须扫全库，否则超过窗口的旧记录既搜不到也删不掉。
     * 用户说「忘掉三个月前那件事」，实际没忘，是最不能接受的一种失败。
     */
    listChat(chatId, limit = 500) {
      const d = open();
      if (!d) return [];
      const n = Number(limit);
      const all = !(n > 0);
      const sql = chatId
        ? `SELECT * FROM journal WHERE chat_id=? ORDER BY at DESC${all ? '' : ' LIMIT ?'}`
        : `SELECT * FROM journal ORDER BY at DESC${all ? '' : ' LIMIT ?'}`;
      const args = chatId ? (all ? [chatId] : [chatId, n]) : all ? [] : [n];
      return d.prepare(sql).all(...args).map(normRow);
    },

    /** FTS 检索：bm25 排序（越小越相关，所以 ORDER BY 直接升序） */
    searchTerms(terms, { chatId = '', limit = 40, crossCritical = false } = {}) {
      const d = open();
      if (!d) return [];
      const expr = matchExpr(terms);
      if (!expr) return [];
      try {
        /**
         * `crossCritical` 让**别的群里的 critical 条目**也参与命中。
         *
         * 为什么开这个口子：日记按群隔离是对的（A 群的梗不该出现在 B 群），
         * 但"他住在杭州"这种身份事实必须跨群——否则换个群问就答不出来。
         * 边界就是 critical 这一档：白天的规则只在命中
         * 「记住/我叫/我住/生日…」时才判 critical，群内玩笑进不来。
         * 这和 facts 分"跨群/本群"两层是同一个道理，只是那边由模型声明，
         * 这边由等级兜底。
         */
        let where = 'journal_fts MATCH ?';
        const args = [expr];
        if (chatId) {
          where += crossCritical
            ? " AND (j.chat_id=? OR j.chat_id='' OR j.level='critical')"
            : ' AND j.chat_id=?';
          args.push(chatId);
        }
        args.push(limit);
        return d
          .prepare(`SELECT j.* FROM journal_fts f JOIN journal j ON j.id=f.jid WHERE ${where} ORDER BY bm25(journal_fts) LIMIT ?`)
          .all(...args)
          .map(normRow);
      } catch (e) {
        log(`日记检索失败：${e.message}`);
        return [];
      }
    },

    withVec({ chatId = '', limit = 2000 } = {}) {
      const d = open();
      if (!d) return [];
      const sql = chatId
        ? 'SELECT * FROM journal WHERE vec IS NOT NULL AND (chat_id=? OR chat_id=\'\') ORDER BY at DESC LIMIT ?'
        : 'SELECT * FROM journal WHERE vec IS NOT NULL ORDER BY at DESC LIMIT ?';
      return d.prepare(sql).all(...(chatId ? [chatId, limit] : [limit])).map(normRow);
    },

    /** 还没有向量的条目（巩固时批量补算，白天不花这个钱） */
    /**
     * 还没有向量的条目（巩固时批量补算，白天不花这个钱）。
     *
     * **占位符不补算**：抹掉的行 `vec` 被清空了，但它的正文已经是
     * 「（已按用户要求遗忘）」。不排除的话，巩固会给这个占位符重新算一遍
     * 向量，等于把抹掉的那行重新塞回语义检索里。
     */
    noVec(limit = 64) {
      const d = open();
      if (!d) return [];
      return d
        .prepare('SELECT * FROM journal WHERE vec IS NULL AND text<>? AND text<>? ORDER BY at DESC LIMIT ?')
        .all(ERASED, CLEARED, limit)
        .map(normRow);
    },

    stats() {
      const d = open();
      if (!d) return null;
      const by = (sql, ...a) => d.prepare(sql).get(...a) || {};
      return {
        total: Number(by('SELECT COUNT(*) c FROM journal').c || 0),
        critical: Number(by("SELECT COUNT(*) c FROM journal WHERE level='critical'").c || 0),
        important: Number(by("SELECT COUNT(*) c FROM journal WHERE level='important'").c || 0),
        normal: Number(by("SELECT COUNT(*) c FROM journal WHERE level='normal'").c || 0),
        compressed: Number(by('SELECT COUNT(*) c FROM journal WHERE digest IS NOT NULL').c || 0),
        withVec: Number(by('SELECT COUNT(*) c FROM journal WHERE vec IS NOT NULL').c || 0),
        firstAt: Number(by('SELECT MIN(at) m FROM journal').m || 0),
        lastAt: Number(by('SELECT MAX(at) m FROM journal').m || 0),
      };
    },

    /**
     * **彻底删掉**某个会话的全部日记：行、FTS 索引一起删。
     *
     * 和 `clearChat`（抹正文、留行）是两档，用途不同：
     *   · clearChat —— 「这个会话别再用这些记忆」，时间线还留着
     *   · purgeChat —— 「这些记录不许存在」，行都没了
     *
     * 磁盘上的旧页要等 `vacuum()` 才真正清掉，这里只标记，不立刻压——
     * VACUUM 会锁库几秒，不能在用户点按钮那条路上跑。
     * @returns {number} 删掉几条
     */
    purgeChat(chatId) {
      const d = open();
      if (!d) return 0;
      let n = 0;
      d.exec('BEGIN');
      try {
        /**
         * 索引用**一条语句按子查询删**，不逐条：逐条 5000 次要 1.3 秒，
         * 一条语句 9ms（见 `deleteFtsMany` 的注释）。先删索引再删行，
         * 同一事务里子查询照样看得到这些行。
         */
        d.prepare('DELETE FROM journal_fts WHERE jid IN (SELECT id FROM journal WHERE chat_id=?)').run(chatId);
        n = Number(d.prepare('DELETE FROM journal WHERE chat_id=?').run(chatId).changes || 0);
        d.exec('COMMIT');
      } catch (e) {
        try {
          d.exec('ROLLBACK');
        } catch {}
        throw e;
      }
      /** 真删掉了才值得压库；一条没删就别让巩固白锁一次 */
      if (n) markVacuum();
      return n;
    },

    /**
     * 压库。**只在删过行之后才真做**，平时是一次判断就返回。
     *
     * 调用点放在巩固的定时器里（每十分钟一轮），不在消息链路上。
     * @returns {boolean} 这次有没有真的 VACUUM
     */
    vacuum() {
      if (!needVacuum) return false;
      const d = open();
      if (!d) return false;
      needVacuum = false;
      try {
        d.exec('VACUUM');
        /** 压成功才删标记：失败时留着，下一轮（或重启后）接着试 */
        try {
          unlinkSync(vacuumMark);
        } catch {}
        return true;
      } catch (e) {
        needVacuum = true;
        log(`压库失败（不影响使用，磁盘上多留一点旧页）：${e.message}`);
        return false;
      }
    },

    close() {
      try {
        db?.close();
      } catch {}
      db = null;
    },
  };
}

/**
 * JSONL 后端：没有 node:sqlite 时的退路。
 *
 * 追加写、内存里建一份数组 + 倒排索引。日计量级（几千条）完全够用。
 * 更新（压缩/改级）会整文件重写——那动作一天只发生一次（巩固），不算热路径。
 */
function createJsonlStore(file, log) {
  let rows = null;
  let index = null;

  function load() {
    if (rows) return rows;
    rows = [];
    try {
      if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            rows.push(normRow(JSON.parse(line)));
          } catch {}
        }
      }
    } catch (e) {
      log(`日记文件读不出来：${e.message}`);
    }
    index = new Map(); // 词 → Set(row 下标)
    rows.forEach((r, i) => {
      for (const t of indexTerms(r.text)) {
        if (!index.has(t)) index.set(t, new Set());
        index.get(t).add(i);
      }
    });
    return rows;
  }

  function rewrite() {
    try {
      ensureDir(file);
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    } catch (e) {
      log(`日记文件写不进去：${e.message}`);
    }
  }

  function reindex() {
    index = new Map();
    (rows || []).forEach((r, i) => {
      for (const t of indexTerms(r.text)) {
        if (!index.has(t)) index.set(t, new Set());
        index.get(t).add(i);
      }
    });
  }

  return {
    kind: 'jsonl',
    open: load,

    insert(row) {
      load();
      if (rows.some((r) => r.id === row.id)) return false;
      rows.push(normRow(row));
      // 追加而不是整文件重写：白天每条消息都走这条路
      try {
        ensureDir(file);
        appendFileSync(file, JSON.stringify(normRow(row)) + '\n', 'utf8');
      } catch (e) {
        log(`日记追加失败：${e.message}`);
      }
      const i = rows.length - 1;
      for (const t of indexTerms(row.text)) {
        if (!index.has(t)) index.set(t, new Set());
        index.get(t).add(i);
      }
      return true;
    },

    get(id) {
      return load().find((r) => r.id === id) || null;
    },

    update(id, patch) {
      load();
      const r = rows.find((x) => x.id === id);
      if (!r) return false;
      Object.assign(r, patch);
      if (patch.text !== undefined) reindex();
      rewrite();
      return true;
    },

    /**
     * 批量抹正文（同 SQLite 后端）。
     *
     * 这里**必须**一次改完再重写一次文件：`update()` 每条都整文件重写，
     * 上层循环调它的话是 O(N²)——实测 1000 条要 5.8 秒。
     */
    erase(ids) {
      load();
      const want = new Set((ids || []).map(String));
      let n = 0;
      for (const r of rows) {
        if (!want.has(r.id)) continue;
        r.text = ERASED;
        r.digest = null;
        r.level = 'normal';
        /** 同 SQLite 后端：原文快照和向量一起清，否则"正文忘了、原文还在" */
        r.evidence = null;
        r.vec = null;
        n += 1;
      }
      if (n) {
        reindex();
        rewrite();
      }
      return n;
    },

    clearChat(chatId) {
      load();
      let n = 0;
      for (const r of rows) {
        if (r.chatId !== chatId) continue;
        r.text = CLEARED;
        r.digest = null;
        r.level = 'normal';
        r.evidence = null;
        r.vec = null;
        n += 1;
      }
      if (n) {
        reindex();
        rewrite();
      }
      return n;
    },

    /** 精确删一条：行和索引一起（同 SQLite 后端） */
    remove(id) {
      load();
      const before = rows.length;
      rows = rows.filter((r) => r.id !== id);
      if (rows.length === before) return false;
      reindex();
      rewrite();
      return true;
    },

    recent(chatId, n, kind = 'chat') {
      return load()
        .filter((r) => r.kind === kind && (!chatId || r.chatId === chatId))
        .sort((a, b) => b.at - a.at)
        .slice(0, n);
    },

    /** 同 SQLite 后端：抹除过的行不进巩固的原料 */
    byDay(day) {
      return load()
        .filter((r) => r.day === day && r.text !== ERASED && r.text !== CLEARED)
        .sort((a, b) => a.at - b.at);
    },

    listChat(chatId, limit = 500) {
      const rows = load()
        .filter((r) => !chatId || r.chatId === chatId)
        .sort((a, b) => b.at - a.at);
      const n = Number(limit);
      // 同 SQLite 后端：0 / 负数 = 不限
      return n > 0 ? rows.slice(0, n) : rows;
    },

    searchTerms(terms, { chatId = '', limit = 40, crossCritical = false } = {}) {
      load();
      const hit = new Map(); // 下标 → 命中词数
      for (const t of terms) {
        for (const i of index.get(t) || []) {
          const r = rows[i];
          // 跨群只放 critical 进来（身份事实），群内梗仍然拦住
          if (chatId && r.chatId !== chatId && r.chatId !== '' && !(crossCritical && r.level === 'critical')) continue;
          hit.set(i, (hit.get(i) || 0) + 1);
        }
      }
      return [...hit.entries()]
        .sort((a, b) => b[1] - a[1] || rows[b[0]].at - rows[a[0]].at)
        .slice(0, limit)
        .map(([i]) => rows[i]);
    },

    withVec({ chatId = '', limit = 2000 } = {}) {
      return load()
        .filter((r) => r.vec && (!chatId || r.chatId === chatId || r.chatId === ''))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },

    noVec(limit = 64) {
      // 同 SQLite 后端：占位符不补算向量
      return load()
        .filter((r) => !r.vec && r.text !== ERASED && r.text !== CLEARED)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },

    stats() {
      load();
      return {
        total: rows.length,
        critical: rows.filter((r) => r.level === 'critical').length,
        important: rows.filter((r) => r.level === 'important').length,
        normal: rows.filter((r) => r.level === 'normal').length,
        compressed: rows.filter((r) => r.digest).length,
        withVec: rows.filter((r) => r.vec).length,
        firstAt: rows.length ? Math.min(...rows.map((r) => r.at)) : 0,
        lastAt: rows.length ? Math.max(...rows.map((r) => r.at)) : 0,
      };
    },

    /** 同 SQLite 后端：整行删掉，不是抹正文 */
    purgeChat(chatId) {
      load();
      const before = rows.length;
      rows = rows.filter((r) => r.chatId !== chatId);
      const n = before - rows.length;
      if (n) {
        reindex();
        rewrite();
      }
      return n;
    },

    /** JSONL 每次 rewrite 都是整文件重写，旧内容已经不在了，没有可压的 */
    vacuum: () => false,

    close() {
      rows = null;
      index = null;
    },
  };
}

/* ---------------- 向量小工具 ---------------- */

function toVec(blob) {
  if (!blob) return null;
  try {
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    return new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
  } catch {
    return null;
  }
}

function toBlob(vec) {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** 余弦。两边都归一化过就不用再除模长，这里保险起见除一下 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/* ---------------- 对外接口 ---------------- */

/**
 * 删除类操作的作用域必须是一个**具体会话**。
 *
 * 为什么要在这一层硬拦：`listChat('')` / `SELECT ... WHERE chat_id=?`（传空串）
 * 在日志库里是"不过滤"的意思，于是 chatId 一缺省，「清空这个群」
 * 就变成清空**所有群**——而调用方的 chatId 来自 `body.chatId || lastScene.chatId || ''`，
 * 面板刚打开、还没收过消息时正好是空串。
 *
 * 宁可抛错让调用方补参数，也不能默默把作用域放大：删除不可逆，
 * 「删多了」比「没删成」难解释得多。
 */
function requireChat(chatId, what = '日记操作') {
  const s = String(chatId ?? '').trim();
  if (!s) throw new Error(`${what}必须指定会话（缺 chatId；空值会作用到全部会话）`);
  return s;
}

/**
 * @param {object} o
 * @param {string} o.file    sqlite 或 jsonl 的落盘路径
 * @param {object} [o.embed] createEmbedder() 的返回；没有就纯关键词
 * @param {(m:string)=>void} [o.log]
 */
export function createJournal({ file, embed = null, log = () => {}, now = () => Date.now() } = {}) {
  let store = null;

  function get() {
    if (store) return store;
    store = createSqliteStore(file, log);
    /**
     * 先试着打开一次，打不开就换 JSONL。
     * 不能等到第一次 insert 才发现——那条日记就丢了。
     */
    if (!store.open()) {
      log('日记：SQLite 用不了，改走 JSONL（检索会慢一些，功能不变）');
      store = createJsonlStore(file.replace(/\.sqlite$/, '') + '.jsonl', log);
      store.open();
    }
    return store;
  }

  /** 压不压缩、什么时候到期 */
  const keepDays = { ...DEFAULT_KEEP_DAYS };

  function keepUntilOf(level, at) {
    if (level === 'critical') return 0; // 0 = 永不到期
    const d = keepDays[level] ?? 0;
    return d > 0 ? at + d * DAY : 0;
  }

  /** 搜到就记一次访问——access_count 是排序的一部分 */
  function touchIds(ids) {
    const s = get();
    const t = now();
    for (const id of ids || []) {
      const r = s.get(id);
      if (r) s.update(id, { accessed: (r.accessed || 0) + 1, lastAccess: t });
    }
  }

  return {
    /** 换一份到期策略（配置里可调） */
    setKeepDays(d) {
      for (const k of Object.keys(keepDays)) {
        const v = Number(d?.[k]);
        if (Number.isFinite(v) && v > 0) keepDays[k] = v;
      }
    },

    /**
     * 记一条。
     *
     * `id` 用 msg_id（`<msgId>` / `<msgId>:bot`）：合并窗口 + 重试会让同一条
     * 消息来两次，按 id 去重才不会写出两条（对照表 12.4）。
     * @returns {{added:boolean, level:string}}
     */
    add({
      id,
      at,
      chatId = '',
      sender = '',
      role = 'user',
      text = '',
      level = '',
      kind = 'chat',
      /** 这条记忆从哪几条消息来（阶段 4）。写的时候一起落，不事后补 */
      eventIds = [],
      /** 原文快照 `[{eventId, at, sender, excerpt}]`。events 7 天后删了，它还留着 */
      evidence = [],
    }) {
      const t = String(text ?? '').trim();
      if (!t) return { added: false, level: 'normal' };
      const ts = Number(at) || now();
      const lv = LEVELS.includes(level) ? level : kind === 'digest' ? 'important' : classify(t, { role });
      const row = {
        id: String(id || `${ts}-${Math.random().toString(36).slice(2, 8)}`),
        at: ts,
        day: dayOf(ts),
        chatId: String(chatId || ''),
        sender: String(sender || ''),
        role,
        text: t.slice(0, 4000),
        level: lv,
        kind,
        digest: null,
        keepUntil: kind === 'digest' ? 0 : keepUntilOf(lv, ts),
        vec: null,
        eventIds: (eventIds || []).map(String).filter(Boolean).slice(0, 50),
        evidence: (evidence || []).slice(0, 50),
      };
      const added = get().insert(row);
      return { added: Boolean(added), level: lv };
    },

    get: (id) => get().get(id),
    recent: (chatId, n = 5, kind = 'chat') => get().recent(chatId, n, kind),
    byDay: (day) => get().byDay(day),

    /** 某个会话里"重要性×衰减+访问"最高的若干条（给注入用） */
    top(chatId, { limit = 6, kinds = ['chat'], levels = ['critical', 'important'] } = {}) {
      const rows = get().listChat(chatId, 400).filter((r) => kinds.includes(r.kind) && levels.includes(r.level));
      const t = now();
      return rows
        .map((r) => ({ ...r, score: scoreOf(r, t) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    },

    /**
     * 每日摘要（巩固产出的那种一行一条）。
     *
     * 被 `forget` / `clearChat` 抹掉的不返回：行还在库里（时间线连续），
     * 但它已经没有内容了，进【这几天】只会多一行占位符噪音。
     * 多取一截再切，免得抹掉几条之后摘要凭空少一半。
     */
    digests(chatId, limit = 5) {
      const want = Math.max(1, Number(limit) || 5);
      return get()
        .recent(chatId, want + 10, 'digest')
        .filter((r) => r.text !== ERASED && r.text !== CLEARED)
        .slice(0, want);
    },

    /** 搜到就记一次访问——access_count 是排序的一部分 */
    touch: (ids) => touchIds(ids),

    /**
     * 检索。
     *
     * 关键词是**必走**的，向量是可选的第二路；两路用 RRF（k=60）融合。
     * 为什么用 RRF 而不是加权求和：bm25 和余弦的量纲完全不可比，
     * 加权需要为每份数据调参数；RRF 只看名次，天然免疫量纲。
     *
     * @returns {Promise<Array>} 按相关度排序的日记（带 score/why）
     */
    async search(query, { chatId = '', limit = 5, crossCritical = true, entityJournalIds = [] } = {}) {
      const terms = queryTerms(query);
      const entIds = [...new Set((entityJournalIds || []).filter(Boolean))];
      // 有实体路也能搜（查询词为空但提到了某个人）
      if (!terms.length && !entIds.length) return [];
      const s = get();

      const kw = terms.length
        ? s.searchTerms(terms, { chatId, limit: 40, crossCritical }).filter((r) => passesCoverage(terms, indexTerms(r.text)))
        : [];
      const ranks = new Map();
      /**
       * `w` 是这一路的权重。关键词和向量都是 1；实体只给 0.5——
       * 「她提到了张三」比字面命中弱，不该盖过关键词。
       */
      const bump = (id, i, w = 1) => ranks.set(id, (ranks.get(id) || 0) + w / (60 + i + 1));
      kw.forEach((r, i) => bump(r.id, i));

      const byId = new Map(kw.map((r) => [r.id, r]));

      /* 第三路：实体。不用算向量，纯靠图谱把候选日记拉进来 */
      entIds.forEach((id, i) => {
        /**
         * **先确认这一行还在，再给它加分。**
         *
         * 以前是先 `bump` 后查：图谱里 `episode.journal_id` 指向的日记
         * 被「彻底删除」之后，这个 id 就成了死 id——`byId` 里没有它，
         * 下面拼结果时读 `r.text` 直接抛 TypeError，被 `host` 那边的
         * catch 吞成一条 warn，于是**这一轮日记检索整段失效**。
         * 用户看到的是"她突然想不起以前的事"，日志里只有一行不好归因的警告。
         *
         * 死 id 是正常现象（删过日记就会留），所以这里直接跳过，不报错。
         */
        const row = byId.get(id) || s.get(id);
        if (!row) return;
        byId.set(id, row);
        bump(id, i, 0.5);
      });
      let vecHits = [];
      if (embed?.enabled?.()) {
        try {
          const qv = await embed.one(query);
          if (qv) {
            const cands = s.withVec({ chatId });
            const scored = [];
            for (const r of cands) {
              const v = toVec(r.vec);
              if (!v) continue;
              const cos = cosine(qv, v);
              if (cos >= (embed.minScore?.() ?? 0.35)) scored.push({ r, cos });
            }
            scored.sort((a, b) => b.cos - a.cos);
            vecHits = scored.slice(0, 40);
            vecHits.forEach(({ r }, i) => {
              bump(r.id, i);
              if (!byId.has(r.id)) byId.set(r.id, r);
            });
          }
        } catch (e) {
          // 向量这一路坏了不能影响关键词那一路
          log(`日记向量检索失败，只用关键词：${e.message}`);
        }
      }

      const vecRank = new Map(vecHits.map(({ r }, i) => [r.id, i]));
      const out = [...ranks.entries()]
        .map(([id, score]) => {
          const r = byId.get(id);
          /** 兜底：万一路径里还有别处塞进来的死 id，也不能让整段检索炸掉 */
          if (!r) return null;
          return {
            ...r,
            score,
            why: [vecRank.has(id) ? `向量#${vecRank.get(id) + 1}` : '', kw.some((k) => k.id === id) ? '关键词' : '']
              .filter(Boolean)
              .join('+'),
            coverage: coverage(terms, indexTerms(r.text)),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (out.length) touchIds(out.map((r) => r.id));
      return out;
    },

    /** 到期该压的条目（巩固要处理的那批） */
    dueToCompress(at = now()) {
      return get()
        .listChat('', 5000)
        /**
         * 占位符不压。
         *
         * 抹过的行 `level` 被降成 normal、`keepUntil` 还是原来那个，
         * 一旦过期就会被挑出来"压缩"——给一句「（已按用户要求遗忘）」
         * 生成摘要，纯浪费，还会在库里留下一条没意义的 digest。
         */
        .filter((r) => r.text !== ERASED && r.text !== CLEARED)
        .filter((r) => r.kind === 'chat' && r.level !== 'critical' && !r.digest)
        .filter((r) => r.keepUntil > 0 && r.keepUntil <= at)
        .sort((a, b) => a.at - b.at);
    },

    /** 写压缩结果。**只写 digest，不动 text** —— 原文永远留着 */
    compress(id, digest) {
      const d = String(digest ?? '').trim();
      if (!d) return false;
      return get().update(id, { digest: d.slice(0, 300) });
    },

    setLevel(id, level) {
      if (!LEVELS.includes(level)) return false;
      const r = get().get(id);
      if (!r) return false;
      /**
       * 已经是 critical 的不许被降级。
       * "非常重要"是用户亲口要求记的，模型复核时觉得不重要也不能推翻——
       * 这条护栏保证「永不压」是真的永不。
       */
      if (r.level === 'critical' && level !== 'critical') return false;
      return get().update(id, { level, keepUntil: keepUntilOf(level, r.at) });
    },

    /**
     * **真的忘掉**：按关键词抹掉正文。
     *
     * 这是铁律的唯一例外，理由：用户说"别记这个"是**指令**，
     * 不是自然衰减。他要的是"这件事不要存在"，不是"压成一句还留着"。
     * 抹法是置空正文 + 删索引，行还在（保住时间线的连续性），但内容没了。
     *
     * **摘要（`kind='digest'`）也在范围内。**
     * 以前这里只放行 `kind='chat'`，结果原文抹了、当天的摘要还在——
     * 用户问「你还记得小美吗」，【这几天】那一段照样把名字带出来。
     * 那不是「忘了」，那是「原文忘了、结论还记得」，比不删更让人不安。
     * @returns {number} 抹掉几条
     */
    forget({ chatId = '', word = '' } = {}) {
      const w = String(word ?? '').trim();
      if (!w) return 0;
      const scope = requireChat(chatId, '忘掉关键词');
      const terms = queryTerms(w);
      const s = get();
      /**
       * **扫全库，不设窗口。**
       *
       * 以前这里是 `listChat(chatId, 2000)`，于是超过 2000 条之后，
       * 更早的记录既搜不到也删不掉——用户说「忘掉三个月前那件事」，
       * 实际没忘，而且没有任何地方会提示他「只忘了最近的」。
       *
       * 必须拉全文而不是在 SQL 里 `LIKE`：命中走两条路（字面子串 +
       * `passesCoverage` 分词覆盖），后者要原文才能判断。
       * 代价是一次性把整个会话读进内存（十万条约几十 MB），
       * 但这是**用户主动要求删除**时才走的路，不在热路径上。
       *
       * `scope` 必须是具体会话：传空串在 `listChat` 里等于「不过滤」，
       * 那句「忘掉小美」就会把**所有群**里带「小美」的日记一起抹了。
       */
      const ids = [];
      for (const r of s.listChat(scope, 0)) {
        if (r.kind !== 'chat' && r.kind !== 'digest') continue;
        const hit = r.text.includes(w) || (terms.length && passesCoverage(terms, indexTerms(r.text)));
        if (hit) ids.push(r.id);
      }
      /** 一次事务抹完；逐条 `update` 是 O(N²)（JSONL 每条重写整个文件） */
      return s.erase(ids);
    },

    /**
     * 清掉某个会话的全部日记（面板"清空上下文"用，慎用）。
     *
     * 同样**不设窗口**：`clearChat` 的语义是「这个会话的日记清空」，
     * 留个 5000 条的上限等于「清了一部分」——用户以为清干净了，
     * 实际更早的记录还在，而且他自己不会发现。
     */
    clearChat(chatId) {
      return get().clearChat(requireChat(chatId, '清空日记'));
    },

    /**
     * **精确删一条**（面板点某一条的「忘」）。
     *
     * 为什么要有这个：关键词抹除是"批量入口"，它的命中判据是
     * `passesCoverage`（覆盖率只要 0.34），拿来删单条会误伤——
     * 实测「生日是三月五号」会把「生日是三月六号」一起抹掉。
     * 用户点的是**这一条**，就该只删这一条。
     * @returns {boolean} 有没有删掉（id 不存在时 false）
     */
    remove: (id) => get().remove(String(id ?? '')),

    /**
     * **彻底删掉**某个会话的日记：行和索引都不留。
     *
     * 和 `clearChat` 是两档，别混：
     *   · clearChat —— 抹正文、留行（时间线连续，能看出「这天有过东西」）
     *   · purgeChat —— 行都没了（用户要的是「这些记录不许存在」）
     * 磁盘上的旧页由 `vacuum()` 在巩固时压掉，这里不等。
     */
    purgeChat(chatId) {
      return get().purgeChat(requireChat(chatId, '彻底删日记'));
    },

    /** 压库。没删过行时是一次判断就返回，可以放心在定时器里调 */
    vacuum: () => get().vacuum(),

    stats: () => get().stats(),
    backend: () => get().kind,

    /* ---- 向量：巩固时补算，白天只算查询那一条 ---- */

    /** 还没算向量的条目（主循环在 consolidate 里） */
    noVec: (limit) => get().noVec(limit),

    setVec(id, vec) {
      if (!vec) return false;
      return get().update(id, { vec: toBlob(vec) });
    },

    vecOf: (row) => toVec(row?.vec),

    close() {
      store?.close();
      store = null;
    },
  };
}
