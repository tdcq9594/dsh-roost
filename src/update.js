/**
 * 本体自更新（dsh-roost 更新自己）。
 *
 * 核心结论：**不自己调 pnpm、不自己改 node_modules**。
 * DSH 有一个 `pluginManager` 服务，`installBundle(spec, options)` 就是现成的
 * 安全自更新原语——失败/取消时它会**把 `package.json` 和 `pnpm-lock.yaml`
 * 恢复原样**，还带 `requestId` 可取消、`waitForInstall` 可恢复。
 * 自更新最容易出事的地方就是"改到一半坏了怎么回滚"，这块已经有人做完了。
 *
 * `pluginManager` **不写进 `inject`**：老版本 DSH 没这个服务，写进 inject 会让
 * 插件直接激活失败。用 `ctx.get()` 拿，拿不到就降级成"只显示当前版本"。
 *
 * 另外要挡住一个坑：开发时 `node_modules/dsh-roost` 是指向源码目录的**符号链接**。
 * 这时候跑 installBundle，pnpm 会把链接换成真实目录 —— 开发链路直接断掉。
 * 所以第一步永远是判断"我是怎么装的"。
 */

import { readFileSync, writeFileSync, existsSync, renameSync, lstatSync } from 'node:fs';
import { join, dirname, win32 as wpath, posix as ppath } from 'node:path';
import { homedir } from 'node:os';
import { compareVersion } from './version.js';

export { compareVersion };

/** 只更新这一个包。面板不接受任意包名，否则这里就成了"任意装包"的洞 */
export const PKG = 'dsh-roost';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * 24 小时冷却：pnpm 10.16+ 的 `minimumReleaseAge` 默认 1440 分钟。
 * 刚发的版本别人装不上，pnpm 会**降级**装一个满 24 小时的旧版（不报错）。
 * 这个常量只用来算"还差多久"和判断要不要提示。
 */
const MIN_AGE_MS = 24 * 3600_000;

/**
 * 检查更新的缓存时长。
 *
 * 概览页顶部会挂一条「有新版本」的横幅，也就是**每次进首页都会问一次**。
 * 不缓存的话，每次切回概览都要打一次 registry（8 秒超时），国内直连
 * 直接把首页拖慢——用户看到的不是「有新版」，是「面板卡了」。
 *
 * 6 小时是抄 aurabot 的取值：发版是低频动作，半天延迟完全够用；
 * 手动点「重新检查」会带 `force` 绕过缓存。
 */
const REMOTE_TTL_MS = 6 * 3600_000;

/** PATH 里找 `dsh`。找到返回完整路径，找不到返回空串 */
function findDshOnPath({ platform, exists, env }) {
  const P = platform === 'win32' ? wpath : ppath;
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh'];
  // Windows 上这个键有时叫 PATH、有时叫 Path，两个都认
  const dirs = String(env.PATH || env.Path || '').split(sep).map((d) => d.trim()).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = P.join(d, n);
      if (exists(p)) return p;
    }
  }
  return '';
}

/**
 * 找 DSH 的 CLI（Windows 上是 `dsh.cmd`）。
 *
 * **不能写死 `%LOCALAPPDATA%\Programs\DeepSeek Harness\...`**：
 * 用户可以把 DSH 装在 D 盘、装在 Program Files、或用便携版，
 * 写死的路径复制过去就是一条跑不起来的命令。
 *
 * 按可靠性排序：
 *   ① PATH 里有 dsh —— 最干净，命令直接写 `dsh`，换机器也能用
 *   ② Electron 的 `process.resourcesPath` —— **任意安装盘符都指得对**
 *   ③ LOCALAPPDATA / ProgramFiles 的默认位置 —— 标准安装器
 * 都没有就返回空：调用方退回 `dsh`，至少不写死一条错路径。
 */
