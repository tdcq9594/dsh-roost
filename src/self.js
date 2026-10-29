/**
 * 自我叙述（第五层 / selfNote）：**她写自己，不是写用户**。
 *
 * 为什么单独一层：
 *   facts 和日记回答的是「他是谁、发生过什么」，那是**关于用户的**。
 *   这一层回答的是「我最近怎么样、我错在哪、我改了什么」，是**关于她自己的**。
 *   没有这一层，换一个新会话，她只能靠人格文件重新扮演一遍——
 *   演得再像，也不是"接着上次的自己往下活"。
 *
 * 三条硬规则：
 *
 *   1. **写是定期的，读是稀有的。**
 *      写入由巩固按天做（当天她自己说得够多，或者被纠正过），读取只在会话边界
 *      （新会话第一轮 / 压缩后的开场）和深度重注时各读一点。
 *      **每轮都灌 = 洗脑**：模型会为了跟自述一致而表演，而不是自然地活着。
 *
 *   2. **只写自己，不写对方。**
 *      自述里出现「他最近很烦」就变成了第二本日记，而且它会和 facts 打架。
 *      prompt 里明说，`forget()` 也会扫这一层——用户要求忘掉的事，
 *      不该在这里换个说法继续存在。
 *
 *   3. **归档不是删除。**
 *      超过 20 条时最旧的 5 条压成一段「阶段自述」，阶段自述也有上限。
 *      这跟日记的「压不是删」是同一条铁律：变抽象，不是消失。
 *
 * 存储：`<数据目录>/self.json`，原子写。不放 journal —— `byDay()` 没有
 * kind 过滤，自述会被当成聊天记录再喂回巩固，形成自我强化的回音。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

/** 一条自述最多多少字 */
const NOTE_MAX = 200;
/** 最多留几条「日自述」，超了往阶段自述压 */
const MAX_NOTES = 20;
/** 阶段自述最多留几段 */
const MAX_CHAPTERS = 12;
/** 每次压几条 */
const BATCH = 5;

/**
 * 「被纠正」的判据。
 *
 * 放在这里而不是 consolidate：写入侧（巩固）和读取侧（调试接口）
 * 都可能要用，两处各写一份必然漂。
 *
 * 故意宽松：误判的代价是自述里多一句「今天被纠正了」，
 * 漏判的代价是**她永远不知道自己错在哪**。宁可多认几次。
 */
export const RE_CORRECTION = /不对|不是这样|不是这个|你记错|记错了|说错|搞错|别这么说|理解错/;

/**
 * 今天的素材够不够写一条自述（按量那一半）。
 *
 * 她自己说了 20 条以上，说明这天确实在认真聊。
 * 冷清的一天硬写一条「今天没说什么」，只是往库里灌水。
 *
 * **但这不是唯一入口**：被纠正过的日子，话再少也要写（见 consolidate 的 writeSelf）。
 */
export const MIN_BOT_LINES = 20;

const dayOf = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const mmdd = (day) => String(day || '').slice(5);

