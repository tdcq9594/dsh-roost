# AI 自我表达与身份变更方案（v4）

> 2026-11-16 第四次重写。v1 前提（资料每月 5 次）已证伪；v2 我们替用户拍了冷却；
> v3 改成「默认无限额、频次交用户」；v3.2 把八个触发器删到两个。
> **v4 是按评审意见修的**——评审推翻了 v3.2 的三件事：论证方式、工具切分、安全网的真实性。
> 逐条采纳情况见 §14。

---

## 1. 事实

### 1.1 已证实（带代码位置）

| 事实 | 证据 |
|---|---|
| `dev.bot.set` / `dev.bot.avatar` 是 `message` 档；`dev.login.*` 全是 `manage` | `bot/src/host/dev.js:79,100,105-118`；`bot/src/host/methods.js:60-68` |
| **但改资料要求框架侧已有登录态**（`requireReady()`，未登录抛 `NOT_LOGGED_IN`），而建立登录态只能走面板（`manage`） | `bot/src/dev/platform.js:598`、`dev.js:105` |
| 协议的 `qq.call` 只认 `p.args` 位置参数数组，`{params}` 会被当 `[]` 静默丢参 | `bot/src/host/methods.js:354-356` |
| `getGlobalMenu` / `setGlobalMenu` / `updatePanel` 不在拦截名单，PUT/POST 记 `write` → 要 `message`；`args` 最多 12 项；`danger` 档要 `confirm:true`（所以 `deletePanel` 不可用） | `host/methods.js:119-141,351-357` |
| 菜单 `PUT /v2/menu`：官方 5 QPM、覆盖式、≤10 项、仅 C2C。**框架只硬校验「数组 + ≤10 项」，QPM 与覆盖式都只是注释，不做本地限频** | `bot/src/api.js:1518-1537`；`src/endpoints.js:55-56` |
| 指令面板支持 `scope: 'c2c'｜'group'｜'channel'｜'dm'`，≤20 个、`createPanel` 只校验每面板 ≤20 项（`updatePanel` 不校验） | `bot/src/api.js:1550,1575,1595,1607` |
| 菜单/面板「暂不需要单独提审」 | `bot.qq.com/wiki` §9.1.2 |
| **`ext.call` 是「框架插件 → DSH 扩展」方向**，不是我们去调框架插件；我们要调生图得走 `tool.image_gen`（`message` 档） | `host/methods.js:930-947,999-1022`；`dsh-roost/src/host.js:3216-3250` |
| `image_gen` 返回**本地绝对路径 + `<<image-alone: 路径>>` 标记**，不是 dataURL | `plugins/imagegen/lib/tools.mjs:31`、`README.md:39,45` |
| `cfg.name` 每 6 小时按平台昵称回拉，方向是**平台 → 本地**；`bot.nickname.sync` 是 `manage` | `bot/src/services/nickname.js:36-74`；`methods.js:813` |
| `dev.bot.get` 只回 `base.name/desc/avatar(URL)/modifyRemain`，**没有 avatarId** | `bot/src/dev/platform.js:919-928` |
| `dev.bot.set` 的 `base` 是整包提交（只改 desc 也会带 `name:''`，靠 `filter` 位忽略） | `platform.js:971-987` |
| 她的名字：`persona.selfName` > `config.persona.name` > `label`（缺则 `name`/`id`）> `大肥鱼` | `dsh-roost/src/personas.js:108-114` |
| `selfName` 存在**人格卡 front-matter**（`selfname:`），不在 config 里 | `personas.js:200-210` |
| **主动搭话轮被硬塞 `bucket:'owner'`**（注释：「这一轮没有真实说话人，不传会退回 member」） | `dsh-roost/src/host.js:3482-3494`、`:2103-2118` |
| 能力页：`newTools:'owner-only'`，`admin` 是**显式白名单**（不含新工具），`owner` 才是 `*` | `src/capabilities.js:129,142-148` |
| 功能页 `affects` 的实现是「关掉后用 `tools.restrict` **收走**」，**不是不注册**；名字写错会整批拒绝 | `src/features.js:512-527`、`src/permissions.js:131-133` |
| config 是**白名单裁剪**：`DEFAULTS` 之外的键会被静默丢掉（不报错、面板不回显） | `src/config.js:757-758,1144-1165,1259-1261` |
| `audit()` 只认 `op/chatId/peer/peerId/note`，`by`/`via` 会被静默丢 | `src/audit.js:40` |
| `mood.js` 注入的是自然语言语气，不是数字 | `src/mood.js:7-9,245-258` |
| 备份整目录打包，新增数据文件无需改 `backup.js` | `src/backup.js:49-57,96-100` |

