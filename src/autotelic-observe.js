/**
 * 自驱 · 观察层（P1）——移植自 aurabot-beta `src/autotelic/observe.js:24-203`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 回答：**她这段时间看到了什么、记住了什么**。
 * 以前 decide() 拿账本行冒充观察——那不是「看到的」，是「做过的」，所以立项依据一直是错的。
 * 这一层写 observations.jsonl（append-only）：source/tag/text/salience，显著度低于门控线不入库。
 *
 * 两个纯函数可单测：matchCorrection（识别主人纠偏）/ salienceOf（显著性启发式）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TAGS, isValidTag } from './autotelic-tags.js';

export const OBSERVE_SOURCES = ['chat', 'emotion', 'activity', 'note']

// —— 主人纠偏语句（§3.6 最高优先级反馈）：「别做X / 别再X / 不要再X / 别X了」——
// 命中后：写一条 source=note 的高显著度观察 + emit 事件（抑制表 feedback.json 归成员 C，
// 这里只观察+发事件，绝不碰 feedback.json）。
const CORRECTION_RES = [
  /(?:^|[，。！？,.!?\s])(?:别|不要?再?|不许|不准)\s*(?:再)?(?:做|弄|搞|玩|刷|提|说|聊|碰)\s*([^\s，。！？,.!?了啦吧哦]{1,16})/,
  /(?:^|[，。！？,.!?\s])别\s*([^\s，。！？,.!?]{1,16}?)了(?:[，。！？,.!?]|$)/,
]

/** 纯函数：从一句主人话里识别纠偏语句，命中返回 { target, phrase }（抑制对象与原话片段），否则 null。 */
export function matchCorrection(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  for (const re of CORRECTION_RES) {
    const m = re.exec(s)
    if (m) {
      // 去掉句尾语气字与句首的「再」（「别再刷B站了」→ 抑制对象是「刷B站」/「熬夜」）
      const target = String(m[1] || '')
        .replace(/[了啦吧哦]+$/, '')
        .replace(/^再/, '')
        .trim()
      if (target) return { target, phrase: m[0].trim() }
    }
  }
  return null
}

/**
 * 显著度启发式（0~1）：只做便宜的文本判断，不做模型调用。
 * 纠偏语句最高；带问号/情绪词/称呼的抬高；太短太普通的压低。
 */
export function salienceOf(text) {
  const s = String(text ?? '').trim()
  if (!s) return 0
  if (matchCorrection(s)) return 1
  let v = 0.15
  if (s.length >= 8) v += 0.1
  if (s.length >= 20) v += 0.1
  if (/[？?]/.test(s)) v += 0.15
  if (/帮|想要|喜欢|讨厌|烦|忙|累|难过|开心|记住|别忘了/.test(s)) v += 0.25
  return Math.min(1, Math.round(v * 100) / 100)
}

/**
 * 造观察层。
 * @param {object} o
 * @param {string|(()=>string)} o.file observations.jsonl 路径（直接 api.dataDir('observations.jsonl')）
 * @param {()=>number} [o.now] 时间源（测试注入）
 * @param {()=>string[]} [o.tagsOf] 当前生效词表（默认内置词表；接了 tags.resolveTags 就传它）
 * @param {number} [o.minSalience] 显著度门控线，低于此不入库（默认 0.2）
 * @param {number} [o.flushMs] 批量落盘延迟（默认 5000；防抖，坑#9）
 * @param {number} [o.maxBuffer] 缓冲条数上限，满了立刻落盘
 * @param {object} [o.hooks] 测试注入点（照 api.__petTestHooks 模式）：
 *   { write(file, text), schedule(fn, ms)→cancel, onCorrection({target, tag, row}) }
 */
