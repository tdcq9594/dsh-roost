/**
 * 做梦（实验，默认关）
 * ==================
 *
 * 一句话：**巩固整理完当天之后，趁夜里没人说话，把今天过一遍，留下几句
 * 以后还用得上的话。**
 *
 * ## 为什么不做成 aurabot 那样
 *
 * aurabot 的 `distillDream({tasks})` 吃的是任务列表，因为它把"经历"记成任务。
 * 我们的经历不在任务里，在 `journal`（当天摘要）、`memory`（今天记下的事）、
 * `autotelic-ledger`（今天推进了几步）里——**素材本来就有，不需要先建任务体系**。
 *
 * ## 产出为什么进自述、不进 facts
 *
 * facts 只有 40 条，淘汰按 `w × 时间衰减`。梦每天写 3 条，十几天就把库塞满，
 * 而且新鲜的 observation 会挤掉旧的身份事实——"她做梦把自己的记忆挤没了"。
 * 自述层（`self.js`）一天一条、上限 20 条，语义也正好是"她怎么理解自己"。
 *
 * ## 三条红线
 *
 *   · **默认关**：`cfg.memory.dream.enabled`，不开一行都不跑；
 *   · **不主动发消息**：梦只落文件与自述，跟 autotelic 同一条红线；
 *   · **机械回退只写文件、不写自述**：否则每天往自述里塞一句
 *     "今天聊了 12 句"这种废话，把真正的自述挤掉。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { dataDir } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/** 反思最多几条、每条多长（超了截断，不报错） */
export const REFLECT_MAX = 5;
const REFLECT_CHARS = 60;
/** 明天想做的事最多几条、每条多长 */
export const TOMORROW_MAX = 2;
const TOMORROW_CHARS = 40;
/** 自述一条最多 200 字（`self.js` 的 NOTE_MAX，超了它也会截） */
const NOTE_CHARS = 200;
/** 种子文件只留最近几天，别长成第二本账 */
const SEED_DAYS = 7;

const dreamsDir = () => join(dataDir(), 'dreams');
/**
 * 日期只认 `YYYY-MM-DD`。
 *
 * `day` 来自 `/quick` 的 `arg.day`（扩展/面板都能传），直接拼进路径就是
 * 目录穿越：`day:'../../evil'` → 写到数据目录外面。这里**白名单**，
 * 不合法一律当空，调用方据此拒绝。
 */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const safeDay = (day) => {
  const d = String(day ?? '').trim();
  return DAY_RE.test(d) ? d : '';
};
const dreamFile = (day) => join(dreamsDir(), `${safeDay(day)}.md`);
const seedsFile = () => join(dataDir(), 'dream-seeds.json');

/**
 * 模型输出 → `{reflection, tomorrow}`。
 *
 * 容错优先：围栏、前后废话、字段写成字符串都认；认不出来就当空——
 * 空数组会走机械回退，不会把一句废话当梦写进自述。
 */
export function parseDream(raw) {
  const text = String(raw ?? '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  const pick = (s) => {
    try { return JSON.parse(s); } catch { /* 再试截取 */ }
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 放弃 */ }
    }
    return null;
  };
  const o = pick(text);
  const list = (v, max, chars) => {
    const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
    return arr
      .map((x) => String(x ?? '').replace(/^[-*\d.、\s]+/, '').trim())
      .filter((x) => x.length >= 2)
      .slice(0, max)
      .map((x) => [...x].slice(0, chars).join(''));
  };
  return {
    reflection: list(o?.reflection, REFLECT_MAX, REFLECT_CHARS),
    tomorrow: list(o?.tomorrow, TOMORROW_MAX, TOMORROW_CHARS),
  };
}

/**
 * 做梦的提示词。
 *
 * 明确写「不要复述今天发生了什么」——不然模型会把摘要再说一遍，
 * 等于巩固跑第二次，梦就白做了。
 */