### 1.2 未证实（不许写成规则）

- `remaining_modify_count` 到底回不回（代码 `?? null`，取不到就是 `null`，**不代表没有限额**）。
- 「PUT /v2/menu 是覆盖式」只来自注释与官方文档，未实测少传项是否截断。
- 改资料是否送审、C 端多久刷新、一次 patch 算 1 次还是 2 次。
- `GET /v2/menu` 空菜单返回什么；`name` 有没有长度上限（框架不校验，12 字是官方文档值）。

### 1.3 已证伪

「基本信息每月可修改 5 次」「上线后改资料必须提审再上线」——出自 2023 年版
`tencent-connect/bot-docs` README，同一份文件还写着「个人开发者不能开群」。

---

## 2. 可见性矩阵（v3 缺的地基）

v3 说「菜单只对 C2C，群里没有表达面」——**这句话是错的**。正确的地基是这张表：

| 出口 | 私聊 | 群 | 频道 | 成本 | 可逆 | 送审 |
|---|---|---|---|---|---|---|
| 菜单文案（`PUT /v2/menu`） | ✅ 那排入口 | ❌ | ❌ | 5 QPM，覆盖式 | 秒改回 | 否 |
| 指令面板（`/v2/panels`） | ✅ | ✅ `/` 面板 | ✅ | 10/60 QPM | 改回 | 否 |
| 昵称 / 头像 / 简介 | ✅ | ✅ 成员列表、资料卡 | ✅ | 要登录态 + 上传 | 半可逆 | 未证实 |

三条结论：
1. **群里的表达面是「资料卡 + 昵称」，不是菜单**——所以「群里没出口」的推论不成立，
   资料反而承担了群场景的全部表达。
2. 指令面板是唯一「群里可见 + 不送审」的出口，v4 记为**候选**（`scope:'group'`），
   第一版不做，因为它改的是功能入口，做成心情栏会像坏掉的产品。
3. 每一档的「可逆」都是真的可逆，除了昵称——它只是「再改一次」，不是撤销。

---

## 3. 设计基线：默认无限额

一句话：**我们不设默认冷却，不设预算，不猜平台余额。**

```jsonc
"selfExpression": {
  "menu":   { "enabled": true, "cooldownMin": 0 },                    // 0 = 不限；菜单没有 confirm
  "sign":   { "enabled": true, "cooldownMin": 0, "confirm": false },  // 简介
  "name":   { "enabled": true, "cooldownMin": 0, "confirm": false },  // 昵称
  "avatar": { "enabled": true, "cooldownMin": 0, "confirm": false },

  "awareness": { "mood": true, "silence": true },
  "proactive": { "enabled": false, "fields": ["menu"] }
}
```

- `enabled` = **工具注册不注册**（不是「注册了再拒」，见 §5.3 的实现注意）。
- `confirm` = 改之前先私聊主人问一句，主人**点「确认改」按钮**才写（§5.4）。只在 `sign`/`name`/`avatar` 上有。
- `cooldownMin` = 两次写之间的最小间隔，**对所有调用生效**（谁调的都一样），0 = 不检查。
- 真正的硬闸不在这里，在 **§5 的授权**：谁能调、哪一轮能调。
- 面板文案写代价，不写数字建议：菜单「随时能改回来」；昵称「所有人看到的名字都变，
  平台侧没有撤销，但这里留了上一版可退回」；头像「要上传，平台按内容规范过一遍」。

---

## 4. 四个工具

v3 把 `name` 和 `desc` 塞进一个 `qq_profile`，理由却是「能力页按工具名授权，
拆开正好对上想开哪个开哪个」——自相矛盾：能力页**没有字段级授权**
（`capabilities.js` 按 `matchPattern` 匹配工具名），所以「允许改简介、不许改昵称」
在旧切法里做不到。v4 拆开：

