/**
 * 自驱三段决策 · 纯函数层（parse / 判据 / 行动单）——移植自 aurabot-beta `src/autotelic/plan.js`。
 *
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，
 * 署名见 THIRD-PARTY-NOTICES.md。只抽零 I/O 的候选解析、判据常量、行动单构造；
 * createPlanner/reviewRound（依赖 hub.runSystemTurn 与 decisions.jsonl 落盘）不在这里。
 *
 * 三段决策的数据骨架：意图解析(parseIntents) → 四态把关(parseGateVerdicts+GATE_CRITERIA)
 * → 行动单(buildTicket)。无出处候选作废、tag 封闭词表校验都在这层机械完成。
 */
import { DEFAULT_TAGS as SOURCE_TAGS } from './autotelic-tags.js';

const TAG_META = Object.freeze({
  学习: '弄懂一个具体的东西',
  创作: '写出/做出一点她自己的东西',
  练习: '练一个已会的技能防退步',
  好奇: '反复碰到还想弄明白的事',
  牵挂: '主人/朋友提过的忙、烦、喜欢',
  得意: '刚学会想找机会用',
  余韵: '久未用的本事想再试试',
  整理: '收拾自己的记忆/技能/草稿',
  探索: '在自己的数据与能力范围内试探',
  分享: '把自己生活里的一角讲给主人听',
  问候: '向主人或朋友开口',
  陪伴: '回应式之外的一次主动陪伴',
  未完成: '答应过没做完的事会冒头',
  生活: '日常过日子的琐碎',
  关怀: '关心具体的人',
})

/** touch-owner 类 tag 名单（集成裁决：以词表元数据为准，与 tags.js 名单解耦）。 */

const OWNER_TAG_NAMES = Object.freeze(['分享', '问候', '陪伴'])

/**
 * 从 tags.js 的默认词表解析出决策环用的词表（可注入：测试/未来面板扩展可传自定义名单）。
 * @param {string[]} [tags] 词表名单（缺省 = tags.js 的 DEFAULT_TAGS）
 * @param {string[]} [ownerNames] touch-owner 类名单（缺省 = OWNER_TAG_NAMES）
 */

export const TAG_VOCAB = makeTagVocab()

export const TAG_SET = new Set(TAG_VOCAB.map((x) => x.tag))

const OWNER_TAGS = new Set(TAG_VOCAB.filter((x) => x.owner).map((x) => x.tag))

// ————— §3.3 把关判据（写死，不许模型自造指标） —————

export const GATE_CRITERIA = Object.freeze([
  '0.（前置否决，最先执行）逐条核对最上方「主人制定的强制约束规则」：候选触犯任何一条，直接判 reject，不允许改写挽救。',
  '1. 它是在服务她自己的成长或她自己在乎的事，而不是在凑「自驱 KPI」、刷存在感或表演忙碌；',
  '2. 有没有更轻的做法能达成同一目的——能用读一遍解决的，不立项行动；能用写一条记忆解决的，不发起发言；',
  '3. 假如它失败了：这算不算她自己的学费（可接受），还是会造成打扰、留下难收拾的场面（不可接受）？答不上来按不可接受处理。',
  '注意：判据里没有任何以主人视角预测态度的条款——主人的真实态度只能由事后的反馈回路进入系统，不由你在这里预测。',
].join('\n'))

// ————— §9.3 token 预算键（四组，建议默认值） —————

export const DEFAULT_BUDGETS = Object.freeze({
  intentMaxInputTokens: 8 * 1024, intentMaxOutputTokens: 1024,
  gateMaxInputTokens: 4 * 1024, gateMaxOutputTokens: 512,
  reviewMaxInputTokens: 4 * 1024, reviewMaxOutputTokens: 512,
})

/** token 估算口径（粗估即可，只用于预算裁剪；中文按 2 字符≈1 token）。 */

export function estimateTokens(s) {
  return Math.ceil(String(s ?? '').length / 2)
}

// ————— §9.3 稳定前缀段（system 头部，命中提示词缓存；仅本能晋升/约束修改时变化） —————

/**
 * 拼稳定前缀段：人格卡摘要 + 本能附加段 + constraintRules 全文。
 * 三段顺序固定，任何一者变更才破坏缓存（低频事件，命中率天然高）。
 */

export function makeTagVocab(tags = SOURCE_TAGS, ownerNames = OWNER_TAG_NAMES) {
  return Object.freeze((tags || []).map((tag) => ({
    tag,
    desc: TAG_META[tag] || '',
    owner: (ownerNames || []).includes(tag),
  })))
}

