/**
 * 她的小闹钟 · 数据层（A1）——移植自 aurabot-beta `src/purpose/module.js` 小闹钟段。
 * MIT License, Copyright (c) 2026 Aurabot contributors；本仓 AGPL-3.0，署名见
 * THIRD-PARTY-NOTICES.md。函数体口径与对方一致，只把 readJson/writeJson 指向
 * 本仓语义等价的 autotelic-store.js。
 *
 * 每条提醒是她自己在私聊里设的一次性闹钟；到点只负责把她叫醒（会话注入一轮），
 * **不直接替她发消息**。纯函数 + 注入式依赖，可单测。
 */

import { readJson, writeJson } from './autotelic-store.js';

export const REMINDER_GRACE_MS = 15 * 60_000;
export const REMINDER_RETRY_MS = 5 * 60_000;
export const REMINDER_WAIT_MS = 4 * 60_000;

const two = (n) => String(n).padStart(2, '0');

/** 时间戳 → `yyyy-mm-dd HH:MM` 本地时间 */
export function reminderText(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 严格解析 `yyyy-mm-dd HH:MM`（或 T 分隔），拒绝 2 月 30 日这类溢出日期 */
export function parseReminderTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return 0;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])
    || d.getHours() !== Number(m[4]) || d.getMinutes() !== Number(m[5])) return 0;
  return d.getTime();
}

/** 脏数据不进列表：id/at/note 缺一不可，字段钳到合法形状 */
export function normalizeReminder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const at = Number(raw.at);
  const note = String(raw.note || '').trim().slice(0, 500);
  if (!id || !Number.isFinite(at) || !note) return null;
  return {
    id,
    at,
    atText: String(raw.atText || '').trim() || reminderText(at),
    note,
    createdAt: Number(raw.createdAt) || at,
    attempts: Math.max(0, Math.round(Number(raw.attempts) || 0)),
    nextAt: Number(raw.nextAt) || at,
    expiresAt: Number(raw.expiresAt) || at + REMINDER_GRACE_MS,
    lastError: String(raw.lastError || '').slice(0, 180),
  };
}

/**
 * 造小闹钟存储。
 * @param {object} o
 * @param {string} o.file reminders.json 路径（必给；空则纯内存，测试用）
 * @param {string} [o.legacyFile] 旧 speakup-reminders.json 只读兼容路径
 * @param {()=>number} [o.now]
 * @param {(id:string)=>string} [o.newId] 生成 id（注入便于测试）
 */
export function createReminderStore({ file = '', legacyFile = '', now = () => Date.now(), newId = null } = {}) {
  const load = () => {
    const fresh = file ? readJson(file, null) : null;
    const raw = Array.isArray(fresh) ? fresh : (() => {
      if (!legacyFile) return [];
      const legacy = readJson(legacyFile, null);
      return Array.isArray(legacy) ? legacy : [];
    })();
    return raw.map(normalizeReminder).filter(Boolean);
  };
  const save = (list) => { if (file) writeJson(file, list); };
  const prune = (at = now()) => {
    const raw = load();
    const live = raw.filter((r) => Number(r.expiresAt) > Number(at));
    if (live.length !== raw.length) save(live);
    return live;
  };

  /** 面板/工具列表：按触发时间升序 */
  const list = (at = now()) => prune(at).sort((a, b) => a.at - b.at);

  /**
   * 设一条闹钟。校验口径与对方一致：总闸/上限由调用方判，这里只判时间格式、将来、note 非空。
   * @returns {{ok:boolean, id?:string, at?:string, message:string}}
   */
  const add = (value, noteText, { limit = 5, at = now() } = {}) => {
    const atMs = parseReminderTime(value);
    if (!atMs) return { ok: false, message: '时间格式不对，要用 yyyy-mm-dd HH:MM，例如 2026-11-26 17:30' };
    if (atMs <= Number(at)) return { ok: false, message: '这个时间已经过去了，请设一个将来的时间' };
    const note = String(noteText || '').trim().slice(0, 500);
    if (!note) return { ok: false, message: '要提醒自己什么？把想说的话写进 note' };
    const live = prune(at);
    if (live.length >= limit) return { ok: false, message: '你设定的提醒太多了' };
    const id = typeof newId === 'function' ? newId() : `r-${at}-${Math.random().toString(36).slice(2, 10)}`;
    const reminder = normalizeReminder({
      id, at: atMs, note, createdAt: Number(at),
      attempts: 0, nextAt: atMs, expiresAt: atMs + REMINDER_GRACE_MS, lastError: '',
    });
    save([...live, reminder]);
    return { ok: true, id, at: reminder.atText, message: `已记下，${reminder.atText} 叫醒你` };
  };

  /** 关一条；过期/已关的按对方口径如实报错，不静默成功 */
  const close = (id) => {
    const key = String(id || '').trim();
    const live = prune();
    if (!key || !live.some((r) => r.id === key)) {
      return { ok: false, message: '没找到这个提醒，可能已经过期或关闭了' };
    }
    save(live.filter((r) => r.id !== key));
    return { ok: true, message: '这个小闹钟已关闭' };
  };

  /**
   * 触发失败后的状态推进（对方 attemptReminder 的状态机，纯函数化）：
   * 首次失败把宽限期从 at+15min 起算；重试将耗尽宽限期则放弃；否则 attempts+1、nextAt+5min。
   * @returns {{drop:boolean, reminder?:object, message:string}}
   */
  const fail = (id, error = '', at = now()) => {
    const live = load();
    const current = live.find((r) => r.id === id);
    if (!current) return { drop: true, message: '提醒已不在' };
    if (current.attempts === 0) current.expiresAt = Number(at) + REMINDER_GRACE_MS;
    if (Number(at) + REMINDER_RETRY_MS >= Number(current.expiresAt)) {
      save(live.filter((r) => r.id !== id));
      return { drop: true, message: '重试窗口耗尽，放弃' };
    }
    current.attempts += 1;
    current.nextAt = Number(at) + REMINDER_RETRY_MS;
    current.lastError = String(error || '触发失败').slice(0, 180);
    save(live);
    return { drop: false, reminder: current, message: '5 分钟后重试' };
  };

  /** 触发成功 / 不可重试时移除 */
  const remove = (id) => {
    save(load().filter((r) => r.id !== id));
  };

  return { load, save, prune, list, add, close, fail, remove };
}
