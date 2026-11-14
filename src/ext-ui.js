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

  /**
   * 自带页面：扩展写一份 HTML，面板用 iframe 加载。
   *
   * 2026-11-14 放宽（主人拍板：「市场上架要我们审核，不能让扩展缺功能」）。
   * 声明式 `view` 只能排版，做不了登录框、扫码、运行记录这类界面；
   * 允许扩展提供自己的页面后，UI 能力不再受宿主限制。
   *
   * 路径仍然卡在扩展目录内：这不是安全策略（审核过的扩展可以信任），
   * 而是防止 `../../` 把宿主自己的文件当扩展页发出去。
   */
  const page = String(raw.page ?? '').trim();
  if (page) {
    if (page.startsWith('/') || page.startsWith('\\') || /^[A-Za-z]:/.test(page) || page.split(/[\\/]/).includes('..')) {
      errors.push('ui.page 必须是扩展目录内的相对路径（不许绝对路径或 ..）');
    } else if (!/\.html?$/i.test(page)) {
      errors.push('ui.page 要指向一个 .html / .htm 文件');
    }
  }

  /**
   * 页面动作的运行方式。
   *
   *   · `mcp`（默认）—— 扩展是独立的 MCP 子进程，宿主把动作放进队列，
   *     扩展自己来取（长轮询）。跨进程，必然有这一跳。
   *   · `inprocess` —— 扩展提供一个 `.mjs`，宿主 `import()` 进来直接调函数。
   *     零 IPC、返回值直接回给面板，代价是这个模块跑在宿主进程里，
   *     和宿主共享一切（上架审核来兜）。
   *
   * 两种可以并存：`inprocess` 里没实现的动作仍然回落到 `mcp` 队列。
   */
  const runtimeRaw = String(raw.runtime ?? '').trim().toLowerCase();
  const runtime = runtimeRaw === 'inprocess' ? 'inprocess' : 'mcp';
  if (runtimeRaw && runtimeRaw !== 'inprocess' && runtimeRaw !== 'mcp') {
    errors.push('ui.runtime 只能是 inprocess / mcp（不写就是 mcp）');
  }
  const entry = String(raw.entry ?? '').trim();
  if (runtime === 'inprocess') {
    if (!entry) errors.push('ui.runtime=inprocess 时 ui.entry 必填（入口 .mjs）');
    else if (!/\.m?js$/i.test(entry)) errors.push('ui.entry 要指向 .js / .mjs');
    else if (entry.startsWith('/') || entry.startsWith('\\') || /^[A-Za-z]:/.test(entry) || entry.split(/[\\/]/).includes('..')) {
      errors.push('ui.entry 必须是扩展目录内的相对路径（不许绝对路径或 ..）');
    }
  }

  const view = raw.view && typeof raw.view === 'object' && !Array.isArray(raw.view) ? raw.view : null;
  if (!view && !page) errors.push('ui.view 必填（或者用 ui.page 指向自己的页面）');
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

  const form = normalizeForm(raw.form, errors);
  const actions = normalizeActions(raw.actions, errors);

  if (errors.length) return { ok: false, errors, spec: null };
  return {
    ok: true,
    errors: [],
    spec: {
      nav: { label, group: group || DEFAULT_GROUP },
      /** 扩展自带的页面（iframe 入口）；空串 = 走下面的声明式 view */
      page,
      /** 页面动作怎么跑：`inprocess` 直接 import 调函数，`mcp` 走队列 */
      runtime,
      entry,
      view: view ? {
        kind,
        title: String(view.title ?? '').trim().slice(0, 30) || label,
        /** 多久算「旧」：面板据此把更新时间标灰（秒）。0 = 不提示 */
        staleSec: Math.max(0, Math.min(86400, Number(view.staleSec) || 3600)),
        source: { file },
        fields: fields.fields,
      } : null,
      /**
       * 表单与按钮都是**声明**，不是能力：
       * `form` 只是说「这一页要显示哪些设置项」，真正读写走宿主已有的
       * `extensions.config.get/save`（secret 仍然不回显）；
       * `actions` 只是说「这一页有哪几个按钮」，点了进 `ext-ui-actions` 队列，
       * 由扩展自己来取，宿主不替它执行。
       */
      form,
      actions,
    },
  };
}

/**
 * 一页最多几个按钮。
 *
 * 这是**策略**不是技术限制：怕一页全是按钮、谁也不知道该点哪个。原来定 8，
 * 但扩展真做起来（B 站一个插件就有 9 个动作：刷、刷新、登录、看回复、
 * 弹幕查看/发送、扫码起停、测试分享）就会把整个扩展判成「清单不合格」，
 * 从列表和导航里隐藏——比按钮多一点严重得多。翻倍到 16，留够余量；
 * 真到 16 个还嫌多，该做的是分组折叠，不是继续卡上限。
 */