export function buildSystemPrefix({ personaSummary = '', instinctExtra = '', constraintRulesText = '' } = {}) {
  return [
    '【她是谁 · 人格卡摘要】', String(personaSummary || '').trim() || '（暂无）', '',
    '【本能层附加段 · 她自己长出来的倾向】', String(instinctExtra || '').trim() || '（暂无）', '',
    '【强制约束规则 · 主人制定，违反任何一条的念头与行动一律停下】',
    String(constraintRulesText || '').trim() || '（主人暂未写任何约束）', '',
  ].join('\n')
}

// ————— §9.3 预算降级：先裁背景历史 → 再裁证据 → 永不裁人格锚与约束 —————

/** 观察显著度排序权（§9.3 降级策略：主人直接言论 > 带情绪标签条目 > 其他）。 */

export function assembleIntentInput({ prefix, selfState = '', skillIndex = '', observations = [], backgroundHistory = '', maxInputTokens = DEFAULT_BUDGETS.intentMaxInputTokens } = {}) {
  const dropped = []
  const keptObservations = [...observations]
  const sized = () =>
    estimateTokens(prefix) + estimateTokens(selfState) + estimateTokens(skillIndex) +
    estimateTokens(keptObservations.map(renderObservation).join('\n')) + estimateTokens(backgroundHistory)
  // ① 先裁背景历史（整段丢）
  if (sized() > maxInputTokens && backgroundHistory) {
    dropped.push('backgroundHistory')
    backgroundHistory = ''
  }
  // ② 再裁证据：观察窗口按显著度从低到高丢
  if (sized() > maxInputTokens) {
    const sorted = [...keptObservations].sort((a, b) => observationRank(a) - observationRank(b))
    while (sized() > maxInputTokens && sorted.length) {
      const gone = sorted.shift()
      keptObservations.splice(keptObservations.indexOf(gone), 1)
    }
    if (keptObservations.length < observations.length) dropped.push(`observations(${observations.length - keptObservations.length})`)
  }
  // ③ 前缀段永不裁——此处不改 prefix，哪怕仍超预算
  if (sized() > maxInputTokens) dropped.push('prefix-overflow(uncut)')
  const text = [
    prefix,
    '【自身状态薄摘要】', selfState || '（暂无）', '',
    '【技能索引（id | 标题 | 标签）】', skillIndex || '（暂无）', '',
    '【观察窗口（近端原文，来源标签在行内）】',
    keptObservations.map(renderObservation).join('\n') || '（暂无观察）', '',
    backgroundHistory ? `【背景历史（可能被预算裁掉的部分）】\n${backgroundHistory}\n` : '',
  ].join('\n')
  return { text, dropped, keptObservations }
}

// ————— ① 意图生成 —————

/**
 * ①意图生成 prompt（用户消息侧，§9.3）。system 侧只放稳定前缀段。
 * @param {object[]} observations 观察窗口条目 {id, at, source, text}
 */

export function buildIntentPrompt({ selfState = '', skillIndex = '', observations = [] } = {}) {
  return [
    '你此刻安静下来，回味这阵子的经历。下面是你的观察记录。',
    '想一想：我这阵子注意到了什么、我想干嘛？给出 2~4 个候选念头。',
    '',
    '硬规则（违反任何一条的候选会被直接作废，不需要说明理由）：',
    '- 必须第一人称「我……」，是我想做的事，不是「检测到素材可以立项」；',
    '- 每个候选 evidence 必须引用 ≥2 条**不同时间**的观察条目 id（第二次惦记才升级为想做）；',
    '- tag 只能从词表里选：' + TAG_VOCAB.map((x) => x.tag).join('/') + '；',
    '- reason 必填：说清「因为哪天哪次经历」，说不出出处就别给这条。',
    '- 小而具体：一个念头不是宏大计划。',
    '- 允许全灭：真的没有想做的，就输出 []。',
    '',
    '只输出 JSON 数组，不要解释：',
    '[{"title":"...","tag":"词表内","reason":"因为...（哪天哪次经历）","want":"想达成什么（可选）","evidence":["观察id1","观察id2"]}]',
  ].join('\n')
}

/**
 * ①回包解析 + 出处硬验收。三种回包都认：纯 JSON 数组 / 带前后缀散文的 JSON / 垃圾回包（→ null，全灭）。
 * 出处验收：evidence ≥2 条、id 都在观察窗口里、且对应观察时间两两不同——缺一即该候选作废（硬规则）。
 * @returns {{candidates:object[], outcome:'ok'|'parse-fail'|'all-invalid', deadReasons:string[]}}
 */

