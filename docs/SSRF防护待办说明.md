# SSRF 防护：现状、缺口与建议边界

> 本轮**只出说明，不改代码**。依据：`docs/腾讯官方QQBot插件源码对照.md` §3.7 / §8-D、
> 两个官方仓库 main 分支源码、以及本仓 2026-11-15 实核的行号。
> 定位：P1 建议里唯一「抄思路但要补严」的一项，因为**全局拦截会砍掉现有功能**。

---

## 1. 我们要防的到底是什么

不是「有人从外网打进来」，而是**从我们自己的进程里发出去的请求被打到内网**。

能控制 URL 的来源有两个：

| 来源 | 入口 | 谁给的 URL |
|---|---|---|
| QQ 事件里的图片 / 附件 | `dsh-roost/src/roost-payload.js:327` `urls = …map(a => a.url)` → `:350` `fetchImpl(urls[i])` | 群成员（QQ 网关转发） |
| 模型 / 扩展给的图片地址 | `bot/src/host/media.js:212`、`:252` 的 `assertUrl()` | 模型输出、扩展入参 |

QQ 的附件 URL 通常是 `multimedia.nt.qq.com` 之类，但**字段本身是事件里带来的字符串**，
模型输出更是完全不可信。一个 `http://169.254.169.254/latest/meta-data/…` 或
`http://127.0.0.1:8080/admin` 就能让框架代替攻击者去访问本机/云元数据/内网服务，
响应还可能被回显进模型上下文。

---

## 2. 我们现在的实际防护（几乎没有）

- `bot/src/host/media.js:73-84 assertUrl()`：**只校验协议**是 `http:` / `https:`，
  不解析域名、不判内网 IP。注释写「不接受 file:// / 内网探测以外的怪协议」，
  但代码里**没有内网判定这一行**。
- `dsh-roost/src/roost-payload.js:324` 注释明说「不走 roost 的 media.fetch，直接抓 QQ 的 URL」
  —— 也就是说**看图这条主路径连 `assertUrl` 都绕过了**，直接 `fetch(外部 URL)`。
- `guessMime` / `sniffImageType`（C 批、P2 批）只判下载**回来之后**的字节，
  防的是格式错，不是请求打去哪。
- 唯一的限制是 `MAX_BYTES = 2MB` 和 `AbortSignal.timeout(8s)`，那是防撑爆和卡死，不防 SSRF。

**结论：目前任何内网地址都能被直接请求。**

---

## 3. 两家官方仓库怎么做的（以及各自的漏洞）

### openclaw-qqbot 有**两套独立实现**

| | 出站 `src/utils/ssrf-guard.ts` | 入站 `src/adapter/media.ts:44-72` |
|---|---|---|
| 协议 | `http:` / `https:` | 降级 fetch 只允 `https:` |
| 拒绝网段 | IPv4 `0.0.0.0`、`127.`、`10.`、`192.168.`、`169.254.`、`172.16-31`；IPv6 `::1`、`::`、`fe80:`、`fc/fd` | 同一张表 + **`224.0.0.0/4` 组播** |
| QQ 白名单 | 6 个官方域名免 DNS 直接放行（支持一级子域） | — |
| DNS 解析方式 | `dns.resolve`（**只查 A 记录**） | `dns.promises.resolve4` |
| DNS 失败 | **`console.warn` 后放行** | **直接抛错拒绝** |
| 调用方 | 出站媒体 `image-size.ts:25` / `media-send.ts:208` | 附件下载 |

**四个可绕过缺口**（`ssrf-guard.ts` 侧，抄的时候必须补）：

1. 只查 A 记录 → IPv6 内网地址 / AAAA-only 域名直接绕过；
2. DNS 解析失败时**放行**（仅当错误信息含「内网」才继续抛）→ 构造解析失败即可穿透；
3. **不校验重定向** → 白名单域名 302 到 `169.254.169.254` 就绕过了；
4. **DNS rebinding / TOCTOU**：先 `dns.resolve` 校验、再 `fetch`（fetch 会重新解析），
   两次解析之间攻击者把域名换到内网 IP 即可。校验与请求没有绑到同一个 IP。

### dsh-qqbot 侧

`src/transport/attachment.ts` 自带 SSRF：仅 `https:`、`PRIVATE_RANGES` 比 openclaw
**多含 `224.0.0.0/4` 组播段**、`DOWNLOAD_TIMEOUT_MS = 120_000`、`DEFAULT_MAX_MB = 200`。
两家是各自独立实现，没有共用。

### 值得抄的共识

- **出站与入站分开校验**，两张表、两套失败策略（入站更严是对的）；
- **QQ 官方域名白名单**免解析，避免给正常图片增加 DNS 开销；
- 拒绝 `169.254.0.0/16`（云元数据）和 `224.0.0.0/4`（组播）。

---

## 4. 为什么不能「全局 fetch 拦内网」（最关键）

本地已有**合法的本机流量**，一刀切会直接砍功能：

| 真实配置 | 位置 |
|---|---|
| `http://127.0.0.1:7890` 代理示例 | `bot/src/config.js:116` |
| `host: '127.0.0.1'`（面板/宿主监听） | `bot/src/config.js:26/71/276/320` |
| `dshUrl` 默认指向本机宿主 | 配置链路 |

面板 ↔ 宿主互调、代理出站、DSH RPC 全走 `127.0.0.1`。
**任何在 `globalThis.fetch` 或 `assertUrl()` 上做的统一拦截，都会把这些一起挡掉。**

---

## 5. 建议的落地边界（如果以后要做）

