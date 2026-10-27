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

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
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
 */
export function scoreOf(row, now = Date.now()) {
  const w = LEVEL_W[row.level] ?? 1;
  const ageDays = Math.max(0, (now - Number(row.at || 0)) / DAY);
  const decay = Math.exp(-ageDays / 30);
  const access = Math.min(1.5, Math.log1p(Number(row.accessed || 0)) / 2);
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
  };
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
          vec BLOB
        );
        CREATE INDEX IF NOT EXISTS journal_day ON journal(day);
        CREATE INDEX IF NOT EXISTS journal_chat ON journal(chat_id, at);
      `);
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
          `INSERT INTO journal(id,at,day,chat_id,sender,role,text,level,kind,digest,keep_until,vec)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
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

    recent(chatId, n, kind = 'chat') {
      const d = open();
      if (!d) return [];
      const sql = chatId
        ? 'SELECT * FROM journal WHERE chat_id=? AND kind=? ORDER BY at DESC LIMIT ?'
        : 'SELECT * FROM journal WHERE kind=? ORDER BY at DESC LIMIT ?';
      const args = chatId ? [chatId, kind, n] : [kind, n];
      return d.prepare(sql).all(...args).map(normRow);
    },

    byDay(day) {
      const d = open();
      if (!d) return [];
      return d.prepare('SELECT * FROM journal WHERE day=? ORDER BY at').all(day).map(normRow);
    },

    listChat(chatId, limit = 500) {
      const d = open();
      if (!d) return [];
      const sql = chatId
        ? 'SELECT * FROM journal WHERE chat_id=? ORDER BY at DESC LIMIT ?'
        : 'SELECT * FROM journal ORDER BY at DESC LIMIT ?';
      return d.prepare(sql).all(...(chatId ? [chatId, limit] : [limit])).map(normRow);
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
    noVec(limit = 64) {
      const d = open();
      if (!d) return [];
      return d.prepare('SELECT * FROM journal WHERE vec IS NULL ORDER BY at DESC LIMIT ?').all(limit).map(normRow);
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

    recent(chatId, n, kind = 'chat') {
      return load()
        .filter((r) => r.kind === kind && (!chatId || r.chatId === chatId))
        .sort((a, b) => b.at - a.at)
        .slice(0, n);
    },

    byDay(day) {
      return load().filter((r) => r.day === day).sort((a, b) => a.at - b.at);
    },

    listChat(chatId, limit = 500) {
      return load()
        .filter((r) => !chatId || r.chatId === chatId)
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
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
      return load()
        .filter((r) => !r.vec)
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
    add({ id, at, chatId = '', sender = '', role = 'user', text = '', level = '', kind = 'chat' }) {
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

    /** 每日摘要（巩固产出的那种一行一条） */
    digests(chatId, limit = 5) {
      return get().recent(chatId, limit, 'digest');
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
    async search(query, { chatId = '', limit = 5, crossCritical = true } = {}) {
      const terms = queryTerms(query);
      if (!terms.length) return [];
      const s = get();

      const kw = s
        .searchTerms(terms, { chatId, limit: 40, crossCritical })
        .filter((r) => passesCoverage(terms, indexTerms(r.text)));
      const ranks = new Map();
      const bump = (id, i) => ranks.set(id, (ranks.get(id) || 0) + 1 / (60 + i + 1));
      kw.forEach((r, i) => bump(r.id, i));

      const byId = new Map(kw.map((r) => [r.id, r]));
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
          return {
            ...r,
            score,
            why: [vecRank.has(id) ? `向量#${vecRank.get(id) + 1}` : '', kw.some((k) => k.id === id) ? '关键词' : '']
              .filter(Boolean)
              .join('+'),
            coverage: coverage(terms, indexTerms(r.text)),
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (out.length) touchIds(out.map((r) => r.id));
      return out;
    },

    /** 到期该压的条目（巩固要处理的那批） */
    dueToCompress(at = now()) {
      return get()
        .listChat('', 5000)
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
     * @returns {number} 抹掉几条
     */
    forget({ chatId = '', word = '' } = {}) {
      const w = String(word ?? '').trim();
      if (!w) return 0;
      const terms = queryTerms(w);
      const s = get();
      const pool = s.listChat(chatId, 2000);
      let n = 0;
      for (const r of pool) {
        if (r.kind !== 'chat') continue;
        const hit = r.text.includes(w) || (terms.length && passesCoverage(terms, indexTerms(r.text)));
        if (!hit) continue;
        s.update(r.id, { text: '（已按用户要求遗忘）', digest: null, level: 'normal' });
        n += 1;
      }
      return n;
    },

    /** 清掉某个会话的全部日记（面板"清空上下文"用，慎用） */
    clearChat(chatId) {
      const s = get();
      let n = 0;
      for (const r of s.listChat(chatId, 5000)) {
        s.update(r.id, { text: '（已清空）', digest: null, level: 'normal' });
        n += 1;
      }
      return n;
    },

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
