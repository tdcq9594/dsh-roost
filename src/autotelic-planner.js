/**
 * 自驱三段决策运行时 ——移植自 aurabot-beta `src/autotelic/plan.js` 的 createPlanner/reviewRound。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 三段：①意图生成(doIntent) → ②自我把关(doGate, 四态 verdict) → ③复盘(reviewRound)。
 * 三个 turn 全部依赖注入——我方接 agentV1.prompt 包装的 run()，不依赖对方 hub.runSystemTurn。
 * 无出处候选作废在 parseIntents（纯函数，见 autotelic-plan.js），约束前置否决在 autotelic-constraint.js。
 */
import {
  buildSystemPrefix, assembleIntentInput, buildIntentPrompt, parseIntents,
  shuffle, trimGateInput, buildGatePrompt, parseGateVerdicts, buildTicket,
  estimateTokens, DEFAULT_BUDGETS,
} from './autotelic-plan.js';
import { createDecisionLog } from './autotelic-decisions.js';
import { join } from 'node:path';

export function createPlanner({ decisionFile = '', hub = {}, settings = () => ({}), intentTurn = null, gateTurn = null, reviewTurn = null, now = () => Date.now(), rng = Math.random, log = null } = {}) {
  const sysTurn = (name, title, key) => async (prompt, opts = {}) => {
    if (!hub?.runSystemTurn) throw new Error(`决策环没接线：${name} 既没有注入 turn，也没有 hub.runSystemTurn`)
    return hub.runSystemTurn(name, title, prompt, { timeoutMs: 120000, noTools: true, key, ...opts })
  }
  const doIntent = intentTurn || sysTurn('autotelic-intent', '自驱 · 意图生成（她想干嘛）', 'intent')
  const doGate = gateTurn || sysTurn('autotelic-gate', '自驱 · 自我把关（像不像我会想的事）', 'gate')

  function budgetOf(key, fallback) {
    const v = Number(settings()?.[key])
    return Number.isFinite(v) && v > 0 ? v : fallback
  }

  return {
    buildSystemPrefix,
    /**
     * 一轮决策（①+②）。observations 为成员 A 观察层的条目数组。
     * 每阶段落一行 decisions.jsonl：phase 'intent' / 'gate'（全灭轮 gate 记 skipped，§3.8 省把关）。
     * @param {object} o
     * @param {number} o.round 轮次号
     * @param {object} o.persona {summary, instinctExtra}
     * @param {string} o.constraintRulesText 约束全文（前缀段 + 把关前置否决共用同一份）
     * @param {object[]} o.observations 观察窗口 [{id, at, source, text}]
     * @param {string} [o.selfState] 自身状态薄摘要
     * @param {string} [o.skillIndex] 技能索引（id | 标题 | 标签）
     * @param {string} [o.backgroundHistory] 背景历史（预算紧张时第一个被裁）
     * @param {object} [o.ticketBudget] 行动单预算 {maxSteps, timeoutMs}
     * @param {string} [o.systemPrefix] 外部稳定前缀段（D15：集成层用 prefix.js 缓存拼好传入，
     *   变更才重拼；不传则退回 buildSystemPrefix 现拼——两条路径不并存）
     * @returns {{outcome:'tickets'|'all-dead'|'error', candidates, deadReasons, verdicts, whys, tickets, dropped}}
     */
    async decideRound({ round = 0, persona = {}, constraintRulesText = '', observations = [], selfState = '', skillIndex = '', backgroundHistory = '', ticketBudget = {}, systemPrefix = '' } = {}) {
      const out = { outcome: 'all-dead', candidates: [], deadReasons: [], verdicts: [], whys: [], tickets: [], dropped: [] }
      const logLine = createDecisionLog({ file: decisionFile, now })
      try {
        // —— ① 意图生成 ——
        const prefix = String(systemPrefix || '').trim()
          || buildSystemPrefix({ personaSummary: persona.summary, instinctExtra: persona.instinctExtra, constraintRulesText })
        const assembled = assembleIntentInput({
          prefix, selfState, skillIndex, observations, backgroundHistory,
          maxInputTokens: budgetOf('intentMaxInputTokens', DEFAULT_BUDGETS.intentMaxInputTokens),
        })
        out.dropped = assembled.dropped
        const raw = await doIntent(assembled.text + '\n' + buildIntentPrompt(), { timeoutMs: 120000, noTools: true, key: 'intent', maxOutputTokens: budgetOf('intentMaxOutputTokens', DEFAULT_BUDGETS.intentMaxOutputTokens) })
        const parsed = parseIntents(raw, { observations })
        out.candidates = parsed.candidates
        out.deadReasons = parsed.deadReasons
        await logLine.append('intent', round, {
          inputDropped: assembled.dropped,
          rawClipped: String(raw ?? '').slice(0, 2000),
          candidates: parsed.candidates.map((c) => ({ title: c.title, tag: c.tag, evidence: c.evidence })),
          deadReasons: parsed.deadReasons,
          outcome: parsed.outcome,
        })
        // 全灭合法：这一轮什么都不立项；全灭轮省把关（§3.8）
        if (!parsed.candidates.length) {
          await logLine.append('gate', round, { skipped: '全灭轮，省把关' })
          log?.info?.(`自驱 v5：第 ${round} 轮全灭（${parsed.outcome}）`)
          return out
        }
        // —— ② 自我把关 ——
        const gateRaw0 = buildGatePrompt({ candidates: shuffle(parsed.candidates, rng), constraintRulesText, observations })
        const gateTrim = trimGateInput({ text: gateRaw0, maxInputTokens: budgetOf('gateMaxInputTokens', DEFAULT_BUDGETS.gateMaxInputTokens) })
        const gateRaw = await doGate(gateTrim.text, { timeoutMs: 60000, noTools: true, key: 'gate', maxOutputTokens: budgetOf('gateMaxOutputTokens', DEFAULT_BUDGETS.gateMaxOutputTokens) })
        const gate = parseGateVerdicts(gateRaw, parsed.candidates.length)
        out.verdicts = gate.verdicts
        out.whys = gate.whys
        out.gateDropped = gateTrim.dropped
        // rework =「改写后通过」（集成审查中危 6，2026-11-17）：把关的 why 即改写指引，附进行动单；
        // park 挂起项由集成层接走（进下轮观察 + 90 天复活检查），这里只如实带出。
        const passed = []
        const parked = []
        parsed.candidates.forEach((c, i) => {
          const v = gate.verdicts[i]
          if (v === 'pass') passed.push({ ...c, gateWhy: gate.whys[i] || '' })
          else if (v === 'rework') passed.push({ ...c, gateWhy: gate.whys[i] || '', reworked: true })
          else if (v === 'park') parked.push({ ...c, gateWhy: gate.whys[i] || '' })
        })
        out.parked = parked
        out.tickets = passed.map((c, i) => buildTicket({ candidate: c, index: i, budget: ticketBudget, now }))
        out.tickets.forEach((t, i) => {
          const src = passed[i]
          if (src.reworked) { t.reworked = true; t.reason = `${t.reason}（把关改写提示：${src.gateWhy}）`.slice(0, 300) }
          t.gateWhy = src.gateWhy || ''
        })
        out.outcome = out.tickets.length ? 'tickets' : 'all-dead'
        await logLine.append('gate', round, {
          verdicts: gate.verdicts.map((v, i) => ({ i: i + 1, verdict: v, why: gate.whys[i] })),
          gateOutcome: gate.outcome,
          gateInputDropped: gateTrim.dropped,
          tickets: out.tickets.map((t) => ({ id: t.id, intent: t.intent, tag: t.tag, ownerSide: t.ownerSide })),
          parked: parked.map((c) => ({ title: c.title, tag: c.tag })),
        })
        log?.info?.(`自驱 v5：第 ${round} 轮 ${passed.length}/${parsed.candidates.length} 通过把关${out.tickets.length ? `，立项 ${out.tickets.map((t) => t.id).join('、')}` : '（全灭）'}`)
        return out
      } catch (error) {
        out.outcome = 'error'
        out.error = error?.message
        try { await logLine.append('error', round, { message: String(error?.message || error).slice(0, 300) }) } catch { /* 审计写盘失败不再抛 */ }
        log?.warn?.('自驱 v5：决策环出错：', error?.message)
        return out
      }
    },
  }
}

