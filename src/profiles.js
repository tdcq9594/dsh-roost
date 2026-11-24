/**
 * D7 人物小档案：**对一个人的印象 + 怎么跟他相处**，跨群、独立成文件。
 *
 * 和 facts / journal 的区别（这是它必须独立的原因）：
 *   - facts 记「什么事」（按会话 + 全局分层），journal 记「谁说过什么」；
 *   - 这里记「**这个人是什么样的、跟他聊要注意什么**」，按人聚合，跨群共用。
 *   混进 facts 会被 `addInto()` 按字面相似度误合并，混进 journal 会被巩固写成
 *   摘要再注入回来，变成自己跟自己的回音。
 *
 * 两条硬约束（报告 §15.1-D / 交接 §3④）：
 *
 * 1. **进稳定段，但天级才重写**。system prompt 每个请求都重发，一变就整段
 *    prompt cache 失效。所以 `text()` 按「日期」缓存渲染结果：同一天里不管写
 *    多少次档案，注入文本都不动；跨天才重算。`clear()` 是例外——用户主动清了
 *    就不能再注入旧内容，缓存当场作废（隐私优先于缓存命中率）。
 * 2. **群成员键走 openid + aliasesOf**。openid 每个 AppID 一套，换机器人全变；
 *    `aliasesOf(chatId)` 给出的别名表里第一个是稳定主 openid。命中任一别名就
 *    归到主 openid，否则才退回显示名。这样换号之后档案不会裂成两个人。
 *
 * 隐私：内容来自模型提炼，可能带主观判断。注入块第一行明令「只是印象、别原样
 * 念出来、别把别处的事当这个群发生过」；面板能只读查看 + 独立 `profiles.clear`，
 * 按契约**不挂** `memory.clear`（跨群档案，清某一个会话不该抹掉所有人的档案）。
 */
import { readFileSync } from 'node:fs';

import { writeJsonAtomic } from './atomic.js';
/** 注入前压成单行——理由见 `memory-line.js` 的 `oneLine()`：正文里一个换行
 *  就能在注入块里伪造出一个段落标题。档案是模型写的，一样会带换行。 */
import { oneLine } from './memory-line.js';

export const PROFILE_MAX = 50;
export const IMPRESSION_MAX = 80;
export const TIPS_MAX = 120;
/** G7：说话方式/性格（对齐 aurabot profileFieldChars=40；handle 沿用我方 tips=怎么相处） */
export const STYLE_MAX = 40;
export const PERSONA_MAX = 40;
/** E4：讨厌/雷区。比印象更敏感——只在模型明确提炼到才写，渲染时单独标"别踩" */
export const DISLIKES_MAX = 80;
export const PROFILE_LINES_MAX = 3;
/**
 * 人物墙人工标签（对齐 aurabot /persona/person/save）：最多 8 个、每个 8 字。
 * '喜欢'/'讨厌' 是一对互斥的特殊标签（面板可一键打），其余自由填。
 * 主人不能被打'讨厌'——和对方同一条护栏。
 */
export const PERSON_TAGS_MAX = 8;
export const PERSON_TAG_LEN = 8;
export const SPECIAL_TAGS = Object.freeze(['喜欢', '讨厌']);

/** 按码点截，别把 emoji 的 surrogate pair 切一半（budget.js 的 clipForBudget 同款顾虑） */
export function clipChars(s, max) {
  const a = Array.from(String(s ?? ''));
  return a.length <= max ? a.join('') : a.slice(0, max).join('');
}

/** 本地日历日。凌晨 4 点巩固时，UTC 日期还停在昨天，不能用 toISOString() */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 人的稳定键。
 * @param {string} who  openid 优先；调用方拿到显示名时也可以传显示名兜底
 * @param {string[]} aliases  会话别名表（aliasesOf(chatId)），第 0 个是主 openid
 */
export function canonicalKey(who, aliases = [], current = '') {
  const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/^@+/, '');
  const w = norm(who);
  if (!w) return '';
  const list = (Array.isArray(aliases) ? aliases : []).map(norm).filter(Boolean);
  /**
   * `current` 是**当前会话的 chatId**。私聊里说话人的 openid 就是 chatId，
   * 而 aliasesOf(chatId) 按设计不含当前 chatId（否则记忆会重复读同一键），
   * 于是换机器人后新 openid 归不到号码，人物档案裂成两条。
   * 只对「who === 当前会话」放行；群里成员 openid ≠ chatId，保持原样，
   * 不会把一整个群合并成一个人。
   */
  const isCurrent = Boolean(current) && norm(current) === w;
  if (list.length && (list.includes(w) || list[0] === w || isCurrent)) return clipChars(list[0], 64);
  return clipChars(w, 64);
}

