/**
 * 一键改写：把某个号码名下散落在各 openid 键里的记忆**合并到号码键**，旧键删除。
 *
 * ## 这是整条链路里唯一会动记忆数据的地方
 *
 * 账号迁移页其它操作都只写 `identity.json`（叠加层），存量数据一个字节不动。
 * 这一页是用户明确要求「把结构改干净」时才走的，**必须**满足：
 *
 *   1. 先 `plan()` 出清单：要动哪些文件（绝对路径）、哪些键、各多少条。
 *   2. 执行前**整文件备份**到 `D:\WorkBuddy\_archive\<日期>-账号改写\<时间戳>\`。
 *   3. 服务端还要收到精确的确认词 `改写`，光点按钮不够——公开路由能被直接 POST。
 *   4. 失败自动回退到备份；成功也保留备份，界面上有「一键回退」。
 *
 * ## 为什么不能只改 memory.json
 *
 * 记忆分散在四份存储里，少改一份就会出现「面板看着改好了，AI 一开口还是旧的」：
 *   · memory.json    facts / 元数据 / 人设覆盖 / 授权
 *   · journal.sqlite 日记（也可能是 JSONL 后端）
 *   · graph.sqlite   实体 / 边 / 原始片段 / 墓碑
 *   · sessions.json  会话映射（标题、类型、DSH sessionId）
 *
 * 日记和图谱走各自模块的 `rekey()`，不在这里假设底层是 SQLite。
 *
 * ## 已知边界（界面上必须提前警告）
 *
 * 换机器人之后如果**旧 bot 还在跑**，它会继续往旧 openid 写新记忆，
 * 于是又多出一个键。改写前要先停旧 bot。另外 identity.json 里的 claims
 * 一律保留——那是历史留痕，读的时候还能把旧 bot 新写的内容带出来。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

import { dataDir } from './config.js';
import { isValidUin } from './account.js';
import { unscopeKey } from './persona-scope.js';

/** 二次确认词。公开路由能被直接 POST，光靠前端弹窗拦不住 */
export const REWRITE_CONFIRM = '改写';

/** 备份根目录。固定按用户约定的归档位置，不接受请求传路径 */
export const BACKUP_ROOT = 'D:\\WorkBuddy\\_archive\\2026-11-04-账号改写';

/**
 * 只备份这几个**明确列出**的文件。
 *
 * 不用通配符、不递归整个数据目录：那会把缓存、日志、几十 MB 的临时文件
 * 一起拖进去，回退时还可能把改写之后新产生的数据覆盖掉。
 */
const BACKUP_FILES = [
  'memory.json',
  'sessions.json',
  'journal.sqlite',
  /** SQLite 是 WAL 模式，关库时一般会把 -wal 合并进主库并删掉；
   *  万一没删干净，这两个也得跟着备份，否则回退出来是半个数据库 */
  'journal.sqlite-wal',
  'journal.sqlite-shm',
  'journal.jsonl',
  'graph.sqlite',
  'graph.sqlite-wal',
  'graph.sqlite-shm',
  /** 审计 §3 的 P1/P2/P3：配置里按 chatId 存的键、人物档案、对话收尾 */
  'config.json',
  'profiles.json',
  'closing.json',
];