1. **只对「不可信来源 URL」校验**，两条路径各自收口，不动全局 fetch：
   - `roost-payload.js:350` 的图片下载（QQ 事件带来的 `a.url`）；
   - `media.js:212/252` 的 `assertUrl()`（模型/扩展给的 URL）。
   - 代理、`dshUrl`、面板互调走**另一条内部路径**，白名单放行，完全不经过这层校验。

2. **校验顺序**：协议白名单 → 主机名在 QQ 官方域名白名单则直接放行 →
   否则 `dns.promises.lookup(host, { all: true, verbatim: true })` 拿**全部 A + AAAA** →
   逐条判保留网段（IPv4 含 `224.0.0.0/4`；IPv6 含 `::1` / `::` / `fe80::/10` / `fc00::/7` / `::ffff:127.0.0.1` 等映射地址）→
   **解析失败即拒绝**（对齐入站那套，不是出站那套）。

3. **把校验与请求绑到同一 IP**：用自定义 `dispatcher` / `lookup` 固定已校验的 IP，
   而不是「先查一次、再让 fetch 自己解析一次」；同时**逐跳校验重定向**
   （`redirect: 'manual'` 自己跟，每跳重新走一遍校验，上限 3 跳）。
   这一步同时堵住 rebinding 和重定向绕过，是两家官方实现都缺的。

4. **QQ 附件下载目录隔离**：`downloads/{appId}/{peerId}/`（CHANGELOG 1.6.6 的描述，
   main v2.0.4 实际并未按此分段，见对照报告 §3.7）。这是「不同 bot / 不同会话不互相读到文件」，
   与 SSRF 互补但不同层，别混为一谈。

5. **失败要可见**：拒绝时 `log.warn` 写清域名与命中网段，别静默吞——
   否则用户只看到「图没取到」，无从排查。

---

## 6. 优先级判断

不进当前批次，理由是**改动边界比 A~G / E / P2 都大**：

- 要同时改 `bot`（`media.js`）和 `dsh-roost`（`roost-payload.js`）两个仓；
- 要新增 DNS 解析依赖与 dispatcher 绑定，属于新的安全基础设施；
- 必须配「内网白名单 + 重定向逐跳」的测试矩阵，且**真机验证代理与 `dshUrl` 不受影响**；
- 官方两家实现本身就有 4 个可绕过缺口，照抄等于把漏洞一起搬进来。

建议单独立一批，先写 `test/ssrf-guard.test.js` 钉死网段表与失败策略，再改两处调用点。

---

## 7. 1.3.2 落地记录（2026-11-15）

1.3.1 上线后被两个真实场景打回来，本节是实际改法，前面的分析保留作背景。

### 7.1 现场：fake-ip 代理把插件市场整个打死

报错：`域名解析到内网地址 198.18.0.32，拒绝访问`（`ssrf.js` 的逐 IP 判定抛的）。

- 插件市场索引 `raw.githubusercontent.com`、分发包 `codeload.github.com`；
- Clash / mihomo 的 fake-ip 模式默认 `fake-ip-range: 198.18.0.1/16`，域名一律解析成假地址；
- `isPrivateIp` 把 `198.18.0.0/15`（RFC 2544 benchmark 段）当保留段硬拒 → 挂了代理的用户**必然**打不开市场。

结论：不是网络问题，是「校验假设公网解析」与「国内必须挂代理」的结构性冲突。

### 7.2 改法

| 改动 | 位置 | 说明 |
|---|---|---|
| `trustedHosts` | `ssrf.js` | 代码里写死的供应链主机**跳过 DNS 逐 IP 校验**，协议 / 端口 / 凭据 / 字面 IP 照旧判。四个域名 + 索引 URL 的 host |
| `allowPrivate` 语义 | `ssrf.js` | 只放开 `isLanIp`（10/8、172.16/12、192.168/16、100.64/10、fc00::/7）；回环、169.254、198.18 等保留段仍拦 |
| `blockedIp` | `ssrf.js` | 唯一裁决点，替代散在两处的 `isPrivateIp + allowLoopback` 组合 |
| `allowHosts` 收紧 | `ssrf.js` | 不再豁免字面内网 IP（1.3.1 里白名单分支在前，`allowHosts:['127.0.0.1']` 能整道绕过） |
| 接线 | `host.js` / `ext-market.js` | 1.3.1 的 `config.security.ssrf` **是死配置**：`allowPrivate` / `allowHosts` 写进磁盘后无人读。现在 `createExtMarket({ ssrf: () => cfg.security?.ssrf })`，每次出站重算白名单 |
| 面板 | `client.js` `SecurityTab` | 从只读改成真开关（`saveCfg` 深合并、危险命令关闭要二次确认、白名单可编辑） |

### 7.3 仍未做（维持 §6 的优先级）

- 校验与请求绑同一 IP（自定义 `dispatcher`）：`trustedHosts` 放行的主机不再解析，但**用户白名单里的域仍是「查一次再 fetch 再解析一次」**，rebinding 窗口还在；
- 重定向逐跳校验：现在靠 `assertSafeTarballUrl(res.url)` 事后补一刀；
- `bot/src/host/media.js` 的 `assertUrl()` 仍然只校验协议（模型给的图片地址那条路）。

### 7.4 测试

`test/safety.test.js` 新增 4 条：`allowPrivate` 的放开 / 不放开边界、`allowHosts` 不豁免字面 IP、
`trustedHosts` 跳过 DNS（用 `.invalid` 复现 fake-ip）、`marketGuardOpts` 的白名单过滤规则；
`test/client-render.test.js` 新增 1 条：安全防护页必须渲染出两个可点的 `role=switch`。

