/**
 * 6.1 扩展声明式界面：扩展只能**声明**页面，不能给面板写代码。
 * ============================================================
 *
 * 安全边界是这一整块存在的理由，先说清楚：
 *
 * 扩展拿得到配置、拿得到令牌、还能被模型调用。如果允许它把 JS 塞进面板 DOM，
 * 等于把整个面板交出去——面板里能改主人的人格、能读全部记忆。所以：
 *
 *   · 扩展只能声明 `ui.view.kind`（table / cards / log 三种之一）+ 字段白名单；
 *   · 数据来自扩展目录里的一个 **JSON 文件**，宿主读它、按白名单挑字段；
 *   · 字段值一律当**纯文本**渲染，不拼 HTML、不认 `javascript:`；
 *   · 不调用扩展的 MCP 工具取数据——那是 agent 侧的能力，宿主拿不到，
 *     硬接会把面板变成「能触发工具调用的入口」，风险比收益大得多。
 *
 * 为什么用数据文件而不是让扩展起 HTTP 端点：文件对所有形态都成立（stdio 扩展
 * 根本没有端口），而且**不联网、不执行**，审计时只要看那个 JSON 里有什么。
 * 代价是数据是扩展自己刷新的快照，不是实时的——面板上会显示「更新于几点」。
 *
 * 三种 kind 的分工：
 *   · `table` —— 列多、要比对的（榜单、搜索结果）；
 *   · `cards` —— 每条有标题 + 一两行摘要（视频、文章）；
 *   · `log`   —— 时间序列，一行一条，最新在上（运行记录、抓取日志）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

/**
 * 渲染形态。四种都只是**排版**差别，扩展拿不到样式控制权。
 *
 * `list` 是 2026-11-14 放宽加的：`cards` 一条占一大块，适合有摘要的内容；
 * 纯清单（好友列表、文件列表）用它更省地方。
 */
export const UI_KINDS = Object.freeze(['table', 'cards', 'list', 'log']);

/** 一次最多渲染多少行：再多面板也滚不动，而且 JSON 会很大 */
export const MAX_ROWS = 200;

/** 数据文件上限。256 KB 足够几百条记录，再大说明扩展写错东西了 */
export const MAX_UI_BYTES = 256 * 1024;

/** 单个字段值最多多少字：防止一条摘要把整页撑开 */
export const MAX_FIELD_CHARS = 500;

/** 一页最多声明多少个字段（2026-11-14 从 12 放宽到 20） */
export const MAX_FIELDS = 20;

/**
 * 扩展页面能挂到哪个一级菜单下。
 *
 * 和前端 `NAV_GROUPS` 的 id 一一对应，**排除 `home`**：概览是单页首屏，
 * 往里塞扩展页会让「打开就看到现在什么状态」这件事失效。
 *
 * 允许挂到自己以外的组是有意的——一个「刷 B 站」的扩展挂在「表达」下
 * （她怎么说话、说什么）比埋在「扩展」里更好找。默认仍是 `mods`。
 */
export const UI_GROUPS = Object.freeze(['home', 'self', 'express', 'group', 'power', 'mods', 'system']);

/** 中文别名 → id。用户手写 plugin.json 时更可能写「群聊」而不是 `group` */
export const GROUP_ALIASES = Object.freeze({
  人设: 'self', 表达: 'express', 群聊: 'group', 能力: 'power', 扩展: 'mods', 系统: 'system',
  概览: 'home', 首页: 'home',
  self: 'self', express: 'express', group: 'group', power: 'power', mods: 'mods', system: 'system',
});

export const DEFAULT_GROUP = 'mods';

