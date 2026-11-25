/**
 * 目的引擎 · 运行时（P0 第六批）——移植自 aurabot-beta `src/purpose/module.js` 的
 * prepare / promptFor / runOnce / tick / fire 主链。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 这是把前五批零件串起来的一层：**到点 → 收素材 → 算驱力 → 选目的 → 拼提示词 → 生成 → 投递 → 结算**。
 *
 * 所有副作用都靠注入（`runTurn` / `deliver` / `stateStore`），所以这一层能单测：
 * 不注入真模型、不真发消息，也能验证「素材太少不硬找话」「选不出目的就跳过」这些判定。
 */
import { DEFAULT_PURPOSE_CONFIG, deriveDrives, formGoalHypotheses, DEFAULT_DRIVES } from './purpose-engine.js';
import { selectPurpose } from './purpose-select.js';
import { buildPurposePrompt } from './purpose-prompt.js';
import {
  applyPurposeOutcome, parsePurposeMemo, isDuplicateText,
} from './purpose-settle.js';
import {
  ensurePurposeDay, ensurePurposeSchedule, planNextFire, evaluatePurposeTick,
  markPurposeDelivered, markPurposeSkip, localDateKey,
} from './purpose-schedule.js';

/**
 * @param {object} o
 * @param {()=>object} o.cfgOf 读目的配置（DEFAULT_PURPOSE_CONFIG 形状）
 * @param {object} o.stateStore createPurposeState 实例（read/write）
 * @param {()=>({items:object[], stats?:object})} o.collect 收素材（含 journal + B站）
 * @param {(prompt:string, opts:object)=>Promise<string>} o.runTurn 跑一轮模型
 * @param {(text:string, purpose:object)=>Promise<'sent'|'failed'|'silent'>} o.deliver 投递
 * @param {()=>number} o.lastOwnerAt 主人最后一次说话的时刻
 * @param {()=>boolean} o.busy 会话是否正忙（忙则让位）
 * @param {()=>boolean} [o.enabled] 总开关（默认看 cfg.enabled）
 * @param {()=>boolean} [o.paused] 插件是否暂停
 * @param {object} [o.log]
 * @param {()=>number} [o.now]
 */
