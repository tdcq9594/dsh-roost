# dsh-roost

> [ai-chat](https://github.com/tdcq9594/qq-bot-roost-plugins) 插件的 **DSH 宿主**：
> QQ 消息推过来，交给 DSH 会话回答，再把回答送回去。

---

## 它是什么（以及不是什么）

```
QQ ⇄ Roost 内核 ⇄ ai-chat 插件 ⇄ POST /inbound ⇄ 本插件 ⇄ DSH 会话 ⇄ DeepSeek
                               ⇄ POST /reply  ⇄
```

**它不碰 QQ**。收消息、整形（语音 ASR / 引用 / 合并转发）、发消息、切段、
防吵（冷却 / 配额 / 认领）全在 ai-chat 那边。这边只做三件事：

1. 起一个固定端口的 HTTP 服务，等 ai-chat 推消息
2. 把消息喂给对应的 DSH 会话，等 AI 说完
3. 把回复发回 ai-chat 给的地址

**为什么要它**：ai-chat 直连模型时，AI 只有「聊天」这一件事。
挂到 DSH 上之后，它能用 DSH 的工具（文件、命令）、记忆、上下文压缩——
这是 `adapter: dsh` 唯一的价值，也是它比直连贵的地方。

---

## ⚠️ 先看这条

**群聊默认也给本地工具（shell / 文件）。**

也就是说，群里**任何人**都能通过对话让 AI 读这台机器上的文件、执行命令。
不是「理论上」——问一句「帮我看看 ~/.ssh 里有什么」就行。

这是明确选的默认值。想收紧：

- 面板「设置 → 群聊也给本地工具」关掉（或 `config.json` 里 `chat.toolsInGroup: false`）
- 关掉后群聊会话只剩聊天能力，私聊不受影响

---

## 装

前提：
1. Roost ≥ 0.8.1 跑着
2. 装了 `ai-chat` 插件（v3.0.0+），适配器选 `dsh`

```bash
git clone https://github.com/tdcq9594/dsh-roost.git
```

在 DSH 里指向这个目录装。装好后侧栏会出现「**Roost**」入口。

---

## 面板（侧栏 → Roost）

| 标签 | 内容 |
|---|---|
| **状态** | 监听端口、是否在跑、密钥是否设置、连了几个 QQ 会话、正在等几个、最近一轮耗时 |
| **会话** | 每个 QQ 会话对应的 DSH 会话，可以「清空」（下一句重建会话） |
| **设置** | 端口、共享密钥、群聊是否给工具、超时、人格（名字/人设/私聊追加/群聊追加） |

改完点保存，服务会自动重载——不用重启 DSH。

---

## 配置

存在 `~/.dsh/dsh-roost/config.json`（可用 `DSH_ROOST_DATA` 改目录）。

```jsonc
{
  "server": {
    "port": 17321,        // ai-chat 的「DSH 地址」默认指向这里，两边要一致
    "token": ""           // 共享密钥；留空表示不校验（只绑本机时可行）
  },
  "chat": {
    "toolsInGroup": true, // ⚠️ 群聊是否给本地工具
    "turnTimeoutSec": 150 // 要小于 ai-chat 那边的 180 秒
  },
  "persona": { "name": "小栖", "text": "…", "rulesPrivate": "…", "rulesSocial": "…" }
}
```

**两边的地址要对上**：ai-chat 的「DSH 地址」= `http://127.0.0.1:<port>`。

---

## 结构

```
src/
  host.js      插件入口：起服务、会话映射、面板接口
  server.js    HTTP /inbound（鉴权、立刻 200、回话）
  sessions.js  chatId → DSH 会话（存盘）
  turn.js      跑一轮：投递 + 从 session/event 等结果
  inbound.js   payload → 给 AI 看的一段话
  config.js    配置读写
client/
  client.js    侧栏面板（React，沿用 DSH 主题变量）
cordis.patch.yml  两档 preset（私聊 / 群聊）
```

**核心技术点**：DSH 没有「发一句返回一句」的接口，是事件驱动的。
`turn.js` 监听 `session/event`，收 `assistant/message`（可能来多次，取最后一次）
和 `turn/end`（`reason.kind === 'completed'` 才算说完）。

---

## 测试

```bash
npm test
```

21 条，覆盖整形、会话映射、HTTP 契约（立刻 200 / 鉴权 / 健康检查）、
回话的 SSRF 防护、一轮的状态机（多段取最后、非正常结束报错、同会话不许并发）。

---

## 致敬

角色设计参考了 [Aurabot（dsh-aurabot-qq）](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)：
一个 QQ 会话对一个 DSH 会话、人格独占系统提示词、安全默认、按会话挂东西、
用 `agent.followup` + `sessions.flush` 投递、从 `session/event` 取回复。

**传输层完全不同**：Aurabot 走 OneBot（SnowLuma，hook 本机 QQ 客户端），
这里走 ai-chat 插件（Roost 官方接口）。所以 Aurabot 里那批 OneBot 特有的东西
（数字 QQ 号、base64 语音段）这里一个都不需要。

如果你只是想用现成的，**先去试试 Aurabot**——它比这个项目成熟得多。

---

## 许可

沿用 [Roost](https://github.com/tdcq9594/qq-bot-roost) 的许可：**永久免费，禁止任何形式的收费与商业使用**。
