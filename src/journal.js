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

/**
 * 失效（invalidate-not-delete）的两条统一口径，批次 2 加。
 *
 * 用户改口时旧约定**不删、不抹正文**，只写 `invalid_at`（失效时刻）与
 * `superseded_by`（指向推翻它的那条消息 id）——原文、`event_ids`、
 * `evidence`、`vec` 全部留着，事后能查「为什么她突然改了口」。
 *
 * 两个后端各用各的形式，但**判据只有这一处定义**：SQLite 拼进 WHERE，
 * JSONL 走 `isActive()`。写死字面量的话，加一条读路径忘一处就前功尽弃。
 */
const NOT_INVALIDATED_SQL = 'invalid_at = 0';
const isActive = (r) => Number(r?.invalidAt ?? 0) === 0;

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
/** 一个 vec 最多认多少个数字键：正常嵌入向量几千个，超了就当坏数据丢掉 */
const MAX_VEC_KEYS = 1_000_000;

/**
 * 备份还原时的 `vec` 兼容（E4 行级还原，§3③「原样插回」）。
 *
 * `toBlob()` 存进 SQLite 的是 `Uint8Array`；`node:sqlite` 读出来也是
 * `Uint8Array`（**不是 Buffer**），`JSON.stringify` 之后会变成
 * `{"0":123,"1":45,…}` 这样的数字键对象；Buffer 则是 `{type:'Buffer',data:[…]}`。
 * 三种形状都得认回来，否则还原后 `vec` 变 null、语义检索静默失效。
 *
 * 一律返回**独立且 byteOffset=0** 的 Uint8Array：`toVec()` 要拿它构造
 * `Float32Array(u8.buffer, u8.byteOffset, …)`，Buffer 池化时 byteOffset
 * 不是 4 的倍数会抛 RangeError，那条检索就白算了。
 */
