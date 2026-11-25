/**
 * 自驱反馈回路（抑制/偏好/冷度/park/熔断）——整文件移植自 aurabot-beta `src/autotelic/feedback.js`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，
 * MIT 署名与许可全文见 THIRD-PARTY-NOTICES.md。
 *
 * 只改了一行 import 路径（对方 core/store.js → 本仓 autotelic-store.js，语义等价），
 * 函数体逐字保留。纯逻辑 + 依赖注入：file/decisionsFile/settings/now 全部可注入。
 */
import { appendFileSync } from 'node:fs'
import { readJson, writeJson } from './autotelic-store.js'

const HOUR = 3600_000
const DAY = 24 * HOUR

const RESP_LEVELS = Object.freeze(['replied', 'perfunctory', 'ignored'])
/** 三档冷度增量（§3.6 原口径）。 */
const CHILL_DELTA = Object.freeze({ ignored: 1, perfunctory: 0.5, replied: -1 })

/** 恢复来源 → 语义。 */
const RESUME_SOURCES = Object.freeze(['mention', 'explicit', 'panel'])

const normalize = (raw) => {
  const t = raw && typeof raw === 'object' ? raw : {}
  return {
    suppress: t.suppress && typeof t.suppress === 'object' ? t.suppress : {}, // tag -> {why, at}
    prefer: t.prefer && typeof t.prefer === 'object' ? t.prefer : {},         // tag -> {count, why, at}
    chill: t.chill && typeof t.chill === 'object' ? t.chill : {},             // tag -> {value, at}
    park: t.park && typeof t.park === 'object' ? t.park : {},                 // tag -> {until, at, why}
    windows: Array.isArray(t.windows) ? t.windows : [],                       // {id, tag, at}
    lastSpoke: t.lastSpoke && typeof t.lastSpoke === 'object' ? t.lastSpoke : {}, // tag -> 最近主动发言时刻（24h 频控，跨重启持久，lead 裁决 2026-11-17）
    rounds: t.rounds && typeof t.rounds === 'object' ? t.rounds : { allDead: 0, stops: 0 },
    breaker: t.breaker && typeof t.breaker === 'object' ? t.breaker : { silentUntil: 0, needsReview: false },
  }
}

/**
 * 造反馈回路。
 * @param {object} o
 * @param {string} [o.file] feedback.json 路径；空则纯内存（测试/预览用）
 * @param {string} [o.decisionsFile] decisions.jsonl 路径（熔断/待检视追加写；空则只留内存标记）
 * @param {()=>object} [o.settings] 模块设置（responseWindowHours / chillHalfLifeDays / chillParkThreshold）
 * @param {()=>number} [o.now]
 * @param {object} [o.log]
 */
