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
          return JSON.parse(text);
        } catch {
          return { ok: false, message: `插件回的不是 JSON（HTTP ${r.status}，${p}）：${text.slice(0, 80)}` };
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
/* 页头：标题 + 通道 + 页签，永远在、不参与滚动 */
.roost-head{flex:0 0 auto;width:100%;max-width:860px;box-sizing:border-box;padding:18px 22px 0}
/* 唯一的滚动区。滚动条要看得见、拖得动，但别太抢眼 */
.roost-scroll-body{flex:1 1 auto;min-height:0;width:100%;max-width:860px;box-sizing:border-box;
  padding:16px 22px 40px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;
  /* 滚动元素本身也带一层底色：它的层先画，再画子内容 */
  background:var(--dsw-alias-bg-base, #16181c)}
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
  padding:5px 12px;border-radius:7px;border:1px solid var(--line);background:transparent;
  color:inherit;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;
  transition:background .14s ease,border-color .14s ease;
}
.roost-btn:hover:not(:disabled){background:var(--hover)}
.roost-btn:active:not(:disabled){transform:translateY(1px)}
.roost-btn:disabled{opacity:.4;cursor:not-allowed}
.roost-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.roost-primary{
  padding:7px 16px;border-radius:7px;border:1px solid transparent;
  background:var(--dsw-alias-button-primary-fill, var(--accent));
  color:var(--dsw-alias-label-primary-foreground, #fff);
  cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;
  transition:filter .14s ease;
}
.roost-primary:hover:not(:disabled){filter:brightness(1.08)}
.roost-primary:disabled{opacity:.55;cursor:not-allowed}
.roost-input{
  width:100%;box-sizing:border-box;padding:7px 10px;border-radius:7px;
  border:1px solid var(--line);background:var(--field);color:inherit;font:inherit;font-size:13px;
}
.roost-input::placeholder{opacity:.5}
.roost-input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
/* select 的原生弹层不跟深色主题走：--field 是半透明的（9% currentColor），
   弹层里合成到系统白底上，再加 color:inherit（深色主题下是浅色字），
   结果就是**选项文字隐形**——只能看见被系统高亮的那一条，其余是空白行。
   弹层由系统绘制，拿不到我们的变量，必须给不透底的显式颜色。 */
select.roost-input{color-scheme:dark}
.roost-input option{background:#1c1d22;color:#e9eaee}
.roost-tab{
  padding:8px 13px;border:none;border-bottom:2px solid transparent;background:transparent;
  color:inherit;opacity:.58;cursor:pointer;font:inherit;font-size:12.5px;margin-bottom:-1px;
  transition:opacity .14s ease,border-color .14s ease;
}
.roost-tab:hover{opacity:.88}
.roost-tab:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.roost-tab[data-on="1"]{opacity:1;font-weight:600;border-bottom-color:var(--accent)}

.roost-sec{margin:22px 0 0}
.roost-sec:first-child{margin-top:2px}
.roost-sec-h{display:flex;align-items:baseline;gap:9px;margin-bottom:10px}
.roost-sec-n{font-size:10.5px;opacity:.4;font-variant-numeric:tabular-nums}
.roost-sec-t{font-size:13px;font-weight:600;letter-spacing:.01em;flex-shrink:0}
.roost-sec-h::after{content:'';flex:1;height:1px;background:var(--line-soft);transform:translateY(-2px)}
.roost-note{font-size:11.5px;line-height:1.62;color:var(--dsw-alias-label-tertiary, inherit);margin-top:4px}
.roost-empty{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-tertiary, inherit);padding:4px 0}
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
.roost-scroll{max-height:320px;overflow:auto}
/* 人格行：左两行文字、右一排动作。窗口窄时优先保住名字 */
.roost-persona{align-items:flex-start;padding:9px 0}
.roost-acts{flex:0 0 auto;display:flex;gap:6px;align-items:center}

/* ── 概览用的统计块与故障条 ── */
.roost-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:9px}
.roost-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:9px;
  border:1px solid var(--line-soft);background:var(--surface)}
.roost-stat b{font-size:19px;font-weight:650;letter-spacing:-.02em;line-height:1.25;
  font-variant-numeric:tabular-nums}
.roost-stat span{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);line-height:1.4}
.roost-banner{display:flex;flex-direction:column;gap:3px;padding:10px 12px;margin-bottom:12px;
  border-radius:9px;border:1px solid var(--line-soft);background:var(--surface)}
.roost-banner.bad{border-color:color-mix(in srgb,var(--bad) 45%,transparent);
  background:color-mix(in srgb,var(--bad) 9%,transparent)}
.roost-banner b{font-size:12.5px;font-weight:600}
.roost-banner i{font-style:normal;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary,inherit)}

/* ── 开关 / 芯片 / 单条记忆 / 文字链接 ── */
.roost-switch{position:relative;width:32px;height:18px;border-radius:9px;border:1px solid var(--line);
  background:var(--field);cursor:pointer;padding:0;flex:0 0 auto;
  transition:background .16s ease,border-color .16s ease}
.roost-switch::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;
  background:var(--dsw-alias-label-secondary,currentColor);
  transition:transform .16s cubic-bezier(.2,.8,.2,1),background .16s ease}
