/**
 * 自驱引擎的账本：**哈希链 + 只追加**。
 * ====================================
 *
 * 整个自驱设计的第一条铁律是「**她可以骗主人，但不能骗账本**」。
 * 所以账本必须满足三个条件，缺一条这条铁律就不成立：
 *
 *   1. **由引擎机械写入**，不经过模型。模型能做的只有「这一轮干了什么」的
 *      自由文本，而「什么时候、哪一轮、调了哪个工具、成没成」这些结构字段
 *      全部由调用方填。
 *   2. **只追加**。不提供 update / delete。要「撤销」就追加一条相反语义的记录，
 *      历史永远留着——这是能对账的前提。
 *   3. **哈希链**。每条记录带前一条的哈希，改动任何一条历史都会让后面全断。
 *      断链能定位到「断在哪个文件第几条」，不是笼统地说「账本坏了」。
 *
 * 为什么不用 SQLite：账本是给人看、给外部工具校验的。一行一个 JSON 用
 * `tail` / `grep` / `jq` 就能查，出事时不需要理解我们的表结构。
 * 日记那边用 SQLite 是因为要检索；这里要的是**可审计**，不是可查询。
 *
 * 稳定序列化是必须的：`JSON.stringify` 的键序跟着对象构造顺序走，
 * 同一份数据换个构造方式就得到不同哈希，链会假断。所以自己排键。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEDGER_FILE = 'autotelic-ledger.jsonl';

/** 链的起点：64 个 0。第一条记录的 `prev` 就是它 */
export const GENESIS = '0'.repeat(64);

/** 一次最多读多少条回来（防止账本攒了几年之后把面板撑爆） */
export const MAX_READ = 500;

/**
 * 稳定序列化：键按字典序递归排序。
 *
 * 数组保持原序（顺序本身是语义），只排对象键。
 */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * 一条记录的哈希 = sha256(prev + 稳定序列化的正文)。
 *
 * 把 `prev` 掺进来（而不是只哈希正文）是链的关键：只哈希正文的话，
 * 攻击者可以删掉中间一条，后面每条自己算一遍就都合法了。
 */
export function hashOf(prev, body) {
  return createHash('sha256').update(`${prev}\n${stableStringify(body)}`).digest('hex');
}

/**
 * 造一条记录（纯函数，不写盘）。
 *
 * `seq` 从 1 开始；`kind` 是**闭集**，不接受自由文本——否则按 kind 统计
 * 就不可靠了。要写自由描述放 `note`。
 */
export const KINDS = Object.freeze([
  'boot',      // 引擎启动 / 恢复
  'project',   // 立项（选定了一个想法）
  'step',      // 推进一步（跑了一轮）
  'deny',      // 被闸门拦下（频率 / 时段 / 未允许动手 / 卡住）
  'stuck',     // 连续失败达到上限，自动卡住
  'review',    // 每日复盘
  'tune',      // 她自己调参数（必须进账本）
  'manual',    // 面板上手动触发
]);

export function makeEntry({ seq = 1, at = Date.now(), kind = 'step', prev = GENESIS, payload = {}, note = '' } = {}) {
  const k = KINDS.includes(kind) ? kind : 'step';
  const body = { seq: Number(seq) || 1, at: Number(at) || 0, kind: k, note: String(note ?? '').slice(0, 2000), payload };
  return { ...body, prev, hash: hashOf(prev, body) };
}

/**
 * 校验整条链。
 *
 * 返回**断在第几条**而不是布尔：用户看到「账本坏了」没法处理，
 * 看到「第 37 条对不上」才能去查那一轮发生了什么。
 *
 * @returns {{ok:boolean, total:number, brokenAt:number, reason:string}}
 */