export function createSelf({ log = () => {}, now = () => Date.now() } = {}) {
  const file = () => join(dataDir(), 'self.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      cache = {
        notes: Array.isArray(raw?.notes) ? raw.notes.filter((n) => n && n.text) : [],
        chapters: Array.isArray(raw?.chapters) ? raw.chapters.filter((c) => c && c.text) : [],
      };
    } catch {
      cache = { notes: [], chapters: [] };
    }
    return cache;
  }

  function save() {
    try {
      mkdirSync(dataDir(), { recursive: true });
      const tmp = file() + '.tmp';
      writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
      renameSync(tmp, file()); // 原子替换，断电不会留半个文件
    } catch (e) {
      log(`自述存不下来：${e.message}`);
    }
  }

  /**
   * 超限就往阶段自述压。
   *
   * **不调模型**：这一步只做机械合并（首句拼接 + 日期范围），
   * 它的作用是「别让文件无限长」，不是「写得更深刻」。
   * 真要让阶段自述更凝练，那是另一次模型调用的事，不该藏在 prune 里。
   */
  function distill() {
    const m = load();
    let changed = false;

    while (m.notes.length > MAX_NOTES) {
      const batch = m.notes.splice(0, BATCH);
      m.chapters.push({
        at: now(),
        from: String(batch[0].day || ''),
        to: String(batch[batch.length - 1].day || ''),
        text: batch.map((n) => String(n.text).trim()).join('；').slice(0, 400),
      });
      changed = true;
    }

    while (m.chapters.length > MAX_CHAPTERS) {
      const batch = m.chapters.splice(0, 3);
      m.chapters.push({
        at: now(),
        from: String(batch[0].from || ''),
        to: String(batch[batch.length - 1].to || ''),
        text: batch.map((c) => String(c.text).trim()).join('；').slice(0, 500),
      });
      changed = true;
    }

    if (changed) save();
  }

  return {
    /**
     * 记一条自述。
     *
     * 同一天重复写会**覆盖**当天那条，而不是堆两条——
     * 巩固可能因为重跑/补跑再写一次，堆起来会让自述变成流水账。
     * @returns {{ok:boolean, why?:string}}
     */
    add({ text, day = '', at = 0, kind = 'daily' } = {}) {
      const t = String(text ?? '').trim().slice(0, NOTE_MAX);
      if (!t) return { ok: false, why: '空的' };
      const ts = Number(at) || now();
      const d = String(day || dayOf(ts));
      const m = load();

      const i = m.notes.findIndex((n) => n.day === d && n.kind === kind);
      const rec = { at: ts, day: d, text: t, kind };
      if (i >= 0) m.notes[i] = rec;
      else m.notes.push(rec);
      m.notes.sort((a, b) => a.at - b.at);

      save();
      distill();
      return { ok: true };
    },

    /** 最近 n 条，按时间正序 */
    recent(n = 3) {
      const m = load();
      const k = Math.max(1, Number(n) || 3);
      return m.notes.slice(-k).map((x) => ({ ...x }));
    },

    /**
     * 注入用的一段话。没有就返回空串——**不要注入「还没有自述」这种废话**。
     *
     * 措辞刻意区分于记忆块：这是她自己写的，不是别人对她的评价。
     * 不这么说的话，模型会把它当成"用户对我的设定"，然后照着演。
     */
    text(n = 3) {
      const m = load();
      const k = Math.max(1, Number(n) || 3);
      const notes = m.notes.slice(-k);
      if (!notes.length) return '';
      return [
        '【你自己最近写下的】（这些是你自己写的，不是别人对你的评价）',
        ...notes.map((x) => `· ${mmdd(x.day)} ${x.text}`),
      ].join('\n');
    },

    /**
     * 用户要求忘掉某件事时，这一层也要扫。
     *
     * 只抹含关键词的那几条：整条置空会让自述断档，
     * 而「自述里还留着他说别记的事」是最伤信任的一种漏。
     * @returns {number} 抹掉几条
     */
    forget(word) {
      const w = String(word ?? '').trim();
      if (!w) return 0;
      const m = load();
      let n = 0;
      for (const note of m.notes) {
        if (!note.text.includes(w)) continue;
        note.text = '（已按用户要求遗忘）';
        n += 1;
      }
      for (const c of m.chapters) {
        if (!String(c.text).includes(w)) continue;
        c.text = '（已按用户要求遗忘）';
        n += 1;
      }
      if (n) save();
      return n;
    },

    /** 清空（面板用，慎用） */
    clear() {
      cache = { notes: [], chapters: [] };
      save();
    },

    all() {
      const m = load();
      return { notes: m.notes.map((x) => ({ ...x })), chapters: m.chapters.map((x) => ({ ...x })) };
    },

    stats() {
      const m = load();
      return {
        notes: m.notes.length,
        chapters: m.chapters.length,
        firstAt: m.notes[0]?.at || 0,
        lastAt: m.notes[m.notes.length - 1]?.at || 0,
      };
    },
  };
}
