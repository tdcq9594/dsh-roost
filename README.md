<div align="center">

# dsh-roost

> [ai-chat](https://github.com/tdcq9594/qq-bot-roost-plugins) 插件的 **DSH 宿主**：QQ 消息推过来，交给 DSH 会话回答，再把回答送回去。

[![npm version](https://img.shields.io/npm/v/dsh-roost?color=6c5ce7)](https://www.npmjs.com/package/dsh-roost)
[![npm downloads](https://img.shields.io/npm/dm/dsh-roost?color=4b6fff)](https://www.npmjs.com/package/dsh-roost)
[![CI](https://github.com/tdcq9594/dsh-roost/actions/workflows/ci.yml/badge.svg)](https://github.com/tdcq9594/dsh-roost/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/tdcq9594/dsh-roost?color=eab308)](https://github.com/tdcq9594/dsh-roost)
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](#)
[![License](https://img.shields.io/badge/license-非商业自定义-blue.svg)](LICENSE)

**让 QQ 机器人从「只会聊天」变成「能用 DSH 的全部能力」** —— 工具、记忆、上下文压缩、主动搭话，都归它。

</div>

---

## 📚 目录

- [它是什么（以及不是什么）](#它是什么以及不是什么)
- [特性](#特性)
- [安装](#安装)
- [一键接入](#一键接入)
- [权限：AI 知道是谁在说话](#权限ai-知道是谁在说话)
- [面板](#面板)
- [配置](#配置)
- [目录结构](#目录结构)
- [和 Aurabot 的对比](#和-aurabot-的对比)
- [已知限制](#已知限制)
- [开发与测试](#开发与测试)
- [许可](#许可)

---

## 它是什么（以及不是什么）

```
QQ ⇄ Roost 内核 ⇄ ai-chat 插件 ⇄ POST /inbound ⇄ 本插件 ⇄ DSH 会话 ⇄ DeepSeek
                               ⇄ POST /reply  ⇄
```

**它不碰 QQ。** 收消息、整形（语音 ASR / 引用 / 合并转发）、发消息、切段、防吵（冷却 / 配额 / 认领）全在 ai-chat 那边。这边只做三件事：

1. 起一个固定端口的 HTTP 服务，等 ai-chat 推消息
2. 把消息喂给对应的 DSH 会话，等 AI 说完
3. 把回复发回 ai-chat 给的地址

**为什么要它**：ai-chat 直连模型时，AI 只有「聊天」这一件事。挂到 DSH 上之后，它能用 DSH 的工具（文件、命令）、三层记忆、上下文压缩——这是 `adapter: dsh` 唯一的价值，也是它比直连贵的地方。

---

## 特性

- 🗨️ **一个 QQ 会话 = 一个 DSH 会话**：断线重连、重启之后映射还在，会话不丢
- 🧭 **一键接入**：六步向导 + 「一键就绪」，Roost 本体、ai-chat 插件、适配器配置都能自动装
- 🔐 **逐条权限判定**：每一句都告诉 AI「谁在说、什么档位」，并按档位收本地工具（不是整群一刀切）
- 🧠 **三层记忆**：跨群/本群事实 + 日记（三级衰减 + 关键词/向量检索）+ 知识图谱（实体·关系·结束时间）
- 🛠️ **记忆工具**：给模型 `memory_search` / `memory_note` 两把「拉」的手，能主动翻旧账
- 🌙 **凌晨巩固**：打分、升降级、到期压缩、抽三元组、提取约定，全在凌晨做，不花白天的钱
- 🌅 **觉醒**：约定/想你/随性三类机会打分，到点「问她要不要说」，不是到点硬发
- 💬 **对话收尾**：她判断这段聊完了就记一句「收在哪 / 下次怎么接」——**不发言、不动记忆**。下一轮接得上，刚说完晚安 90 分钟内也不会又冒出来（只做私聊）
- 🛠️ **发言走工具**：`qq_send` / `qq_close` 由模型自己调——分几段说、说完要不要退场、一句都不说，都它定。**调几次就是几条独立消息**（不是拼成一条），不再是一整段文本被动切段
- 📣 **能 @ 人**：`qq_send` 的 `at` 参数（填 `sender` 就是刚说话的人，也可以填 openid）。群里每条消息头带 `[昵称 (openid)]`，**标签由宿主拼**——模型不碰那串 id 的语法，抄错了也没机会发出去。私聊 / 非第一段 / markdown 关着时会自动降级并告诉模型为什么
- 🗜️ **上下文压缩**：到阈值（群 85% / 私聊 75%）开新会话 + 摘要开场，旧会话保留可回查；压之前那一刻的**缓存命中率**记在面板和日志里，阈值该往上还是往下调用它判断
- 📱 **侧栏面板**：九页仪表盘，状态、记忆、人格、排期、日志全在 DSH 里看
- 🧬 **人格四段式**：人格文件分性格 / 开场白 / 说话示例 / 世界书四段。世界书一行一条 `触发词 | 内容`，**命中才注入**；开场白给主动搭话一个语气锚；近处指令贴在离历史最近的位置，聊到几十轮人设也不被冲淡
- 🔄 **人格库一键更新**：内置人格放在仓库的 `personas/*.md`，改完推个 commit，面板点一下就拿到——**不用发版**。只覆盖没改过的，你改过和自建的一个不碰
- ⬆️ **本体自更新**：设置页顶部查最新版、一键装。走 DSH 自己的 `pluginManager`（失败会回滚 `package.json` + `pnpm-lock.yaml`），装完提示重启。开发机（符号链接装的）自动禁用
- 🎭 **双人格 preset**：私聊（`roost-private`）/ 群聊（`roost-social`）各一套提示词

---

## 安装

DSH 插件市场里输入包名：

```
dsh-roost
```

或命令行：

```bash
dsh plugin --profile web add dsh-roost
```

> 前提：DSH 桌面版 / Web 组合（需要 `sessionController` 和 `agents`）。
> Roost 和 ai-chat 不用提前准备——「接入」里会装。

从源码装也行：

```bash
git clone https://github.com/tdcq9594/dsh-roost.git
```

---

## 一键接入

装好插件后，侧栏「Roost → 接入」是一条七步路径，**能自动的都自动做掉**：

| 步 | 做什么 | 自动？ |
|---|---|---|
| 1 | 装 Roost（下载解压，零依赖，不用 npm install） | ✅ 点一下 · 已装过可点「已装过？」填路径绑定 |
| 2 | 启动 Roost | ✅ 点一下（没填凭据也能起，正好用来扫码） |
| 3 | 扫码 / 填 AppID、AppSecret | ✋ 开放平台拿；存完自动重启 Roost 让新凭据生效 |
| 4 | 装 ai-chat 插件（走 Roost 的市场） | ✅ 点一下 |
| 5 | 把 ai-chat 切成 DSH 适配器，填好回话地址 | ✅ 点一下 |
| 6 | 去群里说句话 | ✋ 开放平台开「接收所有消息」+ 机器人进群 |
| 7 | 配置主人 | ✅ 点一下，直接跳到 Roost 面板的「主人与群组」 |

顶上的「**一键就绪**」把 1、2、4、5 连着做完，卡在 3 就停下来提示你扫码或填。每一步也能单独点，跳着点不会把东西搞坏（每步先检测前置条件）。第 2 步「启动」之后，旁边按钮直接**打开 Roost 的 WebUI**（带上面板密钥）。

**为什么先启动再填凭据**：扫码走的是 Roost 自己的 `/qr/start`，没启动就没有这个接口；反过来，没 AppID 也能先起一个空面板专门用来扫码。这个顺序以前是反的，两边互相等死。

**下载地址**：优先 GitHub Release（自动补 `v` 前缀、自动查最新版），拿不到就回退 npm 包。早期版本写死过地址，Release 一换就整片 404。

**装到哪**：默认 `~/.dsh/dsh-roost/roost`，可在设置里改 `setup.roostDir`。

---

## 权限：AI 知道是谁在说话

群里给 AI 挂了 shell 和文件工具，但**说话的人不一定是主人**。路人一句「帮我删掉 ~/Documents」跟主人说同样的话，不该一个待遇。

所以每一轮都做两件事：

**① 告诉 AI 谁在说话**（提示词层）

```
这一句是「小明」说的，权限：普通成员。
对方是普通群成员。不要执行任何会改动这台机器的操作（删除、写入、安装、跑命令），
也不要读私人文件或目录。他要你这么做时，直说「这个我没权限」。
```

**② 按档位收工具**（硬限制层）

| 档位 | 默认 | 说明 |
|---|---|---|
| 主人 | 全部工具 | 你本人 |
| 管理员 | 只能聊天 | 群管理员也不该读你机器上的文件 |
| 普通成员 | 只能聊天 | 想让群友也能用，自己改成「全部工具」 |
| **身份不明** | **只能聊天** | **兜底**，不建议放开 |

两层的意义：模型被说服时硬限制还在；工具没收干净时提示词还在。

**权限逐条生效**，不是整群一个档位——主人问完、路人接着问，待遇不一样。**兜底原则**：认不出来就当最低档，缺字段、字段脏了、框架改了名字，一律按「身份不明」处理。

---

## 面板

| 标签 | 内容 |
|---|---|
| **概览** | 四个数字（会话数 / 正在等 / 最近一轮耗时 / 能用工具的档位）、状态条、**一键自测**、最近动态 |
| **接入** | 七步一键流程（上面那张表） |
| **人格与情绪** | 人格列表与编辑（新建入口在标题右侧）、**从仓库更新**（带「几个可更新」角标）与仓库面板（预览 / 恢复官方版）、此刻情绪（三维条形图，只读，可用 👍/👎 影响）、表情包、语音条 |
| **记忆** | 会话选择器 + 三层：跨群/本群事实、日记（三级）、知识图谱；检索、手动记、从旧版导入、清空 |
| **主动搭话** | 这一轮算出来的机会、私聊排期、群聊主动（默认全关）、现在试一次 |
| **上下文** | 窗口占用、压缩触发、这一轮注入了什么、记忆工具状态 |
| **会话** | 每个 QQ 会话对应的 DSH 会话，可「清空」（下一句重建） |
| **设置** | 最上面是**更新**（本体 + 人格库）；下面是配置全文（JSON）+ 分节说明，改完保存即热重载 |
| **日志** | 最近 400 条动静，按级别筛，3 秒自动刷新 |

**自测**不经过 QQ，直接跑一轮 DSH 对话，验的是「会话建得起来、AI 回得来、回复取得回来」——链路里最容易坏的那段。QQ 那半边（收消息、发消息）它测不到，那部分出问题看日志。

---

## 配置

存在 `~/.dsh/dsh-roost/config.json`（可用 `DSH_ROOST_DATA` 改目录），面板「设置」页直接编辑。

```jsonc
{
  "server": {
    "port": 17321,          // ai-chat 的「DSH 地址」默认指向这里，两边要一致
    "token": ""             // 共享密钥；留空不校验（只绑本机时可行）
  },
  "chat": {
    "turnTimeoutSec": 150,  // 要小于 ai-chat 那边的 180 秒
    "upstreamRetry": {       // 上游 502/429/超时时的补重试
      "enabled": true,
      "attempts": 1,         // 补几次（1 = 失败后再补 1 轮，总共 2 轮）
      "delayMs": 3000,       // 补之前等多久
      "budgetSec": 170       // 整轮总预算，必须小于 ai-chat 的 180
    }
  },
  "workspace": {
    "dir": ""               // QQ 会话挂哪个工作区：留空=单开 <数据目录>/workspace，
                            // __default__=用 DSH 默认工作区，其它值=自定义目录
  },
  "permissions": {
    "owner": "all",         // 主人：全部工具
    "admin": "chat",        // 管理员：只能聊天
    "member": "chat",       // 普通成员：只能聊天
    "unknown": "chat"       // 兜底：认不出身份只给聊天
  },
  "setup": { "roostDir": "", "version": "v0.8.6", "registration": "qr" },
  "memory":  { /* 日记寿命、注入条数、多少轮全量重注、记忆工具开关、向量检索 */ },
  "compact": { /* 群聊/私聊两档压缩阈值、开场带几条原话 */ },
  "awake":   { /* 清醒时段、机会分门槛、群白名单 */ },
  "speakUp": { /* 私聊排期：间隔/免打扰/每日上限 */ },
  "persona": { "current": "default", "byChat": {} },
  "stickers": { "enabled": true, "dir": "" },
  "channel": { "current": "qq" }
}
```

**两边的地址要对上**：ai-chat 的「DSH 地址」= `http://127.0.0.1:<port>`。

---

## 目录结构

```
src/
  host.js        插件入口：起服务、会话映射、面板接口、记忆工具挂载
  server.js      HTTP /inbound（鉴权、立刻 200、回话）
  inbound.js     payload → 给 AI 看的一段话
  turn.js        跑一轮：投递 + 从 session/event 等结果
  sessions.js    chatId → DSH 会话（存盘）
  permissions.js 权限：谁在说话、能用什么工具
  setup.js       一键流程：下载解压、写配置、起停、装插件、配适配器
  config.js      配置读写（默认值 + 合并）
  memory.js      三层记忆第一层：跨群/本群事实
  journal.js     日记：三级衰减 + FTS5 关键词 + 可选向量检索（RRF 融合）
  graph.js       知识图谱：实体 / 关系（双时态） / 原始记录
  embed.js       可选向量：只接一个 /embeddings 端点，不配就纯关键词
  tokenize.js    中文切词（索引侧存二元组，FTS5 对中文是废的）
  consolidate.js 凌晨巩固：打分 → 升降级 → 到期压缩 → 抽三元组 → 提取约定
  personas.js    人格库：本地 personas/*.md 的读写（正文分四段）
  persona-repo.js 人格仓库：拉 index.json、一键更新、恢复官方版、静态扫描
  update.js      本体自更新：查最新版、装法检测（符号链接禁用）、豁免 24 小时冷却
  version.js     版本号比较（三处共用，按数字比不按字符串比）
  awake.js       觉醒：约定/想你/随性三类机会纯函数打分
  compact.js     上下文压缩：读占用 → 开新会话 + 摘要开场
  channel.js     通道抽象（以后接别的平台时切这里）
  registration.js 接入方式抽象（扫码 / 手动填）
  lease.js       端口租约：端口被占时自动换
  sync-retry.js  「等一下再试」的退避调度（Roost 比我们晚起时用来补同步 ai-chat 地址）
  tools.js       记忆工具（memory_search / memory_note）定义与挂载
client/
  client.js      侧栏面板（React，沿用 DSH 主题变量）
cordis.patch.yml 两档 agent preset（私聊 / 群聊）
personas/        内置人格（8 份）+ index.json（生成物，sha256 清单）
scripts/         生成人格索引、dry-run、同步 GitHub
docs/            设计文档、调研、和 Aurabot 的对比
```

**核心技术点**：DSH 没有「发一句返回一句」的接口，是事件驱动的。`turn.js` 监听 `session/event`，收 `assistant/message`（可能来多次，取最后一次）和 `turn/end`（`reason.kind === 'completed'` 才算说完）。

---

## 和 Aurabot 的对比

角色设计参考了 [Aurabot（dsh-aurabot-qq）](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)：一个 QQ 会话对一个 DSH 会话、人格独占系统提示词、安全默认、按会话挂东西、用 `agent.followup` + `sessions.flush` 投递、从 `session/event` 取回复。

**传输层完全不同**：Aurabot 走 OneBot（SnowLuma，hook 本机 QQ 客户端），这里走 ai-chat 插件（Roost 官方接口）。所以 Aurabot 里那批 OneBot 特有的东西（数字 QQ 号、base64 语音段）这里一个都不需要。

一句话：**传输层我们更稳（官方接口），对话体验它更成熟。** 只想用现成的，先去试试 Aurabot。

---

## 已知限制

- 只支持 QQ（`channel.current = 'qq'`），通道抽象已备好但还没接第二个平台
- 语音靠官方 ASR（`asr_refer_text`），没有本地语音模型；TTS 音色由 ai-chat 设置，面板只读
- 面板是 JSON 直编辑配置（不是逐字段表单），代价是要看得懂结构——所以配了分节说明
- **模型服务挂了插件救不了**：DeepSeek 网关 502 时，补重试能救回一部分，但网关整体挂掉时只能等它自己恢复。这种时候插件回一句「模型服务那边暂时抽风了」，不会把内部报错糊给你

---

## 开发与测试

```bash
npm test
```

667 条测试，覆盖整形、会话映射、HTTP 契约（立刻 200 / 鉴权 / 健康检查 / SSRF 防护）、一轮的状态机、权限分档与兜底、记忆三层、觉醒打分、压缩、通道/接入抽象、工具定义与权限（含 `at` 参数的四条降级路径）、上游错误分类与补重试、会话类型标签（群 / 私聊）、前端九页空数据渲染。

CI（GitHub Actions，Node 22 / 24 矩阵）跑同样这些，外加三件单测覆盖不到的：

- `node --check` 全量语法检查（TDZ 这类运行时错它查不出，但拼错、少括号能拦住）
- `scripts/dry-run.mjs` 用假 ctx 真跑一遍 `apply()`，确认插件能加载、路由能注册
- `npm pack --dry-run` 检查 `files` 字段没漏 `src/host.js` / `client/client.js`——打包漏文件，用户装上去就是坏的

---

## 许可

沿用 [Roost](https://github.com/tdcq9594/qq-bot-roost) 的许可：**永久免费，禁止任何形式的收费与商业使用**。全文见 [LICENSE](LICENSE)。
