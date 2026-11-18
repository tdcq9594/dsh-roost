## 这个 PR 做了什么

<!-- 一句话说清。如果修的是 Issue，写 Fixes #123 -->

## 验证方式

<!-- 怎么证明它是好的？跑了什么、看到什么 -->

- [ ] `npm test` 全绿
- [ ] 动过扩展文档/人格索引的：`npm run ext-docs:check` / `npm run persona-index:check`
- [ ] 界面改动附了截图

## 发版相关（如果这次要发新版）

<!-- 只有 bump 版本的 PR 才勾下面这些。普通改动不用管。 -->

- [ ] `package.json` 的 `version` 已按末位 +0.0.1 bump（**不要按 commit 前缀自动跳位**）
- [ ] `RELEASE_NOTES.md` 顶部已加 `## vX.Y.Z：...` 段，且段内有「一句话：」开头的一行
- [ ] notes 顶部版本号 = package.json 版本号

## 检查清单

- [ ] 改动范围就是这个 PR 说的，没有夹带无关修改
- [ ] 没有提交 `config/` `data/` `logs/` 里的文件
- [ ] **没有提交任何凭证**（AppSecret / AccessToken / 完整 openid）
- [ ] 新增配置项有默认值，旧配置能正常加载
- [ ] 破坏性变更已在描述里写明，并提供了迁移方式
- [ ] 相关文档已更新（README / docs）
- [ ] 新增依赖？—— 本项目零依赖，如有请说明理由
