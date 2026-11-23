/**
 * 记忆统计快照（A2）
 * =================
 *
 * 对齐 Hindsight `/stats` + `/stats/memories-timeseries` 的**展示形态**
 * （规模计数 + 按 period 分桶的时序），但落在我方形态里：纯函数聚合已经
 * 存在的数据源，**不写盘、不新增存储、不引入第二套统计台账**。
 *
 * 为什么是纯函数：host 那边把 `memory.listFull()` / `journal.stats()` /
 * `graph.stats()` / `usage.summary()` / 按天日记数**读出来传进来**，本模块只
 * 做合并。这样测试不用起 sqlite、不用造数据目录，也不会一不小心把只读 op
 * 写成带副作用的东西——A2 的验收就是「只读不改字节」。
 *
 * 按天时序：调用方传 `days: [{day, count}]`（从 journal 的 `day` 索引查），
 * 本模块只负责补齐空白天、算合计。**不在本模块里连库**——那是 dry-run
 * 的教训（保持纯函数，口径靠测试快照锁死）。
 */

/** 与 usage.summary 的 `days` 上限一致 */
export const MAX_DAYS = 400;
export const DEFAULT_DAYS = 7;

/** YYYY-MM-DD（本地日，和 journal 的 day 列同口径） */
export function dayOf(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 [day,count] 列表对齐到 want 天的窗口，空白天补 0（Hindsight 同款口径） */
export function alignDays(rows = [], { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const want = Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, MAX_DAYS));
  const byDay = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = String(r?.day ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(k)) byDay.set(k, (byDay.get(k) || 0) + (Number(r?.count) || 0));
  }
  const out = [];
  for (let i = want - 1; i >= 0; i -= 1) {
    const key = dayOf(now - i * 86400000);
    out.push({ day: key, count: byDay.get(key) || 0 });
  }
  return out;
}

/**
 * 生成一张统计快照。所有入参都是「已经读好的值」，缺省给空值不报错——
 * 老库/空库要能出一张全是 0 的卡，而不是面板报错。
 *
 * @param {{global?:Array, chat?:Array, journal?:object|null, graph?:object|null,
 *          usage?:object|null, days?:Array, period?:number, now?:number}} input
 * @returns {{facts:object, journal:object, graph:object, usage:object,
 *            timeseries:Array, period:number, generatedAt:number}}
 */
export function statsSnapshot(input = {}) {
  const now = Number(input.now) > 0 ? Number(input.now) : Date.now();
  const global = Array.isArray(input.global) ? input.global : [];
  const chat = Array.isArray(input.chat) ? input.chat : [];
  const all = [...global, ...chat];
  const n = (x) => Number(x) || 0;

  /** 只数活事实：被取代(until)/归档(archivedAt)的仍占存储，但不该算"她记得的事" */
  const live = all.filter((x) => !Number(x?.until) && !Number(x?.archivedAt));
  const byTier = {};
  const byStatus = {};
  for (const x of live) {
    const t = String(x?.tier || 'long');
    const s = String(x?.status || 'fact');
    byTier[t] = (byTier[t] || 0) + 1;
    byStatus[s] = (byStatus[s] || 0) + 1;
  }

  const j = input.journal && typeof input.journal === 'object' ? input.journal : {};
  const g = input.graph && typeof input.graph === 'object' ? input.graph : {};
  const u = input.usage && typeof input.usage === 'object' ? input.usage : {};
  const total = u.total && typeof u.total === 'object' ? u.total : {};

  return {
    facts: {
      total: all.length,
      live: live.length,
      global: global.length,
      chat: chat.length,
      byTier,
      byStatus,
      /** 跨级能力：有证据/趋势的事实条数——证据账已落盘但能从快照看见 */
      withEvidence: live.filter((x) => n(x?.proofs) > 0 || Array.isArray(x?.evidence) && x.evidence.length > 0).length,
      directives: live.filter((x) => x?.directive === true).length,
    },
    journal: {
      total: n(j.total),
      critical: n(j.critical),
      important: n(j.important),
      normal: n(j.normal),
      /** 压缩率 = 有 digest 的条数 / 有效日记数；空库给 0 不给 NaN */
      compressed: n(j.compressed),
      compressionRate: n(j.total) ? Number((n(j.compressed) / n(j.total)).toFixed(3)) : 0,
      withVec: n(j.withVec),
      invalidated: n(j.invalidated),
      firstAt: n(j.firstAt),
      lastAt: n(j.lastAt),
    },
    graph: {
      enabled: g.enabled === true,
      entities: n(g.entities),
      edges: n(g.edges),
      ended: n(g.ended),
      episodes: n(g.episodes),
    },
    usage: {
      turns: n(total.turns),
      uncached: n(total.uncached),
      cacheRead: n(total.cacheRead),
      cacheWrite: n(total.cacheWrite),
      output: n(total.output),
      cacheHit: total.cacheHit ?? null,
      /** 金额只在调用方传了 pricing 时才有；不猜价 */
      cost: u.cost && typeof u.cost === 'object' ? u.cost : null,
    },
    timeseries: alignDays(input.days, { days: input.period, now }),
    period: Math.max(1, Math.min(Number(input.period) || DEFAULT_DAYS, MAX_DAYS)),
    generatedAt: now,
  };
}
