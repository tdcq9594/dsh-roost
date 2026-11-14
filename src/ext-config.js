/**
 * 扩展配置：声明校验 / 默认值 / 输入校验 / 落盘 / 下发
 * ==================================================
 *
 * 为什么需要这一层：扩展是 MCP server（stdio 进程），协议只带 tools / resources /
 * prompts，**没有 UI**。所以「扩展自己的设置」只能由宿主代画、宿主代存、宿主代下发。
 *
 * 三层约定：
 *   1. 扩展在 `plugin.json` 里用 **`config`** 声明字段（本文件 `normalizeConfigSpec` 校验）；
 *   2. 面板按声明渲染表单，值存 `<dataDir>/extensions/<id>/config.json`；
 *      标了 `secret: true` 的项**不进这个文件**，单独存
 *      `<dataDir>/secrets/<id>.config.json`（0600，与令牌文件分开，令牌轮换不覆盖它）；
 *   3. `ext-launcher.mjs` 读这两份，把非敏感项拼成 `ROOST_EXT_CONFIG`（JSON 字符串）、
 *      敏感项按 `ROOST_EXT_SECRET_<KEY>` 注入子进程 env。
 *
 * 安全边界（沿用 §5.4 / 方案 L）：
 *   · 键名由**宿主**从声明生成（大写化 + 非字母数字转下划线），扩展不能声明任意 env；
 *   · 不支持 `path` / `file` 类型 —— 配置里出现路径就等于让面板能指定读写目标；
 *   · 声明本身也不许带可执行语义（没有 command / url / cwd 这类键）。
 *
 * 设计约束：零外部依赖；`dir` 可注入；纯函数部分（normalize / fill / validate /
 * envOf）不碰磁盘，单测不需要临时目录。
 */

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** 允许的字段类型。刻意没有 `path` / `file`。 */
export const CONFIG_TYPES = Object.freeze(['string', 'number', 'boolean', 'select', 'array', 'object']);

/** 键名规范：与 env 变量名对齐（大写化后仍合法），也防止 `__proto__` 之类。 */
export const CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

/**
 * 一个扩展最多声明多少字段、嵌套多深。
 *
 * 不是性能限制，是防止面板被一份清单撑爆。最初定 32 是按「常见扩展 10~20 项」
 * 留了一倍余量；但 B 站这种把「怎么刷 / 评论分享 / 看画面 / 写动作」都做成可调项
 * 的扩展会顶到边，32 逼着把不相关的东西硬合并。放到 64 仍然是一屏放得下的量级
 * （面板按卡片分组，不是平铺），再往上就该考虑拆扩展了。
 */
export const MAX_FIELDS = 64;
export const MAX_DEPTH = 2;

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 浅判一个值是普通对象（排除 null / 数组）。 */
const isPlain = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 校验并规范化一个字段声明。
 *
 * 只保留认识的键 —— 未知键直接丢弃而不是报错：以后加字段（比如 `group`）时，
 * 老宿主读新清单不会整份拒收。
 *
 * @param {string} key 字段名
 * @param {object} raw 清单里写的声明
 * @param {number} depth 当前嵌套深度（顶层为 0）
 * @param {string[]} errors 收集错误
 * @returns {object|null} 规范化后的声明；非法时返回 null 并写 errors
 */
