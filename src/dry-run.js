/**
 * 「改了之后会动到什么」的预览计算（阶段 2 的契约，先做纯函数）。
 *
 * 为什么要单独一层：几个新开关都会动**已经存下来的数据**（旧记忆作废、
 * 人物档案、经历层、扩展权限）。用户点之前看不到后果，就只能靠「先备份、
 * 不行再恢复」兜底。所以这些开关一律先跑 dry-run，把命中条数和原因摆出来，
 * 用户确认了才写配置。
 *
 * 这里只做计算，不读盘、不写盘、不改任何条目。host 在 `features.preview`
 * 里把真实条目喂进来（阶段 4c 接线），面板拿 `formatImpact()` 的结果渲染。
 * 保持纯函数是为了能直接测边界，不用搭一整套数据库。
 */

/** 需要 dry-run 预览的开关（§16.5：影响数据的开关都要带） */
export const DRY_RUN_FEATURES = [
  'retentionMode',
  'profiles',
  'events',
  'extensions',
];

const DAY = 86400000;

/**
 * 一条自动提炼记忆的「保留度」。
 *
 * 和 aurabot 的 `retention()` 同名但不是同一套：
 *   · **不按「被注入过」复习**——我们 `journal.js` 明定 `accessed` 只由检索写入，
 *     自动注入不算（实测注入计数会让旧记忆霸榜、列表冻结，有测试锁死）。
 *     这里只用现有的 `lastAccess` 算 Δt，不新增 `hitDays`。
 *   · **不乘在检索分上**——`journal.search()` 是 RRF k=60 名次融合，
 *     名次差只有 1.6%，任何乘数都会反转顺序。这个 R 只用来挑「哪些条目
 *     该退出候选集与注入」，绝不改名次。
 *   · **结果不是删除**：调用方拿到 id 后标 `expiredAt`，原文留在库里。
 */
export function retentionR(entry, now = Date.now()) {
  const at = Number(entry?.at) || now;
  const last = Number(entry?.lastAccess) || at;
  const ageDays = Math.max(0, (now - Math.max(at, last)) / DAY);
  const importance = Math.min(1, Math.max(0, Number(entry?.importance ?? 0.5)));
  const tau = 20 * (0.5 + importance);
  return Math.exp(-ageDays / tau);
}

/** 这条能不能参与过期。用户明说记住的、手记的、日记、重要的一律不碰 */
export function canExpire(entry) {
  if (!entry || entry.expiredAt) return false;
  if (entry.source !== 'auto') return false;
  if (Number(entry.importance ?? 0.5) >= 0.6) return false;
  if (entry.critical) return false;
  return true;
}

/**
 * 算出「按这套配置，哪些条目会被作废」。
 *
 * @param {Array<{id:string,at?:number,lastAccess?:number,importance?:number,
 *                source?:string,critical?:boolean,expiredAt?:number,text?:string}>} entries
 * @param {{mode?:string,thresholdPct?:number,minProtectDays?:number}} opts
 * @param {number} now
 * @returns {{enabled:boolean,mode:string,total:number,affected:number,kept:number,
 *            items:Array<{id:string,r:number,ageDays:number,reason:string}>,purge:boolean}}
 */
export function planRetention(entries = [], opts = {}, now = Date.now()) {
  const mode = String(opts.mode || 'off');
  const base = {
    mode,
    total: entries.length,
    affected: 0,
    kept: entries.length,
    items: [],
    purge: mode === 'purge',
    enabled: mode === 'expire' || mode === 'purge',
  };
  if (!base.enabled) return base;

  const pct = Number(opts.thresholdPct ?? 5);
  const threshold = (Number.isFinite(pct) ? Math.min(50, Math.max(1, pct)) : 5) / 100;
  const protectDays = Number(opts.minProtectDays ?? 30);
  const protect = (Number.isFinite(protectDays) ? Math.max(0, protectDays) : 30) * DAY;

  for (const e of entries) {
    if (!canExpire(e)) continue;
    const at = Number(e.at) || now;
    if (now - at < protect) continue; // 最短保护期
    const r = retentionR(e, now);
    if (r >= threshold) continue;
    const ageDays = Math.max(0, (now - Math.max(at, Number(e.lastAccess) || at)) / DAY);
    base.items.push({
      id: String(e.id),
      r: Math.round(r * 10000) / 10000,
      ageDays: Math.round(ageDays * 10) / 10,
      reason: `保留度 ${(r * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%`,
    });
  }
  base.affected = base.items.length;
  base.kept = entries.length - base.affected;
  return base;
}

/** 面板用的一句人话。条数 + 处置方式，不说「已删除」——默认只是作废 */
export function formatImpact(plan) {
  if (!plan) return '没算出结果';
  if (!plan.enabled) return '当前是「关」，不会动任何记忆。';
  if (!plan.affected) return '按现在的配置，没有记忆会被作废。可以先打开，随时关回来。';
  const what = plan.purge ? '真删（会先自动备份）' : '作废不删行（可一键恢复）';
  return `会影响 ${plan.affected} 条（共 ${plan.total} 条）：${what}。其余 ${plan.kept} 条不动。`;
}
