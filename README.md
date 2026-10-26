# dsh-roost

> 让 AI 通过 [Roost](https://github.com/tdcq9594/qq-bot-roost) 住进 QQ。
> DeepSeek Harness 插件，走 **QQ 官方接口**，不 hook 客户端、不违反协议。

---

## 致敬

这个项目的**整体设计思路来自 [Aurabot（dsh-aurabot-qq）](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)**
—— @accomplish07zrh-eng 写的一个「住在 QQ 里的 AI 伙伴」DSH 插件，约 9000 行。

没有它，我不会想到这些事：

| 从 Aurabot 学到的 | 说明 |
|---|---|
| **一个 QQ 会话 = 一个 DSH 会话** | `chatId → sessionId` 的映射，让每个群/每个人的上下文天然隔离 |
| **私聊 / 群聊两档 preset** | 群聊里**不给** shell、文件工具，只挂 QQ 工具。这个安全边界非常对 |
| **人格独占系统提示词**（`complete: true`） | 不带 DSH 那一大段编程助手身份和工具指南，否则私聊一轮要好几分钟 |
| **安全默认：总开关关 + 试运行** | 装上不会自己乱发消息，必须手动打开 |
| **工具定义尽量别改** | 改一次，DeepSeek 的前缀缓存就失效一次 |
| **`agent.ctx.tools.register` 按会话挂工具** | 工具只出现在该会话里，不污染全局 |
| **`agent.followup` + `sessions.flush` 投递** | DSH 里把外部消息喂给 AI 的正确姿势 |

**本项目与 Aurabot 的关系**：只借了上面这些**设计**，代码是重写的。
传输层从 OneBot v11（SnowLuma，hook 本机 QQ 客户端）换成 Roost（QQ 官方接口），
所以 Aurabot 里那批 OneBot 特有的东西（数字 QQ 号、base64 语音段、`get_group_list`）
这里一个都不需要。

Aurabot 是 MIT，本项目沿用 Roost 的许可（免费、禁商用）。如果你只是想用现成的，
**先去试试 Aurabot** —— 它比这个项目成熟得多。

---

## 和 Aurabot 的差别（为什么还要写一个新的）

不是「重写一遍更好」，是**传输层换了之后，能拿到的东西不一样**：

| | Aurabot（OneBot / SnowLuma） | 本项目（Roost / 官方接口） |
|---|---|---|
| 合规 | hook 本机 QQ，违反协议、有封号风险 | 官方开放平台，无风险 |
| 语音转文字 | SnowLuma 私有扩展 `fetch_ptt_text` | 官方 `asr_refer_text` |
| 语音文件 | 自己拉、自己转码 | 官方 `voice_wav_url`（已转好的 WAV） |
| 卡片消息 | 自己解析 `json` 段 | 官方 `ark` 结构化字段 |
| 引用回复 | `reply` 段 | `message_reference`（REFIDX） |
| 合并转发 | `get_forward_msg` 再拉一次 | 事件里直接给（`elements` 102） |
| Markdown / 按钮 / 指令面板 | 没有 | 官方支持 |
| 部署 | 要跑 SnowLuma + 本机 QQ 客户端 | 只要 Roost 一个进程 |

---

## 当前状态

**骨架阶段（0.1.0）**。Roost 侧的两个通道**已经实现**（框架 v0.8.0），
所以本插件现在能收到消息、能调官方接口。

| 依赖 | 状态 |
|---|---|
| `GET /api/stream` 推 `message` 事件 | ✅ Roost v0.8.0 |
| `POST /api/qq/call` 通用能力调用 | ✅ Roost v0.8.0 |
| `GET /api/qq/capabilities` 能力清单 | ✅ Roost v0.8.0 |

还差的（本仓库自己的活）：群聊分段回复、记忆、心情、语音。见
[`docs/接入说明.md`](./docs/接入说明.md) 与 Roost 的
[`docs/DSH-Aurabot适配方案-v2.md`](https://github.com/tdcq9594/qq-bot-roost/blob/master/docs/DSH-Aurabot适配方案-v2.md) 的 P2~P5。

**前提**：Roost 要 ≥ 0.8.0。

---

## 安装

前提：已经装好 Roost 并能正常收发消息（`npm start` 跑起来了、面板能打开）。

```bash
# 在 DSH 的插件目录里
git clone https://github.com/tdcq9594/dsh-roost.git
```

或者在 DSH 里用插件市场 / 本地插件入口指向这个目录。

装好后在面板里填 Roost 地址（默认 `http://127.0.0.1:8080`）和面板访问密钥，
**然后手动打开「启用」**——默认是关的。

---

## 配置

存在 `~/.dsh/dsh-roost/config.json`（可用 `DSH_ROOST_DATA` 改目录）。
面板接口：`GET/POST /roost/api/config`、`GET /roost/api/status`。

```jsonc
{
  "roost": {
    "baseUrl": "http://127.0.0.1:8080",
    "accessKey": "",      // 对应 Roost 的 webui.accessKey
    "bot": ""             // 多机器人时只接这一个
  },
  "chat": {
    "enabled": false,         // 总开关，默认关
    "replyWithoutAt": false,  // 群聊里理不理没 @ 的消息
    "maxReplyChars": 1500
  },
  "persona": {
    "name": "小栖",
    "text": "你住在 QQ 群里……",
    "rulesPrivate": "……",
    "rulesSocial": "……"
  }
}
```

---

## 结构

```
src/
  host.js     DSH 插件入口：连接管理、会话映射、工具挂载、面板接口
  roost.js    Roost 客户端：SSE 订阅 + 通用能力调用（可单独跑，自测连通性）
  tools.js    给 AI 的工具（L1 专用 / L2 通用 / L3 说明书）
  config.js   配置读写
cordis.patch.yml   bundle patch：插件挂载 + 两档 agent preset
```

单独测连通性：

```bash
ROOST_URL=http://127.0.0.1:8080 ROOST_KEY=你的密钥 node src/roost.js
```

---

## 许可

沿用 [Roost](https://github.com/tdcq9594/qq-bot-roost) 的许可：**永久免费，禁止任何形式的收费与商业使用**。
详见 [LICENSE](./LICENSE)。
