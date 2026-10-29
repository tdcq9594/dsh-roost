/**
 * 记忆：**两层，存在 dsh-roost 这边**。
 *
 * 为什么不在 ai-chat：
 *   1. 情绪要调制记忆（心情差记得更牢），两者必须同处一地
 *   2. 记忆的抽取/摘要/评分都要调模型，ai-chat 4.0.0 之后调不了模型
 *   3. 日记/图谱/向量最终都落在这边，facts 不该另起一处
 *
 * 两层：
 *   global —— 跨群共享（他是谁、经历过什么、约定过什么）
 *   chat   —— 这个群特有（梗、绰号、小圈子关系），**不串场**
 *
 * 存储：`<数据目录>/memory.json`，原子写（.tmp + rename）。形状：
 *
 *   {
 *     "global": ["主人住在杭州"],                 ← 事实正文，**永远是字符串数组**
 *     "chats":  { "g1": ["这个群管阿离叫小离"] },
 *     "meta":   { "global": { "主人住在杭州": { "w": 2, "at": 1750000000000, "src": {...} } },
 *                 "chats":  { "g1": { "…": {…} } } },
 *     "personas": {...}, "authz": {...}
 *   }
 *
 * 为什么权重和出处**另开 meta，不把 facts 变成对象数组**：
 *   老版本的 `load()` 只认字符串（`filter(x => typeof x === 'string')`），
 *   一旦把 `global` 写成 `[{text:…}]`，降级回旧版就会**静默丢掉全部事实**——
 *   文件还在、内容也在，只是看不见。meta 是并行字段，老版本忽略它照常工作。
 *   代价是元数据以**文本**为 key：同一句话在不同群共用一份。
 *   实际无影响——文本相同就是同一条事实，而且我们从不改写已存的文本。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

/** 一条最多 200 字，每层最多 40 条（比原来的 20 条放宽，跨群后量会涨） */
const FACT_MAX = 200;
const FACTS_MAX = 40;

/** 权重的天花板：同一件事被反复提到会加分，但别让它无限涨 */
const W_MAX = 5;
/** 重复被提到 / 被用到时加多少 */
const W_BUMP = 0.5;
/** 用户（或她自己）明确说「记住」的权重；巩固抽出来的按 1 算 */
export const W_EXPLICIT = 2;
/** 权重的时间半衰期（天）：30 天没被提到的，分量减半 */
const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * 一条事实「该不该留」的分数：重要度 × 时间衰减。
 *
 * 没有元数据（老数据）时按 `w=1`、不衰减算 —— 于是全部同分，淘汰退化成
 * 「最旧的先走」，**跟加权重之前的行为完全一致**。
 * 这是刻意的：升级不该悄悄改变已有库的淘汰顺序。
 */
export function scoreOfFact(meta, now = Date.now()) {
  const w = Number(meta?.w) > 0 ? Number(meta.w) : 1;
  const at = Number(meta?.at) || 0;
  const days = at ? Math.max(0, (now - at) / DAY_MS) : 0;
  return w * 0.5 ** (days / HALF_LIFE_DAYS);
}

/**
 * 事实的出处，**统一在这里收口**。
 *
 * 为什么要一个收口函数：`src` 是从消息 payload 来的（`payload.id` / `payload.eventIds`），
 * 一路写进 `memory.json` 长期存着。不收口的话，一个畸形 payload 就能把
 * 几千个 event id 灌进每条事实里，文件悄悄涨到几十 MB，而没有任何一处会报错。
 *
 * 形状（都可有可无，全空就当没有出处）：
 *   journalId  这一轮对应的日记行 id（= 消息 id），拿它调 `/r/context?aroundId=` 能翻回原文
 *   eventIds   事件账本里的那几条（合并批是多条）
 *   at         记下这条的时间
 *   manual     面板上手动记的（人手写的，没有消息来源）
 *   by         谁记的（现在只有 'owner'）
 *
 * @returns {object|null} 清理过的出处；没有任何有效字段时返回 null（不存 `{}`）
 */
