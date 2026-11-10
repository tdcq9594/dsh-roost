/**
 * `cordis.patch.yml` 受管块同步（方案 §3.2 / 实施阶段 1.2）。
 *
 * 方案 L 定稿：受管块里**零令牌明文、零 `!!js`、零 YAML tag**。
 * `command` 一律指向宿主自带的 `src/ext-launcher.mjs`，真 server 的命令与
 * 参数由 launcher 从扩展清单读；`env` 只允许三个引用名 / 宿主参数。
 * `secrets/` 注入与令牌轮换属 3.2，本文件不碰。
 *
 * 保守开关：默认只 `render()` 出片段交给用户「一键复制」；只有显式
 * `apply: true` 才写宿主 profile 文件。最坏情况应止于手动。
 *
 * 零依赖说明：本仓没有 YAML 解析器，`assertManagedShape()` 只校验**本模板
 * 生成的固定形状**（缩进、必需键、白名单 env 键、无标签 / 无模板插值），
 * 不是通用 YAML 解析。扩展仓的内容永远不进这个模板，所以这个子集够用。
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataDir, loadConfig } from './config.js';
import { findProfileDir } from './update.js';
import { redactText } from './redact.js';

export const BLOCK_BEGIN = '# >>> dsh-roost managed extensions (do not edit) >>>';
export const BLOCK_END = '# <<< dsh-roost managed extensions <<<';

export const ALLOWED_ENV_KEYS = ['ROOST_API_URL', 'ROOST_EXT_ID', 'ROOST_LAUNCHER_DIR'];
export const MCP_CLIENT_PKG = '@deepseek-ai/dsh-mcp-client';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const ROOST_DIR = dirname(SRC_DIR);

export function launcherPath() {
  return join(SRC_DIR, 'ext-launcher.mjs');
}

/** YAML 单引号标量：单引号双写，换行不允许（路径里出现换行本身就是异常）。 */
function q(v) {
  const s = String(v);
  if (/[\r\n]/.test(s)) throw new Error('值里不许有换行');
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 生成一条 MCP 条目。只吃宿主侧的 id 与路径，扩展清单里的 `command` / `args`
 * **一概不读** —— 扩展仓永远不能指定被 spawn 的可执行文件。
 */
export function renderEntry(id, { apiUrl, dir, roostDir = ROOST_DIR } = {}) {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(id)) throw new Error(`扩展 id 不合法：${id}`);
  // 路径统一正斜杠：Windows 的 fs / Node 都认，且与方案 §3.2 的
  // `<roost>/src/ext-launcher.mjs` 写法一致，避免 YAML 里出现反斜杠歧义。
  const norm = (p) => String(p).replace(/\\/g, '/');
  const launcher = norm(join(roostDir, 'src', 'ext-launcher.mjs'));
  const lines = [
    `    - id: mcp-${id}`,
    `      name: '${MCP_CLIENT_PKG}'`,
    `      config:`,
    `        serverName: ${id}`,
    `        transport: stdio`,
    `        command: node`,
    `        args: [${q(launcher)}]`,
    `        env:`,
    `          ROOST_API_URL: ${q(apiUrl)}`,
    `          ROOST_EXT_ID: ${q(id)}`,
    `          ROOST_LAUNCHER_DIR: ${q(norm(dir))}`,
    `        failOnStartupError: false`,
  ];
  return lines.join('\n');
}

export function renderBlock(ids, opts = {}) {
  const body = ids.length
    ? ['- insert:', ...ids.map((id) => renderEntry(id, opts))].join('\n')
    : '# (暂无已装扩展)';
  return `${BLOCK_BEGIN}\n${body}\n${BLOCK_END}`;
}

