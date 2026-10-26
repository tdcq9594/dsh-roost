# DSH 分支方案

> 目标：把 `dsh-roost` 从「自己去连 Roost 的客户端」改成「被 ai-chat 推消息的宿主」。
>
> 依据：Roost **v0.8.1** + ai-chat 插件 **v3.0.0** 的宿主协议。

---

## 一、角色变了，代码要砍一半

v1 的设想是：DSH 插件自己订阅 Roost 的 SSE、自己调 `/api/qq/call`、自己注册 QQ 工具。

现在 **ai-chat 插件已经把 QQ 那一半全包了**：收消息、整形（ASR/引用/合并转发）、
发消息、切段、防吵（冷却/配额/认领）。DSH 这边再连一次 QQ 就是重复劳动。

所以职责收窄成一句话：**接一条消息 → 喂给 DSH 会话 → 把回复回过去。**

| v1 的东西 | 现在 | 为什么 |
|---|---|---|
| `src/roost.js`（SSE 客户端） | **删** | 消息由 ai-chat 推进来，不用自己订阅 |
| `src/tools.js`（qq_send / qq_api 等） | **删** | 发消息是 ai-chat 的事；AI 只要回文本 |
| `src/host.js`（连接管理 + 会话 + 工具挂载） | **重写** | 变成一个 HTTP 宿主 |
| `cordis.patch.yml`（私聊/群聊两档 preset） | **留** | 群聊不给本地工具这条边界要保住 |
| `src/config.js` | **改** | 字段从「Roost 地址」变成「监听端口 + 共享密钥」 |

---

## 二、架构

```
QQ 官方
  ⇅
Roost 内核（网关 / 限频 / 47 接口）
  ⇅  ctx.on('message')
ai-chat 插件（按群开关，自己判断接不接话）
  │  POST /inbound   ─────────────→  dsh-roost
  │  ←──────────────  POST /reply
  ⇅
DSH 会话（每群一个，social preset 不给本地工具）
  ⇅
DeepSeek
```

DSH 在这个链路里**不碰 QQ**，只做一件事：把一段话变成 DSH 的一轮对话，把回答交回去。

---

## 三、协议（照着 ai-chat 的约定实现）

### 收：`POST http://127.0.0.1:17321/inbound`

```jsonc
{
  "id": "evt_01H...",
  "chat": { "kind": "group", "chatId": "B2C3...", "name": "测试群", "groupId": "B2C3..." },
  "sender": { "id": "A1B2...", "name": "小明" },
  "text": "看图",
  "quoted": "",
  "attachments": [ { "type": "voice", "asrText": "你好", "wavUrl": "https://...wav" } ],
  "elements": [],
  "history": [ { "role": "user", "content": "..." } ],
  "reply": { "url": "http://127.0.0.1:8080/api/plugins/ai-chat/r/reply",
             "token": "一次性令牌", "expiresAt": 1761456300000 },
  "adapter": "dsh"
}
```

**收到就立刻回 200**（别等 AI 想完再回——ai-chat 那边等的是 `/reply`，不是这个响应）。

### 回：`POST {reply.url}`

```jsonc
{ "id": "evt_01H...", "token": "一次性令牌", "text": "看到了，是只猫。", "done": true }
```

- `done: false` 表示「还有后续」，可以分几段回（AI 先应一句再给正文时用）
- 不传 `done` 当作 `true`
- **必须在 ai-chat 的超时（180 秒）之前回**，否则用户会看到「宿主没回话」

---

## 四、拿 AI 的回复：`session/event`

这是整件事的技术核心。DSH 给了一个事件流：

```js
ctx.on('session/event', (session, event) => {
  if (event.type === 'assistant/message') { /* event.data.message 里是这一轮的话 */ }
  if (event.type === 'turn/end') { /* event.data.reason.kind === 'completed' 才算说完 */ }
});
```

所以一轮对话是：

