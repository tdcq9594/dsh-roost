// dsh-roost · 网页半边：侧栏「Roost」入口 + 整页面板
//
// 只读写宿主半边的 /roost/api/* 接口，不直接碰会话和 QQ。
//
// ── 配色（2026-10 按 DSH 文档重做）─────────────────────────
// DSH 插件文档要求：样式只用主题令牌 `--dsw-alias-*`，字面色只用于插画。
// 之前这里走的是另一条路——因为 `--dsw-alias-text-primary` 这个名字
// 在 DSH 里**确实不存在**，当时以为是"没有这套变量"，于是退回
// `color: inherit` + 自己量背景亮度判明暗。
//
// 查过 asar 里的真实令牌表（120 个）才知道：变量是有的，是我名字猜错了。
// 正确的文字色叫 `--dsw-alias-label-primary`，不是 `-text-primary`。
//
// 现在规矩：
//   · 颜色一律 `var(--dsw-alias-xxx, 兜底)`，兜底用 `color-mix(currentColor…)`
//     —— 令牌改名了只会"样式退化"，不会像字面色那样在深色主题里直接隐形
//   · 不再自己测量明暗（`useDark` 已删）：令牌本身两套主题都有值
//   · 状态色用 `--dsw-alias-state-*`，兜底给一对 hex
//
// ── 页面结构 ─────────────────────────────────────────────
// 这是**仪表盘**，不是营销页。首屏回答一个问题：「我卡在哪一步」。
// 分节刻意不堆卡片：DSH 自己是深色仪表盘，一层层圆角方块会把宿主的层次压平。
// 分节靠「序号 + 标题 + 一条细线」，条目靠上边线分隔。

window.__ModuleLoader__.load({
  id: 'dsh-roost',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useRef } = React
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'roost'
    const API = '/roost/api'
    /**
     * 超过这个大小才走「缩略图」那条路。
     *
     * 小图直接给浏览器，省一次 fetch + 重编码；大图（壁纸、长截图）一屏铺
     * 二十张会把面板拖死——先降采样成 320px 宽的 JPEG 再显示，顺手存到
     * 服务端，下次打开就是几十 KB。
     */
    const THUMB_MIN = 700 * 1024
    /** 首次创建工作区的默认名字；只影响「还叫目录名」的那些，用户改过的不动 */
    const DEFAULT_WORKSPACE_TITLE = 'Roost·QQ'

    /**
     * QR SVG 是宿主给的，不是用户输入，但面板用 `dangerouslySetInnerHTML`
     * 插进去——上游一旦把 SVG 拼错或被替换，就是面板内的 XSS。
     * 只留 svg 本身：剥脚本、外部嵌入、内联事件和 javascript: 链接。
     */
    const safeSvg = (s) => {
      const t = String(s || '').trim()
      /**
       * 从第一个 `<svg` 开始截，不要求整串以它开头：
       * qrcode 的 `toString` 现在不带 XML 声明，但换版本/换实现可能带
       * `<?xml …?>` 或注释——写死 `^<svg` 会让二维码直接变空白，而且不报错。
       */
      const i = t.toLowerCase().indexOf('<svg')
      if (i < 0) return ''
      /**
       * **反复剥到稳定为止**。
       *
       * 单遍黑名单挡不住自嵌套：`<scr<script>ipt>` 剥掉内层后，剩下的两半
       * 正好拼回一个完整的 `<script>`（2026-11 审查实测能绕过）。
       * 每轮至少少一个标签，几轮就收敛；上限 8 轮只是防病态输入。
       */
      const strip = (s) => s
        .replace(/<\s*(script|foreignObject|iframe|object|embed|animate|set)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*(script|foreignObject|iframe|object|embed|animate|set)\b[^>]*\/?>/gi, '')
        /**
         * 前导用 `[\s/]` 而不是 `\s`：`<svg/onload=alert(1)>` 里属性前的 `/`
         * 会被 HTML tokenizer 当成属性分隔符，和空格等价（2026-11 复核实测）。
         */
        .replace(/[\s/]on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        /**
         * 二维码不需要任何链接，直接把 href/xlink:href 全剥掉。
         * 只挡 `javascript:` 字面量不够：`java\tscript:`、无引号、
         * 大小写混写都能绕过，而这里本来就没有合法的链接用途。
         */
        .replace(/[\s/](href|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      let out = t.slice(i)
      for (let n = 0; n < 32; n += 1) {
        const next = strip(out)
        if (next === out) break
        out = next
      }
      /**
       * **fail-closed**：剥到上限还剩危险标签/事件，就一个字都不给。
       *
       * 二维码画不出来只是难看；放一个 `<script>` 进面板是另一回事。
       * 深度嵌套（十几层 `<scr<script>…`）会一次只收敛一层，靠这个兜底。
       */
      if (/<\s*(script|foreignObject|iframe|object|embed|animate|set)\b/i.test(out)) return ''
      if (/[\s/]on[a-z]+\s*=/i.test(out)) return ''
      return out
    }

    /* ---------------- 请求 ---------------- */

    /**
     * 所有请求走这一个，别再用裸 `r.json()`。
     *
     * 裸 json() 遇到空 body 只会抛 `Unexpected end of JSON input`，
     * 完全看不出是哪个接口、什么状态码。这里把状态码和路径都带上，
     * 回的不是 JSON 也把前 80 字打出来。
     */
    const req = async (p, init) => {
      try {
        const r = await fetch(API + p, { cache: 'no-store', ...init });
        const text = await r.text();
        if (!text) {
          return {
            ok: false,
            message: `插件没回内容（HTTP ${r.status}，${p}）—— 多半是插件没加载完或路由没注册，重载 DSH 再试`,
          };
        }
        try {
          /**
           * 用 `httpStatus`，**不能**叫 `status`：
           * `/setup/qr/poll` 的业务字段就叫 `status`（pending/done），覆盖掉会直接坏扫码。
           */
          return { ...JSON.parse(text), httpStatus: r.status };
        } catch {
          return { ok: false, httpStatus: r.status, message: `插件回的不是 JSON（HTTP ${r.status}，${p}）：${text.slice(0, 80)}` };
        }
      } catch (e) {
        return { ok: false, message: '连不上插件：' + e.message };
      }
    };

    const get = (p) => req(p);
    /**
     * `viaExt` 是「谁在调面板 API」的标记：`@panel` = 面板自己的按钮（全权），
     * 扩展页面转发时是那个扩展的 id（按它的 scope 判权，见 `src/ext-quick-guard.js`）。
     *
     * **在 `post()` 统一加**，不靠每个调用点记得写：漏传会被服务端 400。
     * 放在 spread 之前，`EXT_POST(..., { viaExt: id })` 能覆盖它。
     */
    const post = (p, body) =>
      req(p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(p === '/quick' ? { viaExt: '@panel', ...(body || {}) } : (body || {})),
      });

    const clone = (o) => JSON.parse(JSON.stringify(o))
    const setPath = (obj, path, value) => {
      const next = clone(obj)
      let cur = next
      const ks = path.split('.')
      for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {}
      cur[ks[ks.length - 1]] = value
      return next
    }
    const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)

    const ago = (t) => {
      if (!t) return '—'
      const s = Math.max(0, Math.round((Date.now() - t) / 1000))
      if (s < 60) return s + ' 秒前'
      if (s < 3600) return Math.round(s / 60) + ' 分钟前'
      if (s < 86400) return Math.round(s / 3600) + ' 小时前'
      return Math.round(s / 86400) + ' 天前'
    }

    /**
     * 投递状态的中文名。
     *
     * 只有 `waiting`（还在等）和四个终态会落进 `delivery.json`——
     * `src/delivery.js` 的 `nextState` 把 `pending` / `audited` 都归成
     * `waiting`。所以这里不列那两个，免得读的人以为中间态会被存下来。
     *
     * 「没发出去」和「不确定」的区别是这一页最要讲清楚的事：
     * 前者可以再发一次，后者重发会让对方收到两条。
     */
    const DELIV_STATE = {
      waiting: '等结果',
      sent: '送到了',
      failed: '没发出去',
      unknown: '不确定',
      gone: '查不到了',
    }

    /** 时间戳 → 本地日期（日记和图谱都按天看，别显示 ISO 串） */
    const dayOf = (t) => {
      if (!t) return '—'
      const d = new Date(t)
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }

    /* ---------------- 样式 ---------------- */

    /* 令牌名全部取自 DSH 真实令牌表（--dsw-alias-*，共 120 个）。
       兜底用 color-mix(currentColor…)：令牌没了只是变淡，不会隐形。 */
    const CSS = `
.roost-root{
  display:flex;flex-direction:column;
  /* 页头固定、正文滚：height:100% 撑满宿主给的槽位，
     max-height:100vh 是兜底——万一外层没给确定高度，至少不会溢出到看不见 */
  height:100%;max-height:100vh;min-height:0;overflow:hidden;
  /**
   * 自己画底色，不靠父亲的透明。
   *
   * 滚动容器在 Chromium 里是独立合成层，栅格化是**分块、异步**的：
   * 某一块还没画完时露出的是**文档默认白底**。从录屏抽帧能看到典型表现——
   * 切页瞬间左半边整块变白、右半边正常，而且是一闪一闪的。
   * 只要这层自己有背景色，没画完的块也是深色，不会出现白板。
   */
  background:var(--dsw-alias-bg-base, #16181c);
  color:var(--dsw-alias-label-primary, inherit);
  font-size:13px;line-height:1.62;
  /* 面板常驻窄侧栏，媒体查询量的是视口、永远不触发；量自己这一页才对 */
  container-type:inline-size;
  --line:var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent));
  --line-soft:var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 12%, transparent));
  --surface:var(--dsw-alias-bg-l1, color-mix(in srgb, currentColor 6%, transparent));
  --field:var(--dsw-alias-fill-l1, color-mix(in srgb, currentColor 9%, transparent));
  --hover:var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 9%, transparent));
  --ok:var(--dsw-alias-state-success-primary, #12855a);
  --warn:var(--dsw-alias-state-warn-primary, #b45309);
  --bad:var(--dsw-alias-state-error-primary, #b42318);
  --accent:var(--roost-accent, var(--dsw-alias-brand-primary, #2563eb));
}
/**
 * 用户自选的强调色（个性化页）。
 *
 * 只覆盖 --accent 这一个锚点：面板里 39 处用它，其中 9 处是 color-mix
 * 派生（14% / 30% / 9% / 8%），换一个值那些药丸底与边框自动跟着变。
 * **其余颜色一概不碰**——--dsw-alias-* 是宿主的两套主题令牌，改它们会在
 * 宿主切深浅时花掉（2026-11-11 的下拉弹层事故就是这个形状）。
 *
 * 深浅各给一个值（inline 注入两个变量），否则浅色主题下会出现荧光色下划线。
 * 没有注入这两个变量时（选了「跟随宿主」）整条回落到宿主令牌。
 */
@media (prefers-color-scheme: light){
  .roost-root{--accent:var(--roost-accent-light, var(--roost-accent, var(--dsw-alias-brand-primary, #2563eb)))}
}
/**
 * 关动效（个性化页的开关）。
 *
 * 用一条通配规则兜住全部：分节入场、切页淡入、.roost-node.current::after
 * 那个 2.4s 无限呼吸、以及所有按钮/选项卡过渡。逐条列会漏——现有三段
 * prefers-reduced-motion 就漏了呼吸圈和 .roost-fade。
 */
.roost-root.no-anim *,
.roost-root.no-anim *::before,
.roost-root.no-anim *::after{animation:none!important;transition:none!important}
/* ── 个性化页（2026-11-19）────────────────────────────
   三样东西没有现成样式可复用：组切换胶囊、行内上下移按钮、色块。
   其余（分节、行、开关、输入框）全部走既有的 Sec / GRow / Switch / roost-g-area。 */
.roost-pf-grp{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 12px}
.roost-pf-grp button{padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:transparent;
  color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit;font-size:12px;
  transition:background .16s,color .16s,border-color .16s}
.roost-pf-grp button:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--hover)}
.roost-pf-grp button[data-on="1"]{color:var(--dsw-alias-label-primary,inherit);border-color:var(--accent);
  background:color-mix(in srgb,var(--accent) 12%,transparent)}
.roost-pf-order{display:inline-flex;gap:4px}
.roost-pf-order button{width:26px;height:26px;padding:0;display:inline-flex;align-items:center;justify-content:center;
  border-radius:6px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer;
  font:inherit;font-size:12px;line-height:1}
.roost-pf-order button:hover:not(:disabled){background:var(--hover)}
.roost-pf-order button:disabled{opacity:.28;cursor:not-allowed}
.roost-swatches{display:flex;gap:10px;flex-wrap:wrap;padding:2px 0 6px}
.roost-swatch{width:32px;height:32px;padding:0;border-radius:9px;border:2px solid transparent;
  background:transparent;cursor:pointer}
.roost-swatch span{display:block;width:100%;height:100%;border-radius:7px}
.roost-swatch.host span{background:linear-gradient(135deg,#39404d 50%,#24272e 50%)}
.roost-swatch[data-on="1"]{border-color:var(--dsw-alias-label-primary,#e6e7eb)}
.roost-swatch:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* 首次接入向导：全屏遮罩，窄侧栏里也要能滚、不能把按钮挤出屏幕 */
/* 垂直也居中：卡片贴顶会在大屏上留下半屏空白，看着像没加载完 */
.roost-wizard{display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:auto;padding:20px;box-sizing:border-box}
.roost-wizard-card{width:100%;max-width:720px;padding:24px 28px;border:1px solid var(--line);border-radius:14px;background:var(--surface);box-shadow:0 12px 40px color-mix(in srgb, currentColor 8%, transparent);box-sizing:border-box}
.roost-wizard-card .roost-pill.on{border-color:var(--accent);color:var(--accent)}
.roost-wiz-body{min-height:260px;margin-top:16px}
/* 链路对比：旧版划掉、新版高亮，一眼看出少了哪一层 */
.roost-wiz-chain{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--line-soft);border-radius:10px;margin:10px 0;background:var(--field)}
.roost-wiz-chain.old{opacity:.55}
.roost-wiz-chain.now{border-color:var(--accent)}
.roost-wiz-node{padding:4px 10px;border:1px solid var(--line);border-radius:7px;font-size:12px;white-space:nowrap}
.roost-wiz-node.gone{text-decoration:line-through;color:var(--bad)}
.roost-wiz-node.hot{border-color:var(--accent);color:var(--accent);font-weight:600}
.roost-wiz-arrow{color:var(--muted, currentColor);opacity:.5;font-size:12px}
.roost-wiz-todo{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.roost-wiz-todo-row{display:flex;align-items:center;gap:10px;font-size:12.5px}
.roost-wiz-todo-num{flex:0 0 auto;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:var(--field);border:1px solid var(--line);font-size:11px}
@container (max-width: 420px){.roost-wizard{padding:8px;align-items:flex-start}.roost-wizard-card{padding:16px}.roost-wiz-body{min-height:0}}
/* 页头：标题 + 通道 + 页签，永远在、不参与滚动 */
.roost-head{flex:0 0 auto;width:100%;box-sizing:border-box;padding:0}
/**
 * 内容宽度上限与居中（2026-11-12）。
 *
 * 原来直接把 max-width:860px 加在 .roost-head / .roost-scroll-body 上，
 * 没有 margin:auto——面板一拉宽，多出来的宽度全堆在**右边**，看着就是
 * 「边上空了一大块」。aurabot 的做法是 .ab-wrap{max-width:1040px;margin:0 auto}，
 * 这里照同样的思路，但**滚动条要贴面板右边**，所以分两层：
 *   · 外层（head / scroll-body）铺满，滚动条贴边
 *   · 内层（*-inner）限宽居中，正文不跟着拉成一行一千多像素
 */
.roost-head-inner{width:100%;max-width:1040px;margin:0 auto;box-sizing:border-box;padding:16px 24px 0}
/* 唯一的滚动区。滚动条要看得见、拖得动，但别太抢眼 */
.roost-scroll-body{flex:1 1 auto;min-height:0;
  /* min-width:0 是必需的：它是 flex 子项，自动最小尺寸会让"最宽的那一行内容"
     把整个面板撑宽（侧边栏里表现为横向溢出、右边按钮被裁掉）。
     行内的宽度收缩自己解决，容器不许被内容撑大。 */
  min-width:0;width:100%;box-sizing:border-box;
  padding:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;
  /* 滚动元素本身也带一层底色：它的层先画，再画子内容 */
  background:var(--dsw-alias-bg-base, #16181c)}
/* 内层限宽居中：滚动条留在外层贴边，正文不会被拉得过宽 */
.roost-body-inner{width:100%;max-width:1040px;margin:0 auto;box-sizing:border-box;
  padding:24px 24px 48px}
.roost-scroll-body::-webkit-scrollbar{width:10px}
.roost-scroll-body::-webkit-scrollbar-track{background:transparent}
.roost-scroll-body::-webkit-scrollbar-thumb{
  background:color-mix(in srgb, currentColor 24%, transparent);
  border-radius:6px;border:3px solid transparent;background-clip:content-box}
.roost-scroll-body::-webkit-scrollbar-thumb:hover{
  background:color-mix(in srgb, currentColor 42%, transparent);background-clip:content-box}
.roost-dim{color:var(--dsw-alias-label-tertiary, inherit);opacity:.9}
.roost-muted{color:var(--dsw-alias-label-secondary, inherit);opacity:.92}
.roost-mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all;color:var(--dsw-alias-label-secondary, inherit)}
.roost-btn{
  padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;
  color:inherit;cursor:pointer;font:inherit;font-size:12.5px;white-space:nowrap;
  transition:background .16s ease,border-color .16s ease,transform .16s ease;
}
.roost-btn:hover:not(:disabled){background:var(--hover)}
.roost-btn:active:not(:disabled){transform:scale(.97)}
.roost-btn:disabled{opacity:.4;cursor:not-allowed}
/* 能按的按钮用主文字色；只有真禁用才靠 opacity 变淡，两者要一眼分得开 */
.roost-btn:not(:disabled){color:var(--dsw-alias-label-primary,inherit)}
.roost-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.roost-primary{
  padding:8px 18px;border-radius:8px;border:1px solid transparent;
  background:var(--dsw-alias-button-primary-fill, var(--accent));
  color:var(--dsw-alias-label-primary-foreground, #fff);
  cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;
  transition:filter .16s ease,transform .16s ease;
}
.roost-primary:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px)}
.roost-primary:active:not(:disabled){transform:scale(.97)}
.roost-primary:disabled{opacity:.55;cursor:not-allowed}
.roost-input{
  width:100%;box-sizing:border-box;padding:8px 12px;border-radius:8px;
  border:1px solid var(--line);background:var(--field);color:inherit;font:inherit;font-size:13px;
  transition:border-color .16s ease;
}
.roost-input::placeholder{opacity:.5}
.roost-input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
/* select 的原生弹层不跟深色主题走：--field 是半透明的（9% currentColor），
   弹层里合成到系统白底上，再加 color:inherit（深色主题下是浅色字），
   结果就是**选项文字隐形**——只能看见被系统高亮的那一条，其余是空白行。
   弹层由系统绘制，拿不到我们的变量，必须给不透底的显式颜色。 */
select.roost-input{color-scheme:dark}
.roost-input option{background:#1c1d22;color:#e9eaee}
/* 浅色主题下原生弹层也要跟着翻：上面那组深色是深色主题的兜底，
   不翻就会在白底页面上弹出一块黑色下拉（2026-11-11 查弹窗时顺带发现）。
   原生 option 拿不到 --dsw-alias-*，只能按系统配色偏好切换。 */
@media (prefers-color-scheme: light){
  select.roost-input{color-scheme:light}
  .roost-input option{background:#fff;color:#1c1d22}
}
/* ── 两层导航（2026-11-12）─────────────────────────────────
   一级是分组（图标 + 名字，淡底药丸），二级是组内页面（下划线）。
   **两层必须用两种选中态**：都用底块会看成同一层，反而比原来那排更乱。
   两级都只换行、不设 overflow——页签条一旦 overflow:auto，另一轴也会算成 auto，
   窄侧栏里会凭空长出拖不动的竖滚动条（2026-11-06 踩过）。 */
.roost-nav{margin:14px 0 0;border-top:1px solid var(--line-soft)}
.roost-nav-top{display:flex;align-items:center;gap:2px;padding:6px 0 0;flex-wrap:wrap}
.roost-grp{
  flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;
  padding:0 11px;border:1px solid transparent;border-radius:9px;background:transparent;
  color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit;font-size:12.5px;
  transition:background .16s ease,color .16s ease,transform .16s ease;
}
.roost-grp svg{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;
  stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.roost-grp:hover{color:var(--dsw-alias-label-primary,inherit);background:var(--hover)}
.roost-grp:active{transform:scale(.97)}
.roost-grp:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.roost-grp[data-on="1"]{color:var(--dsw-alias-label-primary,inherit);font-weight:600;
  background:color-mix(in srgb,var(--accent) 14%,transparent);
  border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.roost-nav-sub{display:flex;gap:2px;padding:0 2px;margin-top:3px;flex-wrap:wrap}
/* 二级：下划线。不把 border-bottom 压在容器上，改用伪元素贴在 tab 自己底部，
   这样容器可以没有边框，横向滚动时线不会跟着断。 */
.roost-tab{
  flex:none;position:relative;padding:8px 11px 9px;border:0;border-radius:0;
  background:transparent;color:var(--dsw-alias-label-secondary,inherit);
  cursor:pointer;font:inherit;font-size:12.5px;white-space:nowrap;
  transition:color .16s ease;
}
.roost-tab:hover{color:var(--dsw-alias-label-primary,inherit)}
.roost-tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:6px}
.roost-tab::after{content:"";position:absolute;left:11px;right:11px;bottom:0;height:2px;
  border-radius:2px;background:transparent;transition:background .16s ease}
.roost-tab[data-on="1"]{color:var(--dsw-alias-label-primary,inherit);font-weight:600}
.roost-tab[data-on="1"]::after{background:var(--accent)}
/* 隐藏页的当前位置标记：样式接近二级选中态，但不可点 */
.roost-nav-current{padding:8px 11px;border-radius:6px;font-size:12.5px;font-weight:600;
  color:var(--dsw-alias-label-primary,inherit);
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
/* 分节头：编号徽标 + 标题 + 操作槽 + 折叠开关，下边框代替原先标题右侧的细线。
   整页按 8pt 网格走，标题/正文/说明只留三级字阶。 */
.roost-sec{margin:24px 0 0;animation:roost-sec-in .28s cubic-bezier(.2,.8,.2,1) backwards}
.roost-sec:first-child{margin-top:2px}
.roost-sec:nth-child(2){animation-delay:.04s}
.roost-sec:nth-child(3){animation-delay:.08s}
.roost-sec:nth-child(4){animation-delay:.12s}
.roost-sec:nth-child(n+5){animation-delay:.16s}
@keyframes roost-sec-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.roost-sec-h{display:flex;align-items:center;gap:10px;margin-bottom:12px;min-height:26px;
  padding-bottom:8px;border-bottom:1px solid var(--line-soft)}
/* 排障页把 日志 / 上下文 / 会话 三块拼一页：后两块原本各自从 01 起编号，
   一屏出现三个「01」像渲染坏了。用分区标题代替编号。 */
.roost-diag-part{margin-top:16px;border-top:1px solid var(--line-soft);padding-top:10px}
.roost-diag-h{font-size:12px;font-weight:650;opacity:.85;margin-bottom:6px}
.roost-diag-part .roost-sec-n{display:none}
.roost-sec-n{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;
  min-width:20px;height:18px;padding:0 5px;border-radius:6px;
  border:1px solid var(--line-soft);background:var(--surface);
  font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-tertiary,inherit);opacity:.9}
.roost-sec-t{font-size:14px;font-weight:600;letter-spacing:.01em;flex-shrink:0}
.roost-sec-acts{margin-left:auto;display:inline-flex;align-items:center;gap:8px}
.roost-sec-fold{flex:0 0 auto;width:22px;height:22px;padding:0;border-radius:6px;
  border:1px solid transparent;background:transparent;color:inherit;
  font:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:.72;
  transition:opacity .16s ease,background .16s ease}
.roost-sec-fold:hover,.roost-sec-fold:focus-visible{opacity:1;background:var(--hover)}
.roost-sec.is-folded .roost-sec-h{margin-bottom:0;padding-bottom:6px}
.roost-sec.is-folded > *:not(.roost-sec-h){display:none}
.roost-note{font-size:11.5px;line-height:1.62;color:var(--dsw-alias-label-tertiary, inherit);margin-top:4px}
.roost-empty{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-tertiary, inherit);padding:4px 0}

/* ---------------- 账号迁移 ---------------- */
/* 用 grid 不用 table：table 在 flex 容器里宽度不可控（会被内容撑宽），
   而行内又有输入框，列宽会被输入框的固有宽度顶歪。 */
.acc-head,.acc-row{
  display:grid;
  grid-template-columns:minmax(0,1.6fr) 44px 44px 44px 74px minmax(0,1.25fr) 62px;
  gap:8px;align-items:center;padding:7px 0;
}
.acc-head{
  font-size:10.5px;color:var(--dsw-alias-label-tertiary, inherit);
  border-bottom:1px solid var(--line-soft);padding-bottom:5px;
  /* 表头跟列对齐：数字列右对齐，其余左对齐 */
}
.acc-head>span:nth-child(2),.acc-head>span:nth-child(3),.acc-head>span:nth-child(4){text-align:right}
.acc-row{border-top:1px solid var(--line-soft);font-size:12px}
.acc-row:first-of-type{border-top:none}
.acc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acc-num{font-variant-numeric:tabular-nums;text-align:right;
  color:var(--dsw-alias-label-secondary, inherit);font-size:11.5px}
/* 输入框压扁一点：这一列是「顺手填个号码」，不该跟正文一样高 */
.acc-uin{padding:4px 8px;font-size:12px;border-radius:6px}
.acc-row .roost-btn{padding:4px 9px;font-size:11.5px}
.acc-claims{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.acc-claim{font-size:10.5px;line-height:1.5;opacity:.72}
/* 「需要 Roost」这类提示条：不是错误，是说明，所以用中性的边框 */
.acc-warn{
  margin:0 0 10px;padding:8px 11px;border-radius:7px;font-size:11.5px;line-height:1.6;
  border:1px solid color-mix(in srgb, currentColor 22%, transparent);
  background:color-mix(in srgb, currentColor 6%, transparent);
}
.acc-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}

.roost-row{display:flex;gap:14px;padding:11px 0;border-top:1px solid var(--line-soft)}
.roost-row:first-of-type{border-top:none;padding-top:2px}
.roost-k{flex:0 0 62px;font-size:12px;color:var(--dsw-alias-label-secondary, inherit);padding-top:1px}
.roost-v{flex:1;min-width:0}
.roost-v-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}

.roost-mood{display:flex;flex-direction:column;gap:8px}
.roost-mood-row{display:flex;align-items:center;gap:10px}
.roost-mood-k{flex:0 0 42px;font-size:11.5px;color:var(--dsw-alias-label-secondary, inherit)}
.roost-mood-w{flex:0 0 46px;text-align:right;font-size:11.5px;font-variant-numeric:tabular-nums}

.roost-node{
  position:relative;flex:0 0 26px;height:26px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-family:ui-monospace,Menlo,Consolas,monospace;
  font-size:11px;font-weight:700;
  transition:transform .18s cubic-bezier(.2,.8,.2,1),background .18s,border-color .18s;
}
.roost-node.done{background:var(--ok);border:1px solid var(--ok);color:#04150e}
.roost-node.todo{border:1px dashed var(--line);opacity:.55}
.roost-node.current{border:1px solid var(--warn);color:var(--warn)}
.roost-node.bad{border:1px solid var(--bad);color:var(--bad)}
.roost-node.current::after{
  content:'';position:absolute;inset:-4px;border-radius:50%;
  border:1px solid var(--warn);opacity:.5;
  animation:roost-breathe 2.4s cubic-bezier(.4,0,.6,1) infinite;
}
@keyframes roost-breathe{
  0%{transform:scale(.92);opacity:.5}
  50%{transform:scale(1.14);opacity:0}
  100%{transform:scale(.92);opacity:0}
}
.roost-step{display:flex;gap:14px;padding:0 0 20px;position:relative}
.roost-step:last-child{padding-bottom:2px}
.roost-rail{position:absolute;left:12.5px;top:28px;bottom:2px;width:1px;background:var(--line-soft)}
.roost-step:last-child .roost-rail{display:none}
.roost-step.done .roost-rail{background:var(--ok);opacity:.4}
.roost-body{flex:1;min-width:0;padding-top:2px}
.roost-title{font-weight:600;font-size:13px}
.roost-fade{animation:roost-in .22s cubic-bezier(.2,.8,.2,1)}
@keyframes roost-in{from{opacity:0}to{opacity:1}}
@keyframes roost-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

.roost-pill{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:20px;font-size:11px;
  border:1px solid var(--line-soft);background:var(--field);color:var(--dsw-alias-label-secondary, inherit)}
.roost-pill.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.roost-pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,transparent)}
.roost-pill.bad{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
/**
 * 可点的 pill：和「纯状态标签」必须看得出区别。
 *
 * 之前两者共用同一个 roost-pill 类，一排下来全是灰底圆角，用户不知道哪个能点、
 * 更看不出选中了哪个。现在：状态是平的（无 cursor），按钮有实边 + hover，
 * 选中态用主色边框 + 淡主色底 + 加粗。
 */
.roost-pill.as-btn{cursor:pointer;background:var(--surface);border-color:var(--line);
  padding:2px 10px;font-size:11.5px;transition:border-color .12s,color .12s,background .12s}
.roost-pill.as-btn:hover{border-color:var(--accent);color:var(--accent)}
.roost-pill.as-btn:disabled{opacity:.55;cursor:default;border-color:var(--line);color:inherit}
.roost-pill.on{border-color:var(--accent);color:var(--accent);font-weight:600;
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
.roost-pill.on::before{content:'✓ ';font-weight:700}
.roost-code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;
  background:var(--dsw-alias-markdown-code-block, var(--field));border-radius:6px;padding:2px 6px}
.roost-pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;
  background:var(--dsw-alias-markdown-code-block, var(--field));border-radius:8px;padding:10px 12px;
  white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;margin:6px 0 0}
.roost-list{display:flex;flex-direction:column;gap:2px}
.roost-item{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line-soft);font-size:12.5px}
.roost-item:first-child{border-top:none}
.roost-item .t{flex:1;min-width:0;word-break:break-word}
.roost-item .d{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-tertiary, inherit)}
/* 扩展 usage 编辑卡：标题 + 元信息一行、输入框一行、按钮一行，**必须竖排**。
   套 .roost-item 会被两样东西挤死：兄弟「保存 usage」按钮是 flex:0 0 auto，
   textarea 又是 width:100%，.t{flex:1;min-width:0} 只能缩到最小内容宽度 ——
   中文没有词边界，于是变成「一个字一行」（2026-11-12 的截图就是这么来的，
   这是第四次踩同一个坑，前三次是关系确认块 / 档位卡 / 扩展能力页）。 */
.ext-row{padding:7px 0;border-top:1px solid var(--line-soft);font-size:12.5px;min-width:0}
.ext-row:first-child{border-top:none;padding-top:2px}
.ext-row .t{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0;word-break:break-word}
.ext-row .t .d{font-size:11px;color:var(--dsw-alias-label-tertiary, inherit)}
.ext-row > .d{display:block;margin-top:3px;font-size:11px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary, inherit);overflow-wrap:anywhere}
.roost-scroll{max-height:320px;overflow:auto}
/* 拒绝诊断 / 最近拒绝：标题一行、规则一行（**不能套 .roost-item**）。
   .roost-item 是横排 flex，.t{flex:1;min-width:0} 会被兄弟 .d{flex:0 0 auto}
   挤成一个字一行；而 .d 里装的是没有空格的 JSON（{"owner":{"allow":["*"]…}}），
   自己不换行，还会把整行撑出屏幕（截图里右侧被切掉 + 底部横向滚动条）。
   2026-11-04 关系确认块、2026-11-05 档位卡都是这个坑，扩展能力页是第三次。 */
.diag-item{padding:7px 0;border-top:1px solid var(--line-soft);font-size:12.5px;min-width:0}
.diag-item:first-child{border-top:none;padding-top:2px}
.diag-item .t{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;min-width:0;word-break:break-word}
.diag-item > .d{display:block;margin-top:2px;font-size:11px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary, inherit);overflow-wrap:anywhere;word-break:break-word}
.diag-item .t .d{opacity:.72;font-size:11px}
/* 功能开关的分组：标题一行、条目一列。
   **不能套 .roost-item**（它 .t{flex:1} + 兄弟 flex:0 0 auto，标题会被压成一个字一行，
   2026-11-04 在关系确认块上就是这么错的，这次又犯了一遍）。 */
.cap-group{padding:11px 0;border-top:1px solid var(--line-soft)}
.cap-group:first-child{border-top:none;padding-top:2px}
.cap-group-t{font-size:11px;font-weight:650;letter-spacing:.05em;opacity:.75;margin-bottom:9px}
.cap-group-b{display:flex;flex-direction:column;gap:13px}
.cap-row{display:flex;align-items:flex-start;gap:8px}
.cap-row-b{flex:1 1 auto;min-width:0}
.cap-cap{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.cap-cap input[type=number]{width:62px}
/* 「数值 / 下拉」型功能项：控件要窄且不被 flex 拉伸，否则会挤掉右边的说明文字 */
.cap-row > input.cap-num,.cap-row > .cap-ctl{width:96px;flex:0 0 96px}
.cap-row > .cap-ctl{display:flex;flex-direction:column;gap:4px}
.cap-row > .cap-ctl select,.cap-row > .cap-ctl input{width:100%;min-width:0}
/* 档位卡：标题一行、按钮一行、摘要一行。
   原来整块塞进 .roost-item 的 .t 里，兄弟 .d 是 flex:0 0 auto 不换行，
   工具名一长就把整行撑出屏幕（截图里右侧被切掉）。 */
.cap-card{padding:12px 0;border-top:1px solid var(--line-soft)}
.cap-card:first-child{border-top:none;padding-top:2px}
.cap-card-h{display:flex;align-items:baseline;gap:8px;margin-bottom:9px;min-width:0}
.cap-card-h .n{font-size:13px;font-weight:640}
.cap-card-h .m{flex:1 1 auto;min-width:0;font-size:11px;opacity:.6;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cap-card-h .c{flex:0 0 auto;font-size:11px;opacity:.75;font-variant-numeric:tabular-nums}
.cap-card-b{display:flex;flex-wrap:wrap;gap:6px}
.cap-card-a{margin-top:8px;font-size:11px;line-height:1.55;opacity:.6;word-break:break-all}
/* 工具权限：一行一条连续轨道 + 一个滑块，拨到哪档就开放到哪档。
   五个透明热区均分轨道，圆心与表头五个标签严格对齐；轨道左右各让 19px，
   让首尾停靠点正好落在第一、第五个热区的圆心上。 */
.cap-tool-h,.cap-tool{
  display:grid;grid-template-columns:minmax(0,1fr) 190px;
  gap:8px;align-items:center;min-width:0;
}
.cap-tool-h{padding:2px 0 8px;font-size:10px;opacity:.72}
.cap-tool-h .n{min-width:0}
.cap-tool{padding:4px 0;font-size:12px}
.cap-tool .n{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.cap-tool .n .note{font-family:inherit;font-size:10.5px;opacity:.62}
.cap-tiers{position:relative;display:flex;align-items:center;width:190px;height:24px;min-width:0}
.cap-tool-h .cap-tiers .t{flex:1 1 0;min-width:0;text-align:center;font-size:10px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cap-track{position:absolute;left:19px;right:19px;top:50%;height:5px;
  transform:translateY(-50%);border-radius:3px;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary,inherit) 26%,transparent)}
.cap-fill{position:absolute;left:0;top:0;height:100%;border-radius:3px;
  background:var(--dsw-alias-button-primary-fill,var(--accent,#4d6bfe));
  transition:width .2s ease}
.cap-knob{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-button-primary-fill,var(--accent,#4d6bfe));
  border:2px solid var(--dsw-alias-bg-base,#fff);
  box-shadow:0 1px 4px rgba(0,0,0,.3);
  transform:translate(-50%,-50%);transition:left .2s ease;pointer-events:none}
/* 一档都不给时滑块停在起点并转成中性色，别伪装成「主人可用」 */
.cap-tiers[data-level="-1"] .cap-knob{background:var(--dsw-alias-label-secondary,#8a93a6)}
/* 钉住项整条滑块变淡：热区本身是透明的，只给 button 加 opacity 看不出来 */
.cap-tiers[data-locked="1"] .cap-track,.cap-tiers[data-locked="1"] .cap-knob{opacity:.45}
.cap-tier{position:relative;z-index:1;flex:1 1 0;min-width:0;height:24px;padding:0;
  border:0;border-radius:6px;background:transparent;cursor:pointer;
  appearance:none;-webkit-appearance:none}
.cap-tier:hover:enabled{background:var(--hover)}
.cap-tier:focus-visible{outline:2px solid var(--accent,#4d6bfe);outline-offset:-2px}
.cap-tier:disabled{cursor:not-allowed;opacity:.45}
@media (prefers-reduced-motion:reduce){
  .cap-fill,.cap-knob{transition:none}
}
/* 弹窗：搜索 + 长列表，不再把页面撑成一米长 */
.cap-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:60;
  display:flex;justify-content:center;padding:24px;
  overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
/* 弹窗是渲染在 .roost-scroll-body 里的 fixed 层。
   **主防线**是下面两条：小弹窗靠 :has() 锁住底层唯一滚动区，整页弹窗由
   RoostPage 加 .is-locked；都是纯 CSS，弹窗卸载自动解锁，不用挂 effect。
   **兜底**（不依赖 :has()）：遮罩用 overflow-y:auto 自己接住滚轮，滚到边界
   被 overscroll-behavior:contain 截断，不会 chaining 给祖先。
   ⚠️ 不能写成 overflow:hidden —— 不可滚动的容器不消费滚轮，Chromium 会
   直接滚祖先，contain 也就永远不触发。 */
.roost-scroll-body:has(.cap-modal){overflow:hidden}
.roost-scroll-body.is-locked{overflow:hidden}
/* 底色必须跟着主题令牌走：原来写 var(--bg, 深色兜底) 时 --bg 在本页根本没定义，
   永远取深色兜底；浅色模式下文字是深色，就成了「深底深字」几乎看不见（2026-11-11 截图）。
   用 --dsw-alias-bg-base 和 .roost-root 同一层底色，层次交给边框和投影。 */
.cap-modal-b{background:var(--dsw-alias-bg-base, #1b1b1b);
  box-shadow:0 16px 48px rgba(0,0,0,.38);
  border:1px solid var(--line-soft);border-radius:12px;
  width:min(760px,100%);max-height:min(78vh,720px);display:flex;flex-direction:column;overflow:hidden;
  margin:auto}
.cap-modal-h{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line-soft)}
.cap-modal-h .t{flex:1 1 auto;font-size:13.5px;font-weight:640;min-width:0}
.cap-modal-s{padding:10px 16px;border-bottom:1px solid var(--line-soft)}
.cap-modal-s input{width:100%}
.cap-modal-c{padding:10px 16px 16px;overflow:auto;flex:1 1 auto;min-height:0;
  overscroll-behavior:contain}
/* 人格行：左两行文字、右一排动作。窗口窄时优先保住名字 */
.roost-acts{flex:0 0 auto;display:flex;gap:6px;align-items:center}

/* ── 人格页（pv-*）─────────────────────────────────────────────
   这一页的主体是「一份 200 行的清单」。原来每行四个同级按钮平铺，
   一屏就有几十个按钮，名字被按钮抢走注意力；搜索框也没有，
   200 个人格只能靠肉眼滚。以下分组按「先答案、再工具、后清单」排。 */
.pv-top{display:flex;flex-direction:column;gap:11px;margin-bottom:16px}
.pv-k{flex:0 0 auto;font-size:11px;font-weight:650;letter-spacing:.04em;
  color:var(--dsw-alias-label-secondary,inherit)}
.pv-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pv-name .roost-input{flex:1 1 180px;max-width:280px}
.pv-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,inherit);
  margin-top:-7px}
/* 当前生效：先给一个确定答案，再把两个作用域摆开 */
.pv-now{display:flex;flex-direction:column;gap:10px;padding:11px 13px;border-radius:11px;
  border:1px solid var(--line-soft);background:var(--surface)}
.pv-now-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pv-now-name{font-size:14.5px;font-weight:650;letter-spacing:-.01em}
.pv-sels{display:grid;grid-template-columns:repeat(auto-fit,minmax(196px,1fr));gap:10px}
.pv-sel{display:flex;flex-direction:column;gap:4px;min-width:0}
.pv-sel .roost-input{max-width:none}
.pv-sel-h{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.pv-sel-k{font-size:11.5px;color:var(--dsw-alias-label-secondary,inherit)}
.pv-sel-d{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
/* 工具条：搜索占主位，动作靠右，不与列表标题抢一行 */
.pv-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 6px}
.pv-bar .roost-input{flex:1 1 220px;min-width:130px;max-width:420px}
/* 第二行：只说数量与状态，别和搜索框抢一行 */
.pv-sub{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px;min-height:16px}
.pv-count{font-size:11.5px;color:var(--dsw-alias-label-tertiary,inherit);
  font-variant-numeric:tabular-nums;margin-right:auto}
.pv-sub .roost-btn{padding:2px 9px;font-size:11.5px}
/* 新建/粘贴导入：虚线框，表示「这是就地展开的一块，不是常驻区域」 */
.pv-new{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 8px;
  padding:9px 10px;border-radius:10px;border:1px dashed var(--line-soft);background:var(--surface)}
.pv-new .roost-input{flex:1 1 190px;max-width:320px}
/* 清单：卡片行；次要操作默认 62% 不透明度，指到/聚焦才全额
   —— 这样默认视觉里每行只剩「名字 + 一个主操作」，可点性没变 */
.pv-list{display:flex;flex-direction:column;gap:1px;padding:2px 0;
  max-height:min(52vh,520px);overflow-y:auto;overscroll-behavior:contain;
  scrollbar-width:thin;border-radius:10px}
.pv-list::-webkit-scrollbar{width:8px}
.pv-list::-webkit-scrollbar-track{background:transparent}
.pv-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 16%,transparent);
  border-radius:6px;border:2px solid transparent;background-clip:content-box}
.pv-list:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,currentColor 30%,transparent);
  background-clip:content-box}
.pv-row{display:flex;align-items:center;gap:12px;padding:7px 10px;border-radius:10px;
  border:1px solid transparent;transition:background .14s ease,border-color .14s ease}
.pv-row:hover{background:var(--hover);border-color:var(--line-soft)}
.pv-row.is-cur{background:color-mix(in srgb,var(--accent) 8%,transparent);
  border-color:color-mix(in srgb,var(--accent) 30%,transparent)}
.pv-row.is-edit{border-color:var(--line);background:var(--hover)}
.pv-row .t{flex:1;min-width:0}
.pv-nm{font-size:13px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.pv-row.is-cur .pv-nm{font-weight:650}
/* 状态标签跟在名字后面：一行里读成「名字 · 状态」，不用再去右边对照 */
.pv-nm .roost-pill{margin-left:7px;font-weight:400;vertical-align:1px}
/* 仓库里有、本地没装的：名字降一档字重，和已经装好的区分开
   （顺序上它们本来就在后面，这里只做轻微提示，不做成"禁用"的样子） */
.pv-row.is-repo .pv-nm{font-weight:500}
/* 清单里的分组头：解释"从这里开始是还没装的" */
.pv-group{display:flex;align-items:center;gap:9px;margin:10px 0 3px;padding:0 10px;
  font-size:11px;letter-spacing:.02em;color:var(--dsw-alias-label-tertiary,inherit)}
.pv-group::after{content:'';flex:1;height:1px;background:var(--line-soft)}
.pv-alias{font-size:11px;font-weight:400;margin-left:6px;
  color:var(--dsw-alias-label-tertiary,inherit)}
.pv-meta{font-size:11px;line-height:1.55;overflow-wrap:anywhere;
  color:var(--dsw-alias-label-tertiary,inherit)}
.pv-acts{flex:0 0 auto;display:flex;gap:2px;align-items:center}
/* 次要项只比主操作轻一点，别淡到像禁用；指到这一行或键盘聚焦才给全额。
   真禁用仍回 0.4，否则 0.85 会把禁用态和正常态抹成一样。 */
.pv-acts .roost-btn:not(.pv-main):not(:disabled),.pv-acts .pv-del:not(:disabled){opacity:.85;
  transition:opacity .14s ease}
.pv-acts .roost-btn:disabled,.pv-acts .pv-del:disabled{opacity:.4;cursor:not-allowed}
.pv-row:hover .pv-acts .roost-btn,.pv-row:focus-within .pv-acts .roost-btn,
.pv-row:hover .pv-acts .pv-del,.pv-row:focus-within .pv-acts .pv-del{opacity:1}
.pv-acts .roost-btn{padding:3px 9px;border-color:transparent;background:transparent;
  font-size:11.5px;color:var(--dsw-alias-label-primary,inherit)}
.pv-acts .roost-btn:hover:not(:disabled){background:var(--hover);
  border-color:var(--line-soft);color:var(--dsw-alias-label-primary,inherit)}
.pv-acts .roost-btn.armed{background:var(--bad);border-color:var(--bad);color:#fff}
/* 每行只有一个主操作（用这个 / 更新 / 装上），只有它带边框 */
.pv-acts .pv-main{border-color:var(--line);color:inherit}
.pv-acts .pv-del .roost-btn:hover:not(:disabled){color:var(--bad);
  border-color:color-mix(in srgb,var(--bad) 45%,transparent)}
/* 长篇说明折叠：默认收起，需要时展开，不再把人推到页底 */
.pv-help{margin-top:16px;border-top:1px solid var(--line-soft);padding-top:9px}
.pv-help summary{display:flex;align-items:center;gap:7px;cursor:pointer;list-style:none;
  font-size:12px;color:var(--dsw-alias-label-secondary,inherit)}
.pv-help summary::-webkit-details-marker{display:none}
.pv-help summary::before{content:'›';font-size:15px;line-height:1;display:inline-block;
  transition:transform .14s ease}
.pv-help[open] summary::before{transform:rotate(90deg)}
.pv-help summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:5px}
.pv-empty{padding:14px 10px;font-size:12px;line-height:1.7;text-align:center;
  color:var(--dsw-alias-label-tertiary,inherit)}
/* 预览（装之前先读正文）：和「当前人格」卡片同一套底，别用 currentColor 描边把整页割开 */
.pv-preview{margin:2px 0 8px;padding:11px 12px;border-radius:10px;
  border:1px solid var(--line-soft);background:var(--surface)}
/**
 * 窄栏适配走**容器查询**，不走媒体查询。
 *
 * 这是侧边栏：面板可能只有 400px 宽，而浏览器窗口是 1440——
 * 媒体查询量的是**视口**，这种情况下永远不触发，按钮就一路溢出到看不见。
 * 容器查询量的是这一页自己的宽度，两种情形都对。
 */
.pv-root{container-type:inline-size}
@container (max-width:560px){
  /* 一行放不下四个动作时，动作行整体折到下一行、右对齐；名字拿到整行 */
  .pv-row{flex-wrap:wrap;row-gap:2px}
  .pv-acts{width:100%;justify-content:flex-end}
  .pv-bar .roost-input{flex:1 1 100%;max-width:none}
  .pv-sels{grid-template-columns:1fr}
  .pv-now-name{font-size:13.5px}
}
/* 编辑区顶部的「你改过这份」提示：带一个覆盖动作，所以用警示色而不是红 */
.pv-warn{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:9px;
  padding:8px 11px;border-radius:9px;font-size:11.5px;line-height:1.65;
  border:1px solid color-mix(in srgb,var(--warn) 40%,transparent);
  background:color-mix(in srgb,var(--warn) 8%,transparent)}
.pv-warn span{flex:1;min-width:0}

/* ── 概览用的统计块与故障条 ──
   尺寸与配色严格对齐 dsh-context 的 .lc-stat + .lc-ov-kpi：
   gap 8 · padding 8 · radius 8 · label/sub 11px · value 20px · 三行居中。
   底色跟页面一致，只留 1px 细边框，不再垫一层 --surface。 */
/* 六宫格固定 3 列 2 行：对方 overview.css 的 .lc-ov-kpis 用 repeat(3,minmax(0,1fr)) */
.roost-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.roost-stat{display:flex;flex-direction:column;align-items:center;text-align:center;
  gap:2px;padding:8px;border-radius:8px;min-width:0;
  border:1px solid var(--line);background:var(--dsw-alias-bg-base, transparent);
  transition:border-color .16s ease}
.roost-stat:hover{border-color:var(--dsw-alias-label-tertiary, var(--line))}
.roost-stat b{font-size:20px;font-weight:600;letter-spacing:-.02em;line-height:1.2;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit);
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roost-stat span{font-size:11px;color:var(--dsw-alias-label-secondary,inherit);line-height:1.4;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 三行统计卡：小标题 / 大数字 / 副标题（对齐 dsh-context 的读法） */
.roost-stat .k{font-weight:600}
.roost-stat .sub{font-weight:400}
/* ── 概览洞察区：网格 / 尺寸 / 配色 / 动效严格对齐 dsh-context overview.css ──
   .lc-ov-first 两列 gap 10、.lc-ov-stats 两列、.lc-ov-tiles 四列且每卡 280px 高、
   .lc-card padding 10px 12px、热力格 20x20、柱宽 10px、字号 9~11px。 */
.ov-first{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:10px}
.ov-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:10px}
.ov-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;align-items:stretch}
/* 只给下限不锁死高度：280px 配 overflow:hidden 会把 7 行热力格和悬停气泡整条裁掉，
   看起来就是「超框就没了」。四张卡由 grid 的 align-items:stretch 自动对齐高度。 */
.ov-tile{display:flex;flex-direction:column;min-height:280px;min-width:0;overflow:visible}
.ov-panel{border:1px solid var(--line);border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base,transparent));
  padding:10px 12px;min-width:0;box-sizing:border-box;
  transition:border-color .2s ease,background-color .2s ease,box-shadow .2s ease}
.ov-panel:hover{border-color:var(--dsw-alias-label-secondary,var(--line));
  background:var(--dsw-alias-interactive-bg-hover,var(--hover));
  box-shadow:0 6px 18px rgba(0,0,0,.14)}
.ov-panel h4{margin:0;font-size:12px;font-weight:600;
  color:var(--dsw-alias-label-primary,inherit)}
.ov-cap{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);
  margin:2px 0 8px;line-height:1.4}
.ov-bars{display:flex;align-items:flex-end;gap:6px;height:104px;border-bottom:1px solid var(--line-soft)}
.ov-bar{flex:1 1 0;min-width:0;height:100%;display:flex;flex-direction:column;
  justify-content:flex-end;align-items:center;gap:3px}
.ov-bar i{display:block;width:10px;border-radius:3px 3px 0 0;
  background:#3b82f6;min-height:2px;transition:opacity .2s ease,filter .2s ease}
.ov-bar:hover i{filter:brightness(1.15)}
.ov-bar b,.ov-bar span{font-size:9px;font-weight:500;line-height:1.2;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}
.ov-donut-row{display:flex;align-items:center;gap:14px;min-width:0}
.ov-donut{flex:0 0 auto;width:80px;height:80px}
.ov-donut .ov-seg{transition:opacity .2s ease}
.ov-donut:hover .ov-seg{opacity:.35}
.ov-donut .ov-seg:hover{opacity:1}
.ov-legend{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:5px}
.ov-legend>div{display:flex;align-items:center;gap:6px;font-size:11px;min-width:0;
  border-radius:6px;padding:1px 6px;margin:0 -6px;transition:background-color .2s ease}
.ov-legend>div:hover{background:var(--hover)}
.ov-legend i{width:8px;height:8px;border-radius:2px;flex:0 0 auto}
.ov-legend .t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-legend .v{flex:0 0 auto;font-variant-numeric:tabular-nums;opacity:.8}
/* 对方 .lc-heat-cell 是 20x20 固定格。八周七行共 56 格，
   格子若跟着卡宽涨到 40px，七行就塞不进卡片被裁（2026-11-11 截图）。
   用 max-width 封顶 20px、窄卡再等比缩小，七行始终完整可见。 */
.ov-heat{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:3px;justify-items:center}
.ov-heat i{display:block;width:100%;max-width:20px;aspect-ratio:1;border-radius:20%;
  background:color-mix(in srgb,var(--dsw-alias-label-secondary,inherit) 16%,transparent);
  transition:box-shadow .2s ease,transform .2s ease}
.ov-heat i:hover{box-shadow:0 0 0 1.5px color-mix(in srgb,#3b82f6 70%,transparent);
  transform:scale(1.12)}
.ov-rowline{display:flex;gap:8px;align-items:baseline;font-size:11px;padding:3px 0;min-width:0}
.ov-rowline .t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ov-rowline .v{flex:0 0 auto;font-variant-numeric:tabular-nums;opacity:.8}
.ov-empty{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);padding:6px 0}
/* 会话筛选与卡片：尺寸、字号、圆角、过渡对齐 dsh-context overview.css 的
   lc-ov-search / lc-ov-cover / lc-gran / lc-ov-chip / lc-ov-grid / lc-ov-session。
   卡内指标换成我们自己的四类 Token 与 DSH 会话号，不照搬费用或上下文占用。 */
.ov-count{display:inline-block;padding:1px 7px;border-radius:8px;
  background:var(--field,transparent);font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,inherit)}
.ov-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.ov-filter .roost-input{width:auto}
.ov-filter .ov-search{flex:1 1 160px;min-width:0;padding:4px 10px;font-size:12px}
.ov-filter .ov-cover{flex:none;padding:4px 8px;border-radius:6px;font-size:12px}
.ov-gran{display:flex;gap:2px;padding:1px;border:1px solid var(--line-soft);
  border-radius:6px;background:var(--field,transparent)}
.ov-gran button{border:0;background:transparent;font:inherit;font-size:11px;line-height:1;
  padding:3px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,inherit);
  transition:background-color .2s ease,color .2s ease}
.ov-gran button:hover{background:var(--hover);color:var(--dsw-alias-label-primary,inherit)}
.ov-gran button[data-on="1"]{background:var(--dsw-alias-button-primary-fill,var(--accent));
  color:var(--dsw-alias-label-primary-foreground,#fff)}
.ov-groups{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}
.ov-chip{display:inline-flex;align-items:baseline;gap:5px;
  border:1px solid var(--line-soft);background:transparent;
  color:var(--dsw-alias-label-secondary,inherit);font:inherit;
  font-size:11px;line-height:1.5;padding:2px 10px;border-radius:999px;
  cursor:pointer;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:background-color .2s ease,border-color .2s ease,color .2s ease}
.ov-chip:hover{background:var(--hover);color:var(--dsw-alias-label-primary,inherit)}
.ov-chip[data-on="1"]{background:var(--dsw-alias-button-primary-fill,var(--accent));
  border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.ov-chip .n{font-variant-numeric:tabular-nums;opacity:.65;font-size:10px}
.ov-chip[data-on="1"] .n{opacity:.85}
.ov-sessions{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.ov-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--line);
  background:var(--dsw-alias-bg-layer-1,transparent);
  min-width:0;cursor:pointer;text-align:left;font:inherit;color:inherit;
  transition:border-color .2s ease,background-color .2s ease,box-shadow .2s ease}
.ov-card:hover{border-color:var(--dsw-alias-label-secondary,var(--line));
  background:var(--dsw-alias-interactive-bg-hover,var(--hover));
  box-shadow:0 6px 18px rgba(0,0,0,.14)}
.ov-card[data-today="1"]{border-color:color-mix(in srgb,#3b82f6 65%,transparent)}
.ovc-head{display:flex;align-items:flex-start;gap:6px;min-width:0}
.ovc-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-top:5px}
.ovc-title{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;line-height:1.4;
  overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;
  overflow-wrap:anywhere}
.ovc-tag{flex:none;font-size:10px;line-height:1.5;color:#3b82f6;
  border:1px solid color-mix(in srgb,#3b82f6 45%,transparent);border-radius:4px;padding:0 4px}
.ovc-times{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px}
.ovc-times span{font-size:10px;line-height:1.4;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}
.ovc-crumb{display:flex;align-items:center;gap:5px;min-width:0;font-size:11px;
  color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;overflow:hidden}
.ovc-proj{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.6;
  color:var(--dsw-alias-label-primary,inherit);
  background:color-mix(in srgb,var(--dsw-alias-label-secondary,inherit) 16%,transparent);
  border-radius:999px;padding:0 8px}
.ovc-body{display:flex;gap:14px;align-items:center;min-width:0}
.ovc-ring{flex:0 0 auto;width:64px;height:64px;position:relative}
.ovc-ring svg{display:block;width:64px;height:64px}
.ovc-ring .ov-seg{transition:opacity .2s ease}
.ovc-ring:hover .ov-seg{opacity:.35}
.ovc-ring .ov-seg:hover{opacity:1}
.ovc-mid{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;pointer-events:none;line-height:1.2}
.ovc-mid b{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
  max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ovc-mini{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px}
.ovc-mini>div{display:flex;justify-content:space-between;align-items:baseline;gap:6px;font-size:11px}
/* 值不参与收缩：窄卡里宁可把标签省略，也不能让三行数值全被挤成空白 */
.ovc-mini .l{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit)}
.ovc-mini .v{flex:0 0 auto;max-width:52%;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.ovc-preview{display:flex;align-items:baseline;gap:6px;margin-top:auto;padding-top:6px;
  border-top:1px solid color-mix(in srgb,var(--line) 60%,transparent);min-width:0}
.ovc-preview .l{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary,inherit)}
.ovc-preview .v{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ov-pager{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;font-size:11px}
.ov-pager button{flex:none;width:26px;height:22px;display:flex;align-items:center;
  justify-content:center;border:1px solid var(--line-soft);background:transparent;color:inherit;
  border-radius:6px;font:inherit;line-height:1;cursor:pointer;
  transition:border-color .2s ease,background-color .2s ease}
.ov-pager button:hover:enabled{background:var(--hover)}
.ov-pager button:disabled{opacity:.4;cursor:default}
/* 悬停气泡：对应对方 .lc-hovertip / .lc-stat-tip。
   居中而非左对齐，最右一列格子 hover 时气泡不会整条甩到卡片外面被裁掉。 */
.ov-tipbox{position:relative}
.ov-tipbox[data-tip]:hover::after{content:attr(data-tip);position:absolute;left:50%;
  transform:translateX(-50%);bottom:calc(100% + 6px);z-index:40;
  max-width:min(180px,50vw);width:max-content;white-space:normal;
  padding:6px 9px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-2,#22242a);border:1px solid var(--line);
  color:var(--dsw-alias-label-primary,inherit);font-size:10.5px;line-height:1.5;
  box-shadow:0 6px 20px rgba(0,0,0,.28);pointer-events:none}
/* 热力格首列与末列的气泡贴边展开，别居中甩出卡片被滚动容器裁掉 */
.ov-heat i:nth-child(8n+1).ov-tipbox:hover::after,
.ov-heat i:nth-child(8n+2).ov-tipbox:hover::after{left:0;transform:none}
.ov-heat i:nth-child(8n).ov-tipbox:hover::after{left:auto;right:0;transform:none}
@keyframes ov-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.ov-first>*,.ov-stats>*,.ov-tiles>*,.ov-sessions>*{animation:ov-in .28s ease both}
.ov-first>*:nth-child(2),.ov-stats>*:nth-child(2){animation-delay:.06s}
.ov-tiles>*:nth-child(2),.ov-sessions>*:nth-child(2){animation-delay:.05s}
.ov-tiles>*:nth-child(3),.ov-sessions>*:nth-child(3){animation-delay:.1s}
.ov-tiles>*:nth-child(4),.ov-sessions>*:nth-child(4){animation-delay:.15s}
/* 对方在 932px 退单列，但本面板内容区只有 812px；照抄会永远单列。
   主栏里保持并排，窄栏分别退单列：ov-stats 与 ov-sessions 700px、ov-first 620px。 */
@container (max-width:700px){
  .ov-stats{grid-template-columns:minmax(0,1fr)}
  .ov-sessions{grid-template-columns:minmax(0,1fr)}
}
@container (max-width:640px){.ov-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:620px){.ov-first{grid-template-columns:minmax(0,1fr)}}
@container (max-width:560px){.ov-tiles{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){
  .ov-first>*,.ov-stats>*,.ov-tiles>*,.ov-sessions>*{animation:none}
  .ov-panel,.ov-card,.ov-chip,.ov-bar i,.ov-heat i,.ov-gran button,
  .ov-donut .ov-seg,.ovc-ring .ov-seg{transition:none}
}
.roost-banner{display:flex;flex-direction:column;gap:3px;padding:12px 16px;margin-bottom:16px;
  border-radius:12px;border:1px solid var(--line-soft);background:var(--surface)}
.roost-banner.bad{border-color:color-mix(in srgb,var(--bad) 45%,transparent);
  background:color-mix(in srgb,var(--bad) 9%,transparent)}
/* 有新版是「建议动作」，不是故障：用 warn 色，别和 .bad 抢同一套红 */
.roost-banner.warn{border-color:color-mix(in srgb,var(--warn) 42%,transparent);
  background:color-mix(in srgb,var(--warn) 9%,transparent)}
/* 横幅里的手动命令：一行等宽字 + 复制按钮，窄屏时按钮换到下一行 */
.roost-cmd{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;margin-top:8px}
.roost-cmd>code{flex:1 1 240px;min-width:0;margin:0;padding:6px 8px;border-radius:8px;
  background:color-mix(in srgb,var(--line-soft) 55%,transparent);font-size:11px;
  line-height:1.6;word-break:break-all;white-space:pre-wrap;
  font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
.roost-cmd>summary{flex:1 1 100%;cursor:pointer;font-size:11.5px;
  color:var(--dsw-alias-label-tertiary,inherit)}
.roost-banner b{font-size:13px;font-weight:600}
.roost-banner i{font-style:normal;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary,inherit)}

/* ── 开关 / 芯片 / 单条记忆 / 文字链接 ── */
/* 开关是 <button>：必须 appearance:none + 自带底色，否则深色下会露出
   UA 的 ButtonFace 浅色皮（2026-11-11 截图里轨道整个发白）。 */
/* 开关颜色一律写死，不碰 DSH 变量：
   ① --dsw-alias-brand-primary 在深色主题下被映射成 --dsw-alias-label-primary
      （主文字色 = 白），拿 --accent 做填充会得到纯白开关（2026-11-11 实测）；
   ② 纯 color-mix / 变量链一旦不被支持，background 整条失效，<button>
      会露出 UA 样式表里的 ButtonFace 白底。 */
.roost-switch{position:relative;width:32px;height:18px;border-radius:9px;
  border:1px solid #4a5060;
  appearance:none;-webkit-appearance:none;
  background:#313640;
  cursor:pointer;padding:0;flex:0 0 auto;
  transition:background .16s ease,border-color .16s ease,box-shadow .16s ease}
.roost-switch::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:#c9cedb;
  transition:transform .16s cubic-bezier(.2,.8,.2,1),background .16s ease}
/* 开启态：DSH 品牌蓝（该变量在 app.asar 里的 fallback 值），深色里一眼看出开了 */
.roost-switch[data-on="1"]{background:#4d6bfe;border-color:#4d6bfe;
  box-shadow:0 0 0 2px rgba(77,107,254,.24)}
.roost-switch[data-on="1"]::after{transform:translateX(14px);background:#fff}
.roost-switch:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}
.roost-switch:disabled{opacity:.4;cursor:not-allowed}
@media (prefers-color-scheme: light){
  .roost-switch{background:#d5d9e2;border-color:#b9bec9}
  .roost-switch::after{background:#697080}
}
.roost-chip{padding:3px 10px;border-radius:20px;border:1px solid var(--line-soft);background:transparent;
  color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .14s,border-color .14s}
.roost-chip:hover{background:var(--hover)}
.roost-chip[data-on="1"]{border-color:var(--accent);font-weight:600;
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
.roost-chip[data-on="1"]:hover{filter:brightness(1.06)}
/* 档位预设按能碰到的东西分级上色：只读最轻、全权最重，一眼看出放开到哪一层 */
.roost-chip[data-on="1"][data-role="inherit"]{border-color:var(--accent);
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
.roost-chip[data-on="1"][data-role="chat"]{border-color:#94a3b8;
  background:color-mix(in srgb,#94a3b8 20%,transparent)}
.roost-chip[data-on="1"][data-role="read"]{border-color:#22c55e;
  background:color-mix(in srgb,#22c55e 18%,transparent)}
.roost-chip[data-on="1"][data-role="work"]{border-color:#eab308;
  background:color-mix(in srgb,#eab308 22%,transparent)}
.roost-chip[data-on="1"][data-role="all"]{border-color:#ef4444;
  background:color-mix(in srgb,#ef4444 18%,transparent)}
.roost-fact{display:flex;gap:8px;align-items:flex-start;padding:5px 0;font-size:12.5px;
  border-top:1px solid var(--line-soft)}
.roost-fact:first-child{border-top:none}
.roost-fact span{flex:1;min-width:0;word-break:break-word}
.roost-fact-x{flex:0 0 auto;border:none;background:transparent;color:inherit;opacity:.65;cursor:pointer;
  font:inherit;font-size:14px;line-height:1;padding:2px 5px;border-radius:5px}
/* 删除只在鼠标移到这一行时才显眼：平时淡到几乎看不见，避免误点 */
.roost-fact:hover .roost-fact-x,.roost-fact-x:focus-visible{opacity:.75}
.roost-fact-x:hover{opacity:1;color:var(--bad);background:var(--hover)}
.roost-fact-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media (hover:none){.roost-fact-x{opacity:.65}}
/* 危险动作：默认低饱和红，二次确认后实心红——和普通按钮明确区分 */
/* 危险动作：平时和普通按钮一样（列表里挂一排红框非常吵），点一下才变红 */
.roost-btn.danger{color:inherit;border-color:var(--line)}
.roost-btn.armed{background:var(--bad);border-color:var(--bad);color:#fff}
.roost-link{border:none;background:transparent;color:var(--accent);font:inherit;font-size:11.5px;
  cursor:pointer;padding:0 2px;text-decoration:underline;text-underline-offset:2px}
.roost-link:hover{filter:brightness(1.12)}

/* 条形（只读读数，不是滑块：不给手柄，免得让人以为能拖） */
.roost-bar{display:flex;flex:1;height:8px;border-radius:4px;overflow:hidden;
  background:var(--dsw-alias-fill-l2, color-mix(in srgb, currentColor 13%, transparent));
  box-shadow:inset 0 0 0 1px var(--line-soft)}
/* 双向条的中轴线：用渐变画，不额外放元素（少一个绝对定位的隐患） */
.roost-bar.is-bi{
  background-image:linear-gradient(90deg,transparent 49.6%,var(--line) 49.6%,var(--line) 50.4%,transparent 50.4%)}
.roost-bar i{display:block;height:100%;border-radius:4px;background:var(--accent)}
/* 条形不做过渡：这是读数，不是会连续变化的控件；
   过渡会在数据落地那一下给元素提层，紧接着又整页重排，白白多一轮重绘 */
.roost-bar.is-bi i{background:var(--warn)}

/* ── 2026-11-11 重设计：页头字阶、窄栏收束、动效降级 ── */
.roost-title-lg{font-size:18px;font-weight:600;letter-spacing:-.02em;line-height:1.3}
.roost-sub{font-size:11.5px;line-height:1.55;
  color:var(--dsw-alias-label-tertiary,inherit);margin-top:2px}
/* 标题行：左标题 / 右快速开关。flex-wrap 是给窄栏兜底的，
   正常宽度下永远是一行 */
.roost-head-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.roost-head-quick{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.roost-head-q{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:1;
  color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;white-space:nowrap}
/* 窄栏里只留开关本身：三组「文字+开关」会把页签条挤到第二屏 */
@container (max-width:620px){
  .roost-head-q span{display:none}
  .roost-head-quick{gap:10px}
}
/* 面板在窄侧栏里：统计卡回到两列，页头与页签一起收紧 */
@container (max-width:620px){
  .roost-head{padding:12px 16px 0}
  .roost-scroll-body{padding:16px 16px 40px}
  /* 窄栏里一级分组要挤进一行：4 个分组在 300px 左右刚好放得下，
     再宽一点就会把最后一个挤到第二行，看着像"系统"掉队了 */
  .roost-grp{padding:0 8px;height:28px;font-size:12px;gap:4px}
  .roost-grp svg{width:13px;height:13px}
  .roost-tab{padding:7px 9px 8px;font-size:12px}
  .roost-tab::after{left:9px;right:9px}
  /* 窄侧栏收成 2 列 3 行，和 dsh-context 在 640px 以下的做法一致 */
  .roost-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .roost-stat{padding:6px}
  .roost-stat b{font-size:20px}
}
/* ── 群聊页卡片（2026-11-13）───────────────────────────────────
 * 形态借 aurabot beta 的 Group 页：一张卡 = 一句说明 + 若干行，
 * 每行左边「标题 + 小字解释」、右边控件，总开关挂在卡片右上。
 *
 * 配色不跟它的海蓝（--ab-sea #3d7fd6 / --ab-foam），这里全部走本项目
 * 的主题令牌；唯一的 --g-tint 是 accent 的淡混合，深色主题会自动跟着变，
 * 不会在某天主题切换后变成一块突兀的蓝。
 */
.roost-g-card{
  --g-tint:color-mix(in srgb, var(--accent) 9%, transparent);
  /* 2026-11-13 主人：卡片背景不好看，去掉。群聊页与其它页统一成
     「分节标题 + 上边线分隔」，不再套一层带边框的灰底方块。
     --g-tint 仍保留：下面的提示块/日志行还要用它。 */
  border:0;border-radius:0;background:transparent;padding:0;
}
.roost-g-desc{margin:0 0 10px;font-size:12px;line-height:1.6;
  color:var(--dsw-alias-label-secondary, inherit);opacity:.92}
.roost-g-row{display:flex;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--line-soft)}
.roost-g-desc + .roost-g-row{border-top:0}
.roost-g-label{flex:1 1 45%;min-width:0}
.roost-g-label b{display:block;font-size:12.5px;font-weight:600}
.roost-g-label small{display:block;font-size:11.5px;line-height:1.5;margin-top:2px;
  color:var(--dsw-alias-label-secondary, inherit);opacity:.85}
.roost-g-ctl{flex:0 0 auto;display:flex;align-items:center;gap:6px;max-width:55%;flex-wrap:wrap;justify-content:flex-end}
.roost-g-num{width:76px;box-sizing:border-box;padding:5px 8px;border:1px solid var(--line);border-radius:8px;
  background:var(--field);color:inherit;font:inherit;font-size:12.5px;text-align:right}
.roost-g-num:focus,.roost-g-sel:focus,.roost-g-area:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
.roost-g-sel{padding:5px 8px;border:1px solid var(--line);border-radius:8px;
  background:var(--field);color:inherit;font:inherit;font-size:12.5px;max-width:100%}
.roost-g-sel option{background:#1c1d22;color:#e9eaee}
.roost-g-unit{font-size:11.5px;color:var(--dsw-alias-label-secondary, inherit);opacity:.85}
.roost-g-area{width:100%;min-height:58px;padding:7px 9px;box-sizing:border-box;
  border:1px solid var(--line);border-radius:8px;background:var(--field);
  color:inherit;font:inherit;font-size:12.5px;resize:vertical}
.roost-g-note{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--g-tint);
  font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary, inherit)}
/* 2.2b：决策链 / 按群覆写列表。同样只用主题令牌，浅色主题下不会冒出黑底 */
.roost-g-log{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:260px;overflow:auto}
.roost-g-log-row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;
  padding:6px 9px;border-radius:8px;background:var(--g-tint);font-size:11.5px;line-height:1.5}
.roost-g-log-row b{flex:0 0 auto;font-variant-numeric:tabular-nums;font-weight:600}
.roost-g-tag{flex:0 0 auto;padding:1px 6px;border:1px solid var(--line);border-radius:6px;font-size:11px}
.roost-g-log-row span:last-child{flex:1 1 160px;min-width:0;word-break:break-all}
.roost-g-ov{margin-top:8px;border-top:1px solid var(--line-soft);padding-top:8px;
  display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11.5px}
@container (max-width:520px){
  .roost-g-row{flex-direction:column;align-items:stretch;gap:6px}
  .roost-g-ctl{max-width:100%;justify-content:flex-start}
}
@media (prefers-reduced-motion:reduce){
  .roost-sec{animation:none}
  .roost-stat,.roost-btn,.roost-primary,.roost-tab,.roost-sec-fold,.roost-input{transition:none}
  .roost-stat:hover,.roost-primary:hover:not(:disabled){transform:none}
}
`

    function useStyle() {
      useEffect(() => {
        if (document.getElementById('roost-style')) return
        const el = document.createElement('style')
        el.id = 'roost-style'
        el.textContent = CSS
        document.head.appendChild(el)
        // 卸载时不留垃圾；DSH 会重载插件，重复插入会叠加
        return () => {
          el.remove()
        }
      }, [])
    }

    /* ---------------- 小零件 ---------------- */

    const Pill = ({ tone, children }) => h('span', { className: 'roost-pill' + (tone ? ' ' + tone : '') }, children)

    /**
     * 分节：编号徽标 + 标题 + 操作槽 + 折叠开关。整个面板的排版骨架。
     *
     * 2026-11-11 重设计：配置、记忆、能力这些页一次铺开 6–7 节，
     * 读起来是一整面文字墙。现在每节都能收起，状态按「编号 + 标题」
     * 记在模块级表里：同页内稳定、不同页不串、也不写 localStorage
     *（折叠只是本次使用习惯，不该变成长期配置）。默认全展开，
     * 首屏信息和既有渲染断言一条都不少。
     */
    const foldState = Object.create(null)

    function Sec({ n, title, children, right, defaultOpen = true }) {
      const key = String(n || '') + '|' + String(title || '')
      /**
       * 默认展开/折叠：`foldState` 里有记录就按用户的（他手动动过），
       * 没有才用 defaultOpen。长分节（日记/关系/召回记录）默认收起，
       * 否则一进记忆页就是一屏几千字，想找的那块得滚半天。
       */
      const [open, setOpen] = useState(() => (key in foldState ? foldState[key] !== false : defaultOpen))
      return h('div', { className: 'roost-sec' + (open ? '' : ' is-folded') },
        h('div', { className: 'roost-sec-h' },
          n ? h('span', { className: 'roost-sec-n' }, n) : null,
          h('span', { className: 'roost-sec-t' }, title),
          right ? h('span', { className: 'roost-sec-acts' }, right) : null,
          h('button', {
            type: 'button',
            className: 'roost-sec-fold',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': (open ? '收起' : '展开') + String(title || '这一节'),
            title: open ? '收起这一节' : '展开这一节',
            onClick: () => {
              const next = !open
              foldState[key] = next
              setOpen(next)
            },
          }, open ? '−' : '+'),
        ),
        /* 常驻渲染，折叠只由 CSS 隐藏：收起时组件不卸载，
           输入框里没提交的内容、弹窗开关状态都还在，功能一条不少 */
        children,
      )
    }

    const Row = ({ k, children }) =>
      h('div', { className: 'roost-row' },
        h('div', { className: 'roost-k' }, k),
        h('div', { className: 'roost-v' }, children),
      )

    /**
     * 多久以前。面板里只需要粗粒度（「3 小时前」就够），
     * 不引 dayjs 那类库——一个插件为了一行字加个依赖不值得。
     */
    const sinceText = (t) => {
      const n = Number(t) || 0
      if (!n) return ''
      const m = Math.round((Date.now() - n) / 60000)
      if (m < 1) return '刚刚'
      if (m < 60) return `${m} 分钟前`
      const hr = Math.round(m / 60)
      if (hr < 48) return `${hr} 小时前`
      return `${Math.round(hr / 24)} 天前`
    }

    /**
     * 条形：单向从左往右，双向从中线往两边长。
     *
     * **这是读数，不是滑块**：所以不给手柄、不接受拖动。
     * 之前画了个竖向游标，看起来像能拖，实际拖不动——暗示错了比没画更糟。
     * 双向那条保留中轴线，正负一眼看得出就够了。
     */
    /**
     * 条形：单向从左往右，双向从中线往两边长。**只读**，不给手柄、不能拖。
     *
     * 刻意不用绝对定位：填充条用 margin-left + width 排在正常流里。
     * 之前是 `i{position:absolute;top:0;bottom:0}` + `.roost-bar{position:relative}`，
     * 一旦 `.roost-bar` 那条规则失效（这次是 CSS 里混进了 JS 的 `//` 注释，
     * 把它粘成非法选择器），填充条就脱离父容器、按视口铺满整页——
     * 而且它本身可点，会把下面所有按钮的点击全吃掉。
     * 正常流里最坏只是条画歪，不会变成盖住半屏的挡板。
     */
    const Bar = ({ v, bi, tone }) => {
      const val = Math.max(-1, Math.min(1, Number(v) || 0))
      const pct = bi ? Math.round(((val + 1) / 2) * 100) : Math.round(Math.max(0, val) * 100)
      const w = bi ? Math.abs(val) * 50 : Math.max(0, val) * 100
      const left = bi ? (val >= 0 ? 50 : 50 - w) : 0
      return h('div', {
        className: 'roost-bar' + (bi ? ' is-bi' : ''),
        role: 'img',
        'aria-label': `${pct}%`,
        title: `${pct}%（只读，情绪由她自己变）`,
      }, h('i', {
        style: { marginLeft: left + '%', width: w + '%', ...(tone ? { background: tone } : {}) },
      }))
    }

    /** 情绪三项的读法：数字是内部量，人看的是词 */
    /** 三条各用一个色：玫瑰=情绪温度、琥珀=体力能量、青蓝=表达沟通。
        深色底上都要够亮；不使用纯红/纯绿，避免被读成「好/坏」的判定色。 */
    const MOOD = [
      { key: 'valence', label: '心情', bi: true, tone: '#e8799f', words: ['很糟', '不太好', '一般', '还行', '不错'] },
      { key: 'energy', label: '精力', bi: false, tone: '#e0a23c', words: ['很累', '有点累', '一般', '有精神', '很活跃'] },
      { key: 'sociability', label: '想说话', bi: false, tone: '#3fa7d6', words: ['不想理人', '有点闷', '一般', '想聊', '很想说'] },
    ]

    /**
     * 取值 → 五个词里挑一个。
     *
     * `bi` 决定量纲：心情是 -1..1（要折成 0..1），另外两条本来就是 0..1。
     * 不区分就会把 -0.6 的心情说成「还行」。
     */
    function wordOf(v, words, bi) {
      if (!words) return ''
      const raw = Number(v) || 0
      const x = bi ? (raw + 1) / 2 : raw
      const i = Math.min(words.length - 1, Math.max(0, Math.floor(x * words.length)))
      return words[i]
    }

    /** 统计卡：小标题 k / 大数字 n / 副标题 sub。老调用只给 label 时仍是两行。
        hint 放 title，长诊断（trace / 耗时拆分）不丢，但不会把卡片撑歪。 */
    /** title 要同时带口径说明与副标题：窄栏里 .sub 是 ellipsis，
        只挂 hint 的话被截断的副标题连悬停都看不全。 */
    const Stat = ({ n, label, k, sub, tone, hint }) =>
      h('div', {
        className: 'roost-stat ov-tipbox',
        'data-tip': [hint, sub || label].filter(Boolean).join(' · '),
        title: [hint, sub || label].filter(Boolean).join(' · '),
      },
        k ? h('span', { className: 'k' }, k) : null,
        h('b', {
          style: tone === 'bad' ? { color: 'var(--bad)' } : tone === 'ok' ? { color: 'var(--ok)' } : null,
        }, n),
        h('span', { className: 'sub' }, sub || label),
      )

    /** 一行状态提示：只在真有问题（或真的好）时出现 */
    function Banner({ st, setupSt }) {
      if (!st) return h('div', { className: 'roost-banner bad' },
        h('b', null, '读不到宿主状态。'),
        h('i', null, '「刷新」再试一次；一直这样说明插件没加载完，重载 DSH。'))
      const lt = st.lastTurn
      if (!st.listening) {
        return h('div', { className: 'roost-banner bad' },
          h('b', null, `宿主没在听（端口 ${st.port}）。`),
          h('i', null,
            '固定服务（/v1 控制面、TTS）没人听，扩展和语音会失败。'
            + (st.serverError ? `原因：${st.serverError}。` : '')
            + ' 常见是端口被占或上一轮没退干净——重启 DSH 让端口释放。'))
      }
      if (st.fenceDegraded) {
        return h('div', { className: 'roost-banner bad' },
          h('b', null, '面板接口没有会话鉴权。'),
          h('i', null,
            '当前宿主没有 connection 服务，面板只剩「本机 + 同源」校验——'
            + '本机上的任何程序都能调这些接口。功能不受影响，但别在共用机器上长期这样跑。'))
      }
      if (st.pathErrorCount) {
        /**
         * 链路错误：消息进来了但没处理成一轮，或者轮次成了但回话发不出去。
         *
         * 这类问题以前完全不可见——面板全绿、`lastTurn` 也是 ok，
         * 只有插件日志里一行 `xxx 失败（已吞）`。2026-11-13 两次
         * 「先全绿再不回话」就是这么耗掉的半天。
         */
        const last = (st.pathErrors || [])[st.pathErrors.length - 1] || {}
        const ago = last.at ? Math.max(0, Math.round((Date.now() - last.at) / 1000)) : 0
        return h('div', { className: 'roost-banner bad' },
          h('b', null, `链路里有 ${st.pathErrorCount} 条错误。`),
          h('i', null,
            `${last.stage || '未知阶段'}：${last.message || '未知错误'}`
            + (ago ? `（${ago < 60 ? `${ago} 秒前` : `${Math.round(ago / 60)} 分钟前`}）` : '')
            + ' —— 细节看「排障」（带 stack 前两帧），或重启 DSH 让代码回到干净状态。'))
      }
      if (!st.chats) {
        return h('div', { className: 'roost-banner' },
          h('b', null, '还没有会话接进来。'),
          h('i', null, '在群里说一句话就会自动建一个；也可以先跑一次自测。'))
      }
      if (lt && !lt.ok) {
        return h('div', { className: 'roost-banner bad' },
          h('b', null, '最近一轮失败了。'),
          h('i', null, `${lt.error || '未知错误'} —— 细节看「排障」。`))
      }
      return null
    }

    /* ---------------- 更新横幅（概览页） ---------------- */

    /** localStorage：这一版先不提醒 / 上次看到过的版本（用来判断「刚更新完」） */
    const UPD_SKIP = 'roost.update.skip'
    const UPD_SEEN = 'roost.update.seen'
    const lsGet = (k) => { try { return localStorage.getItem(k) || '' } catch { return '' } }
    const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch {} }

    /** RELEASE_NOTES 一段太长：横幅里只放「一句话」那行，完整内容折进 details */
    const notesBrief = (s) => {
      const t = String(s || '')
      const m = t.match(/^一句话[：:]\s*(.+)$/m)
      if (m) return m[1].trim()
      const line = t.split('\n').find((l) => l.trim() && !/^#/.test(l))
      return line ? line.trim() : ''
    }

    /**
     * 装不了时，为什么只能给命令（三种装法各有各的说法）。
     *
     * `link:` 装法**不能给 add 命令**：`dsh plugin add` 就是把参数转发给
     * pnpm，`pnpm add dsh-roost@x` 会把 `"link:…"` 换成真实版本，
     * 符号链接当场变目录、改源码不再生效。开发机的更新方式是 git pull。
     */
    const whyManual = (i) => i.linked || i.kind === 'linked'
      ? '开发模式（link: 装法）：这是源码目录，更新请 git pull 后重启 DSH。别跑 plugin add——那会把符号链接换成真实目录，之后改源码就不再生效。'
      : i.hasManager === false
        ? '这个 DSH 版本没有 pluginManager：把下面这行粘到 PowerShell 里跑，跑完重启 DSH。'
        : i.kind === 'unknown'
          ? '找不到已安装的目录：确认下面命令里的 profile 名对不对，再跑。'
          /**
           * 真实目录 + 有 pluginManager，却还是不给按钮 = 这个 DSH 只有
           * `installBundle`（按包名拒绝已存在的包），没有升级用的 `updateBundle`。
           * 这时候「DSH 不让面板自己装」是误导——它让装新包，只是升不了级。
           */
          : i.kind === 'real' && i.hasManager
            ? '这个 DSH 版本的插件面板只能装新包、装不了升级：把下面那行粘到 PowerShell 里跑，跑完重启 DSH。'
            : 'DSH 不让面板自己装：把下面这行粘到 PowerShell 里跑，跑完重启 DSH。'

    /**
     * 概览页顶部的更新横幅。
     *
     * **自己不查更新**：只读 `/update/check` 的后台快照——插件启动 10 秒后查
     * 一次、之后每 6 小时一次，结果存在服务端。没新版就返回空，一个像素不占；
     * 也不会因为「用户打不打开面板」决定有没有人检查。
     *
     * 能自更新（真实目录 + 有 pluginManager）就直接给按钮，点一下装完；
     * 装不了（开发模式 / 老 DSH / DSH 拒绝重装）才把手动命令顶上来。
     */
    function UpdateBanner({ toast }) {
      const [info, setInfo] = useState(null)
      const [busy, setBusy] = useState(false)
      const [skip, setSkip] = useState(() => lsGet(UPD_SKIP))
      /** 刚更新完：显示这一版改了什么（只在版本变过时出现一次） */
      const [notes, setNotes] = useState(null)

      const fetchInfo = async (force) => {
        try {
          const r = await get('/update/check' + (force ? '?force=1' : ''))
          setInfo(r)
          return r
        } catch {
          setInfo(null)
          return null
        }
      }

      /**
       * `pending` = 后台还没查完（刚启动 10 秒内）：4 秒后再问一次。
       *
       * 最多重试 5 次就停：后台检查被环境变量关掉时（`DSH_ROOST_NO_UPDATE_WATCH=1`）
       * 会永远 pending，无上限重试等于给首页挂了一个永不停机的定时器。
       */
      useEffect(() => {
        let timer = null
        let alive = true
        let tries = 0
        const tick = async () => {
          const r = await fetchInfo(false)
          if (!alive) return
          if (r && r.pending && tries++ < 5) timer = setTimeout(tick, 4000)
        }
        tick()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [])

      /** 版本变过才弹「这次改了什么」；第一次装（没记录）只记下版本，不弹 */
      const own = info && info.own ? info.own : ''
      useEffect(() => {
        if (!own) return
        const seen = lsGet(UPD_SEEN)
        if (!seen) { lsSet(UPD_SEEN, own); return }
        if (seen === own) return
        get('/update/notes').then((r) => { if (r && r.notes) setNotes(r) }).catch(() => {})
      }, [own])

      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          toast('命令复制好了，粘到 PowerShell 里跑')
        } catch {
          toast('复制失败，手动选中那行命令复制')
        }
      }

      const doSelf = async () => {
        setBusy(true)
        try {
          /**
           * 横幅只有一颗按钮，所以**冷却期内直接带 `fresh`**。
           *
           * 不带的话 pnpm 的 `minimumReleaseAge` 会把刚发的版本过滤掉：
           * 轻则静默装回旧版，重则 `no-matching-version`——用户看到的就是
           * 「有新版本、点了没反应」。设置页那边有单独的「立即安装」按钮，
           * 这里没有，就别让他为了一条 yaml 豁免多跑一趟。
           */
          const fresh = Boolean(info && (info.cooling || info.coolingUnknown))
          const r = await post('/update/self', { fresh })
          toast(r.message || (r.ok ? '装好了，重启 DSH 生效' : '没更新成'))
          await fetchInfo(true)
        } finally {
          setBusy(false)
        }
      }

      const pending = Boolean(info && info.pending)
      const restart = Boolean(info && info.ok !== false && info.pendingRestart && !info.hasUpdate)
      /** 源地址只留主机名（和设置页同一口径） */
      const hostOf = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
      /** 跳过的是**这一版**：出了下一版还会提示 */
      const upd = Boolean(info && info.ok !== false && info.hasUpdate && info.latest
        && !pending && skip !== info.latest)

      return h('div', null,
        notes
          ? h('div', { className: 'roost-banner' },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                h('b', null, `已更新到 v${notes.version || own}`),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  onClick: () => { lsSet(UPD_SEEN, own); setNotes(null) },
                }, '知道了')),
              h('i', null, notesBrief(notes.notes)),
              h('details', { className: 'roost-note', style: { marginTop: 6 } },
                h('summary', { style: { cursor: 'pointer', fontSize: 11.5 } }, '这次改了什么'),
                h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, lineHeight: 1.7 } }, notes.notes)))
          : null,

        upd
          ? h('div', { className: 'roost-banner warn' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('b', null, `有新版本 v${info.latest}`),
                h('i', { style: { margin: 0 } }, `（现在是 v${info.own}）`),
                h('span', { style: { flex: '1 1 auto' } }),
                info.canSelf
                  ? h('button', {
                      type: 'button', className: 'roost-primary', disabled: busy, onClick: doSelf,
                    }, busy ? '安装中…' : `更新到 v${info.latest}`)
                  : null,
                h('button', {
                  type: 'button', className: 'roost-btn',
                  title: '这一版先不提醒；出了下一版还会提示',
                  onClick: () => { lsSet(UPD_SKIP, info.latest); setSkip(info.latest) },
                }, '这版先不提醒')),
              h('i', null, info.canSelf
                ? '装完重启 DSH 才生效；设置、人格、记忆、扩展都不动。'
                : whyManual(info)),
              /**
               * 镜像滞后时把话说在前面：用户看到「你的源上是旧版」就不会以为
               * 是更新坏了，也不会为了更新去手动换源——这次装的是官方那份。
               */
              info.mirrorLag
                ? h('i', null, info.canSelf
                  ? `你配的源（${hostOf(info.registry)}）还没同步 v${info.latest}，`
                    + '这次直接从官方源装，装完重启 DSH 才生效。'
                  // 装不了的时候别许一个我们做不到的承诺（link: 装法根本没按钮）；
                  // 下面那行手动命令已经自带 --registry，不用再叮嘱一遍
                  : `你配的源（${hostOf(info.registry)}）还没同步 v${info.latest}。`)
                : null,
              /** `link:` 装法没有可用命令（服务端返回空串）：只留上面那句「git pull 后重启」 */
              info.command
                ? h(info.canSelf ? 'details' : 'div', { className: 'roost-cmd' },
                    info.canSelf
                      ? h('summary', null, '或者自己在 PowerShell 里跑（一行就够）')
                      : null,
                    h('code', null, info.command),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => copy(info.command),
                    }, '复制'))
                : null)
          : null,

        restart
          ? h('div', { className: 'roost-banner' },
              h('b', null, `v${info.installed} 已经装好，等重启`),
              h('i', null, '重启 DSH 之后版本号和功能才会变；设置、人格、记忆、扩展都不受影响。'))
          : null,
      )
    }

    /** 分步：编号节点 + 竖线 + 标题说明 + 右侧动作 */
    const Step = ({ n, state, title, desc, children, extra }) =>
      h('div', { className: 'roost-step ' + (state || 'todo') },
        h('div', { className: 'roost-node ' + (state || 'todo') },
          state === 'done' ? '✓' : state === 'bad' ? '!' : n),
        h('div', { className: 'roost-rail' }),
        h('div', { className: 'roost-body' },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('div', { className: 'roost-title' }, title),
            children ? h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' } }, children) : null,
          ),
          h('div', { className: 'roost-note', style: { marginTop: 2 } }, desc),
          extra || null,
        ),
      )

    /**
     * 二次确认的行内按钮：删/清这类不可逆动作都要过一次。
     *
     * 习惯上分三段：平时是灰底普通按钮 → 点一下变成红底「确认删除」→ 再点才执行。
     * 4 秒没点就自己退回，不会一直挂在「确认」状态等人误触。
     */
    function ConfirmLink({ label, confirmLabel, onConfirm, disabled, danger = true, style = null }) {
      const [arm, setArm] = useState(false)
      useEffect(() => {
        if (!arm) return
        const t = setTimeout(() => setArm(false), 4000)
        return () => clearTimeout(t)
      }, [arm])
      return h('button', {
        type: 'button',
        className: 'roost-btn' + (danger ? ' danger' : '') + (arm ? ' armed' : ''),
        style,
        disabled,
        onClick: () => {
          if (!arm) return setArm(true)
          setArm(false)
          onConfirm()
        },
      }, arm ? confirmLabel : label)
    }

    /* ---------------- 概览 ---------------- */

    /**
     * 端口那一节到底该显示什么。**纯函数，好测**。
     *
     * 配置是**意愿**，实际 bind 的是**现实**，被占后会顺延。
     * 「配置 17321、实际 17322」必须让用户看见——否则他按 17321 去连，
     * 怎么都连不上还以为是插件坏了。
     *
     * 但反过来更危险：`actualPort` 还是 0 的时候（服务刚起、或重启那几百毫秒），
     * 拿配置值冒充「我们实际在听的端口」，就会给出一条**假红字**，
     * 用户照着它去改一个本来就对的值。所以这里宁可说「还不知道」。
     */
    /**
     * 概览页「直连状态」那一格的结论全部在这里算，别在渲染层自己拼。
     *
     * 移除 ai-chat 之后只有一个通道，不再有「两端端口对不对得上」这回事——
     * 消息由框架外接协议的事件流推进来，能不能收到全看连没连上 + seq 有没有推进。
     */
    function portView(st) {
      const r = st?.roost || {}
      const map = {
        online: { kind: 'ok', text: '✓ 已连上外接协议，消息直接进来' },
        /** 对端没启动：不是错误，别用红字吓人 */
        waiting: { kind: 'unknown', text: 'Roost 没在运行，启动后会自动连上' },
        connecting: { kind: 'unknown', text: '正在连 Roost…' },
        reconnecting: { kind: 'unknown', text: '断了，正在重连（会从上次的 seq 补拉）' },
        error: { kind: 'bad', text: `✗ 连不上：${r.lastError || '未知原因'}` },
        stopped: { kind: 'unknown', text: '已停止（配置关了或插件已卸载）' },
      }
      const it = map[r.state] || { kind: 'unknown', text: `状态：${r.state || '还没开始'}` }
      return {
        kind: it.kind,
        /** 停在同一个数字 = 事件没进来，比「指示灯绿着」更能说明问题 */
        cell: r.seq ? `seq ${r.seq}` : '—',
        text: it.text,
      }
    }

    function OverviewTab({ st, setupSt, toast, reload, busy, onGo, logs }) {
      /** 「重新打开向导」按钮的忙碌态，和外面的 busy（自测）分开 */
      const [wizardBusy, setWizardBusy] = useState(false)
      const reopenWizard = async () => {
        setWizardBusy(true)
        try {
          const r = await post('/setup/wizard/reopen', {})
          toast(r?.ok === false ? (r.message || '没打开') : '向导已重新打开')
          reload()
        } finally { setWizardBusy(false) }
      }
      /** 洞察区数据：/usage 按日历天补齐（56 天够画 7 天柱状图 + 8 周活跃度），
       *  /chats 是我们自己创建并持有的 QQ↔DSH 会话清单。
       *  两份都只读 dsh-roost 的账本，不会把宿主 DSH 里手动开的会话算进来。
       *  只在挂载时拉一次，不加定时器；切回概览页会重拉，但两次请求都很轻。 */
      const [usage, setUsage] = useState(null)
      const [myChats, setMyChats] = useState(null)
      useEffect(() => {
        let alive = true
        Promise.all([get('/usage?days=56'), get('/chats')])
          .then(([u, c]) => {
            if (!alive) return
            setUsage(u.ok === false ? null : u)
            setMyChats(c.ok === false ? null : (Array.isArray(c.chats) ? c.chats : []))
          })
          .catch(() => {})
        return () => { alive = false }
      }, [])
      /** 会话筛选（对方洞察页下半部分）：搜索 / 群私聊 / 时间范围 / 排序 / 分页 */
      const [qText, setQText] = useState('')
      const [qKind, setQKind] = useState('all')
      const [qRange, setQRange] = useState('all')
      const [qSort, setQSort] = useState('recent')
      const [qPage, setQPage] = useState(0)
      const [starting, setStarting] = useState(false)
      const perms = st?.permissions || {}
      const toolable = ['owner', 'admin', 'member'].filter((k) => perms[k] === 'all')
      const lt = st?.lastTurn
      /** 后端还没重启时这几个字段都不存在，一律给兜底，不能让概览整页白掉 */
      const capsOn = Boolean(st?.capabilitiesEnabled)
      const q = st?.queue || { busy: 0, pending: 0, lanes: 0 }
      const today = st?.today || null
      const tools = st?.qqTools || null
      /** token 只给量级，别在数字格里塞一长串；过了百万就换 M，别写出 1162.5k */
      const tokens = today ? (today.uncached + today.cacheRead + today.cacheWrite + today.output) : 0
      const fmtNum = (v) => {
        const n = Number(v) || 0
        if (!Number.isFinite(n)) return '—'
        return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M`
          : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
      }
      const tokenText = fmtNum(tokens)
      /** 命中率直接用后端 `usage.summary().total.cacheHit`（三个计费桶做分母），
          不在前端另算一遍：自算的两桶口径会和上下文页的「命中率」差出一截。 */
      const cacheHit = today && Number.isFinite(today.cacheHit) ? today.cacheHit : null

      /** 一天的四类 Token 合计。/usage 的 days 是日历天补齐的，空天全是 0 */
      const sumDay = (d) => (Number(d?.uncached) || 0) + (Number(d?.cacheRead) || 0)
        + (Number(d?.cacheWrite) || 0) + (Number(d?.output) || 0)
      const usageDays = Array.isArray(usage?.days) ? usage.days : []
      const last7 = usageDays.slice(-7)
      const heatDays = usageDays.slice(-56)
      /** 3.1：金额。后端已经按峰/谷分别折价；未定价的 token 如实报数量不猜价 */
      const costToday = usageDays.length ? usageDays[usageDays.length - 1]?.cost : null
      const cost7 = last7.reduce((a, d) => a + (Number(d?.cost?.yuan) || 0), 0)
      const unpriced7 = last7.reduce((a, d) => a + (Number(d?.cost?.unpricedTokens) || 0), 0)
      const costText = costToday?.priced ? `¥${Number(costToday.yuan).toFixed(2)}` : null
      const cost7Text = cost7 > 0 ? `近 7 天 ¥${cost7.toFixed(2)}` : ''
      const unpricedText = unpriced7 > 0 ? `未定价 ${fmtNum(unpriced7)} tokens` : ''
      /** 最近一轮的结论：ok 字段缺失是「没读到」，不能当成「失败」报红 */
      const turnWord = !lt ? '本次启动暂无记录'
        : lt.ok === false ? '最近一轮失败'
          : lt.ok ? `回了 ${lt.len ?? 0} 字` : '本轮状态未知'

      /** 占比别用整数百分比：输出只占万分之四，Math.round 会把它显示成 0%，
          看着像没统计。零值留空，非零但不到 0.1% 显示 <0.1%。 */
      const pctText = (v, total) => {
        if (!Number.isFinite(v) || !Number.isFinite(total)) return '—'
        if (!(total > 0) || !(v > 0)) return '—'
        const p = v / total * 100
        return p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`
      }

      /** 环形图：SVG 描边拼接，不引图表库。parts = [{k, v, c}] */
      const donut = (parts, center, cap) => {
        const total = parts.reduce((a, p) => a + (Number(p.v) || 0), 0)
        const C = 2 * Math.PI * 38
        let off = 0
        return h('div', { className: 'ov-donut-row' },
          h('svg', { className: 'ov-donut', viewBox: '0 0 100 100', 'aria-hidden': 'true' },
            h('circle', { cx: 50, cy: 50, r: 38, fill: 'none', stroke: 'var(--field)', 'stroke-width': 12 }),
            total > 0 ? parts.filter((p) => p.v > 0).map((p) => {
              const len = p.v / total * C
              const el = h('circle', {
                key: p.k, className: 'ov-seg', cx: 50, cy: 50, r: 38, fill: 'none', stroke: p.c,
                'stroke-width': 12, 'stroke-dasharray': `${len} ${C - len}`,
                'stroke-dashoffset': -off, transform: 'rotate(-90 50 50)',
              }, h('title', null, `${p.k} · ${fmtNum(p.v)} tokens · ${pctText(p.v, total)}`))
              off += len
              return el
            }) : null,
            h('text', { x: 50, y: 52, 'text-anchor': 'middle', 'font-size': 12,
              fill: 'var(--dsw-alias-label-primary, inherit)' }, center),
          ),
          h('div', { className: 'ov-legend' },
            parts.map((p) => h('div', {
              key: p.k, title: `${p.k} · ${fmtNum(p.v)} tokens`,
            },
              h('i', { style: { background: p.c } }),
              h('span', { className: 't' }, p.k),
              h('span', { className: 'v' }, pctText(p.v, total)),
            )),
            cap ? h('div', { className: 'ov-empty' }, cap) : null,
          ),
        )
      }

      /** 对应 dsh-context 底部「技能加载 / 工具调用 / 命令执行」那三格的位置；
          只给 280px 下限，内容由 grid 拉齐，不锁死高度裁内容 */
      const mini = (title, cap, rows) => h('div', { className: 'ov-panel ov-tile' },
        h('h4', null, title),
        h('div', { className: 'ov-cap' }, cap),
        rows.length
          ? rows.map(([k, v], i) => h('div', { key: i, className: 'ov-rowline' },
              h('span', { className: 't' }, k), h('span', { className: 'v' }, v)))
          : h('div', { className: 'ov-empty' }, '暂无数据'),
      )

      /** 对方 .lc-heat-0..4 的五档蓝；没有用量的日子用最低档灰 */
      const heatColor = (v, max) => {
        if (!v) return null
        const p = v / max
        const a = p > .8 ? 92 : p > .55 ? 72 : p > .3 ? 50 : p > .1 ? 28 : 16
        return a === 16
          ? 'color-mix(in srgb,var(--dsw-alias-label-secondary,inherit) 16%,transparent)'
          : `color-mix(in srgb,#3b82f6 ${a}%,transparent)`
      }
      /** 会话筛选与卡片：只在我们创建并持有的会话里筛，用量只认自己的账本 */
      const chatRow = (cid) => usage?.chats?.[cid] || null
      const chatToken = (cid) => {
        const v = chatRow(cid)
        return v ? (Number(v.uncached) || 0) + (Number(v.cacheRead) || 0)
          + (Number(v.cacheWrite) || 0) + (Number(v.output) || 0) : 0
      }
      const chatTurns = (cid) => Number(chatRow(cid)?.turns) || 0
      /** 单个会话的命中率：和后端 summary 一样用三个计费桶做分母 */
      const chatHit = (cid) => {
        const v = chatRow(cid)
        if (!v) return null
        const billed = (Number(v.uncached) || 0) + (Number(v.cacheRead) || 0)
          + (Number(v.cacheWrite) || 0)
        return billed ? Math.round((Number(v.cacheRead) || 0) / billed * 1000) / 10 : null
      }
      /** 卡里的 64px 圆环：对方画上下文组成，我们画四个计费桶 */
      const chatParts = (cid) => {
        const v = chatRow(cid) || {}
        return [
          { k: '未缓存输入', v: Number(v.uncached) || 0, c: '#4d6bfe' },
          { k: '缓存读取', v: Number(v.cacheRead) || 0, c: '#3fa7d6' },
          { k: '缓存写入', v: Number(v.cacheWrite) || 0, c: '#e0a23c' },
          { k: '模型输出', v: Number(v.output) || 0, c: '#e8799f' },
        ]
      }
      const dstr = (t) => {
        if (!Number.isFinite(Number(t)) || !(Number(t) > 0)) return '—'
        const d = new Date(Number(t))
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      }
      const relTime = (at) => {
        const t = Number(at) || 0
        if (!t) return '—'
        const diff = Date.now() - t
        if (diff < 0) return dstr(t)
        if (diff < 60000) return '刚刚'
        if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
        if (diff < 30 * 86400000) return `${Math.floor(diff / 86400000)} 天前`
        return dstr(t)
      }
      /** 对方 Donut 的 42 格 viewBox + 15.9155 半径：周长正好 100，直接按百分比拼接 */
      const ring = (parts, center) => {
        const total = parts.reduce((a, p) => a + (p.v > 0 ? p.v : 0), 0)
        let off = 0
        return h('div', { className: 'ovc-ring' },
          h('svg', { viewBox: '0 0 42 42', 'aria-hidden': 'true' },
            h('circle', {
              cx: 21, cy: 21, r: 15.9155, fill: 'none',
              stroke: 'var(--field)', 'stroke-width': 4,
            }),
            total > 0 ? parts.filter((p) => p.v > 0).map((p) => {
              const len = p.v / total * 100
              const el = h('circle', {
                key: p.k, className: 'ov-seg', cx: 21, cy: 21, r: 15.9155,
                fill: 'none', stroke: p.c, 'stroke-width': 4,
                'stroke-dasharray': `${len} ${100 - len}`, 'stroke-dashoffset': 125 - off,
              }, h('title', null, `${p.k} · ${fmtNum(p.v)} tokens · ${pctText(p.v, total)}`))
              off += len
              return el
            }) : null,
          ),
          h('div', { className: 'ovc-mid' }, h('b', null, center)),
        )
      }
      const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30, all: 0 }
      const filteredChats = (myChats || []).filter(Boolean).filter((c) => {
        if (qKind === 'group' && c.kind !== 'group') return false
        if (qKind === 'c2c' && c.kind !== 'c2c') return false
        const days = RANGE_DAYS[qRange] || 0
        if (days && Date.now() - (Number(c.at) || 0) > days * 86400000) return false
        const text = `${c.title || ''} ${c.chatId ?? ''} ${c.sessionId ?? ''} ${c.preset ?? ''}`
          .toLowerCase()
        return !qText.trim() || text.includes(qText.trim().toLowerCase())
      }).sort((a, b) => qSort === 'tokens'
        ? chatToken(b.chatId) - chatToken(a.chatId)
        : qSort === 'turns'
          ? chatTurns(b.chatId) - chatTurns(a.chatId)
          : (Number(b.at) || 0) - (Number(a.at) || 0))
      const PAGE_SIZE = 6
      const pageCount = Math.max(1, Math.ceil(filteredChats.length / PAGE_SIZE))
      const page = Math.max(0, Math.min(qPage, pageCount - 1))
      const pageChats = filteredChats.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      const chip = (label, val, cur, set, n) => h('button', {
        type: 'button', className: 'ov-chip', 'data-on': cur === val ? '1' : '0',
        onClick: () => { set(val); setQPage(0) },
      }, label, h('span', { className: 'n' }, String(n)))

      /** 接入进度上的直达按钮：后端 /setup/start、/setup/stop 与 /setup/webui 都已存在 */
      const startRoost = async () => {
        setStarting(true)
        try {
          const r = await post('/setup/start', {})
          toast(r?.ok === false ? `启动失败：${r.message || '未知'}` : (r?.message || 'Roost 已启动'))
          reload()
        } finally { setStarting(false) }
      }
      /** 在跑的时候同一颗按钮要把 Roost 关掉，别让人只能去别的页找停止 */
      const stopRoost = async () => {
        setStarting(true)
        try {
          const r = await post('/setup/stop', {})
          toast(r?.ok === false ? `关闭失败：${r.message || '未知'}` : (r?.message || 'Roost 已关闭'))
          reload()
        } finally { setStarting(false) }
      }
      const openRoostPanel = async () => {
        const r = await get('/setup/webui')
        const url = r.ok !== false ? r.url : ''
        if (url || s.webui) window.open(url || s.webui, '_blank', 'noopener')
        else toast('还没装好 Roost，没有面板可开')
      }

      /**
       * 接入进度用**真实字段**推，不再靠一个后端不存在的 `steps`。
       * 移除 ai-chat 后链路只剩四段：装好 → 有机器人凭证 → 在跑 → 外接协议连上。
       * **不包含「主人」**——主人是「谁能指挥她」，不是「链路通不通」。
       */
      const s = setupSt || {}
      const checks = [
        ['Roost 装好', s.installed],
        ['机器人凭证', s.hasCreds],
        ['Roost 在跑', s.running],
        ['外接协议已连上', st?.roost?.state === 'online'],
      ]
      const doneCount = checks.filter(([, v]) => v).length
      const allReady = doneCount === checks.length

      const selftest = async () => {
        toast('正在自测…')
        const r = await post('/selftest', {})
        toast(r.ok ? `自测通过（${r.ms}ms）：${String(r.reply || '').slice(0, 40)}` : `自测失败：${r.message || '未知'}`)
        reload()
      }

      /**
       * 端口那一段的结论全部来自 `portView`——这里不再自己拼「我们监听 …」，
       * 免得又出现「拿配置端口冒充实际端口」那种假红字。
       */
      const pv = portView(st)
      /** 跳过了向导也要一直催：不重接就是哑的，不能让「暂时跳过」变成静默 */
      const wizardPending = Boolean(st?.wizard && !st.wizard.completed)

      return h('div', null,
        h(Banner, { st, setupSt }),

        /**
         * 有新版就顶一条横幅（后台查到的，不在这里发请求）。
         * 放在故障横幅下面、接入进度上面：故障先看，更新其次。
         */
        h(UpdateBanner, { toast }),

        /** 01 接入进度放最上面（主人 2026-11-11 指定），并把两个直达按钮放这里 */
        h(Sec, { n: '01', title: '接入进度',
          right: h('span', { className: 'roost-note', style: { margin: 0 } }, `${doneCount} / ${checks.length}`) },
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
            checks.map(([label, ok]) =>
              h('span', { key: label, className: 'roost-pill' + (ok ? ' ok' : '') },
                (ok ? '✓ ' : '· ') + label),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
            /** 一颗按钮两种含义：没跑就是「启动」，在跑就是「关闭」 */
            s.running
              ? h('button', { type: 'button', className: 'roost-btn', disabled: starting,
                  title: '停掉 Roost 主进程；插件与配置都保留，下次点「一键启动」再起来',
                  onClick: stopRoost },
                  starting ? '关闭中…' : '关闭 Roost')
              : h('button', { type: 'button', className: 'roost-primary', disabled: starting, onClick: startRoost },
                  starting ? '启动中…' : '一键启动 Roost'),
            h('button', { type: 'button', className: 'roost-btn', onClick: openRoostPanel }, '打开 Roost 面板 ↗'),
            /** 向导入口不能随「五项全绿」消失：组件版本、重新检查、二维码都只在那一页 */
            h('button', { type: 'button', className: 'roost-btn', onClick: () => onGo('setup') },
              allReady ? '接入向导 / 组件版本' : '去接入'),
          ),
          h('div', { className: 'roost-note' },
            allReady
              ? '链路这五项都齐了。剩下两件手工做：请群主在手机 QQ 里给群开「接收所有消息」、把机器人拉进群。'
              : '缺哪一步在那一页有单独说明和按钮。'),
        ),

        /** 02 洞察区：网格严格按 dsh-context 的 .lc-ov-first / .lc-ov-stats / .lc-ov-tiles。
            指标仍用我们自己的（四类 Token、三段耗时、我们创建的会话）。 */
        h(Sec, { n: '02', title: '现在这样',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          // 第一行：六格 KPI + 近 7 天用量
          h('div', { className: 'ov-first' },
            h('div', { className: 'roost-grid' },
              h(Stat, {
                k: '托管会话',
                n: st ? (st.chats ?? 0) : '—',
                sub: st ? `正在等 DSH 回复 ${st.waiting ?? 0}` : '读不到宿主状态',
                hint: '只统计 dsh-roost 创建并持有的会话（含面板自测那一条），'
                  + '不含你在 DSH 里手动开的会话；下面几格的用量、排队、工具挂载也是同一批会话。',
              }),
              h(Stat, {
                k: '今日 Token', n: today ? tokenText : '—',
                sub: today
                  ? `${today.turns ?? 0} 轮 · 输出 ${fmtNum(today.output)}`
                  : '今日暂无用量',
              }),
              h(Stat, {
                k: '今日花费', n: costText ?? '未定价',
                sub: costText
                  ? [cost7Text, unpricedText].filter(Boolean).join(' · ') || '按峰/谷价分别折算'
                  : '没有能折算的模型',
                hint: '只折算价目表里的模型（内置 DeepSeek，官方价已核；其余标未定价不猜折扣）。'
                  + '价格会过期，以官网为准；要换价目改设置里的 usage.pricing。'
                  + '升级前的历史没分峰/谷档，不计入金额，token 数在「未定价」里如实报。',
              }),
              h(Stat, {
                k: '排队并发', n: q.pending ?? 0,
                sub: `正在跑 ${q.busy ?? 0} 条 · ${q.lanes ?? 0} 车道`,
              }),
              h(Stat, {
                k: '缓存命中', n: cacheHit === null ? '—' : `${cacheHit}%`,
                sub: today
                  ? `读取 ${fmtNum(today.cacheRead)} · 写入 ${fmtNum(today.cacheWrite)}`
                  : '暂无输入用量',
                hint: '命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入），按宿主回报的用量算。',
              }),
              h(Stat, {
                k: '她现在', n: (() => {
                  const v = Number(st?.sheNow?.mood?.valence) || 0
                  return v > 0.4 ? '心情不错' : v < -0.4 ? '有点烦' : '平静'
                })(),
                sub: (() => {
                  const sn = st?.sheNow
                  const total = sn?.journal?.total
                  const persona = sn?.persona?.label || sn?.persona?.id || '默认'
                  return `记忆 ${total ? fmtNum(total) : 0} 条 · 人格 ${persona}`
                })(),
                hint: (() => {
                  const sn = st?.sheNow || {}
                  const last = sn.lastSpeakUpAt ? `上次主动 ${ago(sn.lastSpeakUpAt)}` : '还没主动找过人'
                  const pure = sn.pure?.enabled === false
                    ? '全局记忆关着'
                    : sn.pure?.offCount
                      ? `${sn.pure.offCount} 个会话纯净模式`
                      : '纯净模式没开（全都在记）'
                  return `${last} · ${pure}`
                })(),
              }),
              h(Stat, {
                k: '最近一轮', n: lt && lt.ms != null ? `${lt.ms}ms` : '—',
                sub: turnWord,
                hint: lt
                  ? turnWord
                    + (lt.trace ? ` · 本轮编号 ${lt.trace}` : '')
                    + (lt.seg
                      ? ` · 排队 ${lt.seg.queue ?? '—'}ms / 准备 ${lt.seg.prep ?? '—'}ms / 生成 ${lt.seg.gen ?? '—'}ms`
                      : '')
                  : '',
                tone: lt ? (lt.ok === false ? 'bad' : lt.ok ? 'ok' : null) : null,
              }),
              h(Stat, {
                k: '工具挂载',
                n: !tools || !tools.sessionCount ? '—' : (tools.ok ? '已挂' : '未挂'),
                sub: !tools || !tools.sessionCount
                  ? '等第一条消息挂载'
                  : `${tools.sessionCount} 个会话 · 失败 ${tools.failedCount ?? 0}`,
                tone: tools && tools.sessionCount ? (tools.ok ? 'ok' : 'bad') : null,
              }),
            ),
            h('div', { className: 'ov-panel ov-tipbox', 'data-tip': '按自然日补齐，没数据的天算 0' },
              h('h4', null, '近 7 天用量'),
              h('div', { className: 'ov-cap' }, '每天用掉的 Token 总量 · 只统计我们创建的会话'),
              last7.length
                ? h('div', { className: 'ov-bars' },
                    last7.map((d, i) => {
                      const v = sumDay(d)
                      const max = Math.max(1, ...last7.map(sumDay))
                      return h('div', {
                        key: d?.day || i, className: 'ov-bar ov-tipbox',
                        'data-tip': `${d?.day || ''} · ${fmtNum(v)} tokens · ${d?.turns ?? 0} 轮`,
                        title: `${d?.day || ''} · ${fmtNum(v)} tokens`,
                      },
                        h('b', null, v ? fmtNum(v) : ''),
                        h('i', { style: { height: `${Math.max(2, Math.round(v / max * 62))}px` } }),
                        h('span', null, String(d?.day || '').slice(5)),
                      )
                    }),
                  )
                : h('div', { className: 'ov-empty' }, '读取中…'),
            ),
          ),
          // 第二行：两个环形图
          h('div', { className: 'ov-stats' },
            h('div', { className: 'ov-panel ov-tipbox', 'data-tip': '按输入、缓存、输出拆开，不是 DSH 的上下文占用' },
              h('h4', null, 'Token 构成'),
              h('div', { className: 'ov-cap' },
                '近 7 天 · 悬停看具体数值 · 缓存写入这项上游没回报'),
              donut([
                { k: '未缓存输入', v: last7.reduce((a, d) => a + (Number(d?.uncached) || 0), 0), c: '#3b82f6' },
                { k: '缓存读取', v: last7.reduce((a, d) => a + (Number(d?.cacheRead) || 0), 0), c: '#14b8a6' },
                { k: '缓存写入', v: last7.reduce((a, d) => a + (Number(d?.cacheWrite) || 0), 0), c: '#f59e0b' },
                { k: '模型输出', v: last7.reduce((a, d) => a + (Number(d?.output) || 0), 0), c: '#8b5cf6' },
              ], fmtNum(last7.reduce((a, d) => a + sumDay(d), 0)), '中心是这四项加起来'),
            ),
            h('div', { className: 'ov-panel ov-tipbox', 'data-tip': '最近一轮的排队 / 准备 / 生成耗时' },
              h('h4', null, '耗时拆分'),
              h('div', { className: 'ov-cap' }, '最近一轮 · 排队 / 准备 / 生成'),
              lt?.seg
                ? donut([
                    { k: '排队', v: Number(lt.seg.queue) || 0, c: '#3b82f6' },
                    { k: '准备', v: Number(lt.seg.prep) || 0, c: '#8b5cf6' },
                    { k: '生成', v: Number(lt.seg.gen) || 0, c: '#14b8a6' },
                  ], lt.ms != null ? `${lt.ms}ms` : '—', lt.trace ? `本轮编号 ${lt.trace}` : '')
                : h('div', { className: 'ov-empty' }, '最近一轮还没有耗时明细。'),
            ),
          ),
          // 第三行：四张 280px 卡（对方 .lc-ov-tile）
          h('div', { className: 'ov-tiles' },
            h('div', { className: 'ov-panel ov-tile' },
              h('h4', null, '活跃度'),
              h('div', { className: 'ov-cap' }, '近 8 周每天的用量 · 颜色越深越高'),
              heatDays.length
                ? h('div', { className: 'ov-heat' },
                    heatDays.map((d, i) => {
                      const v = sumDay(d)
                      const max = Math.max(1, ...heatDays.map(sumDay))
                      return h('i', {
                        key: d?.day || i, className: 'ov-tipbox',
                        'data-tip': `${d?.day || ''} · ${fmtNum(v)} tokens`,
                        title: `${d?.day || ''} · ${fmtNum(v)} tokens`,
                        style: heatColor(v, max) ? { background: heatColor(v, max) } : null,
                      })
                    }),
                  )
                : h('div', { className: 'ov-empty' }, '读取中…'),
            ),
            mini('会话构成', '只统计我们创建并持有的会话', [
              ['群会话', String((myChats || []).filter((c) => c.kind === 'group').length)],
              ['私聊', String((myChats || []).filter((c) => c.kind === 'c2c').length)],
              ['合计', String((myChats || []).length)],
            ]),
            mini('用量最高', '近 8 周各会话的用量',
              Object.entries(usage?.chats || {})
                .map(([cid, v]) => [cid, (Number(v?.uncached) || 0) + (Number(v?.cacheRead) || 0)
                  + (Number(v?.cacheWrite) || 0) + (Number(v?.output) || 0)])
                .sort((a, b) => b[1] - a[1]).slice(0, 4)
                .map(([cid, v]) => [String(cid).slice(0, 10), fmtNum(v)])),
            mini('最近更新', '按映射写入时间',
              (myChats || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 4)
                .map((c) => [c.title || String(c.chatId ?? '').slice(0, 10),
                  c.at ? new Date(c.at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '—'])),
          ),
          /**
           * 权限说明不占数字格：七格会在窄面板里单独换行，而这格是文字、
           * 长短和其他格差得多，会把整排撑歪（2026-11-10 面板截图实测）。
           * 能力策略接管后旧权限只是历史值，这里也不拿它冒充当前档位。
           */
          h('div', { className: 'roost-note', style: { marginTop: 8 } },
            capsOn
              ? '权限：策略已接管，档位与工具在「权限」页配置。'
              : toolable.length
                ? `权限：能用本地工具的档位 ${toolable.join(' / ')}（共 ${toolable.length} 档）。`
                : '权限：没有档位开放全部工具。'),
        ),

        /** 03 会话筛选：对应 dsh-context 洞察页下半部分的搜索 / 范围 / 排序 / 卡片 / 分页。
            只在我们创建并持有的 QQ↔DSH 会话里筛，用量也只读我们自己的账本。
            卡片尺寸与读法照对方 .lc-ov-session，指标换成四类 Token 与 DSH 会话号。 */
        h(Sec, { n: '03', title: '会话',
          right: h('span', { className: 'ov-count' }, String(filteredChats.length)) },
          /**
           * 2.6：整张表加一层折叠。
           * 不许压成「一行摘要」——搜索、时间范围、排序、分类、分页一个不少；
           * details 的 children 常驻 DOM，收起时筛选条件和页码都还在，
           * 展开回来还是刚才那一页。Sec 右上那个「−」是收起整节，两码事。
           */
          h('details', { open: true },
            h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer', marginBottom: 8 } },
              '折叠 / 展开整张表（搜索、时间范围、排序、分类、分页都在里面，收起后条件不丢）'),
          h('div', { className: 'ov-filter' },
            h('input', {
              className: 'roost-input ov-search', type: 'search',
              placeholder: '搜名称、QQ 会话号或 DSH 会话号',
              value: qText,
              onChange: (e) => { setQText(e.target.value); setQPage(0) },
            }),
            h('select', {
              className: 'roost-input ov-cover', value: qRange,
              onChange: (e) => { setQRange(e.target.value); setQPage(0) },
            },
              h('option', { value: 'all' }, '全部时间'),
              h('option', { value: 'today' }, '近 24 小时'),
              h('option', { value: '7d' }, '近 7 天'),
              h('option', { value: '30d' }, '近 30 天'),
            ),
            h('div', { className: 'ov-gran', role: 'group' },
              [['recent', '最近更新'], ['tokens', 'Token 用量'], ['turns', '轮次']]
                .map(([v, label]) => h('button', {
                  key: v, type: 'button', 'data-on': qSort === v ? '1' : '0',
                  onClick: () => { setQSort(v); setQPage(0) },
                }, label)),
            ),
          ),
          h('div', { className: 'ov-groups' },
            chip('全部', 'all', qKind, setQKind, (myChats || []).length),
            chip('群', 'group', qKind, setQKind,
              (myChats || []).filter((c) => c.kind === 'group').length),
            chip('私聊', 'c2c', qKind, setQKind,
              (myChats || []).filter((c) => c.kind === 'c2c').length),
          ),
          h('div', { className: 'ov-sessions' },
            pageChats.length
              ? pageChats.map((c, i) => {
                  const total = chatToken(c.chatId)
                  const hit = chatHit(c.chatId)
                  const at = Number(c.at) || 0
                  const delta = Date.now() - at
                  /** at 是映射写入时间，不是最后一条消息时间：文案一律按「更新」说。
                      「今日」用日历日判定，别把昨天 23 点算成今天。 */
                  const todayCard = at > 0 && delta >= 0 && dstr(at) === dstr(Date.now())
                  const fresh = at > 0 && delta >= 0 && delta < 300000
                  return h('div', {
                    key: c.chatId || i, className: 'ov-card ov-tipbox',
                    role: 'button', tabIndex: 0,
                    'data-today': todayCard ? '1' : '0',
                    'data-tip': `${c.title || '未命名'} · ${c.kind === 'group' ? '群' : '私聊'}`
                      + ` · QQ 会话 ${String(c.chatId ?? '')} · DSH 会话 ${String(c.sessionId ?? '—')}`,
                    onClick: () => onGo('chats'),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onGo('chats')
                      }
                    },
                  },
                    h('div', { className: 'ovc-head' },
                      fresh ? h('i', { className: 'ovc-dot', title: '5 分钟内更新过映射' }) : null,
                      h('span', { className: 'ovc-title', title: c.title || '' },
                        (c.kind === 'group' ? 'QQ · 群 ' : 'QQ · 私聊 ')
                          + (c.title || String(c.chatId ?? '').slice(0, 12))),
                      todayCard ? h('span', { className: 'ovc-tag', title: '今天更新过映射' }, '今日') : null,
                      h('span', { className: 'ovc-times' },
                        h('span', null, relTime(c.at)),
                        h('span', null, at ? dstr(at) : '—')),
                    ),
                    h('div', { className: 'ovc-crumb',
                      title: `预设 ${c.preset || '默认'} · DSH 会话 ${String(c.sessionId ?? '—')}` },
                      h('span', null, c.kind === 'group' ? '群会话' : '私聊'),
                      h('span', { className: 'ovc-proj' },
                        c.preset || (c.sessionId ? String(c.sessionId).slice(0, 8) : '未命名')),
                    ),
                    total > 0
                      ? h('div', { className: 'ovc-body' },
                          /** 圆环中心就是四类合计，不再塞「占近 8 周 x%」：
                              我们没有上下文窗口这种分母，那行既没口径又会溢出 64px 环。 */
                          ring(chatParts(c.chatId), fmtNum(total)),
                          h('div', { className: 'ovc-mini' },
                            h('div', null,
                              h('span', { className: 'l' }, '轮次'),
                              h('span', { className: 'v' }, `${chatTurns(c.chatId)} 轮`)),
                            h('div', null,
                              h('span', { className: 'l' }, '模型输出'),
                              h('span', { className: 'v' },
                                fmtNum(Number(chatRow(c.chatId)?.output) || 0))),
                            h('div', null,
                              h('span', { className: 'l' }, '缓存命中'),
                              h('span', { className: 'v' }, hit === null ? '—' : `${hit}%`)),
                          ),
                        )
                      : h('div', { className: 'ov-empty' },
                          usage === null ? '用量暂时读不到' : '还没有用量记录'),
                    h('div', { className: 'ovc-preview',
                      title: `QQ 会话 ${String(c.chatId ?? '')} · DSH 会话 ${String(c.sessionId ?? '—')}` },
                      h('span', { className: 'l' }, 'DSH 会话'),
                      h('span', { className: 'v' },
                        c.sessionId ? String(c.sessionId).slice(0, 12) : '—')),
                  )
                })
              : h('div', { className: 'ov-empty' }, myChats === null ? '读取中…' : '没有匹配的会话。'),
          ),
          pageCount > 1
            ? h('div', { className: 'ov-pager' },
                h('button', {
                  type: 'button', disabled: page <= 0,
                  onClick: () => setQPage(page - 1),
                }, '‹'),
                h('span', { className: 'roost-note', style: { margin: 0 } }, `${page + 1} / ${pageCount}`),
                h('button', {
                  type: 'button', disabled: page >= pageCount - 1,
                  onClick: () => setQPage(page + 1),
                }, '›'),
              )
            : null,
          ),
        ),

        h(Sec, { n: '04', title: '快捷',
          right: h('span', { className: 'roost-note', style: { margin: 0 } }, '自测不经过 QQ') },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'roost-primary', disabled: busy, onClick: selftest },
              busy ? '跑着…' : '跑一次自测'),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: async () => {
                // 现读一次，别用可能过期的 setupSt（Roost 刚起来时它是旧的）
                const r = await get('/setup/webui')
                const url = r.ok !== false ? r.url : ''
                if (url || s.webui) window.open(url || s.webui, '_blank', 'noopener')
                else toast('还没装好 Roost，没有面板可开')
              },
            }, '打开 Roost 面板 ↗'),
          ),
          h('div', { className: 'roost-note' },
            '自测直接跑一轮 DSH 对话，验「会话建得起来、AI 回得来」；QQ 那一段不在里面。'
            + '上面「01 接入进度」里也有一颗「打开 Roost 面板 ↗」，两颗开的是同一个面板，这里是顺手的快捷入口。'),
        ),

        h(Sec, { n: '05', title: '直连状态' },
          h('div', { className: 'roost-list' },
            [
              ['事件流 seq', pv.cell || '—', '停在同一个数字就是没在进消息'],
              ['Roost 面板', s.port || '—', 'Roost 自己的面板端口，和这里不是一回事'],
              ['通道', 'roost（框架外接协议）', '消息不经过任何中间层'],
            ].map(([k, v, why]) =>
              h('div', { key: k, className: 'roost-item' },
                h('span', { className: 't' }, k, h('span', { className: 'd' }, ' ' + why)),
                /** URL 可能很长：允许收缩并断行，别把左边的说明挤成一个字一行 */
                h('span', { className: 'roost-mono',
                  style: { flex: '0 1 auto', minWidth: 0, overflowWrap: 'anywhere' } }, String(v)),
              ),
            ),
          ),
          h('div', {
            className: 'roost-note',
            style: pv.kind === 'ok' ? { color: 'var(--ok)' } : pv.kind === 'bad' ? { color: 'var(--bad)' } : null,
          },
            pv.text,
            /** 跳过向导的人要一直看得见这条：不重接就是哑的 */
            wizardPending
              ? h('button', {
                  type: 'button', className: 'roost-btn',
                  style: { marginLeft: 8, flex: '0 0 auto' },
                  disabled: wizardBusy, onClick: reopenWizard,
                }, wizardBusy ? '打开中…' : '重新走接入向导')
              : null,
          ),
        ),

        h(Sec, { n: '06', title: '最近动态' },
          logs === null
            ? h('div', { className: 'roost-empty' }, '读取中…')
            : logs.length === 0
              ? h('div', { className: 'roost-empty' }, '还没有动静。群里说句话，或者跑一次自测。')
              : h('div', { className: 'roost-list' },
                  logs.slice(-6).reverse().map((e, i) =>
                    h('div', { key: i, className: 'roost-item' },
                      h('span', { className: 'roost-mono', style: { flex: '0 0 auto', opacity: 0.7 } }, e.time),
                      h('span', {
                        style: {
                          flex: '0 0 5px', height: 5, borderRadius: 3, marginTop: 7,
                          background: e.level === 'error' ? 'var(--bad)' : e.level === 'warn' ? 'var(--warn)' : 'var(--ok)',
                        },
                      }),
                      h('span', { className: 't', style: { opacity: e.level === 'error' ? 1 : 0.86 } }, e.text),
                    ),
                  ),
                ),
        ),
      )
    }

    /* ---------------- 接入 ---------------- */

    /**
     * 组件版本块（框架版本）。
     *
     * 抽成独立组件的原因：放在 SetupTab 里时它依赖内部 state，而假 React 不跑
     * effect，永远只能测到「读着…」——第一版就因此把 `d.framework`（未定义）
     * 写进了渲染分支却没人发现。给 props 就能直接渲染断言。
     */
    function DepsBlock({ info, busy, onCheck }) {
      const row = (k, label) => {
        const v = info?.[k] || {}
        return h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 } },
          h('span', { style: { minWidth: 108 } }, label),
          h('span', { className: 'roost-code' }, v.installed ? 'v' + v.installed : '没装'),
          v.latest ? h('span', { className: 'roost-note', style: { margin: 0 } }, '→ v' + v.latest) : null,
          v.hasUpdate
            ? h(Pill, { tone: 'warn' }, '有更新')
            : v.latest
              ? h('span', { className: 'roost-note', style: { margin: 0 } }, '已是最新')
              : h('span', { className: 'roost-note', style: { margin: 0 } }, '查不到最新版'),
        )
      }

      return h(Sec, {
        title: '组件版本',
        right: h('button', {
          type: 'button', className: 'roost-btn', disabled: busy,
          onClick: onCheck,
        }, busy ? '查着…' : '重新检查'),
      },
        !info
          ? h('div', { className: 'roost-empty' }, '读着…')
          : info.error
            ? h('div', { className: 'roost-note' }, '查不到：' + info.error)
            : h('div', null,
                row('framework', 'Roost 框架'),
                info.framework?.hasUpdate
                  ? h('div', { className: 'roost-note' },
                      '框架有新版：下载 tar 包解压覆盖原目录（data/ 里的机器人配置和记忆不受影响），然后重启 Roost。')
                  : null,
                info.framework?.error
                  ? h('div', { className: 'roost-note' },
                      '最新版查不到多半是网络或 GitHub 抖动，不影响使用；点「重新检查」再试一次。')
                  : null,
              ),
      )
    }

    function SetupTab({ st, reload, toast, busy, run, reg, onSaved, saveCfg }) {
      const [qrSvg, setQrSvg] = useState('')
      const [qrTip, setQrTip] = useState('')
      const [appId, setAppId] = useState('')
      const [secret, setSecret] = useState('')
      /**
       * 手动填写的入口。
       *
       * 之前这条只留了一行灰字「在『设置』里切换接入方式」——
       * 用户在一个四步向导里被指去别的页面找开关，等于没有。
       * 现在就地展开，不用离开这一步。
       */
      const [showManual, setShowManual] = useState(false)
      const [pathOpen, setPathOpen] = useState(false)
      const [dir, setDir] = useState('')
      const [cfgMsg, setCfgMsg] = useState('')
      const [work, setWork] = useState('')
      const qrTimer = useRef(null)
      const mode = reg?.current || 'qr'
      /** 框架版本对照（/update/deps） */
      const [depsInfo, setDepsInfo] = useState(null)
      const [depsBusy, setDepsBusy] = useState(false)
      const loadDeps = async (force) => {
        setDepsBusy(true)
        try {
          const r = await get('/update/deps' + (force ? '?force=1' : ''))
          setDepsInfo(r && r.ok !== false ? r : { error: r?.message || '查不到' })
        } finally {
          setDepsBusy(false)
        }
      }
      /** 进页查一次（服务端有半小时缓存，不会每点一次都打 GitHub） */
      useEffect(() => { loadDeps(false) }, [])
      const s = st || {}
      const locked = Boolean(work) || Boolean(busy)

      /**
       * 一键直连（外接协议）。
       *
       * 状态、开、关、试全部由后端 `/roost/pair*` 处理——前端只负责显示和点。
       * **端口和密钥都不让用户填**：密钥由插件生成并存进本插件配置（面板只显示
       * 已设置/未设置），端口交给 Roost 按 botId 分配再读回来。手填这两项是
       * 「配错了也不报错、只是消息进不来」的主要来源。
       */
      const [pair, setPair] = useState(null)
      const [pairBusy, setPairBusy] = useState(false)
      const [pairMsg, setPairMsg] = useState('')
      /**
       * 可选依赖 `ws` 与事件通道。
       *
       * `ws` 只影响「事件流走 WS 还是 SSE」，RPC 和发文件恒走 HTTP。
       * 优先复用框架已装的那份；没装就走 SSE，功能一点不少。
       */
      const [wsInfo, setWsInfo] = useState(null)
      const [wsBusy, setWsBusy] = useState(false)
      /**
       * 框架能力表：连上之后框架有多少方法、其中几个是插件新工具。
       * 只在点按钮时拉（不进 useEffect），免得面板每开一次就多一次请求。
       */
      const [capsInfo, setCapsInfo] = useState(null)
      const loadCaps = async () => {
        try {
          const r = await get('/roost/capabilities')
          setCapsInfo(r && r.ok !== false ? r : null)
          toast(`框架能力：${r?.count ?? 0} 个方法，插件工具 ${r?.pluginTools?.length ?? 0} 个${r?.error ? `（${r.error}）` : ''}`)
        } catch (e) { toast(`读能力表失败：${e?.message ?? e}`) }
      }
      const loadWsInfo = async () => {
        try {
          const r = await get('/roost/ws')
          setWsInfo(r && r.ok !== false ? r : null)
        } catch { setWsInfo(null) }
      }
      const doInstallWs = async () => {
        setWsBusy(true)
        try {
          const r = await post('/roost/ws/install', {})
          toast(r?.ok === false ? (r.message || '装不上') : (r.message || 'ws 已装好'))
          await loadWsInfo()
          await reload()
        } finally { setWsBusy(false) }
      }
      const setTransport = async (t) => {
        setWsBusy(true)
        try {
          const r = await post('/config?mode=patch', { roostHost: { transport: t } })
          if (r?.ok === false) toast(r.message || '改不了')
          else toast(`事件通道已设为 ${t}`)
          await loadWsInfo()
        } finally { setWsBusy(false) }
      }
      const loadPair = async () => {
        try {
          const r = await get('/roost/pair')
          setPair(r && r.ok !== false ? r : null)
        } catch {
          setPair(null)
        }
      }
      /** 步骤 2 的状态变了（Roost 起停）就要重查，否则会一直显示「没在跑」 */
      useEffect(() => { loadPair() }, [s.running])
      useEffect(() => { loadWsInfo() }, [])

      /**
       * @param {{rotate?:boolean}} [o]
       *   rotate = 换一个新密钥（旧的立刻失效）。按钮上要走二次确认——
       *   换完正在连的其它客户端会掉线，误点一次就得重新配。
       */
      const doPair = async ({ rotate = false } = {}) => {
        setPairBusy(true)
        setPairMsg('')
        try {
          const r = await post('/roost/pair/enable', { rotate })
          if (r?.ok === false) {
            setPairMsg(`✗ ${r.message || '没配成'}`)
          } else if (rotate) {
            setPairMsg(`✓ 已换新密钥（旧的立刻失效），已保存并重连 ${r.url}`)
          } else {
            setPairMsg(`✓ 已连上 ${r.url}（端口 ${r.port} 由 Roost 分配，密钥已由插件生成并保存）`)
          }
          toast(r?.ok === false ? (r.message || '没配成') : rotate ? '密钥已换新' : '已直连')
          await loadPair()
          await reload()
        } catch (e) {
          setPairMsg(`✗ ${e?.message ?? e}`)
        } finally {
          setPairBusy(false)
        }
      }

      const doPairTest = async () => {
        setPairBusy(true)
        try {
          const r = await post('/roost/pair/test', {})
          setPairMsg(r?.ok === false ? `✗ ${r.message || '不通'}` : `✓ 通，往返 ${r.ms}ms`)
        } catch (e) {
          setPairMsg(`✗ ${e?.message ?? e}`)
        } finally {
          setPairBusy(false)
        }
      }

      /**
       * 关掉协议。**地址和密钥保留**：下次再开不用重新配对
       *（token 还是原来那个，已经在连的客户端不会被踢下线）。
       */
      const doPairOff = async () => {
        setPairBusy(true)
        try {
          const r = await post('/roost/pair/disable', {})
          setPairMsg(r?.ok === false
            ? `✗ ${r.message || '没关掉'}`
            : `✓ 已关掉${r.warning ? `（${r.warning}）` : ''}，消息暂时收不到`)
          await loadPair()
          await reload()
        } catch (e) {
          setPairMsg(`✗ ${e?.message ?? e}`)
        } finally {
          setPairBusy(false)
        }
      }

      const pairReady = pair?.step === 'ready'
      const pairState = pairReady ? 'done' : s.running ? 'current' : 'todo'

      const stopQr = useCallback(() => {
        if (qrTimer.current) {
          clearInterval(qrTimer.current)
          qrTimer.current = null
        }
      }, [])

      const pollQr = useCallback(
        async (taskId) => {
          const r = await post('/setup/qr/poll', { taskId })
          if (r.ok === false) {
            stopQr()
            setQrTip(r.message || '扫码失败了，重试一次')
            return
          }
          if (r.status === 'pending') return
          stopQr()
          if (r.status === 'done') {
            setAppId(r.appId || '')
            setSecret(r.appSecret || '')
            setQrSvg('')
            setQrTip(`✓ 已拿到 AppID ${r.appId || ''}，点下面「保存」就写进去`)
            await reload()
            onSaved?.()
          } else {
            setQrSvg('')
            setQrTip(r.message || '二维码过期了，重新生成一个')
          }
        },
        [stopQr, reload, onSaved],
      )

      const startQr = useCallback(async () => {
        setQrTip('正在生成二维码…')
        setQrSvg('')
        const r = await post('/setup/qr/start', {})
        if (r.ok === false) {
          setQrTip(r.message || '生成失败')
          return
        }
        setQrSvg(r.qrSvg || '')
        setQrTip('用手机 QQ 扫码，确认后自动填好')
        stopQr()
        qrTimer.current = setInterval(() => pollQr(r.taskId), 2000)
      }, [pollQr, stopQr])

      // 切走页面就停轮询，别在后台一直打
      useEffect(() => () => stopQr(), [stopQr])

      const copy = (t) => {
        try {
          navigator.clipboard?.writeText(t)
          toast('已复制')
        } catch {
          toast('复制失败，手动选一下吧')
        }
      }

      /** 回车即提交——表单里没这个会让人以为按钮才有用 */
      const enter = (fn) => (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        fn()
      }

      const saveBot = () => {
        if (!appId || !secret) return toast('AppID 和 AppSecret 都要填')
        step('写入凭证', '/setup/bot', { name: 'main', appId, appSecret: secret })
      }

      /**
       * 一步一个请求，失败就停。
       *
       * 「一键」不该在第一步失败之后还继续往下点——那只会刷出一串
       * 互相矛盾的报错，用户反而不知道哪一步是真问题。
       */
      const step = async (label, path, body) => {
        setWork(label)
        const r = await post(path, body)
        setWork('')
        toast(r.ok === false ? r.message || label + '失败' : r.message || label + '完成')
        await reload()
        onSaved?.()
        return r.ok !== false
      }

      const oneKey = async () => {
        const s0 = await get('/setup')
        if (s0.ok === false) return toast(s0.message || '读不到状态')
        if (!s0.installed && !(await step('安装', '/setup/install', dir.trim() ? { dir: dir.trim() } : {}))) return
        if (!s0.hasCreds) {
          if (!appId || !secret) {
            toast('还没有机器人：先启动 Roost，再在第 3 步扫码或手动填 AppID / AppSecret')
            return
          }
          if (!(await step('写入凭证', '/setup/bot', { name: 'main', appId, appSecret: secret }))) return
        }
        if (!s0.running && !(await step('启动', '/setup/start'))) return
        if (!(await step('一键直连', '/roost/pair/enable', {}))) return
        await loadPair()
        toast('直连已配好 —— 去群里说一句话试试')
      }

      /**
       * 六步的状态全部由 `/setup` 的真实字段推出来。
       *
       * 原来概览那套「4 步 / 0 完成」是读一个后端根本不返回的 `steps`，
       * 所以永远显示 0 —— 这里不许再猜：每一步都必须有一份可核对的判据。
       */
      /**
       * 「到底配好了没有」要按 **AppID 在不在** 判断，不能按「有没有 bot 记录」。
       *
       * `s.hasBot` 只要有 bot 条目就是 true——而全新装好的 Roost 本来就带一个
       * 「默认机器人（无 AppID）」。于是这一步显示「已配置」+ 绿勾，
       * 实际上什么都没填，后面启动才报缺 AppID。
       */
      const hasCreds = s.hasCreds ?? (s.bots || []).some((b) => String(b?.appId || '').trim())

      const mark = {
        install: s.installed ? 'done' : 'current',
        /**
         * 启动排在扫码前面（扫码要用 Roost 的接口），所以它只依赖「装好了」。
         */
        start: s.running ? 'done' : s.installed ? 'current' : 'todo',
        bot: hasCreds ? 'done' : s.running ? 'current' : 'todo',
        /**
         * 主人在 Roost 面板里设了没有。
         *
         * 这一步**只能在 Roost 面板里做**——面板里有「主人与群组」那块，
         * 能加能删。dsh-roost 这边只读状态，不代劳：
         * 主人是「谁能指挥这台机器」的根，不该由一个插件代写。
         *
         * Roost 都没装的时候别标 current——主人根本无从谈起，
         * 让它跟着前头一起待着就行。
         */
        owner: s.ownersConfigured ? 'done' : s.installed ? 'current' : 'todo',
      }

      /**
       * 「换账号」的提示。
       *
       * 这个页面只负责把**第一个**机器人建起来（扫码 / 填一次凭证），
       * 改已有账号得去 Roost 面板的「配置」页签——那边才有 AppID / AppSecret 的编辑框。
       * 不写这句的话，用户会在这里反复扫码，扫出来还是同一个机器人，以为没生效。
       */
      const switchHint = () =>
        h('div', { className: 'roost-note', style: { marginTop: 8, width: '100%' } },
          '要换账号（换 AppID / AppSecret）：去 Roost 面板的「配置」里改，或者删掉旧机器人再回来扫码——这里只负责建第一个。',
          s.running && s.webui
            ? h('button', {
                type: 'button', className: 'roost-link', style: { marginLeft: 6 },
                onClick: () => window.open(`${s.webui}#config`, '_blank', 'noopener'),
              }, '打开 Roost 面板')
            : null,
        )

      return h('div', null,

        h('div', { className: 'roost-banner', style: pairReady ? { borderColor: 'color-mix(in srgb, var(--ok) 40%, transparent)' } : null },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('b', null, pairReady ? '直连已就绪' : '还没接好'),
              h('i', { style: { display: 'block' } }, pairReady
                ? '群里说一句话试试。没反应看下面的「常见卡点」。'
                : '点右边「一键就绪」：装 Roost、写凭证、启动、一键直连会自动做完。'),
            ),
            h('button', {
              type: 'button', className: 'roost-primary', disabled: locked,
              onClick: oneKey,
            }, work ? work + '…' : pairReady ? '重新检查一遍' : '一键就绪'),
          ),
        ),

        h('div', { style: { padding: '2px 2px 0' } },

          h(Step, {
            n: 1, state: mark.install, title: '装 Roost',
            desc: s.installed
              ? `已装 v${s.version || '?'} · ${s.dirHow || ''}${s.dirOk ? '' : '（但目录里没有 src/main.js）'}`
              : '下载解压就行——Roost 零依赖，不用 npm install',
          },
            h('button', { type: 'button', className: 'roost-btn', onClick: () => setPathOpen((v) => !v) },
              pathOpen ? '收起' : s.installed ? '更改路径' : '改路径'),
            s.installed
              ? null
              : h('button', {
                  type: 'button', className: 'roost-btn', disabled: locked,
                  onClick: async () => {
                    // 装了自定义路径就先落盘再下载，否则 install() 还按旧 dirOf() 装到默认位置
                    if (dir.trim() && dir.trim() !== s.dir && !(await step('绑定目录', '/setup/dir', { dir: dir.trim() }))) return
                    step('安装', '/setup/install')
                  },
                }, '安装'),
          ),
            pathOpen
              ? h('div', { style: { marginTop: -6, marginBottom: 16, paddingLeft: 40 } },
                  h('div', { className: 'roost-note', style: { marginBottom: 6 } },
                    s.installed
                      ? '换到别的目录（里面要有 src/main.js）。改完要重启 Roost 才生效'
                      : '装到哪。留空就用默认（数据目录下的 roost）'),
                  h('div', { style: { display: 'flex', gap: 6 } },
                    h('input', {
                      className: 'roost-input', placeholder: s.dir || 'D:\\bots\\qq-bot-roost',
                      value: dir, onChange: (e) => setDir(e.target.value), style: { flex: 1 },
                      onKeyDown: (e) => {
                        if (e.key === 'Enter' && dir.trim()) step(s.installed ? '更改' : '绑定', '/setup/dir', { dir: dir.trim() })
                        if (e.key === 'Escape') setPathOpen(false)
                      },
                    }),
                    h('button', {
                      type: 'button', className: 'roost-btn', disabled: !dir.trim() || locked,
                      onClick: () => step(s.installed ? '更改' : '绑定', '/setup/dir', { dir: dir.trim() }),
                    }, s.installed ? '更改' : '绑定'),
                  ),
                  s.dir ? h('div', { style: { marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' } },
                    h('span', { className: 'roost-mono' }, s.dir),
                    h('button', { type: 'button', className: 'roost-link', onClick: () => copy(s.dir) }, '复制'),
                  ) : null,
                )
              : null,

          /**
           * **先启动，再扫码**——顺序不能反。
           *
           * 扫码是 Roost 那边的接口（`/qr/start`），Roost 没跑就没有接口可调。
           * 之前这一步排在扫码后面，还把「启动」按钮绑成 `!s.hasBot`，
           * 于是死锁：想扫码得先启动，想启动得先有 AppID。
           *
           * 后端 `start()` 其实只要求框架装好，不要求配了机器人
           * （没配就是一个没有 bot 的空面板，正好用来扫码）。
           */
          h(Step, {
            n: 2, state: mark.start, title: '启动 Roost',
            desc: s.running
              ? `在跑，面板 ${s.webui || ':' + (s.port || '')}`
              : `启动后它的面板在本机 ${s.webui || ':' + (s.port || '')}`,
          },
            s.running
              ? h('button', { type: 'button', className: 'roost-btn', onClick: () => window.open(s.webui, '_blank', 'noopener') }, '打开面板看启动状态')
              : h('button', {
                  type: 'button', className: 'roost-btn', disabled: locked,
                  onClick: () => step('启动', '/setup/start'),
                }, '启动'),
            s.running
              ? h('button', { type: 'button', className: 'roost-btn', disabled: locked, onClick: () => step('停止', '/setup/stop') }, '停止')
              : null,
          ),

          h(Step, {
            n: 3, state: mark.bot, title: '扫码 / 填 AppID、AppSecret',
            desc: hasCreds ? '已配置' : '推荐扫码；扫码用不了就在下面手动填',
          }),
            hasCreds
              ? h('div', { style: { marginTop: -6, marginBottom: 16, paddingLeft: 40, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('div', { className: 'roost-mono' },
                    (s.bots || []).map((b) => `${b.name || b.id}（${b.appId || '无 AppID'}）`).join('、')),
                  h('button', { type: 'button', className: 'roost-link', onClick: () => copy((s.bots || []).map((b) => b.appId).filter(Boolean).join(' ')) }, '复制 AppID'),
                  switchHint(),
                )
              : mode === 'manual'
                ? h('div', { style: { marginTop: -6, marginBottom: 16, paddingLeft: 40, maxWidth: 470 } },
                    h('input', { className: 'roost-input', placeholder: 'AppID', value: appId, onChange: (e) => setAppId(e.target.value), onKeyDown: enter(saveBot), style: { marginBottom: 8 } }),
                    h('input', { className: 'roost-input', placeholder: 'AppSecret', type: 'password', value: secret, onChange: (e) => setSecret(e.target.value), onKeyDown: enter(saveBot), style: { marginBottom: 8 } }),
                    h('button', {
                      type: 'button', className: 'roost-primary', disabled: !appId || !secret || locked,
                      onClick: saveBot,
                    }, '保存凭证'),
                    switchHint(),
                  )
                : h('div', { style: { marginTop: 10, maxWidth: 430 } },
                    h('button', { type: 'button', className: 'roost-primary', disabled: locked, onClick: startQr, style: { width: '100%' } },
                      qrSvg ? '重新生成' : '扫码一键创建'),
                    h('div', { className: 'roost-note', style: { marginTop: 6 } },
                      s.running
                        ? '手机 QQ 扫一下，AppID / AppSecret 自动填好'
                        : '先完成上一步「启动 Roost」——扫码用的是它的接口'),
                    qrSvg
                      ? h('div', {
                          style: { background: '#fff', padding: 8, borderRadius: 10, lineHeight: 0, margin: '8px 0' },
                          dangerouslySetInnerHTML: { __html: safeSvg(qrSvg) },
                        })
                      : null,
                    qrTip ? h('div', { className: 'roost-note' }, qrTip) : null,
                    switchHint(),
                    (appId || secret || showManual)
                      ? h('div', { style: { marginTop: 10 } },
                          h('input', { className: 'roost-input', placeholder: 'AppID', value: appId, onChange: (e) => setAppId(e.target.value), style: { marginBottom: 8 } }),
                          h('input', { className: 'roost-input', placeholder: 'AppSecret', type: 'password', value: secret, onChange: (e) => setSecret(e.target.value), style: { marginBottom: 8 } }),
                          h('button', {
                            type: 'button', className: 'roost-btn', disabled: !appId || !secret || locked,
                            onClick: saveBot,
                          }, '保存'),
                        )
                      : h('div', { style: { marginTop: 10 } },
                          h('button', {
                            type: 'button', className: 'roost-link',
                            onClick: () => setShowManual(true),
                          }, '扫码用不了？手动填 AppID / AppSecret'),
                        ),
                  ),

          /**
           * 一键直连：**推荐路径**。
           *
           * dsh-roost 直接连 Roost 的外接协议，
           * 中间少一层，也就少一处会「静默断链」的地方。
           *
           * 端口和密钥都不给用户填：密钥自动生成后存进本插件配置（面板只显示
           * 已设置/未设置），端口由 Roost 按 botId 分配再读回来。
           */
          h(Step, {
            n: 4,
            state: pairState,
            title: '一键直连（推荐）',
            desc: pair?.text || (s.running ? '点下面按钮，自动开协议、生成密钥、配对' : '先把 Roost 启动起来'),
          },
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                className: pairReady ? 'roost-btn' : 'roost-primary',
                disabled: locked || pairBusy || !s.running,
                onClick: () => doPair(),
              }, pairBusy ? '配着…' : pairReady ? '重新配对' : '一键直连'),
              pairReady
                ? h(ConfirmLink, {
                    label: '重置密钥',
                    confirmLabel: '确认换新？旧的会失效',
                    disabled: locked || pairBusy,
                    onConfirm: () => doPair({ rotate: true }),
                  })
                : null,
              pairReady
                ? h('button', {
                    type: 'button', className: 'roost-btn', disabled: locked || pairBusy,
                    onClick: doPairTest,
                  }, '测一下')
                : null,
              pairReady
                ? h('button', {
                    type: 'button', className: 'roost-btn', disabled: locked || pairBusy,
                    onClick: doPairOff,
                  }, '关掉直连')
                : null,
            ),
            h('div', { className: 'roost-note', style: { marginTop: 8, width: '100%' } },
              '端口和密钥都由插件自动生成并保管：密钥写进本插件配置，面板上只显示「已设置」'
              + '（要换就在设置页点重置），端口交给 Roost 按机器人分配后读回来。两者都不用你手填。'),
            pairMsg
              ? h('div', {
                  className: 'roost-mono',
                  style: {
                    marginTop: 6,
                    color: pairMsg.startsWith('✗') ? 'var(--bad)' : pairMsg.startsWith('✓') ? 'var(--ok)' : 'inherit',
                  },
                }, pairMsg)
              : null,
            /** 事件通道：WS 更快，SSE 零依赖；RPC 和文件传输恒走 HTTP */
            h('div', { style: { marginTop: 12, width: '100%' } },
              h('div', { className: 'roost-note', style: { fontWeight: 600, marginBottom: 6 } }, '事件通道'),
              /**
               * 一行只放**状态**（不可点），另一行放**操作**（按钮）。
               * 混在一排时状态和按钮长得一样，用户不知道哪个能点。
               */
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
                (() => {
                  const st = wsInfo?.roost || {}
                  return h('div', { className: 'roost-pill' + (st.usable ? ' ok' : '') },
                    st.usable
                      ? `WS 可用（框架已装${st.version ? ` v${st.version}` : ''}）`
                      : 'WS 不可用，事件走 SSE（功能一样）')
                })(),
                h('div', { className: 'roost-pill' + (wsInfo?.active === 'ws' ? ' ok' : '') },
                  `当前走 ${wsInfo?.active === 'ws' ? 'WS' : 'SSE'}`),
              ),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } },
                h('button', {
                  type: 'button', className: 'roost-btn', disabled: wsBusy, onClick: loadWsInfo,
                }, '刷新状态'),
                wsInfo && !wsInfo.roost?.usable
                  ? h('button', {
                      type: 'button', className: 'roost-btn', disabled: wsBusy, onClick: doInstallWs,
                    }, wsBusy ? '装着…' : '给框架装 ws')
                  : null,
              ),
              /** 能力协商：框架升级/插件启停会让方法表变化，面板上要能当场重拉 */
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' } },
                h('span', { className: 'roost-note', style: { margin: 0, fontWeight: 600 } }, '框架能力'),
                h('div', { className: 'roost-pill' + (capsInfo?.count ? ' ok' : '') },
                  capsInfo ? `${capsInfo.count} 个方法 · ${capsInfo.pluginTools?.length ?? 0} 个插件工具` : '未读取'),
                h('button', { type: 'button', className: 'roost-btn', onClick: loadCaps }, '刷新能力表'),
                capsInfo?.pluginTools?.length
                  ? h('span', { className: 'roost-note', style: { margin: 0 } },
                      capsInfo.pluginTools.slice(0, 4).map((x) => x.name.replace(/^tool\./, '')).join('、'))
                  : null,
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' } },
                h('span', { className: 'roost-note', style: { margin: 0 } }, '启动 DSH 时自动启动 Roost'),
                h('span', { className: 'roost-pill' + (s.roostAutoStart ? ' ok' : '') },
                  s.roostAutoStart ? '已开启' : '已关闭'),
                h('button', {
                  type: 'button', className: 'roost-btn', disabled: wsBusy,
                  onClick: async () => {
                    setWsBusy(true)
                    try {
                      const r = await post('/config?mode=patch', { roostHost: { autoStart: !s.roostAutoStart } })
                      if (r?.ok === false) toast(r.message || '改不了')
                      else toast(s.roostAutoStart ? '已关闭自动启动' : '已开启：下次启动 DSH 会自动拉起 Roost')
                      await reload()
                    } finally { setWsBusy(false) }
                  },
                }, s.roostAutoStart ? '关掉' : '开启'),
              ),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' } },
                h('span', { className: 'roost-note', style: { margin: 0 } }, '用哪条（当前生效的那条会打勾）：'),
                ...[['auto', '自动（有 ws 用 ws）'], ['sse', '只用 SSE'], ['ws', '只用 WS']].map(([v, t]) =>
                  h('button', {
                    key: v, type: 'button',
                    /** `as-btn` 才有「可点」的视觉；`on` 给当前生效的打勾高亮 */
                    className: 'roost-pill as-btn' + ((wsInfo?.transport || 'auto') === v ? ' on' : ''),
                    disabled: wsBusy,
                    onClick: () => setTransport(v),
                  }, t)),
              ),
              h('div', { className: 'roost-note', style: { marginTop: 6 } },
                'ws 装在 Roost 框架那边（框架自己的 /ws 也要用），这边直接复用，不重复安装。'
                + 'WS 只影响事件流；RPC 和大文件上传恒走 HTTP——发文件传的是本机路径，'
                + '由框架自己读盘分片上传，字节不经过这条连接。'),
            ),
          ),

          /** 第 5 步：直连配好之后，剩下两件要在群主自己的手机 QQ 里做 */
          h(Step, {
            n: 5, state: pairReady ? 'current' : 'todo', title: '在群里说句话',
            desc: pairReady
              ? '还差两件手工的事：请群主在最新版手机 QQ 里给群开「接收所有消息」，机器人先进群'
              : '先把第 4 步的一键直连配好',
          },
            pairReady
              ? h('div', { className: 'roost-note' },
                '开法：群主在最新版手机 QQ 里 → 群成员列表点这个机器人（或加机器人入群时点「设置权限」）→ 开启「接收全量消息」。'
                + '电脑端 QQ 没有这个设置；它不在 q.qq.com，也不是 intents 位。')
              : null,
          ),

          /**
           * 第 6 步：配置主人。**放在最后**——前面五步是「能跑起来」，
           * 这一步是「谁能指挥它」，是跑起来之后才需要定的事。
           *
           * 主人只能在 **Roost 面板**里设（面板有「主人与群组」那块），
           * 这里只读状态 + 给个跳转按钮，不代劳——
           * 主人是「谁能指挥这台机器」的根，不该由插件代写。
           */
          h(Step, {
            n: 6, state: mark.owner, title: '配置主人',
            desc: s.ownersConfigured
              ? `已设 ${s.ownerCount || 1} 个主人 —— 群友的话她只当聊天，主人才能指挥她动工具`
              : '去 Roost 面板的「主人与群组」里把你自己设成主人，不然她只能聊天、不能动工具',
          },
            h('button', {
              type: 'button',
              className: 'roost-btn',
              disabled: !s.webui,
              onClick: () => window.open(`${s.webui || ''}#groups`, '_blank', 'noopener'),
            /** 2.6：和第 2 步那颗不是同一件事——这颗带 #groups，直达主人名单 */
            }, s.ownersConfigured ? '打开「主人与群组」' : '去框架面板设主人'),
          ),
        ),

        h(DepsBlock, { info: depsInfo, busy: depsBusy, onCheck: () => loadDeps(true) }),

        /**
         * 2.7：工作区卡片从「设置」挪到这里（本体，控件一个没少）。
         * 不带编号徽标——这页的 1–6 是接入步骤的圆圈号，再排一个 01
         * 会被读成第 7 步；跟「常见卡点」一样只留标题。
         */
        h(WorkspaceCard, { saveCfg, toast, numbered: false }),

        /* 接入这几步用的是圆圈编号，这里就不再编号了 —— 混用两套编号容易读成别的步号 */
        h(Sec, { title: '常见卡点' },
          h('ul', { className: 'roost-note', style: { margin: 0, paddingLeft: 18 } },
            h('li', null, `启动后马上退出：多半是 AppID / AppSecret 填错了，或端口 ${s.port || ''} 被占`),
            h('li', null, '群里没反应：群主没在手机 QQ 里给群开「接收所有消息」，或机器人不在群里'),
            h('li', null, '群里不接话：检查「设置 → roostHost.decide」的接话模式和冷却是否在挡'),
            h('li', null, '面板一切正常但消息全失败：看「概览 → 直连状态」，seq 不动就是事件没进来'),
            s.accessKeySet === false
              ? h('li', null, '访问密钥还没设过：Roost 面板默认只监听本机，够用；要远程访问再去设')
              : null,
          ),
        ),
      )
    }

    /* ---------------- 人格（页签 key 仍是 her） ---------------- */

    /**
     * `repoSeed` 只为渲染测试注入一份仓库快照。
     *
     * 生产路径不传：清单由下面的 `loadRepo()` 在挂载时拉一次。
     * 测试环境的 useEffect 不跑（要避免真打网络），没有这个口子就没法断言
     * 「未安装的行长什么样」——而这正是合并清单最关键的一段。
     */
    /** 5.5：四段定义与后端 src/persona-sections.js 的 PERSONA_SECTIONS 对齐 */
    const PERSONA_SECTIONS = [
      { key: 'body', label: '性格与设定', hint: '正文骨架、小节标题都留在这里；不用写「## 性格」。' },
      { key: 'firstMes', label: '开场白', hint: '主动搭话时直接用的第一句。' },
      { key: 'demos', label: '说话示例', hint: '两三轮真实对话，校准长度、语气词和标点习惯。' },
      { key: 'lore', label: '世界书', hint: '一行一条：触发词1, 触发词2 | 内容（命中才注入）。' },
    ]

    /**
     * 5.5 分节编辑器：四个文本框 + 本地草稿恢复。
     *
     * 草稿写 localStorage 而不是内存 state：弹窗一关、面板一刷新，state 就没了，
     * 而人格正文是用户手敲的，丢一次就不想再写第二遍。只在「草稿与服务端
     * 内容不同」时才问要不要恢复，免得每次打开都弹一条。
     */
    function SectionEditor({ id, toast, onSaved }) {
      const DRAFT_KEY = 'roost.persona.draft.' + id
      const [blocks, setBlocks] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [pendingDraft, setPendingDraft] = useState(null)
      const [err, setErr] = useState('')
      /**
       * 5.5 可选：AI 润色。`polishFor` 是当前展开的那一段的 key（不是索引——
       * 删段之后索引会错位，key 不会）。`polishDraft` 是**待用户确认**的改写，
       * 点「采用」才写进 blocks，绝不自动替换。
       */
      const [polishPresets, setPolishPresets] = useState([])
      const [polishFor, setPolishFor] = useState('')
      const [polishPreset, setPolishPreset] = useState('concise')
      const [polishNote, setPolishNote] = useState('')
      const [polishBusy, setPolishBusy] = useState(false)
      const [polishDraft, setPolishDraft] = useState(null)

      const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY) } catch {} }
      const load = useCallback(async () => {
        setErr('')
        const r = await get('/personas/sections?id=' + encodeURIComponent(id))
        if (r?.ok === false) { setErr(r.message || '读不到分节'); return }
        /** 段名与内容由服务端自动识别，前端只负责改 / 加 / 删 */
        const fresh = r?.blocks || []
        setBlocks(fresh)
        /** 预设清单只有服务端一份，别在前端另抄 */
        setPolishPresets(Array.isArray(r?.polishPresets) ? r.polishPresets : [])
        setDirty(false)
        try {
          const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null')
          if (d && Array.isArray(d.blocks) && JSON.stringify(d.blocks) !== JSON.stringify(fresh)) {
            setPendingDraft(d)
          }
        } catch {}
      }, [id])
      useEffect(() => { load() }, [load])

      const apply = (next) => {
        setBlocks(next)
        setDirty(true)
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), blocks: next })) } catch {}
      }
      const put = (i, field, value) => {
        apply((blocks || []).map((b, j) => j === i ? { ...b, [field]: value } : b))
      }
      const removeBlock = (i) => apply((blocks || []).filter((_, j) => j !== i))
      const addBlock = () => apply([...(blocks || []), {
        key: 'custom:' + Date.now(), title: '', titleLine: '', text: '', builtin: false, custom: true,
      }])
      /**
       * 跑一次润色。**只发这一段正文**，服务端也不写盘——拼回去是这里的事。
       * 失败只 toast，不动 blocks：润色是锦上添花，不能因为它坏了编辑。
       */
      const runPolish = async (b) => {
        const text = String(b?.text || '').trim()
        if (!text) return toast('这段是空的，没什么可改')
        setPolishBusy(true)
        const r = await post('/personas/polish', {
          id,
          text,
          preset: polishPreset,
          instruction: polishNote,
          section: b.title || '',
        })
        setPolishBusy(false)
        if (r?.ok === false) return toast(r.reason || r.message || '润色失败')
        setPolishDraft({ key: b.key, text: r.text, warnings: r.warnings || [] })
      }

      const save = async () => {
        if (!blocks) return
        setBusy(true)
        try {
          const r = await post('/personas/sections/save', { id, blocks })
          if (r?.ok === false) return toast(r.message || '没存上')
          clearDraft()
          setPendingDraft(null)
          setDirty(false)
          toast('分节已存好')
          onSaved?.()
          await load()
        } finally { setBusy(false) }
      }
      const discard = async () => {
        clearDraft()
        setPendingDraft(null)
        await load()
      }

      return h('div', null,
        h('div', { className: 'roost-note', style: { marginTop: 0 } },
          '段名和内容从原文自动识别，--- 头部原样保留；段名留空 = 无标题正文，'
          + '改名或新增的段写成 ## 段名。段数不限，可任意加删。'),
        pendingDraft
          ? h('div', { className: 'pv-warn', style: { marginTop: 8 } },
              h('span', null, `这份有一份没保存的草稿（${new Date(pendingDraft.at || 0).toLocaleString()}）。`),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: () => { setBlocks(pendingDraft.blocks || []); setDirty(true); setPendingDraft(null) },
              }, '恢复草稿'),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: () => { clearDraft(); setPendingDraft(null) },
              }, '删掉草稿'),
            )
          : null,
        err ? h('div', { className: 'roost-note', style: { color: 'var(--bad)', marginTop: 8 } }, err) : null,
        blocks
          ? h('div', null,
              h('div', { className: 'roost-note', style: { marginTop: 6 } },
                `自动识别出 ${blocks.length} 段；段名和内容都能改，也能加新的段。`),
              blocks.map((b, i) => {
                const spec = PERSONA_SECTIONS.find((x) => x.key === b.key)
                return h('div', {
                  key: b.key || i,
                  style: { borderTop: '1px solid var(--line-soft)', marginTop: 10, paddingTop: 8 },
                },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h('span', {
                      className: 'roost-note',
                      style: { margin: 0, minWidth: 88, flex: '0 0 auto' },
                    }, spec ? spec.label : '自定义段'),
                    h('input', {
                      className: 'roost-input', style: { flex: '1 1 190px' },
                      placeholder: '段名（留空 = 无标题正文）',
                      value: b.title || '',
                      onChange: (e) => put(i, 'title', e.target.value),
                    }),
                    h('button', {
                      type: 'button', className: 'roost-btn', title: '删掉这一段',
                      onClick: () => removeBlock(i),
                    }, '删掉这段'),
                  ),
                  spec?.hint
                    ? h('div', { className: 'roost-note', style: { marginTop: 2 } }, spec.hint)
                    : null,
                  h('textarea', {
                    className: 'roost-input', spellCheck: false,
                    style: {
                      width: '100%', minHeight: b.key === 'body' ? 200 : 90, marginTop: 4,
                      fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 12,
                      lineHeight: 1.7, resize: 'vertical',
                    },
                    value: b.text || '',
                    onChange: (e) => put(i, 'text', e.target.value),
                  }),

                  /**
                   * 5.5 可选：AI 润色。默认收起——多数时候人是自己写的，
                   * 按钮常驻会让人以为「不点一下就写不好」。
                   * 改写结果只做对比展示，点「采用」才替换正文。
                   */
                  h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      disabled: polishBusy || !String(b.text || '').trim(),
                      onClick: () => {
                        setPolishFor(polishFor === b.key ? '' : b.key)
                        setPolishDraft(null)
                      },
                    }, polishFor === b.key ? '收起润色' : '润色'),
                    polishFor === b.key && polishPresets.length
                      ? h('select', {
                        className: 'roost-input', style: { width: 'auto' },
                        value: polishPreset, onChange: (e) => setPolishPreset(e.target.value),
                      }, polishPresets.map((x) => h('option', { key: x.id, value: x.id }, x.label)))
                      : null,
                    polishFor === b.key
                      ? h('input', {
                        className: 'roost-input', style: { flex: '1 1 180px' },
                        placeholder: '额外要求（可不填），如「别用感叹号」',
                        value: polishNote, onChange: (e) => setPolishNote(e.target.value),
                        onKeyDown: (e) => { if (e.key === 'Enter') runPolish(b) },
                      })
                      : null,
                    polishFor === b.key
                      ? h('button', {
                        type: 'button', className: 'roost-btn', disabled: polishBusy,
                        onClick: () => runPolish(b),
                      }, polishBusy ? '改着…' : '开始润色')
                      : null),

                  polishFor === b.key && polishDraft && polishDraft.key === b.key
                    ? h('div', {
                      className: 'roost-note',
                      style: { marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'rgba(120,120,255,.08)' },
                    },
                      (polishDraft.warnings || []).map((w, wi) =>
                        h('div', { key: wi, style: { color: 'var(--warn)', fontSize: 11.5, marginBottom: 4 } }, w)),
                      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 8 } },
                        h('div', null,
                          h('div', { className: 'roost-muted', style: { fontSize: 10.5 } }, '原文'),
                          h('div', { style: { fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', opacity: .75 } }, b.text)),
                        h('div', null,
                          h('div', { className: 'roost-muted', style: { fontSize: 10.5 } }, '改写'),
                          h('div', { style: { fontSize: 11.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, polishDraft.text))),
                      h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
                        h('button', {
                          type: 'button', className: 'roost-btn roost-primary',
                          onClick: () => {
                            put(i, 'text', polishDraft.text)
                            setPolishDraft(null)
                            setPolishFor('')
                            toast('已采用改写（还没保存，记得点下面的「保存分节」）')
                          },
                        }, '采用改写'),
                        h('button', {
                          type: 'button', className: 'roost-btn',
                          onClick: () => setPolishDraft(null),
                        }, '扔掉')))
                    : null,
                )
              }),
              h('button', {
                type: 'button', className: 'roost-btn', style: { marginTop: 10 },
                onClick: addBlock,
              }, '加一段'),
            )
          : h('div', { className: 'roost-note', style: { marginTop: 8 } }, '读着…'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button', className: 'roost-primary', disabled: busy || !dirty || !blocks, onClick: save,
          }, busy ? '保存中…' : dirty ? '保存分节（有未保存改动）' : '保存分节'),
          h('button', {
            type: 'button', className: 'roost-btn', disabled: !dirty && !pendingDraft, onClick: discard,
          }, '放弃改动'),
          h('span', { className: 'roost-note', style: { margin: 0 } },
            dirty ? '改动已自动存成本地草稿，刷新或关掉弹窗也不会丢。' : '改动会自动存成本地草稿。'),
        ),
      )
    }

    /**
     * 5.10 说话方式提炼：只统计主人私聊，产出一段能校准语气的描述。
     *
     * 界面上刻意**不给选会话**：语料固定是主人私聊（服务端定），给了下拉反而
     * 让人以为能选群聊——那正是这个功能要避免的跑偏。
     */
    function SpeechStyleBlock({ toast }) {
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [res, setRes] = useState(null)
      const [saved, setSaved] = useState('')

      const run = async () => {
        setBusy(true)
        const r = await get('/speech-style')
        setBusy(false)
        setRes(r)
        if (r.ok === false) toast(r.message || '提炼不出来')
      }

      const save = async () => {
        setBusy(true)
        const r = await post('/speech-style/save', {})
        setBusy(false)
        toast(r.message || (r.ok ? '已记下' : '没存上'))
        if (r.ok) setSaved(r.text || '')
      }

      const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`

      return h(Sec, {
        title: '说话方式',
        right: h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { setOpen((v) => !v); if (open) setRes(null) },
        }, open ? '收起' : '从私聊里提炼'),
      },
        h('div', { className: 'roost-note', style: { marginBottom: open ? 10 : 0 } },
          open
            ? '只统计**你本人的私聊**：群聊语料一律不进来，免得把群友的口头禅学成她的口音。提炼结果不会自动生效，你点了「记进记忆」才算。'
            : '她说话像不像你，取决于句长、标点、口头禅这些细节。可以从你的私聊里统计出来，校准语气。'),
        open
          ? h('div', null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('button', {
                type: 'button', className: 'roost-btn roost-btn-primary',
                disabled: busy, onClick: run,
              }, busy ? '算着…' : '开始提炼'),
              res?.ok === true
                ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: busy, onClick: save,
                }, '记进记忆')
                : null),

            res?.ok === false
              ? h('div', { className: 'roost-note', style: { marginTop: 8, color: 'var(--warn)' } }, res.message)
              : null,

            res?.ok === true
              ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'roost-note', style: { marginBottom: 6 } },
                  `样本 ${res.samples} 条（会话里共 ${res.totalRows} 条）· 平均 ${res.avgLen} 字 · 短句 ${pct(res.shortRatio)}`,
                  res.ownerFrom ? ` · 主人身份来源：${res.ownerFrom === 'config' ? '面板填写' : res.ownerFrom === 'roost' ? '框架配置' : '从消息学到'}` : ''),
                (res.warnings || []).length
                  ? h('div', { style: { fontSize: 11.5, color: 'var(--warn)', marginBottom: 6 } }, res.warnings.join('；'))
                  : null,
                h('div', {
                  className: 'roost-note',
                  style: { padding: '8px 10px', borderRadius: 8, background: 'rgba(120,120,255,.08)', lineHeight: 1.7 },
                }, res.styleText),
                h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 11.5 } },
                  h('span', null, `口头禅：${(res.particles || []).map((x) => `${x.w}(${x.n})`).join('、') || '—'}`),
                  h('span', null, `句号 ${pct(res.punct?.periodRatio)} · 波浪号 ${pct(res.punct?.tildeRatio)} · 省略号 ${pct(res.punct?.ellipsisRatio)}`),
                  h('span', null, `表情：${(res.emoji || []).map((x) => x.e).join(' ') || '—'}`)),
                saved
                  ? h('div', { className: 'roost-note', style: { marginTop: 8, fontSize: 11.5 } }, `已写入记忆：${saved}`)
                  : null,
              )
              : null,
          )
          : null,
      )
    }

    function HerTab({ config, personas, mem, toast, save, reload, quick, repoSeed }) {
      /** 编辑区正在打开的人格 id */
      const [editId, setEditId] = useState('')
      const [raw, setRaw] = useState('')
      const [newId, setNewId] = useState('')
      const [dirty, setDirty] = useState(false)
      /** 5.5：整份编辑仍是默认，分节编辑是新增的第二个入口（原来的一个不删） */
      const [editMode, setEditMode] = useState('raw')
      const [showNew, setShowNew] = useState(false)
      /**
       * 全局名字（0.11：名字是账号身份，不再写在人格里）。
       *
       * 用本地草稿而不是直接受控于 config：输入过程中不能每个字符都写盘，
       * 点「保存」才提交。
       */
      const [nameDraft, setNameDraft] = useState('')
      /** 用户改过名字输入框没有：没有才跟着 config 刷新，别把他正在输的内容冲掉 */
      const [nameDirty, setNameDirty] = useState(false)
      useEffect(() => {
        if (!nameDirty) setNameDraft(config?.persona?.name ?? '')
      }, [config, nameDirty])

      /**
       * 人格仓库（「从仓库更新」）。
       *
       * `repo` 是 `GET /personas/repo` 的结果：仓库里有哪些人格、本地各自
       * 什么状态（没装 / 已是最新 / 有更新 / 你改过）。服务端有 5 分钟缓存，
       * 所以进这一页拉一次不会每次都打网络。
       */
      const [repo, setRepo] = useState(repoSeed || null)
      const [repoErr, setRepoErr] = useState('')
      const [repoBusy, setRepoBusy] = useState(false)
      /** 「整理」面板（批量打标签 / 删除 / 撤销、健康扫描）。它不属于仓库，是本地清单的工具 */
      const [govOpen, setGovOpen] = useState(false)
      /** 你删过、仓库里还在的那几个默认不显示：删掉的东西不该一直挂在清单里催你 */
      const [showDeleted, setShowDeleted] = useState(false)
      const [preview, setPreview] = useState(null)
      const [riskNote, setRiskNote] = useState(null)
      /** 本地人格的搜索词。仓库视图早就有搜索框，自己的清单反而没有，200 个只能肉眼翻 */
      const [pq, setPq] = useState('')
      /**
       * 仓库里没装的那批**默认折叠**。
       *
       * 用户的诉求是「我本地就想列我下载/同步过来的那几个」——三百多份卡里
       * 绝大多数他这辈子不会装，全铺在列表里会把真正在用的挤出屏幕。
       *
       * 但**不能退回到「我的人格 / 人格仓库」两个页签**（那是更早的形态，
       * 同一个名字两边各出现一次，用户得先判断在哪一页才能动手）。
       * 所以是一张表，仓库那段收成一行，点开才展开。
       */
      const [showRepo, setShowRepo] = useState(false)
      /**
       * 编辑区改成弹窗之后，这里不再需要 `scrollIntoView`。
       *
       * 原来那行是 `block:'nearest'` —— 它只保证"刚好露出一角"，
       * 编辑区一高标题就被顶出屏幕，用户的原话是「编辑框在最下面操作有点…」。
       */

      const loadRepo = async (force) => {
        try {
          const r = await get('/personas/repo' + (force ? '?force=1' : ''))
          if (r.ok === false) { setRepoErr(r.message || '连不上仓库'); return }
          setRepo(r)
          setRepoErr('')
        } catch (e) {
          setRepoErr(e?.message || '连不上仓库')
        }
      }

      /**
       * 进这一页就查一次有没有更新（用来显示角标）。
       *
       * 失败不弹 toast——断网是常态，为此打断用户没必要，`repoErr`
       * 会在仓库面板里显示成一行灰字。
       */
      useEffect(() => { loadRepo(false) }, [])

      const pending = repo?.pending || 0

      /** 一键更新：只动「没改过」的文件，改过的跳过并报告 */
      const runSync = async () => {
        setRepoBusy(true)
        try {
          const r = await post('/personas/sync', {})
          if (r.skipped) {
            toast(r.why || '这次没更新')
          } else {
            const parts = []
            if (r.updated?.length) parts.push(`更新 ${r.updated.length} 个（${r.updated.map((x) => x.name).join('、')}）`)
            if (r.untouched?.length) parts.push(`跳过 ${r.untouched.length} 个（你改过）`)
            if (r.deleted?.length) parts.push(`${r.deleted.length} 个你删过，没动（要的话点上面的「已删」捞回来）`)
            if (r.failed?.length) parts.push(`失败 ${r.failed.length} 个（${r.failed[0].why}）`)
            toast(parts.join('；') || '已经是最新的')
            const risky = (r.updated || []).filter((x) => (x.risky || []).length)
            if (risky.length) {
              setRiskNote(risky.flatMap((x) => x.risky.map((y) => ({ ...y, id: x.id }))))
            }
          }
          await reload()
          await loadRepo(true)
        } finally {
          setRepoBusy(false)
        }
      }

      /**
       * 分节编号自己算，不写死。
       *
       * 之前每节把 '01' '02' 硬写在标题里，于是「编辑人格」那一节
       * 平时是空的占位，编号却照样占着 02 —— 情绪就跳到 03 了，
       * 看上去像少了一节。现在按实际渲染顺序编号，缺哪节后面自动跟上。
       */
      let _seq = 0
      /**
       * 分节壳子（编号自增）。
       *
       * **必须收 `...children`。** 这一页的好几块内容是并列传进来的
       * （人格列表、仓库面板、预览、覆盖提示、两段说明、新建输入框），
       * 签名只收一个 `children` 时，多出来的参数会被 JS **静默丢掉**——
       * 按钮的 onClick 照常执行、文案也变成「收起仓库」，可对应的面板
       * 永远不渲染，用户看到的就是「按了没有用」。
       */
      const sec = (title, extra, ...children) => {
        _seq += 1
        return h(Sec, Object.assign({ n: String(_seq).padStart(2, '0'), title }, extra || {}), ...children)
      }

      /** 这一页说的是「当前这个会话里她是谁」，不是「全局默认是谁」 */
      const byChat = personas?.byChat || {}
      /**
       * 按**人**指定的人格（单人专属人设）。
       *
       * 和 `byChat` 是两个维度：上面那个是「这个会话用谁」，这个是「这个人用谁」，
       * 后者优先。用户原话：「想给单人设置专属人设」。
       */
      /** 读 `/personas` 回的 bySender：reload() 只重拉那个，不重拉 /config */
      const bySender = personas?.bySender || config?.persona?.bySender || {}
      const bySenderCount = Object.keys(bySender).length
      const [senderNew, setSenderNew] = useState('')
      const [senderPick, setSenderPick] = useState('')
      /** 走专门的路由：`/config` 的 patch 是深合并，删不掉一个键 */
      const setBySender = async (senderId, id) => {
        const r = await post('/personas/by-sender', { senderId, id })
        if (r.ok === false) return toast(r.message || '没设成')
        toast(id ? '已指定' : '已移除')
        await reload()
      }
      const byChatCount = Object.keys(byChat).length
      const curId = byChat[mem?.chatId] || personas?.current || config?.persona?.current || 'default'
      /** 全局当前（可能被本群覆盖，选择器要显示全局值） */
      const globalId = personas?.current || config?.persona?.current || 'default'
      const chatId = mem?.chatId || ''
      const chatPick = chatId ? byChat[chatId] : ''
      const usage = personas?.usage || {}
      const labelOf = (id) => {
        const p = (personas?.personas || []).find((x) => x.id === id)
        return p ? (p.label || p.name || p.id) : id
      }
      const override = mem?.personaOverride || ''

      /**
       * 一张清单：本地 + 仓库里没装的。
       *
       * 原来分成「我的人格 / 人格仓库」两页，同一个名字在两边各出现一次，
       * 一边能切换、一边能安装，用户得先判断自己在哪一页才能动手。
       * 现在只有一张表：装了的能切换/编辑，没装的行内直接装。
       * 本地排前面（那是你手上有的），仓库里没装的接在后面。
       */
      /**
       * id → 和它疑似重复的其他 id（服务端按「同名 + 同字数」算的）。
       *
       * 为什么列表要自己算一份而不是用体检结果：体检要读三百多个正文，
       * 是「点体检」时才付的代价。列表进页面就得能看见角标，
       * 否则用户搜出三个一模一样的东西，还得先去点一次体检才知道它们重复。
       */
      const dupOf = personas?.dupOf || {}
      /** `persona-82876cff15` → `82876cff15`：重复时要把 id 露出来，否则两个同名项没法区分 */
      const shortId = (id) => String(id || '').replace(/^persona-/, '')

      const mineAll = personas?.personas || []
      const localIds = new Set(mineAll.map((p) => p.id))
      const repoRows = repo?.personas || []
      const repoById = new Map(repoRows.map((r) => [r.id, r]))
      /** 门槛不过时仓库行不参与：老版本解析不了新格式，装进来只会是半个人格 */
      const repoGated = Boolean(repo && repo.gate && repo.gate.ok === false)
      /** 你删过、仓库里还在的：默认不露出来，但给个入口捞回来 */
      const deletedCount = repoRows.filter((r) => r.state === 'deleted' && !localIds.has(r.id)).length
      const remoteOnly = repoGated ? [] : repoRows.filter((r) => !localIds.has(r.id)
        && (r.state === 'missing' || (r.state === 'deleted' && showDeleted)))
      const allRows = [
        ...mineAll.map((p) => ({ ...p, from: 'local', repo: repoById.get(p.id) || null })),
        ...remoteOnly.map((r) => ({
          id: r.id, label: r.label || r.name || r.id, chars: r.chars, tags: r.tags || [],
          selfName: '', from: 'repo', repo: r,
        })),
      ]
      const kw = pq.trim().toLowerCase()
      const matched = kw
        ? allRows.filter((p) =>
            [p.label || p.name || '', p.id, p.selfName || '', ...(p.tags || [])]
              .join(' ').toLowerCase().includes(kw))
        : allRows
      /**
       * 有搜索词就**两边都搜**：用户明确在找东西，把仓库那批藏起来等于让他搜不到。
       * 没搜索词时才按折叠状态决定。
       */
      const showRemote = showRepo || Boolean(kw)
      const rows = showRemote ? matched : matched.filter((p) => p.from === 'local')

      /** 装一个仓库里的人格（「装上」和「更新」是同一个动作，服务端会拒绝覆盖你改过的） */
      const installOne = async (p) => {
        const r = await post('/personas/install', { id: p.id })
        if (r.ok === false) return toast(r.why || r.message || '没装上')
        // 撞名时 localId 和仓库里的 file 不同名，不是和 id 比
        const stem = String(p.repo?.file || p.id).replace(/\.md$/i, '')
        const saved = r.localId && r.localId !== stem ? `（存为 ${r.localId}）` : ''
        toast(r.already ? '已经装过了' : `已装上${saved}${r.injected ? '，默认不许用工具' : ''}`)
        setPreview(null)
        await reload()
        await loadRepo(true)
      }

      /** 把本地那份换回仓库版本（「恢复官方」）；`deleted` 只影响文案和按钮色 */
      const restoreOne = async (p, deleted) => {
        const r = await post('/personas/restore', { id: p.id })
        // gate 不过时服务端返回 {ok:false, skipped:true, why}，没有 message
        if (r.ok === false) return toast(r.why || r.message || '没恢复成')
        toast(deleted
          ? '已恢复'
          : r.backup ? '已恢复官方版本（旧内容已备份）' : '已恢复官方版本')
        setPreview(null)
        await reload()
        await loadRepo(true)
      }

      /**
       * 关掉编辑弹窗。
       *
       * **有未保存改动就不关**，只提示。关弹窗这个动作太轻，不该承担丢正文的后果；
       * 而正文是用户自己敲的，比"顺手关掉"重要得多。
       */
      const closeEdit = () => {
        if (dirty) {
          toast('有未保存的改动，先点「保存」或「放弃改动」')
          return
        }
        setEditId('')
        setRaw('')
      }

      /** 正在编辑的那份在仓库里是什么状态（决定要不要提示「你改过」） */
      const editRepo = editId ? repoById.get(editId) || null : null

      /** 打开一个人格的正文。列表里没有 raw，得单独读一次 */
      const openPersona = async (id) => {
        const r = await get('/personas/read?id=' + encodeURIComponent(id))
        if (r.ok === false) return toast(r.message || '读不到正文')
        setEditId(id)
        setRaw(r.raw || '')
        setDirty(false)
        setEditMode('raw')
      }

      /** 5.5：分节保存成功后把整份编辑的 raw 也刷新，切回去不会看到旧正文 */
      const onSectionsSaved = async () => {
        await reload?.()
        await loadRepo?.(true)
        const r = await get('/personas/read?id=' + encodeURIComponent(editId))
        if (r?.ok !== false) { setRaw(r.raw || ''); setDirty(false) }
      }

      /**
       * 4.5 人格隔离：选择权必须在使用者手里。
       * 这里只收集选择，后端校验「没选策略不许开」；旧数据一个字节不动。
       */
      const [scopeState, setScopeState] = useState(null)
      const [scopeDraft, setScopeDraft] = useState(null)
      const loadScope = useCallback(async () => {
        const r = await get('/persona/scope')
        setScopeState(r?.ok === false ? null : r)
        setScopeDraft({
          enabled: Boolean(r?.enabled), policy: String(r?.policy || ''),
          owner: String(r?.owner || ''), byChat: { ...(r?.byChat || {}) },
        })
        return r
      }, [])
      useEffect(() => { loadScope() }, [loadScope])
      const sd = scopeDraft || { enabled: false, policy: '', owner: '', byChat: {} }
      const setSD = (patch) => setScopeDraft({ ...sd, ...patch })
      const POLICY_LABELS = {
        shared: 'A 共享：旧记忆所有人格都能读（零迁移）',
        owner: 'B 归某一个人格：其他人格从空白开始',
        perChat: 'C 逐会话指定：下面一个个人格指给旧会话',
      }
      const saveScope = async () => {
        const r = await post('/persona/scope/save', sd)
        toast(r?.ok === false ? (r.message || '没存上') : (sd.enabled ? '人格隔离已开启' : '已关掉人格隔离，回到原来的一锅记忆'))
        await loadScope()
      }

      return h('div', { className: 'pv-root' },
        /** 5.10：说话方式提炼（只学主人私聊），放在人格隔离之前——它调的是语气，不是归属 */
        h(SpeechStyleBlock, { toast }),
        h(Sec, {
          title: '人格隔离',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: loadScope }, '刷新'),
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '开启后，新记忆 / 日记 / 关系 / 会话各写各的人格；旧记忆归谁由你选，代码不替你定。',
            '只写归属标记，不搬动旧数据：关掉开关就回到原来的「一锅记忆」，专属键里的内容仍在盘上不丢。'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 } },
            h('input', {
              type: 'checkbox', checked: sd.enabled,
              onChange: (e) => setSD({ enabled: Boolean(e.target.checked) }),
            }), '开启人格隔离（默认关）'),
          h('div', { style: { margin: '8px 0', display: 'flex', flexDirection: 'column', gap: 5 } },
            Object.keys(POLICY_LABELS).map((id) => h('label', {
              key: id, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
            },
              h('input', {
                type: 'radio', name: 'persona-scope-policy', value: id,
                checked: sd.policy === id, onChange: () => setSD({ policy: id }),
              }), POLICY_LABELS[id]))),
          sd.policy === 'owner'
            ? h('div', { style: { marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', { className: 'roost-muted', style: { fontSize: 11.5 } }, '旧记忆归：'),
                h('select', {
                  className: 'roost-input', style: { width: 'auto', padding: '3px 8px', fontSize: 11.5 },
                  value: sd.owner, onChange: (e) => setSD({ owner: e.target.value }),
                },
                  h('option', { value: '' }, '选一个人格…'),
                  (scopeState?.personas || []).map((x) => h('option', { key: x.id, value: x.id }, x.name))))
            : null,
          sd.policy === 'perChat'
            ? h('div', { style: { marginBottom: 8 } },
                h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginBottom: 4 } },
                  `给每个旧会话指一个人格（共 ${(scopeState?.keys || []).length} 个；留空 = 不归任何人格）`),
                (scopeState?.keys || []).slice(0, 40).map((k) => h('div', {
                  key: k, style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 3 },
                },
                  h('span', { className: 'roost-mono', style: { fontSize: 11, flex: '1 1 auto' } }, k.slice(0, 12) + '…'),
                  h('select', {
                    className: 'roost-input', style: { width: 130, padding: '2px 6px', fontSize: 11 },
                    value: sd.byChat[k] || '',
                    onChange: (e) => {
                      const v = e.target.value;
                      const next = { ...sd.byChat };
                      /** 「不归属」要真的删键，留个空字符串会让账本里堆垃圾 */
                      if (v) next[k] = v; else delete next[k];
                      setSD({ byChat: next });
                    },
                  },
                    h('option', { value: '' }, '不归属'),
                    (scopeState?.personas || []).map((x) => h('option', { key: x.id, value: x.id }, x.name))))))
            : null,
          /**
           * 按钮行只放按钮 + 一句**短状态**。
           * 上一版把后端返回的整段 note 塞进同一个 flex 行，结果长文字和
           * 按钮挤成一行、还和卡片顶部那段说明逐字重复（截图里那块黑按钮
           * 右边拖着一长串字就是这么来的）。说明只在顶部出现一次。
           */
          h('div', {
            style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10, marginBottom: 6 },
          },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: !scopeDraft, onClick: saveScope,
            }, '保存选择'),
            h('span', { className: 'roost-muted', style: { fontSize: 11.5 } },
              !scopeState ? '读取状态…' : (scopeState.enabled ? '当前：已开启' : '当前：已关闭')),
          ),
        ),

        /**
         * 名字放在最上面：它决定「她是谁」，人格只决定「她怎么说话」。
         * 0.11 起名字全局生效——换人格不会改名。
         * 0.12 起人格可写 `selfName` 声明「我就是这个名字」（角色卡），
         * 写了会盖过这里填的全局名；所以这里的语义是「默认名字」。
         */
        h('div', { className: 'pv-top' },
          /**
           * 名字：一行「标签 + 输入 + 保存」，说明挪到下一行。
           *
           * 原来说明和输入框挤在同一行，窗口一窄输入框被压成一条缝，
           * 而那句话本身是解释语义的，不是操作提示——放行尾只会添乱。
           * 「保存」在没有改动时禁用：避免点了得到一个"已更新"的空动作。
           */
          h('div', { className: 'pv-name' },
            h('span', { className: 'pv-k' }, '名字'),
            h('input', {
              className: 'roost-input', value: nameDraft, placeholder: '她的默认名字',
              'aria-label': '她的名字',
              onChange: (e) => { setNameDraft(e.target.value); setNameDirty(true) },
            }),
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: !nameDirty || !nameDraft.trim(),
              title: nameDirty ? '保存这个名字' : '没有改动',
              onClick: async () => {
                const name = nameDraft.trim()
                if (!name) return toast('名字不能为空')
                const r = await save({ persona: { name } })
                if (r.ok === false) return toast(r.message || '没存上')
                setNameDirty(false)
                toast('名字已更新')
              },
            }, '保存'),
          ),
          h('div', { className: 'pv-hint' },
            '全局生效，换人格不会改名；人格里写了 selfName 就会盖过这里。'),

          /**
           * 当前人格：**先回答「本群现在是谁」，再给两个作用域**。
           *
           * 原来两个下拉并排、没有「所以到底是谁」的结论——本群跟随全局时，
           * 用户看到两个框都得自己推一遍。现在顶上是一行结论，
           * 下面两格分别标清「全局默认」和「这个群」，改动前就知道影响面。
           */
          h('div', { className: 'pv-now' },
            h('div', { className: 'pv-now-head' },
              h('span', { className: 'pv-k' }, chatId ? '本群现在用' : '现在用'),
              h('span', { className: 'pv-now-name' }, labelOf(curId)),
              override
                ? h(Pill, { tone: 'warn' }, '本会话被覆盖')
                : chatPick
                  ? h(Pill, { tone: 'ok' }, '本群指定')
                  : h(Pill, null, '跟随全局'),
              chatPick && chatPick !== globalId
                ? h('span', { className: 'roost-note', style: { margin: 0 } }, `全局默认是「${labelOf(globalId)}」`)
                : null,
            ),
            h('div', { className: 'pv-sels' },
              h('div', { className: 'pv-sel' },
                h('div', { className: 'pv-sel-h' },
                  h('span', { className: 'pv-sel-k' }, '全局默认'),
                  h('span', { className: 'pv-sel-d' }, '没单独指定的群都用这个'),
                ),
                h('select', {
                  className: 'roost-input', value: globalId, 'aria-label': '全局当前人格',
                  onChange: async (e) => {
                    const id = e.target.value
                    const r = await post('/personas/use', { id })
                    if (r.ok === false) return toast(r.message || '没换成')
                    toast('换好了')
                    await reload()
                  },
                },
                  /** 当前人格被删/进墓碑时，受控 select 会显示空白——补一个占位选项说清楚 */
                  (personas?.personas || []).some((p) => p.id === globalId) || !personas
                    ? null
                    : h('option', { value: globalId }, `（已删除：${globalId}）`),
                  (personas?.personas || []).map((p) =>
                    h('option', { key: p.id, value: p.id }, p.label || p.name || p.id))),
              ),
              chatId
                ? h('div', { className: 'pv-sel' },
                    h('div', { className: 'pv-sel-h' },
                      h('span', { className: 'pv-sel-k' }, '这个群'),
                      h('span', { className: 'pv-sel-d' }, '只影响本群，别的群不变'),
                    ),
                    h('select', {
                      className: 'roost-input', value: chatPick || '', 'aria-label': '本群使用的人格',
                      title: '只对最近说话的这个会话生效；换会话后这里跟着变',
                      onChange: async (e) => {
                        const id = e.target.value
                        const r = id
                          ? await post('/personas/use', { id, chatId })
                          : await post('/personas/unuse', { chatId })
                        if (r.ok === false) return toast(r.message || '没改成')
                        toast(id ? '本群已指定' : '本群已跟随全局')
                        await reload()
                      },
                    },
                      h('option', { value: '' }, personas ? `跟随全局（${labelOf(globalId)}）` : '跟随全局'),
                      /** 本群指定的那份被删了：受控 select 会显示空白，补一行说清楚（跟上面全局那个同理） */
                      chatPick && personas && !personas.personas.some((p) => p.id === chatPick)
                        ? h('option', { value: chatPick }, `（已删除：${chatPick}）`)
                        : null,
                      (personas?.personas || []).map((p) =>
                        h('option', { key: p.id, value: p.id }, p.label || p.name || p.id)))
                  )
                : h('div', { className: 'pv-sel' },
                    h('div', { className: 'pv-sel-h' },
                      h('span', { className: 'pv-sel-k' }, '这个群'),
                      h('span', { className: 'pv-sel-d' }, '先聊一句，才有会话可选'),
                    ),
                  ),
            ),
          ),
        ),
        sec('人格', null,
          /**
           * 工具条：搜索 + 计数 + 入口。
           *
           * 装了的一律排在前面，仓库里没装的接在后面——同一张表，只是顺序不同。
           * 不再有「我的人格 / 人格仓库」两个页签：同一个名字在两边各出现一次，
           * 一边能切换一边能安装，用户得先判断自己在哪一页才能动手。
           *
           * 「从仓库更新」带角标：有几个可更新就显示几。**不自动更新**——
           * 人格突然变味比"版本旧"难受得多，必须用户自己点。
           */
          h('div', { className: 'pv-bar' },
            h('input', {
              className: 'roost-input', value: pq, placeholder: '搜名字、标签或 id',
              'aria-label': '搜索人格',
              onChange: (e) => setPq(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Escape') setPq('') },
            }),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => setShowNew((v) => !v),
            }, showNew ? '收起新建' : '新建'),
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: repoBusy,
              title: repoErr ? `仓库连不上：${repoErr}` : '从 dsh-roost 仓库拉最新人格（不碰你改过的）',
              onClick: runSync,
            }, repoBusy ? '更新中…' : `从仓库更新${pending ? ' ' + pending : ''}`),
            h('button', {
              type: 'button', className: 'roost-btn',
              title: '批量打标签 / 删除 / 撤销，以及重名和超预算扫描',
              onClick: () => setGovOpen((v) => !v),
            }, govOpen ? '收起整理' : '整理'),
          ),
          /**
           * 第二行只说状态：一共几份、仓库里还有几份没装、删过几份。
           *
           * 这些原来挤在工具条里，把搜索框压到 150px 宽——
           * 而搜索才是这一页最常用的控件。
           */
          h('div', { className: 'pv-sub' },
            h('span', { className: 'pv-count' },
              !personas ? '读着…'
                : kw ? `${rows.length} / ${allRows.length} 个`
                  : showRepo
                    // 展开时要说清 "这几个是仓库的"，否则 342 突然变 349 会让人以为多了
                    ? `${rows.length} 个（本地 ${mineAll.length} + 仓库 ${remoteOnly.length}）`
                    : `${mineAll.length} 个`
                      + (remoteOnly.length ? ` · 仓库还有 ${remoteOnly.length} 个没装` : '')),
            deletedCount
              ? h('button', {
                  type: 'button', className: 'roost-btn',
                  title: '你删过、但仓库里还有的；点开才能装回来',
                  onClick: () => setShowDeleted((v) => !v),
                }, showDeleted ? '收起已删' : `已删 ${deletedCount}`)
              : null,
          ),
          /**
           * 仓库的三种异常各说一句。
           *
           * 合并成一张清单之后，「仓库拿不到」不再是"另一个页的事"——
           * 它直接决定清单里有没有那批没装的人格，所以必须在这里说明白，
           * 并且说清「本地这些不受影响」，别让人以为整个人格页挂了。
           */
          repoErr
            ? h('div', { className: 'roost-note', style: { color: '#c0392b', marginTop: -3 } },
                `仓库连不上（${repoErr}）——下面只有本地已有的人格，仓库那份暂时看不到。`)
            : null,
          repoGated
            ? h('div', { className: 'roost-note', style: { marginTop: -3 } },
                repo.gate.why + '，先升级 dsh-roost 再看仓库里的人格。')
            : null,
          repo?.stale
            ? h('div', { className: 'roost-note', style: { marginTop: -3 } },
                '用的是缓存的仓库清单，可能不是最新（点「从仓库更新」会强制重拉）。')
            : null,
          /**
           * 新建入口紧贴工具条，不用单开一节。
           *
           * 之前它占一节「编辑人格」，可那一节平时是空的（占位），
           * 真正的编辑动作又发生在点开某一行之后——入口和动作被拆到两处。
           * 现在：工具条「新建」展开输入框；点某行的「编辑」在下方展开正文。
           *
           * **位置紧贴工具条**：这几块原来排在整节末尾（人格列表 + 若干说明之后），
           * 点完按钮要往下翻半天才看到输入框，读起来就是「按了没反应」。
           * 现在按「工具条 → 新建 / 预览 → 人格列表」排，点开就在眼前。
           */
          showNew
            ? h('div', { className: 'pv-new' },
                h('input', {
                  className: 'roost-input', placeholder: '新建一个：英文 id（如 lazycat）', value: newId,
                  onChange: (e) => setNewId(e.target.value), style: { flex: 1 },
                }),
                h('button', {
                  type: 'button', className: 'roost-primary',
                  onClick: async () => {
                    const id = newId.trim()
                    if (!id) return toast('先给个 id')
                    const seedText = `---\nname: ${id}\ntags: \n---\n\n（在这里写这个人格怎么说话）\n`
                    const r = await post('/personas/save', { id, raw: seedText })
                    if (r.ok === false) return toast(r.message || '没建成')
                    setNewId('')
                    setShowNew(false)
                    toast('建好了，接着改正文')
                    await reload()
                    openPersona(id)
                  },
                }, '建'),
                /**
                 * 粘贴导入：把别人分享的人格 markdown 直接存成一个新人格。
                 *
                 * 配合上面的「复制这份」，两个人之间就能传人格了——
                 * 不需要远端仓库，也不需要格式转换（本来就是 markdown）。
                 */
                h('button', {
                  type: 'button', className: 'roost-btn',
                  onClick: async () => {
                    const id = newId.trim()
                    if (!id) return toast('先给个 id，再点粘贴导入')
                    let text = ''
                    try {
                      text = await navigator.clipboard.readText()
                    } catch {
                      return toast('读不到剪贴板，请允许读取或手动粘贴到编辑框')
                    }
                    if (!text.trim()) return toast('剪贴板是空的')
                    const r = await post('/personas/save', { id, raw: text })
                    if (r.ok === false) return toast(r.message || '没导入成功')
                    setNewId('')
                    setShowNew(false)
                    toast('导入好了')
                    await reload()
                    openPersona(id)
                  },
                  }, '粘贴导入'),
              )            : null,

          /** 预览：装之前先读一遍正文。人格是要读的，光看标签决定不了 */
          preview
            ? h('div', { className: 'pv-preview' },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { fontSize: 12, fontWeight: 650 } }, `预览：${preview.label || preview.name || preview.id}`),
                  h('span', { className: 'roost-note', style: { margin: 0 } }, `${preview.chars || 0} 字`),
                  h('button', { type: 'button', className: 'roost-btn', onClick: () => setPreview(null) }, '关闭'),
                ),
                (preview.risky || []).length
                  ? h('div', { className: 'roost-note', style: { color: '#c0392b', marginTop: 6 } },
                      `⚠ 提到工具或敏感路径 ${preview.risky.length} 处（只是提醒，不拦）：`,
                      h('div', null, preview.risky.slice(0, 5).map((r, i) =>
                        h('div', { key: i }, `第 ${r.line} 行 · ${r.why}：${r.text}`))))
                  : null,
                h('pre', {
                  style: {
                    marginTop: 8, maxHeight: 260, overflow: 'auto', fontSize: 12, lineHeight: 1.7,
                    whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace,Menlo,Consolas,monospace',
                  },
                }, preview.text || ''),
              )
            : null,

          /**
           * 清单本体。
           *
           * 每行只留两行字（名字 / 元信息）和一排动作：
           *   · 当前行把「用这个」换成「正在用」标签——已生效的动作不该还能点；
           *   · 「用这个」（或「更新」「装上」）是唯一带边框的主操作，
           *     其余动作降到次级色 + 62% 不透明度，指到那一行或键盘聚焦才全额；
           *   · 删除逐行下沉成弱色链路（点两次的确认机制没动）。
           * 视觉上从「四颗同级按钮」变成「一个主操作 + 三个备选」，
           * 一屏几十行也不再像一排按钮墙。可点性没减，只是不再同等抢眼。
           *
           * 装了的一律在前、仓库里没装的在同一个列表的后面（中间一条分组说明），
           * 不再分成「我的人格 / 人格仓库」两页。
           */
          h('div', { className: 'pv-list' },
            rows.map((p, i) => {
              /** 仓库里有、本地没有的（含你删过的）——这类行只有「预览 / 装上」 */
              const isRepo = p.from === 'repo'
              const st = p.repo?.state || ''
              const isCur = !isRepo && p.id === curId
              const isDefault = !isRepo && p.id === 'default'
              const used = usage[p.id]?.useCount ?? usage[p.id] ?? 0
              const localChars = p.repo?.localChars || 0
              /** 第一条「仓库有、本地没有」的行前面插一个分组头：装了的一律在前，这里是分界 */
              const grp = isRepo && rows[i - 1]?.from !== 'repo'
              return [
                grp
                  ? h('div', { key: 'grp-' + p.id, className: 'pv-group' },
                      `仓库里还能装的（${rows.filter((r) => r.from === 'repo').length} 个）`)
                  : null,
                h('div', {
                  key: p.id,
                  className: 'pv-row' + (isCur ? ' is-cur' : '')
                    + (isRepo ? ' is-repo' : '') + (editId === p.id ? ' is-edit' : ''),
                },
                /**
                 * 两行：名字一行（带状态）、字数与标签一行。
                 *
                 * 之前全挤在一行，右侧还要放三个按钮——窗口一窄，名字就被压没了。
                 */
                h('div', { className: 't' },
                  h('div', { className: 'pv-nm' },
                    p.label || p.name || p.id,
                    // 人格自报的名字跟全局名不同时，标出来——否则用户会以为切了人格还是「大肥鱼」
                    p.selfName && p.selfName !== p.label
                      ? h('span', { className: 'pv-alias' }, `自称 ${p.selfName}`)
                      : null,
                    isRepo
                      ? h(Pill, { tone: st === 'deleted' ? 'warn' : null }, st === 'deleted' ? '已删除' : '未安装')
                      : null,
                    /**
                     * 「正在用」和「有更新」可以同时成立：当前这份正好是旧版。
                     * 少写前一个的话，正在用的那一行会看不出自己是当前人格。
                     */
                    isCur ? h(Pill, { tone: 'ok' }, '正在用') : null,
                    !isRepo && st === 'update' ? h(Pill, { tone: 'warn' }, '有更新') : null,
                    !isRepo && st === 'modified' ? h(Pill, { tone: 'warn' }, '你改过') : null,
                    /**
                     * 疑似重复：**必须标在列表里**。
                     *
                     * 之前只在「体检」的建议列表里能看到，而主列表照样显示三行同名同字的卡，
                     * 用户根本不知道它们是重复的，更不知道该删哪个。
                     */
                    !isRepo && dupOf[p.id] ? h(Pill, { tone: 'warn' }, `疑似重复 ${dupOf[p.id].length} 份`) : null,
                  ),
                  h('div', { className: 'pv-meta' },
                    `${p.chars ?? 0} 字`
                    // 有更新时把两个字数并排放，才看得出差多少（只给字数确实不够直观）
                    + (!isRepo && st === 'update' && localChars ? `（仓库版 ${p.repo.chars} 字）` : '')
                    + ((p.tags || []).length ? ` · ${p.tags.join(' / ')}` : '')
                    + (used > 0 ? ` · 用过 ${used} 次` : '')
                    // 重复时把 id 露出来：两份卡名字一模一样，不给个区分依据就只能瞎删
                    + (dupOf[p.id] ? ` · ${shortId(p.id)}` : '')),
                ),
                h('div', { className: 'pv-acts' },
                  isRepo
                    ? [
                        h('button', {
                          key: 'pv',
                          type: 'button', className: 'roost-btn',
                          onClick: async () => {
                            const r = await get('/personas/repo/preview?id=' + encodeURIComponent(p.id))
                            if (r.ok === false) return toast(r.message || '预览不了')
                            setPreview(r)
                          },
                        }, '预览'),
                        /**
                         * 装 / 装回来。
                         *
                         * 「装回来」走 restore（服务端会顺手清掉墓碑，否则下次一键更新
                         * 还会把你删过的当成"你删的"跳过）；「装上」走 install。
                         */
                        st === 'deleted'
                          ? h('button', {
                              key: 'in',
                              type: 'button', className: 'roost-btn pv-main',
                              onClick: () => restoreOne(p, true),
                            }, '装回来')
                          : h('button', {
                              key: 'in',
                              type: 'button', className: 'roost-btn pv-main',
                              title: '装上这份（可以随时删掉）',
                              onClick: () => installOne(p),
                            }, '装上'),
                      ]
                    : [
                        st === 'update'
                          ? h('button', {
                              key: 'up',
                              type: 'button', className: 'roost-btn pv-main',
                              title: '换成仓库里的新版本（旧内容会备份）',
                              onClick: () => installOne(p),
                            }, '更新')
                          : isCur
                            ? h(Pill, { key: 'cur', tone: 'ok' }, '正在用')
                            : h('button', {
                                key: 'use',
                                type: 'button', className: 'roost-btn pv-main',
                                title: '所有群都换成它（只改全局默认）',
                                onClick: async () => {
                                  const r = await save({ persona: { current: p.id } })
                                  toast(r.ok === false ? (r.message || '没换成') : '换好了')
                                  reload()
                                },
                              }, '用这个'),
                        /** 只给「当前这个群」指定，不动全局 */
                        chatId && !isCur
                          ? h('button', {
                              key: 'chat',
                              type: 'button', className: 'roost-btn',
                              title: '只给这个群用，其他群还是全局那个',
                              onClick: async () => {
                                const r = await post('/personas/use', { id: p.id, chatId })
                                if (r.ok === false) return toast(r.message || '没指定成')
                                toast('本群已指定')
                                await reload()
                              },
                            }, '本群用')
                          : null,
                        h('button', {
                          key: 'edit',
                          type: 'button', className: 'roost-btn',
                          onClick: () => openPersona(p.id),
                        }, editId === p.id ? '编辑中' : '编辑'),
                        isDefault
                          ? null
                          : h('span', { key: 'del', className: 'pv-del' },
                              h(ConfirmLink, {
                                label: '删除', confirmLabel: '确认删除',
                                onConfirm: async () => {
                                  const r = await post('/personas/remove', { id: p.id })
                                  toast(r.ok === false ? (r.message || '没删掉') : '删了')
                                  if (editId === p.id) { setEditId(''); setRaw('') }
                                  await reload()
                                  // 仓库快照也要重算：删掉的那份会变成 deleted，
                                  // 「已删 N」的入口和状态标签都靠它
                                  await loadRepo(true)
                                },
                              }),
                            ),
                      ],
                ),
              ),
              ]
            }),
            /**
             * 仓库折叠条。
             *
             * 只在**没有搜索词**时出现：有搜索词的时候 `showRemote` 强制为真
             * （用户明确在找东西，藏起来等于让他搜不到），这条就没意义了。
             */
            !kw && remoteOnly.length
              ? h('div', { style: { padding: '10px 0 2px' } },
                  h('button', {
                    type: 'button', className: 'roost-btn', style: { width: '100%' },
                    title: '仓库里还没装的卡，装上就等于复制到本地',
                    onClick: () => setShowRepo((v) => !v),
                  }, showRepo
                    ? `收起在线仓库（${remoteOnly.length} 个没装）`
                    : `▸ 在线仓库还有 ${remoteOnly.length} 个没装`))
              : null,
            /**
             * 三种空态分开说：读着 / 一个都没有 / 搜不到。
             * 原来只有一句「读不到人格列表」——加载中也是这句话，像坏了。
             */
            !personas
              ? h('div', { className: 'pv-empty' }, '正在读取人格列表…')
              : !allRows.length
                ? h('div', { className: 'pv-empty' },
                    '还没有人格。上面「新建」可以建一个，或者点「从仓库更新」装一批。')
                : !rows.length
                  ? kw
                    ? h('div', { className: 'pv-empty' },
                        `没有匹配「${pq.trim()}」的人格`,
                        h('div', { style: { marginTop: 9 } },
                          h('button', {
                            type: 'button', className: 'roost-btn',
                            onClick: () => setPq(''),
                          }, '清空搜索')),
                      )
                    /**
                     * 本地一份都没有、但仓库里有 —— **新装用户就是这个状态**。
                     *
                     * 不区分的话会显示「没有匹配「」的人格」：搜索词明明是空的，
                     * 用户会以为页面坏了。这里要直接把话说明白并给个按钮。
                     */
                    : h('div', { className: 'pv-empty' },
                        '本地还没有人格。',
                        remoteOnly.length
                          ? h('div', { style: { marginTop: 9 } },
                              h('button', {
                                type: 'button', className: 'roost-primary',
                                onClick: () => setShowRepo(true),
                              }, `看看仓库里的 ${remoteOnly.length} 个`))
                          : null,
                      )
                  : null,
          ),

          /** 更新完的高危提醒（不拦，只亮出来让人自己判断） */
          riskNote && riskNote.length
            ? h('div', { style: { marginTop: 10, border: '1px solid #c0392b', borderRadius: 8, padding: 10 } },
                h('div', { style: { fontSize: 12, fontWeight: 650, color: '#c0392b' } },
                  `刚更新的内容里有 ${riskNote.length} 处提到工具或敏感路径`),
                h('div', { className: 'roost-note', style: { marginTop: 4 } },
                  '人格正文会进系统提示词。这些命中只是提醒——正常人格也可能提到"工具"，自己看一眼判断。'),
                h('div', { className: 'roost-note' },
                  riskNote.slice(0, 6).map((r, i) => h('div', { key: i }, `[${r.id}] 第 ${r.line} 行 · ${r.why}：${r.text}`))),
                h('button', { type: 'button', className: 'roost-btn', style: { marginTop: 6 }, onClick: () => setRiskNote(null) }, '知道了'),
              )
            : null,

          /**
           * 按群覆盖：模型用 `<<persona:>>` 写进来的那一段。
           *
           * 它是**记忆文件里**的内容，不是配置——所以只在有会话时才有，
           * 而且必须能一键清掉。之前这一行被删了，覆盖一旦写进去就再也
           * 看不见、也删不掉，只能去翻记忆页。
           */
          override
            ? h('div', { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' } },
                h('div', { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { fontSize: 12, fontWeight: 600 } }, '本会话已被覆盖'),
                  h('div', { className: 'roost-note', style: { marginTop: 2 } },
                    override.slice(0, 60) + (override.length > 60 ? '…' : '')),
                ),
                h(ConfirmLink, {
                  label: '恢复默认', confirmLabel: '确认恢复？',
                  onConfirm: async () => {
                    const r = await quick('persona.set', '')
                    toast(r.message || '回到默认人格')
                    reload()
                  },
                }),
              )
            : null,

          /**
           * 说明折叠。
           *
           * 三段解释原来直接铺在清单末尾——200 行之后，等于没写。
           * 收进 <details> 后，要查的人展开就有，不查的人不必被推着滚，
           * 清单本身也不会被这段"文档"衬得像说明书。
           */
          h('details', { className: 'pv-help' },
            h('summary', null, '人格文件放在哪、正文怎么写'),
            h('div', { className: 'roost-note', style: { marginTop: 7 } },
              '人格正文在 personas/*.md，这里改的是文件本身。'
              + (byChatCount ? `另有 ${byChatCount} 个会话单独指定了人格（在上面的「正在用」里会显示成那个）。` : '')
              + ' 模型自己用 <<persona:>> 写的覆盖优先级更高，出现在上面那一行。'),
            /**
             * 四段式说明。
             *
             * 不写这段的话，用户只会往正文里堆散文——
             * 而「开场白」「世界书」这两段是**结构**，堆在散文里不生效。
             */
            h('div', { className: 'roost-note' },
              '正文可以分四段：默认那段是性格；'
              + '「## 开场白」是她主动搭话时习惯的第一句（不会每次照抄）；'
              + '「## 世界书」一行一条，写 `触发词1, 触发词2 | 内容`，只有聊到这些词才注入（省 token）；'
              + '「## 说话示例」写 2~3 轮对话，比任何形容词都准。'),
          ),

          /**
           * 整理面板：批量加标签 / 删除 / 撤销、重名与超预算扫描。
           *
           * 它不属于"市场"，是这张清单的维护工具，所以并进这一页，
           * 而不是再开一个入口让人猜「治理」在哪。
           */
          govOpen ? h(GovPanel, { toast, reload, tick: 0, onAfter: () => loadRepo(true) }) : null,
        ),

        /**
         * 按人指定：单人专属人设。
         *
         * 为什么单独一节而不是塞进上面的表：上面那张表改的是「这个群 / 全局」，
         * 这一节改的是「**这个人**」——他走到哪个群、私聊里，用的都是这一套。
         * 粒度从会话换成发送者，是用户明确要的（「想给单人设置专属人设」）。
         */
        sec('按人指定', bySenderCount ? { right: h(Pill, null, `${bySenderCount} 人`) } : null,
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '给某一个人单独指定人格：他走到哪个群、私聊里都用这一套，优先级高于「按会话」和全局。'),
          bySenderCount
            ? h('div', null, Object.entries(bySender).map(([sid, pid]) => h('div', {
                key: sid,
                style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' },
              },
              h('code', { className: 'roost-faint', style: { wordBreak: 'break-all' } }, sid),
              h('span', { className: 'roost-faint' }, '→'),
              h('span', null, labelOf(pid)),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: () => setBySender(sid, ''),
              }, '移除'),
            )))
            : h('div', { className: 'roost-empty' }, '还没有按人指定的。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
            h('input', {
              className: 'roost-input',
              style: { minWidth: 240 },
              placeholder: '发送者 openid（不是群号）',
              value: senderNew,
              onChange: (e) => setSenderNew(e.target.value.trim()),
            }),
            h('select', {
              className: 'roost-input',
              value: senderPick,
              onChange: (e) => setSenderPick(e.target.value),
            },
            h('option', { value: '' }, '选一个人格…'),
            mineAll.map((p) => h('option', { key: p.id, value: p.id }, p.label || p.name || p.id))),
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: !senderNew || !senderPick,
              onClick: async () => {
                await setBySender(senderNew, senderPick)
                setSenderNew('')
                setSenderPick('')
              },
            }, '指定'),
          ),
          h('div', { className: 'roost-faint', style: { marginTop: 4 } },
            'openid 从会话记录里抄。扩展也可以调 POST /v1/session.configure 带 senderId 设置。'
            + '如果装了插件「rp人设」（persona-scope），别再对同一个人开它——'
            + '它改的是**消息正文**、这里改的是**系统提示**，两段会一起进上下文，容易打架。'),
        ),

        /**
         * 第五层：她自己写的（2026-11-12 从「记忆」页搬来）。
         *
         * 放在这里而不是记忆页：前四节记的都是**关于用户**的事，
         * 这一节回答的是「她自己最近怎么样、错在哪」——属于「她是谁」，
         * 不属于「她记得什么」。搬过来之后，记忆页只剩纯数据。
         *
         * 不显示出来的话，用户没法判断她到底变好了还是在重复同一个错，
         * 也没法在写歪的时候把它清掉。
         */
        sec('她自己', { right: mem?.self?.stats?.notes ? h(Pill, null, `${mem.self.stats.notes} 条`) : null },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '每天巩固时她自己写一条（跨群汇总，不属于任何一个群）。'
            + '只在新会话开头和每 15 轮的深度重注时读一点——每轮都灌会变成表演。'),
          mem?.self?.error
            ? h('div', { className: 'roost-note' }, `读不出来：${mem.self.error}`)
            : (mem?.self?.notes?.length || mem?.self?.chapters?.length)
              ? h('div', null,
                ...(mem.self.notes || []).map((n) =>
                  h('div', { key: 'n' + n.day, style: { padding: '6px 0', borderTop: '1px solid var(--line-soft)' } },
                    h('div', { className: 'roost-note', style: { marginBottom: 2 } }, n.day),
                    h('div', null, n.text),
                  ),
                ),
                ...(mem.self.chapters || []).map((c) =>
                  h('div', { key: 'c' + c.from, style: { padding: '6px 0', borderTop: '1px solid var(--line-soft)' } },
                    h('div', { className: 'roost-note', style: { marginBottom: 2 } },
                      `${c.from} → ${c.to}（压成一段）`),
                    h('div', { className: 'roost-muted' }, c.text),
                  ),
                ),
              )
              : h('div', { className: 'roost-note' }, '还没写过。她自己说得够多、或者被纠正过的日子才会写一条。'),
        ),

        /**
         * 编辑区：**弹窗**，不是页面上最下面的一节。
         *
         * 原来它渲染在列表之后，靠 `scrollIntoView({block:'nearest'})` 滚过来。
         * 但 `nearest` 只保证"刚好露出一角"：编辑区一高，标题就被顶到屏幕外；
         * 想回去对照上面那行，一滚就离开编辑区。用户的原话是
         * 「点编辑后，那个编辑框在最下面操作有点…」。
         *
         * 收进弹窗之后，列表和编辑不再抢同一根滚动条。
         */
        editId
          ? h('div', { className: 'cap-modal', onClick: closeEdit },
              h('div', {
                className: 'cap-modal-b',
                style: { width: 'min(920px,100%)' },
                onClick: (e) => e.stopPropagation(),
              },
              h('div', { className: 'cap-modal-h' },
                h('span', { className: 't' }, '编辑「' + labelOf(editId) + '」'),
                h('span', { className: 'roost-note', style: { margin: 0 } },
                  `${raw.length} 字` + (dirty ? ' · 有未保存改动' : '')),
                h('button', { type: 'button', className: 'roost-btn', onClick: closeEdit }, '关闭'),
              ),
              h('div', { className: 'cap-modal-c' },
                /**
                 * 「你改过」的恢复入口放在编辑区，而不是每行挂一颗按钮。
                 *
                 * 覆盖是不可逆的（有备份也要重找），把它放在**正文旁边**——
                 * 你正在看自己改成什么样，才有依据决定要不要换回官方的。
                 * 行内留着只会让「你改过」的行挤到五个按钮。
                 */
                editRepo && editRepo.state === 'modified'
                  ? h('div', { className: 'pv-warn' },
                      h('span', null,
                        `这份你改过（本地 ${raw.length} 字 / 仓库 ${editRepo.chars ?? 0} 字）。`
                        + '恢复官方会覆盖本地正文，旧内容自动备份到 personas/.backup/。'),
                      h(ConfirmLink, {
                        label: '恢复官方', confirmLabel: '确认覆盖？',
                        onConfirm: () => restoreOne({ id: editId, repo: editRepo }, false),
                      }),
                    )
                  : null,
                /** 5.5：两种编辑方式并列，整份编辑是原来的那个，一个控件没删 */
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '编辑方式'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    style: editMode === 'raw' ? { fontWeight: 650, borderColor: 'var(--accent, #3b82f6)' } : undefined,
                    onClick: () => setEditMode('raw'),
                  }, '整份编辑'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    style: editMode === 'sections' ? { fontWeight: 650, borderColor: 'var(--accent, #3b82f6)' } : undefined,
                    onClick: () => {
                      if (dirty) return toast('整份编辑有未保存改动，先保存或放弃')
                      setEditMode('sections')
                    },
                  }, '分节编辑'),
                ),
                h('textarea', {
                  className: 'roost-input',
                  style: {
                    minHeight: 380, display: editMode === 'raw' ? undefined : 'none',
                    fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 12, lineHeight: 1.7, resize: 'vertical',
                  },
                  value: raw,
                  spellCheck: false,
                  onChange: (e) => { setRaw(e.target.value); setDirty(true) },
                }),
                h('div', { style: { display: editMode === 'raw' ? 'flex' : 'none', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button', className: 'roost-primary',
                    disabled: !dirty,
                    title: dirty ? '写回 personas/' + editId + '.md' : '没有改动',
                    onClick: async () => {
                      const r = await post('/personas/save', { id: editId, raw })
                      toast(r.ok === false ? (r.message || '没存上') : '存好了')
                      // 改过之后这份就变成「你改过」了，仓库快照得重算，否则提示条不出现
                      if (r.ok !== false) { setDirty(false); await reload(); await loadRepo(true) }
                    },
                  }, dirty ? '保存（有未保存改动）' : '保存'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: () => { setEditId(''); setRaw(''); setDirty(false) },
                  }, '放弃改动'),
                  /**
                   * 导出 = 把整份 markdown 复制出去。
                   *
                   * 这就是「人格仓库」的最小形态：人格本来就是一个 .md 文件，
                   * 能复制就能分享，别人粘贴进去就能用——不需要先做一个远端服务。
                   */
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: async () => {
                      try {
                        await navigator.clipboard.writeText(raw)
                        toast('已复制，发给别人就能用')
                      } catch {
                        toast('复制不了，手动全选文本框吧')
                      }
                    },
                  }, '复制这份'),
                  h('span', { className: 'roost-note', style: { margin: 0 } },
                    '--- 之间是 name/tags；正文可分四段：性格（默认）、## 开场白、## 世界书、## 说话示例。'
                    + '不想手写标题就切到「分节编辑」。'),
                ),
                editMode === 'sections'
                  ? h(SectionEditor, { id: editId, toast, onSaved: onSectionsSaved })
                  : null,
              ),
            ),
          )
          : null,


      )
    }

    /* ---------------- 记忆（三层） ---------------- */

    function MemoryTab({ mem, toast, reload, quick, busy, onPickChat, setTab, config, saveCfg }) {
      /** 3.4 召回预览：输入一句话，走真实召回（dry），看命中与原因 */
      const [pvText, setPvText] = useState('')
      const [pvResult, setPvResult] = useState(null)
      const [pvBusy, setPvBusy] = useState(false)
      const runPreview = async () => {
        const t = pvText.trim()
        if (!t) return toast('先输入一句话')
        setPvBusy(true)
        try {
          const r = await post('/memory/recall-preview', { text: t, chatId: mem?.chatId || '' })
          setPvResult(r?.ok === false ? { err: r.message || '预览失败' } : r)
        } catch (e) {
          setPvResult({ err: e.message })
        } finally {
          setPvBusy(false)
        }
      }
      /** 3.3 召回参数草稿：null = 跟随配置；保存走整段提交，恢复默认就是写回默认值 */
      const [rcDraft, setRcDraft] = useState(null)
      const RECALL_DEFAULTS = { perPath: 40, entityLimit: 40, linkLimit: 5, residentMax: 600, deepMax: 1200, dynMax: 480 }
      const rcCfg = config?.recall || {}
      const rcVal = (k) => (rcDraft !== null && rcDraft[k] !== undefined ? rcDraft[k] : String(rcCfg[k] ?? ''))
      const putRecall = async (patch) => {
        if (!saveCfg) return
        const r = await saveCfg({ recall: patch })
        toast(r?.ok === false ? (r.message || '没存上') : '已保存，下一轮召回生效')
        setRcDraft(null)
      }
      const rcRow = (k, label, hint) => h('label', { key: k, style: { display: 'flex', gap: 6, alignItems: 'center' } },
        h('span', { className: 'roost-note', style: { margin: 0 } }, label),
        h('input', {
          type: 'number', min: 1, className: 'roost-input', style: { width: 84 },
          title: hint, value: rcVal(k),
          onChange: (e) => setRcDraft({ ...rcDraft, [k]: e.target.value }),
        }))
      /** 召回记录：后端每轮都在写，这里给个入口看「她刚才想起了什么」 */
      const [recallRows, setRecallRows] = useState(null)
      const [recallErr, setRecallErr] = useState('')
      const loadRecall = async () => {
        const r = await quick('recall.log', { limit: 50 })
        /** 读失败要明说，别统一显示「还没有记录」把报错伪装成空数据 */
        setRecallErr(r?.ok === false ? (r.message || '召回记录读取失败') : '')
        setRecallRows(r?.rows || [])
      }
      /**
       * 切会话要重拉：`loadRecall` 读的是 `mem.chatId` 的召回记录。
       * 只挂载时拉一次的话，标题写着 B 群、下面列的还是 A 群的召回。
       */
      useEffect(() => { loadRecall() }, [mem?.chatId])
      /**
       * A2 记忆统计快照：纯读，按需拉（点「看统计」才查，不默认打接口）。
       * 数字全来自 stats.snapshot 的聚合，不在前端另算一套口径。
       */
      const [statsSnap, setStatsSnap] = useState(null)
      const [statsErr, setStatsErr] = useState('')
      const [statsBusy, setStatsBusy] = useState(false)
      const loadStats = async () => {
        setStatsBusy(true)
        try {
          const r = await quick('stats.snapshot', { period: 7 })
          setStatsErr(r?.ok === false ? (r.message || '统计读取失败') : '')
          setStatsSnap(r?.ok === false ? null : r)
        } catch (e) {
          setStatsErr(e.message)
          setStatsSnap(null)
        } finally {
          setStatsBusy(false)
        }
      }
      /**
       * B2 心智模型快照：读现有投影 / 读落盘快照 / 刷新 / 清空。
       * 都按需拉；刷新默认纯投影不调模型，模型改写是双重开关（默认关）。
       */
      const [mindPrev, setMindPrev] = useState(null)
      const [mindSnap, setMindSnap] = useState(null)
      const [mindBusy, setMindBusy] = useState(false)
      const [mindErr, setMindErr] = useState('')
      const loadMindPreview = async () => {
        setMindBusy(true)
        try {
          const r = await quick('mind.model')
          setMindErr(r?.ok === false ? (r.message || '预览失败') : '')
          setMindPrev(r?.ok === false ? null : r)
        } catch (e) { setMindErr(e.message); setMindPrev(null) }
        finally { setMindBusy(false) }
      }
      const loadMindSnapshot = async () => {
        const r = await quick('mind.snapshot', { id: 'default' })
        setMindSnap(r?.ok === false ? null : (r?.snapshot || null))
      }
      const doMindRefresh = async (opts = {}) => {
        setMindBusy(true)
        try {
          const r = await quick('mind.refresh', { id: 'default', mode: opts.mode || 'full', dry: Boolean(opts.dry) })
          toast(r?.ok === false ? (r.message || '刷新失败') : (opts.dry ? '预览好了（没写盘）' : '快照已更新'))
          if (r?.ok && !opts.dry) await loadMindSnapshot()
          return r
        } catch (e) { toast(e.message); return null }
        finally { setMindBusy(false) }
      }
      const doMindClear = async () => {
        const r = await quick('mind.clear', { id: 'default' })
        toast(r?.ok === false ? (r.message || '没清掉') : '心智模型快照清了')
        if (r?.ok) setMindSnap(null)
      }

      /**
       * A3 标签：筛选框 + 行内编辑。
       * 筛选在前端做（factsDetail 已带 tags），不新开 quick op——
       * 后端 listFull/listRanked 的 opts.tags 供内部召回用，两条路互不干扰。
       */
      const [tagFilter, setTagFilter] = useState('')
      const [tagEdit, setTagEdit] = useState(null) // { scope, text, value }
      const splitTags = (v) => String(v ?? '').split(/[,，]/).map((x) => x.trim()).filter(Boolean)
      const tagsOf = (scope, text) => {
        const d = (mem?.factsDetail?.[scope] || []).find((x) => x.text === text)
        return Array.isArray(d?.tags) ? d.tags : []
      }
      const tagHit = (scope, text) => {
        const wanted = splitTags(tagFilter).map((x) => x.toLowerCase())
        if (!wanted.length) return true
        const have = tagsOf(scope, text).map((x) => String(x).toLowerCase())
        return wanted.every((w) => have.includes(w))
      }
      const saveTags = async (scope, text, value) => {
        const r = await post('/memory/fact', {
          action: 'tags', scope, chatId: mem?.chatId || '', key: text, tags: splitTags(value),
        })
        toast(r?.ok === false ? (r.message || '没存上') : '标签已更新')
        if (r?.ok) { setTagEdit(null); if (reload) reload() }
      }
      /**
       * B1 历史/证据：点「史」才拉（只读 quick op），不默认打接口。
       * 后端明确标了 earlier 是推断不是因果链，面板文案照写，别冒充"演变链"。
       */
      const [historyKey, setHistoryKey] = useState('') // `${scope}\u0000${text}`
      const [historyData, setHistoryData] = useState(null)
      const [historyBusy, setHistoryBusy] = useState(false)
      /**
       * 切会话必须收起历史：否则标题写着 B 群、下面还挂着 A 群展开的证据引文。
       * 同一条先例见上面 loadRecall 的 useEffect（阶段 1 踩过一次）。
       */
      useEffect(() => {
        setHistoryKey('')
        setHistoryData(null)
      }, [mem?.chatId])
      const loadHistory = async (scope, text) => {
        setHistoryBusy(true)
        try {
          const r = await quick('memory.history', { scope, text, chatId: mem?.chatId || '' })
          setHistoryData(r?.ok === false ? { err: r.message || '读不出来' } : (r?.detail || null))
        } catch (e) {
          setHistoryData({ err: e.message })
        } finally { setHistoryBusy(false) }
      }
      const historyPanel = (scope, text) => {
        const d = historyData
        if (!d) return null
        if (d.err) return h('div', { className: 'roost-note', style: { color: 'var(--bad)' } }, d.err)
        if (!d.found) return h('div', { className: 'roost-empty' }, '这条已经不在库里了')
        const evRow = (e, k) => h('div', { key: k, style: { fontSize: 11, marginBottom: 2 } },
          e.hasQuote ? `引文：${e.quote}` : `摘要：${e.quote}`,
          e.journalId ? ` · 来源 ${e.journalId}` : '',
          e.at ? ` · ${new Date(e.at).toLocaleDateString('zh-CN')}` : '')
        return h('div', { style: { marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)' } },
          h('div', { className: 'roost-muted', style: { fontSize: 11, marginBottom: 4 } },
            `证据 ${d.evidence.length} 条 · 佐证 ${d.proofs} 条 · 置信度 ${Number(d.confidence).toFixed(2)}`),
          d.evidence.length
            ? h('div', {}, d.evidence.map(evRow))
            : h('div', { className: 'roost-muted', style: { fontSize: 11 } }, '这条没有可核验的证据引文'),
          d.earlier.length
            ? h('div', { style: { marginTop: 8 } },
                h('div', { className: 'roost-muted', style: { fontSize: 11, marginBottom: 2 } },
                  `此前说法 ${d.earlier.length} 条（推断，非因果链）`),
                d.earlier.map((x, k) => h('div', { key: k, style: { fontSize: 11, marginBottom: 4 } },
                  x.text,
                  h('span', { className: 'roost-muted' },
                    ` · 于 ${new Date(x.until).toLocaleDateString('zh-CN')} 被取代`
                    + (x.adjacent ? ' · 时间相邻' : '')
                    + ` · 相似度 ${x.similarity}`),
                )),
              )
            : null,
          h('div', { className: 'roost-muted', style: { fontSize: 10, marginTop: 6 } }, d.note),
        )
      }
      /** 事实行：标签行内编辑 + 历史展开 + 原「删」入口。两层列表共用，免得两处改漏一处。 */
      const factRow = (scope, f, i) => {
        const editing = tagEdit && tagEdit.scope === scope && tagEdit.text === f
        const hk = `${scope}\u0000${f}`
        const open = historyKey === hk
        return h('div', { key: i, className: 'roost-item', style: { flexWrap: 'wrap' } },
          h('span', { className: 't', style: { flex: 1, minWidth: 0 } }, f),
          !editing
            ? h('span', { className: 'roost-muted', style: { fontSize: 11, flexShrink: 0 } }, factMeta(scope, f))
            : null,
          editing
            ? [
                h('input', {
                  key: 'in', className: 'roost-input', value: tagEdit.value,
                  placeholder: '标签，逗号分隔；留空=清空',
                  style: { flex: 1, minWidth: 120 },
                  onChange: (e) => setTagEdit({ ...tagEdit, value: e.target.value }),
                }),
                h('button', { key: 'save', type: 'button', className: 'roost-btn', onClick: () => saveTags(scope, f, tagEdit.value) }, '存'),
                h('button', { key: 'cancel', type: 'button', className: 'roost-btn', onClick: () => setTagEdit(null) }, '消'),
              ]
            : [
                h('button', {
                  key: 'his', type: 'button', className: 'roost-btn',
                  title: '看这条事实的证据引文与此前说法（只读）',
                  onClick: async () => {
                    if (open) { setHistoryKey(''); setHistoryData(null); return }
                    setHistoryKey(hk); setHistoryData(null); await loadHistory(scope, f)
                  },
                }, historyBusy && open ? '…' : (open ? '收' : '史')),
                h('button', {
                  key: 'tag', type: 'button', className: 'roost-btn',
                  title: '给这条事实打标签，之后可按标签筛',
                  onClick: () => setTagEdit({ scope, text: f, value: tagsOf(scope, f).join(', ') }),
                }, '标'),
                h(ConfirmLink, {
                  key: 'del', label: '删', confirmLabel: '确认删除',
                  onConfirm: async () => {
                    const r = await quick('memory.remove', f)
                    toast(r.message || '删了')
                    reload()
                  },
                }),
              ],
          open ? h('div', { style: { flexBasis: '100%' } }, historyPanel(scope, f)) : null,
        )
      }

      /** 3.4 向量/重排状态：开关开了到底生效没，点一下看，别靠猜 */
      const [vecStatus, setVecStatus] = useState(null)
      const loadVecStatus = async () => {
        const r = await quick('memory.vector.status')
        setVecStatus(r?.ok === false ? { err: r.message || '状态读取失败' } : r)
      }
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [fact, setFact] = useState('')
      /** 星图改成按需弹窗：关掉就卸载，3D 自动旋转不会在后台空转 */
      const [starOpen, setStarOpen] = useState(false)
      /** 翻一翻：跨事实/日记的统一列表 */
      const [browse, setBrowse] = useState(null)
      const [browseQ, setBrowseQ] = useState('')
      const [browseBusy, setBrowseBusy] = useState(false)
      const [browseEdit, setBrowseEdit] = useState(null)
      /** 容量编辑态：null = 跟着 config 显示，改过才用本地值 */
      const [capEdit, setCapEdit] = useState(null)
      /**
       * 请求快照：回来时对不上就丢弃。
       *
       * 两个真实时序（2026-11 审查）：
       *   · 搜完点「加载更多」（在途）→ 输入新词回车 → 旧 append 回来把旧词的
       *     行接到新列表后面，`total` 也被旧响应写回；
       *   · 切会话后列表没重置 → 新群的页接在旧群后面，行内「归档/作废」
       *     带着新群的 chatId 打到**错的会话**。
       */
      const browseSeq = useRef(0)
      const loadBrowse = async ({ append = false } = {}) => {
        const seq = ++browseSeq.current
        const baseLen = append && browse ? browse.items.length : 0
        const baseQ = browseQ
        const baseChat = mem?.chatId || ''
        setBrowseBusy(true)
        try {
          const offset = baseLen
          const qs = '?limit=20&offset=' + offset
            + '&q=' + encodeURIComponent(baseQ)
            + (baseChat ? '&chatId=' + encodeURIComponent(baseChat) : '')
          const r = await get('/memory/browse' + qs)
          /** 期间又搜了一次 / 又切了会话：这份结果已经过期，直接丢 */
          if (seq !== browseSeq.current) return
          if (r?.ok === false) { toast(r.message || '翻不动'); return }
          setBrowse((cur) => ({
            total: Number(r.total) || 0,
            hasMore: Boolean(r.hasMore),
            /**
             * 追加要求「当前列表还是发起时那一份」：行数对不上说明中间被
             * 重置或被另一次搜索换掉了，宁可丢掉这一页也不要串群。
             */
            items: append && cur && cur.items.length === baseLen
              ? [...cur.items, ...(r.items || [])]
              : (r.items || []),
          }))
        } catch (e) {
          if (seq === browseSeq.current) toast('翻不动：' + e.message)
        } finally {
          /**
           * **无条件复位**。按序号判断的话，「切会话」把序号加了、却不会发起
           * 新请求，在途那次回来时就永远不复位 —— 搜索按钮永久 disabled。
           * 迟到的响应已经在 try 里 return 掉了，这里复位不会写脏状态。
           */
          setBrowseBusy(false)
        }
      }
      const [scope, setScope] = useState('global')
      /**
       * 正在确认要删的那条关系。
       *
       * 不用 `window.confirm`：它给不了「删掉 / 只是现在不成立」这种二选一，
       * 而这两个语义差别很大——一个是"以后别再记"，一个只是标个结束时间。
       * 选错了前者要撤销，后者要重新聊一遍。
       */
      const [delEdge, setDelEdge] = useState(null)
      const jr = mem?.journal
      const gp = mem?.graph
      const canChat = Boolean(mem?.chatId)
      const chats = mem?.chats || []
      const scene = mem?.scene || null

      /**
       * 这个会话叫什么。
       *
       * 「本群」两个字必须变成具体名字：`scene.name` 是最近说话那个的准确名字，
       * 别的会话从会话表的 title 取；再取不到就退到 chatId 短码——
       * 显示短码也比显示「本群」强，至少能和「会话」页对上。
       *
       * **名字后面必须带类型标签。**
       * QQ 官方事件里没有群名（只有 openid），ai-chat 取不到群名就回退成
       * 发消息那个人的昵称——于是群和私聊的 title 变成同一个人的名字。
       * 光看名字分不出哪个是群，标上「群」「私聊」才分得开。
       */
      const kindTag = (c) => (c?.kind === 'c2c' ? '私聊' : c?.kind === 'group' ? '群' : '')
      const nameOf = (c) => {
        const tag = kindTag(c)
        const nm = c?.title || (c?.chatId ? c.chatId.slice(0, 10) : '')
        return tag ? `${nm}（${tag}）` : nm
      }
      const sceneName = nameOf(scene) || (canChat ? String(mem.chatId).slice(0, 10) : '')
      const sceneKind = scene?.kind === 'c2c' ? '私聊' : scene?.kind === 'group' ? '群' : scene?.kind || '会话'

      /**
       * 一条事实的「多重、从哪来」。
       *
       * 权重系统做完了但看不见等于没做：用户看到一条事实被挤掉，
       * 会以为是 bug，而不是「它 40 天没被提到、权重掉到最低」。
       * 出处同理——「她为什么记着这个」是这类系统最常被问的问题，
       * 而答案就在 `factsDetail` 里（面板手记的还标着「你手动记的」）。
       *
       * 老库没有 `src` 是常态（这个字段是后加的），所以缺省文案是
       * 「来源不明」而不是留空——留空会让人以为渲染坏了。
       */
      const factMeta = (scope, text) => {
        const list = mem?.factsDetail?.[scope]
        if (!Array.isArray(list)) return ''
        const d = list.find((x) => x.text === text)
        if (!d) return ''
        const parts = []
        if (Number(d.w) > 1) parts.push(`×${Number(d.w)}`)
        const s = d.src
        if (s?.manual) parts.push('你手动记的')
        else if (s?.at) parts.push(`来自 ${ago(s.at)}的对话`)
        else parts.push('来源不明')
        /**
         * 可信度（2026-11-18）：默认 fact 不标，只有转述和猜测才显出来。
         * 不标"本人说的"是有意的——大多数条目都是，全标等于噪音。
         * 「猜的」那档不注入，但留在库里，面板得让它看得见、删得掉。
         */
        if (d.status === 'hearsay') parts.push(s?.speaker ? `听说·${s.speaker}说的` : '听说的')
        else if (d.status === 'guess') parts.push('猜的 · 不注入')
        /**
         * 证据趋势（阶段1 算出来的一直没露出来）：只在"非默认态"显示，
         * 免得每条事实都挂个"稳定"变成噪音。走弱/陈旧是真正值得看到的——
         * 它解释了"为什么这条慢慢不注入了"，对齐 Hindsight 的可解释性。
         */
        const TREND_LABEL = { strengthening: '增强中', weakening: '走弱', stale: '陈旧' }
        if (TREND_LABEL[d.trend]) parts.push(TREND_LABEL[d.trend])
        /** 证据条数：多条独立出处才算"被反复印证"，1 条不标 */
        const evCount = Array.isArray(d.evidence) ? d.evidence.length : 0
        if (evCount >= 2) parts.push(`${evCount} 条佐证`)
        /** 阶段 2 标签：跟在出处后面，不另起一行（老库没有 tags = 不显示） */
        if (Array.isArray(d.tags) && d.tags.length) parts.push(d.tags.map((t) => '#' + t).join(' '))
        return parts.join(' · ')
      }

      /**
       * 被取代的说法（`meta.until` 有值）。
       *
       * 它们**不注入**，但还占着那 40 个名额 —— 面板上不露出来的话就变成
       * 「看不见也删不掉」，只能等它自然被淘汰。和关系那边的「结束的」
       * 一个道理：历史留着、默认折叠、随时可删。
       */
      const historyRows = (() => {
        const pick = (scope, label) =>
          (Array.isArray(mem?.factsDetail?.[scope]) ? mem.factsDetail[scope] : [])
            .filter((x) => Number(x.until) > 0)
            .map((x) => ({ ...x, scope, label }))
        return [...pick('global', '跨群'), ...pick('chat', '本会话')]
      })()

      const doSearch = async () => {
        const term = q.trim()
        if (!term) return
        const r = await get('/journal?q=' + encodeURIComponent(term) + (mem?.chatId ? '&chatId=' + encodeURIComponent(mem.chatId) : ''))
        if (r.ok === false) return toast(r.message || '搜不了')
        setHits(r.results || [])
      }

      /**
       * 删一条关系的确认块，渲染在**被点的那一行正下方**。
       *
       * 两个选项对应两种真实诉求，必须分开：
       *   · 记错了 → 删掉 + 立墓碑，以后巩固也不会再写回来
       *   · 过时了 → 只标结束时间，历史还看得见
       * 直接 DELETE 是不行的：日记原文还在，第二天又被抽回来。
       *
       * **不能复用 `.roost-item`**：那是横排 flex（`.t` 占 flex:1、
       * `.d` 固定宽度）。把标题、按钮行、说明三块塞进去会挤在同一行，
       * 标题被压成一个字一行——线上真长这样。所以这里自己写竖排。
       */
      const edgeConfirm = (e) =>
        h('div', {
          style: {
            borderLeft: '2px solid var(--roost-warn, #d08770)',
            paddingLeft: 10,
            margin: '2px 0 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          },
        },
          h('div', { style: { fontSize: 12.5 } },
            `删掉「${e.src} —${e.rel}→ ${e.dst}」？`,
            h('span', { style: { fontSize: 11, opacity: 0.7 } },
              e.chatId ? '（只在这个会话）' : '（所有会话）')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy,
              onClick: async () => {
                /**
                 * `chatId` 传**这条边自己的作用域**，不是当前会话。
                 *
                 * 关系有两种归属：挂在某个会话上，或者全局（chat_id=''）。
                 * 用当前会话去删一条全局关系，`suppressEdge` 里那句
                 * `(?='' OR chat_id=?)` 一条都匹配不上——边还在，
                 * 面板上看起来像"点了没反应"。
                 */
                const r = await quick('graph.suppress', {
                  src: e.src, rel: e.rel, dst: e.dst,
                  chatId: e.chatId,
                  why: '面板手动删除',
                })
                toast(r.ok === false ? (r.message || '没删掉') : (r.message || '删了'))
                setDelEdge(null)
                reload()
              },
            }, '删掉，以后也别再记'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: async () => {
                const r = await quick('graph.close', {
                  src: e.src, rel: e.rel, dst: e.dst, chatId: e.chatId,
                })
                toast(r.ok === false ? (r.message || '没标上') : (r.message || '标成「现在不成立了」'))
                setDelEdge(null)
                reload()
              },
            }, '只是现在不成立了'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: () => setDelEdge(null),
            }, '算了'),
          ),
          h('div', { className: 'roost-note' },
            '「删掉」会同时记住“别再记这条”——不这样的话，凌晨巩固会从日记里把它重新抽出来。'),
        )

      return h('div', null,
        /**
         * 先回答「本群是哪个群」。
         *
         * 之前这一页的「本群」其实是 `lastScene.chatId || ''`——你没得选，
         * 也不告诉你是哪个；一个会话都没进来时它甚至是空串那层，
         * 写进去等于没写。所以选择器放在最上面，标题就用真名。
         */
        h('div', { className: 'roost-banner', style: { marginTop: 0 } },
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            /**
             * 标题里已经带了「（群）」「（私聊）」，前面就不再写「群：」了。
             *
             * 那个短码徽章也去掉了——它和标题里的是同一个值
             * （`chatId.slice(0,10)`），并排显示像两串不同的数字。
             * 要看完整 openid 去「会话」页，那里有一整串。
             */
            h('b', { style: { flexShrink: 0 } }, canChat ? sceneName : '还没有会话'),
            chats.length > 1
              ? h('select', {
                  className: 'roost-input',
                  value: mem.chatId || '',
                  /**
                   * 切会话要把「翻一翻」整块清掉。
                   *
                   * 只 `setHits(null)` 的话，旧群的行还留在表里：新群的页接在
                   * 后面，行内「归档 / 作废」发出去的是 `{ id: 旧行id,
                   * chatId: 新群 }` —— 写操作打到错的会话。
                   */
                  onChange: (e) => {
                    setHits(null)
                    browseSeq.current += 1
                    setBrowse(null)
                    setBrowseQ('')
                    setBrowseEdit(null)
                    onPickChat?.(e.target.value)
                  },
                  style: { flex: 1, minWidth: 170, marginLeft: 'auto' },
                  'aria-label': '看哪个会话的记忆',
                },
                  chats.map((c) =>
                    h('option', { key: c.chatId, value: c.chatId },
                      `${nameOf(c)}${c.chatId === mem.chatId ? '（正在看）' : ''}`),
                  ),
                )
              : null,
          ),
          h('i', null, canChat
            ? '下面「本会话特有」说的就是这个会话。切到别的会话，日记和关系跟着一起换。'
            : '还没有任何群或私聊说过话，所以没有「本会话」可看——先聊一句，或者只看跨群事实。'),

          /**
           * 这个会话「不记也不读」的开关（纯净模式）。
           *
           * 和「清空本会话记忆」分开放：这个只是停读停写，**已有记忆原样保留**，
           * 关回来就能用；清空是不可逆的。混在一起点错，代价差太远。
           */
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
            h('button', {
              type: 'button',
              className: 'roost-btn',
              disabled: !canChat || Boolean(busy),
              title: '只影响这个会话：不再读也不再写记忆，已有记忆保留',
              onClick: async () => {
                const r = await quick(mem?.muted ? 'memory.unmute' : 'memory.mute')
                toast(r.message || (r.ok === false ? '没改成' : '改了'))
                reload()
              },
            }, mem?.muted ? '恢复记忆' : '本会话不记'),
            mem?.muted
              ? h('span', { className: 'roost-muted', style: { fontSize: 12 } },
                  '现在不读也不记；已有的记忆还在，恢复后就能用')
              : null,
          ),
        ),

        /**
         * 记忆星图：原位置只留一个入口按钮，点了才在弹窗里渲染星图。
         * 关掉弹窗即卸载组件 —— 自动旋转 / 星尘动画不再后台空转，
         * 记忆页本身也回到「先看事实再看图」的顺序，不被 420px 画布顶开。
         * 数据仍是同一份 /memory 快照，不新开接口。
         */
        /** A7：页首这几张是「总览入口」，不参与 01–07 的编号；说清就不会像漏页 */
        h('div', { className: 'roost-note', style: { marginBottom: 8 } },
          '下面几张（记忆统计 / 心智模型 / 记忆星图 / 分层与遗忘 / 翻一翻）是总览入口，不参与编号；从「01 事实」起才是主流程。'),
        /**
         * A2 统计快照：对齐 Hindsight /stats + timeseries 的展示形态。
         * 只读、按需拉；7 天时序用最朴素的柱状，不引图表库（零依赖铁律）。
         */
        h(Sec, { title: '记忆统计', right: h('button', {
          type: 'button', className: 'roost-btn', disabled: statsBusy, onClick: loadStats,
        }, statsBusy ? '读…' : '看统计') },
          statsErr
            ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } }, statsErr)
            : !statsSnap
              ? h('div', { className: 'roost-empty' }, '点「看统计」拉一张快照（只读，不改记忆）')
              : (() => {
                  const f = statsSnap.facts || {}, j = statsSnap.journal || {}, g = statsSnap.graph || {}
                  const cells = [
                    ['事实', `${f.live ?? 0} / ${f.total ?? 0}`, '活的 / 存储总数'],
                    ['日记', `${j.total ?? 0}`, `压缩 ${j.compressionRate ?? 0}`],
                    ['实体 · 边', `${g.entities ?? 0} · ${g.edges ?? 0}`, g.enabled ? '' : '图谱未启用'],
                    ['近 7 天新增', `${(statsSnap.timeseries || []).reduce((a, d) => a + (d.count || 0), 0)} 条`, '按天见下'],
                  ]
                  const max = Math.max(1, ...(statsSnap.timeseries || []).map((d) => d.count || 0))
                  return h('div', {},
                    h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 } },
                      cells.map(([k, v, hint]) => h('div', { key: k, className: 'roost-item', style: { flex: '1 1 120px' } },
                        h('div', { className: 'roost-muted', style: { fontSize: 11 } }, k),
                        h('div', { style: { fontSize: 16, fontWeight: 600 } }, v),
                        hint ? h('div', { className: 'roost-muted', style: { fontSize: 10.5 } }, hint) : null))),
                    h('div', { className: 'roost-note', style: { marginBottom: 6 } }, '每天新增日记（近 7 天）'),
                    h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 64 } },
                      (statsSnap.timeseries || []).map((d) => h('div', {
                        key: d.day, title: `${d.day}：${d.count} 条`,
                        style: { flex: 1, height: Math.max(2, Math.round((d.count || 0) / max * 56)), background: 'var(--accent)', borderRadius: 2 },
                      }))),
                    h('div', { style: { display: 'flex', gap: 4, marginTop: 3 } },
                      (statsSnap.timeseries || []).map((d) => h('span', { key: d.day, className: 'roost-muted', style: { flex: 1, fontSize: 9, textAlign: 'center' } }, d.day.slice(5)))))
                })(),
        ),

        /**
         * B2 心智模型：纯投影（mind.model）随时可看，落盘快照（mind.snapshot）
         * 要点「刷新快照」才写 mind-model.json——默认关逐字不变。
         */
        h(Sec, { title: '心智模型', right: h('button', {
          type: 'button', className: 'roost-btn', disabled: mindBusy, onClick: loadMindPreview,
        }, mindBusy ? '…' : '看当前投影') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '「当前投影」是实时从活事实算出的树，不落盘；「快照」要点刷新才写进独立文件，',
            '不进日记、不进自述，也不会自动注入每轮对话。'),
          /** 模型改写：一个开关搞定（勾上=授权，刷新自动用模型；默认关=纯机械零调用） */
          h('label', {
            style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12 },
            title: '勾上后「刷新快照 / 预览刷新」会调后台模型帮忙重组语言；不勾则纯机械投影，零模型调用',
          },
            h('input', {
              type: 'checkbox',
              checked: config?.memory?.mindModel?.modelRefresh === true,
              disabled: Boolean(busy),
              onChange: async (e) => {
                const on = Boolean(e.target.checked)
                if (!saveCfg) { toast('配置不可写，没存上'); return }
                const memory = { ...(config?.memory || {}) }
                memory.mindModel = { ...(memory.mindModel || {}), modelRefresh: on }
                const r = await saveCfg({ memory })
                toast(r?.ok === false ? (r.message || '没存上') : (on ? '模型整理已开，刷新时会调用后台模型' : '模型整理已关，回到纯机械投影'))
              },
            }),
            '用模型整理语言（默认关；开着刷新会调用后台模型，仅写入快照、不进日记）'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
            h('button', { type: 'button', className: 'roost-btn', disabled: mindBusy, onClick: () => doMindRefresh({ dry: true }) }, '预览刷新'),
            h('button', { type: 'button', className: 'roost-btn', disabled: mindBusy, onClick: () => doMindRefresh({}) }, '刷新快照'),
            h('button', { type: 'button', className: 'roost-btn', disabled: mindBusy, onClick: loadMindSnapshot }, '看快照'),
            h('button', { type: 'button', className: 'roost-btn', disabled: mindBusy, onClick: doMindClear }, '清空快照'),
          ),
          mindErr ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } }, mindErr) : null,
          mindSnap
            ? h('div', {},
                h('div', { className: 'roost-muted', style: { fontSize: 11, marginBottom: 4 } },
                  `落盘快照 · ${new Date(mindSnap.at || 0).toLocaleString('zh-CN')} · ${mindSnap.mode}`
                  + (mindSnap.history?.length ? ` · 历史 ${mindSnap.history.length} 份` : '')),
                h('pre', { className: 'roost-pre', style: { maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' } },
                  mindSnap.markdown || '（空）'),
              )
            : h('div', { className: 'roost-muted', style: { fontSize: 11, marginBottom: 6 } }, '还没有落盘快照'),
          mindPrev
            ? h('details', { style: { marginTop: 8 } },
                h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
                  `当前投影 · ${mindPrev.total} 条 / ${mindPrev.groups} 组 / ${mindPrev.staleCount} 条待核实`),
                h('pre', { className: 'roost-pre', style: { maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: 6 } },
                  mindPrev.markdown || '（空）'),
              )
            : null,
        ),

        h(Sec, { title: '记忆星图' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '把事实、日记、人物与关系画成一片星空，可切 2D / 3D，点星能看详情和编辑。',
            '点下面的按钮才打开 —— 没打开时这里不渲染画布，也不跑动画。'),
          h('button', {
            /** 次要按钮：上次「保存选择」那块黑主按钮被说突兀，入口统一用这个 */
            type: 'button', className: 'roost-btn', onClick: () => setStarOpen(true),
          }, '打开记忆星图'),
          h('span', { className: 'roost-muted', style: { fontSize: 11.5, marginLeft: 10 } },
            `跨群 ${(mem?.global || []).length} 条 · 本会话 ${(mem?.chat || []).length} 条`),
        ),
        starOpen
          ? h(PageModal, { title: '记忆星图', onClose: () => setStarOpen(false) },
              h(StarMap, { mem, toast, reload, quick, busy }))
          : null,

        /**
         * 分层记忆与遗忘（对齐 aurabot 记忆页的「分层记忆与遗忘」）。
         * 规则写在上面，数字直接从 /memory 快照算，不新开接口。
         */
        h(Sec, { title: '分层与遗忘', defaultOpen: false },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '临时：15 天减半；长期：30 天；永久：不衰减。满 40 条时按「权重 × 时间」淘汰；',
            '归档/被取代的不参与注入，但留在库里可恢复。复习会把衰减起点拉回来。'),
          (() => {
            const all = [...(mem?.factsDetail?.global || []), ...(mem?.factsDetail?.chat || [])]
            const count = (pred) => all.filter(pred).length
            const dim = count((f) => Number(f.brightness) > 0 && Number(f.brightness) < 0.35)
            const rows = [
              ['共', all.length],
              ['临时', count((f) => f.tier === 'short')],
              ['长期', count((f) => !f.tier || f.tier === 'long')],
              ['永久', count((f) => f.tier === 'core')],
              ['已归档/被取代', count((f) => f.until || f.archivedAt)],
              ['快忘了', dim],
            ]
            return h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 } },
              rows.map(([k, v]) => h('span', { key: k },
                h('span', { className: 'roost-muted' }, k + ' '),
                h('b', null, String(v)))))
          })(),
          /**
           * 记忆库容量（对齐 aurabot「记忆库」的容量分配）。
           * 默认总数 40 与升级前写死的值一致；每层配额 0 = 不限。
           */
          (() => {
            const cur = config?.memory?.capacity || {}
            const d = capEdit || { total: Number(cur.total) || 40, perTier: { ...(cur.perTier || {}) } }
            const setD = (patch) => setCapEdit({ ...d, ...patch })
            const saveCap = async () => {
              const r = await saveCfg({
                memory: {
                  capacity: {
                    total: Math.max(1, Math.floor(Number(d.total) || 40)),
                    perTier: {
                      short: Math.max(0, Math.floor(Number(d.perTier.short) || 0)),
                      long: Math.max(0, Math.floor(Number(d.perTier.long) || 0)),
                      core: Math.max(0, Math.floor(Number(d.perTier.core) || 0)),
                    },
                  },
                },
              })
              toast(r?.ok === false ? (r.message || '没存上') : '容量已保存，下次记新事时生效')
              setCapEdit(null)
            }
            const num = (key, label) => h('label', { key, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              label,
              h('input', {
                className: 'roost-input', type: 'number', min: 0, max: 500,
                style: { width: 68, padding: '2px 6px', fontSize: 12 },
                value: key === 'total' ? d.total : (d.perTier[key] ?? 0),
                onChange: (e) => (key === 'total'
                  ? setD({ total: e.target.value })
                  : setD({ perTier: { ...d.perTier, [key]: e.target.value } })),
              }))
            return h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10, fontSize: 12 } },
              num('total', '总数'),
              num('short', '临时'),
              num('long', '长期'),
              num('core', '永久'),
              h('span', { className: 'roost-muted', style: { fontSize: 11 } }, '每层 0 = 不限；超了先按层裁、再按总数裁'),
              h('button', { type: 'button', className: 'roost-btn', disabled: Boolean(busy) || !saveCfg, onClick: saveCap }, '保存容量'))
          })(),
        ),

        /**
         * 翻一翻：跨「事实 + 日记」的统一搜索列表（对齐 aurabot 记忆页）。
         * 后端 /memory/browse 两边一起读，前端只管展示与行内操作。
         */
        h(Sec, { title: '翻一翻', defaultOpen: false },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '跨「事实 + 日记」一起搜，搜到就能就地改、归档或作废。日记那半边在开了向量（本地或远程）后也走语义，' +
            '像「最近睡不好」能带出「经常熬夜」；事实那半边仍是关键词匹配。'),
          h('div', { style: { display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' } },
            h('input', {
              className: 'roost-input',
              style: { flex: '1 1 200px', padding: '4px 10px', fontSize: 12 },
              placeholder: '搜一条记忆…（回车搜索）',
              value: browseQ,
              onChange: (e) => setBrowseQ(e.target.value),
              /** 判忙：连按回车会打出多个请求，先回来的那个会把 busy 提前复位 */
              onKeyDown: (e) => { if (e.key === 'Enter' && !browseBusy) loadBrowse() },
            }),
            h('button', { type: 'button', className: 'roost-btn', disabled: browseBusy, onClick: () => { if (!browseBusy) loadBrowse() } },
              browseBusy ? '翻…' : '搜索'),
          ),
          !browse
            ? h('div', { className: 'roost-muted', style: { fontSize: 11.5 } }, '点「搜索」或回车开始；不填关键词就是最近 20 条。')
            : browse.items.length === 0
              ? h('div', { className: 'roost-empty' }, '没搜到')
              : h('div', null,
                  h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginBottom: 4 } }, `共 ${browse.total} 条`),
                  browse.items.map((it) => h('div', {
                    key: it.kind + ':' + it.id,
                    style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderTop: '1px solid var(--line)' },
                  },
                    h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: 12.5, lineHeight: 1.5 } },
                      browseEdit && browseEdit.id === it.id
                        ? h('input', {
                            className: 'roost-input',
                            style: { width: '100%', padding: '2px 8px', fontSize: 12 },
                            value: browseEdit.text,
                            onChange: (e) => setBrowseEdit({ ...browseEdit, text: e.target.value }),
                          })
                        : it.text,
                      h('div', { className: 'roost-muted', style: { fontSize: 10.5, marginTop: 2 } },
                        (it.kind === 'fact' ? (it.scope === 'chat' ? '本会话' : '跨群') : '日记')
                        + (it.kind === 'fact' ? ' · ' + ({ short: '临时', long: '长期', core: '永久' }[it.tier] || '长期') : '')
                        + (it.archived ? ' · 已失效' : '')
                        + (it.at ? ' · ' + new Date(it.at).toLocaleDateString('zh-CN') : '')),
                    ),
                    h('div', { style: { display: 'flex', gap: 4, flexShrink: 0 } },
                      browseEdit && browseEdit.id === it.id
                        ? [
                            h('button', {
                              key: 'save', type: 'button', className: 'roost-btn', disabled: browseBusy,
                              onClick: async () => {
                                const r = await post('/memory/fact', {
                                  action: 'update', id: it.id, scope: it.scope,
                                  chatId: mem?.chatId || '', text: browseEdit.text,
                                })
                                toast(r?.ok === false ? (r.message || '没改上') : '改了')
                                if (r?.ok) { setBrowseEdit(null); loadBrowse(); if (reload) reload() }
                              },
                            }, '存'),
                            h('button', { key: 'cancel', type: 'button', className: 'roost-btn', onClick: () => setBrowseEdit(null) }, '消'),
                          ]
                        : [
                            it.kind === 'fact'
                              ? h('button', {
                                  key: 'edit', type: 'button', className: 'roost-btn',
                                  onClick: () => setBrowseEdit({ id: it.id, text: it.text }),
                                }, '改')
                              : null,
                            h('button', {
                              key: 'del', type: 'button', className: 'roost-btn', disabled: browseBusy,
                              onClick: async () => {
                                const r = it.kind === 'fact'
                                  ? await post('/memory/fact', { action: 'archive', id: it.id, scope: it.scope, chatId: mem?.chatId || '' })
                                  : await post('/memory/node', { kind: 'episode', id: it.id, chatId: mem?.chatId || '' })
                                toast(r?.ok === false ? (r.message || '没删成') : (it.kind === 'fact' ? '已归档（可在星图恢复）' : '已作废'))
                                if (r?.ok) { loadBrowse(); if (reload) reload() }
                              },
                            }, it.kind === 'fact' ? '归档' : '作废'),
                          ],
                    ),
                  )),
                  browse.hasMore
                    ? h('button', { type: 'button', className: 'roost-btn', disabled: browseBusy, onClick: () => loadBrowse({ append: true }) },
                        browseBusy ? '翻…' : '加载更多')
                    : null,
                ),
        ),

        /* ── 第一层：事实 ── */
        h(Sec, { n: '01', title: '事实', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '跨群的事实她带去任何会话；本会话特有的只在这个会话提。串场就是从这条线漏出去的，所以要分开看。'
            + '后面那个 ×N 是权重：越常被提到越高，40 天没提会掉到 1；满 40 条时按「权重 × 时间」淘汰。'),
          /**
           * 出处自检。一个数字，但它是唯一能验「回查原文这条链通没通」的东西——
           * `eventIds` 是 ai-chat 下发的，代码里看着对不代表真机上真有值。
           */
          (() => {
            const ev = mem?.evidence
            if (!ev || ev.error || !ev.rows) return null
            return h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 8 } },
              ev.withIds
                ? `出处：最近 ${ev.rows} 条日记里 ${ev.withIds} 条带着事件 id，能回查到原文。`
                : `出处：最近 ${ev.rows} 条日记里一条事件 id 都没有 —— 出处只能记到时间（框架没开事件账本，或事件里没带 eventId）。`,
            )
          })(),
          /** A3 标签筛选：逗号分隔=全部命中；大小写不敏感，跟后端 matchTags 同口径 */
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 } },
            h('span', { className: 'roost-muted', style: { fontSize: 12, flexShrink: 0 } }, '按标签筛'),
            h('input', {
              className: 'roost-input', value: tagFilter,
              placeholder: '如 work, 重要（逗号=都要）',
              style: { flex: 1, minWidth: 0 },
              onChange: (e) => setTagFilter(e.target.value),
            }),
            tagFilter ? h('button', { type: 'button', className: 'roost-btn', onClick: () => setTagFilter('') }, '清') : null,
          ),
          h('div', { style: { marginBottom: 10 } },
            h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } }, '通用（跨群）'),
            (mem?.global || []).some((f) => tagHit('global', f))
              ? h('div', { className: 'roost-list' },
                  mem.global.filter((f) => tagHit('global', f)).map((f, i) => factRow('global', f, i)),
                )
              : h('div', { className: 'roost-empty' },
                  tagFilter ? '没有带这些标签的跨群事实' : '还没有跨群记忆'),
          ),

          h('div', { style: { marginBottom: 10 } },
            h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } },
              /**
               * 「本群特有」改成「本会话特有」。
               *
               * 这个会话可能是私聊——说「本群」就不准了。
               * 而且标题区已经把「（群）」「（私聊）」标出来了，这里再写一遍
               * 「群」会和上面的标签打架。
               */
              canChat ? `本会话特有 · ${sceneName}` : '本会话特有（还没有活跃会话，先聊一句才会有）'),
            (mem?.chat || []).some((f) => tagHit('chat', f))
              ? h('div', { className: 'roost-list' },
                  mem.chat.filter((f) => tagHit('chat', f)).map((f, i) => factRow('chat', f, i)),
                )
              : h('div', { className: 'roost-empty' },
                  tagFilter ? '没有带这些标签的本会话事实' : (canChat ? '这个群还没特有记忆' : '—')),
          ),

          /**
           * 历史：被后来的说法取代的条目。
           *
           * 默认折叠 —— 它们是噪声，不该跟「她现在记得的事」抢位置；
           * 但必须能查到、能删掉，否则就成了占着名额的隐形条目。
           */
          historyRows.length
            ? h('details', { style: { marginBottom: 10 } },
                h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
                  `历史 · ${historyRows.length} 条被后来的说法取代（不注入）`),
                h('div', { className: 'roost-list', style: { marginTop: 6 } },
                  historyRows.slice(0, 20).map((x, i) =>
                    h('div', { key: i, className: 'roost-item' },
                      h('span', {
                        className: 't',
                        style: { opacity: 0.6, textDecoration: 'line-through' },
                      }, x.text),
                      h('span', { className: 'roost-muted', style: { fontSize: 11, flexShrink: 0 } },
                        `${x.label} · ${ago(x.until)}起不再用`),
                      h(ConfirmLink, {
                        label: '删', confirmLabel: '确认删除',
                        onConfirm: async () => {
                          const r = await quick('memory.remove', x.text)
                          toast(r.message || '删了')
                          reload()
                        },
                      }),
                    ),
                  ),
                ),
              )
            : null,

          h('div', { style: { display: 'flex', gap: 8, marginTop: 4 } },
            h('input', {
              className: 'roost-input', placeholder: '手动记一条（关于他/她的事实）', value: fact,
              onChange: (e) => setFact(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doAdd() },
              style: { flex: 1 },
            }),
            h('select', {
              className: 'roost-input', value: scope, onChange: (e) => setScope(e.target.value),
              style: { width: 92, flex: '0 0 92px' },
            },
              h('option', { value: 'global' }, '跨群'),
              h('option', { value: 'chat', disabled: !canChat }, '本会话'),
            ),
            h('button', { type: 'button', className: 'roost-primary', onClick: doAdd }, '记下'),
          ),
        ),

        /* ── 第二层：日记 ── */
        h(Sec, { n: '02', title: '日记', defaultOpen: false },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            jr?.stats
              ? `共 ${jr.stats.total} 条 · 非常重要 ${jr.stats.critical} · 重要 ${jr.stats.important} · 普通 ${jr.stats.normal} · 已压缩 ${jr.stats.compressed}`
              : '读不到日记',
            jr?.backend ? `（存储：${jr.backend}）` : '',
          ),

          h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
            h('input', {
              className: 'roost-input', placeholder: '搜一句（如「杭州」「电影」）', value: q,
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') doSearch() },
              style: { flex: 1 },
            }),
            h('button', { type: 'button', className: 'roost-btn', onClick: doSearch }, '搜'),
          ),

          hits
            ? h('div', null,
                h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } },
                  hits.length ? `搜到 ${hits.length} 条` : '没搜到。可以换个说法，她平时检索也是这么试的。'),
                h('div', { className: 'roost-list roost-scroll' },
                  hits.map((r) =>
                    h('div', { key: r.id, className: 'roost-item' },
                      h('span', { className: 't' },
                        h('span', { className: 'd' }, dayOf(r.at) + ' '),
                        r.text,
                        r.why ? h('span', { className: 'd' }, ' · ' + r.why) : null,
                      ),
                      h(ConfirmLink, {
                        label: '忘', confirmLabel: '确认忘掉这一条',
                        onConfirm: async () => {
                          /**
                           * **按 id 删，不拿正文当关键词。**
                           *
                           * 以前这里是 `r.text.slice(0, 12)` 再交给服务端做关键词匹配，
                           * 而匹配走的是检索的覆盖率阈值（34% 就算命中）——
                           * 点「生日是三月五号」那条，会把「生日是三月六号」一起抹掉。
                           * 顺手把 chatId 也带上：不带的话服务端会退回「最近说话的会话」，
                           * 在别的会话里翻日记时会删到另一个群。
                           */
                          const res = await post('/journal', { id: r.id, chatId: mem?.chatId || '' })
                          toast(res.message || '忘掉了')
                          doSearch()
                          reload()
                        },
                      }),
                    ),
                  ),
                ),
              )
            : null,

          (jr?.digests || []).length
            ? h('div', { style: { marginTop: 12 } },
                h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } }, '每天的摘要（巩固产出）'),
                h('div', { className: 'roost-list' },
                  jr.digests.map((d, i) =>
                    h('div', { key: i, className: 'roost-item' },
                      h('span', { className: 't' }, d.text),
                      h('span', { className: 'd' }, d.day || dayOf(d.at)),
                    ),
                  ),
                ),
              )
            : null,

          (jr?.top || []).length
            ? h('div', { style: { marginTop: 12 } },
                h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } },
                  '记得最深的（重要性 × 时间衰减 + 被搜到的次数）'),
                h('div', { className: 'roost-list' },
                  jr.top.map((r) =>
                    h('div', { key: r.id, className: 'roost-item' },
                      h('span', { className: 't' }, r.text),
                      h('span', { className: 'd' }, `${r.level} · ${dayOf(r.at)}`),
                    ),
                  ),
                ),
              )
            : null,

          h('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: async () => {
                const r = await post('/consolidate', {})
                toast(r.ok ? `巩固完成：压缩 ${r.compressed} 条、三元组 ${r.triples} 个、撤销 ${r.revoked || 0} 条` : (r.reason || r.message || '没跑成'))
                reload()
              },
            }, '手动跑一次巩固'),
            h('div', { className: 'roost-note', style: { margin: 0, alignSelf: 'center' } },
              '平时每天凌晨自动跑（错过会补）'),
          ),
        ),

        /* ── 第三层：图谱 ── */
        h(Sec, { n: '03', title: '她知道的关系', defaultOpen: false },
          gp?.stats?.enabled === false
            ? h('div', { className: 'roost-empty' }, '图谱没启用（当前 Node 没有 node:sqlite）')
            : h('div', null,
                gp?.stats
                  ? h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 6 } },
                      `${gp.stats.entities} 个实体 · ${gp.stats.edges} 条现在成立 · ${gp.stats.ended || 0} 条已结束 · ${gp.stats.episodes} 段原始记录`)
                  : null,
                (gp?.edges || []).length
                  ? h('div', { className: 'roost-list' },
                      gp.edges.map((e) => [
                        /**
                         * 每条关系返回**两个元素**（行 + 可选的确认块），
                         * 而不是包一层 div。
                         *
                         * 包一层会破坏 `.roost-list > .roost-item` 的相邻关系：
                         * 每个 item 都成了自己容器里的 `:first-child`，
                         * `border-top: none` 全部命中，行与行之间的分隔线消失。
                         * React 会摊平嵌套数组，所以直接返回数组最省事。
                         */
                        h('div', { key: e.id, className: 'roost-item' },
                          h('span', { className: 't' }, `${e.src} —${e.rel}→ ${e.dst}`),
                          h('span', { className: 'd', style: { display: 'flex', alignItems: 'center', gap: 8 } },
                            dayOf(e.from),
                            h('button', {
                              type: 'button',
                              className: 'roost-btn',
                              title: '删掉这条关系',
                              onClick: () => setDelEdge(delEdge?.id === e.id ? null : e),
                            }, '删'),
                          ),
                        ),
                        delEdge?.id === e.id
                          ? h('div', { key: `${e.id}-confirm` }, edgeConfirm(e))
                          : null,
                      ]),
                    )
                  : h('div', { className: 'roost-empty' }, '还没有关系。聊得多了巩固时会自己抽出来。'),

                (gp?.suppressed || []).length
                  ? h('details', { style: { marginTop: 10 } },
                      h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
                        `删过的，不会再记（${gp.suppressed.length}）`),
                      h('div', { className: 'roost-list', style: { marginTop: 6 } },
                        gp.suppressed.slice(0, 12).map((s) =>
                          h('div', { key: s.id, className: 'roost-item' },
                            h('span', { className: 't' }, `${s.src} —${s.rel}→ ${s.dst}`),
                            h('span', { className: 'd', style: { display: 'flex', alignItems: 'center', gap: 8 } },
                              s.chatId ? '只在这个会话' : '所有会话',
                              h('button', {
                                type: 'button', className: 'roost-btn', disabled: busy,
                                title: '撤销之后，下次巩固会重新记这条',
                                onClick: async () => {
                                  const r = await quick('graph.unsuppress', { id: s.id })
                                  toast(r.message || (r.ok === false ? '没撤掉' : '撤销了'))
                                  reload()
                                },
                              }, '撤销'),
                            ),
                          ),
                        ),
                      ),
                    )
                  : null,
                (gp?.ended || []).length
                  ? h('details', { style: { marginTop: 10 } },
                      h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
                        `以前成立、现在不成立的（${gp.ended.length}）`),
                      h('div', { className: 'roost-list', style: { marginTop: 6 } },
                        gp.ended.slice(0, 12).map((e) =>
                          h('div', { key: e.id, className: 'roost-item' },
                            h('span', { className: 't' }, `${e.src} —${e.rel}→ ${e.dst}`),
                            h('span', { className: 'd' }, `${dayOf(e.from)} → ${dayOf(e.to)}`),
                          ),
                        ),
                      ),
                    )
                  : null,
                h('div', { className: 'roost-note' },
                  '「现在成立」和「以前成立」分开存：她说“我搬到上海了”，杭州那条不会被删，只标上结束时间。'),
              ),
        ),

        /**
         * 一次性迁移：记忆以前放在 ai-chat 的 storage 里，4.0 之后搬到这里。
         *
         * 原来它塞在「清空与迁移」那节里，跟「清空本群记忆」这种不可逆的
         * 危险操作摆在一起——一个是加法一个是减法，混在一处容易误点。
         * 现在单开一节放在危险区之前，并且默认折叠。
         */
        h(Sec, { n: '04', title: '从旧版导入' },
          h('details', null,
            h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
              '只有从 ai-chat 4.0 之前升级上来的才用得上'),
            h('div', { style: { marginTop: 8 } },
              h('div', { className: 'roost-note', style: { marginBottom: 8 } },
                '记忆以前存在 ai-chat 的 storage 里。这条会把那份搬过来，重复点不会重复导。'),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: async () => {
                  const r = await post('/memory/import', {})
                  toast(r.ok === false ? (r.message || '没导成') : `导进来 ${r.imported ?? 0} 条`)
                  reload()
                },
              }, '导入旧版记忆'),
            ),
          ),
        ),

        /**
         * 2.7：下面这三块（熟人档案 / 经历 / 备份）没有编号、也不是 Sec，
         * 夹在「04 从旧版导入」和「05 召回记录」之间，看着像页面少渲染了一截。
         * 现在收进**一行折叠入口**，2.3 的「人物」「备份」页是正门。
         *
         * 内容一块不删：details 的 children 照常渲染（和 Sec 的折叠一样，
         * 只由浏览器收起），清单、按钮、清空操作、折叠状态全都在，
         * 「只增不减」的控件计数也不变。
         */
        h('details', null,
          h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
            '熟人档案 / 经历 / 备份已经搬到「人物」「备份」页，这里仍保留原样（点开查看）'),
          h('div', { className: 'roost-note', style: { margin: '8px 0' } },
            '并列入口，不是搬家：两页看的是同一份数据，任一边改了都刷新同一处。',
            h('button', {
              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
              onClick: () => { if (setTab) setTab('people') },
            }, '去人物页'),
            h('button', {
              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
              onClick: () => { if (setTab) setTab('backup') },
            }, '去备份页'),
          ),

        /* D7 人物小档案：只读 + 独立清空。跨群档案，不随「清空本会话记忆」抹掉 */
        h('div', { className: 'cap-group' },
          h('div', { className: 'cap-group-t' }, '熟人小档案'),
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '每天凌晨从聊天里攒一小段印象和相处建议，跨群共用；同一天里不改提示词。开关关着也能在这儿查看和清空已有的。'),
          (mem?.profiles || []).length
            ? h('div', { style: { display: 'grid', gap: 4, marginBottom: 8 } },
                (mem.profiles || []).map((p, i) => h('div', { key: i, className: 'roost-note' },
                  '· ' + p.name + '：' + (p.impression || '') + (p.tips ? `（相处：${p.tips}）` : '') + (p.dislikes ? `（别踩：${p.dislikes}）` : ''))))
            : h('div', { className: 'roost-note', style: { marginBottom: 8 } }, '还没写过人物档案。'),
          h(ConfirmLink, {
            label: '清空人物档案', confirmLabel: '确认清空档案',
            onConfirm: async () => {
              const r = await quick('profiles.clear')
              toast(r.message || '清了')
              reload()
            },
          }),
        ),

        /* D8 经历层：只读 + 独立清空。放在危险区之前，别让「查看」混进不可逆操作 */
        h('div', { className: 'cap-group' },
          h('div', { className: 'cap-group-t' }, '她最近做过的事（24 小时）'),
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '只记动作、不记说过的话；过期自动删。开关关着也能在这儿查看和清空已有的。'),
          (mem?.events || []).length
            ? h('div', { style: { display: 'grid', gap: 4, marginBottom: 8 } },
                (mem.events || []).map((e, i) => h('div', { key: i, className: 'roost-note' },
                  '· ' + new Date(e.at).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  }) + ' ' + e.where + ' ' + e.label + (e.count > 1 ? `（${e.count} 次）` : ''))))
            : h('div', { className: 'roost-note', style: { marginBottom: 8 } }, '最近没记下什么。'),
          h(ConfirmLink, {
            label: '清空这些经历', confirmLabel: '确认清空经历',
            onConfirm: async () => {
              const r = await quick('events.clear')
              toast(r.message || '清了')
              reload()
            },
          }),
        ),

        /* E4 备份：导出 + 只读清单 + 行级还原。放在危险区之前，别跟不可逆操作混在一起 */
        h('div', { className: 'cap-group' },
          h('div', { className: 'cap-group-t' }, '备份与恢复'),
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '导出会打包配置、记忆、日记、图谱、人格等；SQLite 用一致性快照，运行中导出也安全。'
            + '⚠ 包里含 config.json（里面有密钥），别外传。'
            + '导入/整包恢复在「备份」页第 01 节：只用 .restore/ 暂存，**下次启动 DSH 才生效**，'
            + '所以这里不放第二颗按钮（两处入口走出两条逻辑）。'),
          mem?.restorePending
            ? h('div', { className: 'roost-note', style: { marginBottom: 8 } },
                `有一份整包恢复等着下次启动生效（${mem.restorePending.files} 个文件，${mem.restorePending.createdAt || ''}）。`,
                h('button', {
                  type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
                  onClick: async () => {
                    const r = await quick('backup.cancelRestore')
                    toast(r.message || '已取消')
                    reload()
                  },
                }, '取消这次恢复'))
            : null,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
            h('button', {
              type: 'button', className: 'roost-primary',
              /** 和备份页共用一份，别让两处按钮走出两条逻辑 */
              onClick: () => downloadBackupZip(toast, reload),
            }, '导出备份（zip）'),
          ),
          (mem?.backups || []).length
            ? h('div', { style: { display: 'grid', gap: 4 } },
                (mem.backups || []).slice(0, 8).map((b, i) => h('div', {
                  key: i, className: 'roost-note',
                  style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: 0 },
                },
                  '· ' + new Date(b.at).toLocaleString('zh-CN', {
                    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
                  }) + ' ' + b.label + ' · ' + (b.bytes / 1024).toFixed(1) + ' KB',
                  b.kind === 'retention'
                    ? h(ConfirmLink, {
                        label: '还原这一份', confirmLabel: '确认还原这些原文',
                        onConfirm: async () => {
                          const r = await quick('backup.restoreRetention', { name: b.name })
                          toast(r.message || '还原了')
                          reload()
                        },
                      })
                    : null,
                )))
            : h('div', { className: 'roost-note', style: { margin: 0 } }, '还没有备份。'),
        ),
        ),

        /** 3.3/3.4：召回预览 + 参数。检索路径和轮次注入是同一个（host 的 recallFor），
         *  预览不写召回日志、不计 access_count —— 试一下不等于被想起 */
        h(Sec, { n: '05', title: '召回预览与参数' },
          h('div', { className: 'roost-note', style: { marginTop: 0 } },
            '输入一句话，看真实召回会命中什么、为什么命中。这是预演：不计入「被想起」，不影响排序。'),
          /** 3.4 status：对齐对面 vector/status，解决"开关开了没生效却不知道" */
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 } },
            h('button', { type: 'button', className: 'roost-btn', onClick: loadVecStatus }, '看向量/重排状态'),
            vecStatus?.err
              ? h('span', { style: { color: 'var(--bad)', fontSize: 11.5 } }, vecStatus.err)
              : vecStatus
                ? h('span', { className: 'roost-muted', style: { fontSize: 11.5 } },
                    vecStatus.summary
                    + (vecStatus.rerank?.mode !== 'off' ? ` · 重排：${vecStatus.rerank.mode === 'local' ? '本地模型' : '规则'}` : ''),
                    ...(vecStatus.warnings || []).map((w, i) => h('div', { key: i, style: { color: 'var(--warn, #d9a441)', fontSize: 11.5 } }, '⚠ ' + w)))
                : null),
          /**
           * 重排候选（Reranker）：默认关。配了向量就按语义相似度重排，
           * 没配就按「关键词命中 + 新鲜度」确定性重排。开关放这里，
           * 是因为它改的正是「召回顺序」。
           */
          h('label', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 8 },
            title: '关着时召回顺序与升级前完全一致',
          },
            h('input', {
              type: 'checkbox',
              checked: config?.recall?.rerank?.enabled === true,
              disabled: Boolean(busy) || !saveCfg,
              onChange: async (e) => {
                const on = Boolean(e.target.checked)
                const r = await saveCfg({
                  recall: { rerank: { ...(config?.recall?.rerank || {}), enabled: on } },
                })
                toast(r?.ok === false ? (r.message || '没存上') : (on ? '重排已开，下一轮生效' : '重排已关'))
              },
            }),
            '重排候选（默认关：配了向量走向量，否则按关键词 + 新鲜度）'),
          /** 本地 ONNX 开关：模型装好后在这里开，不开就是零影响（默认关） */
          h('label', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 },
            title: '要先在「功能包 → 本地智能」装好 e5-small 模型；装好不开也不影响任何行为',
          },
            h('input', {
              type: 'checkbox',
              checked: config?.memory?.embeddingLocal === true,
              disabled: Boolean(busy) || !saveCfg,
              onChange: async (e) => {
                const on = Boolean(e.target.checked)
                const r = await saveCfg({ memory: { ...(config?.memory || {}), embeddingLocal: on } })
                toast(r?.ok === false ? (r.message || '没存上') : (on ? '本地向量已开，下一轮生效' : '本地向量已关'))
              },
            }),
            '本地向量（装好 e5-small 后开，不用外部 API）'),
          h('label', {
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 },
            title: '要先在「功能包 → 本地智能」装好 hs-rerank-1 模型；优先于向量重排',
          },
            h('input', {
              type: 'checkbox',
              checked: config?.recall?.rerank?.useLocal === true,
              disabled: Boolean(busy) || !saveCfg,
              onChange: async (e) => {
                const on = Boolean(e.target.checked)
                const r = await saveCfg({
                  recall: { rerank: { ...(config?.recall?.rerank || {}), useLocal: on } },
                })
                toast(r?.ok === false ? (r.message || '没存上') : (on ? '本地重排已开，下一轮生效' : '本地重排已关'))
              },
            }),
            '本地重排（装好 hs-rerank-1 后开，比向量准）'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
            h('input', {
              className: 'roost-input', style: { flex: '1 1 260px' },
              placeholder: `比如「上次说的那个约定」${mem?.chatId ? '（在本会话里试）' : ''}`,
              value: pvText, onChange: (e) => setPvText(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') runPreview() },
            }),
            h('button', { type: 'button', className: 'roost-primary', disabled: pvBusy || busy, onClick: runPreview },
              pvBusy ? '检索中…' : '试一句'),
          ),
          pvResult?.err
            ? h('div', { className: 'roost-empty', style: { color: 'var(--bad)', marginTop: 8 } }, pvResult.err)
            : pvResult
              ? h('div', { style: { marginTop: 8 } },
                  pvResult.note ? h('div', { className: 'roost-note' }, pvResult.note) : null,
                  pvResult.temporal
                    ? h('div', { className: 'roost-note' },
                        `时间定位：认出「${pvResult.temporal.label}」`
                        + `（${new Date(pvResult.temporal.from).toLocaleDateString('zh-CN')}`
                        + ` ~ ${new Date(pvResult.temporal.to).toLocaleDateString('zh-CN')}），只在这个范围里找。`)
                    : null,
                  (pvResult.entities || []).length
                    ? h('div', { className: 'roost-note' }, '这一句点到的实体：' + pvResult.entities.join('、'))
                    : null,
                  (pvResult.hits || []).length
                    ? pvResult.hits.map((x, i) => {
                        /** 结构化投影（对齐对面 assoc/preview）：直接 / 经谁联想一跳 */
                        const p = pvResult.projection?.items?.[i]
                        return h('div', { key: x.rank, className: 'roost-item' },
                          h('span', { className: 'd' },
                            `#${x.rank} · ${x.when || '—'} · ${x.level || ''}`
                            + (p?.hop ? ` · ${p.hop} 跳联想（经「${p.via}」）` : p ? ' · 直接命中' : '')),
                          h('span', { className: 't' }, x.text || '—'),
                          h('span', { className: 'd' }, (x.why || '未标原因') + (Number.isFinite(x.score) ? ` · 分 ${x.score.toFixed(4)}` : '')))
                      })
                    : h('div', { className: 'roost-empty' }, '没命中。换个说法再试，或检查下面的参数。'),
                  pvResult.projection?.counts
                    ? h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginTop: 4 } },
                        `直接命中 ${pvResult.projection.counts.direct} 条 · 联想带出 ${pvResult.projection.counts.hop1} 条（我方联想只有一跳）`)
                    : null,
                )
              : null,
          h('div', { className: 'roost-note', style: { marginTop: 12 } },
            '召回参数（默认就是原来的写死值；调坏了点「恢复默认」就回去）：'),
          h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 } },
            rcRow('perPath', '每路取几条', '关键词/向量各取多少条进 RRF 融合'),
            rcRow('entityLimit', '实体上限', '参与联想的实体最多几个'),
            rcRow('linkLimit', '每实体联想几条', '一个实体最多拉几条相关日记'),
            rcRow('residentMax', '平时预算(字)', '非深度重注时的记忆注入上限'),
            rcRow('deepMax', '深度预算(字)', '每 N 轮全量重注的上限'),
            rcRow('dynMax', '易变段预算(字)', '拼在用户消息里的动态段上限'),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: !saveCfg || rcDraft === null,
              onClick: () => {
                const patch = {}
                for (const k of Object.keys(RECALL_DEFAULTS)) {
                  const v = Number(rcVal(k))
                  if (!(v > 0)) return toast('参数得是正数')
                  patch[k] = v
                }
                putRecall(patch)
              },
            }, '保存'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: !saveCfg,
              onClick: () => putRecall({ ...RECALL_DEFAULTS }),
            }, '恢复默认'),
          ),
        ),

        h(Sec, { n: '06', title: '召回记录', defaultOpen: false, right: h('button', {
          type: 'button', className: 'roost-btn', onClick: loadRecall,
        }, '刷新') },
          recallErr
            ? h('div', { className: 'roost-empty', style: { color: 'var(--bad)' } }, recallErr)
            : recallRows === null
              ? h('div', { className: 'roost-empty' }, '读取中…')
              : recallRows.length === 0
                ? h('div', { className: 'roost-empty' }, '还没有召回记录')
                : h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 220 } },
                    recallRows.map((x, i) =>
                      h('div', { key: i, className: 'roost-item' },
                        h('span', { className: 'd' }, x.at ? ago(x.at) : (x.time || '')),
                        h('span', { className: 't' }, `命中 ${x.shown ?? 0} 条 · ${x.chatId || '—'}`),
                        h('span', { className: 'd' },
                          ` 查询 ${x.queryLen ?? 0} 字${x.shortPhrase ? ' · 短句' : ''}${x.usedPrev ? ' · 沿用上轮' : ''}`),
                      ))),
        ),

        /* 危险区放最后 */
        h(Sec, { n: '07', title: '清空' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '「清空」抹掉事实和日记正文，行还留着（时间线不断）；'
            + '「彻底删除」连行一起删，磁盘上的旧页十分钟内自动压掉。两者都不可恢复。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(ConfirmLink, {
              label: '清空本会话记忆', confirmLabel: '确认清空本会话',
              onConfirm: async () => {
                const r = await quick('memory.clear')
                // §5.6：扩展记忆不属会话，默认不动 —— 必须当场说清楚，否则用户以为一起清了。
                toast([r.message || '清了', r.extMemory?.message].filter(Boolean).join('。'))
                reload()
              },
            }),
            /**
             * 第二档：**连行一起删**。
             *
             * 和「清空」的区别是时间线：清空之后库里还留着「这天有过东西」，
             * 彻底删除之后什么都没有了。用户要「这些记录不许存在」时用这个。
             * 确认文案要写明差别，否则两个按钮看起来一样、点错不可逆。
             */
            h(ConfirmLink, {
              label: '彻底删除本会话', confirmLabel: '确认彻底删除（行也不留）',
              onConfirm: async () => {
                const r = await quick('memory.purge')
                toast([r.message || '删了', r.extMemory?.message].filter(Boolean).join('。'))
                reload()
              },
            }),
            h(ConfirmLink, {
              label: '清空跨群记忆', confirmLabel: '确认清空跨群',
              onConfirm: async () => {
                const r = await quick('memory.clearGlobal')
                toast([r.message || '清了', r.extMemory?.message].filter(Boolean).join('。'))
                reload()
              },
            }),
            /**
             * 自述不跟上面三个走：它是跨群汇总的一份，
             * 按会话清既清不干净又会误伤别的群，所以单独一个按钮。
             */
            h(ConfirmLink, {
              label: '重置自我叙述', confirmLabel: '确认重置（她的自述全部清掉）',
              onConfirm: async () => {
                const r = await quick('self.clear')
                toast(r.message || '重置了')
                reload()
              },
            }),
          ),
        ),
      )

      function doAdd() {
        const text = fact.trim()
        if (!text) return
        /**
         * 没有会话时选「本群」= 写进空 chatId 那层。
         * 后端 `memory.add` 拿不到 chatId 会返回 false，但接口照样回 ok，
         * 于是界面提示「记下了」、实际什么都没存（0.8.1 修过同一个坑）。
         * 这里先拦住，并且说清该记到哪。
         */
        if (scope === 'chat' && !canChat) {
          toast('还没有会话进来，先记到「跨群」')
          return
        }
        const body = { fact: text, scope }
        if (scope === 'chat') body.chatId = mem.chatId
        post('/memory/add', body).then((r) => {
          toast(r.ok === false ? (r.message || '没记上') : scope === 'chat' ? '记进这个会话了' : '记进跨群了')
          if (r.ok !== false) { setFact(''); reload() }
        })
      }
    }

    /* ---------------- 人物 / 备份（2.3） ---------------- */

    /**
     * 导出整包：记忆页与备份页共用一份，别让两处按钮走出两条逻辑。
     * 浏览器只能靠 <a download> 落盘；失败要说清原因，
     * 不能静默吞掉再弹「备份已导出」。
     */
    const downloadBackupZip = async (toast, reload) => {
      try {
        const res = await fetch(API + '/backup/export')
        if (!res.ok) throw new Error('HTTP ' + res.status)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'dsh-roost-backup.zip'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => { try { URL.revokeObjectURL(url) } catch {} }, 1000)
        toast('备份已导出')
        if (reload) reload()
      } catch (e) {
        toast('导出失败：' + e.message)
      }
    }

    /**
     * 人物页：记忆页里那三块（熟人档案 / 关系 / 经历）原先夹在
     * 「04 从旧版导入」和「05 召回记录」中间，既没编号也不是 Sec，
     * 一屏看过去像页面少渲染了一截。现在给它们一个正门。
     *
     * **记忆页那三块原地保留**（2.3 是并列入口，不是搬家）。
     * 数据仍是同一份 /memory 快照，不新开接口、不复制状态：
     * 两页看到的是同一批 profiles / graph / events，任一边改了都刷新同一处。
     *
     * 关系这里只做**只读概览**。删关系 / 撤销屏蔽 / 标结束仍在记忆页——
     * 同一个写操作摆两个地方，用户得先判断在哪页动手才算数（§0.5 A10 的教训）。
     */
    /* ---------------- 记忆星图（2D / 3D） ---------------- */

    /**
     * 2026-11-13：关系图不再单独做，全部并进这一张记忆星图。
     *
     * 参照 aurabot-beta `client.js:5137 smDraw` 的 3D 透视投影
     * （yaw/pitch 旋转 → 透视除法 → depth 裁剪 → 近大远小），
     * 但**数据全用我们 `/memory` 快照里真实有的字段**：
     *
     *   · 跨群事实 / 本会话事实 / 已被取代的事实（factsDetail）
     *   · 重要日记片段（journal.top）
     *   · 人物与实体（graph.entities）+ 关系连线（graph.edges）
     *   · 熟人档案（profiles）
     *
     * 不造 aurabot 那套 tier / cluster / importance / brightness 字段——
     * 我们没有层级、没有手动重要度，凭空生成就是"面板在撒谎"。
     * 亮度只由**真实存在的**权重 × 时间衰减算出来（和 memory.js 的
     * `scoreOfFact` 同一条公式：w × 0.5^(age/40天)），位置按上面六种
     * 真实来源分星团。
     *
     * 2D / 3D 是同一批星、同一份筛选，只是投影函数不同：
     *   · 3D：透视 + 自动旋转 + 拖拽转视角 + 景深（功能完整版）
     *   · 2D：正交 + 拖拽平移 + 标签避让（轻量版，低配机器也不卡）
     * 自动旋转、景深、星团光环这些**只在 3D 有意义**的开关，就在 2D
     * 下禁用并写明原因，不做个假动画糊弄。
     */
    const STAR_GROUPS = [
      { id: 'global', label: '跨群事实', color: '#7fd1ff' },
      { id: 'chat', label: '本会话', color: '#9d8bff' },
      { id: 'entity', label: '人物与实体', color: '#5ce1b0' },
      { id: 'episode', label: '重要片段', color: '#ffc46b' },
      { id: 'profile', label: '熟人档案', color: '#ff8fb1' },
      { id: 'history', label: '已被取代', color: '#8a93a8' },
    ]
    const STAR_DAY = 86_400_000
    const STAR_HALF_LIFE = 40
    const STAR_R = 240

    /** 和 src/memory.js:64 scoreOfFact 同一条公式；前端只用来画亮度，不参与淘汰 */
    function starScoreOf({ w = 1, at = 0, until = 0, score } = {}, now = Date.now()) {
      if (Number.isFinite(score)) return Math.max(0.01, Number(score))
      const days = at ? Math.max(0, (now - at) / STAR_DAY) : 0
      const base = (Number(w) > 0 ? Number(w) : 1) * 0.5 ** (days / STAR_HALF_LIFE)
      return until ? base * 0.35 : base
    }

    /**
     * `/memory` 快照 → 星图数据（纯函数，导出给测试）。
     *
     * 坐标是确定性的：星团中心按圆周均布，团内用黄金角球面撒点，
     * 不用 Math.random —— 同一份数据每次画出同一片星空。
     */
    function buildStarMap(mem, { now = Date.now(), radius = STAR_R } = {}) {
      const raw = []
      const push = (o) => { if (o && String(o.text || '').trim()) raw.push(o) }
      const factsOf = (scope) => (Array.isArray(mem?.factsDetail?.[scope]) ? mem.factsDetail[scope] : [])
      for (const [scope, group] of [['global', 'global'], ['chat', 'chat']]) {
        factsOf(scope).forEach((f, i) => {
          /** 被取代（until）和主动归档（archivedAt）都算「已被取代」那一团 */
          const archived = Number(f.until) > 0 || Number(f.archivedAt) > 0;
          push({
            id: `${group}:${i}`,
            factId: String(f.id || ''),
            scope,
            text: String(f.text || ''),
            group: archived ? 'history' : group,
            w: Number(f.w) || 1,
            at: Number(f.at) || 0,
            until: Number(f.until) || 0,
            src: f.src || null,
            kind: 'fact',
            /** 数据扩展后的真实字段；老库没有就给默认 */
            tier: String(f.tier || 'long'),
            pin: Number(f.pin) || 0,
            archivedAt: Number(f.archivedAt) || 0,
            reviewedAt: Number(f.reviewedAt) || 0,
            /** 证据演化（阶段1 算好的）：星点详情里展示趋势与出处，别让它在 UI 层丢掉 */
            trend: String(f.trend || ''),
            confidence: Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : 1,
            evidence: Array.isArray(f.evidence) ? f.evidence : [],
            /** 亮度直接用后端算好的（w×30 天半衰期 + pin + 复习 + 层级），不再前端另算一套 */
            trueBrightness: Number(f.brightness) > 0 ? Number(f.brightness) : 0,
          });
        })
      }
      for (const [i, t] of (Array.isArray(mem?.journal?.top) ? mem.journal.top : []).entries()) {
        push({
          id: `episode:${i}`,
          /** 日记行 id：详情里「作废这条」要用它 */
          journalId: String(t.id || ''),
          text: String(t.text || ''),
          group: 'episode',
          w: 1,
          at: Number(t.at) || 0,
          score: Number(t.score) || 0,
          accessed: Number(t.accessed) || 0,
          kind: 'episode',
        })
      }
      for (const [i, e] of (Array.isArray(mem?.graph?.entities) ? mem.graph.entities : []).entries()) {
        push({
          id: `entity:${i}`,
          entityId: Number(e.id) || 0,
          text: String(e.name || ''),
          group: 'entity',
          w: 1,
          at: Number(e.lastSeen) || 0,
          kind: 'entity',
          /** 关系连线要用名字找星，见下面的 links */
          name: String(e.name || ''),
        })
      }
      for (const [i, p] of (Array.isArray(mem?.profiles) ? mem.profiles : []).entries()) {
        push({
          id: `profile:${i}`,
          /** 档案的 key：详情里「忘掉这个人」要用它 */
          profileKey: String(p.key || ''),
          text: `${String(p.name || '某个人')}${p.impression ? '：' + String(p.impression).slice(0, 40) : ''}`,
          group: 'profile',
          w: 1,
          at: Number(p.at) || 0,
          kind: 'profile',
        })
      }

      /** 亮度：按本组最大值归一化，别让「重要片段」的 score 把事实全压暗 */
      const scored = raw.map((s) => ({ ...s, score: s.trueBrightness > 0 ? s.trueBrightness : starScoreOf(s, now) }))
      const maxOf = {}
      for (const s of scored) maxOf[s.group] = Math.max(maxOf[s.group] || 0.01, s.score)
      scored.forEach((s) => {
        /** 事实有后端算好的真实亮度，别再按组内最大值归一化（那会把它压成相对值） */
        s.brightness = s.trueBrightness > 0
          ? Math.max(0.14, Math.min(1, s.trueBrightness))
          : Math.max(0.14, Math.min(1, s.score / maxOf[s.group]))
      })

      /** 星团中心：圆周均布，稍微错开高度，3D 转起来才看得出是分层的 */
      const byGroup = new Map()
      for (const g of STAR_GROUPS) byGroup.set(g.id, [])
      for (const s of scored) byGroup.get(s.group)?.push(s)
      const used = STAR_GROUPS.filter((g) => byGroup.get(g.id).length)
      const GA = Math.PI * (3 - Math.sqrt(5))
      const stars = []
      used.forEach((g, gi) => {
        const a = (gi / used.length) * Math.PI * 2
        /** X/Z 摊得开、Y 压得扁：画布是宽屏（1000×420），纵向撑满会裁掉星星 */
        const cx = Math.cos(a) * radius * 0.8
        const cz = Math.sin(a) * radius * 0.8
        const cy = (gi % 2 ? 1 : -1) * radius * 0.12
        const arr = byGroup.get(g.id)
        arr.forEach((s, j) => {
          const phi = Math.acos(1 - 2 * (j + 0.5) / arr.length)
          const th = GA * j
          const r = radius * (0.18 + 0.22 * Math.sqrt((j + 1) / arr.length))
          stars.push({
            ...s,
            groupLabel: g.label,
            color: g.color,
            x: cx + r * Math.sin(phi) * Math.cos(th),
            y: cy + r * Math.cos(phi) * 0.55,
            z: cz + r * Math.sin(phi) * Math.sin(th),
            /** 归档的不参与注入，画成暗星 */
            archived: s.group === 'history',
          })
        })
      })

      /** 关系连线并入星图：端点按实体名找，找不到就不画（不造假节点） */
      const atName = new Map(stars.filter((s) => s.kind === 'entity').map((s) => [s.name, s.id]))
      const links = (Array.isArray(mem?.graph?.edges) ? mem.graph.edges : [])
        .map((e) => ({ a: atName.get(String(e.src || '')), b: atName.get(String(e.dst || '')), rel: String(e.rel || '') }))
        .filter((l) => l.a && l.b && l.a !== l.b)

      const stats = {
        total: stars.length,
        live: stars.filter((s) => !s.archived).length,
        archived: stars.filter((s) => s.archived).length,
        bright: stars.filter((s) => s.brightness >= 0.7).length,
        dim: stars.filter((s) => s.brightness < 0.35).length,
        groups: used.map((g) => ({ id: g.id, label: g.label, color: g.color, count: byGroup.get(g.id).length })),
      }
      return { stars, links, stats, radius }
    }

    /** 星图筛选（纯函数，导出给测试）：搜索 / 星团 / 只看快忘了或最近 7 天 */
    function filterStars(stars, { q = '', group = '', quick = '', tier = '', now = Date.now() } = {}) {
      const kw = String(q || '').trim().toLowerCase()
      const out = []
      for (const s of stars || []) {
        if (group && s.group !== group) continue
        /** 层级只作用于事实（日记/人物/档案没有层级），选了就只看这一档的事实 */
        if (tier && s.kind === 'fact' && s.tier !== tier) continue
        if (tier && s.kind !== 'fact') continue
        if (quick === 'dim' && s.brightness >= 0.35) continue
        if (quick === 'recent' && !(s.at && now - s.at <= 7 * STAR_DAY)) continue
        if (kw) {
          const hit = String(s.text || '').toLowerCase().includes(kw)
            || String(s.groupLabel || '').toLowerCase().includes(kw)
          if (!hit) continue
        }
        out.push(s)
      }
      return { stars: out, matched: new Set(out.map((s) => s.id)) }
    }

    /**
     * 投影（纯函数，导出给测试）。
     *
     * 3D 用 aurabot `smDraw` 的那套：先绕 Y 轴转 yaw，再绕 X 轴转 pitch，
     * 透视除法 k = focal × zoom / (camZ - z2)，depth < 60 直接丢（相机背后）。
     * 2D 是同一批 (x,y,z) 的正交投影：忽略透视、忽略近大远小，只留 z 做
     * 前后绘制顺序——所以两版的星的相对位置是对得上的，切模式不会"跳一下"。
     */
    function projectStars(stars, view = {}, { W = 640, H = 420, mode = '3d', radius = STAR_R } = {}) {
      const yaw = Number(view.yaw) || 0
      const pitch = Number(view.pitch) || 0
      const zoom = Number(view.zoom) > 0 ? Number(view.zoom) : 1
      const pan = view.pan || { x: 0, y: 0 }
      const cam = view.cam || { x: 0, y: 0, z: 0 }
      const cyw = Math.cos(yaw), syw = Math.sin(yaw)
      const cp = Math.cos(pitch), sp = Math.sin(pitch)
      const camZ = radius * 3
      /** 视场按短边算，但别让它超过画布宽度——窄侧栏里星星不能被推出画面 */
      const focal = Math.min(W, H * 2.1)
      /** 2D 正交同样随宽度自适应：面板窄时不硬撑同一个倍率 */
      const flat = Math.min(1.25, W / 800) * zoom
      const out = []
      for (const star of stars || []) {
        if (mode === '2d') {
          out.push({
            star,
            x: W / 2 + (star.x - cam.x) * flat + pan.x,
            /** 星团在 Y 上压得扁，正交投影纵向拉开一点，别挤成中间一条 */
            y: H / 2 - (star.y - cam.y) * flat * 1.35 + pan.y,
            k: flat,
            depth: 1 + (star.z || 0) / (radius * 8),
            t: Math.max(0, Math.min(1, ((star.z || 0) / radius + 1) / 2)),
          })
          continue
        }
        const wx = star.x - cam.x, wy = star.y - cam.y, wz = star.z - cam.z
        const x1 = wx * cyw + wz * syw
        const z1 = -wx * syw + wz * cyw
        const y2 = wy * cp - z1 * sp
        const z2 = wy * sp + z1 * cp
        const depth = camZ - z2
        if (depth < 60) continue
        const k = focal * zoom / depth
        out.push({
          star,
          x: W / 2 + x1 * k + pan.x,
          y: H / 2 - y2 * k + pan.y,
          k,
          depth,
          t: Math.max(0, Math.min(1, (z2 / radius + 1) / 2)),
        })
      }
      /** 远的先画，近的盖在上面；2D 用 z 当深度，顺序也不乱 */
      return out.sort((a, b) => b.depth - a.depth)
    }

    /** 滚轮缩放档位（纯函数）。原生 passive:false 监听调用，见组件里 */
    function wheelZoom(cur, deltaY, { min = 0.6, max = 2.6 } = {}) {
      const z = Number(cur) > 0 ? Number(cur) : 1
      const next = z * (Number(deltaY) > 0 ? 0.9 : 1.1)
      return Math.max(min, Math.min(max, Math.round(next * 1000) / 1000))
    }

    /**
     * 标签避让（纯函数，导出给测试）。2D 模式用；3D 只给选中/悬停的星标字。
     * 贪心：按亮度从高到低试放，放不下就跳过，宁可留白不叠字。
     */
    function placeLabels(nodes, { maxLabels = 26, font = 11, maxChars = 6, pad = 2 } = {}) {
      const est = (s) => {
        let wpx = 0
        for (const ch of s) wpx += /[\x00-\xff]/.test(ch) ? font * 0.55 : font
        return wpx + 6
      }
      const picked = []
      const order = [...(nodes || [])].sort((a, b) => ((b.brightness ?? b.deg ?? 0) - (a.brightness ?? a.deg ?? 0)) || String(a.name || '').localeCompare(String(b.name || '')))
      for (const n of order) {
        if (picked.length >= maxLabels) break
        const text = String(n.name || n.text || '').slice(0, maxChars)
        if (!text) continue
        const w = est(text)
        const h = font + 4
        const box = { name: text, full: n.full || n.name || n.text, x: n.x - w / 2, y: n.y - (n.r || 6) - h - 3, w, h }
        const hit = picked.some((p) => !(box.x + box.w + pad < p.x || p.x + p.w + pad < box.x
          || box.y + box.h + pad < p.y || p.y + p.h + pad < box.y))
        if (hit || box.x < 0 || box.y < 0) continue
        picked.push(box)
      }
      return picked
    }

    /** 面板偏好：存本地，切页回来不重置；localStorage 不可用就静默用默认 */
    function starPref(key, fallback) {
      try {
        const v = localStorage.getItem('roost.star.' + key)
        return v === null ? fallback : JSON.parse(v)
      } catch { return fallback }
    }
    function saveStarPref(key, value) {
      try { localStorage.setItem('roost.star.' + key, JSON.stringify(value)) } catch {}
    }

    /**
     * 记忆星图组件。数据来自记忆页同一份 `/memory` 快照，不新开路由。
     * 点星出详情；写操作只调**已经存在**的 `memory.remove` / `/memory/add`，
     * 不新造后端能力（编辑文字 / 改重要度 / 复习 / 层级这些我们没有，见文档）。
     */
    function StarMap({ mem, toast, reload, quick, busy }) {
      const ref = useRef(null)
      const hits = useRef([])
      const [mode, setMode] = useState(() => starPref('mode', '3d') === '2d' ? '2d' : '3d')
      const [spin, setSpin] = useState(() => starPref('spin', true) !== false)
      /** 流动星尘只在 3D 成立（透视才有前后漂移），2D 下禁用 */
      const [motion, setMotion] = useState(() => starPref('motion', true) !== false)
      /** motion 单独开、spin 关时也要触发重绘 */
      const [frame, setFrame] = useState(0)
      const [glow, setGlow] = useState(() => starPref('glow', true) !== false)
      const [edgeOn, setEdgeOn] = useState(() => starPref('edgeOn', true) !== false)
      const [labels, setLabels] = useState(() => starPref('labels', true) !== false)
      const [q, setQ] = useState('')
      const [group, setGroup] = useState('')
      const [quickF, setQuickF] = useState('')
      const [tierFilter, setTierFilter] = useState('')
      /** 关系线三档 + 强度（aurabot 有，我们之前只有开关） */
      const [edgeMode, setEdgeMode] = useState('normal')
      const [edgeStrength, setEdgeStrength] = useState(0.5)
      const [zoom, setZoom] = useState(1)
      const [yaw, setYaw] = useState(0.45)
      const [pitch, setPitch] = useState(0.24)
      const [pan, setPan] = useState({ x: 0, y: 0 })
      const [sel, setSel] = useState(null)
      const [hover, setHover] = useState('')
      const [tick, setTick] = useState(0)
      const [addText, setAddText] = useState('')
      const [addScope, setAddScope] = useState('global')
      const [addImp, setAddImp] = useState(0.5)
      const [addTier, setAddTier] = useState('long')
      const [addBusy, setAddBusy] = useState(false)

      const built = buildStarMap(mem)
      const shown = filterStars(built.stars, { q, group, quick: quickF, tier: tierFilter })
      const byId = new Map(shown.stars.map((s) => [s.id, s]))
      const sig = shown.stars.map((s) => s.id).join('|') + '#' + tick
      const H = 420
      const is3d = mode === '3d'

      const setModeAndSave = (v) => { setMode(v); saveStarPref('mode', v) }
      const toggle = (setter, key) => (e) => {
        const v = Boolean(e.target.checked)
        setter(v); saveStarPref(key, v)
      }

      /**
       * 滚轮：原生 passive:false。React 的 onWheel 是 passive，
       * preventDefault 拦不住，缩图时整页会跟着滚。
       */
      useEffect(() => {
        const cv = ref.current
        if (!cv || typeof cv.addEventListener !== 'function') return
        const onWheel = (ev) => {
          if (typeof ev.preventDefault === 'function') ev.preventDefault()
          setZoom((z) => wheelZoom(z, ev.deltaY))
        }
        try { cv.addEventListener('wheel', onWheel, { passive: false }) } catch { return }
        return () => { try { cv.removeEventListener('wheel', onWheel) } catch {} }
      }, [])

      /**
       * 自动旋转与流动星尘都只在 3D 有意义；选中星星时停下，方便读详情。
       * spin 开着时 setYaw 每帧就会触发重绘；spin 关但 motion 开时靠
       * setFrame 触发。弹窗关闭 → 组件卸载 → rAF 一并取消，不后台空转。
       */
      useEffect(() => {
        if (!is3d || (!spin && !motion) || sel) return
        let raf = 0
        let alive = true
        const step = () => {
          if (!alive) return
          if (spin) setYaw((v) => v + 0.0025)
          else setFrame((f) => f + 1)
          raf = requestAnimationFrame(step)
        }
        raf = requestAnimationFrame(step)
        return () => { alive = false; cancelAnimationFrame(raf) }
      }, [is3d, spin, motion, Boolean(sel)])

      useEffect(() => {
        const cv = ref.current
        if (!cv) return
        const W = cv.clientWidth || 640
        const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
        const ctx = cv.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)

        const bg = ctx.createRadialGradient(W * 0.5, H * 0.45, 20, W * 0.5, H * 0.5, Math.max(W, H) * 0.75)
        bg.addColorStop(0, '#141d33'); bg.addColorStop(1, '#0a0f1c')
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
        let seed = 20261113
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
        /** 3D 才让星尘慢慢漂；关掉时用固定 seed 画静止星空，不跑动画 */
        const drift = motion && is3d ? Date.now() * 0.001 : 0
        for (let i = 0; i < 170; i++) {
          const a = 0.05 + rnd() * 0.2
          const speed = 0.3 + rnd()
          const x = (rnd() * W + (drift ? Math.sin(drift * 0.2 + i) * 2 : 0)) % W
          const y = (rnd() * H + (drift ? (drift * 4 * speed) % H : 0)) % H
          ctx.fillStyle = `rgba(200,220,255,${a.toFixed(3)})`
          ctx.fillRect(x, y, 1, 1)
        }

        const projected = projectStars(shown.stars, { yaw, pitch, zoom, pan }, { W, H, mode, radius: built.radius })
        hits.current = projected
        const pos = new Map(projected.map((p) => [p.star.id, p]))

        if (!projected.length) {
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.font = '12px ui-sans-serif,system-ui,sans-serif'
          ctx.fillStyle = 'rgba(226,234,255,.45)'
          ctx.fillText('这里还没有记忆，或筛选后一颗都不剩', W / 2, H / 2)
          return
        }

        /** 星团光环：3D 专属（2D 正交下画圈会变成一堆套圈，反而乱） */
        if (is3d) {
          for (const g of built.stats.groups) {
            const pts = projected.filter((p) => p.star.group === g.id)
            if (!pts.length) continue
            const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length
            const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length
            const rr = Math.max(28, Math.sqrt(pts.reduce((a, p) => a + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / pts.length) * 1.5)
            ctx.beginPath(); ctx.arc(cx, cy, Math.min(rr, 180), 0, Math.PI * 2)
            ctx.strokeStyle = g.color + '1f'; ctx.lineWidth = 1; ctx.stroke()
          }
        }

        /** 关系线：只在两端都画得出来时连；3D 里按深度淡出 */
        if (edgeOn) {
          for (const l of built.links) {
            const a = pos.get(l.a), b = pos.get(l.b)
            if (!a || !b) continue
            const on = !sel && !hover ? true : [l.a, l.b].includes(sel) || [l.a, l.b].includes(hover)
            /** 三档：focus 只画选中相关的；subtle 全部微光；normal 常规 */
            if (edgeMode === 'focus' && !on) continue
            const base = edgeMode === 'subtle' ? 0.18 : 0.42
            const alpha = (on ? base : base * 0.28) * edgeStrength
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
            ctx.strokeStyle = `rgba(140,190,255,${alpha.toFixed(3)})`
            ctx.lineWidth = on ? 1.2 : 0.8; ctx.stroke()
          }
        }

        for (const p of projected) {
          const s = p.star
          const focus = sel === s.id || hover === s.id
          const dim = (sel && sel !== s.id) || (q && !shown.matched.has(s.id))
          const r = Math.max(1.6, Math.min(11, (2.2 + s.brightness * 5.2) * (is3d ? p.k * 1.5 : 1)))
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
          ctx.fillStyle = s.color
          ctx.globalAlpha = dim ? 0.22 : 0.35 + 0.65 * s.brightness
          if (glow) { ctx.shadowColor = s.color; ctx.shadowBlur = focus ? 20 : 9 }
          ctx.fill(); ctx.shadowBlur = 0; ctx.globalAlpha = 1
          if (focus) {
            ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2)
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4; ctx.stroke()
          }
          p.r = r
        }

        /** 标签：两版都用矩形避让；3D 少放几个，避免旋转时名字跟着飘成一片 */
        const labelNodes = projected.map((p) => ({ ...p, name: p.star.text, brightness: p.star.brightness, r: p.r }))
        if (labels) {
          const picked = placeLabels(labelNodes, { maxLabels: is3d ? 14 : 22, font: 11, maxChars: 7 })
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.font = '11px ui-sans-serif,system-ui,sans-serif'
          for (const b of picked) {
            ctx.fillStyle = 'rgba(8,12,22,.7)'; ctx.fillRect(b.x, b.y, b.w, b.h)
            ctx.fillStyle = 'rgba(232,240,255,.94)'
            ctx.fillText(b.name, b.x + b.w / 2, b.y + b.h / 2 + 0.5)
          }
        }

        /** 角标：统计 + 视角 + 3D/2D 标记 */
        ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(226,234,255,.58)'
        ctx.fillText(`${shown.stars.length} 颗星 · ${built.links.length} 条关系 · ${Math.round(zoom * 100)}% · ${is3d ? '3D' : '2D'}`, W - 12, 16)
        ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(226,234,255,.42)'
        ctx.fillText(is3d ? '拖拽转视角 · 滚轮缩放 · 点星看详情' : '拖拽平移 · 滚轮缩放 · 点星看详情', 12, H - 12)
      }, [sig, mode, zoom, yaw, pitch, pan, labels, glow, edgeOn, hover, sel, q, is3d, motion, frame])

      const localOf = (ev) => {
        const r = ref.current.getBoundingClientRect()
        return { x: ev.clientX - r.left, y: ev.clientY - r.top }
      }
      const hitAt = (x, y) => {
        let best = null, bestD = Infinity
        for (const p of hits.current) {
          const d = (p.x - x) ** 2 + (p.y - y) ** 2
          if (d < (p.r + 10) ** 2 && d < bestD) { best = p.star; bestD = d }
        }
        return best
      }

      const forget = async (star) => {
        if (!star || star.kind !== 'fact') return toast('这条不是事实，不能在这儿删')
        const r = await quick('memory.remove', star.text)
        toast(r?.ok === false ? (r.message || '没删掉') : (r.message || '删了'))
        setSel(null)
        if (reload) reload()
      }
      const addStar = async () => {
        const text = addText.trim()
        if (!text) return toast('先写点什么')
        setAddBusy(true)
        try {
          /**
           * 字段名必须是 `fact`：后端读的是它，而这里以前传 `text`，
           * 于是「加上去」长期 400「缺 fact」——点了没反应。
           */
          const body = {
            fact: text, text, scope: addScope,
            importance: Number(addImp) || 0, tier: addTier,
          }
          if (addScope === 'chat' && mem?.chatId) body.chatId = mem.chatId
          const r = await post('/memory/add', body)
          if (r?.ok === false) return toast(r.message || '没记上')
          toast('记上了')
          setAddText('')
          if (reload) reload()
        } catch (e) { toast('没记上：' + e.message) } finally { setAddBusy(false) }
      }

      const detail = sel ? byId.get(sel) : null
      const fmt = (at) => at ? new Date(at).toLocaleDateString('zh-CN') : '没记时间'
      /** 逐条编辑：编辑文字 / 改重要度 / 复习 / 层级 / 归档恢复，共用一个路由 */
      const [edit, setEdit] = useState(null)
      const [showEvidence, setShowEvidence] = useState(false)
      const [factBusy, setFactBusy] = useState(false)
      /** 非事实节点（日记/实体/档案）的操作中状态 */
      const [nodeBusy, setNodeBusy] = useState(false)
      const nodeAct = async (kind, id) => {
        if (!id || nodeBusy) return
        setNodeBusy(true)
        try {
          const r = await post('/memory/node', { kind, id, chatId: mem?.chatId || '' })
          /** 后端失败可能只给 why（旧字段），两个都读，别让用户只看到「没做成」 */
          toast(r?.ok === false ? (r.message || r.why || '没做成') : (r.message || '已处理'))
          if (r?.ok) { setSel(null); if (reload) reload() }
        } catch (e) {
          toast('没做成：' + e.message)
        } finally {
          setNodeBusy(false)
        }
      }
      const factAct = async (action, extra = {}) => {
        if (!detail || factBusy) return
        setFactBusy(true)
        try {
          const r = await post('/memory/fact', {
            action,
            id: detail.factId || detail.text,
            scope: detail.scope || 'global',
            chatId: mem?.chatId || '',
            ...extra,
          })
          toast(r?.ok === false ? (r.message || '没改上') : '已更新')
          setEdit(null)
          if (r?.ok && reload) reload()
        } catch (e) {
          toast('没改上：' + e.message)
        } finally {
          setFactBusy(false)
        }
      }

      return h('div', null,
        h('div', { className: 'roost-note', style: { marginBottom: 8 } },
          '把记忆画成星空：越亮记得越牢（亮度 = 权重 × 时间衰减，和淘汰用的是同一条公式）。位置按真实来源分星团：跨群事实 / 本会话 / 人物与实体 / 重要片段 / 熟人档案 / 已被取代。',
          is3d ? '3D 下可拖拽转视角、自动旋转、看景深与星团光环。' : '2D 是正交投影：没有旋转和景深，但标签不叠、低配机器也不卡。'),
        /* 第一行：模式 + 搜索 + 筛选 */
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
          h('div', { style: { display: 'inline-flex', gap: 2, padding: 2, border: '1px solid var(--line)', borderRadius: 8 } },
            ['2d', '3d'].map((m) => h('button', {
              key: m, type: 'button', className: 'roost-btn',
              'data-on': mode === m ? '1' : '0',
              style: { padding: '2px 10px', background: mode === m ? 'var(--accent)' : 'transparent', color: mode === m ? '#fff' : 'inherit' },
              onClick: () => setModeAndSave(m),
            }, m.toUpperCase()))),
          h('input', {
            className: 'roost-input', style: { width: 150, padding: '3px 8px', fontSize: '11.5px' },
            placeholder: '搜星星：内容 / 分类', value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          h('select', {
            className: 'roost-input', style: { width: 'auto', padding: '3px 8px', fontSize: '11.5px' },
            value: group, onChange: (e) => setGroup(e.target.value),
          },
            h('option', { value: '' }, '全部区域'),
            built.stats.groups.map((g) => h('option', { key: g.id, value: g.id }, `${g.label}（${g.count}）`)),
          ),
          h('select', {
            className: 'roost-input', title: '按层级筛（只作用于事实）',
            style: { width: 'auto', padding: '3px 8px', fontSize: '11.5px' },
            value: tierFilter, onChange: (e) => setTierFilter(e.target.value),
          },
            h('option', { value: '' }, '全部层级'),
            h('option', { value: 'short' }, '临时'),
            h('option', { value: 'long' }, '长期'),
            h('option', { value: 'core' }, '永久'),
          ),
          h('select', {
            className: 'roost-input', style: { width: 'auto', padding: '3px 8px', fontSize: '11.5px' },
            value: quickF, onChange: (e) => setQuickF(e.target.value),
          },
            h('option', { value: '' }, '不筛选'),
            h('option', { value: 'dim' }, '只看快忘了'),
            h('option', { value: 'recent' }, '只看最近 7 天'),
          ),
          h('button', {
            type: 'button', className: 'roost-btn',
            onClick: () => { setZoom(1); setYaw(0.45); setPitch(0.24); setPan({ x: 0, y: 0 }); setTick((t) => t + 1) },
          }, '重置视角'),
          h('span', { className: 'roost-muted', style: { fontSize: 11.5, marginLeft: 'auto' } },
            `共 ${built.stats.total} 颗 · 清晰 ${built.stats.bright} · 快忘了 ${built.stats.dim} · 已被取代 ${built.stats.archived}`),
        ),
        /* 第二行：显示开关。3D 专属的在 2D 下禁用并说明 */
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 11.5, marginBottom: 6 } },
          h('label', { title: is3d ? '' : '自动旋转只在 3D 有意义', style: { opacity: is3d ? 1 : 0.45, display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'checkbox', checked: is3d && spin, disabled: !is3d, onChange: toggle(setSpin, 'spin') }),
            '自动旋转（仅 3D）'),
          h('label', { title: is3d ? '' : '流动星尘只在 3D 有意义', style: { opacity: is3d ? 1 : 0.45, display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'checkbox', checked: is3d && motion, disabled: !is3d, onChange: toggle(setMotion, 'motion') }),
            '流动星尘（仅 3D）'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'checkbox', checked: glow, onChange: toggle(setGlow, 'glow') }), '辉光'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'checkbox', checked: edgeOn, onChange: toggle(setEdgeOn, 'edgeOn') }), '关系线'),
          edgeOn
            ? h('select', {
                className: 'roost-input', title: '关系线显示方式',
                style: { width: 'auto', padding: '2px 6px', fontSize: 11 },
                value: edgeMode, onChange: (e) => setEdgeMode(e.target.value),
              },
                h('option', { value: 'focus' }, '只在选中时'),
                h('option', { value: 'subtle' }, '微光'),
                h('option', { value: 'normal' }, '标准'))
            : null,
          edgeOn && edgeMode !== 'focus'
            ? h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                '强度',
                h('input', {
                  type: 'range', min: 0.05, max: 1, step: 0.05, value: edgeStrength,
                  style: { width: 56 },
                  onChange: (e) => setEdgeStrength(Number(e.target.value)),
                }))
            : null,
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', { type: 'checkbox', checked: labels, onChange: toggle(setLabels, 'labels') }), '显示名字'),
        ),
        h('canvas', {
          ref,
          title: is3d ? '拖拽转视角 · 滚轮缩放 · 点星看详情' : '拖拽平移 · 滚轮缩放 · 点星看详情',
          style: { width: '100%', height: H, borderRadius: 10, border: '1px solid rgba(120,160,220,.28)', display: 'block', cursor: 'grab', touchAction: 'none', overscrollBehavior: 'contain' },
          /* wheel 由原生 passive:false 监听处理，这里不挂 onWheel */
          onMouseDown: (ev) => {
            const start = localOf(ev)
            const from = { pan: { ...pan }, yaw, pitch }
            let moved = false
            const mv = (e2) => {
              const p = localOf(e2)
              const dx = p.x - start.x, dy = p.y - start.y
              if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
              if (is3d) { setYaw(from.yaw + dx * 0.006); setPitch(Math.max(-1.2, Math.min(1.2, from.pitch - dy * 0.005))) }
              else setPan({ x: from.pan.x + dx, y: from.pan.y + dy })
            }
            const up = (e2) => {
              if (typeof window !== 'undefined') {
                window.removeEventListener('mousemove', mv)
                window.removeEventListener('mouseup', up)
              }
              if (moved) return
              const p = localOf(e2)
              const s = hitAt(p.x, p.y)
              setSel(s ? s.id : null)
            }
            if (typeof window !== 'undefined') {
              window.addEventListener('mousemove', mv)
              window.addEventListener('mouseup', up)
            }
          },
          onMouseMove: (ev) => {
            const p = localOf(ev)
            const s = hitAt(p.x, p.y)
            const next = s ? s.id : ''
            if (next !== hover) setHover(next)
          },
          onMouseLeave: () => setHover(''),
        }),
        /* 图例：色点 + 数量，画布缩放/旋转也不会把它弄丢 */
        h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginTop: 5, display: 'flex', gap: 10, flexWrap: 'wrap' } },
          built.stats.groups.map((g) => h('span', { key: g.id, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: { width: 8, height: 8, borderRadius: 4, background: g.color, display: 'inline-block' } }),
            `${g.label} ${g.count}`))),
        /**
         * 没选中星时的引导 + 列表。
         *
         * 星密的时候直接点画布很难点中，用户会以为「弹窗里没有编辑」。
         * 这里按亮度列前 12 颗，点一下等同于点中那颗星。
         */
        !detail && shown.stars.length
          ? h('div', { style: { marginTop: 10 } },
              h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginBottom: 6 } },
                '点画布上的星，或从下面直接点一颗 —— 详情里可以编辑、复习、改层级、归档。'),
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                [...shown.stars].sort((a, b) => b.brightness - a.brightness).slice(0, 12).map((st) => h('button', {
                  key: st.id, type: 'button', className: 'roost-btn',
                  style: { fontSize: 11.5, padding: '3px 8px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  title: st.text,
                  onClick: () => setSel(st.id),
                }, st.text.slice(0, 14)))),
            )
          : null,
        /* 点星后的详情：事实可以逐条编辑；其它来源只读，去对应分节操作 */
        detail
          ? h('div', { style: { marginTop: 10, padding: 10, border: '1px solid var(--line)', borderRadius: 8 } },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, detail.text),
              h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginBottom: 8 } },
                `${detail.groupLabel} · 亮度 ${Math.round(detail.brightness * 100)}% · 权重 ×${detail.w || 1} · ${fmt(detail.at)}`
                + (detail.kind === 'fact' ? ` · 层级 ${({ short: '临时', long: '长期', core: '永久' })[detail.tier] || '长期'}` : '')
                + (detail.kind === 'fact' && detail.pin > 0 ? ` · 重要度 ${Math.round(detail.pin * 100)}%` : '')
                + (detail.reviewedAt ? ` · 复习于 ${fmt(detail.reviewedAt)}` : '')
                + (detail.archived ? ' · 已归档/被取代，不参与注入' : '')
                + ({ strengthening: ' · 证据增强中', weakening: ' · 证据走弱', stale: ' · 证据陈旧' }[detail.trend] || '')
                + (detail.kind === 'fact' && Number(detail.confidence) < 0.99
                  ? ` · 信念 ${Math.round(Number(detail.confidence) * 100)}%` : '')),
              detail.kind === 'fact'
                ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
                    h('button', {
                      type: 'button', className: 'roost-btn', disabled: factBusy,
                      onClick: () => factAct('review'),
                    }, '还记得（复习）'),
                    h('select', {
                      className: 'roost-input', title: '改层级', disabled: factBusy,
                      style: { width: 'auto', padding: '3px 8px', fontSize: 11.5 },
                      value: detail.tier || 'long',
                      onChange: (e) => factAct('tier', { tier: e.target.value }),
                    },
                      h('option', { value: 'short' }, '临时'),
                      h('option', { value: 'long' }, '长期'),
                      h('option', { value: 'core' }, '永久')),
                    h('button', {
                      type: 'button', className: 'roost-btn', disabled: factBusy,
                      onClick: () => factAct(detail.archivedAt ? 'restore' : 'archive'),
                    }, detail.archivedAt ? '恢复' : '归档'),
                    h('button', {
                      type: 'button', className: 'roost-btn', disabled: factBusy,
                      onClick: () => setEdit({ text: detail.text, pin: detail.pin || 0, tier: detail.tier || 'long' }),
                    }, '编辑'),
                    h('button', {
                      type: 'button', className: 'roost-btn', disabled: Boolean(busy) || factBusy,
                      onClick: () => forget(detail),
                    }, '忘掉这条'),
                  )
                : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
                    detail.kind === 'episode'
                      ? h('button', {
                          type: 'button', className: 'roost-btn', disabled: nodeBusy,
                          onClick: () => nodeAct('episode', detail.journalId),
                        }, '作废这条日记')
                      : null,
                    detail.kind === 'entity'
                      ? h('button', {
                          type: 'button', className: 'roost-btn', disabled: nodeBusy,
                          /** 优先按实体 id 删：名字可能重名，也可能来自别名会话 */
                          onClick: () => nodeAct('entity', detail.entityId || detail.text),
                        }, '删掉这个实体（连同关系）')
                      : null,
                    detail.kind === 'profile'
                      ? h('button', {
                          type: 'button', className: 'roost-btn', disabled: nodeBusy,
                          onClick: () => nodeAct('profile', detail.profileKey),
                        }, '忘掉这个人')
                      : null,
                    h('span', { className: 'roost-muted', style: { fontSize: 11.5 } },
                      detail.kind === 'episode'
                        ? '日记原话不提供「编辑」——改原话等于篡改历史，只能作废。'
                        : detail.kind === 'entity'
                          ? '删掉后这条关系线也会消失，巩固时不会再抽回来。'
                          : '只删这条档案，不动聊天记录。'),
                  ),
              /** 证据明细：阶段1 算出的 evidence 一直没露出来，这里让用户能核对出处 */
              detail.kind === 'fact' && Array.isArray(detail.evidence) && detail.evidence.length
                ? h('div', { style: { marginBottom: 6 } },
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => setShowEvidence(!showEvidence),
                    }, showEvidence ? '收起证据' : `看证据（${detail.evidence.length}）`),
                    showEvidence
                      ? h('div', { style: { marginTop: 6, fontSize: 11.5, lineHeight: 1.8 } },
                          detail.evidence.map((ev, i) => h('div', {
                            key: i, className: 'roost-muted',
                            style: { paddingLeft: 8, borderLeft: '2px solid var(--line)', marginBottom: 3 },
                          },
                            `${ev.kind || '证据'} · ${fmt(ev.at)}`
                            + (ev.journalId ? ` · 原文 ${ev.journalId}` : '')
                            + (ev.quote ? ` · 「${String(ev.quote).slice(0, 60)}」` : ''))))
                      : null,
                  )
                : null,
              detail.kind === 'fact' && edit
                ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 } },
                    h('input', {
                      className: 'roost-input', style: { flex: '1 1 220px', padding: '3px 8px', fontSize: 11.5 },
                      value: edit.text, onChange: (e) => setEdit({ ...edit, text: e.target.value }),
                    }),
                    h('input', {
                      className: 'roost-input', type: 'number', min: 0, max: 1, step: 0.05,
                      title: '重要度 0–1（0 表示只用自动权重）',
                      style: { width: 78, padding: '3px 8px', fontSize: 11.5 },
                      value: edit.pin,
                      onChange: (e) => setEdit({ ...edit, pin: e.target.value }),
                    }),
                    h('button', {
                      type: 'button', className: 'roost-btn', disabled: factBusy,
                      onClick: () => factAct('update', { text: edit.text, pin: Number(edit.pin) || 0, tier: edit.tier }),
                    }, '保存'),
                    h('button', { type: 'button', className: 'roost-btn', onClick: () => setEdit(null) }, '取消'),
                  )
                : null,
              h('button', { type: 'button', className: 'roost-btn', onClick: () => { setSel(null); setEdit(null) } }, '收起'),
            )
          : null,
        /* 在星图上加一颗：复用 /memory/add（新增事实，可带重要度与层级） */
        h('div', { style: { marginTop: 12 } },
          h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginBottom: 5 } }, '在星图上加一颗'),
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
          h('input', {
            className: 'roost-input', style: { flex: '1 1 180px', padding: '3px 8px', fontSize: 11.5 },
            placeholder: '加一条记忆…', value: addText,
            onChange: (e) => setAddText(e.target.value),
          }),
          h('input', {
            className: 'roost-input', type: 'number', min: 0, max: 1, step: 0.05,
            title: '重要度 0–1（0 = 只用自动权重）',
            style: { width: 74, padding: '3px 8px', fontSize: 11.5 },
            value: addImp, onChange: (e) => setAddImp(e.target.value),
          }),
          h('select', {
            className: 'roost-input', title: '层级', style: { width: 'auto', padding: '3px 8px', fontSize: 11.5 },
            value: addTier, onChange: (e) => setAddTier(e.target.value),
          },
            h('option', { value: 'short' }, '临时'),
            h('option', { value: 'long' }, '长期'),
            h('option', { value: 'core' }, '永久')),
          h('select', {
            className: 'roost-input', title: '记到哪一层', style: { width: 'auto', padding: '3px 8px', fontSize: 11.5 },
            value: addScope, onChange: (e) => setAddScope(e.target.value),
          },
            h('option', { value: 'global' }, '跨群'),
            h('option', { value: 'chat' }, '本会话')),
          h('button', { type: 'button', className: 'roost-btn', disabled: addBusy, onClick: addStar }, addBusy ? '记…' : '加上去'),
          ),
        ),
      )
    }
    function PeopleTab({ mem, toast, reload, quick, busy, setTab }) {
      const profiles = mem?.profiles || []
      const events = mem?.events || []
      const gp = mem?.graph
      const chatProfiles = mem?.chatProfiles || []
      const goMemory = () => { if (setTab) setTab('memory') }
      /** 阶段6：群印象编辑态，按群 chatId 打开；切页不持久化，关掉就丢草稿 */
      const [chatEditId, setChatEditId] = useState('')
      const [chatEditForm, setChatEditForm] = useState(null)
      const [chatEditBusy, setChatEditBusy] = useState(false)
      const saveChatProfile = async (chatId) => {
        if (!chatEditForm) return
        setChatEditBusy(true)
        try {
          const r = await quick('chatprofile.save', { chatId, ...chatEditForm })
          toast(r?.message || '已保存', r?.ok === false ? 'err' : 'ok')
          if (r?.ok !== false) { setChatEditId(''); setChatEditForm(null); reload && reload() }
        } finally { setChatEditBusy(false) }
      }
      const shortTime = (at) => new Date(at).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })

      /** 4.1 人物墙：搜索 + 状态筛选。profiles 是跨群按 openid 归户的，没有群/标签维度，
       *  不造假的筛选项——维度只有「最近有没有互动」（状态）和名字 */
      const DAY = 86_400_000
      const [wallQ, setWallQ] = useState('')
      const [wallState, setWallState] = useState('all')
      const [picked, setPicked] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailBusy, setDetailBusy] = useState(false)
      /** 阶段6：人物档案编辑闭环。切人/切会话都要清空，免得 A 的表单串到 B */
      const [editForm, setEditForm] = useState(null)
      const [editBusy, setEditBusy] = useState(false)
      const [editTagInput, setEditTagInput] = useState('')
      const startEdit = (p) => {
        setEditForm({
          name: p?.name || '',
          alias: p?.alias || '',
          impression: p?.impression || '',
          tips: p?.tips || '',
          dislikes: p?.dislikes || '',
          tags: [...(p?.tags || [])],
        })
        setEditTagInput('')
      }
      const saveEdit = async () => {
        if (!editForm || !picked) return
        setEditBusy(true)
        try {
          const key = picked.key || picked.name
          const r = await quick('persona.edit', { key, patch: editForm })
          toast(r?.message || (r?.ok ? '已保存' : '没存上'), r?.ok === false ? 'err' : 'ok')
          if (r?.ok !== false) {
            setEditForm(null)
            await openPerson(picked) // 重读详情，刷新四栏
            if (reload) reload()
          }
        } finally { setEditBusy(false) }
      }
      const toggleNoMemory = async (on) => {
        if (!picked) return
        const key = picked.key || picked.name
        const r = await quick('persona.noMemory', { key, enabled: !on })
        toast(r?.message || '已更新', r?.ok === false ? 'err' : 'ok')
        if (r?.ok !== false) { await openPerson(picked); if (reload) reload() }
      }
      const stateWordOf = (at) => {
        if (!at) return '没记过时间'
        const d = (Date.now() - at) / DAY
        return d <= 7 ? '7 天内互动' : d <= 30 ? '30 天内互动' : '久未联系'
      }
      const wall = profiles
        .filter((p) => !wallQ || String(p.name || '').toLowerCase().includes(wallQ.toLowerCase()))
        .filter((p) => {
          if (wallState === 'all') return true
          const d = p.at ? (Date.now() - p.at) / DAY : Infinity
          return wallState === 'idle' ? d > 30 : d <= Number(wallState)
        })
      const openPerson = async (p) => {
        if (!p) return
        setPicked(p)
        setDetail(null)
        setEditForm(null) // 切人必清表单，免得 A 群草稿串到 B 群
        setDetailBusy(true)
        try {
          const r = await get('/person?key=' + encodeURIComponent(p.key || p.name)
            + '&chatId=' + encodeURIComponent(mem?.chatId || ''))
          setDetail(r?.ok === false ? { err: r.message || '读不到详情' } : r)
        } catch (e) {
          setDetail({ err: e.message })
        } finally {
          setDetailBusy(false)
        }
      }

      if (!mem) return h('div', null,
        h('div', { className: 'roost-empty' }, '读取人物数据…'),
        h('div', { className: 'roost-note' }, '一直停在这儿的话，去「排障」页看看 /memory 有没有报错。'),
        h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { if (reload) reload() },
        }, '重试'),
      )

      return h('div', null,
        /** 4.1 人物墙：点人看详情。原来的三节全保留，顺延到 03/04/05 */
        h(Sec, {
          n: '01', title: `人物墙（${wall.length}）`,
          right: h('button', { type: 'button', className: 'roost-btn', onClick: () => reload && reload() }, '刷新'),
        },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
            h('input', {
              className: 'roost-input', style: { flex: '1 1 200px' },
              placeholder: '搜名字', value: wallQ,
              onChange: (e) => setWallQ(e.target.value),
            }),
            [['all', '全部'], ['7', '7 天内'], ['30', '30 天内'], ['idle', '久未联系']].map(([v, label]) =>
              h('button', {
                key: v, type: 'button',
                className: wallState === v ? 'roost-primary' : 'roost-btn',
                onClick: () => setWallState(v),
              }, label))),
          wall.length
            ? h('div', { style: { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } },
                wall.map((p, i) => h('div', {
                  key: i, className: 'roost-item',
                  style: { cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch', gap: 2,
                    borderColor: picked && picked.name === p.name ? 'var(--accent)' : undefined },
                  onClick: () => openPerson(p),
                },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                    h('b', null, p.name || p.key || '(未命名)'),
                    h('span', { className: 'd' }, stateWordOf(p.at))),
                  h('span', { className: 't', style: { fontSize: 12 } },
                    p.impression || p.tips || '还没有印象'),
                )))
            : h('div', { className: 'roost-empty' },
                profiles.length ? '没有符合条件的人' : '还没写过人物档案。'),
          h('div', { className: 'roost-note', style: { marginTop: 8 } },
            '档案是跨群按 openid 归户的，没有群/标签维度——筛选只按「最近有没有互动」，不造假维度。'),
        ),

        /** 4.1 详情四栏：档案 / 关系 / 经历 / 记忆，数据与记忆页同源只是按人过滤；只读 */
        h(Sec, { n: '02', title: picked ? `详情：${picked.name || picked.key}` : '详情' },
          !picked
            ? h('div', { className: 'roost-empty' }, '在人物墙里点一个人，看档案 / 关系 / 经历 / 记忆四栏。')
            : detailBusy
              ? h('div', { className: 'roost-empty' }, '读取中…')
              : detail?.err
                ? h('div', { className: 'roost-empty', style: { color: 'var(--bad)' } }, detail.err)
                : !detail
                  ? null
                  : h('div', null,
                      h('div', { className: 'roost-note', style: { marginBottom: 8 } },
                        '档案可以在这里改（印象/称呼/相处/雷区/标签）；关系与日记的逐条操作仍在「记忆」页。'),
                      h('div', { style: { display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' } },
                        h('div', null,
                          h('div', { className: 'roost-diag-h' },
                            '档案',
                            h('button', {
                              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
                              onClick: () => (editForm ? setEditForm(null) : startEdit(detail.person)),
                            }, editForm ? '收起' : '编辑'),
                          ),
                          editForm
                            ? h('div', null,
                                ...[
                                  ['impression', '印象'], ['alias', '称呼'], ['tips', '相处建议'], ['dislikes', '雷区（别踩）'],
                                ].map(([k, label]) => h('label', { key: k, style: { display: 'block', marginBottom: 6, fontSize: 12 } },
                                  label,
                                  h('input', {
                                    className: 'roost-input', value: editForm[k] || '',
                                    style: { display: 'block', width: '100%', marginTop: 2 },
                                    onChange: (e) => setEditForm({ ...editForm, [k]: e.target.value }),
                                  }))),
                                h('div', { style: { fontSize: 12, marginTop: 6 } }, '标签',
                                  h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 } },
                                    editForm.tags.map((t, i) => h('button', {
                                      key: i, type: 'button', className: 'roost-btn',
                                      onClick: () => setEditForm({ ...editForm, tags: editForm.tags.filter((_, j) => j !== i) }),
                                    }, t + ' ×')),
                                    ['喜欢', '讨厌'].filter((t) => !editForm.tags.includes(t)).map((t) => h('button', {
                                      key: t, type: 'button', className: 'roost-btn',
                                      onClick: () => setEditForm({
                                        ...editForm,
                                        tags: [...editForm.tags.filter((x) => x !== (t === '喜欢' ? '讨厌' : '喜欢')), t],
                                      }),
                                    }, '+ ' + t)),
                                  ),
                                  h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
                                    h('input', {
                                      className: 'roost-input', value: editTagInput, placeholder: '自定义标签（回车）',
                                      onChange: (e) => setEditTagInput(e.target.value),
                                      onKeyDown: (e) => {
                                        if (e.key !== 'Enter') return
                                        const t = editTagInput.trim()
                                        if (t && !editForm.tags.includes(t)) setEditForm({ ...editForm, tags: [...editForm.tags, t] })
                                        setEditTagInput('')
                                      },
                                    })),
                                ),
                                h('button', {
                                  type: 'button', className: 'roost-btn roost-primary', disabled: editBusy,
                                  style: { marginTop: 8 }, onClick: saveEdit,
                                }, editBusy ? '保存中…' : '保存'),
                                h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 10, fontSize: 12 } },
                                  h('input', {
                                    type: 'checkbox', checked: Boolean(detail.person?.noMemory),
                                    onChange: (e) => toggleNoMemory(e.target.checked),
                                  }),
                                  '不再记住这个人（撤回来档案还在）'),
                              )
                            : h('div', null,
                                detail.person?.impression || detail.person?.tips || detail.person?.dislikes || detail.person?.alias || (detail.person?.tags || []).length
                                  ? h('div', { className: 'roost-note' },
                                      (detail.person.alias ? `称呼：${detail.person.alias}；` : '')
                                      + (detail.person.impression || '（没有印象）')
                                      + (detail.person.tips ? `（相处：${detail.person.tips}）` : '')
                                      + (detail.person.dislikes ? `（别踩：${detail.person.dislikes}）` : '')
                                      + ((detail.person.tags || []).length ? ` [${detail.person.tags.join('、')}]` : ''))
                                  : h('div', { className: 'roost-empty' }, '档案里还没写过这个人'),
                                detail.person?.noMemory
                                  ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } }, '已标记「不再记住」')
                                  : null),
                        ),
                        h('div', null,
                          h('div', { className: 'roost-diag-h' }, '关系'),
                          (detail.edges || []).length
                            ? detail.edges.map((e, i) => h('div', { key: i, className: 'roost-note' },
                                `· ${e.src} —${e.rel}→ ${e.dst}${e.chatId ? '（' + e.chatId + '）' : ''}`))
                            : h('div', { className: 'roost-empty' }, '图谱里没有这个人参与的现在成立的关系')),
                        h('div', null,
                          h('div', { className: 'roost-diag-h' }, '经历（本会话说过的）'),
                          (detail.said || []).length
                            ? detail.said.map((s, i) => h('div', { key: i, className: 'roost-note' },
                                '· ' + (s.at ? shortTime(s.at) : '') + ' ' + s.text))
                            : h('div', { className: 'roost-empty' },
                                '当前会话里没归到这个人名下的发言（跨会话聚合等数据模型支持了再补）')),
                        h('div', null,
                          h('div', { className: 'roost-diag-h' }, '记忆（提到这个人的日记）'),
                          (detail.mentions || []).length
                            ? detail.mentions.map((m, i) => h('div', { key: i, className: 'roost-note' },
                                '· ' + (m.at ? shortTime(m.at) : '') + ` [${m.level || ''}] ` + m.text
                                + (m.why ? `（${m.why}）` : '')))
                            : h('div', { className: 'roost-empty' }, '没有提到这个人的日记')))),
        ),

        h(Sec, {
          n: '03', title: `熟人小档案（${profiles.length}）`,
          right: h('button', { type: 'button', className: 'roost-btn', onClick: () => reload && reload() }, '刷新'),
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '每天凌晨从聊天里攒一小段印象和相处建议，跨群共用；同一天里不改提示词。开关关着也能在这儿查看和清空已有的。'),
          profiles.length
            ? h('div', { style: { display: 'grid', gap: 4, marginBottom: 8 } },
                profiles.map((p, i) => h('div', { key: i, className: 'roost-note' },
                  '· ' + p.name + '：' + (p.impression || '') + (p.tips ? `（相处：${p.tips}）` : '') + (p.dislikes ? `（别踩：${p.dislikes}）` : ''))))
            : h('div', { className: 'roost-empty', style: { marginBottom: 8 } }, '还没写过人物档案。'),
          h(ConfirmLink, {
            label: '清空人物档案', confirmLabel: '确认清空档案', disabled: busy,
            onConfirm: async () => {
              const r = await quick('profiles.clear')
              toast(r.message || '清了')
              reload()
            },
          }),
        ),

        h(Sec, { n: '04', title: '她知道的关系' },
          gp?.stats?.enabled === false
            ? h('div', { className: 'roost-empty' }, '图谱没启用（当前 Node 没有 node:sqlite）')
            : h('div', null,
                gp?.stats
                  ? h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 6 } },
                      `${gp.stats.entities} 个实体 · ${gp.stats.edges} 条现在成立 · ${gp.stats.ended || 0} 条已结束 · ${gp.stats.episodes} 段原始记录`)
                  : null,
                (gp?.edges || []).length
                  ? h('div', { className: 'roost-list' },
                      /**
                       * 2026-11-13：关系图不再单独画。人物 / 实体 / 关系连线
                       * 都并进「记忆」页那张记忆星图了，这里只保留文字清单——
                       * 同一个关系画两遍，用户得先判断在哪页看才算数。
                       */
                      gp.edges.slice(0, 12).map((e) => h('div', { key: e.id, className: 'roost-item' },
                        h('span', { className: 't' }, `${e.src} —${e.rel}→ ${e.dst}`),
                        h('span', { className: 'd' }, dayOf(e.from)),
                      )))
                  : h('div', { className: 'roost-empty' }, '还没有关系。聊得多了巩固时会自己抽出来。'),
                (gp?.edges || []).length > 12
                  ? h('div', { className: 'roost-note' }, `只列前 12 条，共 ${gp.edges.length} 条；完整清单在「记忆」页。`)
                  : null,
                h('div', { className: 'roost-note' },
                  '这里只读。删关系、撤销「不要再记」、看以前成立过的，都在「记忆」页。',
                  h('button', {
                    type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
                    onClick: goMemory,
                  }, '去记忆页管理')),
              ),
        ),

        h(Sec, {
          n: '05', title: `她最近做过的事（${events.length}）`,
          right: h('button', { type: 'button', className: 'roost-btn', onClick: () => reload && reload() }, '刷新'),
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '只记动作、不记说过的话；24 小时后自动删。开关关着也能在这儿查看和清空已有的。'),
          events.length
            ? h('div', { style: { display: 'grid', gap: 4, marginBottom: 8 } },
                events.map((e, i) => h('div', { key: i, className: 'roost-note' },
                  '· ' + shortTime(e.at) + ' ' + e.where + ' ' + e.label + (e.count > 1 ? `（${e.count} 次）` : ''))))
            : h('div', { className: 'roost-empty', style: { marginBottom: 8 } }, '最近没记下什么。'),
          h(ConfirmLink, {
            label: '清空这些经历', confirmLabel: '确认清空经历', disabled: busy,
            onConfirm: async () => {
              const r = await quick('events.clear')
              toast(r.message || '清了')
              reload()
            },
          }),
        ),

        /** 阶段6：群印象用无编号总览卡（人物页 01–05 编号被测试钉死，不插节） */
        h(Sec, { title: `群印象（${chatProfiles.length}）` },
          h('div', { className: 'roost-note', style: { marginTop: 0 } },
            '她对每个群的印象：气氛、常聊什么、整体印象。默认不进提示词，只是面板里可查可改的资料。'),
          chatProfiles.length
            ? h('div', { style: { display: 'grid', gap: 8 } },
                chatProfiles.map((c) => h('div', { key: c.chatId, className: 'roost-item' },
                  h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                    h('b', null, c.name || c.chatId),
                    h('div', { className: 'roost-note', style: { margin: 0 } },
                      (c.vibe ? `气氛：${c.vibe}` : '（还没写下气氛）')
                      + (c.topics ? ` · 常聊：${c.topics}` : '')
                      + (c.impression ? ` · 印象：${c.impression}` : '')),
                    chatEditId === c.chatId
                      ? h('div', null,
                          ...[['vibe', '气氛'], ['topics', '常聊什么'], ['impression', '印象']].map(([k, label]) => h('label', {
                            key: k, style: { display: 'block', marginTop: 4, fontSize: 12 },
                          }, label,
                            h('input', {
                              className: 'roost-input', value: chatEditForm?.[k] || '',
                              style: { display: 'block', width: '100%', marginTop: 2 },
                              onChange: (e) => setChatEditForm({ ...chatEditForm, [k]: e.target.value }),
                            }))),
                          h('button', {
                            type: 'button', className: 'roost-btn roost-primary', disabled: chatEditBusy, style: { marginTop: 6 },
                            onClick: () => saveChatProfile(c.chatId),
                          }, chatEditBusy ? '保存中…' : '保存'),
                          h('button', {
                            type: 'button', className: 'roost-btn', style: { marginLeft: 6 },
                            onClick: () => { setChatEditId(''); setChatEditForm(null) },
                          }, '取消'),
                          h(ConfirmLink, {
                            label: '清空这个群的印象', confirmLabel: '确认清空',
                            onConfirm: async () => {
                              const r = await quick('chatprofile.clear', { chatId: c.chatId })
                              toast(r?.message || '清了'); setChatEditId(''); setChatEditForm(null); reload && reload()
                            },
                          }),
                        )
                      : null,
                  ),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: () => {
                      if (chatEditId === c.chatId) { setChatEditId(''); setChatEditForm(null) }
                      else { setChatEditId(c.chatId); setChatEditForm({ vibe: c.vibe || '', topics: c.topics || '', impression: c.impression || '' }) }
                    },
                  }, chatEditId === c.chatId ? '收起' : '编辑'),
                )))
            : h('div', { className: 'roost-empty' }, '还没写下群印象。'),
        ),

        /** 事实 / 日记 / 召回记录仍只在记忆页：那是「记了什么」，不是「记得谁」 */
        h('div', { className: 'roost-note' },
          '事实、日记、召回记录、导入旧版记忆和清空，都还在「记忆」页；这一页只放「她记得哪些人」。',
          h('button', {
            type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
            onClick: goMemory,
          }, '去记忆页'),
        ),
      )
    }

    /**
     * 备份页：E4 那块从记忆页里长出一个正门。
     *
     * **导入在这里，但语义必须说死**：整包恢复只暂存到 `.restore/`、下次启动才换上。
     * 以前因为怕人误会「点完就已经恢复了」而不放按钮，代价是换电脑迁移只能开终端打
     * 命令（导出却只要点一下），最需要人的那一步反而最麻烦。现在补上按钮，靠三件事
     * 防误会：按钮旁的文案、第 02 节「等着下次启动生效的恢复」、以及成功气泡里
     * 明写「重启 DSH 后生效 / 现有数据没动」。
     *
     * 「不会带过去的」照 src/backup.js 的 SKIP / shouldSkip 实写，
     * 不凭印象编：尤其 secrets/ 是扩展长期令牌明文，必须显式说清。
     */
    function BackupTab({ mem, toast, reload, quick, busy, setTab, config, saveCfg }) {
      const backups = mem?.backups || []
      const pending = mem?.restorePending
      const shortTime = (at) => new Date(at).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })

      /**
       * 暂存一份恢复：上传的 zip，或清单里现成的一份，走同一个回调。
       *
       * 面板不重复校验——格式、`data/` 前缀、路径穿越、解包上限全在宿主的
       * `stageRestore()` 里，这里只把失败原文显示出来，别用一句「失败了」盖掉。
       */
      const stageBackup = async (path, init) => {
        try {
          const res = await fetch(API + path, init)
          const r = await res.json().catch(() => ({}))
          if (!res.ok || r.ok === false) throw new Error(r.message || ('HTTP ' + res.status))
          toast(r.message || '已暂存，重启 DSH 后生效')
          if (r.warn) toast('⚠ ' + r.warn)
          if (reload) reload()
        } catch (e) {
          toast('没成：' + e.message)
        }
      }

      /** 选文件 → 确认 → 上传。用临时 input，省得为一次选择挂个 ref */
      const pickAndImport = () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.zip,application/zip'
        input.onchange = () => {
          const f = input.files && input.files[0]
          if (!f) return
          if (!/\.zip$/i.test(f.name)) return toast('要选 .zip 备份文件')
          const ok = window.confirm(`用「${f.name}」暂存一份恢复？\n\n`
            + '只暂存到 .restore/，重启 DSH 后才换上；现有数据现在一个字节都不会动。')
          if (!ok) return
          stageBackup('/backup/import', { method: 'POST', body: f })
        }
        input.click()
      }

      /** 4.3/4.4：定时与云备份。推送结果就地展示（reason 分类给不同指引） */
      const [pushResult, setPushResult] = useState(null)
      const [pushBusy, setPushBusy] = useState(false)
      const [bkDraft, setBkDraft] = useState(null)
      const sched = config?.backup?.schedule || {}
      const remote = config?.backup?.remote || {}
      const sval = (k, fallback) => (bkDraft !== null && bkDraft[k] !== undefined
        ? bkDraft[k]
        : String(sched[k] ?? fallback))
      const putBackup = async (patch) => {
        if (!saveCfg) return
        const r = await saveCfg({ backup: patch })
        toast(r?.ok === false ? (r.message || '没存上') : '已保存')
        setBkDraft(null)
      }
      const runNow = async () => {
        setPushBusy(true)
        try {
          const r = await post('/backup/run-now', { push: true })
          if (r?.ok === false) setPushResult({ ok: false, message: r.message || '没跑成' })
          else setPushResult({
            ok: true,
            name: r.name,
            remote: r.remote || null,
          })
          reload()
        } catch (e) {
          setPushResult({ ok: false, message: e.message })
        } finally {
          setPushBusy(false)
        }
      }

      if (!mem) return h('div', null,
        h('div', { className: 'roost-empty' }, '读取备份状态…'),
        h('div', { className: 'roost-note' }, '一直停在这儿的话，去「排障」页看看 /memory 有没有报错。'),
        h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { if (reload) reload() },
        }, '重试'),
      )

      return h('div', null,
        h(Sec, { n: '01', title: '导出备份' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '打包配置、记忆、日记、图谱、人格等；SQLite 用一致性快照，运行中导出也安全。'
            + '⚠ 包里含 config.json（里面有密钥、端口、路径），别外传；'
            + '**导入会连旧机器的 config.json 一起带过来**（只把数据目录那段换成本机路径）。'
            + '导入只暂存到 .restore/，**重启 DSH 才换上**，现有数据不动，随时能在第 02 节反悔。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('button', {
              type: 'button', className: 'roost-primary',
              onClick: () => downloadBackupZip(toast, reload),
            }, '导出备份（zip）'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              title: '换电脑迁移时用：从本机选一个之前导出的 zip',
              onClick: pickAndImport,
            }, '导入备份（zip）'),
          ),
        ),

        h(Sec, { n: '02', title: '等着下次启动生效的恢复' },
          pending
            ? h('div', { className: 'roost-note' },
                `有一份整包恢复等着下次启动生效（${pending.files} 个文件，${pending.createdAt || ''}）。`,
                h('button', {
                  type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
                  onClick: async () => {
                    const r = await quick('backup.cancelRestore')
                    toast(r.message || '已取消')
                    reload()
                  },
                }, '取消这次恢复'))
            : h('div', { className: 'roost-empty' }, '没有待生效的恢复。导入整包后这里会出现一条，可以反悔。'),
        ),

        h(Sec, {
          n: '03', title: `备份清单（${backups.length}）`,
          right: h('button', { type: 'button', className: 'roost-btn', onClick: () => reload && reload() }, '刷新'),
        },
          backups.length
            ? h('div', { style: { display: 'grid', gap: 4 } },
                backups.slice(0, 20).map((b, i) => h('div', {
                  key: i, className: 'roost-note',
                  style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: 0 },
                },
                  '· ' + shortTime(b.at) + ' ' + b.label + ' · ' + (b.bytes / 1024).toFixed(1) + ' KB',
                  b.kind === 'retention'
                    ? h(ConfirmLink, {
                        label: '还原这一份', confirmLabel: '确认还原这些原文', disabled: busy,
                        onConfirm: async () => {
                          const r = await quick('backup.restoreRetention', { name: b.name })
                          toast(r.message || '还原了')
                          reload()
                        },
                      })
                    : h(ConfirmLink, {
                        label: '用它恢复', confirmLabel: '确认暂存这份备份', disabled: busy,
                        /** 零上传：文件已经在 backups/ 里，把名字交给宿主就行 */
                        onConfirm: () => stageBackup('/backup/restore-local', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ name: b.name }),
                        }),
                      }),
                )))
            : h('div', { className: 'roost-empty' }, '还没有备份。'),
          backups.length > 20
            ? h('div', { className: 'roost-note' }, `只列最近 20 份，共 ${backups.length} 份。`)
            : null,
        ),

        h(Sec, { n: '04', title: '不会带过去的' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '照打包规则实列。下面这些随时能重建、或者本来就不该复制出去：'),
          h('div', { style: { display: 'grid', gap: 4 } }, [
            ['backups/', '备份自身（例外：pre-retention-*.json 行级原文会带走）'],
            ['.restore/ 与恢复标记', '整包恢复的暂存，换电脑不需要'],
            ['logs/ · tmp/ · voice-cache/ · archive-cache/', '日志与缓存'],
            ['secrets/', '扩展长期令牌明文，故意排除'],
            ['.market-tmp/ · node_modules/', '安装暂存与依赖'],
            ['.tmp · SQLite WAL/SHM · 单文件 >2GB', '临时文件与超大文件'],
          ].map(([k, v], i) => h('div', { key: i, className: 'roost-note' }, '· ' + k + '：' + v))),
          h('div', { className: 'roost-note', style: { marginTop: 8 } },
            '整包上限 4GB、解包总量上限 512MB（防 zip 炸弹）。往云端推是加密后的（第 05 节）。'),
        ),

        /** 4.3/4.4：定时备份 + 加密云备份。与定时 tick 同一个 runBackup */
        h(Sec, { n: '05', title: '定时备份与云备份' },
          h('div', { className: 'roost-note', style: { marginTop: 0 } },
            '每天到点自动导一份 zip 到本地，留最近几份；配了远端就先 AES 加密再推——口令没配就拒推，不推明文。'),
          h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' } },
            h('label', { className: 'roost-note', style: { margin: 0, display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                type: 'checkbox', checked: bkDraft?.enabled !== undefined
                  ? bkDraft.enabled
                  : sched.enabled === true,
                onChange: (e) => setBkDraft({ ...bkDraft, enabled: e.target.checked }),
              }),
              '每天自动备份'),
            h('label', { className: 'roost-note', style: { margin: 0, display: 'flex', gap: 6, alignItems: 'center' } },
              '点（0–23，默认 4）：',
              h('input', {
                type: 'number', min: 0, max: 23, className: 'roost-input', style: { width: 64 },
                value: sval('hour', 4), onChange: (e) => setBkDraft({ ...bkDraft, hour: e.target.value }),
              })),
            h('label', { className: 'roost-note', style: { margin: 0, display: 'flex', gap: 6, alignItems: 'center' } },
              '留最近几份：',
              h('input', {
                type: 'number', min: 1, max: 60, className: 'roost-input', style: { width: 64 },
                value: sval('keep', 7), onChange: (e) => setBkDraft({ ...bkDraft, keep: e.target.value }),
              })),
            h('button', {
              type: 'button', className: 'roost-primary', disabled: !saveCfg || bkDraft === null,
              onClick: () => {
                const hour = Number(sval('hour', 4))
                const keep = Number(sval('keep', 7))
                if (!(hour >= 0 && hour <= 23)) return toast('时刻得在 0–23')
                if (!(keep >= 1)) return toast('至少留一份')
                putBackup({ schedule: { enabled: bkDraft?.enabled === true, hour, keep } })
              },
            }, '保存定时'),
          ),
          h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 12, alignItems: 'center' } },
            h('label', { className: 'roost-note', style: { margin: 0, display: 'flex', gap: 6, alignItems: 'center' } },
              '远端：',
              h('select', {
                className: 'roost-input', style: { width: 150 },
                value: remote.kind || '',
                onChange: (e) => saveCfg && putBackup({ remote: { ...remote, kind: e.target.value } }),
              },
                h('option', { value: '' }, '不推云端'),
                h('option', { value: 'gitee' }, 'Gitee 私有仓'),
                h('option', { value: 'webdav' }, 'WebDAV'))),
            remote.kind === 'gitee'
              ? ['owner', 'repo', 'token'].map((k) => h('input', {
                  key: k, className: 'roost-input', style: { width: k === 'token' ? 220 : 120 },
                  placeholder: k === 'token' ? '私人令牌' : k,
                  value: String(remote.gitee?.[k] ?? ''),
                  onChange: (e) => putBackup({ remote: { ...remote, gitee: { ...(remote.gitee || {}), [k]: e.target.value } } }),
                }))
              : null,
            remote.kind === 'webdav'
              ? ['url', 'user', 'pass'].map((k) => h('input', {
                  key: k, className: 'roost-input', style: { width: k === 'url' ? 220 : 120 },
                  placeholder: k === 'url' ? 'https://…/dav' : (k === 'pass' ? '密码' : k),
                  type: k === 'pass' ? 'password' : 'text',
                  value: String(remote.webdav?.[k] ?? ''),
                  onChange: (e) => putBackup({ remote: { ...remote, webdav: { ...(remote.webdav || {}), [k]: e.target.value } } }),
                }))
              : null,
            h('input', {
              className: 'roost-input', style: { width: 180 }, type: 'password',
              placeholder: '加密口令（必填才推）', value: String(remote.passphrase ?? ''),
              onChange: (e) => saveCfg && putBackup({ remote: { ...remote, passphrase: e.target.value } }),
            }),
          ),
          remote.kind === 'gitee'
            ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
              'Gitee 仓库必须设为私有——推送前会硬校验 private，公开仓直接拒绝（记忆里有隐私）。令牌要有该仓库的写权限。')
            : null,
          remote.kind === 'webdav'
            ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
              'WebDAV 目录不存在时多数服务器会自动创建；鉴权失败和网络失败会分开报，不是一句「备份失败」。')
            : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: pushBusy || busy,
              onClick: runNow,
            }, pushBusy ? '备份中…' : '立即备份并推送'),
            h('span', { className: 'roost-note', style: { margin: 0 } },
              '没配远端时只做本地备份（等同第 01 节导出，多留一份在 backups/ 目录）。'),
          ),
          pushResult
            ? h('div', { className: 'roost-note', style: { marginTop: 8 } },
                pushResult.ok
                  ? `本地已生成 ${pushResult.name || ''}`
                    + (pushResult.remote
                      ? (pushResult.remote.ok
                        ? `；已加密推到 ${remote.kind === 'gitee' ? 'Gitee' : 'WebDAV'}`
                        : `；但云备份没推成【${pushResult.remote.reason || 'unknown'}】：${pushResult.remote.message}`)
                      : '')
                  : `失败：${pushResult.message}`)
            : null,
        ),
      )
    }

    /* ---------------- 主动搭话 ---------------- */

    /**
     * 心情：从「主动搭话」里拆出来的一页。
     *
     * 原来它是 awake 的第 02 节。但「她现在心情怎么样」是**读数**，
     * 「她什么时候会来找你」是**排期**——两件事混在一页，想看一眼心情
     * 得先滚过整块「这一轮算出来的机会」。拆开之后两边都变短了。
     */
    function MoodTab({ mood, reloadMood, toast, quick, config, saveCfg }) {
      /** 3.5：半衰期与基线草稿。null = 跟随配置，失焦提交后清空 */
      const [moodDraft, setMoodDraft] = useState(null)
      const moodCfg = config?.mood || {}
      const putMood = async (patch) => {
        if (!saveCfg) return
        const r = await saveCfg({ mood: patch })
        toast(r?.ok === false ? (r.message || '没存上') : '已保存，下一轮衰减就生效')
        setMoodDraft(null)
      }
      const dval = (k) => (moodDraft !== null && moodDraft[k] !== undefined
        ? moodDraft[k]
        : String(moodCfg[k] ?? ''))
      return h('div', null,
        h(Sec, { n: '01', title: '此刻情绪' },
          mood
            ? h('div', null,
                h('div', { className: 'roost-mood' },
                  MOOD.map((m) => {
                    const v = Math.max(-1, Math.min(1, Number(mood[m.key] ?? 0)))
                    return h('div', { key: m.key, className: 'roost-mood-row' },
                      h('span', { className: 'roost-mood-k' }, m.label),
                      h(Bar, { v, bi: m.bi, tone: m.tone }),
                      h('span', { className: 'roost-mood-w' }, wordOf(v, m.words, m.bi)),
                    )
                  }),
                ),
                h('div', { className: 'roost-note' },
                  mood.reason ? '原因：' + mood.reason : '还没被什么事影响过',
                  mood.updatedAt ? ' · ' + ago(mood.updatedAt) : '',
                ),
                h('div', { className: 'roost-note' },
                  '心情左边差、右边好；另两条从左到右是程度。这三项只决定她要不要主动开口、开口时什么语气，'
                  + '不会当成数字喂给模型；没人理她，几小时后会自己回到中间。'),
                h('div', { className: 'roost-note' },
                  '这三条是读数、不能拖——她的情绪由聊天的结果自己变；想影响就用下面的赞 / 踩。'),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '手动喂一次反馈：'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: async () => {
                      const r = await post('/mood', { feedback: 'LIKE' })
                      toast(r?.ok === false ? (r.message || '没记上') : '记了个赞')
                      reloadMood()
                    },
                  }, '👍 赞'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: async () => {
                      const r = await post('/mood', { feedback: 'UNLIKE' })
                      toast(r?.ok === false ? (r.message || '没记上') : '记了个踩')
                      reloadMood()
                    },
                  }, '👎 踩'),
                ),
              )
            : h('div', { className: 'roost-empty' }, '读不到情绪——插件刚起来时会空几秒'),
        ),

        /** 3.5：衰减参数。不变量（半衰期≥0.5h、基线 0.45–0.9）由后端 paramsOf 夹紧，
         *  这里只挡明显手滑（负数/超界就提示），真写了坏值后端也会救回来 */
        h(Sec, { n: '02', title: '衰减与基线' },
          h('div', { className: 'roost-note', style: { marginTop: 0 } },
            '没人理她时，情绪按指数衰减回中性：半衰期越长，一次开心/生气影响得越久。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('label', { className: 'roost-note', style: { margin: 0 } }, '半衰期（小时，默认 4）：'),
            h('input', {
              type: 'number', min: 0.5, max: 168, step: 0.5, className: 'roost-input',
              style: { width: 90 }, value: dval('halfLifeHours'),
              onChange: (e) => setMoodDraft({ ...moodDraft, halfLifeHours: e.target.value }),
            }),
            h('label', { className: 'roost-note', style: { margin: 0 } }, '基线（0.45–0.9，默认 0.5）：'),
            h('input', {
              type: 'number', min: 0.45, max: 0.9, step: 0.05, className: 'roost-input',
              style: { width: 90 }, value: dval('baseline'),
              onChange: (e) => setMoodDraft({ ...moodDraft, baseline: e.target.value }),
            }),
            h('button', {
              type: 'button', className: 'roost-primary', disabled: !saveCfg || moodDraft === null,
              onClick: () => {
                const half = Number(dval('halfLifeHours'))
                const base = Number(dval('baseline'))
                if (!(half > 0)) return toast('半衰期得是正数')
                if (base < 0.45 || base > 0.9) return toast('基线要在 0.45–0.9 之间（必须高于低阈值 0.4）')
                putMood({ halfLifeHours: half, baseline: base })
              },
            }, '保存'),
          ),
          h('div', { className: 'roost-note' },
            '基线是衰减的落点，不是她「平时多开心」的开关：低于 0.45 会被后端夹回 0.45——衰减必须能停在低阈值之上，否则「有点累」会从事件变成常态。'),
        ),

        h(Sec, { n: '03', title: '变化记录' },
          (mood?.history || []).length
            ? h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 180 } },
                mood.history.map((x, i) =>
                  h('div', { key: i, className: 'roost-item' },
                    h('span', { className: 'd' }, x.at ? ago(x.at) : (x.time || '')),
                    h('span', { className: 't' }, x.reason || x.source || '—'),
                  )))
            : h('div', { className: 'roost-empty' }, mood ? '还没有心情变化' : '读不到心情数据'),
          h(ConfirmLink, {
            label: '清空心情历史', confirmLabel: '确认清空（当前心情不动）',
            onConfirm: async () => {
              const r = await quick('mood.history.clear')
              toast(r.message || (r.ok ? '已清空' : '清空失败'))
              reloadMood()
            },
          }),
        ),
      )
    }

    /**
     * 自驱引擎（实验，默认关）。
     *
     * 这一页刻意**不把「开始」做成大按钮**：它是唯一「没人叫她、她自己做事」的
     * 功能，误触的代价是花钱 + 无人值守的动作。所以顺序是「先看候选 → 再立项 →
     * 再推进」，每一步都要人点。
     *
     * 账本那栏是重点：它显示链是否完整、断在第几条。她可以骗人，但不能骗账本。
     */
    function AutotelicCard({ toast, config, saveCfg }) {
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState('')
      const [seeds, setSeeds] = useState('')
      const [seedsDirty, setSeedsDirty] = useState(false)
      const [preview, setPreview] = useState(null)
      const [ledger, setLedger] = useState(null)
      const [review, setReview] = useState('')

      const load = useCallback(async () => {
        const r = await get('/autotelic/status')
        if (r?.ok === false) return
        setSt(r)
        if (!seedsDirty) setSeeds((r.cfg?.seeds || []).join('\n'))
      }, [seedsDirty])
      useEffect(() => { load() }, [load])

      const patch = async (p) => {
        const r = await saveCfg({ autotelic: p })
        if (r?.ok === false) return toast(r.message || '没存上')
        await load()
      }

      const saveSeeds = async () => {
        const list = seeds.split('\n').map((x) => x.trim()).filter(Boolean)
        const r = await post('/autotelic/seeds', { seeds: list })
        setSeedsDirty(false)
        toast(r.message || '已保存')
        await load()
      }

      const run = async (what) => {
        setBusy(what)
        /** 逐条写死路径：动态拼 `/autotelic/` + what 会让「路由对齐」检查找不到入口 */
        const r = what === 'review'
          ? await post('/autotelic/review', {})
          : what === 'preview'
            ? await get('/autotelic/preview')
            : what === 'think'
              ? await post('/autotelic/think', {})
              : await post('/autotelic/step', {})
        setBusy('')
        if (r?.ok === false) return toast(r.reason || r.message || '没成')
        if (what === 'preview') { setPreview(r); return }
        if (what === 'review') { setReview(r.text || ''); await load(); return }
        if (what === 'think') toast(`立项：${r.project?.text || ''}`)
        if (what === 'step') toast('推进了一步')
        await load()
      }

      const showLedger = async () => {
        const r = await get('/autotelic/recent?limit=20')
        setLedger(ledger ? null : (r?.rows || []))
      }

      const c = config?.autotelic || {}
      const t = st?.today
      const chain = st?.ledger?.chain

      return h(Sec, {
        title: '自驱引擎（实验）',
        right: h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => patch({ enabled: c.enabled !== true }),
        }, c.enabled ? '关掉' : '打开'),
      },
        h('div', { className: 'roost-note', style: { marginBottom: 8 } },
          '给她一点自己的时间：自己挑一件事琢磨、记进哈希链账本。默认全关——'
          + '不开就一行代码都不跑；开了也默认只能想、不能动手，产物只进账本和这里，不会发到 QQ。'),

        h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, marginBottom: 8 } },
          h('span', null, c.enabled ? '● 已开' : '○ 关着'),
          h('span', null, `今天：立项 ${t?.projects ?? 0} · 推进 ${t?.steps ?? 0} · 被拦 ${t?.denies ?? 0}`),
          h('span', { style: { color: chain?.ok ? 'var(--ok)' : 'var(--bad)' } },
            chain?.ok ? `账本 ${st?.ledger?.total ?? 0} 条，链完整` : `账本断在第 ${st?.ledger?.brokenAt} 条`),
          st?.stuck ? h('span', { style: { color: 'var(--warn)' } }, '连续失败后卡住了') : null),

        st?.project
          ? h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            `当前在想：${st.project.text}（已推进 ${st.project.steps ?? 0} 次）`)
          : null,

        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
            h('input', {
              type: 'checkbox', checked: c.allowAct === true,
              onChange: (e) => patch({ allowAct: Boolean(e.target.checked) }),
            }), '允许动手（关着只能想）'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 } },
            '一天最多',
            h('input', {
              className: 'roost-input', type: 'number', min: 0, max: 24,
              style: { width: 60 }, value: c.maxPerDay ?? 2,
              onChange: (e) => patch({ maxPerDay: Number(e.target.value) }),
            }), '次')),

        h('div', { style: { fontSize: 11.5, marginBottom: 6 } }, '她想琢磨的方向（一行一个，空着就不立项）：'),
        h('textarea', {
          className: 'roost-input', rows: 3, value: seeds,
          placeholder: '比如：怎么把话说得更像人 / 群里冷场时该说什么',
          style: { width: '100%', resize: 'vertical', fontSize: 12 },
          onChange: (e) => { setSeeds(e.target.value); setSeedsDirty(true) },
        }),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
          h('button', { type: 'button', className: 'roost-btn', disabled: !seedsDirty, onClick: saveSeeds }, '保存种子'),
          h('button', { type: 'button', className: 'roost-btn', disabled: Boolean(busy), onClick: () => run('preview') },
            busy === 'preview' ? '算着…' : '看会选哪个'),
          h('button', { type: 'button', className: 'roost-btn', disabled: Boolean(busy), onClick: () => run('think') },
            busy === 'think' ? '想…' : '立项（想一轮）'),
          h('button', { type: 'button', className: 'roost-btn', disabled: Boolean(busy), onClick: () => run('step') },
            busy === 'step' ? '推进中…' : '推进一步'),
          h('button', { type: 'button', className: 'roost-btn', disabled: Boolean(busy), onClick: () => run('review') }, '今日复盘'),
          h('button', { type: 'button', className: 'roost-btn', onClick: showLedger }, ledger ? '收起账本' : '看账本')),

        preview
          ? h('div', { className: 'roost-note', style: { marginTop: 8 } },
            preview.ok
              ? `会选：${preview.project.text}（分 ${preview.project.score}）`
              : `选不出来：${preview.reason}`,
            (preview.rejected || []).length
              ? h('div', { style: { fontSize: 11, marginTop: 4 } },
                '先放着：' + preview.rejected.map((x) => `${x.text}（${x.reason}）`).join('；'))
              : null)
          : null,

        review
          ? h('div', { className: 'roost-note', style: { marginTop: 8, whiteSpace: 'pre-wrap' } }, review)
          : null,

        ledger
          ? h('div', { className: 'roost-list roost-scroll', style: { marginTop: 8, maxHeight: 220 } },
            ledger.length === 0
              ? h('div', { className: 'roost-empty' }, '还没有记录')
              : ledger.map((r) => h('div', { key: r.seq, className: 'roost-item' },
                h('span', { className: 'd' }, `#${r.seq}`),
                h('span', { className: 't' },
                  h('span', { className: 'roost-muted', style: { fontSize: 10.5, marginRight: 6 } }, r.kind),
                  String(r.note || '').slice(0, 120)))))
          : null,
      )
    }

    function AwakeTab({ aw, mem, sp, chats, toast, reload, reloadSp, busy, quick, config, saveCfg }) {
      const cfg = aw?.cfg || {}
      const opps = aw?.lastOpportunities || []
      const groups = aw?.groups || []
      const [authChat, setAuthChat] = useState('')
      const [authScope, setAuthScope] = useState('group_push')
      const state = sp?.state || {}
      const spCfg = sp?.cfg || {}
      /**
       * 能不能手动走一次。
       *
       * `ready === false` 只会在**没配主人 openid** 时出现（宿主 `/speakup`
       * 的判定）。老宿主不返回这个字段，`undefined` 按「可以」处理，
       * 不会因为版本不齐就把按钮全锁了。
       */
      const spReady = sp?.ready !== false
      const spWhy = sp?.why || '不知道发给谁'
      /** 扩展素材队列：装了扩展才会有人往里投，所以默认 null（还没读到）也算正常 */
      const [extQ, setExtQ] = useState(null)
      const reloadExtQ = async () => {
        try { setExtQ(await get('/ext-proactive/state')) } catch { /* 面板读不到不影响别的卡片 */ }
      }
      useEffect(() => { reloadExtQ() }, [])
      /**
       * 收件人从哪来的。
       *
       * 必须标出来——否则人会以为是自己填过 `speakUp.chatId`，
       * 换掉 Roost 的 owners 之后发现「怎么没跟着变」，找不到原因。
       */
      const OWNER_FROM = {
        config: '面板里填的',
        roost: '取自 Roost 的 owners',
        learned: '从主人私聊里认到的',
      }

      /**
       * 待确认的主动消息（桥 3）。
       *
       * 挂载时只读（`GET /delivery` 是读文件，不花钱）；点「回查一次」才
       * 真的回查一次（`POST`）。反过来做的话每次切到这个页签都会
       * 打一轮 HTTP，而结果本来就不急在这一分钟。
       */
      const [deliv, setDeliv] = useState(null)
      const loadDeliv = useCallback(async (hit = false) => {
        const r = hit ? await post('/delivery', {}) : await get('/delivery')
        setDeliv(r?.ok === false ? null : r)
        if (hit && r?.ok !== false) {
          toast(`查了 ${r.checked ?? 0} 条，结案 ${(r.settled || []).length} 条，还有 ${r.pending ?? 0} 条在等`)
        }
        return r
      }, [toast])
      useEffect(() => { loadDeliv(false) }, [loadDeliv])

      /**
       * 4.6 互动召回（官方 is_wakeup）：和「私聊排期」两本账。
       * 状态只读拉一次，点「立刻走一次」才真的发消息。
       */
      const [wk, setWk] = useState(null)
      const loadWake = useCallback(async () => {
        const r = await get('/wakeup/status')
        setWk(r?.ok === false ? null : r)
        return r
      }, [])
      useEffect(() => { loadWake() }, [loadWake])
      const wakeCfg = { ...(config?.wakeup || {}) }
      const wakeOn = wakeCfg.enabled === true
      const runWakeNow = async () => {
        const r = await post('/wakeup/run-now', {})
        toast(r?.ok ? (r.message || '已发出') : (r?.message || '这次没发'))
        await loadWake()
      }

      return h('div', null,
        h(Sec, {
          title: '互动召回',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: loadWake }, '刷新'),
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '官方口径：用户主动说过话之后的 30 天内，当天 / 1–3 天 / 3–7 天 / 7–30 天四个窗口各 1 条，合计 4 条。',
            '超过 30 天没有额度；用户再说一句会开启新一轮。和下面的「私聊排期」是两本账，互不占额度。'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 } },
            h('input', {
              type: 'checkbox', checked: wakeOn,
              onChange: async (e) => {
                const r = await saveCfg({ wakeup: { ...wakeCfg, enabled: Boolean(e.target.checked) } })
                toast(r?.ok === false ? (r.message || '没存上') : (wakeOn ? '已关掉互动召回' : '已开启互动召回'))
              },
            }), '开启互动召回（默认关）'),
          h('div', { style: { margin: '8px 0', display: 'flex', gap: 8, flexWrap: 'wrap' } },
            (wk?.windows || []).map((w) => h('span', {
              key: w.id,
              className: 'roost-muted',
              style: {
                fontSize: 11.5, padding: '2px 8px', borderRadius: 6,
                border: '1px solid var(--line)',
                opacity: w.used ? 0.55 : 1,
              },
              title: w.used ? '这一档已经发过' : '这一档还可以发 1 条',
            }, `${w.label} · ${w.used ? '已用' : '可用'}`)),
          ),
          h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginBottom: 8 } },
            wk
              ? `${wk.enabled ? '开着' : '关着'} · ${wk.why || ''}${wk.owner ? ' · 收件人已识别' : ' · 还没认出主人 openid'}`
              : '读取互动召回状态…'),
          h('button', { type: 'button', className: 'roost-btn', disabled: Boolean(busy), onClick: runWakeNow }, '立刻走一次（仍守官方额度）'),
        ),
        h(Sec, { n: '01', title: '这一轮算出来的机会', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '重算') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '不是"到点就发"，是"到点问她要不要说"。她自己可以选不说——那不算失败，也不占当天的额度。'),
          opps.length
            ? h('div', { className: 'roost-list' },
                opps.map((o, i) =>
                  h('div', { key: i, className: 'roost-item' },
                    h('span', { className: 't' },
                      h(Pill, { tone: o.kind === 'agreement' ? 'ok' : null },
                        o.kind === 'agreement' ? '约定' : o.kind === 'miss' ? '想你' : '随性'),
                      ' ',
                      o.reason,
                    ),
                    h('span', { className: 'd' }, o.score.toFixed(2)),
                  ),
                ),
              )
            : h('div', { className: 'roost-empty' },
                cfg.enabled === false
                  ? '主动说话关着（去「权限 → 她会做什么」打开「先想想要不要开口」）'
                  : '现在没有值得开口的理由 —— 这是正常的，不是坏了。'),
          h('div', { className: 'roost-note' },
            `清醒时段 ${cfg.awakeFrom ?? 8}–${cfg.awakeTo ?? 23} 点 · 沉默超过 ${cfg.missAfterHours ?? 6} 小时算「想你」 · 随性每天最多 ${cfg.casualPerDay ?? 1} 次`),

          /**
           * 「上次的决定」原来是独立一节，但只有两行读数，
           * 而且它讲的还是上一轮的机会——和上面那节是同一件事，
           * 拆开反而把「机会 → 排期」的因果链切断了。
           * 现在并到这一节底部，当成「上一轮的结果」。
           */
          h('div', { className: 'roost-note', style: { marginTop: 6 } },
            aw?.lastKind
              ? '上一轮：' + (aw.lastKind === 'agreement' ? '约定' : aw.lastKind === 'miss' ? '想你' : '随性')
                + (aw.lastWhy ? '（' + aw.lastWhy + '）' : '')
              : '上一轮：还没醒过。'),
        ),

        /* 私聊排期：speakup.js 管"什么时候轮到她"，awake 只管"要不要说" */
        h(Sec, { n: '02', title: '私聊排期', right: h('button', { type: 'button', className: 'roost-btn', onClick: reloadSp }, '刷新') },
          h(Row, { k: '发给' },
            sp?.owner
              ? `${String(sp.owner).slice(0, 8)}…（${OWNER_FROM[sp.ownerFrom] || '未知来源'}）`
              : '还不知道发给谁'),
          h(Row, { k: '下次' }, state.nextAt ? ago(state.nextAt).replace('前', '后') : '还没排'),
          h(Row, { k: '今天' }, `${state.day && state.day === new Date().toDateString() ? state.todayCount : 0} / ${spCfg.maxPerDay ?? 3} 次`),
          h(Row, { k: '上次' },
            state.lastBotAt
              ? `${ago(state.lastBotAt)}${state.lastText ? '：' + state.lastText : ''}`
              : '还没主动说过'),
          /**
           * 「连着几条没被回」——这是「她怎么不追了」的直接答案。
           *
           * 不显示的话，主人不回她、她停下来，看起来就跟坏了一样。
           */
          h(Row, { k: '追问' },
            Number(state.unanswered || 0) > 0
              ? `连着 ${state.unanswered} 条没被回（上限 ${spCfg.followUps ?? 1} 次追问）`
              : '没有欠着的'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: busy || !spReady,
              title: spReady ? '' : spWhy,
              onClick: async () => {
                if (!spReady) return toast(spWhy)
                const r = await post('/speakup/fire', {})
                toast(r.ok ? '说了：' + (r.text || '') : (r.why || r.message || '这次没说'))
                reloadSp()
                reload()
              },
            }, '立刻走一次私聊流程'),
          ),
          h('div', { className: 'roost-note' },
            spReady
              ? (sp?.ownerFrom === 'config'
                ? '间隔随机、免打扰、每日上限都在这里管；「要不要说」交给上面的机会判断。'
                : '收件人是从 Roost 那边自动取的，不用在这填。想换人就去 Roost 面板改主人，或者在这里填会话号覆盖它。')
              : `暂时不能手动触发：${spWhy}。在 Roost 面板上把主人配好，这个按钮就会亮。`),
        ),

        /**
         * 扩展主动消息（0.4）：扩展只投素材，措辞由模型写、门闸与审批在宿主。
         * 放这一页是因为它和「私聊排期」共用同一本主动开口账，拆到别处会让人
         * 以为两条线互不干扰，结果一天里被找了两次都不知道去哪调。
         */
        h(Sec, { n: '03', title: '扩展主动消息', right: h('button', { type: 'button', className: 'roost-btn', onClick: reloadExtQ }, '刷新') },
          h(Row, { k: '通道' }, extQ ? (extQ.enabled ? '开着' : '关着') : '读取中…'),
          h(Row, { k: '今天' }, extQ ? `${extQ.sentToday} / ${extQ.maxPerDay} 条` : '—'),
          h(Row, { k: '排队 / 待批' }, extQ ? `${extQ.queued} / ${extQ.awaiting}` : '—'),
          (extQ?.items || []).filter((x) => x.state === 'awaiting').slice(0, 5).map((x, i) =>
            h('div', { key: x.id, style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
              h('span', { className: 'roost-muted', style: { fontSize: 11.5, flex: 1 } }, `${i + 1}. ${x.cause} · ${x.text}`),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: async () => {
                  await get('/ext-proactive/decide?index=' + (i + 1) + '&action=approve')
                  toast('已批准，正在走门闸')
                  reloadExtQ()
                },
              }, '发'),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: async () => {
                  await get('/ext-proactive/decide?index=' + (i + 1) + '&action=reject')
                  toast('已放弃这条')
                  reloadExtQ()
                },
              }, '不发'),
            ),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: async () => {
                const r = await get('/ext-proactive/drain')
                toast(r?.sent ? '发出去了：' + (r.text || '') : (r?.why || '这次没发'))
                reloadExtQ()
              },
            }, '立刻跑一次队列'),
          ),
          h('div', { className: 'roost-note' },
            '扩展只交「有什么值得说」，由她自己决定说不说、怎么说。免打扰时段和她要求安静时会自动排队等下一次；发群还要 group_push 授权。'),
        ),

        /**
         * 对话收尾（2026-11-12 从「记忆」页搬来）。
         *
         * 它决定的是「这段聊完了没有、什么时候可以再开口」，属于**开口时机**，
         * 不是「记住了什么」。放回主动搭话这一页之后，记忆页只剩纯数据。
         */
        h(Sec, {
          n: '04',
          title: '对话收尾',
          right: mem?.closing?.stat
            ? h(Pill, null, `${mem.closing.stat.total} 个会话`)
            : null,
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '她判断这段聊完了，就记一句「收在哪 / 下次怎么接」——不发言，也不动记忆。'
            + '下一轮接得上；刚说完晚安 90 分钟内不会再随性搭话。只做私聊。'),
          !mem?.closing?.chats?.length
            ? h('div', { className: 'roost-note' }, '还没有收尾记录。')
            : mem.closing.chats.map((c) =>
                h(Row, { key: c.chatId, k: String(c.chatId || '').slice(0, 8) },
                  h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start' } },
                    h('div', { style: { flex: 1, minWidth: 0 } },
                      h('div', null, c.point),
                      c.resume
                        ? h('div', { className: 'roost-note' }, '下次：' + c.resume)
                        : null,
                      h('div', { className: 'roost-note' },
                        sinceText(c.at) + (c.why ? ' · ' + c.why : '')),
                    ),
                    h('button', {
                      className: 'roost-btn',
                      onClick: async () => {
                        const r = await post('/closing/clear', { chatId: c.chatId })
                        toast(r.ok === false ? (r.message || '没清成') : '清掉了')
                        reload()
                      },
                    }, '忘掉'),
                  ),
                ),
              ),
        ),

        h(Sec, { n: '05', title: '群聊主动（默认全关）' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '群里主动说话极易被踢。四道门全过才会说：白名单显式开 → 有 group_push 授权 → 不在静默时段 → 当天没到上限且真冷场。'),
          groups.length
            ? h('div', { className: 'roost-list' },
                groups.map((g) =>
                  h('div', { key: g.chatId, className: 'roost-item' },
                    h('span', { className: 't' }, g.name),
                    h('span', { className: 'd' }, g.ok ? h(Pill, { tone: 'ok' }, '可以说') : h(Pill, null, g.why)),
                  ),
                ),
              )
            : h('div', { className: 'roost-empty' },
                '白名单是空的 —— 一个群都不会主动说话。要开得在设置里写 ',
                h('span', { className: 'roost-code' }, 'awake.groups'),
                '。'),

          h('div', { style: { marginTop: 12 } },
            h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } },
              '授权：只有群主动需要（官方硬前置，没这条记录群主动发不出去）。私聊主动不需要授权——发给主人本来就是她能做的事。'),
            mem?.authz
              ? h('div', { className: 'roost-item' },
                  h('span', { className: 't' }, `当前会话已授权：${mem.authz.scope}`),
                  h('span', { className: 'd' }, ago(mem.authz.at)),
                )
              : h('div', { className: 'roost-empty' }, '当前会话还没有授权记录'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('input', {
                className: 'roost-input', placeholder: '群 chatId（可从「会话」页复制）',
                value: authChat, onChange: (e) => setAuthChat(e.target.value), style: { flex: 1, minWidth: 200 },
              }),
              h('select', {
                className: 'roost-input', value: authScope, onChange: (e) => setAuthScope(e.target.value),
                style: { width: 130, flex: '0 0 130px' },
              },
                h('option', { value: 'group_push' }, '群主动'),
              ),
              h('button', {
                type: 'button', className: 'roost-primary',
                onClick: async () => {
                  const id = authChat.trim() || mem?.chatId || ''
                  if (!id) return toast('先填一个 chatId')
                  const r = await post('/authz', { chatId: id, scope: authScope, type: 'manual' })
                  toast(r.ok === false ? (r.message || '没记上') : '授权记下了')
                  setAuthChat('')
                  reload()
                },
              }, '记一条授权'),
            ),
            (chats || []).length
              ? h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 } },
                  chats.slice(0, 8).map((c) =>
                    h('button', {
                      key: c.chatId, type: 'button', className: 'roost-btn',
                      onClick: () => setAuthChat(c.chatId),
                    }, (c.title || c.chatId.slice(0, 8))),
                  ),
                )
              : null,
          ),
        ),

        h(Sec, { n: '06', title: '现在试一次' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '私聊直接问一次要不要说；群里跑一遍四道门。真发出去会出现在 QQ 上。'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy,
              onClick: async () => {
                const r = await post('/awake', {})
                toast(r.spoke
                  ? (r.pending ? '说了，但在等审核：' : '她说了：') + (r.text || '')
                  : (r.why || '这次没说'))
                reload()
              },
            }, busy ? '问着…' : '问一次私聊'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: async () => {
                const r = await post('/awake', { target: 'group' })
                const said = (r.results || []).filter((x) => x.ok)
                const wait = said.filter((x) => x.pending).length
                toast(said.length
                  ? `在 ${said.length} 个群说了${wait ? `，其中 ${wait} 条在等审核` : ''}`
                  : '群里一个都没说')
                reload()
              },
            }, '跑一遍群白名单'),
          ),
        ),
        h(Sec, { n: '07', title: '待确认的主动消息', right: h('button', { type: 'button', className: 'roost-btn', onClick: () => loadDeliv(true) }, '回查一次') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '主动消息要过内容审核。进审核时接口只回「待审核」——既不是送到也不是没送到，'
            + '而审核结果推给的是 Roost 那边（持有 QQ 连接那个进程），这边收不到。'
            + '所以过十分钟自己回来问一次。'
            + '「不确定」和「失败」要分清楚：失败的可以再发一次，不确定的重发会让你收到两条。'),
          deliv === null
            ? h('div', { className: 'roost-empty' },
                '读不到这一节。两种可能：DSH 还没重启（新路由没加载），'
                + '或者 Roost 没在跑（面板读的是它那边写的数据）。')
            : (() => {
                const items = deliv.items || []
                if (!items.length) return h('div', { className: 'roost-empty' }, '没有要跟踪的消息。一切正常。')
                return h('div', { className: 'roost-list' },
                  items.slice(0, 12).map((x) =>
                    h('div', { key: x.requestId, className: 'roost-item' },
                      h('span', { className: 't' },
                        h(Pill, {
                          tone: x.state === 'sent' ? 'ok' : x.state === 'failed' || x.state === 'unknown' ? 'bad' : null,
                        }, DELIV_STATE[x.state] || x.state),
                        ' ',
                        (x.scene === 'group' ? '群 ' : '私聊 ') + (x.text || '（无正文）'),
                      ),
                      h('span', { className: 'd' }, ago(x.at)),
                    ),
                  ),
                )
              })(),
          h('div', { className: 'roost-note', style: { marginTop: 6 } },
            deliv
              ? `共 ${deliv.total ?? 0} 条，其中 ${deliv.pending ?? 0} 条还没定论。`
                + '「不确定」不会自动重发——重发可能让对方收到两条，得你自己去 QQ 里看一眼。'
              : ''),
        ),
        /** 07：自驱引擎（实验，默认关）。放在这一页最后——它不是日常操作 */
        h(AutotelicCard, { toast, config, saveCfg }),
      )
    }

    /* ---------------- 上下文（压缩 + 注入） ---------------- */

    /**
     * 2.7：单独进 `context` 隐藏页时保留 01–05 编号；拼进「排障」页时
     * 传 `numbered: false`——那里 LogsTab 已经有一个 01，再来一组 01
     * 会让人以为编号乱了。分区用 `.roost-diag-h` 标题区分，不靠编号。
     */
    function ContextTab({ ctxInfo, mind, usageInfo, stickers, toast, reload, busy, numbered = true }) {
      /** 计费 token = 三个互不重叠的桶之和（和 compact 的命中率同一口径） */
      const billedOf = (b) => Number((b?.uncached || 0) + (b?.cacheRead || 0) + (b?.cacheWrite || 0))
      const p = ctxInfo?.pressure || {}
      const th = ctxInfo?.cfg || {}
      const b = mind?.budgets?.memory || {}
      const pct = p.percent
      /**
       * `usageInfo` 有、但 `total` 缺（老服务端 / 中间层返回 `{}`）时不能直接点。
       * 以前 `usageInfo.total.output` 会抛，整页进 `RenderBoundary` 变成
       * 「面板渲染出错」——「排障」和「上下文」两页都会中。
       */
      const ut = usageInfo?.total || {}

      return h('div', null,
        h(Sec, { n: numbered ? '01' : null, title: '窗口占用', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          pct == null
            ? h('div', { className: 'roost-empty' },
                '读不到占用。服务商还没回报过用量时会这样——这时按轮数兜底：聊到 ',
                h('span', { className: 'roost-code' }, th.maxTurns ?? 40),
                ' 轮会压一次。')
            : h('div', null,
                h('div', { className: 'roost-mood-row', style: { marginBottom: 6 } },
                  h('span', { className: 'roost-mood-k' }, '占用'),
                  h(Bar, { v: pct / 100 }),
                  h('span', { className: 'roost-mood-w' }, pct.toFixed(1) + '%'),
                ),
                h('div', { className: 'roost-note' },
                  `已用 ${(p.projected || p.tokens || 0).toLocaleString()} / ${(p.window || 0).toLocaleString()} tokens`),
              ),
          h('div', { className: 'roost-note' },
            `群聊到 ${th.atPercentGroup ?? 85}%、私聊到 ${th.atPercentC2C ?? 75}% 就换新会话。` +
            '原来定的 60/40 压得太勤：每换一次会话，prompt 缓存就整段失效，' +
            '省下的 token 赔不回变慢的那几步。真正的数字看下一节的「缓存命中」。'),
        ),

        h(Sec, { n: numbered ? '02' : null, title: '压缩' },
          ctxInfo?.last
            ? h('div', null,
                h(Row, { k: '上次' }, `${ago(ctxInfo.last.at)} · 开场 ${ctxInfo.last.openingLen} 字`),
                h(Row, { k: '会话' },
                  h('span', { className: 'roost-mono' }, `${String(ctxInfo.last.from).slice(-8)} → ${String(ctxInfo.last.to).slice(-8)}`),
                ),
              )
            : h('div', { className: 'roost-empty' }, '还没压过'),
          /**
           * 缓存命中率：调阈值的唯一依据。
           *
           * 上面那个数是"压的那一刻旧会话累计多少"——压完就换新会话、
           * 从零开始，所以它没有第二次机会，只能在压的瞬间记下来。
           * 下面那个是当前会话的实时值，两个放在一起看才知道阈值该往哪调。
           */
          h('div', { style: { marginTop: 10 } },
            h(Row, { k: '当前命中' },
              p?.usage?.cacheHit == null
                ? '还没有用量数据'
                : `${p.usage.cacheHit.toFixed(1)}%（读 ${(p.usage.cacheRead || 0).toLocaleString()} / 计费 ${(p.usage.billed || 0).toLocaleString()}）`),
            (ctxInfo?.history || []).slice(-3).reverse().map((h2, i) =>
              h(Row, { k: i === 0 ? '压之前' : '' },
                `${ago(h2.at)} · 占用 ${h2.percent == null ? '—' : h2.percent.toFixed(0) + '%'}`
                + ` · 命中 ${h2.cacheHit == null ? '—' : h2.cacheHit.toFixed(1) + '%'}`),
            ),
          ),
          h('div', { className: 'roost-note' },
            '命中率低 = 缓存反复失效，多半是压得太勤或者注入的东西每轮都在变。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy,
              onClick: async () => {
                const r = await post('/compact', {})
                toast(r.ok ? '换好了，新的开场已经就位' : (r.why || r.message || '没换成'))
                reload()
              },
            }, busy ? '压着…' : '现在就压一次'),
          ),
          h('div', { className: 'roost-note' },
            '换会话不等于删对话：旧会话原样留着，随时回去翻。新会话的第一句会带摘要 + 最近原话 + 没办完的约定。'),
        ),

        h(Sec, { n: numbered ? '03' : null, title: '这一轮注入了什么' },
          !mind
            ? h('div', { className: 'roost-empty' }, '还没聊过，读不到注入内容')
            : h('div', null,
                h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } },
                  `稳定段 ${b.staticLen ?? 0} 字（进 system prompt，缓存可复用）`),
                h('pre', { className: 'roost-pre' }, mind.memoryStaticText || '（空）'),
                h('div', { className: 'roost-muted', style: { fontSize: 12, margin: '10px 0 4px' } },
                  `易变段 ${b.dynamicLen ?? 0} 字（拼在用户消息前，不污染缓存）`),
                h('pre', { className: 'roost-pre' }, mind.memoryDynamicText || '（空）'),
                stickers
                  ? h('div', { className: 'roost-note' },
                      `表情包：order 901 · ${stickers.items?.length || 0} 张 · 约 ${stickers.chars || 0} 字`
                      + '（进稳定段，跟着缓存走）')
                  : null,
                h('div', { className: 'roost-note' },
                  '分成两段就是为了让 system prompt 的前缀保持稳定。每轮都变的东西塞进系统提示，等于每轮主动作废一次缓存。'),
              ),
        ),

        h(Sec, { n: numbered ? '04' : null, title: '记忆工具' },
          mind?.tools
            ? h('div', null,
                h(Row, { k: '状态' },
                  mind.tools.ok
                    ? h('span', null, h(Pill, { tone: 'ok' }, '已挂上'), ' ', mind.tools.names.join('、'))
                    : h('span', null, h(Pill, { tone: 'warn' }, '没挂上'), ' ', mind.tools.reason),
                ),
                h('div', { className: 'roost-note' },
                  '挂上了她才能主动翻日记（memory_search）、主动记东西（memory_note）。没挂上只是少了这两手，自动注入照常。'),
              )
            : h('div', { className: 'roost-empty' }, '还没聊过'),
        ),

        /**
         * 用量：回答用户真正会问的两个问题——这个群这个月花了多少、哪个群最费。
         * 上面那些是「调阈值用的实时数」，这里是「账单口径的累计数」，两回事。
         */
        h(Sec, { n: numbered ? '05' : null, title: '用量' },
          !usageInfo
            ? h('div', { className: 'roost-empty' }, '还没有用量数据（要先聊过，且服务商回报过 usage）')
            : h('div', null,
                h(Row, { k: '近 7 天' },                  /**
                   * **只统计 token，不折算金额。**
                   * 订阅制、免费额度、自建模型都不按 token 收钱，
                   * 硬乘一个单价出来的美元数不是账单，只会误导。
                   */
                  `计费 ${Number(billedOf(ut)).toLocaleString()}`
                  + ` · 输出 ${Number(ut.output || 0).toLocaleString()}`
                  + ` · 命中 ${ut.cacheHit == null ? '—' : ut.cacheHit + '%'}`),
                h(Row, { k: '轮数' }, String(ut.turns || 0)),
                Object.entries(usageInfo.chats || {})
                  .sort((a, b) => billedOf(b[1]) - billedOf(a[1]))
                  .slice(0, 3)
                  .map(([cid, v], i) =>
                    h(Row, { k: i === 0 ? '最多' : '' },
                      `${String(cid).slice(0, 8)} · ${v.turns} 轮 · 计费 ${Number(billedOf(v)).toLocaleString()}`),
                  ),
              ),
          h('div', { className: 'roost-note' },
            '这里只统计 token，不折算金额——订阅制或免费额度下算出来的美元数不是账单。'
            + '按「天 × 会话」记在 data/usage.json，只存数字不存内容。'),
        ),
      )
    }

    /* ---------------- 会话 ---------------- */

    /* ---------------- 能力 ---------------- */

    /**
     * 「能力」页：谁、在哪个群、能调什么。
     *
     * 第一版是**只读**的，只回答一个问题：「它手里现在有什么，分别给了谁」。
     *
     * 为什么先做只读版：这三十多个工具是宿主插件自动继承来的，
     * `gh_*` / `ops_*` / `mcp__*` 在装插件那天就挂上了，主人根本没配过。
     * 先把这件事摆出来，本身就是一次安全改进——而且不改任何行为，零风险。
     *
     * 开关、分群、配额留到后面几版；这一版只有「看」和「启用」。
     */
    /** 四个档位：id / 名字 / 一句话说明。CapsTab 和弹窗都要用，提到外面 */
    /**
     * 五个可配档位，**对齐框架的 0/1/2/3 等级**。
     *
     * 之前只有主人/管理员/群成员三张卡，把群管和助手一起折进了群成员——
     * 主人在框架里给某人配了 3 级，到这儿跟路人一个待遇。
     */
    const CAP_BUCKETS = [
      ['owner', '主人', '你自己'],
      ['admin', '管理员', '框架里配的，跨群有效'],
      ['manager', '群管', '这个群的管理员'],
      ['helper', '助手', '这个群里帮忙的人'],
      ['member', '群成员', '其他所有人'],
    ]

    /**
     * 兜底档：**写死不可配**。
     *
     * 它表示「拿不到权限信息」（插件没给、字段坏了、版本对不上）。
     * 做成可配置就等于留了一个能手动放开的开关，而这一档恰恰是
     * 出问题时的最后一道闸——保持只给聊天，别给它任何操作入口。
     */
    const CAP_FALLBACK = ['unknown', '身份不明', '认不出来的，固定只给聊天']

    /**
     * 通配匹配，和 `capabilities.js` 的 `matchPattern` **同语义**（`*` 跨任意字符）。
     *
     * 前端只需要判断「这条 `deny` 有没有盖住这个工具」，不需要完整策略计算。
     * 两套实现是不得已（前端拿不到那个函数），所以测试里用同一组样例
     * 两边各跑一遍——语义漂了会被抓住。
     */
    function matchPat(name, pattern) {
      if (pattern === '*') return true
      if (!pattern.includes('*')) return pattern === name
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp('^' + pattern.split('*').map(esc).join('[\\s\\S]*') + '$').test(name)
    }

    /**
     * 勾选 / 取消一个工具之后，这一档的 `defaults` 该变成什么样。
     *
     * **纯函数，单独导出给测试**——这段逻辑出过两次事，而且两次都
     * 「渲染正常、不报错」，只有真点一下才看得出来，所以必须能断言。
     *
     * 四种情况要分清，混掉任何一种都会「界面变了、权限没变」：
     *
     *   · 该档有具体 `allow`  → 加 / 减那一项
     *   · 该档是 `*`          → 取消时先展开成具体清单再减（`*` 是无限集，
     *                           没有「除了某个」的写法）；勾上时不用动
     *   · 该档**没有** `allow` → 它在继承更低档。加一项写 `[name]`（增量，
     *                           继承照旧）；**取消一项只能写 `deny`**——
     *                           写 `allow: []` 的语义是「这一档整档清零」
     *   · 该档有 `deny`       → 勾上时要先把盖住它的那条去掉，否则勾了也没用
     *
     * @param {object} o
     * @param {object} o.cur      这一档当前的配置（可能没有 allow / deny）
     * @param {string} o.name     工具名
     * @param {boolean} o.on      true = 勾上
     * @param {string[]} o.expanded 该档 `*` 展开后的实际清单（取消 `*` 里的某一项要用）
     * @returns {object} 新的那一档配置（不含其它档）
     */
    function planToolToggle({ cur, name, on, expanded }) {
      const src = cur && typeof cur === 'object' ? cur : {}
      /** `null` = 没有 `allow` 字段（继承更低档），和空数组不是一回事 */
      let allow = Array.isArray(src.allow) ? [...src.allow] : null
      let deny = Array.isArray(src.deny) ? [...src.deny] : []

      if (on) {
        /** `deny` 会盖住 `allow`：想勾上，先去掉盖着它的那条 */
        deny = deny.filter((p) => !matchPat(name, p))
        if (allow === null) allow = [name]
        else if (!allow.includes('*') && !allow.includes(name)) allow.push(name)
      } else if (allow === null) {
        if (!deny.some((p) => matchPat(name, p))) deny.push(name)
      } else if (allow.includes('*')) {
        allow = (Array.isArray(expanded) ? expanded : []).filter((n) => n !== name)
      } else {
        allow = allow.filter((n) => n !== name)
      }

      const next = { ...src }
      if (allow === null) delete next.allow
      else next.allow = allow
      if (deny.length) next.deny = deny
      else delete next.deny
      return next
    }

    /**
     * 工具权限弹窗：搜索 + 分组 + 四列勾选。
     *
     * 抽成独立组件而不是内联，是为了能单独渲染测试——
     * 内联的话它默认是关着的，测试永远看不到里面的内容，
     * 「弹窗打开后是不是空白」这种问题就只能靠肉眼发现。
     */
    /**
     * 布尔配置开关：复用早就写好、但一直没接上的 `.roost-switch`。
     * 只有「开 / 关」用它；多选清单和二次确认勾选仍用原生 checkbox ——
     * 那两类不是开关，换成滑块反而会被误读成互斥项。
     */
    function Switch({ on, disabled, title, label, onToggle }) {
      return h('button', {
        type: 'button', className: 'roost-switch', role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': label || undefined,
        'data-on': on ? '1' : '0',
        disabled: !!disabled, title: title || undefined,
        onClick: () => onToggle(!on),
      })
    }

    /** 统一确认弹窗：替掉 window.confirm（原生框和面板是两套皮，webview 里还常受限）。 */
    function ConfirmModal({ title, message, confirmText, danger, busy, onConfirm, onClose, extra }) {
      return h('div', { className: 'cap-modal', onClick: onClose },
        h('div', {
          className: 'cap-modal-b', style: { width: 'min(460px,100%)' },
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { className: 'cap-modal-h' },
            h('span', { className: 't' }, title || '请确认'),
            h('button', { type: 'button', className: 'roost-btn', onClick: onClose }, '关闭'),
          ),
          h('div', {
            className: 'cap-modal-c',
            style: { whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.7 },
          }, message),
          /** 可选的表单区：L3 扩展要手打 id 二次确认，其余调用方不受影响 */
          extra || null,
          h('div', {
            className: 'cap-modal-s',
            style: {
              display: 'flex', gap: 8, justifyContent: 'flex-end',
              borderBottom: 0, borderTop: '1px solid var(--line-soft)',
            },
          },
            h('button', { type: 'button', className: 'roost-btn', onClick: onClose }, '取消'),
            h('button', {
              type: 'button', className: danger ? 'roost-btn' : 'roost-primary',
              disabled: !!busy, onClick: onConfirm,
            }, busy ? '处理中…' : (confirmText || '确定')),
          ),
        ),
      )
    }

    /** 整页弹窗：把低频但很长的页（接入向导）从页签栏里挪出来。 */
    function PageModal({ title, onClose, children }) {
      return h('div', { className: 'cap-modal', onClick: onClose },
        h('div', {
          className: 'cap-modal-b', style: { width: 'min(920px,100%)' },
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { className: 'cap-modal-h' },
            h('span', { className: 't' }, title),
            h('button', { type: 'button', className: 'roost-btn', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'cap-modal-c' }, children),
        ),
      )
    }

    /**
     * 首次接入向导（参考 aurabot 的 setupDone 全屏遮罩）。
     *
     * 新装和老用户升级都会弹：这一版移除了 ai-chat，老配置不重新接一遍就是哑的。
     * 四步走完必须由**后端**真跑一次直连自测才允许完成（`/setup/wizard/done`），
     * 前端点「完成」只是发个请求，不能自己宣布成功。
     *
     * 「暂时跳过」是给老版本 Roost 用户的逃生口：对面还没有外接协议时，
     * 得让人进得了面板去升级，否则锁死在向导里什么都做不了。
     */
    const WIZ_STEPS = ['接入说明', '装好 Roost', '一键直连', '自测完成']

    /** `initial*` 三个只给渲染测试注入状态用；生产不传，由 load() 拉真实值、从第 1 步开始 */
    function SetupWizard({
      st, toast, onDone, reload,
      initialSetup = null, initialPair = null, initialStep = 0,
    }) {
      const [step, setStep] = useState(initialStep)
      const [busy, setWizardBusy] = useState(false)
      const [msg, setMsg] = useState('')
      const [pair, setWizardPair] = useState(initialPair)
      const [setupState, setSetupState] = useState(initialSetup)
      const [tested, setTested] = useState(false)
      /** 自己填的安装目录（绑定已有安装用），以及输入框展开开关 */
      const [dirInput, setDirInput] = useState('')
      const [dirOpen, setDirOpen] = useState(false)

      const load = async () => {
        try {
          const [p, s] = await Promise.all([get('/roost/pair'), get('/setup')])
          setWizardPair(p && p.ok !== false ? p : null)
          setSetupState(s && s.ok !== false ? s : null)
        } catch (e) {
          setMsg(`读状态失败：${e?.message ?? e}`)
        }
      }
      useEffect(() => { load() }, [])

      const call = async (path, body) => {
        setWizardBusy(true)
        setMsg('')
        try {
          const r = await post(path, body || {})
          await load()
          return r
        } catch (e) {
          setMsg(`✗ ${e?.message ?? e}`)
          return { ok: false, message: e?.message ?? String(e) }
        } finally {
          setWizardBusy(false)
        }
      }

      const doEnable = async () => {
        const r = await call('/roost/pair/enable', {})
        /** 顺带装 ws 的结果：装上了就说一句，装不上也说明会走 SSE */
        const wsNote = r?.ws
          ? (r.ws.ok
              ? `；${r.ws.mode === 'reuse' ? '框架已有 ws，直接复用' : '已给框架装好 ws'}`
              : `；给框架装 ws 没成（${r.ws.message || '原因不明'}），事件走 SSE，功能一样`)
          : ''
        setMsg(r?.ok === false
          ? `✗ ${r.message || '没配成'}${r.step === 'old-roost' ? '（这一步只能升级 Roost，不是网络问题）' : ''}`
          : `✓ 已连上 ${r.url}，密钥和端口都由插件自动配好${wsNote}`)
        setTested(false)
      }

      /**
       * 「测试连接」。
       *
       * 文案分两段：**RPC 通** 与 **事件流订阅**。以前只有前者——`system.ping`
       * 打一次就报绿，可消息走的是 `/events` / `/ws` 那条长连接，订阅没建起来
       * 一样收不到（2026-11-13 的「向导全绿但不回话」就是这么来的）。
       */
      const doTest = async () => {
        const r = await call('/roost/pair/test', {})
        const rpc = r?.ms !== undefined ? `RPC 往返 ${r.ms}ms` : 'RPC 通'
        if (r?.ok === false) { setTested(false); setMsg(`✗ ${r.message || '不通'}`); return }
        /**
         * `stream` 三态：`{ok:true}` 已订阅 / `{ok:false}` 没订阅 / `null` 这个
         * 框架版本没有 `/health`，自检不了。**没订阅要算失败**，不然又是假绿。
         */
        const s = r?.stream
        if (s && s.ok === false) {
          setTested(false)
          setMsg(`△ ${rpc}，但事件流没订阅上（connections=${s.connections}）——消息进不来，检查传输方式或重启插件`)
          return
        }
        setTested(true)
        setMsg(s
          ? `✓ ${rpc}，事件流已订阅（connections=${s.connections}）`
          : `✓ ${rpc}；这个框架版本没有 /health，事件流是否订阅无法自检`)
      }

      /**
       * 第 2 步的四个动作。**都在本页做完，不用跳去「系统 → 接入」**——
       * 向导的本意就是一条路走到底，中途把人支使去别的页最容易走丢。
       *
       * 装和绑是两件不同的事，文案必须分清：
       *   · 一键安装：下载到默认目录（`<数据目录>/roost`），不接收路径
       *   · 绑定已有：把 `setup.roostDir` 指向一份**已经存在**的安装
       * 混成一句「选择安装目录」，用户会填一个空目录然后报「这个目录不像 Roost」。
       */
      const doInstall = async () => {
        setMsg('正在下载安装，可能要一两分钟…')
        const r = await call('/setup/install', {})
        if (r?.ok === false) { setMsg(`✗ ${r.message || '装不上'}`); return }
        setMsg(`✓ ${r.message || '装好了'}，接着点「一键启动」`);
      }

      const doStart = async () => {
        setMsg('正在启动…')
        const r = await call('/setup/start', {})
        if (r?.ok === false) { setMsg(`✗ ${r.message || '起不来'}`); return }
        setMsg(`✓ ${r.message || '已启动'}`);
      }

      const doBindDir = async () => {
        const d = dirInput.trim();
        if (!d) return;
        const r = await call('/setup/dir', { dir: d });
        if (r?.ok === false) { setMsg(`✗ ${r.message || '绑定失败'}`); return }
        setDirOpen(false);
        setMsg(`✓ 已绑定 ${r.dir || d}`);
      }

      const doDone = async () => {
        const r = await call('/setup/wizard/done', {})
        if (r?.ok === false) {
          setMsg(`✗ ${r.message || '还没通过'}`)
          setTested(false)
          return
        }
        toast('接入完成')
        onDone?.()
        reload?.()
      }

      const doSkip = async () => {
        const r = await call('/setup/wizard/skip', {})
        if (r?.ok === false) { setMsg(`✗ ${r.message || '没跳过'}`); return }
        toast('先跳过，概览页会一直提示')
        onDone?.()
        reload?.()
      }

      const upgraded = Boolean(st?.wizard?.upgraded)
      const pairStep = pair?.step || 'no-roost'
      const roostReady = Boolean(setupState?.installed && setupState?.running)
      const paired = pairStep === 'ready' || pairStep === 'other-channel'

      /** 链路对比：把「少了哪一层」画出来，比一段文字好懂 */
      const chain = (items, cls) => h('div', { className: 'roost-wiz-chain ' + cls },
        items.flatMap((it, i) => [
          i ? h('span', { key: 'a' + i, className: 'roost-wiz-arrow' }, '→') : null,
          h('span', {
            key: 'n' + i,
            className: 'roost-wiz-node ' + (it.gone ? 'gone' : it.hot ? 'hot' : ''),
          }, it.label),
        ]),
      )
      const todo = (rows) => h('div', { className: 'roost-wiz-todo' },
        rows.map((r, i) => h('div', { key: r, className: 'roost-wiz-todo-row' },
          h('span', { className: 'roost-wiz-todo-num' }, String(i + 1)),
          h('span', null, r),
        )),
      )

      const body = [
        // 0 接入说明
        h('div', null,
          h('p', { className: 'roost-note' },
            upgraded
              ? '你从旧版升级上来了。这一版彻底移除了 ai-chat 中间层，消息改由框架外接协议直连 —— 老配置里的接入方式已经不存在，必须重新接一次，否则机器人不会回话。'
              : '欢迎使用。机器人不直接连 QQ：Roost 框架负责官方接口，这个插件负责思考和回话，两边通过框架外接协议直连。'),
          h('div', { style: { marginTop: 14 } },
            h('div', { className: 'roost-note', style: { fontSize: 12 } }, upgraded ? '旧版链路（已移除）' : '旧版链路（这一版不再使用）'),
            chain([
              { label: 'QQ' }, { label: 'Roost 框架' },
              { label: 'ai-chat 插件', gone: true }, { label: 'dsh-roost' }, { label: 'DSH' },
            ], 'old'),
            h('div', { className: 'roost-note', style: { fontSize: 12, marginTop: 10 } }, '现在'),
            chain([
              { label: 'QQ' }, { label: 'Roost 框架' },
              { label: '外接协议', hot: true }, { label: 'dsh-roost' }, { label: 'DSH' },
            ], 'now'),
          ),
          h('div', { className: 'roost-note', style: { marginTop: 16, fontWeight: 600 } }, '接下来三步'),
          todo([
            '确认 Roost 装好并启动',
            '一键直连 —— 密钥和端口自动生成，不用手填',
            '自测通过后完成接入',
          ]),
          upgraded
            ? h('div', { className: 'roost-banner', style: { marginTop: 16 } },
                '你的人格、记忆、日记、权限设置都会保留；这一步只重连消息通道。')
            : null,
        ),
        // 1 装好 Roost：装 / 绑 / 启动都在本页做完
        h('div', null,
          h('p', { className: 'roost-note' }, 'Roost 是消息进出的框架。装好、启动，就这一步能全部做完。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('div', { className: 'roost-pill' }, setupState?.installed ? `✓ 已装 v${setupState.version || '?'}` : '未安装'),
            h('div', { className: 'roost-pill' }, setupState?.running ? '✓ 正在运行' : '未运行'),
            h('div', { className: 'roost-pill' }, setupState?.hasCreds ? '✓ 机器人凭证' : '缺机器人凭证'),
            h('div', { className: 'roost-pill' }, `面板端口 ${setupState?.port || '—'}`),
          ),
          /** 目录一行：让人知道自己装在哪、也让人能把已有安装指过来 */
          setupState?.dir
            ? h('div', { className: 'roost-note', style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', null, '安装位置'),
                h('span', { className: 'roost-mono', style: { overflowWrap: 'anywhere' } }, String(setupState.dir)),
                h('span', { style: { opacity: .7 } }, `（${setupState.dirHow || ''}）`),
              )
            : null,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
            !setupState?.installed
              ? h('button', {
                  type: 'button', className: 'roost-primary', disabled: busy, onClick: doInstall,
                }, busy ? '处理中…' : '一键安装 Roost')
              : null,
            setupState?.installed && !setupState?.running
              ? h('button', {
                  type: 'button', className: 'roost-primary', disabled: busy, onClick: doStart,
                }, busy ? '处理中…' : '一键启动 Roost')
              : null,
            setupState?.installed && setupState?.running
              ? h('div', { className: 'roost-pill' }, '✓ 已在运行，可以下一步了')
              : null,
            h('button', {
              type: 'button', className: 'roost-btn', onClick: () => setDirOpen((v) => !v),
            }, dirOpen ? '收起' : '已经装过？指定目录'),
            setupState?.webui
              ? h('button', {
                  type: 'button', className: 'roost-btn',
                  onClick: () => window.open(setupState.webui, '_blank', 'noopener'),
                }, '打开 Roost 面板')
              : null,
          ),
          /** 绑定已有安装：明确说「目录里必须已经有 src/main.js」，否则用户会填空目录 */
          dirOpen
            ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'roost-note', style: { marginBottom: 6 } },
                  '指向一份**已经解压好的** Roost（目录里要能看到 src/main.js）。'
                  + '想装到别的位置就先把包解压过去，再来这里指定。'),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('input', {
                    className: 'roost-input',
                    placeholder: setupState?.dir || 'D:\\bots\\qq-bot-roost',
                    value: dirInput,
                    onChange: (e) => setDirInput(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') doBindDir() },
                    style: { flex: 1, minWidth: 200 },
                  }),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: !dirInput.trim() || busy, onClick: doBindDir,
                  }, '用这个目录'),
                ),
              )
            : null,
          h('div', { className: 'roost-note', style: { marginTop: 12 } },
            'Roost 是零依赖的 QQ 官方机器人框架：装好、填 AppID / AppSecret、启动就行。'
            + '这一版开始它由自己的外接协议直接把消息推给本插件，不需要再装任何中间插件。'),
          !roostReady
            ? h('p', { className: 'roost-note', style: { marginTop: 10 } },
                '还没检测到在跑的 Roost：点上面的「一键安装」或指定已有目录，再点「一键启动」。')
            : null,
        ),
        // 2 一键直连
        h('div', null,
          h('p', { className: 'roost-note' },
            '点下面按钮，插件会通过 Roost 自己的面板接口开启外接协议、生成密钥、读回真实端口。地址和密钥都不用手填。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy,
              onClick: doEnable,
            }, busy ? '处理中…' : paired ? '重新配对一次' : '一键直连'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: doTest,
            }, '测试连接'),
          ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 } },
            h('div', { className: 'roost-pill' }, pair?.host?.enabled ? '✓ 协议已开启' : '协议未开启'),
            h('div', { className: 'roost-pill' }, pair?.self?.tokenSet ? '✓ 密钥已保存' : '密钥未保存'),
            h('div', { className: 'roost-pill' }, pair?.self?.url ? '✓ 已配对' : '未配对'),
          ),
          pair?.text
            ? h('div', { className: 'roost-note', style: { marginTop: 10 } }, pair.text)
            : null,
          pairStep === 'old-roost'
            ? h('div', { className: 'roost-banner', style: { marginTop: 10 } },
                'Roost 版本太老，还没有外接协议。这只能升级 Roost 解决，不是网络或端口问题。')
            : null,
        ),
        // 3 自测完成
        h('div', null,
          h('p', { className: 'roost-note' },
            '最后真发一次协议调用，确认事件能收到、消息能发出去。通过后向导才算走完。'),
          h('div', { className: 'roost-note', style: { marginTop: 8 } },
            '「完成接入」会由服务端再自测一次，前端说了不算 —— 所以这里不会点到一半就假装配好了。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('div', { className: 'roost-pill' }, roostReady ? '✓ Roost 在跑' : '· Roost 没在跑'),
            h('div', { className: 'roost-pill' }, paired ? '✓ 已配对' : '· 还没配对'),
            h('div', { className: 'roost-pill' }, tested ? '✓ 自测通过' : '· 自测未通过'),
          ),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy, onClick: doTest,
            }, '再测一次'),
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy, onClick: doDone,
            }, '完成接入'),
          ),
          tested ? h('div', { className: 'roost-note', style: { marginTop: 10 } }, '✓ 自测通过，可以点「完成接入」了。') : null,
        ),
      ][step]

      return h('div', { className: 'roost-wizard', role: 'dialog', 'aria-label': '首次接入向导' },
        h('div', { className: 'roost-wizard-card' },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('div', { className: 'roost-title-lg' }, '首次接入'),
            h('span', { className: 'roost-note' }, `第 ${step + 1} / ${WIZ_STEPS.length} 步 · ${WIZ_STEPS[step]}`),
          ),
          h('div', { style: { display: 'flex', gap: 4, margin: '14px 0' } },
            WIZ_STEPS.map((name, i) => h('button', {
              key: name, type: 'button',
              className: 'roost-pill' + (i === step ? ' on' : ''),
              style: { flex: 1, cursor: i <= step ? 'pointer' : 'default', opacity: i <= step ? 1 : 0.5 },
              onClick: () => i <= step && setStep(i),
            }, `${i + 1} ${name}`)),
          ),
          h('div', { className: 'roost-wiz-body' }, body),
          msg ? h('div', { className: 'roost-note', style: { marginTop: 10 } }, msg) : null,
          h('div', { style: { display: 'flex', gap: 8, marginTop: 18, alignItems: 'center', flexWrap: 'wrap' } },
            step > 0
              ? h('button', { type: 'button', className: 'roost-btn', onClick: () => setStep(step - 1) }, '上一步')
              : null,
            h('div', { style: { flex: 1 } }),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy, onClick: doSkip,
            }, '暂时跳过'),
            step < WIZ_STEPS.length - 1
              ? h('button', {
                  type: 'button', className: 'roost-primary', onClick: () => setStep(step + 1),
                }, '下一步')
              : null,
          ),
        ),
      )
    }

    /** 能认出来的工具标一句中文 / 来源插件，只做展示，绝不改工具 key。 */
    const TOOL_NOTE = {
      edit: '改文件', write: '写文件', read: '读文件', read_image: '读图片',
      working_directory: '看工作目录', pwsh: '跑 PowerShell', bash: '跑命令',
      load_workspace_dependencies: '加载工作区依赖',
      memory_search: '查记忆', memory_note: '记一笔',
      qq_send: '发言出口', qq_close: '收尾出口', qq_send_file: '发文件',
      sticker_pick: '挑表情包',
      list_mcp_resources: 'MCP 资源列表',
      list_mcp_resource_templates: 'MCP 资源模板',
      read_mcp_resource: '读 MCP 资源',
    }
    const TOOL_PREFIX = [
      ['gh_', 'GitHub'], ['pr_', 'GitHub · PR'], ['issue_', 'GitHub · 议题'],
      ['review_', 'GitHub · 审查'], ['ops_', '运维'], ['acp_', '会话 / 图片'],
      ['memory_', '记忆'], ['qq_', '发言'], ['sticker_', '表情包'],
    ]
    const MCP_TAIL = {
      exec: '执行', edit: '编辑', read: '读取', macro: '宏', feed: '订阅流',
      search: '搜索', list: '列表', get: '查询', write: '写入', add: '新增',
    }
    /** /v1 的 scope 名同样是英文，给一句中文；不认识的留空 */
    const SCOPE_LABEL = {
      'message:write': '发消息', 'say:write': '代她发言',
      'state:read': '读状态', 'context:read': '读上下文',
      'memory:read': '读记忆', 'memory:write': '写记忆',
      'proactive:write': '主动发言', 'session:write': '写会话',
      'prompt:write': '写提示词', 'agent:write': '开独立会话',
      'config:write': '改配置', 'group:write': '管群', 'core:write': '接管内置功能',
    }
    const scopeNote = (s) => (SCOPE_LABEL[s] ? `（${SCOPE_LABEL[s]}）` : '')
    const scopesText = (arr) => (arr || []).map((s) => s + scopeNote(s)).join('、')
    /** ext-tier.js 给的是语义色名，映射到面板现有的主题变量，亮/暗主题都看得清 */
    const tierColorOf = (c) => ({
      green: 'var(--good, #16a34a)', blue: 'var(--accent, #3b82f6)',
      orange: 'var(--warn, #d97706)', red: 'var(--bad, #dc2626)',
    }[c] || 'var(--dsw-alias-label-secondary, #8a93a6)')

    const toolNote = (n) => {
      if (n.startsWith('mcp__')) {
        const parts = n.split('__')
        const srv = parts[1] || 'MCP'
        const tail = parts.slice(2).join('__')
        /** gf_edit / gf_exec 这类带前缀的，用最后一段认动作 */
        const zh = MCP_TAIL[tail] || MCP_TAIL[String(tail).split('_').pop()]
        return `（${srv} 扩展${zh ? ' · ' + zh : ''}）`
      }
      if (TOOL_NOTE[n]) return `（${TOOL_NOTE[n]}）`
      for (const [pre, label] of TOOL_PREFIX) if (n.startsWith(pre)) return `（${label}）`
      return ''
    }

    function ToolsModal({ pool, caps, busy, danger, pinned, suggested, riskGroups,
      allowedIn, onSetLevel = () => {}, q, setQ, onClose }) {
      const kw = String(q || '').trim().toLowerCase()
      const filtered = (pool || []).filter((n) => !kw || n.toLowerCase().includes(kw))
      const isLocked = (n) => (pinned || []).includes(n)
      const isSuggested = (n) => (suggested || []).includes(n)
      /**
       * 一行一个连续滑块。档位从高到低排（主人→群成员），位置 = 开放到哪一档：
       * 前 k+1 档给、其余收走。旧数据若有洞（主人开、管理员关、群管开），
       * 归到最高的连续档；拨一下就会重写成连续，不会再留下洞。
       */
      const tierRow = (n, locked) => {
        let level = -1
        for (let i = 0; i < CAP_BUCKETS.length; i++) {
          if (!allowedIn(CAP_BUCKETS[i][0], n)) break
          level = i
        }
        const pct = `${Math.max(0, level) / (CAP_BUCKETS.length - 1) * 100}%`
        return h('div', {
          className: 'cap-tiers', 'data-level': String(level),
          'data-locked': locked ? '1' : '0',
          role: 'radiogroup', 'aria-label': `${n} 开放到哪一档`, tabIndex: 0,
          onKeyDown: (e) => {
            if (locked || busy || !caps?.enabled) return
            const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
            if (!step) return
            e.preventDefault()
            /** -1 = 一档都不给（灰钮停在起点），点任一档位或按右键即可恢复 */
            const next = Math.max(-1, Math.min(CAP_BUCKETS.length - 1, level + step))
            onSetLevel(n, next)
          },
        },
          h('div', { className: 'cap-track' },
            h('i', { className: 'cap-fill', style: { width: pct } }),
            h('i', { className: 'cap-knob', style: { left: pct } }),
          ),
          CAP_BUCKETS.map(([id, label], i) => h('button', {
            key: id,
            type: 'button', className: 'cap-tier', role: 'radio',
            'aria-checked': i === level ? 'true' : 'false',
            'aria-label': `开放到${label}：${n}`,
            'data-on': i <= level ? '1' : '0',
            title: `拨到「${label}」：这一档及更高档可用，更低档不可用`,
            disabled: busy || !caps?.enabled || locked,
            onClick: () => onSetLevel(n, i),
          })),
        )
      }

      return h('div', { className: 'cap-modal', onClick: onClose },
        h('div', { className: 'cap-modal-b', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'cap-modal-h' },
            h('span', { className: 't' }, `工具权限（${(pool || []).length} 个）`),
            h('button', { type: 'button', className: 'roost-btn', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'cap-modal-s' },
            h('input', {
              className: 'roost-input',
              type: 'search',
              placeholder: '搜工具名，比如 search / memory / gh_',
              value: q,
              onChange: (e) => setQ(e.target.value),
            }),
          ),
          h('div', { className: 'cap-modal-c' },
            h('div', { className: 'cap-tool-h' },
              h('span', { className: 'n' }, '工具名'),
              h('span', { className: 'cap-tiers' },
                CAP_BUCKETS.map(([id, label]) =>
                  h('span', { key: id, className: 't', title: label }, label))),
            ),
            filtered.length
              ? (riskGroups || []).map(([title, pick]) => {
                  const names = filtered.filter(pick)
                  if (!names.length) return null
                  return h('div', { key: title, style: { marginTop: '10px' } },
                    h('div', { className: 'cap-group-t' }, `${title} · ${names.length}`),
                    names.map((n) => {
                      const locked = isLocked(n)
                      return h('div', { key: n, className: 'cap-tool' },
                        h('span', {
                          className: 'n',
                          title: locked
                            ? '钉住项：关掉它机器人就说不出话'
                            : isSuggested(n) ? '建议保留：关掉不影响说话，只是它会少一样本事' : n,
                        },
                          ((danger || {})[n] ? '🔴 ' : '') + n + (locked ? ' 🔒' : ''),
                          toolNote(n)
                            ? h('span', { className: 'note' }, ' ' + toolNote(n))
                            : null),
                        tierRow(n, locked),
                      )
                    }),
                  )
                })
              : h('div', { className: 'roost-empty' }, `没有匹配「${q}」的工具`),
          ),
          h('div', { style: { padding: '0 16px 14px', fontSize: 11, opacity: 0.6, lineHeight: 1.7 } },
            '滑块拨到某一档 = 这一档及更高档可用，更低档不可用；档位从左到右是主人 → 群成员。灰色滑块 = 一档都不给，点任一档位或按方向键即可恢复。',
            h('br'),
            '🔒 钉住项：只有发言出口和收尾两个，关了它就彻底说不出话，所以不给动。🔴 是危险动作——它真的会动你电脑上的东西。',
            h('br'),
            '某一档现在是「全权」时，把滑块拨低会把 * 展开成具体清单；原本「跟随更低档」的档被拨过之后会记下一个增量，不再纯跟随。'),
        ),
      )
    }

    /**
     * 2.8：批量添加群白名单之前的**预演**（纯函数，不写盘）。
     *
     * 批量输入框最容易变成「点完不知道加了什么」：重复的不说、手滑粘进来的
     * 私聊号也塞进群白名单、格式错的静默丢掉。面板要当场报
     * 「新增 / 重复 / 跳过主人 / 格式错」四个数，这类统计必须可测。
     *
     * 「跳过主人」在我们这套里的准确含义：**这个 id 在会话表里是私聊**。
     * 主人 openid 存在框架的 config/bots/<id>.json，dsh-roost 读不到全量名单，
     * 所以不假装做了精确比对；私聊对象一律归框架的「主人与群组」管，
     * 塞进群白名单既不生效也会误导。aurabot 能精确跳过是因为名单在它自己手里。
     *
     * 分隔符用换行 / 逗号 / 分号；每行允许 `chatId 备注名`，名字里可以有空格。
     * `next` 是合并后的**整份**数组（保留原有 enabled），交给 saveCfg 整份覆盖——
     * patchConfig 对数组是直接替换，不会像字典那样局部合并。
     */
    function planGroupWhitelist(raw, opts) {
      const groups = (opts && opts.groups) || []
      const chats = (opts && opts.chats) || []
      const have = new Map()
      for (const g of (Array.isArray(groups) ? groups : [])) {
        const chatId = String((g && g.chatId) || '').trim()
        if (!chatId) continue
        have.set(chatId, {
          chatId,
          name: String((g && g.name) || ''),
          enabled: g.enabled !== false,
        })
      }
      const kindById = new Map()
      for (const c of (Array.isArray(chats) ? chats : [])) {
        const chatId = String((c && c.chatId) || '').trim()
        if (chatId) kindById.set(chatId, String((c && c.kind) || ''))
      }
      const stats = { added: 0, duplicate: 0, skippedOwner: 0, invalid: 0 }
      const items = []
      const notes = []
      for (const line of String(raw == null ? '' : raw).split(/[\r\n,;，；]+/)) {
        const text = line.trim()
        if (!text) continue
        const parts = text.split(/\s+/)
        const chatId = String(parts[0] || '').trim()
        /** 官方 openid / 群号都是这串字符；挡住粘进来的 URL、@、中文句子 */
        if (!/^[A-Za-z0-9_-]{4,128}$/.test(chatId)) {
          stats.invalid += 1
          notes.push('格式不对：' + text.slice(0, 40))
          continue
        }
        if (have.has(chatId)) {
          stats.duplicate += 1
          notes.push('已经在名单里：' + chatId)
          continue
        }
        if (kindById.get(chatId) === 'c2c') {
          stats.skippedOwner += 1
          notes.push('私聊对象，归框架「主人与群组」管：' + chatId)
          continue
        }
        const name = parts.slice(1).join(' ').trim() || chatId.slice(0, 12)
        const row = { chatId, name, enabled: true }
        have.set(chatId, row)
        items.push(row)
        stats.added += 1
      }
      return { items, stats, notes, next: Array.from(have.values()) }
    }

    /** 「从最近会话导入」：只取群，且已经在名单里的不带进输入框 */
    function suggestGroupWhitelist(chats, groups) {
      const have = new Set((Array.isArray(groups) ? groups : []).map((g) => String((g && g.chatId) || '')))
      return (Array.isArray(chats) ? chats : [])
        .filter((c) => c && c.kind === 'group' && String(c.chatId || '') && !have.has(String(c.chatId)))
        .map((c) => (c.chatId + ' ' + String(c.title || '').replace(/\s+/g, ' ').trim()).trim())
    }

    function CapsTab({ caps, preview, chats, feat, retention, quota, toast, reload, quick, busy,
      config, saveCfg, setupSt, setTab }) {
      /**
       * 工具面板是**弹窗**，不是页面上的一节。
       *
       * 二十多个工具 × 四个勾位铺在页面上就是一米多长，滚到底已经忘了上面在讲什么。
       * 收进弹窗之后，页面上只留一行「逐个调整（25 个）」，要细调的人再进去。
       *
       * **hooks 必须在 `if (!caps) return` 之前**——条件返回之后再调 hook
       * 会让 hook 顺序在两次渲染之间变化，React 直接报错。
       */
      const [toolsOpen, setToolsOpen] = useState(false)
      const [toolQ, setToolQ] = useState('')
      /**
       * 「数值 / 下拉」型设置正在编辑的值。
       *
       * 不能直接拿 `feat.settings[id]` 当受控 value：用户每敲一个字符就会
       * 发一次 patch，敲「30」会先存 3 再存 30；而且服务端还没回来时
       * 输入框会被旧值覆盖，看起来像打不了字。
       * 所以编辑期间用本地草稿，失焦 / 回车才提交。
       */
      const [featDraft, setFeatDraft] = useState({})
      /**
       * 次数限制当前在编辑哪一档。
       *
       * 默认「群成员」：那是绝大多数人真正要限的档——
       * 主人的额度他一般懒得改，而群友才是最需要管住的那批人。
       */
      const [quotaBucket, setQuotaBucket] = useState('member')
      /**
       * 「刚点了添加、还没填数字」的工具。
       *
       * 只存在前端、**不写配置**：填 0 才落盘会让人莫名其妙地禁用一个工具。
       * 它唯一的作用是把那一行的空输入框显示出来。
       */
      const [addingTools, setAddingTools] = useState([])
      /** 2.8 授权名单：批量输入草稿。只是本页草稿，点「加进名单」才写配置 */
      const [wlDraft, setWlDraft] = useState('')
      const BUCKET = CAP_BUCKETS

      /** 按来源前缀分组；认不出的归「其他」 */
      const GROUP_OF = (n) => {
        if (n.startsWith('mcp__')) return 'MCP'
        if (/^(gh_|pr_|issue_|review_)/.test(n)) return 'GitHub'
        if (n.startsWith('ops_')) return '运维'
        if (/^(memory_|qq_|sticker_)/.test(n)) return '记忆 / 发言（自带）'
        if (/^(edit|read|write|read_image|working_directory|pwsh|bash)$/.test(n)) return '文件 / 命令'
        if (n.startsWith('acp_')) return '会话 / 图片'
        return '其他'
      }

      if (!caps) return h('div', { className: 'roost-empty' }, '正在读工具清单…')

      /** 2.8：名单来自 config.awake.groups；chats 用来认出「这个 id 其实是私聊」 */
      const wlGroups = Array.isArray(config?.awake?.groups) ? config.awake.groups : []
      const wlPlan = planGroupWhitelist(wlDraft, { groups: wlGroups, chats: chats || [] })
      const saveGroups = async (next, okMsg) => {
        if (!saveCfg) return toast('配置还没读到，等一下再试')
        const r = await saveCfg({ awake: { groups: next } })
        toast(r?.ok === false ? (r.message || '没存上') : okMsg)
        setWlDraft('')
        reload()
      }

      const enable = async () => {
        const r = await quick('capabilities.init')
        toast(r.message || (r.ok ? '已启用' : '启用失败'))
        reload()
      }

      const ack = async () => {
        await quick('capabilities.ack')
        reload()
      }

      /**
       * 四个角色 = 四套 allow 预设。
       *
       * 为什么不让人从 30 多个工具里勾：绝大多数人只想知道"它在这个档位算老几"。
       * 角色是给他们的；想抠细节的往下走到工具清单（下一版）。
       *
       * 顺序按**危险度递增**排，默认第一项是最保守的——手滑点到最右边才出事。
       */
      const ROLES = [
        {
          /**
           * 「跟随」= 不写 `allow`，自动等于所有更低档的并集。
           *
           * 这是群管 / 助手的**默认形态**，也是它们的正确形态：
           * 你调了「群成员」那一档，它们跟着变，不用改三遍。
           * 一旦给它们选了具体角色，它们就固定下来，不再跟随。
           */
          id: 'inherit',
          label: '跟随',
          hint: '和更低的档位一样，跟着变。想让它们多点什么就选右边任何一个',
          inherit: true,
        },
        {
          id: 'chat',
          label: '只聊天',
          hint: '只会回话、记人、发表情，不碰你电脑上的任何东西',
          allow: ['memory_search', 'memory_note', 'qq_send', 'sticker_pick'],
        },
        {
          id: 'read',
          label: '能查能看',
          hint: '加上读文件、看图片、查 GitHub —— 只读，改不了',
          allow: [
            'memory_search', 'memory_note', 'qq_send', 'sticker_pick',
            'read', 'read_image', 'working_directory', 'search_context',
            'gh_search', 'gh_repo',
          ],
        },
        {
          /**
           * 「能干活」用**分组**列举，不是 `*`。
           *
           * 差别在以后：分组只覆盖我们已经认识的那几类（文件/运维/GitHub/MCP），
           * 以后新装的插件不会因为它就被放行；`*` 则是"连将来的一起给"。
           * 这两个必须能区分开，否则「能干活」和「全权」就是同一个东西。
           */
          id: 'work',
          label: '能干活',
          hint: '加上改文件、跑命令、调 MCP。⚠️ 它真的会动你电脑上的东西',
          allow: [
            'memory_search', 'memory_note', 'qq_send', 'sticker_pick',
            'group:files', 'group:ops', 'group:github', 'group:mcp',
          ],
        },
        { id: 'all', label: '全权', hint: '所有工具，**包括以后新装的插件**', allow: ['*'] },
      ]

      /** 当前这档属于哪个角色：按 allow 完全相等判，判不出来就是「自定义」 */
      const roleOf = (allow) => {
        /**
         * 没写 `allow` = 继承更低的档。
         *
         * 这个分支必须排在前面：`JSON.stringify([])` 是 `'[]'`，
         * 不匹配任何角色，界面会显示成「自定义」——用户看到
         * 「群管：自定义」会以为自己配过什么，实际上他什么都没动。
         */
        if (!Array.isArray(allow)) return 'inherit'
        const key = JSON.stringify([...allow].sort())
        /**
         * **必须跳过没有 `allow` 的角色**。
         *
         * 「跟随」这一项只有 `inherit: true`，故意没有 `allow`（它不是一个具体权限集）。
         * 不加这个判断，`[...r.allow]` 就是 `[...undefined]` → `TypeError: r.allow is not iterable`，
         * 整个能力页连同 Roost 面板一起黑屏——2026-11-05 02:41 就是这么崩的。
         *
         * 测试当时没抓到，因为用例里 `caps.store.defaults` 是空的，
         * `roleOf(undefined)` 走上面那行 early return，根本没走到 `find`。
         */
        const hit = ROLES.find((r) => Array.isArray(r.allow)
          && JSON.stringify([...r.allow].sort()) === key)
        return hit ? hit.id : 'custom'
      }

      const setRole = async (bucket, role) => {
        if (!caps.enabled) {
          toast('先点上面「启用能力策略」')
          return
        }
        const defaults = { ...(caps.store?.defaults || {}) }
        /** 保留已有的 `deny`：用户手配的例外不该因为换个角色就被清掉 */
        const prev = { ...(caps.store?.defaults?.[bucket] || {}) }
        if (role.inherit) {
          /**
           * 「跟随」= 把 `allow` 整段删掉，不是写成空数组。
           * `allow: []` 的语义是「这一档什么都不给」，正好相反。
           */
          delete prev.allow
        } else {
          prev.allow = [...role.allow]
        }
        defaults[bucket] = prev
        const r = await quick('capabilities.patch', { defaults })
        toast(r.message || (r.ok ? '改好了，下一条消息生效' : '没改成'))
        reload()
      }

      /**
       * 改某个群的例外。`val === null` = 删掉这条记录（回到跟随默认）。
       *
       * 覆盖是**增量**的：删掉就干净了，不会在文件里留一个空对象。
       */
      const setChat = async (chatId, val, label) => {
        if (!caps.enabled) {
          toast('先点上面「启用能力策略」')
          return
        }
        const next = { ...(caps.store?.chats || {}) }
        if (val) next[chatId] = { ...val, label: label || '' }
        else delete next[chatId]
        const r = await quick('capabilities.patch', { chats: next })
        toast(r.message || (r.ok ? '改好了，下一条消息生效' : '没改成'))
        reload()
      }

      /**
       * 开/关一个功能。
       *
       * 后端会拒掉「依赖没满足」的组合（比如主动搭话关着却要开判断层），
       * 这里把原因直接 toast 出来——比把按钮灰掉又不说原因要好。
       */
      const toggleFeat = async (id, on) => {
        const r = await quick('features.patch', { id, on })
        toast(r.message || (r.ok ? '改好了，下一条消息生效' : '没改成'))
        reload()
      }

      /**
       * 改「数值 / 下拉」型设置。
       *
       * 布尔项走 `on`，这里走 `value`——后端 `features.patch` 按 `kind` 分开收。
       * 共用一个字段会出事：`on: 0` 是「关」，而 `queueMax: 0` 是「不排队」，
       * 两个 0 语义不同。
       *
       * 不管成功失败都清草稿：失败时让输入框回到服务端的真值，
       * 否则页面显示一个根本没保存的数，比报错更糟。
       */
      const setFeatValue = async (id, value) => {
        const r = await quick('features.patch', { id, value })
        toast(r.message || (r.ok ? '已保存' : '没改成'))
        setFeatDraft((d) => {
          const n = { ...d }
          delete n[id]
          return n
        })
        reload()
      }

      /**
       * 渲染一组配额行。
       *
       * @param {'builtin'|'tool'} kind
       *   builtin = 内置动作（语音/发文件/表情包…）；
       *   tool = 工具，**除了已经配过的，还要把池子里没配过的也列出来**——
       *          不列的话用户根本不知道能给哪些工具设次数，只能去翻文档。
       */
      const quotaRows = (kind) => {
        const builtin = (quota && quota.builtin) || []
        const rows = (quota && quota.rows) || []
        const pool = (quota && quota.pool) || []
        const isBuiltin = (f) => kind === 'builtin' ? builtin.includes(f) : !builtin.includes(f)
        const configured = rows.filter((r) => isBuiltin(r.feature))
        /**
         * 工具那一组**默认只列已配了额度的**。
         *
         * 二十多个工具全铺出来就是用户说的「划不到头」。想加新的时候
         * 用下面那个下拉挑一个，挑完这一行才出现——列表长度跟着「你真正
         * 管了几个工具」走，而不是跟着装了多少插件走。
         */
        const names = kind === 'builtin'
          ? configured.map((r) => r.feature)
          : [...new Set([...configured.map((r) => r.feature), ...addingTools])]

        const addPick = kind === 'tool' && pool.length
          ? h('div', { key: '__add', style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' } },
              h('select', {
                className: 'roost-input',
                style: { flex: '1 1 auto', padding: '3px 6px' },
                defaultValue: '',
                disabled: busy,
                onChange: (e) => {
                  const v = e.target.value
                  if (!v) return
                  e.target.value = ''
                  if (!addingTools.includes(v)) setAddingTools([...addingTools, v])
                },
              },
                h('option', { value: '' }, `＋ 给某个工具加次数限制${pool.length ? `（池里 ${pool.filter((n) => !builtin.includes(n)).length} 个）` : ''}`),
                pool.filter((n) => !builtin.includes(n) && !names.includes(n))
                  .map((n) => h('option', { key: n, value: n },
                    n + (toolNote(n) ? ' ' + toolNote(n) : ''))),
              ),
            )
          : null

        if (!names.length) {
          return [h('div', { key: 'empty', className: 'roost-note', style: { margin: 0 } },
            kind === 'tool' ? '还没有限过任何工具的次数。下面挑一个就行。' : '这一组还没有可配的东西。'), addPick].filter(Boolean)
        }

        return names.map((name) => {
          const r = configured.find((x) => x.feature === name)
          const perLabel = !r ? '每人' : r.per === 'person' ? '每人' : r.per === 'chat' ? '每个群' : '全局'
          const winLabel = !r ? '每天' : r.window === 'day' ? '每天'
            : r.window === 'hour' ? '每小时'
              : r.window === 'minute' ? '每分钟'
                : r.window === 'turn' ? '每轮' : '每条'
          /**
           * 当前档位的**实际**额度：该档单独设过就用它，否则跟随默认。
           *
           * 两个值要能区分开：用户改完群成员那一档，回头切到主人，
           * 看到的应该还是主人自己的数——如果这里只读 `max`，
           * 四档会永远显示同一个数字，界面上根本看不出「分级」这件事。
           */
          const bv = r && r.byBucket ? r.byBucket[quotaBucket] : undefined
          const own = bv !== undefined
          const maxNum = own ? Number(bv) : (r ? Number(r.max) : -1)
          const unlimited = !(maxNum >= 0)
          const full = !unlimited && Number(r.peak) >= maxNum
          const wired = !r || r.wired !== false
          const shown = r ? String(r.label || name) : name
          /** 后端已给中文 label 的不用再标；纯英文工具名补一句括号说明 */
          const note = toolNote(name) && !/[^\x00-\x7F]/.test(shown) ? toolNote(name) : ''
          return h('div', { key: name, className: 'cap-row', style: { alignItems: 'center', opacity: wired ? 1 : 0.6 } },
            h('div', { className: 'cap-row-b' },
              h('div', null,
                shown,
                note ? h('span', { className: 'roost-note', style: { margin: 0 } }, ' ' + note) : null,
                wired ? null : ' · 暂未生效'),
              h('div', { className: 'roost-note', style: { margin: 0 } },
                unlimited ? `${perLabel} · ${winLabel} · 不限`
                  : `${perLabel} · ${winLabel} · 目前最多 ${r.peak}`,
                own ? ' · 这一档单独设了' : '',
                full ? ' · 🔴 用满了' : '',
                wired ? '' : ' · 还没接到实际动作上，填了也不拦'),
            ),
            h('div', { className: 'cap-cap' },
              h('input', {
                type: 'number',
                min: '0',
                /**
                 * 占位符带上建议值。
                 *
                 * 默认额度是「不限」（见 `quota.js` 的 `QUOTA_DEFAULTS`），
                 * 所以每一行都是空的——只说「不限」等于让人自己猜该填几。
                 * `suggest` 是服务端给的经验数，照抄就行。
                 */
                placeholder: r && r.suggest ? `不限（建议 ${r.suggest}）` : '不限',
                /** -1 = 不限，输入框留空表示它；直接显示 -1 会让人以为填错了 */
                defaultValue: unlimited ? '' : String(maxNum),
                title: '留空 = 不限；0 = 完全禁用',
                disabled: busy,
                /** 非受控 + 失焦提交：受控输入在没有重渲染的环境里会吃掉输入 */
                onBlur: (e) => setQuota(name, e.target.value, quotaBucket),
              }),
              '次',
              r
                ? h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: busy,
                    onClick: () => resetQuota(name),
                  }, '清零')
                : null,
            ),
          )
        }).concat(addPick ? [addPick] : [])
      }

      /**
       * 改某个功能**在某一档**的额度。留空 = 不限（写 -1），交给后端判。
       *
       * 一定带 `bucket`：不带就是改「所有档位的默认值」，
       * 用户改群成员会把主人一起改了——那就不叫分级了。
       */
      const setQuota = async (feature, raw, bucket = quotaBucket) => {
        const txt = String(raw ?? '').trim()
        const max = txt === '' ? -1 : Number(txt)
        if (!Number.isFinite(max)) {
          toast('填一个数字，或者留空表示不限')
          return
        }
        const r = await quick('quota.patch', { feature, max, bucket })
        toast(r.message || (r.ok ? '改好了' : '没改成'))
        reload()
      }

      const resetQuota = async (feature) => {
        const r = await quick('quota.reset', { feature })
        toast(r.message || (r.ok ? '清零了' : '没清成'))
        reload()
      }

      const featList = (feat && feat.features) || []
      /** 数值 / 下拉项没有「开着 / 关着」，算进来会让右上角那个数字虚高 */
      const toggleList = featList.filter((f) => (f.kind || 'toggle') === 'toggle')
      const featOnCount = toggleList.filter((f) => feat.on?.[f.id]).length
      const featOffCount = toggleList.length - featOnCount

      const results = (preview && preview.results) || []
      const byBucket = Object.fromEntries(results.map((r) => [r.bucket, r]))
      const pool = (preview && preview.pool) || Object.keys(caps.store?.seen?.tools || [])
      const pending = caps.pending || { added: [], gone: [] }
      const added = pending.added || []
      const gone = pending.gone || []
      const changed = added.length || gone.length

      const groups = {}
      for (const n of pool) {
        const g = GROUP_OF(n)
        if (!groups[g]) groups[g] = []
        groups[g].push(n)
      }

      const withNote = (n) => n + (toolNote(n) ? ' ' + toolNote(n) : '')
      const listOf = (names, max = 5) =>
        names.slice(0, max).map(withNote).join('、') + (names.length > max ? ` …+${names.length - max}` : '')

      /** 钉住项：关掉会失忆或说不出话，界面上不给勾（服务端也会把它们钉回来） */
      /**
       * 硬钉：**不可勾掉**。判据是「没了它就完全说不出话」——
       * 只有发言出口和主动收尾两个。
       *
       * 这里必须和后端 `capabilities.js` 的 `PINNED_KEEP` 保持一致：
       * 前端锁着、后端放行 = 用户以为自己关不掉，其实能关；
       * 反过来更糟——用户以为关掉了，实际每次都被钉回来。
       */
      const PINNED = ['qq_send', 'qq_close']
      /**
       * 建议保留：能勾掉，但标一下。记忆、表情、技能关掉都不会让机器人失声，
       * 只是"不记得你""语气变干"，那是主人的选择。
       */
      const SUGGESTED = ['memory_search', 'memory_note', 'sticker_pick']

      /** 危险标记**由服务端给**（`preview.danger`）——通配语义在 `capabilities.js` 里，前端再实现一遍必然漂 */
      const danger = (preview && preview.danger) || {}

      const RISK_GROUPS = [
        ['会改你的电脑', (n) => !!danger[n]],
        ['会对外说话', (n) => /^qq_/.test(n) && !danger[n]],
        ['只看不改', (n) => !danger[n] && !/^qq_/.test(n)],
      ]

      const allowedIn = (bucket, name) => ((byBucket[bucket] && byBucket[bucket].allow) || []).includes(name)

      /**
       * 把滑块拨到第 k 档：前 k+1 档给、其余收走，一次提交。
       *
       * 逐档调 patch 会连发五次、后一次覆盖前一次，所以先把五档全算好再提交。
       * 真正算「变成什么样」的还是模块级的 `planToolToggle()`——那段逻辑出过两次事
       * （`deny` 被冲掉、继承档取消写成 `allow: []`），不要在这里另写一套。
       */
      const setToolLevel = async (name, k) => {
        if (!caps.enabled) {
          toast('先点上面「启用能力策略」')
          return
        }
        /**
         * 展开 `*` 必须用「挂载了哪些工具」(pool)，不能用 preview 的最终生效清单：
         * 后者已被 forceDeny / chat.deny 削过，写回 defaults 会把临时收紧固化成永久配置。
         * 预览整个读不到时更要拒绝——空清单会把该档写成 `allow:[]`，
         * 那不是「收走这一个工具」，而是整档清零并断掉继承链。
         */
        if (!Array.isArray(pool) || !pool.length) {
          toast('工具清单还没读到，刷新一下再拨')
          return
        }
        const defaults = { ...(caps.store?.defaults || {}) }
        CAP_BUCKETS.forEach(([bucket], i) => {
          defaults[bucket] = planToolToggle({
            cur: caps.store?.defaults?.[bucket],
            name,
            on: i <= k,
            expanded: pool,
          })
        })
        const r = await quick('capabilities.patch', { defaults })
        toast(r.message || (r.ok ? '改好了，下一条消息生效' : '没改成'))
        reload()
      }

      const toolsModal = toolsOpen
        ? h(ToolsModal, {
            pool,
            caps,
            busy,
            danger,
            pinned: PINNED,
            suggested: SUGGESTED,
            riskGroups: RISK_GROUPS,
            allowedIn,
            onSetLevel: setToolLevel,
            q: toolQ,
            setQ: setToolQ,
            onClose: () => setToolsOpen(false),
          })
        : null

      return h('div', null,
        toolsModal,
        h(Sec, {
          n: '01', title: '工具与权限',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新'),
        },
          h('div', { className: 'roost-note' },
            '你在 DSH 里装的插件、接的 MCP，工具会自动进到机器人手里。这一页让你看清有哪些，以及给了谁。'),
          caps.enabled
            ? h('div', { className: 'roost-note' },
                '已启用：策略存在 capabilities.json，改完下一条消息生效，不用重启 DSH。')
            : h('div', null,
                h('div', { className: 'roost-note' },
                  '还没启用。现在按 config.json 里的 permissions 走（老规则）。启用后以那份配置为起点，不会悄悄降权。'),
                h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: enable }, '启用能力策略'),
              ),
          changed
            ? h('div', { className: 'roost-item' },
                h('span', { className: 't' },
                  '列表有变化',
                  h('span', { className: 'd' },
                    added.length ? ` · 新增 ${added.length} 个` : '',
                    gone.length ? ` · 失效 ${gone.length} 个` : '',
                    added.length ? `（${listOf(added, 4)}）` : '',
                  ),
                ),
                h('button', { type: 'button', className: 'roost-btn', onClick: ack }, '我知道了'),
              )
            : null,
        ),

        h(Sec, {
          n: '02', title: '她会做什么',
          right: h('span', { className: 'roost-note', style: { margin: 0 } },
            feat ? `开着 ${featOnCount} 个 · 关着 ${featOffCount} 个` : ''),
        },
          h('div', { className: 'roost-note' },
            '这些是「有没有这个功能」，和下面的「谁能用」是两层：这里关掉，谁的调不出来。'),
          /** 两页分属两个进程，用户调「她怎么聊天」最容易走错页（§16.4-1） */
          h('div', { className: 'roost-note' },
            '接话策略、防吵、冷却在「设置 → roostHost.decide」；这一页管记忆、心情、主动和扩展。'),
          /**
           * A10（第二轮对照）：开关全留在本页，另加一层「按功能分组 → 细调页」的导航。
           * 只增不减：权限页仍是这批开关的正门，细调页是并列入口，不是搬家。
           * 只给有明确对应页的组做按钮；「干不干活 / 高级」就在本页调，不乱指路。
           */
          h('div', { className: 'cap-group' },
            h('div', { className: 'cap-group-t' }, '按功能分组 · 去对应页细调'),
            h('div', { className: 'roost-note', style: { marginBottom: 8 } },
              '下面的开关在这一页就能改，不用跑别处；这里只是给「想细调」的人一个直达入口。'
              + '怎么说话 → 表达（语音 / 表情包），记不记得 → 记忆，消息来不及回 → 群聊策略，会不会主动找你 → 主动搭话。'),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              ...[
                ['语音', 'express'],
                ['表情包', 'stickers'],
                ['记忆', 'memory'],
                ['群聊策略', 'groupchat'],
                ['主动搭话', 'awake'],
              ].map(([label, to]) => h('button', {
                key: to, type: 'button', className: 'roost-btn',
                onClick: () => {
                  if (setTab) setTab(to)
                  toast(`已切到「${label}」；开关仍留在权限页，改完随时回来`)
                },
              }, `细调：${label} ↗`)),
            ),
          ),
          feat
            ? (feat.groups || []).map((g) => {
                const items = (feat.features || []).filter((f) => (g.ids || []).includes(f.id))
                if (!items.length) return null
                /** 高级组用原生 details 默认收起：新开关多了不能一上来把人淹没（§16.5-4） */
                return h(g.advanced ? 'details' : 'div', { key: g.id, className: 'cap-group' },
                  h(g.advanced ? 'summary' : 'div', { className: 'cap-group-t' },
                    g.advanced ? `${g.label} · ${items.length} 项，点开看看` : g.label),
                  h('div', { className: 'cap-group-b' },
                    items.map((f) => {
                      const kind = f.kind || 'toggle'
                      const isToggle = kind === 'toggle'
                      const on = !!feat.on?.[f.id]
                      const blocked = !on && feat.blocked?.[f.id]
                      /** 非布尔项的当前值来自 `feat.settings`，不来自 `feat.on` */
                      const cur = feat.settings?.[f.id] ?? f.default
                      const draft = featDraft[f.id]

                      let control
                      if (isToggle) {
                        control = h(Switch, {
                          on,
                          disabled: busy || !!blocked,
                          title: blocked || '',
                          label: f.label || f.id,
                          onToggle: (next) => toggleFeat(f.id, next),
                        })
                      } else if (kind === 'select') {
                        /** 当前值不在预设选项里 = 用户填过「自定义」 */
                        const known = (f.options || []).some((o) => String(o.value) === String(cur))
                        const opts = [
                          ...(f.options || []).map((o) =>
                            h('option', { key: String(o.value), value: String(o.value) }, o.label)),
                          ...(f.custom ? [h('option', { key: '__custom', value: '__custom' }, '自定义…')] : []),
                          ...(!known && !f.custom
                            ? [h('option', { key: '__cur', value: String(cur) }, String(cur))]
                            : []),
                        ]
                        control = h('div', { className: 'cap-ctl' },
                          h('select', {
                            value: draft !== undefined ? String(draft)
                              : (known ? String(cur) : (f.custom ? '__custom' : String(cur))),
                            disabled: busy,
                            onChange: (e) => {
                              const v = e.target.value
                              if (v === '__custom') {
                                setFeatDraft((d) => ({ ...d, [f.id]: '__custom' }))
                                return
                              }
                              setFeatValue(f.id, v)
                            },
                          }, opts),
                          (f.custom && (draft === '__custom' || (!known && draft === undefined)))
                            ? h('input', {
                                type: 'number', min: f.min, max: f.max,
                                defaultValue: known ? '' : String(cur),
                                disabled: busy,
                                onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
                                onBlur: (e) => {
                                  const v = String(e.target.value ?? '').trim()
                                  if (v) setFeatValue(f.id, v)
                                },
                              })
                            : null,
                        )
                      } else {
                        /** number：编辑期用草稿，失焦 / 回车才提交 */
                        control = h('input', {
                          type: 'number',
                          className: 'cap-num',
                          min: f.min,
                          max: f.max,
                          value: draft !== undefined ? draft : String(cur ?? ''),
                          disabled: busy,
                          onChange: (e) => setFeatDraft((d) => ({ ...d, [f.id]: e.target.value })),
                          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
                          onBlur: (e) => {
                            const v = String(e.target.value ?? '').trim()
                            const clear = () => setFeatDraft((d) => {
                              const n = { ...d }; delete n[f.id]; return n
                            })
                            /**
                             * 清空输入框 = 放弃这次编辑，**不能发 patch**。
                             *
                             * 后端 `normalizeSetting` 现在会拒空值（返回 400），
                             * 但更早在前端挡掉能少一次无谓请求和一句报错 toast。
                             * 以前这里把 `''` 提交上去，`Number('')` 是 0，
                             * 会把 `queueMax` 静默改成 0（关掉排队）。
                             */
                            if (!v) return clear()
                            /**
                             * 按数值比较：'02' / '2 ' 和 2 是同一个值，不必多发一次 patch。
                             * 但 `cur` 若是空串 / null（后端异常返回），`Number(cur)` 会得 0——
                             * 那时用户真想填 0 会被误判成「没改」而丢掉提交，所以先判 cur 是否有效。
                             */
                            const curValid = cur !== '' && cur !== null && cur !== undefined
                            if (v === String(cur ?? '') || (curValid && Number(v) === Number(cur))) return clear()
                            setFeatValue(f.id, v)
                          },
                        })
                      }

                      return h('div', { key: f.id, className: 'cap-row' },
                        control,
                        h('div', { className: 'cap-row-b' },
                          h('div', null, f.label, f.risky ? ' 🔴' : ''),
                          h('div', { className: 'roost-note', style: { margin: 0 } }, f.desc),
                          isToggle && !on
                            ? h('div', { className: 'roost-note', style: { margin: 0 } }, `关掉之后：${f.offHint}`)
                            : null,
                          !isToggle
                            ? h('div', { className: 'roost-note', style: { margin: 0 } },
                                `当前 ${cur}${f.max !== undefined ? ` · 可填 ${f.min}–${f.max}` : ''}`)
                            : null,
                          blocked ? h('div', { className: 'roost-note', style: { margin: 0 } }, `⚠️ ${blocked}`) : null,
                        ),
                      )
                    }),
                  ),
                )
              })
            : h('div', { className: 'roost-empty' }, '正在读功能开关…'),
          /**
           * D11：影响已存数据的开关必须先给 dry-run 预览，用户确认了才动数据。
           * 「默认开」开的只是策略档位，没点「应用」前盘上一条记忆都不会变。
           */
          retention && retention.ok
            ? h('div', { className: 'cap-group' },
                h('div', { className: 'cap-group-t' }, '旧记忆淡出 · 先看会动到什么'),
                h('div', { className: 'cap-group-b' },
                  h('div', { className: 'roost-note', style: { margin: 0 } }, retention.text),
                  h('div', { className: 'roost-note', style: { margin: 0 } },
                    `事实：${retention.facts.enabled ? retention.facts.mode : '关'} · 日记：${retention.journal.enabled ? retention.journal.mode : '关'}；共扫 ${retention.total} 条。改档位不碰数据，要下面这个按钮才生效。`),
                  h('div', { className: 'roost-note', style: { margin: 0 } },
                    retention.autoSweep
                      ? '已手动确认过一次：之后每天凌晨巩固时按当前策略自动重复。点「一键恢复」会停止自动。'
                      : '还没点过「应用」，不会自动改动记忆。点一次之后，才会每天凌晨自动重复同一策略。'),
                  (retention.expiredFacts || retention.expiredJournal)
                    ? h('div', { className: 'roost-note', style: { margin: 0 } },
                        `已作废 ${retention.expiredFacts} 条事实、${retention.expiredJournal} 条日记，可一键恢复。`)
                    : null,
                  h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                    h('button', {
                      type: 'button', className: 'roost-primary',
                      disabled: busy || !retention.affected,
                      onClick: async () => {
                        const r = await quick('retention.apply')
                        toast(r.message || (r.ok ? '应用好了' : '没改成'))
                        reload()
                      },
                    }, retention.purge ? '应用（会真删，先自动备份）' : '应用（作废，可恢复）'),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      disabled: busy || !(retention.expiredFacts || retention.expiredJournal),
                      onClick: async () => {
                        const r = await quick('retention.restore')
                        toast(r.message || (r.ok ? '恢复了' : '没改成'))
                        reload()
                      },
                    }, '一键恢复'),
                  ),
                ),
              )
            : null,
          feat && (feat.wouldRemove || []).length
            ? h('div', { className: 'roost-note' },
                `按现在的设置，这一轮会收走：${listOf(feat.wouldRemove, 6)}`)
            : null,
          h('div', { className: 'roost-note' },
            '带 config 的开关和「设置」页是同一份，在哪儿改都一样；发文件那个存在能力策略里。'),
          h('div', { className: 'roost-note' },
            '她记了什么、能清哪些：看左侧「记忆」页；人物档案、经历、召回日志都归到那边查看和清空。'),
        ),

        h(Sec, {
          n: '03', title: '五个档位',
          right: h('span', { className: 'roost-note', style: { margin: 0 } }, `工具池 ${pool.length} 个`),
        },
          /**
           * 没启用时，下面这份是**按默认策略试算**的结果，和真实生效无关
           * （真实生效还走旧的 permissions）。不说明的话，用户会以为
           * 「这里有内容 = 已经管上了」，然后再也不点启用。
           */
          caps.enabled
            ? null
            : h('div', { className: 'roost-note' },
                '还没启用。下面是按默认策略算出来的预览，用来让你看看启用后大致是什么样；现在实际生效的还是设置页那一套。'),
          results.length
            ? h('div', { className: 'roost-list roost-scroll' },
                BUCKET.map(([id, label, who]) => {
                  const r = byBucket[id]
                  if (!r) return null
                  const allow = r.allow || []
                  const deny = r.deny || []
                  /**
                   * 当前角色按**配置原文**判（`store.defaults[b].allow`），
                   * 不按试算结果判：试算会把 `*` 和 `group:x` 展开成几十个名字，
                   * 拿它去和预设的 `['*']` 比永远不相等，界面会一直显示「自定义」。
                   */
                  const cur = roleOf(caps.store?.defaults?.[id]?.allow)
                  return h('div', { key: id, className: 'cap-card' },
                    h('div', { className: 'cap-card-h' },
                      h('span', { className: 'n' }, label),
                      h('span', { className: 'm' }, who),
                      h('span', { className: 'c' },
                        `能用 ${allow.length} · 收走 ${deny.length}`,
                        cur === 'inherit' ? ' · 跟随更低档' : cur === 'custom' ? ' · 自定义' : ''),
                    ),
                    h('div', { className: 'cap-card-b' },
                      /**
                       * 用 `.roost-chip` 而不是 `.roost-btn`：
                       * chip 有 `[data-on="1"]` 的选中样式（描边 + 加粗 + 淡底），
                       * btn 没有——所以之前四个按钮长得一模一样，看不出选了哪个。
                       */
                      ROLES.filter((role) => !role.inherit || id !== 'owner').map((role) =>
                        h('button', {
                          key: role.id,
                          type: 'button',
                          className: 'roost-chip',
                          'data-on': cur === role.id ? '1' : '0',
                          'data-role': role.id,
                          title: role.hint,
                          disabled: busy || !caps.enabled,
                          onClick: () => setRole(id, role),
                        }, (cur === role.id ? '✓ ' : '') + role.label),
                      ),
                    ),
                    h('div', { className: 'cap-card-a', title: allow.join('、') },
                      allow.length ? `能用：${listOf(allow, 8)}` : '什么都调不了'),
                  )
                }).concat([
                  /**
                   * 兜底档只展示、不给按钮。
                   * 它不是一个「配置项」，而是「出问题时降到哪」——
                   * 给了入口就等于给了手动放开它的机会。
                   */
                  h('div', { key: 'unknown', className: 'cap-card', style: { opacity: 0.5 } },
                    h('div', { className: 'cap-card-h' },
                      h('span', { className: 'n' }, CAP_FALLBACK[1]),
                      h('span', { className: 'm' }, CAP_FALLBACK[2]),
                      h('span', { className: 'c' }, '🔒 固定'),
                    ),
                    h('div', { className: 'cap-card-a' },
                      '拿不到权限信息时用这一档。没有操作入口，是故意的——它是最后一道闸。'),
                  ),
                ]),
              )
            : h('div', { className: 'roost-empty' },
                caps.enabled
                  ? '还没有观察记录：在群里说一句话，这一页就有数据了。'
                  : '启用之后这里会显示五个档位各能用什么。'),
        ),

        h(Sec, {
          n: '04', title: '工具清单',
          right: h('span', { className: 'roost-note', style: { margin: 0 } },
            h('button', {
              type: 'button',
              className: 'roost-btn',
              style: { marginRight: '8px' },
              disabled: busy || !caps.enabled || !pool.length,
              onClick: () => setToolsOpen(true),
            }, `逐个调整${pool.length ? `（${pool.length} 个）` : ''}`),
            '按来源分组'),
        },
          pool.length
            ? h('div', { className: 'roost-list roost-scroll' },
                Object.keys(groups).map((g) =>
                  /** 不能套 .roost-item：横排 flex 里 .d 是不换行的长工具名，
                      会把「其他 · 4 个」挤成一个字一行（2026-11-11 截图）。 */
                  h('div', { key: g, className: 'diag-item' },
                    h('div', { className: 't' }, g,
                      h('span', { className: 'd' }, ` · ${groups[g].length} 个`)),
                    h('div', { className: 'd', title: groups[g].map(withNote).join('、') },
                      listOf(groups[g], 5)),
                  ),
                ),
              )
            : h('div', { className: 'roost-empty' }, '还没看到工具。先让它在群里回一句话。'),
          h('div', { className: 'roost-note' },
            '清单来自 DSH 实际挂载的工具，不是我们写死的名单——装了新插件、接了新 MCP，这里会自己多出来。'),
        ),

        h(Sec, {
          n: '05', title: '分群例外',
          right: h('span', { className: 'roost-note', style: { margin: 0 } }, '只配例外'),
        },
          h('div', { className: 'roost-note' },
            '默认按档位。这里只配例外——**没有列出来的群，一律走上面的默认**。'),
          /** A2：同一份「按群」设置两个入口，把「谁管哪一半」和跳转写清楚 */
          h('div', { className: 'roost-note' },
            '这半页只管「谁能用」（跟随默认 / 只能聊天）。接话频率、静默时段、插话概率这类细调在「群聊策略 → 按群覆写」，两边改的是同一份配置。',
            h('button', {
              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
              onClick: () => { if (setTab) setTab('groupchat') },
            }, '去按群覆写 ↗'),
          ),
          (chats || []).length
            ? h('div', { className: 'roost-list roost-scroll' },
                (chats || []).map((c) => {
                  const ov = caps.store?.chats?.[c.chatId]
                  const mode = ov?.chatOnly ? 'chatOnly' : ov ? 'custom' : 'inherit'
                  return h('div', { key: c.chatId, className: 'roost-item' },
                    h('span', { className: 't' },
                      c.title || String(c.chatId).slice(0, 10),
                      h('span', { className: 'd' },
                        ' · ' + (mode === 'chatOnly' ? '只能聊天' : mode === 'custom' ? '自定义覆盖' : '跟随默认')),
                    ),
                    h('span', { className: 'd' },
                      h('button', {
                        type: 'button', className: 'roost-btn',
                        'data-on': mode === 'inherit' ? '1' : '0',
                        style: { marginRight: '6px', opacity: mode === 'inherit' ? 1 : 0.75 },
                        disabled: busy || !caps.enabled,
                        onClick: () => setChat(c.chatId, null, c.title),
                      }, '跟随默认'),
                      h('button', {
                        type: 'button', className: 'roost-btn',
                        'data-on': mode === 'chatOnly' ? '1' : '0',
                        style: { opacity: mode === 'chatOnly' ? 1 : 0.75 },
                        disabled: busy || !caps.enabled,
                        onClick: () => setChat(c.chatId, { chatOnly: true, label: c.title || '' }, c.title),
                      }, '只能聊天'),
                    ),
                  )
                }),
              )
            : h('div', { className: 'roost-empty' },
                '还没有群说过话。等它在某个群回一句，这里就会出现那个群。'),
          h('div', { className: 'roost-note' },
            '「只能聊天」是硬承诺：不管群成员档被改成什么，这个群都只给回话必需的工具。适合公开群。'),
          h('div', { className: 'roost-note' },
            '列表只包含**说过话的群**——群名来自 Roost 推过来的消息，没说过话的群这里看不到，但它照样走默认。'),
        ),

        /**
         * 次数限制放在最后。
         *
         * 前面的都决定「能不能」，这一节决定「一天能几次」——
         * 前者是主人每天要看的，后者是配一次就不动的，所以放末尾。
         */
        h(Sec, { n: '06', title: '次数限制',
          right: h('span', { className: 'roost-note', style: { margin: 0, display: 'inline-flex', alignItems: 'center', gap: '6px' } },
            '按',
            h('select', {
              className: 'roost-input',
              style: { width: 'auto', padding: '2px 6px' },
              value: quotaBucket,
              onChange: (e) => setQuotaBucket(e.target.value),
            },
              BUCKET.map(([id, label]) => h('option', { key: id, value: id }, label)),
            ),
            '算',
            h('button', { type: 'button', className: 'roost-btn', style: { marginLeft: '6px' }, onClick: reload }, '刷新'),
          ) },
          h('div', { className: 'roost-note' },
            '默认全部不限——装上新版本不会突然开始拦人，填了数字才开始算。留空 = 不限，填 0 = 完全禁用。防刷屏用的，不是安全边界——换个号就能绕，真正拦人的是上面的档位。'),
          quota && quota.rows && quota.rows.length
            ? h('div', null,
                /**
                 * 内置动作和工具**分开列**。
                 *
                 * 内置那几个（语音条 / 发文件 / 表情包）是「她主动做的事」，
                 * 用户脑子里有明确概念；工具是「她能调的能力」，数量几十个，
                 * 混在一张表里会把前三行淹掉。
                 */
                h('div', { className: 'cap-group' },
                  h('div', { className: 'cap-group-t' }, '她主动做的事'),
                  h('div', { className: 'cap-group-b' }, quotaRows('builtin')),
                ),
                h('div', { className: 'cap-group' },
                  h('div', { className: 'cap-group-t' },
                    '工具（只填想限的）',
                    h('span', { style: { fontWeight: 400, marginLeft: '8px' } },
                      quota.poolSource === 'live' ? `清单来自 DSH，共 ${(quota.pool || []).length} 个`
                        : quota.poolSource === 'seen' ? '当前没有活着的会话，清单来自上次记录'
                          : '还没看到任何工具'),
                  ),
                  h('div', { className: 'cap-group-b' }, quotaRows('tool')),
                ),
              )
            : h('div', { className: 'roost-empty' }, '正在读用量…'),
          h('div', { className: 'roost-note' },
            '「目前最多用到」看的是**用得最多的那一个**，不是总和——十个人各用一次不等于超了十倍。'),
          h('div', { className: 'roost-note' },
            '工具次数是**真的当场拦**（DSH 的 tools.guard）：超了这一次调用直接失败，模型会被告知「别再试」。'),
          h('div', { className: 'roost-note' },
            '想给主人单独放宽：把上面的下拉切到「主人」，填一个更大的数——那一档会单独存一份，不影响别人。'),
        ),

        /**
         * 2.8 授权名单：aurabot 的「私聊用户 / 群白名单 / 主人」三张表。
         * 我们的主人名单在框架侧（config/bots/<id>.json），这里只读 + 指路，
         * 绝不放一个改了不生效的编辑框；群白名单是自己的 awake.groups，
         * 才做批量添加与实时统计。
         */
        h(Sec, { n: '07', title: '授权名单',
          right: h('span', { className: 'roost-note', style: { margin: 0 } },
            '群归这里管 · 主人归框架面板') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '五档管「能做什么」，名单管「在哪儿能用」。群白名单是「允许她在这些群主动说话」，默认全关；'
            + '主人 openid 存在 Roost 框架的 config/bots/<id>.json，由框架面板的「主人与群组」管，'
            + '这一页只读展示，不提供一个改了不生效的输入框。'),

          h('div', { className: 'cap-group' },
            h('div', { className: 'cap-group-t' }, '主人 / 私聊对象（框架管）'),
            h('div', { className: 'roost-note', style: { marginBottom: 8 } },
              setupSt?.ownersConfigured
                ? `框架里已设 ${setupSt.ownerCount || 0} 个主人，分布在 ${(setupSt.bots || []).length} 个机器人里。`
                : '框架里还没配主人。没设主人时她只能聊天、不能动工具。'),
            (setupSt?.bots || []).length
              ? h('div', { style: { display: 'grid', gap: 4, marginBottom: 8 } },
                  setupSt.bots.map((b, i) => h('div', { key: i, className: 'roost-note' },
                    '· ' + (b.name || b.id || '未命名') + ' · 主人 ' + (b.ownerCount ?? 0) + ' 个'
                    + (b.appId ? '' : '（没填 AppID）'))))
              : h('div', { className: 'roost-empty', style: { marginBottom: 8 } }, '还读不到机器人清单。'),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: () => { if (setTab) setTab('setup') },
              }, '去接入页第 6 步'),
              setupSt?.webui
                ? h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: () => window.open(String(setupSt.webui) + '#groups', '_blank', 'noopener'),
                  }, '打开框架面板的「主人与群组」')
                : null,
            ),
          ),

          h('div', { className: 'cap-group' },
            h('div', { className: 'cap-group-t' }, `群白名单（${wlGroups.length}）`),
            h('div', { className: 'roost-note', style: { marginBottom: 8 } },
              '一行一个，可以写「群 chatId 备注名」，也可以用逗号 / 分号分隔；'
              + '从「会话」页复制 chatId，或点「从最近会话导入」把见过的群列进草稿先看一眼。'),
            h('textarea', {
              className: 'roost-input', rows: 4,
              style: { width: '100%', minHeight: 76, resize: 'vertical' },
              placeholder: 'GROUP_OPENID_1 测试群\nGROUP_OPENID_2',
              value: wlDraft,
              onChange: (e) => setWlDraft(e.target.value),
            }),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' } },
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: () => {
                  const rows = suggestGroupWhitelist(chats, wlGroups)
                  if (!rows.length) return toast('最近会话里没有新群')
                  setWlDraft((wlDraft ? wlDraft.trim() + '\n' : '') + rows.join('\n'))
                },
              }, '从最近会话导入'),
              h('button', {
                type: 'button', className: 'roost-primary',
                disabled: busy || wlPlan.stats.added === 0 || !saveCfg,
                onClick: () => saveGroups(wlPlan.next, `加了 ${wlPlan.stats.added} 个群`),
              }, `把 ${wlPlan.stats.added} 条加进名单`),
            ),
            /** 四项统计每次渲染都重算：纯函数、不写盘、不发请求 */
            h('div', { className: 'roost-note', style: { marginBottom: 8 } },
              `新增 ${wlPlan.stats.added} · 重复 ${wlPlan.stats.duplicate} · 跳过主人/私聊 ${wlPlan.stats.skippedOwner} · 格式错 ${wlPlan.stats.invalid}`),
            wlPlan.notes.length
              ? h('details', null,
                  h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
                    `逐条说明（${wlPlan.notes.length}）`),
                  h('div', { style: { display: 'grid', gap: 4, marginTop: 6 } },
                    wlPlan.notes.slice(0, 12).map((n, i) => h('div', { key: i, className: 'roost-note' }, '· ' + n))))
              : null,
            wlGroups.length
              ? h('div', { style: { display: 'grid', gap: 4, marginTop: 8 } },
                  wlGroups.map((g, i) => h('div', {
                    key: g.chatId || i, className: 'roost-note',
                    style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: 0 },
                  },
                    h('label', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                      h('input', {
                        type: 'checkbox', checked: g.enabled !== false,
                        onChange: () => saveGroups(
                          wlGroups.map((x) => x.chatId === g.chatId
                            ? { ...x, enabled: x.enabled === false } : x),
                          '已更新',
                        ),
                      }),
                      g.enabled === false ? '关' : '开'),
                    h('span', { className: 't' }, g.name || g.chatId),
                    h('span', { className: 'roost-code' }, g.chatId),
                    h('button', {
                      type: 'button', className: 'roost-btn danger',
                      onClick: () => saveGroups(wlGroups.filter((x) => x.chatId !== g.chatId), '已移出名单'),
                    }, '移出'),
                  )))
              : h('div', { className: 'roost-empty', style: { marginTop: 8 } },
                  '名单是空的 —— 一个群都不会主动说话。'),
            h('div', { className: 'roost-note', style: { marginTop: 8 } },
              '光在白名单里还不够：群主动另需一条 group_push 授权（官方硬前置），在「主动搭话」页记。'),
          ),
        ),
      )
    }

    /* ---------------- 群管 ---------------- */

    /**
     * 群管：禁言 / 解禁、踢人、入群审批。
     *
     * 和「身份」页不重复：那边是「QQ 会话 ↔ DSH 会话」的映射，这边是**对群动手**。
     * 协议侧 `group.*` 的 scope 是 `message`（装了就能用），所以这里没有
     * 「先去开权限」这一步；真管不了只有两种——机器人不是管理员、踢人缺
     * 群管内邀。两种情况后端都把 reason 翻成了人话，页面上照着显示。
     *
     * 群只能从「它待过的会话」里选：官方没有群列表接口，群是消息事件发现的。
     */
    /* ── 群聊策略页的卡片骨架 ─────────────────────────────────────
     *
     * 形态借 aurabot beta 的 `Group` 页（client.js:2111）：一张卡 = 一句
     * desc + 若干 Row，Row 左边「标题 + 小字解释」、右边控件，总开关挂卡片
     * 右上。这里套我们的 `Sec` 外壳，编号、折叠、进入动画和别的页一致；
     * 配色走 --accent / --surface / --line，不用它的海蓝 --ab-sea。
     *
     * 只露已经有、面板却看不见的配置键（config.js:574 merge / :594 decide
     * / :156 chat），一个算法都不新增。真缺的插话概率、按群覆写留在 2.2b。
     */
    function GCard({ n, title, desc, right, children }) {
      return h(Sec, { n, title, right },
        h('div', { className: 'roost-g-card' },
          desc ? h('p', { className: 'roost-g-desc' }, desc) : null,
          children,
        ))
    }

    function GRow({ label, hint, children }) {
      return h('div', { className: 'roost-g-row' },
        h('div', { className: 'roost-g-label' },
          h('b', null, label),
          hint ? h('small', null, hint) : null),
        h('div', { className: 'roost-g-ctl' }, children))
    }

    /** 失焦 / 回车才写盘：每敲一个字符都保存，会把配置写成半截数字 */
    function GNum({ value, onSave, min = 0, max = 99999, step = 1, unit, disabled }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('input', {
          type: 'number', className: 'roost-g-num',
          min: String(min), max: String(max), step: String(step),
          /** 后端回读后同步显示；否则保存成功界面还停在上一个值 */
          key: 'v:' + String(value),
          defaultValue: String(value ?? ''),
          disabled: !!disabled,
          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
          onBlur: (e) => {
            const raw = String(e.target.value ?? '').trim()
            const n = raw === '' ? min : Number(raw)
            if (!Number.isFinite(n)) { e.target.value = String(value ?? ''); return }
            const v = Math.min(max, Math.max(min, n))
            if (v === Number(value)) { e.target.value = String(v); return }
            onSave(v)
          },
        }),
        unit ? h('span', { className: 'roost-g-unit' }, unit) : null)
    }

    const DECIDE_MODES = [
      ['ai', '每条都看（默认）'],
      ['mention', '只在被 @ 时回'],
      ['window', '@ 之后接着聊一阵'],
      ['engaged', '聊开了就接下去'],
    ]

    /**
     * 按群覆写能改的字段。键名必须和 `roost-decide.js` 的 OVERRIDE_KEYS 对齐——
     * 那边是白名单，这里写了个它不认的键，界面上改了也不会生效。
     */
    const OV_FIELDS = [
      { key: 'mode', label: '接话方式', kind: 'select', options: DECIDE_MODES },
      { key: 'interruptChance', label: '插话概率', kind: 'num', min: 0, max: 100, unit: '%' },
      { key: 'cooldownSec', label: '两次至少隔', kind: 'num', min: 0, max: 600, unit: '秒' },
      { key: 'maxRepliesPerMin', label: '每分钟最多', kind: 'num', min: 0, max: 60, unit: '条' },
      { key: 'maxPerHour', label: '每小时最多', kind: 'num', min: 0, max: 500, unit: '条' },
      { key: 'quietStartHour', label: '安静从', kind: 'num', min: 0, max: 23, unit: '点' },
      { key: 'quietEndHour', label: '安静到', kind: 'num', min: 0, max: 23, unit: '点' },
      { key: 'shortAskMustReply', label: '短问必答', kind: 'switch' },
      { key: 'silent', label: '这个群一键静默', kind: 'switch' },
    ]

    /**
     * 覆写专用数值框：和 GNum 的差别是**允许留空**。
     * 空 = 这一项不覆写、跟全局；GNum 会把空串压成 min，那样永远删不掉覆写。
     */
    function GOvNum({ value, onSave, min = 0, max = 99999, unit, disabled }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('input', {
          type: 'number', className: 'roost-g-num',
          min: String(min), max: String(max), step: '1',
          key: 'ov:' + String(value ?? ''),
          defaultValue: value === undefined || value === null ? '' : String(value),
          disabled: !!disabled,
          onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
          onBlur: (e) => {
            const raw = String(e.target.value ?? '').trim()
            if (raw === '') { onSave(undefined); return }
            const n = Number(raw)
            if (!Number.isFinite(n)) {
              e.target.value = value === undefined ? '' : String(value)
              return
            }
            const v = Math.min(max, Math.max(min, n))
            if (v === Number(value)) { e.target.value = String(v); return }
            onSave(v)
          },
        }),
        unit ? h('span', { className: 'roost-g-unit' }, unit) : null)
    }

    function GroupChatTab({ config, saveCfg, saveAll, toast, setTab, chats }) {
      const decide = config?.roostHost?.decide || {}
      const merge = config?.roostHost?.merge || {}
      const chat = config?.chat || {}
      const groupCfg = config?.group || {}
      const overrides = groupCfg.overrides || {}
      const groups = (chats || []).filter((c) => c.kind === 'group')
      const [busy, setBusy] = useState(false)
      /** null = 跟随后端值；编辑中才有内容，失焦提交后清空 */
      const [wordsDraft, setWordsDraft] = useState(null)
      /** 按群覆写：选中的群 + 编辑草稿（null = 用盘上的值） */
      const [ovGid, setOvGid] = useState('')
      const [ovDraft, setOvDraft] = useState(null)
      /** 决策链：null = 还没读到，[] = 读到了但还没有判定 */
      const [decisions, setDecisions] = useState(null)

      const loadDecisions = useCallback(async () => {
        try {
          const r = await get('/group/decisions?limit=20')
          setDecisions(Array.isArray(r?.items) ? r.items : [])
        } catch { setDecisions([]) }
      }, [])
      useEffect(() => { loadDecisions() }, [loadDecisions])
      /** 换群要丢掉上一个群的草稿，别把它写到新群头上 */
      useEffect(() => { setOvDraft(null) }, [ovGid])

      /**
       * 配置没到不渲染控件：在空对象上点保存，会把 roostHost 的 token /
       * url 一起冲掉（深合并只保证「没提交的键保留」，不保证提交的是全量）。
       */
      if (!config) return h('div', { className: 'roost-note' }, '读取配置…')

      const put = async (patch) => {
        if (!saveCfg || busy) return
        setBusy(true)
        try {
          const r = await saveCfg(patch)
          toast(r?.ok === false ? (r.message || '没存上') : '已保存，下一轮生效')
        } finally { setBusy(false) }
      }
      const setDecide = (k, v) => put({ roostHost: { decide: { [k]: v } } })
      const setMerge = (k, v) => put({ roostHost: { merge: { [k]: v } } })
      const setChat = (k, v) => put({ chat: { [k]: v } })
      const setGroup = (k, v) => put({ group: { [k]: v } })

      const pickOv = ovGid || groups[0]?.chatId || Object.keys(overrides)[0] || ''
      const ov = ovDraft !== null ? ovDraft : { ...(overrides[pickOv] || {}) }
      const setOv = (k, v) => {
        const next = { ...ov }
        if (v === undefined) delete next[k]
        else next[k] = v
        setOvDraft(next)
      }
      /**
       * 覆写的增改删必须走**整份保存**（saveAll / ?mode=full）。
       * 局部 patch 的 merge 只遍历提交的键，删掉一个键 / 一个群会静默失效：
       * 盘上那份还在，界面显示「已恢复全局」，下一句却照样按覆写走。
       */
      const saveOverride = async (obj) => {
        if (!saveAll || !pickOv || busy) return
        setBusy(true)
        try {
          const rest = { ...overrides }
          if (Object.keys(obj).length) rest[pickOv] = obj
          else delete rest[pickOv]
          const r = await saveAll({ ...config, group: { ...groupCfg, overrides: rest } })
          toast(r?.ok === false ? (r.message || '没存上') : '已保存，下一句生效')
          setOvDraft(null)
        } finally { setBusy(false) }
      }

      const chatName = (id) => {
        const g = groups.find((x) => x.chatId === id)
        return g?.title || (id ? String(id).slice(0, 8) + '…' : '（未知会话）')
      }
      const hhmmss = (ms) => {
        try { return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) }
        catch { return '' }
      }
      const words = wordsDraft !== null
        ? wordsDraft
        : (Array.isArray(decide.ignoreWords) ? decide.ignoreWords.join('\n') : '/')

      return h('div', null,
        h(GCard, {
          n: '01', title: '什么时候接话',
          desc: '只对群里没被 @ 的消息生效。私聊、被 @、命令永远直接接——这些是明确在叫她，不该被策略拦。',
        },
          h(GRow, { label: '接话方式', hint: '选了之后她每条群消息都会先过这一道，再去问模型' },
            h('select', {
              className: 'roost-g-sel', value: decide.mode || 'ai', disabled: busy,
              onChange: (e) => setDecide('mode', e.target.value),
            }, DECIDE_MODES.map(([v, t]) => h('option', { key: v, value: v }, t)))),
          h(GRow, { label: '@ 之后接着聊多久', hint: '只在「@ 之后接着聊一阵」模式下有用；窗口只由真 @ 打开，命令不算' },
            h(GNum, { value: decide.windowMin ?? 3, min: 1, max: 60, unit: '分钟', disabled: busy,
              onSave: (v) => setDecide('windowMin', v) })),
          h(GRow, { label: '连聊最多接几次', hint: '聊开了之后，没人接话时最多再连着接几次就先停；默认 6' },
            h(GNum, { value: decide.engagedMaxTurns ?? 6, min: 0, max: 30, unit: '次', disabled: busy,
              onSave: (v) => setDecide('engagedMaxTurns', v) })),
        ),

        h(GCard, {
          n: '02', title: '连发合并',
          desc: '人常常一口气发好几句。等她说完再一起回，而不是一句一回，省调用也少刷屏。她正忙时来的消息会攒着，等这一轮结束合在一起回，不会逐条刷「还在想」。',
        },
          h(GRow, { label: '私聊停顿多久算说完', hint: '从最后一条消息算起；太短会把一句话劈成两半' },
            h(GNum, { value: merge.waitSec ?? 1.5, min: 0.5, max: 10, step: 0.5, unit: '秒', disabled: busy,
              onSave: (v) => setMerge('waitSec', v) })),
          h(GRow, { label: '私聊最多等多久', hint: '对方一直在发，从第一条算也最多等这么久' },
            h(GNum, { value: merge.maxSec ?? 6, min: 2, max: 30, unit: '秒', disabled: busy,
              onSave: (v) => setMerge('maxSec', v) })),
          h(GRow, { label: '群里停顿多久算一段', hint: '群里你一句我一句说得慢，多等一会儿攒齐再回；她正忙时新消息也先攒着' },
            h(GNum, { value: merge.groupWaitSec ?? 5, min: 1, max: 20, unit: '秒', disabled: busy,
              onSave: (v) => setMerge('groupWaitSec', v) })),
          h(GRow, { label: '群里最多等多久', hint: '从这一段第一条算，一直有人发也最多等这么久' },
            h(GNum, { value: merge.groupMaxSec ?? 15, min: 3, max: 60, unit: '秒', disabled: busy,
              onSave: (v) => setMerge('groupMaxSec', v) })),
        ),

        h(GCard, {
          n: '03', title: '安全刹车',
          desc: '只防失控（比如和别的机器人聊起来停不下）。被 @、引用她、喊名字不算主动接话，不会被刹车拦；平时碰不到。填 0 = 不限。',
          right: h(Switch, {
            on: decide.silent === true, label: '一键静默', disabled: busy,
            onToggle: (v) => setDecide('silent', v),
          }),
        },
          h(GRow, { label: '两次接话至少隔多久', hint: '冷却期里的消息攒着，不丢；0 = 不冷却' },
            h(GNum, { value: decide.cooldownSec ?? 20, min: 0, max: 600, unit: '秒', disabled: busy,
              onSave: (v) => setDecide('cooldownSec', v) })),
          h(GRow, { label: '每分钟最多接几条', hint: '0 = 不限；默认 3' },
            h(GNum, { value: decide.maxRepliesPerMin ?? 3, min: 0, max: 60, unit: '条', disabled: busy,
              onSave: (v) => setDecide('maxRepliesPerMin', v) })),
          h(GRow, { label: '每小时最多接几条', hint: '0 = 不限（默认）' },
            h(GNum, { value: decide.maxPerHour ?? 0, min: 0, max: 500, unit: '条', disabled: busy,
              onSave: (v) => setDecide('maxPerHour', v) })),
          h(GRow, { label: '两分钟内最多接几次', hint: '突发上限，0 = 不限（默认）' },
            h(GNum, { value: decide.burstMax ?? 0, min: 0, max: 50, unit: '次', disabled: busy,
              onSave: (v) => setDecide('burstMax', v) })),
          h(GRow, { label: '短问必答', hint: '「在吗」「人呢」这类短问，刹车也不拦' },
            h(Switch, {
              on: decide.shortAskMustReply === true, label: '短问必答', disabled: busy,
              onToggle: (v) => setDecide('shortAskMustReply', v),
            })),
        ),

        h(GCard, {
          n: '04', title: '静默时段与忽略词',
          desc: '两条静默各管一头：「她别插话」是这段内她不主动接话、但被叫到还会回；'
            + '「对外静默」是这段内**连别人 @ 她也不起轮次**，只有主人叫得醒。忽略词是别的插件靠前缀干活的，别抢。',
        },
          h(GRow, { label: '她别插话', hint: '这段内不主动接话，但被 @ / 被叫到还是会回；起止相同 = 不设' },
            h(GNum, { value: decide.quietStartHour ?? 0, min: 0, max: 23, unit: '点', disabled: busy,
              onSave: (v) => setDecide('quietStartHour', v) }),
            h('span', { className: 'roost-g-unit' }, '到'),
            h(GNum, { value: decide.quietEndHour ?? 0, min: 0, max: 23, unit: '点', disabled: busy,
              onSave: (v) => setDecide('quietEndHour', v) })),
          /**
           * 对外静默（2026-11-19）：与上面那条正交。
           *
           * 两个输入都填了才生效（起止相同视为关），留空 = 不启用——半天填一半
           * 不该变成「整天把群友全挡了」。判定在 `roost-decide.js` 里排在
           * 「必回」四条之前，主人豁免。
           */
          h(GRow, { label: '对外静默（只有主人叫得醒）', hint: '这段内别人 @、引用、唤醒词、追问都不起轮次；两个都填才生效，留空 = 不启用' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('input', {
                type: 'time', className: 'roost-g-num', value: decide.guestQuietFrom || '', disabled: busy,
                onChange: (e) => setDecide('guestQuietFrom', e.target.value),
              }),
              h('span', { className: 'roost-g-unit' }, '到'),
              h('input', {
                type: 'time', className: 'roost-g-num', value: decide.guestQuietTo || '', disabled: busy,
                onChange: (e) => setDecide('guestQuietTo', e.target.value),
              }))),
          h(GRow, { label: '忽略词', hint: '一行一个；以这些词开头的消息不接，也不会触发一轮模型调用' },
            h('textarea', {
              className: 'roost-g-area', value: words, disabled: busy,
              onChange: (e) => setWordsDraft(e.target.value),
              onBlur: () => {
                if (wordsDraft === null) return
                const arr = wordsDraft.split('\n').map((s) => s.trim()).filter(Boolean)
                setWordsDraft(null)
                setDecide('ignoreWords', arr)
              },
            })),
        ),

        h(GCard, {
          n: '05', title: '一轮与队列',
          desc: '模型或工具卡住时，超过一轮时限就强制放开，后面的消息正常开新一轮；不然会一直哑着。',
        },
          h(GRow, { label: '一轮最多等多久', hint: '从这一轮开始算；太短会打断正常的长回复' },
            h(GNum, { value: chat.turnTimeoutSec ?? 150, min: 10, max: 900, unit: '秒', disabled: busy,
              onSave: (v) => setChat('turnTimeoutSec', v) })),
          h('div', { className: 'roost-g-note' },
            '她正忙时来的消息会攒着，等这一轮结束合在一起回，不会逐条刷「还在想」。私聊忙时直接插话进当前轮。',
            h('button', {
              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
              onClick: () => setTab && setTab('caps'),
            }, '去权限页')),
          h('div', { className: 'roost-g-note' },
            '「她刚才为什么没理我」：每条不接的消息都会把原因写进日志（比如「当前是只在被 @ 时回复模式」「冷却中」），去「排障」页看；本页最后一张卡也按时间列了最近 20 条。',
            h('button', {
              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
              onClick: () => setTab && setTab('logs'),
            }, '去排障页')),
        ),

        h(GCard, {
          n: '06', title: '插话概率',
          desc: '只管「群里没人明确叫她」的普通一句：她有多大概率主动接。被 @、私聊、命令、喊「在吗」、已经聊开了，都不掷骰子。',
        },
          h(GRow, { label: '插话概率', hint: '100 = 句句都接（升级前的行为）；0 = 只在明确被叫到时才说话' },
            h(GNum, {
              value: groupCfg.interruptChance ?? 100, min: 0, max: 100, unit: '%', disabled: busy,
              onSave: (v) => setGroup('interruptChance', v),
            })),
          h(GRow, { label: '群聊摘要回几条', hint: '主人在私聊里问「某群刚聊了什么」时最多带回几条时间线；只读，不记任何东西' },
            h(GNum, {
              value: groupCfg.briefMaxItems ?? 20, min: 1, max: 50, unit: '条', disabled: busy,
              onSave: (v) => setGroup('briefMaxItems', v),
            })),
          h('div', { className: 'roost-g-note' },
            '群聊摘要只在主人私聊里可用，且只能查群——群里的回复所有人都看得见；别人的私聊任何情况下都不查。'),
        ),

        h(GCard, {
          n: '07', title: '按群覆写',
          desc: '某个群想单独设（这个群安静点、那个群只在被 @ 时回），在这里给它一份例外。留空 = 跟上面的全局设置；没列的群一律不受影响。',
        },
          /** A2：这半页管「她怎么接话」，「谁能用」在权限页；双向都有入口 */
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '这里管接话行为；「权限 → 分群例外」管谁能用（跟随默认 / 只能聊天），两边是同一份配置的两个入口。',
            h('button', {
              type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
              onClick: () => { if (setTab) setTab('caps') },
            }, '去分群例外 ↗'),
          ),
          h(GRow, { label: '给哪个群设', hint: '群只能从它待过的会话里选；官方没有群列表接口' },
            groups.length
              ? h('select', {
                  className: 'roost-g-sel', value: pickOv, disabled: busy,
                  onChange: (e) => setOvGid(e.target.value),
                }, groups.map((g) => h('option', {
                  key: g.chatId, value: g.chatId,
                }, g.title || String(g.chatId).slice(0, 10))))
              : h('span', { className: 'roost-g-unit' }, '还没有群会话')),
          ...OV_FIELDS.map((f) => h(GRow, {
            key: f.key, label: f.label,
            hint: f.kind === 'select' ? '选「跟全局」= 不覆写这一项' : '留空 / 不改 = 跟全局',
          },
            f.kind === 'num'
              ? h(GOvNum, {
                  value: ov[f.key], min: f.min, max: f.max, unit: f.unit, disabled: busy,
                  onSave: (v) => setOv(f.key, v),
                })
              : f.kind === 'select'
                ? h('select', {
                    className: 'roost-g-sel', value: ov[f.key] || '', disabled: busy,
                    onChange: (e) => setOv(f.key, e.target.value || undefined),
                  }, [
                    h('option', { key: '', value: '' }, '跟全局'),
                    ...f.options.map(([v, t]) => h('option', { key: v, value: v }, t)),
                  ])
                : h(Switch, {
                    on: ov[f.key] === true, label: f.label, disabled: busy,
                    onToggle: (v) => setOv(f.key, v ? true : undefined),
                  }))),
          h('div', { className: 'roost-g-ov' },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy || !pickOv,
              onClick: () => saveOverride(ov),
            }, '保存这个群的例外'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy || !pickOv,
              onClick: () => saveOverride({}),
            }, '恢复成全局'),
            h('span', { className: 'roost-g-unit' },
              Object.keys(ov).length ? `这个群已覆写 ${Object.keys(ov).length} 项` : '这个群目前跟全局一致'),
          ),
          h('div', { className: 'roost-g-note' },
            Object.keys(overrides).length
              ? '已经设了例外的群：' + Object.keys(overrides)
                  .map((id) => `${chatName(id)}（${Object.keys(overrides[id] || {}).length} 项）`).join('、')
              : '目前没有群设了例外，所有群都用上面的全局设置。'),
        ),

        h(GCard, {
          n: '08', title: '刚才为什么回 / 不回',
          desc: '每条消息进来都会过一遍上面的规则，这里按时间列出最近 20 条的判定和原因。和排障页日志是同一份 reason，只是排好了队；只在内存里，不落盘。',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: loadDecisions }, '刷新'),
        },
          h('div', { className: 'roost-g-log' },
            !decisions
              ? h('div', { className: 'roost-empty' }, '读取中…')
              : !decisions.length
                ? h('div', { className: 'roost-empty' }, '还没有消息进来。让它在群里说一句话，这里就会出现判定。')
                : decisions.map((d, i) => h('div', {
                    key: String(d.at) + ':' + i, className: 'roost-g-log-row',
                  },
                    h('b', null, hhmmss(d.at)),
                    h('span', { className: 'roost-g-tag' }, d.kind === 'c2c' ? '私聊' : '群'),
                    h('span', { className: 'roost-g-tag' }, d.go ? '接' : '不接'),
                    h('span', null, d.reason || '（没写原因）'),
                    h('span', { style: { opacity: 0.72 } },
                      d.text ? '「' + d.text + '」' : chatName(d.chatId))))),
          h('div', { className: 'roost-g-note' },
            '看不到变化就点一下刷新；改了设置后，下一句消息才会按新规则判定。'),
        ),
      )
    }

    /**
     * 频道总览（4 张卡）。
     *
     * 按「开频道之前必须看清」的顺序排：能不能开 → 订阅对不对 → 额度够不够
     * → 现在有哪些频道会话。原来那张「会话归属」只有说明没有数据，2026-11-15
     * 换成了真的频道会话清单（数据来自会话映射，不额外打接口）。
     */
    function ChannelHomeTab({ config, saveCfg, toast, chats, setTab }) {
      const g = config?.guild || {}
      const [busy, setBusy] = useState(false)
      const [st, setSt] = useState(null)
      /**
       * 「我在频道里是谁」的候选。
       *
       * 频道用的人 id（`author.id`）和群/私聊的 openid 是两套标识，框架的主人名单
       * 只认一种 → 主人在频道里被算成普通成员。这里列出最近说过话的人，
       * 点「这是我」就把那个 id 记进 `ownerAliases`，之后一直按主人算。
       */
      const [me, setMe] = useState(null)
      const loadMe = useCallback(async () => {
        try { setMe(await get('/owner/aliases')) } catch { setMe(null) }
      }, [])
      useEffect(() => { loadMe() }, [loadMe])
      /**
       * 「把机器人加进频道」的链接。
       *
       * 二维码不在这里画（2026-11-17 主人决定）：这条链接在浏览器打开后，
       * 腾讯自己的页面就会显示二维码。少一层本地生成就少一种"码不对/画不出"的故障。
       */
      const [share, setShare] = useState(null)
      const [manualAppid, setManualAppid] = useState('')
      const loadShare = useCallback(async () => {
        try {
          const r = await get('/channel/share')
          setShare(r)
          if (r?.appid) setManualAppid((v) => v || r.appid)
        } catch { setShare(null) }
      }, [])
      useEffect(() => { loadShare() }, [loadShare])
      const doCopyShareUrl = async () => {
        const u = share?.url || ''
        if (!u) return
        try {
          await navigator.clipboard.writeText(u)
          toast('链接复制好了')
        } catch {
          window.prompt('手动复制这个链接：', u)
        }
      }
      const loadSt = useCallback(async () => {
        try { setSt(await get('/channel/status')) } catch { setSt(null) }
      }, [])
      useEffect(() => { loadSt() }, [loadSt])
      if (!config) return h('div', { className: 'roost-note' }, '读取配置…')

      const put = async (patch) => {
        if (!saveCfg || busy) return
        setBusy(true)
        try {
          const r = await saveCfg(patch)
          toast(r?.ok === false ? (r.message || '没存上') : '已保存，下一轮生效')
        } finally { setBusy(false) }
      }
      const on = g.enabled === true
      /**
       * 订阅掩码只有一个真来源：框架 `config.get().intents`（Identify 时提交的那份）。
       *
       * 这里以前读的是 `st.gatewayIntents` —— 后端**从来没有这个字段**，于是
       * 两个值永远是 0，整张订阅位表按 `0 & bit` 全判成「未订阅」。比留白更糟：
       * 用户会以为频道事件没订阅，跑去改 intents 重连。
       */
      const mask = Number(st?.intents)
      const hasMask = Number.isFinite(mask) && mask > 0
      /** 频道会话：一个频道一个 / 一个子频道一个都算，私信单独标出来 */
      const guildChats = (chats || []).filter((c) => c.kind === 'guild' || c.kind === 'dm')
      return h('div', null,
        /**
         * 06：把机器人加进频道。
         *
         * 频道加机器人只有「商店页添加」和「扫二维码」两条路，而**官方没有
         * 获取二维码的接口**——那张码只在开放平台「使用范围与人员」页面上。
         * 所以这里做的是"存一张"：存过一次，以后不用回去翻。
         */
        h(Sec, { n: '01', title: '把机器人加进频道', defaultOpen: true },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '加机器人都在 QQ 客户端里完成，三条路选一条：① 频道设置 → 机器人 → 商店页里添加；'
              + '② 手机打开下面这条链接，腾讯的页面会显示二维码，扫了就能加到频道；'
              + '③ 扫开放平台「使用范围与人员」页面上的那张码。'),
            share && share.url
              ? h('div', { style: { marginTop: 10 } },
                h('div', { className: 'roost-g-unit', style: { marginBottom: 4 } },
                  share.appid ? `机器人资料卡链接（appid ${share.appid}）` : '机器人资料卡链接'),
                h('code', {
                  style: {
                    display: 'block', padding: '6px 10px', borderRadius: 6, wordBreak: 'break-all',
                    fontSize: 12, background: 'var(--dsw-alias-fill-secondary, rgba(128,128,128,.12))',
                  },
                }, share.url),
                h('div', { className: 'roost-g-ov', style: { marginTop: 8 } },
                  h('button', { type: 'button', className: 'roost-btn', onClick: doCopyShareUrl }, '复制链接'),
                  h('a', {
                    href: share.url, target: '_blank', rel: 'noreferrer', className: 'roost-btn',
                  }, '在浏览器打开'),
                  h('a', {
                    href: 'https://q.qq.com/#/apps', target: '_blank', rel: 'noreferrer',
                    className: 'roost-g-unit',
                  }, '去开放平台 →')),
                h('p', { className: 'roost-note', style: { marginTop: 6 } },
                  '浏览器打开后腾讯会给你二维码，用手机 QQ 扫即可；链接本身也能直接发到手机上点开。'))
              : h('div', null,
                h('p', { className: 'roost-note' },
                  share && share.reason
                    ? `拿不到 appid：${share.reason}`
                    : '拿不到 appid（框架没连上？）。'),
                /** 读不到就让人手填：这条链接只为拼 URL，填一次就够 */
                h('div', { className: 'roost-g-ov', style: { marginTop: 6 } },
                  h('input', {
                    type: 'text', className: 'roost-g-num', placeholder: '填机器人 AppID，例如 102056878',
                    style: { width: 200 }, value: manualAppid, disabled: busy,
                    onChange: (e) => setManualAppid(e.target.value.replace(/\D/g, '').slice(0, 20)),
                  }),
                  h('button', {
                    type: 'button', className: 'roost-btn', disabled: busy || !manualAppid,
                    onClick: async () => {
                      /** 拼链接只做一次（后端）：前端不重复实现清洗和格式，避免两边漂移 */
                      const r = await get('/channel/share?appid=' + encodeURIComponent(manualAppid))
                      if (!r?.url) { toast('appid 要是一串数字'); return }
                      setShare(r)
                      if (saveCfg) await saveCfg({ shareAppid: manualAppid })
                      toast('链接拼好了')
                    },
                  }, '用这个 appid'),
                  h('a', {
                    href: 'https://q.qq.com/#/apps', target: '_blank', rel: 'noreferrer',
                    className: 'roost-g-unit',
                  }, '去开放平台查 →'))),
          )),

        h(Sec, {
          n: '02', title: '总开关与粒度',
          right: on ? '已开启' : '已关闭',
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '默认关。关着时只在 dsh-roost 入口丢弃频道事件，不改框架的 intents 订阅——'
              + '框架照常收、照常推给别的插件，这边只是不处理。'),
            h(GRow, { label: '启用频道', hint: '开启前请确认框架侧已订阅频道事件' },
              h(Switch, {
                on, label: '启用频道', disabled: busy,
                onToggle: (v) => put({ guild: { enabled: v } }),
              })),
            h(GRow, { label: '会话粒度', hint: 'guild = 一个频道一个会话；channel = 一个子频道一个' },
              h('select', {
                className: 'roost-g-num', value: g.sessionMode || 'guild', disabled: busy || !on,
                onChange: (e) => put({ guild: { sessionMode: e.target.value } }),
              },
                h('option', { value: 'guild' }, '一个频道一个'),
                h('option', { value: 'channel' }, '一个子频道一个'))),
            h('p', { className: 'roost-note', style: { marginTop: 10 } },
              '会话键：一个频道一个 = guild:<频道ID>；一个子频道一个 = guild:<频道ID>:ch:<子频道ID>；'
              + '频道私信固定 dm:<用户ID>（一人一个，不随私信会话 id 变）。'),
            h('p', { className: 'roost-note' },
              '切换粒度不会迁移已有会话：旧会话保留在 DSH 里，但不再接回。'),
            setTab
              ? h('button', {
                  type: 'button', className: 'roost-btn', style: { marginTop: 8 },
                  onClick: () => { setTab('ch-diag'); toast('已切到「频道排障」，失联会话在 03 卡') },
                }, '看有没有失联会话 ↗')
              : null,
          )),
        h(Sec, {
          n: '03', title: '接入体检',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: loadSt }, '刷新'),
        },
          h('div', { className: 'roost-g-card' },
            h(GRow, { label: '框架配置的 intents', hint: 'Identify 时提交的就是这个值' },
              h('code', null, hasMask ? String(mask) : '—')),
            h('p', { className: 'roost-note' },
              '改完 intents 要重建 Gateway 才生效：面板「上下线」点一次（下线 → 上线），或重启机器人。'),
            /**
             * 这两个开关被问过很多次，索性写在勾选的地方：
             * 订阅位管「网关推不推」，01 卡的启用频道管「dsh-roost 处不处理」。
             * 只开订阅位 → 事件进来了但这边直接丢；只开总开关 → 这边等不到事件。
             */
            h('p', { className: 'roost-note' },
              '⚠️ 这里的「已订阅」只表示**网关会把事件推过来**。dsh-roost 要不要处理，看上面 01 卡的'
              + '「启用频道」——**两个都开着**，频道消息才会真的进到她这里。'),
            !hasMask
              ? h('p', { className: 'roost-note' },
                  '读不到框架配置（config.get 没通），下面只列订阅位、不判断已订未订。')
              : null,
            st?.events?.meta
              ? h('div', { style: { marginTop: 10 } },
                  h('p', { className: 'roost-note' },
                    hasMask ? '订阅位（按上面这个 intents 算）：' : '订阅位（只有位定义，没有掩码）：'),
                  Object.entries(st.events.meta).map(([name, m]) => {
                    const has = hasMask ? (mask & (1 << Number(m.bit))) !== 0 : null
                    return h('div', {
                      key: name,
                      style: {
                        display: 'flex', gap: 8, fontSize: 12,
                        opacity: has === false ? 0.45 : 1, padding: '2px 0',
                      },
                    },
                      h('code', { style: { minWidth: 200 } }, `${name}  1<<${m.bit}`),
                      h('span', null, m.name || ''),
                      h('span', { style: { marginLeft: 'auto' } },
                        has === null ? '' : (has ? '已订阅' : '未订阅')))
                  }))
              : null)),
        h(Sec, {
          n: '04', title: '额度与投递',
          right: st?.quota?.day ? `统计日 ${st.quota.day}` : null,
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '频道主动消息：20 条/天·子频道、每频道每天最多 2 个子频道、每子频道 1 秒 ≤5 条；'
              + '私信 2 条/天·用户 + 200 条/天·机器人。'),
            st?.quota
              ? h('div', null,
                  (() => {
                    const rows = Object.entries(st.quota.items || {})
                      .filter(([k]) => k.startsWith('guild:') || k.startsWith('dm:'))
                    if (!rows.length) {
                      return h('p', { className: 'roost-note' }, '今天还没有频道/私信主动消息记录。')
                    }
                    return rows.slice(0, 12).map(([k, v]) => h(GRow, {
                      key: k,
                      label: k,
                      hint: k.startsWith('guild:')
                        ? `上限 ${st.quota.limits?.guild ?? 20} 条/天·子频道`
                        : `上限 ${st.quota.limits?.dm ?? 2} 条/天·用户`,
                    }, h('code', null, String(v))))
                  })())
              : h('p', { className: 'roost-note' }, '框架未提供 quota.get（需要带该方法的框架版本）'),
            h('p', { className: 'roost-note', style: { marginTop: 12 } },
              '投递：频道消息可能进审核（304023 / 304024 → 状态「审核中」，结果由 '
              + 'MESSAGE_AUDIT_PASS / REJECT 事件回来）。关掉总开关只影响事件是否进这边，'
              + '不影响群聊 / 单聊的投递终态。'),
            (() => {
              const items = Array.isArray(st?.delivery?.items) ? st.delivery.items : []
              const ch = items.filter((x) => String(x.target || x.chatId || '').includes(':')
                && /^(guild|dm):/.test(String(x.target || x.chatId || '')))
              if (!st?.delivery) return h('p', { className: 'roost-note' }, '框架未提供 delivery.recent')
              if (!ch.length) return h('p', { className: 'roost-note' }, '最近没有频道/私信的投递记录。')
              return ch.slice(0, 8).map((x) => h(GRow, {
                key: String(x.requestId || x.id || ''),
                label: String(x.target || x.chatId || ''),
                hint: String(x.state || ''),
              }, h('code', null, String(x.code || x.state || ''))))
            })())),
        h(Sec, {
          n: '05', title: '频道会话',
          right: chats === null ? '读取中…' : `${guildChats.length} 个`,
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '会话映射里属于频道的那些（一个频道 / 一个子频道 / 频道私信）。'
              + '这里只是看一眼；要按频道单独调策略，去「频道策略 → 按频道覆写」。'),
            chats === null
              ? h('p', { className: 'roost-note' }, '会话映射还没读完…')
              : guildChats.length
                ? guildChats.slice(0, 20).map((c) => h(GRow, {
                    key: c.chatId,
                    label: c.title || String(c.chatId).slice(0, 24),
                    hint: (c.kind === 'dm' ? '频道私信' : '频道')
                      + (String(c.chatId).includes(':ch:') ? ' · 子频道' : '')
                      + (c.at ? ' · ' + new Date(c.at).toLocaleString('zh-CN') : ''),
                  }, h('code', null, String(c.chatId).slice(-12))))
                : h('p', { className: 'roost-note' },
                    '还没有频道会话。先在 QQ 里给频道发一条消息，这里就会长出来。'),
          )),

        /**
         * 05：我在频道里是谁。
         *
         * 单独一张卡是因为它回答的是一个**只在频道里才会出现**的问题：
         * 同一个人换渠道就换 id，框架的主人名单认不出频道侧的你。
         */
        h(Sec, { n: '06', title: '我在频道里是谁', defaultOpen: false },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '频道用的人 id 和群/私聊的 openid 不是同一套，框架的「主人」名单只认一种——'
              + '所以你在频道里说话时，她可能把你当成普通成员。下面这些是最近说过话的人，'
              + '点「这是我」，这个 id 之后就一直按主人算（只影响 dsh-roost，不改框架配置）。'),
            !me
              ? h('p', { className: 'roost-note' }, '读取中…（读不到就说明这条接口没通）')
              : (me.recent || []).length
                ? me.recent.map((s) => h(GRow, {
                  key: s.id,
                  label: s.name || `（没有昵称）…${String(s.id).slice(-6)}`,
                  hint: `${{ group: '群', c2c: '私聊', guild: '频道', dm: '频道私信' }[s.kind] || s.kind}`
                    + ` · ${String(s.id).slice(0, 10)}…`,
                },
                  s.isOwnerAlias
                    ? h('span', { className: 'roost-g-unit' }, '已是主人')
                    : h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: async () => {
                        const r = await post('/owner/aliases', { add: s.id })
                        if (r?.ok) { toast('记下了，之后按主人算'); await loadMe() }
                        else toast(r?.message || '没记上')
                      },
                    }, '这是我')))
                : h('p', { className: 'roost-note' },
                  '还没有记录：先在频道里给机器人发一句话，再回来这一页看。'),
            (me?.aliases || []).length
              ? h('p', { className: 'roost-note', style: { marginTop: 8 } },
                '已登记的 id：' + me.aliases.join('、'))
              : null,
          )),

      )
    }

    /**
     * 频道策略（P1）。
     *
     * 频道的接话 / 连发 / 刹车和群聊**共用**全局 `roostHost.decide` / `merge`，
     * 这里只读展示并给跳转入口；真正能按频道单独调的是 `guild.overrides`。
     * 覆写表是整份保存（`saveAll`），局部合并删不掉键。
     */
    function ChannelPolicyTab({ config, saveCfg, saveAll, toast, setTab, chats }) {
      const g = config?.guild || {}
      const decide = config?.roostHost?.decide || {}
      const overrides = g.overrides || {}
      const list = (chats || []).filter((c) => c.kind === 'guild')
      const [busy, setBusy] = useState(false)
      const [pick, setPick] = useState('')
      const [draft, setDraft] = useState(null)
      /**
       * 机器人加入的频道：直接问 QQ 要（`getMyGuilds`）。
       *
       * 原来这里的下拉是从会话映射里推的——机器人刚进频道、没人说话时就空着，
       * 用户看到的是「还没有频道会话」，于是整张卡一个可改项都没有。
       */
      const [guilds, setGuilds] = useState(null)
      useEffect(() => {
        (async () => {
          try {
            const r = await post('/channel/guilds', {})
            setGuilds(Array.isArray(r?.guilds) ? r.guilds : [])
          } catch { setGuilds([]) }
        })()
      }, [])

      /** 换频道要丢掉上一个的草稿，别写到新频道头上 */
      useEffect(() => { setDraft(null) }, [pick])
      if (!config) return h('div', { className: 'roost-note' }, '读取配置…')

      const put = async (patch, full) => {
        if (busy) return
        setBusy(true)
        try {
          const r = full ? await saveAll(patch) : await saveCfg(patch)
          toast(r?.ok === false ? (r.message || '没存上') : '已保存，下一轮生效')
        } finally { setBusy(false) }
      }

      const key = pick || Object.keys(overrides)[0] || ''
      const ov = draft !== null ? draft : { ...(overrides[key] || {}) }
      const setOv = (k, v) => {
        const next = { ...ov }
        if (v === undefined) delete next[k]
        else next[k] = v
        setDraft(next)
      }
      const saveOv = async () => {
        const next = { ...overrides }
        if (Object.keys(ov).length) next[key] = ov
        else delete next[key]
        await put({ guild: { overrides: next } }, true)
        setDraft(null)
      }

      return h('div', null,
        h(Sec, { n: '01', title: '按频道覆写', right: draft !== null
          ? h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: saveOv }, '保存覆写')
          : null },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '只影响选中的那个频道；没填的项跟随全局「群聊策略」。键用 guild:<guildId>，'
              + '所以同一频道的所有子频道共用这份覆写。'),
            guilds === null
              ? h('p', { className: 'roost-note' }, '正在问 QQ 要频道列表…')
              : (guilds.length || Object.keys(overrides).length)
                ? h(GRow, { label: '频道', hint: '机器人加入的频道（直接问 QQ 要，不要求有人说过话）' },
                    h('select', {
                      className: 'roost-g-sel', value: key, disabled: busy,
                      onChange: (e) => setPick(e.target.value),
                    },
                      guilds.length ? null : h('option', { value: '' }, '选一个频道'),
                      guilds.map((g) => h('option', { key: g.id, value: `guild:${g.id}` },
                        g.name || `频道 …${String(g.id).slice(-6)}`)),
                      /** 已配过、但机器人已经不在里面的频道：也要能选中去删掉，不能凭空消失 */
                      Object.keys(overrides)
                        .filter((k) => !guilds.some((g) => `guild:${g.id}` === k))
                        .map((k) => h('option', { key: k, value: k }, `${k}（机器人不在这个频道了）`))))
                : h('p', { className: 'roost-note' },
                    '拉不到频道列表：先确认机器人已经被拉进频道（「频道总览 → 01」有加机器人的链接）。'),
            key
              ? OV_FIELDS.map((f) => h(GRow, { key: f.key, label: f.label, hint: '留空 = 跟随全局' },
                  f.kind === 'select'
                    ? h('select', {
                        className: 'roost-g-sel', value: ov[f.key] ?? '', disabled: busy,
                        onChange: (e) => setOv(f.key, e.target.value || undefined),
                      },
                        h('option', { value: '' }, '跟随全局'),
                        (f.options || []).map(([v, t]) => h('option', { key: v, value: v }, t)))
                    : h(GNum, {
                        value: ov[f.key] ?? 0, min: 0, max: 100, disabled: busy,
                        onSave: (v) => setOv(f.key, v),
                      })))
              : null)),

        h(Sec, { n: '02', title: '接话与节奏（全局）', right: h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { setTab('groupchat'); toast('已切到「群聊策略」，那边的 01–03 卡改的是同一份配置') },
        }, '去群聊策略改') },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '接话方式、连发合并、安全刹车与群聊**共用同一份全局配置**，这里只读展示，'
              + '避免两个页面各改一半打架。要单独调某个频道，用上面那张「按频道覆写」。'),
            h(GRow, { label: '接话方式', hint: 'roostHost.decide.mode' },
              h('code', null, String(decide.mode || 'ai'))),
            h(GRow, { label: '冷却 / 每分钟上限', hint: 'roostHost.decide' },
              h('code', null, `${decide.cooldownSec ?? 20}s / ${decide.maxRepliesPerMin ?? 3} 条`)))),

        h(Sec, { n: '03', title: '连发与分段' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '频道没有群聊「每秒 5 条」那条限制（那是文字子频道的发送侧限制，'
              + '框架出站调度器已经按 kind 处理）。`qq_send` 不设段数硬上限，'
              + '提示词只说明一次一段、按需多次；超过官方被动回话次数时由框架改发主动消息。'))),

        /**
         * 04：把「富媒体限制」和「事件订阅」并成一张参考卡。
         *
         * 两块原来各占一张卡、各只有一段说明，页面上一半的卡读完了什么都不能做。
         * 合并后默认收起：需要查语法的人展开，不需要的人不被挡路。
         */
        h(Sec, {
          n: '04', title: '频道的限制与订阅', defaultOpen: false,
          right: h('button', {
            type: 'button', className: 'roost-btn',
            onClick: () => { setTab('ch-home'); toast('已切到「频道总览」，订阅位清单在「接入体检」卡里') },
          }, '去总览看订阅位'),
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '频道**只支持图片**：`image` 传公网 URL（平台转存）、`file_image` 走 multipart 直传；'
              + '语音 / 视频 / 文件在频道没有对应发送字段，会被明确拒绝。'
              + '另有 `embed` / `ark` / `markdown` 三种结构化消息。'),
            h('p', { className: 'roost-note' },
              '内嵌格式用频道自己的语法：`<@用户id>` 提到人、`<#子频道id>` 提到子频道、'
              + '`<emoji:表情id>` 发表情——**不要套群聊的 `<qqbot-at-user>`**，频道不认。'),
            h('p', { className: 'roost-note', style: { marginTop: 10 } },
              '订阅只靠 intents 掩码，在 Identify 时一次性提交，**没有运行时动态增删**。'
              + '改完必须让框架重建 Gateway（面板「上下线」或重启 Roost）才生效；'
              + '关掉总开关不会退订——框架照常收、照常推给别的插件，这边只在入口丢弃频道事件。'))),


      )
    }

    /**
     * 频道接口台的四个段（2026-11-15）。
     *
     * 这四个段原来各是一个页签，但它们是**同一个组件、同一张卡**的四个过滤器——
     * 拆成四个一级可达的页签等于「导航层级比内容还重」，而且四页长得一模一样。
     * 现在收成一页，段内仍是「选接口 → 填参数 → 执行 → 看结果」。
     *
     * `groups` 与框架 `qq.methods[].group` 对齐（都以「频道」开头）。
     */
    const CH_SECTIONS = [
      {
        id: 'channels', label: '频道与子频道', groups: ['频道', '频道·子频道'],
        note: '频道与子频道的列表 / 详情、创建·改名·删除。删除子频道不可恢复。',
      },
      {
        id: 'messages', label: '消息与私信', groups: ['频道·消息', '频道·私信', '频道·表情'],
        note: '发频道消息 / 私信、撤回、创建私信会话。带 msg_id 或 event_id 才是被动回复（不占主动额度）。',
      },
      {
        id: 'content', label: '内容与互动',
        groups: ['频道·公告', '频道·论坛', '频道·精华', '频道·日程', '频道·音频'],
        note: '公告、论坛帖子、精华消息、日程、音频子频道。论坛仅私域；音频接口仅音频类机器人可用。',
      },
      {
        id: 'member', label: '成员与权限',
        groups: ['频道·成员', '频道·身份组', '频道·权限', '频道·API权限'],
        note: '成员列表 / 详情 / 在线人数、身份组增删改、成员角色增删、子频道权限、API 权限申请。',
      },
    ]

    /**
     * 频道接口操作台。
     *
     * 安全：非只读操作点「执行」先弹 confirm，确认后才带 `confirm: true`；
     * 后端还会再校验一次（只放行 group 以「频道」开头的方法）。
     *
     * `initialSection` 来自老深链（`?tab=ch-message` 之类），决定进来先落哪一段。
     */
    function ChannelApiTab({ toast, chats, initialSection = 'channels' }) {
      const [section, setSection] = useState(initialSection)
      const [idx, setIdx] = useState(null)
      const [fallback, setFallback] = useState(false)
      const [sel, setSel] = useState('')
      const [params, setParams] = useState('{}')
      const [out, setOut] = useState(null)
      const [busy, setBusy] = useState(false)
      const [readOnly, setReadOnly] = useState(false)
      /** 最近调用只在本页内存里，刷新即清——和 /asr/recent 同口径，不落盘、不进记忆 */
      const [recent, setRecent] = useState([])
      const load = useCallback(async () => {
        try {
          const r = await get('/channel/methods')
          setIdx(r?.methods && typeof r.methods === 'object' ? r.methods : {})
          setFallback(r?.fallback === true)
        } catch { setIdx({}) }
      }, [])
      useEffect(() => { load() }, [load])

      const curSec = CH_SECTIONS.find((s) => s.id === section) || CH_SECTIONS[0]
      /**
       * 方法属于哪一段：**最长前缀优先**。
       *
       * 不能只写 `startsWith('频道·')`——那样「频道」这一段会把「频道·消息」
       * 也一起吞进来。原来四个页签就靠这个判定，于是第一页列了全部方法、
       * 后面三页重复列了一遍，谁都没发现。最长前缀同时兜住框架将来加的
       * 更深分组（`频道·消息·xx` → 仍归到消息段）。
       */
      const sectionOf = (group) => {
        const s = String(group || '')
        let best = null
        for (const sec of CH_SECTIONS) {
          for (const p of sec.groups) {
            if (s === p || s.startsWith(`${p}·`)) {
              if (!best || p.length > best.len) best = { sec, len: p.length }
            }
          }
        }
        return best ? best.sec : null
      }
      const methodsOf = (sec) => Object.entries(idx || {})
        .filter(([, v]) => sectionOf(v?.group)?.id === sec.id)
      /** 每段有多少个方法：切段之前就知道值不值得点 */
      const countOf = (sec) => methodsOf(sec).length
      const list = methodsOf(curSec)
        .filter(([, v]) => !readOnly || String(v?.risk || '') === 'read')
        .sort((a, b) => String(a[1].group).localeCompare(String(b[1].group))
          || String(a[0]).localeCompare(String(b[0])))
      const cur = list.some(([k]) => k === sel) ? sel : (list[0] ? list[0][0] : '')
      const meta = cur ? idx?.[cur] : null

      /** 频道会话 → 参数骨架。手抄 guild_id / channel_id 是这一步最痛的地方 */
      const chList = (chats || []).filter((c) => c.kind === 'guild' || c.kind === 'dm')
      const fillFrom = (chatId) => {
        const s = String(chatId || '')
        if (s.startsWith('dm:')) {
          const m = s.match(/^dm:([^:]+)/)
          setParams(JSON.stringify({ guild_id: '', user_id: m ? m[1] : '' }, null, 2))
          return
        }
        const m = s.match(/^guild:([^:]+)(?::ch:(.+))?$/)
        if (!m) { toast('这个会话键不是频道格式'); return }
        setParams(JSON.stringify({ guild_id: m[1], channel_id: m[2] || '' }, null, 2))
      }

      const run = async (method = cur, raw = params) => {
        if (!method || busy) return
        let p = {}
        try { p = JSON.parse(raw || '{}') } catch { toast('参数不是合法 JSON'); return }
        const risk = String(idx?.[method]?.risk || 'write')
        const need = risk !== 'read'
        if (need && !window.confirm(`${method} 属 ${risk} 级操作，确定执行？`)) return
        setBusy(true)
        const startedAt = Date.now()
        const push = (ok, msg) => setRecent((rows) => [{
          at: Date.now(), method, ok, ms: Date.now() - startedAt, msg, params: raw,
        }].concat(rows).slice(0, 5))
        try {
          const r = await post('/channel/qq', { method, params: p, confirm: need })
          setOut(r)
          push(r?.ok !== false, r?.ok === false ? String(r.message || '失败') : '')
          toast(r?.ok === false ? (r.message || '调用失败') : '已执行')
        } catch (e) {
          push(false, String(e?.message || e))
          toast('调用失败：' + String(e?.message || e))
        } finally { setBusy(false) }
      }

      if (idx === null) return h('div', { className: 'roost-note' }, '读取频道方法表…')
      return h('div', null,
        h(Sec, {
          n: '01', title: '接口操作台',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: load }, '刷新方法表'),
        },
          h('div', { className: 'roost-g-card' },
            /* 段切换：这四段就是原来的四个页签，现在不再占导航 */
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
              CH_SECTIONS.map((s) => h('button', {
                key: s.id, type: 'button', className: 'roost-chip',
                'data-on': section === s.id ? '1' : '0',
                onClick: () => { setSection(s.id); setSel(''); setOut(null) },
              }, `${s.label} ${countOf(s)}`)),
              h('button', {
                type: 'button', className: 'roost-chip',
                'data-on': readOnly ? '1' : '0',
                title: '只列不会改数据的方法',
                onClick: () => { setReadOnly((v) => !v); setSel('') },
              }, '只看只读')),
            h('p', { className: 'roost-g-desc' }, curSec.note),
            fallback
              ? h('p', { className: 'roost-note' },
                  '框架的 qq.methods 没带 group（版本较旧，或运行副本没同步本轮改动），'
                  + '当前用本地兜底名单，分组按本地表推。同步并重启框架后自动切回框架的分组。')
              : null,
            list.length
              ? h(GRow, { label: '接口', hint: '只列本段的方法；非只读要二次确认' },
                  h('select', {
                    className: 'roost-g-sel', value: cur, disabled: busy,
                    onChange: (e) => { setSel(e.target.value); setOut(null) },
                  },
                    list.map(([k, v]) => h('option', { key: k, value: k },
                      `${k}（${v.group || '—'} / ${v.risk || '—'}）`))))
              : h('p', { className: 'roost-note' },
                  readOnly
                    ? '本段没有只读方法，取消「只看只读」再看看。'
                    : '本段没有方法。检查外接协议是否连上、框架版本是否带 qq.methods.group。'),
            cur
              ? h('div', null,
                  chList.length
                    ? h(GRow, {
                        label: '填入已知频道',
                        hint: '从会话映射里挑一个，自动填 guild_id / channel_id 骨架',
                      },
                        h('select', {
                          className: 'roost-g-sel', value: '', disabled: busy,
                          onChange: (e) => { if (e.target.value) fillFrom(e.target.value) },
                        },
                          h('option', { value: '' }, '选一个…'),
                          chList.slice(0, 20).map((c) => h('option', { key: c.chatId, value: c.chatId },
                            `${c.title || String(c.chatId).slice(0, 20)}${c.kind === 'dm' ? '（私信）' : ''}`))))
                    : null,
                  h('p', { className: 'roost-note', style: { marginTop: 8 } },
                    meta?.blocked
                      ? '这个方法被框架标为禁止外部调用。'
                      : `风险档：${meta?.risk || '—'}；scope：${meta?.scope || '—'}`),
                  h('textarea', {
                    className: 'roost-g-num',
                    style: { width: '100%', minHeight: 96, marginTop: 6, fontFamily: 'monospace' },
                    value: params, disabled: busy, spellCheck: false,
                    onChange: (e) => setParams(e.target.value),
                    placeholder: '{"guild_id":"..."}',
                  }),
                  h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      disabled: busy || meta?.blocked, onClick: () => run(),
                    }, busy ? '执行中…' : '执行')),
                  out
                    ? h('pre', {
                        className: 'roost-note',
                        style: {
                          marginTop: 10, whiteSpace: 'pre-wrap',
                          maxHeight: 320, overflow: 'auto',
                        },
                      }, JSON.stringify(out, null, 2))
                    : null)
              : null)),

        recent.length
          ? h(Sec, { n: '02', title: '最近调用', right: `${recent.length} 条 · 刷新即清` },
              h('div', { className: 'roost-g-card' },
                h('p', { className: 'roost-g-desc' },
                  '只在本页内存里，不落盘、不进记忆。点「重跑」把它填回上面，连调同一个接口时不用反复选。'),
                recent.map((r, i) => h(GRow, {
                  key: String(r.at) + ':' + i,
                  label: r.method,
                  hint: (r.ok ? '成功' : '失败') + ' · ' + r.ms + 'ms · '
                    + new Date(r.at).toLocaleTimeString('zh-CN')
                    + (r.msg ? ' · ' + r.msg : ''),
                }, h('button', {
                  type: 'button', className: 'roost-chip',
                  onClick: () => {
                    const hit = sectionOf(idx?.[r.method]?.group)
                    if (hit) setSection(hit.id)
                    setSel(r.method)
                    setParams(r.params || '{}')
                    setOut(null)
                  },
                }, '重跑')))))
          : null,
      )
    }

    /**
     * 机器人自身设置：只用机器人 token 就能改的那部分。
     *
     * 开发者后台里的资料 / 头像 / 回调 / 白名单 / AppSecret 属于**开发者身份**，
     * 要网页登录态，不在这条链上，这里也不给入口。
     *
     * 参数是 `args` 数组（位置参数），协议会展开成 `QQApi[name](...args)`；
     * 和 WebUI `/api/qq/call` 那套 `__target` / `__rest` 对象不是一回事。
     */
    /**
     * 「人设 → 资料」：她长什么样、叫什么，以及**她能不能自己改**。
     *
     * 为什么单开一页、不塞进「人格」：人格页管的是「她怎么说话」，这一页管的是
     * 「别人看到的她」。混在一起会让「改个名字」看起来像在改人设。
     *
     * 这一页**只放开关**，不在这儿直接改昵称——改资料要走开发者登录态、要留
     * before/after 快照，那是工具层（`qq_name` / `qq_sign` / `qq_avatar` / `qq_menu`）
     * 的活。面板的职责是定「什么时候允许她动」，不是替她动手。
     */
    const PROFILE_KINDS = [
      ['menu', '菜单文案', '私聊那排入口上的一行字，改错了随时能改回来'],
      ['sign', '简介', '别人点开你看到的那句话'],
      ['name', '昵称', '所有人看到的名字；改的时候会连人格自称一起改'],
      ['avatar', '头像', '要上传图片，平台会按内容规范过一遍'],
    ]

    /** 历史里的 before/after 可能是字符串、对象或 null，渲染成一行短摘要 */
    function briefValue(v) {
      if (v === null || v === undefined) return '（空）'
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      return s.length > 48 ? s.slice(0, 48) + '…' : s
    }

    function ProfileTab({ toast }) {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const r = await get('/self/profile')
          if (r?.ok === false) { setErr(String(r.message || '读不到')); setData(null); return }
          setErr('')
          setData(r)
        } catch (e) {
          setErr(String(e?.message || e))
          setData(null)
        }
      }, [])
      useEffect(() => { load() }, [load])

      /**
       * 保存一段。**不做乐观更新**：这是「关掉就不注册」的硬开关，
       * 界面上先亮起来、实际没存进去，比卡一下更糟。
       */
      const save = useCallback(async (patch) => {
        setBusy(true)
        try {
          const r = await post('/self/profile', { patch })
          if (r?.ok === false) { toast(String(r.message || '保存失败')); return }
          setData((d) => (d ? { ...d, cfg: r.cfg } : d))
        } catch (e) {
          toast('保存失败：' + String(e?.message || e))
        } finally { setBusy(false) }
      }, [toast])

      const clearHistory = useCallback(async () => {
        if (!window.confirm('清空变更记录？清掉之后就没法再退回上一版了（当前资料不受影响）。')) return
        setBusy(true)
        try {
          const r = await post('/self/profile/history/clear', { confirm: true })
          if (r?.ok === false) { toast(String(r.message || '清空失败')); return }
          toast('记录已清空')
          await load()
        } catch (e) {
          toast('清空失败：' + String(e?.message || e))
        } finally { setBusy(false) }
      }, [load, toast])

      /** 退回某一条历史之前的样子。与「清空记录」不同：这一步真的会改平台 */
      const restore = useCallback(async (row) => {
        const label = data?.labels?.[row.kind] || row.kind
        if (!window.confirm(`把「${label}」改回 ${new Date(row.at).toLocaleString()} 之前的样子？`)) return
        setBusy(true)
        try {
          const r = await post('/self/profile/restore', { kind: row.kind, at: row.at })
          if (r?.ok === false) { toast(String(r.message || '退回失败')); return }
          toast(String(r?.note || '已退回'))
          await load()
        } catch (e) {
          toast('退回失败：' + String(e?.message || e))
        } finally { setBusy(false) }
      }, [data, load, toast])

      /**
       * 面板上直接改（人按的，不走「主人确认」那道）。
       * 走同一套写入逻辑，所以历史里照样留痕、照样能退回。
       */
      const applyField = useCallback(async (kind, label, cur) => {
        const v = window.prompt(`新的${label}（留空取消）`, cur || '')
        if (v === null) return
        const val = String(v).trim()
        if (!val) return
        setBusy(true)
        try {
          const r = await post('/self/profile/apply', { kind, value: val })
          if (r?.ok === false) { toast(String(r.message || '没改成')); return }
          toast(`${label}改好了`)
          await load()
        } catch (e) {
          toast('没改成：' + String(e?.message || e))
        } finally { setBusy(false) }
      }, [load, toast])

      /**
       * 跳到 Roost **面板**的「开放平台」页（框架那台自己的网页面板，`#dev`）。
       *
       * 地址由后端给，前端不拼：面板端口（`webui.port`，被占会顺延）与外接协议
       * 端口（`roostHost.url` = `6800+sha1(botId)%100`）是两个数，前端手里没有前者。
       *
       * 为什么是「先 fetch 再 open」而不是直接 open 一条后端 302：
       * 面板 API 有请求栅栏（`fence.js`），浏览器顶层导航带不了自定义头，会 403。
       *
       * 不内嵌扫码：登录是**开发者身份**，票据在框架自己的会话里（`/api/dev/*`），
       * 这边只有机器人 token，拿不到也写不进去。能做的是把门打开，登录完回来点「刷新」。
       */
      const openPlatform = useCallback(async () => {
        setBusy(true)
        try {
          const r = await get('/self/panel')
          if (r?.ok === false || !r?.url) { toast(String(r?.message || '拿不到面板地址')); return }
          window.open(String(r.url), '_blank', 'noopener')
        } catch (e) {
          toast('打不开面板：' + String(e?.message || e))
        } finally { setBusy(false) }
      }, [toast])

      const cfg = data?.cfg || null
      const platform = data?.platform || null
      const bot = platform?.bot?.base || null
      const history = Array.isArray(data?.history) ? data.history : []

      /* ---------- 01 资料现状 ---------- */
      let nowBody
      if (err) {
        nowBody = h('p', { className: 'roost-note' }, err)
      } else if (!data) {
        nowBody = h('p', { className: 'roost-g-desc' }, '读配置中…')
      } else if (!platform?.ok) {
        nowBody = h('p', { className: 'roost-g-desc' }, '框架没连上，读不到平台上的资料。下面那些开关照样能改。')
      } else if (!platform.loggedIn) {
        nowBody = h('p', { className: 'roost-g-desc' },
          '开放平台没登录（改资料走的是开发者登录态，不是机器人 token）。'
          + '点上面「开放平台」打开 Roost 面板那一页扫码登录，回来再点「刷新」，'
          + '这里就会显示她现在的名字、简介和头像。')
      } else {
        const editBtn = (kind, label, cur) => h('button', {
          type: 'button', className: 'roost-btn', disabled: busy,
          onClick: () => applyField(kind, label, cur),
        }, '改')
        const rows = [
          h(GRow, { key: 'name', label: '昵称', hint: '所有人看到的名字' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '10px' } },
              h('b', null, bot?.name || '（空）'),
              editBtn('name', '昵称', bot?.name || ''))),
          h(GRow, { key: 'desc', label: '简介', hint: '资料卡上那句话' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '10px' } },
              h('span', null, bot?.desc || '（空）'),
              editBtn('sign', '简介', bot?.desc || ''))),
          h(GRow, { key: 'avatar', label: '头像', hint: '平台只回 URL，写回要 avatarId' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '10px' } },
              bot?.avatar
                ? h('img', {
                    src: bot.avatar, alt: '',
                    style: { width: '44px', height: '44px', borderRadius: '50%', objectFit: 'cover' },
                  })
                : h('span', null, '（无）'),
              editBtn('avatar', '头像地址', bot?.avatar || ''))),
        ]
        /**
         * 平台自己回的剩余次数。框架读了这个字段，但**没人验证过官方会不会
         * 真的返回**——所以只在它有值的时候显示，不写「还剩 N 次」，更不拿它当限额。
         */
        if (bot && bot.modifyRemain !== null && bot.modifyRemain !== undefined) {
          rows.push(h(GRow, { key: 'remain', label: '平台余量', hint: '框架读到的字段，含义未证实' },
            h('b', null, String(bot.modifyRemain))))
        }
        if (platform.botError) {
          rows.push(h('p', { key: 'boterr', className: 'roost-note' }, '读平台资料失败：' + platform.botError))
        }
        nowBody = h('div', null, rows)
      }

      /* ---------- 02 修改权限 ---------- */
      const switchRows = !cfg
        ? h('p', { className: 'roost-note' }, err || '读配置中…')
        : h('div', null, PROFILE_KINDS.map(([kind, label, hint]) =>
            h(GRow, { key: kind, label, hint: hint + '；间隔 0 = 不限' },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '12px' } },
                h(Switch, {
                  on: !!cfg[kind]?.enabled, disabled: busy, label: label + '开关',
                  onToggle: (v) => save({ [kind]: { enabled: v } }),
                }),
                h(GNum, {
                  value: cfg[kind]?.cooldownMin ?? 0, min: 0, max: 10080, step: 5,
                  unit: '分钟', disabled: busy,
                  onSave: (v) => save({ [kind]: { cooldownMin: v } }),
                }),
                /**
                 * 菜单没有这两项：它一秒能改回来，为它加确认 / 无人值守判断
                 * 只会让「换个说法」比说话还麻烦。
                 */
                kind === 'menu'
                  ? null
                  : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
                      h('span', { className: 'roost-g-unit' }, '需主人确认'),
                      h(Switch, {
                        on: !!cfg[kind]?.confirm, disabled: busy, label: label + '需要主人确认',
                        onToggle: (v) => save({ [kind]: { confirm: v } }),
                      }),
                      h('span', {
                        className: 'roost-g-unit',
                        title: '主动搭话 / 夜间巩固这类没有人在场的轮次',
                      }, '没人看着也允许改'),
                      h(Switch, {
                        on: !!cfg[kind]?.unattended, disabled: busy, label: label + '无人值守也允许改',
                        onToggle: (v) => save({ [kind]: { unattended: v } }),
                      })),
                /**
                 * 头像独有：本机图片路径能不能超出数据目录。
                 *
                 * 开着 = 桌面/相册里随便一张图都能当头像（老行为，默认）；
                 * 关掉 = 只认数据目录里的文件。这一项挡的不是主人手滑，是
                 * 「提示词注入成功一次就把本机任意图传成公开头像」。
                 */
                kind === 'avatar'
                  ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                      h('span', {
                        className: 'roost-g-unit',
                        title: '关掉之后只能用数据目录里的图当头像',
                      }, '允许任意路径'),
                      h(Switch, {
                        on: cfg.avatar?.anyPath !== false, disabled: busy, label: '头像允许读任意路径',
                        onToggle: (v) => save({ avatar: { anyPath: v } }),
                      }))
                  : null))))

      /* ---------- 03 状态感知 ---------- */
      const awareRows = !cfg
        ? h('p', { className: 'roost-note' }, '读配置中…')
        : h('div', null,
            h(GRow, { label: '情绪', hint: '沿用心情页那套，注入的是自然语言，不是数字' },
              h(Switch, {
                on: !!cfg.awareness?.mood, disabled: busy, label: '情绪感知',
                onToggle: (v) => save({ awareness: { mood: v } }),
              })),
            h(GRow, { label: '安静多久了', hint: '多久没人说话' },
              h(Switch, {
                on: !!cfg.awareness?.silence, disabled: busy, label: '静默感知',
                onToggle: (v) => save({ awareness: { silence: v } }),
              })))

      /* ---------- 04 主动轮次 ---------- */
      const fieldsOf = (cfg?.proactive?.fields || []).filter((x) => x !== 'name')
      const proactiveRows = !cfg
        ? h('p', { className: 'roost-note' }, '读配置中…')
        : h('div', null,
            h(GRow, { label: '允许她主动换', hint: '只在她主动搭话的那一轮' },
              h(Switch, {
                on: !!cfg.proactive?.enabled, disabled: busy, label: '主动改开关',
                onToggle: (v) => save({ proactive: { enabled: v } }),
              })),
            h(GRow, { label: '可以动哪些', hint: '昵称永远需要有人点头' },
              h('span', { style: { display: 'inline-flex', gap: '14px', flexWrap: 'wrap' } },
                PROFILE_KINDS.filter(([k]) => k !== 'name').map(([kind, label]) =>
                  h('label', { key: kind, style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
                    h('input', {
                      type: 'checkbox',
                      checked: fieldsOf.includes(kind),
                      disabled: busy || !cfg.proactive?.enabled,
                      onChange: (e) => {
                        const rest = fieldsOf.filter((x) => x !== kind)
                        save({ proactive: { fields: e.target.checked ? rest.concat(kind) : rest } })
                      },
                    }),
                    label)))))

      /* ---------- 05 变更记录 ---------- */
      const historyRows = history.length
        ? h('div', null, history.map((r, i) =>
            h('div', { key: i, className: 'roost-g-row' },
              h('div', { className: 'roost-g-label' },
                h('b', null, (data?.labels?.[r.kind] || r.kind) + (r.ok === false ? '（失败）' : '')),
                h('small', null,
                  new Date(r.at).toLocaleString()
                  + (r.via === 'proactive' ? ' · 她主动改的' : ' · 主人让改的'))),
              h('div', { className: 'roost-g-ctl' },
                h('small', null, briefValue(r.before) + ' → ' + briefValue(r.after)),
                r.ok !== false && r.before
                  ? h('button', {
                      type: 'button', className: 'roost-btn', disabled: busy,
                      title: '把这一项改回这次改动之前的样子',
                      onClick: () => restore(r),
                    }, '退回')
                  : null))))
        : h('p', { className: 'roost-note' }, '还没有记录。')

      return h('div', null,
        h(Sec, {
          n: '01', title: '资料现状',
          right: h('span', { style: { display: 'inline-flex', gap: '8px' } },
            h('button', {
              type: 'button', className: 'roost-btn', onClick: openPlatform, disabled: busy,
              title: '在浏览器里打开 Roost 面板的「开放平台」页（开发者后台，扫码登录）',
            }, '开放平台'),
            h('button', { type: 'button', className: 'roost-btn', onClick: load, disabled: busy }, '刷新')),
        },
          h('div', { className: 'roost-g-card' }, nowBody)),

        h(Sec, { n: '02', title: '修改权限' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '关掉某一项，对应的工具就**不注册**——她不是"被拒绝"，是根本看不到这个能力。'
              + '冷却填 0 表示完全不限制。打开「需主人确认」之后，改这一项会先私聊问你一句，'
              + '你回「确认 1234」才真的改，回「不用」就不改。'),
            switchRows)),

        h(Sec, { n: '03', title: '状态感知' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '这两项**只影响她会不会想改**，不触发任何动作。关掉之后她照样能改，只是不知道自己现在什么心情。'),
            awareRows)),

        h(Sec, { n: '04', title: '主动轮次' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '默认关。打开后，她主动找你的那一轮可以顺手换个说法——不额外多跑一次模型。'
              + '昵称不在这里管：改名字必须有人在场，主动轮次一律改不了。'),
            proactiveRows)),

        h(Sec, {
          n: '05', title: '变更记录',
          right: history.length
            ? h('button', { type: 'button', className: 'roost-btn', onClick: clearHistory, disabled: busy }, '清空记录')
            : null,
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '每次改资料前的旧值都存在本机（含正文，面板可清空）。点某一行的「退回」，'
              + '就是把这一项改回那次改动之前的样子；头一条没有旧值，退不了。'),
            historyRows)),
      )
    }

    function SelfConfigTab({ toast }) {
      const [idx, setIdx] = useState({})
      const [notice, setNotice] = useState('')
      const [sel, setSel] = useState('getMe')
      const [args, setArgs] = useState('[]')
      const [out, setOut] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        try {
          const r = await get('/self/methods')
          const m = r?.methods && typeof r.methods === 'object' ? r.methods : {}
          setIdx(m)
          setNotice(r?.ok === false ? String(r.message || '框架方法表没读到，下面按默认风险档显示') : '')
          setArgs(JSON.stringify(m?.getMe?.args ?? [], null, 2))
        } catch (e) {
          setIdx({})
          setNotice(String(e?.message || e))
        }
      }, [])
      useEffect(() => { load() }, [load])
      const names = Object.keys(idx)
      const cur = names.includes(sel) ? sel : (names[0] || '')
      const meta = cur ? idx[cur] : null
      const pick = (name) => {
        setSel(name)
        setArgs(JSON.stringify(idx[name]?.args ?? [], null, 2))
        setOut(null)
      }
      /** 发一次 qq.call。`confirm` 由调用方判好：常用三颗只放只读接口，恒 false */
      const call = async (name, a, needConfirm) => {
        setBusy(true)
        try {
          const r = await post('/self/qq', { method: name, args: a, confirm: needConfirm })
          setOut(r)
          toast(r?.ok === false ? (r.message || '调用失败') : '已执行')
        } catch (e) {
          toast('调用失败：' + String(e?.message || e))
        } finally { setBusy(false) }
      }
      const run = async () => {
        if (!cur || busy) return
        let a
        try { a = JSON.parse(args || '[]') } catch { toast('args 不是合法 JSON'); return }
        if (!Array.isArray(a)) { toast('args 要是数组（位置参数）'); return }
        const risk = String(meta?.risk || 'write')
        const need = risk !== 'read'
        if (need && !window.confirm(`${cur} 属 ${risk} 级操作，确定执行？`)) return
        await call(cur, a, need)
      }
      /**
       * 常用只读接口：主操作摆成按钮。
       *
       * 为什么加：这一页以前只有「选方法 + 手写 JSON 参数」一条路，想看一眼自己
       * 现在叫什么，得先知道 `getMe` 的 args 是一个空数组——普通人到这一步就走了。
       * **只放 `risk=read`**：改菜单、删面板这类写操作留在下面折叠的高级台里，
       * 那里有二次确认、也才有地方逐字核对参数。
       */
      const QUICK = [
        ['getMe', '查身份', '机器人自己的 openid / 昵称 / 头像地址'],
        ['getGlobalMenu', '看全局菜单', '当前私聊那排入口的文案与动作'],
        ['listPanels', '指令面板列表', '每个面板的 id、名称与元素个数'],
      ]
      const quick = (name) => {
        const m0 = idx[name]
        if (!m0) { toast('这个方法表里没有：' + name); return }
        if (String(m0.risk || 'read') !== 'read') { toast('非只读接口请在下面「高级」里手动执行'); return }
        return call(name, Array.isArray(m0.args) ? m0.args : [], false)
      }
      return h('div', null,
        h(Sec, {
          n: '01', title: '机器人自身设置',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: load }, '刷新方法表'),
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '这一页走机器人身份（AppID/Secret → access_token）：查身份、改全局菜单与指令面板。'
              + '参数要手写，是给开发者用的；只想改名字头像的话不用来这一页。'),
            h('p', { className: 'roost-note' },
              '昵称 / 头像 / 简介 / 菜单文案的现状、授权与逐条退回在「人设 → 资料」；'
              + '回调地址与 IP 白名单要去开发者后台；AppSecret 在「接入」页。'),
            notice ? h('p', { className: 'roost-note' }, notice) : null,
            names.length
              ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 2px' } },
                  QUICK.map(([name, label, hint]) => (idx[name]
                    ? h('button', {
                        key: name, type: 'button', className: 'roost-btn',
                        disabled: busy || Boolean(idx[name]?.blocked), title: hint,
                        onClick: () => quick(name),
                      }, label)
                    : null)))
              : h('p', { className: 'roost-note' }, '方法表没读到。检查外接协议是否连上、框架是否提供 qq.methods。'),
            /**
             * 高级台默认收起：能调任意方法，但参数是位置数组，只有开发者用得上。
             * 常驻渲染（`details` 只折叠不卸载），切来切去不会丢掉手写的参数。
             */
            names.length
              ? h('details', { style: { marginTop: 10 } },
                  h('summary', { style: { cursor: 'pointer', fontSize: 12 } },
                    '高级：直接调接口（给开发者）'),
                  h(GRow, { label: '接口', hint: '非只读要二次确认；带 <> 的参数是占位符' },
                    h('select', {
                      className: 'roost-g-sel', value: cur, disabled: busy,
                      onChange: (e) => pick(e.target.value),
                    },
                      names.map((k) => h('option', { key: k, value: k },
                        `${k}（${idx[k]?.group || '—'} / ${idx[k]?.risk || '—'}）`)))),
                  cur
                    ? h('div', null,
                        h('p', { className: 'roost-note', style: { marginTop: 8 } },
                          `${meta?.desc || ''} · 风险 ${meta?.risk || '—'} · scope ${meta?.scope || '—'}`
                          + (meta?.blocked ? ' · 框架标为禁止外部调用' : '')),
                        h('p', { className: 'roost-note' },
                          'args 是位置参数数组，会直接展开成 QQApi 的实参；不是 WebUI 那套 __target/__rest 对象。'),
                        h('textarea', {
                          className: 'roost-g-num',
                          style: { width: '100%', minHeight: 120, marginTop: 6, fontFamily: 'monospace' },
                          value: args, disabled: busy, spellCheck: false,
                          onChange: (e) => setArgs(e.target.value),
                          placeholder: '[]',
                        }),
                        h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
                          h('button', {
                            type: 'button', className: 'roost-btn',
                            disabled: busy || meta?.blocked, onClick: () => run(),
                          }, busy ? '执行中…' : '执行')))
                    : null)
              : null,
            out
              ? h('pre', {
                  className: 'roost-note',
                  style: { marginTop: 10, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' },
                }, JSON.stringify(out, null, 2))
              : null)),
        h(Sec, { n: '02', title: '权限与限制' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '只读接口（getMe / getGlobalMenu / listPanels / getPanel）只要 read scope；'
              + '写接口要 message scope；deletePanel 是 danger，还要 manage scope，框架拒绝时错误会原样显示。'),
            h('p', { className: 'roost-note' },
              '菜单写 5 QPM、面板写 10 QPM；菜单覆盖式 ≤10 项且仅 C2C，面板每机器人 ≤20 个、每个 ≤20 元素。'
              + 'updatePanelTarget 只对 target_type=specific 的面板有效。'),
            h('p', { className: 'roost-note' },
              'AI 工具仍不能调 qq.call：这里只给人从面板点，扩展能力白名单没放开。')))
      )
    }

    /**
     * 频道排障（P4）。四块只读：方法表 / 投递终态 / 失联会话 / 错误码速查。
     *
     * 「最近频道事件」放在这里而不是总览——`ledger.recent` 要按 chatId 查，
     * 总览页没有具体频道；这里至少能按失联清单里的会话反查。
     */
    function ChannelDiagTab() {
      const [st, setSt] = useState(null)
      const [methods, setMethods] = useState(null)
      const [orphans, setOrphans] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        setBusy(true)
        try {
          const [a, b, c] = await Promise.all([
            get('/channel/status').catch(() => null),
            get('/channel/methods').catch(() => null),
            get('/channel/orphans').catch(() => null),
          ])
          setSt(a); setMethods(b); setOrphans(c)
        } finally { setBusy(false) }
      }, [])
      useEffect(() => { load() }, [load])

      const byGroup = {}
      for (const [name, m] of Object.entries(methods?.methods || {})) {
        const g = String(m?.group || '其他')
        if (!byGroup[g]) byGroup[g] = []
        byGroup[g].push({ name, ...m })
      }
      const delivery = (st?.delivery?.items || [])
        .filter((x) => /^(guild|dm):/.test(String(x?.target || x?.chatId || '')))
      const orph = Array.isArray(orphans?.items) ? orphans.items : []

      return h('div', null,
        h(Sec, {
          n: '01', title: '频道方法表',
          right: h('button', {
            type: 'button', className: 'roost-btn', disabled: busy, onClick: load,
          }, '刷新'),
        },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '来自框架 qq.methods（group 以「频道」开头）。风险档决定操作台要不要二次确认。'),
            Object.keys(byGroup).sort().map((g) => h('div', { key: g, style: { marginTop: 10 } },
              h('p', { className: 'roost-note' }, `${g}（${byGroup[g].length}）`),
              byGroup[g].map((m) => h('div', {
                key: m.name,
                style: { display: 'flex', gap: 8, fontSize: 12, padding: '2px 0' },
              },
                h('code', { style: { minWidth: 220 } }, m.name),
                h('span', null, `${m.risk || '—'} · ${m.scope || '—'}`))))),
            methods ? null : h('p', { className: 'roost-note' }, '读取方法表…'))),

        h(Sec, { n: '02', title: '投递终态' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              '最近 10 条频道 / 私信的发送结果。304023 / 304024 会先显示为审核中，'
              + '结果由 MESSAGE_AUDIT_* 事件回来。'),
            delivery.length
              ? delivery.map((x) => h(GRow, {
                  key: String(x.requestId || x.id || ''),
                  label: String(x.target || x.chatId || ''),
                  hint: String(x.state || ''),
                }, h('code', null, String(x.code || x.state || ''))))
              : h('p', { className: 'roost-note' }, '没有频道 / 私信的投递记录。'))),

        h(Sec, { n: '03', title: '失联会话' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' },
              `当前粒度：${orphans?.mode === 'channel' ? '一个子频道一个' : '一个频道一个'}。`
              + '切换粒度后旧会话不会自动迁移，下面这些已经不再命中。'),
            orph.length
              ? orph.slice(0, 20).map((x) => h(GRow, {
                  key: x.key,
                  label: x.chatId,
                  hint: x.title || '（无标题）',
                }, h('code', null, String(x.sessionId || '').slice(-8) || '—')))
              : h('p', { className: 'roost-note' }, '没有失联会话。'),
            orph.length
              ? h('p', { className: 'roost-note' },
                  '接回办法：把「频道策略 → 会话粒度」切回原来的值，这些键就又能命中。')
              : null)),

        h(Sec, { n: '04', title: '错误码速查' },
          h('div', { className: 'roost-g-card' },
            h('p', { className: 'roost-g-desc' }, '频道相关常见码；完整清单见框架 docs/官方接口限制.md。'),
            [
              ['304023 / 304024', '消息进审核；结果由 MESSAGE_AUDIT_PASS / REJECT 事件回来'],
              ['40034128', '被动回复次数用完（群 5 / 单聊 4 次），框架会静默降级成主动消息'],
              ['40054xxx', '主动消息额度 / 权限类（私信 2 条/天·用户、200 条/天·机器人）'],
              ['4013 / 4014', 'intents 参数无效或无权限；4014 要去管理端申请频道能力'],
            ].map(([k, v]) => h(GRow, { key: k, label: k }, h('span', { className: 'roost-note' }, v))))),
      )
    }

    /**
     * 频道发帖：让她在频道的一个论坛版块里，每天写几篇留着的小记。
     *
     * 页面结构**照 aurabot 的空间日记页**排：开关 + 排期 + 字数 + 预览 + 历史。
     * 唯一多出来的是最上面那条「能不能发」的体检——空间那边第三方协议端登录了
     * 就能发，不需要；频道要先有论坛权限、要有论坛版块，这些不查清楚就是白配。
     *
     * 体检**不挡操作**：没通过也能配排期、能看草稿，只是真发时会告诉你还差哪一步。
     */
    /**
     * 从会话映射里抽「频道」候选：真正的 guild_id，且按频道去重。
     *
     * 两个坑：
     *   ① 会话可能按**子频道**粒度建，`chatId` 形如 `guild:<guildId>:ch:<channelId>`；
     *      把整串当 guildId 存进去，`normalizePostCfg` 的纯数字校验会把它清空——
     *      用户看到的现象是"选了频道，保存完又变回未选"。
     *   ② 同一频道下多个子频道会重复，下拉里必须合成一条。
     *
     * 导出给测试：这类"字符串切一半"的逻辑，光看代码看不出错。
     */
    function guildChoicesOf(chats) {
      const seen = new Map()
      for (const c of (chats || [])) {
        if (c.kind !== 'guild') continue
        const hit = String(c.chatId || '').match(/^guild:(\d{1,20})/)
        if (hit && !seen.has(hit[1])) seen.set(hit[1], c.title || '')
      }
      return [...seen.entries()].map(([id, title]) => ({ id, title }))
    }

    /** 子频道类型 → 人话。发帖只认 10007，其它要标出来为什么选不了 */
    const SUB_TYPE_NAME = { 0: '文字', 2: '语音', 4: '分组', 10005: '直播', 10006: '应用', 10007: '论坛' }

    function ChannelPostTab({ chats, toast, setTab, seed }) {
      /**
       * `seed` 只给渲染测试注入一份快照（`{ st, diag, guilds, subs }`）。
       *
       * 生产路径不传：数据由挂载时的 `load()` 拉。渲染测试里 `useEffect` 不跑，
       * 没有这个口子就断言不到「体检没过时界面上到底写了什么」——
       * 而那正是这个页面最该被测到的一段（用户就是照着那几句走的）。
       */
      const [st, setSt] = useState(seed?.st || null)
      const [diag, setDiag] = useState(seed?.diag || null)
      const [guilds, setGuilds] = useState(Array.isArray(seed?.guilds) ? seed.guilds : [])
      /** 读频道列表失败的原因：只说"拉不到"等于没说，用户没法判断该改哪儿 */
      const [guildsErr, setGuildsErr] = useState('')
      const [subs, setSubs] = useState(Array.isArray(seed?.subs) ? seed.subs : [])
      /** 「把机器人加进频道」的链接：这是发帖的前置条件，缺了它这页什么都做不了 */
      const [share, setShare] = useState(seed?.share || null)
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState(null)
      /** 生成失败时模型到底输出了什么：排障的唯一线索，界面上要能看到 */
      const [rawOut, setRawOut] = useState('')
      const [newName, setNewName] = useState('她的日记本')
      /** 建版块失败时的服务端原文：判断"参数哪不对"的唯一线索，别用弹窗盖住 */
      const [createErr, setCreateErr] = useState('')

      const cfg = st?.cfg || {}
      const steps = diag?.steps || []

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const a = await get('/channel/post')
          setSt(a)
          /**
           * 一次拉三样：体检、机器人加入的频道、当前频道的子频道。
           *
           * 「频道」必须来自 `getGuilds`（机器人所在频道），不能从会话映射反推——
           * 那要求先有人说过话，而选频道发生在说话之前，是死锁。
           */
          const [d, g, sh] = await Promise.all([
            post('/channel/post/diagnose', {}).catch(() => null),
            post('/channel/guilds', {}).catch(() => null),
            get('/channel/share').catch(() => null),
          ])
          setDiag(d)
          setGuilds(Array.isArray(g?.guilds) ? g.guilds : [])
          setGuildsErr(g && g.ok === false ? String(g.message || '读不到频道列表') : '')
          setShare(sh?.url ? sh : null)
          const gid = a?.cfg?.guildId || ''
          if (gid) {
            const s = await post('/channel/post/subs', { guildId: gid }).catch(() => null)
            setSubs(Array.isArray(s?.channels) ? s.channels : [])
          } else {
            setSubs([])
          }
        } catch (e) {
          toast('读发帖设置失败：' + String(e?.message || e))
        } finally {
          setBusy(false)
        }
      }, [toast])

      useEffect(() => { load() }, [load])

      /** 改一项配置：整份走 normalize，后端只回夹紧后的值 */
      const save = async (patch, okText = '已保存') => {
        setBusy(true)
        try {
          const r = await post('/channel/post/config', patch)
          if (r?.ok) {
            setSt((s) => ({ ...(s || {}), cfg: r.channelPost }))
            toast(okText)
          } else toast(r?.message || '保存失败')
          return r
        } catch (e) {
          toast('保存失败：' + String(e?.message || e))
          return null
        } finally { setBusy(false) }
      }

      const runDiag = async () => {
        setBusy(true)
        try {
          const d = await post('/channel/post/diagnose', {})
          setDiag(d)
          if (Array.isArray(d?.forumChannels)) setChans(d.forumChannels)
          toast(d?.ready ? '都齐了，她可以发了' : d?.blocked ? (d.steps.find((x) => x.state === 'fail')?.detail || '还差一步') : '还差几步')
        } catch (e) { toast('体检失败：' + String(e?.message || e)) } finally { setBusy(false) }
      }

      /**
       * 建一个论坛版块。
       *
       * 失败时**不弹窗**：弹窗盖住原文也没法复制，而这条错误的核心信息
       * 恰恰是服务端那串原话。改成页面内一行红字。
       */
      const doCreate = async () => {
        if (!/^\d{1,20}$/.test(String(cfg.guildId || ''))) { toast('先选一个频道'); return }
        setBusy(true)
        setCreateErr('')
        try {
          const r = await post('/channel/post/channel', { mode: 'create', name: newName })
          if (r?.ok) {
            toast(`建好了：${r.name || newName}`)
            await save({ channelId: r.id }, '已选为发帖版块')
            await load()
          } else {
            setCreateErr([r?.message || '没建成', r?.raw ? `　（服务端原文：${r.raw}）` : ''].join(''))
          }
        } finally {
          setBusy(false)
        }
      }

      /**
       * 体检项里的「就地操作」。
       *
       * 让用户不必滚到 03 卡去选：哪一项没过，就在那一行直接选。
       * 只做「有数据可选项」的两种（选频道 / 选版块），其余仍给文字说明——
       * 这一行不该长成第二个设置面板。
       */
      const inlineActionOf = (s) => {
        if (!s || s.id !== 'channel') return null
        if (!cfg.guildId) {
          if (!guildChoices.length) return null
          return h('select', {
            className: 'roost-g-sel', style: { maxWidth: 180, flex: '0 0 auto' }, value: '', disabled: busy,
            onChange: async (e) => {
              const v = e.target.value
              if (!v) return
              await save({ guildId: v, channelId: '' }, '频道选好了')
              await load()
            },
          },
            h('option', { value: '' }, '选频道…'),
            guildChoices.map((g) => h('option', { key: g.id, value: g.id },
              g.name || `…${String(g.id).slice(-6)}`)))
        }
        if (!cfg.channelId) {
          const list = (subs || []).filter((c) => c.isForum)
          if (!list.length) return null
          return h('select', {
            className: 'roost-g-sel', style: { maxWidth: 180, flex: '0 0 auto' }, value: '', disabled: busy,
            onChange: async (e) => {
              const v = e.target.value
              if (!v) return
              await post('/channel/post/channel', { mode: 'pick', channelId: v, guildId: cfg.guildId })
              toast('版块选好了')
              await load()
            },
          },
            h('option', { value: '' }, '选版块…'),
            list.map((c) => h('option', { key: c.id, value: c.id }, c.name || c.id)))
        }
        return null
      }

      const doPreview = async () => {
        setBusy(true)
        try {
          const r = await post('/channel/post/preview', {})
          if (r?.ok) { setDraft(r); setRawOut(''); toast('草稿生成好了') }
          else { setDraft(null); setRawOut(String(r?.raw || '')); toast(r?.message || '没写出来') }
        } catch (e) { toast('生成失败：' + String(e?.message || e)) } finally { setBusy(false) }
      }

      const doSend = async () => {
        const body = draft ? { title: draft.title, text: draft.text, confirm: true } : { confirm: true }
        if (!window.confirm('真的发到频道版块？发出去要等审核，撤不回来。')) return
        setBusy(true)
        try {
          const r = await post('/channel/post/send', body)
          if (r?.ok) {
            toast(r.dryRun ? '试运行：没真发（去关掉「试运行」再发）' : '已提交，等审核；过一会儿点「查上线」看看')
            setDraft(null)
            await load()
          } else {
            toast(r?.message || '发失败')
            if (Array.isArray(r?.todo) && r.todo.length) {
              window.alert([r.message, '', ...r.todo.map((x, i) => `${i + 1}. ${x}`)].join('\n'))
            }
          }
        } catch (e) { toast('发失败：' + String(e?.message || e)) } finally { setBusy(false) }
      }

      /**
       * 发一条**待发草稿**。
       *
       * 这是 `askFirst` 的落地：她在对话里写好一篇（`qq_post_thread` 拒发只记账），
       * 面板上出现「《标题》 发」，人点了才走真发。不做对话里多轮确认——
       * 那需要跨轮状态机，而"显式操作"本来就只有面板有。
       */
      const doSendDraft = async (row) => {
        if (!window.confirm(`发《${row.title || '这一篇'}》？发出去要等审核，撤不回来。`)) return
        setBusy(true)
        try {
          const r = await post('/channel/post/send', { title: row.title, text: row.text, confirm: true })
          toast(r?.ok ? (r.dryRun ? '试运行：没真发（去关掉「试运行」再发）' : '已提交，等审核') : (r?.message || '发失败'))
          await load()
        } catch (e) { toast('发失败：' + String(e?.message || e)) } finally { setBusy(false) }
      }

      const doSync = async () => {        setBusy(true)
        try {
          const r = await post('/channel/post/sync', {})
          if (r?.ok) { toast(r.changed ? `更新了 ${r.changed} 条` : '还没有新进展'); await load() }
          else toast(r?.warning || r?.message || '对账失败')
        } catch (e) { toast('对账失败：' + String(e?.message || e)) } finally { setBusy(false) }
      }

      const doTick = async () => {
        /**
         * 必须问一句：`tick` 不是"只读检查"，今天有错过的档位时它会**立刻真发一篇**。
         * 原本文案叫「现在检查一次」，用户点下去可能凭空多出一篇帖子。
         */
        if (!window.confirm('检查今天的排期。如果有错过的档位，会立刻发一篇（受「试运行」开关约束）。继续？')) return
        setBusy(true)
        try {
          const r = await post('/channel/post/tick', { confirm: true })
          toast(r?.ok ? (r.next ? `下次 ${r.next}` : '今天没有待发的了') : (r?.message || '检查失败'))
          await load()
        } catch (e) { toast('检查失败：' + String(e?.message || e)) } finally { setBusy(false) }
      }

      /**
       * 频道候选：优先 `getMyGuilds`（机器人所在频道），拉不到才回退会话映射。
       *
       * 再加一条兜底：**已经选过的频道必须始终在列表里**。私有机器人的
       * `/users/@me/guilds` 可能回空，但 `getGuildChannels` 明明能读到子频道——
       * 这时下拉不能把用户选过的东西弄丢，否则看着像"配置没了"。
       */
      const guildChoices = (() => {
        const base = guilds.length ? guilds : guildChoicesOf(chats)
        const cur = String(cfg.guildId || '')
        if (cur && !base.some((g) => String(g.id) === cur)) {
          return [...base, { id: cur, name: `当前频道 …${cur.slice(-6)}` }]
        }
        return base
      })()
      /** `info` 是"验证状态"（还没试发过），不是配置没配好，所以用中性点而不是空心圈 */
      const lamp = (s) => (s === 'ok' ? '●' : s === 'fail' ? '✕' : s === 'info' ? '·' : '○')
      const lampColor = (s) => (s === 'ok'
        ? 'var(--dsw-alias-state-success, #3c9)'
        : s === 'fail' ? 'var(--dsw-alias-state-danger, #e55)' : 'var(--dsw-alias-label-tertiary, #888)')
      const stateText = (s) => ({ pending: '已提交', live: '已上线', stale: '没看到', dry: '试运行', failed: '没发成', draft: '待发' }[s] || s || '—')
      const fmtAt = (t) => {
        const d = new Date(Number(t) || 0)
        return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }

      const ready = diag?.ready === true
      const todoCount = diag ? steps.filter((x) => x.state !== 'ok').length : null

      return h('div', null,
        h(Sec, { n: '01', title: '频道发帖', defaultOpen: true },
          h('div', { className: 'roost-note', style: { marginBottom: 10 } },
            '让她在频道里有一个自己的版块，想写什么就写一篇。你只要做三件事：开频道、给权限、选版块——剩下的她来写。'),

          /**
           * 一键打开「加机器人」链接，放在体检条之前。
           *
           * 频道没加，这一页什么都做不了；而这个链接在浏览器打开后腾讯会直接给二维码，
           * 比让人回去翻开放平台快得多。
           */
          share && share.url
            ? h('p', { className: 'roost-g-unit', style: { marginBottom: 8 } },
              '还没把机器人加进频道？',
              h('a', {
                href: share.url, target: '_blank', rel: 'noreferrer',
                style: { marginLeft: 6, fontWeight: 600 },
              }, '打开链接 →'),
              h('span', { style: { marginLeft: 6, opacity: 0.75 } }, '（腾讯会显示二维码，扫了就加进去）'))
            : null,

          /** ---------- 体检条 ---------- */
          h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              padding: '10px 12px', borderRadius: 8, marginBottom: 12,
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
            },
          },
            h('span', { style: { fontWeight: 600 } },
              diag == null ? '正在体检…' : ready ? '她可以在频道发帖了' : (diag.blocked ? '有一项卡住了' : `还差 ${todoCount} 项`)),
            steps.map((s) => h('span', {
              key: s.id, title: s.detail, style: { color: lampColor(s.state), fontSize: 13 },
            }, `${lamp(s.state)} ${({ guild: '频道已开', perm: '有论坛权限', channel: '选了版块', sent: '发过一篇' }[s.id] || s.id)}`)),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy, style: { marginLeft: 'auto' },
              onClick: runDiag,
            }, '重新体检'),
          ),
          /**
           * 「接下来做什么」——**把指引印在界面上，不藏在 title 提示里**。
           *
           * 上一版的问题：四盏灯只有名字，具体该点哪儿全在 `title` 属性里。
           * 桌面端要悬停才看得到，手机上根本点不出来——等于没有指引。
           * 现在只列没通过的项，每项一句"点哪里"，能跳到别的页的给按钮，
           * 有分步操作的直接列成编号清单（比如论坛权限那三步）。
           */
          /** 全绿的时候别让人愣着：告诉他现在能做什么 */
          diag && diag.ready
            ? h('div', { className: 'roost-g-card', style: { marginBottom: 12 } },
              h('div', { className: 'roost-g-desc' },
                diag.verified
                  ? '都齐了，也发过一篇了。想让她自己在聊天里发帖，就打开 06 卡那个开关。'
                  : '配置都齐了，可以发了。还没真发过——去 04 卡点「现在真发一篇」确认一次；成功之后她才能在对话里自己发。'))
            : null,
          diag && !diag.ready && steps.some((s) => s.state === 'todo' || s.state === 'fail')
            ? h('div', { className: 'roost-g-card', style: { marginBottom: 12 } },
              h('div', { className: 'roost-g-desc', style: { marginBottom: 2 } }, '接下来做什么'),
              h('div', { className: 'roost-g-unit', style: { marginBottom: 4 } },
                '从上往下做；每做完一步点右上角「重新体检」。论坛权限那几步要去 QQ 开放平台，改完记得回来重查。'),
              steps.filter((s) => s.state !== 'ok').map((s) => h('div', {
                key: 'todo-' + s.id,
                style: {
                  display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0',
                  borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.15))',
                },
              },
                h('span', { style: { color: lampColor(s.state), minWidth: 14, lineHeight: '22px' } }, lamp(s.state)),
                h('div', { style: { flex: 1, lineHeight: 1.65 } },
                  h('div', null, s.detail),
                  Array.isArray(s.todo) && s.todo.length
                    ? h('ol', { style: { margin: '4px 0 0 18px', padding: 0 } },
                      s.todo.map((t, i) => h('li', { key: i, style: { marginBottom: 2 } }, t)))
                    : null,
                  /** 必须去外部后台才能修的（目前只有论坛权限），给一个能点的入口 */
                  s.url
                    ? h('a', {
                      href: s.url, target: '_blank', rel: 'noreferrer',
                      style: { display: 'inline-block', marginTop: 4, fontSize: 12 },
                    }, '打开 QQ 开放平台 →')
                    : null),
                inlineActionOf(s) || (s.jump && setTab
                  ? h('button', {
                    type: 'button', className: 'roost-btn', style: { whiteSpace: 'nowrap' },
                    onClick: () => setTab(s.jump),
                  }, '去打开')
                  : null))))
            : null,
          /**
           * 快捷入口：体检区本身就是操作台。
           *
           * 这些按钮**不预先禁用**——点下去失败时返回的正是「还差哪一步」，
           * 比一上来就灰着更有信息量。
           */
          h('div', { className: 'roost-g-ov', style: { marginBottom: 12 } },
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doPreview }, '先看草稿'),
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doSend }, '现在发一篇'),
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: runDiag }, '重新体检'),
            share && share.url
              ? h('a', {
                href: share.url, target: '_blank', rel: 'noreferrer',
                className: 'roost-g-unit', style: { marginLeft: 'auto' },
              }, '把机器人加进频道 →')
              : null),
          diag && diag.permError
            ? h('div', { className: 'roost-note', style: { color: 'var(--dsw-alias-state-danger, #e55)' } },
              /**
               * 只显示**数字**业务码。`NETWORK` 这类内部标识对用户没有意义，
               * 拼在「连不上 roost」前面只会让人以为是另一个错误
               * （2026-11-19 截图：红字以 `NETWORK` 开头，读者会以为码本身有问题）。
               */
              `${/^\d+$/.test(String(diag.permError.code ?? '')) ? String(diag.permError.code) + ' ' : ''}${diag.permError.message || ''}`.trim())
            : null,
          /**
           * 最近一次失败。
           *
           * 定时发帖失败时没人在场、也没有会话能让模型说话——**面板是唯一出口**。
           * 所以这里必须明写"上次没发成 + 原因"，而不是只在历史列表里留一行红字。
           */
          st && st.lastError && st.lastError.message
            ? h('div', { className: 'roost-note', style: { color: 'var(--dsw-alias-state-danger, #e55)' } },
              `上次没发成（${fmtAt(st.lastError.at)}）：${st.lastError.message}`,
              st.lastError.code ? `　[${st.lastError.code}]` : '',
              '　——改好之后点「现在发一篇」再试一次，或等下一次排期自动重试')
            : null,
        ),

        /** ---------- 01 总开关与排期 ---------- */
        h(GCard, {
          n: '01', title: '总开关与排期',
          desc: '每天挑几个时间自己写一篇。时间在窗口里随机、两两隔开，不是固定整点——固定整点一眼就是机器人。',
        },
          h(GRow, { label: '允许发帖', hint: '关着的时候，排期和她自己都不会发；手动「现在发一篇」也拦' },
            h(Switch, {
              on: cfg.enabled === true, disabled: busy,
              onToggle: (v) => save({ enabled: v }, v ? '已打开' : '已关闭'),
            })),
          h(GRow, { label: '每天几篇', hint: '自动排期与她自己发共用这一个数；0 = 只手动' },
            h(GNum, {
              value: cfg.timesPerDay ?? 2, min: 0, max: 24, unit: '篇', disabled: busy,
              onSave: (v) => save({ timesPerDay: v }),
            })),
          h(GRow, { label: '时间窗', hint: '跨天也行（比如 22:00–02:00）；起止相同视为全天' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h('input', {
                type: 'time', className: 'roost-g-num', value: cfg.windowStart || '10:00', disabled: busy,
                onChange: (e) => save({ windowStart: e.target.value }),
              }),
              h('span', { className: 'roost-g-unit' }, '到'),
              h('input', {
                type: 'time', className: 'roost-g-num', value: cfg.windowEnd || '23:30', disabled: busy,
                onChange: (e) => save({ windowEnd: e.target.value }),
              }))),
          h(GRow, { label: '两篇至少隔', hint: '排不开时会自动放宽到能塞下为止' },
            h(GNum, {
              value: cfg.minGapMinutes ?? 180, min: 0, max: 1440, step: 30, unit: '分钟', disabled: busy,
              onSave: (v) => save({ minGapMinutes: v }),
            })),
          h('div', { className: 'roost-g-note' },
            st?.next ? `下一次：今天 ${st.next}` : '今天没有待发的了',
            st?.plan?.times?.length
              ? `　今天的排期：${st.plan.times.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join('、')}`
              : '',
            st?.today ? `　今天已发 ${st.today} 篇` : ''),
          h('div', { className: 'roost-g-ov' },
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doTick }, '补发错过的那一篇'),
            h('span', { className: 'roost-g-unit' }, '平时每分钟自动检查；这个按钮只在今天有错过档位时才会真发')),
        ),

        /** ---------- 02 写什么 ---------- */
        h(GCard, {
          n: '02', title: '写什么',
          desc: '字数只管正文，标题会截到 20 字（频道帖子必须有标题，这点和空间说说不同）。',
        },
          h(GRow, { label: '字数', hint: '太短会像没写完，太长没人看' },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
              h(GNum, { value: cfg.minChars ?? 80, min: 20, max: 1000, unit: '字起', disabled: busy, onSave: (v) => save({ minChars: v }) }),
              h(GNum, { value: cfg.maxChars ?? 600, min: 20, max: 2000, unit: '字止', disabled: busy, onSave: (v) => save({ maxChars: v }) }))),
          h(GRow, { label: '正文格式', hint: 'Markdown 能分段；纯文本最不容易出错' },
            h('select', {
              className: 'roost-g-sel', value: String(cfg.format || 3), disabled: busy,
              onChange: (e) => save({ format: Number(e.target.value) }),
            },
              h('option', { value: '3' }, 'Markdown'),
              h('option', { value: '1' }, '纯文本'))),
          h('div', { className: 'roost-g-note' },
            '素材来自这个频道里各文字子频道最近的聊天；没有素材时她会写心情，不会去读私聊凑内容。'),
        ),

        /** ---------- 03 发到哪 ---------- */
        h(GCard, {
          n: '03', title: '发到哪',
          desc: '先选频道、再选子频道。发帖只支持「论坛」类型的子频道，其它类型会列出来但选不了。',
        },
          h(GRow, { label: '频道', hint: '机器人加入的频道（直接问 QQ 要，不要求先在频道里说过话）' },
            guildChoices.length
              ? h('select', {
                  className: 'roost-g-sel', value: cfg.guildId || '', disabled: busy,
                  onChange: async (e) => {
                    await save({ guildId: e.target.value, channelId: '' }, '已切换频道')
                    await load()
                  },
                },
                  h('option', { key: '', value: '' }, '选一个频道'),
                  guildChoices.map((g) => h('option', { key: g.id, value: g.id },
                    g.name ? `${g.name}（…${g.id.slice(-6)}）` : `频道 …${g.id.slice(-6)}`)))
              : h('span', { className: 'roost-g-unit' },
                guildsErr
                  ? `拉不到频道列表：${guildsErr}`
                  : '拉不到频道列表：确认机器人已经被拉进频道，然后点右上角「重新体检」')),
          h(GRow, { label: '子频道', hint: '选了就能发到它里面；非论坛类型会标注原因' },
            subs.length
              ? h('select', {
                  className: 'roost-g-sel', value: cfg.channelId || '', disabled: busy,
                  onChange: async (e) => {
                    const id = e.target.value
                    if (!id) return
                    await post('/channel/post/channel', { mode: 'pick', channelId: id, guildId: cfg.guildId })
                    toast('已选发帖版块')
                    await load()
                  },
                },
                  h('option', { key: '', value: '' }, '选一个子频道'),
                  subs.map((c) => h('option', { key: c.id, value: c.id, disabled: !c.isForum },
                    `${c.name || c.id}　${c.isForum ? '（论坛，可以发）' : `（${SUB_TYPE_NAME[c.type] || 'type ' + c.type}，发不了）`}`)))
              : h('span', { className: 'roost-g-unit' },
                cfg.guildId
                  ? '这个频道里没有读到子频道：可能没权限，或这个频道只有一个默认板块'
                  : '先选上面的频道')),
          /**
           * 建论坛版块。
           *
           * 官方接口**支持**论坛类型（NodeSDK 文档里"不支持创建的"只有子频道分组），
           * 所以失败基本都是参数问题——把服务端原文摊在界面上，别用弹窗盖住。
           */
          h('div', { className: 'roost-g-ov', style: { marginTop: 6 } },
            h('input', {
              type: 'text', className: 'roost-g-num', value: newName, disabled: busy, maxLength: 20,
              style: { width: 160 }, onChange: (e) => setNewName(e.target.value),
            }),
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doCreate }, '建一个论坛版块'),
            h('span', { className: 'roost-g-unit' }, '手动建更稳：频道设置 → 新建子频道 → 类型选「论坛」（这个接口只对私域机器人开放）')),
          createErr
            ? h('p', { className: 'roost-note', style: { color: 'var(--dsw-alias-state-danger, #e55)', marginTop: 4 } }, createErr)
            : null,
          h(GRow, { label: '试运行', hint: '只影响定时和自动发帖；「现在真发一篇」按钮不受它限制' },
            h(Switch, {
              on: cfg.dryRun !== false, disabled: busy,
              onToggle: (v) => save({ dryRun: v }, v ? '已打开试运行（定时只记账）' : '已关掉试运行，定时会真发'),
            })),
        ),

        /** ---------- 04 现在发一篇 ---------- */
        h(GCard, {
          n: '04', title: '现在发一篇',
          desc: '先看草稿，满意再发。发出去要过审核，所以「已提交」不等于「已经能看见」。',
        },
          h('div', { className: 'roost-g-ov' },
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doPreview }, '先看草稿（不发）'),
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doSend }, '现在真发一篇'),
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: doSync }, '查上线'),
            h('span', { className: 'roost-g-unit' }, busy ? '忙…' : '')),
          draft
            ? h('div', {
                style: {
                  marginTop: 10, padding: 12, borderRadius: 8,
                  border: '1px dashed var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
                  whiteSpace: 'pre-wrap', lineHeight: 1.7,
                },
              },
                h('div', { style: { fontWeight: 600, marginBottom: 6 } }, draft.title),
                h('div', null, draft.text),
                h('div', { className: 'roost-g-unit', style: { marginTop: 8 } },
                  `素材 ${draft.excerptLines ?? 0} 行`))
            : h('div', { className: 'roost-g-note' }, '还没有草稿。点「先看草稿」生成一篇，它不会发布。'),
          rawOut
            ? h('div', { style: { marginTop: 10 } },
              h('div', { className: 'roost-g-unit', style: { marginBottom: 4 } },
                '模型这次的原始输出（复制给开发者看，能定位是没写正文还是被截断）：'),
              h('pre', {
                style: {
                  margin: 0, padding: 8, borderRadius: 6, fontSize: 12, lineHeight: 1.5,
                  whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto',
                  background: 'var(--dsw-alias-fill-secondary, rgba(128,128,128,.12))',
                },
              }, rawOut))
            : null,
        ),

        /** ---------- 05 历史 ---------- */
        h(GCard, {
          n: '05', title: '发过什么',
          desc: '「已上线」是列表里认领到了；「没看到」只代表这批里没找到，可能还在审核，不代表失败。她写好等你点头的那几条也在这里，标「待发」。',
        },
          (st?.history || []).length
            ? h('div', null, st.history.slice(0, 20).map((r) => h('div', {
                key: String(r.at) + String(r.title || ''),
                style: {
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '6px 0',
                  borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.18))',
                },
              },
                h('span', { className: 'roost-g-unit', style: { minWidth: 76 } }, fmtAt(r.at)),
                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  r.title || '（无标题）'),
                h('span', {
                  style: {
                    fontSize: 12,
                    color: r.state === 'live' ? 'var(--dsw-alias-state-success, #3c9)'
                      : r.state === 'failed' ? 'var(--dsw-alias-state-danger, #e55)'
                        : 'var(--dsw-alias-label-tertiary, #888)',
                  },
                }, stateText(r.state)),
                r.state === 'draft'
                  ? h('button', {
                      type: 'button', className: 'roost-btn', style: { marginLeft: 8 },
                      disabled: busy, onClick: () => doSendDraft(r),
                    }, '发')
                  : null)))
            : h('div', { className: 'roost-g-note' }, '还没发过。'),
        ),

        /** ---------- 06 交给她自己发 ---------- */
        h(GCard, {
          n: '06', title: '交给她自己发',
          desc: '打开之后，聊天里她说「我发个帖子」时就有这个工具了；发到哪个版块是这里定死的，她改不了。',
        },
          h(GRow, { label: '允许她在对话里发帖', hint: ready ? '体检已通过' : '体检还没全绿，建议先去 04 卡发一篇看看' },
            h(Switch, {
              on: cfg.allowTools === true, disabled: busy,
              onToggle: (v) => {
                if (v && !ready && !window.confirm('体检还没全绿，可能发不出去。仍然打开？')) return
                save({ allowTools: v }, v ? '已允许她自己发' : '已收回')
              },
            })),
          h(GRow, { label: '每次发之前问我', hint: '她写好会先在面板里放一条待发，你点「发」才算' },
            h(Switch, {
              on: cfg.askFirst !== false, disabled: busy,
              onToggle: (v) => save({ askFirst: v }),
            })),
          h('div', { className: 'roost-g-note' },
            '每天最多发几篇跟着 01 卡的「每天几篇」走，不另设计数器。'),
        ),
      )
    }

    function GroupAdminTab({ chats, toast }) {
      const groups = (chats || []).filter((c) => c.kind === 'group')
      const [gid, setGid] = useState('')
      const [info, setInfo] = useState(null)
      const [busy, setBusy] = useState(false)
      const [targets, setTargets] = useState('')
      const [seconds, setSeconds] = useState(600)
      const [black, setBlack] = useState(false)
      const [reqs, setReqs] = useState(null)
      const [note, setNote] = useState('')

      const pick = gid || groups[0]?.chatId || ''
      const who = targets.split(/[\s,，、;]+/).map((s) => s.trim()).filter(Boolean)

      const load = useCallback(async (id) => {
        if (!id) { setInfo(null); setReqs(null); return }
        setBusy(true)
        try {
          const r = await get('/group/info?groupId=' + encodeURIComponent(id))
          setInfo(r)
          if (r && r.ok && r.canManage) {
            const j = await post('/group/join', { groupId: id, action: 'list' })
            setReqs(j && j.ok ? (j.requests || []) : [])
          } else {
            setReqs(null)
          }
        } catch (e) {
          setNote('读不到群状态：' + (e.message || e))
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { load(pick) }, [pick, load])

      const act = async (path, body, okText) => {
        setBusy(true)
        setNote('')
        try {
          const r = await post(path, body)
          const msg = r && r.ok ? okText : (r?.message || '没成功')
          setNote(msg)
          toast?.(msg)
          await load(pick)
        } catch (e) {
          setNote('失败：' + (e.message || e))
        } finally {
          setBusy(false)
        }
      }

      if (!groups.length) {
        return h(Sec, { n: '01', title: '群' },
          h('div', { className: 'roost-empty' }, '还没有群会话。让它在群里说一句话，这里就会出现那个群。'),
          h('div', { className: 'roost-note' },
            '官方没有「群列表」接口，群只能从消息事件里发现 —— 所以这里列的是它待过、说过话的群。'),
        )
      }

      const roleText = { owner: '群主', admin: '管理员', member: '普通成员' }
      const picker = h('select', {
        value: pick,
        onChange: (e) => setGid(e.target.value),
        className: 'roost-btn',
        style: { minWidth: 200 },
      }, groups.map((g) => h('option', { key: g.chatId, value: g.chatId }, g.title || g.chatId.slice(0, 10))))

      return h('div', null,
        h(Sec, {
          n: '01', title: '这个群现在什么状态',
          right: h('button', { type: 'button', className: 'roost-btn', onClick: () => load(pick), disabled: busy }, '刷新'),
        },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
            picker,
            h('span', { className: 'd' }, busy ? '读着…' : ''),
          ),
          !info
            ? h('div', { className: 'roost-empty' }, busy ? '读着…' : '选一个群看看')
            : !info.ok
              ? h('div', { className: 'roost-empty' }, info.message || '读不到（外接协议没连上？）')
              : h('div', null,
                  h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
                    h('span', null, '群名 ', h('b', null, info.name || '（没读到）')),
                    h('span', null, '我的角色 ', h('b', null, roleText[info.role] || info.role || '未知')),
                    h('span', null, '能不能管 ', h('b', null, info.canManage ? '能' : '不能')),
                    h('span', null, '群管内邀 ', h('b', null, info.invited ? '已开' : '没开')),
                  ),
                  !info.canManage && info.manageReason
                    ? h('div', { className: 'roost-note' }, '管不了的原因：' + info.manageReason)
                    : null,
                  info.used
                    ? h('div', { className: 'roost-note' },
                        `今天已用：禁言 ${info.used.mute} 次、踢人 ${info.used.kick} 次、审批 ${info.used.join} 次`)
                    : null,
                ),
          note ? h('div', { className: 'roost-note' }, note) : null,
        ),

        h(Sec, { n: '02', title: '禁言 / 解禁' },
          h('div', { className: 'roost-note' },
            '目标填 openid，多个用逗号或换行分开（最多 20 人）。时长选 0 就是解禁。'),
          h('textarea', {
            value: targets,
            onChange: (e) => setTargets(e.target.value),
            rows: 2,
            placeholder: '成员的 openid，一行一个',
            className: 'roost-input',
            style: { width: '100%', marginTop: 6, marginBottom: 8 },
          }),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('select', {
              value: String(seconds),
              onChange: (e) => setSeconds(Number(e.target.value)),
              className: 'roost-btn',
            },
              [['600', '10 分钟'], ['3600', '1 小时'], ['86400', '1 天'], ['0', '解禁']]
                .map(([v, t]) => h('option', { key: v, value: v }, t))),
            h(ConfirmLink, {
              label: seconds ? '禁言' : '解禁',
              confirmLabel: '确认执行',
              onConfirm: () => act('/group/mute', { groupId: pick, targets: who, seconds, confirm: true }, seconds ? '已禁言' : '已解禁'),
            }),
            h('span', { className: 'd' }, who.length ? `已填 ${who.length} 人` : '还没填目标'),
          ),
        ),

        h(Sec, { n: '03', title: '踢人' },
          !info || !info.invited
            ? h('div', null,
                h('div', { className: 'roost-empty' }, '踢人需要「群管内邀」白名单，现在没开。'),
                h('div', { className: 'roost-note' },
                  '去 QQ 开放平台为这个机器人申请「群管内邀」权限，通过后回来点「刷新」。禁言不需要这个。'),
              )
            : h('div', null,
                h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
                  h('input', { type: 'checkbox', checked: black, onChange: (e) => setBlack(e.target.checked) }),
                  h('span', null, '踢出去的同时拉黑（以后不能再进）'),
                ),
                h(ConfirmLink, {
                  label: '踢出',
                  confirmLabel: '确认踢出',
                  onConfirm: () => act('/group/kick', { groupId: pick, targets: who, addToBlacklist: black, confirm: true }, '已踢出'),
                }),
                h('div', { className: 'roost-note' }, '目标沿用上面「禁言」那一栏填的 openid。'),
              ),
        ),

        h(Sec, { n: '04', title: '入群申请', right: h('button', { type: 'button', className: 'roost-btn', onClick: () => load(pick) }, '刷新') },
          reqs === null
            ? h('div', { className: 'roost-empty' }, info && info.canManage ? '读着…' : '机器人不是管理员时没有审批入口')
            : !reqs.length
              ? h('div', { className: 'roost-empty' }, '现在没有待处理的申请。')
              : h('div', { className: 'roost-list roost-scroll' },
                  reqs.map((r, i) => {
                    const who2 = r.member_openid || r.openid || ''
                    const rid = r.join_request_id || r.joinRequestId || ''
                    return h('div', { key: rid || who2 || i, className: 'roost-item' },
                      h('span', { className: 't' }, r.nick || r.nickname || who2.slice(0, 12) || '（没拿到昵称）',
                        h('span', { className: 'd' }, r.apply_at || r.at ? ' · ' + ago(r.apply_at || r.at) : '')),
                      h('span', { className: 'd' }, r.apply_text || r.applyText || ''),
                      h('span', { style: { display: 'flex', gap: 6 } },
                        h(ConfirmLink, {
                          label: '通过', confirmLabel: '确认通过',
                          onConfirm: () => act('/group/join', { groupId: pick, action: 'approve', memberOpenid: who2, joinRequestId: rid, confirm: true }, '已通过'),
                        }),
                        h(ConfirmLink, {
                          label: '拒绝', confirmLabel: '确认拒绝',
                          onConfirm: () => act('/group/join', { groupId: pick, action: 'decline', memberOpenid: who2, joinRequestId: rid, confirm: true }, '已拒绝'),
                        }),
                      ),
                    )
                  }),
                ),
        ),
      )
    }

    function ChatsTab({ chats, reload, toast }) {
      return h('div', null,
        h(Sec, { n: '01', title: 'QQ 会话 → DSH 会话', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          (chats || []).length
            ? h('div', { className: 'roost-list roost-scroll' },
                chats.map((c) =>
                  h('div', { key: c.chatId, className: 'roost-item' },
                    h('span', { className: 't' },
                      c.title || c.chatId.slice(0, 10),
                      h('span', { className: 'd' }, ' · ' + (c.preset || '—') + ' · ' + ago(c.at)),
                    ),
                    h('span', { className: 'd' }, String(c.sessionId || '').slice(-8) || '未绑定'),
                    h(ConfirmLink, {
                      label: '清上下文', confirmLabel: '确认解绑',
                      onConfirm: async () => {
                        const r = await post('/chats/clear', { chatId: c.chatId })
                        toast(r.message || '解绑了')
                        reload()
                      },
                    }),
                  ),
                ),
              )
            : h('div', { className: 'roost-empty' }, '还没有会话。QQ 上跟它说一句话就会有一条。'),
          h('div', { className: 'roost-note' },
            '解绑只是断开映射，下一条消息会开新会话；旧会话在 DSH 里还留着，能回去翻。'),
        ),
        /** A4：这一页原来只有一张卡，补一张只读说明，别让「清上下文」孤零零的 */
        h(Sec, { n: '02', title: '清上下文会怎样' },
          h('div', { className: 'roost-note' },
            '只断这一条 QQ 会话 ↔ DSH 会话的映射：下条消息重新开会话，旧会话在 DSH 里仍可回翻；'
            + '记忆、日记、人格、配置都不动。想连记忆一起清，去「记忆 → 清空」；想换机器人，去「账号迁移」。'),
        ),
      )
    }

    /* ---------------- 账号迁移 ---------------- */

    /**
     * 把「记忆里躺着的旧 openid」对上号码。
     *
     * 和 Roost 自己面板的「身份」页**不重复**，分工要说清楚：
     *   · 那边看**最近发过言**的人（统计库 + 最近发言人）
     *   · 这边看**库里有记忆**的键（换机器人后早就不说话的那批）
     * 两边的交集是空的，缺一边就漏。
     *
     * 三条规矩，都写进了 `src/account.js`，这里只是把它们摆到界面上：
     *   1. 扫描只读，不碰记忆一个字节
     *   2. 类型**不猜**——没有会话记录时让用户选
     *   3. 追加不替换——给号码补 openid 绝不删旧的
     */
    function AccountTab({ toast }) {
      const [scan, setScan] = useState(null)
      const [bound, setBound] = useState(null)
      const [bots, setBots] = useState([])
      /** `/account/bots` 的完整回包：`ok` 是「roost 到底通不通」的信号 */
      const [botsResult, setBotsResult] = useState(null)
      /** key → 用户填的号码（还没提交） */
      const [uinDraft, setUinDraft] = useState({})
      /** key → 'group' | 'c2c'。只有 sessions.json 里没类型时才需要用户选 */
      const [kindDraft, setKindDraft] = useState({})
      /** key → 冲突时服务端说的「已经属于谁」 */
      const [conflict, setConflict] = useState({})
      /** `${kind}:${uin}` → 追加时选中的 openid */
      const [appendDraft, setAppendDraft] = useState({})
      const [botPick, setBotPick] = useState('')
      /** roost 当前在跑的那只鸟，用来给「记到哪个机器人」选默认值 */
      const [botCur, setBotCur] = useState('')
      const [busy, setBusy] = useState('')
      const [loading, setLoading] = useState(true)

      const load = useCallback(async () => {
        setLoading(true)
        const [s, b, bt] = await Promise.all([get('/account/scan'), get('/account/bound'), get('/account/bots')])
        setScan(s)
        setBound(b)
        setBots(bt?.bots || [])
        setBotsResult(bt || null)
        setBotCur(bt?.current || '')
        setLoading(false)
      }, [])

      useEffect(() => { load() }, [load])
      // 默认绑到当前在跑的那只鸟；列表回来之后再设，避免空值提交
      useEffect(() => {
        if (botPick || !bots.length) return
        setBotPick((bots.find((x) => x.id === botCur) || bots[0]).id)
      }, [bots, botCur, botPick])

      const items = scan?.items || []
      const todo = items.filter((x) => !x.bound)
      /**
       * roost 可用吗 → 绑定按钮能不能点。
       *
       * 两个信号都要看，缺一不可：
       *   · `scan.roost.ok` —— 反查那一批成功了
       *   · `botsOk`        —— `/account/bots` 通了
       *
       * 只看第一个会误判：**待迁移列表是空的时候根本不发反查请求**，
       * 于是 `roost.ok` 是 true，界面把按钮点亮，用户一按就报「连不上」。
       * 空库恰恰是新装用户的常态。
       */
      const botsOk = Boolean(botsResult?.ok)
      const roostOk = Boolean(scan && scan.roost && scan.roost.ok) && botsOk
      const roostWhy = scan?.roost?.error || botsResult?.error || ''

      const kindOf = (item) => kindDraft[item.key] || item.kind || ''

      const bindOne = async (item, force = false) => {
        const u = String(uinDraft[item.key] ?? '').trim()
        if (!u) return toast('先填号码')
        const k = kindOf(item)
        if (k !== 'group' && k !== 'c2c') return toast('先选类型（群 / 私聊）')
        setBusy(item.key)
        const r = await post('/account/bind', {
          kind: k === 'group' ? 'group' : 'user',
          uin: u,
          openid: item.key,
          botId: botPick,
          force,
        })
        setBusy('')
        if (r.ok) {
          toast(`绑好了：${u}`)
          /**
           * 成功之后把这一行的冲突标记清掉。
           *
           * 不清的话：409 之后冲突方被别人解绑了，用户再点「全部绑定」成功，
           * 这一行仍然显示「改绑」按钮和「已在 X」的占位符——看起来像没绑上。
           */
          setConflict((c) => { const n = { ...c }; delete n[item.key]; return n })
          await load()
          return
        }
        if (r.code === 'CONFLICT') {
          /**
           * 冲突**不自动改绑**。同一个 openid 从 A 挪到 B，A 的记忆立刻读不到，
           * 得让人看见「从谁挪到谁」再决定。所以这里只记下 owner，界面上
           * 把「绑定」换成「改绑」让人二次确认。
           */
          setConflict((c) => ({ ...c, [item.key]: r.owner || '别的号码' }))
          toast(r.error || '这个 openid 已经绑给别的号码了')
          return
        }
        toast(r.message || r.error || '绑定失败')
      }

      /** 把填了号码的行一次提交。逐条走，失败的单独报，不影响成功的 */
      const bindAll = async () => {
        const ready = todo.filter((x) => String(uinDraft[x.key] ?? '').trim() && (kindOf(x) === 'group' || kindOf(x) === 'c2c'))
        if (!ready.length) return toast('没有填好号码的行')
        setBusy('all')
        const failed = []
        const done = []
        for (const item of ready) {
          const r = await post('/account/bind', {
            kind: kindOf(item) === 'group' ? 'group' : 'user',
            uin: String(uinDraft[item.key]).trim(),
            openid: item.key,
            botId: botPick,
          })
          if (r.ok) done.push(item.key)
          else failed.push(`${String(uinDraft[item.key]).trim()}：${r.error || '失败'}`)
        }
        setBusy('')
        /**
         * 成功的行要把冲突标记清掉。
         *
         * 不清的话：409 之后冲突方被别人解绑了，用户再点「全部绑定」成功，
         * 这一行仍然显示「改绑」按钮和「已在 X」的占位符——看起来像没绑上。
         */
        if (done.length) {
          setConflict((c) => {
            const n = { ...c }
            for (const k of done) delete n[k]
            return n
          })
        }
        await load()
        toast(failed.length ? `${done.length} 条成功，${failed.length} 条失败（${failed[0]}）` : `${done.length} 条都绑好了`)
      }

      /** 给已有号码追加一个 openid（加一条 claim，**不删旧的**） */
      const append = async (rec) => {
        const id = `${rec.kind}:${rec.uin}`
        const openid = appendDraft[id] || ''
        if (!openid) return toast('先选一个要追加的 openid')
        setBusy(id)
        const r = await post('/account/attach', {
          kind: rec.kind === 'group' ? 'group' : 'user',
          uin: rec.uin,
          openid,
          botId: botPick,
        })
        setBusy('')
        if (!r.ok) return toast(r.error || '追加失败')
        toast(`已追加到 ${rec.uin}（旧的 openid 都留着）`)
        setAppendDraft((d) => ({ ...d, [id]: '' }))
        await load()
      }

      if (loading && !scan) return h('div', { className: 'roost-empty' }, '扫描本机数据…')

      const boundRecs = [...(bound?.users || []), ...(bound?.groups || [])]

      return h('div', null,
        roostOk
          ? null
          : h('div', { className: 'acc-warn' },
              '连不上 Roost（' + (roostWhy || '未知原因') + '）。上半区照样能看——扫描只读本地数据，',
              '但绑定要先让 Roost 跑起来。'),

        h(Sec, {
          n: '01',
          title: `未对上（${todo.length}）`,
          right: h('button', { type: 'button', className: 'roost-btn', onClick: load, disabled: loading }, '重新扫描'),
        },
          h('div', { className: 'roost-note' },
            '这些键在记忆里有东西，但认不出是哪个号码。填上号码、选好类型，点绑定。',
            '只写 Roost 的身份表，**不碰记忆一个字节**。'),
          /**
           * 剔掉的键要报出来，各说各的原因。
           *
           * · **频道会话**（`guild:…` / `dm:…`）是「不可能绑」：频道没有号码，
           *   身份表里也没这种记录，绑了读记忆时也取不到（详见 `isChannelKey()`）。
           * · **手写假键**（`g1`、`GROUP_OPENID_XYZ_9999`、20 位假数字）是模拟测试
           *   留下的残留，绑上去一辈子也接不上真会话（详见 `isJunkKey()`）。
           *
           * 假键把原样键名带出来：只报个数的话，用户没法判断是不是把真键扔了。
           */
          scan?.skipped?.channel
            ? h('div', { className: 'roost-note' },
                `另有 ${scan.skipped.channel} 个频道会话键（guild:… / dm:…）没列出来——`,
                '频道没有 QQ号 / 群号可绑，绑了也读不到记忆，所以整类跳过。')
            : null,
          scan?.skipped?.junk
            ? h('div', { className: 'roost-note' },
                `另有 ${scan.skipped.junk} 个手写假键（模拟测试残留）没列出来：`,
                (scan.skipped.junkKeys || []).join('、') + (scan.skipped.junk > (scan.skipped.junkKeys || []).length ? ' 等' : ''),
                '。它们既不是 openid 也不是号码，绑上去接不上任何真实会话。')
            : null,
          todo.length
            ? h('div', null,
                h('div', { className: 'acc-head' },
                  h('span', null, '会话键'), h('span', null, '记忆'), h('span', null, '日记'),
                  h('span', null, '关系'), h('span', null, '类型'), h('span', null, '号码'), h('span', null, ''),
                ),
                todo.map((item) => {
                  const k = kindOf(item)
                  const lockKind = Boolean(item.kind)
                  const bad = conflict[item.key]
                  return h('div', { className: 'acc-row', key: item.key },
                    h('div', { className: 'acc-key' },
                      h('div', { className: 'acc-name', title: item.key },
                        item.title || (item.isOpenid ? '（无会话记录）' : '（不像 openid）')),
                      h('div', { className: 'roost-mono' }, item.short + '…'),
                    ),
                    h('div', { className: 'acc-num' }, String(item.facts ?? 0)),
                    h('div', { className: 'acc-num' }, item.journal == null ? '—' : String(item.journal)),
                    h('div', { className: 'acc-num' }, item.edges == null ? '—' : String(item.edges)),
                    h('select', {
                      className: 'roost-input acc-uin',
                      value: k,
                      // 会话记录里已有类型就锁住：那是**事实**，不是可选项
                      disabled: lockKind || !roostOk,
                      onChange: (e) => setKindDraft((d) => ({ ...d, [item.key]: e.target.value })),
                    },
                      h('option', { value: '' }, '选…'),
                      h('option', { value: 'group' }, '群'),
                      h('option', { value: 'c2c' }, '私聊'),
                    ),
                    h('input', {
                      className: 'roost-input acc-uin',
                      placeholder: bad ? `已在 ${bad}` : '号码',
                      value: uinDraft[item.key] || '',
                      disabled: !roostOk,
                      onChange: (e) => setUinDraft((d) => ({ ...d, [item.key]: e.target.value })),
                      onKeyDown: (e) => { if (e.key === 'Enter') bindOne(item) },
                    }),
                    bad
                      ? h(ConfirmLink, {
                          label: '改绑', confirmLabel: '确认改绑',
                          onConfirm: () => bindOne(item, true),
                        })
                      : h('button', {
                          type: 'button', className: 'roost-btn',
                          disabled: !roostOk || busy === item.key,
                          onClick: () => bindOne(item),
                        }, busy === item.key ? '…' : '绑定'),
                  )
                }),
                h('div', { className: 'acc-tools' },
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: !roostOk || busy === 'all',
                    onClick: bindAll,
                  }, busy === 'all' ? '提交中…' : '全部绑定'),
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '只提交填了号码的行'),
                  bots.length
                    ? h('span', { style: { marginLeft: 'auto' } },
                        h('span', { className: 'roost-note', style: { margin: 0 } }, '记到 '),
                        h('select', {
                          className: 'roost-input', style: { width: 'auto', padding: '3px 8px', fontSize: '11.5px' },
                          value: botPick,
                          onChange: (e) => setBotPick(e.target.value),
                        }, bots.map((b) => h('option', { key: b.id, value: b.id }, b.name || b.id))),
                      )
                    : null,
                ),
              )
            : h('div', { className: 'roost-empty' }, '没有待迁移的键。要么都绑好了，要么记忆本来就认得出号码。'),
        ),

        h(Sec, { n: '02', title: `已绑定（${boundRecs.length}）` },
          h('div', { className: 'roost-note' },
            '换机器人之后，新 openid 要**追加**到同一个号码下面。',
            '旧的 openid 一条都不会删——删了旧记忆就没人引用了，看起来像「迁移完记忆全没了」。'),
          boundRecs.length
            ? h('div', { className: 'roost-list' },
                boundRecs.map((rec) => {
                  const id = `${rec.kind}:${rec.uin}`
                  const live = (rec.claims || []).filter((c) => c.state !== 'revoked')
                  const revoked = (rec.claims || []).filter((c) => c.state === 'revoked')
                  /**
                   * 追加的候选只从**还没绑过**的键里挑。
                   *
                   * 拿已经绑过的去追加，服务端必然 409（同一个 openid 不能
                   * 同时属于两个号码），用户只会看到一句莫名其妙的冲突提示。
                   *
                   * 类型必须一致，而且要用 `kindOf()`（用户选的那个）而不是
                   * `x.kind`（会话记录里的那个）：类型留空的键 `x.kind` 是空串，
                   * `!x.kind` 恒真，会同时出现在群和人的候选里——
                   * 把群的 openid 追加到 QQ号 下面，正是注释里说的那种
                   * 「界面上完全看不出来」的错。
                   */
                  const wantKind = rec.kind === 'group' ? 'group' : 'c2c'
                  const cands = todo.filter((x) => kindOf(x) === wantKind)
                  return h('div', { key: id, className: 'roost-item' },
                    h('span', { className: 't' },
                      h('span', { style: { fontWeight: 600 } }, rec.uin),
                      h('span', { className: 'd' }, rec.kind === 'group' ? '  群' : '  私聊'),
                      h('div', { className: 'acc-claims' },
                        live.map((c) => h('div', { key: c.openid, className: 'acc-claim roost-mono' },
                          `${c.botId || '无归属'} · ${c.openid}`)),
                        revoked.length
                          ? h('div', { className: 'acc-claim' }, `另有 ${revoked.length} 条已撤销（留痕，不参与读取）`)
                          : null,
                      ),
                    ),
                    h('span', { className: 'd', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                      h('select', {
                        className: 'roost-input',
                        style: { width: '132px', padding: '3px 6px', fontSize: '11px' },
                        value: appendDraft[id] || '',
                        disabled: !roostOk || !cands.length,
                        onChange: (e) => setAppendDraft((d) => ({ ...d, [id]: e.target.value })),
                      },
                        h('option', { value: '' }, cands.length ? '选 openid…' : '没有可追加的'),
                        cands.map((c) => h('option', { key: c.key, value: c.key },
                          (c.title || c.short) + '（' + (c.journal ?? 0) + ' 条日记）')),
                      ),
                      h('button', {
                        type: 'button', className: 'roost-btn',
                        disabled: !roostOk || busy === id || !appendDraft[id],
                        onClick: () => append(rec),
                      }, busy === id ? '…' : '追加'),
                    ),
                  )
                }),
              )
            : h('div', { className: 'roost-empty' },
                bound?.ok === false
                  ? (bound.error || '读不到 Roost 的身份表')
                  : '还没有绑定过任何号码。'),
          bound?.botName ? h('div', { className: 'roost-note' }, `当前 Roost 机器人：${bound.botName}（${bound.bot}）`) : null,
        ),

        /** 群成员绑定 / 批量追加 / 一键改写：各自带状态，别把上面这页撑成一团 */
        h(AccountExtras, { toast, reload: load, roostOk }),
      )
    }


    /* ---------------- 账号迁移 · 扩展区 ---------------- */

    /**
     * 群成员绑定 / 批量追加 / 一键改写。
     *
     * 单独成组件是为了不给 AccountTab 再塞十几个 state——上面那页
     * 已经够长了，而且这三块各有自己的加载与危险操作确认流程。
     */
    function AccountExtras({ toast, reload, roostOk }) {
      const [people, setPeople] = useState(null)
      const [bound, setBound] = useState(null)
      const [scan, setScan] = useState(null)
      const [suggest, setSuggest] = useState(null)
      const [uins, setUins] = useState({})
      const [batchUin, setBatchUin] = useState('')
      const [picked, setPicked] = useState({})
      const [plan, setPlan] = useState(null)
      const [backups, setBackups] = useState([])
      const [confirmWord, setConfirmWord] = useState('')
      const [stoppedOld, setStoppedOld] = useState(false)
      const [busy, setBusy] = useState('')
      const [lastResult, setLastResult] = useState(null)

      const loadAll = useCallback(async () => {
        const [p, b, s, g, bk] = await Promise.all([
          get('/account/people'),
          get('/account/bound'),
          get('/account/scan'),
          get('/account/suggest'),
          get('/account/backups'),
        ])
        setPeople(p)
        setBound(b)
        setScan(s)
        setSuggest(g)
        setBackups(bk?.items || [])
      }, [])
      useEffect(() => { loadAll() }, [loadAll])

      const numberList = [
        ...(bound?.users || []).map((r) => ({ id: String(r.uin || ''), kind: 'user', label: `QQ号 ${r.uin} · ${r.name || '人'}` })),
        ...(bound?.groups || []).map((r) => ({ id: String(r.groupUin || r.uin || ''), kind: 'group', label: `群号 ${r.groupUin || r.uin} · ${r.name || '群'}` })),
      ]
      const batchRec = numberList.find((n) => n.id === batchUin)

      /** 批量追加的候选：记忆库里未绑定的键 + Roost 最近发言人（含群成员） */
      const attachCands = (() => {
        const m = new Map()
        for (const it of scan?.items || []) {
          if (!it.bound) m.set(it.key, { key: it.key, label: it.title || it.short })
        }
        for (const u of people?.users || []) {
          if (!m.has(u.openid)) m.set(u.openid, { key: u.openid, label: u.name || u.openid.slice(0, 8) })
        }
        return [...m.values()]
      })()
      const pickedKeys = Object.keys(picked).filter((k) => picked[k])

      const bindPerson = async (openid) => {
        const uin = String(uins[openid] || '').trim()
        if (!uin) return toast('先填 QQ号')
        setBusy(openid)
        const r = await post('/account/bind', { kind: 'user', uin, openid })
        setBusy('')
        if (!r.ok) return toast(r.error || '绑定失败')
        toast(`绑好了：${uin}`)
        setUins((d) => ({ ...d, [openid]: '' }))
        await loadAll()
        await reload?.()
      }

      const doBatch = async () => {
        if (!batchRec || !pickedKeys.length) return toast('先选号码，再勾几个 openid')
        setBusy('batch')
        const r = await post('/account/batch-attach', {
          kind: batchRec.kind, uin: batchRec.id, openids: pickedKeys,
        })
        setBusy('')
        /**
         * 一律走可选链：接口被中间层改成空 body、或者老版本没返回这两个字段时，
         * `r.done.length` 会抛 TypeError，而 `setBusy('')` 已经执行过了——
         * 按钮恢复、用户什么提示都没有，就是「点了没反应」。
         */
        const okN = r?.done?.length ?? 0
        const failN = r?.failed?.length ?? 0
        toast(failN
          ? `${okN} 条追加成功，${failN} 条失败（${r.failed[0]?.error || '原因未知'}）`
          : `${okN} 条都追加好了（旧 openid 一条没删）`)
        setPicked({})
        await loadAll()
        await reload?.()
      }

      const doPlan = async () => {
        setBusy('plan')
        const r = await get('/account/rewrite-plan')
        setBusy('')
        setPlan(r)
        if (!r.ok) toast(r.error || '预览失败')
      }

      const doRewrite = async () => {
        setBusy('rewrite')
        const r = await post('/account/rewrite', { confirm: confirmWord })
        setBusy('')
        setLastResult(r)
        toast(r.ok ? '改写完成，备份路径在下面' : (r.error || r.message || '改写失败'))
        setConfirmWord('')
        setStoppedOld(false)
        /** 旧清单已经不对了（那些键被合并掉了），清掉免得用户对着过期数据做决定 */
        setPlan(null)
        /**
         * 必须重新拉一遍：改写之后上面「待迁移」列表里那几个键已经不存在了，
         * 不刷新的话用户看到的是旧数据，会以为「点了没生效」。
         */
        await loadAll()
        await reload?.()
      }

      const doRollback = async (backup) => {
        setBusy('rollback')
        const r = await post('/account/rollback', { backup })
        setBusy('')
        toast(r.ok ? '已回退，数据重新读盘了' : (r.error || '回退失败'))
        setLastResult(r)
        setPlan(null)
        await loadAll()
        await reload?.()
      }

      return h('div', null,
        /* 03 群里的人 */
        h(Sec, { n: '03', title: `群里的人 / 私聊对象（${(people?.users || []).length}）` },
          h('div', { className: 'roost-note' },
            '上面两区列的是「会话键」；群里某个发言人的 QQ号是另一回事。',
            '这里列 Roost 最近发言人，填号码直接绑成「人」。'),
          people?.ok === false
            ? h('div', { className: 'roost-empty' }, people.error || '读不到 Roost 的未识别用户')
            : (people?.users || []).length
              ? h('div', { className: 'roost-list roost-scroll' },
                  people.users.map((u) =>
                    h('div', { key: u.openid, className: 'roost-item' },
                      h('span', { className: 't' },
                        u.name || u.openid.slice(0, 8),
                        h('span', { className: 'd' }, ' ' + u.openid.slice(0, 8) + '…'),
                        u.chatId ? h('span', { className: 'd' }, ' · 在 ' + u.chatId.slice(0, 8)) : null,
                      ),
                      h('input', {
                        className: 'roost-input', style: { width: '120px', padding: '4px 8px', fontSize: 12 },
                        placeholder: 'QQ号', value: uins[u.openid] || '',
                        onChange: (e) => setUins((d) => ({ ...d, [u.openid]: e.target.value })),
                        onKeyDown: (e) => { if (e.key === 'Enter') bindPerson(u.openid) },
                      }),
                      h('button', {
                        type: 'button', className: 'roost-btn', disabled: !roostOk || busy === u.openid,
                        onClick: () => bindPerson(u.openid),
                      }, busy === u.openid ? '…' : '绑定'),
                    ),
                  ),
                )
              : h('div', { className: 'roost-empty' }, '没有未识别的人。'),
        ),

        /* 04 换机器人 · 批量追加 */
        h(Sec, { n: '04', title: '换机器人 · 批量追加 openid' },
          h('div', { className: 'roost-note' },
            '新机器人给同一个人/群换了 openid，就把它**追加**到原来的号码下面。',
            '旧的 openid 一条都不删——删了旧记忆就没人引用了。'),

          /** 昵称候选：只提示，绝不自动绑 */
          (suggest?.items || []).length
            ? h('div', { className: 'acc-warn' },
                h('div', null, suggest.note),
                ...suggest.items.slice(0, 6).map((it) =>
                  h('div', { key: it.key, style: { marginTop: 4 } },
                    `「${it.label}」可能是 `,
                    ...it.candidates.slice(0, 2).map((c) =>
                      h('button', {
                        key: c.uin, type: 'button', className: 'roost-btn',
                        style: { padding: '2px 7px', marginRight: 4, fontSize: 11 },
                        onClick: () => setBatchUin(c.uin),
                      }, `${c.uin}（${c.kind === 'group' ? '群' : '人'}）`),
                    ),
                  ),
                ),
              )
            : null,

          h('div', { className: 'acc-tools' },
            h('select', {
              className: 'roost-input', style: { width: 'auto', minWidth: 220, padding: '5px 9px' },
              value: batchUin, onChange: (e) => setBatchUin(e.target.value),
            },
              h('option', { value: '' }, numberList.length ? '选一个已绑定的号码…' : '还没有绑定过任何号码'),
              ...numberList.map((n) => h('option', { key: n.id, value: n.id }, n.label)),
            ),
            h('span', { className: 'roost-note', style: { margin: 0 } }, `已勾 ${pickedKeys.length} 个`),
            h('button', {
              type: 'button', className: 'roost-primary',
              disabled: !roostOk || !batchRec || !pickedKeys.length || busy === 'batch',
              onClick: doBatch,
            }, busy === 'batch' ? '提交中…' : '一键追加'),
          ),
          attachCands.length
            ? h('div', { className: 'roost-list roost-scroll', style: { marginTop: 8, maxHeight: 200 } },
                attachCands.map((c) =>
                  h('label', { key: c.key, className: 'roost-item', style: { alignItems: 'center', cursor: 'pointer' } },
                    h('input', {
                      type: 'checkbox', checked: Boolean(picked[c.key]),
                      onChange: (e) => setPicked((d) => ({ ...d, [c.key]: e.target.checked })),
                    }),
                    h('span', { className: 't' }, c.label),
                    h('span', { className: 'd roost-mono' }, c.key.slice(0, 12) + '…'),
                  ),
                ),
              )
            : h('div', { className: 'roost-empty' }, '没有可追加的 openid（新机器人还没说过话？让它先收一条消息）。'),
        ),

        /* 05 一键改写（危险） */
        h(Sec, { n: '05', title: '一键改写：合并后删掉旧键' },
          h('div', { className: 'acc-warn' },
            '⚠ 这是整条链路里唯一会**重写记忆数据**的操作：把某号码名下所有旧 openid 键的',
            ' facts / 日记 / 图谱 / 授权 / 会话映射合并到号码键，旧键删除。',
            '执行前自动整文件备份，失败自动回退，成功后仍可一键回退。',
            plan?.warning ? h('div', { style: { marginTop: 6 } }, plan.warning) : null,
          ),

          h('div', { className: 'acc-tools' },
            h('button', { type: 'button', className: 'roost-btn', onClick: doPlan, disabled: busy === 'plan' },
              busy === 'plan' ? '扫描中…' : '预览改写清单'),
            h('span', { className: 'roost-note', style: { margin: 0 } },
              '预览只读，不改任何东西'),
          ),

          plan?.ok
            ? h('div', { style: { marginTop: 8 } },
                h('div', { className: 'roost-note' },
                  `数据目录：${plan.dataDir}`,
                  h('br'),
                  `备份位置：${plan.backupRoot}`,
                  h('br'),
                  `合计：${plan.totals.keys} 个旧键 · ${plan.totals.facts} 条 facts · ${plan.totals.journal} 条日记 · ${plan.totals.edges} 条关系`),
                h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 180, marginTop: 6 } },
                  (plan.files || []).filter((f) => f.exists).map((f) =>
                    h('div', { key: f.name, className: 'roost-item' },
                      h('span', { className: 't roost-mono' }, f.abs),
                    ),
                  ),
                  ...(plan.items || []).map((it) =>
                    /** 同样不能套 .roost-item：右边是用顿号拼的长串，会把标题压成竖排 */
                    h('div', { key: it.uin, className: 'diag-item' },
                      h('div', { className: 't' }, `${it.uin} ← ${it.keys.length} 个旧键`),
                      h('div', { className: 'd' },
                        it.keys.map((k) => `${k.key.slice(0, 8)}(${k.facts}/${k.journal}/${k.edges})`).join('、')),
                    ),
                  ),
                ),

                h('div', { className: 'acc-tools' },
                  h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
                    h('input', {
                      type: 'checkbox', checked: stoppedOld,
                      onChange: (e) => setStoppedOld(e.target.checked),
                    }),
                    '我已经停掉旧机器人'),
                  h('input', {
                    className: 'roost-input', style: { width: 130, padding: '5px 9px' },
                    placeholder: '输入「改写」', value: confirmWord,
                    onChange: (e) => setConfirmWord(e.target.value),
                  }),
                  h('button', {
                    type: 'button', className: 'roost-primary',
                    disabled: !stoppedOld || confirmWord.trim() !== '改写' || busy === 'rewrite' || !plan.totals.keys,
                    onClick: doRewrite,
                  }, busy === 'rewrite' ? '改写中…' : '执行改写'),
                ),
              )
            : null,

          lastResult
            ? h('div', { className: 'roost-note', style: { marginTop: 8, color: lastResult.ok ? 'var(--good, #2e7d32)' : 'var(--bad)' } },
                lastResult.ok
                  ? `改写完成。备份：${lastResult.backup} · ${lastResult.hint}`
                  : `${lastResult.error}${lastResult.rolledBack ? '（已自动回退）' : ''}${lastResult.backup ? ` · 备份 ${lastResult.backup}` : ''}`)
            : null,

          backups.length
            ? h('div', { style: { marginTop: 8 } },
                h('div', { className: 'roost-note' }, '可回退的备份（最近的在前）'),
                h('div', { className: 'roost-list' },
                  backups.slice(0, 5).map((b) =>
                    h('div', { key: b.dir, className: 'roost-item' },
                      h('span', { className: 't roost-mono' }, b.dir),
                      h('span', { className: 'd' }, `${b.files} 个文件`),
                      h('button', {
                        type: 'button', className: 'roost-btn', disabled: busy === 'rollback',
                        onClick: () => doRollback(b.dir),
                      }, '一键回退'),
                    ),
                  ),
                ),
              )
            : null,
        ),
      )
    }

    /* ---------------- 设置 ---------------- */

    const JSON_SECTIONS = [
      ['memory', '记忆', '日记寿命、注入条数、多少轮全量重注、记忆工具开关'],
      ['security', '安全防护', 'dangerousConfirm：删根目录/格式化/关机/下载后执行这类命令先在 QQ 里问一句「确认」，只放一次；ssrf：出站 URL 逐 IP 校验（默认拒内网），自建服务用 allowPrivate 或 allowHosts 显式放开'],
      ['mood', '心情', 'effects 打开后聊天里被夸/被凶会带动心情；halfLifeHours 是回中性半衰期、baseline 是衰减落点（心情页有控件）；日常在「权限」页的高级组里点'],
      ['offpeak', '错峰', 'mode self=谷时窗口+安静期（默认）；official=官方峰时（工作日 9–12/14–18 高峰，节假日与周末全天空闲，和账单档位同一份判据）；deferHeavy 开了才把压库/过期压缩限到谷时跑；holidays 可覆盖节假日表'],
      ['usage', '用量金额', '概览的「今日花费」只折算 pricing 里有的模型（内置 DeepSeek 官方价）；键是模型名子串，值是 peak/idle 两档的 元/百万 tokens，价格会过期以官网为准'],
      ['recall', '召回参数', '每路取几条/实体上限/每实体联想几条/三个注入预算（字）；默认就是原写死值，调坏了在记忆页点「恢复默认」；没有「最低相关度」——RRF 名次融合没有跨路可比的分数，那个旋钮调了也没反应'],
      ['backup', '备份', 'schedule：每天到点自动导 zip（hour 时刻、keep 留几份）；remote：先 AES-GCM 加密再推 Gitee 私有仓（推前硬校验 private）或 WebDAV，passphrase 没配拒推不推明文；maxBytes 是推送体积上限（备份页 05 有控件）'],
      ['events', '经历', 'enabled：记不记她主动做过的事（找过人、发过文件）。24 小时自动过期，只给主人私聊当素材；关着也能在「记忆」页查看和清空已有的'],
      ['profiles', '人物档案', 'enabled：要不要把对熟人的印象攒成一小段，聊天时带上。每天凌晨巩固时提炼、跨群共用，同一天里提示词不变；关着也能在「记忆」页查看和清空已有的'],
      ['compact', '上下文压缩', '两个场景的阈值、开场带几条原话'],
      ['awake', '主动说话', '清醒时段、机会分门槛、群白名单（开着时 speakUp.prompt 会当额外要求一起给）'],
      ['wakeup', '互动召回', 'enabled 默认关。官方口径：用户主动说过话之后 30 天内，当天 / 1–3 天 / 3–7 天 / 7–30 天四个窗口各 1 条（共 4 条），超 30 天没额度；idleHours 是「多久没说话才召回」的额外门槛，默认 72 小时所以实际只命中后两档。和 speakUp 是两本账'],
      ['speakUp', '私聊排期', '主人 openid、间隔/免打扰/每日上限、followUps（说几次没回就不再追）'],
      ['extProactive', '扩展主动消息', '扩展只投递素材，措辞、门闸、额度、审批都在宿主。enabled 默认开；maxPerDay 是这条通道自己的每日额度（和 speakUp 两本账）；approval 开了群分享要主人回「发 1」或去面板点批准；allowGroup 关掉后素材只能发私聊'],
      ['shareAppid', '手填的机器人 AppID', '「加机器人进频道」那条链接只由 appid 拼成。'
        + '正常情况下从框架读；读不到（外接协议断开 / 框架配置没填）时可以在这里填一次，'
        + '面板「频道总览 → 01」也能直接填'],
      ['ownerAliases', '主人的其他渠道 id', '同一个人的 id 在群/私聊（openid）和频道（author.id）是两套标识，'
        + '框架 owners 只认一种，所以主人在频道里会被算成普通成员。这里登记的 id 命中就按主人算（只影响本插件）；'
        + '面板「群与频道 → 频道总览 → 我在频道里是谁」可以直接点选，不用手填'],
      ['channelPost', '频道发帖', 'enabled：允不允许发；guildId / channelId 是目标频道与论坛版块（面板「发帖」页选）；'
        + 'timesPerDay / windowStart / windowEnd / minGapMinutes 是每天几篇与排期；minChars / maxChars 是正文字数；'
        + 'dryRun 试运行（默认开，只记账不外发）；allowTools 允不允许她在对话里自己发；askFirst 每次发前要不要先点头'],
      ['closing', '收尾', '对话冷掉前自己补一句：多久算冷（coolMinutes）、盯几个会话（maxChats）、记录留几天（ttlDays）'],
      ['leakGuard', '防复读', 'enabled：她回复里整段复述了注入的记忆块，出站前删掉那几句。默认关，日常在「权限」页高级组里点'],
      ['bridge', '对外联动（实验）', 'enabled：让别的 DSH 插件通过 ctx.get("aurabot") 主动发消息、读状态；接口可能变，默认关'],
      ['autotelic', '自驱引擎（实验）', '默认全关。enabled 开了她才会有自己的时间；allowAct 决定能不能动手（关着只能想）；'
        + 'maxPerDay 一天最多推进几次、failLimit 连续失败几次自动卡住、stuckHours 卡多久；'
        + 'heartbeatMin 是自动心跳间隔（0 = 只能手动点）；seeds 是她可以琢磨的方向，空就不立项。'
        + '所有动作都进 autotelic-ledger.jsonl 的哈希链账本，面板能看链完整性和断在第几条'],
      ['model', '模型', '三层回退：byChat[chatId] > byKind.c2c / byKind.group > default > DSH 全局默认模型。'
        + 'default 是「所有聊天都用它」（面板「聊天用的模型」那张卡）。'
        + 'effort 是全局思考强度（low / high / max，空 = 不传）：哪一级显式写了 reasoningEffort 就以它为准。'
        + '真正下传前会先问 DSH 这个模型支持哪几档，不支持就不传，避免整轮直接报错'],
      ['persona', '人格', '当前用哪个人格、按群指定；换人格去「人格」页点「用这个」'
        + '（name / text 是 0.10.0 之前的旧字段，只在人格文件读不出正文时才兜底）'],
      ['selfExpression', '她自己的资料', 'menu / sign / name / avatar 四段的 enabled（工具注册不注册）与 cooldownMin'
        + '（两次写至少隔几分钟，0 = 完全不限——这里不设默认值，也不编平台次数）；'
        + 'sign / name / avatar 另有 confirm（改前私聊问一句，点「确认改」按钮才执行）与 unattended'
        + '（主动搭话 / 夜间巩固这类没人看着的轮次允不允许改，默认简介开、昵称头像关，面板可逐项改）；'
        + 'avatar.anyPath 决定本机图片能不能超出数据目录（默认允许，关掉后只能用数据目录里的图当头像）；'
        + 'awareness.mood / silence 只影响她「知不知道」自己的状态，不触发动作；'
        + 'proactive.enabled 允许她在主动搭话那一轮顺手改，fields 决定能动哪几项'],
      ['stickers', '图库', '图放哪、要不要注入；线上那份留不留'],
      ['gallery', '图库', 'keepUploads：发图时往官方素材池传的那份留不留。'
        + '默认 true＝留着复用（同一张图第二次发不重传、不占新配额）；'
        + 'false＝用完即删，只在配额特别紧（多个插件共用一个机器人）时才值得'],
      ['guild', '频道', 'enabled：频道总开关，**默认关**。关着时只在 dsh-roost 入口丢弃频道事件，不动框架的 intents 订阅（框架照常收、照常推给别的插件）；'
        + 'sessionMode：guild = 一个频道一个会话（同一频道的子频道/论坛/公告共用）、channel = 一个子频道一个会话；频道私信固定一人一个。'
        + 'intentsPreset：面板勾选的订阅位预设；overrides：按频道覆写，键用 guild:<guildId>'],
      ['permissions', '权限', '主人/管理员/成员各能用什么工具'],
      ['qqTools', 'QQ 工具', '给 AI 的工具总开关；`qq_send` 不设段数硬上限、按需要分段，旧配置里的 maxParts 已作废'],
      ['quota', '次数限制', '语音/发文件/表情包的额度覆盖。默认值在代码里（quota.js 的 QUOTA_DEFAULTS），'
        + '这里只填要改的；日常用「权限」页调，这里是手改的口子'],
      ['sendFile', '发文件', '能发哪些文件：restrictPaths 默认关＝全盘都能发；'
        + '开了只允许 workspace / images / extraRoots 里的路径'],
      ['channel', '通道', '只保留 roost（框架外接协议直连）；老配置里的 qq 会自动归一'],
      ['roostHost', '直连 roost', 'enabled：要不要连框架的外接协议（地址和 token 在 roost 面板「外接」页，'
        + '端口是 6800+hash，每只鸟不一样）。url 形如 http://127.0.0.1:6801；'
        + 'vision 三态：true 总是发图 / false 只给文字提示 / "auto" 按 DSH 声明的模型能力决定；'
        + 'maxImages 是一次最多看几张（0 关，上限 8）；'
        + 'markdown 关掉后加粗列表和真 @ 都会退化成纯文字。'
        + '**只有 enabled 一个开关**：关了就不连，开着就连（`channel.current` 已废弃，'
        + '只剩 roost 一条通道，老配置里的 qq 会自动归一）。'
        + 'merge：连发几句攒成一段再回（私聊和被 @ 不等）。'
        + 'decide：群里**没被 @** 时要不要接——mode 有 ai / mention（只在被 @ 时）/ '
        + 'window（@ 后 N 分钟内）/ engaged（刚说过话算在聊，engagedMaxTurns 是最多接几次）；'
        + 'cooldownSec 冷却（期间的消息攒着不丢）、maxRepliesPerMin 每分钟条数、'
        + 'maxPerHour / burstMax / quietStartHour~quietEndHour / shortAskMustReply 是刹车，'
        + '数值 0 和起止相同都表示关。接话策略、防吵、冷却都在这里设'],
      ['group', '群聊补充', 'interruptChance：群里没人明确叫她时的插话概率（100 = 句句都接，升级前的行为）；'
        + 'briefMaxItems：主人私聊问「某群刚聊了什么」回几条；'
        + 'overrides：按群 openid 覆写，可改 mode / 冷却 / 每分钟 / 每小时上限 / 静默时段 / 插话概率等'
        + '（白名单在 roost-decide.js 的 OVERRIDE_KEYS，空对象当开放字典）。'
        + '日常在「群聊 → 群聊策略」06、07 两张卡里改'],
      ['chat', '会话', '一轮最多等多久；上游 502/429 时的补重试（attempts 是「补几次」，budgetSec 是整轮总预算）'],
      ['workspace', '工作区', '机器人会话挂哪个工作区：dir 留空单开、__default__ 用默认'],
      ['server', '服务', '端口与密钥'],
      ['tts', '语音合成', '默认关闭；在「表达 → 语音合成」那张卡里改（也可以在这里手改）'],
      ['setup', '接入', '装在哪、用哪种接入方式'],
      ['update', '更新源', 'npm 源（registry）。留空跟随 pnpm 配置的源（国内常是镜像，同步有延迟）；'
        + '版本检查会同时问官方源、取较新者，装包仍优先走你配的源'],
      ['extensions', '用户扩展', 'enabled：扩展说明要不要进 QQ 会话提示词。关着时清单还在、/v1 与已发令牌照常，只是不挂 usage section'],
    ]

    /**
     * 更新块（设置页最上面）。
     *
     * 放在设置页顶部而不是单开一个侧边栏入口，是主人的决定：更新是低频动作，
     * 为它多占一行侧边栏不划算；而设置页是"改这台机器"的地方，更新本来就属于这里。
     *
     * 两块东西各自独立：
     *   · **本体**——走 DSH 的 pluginManager 装 npm 包，装完要重启 DSH
     *   · **人格库**——从仓库拉 personas/*.md，即时生效、不碰你改过的
     * 刻意**都不自动**：本体更新会改用户的安装，人格变味比版本旧难受得多。
     */
    function UpdatesBlock({ toast }) {
      const [info, setInfo] = useState(null)
      const [repo, setRepo] = useState(null)
      const [busy, setBusy] = useState('')
      const [at, setAt] = useState('')
      /** 上一次自更新的失败详情：错误码之外还有 pnpm 的分类、原文和日志路径 */
      const [fail, setFail] = useState(null)
      /** 「成功但版本不对」也要留一块持久提示：降级是静默的，toast 一闪就没 */
      const [notice, setNotice] = useState(null)
      /** 5.8 测试版通道：改完立刻重查一次，否则要等 6 小时缓存 */
      const [channel, setChannel] = useState(() => {
        try { return localStorage.getItem('roost.update.channel') === 'beta' ? 'beta' : 'latest' } catch { return 'latest' }
      })

      /**
       * 读检查结果。
       *
       * 默认只读**后台快照**（插件启动 10 秒后查一次、之后 6 小时一次），
       * 所以进设置页不会卡在 registry 的 8 秒超时上；`force` 才是真的重查。
       */
      const loadCheck = async (force, ch = channel) => {
        /** 5.8：带上通道，后端据此比 latest 还是 next；force 时一并重查 */
        const qs = `?channel=${encodeURIComponent(ch)}` + (force ? '&force=1' : '')
        const r = await get('/update/check' + qs)
        setInfo(r && r.ok !== false ? r : { ok: false, own: r?.own || '', error: r?.error || '查不到', canSelf: false })
        setAt(new Date().toLocaleTimeString())
      }
      const loadRepo = async () => {
        try {
          const r = await get('/personas/repo')
          if (r.ok !== false) setRepo(r)
        } catch {}
      }
      useEffect(() => { loadCheck(false, channel); loadRepo() }, [])

      const doSelf = async (fresh) => {
        setBusy(fresh ? 'fresh' : 'self')
        try {
          const r = await post('/update/self', { fresh })
          /**
           * 失败时把**完整结果**留下来，而不只是弹一句 toast。
           *
           * 以前所有失败都只弹「更新失败，本地什么都没动」，用户没法定性；
           * 现在错误码、pnpm 分类、诊断原文、日志路径都在 `r.detail` 里，
           * 折在下面让他随时能翻出来发给别人。
           */
          setFail(r && r.ok === false ? r : null)
          // 降级 / 没核对到版本：toast 一闪就没，必须留一块持久提示，
          // 否则用户看到「已装新版」，重启后还是旧版
          setNotice(r && r.ok && (r.downgraded || r.unverified) ? r : null)
          toast(r.message || (r.ok ? '更新完成，重启 DSH 生效' : '没更新成'))
          // 装完必须强刷：快照是装之前的，直接读回来还是「有新版」
          await loadCheck(true)
        } finally {
          setBusy('')
        }
      }

      const doPersonas = async () => {
        setBusy('personas')
        try {
          const r = await post('/personas/sync', {})
          if (r.skipped) toast(r.why || '这次没更新')
          else {
            const parts = []
            if (r.updated?.length) parts.push(`更新 ${r.updated.length} 个`)
            if (r.untouched?.length) parts.push(`跳过 ${r.untouched.length} 个（你改过）`)
            if (r.failed?.length) parts.push(`失败 ${r.failed.length} 个`)
            toast(parts.join('；') || '已经是最新的')
          }
          await loadRepo()
        } finally {
          setBusy('')
        }
      }

      const own = info?.own ? 'v' + info.own : '—'
      const latest = info?.latest ? 'v' + info.latest : ''
      const pending = repo?.pending || 0
      /** 源地址只留主机名：面板一行放不下完整 URL，用户认的也是 `registry.npmmirror.com` */
      const hostOf = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '')

      return h(Sec, {
        n: '01', title: '更新',
        right: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          /**
           * 5.8 测试版通道：稳定版 / 测试版（npm dist-tag `beta`）。
           * 切换只改「比哪个版本」，不改安装方式；存 localStorage 免得每次进来都要选。
           */
          h('select', {
            className: 'roost-input', title: '更新通道：稳定版（latest）/ 测试版（beta）',
            style: { width: 'auto', padding: '2px 6px', fontSize: 11.5 },
            value: channel,
            onChange: (e) => {
              const v = e.target.value === 'beta' ? 'beta' : 'latest'
              setChannel(v)
              try { localStorage.setItem('roost.update.channel', v) } catch {}
              loadCheck(true, v)
            },
          },
            h('option', { value: 'latest' }, '稳定版'),
            h('option', { value: 'beta' }, '测试版 beta')),
          h('button', { type: 'button', className: 'roost-btn', onClick: () => { loadCheck(true, channel); loadRepo() } }, '重新检查'),
        ),
      },
        /* ---- 本体 ---- */
        h('div', { className: 'roost-item' },
          h('div', { className: 't' },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, 'dsh-roost 本体'),
              h('span', { className: 'roost-note', style: { margin: 0 } },
                `当前 ${own}`
                + (info?.pendingRestart ? ` · 已装 v${info.installed}（重启生效）` : '')
                + (latest ? ` · 最新 ${latest}` : '')
                + (info?.ageText ? `（${info.ageText}）` : '')),
              info?.hasUpdate ? h(Pill, { tone: 'info' }, '有新版') : null,
              info?.pendingRestart && !info?.hasUpdate ? h(Pill, { tone: 'ok' }, '待重启') : null,
            ),
            /**
             * 三种装法要说清，不然用户点不动按钮也不知道为什么：
             * 开发模式（符号链接）根本不该更新，会把源码链路搞断。
             */
            h('div', { className: 'roost-note', style: { marginTop: 2 } },
              info?.pending
                // 后台还没查完：不能说「已是最新」，那是在编
                ? '后台正在检查最新版（启动后 10 秒查一次，之后每 6 小时一次）；点「重新检查」可以立刻查。'
                : info?.kind === 'linked'
                  // link: 装法连命令都不给（见 updateCommand 注释）：add 会把链接换成真实目录
                  ? '开发模式（link: 装法）：自更新已禁用，下面也没有可跑的命令。更新请 git pull 后重启 DSH。'
                  : info?.pendingRestart
                    // 装完没重启：磁盘上已经是新版，运行中的还是旧版。这句话不写清楚，
                    // 用户会以为"更新失败"，然后再点一次
                    ? `新版已经装到磁盘上了，重启 DSH 就会生效（面板上的版本号要重启后才变）。`
                    : info?.kind === 'real'
                      /**
                       * 真实目录但没有 `updateBundle`：面板装不了升级。
                       * 这时候还写「装完要重启」会让人以为按钮在、只是没显示。
                       */
                      ? (info?.canSelf === false
                        ? '这个 DSH 版本的插件面板只能装新包、装不了升级，请用下面那行命令（跑完重启 DSH）。'
                        : '装完要重启 DSH 才生效。')
                      : info?.hasManager === false
                        ? '这个 DSH 版本没有 pluginManager，请用下面那行命令手动更新。'
                        : (info?.error
                          ? `查不到最新版：${info.error}——不影响试装，pnpm 会自己解析 latest。`
                          : '')),
            (info?.cooling || info?.coolingUnknown) && info?.hasUpdate
              ? h('div', { className: 'roost-note', style: { color: 'var(--warn)', marginTop: 2 } },
                  info?.cooling
                    ? `${latest} 发布不满 24 小时（pnpm 默认不装这么新的版本，会降级），${info.coolingLeftText}。`
                      + '点「立即安装」会先给 dsh-roost 加一条豁免再装。'
                    : `查不到 ${latest} 的发布时间，可能仍在 pnpm 的 24 小时冷却期内。`
                      + '点「立即安装」会加一条只对本包生效的豁免，避免静默装到旧版。')
              : null,
            /**
             * 「是谁说的」要写在面板上。
             *
             * 用户配了镜像时，镜像滞后会让面板一直说「已是最新」——而 npm 上
             * 明明有新版。现在版本判断取两个源里较新的那个，镜像是谁说清楚的，
             * 免得用户以为源配错了、或者以为更新坏了。
             */
            info?.mirrorLag
              ? h('div', { className: 'roost-note', style: { color: 'var(--warn)', marginTop: 2 } },
                  `你配的源（${hostOf(info.registry)}）还停在 v${info.mirrorLatest}，`
                  + `${latest} 目前只在官方源上。版本判断按官方算`
                  + (info.canSelf ? '，点更新也会直接从官方装，不用先换源。' : '。'))
              : null,
            info?.ok !== false && info?.registry && !info?.mirrorLag
              ? h('div', { className: 'roost-note', style: { marginTop: 2, opacity: 0.65 } },
                  `查询源：${hostOf(info.registry)}`)
              : null,
          ),
          h('div', { className: 'roost-acts' },
            /**
             * 装好待重启时给一颗**禁用**按钮，而不是什么都不显示。
             *
             * 按钮直接消失会让人以为"更新入口没了"；留一颗灰的，
             * 顺带把"该做什么"写在按钮上（重启）。
             */
            info?.pendingRestart && !info?.hasUpdate
              ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: true,
                  title: '重启 DSH 之后版本号和功能才会变',
                }, `已装 v${info.installed} · 待重启`)
              : null,
            info?.canSelf && info?.hasUpdate
              ? h('button', {
                  type: 'button', className: 'roost-primary', disabled: Boolean(busy),
                  onClick: () => doSelf(false),
                }, busy === 'self' ? '更新中…' : `更新到 ${latest}`)
              : null,
            /**
             * 查不到最新版时的出口。
             *
             * `check()` 只是前置判断，装的时候 pnpm 自己会解析 latest tag。
             * 不给这个按钮的话，registry 一超时（国内很常见）用户就彻底没辙了。
             */
            info?.canSelf && info?.unknownLatest
              ? h('button', {
                  type: 'button', className: 'roost-primary', disabled: Boolean(busy),
                  title: '查不到版本号不影响安装：让 pnpm 自己解析 latest',
                  onClick: () => doSelf(false),
                }, busy === 'self' ? '更新中…' : '按 latest 试装')
              : null,
            info?.canSelf && info?.hasUpdate && (info?.cooling || info?.coolingUnknown)
              ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: Boolean(busy),
                  title: '改 pnpm-workspace.yaml 加一条只对 dsh-roost 生效的豁免，然后立刻装',
                  onClick: () => doSelf(true),
                }, busy === 'fresh' ? '安装中…' : '立即安装（不等 24 小时）')
              : null,
          ),
        ),
        /**
         * 手动更新命令（兜底出口）。
         *
         * 三种装不了的情况（开发模式符号链接 / 没有 pluginManager /
         * DSH 以 already-installed 拒绝重装）以前只能给一句
         * 「去 DSH 插件管理里手动更新」——用户根本不知道要跑什么。
         * 命令里的 profile 名是服务端从**真实安装目录**推出来的，
         * 不是写死的 desktop（用 web / headless profile 的人不会装错地方）。
         *
         * 放在 `.roost-item` **外面**：那个容器是 `display:flex;align-items:baseline`，
         * 塞进去会和标题、按钮挤成一行，命令被压到只剩几个字宽。
         */
        info?.command
          ? h(info.canSelf ? 'details' : 'div', { className: 'roost-cmd' },
              info.canSelf
                ? h('summary', null, `也可以自己在 ${info.shell} 里跑（profile: ${info.profile}）`)
                : h('div', { className: 'roost-note', style: { flex: '1 1 100%', margin: '0 0 2px' } },
                    `在 ${info.shell} 里跑这一行，跑完重启 DSH（profile: ${info.profile}）：`),
              h('code', null, info.command),
              h('button', {
                type: 'button', className: 'roost-btn',
                onClick: async () => {
                  try { await navigator.clipboard.writeText(info.command); toast('命令复制好了') }
                  catch { toast('复制失败，手动选中那行复制') }
                },
              }, '复制'))
          : null,
        /**
         * 自更新失败的详情。
         *
         * toast 一闪就没了，而"为什么失败"恰恰是用户唯一的求助材料：
         * 错误码、pnpm 的分类（网络/权限/磁盘满）、诊断原文、日志路径，
         * 全折在这里，需要时展开抄给别人。
         */
        fail
          ? h('div', { className: 'pv-warn', style: { marginTop: 8 } },
              h('div', { style: { flex: '1 1 100%' } },
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, '这次没装上'),
                h('div', { className: 'roost-note', style: { marginTop: 2 } }, fail.message || '没有更多信息'),
              ),
              (() => {
                const d = fail.detail || {}
                const lines = [
                  fail.code ? `code: ${fail.code}` : '',
                  /** 升级专用：卡在哪一步、从哪版到哪版（停在 check 说明 profile 没动） */
                  d.step ? `step: ${d.step}` : '',
                  (d.from || d.to) ? `version: ${d.from || '?'} → ${d.to || '?'}` : '',
                  d.kind ? `kind: ${d.kind}${d.timedOut ? '（静默超时）' : ''}` : '',
                  d.failedAt ? `failedAt: ${d.failedAt}` : '',
                  d.exitCode != null ? `exitCode: ${d.exitCode}` : '',
                  d.logPath ? `log: ${d.logPath}` : '',
                  d.diagnostic ? `diagnostic: ${d.diagnostic}` : '',
                  d.output ? `output: ${d.output}` : '',
                ].filter(Boolean)
                if (!lines.length) return null
                return h('details', { className: 'roost-note', style: { flex: '1 1 100%', margin: 0 } },
                  h('summary', { style: { cursor: 'pointer' } }, '技术细节（复制给别人更好排查）'),
                  h('div', { className: 'roost-mono', style: { marginTop: 5, whiteSpace: 'pre-wrap', lineHeight: 1.6 } },
                    lines.join('\n')),
                )
              })(),
              /** 装失败时把命令一起给出来：DSH 拒绝重装 / 权限问题，唯一的出路就是手动跑一行 */
              fail.command
                ? h('div', { className: 'roost-cmd', style: { flex: '1 1 100%' } },
                    h('code', null, fail.command),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: async () => {
                        try { await navigator.clipboard.writeText(fail.command); toast('命令复制好了') }
                        catch { toast('复制失败，手动选中那行复制') }
                      },
                    }, '复制命令'))
                : null,
              h('button', { type: 'button', className: 'roost-btn', onClick: () => setFail(null) }, '知道了'),
            )
          : null,

        /**
         * 更新「成功」但没装到想要的版本：持久展示，别只弹 toast。
         * pnpm 被 24h 冷却挡住时是**静默降级、不报错**，用户唯一的线索就是这块。
         */
        notice
          ? h('div', { className: 'pv-warn', style: { marginTop: 8 } },
              h('div', { style: { flex: '1 1 100%' } },
                h('div', { style: { fontSize: 12, fontWeight: 600 } }, '装上了，但版本不对'),
                h('div', { className: 'roost-note', style: { marginTop: 2 } }, notice.message || '没能核对到实际装到的版本'),
              ),
              h('button', { type: 'button', className: 'roost-btn', onClick: () => setNotice(null) }, '知道了'),
            )
          : null,

        /* ---- 人格库 ---- */
        h('div', { className: 'roost-item', style: { marginTop: 8 } },
          h('div', { className: 't' },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, '人格库'),
              h('span', { className: 'roost-note', style: { margin: 0 } },
                repo ? `${(repo.personas || []).length} 个` + (pending ? ` · ${pending} 个可更新` : ' · 都是最新的') : '读着…'),
              repo?.stale ? h(Pill, { tone: 'warn' }, '缓存清单') : null,
            ),
            h('div', { className: 'roost-note', style: { marginTop: 2 } },
              repo && repo.gate && repo.gate.ok === false
                ? repo.gate.why + '，先升级本体。'
                : '从 dsh-roost-personas 仓库拉。只覆盖没改过的，你自己改过和自建的一个不碰；即时生效不用重启。'),
          ),
          h('div', { className: 'roost-acts' },
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: Boolean(busy) || (repo?.gate && repo.gate.ok === false),
              onClick: doPersonas,
            }, busy === 'personas' ? '更新中…' : (pending ? `一键更新 ${pending} 个` : '一键更新')),
          ),
        ),

        at ? h('div', { className: 'roost-note', style: { marginTop: 6 } }, `最后检查 ${at}`) : null,
      )
    }

    /** 交流反馈群：固定群号，一键复制 */
    /**
     * 更新历史。
     *
     * 面板原来只在**版本变过**时弹一次「这次改了什么」，看过就没了——
     * 换机器、隔几版才回来、或者想知道某个行为是哪版改的，都没有地方翻。
     * 这里把 notes 里的版本全列出来，默认当前版本。
     */
    function ChangelogBlock({ toast }) {
      const [data, setData] = useState(null)
      const [sel, setSel] = useState('')
      const load = useCallback(async (v) => {
        try {
          const r = await get('/update/notes' + (v ? '?version=' + encodeURIComponent(v) : ''))
          if (r) { setData(r); setSel(r.showing || r.version || '') }
        } catch { /* 读不到就留空，别让整页崩 */ }
      }, [])
      useEffect(() => { load() }, [load])

      const versions = data?.versions || []
      /** 默认展开：整个面板的既定规则是「分节默认全展开，折叠不卸载功能」 */
      return h(Sec, { n: '02', title: '更新历史' },
        h('div', { className: 'roost-g-card' },
          h('p', { className: 'roost-g-desc' },
            '每一版改了什么都在这里，往回翻得到。只列有说明的版本——很早的版本可能没写。'),
          versions.length
            ? h(GRow, { label: '版本', hint: '新的在前' },
              h('select', {
                className: 'roost-g-sel', value: sel,
                onChange: (e) => load(e.target.value),
              },
                versions.map((v) => h('option', { key: v, value: v },
                  v === data?.version ? `v${v}（当前）` : `v${v}`))))
            : h('p', { className: 'roost-note' }, '还没有更新说明。'),
          h('pre', {
            style: {
              marginTop: 8, padding: '10px 12px', borderRadius: 8, whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.7,
              maxHeight: 420, overflow: 'auto', fontFamily: 'inherit',
              background: 'var(--dsw-alias-fill-secondary, rgba(128,128,128,.12))',
            },
          }, data?.notes || '这一版没写说明。')))
    }

    function FeedbackCard({ toast }) {
      const [copied, setCopied] = useState(false)
      const group = '1130901545'

      return h(Sec, { n: '03', title: '交流反馈群' },
        h('div', { className: 'roost-note', style: { marginTop: 2 } },
          '遇到问题、想加功能，或者只是想看看别人怎么用，都可以进群说。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
          h('span', { className: 'roost-code', style: { fontSize: 14, padding: '4px 8px' } }, group),
          h('button', {
            type: 'button', className: 'roost-btn',
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(group)
                setCopied(true)
                toast('群号已复制')
                setTimeout(() => setCopied(false), 1500)
              } catch {
                toast('复制失败，手动记一下：' + group)
              }
            },
          }, copied ? '已复制' : '复制群号'),
        ),
      )
    }

    /** 工作区：当前挂在哪个目录 + 改名 / 换目录。
     * 2.7：本体挪进「首次设置」，设置页只留一行链接——
     * 工作区属于「装机时定一次」的事，跟配置全文不是一个使用频率。 */
    function WorkspaceCard({ saveCfg, toast, numbered = true }) {
      const [ws, setWs] = useState(null)
      const [dir, setDir] = useState('')
      const [name, setName] = useState('')
      const [busy, setBusy] = useState(false)

      const load = async () => {
        const r = await get('/workspace')
        if (r.ok === false) return toast(r.message || '读不到工作区')
        setWs(r)
        setDir(r.configured?.dir || '')
        /** 没保存过名字时，向导里预填默认名；点保存才写进配置 */
        setName(r.configured?.name || DEFAULT_WORKSPACE_TITLE)
      }
      useEffect(() => { load() }, [])

      const run = async (fn) => {
        setBusy(true)
        try { await fn() } finally { setBusy(false) }
      }

      return h(Sec, {
        n: numbered ? '01' : null,
        title: '工作区',
        right: h('span', { className: 'roost-note', style: { margin: 0 } }, ws?.current?.title || ''),
      },
        h('div', { className: 'roost-note', style: { marginTop: 2 } },
          ws?.current
            ? `当前：${ws.current.title || '(未命名)'} · ${ws.current.path}`
            : '还没有工作区（下一条消息会创建）'),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('input', {
            className: 'roost-input', value: dir,
            placeholder: '目录（留空=数据目录/workspace；__default__=DSH 默认）',
            style: { flex: '1 1 280px' },
            onChange: (e) => setDir(e.target.value),
          }),
          h('input', {
            className: 'roost-input', value: name, placeholder: `名字（留空=${DEFAULT_WORKSPACE_TITLE}）`,
            style: { flex: '0 1 180px' },
            onChange: (e) => setName(e.target.value),
          }),
        ),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button', className: 'roost-primary', disabled: busy,
            onClick: () => run(async () => {
              const r = await saveCfg({ workspace: { dir, name } })
              if (r.ok === false) return toast(r.message || '没存上')
              toast('工作区设置已保存（下一条消息生效）')
              await load()
            }),
          }, '保存'),
          h('button', {
            type: 'button', className: 'roost-btn', disabled: busy || !ws?.current,
            onClick: () => run(async () => {
              const r = await post('/workspace/rename', { title: name.trim() || DEFAULT_WORKSPACE_TITLE })
              if (r.ok === false) return toast(r.message || '没改成')
              toast('工作区已改名')
              await load()
            }),
          }, '改名'),
        ),
        h('div', { className: 'roost-note', style: { marginTop: 6 } },
          `第一次创建时默认叫「${DEFAULT_WORKSPACE_TITLE}」；之后你自己改过的名字不会被覆盖。`
          + '换目录只影响之后新建的会话；已经在跑的会话仍挂在旧工作区。'),
      )
    }

    /**
     * 语音合成（TTS）设置卡片。
     *
     * 为什么不再让用户去「配置全文」里手改 JSON：`tts` 段有十几个字段，
     * 其中一半只在某个 provider 下才有意义。手改的代价是拼错一个键就静默失效
     * （`pruneTo` 会把它裁掉），用户只会看到「开了但没声音」。
     *
     * 状态一律问服务端（`/tts-status`）：必填项判定、本地引擎和模型在不在，
     * 都只有 `src/tts.js` 说了算。前端自己算一份必然漂移。
     */
    function TtsCard({ config, saveCfg, toast, reload }) {
      const cfgTts = config?.tts || {}
      const cfgJson = JSON.stringify(cfgTts)
      const [st, setSt] = useState(null)
      const [draft, setDraft] = useState(cfgTts)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      /** 正在点「一键安装」的那一下，防止连点两次 */
      const [installing, setInstalling] = useState(false)

      const loadStatus = async () => {
        const r = await get('/tts-status')
        setSt(r.ok === false ? null : r)
      }
      useEffect(() => { loadStatus() }, [])
      /**
       * 安装中每秒刷一次。
       *
       * 只在**真的在装**的时候轮询：平时这个页面不需要高频请求，
       * 而安装是几十 MB 的下载，用户要看到数字在动。
       */
      const installRunning = st?.install?.running === true
      useEffect(() => {
        if (!installRunning) return undefined
        const timer = setInterval(loadStatus, 1000)
        return () => clearInterval(timer)
      }, [installRunning])

      /** GPT-SoVITS 的进程状态（来自 `/tts-status` 的 `gpt` 字段） */
      const [probeInfo, setProbeInfo] = useState(null)
      const gptPhase = st?.gpt?.phase || 'idle'
      const gptStarting = gptPhase === 'starting'
      const gptRunning = gptPhase === 'running'

      /** 启动中每秒刷一次：加载模型要一两分钟，用户得看见它在动 */
      useEffect(() => {
        if (!gptStarting) return undefined
        const timer = setInterval(loadStatus, 1000)
        return () => clearInterval(timer)
      }, [gptStarting])

      /**
       * 从「启动中」翻到「运行中」的那一刻刷新配置。
       *
       * 地址和路由是**后端**在就绪回调里写进配置的，前端手里的 config 还是旧的；
       * 不刷一下，用户会看到「服务在跑，但地址栏还是空的」。
       */
      const prevGptPhase = useRef('')
      useEffect(() => {
        if (prevGptPhase.current === 'starting' && gptPhase === 'running') {
          toast('已启动，地址和路由已自动填好')
          reload?.()
        }
        prevGptPhase.current = gptPhase
      }, [gptPhase])

      const gptStatusText = (() => {
        const g = st?.gpt
        if (!g || g.phase === 'idle') return ''
        if (g.phase === 'starting') return `启动中… 端口 ${g.port || '待定'}，加载模型要一两分钟`
        if (g.phase === 'running') {
          /** 把「实际生效的角色」摆出来——切换失败时它和用户选的不是同一个 */
          return `运行中：${g.baseUrl}（pid ${g.pid}）`
            + (g.activeModel ? ` · 实际生效角色「${g.activeModel}」` : '')
        }
        if (g.phase === 'stopped') return '已停止'
        if (g.phase === 'error') return '启动失败：' + (g.error || '未知原因')
        return ''
      })()
      /** 权重没切过去：服务能出声但音色不对，必须单独用醒目的一行说出来 */
      const gptWarning = String(st?.gpt?.warning || '')
      /** 外部配置变了（比如刚在配置全文里保存）：没动过草稿就跟上 */
      useEffect(() => {
        if (dirty) return
        setDraft(JSON.parse(cfgJson))
      }, [cfgJson, dirty])

      const v = (path, fallback = '') => {
        const got = getPath(draft || {}, path)
        return got === undefined || got === null ? fallback : got
      }
      const put = (path, value) => {
        setDraft((d) => setPath(d || {}, path, value))
        setDirty(true)
      }

      const provider = v('provider', 'openai')
      /**
       * MiMo 的音色下拉要**保住手填值**。
       *
       * `voiceclone` 模型允许填音频样本、也允许填清单外的新音色；直接把
       * `mimo.voice` 硬设成清单里的第一项，用户手填的值会在下一次渲染时
       * 被下拉框悄悄改掉。
       */
      const mimoVoice = String(v('mimo.voice') || 'mimo_default')
      /**
       * 用对象而不是「值 + 文字」的二元数组。
       *
       * 设置页那段「各段是干什么的」的清单是靠正则从 `JSON_SECTIONS` 里读出来的，
       * 它扫的是 `JSON_SECTIONS` 到 `ConfigTab` 之间的所有二元数组字面量。
       * 这里再写一堆，会把 `v1` / `v2` 这类取值混进「配置段」里，
       * 让对齐测试误报。对象写法没有这个歧义。
       */
      const PROVIDERS = [
        { id: 'edge', label: '微软在线朗读（免费 · 不用 Key · 一键配好）' },
        { id: 'sherpa', label: '本地模型（离线，可一键安装）' },
        { id: 'openai', label: 'OpenAI 兼容（/audio/speech）' },
        { id: 'gpt-sovits', label: 'GPT-SoVITS 原生 API（本地）' },
        { id: 'mimo', label: '小米 MiMo（chat/completions 出音频）' },
      ]

      /**
       * 微软音色清单。
       *
       * 和 `src/tts.js` 的 `EDGE_VOICES` 是同一份（客户端不能 import 服务端模块）。
       * 一样用**对象**而不是 `[值, 文字]` 二元数组：设置页的对齐测试会扫
       * `JSON_SECTIONS` 到 `ConfigTab` 之间的所有二元数组字面量，
       * 写二元数组会把音色名误当成「配置段」报缺失。
       */
      const EDGE_VOICES = [
        { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 普通话女声（默认）' },
        { id: 'zh-CN-YunxiNeural', label: '云希 · 普通话男声' },
        { id: 'zh-CN-YunjianNeural', label: '云健 · 普通话男声（沉稳）' },
        { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 普通话女声（轻快）' },
        { id: 'zh-CN-YunyangNeural', label: '云扬 · 普通话男声（播报）' },
        { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话女声' },
        { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声' },
        { id: 'ja-JP-NanamiNeural', label: 'Nanami · 日语女声' },
        { id: 'en-US-JennyNeural', label: 'Jenny · 英语女声' },
      ]

      /**
       * 小米 MiMo 的预置音色。
       *
       * 和 `src/tts.js` 的 `MIMO_VOICES` 是同一份（客户端不能 import 服务端模块）。
       * 服务端**不**按这张表校验：`voiceclone` 模型还接受音频样本，
       * 写死白名单会把那条路堵死。
       */
      const MIMO_VOICES = [
        { id: 'mimo_default', label: 'MiMo 默认' },
        { id: '冰糖', label: '冰糖' },
        { id: '茉莉', label: '茉莉' },
        { id: '苏打', label: '苏打' },
        { id: '白桦', label: '白桦' },
        { id: 'Mia', label: 'Mia' },
        { id: 'Chloe', label: 'Chloe' },
        { id: 'Milo', label: 'Milo' },
        { id: 'Dean', label: 'Dean' },
      ]

      /** 服务端状态翻成人话。`reason` 的取值来自 `src/tts.js` 的 status() */
      const reasonText = (() => {
        /**
         * 状态还没回来时**先用配置里的开关**，不要显示「读不到状态」——
         * 那句话只在插件真的没响应时才该出现，正常打开页面会闪一下很难看。
         */
        if (!st) return cfgTts.enabled === true ? '已启用' : '未启用'
        if (st.enabled !== true) return '未启用'
        if (st.configured === true) return '已启用，配置齐全'
        if (st.reason === 'configuration_incomplete') return '已启用，但必填项还没填完'
        /** edge 和 sherpa 都会报 runtime_missing，文案别写死「本地引擎」 */
        if (st.reason === 'runtime_missing') return '已启用，但依赖没装（点下面一键安装）'
        if (st.reason === 'model_missing') return '已启用，但模型文件不全'
        if (st.reason === 'upstream_unreachable') return '已启用，但语音服务刚失败过（检查服务是否启动）'
        if (st.reason === 'unsupported_provider') return '已启用，但 provider 不认识'
        return '已启用，状态未知'
      })()

      /**
       * 「一键配好」：启用 + 切到微软朗读 + 填默认音色，一次保存。
       *
       * 不填地址、不填 Key 是这个 provider 的全部意义——用户要做的只剩
       * 点一下安装依赖，然后选个音色。
       */
      const oneKeyEdge = () => save({
        enabled: true,
        provider: 'edge',
        edge: { voice: v('edge.voice') || 'zh-CN-XiaoxiaoNeural' },
      })

      /** 一键装微软朗读的三个纯 JS 包（约 0.4MB），进度走 st.install 轮询 */
      const installEdge = async () => {
        const r = await post('/tts/edge-install', {})
        if (r?.ok === false) toast(r.message || '装不上')
        else toast('开始下载，几秒就好')
        await loadStatus()
      }

      /** 认一下目录：只读探测，填错了当场知道，不用等启动失败 */
      const probeGpt = async () => {
        const r = await post('/tts/gpt-probe', { dir: v('gptSovits.installDir') })
        setProbeInfo(r)
        toast(r?.ok ? '目录认出来了' : (r?.message || '这个目录不像 GPT-SoVITS 的根目录'))
      }

      const startGpt = async () => {
        const r = await post('/tts/gpt-start', {
          dir: v('gptSovits.installDir'),
          /** 选了角色就让它启动后切过去；空 = 用配置文件里已经加载的 */
          model: v('gptSovits.model'),
          /** 手填的权重路径优先于自动配对；留空 = 用扫描结果 */
          gptWeights: v('gptSovits.gptWeights'),
          sovitsWeights: v('gptSovits.sovitsWeights'),
        })
        if (r?.ok === false) toast(r.message || '起不来')
        else toast('正在启动，加载模型要一两分钟')
        await loadStatus()
      }

      const stopGpt = async () => {
        await post('/tts/gpt-stop', {})
        toast('已停止')
        await loadStatus()
      }

      /**
       * 一键安装本地引擎 + 模型。
       *
       * 请求**立刻返回**，不在这里等下载：30MB 模型加 23MB 引擎，等完
       * 请求早超时了。进度靠 `st.install` 轮询。
       */
      const install = async () => {
        setInstalling(true)
        try {
          const r = await post('/tts/install', { model: v('sherpa.model', 'aishell3') })
          if (r?.ok === false) toast(r.message || '装不上')
          else toast('开始下载，进度在下面')
          await loadStatus()
        } finally {
          setInstalling(false)
        }
      }

      const cancelInstall = async () => {
        const r = await post('/tts/install-cancel', {})
        if (r?.ok === false) toast(r.message || '没有在装')
        await loadStatus()
      }

      /** 卸载会删掉下载好的引擎和模型（几十 MB），用面板自己的弹窗问一句。 */
      const [confirmUninstall, setConfirmUninstall] = useState(false)
      const [uninstalling, setUninstalling] = useState(false)
      const uninstall = async () => {
        setUninstalling(true)
        try {
          const r = await post('/tts/uninstall', { model: v('sherpa.model', 'aishell3') })
          if (r?.ok === false) toast(r.message || '卸载失败')
          else toast('已卸载')
          await loadStatus()
        } finally {
          setUninstalling(false)
          setConfirmUninstall(false)
        }
      }

      /**
       * 5.3 试听：整份草稿（含未保存改动）直接交给后端，不用先点保存。
       * 音频只在浏览器内存里拼成 Blob URL，不写盘、不占次数；换一段试听
       * 时把上一个 URL 回收，免得几十段音频一直占着内存。
       */
      const [pvText, setPvText] = useState('你好，这是一条语音试听。')
      const [pvBusy, setPvBusy] = useState(false)
      const [pvAudio, setPvAudio] = useState(null)
      const pvUrl = useRef('')
      useEffect(() => () => {
        if (pvUrl.current) URL.revokeObjectURL(pvUrl.current)
      }, [])
      const previewVoice = async () => {
        const t = String(pvText || '').trim()
        if (!t) return toast('写一句要试听的话')
        setPvBusy(true)
        try {
          const r = await post('/tts/preview', { text: t, draft: draft || {} })
          if (r?.ok === false) return toast(r.message || '试听失败')
          const bin = atob(String(r.audio || ''))
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          if (pvUrl.current) URL.revokeObjectURL(pvUrl.current)
          const url = URL.createObjectURL(new Blob([bytes], { type: r.contentType || 'audio/mpeg' }))
          pvUrl.current = url
          setPvAudio({
            url, bytes: Number(r.bytes) || bytes.length,
            provider: String(r.provider || ''),
            silk: r.silk || { ok: false, reason: 'unchecked' },
          })
        } catch (e) {
          toast('试听失败：' + (e?.message || e))
        } finally {
          setPvBusy(false)
        }
      }

      /**
       * 保存。`override` 给「一键配好」用：按钮要一次写入多个字段，
       * 而 `put()` 走的是 setState，紧接着读 `draft` 还是旧值——
       * 不能靠连续三次 put 再 save。
       */
      const save = async (override = null) => {
        /**
         * 配置还没读到就**不许保存**。
         *
         * 少了这一道：`config` 为 null 时 `draft` 是空对象，点保存提交的 `tts`
         * 只剩 `timeoutSec / maxChars / speed` 三个默认值。patch 语义下
         * `provider / voice / enabled` 能保住，但这仍然是在**空数据上操作**——
         * 用户看到的是「语音合成：未启用」，实际可能开着。
         * 页签预拉是第一道，这里是最后一道。
         */
        if (!config) return toast('配置还没读到，稍等一下再保存')
        setBusy(true)
        try {
          const src = override ? { ...(draft || {}), ...override } : draft
          /**
           * 数字字段要在这里转回 number。
           * 输入框给的永远是字符串，直接存进去 `Number(cfg.timeoutSec)` 虽然也能用，
           * 但配置全文里会变成 `"30"`，和默认值的类型不一致，看的人会以为坏了。
           */
          const next = {
            ...src,
            timeoutSec: Number(src?.timeoutSec) || 30,
            maxChars: Number(src?.maxChars) || 300,
            /** 语速夹在 0.5–2，和 `speedOf()` 同一套范围；空值回原速 */
            speed: Math.max(0.5, Math.min(2, Number(src?.speed) || 1)),
            ...(src?.sherpa
              ? {
                  sherpa: {
                    ...src.sherpa,
                    sid: Number(src.sherpa.sid) || 0,
                    numThreads: Number(src.sherpa.numThreads) || 2,
                  },
                }
              : {}),
          }
          const r = await saveCfg({ tts: next })
          if (r?.ok === false) return toast(r.message || '没存上')
          setDirty(false)
          toast(r?.message || '语音设置已保存（下一轮生效）')
          await loadStatus()
          reload?.()
        } finally {
          setBusy(false)
        }
      }

      const field = (label, path, opts = {}) =>
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: opts.flex || '1 1 240px' } },
          h('span', { className: 'roost-note', style: { margin: 0 } }, label),
          h('input', {
            className: 'roost-input',
            type: opts.type || 'text',
            value: v(path),
            placeholder: opts.placeholder || '',
            spellCheck: false,
            onChange: (e) => put(path, e.target.value),
          }),
        )

      const select = (label, path, options) =>
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' } },
          h('span', { className: 'roost-note', style: { margin: 0 } }, label),
          h('select', {
            className: 'roost-input',
            value: v(path),
            onChange: (e) => put(path, e.target.value),
          }, options.map((o) => h('option', { key: o.id, value: o.id }, o.label))),
        )

      /** 只取文件名，下拉里显示全路径会撑爆 */
      const shortName = (p) => String(p || '').split(/[\\/]/).pop()

      /**
       * 参考音频的选项：扫描到的候选 + 当前值。
       *
       * 把当前值也塞进去是为了「用户手填了一个不在候选里的路径」时
       * 下拉不会变成空白——否则一保存就把他的路径清掉了。
       */
      const refPath = String(v('gptSovits.referWavPath') || '')
      const refOptions = [...new Set([
        ...(probeInfo?.refCandidates || []),
        ...(refPath ? [refPath] : []),
      ])]

      return h(Sec, {
        n: '01',
        title: '语音合成',
        right: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('span', { className: 'roost-note', style: { margin: 0 } }, reasonText),
          h('button', {
            type: 'button', className: 'roost-primary', disabled: busy || !dirty,
            title: dirty ? '' : '没有改动',
            onClick: () => save(),
          }, busy ? '保存中…' : '保存'),
        ),
      },
        h('div', { className: 'roost-note', style: { marginTop: 2 } },
          '默认关闭。开启后，模型可以用 <<say: 内容>> 让这句话变成语音条；'
          + '合成在这里做，转成 QQ 要的 silk 和发送由框架外接协议完成。'),
        dirty
          ? h('div', { className: 'roost-note', style: { color: 'var(--warn, #b8860b)' } },
              '有未保存的改动。')
          : null,

        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' } },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
              h(Switch, {
                on: draft?.enabled === true,
                label: '启用',
                onToggle: (next) => put('enabled', next),
              }),
            '启用语音合成'),
          select('provider', 'provider', PROVIDERS),
          /**
           * 语速放在 provider 旁边，**四个 provider 共用这一个**。
           * 以前只有本地模型有语速，而且输入框埋在它自己的分区里——
           * 切到云端之后那个框还在，改了却完全没反应。
           */
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '0 0 110px' } },
            h('span', { className: 'roost-note', style: { margin: 0 } }, '语速（0.5–2）'),
            h('input', {
              className: 'roost-input', type: 'number', step: '0.1', min: '0.5', max: '2',
              value: v('speed', 1),
              onChange: (e) => put('speed', e.target.value),
            }),
          ),
        ),

        provider === 'openai'
          ? h('div', null,
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('接口地址（含版本前缀）', 'baseUrl', { placeholder: 'https://api.openai.com/v1' }),
                field('模型', 'model', { placeholder: 'tts-1' }),
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('音色', 'voice', { placeholder: 'alloy' }),
                field('API Key', 'apiKey', { placeholder: '留空表示不需要' }),
              ),
              h('div', { className: 'roost-note' },
                '走 OpenAI 兼容的 POST /audio/speech，固定请求 mp3。'
                + '硅基流动、one-api 这类中转也填这里。'),
            )
          : null,

        provider === 'edge'
          ? h('div', null,
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' } },
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 260px' } },
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '音色'),
                  h('select', {
                    className: 'roost-input',
                    value: v('edge.voice') || 'zh-CN-XiaoxiaoNeural',
                    onChange: (e) => put('edge.voice', e.target.value),
                  }, EDGE_VOICES.map((o) => h('option', { key: o.id, value: o.id }, o.label))),
                ),
                h('button', {
                  type: 'button', className: 'roost-primary', disabled: busy,
                  onClick: oneKeyEdge,
                }, '一键配好'),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  disabled: st?.install?.running === true,
                  onClick: installEdge,
                }, st?.edgeInstalled ? '重装依赖' : '一键安装依赖'),
              ),

              st?.install?.running
                ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
                    `${st.install.message || '安装中…'}${st.install.percent ? ` · ${st.install.percent}%` : ''}`)
                : null,

              h('div', { className: 'roost-note' },
                '免费、不用 API Key，装好依赖选个音色就能用；输出 mp3，宿主自己转 silk。'),
              h('div', { className: 'roost-note', style: { color: 'var(--warn, #b8860b)' } },
                '注意：要念的文本会发到微软的服务器。介意隐私就换「本地模型」，那个完全离线。',
                '依赖 @andresaya/edge-tts 是 GPL-3.0，只下载到你自己的数据目录，不随插件分发。'),
            )
          : null,

        provider === 'gpt-sovits'
          ? h('div', null,
              /**
               * 目录 + 一键启动。
               *
               * 这一段存在的理由：起 GPT-SoVITS 的 API 有四个坑，每个都能
               * 让人卡半小时——要 cd 到安装目录、要认 runtime\python.exe、
               * 要挑一个**没被 Windows 保留**的端口（9880 就绑不上）、
               * 起来以后还得把地址和路由抄回配置。全部收进这里。
               */
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' } },
                field('安装目录（含 api_v2.py 的那层）', 'gptSovits.installDir', {
                  placeholder: 'D:\\GPT-SoVITS',
                  flex: '2 1 380px',
                }),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 2 } },
                  h('button', { type: 'button', className: 'roost-btn', onClick: probeGpt }, '探测'),
                  gptRunning || gptStarting
                    ? h('button', { type: 'button', className: 'roost-btn', onClick: stopGpt }, '停止')
                    : h('button', {
                        type: 'button', className: 'roost-primary', disabled: !v('gptSovits.installDir'),
                        onClick: startGpt,
                      }, '一键启动'),
                ),
              ),

              /** 探测结果：认出了什么，一眼看明白 */
              probeInfo
                ? probeInfo.ok
                  ? h('div', { className: 'roost-note', style: { color: 'var(--good, #2e7d32)', marginTop: 6 } },
                      `✓ ${probeInfo.apiVersion === 'v2' ? 'v2（接口 /tts）' : 'v1（接口 /）'}`
                      + ` · ${probeInfo.weightVersion || '未读出版本'}`
                      + (probeInfo.character ? ` · 当前角色「${probeInfo.character}」` : '')
                      + (probeInfo.refCandidates?.length ? ` · 参考音频候选 ${probeInfo.refCandidates.length} 个` : ''),
                    )
                  : h('div', { className: 'roost-note', style: { color: 'var(--bad)', marginTop: 6 } },
                      '✗ ' + (probeInfo.message || '这个目录不像 GPT-SoVITS 的根目录'))
                : null,

              /** 进程状态 */
              gptStatusText
                ? h('div', { className: 'roost-note', style: { marginTop: 6 } }, gptStatusText)
                : null,

              /**
               * 权重没切过去是最容易误判的一种状态：服务在跑、音频正常返回，
               * 只是音色是另一个模型的。不单独用醒目的一行说出来，
               * 用户只会以为「模型训练坏了」。
               */
              gptWarning
                ? h('div', { className: 'roost-note', style: { color: 'var(--bad)', marginTop: 6 } }, '⚠ ' + gptWarning)
                : null,

              /**
               * 扫描结果做成下拉。
               *
               * 用户不用知道「GPT_weights_v2ProPlus/角色A-e15.ckpt」这种路径，
               * 只要在下拉里选「角色A」——启动后宿主会调 `/set_*_weights`
               * 切过去，**不改 tts_infer.yaml**。
               */
              probeInfo?.ok && probeInfo.models?.length
                ? h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                    select('角色（扫描到的权重）', 'gptSovits.model', [
                      { id: '', label: probeInfo.character ? `用配置文件里的（${probeInfo.character}）` : '用配置文件里的' },
                      ...probeInfo.models.map((m) => ({
                        id: m.name,
                        label: m.name + (m.version ? ` · ${m.version}` : ''),
                      })),
                    ]),
                    refOptions.length
                      ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' } },
                          h('span', { className: 'roost-note', style: { margin: 0 } }, `参考音频（扫描到 ${refOptions.length} 个）`),
                          h('select', {
                            className: 'roost-input',
                            value: refPath,
                            onChange: (e) => put('gptSovits.referWavPath', e.target.value),
                          },
                            h('option', { value: '' }, '（未选）'),
                            ...refOptions.map((p) => h('option', { key: p, value: p }, shortName(p))),
                          ),
                        )
                      : null,
                  )
                : null,

              /**
               * 手动权重路径：**优先于**上面的自动配对。
               *
               * `scanModels()` 靠文件名猜角色名，权重一多很容易把不同 epoch、
               * 不同角色的 GPT / SoVITS 配错一对——能出声，但音色完全不是
               * 自己训的那个。留空就用扫描结果，填了就以这里为准。
               */
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('GPT 权重路径（可选，填了优先）', 'gptSovits.gptWeights', {
                  placeholder: 'D:\\GPT-SoVITS\\GPT_weights_v2\\角色-e15.ckpt',
                  flex: '1 1 300px',
                }),
                field('SoVITS 权重路径（可选，填了优先）', 'gptSovits.sovitsWeights', {
                  placeholder: 'D:\\GPT-SoVITS\\SoVITS_weights_v2\\角色_e8_s200.pth',
                  flex: '1 1 300px',
                }),
              ),
              h('div', { className: 'roost-note' },
                '路径要填 GPT-SoVITS 服务进程能读到的（绝对路径最稳）。',
                '两个都留空 = 按角色名自动配对；音色不对时优先改成手填，',
                '另外参考音频也要和这个模型配套，音色主要由它决定。'),

              /** 日志尾部：启动失败时这是唯一能看出原因的东西 */
              st?.gpt?.logs?.length
                ? h('pre', {
                    style: {
                      marginTop: 6, maxHeight: 140, overflow: 'auto', fontSize: 11, lineHeight: 1.5,
                      padding: '6px 8px', borderRadius: 4,
                      background: 'var(--panel, rgba(128,128,128,.12))',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    },
                  }, st.gpt.logs.join('\n'))
                : null,

              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('服务地址', 'gptSovits.baseUrl', { placeholder: 'http://127.0.0.1:17860/' }),
                field('参考音频路径', 'gptSovits.referWavPath', { placeholder: 'GPT-SoVITS 那台机器上的路径' }),
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('参考文本（须与音频逐字一致）', 'gptSovits.promptText', { flex: '2 1 320px' }),
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('参考音频语种', 'gptSovits.promptLanguage', { placeholder: '中文 / 日文 / 英文' }),
                field('合成文本语种', 'gptSovits.textLanguage', { placeholder: '中文 / 日文 / 英文' }),
                select('接口版本', 'gptSovits.apiVersion', [
                  { id: 'v1', label: 'v1（api.py）' },
                  { id: 'v2', label: 'v2（api_v2.py）' },
                ]),
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('接口路由', 'gptSovits.endpointPath', { placeholder: '/tts' }),
                field('Bearer 密钥（可选）', 'gptSovits.apiKey', { placeholder: '本地原生 API 通常留空' }),
              ),
              h('div', { className: 'roost-note' },
                '语种填「中文」「日文」就行，会自动转成 API 要的 zh / ja。'
                + '参考音频路径是「GPT-SoVITS 服务进程」要能读到的路径，不是 DSH 这边的。'
                + '一键启动会自动挑一个没被系统保留的端口，就绪后把地址和路由填好——'
                + '加载模型要一两分钟，这期间可以先干别的。'),
            )
          : null,

        provider === 'mimo'
          ? h('div', null,
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('接口地址（含版本前缀）', 'mimo.baseUrl', { placeholder: 'https://api.xiaomimimo.com/v1' }),
                field('模型', 'mimo.model', { placeholder: 'mimo-v2.5-tts' }),
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' } },
                h('label', { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px' } },
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '音色'),
                  h('select', {
                    className: 'roost-input',
                    value: mimoVoice,
                    onChange: (e) => put('mimo.voice', e.target.value),
                  }, [
                    ...MIMO_VOICES,
                    ...(MIMO_VOICES.some((o) => o.id === mimoVoice)
                      ? []
                      : [{ id: mimoVoice, label: `${mimoVoice}（手填）` }]),
                  ].map((o) => h('option', { key: o.id, value: o.id }, o.label))),
                ),
                field('API Key', 'mimo.apiKey', { placeholder: '必填，sk-…' }),
              ),
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('语气提示', 'mimo.prompt', {
                  placeholder: '请用自然、亲切的语气朗读下面这句话。',
                  flex: '2 1 320px',
                }),
              ),
              h('div', { className: 'roost-note' },
                'MiMo 没有 /audio/speech：走 POST /chat/completions，'
                + '要念的文本放在 assistant 那条消息里，音频以 base64 回在 message.audio.data。'
                + '因此它不支持语速——上面那个「语速」对 MiMo 无效。'),
            )
          : null,

        provider === 'sherpa'
          ? h('div', null,
              /**
               * 模型 + 安装按钮同一行。
               *
               * 安装状态全部来自 `/tts-status` 的 `install` 字段，前端不自己
               * 记「点了没点」——记了就会出现「页面刷新后按钮变回一键安装，
               * 但其实还在下」。
               */
              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, alignItems: 'flex-end' } },
                select('模型', 'sherpa.model',
                  (st?.models?.length ? st.models : [{ id: 'aishell3', label: 'aishell3' }])
                    .map((m) => ({ id: m.id, label: m.label }))),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', paddingBottom: 2 } },
                  h('button', {
                    type: 'button',
                    className: 'roost-primary',
                    disabled: installing || installRunning,
                    onClick: install,
                  }, installRunning ? '安装中…' : (st?.configured ? '重新安装' : '一键安装')),
                  installRunning
                    ? h('button', { type: 'button', className: 'roost-btn', onClick: cancelInstall }, '取消')
                    : null,
                  !installRunning && st?.usage?.total > 0
                    ? h('button', { type: 'button', className: 'roost-btn', onClick: () => setConfirmUninstall(true) }, '卸载')
                    : null,
                ),
              ),

              installRunning
                ? h('div', { style: { marginTop: 8 } },
                    h('div', { className: 'roost-note', style: { margin: 0 } },
                      st.install.message
                      + (st.install.total > 0
                        ? ` ${(st.install.received / 1048576).toFixed(1)} / ${(st.install.total / 1048576).toFixed(1)} MB（${st.install.percent}%）`
                        : '')),
                    h('div', {
                      style: {
                        height: 6, marginTop: 4, borderRadius: 3, overflow: 'hidden',
                        background: 'var(--line, rgba(128,128,128,.3))',
                      },
                    }, h('div', {
                      style: {
                        width: `${st.install.percent}%`, height: '100%',
                        background: 'var(--good, #3b82f6)', transition: 'width .3s',
                      },
                    })),
                  )
                : null,

              st?.install?.phase === 'error' && st?.install?.error
                ? h('div', { className: 'roost-note', style: { color: 'var(--bad)', marginTop: 6 } },
                    '安装失败：' + st.install.error)
                : null,

              !installRunning && st?.usage?.total > 0
                ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
                    `已占用 ${(st.usage.total / 1048576).toFixed(1)} MB`
                    + `（引擎 ${(st.usage.engine / 1048576).toFixed(1)} MB + 模型 ${(st.usage.model / 1048576).toFixed(1)} MB）`)
                : null,

              h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
                field('说话人编号（aishell3 是 0-173）', 'sherpa.sid', { placeholder: '88' }),
                /** 语速已经统一到上面 provider 旁边那个框，这里不再重复 */
                field('线程数', 'sherpa.numThreads', { placeholder: '2' }),
              ),
              h('div', { className: 'roost-note' },
                '完全离线：模型装在本机，不联网、不要 Key。一键安装会下 23MB 引擎 + '
                + '30MB 模型（解压后一共约 230MB，其中多音字规则库 173MB），'
                + '装到数据目录（不是插件目录，DSH 更新插件不会冲掉）。'
                + '换说话人编号就是换音色，改完点上面的保存。'),
            )
          : null,

        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 } },
          field('超时（秒）', 'timeoutSec', { placeholder: '30' }),
          field('单次最多多少字', 'maxChars', { placeholder: '300' }),
        ),
        h('div', { className: 'roost-note' },
          '最多字数要配合 QQ 语音条时长：太长的会被截断，不如直接发文字。'),

        /**
         * 5.3 试听：不另起一张卡片（主人不要卡片背景），用一条分隔线接在本节末尾。
         * A3 保留这个形态，只补一个锚点，让「试听」能被找到、能被跳过来。
         */
        h('div', {
          id: 'roost-tts-preview',
          style: { borderTop: '1px solid var(--line-soft)', marginTop: 12, paddingTop: 10 },
        },
          h('div', { style: { fontWeight: 650, fontSize: 13 } }, '试听'),
          h('div', { className: 'roost-note', style: { marginTop: 4 } },
            '走和 QQ 语音条同一条合成链路，音频只在内存里，不落盘、不占次数；'
            + '改了配置不用先保存，点试听就按当前草稿来。'),
          h('div', {
            style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' },
          },
            h('input', {
              className: 'roost-input', style: { flex: '1 1 260px', minWidth: 180 },
              value: pvText, maxLength: 500, placeholder: '写一句要试听的话',
              onChange: (e) => setPvText(e.target.value),
            }),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: pvBusy,
              onClick: previewVoice,
            }, pvBusy ? '合成中…' : '试听'),
          ),
          dirty
            ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
                '当前用的是未保存的草稿配置。')
            : null,
          pvAudio
            ? h('div', { style: { marginTop: 8 } },
                h('audio', {
                  controls: true, autoPlay: true, src: pvAudio.url,
                  style: { width: '100%', maxWidth: 420 },
                }),
                h('div', { className: 'roost-note', style: { marginTop: 4 } },
                  `已合成 ${(pvAudio.bytes / 1024).toFixed(0)} KB`
                  + (pvAudio.provider ? ` · ${pvAudio.provider}` : '')
                  + (pvAudio.silk.ok
                      ? ` · SILK 校验通过${pvAudio.silk.size ? `（${pvAudio.silk.size} B）` : ''}`
                      : ` · SILK 未校验：${pvAudio.silk.message || pvAudio.silk.reason}`)),
              )
            : null,
        ),

        confirmUninstall
          ? h(ConfirmModal, {
              title: '卸载本地语音引擎',
              message: '会删掉已下载的本地语音引擎和模型（几十 MB）。\n下次要用得重新下载，确定吗？',
              confirmText: '卸载', danger: true, busy: uninstalling,
              onClose: () => { if (!uninstalling) setConfirmUninstall(false) },
              onConfirm: uninstall,
            })
          : null,
      )
    }

    /**
     * 表情包目录编辑器。
     *
     * 以前这里只有「复制目录」和一行只读文本：想换目录只能滚到「配置全文」手改
     * JSON，填错一个反斜杠就静默失效——`dir` 改了但读不到图，面板只显示 0 张。
     *
     * 两个必须做对的点：
     * ① **打不开的目录要标红**。路径填错时唯一的反馈如果只是「共 0 张」，用户
     *    没法区分「路径错了」和「目录真是空的」，只能去猜。
     * ② **保存形态按数量还原**：0 个 → `''`（回落默认），1 个 → 字符串，多个 → 数组。
     *    单一目录仍写字符串，是因为没必要因为支持了数组就把所有人的 config.json 都改成数组。
     */
    /**
     * 表情包目录。
     *
     * `n` 是分节编号：留在「表达」页时它是 02（排在语音后面）；
     * 2026-11-13 拆成独立页之后它是 01（一页就这一节）。
     */
    function StickerDirsCard({ config, stickers, saveCfg, toast, reload, n = '02' }) {
      /** 服务端 → 编辑态。老服务端只回 `dir` 一个字符串，也要能显示 */
      const fromServer = (s) => {
        const list = Array.isArray(s?.dirs) && s.dirs.length ? s.dirs : (s?.dir ? [s.dir] : [])
        return list.map((x) => String(x ?? '')).filter(Boolean)
      }

      const [paths, setPaths] = useState(() => fromServer(stickers))
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [syncOpen, setSyncOpen] = useState(false)

      /**
       * 偷表情的配置（`stickers.steal`）：总开关、范围、每小时上限、顺手起名。
       *
       * `capDraft` 单独存一份字符串：数字框每敲一个字符就 saveCfg 会把
       * 「20」→「2」的中间态也存进去，用户删完重打时等于一路在改配置。
       * 改成失焦才算一次。
       */
      const steal = config?.stickers?.steal || {}
      const [capDraft, setCapDraft] = useState(() => String(steal.maxPerHour ?? 20))
      useEffect(() => { setCapDraft(String(steal.maxPerHour ?? 20)) }, [steal.maxPerHour])

      /**
       * 贴表情（`stickers.post`）。三个数字都先存草稿、失焦才提交：
       * 「每天最多 3 次」里那个 3 改成 30 的过程中会经过「空 → 3 → 30」，
       * 每次按键都 saveCfg 等于在配置里跳一遍。
       *
       * 概率在界面上用百分比（25），存进配置是 0.25——用户不该看到小数。
       */
      /**
       * 名字刻意不叫 `post`：外层有个同名的请求函数（`post(path, body)`），
       * 这里再叫 `post` 会遮蔽它——以后在这个组件里加一个保存动作，
       * 报的错会是「post is not a function」，而且看着完全不像变量遮蔽。
       */
      const postCfg = config?.stickers?.post || {}
      const postDraftOf = (p) => ({
        maxPerDay: String(p.maxPerDay ?? 3),
        chance: String(Math.round((Number(p.chance) || 0) * 100)),
        minGapMinutes: String(p.minGapMinutes ?? 90),
      })
      const [postDraft, setPostDraft] = useState(() => postDraftOf(postCfg))
      useEffect(
        () => { setPostDraft(postDraftOf(config?.stickers?.post || {})) },
        [postCfg.maxPerDay, postCfg.chance, postCfg.minGapMinutes],
      )

      /** 「未分类」里有多少张：同步进来的图都先落这儿，提醒用户自己分类 */
      const uncat = (stickers?.categories || []).find((c) => c.name === '未分类')

      /**
       * 只在**服务端真的变了**（别处改过 / 保存后回填）时覆盖编辑框。
       *
       * 不用「!dirty 就跟上」那套：保存成功那一刻 dirty 刚清掉、而 reload 还没回来，
       * 编辑框会被服务端的旧值闪一下。比 sig 更直接。
       */
      const sig = JSON.stringify(fromServer(stickers))
      const lastSig = useRef(sig)
      useEffect(() => {
        if (sig === lastSig.current) return
        lastSig.current = sig
        setPaths(JSON.parse(sig))
        setDirty(false)
      }, [sig])

      /** 打不开的目录：后端 /stickers 的 `missing`。前端只负责标出来 */
      const missing = (stickers?.missing || []).map((x) => String(x).toLowerCase().replace(/[\\/]+$/, ''))
      const isMissing = (p) => {
        const s = String(p || '').trim().toLowerCase().replace(/[\\/]+$/, '')
        return !!s && missing.includes(s)
      }

      /** 去空串、去重（大小写不敏感，Windows 一个目录两种写法很常见） */
      const clean = () => {
        const out = []
        const seen = new Set()
        for (const p of paths) {
          const s = String(p ?? '').trim()
          if (!s) continue
          const k = s.toLowerCase()
          if (seen.has(k)) continue
          seen.add(k)
          out.push(s)
        }
        return out
      }

      const save = async () => {
        /**
         * 同理：`/stickers` 没读到时 `paths` 是空数组，保存会写入 `dir:''`，
         * 等于把用户真实配的目录**清空恢复默认**。空列表和「读不到」必须分开看。
         */
        if (!stickers) return toast('表情包配置还没读到，稍等一下再保存')
        const list = clean()
        setBusy(true)
        const r = await saveCfg({
          stickers: { dir: list.length === 0 ? '' : (list.length === 1 ? list[0] : list) },
        })
        setBusy(false)
        if (r?.ok === false) return toast(r.message || '没存上')
        setPaths(list)
        setDirty(false)
        toast(list.length === 0 ? '已恢复默认目录' : `已保存 ${list.length} 个目录`)
        // 张数、分类、字数都要重算，不刷的话上面还写着旧数字
        reload?.()
      }

      const copy = () => {
        const list = clean()
        const text = (list.length ? list : (stickers?.dir ? [stickers.dir] : [])).join('\n')
        try { navigator.clipboard?.writeText(text); toast(list.length > 1 ? '目录路径已复制（每行一个）' : '目录路径已复制') }
        catch { toast('复制失败，手动选一下吧') }
      }

      return h('div', null,
        h(Sec, {
        n,
        title: '表情包目录',
        right: h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 } },
            h(Switch, {
              on: config?.stickers?.enabled !== false,
              label: '启用表情包',
              onToggle: async (on) => {
                const r = await saveCfg({ stickers: { enabled: on } })
                toast(r?.ok === false ? (r.message || '没改成') : (on ? '表情包已开' : '表情包已关'))
                if (r?.ok !== false) reload?.()
              },
            }),
            '启用'),
          h('button', { type: 'button', className: 'roost-link', onClick: copy }, '复制目录'),
        ),
      },
        h('div', { className: 'roost-note' },
          '图片放进这些目录就会出现在清单里；每个目录的一级子目录算一个分类。'),
        paths.length === 0
          ? h('div', { className: 'roost-note' },
              `现在没配路径，用默认目录：${stickers?.dir || '（插件刚起来时会空几秒）'}`)
          : h('div', null,
              ...paths.map((p, i) => h('div', {
                key: i,
                style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' },
              },
                h('input', {
                  className: 'roost-input',
                  value: p,
                  placeholder: '例如 D:\\表情包',
                  spellCheck: false,
                  style: {
                    flex: '1 1 320px',
                    fontFamily: 'ui-monospace,Menlo,Consolas,monospace',
                    fontSize: 12,
                    ...(isMissing(p) ? { borderColor: 'var(--bad, #c0392b)' } : null),
                  },
                  onChange: (e) => {
                    const next = paths.slice()
                    next[i] = e.target.value
                    setPaths(next)
                    setDirty(true)
                  },
                }),
                isMissing(p)
                  ? h('span', { style: { color: 'var(--bad, #c0392b)', fontSize: 12, whiteSpace: 'nowrap' } }, '打不开')
                  : null,
                h('button', {
                  type: 'button', className: 'roost-link',
                  onClick: () => {
                    setPaths(paths.filter((_, j) => j !== i))
                    setDirty(true)
                  },
                }, '移除'),
              ))),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', {
            type: 'button', className: 'roost-btn',
            onClick: () => { setPaths([...paths, '']); setDirty(true) },
          }, '+ 添加目录'),
          h('button', {
            type: 'button', className: 'roost-primary',
            disabled: !dirty || busy,
            title: dirty ? '' : '没改动',
            onClick: save,
          }, '保存路径'),
          dirty ? h('span', { className: 'roost-note', style: { margin: 0 } }, '还没保存') : null,
          h('button', {
            type: 'button', className: 'roost-btn',
            onClick: () => setSyncOpen(true),
          }, '同步缓存图'),
        ),
        /**
         * 偷表情：聊天里别人发的图自动收进「未分类」。
         *
         * 放在这一页而不是图库页：它和「目录」是同一件事——都在决定
         * **库里的图从哪来**。图库页管「已有的图怎么整理」，这页管「怎么进来」。
         *
         * 原料就是「同步缓存图」看到的那个 `images/` 目录：图本来就会为
         * 「让模型看一眼」下到那里，这里只是多一步「顺手复制进库」。
         */
        h('div', {
          className: 'roost-note',
          style: {
            marginTop: 10, paddingTop: 10,
            borderTop: '1px solid rgba(128,128,128,.18)',
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          },
        },
          h(Switch, {
            on: steal.enabled !== false,
            label: '偷表情',
            onToggle: async (on) => {
              const r = await saveCfg({ stickers: { steal: { enabled: on } } })
              toast(r?.ok === false ? (r.message || '没改成') : (on ? '开始偷表情了' : '已停止偷表情'))
            },
          }),
          h('strong', null, '偷表情'),
          h('select', {
            className: 'roost-input',
            style: { width: 'auto', fontSize: 12 },
            value: steal.scope || 'all',
            onChange: async (e) => {
              const v = e.target.value
              const r = await saveCfg({ stickers: { steal: { scope: v } } })
              toast(r?.ok === false
                ? (r.message || '没改成')
                : (v === 'all' ? '群和私聊都收' : v === 'private' ? '只在私聊收' : '只在群里收'))
            },
          },
            h('option', { value: 'all' }, '群和私聊'),
            h('option', { value: 'private' }, '只私聊'),
            h('option', { value: 'group' }, '只在群'),
          ),
          h('span', { style: { fontSize: 12 } }, '每小时最多'),
          h('input', {
            className: 'roost-input', type: 'number', min: 1, max: 200,
            value: capDraft,
            style: { width: 64, fontSize: 12 },
            onChange: (e) => setCapDraft(e.target.value),
            onBlur: async () => {
              const n = Math.max(1, Math.min(200, Number(capDraft) || 20))
              setCapDraft(String(n))
              if (n === Number(steal.maxPerHour ?? 20)) return
              const r = await saveCfg({ stickers: { steal: { maxPerHour: n } } })
              toast(r?.ok === false ? (r.message || '没存上') : `每小时最多收 ${n} 张`)
            },
          }),
          h('span', { style: { fontSize: 12 } }, '张'),
          h('label', {
            style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' },
            title: '收进来就让她起名。每张一次模型调用，和上面的每小时上限是同一个数。',
          },
            h('input', {
              type: 'checkbox',
              checked: steal.autoOrganize === true,
              onChange: async (e) => {
                const on = e.target.checked
                const r = await saveCfg({ stickers: { steal: { autoOrganize: on } } })
                toast(r?.ok === false
                  ? (r.message || '没存上')
                  : (on ? '收进来就起名（每张一次模型调用）' : '收进来先堆着，你自己点整理'))
              },
            }),
            '顺手让 AI 起名'),
        ),
        h('div', { className: 'roost-note', style: { marginTop: 4 } },
          '只收当前这条消息里对方主动发的图，按尺寸挑（边长 1024 以内、长宽比 1.8 以内，5KB~1MB），'
          + '能切掉截图和壁纸。收进来的图落在「未分类」，文件名以「偷_」开头，侧车记着是哪个会话。'),
        h('div', { className: 'roost-note', style: { marginTop: 2 } },
          '前提：她得先「看图」才会把图下到本地——「接入」页的图片上限设成 0，偷表情就一张也收不到。'),
        /**
         * 贴表情：她主动发一张图。
         *
         * 这是唯一「没人问她、她自己往外发图」的行为，所以默认关、只发私聊。
         * 三个数字都用草稿 + 失焦提交，理由见上面 `postDraft` 的注释。
         */
        h('div', {
          className: 'roost-note',
          style: {
            marginTop: 10, paddingTop: 10,
            borderTop: '1px solid rgba(128,128,128,.18)',
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
          },
        },
          h(Switch, {
            on: postCfg.enabled === true,
            label: '贴表情',
            onToggle: async (on) => {
              const r = await saveCfg({ stickers: { post: { enabled: on } } })
              toast(r?.ok === false ? (r.message || '没改成') : (on ? '她会主动贴图了（只发私聊）' : '已停止贴表情'))
            },
          }),
          h('strong', null, '贴表情'),
          h('span', { style: { fontSize: 12 } }, '每天'),
          h('input', {
            className: 'roost-input', type: 'number', min: 1, max: 20,
            value: postDraft.maxPerDay,
            style: { width: 56, fontSize: 12 },
            onChange: (e) => setPostDraft({ ...postDraft, maxPerDay: e.target.value }),
            onBlur: async () => {
              const n = Math.max(1, Math.min(20, Number(postDraft.maxPerDay) || 3))
              setPostDraft((d) => ({ ...d, maxPerDay: String(n) }))
              if (n === Number(postCfg.maxPerDay ?? 3)) return
              const r = await saveCfg({ stickers: { post: { maxPerDay: n } } })
              toast(r?.ok === false ? (r.message || '没存上') : `每天最多贴 ${n} 次`)
            },
          }),
          h('span', { style: { fontSize: 12 } }, '次 · 命中'),
          h('input', {
            className: 'roost-input', type: 'number', min: 1, max: 100,
            value: postDraft.chance,
            style: { width: 56, fontSize: 12 },
            onChange: (e) => setPostDraft({ ...postDraft, chance: e.target.value }),
            onBlur: async () => {
              const n = Math.max(1, Math.min(100, Number(postDraft.chance) || 25))
              setPostDraft((d) => ({ ...d, chance: String(n) }))
              if (n === Math.round((Number(postCfg.chance) || 0) * 100)) return
              const r = await saveCfg({ stickers: { post: { chance: n / 100 } } })
              toast(r?.ok === false ? (r.message || '没存上') : `每次命中 ${n}%`)
            },
          }),
          h('span', { style: { fontSize: 12 } }, '% · 至少隔'),
          h('input', {
            className: 'roost-input', type: 'number', min: 5, max: 1440,
            value: postDraft.minGapMinutes,
            style: { width: 64, fontSize: 12 },
            onChange: (e) => setPostDraft({ ...postDraft, minGapMinutes: e.target.value }),
            onBlur: async () => {
              const n = Math.max(5, Math.min(1440, Number(postDraft.minGapMinutes) || 90))
              setPostDraft((d) => ({ ...d, minGapMinutes: String(n) }))
              if (n === Number(postCfg.minGapMinutes ?? 90)) return
              const r = await saveCfg({ stickers: { post: { minGapMinutes: n } } })
              toast(r?.ok === false ? (r.message || '没存上') : `两次至少隔 ${n} 分钟`)
            },
          }),
          h('span', { style: { fontSize: 12 } }, '分钟'),
        ),
        h('div', { className: 'roost-note', style: { marginTop: 4 } },
          postCfg.enabled === true && !config?.speakUp?.chatId
            ? '还差一步：这个开关只往「主人私聊」发，去「主动搭话」里填上 chatId，否则一张也发不出去。'
            : '只发私聊（和主动搭话同一个会话），群里不会主动贴；9~23 点之外不贴（要改时段去 config.json 的 stickers.post.awakeFrom），心情差时概率打折。贴的都是「已经有名字或描述」的图。'),
        /**
         * 「未分类」里的图是同步进来的，没有语义标签——模型只认分类名。
         * 所以这行不是装饰，是提醒：不分类的话它们基本用不上。
         */
        uncat && uncat.count
          ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
              `「未分类」里有 ${uncat.count} 张——拖进「开心」「无语」这类目录才算真的分类，模型只认目录名。`)
          : null,
        stickers
          ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
              `共 ${stickers.items?.length || 0} 张 · 约 ${stickers.chars || 0} 字（注入系统提示词，order 901）`)
          : h('div', { className: 'roost-note', style: { marginTop: 6 } },
              '读不到表情包目录——插件刚起来时会空几秒'),
        ),
        syncOpen
          ? h(SyncModal, {
              categories: stickers?.categories || [],
              onClose: () => setSyncOpen(false), toast, onDone: reload,
            })
          : null,
      )
    }

    /**
     * 同步缓存图弹窗。
     *
     * 两步走：先预览、再确认。因为筛选**只能看尺寸**（没有内容识别，原因见
     * `sticker-sync.js` 头注释），规则必然有误伤和漏网，让人先看一眼
     * 比事后去表情包目录里翻着删省事。
     *
     * 缩略图走 `fetch + blob` 而不是 `<img src>`：面板 API 有一道
     * `connection.admit()` 栅栏，`<img>` 裸请求不一定带得上宿主认证，
     * 表现是满屏破图。用 fetch 走的是和别的接口同一条路，稳。
     */
    function SyncModal({ categories = [], onClose, toast, onDone }) {
      const [st, setSt] = useState(null)
      const [picked, setPicked] = useState(() => new Set())
      const [busy, setBusy] = useState(false)
      const [thumbs, setThumbs] = useState({})
      /** 每张图的去向：`{ [缓存文件名]: { folder, tags } }`。留空就是「进未分类、不打标签」 */
      const [meta, setMeta] = useState({})
      /** 批量填充用，不参与提交 */
      const [bulk, setBulk] = useState({ folder: '', tags: '' })

      useEffect(() => {
        let dead = false
        ;(async () => {
          const r = await get('/stickers/sync/preview')
          if (dead) return
          setSt(r)
          if (r?.ok !== false) {
            /** 默认全选通过筛选的那批，用户只需要取消不想要的 */
            setPicked(new Set((r.items || []).filter((x) => x.ok).map((x) => x.name)))
          }
        })()
        return () => { dead = true }
      }, [])

      const items = st?.items || []
      const key = items.map((x) => x.name).join('|')

      /** 拉缩略图。一张失败就少一个预览，不影响勾选 */
      useEffect(() => {
        if (!items.length) return undefined
        let dead = false
        const made = []
        ;(async () => {
          const next = {}
          for (const it of items) {
            if (dead) break
            try {
              const res = await fetch(API + '/stickers/thumb?name=' + encodeURIComponent(it.name))
              if (!res.ok) continue
              const blob = await res.blob()
              const url = URL.createObjectURL(blob)
              made.push(url)
              next[it.name] = url
            } catch {}
          }
          if (dead) return
          setThumbs(next)
        })()
        return () => {
          dead = true
          for (const u of made) { try { URL.revokeObjectURL(u) } catch {} }
        }
      }, [key])

      const total = picked.size
      const toggle = (n) => {
        const next = new Set(picked)
        if (next.has(n)) next.delete(n)
        else next.add(n)
        setPicked(next)
      }
      const allOn = items.length > 0 && items.every((x) => picked.has(x.name))
      const toggleAll = () => setPicked(allOn ? new Set() : new Set(items.map((x) => x.name)))

      const run = async () => {
        if (!total) return toast('一张都没选')
        setBusy(true)
        const picks = [...picked].map((n) => ({
          name: n,
          folder: String(meta[n]?.folder ?? '').trim(),
          tags: String(meta[n]?.tags ?? '').trim(),
        }))
        const r = await post('/stickers/sync/apply', { picks })
        setBusy(false)
        if (r?.ok === false) return toast(r.message || '同步失败')
        const n = r.copied || 0
        const bad = (r.failed || []).length
        const parts = Object.entries(r.folders || {}).map(([k, v]) => `${k} ${v} 张`)
        toast(bad
          ? `同步了 ${n} 张，${bad} 张失败`
          : `同步了 ${n} 张${parts.length ? '：' + parts.join('、') : ''}`)
        onDone?.()
        onClose?.()
      }

      /** 改单张的去向 */
      const setOne = (name, key, val) => setMeta((m) => ({ ...m, [name]: { ...(m[name] || {}), [key]: val } }))
      /** 把批量框里的文件夹/标签刷给所有勾选的行 */
      const applyBulk = () => {
        if (!picked.size) return toast('先勾几张')
        setMeta((m) => {
          const next = { ...m }
          for (const n of picked) next[n] = { ...(next[n] || {}), folder: bulk.folder, tags: bulk.tags }
          return next
        })
        toast(`已给 ${picked.size} 张套上同一组设置`)
      }

      /**
       * 重置同步记录：删掉表情包目录里的图之后，想让它们再来一次。
       * 不重置的话账本还记着「已同步过」，它们永远不会再出现。
       */
      const resetLedger = async () => {
        const r = await post('/stickers/sync/reset', {})
        if (r?.ok === false) return toast(r.message || '没重置成')
        setPicked(new Set())
        const p = await get('/stickers/sync/preview')
        setSt(p)
        toast('同步记录已清空')
      }

      return h('div', { className: 'cap-modal', onClick: onClose },
        h('div', { className: 'cap-modal-b', onClick: (e) => e.stopPropagation() },
          h('div', { className: 'cap-modal-h' },
            h('span', { className: 't' }, `同步缓存图（可同步 ${st?.willSync ?? '…'} 张）`),
            h('button', { type: 'button', className: 'roost-btn', onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'cap-modal-s' },
            h('div', { className: 'roost-note', style: { margin: 0 } },
              st?.dir
                ? `复制到 ${st.dir} 这一层。判断只看尺寸（边长 / 长宽比 / 体积），不看内容——不对的勾掉就行。`
                : '正在读缓存目录…'),
            h('div', { className: 'roost-note', style: { margin: 0 } },
              '下面可以给每张填文件夹和标签：填了标签就用它当文件名，填了文件夹就进那个分类，**都留空就进「未分类」**。'),
            st?.ok === false
              ? h('div', { className: 'roost-note', style: { color: 'var(--warn, #b8860b)', marginBottom: 0 } }, st.message || '没有可同步的图')
              : null,
          ),
          h('div', { className: 'cap-modal-s', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { className: 'roost-note', style: { margin: 0 } }, '批量：'),
            h('input', {
              className: 'roost-input', list: 'sticker-folders',
              placeholder: '文件夹（留空=未分类）',
              value: bulk.folder,
              style: { width: 168, fontSize: 11 },
              onChange: (e) => setBulk({ ...bulk, folder: e.target.value }),
            }),
            h('input', {
              className: 'roost-input',
              placeholder: '标签，逗号分隔',
              value: bulk.tags,
              style: { width: 150, fontSize: 11 },
              onChange: (e) => setBulk({ ...bulk, tags: e.target.value }),
            }),
            h('button', { type: 'button', className: 'roost-link', onClick: applyBulk }, '应用到选中的'),
          ),
          /** 现有分类当输入提示：不用记名字，点一下就填上 */
          h('datalist', { id: 'sticker-folders' },
            categories.filter((c) => c.name !== '未分类')
              .map((c) => h('option', { key: c.name, value: c.name }))),
          h('div', { className: 'cap-modal-c' },
            items.length
              ? items.map((it) => h('div', {
                  key: it.name,
                  style: {
                    display: 'flex', gap: 8, alignItems: 'center', padding: '4px 2px', flexWrap: 'wrap',
                    opacity: it.reason.includes('已同步') ? 0.45 : 1,
                  },
                },
                  h('input', {
                    type: 'checkbox',
                    checked: picked.has(it.name),
                    disabled: it.reason.includes('已同步'),
                    onChange: () => toggle(it.name),
                  }),
                  thumbs[it.name]
                    ? h('img', {
                        src: thumbs[it.name],
                        alt: '',
                        style: { width: 40, height: 40, objectFit: 'contain', borderRadius: 4, background: 'rgba(0,0,0,.06)', flex: '0 0 auto' },
                      })
                    : h('span', { style: { width: 40, height: 40, flex: '0 0 auto' } }),
                  /**
                   * 文件名可点 = 勾选。整行不再是 `<label>`：里面有两个输入框，
                   * 用 label 包着会让「点输入框」也触发勾选，打字时状态乱跳。
                   */
                  h('span', {
                    style: { fontSize: 12, minWidth: 110, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis' },
                    onClick: () => { if (!it.reason.includes('已同步')) toggle(it.name) },
                    title: it.name,
                  },
                    it.name.slice(0, 8) + '…',
                    h('span', { style: { opacity: 0.6, marginLeft: 6 } },
                      it.w ? `${it.w}×${it.h}` : '',
                      ` ${Math.max(1, Math.round(it.size / 1024))}KB`)),
                  h('input', {
                    className: 'roost-input',
                    list: 'sticker-folders',
                    placeholder: '未分类',
                    value: meta[it.name]?.folder ?? '',
                    style: { width: 96, fontSize: 11 },
                    onChange: (e) => setOne(it.name, 'folder', e.target.value),
                  }),
                  h('input', {
                    className: 'roost-input',
                    placeholder: '标签',
                    value: meta[it.name]?.tags ?? '',
                    style: { width: 116, fontSize: 11 },
                    onChange: (e) => setOne(it.name, 'tags', e.target.value),
                  }),
                  it.reason
                    ? h('span', {
                        style: {
                          marginLeft: 'auto', fontSize: 11, whiteSpace: 'nowrap',
                          color: it.ok ? 'var(--ok, #2e7d32)' : 'var(--bad, #c0392b)',
                        },
                      }, it.ok ? '可同步' : it.reason)
                    : null,
                ))
              : h('div', { className: 'roost-note' }, st ? '没有图片缓存。群里有人发图之后再看。' : '读取中…'),
          ),
          h('div', { className: 'cap-modal-s', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'roost-btn', onClick: toggleAll }, allOn ? '全不选' : '全选'),
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy || !total,
              onClick: run,
            }, busy ? '同步中…' : `同步选中的 ${total} 张`),
            h('span', { className: 'roost-note', style: { margin: 0 } },
              `共 ${st?.total ?? 0} 张缓存，跳过 ${st?.skipped ?? 0} 张`),
            h(ConfirmLink, { label: '重置同步记录', confirmLabel: '确认重置', onConfirm: resetLedger }),
          ),
        ),
      )
    }

    /**
     * 模型：聊天用哪个、按聊天单独选、清单里有什么。
     *
     * 以前这一页是「provider / model 两个输入框 + 四个按钮」：得先知道 DSH 里
     * 它们分别叫什么，拼错一个字母就整轮报「找不到模型」，而报错点离面板很远，
     * 用户根本联想不到是这里填错了。
     *
     * 现在改成从 DSH 的清单里选（`model.list`），并把能力一起显示出来：
     * 思考强度不支持的模型选了也不会传下去，看图能力「未知」和「看不了」要能分清。
     *
     * **清单拿不到时退回手填**（宿主没暴露 `ctx.llm`、或者 provider 全没登录），
     * 功能不因为清单没拉到就整页不能改。
     */
    function ModelBlock({ toast, currentChatId, config, saveCfg }) {
      const [info, setInfo] = useState(null)
      const [cat, setCat] = useState(null)
      const [catErr, setCatErr] = useState('')
      const [busy, setBusy] = useState(false)
      /** `provider::model` → 测速结果文案 */
      const [ping, setPing] = useState({})
      const [open, setOpen] = useState(false)
      const [add, setAdd] = useState({ kind: 'c2c', id: '', sel: '' })
      const [manual, setManual] = useState({ provider: '', model: '' })

      const call = async (op, arg) => {
        const r = await post('/quick', { op, arg: arg || {}, chatId: '' })
        if (r?.ok === false && r?.message) toast(r.message)
        return r
      }
      /** 测速失败不该弹提示条：它本来就有一列结果在下面，失败原因写在那里 */
      const quiet = async (op, arg) => post('/quick', { op, arg: arg || {}, chatId: '' })

      /**
       * 一次把两张表拉齐：`model.get` 是「现在用的是什么」，`model.list` 是
       * 「能选什么」。少一张，下拉里就是空值，用户会以为配置丢了。
       */
      const load = async (refresh) => {
        setBusy(true)
        try {
          const [g, l] = await Promise.all([
            quiet('model.get', {}),
            quiet('model.list', { refresh: Boolean(refresh) }),
          ])
          if (g && g.ok !== false) setInfo(g)
          if (l && l.ok !== false) {
            setCat(l)
            setCatErr('')
          } else {
            setCat({ list: [] })
            setCatErr(String(l?.message || '读不到模型清单'))
          }
        } finally {
          setBusy(false)
        }
      }
      useEffect(() => { load(false) }, [])

      const apply = async (arg, okText) => {
        setBusy(true)
        try {
          const r = await call('model.set', arg)
          if (r?.ok) toast(okText)
          await load(false)
        } finally {
          setBusy(false)
        }
      }

      const list = Array.isArray(cat?.list) ? cat.list : []
      const keyOf = (m) => (m && m.provider && m.model ? m.provider + '::' + m.model : '')
      const valOf = (sel) => (sel && sel.provider && sel.model ? sel.provider + '::' + sel.model : '')
      const split = (v) => {
        const s = String(v || '')
        if (!s) return null
        const [p, ...rest] = s.split('::')
        return { provider: p, model: rest.join('::') }
      }
      const labelOf = (v) => {
        const hit = list.find((m) => keyOf(m) === v)
        return hit ? hit.name : (split(v)?.model || '')
      }

      /** 「聊天用的模型」：自己设的默认优先，没设就是 DSH 的全局默认 */
      const mine = valOf(info?.defaultSel)
      const eff = info?.effective || info?.global || null
      /** 宿主老版本回的是字符串（'provider / model'），新版本回对象，两种都得能显示 */
      const effTxt = eff ? (typeof eff === 'string' ? eff : [eff.provider, eff.model].filter(Boolean).join(' / ')) : ''
      const effCap = list.find((m) => keyOf(m) === keyOf(eff)) || null
      /** 测速对象：设了自己的默认就测它，否则测 DSH 那个 */
      const pingTarget = split(mine) || (eff && eff.provider && eff.model ? { provider: eff.provider, model: eff.model } : null)

      /** 下拉选项：清单 + 「跟随 DSH 默认」。当前值不在清单里（模型被删）也要能看见 */
      const optsOf = (cur, withNone = true, noneLabel = '跟随 DSH 默认') => {
        const out = (withNone ? [{ value: '', label: noneLabel }] : [])
          .concat(list.map((m) => ({ value: keyOf(m), label: m.name + (m.provider ? '｜' + m.provider : '') })))
        if (cur && !out.some((o) => o.value === cur)) {
          out.unshift({ value: cur, label: (split(cur)?.model || cur) + '（清单里没找到）' })
        }
        return out
      }

      const select = (value, opts, onChange, width) => h('select', {
        className: 'roost-input',
        style: { width: width || 260 },
        value: value || '',
        onChange: (e) => onChange(e.target.value),
      }, opts.map((o) => h('option', { key: o.value || 'none', value: o.value }, o.label)))

      /**
       * 分段选择器。选中那段用主按钮色：原生的 radio 在这套深色皮里太小，
       * 而两个按钮挨着放又看不出「这是一组、只能选一个」。
       */
      const seg = (value, opts, onChange, disabled) => h('div', {
        style: { display: 'inline-flex', border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' },
      }, opts.map((o, i) => h('button', {
        key: String(o.value),
        type: 'button',
        disabled: Boolean(disabled),
        className: value === o.value ? 'roost-primary' : 'roost-btn',
        style: {
          borderRadius: 0, padding: '5px 13px',
          border: 'none', borderLeft: i ? '1px solid var(--line)' : 'none',
        },
        onClick: () => onChange(o.value),
      }, o.label)))

      /** 一行：左边标签 + 说明，右边控件；窄侧栏自动折行 */
      const row = (label, hint, control) => h('div', {
        style: {
          display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
          padding: '10px 0', borderTop: '1px solid var(--line-soft)',
        },
      },
        h('div', { style: { flex: '1 1 210px', minWidth: 150 } },
          h('div', { style: { fontSize: 12.5, fontWeight: 650 } }, label),
          hint ? h('div', { className: 'roost-note', style: { margin: '2px 0 0' } }, hint) : null),
        h('div', { style: { flex: '0 0 auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, control),
      )

      const test = async (sel) => {
        if (!sel?.provider || !sel?.model) return
        const k = keyOf(sel)
        setPing((p) => ({ ...p, [k]: '测速中…' }))
        const r = await quiet('model.ping', { provider: sel.provider, model: sel.model })
        setPing((p) => ({ ...p, [k]: r?.ok ? (Number(r.ms) / 1000).toFixed(1) + ' 秒' : '失败：' + (r?.message || '') }))
      }

      /**
       * 思考强度：`''` = 不指定（让模型用自己的默认档）。
       *
       * 不给「不支持就别选」的硬拦——档位是 adapter 私有的不透明 id，
       * 清单里没查到不等于一定不支持（宿主可能只是没公布）。所以只是把提示写清楚，
       * 真传的时候 `pickReasoningEffort` 还会再校验一次，不认就不传。
       */
      const efforts = [
        { value: '', label: '不指定' },
        { value: 'low', label: '低' },
        { value: 'high', label: '高' },
        { value: 'max', label: '最高' },
      ]
      const noReasoning = Boolean(effCap && effCap.reasoning === null)
      const effortHint = noReasoning
        ? '这个模型没有公布思考强度，选了也不会传下去'
        : effCap && effCap.reasoning
          ? '这个模型支持：' + effCap.reasoning.efforts.join(' / ') + '；聊天建议「低」，回得快'
          : '聊天建议「低」，回得快；模型认不认这一档由 DSH 兜底'

      /** 视觉能力：true = 总是发，false = 不发，'auto' = 问 DSH 这个模型能不能看图 */
      const rawVision = config ? (config.roostHost?.vision ?? true) : true
      const vision = rawVision === 'auto' ? 'auto' : (rawVision === false ? 'off' : 'on')
      const visionHint = vision === 'off'
        ? '收到图片只给一行文字提示，不会把图发给模型'
        : vision === 'on'
          ? '总是把图发给模型；模型其实看不了的话，带图那一轮可能报错'
          : effCap && effCap.vision === true
            ? 'DSH 说这个模型能看图，照常发'
            : effCap && effCap.vision === false
              ? 'DSH 说这个模型看不了图，自动降级成文字提示'
              : 'DSH 没声明，照样发；确实看不了就手动选「不发」'
      const setVision = async (v) => {
        if (typeof saveCfg !== 'function') return
        const r = await saveCfg({ roostHost: { vision: v === 'auto' ? 'auto' : v === 'on' } })
        toast(r?.ok === false ? (r.message || '没存上') : '视觉能力已改（下一轮生效）')
      }

      const kinds = info?.byKindAll || {}
      const exceptions = Object.entries(info?.byChat || {})
        .map(([id, sel]) => ({ id, sel }))
        .filter((x) => x.sel && x.sel.provider && x.sel.model)

      return h('div', null,
        h(Sec, {
          n: '01',
          title: '聊天用的模型',
          right: h('button', {
            type: 'button', className: 'roost-btn', disabled: busy,
            onClick: () => load(true),
          }, busy ? '读着…' : '刷新'),
        },
          h('div', { className: 'roost-note', style: { marginTop: 2 } },
            '新建的 QQ 会话按这里的设置来；已有会话改完从那个聊天的下一轮消息起生效。'
            + (effTxt ? 'DSH 全局：' + effTxt : 'DSH 还没有默认模型')),

          row('思考强度', effortHint,
            seg(info?.effort || '', efforts, (v) => apply({ effort: v }, v ? '思考强度已改' : '已改成跟随模型默认'), false)),

          row('视觉能力', visionHint,
            config
              ? seg(vision, [
                  { value: 'auto', label: '自动' },
                  { value: 'on', label: '总是发' },
                  { value: 'off', label: '不发' },
                ], (v) => setVision(v))
              : h('span', { className: 'roost-note', style: { margin: 0 } }, '读取配置…')),

          row('模型', '选了就用它当所有聊天的默认；「跟随 DSH 默认」= 用你在 DSH 里平时那个',
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              select(mine, optsOf(mine), (v) => apply(
                v ? { default: split(v) } : { default: { off: true } },
                v ? '已设为默认模型' : '已改回跟随 DSH 默认',
              )),
              pingTarget ? h('button', {
                type: 'button', className: 'roost-btn', disabled: busy,
                onClick: () => test(pingTarget),
              }, '测速') : null,
              pingTarget && ping[keyOf(pingTarget)]
                ? h('span', { className: 'roost-note', style: { margin: 0 } }, ping[keyOf(pingTarget)])
                : null,
            )),

          /** 清单没拉到时的退路：仍然能手填（老面板就是这个操作方式） */
          catErr
            ? h('div', {
                style: { marginTop: 12, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 10 },
              },
                h('div', { className: 'roost-note', style: { margin: 0 } }, '没用上清单：' + catErr),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' } },
                  h('input', {
                    className: 'roost-input', style: { width: 150 }, placeholder: 'provider',
                    value: manual.provider, onChange: (e) => setManual({ ...manual, provider: e.target.value }),
                  }),
                  h('input', {
                    className: 'roost-input', style: { width: 190 }, placeholder: 'model',
                    value: manual.model, onChange: (e) => setManual({ ...manual, model: e.target.value }),
                  }),
                  h('button', {
                    type: 'button', className: 'roost-primary',
                    disabled: busy || !manual.provider.trim() || !manual.model.trim(),
                    onClick: () => apply(
                      { default: { provider: manual.provider.trim(), model: manual.model.trim() } },
                      '已设为默认模型',
                    ),
                  }, '手填并设为默认'),
                ),
              )
            : null,
        ),

        h(Sec, { n: '02', title: '按聊天选模型' },
          h('div', { className: 'roost-note', style: { marginTop: 2 } },
            '顺序：这个聊天 > 私聊 / 群聊默认 > 上面那个默认模型 > DSH 全局。'
            + '没配的那一级自动往下用；选的模型在 DSH 里找不到时也自动退回。'
            + '只有你能在这里改，聊天里的人换不了。'),

          row('私聊默认', '所有私聊用它；单个 QQ 的例外在下面加',
            select(valOf(kinds.c2c), optsOf(valOf(kinds.c2c), true, '跟随上一级'), (v) => {
              const s = split(v)
              return s
                ? apply({ kind: 'c2c', ...s }, '已设为私聊默认')
                : apply({ kind: 'c2c', off: true }, '私聊改回跟随上一级')
            })),

          row('群聊默认', '所有群用它；单个群的例外在下面加',
            select(valOf(kinds.group), optsOf(valOf(kinds.group), true, '跟随上一级'), (v) => {
              const s = split(v)
              return s
                ? apply({ kind: 'group', ...s }, '已设为群聊默认')
                : apply({ kind: 'group', off: true }, '群聊改回跟随上一级')
            })),

          h('div', { style: { marginTop: 12 } },
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => setOpen(!open),
            }, (open ? '收起' : '展开') + '单个 QQ / 群的例外（' + exceptions.length + '）')),

          open
            ? h('div', { style: { marginTop: 10 } },
                exceptions.length === 0
                  ? h('div', { className: 'roost-note', style: { margin: '0 0 10px' } }, '还没有单独设置的聊天。')
                  : h('div', { className: 'roost-list' },
                      exceptions.map((x) => h('div', { key: x.id, className: 'roost-item' },
                        h('span', { className: 'd' }, x.sel.kind === 'group' ? '群' : x.sel.kind === 'c2c' ? '私聊' : '聊天'),
                        h('span', { className: 't' }, String(x.id)),
                        h('span', { className: 'd' }, labelOf(valOf(x.sel))),
                        h('button', {
                          type: 'button', className: 'roost-btn', disabled: busy,
                          onClick: () => apply({ chatId: x.id, off: true }, '已恢复该聊天默认'),
                        }, '移除'),
                      ))),

                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 } },
                  seg(add.kind, [{ value: 'c2c', label: '私聊' }, { value: 'group', label: '群' }],
                    (v) => setAdd({ ...add, kind: v })),
                  h('input', {
                    className: 'roost-input', style: { width: 200 },
                    placeholder: add.kind === 'c2c' ? '会话 id（私聊是 openid）' : '群 id',
                    value: add.id, onChange: (e) => setAdd({ ...add, id: e.target.value.trim() }),
                  }),
                  h('button', {
                    type: 'button', className: 'roost-btn', disabled: !currentChatId,
                    title: currentChatId ? '填当前聊天' : '先在「记忆」页选一个聊天',
                    onClick: () => setAdd({ ...add, id: String(currentChatId) }),
                  }, '用当前会话'),
                  select(add.sel, optsOf(add.sel, false).length
                    ? [{ value: '', label: '选模型' }].concat(optsOf(add.sel, false))
                    : [{ value: '', label: '清单里没有可选的模型' }],
                  (v) => setAdd({ ...add, sel: v }), 230),
                  h('button', {
                    type: 'button', className: 'roost-primary',
                    disabled: busy || !add.id || !add.sel,
                    onClick: () => {
                      const s = split(add.sel)
                      if (!s) return
                      apply({ chatId: add.id, kind: add.kind, ...s }, '已设为该聊天模型')
                      setAdd({ ...add, id: '' })
                    },
                  }, '添加'),
                ),
              )
            : null,
        ),

        h(Sec, {
          n: '03',
          title: '可用的模型',
          right: h('span', { className: 'roost-note', style: { margin: 0 } },
            list.length ? '共 ' + list.length + ' 个' : ''),
        },
          cat === null
            ? h('div', { className: 'roost-empty' }, '读着…')
            : list.length === 0
              ? h('div', { className: 'roost-empty' }, catErr || 'DSH 没有列出模型')
              : h('div', null,
                  h('div', { className: 'roost-note', style: { marginTop: 2 } },
                    '「测速」是真的问一次模型（花一点点额度），看它回一句话要多久。'),
                  h('div', { className: 'roost-list' },
                    list.map((m) => h('div', { key: keyOf(m), className: 'roost-item' },
                      h('span', { className: 't' }, m.name + (m.provider ? '｜' + m.provider : '')),
                      h('span', { className: 'd' },
                        m.reasoning ? '思考 ' + m.reasoning.efforts.join('/') : '无思考档'),
                      h('span', { className: 'd' },
                        m.vision === true ? '能看图' : m.vision === false ? '看不了图' : '看图未知'),
                      ping[keyOf(m)] ? h('span', { className: 'd' }, ping[keyOf(m)]) : null,
                      h('button', {
                        type: 'button', className: 'roost-btn', disabled: busy,
                        onClick: () => test(m),
                      }, '测速'),
                      h('button', {
                        type: 'button', className: 'roost-btn', disabled: busy,
                        onClick: () => apply(
                          { default: { provider: m.provider, model: m.model } },
                          '已设为默认模型',
                        ),
                      }, '用这个'),
                    ))),
                ),
        ),
      )
    }

    function ConfigTab({ config, save, saveCfg, toast, stickers, setupSt, reload, currentChatId, setTab }) {
      const cfgJson = JSON.stringify(config, null, 2)
      const [draft, setDraft] = useState(cfgJson)
      const [err, setErr] = useState('')
      /** 用户动过草稿没有。动过就别被外部变化覆盖，否则输入白丢 */
      const [dirty, setDirty] = useState(false)
      /** 上次与服务端对齐时的 JSON。和当前 cfgJson 不同 = 草稿已过期。用 state：改了要能触发重渲染 */
      const [baseline, setBaseline] = useState(cfgJson)
      const taRef = useRef(null)

      /**
       * 外部配置变了（比如上面刚保存了工作区）：没动过草稿就跟上，动过就保留。
       * 只在 !dirty 时同步，所以不会和 dirty 打转。
       */
      useEffect(() => {
        if (dirty) return
        setDraft(cfgJson)
        setBaseline(cfgJson)
      }, [cfgJson, dirty])

      /** 草稿是旧的、而且用户改过 → 直接保存会把别处的改动盖回去 */
      const stale = dirty && baseline !== cfgJson

      /** 重新载入：丢掉自己的草稿，跟服务端对齐 */
      const reloadDraft = () => {
        setDraft(cfgJson)
        setBaseline(cfgJson)
        setDirty(false)
      }
      /** 我知道别处改过，仍要用我的草稿：把基线挪过来，stale 就消了 */
      const keepMine = () => setBaseline(cfgJson)

      /**
       * 点段名跳到那一段。
       *
       * 以前提示「在下面的配置全文里搜 «x»」——但浏览器的页内查找**不搜 textarea
       * 的内容**（它只搜 DOM 文本节点，textarea 的 value 不算），用户按提示去搜
       * 根本搜不到。改成直接定位并选中。
       */
      const jumpTo = (k) => {
        const ta = taRef.current
        if (!ta) return
        const needle = '"' + k + '"'
        const i = draft.indexOf(needle)
        if (i < 0) {
          toast('当前配置里没有 «' + k + '» 这一段（可能被你删了）')
          return
        }
        ta.focus()
        ta.setSelectionRange(i, i + needle.length)
        // 11.5px × 1.6 ≈ 18.4px 行高；滚到中间偏上，前后都能看见
        const line = draft.slice(0, i).split('\n').length - 1
        ta.scrollTop = Math.max(0, line * 18.4 - ta.clientHeight / 2)
      }

      /**
       * 直接编辑 JSON，而不是给每个字段做表单。
       *
       * 为什么：上一版是逐字段表单，后端加一个配置项就得回来补一次 UI，
       * 补不及时就「后端有、面板没有」，用户只能去改文件。
       * 直接给 JSON 不会和后端漂移，代价是用户得看懂结构 ——
       * 所以上面配了分节说明，把常改的几段点出来。
       */
      const doSave = async () => {
        let parsed
        try {
          parsed = JSON.parse(draft)
        } catch (e) {
          setErr('JSON 不合法：' + e.message)
          return
        }
        /**
         * 根必须是对象。`null` / `[]` / `"abc"` / `123` 都能过 JSON.parse，
         * 后端会 400，这里先拦一道，省一次往返。
         */
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setErr('配置必须是一个 JSON 对象（形如 { "server": { … } }）')
          return
        }
        setErr('')
        const r = await save(parsed)
        if (r.ok === false) {
          /** 409 时服务端把当前配置一起回了：强制对齐，否则用户会拿旧草稿反复撞 409 */
          if (r.config) {
            const next = JSON.stringify(r.config, null, 2)
            setDraft(next)
            setBaseline(next)
            setDirty(false)
          }
          toast(r.message || '没存上')
          return
        }
        /**
         * 回填服务端返回的配置。
         *
         * 服务端会做归一化（补默认值、删掉展示字段、把旧默认值升级），不回填的话
         * 用户看到的是自己提交的版本，跟磁盘上真正存的不一致——下次改别的字段时
         * 会基于一份并不存在的配置继续改。
         */
        if (r.config) {
          const next = JSON.stringify(r.config, null, 2)
          setDraft(next)
          setBaseline(next)
          setDirty(false)
        }
        /**
         * 用服务端的 message，不再写死。
         *
         * 以前成功分支固定 `'存好了（下一轮生效）'`，把服务端返回的
         * 「已保存，服务已重载；但 xxx 没成功（原因）」整句丢掉了——
         * 重载只做了一半时，那正是唯一能看见的警告。
         */
        toast(r.message || '存好了')
      }

      return h('div', null,
        /**
         * 2026-11-12：模型 / 更新 / 反馈 / 语音 / 表情包各自独立成页，
         * 这里只剩「这台机器怎么配」——配置全文、各段说明。
         * 2.7：工作区卡片挪进「首次设置」，这里按原位置留一行链接（只增不减）。
         */
        h(Sec, { n: '01', title: '工作区',
          right: h('button', {
            type: 'button', className: 'roost-btn',
            onClick: () => setTab && setTab('setup'),
          }, '去首次设置页改'),
        },
          h('div', { className: 'roost-note', style: { margin: 0 } },
            '工作区目录和名字在「首次设置」页里改——那是装机时定一次的事，跟本页的配置全文不是一个使用频率。改完要重启会话才挂上新工作区。'),
        ),

        h(Sec, { n: '02', title: '配置全文', right: h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', className: 'roost-btn', onClick: reloadDraft }, '还原'),
          h('button', {
            type: 'button', className: 'roost-primary', onClick: doSave,
            disabled: stale,
            title: stale ? '配置在别处改过了，先选「重新载入」或「仍用我的草稿」' : '',
          }, '保存'),
        ) },
          err ? h('div', { style: { color: 'var(--bad)', fontSize: 12, marginBottom: 6 } }, err) : null,
          stale
            ? h('div', { className: 'roost-note', style: { color: 'var(--warn, #b8860b)', marginBottom: 6, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', null, '配置在别处改过了，直接保存会把它盖回去。'),
                h('button', { type: 'button', className: 'roost-btn', onClick: reloadDraft }, '重新载入'),
                h('button', { type: 'button', className: 'roost-btn', onClick: keepMine }, '仍用我的草稿'))
            : null,
          h('textarea', {
            ref: taRef,
            className: 'roost-input',
            style: { minHeight: 240, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 11.5, lineHeight: 1.6, resize: 'vertical' },
            value: draft,
            spellCheck: false,
            onChange: (e) => { setDraft(e.target.value); setDirty(true) },
          }),
          h('div', { className: 'roost-note' },
            '密钥显示成 ******。原样提交回来不会覆盖真密钥，只有填了新的才会改。'),
        ),

        h(Sec, { n: '03', title: '各段是干什么的' },
          h('div', { className: 'roost-list' },
            JSON_SECTIONS.map(([k, label, desc]) =>
              h('div', { key: k, className: 'roost-item' },
                h('span', { className: 't' },
                  h('span', { className: 'roost-code', style: { cursor: 'pointer' }, onClick: () => jumpTo(k), title: '点一下跳到这一段' }, k),
                  ' ',
                  h('span', null, label),
                  h('span', { className: 'd' }, ' · ' + desc),
                ),
              ),
            ),
          ),
        ),
      )
    }

    /* ---------------- 扩展面板（2026-11-12 独立成一级分组「扩展」，下辖三页） ---------------- */

    /** 三段都走 /quick 的扩展 op；这些是全局设置，chatId 留空。 */
    /**
     * `extra` 给扩展页面的转发用：带 `{ viaExt: id }`，服务端据此按该扩展
     * **实际授予的 scope** 判权（见 `src/ext-quick-guard.js`）。
     * 面板自己的按钮不传，保持全权。
     */
    const EXT_POST = (op, arg, extra) => post('/quick', { op, arg, chatId: '', ...(extra || {}) })
    const EXT_BUCKET_LABEL = {
      owner: '主人', admin: '管理员', manager: '群管', helper: '助手', member: '群成员', unknown: '未识别',
    }
    /** 与 src/ext-panel.js 的 REJECTION_LAYERS 同顺序；前端只用来把英文层名翻成中文。 */
    const EXT_LAYER_LABEL = {
      fence: '接入栅栏 / 令牌鉴权',
      capabilities: '权限页的收紧规则',
      quota: '次数限制',
      acl: '扩展记忆命名空间 ACL',
      guard: '执行期工具 guard',
    }

    /**
     * 扩展档位：按 `mcp__<id>__` 前缀自动归组 + 六档矩阵 + dry-run + 五层拒绝诊断。
     * 现挂在「扩展 → 已安装」页里，`Sec` 不带编号，免得和该页其它块撞号。
     */
    function ExtCapsBlock({ quick, toast }) {
      const [buckets, setBuckets] = useState(null)
      const [diag, setDiag] = useState(null)
      const [list, setList] = useState([])
      const [pick, setPick] = useState('')
      const [dry, setDry] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = async () => {
        const [a, b, c] = await Promise.all([
          EXT_POST('extensions.get'),
          EXT_POST('extensions.buckets'),
          EXT_POST('extensions.diagnose', { limit: 20 }),
        ])
        setList(a.rows || [])
        setBuckets(b)
        setDiag(c)
        if (!pick && (a.rows || []).length) setPick(a.rows[0].id)
      }
      useEffect(() => { load() }, [])

      /** 试算只读：算「选中扩展的工具在各档会少几个」，确认后才真写 forceDeny。 */
      const preview = () => {
        if (!pick || !buckets) return
        const prefix = `mcp__${pick}__`
        const rows = (buckets.buckets || []).map((b) => ({
          bucket: b.bucket,
          hit: (b.allow || []).filter((n) => String(n).startsWith(prefix)).length,
          total: b.allowCount,
        }))
        setDry({
          id: pick, prefix, rows,
          affected: rows.filter((r) => r.hit > 0).length,
          totalHits: rows.reduce((n, r) => n + r.hit, 0),
        })
      }

      /** 应用复用阶段 1 的 C′：forceDeny 支持通配且持久化，跨档硬否决。 */
      const apply = async () => {
        if (!dry) return
        setBusy(true)
        try {
          /** 不拿 load 时的快照做读-改-写：两个人同时收紧时后点的会盖掉前点的。 */
          const fresh = await EXT_POST('extensions.buckets')
          const next = [...(fresh.rules?.forceDeny || buckets.rules?.forceDeny || []), `${dry.prefix}*`]
          const r = await quick('capabilities.patch', { forceDeny: [...new Set(next)] })
          toast(r.message || (r.ok ? '已收紧' : '收紧失败'))
          setDry(null)
          await load()
        } finally { setBusy(false) }
      }

      return h(Sec, {
        title: '扩展能力分组 · 六档矩阵 / 试算 / 拒绝诊断',
        right: h('button', { type: 'button', className: 'roost-btn', onClick: load }, '刷新'),
      },
        h('div', { className: 'roost-note' },
          '按 mcp__<扩展id>__ 前缀自动归组。「实际生效档位」用和真实生效同一份策略算；发言人身份缺失时的兜底退化会在这里明说，不静默。'),
        /** 常驻显示兜底档：退化状态由后端读真实 speaker 表，前端不自报。 */
        h('div', {
          className: 'roost-note',
          style: buckets?.fallback?.degraded ? { color: 'var(--warn)' } : undefined,
        },
          `档位兜底：${buckets?.fallback?.reason || '读不到兜底信息'}`,
          buckets?.fallback
            ? `（兜底档 ${buckets.fallback.effective} 允许 ${buckets.fallback.allowCount === null ? '未能试算' : buckets.fallback.allowCount + ' 个工具'}，活跃会话 ${buckets.fallback.activeSessions ?? '未知'}）`
            : '',
        ),
        h('div', { className: 'roost-list' },
          (buckets?.buckets || []).map((b) => h('div', { key: b.bucket, className: 'roost-item' },
            h('span', { className: 't' },
              `${EXT_BUCKET_LABEL[b.bucket] || b.bucket}（${b.bucket}）`,
              h('span', { className: 'd' }, ` · 允许 ${b.allowCount === null ? '未能试算' : b.allowCount + ' 个工具'}`),
            ),
          )),
        ),
        list.length
          ? h('div', { className: 'roost-note', style: { marginTop: 8 } },
              '六档矩阵 · 每个扩展当前可调取的工具数：',
              h('div', { className: 'roost-list' },
                list.map((x) => h('div', { key: x.id, className: 'roost-item' },
                  h('span', { className: 't' }, x.name,
                    h('span', { className: 'd' }, ` · mcp__${x.id}__*（${x.id} 扩展的全部工具）`),
                    h('span', { className: 'd' },
                      ' · ' + (buckets?.buckets || []).map((b) =>
                        `${EXT_BUCKET_LABEL[b.bucket] || b.bucket}:${(b.allow || []).filter((n) => String(n).startsWith(`mcp__${x.id}__`)).length}`).join(' / '),
                    ),
                  ),
                )),
              ),
            )
          : h('div', { className: 'roost-empty' }, '还没装扩展。装好后在「扩展 → 已安装」里改说明。'),
        h('div', { className: 'roost-note', style: { marginTop: 8 } },
          'dry-run 预览：选一个扩展先试算，确认后才写进 forceDeny。',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            h('select', {
              className: 'roost-input', value: pick,
              onChange: (e) => { setPick(e.target.value); setDry(null) },
            }, list.map((x) => h('option', { key: x.id, value: x.id },
              x.id + (x.name && x.name !== x.id ? `（${x.name}）` : '')))),
            h('button', { type: 'button', className: 'roost-btn', disabled: !pick, onClick: preview }, '试算'),
            dry
              ? h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: apply }, '确认收紧')
              : null,
          ),
          dry
            ? h('div', { className: 'roost-note', style: { marginTop: 6 } },
                `确认后「群友明天会少这 ${dry.totalHits} 个能力」，影响 ${dry.affected} 个档位；次数覆盖仍由下面「次数限制」一节配置。`,
                h('div', { className: 'roost-list' },
                  dry.rows.filter((r) => r.hit > 0).map((r) => h('div', { key: r.bucket, className: 'roost-item' },
                    h('span', { className: 't' }, `${EXT_BUCKET_LABEL[r.bucket] || r.bucket}：少 ${r.hit} 个`),
                  )),
                ),
              )
            : null,
        ),
        h('div', { className: 'roost-note', style: { marginTop: 8 } },
          '统一「为什么没生效」诊断：五层来源各自可分辨，最近 N 次拒绝带工具名 / 档位 / 命中的规则。',
          h('div', { className: 'roost-list' },
            (diag?.layers || []).map((L) => {
              const rules = (L.rules || []).join('；').slice(0, 220)
              return h('div', { key: L.id, className: 'diag-item' },
                h('div', { className: 't' },
                  h('span', null, L.label),
                  h('span', { className: 'd' }, `捕获 ${L.events} 次`),
                  L.wired ? null : h('span', { className: 'd' }, '规则层，实际拦截事件由 guard 记'),
                ),
                rules ? h('div', { className: 'd' }, rules) : null,
              )
            }),
          ),
          (diag?.recent || []).length
            ? h('div', { className: 'roost-list' },
                diag.recent.slice(0, 5).map((r, i) => h('div', { key: i, className: 'diag-item' },
                  h('div', { className: 't' },
                    `${r.tool}${toolNote(r.tool) ? ' ' + toolNote(r.tool) : ''} · ${EXT_BUCKET_LABEL[r.bucket] || r.bucket}`),
                  h('div', { className: 'd' }, `${EXT_LAYER_LABEL[r.layer] || r.layer}：${r.rule}`),
                )),
              )
            : h('div', { className: 'roost-empty' }, '最近没有拒绝记录。'),
        ),
      )
    }

    /** 设置页：扩展清单 + usage 预览编辑 + 两个凭据状态。 */
    function ExtSettingsBlock({ toast, part = 'all' }) {
      /**
       * 市场 / 已安装拆成两页（2026-11-12，与 aurabot 的「模块」组对齐）。
       *
       * 两页共用同一份 `/extensions.*` 数据加载——拆的是**渲染**，不是取数：
       * 分成两个组件会让市场页和已安装页各拉一次清单，装完还得手动刷新另一页。
       */
      const showMarket = part !== 'installed'
      const showInstalled = part !== 'market'
      const [data, setData] = useState(null)
      const [drafts, setDrafts] = useState({})
      const [saving, setSaving] = useState('')
      /**
       * 扩展设置：`cfgFor` = 当前展开的那一个扩展的 id。
       *
       * `cfgSecrets` 里 **undefined = 不动**、`''` = 清除、有字符串 = 覆盖。
       * 三者必须分开：只用空串会变成「想清除」和「没动」不可区分，
       * 一保存就把用户辛苦填的密钥抹掉。
       */
      const [cfgFor, setCfgFor] = useState('')
      const [cfgData, setCfgData] = useState(null)
      const [cfgDraft, setCfgDraft] = useState({})
      const [cfgSecrets, setCfgSecrets] = useState({})
      const [cfgErr, setCfgErr] = useState('')
      const [cfgBusy, setCfgBusy] = useState(false)
      /** 扩展索要敏感权限时先弹窗，绝不自动带 confirmScopes 重试 */
      const [scopeAsk, setScopeAsk] = useState(null)
      const [scopeBusy, setScopeBusy] = useState(false)
      /** L3（核心接管）按 ext-tier 的 type-name 口径手打扩展 id */
      const [tierTyped, setTierTyped] = useState('')
      const [revokeAsk, setRevokeAsk] = useState(null)
      const [market, setMarket] = useState(null)
      const [marketBusy, setMarketBusy] = useState('')
      /** 5.6：搜索 / 分类 / 标签都在服务端筛，这里只存条件 */
      const [marketQuery, setMarketQuery] = useState('')
      const [marketCategory, setMarketCategory] = useState('')
      const [marketTag, setMarketTag] = useState('')
      const [marketProgress, setMarketProgress] = useState(null)
      /**
       * 市场数据源。国内直连 `raw.githubusercontent.com` / `codeload.github.com`
       * 经常被重置（面板报「连接被重置」），而 Gitee 是同一份仓库的镜像
       * （索引字节数实测完全一致），换过去就能用。
       */
      const [marketSrc, setMarketSrc] = useState('github')
      const [marketSrcUrl, setMarketSrcUrl] = useState('')
      const [marketSrcInfo, setMarketSrcInfo] = useState(null)
      const progressTimer = useRef(null)
      const marketFilters = () => ({ q: marketQuery, category: marketCategory, tag: marketTag })
      const stopProgress = () => {
        if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null }
      }
      /**
       * 卸载时停掉轮询。
       *
       * 以前只在动作函数里 `stopProgress()`：安装请求还没回来就切到别的页，
       * 组件卸载了但 interval 还在，每 400ms 一直打 `market.progress`
       * （请求挂死的话永不停止）。
       */
      useEffect(() => () => stopProgress(), [])
      /** 安装是单个 POST，中途拿不到响应体；用另一个只读 op 轮询阶段 */
      const startProgress = () => {
        stopProgress()
        progressTimer.current = setInterval(async () => {
          try {
            const r = await EXT_POST('extensions.market.progress', {})
            if (r?.ok !== false) setMarketProgress(r)
          } catch {}
        }, 400)
      }
      const loadMarket = async (refresh = false, filters = null) => {
        setMarketBusy('list')
        try {
          const r = await EXT_POST('extensions.market.list', {
            refresh, ...(filters || marketFilters()),
          })
          setMarket(r)
          if (!r.ok) toast(r.message || '市场索引拉取失败')
        } finally { setMarketBusy('') }
      }
      const marketAct = async (op, id, extra = {}) => {
        setMarketBusy(id)
        if (op === 'extensions.market.install') startProgress()
        try {
          let r = await EXT_POST(op, { id, ...extra })
          /**
           * 扩展索要敏感权限（`say:write` / `proactive:write` 之类）：后端**不肯**
           * 直接装，回 `needs_scope_confirm`。这里必须把「要授什么」摆出来让用户
           * 点第二次，绝不自动带 `confirmScopes:true` 重试 —— 那样等于一键装顺带授权。
           */
          /**
           * 后端按 L0–L3 现算等级、逐条给人话后果（ext-tier.js）。
           * 这里把等级 / 风险 / 确认方式一起收进弹窗，绝不自动带
           * confirmScopes:true 重试 —— 那等于一键装顺带授权。
           */
          if (r?.reason === 'needs_scope_confirm' || r?.reason === 'needs_tier_confirm') {
            setTierTyped('')
            setScopeAsk({
              op, id,
              /** 强制重装的 force 要跟着确认框走，否则第二次请求会被「已是最新版」短路 */
              extra,
              scopes: r.scopes || [],
              tier: r.tier || '', tierLabel: r.tierLabel || '', tierColor: r.tierColor || '',
              confirm: r.confirm || '', risks: r.risks || [], message: r.message || '',
            })
            return
          }
          toast(r.message || (r.ok ? '完成' : '失败'))
          await load()
          if (market) await loadMarket(true, marketFilters())
        } finally {
          stopProgress()
          setTimeout(() => setMarketProgress(null), 3000)
          setMarketBusy('')
        }
      }
      const confirmScopeAct = async () => {
        const ask = scopeAsk
        if (!ask) return
        /** L3 要手打扩展 id；没打对就不发请求，连 confirmScopes 都不给 */
        if (ask.confirm === 'type-name' && String(tierTyped || '').trim() !== ask.id) {
          toast(`请输入扩展 id「${ask.id}」以确认接管风险`)
          return
        }
        setScopeBusy(true)
        startProgress()
        try {
          const r = await EXT_POST(ask.op, {
            id: ask.id, confirmScopes: true,
            ...(ask.extra || {}),
            ...(ask.tier ? { confirmTier: ask.tier } : {}),
          })
          toast(r.message || (r.ok ? '完成' : '失败'))
          await load()
          if (market) await loadMarket(true, marketFilters())
        } finally {
          stopProgress()
          setTimeout(() => setMarketProgress(null), 3000)
          setScopeBusy(false)
          setScopeAsk(null)
          setTierTyped('')
        }
      }
      const checkUpdates = async () => {
        setMarketBusy('updates')
        try {
          const r = await EXT_POST('extensions.market.updates', {})
          const rows = r?.rows || []
          toast(rows.length ? `${rows.length} 个扩展有新版` : (r?.ok === false ? (r.message || '检查失败') : '都是最新版'))
          await loadMarket(true, marketFilters())
        } finally { setMarketBusy('') }
      }
      const revokeMarket = async (id) => {
        setMarketBusy(id)
        try {
          const r = await EXT_POST('extensions.market.revoke', { id, reason: 'panel' })
          toast(r.message || (r.ok ? '已停用' : '停用失败'))
          await load()
          await loadMarket(true, marketFilters())
        } finally {
          setMarketBusy('')
          setRevokeAsk(null)
        }
      }
      const load = async () => {
        const r = await EXT_POST('extensions.get')
        setData(r)
        const d = {}
        for (const x of (r.rows || [])) d[x.id] = x.usage
        setDrafts(d)
      }
      /** 进扩展页就把市场拉出来，别让用户自己找「加载市场」按钮 */
      const loadSource = async () => {
        try {
          const r = await EXT_POST('extensions.market.source', {})
          if (r?.ok !== false) {
            setMarketSrcInfo(r)
            setMarketSrc(r.source || 'github')
            setMarketSrcUrl(r.customUrl || '')
          }
        } catch { /* 读不到就按默认 github 显示 */ }
      }
      const saveSource = async () => {
        setMarketBusy('source')
        try {
          /**
           * 只在 `custom` 时才提交地址：预设源也提交会把用户之前填的自建地址
           * 冲成空串，切回「自定义」就得重填一遍。
           */
          const r = await EXT_POST('extensions.market.source', {
            set: true,
            source: marketSrc,
            ...(marketSrc === 'custom' ? { indexUrl: marketSrcUrl } : {}),
          })
          if (r?.ok === false) { toast(r.message || '保存失败'); return }
          toast('已切换数据源，正在重新拉取…')
          await loadSource()
          await loadMarket(true, marketFilters())
        } finally { setMarketBusy('') }
      }
      useEffect(() => { load(); loadSource() }, [])
      /** 5.6：筛选条件变了重查（250ms 防抖），别每敲一个字都打一次索引 */
      useEffect(() => {
        const t = setTimeout(() => loadMarket(false, {
          q: marketQuery, category: marketCategory, tag: marketTag,
        }), 250)
        return () => clearTimeout(t)
      }, [marketQuery, marketCategory, marketTag])
      const save = async (id) => {
        setSaving(id)
        try {
          const r = await EXT_POST('extensions.usage.save', { id, usage: drafts[id] ?? '' })
          /** 后端会把超 200 字截断；不告诉用户就是「存了却少了一截」的静默数据丢失。 */
          const cut = r.ok && r.truncated ? `（超过 200 字，已截断保存，实际 ${r.bytes} 字节）` : ''
          toast(`${r.message || (r.ok ? '已保存' : '保存失败')}${cut}`)
          await load()
        } finally { setSaving('') }
      }

      /**
       * 扩展设置：读 / 写 / 递归渲染。
       *
       * 字段类型由扩展在 `plugin.json` 的 `config` 里声明，前端不猜：
       * string / number / boolean / select / array / object（嵌套最多两层）。
       * 敏感项（`secret: true`）永远拿不到明文，只显示「已设置 / 未设置」。
       */
      const openCfg = async (id) => {
        /** 再点一次同一个 = 收起；一次只展开一个，避免长列表里挂十几份表单。 */
        if (cfgFor === id) { setCfgFor(''); setCfgData(null); setCfgErr(''); return }
        setCfgFor(id); setCfgData(null); setCfgDraft({}); setCfgSecrets({}); setCfgErr('')
        const r = await EXT_POST('extensions.config.get', { id })
        setCfgData(r)
        setCfgDraft(r.values || {})
        if (!r.ok) setCfgErr(r.message || '读不到设置')
      }
      const cfgGet = (path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), cfgDraft)
      const cfgSet = (path, v) => {
        const next = { ...cfgDraft }
        let cur = next
        for (let i = 0; i < path.length - 1; i++) {
          const k = path[i]
          cur[k] = { ...(cur[k] && typeof cur[k] === 'object' && !Array.isArray(cur[k]) ? cur[k] : {}) }
          cur = cur[k]
        }
        cur[path[path.length - 1]] = v
        setCfgDraft(next)
      }
      const saveCfg = async (id) => {
        setCfgBusy(true); setCfgErr('')
        try {
          /** `undefined` = 不动；`''` = 清除；字符串 = 覆盖。三者不能混。 */
          const secrets = {}
          for (const [k, v] of Object.entries(cfgSecrets)) if (v !== undefined) secrets[k] = v
          const r = await EXT_POST('extensions.config.save', { id, values: cfgDraft, secrets })
          if (!r.ok) { setCfgErr(r.message || '保存失败'); return }
          toast(r.message || '已保存')
          /** 存完重读：后端会把默认值补齐，界面要和盘上一致。 */
          const fresh = await EXT_POST('extensions.config.get', { id })
          setCfgData(fresh)
          setCfgDraft(fresh.values || {})
          setCfgSecrets({})
        } finally { setCfgBusy(false) }
      }
      const labelStyle = { display: 'block', fontSize: 11, opacity: 0.7, marginBottom: 2 }
      const fieldBox = { marginTop: 8 }
      const renderCfgField = (f, parentPath = []) => {
        const path = [...parentPath, f.key]
        const k = path.join('.')
        if (f.secret) {
          const typed = cfgSecrets[f.key]
          const isSet = Boolean(cfgData?.secretSet?.[f.key])
          const state = typed === undefined ? (isSet ? '已设置（留空不改）' : '未设置')
            : typed === '' ? '保存后清除' : '保存后覆盖'
          return h('div', { key: k, style: fieldBox },
            h('span', { style: labelStyle }, `${f.label}${f.required ? ' *' : ''}`),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                className: 'roost-input', type: 'password', autoComplete: 'new-password',
                placeholder: isSet ? '已设置，留空不改' : '未设置',
                value: typed === undefined ? '' : typed,
                onChange: (e) => setCfgSecrets({ ...cfgSecrets, [f.key]: e.target.value }),
              }),
              isSet && typed === undefined
                ? h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: () => setCfgSecrets({ ...cfgSecrets, [f.key]: '' }),
                  }, '清除')
                : null,
            ),
            h('span', { style: { ...labelStyle, marginTop: 2 } }, state),
          )
        }
        if (f.type === 'object') {
          return h('fieldset', {
            key: k,
            style: { marginTop: 8, padding: '4px 8px 8px', border: '1px solid color-mix(in srgb, currentColor 18%, transparent)', borderRadius: 6 },
          },
            h('legend', { style: { fontSize: 11, opacity: 0.75, padding: '0 4px' } }, f.label),
            (f.properties || []).map((c) => renderCfgField(c, path)))
        }
        const val = cfgGet(path)
        let control = null
        if (f.type === 'boolean') {
          return h('label', { key: k, style: { ...fieldBox, display: 'flex', gap: 6, alignItems: 'center' } },
            h('input', {
              type: 'checkbox', checked: val === true,
              onChange: (e) => cfgSet(path, e.target.checked),
            }),
            h('span', null, f.label))
        }
        if (f.type === 'select') {
          const cur = val === undefined ? '' : String(val)
          /** 没有值又没默认值时补一个占位项：否则浏览器默认显示第一项，看着像已经选了。 */
          const known = (f.options || []).some((o) => o.value === cur)
          control = h('select', {
            className: 'roost-input', value: cur,
            onChange: (e) => cfgSet(path, e.target.value),
          },
            known ? null : h('option', { key: '__unset', value: '' }, '（未设置）'),
            (f.options || []).map((o) => h('option', { key: o.value, value: o.value }, o.label)))
        } else if (f.type === 'number') {
          control = h('input', {
            className: 'roost-input', type: 'number',
            min: f.min, max: f.max, step: f.integer ? 1 : 'any',
            value: val === undefined ? '' : String(val),
            onChange: (e) => cfgSet(path, e.target.value),
          })
        } else if (f.type === 'array') {
          /** 逐行一项：用逗号会吃掉用户正在输入的逗号，换行不会。 */
          control = h('textarea', {
            className: 'roost-input', rows: 3, style: { width: '100%' },
            placeholder: '每行一项',
            value: Array.isArray(val) ? val.join('\n') : '',
            onChange: (e) => cfgSet(path, e.target.value.split('\n')),
          })
        } else if (f.multiline) {
          /**
           * 清单里写了 `multiline: true` 的字符串：渲染成多行。
           *
           * 以前这类字段只能是单行 input，hint 写着「一行一个」却输不进
           * 第二行。值仍是**字符串**，不换成 array —— 换类型会让已经存着的
           * 字符串变非法值，用户下一次保存就把内容清空了。
           *
           * 旧宿主看不到这个标志，会走下面的单行分支，行为不变。
           */
          control = h('textarea', {
            className: 'roost-input', rows: 4, style: { width: '100%' },
            maxLength: f.maxLength,
            placeholder: f.placeholder || '',
            value: val === undefined ? '' : String(val),
            onChange: (e) => cfgSet(path, e.target.value),
          })
        } else {
          control = h('input', {
            className: 'roost-input', type: 'text', maxLength: f.maxLength,
            placeholder: f.placeholder || '',
            value: val === undefined ? '' : String(val),
            onChange: (e) => cfgSet(path, e.target.value),
          })
        }
        return h('div', { key: k, style: fieldBox },
          h('span', { style: labelStyle }, `${f.label}${f.required ? ' *' : ''}`),
          control,
          f.hint ? h('span', { style: { ...labelStyle, marginTop: 2 } }, f.hint) : null)
      }
      return h(Sec, {
        title: part === 'market' ? '扩展市场' : part === 'installed' ? '已装扩展' : '扩展市场 / 已装扩展',
        right: h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { load(); loadMarket(true, marketFilters()) },
        }, '刷新'),
      },
        ...(showMarket ? [
        h('div', { className: 'roost-note' },
          data?.enabled
            ? '总开关：开 —— 扩展说明会进 QQ 会话提示词。'
            : '总开关：关 —— 清单还在、已发令牌照常，只是不挂 usage section。去「权限 → 高级 · 新功能」打开「用户扩展」。'),
        data?.status?.authFailed
          ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } },
              `⚠ ${data.status.hintAuthFailed}：${(() => {
                /**
                 * 说清「是谁」和「下一步」。
                 *
                 * 以前固定一句「检查令牌是否被吊销或凭据缺失」——用户照着去查令牌，
                 * 而令牌往往是好的。真实原因按出现频率排：
                 *   1. 面板上把扩展停用了，DSH 里的进程还在跑（令牌已不被认）
                 *   2. 备份还原 / 换数据目录后 secrets 丢了，宿主重发了新令牌
                 *   3. 手动改过 api-clients.json
                 */
                const who = String(data.status.authFailedWho || '');
                const off = Array.isArray(data.status.disabledClients) ? data.status.disabledClients : [];
                if (who.startsWith('disabled ext:')) {
                  return `「${who.slice('disabled ext:'.length)}」已被停用，但它的进程可能还在跑（宿主已经不认它的令牌）。重新启用后要重启 DSH 才会生效；不打算再用了就卸载它，这行字会跟着记录一起消失。`;
                }
                if (off.length) {
                  return `这些扩展被停用了：${off.join('、')}。它们的进程如果还在跑就会一直 401 —— 重启 DSH 即可；不打算再用了就卸载，这行字会跟着消失。`;
                }
                if (who === 'unknown-token') {
                  return '令牌对不上（常见原因：备份还原后 secrets 丢了、手动改过、或者换了数据目录）。重新签发一次，再重启 DSH。';
                }
                if (who === 'no-token') return '扩展在调 /v1 但没带令牌，检查它的启动环境里有没有注入 DSH_ROOST_TOKEN。';
                return '检查令牌是否被吊销或凭据缺失。';
              })()}`)
          : null,
        data?.status?.regenerated
          ? h('div', { className: 'roost-note', style: { color: 'var(--warn)' } },
              `✓ ${data.status.hintRegenerated}：备份还原后 secrets 缺失，宿主已补发新令牌；旧令牌立即 401。`)
          : null,
        h('div', { className: 'roost-note', style: { marginTop: 8 } },
          '从插件市场安装或更新扩展。',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' } },
            h('span', { className: 'roost-faint' }, '数据源'),
            h('select', {
              className: 'roost-input',
              value: marketSrc,
              onChange: (e) => setMarketSrc(e.target.value),
            },
            h('option', { value: 'github' }, 'GitHub（官方）'),
            h('option', { value: 'gitee' }, 'Gitee（镜像，国内更稳）'),
            h('option', { value: 'custom' }, '自建 / 自定义地址')),
            marketSrc === 'custom'
              ? h('input', {
                  className: 'roost-input',
                  style: { minWidth: 260 },
                  placeholder: 'https://…/index.json',
                  value: marketSrcUrl,
                  onChange: (e) => setMarketSrcUrl(e.target.value),
                })
              : null,
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: marketBusy === 'source',
              onClick: saveSource,
            }, marketBusy === 'source' ? '切换中…' : '应用'),
            marketSrcInfo?.indexUrl
              ? h('span', { className: 'roost-faint', style: { wordBreak: 'break-all' } },
                  `当前：${marketSrcInfo.indexUrl}`)
              : null,
          ),
          h('div', { className: 'roost-faint', style: { marginTop: 4 } },
            'GitHub 拉不动（提示「连接被重置」）时换成 Gitee：同一份仓库的镜像，索引内容一样。'),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: marketBusy === 'list',
              onClick: () => loadMarket(true, marketFilters()),
            }, marketBusy === 'list' ? '拉取中…' : '刷新市场'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: !!marketBusy,
              onClick: checkUpdates,
            }, marketBusy === 'updates' ? '检查中…' : '检查更新'),
            market?.repo ? h('span', { className: 'roost-code' }, `${market.repo}@${market.branch}`) : null,
          ),
          /** 5.6：搜索 / 分类 / 标签，条件交给服务端筛 */
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' } },
            h('input', {
              className: 'roost-input', style: { flex: '1 1 200px' },
              placeholder: '搜名字 / id / 描述 / 标签 / 作者',
              value: marketQuery, onChange: (e) => setMarketQuery(e.target.value),
            }),
            h('select', {
              className: 'roost-input', style: { flex: '0 1 170px' },
              value: marketCategory, onChange: (e) => setMarketCategory(e.target.value),
            },
              h('option', { value: '' }, `全部分类${market?.total ? `（${market.total}）` : ''}`),
              (market?.facets?.categories || []).map((c) =>
                h('option', { key: c.value, value: c.value }, `${c.value}（${c.count}）`))),
            marketTag
              ? h('button', {
                  type: 'button', className: 'roost-btn',
                  onClick: () => setMarketTag(''),
                }, `标签：${marketTag} ×`)
              : null,
            h('span', { className: 'roost-note', style: { margin: 0 } },
              market ? `显示 ${(market.rows || []).length} / ${market.total ?? 0} 条` : ''),
          ),
          /** 5.6：下载 / 校验 / 落位分阶段显示，不再只是一个转圈 */
          marketProgress && marketProgress.phase !== 'idle'
            ? h('div', { style: { marginTop: 8 } },
                h('div', { className: 'roost-note' },
                  `${marketProgress.label || marketProgress.phase} · ${marketProgress.message || marketProgress.id}`),
                h('div', {
                  style: {
                    height: 6, marginTop: 4, borderRadius: 3, overflow: 'hidden',
                    background: 'var(--line, rgba(128,128,128,.3))',
                  },
                }, h('div', {
                  style: {
                    width: `${Number(marketProgress.percent) || 0}%`, height: '100%',
                    background: 'var(--good, #3b82f6)', transition: 'width .3s',
                  },
                })),
              )
            : null,
          market && !market.ok
            ? h('div', { style: { color: 'var(--bad)', marginTop: 4 } }, market.message || '索引拉取失败')
            : null,
          (market?.rows || []).length
            ? h('div', { className: 'roost-list', style: { marginTop: 6 } },
                market.rows.map((x) => h('div', { key: x.id, className: 'ext-row' },
                  h('span', { className: 't' },
                    `${x.name} · ${x.id}`,
                    h('span', { className: 'd' }, ` · ${x.category || '其它'} · ${x.transport}${x.author ? ` · ${x.author}` : ''}`),
                    x.revoked ? h('span', { className: 'd', style: { color: 'var(--bad)' } }, ' · 已撤回') : null,
                    x.updateAvailable ? h('span', { className: 'd', style: { color: 'var(--warn)' } }, ' · 有更新') : null,
                    /** 等级徽章：装之前就能看出这个扩展会碰到什么（ext-tier.js 现算，作者虚标不了） */
                    x.tierLabel
                      ? h('span', {
                          className: 'd',
                          style: {
                            color: tierColorOf(x.tierColor),
                            border: '1px solid currentColor', borderRadius: 4,
                            padding: '0 5px', fontSize: 10.5, lineHeight: '16px',
                          },
                          title: x.tierSummary || `权限等级 ${x.tier}`,
                        }, `权限 ${x.tier} · ${x.tierLabel}`)
                      : null,
                  ),
                  x.description ? h('span', { className: 'd' }, x.description) : null,
                  /** 逐条人话后果，不只是英文 scope 名；最多摆 3 条，全量在确认弹窗 */
                  (x.risks || []).length
                    ? h('span', { className: 'd', style: { display: 'block', marginTop: 3, color: tierColorOf(x.tierColor) } },
                        `⚠ ${x.risks.slice(0, 3).map((r) => r.text).join('；')}`
                        + (x.risks.length > 3 ? ` 等 ${x.risks.length} 项` : ''))
                    : null,
                  /** 能力标签：点一下就只看这个标签，再点一下取消 */
                  (x.tags || []).length
                    ? h('span', {
                        className: 'd',
                        style: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 },
                      }, x.tags.map((t) => h('button', {
                        key: t, type: 'button', className: 'roost-btn',
                        style: {
                          padding: '1px 6px', fontSize: 10.5,
                          ...(marketTag === t ? { fontWeight: 650, borderColor: 'var(--accent, #3b82f6)' } : {}),
                        },
                        title: `只看「${t}」标签`,
                        onClick: () => setMarketTag(marketTag === t ? '' : t),
                      }, t)))
                    : null,
                  x.revoked
                    ? h('span', { className: 'd' }, '拒绝安装')
                    /**
                     * 已装且无更新：后端会直接回「已是最新版」，只有明确「强制重装」
                     * 才带 force。用二次确认挡住误点 —— 切页签回来手滑点一下，
                     * 不该变成重下一遍整仓 tar.gz + 重启扩展连接。
                     */
                    : x.installed && !x.foreign && !x.updateAvailable
                      ? h(ConfirmLink, {
                          label: '重装', confirmLabel: '确认强制重装', danger: false,
                          style: { marginTop: 6 },
                          disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                          onConfirm: () => marketAct('extensions.market.install', x.id, { force: true }),
                        })
                      : x.foreign
                        /**
                         * 手写目录：**允许用官方版替换**（二次确认，服务端先整目录备份）。
                         *
                         * 以前这里写死禁用 + 「用户手写 · 不覆盖」，而判据只看有没有
                         * `.source.json` —— 整目录拷进来的官方扩展同样没有那个文件，
                         * 用户会卡在「既换不成官方版、也卸载不掉」。
                         */
                        ? h(ConfirmLink, {
                            label: '用官方版替换',
                            confirmLabel: '确认替换（先备份）',
                            disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                            onConfirm: () => marketAct('extensions.market.install', x.id, { takeOver: true }),
                          })
                        : h('button', {
                            type: 'button', className: 'roost-btn', style: { marginTop: 6 },
                            disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                            onClick: () => marketAct('extensions.market.install', x.id),
                          }, x.installed ? '更新' : '安装'),
                  x.installed
                    ? h(ConfirmLink, {
                        label: '卸载',
                        confirmLabel: x.foreign ? '确认删除（先备份）' : '确认卸载',
                        disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                        /** 手写目录要 force：服务端会先备份到 data/backups/ 再删 */
                        onConfirm: () => marketAct('extensions.market.remove', x.id, x.foreign ? { force: true } : {}),
                      })
                    : null,
                  /**
                   * 「停用」只吊销令牌、不动文件，手写扩展同样该有 —— 以前用
                   * `!x.foreign` 挡掉，等于手写扩展连停都停不了。
                   */
                  x.installed && !x.revoked
                    ? h('button', {
                        type: 'button', className: 'roost-btn', style: { marginTop: 6, marginLeft: 6 },
                        disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                        onClick: () => setRevokeAsk(x.id),
                      }, '停用')
                    : null,
                )),
              )
            : (market && market.ok === false
              /**
               * 拉取失败时**不能**说「市场里还没有扩展条目」——那句话是在
               * 描述「索引拉到了、里面是空的」，而这里根本没拉到。用户看到
               * 上面一行红字 + 下面一句「还没有条目」，会以为市场真的没东西。
               */
              ? h('div', { className: 'roost-empty', style: { color: 'var(--bad)' } },
                `索引没拉到：${market.message || '原因不明'}。上面的红字是具体错误；网络恢复后点「刷新市场」重试。`)
              : market ? h('div', { className: 'roost-empty' },
                (marketQuery || marketCategory || marketTag)
                  ? '当前筛选下没有条目，换个词或清掉筛选。'
                  : '市场里还没有扩展条目。') : null),
        ),
        ] : []),
        ...(showInstalled ? [
        h('div', { className: 'roost-diag-h', style: { marginTop: 12 } }, '已装扩展'),
        /**
         * 有目录、但清单不合格的扩展：`list()` 会静默跳过，面板就只剩一句
         * 「还没有东西」，用户根本不知道自己的扩展怎么了。把原因直接摆出来。
         */
        (data?.problems || []).length
          ? h('div', { className: 'roost-note', style: { color: 'var(--bad)', marginTop: 4 } },
              `⚠ ${data.problems.length} 个扩展在目录里但清单不合格，已从列表与导航隐藏：`
              + data.problems.map((x) => `${x.id}（${(x.errors || []).join('；')}）`).join('；')
              + '。修好它的 plugin.json 再刷新即可。')
          : null,
        (data?.rows || []).length
          ? h('div', { className: 'roost-list' },
              data.rows.map((x) => h('div', { key: x.id, className: 'ext-row' },
                h('span', { className: 't' },
                  `${x.name} · ${x.id}`,
                  h('span', { className: 'd' }, ` · ${x.bytes} 字节 / ${x.chars} 字（单条上限 ${x.cap} 字）`),
                  h('span', { className: 'd' }, x.foreign ? ' · 用户手写' : ' · 市场装'),
                  x.locallyModified ? h('span', { className: 'd', style: { color: 'var(--warn)' } }, ` · ${x.label}`) : null,
                  x.sha256Valid ? h('span', { className: 'd' }, ' · 校验和有效') : null,
                  /** 令牌实际拿到的 scope：清单写的和实际授的可能不一样，必须看得见。 */
                  h('span', { className: 'd' }, x.scopes
                    ? ` · 权限：${x.scopes.length ? scopesText(x.scopes) : '（无）'}`
                    : ' · 权限：尚未发令牌'),
                  /** 已装页按实际授予的 scopes 现算等级，不是看清单上写什么 */
                  x.tier?.label
                    ? h('span', {
                        className: 'd',
                        style: {
                          color: tierColorOf(x.tier.color),
                          border: '1px solid currentColor', borderRadius: 4,
                          padding: '0 5px', fontSize: 10.5, lineHeight: '16px',
                        },
                        title: x.tier.summary || '',
                      }, `${x.tier.id} · ${x.tier.label}`)
                    : null,
                ),
                h('textarea', {
                  className: 'roost-input', rows: 2, style: { width: '100%', marginTop: 6 },
                  value: drafts[x.id] ?? '', spellCheck: false, disabled: x.foreign,
                  onChange: (e) => setDrafts({ ...drafts, [x.id]: e.target.value }),
                }),
                h('div', { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' } },
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: saving === x.id || x.foreign, onClick: () => save(x.id),
                  }, x.foreign ? '用户手写 · 只读' : '保存 usage'),
                  x.hasConfig && !x.foreign
                    ? h('button', {
                        type: 'button', className: 'roost-btn',
                        disabled: cfgBusy, onClick: () => openCfg(x.id),
                      }, cfgFor === x.id ? '收起设置' : '设置')
                    : null,
                ),
                cfgFor === x.id && cfgData
                  ? h('div', {
                      style: {
                        marginTop: 8, paddingTop: 8,
                        borderTop: '1px dashed color-mix(in srgb, currentColor 20%, transparent)',
                      },
                    },
                      h('div', { className: 'roost-diag-h' }, `设置 · ${x.id}`),
                      cfgErr ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } }, cfgErr) : null,
                      !cfgData.spec || !cfgData.spec.length
                        ? h('div', { className: 'roost-empty' }, cfgData.message || '这个扩展没有声明设置项')
                        : h('div', null,
                            cfgData.spec.map((f) => renderCfgField(f)),
                            h('div', { style: { marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' } },
                              h('button', {
                                type: 'button', className: 'roost-btn',
                                disabled: cfgBusy || !cfgData.canEdit,
                                onClick: () => saveCfg(x.id),
                              }, cfgBusy ? '保存中…' : '保存设置'),
                              h('span', { className: 'roost-note' },
                                cfgData.canEdit
                                  ? '保存后需要重连（或重启 DSH）才生效'
                                  : '用户手写的扩展只读'),
                            ),
                          ),
                    )
                  : null,
              )),
            )
          : h('div', { className: 'roost-empty' }, '还没有扩展写过记忆（装好的扩展会出现在左侧导航；这里只列它们进提示词的说明）。'),
        h('div', {
          className: 'roost-note',
          /** 合计预算 2048 字节（与 `ext-usage.js` 的 USAGE_TOTAL_BYTE_LIMIT 对齐）。超了进提示词会被截，必须当场说。 */
          style: (data?.totalBytes ?? 0) > 2048 ? { color: 'var(--warn)' } : undefined,
        },
          `合计 ${data?.totalBytes ?? 0} 字节${(data?.totalBytes ?? 0) > 2048
            ? '（已超过合计 2048 字节预算，超出部分进提示词时会被截掉，请精简）'
            : '（合计预算 2048 字节）'}。`),
        h('div', { style: { marginTop: 8 } },
          h(ConfirmLink, {
            label: '清空扩展记忆', confirmLabel: '确认清空（只删扩展自己的记忆）',
            onConfirm: async () => {
              const r = await EXT_POST('extensions.memory.clear', { confirm: true })
              toast(r.message || (r.ok ? '已清除' : '清除失败'))
            },
          }),
        ),
        ] : []),

        /** 两个 ask 互斥：万一都非空，只显示停用确认，避免两层遮罩叠着误点「授权并安装」 */
        scopeAsk && !revokeAsk
          ? h(ConfirmModal, {
              title: scopeAsk.tierLabel
                ? `扩展权限 · ${scopeAsk.tier} ${scopeAsk.tierLabel}`
                : '扩展索要敏感权限',
              /** 后端 installNotice() 的人话风险全文优先，英文 scope 只作附录 */
              message: (scopeAsk.message
                || `扩展「${scopeAsk.id}」索要：\n\n${scopesText(scopeAsk.scopes)}`)
                + (scopeAsk.scopes?.length ? `\n\n申请的 scope：${scopesText(scopeAsk.scopes)}` : '')
                + (scopeAsk.confirm === 'type-name'
                  ? '' : '\n\n确认授权并安装？'),
              /** L3 核心接管：必须手打扩展 id，不给「点一下就授权」 */
              extra: scopeAsk.confirm === 'type-name'
                ? h('div', { style: { padding: '0 12px 12px' } },
                    h('span', { style: { display: 'block', fontSize: 11, opacity: 0.75, marginBottom: 4 } },
                      `请输入扩展 id「${scopeAsk.id}」确认接管风险：`),
                    h('input', {
                      className: 'roost-input', value: tierTyped, spellCheck: false,
                      placeholder: scopeAsk.id,
                      onChange: (e) => setTierTyped(e.target.value),
                    }))
                : null,
              confirmText: scopeAsk.confirm === 'type-name' ? '我已确认，授权并安装' : '授权并安装',
              danger: true, busy: scopeBusy,
              onClose: () => {
                if (scopeBusy) return
                setScopeAsk(null)
                setTierTyped('')
                toast('已取消安装（未授权）')
              },
              onConfirm: confirmScopeAct,
            })
          : null,
        revokeAsk
          ? h(ConfirmModal, {
              title: '停用扩展',
              message: `停用「${revokeAsk}」后会禁止它的工具运行，已装文件保留，可再装回来。`,
              confirmText: '停用', danger: true, busy: marketBusy === revokeAsk,
              onClose: () => { if (marketBusy !== revokeAsk) setRevokeAsk(null) },
              onConfirm: () => revokeMarket(revokeAsk),
            })
          : null,
      )
    }

    /**
     * 「加载更多」的合并规则（纯函数，单测直接调）。
     *
     * `base` 是**发请求那一刻**的快照。请求在途时列表可能被新建 / 吊销重置过
     * （它们也调 `load()`），拿旧 `base` 覆盖会把已吊销的行写回去、行数也会多。
     * 所以两个前提不成立就返回 `null`，由调用方丢掉这份响应：
     *   · 当前行数必须还是发请求时那个数（没被重置过）；
     *   · 服务端 `total` 必须没变（没人在期间增删）。
     *
     * 合并按 id 去重：offset 分页在「期间增删」时必然错位，去重至少不会重复渲染
     * （重复 key 会让 React 报错、也会让计数看起来不对）。
     */
    function mergeClientPage(cur, page, base) {
      const curRows = (cur && cur.rows) || []
      if (!cur || curRows.length !== base.length) return null
      if (Number(page.total) !== Number(cur.total)) return null
      const seen = new Set(base.map((c) => c.id))
      return {
        ...cur,
        total: Number(page.total) || 0,
        limit: Number(page.limit) || 20,
        hasMore: Boolean(page.hasMore),
        rows: [...curRows, ...((page.rows || []).filter((c) => !seen.has(c.id)))],
      }
    }

    /** 接入页：发放带 agent:write 的客户端令牌（阶段 3 缺口 2 的落点）。 */
    function ExtClientsBlock({ toast }) {
      const [data, setData] = useState(null)
      const [name, setName] = useState('')
      /** §7 最小授权：默认一个 scope 都不给，高权限要单独勾 + 二次确认。 */
      const [scopes, setScopes] = useState([])
      const [confirm, setConfirm] = useState(false)
      const [issued, setIssued] = useState(null)
      const [busy, setBusy] = useState(false)
      const [moreBusy, setMoreBusy] = useState(false)
      /**
       * 列表分页。
       *
       * 一个扩展一个 `ext:<id>` 令牌，装得多的机器这张表会很长；`limit=20`
       * 一页，`offset` 往后翻。**新建 / 吊销之后一律从第 0 页重来**：分页状态
       * 留着会让「刚发的令牌」落到看不见的页上，看起来像没发出去。
       */
      /** 关键词（后端按名字 / id / scope 过滤）。空串 = 不过滤 */
      const [q, setQ] = useState('')
      /** 列表请求在途：防连点 / 连按回车打出多个请求 */
      const [listBusy, setListBusy] = useState(false)
      /** 请求序号：慢的旧响应不许盖掉新的一次搜索（「清空」后尤其明显） */
      const listSeq = useRef(0)
      const load = async ({ append = false, q: qOverride } = {}) => {
        /** `qOverride` 给「清空」用：`setQ` 之后这次渲染的闭包还是旧值 */
        const term = qOverride === undefined ? q : qOverride
        const base = append && data ? (data.rows || []) : []
        const seq = ++listSeq.current
        setListBusy(true)
        try {
          const r = await EXT_POST('extensions.clients.list', { limit: 20, offset: base.length, q: term })
          if (seq !== listSeq.current) return
          if (r?.ok === false) { toast(r.message || '读不到令牌列表'); return }
          if (!append) {
            setData({
              availableScopes: r.availableScopes || [],
              total: Number(r.total) || 0,
              limit: Number(r.limit) || 20,
              hasMore: Boolean(r.hasMore),
              rows: r.rows || [],
            })
            return
          }
          /** 条数变了说明期间增删过，offset 已经不可信：退回第 0 页重来一遍 */
          if (data && Number(r.total) !== Number(data.total)) {
            await load()
            return
          }
          /** 函数式更新：用**当前** state 合并，不能用闭包里那份旧快照 */
          setData((cur) => mergeClientPage(cur, r, base) || cur)
        } finally {
          /** 只有最新那次才复位忙态：否则先回来的旧请求会把按钮提前放开 */
          if (seq === listSeq.current) setListBusy(false)
        }
      }
      useEffect(() => { load() }, [])
      const create = async () => {
        setBusy(true)
        try {
          const r = await EXT_POST('extensions.clients.create', { name, scopes, confirm })
          toast(r.message || (r.ok ? '已生成' : '生成失败'))
          if (r.ok) { setIssued(r); setName(''); setScopes([]); setConfirm(false) }
          await load()
        } finally { setBusy(false) }
      }
      const revoke = async (id) => {
        const r = await EXT_POST('extensions.clients.revoke', { id })
        toast(r.message || (r.ok ? '已吊销' : '吊销失败'))
        await load()
      }
      const toggle = (s) => setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s])
      /** A4：原来一页一张卡，「发令牌」和「管令牌」挤在一起；拆成两张，控件一个不少 */
      return h('div', null,
        h(Sec, { n: '01', title: '扩展 /v1 客户端令牌' },
        h('div', { className: 'roost-note' },
          '独立会话的 agent.* 需要 agent:write。默认最小授权（不给任何 scope）；勾高权限 scope 还要再勾一次「我确认授予」。令牌只存 hash，明文只显示一次；扩展令牌由安装/卸载自动管理，不在这里发。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            className: 'roost-input', placeholder: '客户端名字（可留空）', value: name,
            onChange: (e) => setName(e.target.value),
          }),
          h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: create }, '生成令牌'),
        ),
        h('div', { className: 'roost-list' },
          (data?.availableScopes || []).map((s) => h('label', { key: s, className: 'roost-item', style: { display: 'inline-flex', gap: 4, marginRight: 10 } },
            h('input', { type: 'checkbox', checked: scopes.includes(s), onChange: () => { toggle(s); setConfirm(false) } }),
            h('span', { className: 'roost-code' }, s + scopeNote(s)),
          )),
        ),
        h('label', { className: 'roost-note', style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: confirm, onChange: (e) => setConfirm(e.target.checked) }),
          '我确认授予高权限 scope（agent:write / say:write / prompt:write / config:write / group:write / proactive:write）',
        ),
        issued
          ? h('div', { className: 'roost-note', style: { color: 'var(--ok)' } },
              `只显示这一次：${issued.id} / ${issued.token}`,
              h('br'),
              '把它填到扩展的启动环境里；刷新页面后就再也读不出来了。')
          : null,
        ),
        h(Sec, { n: '02', title: '已经发出去的令牌' },
          h('div', { className: 'roost-note' },
            '明文只在生成时显示一次，服务端只存 hash。这里能吊销的是面板发放的令牌；扩展自己的由安装 / 卸载自动管理，不在这里发。'),
          /**
           * 搜索框。后端一直支持 `q`（名字 / id / scope 子串），但前端没入口，
           * 等于白做（2026-11 复核）。回车才发请求，别每敲一个字打一次。
           */
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' } },
            h('input', {
              /** 后端只匹配 name / id（`ext-panel.js` 的 `q`），别在文案里承诺 scope */
              className: 'roost-input', placeholder: '按名字 / id 搜（回车）', value: q,
              style: { flex: 1, minWidth: 160 },
              onChange: (e) => setQ(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !listBusy) load() },
            }),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: listBusy,
              onClick: () => { if (!listBusy) load() },
            }, listBusy ? '搜…' : '搜索'),
            q
              ? h('button', {
                  type: 'button', className: 'roost-btn',
                  /** 显式把空串传给这一趟，别依赖 `setQ` 之后的新渲染 */
                  onClick: () => { setQ(''); load({ q: '' }) },
                }, '清空')
              : null,
          ),
          (data?.rows || []).length
            ? h('div', { className: 'roost-list' },
                data.rows.map((c) => h('div', { key: c.id, className: 'roost-item' },
                  h('span', { className: 't' },
                    `${c.name} · ${c.id}`,
                    h('span', { className: 'd' }, ` · ${c.kind === 'ext' ? '扩展自动管理' : '面板发放'} · ${(c.scopes || []).join('、') || '无 scope'}`),
                  ),
                  c.kind === 'panel'
                    ? h(ConfirmLink, { label: '吊销', confirmLabel: '确认吊销', onConfirm: () => revoke(c.id) })
                    : null,
                )),
              )
            : h('div', { className: 'roost-empty' }, '还没有客户端。'),
          /**
           * 分页脚：只有真超过一页才出现，否则「共 N 条」这种文案纯属噪音。
           * `total` 是**过滤后**的总数（关键词搜过的也是它），不是全库条数。
           */
          (data?.total || 0) > (data?.limit || 20)
            ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
                h('span', { className: 'roost-muted', style: { fontSize: 10.5 } },
                  `已显示 ${(data.rows || []).length} / ${data.total} 条`),
                data.hasMore
                  ? h('button', {
                      type: 'button', className: 'roost-btn', disabled: moreBusy,
                      onClick: async () => {
                        setMoreBusy(true)
                        try { await load({ append: true }) } finally { setMoreBusy(false) }
                      },
                    }, moreBusy ? '翻…' : '加载更多')
                  : null,
              )
            : null,
        ),
      )
    }

    /* ---------------- 日志 ---------------- */

    /**
     * 扩展独立页（2026-11-11）：装扩展是一整条动线 —— 档位 → 说明 → 令牌，
     * 原先散在 能力 / 设置 / 接入 三页，也不该跟工具白名单挤在「能力」里。
     */
    /**
     * 表达：语音 + 表情包。
     *
     * 这两块原来是「设置」里的第 04、05 节，但它们跟「配置文件在哪」没有关系——
     * 说的都是**她怎么出声、怎么发表情**。放在一起，找语音的人不用再滚配置全文。
     */
    /**
     * 表达：语音与表情包**分成两页**（2026-11-13），但共用这一个组件。
     *
     * `part` 决定渲染哪半边：
     *   · `'voice'`  只有语音合成（TTS 那套，也是「说话」这一侧）
     *   · `'sticker'` 只有表情包目录
     *   · 不传 = 两块都渲染（老入口/单测走这条，行为与拆分前一致）
     *
     * 为什么拆：一页塞两块互不相干的东西，找语音要往下滚过表情目录。
     * tab key `express` 保持不变，老 `localStorage['roost.tab']` 照样落在语音这页。
     */
    /**
     * 图库：**一个入口，三个分区**。
     *
     * 合并前这里是三块卡：「表情库」（按文件列，上传 / 批删 / 补标签）、
     * 「图库」（按序号列，回收站 / 固定 / 让 AI 整理）、「官方素材池」（线上层）。
     * 同一批图三个页面、两套删除语义、两套标注入口——用户得记住「改标签去 A 页、
     * 改名字去 B 页」，而模型那边还同时收到两套互斥的发图写法。
     *
     * 现在只剩这一个组件，三个分区：
     *
     *   · **图片**：序号 + 文件名 + 描述。上传、补标签、让 AI 整理、改标注、
     *     停用、固定、多选撤下，全在这一屏；
     *   · **线上**：官方素材池。发过的图默认留一份，第二次发不重传；
     *   · **回收站**：撤下的图。能恢复，也能彻底删除（真删文件）。
     *
     * **能力一件没少**：每个按钮还是原来那个接口，只是换了位置。删除语义收敛成
     * 一条线——图片区「撤下」进回收站（可恢复），回收站「彻底删除」才真删文件。
     */
    function GalleryPage({ toast, config, saveCfg }) {
      const [view, setView] = useState('pics')
      const tabs = [['pics', '图片'], ['online', '线上'], ['trash', '回收站']]
      const hint = view === 'online'
        ? '官方图床那份：发过的图默认留一份，第二次发不用重传；配额满了按「最久没动过」淘汰，固定的不碰。'
        : view === 'trash'
          ? '撤下的图文件还在，点「恢复」就能回来；「彻底删除」才会真删文件，恢复不了。'
          : '她发图只写序号，路径由宿主去换。上传、改标注、补标签、固定、停用都在这儿。'
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 } },
          tabs.map(([k, label]) => h('button', {
            key: k,
            type: 'button',
            className: 'roost-btn' + (view === k ? ' roost-btn-primary' : ''),
            onClick: () => setView(k),
          }, label)),
          h('span', { className: 'roost-note', style: { margin: 0, flex: '1 1 220px' } }, hint)),
        view === 'online'
          ? h(MediaPoolCard, { toast, n: '02' })
          /**
           * `key={view}`：换分区 = 换一份清单，页码 / 搜索 / 分类 / 勾选全部归零。
           *
           * 不加 key 的话组件实例会被复用：在图片区翻到第 3 页再点回收站，
           * 请求带的是 `page=3`，而回收站可能只有 1 页——`pageOf` 会把页码夹回去，
           * 但中间那一瞬是「回收站是空的」，看着就像没内容。更烦的是搜索词和
           * 分类筛选会跨区带过去，回收站里搜不到东西也说不清为什么。
           */
          : h(GalleryCard, { key: view, toast, n: '02', view, config, saveCfg }),
      )
    }

    /**
     * 图库里「一屏图」的那块（图片 / 回收站共用，`view` 决定看哪边）。
     *
     * 按**序号**列：序号是模型唯一要抄的东西，也是它认得出哪张、认不出哪张的
     * 依据。所以最要紧的三样是 `#序号`、有没有描述、以及「让 AI 整理」那个按钮。
     *
     * 「让 AI 整理」是**增量**的：只挑 `name` 和 `meaning` 都为空的图去问模型。
     * 几百张全跑一遍是几百次视觉调用，第一次点可能要等，第二次点应该秒完成。
     * 所以按钮文案要诚实说明「每张问一次模型」——不然用户会以为卡住了。
     */
    function GalleryCard({ toast, n = '02', view = 'pics', config, saveCfg }) {
      const [data, setData] = useState(null)
      const [page, setPage] = useState(1)
      /** 每页几张：原来「表情库」那张卡有 12/24/48/96，合并后保留 */
      const [size, setSize] = useState(24)
      const [cat, setCat] = useState('')
      const [q, setQ] = useState('')
      /**
       * 回收站不再是一个页内 checkbox，而是外层分区（`view === 'trash'`）。
       *
       * 以前「表情库」和「图库」是两页，各有各的删除语义（真删文件 / 进回收站）；
       * 合成一页之后只剩一套：图片区「撤下」= 进回收站，回收站里「彻底删除」
       * 才真删文件。同一个东西只有一个删除入口，误触成本才降得下来。
       */
      const trash = view === 'trash'
      const [busy, setBusy] = useState(false)
      const [job, setJob] = useState(null)
      /**
       * 「全部重做」：连已经有名字/描述的一起重跑。
       *
       * 为什么需要它：整理是增量的，只挑「name 和 meaning 都为空」的图。
       * 但描述写歪了、标签全是文件名拆出来的词、换了更会看图的模型——
       * 这些情况下增量永远够不着那张图，用户只能一张张手改。
       */
      const [redoAll, setRedoAll] = useState(false)
      const [editFor, setEditFor] = useState(0)
      const [draft, setDraft] = useState({})
      /** 多选：存序号（撤下 / 彻底删除都按序号提交，不走相对路径） */
      const [picked, setPicked] = useState([])
      /**
       * 批量模式。
       *
       * 原来是每张图左下角一个小复选框——缩略图只有 140px 宽，那个框既难点
       * （14px 见方）又和「停用 / 固定」角标挤在一起，手机上基本点不中。
       * 改成显式开关：打开之后整张卡片就是目标，点哪儿都算选中；同时把
       * 「改 / 停用 / 固定 / 撤下」这些单张按钮藏起来——批量的时候它们
       * 只会被误触，用户已经用不到「这一张」的语义了。
       */
      const [selecting, setSelecting] = useState(false)
      /** 批量改名弹层：统一改名字前缀 / 标签，名字可自动加序号 */
      const [bulk, setBulk] = useState(null)
      /** 补标签任务（规则补全，沿用 `/stickers/tags/job` 那条通道） */
      const [tagJob, setTagJob] = useState(null)
      /**
       * 缩略图：`seq → objectURL`（本次会话现生成的那份）。
       *
       * 服务端已经有缓存的不进这里，直接用 `/gallery/thumb?seq=N`（长缓存）。
       * 这里存的是「刚用 canvas 压出来的」，它的价值在于**当场就能显示**，
       * 不用等回传落盘再取一遍。
       */
      const [thumbs, setThumbs] = useState({})
      /**
       * `thumbs` 的同步镜像。
       *
       * `load()` 里要「把不在新一页的 objectURL 释放掉」，但它在 `useCallback`
       * 里，闭包拿到的 `thumbs` 可能是旧的。**不能**把释放写进 `setThumbs`
       * 的 updater——updater 必须是纯函数（严格模式下会跑两遍），revoke 这种
       * 副作用放进去等于赌「重复调用无害」。所以用一个 ref 跟着 state 走。
       */
      const thumbsRef = useRef({})
      /** state 是唯一真相，ref 每次渲染后跟一份（见上面的说明） */
      useEffect(() => { thumbsRef.current = thumbs }, [thumbs])
      /**
       * 已经排进生成队列的序号。
       *
       * `data` 一变（翻页、同步、随便刷一下）下面的 effect 就会重跑，
       * 没有这个集合会把同一张大图反复解码——那是整页最贵的一步。
       */
      const thumbQueued = useRef(new Set())
      /**
       * 「起名用的模型」下拉的候选清单。`null` = 还在读（要逐个 provider 问
       * 能力，慢），`[]` = 读不到——面板退回「跟随聊天模型」一项。
       */
      const [models, setModels] = useState(null)
      /** 上传时统一填的名字（只对单张有效；多张时各用各的原文件名） */
      const [newName, setNewName] = useState('')

      /**
       * 整理进度里「上次看到第几张」。
       *
       * aurabot 每跑 5 张就把列表刷一次（新起的名字能早点看到）。这里也这么干，
       * 但只在 `running` 期间——跑完那一次由 `load(1)` 负责，别重复请求。
       */
      const seenDone = useRef(0)

      const load = useCallback(async (p = page) => {
        const qs = new URLSearchParams({ page: String(p), size: String(size) })
        if (cat) qs.set('category', cat)
        if (q.trim()) qs.set('q', q.trim())
        if (trash) qs.set('trash', '1')
        const r = await get('/gallery?' + qs.toString())
        if (r.ok === false) return toast(r.message || '读不到图库')
        setData(r)
        /** 翻页 / 换筛选之后旧的勾选不该留着：那张已经不在这一页了 */
        setPicked([])
        /**
         * 上一批「现压的 objectURL」已经没有任何 `<img>` 引用了。不 revoke 就是
         * 只增不减的内存（几百张虽只几 MB，但永远不还）。
         *
         * 顺手把它们从「已排队」里放掉：如果那一张其实**没回传成功**（宿主没重启、
         * 写入失败），回到这一页时才会重新压一次；回传成功的那些 `it.thumb` 已经是
         * true，不会再进队列，不会白跑。
         *
         * 释放写在 updater **外面**：updater 要能被重复调用（严格模式会跑两遍），
         * 里面做 revoke 就是赌「重复释放无害」。
         */
        const prev = thumbsRef.current || {}
        const keep = new Set(r.items.map((x) => Number(x.seq)))
        const next = {}
        for (const [k, v] of Object.entries(prev)) {
          if (keep.has(Number(k))) {
            next[k] = v
            continue
          }
          if (String(v).startsWith('blob:')) {
            try { URL.revokeObjectURL(v) } catch { /* 已经释放过 */ }
          }
          thumbQueued.current.delete(Number(k))
        }
        thumbsRef.current = next
        setThumbs(next)
      }, [page, size, cat, q, trash])

      useEffect(() => { load(page) }, [page, size, cat, q, trash])

      /**
       * 面板刚打开时接上宿主里还在跑的后台任务。
       *
       * 对齐 aurabot 的 `caption-status` 初次查询：整理 / 补标签都是宿主侧的
       * 后台任务，用户关掉面板再打开时它们可能才跑到一半。不查这一次的话，
       * 按钮看起来「还能再点」（点了 409），进度条和失败原因也全丢了。
       */
      useEffect(() => {
        let live = true
        get('/gallery/organize/job').then((r) => {
          if (live && r?.job?.running) {
            seenDone.current = Number(r.job.done) || 0
            setJob(r.job)
          }
        }).catch(() => {})
        get('/stickers/tags/job').then((r) => {
          if (live && r?.job?.running) setTagJob(r.job)
        }).catch(() => {})
        return () => { live = false }
      }, [])

      /**
       * 「起名用的模型」的候选清单。
       *
       * 走 `model.list`（和「模型」页同一份缓存）：它要逐个 provider 问能力，
       * 慢但不常变。只在图片区拉一次，回收站里用不到。
       */
      useEffect(() => {
        if (view !== 'pics') return undefined
        let live = true
        post('/quick', { op: 'model.list', arg: {}, chatId: '' })
          .then((r) => {
            if (!live) return
            setModels(r && r.ok !== false && Array.isArray(r.list) ? r.list : [])
          })
          .catch(() => { if (live) setModels([]) })
        return () => { live = false }
      }, [view])

      /**
       * 把一张大图压成 320px 宽的 JPEG，回传服务端，返回本次会话可用的 URL。
       *
       * `createImageBitmap(blob, { resizeWidth })` 是**解码阶段降采样**：
       * 5120×2880 的 PNG 不会先铺成 59MB 的位图再缩，内存和耗时都是零头。
       * 少数浏览器不认这个参数，退回整幅解码——也就是原来的行为，不更糟。
       */
      const makeThumb = async (it) => {
        /**
         * 取原图优先走新接口（按序号，稳）。
         *
         * 退回旧接口是为了**面板热更新、宿主还没重启**那段时间：新路由在旧进程里
         * 不存在，会 404，而面板脚本是每次从磁盘读的，用户刷新就拿到了新脚本。
         * 不兜底的话表现是「大图全是占位，点也点不开」，比改之前还差。
         */
        let res = await fetch(API + '/gallery/file?seq=' + encodeURIComponent(it.seq))
        if (!res.ok) {
          res = await fetch(API + '/stickers/file?path=' + encodeURIComponent(it.rel || it.file))
        }
        if (!res.ok) throw new Error('取不到原图')
        const blob = await res.blob()
        let bmp
        try {
          bmp = await createImageBitmap(blob, { resizeWidth: 320, resizeQuality: 'low' })
        } catch {
          bmp = await createImageBitmap(blob)
        }
        const canvas = document.createElement('canvas')
        /**
         * 长截图（`320×12000` 那种）只限宽不行：`resizeWidth: 320` 出来还是
         * 一条 12000px 高的位图，`toBlob` 出来几百 KB，直接被宿主 400KB 拒收，
         * 于是每次打开面板都白压一遍。等比塞进 320×1280 的框里。
         */
        const scale = Math.min(1, 320 / bmp.width, 1280 / bmp.height)
        canvas.width = Math.max(1, Math.round(bmp.width * scale))
        canvas.height = Math.max(1, Math.round(bmp.height * scale))
        const ctx = canvas.getContext('2d')
        /**
         * JPEG 没有透明通道。表情包大半是透明 PNG，直接画到空白 canvas 上
         * 再压 JPEG，透明区会变成黑块（看起来像图坏了）。先铺白底。
         */
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
        bmp.close?.()
        const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
        if (!out) return ''
        const data = await new Promise((resolve) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result || ''))
          fr.onerror = () => resolve('')
          fr.readAsDataURL(out)
        })
        /** 存不上（宿主没重启）不影响这次显示：objectURL 是本地那份 */
        if (data) await post('/gallery/thumb', { seq: it.seq, data })
        return URL.createObjectURL(out)
      }

      /**
       * 给本页缺缩略图的大图排队生成，**同时只跑两个**。
       *
       * 并发全开的话二十张大图一起解码，主线程反而卡住；两个既能让首屏
       * 尽快有图，也不会把面板顶住。生成完一张就 `setThumbs` 一张。
       */
      useEffect(() => {
        if (typeof createImageBitmap !== 'function') return undefined
        const need = (data?.items || []).filter((it) => !it.thumb && !thumbs[it.seq]
          && Number(it.bytes) >= THUMB_MIN && !thumbQueued.current.has(it.seq))
        if (!need.length) return undefined
        let stop = false
        const queue = [...need]
        const worker = async () => {
          while (queue.length && !stop) {
            const it = queue.shift()
            thumbQueued.current.add(it.seq)
            try {
              const url = await makeThumb(it)
              /** 压不出来（canvas 内存不够 / 这个格式浏览器解不了）：放回队列，下次再试 */
              if (!url) { thumbQueued.current.delete(it.seq); continue }
              /** 翻页了（stop）：这张算出来了也没人会显示，直接释放，别留个孤儿 blob */
              if (stop) { try { URL.revokeObjectURL(url) } catch { /* 已释放 */ } continue }
              /**
               * 用 ref 当「下一份」的来源，而不是 `setThumbs((cur) => ...)`：
               * 后面 `load()` 要靠 ref 决定哪些需要 revoke，两边必须是同一份。
               */
              thumbsRef.current = { ...thumbsRef.current, [it.seq]: url }
              setThumbs(thumbsRef.current)
            } catch {
              /**
               * 失败（宿主还没重启、刚好被占用、浏览器解不了这个格式）就把它
               * 从「已排队」里放掉：下一次 `data` 变化还能再试一次。
               * 留在集合里的话，这张图这一整场都不会再尝试，只能刷新页面。
               */
              thumbQueued.current.delete(it.seq)
            }
          }
        }
        Promise.all([worker(), worker()])
        return () => { stop = true }
      }, [data])

      /** 整理进度：任务在跑时每 500ms 问一次（一张是一次模型调用，比补标签慢得多） */
      useEffect(() => {
        if (!job?.running) return undefined
        const t = setInterval(async () => {
          const r = await get('/gallery/organize/job')
          if (r?.job) {
            setJob(r.job)
            if (!r.job.running) {
              /**
               * 念后端给的 `message`：它分得清「跑完了」「你按了停」「连续失败
               * 自己收手了」三种结局，并带上第一张失败原因。面板自己拼
               * 「补上 N 张」的话，用户永远不知道那 N 张为什么没补上。
               */
              toast(r.job.message || `整理完成：补上 ${r.job.done} 张，跳过 ${r.job.failed} 张`)
              /**
               * 跑完就把「全部重做」放掉：勾着不放的话，下一次随手点整理
               * 会再花一整轮钱（几十到两百次模型调用）。想重做再勾一次，
               * 这个动作本身就该是有意识的。
               */
              setRedoAll(false)
              reloadFirst()
            } else if ((Number(r.job.done) || 0) - seenDone.current >= 5) {
              /**
               * 每成功 5 张刷一次列表（抄 aurabot）。
               *
               * 只在跑的时候刷：新起的名字当场出现在卡片上，用户才敢相信
               * 这一轮真在干活；只看进度条动数字的话，图一张没变很像卡死。
               */
              seenDone.current = Number(r.job.done) || 0
              load(page)
            }
          }
        }, 500)
        return () => clearInterval(t)
      }, [job?.running, page])

      /**
       * 启动整理。
       *
       * `seqs` 是「整理所选」：用户在批量模式里挑出来的那几张。传了就只跑它们，
       * 而且**连已有描述、已停用的也跑**——点选就是明确的意图，再拿规则挡回去
       * 会表现成「我明明选了它却一动不动」。不传走增量 / 全部重做。
       */
      const organize = async (seqs = null) => {
        setBusy(true)
        const body = Array.isArray(seqs) && seqs.length ? { seqs } : { all: redoAll }
        const r = await post('/gallery/organize', body)
        setBusy(false)
        if (r.ok === false) return toast(r.message || '启动失败')
        if (!r.total) return toast(r.message || '每张都有描述了')
        seenDone.current = 0
        setJob({ running: true, total: r.total, done: 0, failed: 0, percent: 0, all: r.all })
        const what = Array.isArray(seqs) && seqs.length ? `选中的 ${r.total} 张` : `${r.total} 张${r.all ? '（全部重做）' : ''}`
        toast(`开始整理${what}（每张问一次模型，会慢一点）`)
      }

      const cancelJob = async () => {
        const r = await post('/gallery/organize/cancel', {})
        setJob(r.job || null)
        /** 停下也放掉「全部重做」：下一轮该从增量继续，不该又全量烧一遍 */
        setRedoAll(false)
        toast(r.message || '已停下')
        load(page)
      }

      const saveEdit = async () => {
        const r = await post('/gallery/edit', { seq: editFor, ...draft })
        if (r.ok === false) return toast(r.message || '没存上')
        setEditFor(0)
        setDraft({})
        toast('标注已更新')
        load(page)
      }

      const toTrash = async (seq) => {
        const r = await post('/gallery/remove', { seq })
        if (r.ok === false) return toast(r.message || '没撤下来')
        toast(`#${seq} 已移入回收站（文件还在）`)
        load(page)
      }

      const back = async (seq) => {
        const r = await post('/gallery/restore', { seq })
        if (r.ok === false) return toast(r.message || '恢复不了')
        toast(`#${seq} 已恢复`)
        load(page)
      }

      /**
       * 停用 / 启用。
       *
       * `enabled=0` 是唯一个**只有 AI 会主动设**的状态（`gallery_edit`）。
       * 原来面板只画出「停用」角标、不给开关——用户看得见却改不回来，
       * 只能反过来求 AI 改，而「让 AI 改」本身就要碰运气。两个方向都给按钮。
       */
      const togglePause = async (seq, next) => {
        const r = await post('/gallery/edit', { seq, enabled: next })
        if (r.ok === false) return toast(r.message || '没改过来')
        toast(next ? `#${seq} 已启用` : `#${seq} 已停用（还在库里，只是不发）`)
        load(page)
      }

      /** 固定 / 取消固定：挡的是「配额满时自动淘汰」，不影响发不发 */
      const togglePin = async (seq, next) => {
        const r = await post('/gallery/edit', { seq, pinned: next })
        if (r.ok === false) return toast(r.message || '没改过来')
        toast(next ? `#${seq} 已固定：配额满也不会淘汰它` : `#${seq} 已取消固定`)
        load(page)
      }

      /**
       * 补标签任务：任务在跑时每 400ms 问一次，跑完停。
       *
       * 这条通道原本挂在「表情库」那张按文件列的卡上。合并之后按钮搬到这里，
       * 通道和进度口径没变——补的是 `.tags` 侧车，而图库现在按侧车回采
       * `tags / scenes`（`gallery.js` 的 `sync()`），补完这一页会跟着变。
       */
      useEffect(() => {
        if (!tagJob?.running) return undefined
        const t = setInterval(async () => {
          const r = await get('/stickers/tags/job')
          if (r?.job) {
            setTagJob(r.job)
            if (!r.job.running) {
              toast(`补标签完成：${r.job.done} 张，失败 ${r.job.failed} 张`)
              /** 页码一起归位：否则在第 3 页跑完，数据是第一页、页码还写着 3 */
              reloadFirst()
            }
          }
        }, 400)
        return () => clearInterval(t)
      }, [tagJob?.running])

      const fill = async (all) => {
        setBusy(true)
        const r = await post('/stickers/tags/fill', { all })
        setBusy(false)
        if (r.ok === false) return toast(r.message || '启动失败')
        if (!r.total) return toast(r.message || '都已有标签')
        setTagJob({ running: true, total: r.total, done: 0, percent: 0, failed: 0 })
        toast(`开始补 ${r.total} 张`)
      }

      const cancelTagJob = async () => {
        const r = await post('/stickers/tags/cancel', {})
        setTagJob(r.job || null)
        toast(r.message || '已取消')
        load(page)
      }

      /**
       * 上传：落在当前筛选的分类里（没筛就进根目录），和原来表情库页同一个接口。
       *
       * 对齐 aurabot 的两点：**一次可选多张**（逐张发，一张失败不拖累别的）、
       * **单张时能填名字**。名字在这里是**文件名**（roost 的文件系统才是真相，
       * 不像 aurabot 按 md5 存库），所以保留原扩展名，只换前面那段。
       */
      const upload = async (fileList) => {
        const list = [...(fileList || [])]
        if (!list.length) return
        setBusy(true)
        const want = String(newName).trim().slice(0, 20)
        let ok = 0
        const errs = []
        for (const f of list) {
          if (f.size > 10 * 1024 * 1024) { errs.push(`${f.name} 超过 10MB`); continue }
          let data64 = ''
          try {
            data64 = await new Promise((resolve, reject) => {
              const fr = new FileReader()
              fr.onload = () => resolve(String(fr.result || ''))
              fr.onerror = () => reject(new Error('读不了这个文件'))
              fr.readAsDataURL(f)
            })
          } catch (e) {
            errs.push(`${f.name}：${e.message}`)
            continue
          }
          if (!data64) continue
          /**
           * 多张时不套用统一名字：十张全叫「猫猫」只会被后端一路加序号，
           * 反而比原名更难认。要统一命名用批量「改名」（改标注，不动文件）。
           */
          const ext = (/\.[a-z0-9]+$/i.exec(f.name) || [''])[0]
          const nm = list.length === 1 && want ? want + ext : f.name
          const r = await post('/stickers/upload', { name: nm, data: data64, category: cat })
          if (r.ok) ok += 1
          else errs.push(`${f.name}：${r.message || '没传上去'}`)
        }
        setBusy(false)
        setNewName('')
        toast(errs.length
          ? `${ok ? `加好 ${ok} 张；` : ''}${errs.slice(0, 2).join('；')}${errs.length > 2 ? '…' : ''}`
          : `已上传 ${ok} 张`)
        if (ok) reloadFirst()
      }

      const togglePick = (seq) => setPicked((cur) => (cur.includes(seq) ? cur.filter((x) => x !== seq) : [...cur, seq]))

      /** 批量撤下：进回收站，**文件不动**（真删在回收站里，见 `purgePicked`） */
      const removePicked = async () => {
        if (!picked.length) return toast('先勾几张')
        setBusy(true)
        const r = await post('/gallery/remove', { seqs: picked })
        setBusy(false)
        toast(r.ok ? `已撤下 ${r.count} 张（在回收站，可以恢复）` : (r.message || '没撤下来'))
        setPicked([])
        load(page)
      }

      /** 批量恢复：回收站里勾几张一起拿回来（单张那颗「恢复」还在） */
      const restorePicked = async () => {
        if (!picked.length) return toast('先勾几张')
        setBusy(true)
        const r = await post('/gallery/restore', { seqs: picked })
        setBusy(false)
        toast(r.ok ? `已恢复 ${r.count} 张` : (r.message || '恢复不了'))
        setPicked([])
        load(page)
      }

      /** 彻底删除：删文件 + 删记录。全仓唯一不可逆的删图入口，先说清张数 */
      const purgePicked = async () => {
        if (!picked.length) return toast('先勾几张')
        const n = picked.length
        if (!window.confirm(
          `彻底删除 ${n} 张图？\n\n`
          + '会直接删掉文件（连同 .tags 标签文件）和它们的序号，没有回收站，恢复不了。\n\n'
          + '只想让它别再发这张，用「撤下」。',
        )) return
        setBusy(true)
        const r = await post('/gallery/purge', { seqs: picked, confirm: true })
        setBusy(false)
        toast(r.failed?.length
          ? `删了 ${r.count} 张，${r.failed.length} 张没删掉（${r.failed[0].message}）`
          : `已彻底删除 ${r.count} 张`)
        setPicked([])
        /** 删完可能不够一页了：页码跟着回第一页，不然停在空页上看着像没删成功 */
        reloadFirst()
      }

      const purgeOne = async (seq) => {
        if (!window.confirm(`彻底删除 #${seq}？\n\n会删掉文件本身，恢复不了。`)) return
        setBusy(true)
        const r = await post('/gallery/purge', { seqs: [seq], confirm: true })
        setBusy(false)
        toast(r.ok ? `#${seq} 已彻底删除` : (r.failed?.[0]?.message || r.message || '没删掉'))
        setPicked((cur) => cur.filter((x) => x !== seq))
        load(page)
      }

      /**
       * 批量改名。
       *
       * 两个字段都能留空，所以「只改名字」「只改标签」都是同一条路。
       * 勾了「后加序号」每张名字都不一样，只能顺序发（编号要按序号排，
       * 不能按点击顺序）；不勾就一次提交整批，服务端逐张改、返回失败清单。
       *
       * 改的是**标注**（`name` / `tags`），不是磁盘上的文件名——文件名是
       * `rel` 的组成部分，改了会影响缩略图接口和侧车定位，不该在批量里做。
       */
      const bulkRename = async () => {
        const prefix = String(bulk?.prefix ?? '').trim()
        const tags = String(bulk?.tags ?? '').trim()
        if (!prefix && !tags) return toast('名字和标签都空着，没什么可改的')
        const seqs = [...picked].sort((a, b) => a - b)
        setBusy(true)
        let done = 0
        const failed = []
        if (prefix && bulk?.numbered) {
          for (let i = 0; i < seqs.length; i += 1) {
            const patch = { seq: seqs[i], name: `${prefix} ${i + 1}` }
            if (tags) patch.tags = tags
            const r = await post('/gallery/edit', patch)
            if (r.ok === false) failed.push({ seq: seqs[i], message: r.message || '没改成' })
            else done += 1
          }
        } else {
          const patch = { seqs }
          if (prefix) patch.name = prefix
          if (tags) patch.tags = tags
          const r = await post('/gallery/edit', patch)
          done = Number(r.count) || 0
          for (const f of (r.failed || [])) failed.push(f)
          if (!done && !failed.length) failed.push({ message: r.message || '没改成' })
        }
        setBusy(false)
        setBulk(null)
        toast(failed.length
          ? `改了 ${done} 张，${failed.length} 张没改成（${failed[0].message}）`
          : `已改 ${done} 张`)
        load(page)
      }

      const stats = data?.stats || {}
      /** 本页全部序号：给「全选本页」用。只选这一页，不做「全选全库」——太容易误伤 */
      const pageSeqs = (data?.items || []).map((it) => Number(it.seq) || 0).filter(Boolean)
      const secTitle = view === 'trash' ? '回收站' : '图片'
      /**
       * 回到第一页并重读。
       *
       * `setPage(1)` 在页码本来就是 1 时不会触发那个 `load` effect（React 会跳过
       * 同值更新），所以那种情况得自己再读一次。统一走这个函数，省掉「数据停在
       * 第一页、页码还写着第 3 页」这类只在特定页数下才出现的错位。
       */
      const reloadFirst = () => { if (page === 1) load(1); else setPage(1) }
      /**
       * 「起名用的模型」的当前值和落库动作。
       *
       * 空字符串 = 跟随聊天模型（默认）。存到 `stickers.captionModel`，
       * 只有图库整理这条链读它，聊天不受影响——这正是它存在的理由。
       */
      const cm = config?.stickers?.captionModel || {}
      const cmKey = cm.provider && cm.model ? `${cm.provider}::${cm.model}` : ''
      const cmHit = models && cmKey
        ? models.find((m) => `${m.provider}::${m.model}` === cmKey)
        : null
      const setCm = (v) => {
        const [p, ...rest] = String(v || '').split('::')
        saveCfg?.({
          stickers: {
            captionModel: { provider: v ? p : '', model: v ? rest.join('::') : '' },
          },
        })
      }
      return h(Sec, {
        n, title: secTitle,
        /**
         * 批量模式下头部的单张动作全收起来：上传、补标签、让 AI 整理都是
         * 「对整库做一件事」，和「我正在挑几张」是两种心态，放一起会点错。
         */
        right: h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          selecting
            ? h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => { setSelecting(false); setPicked([]); setBulk(null) },
            }, '退出批量')
            : null,
          selecting || view !== 'pics'
            ? null
            : h('input', {
              className: 'roost-input', style: { width: 118 }, placeholder: '名字（可不填）',
              value: newName, maxLength: 20,
              title: '只传一张时用它当文件名（保留原扩展名）；传多张就各用原名',
              onChange: (e) => setNewName(e.target.value),
            }),
          selecting || view !== 'pics'
            ? null
            : h('label', { className: 'roost-btn', style: { cursor: 'pointer' } },
              busy ? '处理中…' : '上传',
              h('input', {
                type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' },
                onChange: (e) => { upload(e.target.files); e.target.value = '' },
              })),
          selecting || view !== 'pics'
            ? null
            : h('button', {
              type: 'button', className: 'roost-btn', disabled: busy || tagJob?.running,
              title: '按分类名和文件名补 .tags：规则算，不调模型，免费',
              onClick: () => fill(false),
            }, tagJob?.running ? '补标签中…' : '补标签'),
          selecting || view !== 'pics'
            ? null
            : h('label', {
              /**
               * 放在「让 AI 整理」左边：勾选框读起来像个前缀，点按钮时才生效。
               * 单独放按钮右边的话，人点完才发现有个没勾的框，会以为整理没覆盖全。
               */
              className: 'roost-muted',
              title: '连已经有名字/描述的一起重跑（会重新花模型调用）。'
                + '描述写歪了、标签全是文件名拆的词、换了更会看图的模型时用',
              style: {
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 11.5, cursor: job?.running ? 'default' : 'pointer',
                opacity: job?.running ? .5 : 1,
              },
            },
              h('input', {
                type: 'checkbox', checked: redoAll, disabled: Boolean(job?.running),
                onChange: (e) => setRedoAll(e.target.checked),
              }),
              '全部重做'),
          selecting
            ? null
            : view === 'pics'
              ? h('button', {
                type: 'button', className: 'roost-btn roost-btn-primary',
                disabled: busy || job?.running,
                title: redoAll
                  ? '全部重做：会重新描述每一张（回收站、停用、文件丢了的不算）'
                  : '只补还没名字和描述的图；每张问一次模型',
                onClick: () => organize(),
              }, job?.running ? '整理中…' : '让 AI 整理')
              : h('button', {
                type: 'button', className: 'roost-btn', disabled: busy || !picked.length,
                onClick: purgePicked,
              }, picked.length ? `彻底删除 ${picked.length} 张` : '彻底删除'),
          /**
           * 批量选择是这一页唯一的「多张」入口。它不变灰、不加 primary：
           * 常态下这里没有选中的东西，主按钮应该留给「上传 / 整理」。
           */
          selecting
            ? null
            : h('button', {
              type: 'button', className: 'roost-btn',
              disabled: !pageSeqs.length,
              title: '打开后点图片就能选，可以一次撤下 / 改名 / 删除',
              onClick: () => { setSelecting(true); setBulk(null); setEditFor(0) },
            }, '批量选择'),
          /**
           * 刷新：`load()` 每次都会让宿主重扫目录（快照有 3 秒缓存，翻页不痛）。
           * 用户往文件夹里直接丢图之后，这是唯一能立刻看见它们的地方。
           */
          selecting
            ? null
            : h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              title: '重新读一遍目录：刚往文件夹里丢的图会出现在这里',
              onClick: () => load(page),
            }, '刷新')),
      },
        !data
          ? h('div', { className: 'roost-empty' }, '读着…')
          : h('div', null,
            h('div', { className: 'roost-note', style: { marginBottom: 8 } },
              /**
               * 回收站里不能说「共 N 张」：那个数是**全库**的（`stats()` 的口径），
               * 而这一屏只列撤下的那几张，两个数字对不上会让人以为列表没刷。
               */
              trash
                ? `回收站 ${stats.trash} 张 · 文件都还在，点「恢复」就能回来；「彻底删除」才真删`
                : `共 ${stats.total} 张 · 还没描述 ${stats.untagged} 张`
                  + (stats.paused ? ` · 停用 ${stats.paused}` : '')
                  + (stats.pinned ? ` · 固定 ${stats.pinned}` : '')
                  + (stats.online ? ` · 线上 ${stats.online}` : '')
                  + ` · 回收站 ${stats.trash} · 下一个序号 #${stats.nextSeq}`
                  + (data.dir ? ` · 目录 ${data.dir}` : '')),

            /** 回收站里不谈标注：这一屏能做的只有恢复和彻底删除 */
            trash
              ? null
              : h('div', { className: 'roost-note', style: { fontSize: 11, marginBottom: 8, opacity: .75 } },
                'AI 发图时只写序号（如 <<image: #3>>），路径由宿主去换。'
                + '这里能改的是它判断「该不该发这张」的依据：名字、含义、场合。'),

            tagJob?.running
              ? h('div', { style: { marginBottom: 8 } },
                h('div', { className: 'roost-note', style: { fontSize: 11.5, marginBottom: 4 } },
                  `补标签中 ${tagJob.done + tagJob.failed} / ${tagJob.total}（${tagJob.percent}%）`
                  + ' · 按分类名和文件名写 .tags，不调模型'),
                h('button', { type: 'button', className: 'roost-btn', onClick: cancelTagJob }, '停下'))
              : null,

            /**
             * 批量操作条：只在批量模式下出现，**常驻**（没选也显示）。
             *
             * 以前是「选中了才冒出这条」，于是用户得先猜「怎么才能多选」。
             * 现在打开批量模式就先看到这条，上面写清「点图片就能选」，
             * 三个动作（撤下 / 改名 / 删除）位置固定，不随选中数跳动。
             *
             * 图片区的「撤下」= 进回收站（可恢复）；「删除」是最右边那个不可逆的，
             * 有确认框兜着。回收站里把「撤下」换成「恢复」。
             */
            selecting
              ? h('div', {
                className: 'roost-note',
                style: {
                  marginBottom: 8, padding: '6px 8px', borderRadius: 6,
                  background: 'rgba(74,170,119,.10)',
                  border: '1px solid rgba(74,170,119,.35)',
                  display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
                },
              },
                h('strong', null, picked.length ? `已选 ${picked.length} 张` : '点图片就能选中'),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  disabled: !pageSeqs.length,
                  onClick: () => setPicked(picked.length === pageSeqs.length ? [] : pageSeqs),
                }, picked.length === pageSeqs.length && pageSeqs.length ? '取消全选' : '全选本页'),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  disabled: !pageSeqs.length,
                  title: '本页没选中的全部选上，已选的取消',
                  onClick: () => setPicked((cur) => pageSeqs.filter((s) => !cur.includes(s))),
                }, '反选'),
                view === 'pics'
                  ? h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: busy || !picked.length, onClick: removePicked,
                    title: '从图库撤下，进回收站；文件不动，可以恢复',
                  }, `撤下 ${picked.length || ''}`.trim())
                  : h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: busy || !picked.length, onClick: restorePicked,
                    title: '拿回图库，恢复之后她可以再发',
                  }, `恢复 ${picked.length || ''}`.trim()),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  disabled: busy || job?.running || !picked.length,
                  /**
                   * 只整理选中的这几张。和「让 AI 整理」的差别不只是范围：
                   * 手选的**不再过滤**已有描述 / 已停用——点选就是明确意图。
                   * 这样「这张起名起歪了，重来一次」终于有地方点了。
                   */
                  title: '只整理选中的这几张；已经有名字的也会重跑',
                  onClick: () => organize(picked),
                }, `整理所选 ${picked.length || ''}`.trim()),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  disabled: busy || !picked.length,
                  title: '给这几张统一改名字 / 标签，留空的字段不动',
                  onClick: () => setBulk({ prefix: '', tags: '', numbered: true }),
                }, '改名'),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  disabled: busy || !picked.length, onClick: purgePicked,
                  title: '删文件 + 删序号，不可恢复',
                }, '删除'),
                h('span', { style: { flex: '1 1 auto' } }),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  onClick: () => { setSelecting(false); setPicked([]); setBulk(null) },
                }, '退出批量'))
              : null,

            /** 批量改名：留空 = 不动，所以一次只改名字或只改标签也行 */
            bulk
              ? h('div', {
                className: 'roost-note',
                style: {
                  marginBottom: 8, padding: '8px 10px', borderRadius: 6,
                  border: '1px solid rgba(128,128,128,.35)',
                  display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
                },
              },
                h('span', null, `给这 ${picked.length} 张改名`),
                h('input', {
                  className: 'roost-input', style: { width: 150 }, placeholder: '名字（留空不改）',
                  value: bulk.prefix,
                  onChange: (e) => setBulk((b) => ({ ...b, prefix: e.target.value })),
                }),
                h('label', { style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5 } },
                  h('input', {
                    type: 'checkbox', checked: bulk.numbered,
                    onChange: (e) => setBulk((b) => ({ ...b, numbered: e.target.checked })),
                  }),
                  '后加序号'),
                h('input', {
                  className: 'roost-input', style: { width: 170 }, placeholder: '标签，逗号分隔（留空不改）',
                  value: bulk.tags,
                  onChange: (e) => setBulk((b) => ({ ...b, tags: e.target.value })),
                }),
                h('button', {
                  type: 'button', className: 'roost-btn roost-btn-primary',
                  disabled: busy, onClick: bulkRename,
                }, '存'),
                h('button', {
                  type: 'button', className: 'roost-btn', onClick: () => setBulk(null),
                }, '取消'),
                h('span', { style: { fontSize: 11, opacity: .7, flex: '1 1 100%' } },
                  '名字最多 20 字；勾了「后加序号」会按序号排成「猫猫 1、猫猫 2…」，'
                  + '免得几张图同名。这里改的是 AI 用来判断「该不该发」的标注，不是文件名。'))
              : null,

            /**
             * 「起名用的模型」。
             *
             * 放这儿和整理进度连成一条因果链：用什么模型 → 这一轮跑成什么样。
             * 不在批量模式显示：批量时用户在处理选中的几张，改模型是「换整库
             * 的工具」，两件事不该同屏。
             */
            view === 'pics' && !selecting
              ? h('div', {
                className: 'roost-note',
                style: {
                  marginBottom: 8, display: 'flex', gap: 6,
                  alignItems: 'center', flexWrap: 'wrap', fontSize: 11.5,
                },
              },
                h('span', null, '起名用的模型'),
                h('select', {
                  className: 'roost-input', style: { width: 'auto', maxWidth: 280 },
                  value: cmKey,
                  disabled: Boolean(job?.running),
                  title: '「让 AI 整理」看图用哪个模型。空 = 跟随聊天模型；整理必须能看图',
                  onChange: (e) => setCm(e.target.value),
                },
                  h('option', { value: '' }, '跟随聊天模型'),
                  /**
                   * 配了、但清单里已经没有这个模型（换了 provider、退了登录）。
                   * 不补这一项的话，原生 select 会把显示回退到第一项「跟随聊天模型」，
                   * 而配置里其实还指着那个失效的模型——用户以为已经改回来了。
                   */
                  cmKey && models && models.length && !cmHit
                    ? h('option', { value: cmKey }, `${cm.model}（已不在模型清单里）`)
                    : null,
                  (models || []).map((m) => h('option', {
                    key: `${m.provider}::${m.model}`,
                    value: `${m.provider}::${m.model}`,
                  }, `${m.name || m.model}`
                    + (m.vision === true ? '（能看图）' : m.vision === false ? '（不看图）' : '')))),
                models === null ? h('span', null, '正在查模型…') : null,
                /**
                 * 选到看不了图的当场警告：不然用户会点完整理、看到
                 * 「连续失败 5 张」才发现，那一轮还白花了 5 次调用。
                 */
                cmHit && cmHit.vision === false
                  ? h('span', { style: { color: '#c8752a' } }, '这个模型看不了图，整理会被整批跳过')
                  : null)
              : null,

            job
              ? h('div', { style: { marginBottom: 8 } },
                job.running
                  ? h('div', null,
                    h('div', { className: 'roost-note', style: { fontSize: 11.5, marginBottom: 4 } },
                      `整理中 ${job.done + job.failed} / ${job.total}（${job.percent}%）`
                      + (job.note ? ` · ${job.note}` : '')
                      /** 心跳：刚起好的名字。没有它，进度条只是在动数字 */
                      + (job.last ? ` · 刚起好 ${job.last}` : '')),
                    h('div', { style: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,.2)' } },
                      h('div', {
                        style: {
                          height: '100%', borderRadius: 3, width: `${job.percent}%`,
                          background: 'var(--ok, #2a9d5c)', transition: 'width .3s',
                        },
                      })),
                    h('button', { type: 'button', className: 'roost-btn', style: { marginTop: 6 }, onClick: cancelJob }, '停下'))
                  : h('div', {
                    /**
                     * 结果留在页面上，不只是一闪而过的 toast。
                     *
                     * 「补上 0 张」这种结果最需要解释：用户要点开看一眼
                     * 到底是模型看不了图、图太大、还是模型回的话解析不了。
                     * 以前这里跑完就消失，等于把失败原因丢掉了。
                     */
                    className: 'roost-note',
                    style: {
                      fontSize: 11.5, padding: '6px 8px', borderRadius: 6,
                      background: job.failed ? 'rgba(200,120,40,.10)' : 'rgba(42,157,92,.10)',
                    },
                  },
                    h('div', { style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
                      h('span', { style: { flex: 1 } },
                        job.message || `补上 ${job.done} 张，跳过 ${job.failed} 张`),
                      h('button', {
                        type: 'button', className: 'roost-btn', style: { padding: '0 6px' },
                        onClick: () => setJob(null),
                      }, '知道了')),
                    job.errors?.length
                      ? h('div', { style: { marginTop: 4, opacity: .8 } },
                        job.errors.slice(0, 3).map((e, i) => h('div', { key: i },
                          `#${e.seq} ${e.file}：${e.reason}`)))
                      : null))
              : null,

            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' } },
              h('select', {
                className: 'roost-input', style: { width: 'auto' }, value: cat,
                onChange: (e) => { setCat(e.target.value); setPage(1) },
              },
                h('option', { value: '' }, '全部分类'),
                (data.cats || []).map((c) => h('option', { key: c.name, value: c.name }, `${c.name}（${c.count}）`))),
              h('input', {
                className: 'roost-input', style: { width: 160 }, placeholder: '搜文件名 / 描述', value: q,
                onChange: (e) => setQ(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') { setPage(1); load(1) } },
              }),
              h('button', { type: 'button', className: 'roost-btn', onClick: () => { setPage(1); load(1) } }, '搜'),
              h('select', {
                className: 'roost-input', style: { width: 'auto' }, value: size,
                onChange: (e) => { setSize(Number(e.target.value)); setPage(1) },
              }, [12, 24, 48, 96].map((v) => h('option', { key: v, value: v }, `每页 ${v}`))),
              /**
               * 「全选本页」搬进批量条了。
               *
               * 它原来靠复选框才有意义：不在批量模式时点它，选中的东西
               * 屏幕上没有任何反馈（复选框已经去掉了），用户只会以为按钮坏了。
               */
              h('span', { className: 'roost-muted', style: { fontSize: 11.5 } },
                `第 ${data.page} / ${data.pages} 页 · ${data.total} 张`)),

            data.items.length === 0
              ? h('div', { className: 'roost-empty' },
                trash ? '回收站是空的' : '图库还是空的：往表情目录丢几张图，或让 AI 自己存（gallery_save）')
              : h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 8 } },
                data.items.map((it) => {
                  const id = Number(it.seq) || 0
                  const editing = editFor === id
                  /**
                   * AI 可以用 `gallery_edit` 的 `enabled=0` 把一张图「停下」。
                   * 停了之后 `pathOf()` 会挡住它、永远发不出去——面板上要是
                   * 和正常的没区别，用户只会觉得「怎么从来不发这张」。
                   */
                  const paused = it.enabled === false
                  /** 批量模式下的选中态：靠边框和底色说，不用复选框 */
                  const hit = selecting && picked.includes(id)
                  /**
                   * 原图地址：缩略图那条路挂了时的最终退路。
                   *
                   * **按序号取**，不按 `rel`：库里有真 `未分类/` 目录时，快照会把
                   * 根目录图的 `rel` 改写成 `未分类/xxx`，照它取图就是 404（破图）。
                   */
                  const origUrl = API + '/gallery/file?seq=' + id
                  /**
                   * 旧接口兜底。宿主没重启时 `/gallery/file` 还不存在（面板脚本是
                   * 每次从磁盘读的，会先拿到新代码），退回按相对路径取——那条路
                   * 在「有真 `未分类/` 目录」时可能 404，但总比点不开强。
                   */
                  const legacyUrl = API + '/stickers/file?path='
                    + encodeURIComponent(it.rel || it.file)
                  /**
                   * 缩略图优先。
                   *
                   *   1. 本次会话刚压出来的（objectURL，立刻能看）；
                   *   2. 服务端已缓存（`it.thumb`，几十 KB、长缓存）；
                   *   3. 小图直接给原图；
                   *   4. 大图又还没压好 → 空字符串，走下面的占位块。
                   *
                   * 第 4 条是这次报障的根子：以前一屏二十张各按原尺寸解码，
                   * 混进两张 24MB 壁纸就把面板拖住了，图显示成破图/半截。
                   */
                  /**
                   * `v` 是内容版本（字节数），服务端不看，只为**打穿浏览器缓存**。
                   *
                   * 缩略图那条是 `max-age=604800`（7 天）。正常情况下同一个 seq
                   * 永远是同一张图（序号单调递增不回收），所以敢长缓存；但如果
                   * 用户删过 `index.json`（或索引版本升级重建），seq 会从 1 重新
                   * 分配，这时 `?seq=1` 在浏览器里还是**七天前那张图**。
                   * 带上字节数，新图基本一定换 URL。
                   */
                  const ver = Number(it.bytes) || 0
                  const thumbUrl = thumbs[id]
                    || (it.thumb ? API + '/gallery/thumb?seq=' + id + '&v=' + ver : '')
                  const src = thumbUrl || (Number(it.bytes) >= THUMB_MIN ? '' : origUrl)
                  const bigLabel = `${(Number(it.bytes) / 1048576).toFixed(1)} MB`
                  return h('div', {
                    key: id,
                    /**
                     * 整张卡片就是点击目标。
                     *
                     * 缩略图只有 140px 宽，原来那个 14px 的复选框在手机上
                     * 基本点不中，还和「停用 / 固定」角标抢位置。批量模式
                     * 打开后点哪儿都算选中，命中面积就是整块卡片。
                     */
                    onClick: selecting ? () => togglePick(id) : undefined,
                    role: selecting ? 'button' : undefined,
                    'aria-pressed': selecting ? hit : undefined,
                    title: selecting
                      ? (hit ? `取消选择 #${id}` : `选中 #${id}`)
                      : (paused ? '已停用：她不会发这张（点「启用」可恢复）' : undefined),
                    style: {
                      cursor: selecting ? 'pointer' : 'default',
                      border: `1px ${paused ? 'dashed' : 'solid'} ${hit || editing ? 'var(--accent, #4a7)' : 'rgba(128,128,128,.25)'}`,
                      borderRadius: 8, padding: 6, fontSize: 11,
                      background: hit ? 'rgba(74,170,119,.14)' : undefined,
                      /** 选中时描一圈，缩略图再暗也不至于看不出选了哪张 */
                      boxShadow: hit ? '0 0 0 2px rgba(74,170,119,.45)' : undefined,
                      /** 回收站里的图淡一点（表示已撤下），但别淡到看不清是什么 */
                      opacity: hit ? 1 : (trash ? .68 : (paused ? .6 : 1)),
                    },
                  },
                    h('div', { style: { position: 'relative' } },
                      src
                        ? h('img', {
                          src,
                          alt: it.file, loading: 'lazy', decoding: 'async',
                          style: { width: '100%', height: 80, objectFit: 'contain', borderRadius: 4, background: 'rgba(128,128,128,.08)' },
                          /**
                           * 三级兜底：缩略图 → 新接口原图 → 旧接口原图。
                           *
                           * 第二级 404 的典型场景是宿主还没重启（新路由不在旧进程里）；
                           * 第三级再不行就留一张破图——那说明文件真的没了。
                           */
                          onError: () => {
                            if (src === legacyUrl) return
                            const next = src === origUrl ? legacyUrl : origUrl
                            thumbsRef.current = { ...thumbsRef.current, [id]: next }
                            setThumbs(thumbsRef.current)
                          },
                        })
                        : h('div', {
                          /**
                           * 大图还没压好：先占位，不加载原图。
                           *
                           * 点一下 = 不等缩略图了，直接看原图（24MB 会慢一两秒，
                           * 但那是用户自己选的）。批量模式下点击归选中，不拦。
                           */
                          'aria-label': `大图 ${bigLabel}`,
                          onClick: selecting ? undefined : (e) => {
                            e.stopPropagation()
                            thumbsRef.current = { ...thumbsRef.current, [id]: origUrl }
                            setThumbs(thumbsRef.current)
                          },
                          title: selecting ? undefined : '点一下直接看原图（缩略图还在生成）',
                          style: {
                            width: '100%', height: 80, borderRadius: 4,
                            background: 'rgba(128,128,128,.08)',
                            display: 'flex', flexDirection: 'column',
                            alignItems: 'center', justifyContent: 'center', gap: 2,
                            fontSize: 10.5, opacity: .72,
                            cursor: selecting ? 'inherit' : 'pointer',
                          },
                        },
                          h('span', null, '大图'),
                          h('span', null, bigLabel)),
                      h('span', {
                        style: {
                          position: 'absolute', top: 2, left: 2, padding: '0 4px', borderRadius: 4,
                          fontSize: 10.5, fontWeight: 600, background: 'rgba(0,0,0,.55)', color: '#fff',
                        },
                      }, `#${id}`),
                      /** 选中标记：只是个角标，不是可点控件（点它等于点卡片） */
                      hit
                        ? h('span', {
                          style: {
                            position: 'absolute', bottom: 2, left: 2, padding: '0 5px', borderRadius: 4,
                            fontSize: 10, fontWeight: 600, background: 'rgba(42,157,92,.92)', color: '#fff',
                          },
                        }, '已选')
                        : null,
                      paused
                        ? h('span', {
                            style: {
                              position: 'absolute', top: 2, right: 2, padding: '0 4px', borderRadius: 4,
                              fontSize: 10, fontWeight: 600, background: 'rgba(200,120,0,.85)', color: '#fff',
                            },
                          }, '停用')
                        : null,
                      /**
                       * 固定 = 官方素材池配额满时不会被自动淘汰。和「停用」是两个
                       * 维度（停用是别发，固定是别删），所以两个角标可以同时出现。
                       */
                      it.pinned
                        ? h('span', {
                            style: {
                              position: 'absolute', top: paused ? 20 : 2, right: 2, padding: '0 4px', borderRadius: 4,
                              fontSize: 10, fontWeight: 600, background: 'rgba(60,120,220,.85)', color: '#fff',
                            },
                          }, '固定')
                        : null),

                    h('div', {
                      title: it.file,
                      style: { marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    }, it.name || it.file),

                    h('div', {
                      className: 'roost-muted',
                      style: { fontSize: 10.5, minHeight: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      title: it.meaning || it.scenes || '',
                    }, it.meaning || it.scenes || '还没描述'),

                    /**
                     * 批量模式下把单张按钮全收起来（改 / 停用 / 固定 / 撤下 / 彻底删除）。
                     *
                     * 这时候用户的心智是「我在挑几张一起处理」，单张按钮只会被误触；
                     * 而且整卡点击是选中，按钮上的点击还得 stopPropagation 才不会
                     * 顺手把这张也选上——藏掉比逐个处理事件更干净。
                     */
                    selecting
                      ? null
                      : h('div', { style: { display: 'flex', gap: 4, marginTop: 4 } },
                      editing
                        ? null
                        : h('button', {
                            type: 'button', className: 'roost-btn', style: { fontSize: 10.5, padding: '1px 6px' },
                            onClick: () => {
                              setEditFor(id)
                              setDraft({
                                name: it.name || '',
                                meaning: it.meaning || '',
                                scenes: it.scenes || '',
                                /** 标签原来只能在「表情库」那张卡里改，合并后搬进这个弹层 */
                                tags: (it.tags || []).join(', '),
                              })
                            },
                          }, '改'),
                      /**
                       * 回收站里不给「停用」：那张已经不在清单里了，再标一层
                       * 「停用」只会让人以为恢复之后还得手动启用一次。
                       */
                      trash
                        ? null
                        : h('button', {
                            type: 'button', className: 'roost-btn', style: { fontSize: 10.5, padding: '1px 6px' },
                            /** `paused` 是当前状态，按钮要写的是「按下去会变成什么」 */
                            onClick: () => togglePause(id, paused),
                            title: paused ? '恢复使用：她可以再发这张' : '停用：还在库里，但不会发出去',
                          }, paused ? '启用' : '停用'),
                      /**
                       * 固定：挡的是「配额满时自动淘汰」，不是「发不发」。
                       * 回收站里也不给——那张都撤下了，钉它没有意义。
                       */
                      trash
                        ? null
                        : h('button', {
                            type: 'button', className: 'roost-btn', style: { fontSize: 10.5, padding: '1px 6px' },
                            onClick: () => togglePin(id, !!it.pinned),
                            title: it.pinned
                              ? '取消固定：配额满时可能被淘汰'
                              : '固定：配额满时不会淘汰它（发图也不用重传）',
                          }, it.pinned ? '取消固定' : '固定'),
                      h('button', {
                        type: 'button', className: 'roost-btn', style: { fontSize: 10.5, padding: '1px 6px', marginLeft: 'auto' },
                        onClick: () => (trash ? back(id) : toTrash(id)),
                      }, trash ? '恢复' : '撤下'),
                      /**
                       * 回收站里那颗「彻底删除」——全仓唯一不可逆的删图入口。
                       * 图片区不把它放在单张上（那儿是「撤下」），只在多选条里
                       * 留一个显式按钮，误触成本才够高。
                       */
                      trash
                        ? h('button', {
                          type: 'button', className: 'roost-btn', style: { fontSize: 10.5, padding: '1px 6px' },
                          onClick: () => purgeOne(id),
                        }, '彻底删除')
                        : null),

                    editing
                      ? h('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 3 } },
                        h('input', {
                          className: 'roost-input', placeholder: '短名（10 字内）', value: draft.name || '',
                          style: { fontSize: 10.5, padding: '2px 4px' },
                          onChange: (e) => setDraft((d) => ({ ...d, name: e.target.value })),
                        }),
                        h('input', {
                          className: 'roost-input', placeholder: '这是什么、什么感觉', value: draft.meaning || '',
                          style: { fontSize: 10.5, padding: '2px 4px' },
                          onChange: (e) => setDraft((d) => ({ ...d, meaning: e.target.value })),
                        }),
                        h('input', {
                          className: 'roost-input', placeholder: '什么场合发', value: draft.scenes || '',
                          style: { fontSize: 10.5, padding: '2px 4px' },
                          onChange: (e) => setDraft((d) => ({ ...d, scenes: e.target.value })),
                        }),
                        h('input', {
                          className: 'roost-input', placeholder: '标签，逗号分隔（如 猫, 无语）', value: draft.tags || '',
                          style: { fontSize: 10.5, padding: '2px 4px' },
                          onChange: (e) => setDraft((d) => ({ ...d, tags: e.target.value })),
                        }),
                        h('div', { style: { display: 'flex', gap: 4 } },
                          h('button', {
                            type: 'button', className: 'roost-btn roost-btn-primary',
                            style: { fontSize: 10.5, padding: '1px 6px' },
                            onClick: saveEdit,
                          }, '存'),
                          h('button', {
                            type: 'button', className: 'roost-btn', style: { fontSize: 10.5, padding: '1px 6px' },
                            onClick: () => { setEditFor(0); setDraft({}) },
                          }, '取消')))
                      : null,
                  )
                })),

            h('div', { style: { display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' } },
              h('button', {
                type: 'button', className: 'roost-btn', disabled: data.page <= 1,
                onClick: () => setPage(data.page - 1),
              }, '上一页'),
              h('button', {
                type: 'button', className: 'roost-btn', disabled: data.page >= data.pages,
                onClick: () => setPage(data.page + 1),
              }, '下一页')),
          ),
      )
    }

    /**
     * 官方 Markdown 素材池（`/v2/media-images`，机器人级共享，上限 100 张）。
     *
     * 这一节存在的唯一理由是**排障**。`<<image:>>` 发图会先传到官方图床，
     * 正常几秒内就删（`outbound-actions.js` 末尾那段）。漏下来的只有三种情况：
     * 进程崩在「上传完 / 还没删」之间、令牌缺 manage 权限、删除请求自己失败。
     * 漏一张白占一格，漏满 100 张之后**所有**发图都失败，而报错只有
     * 「上传失败」四个字——以前用户完全看不到这个池子，也就无从判断是不是满了。
     */
    function MediaPoolCard({ toast, n = '04' }) {
      const [data, setData] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async (cursor = '') => {
        setBusy(true)
        try {
          const qs = cursor ? '?cursor=' + encodeURIComponent(cursor) : ''
          const r = await get('/stickers/media' + qs)
          setData((prev) => {
            /**
             * 翻页时把已加载的拼进来，**按 imageId 去重**：翻页途中若有新素材
             * 传上来，游标会错位、同一条出现两次，React 的重复 key 会把整个
             * 列表渲染坏（不是只多一行）。
             */
            if (!cursor || !prev?.images?.length) return r
            const seen = new Set(prev.images.map((x) => x.imageId))
            return {
              ...r,
              images: [...prev.images, ...(r.images || []).filter((x) => !seen.has(x.imageId))],
            }
          })
        } catch {
          setData({ ok: false, message: '连不上面板后端（宿主可能刚重启）' })
        } finally { setBusy(false) }
      }, [])

      useEffect(() => { load('') }, [load])

      const del = async (it) => {
        const name = it.fileName || it.imageId
        if (!window.confirm(
          `删掉线上副本「${name}」？\n\n`
          + '配额立刻还回来，本地那张图还在图库里（下次发它会重新上传）。\n'
          + '这个池子是机器人级共享的——若别的插件正在引用它，那条引用会失效'
          + '（已经发出去的消息不受影响，平台发送时已转存副本）。',
        )) return
        const r = await post('/stickers/media/delete', { imageId: it.imageId, confirm: true })
        if (r.ok === false) return toast(r.message || '删不掉')
        toast('已删掉，配额还回来了')
        load('')
      }

      /** 固定 / 取消固定：钉住的图配额满时不会被自动淘汰 */
      const pin = async (it, next) => {
        const r = await post('/gallery/edit', { seq: it.seq, pinned: next })
        if (r.ok === false) return toast(r.message || '改不了固定状态')
        toast(next
          ? `#${it.seq} 已固定：配额满时不会淘汰它`
          : `#${it.seq} 已取消固定`)
        load('')
      }

      /**
       * 官方素材池的时间戳统一成**毫秒**。
       *
       * `created_at` / `expires_at` 官方给的是**秒**（框架原样透传成
       * `createdAt` / `expiresAt`），以前这里直接 `new Date(v)`，于是
       * 「到期」显示成 1970/1/22 04:52 —— 秒数被当成毫秒了。
       * 按量级判断而不是写死乘 1000：哪天框架改成毫秒、或者某个通道
       * 给的就是毫秒，两种都认，不会反着错一次。
       */
      const msOf = (v) => {
        const n = Number(v) || 0
        if (!n) return 0
        return n < 1e12 ? n * 1000 : n
      }

      /** 时间戳可能缺失或为 0：别渲染成 1970，那比空白更让人困惑 */
      const when = (ms) => {
        const v = msOf(ms)
        if (!v) return '未知'
        try { return new Date(v).toLocaleString('zh-CN') } catch { return '未知' }
      }

      /**
       * 到期时间给**剩余天数**，不给绝对时间。
       *
       * 这张图还能用多久，一眼就知道该不该重新上传；绝对时间还得自己在心里
       * 减一遍。已经过期就明说「已过期」，不显示负数；算出来超过十年
       * （>3650 天）基本是数据不对，宁可说「未知」也不硬编一个数。
       */
      const daysLeft = (ms) => {
        const v = msOf(ms)
        if (!v) return '到期未知'
        const diff = v - Date.now()
        if (diff <= 0) return '已过期'
        const d = Math.ceil(diff / 86_400_000)
        if (d > 3650) return '到期未知'
        return d === 1 ? '还剩 1 天' : `还剩 ${d} 天`
      }

      const quota = Number(data?.quota) || 100
      const total = Number(data?.total) || 0
      const remaining = Number.isFinite(Number(data?.remaining))
        ? Number(data.remaining)
        : Math.max(0, quota - total)
      const used = Math.max(0, quota - remaining)
      const pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0
      const rows = Array.isArray(data?.images) ? data.images : []

      return h(Sec, {
        n, title: '线上（官方素材池）',
        right: h('button', {
          type: 'button', className: 'roost-btn', disabled: busy, onClick: () => load(''),
        }, busy ? '读取中…' : '刷新'),
      },
        h('div', { className: 'roost-note' },
          '图库里每张图发第一次时，会往官方图床上传一份、拿 qqbot-media:// 引用发出去。'
          + '这份**默认留着**——同一张图第二次发直接复用，不重传、不占新配额。'
          + '配额是机器人级共享的 100 张：不够时按「最久没动过的先走」自动淘汰，'
          + '**钉住的图不淘汰**。'),

        !data
          ? h('div', { className: 'roost-empty' }, '读着…')
          : data.ok === false
            ? h('div', { className: 'roost-empty' }, data.message || '读不到素材池')
            : h('div', null,
              h('div', { className: 'roost-note', style: { marginBottom: 6 } },
                `已用 ${used} / ${quota} · 还剩 ${remaining} 张`
                + (used >= quota
                  ? ' · 满了：这时会先淘汰最久没动过的；都钉住了就得手动删'
                  : '')),

              h('div', { style: { height: 6, borderRadius: 3, background: 'rgba(128,128,128,.2)', marginBottom: 10 } },
                h('div', {
                  style: {
                    height: '100%', borderRadius: 3, width: `${pct}%`,
                    background: used >= quota ? 'var(--danger, #c0392b)' : 'var(--ok, #2a9d5c)',
                    transition: 'width .3s',
                  },
                })),

              rows.length === 0
                ? h('div', { className: 'roost-empty' },
                  '线上还没有图——第一次发图时会自动传一份过来')
                : h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 260 } },
                  rows.map((it) => h('div', {
                    key: it.imageId || it.fileName,
                    className: 'roost-item',
                    style: { alignItems: 'center' },
                  },
                    it.previewUrl
                      ? h('img', {
                          src: it.previewUrl, alt: it.fileName, loading: 'lazy',
                          /** 预签名链接是短时效的，只当缩略图用，不缓存也不写盘 */
                          style: { width: 34, height: 34, objectFit: 'cover', borderRadius: 4, flex: '0 0 auto' },
                        })
                      : null,
                    h('span', { className: 't', style: { minWidth: 0 } },
                      /** 认得出来就是图库里的某张（`#3`）；认不出是别的插件传的 */
                      it.seq ? `#${it.seq} ` : '',
                      it.fileName || '(没文件名)',
                      h('span', { className: 'd' },
                        ` · 传于 ${when(it.createdAt)}`
                        + (it.expiresAt ? ` · ${daysLeft(it.expiresAt)}` : '')
                        + (it.seq ? '' : ' · 不是图库传的'))),
                    /**
                     * 认得出的（图库自己传的）才给「固定」——别人插件传的图我们没有
                     * 它的记录，钉了也没地方存。固定 = 配额满时自动淘汰不碰它。
                     */
                    it.seq
                      ? h('button', {
                          type: 'button', className: 'roost-btn',
                          style: { fontSize: 11, padding: '1px 8px', marginLeft: 'auto', flex: '0 0 auto' },
                          title: it.pinned
                            ? '已固定：配额满时不会自动淘汰它（点一下取消）'
                            : '固定：配额满时不会自动淘汰它',
                          onClick: () => pin(it, !it.pinned),
                        }, it.pinned ? '已固定' : '固定')
                      : null,
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      style: {
                        fontSize: 11, padding: '1px 8px', flex: '0 0 auto',
                        marginLeft: it.seq ? 4 : 'auto',
                      },
                      onClick: () => del(it),
                    }, '删')))),

              data.nextCursor
                ? h('button', {
                    type: 'button', className: 'roost-btn', disabled: busy,
                    style: { marginTop: 8 }, onClick: () => load(data.nextCursor),
                  }, busy ? '读取中…' : '加载更多')
                : null),
      )
    }

    /**
     * A3（第二轮对照）：「听」这一条腿终于有面板了。
     * 官方 Bot API 直接把语音转成文字（asrText），不用配 ASR、不用 Key；
     * 以前只能从提示词里猜「她听没听清」，现在排障能看见刚才转成了什么。
     * 数据来自 /asr/recent：内存里最近 20 条、正文截断 120 字、不落盘不进记忆。
     */
    function AsrCard({ toast }) {
      const [rows, setRows] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = useCallback(async () => {
        setBusy(true)
        try {
          const r = await get('/asr/recent')
          /** 元素也要过滤：接口契约漂了（null / 数字 / 缺 text）时不能让整张卡渲染崩 */
          setRows(Array.isArray(r?.items)
            ? r.items.filter((x) => x && typeof x === 'object' && !Array.isArray(x))
            : [])
        } catch {
          setRows([])
          if (toast) toast('读不到语音转写记录')
        } finally { setBusy(false) }
      }, [])
      useEffect(() => { load() }, [load])
      const goPreview = () => {
        /** 试听那一节保留主人定的分隔线形态，这里只给一个跳过去的入口 */
        try {
          document.getElementById('roost-tts-preview')
            ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        } catch {}
      }
      /** 每行按最坏情况取值：Symbol / 抛 valueOf / 缺字段都不许把这一页渲染崩 */
      const str = (v) => { try { return String(v ?? '') } catch { return '' } }
      const num = (v) => { try { return Number(v) } catch { return NaN } }
      const renderRow = (r, i) => {
        const text = str(r.text)
        const at = num(r.at)
        const when = Number.isFinite(at) && at > 0
          ? new Date(at).toLocaleTimeString('zh-CN') : '时间未知'
        const chars = num(r.chars) || 0
        return h('div', { key: str(r.at ?? i) + ':' + i, className: 'roost-item' },
          h('span', { className: 't' }, r.ok ? text : '（没转出文字）',
            h('span', { className: 'd' },
              ' · ' + (r.chatId ? '会话 ' + str(r.chatId).slice(-10) : '未标会话')
              + ' · ' + when
              + (chars > text.length ? ` · 原长 ${chars} 字` : ''))),
          h('span', { className: 'd' }, r.ok ? '已转写' : '没听清'),
        )
      }
      return h(Sec, {
        n: '02', title: '听语音（官方转写）',
        right: h('button', {
          type: 'button', className: 'roost-btn', disabled: busy, onClick: load,
        }, busy ? '读取中…' : '刷新'),
      },
        h('div', { className: 'roost-note' },
          '语音由官方直接转成文字给她，这里不用配识别服务。下面是最近 20 条转写读数：只在内存里，重启就没了，不写盘、不进记忆，正文只留前 120 字。'),
        h('div', { className: 'roost-note' },
          '想看「这一轮到底注入了什么」，去「排障 → 上下文」；想听她怎么说，点下面这颗去 01 卡末尾的试听。',
          h('button', {
            type: 'button', className: 'roost-btn', style: { marginLeft: 8 }, onClick: goPreview,
          }, '去试听 ↘'),
        ),
        rows === null
          ? h('div', { className: 'roost-empty' }, '读取中…')
          : rows.length
            ? h('div', { className: 'roost-list roost-scroll' }, rows.map(renderRow))
            : h('div', { className: 'roost-empty' }, '还没有语音。发一条语音给她，这里就会出现转写。'),
      )
    }

    function ExpressTab({ config, stickers, saveCfg, toast, reload, part = 'all' }) {
      return h('div', null,
        part === 'sticker' ? null : h(TtsCard, { config, saveCfg, toast, reload }),
        /** A3：听语音只在独立的「语音」页出现；老入口 part='all' 行为不变 */
        part === 'voice' ? h(AsrCard, { toast }) : null,
        /** 独立成页时它是这一页的第 01 节；留在表达页时仍是 02（排在语音后面） */
        part === 'voice' ? null : h(StickerDirsCard, {
          config, stickers, saveCfg, toast, reload,
          n: part === 'sticker' ? '01' : '02',
        }),
        /**
         * 图库是**一个**入口：图片 / 线上 / 回收站三个分区。
         *
         * 以前这里是三张卡（表情库按文件、图库按序号、官方素材池），同一批图
         * 三个页面、两套删除语义。合并之后按钮一件没少，但用户只需要记一个词。
         */
        part === 'sticker' ? h(GalleryPage, { toast, config, saveCfg }) : null,
        part === 'voice'
          ? h('div', { className: 'roost-note' }, '配图在「表达 → 图库」那一页。')
          : null,
      )
    }

    /**
     * A6（第二轮对照）：安全防护独立页。
     *
     * 上一版是纯只读（「已开启 / 已关闭」两行字），用户的反馈很直接：
     * 「这些功能的开关怎么没有」。全仓找不到第三个写 `security` 的地方，
     * 结果就是这两道闸**只能靠手改 config.json**，等于没有入口。
     *
     * 这一版改成真开关，走 `saveCfg`（`?mode=patch`，深合并）：只提交
     * `security` 下被点的那一个键，不会把 `ssrf.allowHosts` 顶掉。
     * 关掉「危险命令确认」是降安全等级的动作，先弹确认框再提交。
     */
    function SecurityTab({ config, saveCfg, toast, setTab }) {
      const s = config?.security || {}
      const ssrf = s.ssrf || {}
      const hosts = Array.isArray(ssrf.allowHosts) ? ssrf.allowHosts : []
      const [saving, setSaving] = useState(false)
      const [err, setErr] = useState('')
      const [askOff, setAskOff] = useState(false)
      /** 白名单草稿：每行一个域名；config 从别处变了且没动过草稿就跟上 */
      const [draftHosts, setDraftHosts] = useState(hosts.join('\n'))
      const [touched, setTouched] = useState(false)
      const hostKey = hosts.join('\n')
      useEffect(() => { if (!touched) setDraftHosts(hostKey) }, [hostKey])

      const patch = async (next, okText) => {
        if (!saveCfg) { setErr('面板没接上保存接口，请刷新重试'); return }
        setSaving(true); setErr('')
        try {
          const r = await saveCfg({ security: next })
          if (r && r.ok === false) setErr(r.error || r.message || '保存失败')
          else toast?.(okText || '已保存')
        } catch (e) {
          setErr(String(e?.message || e))
        } finally {
          setSaving(false)
        }
      }

      const saveHosts = () => {
        const list = draftHosts.split(/[\s,，;；]+/).map((x) => x.trim()).filter(Boolean)
        setTouched(false)
        patch({ ssrf: { allowHosts: list } }, list.length ? `已保存 ${list.length} 个域名` : '白名单已清空')
      }

      /** 状态字与开关并排：文字说清「现在是开是关」，开关负责改 */
      const row = (label, on, hint, onToggle, extra) => h('div', { className: 'roost-item' },
        h('span', { className: 't' }, label,
          h('span', { className: 'd' }, ' · ' + (on ? '已开启' : '已关闭'))),
        h('div', {
          style: {
            marginLeft: 'auto', display: 'flex', alignItems: 'center',
            gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end',
          },
        },
          h('span', { className: 'd', style: { textAlign: 'right' } }, hint),
          extra || null,
          onToggle ? h(Switch, {
            on, disabled: saving || !config, label,
            onToggle,
          }) : null))

      return h('div', null,
        /**
         * config 没拉到时开关是禁用的。上一版把提示只放在第 03 段，用户看到的是
         * 「输入框点了没反应」——现在这条顶到最上面，先说清为什么点不动。
         */
        config ? null : h('div', { className: 'roost-empty', style: { marginBottom: 8 } },
          '配置还在读（开关暂时点不动）。一直这样的话点下面「去配置全文核一遍」看看 /config 接口。'),
        h(Sec, { n: '01', title: '危险命令确认' },
          row('执行前先在 QQ 里问一句「确认」', s.dangerousConfirm !== false,
            '删根目录 / 格式化 / 关机 / 下载后执行；60 秒不回就拦下。',
            (next) => (next ? patch({ dangerousConfirm: true }, '已开启') : setAskOff(true))),
          h('div', { className: 'roost-note' },
            '对应 config.security.dangerousConfirm。这是工具层的硬闸，不靠模型自觉；关掉等于把这些动作直接放行，'
            + '所以关闭要先在面板上确认一次。'),
        ),
        h(Sec, { n: '02', title: '出站 URL 防护（SSRF）' },
          row('默认拒绝内网地址', !ssrf.allowPrivate,
            '协议 / 端口 / DNS 解析后的逐 IP 都校验。',
            (next) => patch({ ssrf: { allowPrivate: !next } }, next ? '已改为放行内网' : '已恢复默认拒绝'),
            h('span', { className: 'd', style: { opacity: 0.7 } }, '（开着 = 允许自建内网服务）')),
          h('div', { className: 'roost-note' },
            '关闭后只放开 10/8、172.16/12、192.168/16、100.64/10 这类局域网段；'
            + '回环、云元数据（169.254）和保留段照旧拦着。'),
          h('div', { style: { marginTop: 10 } },
            h('div', { className: 'roost-note', style: { marginBottom: 6 } },
              `显式放行的域名：${hosts.length} 个。每行一个，只写域名（端口和协议不用写）。`),
            h('textarea', {
              className: 'roost-input',
              value: draftHosts,
              spellCheck: false,
              placeholder: '例如：raw.githubusercontent.com',
              rows: 3,
              disabled: saving || !config,
              style: { width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 },
              onChange: (e) => { setTouched(true); setDraftHosts(e.target.value) },
            }),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
              h('button', {
                type: 'button', className: 'roost-primary',
                disabled: saving || !config || !touched,
                onClick: saveHosts,
              }, '保存白名单'),
              h('span', { className: 'd' }, '生图、TTS、云端 ASR、备份远端这些填 URL 的地方共用同一道校验。'),
            ),
          ),
          h('div', { className: 'roost-note', style: { marginTop: 8 } },
            '插件市场的几个入口（raw.githubusercontent.com / codeload.github.com / github.com）'
            + '不参与 DNS 网段校验——它们不归攻击者控制，而开了 Clash 之类 fake-ip 代理时所有域名'
            + '都会解析成 198.18.x.x 假地址，逐 IP 校验会把「挂了代理的正常用户」全拦死。'),
        ),
        h(Sec, { n: '03', title: '在哪儿看 / 怎么排查' },
          config ? null : h('div', { className: 'roost-empty' }, '配置还没读到，上面的状态按默认值显示。'),
          err ? h('div', { className: 'roost-empty', style: { color: 'var(--danger, #e5484d)' } }, err) : null,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => { if (setTab) setTab('config') },
            }, '去配置全文核一遍 ↗'),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => { if (setTab) setTab('logs') },
            }, '去排障看日志 ↗'),
          ),
          h('div', { className: 'roost-note' },
            '这一页的开关直接写服务端配置（深合并，只改被点的那一个键）；'
            + '「配置全文」仍可看到同一个 security 段，两边读的是同一份 —— 改完立刻生效，不用重启。'),
        ),
        askOff ? h(ConfirmModal, {
          title: '关掉危险命令确认？',
          danger: true,
          message: '关掉之后，删根目录、格式化磁盘、关机、下载后直接执行这类命令不会再在 QQ 里问你，模型说执行就执行。\n\n'
            + '只建议在完全信任当前模型与工作区的时候这么做。',
          confirmText: '仍然关掉',
          onClose: () => setAskOff(false),
          onConfirm: async () => { setAskOff(false); await patch({ dangerousConfirm: false }, '已关闭') },
        }) : null,
      )
    }

    /**
     * 关于：版本、仓库、许可、反馈群。
     *
     * 以前这些散在「更新」页和 README 里——用户想知道「我装的是哪个版本、
     * 这个项目能不能商用」，得翻三处。单独一页成本极低。
     */
    function AboutTab({ toast }) {
      const [ver, setVer] = useState(null)
      useEffect(() => {
        get('/update/check').then((r) => setVer(r && r.ok !== false ? r : null)).catch(() => setVer(null))
      }, [])
      const copy = (t) => {
        try { navigator.clipboard?.writeText(t) } catch {}
        toast?.('已复制')
      }
      const row = (k, v) => h('div', { style: { display: 'flex', gap: 10, padding: '3px 0' } },
        h('span', { style: { minWidth: 88, opacity: 0.72 } }, k),
        h('span', null, v),
      )
      return h('div', null,
        h(Sec, { n: '01', title: '版本' },
          /**
           * 字段名是 `own`（运行中版本）/ `installed`（磁盘上那份），
           * 以前读的是 `current` / `version`——`updater.check()` 从来不返回
           * 这两个名字，于是这块永远显示「没读到」，而「最新版本」是好的
           * （那个字段确实叫 `latest`）。
           */
          row('当前版本', ver?.own || ver?.installed || '（没读到，稍后刷新）'),
          ver?.installed && ver?.own && ver.installed !== ver.own
            ? row('已装版本', `${ver.installed}（重启后生效）`)
            : null,
          ver?.latest ? row('最新版本', ver.latest + (ver.hasUpdate ? '（有新版，去「更新」页装）' : '（已是最新）')) : null,
        ),
        h(Sec, { n: '02', title: '仓库与许可' },
          row('GitHub', h('a', { href: 'https://github.com/roost-qq/dsh-roost', target: '_blank', rel: 'noreferrer' }, 'roost-qq/dsh-roost')),
          row('Gitee', h('a', { href: 'https://gitee.com/tdcq9594/dsh-roost', target: '_blank', rel: 'noreferrer' }, 'tdcq9594/dsh-roost')),
          /**
           * 许可改过一次：**本仓**（dsh-roost 这一层）已经换成 AGPL-3.0，
           * 旧文案还写着「自写协议 v2.0，非 OSI 许可」——那是框架
           * qq-bot-roost 的协议，两层不是同一个。照旧文案写会误导：
           * AGPL 明确允许商用，义务是「改过的版本对外提供服务要公开源码」。
           */
          h('div', { className: 'roost-note' },
            'dsh-roost 以 AGPL-3.0 发布（OSI 认可的开源许可）：可以免费使用、修改、再分发；'
            + '改过的版本只要对外提供服务，就必须一并公开源码。'
            + '框架本体 qq-bot-roost 是另一套协议（永久免费、禁止收费与商业使用），这一层是把它接进 DSH 的插件。'),
        ),
        h(Sec, { n: '03', title: '交流反馈群' },
          h('div', { style: { display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' } },
            /**
             * 二维码走宿主路由读仓库里的图（随包发布），不内联进 client.js。
             * 白底是必要的：二维码图片本身透明，深色主题下会糊成一片。
             *
             * **只给宽、高留 auto**：这张是 QQ 的群分享卡片（1005×1305，竖版，
             * 上面还有群头像和群名），不是正方形二维码。以前写死 `width:168;
             * height:168` 会把它横压竖拉——定位方块变成椭圆，扫码成功率跟着掉，
             * 而「图糊了」看起来像图片质量问题，没人会想到是 CSS 比例。
             */
            h('img', {
              src: API + '/community-qr',
              alt: '交流群二维码',
              style: { width: 168, height: 'auto', borderRadius: 6, flex: '0 0 auto', background: '#fff' },
            }),
            h('div', { style: { minWidth: 200 } },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                h('span', null, 'QQ 群 1130901545'),
                h('button', { type: 'button', className: 'roost-btn', onClick: () => copy('1130901545') }, '复制群号'),
              ),
              h('div', { className: 'roost-note' }, '手机扫码进群；出问题先看「排障」页的日志，再来群里问。'),
            ),
          ),
        ),
      )
    }

    /** 模型：聊天用哪个、按聊天单独选、清单里有什么。原来是「设置」里最上面那块。 */
    function ModelTab({ toast, currentChatId, config, saveCfg }) {
      return h(ModelBlock, { toast, currentChatId, config, saveCfg })
    }

    /**
     * 功能包（2026-11-22，能力组第三页）
     *
     * 解决的问题很具体：宿主有些能力得靠外部依赖（图片处理、音频转码），
     * 以前只有扩展 API 能触发安装，装在哪、装没装、能不能卸，用户没地方看。
     *
     * 这页做三件事：**看见、装上、卸掉**。另外把「自动查找找过哪儿」摊开——
     * 用户把包手动拷进某个扩展目录时，能一眼确认面板到底认没认出来。
     *
     * 和「扩展」组的区别：扩展是**功能**的单位，这里是**依赖**的单位。
     * 一个包可能被多个功能用（ffmpeg 既转码又抽帧），所以不挂在某个扩展下面。
     */
    const DEP_GROUPS = [
      ['image', '图片处理', '图库去重、缩略图、拼长图——没装就退回简版，不会报错'],
      ['media', '媒体处理', '视频抽帧、音频转码'],
      ['misc', '其他', '按需装的小件'],
    ]

    /**
     * 一个包的来源徽章。
     *
     * 必须说清「能用」到底是哪一份在起作用：共享目录那份面板能卸，扩展
     * 自带的那份不能（删了会把扩展弄坏）。只写「已安装」会让用户去点一个
     * 不存在的卸载按钮。
     */
    function depSourceOf(p) {
      const f = p && p.found
      if (!f) return { text: '未安装', kind: 'off' }
      /**
       * 包目录在、可执行文件不在（ffmpeg 特有的半坏状态：杀毒隔离、
       * 装一半断了）。说「已装」会让用户以为能转码，实际一跑就报错。
       */
      if (p.available === false) return { text: `包在但不可用（${f.version}）`, kind: 'off' }
      if (f.kind === 'shared') return { text: `已装 ${f.version}`, kind: 'shared' }
      if (f.kind === 'ext') return { text: `由扩展 ${f.id} 提供 ${f.version}`, kind: 'other' }
      return { text: `宿主自带 ${f.version}`, kind: 'other' }
    }

    function DepsTab({ toast, quick, setTab }) {
      const [st, setSt] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState('')

      const load = useCallback(async () => {
        try {
          const [r, ox] = await Promise.all([
            quick('sharedDeps.status'),
            quick('onnx.status'),
          ])
          if (r && r.ok === false) { setErr(r.message || '读依赖状态失败'); return }
          /**
           * ONNX 状态并进来单独用（不塞 st.runtimes——那是语音页只读展示）。
           * onnx.status 失败不算墙：站点老版本可能没这个 op，不影响功能包页。
           */
          setSt({ ...r, onnx: ox && ox.ok !== false ? ox : null })
          setErr('')
        } catch (e) {
          setErr(e?.message || '读依赖状态失败')
        }
      }, [quick])

      useEffect(() => { load() }, [load])

      /**
       * 安装中轮询：npm 是几十秒到几分钟的事，服务端把进度放在 `installing`
       * 里（谁问都答同一份真相）。装完 `installing` 变 null，这个 effect 自己停。
       * ONNX 的三套安装器各自有 `install.running`，任一在跑就继续轮询。
       */
      const onnxBusy = (ox) => Boolean(ox && (
        ox.install?.running || ox.model?.install?.running || ox.rerankModel?.install?.running
      ))
      useEffect(() => {
        if (!st || (!st.installing && !onnxBusy(st.onnx))) return undefined
        const t = setTimeout(load, 1500)
        return () => clearTimeout(t)
      }, [st, load])

      const call = async (op, arg, okMsg, keyOverride) => {
        const key = keyOverride || String(arg?.name || (arg?.names ? 'batch' : 'scan'))
        setBusy(key)
        try {
          const r = await quick(op, arg)
          toast?.(r && r.ok === false ? (r.message || '操作失败') : (okMsg || '好了'))
          await load()
        } catch (e) {
          toast?.(e?.message || '操作失败')
        } finally {
          setBusy('')
        }
      }

      const rescan = () => call('sharedDeps.scan', {}, '已重新扫过一遍')
      /**
       * `opts` 目前只有一个用法：ffmpeg 的「用系统那份」（`preferSystem`）。
       * 别的包不接受这个参数——它只影响 ffmpeg 的判定分支。
       */
      const install = (name, opts) => call(
        'sharedDeps.install', { name, ...(opts || {}) },
        opts?.preferSystem ? `改用系统里的 ${name}，不再下载` : `开始安装 ${name}（可能要等一会儿）`,
      )
      const remove = (name) => {
        if (!window.confirm(`卸载 ${name}？\n\n用到它的功能会退回简版（图库不去重、缩略图直出原图之类），数据本身不会丢。`)) return
        call('sharedDeps.remove', { name }, `已卸载 ${name}`)
      }
      const installGroup = (names) => {
        if (!names.length) return
        call('sharedDeps.install', { names }, `开始安装 ${names.length} 个包，装完会自动刷新`)
      }

      /**
       * ONNX 一行：运行时 / embedding 模型 / rerank 模型共用一套渲染。
       * op 三件套（install / cancel / uninstall）服务端已接好，这里只管按钮。
       * 进度直接读服务端 `install`（percent / message / error），前端不算。
       */
      const onnxRow = (key, label, hint, spec, ops) => {
        const install = spec?.install || {}
        const running = Boolean(install.running)
        const isBusy = busy === key || running
        const bytes = spec?.usage?.bytes || 0
        const sizeText = bytes > 0 ? ` · 已占 ${(bytes / 1048576).toFixed(0)} MB` : ''
        const statusText = running
          ? (install.message || '安装中…') + (install.total > 0 ? ` ${install.percent || 0}%` : '')
          : install.error ? `失败：${install.error}`
            : spec?.ready ? `已装好${sizeText}` : '未安装'
        return h('div', {
          key,
          style: {
            border: '1px solid var(--border, rgba(128,128,128,.22))',
            borderRadius: 10, padding: '10px 12px', marginBottom: 8,
            display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
          },
        },
          h('div', { style: { flex: '1 1 320px', minWidth: 0 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('b', { style: { fontSize: 13 } }, label),
              h('span', {
                style: {
                  fontSize: 11, padding: '1px 7px', borderRadius: 999,
                  border: '1px solid var(--border, rgba(128,128,128,.3))',
                  opacity: running ? 0.95 : (spec?.ready ? 0.95 : 0.55),
                },
              }, statusText),
            ),
            h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 3, wordBreak: 'break-all' } }, hint),
            running && install.total > 0
              ? h('div', {
                style: {
                  marginTop: 6, height: 4, borderRadius: 2,
                  background: 'var(--border, rgba(128,128,128,.2))', overflow: 'hidden',
                },
              }, h('div', {
                style: {
                  height: '100%', width: `${install.percent || 0}%`,
                  background: 'var(--accent, #4a90d9)', transition: 'width .4s',
                },
              }))
              : null,
          ),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' } },
            running
              ? h('button', {
                type: 'button', className: 'roost-btn', disabled: busy === key,
                onClick: () => call(ops.cancel, {}, '已取消', key),
              }, '取消')
              : h('button', {
                type: 'button', className: 'roost-btn', disabled: isBusy,
                onClick: () => call(ops.install, {}, `开始下载${label}（可能要等一会儿）`, key),
              }, spec?.ready ? '重新安装' : '一键安装'),
            spec?.ready && !running
              ? h('button', {
                type: 'button', className: 'roost-btn', disabled: isBusy,
                onClick: () => {
                  if (!window.confirm(`卸载${label}？\n\n用到它的功能会退回原样（本地向量/重排关掉），数据本身不会丢。`)) return
                  call(ops.uninstall, {}, `已卸载${label}`, key)
                },
              }, '卸载')
              : null,
          ),
        )
      }

      if (err && !st) {
        return h(Sec, { n: '01', title: '功能包' },
          h('p', { style: { fontSize: 12.5, opacity: 0.8 } }, err),
          h('button', { type: 'button', className: 'roost-btn', onClick: load }, '重试'),
        )
      }
      if (!st) return h('div', { style: { padding: 16, fontSize: 12.5, opacity: 0.7 } }, '正在读依赖状态…')

      const packages = st.packages || {}
      const groups = {}
      for (const [name, p] of Object.entries(packages)) {
        const g = (p && p.group) || 'misc'
        if (!groups[g]) groups[g] = []
        groups[g].push([name, p])
      }

      const card = (name, p) => {
        const src = depSourceOf(p)
        const installing = st.installing && st.installing.name === name
        /** ffmpeg 特殊：包在但二进制不在，也算「不能安装来完成」——要重装 */
        const needReinstall = name === '@ffmpeg-installer/ffmpeg' && !p.available
        const canInstall = !p.found || needReinstall
        const isBusy = busy === name || Boolean(installing)
        return h('div', {
          key: name,
          style: {
            border: '1px solid var(--border, rgba(128,128,128,.22))',
            borderRadius: 10, padding: '10px 12px', marginBottom: 8,
            display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
          },
        },
          h('div', { style: { flex: '1 1 230px', minWidth: 0 } },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              h('b', { style: { fontSize: 13 } }, name),
              h('span', {
                style: {
                  fontSize: 11, padding: '1px 7px', borderRadius: 999,
                  border: '1px solid var(--border, rgba(128,128,128,.3))',
                  opacity: src.kind === 'off' ? 0.55 : 0.95,
                },
              }, src.text),
            ),
            h('div', { style: { fontSize: 12, opacity: 0.75, marginTop: 4 } }, p.desc || ''),
            h('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } },
              [p.size, p.range ? `版本 ${p.range}` : ''].filter(Boolean).join(' · ')),
            p.found && p.found.kind !== 'shared'
              ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 3 } }, `位置：${p.found.dir || ''}`)
              : null,
            p.system
              ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 3 } }, `系统 PATH 里已有：${p.system}`)
              : null,
            /**
             * 来源说明：用户最常问的两句是「npm 装不上还有别的办法吗」和
             * 「为什么 ffmpeg 不能也内置」。直接把答案写在卡片上。
             */
            h('div', { style: { fontSize: 11, opacity: 0.5, marginTop: 3, lineHeight: 1.6 } },
              name === '@ffmpeg-installer/ffmpeg'
                ? 'npm 装不上时会引导用系统 ffmpeg；这个包不进内置镜像（8 个平台子包、上百 MB）'
                : 'npm 装不上时会自动改用市场内置包，不需要 npm'),
          ),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto', flexWrap: 'wrap' } },
            installing
              ? h('span', { style: { fontSize: 11.5, opacity: 0.75 } },
                  `安装中 ${Math.round((st.installing.elapsedMs || 0) / 1000)}s`
                  + (st.installing.step ? ` · ${st.installing.step}` : ''))
              : null,
            canInstall
              ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: isBusy,
                  onClick: () => install(name),
                }, isBusy ? '处理中…' : (p.found ? '重新安装' : '安装'))
              : null,
            /**
             * ffmpeg 专属：系统里那份能用、又没有可执行文件时，允许直接采纳。
             *
             * 为什么不自动采纳：扩展是通过受管块里的 `ROOST_DEPS_DIR` 找
             * `<deps>/node_modules/@ffmpeg-installer/<plat>/ffmpeg.exe` 的，系统
             * PATH 上那份它看不见。让用户自己选，才不会出现「面板说好了、
             * 扩展说没装」。
             */
            p.system && !p.available
              ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: isBusy,
                  onClick: () => install(name, { preferSystem: true }),
                }, '用系统那份')
              : null,
            p.removable
              ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: isBusy,
                  onClick: () => remove(name),
                }, '卸载')
              : null,
          ),
        )
      }

      return h('div', null,
        h(Sec, {
          n: '01', title: '查找范围',
          right: h('button', {
            type: 'button', className: 'roost-btn', disabled: busy === 'scan', onClick: rescan,
          }, busy === 'scan' ? '扫描中…' : '重新扫描'),
        },
          h('div', { style: { fontSize: 12.5, lineHeight: 1.95, wordBreak: 'break-all' } },
            h('div', null,
              h('span', { style: { opacity: 0.7 } }, '共享依赖目录：'),
              h('code', { style: { fontSize: 11.5 } }, st.dir || '')),
            (st.dirs || []).map((d, i) => h('div', { key: `${d.kind}-${i}` },
              h('span', { style: { opacity: 0.7 } }, `${d.label}：`),
              h('code', { style: { fontSize: 11.5 } }, d.dir || ''))),
          ),
          h('p', { style: { fontSize: 11.5, opacity: 0.6, marginTop: 6, lineHeight: 1.7 } },
            '装的只有一处（共享目录），但判断「有没有」会按上面的顺序找一遍：'
            + '扩展自带的那份、宿主自带的那份都算数，不会让你重复下载。'
            + '标着「由扩展 X 提供」的包不归这里管，删了会把那个扩展弄坏。'),
        ),
        /** 语音运行时只读展示；ONNX 那两项有自己的安装区块，不在这里（也别再跳语音页） */
        (st.runtimes || []).filter((r) => !String(r.id || '').startsWith('onnx')).length
          ? h(Sec, { n: '02', title: '语音运行时（只读）' },
              h('p', { style: { fontSize: 11.5, opacity: 0.6, margin: '0 0 8px', lineHeight: 1.7 } },
                '这两个目录装的是语音引擎，有各自的安装器和进度条。这里只让你看见'
                + '「本体一共装了什么」，装和卸请回「语音」页——两套 npm 同时接管会互相踩。'),
              (st.runtimes || []).filter((r) => !String(r.id || '').startsWith('onnx')).map((r) => h('div', {
                key: r.id,
                style: {
                  border: '1px solid var(--border, rgba(128,128,128,.22))',
                  borderRadius: 10, padding: '10px 12px', marginBottom: 8,
                  display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap',
                },
              },
                h('div', { style: { flex: '1 1 230px', minWidth: 0 } },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                    h('b', { style: { fontSize: 13 } }, r.label || r.id),
                    h('span', {
                      style: {
                        fontSize: 11, padding: '1px 7px', borderRadius: 999,
                        border: '1px solid var(--border, rgba(128,128,128,.3))',
                        opacity: r.exists ? 0.95 : 0.55,
                      },
                    }, r.exists
                      ? `已装 ${r.packages.length}${r.packages.length >= 20 ? '+' : ''} 个包`
                      : '未安装'),
                  ),
                  h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 3, wordBreak: 'break-all' } }, r.dir || ''),
                  r.exists
                    ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 3, wordBreak: 'break-all' } },
                        r.packages.join('、') + (r.packages.length >= 20 ? ' …' : ''))
                    : null,
                ),
                h('div', { style: { marginLeft: 'auto' } },
                  h('button', {
                    type: 'button', className: 'roost-btn', onClick: () => setTab?.('express'),
                  }, '去语音页')),
              )),
            )
          : null,
        /** 本地 ONNX 能力：运行时 + 两个模型，各自安装/卸载/进度（不再误跳语音页） */
        st.onnx
          ? h(Sec, { n: '03', title: '本地智能（可选，按需安装）' },
              h('p', { style: { fontSize: 11.5, opacity: 0.6, margin: '0 0 10px', lineHeight: 1.7 } },
                '本地向量和重排的模型，不依赖任何外部 API。装好后到「记忆配置 → 召回预览与参数」'
                + '打开「本地向量 / 本地重排」开关才生效（默认关，不开零影响）。'
                + '运行时约 300 MB、embedding 模型约 450 MB、重排模型约 190 MB，按需装。'),
              onnxRow('onnx-runtime', 'ONNX 运行时',
                '推理引擎，两个本地模型的共同前置', st.onnx,
                { install: 'onnx.install', cancel: 'onnx.cancel', uninstall: 'onnx.uninstall' }),
              onnxRow('onnx-embed', '本地 embedding 模型（e5-small）',
                '中文向量；装好后在「记忆配置」开本地向量开关', st.onnx.model,
                { install: 'onnx.modelInstall', cancel: 'onnx.modelCancel', uninstall: 'onnx.modelUninstall' }),
              onnxRow('onnx-rerank', '本地重排模型（hs-rerank-1）',
                'cross-encoder；装好后在「记忆配置」开本地重排开关', st.onnx.rerankModel,
                { install: 'onnx.rerankInstall', cancel: 'onnx.rerankCancel', uninstall: 'onnx.rerankUninstall' }),
            )
          : null,
        ...DEP_GROUPS.filter(([g]) => (groups[g] || []).length).map(([g, label, hint], i) => {
          const list = groups[g]
          const missing = list.filter(([, p]) => !p.found).map(([n]) => n)
          return h(Sec, {
            key: g,
            n: String(i + 4).padStart(2, '0'),
            title: label,
            right: missing.length
              ? h('button', {
                  type: 'button', className: 'roost-primary', disabled: busy === 'batch',
                  onClick: () => installGroup(missing),
                }, busy === 'batch' ? '安装中…' : `安装全部 ${missing.length} 个`)
              : null,
          },
            h('p', { style: { fontSize: 11.5, opacity: 0.6, margin: '0 0 8px' } }, hint),
            list.map(([name, p]) => card(name, p)),
          )
        }),
      )
    }

    /** 更新：版本与更新说明 + 反馈群。属于「这台机器怎么维护」，不跟聊天设置混。 */
    /**
     * 5.7 模拟测试：假主人 / 假群友发一句，逐步显示每一层怎么处理。
     *
     * 这页**只读**——它调 `/simulate/run`，服务端跑纯函数、一条都不真发。
     * 所以界面上不设「确认发送」之类的东西，文案也要把「不会真发」说在前面，
     * 否则用户会以为自己在测试群里发了条消息。
     *
     * 为什么不做成弹窗：结果有 6 层，弹窗里滚起来很难看；而且改一句话再跑一次
     * 是高频动作，整页留得住输入框和上一次结果。
     */
    const SIM_PERSONAS = [
      { id: 'owner', label: '主人（私聊）', kind: 'c2c', bucket: 'owner', name: '主人', mentioned: false },
      { id: 'member', label: '群友（@ 她）', kind: 'group', bucket: 'member', name: '群友', mentioned: true },
      { id: 'stranger', label: '群友（没 @）', kind: 'group', bucket: 'member', name: '群友', mentioned: false },
    ]

    function SimTab({ toast }) {
      const [text, setText] = useState('')
      const [persona, setPersona] = useState('owner')
      const [busy, setBusy] = useState(false)
      const [res, setRes] = useState(null)

      const run = async () => {
        if (!text.trim()) return toast('先写一句要模拟的话')
        const p = SIM_PERSONAS.find((x) => x.id === persona) || SIM_PERSONAS[0]
        setBusy(true)
        const r = await post('/simulate/run', {
          text, kind: p.kind, mentioned: p.mentioned, bucket: p.bucket, name: p.name,
        })
        setBusy(false)
        if (r.ok === false) return toast(r.message || '模拟失败')
        setRes(r)
      }

      const mark = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '·')
      const tone = (ok) => (ok === true ? 'var(--ok)' : ok === false ? 'var(--bad)' : 'var(--muted, #888)')

      /** 每层展开一行最关键的细节，其余不铺开——面板不是日志 */
      const detailLine = (s) => {
        const d = s.detail || {}
        if (s.layer === 'inbound') return d.rendered ? `AI 看到的是：${d.rendered}` : ''
        if (s.layer === 'model') {
          if (!d.provider) return d.effort ? `思考强度：${d.effort}` : ''
          return `${d.provider} / ${d.model}${d.effort ? ` · 强度 ${d.effort}` : ''}（${d.source}）`
        }
        if (s.layer === 'tools') {
          if (!d.available) return ''
          const cut = d.denied?.length ? `；收走：${d.denied.slice(0, 6).join('、')}${d.denied.length > 6 ? '…' : ''}` : ''
          return `能用 ${d.available.length} / ${d.total} 个${cut}`
        }
        if (s.layer === 'decide') {
          if (d.cooling) return `冷却中，会等 ${Math.ceil((d.delayMs || 0) / 1000)} 秒再把消息一起交出去`
          return d.force ? '这句是「明确在叫她」，刹车策略不拦' : ''
        }
        return ''
      }

      return h('div', null,
        h(Sec, {
          n: '01', title: '发一句试试',
          right: res
            ? h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => {
                const lines = [`【模拟结果】${res.summary}`]
                for (const s of res.steps || []) lines.push(`${mark(s.ok)} ${s.title}：${s.reason}`)
                lines.push('（本次是 dry run，一条消息都没真发）')
                navigator.clipboard?.writeText(lines.join('\n')).then(
                  () => toast('已复制'),
                  () => toast('复制失败，手动选一下吧'),
                )
              },
            }, '复制结果')
            : null,
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '假扮一个人发一句话，看框架会怎么处理。**不会真的发出去**，也不会写投递账本、不动冷却和配额。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' } },
            h('select', {
              className: 'roost-input', style: { width: 'auto', minWidth: 140 },
              value: persona, onChange: (e) => setPersona(e.target.value),
            }, SIM_PERSONAS.map((p) => h('option', { key: p.id, value: p.id }, p.label))),
            h('textarea', {
              className: 'roost-input', rows: 3, value: text,
              placeholder: '比如：在吗 / 今天好热 / /roll',
              style: { flex: '1 1 320px', minWidth: 220, resize: 'vertical' },
              onChange: (e) => setText(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run() },
            }),
            h('button', {
              type: 'button', className: 'roost-btn roost-btn-primary',
              disabled: busy, onClick: run,
            }, busy ? '算着…' : '跑一次'),
          ),
        ),

        res
          ? h(Sec, { n: '02', title: '每一层怎么处理' },
            h('div', {
              className: 'roost-note',
              style: {
                marginBottom: 10, padding: '8px 10px', borderRadius: 8,
                background: res.verdict === 'reply' ? 'rgba(0,160,90,.08)' : 'rgba(160,160,160,.10)',
              },
            }, res.summary),
            h('div', { className: 'roost-list' },
              (res.steps || []).map((s, i) =>
                h('div', { key: i, className: 'roost-item', style: { alignItems: 'flex-start' } },
                  h('span', { style: { flex: '0 0 14px', color: tone(s.ok), fontWeight: 700 } }, mark(s.ok)),
                  h('span', { className: 't' },
                    h('div', { style: { fontWeight: 600 } }, s.title),
                    h('div', { className: 'roost-muted', style: { fontSize: 11.5 } }, s.reason),
                    detailLine(s)
                      ? h('div', { className: 'roost-muted', style: { fontSize: 11, marginTop: 2, opacity: .8 } }, detailLine(s))
                      : null,
                  ),
                ),
              ),
            ),
            h('div', { className: 'roost-note', style: { marginTop: 10 } },
              '出站内容取决于模型输出，模拟不跑模型（跑一次要花钱，结果也不可复现）——这里只算「会不会发、走哪条通道、要不要等」。'),
          )
          : null,
      )
    }

    function UpdateTab({ toast }) {
      return h('div', null,
        h(UpdatesBlock, { toast }),
        h(ChangelogBlock, { toast }),
        h(FeedbackCard, { toast }),
      )
    }

    /**
     * 扩展独立成一级分组（2026-11-12），下辖三页，和 aurabot 的「模块」组同构：
     *   已安装 ext / 市场 ext-market / 接口 ext-api
     *
     * 为什么拆：原来一页里同时有「档位矩阵 + 市场列表 + 已装清单 + 令牌」，
     * 装一个扩展要滚三次。拆完每页只回答一个问题。
     */
    /**
     * 5.9 新建扩展向导：填几个字段，生成一份能直接跑的骨架。
     *
     * 默认收起——绝大多数人打开「已安装」是来看/改已装的东西，不是要写扩展。
     * 展开后一次只问必需项，工具声明用「一行一个 `名字|说明`」的纯文本，
     * 不做动态行编辑器：写三五个工具时敲文本比点十次「加一行」快。
     *
     * 生成成功后**不自动重载**：stdio 扩展要宿主重新拉进程，中途重载会让
     * 正在跑的对话断掉。所以只把目录和下一步摊出来，让人自己挑时机。
     */
    function ExtWizardBlock({ toast }) {
      const [open, setOpen] = useState(false)
      const [f, setF] = useState({
        id: '', name: '', description: '',
        transport: 'stdio', port: '',
        tools: 'ping|测试一下通不通',
      })
      const [busy, setBusy] = useState(false)
      const [res, setRes] = useState(null)
      const set = (k, v) => setF((x) => ({ ...x, [k]: v }))

      const gen = async () => {
        /** `名字|说明` 拆开；只写名字也认（说明留空由服务端兜底成名字） */
        const tools = String(f.tools || '')
          .split('\n')
          .map((line) => {
            const [name, ...rest] = line.split('|')
            return { name: String(name ?? '').trim(), description: rest.join('|').trim() }
          })
          .filter((t) => t.name || t.description)

        setBusy(true)
        const r = await post('/extensions/scaffold', {
          id: f.id, name: f.name, description: f.description,
          transport: f.transport,
          port: Number(f.port) || undefined,
          tools,
        })
        setBusy(false)
        setRes(r)
        toast(r.ok === false ? (r.message || '生成失败') : (r.message || '已生成'))
      }

      return h(Sec, {
        n: '01', title: '新建扩展',
        right: h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { setOpen((v) => !v); if (open) setRes(null) },
        }, open ? '收起' : '写一个'),
      },
        h('div', { className: 'roost-note', style: { marginBottom: open ? 10 : 0 } },
          open
            ? '生成的是一份**能直接跑**的零依赖骨架：stdio 形态由宿主拉起子进程，http 形态自己起端口。同名目录已存在时不会覆盖。'
            : '想自己写扩展？填几个字段就能拿到可运行的骨架，不用先读协议文档。'),
        open
          ? h('div', null,
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 8, marginBottom: 8 } },
              h('label', { style: { fontSize: 11.5 } }, '扩展 id（英文，如 weather-lite）',
                h('input', {
                  className: 'roost-input', value: f.id, placeholder: 'weather-lite',
                  onChange: (e) => set('id', e.target.value),
                })),
              h('label', { style: { fontSize: 11.5 } }, '显示名',
                h('input', {
                  className: 'roost-input', value: f.name, placeholder: '天气',
                  onChange: (e) => set('name', e.target.value),
                })),
              h('label', { style: { fontSize: 11.5 } }, '一句话说明（给模型看）',
                h('input', {
                  className: 'roost-input', value: f.description, placeholder: '查天气',
                  onChange: (e) => set('description', e.target.value),
                })),
              h('label', { style: { fontSize: 11.5 } }, '形态',
                h('select', {
                  className: 'roost-input', value: f.transport,
                  onChange: (e) => set('transport', e.target.value),
                },
                  h('option', { value: 'stdio' }, 'stdio（宿主拉起）'),
                  h('option', { value: 'streamable-http' }, 'streamable-http（自己起端口）'))),
              f.transport === 'streamable-http'
                ? h('label', { style: { fontSize: 11.5 } }, '端口（1024–65535，默认 18080）',
                  h('input', {
                    className: 'roost-input', value: f.port, placeholder: '18080',
                    onChange: (e) => set('port', e.target.value),
                  }))
                : null,
            ),
            h('label', { style: { fontSize: 11.5, display: 'block' } },
              '工具（一行一个：名字|说明，名字只能用字母数字下划线横线）',
              h('textarea', {
                className: 'roost-input', rows: 4, value: f.tools,
                style: { width: '100%', resize: 'vertical', fontFamily: 'ui-monospace,monospace' },
                onChange: (e) => set('tools', e.target.value),
              })),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
              h('button', {
                type: 'button', className: 'roost-btn roost-btn-primary',
                disabled: busy, onClick: gen,
              }, busy ? '生成中…' : '生成骨架'),
              res?.ok === false
                ? h('span', { style: { fontSize: 11.5, color: 'var(--bad)' } }, res.message)
                : null),

            res?.ok === true
              ? h('div', {
                className: 'roost-note',
                style: { marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(0,160,90,.08)' },
              },
                h('div', null, `已生成到：${res.dir}`),
                h('div', { className: 'roost-muted', style: { fontSize: 11.5, marginTop: 2 } },
                  `文件：${(res.files || []).join('、')}`),
                (res.warnings || []).length
                  ? h('div', { style: { fontSize: 11.5, color: 'var(--warn)', marginTop: 4 } }, res.warnings.join('；'))
                  : null,
                h('div', { style: { fontSize: 11.5, marginTop: 6 } }, '下一步：'),
                h('ol', { style: { margin: '2px 0 0 16px', fontSize: 11.5, lineHeight: 1.7 } },
                  (res.next || []).map((s, i) => h('li', { key: i }, s))),
              )
              : null,
          )
          : null,
      )
    }

    /**
     * A5（第二轮对照）：扩展可以自己声明页签、还能挑一级菜单，
     * 结果是「扩展」组不再是扩展内容的全集。这张索引卡把散在各组的扩展页收在一处。
     */
    function ExtPagesIndexCard({ extPages, setTab }) {
      const pages = Array.isArray(extPages) ? extPages : []
      const groupLabel = (id) => (NAV_GROUPS.find((g) => g.id === id)?.label) || id || '未指定组'
      return h(Sec, { title: '扩展自己的页面' },
        h('div', { className: 'roost-note' },
          '扩展可以声明自己的页签，挂到任意一级菜单；这一页是总索引，免得在几个组之间来回找。点了只是切页，不改动扩展。'),
        pages.length
          ? h('div', { className: 'roost-list' },
              pages.map((p) => h('div', { key: p.id, className: 'roost-item' },
                h('span', { className: 't' }, p.nav?.label || p.id,
                  h('span', { className: 'd' }, ' · 挂在「' + groupLabel(p.nav?.group) + '」组')),
                h('button', {
                  type: 'button', className: 'roost-btn',
                  onClick: () => { if (setTab) setTab('ext:' + p.id) },
                }, '打开 ↗'),
              )),
            )
          : h('div', { className: 'roost-empty' }, '还没有扩展声明页面。装一个带界面的扩展，这里就会列出来。'),
      )
    }

    function ExtTab({ quick, toast, extPages, setTab }) {
      return h('div', null,
        h(ExtSettingsBlock, { toast, part: 'installed' }),
        h(ExtPagesIndexCard, { extPages, setTab }),
        h(ExtCapsBlock, { quick, toast }),
        h(ExtWizardBlock, { toast }),
      )
    }

    /** 市场：能装什么、装 / 更新 / 停用 */
    function ExtMarketTab({ toast }) {
      return h(ExtSettingsBlock, { toast, part: 'market' })
    }

    /** 接口：给独立会话发 /v1 客户端令牌 */
    /**
     * 6.1 扩展声明的页面。
     *
     * 只渲染**数据**，不执行扩展的任何代码：宿主已经把字段按白名单挑好、
     * 值也收敛成标量（字符串截断、url 只留 http/https），这里连 HTML 都不拼，
     * 全部当文本子节点传进去。`javascript:` 那种值在服务端就被清空了。
     *
     * 三种 kind 的呈现差别只有排版：table 对齐成列、cards 一卡一条、
     * log 一行一条。**不给扩展自定义样式的能力**——那等于让它控制面板外观，
     * 而面板上还有主人的记忆和配置。
     */
    function ExtUiPage({ id, toast }) {
      const [d, setD] = useState(null)
      /** 沙箱 iframe 的句柄：既要拿 `contentWindow` 校验来源，也要回消息 */
      const frameRef = useRef(null)

      /**
       * 沙箱页面的**唯一通道**。
       *
       * 页面是 opaque origin（`sandbox` 没给 `allow-same-origin`），它既读不到
       * 父窗口，也不能直接调面板 API。所有操作都走这里：
       *   页面 `fetch('/roost/api/quick')` → 注入的垫片转成 `postMessage`
       *   → 这里按 `viaExt` 转发 → 服务端按该扩展**实际授予的 scope** 判权
       *   → 结果回给页面。
       *
       * `viaExt` **只从这里填**：页面载荷里带的同名字段一律忽略，
       * 否则页面自称「我是 ext:manage」就能越权。
       */
      useEffect(() => {
        const onMsg = async (e) => {
          const f = frameRef.current
          if (!f || !f.contentWindow || e.source !== f.contentWindow) return
          const m = e.data
          if (!m || m.type !== 'roost:quick' || !m.id) return
          let status = 200
          let body
          try {
            body = await EXT_POST(String(m.op || ''), m.arg || {}, { viaExt: id })
            if (body && body.ok === false) status = 403
          } catch (err) {
            status = 500
            body = { ok: false, message: String((err && err.message) || err) }
          }
          try {
            f.contentWindow.postMessage({ type: 'roost:reply', id: m.id, ok: status < 400, status, body }, '*')
          } catch { /* 页面已经走了 */ }
        }
        window.addEventListener('message', onMsg)
        return () => window.removeEventListener('message', onMsg)
      }, [id])
      /** 设置表单：`null` = 还没改过，直接用服务端返回的当前值 */
      const [cfgDraft, setCfgDraft] = useState(null)
      const [cfgSecrets, setCfgSecrets] = useState({})
      const [cfgBusy, setCfgBusy] = useState(false)
      const [cfgErr, setCfgErr] = useState('')

      const load = useCallback(async () => {
        const r = await get('/extensions/ui/data?id=' + encodeURIComponent(id))
        setD(r || { ok: false, message: '没拿到数据' })
      }, [id])
      useEffect(() => { load() }, [load])

      if (!d) return h('div', { className: 'roost-empty' }, '读着…')

      /**
       * 表单与动作按钮。
       *
       * 都是**声明式**的：扩展在清单里写「显示哪些设置项」「有哪些按钮」，
       * 这里只负责画控件。设置读写走宿主已有的 `extensions.config.get/save`
       * （secret 仍然只显示「已设置 / 未设置」）；按钮只把动作名交给宿主
       * 入队，由扩展自己取走执行 —— 面板里不执行扩展代码。
       */
      const cfg = d.config && d.config.ok ? d.config : null
      const formKeys = d.form?.keys || []
      const cfgSpec = (cfg?.spec || []).filter((f) => {
        if (!d.form?.enabled) return false
        return formKeys.length ? formKeys.includes(f.key) : true
      })
      const val = (f) => (cfgDraft && Object.hasOwn(cfgDraft, f.key) ? cfgDraft[f.key] : cfg?.values?.[f.key])
      const setVal = (key, v) => setCfgDraft((prev) => ({ ...(prev || cfg?.values || {}), [key]: v }))
      const inputStyle = {
        width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
        border: '1px solid var(--line-soft)', background: 'transparent',
        color: 'inherit', fontSize: 12, fontFamily: 'inherit',
      }
      const saveCfg = async () => {
        setCfgBusy(true); setCfgErr('')
        try {
          const values = { ...(cfgDraft || cfg?.values || {}) }
          const secrets = {}
          for (const [k, v] of Object.entries(cfgSecrets)) if (v !== undefined) secrets[k] = v
          const r = await EXT_POST('extensions.config.save', { id, values, secrets })
          if (!r.ok) { setCfgErr(r.message || '保存失败'); return }
          toast(r.message || '已保存')
          setCfgSecrets({}); setCfgDraft(null)
          await load()
        } finally { setCfgBusy(false) }
      }
      const fieldRow = (f) => {
        const k = f.key
        const label = h('div', { style: { fontSize: 11.5, marginBottom: 3 } },
          f.label,
          f.hint ? h('span', { className: 'roost-muted' }, ' · ' + f.hint) : null)
        if (f.secret) {
          const typed = cfgSecrets[k]
          const isSet = Boolean(cfg?.secretSet?.[k])
          const ph = typed === undefined
            ? (isSet ? '已设置（留空不改）' : '未设置')
            : (typed === '' ? '保存后清除' : '保存后覆盖')
          return h('div', { key: k, style: { marginTop: 10 } }, label,
            h('input', {
              type: 'password', autoComplete: 'off', spellCheck: false, style: inputStyle,
              placeholder: ph, value: typed || '',
              onChange: (e) => setCfgSecrets({ ...cfgSecrets, [k]: e.target.value }),
            }))
        }
        if (f.type === 'boolean') {
          return h('label', {
            key: k, style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' },
          },
            h('input', { type: 'checkbox', checked: val(f) === true, onChange: (e) => setVal(k, e.target.checked) }),
            h('span', { style: { fontSize: 12 } }, f.label),
            f.hint ? h('span', { className: 'roost-muted', style: { fontSize: 11 } }, f.hint) : null)
        }
        if (f.type === 'select') {
          return h('div', { key: k, style: { marginTop: 10 } }, label,
            h('select', {
              style: inputStyle, value: val(f) ?? '',
              onChange: (e) => setVal(k, e.target.value),
            }, (f.options || []).map((o) => {
              const ov = typeof o === 'object' ? o.value : o
              const ol = typeof o === 'object' ? (o.label ?? o.value) : o
              return h('option', { key: String(ov), value: String(ov) }, String(ol))
            })))
        }
        const type = f.type === 'number' ? 'number' : 'text'
        return h('div', { key: k, style: { marginTop: 10 } }, label,
          h('input', {
            type, style: inputStyle,
            placeholder: f.placeholder || '',
            min: f.min, max: f.max,
            value: val(f) ?? '',
            onChange: (e) => {
              const raw = e.target.value
              setVal(k, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
            },
          }))
      }
      const pending = new Set(d.pendingActions || [])
      const actionsRow = (d.actions || []).length
        ? h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          d.actions.map((a) => h('button', {
            key: a.id, type: 'button', className: 'roost-btn',
            title: '交给扩展执行，几秒后刷新看结果',
            onClick: async () => {
              if (a.confirm && !window.confirm(`确定执行「${a.label}」？`)) return
              const r = await EXT_POST('extensions.ui.action', { id, action: a.id })
              toast(r.message || (r.ok ? '已交给扩展' : '没交上'))
              await load()
            },
          }, pending.has(a.id) ? `${a.label} · 排队中` : a.label)))
        : null
      const formBlock = cfgSpec.length
        ? h('div', {
          style: {
            border: '1px solid var(--line-soft)', borderRadius: 8,
            padding: '10px 12px', marginBottom: 10,
          },
        },
          h('div', { style: { fontWeight: 600, fontSize: 12.5, marginBottom: 2 } },
            d.form?.title || '设置'),
          h('div', { className: 'roost-muted', style: { fontSize: 11, marginBottom: 4 } },
            '改完点「保存」；标着 secret 的项只存宿主，不回显明文。'),
          cfgSpec.map(fieldRow),
          cfgErr ? h('div', { className: 'roost-note', style: { color: 'var(--warn)' } }, cfgErr) : null,
          h('div', { style: { marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: cfgBusy,
              onClick: saveCfg,
            }, cfgBusy ? '保存中…' : '保存')))
        : null

      const head = h('div', null,
        h(Sec, {
          title: d.view?.title || d.name || id,
          right: h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('span', { className: 'roost-muted', style: { fontSize: 11 } },
              d.updatedAt
                ? `更新于 ${new Date(d.updatedAt).toLocaleString()}`
                : '还没有更新时间'),
            h('button', { type: 'button', className: 'roost-btn', onClick: load }, '刷新')),
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '这个页面由扩展声明、由面板按数据渲染——扩展不能往面板里放代码，只能提供数据、设置项和按钮名。'),
        ),
        actionsRow,
        formBlock,
      )

      /**
       * 自带页面：扩展写自己的 HTML，面板用 iframe 装进来。
       *
       * 同源（`/ext-pages` 是面板自己的路由），所以页面里可以直接
       * `fetch('/roost/api/quick')` 读写设置、点按钮。宿主不再限制它能画什么。
       */
      /**
       * 自带页面：**整页交给扩展**，面板不再包标题、说明、表单。
       *
       * 早先的写法是 `h('div', null, head, iframe)`，结果旧 head（标题 + 说明 +
       * 表单）和扩展页面上下叠在一起，看着像两个页面。扩展页面自己就有标题，
       * 外层再画一遍纯属重复。
       */
      if (d.page) {
        return h('iframe', {
          ref: frameRef,
          src: API + '/ext-pages?id=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(d.page),
          title: d.nav?.label || id,
          /**
           * **沙箱**（2026-11-21）：不给 `allow-same-origin`，页面变成 opaque
           * origin——读不到父窗口、带不上面板 cookie、直接 fetch 面板接口会被
           * CORS 挡。能力收窄到「注入垫片转发的那几个 op」，且服务端再按
           * 该扩展声明过的 scope 判一次。
           *
           * 几个 `allow-*` 不是随手加的，是 5 个存量页面实测要用的：
           *   · `allow-modals`  —— `confirm()`（删人设卡/预设共 10 处）；
           *   · `allow-popups`  —— `target="_blank"` 打开 B 站（4 处）；
           *   · `allow-forms`   —— 页面里的表单提交。
           * 少了 `allow-modals` 的表现是**静默返回 false**，删除按钮全失效。
           */
          sandbox: 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox',
          /** 剪贴板要单独授权（imagegen 的「复制」按钮） */
          allow: 'clipboard-write',
          style: {
            width: '100%', height: 'calc(100vh - 136px)', minHeight: 480,
            border: 0, display: 'block', background: 'transparent',
          },
        })
      }

      if (d.ok === false) {
        return h('div', null, head,
          h('div', { className: 'roost-note', style: { color: 'var(--warn)' } },
            d.message || '这个扩展还没产出数据'),
          h('div', { className: 'roost-note' },
            '扩展把数据写到它自己目录下的 JSON 文件里（清单的 ui.view.source.file），面板只读不执行。'
            + '第一次装完通常要等它跑一次才有内容。'))
      }

      const fields = d.view?.fields || []
      const rows = Array.isArray(d.rows) ? d.rows : []
      if (!rows.length) {
        return h('div', null, head, h('div', { className: 'roost-empty' }, '暂时没有内容'))
      }

      /**
       * 按字段类型渲染一个值。
       *
       * 七种类型全部只是**排版**：服务端已经把值收敛成标量（字符串截断、
       * url/image 只留 http(s)、progress 夹到 0–100、time 是毫秒数），
       * 这里不做任何解析，也不拼 HTML——React 会把字符串当文本转义。
       */
      const cell = (f, row) => {
        const v = row[f.key]
        if (v === '' || v == null) return ''
        if (f.type === 'url') {
          return h('a', {
            href: v, target: '_blank', rel: 'noreferrer noopener',
            style: { color: 'var(--accent, inherit)', textDecoration: 'underline' },
          }, String(v))
        }
        if (f.type === 'image') {
          return h('img', {
            src: v, alt: f.label, loading: 'lazy',
            style: { maxHeight: 120, maxWidth: '100%', borderRadius: 6, display: 'block' },
          })
        }
        if (f.type === 'tag') {
          return h('span', {
            style: {
              display: 'inline-block', padding: '0 6px', borderRadius: 4, fontSize: 10.5,
              background: 'rgba(128,128,128,.16)', marginRight: 4,
            },
          }, String(v))
        }
        if (f.type === 'progress') {
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' } },
            h('span', { style: { flex: 1, height: 6, borderRadius: 3, background: 'rgba(128,128,128,.2)' } },
              h('span', {
                style: { display: 'block', height: '100%', borderRadius: 3, width: `${v}%`, background: 'var(--ok, #2a9d5c)' },
              })),
            h('span', { style: { fontSize: 10.5, flex: '0 0 auto' } }, `${v}%`))
        }
        if (f.type === 'time') {
          const t = Number(v)
          return t > 0 ? new Date(t).toLocaleString() : ''
        }
        return String(v)
      }

      const kind = d.view?.kind || 'table'

      /** list：一行一条，没有列头，最省地方 */
      if (kind === 'list') {
        const [first, ...rest] = fields
        return h('div', null, head,
          h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 520 } },
            rows.map((r, i) => h('div', { key: i, className: 'roost-item' },
              h('span', { className: 't', style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
                first ? h('span', { style: { fontSize: 12 } }, cell(first, r)) : null,
                rest.map((f) => (r[f.key] === '' || r[f.key] == null
                  ? null
                  : h('span', { key: f.key, className: 'roost-muted', style: { fontSize: 11 } },
                    `${f.label} ${cell(f, r)}`))))))),
          d.truncated ? h('div', { className: 'roost-note' }, '内容太多，只显示前一部分') : null)
      }

      if (kind === 'cards') {
        const [first, ...rest] = fields
        return h('div', null, head,
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 8 } },
            rows.map((r, i) => h('div', {
              key: i,
              style: { border: '1px solid var(--line-soft)', borderRadius: 8, padding: 10 },
            },
              h('div', { style: { fontWeight: 600, marginBottom: 4, fontSize: 12.5, lineHeight: 1.5 } },
                first ? cell(first, r) : ''),
              rest.map((f) => {
                if (r[f.key] === '' || r[f.key] == null) return null
                /** 图片整宽放在卡片里，不写「封面：」——图本身就是内容 */
                if (f.type === 'image') {
                  return h('div', { key: f.key, style: { margin: '4px 0 6px' } }, cell(f, r))
                }
                return h('div', { key: f.key, className: 'roost-muted', style: { fontSize: 11.5, lineHeight: 1.6 } },
                  `${f.label}：`, cell(f, r))
              }))),
          ),
          d.truncated ? h('div', { className: 'roost-note' }, '内容太多，只显示前一部分') : null)
      }

      if (kind === 'log') {
        return h('div', null, head,
          h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 480 } },
            rows.map((r, i) => h('div', { key: i, className: 'roost-item', style: { alignItems: 'flex-start' } },
              h('span', { className: 't' },
                fields.map((f, fi) => h('span', {
                  key: f.key,
                  style: fi === 0
                    ? { marginRight: 8 }
                    : { marginRight: 8, opacity: .8, fontSize: 11.5 },
                }, cell(f, r))))))),
          d.truncated ? h('div', { className: 'roost-note' }, '内容太多，只显示前一部分') : null)
      }

      /** table：列多、要比对时用它 */
      return h('div', null, head,
        h('div', { className: 'roost-list roost-scroll', style: { maxHeight: 520 } },
          h('div', {
            className: 'roost-item',
            style: { fontWeight: 600, position: 'sticky', top: 0, background: 'var(--surface, transparent)', fontSize: 11.5 },
          }, fields.map((f) => h('span', { key: f.key, style: { flex: '1 1 0', minWidth: 0 } }, f.label))),
          rows.map((r, i) => h('div', { key: i, className: 'roost-item' },
            fields.map((f) => h('span', {
              key: f.key,
              style: { flex: '1 1 0', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 },
            }, cell(f, r)))))),
        d.truncated ? h('div', { className: 'roost-note' }, '内容太多，只显示前一部分') : null)
    }

    function ExtApiTab({ toast }) {
      return h(ExtClientsBlock, { toast })
    }

    /**
     * 排障页（5.2）：日志筛选 + 自动刷新开关。
     *
     * 以前只能一屏 400 条全看，出问题时真正的 error 埋在几十条 info 里。
     * 级别与模块都在前端筛（日志最多 400 条，全量已在内存），不额外打接口。
     */
    function LogsTab({ logs, auto = true, onToggleAuto, onReload }) {
      const [lv, setLv] = useState('')
      const [area, setArea] = useState('')
      const tone = (x) => (x === 'error' ? 'var(--bad)' : x === 'warn' ? 'var(--warn)' : 'var(--ok)')
      const all = Array.isArray(logs) ? logs : []
      const areas = [...new Set(all.map((e) => e.area).filter(Boolean))].sort()
      const shown = all.filter((e) => (!lv || e.level === lv) && (!area || e.area === area))

      return h(Sec, {
        n: '01', title: '最近的动静',
        right: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('select', {
            className: 'roost-input', title: '按级别筛', style: { width: 'auto', padding: '2px 6px', fontSize: 11.5 },
            value: lv, onChange: (e) => setLv(e.target.value),
          },
            h('option', { value: '' }, '全部级别'),
            h('option', { value: 'debug' }, '调试'),
            h('option', { value: 'info' }, '信息'),
            h('option', { value: 'warn' }, '警告'),
            h('option', { value: 'error' }, '错误')),
          h('select', {
            className: 'roost-input', title: '按模块筛', style: { width: 'auto', padding: '2px 6px', fontSize: 11.5 },
            value: area, onChange: (e) => setArea(e.target.value),
          },
            h('option', { value: '' }, '全部模块'),
            areas.map((a) => h('option', { key: a, value: a }, a))),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 } },
            h('input', {
              type: 'checkbox', checked: auto !== false,
              onChange: (e) => onToggleAuto?.(Boolean(e.target.checked)),
            }), '自动刷新'),
          h('button', { type: 'button', className: 'roost-btn', onClick: () => onReload?.() }, '刷新')),
      },
        logs === null
          ? h('div', { className: 'roost-empty' }, '读着…')
          : shown.length === 0
            ? h('div', { className: 'roost-empty' }, all.length ? '当前筛选下没有日志' : '还没有日志')
            : h('div', { className: 'roost-list roost-scroll' },
                h('div', { className: 'roost-note', style: { margin: '0 0 6px' } },
                  `显示 ${shown.length} / ${all.length} 条` + (auto === false ? ' · 自动刷新已关' : ' · 每 3 秒刷新')),
                shown.slice().reverse().map((e, i) =>
                  h('div', { key: i, className: 'roost-item' },
                    h('span', { className: 'd' }, e.time),
                    h('span', { style: { flex: '0 0 4px', height: 4, borderRadius: 2, background: tone(e.level), marginTop: 7 } }),
                    h('span', { className: 't', style: { opacity: e.level === 'error' ? 1 : 0.86 } },
                      e.area ? h('span', { className: 'roost-muted', style: { fontSize: 10.5, marginRight: 6 } }, `[${e.area}]`) : null,
                      e.text),
                  ),
                ),
              ),
      )
    }

    /**
     * A1 审计查询：对齐 Hindsight `/audit-logs` 的「谁在什么时候动了什么」。
     * 和上面的应用日志分开——那份是排查流程，这份是追责台账（白名单字段）。
     * 只读、按需拉，默认不查（打开排障页不该顺手翻审计）。
     */
    function AuditPanel({ quick }) {
      const [op, setOp] = useState('')
      const [limit, setLimit] = useState(50)
      const [rows, setRows] = useState(null)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const load = async () => {
        setBusy(true)
        try {
          const r = await quick('audit.query', { op: op.trim(), limit: Number(limit) || 50 })
          setErr(r?.ok === false ? (r.message || '审计读取失败') : '')
          setRows(r?.ok === false ? [] : r)
        } catch (e) {
          setErr(e.message)
          setRows([])
        } finally {
          setBusy(false)
        }
      }
      /** 不参与编号（和记忆页的「记忆星图」同范式）：编号只给主流程，01 仍归「最近的动静」 */
      return h(Sec, { title: '操作审计', right: h('button', {
        type: 'button', className: 'roost-btn', disabled: busy, onClick: load,
      }, busy ? '查…' : '查询') },
        h('div', { className: 'roost-note', style: { marginBottom: 8 } },
          '只记面板写操作的时间、操作名、会话与身份摘要，**不记参数内容**。查自己不写日志（免自污染）。'),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
          h('input', {
            className: 'roost-input', placeholder: '操作名，如 memory.clear（留空=全部）',
            value: op, onChange: (e) => setOp(e.target.value), style: { flex: '1 1 200px' },
          }),
          h('select', {
            className: 'roost-input', value: limit, onChange: (e) => setLimit(Number(e.target.value)), style: { width: 'auto' },
          }, [20, 50, 100, 200].map((n) => h('option', { key: n, value: n }, `${n} 条`)))),
        err
          ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } }, err)
          : !rows
            ? h('div', { className: 'roost-empty' }, '点「查询」看最近的审计记录')
            : rows.rows?.length === 0
              ? h('div', { className: 'roost-empty' }, '还没有审计记录')
              : h('div', { className: 'roost-list roost-scroll' },
                  h('div', { className: 'roost-note', style: { margin: '0 0 6px' } },
                    `窗口内 ${rows.rows.length} / ${rows.total} 条` + (rows.truncated ? ' · 只扫了最近 256 KB，更早的看不到' : '')),
                  rows.rows.map((r, i) => h('div', { key: i, className: 'roost-item' },
                    h('span', { className: 'd' }, r.at ? new Date(r.at).toLocaleString() : ''),
                    h('span', { className: 't' },
                      h('span', { style: { fontWeight: 600 } }, r.op || '?'),
                      r.chatId ? h('span', { className: 'roost-muted' }, ` · ${r.chatId}`) : null,
                      r.peer ? h('span', { className: 'roost-muted' }, ` · ${r.peer}${r.peerId ? ':' + r.peerId : ''}`) : null,
                      r.note ? h('span', { className: 'roost-muted' }, ` · ${r.note}`) : null))))
      )
    }

    /* ---------------- 治理 ---------------- */

    /**
     * 治理：谁在用、引用有没有失效、体检 + 批量清理。
     *
     * 首屏**不扫描**（`health: null`），显示「未扫描」而不是四张 0——
     * 0 会被读成「没问题」，那比不显示更糟。
     */
    function GovPanel({ toast, reload, tick, onAfter }) {
      const [gov, setGov] = useState(null)
      const [busy, setBusy] = useState(false)
      const [picked, setPicked] = useState([])
      const [tagDraft, setTagDraft] = useState('')

      const load = useCallback(async (scan) => {
        const r = await get('/personas/gov' + (scan ? '?scan=1' : ''))
        if (r.ok === false) return toast(r.message || '读不到治理信息')
        setGov(r)
        /**
         * **重复项默认勾好**。
         *
         * 理由是这两类建议的性质不同：
         *   · 「内容重复」是**确定的冗余**，两份一模一样的卡，删一份不会有任何损失；
         *   · 「长期未用」要人判断（可能只是这阵子没聊），不能替他决定。
         *
         * 敢默认勾是因为删除**可撤销**（`/personas/batch/undo`，留最近 5 批），
         * 而且按钮上就写着「删除选中（N）」——数字变了用户看得见。
         */
        setPicked(((r.health && r.health.suggestions) || [])
          .filter((x) => x.why === '内容重复')
          .map((x) => x.id))
      }, [toast])

      useEffect(() => { load(false) }, [load, tick])

      const run = async (fn) => {
        setBusy(true)
        try {
          await fn()
        } finally {
          setBusy(false)
        }
      }

      const toggle = (id) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))

      if (!gov) return h('div', { className: 'roost-empty' }, '读着…')

      const health = gov.health
      const batches = gov.batches || []

      return h('div', { style: { marginTop: 8 } },
        h(Sec, { title: '正在用' },
          h('div', { className: 'roost-note', style: { marginTop: 4, color: gov.currentOk === false ? '#c0392b' : undefined } },
            `全局：${gov.currentLabel || gov.current}` + (gov.currentOk === false ? '（不存在，已回退 default）' : '')),
          (gov.refs || []).length
            ? h('div', { className: 'roost-list', style: { marginTop: 6 } },
                gov.refs.map((r) => h('div', { key: r.chatId, className: 'roost-item' },
                  h('span', { className: 't', style: { color: r.ok ? undefined : '#c0392b' } },
                    `${String(r.chatId).slice(0, 10)}… → ${r.ok ? r.label : `${r.id}（不存在，已回退 default）`}`),
                )))
            : h('div', { className: 'roost-note', style: { marginTop: 4 } }, '没有按会话指定的人格'),
        ),

        h(Sec, { title: '体检', right: h('button', {
          type: 'button', className: 'roost-btn', disabled: busy,
          onClick: () => run(async () => {
            await load(true)
            toast('扫完了')
          }),
        }, health ? '重新扫描' : '开始扫描') },
          !health
            ? h('div', { className: 'roost-empty' }, '未扫描——点右上角「开始扫描」')
            : h('div', null,
                h('div', { className: 'roost-note', style: { marginTop: 4 } },
                  `高危 ${health.risky.length} · 重复 ${health.dup.length} 组 · 长期未用 ${health.stale.length} · 超预算 ${health.big.length}`),
                (gov.invalid || []).length
                  ? h('div', { className: 'roost-note', style: { color: '#c0392b', marginTop: 4 } },
                      `引用失效 ${gov.invalid.length} 个会话（已静默回退 default）`)
                  : null,

                h('div', { style: { marginTop: 10, fontSize: 12, fontWeight: 650 } },
                  '清理建议',
                  (health.dup || []).length
                    ? h('span', { style: { fontWeight: 400, opacity: 0.6, marginLeft: 8 } },
                        '重复项已经帮你勾好了 —— 删掉的那份可以点下面的「撤销」找回')
                    : null),
                (health.suggestions || []).length
                  ? h('div', { className: 'roost-list' },
                      health.suggestions.map((s) => h('div', { key: s.id, className: 'roost-item' },
                        h('label', { className: 't', style: { display: 'flex', gap: 8, alignItems: 'center' } },
                          h('input', {
                            type: 'checkbox',
                            checked: picked.includes(s.id),
                            onChange: () => toggle(s.id),
                          }),
                          h('span', null, `${s.label} · ${s.why}`),
                        ),
                      )))
                  : h('div', { className: 'roost-note', style: { marginTop: 4 } }, '没有可清理的（默认、正在用、被指定的都已排除）'),

                h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' } },
                  h('input', {
                    className: 'roost-input', value: tagDraft, placeholder: '给选中的加标签（逗号分隔）',
                    'aria-label': '批量加标签', style: { maxWidth: 220 },
                    onChange: (e) => setTagDraft(e.target.value),
                  }),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: busy || !picked.length || !tagDraft.trim(),
                    onClick: () => run(async () => {
                      const add = tagDraft.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
                      const r = await post('/personas/batch/tag', { ids: picked, add })
                      if (r.ok === false) return toast(r.message || '没改成')
                      toast(`改了 ${r.changed.length} 份的标签`)
                      setTagDraft('')
                      await load(true)
                      reload?.()
                      // 合并成一张清单之后，删/改也会改变仓库那边的状态（deleted / modified），
                      // 不刷的话「已删 N」和行内标签要等下次进页才对得上
                      onAfter?.()
                    }),
                  }, '加标签'),
                  h('button', {
                    type: 'button', className: 'roost-btn danger', disabled: busy || !picked.length,
                    onClick: () => run(async () => {
                      const r = await post('/personas/batch/remove', { ids: picked })
                      if (r.ok === false) return toast(r.message || '没删成')
                      toast(`删了 ${r.removed.length} 份` + (r.batch ? '，可以撤销' : ''))
                      await load(true)
                      reload?.()
                      // 合并成一张清单之后，删/改也会改变仓库那边的状态（deleted / modified），
                      // 不刷的话「已删 N」和行内标签要等下次进页才对得上
                      onAfter?.()
                    }),
                  }, `删除选中（${picked.length}）`),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    disabled: busy || !batches.length,
                    /** 撤销窗口 = 最近 5 个批次（pruneBackups 按目录数留 5） */
                    title: '只保留最近 5 次备份',
                    onClick: () => run(async () => {
                      const r = await post('/personas/batch/undo', { batch: batches[0].ts })
                      if (r.ok === false) return toast(r.message || '没撤销成')
                      toast(`恢复了 ${r.restored.length} 份`)
                      await load(true)
                      reload?.()
                      // 合并成一张清单之后，删/改也会改变仓库那边的状态（deleted / modified），
                      // 不刷的话「已删 N」和行内标签要等下次进页才对得上
                      onAfter?.()
                    }),
                  }, batches.length ? `撤销上一批（${batches[0].count} 份）` : '没有可撤销的批次'),
                ),
              ),
        ),
      )
    }

    /* ---------------- 页面 ---------------- */

    /**
     * 页签顺序固定；「概览」永远第一个——它是首屏。
     *
     * `her` 这一页叫「人格」：本地人格 + 仓库（原「市场」）。
     * 表情包、语音条。以前页签名只有一个「她」字，用户得点进去才知道
     * 这页能改人格——名字写清楚比省两个字重要。key 仍是 `her`，
     * 不动它是因为 `localStorage` 里存着上次停留的页签，改 key 会让
     * 老用户回来时落空、退回概览。
     */
    /**
     * 2026-11-11 大重排：11 → 8 个可见页签。
     *
     *  「排障」（原 logs）里同时放 日志 / 上下文 / 会话清理 —— 机器人不回消息
     *    时不用再跨 5 个页签找；
     *  接入整页收进弹窗（概览「去接入」打开）；
     *  扩展独立成「扩展」页：档位 / 说明编辑 / 客户端令牌一处走完，
     *    不跟工具白名单挤在「能力」里，也不用跨三页。
     *
     * **2026-11-13 账号迁移提成正式页签**：原先它跟接入一样只在弹窗里，
     * 换机器人（换 AppID）是真实高频需求，藏在「设置 → 危险操作」底部等于没有入口。
     * 弹窗形态撤销，`tab key` 仍是 `account`（老 `localStorage['roost.tab']` 不受影响）。
     *
     * **隐藏页签仍可直接到达**：`context / setup` 保留为可直接进入的页，
     * 老 `localStorage['roost.tab']` 存着它们时照常渲染原页，功能与位置都不丢。
     * 2026-11-12：这一排不再直接铺 8 个按钮，改成「一级分组 + 二级页面」两层
     * （见下面的 `NAV_GROUPS`）。`TABS` 仍然是**唯一的页面清单**，两层只决定怎么分组、
     * 不决定有哪些页面——新增一页先加到这里，再决定归哪个组。
     */
    const TABS = [
      ['overview', '概览'],
      /**
       * 个性化（2026-11-19）：菜单顺序 / 显示隐藏 / 强调色 / 动效。
       *
       * 为什么不放「系统」组：系统组已经 11 页，是全站最重的一组；而这几项
       * 是「我每天看的界面怎么摆」，不是运维。放概览组还顺手补上「概览只有
       * 一页」那个唯一的单页组（二级行现在会出现，见 `groupTabs.length > 1`）。
       */
      ['personalize', '个性化'],
      /* 人设：她是谁、心情如何、什么时候开口、记得什么 */
      ['her', '人格'],
      /**
       * 资料：她的名字 / 简介 / 头像 / 菜单，以及「她能不能自己改」。
       *
       * 归在「人设」而不是「系统 → 自身设置」：用户对这几项的直觉是
       * 「她长什么样、叫什么」，跟人格放在一起才找得到；`bot-self` 那页是
       * 给开发者用的接口操作台，两件事别混。
       */
      ['profile', '资料'],
      ['mood', '心情'],
      ['awake', '主动搭话'],
      ['memory', '记忆'],
      /* 2.3：人物是记忆页那三块（档案/关系/经历）的并列入口，不是搬家 */
      ['people', '人物'],
      /* 能力：她能干什么 */
      ['caps', '权限'],
      ['express', '语音'],
      ['stickers', '图库'],
      ['model', '模型'],
      /* 功能包：依赖是「能力」的前置条件，不是扩展（一个包可能被多个功能用） */
      ['deps', '功能包'],
      /* 扩展：独立成组，和 aurabot 的「模块」对齐 */
      ['ext', '已安装'],
      ['ext-market', '市场'],
      ['ext-api', '接口'],
      /* 群聊：策略在前、动手管人在后 */
      ['groupchat', '群聊策略'],
      ['groupadmin', '群管'],
      /**
       * 频道：4 个二级页 —— 看状态 / 调策略 / 调接口 / 排障。
       *
       * 2026-11-15 收敛：原来「频道与子频道 / 消息与私信 / 内容与互动 / 成员与权限」
       * 是**同一个接口台的四个过滤器**（同一个组件、同一张卡，只有 group 不同），
       * 拆成四个页签等于「导航层级比内容还重」。现在并成一页「频道接口」，
       * 页内用分段切换；四个老 key 仍能深链打开对应段（见 LEGACY_CH_TABS）。
       */
      ['ch-home', '频道总览'],
      ['ch-policy', '频道策略'],
      /* 发帖是**新的一件事**（内容创作与发布），不是接口台的第五个过滤器，所以单开一页 */
      ['ch-post', '发帖'],
      ['ch-api', '频道接口'],
      ['ch-diag', '频道排障'],
      /* 系统：这台机器怎么跑。**书写顺序与 `NAV_GROUPS.system.tabs` 保持一致**——
         以前两处不一致，渲染被列表顺序盖掉（第三轮 A1）。现在渲染和 Alt+K 都
         改走 `NAV_GROUPS`，这里仍对齐是为了不让人被第二份顺序误导。 */
      /** A6：接入提成正式页签；setup 隐藏页、老深链、概览按钮一个不删 */
      ['connect', '接入'],
      /** 机器人身份能改的自身设置（菜单 / 指令面板）；开发者后台那套不在这条链上 */
      ['bot-self', '自身设置'],
      ['chats', '会话'],
      /** 账号迁移：原先是隐藏页 + 弹窗（低频整页）；换机器人是真实高频需求，提成正式页签 */
      ['account', '账号迁移'],
      /** 5.7 模拟测试：假身份发一句，看每层怎么处理（绝不真发） */
      ['sim', '模拟测试'],
      ['logs', '排障'],
      ['update', '更新'],
      ['config', '设置'],
      /* 2.3：备份从记忆页里长出一个正门，记忆页那块原地保留 */
      ['backup', '备份'],
      /** A6：安全防护同上，正式页签 */
      ['security', '安全防护'],
      ['about', '关于'],
    ]
    /**
     * `chats` 原来是隐藏页，2026-11-12 提升成「身份」：它本来就是
     * 「QQ 会话 ↔ DSH 会话」的映射表，不给入口只能从记忆页绕进去。
     */
    const HIDDEN_TABS = ['context', 'setup']
    /**
     * 频道接口台的四个老页签 key（2026-11-15 合并前各自是一页）。
     *
     * 只用来**接住老深链与老 localStorage**：打开时落到 `ch-api` 并选中对应段。
     * 它们不进导航、不进 Alt+K（`TABS` 里没有，`paletteTabs` 也就带不进来），
     * 否则页签又会变回四个。
     */
    const LEGACY_CH_TABS = {
      'ch-channels': 'channels',
      'ch-message': 'messages',
      'ch-content': 'content',
      'ch-member': 'member',
    }
    const ALL_TABS = TABS.map(([id]) => id).concat(HIDDEN_TABS)
    /** 深链校验用：老 key 也放行，否则老书签会被当成无效值、静默退回概览 */
    const KNOWN_TABS = ALL_TABS.concat(Object.keys(LEGACY_CH_TABS))

    /* ---------------- 个性化：菜单显隐 / 顺序 / 外观 ---------------- */

    /**
     * 不可隐藏的页（**恢复入口 + 唯一入口**）。
     *
     * 这份名单的每一条都有代价可算：
     *   · `overview` / `config` / `caps` —— 关了功能之后要能把开关找回来；
     *   · `ext-market` / `ext-api` —— 装扩展与控制面各只有这一个入口；
     *   · `express` —— 含「听语音（ASR）」全仓唯一入口，与 `tts.enabled` 无关
     *     （关语音藏整页会连带把 ASR 设置弄丢）；
     *   · `personalize` —— 它自己。藏了就再也进不来，连「全部显示」都点不到。
     */
    const PROTECTED_TABS = Object.freeze([
      'overview', 'config', 'caps', 'ext-market', 'ext-api', 'express', 'personalize',
    ])

    /**
     * 强调色预设：深/浅各一个值。
     *
     * 只给预设、不给任意 hex：这几个值都按 WCAG AA 算过（深色底 5.30–7.32，
     * 浅色底 5.01–6.04），用户自选很容易选出一个把下划线糊进背景的颜色。
     * 串里的 `id` 会存进偏好，改 id 等于让老用户的设置失效——只能加不能改。
     */
    const ACCENT_PRESETS = Object.freeze([
      { id: 'host', label: '跟随宿主', dark: '', light: '' },
      { id: 'blue', label: '蓝', dark: '#4c8dff', light: '#2563eb' },
      { id: 'teal', label: '青', dark: '#2bb8b8', light: '#0e7c7c' },
      { id: 'green', label: '绿', dark: '#3fb950', light: '#1a7f37' },
      { id: 'purple', label: '紫', dark: '#a371f7', light: '#7c3aed' },
      { id: 'orange', label: '橙', dark: '#d29922', light: '#b45309' },
      { id: 'magenta', label: '洋红', dark: '#e85a8a', light: '#be185d' },
    ])
    const accentOf = (id) => ACCENT_PRESETS.find((a) => a.id === id) || ACCENT_PRESETS[0]
    /** 页签中文名（查不到就退回 key，`TABS` 是唯一来源） */
    const tabLabel = (id) => (TABS.find(([x]) => x === id) || [])[1] || String(id)

    /** 个性化偏好的键。**只存这台浏览器**：纯显示层，不进 config（进 config 要同步
     *  `DEFAULTS` + `JSON_SECTIONS`，还会让 JSON 编辑器多一段给人手改坏）。 */
    const UI_PREF_KEY = 'roost.ui.v1'

    /**
     * 读偏好：**逐字段校验，坏字段丢字段**。
     *
     * 不整份拒绝的理由：用户手改 JSON 时最容易错一个逗号或一个引号，
     * 整份拒掉等于「我改个颜色，顺序和隐藏全没了」。
     */
    function readUiPref() {
      const empty = { hidden: [], order: {}, accent: 'host', anim: true }
      let raw = null
      try { raw = JSON.parse(localStorage.getItem(UI_PREF_KEY) || 'null') } catch { return empty }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
      const ids = new Set(ALL_TABS)
      const hidden = Array.isArray(raw.hidden)
        ? raw.hidden.filter((id) => typeof id === 'string' && ids.has(id) && !PROTECTED_TABS.includes(id))
        : []
      const order = {}
      if (raw.order && typeof raw.order === 'object' && !Array.isArray(raw.order)) {
        for (const [g, list] of Object.entries(raw.order)) {
          if (Array.isArray(list)) order[g] = list.filter((id) => typeof id === 'string' && ids.has(id))
        }
      }
      const accents = ['host', 'blue', 'teal', 'green', 'purple', 'orange', 'magenta']
      return {
        hidden,
        order,
        accent: accents.includes(raw.accent) ? raw.accent : 'host',
        anim: raw.anim !== false,
      }
    }

    function writeUiPref(p) {
      try { localStorage.setItem(UI_PREF_KEY, JSON.stringify(p)) } catch { /* 存不了就只活这一页 */ }
    }

    /**
     * 要隐藏哪些页。**返回"要藏的"集合**，名字按语义取（旧方案曾叫
     * `visibleTabIds` 却返回隐藏集，容易写反，这里改掉）。
     *
     * 两个来源，都 fail-open：
     *   · 自动型 —— 功能关了 / 一个扩展都没装（§11 白名单：只藏 `stickers`、`ext`）；
     *   · 用户型 —— 个性化页里手动关掉的（保护名单除外）。
     * `featOn === null`（还没读到 / 接口失败）一律不藏；扩展清单同理，必须
     * 「读成功且确实为空」才藏。
     */
    function hiddenTabIds(featOn, installedRows, installedReady, prefs) {
      const out = new Set()
      if (featOn && featOn.stickers === false) out.add('stickers')
      if (installedReady === true && Array.isArray(installedRows) && installedRows.length === 0) out.add('ext')
      for (const id of (prefs && prefs.hidden) || []) {
        if (!PROTECTED_TABS.includes(id)) out.add(id)
      }
      return out
    }

    /** 组内顺序：用户排过的在前（按排的次序），没排过的按声明顺序接后 */
    function orderTabs(g, ids, prefs) {
      const order = (prefs && prefs.order && prefs.order[g.id]) || []
      const pos = (id) => {
        const i = order.indexOf(id)
        return i < 0 ? Number.MAX_SAFE_INTEGER : i
      }
      return ids.slice().sort((a, b) => {
        const pa = pos(a), pb = pos(b)
        if (pa !== pb) return pa - pb
        return g.tabs.indexOf(a) - g.tabs.indexOf(b)
      })
    }


    /**
     * 两层导航：一级是分组（带图标），二级是组内页面。
     *
     * 为什么现在分：页签一多，窄侧栏里平铺一排就挤到换行，变成两排一样重的按钮、
     * 分不清主次。分组之后一级只有 7 个（2026-11-16 群聊并入「群与频道」前是 8 个），
     * 加页只影响组内。
     *
     * 分组参照 aurabot 的「概览 / 人设 / 表达 / 平台 / 系统」思路，按我们的页面裁剪：
     * 概览单独成组（只有一页，不渲染二级行），其余按「人设 / 表达 / 群与频道 / 能力 /
     * 扩展 / 系统」收。
     * **tab 的 key 一个都不改**，老 `localStorage['roost.tab']` 照样落回原来那页，
     * 隐藏页（context/setup）不进口分组，仍靠 `roost-nav-current` 标记位置。
     */
    /**
     * Alt+K 全局查找：每个页签的中文别名。
     *
     * 只按页名搜不够用——用户想找「日记」时会想搜「日记」，而不是先记住它
     * 在「记忆」页下面。别名表把常用叫法都收进来。
     */
    const TAB_ALIAS = {
      overview: '概览 首页 总览 现在 状态 卡在哪',
      personalize: '个性化 外观 主题 颜色 强调色 菜单 页签 顺序 隐藏 显示 布局 自定义 动画',
      her: '人格 人设 角色 名字 自称',
      profile: '资料 改资料 昵称 头像 简介 签名 菜单 换名字 换头像 自我表达 她能不能自己改',
      mood: '心情 情绪 状态 衰减',
      awake: '主动搭话 主动 唤醒 互动召回 机会',
      memory: '记忆 回忆 事实 日记 关系 星图 翻一翻 分层 遗忘 容量',
      people: '人物 熟人 档案 印象 人物墙',
      caps: '权限 能力 授权 工具 限额',
      express: '语音 表达 声音 tts 念出来 试听 预览',
      stickers: '图库 表情包 表情 贴纸 图片 素材池 回收站',
      model: '模型 价格 用量 金额 花费',
      ext: '扩展 已安装 插件',
      'ext-market': '市场 扩展市场 插件市场 安装',
      'ext-api': '接口 api 扩展接口 协议',
      groupchat: '群聊 群聊策略 接话 连发 安全刹车',
      groupadmin: '群管 禁言 审批 群信息 入群',
      'ch-home': '频道 频道总览 总开关 订阅 intents 额度 会话 审核',
      'ch-policy': '频道策略 会话粒度 子频道 接话 覆写 富媒体',
      /* 四个老页签并进来之后，原来各自的词都收在这一条里，搜哪个都还能到 */
      'ch-api': '频道接口 子频道 频道结构 创建 改名 删除 权限 频道消息 私信 撤回 表态 精华 dms 论坛 帖子 公告 日程 音频 上麦 频道成员 身份组 角色 在线人数 api权限',
      'ch-diag': '频道排障 事件 账本 投递 错误码',
      'ch-post': '发帖 频道发帖 记 日记 版块 论坛 帖子 自动写 排期 putThread',
      'bot-self': '自身设置 机器人身份 菜单 指令面板 全局菜单 panels 接口台',
      chats: '会话 身份 映射 上下文',
      account: '账号迁移 迁移 换号 绑定 旧 openid',
      sim: '模拟 模拟测试 试跑 演练 dry run 会不会回 为什么没回',
      logs: '日志 排障 报错 排查',
      update: '更新 版本 升级 changelog',
      config: '配置 设置 json 高级',
      backup: '备份 恢复 导出 迁移',
      about: '关于 版本 许可 鸣谢',
      connect: '接入 安装 直连 凭证 二维码 组件版本 首次设置',
      security: '安全 防护 危险命令 确认 ssrf 白名单 内网 出站',
      context: '上下文 提示词',
      /** 隐藏页只在深链/老 localStorage 里出现，别名别和正式「接入」页撞词 */
      setup: '向导 老链接 自测',
    }

    /**
     * 搜页签：页名 / 别名 / **所属组名** 命中都算；空查询给全部（按传入顺序）。
     *
     * 组名也算命中：用户记不住「群管」在哪一组，但记得「群与频道」——
     * 搜组名就把该组页面全列出来，比让他一个个组去点快。
     *
     * 组标签走 `navGroupOf` 而不是自己 `find`：扩展页（`ext:<id>`）不在任何
     * `NAV_GROUPS[x].tabs` 里，得问它自己声明的 `nav.group`，否则搜索结果显示
     * 一个空组名（第三轮 A8）。`groups` 参数留着只为兼容既有调用与测试。
     */
    function matchTabs(q, tabs, groups, extPages = null) {
      const kw = String(q || '').trim().toLowerCase()
      const out = []
      for (const [id, label] of tabs) {
        const alias = TAB_ALIAS[id] || ''
        const g = navGroupOf(id, extPages) || (groups || []).find((x) => x.tabs.includes(id)) || null
        const hit = !kw || label.toLowerCase().includes(kw) || alias.toLowerCase().includes(kw)
          || (g ? String(g.label).toLowerCase().includes(kw) : false)
        if (!hit) continue
        out.push({ id, label, group: g ? g.label : '' })
      }
      return out
    }

    const NAV_GROUPS = [
      { id: 'home', label: '概览', icon: 'M3 10.5 12 3l9 7.5M5.5 9v11.5h13V9M10 20.5v-6h4v6', tabs: ['overview', 'personalize'] },
      { id: 'self', label: '人设', icon: 'M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5zM4.5 20.5c.9-3.6 3.9-5.5 7.5-5.5s6.6 1.9 7.5 5.5', tabs: ['her', 'profile', 'mood', 'awake', 'memory', 'people'] },
      /**
       * 表达：她怎么"出声"——说话（语音合成）、表情包、发帖。
       *
       * 发帖（`ch-post`）2026-11-17 从「群与频道」搬来这里：它是**她的表达出口**
       * （代替 QQ 空间那样，在版块里写点留着的东西），不是频道运维。
       * 技术上它要发到论坛子频道，但那是"发到哪儿"，不是"这件事属于频道管理"——
       * 把它和频道策略、订阅位、接口台放一起，用户会以为得先搞懂频道才能用。
       */
      { id: 'express', label: '表达', icon: 'M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.4A8 8 0 1 1 20.5 11.5zM9 13.2s1.1 1.5 3 1.5 3-1.5 3-1.5M9.5 9.6h.01M14.5 9.6h.01', tabs: ['express', 'stickers', 'ch-post'] },
      /**
       * 群与频道（2026-11-16 合组，一级 8 → 7）：它们回答同一个问题——
       * 「在这个渠道里怎么说话」。
       *
       * 配置层本来就是共用的：频道策略页里写着「接话 / 连发 / 刹车与群聊
       * **共用**全局 `roostHost.decide` / `merge`」，导航却劈成两个一级位，
       * 点进去各只有 2 / 4 个页签。组内先群聊（多数人只有群）后频道
       * （官方 Bot API 的可选平台）。
       *
       * **老 id `group` 不删**：已发布扩展的 `plugin.json` 里
       * `ui.nav.group: 'group'` 还写着它，见下面 `GROUP_ALIAS`。
       */
      { id: 'channel', label: '群与频道', icon: 'M4 6.5h16M4 12h10M4 17.5h7M17.5 15.5l3 2-3 2',
        tabs: ['groupchat', 'groupadmin', 'ch-home', 'ch-policy', 'ch-api', 'ch-diag'] },
      { id: 'power', label: '能力', icon: 'M12 3.2 4.8 6v5.6c0 4.4 3 7.7 7.2 9.2 4.2-1.5 7.2-4.8 7.2-9.2V6L12 3.2zM8.8 12l2.2 2.2 4.2-4.4', tabs: ['caps', 'model', 'deps'] },
      { id: 'mods', label: '扩展', icon: 'M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12.5V20h13v-7.5M10 20v-4.5h4V20', tabs: ['ext', 'ext-market', 'ext-api'] },
      { id: 'system', label: '系统', icon: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4', tabs: ['connect', 'bot-self', 'chats', 'account', 'sim', 'logs', 'update', 'config', 'backup', 'security', 'about'] },
    ]
    /**
     * 合并前的一级组 id（2026-11-16 群聊并入「群与频道」）。
     *
     * 三处还在用旧 id，删掉这张表会**静默**失效、不是报错：
     *  · 已发布扩展的 `plugin.json` 里 `ui.nav.group: 'group'` → 挂不上组，
     *    页面从导航里消失（`navGroupOf` 找不到组会返回 null）；
     *  · 老 `localStorage['roost.navlast']` 里 `{ group: 'groupadmin' }`；
     *  · 老深链/书签（tab key 没变，只影响组名显示）。
     */
    const GROUP_ALIAS = { group: 'channel' }
    /** 老组 id → 现组 id。只认一层，别写成递归 */
    const groupIdOf = (id) => GROUP_ALIAS[String(id ?? '')] || String(id ?? '')
    /**
     * A1：系统组页最多，混了「接入与身份 / 诊断 / 运维 / 关于」四类。
     * 不拆组、不删页、不改 key，只在二级页签上给段首留一道分隔与悬浮说明。
     */
    const SYSTEM_SEG = { sim: '诊断', update: '运维', security: '安全', about: '关于' }
    /**
     * 当前页属于哪一组；隐藏页不属于任何组，返回 null。
     *
     * `extPages` 是扩展声明的页面（6.1）。它们的 tab key 是 `ext:<id>`，
     * 不属于静态 `TABS`，所以要看扩展自己声明的 `nav.group`——
     * **扩展可以自己挑挂哪个一级菜单**，不强制都塞在「扩展」里。
     */
    const navGroupOf = (id, extPages = null) => {
      const key = String(id ?? '')
      if (key.startsWith('ext:')) {
        const pid = key.slice(4)
        const page = (extPages || []).find((x) => x.id === pid)
        if (!page) return null
        /** 扩展声明的组 id 可能是合并前的（`group`），归一后再找 */
        return NAV_GROUPS.find((g) => g.id === groupIdOf(page.nav.group)) || null
      }
      return NAV_GROUPS.find((g) => g.tabs.includes(id)) || null
    }
    const navIcon = (d) => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d }))

    /**
     * 渲染错误边界：**把黑屏变成一句话**。
     *
     * 为什么需要：面板一旦在渲染期抛异常，React 会把整棵子树卸载，
     * 用户看到的就是"点 Roost 一片黑"，既没有报错也没有线索。
     * 2026-11-05 02:41 就撞上过一次，只能靠猜。
     *
     * 用 class 是因为这是 React 唯一还认的错误边界写法（`componentDidCatch`）。
     * 测试用的假 React 没有 `Component`，那里降级成直通——断言渲染结果不受影响。
     */
    const RenderBoundary = React.Component
      ? class RenderBoundary extends React.Component {
          constructor(props) {
            super(props)
            this.state = { err: null }
          }

          static getDerivedStateFromError(err) {
            return { err }
          }

          componentDidCatch(err, info) {
            // 控制台也留一份，方便用户复制给开发者
            try { console.error('[roost] 面板渲染失败', err, info); } catch {}
          }

          render() {
            const e = this.state.err
            if (!e) return this.props.children
            return h('div', { style: { padding: 24, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 12, lineHeight: 1.7 } },
              h('div', { style: { fontSize: 14, fontWeight: 650, marginBottom: 10 } }, 'Roost 面板渲染出错'),
              h('div', { style: { opacity: 0.85, marginBottom: 10 } }, String(e && e.message ? e.message : e)),
              h('div', { style: { opacity: 0.55, marginBottom: 14 } },
                '这段报错可以直接截图发给开发者；改完代码后重载 DSH 即可，不需要重装。'),
              h('button', {
                type: 'button',
                onClick: () => this.setState({ err: null }),
                style: { padding: '4px 10px', cursor: 'pointer' },
              }, '重试渲染'),
              h('pre', {
                style: { marginTop: 14, whiteSpace: 'pre-wrap', opacity: 0.6, fontSize: 11 },
              }, String(e && e.stack ? e.stack : '')),
            )
          }
        }
      /**
       * 假 React（渲染测试）里没有 Component：降级成直通。
       * 返回**单个**孩子而不是 children 数组——假 React 的 createElement
       * 把 children 收成数组，直接返回会让展开后的树多套一层数组，
       * 「页头 / 滚动区是 RoostPage 直接孩子」这类结构断言就找不到了。
       */
      : ({ children }) => (Array.isArray(children) ? children[0] : children) ?? null

    /**
     * 个性化：菜单顺序与显示 / 强调色 / 动效 / 导出导入。
     *
     * 两条边界写死在页面里（不是藏在代码注释里，用户看不到就等于没有）：
     *   · **隐藏 ≠ 关功能**：只从导航拿掉入口，功能照常跑，要真关去「权限」页；
     *   · 偏好**只存在这台浏览器**，换机器要自己把下面那段 JSON 搬过去。
     *
     * 所有状态都在 `RoostPage`（`uiPref` / `setPrefs`），本组件只负责画和改——
     * 放自己 state 里会出现「本页变了、导航和颜色没变」。
     */
    function PersonalizeTab({ uiPref, setPrefs, toast }) {
      const [editGroup, setEditGroup] = useState('self')
      const [draft, setDraft] = useState(null)
      const g = NAV_GROUPS.find((x) => x.id === editGroup) || NAV_GROUPS[1]
      const hidden = new Set(uiPref.hidden || [])

      /** 每次改动都清掉 04 的草稿：否则先编辑过 textarea、再动 01/02/03，
       *  下面那段 JSON 会停在改之前的样子，用户以为没生效 */
      const patch = (next) => { setDraft(null); setPrefs((prev) => ({ ...prev, ...next })) }

      /** 上下移：以「当前可见顺序」为基准重写这一组的 order，隐藏页接在后面 */
      const move = (id, dir) => {
        setDraft(null)
        setPrefs((prev) => {
          const h = new Set(prev.hidden || [])
          const vis = orderTabs(g, g.tabs.filter((x) => !h.has(x)), prev)
          const i = vis.indexOf(id)
          const j = i + dir
          if (i < 0 || j < 0 || j >= vis.length) return prev
          const next = vis.slice()
          next.splice(i, 1)
          next.splice(j, 0, id)
          const rest = g.tabs.filter((x) => !next.includes(x))
          return { ...prev, order: { ...(prev.order || {}), [g.id]: next.concat(rest) } }
        })
      }

      const toggleHidden = (id) => {
        if (PROTECTED_TABS.includes(id)) {
          toast(`「${tabLabel(id)}」是恢复入口，不能隐藏`)
          return
        }
        const wasHidden = hidden.has(id)
        setDraft(null)
        setPrefs((prev) => {
          const cur = prev.hidden || []
          return { ...prev, hidden: wasHidden ? cur.filter((x) => x !== id) : [...cur, id] }
        })
        /** 当前页不跳走（与深链口径一致），只说去哪找 */
        toast(wasHidden
          ? `「${tabLabel(id)}」回到导航`
          : `「${tabLabel(id)}」已从导航隐藏，Alt+K 还能找到`)
      }

      const resetAll = () => {
        setDraft(null)
        setPrefs({ hidden: [], order: {}, accent: 'host', anim: true })
        toast('已恢复默认（只重置这一页的四项）')
      }

      /** 导入：**逐字段校验，坏字段丢字段**，不整份拒绝 */
      const importJson = () => {
        let raw = null
        const text = draft === null ? JSON.stringify(uiPref) : draft
        try { raw = JSON.parse(text) } catch (e) { toast('这段不是合法 JSON：' + e.message); return }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { toast('要一段对象 JSON'); return }
        const ids = new Set(ALL_TABS)
        const next = {
          hidden: Array.isArray(raw.hidden)
            ? raw.hidden.filter((x) => typeof x === 'string' && ids.has(x) && !PROTECTED_TABS.includes(x))
            : [],
          order: {},
          accent: ACCENT_PRESETS.some((a) => a.id === raw.accent) ? raw.accent : 'host',
          anim: raw.anim !== false,
        }
        if (raw.order && typeof raw.order === 'object' && !Array.isArray(raw.order)) {
          for (const [k, list] of Object.entries(raw.order)) {
            if (Array.isArray(list)) next.order[k] = list.filter((x) => typeof x === 'string' && ids.has(x))
          }
        }
        setPrefs(next)
        setDraft(null)
        toast('已导入（坏字段会被丢掉，不会整份失败）')
      }

      /* 组内列表：先按用户顺序排，再渲染每一行 */
      const ids = orderTabs(g, g.tabs, uiPref)
      const visibleIds = orderTabs(g, g.tabs.filter((x) => !hidden.has(x)), uiPref)

      return h('div', null,
        /* 01 菜单顺序与显示 */
        h(Sec, { n: '01', title: '菜单顺序与显示' },
          h('div', { className: 'roost-note' },
            '隐藏只是从这里拿掉入口，功能照常运行；要真关某个功能，去「权限」页改开关。'
            + '顺序只影响组内，一级分组不跟着变。扩展页不在这里排，也不在这里藏。'),
          h('div', { className: 'roost-pf-grp' },
            NAV_GROUPS.map((x) => h('button', {
              key: x.id, type: 'button',
              'data-on': x.id === g.id ? '1' : '0',
              'aria-pressed': x.id === g.id ? 'true' : 'false',
              onClick: () => setEditGroup(x.id),
            }, x.label))),
          ids.map((id) => {
            const prot = PROTECTED_TABS.includes(id)
            const vi = visibleIds.indexOf(id)
            return h(GRow, {
              key: id,
              label: tabLabel(id) + (prot ? '（固定）' : ''),
              hint: id === 'personalize'
                ? '本页自己：藏了就再也进不来，所以锁着'
                : (id === 'express' ? '含「听语音」唯一入口，关语音也不藏' : ''),
            },
              h('span', { className: 'roost-pf-order' },
                h('button', {
                  type: 'button', title: '上移', 'aria-label': `把${tabLabel(id)}上移`,
                  disabled: vi <= 0, onClick: () => move(id, -1),
                }, '↑'),
                h('button', {
                  type: 'button', title: '下移', 'aria-label': `把${tabLabel(id)}下移`,
                  disabled: vi < 0 || vi >= visibleIds.length - 1, onClick: () => move(id, 1),
                }, '↓')),
              h(Switch, {
                on: !hidden.has(id), label: `${tabLabel(id)}显示`, disabled: prot,
                title: prot ? '受保护，不能隐藏' : (hidden.has(id) ? '已隐藏' : '显示中'),
                onToggle: () => toggleHidden(id),
              }),
            )
          }),
        ),

        /* 02 强调色 */
        h(Sec, { n: '02', title: '强调色' },
          h('div', { className: 'roost-note' },
            '只换面板自己的强调色（选中下划线、药丸底、焦点环），不改宿主的背景与文字。'
            + '这几个值都算过对比度；「跟随宿主」会跟 DSH 的深浅主题自己变。'),
          h('div', { className: 'roost-swatches' },
            ACCENT_PRESETS.map((a) => h('button', {
              key: a.id, type: 'button',
              className: 'roost-swatch' + (a.id === 'host' ? ' host' : ''),
              'data-on': uiPref.accent === a.id ? '1' : '0',
              'aria-pressed': uiPref.accent === a.id ? 'true' : 'false',
              title: a.label, 'aria-label': a.label,
              onClick: () => patch({ accent: a.id }),
            }, h('span', { style: a.dark ? { background: a.dark } : null })))),
          h('div', { className: 'roost-note' },
            '当前：' + accentOf(uiPref.accent).label
            + (uiPref.accent === 'host' ? '（跟随 DSH 主题）' : `（${accentOf(uiPref.accent).dark}）`)),
        ),

        /* 03 动效 */
        h(Sec, { n: '03', title: '动效' },
          h(GRow, {
            label: '界面动画',
            hint: '分节入场、切页淡入、指示呼吸圈、按钮回弹；关掉之后全部静止',
          },
            h(Switch, {
              on: uiPref.anim !== false, label: '界面动画',
              onToggle: (v) => patch({ anim: v }),
            })),
        ),

        /* 04 导出与导入 */
        h(Sec, { n: '04', title: '导出与导入' },
          h('div', { className: 'roost-note' },
            '偏好只存在这台浏览器。换电脑时把下面这段复制走，粘回来点「导入」。'),
          h('textarea', {
            className: 'roost-g-area',
            style: { minHeight: 96, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 11.5 },
            value: draft === null ? JSON.stringify(uiPref, null, 2) : draft,
            onChange: (e) => setDraft(e.target.value),
            spellCheck: false, 'aria-label': '偏好 JSON',
          }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
            h('button', { type: 'button', className: 'roost-btn', onClick: resetAll }, '恢复默认'),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => {
                const text = JSON.stringify(uiPref, null, 2)
                setDraft(null)
                /** `typeof` 而不是 `navigator?.`：无 navigator 的环境里后者会抛 */
                try {
                  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(text)
                    toast('已复制到剪贴板')
                  } else toast('浏览器不让写剪贴板，请手动选中上面那段')
                } catch { toast('复制失败，请手动选中上面那段') }
              },
            }, '复制'),
            h('button', { type: 'button', className: 'roost-primary', onClick: importJson }, '导入'),
          ),
        ),
      )
    }

    function RoostPage() {
      useStyle()
      /**
       * 页头开关的生效态（`features.get` 的 `on`，算过依赖）。
       *
       * **声明必须在这里、早于 `hiddenIds`**：导航显隐要读它，
       * 放在下面（页头那两个开关旁边）会撞 TDZ —— 渲染直接抛
       * 「Cannot access 'featOn' before initialization」。
       */
      const [featOn, setFeatOn] = useState(null)
      /**
       * 个性化偏好：顺序 / 隐藏 / 强调色 / 动效。
       *
       * **必须放在这一层**：强调色与 `no-anim` 都注入 `.roost-root`，
       * 导航过滤也在这里算。放子组件里会出现「本页 UI 变了、导航和颜色没变」
       * ——这类设置页最常见的假成功。
       */
      const [uiPref, setUiPref] = useState(readUiPref)
      /**
       * 必须支持函数式更新：快速连点 ↑↓ 时两次 `setPrefs` 会落在同一批里，
       * 用 `{...uiPref, ...}` 的快照写法会让第二次覆盖第一次（改动静默丢失）。
       */
      const setPrefs = useCallback((next) => {
        setUiPref((prev) => (typeof next === 'function' ? next(prev) : next))
      }, [])
      /** 持久化放 effect：`setUiPref` 里做副作用在 StrictMode 下会被执行两次 */
      useEffect(() => { writeUiPref(uiPref) }, [uiPref])
      /** 已装扩展清单：`null` = 还没读到；`ready` 区分「读到空」与「没读到」 */
      const [installedRows, setInstalledRows] = useState(null)
      const [installedReady, setInstalledReady] = useState(false)
      /**
       * 记住上次停在哪一页。
       *
       * 习惯上仪表盘会记位置：关掉再打开还回到刚才那页，
       * 而不是每次都弹回概览让人重新点。localStorage 不可用时静默退回概览。
       */
      const [tab, setTabState] = useState(() => {
        try {
          /**
           * 深链：`?tab=memory` 直达。界面上两句说明早就写着「老链接
           * ?tab=context 仍能单独打开」，但代码从来没有解析 location.search
           * —— 文案在撒谎。现在真的解析，且**优先于 localStorage**：
           * 点了一个深链，期望是去那一页，而不是回到上次停留。
           */
          const want = typeof location !== 'undefined'
            ? String(new URLSearchParams(location.search || '').get('tab') || '').trim()
            : ''
          if (want && KNOWN_TABS.includes(want)) return want
          const last = localStorage.getItem('roost.tab')
          /** 老用户存着 'market'：并进「人格」了，别让他打开就是概览 */
          const alias = last === 'market' ? 'her' : last
          return KNOWN_TABS.includes(alias) ? alias : 'overview'
        } catch {
          return 'overview'
        }
      })
      /** 接入是整页弹窗：不占页签，也不写「上次停留」 */
      const [pageModal, setPageModal] = useState(null)
      /** Alt+K 全局查找（5.1） */
      const [palette, setPalette] = useState({ open: false, q: '', idx: 0 })
      const setTab = useCallback((id) => {
        if (id === 'setup') { setPageModal(id); return }
        /** 老频道 key 一律归一到 ch-api：state 与 localStorage 只存正式页签 */
        const next = LEGACY_CH_TABS[id] ? 'ch-api' : id
        setPageModal(null)
        setTabState(next)
        try { localStorage.setItem('roost.tab', next) } catch {}
      }, [])
      /**
       * Alt+K 打开全局查找；Esc 关；↑↓ 选择；回车跳转。
       * 只在面板里监听（卸载即移除），不污染宿主页面。
       */
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
        const onKey = (e) => {
          if (e.altKey && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault()
            setPalette((p) => ({ open: !p.open, q: '', idx: 0 }))
            return
          }
          if (!palette.open) return
          if (e.key === 'Escape') { e.preventDefault(); setPalette({ open: false, q: '', idx: 0 }); return }
          const list = matchTabs(palette.q, paletteTabs(), NAV_GROUPS, extPages)
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setPalette((p) => ({ ...p, idx: Math.min(p.idx + 1, Math.max(0, list.length - 1)) }))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setPalette((p) => ({ ...p, idx: Math.max(0, p.idx - 1) }))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            const pick = list[palette.idx]
            if (pick) { setTab(pick.id); setPalette({ open: false, q: '', idx: 0 }) }
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [palette.open, palette.q, palette.idx, setTab])

      /**
       * 每组记住最后看的那页：点一级分组回到那页，而不是每次都跳组内第一页。
       *
       * 单独存一份、不塞进 `roost.tab`：全局的「上次停留」只有一个，
       * 再拆一层才记得住「上次在能力组看的是扩展」。
       */
      /**
       * 扩展声明的页面（6.1）。**面板不执行扩展的任何代码**——这里只拿到
       * 页名、分组、字段白名单，数据另外单独拉 `/extensions/ui/data`。
       */
      const [extPages, setExtPages] = useState([])
      useEffect(() => {
        let alive = true
        ;(async () => {
          const r = await get('/extensions/ui')
          if (alive && Array.isArray(r?.pages)) setExtPages(r.pages)
        })()
        return () => { alive = false }
      }, [])
      /** 静态页 + 扩展页。只用于渲染导航，不改 `TABS` 本身 */
      /**
       * 要藏起来的页（自动 + 用户手动），导航 / Alt+K / 一级组全读这一份。
       *
       * 只算一次、下面七处消费——分散判的话必然出现「导航没了但搜索还能跳进去」
       * 或「点一级分组落空」。
       */
      const hiddenIds = hiddenTabIds(featOn, installedRows, installedReady, uiPref)

      /** 静态页 + 扩展页，**已扣掉隐藏页**。只用于渲染导航，不改 `TABS` 本身 */
      const dynamicTabs = (extPages.length
        ? TABS.concat(extPages.map((p) => [`ext:${p.id}`, p.nav.label]))
        : TABS).filter(([id]) => !hiddenIds.has(id))

      /**
       * 某个一级分组里的页面，**按 `NAV_GROUPS[x].tabs` 声明的顺序**排，
       * 再叠加用户自定义的顺序（个性化页里 ↑↓ 排过的）。
       *
       * 为什么不能直接用 `dynamicTabs` 过滤：`TABS` 是「有哪些页」的清单，
       * 它的书写顺序只服务于 Alt+K 全站遍历；组内的主次是 `NAV_GROUPS`
       * 说了算。之前拿 `TABS` 顺序当组内顺序，等于让清单覆盖了声明——
       * `NAV_GROUPS.system` 把 `connect` 排在首位，实际渲染成倒数第二，
       * `SYSTEM_SEG` 的分段标记跟着错位（第三轮 A1）。
       *
       * 扩展页（`ext:*`）不在静态声明里，按 `extPages` 顺序接在组内末尾，
       * 且**不参与用户排序**（它们的 id 不稳定，排了也是白排）。
       */
      const tabsOfGroup = (g) => {
        if (!g) return []
        const declaredIds = g.tabs.filter((id) => dynamicTabs.some(([tid]) => tid === id))
        const ordered = orderTabs(g, declaredIds, uiPref)
          .map((id) => dynamicTabs.find(([tid]) => tid === id))
          .filter(Boolean)
        const ext = dynamicTabs.filter(([id]) =>
          id.startsWith('ext:') && (navGroupOf(id, extPages)?.id || '') === g.id)
        return ordered.concat(ext)
      }

      /**
       * Alt+K 的候选清单：**按一级分组的顺序展开**，组内顺序等同导航里看到的顺序。
       *
       * 以前这里是 `ALL_TABS`（= `TABS` 的书写顺序），于是「接入」「安全防护」
       * 在搜索结果里排到最后，和导航里第一位对不上——第三轮 A1 只修了渲染，
       * 没修这一处。扩展页（`ext:<id>`）以前根本不在候选里，现在跟着组一起进来；
       * 隐藏页接在末尾，给它们一个人话页名（以前直接显示 key）。
       *
       * **被藏掉的页也要列出来**（§11 红线：导航隐藏但 Alt+K 仍可达），
       * 带「（已隐藏）」后缀——不然用户会以为设置把功能弄丢了。
       */
      const paletteTabs = () => {
        const ordered = NAV_GROUPS.flatMap((g) => tabsOfGroup(g))
        const seen = new Set(ordered.map(([id]) => id))
        const ext = dynamicTabs.filter(([id]) => !seen.has(id))
        const hidden = HIDDEN_TABS.filter((id) => !seen.has(id))
          .map((id) => [id, ({ context: '上下文', setup: '接入向导' })[id] || id])
        const off = TABS
          .filter(([id]) => hiddenIds.has(id) && !seen.has(id))
          .map(([id, label]) => [id, label + '（已隐藏）'])
        return ordered.concat(ext, hidden, off)
      }

      const [navLast, setNavLast] = useState(() => {
        try {
          const raw = JSON.parse(localStorage.getItem('roost.navlast') || '{}') || {}
          /**
           * 合组迁移：老 `group`（群聊）的落点继承给 `channel`，否则「上次停在群管」
           * 的人点一级组会掉回组内第一页（群聊策略），看着像设置丢了。
           * 已有 `channel` 就听新的，别覆盖。
           */
          if (raw.group && !raw.channel) raw.channel = raw.group
          return raw
        } catch { return {} }
      })
      useEffect(() => {
        const g = navGroupOf(tab, extPages)
        if (!g || navLast[g.id] === tab) return
        const next = { ...navLast, [g.id]: tab }
        setNavLast(next)
        try { localStorage.setItem('roost.navlast', JSON.stringify(next)) } catch {}
      }, [tab, navLast])
      /** 点分组：优先回该组上次那页；存着已下线的 key 时退回组内第一页 */
      const openGroup = useCallback((g) => {
        /**
         * 组内页面要算上扩展页：点「表达」时如果只有一个内置页 + 一个扩展页，也得能落到扩展页。
         * 顺序走 `tabsOfGroup`（= 分组声明顺序 + 用户自定义），这样「点一级分组」的
         * 默认落点和二级行第一个页签永远是同一页，不会指东落西。
         */
        const list = tabsOfGroup(g).map(([id]) => id)
        /**
         * 「概览」组恒回首屏。它现在有两页（概览 / 个性化），若沿用「上次那页」，
         * 用户从个性化出来再点一级「概览」就不回首屏了——与"概览是首屏"的定位冲突。
         */
        if (g.id === 'home' && list.includes('overview')) { setTab('overview'); return }
        const want = navLast[g.id]
        setTab(list.includes(want) ? want : (list[0] || ''))
      }, [navLast, setTab, extPages, dynamicTabs, tabsOfGroup, uiPref])
      /** 日志统一拉一次：概览显示最近 6 条，排障页显示全量，别两处各起一个轮询 */
      const [logs, setLogs] = useState(null)
      /** 5.2：自动刷新开关（存 localStorage，刷新页面也记得） */
      const [logAuto, setLogAuto] = useState(() => {
        try { return localStorage.getItem('roost.logs.auto') !== '0' } catch { return true }
      })
      useEffect(() => {
        /** 只在概览/排障常驻轮询：client-effects 测试会真的执行 effect，
            在别的页挂 setInterval 会让进程退不出去。切页时下面这行 load()
            本来就会立即拉一次，所以停在别的页也不会看到旧数据。 */
        if (tab !== 'overview' && tab !== 'logs') return
        let alive = true
        const load = async () => {
          const r = await get('/logs')
          if (alive) setLogs(r.ok === false ? [] : r.entries || [])
        }
        load()
        /** 关掉自动刷新只是不再轮询；进页仍会拉一次，手动「刷新」也还在 */
        if (!logAuto) return () => { alive = false }
        const t = setInterval(load, 3000)
        return () => { alive = false; clearInterval(t) }
      }, [tab, logAuto])

      const [st, setSt] = useState(null)
      const [setupSt, setSetupSt] = useState(null)
      const [config, setConfig] = useState(null)
      /** 配置版本（mtime）：整份保存时带回去，别处改过就 409 而不是覆盖 */
      const [configRev, setConfigRev] = useState('')
      const [mem, setMem] = useState(null)
      /** 记忆页选中的会话；空串 = 跟随「最近说话的那个」 */
      const [memPick, setMemPick] = useState('')
      /**
       * 最新选中的会话。
       *
       * `loadMemory` 的依赖清空了（否则切会话时它的身份一变，加载 effect 又跑一次），
       * 但默认参数 `pick = memPick` 会**闭包住首帧的空串**——选中某个群再刷新，
       * 就会悄悄退回「最近说话的那个」。用 ref 取最新值。
       */
      const memPickRef = useRef(memPick)
      useEffect(() => {
        memPickRef.current = memPick
      }, [memPick])
      /**
       * 「人格」页一次要三份数据，合成**一个** state（情绪、表情包也在里面，别的页要用）。
       *
       * 原来三个独立 setState：接口回来时如果 React 没批处理，就是三次渲染、
       * 三次整页重排。这一页是唯一这样的页面（其余页最多两份，且多数是分开用），
       * 所以「切到这一页」更容易看到没画完的白块。
       */
      const [her, setHer] = useState(null)
      /** 市场：仓库清单 + 每个条目在本地的状态（`/personas/repo` 原样存） */
      const [aw, setAw] = useState(null)
      const [sp, setSp] = useState(null)
      const [ctxInfo, setCtxInfo] = useState(null)
      const [usageInfo, setUsageInfo] = useState(null)
      const [mind, setMind] = useState(null)
      const [chats, setChats] = useState(null)
      /** 能力页：策略 + 本次观察到的变化 */
      const [caps, setCaps] = useState(null)
      /** 能力页：四个档位的试算结果（服务端 resolvePolicy 算的，前端只渲染） */
      const [capPreview, setCapPreview] = useState(null)
      /** 能力页：已知群列表（分群例外用） */
      const [capChats, setCapChats] = useState(null)
      /** 能力页：功能开关（哪些功能整个关着） */
      const [capFeat, setCapFeat] = useState(null)
      /** 能力页：D11 记忆淡出的 dry-run 预览（纯读，不动数据） */
      const [capRetention, setCapRetention] = useState(null)
      /** 能力页：次数配额（每个功能用了多少 / 上限多少） */
      const [capQuota, setCapQuota] = useState(null)
      /**
       * 页头两个开关的初值。
       *
       * **不复用 `capFeat`**：那个是「能力」页的内容，`loadCaps` 只在
       * `tab === 'caps'` 时才跑，首屏是 null。页头必须自己拉一次。
       * 存的是 `features.get` 返回的 `on`（算过依赖的**生效态**），不是 `raw`。
       */
      const [reg, setReg] = useState(null)
      const [busy, setBusy] = useState(false)
      const [toastMsg, setToastMsg] = useState('')
      const toastTimer = useRef(null)

      const toast = useCallback((m) => {
        setToastMsg(String(m || ''))
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToastMsg(''), 3600)
      }, [])
      useEffect(() => () => clearTimeout(toastTimer.current), [])

      const loadStatus = useCallback(async () => {
        const [a, b] = await Promise.all([get('/status'), get('/setup')])
        setSt(a.ok === false ? null : a)
        setSetupSt(b.ok === false ? null : b)
      }, [])

      /**
       * 只剩一种通道（roost 外接协议直连），页头那个「通道 roost」徽章
       * 是恒定值，零信息量，已随端口徽章一起删掉——这里不再拉 `/channels`。
       */
      const loadSetupMeta = useCallback(async () => {
        const a = await get('/registrations')
        setReg(a.ok === false ? null : a)
      }, [])

      const loadConfig = useCallback(async () => {
        const r = await get('/config')
        setConfig(r.ok === false ? null : r.config)
        if (r.ok !== false) setConfigRev(String(r.revision || ''))
      }, [])

      /**
       * `pick` 是记忆页上选中的会话（空 = 跟随「最近说话的那个」）。
       * 两个接口都带上它，否则切了会话看到的还是原来那个群的日记和图谱。
       */
      const loadMemory = useCallback(async (pick = memPickRef.current) => {
        /**
         * 两个接口一起拉，合并成一份。
         *
         * `/memory` 给的是三层概览（facts + 日记 + 图谱的现在）；
         * `/graph` 额外带 `ended`（以前成立、现在不成立的关系）。
         * 只读 `/memory` 的话"她改过什么主意"那块永远是空的——
         * 字段缺失不会报错，只会静默少一块内容，这种最容易漏。
         */
        const qs = pick ? '?chatId=' + encodeURIComponent(pick) : ''
        /**
         * 三个接口一起拉。
         *
         * `/closing` 也在这儿拉：它是「这段聊到哪结束」的状态，跟记忆同页看最顺
         * （收尾是静默发生的，不摆在面板上就只能翻日志）。
         */
        const [r, g, c] = await Promise.all([get('/memory' + qs), get('/graph' + qs), get('/closing')])
        if (r.ok === false) {
          setMem(null)
          return
        }
        setMem({
          ...r,
          graph: {
            ...(r.graph || {}),
            ...(g.ok === false ? {} : { stats: g.stats, entities: g.entities, edges: g.edges, ended: g.ended }),
          },
          closing: c.ok === false ? null : c,
        })
        /**
         * 依赖必须为空。
         *
         * 原来依赖 `memPick`：切会话时 `setMemPick` 让它换了个身份，
         * 而加载 effect 的依赖里有 `loadMemory` → effect 再跑一次 → 同一个会话拉两遍。
         * 用 ref 读最新值，身份就稳定了。
         */
      }, [])

      /** 切会话：记住选择，再拉一次（日记/图谱/授权都跟着换） */
      const pickChat = useCallback(async (chatId) => {
        setMemPick(chatId)
        await loadMemory(chatId)
      }, [loadMemory])

      /** 正在飞的请求：key → true。切页时避免同一份数据被连拉两次 */
      const inflightRef = useRef({})

      const loadHer = useCallback(async () => {
        const [p, m, s] = await Promise.all([get('/personas'), get('/mood'), get('/stickers')])
        // 一次落地：三份数据合成一次 setState，只重排一次
        setHer({
          personas: p.ok === false ? null : p,
          mood: m.ok === false ? null : m,
          stickers: s.ok === false ? null : s,
        })
      }, [])

      const loadAwake = useCallback(async () => {
        const [a, s] = await Promise.all([get('/awake'), get('/speakup')])
        setAw(a.ok === false ? null : a)
        setSp(s.ok === false ? null : { state: s.state, cfg: s.cfg })
      }, [])

      const loadCtx = useCallback(async () => {
        const [c, m, u] = await Promise.all([get('/compact'), get('/mind'), get('/usage?days=7')])
        setCtxInfo(c.ok === false ? null : c)
        setMind(m.ok === false ? null : m)
        setUsageInfo(u.ok === false ? null : u)
      }, [])

      const loadChats = useCallback(async () => {
        const r = await get('/chats')
        setChats(r.ok === false ? null : r.chats || [])
      }, [])

      /** 首屏 + 切页时按需拉，不一次性全打一遍 */
      useEffect(() => {
        loadStatus()
        loadSetupMeta()
      }, [loadStatus, loadSetupMeta])

      useEffect(() => {
        /**
         * 同一份数据只允许一个请求在飞。
         *
         * 判空（`if (!config)`）挡得住「已经有值」，挡不住「正在拉」——
         * 切页时上一个请求还没回来，下一页又发一次。实测 her → 设置 时
         * `/config`、`/stickers`、`/personas` 各被拉两次。
         */
        const once = (key, fn) => {
          if (inflightRef.current[key]) return
          inflightRef.current[key] = true
          Promise.resolve()
            .then(fn)
            /** 失败也要落地：不接住就是面板里一条 unhandled rejection */
            .catch(() => {})
            .finally(() => {
              inflightRef.current[key] = false
            })
        }

        if (tab === 'caps') {
          once('caps', loadCaps)
          /** 2.8 名单节读 config；直接停在权限页刷新也要拉一次 */
          if (!config) once('config', loadConfig)
        }
        /** 人物 / 备份共用 /memory 那一份快照；直接从这两页进也要拉一次 */
        if (tab === 'memory' || tab === 'people' || tab === 'backup') once('memory', () => loadMemory())
        if (tab === 'her') {
          once('her', loadHer)
          // 名字输入框读 config；「本群」下拉要 mem.chatId——都主动拉一次
          if (!config) once('config', loadConfig)
          if (!mem) once('memory', () => loadMemory())
        }
        /**
         * 心情页的数据**全部**来自 `/mood`，而它挂在 `her` 上。
         *
         * 少了这一支：直接进「心情」页（或上次停在那一页、刷新后恢复）
         * 一个数据请求都不发，页面永远停在「读不到情绪——插件刚起来时会空几秒」，
         * 而且不会自愈，除非切到人格 / 主动搭话 / 设置 / 排障任意一页再回来。
         * 拆分页签（a435957）时只加了渲染分支，忘了这里。
         */
        if (tab === 'mood') {
          if (!her?.mood) once('her', loadHer)
        }
        /**
         * 表达页：语音卡片读 `config.tts`、表情包卡片读 `/stickers`（挂在 `her` 上）。
         *
         * 更危险的是**写**：`config` 为 null 时 `TtsCard` 的草稿是空对象，
         * 此时点保存提交的 `tts` 只含三个默认值，等于在空数据上覆盖真实配置。
         * `TtsCard` 自己另有一道 `!config` 的硬拦（见 `save()`），这里是第一道。
         */
        if (tab === 'express' || tab === 'stickers') {
          if (!config) once('config', loadConfig)
          if (!her?.stickers) once('her', loadHer)
        }
        /**
         * 模型页：「视觉能力」那一行读写 `config.roostHost.vision`。
         * 没拉配置时那一行只能显示「读取配置…」，改不了——所以进页先拉一次。
         * 清单（`model.list`）由卡片自己拉：它慢（要逐个 provider 问能力），
         * 卡在这儿会连页签都切不动。
         */
        /** 群聊策略页整页读写 config，进来先拉一次；没拉到时页面只显示「读取配置…」 */
        if (tab === 'groupchat' && !config) once('config', loadConfig)
        if (tab === 'model' && !config) once('config', loadConfig)
        /**
         * 安全防护页整页读写 `config.security`。漏了这一步的后果不是「显示读不到」，
         * 而是**开关和输入框全被 disabled**（`!config` 那道闸），页面看起来像坏了：
         * 用户点白名单框没反应、开关点不动，只有状态字按默认值写着「已开启」。
         */
        if (tab === 'security' && !config) once('config', loadConfig)
        if (tab === 'awake') {
          // 授权状态在 /memory 里、chatId 列表在 /chats 里，这一页两样都要用
          once('awake', loadAwake)
          /**
           * 判的是**字段**不是对象：`loadHer` 即使三个接口全失败也会 setHer，
           * 对象非空但里面全是 null。只看 `!her` 的话，插件刚起时一次 503
           * 就让它永远不再重试，页面永久停在「读不到」。
           */
          if (!her?.mood) once('her', loadHer)
          if (!mem) once('memory', () => loadMemory())
          if (!chats) once('chats', loadChats)
        }
        /** 排障页把 日志 / 上下文 / 会话清理 放一起，三份数据都得预拉 */
        if (tab === 'context' || tab === 'logs') {
          once('ctx', loadCtx)
          once('chats', loadChats)
          // 「表情包 order 901 · N 字」那行要 /stickers
          if (!her?.stickers) once('her', loadHer)
        }
        if (tab === 'chats') once('chats', loadChats)
        if (tab === 'config') {
          if (!config) once('config', loadConfig)
          // 「表情包」卡片要读 /stickers
          if (!her?.stickers) once('her', loadHer)
        }
        /**
         * **不要**把 `mem` / `chats` / `her` 放进来。
         *
         * 它们每拉一次都会变成新对象（`setMem({ ...r })`），而这里又调 `loadMemory()`：
         * setMem → mem 变 → effect 重跑 → 再 setMem …… 自我驱动，永不停止。
         * 实测「记忆」页 30 轮渲染打了 30 次 /memory + /graph + /closing，
         * 「会话」页 30 轮打了 30 次 /chats；真实浏览器没有轮数上限，会一直转。
         *
         * 需要读它们的地方用 `if (!her)` 这种判空即可——判空读的是当次渲染的闭包值，够用。
         */
      }, [tab, loadMemory, loadHer, loadAwake, loadCtx, loadChats, loadConfig])

      /** 通用动作 runner：按钮点下去 → 跑接口 → 提示 → 刷新 */
      const run = useCallback(async (path, label, body) => {
        setBusy(true)
        try {
          const r = await post(path, body || {})
          toast(r.ok === false ? (label + '失败：' + (r.message || '未知')) : (label + '完成'))
          await loadStatus()
          return r
        } finally {
          setBusy(false)
        }
      }, [toast, loadStatus])

      const quick = useCallback(async (op, arg) => {
        /**
         * 不再传 `actor`：身份由宿主（fence → connection.admit）判定，
         * 前端填什么都不会被采信。以前这里写死 `{bucket:'owner'}`，
         * 等于「谁打开面板谁是主人」——看着像鉴权，实际是自报家门。
         */
        const r = await post('/quick', { op, arg, chatId: mem?.chatId || '' })
        return r
        /**
         * 依赖只写 `chatId`，不写整个 `mem`。
         *
         * `loadMemory` 每次都 `setMem({ ...r })` 换新对象，依赖 `[mem]` 会让
         * `quick` 每次刷新都换身份 → 所有以 `quick` 为依赖的 effect 重跑。
         * 实测：刷一次记忆多打 2 次 `features.get` + 2 次 `extensions.get`，
         * 把「旧快照盖掉刚点的开关」那个窗口越开越大。
         */
      }, [mem?.chatId])

      /**
       * 页头两个开关的初值（异步，到了才渲染开关）。
       *
       * 与「能力」页同一个接口，所以两处永远看到同一个真相；取 `on` 而不是
       * `raw`——`on` 是算过 `requires` 的**生效态**，页头要显示的就是它。
       *
       * **不复用 `toggleFeat`**：那个定义在 `CapsTab` 内部，页头在主组件
       * 作用域里调不到；这里直接打 `features.patch`，成功后只更新自己这份
       * `featOn`（不 `reload()`——那是整页状态重拉）。
       */
      /**
       * 本地写入序号：**迟到的 `features.get` 不许盖掉刚点的开关**。
       *
       * 真实时序：进「能力」页会连打 `capabilities.get` + 5 个接口（几百毫秒），
       * 这期间点页头总开关 → PATCH 成功、开关变关 → 切换前的 `features.get`
       * 快照返回 → 开关自己弹回「开」。后端是关的，面板在撒谎。
       */
      const featSeq = useRef(0)
      const loadFeatOn = useCallback(async () => {
        const seq = featSeq.current
        const r = await quick('features.get')
        if (r.ok === false) return
        if (seq !== featSeq.current) return
        setFeatOn(r.on || null)
      }, [quick])
      useEffect(() => { loadFeatOn() }, [loadFeatOn])

      /**
       * 「已安装」页的显隐判据：**真清单为空才藏**。
       *
       * 不能用 `/extensions/ui` 的 `pages`——那只收声明了合法 UI 的扩展，
       * 装了不带 UI 的扩展时它也是空，会把卸载/诊断入口一起藏掉。
       */
      useEffect(() => {
        let alive = true
        ;(async () => {
          const r = await quick('extensions.get')
          if (!alive || !r || r.ok === false) return
          if (!Array.isArray(r.rows)) return
          setInstalledRows(r.rows)
          setInstalledReady(true)
        })()
        return () => { alive = false }
      }, [quick])

      /**
       * 页头开关：总开关 / 试运行。
       *
       * 失败时**不改本地状态**并把后端的原话 toast 出来——后端 `cannotEnable`
       * 与 `staged` 都是 409 + 原因，吞掉就会出现「显示开着、实际没开」。
       */
      const toggleHeadFeat = useCallback(async (id, on) => {
        /** 先加序号：在途的 `features.get` 快照一律作废（见上面的注释） */
        featSeq.current += 1
        const r = await quick('features.patch', { id, on })
        if (r.ok === false) {
          toast(r.message || '改不了，稍后再试')
          return
        }
        if (r.message) toast(r.message)
        setFeatOn((prev) => ({ ...(prev || {}), [id]: on }))
      }, [quick, toast])

      /**
       * 能力页：一次拉两份——策略本体 + 四个档位的试算。
       *
       * 试算放服务端算（`capabilities.preview`），用的是和真实生效同一个
       * `resolvePolicy()`。前端自己展开 `*` / `group:x` 的话，迟早和后台算出两套结果，
       * 那就是"面板说没有、实际有"这类最伤信任的 bug。
       */
      const loadCaps = useCallback(async () => {
        /** 进来先记序号：这之后如果点了页头开关，这次 `features.get` 的结果就作废 */
        const featSeqAtStart = featSeq.current
        const r = await quick('capabilities.get')
        if (r.ok === false) {
          setCaps(null)
          return
        }
        setCaps(r)
        const [p, c, f, q, rt] = await Promise.all([
          quick('capabilities.preview', {}),
          get('/chats'),
          quick('features.get'),
          quick('quota.get'),
          quick('features.preview'),
        ])
        setCapPreview(p.ok === false ? null : p)
        setCapChats(c && c.ok !== false ? c.chats || [] : [])
        setCapFeat(f.ok === false ? null : f)
        /**
         * 顺带刷页头的 `featOn`：`voice`/`stickers` 的开关在权限页改，
         * 走的是这条路径（`reload()` → `loadCaps`），不是页头那两个。
         * 不同步的话「关掉表情包」之后导航永远不会隐藏——§11 独立审查查出的第一条。
         *
         * **但要带序号**：这条 `features.get` 可能比用户点的页头开关更晚回来，
         * 无脑写就把开关弹回旧值（和 `loadFeatOn` 同一类时序，2026-11 复核）。
         */
        if (f.ok !== false && featSeqAtStart === featSeq.current) setFeatOn(f.on || null)
        setCapQuota(q.ok === false ? null : q)
        setCapRetention(rt.ok === false ? null : rt)
      }, [quick])

      /**
       * 局部保存（切人格、改名字）。
       *
       * 走 `?mode=patch`：服务端以磁盘配置为基线合并。走整份替换的话，
       * `saveConfig` 的基线是 DEFAULTS——只提交 `{persona:{name}}` 会把 token
       * 清空、端口改回 17321（2026-11-01 实测）。
       */
      const saveCfg = useCallback(async (patch) => {
        const r = await post('/config?mode=patch', patch)
        if (r.ok !== false) {
          setConfig(r.config || null)
          if (r.revision) setConfigRev(String(r.revision))
        }
        return r
      }, [])

      /** 「配置全文」用：整份替换（删字段 = 回落默认值） */
      const saveAll = useCallback(async (full) => {
        const r = await post('/config?mode=full', { ...full, __revision: configRev })
        if (r.httpStatus === 409) {
          setConfig(r.config || null)
          setConfigRev(String(r.revision || ''))
          return r
        }
        if (r.ok !== false) {
          setConfig(r.config || null)
          setConfigRev(String(r.revision || ''))
        }
        return r
      }, [configRev])

      /**
       * 结构：**页头和页签固定，只有正文滚**。
       *
       * 上一版是整页一个大 div，滚动条跑到哪由 DSH 外层决定——结果是
       * 页签行自己长了一条竖滚动条（还拖不动），而下面的正文没有滚动条、
       * 长页面直接被切掉。仪表盘该有的样子正好相反：切换栏永远在，
       * 内容在它下面滚。
       */
      /**
       * 归一化后的当前页：老频道 key（`ch-message` 等）落到 `ch-api`。
       *
       * 深链和 localStorage 可能还存着老 key，state 里就让它留着（这样
       * `ChannelApiTab` 能据此选中对应段），但**导航高亮、二级页签、路由
       * 判定都按 `activeTab` 走**，否则一级组不高亮、二级行整条消失。
       */
      const activeTab = LEGACY_CH_TABS[tab] ? 'ch-api' : tab
      /** 当前页所属分组；隐藏页不属于任何组，`curGroup` 为 null（一级不高亮、二级不显示） */
      const curGroup = navGroupOf(activeTab, extPages)
      /** 组内页面：按分组声明顺序（见 `tabsOfGroup`），扩展页接在后面 */
      const groupTabs = tabsOfGroup(curGroup)

      /**
       * 根节点的外观：强调色 + 关动效。
       *
       * 写在 `.roost-root` 的 inline style 上——CSS 里的 `--accent` 读的就是
       * 这两个变量（见 CSS 里那段注释）。空对象就别传，免得渲染出空的 style。
       */
      const accent = accentOf(uiPref.accent)
      const rootStyle = accent.dark
        ? { '--roost-accent': accent.dark, '--roost-accent-light': accent.light }
        : undefined
      const rootClass = 'roost-root' + (uiPref.anim === false ? ' no-anim' : '')

      /**
       * 首次接入向导：新装 / 升级后 `needed=true`，整棵面板树都不挂，
       * 只留全屏向导（照 aurabot `showWizard ? h(Wizard) : null` 的做法）。
       * 这样老配置在没重新接入前不会给人一种「一切正常」的错觉。
       * 跳过后后端仍返回 needed=false，但概览页会把未接入状态一直显示着。
       */
      if (st?.wizard?.needed) {
        return h('div', { className: rootClass, style: rootStyle },
          h(SetupWizard, {
            st,
            toast,
            onDone: loadStatus,
            reload: loadStatus,
          }),
        )
      }

      return h('div', { className: rootClass, style: rootStyle },
        h('div', { className: 'roost-head' },
          h('div', { className: 'roost-head-inner' },
          /**
           * 标题行：左边标题，右边两个开关。
           *
           * 删掉的两块是死信息（2026-11-18）：`:17321` 端口徽章读的是
           * `st.actualPort || st.port`，概览页早已改成看外接协议连接状态
           * （连没连上、seq 有没有推进），端口对不对得上不再是问题；
           * 「通道 roost」更是恒定值——只剩这一种通道了。
           */
          h('div', { className: 'roost-head-row' },
            h('div', { className: 'roost-title-lg' }, 'Roost'),
            /**
             * 快速开关：页头改了**立刻生效**（不走「保存设置」）。
             * `featOn` 为 null 时整块不渲染——宁可晚半秒出现，也不要先显示
             * 一个默认开着、实际关着的开关。
             */
            featOn ? h('div', { className: 'roost-head-quick' },
              [
                ['botEnabled', '总开关', '关掉后一条消息都不接，定时行为全停'],
                ['dryRun', '试运行', '照常回、照常记，只是不真的发到 QQ'],
              ].map(([id, label, hint]) => h('label', {
                key: id, className: 'roost-head-q', title: `${hint}（改完立刻生效）`,
              },
                h('span', null, label),
                h('button', {
                  type: 'button', className: 'roost-switch', role: 'switch',
                  'aria-checked': featOn[id] ? 'true' : 'false',
                  'aria-label': label,
                  'data-on': featOn[id] ? '1' : '0',
                  title: hint,
                  onClick: () => toggleHeadFeat(id, !featOn[id]),
                }),
              )),
            ) : null,
          ),
          h('div', { className: 'roost-note roost-sub' }, 'QQ 消息从这里交给 DSH 会话回答。'),
          /** 关着时给一句提示：否则下面所有开关都「改了没反应」，看不出为什么 */
          featOn && featOn.botEnabled === false
            ? h('div', { className: 'roost-note roost-sub' }, '总开关关着：消息不接、她也不主动开口，下面的设置暂时不生效。')
            : null,

          h('div', { className: 'roost-nav' },
            h('div', {
              className: 'roost-nav-top',
              role: 'tablist',
              'aria-label': 'Roost 功能分组',
              /* 行内再写一次 wrap：页签条的溢出行为是硬约束（见测试），
                 不能只靠类名——将来有人改 CSS 时这一条还在 */
              style: { display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', padding: '6px 0 0' },
            },
              NAV_GROUPS.filter((g) => tabsOfGroup(g).length > 0).map((g) => {
                const on = curGroup && curGroup.id === g.id
                /** 悬浮提示把组内页面列出来：只看「能力」猜不到里面有扩展。
                    顺序与点进去后二级行一致，否则提示里看到的和实际的不一样 */
                const names = tabsOfGroup(g)
                  .map(([, label]) => label)
                  .join(' · ')
                return h('button', {
                  key: g.id, type: 'button',
                  className: 'roost-grp',
                  role: 'tab',
                  'aria-selected': on ? 'true' : 'false',
                  'data-on': on ? '1' : '0',
                  title: names,
                  onClick: () => openGroup(g),
                }, navIcon(g.icon), h('span', null, g.label))
              }),
            ),
            /** 二级只在该组超过一页时出现：概览单独成组，不该留一条空的二级行。 */
            groupTabs.length > 1
              ? h('div', {
                  className: 'roost-nav-sub', role: 'tablist', 'aria-label': curGroup.label,
                  /* 与一级组那排同一条硬约束：只换行、不 overflow。写 inline 是为了
                     将来有人改 CSS 时这条还在（2026-11-06 踩过竖滚动条） */
                  style: { flexWrap: 'wrap' },
                },
                  groupTabs.map(([id, label]) => h('button', {
                    key: id, type: 'button',
                    className: 'roost-tab',
                    role: 'tab',
                    'aria-selected': activeTab === id ? 'true' : 'false',
                    'data-on': activeTab === id ? '1' : '0',
                    ...(curGroup.id === 'system' && SYSTEM_SEG[id]
                      ? {
                          style: { marginLeft: 10, paddingLeft: 10, borderLeft: '1px solid var(--line-soft)' },
                          title: '这一段：' + SYSTEM_SEG[id],
                        }
                      : {}),
                    /** 已经是这一页就别再点一次：老深链（ch-message）归一化后
                        高亮的是 ch-api，重复点击会重挂组件、把段重置回第一段 */
                    onClick: () => { if (activeTab !== id) setTab(id) },
                  }, label)))
              : null,
            /** 隐藏页标记放两个 tablist 外面：tablist 的 owned element 必须是 role=tab，
                放外面既能保住 aria-current 的读屏语义，也不破坏 tablist 结构。 */
            /**
             * 当前位置标记：隐藏页（context/setup）与**被藏起来的正式页**共用。
             * 深链或 Alt+K 打开一个藏起来的页时，正文照常渲染、一级组照常高亮，
             * 只在这里补一个不可点的「当前页」标记——不然用户会以为导航坏了。
             */
            HIDDEN_TABS.includes(tab) || hiddenIds.has(tab)
              ? h('div', { className: 'roost-nav-sub' },
                  h('span', { className: 'roost-nav-current', 'aria-current': 'page' },
                    ({ context: '上下文', setup: '接入' })[tab]
                    || ((TABS.find(([id]) => id === tab) || [])[1] ?? tab)
                      + (hiddenIds.has(tab) ? '（已隐藏）' : '')))
              : null,
            ),
          ),
        ),

        /**
         * A11（第二轮对照）：面板级边界之外，再给正文包一层「按页」的边界。
         * key 带 tab —— 上一页崩过，切到别的页会重新挂载，不会卡在报错块里。
         * 只包正文：侧栏导航留着，单页渲染异常时还能点去别的页。
         * 假 React（渲染测试）下 RenderBoundary 降级成直通，结构不变。
         */
        h('div', {
          className: 'roost-scroll-body roost-fade' + (pageModal ? ' is-locked' : ''),
          key: tab,
        },
          h(RenderBoundary, { key: 'tab:' + tab },
            h('div', { className: 'roost-body-inner' },
            tab === 'overview' ? h(OverviewTab, { st, setupSt, toast, reload: loadStatus, busy, run, onGo: setTab, logs }) : null,
          /** 个性化：偏好状态在 RoostPage（`uiPref`），这里只传下去 */
          tab === 'personalize' ? h(PersonalizeTab, { uiPref, setPrefs, toast }) : null,
          tab === 'setup' ? h(SetupTab, { st: setupSt, reload: loadStatus, toast, busy, run, reg, onSaved: loadSetupMeta, saveCfg }) : null,
          /** A6：接入提成正门；隐藏页 setup 与 ?tab=setup 深链原样保留，两边同一份内容 */
          tab === 'connect'
            ? h('div', null,
                h('div', { className: 'roost-note', style: { marginBottom: 8 } },
                  '这页是接入的正门：装没装、凭证、在不在跑、组件版本都在这儿。老链接 ?tab=setup 打开的是同一份内容，两边都留着。'),
                h(SetupTab, { st: setupSt, reload: loadStatus, toast, busy, run, reg, onSaved: loadSetupMeta, saveCfg }))
            : null,
          /** A6：安全防护独立页；5.14 起开关可写（深合并到同一个 security 段） */
          tab === 'security' ? h(SecurityTab, { config, saveCfg, toast, setTab }) : null,
          tab === 'her'
            ? h(HerTab, {
                config,
                personas: her?.personas ?? null,
                mem, toast, save: saveCfg, reload: loadHer, quick,
              })
            : null,
          tab === 'caps' ? h(CapsTab, {
            caps, preview: capPreview, chats: capChats, feat: capFeat,
            retention: capRetention, quota: capQuota, toast, reload: loadCaps, quick, busy,
            /** 2.8 名单要读 config.awake.groups / 写回整份，还要展示框架侧主人状态 */
            config, saveCfg, setupSt, setTab,
          }) : null,
          tab === 'ext' ? h(ExtTab, { quick, toast, extPages, setTab }) : null,
          tab === 'ext-market' ? h(ExtMarketTab, { toast }) : null,
          tab === 'ext-api' ? h(ExtApiTab, { toast }) : null,
          /** 6.1：扩展声明的页面。tab key 形如 `ext:<id>`，不在静态 TABS 里 */
          String(tab).startsWith('ext:') ? h(ExtUiPage, { id: String(tab).slice(4), toast }) : null,
          tab === 'memory' ? h(MemoryTab, { mem, toast, reload: loadMemory, quick, busy, onPickChat: pickChat, setTab, config, saveCfg }) : null,
          /** 2.3：与记忆页并列的两个入口，同一份 mem，不复制状态 */
          tab === 'people' ? h(PeopleTab, { mem, toast, reload: loadMemory, quick, busy, setTab }) : null,
          tab === 'backup' ? h(BackupTab, { mem, toast, reload: loadMemory, quick, busy, setTab, config, saveCfg }) : null,
          /** 2026-11-12 新增：心情从「主动搭话」拆出，表达/模型从「设置」拆出 */
          tab === 'mood' ? h(MoodTab, { mood: her?.mood ?? null, reloadMood: loadHer, toast, quick, config, saveCfg }) : null,
          tab === 'express'
            ? h(ExpressTab, {
                config, stickers: her?.stickers ?? null,
                saveCfg, toast, reload: loadHer, part: 'voice',
              })
            : null,
          /** 表情包：从「表达」里拆出来的那一半（2026-11-13），tab key 新增，不动老的 */
          tab === 'stickers'
            ? h(ExpressTab, {
                config, stickers: her?.stickers ?? null,
                saveCfg, toast, reload: loadHer, part: 'sticker',
              })
            : null,
          tab === 'about' ? h(AboutTab, { toast }) : null,
          tab === 'model'
            /** 视觉能力那一行要读写 config，所以把 config / saveCfg 一起给过去 */
            ? h(ModelTab, { toast, currentChatId: mem?.chatId || '', config, saveCfg })
            : null,
          /** 功能包：宿主自己的可选依赖（图片处理/转码），装哪、装没装、能不能卸都在这儿 */
          tab === 'deps' ? h(DepsTab, { toast, quick, setTab }) : null,
          tab === 'update' ? h(UpdateTab, { toast }) : null,
          /** 5.7：模拟测试页——只调纯函数接口，一条都不真发 */
          tab === 'sim' ? h(SimTab, { toast }) : null,
          tab === 'awake'
            ? h(AwakeTab, {
                aw, mem, sp, chats,
                toast, reload: loadAwake, reloadSp: loadAwake, busy, quick,
                /** 4.6 互动召回的开关要读写 config.wakeup */
                config, saveCfg,
              })
            : null,
          tab === 'context'
            /** 老 key 单独进来时复用排障页的分区外观，别出现「同一块两套皮」 */
            ? h('div', { className: 'roost-diag-part' },
                h('div', { className: 'roost-diag-h' }, '上下文 · 手动刷新'),
                /** 2.6 A10：两处都留着，只把「谁正门」说清，别让人猜该在哪页动手 */
                h('div', { className: 'roost-note', style: { marginBottom: 8 } },
                  '这页是老链接 ?tab=context 的落脚点，内容一直保留。日常查问题请去「排障」页——那边连日志一起看；这里只单看上下文。'),
                h(ContextTab, {
                  ctxInfo, mind, usageInfo, stickers: her?.stickers ?? null,
                  toast, reload: loadCtx, busy,
                }))
            : null,
          /** 「身份」：QQ 会话 ↔ DSH 会话的映射，现在有自己的页签，不再套一层「手动刷新」 */
          tab === 'chats' ? h(ChatsTab, { chats, reload: loadChats, toast }) : null,
          /** 群聊策略：01–05 露已有参数，06–08 是 2.2b 的插话概率 / 按群覆写 / 决策链 */
          tab === 'groupchat'
            ? h(GroupChatTab, { config, saveCfg, saveAll, toast, setTab, chats })
            : null,
          /** 群管：禁言 / 踢人 / 入群审批。协议侧 group.* 是 message scope，装了就能用 */
          tab === 'groupadmin' ? h(GroupAdminTab, { chats, toast }) : null,
          /* 频道：总览 / 策略 / 接口 / 排障。老 key（ch-message 等）落到接口页并选中对应段 */
          tab === 'ch-home' ? h(ChannelHomeTab, { config, saveCfg, toast, chats, setTab }) : null,
          tab === 'ch-policy'
            ? h(ChannelPolicyTab, { config, saveCfg, saveAll, toast, setTab, chats })
            : null,
          activeTab === 'ch-api'
            ? h(ChannelApiTab, {
                toast,
                chats,
                initialSection: LEGACY_CH_TABS[tab] || 'channels',
              })
            : null,
          tab === 'ch-diag' ? h(ChannelDiagTab, {}) : null,
          /** 发帖：开关 + 排期 + 版块 + 预览 + 历史。体检条在页顶，不挡操作 */
          tab === 'ch-post' ? h(ChannelPostTab, { chats, toast, setTab }) : null,
          /** 人设 → 资料：她的名字 / 简介 / 头像 / 菜单，以及她能不能自己改 */
          tab === 'profile' ? h(ProfileTab, { toast }) : null,
          /** 机器人身份：菜单 / 指令面板这条合规链，和开发者后台那套分开 */
          tab === 'bot-self' ? h(SelfConfigTab, { toast }) : null,
          tab === 'account' ? h(AccountTab, { toast }) : null,
          tab === 'config'
            ? h('div', null,
                config
                  ? h(ConfigTab, {
                      config, save: saveAll, saveCfg, toast,
                      stickers: her?.stickers ?? null, setupSt, reload: loadHer,
                      currentChatId: mem?.chatId || '', setTab,
                    })
                  : h('div', { className: 'roost-empty' }, '读取配置…'),
                h(Sec, { title: '危险操作' },
                  h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => { setTab('account'); toast('已切到「账号迁移」，绑定与一键改写都在那一页') },
                    }, '账号迁移…'),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      /** A8：不写编号。插卡后编号会漂，写了就又变成「指错路」 */
                      onClick: () => { setTab('memory'); toast('已切到「记忆」，清空在最后一张「清空」卡') },
                    }, '清空记忆…'),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => { setTab('her'); toast('已切到「人格」，批量删除在「整理」') },
                    }, '整理人格…'),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => { setTab('ext'); toast('已切到「扩展」，清空在「已装扩展」底部') },
                    }, '清空扩展记忆…'),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => { setTab('mood'); toast('已切到「心情」，清空历史在「变化记录」那张卡') },
                    }, '清空心情历史…'),
                  ),
                ),
              )
            : null,
          tab === 'logs'
            ? h('div', { className: 'roost-diag' },
                h(AuditPanel, { quick }),
                h(LogsTab, {
                logs,
                auto: logAuto,
                onToggleAuto: (v) => {
                  setLogAuto(v)
                  try { localStorage.setItem('roost.logs.auto', v ? '1' : '0') } catch {}
                },
                onReload: async () => {
                  const r = await get('/logs')
                  setLogs(r?.ok === false ? [] : (r?.entries || []))
                },
                }),
                h('div', { className: 'roost-diag-part' },
                  h('div', { className: 'roost-diag-h' }, '上下文 · 手动刷新'),
                  /** 2.6 A10：排障页是正门；旧深链仍在，不删也不藏 */
                  h('div', { className: 'roost-note', style: { marginBottom: 8 } },
                    '这一页是查问题的正门：先看日志，再看上下文。老链接 ?tab=context 仍能单独打开上下文，两边内容一模一样。'),
                  h(ContextTab, {
                    ctxInfo, mind, usageInfo, stickers: her?.stickers ?? null,
                    toast, reload: loadCtx, busy, numbered: false,
                  })),
                /**
                 * 2026-11-12：「会话」那块拿掉了。它现在有独立的「身份」页，
                 * 排障页再渲染一遍等于同一个清单两个入口——用户得先判断在哪页动手。
                 */
              )
            : null,
          ),
          ),
        ),

        /**
         * 提示条固定在底部。
         *
         * 之前是普通 div 放在内容最后——「接入」页很长，点了第 5 步的按钮，
         * 提示出现在屏幕外，看起来就是「点了没反应」。
         */
        pageModal === 'setup'
          ? h(PageModal, { title: '首次接入 / 组件版本', onClose: () => setPageModal(null) },
              h(SetupTab, { st: setupSt, reload: loadStatus, toast, busy, run, reg, onSaved: loadSetupMeta, saveCfg }))
          : null,

        /**
         * Alt+K 查找面板。用 .cap-modal 那套遮罩（fixed + 点击关闭），
         * z-index 压过普通弹窗、低于 toast。
         */
        palette.open
          ? (() => {
              const list = matchTabs(palette.q, paletteTabs(), NAV_GROUPS, extPages)
              return h('div', {
                className: 'cap-modal', style: { zIndex: 2147483100, alignItems: 'flex-start' },
                onClick: () => setPalette({ open: false, q: '', idx: 0 }),
              },
                h('div', {
                  className: 'cap-modal-b',
                  style: { width: 'min(560px,100%)', marginTop: 90, padding: 14 },
                  onClick: (e) => e.stopPropagation(),
                },
                  h('input', {
                    className: 'roost-input', autoFocus: true,
                    placeholder: '搜页面：页名或别名，比如「日记」「群管」（↑↓ 选择，回车打开）',
                    value: palette.q,
                    onChange: (e) => setPalette({ open: true, q: e.target.value, idx: 0 }),
                  }),
                  h('div', { style: { marginTop: 10, maxHeight: 320, overflow: 'auto' } },
                    list.length === 0
                      ? h('div', { className: 'roost-muted', style: { fontSize: 12, padding: '8px 4px' } }, '没找到这个页面')
                      : list.map((x, i) => h('div', {
                          key: x.id,
                          role: 'button',
                          onClick: () => { setTab(x.id); setPalette({ open: false, q: '', idx: 0 }) },
                          style: {
                            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
                            borderRadius: 8, cursor: 'pointer', fontSize: 12.5,
                            background: i === palette.idx ? 'var(--hover)' : 'transparent',
                          },
                        },
                          h('b', { style: { flex: '1 1 auto' } }, x.label),
                          h('span', { className: 'roost-muted', style: { fontSize: 11 } }, x.group || '隐藏页'))),
                  ),
                  h('div', { className: 'roost-muted', style: { fontSize: 11, marginTop: 8 } },
                    'Alt+K 开关；Esc 关闭。'),
                ))
            })()
          : null,

        toastMsg
          ? h('div', {
              style: {
                position: 'fixed', left: '50%', bottom: 30, transform: 'translateX(-50%)',
                zIndex: 2147483000, maxWidth: 520, padding: '10px 18px',
                borderRadius: 9, border: '1px solid var(--line)',
                background: 'var(--dsw-alias-toast-bg, var(--surface))',
                color: 'var(--dsw-alias-toast-label, inherit)',
                boxShadow: '0 8px 28px rgba(0,0,0,.28)', fontSize: 13, lineHeight: 1.5,
              },
            }, toastMsg)
          : null,
      )
    }

    /* ---------------- 侧栏图标 ---------------- */

    const RoostIcon = () =>
      h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2 10.5c1.6 2 3.6 3 6 3s4.4-1 6-3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M3.2 9.2c1.2 1 2.9 1.6 4.8 1.6s3.6-.6 4.8-1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.55 }),
        h('circle', { cx: 8, cy: 5.6, r: 1.9, stroke: 'currentColor', strokeWidth: 1.3 }),
      )

    /* ---------------- 挂载 ---------------- */

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, () =>
        h(RenderBoundary, null, h(RoostPage))))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'Roost' }, RoostIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.RoostPage = RoostPage
    exports.RoostIcon = RoostIcon
    exports.ConfigTab = ConfigTab
    exports.WorkspaceCard = WorkspaceCard
    exports.DepsBlock = DepsBlock
    exports.SetupWizard = SetupWizard
    exports.HerTab = HerTab
    /** 5.2：排障页筛选的渲染测试要直接渲染它 */
    exports.LogsTab = LogsTab
    /** 频道发帖页：测试直接渲染，盯住「没数据也不白屏」和六张卡都在 */
    exports.ChannelPostTab = ChannelPostTab
    /** 频道总览 / 策略：渲染测试要锁住「卡在哪一页、什么顺序」 */
    exports.ChannelHomeTab = ChannelHomeTab
    exports.ChannelPolicyTab = ChannelPolicyTab
    /** 频道下拉的候选抽取（子频道 chatId → 纯 guildId + 去重），测试直接断言 */
    exports.guildChoicesOf = guildChoicesOf
    exports.CapsTab = CapsTab
    exports.ToolsModal = ToolsModal
    /**
     * 导出给测试盯住。这段逻辑出过两次事（`deny` 被冲掉、继承档取消写成
     * `allow: []`），两次都「渲染正常、不报错」，只有真点一下才看得出来。
     */
    exports.planToolToggle = planToolToggle
    exports.matchPat = matchPat
    /** 2.8 名单预演：纯函数，测试直接调，盯住四类统计不串味 */
    exports.planGroupWhitelist = planGroupWhitelist
    exports.suggestGroupWhitelist = suggestGroupWhitelist
    exports.AwakeTab = AwakeTab
    /* 2026-11-12 细分出来的四页，测试直接渲染它们 */
    exports.MoodTab = MoodTab
    exports.ExpressTab = ExpressTab
    exports.ModelTab = ModelTab
    exports.UpdateTab = UpdateTab
    /** 5.7：模拟测试页，测试直接渲染它，盯住「一条都不真发」 */
    exports.SimTab = SimTab
    /** 群聊策略页：只露已有配置，测试直接渲染它，盯住「一个算法都没新增」 */
    exports.GroupChatTab = GroupChatTab
    /** 2.3：人物 / 备份与记忆页，测试直接渲染，盯住「并列入口，不是搬家」 */
    exports.PeopleTab = PeopleTab
    exports.BackupTab = BackupTab
    exports.MemoryTab = MemoryTab
    /**
     * 导出给测试盯住。这个函数出过一次「拿配置端口冒充实际端口」的事故——
     * 语法合法、渲染不炸、测试全绿，但面板在撒谎。纯函数才能被断言。
     */
    exports.portView = portView
    /**
     * 记忆星图的纯函数（2026-11-13 替换掉独立关系图）。
     * 数据构建、筛选、2D/3D 投影、缩放档位、标签避让都能单独断言，
     * 不用起浏览器；3D 透视的正确性尤其是"看代码看不出来"的那一类。
     */
    /** 5.1：Alt+K 查找的匹配函数，导出给测试（搜别名能不能命中） */
    exports.matchTabs = matchTabs
    /* 个性化：纯函数导出给单测（渲染测试的假 React 不跑 effect，读不到真实 featOn） */
    exports.hiddenTabIds = hiddenTabIds
    exports.orderTabs = orderTabs
    exports.readUiPref = readUiPref
    exports.PROTECTED_TABS = PROTECTED_TABS
    exports.ACCENT_PRESETS = ACCENT_PRESETS
    exports.starScoreOf = starScoreOf
    exports.mergeClientPage = mergeClientPage
    exports.buildStarMap = buildStarMap
    exports.filterStars = filterStars
    exports.projectStars = projectStars
    exports.wheelZoom = wheelZoom
    exports.placeLabels = placeLabels
    exports.StarMap = StarMap
    return module.exports
  },
})
