/**
 * 中文检索词：**二元组切分 + 查询侧剥疑问词**。
 *
 * 为什么不直接交给 SQLite 的 FTS5 分词器：
 *   · `unicode61` 把一整串汉字当成**一个词**——实测 `我住在杭州` 只能整串匹配，
 *     搜「杭州」返回 0 条。中文没有空格，它无从切分。
 *   · `trigram` 要求至少 3 个字——搜「杭州」（2 字）同样返回 0 条。
 * 所以索引里存的不是原文，而是**预先切好的二元组**（`我住 住在 在杭 杭州`），
 * 这样任意 2 字以上的中文查询都能命中。
 *
 * 两侧规则不一样，这是本文件唯一的要害：
 *   · **索引侧**：原样切，**绝不剥疑问词**。原文里「怎么」是内容的一部分，
 *     剥掉会让索引与原文对不上，也违反"文档侧不能动"这条铁律。
 *   · **查询侧**：把疑问/语气词换成空格当断点。因为疑问词会把主语稀释掉——
 *     「魂骨怎么获得」整串切出来带着「怎么」，命中率被拉低；
 *     换成断点后变成「魂骨」「获得」两段，正好对上文档。
 *
 * 踩过的坑：早先把疑问词直接删掉，结果「魂骨怎么获得」→「魂骨获得」，
 * 凭空多出一个「骨获」这种不存在的二元组，把覆盖率算低。
 * **替换成空格**才能既断开又不造假词。
 */