export function createPurposeRunner({
  cfgOf = () => ({}),
  stateStore,
  collect = () => ({ items: [] }),
  runTurn,
  deliver,
  lastOwnerAt = () => 0,
  busy = () => false,
  enabled = null,
  paused = () => false,
  log = {},
  now = () => Date.now(),
} = {}) {
  const cfg = () => ({ ...DEFAULT_PURPOSE_CONFIG, ...(cfgOf() || {}) });
  /** 在途标记（P1）：按 friend 分键，防心跳与手动触发叠在一起双发 */
  const inFlight = new Set();

  /**
   * 朋友分区（P3）：friend 为空 = 主人这条线（存顶层）；否则存 state.friends[friend]。
   * 两条线完全独立——朋友不占主人的每日额度、不吃主人的人格先验。
   */
  const readState = (friend = '') => {
    const all = stateStore.read();
    if (!friend) return all;
    const f = all.friends && all.friends[friend];
    return f || { day: '', countToday: 0, lastRunAt: 0, nextFireAt: 0, attempts: 0, drives: {}, goals: [], observations: [], pending: [], history: [] };
  };
  const writeState = (friend = '', mutator) => {
    if (!friend) return stateStore.write(mutator);
    return stateStore.write((cur) => {
      cur.friends = cur.friends || {};
      const base = cur.friends[friend] || { day: '', countToday: 0, lastRunAt: 0, nextFireAt: 0, attempts: 0, drives: {}, goals: [], observations: [], pending: [], history: [] };
      cur.friends[friend] = typeof mutator === 'function' ? mutator(base) : mutator;
      return cur;
    });
  };
  const warn = (m, ...a) => log.warn?.(`目的：${m}`, ...a);
  const info = (m, ...a) => log.info?.(`目的：${m}`, ...a);

  /** 收素材 → 算驱力 → 生成目标假设 → 挖种子。纯计算，不写盘。 */
  async function prepare(t = now(), friend = '') {
    const c = cfg();
    const s = readState(friend);
    const collected = collect(friend) || {};
    const materials = Array.isArray(collected.items) ? collected.items : [];
    /**
     * 「多久没和这个人说话」的口径（P1 修复）：朋友线不能用主人的 lastOwnerAt——
     * 那会让朋友线的 connect 驱力跟着主人的活跃度走。朋友线取素材里最新一条的时间。
     */
    const lastMasterAt = friend
      ? materials.reduce((mx, x) => Math.max(mx, Number(x.at) || 0), 0)
      : (Number(lastOwnerAt()) || 0);
    const { drives } = deriveDrives({
      drives: s.drives, drivesAt: s.drivesAt, materials,
      now: t, lastMasterAt, needFeedback: s.needFeedback,
      halfLifeHours: c.driveHalfLifeHours,
    });
    const formed = formGoalHypotheses({
      materials, goals: s.goals, observations: s.observations,
      drives, now: t, lastMasterAt, config: c,
    });
    return {
      materials, stats: collected.stats || {},
      drives, lastMasterAt,
      goals: formed.goals || [],
      observations: formed.observations || [],
      seeds: [],
    };
  }

  /**
   * 跑一轮。
   * @returns {{outcome:string, purpose?:object, text?:string, why?:string}}
   */
  async function runOnce({ reason = '定时', friend = '' } = {}) {
    /**
     * 防重入（P1 修复）：心跳每分钟一次、面板「立即试一次」也可能同时点，
     * 两次叠在一起会各自 markDelivered 并各发一条——同一个人收到两条。
     * 按 friend 分键（主人的一轮不该挡住朋友的一轮）。
     */
    const guardKey = friend ? `f:${friend}` : 'owner';
    if (inFlight.has(guardKey)) return { outcome: 'skipped-in-flight' };
    inFlight.add(guardKey);
    try {
      return await runOnceInner({ reason, friend });
    } finally {
      inFlight.delete(guardKey);
    }
  }

  async function runOnceInner({ reason = '定时', friend = '' } = {}) {
    const t = now();
    const c = cfg();
    const s = readState(friend);
    ensurePurposeDay(s, t);
    ensurePurposeSchedule(s, { now: t, config: c });

    /** 会话忙：不插队、不占次数（与追问让位同一口径）。放最前面——省得白算一遍素材和驱力。 */
    if (busy()) {
      info('主人在说话，这一轮让位');
      return { outcome: 'skipped-busy' };
    }

    const ctx = await prepare(t, friend);
    /** 素材太少就别硬找话——她只能瞎编由头。 */
    const minMaterials = Math.max(1, Number(c.minMaterials) || 2);
    if (ctx.materials.length < minMaterials && !(Array.isArray(s.pending) && s.pending.length)) {
      const nextFireAt = planNextFire({ now: t, config: c, lastRunAt: s.lastRunAt, countToday: s.countToday, replyHours: s.replyHours, replyWeekday: s.replyWeekday });
      writeState(friend, (cur) => {
        cur.drives = ctx.drives; cur.drivesAt = t;
        cur.goals = ctx.goals; cur.observations = ctx.observations;
        return markPurposeSkip(cur, { now: t, reason: 'materials', nextFireAt });
      });
      info(`素材太少（${ctx.materials.length}/${minMaterials}），改约下一次`);
      return { outcome: 'skipped-materials' };
    }

    const picked = selectPurpose({
      seeds: ctx.seeds, goals: ctx.goals, pending: s.pending, history: s.history,
      config: c, drives: ctx.drives, now: t, lastMasterAt: ctx.lastMasterAt,
    });
    if (!picked.purpose) {
      const nextFireAt = planNextFire({ now: t, config: c, lastRunAt: s.lastRunAt, countToday: s.countToday, replyHours: s.replyHours, replyWeekday: s.replyWeekday });
      writeState(friend, (cur) => {
        cur.drives = ctx.drives; cur.drivesAt = t;
        cur.goals = ctx.goals; cur.observations = ctx.observations;
        return markPurposeSkip(cur, { now: t, reason: 'no-candidate', nextFireAt });
      });
      info('这轮没选出目的，改约下一次');
      return { outcome: 'skipped-no-candidate' };
    }

    /** 会话忙已在最前面判过，这里不再重复 */
    const prompt = buildPurposePrompt({
      now: t, config: c, mode: 'auto',
      ownerName: c.ownerName || '主人',
      materials: ctx.materials, candidates: picked.candidates,
      selected: picked.purpose, pending: s.pending || [],
      history: s.history || [], stats: ctx.stats, drives: ctx.drives,
    });

    /** 投递即占今日次数（模型回合已经花钱了）；随后按真结局结算。 */
    writeState(friend, (cur) => {
      cur.drives = ctx.drives; cur.drivesAt = t;
      cur.goals = ctx.goals; cur.observations = ctx.observations;
      return markPurposeDelivered(cur, { now: t, planned: picked.purpose });
    });

    let raw = '';
    let genError = null;
    try {
      raw = String(await runTurn(prompt, { key: 'purpose', timeoutMs: 180000 }) || '');
    } catch (e) {
      genError = e;
      warn(`生成出错：${e?.message || e}`);
    }

    const memo = parsePurposeMemo(raw);
    const text = cleanPurposeText(raw);
    let outcome;
    if (!text) {
      outcome = genError ? 'failed' : 'silent';
    } else {
      /** 复读保护：和她最近说过的太像就不发。 */
      if (isDuplicateText(text, (s.history || []).slice(-5), 0.7)) {
        outcome = 'silent';
        info('这句话最近说过了，这轮不发');
      } else {
        try {
          const where = await deliver(text, picked.purpose, friend);
          outcome = where === 'sent' ? 'sent' : where === 'silent' ? 'silent' : 'delivery-failed';
        } catch (e) {
          warn(`投递出错：${e?.message || e}`);
          outcome = 'delivery-failed';
        }
      }
    }

    writeState(friend, (cur) => applyPurposeOutcome(cur, {
      now: t, config: c, outcome, text, memo, planned: picked.purpose,
    }));
    info(`${reason}：${outcome}「${String(picked.purpose.text).slice(0, 40)}」`);
    return { outcome, purpose: picked.purpose, text };
  }

  /**
   * 每分钟 tick：先判定能不能跑，能跑就 runOnce。
   * env 由接线层给（都是便宜状态）。
   */
  async function tick(env = {}, friend = '') {
    const t = now();
    const c = cfg();
    const s = readState(friend);
    const verdict = evaluatePurposeTick({
      now: t, config: c, state: s,
      env: {
        enabled: enabled ? enabled() : c.enabled !== false,
        paused: paused(),
        busy: busy(),
        ownerIdleMs: Number(lastOwnerAt()) ? t - Number(lastOwnerAt()) : undefined,
        ...env,
      },
    });
    if (verdict.action !== 'run') {
      /** 只在 nextFireAt 真的前移时才写盘，避免每分钟改状态文件。 */
      if (verdict.nextFireAt && verdict.nextFireAt !== s.nextFireAt) {
        writeState(friend, (cur) => { cur.nextFireAt = verdict.nextFireAt; return cur; });
      }
      return { outcome: `wait:${verdict.reason}`, nextFireAt: verdict.nextFireAt };
    }
    return runOnce({ reason: '定时', friend });
  }

  /** 面板手动触发（绕过排程判定，但照样占次数、照样结算）。 */
  async function fire(reason = '手动', friend = '') {
    return runOnce({ reason, friend });
  }

  /** 零副作用预览：只算「会选什么」，不生成、不投递、不写盘。 */
  async function preview(friend = '') {
    const t = now();
    const c = cfg();
    const s = readState(friend);
    const ctx = await prepare(t, friend);
    const picked = selectPurpose({
      seeds: ctx.seeds, goals: ctx.goals, pending: s.pending, history: s.history,
      config: c, drives: ctx.drives, now: t, lastMasterAt: ctx.lastMasterAt,
    });
    return {
      ok: true,
      materials: ctx.materials.length,
      drives: ctx.drives,
      candidates: picked.candidates,
      selected: picked.purpose,
      fromPending: picked.fromPending,
      day: localDateKey(t),
      countToday: s.countToday,
      nextFireAt: s.nextFireAt || 0,
    };
  }

  /** 状态摘要（面板用）。 */
  function status() {
    const c = cfg();
    const s = stateStore.read();
    return {
      enabled: c.enabled !== false,
      day: s.day || '',
      countToday: s.countToday || 0,
      dailyMax: c.dailyMax,
      nextFireAt: s.nextFireAt || 0,
      lastRunAt: s.lastRunAt || 0,
      lastOutcome: s.lastOutcome || '',
      lastPurpose: s.lastPurpose || '',
      lastText: s.lastText || '',
      lastSkip: s.lastSkip || null,
      pending: (s.pending || []).length,
      goals: (s.goals || []).filter((g) => !['rejected', 'done', 'expired'].includes(g.status)).length,
      drives: s.drives || DEFAULT_DRIVES,
    };
  }

  return { prepare, runOnce, tick, fire, preview, status };
}

/**
 * 清掉回执里的内部备忘段（【目的】【状态】等），只留真正要说的话。
 * 不做过度清洗：模型说什么就发什么，只剥掉我们自己塞的协议段。
 */
export function cleanPurposeText(raw) {
  const lines = String(raw ?? '').split('\n');
  const kept = [];
  let inMemo = false;
  for (const line of lines) {
    const s = line.trim();
    /** 备忘段以【…】开头，整段丢弃（直到出现非【】的正文行） */
    if (/^[【\[]/.test(s)) { inMemo = true; continue; }
    if (inMemo && s && !/^[【\[]/.test(s)) {
      /** 备忘行通常是「目的：…」这种短标签行；遇到明显是正文的句子就恢复 */
      if (!/^[^：:]{1,6}[：:]/.test(s)) inMemo = false;
      else continue;
    }
    if (!inMemo) kept.push(line);
  }
  return kept.join('\n').trim();
}
