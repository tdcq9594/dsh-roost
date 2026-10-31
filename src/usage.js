/**
 * 用量记账
 * ========
 *
 * 面板原来只有「当前会话的缓存命中率」——那是调压缩阈值用的，回答不了
 * 用户真正会问的两个问题：**这个群这个月花了多少**、**哪个群最费**。
 *
 * 这里按「天 × 会话」累计 token，落一个 JSON。只记数字，不记内容。
 *
 * ## 为什么要自己算增量
 *
 * DSH 的 `tokenUsage` 是**整个会话累计**的，不是单次请求。直接累加会把
 * 累计值当增量用，数字会指数级膨胀。所以这里记住每个会话上一次的读数，
 * 只累加差值。
 *
 * 会话被压缩（换新 sessionId）后累计会归零——差值变负。这时**这一轮按全量算**：
 * 宁可多记一次，也不要因为负数把整段抹掉。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 一天一个桶，桶里按会话再分 */
const EMPTY = () => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, turns: 0 });



function dayOf(at) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addInto(bucket, delta) {
  for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output']) {
    const v = Number(delta[k]);
    if (Number.isFinite(v) && v > 0) bucket[k] += v;
  }
  bucket.turns += 1;
}

/**
 * @param {{file:string, log?:(m:string)=>void, keepDays?:number}} o
 */
export function createUsage({ file, log = () => {}, keepDays = 400 } = {}) {
  let cache = null;
  /** 每个会话上一次的读数，用来算增量 */
  const last = new Map();

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = raw && typeof raw === 'object' && raw.days ? raw : { days: {}, last: {} };
      /**
       * 把上次的读数恢复回来。
       *
       * 不恢复的话，进程重启后第一个回合会把**整个会话的累计值**当成增量再记一遍
       * ——会话是活的、累计继续往上走，等于把重启前已经记过的又记一次。
       * 表现是"重启一次，用量翻一倍"，而面板上看起来只是数字大了点。
       */
      for (const [cid, v] of Object.entries(cache.last || {})) {
        if (v && typeof v === 'object') last.set(cid, v);
      }
    } catch {
      cache = { days: {} };
    }
    return cache;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      cache.last = Object.fromEntries(last);
      fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf8');
    } catch (e) {
      log(`用量记账落盘失败：${e.message}`);
    }
  }

  /**
   * 记一轮。
   *
   * @param {{chatId:string, at?:number, usage:{uncached?:number|null, cacheRead?:number|null,
   *          cacheWrite?:number|null, output?:number|null}}} o
   * @returns {boolean} 有没有真的记上
   */
  function record({ chatId, at = Date.now(), usage } = {}) {
    if (!chatId || !usage) return false;
    const num = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) : 0);
    const cur = {
      uncached: num(usage.uncached),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      output: num(usage.output),
    };
    // 一个数都没读到时不要记 —— 否则每轮都写盘却没意义
    if (!cur.uncached && !cur.cacheRead && !cur.cacheWrite && !cur.output) return false;

    /**
     * **必须先 load()**：它会顺手把上次的读数恢复进 `last`。
     * 放在算完差值之后，重启后的第一次记录就会把整个会话累计再记一遍。
     */
    const m = load();

    const prev = last.get(chatId) || { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let delta = {
      uncached: cur.uncached - prev.uncached,
      cacheRead: cur.cacheRead - prev.cacheRead,
      cacheWrite: cur.cacheWrite - prev.cacheWrite,
      output: cur.output - prev.output,
    };
    /**
     * 任何一个变负 = 会话被压缩过（累计归零）。
     * 这时把当前读数整份当成这一轮的增量，而不是丢掉。
     */
    if (Object.values(delta).some((x) => x < 0)) delta = { ...cur };

    /**
     * 读数没动 = 这一轮没有模型调用（被跳过、被静默、或者纯本地动作）。
     * 不记——否则"轮数"会把没花钱的回合也算进去，看起来像每轮都在烧 token。
     */
    if (!Object.values(delta).some((x) => x > 0)) {
      last.set(chatId, cur);
      return false;
    }
    last.set(chatId, cur);

    const day = dayOf(at);
    const bucket = (m.days[day] = m.days[day] || { total: EMPTY(), chats: {} });
    addInto(bucket.total, delta);
    const cb = (bucket.chats[chatId] = bucket.chats[chatId] || EMPTY());
    addInto(cb, delta);

    prune(m, at);
    save();
    return true;
  }

  /** 只留最近 keepDays 天 */
  function prune(m, at) {
    const keys = Object.keys(m.days).sort();
    if (keys.length <= keepDays) return;
    for (const k of keys.slice(0, keys.length - keepDays)) delete m.days[k];
  }

  /**
   * 汇总。
   * @param {{days?:number, now?:number}} [o]
   */
  function summary({ days = 7, now = Date.now() } = {}) {
    const m = load();
    /**
     * 按**日历天**往回数，不是"最近 N 个有数据的天"。
     *
     * 后者在中间断更时会误导：面板写着「近 7 天」，实际横跨了半个月。
     * 没有数据的天补零，图表和时间轴才对得上。
     */
    const want = Math.max(1, Math.min(Number(days) || 7, 400));
    const keys = [];
    for (let i = want - 1; i >= 0; i--) keys.push(dayOf(now - i * 86400000));
    const out = {
      days: keys.map((d) => {
        const b = m.days[d];
        return b ? { day: d, ...b.total } : { day: d, ...EMPTY() };
      }),
      /** 区间内按会话合计（谁最费） */
      chats: {},
      total: { ...EMPTY() },
    };
    for (const d of keys) {
      const b = m.days[d];
      if (!b) continue; // 那天没有任何数据（日历补齐的空白天）
      for (const [cid, v] of Object.entries(b.chats || {})) {
        const t = (out.chats[cid] = out.chats[cid] || EMPTY());
        for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output', 'turns']) t[k] += v[k] || 0;
      }
      for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output', 'turns']) out.total[k] += b.total[k] || 0;
    }
    /** 命中率：和 compact.readUsage 同一口径（三个计费桶之和做分母） */
    const billed = out.total.uncached + out.total.cacheRead + out.total.cacheWrite;
    out.total.cacheHit = billed ? Number(((out.total.cacheRead / billed) * 100).toFixed(1)) : null;
    return out;
  }

  return { record, summary, dayOf, _reset: () => { cache = { days: {} }; last.clear(); } };
}