function findDshCmd({ exists, env, resourcesPath }) {
  const onPath = findDshOnPath({ platform: 'win32', exists, env });
  if (onPath) return { onPath: true, path: onPath, via: 'path' };
  const cands = [];
  if (resourcesPath) {
    cands.push({ p: wpath.join(resourcesPath, 'runtime', 'cli', 'bin', 'dsh.cmd'), via: 'resources' });
  }
  if (env.LOCALAPPDATA) {
    cands.push({
      p: wpath.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      via: 'localappdata',
    });
  }
  if (env.ProgramFiles) {
    cands.push({
      p: wpath.join(env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
      via: 'programfiles',
    });
  }
  for (const c of cands) if (exists(c.p)) return { onPath: false, path: c.p, via: c.via };
  return { onPath: false, path: '', via: 'fallback' };
}

/**
 * 把绝对路径换成 PowerShell 的环境变量写法。
 *
 * `"C:\Users\alice\AppData\Local\Programs\..."` 复制给另一个用户就废了；
 * `"$env:LOCALAPPDATA\Programs\..."` 在谁机器上都能展开。
 * 只对已知的环境变量根做替换，别的盘符（`D:\Apps\...`）原样保留——
 * 那是用户自己的选择，没有可移植的写法。
 */
function portablePath(p, env) {
  for (const name of ['LOCALAPPDATA', 'ProgramFiles', 'ProgramW6432']) {
    const dir = env[name];
    if (!dir) continue;
    if (p.toLowerCase().startsWith(dir.toLowerCase())) {
      return `"$env:${name}${p.slice(dir.length)}"`;
    }
  }
  return `"${p}"`;
}

/**
 * 手动更新的命令（一键自更新走不通时的兜底出口）。
 *
 * 以前这三种情况只能甩一句「去 DSH 插件管理里手动更新」：
 *   · 开发模式（符号链接）——自更新会把源码链路搞断，必须挡住
 *   · 老 DSH 没有 pluginManager
 *   · DSH 以 `already-installed` 拒绝重装同一个包
 * 用户拿到那句话根本不知道要跑什么。给一条能直接粘进终端的命令才是可行动的。
 *
 * `dsh plugin` 的实际行为是**把参数原样转发给 pnpm**（`dsh plugin --help`
 * 原文：forwarding the remaining arguments to pnpm in the profile directory），
 * 所以这条命令等价于在 profile 目录里 `pnpm add dsh-roost@<版本>`——
 * **pnpm 改版本是直接替换，不需要先卸载**。`already-installed` 是 DSH
 * 面板 API 自己的限制（热更新模式下拒绝重装同一个包），命令行正好绕过它。
 *
 * **profile 名从 profileDir 推导**（`~/.dsh/profiles/desktop` → `desktop`），
 * 不写死。aurabot 硬编码 `--profile desktop`，用 web / headless profile
 * 的人粘过去会装到另一个 profile 里，装完发现「怎么没生效」。
 *
 * **`link:` 装法（开发机）一律不给命令。** 那种情况下 `pnpm add` 会把
 * `"dsh-roost": "link:…"` 换成真实版本，符号链接当场变目录，之后改源码
 * 不再生效——给这条命令等于递刀。开发机的更新方式是 `git pull` 后重启。
 */
export function updateCommand({
  profileDir, version = '', platform = process.platform, exists = existsSync,
  linked = false, env = process.env, resourcesPath = process.resourcesPath,
  registry = '',
} = {}) {
  const P = platform === 'win32' ? wpath : ppath;
  const profile = P.basename(String(profileDir || '')) || 'desktop';
  const spec = version ? `${PKG}@${version}` : PKG;
  /**
   * `--registry=` 只在「这个版本不在用户配的源上」时加（镜像滞后）。
   *
   * DSH 的 CLI 自己就解析这个参数（`args.filter(a => a.startsWith('--registry='))`），
   * 所以对 `plugin add` 一样有效。平时不加：命令越短越容易复制粘贴，
   * 而且跟着用户自己的源走本来就是默认行为。
   */
  const regArg = registry ? ` --registry=${registry}` : '';
  if (linked) return { command: '', shell: '', profile, spec, linked: true, via: 'linked' };

  if (platform !== 'win32') {
    const onPath = findDshOnPath({ platform, exists, env });
    return {
      command: `${onPath || 'dsh'} plugin --profile ${profile} add ${spec}${regArg}`,
      shell: '终端',
      profile,
      spec,
      linked: false,
      via: onPath ? 'path' : 'fallback',
    };
  }

  const cli = findDshCmd({ exists, env, resourcesPath });
  return {
    // PATH 里有 dsh 就直接写命令名：最短、也最容易复制到别的机器
    command: cli.onPath
      ? `dsh plugin --profile ${profile} add ${spec}${regArg}`
      : `& ${cli.path ? portablePath(cli.path, env) : '"dsh.cmd"'} plugin --profile ${profile} add ${spec}${regArg}`,
    shell: 'PowerShell',
    profile,
    spec,
    linked: false,
    via: cli.via,
  };
}

/**
 * `RELEASE_NOTES.md` 里某个版本那一段（`## v1.1.5：…` 到下一个 `## `）。
 *
 * 用来在「刚更新完」时告诉用户这次改了什么——不然重启完只看到版本号变了，
 * 还得自己去仓库翻。找不到这一段就返回空串（不编内容）。
 */
/**
 * 把 markdown 剥成纯文本。
 *
 * 面板「这次改了什么」是**纯文本渲染**（插件前端零依赖，没有 markdown 解析器），
 * 直接把原文塞过去，屏幕上会出现 `**只改测试**`、`` `pickTitle` `` 和裸的 ``` 围栏——
 * 比不显示还难读（2026-11-17 主人反馈）。
 *
 * 只做「去标记、留内容」：代码块留主体、列表换成 ·、链接留文字。不做语法高亮，
 * 也不试图还原层级——面板那块地方就是一段说明，不是文档。
 */
/**
 * 列出 notes 里出现过的所有版本号（新的在前）。
 *
 * 面板要给一个「更新历史」的入口——**只看当前版本是不够的**：
 * 用户换机器、隔了几版才回来，或者想知道某个行为是哪版改的，都得往回翻。
 */
export function changelogVersions(text) {
  const out = [];
  const re = /^##\s+v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/gm;
  let m;
  const src = String(text ?? '');
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

export function markdownToPlain(text) {
  return String(text ?? '')
    // 代码围栏：去掉 ``` 那两行，留里面的代码
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => body)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]+\)/g, '$1')
    .replace(/^---+\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function changelogSection(text, version) {
  const v = String(version || '').replace(/^v/i, '');
  if (!v) return '';
  const lines = String(text || '').split(/\r?\n/);
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((l) => new RegExp(`^##\\s*v?${esc}(?![\\d.])`).test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

/**
 * DSH 的 `ChangeResult.application` 取值。
 *
 * **没有 `success`。** 真实的成功值是 `applied`；`restart-required`（装好了但要重启）
 * 和 `overridden`（被别的组合包接管）同样属于成功。
 * 以前这里拿 `'success'` 判，于是**每一次成功都被判成失败**——
 * 面板永远显示「更新失败，本地什么都没动」，而实际上文件已经换好了。
 */
const APP_OK = new Set(['applied', 'restart-required', 'overridden', 'success']);

/**
 * `result.error.code` → 人话。
 *
 * 这批键名来自 DSH `pluginManager` 的返回 schema（`@deepseek-ai/dsh-plugin-manager`），
 * **不是 `packageResult.code`**——那个字段不存在，读它永远拿到 undefined，
 * 于是所有失败都落到兜底文案，用户看不出任何可行动的信息。
 */
const FAIL_TEXT = {
  /**
   * DSH 的 `installBundle` 是「装新包」：同名包已存在就直接拒，**跟版本无关**
   * （`known.has(name)` → `<name> is already installed`）。
   * 升级得用 `updateBundle`，所以这条只在老 DSH 的兜底路径上出现——
   * 文案不能再叫人「先卸载」，那对版本升级是错的（`pnpm add` 本来就是原地替换）。
   */
  'already-installed': '这个 DSH 版本的插件面板只能装新包、装不了升级，本地什么都没动。'
    + '用下面那行命令原地升到新版（不用先卸载），跑完重启 DSH。',
  'not-updatable': '这个包在 DSH 里不是「按包名存的 registry 依赖」（比如 git 装的），面板升级不了。'
    + '用下面那行命令。',
  'invalid-spec': '版本号不合法，可能是 registry 返回了脏数据。稍后重试，或去 DSH 插件管理里手动更新。',
  'incompatible-version': '这个版本要求更高版本的 DSH，当前装不了。先升级 DSH。',
  'management-required': '这个 DSH 没给插件管理权限。去 DSH 设置里打开后重试。',
  unaddressable: '包地址解析不出来（registry 或 spec 有问题）。',
  'unknown-plugin': '找不到这个插件（可能已下架）。',
  'ambiguous-install': '有多个同名来源，DSH 不确定装哪个。去 DSH 插件管理里手动指定。',
  'not-bundle': '这个包不是 DSH 插件包（没有 bundle 声明）。',
  'not-removable': '这个包不能卸载（它承载着插件管理），所以装不了别的版本。',
  'stop-profile': 'DSH 正在停止或重启，等它起来再试。',
  'bundle-in-use': '这个包正在被使用，先停掉相关插件。',
  'stale-approval': '构建许可过期了，再点一次即可。',
  'operation-error': '安装过程报错，具体看下面的诊断。',
  /**
   * 我们给 `installBundle` 带了 `expected`：装到的版本不符会被 DSH 回滚。
   * 最常见的原因就是 pnpm 的 24 小时冷却把新版本挡回旧版（静默降级），
   * 所以文案要直接指向那颗「立即安装（不等 24 小时）」。
   */
  'unexpected-package': '装到的版本和预期不符，DSH 已经回滚（本地还是原来那版）。'
    + '多半是新版本发布不满 24 小时被 pnpm 挡回旧版——点「立即安装（不等 24 小时）」再试。',
  cancelled: '已取消，本地什么都没动。',
};

/** `installBundle` 的另一种返回：`{ status:'refused', problem, reason }` */
const REFUSE_TEXT = {
  network: '连不上 registry（或这个 spec 的下载主机）。检查网络、代理，或在设置里换个源。',
  'not-found': 'registry 上没有这个版本（可能刚发布还没同步）。过几分钟再试。',
  'not-a-package': '拉下来的东西不是 npm 包。',
  'not-a-bundle': '这个包不是 DSH 插件包（没有 bundle 声明）。',
  'invalid-spec': FAIL_TEXT['invalid-spec'],
  'already-installed': FAIL_TEXT['already-installed'],
  unknown: 'DSH 拒绝了这次安装，原因不明，见下面的诊断。',
};

/**
 * `packageResult.kind` → 人话。
 *
 * 这是**用户唯一能据此自查**的信息：断网、没权限、磁盘满，处理方式完全不同。
 */
const KIND_TEXT = {
  network: '网络问题（连不上 registry 或下载源）',
  timeout: '卡住超时（包管理器长时间没有输出）',
  integrity: '下载内容校验不通过（缓存坏了，或源被篡改）',
  'pnpm-missing': '找不到 pnpm',
  'not-found': 'registry 上没有这个版本',
  'no-matching-version': '没有匹配的版本（可能被 24 小时冷却挡住）',
  'disk-full': '磁盘空间不足',
  permission: '没有写权限（node_modules 或缓存目录）',
  'build-blocked': '安装脚本被拦（build 未批准）',
  unknown: '包管理器报错',
};

export function humanFail(code, extra = {}) {
  const { kind, failedAt, diagnostic } = extra;
  const base = FAIL_TEXT[code] || REFUSE_TEXT[code]
    || (code
      ? `更新失败（${code}），本地什么都没动。去 DSH 插件管理里手动更新试试。`
      : '更新失败，本地什么都没动。去 DSH 插件管理里手动更新试试。');

  const bits = [base];
  /**
   * 分类比错误码更接近"我该做什么"：`operation-error` 只能说明"报错了"，
   * 而 `kind: network` 能让人立刻想到代理。
   */
  if (kind && KIND_TEXT[kind] && !base.includes(KIND_TEXT[kind])) bits.push(`原因：${KIND_TEXT[kind]}。`);
  if (failedAt === 'registry') bits.push('（卡在 registry）');
  else if (failedAt === 'spec-host') bits.push('（卡在下载主机）');
  /** 诊断是 pnpm 原文，可能很长；toast 只放一句，完整内容走 detail */
  if (diagnostic && !code) bits.push(diagnostic.slice(0, 120));
  return bits.join(' ');
}

/** 「发布 30 分钟前」这种人话 */
export function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return '刚发布';
  if (m < 60) return `发布 ${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 48) return `发布 ${h} 小时前`;
  return `发布 ${Math.floor(h / 24)} 天前`;
}

/**
 * 把 `dsh-roost@<version>` 写进 `pnpm-workspace.yaml` 的豁免列表。
 *
 * **按行改，不解析重排。** 那个文件里有注释、有别的键，用 YAML 库
 * 读出来再写回去会丢注释、重排缩进——改一个我们自己包的豁免项，
 * 顺手把用户整个文件重写一遍，风险不对等。
 *
 * 规则：清掉旧的 `dsh-roost@…` 条目（不然越攒越长，本机已经堆了 17 个），
 * 只留最新那一条；**别的包的条目一个不动**。
 *
 * @returns {{text: string, changed: boolean, reason?: string}}
 */
export function patchExclude(text, pkg, version) {
  const entry = `${pkg}@${version}`;
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);

  let keyAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(lines[i])) { keyAt = i; break; }
  }

  // 没有这个键：整块追加到末尾
  if (keyAt < 0) {
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push('minimumReleaseAgeExclude:', `  - ${entry}`, '');
    return { text: out.join('\n'), changed: true };
  }

  /**
   * 收集这个键下面的列表项。
   *
   * 列表项 = `  - xxx`；遇到空行或非列表行就认为这一块结束。
   * 缩进用两空格——跟 pnpm 自己写出来的一致。
   */
  const items = [];
  let end = keyAt + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() === '') break;
    if (!/^\s*-\s/.test(l)) break;
    items.push({ at: end, value: l.replace(/^\s*-\s*/, '').trim() });
    end++;
  }

  const keep = items.filter((it) => !it.value.startsWith(`${pkg}@`) && it.value !== pkg);
  const out = [
    ...lines.slice(0, keyAt + 1),
    `  - ${entry}`,
    ...keep.map((it) => `  - ${it.value}`),
    ...lines.slice(end),
  ];
  const next = out.join('\n');
  return { text: next, changed: next !== src };
}

/**
 * 从当前文件位置往上找 DSH 的 profile 目录（`pnpm-workspace.yaml` 所在处）。
 *
 * 为什么不硬编码 `~/.dsh/profiles/desktop`：DSH 有多个 profile，
 * 用户也可能装到别的地方。往上找是唯一不猜的办法。
 * 找不到才退回默认路径（至少比什么都不做强）。
 */
export function findProfileDir(startDir) {
  let p = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(p, 'pnpm-workspace.yaml'))) return p;
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return join(homedir(), '.dsh', 'profiles', 'desktop');
}

/**
 * 判断自己是怎么装的。
 *
 * - `linked`  符号链接 / Windows junction（开发模式）→ **自更新必须禁用**
 * - `real`    真实目录（npm 装的）→ 可以更新
 * - `unknown` 找不到 → 不给更新按钮，只显示版本
 *
 * ⚠️ **不要先用 `existsSync()` 判存在**（2026-11-12 实测）：Windows 的 junction
 * 在某些环境里 `existsSync` 返回 false —— 它走 `stat`、会跟随链接，链接目标
 * 一旦被策略挡住就抛 UNKNOWN；而 `lstat` 明明看得见这个链接。先判 `existsSync`
 * 的后果是「明明是链接装法，却判成 unknown」，`linked` 这条防线等于没设。
 * 直接 `lstat`：拿得到就按 isSymbolicLink 分类，拿不到（ENOENT / 权限）才当未知。
 */
export function installKind(profileDir) {
  const p = join(profileDir, 'node_modules', PKG);
  try {
    return lstatSync(p).isSymbolicLink() ? 'linked' : 'real';
  } catch {
    return 'unknown';
  }
}

/**
 * @param {object} opts
 * @param {object} opts.ctx           DSH 的 ctx（用 `ctx.get('pluginManager')`）
 * @param {string} [opts.registry]    配置里的 registry，空就用 DSH 的 / 官方
 * @param {string} [opts.profileDir]  覆盖 profile 目录（测试用）
 * @param {Function} [opts.fetchImpl]
 * @param {(m:string)=>void} [opts.log]
 */
/**
 * 5.8 按通道挑版本（纯函数，导出给测试）。
 *
 * `beta` 没发布时回落 `latest`——否则开了测试通道却永远显示「已是最新」，
 * 用户会以为通道坏了。
 */
export function pickChannel({ latest = '', beta = '', publishedAt = 0, betaPublishedAt = 0, channel = 'latest' } = {}) {
  if (channel === 'beta' && beta) {
    return { version: beta, publishedAt: betaPublishedAt || publishedAt, channel: 'beta' };
  }
  return { version: latest, publishedAt, channel: 'latest' };
}

/**
 * 从 `pluginManager.listVersions()` 的返回里挑一个能装的目标版本（纯函数）。
 *
 * 为什么需要它：`check()` 走的是我们自己的 registry 拉取，8 秒超时、代理、镜像
 * 抽风都会失败；而 DSH 的 `listVersions` 用的是**它自己那套源计划**（跟
 * `updateBundle` 完全一致），我们拉不到时它往往还拉得到。拿到确切版本号，
 * 升级才能走 `updateBundle`——把 `@latest` 交给 `installBundle` 是注定失败的。
 *
 * 返回形状要认三种：remote 包装 `{ ok, value | error }`、`{ versions: [...] }`、
 * 直接一个版本数组。条目可能是字符串，也可能是带 `version` / `deprecated`
 * 的对象（DSH 文档：新版本在前，带 tags、弃用标记与兼容性）。
 * 弃用和不兼容的跳过——装上去比不装更糟。
 *
 * @param {unknown} list `listVersions()` 的返回
 * @returns {string} 目标版本号（`v` 前缀会去掉）；挑不出就返回空串
 */
export function pickUpdateTarget(list) {
  let v = list;
  if (v && typeof v === 'object' && typeof v.ok === 'boolean' && ('value' in v || 'error' in v)) {
    if (!v.ok) return '';
    v = v.value;
  }
  const items = Array.isArray(v?.versions) ? v.versions : (Array.isArray(v) ? v : []);
  for (const it of items) {
    const ver = String((typeof it === 'string' ? it : it?.version) || '').replace(/^v/i, '').trim();
    if (!ver) continue;
    if (it && typeof it === 'object') {
      if (it.deprecated) continue;
      if (it.compatible === false) continue;
    }
    return ver;
  }
  return '';
}

export function createUpdater({ ctx, registry, profileDir, fetchImpl = globalThis.fetch, log = () => {}, channelOf = null }) {
  const own = (() => {
    try {
      return JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();

  const profile = () => profileDir ?? findProfileDir(import.meta.dirname);
  const kind = () => installKind(profile());

  /** registry 的检查结果缓存（见 `remote()`）。null = 没查过 */
  let remoteCache = null;

  /**
   * 后台最近一次检查的结果。
   *
   * 概览页的横幅**只读这份快照**，自己不发起请求：否则「有没有新版本」
   * 就变成了「用户打不打开面板」，而且每次进首页都要打一次 registry。
   */
  let lastCheck = null;

  /**
   * 磁盘上**已经装着的**版本（≠ 正在运行的版本）。
   *
   * `own` 是模块加载时读的一次快照：装完新版不重启，它永远不会变。
   * 拿它判断"要不要装/还有没有新版"，会让按钮在更新成功后继续挂着，
   * 用户再点一次就撞上 `already-installed`。
   */
  function installedVersion() {
    try {
      const p = join(profile(), 'node_modules', PKG, 'package.json');
      return JSON.parse(readFileSync(p, 'utf8')).version || '';
    } catch {
      return '';
    }
  }

  const pm = () => {
    try {
      return ctx?.get?.('pluginManager') ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 向 DSH 要「比已装版本更新的版本列表」，取最新那个。
   *
   * `check()` 拉不到 registry 时（超时 / 代理 / 镜像抽风），这是唯一还能拿到
   * 确切版本号的路。拿到它，升级就能走 `updateBundle`；拿不到就只能给命令，
   * **绝不退化到 `installBundle`**——那条路按包名拒绝，见了就必然 already-installed。
   */
  async function latestFromManager({ registry = '' } = {}) {
    const m = pm();
    if (typeof m?.listVersions !== 'function') return '';
    try {
      return pickUpdateTarget(await m.listVersions(PKG, registry ? { registry } : undefined));
    } catch (e) {
      log(`listVersions 也没成：${e?.message ?? e}`);
      return '';
    }
  }

  /**
   * registry：配置 > DSH 自己的 registries() > 官方。
   *
   * **必须 await。** `pluginManager.registries()` 的签名是
   * `async registries(): Promise<PluginRegistries>`，返回值由 remote 层包成
   * `{ ok, value: { registry, fallbackRegistries, resolved } }`。
   * 以前这里当同步数组取（`Array.isArray(...)`），Promise 永远不是数组、
   * `r.registries` 也永远不存在——于是**不管用户配了什么镜像，都退回官方
   * registry.npmjs.org**，国内 8 秒超时几乎必挂。
   *
   * 形状在 DSH 几个版本间飘过（数组 / `{registries}` / `{ok,value}`），
   * 所以几种都认，认不出再用官方。
   */
  async function registryUrl() {
    if (registry) return String(registry).replace(/\/+$/, '');
    try {
      let r = await pm()?.registries?.();
      // remote 包装层：{ ok, value }
      if (r && typeof r === 'object' && 'ok' in r) {
        if (!r.ok) return DEFAULT_REGISTRY;
        r = r.value;
      }
      const pick = (v) => (typeof v === 'string' && v ? String(v).replace(/\/+$/, '') : '');
      if (typeof r === 'string') return pick(r) || DEFAULT_REGISTRY;
      if (Array.isArray(r)) {
        const first = r[0];
        const url = typeof first === 'string' ? first : first?.url || first?.registry;
        if (pick(url)) return pick(url);
        return DEFAULT_REGISTRY;
      }
      if (r && typeof r === 'object') {
        // PluginRegistries：{ registry, fallbackRegistries, resolved }
        const direct = pick(r.registry) || pick(r.registries?.[0]?.url) || pick(r.resolved);
        if (direct) return direct;
        const arr = Array.isArray(r.registries) ? r.registries
          : Array.isArray(r.fallbackRegistries) ? r.fallbackRegistries : [];
        const first = arr[0];
        const url = typeof first === 'string' ? first : first?.url || first?.registry;
        if (pick(url)) return pick(url);
      }
    } catch {}
    return DEFAULT_REGISTRY;
  }

  /**
   * 问**一个**源要版本信息。
   *
   * 拉**整份 packument**而不是 `/latest`：`/latest` 只给版本号，而我们要
   * 顺手读 `time` 算「发布多久了」——24 小时冷却期内点更新是白点，得提前说。
   * 只查一次，两个信息都拿到。
   *
   * 必须拉完整 packument（application/json）：简版元数据
   * （application/vnd.npm.install-v1+json）只有 name / dist-tags / versions /
   * modified，**不带 time**；取 `j.time[latest]` 永远是 undefined →
   * publishedAt=0 → age=NaN → cooling 恒 false，冷却警告和「立即安装」按钮
   * 都不渲染，24 小时豁免一次都没生效过。
   *
   * 完整 packument 更大：主源给 8 秒；失败时退回简版只拿 latest，
   * 发布时间标成「未知」（coolingUnknown），而不是假装不在冷却期。
   *
   * @param {string} reg
   * @param {{timeoutMs?: number, quiet?: boolean}} [opts] `quiet` = 备用源，失败不刷日志
   */
  async function probe(reg, { timeoutMs = 8000, quiet = false } = {}) {
    const url = `${reg}/${PKG}`;
    let latest = '';
    /** 5.8：测试版标签（dist-tag `beta`）；没发布时是空串，`check()` 会回落 latest */
    let beta = '';
    let publishedAt = 0;
    let betaPublishedAt = 0;
    let err = '';
    try {
      const getPackument = async (accept, ms) => {
        const res = await fetchImpl(url, {
          signal: AbortSignal.timeout(ms),
          headers: { accept },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      let j;
      try {
        j = await getPackument('application/json', timeoutMs);
      } catch (e) {
        if (!quiet) log(`完整 packument 拉取失败（${e.message}），退回简版元数据（拿不到发布时间）`);
        /**
         * 备用源只用来核对版本号：拿不到完整元数据就**直接放弃**，
         * 别为一个辅助结论再等一轮——它多等一秒，用户就多等一秒。
         */
        if (quiet) throw e;
        j = await getPackument('application/vnd.npm.install-v1+json', Math.min(4000, timeoutMs));
      }
      latest = String(j?.['dist-tags']?.latest ?? '');
      /**
       * 5.8 测试版通道：同一个包可以同时挂 `latest`（稳定）和 `beta`（测试）。
       * 两个都读，由 `channelOf()` 决定这次比哪个。
       */
      beta = String(j?.['dist-tags']?.beta ?? '');
      const t = j?.time?.[latest];
      publishedAt = t ? Date.parse(t) || 0 : 0;
      const tb = beta ? j?.time?.[beta] : '';
      betaPublishedAt = tb ? Date.parse(tb) || 0 : 0;
    } catch (e) {
      // 更新是低频操作，失败就如实说，不闷头重试——重试只会让人多等十几秒
      err = e.message;
      if (!quiet) log(`查最新版失败（${url}）：${e.message}`);
    }
    return { registry: reg, latest, beta, publishedAt, betaPublishedAt, error: err };
  }

  /**
   * 要问的源：**用户的源在前，官方源在后**（同一个就不重复问）。
   *
   * 只问用户配的源是不够的：镜像同步新版本有分钟级（偶尔更久）的延迟，
   * 这段时间里 `hasUpdate` 恒 false，面板一口咬定「已经是最新版」，
   * 用户点一百次都没用——而这根本不是用户的问题。
   * 现在两个源都问、按版本号取较新者：**版本判断不吃镜像的延迟**，
   * 装包仍然优先走用户的源（镜像没这版时才改走官方，见 `remote()`）。
   */
  async function probeRegistries() {
    const reg = await registryUrl();
    return reg === DEFAULT_REGISTRY ? [reg] : [reg, DEFAULT_REGISTRY];
  }

  /** 几个源里挑版本最高的那个，连它的发布时间一起带出来 */
  function bestOf(probes, field) {
    let best = null;
    for (const p of probes) {
      const v = p[field];
      if (!v) continue;
      if (!best || compareVersion(v, best.version) > 0) {
        best = { version: v, at: field === 'beta' ? p.betaPublishedAt : p.publishedAt };
      }
    }
    return best;
  }

  /**
   * 远端信息：各源上的最新版 + 发布时间，合并成一个结论。
   *
   * **只缓存成功拿到版本号的结果。** 把断网的 error 也缓存六小时，
   * 用户点「重新检查」就不会真的重查，只能干等缓存过期——那比慢更糟。
   * 缓存的键带**全部**源：用户换了源必须重查。
   */
  async function remote({ force = false } = {}) {
    const regs = await probeRegistries();
    const key = regs.join('|');
    if (!force && remoteCache && remoteCache.key === key
      && Date.now() - remoteCache.at < REMOTE_TTL_MS) {
      return { ...remoteCache.value, cached: true };
    }
    /**
     * 并发问，不排队。官方源只给 3 秒（完整 packument 一次拉不到就放弃，
     * 不再退简版）：国内直连常常超时，**它慢不能拖慢主源**——
     * 真正的结论由「谁的版本更新」决定，备用源只是核对。
     */
    const probes = await Promise.all(regs.map((r, i) => probe(r, {
      timeoutMs: i === 0 ? 8000 : 3000,
      quiet: i > 0,
    })));
    const primary = probes[0];
    const bl = bestOf(probes, 'latest');
    const bb = bestOf(probes, 'beta');
    const latest = bl?.version || '';
    const beta = bb?.version || '';
    const publishedAt = latest ? bl.at || 0 : 0;
    const betaPublishedAt = beta ? bb.at || 0 : 0;
    /**
     * 主源拿到东西了，备用源失败就**不算错误**——面板不该因为备用源挂了
     * 就显示「查不到最新版」。只有主源自己也什么都没拿到才交出去。
     */
    const err = primary.latest || primary.beta ? '' : primary.error;
    /**
     * 镜像滞后：主源的版本低于最终选中的版本。
     * 这正是「面板说已是最新、npm 上其实早有新版」的判定。
     */
    const mirrorLag = Boolean(primary.latest) && Boolean(latest)
      && compareVersion(latest, primary.latest) > 0;
    /**
     * 装包首选源。
     *
     * 镜像是装包真正会走的源；它上面**没有这个版本**时必须改走官方：
     * spec 是写死版本号的 `dsh-roost@1.3.8`，pnpm 会在镜像上解析它，
     * 撞 `not-found` 直接失败。`installBundle` 的 `registry` 选项是
     * 「先问这个」，配置的 fallback 仍排在后面兜底。
     */
    const installRegistry = latest && (mirrorLag || !primary.latest)
      ? DEFAULT_REGISTRY : primary.registry;

    const value = {
      latest, beta, publishedAt, betaPublishedAt, error: err,
      /** 主源（用户配的源）：装包默认走它 */
      registry: primary.registry,
      installRegistry,
      mirrorLag,
      mirrorLatest: primary.latest || '',
      /** 每个源的结论：诊断用，面板只在滞后时展示 */
      sources: probes.map((p) => ({
        registry: p.registry, latest: p.latest, beta: p.beta, error: p.error,
      })),
    };
    // 失败不写缓存：下次进来（或点「重新检查」）应该真的重试一次
    if (latest || beta) remoteCache = { at: Date.now(), key, value };
    return { ...value, cached: false };
  }

  /**
   * 组装「有没有新版 / 能不能自己装」的完整判断。
   *
   * 远端部分走 `remote()`（有 6 小时缓存），**本地部分每次现算**：
   * 装法、磁盘上的版本、有没有 pluginManager 都可能在这六小时里变
   * （用户刚重启完 DSH、刚换了安装方式）。缓存住会让横幅一直挂着一颗
   * 点不动的按钮——那比不提示更让人困惑。
   */
  async function check({ force = false, channel = '' } = {}) {
    const r = await remote({ force });
    const reg = r.registry;
    /**
     * 5.8：`latest` 看稳定版，`beta` 看测试版。beta 没发布时回落 latest，
     * 免得开了测试通道却永远显示「已是最新」。
     */
    const ch = (channel || (() => { try { return channelOf?.() || 'latest'; } catch { return 'latest'; } })()) === 'beta' ? 'beta' : 'latest';
    const pick = pickChannel({
      latest: r.latest, beta: r.beta,
      publishedAt: r.publishedAt, betaPublishedAt: r.betaPublishedAt,
      channel: ch,
    });
    const latest = pick.version;
    const publishedAt = pick.publishedAt;
    const err = r.error;
    /**
     * 这一版的版本号，**主源到底有没有**。
     *
     * 按通道单独判：开测试版的人，镜像可能已经同步了 `latest`（1.3.8）
     * 却没同步 `beta`，拿稳定版的结论去装 beta 一样会 `not-found`。
     */
    const primarySrc = Array.isArray(r.sources) ? r.sources[0] : null;
    const primaryTag = primarySrc ? String((ch === 'beta' ? primarySrc.beta : primarySrc.latest) || '') : '';
    /**
     * 主源**没有**这一版：要么版本更低，要么这个 tag 压根没同步过来
     * （镜像有 `latest` 却没 `beta` 很常见）。两种都得改走官方，否则
     * pnpm 拿 `dsh-roost@<新版>` 去镜像上解析就是 `not-found`。
     */
    const lagging = Boolean(primarySrc && latest) && (!primaryTag || compareVersion(latest, primaryTag) > 0);
    /** 面板提示只在**有版本号可比**时给：主源连 tag 都没有，说不出「还停在哪个版本」 */
    const mirrorLag = Boolean(primaryTag) && lagging;
    const installRegistry = lagging ? DEFAULT_REGISTRY : (r.installRegistry || reg);

    const age = publishedAt ? Date.now() - publishedAt : NaN;
    const ageKnown = Number.isFinite(age);
    /** 拿不到发布时间 ≠ 不在冷却期：三态处理，别让「立即安装」出口凭空消失 */
    const coolingUnknown = !ageKnown;
    const cooling = ageKnown && age < MIN_AGE_MS;
    // 按分钟取整再拆小时：Math.ceil 到小时会把 23 小时 04 分说成「还差 24 小时满 24 小时」
    const leftMin = cooling ? Math.ceil((MIN_AGE_MS - age) / 60_000) : 0;
    const leftH = Math.floor(leftMin / 60);
    const leftM = leftMin % 60;
    const k = kind();
    /**
     * 宿主能力探测。
     *
     * `installBundle` **只能装新包**：DSH 拿到 spec 先看包名，已存在就直接
     * `already-installed`。升级得用 `updateBundle`（DSH 自己的插件页走它），
     * 所以「面板能不能自己更新」看的是后者，不是前者。
     */
    const hasApi = (n) => typeof pm()?.[n] === 'function';
    /** 磁盘上装着的版本；读不到就退回运行中版本（测试环境没有真实 node_modules） */
    const installed = installedVersion();
    const base = installed || own;
    /** 手动更新的命令：一键装走不通时，这条是用户唯一能真正执行的动作（link 装法下为空） */
    const cmd = updateCommand({
      profileDir: profile(), version: latest, linked: k === 'linked',
      /** 这版不在主源上时，手动命令也得显式带官方源，否则装回来的还是旧版 */
      registry: lagging ? installRegistry : '',
    });
    const result = {
      ok: true,
      own,
      installed,
      latest,
      registry: reg,
      /**
       * 这次装包实际会先问哪个源。
       *
       * 平时等于 `registry`（用户的源）；镜像还没同步到 `latest` 时是官方源
       * ——否则按钮会写出一个镜像上并不存在的版本号，点了必然 not-found。
       */
      installRegistry,
      /** 用户的源比官方旧：面板要明说「镜像还没同步」，别让用户以为源配错了 */
      mirrorLag,
      mirrorLatest: primaryTag,
      /** 每个源的结论（诊断用）：镜像滞后时能一眼看出谁没跟上 */
      sources: Array.isArray(r.sources) ? r.sources : [],
      error: err,
      kind: k,
      /**
       * 只有真实目录才给更新按钮；符号链接会把开发链路搞断。
       *
       * 判据是 **`updateBundle`**，不是 `installBundle`：后者按包名拒绝已存在的包，
       * 「有更新」的前提恰恰是「已经装着旧版」，拿它做按钮就是点一次失败一次
       * （2026-11-17 用户实测面板 already-installed、同一时刻 CLI 2.1s 升级成功）。
       * 老 DSH 没有 `updateBundle` → `canSelf` 为假 → 面板直接给可跑的命令。
       */
      canSelf: k === 'real' && hasApi('updateBundle'),
      /**
       * 比的是**磁盘上那份**，不是运行中那份。
       *
       * 比运行中版本的话，装完新版不重启就永远"有更新"，
       * 按钮一直挂着，用户再点一次必然撞 already-installed。
       */
      hasUpdate: latest ? compareVersion(latest, base) > 0 : false,
      /** 查不到最新版（网络/registry 挂了）。面板据此给一个「按 latest 试装」的出口 */
      unknownLatest: Boolean(err && !latest),
      /** 装好了但还没重启：磁盘版本 ≠ 运行中版本 */
      pendingRestart: Boolean(installed && compareVersion(installed, own) > 0),
      publishedAt,
      ageMs: ageKnown ? age : null,
      ageText: ageKnown ? ageText(age) : '',
      // 不满 24 小时：pnpm 可能降级装旧版，得提前告诉用户
      cooling,
      /** 发布时间未知（简版元数据 / 时间字段缺失）：仍允许走豁免，不冒充「已过冷却期」 */
      coolingUnknown,
      coolingLeftText: cooling
        ? `还差 ${leftH} 小时${leftM ? ` ${leftM} 分钟` : ''}满 24 小时`
        : '',
      hasManager: hasApi('installBundle') || hasApi('updateBundle'),
      /** 手动更新的命令（兜底出口）：一键装走不通时给这条，别只甩一句「去插件管理里手动更新」 */
      command: cmd.command,
      shell: cmd.shell,
      profile: cmd.profile,
      spec: cmd.spec,
      /** `link:` 装法：没有可用的 add 命令，面板要改说「git pull 后重启」 */
      linked: cmd.linked,
      /** 命中 6 小时缓存（`force` 才能强刷）：面板据此把「重新检查」标成真的会重查 */
      cached: Boolean(r.cached),
    };
    lastCheck = { ...result, at: Date.now() };
    return result;
  }

  /**
   * 后台定时检查。
   *
   * 启动后先查一次，之后每 6 小时复查；结果留在内存里供概览页读。
   * 这样「有没有新版本」不再依赖用户打开面板，首页也不用等 registry。
   *
   * 定时器一律 `unref()`：不能因为一个更新检查让 DSH 进程退不掉。
   *
   * @param {object} [opts]
   * @param {number} [opts.firstDelayMs] 启动后多久查第一次（等宿主起来，别抢启动时的网络）
   * @param {number} [opts.everyMs]      之后多久复查一次
   * @param {(r:object)=>void} [opts.onResult]
   * @returns {() => void} 停止函数
   */
  function watch({ firstDelayMs = 10_000, everyMs = REMOTE_TTL_MS, onResult } = {}) {
    let stopped = false;
    let first = null;
    let timer = null;
    const run = async () => {
      if (stopped) return;
      try {
        const r = await check({ force: true });
        if (r.hasUpdate || r.pendingRestart) {
          log(`后台检查：有新版本 v${r.latest}（当前 v${r.own}）`);
        }
        onResult?.(r);
      } catch (e) {
        // 后台失败不打扰任何人：下次复查会再试，用户手动点「重新检查」也能立刻重查
        log(`后台检查更新失败：${e.message}`);
      }
    };
    first = setTimeout(() => {
      first = null;
      run();
      timer = setInterval(run, everyMs);
      timer.unref?.();
    }, firstDelayMs);
    first.unref?.();
    return () => {
      stopped = true;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }

  /** 后台快照；没查过返回 null（面板据此显示「还在查」，而不是「已是最新」） */
  function snapshot() {
    return lastCheck;
  }

  /**
   * 让 pnpm 跳过本包的 24 小时冷却。
   *
   * 只改 `~/.dsh/profiles/desktop/pnpm-workspace.yaml` 里的一条豁免项，
   * 写之前备份。**只对 dsh-roost 生效**——放开成"任意包"就等于给面板
   * 开了一个"给任何包跳过防投毒保护"的洞。
   */
  function exempt(version) {
    const f = join(profile(), 'pnpm-workspace.yaml');
    if (!existsSync(f)) throw new Error(`找不到 ${f}，没法加豁免（可能不是 pnpm 装的）`);
    const before = readFileSync(f, 'utf8');
    const r = patchExclude(before, PKG, version);
    if (!r.changed) return { changed: false, file: f };
    const bak = `${f}.roost-bak`;
    writeFileSync(bak, before, 'utf8');
    // 原子写：半截 yaml 会让 pnpm 之后所有操作都失败
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, r.text, 'utf8');
    renameSync(tmp, f);
    return { changed: true, file: f, backup: bak };
  }

  /**
   * 执行自更新。
   *
   * @param {object} [opts]
   * @param {boolean} [opts.fresh] 不等 24 小时（先写豁免项）
   */
  async function self({ fresh = false } = {}) {
    const k = kind();
    /**
     * 失败时把手动命令一起带回去。
     *
     * 「装不了」的三种情况（符号链接 / 没有 pluginManager / DSH 拒绝重装）
     * 唯一的出路就是用户自己在终端跑一行。前端拿到 `command` 才能给出
     * 一颗「复制命令」的按钮，而不是一句干巴巴的「去插件管理里手动更新」。
     */
    if (k === 'linked') {
      return {
        ok: false,
        code: 'linked',
        /**
         * **不给 add 命令。**
         *
         * `dsh plugin add` 会把 `"dsh-roost": "link:…"` 换成真实版本，
         * 符号链接当场变目录——给开发机递这把刀，比不给命令更糟。
         */
        command: '',
        shell: '',
        message: '这台机器上 dsh-roost 是符号链接（开发模式），自更新会把链接换成真实目录、'
          + '改源码就不再生效了。开发机请 git pull 后重启 DSH。',
      };
    }
    let cmd = updateCommand({ profileDir: profile() });
    if (k === 'unknown') {
      return {
        ok: false,
        code: 'unknown',
        command: cmd.command,
        shell: cmd.shell,
        message: '找不到已安装的 dsh-roost 目录，无法自更新。',
      };
    }
    const manager = pm();
    /** 两个 API 有一个就能动：能升级的走 `updateBundle`，只有 `installBundle` 的退回那条已知失败的旧路 */
    if (!manager?.updateBundle && !manager?.installBundle) {
      return {
        ok: false,
        code: 'no-manager',
        command: cmd.command,
        shell: cmd.shell,
        message: '这个 DSH 版本没有 pluginManager 服务，请在 DSH 插件管理里手动更新。',
      };
    }

    /**
     * **强制重查**，不吃那 6 小时缓存。
     *
     * 用户点「更新」就是明确的「我现在要装最新」：拿六小时前的缓存判断
     * 「已经是最新版」会把人挡在门外，而他明明刚看到发布公告。
     * 查失败也没关系——下面有 `unknownLatest` 兜底，照样按 latest 标签装。
     */
    const info = await check({ force: true });
    /**
     * 查不到最新版**不再直接阻断**。
     *
     * `check()` 只是前置判断：它去拉 registry 的 packument，8 秒超时，
     * 国内直连或挂代理的环境经常失败。而真正安装时 pnpm 自己会解析
     * `dsh-roost@latest`，根本不需要我们先知道版本号。
     * 以前这里一失败就 return，于是"网断了"和"其实能装"变成同一句
     * 「查不到最新版」，用户连试都试不了。
     */
    const unknownLatest = Boolean(info.error && !info.latest);
    if (unknownLatest) log(`查不到最新版（${info.error}），仍尝试按 latest 标签安装`);

    /**
     * 已经装上最新版：不再装第二次。
     *
     * 用 `installed`（磁盘）判断，不是 `own`（运行中）——装完没重启时后者还是旧值，
     * 会重复调 installBundle，然后被 DSH 以 already-installed 拒掉。
     */
    if (!unknownLatest && !info.hasUpdate) {
      return {
        ok: true,
        already: true,
        version: info.installed || own,
        message: info.pendingRestart
          ? `已经装好 v${info.installed}，重启 DSH 生效。`
          : `已经是最新版（v${own}）`,
      };
    }

    let exemption = null;
    // 冷却期内、或发布时间未知，都允许走豁免；后者正是简版元数据把 cooling
    // 恒判成 false 时唯一能装上新版的路。
    if (fresh && (info.cooling || info.coolingUnknown) && info.latest) {
      try {
        exemption = exempt(info.latest);
      } catch (e) {
        // 加不上豁免不是致命错误：继续装，pnpm 会降级并如实报告版本
        log(`加豁免失败：${e.message}`);
      }
    }

    const requestId = `roost-self-${Date.now()}`;
    /** `check()` 给的源：装包要跟着版本走，先拿到它才能让 DSH 按同一个源查版本 */
    const source = info.installRegistry || info.registry || '';
    /**
     * **目标版本必须先落实，再谈怎么装。**
     *
     * 以前查不到最新版就把 `dsh-roost@latest` 塞给 `installBundle`，让 pnpm 自己
     * 解析。这条路对升级**永远是失败的**：`installBundle` 是「装一个新包」，
     * DSH 拿到 spec 先看包名，已存在就 `refused('already-installed')`，下载都不会
     * 发生。面板出现更新横幅的前提恰恰是「已经装着旧版」，两个条件一叠加，
     * 「普通更新」和「立即安装（不等 24 小时）」两条路都撞同一堵墙
     * （2026-11-17 实机：`application:"failed"` / `changed:false` /
     * `errorCode:"already-installed"`，本地一个字节没动）。
     *
     * 所以先用 DSH 自己的 `listVersions`（与 `updateBundle` 共用同一套源计划）
     * 补一次确切版本；连它也拿不到就**直接给命令**，绝不再退化到装包。
     */
    let target = unknownLatest ? '' : String(info.latest || '');
    if (!target) {
      target = await latestFromManager({ registry: source });
      if (target) log(`check() 没查到最新版，改用 DSH 的 listVersions：v${target}`);
    }
    /**
     * 装包源**跟版本走**，不跟配置走。
     *
     * 镜像滞后时 `check()` 给的 latest 只存在于官方源：还按配置的源去装，
     * pnpm 会拿 `dsh-roost@<新版>` 到镜像上解析，直接 `not-found`。
     * 所以把它交给 DSH：官方排第一，配置的 fallback 仍在其后兜底。
     */
    /** 装包源和配置的源不一致 = 这版不在用户源上（滞后，或镜像根本没这个 tag） */
    const offPrimary = Boolean(source) && source !== (info.registry || '');
    if (offPrimary) {
      log(info.mirrorLag
        ? `配置的源只有 v${info.mirrorLatest}，v${target} 只在官方源上——这次从 ${source} 装`
        : `v${target} 不在配置的源上（没同步到这个 tag），这次从 ${source} 装`);
    }
    /**
     * 命令里**写死版本号**：知道目标版本就该给一行可复现的（别再交给 pnpm 猜
     * `latest`——镜像滞后时它猜出来的是旧版）。源只在这版不在用户源上时才带。
     */
    cmd = updateCommand({
      profileDir: profile(), version: target, registry: offPrimary ? source : '',
    });
    /**
     * **升级只能走 `updateBundle`，`installBundle` 装不了。**
     *
     * `installBundle` 是「装一个新的组合包」：DSH 拿到 spec 先看**包名**，
     * `known.has(name)` 为真就 `refused('already-installed', "<name> is already installed")`
     * ——按名字拒绝，跟版本号无关。而面板出现更新横幅的前提恰恰是「已经装着旧版」，
     * 两个条件一叠加，这颗按钮就是**点一次失败一次**（2026-11-17 用户实测：
     * 面板回 already-installed，同一时刻 CLI `dsh plugin add` 2.1s 就升上去了）。
     *
     * `updateBundle(name, version, { registry, requestId })` 才是升级入口
     * （DSH 自己的插件页也走它）：先按 `listVersions` 同一套计划核对目标版本，
     * 版本不存在 / 不是组合包 / engines 不满足时停在 `step:'check'`，**profile 不动**。
     * 开了 HMR 时它自己会先卸掉旧版再装新版，失败再把旧版装回来——所以「同名已装」
     * 这一步它内部处理得了，前提是我们给得出**确切版本号**。
     *
     * 因此这里**没有任何退路去调 `installBundle`**：版本落实不了就停在上面那条
     * `no-version` 分支给命令，让用户跑一条真能成的命令，而不是点一次失败一次。
     */
    if (!target) {
      return {
        ok: false,
        code: 'no-version',
        command: cmd.command,
        shell: cmd.shell,
        message: '这次没查到最新版，而面板升级需要确切版本号。稍后点「重新检查」，'
          + '或者用下面那行命令直接装。',
      };
    }
    /**
     * `updateBundle` 不存在 = 这个 DSH 版本的插件面板装不了升级（`canSelf` 也会是假，
     * 面板本来就不显示按钮；这里再兜一次，防止有人直接打接口）。
     */
    if (typeof manager.updateBundle !== 'function') {
      return {
        ok: false,
        code: 'no-update-api',
        command: cmd.command,
        shell: cmd.shell,
        message: '这个 DSH 版本的插件面板只能装新包、装不了升级。'
          + '跑下面那行命令就行，原地升到新版，不用先卸载；跑完重启 DSH。',
      };
    }
    let result;
    try {
      result = await manager.updateBundle(PKG, target, source ? { registry: source, requestId } : { requestId });
    } catch (e) {
      return {
        ok: false,
        code: 'throw',
        command: cmd.command,
        shell: cmd.shell,
        message: `更新失败：${e.message}（本地什么都没动）`,
      };
    }

    /**
     * DSH 的返回有**两种形态**，都必须认：
     *
     *   ChangeResult { changed, application, restartReason?, error?, packageResult?, bundle?, … }
     *   { status: 'refused', problem, reason }        ← 连 pnpm 都没跑就被拒
     *
     * `updateBundle` 又多一层：`{ from, to, step, result: ChangeResult }`
     * （失败时可能是 remote 包装的 `{ ok:false, error:{message} }`）。
     *
     * 以前只认 `application === 'success'`（这个值不存在）并去读
     * `packageResult.code`（这个字段也不存在），结果**每一次成功都被报成失败**，
     * 真正的错误码也全被丢掉，用户只能看到兜底文案。
     */
    /**
     * remote 层可能再包一层 `{ ok, value|error }`（`registries()` 就是这么给的），
     * 先剥掉；`ok:false` 表示连 ChangeResult 都没拿到。
     */
    let answer = result;
    if (answer && typeof answer === 'object' && typeof answer.ok === 'boolean'
      && ('value' in answer || 'error' in answer)) {
      if (!answer.ok) {
        const why = answer.error?.message || '没有给出原因';
        return {
          ok: false,
          code: 'refused',
          command: cmd.command,
          shell: cmd.shell,
          message: `DSH 拒绝了这次升级：${why}（本地什么都没动）。可以试试下面那行命令。`,
          detail: { code: 'refused', diagnostic: why },
          raw: result,
        };
      }
      answer = answer.value;
    }
    /**
     * 统一成 ChangeResult 那一层。
     *
     * `updateBundle` 把结果包在 `result` 里（外层还有 from/to/step，留着做诊断）。
     * 现在只有这一种形态——`installBundle` 那条退路已经删掉了，见上面
     * `no-update-api` 分支的说明。
     */
    const change = answer && typeof answer === 'object' && 'step' in answer
      ? (answer.result || {})
      : answer;
    const app = change?.application;
    const refused = change?.status === 'refused';
    const errCode = change?.error?.code || (refused ? change?.problem : '') || '';
    /** 给人看的细节：错误码之外还有 pnpm 的分类、原文和日志路径 */
    const detail = {
      code: errCode,
      diagnostic: change?.error?.diagnostic || (refused ? change?.reason : '') || '',
      kind: change?.packageResult?.kind || '',
      failedAt: change?.failedAt || answer?.failedAt || '',
      exitCode: change?.packageResult?.exitCode ?? null,
      timedOut: Boolean(change?.packageResult?.timedOut),
      logPath: change?.packageResult?.logPath || '',
      // pnpm 输出可能很长；只带前 400 字，够定位又不会把响应撑大
      output: String(change?.packageResult?.output || '').slice(0, 400),
      /** 升级专用的进度信息：停在哪一步、从哪版到哪版（installBundle 路径为空） */
      step: answer?.step || '',
      from: answer?.from || '',
      to: answer?.to || '',
    };

    if (app === 'cancelled') {
      return { ok: false, code: 'cancelled', message: humanFail('cancelled'), detail };
    }
    if (refused || app === 'failed' || (change?.error && !APP_OK.has(app))) {
      /** 版本核对失败：把「本来要装哪版、现在还剩哪版」说清楚，光有错误码没用 */
      const message = errCode === 'unexpected-package' && target
        ? `没装上 v${target}：DSH 核对版本不符，已经回滚（本地仍是 v${info.installed || own}）。`
          + '多半是新版本发布不满 24 小时被 pnpm 挡回旧版——点「立即安装（不等 24 小时）」，或明天再更新。'
        /**
         * `already-installed` 现在只可能来自 DSH 自己的 `updateBundle`
         * （正常情况下它内部会先卸旧版再装，不该出现）。真撞上了就是「这个 DSH 版本的
         * 插件面板按包名拒绝升级」，唯一能走通的是命令行，所以文案必须把命令抬出来，
         * 而不是叫人「先卸载」——升级本来就是原地替换。
         */
        : errCode === 'already-installed'
          ? '这个 DSH 版本的插件面板只能装新包、装不了升级（返回 already-installed）。'
            + '跑下面那行命令就行，原地升到新版，不用先卸载；跑完重启 DSH。'
          : humanFail(errCode, detail);
      return {
        ok: false,
        code: errCode || 'failed',
        command: cmd.command,
        shell: cmd.shell,
        message,
        detail,
        raw: result,
      };
    }
    if (!APP_OK.has(app)) {
      /**
       * 拿不到 `application`：可能是更老的 DSH，或返回结构又变了。
       * **不能当成功**——那样用户会以为装好了，重启后还是旧版。
       */
      return {
        ok: false,
        code: 'unexpected',
        command: cmd.command,
        shell: cmd.shell,
        message: '更新返回了看不懂的结果，本地可能没动。去 DSH 插件管理里看一眼版本。',
        detail,
        raw: result,
      };
    }

    /**
     * 核对**实际装到的**版本：优先读磁盘，其次信 installBundle 的返回。
     *
     * 旧写法拿 `info.latest`（请求的版本）兜底 `got`，等于自己骗自己：
     * pnpm 被 24 小时冷却挡住时会静默保留旧版、且返回里未必有 version，
     * 兜底成请求版本后 downgraded 恒为 false → 用户看到「已装 v1.0.0」，
     * 重启后还是 0.13.0。写进磁盘的那份才是事实。
     */
    /**
     * 装到的版本，按可信度取：磁盘 > DSH 报的 bundle.version > `updateBundle.to`。
     *
     * `updateBundle` 的 ChangeResult 未必带 `bundle`，但它外层一定给了 `to`——
     * 磁盘读不到时（Windows 上文件被占）靠它兜一下，别动不动就报「没核对到」。
     */
    const reported = String(change?.bundle?.version || change?.version || answer?.to || '').replace(/^v/i, '');
    const onDisk = String(installedVersion() || '').replace(/^v/i, '');
    const got = onDisk || reported;
    const wanted = info.latest || reported;
    /** 两个来源都没版本号：不能报「已装 vX」，如实说没核对到 */
    const unverified = !got;
    // 只有两边都有版本号才谈得上"降级"
    const downgraded = Boolean(wanted && got && compareVersion(got, wanted) < 0);
    /** `restart-required` / `overridden` 都表示"现在还没生效" */
    const needRestart = app === 'restart-required' || app === 'overridden'
      || Boolean(change?.restartReason) || change?.changed === true;
    return {
      ok: true,
      version: got,
      wanted,
      downgraded,
      unverified,
      exemption,
      application: app,
      restartReason: change?.restartReason || '',
      message: downgraded
        ? `已装 v${got}，不是最新的 v${wanted}——因为新版本发布不满 24 小时，pnpm 降级了。`
          + '可以点「立即安装（不等 24 小时）」，或明天再更新。'
        : unverified
          ? '安装已返回成功，但没能核对到实际装到的版本。重启 DSH 后到「设置 → 更新」看版本号；'
            + '如果仍是旧版，点「立即安装（不等 24 小时）」。'
          // toast 是纯文本，别在这里写 markdown 星号（会原样显示出来）
          : unknownLatest
            // 版本号是 pnpm 解析出来的；这次没查到"最新"，就别编一个数字
            ? `已装 ${got ? 'v' + got : '最新版'}，重启 DSH 才生效（没查到版本号，按 latest 标签装的）。`
            : `已装 v${got}，重启 DSH 才生效。`,
      restart: needRestart,
      unknownLatest,
      /** 成功也留诊断：`step`/`from`/`to` 能看出这次是「检查通过后装上了」还是别的路径 */
      detail,
    };
  }

  return {
    own: () => own, installedVersion, check, self, exempt, watch, snapshot,
    profileDir: profile, kind, registryUrl,
  };
}
