/**
 * 扩展文档自举：`API.md` / `extension.d.ts`
 * ========================================
 *
 * 为什么不让文档手写：`/v1` 端点、scope、清单字段、错误码都在代码里，
 * 手写文档**必然**跟实现漂移（阶段 2–6 每轮都在改这些）。所以这里从
 * `V1_ROUTES` / `V1_SCOPES` / `REJECTION_LAYERS` / `EXT_ID_RE` 这些**真实常量**
 * 生成文档，CI 里用 `--check` 比对，改代码忘了重跑就红。
 *
 * 唯一的「手写内容」是 `ROUTE_NOTES`（每个端点一句人话）与各段说明文字 ——
 * 它们是产品语气，不是事实来源；事实（路径、scope、枚举）全部来自代码。
 */
import fs from 'node:fs';
import { join } from 'node:path';

import {
  V1_ROUTES, V1_SCOPES, RATE_LIMIT, WINDOW_MS, IDEMPOTENT_TTL_MS, IDEMPOTENT_MAX, MAX_BODY_BYTES,
  isRouteImplemented,
} from './api-v1.js';
import { REJECTION_LAYERS, SENSITIVE_SCOPES, LOCALLY_MODIFIED_LABEL } from './ext-panel.js';
import { EXT_ID_RE, MANIFEST_FILE, SOURCE_FILE } from './ext-registry.js';
import { ALLOWED_ENV_KEYS } from './ext-patch.js';
import { USAGE_CHAR_LIMIT, USAGE_TOTAL_BYTE_LIMIT } from './ext-usage.js';
import { DEFAULT_EXT_ACL } from './ext-memory.js';

export const API_DOC = 'API.md';
export const DTS_DOC = 'extension.d.ts';

/**
 * 每个端点一句人话。**双向校验**：缺文案、或写了已经不存在的端点，
 * `routeRows()` 直接抛错 —— 上一版只报「缺」不报「死键」，`memory.ext.add`
 * 写成点号后一直静静地不生效。
 */
const ROUTE_NOTES = {
  'POST /v1/message': '把一条消息送进 QQ（复用现有入站链路，不另写一条）',
  'POST /v1/say': '让机器人主动说一句；`pending` 表示进审核，不是已发出',
  'GET /v1/state': '读机器人与当前会话的状态（在线、绑定、档位）',
  'GET /v1/mood': '读当前心情',
  'GET /v1/context': '读当前会话的上下文摘要（条数、窗口占用）',
  'GET /v1/memory': '读当前会话的记忆（列表形态）',
  'POST /v1/memory': '往**当前会话**的记忆里写一条',
  'POST /v1/memory/ext.add': '往**扩展自己的命名空间**写一条（extId 由令牌决定，body 自报无效）',
  'POST /v1/proactive': '排一条主动消息（受清醒时段与频次约束）',
  'POST /v1/session.ensure': '确保会话存在',
  'POST /v1/session.configure': '改会话配置（模型、人格、工具开关）',
  'POST /v1/agent.new': '开一个独立 Agent 会话（游戏裁判这类无 QQ 身份的场景）',
  'POST /v1/agent.prompt': '给独立会话发一轮；默认 SSE 流式',
  'POST /v1/agent.close': '关独立会话并撤销它的注册',
  'GET /v1/agent.list': '列出当前开着的独立会话',
  'GET /v1/whoami': '回显令牌身份（不含 hash / 明文）',
};

const errCodeRows = [
  ['401 `unauthorized`', '令牌无效、已吊销，或扩展的 `secrets/<id>.json` 缺失（宿主已记 `ext.auth_failed`）'],
  ['403 `forbidden`', 'scope 不足；或扩展令牌调了 `agent.*` / `say` 这类不属于它的端点'],
  ['404 `not_found`', '没有这个 `/v1` 端点'],
  ['413 `request_too_large`', '请求体超过 1 MB'],
  ['429 `rate_limited`', '每客户端每分钟 120 次（响应带 `retry-after`）'],
  ['501 `not_implemented`', '该端点业务尚未接线（见第 6 节「状态」列，当前有若干条）'],
];

