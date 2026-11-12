/**
 * 觉醒：**只唤醒，做不做她自己定**。
 *
 * 这一层解决的是"主动"的老问题。以前的 `speakup.js` 是**定时器**：
 * 到点了就发，发什么由一句固定 prompt 决定。结果是"每隔几小时准时出现一句
 * 无关痛痒的话"——像闹钟，不像人。
 *
 * 现在改成**决策型**：
 *   1. 先算"有没有值得说的机会"（三类，纯函数，可测）
 *   2. 把机会 + 最近对话 + 情绪 + 没办完的约定一起喂给模型
 *   3. 模型自己决定说不说——**可以不说**
 *
 * 铁律三的依据（大肥鱼实证）：硬叫醒的 AI 会为了"显得主动"随口挑一件不重要的事，
 * 那比不说话更假。所以 `<<skip>>` 是**正常结局**，不是失败。
 *
 * 三类机会的性质完全不同，权重差很远：
 *   agreement 约定 —— 有具体事没办，最有效（"你上次说要给我看那个"）
 *   miss      想你 —— 久了没聊 + 社交意愿高，其次
 *   casual    随性 —— 最容易做作，权重最低，且**每天最多一次**
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { NEUTRAL } from './mood.js';
// 跨天排期和私聊共用一份实现，两边的「额度用完推到明天」不能算出两个时间
import { scheduleNextDay, silenceMsOf } from './speakup.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const KINDS = ['agreement', 'miss', 'casual'];

export const DEFAULTS = {
  enabled: false,
  /** 清醒时段（小时，左闭右开，支持跨零点） */
  awakeFrom: 8,
  awakeTo: 23,
  /** 多久没聊才算「想你」（小时） */
  missAfterHours: 6,
  /** 机会分阈值，低于它连问都不问模型 */
  minScore: 0.35,
  /** 随性每天最多几次 */
  casualPerDay: 1,
  /**
   * 收尾后多久内不「随性搭话」（分钟）。**只是兜底默认值**——
   * 真正的配置在 `closing.coolMinutes`，`cfg()` 会用它覆盖这里。
   */
  closeCoolMinutes: 90,
  /** 群聊主动：默认关。白名单里写了才考虑 */
  groups: [],
  /** 每个群每天最多主动几次 */
  maxPerGroupPerDay: 3,
  /** 群里冷场多久才考虑插话（分钟） */
  groupQuietMinutes: 45,
  /**
   * 她决定不说（或调模型失败）之后，多久内不再问这个群（分钟）。
   * **每跳过一次翻一倍**，到 `skipBackoffMaxMinutes` 封顶。
   */
  skipBackoffMinutes: 30,
  /** 退避上限（分钟）。连续几次都不想说的群，就固定这么久问一次 */
  skipBackoffMaxMinutes: 360,
};

/* ---------------- C3 主人反馈闭环 ---------------- */

export const KIND_WEIGHT_MIN = 0.5;
export const KIND_WEIGHT_MAX = 1.5;
export const KIND_WEIGHT_STEP = 0.05;
/** 同一类主动连续两次没人回，才降权重（一次可能是刚好在忙） */
export const NO_REPLY_PENALTY = 0.08;

export function defaultKindWeights() {
  return { agreement: 1, miss: 1, casual: 1 };
}

/** 只动被反馈的那一类；夹在 [0.5, 1.5]，别让一两次点踩把某类机会彻底掐死 */
export function adjustKindWeights(weights = {}, kind, delta) {
  const cur = { ...defaultKindWeights(), ...(weights || {}) };
  if (!KINDS.includes(kind)) return cur;
  const v = Number(cur[kind] ?? 1);
  const raw = Number.isFinite(v) ? v : 1;
  cur[kind] = Math.round(
    Math.min(KIND_WEIGHT_MAX, Math.max(KIND_WEIGHT_MIN, raw + Number(delta || 0))) * 1000,
  ) / 1000;
  return cur;
}

/**
 * 主人下一条私聊回复的态度。只作**补充**信号：官方点赞点踩（/mood）更可靠，
 * 用户不一定会点。中文没词边界，所以先判否定——「不要」「不好」里都带正面的字。
 */
export function classifyOwnerReply(text) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return 'neutral';
  /**
   * 中文没词边界，否定必须先判：「不好 / 不太好 / 不怎么样」里都带正面的字，
   * 落到下面的正面表就会被当成夸。
   * 「不好」要排除「不好意思」——那是客气，不是否定（审查实测过误判）。
   */
  if (/(别再|别发|不要|不用了|不想|烦|吵|闭嘴|无聊|够了|算了|讨厌|没空|很忙|少来|行了|不好(?!意思)|不太好|不怎么样|不太行|没意思)/.test(s)) return 'negative';
  if (/(谢谢|太棒|好棒|好呀|好的|真好|喜欢|有意思|哈哈|可爱|厉害|赞|不错|开心|对呀|嗯嗯)/.test(s)) return 'positive';
  /** 「嗯」是敷衍不是夸，只有叠字「嗯嗯」算正面（已在上面那条里） */
  if (/^(好|行|ok|okay|可以|好啊)$/.test(s)) return 'positive';
  return 'neutral';
}

