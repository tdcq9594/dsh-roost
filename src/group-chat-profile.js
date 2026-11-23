/**
 * 阶段6·群印象档案：每个群一小段「气氛 / 常聊什么 / 印象」，独立成文件。
 *
 * 对齐 aurabot `s.chats['group:<id>']` + `/chats/save`：她在某个群待一阵子，
 * 会形成对这个群的印象，面板能看能改。和 profiles（按人）平行，这里按群（chatId）。
 *
 * 设计取舍：
 *   - **不进人格隔离**：和 profiles 一样跨人格共享（数据本身就是"这个群什么样"，
 *     不是"某人格眼里的群"），所以不登记 personaScope PLAN。
 *   - **默认不注入**：只是面板可见的资料，除非有人在 prompt 里显式读它。
 *   - **三字段定长**：气氛/印象各 80 字、常聊什么 120 字，和 profiles 同款 clipChars。
 *   - 用户主动改 → 当场生效，不缓存（无 prompt cache 顾虑，因为默认不注入）。
 */
import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './atomic.js';
import { oneLine } from './memory-line.js';

export const VIBE_MAX = 80;
export const TOPICS_MAX = 120;
export const IMPRESSION_MAX = 80;
export const GROUP_MAX = 50;

export function clip(s, max) {
  const a = Array.from(String(s ?? ''));
  return a.length <= max ? a.join('') : a.slice(0, max).join('');
}

/** 规范化/校验一条群印象的 patch；没有可写字段返回 ok:false */
export function normalizeChatPatch(patch = {}) {
  const fields = ['vibe', 'topics', 'impression'];
  const out = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(patch, f)) continue;
    out[f] = clip(String(patch[f] ?? '').trim(), f === 'topics' ? TOPICS_MAX : IMPRESSION_MAX);
  }
  if (!Object.keys(out).length) return { ok: false, message: '没有要保存的内容' };
  return { ok: true, patch: out };
}

export function createGroupChatProfiles({ file, now = () => Date.now(), max = GROUP_MAX, log = () => {} } = {}) {
  let rows = null;

  function load() {
    if (rows) return rows;
    let all = [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.chats) ? raw.chats : []);
      all = list.filter((r) => r && typeof r === 'object' && String(r.chatId ?? '').trim());
    } catch {
      all = [];
    }
    rows = all.slice(-max);
    return rows;
  }

  function save() {
    try {
      writeJsonAtomic(file, load(), { indent: 0 });
    } catch (e) {
      log(`写群印象失败（不影响聊天）：${e.message}`);
    }
  }

  function keyOf(chatId) {
    return String(chatId ?? '').trim().toLowerCase();
  }

  return {
    /** 面板列表，最近更新在前 */
    recent(limit = 50) {
      const all = [...load()].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
      return limit > 0 ? all.slice(0, limit) : all;
    },

    /** 读一个群 */
    get(chatId) {
      const k = keyOf(chatId);
      if (!k) return null;
      return load().find((r) => keyOf(r.chatId) === k) || null;
    },

    /**
     * 写入/更新群印象（面板编辑 + consolidate 自动生成共用）。
     * @returns {{ok:boolean, message:string}}
     */
    save(chatId, patch = {}) {
      const k = keyOf(chatId);
      if (!k) return { ok: false, message: '缺群 chatId' };
      const n = normalizeChatPatch(patch);
      if (!n.ok) return { ok: false, message: n.message };
      const all = load();
      let row = all.find((r) => keyOf(r.chatId) === k);
      if (!row) {
        if (all.length >= max) all.splice(0, all.length - max + 1);
        row = { chatId: String(chatId).trim() };
        all.push(row);
      }
      Object.assign(row, n.patch);
      row.at = now();
      /** 三字段全空视为清空这个群的印象（不是删行，留着空壳让用户看得见清过） */
      save();
      return { ok: true, message: (n.patch.vibe || n.patch.topics || n.patch.impression) ? '群印象已保存' : '群印象已清空' };
    },

    /** 注入用的一段文本（默认不调用；显式读时才渲染） */
    text({ chatId, limit = 3 } = {}) {
      const list = limit > 0 ? this.recent(limit) : this.recent(0);
      const picked = chatId ? list.filter((r) => keyOf(r.chatId) === keyOf(chatId)) : list;
      if (!picked.length) return '';
      return picked.map((r) => {
        const name = clip(r.name || r.chatId, 24);
        return `· ${oneLine(name)}：${oneLine(clip(r.vibe || '', VIBE_MAX))}`
          + (r.topics ? `（常聊：${oneLine(clip(r.topics, TOPICS_MAX))}）` : '')
          + (r.impression ? `（印象：${oneLine(clip(r.impression, IMPRESSION_MAX))}）` : '');
      }).join('\n');
    },

    clear(chatId) {
      const k = keyOf(chatId);
      const cur = load();
      const next = k ? cur.filter((r) => keyOf(r.chatId) !== k) : [];
      if (next.length === cur.length && k) return false;
      rows = next;
      save();
      return true;
    },
  };
}