function routeRows() {
  const missing = Object.keys(V1_ROUTES).filter((k) => !ROUTE_NOTES[k]);
  if (missing.length) throw new Error(`ext-docs：这些端点缺 ROUTE_NOTES 文案：${missing.join('、')}`);
  const dead = Object.keys(ROUTE_NOTES).filter((k) => !(k in V1_ROUTES));
  if (dead.length) throw new Error(`ext-docs：ROUTE_NOTES 有已经不存在的端点（死键）：${dead.join('、')}`);

  const rows = [];
  for (const [key, route] of Object.entries(V1_ROUTES)) {
    const [method, path] = key.split(' ');
    rows.push({
      key, method, path,
      scope: route.scope ?? '（任意有效令牌）',
      note: ROUTE_NOTES[key],
      /** 按 `isRouteImplemented()` 判，不靠人工维护第二份名单。 */
      ready: isRouteImplemented(key),
    });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function renderApiMd({ version = '' } = {}) {
  const rows = routeRows();
  const aclRows = Object.entries(DEFAULT_EXT_ACL.byBucket ?? {}).map(([bucket, rule]) => {
    const fmt = (v) => (Array.isArray(v) && v.length ? v.join(' / ') : '（无）');
    return `| \`${bucket}\` | ${fmt(rule.read)} | ${fmt(rule.write)} |`;
  });

  return `# dsh-roost 扩展 API

> 本文件由 \`scripts/build-ext-docs.mjs\` **从源码生成**，不要手改。
> 改端点 / scope / 清单字段后跑 \`node scripts/build-ext-docs.mjs\`，CI 用 \`--check\` 校验。
${version ? `>\n> 对应版本：\`${version}\`\n` : ''}
## 1. 扩展是什么

一个扩展 = 一份 \`${MANIFEST_FILE}\` + 一个 **MCP server**（任意语言）。宿主不关心它内部怎么写，
只按标准 MCP 协议拉起、发现工具，并把工具变成 \`mcp__<id>__<tool>\` 交给模型。

- 加载 / 发现 / 重连交给 DSH 官方；
- 宿主只补四块：QQ 权限桥、\`/v1\` 控制面、扩展记忆、面板与市场。

## 2. 三步装起来

1. 在 \`${MANIFEST_FILE}\` 里写 \`"kind": "dsh-extension"\`，\`id\` 必须等于目录名（正则 \`${EXT_ID_RE}\`）；
2. 把目录放进 \`<dataDir>/extensions/<id>/\`，或用面板「设置 → 扩展 → 市场」安装；
3. 在能力页把该扩展的六档权限调好（装完会自动建 \`ext_<id>\` 影子组）。

## 3. 清单字段

必填：\`id\` / \`serverName\`（必须等于 \`id\`）/ \`name\` / \`description\` / \`transport\`；
\`stdio\` 还要 \`command\`，\`streamable-http\` 还要 \`url\`（**只认回环地址**）。

| 字段 | 说明 |
|---|---|
| \`kind\` | 固定 \`dsh-extension\`；框架插件不应带这个值 |
| \`transport\` | \`stdio\` 或 \`streamable-http\` |
| \`mounts\` | **保留字段**：当前版本只做类型校验，尚未接到 \`restrictTurnTools\` |
| \`memory\` | **保留字段**：\`onClear\` / \`maxRows\` 由 store 读取但安装时不会写入；\`visibility\` 未映射到 ACL |
| \`usage\` | 可选，覆盖自动生成的能力说明（单条上限 **${USAGE_CHAR_LIMIT} 字**、全部合计 **${USAGE_TOTAL_BYTE_LIMIT} 字节**） |
| \`sha256\` / \`size\` / \`publishedAt\` | 市场条目用于本地完整性校验；**编辑 usage 后 \`sha256\` 会被宿主置空并标注「${LOCALLY_MODIFIED_LABEL}」** |

**清单不许自带 \`env\` 键**（方案 L：env 由 launcher 注入）。受管块里只允许这三个变量名：
${ALLOWED_ENV_KEYS.map((k) => `\`${k}\``).join(' / ')}。

