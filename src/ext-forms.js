/**
 * 四形态统一扩展注册表（2026-11-14 全放开配套）。
 *
 * 主人要的方向：扩展可以是内建程序、进程内扩展、外部扩展，后续还会把
 * 内置功能逐个解离成「核心扩展」并交给用户自己的实现。所以第一件事不是
 * 改加载链路，而是**先有一套统一的视图与生命周期**：
 *
 *   builtin    随程序发布的内建能力 —— 本轮只登记成清单，不拆代码、不可停用
 *   inprocess  进程内 ui 动作（`ui.runtime: inprocess`）
 *   mcp        外部 MCP 子进程（默认，存量扩展零改动）
 *   core       后续从内置解离出来、可关闭/可替换的核心扩展（预留位）
 *
 * 这份注册表刻意**只做聚合与启停**，不替换 `ext-registry.js` 的落位/校验/
 * 令牌链路 —— 存量 22 个扩展照常工作，风险最低。后续解离某个内置能力时，
 * 把它从 `BUILTIN_CAPABILITIES` 挪到 `core` 形态并挂上实现即可。
 *
 * 内置的 `id` 是命名空间：外部扩展不允许占用同名 id（否则市场装一个叫
 * `memory` 的扩展就能在视图里盖掉内置记忆系统）。
 */

import { FORMS, FORM_INFO, CORE_POINTS, deriveTier } from './ext-tier.js';

/**
 * 内置能力清单。`point` 对上 `CORE_POINTS` 的键 —— 某个能力被解离成核心
 * 扩展后，扩展清单里写 `overrides: ['memory']` 就能声明接管它。
 *
 * 本轮只登记，不改动任何现有模块；名字取自 `src/` 里真实存在的文件。
 */
export const BUILTIN_CAPABILITIES = Object.freeze([
  { id: 'memory', label: '记忆系统', point: 'memory', note: '长期记忆、检索与提炼' },
  { id: 'recall', label: '记忆召回', point: 'memory', note: '按话题与相关度取回记忆' },
  { id: 'speakup', label: '主动搭话', point: 'prompt', note: '醒着时段里主动开口' },
  { id: 'awake', label: '清醒时段', point: 'prompt', note: '决定什么时候可以打扰主人' },
  { id: 'persona-sections', label: '人格提示词', point: 'prompt', note: '把人格写进系统提示词' },
  { id: 'channel', label: '消息通道', point: 'channels', note: '把消息送进 QQ / 直连协议' },
  { id: 'outbound-actions', label: '出站动作', point: 'outbound-actions', note: '卡片、图片、按钮等出站标记' },
  { id: 'tools', label: '工具表', point: 'tools', note: '模型能调用的工具清单' },
  { id: 'ext-ui', label: '扩展面板', point: 'ui', note: '扩展页面、按钮与设置项' },
]);

/** 从清单推断运行形态。未知值退回 mcp，并让 deriveTier 抬到 L3。 */
export function formOf(manifest = {}) {
  const raw = String(manifest?.form ?? '').trim();
  if (FORMS.includes(raw)) return raw;
  if (manifest?.builtin === true || manifest?.kind === 'builtin') return 'builtin';
  if (manifest?.ui?.runtime === 'inprocess') return 'inprocess';
  return 'mcp';
}

/**
 * @param {object} o
 * @param {() => Array<{id:string, manifest:object, dir?:string, source?:object, foreign?:boolean}>} [o.listInstalled]
 *   `ext-registry.js` 的 `list()`，每次 refresh 现取，避免缓存陈旧。
 * @param {Array} [o.builtins] 内置能力清单（测试可注入）
 * @param {Function} [o.log]
 * @param {() => number} [o.now]
 */