/** 拒绝任何表达式 / 标签 / 模板插值；这是方案 L 的硬约束。 */
export function rejectExpressions(text) {
  const hits = [];
  // 双感叹号（!!js）与单感叹号本地 tag（command: !js ...）都要挡。
  if (/!![A-Za-z]/.test(text) || /:\s+![A-Za-z!]/.test(text)) hits.push('YAML tag / !!js 表达式');
  if (/\$\{/.test(text)) hits.push('${...} 模板插值');
  if (/\t/.test(text)) hits.push('tab 缩进（YAML 不允许）');
  return hits;
}

/**
 * 轻量结构校验：每条受管条目必须有 id / name / config 四件套，
 * `env` 下只允许三个白名单键。返回解析出的 id 列表，供幂等比对。
 */
export function assertManagedShape(block) {
  const problems = rejectExpressions(block);
  const lines = block.split(/\r?\n/).filter((l) => !l.startsWith('#'));
  const ids = [];
  let cur = null;
  let inEnv = false;
  let sawInsert = false;

  for (const line of lines) {
    if (line.trim() === '- insert:') { sawInsert = true; continue; }
    const m = line.match(/^    - id: mcp-([a-z][a-z0-9-]{1,31})$/);
    if (m) {
      cur = { id: m[1], keys: new Set() };
      ids.push(cur);
      inEnv = false;
      continue;
    }
    if (!cur) continue;
    const kv = line.match(/^      (\w+):/);
    const cfg = line.match(/^        (\w+):/);
    // 键名放宽到「任意合法 YAML 标识符」，再统一交给白名单判；
    // 只认 [A-Z_] 的话 `token:` / `bad-key:` 会悄悄漏过去。
    const env = line.match(/^          ([A-Za-z_][A-Za-z0-9_-]*):/);
    if (kv) cur.keys.add(`top:${kv[1]}`);
    if (cfg) { cur.keys.add(`cfg:${cfg[1]}`); inEnv = cfg[1] === 'env'; }
    if (env) {
      if (!inEnv) problems.push(`${cur.id}: env 缩进不对`);
      if (!ALLOWED_ENV_KEYS.includes(env[1])) problems.push(`${cur.id}: env 键 ${env[1]} 不在白名单`);
      cur.keys.add(`env:${env[1]}`);
    }
  }
  if (ids.length && !sawInsert) problems.push('缺 - insert:');
  for (const e of ids) {
    for (const k of ['top:name', 'cfg:serverName', 'cfg:transport', 'cfg:command', 'cfg:args', 'cfg:env', 'cfg:failOnStartupError']) {
      if (!e.keys.has(k)) problems.push(`mcp-${e.id}: 缺 ${k}`);
    }
    for (const k of ALLOWED_ENV_KEYS) if (!e.keys.has(`env:${k}`)) problems.push(`mcp-${e.id}: env 缺 ${k}`);
  }
  return { ok: problems.length === 0, problems, ids: ids.map((e) => e.id) };
}

/** 把受管块换掉，用户手写的条目一律保留。只有一个标记时拒绝猜。 */
export function mergeManaged(original, block) {
  const hasBegin = original.includes(BLOCK_BEGIN);
  const hasEnd = original.includes(BLOCK_END);
  const beginCount = original.split(BLOCK_BEGIN).length - 1;
  const endCount = original.split(BLOCK_END).length - 1;
  if (hasBegin !== hasEnd || beginCount !== endCount || beginCount > 1) {
    // 用户在手写注释里抄了完整标记时，indexOf 会落在注释处，
    // 直接替换可能删掉用户内容 —— 认不准就别改。
    throw new Error('受管块起止标记不成对或重复，拒绝改文件');
  }
  if (!hasBegin) {
    const sep = original.endsWith('\n') || !original ? '' : '\n';
    return `${original}${sep}\n${block}\n`;
  }
  const i = original.indexOf(BLOCK_BEGIN);
  const j = original.indexOf(BLOCK_END);
  if (j < i) throw new Error('受管块标记顺序颠倒，拒绝改文件');
  const head = original.slice(0, i);
  // 用户手改把 BEGIN 前面的换行删掉时，直接拼接会把注释粘在 YAML 值后面。
  const sep = head && !head.endsWith('\n') ? '\n' : '';
  return `${head}${sep}${block}${original.slice(j + BLOCK_END.length)}`;
}

export function createExtPatch({
  dir = dataDir(),
  profileDir = findProfileDir(SRC_DIR),
  apiUrl,
  port,
  /** 返回**当前实际监听端口**。运行期求值，不能在创建时算死。 */
  getPort = null,
  roostDir = ROOST_DIR,
  log = () => {},
} = {}) {
  const file = join(profileDir, 'cordis.patch.yml');
  // 端口不硬编码：与 ai-chat 的「DSH 地址」同源，取 config.json 的 server.port。
  const cfgPort = port ?? (() => { try { return loadConfig()?.server?.port; } catch { return undefined; } })();

  /**
   * **每次渲染时**才定 URL。
   *
   * `config.json` 里的端口只是「想要的值」；被占时 `createInboundServer()` 会
   * 顺着 `candidates()` 往后漂（`server.js` 的 `EADDRINUSE` 分支），真正在听的是
   * `server.actualPort`。创建时算死就会把旧端口写进受管块，扩展连过去得到
   * **connection refused**（不是 401）—— 连接层就断了，`ext.auth_failed` 不会记、
   * 面板两个凭据状态都不会亮，表现是「装好了但一点反应都没有」。
   *
   * 优先级：显式 `apiUrl` > 运行期 `getPort()` > 配置端口 > 17321。
   */
  const resolveApiUrl = () => {
    if (apiUrl) return apiUrl;
    let p = cfgPort;
    try {
      const live = getPort?.();
      if (live) p = live;
    } catch { /* 取不到就退回配置值，不因此让安装失败 */ }
    return `http://127.0.0.1:${p || 17321}/v1`;
  };
  const opts = { dir, roostDir };

  /** 默认不写盘：`render()` 返回片段，面板给「一键复制」。 */
  function render(ids, { apply = false } = {}) {
    const block = renderBlock(ids, { ...opts, apiUrl: resolveApiUrl() });
    const shape = assertManagedShape(block);
    if (!shape.ok) throw new Error(`受管块结构校验失败：${shape.problems.join('；')}`);

    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    // 先做可能抛错的合并，再落备份：失败时不留半截备份文件。
    const next = mergeManaged(original, block);
    const result = { path: file, block, text: next, changed: next !== original, ids: shape.ids };
    if (!apply || !result.changed) return { ...result, written: false };

    // 备份：脱敏后落盘仅供人工查阅；程序回滚用内存里的原文，保证逐字节还原。
    const bak = `${file}.roost-bak-${Date.now()}`;
    fs.writeFileSync(bak, redactText(original), 'utf8');
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      const written = fs.readFileSync(tmp, 'utf8');
      const begin = written.indexOf(BLOCK_BEGIN);
      const end = written.indexOf(BLOCK_END);
      if (begin < 0 || end < begin) throw new Error('写后受管块标记丢失');
      const check = assertManagedShape(written.slice(begin, end + BLOCK_END.length));
      if (!check.ok) throw new Error(`写后校验失败：${check.problems.join('；')}`);
      fs.renameSync(tmp, file);
      return { ...result, written: true, backup: bak };
    } catch (e) {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
      if (original) fs.writeFileSync(file, original, 'utf8');
      else if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      log.warn?.(`受管块写入失败，已回滚：${e?.message || e}`);
      throw e;
    }
  }

  return { file, render };
}