function asVec(v) {
  if (!v) return null;
  let bytes = null;
  if (v instanceof Float32Array) return Uint8Array.from(toBlob(v));
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) bytes = v;
  else if (Array.isArray(v)) bytes = v;
  else if (v && v.type === 'Buffer' && Array.isArray(v.data)) bytes = v.data;
  else if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    /**
     * 别用 `Math.max(...keys.map(Number))`：键一多展开参数就爆栈（实测 20 万键
     * `Maximum call stack size exceeded`），JSONL 的 `load()` 又会空吞这个异常，
     * 整行静默消失。改成循环 + 键数上限，畸形 vec 直接当没有。
     */
    if (keys.length && keys.length <= MAX_VEC_KEYS && keys.every((k) => /^\d+$/.test(k))) {
      let max = 0;
      for (const k of keys) { const n = Number(k); if (n > max) max = n; }
      if (max < MAX_VEC_KEYS) {
        const out = new Array(max + 1).fill(0);
        for (const k of keys) out[Number(k)] = Number(v[k]) & 0xff;
        bytes = out;
      }
    }
  }
  return bytes ? Uint8Array.from(bytes) : null;
}

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
    /** 统一过 asVec：JSONL 读回来的数字键对象也要还原成可用字节视图 */
    vec: asVec(r.vec),
    /** 这条记忆从哪几条消息来（阶段 4）。解析失败当空数组，不让坏数据拖垮整行 */
    eventIds: parseList(r.event_ids ?? r.eventIds),
    /** 原文快照 `[{eventId, at, sender, excerpt}]`，events 删了它也还在 */
    evidence: parseList(r.evidence),
    /**
     * 失效标记（批次 2）。两个名字都要认：SQLite 出来是蛇形，JSONL 文件里
     * 存的是 `normRow()` 自己的驼峰输出。漏一个，JSONL 在「读 → 改 → 重写」
     * 之后就会把失效状态整条丢掉，而且只影响 JSONL 后端，最难发现。
     */
    invalidAt: Number(r.invalid_at ?? r.invalidAt ?? 0),
    supersededBy: String(r.superseded_by ?? r.supersededBy ?? ''),
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
          evidence TEXT,
          -- 失效（批次 2）：0 = 有效；被推翻时写失效时刻，并把推翻它的
          -- 消息 id 记进 superseded_by。行、正文、出处一律不删
          invalid_at INTEGER NOT NULL DEFAULT 0,
          superseded_by TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS journal_day ON journal(day);
        CREATE INDEX IF NOT EXISTS journal_chat ON journal(chat_id, at);
        /*
         * 过期压缩的取料索引。
         *
         * 原来是 ORDER BY at DESC LIMIT 5000 再在内存里过滤：取的是**最新**
         * 5000 条，总数一超，最该压的老条目永远排不进来。改成按 keep_until
         * 直查之后，没有索引就是全表扫 + 临时排序。部分索引只覆盖"还没压过的"，
         * 体积小，正好卡在这个查询上。
         *
         * 注意：这段注释在模板字符串里，**不能出现反引号**，否则会把 SQL 截断。
         */
        CREATE INDEX IF NOT EXISTS journal_due ON journal(keep_until) WHERE digest IS NULL;
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
       * 失效两列同样按列判，不引 `user_version`。真机库的 `user_version=0`，
       * 而且这套代码从来没有版本迁移号——用版本号反而会把「已经手工补过列」
       * 的库判成旧库，撞 `duplicate column name`。
       * `ALTER TABLE ... NOT NULL DEFAULT` 在 SQLite 合法，老行自动拿到 0 / ''。
       */
      if (!cols.has('invalid_at')) db.exec('ALTER TABLE journal ADD COLUMN invalid_at INTEGER NOT NULL DEFAULT 0');
      if (!cols.has('superseded_by')) db.exec(`ALTER TABLE journal ADD COLUMN superseded_by TEXT NOT NULL DEFAULT ''`);
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

    /**
     * E4 / D11 备份还原：**原样插回**一整行。
     * 不走 `insert()`：那条会重算 level / keepUntil、丢掉 accessed / invalidAt /
     * supersededBy，等于把「被作废过的历史」洗成新行。按 id 幂等，重复还原
     * 靠 `ON CONFLICT DO NOTHING` 挡住。
     */
    insertRaw(row) {
      const d = open();
      if (!d) return false;
      const id = String(row?.id ?? '');
      if (!id) return false;
      const at = Number(row.at) || 0;
      const r = d
        .prepare(
          `INSERT INTO journal(id,at,day,chat_id,sender,role,text,level,kind,digest,keep_until,vec,event_ids,evidence,accessed,last_access,invalid_at,superseded_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(
          id,
          at,
          String(row.day || dayOf(at)),
          String(row.chatId ?? ''),
          String(row.sender ?? ''),
          String(row.role ?? 'user'),
          String(row.text ?? ''),
          LEVELS.includes(row.level) ? row.level : 'normal',
          String(row.kind ?? 'chat'),
          row.digest == null ? null : String(row.digest),
          Number(row.keepUntil) || 0,
          asVec(row.vec),
          row.eventIds?.length ? JSON.stringify(row.eventIds) : null,
          row.evidence?.length ? JSON.stringify(row.evidence) : null,
          Number(row.accessed) || 0,
          Number(row.lastAccess) || 0,
          Number(row.invalidAt) || 0,
          String(row.supersededBy ?? ''),
        );
      if (!r.changes) return false;
      d.prepare('INSERT INTO journal_fts(jid, tok) VALUES (?,?)').run(id, indexText(String(row.text ?? '')));
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
     * 标失效（批次 2）：只写 `invalid_at` / `superseded_by` 两列，
     * **不碰正文、摘要、`event_ids`、`evidence`、`vec`，也不删 FTS**。
     *
     * 和 `erase()` 的区别正是这次改动的核心：`erase()` 服务「用户说别记这个」，
     * 要把正文抹成占位符并清掉原文快照和向量；失效服务「这条约定被推翻了」，
     * 原文与溯源反而**必须留着**，否则事后查不出「她为什么突然不发图了」。
     *
     * `WHERE invalid_at=0` 让重复撤销不会反复改写失效时刻；事务包住整批，
     * 理由同 `erase()`——`DatabaseSync` 是同步 API，逐条隐式事务会卡住事件循环。
     * 检索侧靠各读路径的 `invalid_at = 0` 过滤，不是靠删索引（删了就没法溯源）。
     *
     * @param {string[]} ids 要作废的行 id
     * @returns {number} 本次实际作废几条
     */
    invalidate(ids, { at = Date.now(), supersededBy = '' } = {}) {
      const d = open();
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
      if (!d || !list.length) return 0;
      const t = Number(at) || Date.now();
      const by = String(supersededBy ?? '');
      const upd = d.prepare(
        'UPDATE journal SET invalid_at=?, superseded_by=? WHERE id=? AND invalid_at=0',
      );
      let n = 0;
      d.exec('BEGIN');
      try {
        for (const id of list) n += Number(upd.run(t, by, id).changes || 0);
        d.exec('COMMIT');
      } catch (e) {
        try { d.exec('ROLLBACK'); } catch {}
        throw e;
      }
      return n;
    },

    /**
     * 恢复失效（D11 retention 的「一键恢复」）：只认本功能打过的标记。
     *
     * 为什么按 `superseded_by='retention'` 过滤：失效还被「改口旧约定」用着，
     * 一键恢复不能把那些本来就该失效的行也放回注入。
     * ids 为空 = 全库恢复；传了就只恢复这批 id。
     */
    restore(ids) {
      const d = open();
      if (!d) return 0;
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
      const sql = list.length
        ? `UPDATE journal SET invalid_at=0, superseded_by='' WHERE invalid_at>0 AND superseded_by='retention' AND id IN (${marks(list.length)})`
        : `UPDATE journal SET invalid_at=0, superseded_by='' WHERE invalid_at>0 AND superseded_by='retention'`;
      const upd = d.prepare(sql);
      let n = 0;
      d.exec('BEGIN');
      try {
        n = Number(upd.run(...list).changes || 0);
        d.exec('COMMIT');
      } catch (e) {
        try { d.exec('ROLLBACK'); } catch {}
        throw e;
      }
      return n;
    },

    /** 排查看：列出已失效的行（原文与 `superseded_by` 都在），不进任何注入集 */
    invalidated({ chatId = '', limit = 50, aliases = [] } = {}) {
      const d = open();
      if (!d) return [];
      const keys = chatKeys(chatId, aliases);
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
      const sql = keys.length
        ? `SELECT * FROM journal WHERE invalid_at>0 AND chat_id IN (${marks(keys.length)}) ORDER BY invalid_at DESC LIMIT ?`
        : 'SELECT * FROM journal WHERE invalid_at>0 ORDER BY invalid_at DESC LIMIT ?';
      return d.prepare(sql).all(...(keys.length ? [...keys, lim] : [lim])).map(normRow);
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

    /**
     * 抹掉某个会话的全部正文（`clearChat` 的落点）：行留着，时间线不断。
     *
     * `aliases` 一起抹：换机器人之后「这个群」横跨好几个 openid，
     * 只抹当前键的话，旧键那些行还能被别名读出来——用户以为清干净了，
     * 下一条消息她又想起来了。
     */
    clearChat(chatId, aliases = []) {
      const d = open();
      if (!d) return 0;
      const keys = chatKeys(chatId, aliases);
      if (!keys.length) return 0;
      /**
       * 已经抹过的行不再算一次。
       *
       * 不排掉的话，同一个会话清第二遍会返回「又抹了 N 条」——
       * 用户看到这个数字会以为第一次没清干净。
       * `ERASED`（`forget` 留下的占位符）同样跳过：正文早就没了，
       * 再算一次只会让「忘掉 1 条」之后紧跟着「清空 2 条」。
       */
      const ids = d
        .prepare(`SELECT id FROM journal WHERE chat_id IN (${marks(keys.length)}) AND text<>? AND text<>? AND ${NOT_INVALIDATED_SQL}`)
        .all(...keys, CLEARED, ERASED)
        .map((r) => String(r.id));
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

    recent(chatId, n, kind = 'chat', aliases = []) {
      const d = open();
      if (!d) return [];
      const keys = chatKeys(chatId, aliases);
      const sql = keys.length
        ? `SELECT * FROM journal WHERE chat_id IN (${marks(keys.length)}) AND kind=? AND ${NOT_INVALIDATED_SQL} ORDER BY at DESC LIMIT ?`
        : `SELECT * FROM journal WHERE kind=? AND ${NOT_INVALIDATED_SQL} ORDER BY at DESC LIMIT ?`;
      const args = keys.length ? [...keys, kind, n] : [kind, n];
      return d.prepare(sql).all(...args).map(normRow);
    },

    /**
     * 按会话取「时间线」：只要真的对话（user / bot），不要摘要行。
     *
     * 和 `recent()` 的三个区别，都是给 `chat_look` 用的：
     *   · 排掉 `role='digest'`——那是巩固写的摘要，不是谁说过的话；
     *   · 排掉被抹除的行（`ERASED` / `CLEARED`）——用户明确要求忘掉的内容
     *     不能再以「（已按用户要求遗忘）」的形式出现在时间线里；
     *   · 支持 `before` 游标翻页（`recent()` 只能取「最近 N 条」）。
     *
     * 返回**倒序**（新的在前），由调用方决定怎么展示——和 `recent()` 一致。
     */
    recentTimeline(chatId, { limit = 20, before = 0, aliases = [] } = {}) {
      const d = open();
      if (!d) return [];
      const keys = chatKeys(chatId, aliases);
      const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const cur = Number(before) || 0;
      const where = [
        keys.length ? `chat_id IN (${marks(keys.length)})` : '',
        NOT_INVALIDATED_SQL,
        `kind = 'chat'`,
        `role IN ('user','bot')`,
        `text NOT IN (?,?)`,
        cur > 0 ? 'at < ?' : '',
      ].filter(Boolean);
      const args = [
        ...(keys.length ? keys : []),
        ERASED,
        CLEARED,
        ...(cur > 0 ? [cur] : []),
        lim,
      ];
      try {
        return d
          .prepare(`SELECT * FROM journal WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`)
          .all(...args)
          .map(normRow);
      } catch {
        return [];
      }
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
        .prepare(`SELECT * FROM journal WHERE day=? AND text<>? AND text<>? AND ${NOT_INVALIDATED_SQL} ORDER BY at`)
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
    listChat(chatId, limit = 500, aliases = []) {
      const d = open();
      if (!d) return [];
      const n = Number(limit);
      const all = !(n > 0);
      const keys = chatId ? chatKeys(chatId, aliases) : [];
      const sql = keys.length
        ? `SELECT * FROM journal WHERE chat_id IN (${marks(keys.length)}) AND ${NOT_INVALIDATED_SQL} ORDER BY at DESC${all ? '' : ' LIMIT ?'}`
        : `SELECT * FROM journal WHERE ${NOT_INVALIDATED_SQL} ORDER BY at DESC${all ? '' : ' LIMIT ?'}`;
      const args = keys.length ? (all ? keys : [...keys, n]) : all ? [] : [n];
      return d.prepare(sql).all(...args).map(normRow);
    },

    /**
     * 按会话统计条数。**只读**，不改任何东西。
     *
     * 给「账号迁移」页用：那一页要列出「库里有记忆、但认不出号码」的键。
     * 不能靠 `listChat` 一个个试——键可能上千个，而且试不出来哪些键存在。
     */
    scanChats() {
      const d = open();
      if (!d) return [];
      return d
        .prepare(`SELECT chat_id, COUNT(*) c FROM journal WHERE ${NOT_INVALIDATED_SQL} GROUP BY chat_id`)
        .all()
        .map((r) => ({ chatId: String(r.chat_id || ''), journal: Number(r.c || 0) }))
        .filter((x) => x.chatId);
    },

    /**
     * 把一批旧键的行**整体改挂**到号码键下（一键改写用）。
     *
     * 只改 `chat_id`，行 id / 时间 / 正文 / 摘要 / 向量都不动。
     * FTS 表索引的是 `(jid, tok)`，不含 chat_id，所以不用重建索引。
     *
     * 一个事务包住所有键：中途失败全部回滚，不能出现「改了一半」。
     * 上层（`rewrite.js`）在调用前已经做过整目录备份，这里是第二道保险。
     */
    rekey(fromKeys, toKey) {
      const to = String(toKey ?? '').trim();
      const keys = [...new Set((Array.isArray(fromKeys) ? fromKeys : []).map((k) => String(k ?? '').trim()).filter(Boolean))]
        .filter((k) => k !== to);
      const d = open();
      if (!to || !keys.length || !d) return 0;
      const upd = d.prepare('UPDATE journal SET chat_id=? WHERE chat_id=?');
      d.exec('BEGIN');
      try {
        let n = 0;
        for (const k of keys) n += Number(upd.run(to, k).changes || 0);
        d.exec('COMMIT');
        return n;
      } catch (e) {
        try { d.exec('ROLLBACK'); } catch {}
        throw e;
      }
    },

    /** FTS 检索：bm25 排序（越小越相关，所以 ORDER BY 直接升序） */
    searchTerms(terms, { chatId = '', limit = 40, crossCritical = false, aliases = [] } = {}) {
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
        let where = `journal_fts MATCH ? AND j.${NOT_INVALIDATED_SQL}`;
        const args = [expr];
        /**
         * 别名键也一起查：换过机器人之后，旧日记还在旧 `chat_id` 下面。
         * 不带上的话 AI「主动想起来」时永远搜不到以前的事——
         * 注入里有、检索里没有，是最难发现的一种半失效。
         */
        const keys = chatId ? chatKeys(chatId, aliases) : [];
        if (keys.length) {
          where += crossCritical
            ? ` AND (j.chat_id IN (${marks(keys.length)}) OR j.chat_id='' OR j.level='critical')`
            : ` AND j.chat_id IN (${marks(keys.length)})`;
          args.push(...keys);
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

    withVec({ chatId = '', limit = 2000, aliases = [] } = {}) {
      const d = open();
      if (!d) return [];
      const keys = chatId ? chatKeys(chatId, aliases) : [];
      const sql = keys.length
        ? `SELECT * FROM journal WHERE vec IS NOT NULL AND (chat_id IN (${marks(keys.length)}) OR chat_id='') AND ${NOT_INVALIDATED_SQL} ORDER BY at DESC LIMIT ?`
        : `SELECT * FROM journal WHERE vec IS NOT NULL AND ${NOT_INVALIDATED_SQL} ORDER BY at DESC LIMIT ?`;
      return d.prepare(sql).all(...(keys.length ? [...keys, limit] : [limit])).map(normRow);
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
        /** 先补**老**条目的向量：按 DESC 取的话，最新的先补，最老的永远轮不到 */
        .prepare(`SELECT * FROM journal WHERE vec IS NULL AND text<>? AND text<>? AND ${NOT_INVALIDATED_SQL} ORDER BY at ASC LIMIT ?`)
        .all(ERASED, CLEARED, limit)
        .map(normRow);
    },

    /**
     * 到期待压的条目（最该压的在前）。
     *
     * 为什么不用 `listChat` 取完再过滤：那样取的是**最新** N 条，
     * 老条目进了窗口就永远压不到；而且每次要把整行正文读进内存。
     * 这里让 SQL 只把"已经到期、还没压过"的那批交出来，配合
     * `journal_due` 部分索引是毫秒级。
     *
     * @param {number} limit 一次最多压几条（剩下的下一轮接着来）
     * @param {number} at 判定"现在"的时间戳
     */
    due(limit = 500, at = Date.now()) {
      const d = open();
      if (!d) return [];
      return d
        .prepare(
          `SELECT * FROM journal
            WHERE kind='chat' AND level<>'critical' AND digest IS NULL
              AND keep_until>0 AND keep_until<=?
              AND ${NOT_INVALIDATED_SQL}
              AND text<>? AND text<>?
            ORDER BY keep_until ASC LIMIT ?`,
        )
        .all(at, ERASED, CLEARED, Number(limit) || 500)
        .map(normRow);
    },

    /** 还有多少条等着压（给日志看，不算在热路径上） */
    dueCount(at = Date.now()) {
      const d = open();
      if (!d) return 0;
      const r = d
        .prepare(
          `SELECT COUNT(*) c FROM journal
            WHERE kind='chat' AND level<>'critical' AND digest IS NULL
              AND keep_until>0 AND keep_until<=?
              AND ${NOT_INVALIDATED_SQL}
              AND text<>? AND text<>?`,
        )
        .get(at, ERASED, CLEARED);
      return Number(r?.c || 0);
    },

    stats() {
      const d = open();
      if (!d) return null;
      /** 统计只看有效行：失效行还在库里、能溯源，但不该混进「有多少记忆」 */
      const by = (sql, ...a) => d.prepare(
        `${sql}${sql.includes('WHERE') ? ' AND ' : ' WHERE '}${NOT_INVALIDATED_SQL}`,
      ).get(...a) || {};
      const gone = d.prepare('SELECT COUNT(*) c FROM journal WHERE invalid_at>0').get() || {};
      return {
        total: Number(by('SELECT COUNT(*) c FROM journal').c || 0),
        critical: Number(by("SELECT COUNT(*) c FROM journal WHERE level='critical'").c || 0),
        important: Number(by("SELECT COUNT(*) c FROM journal WHERE level='important'").c || 0),
        normal: Number(by("SELECT COUNT(*) c FROM journal WHERE level='normal'").c || 0),
        compressed: Number(by('SELECT COUNT(*) c FROM journal WHERE digest IS NOT NULL').c || 0),
        withVec: Number(by('SELECT COUNT(*) c FROM journal WHERE vec IS NOT NULL').c || 0),
        invalidated: Number(gone.c || 0),
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

  /**
   * 全量重写 JSONL。
   *
   * **返回是否真的写成功**。以前吞掉异常只记一条日志，于是 `rekey()` 在
   * 盘写不进去时照样 `return n`：内存说改好了、盘上没改，重启后旧键复活，
   * 而一键改写那边报的是「成功」。
   */
  function rewrite() {
    try {
      ensureDir(file);
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      return true;
    } catch (e) {
      log(`日记文件写不进去：${e.message}`);
      return false;
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

    /** E4：原样插回（不走会重算 level 的 insert()），按 id 幂等。 */
    insertRaw(row) {
      load();
      const id = String(row?.id ?? '');
      if (!id || rows.some((r) => r.id === id)) return false;
      const r = normRow(row);
      r.vec = asVec(row.vec);
      rows.push(r);
      if (!rewrite()) return false;
      reindex();
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

    /** 同 SQLite 后端：只写两列，正文 / 出处 / 向量 / 倒排都不动 */
    invalidate(ids, { at = Date.now(), supersededBy = '' } = {}) {
      load();
      const want = new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean));
      if (!want.size) return 0;
      const t = Number(at) || Date.now();
      const by = String(supersededBy ?? '');
      let n = 0;
      for (const r of rows) {
        /** 已失效的不再改写，和 SQLite 的 `WHERE invalid_at=0` 同口径 */
        if (!want.has(r.id) || !isActive(r)) continue;
        r.invalidAt = t;
        r.supersededBy = by;
        n += 1;
      }
      if (n) rewrite();
      return n;
    },

    /** 同 SQLite 后端：只把 `supersededBy='retention'` 的行放回，别动改口作废的 */
    restore(ids) {
      load();
      const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
      const want = list.length ? new Set(list) : null;
      let n = 0;
      for (const r of rows) {
        if (isActive(r) || String(r.supersededBy ?? r.superseded_by ?? '') !== 'retention') continue;
        if (want && !want.has(String(r.id))) continue;
        r.invalidAt = 0;
        r.supersededBy = '';
        n += 1;
      }
      if (n) rewrite();
      return n;
    },

    /** 同 SQLite 后端：排查看已失效的行 */
    invalidated({ chatId = '', limit = 50, aliases = [] } = {}) {
      const keys = chatKeys(chatId, aliases);
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
      return load()
        .filter((r) => !isActive(r) && (!keys.length || keys.includes(r.chatId)))
        .sort((a, b) => Number(b.invalidAt) - Number(a.invalidAt))
        .slice(0, lim);
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

    clearChat(chatId, aliases = []) {
      load();
      const keys = new Set(chatKeys(chatId, aliases));
      let n = 0;
      for (const r of rows) {
        if (!keys.has(r.chatId) || !isActive(r)) continue;
        /** 同 SQLite 后端：已经抹过的（`forget` 的 ERASED 也算）不再算一次 */
        if (r.text === CLEARED || r.text === ERASED) continue;
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

    recent(chatId, n, kind = 'chat', aliases = []) {
      const keys = chatKeys(chatId, aliases);
      return load()
        .filter((r) => isActive(r) && r.kind === kind && (!keys.length || keys.includes(r.chatId)))
        .sort((a, b) => b.at - a.at)
        .slice(0, n);
    },

    /** 同 SQLite 后端：只要对话行、排掉抹除行、支持 before 游标 */
    recentTimeline(chatId, { limit = 20, before = 0, aliases = [] } = {}) {
      const keys = chatKeys(chatId, aliases);
      const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const cur = Number(before) || 0;
      return load()
        .filter(
          (r) =>
            isActive(r)
            && r.kind === 'chat'
            && (r.role === 'user' || r.role === 'bot')
            && r.text !== ERASED
            && r.text !== CLEARED
            && (!keys.length || keys.includes(r.chatId))
            && (!cur || r.at < cur),
        )
        .sort((a, b) => b.at - a.at)
        .slice(0, lim);
    },

    /** 同 SQLite 后端：抹除过的行不进巩固的原料 */
    byDay(day) {
      return load()
        .filter((r) => isActive(r) && r.day === day && r.text !== ERASED && r.text !== CLEARED)
        .sort((a, b) => a.at - b.at);
    },

    listChat(chatId, limit = 500, aliases = []) {
      const keys = chatKeys(chatId, aliases);
      const rows = load()
        .filter((r) => isActive(r) && (!keys.length || keys.includes(r.chatId)))
        .sort((a, b) => b.at - a.at);
      const n = Number(limit);
      // 同 SQLite 后端：0 / 负数 = 不限
      return n > 0 ? rows.slice(0, n) : rows;
    },

    /** 同 SQLite 后端：按会话统计条数，只读 */
    scanChats() {
      const out = new Map();
      for (const r of load()) {
        if (!isActive(r)) continue;
        const k = String(r.chatId || '');
        if (!k) continue;
        out.set(k, (out.get(k) || 0) + 1);
      }
      return [...out].map(([chatId, journal]) => ({ chatId, journal }));
    },

    /** 同 SQLite 后端：把一批旧键的行整体改挂到号码键下 */
    rekey(fromKeys, toKey) {
      const to = String(toKey ?? '').trim();
      const keys = new Set(
        (Array.isArray(fromKeys) ? fromKeys : []).map((k) => String(k ?? '').trim()).filter(Boolean),
      );
      keys.delete(to);
      if (!to || !keys.size) return 0;
      load();
      let n = 0;
      for (const r of rows) {
        if (!keys.has(String(r.chatId || ''))) continue;
        r.chatId = to;
        n += 1;
      }
      if (n) {
        reindex();
        /** 写盘失败要抛：调用方（一键改写）靠这个走自动回退，不能静默成功 */
        if (!rewrite()) throw new Error('日记改挂之后写盘失败，改动没有落盘');
      }
      return n;
    },

    searchTerms(terms, { chatId = '', limit = 40, crossCritical = false, aliases = [] } = {}) {
      load();
      const keys = chatId ? chatKeys(chatId, aliases) : [];
      const hit = new Map(); // 下标 → 命中词数
      for (const t of terms) {
        for (const i of index.get(t) || []) {
          const r = rows[i];
          if (!isActive(r)) continue;
          // 跨群只放 critical 进来（身份事实），群内梗仍然拦住；别名键等同于当前键
          if (keys.length && !keys.includes(r.chatId) && r.chatId !== '' && !(crossCritical && r.level === 'critical')) continue;
          hit.set(i, (hit.get(i) || 0) + 1);
        }
      }
      return [...hit.entries()]
        .sort((a, b) => b[1] - a[1] || rows[b[0]].at - rows[a[0]].at)
        .slice(0, limit)
        .map(([i]) => rows[i]);
    },

    withVec({ chatId = '', limit = 2000, aliases = [] } = {}) {
      const keys = chatId ? chatKeys(chatId, aliases) : [];
      return load()
        .filter((r) => isActive(r) && r.vec && (!keys.length || keys.includes(r.chatId) || r.chatId === ''))
        .sort((a, b) => b.at - a.at)
        .slice(0, limit);
    },

    noVec(limit = 64) {
      // 同 SQLite 后端：占位符不补算向量；先补**老**条目（DESC 会让最老的永远轮不到）
      return load()
        .filter((r) => isActive(r) && !r.vec && r.text !== ERASED && r.text !== CLEARED)
        .sort((a, b) => a.at - b.at)
        .slice(0, limit);
    },

    /** 同 SQLite 后端：到期待压的条目，最该压的在前 */
    due(limit = 500, at = Date.now()) {
      return load()
        .filter(
          (r) =>
            isActive(r)
            && r.kind === 'chat'
            && r.level !== 'critical'
            && !r.digest
            && r.keepUntil > 0
            && r.keepUntil <= at
            && r.text !== ERASED
            && r.text !== CLEARED,
        )
        .sort((a, b) => a.keepUntil - b.keepUntil || a.at - b.at)
        .slice(0, Number(limit) || 500);
    },

    dueCount(at = Date.now()) {
      return load().filter(
        (r) =>
          isActive(r)
          && r.kind === 'chat'
          && r.level !== 'critical'
          && !r.digest
          && r.keepUntil > 0
          && r.keepUntil <= at
          && r.text !== ERASED
          && r.text !== CLEARED,
      ).length;
    },

    stats() {
      load();
      /** 同 SQLite：统计只看有效行，另给一个已失效条数供排查 */
      const live = rows.filter(isActive);
      return {
        total: live.length,
        critical: live.filter((r) => r.level === 'critical').length,
        important: live.filter((r) => r.level === 'important').length,
        normal: live.filter((r) => r.level === 'normal').length,
        compressed: live.filter((r) => r.digest).length,
        withVec: live.filter((r) => r.vec).length,
        invalidated: rows.length - live.length,
        firstAt: live.length ? Math.min(...live.map((r) => r.at)) : 0,
        lastAt: live.length ? Math.max(...live.map((r) => r.at)) : 0,
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
 * 「当前会话键 + 别名键」→ 去重后的键列表。
 *
 * 别名是换机器人之后唯一能读到旧日记的东西：openid 变了，旧记录还在旧
 * `chat_id` 下面。这里只负责拼键，SQL / 数组过滤两种后端都用它，
 * 免得两边各写一套、其中一边漏掉空值处理。
 */
function chatKeys(chatId, aliases) {
  const out = [];
  for (const k of [chatId, ...(Array.isArray(aliases) ? aliases : [])]) {
    const s = String(k ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** `[a,b]` → `'?,?'`，给 `IN (...)` 用 */
function marks(n) {
  return Array.from({ length: n }, () => '?').join(',');
}

/**
 * 每个键**各取一段**，拼起来（去重和排序交给调用方）。
 *
 * 为什么不是「一次 `IN (...)` 取一段」：那样窗口是被所有键共用的，
 * 活跃的新键会把旧键挤到窗口外。`top` / `digests` 都是「挑最重要的几条」，
 * 被挤掉的恰好是最该出现的老记忆。
 *
 * `chatId` 为空且没有别名时**保持旧行为**（`take('')` = 不过滤 = 看全部）：
 * 那是有意义的「全局视角」，不能悄悄变成空结果。
 */
function perKeyRows(chatId, aliases, take) {
  const keys = chatKeys(chatId, aliases);
  if (!keys.length) return take('');
  const out = [];
  for (const k of keys) for (const r of take(k)) out.push(r);
  return out;
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

    /**
     * `aliases` 是**换机器人之后**才有的东西：旧 openid 下的日记也该读得到。
     *
     * 注意这一层必须显式往下传——`host` 那边早就按四个参数在调了，
     * 少传一层不会报错，只会让别名静默失效（最难发现的那种）。
     */
    recent: (chatId, n = 5, kind = 'chat', aliases = []) => get().recent(chatId, n, kind, aliases),
    /**
     * 某个会话的全部行（`limit` 传 0 = 不限），批次 2 的撤销判定要用。
     *
     * store 层早就有这个方法，公开层却一直没透出——调用方若只用
     * `typeof journal.listChat === 'function'` 做兼容判断，整条撤销链路会
     * 静默跳过（生产上表现为「说了不用了，她还在发表情包」）。
     */
    listChat: (chatId, limit = 500, aliases = []) => get().listChat(chatId, limit, aliases),
    /**
     * 时间线（`chat_look` 用）：只要 user/bot 行、排掉抹除行、支持 before 游标。
     * 同样必须显式把 `aliases` 往下传，否则「号码 → 多个 openid」的会话查不全。
     */
    recentTimeline: (chatId, opts = {}) => get().recentTimeline(chatId, opts),
    byDay: (day) => get().byDay(day),
    /** 按会话统计条数（「账号迁移」页扫描用），只读 */
    scanChats: () => get().scanChats(),
    /** 一键改写：把一批旧键的行整体改挂到号码键下；两个后端都实现 */
    rekey: (fromKeys, toKey) => get().rekey(fromKeys, toKey),

    /**
     * 某个会话里"重要性×衰减+访问"最高的若干条（给注入用）。
     *
     * **每个键各取一段，再合并。** 共用一个 400 行窗口是不行的：
     * `listChat` 按 `at DESC` 取最新 400 条，迁移之后新键一两天就能攒满，
     * 旧键那条 `important` 排在第 401 位被截掉——而且是在**按等级过滤之前**
     * 就被截掉了，于是【记得比较深的】永远只有换机器人之后的事。
     * 别名通常 2~5 个键，多查几次不值一提。
     */
    top(chatId, { limit = 6, kinds = ['chat'], levels = ['critical', 'important'], aliases = [] } = {}) {
      const rows = [];
      const seen = new Set();
      for (const r of perKeyRows(chatId, aliases, (k) => get().listChat(k, 400))) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        if (!kinds.includes(r.kind) || !levels.includes(r.level)) continue;
        rows.push(r);
      }
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
     *
     * **这里不需要按每个键各取窗口**（`top` 需要）：摘要按时间取最新的几条，
     * 「这几天」本来就该是最近的——旧键那条一百天前的摘要，挤进来反而是错的。
     */
    digests(chatId, limit = 5, aliases = []) {
      const want = Math.max(1, Number(limit) || 5);
      return get()
        .recent(chatId, want + 10, 'digest', aliases)
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
     * `crossCritical` 默认 **true**，这是**设计**不是疏漏：
     *   · 判成 `critical` 的只有「身份事实」（名字、住处、明确要求记住的约定）；
     *   · 群内梗、闲聊永远进不了这一档，所以不会串场。
     * 两条验收锁着它：`memory.test.js` 的「验收1」（换群答得上来）和「验收2」（梗不串场）。
     * 想关掉必须两个都改，别只改这里——只改默认值会让验收1 静默失效。
     *
     * @returns {Promise<Array>} 按相关度排序的日记（带 score/why）
     */
    async search(query, { chatId = '', limit = 5, crossCritical = true, entityJournalIds = [], aliases = [] } = {}) {
      const terms = queryTerms(query);
      const entIds = [...new Set((entityJournalIds || []).filter(Boolean))];
      // 有实体路也能搜（查询词为空但提到了某个人）
      if (!terms.length && !entIds.length) return [];
      const s = get();

      const kw = terms.length
        ? s.searchTerms(terms, { chatId, limit: 40, crossCritical, aliases }).filter((r) => passesCoverage(terms, indexTerms(r.text)))
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
        /** `get()` 故意不过滤（写路径与溯源要用），实体路这里得自己挡一道 */
        if (!row || !isActive(row)) return;
        byId.set(id, row);
        bump(id, i, 0.5);
      });
      let vecHits = [];
      if (embed?.enabled?.()) {
        try {
          const qv = await embed.one(query);
          if (qv) {
            const cands = s.withVec({ chatId, aliases });
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
    /**
     * 到期待压的条目（巩固要处理的那批）。
     *
     * 旧实现是 `listChat('', 5000)` 再在内存里过滤，有三个毛病：
     *   1. 取的是**最新** 5000 条 —— 总数一超，最该压的老条目永远排不进窗口，
     *      「普通 3 天、重要 21 天压成一句」对老数据直接失效；
     *   2. 每次把 5000 行**全文**拉进内存只为挑出几十条；
     *   3. 它是在 `apply()` 里被调用的，而 `apply()` 按会话跑 —— N 个群就是 N 遍。
     *
     * 现在交给 store 按 `keep_until` 直查（配 `journal_due` 部分索引），
     * 顺序按"谁先到期"排，并带 `limit`：一次压不完，下一轮接着来。
     *
     * 占位符（已遗忘/已清空）不进这个队列：它们的 `keepUntil` 还留着旧值，
     * 一旦过期就会被挑出来给「（已按用户要求遗忘）」生成摘要，纯浪费。
     */
    dueToCompress(at = now(), limit = 500) {
      return get().due(Number(limit) || 500, at);
    },

    /** 还有多少条等着压（只给日志看，不进热路径） */
    dueCount: (at = now()) => get().dueCount(at),

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
     * 标失效（批次 2 的 2.2 三级撤销共用落点）。
     *
     * 只写 `invalid_at` / `superseded_by`，行、正文、`event_ids`、
     * `evidence` 全留着；`invalidated()` 能把这些行查回来做溯源。
     * 两个后端都实现同名方法（和 `rekey` 一样），否则回落到 JSONL 时
     * 会在运行时抛 TypeError。
     *
     * @param {string[]} ids 要作废的日记行 id
     * @param {{at?:number, supersededBy?:string}} opts `supersededBy` 传推翻它的那条消息 id
     * @returns {number} 本次实际作废几条
     */
    invalidate(ids, opts = {}) {
      return get().invalidate(ids, {
        at: opts.at ?? now(),
        supersededBy: String(opts.supersededBy ?? ''),
      });
    },

    /** 排查看：列出已失效的行（原文与 supersededBy 都在），默认 50 条 */
    invalidated: (opts = {}) => get().invalidated(opts),
    /** D11 retention 的一键恢复：只把本功能作废的行放回；ids 为空 = 全库 */
    restore: (ids) => get().restore(ids),
    /** E4 / D11 备份还原：原样插回一行，保留 accessed / invalidAt / vec */
    insertRaw: (row) => get().insertRaw(row),

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
    forget({ chatId = '', word = '', aliases = [], onStale = null } = {}) {
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
       *
       * 别名键一起扫：读的时候把旧键的行读出来了（面板看得见、注入里也有），
       * 只抹当前键就会出现「说了忘掉、下一条又想起来了」。
       * 这也是 `journal.js` 开头那句「实际没忘，是最不能接受的一种失败」
       * 在别名机制下唯一正确的处理方式。
       */
      const ids = [];
      for (const key of chatKeys(scope, aliases)) {
        for (const r of s.listChat(key, 0)) {
          if (r.kind !== 'chat' && r.kind !== 'digest') continue;
          const hit = r.text.includes(w) || (terms.length && passesCoverage(terms, indexTerms(r.text)));
          if (hit) ids.push(r.id);
        }
      }
      /**
       * **失效行扫不到，但要提示。**
       *
       * `listChat` 从批次 2 起就过滤 `invalid_at = 0`（注入/检索/计数都不该
       * 看见已作废的约定），于是「忘掉表情包」对一条被撤销的旧约定会返回 0，
       * 用户以为没生效。
       *
       * 但失效行**不能抹**：它们是 invalidate-not-delete 的溯源链，
       * `invalidated()` 是唯一还能查回原文与 `evidence` 的路径。所以这里只
       * 读数一遍、写一条日志，不动任何一行历史数据，返回类型也不变
       * （调用方都按 number 用）。
       */
      let gone = 0;
      try {
        const stale = typeof s.invalidated === 'function'
          ? s.invalidated({ chatId: scope, aliases, limit: 500 })
          : [];
        gone = stale.filter((r) => (r.kind === 'chat' || r.kind === 'digest')
          && (r.text.includes(w) || (terms.length && passesCoverage(terms, indexTerms(r.text))))).length;
      } catch {
        /** 提示是附加信息，读不到就算了——不能影响真正的抹除 */
      }
      /** 一次事务抹完；逐条 `update` 是 O(N²)（JSONL 每条重写整个文件） */
      const erased = s.erase(ids);
      if (gone) {
        log(`忘掉「${w}」：抹掉 ${erased} 条；另有 ${gone} 条已作废记录含这个词，`
          + '按「失效不改原文」保留（要溯源可用 invalidated() 查回）');
        /**
         * 只写日志的话，用户侧仍然看到「没有匹配的」——「以为没生效」这个
         * 原始症状一点没解决。所以给调用方一个回调，由它决定怎么把这件事
         * 说给人听（面板文案 / QQ 里的回复）。回调出错不许影响遗忘本身。
         */
        if (typeof onStale === 'function') {
          try {
            onStale(gone);
          } catch (e) {
            log(`遗忘提示回调出错：${e?.message ?? e}`);
          }
        }
      }
      return erased;
    },

    /**
     * 清掉某个会话的全部日记（面板"清空上下文"用，慎用）。
     *
     * 同样**不设窗口**：`clearChat` 的语义是「这个会话的日记清空」，
     * 留个 5000 条的上限等于「清了一部分」——用户以为清干净了，
     * 实际更早的记录还在，而且他自己不会发现。
     */
    clearChat(chatId, aliases = []) {
      return get().clearChat(requireChat(chatId, '清空日记'), aliases);
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
