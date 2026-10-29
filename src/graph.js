/**
 * 知识图谱：**纯 SQLite 三表，不引 Neo4j / Graphiti**。
 *
 * 为什么不引图数据库：这一层要存的东西是"她记得谁是谁、谁跟谁什么关系"，
 * 量级是几千条边，不是百万。为一个几千行的图拉起一个 JVM 服务，
 * 部署成本远大于它带来的查询能力（框架还是零依赖）。
 *
 * 三张表：
 *   entity   人 / 地点 / 东西。名字 + 别名，openid 记在 meta 里
 *   edge     关系，**双时态**：valid_from / valid_to
 *   episode  原始片段。图抽错了能拿它重建——**兜底比聪明重要**
 *
 * 双时态是这套设计的核心：
 *   「我住在杭州」→ 边(用户 —住在→ 杭州) valid_from=10月，valid_to=NULL
 *   后来「我搬到上海了」→ **不删杭州那条**，给它 valid_to=今天，再插一条上海
 *   问「现在住哪」→ `valid_to IS NULL` 只剩上海
 *   问「九月住哪」→ `asOf(九月)` 还能答杭州
 *   删了旧边就再也答不了后者，人也确实是这样记事的。
 *
 * 作用域：边带 `chat_id`，空串表示"跨群"。
 *   群里的梗只在这个群可见（防串场），关于主人本人的事实走跨群。
 *   这个归属由巩固时的模型给（三元组带 scope），不在这一层猜。
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * "同一时刻只能有一个值"的关系。
 *
 * 只有这些关系在"改主意"时需要把旧边关掉；「喜欢」这类可以有多个并存
 * （喜欢吃辣 ≠ 不喜欢吃甜），关掉就丢信息了。
 */
const FUNCTIONAL = /住|叫|名字|生日|工作|职业|年龄|学校|城市|老家|电话|手机|邮箱|上班|所在地/;

const normKey = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 60);

/** 一条边的可读形状 */
const edgeView = (r) => ({
  id: Number(r.id),
  src: String(r.src_name ?? ''),
  rel: String(r.rel ?? ''),
  dst: String(r.dst_name ?? ''),
  from: Number(r.valid_from ?? 0),
  to: r.valid_to == null ? null : Number(r.valid_to),
  chatId: String(r.chat_id ?? ''),
  episodeId: r.episode_id == null ? null : Number(r.episode_id),
});

/**
 * @param {object} o
 * @param {string} o.file  graph.sqlite 路径
 * @param {(m:string)=>void} [o.log]
 */
