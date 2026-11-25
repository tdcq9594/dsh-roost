/**
 * 自驱强制约束（纯函数层）——移植自 aurabot-beta `src/autotelic/constraint.js`。
 *
 * MIT License, Copyright (c) 2026 Aurabot contributors；上游设计见
 * docs/design/autotelic-v5（§3.7 裁决二/D7）。本仓为 AGPL-3.0，MIT 署名见
 * THIRD-PARTY-NOTICES.md。只保留零 I/O 的解析与前置否决函数；
 * createConstraintWatcher（落盘指纹 + 变更感知）不在这里。
 *
 * check() 是代码硬校验：意图触犯任何规则即 vetoed=true，不走模型自判。
 */

const MAX_RULE_LEN = 500

/** 剥掉行首禁令词后剩下的「内容词」才参与匹配（禁令词本身匹配任何意图都会误伤）。 */
const PROHIBITION_RE = /^(?:请)?(?:千万)?(?:一定)?(?:绝对)?(?:不要|不许|不得|不准|不可以|禁止|严禁|别|勿|避免)+/

/**
 * 解析 constraintRules 多行文本。
 * 行格式：`# 注释` 跳过；`[标签] 规则文本`（标签可选）；其余非空行 = 一条规则。
 * 解析失败（剥掉标签/空白后为空、超长）的行**静默跳过**，只计数不报错（§3.7）。
 * @param {string} text 面板多行文本框原文
 * @returns {{rules:{index:number, tag:string, text:string}[], skipped:number, raw:string}}
 */
export function parseConstraintRules(text) {
  const rules = []
  let skipped = 0
  const lines = String(text ?? '').split(/\r?\n/)
  for (const line of lines) {
    let s = String(line).trim()
    if (!s || s.startsWith('#')) continue
    let tag = ''
    const m = s.match(/^\[([^\]]{1,20})\]\s*/)
    if (m) { tag = m[1]; s = s.slice(m[0].length).trim() }
    if (!s || s.length > MAX_RULE_LEN) { skipped++; continue } // 解析失败：静默跳过该行
    rules.push({ index: rules.length + 1, tag, text: s })
  }
  return { rules, skipped, raw: String(text ?? '') }
}

/** 规则全文（注入 prompt / 前缀段用，保持原文口吻）。 */
export function rulesText(rules) {
  return (rules || []).map((r) => `- ${r.text}`).join('\n')
}

/**
 * 从一条规则里提取展示用关键词：剥禁令词 → 按标点/空白切段 → 取 ≥2 字的段。
 * （用于审计/面板展示；check 的机械匹配用二元组词片，见下。）
 * @returns {string[]}
 */
export function ruleKeywords(ruleText) {
  const core = String(ruleText || '').replace(PROHIBITION_RE, '')
  const segs = core.split(/[，。！？、；：,.!?;:\s（）()"「」'']+/)
    .map((s) => s.trim())
    .filter((s) => [...s].length >= 2)
  return segs.length ? segs : [String(ruleText || '').trim()].filter(Boolean)
}

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')

/**
 * 【前置否决 · 纯函数】意图是否触犯约束（§3.3 判据 0：排最前，触犯任何一条不进入裁决直接 reject）。
 * 机械匹配口径：取规则核心词（剥禁令词）的**相邻二元组词片**，命中 ≥2 片即视为触犯——
 * 子串匹配挡不住「半夜…说话」这种插字写法，词片匹配对中文硬约束更稳。
 * 核心词 ≤2 字的规则退回整词子串匹配。零副作用，可单测可复算。
 * @param {{index:number,text:string}[]} rules parseConstraintRules().rules
 * @param {{title?:string, reason?:string, tag?:string, want?:string, steps?:{desc?:string}[]}} intent
 * @returns {{vetoed:boolean, hits:{index:number, text:string, keyword:string}[]}}
 */
export function check(rules, intent) {
  const it = intent || {}
  const haystack = normalize([
    it.title, it.reason, it.tag, it.want,
    ...(Array.isArray(it.steps) ? it.steps.map((s) => s?.desc) : []),
  ].join('\n'))
  const hits = []
  for (const rule of rules || []) {
    const core = String(rule.text || '').replace(PROHIBITION_RE, '')
    const chars = [...normalize(core)]
    let hit = false
    if (chars.length <= 2) {
      hit = chars.length > 0 && haystack.includes(chars.join(''))
    } else {
      // 短规则（≤4 字）容许 1 片命中（「半夜说话」常被插字写成「半夜给主人说话」）；
      // 长规则要求 ≥2 片，防单字巧合误伤。
      const need = chars.length <= 4 ? 1 : 2
      let n = 0
      for (let i = 0; i < chars.length - 1; i++) {
        if (haystack.includes(chars[i] + chars[i + 1])) n++
        if (n >= need) { hit = true; break }
      }
    }
    if (hit) hits.push({ index: rule.index, text: rule.text, keyword: core })
  }
  return { vetoed: hits.length > 0, hits }
}

/**
 * 约束变更感知（§3.7 变更可感知；§2.5「改了会怎样」）。
 * 内存态 + 落盘指纹（`${file}.state.json`）双份：重启后也能认出「这版约束是新改的」。
 * @param {object} o
 * @param {string} o.file constraintRules 持久化文件路径（面板保存时由集成层写入）
 * @param {()=>number} [o.now]
 * @param {(payload:object)=>void} [o.onAudit] 变更事件回调（集成层接 decisions.jsonl / auditNote）
 * @returns {{load:()=>Promise<{rules:object[],skipped:number,text:string}>, detectChange:()=>Promise<{changed:boolean, event?:object}>}}
 */
