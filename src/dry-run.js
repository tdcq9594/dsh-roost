/**
 * 「改了之后会动到什么」的预览计算（阶段 2 的契约，阶段 4c 接真实数据）。
 *
 * 只做计算，不读盘、不写盘、不改任何条目。host 在 `features.preview` /
 * `retention.apply` 里把真实条目喂进来，面板拿 `formatImpact()` 渲染。
 * 保持纯函数是为了能直接测边界，不用搭一整套数据库。
 *
 * **2026-11-08 方案订正**（主人拍板「两类都做，让用户自由开关」）：
 * 阶段 2 写的 `source==='auto'` / `importance` 两个字段在真实数据里都不存在，
 * `canExpire()` 恒返回 false，预览永远算不出命中。改按两路真实字段：
 *   · facts   —— `memory.json` 里模型自动提炼的事实（`w=1`、非手记、无 `until`），
 *               作废复用现成的 `until`；facts 没有访问时间，所以是纯时间衰减。
 *   · journal —— 日记里 `level='normal'` 的行，`accessed` / `lastAccess` /
 *               `invalidAt` 全是现成的，遗忘曲线最完整。
 * 两路各有独立 `mode`（off / expire / purge），共用阈值与最短保护期；默认都关。
 *
 * 三条铁律（报告 §8 D11 专段）：
 *   · 不按「被注入过」复习：只用检索写入的 `accessed` / `lastAccess` 算 Δt；
 *   · 不乘在检索分上：`journal.search()` 是 RRF k=60 名次融合，这个 R 只用来
 *     挑哪些条目该退出候选集，绝不改名次；
 *   · 不删除：`expire` 只作废不删行，原文留库；`purge` 才真删，且宿主先备份。
 */

/** 需要 dry-run 预览的开关（§16.5：影响数据的开关都要带） */
export const DRY_RUN_FEATURES = [
  'retentionFactsMode',
  'retentionJournalMode',
  'profiles',
  'events',
  'extensions',
];

export const RETENTION_MODES = ['off', 'expire', 'purge'];

const DAY = 86400000;

/**
 * 与 `memory.js` 的 `W_EXPLICIT`、`journal.js` 的 `ERASED/CLEARED` 对齐。
 * 这里故意不 import 那两个模块：dry-run 要保持纯函数、零副作用，而
 * `journal.js` 会连带拉起 sqlite 后端。判据一致性由 `dry-run.test.js` 锁死。
 */
const W_EXPLICIT_LINE = 2;
const PLACEHOLDER_TEXT = new Set(['（已按用户要求遗忘）', '（已清空）']);

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));

/** 一条记忆的「保留度」，R = e^(−Δt/τ)。两路共用，字段由 normalizeEntry 归一好 */
export function retentionR(entry, now = Date.now()) {
  const at = Number(entry?.at) || now;
  const last = Number(entry?.lastAccess) || at;
  const ageDays = Math.max(0, (now - Math.max(at, last)) / DAY);
  const importance = clamp01(Number(entry?.importance ?? 0.5));
  const tau = 20 * (0.5 + importance);
  return Math.exp(-ageDays / tau);
}

/**
 * 把真实条目归一化成预览用的形状；两路的字段差异只收在这一处。
 *
 * facts 没有独立 id，用正文当 id（作废/恢复也按正文精确定位）。
 * journal 的 `importance` 由**检索次数**推出来：`accessed` 只由检索写入，
 * 不是「被注入过」的计数，不违反记忆铁律。
 */
export function normalizeEntry(raw, target, chatId = '') {
  const e = raw || {};
  const base = {
    id: String(e.id ?? e.text ?? ''),
    target,
    chatId: String(chatId || e.chatId || ''),
    text: String(e.text ?? ''),
    at: Number(e.at) || 0,
    lastAccess: Number(e.lastAccess ?? e.last_access ?? 0) || 0,
    critical: Boolean(e.critical),
  };
  if (target === 'journal') {
    const accessed = Math.max(0, Number(e.accessed) || 0);
    return {
      ...base,
      level: String(e.level || 'normal'),
      kind: String(e.kind || 'chat'),
      accessed,
      invalidAt: Number(e.invalidAt ?? e.invalid_at ?? 0) || 0,
      importance: 0.5 + Math.min(0.3, Math.log1p(accessed) / 10),
    };
  }
  return {
    ...base,
    w: Number(e.w) > 0 ? Number(e.w) : 1,
    src: e.src || null,
    until: Number(e.until) > 0 ? Number(e.until) : 0,
    scope: String(e.scope || 'global'),
    importance: 0.5,
    lastAccess: 0,
  };
}

/**
 * 这条能不能参与过期。
 *
 * 两路都只碰「低价值、模型自己攒的」那批：
 * 用户明说记住的（`w>=2`）、面板手记（`src.manual`）、已作废的、critical /
 * important / digest / 已抹正文的占位行，一律不碰。
 */