export function verifyChain(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { ok: true, total: 0, brokenAt: 0, reason: '' };

  let prev = GENESIS;
  for (let i = 0; i < list.length; i += 1) {
    const r = list[i];
    const seq = Number(r?.seq) || 0;
    if (seq !== i + 1) {
      return { ok: false, total: list.length, brokenAt: i + 1, reason: `序号断了：第 ${i + 1} 条记的是 ${seq}` };
    }
    if (String(r?.prev ?? '') !== prev) {
      return { ok: false, total: list.length, brokenAt: i + 1, reason: `第 ${i + 1} 条的前序哈希对不上（被改过或中间缺了一条）` };
    }
    const body = { seq: r.seq, at: r.at, kind: r.kind, note: r.note, payload: r.payload };
    if (hashOf(prev, body) !== String(r?.hash ?? '')) {
      return { ok: false, total: list.length, brokenAt: i + 1, reason: `第 ${i + 1} 条的内容与哈希不符（被改过）` };
    }
    prev = String(r.hash);
  }
  return { ok: true, total: list.length, brokenAt: 0, reason: '' };
}

/** 读账本。坏行跳过并计数——一行写坏了不该让整个账本读不出来 */
export function readLedger(file, { limit = MAX_READ } = {}) {
  if (!existsSync(file)) return { rows: [], badLines: 0, total: 0 };
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { rows: [], badLines: 0, total: 0 };
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const all = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object') all.push(r);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  /** `limit: 0` = 全部读完（校验链要用）；否则夹到 MAX_READ 以内 */
  const n = Number(limit) === 0 ? all.length : Math.min(MAX_READ, Math.max(1, Number(limit) || MAX_READ));
  return { rows: n >= all.length ? all : all.slice(-n), badLines, total: all.length };
}

/**
 * 追加一条。**这是唯一的写入口**，调用方不直接碰文件。
 *
 * 每次追加都先读一遍尾巴拿 `prev` 与 `seq`：账本不大（一天最多几条），
 * 读全文比维护内存态更不容易错——插件重启、多进程都天然一致。
 *
 * @returns {{ok:boolean, entry?:object, reason?:string}}
 */
export function appendLedger(file, { kind, payload = {}, note = '', at = Date.now() } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const { rows } = readLedger(file, { limit: 0 });
    /**
     * 校验**整条链**再往上接。
     *
     * 别只校验最后一条：`verifyChain` 是按「第一条的 seq 必须是 1、prev 必须是
     * GENESIS」验的，单拿最后一条去验必然不过，于是第二次之后的追加全被拒
     * （2026-11-14 实测：账本只写进两条，后面的失败记录全丢）。
     * 账本一天几条，全量校验的代价可以忽略。
     */
    if (rows.length) {
      const check = verifyChain(rows);
      if (!check.ok) {
        return { ok: false, reason: `账本已损坏（第 ${check.brokenAt} 条：${check.reason}），先修好再写` };
      }
    }
    const last = rows.length ? rows[rows.length - 1] : null;
    const entry = makeEntry({
      seq: (Number(last?.seq) || 0) + 1,
      at,
      kind,
      prev: last ? String(last.hash) : GENESIS,
      payload,
      note,
    });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, entry };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/** 按天统计：面板顶部那几个数字 */
export function dayStats(rows = [], day = '') {
  const want = String(day || '').trim() || new Date().toISOString().slice(0, 10);
  const list = Array.isArray(rows) ? rows : [];
  const ofDay = list.filter((r) => new Date(Number(r?.at) || 0).toISOString().slice(0, 10) === want);
  const byKind = {};
  for (const r of ofDay) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  return {
    day: want,
    total: ofDay.length,
    steps: byKind.step || 0,
    denies: byKind.deny || 0,
    /** 手动立项记的是 `manual`，统计口径上要和自动立项算在一起 */
    projects: (byKind.project || 0) + (byKind.manual || 0),
    byKind,
    lastAt: ofDay.length ? Math.max(...ofDay.map((r) => Number(r.at) || 0)) : 0,
  };
}

/** 账本文件路径 */
export function ledgerPath(dir) {
  return join(dir, LEDGER_FILE);
}
