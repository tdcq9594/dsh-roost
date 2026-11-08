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
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const PROFILE_MAX = 50;
export const IMPRESSION_MAX = 80;
export const TIPS_MAX = 120;
export const PROFILE_LINES_MAX = 3;

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
export function canonicalKey(who, aliases = []) {
  const norm = (x) => String(x ?? '').trim().toLowerCase().replace(/^@+/, '');
  const w = norm(who);
  if (!w) return '';
  const list = (Array.isArray(aliases) ? aliases : []).map(norm).filter(Boolean);
  /** 命中任一别名（或本来就是主 openid）→ 归到主 openid，换号不裂成两个人 */
  if (list.length && (list.includes(w) || list[0] === w)) return clipChars(list[0], 64);
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
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(load()), 'utf8');
      renameSync(tmp, file);
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
    const list = load().filter((r) => r.impression || r.tips);
    const picked = limit > 0 ? list.slice(-limit).reverse() : [...list].reverse();
    if (!picked.length) return '';
    const lines = picked.map((r) => {
      const name = clipChars(r.name || r.key, 24);
      const imp = clipChars(r.impression || '', IMPRESSION_MAX);
      const tips = clipChars(r.tips || '', TIPS_MAX);
      return `· ${name}：${imp}${tips ? `（相处：${tips}）` : ''}`;
    });
    return `${HEADER}\n${lines.join('\n')}`;
  }

  return {
    /**
     * 记一笔。`openid` 优先于显示名当键；`aliases` 传 aliasesOf(chatId)。
     * 开关关着时由调用方决定不调这里——本模块不偷偷读配置（单一真相在 config）。
     */
    note({ who = '', openid = '', impression = '', tips = '', aliases = [] } = {}) {
      const key = canonicalKey(openid || who, aliases);
      if (!key) return 0;
      const all = load();
      const imp = accumulate('', impression, IMPRESSION_MAX);
      const tip = accumulate('', tips, TIPS_MAX);
      if (!imp && !tip) return 0;
      const name = clipChars(String(who || openid || key).trim(), 24) || key;
      const cur = all.find((r) => r.key === key);
      if (cur) {
        cur.name = name || cur.name;
        cur.impression = accumulate(cur.impression, impression, IMPRESSION_MAX);
        cur.tips = accumulate(cur.tips, tips, TIPS_MAX);
        cur.at = now();
        cur.hits = Number(cur.hits || 0) + 1;
      } else {
        all.push({ key, name, impression: imp, tips: tip, at: now(), hits: 1 });
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
