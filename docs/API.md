# dsh-roost 扩展 API

> 本文件由 `scripts/build-ext-docs.mjs` **从源码生成**，不要手改。
> 改端点 / scope / 清单字段后跑 `node scripts/build-ext-docs.mjs`，CI 用 `--check` 校验。
>
> 对应版本：`1.3.0-beta.1`

## 1. 扩展是什么

一个扩展 = 一份 `plugin.json` + 一个 **MCP server**（任意语言）。宿主不关心它内部怎么写，
只按标准 MCP 协议拉起、发现工具，并把工具变成 `mcp__<id>__<tool>` 交给模型。

- 加载 / 发现 / 重连交给 DSH 官方；
- 宿主只补四块：QQ 权限桥、`/v1` 控制面、扩展记忆、面板与市场。

## 2. 三步装起来

1. 在 `plugin.json` 里写 `"kind": "dsh-extension"`，`id` 必须等于目录名（正则 `/^[a-z][a-z0-9-]{1,31}$/`）；
2. 把目录放进 `<dataDir>/extensions/<id>/`，或用面板「扩展 → 市场」安装；
3. 在权限页把该扩展的六档权限调好（装完会自动建 `ext_<id>` 影子组）。

## 3. 清单字段

必填：`id` / `serverName`（必须等于 `id`）/ `name` / `description` / `transport`；
`stdio` 还要 `command`，`streamable-http` 还要 `url`（**只认回环地址**）。

| 字段 | 说明 |
|---|---|
| `kind` | 固定 `dsh-extension`；框架插件不应带这个值 |
| `transport` | `stdio` 或 `streamable-http` |
| `scopes` | 扩展要用的权限，可选。**不写 = 只有 `memory:write` + `state:read`**；`say:write` / `proactive:write` / `message:write` 等属于敏感项，安装时必须由主人二次确认。未知项会被拒。 |
| `mounts` | **保留字段**：当前版本只做类型校验，尚未接到 `restrictTurnTools` |
| `memory` | **保留字段**：`onClear` / `maxRows` 由 store 读取但安装时不会写入；`visibility` 未映射到 ACL |
| `usage` | 可选，覆盖自动生成的能力说明（单条上限 **200 字**、全部合计 **2048 字节**） |
| `config` | 可选，**可调设置**的声明（见 §3.1）。面板据此画表单，宿主负责存储与下发 |
| `sha256` / `size` / `publishedAt` | 市场条目用于本地完整性校验；**编辑 usage 后 `sha256` 会被宿主置空并标注「已本地修改，不再参与更新校验」** |

**清单不许自带 `env` 键**（方案 L：env 由 launcher 注入）。受管块里只允许这三个变量名：
`ROOST_API_URL` / `ROOST_EXT_ID` / `ROOST_LAUNCHER_DIR`。

### 3.1 可调设置（`config`）

扩展是 MCP server，协议里没有 UI，所以设置只能**宿主代画、代存、代下发**。
在清单里声明字段，面板会渲染表单，值保存在宿主侧，启动时通过环境变量给回扩展：

```jsonc
{
  "config": {
    "threshold": { "type": "number", "label": "阈值", "default": 3, "min": 1, "max": 100, "integer": true },
    "region":    { "type": "select", "label": "分区", "options": ["热门", { "value": "anime", "label": "动画" }], "default": "热门" },
    "enabled":   { "type": "boolean", "label": "启用", "default": true },
    "keyword":   { "type": "string", "label": "关键词", "maxLength": 64, "hint": "留空表示不过滤" },
    "apiKey":    { "type": "string", "label": "API Key", "secret": true, "required": true },
    "tags":      { "type": "array", "label": "标签", "items": { "type": "string" }, "maxItems": 8 },
    "advanced":  { "type": "object", "label": "高级", "properties": { "retries": { "type": "number", "default": 2 } } }
  }
}
```

