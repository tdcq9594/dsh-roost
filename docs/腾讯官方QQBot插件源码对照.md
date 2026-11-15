# 腾讯官方两个 QQ Bot 插件 · 源码对照报告

> 调研日期：2026-11-15
> 对象：`tencent-connect/dsh-qqbot`（main，0.5.5）、`tencent-connect/openclaw-qqbot`（main，2.0.4）
> 方法：逐份读取 **main 分支实际源码**（`raw.githubusercontent.com`）并与本地三仓源码交叉核对。README / CHANGELOG 只当线索，**凡与源码冲突一律以源码为准**。
> 本报告只回答一件事：哪些实现值得我们搬，哪些不能搬，依据是什么。
> 修订 v3：两路深挖查证均延迟送达，已全部整合（v2 只含 `dsh-qqbot` 一路）。`oc-src` 用 GitHub API tree 拉取了 main 全量 83 个 `.ts`，并额外抓 **v1.6.6 tag** 补齐 main 已移除的旧版文件；本地副本留在 `workbody.work/qqbot_src/`（`files/src/` 94 个 .ts、`v166_*.ts`、`root/tests/`），关键结论已由主 agent 抽查复核。
> **版本前提（影响所有数值）**：openclaw main 是 **v2.0.4**；2.0.0（2026-07-13）做了「模块化分层架构」重构，分片上传 / 上传缓存 / 独立消息队列 / 音频转码 / Ed25519 派生 / quoteRef 等**下沉到 SDK `@tencent-connect/qqbot-nodejs`**，插件层只剩调用。凡标「v1.6.6 tag」的数值是真实源码但**不是 main**，README 里的 20/30/100MB、每日 2GB 等是 v1.6.6 时代能力的描述，不能当 main 常量。

---

## 0. 结论摘要

我们是「Roost 框架直连 QQ 官方 API → 外接协议 `roost-host/1` → dsh-roost 插件」三层；两家官方插件都是「一个插件 + 官方 SDK 直连」。**底层我们更深，中层互有胜负，差距集中在插件层的交互与工程细节。**

| 优先级 | 事项 | 一句话依据 | 动作 |
|---|---|---|---|
| **P0-1** | 会话映射持久化并发安全 | `sessions.js` 整文件覆盖写；官方 `prefs-store.ts` 有原子写 + 写前合并 + 墓碑 + 损坏备份 | 抄实现，改 `sessions.js` |
| **P0-2** | DSH 审批 / 提问 seam 桥到 QQ 按钮 | 我方全仓无 `approval/request` / `ask_user_question`；两家都有完整通道 | 抄 dsh-qqbot 形态 |
| **P1-1** | 中间件编排顺序与配对码前置 | `middleware-setup.ts` 12 层洋葱，配对码必须先于访问控制，命令/问答必须先于并发门 | 抄顺序，不抄 SDK 调用 |
| **P1-2** | 自助命令 | `/bot-ping` 拆网络/插件耗时、`/bot-me` 查 openid、命令进 AI 队列前拦截 | 低成本补齐 |
| **P1-3** | 下载 SSRF 防护 | `ssrf-guard.ts` 有，但有可绕过的缺口 | 抄思路，补严 |
| **P1-4** | 配置写入保真 | 我方 `config.js` 也是整文件覆盖 | 抄保真编辑 |
| **P2** | 放开引用 500 字截断 / 引用媒体摘要 / 回复自动挂引用 | 主链路完整；openclaw 全文注入，dsh-qqbot 的 SDK 也只给 500 | 可选 |
| **不抄** | 传输层调用、架构分层、ref-index 索引、热更新 | 见 §4 | — |

**必须纠正的旧结论**（前几轮调研里说过，源码核验后修正）：

1. 「引用上下文是明确缺口」——**错**，链路完整。但「我们截 500 字不是差异」这句**只对 dsh-qqbot 成立**：它调 SDK `quoteRef({maxSize:500})`；openclaw **插件层不截断、全文注入** `quote.text`（1.6.2 起移除 `MAX_CONTENT_LENGTH`）。所以对 openclaw 而言，500 字截断是**真实差异**，已升回 P2。详见 §3.5。
2. 「端点覆盖 47/50」——**过期**。实跑 `OFFICIAL_ENDPOINTS.length = 56`、`missing api = 0`、45 条唯一 path。
3. 「openclaw 审批不校验点击者身份」——**错**。按钮层 `permission.type=2` 确实人人可点，但**回调层** `gateway/event-handlers.ts` 有 `isApprovalAuthorized()` + `allowFrom` 校验，并配了 `tests/approval-auth.test.ts`。详见 §3.4。
4. 「`downloads/{appId}/{peerId}/` 是 main 的下载目录」——**错**。那是 CHANGELOG 1.6.6 的历史描述；main 实际落到 `~/.openclaw/media/qqbot/qqbot/downloads`（`qqbot` 重复两次），没有 appId/peerId 分段。详见 §3.7。

---

## 1. 两个仓库是什么（一手元数据）

| 项 | dsh-qqbot | openclaw-qqbot |
|---|---|---|
| 包名 / 版本 | `@tencent-connect/dsh-qqbot` **0.5.5** | `@tencent-connect/openclaw-qqbot` **2.0.4** |
| 宿主 | DSH / Cordis（**与我们同宿主**） | OpenClaw |
| 语言 / 运行时 | TypeScript，ESM，`node >=20.3.0`，`main: lib/index.js` | TypeScript，tsup 打包成 `dist/index.cjs` |
| 许可 | `license: MIT` | **`package.json` 未声明 license 字段**，但仓库有 `LICENSE`（MIT 文本）、README 挂 MIT badge |
| 共同依赖 | `@tencent-connect/qqbot-connector` **1.2.0**、`@tencent-connect/qqbot-nodejs` `^1.0.5` | 同左，`qqbot-nodejs` `^1.0.4` |
| 其他依赖 | `js-yaml`、`yaml 2.8.1`、`qrcode` | 无（peer `openclaw: *`） |
| 宿主契约 | `dsh.bundle.patch = ./cordis.patch.yml`、`dsh.client.platform = web`；peer 依赖 `cordis / dsh-agent / dsh-session / dsh-llm / schemastery`，`dsh-user-approval` 为 **optional** | `openclaw.id = openclaw-qqbot`、`channel.id = qqbot`、`extensions: preload.cjs` |

**两家共享同一套 `@tencent-connect/qqbot-connector` SDK**，这解释了它们形态相似：访问控制、斜杠命令、限流、输入状态、引用解析、并发门全部是 SDK 内置中间件，插件只负责编排与桥接。**我们是零依赖直连官方 HTTP/WebSocket，SDK 调用一行都不能照搬，只能照搬形态与顺序。**

### 入口契约里一条值得抄的坑

`dsh-qqbot/src/index.ts`：`name = 'im-qqbot'`、`inject = ['agents']`、`Config = ConfigSchema`。`apply()` 里凭据缺失时：

```ts
// 关键：不 await 扫码结果。boot 会等 Loader 树稳定（loader.await()），
// 无限期等待用户扫码会阻塞 Host ready——Desktop 界面无法进入、
// Web 的 URL 延迟输出。
void ensureCredentials(ctx, ...).then(...)
return; // apply 立即完成，插件 fiber 进入 ACTIVE
```

并且明确**不把凭据写进 `process.env`**：解绑后 HMR 重载的新 fiber 仍会从 env 读到旧凭据，状态会停在 `bound`。这与我们记忆里「`ctx.*` 只能在激活阶段用」「改子模块必须重启」是同一类 DSH 宿主契约陷阱，做向导时可对照。

---

## 2. 分层定位

```
上层 插件产品化   交互/审批/问答/命令/配置/并发安全   ← 主要借鉴
中层 会话与投递   被动窗口我们更准；流式与切分各有取舍 ← 互有胜负
底层 QQ 官方 API  webhook 验签/扫码/interaction/端点   ← 我们更深
```

底层证据（本地实测）：`bot/src/sign.js` 的 Ed25519 **连普通事件都验签**（不只 `op=13`）、`bot/src/webhook.js` 有 `op=13` 重复拒绝 + 每分钟 3 次限速 + `plain_token` 形态校验 + interaction 两层确认（`{op:12}` ACK 与 `PUT /interactions/{id}`）、`bot/src/qq/qrlogin.js` 扫码建 bot、`bot/src/endpoints.js` 56 条端点零缺方法、`dsh-roost/src/qq-tools.js:116` 的 `buildAtPrefix` / `<qqbot-at-user>`。openclaw 是 1.7.2 才加 Webhook 双模、1.5.4 才修多账户 token 串号；dsh-qqbot 0.5.3 完全没做 @ 输出（此条出自既有核对记录，本轮未复验）。

---

## 3. 逐项源码对照

### 3.1 会话与偏好持久化 → **P0-1，抄**

**对方 `dsh-qqbot/src/model/prefs-store.ts`**（一手）：