```js
// 1. 投递
await agent.followup({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'roost' } })
await ctx.sessions.flush(agent.session)

// 2. 等这一轮结束
//    assistant/message 收集文本（可能多次，取最后一次）
//    turn/end 且 reason.kind === 'completed' → resolve
//    turn/end 但 reason 不是 completed → reject（AI 被中断 / 出错）

// 3. 回话
await fetch(payload.reply.url, { method:'POST', body: JSON.stringify({ id, token, text, done: true }) })
```

**注意**：`assistant/message` 可能来好几次（工具调用前后各一次），
要取**最后一次**的文本，并且忽略 `data.interrupted` 的那些。

---

## 五、会话与人格

沿用 Aurabot 的设计（这套是对的）：

- **一个 QQ 会话 = 一个 DSH 会话**，`chatId → sessionId` 存盘
- **两档 preset**：
  - `roost-private`（私聊）：完整工具 + 人格
  - `roost-social`（群聊）：**不给 shell / 文件工具**，只有人格
- 人格用 `agent.ctx.systemPrompt.context()` 注入，配置改完下一轮生效

为什么不给群聊本地工具：群里是陌生人，能读文件、能执行命令的 AI 是个洞。
这一条不能省。

---

## 六、端口与安全

| 项 | 方案 | 理由 |
|---|---|---|
| 监听地址 | `127.0.0.1` 写死 | 只给本机的 ai-chat 用，不对外 |
| 端口 | `17321`（可配） | ai-chat 的 `DSH 地址` 默认就是这个，两边要对上 |
| 鉴权 | 可选共享密钥（`X-Roost-Token` 头） | 同机时风险低；跨机部署必须开 |
| 回话地址校验 | 只允许 `http://127.0.0.1` / `http://localhost` | 防止被当成 SSRF 跳板 |

**为什么自己起 http server 而不是用 `ctx.webServer`**：DSH 面板端口是随机的，
ai-chat 需要一个**固定地址**才能找到宿主。所以自己 `createServer` 监听固定端口。

---

## 七、代码结构（改完的样子）

```
dsh-roost/
  src/
    host.js        插件入口：读配置、起服务、生命周期
    server.js      HTTP /inbound + 回话 + 鉴权
    sessions.js    chatId → DSH 会话（建、复用、存盘）
    turn.js        投递一轮 + 从 session/event 里等结果
  cordis.patch.yml 两档 preset（沿用）
  config.js        端口 / 密钥 / 人格
```

比现在少两个文件（roost.js、tools.js），多两个（server.js、sessions.js、turn.js）。

---

## 八、分期

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **D1** | 起服务 + 会话映射 + 一轮对话跑通 | 群里说一句，DSH 回一句 |
| **D2** | 人格注入 + 两档 preset 生效 | 群里没有本地工具，私聊有 |
| **D3** | 健壮性：超时、并发（同群串行）、AI 出错也要回话 | 故意让 AI 报错，用户能看到一句人话而不是干等 |
| **D4** | 面板：连了几个群、最近几轮耗时、手动清会话 | 不用看日志也能知道状态 |

---

## 九、发现一个协议缺口（要顺手补）

ai-chat 的 `hostPayload` 里，`text` 是**原始 `msg.content`**，
语音/引用/合并转发这些在 `attachments` / `elements` 里分开给。

结果是**每个宿主都要自己写一遍整形逻辑**（把 ASR 拼进文本、把引用标注出来）。
这跟「宿主协议」的初衷相悖——宿主应该尽量笨。

建议 ai-chat 补一个字段：

```jsonc
{ "text": "看图",                    // 原始输入，保留
  "rendered": "看图\n（语音，转成文字是：你好）",   // 新增：整形好的，宿主直接用
  ... }
```

宿主优先用 `rendered`，没有就退回 `text`。这样 DSH 这边一行都不用写整形。

---

## 十、需要你拍板

1. **端口用 17321 行不行？**（ai-chat 的 `DSH 地址` 默认值，两边得一致）
2. **要不要共享密钥？** 同机可以不设；你要是打算以后跨机跑，现在就加。
3. **群聊里 DSH 的本地工具**：我按「不给」设计（social preset）。你确认一下。
4. **回复分段**：默认一次性回（ai-chat 那边负责切段）。要不要支持「先应一句再给正文」？