| 工具 | 写什么 | 默认给谁 | 说明 |
|---|---|---|---|
| `qq_menu` | 菜单那一格文案 + 点击载荷 | owner、admin | 秒可逆 |
| `qq_sign` | 简介（= OneBot 的 `longNick`） | owner（可放开） | 可逆 |
| `qq_name` | 昵称（+ 人格卡 `selfName`） | **只有 owner** | 半可逆，必须有人在场 |
| `qq_avatar` | 头像 | owner（可放开） | 要上传 |

### 4.1 `qq_menu { text?: string }`

- 不给 `text` = 读；给了 = 换那一格。
- **必须读改写**（PUT 按官方文档覆盖式）。但「覆盖式」在 §1.2 里是待验证项，
  所以实现上按「覆盖式」防御（永远读→改→写），并在注释里写明这是防御性假设。
- **实例身份不靠 `·` 前缀**（前缀会误命中：用户自己也可能起一个 `·帮助`）。
  自己存一份 `menu-slot.json: { index, name, type }`，匹配顺序：记录 → `·` 前缀 → 索引。
  **匹配失败一律拒，不追加**——v3 的「找不到就追加」会静默漂移：
  用户改个名字 → 追加新格 → 几次之后占满 10 项 → 永久哑掉，而模型没法腾格。
- 追加只允许在「首次使用 + 项数 < 10 + 菜单里没有 `·` 项」三条同时成立时。
- **写回前按白名单重建**：`{name, type, send_message, link, sub_menu_items}`。
  `GET` 回的项可能带 `PUT` 不接受的字段，原样回吐有风险。
- **名字和载荷一起写**：换标签时同步改 `send_message`，否则点进去发的还是旧那句话。
- 长度 ≤12 字是官方文档值，框架不校验——**自己挡**，并在错误文案里说清是本地挡的。

### 4.2 `qq_sign { text?: string }`

只写简介，不碰昵称。工具描述里给情境：「别人点开你会看到这句话」。
写前读一次、写后读一次回显实际生效值。

### 4.3 `qq_name { name?: string }`

**实现时改了策略（v4 原案是「内部同写 selfName」，落地时否掉了）**：

- 角色卡人格（`.md` 头部有 `selfName`）→ **拒绝改昵称**，并说明「去改人格卡里的 selfName」。
- 普通人格 → 写平台昵称 + 同步 `config.persona.name`。

为什么否掉「自动同写」：`selfName` 在**用户手写的 markdown** 里，front-matter 可能有
注释、缩进、别的字段。程序去改它，一次格式化失误就把人格卡弄坏，而且不可逆；
而「拒绝 + 指路」把选择权交回人，最坏情况也只是改名没做成。
xAI 伴侣那次 `identity conflict` 说明这**必须**处理，但「处理」不等于「替人改文件」。

其余约束：

- **昵称必须有人在场**：判据是 `caller().senderId` 非空 + `bucket === 'owner'`。
  不能靠 `bucket` 单独判——主动搭话轮被硬塞了 `bucket:'owner'`（`host.js:3482-3494`）。
- 顺序：**平台先写成功，再同步本地**。反过来的话，本地先叫她新名字、平台失败，
  用户看到的就是「她说自己叫小蓝、点开还是大肥鱼」。
- 本地同步失败不报整体失败：平台那步已经成真，返回里带 `selfSynced:false` 和一句说明。
- 历史快照带 `{name, selfName, personaId}`——回滚时要看得出当时有没有 selfName。

### 4.4 `qq_avatar { url?, path?, dataUrl? }`

三条给图的路，第一个给了就算：`url`（http/https）、`path`（本机图片）、`dataUrl`。

**收本地路径**（第一版曾写成「不收」，改回来了）：主人这一档本来就有读文件的工具，
再把它挡在头像这里只是「多一道猜谜」——她得先调生图、再把图发给主人、等主人给地址。
该守的不是「能不能读」，而是**读到的东西是不是官方收得下的图**：

- 扩展名白名单 `png/jpg/jpeg/bmp/gif`（不做文件头校验：真正的格式判定在框架与平台各有一道）
- **先 `stat` 再读**：超 2MB 直接拒，不把大文件读进内存
- 只认普通文件（目录/空文件拒）

**仍不做 `source:'generate'`**：`tool.image_gen` 返回的是**一段中文文本**
（「画好了：<绝对路径> …」），拿路径得正则抠文案，插件改一句话就静默失灵；
跨机部署更不通。要做「她自己画」，让她先调生图工具，再拿 `path` 传回来 ——
两件事分开，各自可以单独失败、单独解释。