/** 「攒」一小段：按句去重、只留最近 3 句、总长有上限，丢最旧的 */
export function accumulate(prev, add, max) {
  const parts = (s) => String(s ?? '').split(/[;；|｜]/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of [...parts(prev), ...parts(add)]) {
    /** 先按码点截断单句，否则一句超长会被下面的循环整句丢掉 */
    const q = clipChars(p, max);
    if (!q || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
  }
  while (out.length > PROFILE_LINES_MAX || out.join('；').length > max) {
    if (!out.length) break;
    out.shift();
  }
  return clipChars(out.join('；'), max);
}

/** 默认关时一个字都不给（等价基线由接线测试锁死） */
export function shouldInjectProfiles({ enabled } = {}) {
  return enabled === true;
}

/**
 * 人工标签规范化 + 校验（对齐 aurabot 的护栏，含互斥与"不能讨厌主人"）。
 * @returns {{ok:true, tags:string[]} | {ok:false, message:string}}
 */
export function normalizePersonTags(raw, { isOwner = false } = {}) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[,，]/);
  const tags = list.map((t) => String(t ?? '').trim()).filter(Boolean);
  if (tags.length > PERSON_TAGS_MAX) return { ok: false, message: `标签最多 ${PERSON_TAGS_MAX} 个` };
  if (tags.some((t) => Array.from(t).length > PERSON_TAG_LEN)) return { ok: false, message: `每个标签最多 ${PERSON_TAG_LEN} 个字` };
  if (new Set(tags).size !== tags.length) return { ok: false, message: '标签不能重复' };
  if (tags.includes('喜欢') && tags.includes('讨厌')) return { ok: false, message: '喜欢和讨厌不能同时选' };
  if (isOwner && tags.includes('讨厌')) return { ok: false, message: '不能讨厌主人' };
  return { ok: true, tags };
}

const HEADER = '【熟人小档案】（只是印象，别原样念出来；别把别处的事当这个群发生过）';

