/**
 * 扩展清单与原子落位（方案 §3.1 / 实施阶段 1.1）。
 *
 * 只做三件事，别的一概不管：
 *   1. 读**唯一**清单 `plugin.json` 并校验（无转换层，仓内那份原样复制）；
 *   2. 把扩展目录原子落位到 `<dataDir>/extensions/<id>/`；
 *   3. 用每目录一份的 `.source.json` 区分「市场装的」与「用户手写的」。
 *
 * 令牌、受管块、权限组、记忆都不在这里 —— 分别在 3.2 / 1.2 / 1.3 / 4.1。
 *
 * 设计约束：
 *   · 零外部依赖（本仓 src 只用 node 内置模块）；
 *   · `dir` 可注入，测试一律用临时目录，绝不碰真实 `<dataDir>`；
 *   · 点开头目录（`.<id>.installing` / `.<id>.old`）扫描器一律不认。
 */

import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

import { dataDir } from './config.js';
import { normalizeUiSpec } from './ext-ui.js';
import { normalizeConfigSpec } from './ext-config.js';

/** 与方案 §3.1 一致：小写开头、2–32 字符、只含小写字母数字与短横线。 */
export const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const EXT_KIND = 'dsh-extension';
export const SOURCE_FILE = '.source.json';
export const MANIFEST_FILE = 'plugin.json';

/**
 * 扩展令牌的 scope 策略。
 *
 * 默认**只给两件**：写自己的记忆（`memory:write`）+ 读状态心情（`state:read`）。
 * 发消息、主动消息、开会话这些必须由扩展在清单里声明、主人在安装时显式确认 ——
 * 默认值一旦放宽，等于「装上就能以机器人身份往外说话」。
 *
 * ⚠️ `EXT_ALLOWED_SCOPES` 必须与 `api-v1.js` 的 `V1_SCOPES` 逐项一致，
 * 由 `test/ext-scopes.test.js` 断言（放在测试里而不是 import，避免循环依赖）。
 */
export const EXT_DEFAULT_SCOPES = Object.freeze(['memory:write', 'state:read']);

export const EXT_ALLOWED_SCOPES = Object.freeze([
  'message:write', 'say:write', 'state:read', 'context:read',
  'memory:read', 'memory:write', 'proactive:write', 'session:write',
  'prompt:write', 'agent:write', 'core:write',
]);

/** 会对外产生可见动作（说话 / 刷屏 / 改人格 / 开会话）的 scope，安装时必须主人点头。 */
export const EXT_SENSITIVE_SCOPES = Object.freeze([
  'message:write', 'say:write', 'proactive:write', 'session:write', 'prompt:write', 'agent:write',
  'core:write',
]);

/** 去重 + 过滤未知项；结果为空时退回默认（绝不返回「无 scope 但令牌有效」这种半吊子态）。 */
export function normalizeScopes(list) {
  if (!Array.isArray(list)) return [...EXT_DEFAULT_SCOPES];
  const clean = [...new Set(list.filter((s) => typeof s === 'string' && EXT_ALLOWED_SCOPES.includes(s)))];
  return clean.length ? clean : [...EXT_DEFAULT_SCOPES];
}

/** 清单声明的 scope 里，哪些需要主人确认。 */
export function sensitiveScopesOf(manifest) {
  const want = Array.isArray(manifest?.scopes) ? manifest.scopes : [];
  return want.filter((s) => EXT_SENSITIVE_SCOPES.includes(s));
}

/** 官方 `dsh-credentials/lib/index.js:13` 的 REF_PATTERN，短横线必须规范化。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function extensionsDir(dir = dataDir()) {
  return join(dir, 'extensions');
}

export function secretsDir(dir = dataDir()) {
  return join(dir, 'secrets');
}

/**
 * REF 只作 env 变量名 / 审计键 / secrets 文件名的**命名规范**（方案 L 不用
 * `${credential:REF}` 模板解析）。两个只差短横线的 id 不能撞名。
 */
export function credentialRef(id) {
  const ref = `ROOST_EXT_${String(id).toUpperCase().replace(/-/g, '_')}_TOKEN`;
  if (!REF_PATTERN.test(ref)) throw new Error(`REF 不合官方规则：${ref}`);
  return ref;
}

