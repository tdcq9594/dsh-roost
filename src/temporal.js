/**
 * 中文时间定位（照 Hindsight `chinese_temporal_periods.py` 的思路精简）。
 *
 * 用户说「上个月说的那件事」，检索不该把「上个月」当关键词——它该变成
 * 一个日期范围，把候选日记按 at 缩到那个月。Hindsight 那套 1845 行覆盖
 * 农历/节气/歧义消解，这里只做 roost 用得上的常见口语，覆盖不了就返回
 * null（**不加任何过滤**，行为与以前逐字一致——只增不减）。
 *
 * 纯函数：不碰数据库、不碰模型，now 注入以便测试。
 *
 * @returns {{from:number, to:number, label:string, rest:string}|null}
 *   from/to 是毫秒时间戳（闭开区间 [from, to)）；rest 是去掉时间词后的查询。
 */

const DAY = 86_400_000;

/** 把时间戳/Date 规到本地零点（时间词都按用户本地日界算） */
function startOfDay(v) {
  const d = v instanceof Date ? v : new Date(v);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function addDays(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}
function startOfMonth(v) {
  const d = v instanceof Date ? v : new Date(v);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
function shiftMonth(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}
/** 中文数字 → 整数（支持 一二三…十 十一 二十 廿 半） */
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function cnNumber(s) {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  if (s === '十') return 10;
  if (s === '廿') return 20;
  if (s.length === 1) return CN_DIGIT[s] ?? null;
  let total = 0;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const hi = a ? (CN_DIGIT[a] ?? 1) : 1;
    const lo = b ? (CN_DIGIT[b] ?? 0) : 0;
    total = hi * 10 + lo;
    if (total > 0) return total;
  }
  if (s.includes('百')) {
    const [a, b] = s.split('百');
    return (a ? (CN_DIGIT[a] ?? 1) : 1) * 100 + (b ? (cnNumber(b) || 0) : 0);
  }
  return null;
}

/**
 * 规则表：按「先具体后宽泛」排序，命中第一条就返回。
 * 每条 `{ re, make }`：make(m, now) → {from,to,label}。
 */
const RULES = [
  /** 绝对年月：2024年3月 / 2024年 / 3月（3月按今年，跨年模糊时交给后面的相对词） */
  {
    re: /(\d{4})年(\d{1,2})月(?:份)?/,
    make: (m) => {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (mo < 1 || mo > 12) return null;
      return { from: new Date(y, mo - 1, 1).getTime(), to: new Date(y, mo, 1).getTime(), label: `${y}年${mo}月` };
    },
  },
  {
    re: /(\d{4})年/,
    make: (m) => {
      const y = Number(m[1]);
      return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: `${y}年` };
    },
  },
  /** 相对日期：N天前 / N周前 / N个月前 / N年前 */
  {
    re: /(前天|昨天|昨日|今天|今日)/,
    make: (m, now) => {
      const map = { 前天: -2, 昨天: -1, 昨日: -1, 今天: 0, 今日: 0 };
      const day = addDays(startOfDay(now), map[m[1]]);
      return { from: day, to: addDays(day, 1), label: m[1] };
    },
  },
  {
    re: /([一二两俩三四五六七八九十\d]+)个月前/,
    make: (m, now) => {
      const n = cnNumber(m[1]);
      if (!n || n < 1) return null;
      /** 「三个月前」= 那一整个月，不是「三个月前至今」（那是 N 天前的语义） */
      const from = shiftMonth(startOfMonth(now), -n);
      return { from, to: shiftMonth(startOfMonth(now), -n + 1), label: `${m[1]}个月前` };
    },
  },
  {
    re: /([一二两俩三四五六七八九十\d]+)年前/,
    make: (m, now) => {
      const n = cnNumber(m[1]);
      if (!n || n < 1) return null;
      const d = new Date(now);
      return { from: new Date(d.getFullYear() - n, d.getMonth(), d.getDate()).getTime(), to: now + 1, label: `${m[1]}年前至今` };
    },
  },
  {
    re: /([一二两俩三四五六七八九十\d]+)(?:个)?(?:星期|周)前/,
    make: (m, now) => {
      const n = cnNumber(m[1]);
      if (!n || n < 1) return null;
      const from = addDays(startOfDay(now), -7 * n);
      /** 「至今」要含今天全天，to=now+1 才不会把今天的日记排除在外 */
      return { from, to: now + 1, label: `${m[1]}周前至今` };
    },
  },
  {
    re: /([一二两俩三四五六七八九十\d]+)天前/,
    make: (m, now) => {
      const n = cnNumber(m[1]);
      if (!n || n < 1) return null;
      const from = addDays(startOfDay(now), -n);
      /** 同上：「至今」含今天，to 不能用今天零点（会漏掉今天说的话） */
      return { from, to: now + 1, label: `${m[1]}天前至今` };
    },
  },
  /** 上个粒度：上个月 / 上月 / 上周 / 上个星期 / 去年 */
  {
    re: /(上个月|上月)/,
    make: (_m, now) => {
      const from = shiftMonth(startOfMonth(now), -1);
      return { from, to: startOfMonth(now), label: '上个月' };
    },
  },
  {
    re: /(上周|上个星期|上星期)/,
    make: (_m, now) => {
      /** 周一为一周起点；JS getDay(): 0=日 */
      const dow = (new Date(startOfDay(now)).getDay() + 6) % 7;
      const thisMon = addDays(startOfDay(now), -dow);
      const lastMon = addDays(thisMon, -7);
      return { from: lastMon, to: thisMon, label: '上周' };
    },
  },
  {
    re: /去年/,
    make: (_m, now) => {
      const y = new Date(now).getFullYear() - 1;
      return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime(), label: '去年' };
    },
  },
  /** 最近 N 天 / N 天来 */
  {
    re: /(?:最近|这|近)([一二两俩三四五六七八九十\d]+)天/,
    make: (m, now) => {
      const n = cnNumber(m[1]);
      if (!n || n < 1) return null;
      const from = addDays(startOfDay(now), -(n - 1));
      return { from, to: now + 1, label: `最近${m[1]}天` };
    },
  },
];

export function parseTemporal(query, now = Date.now()) {
  const s = String(query ?? '');
  if (!s) return null;
  for (const { re, make } of RULES) {
    const m = s.match(re);
    if (!m) continue;
    const range = make(m, now);
    if (!range) continue;
    if (!(range.from < range.to)) continue;
    /** rest 去掉整条匹配（时间词），给 FTS 用；空了也没关系（还有实体/向量路） */
    const rest = s.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    return { ...range, rest };
  }
  return null;
}

/** 给召回日志/面板用的简短说明 */
export function temporalLabel(t) {
  return t ? t.label : '';
}