/** 把 `group` 归一成 id；认不出来返回空串（调用方决定是报错还是回落） */
export function groupOf(raw) {
  const k = String(raw ?? '').trim();
  if (!k) return '';
  return GROUP_ALIASES[k] || GROUP_ALIASES[k.toLowerCase()] || '';
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * 字段声明归一化。
 *
 * 接受两种写法：`['title', 'url']`（只要键名）和
 * `[{ key: 'url', label: '链接', type: 'url' }]`（带显示名与类型）。
 * 两种都要过同一套白名单——**没声明的字段一个都不给前端**。
 */
export function normalizeFields(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const errors = [];
  for (const [i, f] of list.entries()) {
    const one = typeof f === 'string' ? { key: f } : (f && typeof f === 'object' ? f : null);
    if (!one) {
      errors.push(`fields[${i}] 既不是字符串也不是对象`);
      continue;
    }
    const key = String(one.key ?? '').trim();
    if (!key) {
      errors.push(`fields[${i}] 缺 key`);
      continue;
    }
    /**
     * 键名只认「字母数字下划线点横线」，并显式挡掉三个原型链键。
     * 正则本身会放过 `__proto__`（下划线开头是合法的），所以必须单独判：
     * 前端拿它当对象键赋值时会改掉原型，是经典的原型污染入口。
     */
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      errors.push(`fields[${i}] 的 key「${key}」是保留字，换一个`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/.test(key)) {
      errors.push(`fields[${i}] 的 key「${key}」不合法（字母开头，只含字母数字 _ . -，最多 40 位）`);
      continue;
    }
    /**
     * 字段类型：`text` / `number` / `url` / `time` / `tag` / `image` / `progress`。
     *
     * 放宽到 7 种（2026-11-14）：`tag` 画成小徽标、`image` 只放 http(s) 图片、
     * `progress` 是 0–100 的进度条、`time` 是毫秒时间戳由前端本地化。
     * **都只是渲染方式，不是执行能力**——扩展能控制的永远只有「这个值是干什么的」。
     */
    const type = ['text', 'number', 'url', 'time', 'tag', 'image', 'progress'].includes(String(one.type ?? ''))
      ? String(one.type) : 'text';
    out.push({ key, label: String(one.label ?? '').trim().slice(0, 20) || key, type });
  }
  if (out.length > MAX_FIELDS) errors.push(`fields 最多 ${MAX_FIELDS} 个（再多表格就挤成一团）`);
  return { ok: errors.length === 0, fields: out.slice(0, MAX_FIELDS), errors };
}

/**
 * 校验清单里的 `ui` 段。
 *
 * 返回 `{ ok, errors, spec }`；`spec` 里只留**认得的字段**，未知键一律丢弃
 * （不报错——扩展可能给未来版本留字段，但宿主不能把它当契约用）。
 */
export function normalizeUiSpec(raw) {
  const errors = [];
  if (raw === undefined) return { ok: true, errors, spec: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['ui 必须是对象'], spec: null };
  }

  const nav = raw.nav && typeof raw.nav === 'object' && !Array.isArray(raw.nav) ? raw.nav : null;
  if (!nav) errors.push('ui.nav 必填（扩展页面要有页名）');
  const label = String(nav?.label ?? '').trim();
  if (nav && (!label || label.length > 12)) errors.push('ui.nav.label 必填且不超过 12 字');
  const group = groupOf(nav?.group);
  if (String(nav?.group ?? '').trim() && !group) {
    errors.push(`ui.nav.group 只能是 ${UI_GROUPS.join(' / ')}（也可以写中文：人设 / 表达 / 群聊 / 能力 / 扩展 / 系统）`);
  }

  const view = raw.view && typeof raw.view === 'object' && !Array.isArray(raw.view) ? raw.view : null;
  if (!view) errors.push('ui.view 必填');
  const kind = String(view?.kind ?? '');
  if (view && !UI_KINDS.includes(kind)) errors.push(`ui.view.kind 只能是 ${UI_KINDS.join(' / ')}`);

  const source = view?.source && typeof view.source === 'object' && !Array.isArray(view.source)
    ? view.source : null;
  const file = String(source?.file ?? '').trim();
  if (view && !file) errors.push('ui.view.source.file 必填（数据文件的相对路径）');
  /**
   * 路径必须是「扩展目录内的相对路径」：
   *   · 绝对路径 / 盘符 —— 扩展凭什么读宿主机器上任何文件？
   *   · `..` —— 同上，只是绕得更明显。
   * 真正的落地校验在 `readUiData()`（解析后还要确认仍在目录下）。
   */
  if (file && (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..'))) {
    errors.push('ui.view.source.file 必须是扩展目录内的相对路径（不许绝对路径或 ..）');
  }

  const fields = normalizeFields(view?.fields);
  errors.push(...fields.errors);

  if (errors.length) return { ok: false, errors, spec: null };
  return {
    ok: true,
    errors: [],
    spec: {
      nav: { label, group: group || DEFAULT_GROUP },
      view: {
        kind,
        title: String(view.title ?? '').trim().slice(0, 30) || label,
        /** 多久算「旧」：面板据此把更新时间标灰（秒）。0 = 不提示 */
        staleSec: Math.max(0, Math.min(86400, Number(view.staleSec) || 3600)),
        source: { file },
        fields: fields.fields,
      },
    },
  };
}

/**
 * 把一条原始记录收敛成「只有白名单字段、只有纯值」的扁平对象。
 *
 * 三条收敛规则，都是为了「前端拿到的永远是可以直接渲染的标量」：
 *   · 只保留声明过的键；
 *   · 嵌套对象 / 数组一律丢掉（渲染器不会递归，留着只会让人以为能点开）；
 *   · 字符串截断到 500 字、数字只留有限数、布尔保留、其余转空串。
 *
 * `type: 'url'` 额外校验协议：**只放 http/https**。`javascript:` / `data:`
 * 一律清空——前端就算照直放进 `<a href>` 也点不出事。
 */
export function projectRow(raw, fields = []) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const f of fields) {
    const v = src[f.key];
    if (f.type === 'number') {
      const n = Number(v);
      out[f.key] = Number.isFinite(n) ? n : null;
      continue;
    }
    if (f.type === 'url' || f.type === 'image') {
      /** 图片和链接同一条规矩：只放 http/https，别的协议一律清空 */
      const s = String(v ?? '').trim();
      out[f.key] = /^https?:\/\//i.test(s) ? s.slice(0, MAX_FIELD_CHARS) : '';
      continue;
    }
    if (f.type === 'progress') {
      const n = Number(v);
      out[f.key] = Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
      continue;
    }
    if (f.type === 'time') {
      const n = Number(v);
      out[f.key] = Number.isFinite(n) && n > 0 ? n : null;
      continue;
    }
    if (v === true || v === false) {
      out[f.key] = v;
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[f.key] = v;
      continue;
    }
    if (typeof v === 'object' && v !== null) {
      out[f.key] = '';
      continue;
    }
    out[f.key] = String(v ?? '').slice(0, MAX_FIELD_CHARS);
  }
  return out;
}

