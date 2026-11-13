/**
 * 5.10 说话方式提炼
 * =================
 *
 * 从**主人自己的私聊**里统计「他怎么说话」，产出几句能塞进提示词的描述：
 * 平均句长、爱不爱用标点、常挂的口头禅、常用表情。
 *
 * ## 为什么只学主人私聊
 *
 * 群里说话的人多，混进来就成了「大杂烩口音」：群友爱用「草」「xswl」，
 * 主人自己不说，学过去她就会在私聊里冒网络黑话。这个模块**本身不做数据源
 * 判断**——它只吃 `rows`。真正的边界在 host：只允许 `kind === 'c2c'` 的会话
 * 进来，群聊 chatId 直接拒。为什么把边界放 host 而不是这里：这里拿不到
 * 「这个 chatId 是什么类型」，硬猜等于给调用方一个可以绕过的假安全感。
 *
 * ## 为什么不用分词
 *
 * 中文分词要带词典（几十 MB）或调模型（花钱、不可复现）。口头禅大多是
 * 2–4 字的固定串（「就是说」「emmm」「哈哈」），n-gram 统计足够，而且
 * 零依赖、结果稳定、能直接测。代价是会把「我觉得」这类常见搭配也算进来，
 * 所以有一张停用词表压着，并且要求出现 ≥3 次才入选。
 *
 * ## 产物怎么用
 *
 * `styleText` 是**给人看也给模型看**的一段话，直接拼进提示词即可。刻意写成
 * 「统计结论 + 提醒别照抄」，而不是「请模仿以下风格」——后者会让模型开始
 * 演，把统计特征夸张成口音。
 */

/** 少于这么多条就别统计了：三条消息算出来的「风格」还不如不写 */
export const MIN_SAMPLES = 20;
/** 最多看这么多条：再多也是同一批口头禅，白算 */
export const MAX_SAMPLES = 2000;
/** 口头禅至少出现这么多次才算「习惯」，一次两次是偶然 */
export const MIN_PARTICLE_COUNT = 3;

/**
 * 停用词：这些 n-gram 出现频率必然高，但它们是语言本身，不是个人习惯。
 *
 * 只收「高频且无个人特征」的：代词、助词、常见动词、时间词、连接词。
 * 收太多会把真口头禅一起压掉（比如「就是」既是停用词也是很多人的口头禅），
 * 所以这里只收**单字 + 最通用的双字**，「就是说」「就是说嘛」这类三字以上
 * 仍然能选出来。
 */
const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '就', '不', '也', '都', '要', '会', '有', '这', '那', '个', '上', '下', '去', '来', '说', '着', '过', '吧', '啊', '呢', '吗', '呀', '哦', '嗯', '哈',
  '我们', '你们', '他们', '什么', '怎么', '这个', '那个', '这样', '那样', '可以', '没有', '不是', '就是', '还是', '因为', '所以', '但是', '然后', '现在', '时候', '一个', '一下', '一点', '知道', '觉得', '应该', '可能', '真的', '其实', '已经', '如果', '虽然', '而且', '或者', '自己', '大家',
]);

/** 结尾标点习惯 */
const END_PUNCT = {
  period: /[。.]$/,
  question: /[？?]$/,
  exclaim: /[！!]$/,
  tilde: /[~～]/,
  ellipsis: /…|\.{3,}/,
};

/**
 * 表情 / emoji：只认最常见的几段码位，不做完整 Unicode 表。
 * 目的是「这人爱不爱用表情」，不是精确识别每一个。
 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 句子长度按**字符**算（`[...str].length`），别用 `.length`——emoji 会算成 2 */
const charLen = (s) => [...s].length;

/**
 * 抽 n-gram 候选：2–4 字，纯中文/字母，不含数字与标点。
 *
 * 只在「句内」抽，不跨标点——跨标点拼出来的「了吗」没有意义。
 */