---

## 5. 授权：三件事分开算

### 5.1 谁能调（能力页）

| 工具 | owner | admin | manager/helper/member |
|---|---|---|---|
| `qq_menu` | ✅ | ✅（需手动加进 `defaults.admin.allow`） | ❌ |
| `qq_sign` | ✅ | ❌ 默认 | ❌ |
| `qq_name` | ✅ | ❌ **永不** | ❌ |
| `qq_avatar` | ✅ | ❌ 默认 | ❌ |

**注意**：`admin` 是显式白名单（`capabilities.js:143`），新工具不会自动进去；
写文档时别说「默认给 admin」，要么改那一行，要么标「需手动勾」。

### 5.2 哪一轮能调（`qq_name` 的硬规则）

v3 写的是「定时器/事件轮次没有 `bucket` 所以会拦住」——**代码里不是这样**：
主动搭话轮被硬塞 `bucket:'owner'`（`host.js:3482-3494`），按 bucket 判会**放行**。
这是 v3 最危险的一条：它把安全网写成了「安全网存在」。

v4 的判据是**看有没有真实说话人**，不看 bucket：

```
qq_name 可执行 ⇔ caller().senderId 非空（这一轮有真实消息的发送者）
              ∧ bucket === 'owner'
```

- 主动搭话、定时器、事件轮：`senderId` 为空 → 拒。
- 群里 owner 说话：通过；群友说话：bucket 不对 → 拒。
- 能力页再收一道：`qq_name` 只在 owner 档可勾（`defaults.admin` 里永不出现）。

`qq_menu` / `qq_sign` / `qq_avatar` 不要求 `senderId`（它们可逆，且
主动搭话轮正是她想换个说法的时候）。

### 5.3 `enabled:false` 到底怎么实现

§3 说「不注册」，但功能页的 `affects` 是「关掉后每轮收走」（`features.js:512-527`），
两者不能混。v4 明确：

- **`enabled` 用「不注册」**：在 `host.js` 调 `registerQqTools({...})` 时按配置决定
  要不要传 `menuOf/signOf/nameOf/avatarOf`，照 `qq-tools.js:402-404` 对 `fileOf`
  的条件展开写法（没传就不注册该工具）。
- **功能页开关与 `enabled` 是同一个键**，不要另开一个 `affects`——否则
  「关了但还在 schema 里」会让模型以为能用。

### 5.4 主人确认（`confirm`）

打开某一项的 `confirm` 之后，**任何一次改动**（不管谁触发的）都要先私聊主人问一句，
主人**点确认卡片上的按钮**才真的写平台：

```
她想改简介：「今天想安静一点」
点下面的按钮告诉我。10 分钟内有效。
（按钮显示不出来时，直接回「确认」或「不用」。）
        [ 确认改 ]  [ 不用了 ]
```

按钮是**回调型**（`action.type: 1`）：点击产生 `INTERACTION_CREATE`，带
`button_data`（`{t:'pf', n:<nonce>, v:'y'|'n'}`）回到宿主，按 nonce 精确对上
那一条请求。点了就是点了，不存在「主人正好说了句确认」这种误批。

文本只留「确认」「不用」两个字面兜底（覆盖按钮显示不出来的老客户端）。
`channel.js` 在 markdown 被 4xx 拒时会降级成纯文本重发，**那条路不带
keyboard**，所以正文里必须写清「按钮没了就回哪两个字」。

| 约束 | 为什么 |
|---|---|
| 按钮 `style` 只能 0 / 1 | 官方只有「灰色线框 / 蓝色线框」两档；写成 2 平台不认，**整条消息被拒**（表现是「点了改资料，主人什么都没收到」） |
| 授权 fail-closed | 拿不到点击者 openid、或点的不是主人本人，一律不算；群里点无效 |
| nonce 绑请求 | 新请求顶掉旧的，旧卡片点了只回「已失效」，不会改到新请求上 |
| 只认**主人的 c2c 会话**，命中后**不进模型** | 群里点了不能替主人确认；这一句是「批准」不是聊天，喂给模型它会当新话题 |
| 待确认放内存、10 分钟过期 | 落盘会让「重启后还挂着三天前的请求」变成真事，而那种请求主人早忘了 |