.roost-switch[data-on="1"]{background:var(--accent);border-color:var(--accent)}
.roost-switch[data-on="1"]::after{transform:translateX(14px);background:#fff}
.roost-switch:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.roost-chip{padding:3px 10px;border-radius:20px;border:1px solid var(--line-soft);background:transparent;
  color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .14s,border-color .14s}
.roost-chip:hover{background:var(--hover)}
.roost-chip[data-on="1"]{border-color:var(--accent);font-weight:600;
  background:color-mix(in srgb,var(--accent) 14%,transparent)}
.roost-fact{display:flex;gap:8px;align-items:flex-start;padding:5px 0;font-size:12.5px;
  border-top:1px solid var(--line-soft)}
.roost-fact:first-child{border-top:none}
.roost-fact span{flex:1;min-width:0;word-break:break-word}
.roost-fact-x{flex:0 0 auto;border:none;background:transparent;color:inherit;opacity:.42;cursor:pointer;
  font:inherit;font-size:14px;line-height:1;padding:2px 5px;border-radius:5px}
/* 删除只在鼠标移到这一行时才显眼：平时淡到几乎看不见，避免误点 */
.roost-fact:hover .roost-fact-x,.roost-fact-x:focus-visible{opacity:.75}
.roost-fact-x:hover{opacity:1;color:var(--bad);background:var(--hover)}
.roost-fact-x:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
@media (hover:none){.roost-fact-x{opacity:.6}}
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

    /** 分节标题：序号 + 标题 + 一条细线。整个面板的排版骨架 */
    const Sec = ({ n, title, children, right }) =>
      h('div', { className: 'roost-sec' },
        h('div', { className: 'roost-sec-h' },
          n ? h('span', { className: 'roost-sec-n' }, n) : null,
          h('span', { className: 'roost-sec-t' }, title),
          right ? h('span', { style: { marginLeft: 'auto' } }, right) : null,
        ),
        children,
      )

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
    const Bar = ({ v, bi }) => {
      const val = Math.max(-1, Math.min(1, Number(v) || 0))
      const pct = bi ? Math.round(((val + 1) / 2) * 100) : Math.round(Math.max(0, val) * 100)
      const w = bi ? Math.abs(val) * 50 : Math.max(0, val) * 100
      const left = bi ? (val >= 0 ? 50 : 50 - w) : 0
      return h('div', {
        className: 'roost-bar' + (bi ? ' is-bi' : ''),
        role: 'img',
        'aria-label': `${pct}%`,
        title: `${pct}%（只读，情绪由她自己变）`,
      }, h('i', { style: { marginLeft: left + '%', width: w + '%' } }))
    }

    /** 情绪三项的读法：数字是内部量，人看的是词 */
    const MOOD = [
      { key: 'valence', label: '心情', bi: true, words: ['很糟', '不太好', '一般', '还行', '不错'] },
      { key: 'energy', label: '精力', bi: false, words: ['很累', '有点累', '一般', '有精神', '很活跃'] },
      { key: 'sociability', label: '想说话', bi: false, words: ['不想理人', '有点闷', '一般', '想聊', '很想说'] },
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

    /** 概览上的一个数字格 */
    const Stat = ({ n, label, tone }) =>
      h('div', { className: 'roost-stat' },
        h('b', {
          style: tone === 'bad' ? { color: 'var(--bad)' } : tone === 'ok' ? { color: 'var(--ok)' } : null,
        }, n),
        h('span', null, label),
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
            'ai-chat 推过来的消息会全部失败。'
            + (st.serverError ? `原因：${st.serverError}。` : '')
            + ' 常见是端口被占或上一轮没退干净——重启 DSH 让端口释放。'))
      }
      if (!st.chats) {
        return h('div', { className: 'roost-banner' },
          h('b', null, '还没有会话接进来。'),
          h('i', null, '在群里说一句话就会自动建一个；也可以先跑一次自测。'))
      }
      if (lt && !lt.ok) {
        return h('div', { className: 'roost-banner bad' },
          h('b', null, '最近一轮失败了。'),
          h('i', null, `${lt.error || '未知错误'} —— 细节看「日志」。`))
      }
      return null
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
    function portView(st, gotUrl) {
      const actual = st?.actualPort || 0
      const want = actual ? `http://127.0.0.1:${actual}` : ''
      if (!want) {
        const down = st?.listening === false
        return {
          kind: 'unknown',
          cell: down ? '没在听' : '—',
          text: down
            ? 'dsh-roost 还没在听（端口没起来），等它起来再对。'
            : '还没拿到实际端口，点右上「刷新」再看。',
        }
      }
      const cell = st.wantPort && st.wantPort !== actual
        ? `${actual}（配置 ${st.wantPort}，被占了）`
        : String(actual)
      if (!gotUrl) {
        return { kind: 'unset', cell, wantUrl: want, text: 'ai-chat 还没配好，消息推不过来 —— 去「接入」第 5 步。' }
      }
      if (gotUrl === want) return { kind: 'ok', cell, wantUrl: want, text: '✓ 两端一致，链路通' }
      return {
        kind: 'bad',
        cell,
        wantUrl: want,
        // `action: 'sync'` 是给渲染层看的：这种情况配一个「现在就改过来」按钮
        action: 'sync',
        text: `✗ 对不上：ai-chat 指向 ${gotUrl}，我们监听 ${want}。消息会推到没人听的端口上。`,
      }
    }

    function OverviewTab({ st, setupSt, toast, reload, busy, onGo }) {
      const [logs, setLogs] = useState(null)
      /** 「现在就改过来」按钮的忙碌态，和外面的 busy（自测）分开 */
      const [syncing, setSyncing] = useState(false)
      const perms = st?.permissions || {}
      const toolable = ['owner', 'admin', 'member'].filter((k) => perms[k] === 'all')
      const lt = st?.lastTurn

      /** 概览上的最近动态：不用切到日志页就能看到刚刚发生了什么 */
      useEffect(() => {
        let alive = true
        const load = () => get('/logs?limit=6').then((r) => alive && setLogs(r.ok === false ? [] : r.entries || []))
        load()
        const t = setInterval(load, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      /**
       * 接入进度用**真实字段**推，不再靠一个后端不存在的 `steps`。
       * 五点全部来自 `/setup`：装好 → 有机器人 → 在跑 → 插件装了 → 已指向我们。
       *
       * **不包含「主人」**——主人是「谁能指挥她」，不是「链路通不通」。
       * 没设主人也能正常聊天，所以它不进这个进度条，在「接入」页单独一步。
       */
      const s = setupSt || {}
      const checks = [
        ['Roost 装好', s.installed],
        ['机器人凭证', s.hasCreds],
        ['Roost 在跑', s.running],
        ['ai-chat 插件', s.pluginInstalled],
        ['已指向 dsh-roost', s.pluginConfigured],
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
      const pv = portView(st, s.pluginConfig?.dshUrl || '')

      /** 红字旁边那个「现在就改过来」：只改 dshUrl 一行，不重刷插件配置 */
      const fixUrl = async () => {
        setSyncing(true)
        const r = await post('/setup/sync', {})
        setSyncing(false)
        toast(r?.ok && !r.skipped ? (r.message || '已改过来') : (r?.message || '没改成功'))
        reload()
      }

      return h('div', null,
        h(Banner, { st, setupSt }),
        h('div', { className: 'roost-sec', style: { marginTop: 0 } },
          h('div', { className: 'roost-sec-h' },
            h('span', { className: 'roost-sec-n' }, '01'),
            h('span', { className: 'roost-sec-t' }, '现在这样'),
            h('span', { style: { marginLeft: 'auto' } },
              h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新')),
          ),
          h('div', { className: 'roost-grid' },
            h(Stat, { n: st?.chats ?? 0, label: 'QQ 会话' }),
            h(Stat, { n: st?.waiting ?? 0, label: '正在等回复' }),
            h(Stat, {
              n: lt ? `${lt.ms}ms` : '—',
              label: lt ? (lt.ok ? `最近一轮回了 ${lt.len} 字` : '最近一轮失败') : '还没跑过',
              tone: lt ? (lt.ok ? 'ok' : 'bad') : null,
            }),
            h(Stat, {
              n: toolable.length || 1,
              label: toolable.length ? `能用本地工具的档位：${toolable.join('/')}` : '只有主人能用本地工具',
            }),
          ),
        ),

        h(Sec, { n: '02', title: '接入进度',
          right: h('span', { className: 'roost-note', style: { margin: 0 } }, `${doneCount} / ${checks.length}`) },
          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
            checks.map(([label, ok]) =>
              h('span', { key: label, className: 'roost-pill' + (ok ? ' ok' : '') },
                (ok ? '✓ ' : '· ') + label),
            ),
          ),
          allReady
            ? h('div', { className: 'roost-note' },
                '五项都齐了。还差两件手工的事在 QQ 开放平台：开「接收所有消息」、把机器人拉进群。')
            : h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                h('button', { type: 'button', className: 'roost-btn', onClick: () => onGo('setup') }, '去接入'),
                h('span', { className: 'roost-note', style: { margin: 0 } },
                  '缺哪一步在那一页有单独说明和按钮。'),
              ),
        ),

        h(Sec, { n: '03', title: '快捷',
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

        h(Sec, { n: '04', title: '端口对得上吗' },
          h('div', { className: 'roost-list' },
            [
              ['dsh-roost 实际监听', pv.cell || '—', 'ai-chat 要往这里推'],
              ['Roost 面板', s.port || '—', 'Roost 自己的 webui 端口，和上面不是一回事'],
              ['ai-chat 指向', s.pluginConfig?.dshUrl || '未配置', '它以为该推给谁'],
            ].map(([k, v, why]) =>
              h('div', { key: k, className: 'roost-item' },
                h('span', { className: 't' }, k, h('span', { className: 'd' }, ' ' + why)),
                h('span', { className: 'roost-mono', style: { flex: '0 0 auto' } }, String(v)),
              ),
            ),
          ),
          h('div', {
            className: 'roost-note',
            style: pv.kind === 'ok' ? { color: 'var(--ok)' } : pv.kind === 'bad' ? { color: 'var(--bad)' } : null,
          },
            pv.text,
            // 对不上时给一个**立刻能点**的出口：这事它自己就能改，
            // 没必要让用户跑去「接入」页重走一遍
            pv.action === 'sync'
              ? h('button', {
                  type: 'button',
                  className: 'roost-btn',
                  style: { marginLeft: 8, flex: '0 0 auto' },
                  disabled: syncing,
                  onClick: fixUrl,
                }, syncing ? '改着…' : '现在就改过来')
              : null,
          ),
        ),

        h(Sec, { n: '05', title: '最近动态' },
          logs === null
            ? h('div', { className: 'roost-empty' }, '读取中…')
            : logs.length === 0
              ? h('div', { className: 'roost-empty' }, '还没有动静。群里说句话，或者跑一次自测。')
              : h('div', { className: 'roost-list' },
                  logs.slice().reverse().map((e, i) =>
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

    function SetupTab({ st, reload, toast, busy, run, reg, onSaved }) {
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
      const s = st || {}
      const locked = Boolean(work) || Boolean(busy)

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
        if (!s0.pluginInstalled && !(await step('安装插件', '/setup/plugin'))) return
        if (!s0.pluginConfigured && !(await step('写配置', '/setup/configure'))) return
        toast('链路就绪 —— 去群里说一句话试试')
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
        plugin: s.pluginInstalled ? 'done' : s.running ? 'current' : 'todo',
        configure: s.pluginConfigured ? 'done' : s.pluginInstalled ? 'current' : 'todo',
        ready: s.pluginConfigured ? 'done' : 'todo',
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

      return h('div', null,

        h('div', { className: 'roost-banner', style: s.pluginConfigured ? { borderColor: 'color-mix(in srgb, var(--ok) 40%, transparent)' } : null },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('b', null, s.pluginConfigured ? '链路已就绪' : '还没配好'),
              h('i', { style: { display: 'block' } }, s.pluginConfigured
                ? '群里说一句话试试。没反应看下面的「常见卡点」。'
                : '点右边「一键就绪」，能自动做的都会做掉；做不了的会停在哪一步并说明原因。'),
            ),
            h('button', {
              type: 'button', className: 'roost-primary', disabled: locked,
              onClick: s.pluginConfigured ? () => oneKey() : oneKey,
            }, work ? work + '…' : s.pluginConfigured ? '重新检查一遍' : '一键就绪'),
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
              ? h('button', { type: 'button', className: 'roost-btn', onClick: () => window.open(s.webui, '_blank', 'noopener') }, '打开面板')
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
                )
              : mode === 'manual'
                ? h('div', { style: { marginTop: -6, marginBottom: 16, paddingLeft: 40, maxWidth: 470 } },
                    h('input', { className: 'roost-input', placeholder: 'AppID', value: appId, onChange: (e) => setAppId(e.target.value), onKeyDown: enter(saveBot), style: { marginBottom: 8 } }),
                    h('input', { className: 'roost-input', placeholder: 'AppSecret', type: 'password', value: secret, onChange: (e) => setSecret(e.target.value), onKeyDown: enter(saveBot), style: { marginBottom: 8 } }),
                    h('button', {
                      type: 'button', className: 'roost-primary', disabled: !appId || !secret || locked,
                      onClick: saveBot,
                    }, '保存凭证'),
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

          h(Step, {
            n: 4, state: mark.plugin, title: '装 ai-chat 插件',
            desc: s.pluginInstalled ? '已装 —— Roost 那边负责收发 QQ 消息的那个插件' : 'Roost 那边负责收发 QQ 消息的插件',
          },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: !s.running || locked,
              onClick: () => step('安装插件', '/setup/plugin'),
            }, s.pluginInstalled ? '重装 / 更新' : '安装'),
          ),

          h(Step, {
            n: 5, state: mark.configure, title: '切到 DSH 适配器',
            desc: s.pluginConfigured
              ? `ai-chat 已指向 ${s.pluginConfig?.dshUrl || s.dshUrl}`
              : '把 ai-chat 的「交给谁去想」改成 DSH，并填好回话地址',
          },
            /**
             * 永远给个能点的按钮。
             *
             * 之前「已配置就隐藏、没装插件就禁用」，两种情况下点下去都毫无反应，
             * 用户不知道发生了什么。现在一律可点，做不了就在提示里说清原因。
             */
            h('button', {
              type: 'button', className: 'roost-btn', disabled: locked,
              onClick: async () => {
                if (!s.pluginInstalled) {
                  setCfgMsg('✗ 还没装 ai-chat 插件，先走第 4 步')
                  return toast('先装 ai-chat 插件（第 4 步）')
                }
                if (!s.running) {
                  setCfgMsg(`✗ Roost 没在跑（${s.webui || '面板端口'} 连不上），先点第 3 步的「启动」`)
                  return toast('Roost 没在跑，先启动（第 3 步）')
                }
                setCfgMsg('正在写…')
                const r = await post('/setup/configure', {})
                setCfgMsg(r.ok === false ? `✗ ${r.message || '没写成'}` : `✓ ${r.message || '已指向 dsh-roost'}`)
                toast(r.ok === false ? r.message || '没写成' : r.message || '已切换')
                await reload()
              },
            }, s.pluginConfigured ? '重新写一次' : '配置'),
          ),
            cfgMsg
              ? h('div', {
                  className: 'roost-mono',
                  style: {
                    marginTop: 6,
                    color: cfgMsg.startsWith('✗') ? 'var(--bad)' : cfgMsg.startsWith('✓') ? 'var(--ok)' : 'inherit',
                  },
                }, cfgMsg)
              : null,

          h(Step, {
            n: 6, state: mark.ready, title: '在群里说句话',
            desc: s.pluginConfigured
              ? '还差两件手工的事：开放平台开「接收所有消息」，机器人先进群'
              : '前面五步走完就能试了',
          },
            s.pluginConfigured
              ? h('button', { type: 'button', className: 'roost-btn', onClick: () => window.open('https://q.qq.com', '_blank', 'noopener') }, '开放平台')
              : null,
          ),

          /**
           * 第七步：配置主人。**放在最后**——前面六步是「能跑起来」，
           * 这一步是「谁能指挥它」，是跑起来之后才需要定的事。
           *
           * 主人只能在 **Roost 面板**里设（面板有「主人与群组」那块），
           * 这里只读状态 + 给个跳转按钮，不代劳——
           * 主人是「谁能指挥这台机器」的根，不该由插件代写。
           */
          h(Step, {
            n: 7, state: mark.owner, title: '配置主人',
            desc: s.ownersConfigured
              ? `已设 ${s.ownerCount || 1} 个主人 —— 群友的话她只当聊天，主人才能指挥她动工具`
              : '去 Roost 面板的「主人与群组」里把你自己设成主人，不然她只能聊天、不能动工具',
          },
            h('button', {
              type: 'button',
              className: 'roost-btn',
              disabled: !s.webui,
              onClick: () => window.open(`${s.webui || ''}#groups`, '_blank', 'noopener'),
            }, s.ownersConfigured ? '打开面板看看' : '打开 Roost 面板设置'),
          ),
        ),

        /* 接入这几步用的是圆圈编号，这里就不再编号了 —— 混用两套编号会读成"第 8 步" */
        h(Sec, { title: '常见卡点' },
          h('ul', { className: 'roost-note', style: { margin: 0, paddingLeft: 18 } },
            h('li', null, `启动后马上退出：多半是 AppID / AppSecret 填错了，或端口 ${s.port || ''} 被占`),
            h('li', null, '群里没反应：开放平台没开「接收所有消息」，或机器人不在群里'),
            h('li', null, '有反应但答非所问：ai-chat 的「什么时候接话」被设成了「只在被 @ 时」'),
            h('li', null, '面板上一切正常但消息全失败：看「概览 → 端口对得上吗」，八成是 ai-chat 指错端口'),
            s.accessKeySet === false
              ? h('li', null, '访问密钥还没设过：Roost 面板默认只监听本机，够用；要远程访问再去设')
              : null,
          ),
        ),
      )
    }

    /* ---------------- 人格与情绪（页签 key 仍是 her） ---------------- */

    function HerTab({ config, personas, mood, stickers, mem, setupSt, toast, save, reload, quick }) {
      const [editId, setEditId] = useState('')
      const [raw, setRaw] = useState('')
      const [newId, setNewId] = useState('')
      const [dirty, setDirty] = useState(false)
      const [showNew, setShowNew] = useState(false)

      /**
       * 人格仓库（「从仓库更新」）。
       *
       * `repo` 是 `GET /personas/repo` 的结果：仓库里有哪些人格、本地各自
       * 什么状态（没装 / 已是最新 / 有更新 / 你改过）。服务端有 5 分钟缓存，
       * 所以进这一页拉一次不会每次都打网络。
       */
      const [repo, setRepo] = useState(null)
      const [repoErr, setRepoErr] = useState('')
      const [repoBusy, setRepoBusy] = useState(false)
      const [repoOpen, setRepoOpen] = useState(false)
      const [preview, setPreview] = useState(null)
      const [riskNote, setRiskNote] = useState(null)

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
      const sec = (title, extra, children) => {
        _seq += 1
        return h(Sec, Object.assign({ n: String(_seq).padStart(2, '0'), title }, extra || {}), children)
      }

      /** 这一页说的是「当前这个会话里她是谁」，不是「全局默认是谁」 */
      const byChat = personas?.byChat || {}
      const byChatCount = Object.keys(byChat).length
      const curId = byChat[mem?.chatId] || personas?.current || config?.persona?.current || 'default'
      const override = mem?.personaOverride || ''
      const tts = setupSt?.pluginConfig?.ttsVoice

      /** 打开一个人格的正文。列表里没有 raw，得单独读一次 */
      const openPersona = async (id) => {
        const r = await get('/personas/read?id=' + encodeURIComponent(id))
        if (r.ok === false) return toast(r.message || '读不到正文')
        setEditId(id)
        setRaw(r.raw || '')
        setDirty(false)
      }

      return h('div', null,
        sec('人格', {
          /**
           * 标题右边两个按钮。
           *
           * 「从仓库更新」带角标：有几个可更新就显示几。**不自动更新**——
           * 人格突然变味比"版本旧"难受得多，必须用户自己点。
           */
          right: h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('button', {
              type: 'button', className: 'roost-btn',
              disabled: repoBusy,
              title: repoErr ? `仓库连不上：${repoErr}` : '从 dsh-roost 仓库拉最新人格（不碰你改过的）',
              onClick: runSync,
            }, repoBusy ? '更新中…' : `从仓库更新${pending ? ' ' + pending : ''}`),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => { setRepoOpen((v) => !v); if (!repoOpen && !repo) loadRepo(true) },
            }, repoOpen ? '收起仓库' : '仓库'),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: () => setShowNew((v) => !v),
            }, showNew ? '收起新建' : '新建'),
          ),
        },
          h('div', { className: 'roost-list' },
            (personas?.personas || []).map((p) => {
              const isCur = p.id === curId
              const isDefault = p.id === 'default'
              return h('div', { key: p.id, className: 'roost-item roost-persona' },
                /**
                 * 两行：名字一行、字数与标签一行。
                 *
                 * 之前全挤在一行，右侧还要放三个按钮——窗口一窄，名字就被压没了。
                 * 「当前」也不再做成禁用按钮（禁用态看着像坏了），改用标签。
                 */
                h('div', { className: 't' },
                  h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                    h('span', { style: { fontWeight: isCur ? 650 : 500 } }, p.name || p.id),
                    isCur ? h(Pill, { tone: 'ok' }, '正在用') : null,
                  ),
                  h('div', { className: 'roost-note', style: { marginTop: 1 } },
                    `${p.chars ?? 0} 字` + ((p.tags || []).length ? ` · ${p.tags.join(' / ')}` : '')),
                ),
                h('div', { className: 'roost-acts' },
                  isCur
                    ? null
                    : h('button', {
                        type: 'button', className: 'roost-btn',
                        onClick: async () => {
                          const r = await save({ persona: { current: p.id } })
                          toast(r.ok === false ? (r.message || '没换成') : '换好了')
                          reload()
                        },
                      }, '用这个'),
                  h('button', { type: 'button', className: 'roost-btn', onClick: () => openPersona(p.id) }, '编辑'),
                  isDefault
                    ? null
                    : h(ConfirmLink, {
                        label: '删除', confirmLabel: '确认删除',
                        onConfirm: async () => {
                          const r = await post('/personas/remove', { id: p.id })
                          toast(r.ok === false ? (r.message || '没删掉') : '删了')
                          if (editId === p.id) { setEditId(''); setRaw('') }
                          reload()
                        },
                      }),
                ),
              )
            }),
            !(personas?.personas || []).length ? h('div', { className: 'roost-empty' }, '读不到人格列表') : null,
          ),

          /**
           * 仓库面板：仓库里有哪些人格、本地各自什么状态。
           *
           * 刻意**不做单条安装**：安装动作只有「从仓库更新」一个按钮，
           * 点一次装全部该装的。多一个入口就多一套状态，而这里的需求
           * 本来就是"顺手点一下"，不是逐条挑着装。
           * 面板存在的意义是**看清楚**：谁没装、谁有更新、谁是你改过的。
           */
          repoOpen
            ? h('div', { style: { marginTop: 12 } },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { fontSize: 12, fontWeight: 650 } },
                    `仓库 ${repo?.repo || 'tdcq9594/dsh-roost'} · personas/`),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: () => loadRepo(true),
                  }, '刷新'),
                  repo?.stale ? h(Pill, { tone: 'warn' }, '用的是缓存清单') : null,
                ),
                repoErr ? h('div', { className: 'roost-note', style: { color: '#c0392b' } }, '连不上仓库：' + repoErr) : null,
                repo && repo.gate && repo.gate.ok === false
                  ? h('div', { className: 'roost-note' }, repo.gate.why + '，先升级 dsh-roost 再看。')
                  : null,

                h('div', { className: 'roost-list', style: { marginTop: 8 } },
                  (repo?.personas || []).map((p) => {
                    const label = p.state === 'missing' ? '未安装'
                      : p.state === 'update' ? '有更新'
                        : p.state === 'modified' ? '你改过'
                          : '已是最新'
                    return h('div', { key: p.id, className: 'roost-item' },
                      h('div', { className: 't' },
                        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                          h('span', { style: { fontWeight: 500 } }, p.name || p.id),
                          h(Pill, { tone: p.state === 'modified' ? 'warn' : p.state === 'same' ? 'ok' : 'info' }, label),
                        ),
                        h('div', { className: 'roost-note', style: { marginTop: 1 } },
                          `仓库 ${p.chars} 字` + (p.localChars ? ` · 本地 ${p.localChars} 字` : '')
                          + ((p.tags || []).length ? ` · ${p.tags.join(' / ')}` : '')),
                      ),
                      h('div', { className: 'roost-acts' },
                        h('button', {
                          type: 'button', className: 'roost-btn',
                          onClick: async () => {
                            const r = await get('/personas/repo/preview?id=' + encodeURIComponent(p.id))
                            if (r.ok === false) return toast(r.message || '预览不了')
                            setPreview(r)
                          },
                        }, '预览'),
                        /**
                         * 「恢复官方版本」只对**改过的**出现。
                         * 一键更新刻意不碰你改过的文件，这里就是反悔的出口；
                         * 服务端覆盖前会自动备份到 personas/.backup/。
                         */
                        p.state === 'modified'
                          ? h(ConfirmLink, {
                              label: '恢复官方', confirmLabel: '确认覆盖？',
                              onConfirm: async () => {
                                const r = await post('/personas/restore', { id: p.id })
                                toast(r.ok === false ? (r.message || '没恢复成') : '已恢复官方版本（旧内容已备份）')
                                await reload()
                                await loadRepo(true)
                              },
                            })
                          : null,
                      ),
                    )
                  }),
                  !(repo?.personas || []).length ? h('div', { className: 'roost-empty' }, '仓库里没读到人格') : null,
                ),
                h('div', { className: 'roost-note' },
                  '只装「没被改过」的：一键更新会跳过你手改过的那几份，'
                  + '自建的人格（不在仓库清单里的）完全不碰。'),
              )
            : null,

          /** 预览：装之前先读一遍正文。人格是要读的，光看标签决定不了 */
          preview
            ? h('div', { style: { marginTop: 12, border: '1px solid currentColor', borderRadius: 8, padding: 10 } },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('div', { style: { fontSize: 12, fontWeight: 650 } }, `预览：${preview.name || preview.id}`),
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

          h('div', { className: 'roost-note' },
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

          /**
           * 新建入口放在「人格」这一节里，而不是单开一节。
           *
           * 之前它单独占一节「编辑人格」，可那一节平时是空的（占位），
           * 真正的编辑动作又发生在点开某一行之后——入口和动作被拆到两处。
           * 现在：标题右边「新建」开输入框；点某行的「编辑」就地展开正文。
           */
          showNew
            ? h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
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
        ),

        /**
         * 编辑区：**只在真的打开了某个人格时**才占一节。
         *
         * 之前无论有没有打开都渲染一节「编辑人格」，空的时候留一句
         * 「点上面某一行的编辑读正文」——占位 + 指路，占了版面也占了编号。
         */
        editId
          ? sec('编辑「' + editId + '」', null,
              h('div', null,
                h('textarea', {
                  className: 'roost-input',
                  style: { minHeight: 300, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 12, lineHeight: 1.7, resize: 'vertical' },
                  value: raw,
                  spellCheck: false,
                  onChange: (e) => { setRaw(e.target.value); setDirty(true) },
                }),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
                  h('button', {
                    type: 'button', className: 'roost-primary',
                    onClick: async () => {
                      const r = await post('/personas/save', { id: editId, raw })
                      toast(r.ok === false ? (r.message || '没存上') : '存好了')
                      if (r.ok !== false) { setDirty(false); reload() }
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
            )
          : null,

        sec('此刻情绪', null,
          mood
            ? h('div', null,
                h('div', { className: 'roost-mood' },
                  MOOD.map((m) => {
                    const v = Math.max(-1, Math.min(1, Number(mood[m.key] ?? 0)))
                    return h('div', { key: m.key, className: 'roost-mood-row' },
                      h('span', { className: 'roost-mood-k' }, m.label),
                      h(Bar, { v, bi: m.bi }),
                      h('span', { className: 'roost-mood-w' }, wordOf(v, m.words, m.bi)),
                    )
                  }),
                ),
                h('div', { className: 'roost-note' },
                  mood.reason ? '原因：' + mood.reason : '还没被什么事影响过',
                  mood.updatedAt ? ' · ' + ago(mood.updatedAt) : '',
                ),
                h('div', { className: 'roost-note' },
                  '心情左边差、右边好；另两条从左到右是程度。这三项只决定她接不接话、说多长，'
                  + '不会当成数字喂给模型；没人理她，几小时后会自己回到中间。'),
                h('div', { className: 'roost-note' },
                  '这三条是读数、不能拖——她的情绪由聊天的结果自己变；想影响就用下面的赞 / 踩。'),
                /* 后端接受 feedback（QQ 里点赞/点踩会打到这），这里给手动入口方便调 */
                h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '手动喂一次反馈：'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    /**
                     * 传 `LIKE` / `UNLIKE`，别传 `up` / `down`。
                     *
                     * 这里以前传的是 `up`/`down`，而后端只认 `LIKE`/`UNLIKE`——
                     * **按钮点了完全没反应，toast 还照样说"记了个赞"**。
                     * 后端现在也做归一化了（`normalizeFeedback`），
                     * 但前端按契约传，别指望对面兜底。
                     */
                    onClick: async () => {
                      const r = await post('/mood', { feedback: 'LIKE' })
                      toast(r?.ok === false ? (r.message || '没记上') : '记了个赞')
                      reload()
                    },
                  }, '👍 赞'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: async () => {
                      const r = await post('/mood', { feedback: 'UNLIKE' })
                      toast(r?.ok === false ? (r.message || '没记上') : '记了个踩')
                      reload()
                    },
                  }, '👎 踩'),
                ),
              )
            : h('div', { className: 'roost-empty' }, '读不到情绪——插件刚起来时会空几秒'),
        ),

        sec('表情包', {
          right: h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              type: 'button', className: 'roost-link',
              onClick: () => {
                try { navigator.clipboard?.writeText(stickers?.dir || ''); toast('目录路径已复制') }
                catch { toast('复制失败，手动选一下吧') }
              },
            }, '复制目录'),
            h('button', { type: 'button', className: 'roost-link', onClick: reload }, '刷新'),
          ) },
          stickers?.items?.length
            ? h('div', null,
                h('div', { className: 'roost-muted' }, `${stickers.items.length} 张`),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
                  stickers.items.slice(0, 40).map((s, i) =>
                    h('span', { key: i, className: 'roost-pill' }, s.tags?.join(' / ') || s.name || '图'),
                  ),
                ),
                h('div', { className: 'roost-note', style: { marginTop: 8 } },
                  stickers.items.slice(0, 6).map((x) => x.file).filter(Boolean).join('、')
                  + (stickers.items.length > 6 ? ' …' : '')),
              )
            : h('div', { className: 'roost-empty' },
                '一张图都没有。往 ',
                h('span', { className: 'roost-code' }, stickers?.dir || 'stickers/'),
                ' 丢图片，文件名当标签（开心_猫.png → 开心、猫），丢完点「刷新」。'),
          h('div', { className: 'roost-mono roost-dim', style: { marginTop: 4 } }, stickers?.dir || ''),
          h('div', { className: 'roost-note' }, '她只在合适的时候发，不会每句都配图。'),
        ),

        /**
         * 语音条只读。
         *
         * 音色是 ai-chat 的设置项，面板改不了——但「现在开没开」必须能看见，
         * 否则每次都要跨插件去翻配置才知道她为什么不发语音。
         */
        sec('语音条', null,
          setupSt?.pluginInstalled === false
            ? h('div', { className: 'roost-empty' }, 'ai-chat 还没装')
            : tts === undefined
              ? h('div', { className: 'roost-empty' }, '读不到 ai-chat 的配置（Roost 没在跑？）')
              : h('div', null,
                  h('div', null, tts ? '开 · ' + tts : '关着'),
                  tts
                    ? null
                    : h('div', { className: 'roost-note' }, '音色在 ai-chat 的设置里填，这里只读。'),
                ),
        ),
      )
    }

    /* ---------------- 记忆（三层） ---------------- */

    function MemoryTab({ mem, toast, reload, quick, busy, onPickChat }) {
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [fact, setFact] = useState('')
      const [scope, setScope] = useState('global')
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

      const doSearch = async () => {
        const term = q.trim()
        if (!term) return
        const r = await get('/journal?q=' + encodeURIComponent(term) + (mem?.chatId ? '&chatId=' + encodeURIComponent(mem.chatId) : ''))
        if (r.ok === false) return toast(r.message || '搜不了')
        setHits(r.results || [])
      }

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
        ),

        /* ── 第一层：事实 ── */
        h(Sec, { n: '01', title: '事实', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '跨群的事实她带去任何会话；本会话特有的只在这个会话提。串场就是从这条线漏出去的，所以要分开看。'),

          h('div', { style: { marginBottom: 10 } },
            h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } }, '通用（跨群）'),
            (mem?.global || []).length
              ? h('div', { className: 'roost-list' },
                  mem.global.map((f, i) =>
                    h('div', { key: i, className: 'roost-item' },
                      h('span', { className: 't' }, f),
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
                        label: '忘', confirmLabel: '确认忘掉',
                        onConfirm: async () => {
                          const w = r.text.slice(0, 12)
                          const res = await post('/journal', { word: w })
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
                toast(r.ok ? `巩固完成：压缩 ${r.compressed} 条、三元组 ${r.triples} 个` : (r.reason || '没跑成'))
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
                      gp.edges.map((e) =>
                        h('div', { key: e.id, className: 'roost-item' },
                          h('span', { className: 't' }, `${e.src} —${e.rel}→ ${e.dst}`),
                          h('span', { className: 'd' }, dayOf(e.from)),
                        ),
                      ),
                    )
                  : h('div', { className: 'roost-empty' }, '还没有关系。聊得多了巩固时会自己抽出来。'),
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

        /* 对话收尾：静默发生的东西，必须能看见 */
        h(Sec, {
          n: '05',
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

        /**
         * 第五层：她自己写的。
         *
         * 前几节都是「关于用户」的；这一节回答「她最近怎么样、错在哪」。
         * 不显示出来的话，用户没法判断她到底是变好了还是在重复同一个错，
         * 也没法在写歪的时候把它清掉。
         */
        h(Sec, {
          n: '06',
          title: '她自己',
          right: mem?.self?.stats?.notes
            ? h(Pill, null, `${mem.self.stats.notes} 条`)
            : null,
        },
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
                toast(r.message || '清了')
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
                toast(r.message || '删了')
                reload()
              },
            }),
            h(ConfirmLink, {
              label: '清空跨群记忆', confirmLabel: '确认清空跨群',
              onConfirm: async () => {
                const r = await quick('memory.clearGlobal')
                toast(r.message || '清了')
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

    /* ---------------- 主动搭话 ---------------- */

    function AwakeTab({ aw, mem, sp, chats, toast, reload, reloadSp, busy }) {
      const cfg = aw?.cfg || {}
      const opps = aw?.lastOpportunities || []
      const groups = aw?.groups || []
      const [authChat, setAuthChat] = useState('')
      const [authScope, setAuthScope] = useState('group_push')
      const state = sp?.state || {}
      const spCfg = sp?.cfg || {}

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
                  ? '主动说话关着（去「设置」打开 awake.enabled）'
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
          h(Row, { k: '下次' }, state.nextAt ? ago(state.nextAt).replace('前', '后') : '还没排'),
          h(Row, { k: '今天' }, `${state.day && state.day === new Date().toDateString() ? state.todayCount : 0} / ${spCfg.maxPerDay ?? 3} 次`),
          h(Row, { k: '上次' },
            state.lastBotAt
              ? `${ago(state.lastBotAt)}${state.lastText ? '：' + state.lastText : ''}`
              : '还没主动说过'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: async () => {
                const r = await post('/speakup/fire', {})
                toast(r.ok ? '说了：' + (r.text || '') : (r.why || r.message || '这次没说'))
                reloadSp()
                reload()
              },
            }, '立刻走一次私聊流程'),
          ),
          h('div', { className: 'roost-note' },
            '间隔随机、免打扰、每日上限都在这里管；「要不要说」交给上面的机会判断。'),
        ),

        h(Sec, { n: '03', title: '群聊主动（默认全关）' },
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
              '授权：官方硬前置，没这条记录群主动发不出去'),
            mem?.authz
              ? h('div', { className: 'roost-item' },
                  h('span', { className: 't' }, `当前会话已授权：${mem.authz.scope}`),
                  h('span', { className: 'd' }, ago(mem.authz.at)),
                )
              : h('div', { className: 'roost-empty' }, '当前会话还没有授权记录'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
              h('input', {
                className: 'roost-input', placeholder: '群/用户 chatId（可从「会话」页复制）',
                value: authChat, onChange: (e) => setAuthChat(e.target.value), style: { flex: 1, minWidth: 200 },
              }),
              h('select', {
                className: 'roost-input', value: authScope, onChange: (e) => setAuthScope(e.target.value),
                style: { width: 130, flex: '0 0 130px' },
              },
                h('option', { value: 'group_push' }, '群主动'),
                h('option', { value: 'c2c_push' }, '私聊主动'),
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

        h(Sec, { n: '04', title: '现在试一次' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '私聊直接问一次要不要说；群里跑一遍四道门。真发出去会出现在 QQ 上。'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
              type: 'button', className: 'roost-primary', disabled: busy,
              onClick: async () => {
                const r = await post('/awake', {})
                toast(r.spoke ? '她说了：' + (r.text || '') : (r.why || '这次没说'))
                reload()
              },
            }, busy ? '问着…' : '问一次私聊'),
            h('button', {
              type: 'button', className: 'roost-btn', disabled: busy,
              onClick: async () => {
                const r = await post('/awake', { target: 'group' })
                const said = (r.results || []).filter((x) => x.ok)
                toast(said.length ? `在 ${said.length} 个群说了` : '群里一个都没说')
                reload()
              },
            }, '跑一遍群白名单'),
          ),
        ),
      )
    }

    /* ---------------- 上下文（压缩 + 注入） ---------------- */

    function ContextTab({ ctxInfo, mind, toast, reload, busy }) {
      const p = ctxInfo?.pressure || {}
      const th = ctxInfo?.cfg || {}
      const b = mind?.budgets?.memory || {}
      const pct = p.percent

      return h('div', null,
        h(Sec, { n: '01', title: '窗口占用', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
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

        h(Sec, { n: '02', title: '压缩' },
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

        h(Sec, { n: '03', title: '这一轮注入了什么' },
          !mind
            ? h('div', { className: 'roost-empty' }, '还没聊过，读不到注入内容')
            : h('div', null,
                h('div', { className: 'roost-muted', style: { fontSize: 12, marginBottom: 4 } },
                  `稳定段 ${b.staticLen ?? 0} 字（进 system prompt，缓存可复用）`),
                h('pre', { className: 'roost-pre' }, mind.memoryStaticText || '（空）'),
                h('div', { className: 'roost-muted', style: { fontSize: 12, margin: '10px 0 4px' } },
                  `易变段 ${b.dynamicLen ?? 0} 字（拼在用户消息前，不污染缓存）`),
                h('pre', { className: 'roost-pre' }, mind.memoryDynamicText || '（空）'),
                h('div', { className: 'roost-note' },
                  '分成两段就是为了让 system prompt 的前缀保持稳定。每轮都变的东西塞进系统提示，等于每轮主动作废一次缓存。'),
              ),
        ),

        h(Sec, { n: '04', title: '记忆工具' },
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
      )
    }

    /* ---------------- 会话 ---------------- */

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

    /* ---------------- 设置 ---------------- */

    const JSON_SECTIONS = [
      ['memory', '记忆', '日记寿命、注入条数、多少轮全量重注、记忆工具开关'],
      ['compact', '上下文压缩', '两个场景的阈值、开场带几条原话'],
      ['awake', '主动说话', '清醒时段、机会分门槛、群白名单'],
      ['speakUp', '私聊排期', '间隔/免打扰/每日上限（开不开由这里的总开关管）'],
      ['persona', '人格', '当前用哪个人格、按群指定；换人格去「人格与情绪」页点「用这个」'
        + '（name / text 是 0.10.0 之前的旧字段，只在人格文件读不出正文时才兜底）'],
      ['stickers', '表情包', '图放哪、要不要注入'],
      ['permissions', '权限', '主人/管理员/成员各能用什么工具'],
      ['channel', '通道', '当前用哪个通道'],
      ['chat', '会话', '一轮最多等多久；上游 502/429 时的补重试（attempts 是「补几次」，budgetSec 是整轮总预算）'],
      ['workspace', '工作区', '机器人会话挂哪个工作区：dir 留空单开、__default__ 用默认'],
      ['server', '服务', '端口与密钥'],
      ['setup', '接入', '装在哪、用哪种接入方式'],
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

      const loadCheck = async () => {
        const r = await get('/update/check')
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
          toast(r.message || (r.ok ? '更新完成，重启 DSH 生效' : '没更新成'))
          await loadCheck()
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
        right: h('button', { type: 'button', className: 'roost-btn', onClick: () => { loadCheck(); loadRepo() } }, '重新检查'),
      },
        /* ---- 本体 ---- */
        h('div', { className: 'roost-item' },
          h('div', { className: 't' },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, 'dsh-roost 本体'),
              h('span', { className: 'roost-note', style: { margin: 0 } },
                `当前 ${own}` + (latest ? ` · 最新 ${latest}` : '')
                + (info?.ageText ? `（${info.ageText}）` : '')),
              info?.hasUpdate ? h(Pill, { tone: 'info' }, '有新版') : null,
            ),
            /**
             * 三种装法要说清，不然用户点不动按钮也不知道为什么：
             * 开发模式（符号链接）根本不该更新，会把源码链路搞断。
             */
            h('div', { className: 'roost-note', style: { marginTop: 2 } },
              info?.kind === 'linked'
                ? '开发模式（node_modules 里是符号链接）：自更新已禁用，改完源码重启 DSH 即可。'
                : info?.kind === 'real'
                  ? '装完要**重启 DSH** 才生效。'
                  : info?.hasManager === false
                    ? '这个 DSH 版本没有 pluginManager，请去 DSH 插件管理里手动更新。'
                    : (info?.error ? '查不到最新版：' + info.error : '')),
            info?.cooling && info?.hasUpdate
              ? h('div', { className: 'roost-note', style: { color: 'var(--warn)', marginTop: 2 } },
                  `${latest} 发布不满 24 小时（pnpm 默认不装这么新的版本，会降级），${info.coolingLeftText}。`
                  + '点「立即安装」会先给 dsh-roost 加一条豁免再装。')
              : null,
          ),
          h('div', { className: 'roost-acts' },
            info?.canSelf && info?.hasUpdate
              ? h('button', {
                  type: 'button', className: 'roost-primary', disabled: Boolean(busy),
                  onClick: () => doSelf(false),
                }, busy === 'self' ? '更新中…' : `更新到 ${latest}`)
              : null,
            info?.canSelf && info?.hasUpdate && info?.cooling
              ? h('button', {
                  type: 'button', className: 'roost-btn', disabled: Boolean(busy),
                  title: '改 pnpm-workspace.yaml 加一条只对 dsh-roost 生效的豁免，然后立刻装',
                  onClick: () => doSelf(true),
                }, busy === 'fresh' ? '安装中…' : '立即安装（不等 24 小时）')
              : null,
          ),
        ),

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
                : '从 dsh-roost 仓库的 personas/ 拉。只覆盖没改过的，你自己改过和自建的一个不碰；即时生效不用重启。'),
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

    function ConfigTab({ config, save, toast }) {
      const [draft, setDraft] = useState(() => JSON.stringify(config, null, 2))
      const [err, setErr] = useState('')

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
        setErr('')
        const r = await save(parsed)
        toast(r.ok === false ? (r.message || '没存上') : '存好了（下一轮生效）')
      }

      return h('div', null,
        h(UpdatesBlock, { toast }),

        h(Sec, { n: '02', title: '配置全文', right: h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { type: 'button', className: 'roost-btn', onClick: () => setDraft(JSON.stringify(config, null, 2)) }, '还原'),
          h('button', { type: 'button', className: 'roost-primary', onClick: doSave }, '保存'),
        ) },
          err ? h('div', { style: { color: 'var(--bad)', fontSize: 12, marginBottom: 6 } }, err) : null,
          h('textarea', {
            className: 'roost-input',
            style: { minHeight: 420, fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 11.5, lineHeight: 1.6, resize: 'vertical' },
            value: draft,
            spellCheck: false,
            onChange: (e) => setDraft(e.target.value),
          }),
          h('div', { className: 'roost-note' },
            '密钥显示成 ******。原样提交回来不会覆盖真密钥，只有填了新的才会改。'),
        ),

        h(Sec, { n: '03', title: '各段是干什么的' },
          h('div', { className: 'roost-list' },
            JSON_SECTIONS.map(([k, label, desc]) =>
              h('div', { key: k, className: 'roost-item' },
                h('span', { className: 't' },
                  h('span', { className: 'roost-code', style: { cursor: 'pointer' }, onClick: () => toast('在下面的配置全文里搜 «' + k + '»') }, k),
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

    /* ---------------- 日志 ---------------- */

    function LogsTab() {
      const [logs, setLogs] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          const r = await get('/logs')
          // 路由返回的键是 entries；写成 r.logs 会永远是空列表（且不报错）
          if (alive) setLogs(r.ok === false ? [] : r.entries || [])
        }
        load()
        const t = setInterval(load, 3000)
        return () => { alive = false; clearInterval(t) }
      }, [])

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

    /* ---------------- 页面 ---------------- */

    /**
     * 页签顺序固定；「概览」永远第一个——它是首屏。
     *
     * `her` 这一页现在叫「人格与情绪」：里面是人格正文、当前情绪、
     * 表情包、语音条。以前页签名只有一个「她」字，用户得点进去才知道
     * 这页能改人格——名字写清楚比省两个字重要。key 仍是 `her`，
     * 不动它是因为 `localStorage` 里存着上次停留的页签，改 key 会让
     * 老用户回来时落空、退回概览。
     */
    const TABS = [
      ['overview', '概览'],
      ['setup', '接入'],
      ['her', '人格与情绪'],
      ['memory', '记忆'],
      ['awake', '主动搭话'],
      ['context', '上下文'],
      ['chats', '会话'],
      ['config', '设置'],
      ['logs', '日志'],
    ]

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
          return TABS.some(([id]) => id === last) ? last : 'overview'
        } catch {
          return 'overview'
        }
      })
      const setTab = useCallback((id) => {
        setTabState(id)
        try { localStorage.setItem('roost.tab', id) } catch {}
      }, [])
      const [st, setSt] = useState(null)
      const [setupSt, setSetupSt] = useState(null)
      const [config, setConfig] = useState(null)
      const [mem, setMem] = useState(null)
      /** 记忆页选中的会话；空串 = 跟随「最近说话的那个」 */
      const [memPick, setMemPick] = useState('')
      /**
       * 「人格与情绪」页一次要三份数据，合成**一个** state。
       *
       * 原来三个独立 setState：接口回来时如果 React 没批处理，就是三次渲染、
       * 三次整页重排。这一页是唯一这样的页面（其余页最多两份，且多数是分开用），
       * 所以「切到这一页」更容易看到没画完的白块。
       */
      const [her, setHer] = useState(null)
      const [aw, setAw] = useState(null)
      const [sp, setSp] = useState(null)
      const [ctxInfo, setCtxInfo] = useState(null)
      const [mind, setMind] = useState(null)
      const [chats, setChats] = useState(null)
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
      }, [])

      /**
       * `pick` 是记忆页上选中的会话（空 = 跟随「最近说话的那个」）。
       * 两个接口都带上它，否则切了会话看到的还是原来那个群的日记和图谱。
       */
      const loadMemory = useCallback(async (pick = memPick) => {
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
      }, [memPick])

      /** 切会话：记住选择，再拉一次（日记/图谱/授权都跟着换） */
      const pickChat = useCallback(async (chatId) => {
        setMemPick(chatId)
        await loadMemory(chatId)
      }, [loadMemory])

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
        const [c, m] = await Promise.all([get('/compact'), get('/mind')])
        setCtxInfo(c.ok === false ? null : c)
        setMind(m.ok === false ? null : m)
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
        if (tab === 'memory') loadMemory()
        if (tab === 'her') loadHer()
        if (tab === 'awake') {
          // 授权状态在 /memory 里、chatId 列表在 /chats 里，这一页两样都要用
          loadAwake()
          if (!mem) loadMemory()
          if (!chats) loadChats()
        }
        if (tab === 'context') loadCtx()
        if (tab === 'chats') loadChats()
        if (tab === 'config' && !config) loadConfig()
      }, [tab, config, mem, chats, loadMemory, loadHer, loadAwake, loadCtx, loadChats, loadConfig])

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
        const r = await post('/quick', { op, arg, chatId: mem?.chatId || '', actor: { bucket: 'owner' } })
        return r
      }, [mem])

      const saveCfg = useCallback(async (patch) => {
        const r = await post('/config', patch)
        if (r.ok !== false) setConfig(r.config || null)
        return r
      }, [])

      /**
       * 结构：**页头和页签固定，只有正文滚**。
       *
       * 上一版是整页一个大 div，滚动条跑到哪由 DSH 外层决定——结果是
       * 页签行自己长了一条竖滚动条（还拖不动），而下面的正文没有滚动条、
       * 长页面直接被切掉。仪表盘该有的样子正好相反：切换栏永远在，
       * 内容在它下面滚。
       */
      return h('div', { className: 'roost-root' },
        h('div', { className: 'roost-head' },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('div', { style: { fontSize: 17, fontWeight: 650, letterSpacing: '-0.01em' } }, 'Roost'),
            st
              ? h(Pill, { tone: st.listening ? 'ok' : 'bad' }, st.listening ? `:${st.actualPort || st.port}` : '端口没起')
              : null,
            ch?.current ? h(Pill, null, '通道 ' + ch.current) : null,
          ),
          h('div', { className: 'roost-note', style: { marginTop: 3 } }, 'QQ 消息从这里交给 DSH 会话回答。'),

          h('div', {
            role: 'tablist',
            'aria-label': 'Roost 各页',
            style: { display: 'flex', gap: 2, flexWrap: 'wrap', margin: '16px 0 0', borderBottom: '1px solid var(--line-soft)' },
          },
            TABS.map(([id, label]) =>
              h('button', {
                key: id, type: 'button', className: 'roost-tab',
                role: 'tab',
              'aria-selected': tab === id ? 'true' : 'false',
              'data-on': tab === id ? '1' : '0',
              onClick: () => setTab(id),
            }, label),
          ),
          ),
        ),

        h('div', { className: 'roost-scroll-body roost-fade', key: tab },
          tab === 'overview' ? h(OverviewTab, { st, setupSt, toast, reload: loadStatus, busy, run, onGo: setTab }) : null,
          tab === 'setup' ? h(SetupTab, { st: setupSt, reload: loadStatus, toast, busy, run, reg, onSaved: loadSetupMeta }) : null,
          tab === 'her'
            ? h(HerTab, {
                config,
                personas: her?.personas ?? null,
                mood: her?.mood ?? null,
                stickers: her?.stickers ?? null,
                mem, setupSt, toast, save: saveCfg, reload: loadHer, quick,
              })
            : null,
          tab === 'memory' ? h(MemoryTab, { mem, toast, reload: loadMemory, quick, busy, onPickChat: pickChat }) : null,
          tab === 'awake' ? h(AwakeTab, { aw, mem, sp, chats, toast, reload: loadAwake, reloadSp: loadAwake, busy }) : null,
          tab === 'context' ? h(ContextTab, { ctxInfo, mind, toast, reload: loadCtx, busy }) : null,
          tab === 'chats' ? h(ChatsTab, { chats, reload: loadChats, toast }) : null,
          tab === 'config' ? (config ? h(ConfigTab, { config, save: saveCfg, toast }) : h('div', { className: 'roost-empty' }, '读取配置…')) : null,
          tab === 'logs' ? h(LogsTab, null) : null,
        ),

        /**
         * 提示条固定在底部。
         *
         * 之前是普通 div 放在内容最后——「接入」页很长，点了第 5 步的按钮，
         * 提示出现在屏幕外，看起来就是「点了没反应」。
         */
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
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, RoostPage))
      slots.inject('sidebar.panellist', () =>
        slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'Roost' }, RoostIcon),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.RoostPage = RoostPage
    exports.RoostIcon = RoostIcon
    /**
     * 导出给测试盯住。这个函数出过一次「拿配置端口冒充实际端口」的事故——
     * 语法合法、渲染不炸、测试全绿，但面板在撒谎。纯函数才能被断言。
     */
    exports.portView = portView
    return module.exports
  },
})