/** 回环地址白名单：`url` 形态只认本机，别让扩展清单指到公网。 */
function isLoopbackUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/**
 * 校验清单。**返回错误清单而不是抛**，安装器要把原因显示给用户。
 *
 * 额外一条方案 L 安全约束：清单里不许有 `env` 键。扩展仓永远不能直接
 * 指定被 spawn 的可执行文件之外的运行期环境；真 server 的 env 由 launcher
 * 从私有 secrets 注入（§3.2 / §5.4）。
 *
 * ⚠️ **信任边界**：`command` / `args` / `cwd` 这里只校验类型与非空，**内容
 * 不做白名单**。阶段 1 是手工放扩展，清单内容视为可信；真正执行前的
 * 「用户确认 + 市场验签」是阶段 6（§3.1:199 / §10.1:902）的职责。3.2 接
 * launcher 时别把这里误当成已经审过命令，否则会少一道确认。
 */
export function validateManifest(raw, { expectedId } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['plugin.json 不是对象'], manifest: null };
  }
  const m = raw;

  if (m.api !== undefined && m.api !== 1) errors.push('api 只能是 1');
  if (m.kind !== undefined && m.kind !== EXT_KIND) errors.push(`kind 只能是 ${EXT_KIND}`);
  if (typeof m.id !== 'string' || !EXT_ID_RE.test(m.id)) {
    errors.push(`id 不合法（需匹配 ${EXT_ID_RE}）`);
  } else if (expectedId !== undefined && m.id !== expectedId) {
    errors.push(`id 与目录名不一致（${m.id} ≠ ${expectedId}）`);
  }
  if (m.serverName !== undefined && m.serverName !== m.id) {
    errors.push('serverName 必须等于 id（工具名 / section 名 / 组名全由 id 推导）');
  } else if (m.serverName === undefined) {
    errors.push('缺 serverName');
  }
  for (const k of ['name', 'description']) {
    if (typeof m[k] !== 'string' || !m[k].trim()) errors.push(`${k} 必填`);
  }
  if (m.transport !== 'stdio' && m.transport !== 'streamable-http') {
    errors.push('transport 只能是 stdio 或 streamable-http');
  }
  if (m.transport === 'stdio') {
    if (typeof m.command !== 'string' || !m.command.trim()) errors.push('stdio 缺 command');
    if (m.args !== undefined && (!Array.isArray(m.args) || m.args.some((a) => typeof a !== 'string'))) {
      errors.push('args 必须是字符串数组');
    }
  }
  if (m.transport === 'streamable-http' && !isLoopbackUrl(m.url)) {
    errors.push('streamable-http 的 url 必须是回环地址');
  }
  if (Object.hasOwn(m, 'env')) errors.push('清单不许自带 env 键（方案 L：env 由宿主注入）');
  /**
   * scope 声明：扩展要什么权限必须写在这里，装的时候主人确认。
   * 未知项直接拒 —— 写错一个字母就静默少一个权限，比报错更难查。
   */
  if (m.scopes !== undefined) {
    if (!Array.isArray(m.scopes) || m.scopes.some((x) => typeof x !== 'string')) {
      errors.push('scopes 必须是字符串数组');
    } else {
      const bad = m.scopes.filter((x) => !EXT_ALLOWED_SCOPES.includes(x));
      if (bad.length) errors.push(`scopes 含未知项：${bad.join('、')}（允许：${EXT_ALLOWED_SCOPES.join('、')}）`);
    }
  }
  /**
   * 四形态与「接管内置能力」声明（2026-11-14 全放开配套）。
   * 不在这里拦未知值：`ext-tier.js` 会把未知形态/未知能力按 L3 最保守处理，
   * 安装时明说「无法确认它会改什么」，比直接拒收更适合一个开放生态。
   */
  if (m.form !== undefined && typeof m.form !== 'string') errors.push('form 必须是字符串');
  if (m.overrides !== undefined && (!Array.isArray(m.overrides) || m.overrides.some((x) => typeof x !== 'string'))) {
    errors.push('overrides 必须是字符串数组（要接管的内置能力名）');
  }
  if (m.mounts !== undefined && (!Array.isArray(m.mounts) || m.mounts.some((x) => typeof x !== 'string'))) {
    errors.push('mounts 必须是字符串数组');
  }
  if (m.memory !== undefined && (typeof m.memory !== 'object' || m.memory === null || Array.isArray(m.memory))) {
    errors.push('memory 必须是对象');
  }
  /**
   * 配置声明：装的时候就校验，坏声明直接拒收而不是等面板渲染时才炸。
   * 规范化后的 spec 不写回清单（那会让 `saveUsage` 的 spread 把派生数据
   * 也落进 plugin.json），下游每次现算 —— 声明最多几十个字段，成本可忽略。
   */
  if (Object.hasOwn(m, 'config')) {
    const cfg = normalizeConfigSpec(m.config);
    if (!cfg.ok) errors.push(...cfg.errors);
  }
  /**
   * 6.1 声明式界面：装的时候就校验，坏声明直接拒收。
   *
   * 这里只校验、**不把规范化结果写回清单**——和 config 同一个理由：
   * 派生数据落进 `plugin.json` 之后，`saveUsage` 的 spread 会把它一起带走，
   * 下次读到的就是「规范化过的规范化结果」。下游每次现算（字段最多 12 个）。
   */
  if (Object.hasOwn(m, 'ui')) {
    const ui = normalizeUiSpec(m.ui);
    if (!ui.ok) errors.push(...ui.errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0 ? { ...m, kind: EXT_KIND, api: 1, serverName: m.id } : null,
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归删目录。
 *
 * `maxRetries` 不是洁癖：扩展进程的 **cwd 就是扩展目录**，Windows 上只要那个
 * 进程还活着，删内容可以、删目录本身会被拒 —— 于是留下一个空目录。重试几次
 * 能救回「进程刚好在退出」的情况；真删不掉时由调用方如实报出来，
 * 不要静默吞成「卸载成功」。
 */
function rmrf(p) {
  if (!exists(p)) return;
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}

export function createExtRegistry({ dir = dataDir(), log = () => {}, secrets = null, clientStore = null } = {}) {
  const root = extensionsDir(dir);

  /**
   * §3.5 ①：usage 的**唯一运行期数据源**。section 的 `text()` 每轮 assembly
   * 都会被调用，只读这张内存表（零 IO）；写盘只发生在下面的失效钩子里。
   */
  const usageCache = new Map();

  const pathOf = (id) => join(root, id);
  const sourcePathOf = (id) => join(pathOf(id), SOURCE_FILE);

  /** 有 `.source.json` = 市场装的；没有但目录在 = 用户手写（只读，绝不覆盖）。 */
  function sourceOf(id) {
    return readJson(sourcePathOf(id));
  }

  /**
   * 用户手写的扩展 = 目录存在、没有 `.source.json`、**而且真的是一份扩展**（有 `plugin.json`）。
   *
   * 为什么必须多最后这一条：Windows 上 `rmSync({recursive:true})` 遇到被占用的句柄
   * （扩展的子进程还没退干净就是这个情况）会**删掉内容却留下空目录**。这种残留
   * 没有 `.source.json`，按旧判据就成了「用户手写」——
   *   · 更新 → `install()` 报「用户手写的扩展，拒绝覆盖」；
   *   · 卸载 → `remove()` 同样被拒；
   *   · 已装列表 → `list()` 读不到清单，直接跳过，面板上这个扩展凭空消失。
   * 三个按钮一起废，而用户根本不知道发生了什么。
   *
   * 没有清单的目录不是任何人的作品，让安装直接接管即可。
   */
  function isForeign(id) {
    const dest = pathOf(id);
    if (!exists(dest)) return false;
    if (exists(sourcePathOf(id))) return false;
    return exists(join(dest, MANIFEST_FILE));
  }

  function read(id) {
    if (!EXT_ID_RE.test(id)) return null;
    const v = validateManifest(readJson(join(pathOf(id), MANIFEST_FILE)), { expectedId: id });
    return v.ok ? v.manifest : null;
  }

  /**
   * 这个扩展声明的配置字段（规范化后的 spec）。
   *
   * 清单里读不到 / 声明非法时返回空数组 —— 调用方按「没有设置项」处理，
   * 不把坏声明变成面板报错（装的时候 `validateManifest` 已经拦过一次）。
   */
  function configSpecOf(id) {
    const m = read(id);
    const r = normalizeConfigSpec(m?.config);
    return r.ok ? r.spec : [];
  }

  /** 清单里 `usage?: string` 可选覆盖自动文案；自动文案由 name + description 生成。 */
  function usageFromManifest(m) {
    return typeof m.usage === 'string' && m.usage.trim()
      ? m.usage
      : `${m.name}：${m.description}`;
  }

  /**
   * 目录里**有东西但装不上**的扩展：清单无效 / 读不出来。
   *
   * `list()` 遇到坏清单会静默跳过（这是对的，一个坏扩展不该拖垮整张列表），
   * 但跳过之后面板上就只剩「扩展目录里还没有东西」——用户完全看不出
   * 「我的扩展怎么没了」。0.11.0 就撞过：清单 35 个配置字段超过 32 上限，
   * 面板空、侧边栏入口也没了，只能靠日志里的 warn 找原因。
   *
   * 这里把原因捞出来交给面板显示，**不参与** `list()` 的判断。
   *
   * @returns {{id: string, errors: string[]}[]}
   */
  function problems() {
    let names;
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const ent of names) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      if (!EXT_ID_RE.test(ent.name)) continue;
      const v = validateManifest(readJson(join(root, ent.name, MANIFEST_FILE)), { expectedId: ent.name });
      if (!v.ok) out.push({ id: ent.name, errors: v.errors.map(String) });
    }
    return out;
  }

  /**
   * §3.5 ① 的失效钩子：面板保存 usage / 安装 / 更新 / 卸载 / 启动加载清单后调用。
   * 这里读一次盘，把结果放进内存；`liveUsage()` 之后完全不碰文件。
   */
  function refreshUsage(id) {
    if (!EXT_ID_RE.test(id)) {
      usageCache.delete(id);
      return '';
    }
    const m = read(id);
    if (!m) {
      usageCache.delete(id);
      return '';
    }
    const raw = usageFromManifest(m);
    usageCache.set(id, raw);
    return raw;
  }

  /** 只认内存表。没刷新过的 id 返回空串，绝不偷偷读文件。 */
  function liveUsage(id) {
    return usageCache.get(id) ?? '';
  }

  /** 扫描时跳过所有点开头目录：`.<id>.installing` / `.<id>.old` 不算已装扩展。 */
  function list() {
    let names;
    try {
      names = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const ent of names) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      if (!EXT_ID_RE.test(ent.name)) continue;
      const v = validateManifest(readJson(join(root, ent.name, MANIFEST_FILE)), { expectedId: ent.name });
      if (!v.ok) {
        log.warn?.(`扩展 ${ent.name} 清单无效，跳过：${v.errors.join('；')}`);
        continue;
      }
      // 启动加载清单 = §3.5 ① 的三个失效时机之一。只补 cache 里还没有的，
      // 避免每次 list() 都重复读盘；面板改过的不被覆盖。
      if (!usageCache.has(ent.name)) usageCache.set(ent.name, usageFromManifest(v.manifest));
      out.push({ id: ent.name, manifest: v.manifest, dir: join(root, ent.name), source: sourceOf(ent.name), foreign: isForeign(ent.name) });
    }
    // 只清「目录确实消失」的 usage。清单瞬时无效（手改到一半 / 写回瞬间 / 文件锁）
    // 时保留 cache，别让面板刚改过的说明被一次扫描打回默认文案；目录恢复后
    // 上面的 `!usageCache.has()` 分支也不会覆盖它，要生效请走 refreshUsage()。
    for (const id of [...usageCache.keys()]) {
      if (!out.some((x) => x.id === id) && !exists(pathOf(id))) usageCache.delete(id);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 原子落位：暂存目录 → 旧目录让位 → rename 上位 → 失败回滚。
   *
   * `source` 传对象表示「市场装的」，会写 `.source.json`；不传表示用户手写目录，
   * 之后 foreign 保护会拒绝任何覆盖它的安装。
   */
  function install(srcDir, { source = null } = {}) {
    const from = resolve(srcDir);
    const v = validateManifest(readJson(join(from, MANIFEST_FILE)), { expectedId: basename(from) });
    if (!v.ok) return { ok: false, reason: v.errors.join('；') };
    const id = v.manifest.id;

    const dest = pathOf(id);
    // §8.3：没有 `.source.json` 的目录是用户手写的，**只读、绝不覆盖**。
    // 这里不给 force 口子 —— 面板一旦能给，就等于给市场安装开了覆盖用户
    // 文件的后门。要接管就由用户自己先删目录，那是他看得见的动作。
    if (exists(dest) && isForeign(id)) {
      return { ok: false, reason: `目录 ${id} 是用户手写的扩展，拒绝覆盖（foreign 保护）` };
    }

    fs.mkdirSync(root, { recursive: true });
    const staging = join(root, `.${id}.installing`);
    const old = join(root, `.${id}.old`);
    /**
     * 上次失败可能留下 `.<id>.old`：目标目录不在时**先恢复**，别把存着原扩展
     * 的目录当垃圾清掉。恢复不了就拒绝这次安装，留着给人手动处理。
     */
    if (exists(old)) {
      if (!exists(dest)) {
        try {
          fs.renameSync(old, dest);
          // 恢复出来的目录可能是用户手写的：foreign 检查要再做一次，
          // 不能因为「它是从 .old 恢复的」就绕过保护。
          if (isForeign(id)) {
            return { ok: false, reason: '残留恢复出的目录是用户手写的，拒绝覆盖（foreign 保护）' };
          }
        } catch {
          return { ok: false, reason: '上次安装残留的备份目录无法自动恢复，已保留供人工处理' };
        }
      } else {
        rmrf(old);
      }
    }
    rmrf(staging);

    let keepOld = false;
    try {
      fs.cpSync(from, staging, { recursive: true });
      // 落位后按目标目录名再校验一次，防「目录名与清单 id 不一致」混进来
      const again = validateManifest(readJson(join(staging, MANIFEST_FILE)), { expectedId: id });
      if (!again.ok) throw new Error(again.errors.join('；'));
      if (source) fs.writeFileSync(join(staging, SOURCE_FILE), JSON.stringify(source, null, 2) + '\n', 'utf8');

      const hadDest = exists(dest);
      if (hadDest) {
        /**
         * 更新时保住**用户设置**：`config.json` 不是扩展的发布物，是主人在面板里
         * 填的值。整个目录被 rename 成 `.old` 再删掉，不抢救就等于「更新一次，
         * 设置全丢」。密钥在 `secrets/` 外部，不受影响。
         */
        try {
          const prevCfg = join(dest, 'config.json');
          if (fs.existsSync(prevCfg)) fs.copyFileSync(prevCfg, join(staging, 'config.json'));
        } catch (e) {
          log.warn?.(`扩展 ${id} 的旧设置没能带到新版本（${e?.message ?? e}），更新后需要重填`);
        }
        fs.renameSync(dest, old);
      }
      try {
        fs.renameSync(staging, dest);
      } catch (e) {
        if (hadDest && !exists(dest)) {
          try {
            fs.renameSync(old, dest);
          } catch {
            // 双重 IO 故障：原扩展此刻只存在于 `.old`，绝不能删。
            keepOld = true;
          }
        }
        throw e;
      }
      rmrf(old);
      // 直接用二次校验过的清单填 cache，别再读一次目标文件：落位刚 rename 完，
      // 若此刻读盘恰好失败，会出现「install 成功但 usage 为空」的窗口。
      usageCache.set(id, usageFromManifest(v.manifest));
      // 方案 L：安装即发一扩展一令牌。令牌生成失败不把「已落位」说成安装失败，
      // 否则面板会以为目录还在回滚、实际却已装好；只记 warn，由 G3 的 401 暴露。
      let tokenIssued = false;
      if (secrets && clientStore) {
        // scope 来自清单声明；没写就是默认的两件（写自己记忆 + 读状态）。
        try { secrets.issue(id, clientStore, { scopes: v.manifest.scopes }); tokenIssued = true; }
        catch (e) { log.warn?.(`扩展 ${id} 令牌生成失败：${e?.message ?? e}`); }
      }
      return { ok: true, id, manifest: v.manifest, dir: dest, foreign: !source, tokenIssued };
    } catch (e) {
      rmrf(staging);
      if (!keepOld) rmrf(old);
      return { ok: false, reason: `落位失败，已回滚：${e?.message || e}` };
    }
  }

  /** 卸载：用户手写目录面板不能卸（§8.3），只有市场装的可卸。 */
  function remove(id) {
    if (!EXT_ID_RE.test(id)) return { ok: false, reason: 'id 不合法' };
    const dest = pathOf(id);
    if (!exists(dest)) return { ok: false, reason: `扩展 ${id} 不存在` };
    if (isForeign(id)) return { ok: false, reason: `目录 ${id} 是用户手写的扩展，拒绝卸载` };
    rmrf(dest);
    /**
     * 删完要**回读确认**：扩展进程的 cwd 就在这个目录里，Windows 上句柄没退
     * 干净时会「内容删光、目录留着」。**不能提前 return** —— 令牌吊销和密钥清理
     * 必须照做（扩展已经没了，旧令牌绝不能还能验），所以只记个标记，最后一起报。
     */
    const leftoverDir = exists(dest);
    usageCache.delete(id);
    /**
     * 配置里的密钥存在**扩展目录之外**（`secrets/<id>.config.json`），
     * `rmrf(dest)` 删不到它。不清就等于「卸载了扩展，密钥还躺在盘上」。
     * 非敏感值在扩展目录里，随目录一起删。
     */
    try { fs.rmSync(join(secretsDir(dir), `${id}.config.json`), { force: true }); }
    catch (e) { log.warn?.(`扩展 ${id} 的配置密钥清理失败：${e?.message ?? e}`); }
    // 删 api.clients 记录 + secrets 文件 = 吊销。删记录失败必须报出来，
    // 否则「扩展已卸载、旧令牌却还能 verify」是静默的权限残留。
    if (secrets) {
      try { secrets.revoke(id, clientStore); }
      catch (e) { log.warn?.(`扩展 ${id} 令牌吊销失败：${e?.message ?? e}`); }
      // secrets 文件删了但客户端记录没删 = 旧令牌还能 verify，必须报出来。
      if (!clientStore) log.warn?.(`扩展 ${id} 缺 clientStore，api.clients 记录未删除`);
    }
    return leftoverDir
      ? {
        ok: true,
        id,
        partial: true,
        message: `扩展 ${id} 的文件已删除，但目录还在（扩展进程可能仍在运行）。重启 DSH 后会清掉；在此之前它不会出现在已装列表里。`,
      }
      : { ok: true, id };
  }

  return {
    dir, root, list, problems, read, sourceOf, isForeign, install, remove, pathOf,
    liveUsage, refreshUsage, configSpecOf,
  };
}

// ---------------------------------------------------------------------------
// 方案 L 的令牌链路（实施阶段 3.2，§5.4 / §9-#30）
//
// 存储分两处，绝不混在一起：
//   · `<dataDir>/api-clients.json` —— 宿主只存 sha256 hash + scope + extId，可进 E4 包；
//   · `<dataDir>/secrets/<id>.json` —— 明文 0600，`backup.js` 的 SKIP 已排除，不进 E4 包。
// 令牌不落 cordis.patch.yml、不进 process.env、不回显给任何接口。
// ---------------------------------------------------------------------------

export const CLIENTS_FILE = 'api-clients.json';
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** 客户端记录存储。每次 verify 都重读文件 —— 吊销 / 轮换立刻生效，无缓存 stale。 */
export function createClientStore({ dir = dataDir(), log = () => {} } = {}) {
  const file = join(dir, CLIENTS_FILE);

  function readAll() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(raw?.clients) ? raw.clients : [];
    } catch {
      return [];
    }
  }

  function writeAll(clients) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${CLIENTS_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify({ clients }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  return {
    file,
    list: readAll,
    get: (id) => readAll().find((c) => c.id === id) ?? null,
    add(record) {
      if (!record?.id || !record?.hash) throw new Error('客户端记录缺 id / hash');
      const all = readAll().filter((c) => c.id !== record.id);
      all.push(record);
      writeAll(all);
      return record;
    },
    rotate(id, hash) {
      const all = readAll();
      const one = all.find((c) => c.id === id);
      if (!one) return null;
      one.hash = hash;
      writeAll(all);
      return one;
    },
    revoke(id) {
      const all = readAll();
      const next = all.filter((c) => c.id !== id);
      if (next.length === all.length) return false;
      writeAll(next);
      return true;
    },
    verify(token) {
      if (typeof token !== 'string' || !token) return null;
      const hb = Buffer.from(sha256(token), 'utf8');
      for (const c of readAll()) {
        if (c.enabled === false) continue;
        const cb = Buffer.from(String(c.hash ?? ''), 'utf8');
        if (cb.length === hb.length && timingSafeEqual(cb, hb)) return c;
      }
      log.warn?.('ext.auth_failed：令牌未在 api.clients 命中');
      return null;
    },
  };
}

/** 私有 secrets 与「一扩展一令牌」的生成 / 轮换 / 吊销 / 备份还原重建。 */
export function createExtSecrets({ dir = dataDir(), log = () => {} } = {}) {
  const root = secretsDir(dir);
  const fileOf = (id) => join(root, `${id}.json`);
  const readSecret = (id) => {
    try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
  };

  function writeSecret(id, token, ref) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = join(root, `.${id}.${randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify({ token, ref })}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, fileOf(id));
    // Windows 会忽略 mode，chmod 失败不算错误；POSIX 上确保 0600。
    try { fs.chmodSync(fileOf(id), 0o600); } catch { /* 平台差异 */ }
  }

  function issue(id, store, { scopes } = {}) {
    if (!EXT_ID_RE.test(id)) throw new Error(`扩展 id 不合法：${id}`);
    const token = randomBytes(32).toString('base64url');
    const ref = credentialRef(id);
    writeSecret(id, token, ref);
    const client = {
      id: `ext:${id}`, name: `扩展 ${id}`, hash: sha256(token),
      scopes: normalizeScopes(scopes), extId: id, enabled: true, createdAt: Date.now(),
    };
    store?.add(client);
    return { token, ref, hash: client.hash, client };
  }

  return {
    root,
    fileOf,
    read: readSecret,
    issue,
    rotate(id, store, opts = {}) {
      /**
       * 轮换必须**保持原 scope**：从 api.clients 现有记录读，读不到才用清单/默认。
       * 否则一次轮换会把主人刚授的 `say:write` 悄悄收回去，扩展突然 403。
       */
      const cur = store?.get?.(`ext:${id}`)?.scopes;
      const r = issue(id, null, { scopes: Array.isArray(cur) && cur.length ? cur : opts.scopes });
      store?.rotate(`ext:${id}`, r.hash);
      return r;
    },
    revoke(id, store) {
      try { fs.rmSync(fileOf(id), { force: true }); } catch { /* 已删 */ }
      return store?.revoke(`ext:${id}`) ?? true;
    },
    /**
     * E4 备份包不含 secrets/，还原后文件必然缺失：此时**重新生成**令牌并更新
     * hash（旧 hash 不可逆），面板据此提示「扩展令牌已重新生成」（§5.4 第 5 条）。
     */
    ensure(id, store) {
      if (readSecret(id)?.token) return { regenerated: false };
      log.warn?.(`扩展 ${id} 的 secrets 缺失，已重新生成令牌`);
      /**
       * 重建时**沿用 api.clients 里现有的 scope**：备份还原只丢了 secrets，
       * 授权记录还在。若在这里回退到默认，主人当初授的 `say:write` 会被
       * 静默收回，扩展恢复后突然 403，而面板只会说「令牌已重新生成」。
       */
      const cur = store?.get?.(`ext:${id}`)?.scopes;
      return { regenerated: true, ...issue(id, store, { scopes: cur }) };
    },
  };
}