| 字段键 | 说明 |
|---|---|
| `type` | `string` / `number` / `boolean` / `select` / `array` / `object`。**没有 `path` / `file`** —— 配置里出现路径等于让面板能指定读写目标 |
| `label` / `hint` | 面板显示的文字；`label` 缺省用字段名 |
| `default` | 缺省值，会按类型校验；保存时自动补齐缺的键 |
| `required` | 必填。敏感项只在「从未设置过」时算不满足 |
| `secret` | **只能用在顶层 `string`**：值不进 `config.json`，单独存 `secrets/<id>.config.json`（0600），面板永远拿不到明文。**不能写 `default`** —— 声明会原样回给面板，默认值等于明文下发 |
| `min` / `max` / `integer` | `number` 的边界 |
| `maxLength` / `placeholder` | `string` 的长度与占位符（上限 4096） |
| `options` | `select` 的候选，`["a"]` 或 `[{value,label}]` 两种写法 |
| `items` / `maxItems` | `array` 的元素类型（仅标量）与条数上限 |
| `properties` | `object` 的子字段，**嵌套最多 2 层**，且子字段不能再标 `secret` |

约束：最多 **32** 个字段（`object` 的子字段也计入这个上限）；字段名 `[a-zA-Z][a-zA-Z0-9_]{0,31}`；
声明非法时**安装就会被拒**（不会等到面板渲染才发现）。更新扩展时 `config.json` 会原样保留，设置不会因为升级而丢。

**扩展怎么读**：

| 变量 | 内容 |
|---|---|
| `ROOST_EXT_CONFIG` | 非敏感项的 JSON 字符串（已补齐默认值；没有声明时是 `{}`） |
| `ROOST_EXT_SECRET_<KEY>` | 敏感项，键名由宿主从字段名生成（`apiKey` → `ROOST_EXT_SECRET_APIKEY`）。未设置时是**空串**，不是缺键 |

**生效方式**：配置在进程启动时读一次。面板保存后会尝试重建连接；当前受管块是静态挂载的实例，
`mcpManager` 治理不到它，所以通常要**重启 DSH**。扩展机制迁到 `mcpManager.register()` 之后会自动变成热生效。

## 4. 认证

- 每个扩展一个 Bearer 令牌，明文只在 `<dataDir>/secrets/<id>.json`（0600，不进备份包）；
- `api.clients` 只存 sha256，面板只显示一次；
- `extId` **一律从令牌记录读**，请求体里传了会被忽略并记 warn（来源不可自报）；
- 令牌缺失 / 被吊销 → `401` + 宿主审计 `ext.auth_failed` → 面板显示「扩展鉴权失败」。

## 5. scope

- `message:write`
- `say:write`（**敏感**：面板发放要二次确认）
- `state:read`
- `context:read`
- `memory:read`
- `memory:write`
- `proactive:write`（**敏感**：面板发放要二次确认）
- `session:write`
- `prompt:write`（**敏感**：面板发放要二次确认）
- `agent:write`（**敏感**：面板发放要二次确认）

最小授权默认 `message:write` + `state:read`；敏感 scope 需要单独勾选确认。

## 6. 端点

**「状态」列是硬事实，不是进度暗示**：✅ 的才是能用的；⛔ 的当前恒回 `501 not_implemented`
（已预留路由与鉴权，只差业务）；🚫 是**设计上不开放**给扩展的，不会随版本变成可用。