同一类还有未过期请求时**直接复用**，不重复发私聊——模型一轮调两次、用户连点两下，
主人不该收到两条一样的消息。文本回「不用」或点「不用了」→ 取消最近一条。

**面板上人自己按的「改」不经过这道闸**：它防的是「别人替主人做决定」，
而那个按钮就是主人自己按的。

---

## 6. 记录与回滚

### 6.1 `before` 必须是「可重放的最小对象」

v3 只存字符串，三条都不可用：

| kind | v4 的 before | 为什么 |
|---|---|---|
| `menu` | `{ index, name, type, send_message }` | 整份菜单回滚会冲掉别人在这期间的改动 |
| `sign` | 字符串 | 够 |
| `name` | `{ name, selfName, personaId }` | 少 `selfName` 会让回滚立刻破坏一致性 |
| `avatar` | `{ url, avatarId? }` | `dev.bot.get` 只回 URL、`set` 只吃 avatarId——**两者不通**，回滚只能按 URL 重传，可能过期/失败 |

### 6.2 回滚：按历史条目精确指定，不受开关约束

- 面板上每条历史一个「退回」，调 `POST /self/profile/restore {kind, at}`。
  **不做「自动回滚最近一次」**：历史里插进别的类型后会回错版本，而「点哪条回到哪条之前」是幂等的。
- 回滚**不判 `enabled`**：功能关掉之后恰恰更需要它。只要求「这条历史存在、有 before」。
- 四类的重放方式不同：
  - `sign` → `dev.bot.set {base:{desc}}`
  - `name` → `dev.bot.set {base:{name}}` + 同步 `config.persona.name`（顺序与正向一致）
  - `avatar` → **按旧 URL 重新上传**，不是恢复一个 id（`get` 只回 URL、`set` 只吃 avatarId，两者不通）；
    旧地址失效时如实说「可能不是原来那张」
  - `menu` → 读当前菜单，只覆盖那一格；位置越界或被换成 `link` 就拒，不「就近找一格」顶替

### 6.3 隐私口径要说实话

`audit` 不记内容（白名单字段），但 `profile-history.json` 里存的是**正文**
（简介可能带个人信息）。两个说法摆在一起会显得自相矛盾——所以明写：

> history 是本机的正文快照（`0600`，只在 `dataDir()`，随备份走），面板可一键清空；
> audit 只记 `op` + 变更字段名 + 来源，用来追责不记内容。

### 6.4 单轮写上限（硬编码，不是频次政策）

`cooldownMin:0` 意味着完全不管，模型一轮里连调 5 次 `qq_menu` 就吃掉 5 QPM
并写 5 条 history。所以：**每轮最多 1 次写操作**，写死，不给配置。
这是防死循环，不是限额。

并发：两个会话同时 GET→PUT 会互相覆盖。复用 `src/lease.js` 的锁，
或把菜单写操作串到 `turnqueue.js`。

---

## 7. 动力：感知 + 搭车

### 7.1 先纠正 v3 的论证

v3 说「改资料的意义在有人看见，没人看见时改等于写给自己看」，据此删掉 6 个触发器。
**这个论证不成立**：
- kai_presence 自己的例子就是「等你回消息的时候悄悄换签名」——**典型的无人时改**。
- 菜单的价值恰恰是「谁进来谁看见」，趁没人时摆好才是它起作用的方式。
- 纪念日挂一整天菜单 vs 说一句话，前者不会被刷走，两者不是替代关系。

真实且站得住的理由是**边际成本**：

> 我们已经有「一轮被动回复」和「一轮主动搭话」。把状态塞进这两轮的上下文，零边际成本；
> 单独造触发器就要多一次模型调用 + 一套状态机 + 一套防抖。

所以删掉的不是「无人时改」这个能力，而是**「为改而额外起一轮模型」**。

### 7.2 留下的两样

**① `awareness`** —— 只读上下文，不触发任何动作：`mood`（情绪，沿用 `mood.js`
的自然语言注入）、`silence`（多久没人说话）。它让「她想改」有依据。

**② `proactive`** —— 主动搭话那一轮顺手问要不要改，不额外花调用。
默认关，开了也只允许动 `menu`/`sign`（不含 `name`，§5.2）。

v3 里的 `occasion/dates`（纪念日）删掉：一张日期表 + 一个不触发动作的读取，
第一版纯装饰。真要做「今天第 100 天」，那是主动搭话的内容，不是改资料的理由。