/** 批量版；非对象元素直接跳过（脏数据不该让整页空白） */
export function projectRows(rows, fields = []) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    out.push(projectRow(r, fields));
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/**
 * 读扩展的数据文件。
 *
 * @param {{dir:string, spec:object, maxBytes?:number}} o `dir` 是扩展目录
 * @returns {{ok:boolean, rows:Array, updatedAt:number, truncated:boolean, reason?:string}}
 */
export function readUiData({ dir, spec, maxBytes = MAX_UI_BYTES } = {}) {
  const file = String(spec?.view?.source?.file ?? '');
  if (!file) return { ok: false, rows: [], updatedAt: 0, truncated: false, reason: '没声明数据文件' };

  const root = resolvePath(String(dir || ''));
  const abs = resolvePath(join(root, file));
  /** 二次确认：解析之后仍要在扩展目录里（`a/../../x` 这种能绕过第一道字符串检查） */
  if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return { ok: false, rows: [], updatedAt: 0, truncated: false, reason: '数据文件跑到扩展目录外面了' };
  }
  if (!existsSync(abs)) {
    return { ok: false, rows: [], updatedAt: 0, truncated: false, reason: `还没有数据文件（${file}）` };
  }

  let stat;
  try {
    stat = statSync(abs);
  } catch (e) {
    return { ok: false, rows: [], updatedAt: 0, truncated: false, reason: String(e?.message || e) };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false, rows: [], updatedAt: 0, truncated: false,
      reason: `数据文件太大（${Math.round(stat.size / 1024)} KB，上限 ${Math.round(maxBytes / 1024)} KB）`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    return { ok: false, rows: [], updatedAt: 0, truncated: false, reason: `数据文件不是合法 JSON：${e?.message || e}` };
  }

  /**
   * 两种形状都收：顶层数组，或者 `{ rows: [], updatedAt }`。
   * 后者让扩展能自己报「这份数据是什么时候抓的」——比用文件 mtime 准，
   * 因为文件可能是被复制过来的。
   */
  const rawRows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.rows) ? parsed.rows : null);
  if (!rawRows) {
    return { ok: false, rows: [], updatedAt: 0, truncated: false, reason: '数据文件里既不是数组，也没有 rows 数组' };
  }
  const rows = projectRows(rawRows, spec?.view?.fields || []);
  return {
    ok: true,
    rows,
    updatedAt: Number(parsed?.updatedAt) || stat.mtimeMs || 0,
    truncated: rawRows.length > rows.length,
  };
}