## 4. 认证

- 每个扩展一个 Bearer 令牌，明文只在 \`<dataDir>/secrets/<id>.json\`（0600，不进备份包）；
- \`api.clients\` 只存 sha256，面板只显示一次；
- \`extId\` **一律从令牌记录读**，请求体里传了会被忽略并记 warn（来源不可自报）；
- 令牌缺失 / 被吊销 → \`401\` + 宿主审计 \`ext.auth_failed\` → 面板显示「扩展鉴权失败」。

## 5. scope

${V1_SCOPES.map((s) => `- \`${s}\`${SENSITIVE_SCOPES.includes(s) ? '（**敏感**：面板发放要二次确认）' : ''}`).join('\n')}

最小授权默认 \`message:write\` + \`state:read\`；敏感 scope 需要单独勾选确认。

## 6. 端点

**「状态」列是硬事实，不是进度暗示**：标 ⛔ 的端点当前恒回 \`501 not_implemented\`，
调用不会产生任何副作用。标 ✅ 的才是现在能用的。

| 方法 | 路径 | scope | 状态 | 说明 |
|---|---|---|---|---|
${rows.map((r) => `| ${r.method} | \`${r.path}\` | ${r.scope === '（任意有效令牌）' ? r.scope : `\`${r.scope}\``} | ${r.ready ? '✅ 可用' : '⛔ 501 未接线'} | ${r.note} |`).join('\n')}

> 未接线的 ${rows.filter((r) => !r.ready).length} 条端点已预留路由与鉴权（scope 校验、限频、幂等都在生效），
> 只差业务实现。第三方可以先按此契约开发，但**不要**把它们当成已可用能力。

### 幂等与限频

- 请求体带 \`requestId\`（或头 \`x-request-id\`）→ **${IDEMPOTENT_TTL_MS / 3_600_000} 小时**内重复投递不重复执行（内存 LRU ${IDEMPOTENT_MAX} 条），直接回首次结果；
- 每客户端 **${RATE_LIMIT} 次/${WINDOW_MS / 1000} 秒**滑动窗口，超了回 \`429\` + \`retry-after\`；
- 请求体上限 **${MAX_BODY_BYTES / 1024 / 1024} MB**，超过回 \`413\`；
- 幂等短路在限频之前：重复投递不再消耗配额。

## 7. 扩展记忆

每个扩展一个 \`ext-memory/<id>.json\`，**不自动注入**；只有模型主动调 \`ext_memory_search\` 才会读。

命名空间 ACL（默认值，面板可改）：

| 档位 | 可读 | 可写 |
|---|---|---|
${aclRows.join('\n')}

\`private\` 行命中条件：\`kind === 'c2c'\` **且** 档位是 \`owner\` / \`admin\`。
\`all:true\` 只放宽**检索范围**，绝不放宽 ACL —— ACL 是硬上限。

## 8. 常见错误码

| 错误 | 含义 |
|---|---|
${errCodeRows.map(([c, m]) => `| ${c} | ${m} |`).join('\n')}

## 9. 为什么没生效

拒绝可能来自五层，面板「能力 → 扩展能力分组 → 拒绝诊断」按层显示：

${Object.entries(REJECTION_LAYERS).map(([id, label], i) => `${i + 1}. \`${id}\` —— ${label}`).join('\n')}

## 10. 示例

- \`examples/hello-stdio/\` —— 最小 stdio MCP server（零依赖）
- \`examples/hello-http/\` —— 最小 streamable-http MCP server（零依赖）

两个示例都会被 \`test/ext-examples.test.js\` 真跑：发 \`initialize\` / \`tools/list\` / \`tools/call\`，
断言工具真的能调。
`;
}