function normalizeField(key, raw, depth, errors) {
  const at = `config.${key}`;
  if (!CONFIG_KEY_RE.test(String(key))) {
    errors.push(`${at}: 字段名只能是字母开头的 1–32 位字母/数字/下划线`);
    return null;
  }
  if (RESERVED_KEYS.has(key)) {
    errors.push(`${at}: 保留字段名`);
    return null;
  }
  if (!isPlain(raw)) {
    errors.push(`${at}: 声明必须是对象`);
    return null;
  }
  if (!CONFIG_TYPES.includes(raw.type)) {
    errors.push(`${at}: type 必须是 ${CONFIG_TYPES.join(' / ')} 之一`);
    return null;
  }
  const out = {
    key,
    type: raw.type,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : key,
    hint: typeof raw.hint === 'string' ? raw.hint.slice(0, 200) : '',
    required: raw.required === true,
    secret: raw.secret === true,
  };

  /**
   * `secret` 只对顶层字符串有意义：
   *   · 布尔/数字当密钥没有意义，前端会渲染成「已设置」的黑框，反而误导；
   *   · 嵌套对象里的 secret 会被 `validateObject` / `fillDefaults` 跳过（它们按
   *     顶层字段处理密钥），允许写等于让它静默丢值 —— 直接拒掉比默默失效好。
   */
  if (out.secret && raw.type !== 'string') {
    errors.push(`${at}: secret 只能用于 string`);
    return null;
  }
  if (out.secret && depth > 0) {
    errors.push(`${at}: secret 只能放在顶层，不能嵌进 object`);
    return null;
  }

  if (raw.type === 'number') {
    if (raw.min !== undefined) {
      if (typeof raw.min !== 'number' || !Number.isFinite(raw.min)) errors.push(`${at}: min 必须是有限数字`);
      else out.min = raw.min;
    }
    if (raw.max !== undefined) {
      if (typeof raw.max !== 'number' || !Number.isFinite(raw.max)) errors.push(`${at}: max 必须是有限数字`);
      else out.max = raw.max;
    }
    if (out.min !== undefined && out.max !== undefined && out.min > out.max) errors.push(`${at}: min 大于 max`);
    out.integer = raw.integer === true;
  }

  if (raw.type === 'string') {
    out.maxLength = Number.isInteger(raw.maxLength) && raw.maxLength > 0 ? Math.min(raw.maxLength, 4096) : 512;
    if (raw.placeholder !== undefined) out.placeholder = String(raw.placeholder).slice(0, 80);
  }

  if (raw.type === 'select') {
    /**
     * options 支持两种写法：`['a','b']` 与 `[{value,label}]`。
     * 统一成 `{value,label}`，前端只认一种形态。
     */
    const opts = Array.isArray(raw.options) ? raw.options : [];
    if (!opts.length) {
      errors.push(`${at}: select 需要非空 options`);
      return null;
    }
    out.options = opts.map((o) => {
      if (typeof o === 'string' || typeof o === 'number') return { value: String(o), label: String(o) };
      if (isPlain(o) && (typeof o.value === 'string' || typeof o.value === 'number')) {
        return { value: String(o.value), label: typeof o.label === 'string' ? o.label.slice(0, 40) : String(o.value) };
      }
      return null;
    }).filter(Boolean).slice(0, 64);
    if (out.options.length !== opts.length) errors.push(`${at}: options 里有无法识别的项`);
  }

  if (raw.type === 'array') {
    const itemType = isPlain(raw.items) ? raw.items.type : 'string';
    if (!['string', 'number', 'boolean'].includes(itemType)) {
      errors.push(`${at}: array.items.type 只能是 string / number / boolean`);
      return null;
    }
    out.itemsType = itemType;
    out.maxItems = Number.isInteger(raw.maxItems) && raw.maxItems > 0 ? Math.min(raw.maxItems, 64) : 32;
  }

  if (raw.type === 'object') {
    if (depth + 1 >= MAX_DEPTH) {
      errors.push(`${at}: 嵌套最多 ${MAX_DEPTH} 层`);
      return null;
    }
    if (!isPlain(raw.properties) || !Object.keys(raw.properties).length) {
      errors.push(`${at}: object 需要非空 properties`);
      return null;
    }
    /**
     * 子字段也要限量：顶层限了 32，但一个 object 里塞一千个照样能把面板撑爆
     * （`MAX_FIELDS` 的本意是「一份表单最多多少控件」，不分层级）。
     */
    if (Object.keys(raw.properties).length > MAX_FIELDS) {
      errors.push(`${at}: properties 最多 ${MAX_FIELDS} 个字段`);
      return null;
    }
    const props = [];
    for (const [k, v] of Object.entries(raw.properties)) props.push(normalizeField(k, v, depth + 1, errors));
    out.properties = props.filter(Boolean);
  }

  /**
   * 敏感字段不许写 `default`：声明会原样回给面板（前端要按它渲染），
   * 作者在 default 里塞了真密钥就等于明文下发给浏览器。
   */
  if (raw.default !== undefined && out.secret) {
    errors.push(`${at}: secret 字段不能写 default（默认值会明文返回给面板）`);
    return null;
  }

  if (raw.default !== undefined) {
    const d = checkValue(out, raw.default, { defaulting: true });
    if (d.error) errors.push(`${at}: default ${d.error}`);
    else out.default = d.value;
  }

  return out;
}

/**
 * 校验一个值是否符合字段声明。
 *
 * @param {object} field normalizeField 的产物
 * @param {unknown} value 待校验值
 * @returns {{value?:unknown,error?:string,empty?:boolean}}
 *   `empty: true` 表示「没填且非必填」——调用方应丢弃该键。
 */
