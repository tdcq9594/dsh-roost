/**
 * 日志脱敏（E7）
 * =============
 *
 * 「写日志之前统一脱敏，不是每个调用点各写一遍」——这是报告 §15-E7 的
 * 硬要求，也是调研对象 `[A]/src/core/logger.js:1-10` 的做法。
 *
 * 现成方案与为什么合成一份：
 *  · 调研对象 `[A]/src/core/redact.js`（29 行）：文本正则 +
 *    `registerSecret()` 注册已知敏感值，写日志前统一 `redact(message)`。
 *  · 我们框架 `bot/src/runtime.js:14` 的 `redact()`：对象递归 +
 *    `SENSITIVE_KEY` 字段名掩码（事件报文用），还导出给账本复用。
 *
 * 两仓是**独立 npm 包**，dsh-roost 不能 import bot 的模块（也不该复制
 * 对方的整个 logger）。所以这里把两种输入形态合成一份纯函数：字符串走
 * 正则、对象走递归，bot 侧一动不动。`setSecretProvider()` 让 host 把
 * 当前配置里的密钥挂进来，改配置后不用重新注册。
 *
 * **不改日志的 ring 大小与生命周期**：dsh-roost 的 `logs` 是进程内
 * 400 条环形缓冲、专门给面板看「刚才那条为什么没回」，DSH 宿主自己另有
 * 日志；对方那套「按天写文件 + ring 500 + 保留 14 天」是它的实现描述，
 * 照搬会在用户数据目录里新增一堆日志文件，超出本件范围。
 */

/** 字段名命中就整段替换（和 `bot/src/runtime.js` 的 SENSITIVE_KEY 同一口径，补了几个别名） */
export const SENSITIVE_KEY = /^(auth_token|token|access_token|secret|client_secret|cookie|password|passwd|pwd|api[_-]?key|skey|p_skey|clientkey|authorization|music_u)$/i;

/** 顺序有讲究：Authorization 要在通用 key=value 之前，免得只抹掉 "Bearer" */
const PATTERNS = [
  [/(Authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  /**
   * Basic 必须在通用 key=value **之前**：否则 `Authorization: Basic dXNl…`
   * 会先把 "Basic" 当成值抹成 `Authorization: *** dXNl…`，base64 反而原样漏出去。
   */
  /** `i` 不能省：小写 `basic` 也要认；`Basic authentication` 是正常说明文字，别抹 */
  [/(Basic\s+)(?!authentication\b)[A-Za-z0-9+/=]{8,}/gi, '$1***'],
  [/((?:access[_-]?token|token|password|passwd|pwd|secret|api[_-]?key|cookie|music_u|p_skey|skey|clientkey|authorization)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1***'],
  /** 全角冒号/等号（中文日志里常见）与 URL 编码的等号 */
  [/((?:access[_-]?token|token|password|passwd|pwd|secret|api[_-]?key|authorization)\s*[:：=＝]\s*["']?)([^\s"',;&]{4,})/gi, '$1***'],
  [/((?:access[_-]?token|token|api[_-]?key)%3[dD])([^\s&"']{4,})/gi, '$1***'],
  [/\bsk-[A-Za-z0-9_.-]{16,}\b/g, 'sk-***'],
  [/([?&](?:token|access_token|key|api_key)=)[^&\s]+/gi, '$1***'],
  /** PEM 私钥整块，别只抹掉第一行 */
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '(私钥已隐藏)'],
];

/** 手工注册的已知敏感值（如当前 OneBot token） */
const known = new Set();
/**
 * 动态来源用 **Set 累加**，不是单例：同一进程可能 `apply()` 出多个实例
 * （多机器人 / 测试连跑），后者覆盖前者会让前一个实例的密钥裸奔。
 * 每个 provider 返回注销函数，挂在 `ctx.effect()` 上随实例卸载。
 */
const providers = new Set();

export function registerSecret(value) {
  const v = String(value ?? '');
  if (v.length >= 6) known.add(v);
}

/** @param {() => Iterable<string>} fn 每次脱敏时现取，不要缓存结果 */
export function addSecretProvider(fn) {
  if (typeof fn !== 'function') return () => {};
  providers.add(fn);
  return () => providers.delete(fn);
}

/**
 * 单实例/测试用：只替换**自己上一次**注册的那个。
 * 不能 `providers.clear()` —— 那会把别的实例 add 进来的保护一起清掉。
 */
let singleOff = null;
export function setSecretProvider(fn) {
  if (singleOff) { singleOff(); singleOff = null; }
  return typeof fn === 'function' ? (singleOff = addSecretProvider(fn)) : () => {};
}

export function clearSecrets() {
  known.clear();
  providers.clear();
  singleOff = null;
}

function currentSecrets() {
  const out = new Set(known);
  for (const fn of providers) {
    try {
      for (const v of fn() || []) {
        if (typeof v === 'string' && v.length >= 6) out.add(v);
      }
    } catch { /* 取密钥失败不该让日志写不出来 */ }
  }
  return out;
}

/**
 * 文本脱敏。幂等：替换产物是 `***`，长度小于正则要求的 4 个字符，
 * 再过一遍不会把脱敏结果改坏（日志层会经过两道，见 host.js）。
 */
export function redactText(text) {
  let s = String(text ?? '');
  for (const v of currentSecrets()) {
    if (v && s.includes(v)) s = s.split(v).join('***');
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

/** 对象/数组递归脱敏，返回新值，不改原对象（日志参数可能还要给别处用） */
export function redactValue(value, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue(v, depth + 1));
  if (value instanceof Error) return redactText(value.stack || value.message || String(value));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return redactValue(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return redactValue([...value].slice(0, 20), depth + 1);
  if (typeof value === 'bigint' || typeof value === 'symbol') return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<二进制 ${value.byteLength} 字节>`;
  if (value && typeof value === 'object') {
    const out = {};
    let entries;
    /** getter 抛错、Proxy、循环引用：日志参数什么都可能传进来，不能让它拖垮写日志 */
    try { entries = Object.entries(value); } catch { return '(对象不可读)'; }
    for (const [k, v] of entries) {
      try { out[k] = SENSITIVE_KEY.test(k) ? '***' : redactValue(v, depth + 1); }
      catch { out[k] = '(不可读)'; }
    }
    return out;
  }
  return typeof value === 'string' ? redactText(value) : value;
}