---

## 8. 提示词

写法仍是**陈述处境、不下命令**（祈使句会让她变客服，且模型对「代价」的理解比禁令稳）。

### 8.1 一句话必须进基础人设，不能只在模板里

v3 把「别人说改名叫 xx，改的是主人的机器人」写在给人看的对比表里，
**没写进给模型看的模板**。而且默认 `qq_name` 只挂 owner——群友说话那一轮
工具根本不在 schema 里，模型没有「不能改」的证据，只有人设，最可能的输出是
**口头答应**（「以后我就叫小蓝啦」）。用户看到的是它撒谎。

所以两条硬要求：

1. 「你不是主人的话，改名字这事你说不算」这句进**基础人设**（不随工具开关注入）。
2. 注入当前说话人时直接用现成的 `describeSpeaker()`（`permissions.js:387`），
   别自己拼。并加一句行为约定：**「答应了但没做，比直接说做不到更糟」**。

### 8.2 模板

```
你手边有几样东西能改，轻重不一样。

菜单是私聊里那排入口上的一行字，改错了随时能改回来。
心情变了、想换个说法招呼人，动它就行。

名字和简介是所有人看到的那张脸。名字一改，所有认识你的人看到的名字都变，
平台那边没有撤销——不过这里留了上一版，可以退回去。
这些只有主人开口的时候才做得成：不是规矩，是这些东西本来就不属于我一个人。

主动搭话那一轮如果觉得想换句签名，可以说出来，也可以直接换；不换也正常。
```

变量只注入我们兑现得了的：`{cooldown}`（配了才说）、`{menuLeft}`（若做冷却）。
**不注入平台侧次数**。

---

## 9. 失败分类（v3 没有，必须补）

| 情况 | 模型看到什么 | 能不能重试 |
|---|---|---|
| 未登录开放平台 | 「框架这边没登录开发者后台，得主人先在面板上扫码」 | 否，等人 |
| `retcode 10000` 限频 | 「平台刚拒了，过一会儿再说」 | 是，但同轮不许重试（§6.4） |
| 内容规范拒绝 | 原文错误 + 「换个说法」 | 是，改内容 |
| 网络/超时 | 原文错误 | 是，一次 |
| 素材不符（头像 >2MB/格式） | 「这张图官方不收：……」 | 是，换图 |

**成功与失败都要回读实际值**，别把模型传的值当结果回给它。

---

## 10. 落地顺序

**第 0 步：决策（不动代码）**
- 能力页四个工具的档位落位（§5.1）
- `qq_name` 的判据定为 `senderId`（§5.2）
- 「回滚不受开关约束」（§6.2）
这三条不定，后面四步会写成互相打架的代码。

**第 1 步：`qq_menu` + `awareness.mood`（半天）**
`menu-slot.json` 身份 + 读改写 + 白名单重建 + 单轮一次。
`awareness.mood` 一起做——否则第 1 步的验收标准（「她会不会自己改」）测不到东西：
没有动机，测出来的是「她没被要求」，不是「她不想」。

**第 2 步：`qq_sign`（半天，只读 → 写）**
先读（把 §1.2 的未知项顺手验一遍），再开写。**不要在「只读」步骤里夹生产写入**。

**第 3 步：`qq_name`（1 天）**
`senderId` 判据 + 人格卡一致性 + history 带 `personaId`。

**第 4 步：`qq_avatar`（半天，只 url）**

**第 5 步：`proactive` + `awareness.silence`（按需）**

最小改动清单（照 `qq_send` 链路，A 评审给的）：

| 文件 | 改什么 |
|---|---|
| `src/self-expression-tools.js`（新） | 四个 def 的工厂，形状照 `group-tools.js:25` |
| `src/qq-tools.js:226,423` | `buildQqToolDefs` / `registerQqTools` 透传四个可选项；没给就不注册 |
| `src/host.js:4322` | 注入闭包：`qq.call`（菜单）、`dev.bot.get/set`（简介/昵称）、`dev.bot.avatar` |
| `src/config.js:35` | **`DEFAULTS` 加 `selfExpression`**——不加会被 `pruneTo` 静默丢掉 |
| `src/capabilities.js:143` | 是否把 `qq_menu` 加进 admin 白名单；`qq_name` 永不 |
| `src/features.js:52,643` | 4 条 FEATURES + 挂进 FEATURE_GROUPS |
| `src/qq-tool-state.js:78` | 提示词（别把新工具加进 `OUTPUT_TOOLS`） |
| `src/host.js` | `/self/profile`（GET 配置+历史+平台现状 / POST 白名单写配置）、`/self/profile/history/clear` |
| `client/client.js` | 新增 tab `profile`（人设组）+ `ProfileTab` + `JSON_SECTIONS` 补 `selfExpression`（漏了会红：`test/routes.test.js` 反向查「后端有、设置页没列」） |