export function createGraph({ file, log = () => {} } = {}) {
  let db = null;
  let ready = false;
  let broken = false;

  function open() {
    if (ready) return db;
    ready = true;
    if (broken) return null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const { DatabaseSync } = process.getBuiltinModule
        ? process.getBuiltinModule('node:sqlite')
        : { DatabaseSync: null };
      if (!DatabaseSync) throw new Error('当前 Node 没有 node:sqlite');
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS entity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          name TEXT NOT NULL,
          aliases_json TEXT NOT NULL DEFAULT '[]',
          first_seen INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL DEFAULT 'thing',
          chat_id TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX IF NOT EXISTS entity_key ON entity(key, chat_id);

        CREATE TABLE IF NOT EXISTS episode (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          chat_id TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL,
          journal_id TEXT
        );

        CREATE TABLE IF NOT EXISTS edge (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          src_id INTEGER NOT NULL,
          rel TEXT NOT NULL,
          dst_id INTEGER NOT NULL,
          valid_from INTEGER NOT NULL,
          valid_to INTEGER,
          episode_id INTEGER,
          chat_id TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS edge_src ON edge(src_id, rel);
        CREATE INDEX IF NOT EXISTS edge_chat ON edge(chat_id, valid_to);

        /**
         * 墓碑：用户明确说过「这条关系不该存在」。
         *
         * 为什么需要单独一张表：光删 edge 没用——日记原文还在，
         * 凌晨巩固会把同一件事重新抽出来。删了又长回来，比删不掉更让人火大。
         *
         * 用 normKey(名字) 而不是 entity.id：实体删掉重建之后 id 会变，
         * 名字才是稳定标识。
         *
         * chat_id='' 表示**所有会话**都别再写（全局屏蔽）；
         * 带具体 id 就只拦那一个会话——同一个关系在 A 群是真的、B 群是错的，
         * 这种情况必须能分开。
         */
        CREATE TABLE IF NOT EXISTS suppress (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          src_key TEXT NOT NULL,
          rel TEXT NOT NULL,
          dst_key TEXT NOT NULL,
          chat_id TEXT NOT NULL DEFAULT '',
          at INTEGER NOT NULL,
          why TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX IF NOT EXISTS suppress_uniq
          ON suppress(src_key, rel, dst_key, chat_id);
      `);
      /**
       * "同一关系同一时刻只有一条活边"用**部分唯一索引**表达。
       * 普通 UNIQUE 在 SQLite 里把 NULL 当互不相等，挡不住重复活边。
       */
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS edge_alive ON edge(src_id, rel, dst_id) WHERE valid_to IS NULL',
      );
      return db;
    } catch (e) {
      broken = true;
      db = null;
      log(`知识图谱不可用（${e.message}），记忆只剩 facts 和日记`);
      return null;
    }
  }

  const enabled = () => Boolean(open());

  /** 拿实体 id；没有就建。aliases 里已有的名字也能命中同一个实体 */
  function ensureEntity(name, { chatId = '', at = Date.now(), kind = 'thing', aliases = [] } = {}) {
    const d = open();
    if (!d) return 0;
    const raw = String(name ?? '').trim().slice(0, 60);
    const key = normKey(raw);
    if (!key) return 0;

    const hit = d.prepare('SELECT id, aliases_json FROM entity WHERE key=? AND chat_id=?').get(key, chatId);
    if (hit) {
      d.prepare('UPDATE entity SET last_seen=?, name=? WHERE id=?').run(at, raw || hit.name || raw, hit.id);
      return Number(hit.id);
    }
    // 别名反查：先找找有没有别的实体把它当别名
    const like = `%"${key}"%`;
    const byAlias = d
      .prepare('SELECT id FROM entity WHERE aliases_json LIKE ? AND chat_id=?')
      .get(like, chatId);
    if (byAlias) return Number(byAlias.id);

    const r = d
      .prepare(
        'INSERT INTO entity(key,name,aliases_json,first_seen,last_seen,kind,chat_id) VALUES (?,?,?,?,?,?,?)',
      )
      .run(key, raw, JSON.stringify((aliases || []).map(normKey).filter(Boolean)), at, at, kind, chatId);
    return Number(r.lastInsertRowid);
  }

  function addEpisode({ at = Date.now(), chatId = '', text = '', journalId = null } = {}) {
    const d = open();
    if (!d) return 0;
    const r = d
      .prepare('INSERT INTO episode(at,chat_id,text,journal_id) VALUES (?,?,?,?)')
      .run(Number(at) || Date.now(), chatId, String(text ?? '').slice(0, 2000), journalId);
    return Number(r.lastInsertRowid);
  }

  /**
   * 加一条边。同一条边（同一 src/rel/dst 且还活着）重复来就只更新时间，不重复插。
   *
   * 功能性关系（住在/叫/生日…）遇到不同的 dst 时，**把旧边关掉而不是删掉**，
   * 这就是双时态的落点。
   */
  function addEdge({ src, rel, dst, at = Date.now(), chatId = '', episodeId = null } = {}) {
    const d = open();
    if (!d) return 0;
    const r0 = String(rel ?? '').trim().slice(0, 40);
    if (!src || !dst || !r0) return 0;
    const t = Number(at) || Date.now();
    const sid = ensureEntity(src, { chatId, at: t });
    const did = ensureEntity(dst, { chatId, at: t });
    if (!sid || !did || sid === did) return 0;

    const alive = d
      .prepare('SELECT * FROM edge WHERE src_id=? AND rel=? AND dst_id=? AND valid_to IS NULL')
      .get(sid, r0, did);
    if (alive) return Number(alive.id);

    if (FUNCTIONAL.test(r0)) {
      // 旧的同关系活边全部关掉（valid_to 打上现在的时间，不是删除）
      d.prepare('UPDATE edge SET valid_to=? WHERE src_id=? AND rel=? AND valid_to IS NULL').run(t, sid, r0);
    }

    const r = d
      .prepare(
        'INSERT INTO edge(src_id,rel,dst_id,valid_from,valid_to,episode_id,chat_id) VALUES (?,?,?,?,NULL,?,?)',
      )
      .run(sid, r0, did, t, episodeId, chatId);
    return Number(r.lastInsertRowid);
  }

  /**
   * 关掉一条边（约定办完了、关系结束了）。
   * 不传 dst 就把这组 (src, rel) 的活边全关。
   */
  function closeEdge({ src, rel, dst = '', at = Date.now(), chatId = '' } = {}) {
    const d = open();
    if (!d) return 0;
    const t = Number(at) || Date.now();
    const sid = ensureEntity(src, { chatId, at: t });
    if (!sid) return 0;
    const r0 = String(rel ?? '').trim();
    let r;
    if (dst) {
      const did = ensureEntity(dst, { chatId, at: t });
      if (!did) return 0;
      r = d.prepare('UPDATE edge SET valid_to=? WHERE src_id=? AND rel=? AND dst_id=? AND valid_to IS NULL').run(t, sid, r0, did);
    } else {
      r = d.prepare('UPDATE edge SET valid_to=? WHERE src_id=? AND rel=? AND valid_to IS NULL').run(t, sid, r0);
    }
    return Number(r.changes || 0);
  }

  /**
   * 删掉一条关系，并记住「别再写回来」。
   *
   * 光 DELETE 是不够的：日记原文还在，凌晨巩固会把同一件事重新抽出来。
   * 所以这里是一个事务里的两步——删干净 + 立墓碑。
   *
   * 删的是**同名全部边**（活边 + 已经结束的），不只是活边：
   * 用户说"这条关系不对"时，面板「以前成立、现在不成立」那栏里还留着一条
   * 一模一样的，等于没删掉。
   *
   * 实体不级联删：可能还有别的边引用它，孤儿本身无害。
   *
   * @param {object} o
   * @param {string} o.src 主语
   * @param {string} o.rel 关系名
   * @param {string} o.dst 宾语
   * @param {string} [o.chatId] 只在这个会话里屏蔽；空串 = 所有会话
   * @param {string} [o.why] 为什么删（面板上显示，省得以后想不起）
   * @returns {{ok:boolean, removed:number, reason?:string}}
   */
  function suppressEdge({ src, rel, dst, chatId = '', why = '', at = Date.now() } = {}) {
    const d = open();
    if (!d) return { ok: false, removed: 0, reason: '图谱没启用' };
    const s = String(src ?? '').trim();
    const r = String(rel ?? '').trim();
    const o = String(dst ?? '').trim();
    if (!s || !r || !o) return { ok: false, removed: 0, reason: 'src / rel / dst 都得有' };

    const t = Number(at) || Date.now();
    const sk = normKey(s);
    const ok = normKey(o);
    const cid = String(chatId ?? '');

    let removed = 0;
    try {
      d.exec('BEGIN');
      /**
       * 删边用**名字**定位，不经过 `ensureEntity`。
       *
       * `ensureEntity` 会顺手把不存在的实体插进去——为了删一条边而造出
       * 两条实体，纯属垃圾。这里直接 join 名字。
       */
      removed = Number(
        d
          .prepare(
            `DELETE FROM edge WHERE rel=? AND src_id IN (SELECT id FROM entity WHERE key=?)
             AND dst_id IN (SELECT id FROM entity WHERE key=?) AND (?='' OR chat_id=?)`,
          )
          .run(r, sk, ok, cid, cid).changes || 0,
      );
      d.prepare(
        `INSERT INTO suppress(src_key, rel, dst_key, chat_id, at, why) VALUES (?,?,?,?,?,?)
         ON CONFLICT(src_key, rel, dst_key, chat_id)
         DO UPDATE SET at=excluded.at, why=excluded.why`,
      ).run(sk, r, ok, cid, t, String(why ?? '').slice(0, 120));
      d.exec('COMMIT');
    } catch (e) {
      try {
        d.exec('ROLLBACK');
      } catch {}
      return { ok: false, removed: 0, reason: e?.message || String(e) };
    }
    return { ok: true, removed };
  }

  /** 撤销屏蔽。撤销之后巩固会重新把它抽回来——这是对的，不是 bug */
  function unsuppressEdge({ id, src, rel, dst, chatId } = {}) {
    const d = open();
    if (!d) return { ok: false, removed: 0, reason: '图谱没启用' };
    try {
      if (id) {
        return { ok: true, removed: Number(d.prepare('DELETE FROM suppress WHERE id=?').run(Number(id)).changes || 0) };
      }
      const sk = normKey(src);
      const r = String(rel ?? '').trim();
      const ok = normKey(dst);
      if (!sk || !r || !ok) return { ok: false, removed: 0, reason: 'id 或者 src/rel/dst 得有' };
      const cid = String(chatId ?? '');
      return {
        ok: true,
        removed: Number(
          d.prepare('DELETE FROM suppress WHERE src_key=? AND rel=? AND dst_key=? AND chat_id=?')
            .run(sk, r, ok, cid).changes || 0,
        ),
      };
    } catch (e) {
      return { ok: false, removed: 0, reason: e?.message || String(e) };
    }
  }

  /**
   * 这条关系是不是被屏蔽过。
   *
   * 两条命中路径：**本会话**的墓碑，或者 `chat_id=''` 的全局墓碑。
   * 反过来不成立——只屏蔽了 A 群，B 群照样能写。
   *
   * @returns {boolean}
   */
  function isSuppressed({ src, rel, dst, chatId = '' } = {}) {
    const d = open();
    if (!d) return false;
    const sk = normKey(src);
    const r = String(rel ?? '').trim();
    const ok = normKey(dst);
    if (!sk || !r || !ok) return false;
    try {
      const hit = d
        .prepare(
          `SELECT 1 FROM suppress WHERE src_key=? AND rel=? AND dst_key=?
           AND (chat_id='' OR chat_id=?) LIMIT 1`,
        )
        .get(sk, r, ok, String(chatId ?? ''));
      return Boolean(hit);
    } catch {
      return false;
    }
  }

  /** 面板用：列出屏蔽清单（新删的在前） */
  function suppressed({ chatId = '', limit = 50 } = {}) {
    const d = open();
    if (!d) return [];
    try {
      const sql = chatId
        ? 'SELECT * FROM suppress WHERE chat_id=? OR chat_id=\'\' ORDER BY at DESC LIMIT ?'
        : 'SELECT * FROM suppress ORDER BY at DESC LIMIT ?';
      const rows = chatId ? d.prepare(sql).all(chatId, limit) : d.prepare(sql).all(limit);
      return rows.map((r) => ({
        id: r.id,
        src: r.src_key,
        rel: r.rel,
        dst: r.dst_key,
        chatId: r.chat_id,
        at: r.at,
        why: r.why,
      }));
    } catch {
      return [];
    }
  }

  const SELECT_EDGE = `
    SELECT e.*, s.name AS src_name, t.name AS dst_name
    FROM edge e
    JOIN entity s ON s.id = e.src_id
    JOIN entity t ON t.id = e.dst_id
  `;
  /** 现在的状态：只要活边。`chatId` 给定时包含跨群（chat_id=''）的边 */
  function nowEdges({ chatId = '', limit = 50 } = {}) {
    const d = open();
    if (!d) return [];
    const sql = chatId
      ? `${SELECT_EDGE} WHERE e.valid_to IS NULL AND (e.chat_id=? OR e.chat_id='') ORDER BY e.valid_from DESC LIMIT ?`
      : `${SELECT_EDGE} WHERE e.valid_to IS NULL ORDER BY e.valid_from DESC LIMIT ?`;
    return d.prepare(sql).all(...(chatId ? [chatId, limit] : [limit])).map(edgeView);
  }

  /** 某个时刻的状态（"九月住哪"）。双时态的第二个维度 */
  function edgesAsOf(ts, { chatId = '', limit = 50 } = {}) {
    const d = open();
    if (!d) return [];
    const t = Number(ts) || Date.now();
    const sql = chatId
      ? `${SELECT_EDGE} WHERE e.valid_from<=? AND (e.valid_to IS NULL OR e.valid_to>?) AND (e.chat_id=? OR e.chat_id='') ORDER BY e.valid_from DESC LIMIT ?`
      : `${SELECT_EDGE} WHERE e.valid_from<=? AND (e.valid_to IS NULL OR e.valid_to>?) ORDER BY e.valid_from DESC LIMIT ?`;
    return d.prepare(sql).all(...(chatId ? [t, t, chatId, limit] : [t, t, limit])).map(edgeView);
  }

  /** 已经结束的边（想看"改过什么主意"时用） */
  function endedEdges({ chatId = '', limit = 50 } = {}) {
    const d = open();
    if (!d) return [];
    const sql = chatId
      ? `${SELECT_EDGE} WHERE e.valid_to IS NOT NULL AND (e.chat_id=? OR e.chat_id='') ORDER BY e.valid_to DESC LIMIT ?`
      : `${SELECT_EDGE} WHERE e.valid_to IS NOT NULL ORDER BY e.valid_to DESC LIMIT ?`;
    return d.prepare(sql).all(...(chatId ? [chatId, limit] : [limit])).map(edgeView);
  }

  function entities({ chatId = '', limit = 50 } = {}) {
    const d = open();
    if (!d) return [];
    const sql = chatId
      ? 'SELECT * FROM entity WHERE chat_id=? OR chat_id=\'\' ORDER BY last_seen DESC LIMIT ?'
      : 'SELECT * FROM entity ORDER BY last_seen DESC LIMIT ?';
    return d.prepare(sql)
      .all(...(chatId ? [chatId, limit] : [limit]))
      .map((r) => ({
        id: Number(r.id),
        name: String(r.name),
        aliases: (() => {
          try {
            return JSON.parse(r.aliases_json || '[]');
          } catch {
            return [];
          }
        })(),
        firstSeen: Number(r.first_seen || 0),
        lastSeen: Number(r.last_seen || 0),
        kind: String(r.kind || 'thing'),
      }));
  }

  /**
   * 注入用的一段文字。
   *
   * 只给"现在还成立的"边，且压到 `A —关系→ B` 一行一条。
   * 为什么不把历史边一起给：那是查档案的活，不是聊天的活，
   * 给了反而让她把"以前住杭州"当"现在住杭州"说出去。
   */
  function text({ chatId = '', max = 300, limit = 10 } = {}) {
    if (!enabled()) return '';
    const rows = nowEdges({ chatId, limit });
    if (!rows.length) return '';
    const lines = rows.map((e) => `${e.src}—${e.rel}→${e.dst}`);
    let out = '';
    for (const line of lines) {
      if (out.length + line.length + 3 > max) break;
      out += (out ? '\n' : '') + '· ' + line;
    }
    return out;
  }

  /**
   * 某个实体牵涉到的日记 id。
   *
   * 用途：检索的**第三路**（关键词 / 向量 / 实体）。问"张三最近在忙什么"时
   * 字面命中往往很差，但图谱里"张三—工作在→X"是现成的，能把她带到对的日记上。
   *
   * 走 `episode.journal_id` 反查，**不改表结构**——episode 本来就记着来源日记。
   * （更准的做法是 edge 直接存 journal_id，但那要迁移；先用现成的。）
   */
  function linkedJournalIds(entityName, { chatId = '', limit = 20 } = {}) {
    const d = open();
    if (!d) return [];
    const key = normKey(entityName);
    if (!key) return [];
    try {
      const sql = chatId
        ? `SELECT DISTINCT e.journal_id AS jid
           FROM entity n
           JOIN edge g ON (g.src_id = n.id OR g.dst_id = n.id)
           JOIN episode e ON e.id = g.episode_id
           WHERE n.key = ? AND e.journal_id IS NOT NULL AND (g.chat_id = ? OR g.chat_id = '')
           LIMIT ?`
        : `SELECT DISTINCT e.journal_id AS jid
           FROM entity n
           JOIN edge g ON (g.src_id = n.id OR g.dst_id = n.id)
           JOIN episode e ON e.id = g.episode_id
           WHERE n.key = ? AND e.journal_id IS NOT NULL
           LIMIT ?`;
      const rows = d.prepare(sql).all(...(chatId ? [key, chatId, limit] : [key, limit]));
      return rows.map((r) => String(r.jid)).filter(Boolean);
    } catch (e) {
      log(`实体反查日记失败：${e.message}`);
      return [];
    }
  }

  /** 这条 (主语, 关系) 现在有没有活边。给"改主意"的护栏用 */
  function hasActive(src, rel, { chatId = '' } = {}) {
    const d = open();
    if (!d) return false;
    const r0 = String(rel ?? '').trim();
    if (!src || !r0) return false;
    const sid = ensureEntity(src, { chatId, at: Date.now() });
    if (!sid) return false;
    const row = d
      .prepare('SELECT id FROM edge WHERE src_id=? AND rel=? AND valid_to IS NULL LIMIT 1')
      .get(sid, r0);
    return Boolean(row);
  }

  function stats() {
    const d = open();
    if (!d) return { enabled: false, entities: 0, edges: 0, episodes: 0 };
    const one = (sql) => Number(d.prepare(sql).get()?.c || 0);
    return {
      enabled: true,
      entities: one('SELECT COUNT(*) c FROM entity'),
      edges: one('SELECT COUNT(*) c FROM edge WHERE valid_to IS NULL'),
      ended: one('SELECT COUNT(*) c FROM edge WHERE valid_to IS NOT NULL'),
      episodes: one('SELECT COUNT(*) c FROM episode'),
    };
  }

  /**
   * 把图清掉，**episode 留着**。
   *
   * 抽错了（模型把"喜欢"抽成"住在"）时，正确的修法是从原始片段重建，
   * 而不是手工删边。所以这个函数故意不碰 episode 表。
   */
  function reset({ keepEpisodes = true } = {}) {
    const d = open();
    if (!d) return false;
    d.exec('DELETE FROM edge');
    d.exec('DELETE FROM entity');
    if (!keepEpisodes) d.exec('DELETE FROM episode');
    return true;
  }

  function episodes({ chatId = '', limit = 20 } = {}) {
    const d = open();
    if (!d) return [];
    const sql = chatId
      ? 'SELECT * FROM episode WHERE chat_id=? ORDER BY at DESC LIMIT ?'
      : 'SELECT * FROM episode ORDER BY at DESC LIMIT ?';
    return d.prepare(sql).all(...(chatId ? [chatId, limit] : [limit]));
  }

  return {
    enabled,
    addEpisode,
    addEdge,
    closeEdge,
    /** 删一条关系 + 立墓碑（删了不会再被巩固写回来） */
    suppressEdge,
    /** 撤销屏蔽 */
    unsuppressEdge,
    /** 这条关系是不是被屏蔽过（巩固写之前要问一句） */
    isSuppressed,
    /** 屏蔽清单（面板用） */
    suppressed,
    ensureEntity,
    nowEdges,
    edgesAsOf,
    endedEdges,
    entities,
    episodes,
    linkedJournalIds,
    hasActive,
    text,
    stats,
    reset,
    isFunctional: (rel) => FUNCTIONAL.test(String(rel ?? '')),
    close() {
      try {
        db?.close();
      } catch {}
      db = null;
      ready = false;
    },
  };
}