export function createFormRegistry({
  listInstalled = () => [],
  builtins = BUILTIN_CAPABILITIES,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, object>} */
  const entries = new Map();
  /** 主人手动停用的扩展 id（只影响视图与后续加载闸门，不删文件） */
  const disabled = new Set();
  const listeners = new Set();

  function emit(kind, entry) {
    for (const fn of [...listeners]) {
      try { fn(kind, entry); } catch (e) { log?.(`扩展生命周期回调失败：${e?.message ?? e}`); }
    }
  }

  function refresh() {
    const next = new Map();

    for (const b of builtins ?? []) {
      const id = String(b?.id ?? '').trim();
      if (!id) continue;
      const manifest = { id, name: b.label, form: 'builtin', scopes: [], overrides: [] };
      next.set(id, {
        id, name: String(b.label ?? id), form: 'builtin',
        formLabel: FORM_INFO.builtin.label, formNote: FORM_INFO.builtin.note,
        builtin: true, enabled: true, removable: false,
        point: String(b.point ?? ''), note: String(b.note ?? ''),
        dir: '', source: 'builtin', foreign: false,
        tier: deriveTier(manifest), at: now(),
      });
    }

    let rows = [];
    try { rows = listInstalled() || []; } catch (e) { log?.(`读已装扩展失败：${e?.message ?? e}`); }
    for (const row of rows) {
      const m = row?.manifest ?? {};
      const id = String(row?.id ?? m.id ?? '').trim();
      if (!id) continue;
      if (next.has(id)) {
        log?.(`扩展 ${id} 与内置能力同名，已跳过（内置命名空间不可占用）`);
        continue;
      }
      const form = formOf(m);
      next.set(id, {
        id, name: String(m.name ?? id), form,
        formLabel: FORM_INFO[form].label, formNote: FORM_INFO[form].note,
        builtin: false, enabled: !disabled.has(id), removable: true,
        point: '', note: '', dir: String(row?.dir ?? ''),
        source: row?.source ?? 'local', foreign: Boolean(row?.foreign),
        tier: deriveTier(m), at: now(),
      });
    }

    entries.clear();
    for (const [k, v] of next) entries.set(k, v);
    return [...entries.values()];
  }

  function list({ form = '', enabled = null, tier = '' } = {}) {
    return [...entries.values()].filter((e) => (
      (!form || e.form === form)
      && (enabled === null || e.enabled === enabled)
      && (!tier || e.tier.id === tier)
    ));
  }

  function get(id) { return entries.get(String(id ?? '')) ?? null; }

  /** 内建程序不可停用 —— 主人明确要求「保留我们原有功能基础上增加功能」。 */
  function setEnabled(id, enabled, { reason = '' } = {}) {
    const key = String(id ?? '');
    const e = entries.get(key);
    if (!e) return { ok: false, why: `没有这个扩展：${key}` };
    if (e.builtin) return { ok: false, why: '内建程序不可停用；后续解离成核心扩展后才可关闭' };
    if (enabled) disabled.delete(key); else disabled.add(key);
    e.enabled = Boolean(enabled);
    e.changedAt = now();
    e.changeReason = String(reason ?? '');
    emit(enabled ? 'enable' : 'disable', e);
    return { ok: true, entry: e };
  }

  /** 订阅启停；返回取消订阅函数。 */
  function onChange(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 给面板 / 市场用的紧凑视图（等级只给 id 与 label，细节按需再取）。 */
  function snapshot() {
    return [...entries.values()].map((e) => ({
      id: e.id, name: e.name, form: e.form, formLabel: e.formLabel,
      builtin: e.builtin, enabled: e.enabled, removable: e.removable,
      tier: e.tier.id, tierLabel: e.tier.label, tierColor: e.tier.color,
      confirm: e.tier.confirm,
      scopes: e.tier.scopes, overrides: e.tier.overrides,
      point: e.point, note: e.note, foreign: e.foreign,
    }));
  }

  refresh();
  return { refresh, list, get, setEnabled, onChange, snapshot, CORE_POINTS };
}