export function renderDts() {
  return `/**
 * dsh-roost 扩展类型定义
 *
 * 本文件由 \`scripts/build-ext-docs.mjs\` **从源码生成**，不要手改。
 * 源码常量：\`V1_SCOPES\` / \`REJECTION_LAYERS\` / \`EXT_ID_RE\` / \`ALLOWED_ENV_KEYS\`。
 */

/** 扩展 id：小写字母开头，2–32 位，只含 \`a-z0-9-\`。必须等于目录名。 */
export type ExtensionId = string;

/** \`/v1\` 客户端 scope。 */
export type V1Scope =
${V1_SCOPES.map((s) => `  | '${s}'`).join('\n')};

/** 需要单独确认的敏感 scope。 */
export type SensitiveScope =
${SENSITIVE_SCOPES.map((s) => `  | '${s}'`).join('\n')};

/** 拒绝诊断的五层来源。 */
export type RejectionLayer =
${Object.keys(REJECTION_LAYERS).map((s) => `  | '${s}'`).join('\n')};

/** 受管块里允许出现的环境变量名（值由 launcher 注入，清单不许自带 env）。 */
export type ManagedEnvKey =
${ALLOWED_ENV_KEYS.map((s) => `  | '${s}'`).join('\n')};

export interface ExtensionMemoryConfig {
  /** 写入目标命名空间，形如 \`ext:<id>\`。 */
  writeTarget?: string;
  /** 可见性：\`all\` 表示其他档位也能读。 */
  visibility?: 'all' | 'owner' | 'private';
  /** 宿主清空会话 / 全局记忆时的行为。 */
  onClear?: 'keep' | 'clear';
  /** 单命名空间最多保留多少行。 */
  maxRows?: number;
}

export interface ExtensionManifest {
  /** 固定 \`1\`。 */
  api?: 1;
  /** 固定 \`dsh-extension\`（框架插件不带这个值）。 */
  kind?: 'dsh-extension';
  /** 必须等于目录名，正则 \`${EXT_ID_RE.source}\`。 */
  id: ExtensionId;
  /** 必须等于 \`id\`：工具名 / section 名 / 组名全由 id 推导。 */
  serverName: ExtensionId;
  name: string;
  description: string;
  /** 可选，覆盖自动生成的能力说明（上限 ${USAGE_CHAR_LIMIT} 字）。 */
  usage?: string;
  transport: 'stdio' | 'streamable-http';
  /** stdio 必填。 */
  command?: string;
  args?: string[];
  /** streamable-http 必填，且只认回环地址。 */
  url?: string;
  /** 只管 QQ 会话的工具可见性；独立会话工具全见。 */
  mounts?: string[];
  memory?: ExtensionMemoryConfig;
  /** 市场元数据：本地完整性校验用。 */
  sha256?: string | null;
  size?: number;
  publishedAt?: string;
  /** \`true\` 表示被本地改过，不再参与更新校验。 */
  locallyModified?: boolean;
}

export interface V1ErrorBody {
  ok: false;
  error: string;
  message?: string;
}

export interface WhoAmI {
  ok: true;
  id: string;
  name: string;
  scopes: V1Scope[];
  /** 扩展令牌才有；面板发放的客户端为 \`null\`。 */
  extId: string | null;
}
`;
}

/**
 * 写两份文档。`--check` 用 `checkDocs()`，不写盘。
 */
export function buildDocs({ version = '' } = {}) {
  return [
    { name: API_DOC, text: renderApiMd({ version }) },
    { name: DTS_DOC, text: renderDts() },
  ];
}

export function writeDocs({ docsDir, version = '' } = {}) {
  const out = [];
  for (const d of buildDocs({ version })) {
    const file = join(docsDir, d.name);
    fs.mkdirSync(docsDir, { recursive: true });
    // 原子写：中断时不会留下一份半截 API.md（与 ext-patch / ext-memory-store 同一口径）。
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, d.text, 'utf8');
    fs.renameSync(tmp, file);
    out.push(file);
  }
  return out;
}

/** 返回与磁盘不一致的文件名列表；空 = 一致。 */
export function checkDocs({ docsDir, version = '' } = {}) {
  const bad = [];
  for (const d of buildDocs({ version })) {
    const file = join(docsDir, d.name);
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8'); } catch { /* 缺失 */ }
    if (cur !== d.text) bad.push(d.name);
  }
  return bad;
}

export { MANIFEST_FILE, SOURCE_FILE };
