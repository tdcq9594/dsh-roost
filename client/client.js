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
    const post = (p, body) =>
      req(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

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
  --accent:var(--dsw-alias-brand-primary, #2563eb);
}
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
.roost-head .roost-pill{font-size:10.5px;padding:1px 9px}
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
  border:1px solid var(--line);border-left:2px solid color-mix(in srgb, var(--accent) 55%, var(--line));
  border-radius:12px;background:var(--surface);padding:2px 14px 14px;
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

    function Sec({ n, title, children, right }) {
      const key = String(n || '') + '|' + String(title || '')
      const [open, setOpen] = useState(() => foldState[key] !== false)
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
            + ' —— 细节看「日志」页（带 stack 前两帧），或重启 DSH 让代码回到干净状态。'))
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
          const r = await post('/update/self', {})
          toast(r.message || (r.ok ? '装好了，重启 DSH 生效' : '没更新成'))
          await fetchInfo(true)
        } finally {
          setBusy(false)
        }
      }

      const pending = Boolean(info && info.pending)
      const restart = Boolean(info && info.ok !== false && info.pendingRestart && !info.hasUpdate)
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
    function ConfirmLink({ label, confirmLabel, onConfirm, disabled, danger = true }) {
      const [arm, setArm] = useState(false)
      useEffect(() => {
        if (!arm) return
        const t = setTimeout(() => setArm(false), 4000)
        return () => clearTimeout(t)
      }, [arm])
      return h('button', {
        type: 'button',
        className: 'roost-btn' + (danger ? ' danger' : '') + (arm ? ' armed' : ''),
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
              ? '链路这五项都齐了。剩下两件在 QQ 开放平台手动做：开「接收所有消息」、把机器人拉进群。'
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
            '自测直接跑一轮 DSH 对话，验「会话建得起来、AI 回得来」；QQ 那一段不在里面。'),
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
                          dangerouslySetInnerHTML: { __html: qrSvg },
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

          /** 第 5 步：直连配好之后，剩下两件是 QQ 开放平台上的手工操作 */
          h(Step, {
            n: 5, state: pairReady ? 'current' : 'todo', title: '在群里说句话',
            desc: pairReady
              ? '还差两件手工的事：开放平台开「接收所有消息」，机器人先进群'
              : '先把第 4 步的一键直连配好',
          },
            pairReady
              ? h('button', { type: 'button', className: 'roost-btn', onClick: () => window.open('https://q.qq.com', '_blank', 'noopener') }, '开放平台')
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
            h('li', null, '群里没反应：开放平台没开「接收所有消息」，或机器人不在群里'),
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
    function HerTab({ config, personas, mem, toast, save, reload, quick, repoSeed }) {
      /** 编辑区正在打开的人格 id */
      const [editId, setEditId] = useState('')
      const [raw, setRaw] = useState('')
      const [newId, setNewId] = useState('')
      const [dirty, setDirty] = useState(false)
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
      }

      return h('div', { className: 'pv-root' },
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
                h('textarea', {
                  className: 'roost-input',
                  style: { minHeight: 380, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 12, lineHeight: 1.7, resize: 'vertical' },
                  value: raw,
                  spellCheck: false,
                  onChange: (e) => { setRaw(e.target.value); setDirty(true) },
                }),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
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
                    '--- 之间是 name/tags；正文可分四段：性格（默认）、## 开场白、## 世界书、## 说话示例'),
                ),
              ),
            ),
          )
          : null,


      )
    }

    /* ---------------- 记忆（三层） ---------------- */

    function MemoryTab({ mem, toast, reload, quick, busy, onPickChat, setTab }) {
      /** 召回记录：后端每轮都在写，这里给个入口看「她刚才想起了什么」 */
      const [recallRows, setRecallRows] = useState(null)
      const [recallErr, setRecallErr] = useState('')
      const loadRecall = async () => {
        const r = await quick('recall.log', { limit: 50 })
        /** 读失败要明说，别统一显示「还没有记录」把报错伪装成空数据 */
        setRecallErr(r?.ok === false ? (r.message || '召回记录读取失败') : '')
        setRecallRows(r?.rows || [])
      }
      useEffect(() => { loadRecall() }, [])
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [fact, setFact] = useState('')
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
                  onChange: (e) => { setHits(null); onPickChat?.(e.target.value) },
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
          h('div', { style: { marginBottom: 10 } },
            h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } }, '通用（跨群）'),
            (mem?.global || []).length
              ? h('div', { className: 'roost-list' },
                  mem.global.map((f, i) =>
                    h('div', { key: i, className: 'roost-item' },
                      h('span', { className: 't' }, f),
                      h('span', { className: 'roost-muted', style: { fontSize: 11, flexShrink: 0 } },
                        factMeta('global', f)),
                      h(ConfirmLink, {
                        label: '删', confirmLabel: '确认删除',
                        onConfirm: async () => {
                          const r = await quick('memory.remove', f)
                          toast(r.message || '删了')
                          reload()
                        },
                      }),
                    ),
                  ),
                )
              : h('div', { className: 'roost-empty' }, '还没有跨群记忆'),
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
            (mem?.chat || []).length
              ? h('div', { className: 'roost-list' },
                  mem.chat.map((f, i) =>
                    h('div', { key: i, className: 'roost-item' },
                      h('span', { className: 't' }, f),
                      h('span', { className: 'roost-muted', style: { fontSize: 11, flexShrink: 0 } },
                        factMeta('chat', f)),
                      h(ConfirmLink, {
                        label: '删', confirmLabel: '确认删除',
                        onConfirm: async () => {
                          const r = await quick('memory.remove', f)
                          toast(r.message || '删了')
                          reload()
                        },
                      }),
                    ),
                  ),
                )
              : h('div', { className: 'roost-empty' }, canChat ? '这个群还没特有记忆' : '—'),
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
        h(Sec, { n: '02', title: '日记' },
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
                toast(r.ok ? `巩固完成：压缩 ${r.compressed} 条、三元组 ${r.triples} 个、撤销 ${r.revoked || 0} 条` : (r.reason || '没跑成'))
                reload()
              },
            }, '手动跑一次巩固'),
            h('div', { className: 'roost-note', style: { margin: 0, alignSelf: 'center' } },
              '平时每天凌晨自动跑（错过会补）'),
          ),
        ),

        /* ── 第三层：图谱 ── */
        h(Sec, { n: '03', title: '她知道的关系' },
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
                  '· ' + p.name + '：' + (p.impression || '') + (p.tips ? `（相处：${p.tips}）` : ''))))
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
            + '导入请用命令行 node scripts/backup.mjs import <zip>：只暂存到 .restore/，下次启动 DSH 才生效，'
            + '所以面板不放导入按钮。'),
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

        h(Sec, { n: '05', title: '召回记录', right: h('button', {
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
        h(Sec, { n: '06', title: '清空' },
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
    function PeopleTab({ mem, toast, reload, quick, busy, setTab }) {
      const profiles = mem?.profiles || []
      const events = mem?.events || []
      const gp = mem?.graph
      const goMemory = () => { if (setTab) setTab('memory') }
      const shortTime = (at) => new Date(at).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })

      if (!mem) return h('div', null,
        h('div', { className: 'roost-empty' }, '读取人物数据…'),
        h('div', { className: 'roost-note' }, '一直停在这儿的话，去「排障」页看看 /memory 有没有报错。'),
        h('button', {
          type: 'button', className: 'roost-btn',
          onClick: () => { if (reload) reload() },
        }, '重试'),
      )

      return h('div', null,
        h(Sec, {
          n: '01', title: `熟人小档案（${profiles.length}）`,
          right: h('button', { type: 'button', className: 'roost-btn', onClick: () => reload && reload() }, '刷新'),
        },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '每天凌晨从聊天里攒一小段印象和相处建议，跨群共用；同一天里不改提示词。开关关着也能在这儿查看和清空已有的。'),
          profiles.length
            ? h('div', { style: { display: 'grid', gap: 4, marginBottom: 8 } },
                profiles.map((p, i) => h('div', { key: i, className: 'roost-note' },
                  '· ' + p.name + '：' + (p.impression || '') + (p.tips ? `（相处：${p.tips}）` : ''))))
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

        h(Sec, { n: '02', title: '她知道的关系' },
          gp?.stats?.enabled === false
            ? h('div', { className: 'roost-empty' }, '图谱没启用（当前 Node 没有 node:sqlite）')
            : h('div', null,
                gp?.stats
                  ? h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 6 } },
                      `${gp.stats.entities} 个实体 · ${gp.stats.edges} 条现在成立 · ${gp.stats.ended || 0} 条已结束 · ${gp.stats.episodes} 段原始记录`)
                  : null,
                (gp?.edges || []).length
                  ? h('div', { className: 'roost-list' },
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
          n: '03', title: `她最近做过的事（${events.length}）`,
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
     * 不做「面板导入」——整包恢复只暂存到 .restore/、下次启动才生效，
     * 在面板放个按钮会让人以为点完就已经恢复了（记忆页那条注释写过这个坑）。
     *
     * 「不会带过去的」照 src/backup.js 的 SKIP / shouldSkip 实写，
     * 不凭印象编：尤其 secrets/ 是扩展长期令牌明文，必须显式说清。
     */
    function BackupTab({ mem, toast, reload, quick, busy, setTab }) {
      const backups = mem?.backups || []
      const pending = mem?.restorePending
      const shortTime = (at) => new Date(at).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })

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
            + '⚠ 包里含 config.json（里面有密钥），别外传。'
            + '导入请用命令行 node scripts/backup.mjs import <zip>：只暂存到 .restore/，下次启动 DSH 才生效，'
            + '所以面板不放导入按钮。'),
          h('button', {
            type: 'button', className: 'roost-primary',
            onClick: () => downloadBackupZip(toast, reload),
          }, '导出备份（zip）'),
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
                    : null,
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
            '整包上限 4GB、解包总量上限 512MB（防 zip 炸弹）。云备份还没做，现在只有本地导出。'),
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

    function AwakeTab({ aw, mem, sp, chats, toast, reload, reloadSp, busy, quick }) {
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

      return h('div', null,
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
         * 对话收尾（2026-11-12 从「记忆」页搬来）。
         *
         * 它决定的是「这段聊完了没有、什么时候可以再开口」，属于**开口时机**，
         * 不是「记住了什么」。放回主动搭话这一页之后，记忆页只剩纯数据。
         */
        h(Sec, {
          n: '03',
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

        h(Sec, { n: '04', title: '群聊主动（默认全关）' },
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

        h(Sec, { n: '05', title: '现在试一次' },
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
        h(Sec, { n: '06', title: '待确认的主动消息', right: h('button', { type: 'button', className: 'roost-btn', onClick: () => loadDeliv(true) }, '回查一次') },
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
                toast(r.ok ? '换好了，新的开场已经就位' : (r.why || '没换成'))
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
                h(Row, { k: '近 7 天' },
                  /**
                   * **只统计 token，不折算金额。**
                   * 订阅制、免费额度、自建模型都不按 token 收钱，
                   * 硬乘一个单价出来的美元数不是账单，只会误导。
                   */
                  `计费 ${Number(billedOf(usageInfo.total)).toLocaleString()}`
                  + ` · 输出 ${Number(usageInfo.total.output || 0).toLocaleString()}`
                  + ` · 命中 ${usageInfo.total.cacheHit == null ? '—' : usageInfo.total.cacheHit + '%'}`),
                h(Row, { k: '轮数' }, String(usageInfo.total.turns || 0)),
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
    function ConfirmModal({ title, message, confirmText, danger, busy, onConfirm, onClose }) {
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

    /** 整页弹窗：把低频但很长的页（接入向导 / 账号迁移）从页签栏里挪出来。 */
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
    }
    const scopeNote = (s) => (SCOPE_LABEL[s] ? `（${SCOPE_LABEL[s]}）` : '')
    const scopesText = (arr) => (arr || []).map((s) => s + scopeNote(s)).join('、')

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
          desc: '人常常一口气发好几句。等她说完再一起回，而不是一句一回，省调用也少刷屏。私聊、被 @、命令不等待。',
        },
          h(GRow, { label: '对方停顿多久算说完', hint: '从最后一条消息算起；太短会把一句话劈成两半' },
            h(GNum, { value: merge.waitSec ?? 1.5, min: 0.5, max: 10, step: 0.5, unit: '秒', disabled: busy,
              onSave: (v) => setMerge('waitSec', v) })),
          h(GRow, { label: '最多等多久', hint: '对方一直在发，从第一条算也最多等这么久' },
            h(GNum, { value: merge.maxSec ?? 6, min: 2, max: 30, unit: '秒', disabled: busy,
              onSave: (v) => setMerge('maxSec', v) })),
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
          desc: '静默时段里她不主动接话，但被叫到还是会回；起止填同一个数 = 关掉。忽略词是别的插件靠前缀干活的，别抢。',
        },
          h(GRow, { label: '每天几点到几点安静', hint: '跨零点也行，比如 22 点到 7 点；两个数相同 = 不设' },
            h(GNum, { value: decide.quietStartHour ?? 0, min: 0, max: 23, unit: '点', disabled: busy,
              onSave: (v) => setDecide('quietStartHour', v) }),
            h('span', { className: 'roost-g-unit' }, '到'),
            h(GNum, { value: decide.quietEndHour ?? 0, min: 0, max: 23, unit: '点', disabled: busy,
              onSave: (v) => setDecide('quietEndHour', v) })),
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
            '同时最多排几条（queueMax）、剩余时间不够就不开跑（queueMinBudgetSec）在「权限 → 她会做什么」里，两边改的是同一份配置。',
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
              onConfirm: () => act('/group/mute', { groupId: pick, targets: who, seconds }, seconds ? '已禁言' : '已解禁'),
            }),
            h('span', { className: 'd' }, who.length ? `已填 ${who.length} 人` : '还没填目标'),
          ),
        ),

        h(Sec, { n: '03', title: '踢人' },
          !info || !info.invited
            ? h('div', null,
                h('div', { className: 'roost-empty' }, '踢人需要「群管内邀」白名单，现在没开。'),
                h('div', { className: 'roost-note' },
                  '去开放平台申请通过后，在 Roost 面板（浏览器打开的那个）「配置 → 群管能力」打开。禁言不需要这个。'),
              )
            : h('div', null,
                h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 } },
                  h('input', { type: 'checkbox', checked: black, onChange: (e) => setBlack(e.target.checked) }),
                  h('span', null, '踢出去的同时拉黑（以后不能再进）'),
                ),
                h(ConfirmLink, {
                  label: '踢出',
                  confirmLabel: '确认踢出',
                  onConfirm: () => act('/group/kick', { groupId: pick, targets: who, addToBlacklist: black }, '已踢出'),
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
                          onConfirm: () => act('/group/join', { groupId: pick, action: 'approve', memberOpenid: who2, joinRequestId: rid }, '已通过'),
                        }),
                        h(ConfirmLink, {
                          label: '拒绝', confirmLabel: '确认拒绝',
                          onConfirm: () => act('/group/join', { groupId: pick, action: 'decline', memberOpenid: who2, joinRequestId: rid }, '已拒绝'),
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
        toast(r.ok ? '改写完成，备份路径在下面' : (r.error || '改写失败'))
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
      ['mood', '心情', 'effects 打开后聊天里被夸/被凶会带动心情；halfLifeHours 是回中性半衰期、baseline 是衰减落点（心情页有控件）；日常在「权限」页的高级组里点'],
      ['offpeak', '错峰', 'mode self=谷时窗口+安静期（默认）；official=官方峰时（工作日 9–12/14–18 高峰，节假日与周末全天空闲，和账单档位同一份判据）；deferHeavy 开了才把压库/过期压缩限到谷时跑；holidays 可覆盖节假日表'],
      ['usage', '用量金额', '概览的「今日花费」只折算 pricing 里有的模型（内置 DeepSeek 官方价）；键是模型名子串，值是 peak/idle 两档的 元/百万 tokens，价格会过期以官网为准'],
      ['events', '经历', 'enabled：记不记她主动做过的事（找过人、发过文件）。24 小时自动过期，只给主人私聊当素材；关着也能在「记忆」页查看和清空已有的'],
      ['profiles', '人物档案', 'enabled：要不要把对熟人的印象攒成一小段，聊天时带上。每天凌晨巩固时提炼、跨群共用，同一天里提示词不变；关着也能在「记忆」页查看和清空已有的'],
      ['compact', '上下文压缩', '两个场景的阈值、开场带几条原话'],
      ['awake', '主动说话', '清醒时段、机会分门槛、群白名单（开着时 speakUp.prompt 会当额外要求一起给）'],
      ['speakUp', '私聊排期', '主人 openid、间隔/免打扰/每日上限、followUps（说几次没回就不再追）'],
      ['closing', '收尾', '对话冷掉前自己补一句：多久算冷（coolMinutes）、盯几个会话（maxChats）、记录留几天（ttlDays）'],
      ['leakGuard', '防复读', 'enabled：她回复里整段复述了注入的记忆块，出站前删掉那几句。默认关，日常在「权限」页高级组里点'],
      ['bridge', '对外联动（实验）', 'enabled：让别的 DSH 插件通过 ctx.get("aurabot") 主动发消息、读状态；接口可能变，默认关'],
      ['model', '模型', '三层回退：byChat[chatId] > byKind.c2c / byKind.group > default > DSH 全局默认模型。'
        + 'default 是「所有聊天都用它」（面板「聊天用的模型」那张卡）。'
        + 'effort 是全局思考强度（low / high / max，空 = 不传）：哪一级显式写了 reasoningEffort 就以它为准。'
        + '真正下传前会先问 DSH 这个模型支持哪几档，不支持就不传，避免整轮直接报错'],
      ['persona', '人格', '当前用哪个人格、按群指定；换人格去「人格」页点「用这个」'
        + '（name / text 是 0.10.0 之前的旧字段，只在人格文件读不出正文时才兜底）'],
      ['stickers', '表情包', '图放哪、要不要注入'],
      ['permissions', '权限', '主人/管理员/成员各能用什么工具'],
      ['qqTools', 'QQ 工具', '给 AI 的工具总开关、单次最多分几段发（maxParts）'],
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
      ['update', '更新源', 'npm 源（registry）；留空用默认源'],
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

      /**
       * 读检查结果。
       *
       * 默认只读**后台快照**（插件启动 10 秒后查一次、之后 6 小时一次），
       * 所以进设置页不会卡在 registry 的 8 秒超时上；`force` 才是真的重查。
       */
      const loadCheck = async (force) => {
        const r = await get('/update/check' + (force ? '?force=1' : ''))
        setInfo(r && r.ok !== false ? r : { ok: false, own: r?.own || '', error: r?.error || '查不到', canSelf: false })
        setAt(new Date().toLocaleTimeString())
      }
      const loadRepo = async () => {
        try {
          const r = await get('/personas/repo')
          if (r.ok !== false) setRepo(r)
        } catch {}
      }
      useEffect(() => { loadCheck(); loadRepo() }, [])

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

      return h(Sec, {
        n: '01', title: '更新',
        right: h('button', { type: 'button', className: 'roost-btn', onClick: () => { loadCheck(true); loadRepo() } }, '重新检查'),
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
                      ? '装完要重启 DSH 才生效。'
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
    function FeedbackCard({ toast }) {
      const [copied, setCopied] = useState(false)
      const group = '1130901545'

      return h(Sec, { n: '02', title: '交流反馈群' },
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
        setName(r.configured?.name || '')
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
            className: 'roost-input', value: name, placeholder: '名字（留空=跟目录名）',
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
              const r = await post('/workspace/rename', { title: name.trim() || 'workspace' })
              if (r.ok === false) return toast(r.message || '没改成')
              toast('工作区已改名')
              await load()
            }),
          }, '改名'),
        ),
        h('div', { className: 'roost-note', style: { marginTop: 6 } },
          '换目录只影响之后新建的会话；已经在跑的会话仍挂在旧工作区。'),
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
        title: '表情包',
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
    const EXT_POST = (op, arg) => post('/quick', { op, arg, chatId: '' })
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
      const [revokeAsk, setRevokeAsk] = useState(null)
      const [market, setMarket] = useState(null)
      const [marketBusy, setMarketBusy] = useState('')
      const loadMarket = async (refresh = false) => {
        setMarketBusy('list')
        try {
          const r = await EXT_POST('extensions.market.list', { refresh })
          setMarket(r)
          if (!r.ok) toast(r.message || '市场索引拉取失败')
        } finally { setMarketBusy('') }
      }
      const marketAct = async (op, id) => {
        setMarketBusy(id)
        try {
          let r = await EXT_POST(op, { id })
          /**
           * 扩展索要敏感权限（`say:write` / `proactive:write` 之类）：后端**不肯**
           * 直接装，回 `needs_scope_confirm`。这里必须把「要授什么」摆出来让用户
           * 点第二次，绝不自动带 `confirmScopes:true` 重试 —— 那样等于一键装顺带授权。
           */
          if (r?.reason === 'needs_scope_confirm') {
            /** 把「要授什么」摆出来等用户点第二次，绝不在这里自动重试 */
            setScopeAsk({ op, id, scopes: r.scopes || [] })
            return
          }
          toast(r.message || (r.ok ? '完成' : '失败'))
          await load()
          if (market) await loadMarket(true)
        } finally { setMarketBusy('') }
      }
      const confirmScopeAct = async () => {
        const ask = scopeAsk
        if (!ask) return
        setScopeBusy(true)
        try {
          const r = await EXT_POST(ask.op, { id: ask.id, confirmScopes: true })
          toast(r.message || (r.ok ? '完成' : '失败'))
          await load()
          if (market) await loadMarket(true)
        } finally {
          setScopeBusy(false)
          setScopeAsk(null)
        }
      }
      const checkUpdates = async () => {
        setMarketBusy('updates')
        try {
          const r = await EXT_POST('extensions.market.updates', {})
          const rows = r?.rows || []
          toast(rows.length ? `${rows.length} 个扩展有新版` : (r?.ok === false ? (r.message || '检查失败') : '都是最新版'))
          await loadMarket(true)
        } finally { setMarketBusy('') }
      }
      const revokeMarket = async (id) => {
        setMarketBusy(id)
        try {
          const r = await EXT_POST('extensions.market.revoke', { id, reason: 'panel' })
          toast(r.message || (r.ok ? '已停用' : '停用失败'))
          await load()
          await loadMarket(true)
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
      useEffect(() => { load(); loadMarket() }, [])
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
          onClick: () => { load(); loadMarket(true) },
        }, '刷新'),
      },
        ...(showMarket ? [
        h('div', { className: 'roost-note' },
          data?.enabled
            ? '总开关：开 —— 扩展说明会进 QQ 会话提示词。'
            : '总开关：关 —— 清单还在、已发令牌照常，只是不挂 usage section。去「权限 → 高级 · 新功能」打开「用户扩展」。'),
        data?.status?.authFailed
          ? h('div', { className: 'roost-note', style: { color: 'var(--bad)' } },
              `⚠ ${data.status.hintAuthFailed}：有扩展鉴权失败，检查令牌是否被吊销或凭据缺失。`)
          : null,
        data?.status?.regenerated
          ? h('div', { className: 'roost-note', style: { color: 'var(--warn)' } },
              `✓ ${data.status.hintRegenerated}：备份还原后 secrets 缺失，宿主已补发新令牌；旧令牌立即 401。`)
          : null,
        h('div', { className: 'roost-note', style: { marginTop: 8 } },
          '从插件市场安装或更新扩展。',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: marketBusy === 'list',
              onClick: () => loadMarket(true),
            }, marketBusy === 'list' ? '拉取中…' : '刷新市场'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: !!marketBusy,
              onClick: checkUpdates,
            }, marketBusy === 'updates' ? '检查中…' : '检查更新'),
            market?.repo ? h('span', { className: 'roost-code' }, `${market.repo}@${market.branch}`) : null,
          ),
          market && !market.ok
            ? h('div', { style: { color: 'var(--bad)', marginTop: 4 } }, market.message || '索引拉取失败')
            : null,
          (market?.rows || []).length
            ? h('div', { className: 'roost-list', style: { marginTop: 6 } },
                market.rows.map((x) => h('div', { key: x.id, className: 'ext-row' },
                  h('span', { className: 't' },
                    `${x.name} · ${x.id}`,
                    h('span', { className: 'd' }, ` · ${x.transport}${x.author ? ` · ${x.author}` : ''}`),
                    x.revoked ? h('span', { className: 'd', style: { color: 'var(--bad)' } }, ' · 已撤回') : null,
                    x.updateAvailable ? h('span', { className: 'd', style: { color: 'var(--warn)' } }, ' · 有更新') : null,
                  ),
                  x.description ? h('span', { className: 'd' }, x.description) : null,
                  x.revoked
                    ? h('span', { className: 'd' }, '拒绝安装')
                    : h('button', {
                        type: 'button', className: 'roost-btn', style: { marginTop: 6 },
                        disabled: marketBusy === x.id || x.foreign || !!scopeAsk || !!revokeAsk,
                        onClick: () => marketAct('extensions.market.install', x.id),
                      }, x.foreign ? '用户手写 · 不覆盖' : x.installed ? (x.updateAvailable ? '更新' : '重装') : '安装'),
                  x.installed && !x.foreign
                    ? h(ConfirmLink, {
                        label: '卸载', confirmLabel: '确认卸载',
                        disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                        onConfirm: () => marketAct('extensions.market.remove', x.id),
                      })
                    : null,
                  x.installed && !x.foreign && !x.revoked
                    ? h('button', {
                        type: 'button', className: 'roost-btn', style: { marginTop: 6, marginLeft: 6 },
                        disabled: marketBusy === x.id || !!scopeAsk || !!revokeAsk,
                        onClick: () => setRevokeAsk(x.id),
                      }, '停用')
                    : null,
                )),
              )
            : (market ? h('div', { className: 'roost-empty' }, '市场里还没有扩展条目。') : null),
        ),
        ] : []),
        ...(showInstalled ? [
        h('div', { className: 'roost-diag-h', style: { marginTop: 12 } }, '已装扩展'),
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
          : h('div', { className: 'roost-empty' }, '扩展目录里还没有东西。'),
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
              title: '扩展索要敏感权限',
              message: `扩展「${scopeAsk.id}」索要：\n\n${scopesText(scopeAsk.scopes)}`
                + '\n\n授权后它能以机器人身份执行对应动作（发消息 / 主动发言等）。确认安装？',
              confirmText: '授权并安装', danger: true, busy: scopeBusy,
              onClose: () => {
                if (scopeBusy) return
                setScopeAsk(null)
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

    /** 接入页：发放带 agent:write 的客户端令牌（阶段 3 缺口 2 的落点）。 */
    function ExtClientsBlock({ toast }) {
      const [data, setData] = useState(null)
      const [name, setName] = useState('')
      /** §7 最小授权：默认一个 scope 都不给，高权限要单独勾 + 二次确认。 */
      const [scopes, setScopes] = useState([])
      const [confirm, setConfirm] = useState(false)
      const [issued, setIssued] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = async () => setData(await EXT_POST('extensions.clients.list'))
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
      return h(Sec, { title: '扩展 /v1 客户端令牌' },
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
          '我确认授予高权限 scope（agent:write / say:write / prompt:write / proactive:write）',
        ),
        issued
          ? h('div', { className: 'roost-note', style: { color: 'var(--ok)' } },
              `只显示这一次：${issued.id} / ${issued.token}`,
              h('br'),
              '把它填到扩展的启动环境里；刷新页面后就再也读不出来了。')
          : null,
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
    function ExpressTab({ config, stickers, saveCfg, toast, reload, part = 'all' }) {
      return h('div', null,
        part === 'sticker' ? null : h(TtsCard, { config, saveCfg, toast, reload }),
        /** 独立成页时它是这一页的第 01 节；留在表达页时仍是 02（排在语音后面） */
        part === 'voice' ? null : h(StickerDirsCard, {
          config, stickers, saveCfg, toast, reload,
          n: part === 'sticker' ? '01' : '02',
        }),
        part === 'voice'
          ? h('div', { className: 'roost-note' }, '表情包在「表达 → 表情包」那一页。')
          : null,
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
          row('当前版本', ver?.current || ver?.version || '（没读到，稍后刷新）'),
          ver?.latest ? row('最新版本', ver.latest + (ver.hasUpdate ? '（有新版，去「更新」页装）' : '（已是最新）')) : null,
        ),
        h(Sec, { n: '02', title: '仓库与许可' },
          row('GitHub', h('a', { href: 'https://github.com/tdcq9594/dsh-roost', target: '_blank', rel: 'noreferrer' }, 'tdcq9594/dsh-roost')),
          row('Gitee', h('a', { href: 'https://gitee.com/tdcq9594/dsh-roost', target: '_blank', rel: 'noreferrer' }, 'tdcq9594/dsh-roost')),
          h('div', { className: 'roost-note' },
            '永久免费，禁止收费与商业使用（自写协议 v2.0，非 OSI 许可）。'
            + '框架本体是 qq-bot-roost，这一层是把它接进 DSH 的插件。'),
        ),
        h(Sec, { n: '03', title: '交流反馈群' },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', null, 'QQ 群 1130901545'),
            h('button', { type: 'button', className: 'roost-btn', onClick: () => copy('1130901545') }, '复制群号'),
          ),
          h('div', { className: 'roost-note' }, '出问题先看「排障」页的日志，再来群里问。'),
        ),
      )
    }

    /** 模型：聊天用哪个、按聊天单独选、清单里有什么。原来是「设置」里最上面那块。 */
    function ModelTab({ toast, currentChatId, config, saveCfg }) {
      return h(ModelBlock, { toast, currentChatId, config, saveCfg })
    }

    /** 更新：版本与更新说明 + 反馈群。属于「这台机器怎么维护」，不跟聊天设置混。 */
    function UpdateTab({ toast }) {
      return h('div', null,
        h(UpdatesBlock, { toast }),
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
    function ExtTab({ quick, toast }) {
      return h('div', null,
        h(ExtSettingsBlock, { toast, part: 'installed' }),
        h(ExtCapsBlock, { quick, toast }),
      )
    }

    /** 市场：能装什么、装 / 更新 / 停用 */
    function ExtMarketTab({ toast }) {
      return h(ExtSettingsBlock, { toast, part: 'market' })
    }

    /** 接口：给独立会话发 /v1 客户端令牌 */
    function ExtApiTab({ toast }) {
      return h(ExtClientsBlock, { toast })
    }

    function LogsTab({ logs }) {
      const tone = (lv) => (lv === 'error' ? 'var(--bad)' : lv === 'warn' ? 'var(--warn)' : 'var(--ok)')

      return h(Sec, { n: '01', title: '最近的动静', right: h('span', { className: 'roost-note', style: { margin: 0 } }, '每 3 秒刷新') },
        logs === null
          ? h('div', { className: 'roost-empty' }, '读着…')
          : logs.length === 0
            ? h('div', { className: 'roost-empty' }, '还没有日志')
            : h('div', { className: 'roost-list roost-scroll' },
                logs.slice().reverse().map((e, i) =>
                  h('div', { key: i, className: 'roost-item' },
                    h('span', { className: 'd' }, e.time),
                    h('span', { style: { flex: '0 0 4px', height: 4, borderRadius: 2, background: tone(e.level), marginTop: 7 } }),
                    h('span', { className: 't', style: { opacity: e.level === 'error' ? 1 : 0.86 } }, e.text),
                  ),
                ),
              ),
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
     *  接入、账号迁移整页收进弹窗（概览「去接入」、设置页底部按钮打开）；
     *  扩展独立成「扩展」页：档位 / 说明编辑 / 客户端令牌一处走完，
     *    不跟工具白名单挤在「能力」里，也不用跨三页。
     *
     * **隐藏页签仍可直接到达**：`chats / context / setup / account` 保留为可直接进入的页，
     * 老 `localStorage['roost.tab']` 存着它们时照常渲染原页，功能与位置都不丢。
     * 2026-11-12：这一排不再直接铺 8 个按钮，改成「一级分组 + 二级页面」两层
     * （见下面的 `NAV_GROUPS`）。`TABS` 仍然是**唯一的页面清单**，两层只决定怎么分组、
     * 不决定有哪些页面——新增一页先加到这里，再决定归哪个组。
     */
    const TABS = [
      ['overview', '概览'],
      /* 人设：她是谁、心情如何、什么时候开口、记得什么 */
      ['her', '人格'],
      ['mood', '心情'],
      ['awake', '主动搭话'],
      ['memory', '记忆'],
      /* 2.3：人物是记忆页那三块（档案/关系/经历）的并列入口，不是搬家 */
      ['people', '人物'],
      /* 能力：她能干什么 */
      ['caps', '权限'],
      ['express', '语音'],
      ['stickers', '表情包'],
      ['model', '模型'],
      /* 扩展：独立成组，和 aurabot 的「模块」对齐 */
      ['ext', '已安装'],
      ['ext-market', '市场'],
      ['ext-api', '接口'],
      /* 群聊：策略在前、动手管人在后 */
      ['groupchat', '群聊策略'],
      ['groupadmin', '群管'],
      /* 系统：这台机器怎么跑 */
      ['chats', '会话'],
      ['logs', '排障'],
      ['update', '更新'],
      ['config', '设置'],
      /* 2.3：备份从记忆页里长出一个正门，记忆页那块原地保留 */
      ['backup', '备份'],
      ['about', '关于'],
    ]
    /**
     * `chats` 原来是隐藏页，2026-11-12 提升成「身份」：它本来就是
     * 「QQ 会话 ↔ DSH 会话」的映射表，不给入口只能从记忆页绕进去。
     */
    const HIDDEN_TABS = ['context', 'setup', 'account']
    const ALL_TABS = TABS.map(([id]) => id).concat(HIDDEN_TABS)

    /**
     * 两层导航：一级是分组（带图标），二级是组内页面。
     *
     * 为什么现在分：8 个页签平铺一排，窄侧栏里正好挤满一行，再加一页就只能换行，
     * 变成两排一样重的按钮、分不清主次。分组之后一级只有 4 个，加页只影响组内。
     *
     * 分组参照 aurabot 的「概览 / 人设 / 表达 / 平台 / 系统」思路，按我们的页面裁剪：
     * 概览单独成组（只有一页，不渲染二级行），其余按「人设 / 能力 / 系统」收。
     * **tab 的 key 一个都不改**，老 `localStorage['roost.tab']` 照样落回原来那页，
     * 隐藏页（chats/context/setup/account）不进口分组，仍靠 `roost-nav-current` 标记位置。
     */
    const NAV_GROUPS = [
      { id: 'home', label: '概览', icon: 'M3 10.5 12 3l9 7.5M5.5 9v11.5h13V9M10 20.5v-6h4v6', tabs: ['overview'] },
      { id: 'self', label: '人设', icon: 'M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5zM4.5 20.5c.9-3.6 3.9-5.5 7.5-5.5s6.6 1.9 7.5 5.5', tabs: ['her', 'mood', 'awake', 'memory', 'people'] },
      /* 表达：她怎么"出声"——说话（语音合成）与表情包。2026-11-13 从「能力」里独立出来 */
      { id: 'express', label: '表达', icon: 'M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.4A8 8 0 1 1 20.5 11.5zM9 13.2s1.1 1.5 3 1.5 3-1.5 3-1.5M9.5 9.6h.01M14.5 9.6h.01', tabs: ['express', 'stickers'] },
      /**
       * 群聊：两页都在才开组（单页组不渲染二级行，导航里看不到页名反而迷惑）。
       * 2026-11-13 群聊策略页做出来后，群管从「系统」搬过来。
       */
      { id: 'group', label: '群聊', icon: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM15.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M3 19c.7-2.6 3-4 6-4s5.3 1.4 6 4M15 15.2c2 .2 3.5 1.4 4 3.3', tabs: ['groupchat', 'groupadmin'] },
      { id: 'power', label: '能力', icon: 'M12 3.2 4.8 6v5.6c0 4.4 3 7.7 7.2 9.2 4.2-1.5 7.2-4.8 7.2-9.2V6L12 3.2zM8.8 12l2.2 2.2 4.2-4.4', tabs: ['caps', 'model'] },
      { id: 'mods', label: '扩展', icon: 'M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5.5 12.5V20h13v-7.5M10 20v-4.5h4V20', tabs: ['ext', 'ext-market', 'ext-api'] },
      { id: 'system', label: '系统', icon: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4', tabs: ['chats', 'logs', 'update', 'config', 'backup', 'about'] },
    ]
    /** 当前页属于哪一组；隐藏页不属于任何组，返回 null */
    const navGroupOf = (id) => NAV_GROUPS.find((g) => g.tabs.includes(id)) || null
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
      : ({ children }) => children

    function RoostPage() {
      useStyle()
      /**
       * 记住上次停在哪一页。
       *
       * 习惯上仪表盘会记位置：关掉再打开还回到刚才那页，
       * 而不是每次都弹回概览让人重新点。localStorage 不可用时静默退回概览。
       */
      const [tab, setTabState] = useState(() => {
        try {
          const last = localStorage.getItem('roost.tab')
          /** 老用户存着 'market'：并进「人格」了，别让他打开就是概览 */
          const alias = last === 'market' ? 'her' : last
          return ALL_TABS.includes(alias) ? alias : 'overview'
        } catch {
          return 'overview'
        }
      })
      /** 接入 / 账号迁移是整页弹窗：不占页签，也不写「上次停留」 */
      const [pageModal, setPageModal] = useState(null)
      const setTab = useCallback((id) => {
        if (id === 'setup' || id === 'account') { setPageModal(id); return }
        setPageModal(null)
        setTabState(id)
        try { localStorage.setItem('roost.tab', id) } catch {}
      }, [])
      /**
       * 每组记住最后看的那页：点一级分组回到那页，而不是每次都跳组内第一页。
       *
       * 单独存一份、不塞进 `roost.tab`：全局的「上次停留」只有一个，
       * 再拆一层才记得住「上次在能力组看的是扩展」。
       */
      const [navLast, setNavLast] = useState(() => {
        try { return JSON.parse(localStorage.getItem('roost.navlast') || '{}') || {} } catch { return {} }
      })
      useEffect(() => {
        const g = navGroupOf(tab)
        if (!g || navLast[g.id] === tab) return
        const next = { ...navLast, [g.id]: tab }
        setNavLast(next)
        try { localStorage.setItem('roost.navlast', JSON.stringify(next)) } catch {}
      }, [tab, navLast])
      /** 点分组：优先回该组上次那页；存着已下线的 key 时退回组内第一页 */
      const openGroup = useCallback((g) => {
        const want = navLast[g.id]
        setTab(g.tabs.includes(want) ? want : g.tabs[0])
      }, [navLast, setTab])
      /** 日志统一拉一次：概览显示最近 6 条，排障页显示全量，别两处各起一个轮询 */
      const [logs, setLogs] = useState(null)
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
        const t = setInterval(load, 3000)
        return () => { alive = false; clearInterval(t) }
      }, [tab])

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
      const [ch, setCh] = useState(null)
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

      const loadSetupMeta = useCallback(async () => {
        const [a, b] = await Promise.all([get('/registrations'), get('/channels')])
        setReg(a.ok === false ? null : a)
        setCh(b.ok === false ? null : b)
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
      }, [mem])

      /**
       * 能力页：一次拉两份——策略本体 + 四个档位的试算。
       *
       * 试算放服务端算（`capabilities.preview`），用的是和真实生效同一个
       * `resolvePolicy()`。前端自己展开 `*` / `group:x` 的话，迟早和后台算出两套结果，
       * 那就是"面板说没有、实际有"这类最伤信任的 bug。
       */
      const loadCaps = useCallback(async () => {
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
      /** 当前页所属分组；隐藏页不属于任何组，`curGroup` 为 null（一级不高亮、二级不显示） */
      const curGroup = navGroupOf(tab)
      const groupTabs = curGroup ? TABS.filter(([id]) => curGroup.tabs.includes(id)) : []

      /**
       * 首次接入向导：新装 / 升级后 `needed=true`，整棵面板树都不挂，
       * 只留全屏向导（照 aurabot `showWizard ? h(Wizard) : null` 的做法）。
       * 这样老配置在没重新接入前不会给人一种「一切正常」的错觉。
       * 跳过后后端仍返回 needed=false，但概览页会把未接入状态一直显示着。
       */
      if (st?.wizard?.needed) {
        return h('div', { className: 'roost-root' },
          h(SetupWizard, {
            st,
            toast,
            onDone: loadStatus,
            reload: loadStatus,
          }),
        )
      }

      return h('div', { className: 'roost-root' },
        h('div', { className: 'roost-head' },
          h('div', { className: 'roost-head-inner' },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('div', { className: 'roost-title-lg' }, 'Roost'),
            st
              ? h(Pill, { tone: st.listening ? 'ok' : 'bad' }, st.listening ? `:${st.actualPort || st.port}` : '端口没起')
              : null,
            ch?.current ? h(Pill, null, '通道 ' + ch.current) : null,
          ),
          h('div', { className: 'roost-note roost-sub' }, 'QQ 消息从这里交给 DSH 会话回答。'),

          h('div', { className: 'roost-nav' },
            h('div', {
              className: 'roost-nav-top',
              role: 'tablist',
              'aria-label': 'Roost 功能分组',
              /* 行内再写一次 wrap：页签条的溢出行为是硬约束（见测试），
                 不能只靠类名——将来有人改 CSS 时这一条还在 */
              style: { display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', padding: '6px 0 0' },
            },
              NAV_GROUPS.map((g) => {
                const on = curGroup && curGroup.id === g.id
                /** 悬浮提示把组内页面列出来：只看「能力」猜不到里面有扩展 */
                const names = g.tabs
                  .map((id) => (TABS.find((row) => row[0] === id) || [, id])[1])
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
              ? h('div', { className: 'roost-nav-sub', role: 'tablist', 'aria-label': curGroup.label },
                  groupTabs.map(([id, label]) => h('button', {
                    key: id, type: 'button',
                    className: 'roost-tab',
                    role: 'tab',
                    'aria-selected': tab === id ? 'true' : 'false',
                    'data-on': tab === id ? '1' : '0',
                    onClick: () => setTab(id),
                  }, label)))
              : null,
            /** 隐藏页标记放两个 tablist 外面：tablist 的 owned element 必须是 role=tab，
                放外面既能保住 aria-current 的读屏语义，也不破坏 tablist 结构。 */
            HIDDEN_TABS.includes(tab)
              ? h('div', { className: 'roost-nav-sub' },
                  h('span', { className: 'roost-nav-current', 'aria-current': 'page' },
                    ({ context: '上下文', setup: '接入', account: '账号迁移' })[tab] || tab))
              : null,
            ),
          ),
        ),

        h('div', {
          className: 'roost-scroll-body roost-fade' + (pageModal ? ' is-locked' : ''),
          key: tab,
        },
          h('div', { className: 'roost-body-inner' },
          tab === 'overview' ? h(OverviewTab, { st, setupSt, toast, reload: loadStatus, busy, run, onGo: setTab, logs }) : null,
          tab === 'setup' ? h(SetupTab, { st: setupSt, reload: loadStatus, toast, busy, run, reg, onSaved: loadSetupMeta, saveCfg }) : null,
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
          tab === 'ext' ? h(ExtTab, { quick, toast }) : null,
          tab === 'ext-market' ? h(ExtMarketTab, { toast }) : null,
          tab === 'ext-api' ? h(ExtApiTab, { toast }) : null,
          tab === 'memory' ? h(MemoryTab, { mem, toast, reload: loadMemory, quick, busy, onPickChat: pickChat, setTab }) : null,
          /** 2.3：与记忆页并列的两个入口，同一份 mem，不复制状态 */
          tab === 'people' ? h(PeopleTab, { mem, toast, reload: loadMemory, quick, busy, setTab }) : null,
          tab === 'backup' ? h(BackupTab, { mem, toast, reload: loadMemory, quick, busy, setTab }) : null,
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
          tab === 'update' ? h(UpdateTab, { toast }) : null,
          tab === 'awake'
            ? h(AwakeTab, {
                aw, mem, sp, chats,
                toast, reload: loadAwake, reloadSp: loadAwake, busy, quick,
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
                      onClick: () => setPageModal('account'),
                    }, '账号迁移…'),
                    h('button', {
                      type: 'button', className: 'roost-btn',
                      onClick: () => { setTab('memory'); toast('已切到「记忆」，清空在「06 清空」') },
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
                      onClick: () => { setTab('mood'); toast('已切到「心情」，清空在「02 变化记录」') },
                    }, '清空心情历史…'),
                  ),
                ),
              )
            : null,
          tab === 'logs'
            ? h('div', { className: 'roost-diag' },
                h(LogsTab, { logs }),
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
        pageModal === 'account'
          ? h(PageModal, { title: '账号迁移', onClose: () => setPageModal(null) },
              h(AccountTab, { toast }))
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
    return module.exports
  },
})
