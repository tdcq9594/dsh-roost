/**
 * 自驱决策审计 · decisions.jsonl 哈希链——移植自 aurabot-beta `src/autotelic/plan.js`。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见
 * THIRD-PARTY-NOTICES.md。每阶段一行 {ts,phase,round,payload,prevHash,hash}，
 * 只由代码在固定时机写入，模型回包作为 payload 原样落账，没有模型可写旁路。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/**
 * 决策日志（「她可以骗主人，但不能骗账本」）：每阶段一行 {ts, phase, round, payload, prevHash, hash}。
 * 只由代码在固定时机写入，模型的任何回包都作为 payload 原样落账，没有模型可写的旁路。
 */

export function createDecisionLog({ file, now = () => Date.now() } = {}) {
  let prevHash = ''
  let inited = false
  // 同文件互斥（2026-11-18 修「并发复盘断链」）：createPlanner 与 reviewRound 每次调用都新造
  // createDecisionLog 实例，两个并行复盘各自 initTail() 读到同一个链尾，各算各的 hash，
  // 后写的那行 prevHash 就接不上（真机实证：第 7/8 行 ts 相同、第 8 行断链）。
  // 全进程按文件路径共用一把写锁：initTail + 计算 + appendFile 必须整体原子。
  const chainLocks = createDecisionLog._locks || (createDecisionLog._locks = new Map())
  let lock = chainLocks.get(file)
  if (!lock) { lock = { queue: Promise.resolve() }; if (file) chainLocks.set(file, lock) }
  /** 首次落账前从文件尾恢复链尾（同一文件跨调用/跨轮也要连成一条链）。 */
  async function initTail() {
    if (inited || !file) { inited = true; return }
    inited = true
    let text = ''
    try { text = await readFile(file, 'utf8') } catch { return } // 不存在 = 空链
    const last = text.split('\n').filter((l) => l.trim()).pop()
    if (!last) return
    try { prevHash = String(JSON.parse(last).hash || '') } catch { /* 尾行损坏：从空链起重记（校验器会报旧链） */ }
  }
  return {
    /** 记一阶段。返回落账行（含链哈希）。写盘失败抛给调用方（决策环上层静默记账，不吞审计失败）。
     *  同文件写入串行化 + 每次落账前重读文件尾拿最新链尾（防并发实例互相踩断链）。 */
    async append(phase, round, payload) {
      const run = async () => {
        await initTail()
        // 重读文件尾：本实例之外（另一个 reviewRound 并发落了账）链尾可能已经前进
        if (file) {
          try {
            const last = (await readFile(file, 'utf8')).split('\n').filter((l) => l.trim()).pop()
            const h = last ? String(JSON.parse(last).hash || '') : ''
            if (h) prevHash = h
          } catch { /* 文件没了按内存链尾走 */ }
        }
        const ts = now()
        const body = JSON.stringify({ ts, phase, round, payload })
        const hash = sha256(prevHash + body)
        const line = JSON.stringify({ ts, phase, round, payload, prevHash, hash })
        if (file) {
          await mkdir(dirname(file), { recursive: true })
          await appendFile(file, line + '\n', 'utf8')
        }
        prevHash = hash
        return JSON.parse(line)
      }
      const p = lock.queue.then(run, run)
      lock.queue = p.catch(() => {}) // 锁不吞结果，但自身永不 reject
      return p
    },
    /** 当前链尾（测试与校验用）。 */
    get tail() { return prevHash },
  }
}

/** 校验 decisions.jsonl 链完整性：{ok, total, brokenAt:{line, reason}|null}。
 *  2026-11-18 口径放宽（用户定）：断链不再判死——校验器继续往下走，只把断点记进
 *  `breaks[]` 供面板提示「这里开过新链段」；每一段内部仍要求逐行哈希连贯。
 *  （旧口径整链一断就全盘红，每次都要人工重排数据，烦；现在断点即新链段起点，
 *  链的防篡改价值保留在段内：改段内任意一行，该行 hash/prevHash 对不上仍会被抓。） */

export async function verifyDecisionLog(file) {
  const out = { ok: true, total: 0, brokenAt: null, breaks: [] }
  let text = ''
  try { text = await readFile(file, 'utf8') } catch { return out } // 文件不存在 = 空链，完好
  let prev = ''
  const lines = text.split('\n').filter((l) => l.trim())
  for (let i = 0; i < lines.length; i++) {
    let rec
    try { rec = JSON.parse(lines[i]) } catch { out.ok = false; out.brokenAt = { line: i + 1, reason: 'JSON 损坏' }; return out }
    const body = JSON.stringify({ ts: rec.ts, phase: rec.phase, round: rec.round, payload: rec.payload })
    if (rec.prevHash !== prev) {
      // 断点 = 新链段起点：重置期望链尾继续校验，不再判死（2026-11-18 用户定）
      out.breaks.push({ line: i + 1, reason: 'prevHash 接不上（这里开过新链段）' })
      prev = String(rec.prevHash || '')
    }
    if (rec.hash !== sha256(prev + body)) { out.ok = false; out.brokenAt = { line: i + 1, reason: 'hash 对不上（内容被改）' }; return out }
    prev = rec.hash
    out.total++
  }
  return out
}

// ————— 决策环本体 —————

/**
 * 造决策环（v5 三段式，取代 engine.js/runtime.js 的决策部分）。
 * @param {object} o
 * @param {string} o.decisionFile decisions.jsonl 完整路径（dataDir 根；留空则只走内存链）
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.intentTurn] ①意图生成回合（默认接 hub.runSystemTurn）
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.gateTurn] ②把关回合
 * @param {(prompt:string, opts:object)=>Promise<string>} [o.reviewTurn] ③复盘回合
 * @param {object} [o.hub] 插件 hub（未注入 turn 时的默认通道：hub.runSystemTurn）
 * @param {()=>object} [o.settings] 预算等配置（ext.autotelic + defaults）
 * @param {()=>number} [o.now]
 * @param {()=>number} [o.rng] 洗牌随机源（测试注入固定序列）
 * @param {object} [o.log]
 */

