# 交接：把 aurabot 的「B 站」「生图」做成 dsh-roost 扩展

> 写于 2026-11-14 03:10。接手的人先读第 3 节（约束）再动手，能省掉一半返工。

## 0. 一句话

把 `dsh-aurabot-qq` 里内置的 **B 站模块**和**生图模块**，改写成两个 **dsh-roost 的 MCP 扩展**（`plugin.json` + `server.mjs`），功能对齐，而不是塞进宿主 `src/`。

## 0.5 相关方案在哪（先看这几份）

本任务没有单独的「总方案文档」——**本文档就是**。但底下有三层既有方案必须知道位置，否则会重复设计或踩到已定的口径：

| 文档 | 位置 | 什么时候看 |
|---|---|---|
| **扩展机制总方案** | `dsh-roost/docs/扩展机制方案.md`（1258 行） | **接手先读第 17 行「交接速览」**。§三 讲扩展本体（目录/清单/受管块），§四 讲权限与次数，§五 扩展记忆，§七 `/v1` 端点，§八 扩展仓库与一键安装 |
| 实施进度台账 | `dsh-roost/docs/实施进度.md` | 看 8 个阶段 + 门 G0–G7 各自结论、当前留了哪些待办 |
| 扩展接口契约 | `dsh-roost/docs/API.md` + `extension.d.ts` | **自动生成**（`npm run ext-docs`），改 `api-v1.js` 后必须重跑，`--check` 会抓漂移 |
| 与 aurabot 的功能对比 | `dsh-roost/docs/与Aurabot对比.md` | 判断「这个功能该不该做、我们差在哪」时的既有结论 |
| aurabot 弹幕设计 | `dsh-aurabot-qq-beta/docs/BILI-DANMAKU.md` | 做 B 站弹幕前必读（有平台限频与风控结论） |
| aurabot 模块教程 | `dsh-aurabot-qq-beta/docs/MODULE-TUTORIAL.md` | 想照抄它的模块结构时看 |
| 本任务方案 | **本文档** | 就是现在这份，含调研结论、已补能力、待做拆分 |

> `dsh-aurabot-qq-beta/HANDOFF.md` 是**向量记忆库**那摊的交接，与本任务无关，别被标题骗了。

## 1. 目标与验收

- **形态**：扩展。不走宿主内置，因为这两个能力都可以独立进程跑，且用户可能只想装其中一个。
- **对齐对象**：`C:\Users\q9079\WorkBuddy AI\workbody.work\dsh-aurabot-qq-beta`（1.3.0-beta.1）。稳定版 `dsh-aurabot-qq`（1.2.1）是旧一点的那份，**以 beta 为准**。
- **验收**：aurabot 前端那两页上的功能，在扩展侧都有对应能力（见 §2.1 清单）。
- **B 站写操作**：主人已确认**全做**（评论 / 回复 / 点赞 / 弹幕），但必须有 dry-run、每日上限、暂停开关。

## 2. 已完成

### 2.1 前端调研（结论，不用重看）

aurabot 前端是单文件 `client/client.js`，两个页面组件：

| 组件 | 行号 | 区块 |
|---|---|---|
| `Bili` | 7076 | 刷 B 站 / 怎么刷 / 评论回复分享 / 看画面 / 截图库 / ta 刷过什么 |
| `BiliDanmaku` | 7195 | 视频弹幕（检查视频、发送、历史） |
| `ImageGen` | 7962 | 让ta画图（4 种接法 + 备用接口链 + 构图尺寸 + 权限） |
| `PaintGallery` | 7855 | ta 的画作（画廊、打开文件夹、单张删除） |
| `CodexSub` | 7897 | Codex 订阅登录（实验性，可先不做） |

**B 站页字段全清单**：
- 刷 B 站：总开关、Cookie（`SESSDATA` / `bili_jct` 分框，可显示隐藏，整串粘贴自动拆）、扫码登录、检查登录
- 怎么刷：定时刷、间隔 1–24h、每天最多 0–12 轮、一轮 1–6 个、额外关键词（多行）、播放量门槛、只看最近 N 天
- 互动：主人 B 站昵称（@ 用）、自己发评论 + 每日上限、回评论 + 上限、分享给主人、提议发群（群号 + 每日上限）、顺手点赞
- 看画面：开关、每视频抽 2–12 帧、刷完顺手发截图概率、截图库上限、ffmpeg 路径、状态（ffmpeg 找没找到 / 已存几张）
- 截图库：25/页 + 加载更多、缩略图、单张删除
- 刷过什么：暂停原因、今日统计、`看看有没有人回ta` / `现在刷一轮`、历史（时间·类型·标题链接·摘要）
- 弹幕：允许发弹幕、刷完自己发、每日上限 1–20、视频/分P/秒数/文字/位置、检查视频（不发送）、发送、今日计数、历史（含平台原始响应）