export function createFeedback({ file = '', decisionsFile = '', settings = () => ({}), now = () => Date.now(), log } = {}) {
  let state = normalize(file ? readJson(file, null) : null)

  const sOf = () => { try { return settings() || {} } catch { return {} } }
  const windowMs = () => { const h = Number(sOf().responseWindowHours); return (h > 0 ? h : 48) * HOUR }
  const halfLifeMs = () => { const d = Number(sOf().chillHalfLifeDays); return (d > 0 ? d : 14) * DAY }
  const parkThreshold = () => { const v = Number(sOf().chillParkThreshold); return v > 0 ? v : 3 }
  const parkMs = () => 90 * DAY

  const save = () => { if (file) { try { writeJson(file, state) } catch (error) { log?.warn?.('反馈表落盘失败：', error?.message) } } }

  /** decisions.jsonl 追加一行（机器可读审计）；失败静默不抛。 */
  function noteDecision(entry) {
    try {
      const line = JSON.stringify({ ts: now(), ...entry })
      if (decisionsFile) appendFileSync(decisionsFile, line + '\n', 'utf8')
    } catch (error) { log?.warn?.('decisions 追加失败：', error?.message) }
  }

  /** 半衰折算：把 tag 的冷度按 14 天半衰折算到当前时刻并落回状态。
   *  小时级内的微小 dt 不折算——否则 1+1+1 会被浮点衰成 2.999…<3，park 阈值永远差一口气。
   *  **dt≤1h 时连 `at` 也不刷新**（P2 修复）：以前每次都写 `rec.at = at`，
   *  导致 tick 每分钟都判定「状态变了」而无条件落盘；不刷新 `at` 反而让 dt 累积，
   *  到 1 小时才真正折算一次——语义不变、写盘量降两个数量级。 */
  function decayChill(tag, at = now()) {
    const rec = state.chill[tag]
    if (!rec) return 0
    const dt = at - (rec.at || at)
    if (dt <= HOUR) return rec.value
    const v = Math.max(0, rec.value * 0.5 ** (dt / halfLifeMs()))
    /**
     * 值没变就不推进 `at`（P3 修复）：`value=0` 的条目折算永远是 0，
     * 以前照样写 `rec.at = at` → 每小时落盘一次。不推进反而让 dt 继续累积，
     * 语义不变（0 衰多少还是 0），稳态彻底静音。
     */
    if (v === rec.value) return rec.value
    rec.value = v
    rec.at = at
    return rec.value
  }

  /** 加冷度（先半衰再叠加），到阈值自动 park 90 天。 */
  function addChill(tag, delta, at = now()) {
    const cur = decayChill(tag, at)
    const value = Math.max(0, cur + delta)
    state.chill[tag] = { value, at }
    if (value >= parkThreshold() && !isParked(tag, at)) {
      state.park[tag] = { until: at + parkMs(), at, why: `冷度 ${Number(value.toFixed(2))} ≥ ${parkThreshold()}，自动 park 90 天` }
      noteDecision({ kind: 'feedback/park', tag, chill: Number(value.toFixed(2)), until: state.park[tag].until })
    }
    save()
    return value
  }

  const isParked = (tag, at = now()) => {
    const p = state.park[tag]
    return Boolean(p && (p.until || 0) > at)
  }

  // ── 主人纠偏（最高优先级） ────────────────────────────────────────────────

  /**
   * 主人纠偏语句入口（模块壳接线；观察层 source=note 高显著条目由成员 A 产出后汇入同口）。
   * 「别做了/别再X」→ 抑制表；「多干这种」→ 偏好表。
   * @param {string} text 纠偏原文
   * @param {object} [opts] { tags:[], at } —— tags 命中的 tag 进表；不给 tags 时尽量从文本里猜不出就不进
   * @returns {{suppressed:[], preferred:[]}}
   */
  function ingestCorrection(text, opts = {}) {
    const t = String(text || '')
    const at = Number(opts.at) || now()
    const tags = Array.isArray(opts.tags) ? opts.tags.filter(Boolean) : []
    const suppressed = []
    const preferred = []
    if (!t.trim() || !tags.length) return { suppressed, preferred }
    const isSuppress = /(别做了|别再做|别再|不要做了|不许做|停止做|stop doing)/i.test(t)
    const isPrefer = /(多干|多做|多来点|继续做|这种很好|很喜欢这种|keep doing|do more)/i.test(t)
    for (const tag of tags) {
      if (isSuppress) {
        state.suppress[tag] = { why: t.slice(0, 120), at }
        // 纠偏硬排除：连 park 状态一并压住（抑制优先级最高）
        state.chill[tag] = { value: Math.max(decayChill(tag, at), parkThreshold()), at }
        state.park[tag] = { until: at + parkMs(), at, why: `主人纠偏抑制：${t.slice(0, 60)}` }
        noteDecision({ kind: 'feedback/suppress', tag, why: t.slice(0, 120) })
        suppressed.push(tag)
      } else if (isPrefer) {
        const rec = state.prefer[tag] || { count: 0, why: '', at }
        rec.count = (rec.count || 0) + 1
        rec.why = t.slice(0, 120)
        rec.at = at
        state.prefer[tag] = rec
        // 显式「多干」同时是 park 恢复条件之一
        if (state.park[tag]) delete state.park[tag]
        noteDecision({ kind: 'feedback/prefer', tag, why: t.slice(0, 120) })
        preferred.push(tag)
      }
    }
    if (suppressed.length || preferred.length) save()
    return { suppressed, preferred }
  }

  const isSuppressed = (tag) => Boolean(state.suppress[tag])

  // ── 无回应负反馈 ─────────────────────────────────────────────────────────

  /** touch-owner 行动投递：开观察窗（responseWindowHours，默认 48h）。
   *  text：立项意图原文（集成审查中危 8，2026-11-17）——回应判档按它做关键词匹配，
   *  「窗口内主人说的话头对得上这次行动」才算回应，否则 ignored 信号被无关聊天稀释。 */
  function recordDelivery({ id, tag, text = '', at = now() } = {}) {
    if (!id || !tag) return { ok: false }
    state.windows = [...state.windows, { id: String(id), tag: String(tag), text: String(text || '').slice(0, 160), at }]
    save()
    return { ok: true }
  }

  /** 主人回应记账（通道层规则判档，不耗模型调用）：replied / perfunctory / ignored。 */
  function recordResponse(id, level, at = now()) {
    const key = String(id || '')
    const lv = String(level || '').toLowerCase()
    if (!RESP_LEVELS.includes(lv)) return { ok: false, why: '回应档位必须是 replied/perfunctory/ignored' }
    const w = state.windows.find((x) => x.id === key)
    const tag = w ? w.tag : ''
    if (w) state.windows = state.windows.filter((x) => x.id !== key)
    if (tag) {
      const chill = addChill(tag, CHILL_DELTA[lv], at)
      noteDecision({ kind: 'feedback/response', tag, level: lv, chill: Number(chill.toFixed(2)) })
      return { ok: true, tag, chill: Number(chill.toFixed(2)) }
    }
    save()
    return { ok: true, tag: '', chill: null }
  }

  /**
   * 周期维护（模块 tick 调）：观察窗到点没人回应 → 记 ignored；顺带半衰折算与熔断静默到期。
   * @returns {{expired:number}}
   */
  function tick(at = now()) {
    let expired = 0
    const due = state.windows.filter((w) => at - w.at >= windowMs())
    for (const w of due) { recordResponse(w.id, 'ignored', at); expired++ }
    const chillTags = Object.keys(state.chill)
    /**
     * 写放大（P2 修复）：先快照 chill，折算后比一次——**状态真变了才落盘**。
     * 这条 tick 每分钟跑一次，无条件 save 等于每分钟重写 feedback.json；
     * 配合 decayChill「dt≤1h 不动 at」，稳态下这里几乎永远不写。
     */
    const before = JSON.stringify(state.chill)
    for (const tag of chillTags) decayChill(tag, at)
    const chillChanged = JSON.stringify(state.chill) !== before
    if (expired > 0 || chillChanged) save()
    return { expired }
  }

  /** 立项权重：抑制=0；park 中=0；否则 0.6^chill × 偏好抬升（1 + 0.2×count，封顶 2）。 */
  function weightOf(tag, at = now()) {
    if (isSuppressed(tag) || isParked(tag, at)) return 0
    const chill = decayChill(tag, at)
    const boost = Math.min(2, 1 + 0.2 * (state.prefer[tag]?.count || 0))
    return Number((0.6 ** chill * boost).toFixed(4))
  }

  /** 冷度快照（面板/立项侧读）。 */
  const chillOf = (tag, at = now()) => Number(decayChill(tag, at).toFixed(4))
  const parkInfo = (tag) => state.park[tag] ? { ...state.park[tag] } : null

  // ── 恢复三条件 ───────────────────────────────────────────────────────────

  /**
   * 恢复（三选一）：mention=主人主动提及相关话题；explicit=显式说多干；panel=面板清零接口。
   * mention/explicit 只解 park；panel 清零连冷度一起归零。
   */
  function resume(tag, source, at = now()) {
    if (!RESUME_SOURCES.includes(source)) return { ok: false, why: '恢复来源必须是 mention/explicit/panel' }
    const wasParked = Boolean(state.park[tag])
    delete state.park[tag]
    if (source === 'panel') { delete state.chill[tag]; delete state.suppress[tag] }
    noteDecision({ kind: 'feedback/resume', tag, source, wasParked })
    save()
    return { ok: true, clearedChill: source === 'panel', wasParked }
  }

  // ── 主动发言频控（同 tag 24h 至多一次；账在 feedback.json，重启不重置节流——lead 裁决 2026-11-17） ──

  /** 记一次主动发言时刻（执行器在真正发出时调）。 */
  function recordSpoke(tag, at = now()) {
    state.lastSpoke[String(tag || '')] = at
    save()
    return { ok: true }
  }

  /** 某 tag 最近一次主动发言时刻（没有则 0）。 */
  const lastSpokeOf = (tag) => Number(state.lastSpoke[String(tag || '')] || 0)

  // ── 熔断（§3.6：连续 3 轮全灭 或 连续 2 个行动被叫停 → 静默一轮 + 标记待检视） ──

  /** 记一轮决策结果：dead=本轮候选全灭。连续 3 轮全灭触发熔断。 */
  function recordRound({ dead = false, at = now() } = {}) {
    state.rounds.allDead = dead ? (state.rounds.allDead || 0) + 1 : 0
    return maybeBreak('rounds-all-dead', at)
  }

  /** 记一次行动被叫停（确认超时/主人喊停/硬闸拦下）。连续 2 次触发熔断。 */
  function recordStop({ at = now() } = {}) {
    state.rounds.stops = (state.rounds.stops || 0) + 1
    return maybeBreak('stops', at)
  }

  /** 熔断判定：命中就把静默置一轮 + 标记待检视 + 写 decisions。 */
  function maybeBreak(reason, at) {
    const hit = state.rounds.allDead >= 3 || state.rounds.stops >= 2
    if (hit) {
      state.breaker = { silentUntil: at + 2 * HOUR, needsReview: true, reason, at } // 「一轮」按常规间隔 2h 估
      state.rounds = { allDead: 0, stops: 0 }
      noteDecision({ kind: 'feedback/breaker', reason, silentUntil: state.breaker.silentUntil, needsReview: true })
      save()
    }
    return { broken: hit, reason: hit ? reason : '' }
  }

  /** 现在是否处于静默轮（静默期不立项，观察照常积累）。 */
  function isSilent(at = now()) {
    return Boolean(state.breaker?.silentUntil && at < state.breaker.silentUntil)
  }
  const needsReview = () => Boolean(state.breaker?.needsReview)
  /** 面板检视完成：清掉待检视标记。 */
  function clearReview() { if (state.breaker?.needsReview) { state.breaker.needsReview = false; save() } }

  /** 全量快照（面板/接线方读）。 */
  function snapshot() {
    return {
      suppress: { ...state.suppress },
      prefer: { ...state.prefer },
      park: { ...state.park },
      windows: state.windows.map((w) => ({ ...w })),
      lastSpoke: { ...state.lastSpoke },
      rounds: { ...state.rounds },
      breaker: { ...state.breaker },
    }
  }

  return {
    ingestCorrection, recordDelivery, recordResponse, tick,
    weightOf, chillOf, parkInfo, isSuppressed, resume,
    recordSpoke, lastSpokeOf,
    recordRound, recordStop, isSilent, needsReview, clearReview,
    snapshot,
    /** 测试用：强制落盘。 */
    save,
  }
}

export default createFeedback