/** 在不在清醒时段（跨零点也支持） */
export function inWindow(hour, from, to) {
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

const dayKey = (ts) => new Date(ts).toDateString();

/**
 * 读"没办完的约定"。
 *
 * 两个来源都要看，因为它们记的是同一件事的两面：
 *   · facts 里以「约定：」开头的（巩固时写进去的）
 *   · 图谱里 `rel='约定'` 且 `valid_to IS NULL` 的活边（办完会被关掉）
 * 图谱那边更准（有状态），facts 那边更全（模型顺手写的）。
 * 去重后返回纯文本。
 */
export function readAgreements({ memory, graph, chatId = '', aliases = [] } = {}) {
  const out = new Set();
  try {
    const m = memory?.list?.(chatId, aliases);
    for (const f of [...(m?.global || []), ...(m?.chat || [])]) {
      const s = String(f || '');
      if (s.startsWith('约定：')) out.add(s.slice(3).trim());
    }
  } catch {}
  try {
    for (const e of graph?.nowEdges?.({ chatId, limit: 30, aliases }) || []) {
      if (e.rel === '约定' && e.dst) out.add(String(e.dst).trim());
    }
  } catch {}
  return [...out].filter(Boolean).slice(0, 8);
}

/**
 * 算这一轮有哪些机会。
 *
 * 纯函数：不读文件、不看时钟（`now` 传进来）、不调模型。
 * 这样"半夜三点会不会被叫醒"这种事能直接测，不必真的等到半夜。
 *
 * @param {object} o
 * @param {number} o.now
 * @param {object} o.mood      { valence, energy, sociability }
 * @param {string[]} o.agreements 没办完的约定
 * @param {object} o.state     { lastOwnerAt, lastWakeAt, casualDay, casualCount, day }
 * @param {object} o.cfg
 * @param {boolean} [o.noMiss] 不算「想你」这一档（群聊用）
 * @returns {Array<{kind:string, score:number, reason:string}>} 按分降序
 */
export function opportunities({ now = Date.now(), mood = {}, agreements = [], state = {}, cfg = {}, noMiss = false, pending = '', weights = null } = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const hour = new Date(now).getHours();
  if (!inWindow(hour, c.awakeFrom, c.awakeTo)) return [];

  /**
   * 缺省值取 `NEUTRAL`（0.5），跟 `mood.js` 的落点**必须一致**。
   *
   * 以前这里写的是 0.6，而情绪衰减的落点是 0.5——两处不一致的后果是：
   * 传进来的 mood 一旦缺字段（老数据 / 面板刚清过），判分用的基准
   * 就跟实际存着的值不是一回事，同一份数据两处算出不同结论。
   */
  const sociability = Number.isFinite(mood.sociability) ? mood.sociability : NEUTRAL;
  const energy = Number.isFinite(mood.energy) ? mood.energy : NEUTRAL;
  const valence = Number.isFinite(mood.valence) ? mood.valence : 0;
  const out = [];

  /* 约定：有事没办，最该说 */
  if (agreements.length) {
    out.push({
      kind: 'agreement',
      score: 1,
      /**
       * 心情差的时候提约定反而像催债，所以低 valence 降一点权重，
       * 但**不降到不出现**——答应过的事还是要提。
       */
      reason: `有 ${agreements.length} 件答应过但还没做的事：${agreements.slice(0, 2).join('；')}`,
    });
    if (valence < -0.3) out[out.length - 1].score -= 0.15;
  }

  /* 想你：沉默够久 + 社交意愿 */
  const lastOwner = Number(state.lastOwnerAt || 0);
  /**
   * `lastOwnerAt = 0` 按「很久没联系」算（沉默 99 小时）。
   *
   * 私聊要这个语义：一条记录都没有时，确实该先打个招呼。
   * **群聊不能这么算**——群里没有「等谁」这回事，`noMiss` 显式关掉这一档。
   * 以前是靠宿主传 `lastOwnerAt: 0` 想"跳过"miss，结果 0 反而触发了最高分的 miss，
   * 于是群主动每轮都以「很久没联系了」为理由开口，把「约定」永远压下去了。
   */
  const silentH = lastOwner ? (now - lastOwner) / HOUR : 99;
  if (!noMiss && silentH >= c.missAfterHours) {
    // 沉默越久权重越高，但封顶；社交意愿是乘数（心情好才更容易想起人）
    const depth = Math.min(1, (silentH - c.missAfterHours) / (c.missAfterHours * 2));
    const score = (0.45 + 0.4 * depth) * (0.5 + sociability * 0.6);
    out.push({
      kind: 'miss',
      score,
      reason: lastOwner ? `已经 ${Math.round(silentH)} 小时没聊了` : '很久没联系了',
    });
  }

  /* 随性：权重最低，且每天一次封顶 */
  const today = dayKey(now);
  const casualUsed = state.casualDay === today ? Number(state.casualCount || 0) : 0;
  /**
   * 刚收过尾就别「随便说句话」了。
   *
   * `closedAt` 由宿主从 `closing.json` 传进来（0 = 没记录）。
   * 这里自己算冷却，不调用 closing 的 coolingDown——保持纯函数，
   * 「刚说完晚安会不会又被叫醒」能直接测，不必等到半夜。
   */
  const closedAt = Number(state.closedAt || 0);
  const closeCool = Math.max(0, Number(c.closeCoolMinutes) || 0) * MINUTE;
  const inCloseCool = closedAt > 0 && now - closedAt < closeCool;

  if (casualUsed < c.casualPerDay && !inCloseCool) {
    /**
     * C2：心里惦记着一句没被回的话时，随性这一档 +0.35（照 aurabot 的权重），
     * 并打上 `pendingBoost` 让 `pickOpportunity` 有一半机会直接优先它。
     * 不给「约定」加：答应过的事本来就该提，不需要靠惦记抬分。
     */
    /**
     * 基础分 + 精力项的系数是照着 `minScore` 定的：精力中性 0.5 时约 0.39
     * 能过线（阈值 0.35），掉到 0.2 时约 0.34 自动不过线——累了就不想
     * 随便搭话。C2 的 pending 加成叠在这上面，不另造一档机会。
     */
    const thought = String(pending ?? '').trim().slice(0, 60);
    out.push({
      kind: 'casual',
      score: 0.3 + 0.18 * energy + (thought ? 0.35 : 0),
      reason: thought ? `心里还惦记着「${thought}」` : '没什么特别的事，就是想随便说句话',
      ...(thought ? { pendingBoost: true } : {}),
    });
  }

  /**
   * C3：权重乘在**过阈值之前**，否则被降权的 kind 照样进列表、只是排序靠后，
   * 「说了没人理就少说这类」根本没生效。默认全 1 时乘完数值逐字节不变。
   */
  const w = { ...defaultKindWeights(), ...(weights || {}) };
  return out
    .map((o) => {
      const k = Number(w[o.kind]);
      return { ...o, score: o.score * (Number.isFinite(k) ? k : 1) };
    })
    .filter((o) => o.score >= c.minScore)
    .map((o) => ({ ...o, score: Math.max(0, Math.min(1, Number(o.score.toFixed(3)))) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * C1 防复读：两段主动文本像不像。
 *
 * 用**字符 bigram 的 Dice 系数**：中文短句没有空格可分，整句等值判断
 * 又挡不住「在干嘛」→「在干嘛呀」这种换个尾巴的复读。bigram 能给出
 * 连续程度而不是布尔值，阈值才有意义。
 * 阈值 0.55 借 aurabot `engine.js:755`（报告 §6.4）。
 *
 * 比较前先抹掉括号里的动作/神态和标点——「（伸懒腰）在干嘛」和「在干嘛」
 * 是同一句，不该因为加了动作就放过复读。
 */
export const DUP_THRESHOLD = 0.55;

function compareKey(s) {
  return String(s ?? '')
    .replace(/[（(][^）)]{0,40}[）)]/g, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

function bigrams(s) {
  const t = compareKey(s);
  if (!t) return [];
  const out = [];
  for (let i = 0; i < t.length - 1; i += 1) out.push(t.slice(i, i + 2));
  return out.length ? out : [t];
}

export function textSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const pool = new Map();
  for (const g of B) pool.set(g, (pool.get(g) || 0) + 1);
  let hit = 0;
  for (const g of A) {
    const n = pool.get(g) || 0;
    if (n > 0) {
      hit += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

/**
 * C1/C4：从现成数据里挑出给主动提示词的素材。
 *
 * 抽成纯函数是为了让「查了哪些行、取几条、开关关着给不给」都能单测，
 * 而不是只靠看 host 里那段 JSX 似的拼装代码。调用方负责查数据：
 *   · journalRows = `journal.recent(chatId, 16, 'chat', aliases)`（最新在前）
 *   · eventRows   = `events.recent(3)`（D8 经历层，最新在前）
 *
 * eventsEnabled=false 时 `done` 一定是空数组——功能关了就把旧动作翻出来
 * 说，等于「关了还在生效」，也破坏了默认关时 prompt 逐字节一致的基线。
 */
export function wakeMaterials({ journalRows = [], eventRows = [], eventsEnabled = false, labels = {} } = {}) {
  const recentBot = (Array.isArray(journalRows) ? journalRows : [])
    .filter((r) => r?.role === 'bot')
    .slice(0, 3)
    .map((r) => String(r.digest || r.text || '').slice(0, 60))
    .filter(Boolean);
  const done = eventsEnabled
    ? (Array.isArray(eventRows) ? eventRows : []).slice(0, 3)
      .map((r) => `${r?.scene === 'group' ? '在群里' : '在私聊'}${labels[r?.kind] || r?.kind || '做过点什么'}`)
    : [];
  return { recentBot, done };
}

/** 和最近说过的任一 text 相似度 ≥ 阈值就算复读 */
export function isDuplicateText(text, recent = [], threshold = DUP_THRESHOLD) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return (Array.isArray(recent) ? recent : [])
    .some((r) => textSimilarity(t, r) >= threshold);
}

/**
 * 从机会里挑一个。
 *
 * 不直接取最高分：那样"约定"会永远压过其它，行为会变得可预测。
 * 按分数做加权随机，既偏向更值得说的，又保留不确定。
 */
export function pickOpportunity(list, rand = Math.random) {
  const items = (list || []).filter((o) => o.score > 0);
  if (!items.length) return null;
  /**
   * C2：心里惦记着的事有一半机会直接插队。
   * 只在这条标记存在时才多摇一次随机数——没 pending 的部署随机序列
   * 与改动前完全一致（老测试的固定 rand 不会因此漂移）。
   */
  const boosted = items.find((o) => o.pendingBoost);
  if (boosted && rand() < 0.5) return boosted;
  const total = items.reduce((s, o) => s + o.score, 0);
  let r = rand() * total;
  for (const o of items) {
    r -= o.score;
    if (r <= 0) return o;
  }
  return items[items.length - 1];
}

/**
 * 拼"要不要说话"的提示词。
 *
 * 关键是最后那句 `<<skip>>`：**必须明确给出不说话的出口**，
 * 否则模型会为了完成任务硬凑一句（这是铁律三的落点）。
 */
export function buildWakePrompt({ opp, ctx = {}, group = null, extra = '' } = {}) {
  const where = group ? `你在 QQ 群「${group.name || group.idShort || ''}」里` : '你在和主人私聊';
  const lines = [
    `${where}。现在 ${ctx.hour ?? ''} 点，${opp?.reason || '没什么特别的事'}。`,
    ctx.moodText ? `你现在的心情：${ctx.moodText}` : '',
    /**
     * 开场白（SillyTavern 的 `first_mes`）。
     *
     * 为什么要给：不给的话每次开口都是现编，隔几次就一个调子、越编越像客服。
     * 给了但**不要求照抄**——照抄会变成每次都同一句，那比现编更假。
     * 所以是「她习惯这样开口」，让模型顺着这个感觉说。
     */
    ctx.opener ? `她习惯这样开口：「${ctx.opener}」——可以照这个感觉说，别每次一模一样。` : '',
    /**
     * 上次收在哪。
     *
     * 主动搭话最容易假的地方是「装作没发生过」——明明上次聊到一半说了
     * 晚安，这次又来一句「在干嘛」。接上话头就自然多了。
     *
     * 注意这里的措辞跟「下一轮被动接话」那边**不一样**：那边是同一段
     * 聊天的延续（`closing.text()` 说「不用重新自我介绍」），这边是
     * **重新开一段**，所以说「接上次的」而不是「延续」。
     */
    ctx.closing?.point
      ? `【上次聊到这儿】\n收在：${ctx.closing.point}`
        + (ctx.closing.resume ? `\n你本来打算下次这么接：${ctx.closing.resume}` : '')
        + '\n（可以从这儿接着聊，也可以就着这件事起个头；别装作没发生过。）'
      : '',
    /**
     * C2：上次主动问出去、对方没回的话。
     * 明确写「别追问怎么不回我」——否则模型很容易把惦记演成催回复，
     * 那比干脆不提更烦人。也照样给 <<skip>> 的出口。
     */
    ctx.pending
      ? `【心里还惦记着】\n上次你主动问了「${String(ctx.pending).slice(0, 60)}」，对方没回。`
        + '\n（可以自然地接着聊那件事，别追问「怎么不回我」；没什么想说的就输出 <<skip>>。）'
      : '',
    ctx.recent?.length ? `【最近说过的话】\n${ctx.recent.map((r) => `· ${r}`).join('\n')}` : '',
    /**
     * C1：最近几次**她主动说过的话**（journal 的 bot 行，不另建数组）。
     * 只摆事实、不下「不许重复」的命令就算了：模型看到清单会自然避开，
     * 而明确的「别重复」能挡住「换个措辞再说一遍」这类最像复读的情况。
     */
    ctx.recentBot?.length
      ? `【最近你已经主动说过】\n${ctx.recentBot.map((r) => `· ${r}`).join('\n')}`
        + '\n（别换个说法再说一遍；没什么新事就输出 <<skip>>。）'
      : '',
    ctx.agreements?.length ? `【答应过还没做的】\n${ctx.agreements.map((a) => `· ${a}`).join('\n')}` : '',
    /**
     * C4：casual / agreement 的**真实素材**。D8 事件层默认关，那段就没内容，
     * 此时 prompt 与未上线前逐字节一致；关着也不该把旧动作翻出来说。
     * 「想你」那一档不喂这个——刚沉默很久就汇报自己做过什么，很不像人。
     */
    opp?.kind && opp.kind !== 'miss' && ctx.done?.length
      ? `【最近做过的事】\n${ctx.done.map((r) => `· ${r}`).join('\n')}\n（可以顺口提一句，别写成汇报。）`
      : '',
    /**
     * 主人自己写的指令（`speakUp.prompt`）。
     *
     * 放在 `<<skip>>` 那一段**之前**：那段是铁律三的落点（必须给她不说话的
     * 出口），不能被任何自定义指令顶掉。自定义指令写在前面，读起来是
     * 「她自己的偏好」，最后那句仍然是「你可以不说」。
     */
    extra ? `【主人给你的额外要求】\n${extra}` : '',
    '',
    '现在给你一个开口的机会。**你可以不说。**',
    '想说就直接写要发出去的那句话：口语、简短（通常一两句），不要解释你为什么突然说话，',
    '不要提这是定时任务，不要问「在吗」。',
    /** 这段会原样发到 QQ：只挡名字前缀；markdown 和括号动作都允许（第一段按 md 发，@ 也靠它） */
    '别加名字前缀（不要「大肥鱼：」）。括号里的动作/神态可以写，但别写成整段旁白。',
    '如果此刻没什么想说的，或者没什么值得打扰对方的，**只输出 `<<skip>>`**，什么都别加。',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 解析模型的回答。
 *
 * `speak=false` 是**正常结果**，不是失败——调用方据此直接跳过，
 * 不要重试、不要记成错误。
 */
export function parseVerdict(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { speak: false, text: '', why: '空回答' };
  if (/<<\s*skip\s*>>/i.test(s)) return { speak: false, text: '', why: '她自己决定不说' };
  /**
   * 静默要**先提取再摘掉**——下一行的 replace 会把所有 `<<...>>` 一起抹平。
   *
   * 群主动只支持「说完这句顺带要求安静」；只有静默、没有正文时按「不说」处理
   * （群主动本来就是「要不要插话」，不插话就不说话，单独静默没有意义）。
   */
  const silenceMs = silenceMsOf(s);
  const text = s
    .replace(/<<[^>]*>>/g, '')
    .replace(/^["「『]|["」』]$/g, '')
    .trim();
  if (!text) return { speak: false, text: '', why: '去掉标记后没内容' };
  if (text.length > 500) return { speak: true, text: text.slice(0, 500), silenceMs, why: '' };
  return { speak: true, text, silenceMs, why: '' };
}

/**
 * 她刚说过「不想说」之后，要等多久再问同一个群（毫秒）。
 *
 * 逐次翻倍：30 → 60 → 120 → 240 → 360（封顶）分钟。
 * 抽成纯函数是为了能测——这块写错的表现不是报错，是**账单**：
 * 连续跳过的群会每 5 分钟被空问一次，一直到跨天。
 *
 * @param {number} streak 连续跳过几次（从 1 开始）
 * @param {object} cfg
 */
export function skipBackoffMs(streak, cfg = {}) {
  const base = Math.max(1, Number(cfg.skipBackoffMinutes) || DEFAULTS.skipBackoffMinutes);
  const cap = Math.max(base, Number(cfg.skipBackoffMaxMinutes) || DEFAULTS.skipBackoffMaxMinutes);
  // 上限 20 是为了别让 2**n 溢出成 Infinity（那样也能被 min 兜回来，但没必要）
  const n = Math.min(Math.max(1, Math.floor(Number(streak) || 1)), 20);
  return Math.min(base * 2 ** (n - 1), cap) * MINUTE;
}

/**
 * 群聊主动的候选群（C7）。
 *
 * 四道门，缺一不发：
 *   1. 白名单里显式开了（默认关，群主动极易被踢）
 *   2. 有 `group_push` 授权（官方硬前置，没它发不出去）
 *   3. 不在静默时段
 *   4. 这个群今天还没到上限，且群里确实冷场了
 *
 * 返回每个群"能不能说 + 为什么"，面板和日志都能直接用。
 */
export function groupCandidates({ groups = [], authzOf, stateOf, cfg = {}, now = Date.now() } = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const hour = new Date(now).getHours();
  const out = [];
  for (const g of groups) {
    const chatId = String(g?.chatId || '').trim();
    if (!chatId) continue;
    const st = stateOf?.(chatId) || {};
    const rec = { chatId, name: g.name || chatId.slice(0, 8) };

    if (g.enabled === false) {
      out.push({ ...rec, ok: false, why: '这个群没开主动' });
      continue;
    }
    if (!inWindow(hour, c.awakeFrom, c.awakeTo)) {
      out.push({ ...rec, ok: false, why: '静默时段' });
      continue;
    }
    if (!authzOf?.(chatId)) {
      out.push({ ...rec, ok: false, why: '没有 group_push 授权' });
      continue;
    }
    const today = dayKey(now);
    const count = st.day === today ? Number(st.count || 0) : 0;
    if (count >= c.maxPerGroupPerDay) {
      out.push({ ...rec, ok: false, why: `今天已经说了 ${count} 次` });
      continue;
    }
    /**
     * 被框架挡回来过（主动额度用完），等到点再试。
     *
     * 为什么不用「把 count 填满」来变相封禁：那是往状态里写假数据，
     * 面板上会显示「今天已经说了 3 次」而实际一次没说，比不封更让人困惑。
     */
    if (st.blockedUntil && now < st.blockedUntil) {
      const mins = Math.ceil((st.blockedUntil - now) / MINUTE);
      out.push({ ...rec, ok: false, why: `主动额度用完，${mins} 分钟后再看` });
      continue;
    }
    /**
     * 她刚说过「不想说」，别过五分钟再问一遍。
     *
     * 这道门以前没有，于是 `<<skip>>` 之后状态原地不变、条件照样成立，
     * 检查循环每 5 分钟空问一次：清醒 15 小时 = 180 次模型调用/群/天，
     * 一个字都没发出去。这是纯烧钱，不是功能问题。
     */
    if (st.nextAskAt && now < st.nextAskAt) {
      const mins = Math.ceil((st.nextAskAt - now) / MINUTE);
      out.push({ ...rec, ok: false, why: `刚问过她，${mins} 分钟后再看` });
      continue;
    }
    const quietMin = st.lastUserAt ? (now - st.lastUserAt) / MINUTE : 9999;
    if (quietMin < c.groupQuietMinutes) {
      out.push({ ...rec, ok: false, why: `群里刚有人说话（${Math.round(quietMin)} 分钟前）` });
      continue;
    }
    out.push({ ...rec, ok: true, why: `冷场 ${Math.round(quietMin)} 分钟`, count });
  }
  return out;
}

/**
 * 觉醒的执行体。
 *
 * 职责边界：它**只决定说不说、说什么**，发送交给通道（`channel.send`）。
 * 排期仍归 `speakup.js`——那块已经有测试、有状态文件，不重复造。
 */
export function createAwake({
  dataDir,
  cfgOf,
  channelOf,
  contextOf,
  generate,
  authzOf,
  log = () => {},
  rand = Math.random,
  now = () => Date.now(),
} = {}) {
  const file = () => join(dataDir, 'awake.json');
  /**
   * `groups` 只放**群**，`c2c` 单独一格。
   *
   * 以前私聊也往 `groups` 里写（`noteUser` 不看 kind），于是 `awake.json`
   * 的 groups 里混进了主人的 c2c openid。后果不只是脏数据：`groupCandidates`
   * 的候选来自配置白名单，脏条目不会真被当成群，但面板「她为什么不说」那栏
   * 一旦有人按 state 去看，就会多出一个不存在的群。
   */
  let state = {
    groups: {}, c2c: { lastUserAt: 0 }, casualDay: '', casualCount: 0,
    lastWakeAt: 0, lastKind: '', lastWhy: '',
    /** C3：三类机会的反馈权重（默认全 1 = 与未上线前一致） */
    kindWeights: defaultKindWeights(),
    /** 上一次主动说出去是哪一类、有没有结算过、连续几次没人回 */
    lastWakeKind: '', settled: true, noReplyStreak: 0, lastFeedbackAt: 0,
  };
  try {
    state = { ...state, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {}

  function save() {
    try {
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(state), 'utf8');
    } catch (e) {
      log(`觉醒状态存不下来：${e.message}`);
    }
  }

  const cfg = () => {
    const root = cfgOf() || {};
    return {
      ...DEFAULTS,
      ...(root.awake ?? {}),
      /**
       * 收尾冷却的**唯一真相在 `closing.coolMinutes`**（跟 `closing.json` 同源）。
       *
       * 这里不另开一个 `awake.closeCoolMinutes` 让人配——两份配置必然会漂，
       * 而漂的表现是「面板上调了 30 分钟，实际还是 90 分钟」，查起来很费劲。
       */
      closeCoolMinutes: root.closing?.coolMinutes ?? DEFAULTS.closeCoolMinutes,
    };
  };

  /**
   * 有人说话时调一下。
   *
   * @param {string} chatId
   * @param {'c2c'|'group'} [kind] 不传按群处理（老调用点兼容）
   *
   * 私聊和群记的是**两件不同的事**：私聊记「多久没聊」（喂给 miss 机会），
   * 群记「冷场多久了 + 退避」（喂给插话的四道门）。以前不分，
   * 私聊的 openid 被写进群状态表，而私聊决策读的却是 speakUp 的
   * `lastOwnerAt`——那条路径在 `speakUp.chatId` 空着时永远不更新，
   * 于是私聊的「沉默多久」永远是 99 小时，miss 机会每轮都成立。
   */
  function noteUser(chatId, kind = 'group') {
    if (!chatId) return;
    if (kind === 'c2c') {
      state.c2c = { ...(state.c2c || {}), lastUserAt: now() };
      /**
       * 顺手把历史上误写进 groups 的那条清掉。
       *
       * 不写迁移脚本：这条数据本身无害（候选群来自白名单），
       * 主人下次说话就自然消失，比在启动时批量改文件安全。
       */
      if (state.groups[chatId]) delete state.groups[chatId];
      save();
      return;
    }
    const g = state.groups[chatId] || {};
    /**
     * 顺带把退避清掉：有人说话了 = 场面变了，值得重新问她一次。
     * 不清的话，冷场之后她连跳几次，新话题来了也轮不到她开口。
     */
    state.groups[chatId] = { ...g, lastUserAt: now(), skipStreak: 0, nextAskAt: 0 };
    save();
  }

  /** 私聊最后一次收到消息的时间（`contextOf` 算 miss 用） */
  const c2cLastUserAt = () => Number(state.c2c?.lastUserAt || 0);

  function groupState(chatId) {
    return state.groups[chatId] || {};
  }

  /**
   * C3：上一次主动说出去之后，主人一直没回。
   *
   * 在**下一次 compose 之前**结算：又轮到她想说话了，说明上一次确实没人接。
   * 连续两次才降权，一次可能只是对方在忙。`settled` 由 noteOwnerReply /
   * feedback 置回 true；老盘没有这个字段（undefined）时这里直接跳过，
   * 保证升级上来的部署行为不变。
   */
  function settleNoReply() {
    if (state.settled !== false) return;
    state.noReplyStreak = Number(state.noReplyStreak || 0) + 1;
    if (state.noReplyStreak >= 2 && KINDS.includes(state.lastWakeKind)) {
      state.kindWeights = adjustKindWeights(state.kindWeights, state.lastWakeKind, -NO_REPLY_PENALTY);
      log(`主动 ${state.lastWakeKind} 连续 ${state.noReplyStreak} 次没回音，权重降了 ${NO_REPLY_PENALTY}`);
    }
    state.settled = true;
    save();
  }

  /** C3：官方点赞点踩（/mood）——比文本分类可靠，优先走这条 */
  function feedback({ positive, kind = '' } = {}) {
    if (typeof positive !== 'boolean') return false;
    /** 显式传了不认识的 kind 就拒，别悄悄退回 lastWakeKind 调错一类 */
    const k = kind ? (KINDS.includes(kind) ? kind : '') : (state.lastWakeKind || state.lastKind);
    if (!KINDS.includes(k)) return false;
    /**
     * 同一条回复只结算一次（镜像窗口）：先回了「好呀」、5 分钟内又点 /mood 赞，
     * 不该把 ±0.05 算两遍。noteOwnerReply 那边已有同款窗口，这里补上反向。
     * 只清「没回音」状态，不刷 lastFeedbackAt，免得把窗口一路往后推。
     */
    if (state.lastFeedbackAt > 0 && now() - state.lastFeedbackAt < 5 * MINUTE) {
      state.noReplyStreak = 0;
      state.settled = true;
      save();
      return false;
    }
    state.kindWeights = adjustKindWeights(
      state.kindWeights, k, positive ? KIND_WEIGHT_STEP : -KIND_WEIGHT_STEP,
    );
    state.noReplyStreak = 0;
    state.settled = true;
    state.lastFeedbackAt = now();
    save();
    return true;
  }

  /** C3：主人下一条私聊回复的文本分类（补充信号） */
  function noteOwnerReply(text) {
    const c = classifyOwnerReply(text);
    /** 有回音就清计数、结算上一次主动——跟态度是正还是中性无关 */
    state.noReplyStreak = 0;
    state.settled = true;
    /**
     * 同一条回复只结算一次：先点了赞、又顺手回一句「好呀」，不该 ±0.05 算两遍。
     * 5 分钟窗口覆盖「点完按钮再打字」的间隔。
     */
    const justSettled = state.lastFeedbackAt > 0 && now() - state.lastFeedbackAt < 5 * MINUTE;
    if (c !== 'neutral' && !justSettled) {
      const k = state.lastWakeKind || state.lastKind;
      if (KINDS.includes(k)) {
        state.kindWeights = adjustKindWeights(
          state.kindWeights, k, c === 'positive' ? KIND_WEIGHT_STEP : -KIND_WEIGHT_STEP,
        );
        state.lastFeedbackAt = now();
      }
    }
    save();
    return c;
  }

  /**
   * **只做决定，不发送**。这是整套东西的分工线：
   *   · `speakup.js` 管「什么时候轮到她」（间隔、日上限、免打扰，已有测试）
   *   · 这里管「这次说什么、要不要说」
   *   · `channel.js` 管「怎么发出去」
   * 三件事分开，任何一件换实现都不用动另外两件。
   *
   * @param {'c2c'|'group'} kind
   * @param {string} [chatId] 群聊时必填；私聊传主人的 openid，不传就按配置兜底
   * @param {string} [extraPrompt] 主人自己写的额外指令（`speakUp.prompt`）
   * @returns {Promise<{speak:boolean, text:string, kind:string, why:string}>}
   */
  async function compose({ kind = 'c2c', chatId = '', extraPrompt = '' } = {}) {
    /** C3：先把上一次「说了没人理」结算掉，再用新权重算这一轮的机会 */
    settleNoReply();
    const c = cfg();
    const ctx = contextOf?.({ kind, chatId }) || {};
    const opps = opportunities({
      now: now(),
      mood: ctx.mood,
      agreements: ctx.agreements,
      /**
       * 随性额度**必须从这里补进来**。
       *
       * `ctx.state` 是宿主给的（`lastOwnerAt` / `closedAt`），它不知道
       * 「今天随性说过几次」——那是 `awake.json` 自己记的账。
       * 以前两边没接上：`opportunities()` 从 `ctx.state.casualCount` 读，
       * 写入点却是 `state.casualCount`，读的和写的不是一个对象，
       * 所以即使有人写了，读到的也永远是 0。
       */
      state: {
        ...(ctx.state || {}),
        casualDay: state.casualDay,
        casualCount: state.casualCount,
      },
      // 群里不给"随性"机会：群聊随性插话最容易招人烦
      cfg: kind === 'group' ? { ...c, casualPerDay: 0 } : c,
      // 群里也没有"想你"：她不在群里等谁，等谁的是私聊
      noMiss: kind === 'group',
      /** C2：惦记只作用私聊随性这一档；群主动传进来也不该被抬分 */
      pending: kind === 'group' ? '' : ctx.pending,
      /** C3：反馈后的权重直接影响「该不该开口」（过阈值之前乘） */
      weights: state.kindWeights,
    });
    if (!opps.length) return { speak: false, text: '', kind: '', why: '没有值得说的机会', asked: false };

    const opp = pickOpportunity(opps, rand);
    if (!opp) return { speak: false, text: '', kind: '', why: '没有值得说的机会', asked: false };

    const prompt = buildWakePrompt({
      opp,
      ctx,
      group: kind === 'group' ? { name: ctx.name, idShort: String(chatId).slice(0, 8) } : null,
      extra: extraPrompt,
    });

    let raw = '';
    try {
      raw = await generate(prompt, { kind, chatId });
    } catch (e) {
      return { speak: false, text: '', kind: opp.kind, why: `调模型失败：${e.message}`, error: true, asked: true };
    }

    const v = parseVerdict(raw);
    /**
     * C1：模型写出来的正文若和最近几次主动文本太像，直接当「这次不说」。
     * 不重生成一次——那要再花一次模型调用，而且第二遍常常只是换个语气，
     * 照样像复读。少说一句永远比重复一句安全。
     */
    const dup = v.speak && isDuplicateText(v.text, ctx.recentBot);
    state.lastKind = opp.kind;
    state.lastWhy = opp.reason;
    /**
     * 「上次醒来是什么时候」。
     *
     * 这个字段从第 5 期就声明在状态里，但**全仓零写入点**——永远是 0。
     * 「醒来」= 真的问过模型（说没说都算），所以写在这里，
     * 不写在发送成功之后：问了但决定不说是醒过的，问了但没发出去也是醒过的。
     */
    state.lastWakeAt = now();
    if (!v.speak || dup) {
      const why = dup ? '和最近主动说过的话太像（防复读）' : v.why;
      log(`觉醒了但没说（${opp.kind}）：${why}`);
      save();
      return { speak: false, text: '', kind: opp.kind, why, asked: true, ...(dup ? { duplicate: true } : {}) };
    }
    /**
     * 「随性每天最多一次」的计数。
     *
     * `opportunities()` 一直在读 `casualDay` / `casualCount`，但**全仓没有
     * 一处写**——`casualUsed` 永远 0，这条限制从上线起就没生效过。
     * 实测 `awake.json` 是 `casualCount: 0` 而 `lastKind: "casual"`，
     * 正好把「挑到过 casual 但没记账」这件事摆出来了。
     *
     * 记账放在**决定说**这一刻，不放在发送成功之后：发送失败时 `speakup`
     * 会把下一次推到 3–8 小时后，这一次机会本来也已经花掉了。
     * 宁可少说一句，也不能在同一个额度里反复开口。
     */
    if (opp.kind === 'casual') {
      const today = dayKey(now());
      state.casualCount = state.casualDay === today ? Number(state.casualCount || 0) + 1 : 1;
      state.casualDay = today;
    }
    /**
     * C3：这次说出口了，等主人下一条私聊回复来结算。
     * 群主动不记：群里的插话没有「等主人回」这回事，混进来会误伤私聊权重。
     */
    if (kind === 'c2c') {
      state.lastWakeKind = opp.kind;
      state.settled = false;
    }
    save();
    return { speak: true, text: v.text, kind: opp.kind, why: opp.reason, asked: true };
  }

  /** 群主动的一轮检查：每群单独问，各自决定 */
  async function wakeGroups() {
    const c = cfg();
    if (!c.groups?.length) return [];
    const cands = groupCandidates({
      groups: c.groups,
      authzOf,
      stateOf: groupState,
      cfg: c,
      now: now(),
    });
    const results = [];
    for (const cand of cands) {
      if (!cand.ok) {
        results.push(cand);
        continue;
      }
      const v = await compose({ kind: 'group', chatId: cand.chatId });
      if (!v.speak) {
        /**
         * 她决定不说 —— 记一笔退避，别原地重问。
         *
         * 不记的话状态一点没变，下一轮（5 分钟后）同样的条件再次成立，
         * 于是一直问到跨天。逐次翻倍是为了让「连续几次都不想说话」的群自己静下来。
         *
         * **调模型失败也走这条路**：失败还每 5 分钟重试一遍，是另一种烧法。
         *
         * `asked === false` 是「压根没问模型」（没有值得说的机会），
         * 那不花钱，也就不该退避——退避了反而会让面板显示一个不存在的理由。
         */
        if (v.asked) {
          const g = state.groups[cand.chatId] || {};
          const streak = Math.min(Number(g.skipStreak || 0) + 1, 20);
          state.groups[cand.chatId] = {
            ...g,
            skipStreak: streak,
            nextAskAt: now() + skipBackoffMs(streak, c),
          };
          save();
        }
        results.push({ ...cand, ok: false, why: v.why, kind: v.kind });
        continue;
      }
      const r = await channelOf().send({
        scene: 'group',
        target: cand.chatId,
        text: v.text,
        hasGroupAuthz: true,
        // 「说完这句，让我静静」——群主动也认这个标记
        silenceMs: v.silenceMs || 0,
      });
      if (r?.ok) {
        const today = dayKey(now());
        const g = state.groups[cand.chatId] || {};
        state.groups[cand.chatId] = {
          ...g,
          day: today,
          count: g.day === today ? Number(g.count || 0) + 1 : 1,
          lastBotAt: now(),
          // 这次发成功了，之前的封禁和退避自然作废
          blockedUntil: 0,
          skipStreak: 0,
          nextAskAt: 0,
        };
        save();
        log(`在群 ${cand.name} 主动说了话（${v.kind}）：${v.text.slice(0, 40)}`);
      } else if (r?.code === 'quota') {
        /**
         * 这个群的主动额度今天用完了，等跨天。
         *
         * 不处理的话检查循环每 5 分钟空撞一次，一直到跨天（288 次无效请求
         * 加 288 行 warn）。`rate`（一分钟限流）不封——5 分钟一轮本来就不会撞上，
         * 真撞上了下一轮自然就好了。
         */
        const g = state.groups[cand.chatId] || {};
        state.groups[cand.chatId] = {
          ...g,
          blockedUntil: scheduleNextDay({ awakeFrom: c.awakeFrom }, now()),
        };
        save();
        log(`群 ${cand.name} 主动额度用完，今天不再试`);
      }
      results.push({
        ...cand,
        ok: Boolean(r?.ok),
        /**
         * 进了审核：`ok` 为真，但**还不能算「说到了」**。
         *
         * 官方 304023 之后审核结果推到框架侧，这边只能等投递跟踪
         * 回来问（`src/delivery.js`）。面板上「说了」和「说了但在等审核」
         * 必须长得不一样，否则人会把一条可能被驳的消息当成已经送达。
         */
        pending: Boolean(r?.pending),
        why: r?.ok ? (r?.pending ? '说了（等审核）' : '说了') : r?.message,
        kind: v.kind,
        text: r?.ok ? v.text : '',
      });
    }
    return results;
  }

  return {
    noteUser,
    compose,
    wakeGroups,
    /** C3：官方点赞点踩 / 主人回复文本，两个反馈入口 */
    feedback,
    noteOwnerReply,
    /** 私聊最后一次收到消息的时间戳（0 = 没记录）。`contextOf` 算「想你」用它 */
    c2cLastUserAt,
    /** 某个群的觉醒状态（面板/日志看"为什么不说话"用） */
    groupState: (chatId) => state.groups[chatId] || {},
    /** 面板用 */
    status: () => ({
      ...state,
      cfg: cfg(),
      lastOpportunities: (() => {
        try {
          const ctx = contextOf?.({ kind: 'c2c' }) || {};
          return opportunities({
            now: now(), mood: ctx.mood, agreements: ctx.agreements,
            state: ctx.state || {}, cfg: cfg(),
            /** 面板算的机会分必须和 compose 用同一份权重与惦记，否则「她为什么不说」会答错 */
            pending: ctx.pending, weights: state.kindWeights,
          });
        } catch {
          return [];
        }
      })(),
    }),
  };
}