// ————— ③ 复盘（接口留出，行动数据由成员 C 执行侧按契约喂） —————

/**
 * ③复盘调用。
 *
 * 【入参契约 v1（lead 2026-11-17 裁决定稿，成员 C 按此喂）】
 * reviewRound(ticketResult) 的 ticketResult：
 * ```
 * {
 *   roundId: string,                    // 决策轮次标识（decisions.jsonl 的 round 口径一致）
 *   ts: number,                         // 行动终态时刻（epoch ms）
 *   ticketId: string,                   // 行动单 id（buildTicket().id）
 *   intentTitle: string,                // 立项意图原文（= ticket.intent）
 *   tag: string,                        // 封闭词表内 tag（= ticket.tag）
 *   steps: [{desc: string, status: 'done'|'failed'|'skipped'}],  // 各步骤终态（执行侧已终态化）
 *   finalStatus: 'done'|'failed'|'aborted',   // 行动单终态（预算耗尽即 aborted，不许续命 §3.5）
 *   ownerSide: boolean,                 // 是否 touch-owner 类（= ticket.ownerSide）
 *   ownerResponse: 'replied'|'perfunctory'|'ignored'|'none',   // 主人回应档位（非 touch-owner 恒 'none'；通道层规则记账，§3.6）
 *   evidence: string[],                 // 立项时引用的观察 id（= ticket.evidence）
 *   lesson: string,                     // 执行侧草拟的一条教训（可为空串，复盘可改写）
 * }
 * ```
 * 【输出产物（整包交 skills.ingestReflection(artifact) 进记忆层）】含上述全部入参字段，
 * 另加复盘建议：summary / suggestions.lessons[] / suggestions.next('retry'|'drop'|'promote'|'archive')
 * / suggestions.memoryDrafts[]。**复盘只有建议权不碰分数**（D9）：score 记账由执行侧在终态
 * 落账时调 skills.recordOutcome(skillId, finalStatus, ownerResponse)，本函数不产生也不修改 score。
 *
 * 回包要求 JSON：{"summary":"...", "lessons":["..."], "next":"retry|drop|promote|archive",
 * "memoryDrafts":["..."]}；解析失败按保守兜底（next='drop'，不动技能层）。
 * @param {object} ticketResult 见上契约
 * @returns {Promise<object>} artifact（入参字段 + summary + suggestions），并落 decisions.jsonl 一行 phase='review'
 */