/** 原子写：先写 .tmp 再 rename，断电/异常时不会留下半个 JSON */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.rewrite.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** 这个号码名下有哪些旧键（只取 active claim，号码本身不算旧键） */
export function claimsOf(record) {
  const uin = String(record?.uin ?? record?.groupUin ?? '').trim();
  const out = [];
  const seen = new Set();
  for (const c of record?.claims ?? []) {
    if (c?.state !== 'active') continue;
    const k = String(c.openid ?? '').trim();
    if (!k || k === uin || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return { uin, keys: out };
}

/**
 * `backupRoot` 可注入是为了测试：真实执行会往
 * `D://WorkBuddy//_archive//...` 写，单元测试不该碰那个目录。
 * 生产不传，永远用 `BACKUP_ROOT`。
 */
export function createRewriter({
  memory, journal, graph, sessions, boundList, onReload,
  backupRoot = BACKUP_ROOT,
  log = () => {},
} = {}) {
  /**
   * 改写进行中。
   *
   * 两次 apply 并发时会出**最坏的一种错**：第二次的备份发生在第一次
   * 已经改完之后，于是它备份的是「改写后」的数据，还照样进
   * `listBackups()` 变成「可回退」——用户点回退，等于什么都没回退。
   * 前端那个 `busy` 只管一个标签页，直接 POST 根本拦不住。
   */
  let applying = false;

  /**
   * 归档根不可写时的退路。
   *
   * `BACKUP_ROOT` 写死在 `D://WorkBuddy//_archive//...`——没有 D 盘的机器上
   * `mkdir` 直接 EPERM，一键改写整个功能就不可用了，报错还是一句
   * `EPERM: operation not permitted, mkdir 'D://...'`，看不懂。
   * 退到数据目录下面，至少功能还在。
   */
  function fallbackRoot() {
    return join(dataDir(), 'rewrite-backups');
  }

  /** 真正能写的备份根：优先配置的那个，写不了就退到数据目录 */
  function activeRoot() {
    const preferred = resolve(backupRoot);
    try {
      mkdirSync(preferred, { recursive: true });
      return preferred;
    } catch (e) {
      const alt = resolve(fallbackRoot());
      mkdirSync(alt, { recursive: true });
      log(`归档目录 ${backupRoot} 写不了（${e?.message || e}），备份改到 ${alt}`);
      return alt;
    }
  }

  /** 回退时两个根都要认：同一份配置，取决于当时哪个可写 */
  function knownRoots() {
    return [resolve(backupRoot), resolve(fallbackRoot())];
  }

  function files() {
    return BACKUP_FILES.map((name) => ({
      name,
      abs: join(dataDir(), name),
      exists: existsSync(join(dataDir(), name)),
    }));
  }

  /** 关掉 sqlite 句柄。Windows 上打开着的文件没法被回退覆盖 */
  function closeHandles() {
    try { journal?.close?.(); } catch {}
    try { graph?.close?.(); } catch {}
  }

  /** 丢掉内存缓存，否则下一次 save() 会把刚恢复的文件又盖回去 */
  function reloadCaches() {
    try { memory?.reload?.(); } catch {}
    try { sessions?.reload?.(); } catch {}
    /** config.json 被改写后 host 里的 cfg 还是旧的，必须重新读盘 */
    try { onReload?.(); } catch {}
    closeHandles();
  }

  /**
   * 预览。**只读**，不写任何东西。
   *
   * 返回绝对路径是为了让界面在二次确认时能把「到底要改哪几个文件」
   * 原样列给用户，而不是一句「将修改你的记忆」。
   */
  async function plan({ uins = [] } = {}) {
    const bound = await boundList();
    if (!bound.ok) return { ok: false, error: bound.error || '读不到 Roost 的身份表' };

    /**
     * `uins` 允许三种形态：数组、逗号串（和 GET 路由一致）、不传（= 全部）。
     *
     * **字符串必须按逗号拆开**。以前非数组一律当空集，而空集等于「没指定
     * = 改全部」——`POST {"uins":"10001"}` 会把**所有**号码的记忆一起改掉，
     * 用户以为自己只改了一个。破坏性操作宁可少做，不能静默放宽范围。
     */
    const wanted = new Set(
      (Array.isArray(uins) ? uins : String(uins ?? '').split(','))
        .map((u) => String(u ?? '').trim())
        .filter(Boolean),
    );
    /** 没指定号码就默认全部已绑定的（界面上要能「一键全改」） */
    const records = [...(bound.users || []), ...(bound.groups || [])]
      .filter((r) => !wanted.size || wanted.has(String(r.uin ?? r.groupUin ?? '')))
      .filter((r) => isValidUin(String(r.uin ?? r.groupUin ?? '')));

    /**
     * 各存储的条数，用来在界面上列清单、执行后核对。
     * 4.5：键可能是 `xxx::p:<人格>`，先还原成逻辑 chatId 再合并取最大值——
     * 一键改写的计划按 openid 列键，用物理键去查会整片显示 0 条。
     */
    const putMax = (m, raw, v) => {
      const k = unscopeKey(raw);
      if (k) m.set(k, Math.max(Number(m.get(k)) || 0, Number(v) || 0));
    };
    const factsByKey = new Map();
    try {
      for (const { chatId, facts } of memory?.scanKeys?.() ?? []) putMax(factsByKey, chatId, facts);
    } catch {}
    const journalByKey = new Map();
    try {
      for (const { chatId, journal: n } of journal?.scanChats?.() ?? []) putMax(journalByKey, chatId, n);
    } catch {}
    const graphByKey = new Map();
    try {
      for (const { chatId, edges, episodes } of graph?.scanChats?.() ?? []) {
        const k = unscopeKey(chatId);
        if (!k) continue;
        const cur = graphByKey.get(k) || { edges: 0, episodes: 0 };
        graphByKey.set(k, {
          edges: Math.max(Number(cur.edges) || 0, Number(edges) || 0),
          episodes: Math.max(Number(cur.episodes) || 0, Number(episodes) || 0),
        });
      }
    } catch {}

    const items = [];
    for (const rec of records) {
      const { uin, keys } = claimsOf(rec);
      if (!uin || !keys.length) continue;
      const detail = keys.map((key) => ({
        key,
        facts: Number(factsByKey.get(key)) || 0,
        journal: Number(journalByKey.get(key)) || 0,
        edges: Number(graphByKey.get(key)?.edges) || 0,
        episodes: Number(graphByKey.get(key)?.episodes) || 0,
        /** 会话映射里这个键还在不在 */
        session: Boolean(sessions?.entry?.(key)),
      }));
      items.push({ uin, kind: rec.kind || '', keys: detail });
    }

    const totals = items.reduce(
      (a, it) => {
        for (const k of it.keys) {
          a.keys += 1;
          a.facts += k.facts;
          a.journal += k.journal;
          a.edges += k.edges;
        }
        return a;
      },
      { keys: 0, facts: 0, journal: 0, edges: 0 },
    );

    return {
      ok: true,
      dataDir: dataDir(),
      backupRoot,
      fallbackBackupRoot: fallbackRoot(),
      confirmWord: REWRITE_CONFIRM,
      files: files(),
      items,
      totals,
      /** 旧 bot 还在跑会立刻写回旧键，这个警告必须出现在确认框里 */
      warning: '改写前请先停掉旧机器人，否则它会继续往旧 openid 写记忆，改完又多出一个键。',
    };
  }

  /** 整文件备份。失败就抛，绝不允许「没备份就改」 */
  function backup(uins) {
    /**
     * **备份前必须先关 SQLite 句柄。**
     *
     * 两个库都是 `PRAGMA journal_mode=WAL`：刚写进去的行还在 `.sqlite-wal`
     * 里，主库文件可能一个字节都没变。直接 copy 主库等于备份了一份
     * 缺数据的库——回退出来「旧记忆没了」，正好是这个功能最不能出的错。
     * 关闭最后一个连接会触发 checkpoint 把 WAL 合并进主库。
     *
     * 关掉之后下面的 `rekey()` 会自动重新打开，不需要在这里恢复。
     */
    closeHandles();
    /**
     * 时间戳只到毫秒，两次并发仍可能撞在同一毫秒。加一段随机后缀，
     * 并且**不用 `recursive: true`**——撞了就直接抛，别把两次备份
     * 静默合进同一个目录（合并之后谁覆盖谁说不清）。
     */
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    const root = activeRoot();
    const dir = join(root, stamp);
    mkdirSync(dir);
    const saved = [];
    for (const f of files()) {
      if (!f.exists) continue;
      const dest = join(dir, basename(f.abs));
      copyFileSync(f.abs, dest);
      saved.push({ name: f.name, abs: f.abs, size: statSync(dest).size });
    }
    if (!saved.length) throw new Error('一个可备份的数据文件都没找到，已中止（不会改写）');
    writeJsonAtomic(join(dir, 'manifest.json'), {
      at: Date.now(),
      uins,
      dataDir: dataDir(),
      files: saved,
    });
    log(`一键改写备份完成：${dir}（${saved.length} 个文件）`);
    return { dir, files: saved };
  }

  /** memory.json：把旧键的 facts / 元数据 / 人设覆盖 / 授权合并到号码键，删旧键 */
  function rewriteMemory(items) {
    const file = join(dataDir(), 'memory.json');
    const raw = readJson(file);
    const chats = raw.chats && typeof raw.chats === 'object' ? raw.chats : {};
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
    const metaChats = meta.chats && typeof meta.chats === 'object' ? meta.chats : {};
    const personas = raw.personas && typeof raw.personas === 'object' ? raw.personas : {};
    const authz = raw.authz && typeof raw.authz === 'object' ? raw.authz : {};

    let moved = 0;
    for (const { uin, keys } of items) {
      const target = Array.isArray(chats[uin]) ? [...chats[uin]] : [];
      const targetMeta = { ...(metaChats[uin] || {}) };
      for (const { key } of keys) {
        for (const f of Array.isArray(chats[key]) ? chats[key] : []) {
          if (!target.includes(f)) target.push(f);
        }
        Object.assign(targetMeta, metaChats[key] || {});
        delete chats[key];
        delete metaChats[key];
        /** 人设 / 授权是「一条记录」，目标键没有才从旧键取，不覆盖用户已设的 */
        if (!personas[uin] && personas[key]) personas[uin] = personas[key];
        if (!authz[uin] && authz[key]) authz[uin] = authz[key];
        delete personas[key];
        delete authz[key];
        moved += 1;
      }
      chats[uin] = target;
      metaChats[uin] = targetMeta;
    }
    raw.chats = chats;
    raw.meta = { ...meta, chats: metaChats };
    raw.personas = personas;
    raw.authz = authz;
    writeJsonAtomic(file, raw);
    return moved;
  }

  /** sessions.json：旧键的映射并到号码键（目标已有就保留目标，别把当前 sessionId 冲掉） */
  function rewriteSessions(items) {
    const file = join(dataDir(), 'sessions.json');
    const raw = readJson(file);
    const chats = raw.chats && typeof raw.chats === 'object' ? raw.chats : {};
    let moved = 0;
    for (const { uin, keys } of items) {
      for (const { key } of keys) {
        if (!chats[uin] && chats[key]) chats[uin] = chats[key];
        if (chats[key]) {
          delete chats[key];
          moved += 1;
        }
      }
    }
    raw.chats = chats;
    writeJsonAtomic(file, raw);
    return moved;
  }

  /**
   * 审计 §3 补缺：一键改写时把**非记忆本体**的三处也一起合键。
   *
   * 以前这五处按 chatId 存的键、人物档案、收尾记录都不在改写链路里，
   * 换机器人后静默失效（按群覆写 / 群主动白名单 / 单聊模型 / 人格绑定 /
   * 主动搭话目标退回默认），或者同一人裂成两条档案。
   *
   * 目标键已有值就**不覆盖**（用户手动重选过的值优先）。
   */
  function rewriteExtraFiles(items) {
    const out = { config: 0, profiles: 0, closing: 0 };

    /* config.json：三张按 chatId 索引的表 + 两个标量/数组字段 */
    const cf = join(dataDir(), 'config.json');
    const c = readJson(cf);
    for (const { uin, keys } of items) {
      for (const { key } of keys) {
        for (const [seg, field] of [['model', 'byChat'], ['persona', 'byChat'], ['group', 'overrides']]) {
          const t = c?.[seg]?.[field];
          if (!t || typeof t !== 'object' || !Object.prototype.hasOwnProperty.call(t, key)) continue;
          if (t[uin] === undefined) t[uin] = t[key];
          delete t[key];
          out.config += 1;
        }
        if (String(c?.speakUp?.chatId ?? '') === key) {
          c.speakUp.chatId = uin;
          out.config += 1;
        }
        if (Array.isArray(c?.awake?.groups)) {
          for (const g of c.awake.groups) {
            if (g && String(g.chatId ?? '') === key) { g.chatId = uin; out.config += 1; }
          }
        }
      }
    }
    if (out.config) writeJsonAtomic(cf, c);

    /* profiles.json：数组或 { people: [] }，按 key 合并 */
    const pf = join(dataDir(), 'profiles.json');
    let praw;
    try { praw = JSON.parse(readFileSync(pf, 'utf8')); } catch { praw = null; }
    if (praw) {
      const arr = Array.isArray(praw) ? praw : (Array.isArray(praw?.people) ? praw.people : null);
      if (arr) {
        for (const { uin, keys } of items) {
          for (const { key } of keys) {
            const row = arr.find((r) => r && String(r.key ?? '') === key);
            if (!row) continue;
            const target = arr.find((r) => r && String(r.key ?? '') === uin);
            if (target) {
              /** 两条都留着没意义：把旧行的印象/建议接过去，再删旧行 */
              target.impression = [target.impression, row.impression].filter(Boolean).join('；').slice(0, 400);
              target.tips = [target.tips, row.tips].filter(Boolean).join('；').slice(0, 400);
              arr.splice(arr.indexOf(row), 1);
            } else {
              row.key = uin;
            }
            out.profiles += 1;
          }
        }
        writeJsonAtomic(pf, praw);
      }
    }

    /* closing.json：{ chats: { chatId: rec } } */
    const lf = join(dataDir(), 'closing.json');
    const l = readJson(lf);
    const chats = l.chats && typeof l.chats === 'object' ? l.chats : {};
    for (const { uin, keys } of items) {
      for (const { key } of keys) {
        if (!chats[key]) continue;
        if (!chats[uin]) chats[uin] = chats[key];
        delete chats[key];
        out.closing += 1;
      }
    }
    if (out.closing) { l.chats = chats; writeJsonAtomic(lf, l); }
    return out;
  }

  /**
   * 执行。任何一步失败都自动回退到刚做的备份。
   */
  /**
   * 执行。串行化：同一时刻只允许一次改写。
   *
   * 包装一层而不是在每个 return 前手动复位——中间有七八个返回点，
   * 漏一个就等于锁永远不释放（比不加锁更糟）。
   */
  async function apply(opts = {}) {
    if (applying) {
      return { ok: false, code: 'BUSY', error: '上一次改写还没结束，等它跑完再点' };
    }
    applying = true;
    try {
      return await applyOnce(opts);
    } finally {
      applying = false;
    }
  }

  async function applyOnce({ uins = [], confirm = '' } = {}) {
    if (String(confirm).trim() !== REWRITE_CONFIRM) {
      return { ok: false, code: 'CONFIRM_REQUIRED', error: `必须原样输入「${REWRITE_CONFIRM}」才会执行` };
    }
    const p = await plan({ uins });
    if (!p.ok) return { ok: false, error: p.error };
    if (!p.totals.keys) return { ok: false, code: 'NOTHING_TO_DO', error: '没有需要改写的旧键（可能都已经是号码键了）' };

    let bak;
    try {
      bak = backup(p.items.map((x) => x.uin));
    } catch (e) {
      return { ok: false, code: 'BACKUP_FAILED', error: `备份失败，什么都没改：${e?.message || e}` };
    }

    try {
      /** 先关句柄：Windows 上 sqlite 文件被占着时，回退覆盖会失败 */
      closeHandles();
      const memoryMoved = rewriteMemory(p.items);
      const sessionsMoved = rewriteSessions(p.items);
      const extraMoved = rewriteExtraFiles(p.items);

      let journalMoved = 0;
      let graphMoved = { entities: 0, edges: 0, episodes: 0, suppress: 0, mergedEntities: 0 };
      for (const { uin, keys } of p.items) {
        const from = keys.map((k) => k.key);
        journalMoved += Number(journal?.rekey?.(from, uin)) || 0;
        const g = graph?.rekey?.(from, uin);
        if (g) {
          for (const k of Object.keys(graphMoved)) graphMoved[k] += Number(g[k]) || 0;
        }
      }

      /** 让四个存储都重新读盘，否则内存里那份旧数据会写回去把改写盖掉 */
      reloadCaches();

      const changed = {
        keys: memoryMoved,
        sessions: sessionsMoved,
        journal: journalMoved,
        graph: graphMoved,
        /** 配置里按 chatId 存的键 / 人物档案 / 收尾记录 */
        config: extraMoved.config,
        profiles: extraMoved.profiles,
        closing: extraMoved.closing,
      };
      log(`一键改写完成：${JSON.stringify(changed)}，备份 ${bak.dir}`);
      return {
        ok: true,
        backup: bak.dir,
        backupFiles: bak.files.map((f) => f.abs),
        changed,
        /** 回退不需要重启就能生效，但保险起见界面上还是提一句 */
        hint: '已重新读盘，立即生效。出问题点「一键回退」恢复备份文件。',
      };
    } catch (e) {
      const why = e?.message || e;
      log(`一键改写失败，自动回退：${why}`);
      let rolled = { ok: false };
      try {
        rolled = rollback({ backup: bak.dir });
      } catch (r) {
        rolled = { ok: false, error: r?.message || r };
      }
      return {
        ok: false,
        code: 'REWRITE_FAILED',
        error: `改写失败：${why}`,
        rolledBack: rolled.ok,
        rollbackError: rolled.ok ? '' : rolled.error || '',
        backup: bak.dir,
      };
    }
  }

  /**
   * 一键回退：把备份里的文件**逐个**覆盖回去。
   *
   * 不整目录拷贝、不删当前目录——改写不会新增文件，逐个覆盖最可控；
   * 而且万一用户在这期间又写了别的文件，也不会被备份冲掉。
   */
  function rollback({ backup: dir } = {}) {
    const raw = String(dir || '').trim();
    /**
     * 路径校验要做**规范化之后的前缀比较**，不能直接 `startsWith`：
     * `backupRoot\..\..\Windows` 字面上是以 backupRoot 开头的，
     * 解析完却跑到别处去了。这是个公开路由，能直接 POST。
     */
    const root = raw ? resolve(raw) : '';
    const under = (base) => root === base || root.startsWith(base + sep);
    if (!root || !knownRoots().some(under)) {
      return { ok: false, code: 'INVALID_BACKUP', error: '这不是一键改写生成的备份目录' };
    }
    const manifestFile = join(root, 'manifest.json');
    if (!existsSync(manifestFile)) return { ok: false, code: 'INVALID_BACKUP', error: '备份里没有 manifest.json' };
    const manifest = readJson(manifestFile);
    if (!Array.isArray(manifest.files) || !manifest.files.length) {
      return { ok: false, code: 'INVALID_BACKUP', error: '备份清单是空的' };
    }
    /**
     * 备份必须属于**当前这个数据目录**。
     *
     * 不校验的话，把一份别的目录的备份（或者手改过 manifest 的备份）
     * 回退过来，等于把整个记忆库换成另一份——比删掉还难发现。
     */
    if (String(manifest.dataDir || '') !== dataDir()) {
      return { ok: false, code: 'INVALID_BACKUP', error: '这份备份不属于当前数据目录，拒绝回退' };
    }

    /**
     * **先把所有条目校验完，再动手。**
     *
     * 一边校验一边拷的话，遇到后面那条不合格时，前面的文件已经被覆盖了——
     * 返回「校验失败」却留下半改状态，比直接失败更糟。
     */
    const plan = [];
    for (const f of manifest.files) {
      /**
       * 目标路径**由白名单 + 当前数据目录重新拼**，不采信 manifest 里的绝对路径。
       *
       * manifest 是磁盘上的普通 JSON，能被人改。照着它的 `abs` 写文件
       * 等于把「写任意路径」这个能力开给了一个公开接口。
       */
      const name = basename(String(f.abs || ''));
      if (!BACKUP_FILES.includes(name)) {
        return { ok: false, code: 'INVALID_BACKUP', error: `备份里有不认识的条目：${name}` };
      }
      const isWal = name.endsWith('-wal') || name.endsWith('-shm');
      const src = join(root, name);
      if (!isWal && !existsSync(src)) {
        return { ok: false, code: 'INVALID_BACKUP', error: `备份缺文件：${src}` };
      }
      plan.push({ name, src, target: join(dataDir(), name), isWal });
    }

    closeHandles();

    /**
     * 两阶段恢复：先全部拷到 `.restore.tmp`，都成功了再统一 rename。
     *
     * 回退是**保命路径**。逐文件直接覆盖的话，中途失败（Windows 上数据库
     * 被别的程序打开就是 EBUSY/EPERM）会留下一半恢复、一半改写后的混合状态，
     * 而且异常直接穿出去，调用方连「哪些成了」都拿不到。
     */
    const staged = [];
    const cleanup = () => {
      for (const it of staged) {
        try { rmSync(it.tmp, { force: true }); } catch {}
      }
    };
    for (const it of plan) {
      if (it.isWal) continue;
      try {
        copyFileSync(it.src, `${it.target}.restore.tmp`);
        staged.push({ ...it, tmp: `${it.target}.restore.tmp` });
      } catch (e) {
        cleanup();
        return {
          ok: false,
          code: 'RESTORE_FAILED',
          error: `准备恢复时失败（${e?.message || e}）。原文件一个都没动，先关掉可能占用数据库的程序再点一次`,
          backup: root,
        };
      }
    }

    const restored = [];
    const failed = [];
    for (const it of staged) {
      try {
        renameSync(it.tmp, it.target);
        restored.push(it.target);
      } catch (e) {
        failed.push({ file: it.target, error: String(e?.message || e) });
      }
    }
    /** 残留的 WAL 必须删掉，否则下次 open 会读到它把已 checkpoint 的库覆盖回去 */
    for (const it of plan) {
      if (!it.isWal) continue;
      try { rmSync(it.target, { force: true }); } catch {}
    }

    if (failed.length) {
      cleanup();
      return {
        ok: false,
        code: 'RESTORE_FAILED',
        error: `${failed.length} 个文件没换成功（${failed[0].error}）。已经换好的已生效，剩下的重启 DSH 后再点一次`,
        restored,
        failed,
        backup: root,
      };
    }
    reloadCaches();
    log(`一键改写已回退：${root}（${restored.length} 个文件）`);
    return { ok: true, restored, backup: root, hint: '备份文件已恢复并重新读盘，立即生效。' };
  }

  /** 面板列出可选备份（最近的在前） */
  function listBackups() {
    const out = [];
    for (const root of knownRoots()) {
      /**
       * 不能用 `existsSync` 就 `readdirSync`：备份根被指到一个**文件**时
       * （配置写错、或者 activeRoot 还没退路时的历史状态）会抛 ENOTDIR，
       * 整个 `/account/backups` 直接 500。
       */
      let entries;
      try {
        if (!statSync(root).isDirectory()) continue;
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = join(root, e.name);
        const mf = join(dir, 'manifest.json');
        if (!existsSync(mf)) continue;
        const m = readJson(mf);
        out.push({ dir, at: Number(m.at) || 0, uins: m.uins || [], files: (m.files || []).length });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  return { plan, apply, rollback, listBackups, files };
}