function gramsOf(text) {
  const out = [];
  for (const seg of text.split(/[，。！？、；：,.!?;:\s~～…]+/)) {
    const s = seg.trim();
    if (!s) continue;
    const chars = [...s];
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= chars.length; i += 1) {
        const g = chars.slice(i, i + n).join('');
        /** 纯中文或纯字母才算候选；混数字（「123」）和标点一律跳过 */
        if (!/^[\u4e00-\u9fa5]+$|^[a-zA-Z]+$/.test(g)) continue;
        out.push(g);
      }
    }
  }
  return out;
}

/**
 * 分析一批「主人说的话」。
 *
 * @param {Array<{text:string, at?:number, role?:string}>} rows
 * @param {{minSamples?:number, topN?:number, now?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, samples:number, avgLen:number,
 *            shortRatio:number, particles:Array<{w:string,n:number}>,
 *            punct:object, emoji:Array<{e:string,n:number}>,
 *            styleText:string, warnings:string[]}}
 */
export function analyzeStyle(rows, opts = {}) {
  const minSamples = Number(opts.minSamples) || MIN_SAMPLES;
  const topN = Math.max(1, Math.min(30, Number(opts.topN) || 12));
  const warnings = [];

  const all = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      id: String(r?.id ?? ''),
      text: norm(r?.text),
      at: Number(r?.at) || 0,
      role: String(r?.role || 'user'),
    }))
    /** 只要主人说的：`role` 不是 user 的是她自己回的，学进去就成了自问自答 */
    .filter((r) => r.role === 'user' && r.text);

  /**
   * 按 **消息 id** 去重，不按正文。
   *
   * 合并窗口 + 重试会让同一条消息来两次，那是真重复；但「好呀」说了十遍
   * 是**习惯本身**，按正文去重等于把这个信号抹掉（第一版就是这么错的，
   * 测出来「好呀」只有 1 条样本）。没带 id 的行不去重——调用方给不出 id 时，
   * 宁可多算也不要把频次丢掉。
   */
  const seen = new Set();
  const texts = [];
  for (const r of all) {
    if (r.id) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    texts.push(r.text);
    if (texts.length >= MAX_SAMPLES) break;
  }

  const samples = texts.length;
  if (samples < minSamples) {
    return {
      ok: false,
      reason: `只有 ${samples} 条能用来统计，至少要 ${minSamples} 条才看得出习惯`,
      samples,
      avgLen: 0,
      shortRatio: 0,
      particles: [],
      punct: {},
      emoji: [],
      styleText: '',
      warnings,
    };
  }

  const lens = texts.map(charLen);
  const avgLen = lens.reduce((a, b) => a + b, 0) / samples;
  /** 「短句」的门槛定 10 字：中文一句话说到 10 字以上通常已经是在讲事了 */
  const shortRatio = lens.filter((n) => n <= 10).length / samples;

  /* ---- 口头禅 ---- */
  const count = new Map();
  for (const t of texts) {
    for (const g of new Set(gramsOf(t))) count.set(g, (count.get(g) || 0) + 1);
  }
  const particles = [...count.entries()]
    .filter(([w, n]) => n >= MIN_PARTICLE_COUNT && !STOP.has(w))
    /**
     * 子串压制：`就是说嘛` 和 `就是说` 同时高频时只留长的那个。
     * 否则列表里会出现三条互相包含的，看着像复读。
     * 先按次数降序、再按长度降序，保证长的先占位。
     */
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .reduce((acc, [w, n]) => {
      if (acc.some(([kept]) => kept.includes(w) || w.includes(kept))) return acc;
      acc.push([w, n]);
      return acc;
    }, [])
    .slice(0, topN)
    .map(([w, n]) => ({ w, n }));

  /* ---- 标点习惯 ---- */
  const hits = { period: 0, question: 0, exclaim: 0, tilde: 0, ellipsis: 0 };
  for (const t of texts) {
    for (const [k, re] of Object.entries(END_PUNCT)) if (re.test(t)) hits[k] += 1;
  }
  const punct = {
    /** 句末加句号的占比：很低说明习惯不加 */
    periodRatio: hits.period / samples,
    questionRatio: hits.question / samples,
    exclaimRatio: hits.exclaim / samples,
    tildeRatio: hits.tilde / samples,
    ellipsisRatio: hits.ellipsis / samples,
  };

  /* ---- 表情 ---- */
  const emo = new Map();
  for (const t of texts) {
    for (const e of t.match(EMOJI_RE) || []) emo.set(e, (emo.get(e) || 0) + 1);
  }
  const emoji = [...emo.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([e, n]) => ({ e, n }));

  if (samples < minSamples * 3) warnings.push(`样本只有 ${samples} 条，结论可能不稳`);

  return {
    ok: true,
    samples,
    avgLen: Math.round(avgLen * 10) / 10,
    shortRatio: Math.round(shortRatio * 100) / 100,
    particles,
    punct,
    emoji,
    styleText: styleTextOf({ samples, avgLen, shortRatio, particles, punct, emoji }),
    warnings,
  };
}

