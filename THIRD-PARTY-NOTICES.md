# 第三方组件署名与许可（THIRD-PARTY NOTICES）

本仓库主体为 AGPL-3.0（见 `LICENSE`），但 `src/purpose-engine.js` 的纯逻辑核心移植自下列 MIT 项目。按 MIT 许可要求，在此逐文件署名并附许可原文。

## Mieksido/surfcore — 目的引擎（MIT）

- 上游项目：<https://github.com/Mieksido/surfcore>
- 中间项目：Aurabot（`dsh-aurabot-qq` beta）
- 移植范围：
  - `src/purpose-engine.js`：目标假设生成闭包（归属判定、置信度、证据去重、观察账、主人反馈结算），抽自 `aurabot-beta/src/purpose/engine.js`。
  - `src/autotelic-constraint.js`：约束解析与前置否决硬校验，抽自 `aurabot-beta/src/autotelic/constraint.js` 的纯函数区。
  - `src/autotelic-plan.js` + `src/autotelic-tags.js`：三段决策的判据常量与解析层（parseIntents / parseGateVerdicts / GATE_CRITERIA / buildTicket / tag 词表），抽自 `aurabot-beta/src/autotelic/plan.js` 与 `tags.js`。
  - `src/autotelic-exec.js`：行动单执行器 createExecV5 全文件（三级分级、五类硬禁区、确认队列、时间戳快照、终态回调），整文件抽自 `aurabot-beta/src/autotelic/exec.js`。
  - `src/autotelic-planner.js`：三段决策运行时 createPlanner / reviewRound，抽自 `aurabot-beta/src/autotelic/plan.js`。
  - `src/autotelic-decisions.js`：decisions.jsonl 哈希链决策审计，抽自 `aurabot-beta/src/autotelic/plan.js` 的 createDecisionLog / verifyDecisionLog。
  - `src/autotelic-feedback.js`：反馈回路（抑制/偏好/冷度/park/熔断/24h 频控），整文件抽自 `aurabot-beta/src/autotelic/feedback.js`。
  - `src/autotelic-skills.js`：三层技能体系 createSkillStore（晋升/快照/score 只锚真实终态），抽自 `aurabot-beta/src/autotelic/skills.js` 的 v5 接口区（文件尾 P3.1/P4.2 旧接口未移植，我方无消费方）。
  - `src/autotelic-store.js`：readJson/writeJson 语义适配，对齐 `aurabot-beta/src/core/store.js`（BOM 处理 + 重试 + tmp/rename 原子写），写盘复用本仓 atomic.js。
  - `src/reminder-store.js`：小闹钟数据层（时间解析 / normalize / prune / add / close / 失败重试状态机），移植自 `aurabot-beta/src/purpose/module.js` 的小闹钟段。
  - `src/nudge.js`：追问判据 judgeNudge / 标记存储 / 提示词，移植自 `aurabot-beta/src/purpose/module.js` 的 maybeNudge 与 nudgePrompt 口径。
  - `src/takeover.js`：收窄版接管——借鉴 `aurabot-beta/src/modules/autotelic/index.js` 的 takeover 思路，只保留白名单式 seeds 写入 + 冷却 + 变更历史，权限/配置/工具字段一律不接管（我方刻意收窄，非逐字移植）。
- 接线层 `src/purpose-collect.js`、`src/host.js`、`src/purpose-state.js`、`src/autotelic.js` 是我方为 dsh-roost 新写的，不属于移植范围。
- 移植方式：按顶层声明边界原样抽取函数体（脚本配对），避免手抄走样；仅改文件头署名与模块语境。

上游原许可全文：

```text
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Aurabot contributors — 目的引擎改写（MIT）

- 项目：`dsh-aurabot-qq`（beta 工作树）
- 许可：MIT，Copyright (c) 2026 Aurabot contributors
- 改写范围：把 surfcore 的 purpose-engine 按 Aurabot 模块与配置语境改写为我方抽取的 `src/purpose/engine.js`；本次从其生产版本抽取闭包到本仓。

原许可全文：

```text
MIT License

Copyright (c) 2026 Aurabot contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