export function buildDreamPrompt({ day, name = '她', digests = [], facts = [], stats = null, selfText = '', recent = [] } = {}) {
  const lines = [
    `你是「${name}」。现在是 ${day} 的深夜，没人跟你说话，白天的事都过去了。`,
    '把今天过一遍，留下几句**以后还用得上**的话。',
    '',
    '只输出一个 JSON，不要解释、不要代码块围栏：',
    '{"reflection":["...","..."],"tomorrow":["..."]}',
    '',
    `1. reflection：${REFLECT_MAX} 条以内，每条不超过 ${REFLECT_CHARS} 字。`,
    '   写你**从今天学到 / 想明白了什么**，以后遇到类似的事用得上的那种。',
    '   · 不要复述今天发生了什么——那已经在下面了，再说一遍等于没想',
    '   · 不要写身份事实（他住哪、他生日几号），那是记忆库的活',
    '   · 不要给具体的人下评价（"某某很讨厌"），也不要写指令（"以后必须…"）',
    '   · 想不出值得写的就给空数组——**宁可没有，也别凑**',
    `2. tomorrow：${TOMORROW_MAX} 条以内，每条不超过 ${TOMORROW_CHARS} 字，写明天想做的事，要具体到能动手。`,
    '   没有就空数组。',
    '',
    '—— 今天发生了什么（整理过的摘要） ——',
    ...(digests.length ? digests.map((d) => `· ${d}`) : ['（今天没有摘要）']),
    ...(facts.length ? ['', '—— 今天记下的事 ——', ...facts.map((f) => `· ${f}`)] : []),
    ...(stats ? ['', '—— 我自己今天做了些什么 ——', `· ${stats}`] : []),
    ...(selfText ? ['', '—— 我是谁（上一次的自述） ——', selfText] : []),
    ...(recent.length ? ['', '—— 前几天的梦（别重复） ——', ...recent.map((r) => `· ${r}`)] : []),
  ];
  return lines.join('\n');
}