/**
 * 把统计结果写成一段话。
 *
 * 措辞刻意是「他习惯…」而不是「请模仿…」：后者会让模型开始演口音，
 * 把「偶尔用~」夸张成每句都带波浪号。
 */
export function styleTextOf(p) {
  const parts = [];
  const avg = Number(p.avgLen) || 0;
  const short = Number(p.shortRatio) || 0;

  if (avg <= 8) parts.push(`句子很短，平均 ${avg} 字`);
  else if (avg <= 16) parts.push(`句子中等偏短，平均 ${avg} 字`);
  else parts.push(`句子偏长，平均 ${avg} 字`);
  if (short >= 0.6) parts.push(`${Math.round(short * 100)}% 的消息不超过 10 字`);

  if (p.particles?.length) {
    parts.push(`常挂的口头禅：${p.particles.slice(0, 6).map((x) => `「${x.w}」`).join('、')}`);
  }

  const pu = p.punct || {};
  const habit = [];
  if ((pu.periodRatio ?? 0) < 0.2) habit.push('句末一般不加句号');
  else if ((pu.periodRatio ?? 0) > 0.7) habit.push('习惯给每句话加句号');
  if ((pu.tildeRatio ?? 0) > 0.2) habit.push('爱用波浪号 ~');
  if ((pu.ellipsisRatio ?? 0) > 0.15) habit.push('常用省略号');
  if ((pu.exclaimRatio ?? 0) > 0.25) habit.push('感叹号用得多');
  if ((pu.questionRatio ?? 0) > 0.3) habit.push('爱反问');
  if (habit.length) parts.push(habit.join('，'));

  if (p.emoji?.length) {
    parts.push(`偶尔用表情：${p.emoji.slice(0, 4).map((x) => x.e).join(' ')}`);
  }

  const body = parts.join('；');
  return `说话方式（从 ${p.samples} 条私聊里统计）：${body}。这是统计结论，用来校准长度和语气，不要逐字照抄，也别把习惯夸张成口音。`;
}

/**
 * 提炼结果的存储形状：写进 `memory.json` 的一条手记，`w=2`（明说的那种）。
 *
 * 为什么进记忆而不是进人格 md：人格 md 是**设定**（她想成为谁），这段是
 * **观察**（主人实际怎么说话）。混在一起的话，换人格会把它一起换掉，
 * 而它其实与人格无关。`w=2` 保证它不会被保留策略当低价值事实清掉。
 */
export function styleMemoryEntry(result, { at = Date.now(), chatId = '' } = {}) {
  if (!result?.ok) return null;
  return {
    text: result.styleText,
    w: 2,
    at: Number(at) || Date.now(),
    scope: chatId ? `chat:${chatId}` : 'global',
    src: { manual: false, speechStyle: true },
  };
}
