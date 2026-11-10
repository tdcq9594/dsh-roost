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
import { basename, join, resolve } from 'node:path';

import { dataDir } from './config.js';

/** 与方案 §3.1 一致：小写开头、2–32 字符、只含小写字母数字与短横线。 */
export const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const EXT_KIND = 'dsh-extension';
export const SOURCE_FILE = '.source.json';
export const MANIFEST_FILE = 'plugin.json';

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
  if (m.mounts !== undefined && (!Array.isArray(m.mounts) || m.mounts.some((x) => typeof x !== 'string'))) {
    errors.push('mounts 必须是字符串数组');
  }
  if (m.memory !== undefined && (typeof m.memory !== 'object' || m.memory === null || Array.isArray(m.memory))) {
    errors.push('memory 必须是对象');
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

function rmrf(p) {
  if (exists(p)) fs.rmSync(p, { recursive: true, force: true });
}

export function createExtRegistry({ dir = dataDir(), log = () => {} } = {}) {
  const root = extensionsDir(dir);

  const pathOf = (id) => join(root, id);
  const sourcePathOf = (id) => join(pathOf(id), SOURCE_FILE);

  /** 有 `.source.json` = 市场装的；没有但目录在 = 用户手写（只读，绝不覆盖）。 */
  function sourceOf(id) {
    return readJson(sourcePathOf(id));
  }

  function isForeign(id) {
    return exists(pathOf(id)) && !exists(sourcePathOf(id));
  }

  function read(id) {
    if (!EXT_ID_RE.test(id)) return null;
    const v = validateManifest(readJson(join(pathOf(id), MANIFEST_FILE)), { expectedId: id });
    return v.ok ? v.manifest : null;
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
      out.push({ id: ent.name, manifest: v.manifest, dir: join(root, ent.name), source: sourceOf(ent.name), foreign: isForeign(ent.name) });
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
      if (hadDest) fs.renameSync(dest, old);
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
      return { ok: true, id, manifest: v.manifest, dir: dest, foreign: !source };
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
    return { ok: true, id };
  }

  return { dir, root, list, read, sourceOf, isForeign, install, remove, pathOf };
}