**生图页字段全清单**：
- 接口格式四选：OpenAI 兼容 / 自定义（GET·POST、占位符 `{prompt}{model}{size}{width}{height}{image}`、参数键值表、bodyType、取值路径）/ Codex 订阅 / 官方推荐地址
- 失败自动切换：备用接口列表，可增删、上移下移、每条单独测试，openai 与 codex 可混排
- 出图：默认构图（让她选/方/竖/横/宽）、图片尺寸（含 2K/4K）、固定风格
- 权限与体验：`ownerOnly`、`img2img`（参考图改画）、`seeOwn`（画完自己看一眼）
- 画作：面板显示最近 1–50 张、打开文件夹、缩略图、单张删除、存图目录

### 2.2 宿主能力已补齐：`POST /v1/send`（提交 `e281291`）

**这是做这两个扩展的前提**，之前扩展画完图发不出去。

```
POST /v1/send        scope: message:write
Authorization: Bearer <扩展令牌>

{
  "scene": "c2c" | "group",
  "target": "<chatId>",
  "text":  "可选，一句话",
  "files": ["相对扩展目录的路径"],          // 可选，≤4 个
  "card":  { "title", "description", "url", "picUrl" },  // 可选，官方图文卡片
  "requestId": "可选幂等键"
}
→ 200 { ok, scene, target, text:{ok,id,message}|null, files:[{file,ok}], card:{ok,id,message}|null }
→ 400 参数/文件不合法（message 里有具体原因）
→ 403 群里没有 group_push 授权，或令牌没绑扩展却要发文件
```

要点：
- **文本与文件可同发**（先文本后文件）；**卡片独占一条**（一条消息只能一种富文本，有 card 就不发正文）。
- **卡片是官方 `msg_type=8`**（2026-10-28 新增，群聊/单聊都支持）。四字段必填，`title ≤50` 字、`description ≤200` 字、`url`/`picUrl` 必须 https 且 ≤1024。校验在宿主侧做（`tuwenProblem()`），因为平台只会回笼统的 `304061`。
- **文件只认扩展自己目录**：`<dataDir>/extensions/<extId>/` 下，`resolve` + `realpath` 双检（挡 `../`、软链、`bili-evil` 这种前缀相同的兄弟目录）。单文件 20MB，`.exe/.bat/.ps1` 等可执行后缀一律拒。
- 发文件走 `outActions`，去重 / 冷却 / 账本 `requestId` 都复用。

**扩展怎么知道自己目录**：宿主不给「数据目录」环境变量，只给 `ROOST_API_URL` / `ROOST_EXT_ID` / `ROOST_LAUNCHER_DIR`。用自己的模块路径：

```js
import { fileURLToPath } from 'node:url';
const SELF_DIR = fileURLToPath(new URL('.', import.meta.url));  // <extensions>/<id>/
// 存图 → path.join(SELF_DIR, 'out', 'x.png')
// 发图 → files: ['out/x.png']（相对路径，宿主拼成 <dataDir>/extensions/<id>/out/x.png）
```

## 3. 关键约束（必读，不读会返工）

### 3.1 扩展能力边界

宿主给扩展的 `/v1` 端点（scope 见 `docs/API.md`）：

| 端点 | 用途 |
|---|---|
| `POST /v1/send` | **发文本 / 文件 / 图文卡片**（本任务的主力） |
| `POST /v1/message` | 投递一句话进入站链路、跑一轮模型（不是发消息） |
| `POST /v1/say` | 让机器人主动说一句（仅文本） |
| `POST /v1/proactive` | 排一条主动消息（受清醒时段/频次约束） |
| `GET /v1/state` `mood` `context` `memory` | 只读 |
| `POST /v1/memory` `memory/ext.add` | 写记忆 |
| `session.*` / `agent.*` | 会话与独立 agent（扩展令牌一般拿不到 `agent:write`） |

**扩展不能**：直接调 QQ 官方 API（没有令牌）、读宿主内部数据、往会话发未经 `/v1/send` 的东西。

### 3.2 面板 UI：声明式，只读