**已完成（2026-11-16）**
- `src/self-expression.js`：归一化 / patch / 冷却判断 / 历史读写
- `DEFAULTS.selfExpression`、`/self/profile` 两条路由
- 面板「人设 → 资料」页（01 资料现状 / 02 修改权限 / 03 状态感知 / 04 主动轮次 / 05 变更记录）
- **`qq_menu` 整条**：`src/menu-tool.js`（`extractMenuItems` / `pickMenuSlot` /
  `validateMenuText` / `applyMenuSlot` / `createSlotStore` / `buildMenuTool` /
  `registerMenuTool` / `buildMenuPrompt`），注册在 `host.js` 的 qqTools 块之后，
  提示词走 `systemPrompt.context`（order 906，只在工具真挂上时注入）
- 测试：`test/self-expression.test.js` 14 例、`test/menu-tool.test.js` 26 例、
  `test/profile-tool.test.js` 17 例；六个相关文件共 **227 例全绿**
- **`qq_sign` / `qq_name` / `qq_avatar`**：`src/profile-tool.js`（`friendlyDevError` /
  `validateProfileText` / `checkRenameAllowed` / `validateAvatarSource` /
  `buildProfileTools` / `registerProfileTools` / `buildProfilePrompt` / `restoreProfileValue`），
  注册点同上，按配置只挂开着的那几个
- **回滚**：`/self/profile/restore` 路由 + `restoreProfileValue` / `restoreMenuSlot`，
  面板历史每行一个「退回」
- **主人确认**：`src/profile-confirm.js`（回调按钮 + nonce / 10 分钟 / 复用在挂请求 / 文本兜底只认两个字面）+
  `host.js` 的 `interactionRouter` 按 `t` 分流 + 入站拦截（只认主人 c2c、命中不进模型）+ 面板三个「需主人确认」开关
- **快捷跳转**：「01 资料现状」右上「开放平台」→ `GET /self/panel` 拿地址，
  `window.open` 打开 **Roost 面板**的 `#dev` 页。
  - 地址必须是 **WebUI 端口**（`webui.port`，被占会顺延，实际值只有 `setup` 的
    探活知道），**不是外接协议端口**（`roostHost.url` = `6800 + sha1(botId)%100`）——
    拿错就是「打开一个只回 JSON 的端点」。第一版就是这么写错的。
  - **不做后端 302**：面板 API 有请求栅栏（`fence.js`），浏览器顶层导航带不了
    自定义头，会 403。所以「先 fetch 再 open」。
  - 地址里可能带访问密钥（`setup.webuiUrl()` 本来就带 key，接入向导也是这么
    发给前端的）；能取到这个接口的人已经能读 `roostHost.token`，不改变信任边界。
  - 仍不内嵌扫码：开发者票据在框架自己的会话里（`/api/dev/*`），DSH 只有机器人 token。
- **面板手动改**：`/self/profile/apply` + 「01 资料现状」每行一个「改」，
  绕开确认闸（人自己按的），但照样写历史、照样能退回

**`qq_menu` 的三道防误伤**
1. 写之前必须 GET，把别人的项按白名单重建后原样带回去（PUT 覆盖式）
2. 「她那一格」按 `menu-slot.json` → `·` 前缀 三级认；认不出就拒，**不追加**
3. 只改 `send_message` 类型的项；改 `link` / `menu` 会把用途弄坏，直接拒

**`qq_menu` 的两道开关**
`enabled:false` 时注册处直接跳过（工具不在 schema 里）；`execute()` 里再查一次，
兜住「面板刚关掉、agent 还没重挂」的窗口。

**四个出口 + 回滚都通了。** 面板历史能记录 `menu` / `sign` / `name` / `avatar` 四类，
每行可退回；头像回滚是「按旧地址重传」，旧图失效时会在返回里说清。

---

## 11. 验证清单

