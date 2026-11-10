/**
 * 方案 L 的令牌注入器（实施阶段 3.2，§3.2 / §5.4 / §9-#30 / §10.9）。
 *
 * DSH 的 `dsh-mcp-client` 按受管块 spawn `node <roost>/src/ext-launcher.mjs`；
 * 本进程读私有 secrets 与扩展清单，再 spawn **真正的 MCP server**，把令牌
 * 注入子进程 env。MCP 的 stdio 用 `inherit` 原样透传，退出码 / 信号也透传。
 *
 * 三条硬约束：
 *  1. 受管块里没有令牌明文、没有 `!!js`、没有 `${...}` —— 值完全不经 DSH 配置层；
 *  2. 扩展进程 env **只有**三个业务变量（TOKEN / URL / EXT_ID）+ 最小系统变量，
 *     拿不到 `dataDir` 全路径、`ROOST_LAUNCHER_DIR` 或任何私有文件路径；
 *  3. secrets 缺失时**注入空串**而不是崩：扩展调 `/v1` 得 401 → 记
 *     `ext.auth_failed` 审计 → 面板显示「扩展鉴权失败」，不静默失联。
 *
 * 轮换不需要重启 DSH：重建 MCP 连接会重新拉起本 launcher，自然读到新 secrets。
 * （§10.9 实测 `!!js` 在 HMR reload 时不重新求值，这是选 L 的关键原因。）
 *
 * 独立进程、零外部依赖；`planLaunch()` 是纯函数，单测不 spawn 任何进程。
 */

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 让 `node` / python 之类能启动的最小系统环境；不复制任何含 TOKEN/SECRET 的父变量。
 * 刻意**不带** HOME / USERPROFILE / TEMP / TMP：扩展用它们能拼出
 * `~/.dsh/dsh-roost/secrets/<id>.json`，那就等于把私有目录位置又递回去了。
 * 真需要临时目录的扩展请用自己的 cwd（§5.4「私有文件路径一律不传」）。
 */
const SYSTEM_ENV_KEYS = [
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL',
];

const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 纯规划：算出要 spawn 的命令与子进程 env，不产生副作用。
 * `env` / `readJson` 可注入，便于测试各种缺值 / 越界输入。
 */
export function planLaunch({ env = process.env, readJsonFn = readJson } = {}) {
  const id = String(env.ROOST_EXT_ID ?? '');
  const launcherDir = String(env.ROOST_LAUNCHER_DIR ?? '');
  const apiUrl = String(env.ROOST_API_URL ?? '');
  if (!EXT_ID_RE.test(id)) throw new Error(`ROOST_EXT_ID 不合法：${id || '(空)'}`);
  if (!launcherDir) throw new Error('缺 ROOST_LAUNCHER_DIR，无法定位 secrets 与扩展清单');

  const extDir = join(launcherDir, 'extensions', id);
  const manifest = readJsonFn(join(extDir, 'plugin.json'));
  if (!manifest) throw new Error(`扩展 ${id} 的 plugin.json 读不到`);
  if (manifest.transport !== 'stdio') {
    throw new Error(`扩展 ${id} 是 ${manifest.transport}，streamable-http 不由宿主注入（§13）`);
  }
  if (typeof manifest.command !== 'string' || !manifest.command.trim()) {
    throw new Error(`扩展 ${id} 缺 command`);
  }
  const args = Array.isArray(manifest.args) ? manifest.args.filter((a) => typeof a === 'string') : [];
  const rawCwd = typeof manifest.cwd === 'string' && manifest.cwd ? manifest.cwd : extDir;
  const cwd = isAbsolute(rawCwd) ? rawCwd : resolve(extDir, rawCwd);

  // 缺 secrets 不抛：注入空串让 /v1 明确回 401，而不是连接层静默失败。
  const secret = readJsonFn(join(launcherDir, 'secrets', `${id}.json`));
  const token = typeof secret?.token === 'string' ? secret.token : '';

  const childEnv = {};
  for (const k of SYSTEM_ENV_KEYS) {
    if (typeof env[k] === 'string') childEnv[k] = env[k];
  }
  childEnv.ROOST_API_TOKEN = token;
  childEnv.ROOST_API_URL = apiUrl;
  childEnv.ROOST_EXT_ID = id;

  return {
    id, extDir, command: manifest.command, args, cwd, childEnv,
    apiUrl, token, missingSecret: !token,
  };
}

export function main() {
  let plan;
  try {
    plan = planLaunch();
  } catch (e) {
    // 只写原因，绝不打印 token / secrets 路径内容。
    console.error(`[ext-launcher] 启动失败：${e?.message ?? e}`);
    process.exit(1);
  }
  if (plan.missingSecret) {
    console.error(`[ext-launcher] 扩展 ${plan.id} 的令牌缺失，注入空串；调用 /v1 将返回 401`);
  }

  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.childEnv,
    stdio: 'inherit',
  });
  child.on('error', (e) => {
    console.error(`[ext-launcher] 无法启动扩展 ${plan.id}：${e?.message ?? e}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); } catch { process.exit(1); }
    } else {
      process.exit(code ?? 0);
    }
  });
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();