export function normalizeSrc(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};

  const s = (v, max) => {
    const t = String(v ?? '').trim().slice(0, max);
    return t || '';
  };

  const journalId = s(raw.journalId, 120);
  if (journalId) out.journalId = journalId;

  if (Array.isArray(raw.eventIds)) {
    const ids = [...new Set(raw.eventIds.map((x) => s(x, 120)).filter(Boolean))].slice(0, 50);
    if (ids.length) out.eventIds = ids;
  }

  const at = Number(raw.at);
  if (Number.isFinite(at) && at > 0) out.at = at;

  if (raw.manual === true) out.manual = true;
  const by = s(raw.by, 20);
  if (by) out.by = by;

  return Object.keys(out).length ? out : null;
}

export function createMemory({ now = () => Date.now() } = {}) {
  const file = () => join(dataDir(), 'memory.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    let raw = {};
    try {
      raw = JSON.parse(readFileSync(file(), 'utf8')) || {};
    } catch {
      raw = {};
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};

    /**
     * **从 `raw` 展开**，不是从空对象重建。
     *
     * 以前这里是 `cache = { global, chats, personas }`，白名单漏了 `authz`：
     * 重启后读不到授权，而下一次 `save()` 还会把盘上那段**抹掉**——
     * 表现是「重启一次群主动就永久失效」，面板上看不出任何异常。
     * 展开 raw 之后，别处写进来的字段（现在和以后的）都不会被白名单吃掉。
     */
    cache = {
      ...raw,
      global: Array.isArray(raw.global) ? raw.global.filter((x) => typeof x === 'string' && x) : [],
      chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
      meta: {
        global: meta.global && typeof meta.global === 'object' ? meta.global : {},
        chats: meta.chats && typeof meta.chats === 'object' ? meta.chats : {},
      },
      /**
       * 按群的人设覆盖（模型用 `<<persona: 内容>>` 写）。
       *
       * 为什么放这儿：人格以前在 ai-chat 有一份 500 字的碎文本，
       * 跟这边的 `personas/*.md` 打架。现在只留一处——
       * 覆盖优先于 personas 文件，清掉就回到文件里那个人格。
       */
      personas: raw.personas && typeof raw.personas === 'object' ? raw.personas : {},
    };
    return cache;
  }

  function save() {
    const m = load();
    try {
      mkdirSync(dataDir(), { recursive: true });
      const tmp = file() + '.tmp';
      writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf8');
      renameSync(tmp, file()); // 原子替换，断电不会留半个文件
    } catch {
      /* 写不进去就算了，不能因为存记忆把这一轮弄挂 */
    }
  }

  const clean = (f) => String(f ?? '').trim().slice(0, FACT_MAX);

  /**
   * 往一层里放一条，必要时按分数淘汰。
   *
   * @param {string[]} list
   * @param {object} metaMap 这一层的元数据（会被就地修改）
   * @param {string} fact
   * @param {{w?:number, src?:object, at?:number}} [opts]
   * @returns {string[]} 新的列表
   */
  function addInto(list, metaMap, fact, opts = {}) {
    const f = clean(fact);
    if (!f) return list;
    const t = Number(opts.at) > 0 ? Number(opts.at) : now();
    const old = metaMap[f];
    // 收口在这里：所有写入路径（模型标记、面板手记、以后新增的）都过一遍
    const src = normalizeSrc(opts.src);

    if (list.includes(f)) {
      /**
       * 又提了一次同一件事 —— 加权重，不加条目。
       *
       * 反复被提到的才是他真正在意的事。这比单纯按时间排队更接近人怎么记东西：
       * 「我生日是三月五号」被说过五次，不该因为今天新记了五条杂事就被挤掉。
       */
      metaMap[f] = {
        ...old,
        w: Math.min(W_MAX, (Number(old?.w) > 0 ? Number(old.w) : 1) + W_BUMP),
        at: t,
        src: src || old?.src || null,
      };
      return list;
    }

    list.push(f);
    metaMap[f] = { w: Number(opts.w) > 0 ? Number(opts.w) : 1, at: t, src };
    if (list.length <= FACTS_MAX) return list;

    /**
     * 超了：按分数留前 40 条，同分时**新的优先**。
     *
     * 同分新的优先，是为了让没有元数据的老库表现跟以前（FIFO）一模一样——
     * 升级不该顺手把人家存了很久的事换一批。
     */
    const scored = list
      .map((text, i) => ({ text, i, s: scoreOfFact(metaMap[text], t) }))
      .sort((a, b) => b.s - a.s || b.i - a.i);
    const keep = new Set(scored.slice(0, FACTS_MAX).map((x) => x.text));
    for (const text of list) if (!keep.has(text)) delete metaMap[text];
    return list.filter((text) => keep.has(text));
  }

  return {
    /** 读两层（正文）。签名不变——注入路径和面板都按字符串用 */
    list(chatId) {
      const m = load();
      return {
        global: [...m.global],
        chat: Array.isArray(m.chats?.[chatId]) ? [...m.chats[chatId]] : [],
      };
    },

    /**
     * 带权重和出处的版本（面板、调试用）。
     *
     * 单独开一个方法而不是让 `list()` 返回对象：`list()` 有四处调用点，
     * 全都要跟着改的话，漏一处就是「注入里出现 `[object Object]`」。
     */
    listFull(chatId) {
      const m = load();
      const one = (list, mm) =>
        (Array.isArray(list) ? list : []).map((text) => {
          const x = mm?.[text] || {};
          return {
            text,
            w: Number(x.w) > 0 ? Number(x.w) : 1,
            at: Number(x.at) || 0,
            src: x.src || null,
          };
        });
      return {
        global: one(m.global, m.meta.global),
        chat: one(m.chats?.[chatId], m.meta.chats?.[chatId]),
      };
    },

    /**
     * 记一条。
     *
     * @param {'global'|'chat'} scope 默认 global —— 用户说"记住 XX"多半是关于他自己
     * @param {{w?:number, src?:{journalId?:string, eventIds?:string[], at?:number}, at?:number}} [opts]
     */
    add(chatId, fact, scope = 'global', opts = {}) {
      const m = load();
      if (scope === 'chat') {
        if (!chatId) return false;
        const cur = Array.isArray(m.chats[chatId]) ? m.chats[chatId] : [];
        const mm = (m.meta.chats[chatId] = m.meta.chats[chatId] || {});
        m.chats[chatId] = addInto(cur, mm, fact, opts);
      } else {
        m.global = addInto(m.global, m.meta.global, fact, opts);
      }
      save();
      return true;
    },

    /**
     * 这条事实被用上了（注入进提示词、这一轮也确实回了话）——加一点权重。
     *
     * 不记的话，权重只反映"被说过几次"，不反映"被用到过几次"：
     * 一条一直有用的事实会被一直没用的新事实挤掉。
     *
     * @returns {number} 加到了几条
     */
    touch(chatId, texts, scope = 'global') {
      const m = load();
      const mm = scope === 'chat' ? m.meta.chats?.[chatId] : m.meta.global;
      if (!mm) return 0;
      const t = now();
      let n = 0;
      for (const text of Array.isArray(texts) ? texts : [texts]) {
        const k = String(text ?? '');
        if (!mm[k]) continue;
        mm[k] = {
          ...mm[k],
          w: Math.min(W_MAX, (Number(mm[k].w) > 0 ? Number(mm[k].w) : 1) + W_BUMP),
          at: t,
        };
        n += 1;
      }
      if (n) save();
      return n;
    },

    /** 按关键词删，两层都搜；返回删掉几条 */
    remove(chatId, word) {
      const w = String(word ?? '').trim();
      if (!w) return 0;
      const m = load();
      let n = 0;

      /** 删正文的同时删元数据 —— 不然再记一次同样的内容会"继承"旧权重 */
      const drop = (list, mm) => {
        const gone = list.filter((f) => f.includes(w));
        for (const f of gone) delete mm[f];
        return list.filter((f) => !f.includes(w));
      };

      const g0 = m.global.length;
      m.global = drop(m.global, m.meta.global);
      n += g0 - m.global.length;

      if (chatId && Array.isArray(m.chats[chatId])) {
        const c0 = m.chats[chatId].length;
        m.chats[chatId] = drop(m.chats[chatId], (m.meta.chats[chatId] = m.meta.chats[chatId] || {}));
        n += c0 - m.chats[chatId].length;
      }
      if (n) save();
      return n;
    },

    /** 清本群层，不动全局 */
    clearChat(chatId) {
      const m = load();
      if (chatId && m.chats[chatId]) {
        delete m.chats[chatId];
        delete m.meta.chats[chatId];
        save();
      }
    },

    /** 清全局（等于让它忘掉所有跨群的事） */
    clearGlobal() {
      const m = load();
      m.global = [];
      m.meta.global = {};
      save();
    },

    /** 这个群的人设覆盖（没有就返回空串，回落到 personas/*.md） */
    getPersonaOverride(chatId) {
      if (!chatId) return '';
      const m = load();
      return String(m.personas?.[chatId]?.text ?? '');
    },

    /** 设/清这个群的人设覆盖。传空串就是清掉。 */
    setPersonaOverride(chatId, text) {
      if (!chatId) return;
      const m = load();
      const t = String(text ?? '').trim().slice(0, 500);
      if (!t) delete m.personas[chatId];
      else m.personas[chatId] = { text: t, at: Date.now() };
      save();
    },

    /**
     * 记一条授权（`c2c_push` / `group_push`）。
     *
     * 为什么要记：**群主动消息必须有 `group_push` 授权**，
     * 这是比限频更根本的前置。没这条记录，C7 群聊主动一发就失败。
     */
    setAuthz(chatId, scope, extra = {}) {
      if (!chatId || !scope) return;
      const m = load();
      if (!m.authz || typeof m.authz !== 'object') m.authz = {};
      m.authz[chatId] = { scope, at: Date.now(), ...extra };
      save();
    },

    /** 查这个会话有没有某个授权 */
    hasAuthz(chatId, scope) {
      const m = load();
      const a = m.authz?.[chatId];
      return Boolean(a && (!scope || a.scope === scope));
    },

    /**
     * 这个会话的授权记录，给面板看。
     *
     * 以前只有 `hasAuthz` 这种问句形式，面板拿不到「是什么授权、什么时候给的」，
     * 于是群主动搭话的门槛在界面上完全看不见——用户只知道「群里她不说话」。
     */
    authz(chatId) {
      const m = load();
      const a = chatId ? m.authz?.[chatId] : null;
      if (!a) return null;
      return { scope: String(a.scope || ''), at: Number(a.at || 0), type: a.type, optScene: a.optScene };
    },

    /**
     * 从旧版本（记忆还放在 ai-chat 时）导入。
     * 幂等：重复导入不会产生重复条目（addInto 会去重）。
     */
    import({ global: g = [], chats = {} } = {}) {
      const m = load();
      let n = 0;
      for (const f of Array.isArray(g) ? g : []) {
        const before = m.global.length;
        m.global = addInto(m.global, m.meta.global, f);
        if (m.global.length > before) n += 1;
      }
      for (const [cid, list] of Object.entries(chats ?? {})) {
        if (!cid || !Array.isArray(list)) continue;
        const cur = Array.isArray(m.chats[cid]) ? m.chats[cid] : [];
        const mm = (m.meta.chats[cid] = m.meta.chats[cid] || {});
        for (const f of list) {
          const before = cur.length;
          const next = addInto(cur, mm, f);
          if (next.length > before) n += 1;
          m.chats[cid] = next;
        }
      }
      save();
      return n;
    },
  };
}