export function checkValue(field, value) {
  const label = field.label || field.key;
  /**
   * 未填统一在这一层判，各分支只管「有值时的合法性」：
   * 表单清空后各控件给的形态并不一致（数字框给 `''`、复选框可能给 `undefined`），
   * 分散到每个分支判会漏一两处 —— 漏掉的后果是**非必填的 object/array
   * 被当成「类型错误」**，整份保存失败。
   */
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return { empty: true };
  }
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return { error: '必须是字符串' };
      const v = value.trim();
      if (v.length > field.maxLength) return { error: `超过 ${field.maxLength} 字` };
      return { value: v };
    }
    case 'number': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { error: '必须是有限数字' };
      } else if (typeof value === 'string' && value.trim() !== '') {
        // 表单控件给的是字符串；空串留给下面的「未填」分支。
        const n = Number(value.trim());
        if (!Number.isFinite(n)) return { error: '必须是数字' };
        value = n;
      } else {
        return { error: '必须是数字' };
      }
      const n = Number(value);
      if (field.integer && !Number.isInteger(n)) return { error: '必须是整数' };
      if (field.min !== undefined && n < field.min) return { error: `不能小于 ${field.min}` };
      if (field.max !== undefined && n > field.max) return { error: `不能大于 ${field.max}` };
      return { value: n };
    }
    case 'boolean':
      if (typeof value === 'boolean') return { value };
      if (value === 'true') return { value: true };
      if (value === 'false') return { value: false };
      return { error: '必须是布尔值' };
    case 'select': {
      const s = String(value);
      if (!field.options.some((o) => o.value === s)) return { error: `只能是 ${field.options.map((o) => o.value).join(' / ')}` };
      return { value: s };
    }
    case 'array': {
      if (!Array.isArray(value)) return { error: '必须是数组' };
      if (value.length > field.maxItems) return { error: `最多 ${field.maxItems} 项` };
      const out = [];
      for (const one of value) {
        const r = checkValue({ ...field, type: field.itemsType, key: field.key, label, required: false }, one);
        if (r.error) return { error: `数组项${r.error}` };
        if (!r.empty) out.push(r.value);
      }
      if (!out.length && !field.required) return { empty: true };
      return { value: out };
    }
    case 'object': {
      if (!isPlain(value)) return { error: '必须是对象' };
      const { values, errors } = validateObject(field.properties, value);
      if (errors.length) return { error: errors[0] };
      if (!Object.keys(values).length && !field.required) return { empty: true };
      return { value: values };
    }
    default:
      return { error: '未知类型' };
  }
}

/** 按声明表校验一整份对象（内部用，也是 validateValues 的实现）。 */
function validateObject(fields, input) {
  const values = {};
  const errors = [];
  for (const f of fields) {
    const raw = input[f.key];
    if (f.secret) {
      /**
       * 敏感项走单独的文件，value 里永远不会有它。
       * 校验时只关心「必填有没有值」，值本身由 config.save 的 secretsPatch 处理。
       */
      continue;
    }
    const r = checkValue(f, raw);
    if (r.error) errors.push(`${f.label || f.key}：${r.error}`);
    else if (!r.empty) values[f.key] = r.value;
    else if (f.required) errors.push(`${f.label || f.key}：必填`);
  }
  return { values, errors };
}

/**
 * 校验 `plugin.json` 的 `config` 声明。
 *
 * @param {unknown} raw
 * @returns {{ok:boolean, spec?:object[], errors:string[]}}
 */
export function normalizeConfigSpec(raw) {
  if (raw === undefined || raw === null) return { ok: true, spec: [], errors: [] };
  if (!isPlain(raw)) return { ok: false, spec: [], errors: ['config 必须是对象（字段名 → 声明）'] };
  const keys = Object.keys(raw);
  if (keys.length > MAX_FIELDS) {
    return { ok: false, spec: [], errors: [`config 最多 ${MAX_FIELDS} 个字段（现在 ${keys.length}）`] };
  }
  const errors = [];
  const spec = [];
  for (const key of keys) spec.push(normalizeField(key, raw[key], 0, errors));
  if (errors.length) return { ok: false, spec: [], errors };
  return { ok: true, spec: spec.filter(Boolean), errors: [] };
}

/**
 * 用 default 补齐缺的键，产出「面板打开时看到的初始值」。
 *
 * 只补非敏感字段 —— 敏感值面板永远拿不到明文，只拿得到 `secretSet` 布尔。
 */
export function fillDefaults(spec, values = {}) {
  const out = {};
  for (const f of spec) {
    if (f.secret) continue;
    /**
     * object 必须**先递归**再谈「有没有现成值」：拿到一份部分填过的
     * `{a: 1}` 时，漏掉的兄弟键要沿用各自的 default，直接赋值会把它丢掉。
     */
    if (f.type === 'object') {
      const cur = isPlain(values) && isPlain(values[f.key]) ? values[f.key] : {};
      const nested = fillDefaults(f.properties, cur);
      if (Object.keys(nested).length) out[f.key] = nested;
      continue;
    }
    if (isPlain(values) && Object.hasOwn(values, f.key)) {
      out[f.key] = values[f.key];
      continue;
    }
    if (f.default !== undefined) out[f.key] = f.default;
  }
  return out;
}

