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
 *     "meta":   { "global": { "主人住在杭州": { "w": 2, "at": 1750000000000, "src": {...},
 *                                              "until": 1750000000000 } },
 *                 "chats":  { "g1": { "…": {…} } } },
 *     "personas": {...}, "authz": {...}
 *   }
 *
 * `until` 有值 = 这条说法**被后来的说法取代了**（「搬到上海」之后的「住在杭州」）。
 * 不删，只打时间戳，和 `graph.js` 的双时态一个路子：注入只取活的，
 * 面板还看得见历史。没有 `until` 的老数据一律当活的。
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
 *
 * 被取代的说法（有 `until`）打个折：它们**不参与注入**，却仍占那 40 个
 * 名额。不打折的话，一条 w=2 的旧说法会长期压着新事实，把活的名额挤掉。
 */
export function scoreOfFact(meta, now = Date.now()) {
  const w = Number(meta?.w) > 0 ? Number(meta.w) : 1;
  const at = Number(meta?.at) || 0;
  const days = at ? Math.max(0, (now - at) / DAY_MS) : 0;
  const base = w * 0.5 ** (days / HALF_LIFE_DAYS);
  return meta?.until ? base * HISTORY_WEIGHT : base;
}

/**
 * 取代判定的相似度阈值（字符二元组 Jaccard）。
 *
 * 0.75 是**保守**值，只在"同一句话改了个尾巴"时触发：
 *   「主人住在杭州」vs「主人住在杭州市」         → 0.83 ✓ 取代
 *   「主人对花生过敏」vs「主人对花生过敏，严重」  → 0.75 ✓ 取代
 *   「主人养了猫」vs「主人养了狗」               → 0.43 ✗ 两条都留
 *   「主人在杭州工作」vs「主人住在杭州」          → 0.50 ✗ 两件事
 *
 * 宁可漏判（两条都留着，模型自己挑），不要误判（把不同的事当成改口抹掉）。
 */
const SUPERSEDE_SIM = 0.75;
/** 太短的文本不做取代判定：两三个字的二元组太少，比例没有意义 */
const SUPERSEDE_MIN_LEN = 4;
/** 已取代（历史）的分数折扣，见 `scoreOfFact` */
const HISTORY_WEIGHT = 0.5;

/**
 * 字符二元组。
 *
 * 中文没有空格，按字切比按词切稳 —— 不需要分词表，也不受"未登录词"影响。
 * 代价是它只看字面：语义改口（「搬到上海」vs「住在杭州」）它抓不到，
 * 那类要靠模型判定，别指望调阈值调出来。
 */