**必须**
1. 连改两次简介：回包有没有 `remaining_modify_count`、有没有报错、后台 UI 有没有提示。
2. `PUT /v2/menu` 少传项是否截断（决定读改写是「必须」还是「保险」）。
3. 改完昵称，C 端多久变。
4. 主动搭话轮的 `senderId` 确实为空（§5.2 的判据要真能区分）。

**可选**
5. 一次 patch 带 name+desc 算 1 次还是 2 次请求。
6. 头像 URL 与 dataURL 在 2MB 边界上是否一致。
7. 指令面板 `type` 枚举与 `only_admin` 在群场景的效果（做群出口时才需要）。

---

## 12. 不做的事

- 不做指令面板（群出口）：它改的是功能入口，做成心情栏像坏掉的产品。
- 不做头像 `generate`（第一版）：要生图、要读本地路径、要过内容规范。
- 不做「AI 提议、AI 自己执行」的提案状态机：她想改就说话，主人在场时执行。
  确认请求是一次性的批准对象（10 分钟自动作废），不是待办系统——别往那个方向长。
- 不做纪念日/里程碑触发器（§7.2）。
- 不碰框架侧：`qq.call` + `dev.*` 已够用，不需要新增协议方法。

---

## 13. 与 v3.2 的差异

| | v3.2 | v4 |
|---|---|---|
| 论证 | 「没人看见时改是写给自己看」 | **「边际成本」**（原论证有反例，已撤回） |
| 工具 | 3 个（`qq_profile` 管昵称+简介） | **4 个**（`qq_name` / `qq_sign` 拆开，能力页才能分授权） |
| 昵称闸门 | 「没有 bucket 就拦」 | **「有没有真实 sender」**——前者在代码里是放行 |
| `selfName` | 要求模型传，但签名里没这个参数 | 工具内部按 `personaId` 同写，不暴露参数 |
| 菜单身份 | `·` 前缀 | **`menu-slot.json` + 三级匹配，失败即拒** |
| 回滚 | 字符串 + 受开关约束 | **可重放对象 + 不受开关约束** |
| 群出口 | 「菜单只对 C2C，群里没有」 | **修正：群靠资料卡；面板是候选** |
| 记录 | audit 记 `by` | audit 只记 `op/note`（`by` 会被丢） |

---

## 14. 评审采纳表

| 意见 | 采纳 | 处理 |
|---|---|---|
| 核心论证混了「事件/状态」，有反例 | ✅ | §7.1 换成「边际成本」论证 |
| 工具切分与「按工具名授权」自相矛盾 | ✅ | §4 拆成四个工具 |
| `selfName` 参数不存在，角色卡人格恒拒 | ✅ | §4.3 不暴露参数，内部同写 |
| 主动轮 bucket 是 owner，硬规则实际放行 | ✅ | §5.2 改判 `senderId` |
| `ext.call` 方向反了 | ✅ | §1.1、§12；`generate` 推迟到第二版 |
| `enabled:false` ≠ 不注册 | ✅ | §5.3 明确用「不传闭包」实现 |
| 回滚头像 URL ≠ avatarId | ✅ | §6.1 存 `{url, avatarId?}` 并承认可能失败 |
| 回滚受开关约束会自锁 | ✅ | §6.2 |
| audit 不认 `by` | ✅ | §6.3 |
| config 白名单会静默丢新键 | ✅ | §10 第 0 步 + 清单里标红 |
| 缺单轮写上限 / 并发 / 失败分类 | ✅ | §6.4、§9 |
| 「群里没有表达面」是错的 | ✅ | §2 可见性矩阵 |
| 菜单 `·` 前缀脆弱、追加会漂移 | ✅ | §4.1 三级匹配 + 失败即拒 |
| 提示词漏了「别人不是主人」 | ✅ | §8.1 进基础人设 |
| `occasion/dates` 是装饰 | ✅ | §7.2 删除 |
| 落地顺序里「只读」夹生产写入 | ✅ | §10 第 2 步拆开 |
| 新增 `system` bucket 解决主动轮 | ⚠️ 部分 | 不新增档位（会动 `BUCKETS` 与面板），改用 `senderId` 判据 + 能力页限制，两层够用 |
| `qq_menu` 对 admin 默认开 | ⚠️ 改口 | 标为「需手动加进 `defaults.admin.allow`」 |