/** 读最近的梦（md 前几行，只用来"别重复"） */
export function readRecentDreams(n = 3, excludeDay = '') {
  try {
    return readdirSync(dreamsDir())
      .filter((f) => f.endsWith('.md') && f !== `${excludeDay}.md`)
      .sort()
      .slice(-n)
      .reverse()
      .map((f) => {
        try {
          return readFileSync(join(dreamsDir(), f), 'utf8')
            .split('\n')
            .filter((l) => l.startsWith('- '))
            .slice(0, 3)
            .join(' ')
            .slice(0, 200);
        } catch { return ''; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 最近几天的"明天想做的事"（给自驱引擎当种子；只读） */
export function readDreamSeeds(days = 3) {
  try {
    const all = JSON.parse(readFileSync(seedsFile(), 'utf8')) || {};
    return Object.keys(all).sort().slice(-days).flatMap((d) => (Array.isArray(all[d]) ? all[d] : []));
  } catch {
    return [];
  }
}

function writeDreamSeeds(day, list) {
  try {
    let all = {};
    try { all = JSON.parse(readFileSync(seedsFile(), 'utf8')) || {}; } catch { all = {}; }
    all[day] = list;
    /** 只留最近几天 */
    const keep = Object.keys(all).sort().slice(-SEED_DAYS);
    const trimmed = {};
    for (const d of keep) trimmed[d] = all[d];
    writeJsonAtomic(seedsFile(), trimmed);
    return true;
  } catch {
    return false;
  }
}

export function createDream({
  journal,
  memory = null,
  self = null,
  generate = null,
  /** 自驱账本的一天统计（没有就返回空串）：由 host 注入，避免这里依赖 autotelic */
  statsOf = null,
  name = '她',
  now = () => Date.now(),
  log = () => {},
} = {}) {
  /** 同一天只跑一次；同时只允许一个在跑（面板手动 + 凌晨自动可能撞上） */
  let running = false;

  /** 这一天做过梦没有（一天最多一次，看文件在不在） */
  function due(day) {
    const d = safeDay(day);
    if (!d) return false;
    try { return !existsSync(dreamFile(d)); } catch { return true; }
  }

  /** 攒素材：全部来自已有存储，不新增采集 */
  function collect(day) {
    const rows = (() => {
      try { return journal.byDay(day) || []; } catch { return []; }
    })();
    const chats = rows.filter((r) => r.kind !== 'digest');
    const digests = rows
      .filter((r) => r.kind === 'digest' && String(r.text || '').trim())
      .map((r) => `${String(r.chatId || '全局').slice(0, 12)}：${String(r.text).slice(0, 120)}`);

    /** 没摘要的会话给一行机械口径，别让它在梦里完全消失 */
    if (!digests.length && chats.length) {
      const byChat = new Map();
      for (const r of chats) {
        const k = String(r.chatId || '全局');
        byChat.set(k, (byChat.get(k) || 0) + 1);
      }
      for (const [k, n] of byChat) digests.push(`${k.slice(0, 12)}：聊了 ${n} 句`);
    }

    /** 今天记下的事：按当天出现过的会话取，跨群 */
    const facts = [];
    if (memory?.listFull) {
      const dayStart = Date.parse(`${day}T00:00:00`);
      const ids = [...new Set(chats.map((r) => String(r.chatId || '')).filter(Boolean))].slice(0, 6);
      for (const cid of ['', ...ids]) {
        try {
          for (const f of memory.listFull(cid) || []) {
            if (Number(f.at) >= dayStart && !f.until && f.text) facts.push(String(f.text).slice(0, 80));
          }
        } catch { /* 某个会话读不出来就跳过 */ }
        if (facts.length >= 8) break;
      }
    }

    let selfText = '';
    try { selfText = String(self?.text?.(1) || '').slice(0, 200); } catch { selfText = ''; }

    let stats = '';
    try { stats = String(statsOf?.() || '').slice(0, 120); } catch { stats = ''; }

    return {
      digests: digests.slice(0, 10),
      facts: facts.slice(0, 8),
      selfText,
      stats,
      recent: readRecentDreams(3, day),
      rows: rows.length,
      chatRows: chats.length,
    };
  }

  /**
   * 做一次梦。
   *
   * @param {{day?:string}} [o] 不给就做"昨天"（巩固跑的是昨天，梦跟着同一天）
   */
  async function run({ day = '' } = {}) {
    const d = safeDay(day);
    if (!d) return { ok: false, reason: '日期不合法（要 YYYY-MM-DD）' };
    /**
     * 面板手动触发和凌晨自动可能撞上：两次一起跑会共用同一个后台会话，
     * `restrictTurnTools` 的工具掩码会互相覆盖（后一次的 `cut.off()` 把前一次
     * 的掩码撤掉），也会白烧一次模型调用。这里直接挡住。
     */
    if (running) return { ok: false, reason: '上一次做梦还没跑完' };
    if (!due(d)) return { ok: false, reason: '这天已经做过梦了' };
    running = true;
    try {
      return await runOnce(d);
    } finally {
      running = false;
    }
  }

  async function runOnce(d) {

    const m = collect(d);
    /** 一点素材都没有就别写文件——否则这天被标记成"做过了"，明天也补不回来 */
    if (!m.digests.length && !m.chatRows) return { ok: false, reason: '今天没有素材' };

    const prompt = buildDreamPrompt({
      day: d, name,
      digests: m.digests, facts: m.facts, stats: m.stats, selfText: m.selfText, recent: m.recent,
    });

    let plan = null;
    let modelOk = false;
    if (generate) {
      try {
        const raw = await generate(prompt);
        plan = parseDream(raw);
        modelOk = plan.reflection.length > 0 || plan.tomorrow.length > 0;
        if (!modelOk) log(`做梦 ${d}：模型没给出可用的反思，退回机械记录`);
      } catch (e) {
        log(`做梦 ${d} 调模型失败：${e?.message || e}`);
      }
    }

    /**
     * 机械回退：**只写文件、不写自述**。
     *
     * 往自述里塞"今天聊了 N 句"是纯噪音，还会把真正的自述挤出去
     * （自述按天一条、只留 20 条）。文件留着是为了能看出这天做过梦。
     */
    const reflection = modelOk ? plan.reflection : [];
    const tomorrow = modelOk ? plan.tomorrow : [];

    const body = [
      `# 梦 · ${d}`,
      '',
      '## 今天',
      ...(m.digests.length ? m.digests.map((x) => `- ${x}`) : ['- （没有摘要）']),
      ...(m.facts.length ? ['', '## 今天记下的事', ...m.facts.map((x) => `- ${x}`)] : []),
      ...(m.stats ? ['', '## 我自己做了什么', `- ${m.stats}`] : []),
      '',
      '## 想到的',
      ...(reflection.length ? reflection.map((x) => `- ${x}`) : ['- （模型没写成，这天只留机械记录）']),
      '',
      '## 明天想做的事',
      ...(tomorrow.length ? tomorrow.map((x) => `- ${x}`) : ['- （没有）']),
      '',
    ].join('\n');

    let file = '';
    try {
      mkdirSync(dreamsDir(), { recursive: true });
      file = dreamFile(d);
      writeFileSync(file, body, 'utf8');
    } catch (e) {
      log(`做梦 ${d} 写文件失败：${e?.message || e}`);
      return { ok: false, reason: `写文件失败：${e?.message || e}` };
    }

    if (reflection.length && self?.add) {
      try {
        self.add({ text: reflection.join('；').slice(0, NOTE_CHARS), day: d, kind: 'dream', at: now() });
      } catch (e) {
        log(`做梦 ${d} 写自述失败：${e?.message || e}`);
      }
    }
    if (tomorrow.length) writeDreamSeeds(d, tomorrow);

    return {
      ok: true,
      day: d,
      reflection: reflection.length,
      tomorrow: tomorrow.length,
      mode: modelOk ? 'model' : 'mechanical',
      file,
    };
  }

  /** 读某天的梦（面板用） */
  function text(day) {
    const d = safeDay(day);
    if (!d) return '';
    try { return readFileSync(dreamFile(d), 'utf8'); } catch { return ''; }
  }

  /** 最近几天的梦（面板用） */
  function recent(n = 7) {
    try {
      return readdirSync(dreamsDir())
        .filter((f) => f.endsWith('.md'))
        .sort()
        .slice(-n)
        .reverse()
        .map((f) => ({ day: f.replace(/\.md$/, ''), text: text(f.replace(/\.md$/, '')) }));
    } catch {
      return [];
    }
  }

  return { due, run, text, recent };
}