export function createProfiles({
  file,
  max = PROFILE_MAX,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  let rows = null;
  /** { day, value }：同一天的渲染结果冻结，跨天才重算（保 prompt cache） */
  let renderCache = null;

  function save() {
    try {
      writeJsonAtomic(file, load(), { indent: 0 });
    } catch (e) {
      log(`写人物档案失败（不影响聊天）：${e.message}`);
    }
  }

  function load() {
    if (rows) return rows;
    let all = [];
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.people) ? raw.people : []);
      all = list.filter((r) => r && typeof r === 'object' && String(r.key ?? '').trim());
    } catch {
      all = [];
    }
    rows = all.slice(-max);
    return rows;
  }

  function render(limit) {
    const list = load().filter((r) => r.impression || r.tips || r.dislikes || r.style || r.persona);
    const picked = limit > 0 ? list.slice(-limit).reverse() : [...list].reverse();
    if (!picked.length) return '';
    const lines = picked.map((r) => {
      const name = clipChars(r.name || r.key, 24);
      const imp = clipChars(r.impression || '', IMPRESSION_MAX);
      const tips = clipChars(r.tips || '', TIPS_MAX);
      const bad = clipChars(r.dislikes || '', DISLIKES_MAX);
      const style = clipChars(r.style || '', STYLE_MAX);
      const persona = clipChars(r.persona || '', PERSONA_MAX);
      return `· ${name}：${oneLine(imp)}`
        + (persona ? `（性格：${oneLine(persona)}）` : '')
        + (style ? `（说话方式：${oneLine(style)}）` : '')
        + (tips ? `（相处：${oneLine(tips)}）` : '')
        + (bad ? `（别踩：${oneLine(bad)}）` : '');
    });
    return `${HEADER}\n${lines.join('\n')}`;
  }

  return {
    /**
     * 记一笔。`openid` 优先于显示名当键；`aliases` 传 aliasesOf(chatId)。
     * 开关关着时由调用方决定不调这里——本模块不偷偷读配置（单一真相在 config）。
     */
    note({ who = '', openid = '', impression = '', tips = '', dislikes = '', style = '', persona = '', aliases = [], current = '' } = {}) {
      const key = canonicalKey(openid || who, aliases, current);
      if (!key) return 0;
      const all = load();
      const imp = accumulate('', impression, IMPRESSION_MAX);
      const tip = accumulate('', tips, TIPS_MAX);
      const bad = accumulate('', dislikes, DISLIKES_MAX);
      const sty = accumulate('', style, STYLE_MAX);
      const per = accumulate('', persona, PERSONA_MAX);
      if (!imp && !tip && !bad && !sty && !per) return 0;
      const name = clipChars(String(who || openid || key).trim(), 24) || key;
      const cur = all.find((r) => r.key === key);
      if (cur) {
        cur.name = name || cur.name;
        cur.impression = accumulate(cur.impression, impression, IMPRESSION_MAX);
        cur.tips = accumulate(cur.tips, tips, TIPS_MAX);
        /** E4：只有真的提炼到讨厌项才写，空串不覆盖已有的 */
        if (bad) cur.dislikes = accumulate(cur.dislikes, dislikes, DISLIKES_MAX);
        if (sty) cur.style = accumulate(cur.style || '', style, STYLE_MAX);
        if (per) cur.persona = accumulate(cur.persona || '', persona, PERSONA_MAX);
        cur.at = now();
        cur.hits = Number(cur.hits || 0) + 1;
      } else {
        all.push({ key, name, impression: imp, tips: tip, dislikes: bad, style: sty, persona: per, at: now(), hits: 1 });
      }
      if (all.length > max) all.splice(0, all.length - max);
      /** 当天注入文本保持不变；新增的明天才进稳定段 */
      save();
      return all.length;
    },

    /** 稳定段注入块。enabled=false 直接空串，连盘都不读（默认关等价） */
    text({ enabled = true, day = dayKey(now()), limit = 6 } = {}) {
      if (!shouldInjectProfiles({ enabled })) return '';
      if (renderCache && renderCache.day === day) return renderCache.value;
      const value = render(limit);
      renderCache = { day, value };
      return value;
    },

    /** 面板只读展示，最新在前；开关关着也给，否则用户清不掉旧数据 */
    recent(limit = 20) {
      const all = [...load()].reverse();
      return limit > 0 ? all.slice(0, limit) : all;
    },

    /**
     * 忘掉某一个人（面板星图详情「忘掉这个人」）。
     * 只删这一行，不动别人；当场作废渲染缓存，下一轮注入就不再带他。
     */
    forget(key) {
      const k = String(key ?? '').trim().toLowerCase();
      if (!k) return false;
      const cur = load();
      const next = cur.filter((r) => String(r.key ?? '').trim().toLowerCase() !== k);
      if (next.length === cur.length) return false;
      rows = next;
      renderCache = null;
      save();
      return true;
    },

    /**
     * 人物墙人工编辑（对齐 aurabot /persona/person/save）。
     * 只覆盖 patch 里显式给的字段，模型提炼的其余字段原样留着；
     * 用户主动改 → 当场作废当日渲染缓存（隐私优先于 prompt cache）。
     * @returns {{ok:boolean, message:string}}
     */
    edit(key, patch = {}, { isOwner = false } = {}) {
      const k = String(key ?? '').trim().toLowerCase();
      if (!k) return { ok: false, message: '缺人物 key' };
      const all = load();
      const row = all.find((r) => String(r.key ?? '').trim().toLowerCase() === k);
      if (!row) return { ok: false, message: '还没有这个人的档案' };
      /** G7：style 说话方式 / persona 性格 独立维度；handle 沿用 tips（怎么相处） */
      const fields = ['alias', 'impression', 'tips', 'dislikes', 'style', 'persona'];
      const has = (f) => Object.prototype.hasOwnProperty.call(patch, f);
      if (!fields.some(has) && !has('tags') && !has('name')) return { ok: false, message: '没有要保存的内容' };
      let tags;
      if (has('tags')) {
        const r = normalizePersonTags(patch.tags, { isOwner });
        if (!r.ok) return { ok: false, message: r.message };
        tags = r.tags;
      }
      for (const f of fields) {
        if (!has(f)) continue;
        const max = f === 'impression' ? IMPRESSION_MAX
          : f === 'tips' ? TIPS_MAX
          : f === 'dislikes' ? DISLIKES_MAX
          : f === 'style' ? STYLE_MAX
          : f === 'persona' ? PERSONA_MAX
          : 24;
        const v = clipChars(String(patch[f] ?? '').trim(), max);
        if (f === 'impression' || f === 'tips' || f === 'dislikes') row[f] = accumulate('', v, max);
        else row[f] = v;
      }
      if (has('name')) row.name = clipChars(String(patch.name ?? '').trim(), 24) || row.name;
      if (tags !== undefined) { row.tags = tags; row.tagsBy = 'owner'; }
      row.at = now();
      renderCache = null;
      save();
      return { ok: true, message: '人物印象已保存' };
    },

    /** 不再记住某人：面板开关，只标记不删档案（撤回来还在） */
    setNoMemory(key, enabled = true) {
      const k = String(key ?? '').trim().toLowerCase();
      if (!k) return false;
      const row = load().find((r) => String(r.key ?? '').trim().toLowerCase() === k);
      if (!row) return false;
      if (enabled) row.noMemory = true;
      else delete row.noMemory;
      renderCache = null;
      save();
      return true;
    },

    /**
     * E4：撤销某个人的"雷区"（dislikes），保留印象/相处。
     * 为什么要单独可撤：雷区是模型提炼的主观判断，写错了会一直注入
     * "别踩：…"、还会被下一轮提炼喂回 prompt 自我强化（aurabot 用 tombstone 防这个）。
     * 这里做最小版：清掉这一项，下一轮提炼就不会再看到它。
     */
    clearDislikes(key) {
      const k = String(key ?? '').trim().toLowerCase();
      if (!k) return false;
      const row = load().find((r) => String(r.key ?? '').trim().toLowerCase() === k);
      if (!row || !row.dislikes) return false;
      delete row.dislikes;
      renderCache = null;
      save();
      return true;
    },

    /** 独立清空入口（契约 §3④）；隐私优先，当场作废渲染缓存 */
    clear() {
      rows = [];
      renderCache = null;
      save();
    },

    get size() {
      return load().length;
    },
  };
}