export const MAX_UI_ACTIONS = 16;
/** 表单一次最多列多少项（扩展的全部设置可能更多，前端按 keys 挑） */
export const MAX_FORM_KEYS = 40;

const FORM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * 表单声明。
 *
 * 三种写法：
 *   · `true`                —— 显示清单 `config` 里的全部设置项；
 *   · `['cookie','pushOwner']` —— 只显示这几项（按清单里的顺序，不按这里）；
 *   · `{ keys:[...], title:'B 站设置' }` —— 带小标题。
 *
 * **不校验 key 是否真的在 `config` 里**：那份清单是宿主自己读的，多写一个
 * 不存在的 key 只是不显示，不值得让整个界面校验失败。
 */
function normalizeForm(raw, errors) {
  const off = { enabled: false, keys: [], title: '' };
  if (raw === undefined || raw === null || raw === false) return off;
  let keys = null;
  let title = '';
  if (raw === true) {
    keys = [];
  } else if (Array.isArray(raw)) {
    keys = raw;
  } else if (typeof raw === 'object') {
    keys = Array.isArray(raw.keys) ? raw.keys : [];
    title = String(raw.title ?? '').trim().slice(0, 20);
  } else {
    errors.push('ui.form 只能是 true / 设置项名数组 / { keys, title }');
    return off;
  }
  const out = [];
  for (const [i, k] of keys.entries()) {
    const key = String(k ?? '').trim();
    if (!key) {
      errors.push(`form.keys[${i}] 是空的`);
      continue;
    }
    if (RESERVED_KEYS.includes(key) || !FORM_KEY_RE.test(key)) {
      errors.push(`form.keys[${i}] 的「${key}」不合法（字母开头，只含字母数字 _ . -，最多 64 位）`);
      continue;
    }
    if (!out.includes(key)) out.push(key);
  }
  if (out.length > MAX_FORM_KEYS) errors.push(`form.keys 最多 ${MAX_FORM_KEYS} 个`);
  return { enabled: true, keys: out.slice(0, MAX_FORM_KEYS), title };
}

/**
 * 按钮声明。
 *
 * 只认 `{ id, label, confirm? }`；`id` 是扩展自己约定的动作名，宿主**只负责
 * 校验「这个 id 在清单里写过」再入队**，不理解它的含义。
 */
function normalizeActions(raw, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push('ui.actions 必须是数组');
    return [];
  }
  const out = [];
  for (const [i, a] of raw.entries()) {
    const one = typeof a === 'string' ? { id: a } : (a && typeof a === 'object' ? a : null);
    if (!one) {
      errors.push(`actions[${i}] 既不是字符串也不是对象`);
      continue;
    }
    const id = String(one.id ?? '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,31}$/.test(id)) {
      errors.push(`actions[${i}] 的 id「${id}」不合法（字母开头，只含字母数字 _ -，最多 32 位）`);
      continue;
    }
    if (out.some((x) => x.id === id)) {
      errors.push(`actions[${i}] 的 id「${id}」重复了`);
      continue;
    }
    const label = String(one.label ?? '').trim();
    if (!label || label.length > 12) {
      errors.push(`actions[${i}] 的 label 必填且不超过 12 字`);
      continue;
    }
    out.push({ id, label, confirm: one.confirm === true });
  }
  if (out.length > MAX_UI_ACTIONS) errors.push(`ui.actions 最多 ${MAX_UI_ACTIONS} 个`);
  return out.slice(0, MAX_UI_ACTIONS);
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
  /**
   * 附带的运行状态（今日刷了几轮、上次错误、推送额度……）。
   *
   * 只透传一层标量对象，不做递归：页面是扩展自己写的，宿主没必要替它
   * 做数据整形；但也别把整棵大树原样丢给前端，那等于绕开字段白名单。
   */
  const meta = parsed?.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta)
    ? Object.fromEntries(Object.entries(parsed.meta).slice(0, 40).map(([k, v]) => {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [k, v];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return [k, Object.fromEntries(Object.entries(v).slice(0, 20).map(([k2, v2]) => [
          k2,
          (v2 === null || typeof v2 === 'string' || typeof v2 === 'number' || typeof v2 === 'boolean') ? v2 : String(v2),
        ]))];
      }
      return [k, String(v)];
    }))
    : null;
  return {
    ok: true,
    rows,
    meta,
    updatedAt: Number(parsed?.updatedAt) || stat.mtimeMs || 0,
    truncated: rawRows.length > rows.length,
  };
}