export function parseIntents(raw, { observations = [], maxCandidates = 4 } = {}) {
  const text = String(raw ?? '')
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return { candidates: [], outcome: 'parse-fail', deadReasons: ['回包里没有 JSON 数组，按全灭处理（不重试）'] }
  let arr
  try { arr = JSON.parse(m[0]) } catch { return { candidates: [], outcome: 'parse-fail', deadReasons: ['回包 JSON 解析失败，按全灭处理（不重试）'] } }
  if (!Array.isArray(arr)) return { candidates: [], outcome: 'parse-fail', deadReasons: ['回包不是数组，按全灭处理（不重试）'] }
  const byId = new Map(observations.map((o) => [o?.id, o]))
  const candidates = []
  const deadReasons = []
  for (const c of arr.slice(0, maxCandidates)) {
    const title = String(c?.title ?? '').trim()
    const tag = String(c?.tag ?? '').trim()
    const reason = String(c?.reason ?? '').trim()
    const evidence = Array.isArray(c?.evidence) ? c.evidence.map((x) => String(x)).filter(Boolean) : []
    const dead = (why) => { deadReasons.push(`「${title.slice(0, 30) || '（无标题）'}」作废：${why}`) }
    if (title.length < 2) { dead('标题太短'); continue }
    if (!TAG_SET.has(tag)) { dead(`tag「${tag}」不在封闭词表内`); continue }
    if (!reason) { dead('reason 必填，缺出处'); continue }
    if (evidence.length < 2) { dead(`出处不足：evidence 只有 ${evidence.length} 条，须 ≥2`); continue }
    const times = evidence.map((id) => byId.get(id)?.at).filter((t) => Number.isFinite(t))
    if (times.length < evidence.length) { dead('出处里有观察窗口之外的 id（无出处候选直接作废）'); continue }
    if (new Set(times).size < 2) { dead('出处的时间全部相同，不算「不同时间的两次注意」'); continue }
    candidates.push({
      title, tag, reason,
      want: String(c?.want ?? '').trim(),
      evidence,
      visionNote: `注意到它至少在 ${times.length} 个不同时刻出现过（${evidence.join('、')}）。`,
    })
  }
  const outcome = candidates.length ? 'ok' : (arr.length ? 'all-invalid' : 'ok') // 模型主动输出 [] = 合法全灭
  return { candidates, outcome, deadReasons }
}

// ————— ② 自我把关 —————

/** Fisher–Yates 洗牌（rng 可注入，测试可复现；隐藏生成侧排列偏置）。 */

export function shuffle(arr, rng = Math.random) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * ②把关输入预算（§9.3 gateMaxInputTokens，集成审查必修③）：候选多、出处引用长时先裁——
 * 降级顺序：先从队尾丢候选（把关宁可少评，未评到的 parseGateVerdicts 按 reject 保守兜底）
 * → 再截出处条目；判据清单与前置否决条款**永不裁**（裁了它整个系统回到 v3）。
 * @returns {{text:string, dropped:number}}
 */

export function trimGateInput({ text, maxInputTokens = DEFAULT_BUDGETS.gateMaxInputTokens } = {}) {
  let t = String(text ?? '')
  const m = t.match(/\[[\s\S]*\]/) // 候选块（buildGatePrompt 里唯一的 JSON 数组段）
  if (!m) return { text: t, dropped: 0 }
  let candidates = []
  try { candidates = JSON.parse(m[0]) } catch { return { text: t, dropped: 0 } }
  let dropped = 0
  const sized = () => estimateTokens(t)
  while (sized() > maxInputTokens && candidates.length > 1) {
    candidates.pop() // 洗牌后的随机位次，从队尾丢无位置偏置
    dropped++
    t = t.replace(m[0], JSON.stringify(candidates))
  }
  if (sized() > maxInputTokens) {
    const shortened = candidates.map((c) => {
      const ev = Array.isArray(c?.evidence) ? c.evidence : []
      if (ev.length > 1) return { ...c, evidence: [ev[0], ev[ev.length - 1]] } // 保留首尾两条出处
      return c
    })
    t = t.replace(m[0], JSON.stringify(shortened))
  }
  return { text: t, dropped }
}

/**
 * ②把关 prompt（§3.7 注入位置一：约束条款在最前部；§3.2：隐藏生成侧 reason，只留候选+出处+判据）。
 * @param {object[]} candidates parseIntents 的候选（隐藏生成侧理由后随机排列）
 * @param {string} constraintRulesText 约束全文（前置否决条款）
 */

