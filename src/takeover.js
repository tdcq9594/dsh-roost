/**
 * 她接管「自己琢磨的方向」（A4 · 收窄版）——借鉴 aurabot takeover 思路，
 * 但**刻意收窄**：只准改 autotelic.seeds（她想琢磨什么），不碰权限/配置/工具/人格。
 * 对方是「让她接管读写自己数据」，我方框架强调“框架代码对她锁死”，
 * 全量照搬会让权限闸门失效（autotelic 键不在 CONFIG_DENY）。这里沿用
 * self-expression.js 的白名单 + 冷却 + 变更历史模式，把口子收到最小。
 */

import { cooldownCheck } from './self-expression.js';
import { readJson, writeJson } from './autotelic-store.js';

/** 唯一可接管的字段（白名单，别加第二个） */
export const TAKEOVER_KEYS = Object.freeze(['seeds']);

export function createTakeoverStore({ file = '', cooldownMin = 60, now = () => Date.now() } = {}) {
  const load = () => (file ? readJson(file, null) : null) || { on: false, lastAt: 0, fields: {}, history: [] };
  const save = (s) => { if (file) writeJson(file, s); };

  const status = () => {
    const s = load();
    return { on: s.on === true, lastAt: Number(s.lastAt) || 0, keys: TAKEOVER_KEYS, history: (s.history || []).slice(-5) };
  };

  /** 面板开/关：关掉立即生效，正在途的下一轮也读不到 */
  const setOn = (on) => {
    const s = load();
    s.on = Boolean(on);
    save(s);
    return status();
  };

  /**
   * 她尝试改一个字段：白名单内 + 已开 + 冷却过 → 记录 before/after 并放行（返回建议 patch）。
   * 调用方拿到 patch 后仍走正常 cfg 保存（pruneTo 会裁掉非法键，双保险）。
   */
  const propose = (key, value, at = now()) => {
    if (!TAKEOVER_KEYS.includes(String(key))) return { ok: false, why: `字段 ${key} 不许她改（只接管 ${TAKEOVER_KEYS.join('/')}）` };
    const s = load();
    if (s.on !== true) return { ok: false, why: '接管没开' };
    const cd = cooldownCheck(Number(s.lastAt) || 0, cooldownMin, at);
    if (!cd.ok) return { ok: false, why: '冷却中', waitMs: cd.waitMs };
    const before = s.fields?.[key] ?? null;
    /** seeds 形状：字符串数组，最多 20 条每条 200 字，与面板 seeds 口径一致 */
    let next = null;
    if (key === 'seeds' && Array.isArray(value)) {
      next = value.map((x) => String(x ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, 20);
    }
    if (next === null) return { ok: false, why: '字段值形状不对' };
    s.fields = { ...(s.fields || {}), [key]: next };
    s.lastAt = Number(at);
    s.history = [...(s.history || []), { at: Number(at), key, before, after: next }].slice(-20);
    save(s);
    return { ok: true, patch: { [key]: next }, lastAt: Number(at) };
  };

  return { load, save, status, setOn, propose };
}