```ts
// 原子写：同目录临时文件 + rename，崩溃不留半份文件；
// tmp 名带进程+随机后缀：跨进程并发写时各自的临时文件互不覆盖，
// rename 只会带走自己写的那份（固定名会让 A 的 rename 落盘 B 的内容）
const tmpPath = `${this.prefsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
renameSync(tmpPath, this.prefsPath);
```

四件事：`write()` 前 `readDiskState()` **重读磁盘并合并其他写者条目**（`mergeDisk`，内存覆盖同 key、磁盘独有条目保留、墓碑 key 除外）；删除用 `Tombstones` 防「删除被并发写复活」；文件损坏时 `backupCorrupted()` **先备份再写**（只备份一次）；`onError` 升到 warn——注释点明用户表现是「QQ 里丢上下文」且无从排查。另有 `sessionKeys` 反向索引 O(1) 由 sessionId 找回 QQ 对端。

**我方 `dsh-roost/src/sessions.js:29-35`**：

```js
function save() {
  try { writeFileSync(file, JSON.stringify(map, null, 2), 'utf8'); }
  catch (e) { log(`会话映射写盘失败：${e.message}`); }
}
```

`load()` 的 catch 直接吞、无备份、无 warn；`createSessions` 只在 `host.js:821` 创建一次，没有别的并发保护。`dsh-roost/src/delivery.js:101-103` 虽有「原子写」，但用的是**固定 `file + '.tmp'`**——只防断电半文件，恰恰是 prefs-store 注释点名要避开的坑。**所以不能只搬 rename，要整套搬。**

同类风险：`dsh-roost/src/config.js` 也是 `writeFileSync(FILE(), JSON.stringify(cfg))` 整文件覆盖。

**会话层还藏着三条同源教训**（`src/session/session-id.ts` 与 `session-manager.ts`，一手）：

```ts
// session-id.ts
export function mintSessionId(): string { return `session-${randomUUID()}`; }
// 0.5.x 老派生算法（SHA-256 切片成 UUID 形态），仅用于探测存量会话并迁移
```

- **不要用确定性派生 id 新建会话**：注释原文「确定性 id 跨进程必然相同，两个进程各自新建会把同一 id 写入不同 project 目录」。`session-` 前缀是宿主约定，裸 UUID 会被社区插件误判为子代理会话。
- **singleflight**：`private inflight = new Map<string, Promise<SessionRecord>>()`，同 key 并发的 `getOrCreate` 复用同一次 resume/create。注释点明了成因：**斜杠命令与待答问题截获位于 `concurrencyGuard` 之前、与普通消息不串行**，同 key 并发会各自建出两个 agent，后写入者覆盖前者且前者无人 dispose（泄漏）。这与 §3.3 的中间件顺序是同一件事的两面。
- **回收联动**：闲置回收回调里除 `dispose()`，还统一 `questionChannel?.cancelPending(key)` 与 `approvalChannel?.cancelPending(key)`，防 pending Promise 悬挂；`promptHandles` 用 `WeakMap` 且释放时同步 `delete`——「live 复用的 agent 要能重装，否则 prompt 永久丢失」；`attachPrompt()` 幂等且 fail-soft（装失败只 warn，不打断会话建立）。

`session/` 下还配了 `boundary.test.ts` / `session-id.test.ts` / `session-manager.test.ts` 三个单测，把会话边界、id 铸造、并发恢复都钉住了——**这个测试密度本身也值得抄**：我们 `sessions.js` 目前没有任何专属测试。

**恢复失败必须三态，不能一律重建**（`session-manager.ts` 的 `openSession` → `mayCreateAfterResumeFailure()`，一手）：靠 `host.sessionExists(sessionId)`（`src/host/adapter.ts` → `sessionPersistence.stat(id)`）返回 `true / false / undefined`：

```ts
if (exists === true) { logger.warn(`refusing to recreate existing session: ...`); return false; }
if (exists === undefined) { logger.warn(`creating session without existence check ...`); } // 老宿主无 stat
return true; // 仅确认磁盘上没有，才允许 create
// 求证本身抛错 → 「existence unknown」→ 按存在处理，拒绝重建
```

返回 false 就抛**原 resume 错误**、不改写 prefs 映射。动机写在注释里：日志损坏 / 占用 / 后端故障时沿用同一 id 重建，会把同一 sessionId 写进多个 project 目录，宿主 `list()` 报 duplicate、**整个会话列表打不开**。`session-manager.test.ts` 用 E1-1～E1-6 六个用例钉死（在盘上但 resume EIO → 不 create；故障恢复后老会话仍能 resume；求证失败 → 抛原 `not found`；确认无 → 即使 IO 错也 create；宿主无 `stat` → 允许创建并留痕）。E2-2 / E2-3 则验 singleflight：`/compact` 与普通消息并发时 `resumes`、`handles` 各 1，失败时两个调用方收到同一错误且不残留在途记录。

**回收后仍能主动推送**：`deliveryAddress(sessionId)` 只读、**不唤醒 agent**——内存 `findBySessionId` 未命中就用 `modelResolver.findSessionKey(sessionId)` 反查 prefs，再 `parseSessionKey`（正则 `^qqbot:([^:]+):(c2c|group):(.+)$`，且 `appId` 必须匹配本机器人）得到 `{scope, targetId}`。`TurnTracker.addressOf()` 先查内存再走它。测试断言了「内存里没有会话时只按 prefs 返回 QQ 地址，`resume/create/get` 均未调用」。`idle-evictor.ts` 的 `CHECK_INTERVAL_MS = 60_000`，`timeoutMs <= 0` 不启动定时器。

### 3.2 被动回复窗口与 msgId 缓存 → **不抄，我们更准**

这是两个**职责不同**的模块，容易混：

| 模块 | 管什么 | 数值 |
|---|---|---|
| `transport/reply-limiter.ts` | 每条消息**最多回复几次** | `limit = 4`、`ttlMs = 3_600_000`、`maxTrackedMessages = 10_000`，LRU 驱逐；**不按会话类型分** |
| `transport/msgid-cache.ts` | 被动回复**目标 id 缓存多久** | `TTL_GROUP = 5min`、`TTL_C2C = 30min`、`MAX_PER_TARGET = 10`、`MAX_TARGETS = 200`；按 `kind:'msg'|'event'` 区分，`event` 带 `INTERACTION_CREATE:` 前缀 |

**我方 `bot/src/outbound.js:37-58`**：`PASSIVE_WINDOW_MS = { group: 5min, c2c: 60min, ... }`、`PASSIVE_MAX_REPLIES = { group: 5, c2c: 4 }`、`PASSIVE_SAFE_MS` 各减 15 秒留余量；投递账本以 `(msg_id, msg_seq)` 去重。我们把「窗口」和「次数」都按 kind 分流，官方把两者拆在两个模块且只有一个分流。私聊窗口按官方文档核的是 60 分钟，官方实现取 30 分钟偏保守——**不要倒退去对齐 30min**。

**同属 transport 层的切分**（`src/transport/chunker.ts`，一手）：`chunkMarkdownText(text, limit)`，`limit` 由调用方传 `config.textChunkLimit`（4500），`outbound.ts` 与 `outbound-buffer.ts` 都调它；规则是 `CODE_FENCE_OPEN = /^```/` 切换代码块状态、**代码块内不断开**、`GFM_TABLE_LINE = /^\|.+\|$/` 的表格整块 flush 不拆散，其余逐行累积超限即断。`outbound-buffer.ts` 另有 `STREAM_THROTTLE_MS = 200`。⚠️ 该文件头注释声称「优先在空行处断开」，但**实现里没有对空行做任何特殊处理**——别按注释描述它的实现。

### 3.3 访问控制与中间件编排 → **P1-1，抄顺序，别抄默认值**

**这里有一处文档与源码打架，必须写清**：CHANGELOG 0.5.4 声称「访问控制默认收紧：私聊默认白名单且留空拒绝所有人」，但当前 main 的 `src/config.ts` 实际是：

```ts
c2cMode: Schema.union(['open','allowlist','disabled']).default('open')
c2cAllow: Schema.array(Schema.string()).default([])
groupMode: ... .default('open')
access: AccessControlSchema.default({ c2cMode:'open', c2cAllow:[], groupMode:'open', groupAllow:[] })
```

README 配置项表也写 `open`。**真实语义**在 `src/gateway/middleware-setup.ts`：

```ts
// 3. 访问控制（空名单 = 拒绝所有人，fail-closed）
bot.use((ctx, next) => {
  const access = manager.accountAccess?.currentAccess() ?? config.access;
  return accessPolicy({
    c2c:  { mode: access.c2cMode, allow: access.c2cAllow },
    group:{ mode: access.groupMode, allow: access.groupAllow },
  })(ctx, next);
});
```

即「空白名单拒绝所有人」是 **`allowlist` 模式下 SDK `accessPolicy` 的行为**（插件只把空数组 `[]` 原样传进去，当前源码**没有任何 `['*']` 回落**），不是 schema 默认值。

**这个矛盾已查清成因，不是文档写错，是后来主动改回去了**：`src/config.test.ts` 用「#94-1 不变量」把「省略 access / `{}` / `null` 均得 `open`」钉死；最新提交 `0ddf232` 是 `#113 feat(account): Unify QQ access and slash command modes`，配套 CHANGELOG「未发布」里的配对码白名单体系与「**斜杠命令默认放开**」。`['*']` 回落确实在历史上存在过——commit `7ffb1c3`(fix(security)) 原文：「previously an empty list silently fell back to `['*']`, allowing everyone」，该提交移除了它。

**结论**：CHANGELOG 0.5.4 描述的是**历史状态**，当前 main 三个 mode 全是 `open`；别照抄「默认白名单」，也别把 `open` 当成它们的安全缺陷——安全默认改由**扫码绑定时把 c2cMode 切成 allowlist 并重置为扫码用户**来兜。

**`accessRevision` 乐观锁已坐实**（`src/setup/persist.ts` + `src/setup/bind-routes.ts`，一手），它**不在 config.ts，是路由层算出来的**：

```ts
export function accessRevision(access, appId = ''): string {
  return createHash('sha256').update(JSON.stringify([
    appId, access.c2cMode, access.c2cAllow, access.groupMode,
    access.groupAllow, access.commandMode ?? 'open',
  ])).digest('hex');
}
// GET /config 下发 revision；POST /config：
if (validated.access !== undefined && submitted.accessRevision !== revision) {
  sendJson(res, 409, { ok:false, error: new AccessConfigConflict().message }); return;
}
```

`updateProfileConfig(..., accessCondition)` 在**写事务内二次比对** revision 与 `checkedAppId`，不符就抛 `AccessConfigConflict` 且原文件字节不变；`bind-routes.ts` 的 catch 把它映射成 409，其余 500。`persist.test.ts` 有两条用例验写事务内重校验。这正是防「Web 表单覆盖 QQ 侧刚认领的白名单」的做法，我们做面板配置时可直接借。

**配置写入保真也坐实了**（`src/setup/persist.ts`，一手），头部注释四条约束：文档保真（eemeli/yaml 的 `Document` API 原地编辑，注释 / 锚点 / `!!js` 表达式 / `insert` 行一律保留）、fail-closed（非法 YAML、顶层非数组、config 非映射、配置被锚点共享 → 拒绝写入）、原子写、乐观校验。`ENTRY_ID = 'im-qqbot'`、`WRITE_ATTEMPTS = 3`；写入前重读比对（并发改动则重试合并），写入后读回校验「本插件条目正确 + 其他条目集合不变」，失败写 `.imqqbot.rollback` 回滚；`writePrivateFile` 用 `openSync(path,'wx',0o600)` + `fchmodSync` 落 `${patchPath}.imqqbot.tmp` 再 rename。`src/shared/atomic-file.ts` 另有 `atomicWrite(path, chunks)`：`${path}.${randomUUID()}.tmp` + `fsyncSync(fd)` + rename + 目录 fsync（`win32` 跳过）、失败 `rmSync(tmp)`。

- **大整数精度**不在 persist.ts，在 `src/media/vision-tool.ts` 的 `ensureVisionInputModal()`：`parseDocument(normalized, { intAsBigInt: true })`，整数不经 double 中转，避免回写 `settings.yaml` 时把安装 id / 时间戳截断到 2^53；`src/model/settings-reader.ts` 是 `js-yaml` **只读**，与写入无关。
- **请求体上限**在 `src/setup/bind-routes.ts`：`MAX_MANUAL_BODY_BYTES = 4096`（填凭据）、`MAX_CONFIG_BODY_BYTES = 512*1024`（配置，约容纳 1.4 万条 openid），`readJsonBody(req, maxBytes)` 累加超限抛错；单字段字符串 > 20000 字符拒绝。CHANGELOG 0.5.4 的「4KB→512KB」指的就是这里。

**更值得抄的是 12 层洋葱的顺序**（`middleware-setup.ts`，一手）：

```
1 errorHandler()                         最外层兜底
2 messageFilter({skipSelfEcho:false})
2.5 配对码认领  ← 必须先于访问控制
3 accessPolicy(...)                      空名单 fail-closed
4 historyBuffer({recordOnSkip:true})     ← 在 @ 门控之前，未 @ 的消息也计入上下文
5 mentionGate({requireMentionInGroup})
6 contentSanitizer({parseFaceTags:true})
7 rateLimiter()                          三层：sender/group/global
8 slashCommand({autoHelp:false})         ← 在并发门之前，匹配后不排队直接响应
8.5 questionAnswer(manager)              ← 答案消息不排队直接作答
9 concurrencyGuard({strategy:'merge', maxQueue, maxProcessingMs})
10 typingIndicator()                     SDK 内置「正在输入」
11 quoteRef({maxSize:500, preferMsgElements:true})
11.5 attachmentProcessor(...)
12 envelopeFormatter({includeQuote:true, includeSender:true})
```

三个非显然点：
- **配对码必须先于访问控制**：`isActivePairCode(content)` 且 `content.length <= 32`，否则白名单外的人根本无法完成加白；认领路径只套 `mention + rateLimiter`。
- **群历史缓冲放在 @ 门控之前**且 `recordOnSkip: true`，注释明说「确保所有消息（含未 @bot）都计入上下文」，回复后清空。
- `autoHelp: false` 是为了避免 SDK 再注册一个无前缀 `/help` 与自己的 `/bot-help` 重复。

`config.ts` 其余默认值（可直接对照我方配置）：`requireMention true`、`textChunkLimit 4500`、`streaming true`、`sessionIdleTimeout 30min`、`maxQueue 20`、`processingTimeoutMs 30min`、`askTimeoutMs 5min`、`historyLimit 10`；`media.maxMB 200 / ttlHours 24`；`vision.maxBytes 10MB / maxTokens 1024 / timeoutMs 120000`；`sendFile.restrictPaths true / sendPresentedFiles true / maxFiles 4`；`proactiveDelivery.externalTurns 'c2c'`；`cwd` 缺省 `~/.dsh-qqbot/workspace`。

**openclaw 的群配置走「策略注入」模式**（`src/middleware/policy-injector.ts`，一手）：每条消息把解析结果写进 `ctx.state.policy`，SDK 内置中间件（mentionGate / historyBuffer 等）自动从这里读动态策略作 fallback，**无需各自注册 `resolveConfig`**。

```ts
// 优先级链（注释原文）：具体群配置 > 通配符 "*" > defaultRequireMention > 硬编码默认值
const groupCfg = resolveGroupConfigFromAccount(account, groupOpenid);
policy.group = { requireMention: groupCfg.requireMention,
                 ignoreOtherMentions: groupCfg.ignoreOtherMentions,
                 historyLimit: groupCfg.historyLimit, prompt: groupCfg.prompt };
// 访问控制默认值（注意与 README 不一致）
c2cMode: account.config?.dmPolicy ?? 'allowlist',
groupMode: account.config?.groupPolicy ?? 'allowlist',
```

**上面记的「默认值矛盾」已解开**：`src/config.ts:79-85` 的 `DEFAULT_GROUP_POLICY = "open"` 对应 README 的 `groupPolicy`；`policy-injector.ts` 里的 `account.config?.dmPolicy ?? 'allowlist'` 是 **c2c 的 dmPolicy** 的 fallback——**两个不同字段**，并不矛盾。真要抄优先级链，仍以我们 `docs/能力页方案.md` 的五档栈式继承为准，不必引入 `ctx.state.policy` 中间层。

**优先级链实现已坐实**（`src/config.ts:131-145 resolveGroupConfigFromAccount`，与 README 完全一致）：

```ts
const wildcardCfg = groups["*"] ?? {};
const specificCfg = groups[groupOpenid] ?? {};
return {
  requireMention: specificCfg.requireMention ?? wildcardCfg.requireMention
                   ?? (account.config?.defaultRequireMention ?? DEFAULT_GROUP_CONFIG.requireMention),
  toolPolicy:      specificCfg.toolPolicy ?? wildcardCfg.toolPolicy ?? DEFAULT_GROUP_CONFIG.toolPolicy,
  ...
};
```

`DEFAULT_GROUP_CONFIG`（:87-93）：`requireMention: true`、`ignoreOtherMentions: false`、`toolPolicy: "restricted"`、`historyLimit: 20`（`DEFAULT_GROUP_HISTORY_LIMIT = 20`）——**README 表格写 `historyLimit` 默认 50，源码是 20，又一处文档不一致**。另有 `DEFAULT_PROCESSING_TIMEOUT_MS = 0`、`isGroupAllowed()` 用标准策略引擎 `evaluateMatchedGroupAccessForPolicy`（返回 `allowed / disabled / empty_allowlist / not_allowlisted / missing_match_input`），`src/middleware/access-control.ts` 是 c2c/group 的 allowlist 判定（默认 `allowlist`）。

⚠️ **`toolPolicy` 是「文档有、代码没落地」**：全 src 仅 5 处出现（`config.ts:90/140/173`、`types.ts:56`、`policy-injector.ts:33` 的注释示例），`policy-injector.ts` 注入 `policy.group` 时**根本不含 toolPolicy**，也没有任何中间件或工具过滤代码消费它。README 描述的 `full/restricted/none` 语义在 main 里没有判定。`ignoreOtherMentions` 同理，实际过滤由 SDK `mentionGate()` 执行，本仓库无判定代码。**别照着 README 抄一个不存在的工具权限层**。

### 3.4 审批 / 提问按钮通道 → **P0-2，抄 dsh-qqbot 形态 + openclaw 按钮能力**

**我方缺口（一手核验）**：`dsh-roost/src` 精确检索无 `approval/request`、无 `ask_user_question`、无 `button_data`。但**措辞要准**：我们有自己的审批——`ext-proactive.js` 的主动消息面板审批、`ext-tier.js` 的扩展安装二次确认（`checkbox` / `type-name`）、`config.js:783` 的 `approval: false`。缺的是**把 DSH 宿主的审批/提问 seam 桥到 QQ 按钮**。

**dsh-qqbot（同宿主，形态直接可用）**

`src/features/approval-channel.ts`：监听 `approval/request` waterfall，注册用 `{ global: true, prepend: true }`（`global` 必需，否则被 agent 作用域过滤掉）；找不到 QQ 会话就 `next()` 让给 Web/TUI；每会话单 pending；`nonce = randomUUID().slice(0, 8)` 编码进按钮，点击时匹配，旧卡片一律忽略；点击者身份取 `event.group_member_openid ?? event.user_openid`，allowlist 模式下不在名单**或身份缺失都拒绝**（fail-closed）；发送失败返回 `unavailable`；`commandOf()` 按 `callId` 从 session log 回显被 gate 的命令（`COMMAND_CLIP = 500`）；`cancelPending()` / `signal.abort` 清理挂起 Promise。注释还特别说明**不探测 approval 服务是否已挂载**（optional peer 挂载时机可能更晚，一次性探测失败会让通道永久失效）。

`src/features/question-channel.ts`：**包装 `userQuestions.ask`**（不是 registerProvider），用 `__qqQuestionPatched` 幂等标记、`origAsk` 兜底非 QQ 会话；状态机逐题推进；错误用 `ASK_ABORTED` code，让上层（plan-mode）能区分「用户未作答」与网络错误；按钮归属题校验 `button.q !== current.id` 直接忽略旧题按钮，防错位映射；多选走文本编号 `parseAnswer`；`askTimeoutMs`（5min）超时发提示并 reject；**按钮发送失败降级纯文本**；首题用本回合投递目标，后续题用 `record.replyTarget`（被动回复用户刚作答那条）；新题到达时 reject 旧 pending（`superseded by a new question`）；`uninstall()` 恢复 `origAsk`。

`src/features/button-utils.ts`（共享编码，一手）：

```ts
export const BUTTON_LABEL_MAX = 10;  // QQ 按钮 label 长度限制，超长截断补省略号
export const BUTTONS_PER_ROW = 2;
// 问答 {t:'question', q:问题id, i:选项下标}
// 审批 {t:'approval', d:'allow'|'deny', n?:nonce}
export function encodeButtonData(data: ButtonData): string { return JSON.stringify(data); }
// decodeButtonData：非法 JSON 或缺合法 t 时返回 undefined
```

顶层 `t` 判别字段供 `src/gateway/bootstrap.ts` 的 `dispatchInteraction` 统一路由，避免多通道各自 try 导致误判；未匹配时 `bot.acknowledgeInteraction(event.id, 3)`。这个设计很值得抄。

再补三条一手细节：

- **单选互斥的确切写法**（`src/features/question-renderer.ts`）：`if (opts.length === 0 || question.multiSelect) return undefined`——**多选直接不发按钮**，改用文本编号；单选项共享 `group_id: \`q-${question.id}\`` + `click_limit: 1` + `visited_label: '✓ 已选'`，`data` 编码 `{t:'question', q:问题id, i:下标}`。所以「点一个其余变灰」在两家都是 QQ 键盘原生能力，不是应用层状态机。
- **答案解析**（`src/features/answer-parser.ts`）：`/^[\d\s,，、;；./]+$/` 命中则抽所有数字、过滤越界，单选 `slice(0,1)`、多选全取并去重；否则按 label 全等（忽略大小写）匹配，再否则当 `custom` 自由文本。`src/middleware/question-answer.ts` 在 `concurrencyGuard` **之前**截获答案并 `ctx.stop('question-answer')`，注释说明是避免「turn 等答案 ↔ 答案被缓冲」死锁。
- **命令权限包装**（`src/commands/index.ts`）：`buildCommandList` 把**每个 handler 再包一层**，每次调用都重查 `accountAccess.commandAccessError(ctx.message.senderId)`；`src/commands/auth.ts` 的四种拒绝：`disabled` → 「斜杠命令已关闭」、无 senderId → 「无法确认发送者身份」、`open` → 放行、`allowlist` 且命中 → 放行，否则「你不在白名单中」；`command-access.test.ts` 验证模式切换 / 撤销 owner **即时生效**（不是注册时快照）。`describeCommands` 按 commandMode 映射 scope：`open→all`、`disabled→disabled`、其余 `owner`。

**openclaw（按钮原生能力，一手）**

`src/features/approval-handler.ts` 的 `buildApprovalKeyboard()` 说明「点一个其余变灰」**是 QQ Inline Keyboard 的原生能力，不是应用层状态**：

```ts
const makeBtn = (id, label, visitedLabel, data, style) => ({
  id,
  render_data: { label, visited_label: visitedLabel, style },
  action: { type: 1, data, permission: { type: 2 }, click_limit: 1 },
  group_id: "approval",
});
// data = `approve:${approvalId}:allow-once | allow-always | deny`
```

同 `group_id` + `click_limit: 1` + `visited_label` 实现三选一互斥；`permission.type = 2` 表示所有人可操作。其余工程细节：`toShortId()` 去掉 `exec:` / `plugin:` 前缀取 8 位，resolve 时支持完整 ID / 纯 UUID / shortId 三种匹配；`turnSourceAccountId` 与 `accountId` 比对，只处理本账号请求；`resolveTarget()` 用正则 `qqbot:(c2c|direct|group):([A-F0-9]+)` 从 sessionKey 提取投递目标；超时 exec 用 `expiresAtMs - now`、plugin 用 `timeoutMs ?? 120_000`，再 `+2_000` 缓冲；**发送前 `await 2000ms`**，注释说明是「确保框架侧 waitDecision 已就绪，避免时序竞争」；gateway-runtime 用动态 import，旧版框架加载失败则审批功能自动降级。

**修正：两家都校验点击者身份，只是位置不同。** openclaw 按钮层 `permission.type=2`（人人可点），但**回调层** `src/gateway/event-handlers.ts:150-206` 拦：

```ts
function isApprovalAuthorized(account, operatorId?): boolean {
  if (!operatorId) return false;                    // 身份缺失 fail-closed
  const allowFrom = account.config?.allowFrom ?? [];
  if (!allowFrom.length || allowFrom.includes('*')) return true;
  return allowFrom.includes(operatorId);
}
// resolveOperatorId: user_openid → data.resolved.user_id → user_openid → openid
// handleApproval 先 ack(event.id)，未授权只 warn 并 return
```

`root/tests/approval-auth.test.ts` 有完整单测（空名单放行 / `*` 放行 / 白名单命中 / 非授权 false / operatorId 空 false / 无 config 放行）。dsh-qqbot 则是在**按钮 handler 内**用 `group_member_openid ?? user_openid` 校验且 allowlist 模式 fail-closed。所以正确说法是「**按钮不挡人、回调层挡人**」，不是「openclaw 不鉴权」。

其余定位也已查清：`src/features/approval-utils.ts` 只有 42 行，仅 `isApprovalPayload`（正则 `/(?:Plugin|Exec) approval (?:required|allowed|denied|expired)/i`）和 `approvalStubs`（`buildPendingPayload/buildResolvedPayload: () => null` 抑制框架转发），**没有 allowlist 映射**。模式映射在 `src/commands/bot-approve.ts:7-11`：`on → {security:'allowlist', ask:'on-miss'}`、`off → {security:'full', ask:'off'}`、`always → {security:'allowlist', ask:'always'}`（`reset` 删两键回框架默认 `security=deny, ask=on-miss`）——**源码是 `off/on/always`，没有 `strict` 字面量**，README 的「严格模式」对应 `always`。写进 `cfg.tools.exec.security / ask`（框架级），命令带 `authorized: checkCommandAuth`、`scope:'c2c'`。

**旧卡片**：平台侧靠 `click_limit:1` + `group_id` 置灰；插件侧靠 `pending` Map + `requestCache`，`handleResolved` / `handleTimeout` 都清理两者。**插件没有显式主动拦截旧卡片**——`resolveApproval` 查不到 fullId 时仍会发 `exec.approval.resolve` / `plugin.approval.resolve` RPC，由框架侧拒绝（catch 后记 log 返回 false）；`findApprovalHandlerForShortId` / `hasShortId` 定义了但本仓库未见调用方。超时 `timeoutMs = plugin ? (request.timeoutMs ?? 120_000) : max(0, expiresAtMs - now)`，`setTimeout(handleTimeout, timeoutMs + 2_000)`，`handleTimeout` 只清状态不发消息（「超时由框架处理」）。

**我们要抄的组合**：QQ 原生 `group_id`/`click_limit`/`visited_label` 做互斥 + 回调层 `allowFrom` 鉴权 + dsh-qqbot 的 waterfall/nonce/fail-closed 形态。

### 3.5 引用上下文 → **不抄，前两轮判断已推翻**

**我方链路完整（全部一手）**：

```
bot/src/message.js:456          从事件 quote element 取原文 → msg.quoted
bot/src/host/serialize.js:78    外接协议传 quoted + replyTo
dsh-roost/src/roost-payload.js:194  buildRendered 拼「（引用了这句：…）」（slice 500）→ :417 payload.rendered
dsh-roost/src/host.js:2997      payload.rendered = buildRendered(...)（必定写入）
dsh-roost/src/inbound.js:39     renderInbound 优先用 rendered，:45 只是无 rendered 时的兜底
dsh-roost/src/journal-bridge.js:86  从内联文本反解引用原文，用于记忆定位
bot/src/ledger.js              持久化 msg_idx / ref_msg_idx / quoted，timeline() 可回查
```

> 注：`qq-bot-roost-plugins/plugins/ai-chat/inbound.js:135` 也有同一句 `slice(0,500)`，但 **ai-chat 已不在 DSH 链路上**（`roost-host.js:5`「不再经过 ai-chat 中间层」），那处属退役代码，改它无效。详见 §8 前提。

`serialize.js:47-54` 还有 `eventId`（事件账本主键，`ledger.context` / `msg.get` 按它回查原文）。我们**连按 id 回查原文都有**，比 openclaw 的索引更完整。

**对方**：openclaw `src/features/ref-index-store.ts` 是「SDK 只给 `REFIDX_xxx` 这个 key、不给正文」时的补偿：内存 LRU + JSONL 追加写 + 按 `accountId` 隔离 + 启动按 `t` 排序回放 + 跳过损坏行 + `COMPACT_RATIO = 2` 触发 compact + `writeChain` 串行化 append + 退出 `flush()`。注意该文件**注释与代码不一致**：注释写「默认 2000」，实际 `DEFAULT_MAX_ENTRIES = 50000` 且 `options.maxEntries ?? DEFAULT_MAX_ENTRIES`。

**「500 字」要按仓库分开看，这是 v3 修正的重点**：

- **dsh-qqbot**：`middleware-setup.ts` 第 11 层是 SDK 内置 `quoteRef({ maxSize: 500, preferMsgElements: true })` → 我方 `slice(0,500)` 与它**对齐**，不是差异。
- **openclaw**：插件层**不截断**。`src/dispatch/body-assembler.ts:30-38` 定义 `QUOTE_BEGIN='[Quoted message begins]'` / `QUOTE_END` / `CURRENT_MSG='[Current message]'`，`buildQuotePart()` 把 `quote.text` 全文包进 `agentBody`（:123-127）：

```ts
function buildQuotePart(quote) {
  if (!quote) return '';
  const text = quote.text || 'Original content unavailable';
  return `${QUOTE_BEGIN}\n${text}\n${QUOTE_END}\n${CURRENT_MSG}\n`;
}
```

CHANGELOG.zh.md:235（1.6.2）原文「引用内容不再截断：移除存储引用消息时的 `MAX_CONTENT_LENGTH` 截断，保留完整消息原文」。`ref-index-store.ts` 唯一的「截断」是 compact 到 `maxEntries`，**与正文长度无关**；SDK `quoteRef` 内部是否有限制，两仓库都无源码 → 未找到。所以**对 openclaw 而言我方 500 字是真实差异**，已升回 P2。

`agentBody = dynamicCtx + userMessage`（:85-91），编排在 `gateway/middleware-setup.ts:123-138`（#12 quoteRef 产出 `ctx.state.quote` → #14 envelopeFormatter 返回 `assembled.agentBody`）。`buildDynamicCtx`（:213-254）另生成 `- Images: ${imageUrls}`、`- Voice: ${voiceRefs}`（localPath + remoteUrl 去重）、`- ASR: ${asrTexts}`（`t.source === 'asr' ? t.text : t.asrReferText`），以及非引用消息时 `msg_elements` 的合并转发块。边界：quote 为空 → `''`、text 缺失 → `'Original content unavailable'`、`!quote` 才解析 msg_elements（避免重复）、斜杠命令直通去装饰（`buildAgentBody` :302-304）、`renderWebBody` try/catch 降级 bodyContent。

**结构化附件摘要的三处定义**（我们缺的就是这个）：`src/types.ts:250-259` `MessageAttachment { content_type, filename?, height?, width?, size?, url, voice_wav_url?, asr_refer_text? }`；`src/middleware/attachment.ts:27-38` `ProcessedAttachments { voiceText, imageUrls, otherInfo, transcripts, localMediaPaths, localMediaTypes, remoteMediaUrls }`；`src/utils/voice-text.ts:8-31` `TranscriptSource = 'stt'|'asr'|'fallback'` 与 `VoiceTranscript { text, source, duration?, localPath?, remoteUrl?, asrReferText? }`。附件下载仅 https、`downloadRemoteMedia({ subdir:'qqbot/downloads', maxBytes: 500*1024*1024, timeoutMs: 120_000 })`，失败时图片回退远端 URL、其他回退 `[Attachment: ${filename}]`。

**结论**：抄 `ref-index-store.ts` 仍是倒退（我们事件直给正文）。剩下的 P2 项改为三条：① **放开引用正文的 500 字截断**（对标 openclaw）；② 引用带媒体时补结构化附件摘要；③ dsh-roost 不消费 `replyTo`，回复不会自动挂引用样式。

### 3.6 命令体系 → **P1-2**

`openclaw-qqbot/src/commands/` 有 12 个文件：`bot-approve / bot-clear-storage / bot-group-always / bot-help / bot-logs / bot-me / bot-pairing / bot-ping / bot-streaming / bot-upgrade / bot-version / index.ts`。

`index.ts` 注释「**构建标准命令列表（匹配后直接回复，不进入 AI）**」，与 `middleware-setup.ts` 第 8 层「在 concurrencyGuard 之前，命令匹配后不排队直接响应」互相印证。

`bot-ping.ts`（一手）——耗时拆分的两个时间戳取自 SDK ctx：

```ts
const now = Date.now();
const eventTime = new Date((ctx.message as any).timestamp).getTime();
const totalMs = now - eventTime;
const qqToPlugin = ctx.receivedAt - eventTime;   // 网络传输
const pluginProcess = now - ctx.receivedAt;      // 插件处理
```

`bot-me.ts`（一手）：`scope: 'c2c'` **仅私聊**，只返回 `ctx.message.senderId`。dsh-qqbot 的实现不同且已取到（`src/commands/misc.ts` 的 `meCommand`）：私聊给 `senderId`，**群聊额外给 `groupOpenid`**，注释说这两个分别对应 `access.c2cAllow` / `groupAllow` 的名单 key——注意它并没有返回 `group_member_openid`，CHANGELOG 0.5.4 的表述比代码宽。对我们而言 `/bot-me` 直接服务 `config/bots/<id>.json` 的 `owners` 白名单配置，是最省事的一条。

`/bot-ping` 的 `ctx.receivedAt` 是 SDK `SlashCommandHandlerContext` 注入的字段，**仓库内找不到赋值点**（`types-augment.d.ts` 只扩展了 `downloadedFiles` / `downloadedQuoteFiles`）——别写成「插件自己测的」。三个时间戳：`ctx.message.timestamp` → `eventTime`、`ctx.receivedAt`（SDK 收到时刻，**分割点**）、handler 的 `Date.now()` → `now`，所以是单向时间戳差、**不是真实 ping-pong RTT**。时间戳缺失或非法时只回 `✅ pong!`。命令靠 SDK `slashCommand` 匹配后 `ctx.stop()` 拦截，消息根本到不了 `bot.on('message')` / `handleInbound` / agent followup；commit `26e9a0b` 佐证这也是 `/stop` 曾失效的原因。

`/bot-logs`（`src/commands/bot-logs.ts`，一手）：`MAX_LINES_PER_FILE = 1000`、`MAX_FILES = 4`、`LOG_KEYWORDS = ['gateway','openclaw','clawdbot','moltbot']`；取最近 4 个日志各 `slice(-1000)`，写到 `getQQBotMediaDir('exports')/bot-logs-${timestamp}-${suffix}.txt`（4 字节随机后缀）再 `sendFile`。**README 说「约 2000 行」，源码实际最多 4000 行**。无日志→列出搜索过的路径；读取失败→`⚠️ 找到日志文件但读取失败`；发送失败→返回含 tmpFile 路径的文本。

`?` 后缀用法：README 与 `bot-help.ts:22` 都有，**但解析代码在 SDK `slashCommand` 内，本仓库无实现**；插件侧只为每个命令声明 `usage` 字段，由 `commands/index.ts:29-49` 注册。

**openclaw 的完整链序**（`gateway/middleware-setup.ts`，一手）：`errorHandler → messageFilter → policyInjector → historyBuffer → dynamicAccessControl → mentionGate → contentSanitizer → rateLimiter → slashCommand → concurrencyGuard → typingIndicator → quoteRef → attachmentProcessor → envelopeFormatter`。原文注释「斜杠命令（**在并发锁之前，命令匹配后直接 reply + stop，不排队**）」——所以命令**不经过引用注入 / 附件 / 上下文组装**。`concurrencyGuard({ strategy:'merge', maxQueue: 50, maxProcessingMs })` 的 `urgentPredicate` 另让框架级 `/stop` 跳过排队。

### 3.7 富媒体、文件与 SSRF → **P1-3，抄思路但要补严**

`openclaw-qqbot/src/utils/ssrf-guard.ts`（一手）：

```ts
const RESERVED_V4_PREFIXES = ["127.", "10.", "192.168.", "169.254."];
const PRIVATE_172_RE = /^172\.(1[6-9]|2\d|3[01])\./;
// IPv6: ::1, ::, fe80:, fc/fd
const QQ_TRUSTED_DOMAINS = new Set([
  "api.sgroup.qq.com", "sandbox.api.sgroup.qq.com", "bots.qq.com",
  "multimedia.nt.qq.com.cn", "multimedia.nt.qq.com", "grouppro.grouppro.qq.com",
]);
```

流程：只放行 `http/https` → QQ 白名单域名免 DNS 直接放行 → 字面 IP 即时判定 → 域名 `dns.resolve(host)` 后逐条 `assertPublicAddr`。

**它的四个缺口，我们抄时要补**：
1. `dns.resolve()` 只查 **A 记录（IPv4）**，不查 AAAA → 域名解析到 IPv6 内网可绕过；
2. **DNS 解析失败不阻塞**（`console.warn` 后继续，注释说「后续 fetch 会产生网络错误」）；
3. **不校验重定向**，跳一次到内网即可绕过；
4. **不防 DNS rebinding**（校验与实际请求是两次解析，TOCTOU）。

**「找不到 `chunked-upload.ts`」已有确切答案**：2.0.0 把分片上传、上传缓存、独立消息队列、音频转码**下沉到 SDK**，main 全 src 搜不到 `uploadId` / `partNumber` / `CHUNK_SIZE` 及分片重试常量；`src/utils/` 只剩 8 个文件。main 里与媒体相关的常量只有三个：`setup/finalize.ts:97 mediaMaxMb: 200`、`gateway/qqbot-gateway.ts:41-42 TEXT_TIMEOUT_MS=30_000 / MEDIA_TIMEOUT_MS=300_000`、`outbound/media-send.ts:128 MAX_DATA_URL_BYTES = 10MB`。

**v1.6.6 tag 的 `src/utils/chunked-upload.ts` 是真实源码（非 main）**，数值如下：

| 常量 | 值 | 说明 |
|---|---|---|
| `DEFAULT_CONCURRENT_PARTS` | `1` | 服务端未返回 concurrency 时兜底 |
| `MAX_CONCURRENT_PARTS` | `10` | 并发硬上限 |
| `MAX_PART_FINISH_RETRY_TIMEOUT_MS` | `10*60*1000` | 完成阶段重试总上限 |
| `PART_UPLOAD_TIMEOUT` | `300_000` | 单分片 5 分钟 |
| `PART_UPLOAD_MAX_RETRIES` | `2` | 退避 `1000 * 2^attempt`（1s/2s） |
| `MD5_10M_SIZE` | `10002432` | 10M 摘要切片 |

**分片大小不是硬编码**：`const block_size = Number(prepareResp.block_size)` 由 QQ 开放平台 `upload_prepare` 返回；并发 `Math.min(prepareResp.concurrency ?? 1, 10)`；进度回调 `{ completedParts, totalParts, uploadedBytes, totalBytes }`；每片算 MD5、整体算 md5/sha1/md5_10m，完成调 `c2cCompleteUpload` / `groupCompleteUpload`。README 的「图片 20MB / 视频 30MB / 附件 100MB / 每日 2GB」**在 main 源码里没有对应常量**，是 QQ 平台侧限额的文档说明。

同批 v1.6.6 文件：`upload-cache.ts` 缓存 key = `${md5(fileContent)}:${scope}:${targetId}:${fileType}`、`MAX_CACHE_SIZE = 500`、`effectiveTtl = max(ttl - 60, 10)`（比 API TTL **提前 60 秒**过期）、惰性清理超限删最早一半，fileType `1=IMAGE/2=VIDEO/3=VOICE/4=FILE`；`message-queue.ts` `DEFAULT_GLOBAL_QUEUE_SIZE=1000 / PER_PEER=20 / GROUP=50 / MAX_CONCURRENT_USERS=10`，「同用户串行、跨用户并行」，slash 命令先执行，满队列优先丢最旧（群聊优先丢 bot 消息）；`audio-convert.ts` 降级顺序为 **TTS `pcm → mp3`（仅 400/422 才降级）→ mp3 解码 `ffmpeg → WASM` → QQ 原生语音扩展名 `{.silk,.slk,.amr,.wav,.mp3}` 直传**，PCM→WAV 采样率 24000，`.amr` 需剥 6 字节 `#!AMR\n` 头，超时 120s。main 的等价残留是 `streaming-controller.ts` 的 `chain` 串行、`deliver-pipeline.ts` 媒体逐个 await、`media-send.ts` 的 `sendVoice → sendFile` fallback。

**`downloads/{appId}/{peerId}/` 不是 main 的实现**：CHANGELOG 1.6.6 的历史描述在 2.0.4 已不成立。main 实际链路 `middleware/attachment.ts:303 subdir:'qqbot/downloads'` → `adapter/media.ts:90 getQQBotMediaDir(opts.subdir)` → `utils/platform.ts:79-85 path.join(home,'.openclaw','media','qqbot',...)`，得到 `~/.openclaw/media/qqbot/qqbot/downloads`（`qqbot` 重复两次），**没有 appId/peerId 分段**；文件名 `{name}_${Date.now()}_${rand4byteHex}${ext}`。按 accountId 隔离的只有 `getQQBotDataDir(accountId)`（session 目录）。

**两套独立 SSRF**（修正 §3.7 前半）：`utils/ssrf-guard.ts` 管**出站**媒体 URL（调用方 `outbound/image-size.ts:25`、`outbound/media-send.ts:208`）；**入站附件下载走 `src/adapter/media.ts:44-72` 的另一套**，网段表额外含 `224.0.0.0/4`（组播）、用 `dns.promises.resolve4`、**DNS 解析失败直接抛错**（与 ssrf-guard「失败放行」相反）、降级 fetch 只允 `https:`，并优先用 `openclaw/plugin-sdk/media-runtime` 的 `saveRemoteMedia`。所以「DNS 失败不阻塞」只适用于出站那套，别一概而论。我们 `qq_send_file` 已有 200MB 上限与超 5MB 自动分片，数值口径不同，别直接对齐。

**出站防抖反而拿到了一手数值**（`src/outbound/debounce.ts`）：

```ts
const DEFAULT_WINDOW_MS = 1500;      // 合并窗口
const DEFAULT_MAX_WAIT_MS = 8000;    // 最长等待，超过立即 flush
const DEFAULT_SEPARATOR = '\n\n---\n\n';
// 按 targetId 合并；已有 pending 时 push + 重置窗口；finally 里 resolve
```

注释里一条重要的前提：「框架 ReplyDispatcher 通过 `sendChain` 保证 deliver **严格串行**——`enqueue` 返回的 Promise 在文本实际发出前不会 resolve，因此上游不会并发调用 deliver，无需 `flushBeforeMedia`」。也就是说这个 debounce 能成立，靠的是上层已经串行化；我们若直接搬，必须先确认自己的出站队列有没有同样的保证。

**dsh-qqbot 侧的媒体实现已全部坐实**（一手），此前 `MEMORY-dsh.md` 抄的四条成立，且能补上具体代码：

- `src/transport/attachment.ts` 的 `imageExtension(buf)`：按魔数识别 **GIF（`GIF87a`/`GIF89a`）/ PNG（8 字节签名）/ JPG（`FF D8 FF`）/ WEBP（`RIFF....WEBP`）/ BMP（`BM`）** 五种，每个分支带长度守卫；`correctImageExt` 未识别、扩展名已一致、`.jpg≈.jpeg` 时原样返回，字节不变不转码。注释原文「QQ 网关的 content_type 统一标 image/png 不可信，只有文件头可靠」。`src/media/vision-tool.ts` 另有独立 `sniffImageMediaType()` 只认 png/jpeg/gif/webp（**不含 bmp**），仅判 mediaType、不改扩展名。
- `src/media/send-media.ts`：`realishPath(p)` 先 `realpathSync`，失败则按最近存在祖先逐段 realpath 再拼尾段（处理 macOS `/var → /private/var`）；`isWithinRoot` 用 `relative(realRoot, realishPath(filePath))` 判 `..` 前缀，`root` 不可解析则该 root 无效；`isPathAllowed` 的 roots = `MEDIA_ROOT + cwd + extraRoots`。`send-file-tool.ts` 先 `resolve` → 白名单 → `existsSync`（不存在单独报「文件不存在」，不误报路径不允许）。扩展名分发表：`IMAGE_EXTS`、`VIDEO_EXTS`、`VOICE_EXTS`，其余一律 `sendFile`。
- `src/media/media-cleaner.ts`：`CLEANUP_INTERVAL_MS = 60*60*1000`，按文件 `mtime` 判过期，`ttlHours <= 0` 不启动；启动即异步清一次 + `setInterval`，经 `ctx.effect` 挂载、卸载自动清理。
- **dsh-qqbot 自己也有一套下载 SSRF 防护**（`src/transport/attachment.ts`）：仅 `https:`、`PRIVATE_RANGES` 含 `10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、`224/4`（比 openclaw 多了组播段）、`DOWNLOAD_TIMEOUT_MS = 120_000`、`DEFAULT_MAX_MB = 200`。两家的防护是**各自独立实现**的， ours 若要抄，取 openclaw 的 DNS 白名单 + dsh-qqbot 的网段表合并更稳。

### 3.8 回合归属与主动推送（`externalTurns`）→ **值得抄语义**

我上一轮只写了「区分被动/主动、不占额度」这个业务描述，实际实现在 dsh-qqbot `src/transport/` 下有一整套（一手）：

- `qq-input-origin.ts` 的 `QqInputRegistry`：`handleInbound` 时 `inputs.register(String(message.id))` 登记本插件铸造的消息 id；`has()` **查询不消费**（事件可重放）；`inputOriginTtlMs = max(30min, processingTimeoutMs * 2)`，`DEFAULT_MAX_ENTRIES = 4096`，由 `TurnTracker.end` 释放。
- `turn-origin.ts`：`INTERNAL_KINDS = new Set(['schedule','user-question-reply'])`；`classifyTurnInput(source, qqOwned)` 里 `form==='notice'` / kind 在 INTERNAL_KINDS / `kind !== 'user'` → internal，否则 `qqOwned ? 'qq' : 'external'`。**followup 与桌面输入都是 `kind=user`，靠「id 有没有登记」区分**。`deliveryMode`：`origin==='qq' → passive`、`external → proactive`、`sawInternal → proactive`、完全无输入 → passive。
- `turn-tracker.ts` 的 `planFor()`：被动时返回含 msgId 的 `passive` 目标；`origin==='external'` 且 `!allowsExternal(base)` 直接不投递；否则 `{ ...base, forceProactive: true }`。`allowsExternal`：`all` 全放行、`c2c` 只放 `scope==='c2c'`、`off` 不放行。
- **不占额度、不粘旧消息**的实现在 `reply-target.ts` 第一行：`if (target.forceProactive) return { scope, targetId };` —— 直接丢掉 `msgId`/`eventId`、不查 msgid-cache、不调 ReplyLimiter。`outbound.ts` 的 `shouldStream(plan)` 要求 `!plan.proactive`，主动回合不流式；`OutboundBuffer.target` 是 readonly，「目标在创建时拍下，本回合内不再改」，避免 external 回合中途插入 QQ 入站改判 passive 后粘到旧消息。

已知边界（源码注释）：一个 external 回合中途插入 QQ 入站会改判为被动，但**本回合已创建的缓冲仍按创建时的主动目标发送**。我们 `dsh-roost` 有主动搭话与排期，若要做「桌面续聊 QQ 会话时把回复推回 QQ」，这套 `origin` 判定比自己在出站口猜更干净。

**附：openclaw 的出站三层管道**（`src/outbound/deliver-pipeline.ts`，一手）——「TTS 语音 → 媒体 → 文本 debounce」的确切实现：`Layer 1 audioAsVoice → handleVoiceIntent(text, ctx)`（成功即 return，不再发媒体/文本）；`Layer 2 hasMedia → await sendMediaUrls(ctx, mediaUrls)`，附带文本单独 sendText；`Layer 3 纯文本 → debouncer.enqueue(...) 或 sendText(...)`。`resolveMediaUrls` 优先级 `mediaUrls → 单个 mediaUrl → attachments[].url ?? .path`。debounce 在 `dispatch/dispatch.ts:75-80` 按 `account.config?.deliverDebounce` 实例化（`enabled !== false` 默认开启），回复收尾 `await debouncer.flushAll()`。

`src/outbound/streaming-controller.ts` 有一条**很值得记住的约束**：「QQ 流式 API 替换模式下，**已下发文本的前缀不可变更**」——状态机 `IDLE → STREAMING → DONE`，`lastAcceptedFull` 为单源真理，`chain` 串行队列，`shouldFallbackToStatic = isTerminal && sentChunkCount === 0`。`dispatch/dispatch-deliver.ts` 注释「kind=final 与已发 block 去重；流占用时收尾后跳过静态文本」。配套 `outbound/sanitize.ts` 剥离 thinking 标签（我们 `leak-guard.js` 做同类事）、`reply-limiter.ts` 超限降级主动消息、`TTS_ALLOWED_ROOTS = [~/.openclaw, tmpdir, /tmp]`。媒体部分失败提示 `⚠️ n/total 个媒体发送失败`，全失败 `⚠️ 媒体发送失败（n 个），请重试`。

### 3.9 传输与鉴权 → **不抄**

我方 `sign.js` / `webhook.js` 已覆盖 Ed25519（AppSecret 循环填充成 32 字节种子，签 `event_ts + plain_token`，输出 128 hex）、`op=13` 校验、`X-Bot-Appid` 分流、端口占用顺延、**普通事件也验签**（`sign.js:87-89` 注释说明只验 op13 会导致伪造任意事件）。

**openclaw 侧已坐实**（实现在 `src/adapter/webhook.ts`，**不在 `src/gateway/`**；`gateway/qqbot-gateway.ts:106-109` 只是把 `createPluginWebhookAdapter` 挂进 SDK 构造参数）：

- **Ed25519 种子派生在 SDK 内、本仓库无实现**：`verifyWebhookSignature` 从 `@tencent-connect/qqbot-nodejs/protocol` import，插件只传 `{ body: rawBody, timestamp, signature, botSecret: t.clientSecret }`；签名头 `x-signature-timestamp` / `x-signature-ed25519`，缺失 → 401。main 源码里搜不到 `ed25519` / `plain_token` / `seed` 的派生逻辑。
- **`op:13` 无需签名**，取 `targets[0]` 的 SDK handler 用 `delegateToHandler` 委托处理（`{body, headers}` 进去、`resp.status/headers/body` 回写）；插件层不自己构造 `plain_token` 回包。无 target / 无 handler → 500。
- **多账户按签名自动路由**：`sharedTargets = new Map<string, WebhookTarget[]>()`，同一 `webhookPath` 下每个账户注册一个 target（各自 `appId`/`clientSecret`/`handler`，reload 按 accountId 去重刷新）。op:0 走 `resolveWebhookTargetWithAuthOrRejectSync({ targets, isMatch: t => verifyWebhookSignature(..., t.clientSecret), unauthorizedStatusCode: 401 })`，**遍历同路径所有 target 用各自 secret 验签**，命中后按 `matched.accountId` 取 handler。这确实是「按签名路由」，不是按路径或 appid 头。
- 边界数值：限流 `windowMs 60_000 / maxRequests 600 / maxTrackedKeys 4096 / maxInFlightPerKey 8`；body `maxBytes 1_048_576 / timeoutMs 30_000`；`requireJsonContentType: true`，非法 JSON → 400，顶层 catch → 500；默认 path `/qqbot/webhook`。旧框架缺少 `registerWebhookTargetWithPluginRoute` → 记 error 放弃；缺 `withResolvedWebhookRequestPipeline` → 降级 `handleSimple`（遍历所有 target，取第一个 `status < 400`，全失败 401）。

对比下来我们 `sign.js` 自己派生种子、连普通事件都验签，实现深度仍高于「SDK 代劳」的 openclaw；但它的**同路径多账户按签名路由**我们目前是靠 `X-Bot-Appid` 头分流，思路可以并存参考。

---

## 4. 明确不抄

| 项 | 理由 |
|---|---|
| `@tencent-connect/qqbot-connector` / `qqbot-nodejs` 的调用 | 两家都靠 SDK 中间件；我们零依赖直连官方 API，只能抄形态与顺序 |
| 架构分层 | 它们插件直连 QQ；我们框架 / 外接协议 / 插件三层是优势，动传输层等于自废 |
| `ref-index-store.ts` | SDK 只给 key 的补偿方案；我们事件直带正文，抄了是倒退 |
| 被动回复 30min / limit=4 | 我们按官方文档分了群 5min/5次、单聊 60min/4次，更准 |
| `/bot-upgrade` 热更新 | README 明确 Windows 不支持；我们已有面板自更新 + `package.json`/lock 失败回滚 |
| `toolPolicy` / README 的 `historyLimit:50` | main 里 `toolPolicy` **没有任何消费方**、`historyLimit` 默认 20；别照 README 抄一个不存在的工具权限层，用我们自己的「能力页」五档栈式继承 |
| 把 v1.6.6 的分片/缓存/队列数值当 main 常量 | 2.0.0 已把分片上传、上传缓存、独立消息队列、音频转码下沉 SDK，main 无这些文件；数值只能作历史参考 |
| 许可 | 两家 MIT、我们 AGPL-3.0-only。MIT 代码可并入，但须在 LICENSE/NOTICES 保留原版权与 MIT 声明，不能改名了事 |

---

## 5. 落地建议（按改动量排序）

> ⚠️ 先读 **§8 改动冲突核验**：本节第 3、6 条在本项目**不适用**，第 5 条**全局照做会砍现有功能**。§8 才是可执行的版本。

1. **`dsh-roost/src/sessions.js`**：`save()` 改为 `tmp = file + '.' + pid + '.' + randomHex` → `writeFileSync` → `renameSync`；写前重读磁盘合并其他写者条目；`remove()` / `forgetSession()` 记墓防复活；`load()` 解析失败先备份 `.corrupted.<ts>` 并 `log.warn`（别静默吞）。可直接参考 `delivery.js` 的 rename 写法，但**必须换掉固定 tmp 名**。
2. **新增审批/提问桥接模块**：按 `approval-channel.ts` 的 waterfall + nonce + `group_member_openid` + fail-closed 形态；按钮 data 按 `button-utils.ts` 带顶层 `t` 统一分发；用 QQ 原生 `group_id` / `click_limit` / `visited_label` 做互斥，不用自己维护「其余变灰」状态。注意我们是外接协议中转，按钮事件与 `INTERACTION_CREATE` 的回执链路要走 `roost-host/1`，别直接调 SDK。
3. **中间件顺序对齐**：若引入配对码加白，必须放在访问控制之前；斜杠命令与待答问答放在并发门之前；群历史缓冲放在 @ 门控之前。
4. **补 `/bot-me` / `/bot-ping`**：前者服务 owners 白名单（dsh-qqbot 群聊多给的是 `groupOpenid`，不是 `group_member_openid`）；后者按 `receivedAt` 两段拆分，注意那是单向时间戳差、不是 RTT；命令在进 AI 队列前拦截，且不经过引用注入 / 附件 / 上下文组装。
5. **下载 SSRF**：抄 `ssrf-guard.ts` 的白名单 + 保留网段，但补 AAAA 查询、重定向逐跳校验、DNS 失败即拒绝、把校验与请求绑到同一 IP；网段表再并入 `224/4`（组播），并参考 dsh-qqbot `transport/attachment.ts` 只允 `https:` + 120s 超时。
6. **配置写入保真**：`config.js` 整文件覆盖改为「只改自己条目 + 原子写 + 并发合并」；面板改白名单时补 `accessRevision` 式乐观锁（409 而不是静默覆盖）。
7. **放开引用正文的 500 字截断**（现役是 `dsh-roost/src/roost-payload.js:194` 的 `buildRendered`，兜底是 `inbound.js:45`；**不是 `ai-chat/inbound.js:135`，那处已退役**）：对标 openclaw 全文注入；若要补结构化附件摘要，参考 `types.ts` 的 `MessageAttachment` 与 `utils/voice-text.ts` 的 `TranscriptSource`。注意 dsh-qqbot 的 SDK `quoteRef` 本身是 `maxSize:500`，截断与否属两家不同取向，不是我们「对齐了官方」。

改码仍按项目铁律：跑测试 → 问主人 → 本地 commit → 停，不 bump / push / publish。

---

## 6. 证据索引（本轮实际读过的文件）

**dsh-qqbot（一手源码）**：`package.json`、`src/index.ts`、`src/config.ts`、`src/config.test.ts`、`src/gateway/middleware-setup.ts`、`src/gateway/bootstrap.ts`、`src/model/prefs-store.ts`、`src/session/{session-id,session-manager,idle-evictor,types}.ts`、`src/session/session-manager.test.ts`、`src/host/adapter.ts`、`src/setup/{persist.ts,bind-routes.ts,persist.test.ts}`、`src/shared/atomic-file.ts`、`src/media/vision-tool.ts`、`src/model/settings-reader.ts`、`src/transport/{reply-limiter,msgid-cache,chunker,attachment,turn-tracker,turn-origin,qq-input-origin,reply-target,outbound,outbound-buffer}.ts`、`src/features/{approval-channel,question-channel,answer-parser,question-renderer,button-utils}.ts`、`src/middleware/question-answer.ts`、`src/media/{send-media,send-file-tool,media-cleaner,vision-tool}.ts`、`src/commands/{index,auth,misc}.ts`、`src/commands/command-access.test.ts`；另列 `src/middleware/`、`src/session/`、`src/commands/` 目录及 git commit `7ffb1c3` / `26e9a0b` / `0ddf232` message；另读 `README.md`、`CHANGELOG.md`（二手线索）。`session-manager.ts` 前半段用 `lib/session/session-manager.js` 补全并交叉验证。

**openclaw-qqbot（一手源码）**：`oc-src` 用 GitHub API tree 拉取了 **main 全量 83 个 `.ts`** 原文，重点精读：`package.json`、`src/config.ts`、`src/types.ts`、`src/gateway/{middleware-setup,event-handlers,qqbot-gateway}.ts`、`src/dispatch/{body-assembler,dispatch,dispatch-deliver}.ts`、`src/middleware/{policy-injector,attachment,access-control}.ts`、`src/adapter/{webhook,media}.ts`、`src/utils/{ssrf-guard,voice-text,platform,stt}.ts`、`src/outbound/{deliver-pipeline,debounce,streaming-controller,media-send,image-size,sanitize,reply-limiter,tts-provider}.ts`、`src/commands/{index,bot-approve,bot-ping,bot-me,bot-logs,bot-help}.ts`、`src/features/{ref-index-store,approval-handler,approval-utils}.ts`、`root/tests/approval-auth.test.ts`；另读 `README.md`、`README.zh.md`、`CHANGELOG.zh.md`、`docs/commands.md`（二手线索）。
**v1.6.6 tag（真实源码但非 main）**：`src/utils/{chunked-upload,upload-cache,audio-convert}.ts`、`src/message-queue.ts`。本地副本在 `workbody.work/qqbot_src/`（`files/src/` 共 94 个 .ts、`v166_*.ts`、`chunked_v1.6.6_*`、`root/tests/`），主 agent 已抽查 `isApprovalAuthorized` / `QUOTE_BEGIN` / `DEFAULT_GROUP_CONFIG` / `MAX_CACHE_SIZE` / `MAX_CONCURRENT_PARTS` 等常量复核。

**本地（一手）**：`bot/src/{sign,webhook,outbound,message,ledger,endpoints}.js`、`bot/src/host/serialize.js`、`bot/src/qq/qrlogin.js`、`dsh-roost/src/{sessions,delivery,config,inbound,journal-bridge,qq-tools}.js`、`qq-bot-roost-plugins/plugins/ai-chat/inbound.js`、两份 `LICENSE`（均为 AGPL v3 全文）。端点数由 `node --input-type=module` 实跑 `OFFICIAL_ENDPOINTS` 得到。

## 7. 未复验 / 二手项（别当结论用）

- **SDK 内部实现无法核验**（两仓库均无源码）：`accessPolicy` 空名单判定、`slashCommand` 的 `ctx.stop()` 与 `?` 后缀解析、`ctx.receivedAt` 赋值点、Ed25519 种子派生、`quoteRef` 内部是否截长、`mentionGate` 对 `ignoreOtherMentions` 的过滤、分片上传的 main 实现。报告只记调用方式与注释，未写成仓库自测逻辑。
- **main 里确实不存在的东西**：`chunked-upload.ts` / `upload-cache.ts` / `message-queue.ts` / `audio-convert.ts`（2.0.0 下沉 SDK，数值取自 **v1.6.6 tag**）；`toolPolicy` 的判定代码（README 有语义、main 无消费方）；`downloads/{appId}/{peerId}/` 分段（CHANGELOG 1.6.6 的历史描述）。这些**不要当 main 能力引用**。
- 「图片 20MB / 视频 30MB / 附件 100MB / 每日 2GB」仅有 README 依据，main 源码无对应常量，是 QQ 平台侧限额。
- README 与源码不一致的三处，均以源码为准：`historyLimit` 默认 **20**（README 写 50）、`/bot-logs` 最多 **4000 行**（README 写约 2000）、dsh-qqbot `/bot-me` 群聊只多给 `groupOpenid`（CHANGELOG 写 `group_member_openid` + group openid）。
- CHANGELOG 0.5.4「私聊默认白名单」「`/bot-me` 群聊字段」是**历史状态 / 宽于代码的表述**：当前 dsh-qqbot main 三个 mode 全 `open`（`config.test.ts` #94-1 钉死，`0ddf232` / #113 主动放开斜杠命令）。别把旧版描述当现状。
- 「dsh-qqbot 0.5.3 完全没做 @ 输出」出自 `MEMORY-api.md` 既有核对记录，本轮未复验。

---

## 8. 改动冲突核验（照 §5 落地前必读）

> **前提（先纠正一个易错假设）：现役链路不经过 ai-chat。** 最硬的一条是主人自己的文档：`dsh-roost/README.md:105` 原文「装好后首次打开面板会强制走一遍『首次接入向导』……**因为这一版移除了 ai-chat 中间层**，老配置的接入方式已不存在，不重接就是哑的」。源码侧三条互证：`roost-host.js:5`「直连 roost 框架的 `roost-host/1` 协议，不再经过 ai-chat 中间层」；`host.js:3007`「ai-chat 时代 dsh-roost **收不到**这些」；`host.js:3010 deliverNoticeFromRoost` 只留 AUDIT。部署侧三条：运行副本 `Desktop\工具\qq-bot-roost\plugins` 只有 anime-img / dice / douluo / group-admin / kun（无 ai-chat）；运行副本 `data/bots/main/plugins.json` 只有 `{"douluo": true}`；开发实例 `bot/data/bots/main/plugins.json:3` 是 `"ai-chat": false`（该文件里也只有 `douluo` 为 true）。ai-chat 作为市场插件仍在（`plugins/index.json` 与 `plugins/ai-chat/index.js` 都是 **v4.4.6**，版本一致），但**不在 DSH 链路上**。所以任何「ai-chat 会抢单 / 要改 ai-chat」的判断都是错的。

现役入站链路：QQ → 框架 → `host/index.js:367 onEvent` → `serialize.js:84 serializeNotice` → SSE `notice` 帧 → `roost-host.js:271 onNotice` → `host.js:2732` → `host.js:3010 deliverNoticeFromRoost`。

把 §5 每条建议回落到本地代码逐条核对后，结论是：**7 条里有 2 条基本不适用、1 条会砍现有功能、3 条需要附加规则才不会撞车，只有 1 条可以照抄**。

| # | 建议 | 本地实测 | 判定 |
|---|---|---|---|
| 1 | `sessions.js` 原子写 + 合并 + 墓碑 | `sessions.js:29-35` 整文件 `writeFileSync`、`load()` 解析失败静默吞（`:22-25`）；`delivery.js:101-103` 的「原子写」用固定 `.tmp` 名 | ✅ 可做，**但必须加 3 条规则**（下述 A） |
| 2 | DSH 审批/提问 seam 桥到 QQ 按钮 | 现役链路无 ai-chat；`putInteraction` 全仓唯一调用点在 `webhook.js:470`，**WS 分支（两实例都用 WS）没有任何回执**；`deliverNoticeFromRoost`（`host.js:3010-3017`）只匹配 `/AUDIT/i`、其余丢弃；现有按钮是 `action.type:2` 指令型（`outbound-actions.js:122`） | ⚠️ 真缺口，**前置两件：补 WS 回执 + 放行 notice，然后才是按钮**（下述 B） |
| 3 | 中间件顺序对齐（配对码→访问控制→命令→并发门→@门控） | 我们没有 SDK 洋葱：`bot.js:1051` 先算 `commandEntry` → `:1052` 跑 `pipeline.run`（去重/白名单/限流/暂停闸）→ `:1075` 命中命令执行并 `:1165` `return` | ❌ **不适用**：命令本来就在 AI 之前，且白名单在命令之前；只有 `turnqueue` 做串行，没有可对齐的 12 层 |
| 4 | 补 `/bot-me` / `/bot-ping` | `main.js:372` 已有 `core('whoami')`，输出 openid / 群 openid / 是否主人 / 权限档位，**信息比 `/bot-me` 更全**；`main.js:300` 已有 `core('ping')`，但只有 `pong（已运行 N 秒）` | ⚠️ **别新建命令**：只补 `/ping` 的两段耗时拆分（下述 C） |
| 5 | 下载 SSRF（白名单 + 保留网段 + AAAA + 重定向） | `host/media.js:72-84` 的 `assertUrl` **只校验协议、完全不判内网**；`media.fetch`（`:428`）无条件 `fetch`；`roost-payload.js:283-311` 自己抓 QQ 图片 URL 也无校验 | 🔴 **全局拦截会砍功能**（下述 D）：配置里允许 `http://127.0.0.1:7890` 代理、`dshUrl` 常是本机；必须只对「非可信来源 URL」生效 |
| 6 | `config.js` 改「只改自己条目 + 并发合并」 | `config.js:1212-1233` 是 `DEFAULTS` 做基线 + `restoreMaskedSecrets` + `pruneTo` + `chmod 0600`，**刻意整份写**；注释写明「用户删字段就是要它没了」；`config.json` 全归我们，不存在其他插件的条目与注释 | ❌ **不适用**：改成「只改自己条目」会破坏「删除即回落默认」语义。而配套的 `accessRevision` 乐观锁**我们已有**（`config.js:1063` + `host.js:8415/8462` + `client.js:15990`），见下述 E |
| 7 | 放开引用 500 字截断 | 现役生效的是 `roost-payload.js:194`（`buildRendered` 生成 `rendered`，`host.js:2997` 必定写入 → 必然生效）与 `inbound.js:45`（无 `rendered` 时的兜底）；`ai-chat/inbound.js:135` 已不在链路上 | ⚠️ 可做，**改这两处，不是改 ai-chat**（下述 F） |

### A. `sessions.js` 改写的 3 条硬规则

1. **空 `sessionId` 不是缺失**：`host.js:5452` 与 `:7286` 会 `sessions.set(chatId, '')` 建「只登记不绑定」的条目。合并写时若把空串当「无记录」丢掉，这两个入口建的条目会被下一次写盘抹掉。
2. **`reload()` 必须重置合并基线**：`rewrite.js:178` 的 `reloadCaches()` 在「一键改写 / 一键回退」后调 `sessions.reload()`；`rewrite.js:363-384` 的 `rewriteSessions` 又是 `writeJsonAtomic` 直写整份。若合并仍以旧内存为准，`reload` 之后的一次 `set()` 会把刚回退掉的键写回来——这正是 `sessions.js:41-44` 注释里已经踩过的坑。
3. **墓碑只防「合并复活」，不拦显式 `set`**：`remove()`（`host.js:8365`、`host.js:3972`）是「清上下文」，下一条消息必然再 `set` 同一 chatId。墓碑若连显式写入也拦，等于把「清上下文」变成「永久断链」。

其余调用面（38 处 `sessions.*`，不含定义处）只用 `get/entry/list/size/patch/set/remove/forgetSession`，原子写与合并对它们**完全透明**，没有需要同步改的调用方。

### B. 审批按钮桥的 4 个冲突点（按「点击之后会发生什么」排序）

1. **WS 模式下回执根本没人做**：`putInteraction` 全仓唯一调用点是 `webhook.js:470`（HTTP 分支）；`gateway.js:281 #handle` 的 `OP.DISPATCH` 分支只做 seq 去重（`:326-333`）然后交 `onDispatch`（`:355`），**没有任何 interaction 回执**。而两个实例的连接模式都是 WebSocket（运行副本 `config/bots/main.json:22-24`、开发实例 `bot/config/bots/main.json:23`）。所以用回调型按钮之前，必须先给 WS 分支补 `PUT /interactions/{id}`。webhook 分支已有两层回执（`webhook.js:454-477`：`{op:12,code:0}` + PUT，注释「同一 id 只能回一次」），别在那里重复 ack。
2. **notice 通道把 interaction 丢了**：`INTERACTION_CREATE` 由 `host/index.js:367 onEvent` → `serialize.js:84-86 serializeNotice` 打成 `{at, event, data}` → SSE → `roost-host.js:271 onNotice` → `host.js:2732` → `host.js:3010-3017 deliverNoticeFromRoost`，而后者**只对 `/AUDIT/i` 打日志，其余事件直接丢弃**。注意嵌套层级是 `data.event`（事件名）与 `data.data`（事件体），`button_data` 在 `data.data.data.resolved.button_data`——实现时别少剥一层。
3. **别动现有按钮的 `action.type`**：`outbound-actions.js:113-127` 的 `buildKeyboard` 用 `action: { type: 2, permission: { type: 2 } }`——**type 2 是指令型**，点击后 `data` 作为一条用户消息发出，**不产生 INTERACTION**。`parseButton`（`:92-99`）把 `标签|指令` 的后半段当 `data`（`slice(0,100)`），所以 `<<button: 标签|指令>>` 要真的落到命令上，`data` 必须以命令前缀开头；写成普通文本则点击后按普通消息进 AI。想要「点一个其余变灰」的互斥效果必须改成 `type: 1`（回调）+ `group_id` + `click_limit`，**这会把所有既有指令按钮一起改掉**——应该是新增一种回调按钮类型，而不是改 `buildKeyboard` 的默认值。
4. **别造第二套真相**：`ext-tier.js:74-86` 已有 `confirm: none/checkbox/type-name` 三档，`ext-proactive.js:156-205` 已有 `pending/awaiting` 状态机——但确认入口在**面板**。QQ 按钮只能是「同一个确认要求的另一个输入口」，用 `nonce` 绑到同一条 pending 上，不能另立表，否则面板和 QQ 会各批一半。

顺带一个反向结论：**因为 ai-chat 不在链路上，dsh-roost 现在根本没有 `INTERACTION_CREATE` 的消费方**，所以审批桥不用考虑跟谁抢事件，只需扩一条 notice 路由并补 WS 回执——比原报告设想的简单，但这两个前置必须都做完。

### C. `/ping` 只补耗时，不新建命令

`registry.addCommand`（`main.js:137`）已是统一入口，加命令不会和插件冲突（`bot.js:1142-1144` 注释：命令名排他）。但 `/whoami` 已覆盖 `/bot-me` 的全部字段，再建一个 `bot-me` 只是冗余入口。要补的只有 `/ping` 的两段耗时——**而且不用改任何底层**：`message.js:292/341/461` 早就存了 `receivedAt`（框架收到时刻），`:465` 的 `at` 就是 `Number(d.timestamp) || receivedAt`（QQ 事件时间戳），两个时间点都现成，`core('ping')` 里直接算差值即可。

### D. SSRF 只能拦「外部来源 URL」，不能拦全局 fetch

会误伤的真实配置：`bot/src/config.js:116` 的代理示例就是 `http://127.0.0.1:7890`；`dshUrl` 默认本机；面板与宿主互调全走 `127.0.0.1`。正确边界是**只对「QQ 事件带进来的附件 URL」与「模型给出的 URL」校验**（`roost-payload.js` 图片下载、`media.fetch` 的 `url` 参数），代理与 `dshUrl` 走另一条路白名单放行。

**magic bytes 这条我上一轮说反了，这里更正**：我们两边都做了嗅探，但**优先级都是「先信声明」**，而 QQ 网关统一标 `image/png`（dsh-qqbot `transport/attachment.ts` 注释专门点名这个坑），导致兜底永不触发：

- 出站 `host/media.js:102-114 imageFileName`：扩展名在 `IMAGE_CONTENT_TYPES` 里就直接用，**只有扩展名不认识时才嗅文件头**。
- 入站 `roost-payload.js:70-79 guessMime`：`content-type` 命中 `OK_MIME` 就直接返回，**嗅头部只是兜底**（`:73-78`，仅 jpeg/png/gif/webp 四种）。

所以有效行为等于「全信平台声明」。dsh-qqbot 的 `correctImageExt` 是**只信文件头、不信 content_type**，这才是该抄的点；落到我们代码上只需把 `guessMime` 的判断顺序反过来（文件头优先、声明兜底），不是新写一套。

### E. `accessRevision` 乐观锁 → **我们早就有了，别再做**

上一轮把它列成"值得抄但需跨端配合"，实核后**撤回**：

- `config.js:1063 configRevision()`：对 `config.json` **内容做 sha256 取前 16 位**，注释写明「用内容哈希而不是 mtime：同一毫秒内的两次写，mtime 分不出来」。
- `host.js:8415`：`GET /config` 同时下发 `config` 与 `revision`，注释「config 与 revision 必须同源」。
- `host.js:8462-8470`：`POST /config` 比对 `body.__revision`，不符返回 **409 + 当前 config + 新 revision**，文案「配置在别处改过了，先刷新再保存」。
- 面板已接：`client/client.js:15990` 带 `__revision`、`:15991` 处理 409、`:13054` 注释「409 时服务端把当前配置一起回了：强制对齐」。

唯一瑕疵是 `client.js:15661` 注释还写「配置版本（mtime）」，实际已是内容哈希——顺手改注释即可，不值得单开一批。

（`config.js` 的写入方约 20 处实际调用，`host.js` 内散布 `:695/:742/:1143/:1365/:2469/:6544/:6592/:6690/:6715/:6750/:6784/:8460/:9811/:9882/:10077`，另有 `config.js:1268` 的 `patchConfig` 定义——这个数字仍成立，只是**不需要再加锁**了。）

### F. 引用截断要改的是 `roost-payload.js:194`，不是 ai-chat

现役链路里 `rendered` 是 dsh-roost 自己生成的：`host.js:2997` 与 `roost-payload.js:417` 都会写 `rendered`，而 `roost-payload.js:194` 的 `buildRendered` 里就有一句 `（引用了这句：${String(evt.quoted).slice(0, 500)}）`。`inbound.js:39` 的 `p.rendered` 短路意味着：**有 `rendered` 就完全不走 `inbound.js:45`**，所以生效的是 `roost-payload.js:194`；`inbound.js:45` 只是无 `rendered` 时的兜底，改口径时两处要一起对齐（否则兜底路径行为不一致）。`ai-chat/inbound.js:135` 已退役，改它没有任何效果。

另外放开截断会直接抬高每轮 token，建议改成一个更大的上限（如 2000 字）并保留尾部省略号，而不是彻底取消。

### 结论

- **可原样落地**：`sessions.js`（连同 A 的三条规则）。
- **可以落地但要先修前置**：审批按钮桥——① WS 分支补 `PUT /interactions/{id}`（`gateway.js #handle` 的 DISPATCH 分支现在没有）；② `deliverNoticeFromRoost` 放行 `INTERACTION_CREATE`；两件都做完才谈按钮，且新增回调按钮类型，别改 `buildKeyboard` 的 `action.type`。
- **可以落地且很便宜**：`/ping` 两段耗时（两个时间戳都现成，不用改底层）。
- **要两处同步改**：引用上限（`roost-payload.js:194` + `inbound.js:45`）。
- **不要做**：中间件顺序对齐、`config.js` 改「只改自己条目」、新建 `/bot-me`、全局 fetch 拦内网、改 `ai-chat`（不在链路上）。
- **不用做（早就有了）**：`accessRevision` 乐观锁——`configRevision()` 后端下发 + POST 比对 409 + 面板带 `__revision` 全都已实现（见 E）。

以上判定全部来自本地源码实读，**未改动任何项目代码**。