export function createObserve({
  file,
  now = () => Date.now(),
  tagsOf = () => DEFAULT_TAGS,
  minSalience = 0.2,
  flushMs = 5000,
  maxBuffer = 64,
  maxText = 300,
  hooks = {},
} = {}) {
  const fileOf = () => (typeof file === 'function' ? file() : file)
  const write = hooks.write || ((f, text) => appendFileSync(f, text, 'utf8'))
  const schedule = hooks.schedule || ((fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return () => clearTimeout(t)
  })
  let buffer = []
  let cancelFlush = null

  /** 批量落盘（一次 appendFileSync 写完整批；没东西就不碰盘）。 */
  function flush() {
    if (cancelFlush) { cancelFlush(); cancelFlush = null }
    if (!buffer.length) return
    const batch = buffer
    buffer = []
    const f = fileOf()
    if (!f) return
    try {
      write(f, batch.map((r) => JSON.stringify(r)).join('\n') + '\n')
    } catch (error) {
      // 落盘失败静默（观察层不许拖垮主流程）；把批次放回队头，下次 flush 重试
      buffer = [...batch, ...buffer]
      hooks.onError?.(error)
    }
  }

  function scheduleFlush() {
    if (cancelFlush) return
    cancelFlush = schedule(() => { cancelFlush = null; flush() }, flushMs)
  }

  /**
   * 追加一条观察。校验 source/tag/显著度，通过后进缓冲（不立即写盘）。
   * @returns {{ok:boolean, reason?:string, row?:object}}
   */
  function append({ source, tag, text, salience, ts } = {}) {
    if (!OBSERVE_SOURCES.includes(source)) return { ok: false, reason: 'bad-source' }
    const tags = tagsOf() || DEFAULT_TAGS
    const t = String(tag ?? '').trim()
    if (!isValidTag(t, tags)) return { ok: false, reason: 'bad-tag' }
    const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxText)
    if (!body) return { ok: false, reason: 'empty-text' }
    const sal = Math.max(0, Math.min(1, Number(salience ?? salienceOf(body))))
    if (sal < minSalience) return { ok: false, reason: 'low-salience' } // 显著度门控：太淡的记不住
    const row = { id: randomUUID(), ts: Number(ts) || now(), source, tag: t, text: body, salience: sal }
    buffer.push(row)
    if (buffer.length >= maxBuffer) flush()
    else scheduleFlush()
    return { ok: true, row }
  }

  /** 主人纠偏（§3.6 最高优先级）：识别「别做X/别再X」→ 高显著度 note 观察 + emit 事件。 */
  function observeCorrection(text, { tag = '', source = 'chat' } = {}) {
    const hit = matchCorrection(text)
    if (!hit) return null
    const tags = tagsOf() || DEFAULT_TAGS
    // 纠偏观察的 tag：优先用被抑制行为自己的 tag（调用方传入且合法），否则落一个合法默认
    const rowTag = isValidTag(tag, tags) ? tag : (isValidTag('牵挂', tags) ? '牵挂' : tags[0])
    const r = append({ source: 'note', tag: rowTag, text: `主人纠偏：${hit.phrase}`, salience: 1 })
    if (r.ok) hooks.onCorrection?.({ target: hit.target, tag: rowTag, text: String(text ?? ''), row: r.row })
    return { ...hit, result: r }
  }

  /** 读全量（先 flush 保证读到刚写入的）；坏行静默跳过。append-only 不改写旧行。 */
  function readAll() {
    flush()
    const f = fileOf()
    if (!f || !existsSync(f)) return []
    const out = []
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const s = line.trim()
      if (!s) continue
      try { out.push(JSON.parse(s)) } catch { hooks.onError?.(new Error(`坏行：${s.slice(0, 40)}`)) }
    }
    return out
  }

  /**
   * 时间窗列表（旧→新）。
   * @param {{since?:number, until?:number, source?:string, tag?:string, limit?:number}} [o]
   */
  function list({ since = 0, until = Number.POSITIVE_INFINITY, source = '', tag = '', limit = 200 } = {}) {
    const rows = readAll().filter((r) => r
      && r.ts >= since && r.ts <= until
      && (!source || r.source === source)
      && (!tag || r.tag === tag))
    return rows.length > limit ? rows.slice(-limit) : rows
  }

  /** 按 tag 取（立项须引用 ≥2 条不同时间的观察，§3.2 视野要求的主要取数口）。 */
  function byTag(tag, opts = {}) {
    return list({ ...opts, tag })
  }

  /** 薄统计（面板/自驱轮的「自身状态薄摘要」用）。 */
  function stats() {
    const rows = readAll()
    const bySource = {}
    const byTag = {}
    let lastTs = 0
    for (const r of rows) {
      bySource[r.source] = (bySource[r.source] || 0) + 1
      byTag[r.tag] = (byTag[r.tag] || 0) + 1
      if (r.ts > lastTs) lastTs = r.ts
    }
    return { total: rows.length, bySource, byTag, lastTs }
  }

  function dispose() {
    flush()
  }

  return { append, observeCorrection, flush, list, byTag, stats, dispose }
}

/**
 * 情绪桥（P3 对照补齐）——移植自 aurabot-beta `src/autotelic/observe.js:215 createEmotionBridge`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见 THIRD-PARTY-NOTICES.md。
 *
 * 把心情接进观察层：fetchEmotions() 给出的情绪条目写成 source='emotion' 的观察，
 * 默认 tag「牵挂」。**没接线就保持惰性（not-wired），不写任何观察**——宁缺毋假，
 * 不能凭空替她编情绪。
 */
export function createEmotionBridge({ fetchEmotions = null, observe } = {}) {
  function collect(now = Date.now()) {
    if (typeof fetchEmotions !== 'function') return { ok: false, reason: 'not-wired' };
    let items = [];
    try { items = fetchEmotions() || []; } catch { return { ok: false, reason: 'fetch-failed' }; }
    if (!Array.isArray(items)) return { ok: false, reason: 'fetch-failed' };
    const written = [];
    for (const it of items) {
      const text = String(it?.text || '').trim();
      if (!text) continue;
      const r = observe?.append?.({
        source: 'emotion',
        tag: String(it?.tag || '牵挂'),
        text,
        salience: Number.isFinite(it?.salience) ? it.salience : 0.6,
        ts: Number(it?.ts) || now,
      });
      if (r?.ok) written.push(r.row);
    }
    return { ok: true, written };
  }
  return { collect };
}