| 方法 | 路径 | scope | 状态 | 说明 |
|---|---|---|---|---|
| POST | `/v1/agent.close` | `agent:write` | ✅ 可用 | 关独立会话并撤销它的注册 |
| GET | `/v1/agent.list` | `agent:write` | ✅ 可用 | 列出当前开着的独立会话 |
| POST | `/v1/agent.new` | `agent:write` | ✅ 可用 | 开一个独立 Agent 会话（游戏裁判这类无 QQ 身份的场景） |
| POST | `/v1/agent.prompt` | `agent:write` | ✅ 可用 | 给独立会话发一轮；默认 SSE 流式 |
| GET | `/v1/context` | `context:read` | ✅ 可用 | 读当前会话的上下文摘要（条数、窗口占用） |
| GET | `/v1/ext-ui/actions` | `state:read` | ✅ 可用 | 取走面板上点过的按钮动作（读即消费，只返回本扩展的） |
| GET | `/v1/memory` | `memory:read` | ✅ 可用 | 读当前会话的记忆（列表形态）；scope:global 会带上全局那层 |
| POST | `/v1/memory` | `memory:write` | ✅ 可用 | 往**当前会话**的记忆里写一条；**不能写 global**（会影响所有会话），要记自己的东西用 /v1/memory/ext.add |
| POST | `/v1/memory/ext.add` | `memory:write` | ✅ 可用 | 往**扩展自己的命名空间**写一条（extId 由令牌决定，body 自报无效） |
| POST | `/v1/message` | `message:write` | ✅ 可用 | 把一条消息送进 QQ（复用现有入站链路，不另写一条） |
| GET | `/v1/mood` | `state:read` | ✅ 可用 | 读当前心情 |
| POST | `/v1/proactive` | `proactive:write` | ✅ 可用 | 排一条主动消息（受清醒时段与频次约束） |
| POST | `/v1/proactive/submit` | `proactive:write` | ✅ 可用 | 扩展投递一条素材；宿主过门闸后让模型自己组织语言主动发出 |
| POST | `/v1/say` | `say:write` | ✅ 可用 | 让机器人主动说一句；`pending` 表示进审核，不是已发出 |
| POST | `/v1/send` | `message:write` | ✅ 可用 | 扩展直接把文本 / 文件 / 官方图文卡片发进会话，不跑模型 |
| POST | `/v1/session.configure` | `prompt:write` | 🚫 设计不开放 | 改会话配置（模型、人格、工具开关） |
| POST | `/v1/session.ensure` | `session:write` | ✅ 可用 | 确保会话存在 |
| GET | `/v1/state` | `state:read` | ✅ 可用 | 读机器人与当前会话的状态（在线、绑定、档位） |
| GET | `/v1/whoami` | （任意有效令牌） | ✅ 可用 | 回显令牌身份（不含 hash / 明文） |

> 未接线的 0 条端点已预留路由与鉴权（scope 校验、限频、幂等都在生效），
> 只差业务实现。第三方可以先按此契约开发，但**不要**把它们当成已可用能力。

### 幂等与限频

- 请求体带 `requestId`（或头 `x-request-id`）→ **24 小时**内重复投递不重复执行（内存 LRU 500 条），直接回首次结果；
- 每客户端 **120 次/60 秒**滑动窗口，超了回 `429` + `retry-after`；
- 请求体上限 **1 MB**，超过回 `413`；
- 幂等短路在限频之前：重复投递不再消耗配额。

## 7. 扩展记忆

每个扩展一个 `ext-memory/<id>.json`，**不自动注入**；只有模型主动调 `ext_memory_search` 才会读。

命名空间 ACL（默认值，面板可改）：

| 档位 | 可读 | 可写 |
|---|---|---|
| `owner` | * | * |
| `admin` | * | * |
| `member` | * | （无） |
| `unknown` | （无） | （无） |

`private` 行命中条件：`kind === 'c2c'` **且** 档位是 `owner` / `admin`。
`all:true` 只放宽**检索范围**，绝不放宽 ACL —— ACL 是硬上限。

## 8. 常见错误码

| 错误 | 含义 |
|---|---|
| 401 `unauthorized` | 令牌无效、已吊销，或扩展的 `secrets/<id>.json` 缺失（宿主已记 `ext.auth_failed`） |
| 403 `forbidden` | scope 不足；或扩展令牌调了 `agent.*` / `say` 这类不属于它的端点 |
| 404 `not_found` | 没有这个 `/v1` 端点 |
| 413 `request_too_large` | 请求体超过 1 MB |
| 429 `rate_limited` | 每客户端每分钟 120 次（响应带 `retry-after`） |
| 501 `not_implemented` | 该端点业务尚未接线（见第 6 节「状态」列，当前有若干条） |

## 9. 为什么没生效

拒绝可能来自五层，面板「扩展 → 扩展能力分组 → 拒绝诊断」按层显示：

1. `fence` —— 接入栅栏 / 令牌鉴权
2. `capabilities` —— 权限页的收紧规则
3. `quota` —— 次数限制
4. `acl` —— 扩展记忆命名空间 ACL
5. `guard` —— 执行期工具 guard

## 10. 示例

- `examples/hello-stdio/` —— 最小 stdio MCP server（零依赖）
- `examples/hello-http/` —— 最小 streamable-http MCP server（零依赖）

两个示例都会被 `test/ext-examples.test.js` 真跑：发 `initialize` / `tools/list` / `tools/call`，
断言工具真的能调。