export function canExpire(entry, target = 'facts') {
  if (!entry || entry.expiredAt || entry.critical) return false;
  if (target === 'journal') {
    if (Number(entry.invalidAt) > 0) return false;
    if (entry.level !== 'normal') return false;
    if (entry.kind === 'digest') return false;
    if (PLACEHOLDER_TEXT.has(String(entry.text || '').trim())) return false;
    return true;
  }
  if (Number(entry.until) > 0) return false;
  if (Number(entry.w ?? 1) >= W_EXPLICIT_LINE) return false;
  if (entry.src && entry.src.manual === true) return false;
  return true;
}

export const canExpireFacts = (entry) => canExpire(entry, 'facts');
export const canExpireJournal = (entry) => canExpire(entry, 'journal');

/**
 * 算出「按这套配置，这一路哪些条目会被作废」。
 *
 * @param {Array} entries 已归一化的条目（normalizeEntry 的输出）
 * @param {{mode?:string,thresholdPct?:number,minProtectDays?:number,target?:string}} opts
 * @param {number} now
 * @returns {{enabled:boolean,mode:string,target:string,total:number,affected:number,
 *            kept:number,items:Array<{id:string,target:string,chatId:string,scope:string,
 *            r:number,ageDays:number,reason:string}>,purge:boolean}}
 */
export function planRetention(entries = [], opts = {}, now = Date.now()) {
  const rawMode = String(opts.mode || 'off');
  const mode = RETENTION_MODES.includes(rawMode) ? rawMode : 'off';
  const target = opts.target === 'journal' ? 'journal' : 'facts';
  const base = {
    mode,
    target,
    total: entries.length,
    affected: 0,
    kept: entries.length,
    items: [],
    purge: mode === 'purge',
    enabled: mode !== 'off',
  };
  if (!base.enabled) return base;

  const pct = Number(opts.thresholdPct ?? 5);
  const threshold = (Number.isFinite(pct) ? Math.min(50, Math.max(1, pct)) : 5) / 100;
  const protectDays = Number(opts.minProtectDays ?? 30);
  const protect = (Number.isFinite(protectDays) ? Math.max(0, protectDays) : 30) * DAY;

  for (const e of entries) {
    if (!canExpire(e, target)) continue;
    const at = Number(e.at) || now;
    if (now - at < protect) continue; // 最短保护期
    const r = retentionR(e, now);
    if (r >= threshold) continue;
    const ageDays = Math.max(0, (now - Math.max(at, Number(e.lastAccess) || at)) / DAY);
    base.items.push({
      id: String(e.id),
      target,
      chatId: String(e.chatId || ''),
      scope: String(e.scope || ''),
      r: Math.round(r * 10000) / 10000,
      ageDays: Math.round(ageDays * 10) / 10,
      reason: `保留度 ${(r * 100).toFixed(1)}% < ${(threshold * 100).toFixed(0)}%`,
    });
  }
  base.affected = base.items.length;
  base.kept = entries.length - base.affected;
  return base;
}

/**
 * 两路一起算。`cfg` 传 `config.json` 的 `memory.retention` 段（也接受整个 cfg）。
 * 每路用自己的 mode：只开 facts 时 journal 一步都不会跑，这就是「自由开关」。
 */
export function planRetentionAll(sources = {}, cfg = {}, now = Date.now()) {
  const r = cfg?.retention || cfg || {};
  const common = { thresholdPct: r.thresholdPct, minProtectDays: r.minProtectDays };
  const facts = planRetention(sources.facts || [], { ...common, mode: r.factsMode, target: 'facts' }, now);
  const journal = planRetention(sources.journal || [], { ...common, mode: r.journalMode, target: 'journal' }, now);
  return {
    facts,
    journal,
    total: facts.total + journal.total,
    affected: facts.affected + journal.affected,
    enabled: facts.enabled || journal.enabled,
    purge: facts.purge || journal.purge,
  };
}

/** 面板用的一句人话。条数 + 处置方式，不说「已删除」——默认只是作废 */
export function formatImpact(plan) {
  if (!plan) return '没算出结果';
  if (!plan.enabled) return '当前是「关」，不会动任何记忆。';
  if (!plan.affected) return '按现在的配置，没有记忆会被作废。可以先打开，随时关回来。';
  const what = plan.purge ? '真删（会先自动备份）' : '作废不删行（可一键恢复）';
  return `会影响 ${plan.affected} 条（共 ${plan.total} 条）：${what}。其余 ${plan.kept} 条不动。`;
}

/** 两路汇总的那句人话；没开的路不出现在句子里 */
export function formatImpactAll(summary) {
  if (!summary || !summary.enabled) return '两路都是「关」，不会动任何记忆。';
  const parts = [];
  if (summary.facts.enabled) parts.push(`事实 ${summary.facts.affected} 条`);
  if (summary.journal.enabled) parts.push(`日记 ${summary.journal.affected} 条`);
  if (!summary.affected) return `已开 ${parts.join('、')}，按现在的配置没有记忆会被作废。`;
  const what = summary.purge ? '真删（会先自动备份）' : '作废不删行（可一键恢复）';
  return `会影响 ${parts.join('、')}：${what}。共 ${summary.total} 条里其余 ${summary.total - summary.affected} 条不动。`;
}
