# 第三方组件署名与许可（THIRD-PARTY NOTICES）

本仓库主体为 AGPL-3.0（见 `LICENSE`），但 `src/purpose-engine.js` 的纯逻辑核心移植自下列 MIT 项目。按 MIT 许可要求，在此逐文件署名并附许可原文。

## Mieksido/surfcore — 目的引擎（MIT）

- 上游项目：<https://github.com/Mieksido/surfcore>
- 中间项目：Aurabot（`dsh-aurabot-qq` beta）
- 移植范围：
  - `src/purpose-engine.js`：目标假设生成闭包（归属判定、置信度、证据去重、观察账、主人反馈结算），抽自 `aurabot-beta/src/purpose/engine.js`。
  - `src/autotelic-constraint.js`：约束解析与前置否决硬校验，抽自 `aurabot-beta/src/autotelic/constraint.js` 的纯函数区。
  - `src/autotelic-plan.js` + `src/autotelic-tags.js`：三段决策的判据常量与解析层（parseIntents / parseGateVerdicts / GATE_CRITERIA / buildTicket / tag 词表），抽自 `aurabot-beta/src/autotelic/plan.js` 与 `tags.js`。
  - `src/autotelic-exec.js`：执行三级分级与五类硬禁区检测（isForbidden / LEVELS），抽自 `aurabot-beta/src/autotelic/exec.js` 的纯函数区。
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
