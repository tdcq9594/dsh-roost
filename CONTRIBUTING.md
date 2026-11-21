# 参与贡献

现行链路是 Roost 框架外接协议 `roost-host/1` 直连，背景见
[接入说明](docs/接入说明.md) 与 [使用手册](docs/USER-MANUAL.md)。

欢迎提 issue、改文档、修 bug。这个仓库是零依赖的 DSH 插件，跑起来不需要 `npm install`，只要 Node 22+。

## 提问题 / 提需求

去 [GitHub Issues](https://github.com/roost-qq/dsh-roost/issues)。报告「没回话」「装不上」这类问题时，带上这四样能省掉一轮来回：

- 面板「日志」页里出错前后那几行（按级别筛一下）
- `config.json` 里 `server.port` / `server.token` 是否两边一致（**密钥贴出来前先打码**）
- 面板「概览」页里 Roost 直连是否显示已连上
- DSH 版本、Node 版本、操作系统

别把 AppSecret、共享密钥、openid 原文贴进 issue。

## 本地跑起来

```bash
git clone https://github.com/roost-qq/dsh-roost.git
cd dsh-roost
npm test
```

没有 dependencies，不用 `npm ci`。本地想挂到 DSH 里验证，用目录联结把 `node_modules/dsh-roost` 指到源码目录，重启 DSH 即生效；改了 `src/` 下的子模块必须重启进程，只点「重载」会是新入口配旧模块。

## 提 PR 前跑这五步

CI 会在 `main` 分支的 PR 上跑同样的检查（Node 22 / 24 矩阵），本地先过一遍：

```bash
# 1 语法：CI 会对 src/*.js、client/client.js、scripts/*.mjs 逐个跑
for f in src/*.js client/client.js scripts/*.mjs; do node --check "$f" || exit 1; done

# 2 全套单测
npm test

# 3 人格索引与文件一致（改了 personas/*.md 必须重算）
node scripts/build-persona-index.mjs --check
# 若上一条红了：
node scripts/build-persona-index.mjs

# 4 插件能否加载：假 ctx 真跑一遍 apply()，确认路由能注册
node scripts/dry-run.mjs

# 5 打包内容：files 字段漏文件，用户装上去就是坏的
npm pack --dry-run
```

第 3 步别跳过：`personas/index.json` 里的 sha256 对不上，用户点「从仓库更新」时会拿一个错哈希去校验下载内容，结果是所有人都装不上。

## 代码约定

- **保持零依赖**：`src/` 只准用 Node 内置模块，第三方包一律不进 `dependencies`。
- **纯逻辑抽成纯函数**：策略、权限、打分这类判定放在独立模块里，`apply()` 闭包里的东西测不到。配套单测放 `test/*.test.js`，用 `node:test` + `node:assert`。
- **注释用中文**，说明「为什么这么写」而不是复述代码；变量、文件名、命令保持原样。
- **改了行为就补测试**，尤其是降级路径、错误路径和跨轮状态清理。
- 前端 `client/client.js` 沿用 DSH 的主题变量，不要写死颜色。

## 提交与发版

- 默认分支 `main`；PR 目标选 `main`。分支保护已开：必须走 PR + CI 全绿才能合并。
- 文档细节放 [`docs/USER-MANUAL.md`](docs/USER-MANUAL.md)，README 只留概览和指向，别把手册又搬回 README。
- 提交信息用中文或英文都行，写清改了什么、为什么。

发版由 PR 驱动、CI 自动完成（`release.yml`），流程：

1. 要发新版时，在 PR 里 bump `package.json` version（末位 +0.0.1，**不按 commit 前缀跳位**），
   并在 `RELEASE_NOTES.md` 顶部加 `## vX.Y.Z：...` 段、段内写「一句话：」。
2. PR 打上 `release` 标签、合并进 `main` 后，`release.yml` 校验版本/notes 一致 →
   **自动建 tag + Release + 发 npm**（`Release` environment 只用来挂密钥，无需人工审批）。
3. **不要手动 `git tag` 或 `git push origin vX.Y.Z`**——tag 由 CI 建，手动推会造成内容未校验的坏状态。
4. 外部贡献者不要自行 bump 版本或发版——版本决策由维护者做；上面的流程是维护者发版时走的。

## 许可

沿用 [Roost](https://github.com/roost-qq/qq-bot-roost) 的 **AGPL-3.0-only**（全文见 [LICENSE](LICENSE)）。你提交的贡献按同一许可授权；通过网络提供服务时，同样要以 AGPL-3.0-only 开源并提供完整对应源码。