宿主 `src/ext-ui.js` 支持扩展在 `plugin.json` 里声明一个页面：

```json
"ui": {
  "nav": { "label": "刷 B 站", "group": "express" },
  "view": { "kind": "cards", "source": { "file": "ui-data.json" }, "fields": [...] }
}
```

- 4 种形态：`table` / `cards` / `list` / `log`；7 种字段：`text / number / url / time / tag / image / progress`
- 一级菜单可自选：`home / self / express / group / power / mods / system`（默认 `mods`，B 站建议挂 `express`）
- 数据来自扩展目录内的 JSON（≤256KB、≤200 行），宿主**只读**，不执行扩展代码

**⚠️ 最大缺口：声明式 UI 没有交互。** 没有按钮、没有表单、没有「现在刷一轮」。

三个可选做法（推荐 A，后续再考虑 B）：

- **A. 动作走对话**：扩展把动作做成 MCP 工具（`bili_run` / `image_test`），用户在 QQ 里说「刷一轮 B 站」由模型调。零宿主改动，也符合「模型是操作者」的定位——aurabot 那些按钮本质就是「替用户发一句指令」。
- **B. 宿主补 `ui.actions`**：声明按钮 → 面板点击 → 宿主代调扩展的 MCP 工具。要改 `ext-ui.js` + `client.js` + 权限模型，工作量中等，**建议单独开一个任务**，不要和扩展开发混在一起。
- **C. 扩展自起 HTTP 端口**：面板直接打。要处理鉴权与端口冲突，不推荐。

### 3.3 配置项怎么来

扩展在 `plugin.json` 的 `config` 里声明字段（`string/number/boolean/select/array/object`，**没有 path/file**），宿主面板自动渲染表单并落盘：

- 非敏感 → `<dataDir>/extensions/<id>/config.json` → 子进程 env `ROOST_EXT_CONFIG`（JSON 字符串）
- 敏感（`secret: true`）→ `<dataDir>/secrets/<id>.config.json` → env `ROOST_EXT_SECRET_<KEY>`

所以：生图的 API Key、B 站的 Cookie 都用 `secret: true`，不要自己造存储。

### 3.4 并行开发（重要）

`dsh-roost` 现在有**多个窗口同时改**。本地未推送的 12 个提交里，只有 6 个是本任务线的：

```
e281291  feat(ext-api): /v1/send            ← 本任务
0093048  feat(6.1): 扩展卡片图片整宽         ← 别人
f7cf1c6  feat(6.1): 扩展声明式界面           ← 别人（但本任务要用它）
de3c2ac  feat: 自驱引擎                      ← 别人
3ec7bf5  feat(5.5): AI 润色                  ← 别人
748a195  test: 聊天图片缓存 e2e              ← 别人
5879cc6  fix(5.12): 未分类子目录删不掉       ← 别人
c3fd96a  422adaf 60b720e 22e5632 3ebd4e6    ← 本任务（批次 5 收尾）
```

**纪律**：只提交自己改的文件，别 `git add -A` 把别人的半成品带进来；改 `host.js` / `client.js` 这种大文件时先 `git log -1` 看有没有人刚动过，Edit 报「找不到旧字符串」先怀疑「别人改过了」。

## 4. 待做

### 4.1 生图扩展（建议先做，独立、收益直接）

目录：`qq-bot-roost-plugins/plugins/imagegen/`（新建）。参考实现：`dsh-aurabot-qq-beta/src/features/imagegen.js`（305 行）+ `paintings.js`（190）+ `image-shape.js`（26）+ `modules/imagegen/index.js`（191）。

- 工具：`image_gen({ prompt, shape?, refImage? })` —— 画完存 `<SELF_DIR>/out/`，再 `POST /v1/send { files: ['out/x.png'] }`
- 接法：先做 **OpenAI 兼容**（覆盖 90% 场景），再补自定义接口与备用链；**Codex 订阅可以不做**（实验性、依赖登录态）
- 配置：`baseUrl` / `apiKey`(secret) / `model` / `shape` / `size` / `stylePrompt` / `ownerOnly` / `img2img`
- 面板：`ui.view` 用 `cards` 展示最近画作（`ui-data.json` 由扩展自己写）
- 参考图：宿主消息里的图怎么拿到？见 `src/ext-api-hooks.js` 的 `context` / 宿主 payload 里的 `images` 字段，需要先确认

### 4.2 B 站扩展升级（写操作全做）