export function bigramsOf(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

/** 两句话有多像（0~1）。Jaccard：不看顺序、不看长度 */
export function similarityOf(a, b) {
  const A = bigramsOf(a);
  const B = bigramsOf(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
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

    /**
     * 同槽位取代：这次记的和某条旧说法几乎是同一句，就给旧的打 `until`。
     *
     * 为什么要有：没有它，「主人住在杭州」和「主人住在杭州市」会同时留在
     * 库里、同时注入，白占两个名额，模型还得自己挑一条。
     *
     * 判定**故意用字面相似度**、不调模型：
     *   · 它只抓"同一句改了个尾巴"这一类，抓不到「搬到上海」那种语义改口
     *     —— 那是另一件事，要模型判定，不是调阈值能解决的；
     *   · 好处是零成本、可测、当场生效，而且宁漏不误（阈值 0.75）。
     *
     * 旧条目**不删**，只打时间戳（和 `graph.js` 的双时态一个路子）：
     * 面板还看得见历史，注入只取活的。
     */
    const supersede = () => {
      if (f.length < SUPERSEDE_MIN_LEN) return;
      for (const other of list) {
        if (other === f) continue;
        const om = metaMap[other];
        if (om?.until) continue; // 已经是历史了，不重复打
        if (other.length < SUPERSEDE_MIN_LEN) continue;
        if (similarityOf(other, f) < SUPERSEDE_SIM) continue;
        metaMap[other] = { ...om, until: t };
      }
    };

    if (list.includes(f)) {
      /**
       * 又提了一次同一件事 —— 加权重，不加条目。
       *
       * 反复被提到的才是他真正在意的事。这比单纯按时间排队更接近人怎么记东西：
       * 「我生日是三月五号」被说过五次，不该因为今天新记了五条杂事就被挤掉。
       *
       * 如果这条**自己**已经是历史（被后来的说法取代过），这次重提就是
       * 重新确认 —— 把 `until` 清掉，让它回到活的那一批。
       */
      const next = {
        ...old,
        w: Math.min(W_MAX, (Number(old?.w) > 0 ? Number(old.w) : 1) + W_BUMP),
        at: t,
        src: src || old?.src || null,
      };
      if (next.until) next.until = null;
      metaMap[f] = next;
      supersede();
      return list;
    }

    list.push(f);
    metaMap[f] = { w: Number(opts.w) > 0 ? Number(opts.w) : 1, at: t, src };
    supersede();
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
    /**
     * 读两层（正文）。签名不变——注入路径和面板都按字符串用。
     *
     * **只返回活的**：被取代的说法（`meta.until` 有值）不进这里。
     * 默认安全优先 —— 谁拿 `list()` 去拼提示词都不会把历史说法带进去。
     * 要看历史的用 `listFull()`。
     */
    list(chatId) {
      const m = load();
      const alive = (arr, mm) =>
        (Array.isArray(arr) ? arr : []).filter((text) => !mm?.[text]?.until);
      return {
        global: alive(m.global, m.meta.global),
        chat: alive(m.chats?.[chatId], m.meta.chats?.[chatId]),
      };
    },

    /**
     * 按「重要度 × 时间衰减」排序的正文，**注入用这个**。
     *
     * 为什么不能再用 `list().slice(-N)`：数组是插入序，取尾部等于取
     * "最近记的"，跟权重毫无关系。一条被反复强调（w=5）的事只要最近
     * 没人再提，就永久沉在数组前段——平时那 6 个名额永远轮不到它，
     * 只有每 15 轮的 deep 才可能露一次。权重于是只服务于淘汰，
     * "记得牢"的那半根本没接上。
     *
     * 排序键和 `addInto` 的淘汰排序**必须一致**（`b.s - a.s || b.i - a.i`）：
     * 否则"留得下"和"看得见"是两套口径，会出现"它还在库里，但你永远
     * 看不到它"这种最难查的状态。
     *
     * 深度重注（deep）也用这个顺序，但**不截断**：全量照给，只是让
     * `fitBudget` 万一要砍时，砍掉的是分数低的尾巴而不是最新的几条。
     *
     * 历史（`until`）不参与排序：它不注入，排进来只会白占名额。
     */
    listRanked(chatId) {
      const m = load();
      const t = now();
      const rank = (list, mm) =>
        (Array.isArray(list) ? list : [])
          .filter((text) => !mm?.[text]?.until)
          .map((text, i) => ({ text, i, s: scoreOfFact(mm?.[text], t) }))
          .sort((a, b) => b.s - a.s || b.i - a.i)
          .map((x) => x.text);
      return {
        global: rank(m.global, m.meta.global),
        chat: rank(m.chats?.[chatId], m.meta.chats?.[chatId]),
      };
    },

    /**
     * 带权重、出处和**历史**的版本（面板、调试用）。
     *
     * 单独开一个方法而不是让 `list()` 返回对象：`list()` 有四处调用点，
     * 全都要跟着改的话，漏一处就是「注入里出现 `[object Object]`」。
     *
     * `until` 有值 = 这条被后来的说法取代了，仍然留着但不注入。
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
            until: Number(x.until) > 0 ? Number(x.until) : null,
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
     * 这里原本有个 `touch()`：注入进提示词、这一轮又确实回了话，就给
     * 这条事实 +0.5 权重。**故意删掉的，别加回来。**
     *
     * 两个理由：
     *   1. 它从写下来那天起就**没有任何生产调用点**（只有测试调过），
     *      注释却写得像在生效 —— 比没有这个方法更误导。
     *   2. 语义现在是错的。`listRanked` 让"被注入"直接影响"下次还注不注"，
     *      再叠一层"被注入就加分"，就是注入即加冕：越常被注入的越容易被
     *      注入，列表冻结，再也换不出一批新的。
     *
     * 同一个坑在日记那边踩过并锁死了：`journal.js` 的 `accessed`
     * **只由检索写入，自动注入不算**，`test/memory.test.js` 有断言。
     * facts 走同一条结论 —— **自己读到、自己整理，不强化**。
     */

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
