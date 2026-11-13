# 记忆编辑能力对照：aurabot vs dsh-roost（2026-11-13）

> 主人问「aurabot 是不是还有编辑功能，我们没有」。核对两边源码后的清单。
> 结论：**是的，aurabot 的记忆星图带一套完整的逐条编辑；我们只有「加 / 删 / 清」**。
> 本轮只出清单与可行性，没有擅自加后端接口。

## 一、aurabot 星图点开一颗星之后能做什么

来源：`dsh-aurabot-qq-beta/client/client.js:6230–6290`（详情卡 + 编辑框 + AddStarForm），
后端是 `/memory/graph/*` 一组路由。

| 动作 | 按钮 | 后端 | 依赖的数据字段 |
|---|---|---|---|
| 复习 | 「还记得（复习）」 | `POST /memory/graph/review` | `brightness`（清晰度随时间衰减，复习拉回来） |
| 改层级 | 「临时 / 长期 / 永久」 | `POST /memory/graph/tier` | `tier: short\|long\|core` |
| 恢复 | 「恢复」（已归档/失效时出现） | `POST /memory/graph/restore` | `archivedAt` / `invalidAt` |
| 编辑 | 「编辑」→ 改文字 + 重要度 → 保存 | `POST /memory/graph/update` | `text` / `importance` |
| 删除 | 「删除」 | `POST /memory/graph/remove` | — |
| 新增 | 「在星图上加一颗」 | `POST /memory/graph/add` | `text` / `importance` / `tier` |
| 重新布局 | 「重新布局」 | `POST /memory/graph/optimize` | 3D 星团坐标 |
| 筛选 | 类型 / 层级 / 只看快忘了 / 最近 7 天 | 前端 | `type` / `tier` / `brightness` / `at` |

星图显示开关：自动旋转、辉光、动态星尘、关系线（含「只在选中时 / 微光 / 标准」+ 强度滑杆）、
左上角可展开的层级清单与星团列表。

## 二、我们现在有什么

| 动作 | 在哪 | 走什么 |
|---|---|---|
| 加一条事实 | 记忆页 01 / 星图「加上去」 | `POST /memory/add` |
| 删一条事实 | 记忆页 01 每行「删」/ 星图点星「忘掉这条」 | `memory.remove` |
| 清空 | 记忆页 06 | `memory.clear` / `purge` / `clearGlobal` |
| 删关系 / 标「现在不成立」 | 记忆页 03 | `graph.suppress` / `graph.close` |
| 撤销屏蔽 / 清空人物档案 / 清空经历 | 记忆页 | 已有 quick ops |
| 被取代的事实 | 记忆页 01「历史」折叠区 | 能看、能删，**不能恢复** |
| 召回预览 / 召回参数 | 记忆页 05 | `/memory/recall-preview` |
| 星图交互 | 记忆页顶部 | 2D/3D、自动旋转（3D）、辉光、关系线、名字、搜索、区域筛选、快忘/最近 7 天、重置视角 |

**没有**：改文字、改重要度、复习、层级、恢复、（星尘动画 3D 我们也做了静态星尘，没有流动动画）。

## 三、为什么不能「顺手照搬」

不是调用方式不同，是**数据模型不同**：

- aurabot 每条记忆是一条独立记录，带 `id / text / tier / importance / brightness / archivedAt / cluster`。
  所以「按 id 改一个字段」是天然操作。
- 我们的事实是 `memory.json` 里按会话分组的**字符串数组** + `meta[正文] = { w, at, src, until }`。
  没有 id、没有 tier、没有 archivedAt、没有 importance（只有 `w`，由「被反复提到」自动累加）。
  `w` 还同时服务淘汰（`scoreOfFact` = w × 0.5^(age/40天)）——手工改它等于同时改「她觉得多重要」和「会不会被挤掉」，
  两个语义粘在一起，照搬 aurabot 的 importance 滑块会骗人。

另外「不造假维度」是这轮星图已经守住的线：星图的六个区域用的是**真实存在的来源**
（跨群事实 / 本会话事实 / 已被取代 / 重要日记 / 人物与实体 / 熟人档案），
没有凭空造 `tier` / `importance` 给筛选和滑块用。

## 四、要补齐的话，各自要动什么

| 想补的能力 | 最小正经做法 | 代价 |
|---|---|---|
| 编辑文字 | 新增 `memory.update({ scope, chatId, oldText, newText })`：改数组里的字符串 + 搬 `meta` 键，保留 `w/at/src/until` | 中；要处理同名冲突、`until` 历史行、别名键 |
| 改重要度 | 拆开 `w`：新增 `pin`（用户钉住的权重）与自动 `w` 分开，`scoreOfFact` 用 `max(w, pin)` | 中；改淘汰口径，必须有「升级前后召回结果不变」对照测试 |
| 复习 | 复用 `journal.accessed` 的计数机制，给事实加 `lastReviewedAt` | 小；但要先定义「复习了到底改变什么」——现在事实没有衰减可见度，复习没有可拉回来的量 |
| 层级 / 恢复 | 等于引入新数据模型（tier + archivedAt），并给所有读取路径加过滤 | 大；会动记忆库键结构，必须先定旧数据怎么迁移 |
| 删了再恢复 | 现在 `memory.remove` 是真删；要做恢复得先改成墓碑制 | 大；和「忘掉就是别再记」的现有语义冲突 |
| 星尘流动动画 | 纯前端，rAF 里画慢速漂移 | 小；但 3D 自动旋转已经在跑，再加逐帧动画要多一个开关 |

**建议顺序**（如果主人要补）：先做「编辑文字」（用户最常遇到的是记错了），再做「复习 + 可见的清晰度」，
层级/恢复留到最后——它们要改数据模型，和 4.5 人格隔离一样属于要拍板的迁移类改动。

## 五、这轮已经复用的现成方案

- 3D 透视投影照 `aurabot-beta/client.js:5137 smDraw` 的 yaw/pitch + 透视除法 + depth 裁剪。
- 星图工具条形态（搜索 / 区域 / 快忘 / 最近 7 天 / 显示开关 / 重置视角 / 点星详情 / 加一颗）按同一个交互骨架。
- 官方 `is_wakeup` 的四个窗口按 QQ 开放平台文档原文实现，没按「30 天 ÷ 4」想当然。