现状：`qq-bot-roost-plugins/plugins/bili/` 是 **0.2.0 只读版**（工具 `hot / weekly / search / video / up`，1214 行），已有 `ui.view` 卡片页。参考实现：`dsh-aurabot-qq-beta/src/bili/*.js`（2030 行）+ `modules/bili/index.js`（233）+ `danmaku.js`（195）。

分三步，每步可独立交付：

1. **登录 + 定时刷 + 截图**（只读增强）
   - Cookie 走 `config` secret；扫码登录参考 `src/bili/qr-login.js`
   - 定时刷：扩展进程常驻，自己 `setInterval`；「只在醒着时间刷」读 `GET /v1/state`
   - 抽帧看画面：需要 ffmpeg（`bili.ffmpegPath` 可配），参考 `vision.js`
   - 截图 → `POST /v1/send { files }`，或做成卡片
2. **分享成卡片**：刷到好视频 → `POST /v1/send { card: { title, description, url, picUrl } }`。这是新补的能力，**B 站场景的杀手功能**
3. **写操作**：评论 / 回复 / 点赞 / 弹幕。必须有：dry-run 开关、每日上限、登录失效暂停（`login-pause.js`）、失败原因回给用户

## 5. 参考实现位置速查

```
auraBot（对齐对象）
  src/bili/{api,danmaku,duty,group-share,login-pause,qr-login,shots,vision}.js
  src/modules/bili/index.js            ← 12 条 /bili/* 路由
  src/features/imagegen.js             ← 生图核心（provider / fallback / 参考图）
  src/features/paintings.js            ← 画作存储与画廊
  src/modules/imagegen/index.js        ← 11 条 /image/* 路由 + qq_draw_image 工具
  client/client.js:7076 / 7962         ← 两个页面的完整字段

dsh-roost（宿主侧）
  src/ext-api-hooks.js                 ← /v1/send 实现 + tuwenProblem + checkExtFile
  src/channel.js                       ← send({ card }) 分支
  src/api-v1.js                        ← V1_ROUTES / WIRED_HOOKS
  src/ext-ui.js                        ← 声明式 UI 的形态与字段白名单
  src/ext-config.js                    ← config 声明与 env 下发
  src/ext-wizard.js                    ← 新建扩展向导（生成骨架可参考）
  docs/API.md                          ← 扩展接口文档（npm run ext-docs 生成）

现有扩展（改造基础）
  qq-bot-roost-plugins/plugins/bili/   ← 0.2.0 只读版，有 ui.view 可复用
  qq-bot-roost-plugins/plugins/comfy-draw/  ← 本地画图扩展，可参考发图写法
```

## 6. 怎么验证

```bash
# dsh-roost 全量（当前基线 2339/2339）
cd douluo/dsh-roost && npm test

# 只跑这次新增的
node --test test/ext-api-hooks.test.js test/api-v1.test.js test/v1-live-endpoints.test.js

# 扩展文档一致性（改过 api-v1 / plugin.json 的 ui 或 config 就要跑）
npm run ext-docs && npm run ext-docs:check

# 插件仓：任何改动都要重跑索引，否则市场里是旧清单
cd douluo/qq-bot-roost-plugins && node scripts/build-index.mjs && node scripts/build-index.mjs --check
```

扩展本地调试：把它装进 `<dataDir>/extensions/<id>/`，重启 DSH 生效（stdio 扩展是宿主拉起的子进程，改完必须重启，热重载不会重拉）。

## 7. 纪律与已知坑

- **只本地提交，不推送、不发版**（主人 2026-11-14 明确要求）。`git commit` 即可，不 `push`、不 `npm publish`、不建 tag。
- 扩展是**独立进程**，`console.log` 会进宿主日志；别在热路径上打日志。
- `/v1/send` 的 `files` 是**相对扩展目录**的路径，不是绝对路径；绝对路径会被当成越界拒掉。
- 图文卡片的 `picUrl` 必须是 **https**。B 站封面（`i0.hdslb.com`）是 https，可以直接用；本地截图不行——本地图走 `files`，不要塞进卡片。
- 写操作（评论/弹幕）**默认关**，且要有 dry-run。aurabot 的教训是「登录失效 / 风控 / 频率限制不会因为登录成功而解除」，所以暂停逻辑要独立于登录状态。
- 声明式 UI 的数据文件是**扩展自己写**的 JSON，宿主只读。写的时候注意 ≤256KB、≤200 行，超了会被截断。
