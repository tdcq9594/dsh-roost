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
 * 存储：`<数据目录>/memory.json`，结构简单、原子写（.tmp + rename）。
 * 现在只有 facts；日记/图谱/向量后续加字段，不换文件。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

/** 一条最多 200 字，每层最多 40 条（比原来的 20 条放宽，跨群后量会涨） */
const FACT_MAX = 200;
const FACTS_MAX = 40;

export function createMemory() {
  const file = () => join(dataDir(), 'memory.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      cache = {
        global: Array.isArray(raw?.global) ? raw.global.filter((x) => typeof x === 'string' && x) : [],
        chats: raw?.chats && typeof raw.chats === 'object' ? raw.chats : {},
        /**
         * 按群的人设覆盖（模型用 `<<persona: 内容>>` 写）。
         *
         * 为什么放这儿：人格以前在 ai-chat 有一份 500 字的碎文本，
         * 跟这边的 `personas/*.md` 打架。现在只留一处——
         * 覆盖优先于 personas 文件，清掉就回到文件里那个人格。
         */
        personas: raw?.personas && typeof raw.personas === 'object' ? raw.personas : {},
      };
    } catch {
      cache = { global: [], chats: {}, personas: {} };
    }
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

  function pushInto(list, fact) {
    const f = clean(fact);
    if (!f) return list;
    if (!list.includes(f)) list.push(f);
    return list.length > FACTS_MAX ? list.slice(-FACTS_MAX) : list;
  }

  return {
    /** 读两层 */
    list(chatId) {
      const m = load();
      return {
        global: [...m.global],
        chat: Array.isArray(m.chats?.[chatId]) ? [...m.chats[chatId]] : [],
      };
    },

    /**
     * 记一条。
     * @param {'global'|'chat'} scope 默认 global —— 用户说"记住 XX"多半是关于他自己
     */
    add(chatId, fact, scope = 'global') {
      const m = load();
      if (scope === 'chat') {
        if (!chatId) return false;
        m.chats[chatId] = pushInto(Array.isArray(m.chats[chatId]) ? m.chats[chatId] : [], fact);
      } else {
        m.global = pushInto(m.global, fact);
      }
      save();
      return true;
    },

    /** 按关键词删，两层都搜；返回删掉几条 */
    remove(chatId, word) {
      const w = String(word ?? '').trim();
      if (!w) return 0;
      const m = load();
      let n = 0;
      const before = m.global.length;
      m.global = m.global.filter((f) => !f.includes(w));
      n += before - m.global.length;
      if (chatId && Array.isArray(m.chats[chatId])) {
        const b2 = m.chats[chatId].length;
        m.chats[chatId] = m.chats[chatId].filter((f) => !f.includes(w));
        n += b2 - m.chats[chatId].length;
      }
      if (n) save();
      return n;
    },

    /** 清本群层，不动全局 */
    clearChat(chatId) {
      const m = load();
      if (chatId && m.chats[chatId]) {
        delete m.chats[chatId];
        save();
      }
    },

    /** 清全局（等于让它忘掉所有跨群的事） */
    clearGlobal() {
      const m = load();
      m.global = [];
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
     * 从旧版本（记忆还放在 ai-chat 时）导入。
     * 幂等：重复导入不会产生重复条目（pushInto 会去重）。
     */
    import({ global: g = [], chats = {} } = {}) {
      const m = load();
      let n = 0;
      for (const f of Array.isArray(g) ? g : []) {
        const before = m.global.length;
        m.global = pushInto(m.global, f);
        if (m.global.length > before) n += 1;
      }
      for (const [cid, list] of Object.entries(chats ?? {})) {
        if (!cid || !Array.isArray(list)) continue;
        const cur = Array.isArray(m.chats[cid]) ? m.chats[cid] : [];
        for (const f of list) {
          const before = cur.length;
          const next = pushInto(cur, f);
          if (next.length > before) n += 1;
          m.chats[cid] = next;
        }
      }
      save();
      return n;
    },
  };
}