/** 汉字（含扩展 A）。韩日文字不当汉字处理，它们本来就有空格分词 */
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const HAN_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
/** 拉丁词 / 数字。`gpt-4o` 会切成 gpt / 4 / o 是不理想的，但比整句丢掉好 */
const WORD_RUN = /[a-z0-9][a-z0-9_+#.-]*/g;

/**
 * 疑问 / 语气 / 客套词。**只在查询侧**换成空格。
 *
 * 顺序要紧：长的排前面，否则「什么时候」会先被「什么」吃掉一半。
 */
const QUERY_NOISE = [
  '什么时候',
  '什么样',
  '为什么',
  '怎么样',
  '是不是',
  '有没有',
  '能不能',
  '可不可以',
  '还记得',
  '记不记得',
  '告诉我',
  '我想知道',
  '请问',
  '帮我查',
  '怎么样',
  '如何',
  '怎么',
  '什么',
  '哪些',
  '哪个',
  '哪里',
  '多少',
  '多久',
  '几点',
  '几条',
  '是谁',
  '谁说',
  '在哪',
  '吗',
  '呢',
  '吧',
  '啊',
  '呀',
  '哦',
  '嗯',
  '的话',
  /**
   * 单字「哪」放最后：前面的「哪里/哪个/哪些/在哪」先被替换掉，
   * 剩下的才是疑问语气（「我住哪」）。不加它的话会切出「住哪」这个
   * 文档里根本不会有的二元组，把覆盖率拉到 0.5 而刚好卡在门槛上。
   */
  '哪',
];

/**
 * 纯虚字。**两侧都用**，但只用来丢弃"整条都由虚字组成"的二元组。
 *
 * 例如查询「我们之前说过的杭州」切出 `我们 们之 之前 前说 说过 过的 的杭 杭州`：
 *   `我们`（两个字都是虚字）→ 丢掉，它在任何文档里都有，只会制造误命中
 *   `的杭`（含实字「杭」）→ 留着，可能就是原文里的写法
 *
 * 为什么不用整份停用词表：中文停用词表一长必然误伤（「重要」这类词
 * 一半在表里一半不在）。只丢"全虚"的二元组，足够稳。
 */
const STOP_CHARS = new Set(
  ('的了着过是在有和与或就都也还很太更最又再才只把被给让对从向往于为以并且但如果因为所以' +
    '我你他她它们这那哪个些么什怎谁吗呢吧啊呀哦嗯一二三四五六七八九十').split(''),
);

/** 归一化：统一小写、全角转半角、去掉控制字符。标点留着当断点用 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角 → 半角
    .replace(/\u3000/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

/**
 * 中文二元组：连续汉字段切成相邻两字为一组。
 *
 * 单字段（如「猫」）保留单字本身——不切的话它永远搜不到。
 * 汉字段之间的标点/空格天然成为断点，所以「杭州，喜欢」不会切出「州喜」。
 */
function hanBigrams(run) {
  if (run.length === 1) return [run];
  const out = [];
  for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  return out;
}

/** 一个汉字段 + 一个拉丁段的混合文本 → 词列表 */
function roughTerms(text) {
  const s = normalize(text);
  const out = [];
  // 汉字段
  for (const m of s.matchAll(HAN_RUN)) out.push(...hanBigrams(m[0]));
  // 拉丁/数字段：整段当词，另外补上 2 字前缀（让 v0.8 能命中 0.8.6）
  for (const m of s.matchAll(WORD_RUN)) {
    const w = m[0].replace(/[.-]+$/, '');
    if (!w) continue;
    out.push(w);
    if (w.length > 4) out.push(w.slice(0, 4));
  }
  return out;
}

/** 整条词都由虚字组成 → 它在任何文档里都有，留着只会制造误命中 */
function allStop(term) {
  for (const ch of term) if (!STOP_CHARS.has(ch)) return false;
  return true;
}

/**
 * 索引侧：**原样切，不剥任何词**。
 * @returns {string[]} 去重后的词
 */
export function indexTerms(text) {
  return [...new Set(roughTerms(text).filter((t) => t && !allStop(t)))];
}

/**
 * 查询侧：先剥疑问词（换成空格），再切，再丢掉全虚的二元组。
 * @returns {string[]} 去重后的查询词
 */
export function queryTerms(text) {
  let s = normalize(text);
  for (const w of QUERY_NOISE) {
    if (!s.includes(w)) continue;
    s = s.split(w).join(' ');
  }
  const terms = [...new Set(roughTerms(s).filter((t) => t && !allStop(t)))];
  /**
   * 剥完一个词都不剩（用户只说了「怎么」）→ 退回原句切词。
   * 否则查询条件为空，检索直接返回空，看起来像坏了。
   * 这一路**不再过滤虚词**：反正只剩虚词了，再滤就还是空。
   */
  if (terms.length) return terms;
  return [...new Set(roughTerms(normalize(text)).filter(Boolean))];
}

/** 给 FTS5 用的索引串：词之间用空格（unicode61 才能逐个当 token） */
export function indexText(text) {
  return indexTerms(text).join(' ');
}

/**
 * FTS5 MATCH 表达式。
 *
 * 每个词加双引号：词里可能带 `-` `.` `+`（拉丁词），不加引号 FTS5 会当运算符解析，
 * 直接抛 `fts5: syntax error`。
 */
export function matchExpr(terms, op = 'OR') {
  const list = (terms || []).filter(Boolean);
  if (!list.length) return '';
  return list.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(` ${op} `);
}

/**
 * 覆盖率：查询词里有几成出现在文档词里。
 *
 * 为什么要它，而不是只看 bm25：bm25 只排序、不给"是否真的相关"的判据。
 * 查询「杭州天气」时，一篇只提到「天气」的日记也会排上来。
 * 用覆盖率卡一道，误命中明显下降（这是 ai-native 那边实测过的同一问题）。
 */
export function coverage(terms, docTerms) {
  const q = [...new Set((terms || []).filter(Boolean))];
  if (!q.length) return 0;
  const doc = docTerms instanceof Set ? docTerms : new Set(docTerms || []);
  let hit = 0;
  for (const t of q) if (doc.has(t)) hit += 1;
  return hit / q.length;
}

/**
 * 覆盖率门槛。
 *
 * 短查询（1~2 个词）要求全中——「杭州」只中一个词就是 100%，没有稀释空间，
 * 放宽了反而放进无关文档。长查询允许只中三分之一。
 */
export const MIN_COVERAGE = 0.34;

export function passesCoverage(terms, docTerms) {
  const q = [...new Set((terms || []).filter(Boolean))];
  const cov = coverage(q, docTerms);
  if (q.length <= 2) return cov >= 1;
  return cov >= MIN_COVERAGE;
}