/**
 * 校验面板提交的整份值。
 *
 * @param {object[]} spec
 * @param {object} input 表单提交的原始值（数字可能是字符串）
 * @param {object} [o]
 * @param {Set<string>} [o.secretPresent] 哪些敏感项**已经有值**（决定必填是否满足）
 * @returns {{ok:boolean, values?:object, errors?:string[]}}
 */
export function validateValues(spec, input, { secretPresent = new Set() } = {}) {
  const values = {};
  const errors = [];
  for (const f of spec) {
    if (f.secret) {
      if (f.required && !secretPresent.has(f.key)) errors.push(`${f.label}：必填`);
      continue;
    }
    const r = checkValue(f, isPlain(input) ? input[f.key] : undefined);
    if (r.error) errors.push(`${f.label}：${r.error}`);
    else if (!r.empty) values[f.key] = r.value;
    else if (f.required) errors.push(`${f.label}：必填`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, values };
}

/** 敏感项键名 → env 变量名（`apiKey` → `ROOST_EXT_SECRET_APIKEY`）。 */
export function secretEnvName(key) {
  return `ROOST_EXT_SECRET_${String(key).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** 把校验过的值 + 敏感值拼成子进程 env（只拼接，不读盘）。 */
export function envOf(spec, values, secrets) {
  const env = {};
  // 空 spec 也注入：扩展拿到 `{}` 比拿不到变量更容易判断「宿主有这套机制但没声明字段」。
  env.ROOST_EXT_CONFIG = JSON.stringify(fillDefaults(spec, values));
  for (const f of spec) {
    if (!f.secret) continue;
    const v = secrets?.[f.key];
    // 缺失时给空串：扩展拿到空值自己判，比 env 里凭空少一个键更好排查。
    env[secretEnvName(f.key)] = typeof v === 'string' ? v : '';
  }
  return env;
}

/**
 * 磁盘这一侧：config.json（非敏感）+ secrets/<id>.config.json（敏感）。
 *
 * @param {object} o
 * @param {string} o.dir 数据目录
 * @param {object} [o.log]
 */
export function createExtConfig({ dir, log = () => {} } = {}) {
  const extDirOf = (id) => join(dir, 'extensions', id);
  const fileOf = (id) => join(extDirOf(id), 'config.json');
  const secretFileOf = (id) => join(dir, 'secrets', `${id}.config.json`);

  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };

  function writeAtomic(file, value, mode = 0o600) {
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode); } catch { /* Windows 忽略 mode */ }
  }

  /** 非敏感值（坏文件按空处理，不崩）。 */
  const read = (id) => {
    const v = readJson(fileOf(id));
    return isPlain(v) ? v : {};
  };

  /** 敏感值原文 —— 只在 launcher 与「保存」路径里用，**绝不进面板响应**。 */
  const readSecret = (id) => {
    const v = readJson(secretFileOf(id));
    return isPlain(v) ? v : {};
  };

  /**
   * 保存：非敏感值整份重写；敏感值按 patch 合并
   * （键不出现 = 不动，`''` / `null` = 清除）。
   */
  function save(id, spec, values, secretPatch = {}) {
    try {
      writeAtomic(fileOf(id), fillDefaults(spec, values));
    } catch (e) {
      log.warn?.(`扩展 ${id} 的配置写入失败：${e?.message ?? e}`);
      return { ok: false, message: `配置写入失败：${e?.message ?? e}` };
    }
    const patchKeys = Object.keys(secretPatch);
    if (patchKeys.length) {
      const cur = readSecret(id);
      const next = { ...cur };
      for (const k of patchKeys) {
        const v = secretPatch[k];
        if (v === undefined) continue;
        if (v === '' || v === null) delete next[k];
        else next[k] = String(v);
      }
      try {
        writeAtomic(secretFileOf(id), next, 0o600);
      } catch (e) {
        log.warn?.(`扩展 ${id} 的密钥写入失败：${e?.message ?? e}`);
        return { ok: false, message: `密钥写入失败：${e?.message ?? e}` };
      }
    }
    return { ok: true, values: read(id) };
  }

  /* eslint-disable no-use-before-define -- 下面几个互相引用，都是同一作用域内的函数声明 */
  return {
    fileOf,
    secretFileOf,
    read,
    readSecret,
    /** 面板只拿得到「哪些敏感项已设置」。 */
    secretKeys: (id) => Object.keys(readSecret(id)),
    save,
    /** 删除整个扩展时清掉两份文件。 */
    clear(id) {
      for (const f of [fileOf(id), secretFileOf(id)]) {
        try { fs.rmSync(f, { force: true }); } catch { /* 不存在就算了 */ }
      }
    },
    /** launcher 用：算出要注入的 env（不写任何东西）。 */
    envFor: (id, spec) => envOf(spec, read(id), readSecret(id)),
  };
}