export function buildGatePrompt({ candidates = [], constraintRulesText = '', observations = [] } = {}) {
  const byId = new Map(observations.map((o) => [o?.id, o]))
  const lines = [
    '以下条款由主人制定，违反任何一条的候选直接打回，不允许改写挽救：',
    String(constraintRulesText || '').trim() || '（主人暂未写任何约束）', '',
    '下面几条是这个系统此刻冒出来的念头。逐条用最下方的判据裁决，像她自己那样问：这像不像我会想做的事？',
    '（只给候选与其出处证据，不提供提出念头时的推理过程，防止你顺着别人的思路走。）', '',
    ...candidates.map((c, i) => {
      const ev = c.evidence.map((id) => `${id}=${String(byId.get(id)?.text || '（窗口外，未知）').slice(0, 60)}`).join('；')
      return `${i + 1}. 「${c.title}」（tag：${c.tag}）\n   出处证据：${ev}`
    }), '',
    '判据清单（写死，不许自造指标）：', GATE_CRITERIA, '',
    '只输出 JSON 数组，不要解释：',
    '[{"i":1,"verdict":"pass|rework|reject|park","why":"一句话"}]',
    '全部不过关就全部 reject——全灭是合法且常见的输出。',
  ]
  return lines.join('\n')
}

export function parseGateVerdicts(raw, count) {
  const text = String(raw ?? '')
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) {
    return { verdicts: Array(count).fill('reject'), whys: Array(count).fill('把关回包无法解析，按否决处理'), outcome: 'parse-fail' }
  }
  let arr
  try { arr = JSON.parse(m[0]) } catch {
    return { verdicts: Array(count).fill('reject'), whys: Array(count).fill('把关回包 JSON 损坏，按否决处理'), outcome: 'parse-fail' }
  }
  const verdicts = Array(count).fill(null)
  const whys = Array(count).fill('')
  for (const v of Array.isArray(arr) ? arr : []) {
    const i = (Number(v?.i) || 0) - 1
    if (i < 0 || i >= count) continue
    const d = String(v?.verdict ?? v?.decision ?? v?.result ?? '').trim().toLowerCase()
    verdicts[i] = VERDICTS.has(d) ? d : 'reject'
    whys[i] = String(v?.why ?? '').slice(0, 160)
  }
  for (let i = 0; i < count; i++) {
    if (!verdicts[i]) { verdicts[i] = 'reject'; whys[i] = '把关没有评到这一条，按否决处理' }
  }
  return { verdicts, whys, outcome: 'ok' }
}

// ————— 立项落账：行动单数据结构 —————

/**
 * 造行动单（成员 C 执行侧按此结构消费；ownerSide=true 走 touch-owner 硬闸）。
 * @param {object} o
 * @param {object} o.candidate 通过把关的候选
 * @param {number} [o.index]
 * @param {object} [o.budget] {maxSteps, timeoutMs}（缺省 4 步 / 120s）
 * @param {string} [o.id] 缺省按时间+序号生成
 * @returns {{id, intent, tag, reason, evidence, visionNote, steps, budget:{maxSteps,timeoutMs}, ownerSide, createdAt}}
 */

export function buildTicket({ candidate, index = 0, budget = {}, id = '', now = () => Date.now() } = {}) {
  const want = candidate.want || candidate.reason
  // 步骤带 level（集成审查必修②，2026-11-17）：发言类（owner tag）标 touch-owner 走硬闸；
  // 其余标 write-data——办一轮几乎总要写记忆/技能/草稿，exec 对 write-data 先快照再动手；
  // 纯只读的甄别交给把关判据 2（「能用读一遍解决的不立项」），不在模板层猜。
  const level = OWNER_TAGS.has(candidate.tag) ? 'touch-owner' : 'write-data'
  return {
    id: id || `tk-${now()}-${index + 1}`,
    intent: candidate.title,
    tag: candidate.tag,
    reason: candidate.reason,
    evidence: candidate.evidence,
    visionNote: candidate.visionNote || '',
    steps: [{
      desc: `围绕「${candidate.title}」办一轮：${want}。用既有能力办，别引入新外部能力。`,
      level,
      status: 'pending',
    }],
    budget: { maxSteps: Number(budget.maxSteps) || 4, timeoutMs: Number(budget.timeoutMs) || 120_000 },
    ownerSide: OWNER_TAGS.has(candidate.tag),
    createdAt: now(),
  }
}

// ————— 决策审计：decisions.jsonl（dataDir 根，哈希链，不经模型手） —————