export async function reviewRound(ticketResult, { decisionFile = '', reviewTurn = null, hub = {}, settings = () => ({}), now = () => Date.now(), log = null } = {}) {
  const t = ticketResult || {}
  const doReview = reviewTurn || (async (prompt, opts = {}) => {
    if (!hub?.runSystemTurn) throw new Error('复盘没接线：既没有注入 reviewTurn，也没有 hub.runSystemTurn')
    return hub.runSystemTurn('autotelic-review', '自驱 · 复盘（我做了什么、下次还做吗）', prompt, { timeoutMs: 60000, noTools: true, key: 'review', ...opts })
  })
  const budgetKey = 'reviewMaxInputTokens'
  const maxIn = Number(settings()?.[budgetKey]) || DEFAULT_BUDGETS[budgetKey]
  // 预算降级（§9.3）：行动单只留步骤与终态——契约里 steps 本就只带 desc/status，超预算时截 steps 条数
  let steps = Array.isArray(t.steps) ? t.steps : []
  let clipped = 0
  const base = JSON.stringify({ ...t, steps: [] })
  while (steps.length && estimateTokens(base) + estimateTokens(JSON.stringify(steps)) > maxIn) {
    steps = steps.slice(0, -1); clipped++
  }
  if (clipped) log?.debug?.(`自驱 v5：复盘输入超预算，截掉 ${clipped} 条中途步骤`)
  const prompt = [
    '复盘你刚结束的一段行动。回答：我做了什么、结果如何、下次还做吗、学会了吗。',
    '- 按真实终态说话，failed/aborted 不粉饰；失败算学费不算挫折。',
    '- next 的取值：done 且下次想再试=retry；没办成且不值得再试=drop；熟练想晋升提炼=promote；先放着=archive。',
    '- 只输出 JSON，不要解释：',
    '  {"summary":"一两句","lessons":["一条一行"],"next":"retry|drop|promote|archive","memoryDrafts":["可写进记忆的短句"]}', '',
    JSON.stringify({
      roundId: t.roundId, ticketId: t.ticketId, intentTitle: t.intentTitle, tag: t.tag,
      steps, finalStatus: t.finalStatus, ownerSide: !!t.ownerSide,
      ownerResponse: t.ownerResponse || 'none', evidence: t.evidence || [], lesson: t.lesson || '',
    }),
  ].join('\n')
  let parsed = null
  try {
    const raw = await doReview(prompt, { timeoutMs: 60000, noTools: true, key: 'review', maxOutputTokens: DEFAULT_BUDGETS.reviewMaxOutputTokens })
    const m = String(raw ?? '').match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
  } catch (error) { log?.debug?.('自驱 v5：复盘回合失败，走保守兜底：', error?.message) }
  const suggestions = {
    summary: String(parsed?.summary ?? '').slice(0, 300) || `${t.finalStatus === 'done' ? '办完了' : '没办成'}「${t.intentTitle}」`,
    next: ['retry', 'drop', 'promote', 'archive'].includes(parsed?.next) ? parsed.next
      : (t.finalStatus === 'done' ? 'retry' : 'drop'),
    lessons: Array.isArray(parsed?.lessons) ? parsed.lessons.map((x) => String(x).slice(0, 160)).filter(Boolean)
      : (String(t.lesson || '').trim() ? [String(t.lesson).slice(0, 160)] : []),
    memoryDrafts: Array.isArray(parsed?.memoryDrafts) ? parsed.memoryDrafts.map((x) => String(x).slice(0, 120)).filter(Boolean) : [],
  }
  const artifact = {
    roundId: t.roundId, ts: Number(t.ts) || now(), ticketId: t.ticketId,
    intentTitle: t.intentTitle, tag: t.tag, steps,
    finalStatus: t.finalStatus, ownerSide: !!t.ownerSide,
    ownerResponse: t.ownerResponse || 'none', evidence: t.evidence || [],
    lesson: String(t.lesson || ''),
    summary: suggestions.summary,
    suggestions,
    scoreNote: '复盘只有建议权；score 由执行侧 skills.recordOutcome 锚真实终态（D9），本产物不含也不改 score。',
  }
  if (decisionFile) {
    try {
      const line = createDecisionLog({ file: decisionFile, now })
      await line.append('review', t.roundId ?? '', {
        ticketId: t.ticketId, finalStatus: t.finalStatus, ownerResponse: artifact.ownerResponse,
        next: suggestions.next, lessons: suggestions.lessons,
      })
    } catch (error) { log?.warn?.('自驱 v5：复盘审计落账失败：', error?.message) }
  }
  return artifact
}

/** 便捷再导出：约束解析/前置否决从本仓 autotelic-constraint.js 进（决策环与执行层共用同一份真相）。 */
export { parseConstraintRules, check as constraintCheck, rulesText as constraintRulesTextOf } from './autotelic-constraint.js'

