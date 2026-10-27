// dsh-roost · 网页半边：侧栏「Roost」入口 + 整页面板
//
// 只读写宿主半边的 /roost/api/* 接口，不直接碰会话和 QQ。
//
// ── 关于配色（踩过的坑）─────────────────────────────────
// 第一版用了 `var(--dsw-alias-text-primary, #1f2328)` 这种写法。
// DSH 里并没有这个变量，于是全部退回到 #1f2328——近黑。
// 深色主题下整页文字等于隐形。
//
// 所以现在的规矩是：
//   · 文字一律 `color: inherit`，跟着宿主走，永远是对的
//   · 分隔线/底色用 `color-mix(currentColor …)` 从当前文字色推，
//     深浅主题都自动成立
//   · 只有状态色（成功/警告/失败）需要判断明暗——挂个 data-dark 属性切换
//   · 明暗不是猜的：往上找第一个不透明祖先，量它的背景亮度
//
// 设计取向：这是一块**仪表盘**，不是营销页。
// 首屏回答一个问题「我卡在哪一步」，用一条竖直的归途路径表达进度。

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
     * 完全看不出是哪个接口、什么状态码——之前就因此只能显示「连不上插件」，
     * 查了半天。现在把状态码和路径都带上，回的不是 JSON 也把前 80 字打出来。
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
      return Math.round(s / 3600) + ' 小时前'
    }

    /* ---------------- 明暗判定 ---------------- */

    /**
     * 我在什么底色上？
     *
     * 从根节点往上找第一个「真的有不透明背景」的祖先，算它的亮度。
     * 比 `prefers-color-scheme` 靠谱：DSH 的主题是它自己管的，
     * 系统浅色、应用深色这种组合很常见。
     */
    function useDark(ref) {
      const [dark, setDark] = useState(false)
      useEffect(() => {
        const measure = () => {
          let node = ref.current
          while (node && node !== document.documentElement) {
            const bg = getComputedStyle(node).backgroundColor || ''
            const m = bg.match(/rgba?\(([^)]+)\)/)
            if (m) {
              const [r, g, b, a = 1] = m[1].split(',').map(Number)
              if (a > 0.1) {
                setDark(0.2126 * r + 0.7152 * g + 0.0722 * b < 128)
                return
              }
            }
            node = node.parentElement
          }
          const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
          setDark(Boolean(mq?.matches))
        }
        measure()
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
        mq?.addEventListener?.('change', measure)
        return () => mq?.removeEventListener?.('change', measure)
      }, [ref])
      return dark
    }

    /* ---------------- 样式表 ---------------- */

    function useStyle() {
      useEffect(() => {
        if (document.getElementById('roost-style')) return
        const el = document.createElement('style')
        el.id = 'roost-style'
        el.textContent = `
.roost-root{
  color:inherit;font-size:13px;line-height:1.62;
  --line:color-mix(in srgb, currentColor 22%, transparent);
  --line-soft:color-mix(in srgb, currentColor 12%, transparent);
  --surface:color-mix(in srgb, currentColor 6%, transparent);
  --field:color-mix(in srgb, currentColor 9%, transparent);
  --ok:#12855a; --warn:#b45309; --bad:#b42318; --accent:#2563eb;
}
.roost-root[data-dark="1"]{
  --ok:#34d399; --warn:#fbbf24; --bad:#f87171; --accent:#3b82f6;
}
.roost-dim{opacity:.66}
.roost-mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all}
.roost-card{border:1px solid var(--line-soft);border-radius:10px;padding:14px 16px;margin-bottom:12px;background:var(--surface)}
.roost-btn{
  padding:5px 12px;border-radius:7px;border:1px solid var(--line);background:transparent;
  color:inherit;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;
  transition:background .14s ease,border-color .14s ease;
}
.roost-btn:hover:not(:disabled){background:var(--field)}
.roost-btn:disabled{opacity:.4;cursor:not-allowed}
.roost-primary{
  padding:7px 16px;border-radius:7px;border:1px solid transparent;background:var(--accent);
  color:#fff;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;
  transition:filter .14s ease;
}
.roost-primary:hover:not(:disabled){filter:brightness(1.08)}
.roost-primary:disabled{opacity:.55;cursor:not-allowed}
.roost-input{
  width:100%;box-sizing:border-box;padding:7px 10px;border-radius:7px;
  border:1px solid var(--line);background:var(--field);color:inherit;font:inherit;font-size:13px;
}
.roost-input::placeholder{color:color-mix(in srgb, currentColor 42%, transparent)}
.roost-input:focus{outline:2px solid color-mix(in srgb, var(--accent) 55%, transparent);outline-offset:-1px}
.roost-tab{
  padding:8px 14px;border:none;border-bottom:2px solid transparent;background:transparent;
  color:inherit;opacity:.6;cursor:pointer;font:inherit;font-size:13px;margin-bottom:-1px;
  transition:opacity .14s ease,border-color .14s ease;
}
.roost-tab:hover{opacity:.9}
.roost-tab[data-on="1"]{opacity:1;font-weight:600;border-bottom-color:var(--accent)}

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
.roost-desc{opacity:.66;font-size:12px;margin-top:2px}
.roost-fade{animation:roost-in .22s cubic-bezier(.2,.8,.2,1)}
@keyframes roost-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}

/* —— 功能页：分节账本 ——
   刻意不堆卡片：DSH 自己是深色仪表盘，一层层圆角方块会把宿主原有的层次压平。
   分节靠「序号 + 标题 + 一条细线」，条目靠上边线分隔，只有情绪用条形图。 */
.roost-sec{margin:22px 0 0}
.roost-sec:first-child{margin-top:2px}
.roost-sec-h{display:flex;align-items:baseline;gap:9px;margin-bottom:10px}
.roost-sec-n{font-size:10.5px;opacity:.38;font-variant-numeric:tabular-nums}
.roost-sec-t{font-size:13px;font-weight:600;letter-spacing:.01em;flex-shrink:0}
.roost-sec-h::after{content:'';flex:1;height:1px;background:var(--line-soft);transform:translateY(-2px)}
.roost-note{font-size:11.5px;line-height:1.62;opacity:.55;margin-top:4px}
.roost-empty{font-size:12px;line-height:1.65;opacity:.55;padding:4px 0}
.roost-row{display:flex;gap:14px;padding:11px 0;border-top:1px solid var(--line-soft)}
.roost-row:first-of-type{border-top:none;padding-top:2px}
.roost-k{flex:0 0 58px;font-size:12px;opacity:.55;padding-top:1px}
.roost-v{flex:1;min-width:0}
.roost-v-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}

/* 情绪条：双向的从中线往两边长，单向的从左边长。数字不显示，形态就是信息 */
.roost-mood{display:flex;flex-direction:column;gap:8px;margin-bottom:2px}
.roost-mood-row{display:flex;align-items:center;gap:10px}
.roost-mood-k{flex:0 0 42px;font-size:11.5px;opacity:.55}
.roost-mood-w{flex:0 0 52px;text-align:right;font-size:11.5px;opacity:.8}
.roost-bar{position:relative;flex:1;height:6px;border-radius:3px;background:color-mix(in srgb,currentColor 8%,transparent)}
/* 双向条的中性区：给「0」一个可见的位置，否则中性看起来像没渲染出来 */
.roost-bar-zone{position:absolute;left:42%;width:16%;top:0;bottom:0;background:color-mix(in srgb,currentColor 14%,transparent)}
.roost-bar-fill{position:absolute;top:0;bottom:0;z-index:1;border-radius:3px;background:color-mix(in srgb,currentColor 42%,transparent);
  transition:left .5s cubic-bezier(.16,1,.3,1),width .5s cubic-bezier(.16,1,.3,1)}
/* 游标：当前位置。中性时它停在中性区中间，这才读得出「在中间」 */
.roost-bar-knob{position:absolute;top:0;bottom:0;z-index:2;width:3px;margin-left:-1.5px;border-radius:2px;
  background:currentColor;opacity:.8;transition:left .5s cubic-bezier(.16,1,.3,1)}

/* 文字按钮：次要操作一律降权，整页不设 primary —— 没有哪个动作值得抢焦点 */
.roost-link{border:none;background:none;color:inherit;font:inherit;font-size:11.5px;padding:0;opacity:.5;cursor:pointer;transition:opacity .12s}
.roost-link:hover:not(:disabled){opacity:.92;text-decoration:underline;text-underline-offset:2px}
.roost-link:disabled{opacity:.25;cursor:not-allowed}
.roost-link-warn{opacity:1;color:var(--bad);text-decoration:underline;text-underline-offset:2px}
.roost-chip{padding:3px 9px;border-radius:999px;border:1px solid var(--line-soft);background:transparent;color:inherit;
  font:inherit;font-size:11.5px;cursor:pointer;opacity:.7;transition:opacity .12s,background .12s,border-color .12s}
.roost-chip:hover{opacity:1;background:var(--field)}
.roost-chip[data-on="1"]{opacity:1;font-weight:600;border-color:transparent;background:color-mix(in srgb,currentColor 15%,transparent)}
.roost-switch{position:relative;flex:0 0 32px;width:32px;height:17px;padding:0;border-radius:9px;border:1px solid var(--line);
  background:transparent;color:inherit;cursor:pointer;transition:background .16s ease,border-color .16s ease}
.roost-switch::after{content:'';position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:currentColor;
  opacity:.7;transition:transform .18s cubic-bezier(.2,.8,.2,1),opacity .18s}
.roost-switch[data-on="1"]{border-color:transparent;background:color-mix(in srgb,currentColor 22%,transparent)}
.roost-switch[data-on="1"]::after{transform:translateX(15px);opacity:.95}
.roost-list{display:flex;flex-direction:column}
.roost-fact{display:flex;align-items:flex-start;gap:8px;padding:4px 0;font-size:12px;line-height:1.55}
.roost-fact-x{flex:0 0 auto;border:none;background:none;color:inherit;font:inherit;font-size:13px;line-height:1;padding:3px 4px;
  opacity:.22;cursor:pointer;transition:opacity .12s,color .12s}
.roost-fact:hover .roost-fact-x{opacity:.55}
.roost-fact-x:hover{opacity:1;color:var(--bad)}
.roost-add{display:flex;gap:6px;align-items:center;margin-top:10px}

/* 键盘用户也要看得见焦点：只给按钮加环，输入框已有自己的处理 */
.roost-root button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

@media (prefers-reduced-motion: reduce){
  .roost-node.current::after{animation:none}
  .roost-fade{animation:none}
  .roost-bar-fill{transition:none}
  .roost-bar-knob{transition:none}
}
`
        document.head.appendChild(el)
      }, [])
    }

    /* ---------------- 控件 ---------------- */

    const Field = ({ label, desc, children }) =>
      h('label', { style: { display: 'block', marginBottom: 14 } },
        h('div', { style: { marginBottom: 5, fontWeight: 550, fontSize: 12.5 } }, label),
        children,
        desc ? h('div', { className: 'roost-desc' }, desc) : null,
      )

    const Step = ({ n, state, title, desc, children }) =>
      h('div', { className: 'roost-step ' + state },
        h('div', { className: 'roost-rail' }),
        h('div', { className: 'roost-node ' + state }, state === 'done' ? '✓' : state === 'bad' ? '!' : n),
        h('div', { className: 'roost-body' },
          h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } },
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'roost-title' }, title),
              desc ? h('div', { className: 'roost-desc' }, desc) : null,
            ),
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 } }, children),
          ),
        ),
      )

    /* ---------------- 一键流程 ---------------- */

    function SetupTab({ st, reload, toast, busy, run }) {
      const [appId, setAppId] = useState('')
      const [secret, setSecret] = useState('')
      const [pathOpen, setPathOpen] = useState(false)
      /** 第 5 步的结果，直接显示在步骤下面 */
      const [cfgMsg, setCfgMsg] = useState('')
      const [dir, setDir] = useState('')

      /**
       * 扫码建机器人。
       *
       * 协议、密钥、二维码全在框架那边（/api/bots/qr/*），
       * 这里只负责发起、显示、轮询，拿到就把 AppID / AppSecret 填进输入框。
       * 手填那条路一点没动——扫码失败、已有机器人、想直接粘 key 都还能用。
       */
      const [qrSvg, setQrSvg] = useState('')
      const [qrTip, setQrTip] = useState('')
      const qrTimer = useRef(null)

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
            setQrTip(`✓ 已拿到 AppID ${r.appId}，点下面「保存」就行`)
          } else {
            setQrSvg('')
            setQrTip(r.message || '二维码过期了，重新生成一个')
          }
        },
        [stopQr],
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

      const s = {
        install: st.installed ? 'done' : 'current',
        bot: st.hasBot ? 'done' : st.installed ? 'current' : 'todo',
        start: st.running ? 'done' : st.hasBot ? 'current' : 'todo',
        plugin: st.pluginInstalled ? 'done' : st.running ? 'current' : 'todo',
        configure: st.pluginConfigured ? 'done' : st.pluginInstalled ? 'current' : 'todo',
        ready: st.pluginConfigured ? 'done' : 'todo',
      }

      const copy = (t) => {
        try {
          navigator.clipboard?.writeText(t)
          toast('已复制')
        } catch {
          toast('复制失败，手动选一下吧')
        }
      }

      const bindDir = async () => {
        const r = await post('/setup/dir', { dir })
        toast(r.ok ? '已绑定' : r.message)
        if (r.ok) setPathOpen(false)
        reload()
      }

      return h('div', null,

        h('div', { className: 'roost-card', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('div', null,
            h('div', { style: { fontWeight: 600 } }, st.pluginConfigured ? '链路已就绪' : '还没配好'),
            h('div', { className: 'roost-desc' }, st.pluginConfigured
              ? '群里说一句话试试。没反应就看下面的「常见卡点」。'
              : '点右边的按钮，能自动做的都会做掉。'),
          ),
          h('button', { className: 'roost-primary', disabled: Boolean(busy), onClick: () => run({ appId, secret }) },
            busy ? busy + '…' : st.pluginConfigured ? '重新检查' : '一键就绪'),
        ),

        h('div', { style: { padding: '4px 2px 0' } },

          h(Step, {
            n: 1, state: s.install, title: '装 Roost',
            desc: st.installed ? `已装 v${st.version || '?'}` : '下载解压就行——Roost 零依赖，不用 npm install',
          },
            st.installed
              ? h('button', { className: 'roost-btn', onClick: () => setPathOpen((v) => !v) }, pathOpen ? '收起' : '更改路径')
              : h('button', { className: 'roost-btn', onClick: () => setPathOpen((v) => !v) }, pathOpen ? '收起' : '改路径'),
            st.installed
              ? null
              : h('button', {
                  className: 'roost-btn',
                  disabled: Boolean(busy),
                  onClick: async () => {
                    /**
                     * 装了自定义路径就先落盘再下载。
                     * 不先存的话 install() 还会按旧的 dirOf() 装到默认位置。
                     */
                    const want = (dir || '').trim()
                    if (want && want !== st.dir) {
                      const r = await post('/setup/dir', { dir: want })
                      if (r.ok === false) return toast(r.message || '路径不可用')
                    }
                    run({ only: 'install' })
                  },
                }, '安装'),
          ),

          /* 路径：装之前选装到哪，装完也能改（改了要重启才生效） */
          pathOpen
            ? h('div', { style: { marginTop: -10, marginBottom: 16, paddingLeft: 40, maxWidth: 470 } },
                h('div', { className: 'roost-desc', style: { marginBottom: 6 } },
                  st.installed
                    ? '换到别的目录（里面要有 src/main.js）。改完要重启 Roost 才生效'
                    : `装到哪。默认 ${st.dir || '（数据目录下的 roost）'}，留空就用默认`),
                h('div', { style: { display: 'flex', gap: 6 } },
                  h('input', {
                    className: 'roost-input',
                    placeholder: st.dir || 'D:\\bots\\qq-bot-roost',
                    value: dir,
                    onChange: (e) => setDir(e.target.value),
                  }),
                  h('button', { className: 'roost-btn', disabled: !dir || Boolean(busy), onClick: bindDir },
                    st.installed ? '更改' : '绑定'),
                ),
              )
            : null,

          st.installed
            ? h('div', { className: 'roost-mono roost-dim', style: { marginTop: -12, marginBottom: 14, paddingLeft: 40 } }, st.dir)
            : null,

          h(Step, {
            n: 2, state: s.bot, title: '填 AppID / AppSecret',
            desc: '推荐扫码一键创建；也可以去开放平台手动复制',
          }),
          st.hasBot
            ? h('div', { className: 'roost-mono roost-dim', style: { marginTop: -12, marginBottom: 14, paddingLeft: 40 } },
                '已配置：' + st.bots.map((b) => `${b.name}（${b.appId || '无 AppID'}）`).join('、'))
            : h('div', { style: { marginTop: -8, marginBottom: 18, paddingLeft: 40, maxWidth: 420 } },
                h('button', { className: 'roost-primary', style: { width: '100%' }, onClick: startQr }, '扫码一键创建'),
                h('div', { className: 'roost-desc', style: { marginTop: 6, marginBottom: 12 } },
                  '手机 QQ 扫一下，AppID / AppSecret 自动填好（要 Roost 在跑）'),

                qrSvg
                  ? h('div', {
                      style: { background: '#fff', padding: 8, borderRadius: 10, lineHeight: 0, marginBottom: 8 },
                      // 服务端已经画好 SVG，这里直接塞进去，前端不用带 QR 库
                      dangerouslySetInnerHTML: { __html: qrSvg },
                    })
                  : null,
                qrTip ? h('div', { className: 'roost-desc', style: { marginBottom: 10 } }, qrTip) : null,

                h('div', { className: 'roost-desc', style: { margin: '4px 0 8px', opacity: 0.7 } },
                  '—— 或者手动填（已有机器人、或扫码用不了时）——'),
                h('input', { className: 'roost-input', style: { marginBottom: 8 }, placeholder: 'AppID', value: appId, onChange: (e) => setAppId(e.target.value) }),
                h('input', { className: 'roost-input', style: { marginBottom: 8 }, placeholder: 'AppSecret', type: 'password', value: secret, onChange: (e) => setSecret(e.target.value) }),
                h('button', {
                  className: 'roost-btn', disabled: !appId || !secret || Boolean(busy),
                  onClick: async () => {
                    const r = await post('/setup/bot', { name: 'main', appId, secret })
                    toast(r.ok ? '已写入配置' : r.message)
                    reload()
                  },
                }, '保存'),
              ),

          h(Step, {
            n: 3, state: s.start, title: '启动 Roost',
            desc: st.running ? `在跑，面板 ${st.port}` : `启动后它的面板在本机 ${st.port}`,
          },
            st.running
              ? h('button', { className: 'roost-btn', onClick: () => window.open(st.webui, '_blank', 'noopener') }, '打开面板')
              : h('button', { className: 'roost-btn', disabled: !st.hasBot || Boolean(busy), onClick: () => run({ only: 'start' }) }, '启动'),
          ),

          h(Step, {
            n: 4, state: s.plugin, title: '装 ai-chat 插件',
            desc: st.pluginInstalled ? '已装' : 'Roost 那边负责收发 QQ 消息的插件',
          },
            st.pluginInstalled
              ? null
              : h('button', { className: 'roost-btn', disabled: !st.running || Boolean(busy), onClick: () => run({ only: 'plugin' }) }, '安装'),
          ),

          h(Step, {
            n: 5, state: s.configure, title: '切到 DSH 适配器',
            desc: st.pluginConfigured
              ? `ai-chat 已经指向 ${st.pluginConfig?.dshUrl || st.dshUrl}`
              : '把 ai-chat 的「交给谁去想」改成 DSH，并填好回话地址',
          },
            /**
             * 永远给个能点的按钮。
             *
             * 之前「已配置就隐藏、没装插件就禁用」，两种情况下点下去都毫无反应，
             * 用户根本不知道发生了什么。现在一律可点，不能做就在提示里说清楚。
             */
            h('button', {
              className: 'roost-btn',
              disabled: Boolean(busy),
              onClick: async () => {
                if (!st.pluginInstalled) {
                  setCfgMsg('✗ 还没装 ai-chat 插件，先走第 4 步')
                  return toast('先装 ai-chat 插件（第 4 步）')
                }
                if (!st.running) {
                  setCfgMsg(`✗ Roost 没在跑（${st.webui || '面板端口'} 连不上），先点第 3 步的「启动」`)
                  return toast('Roost 没在跑，先启动（第 3 步）')
                }
                /**
                 * 直接把结果显示在这一步下面。
                 *
                 * 光靠底部提示条不够——用户点了以后眼睛盯着按钮，
                 * 得让他不用移开视线就能看到成没成、为什么没成。
                 */
                setCfgMsg('正在切换…')
                const r = await post('/setup/configure', {})
                setCfgMsg(r.ok ? `✓ ${r.message || '已切换'}` : `✗ ${r.message || '切换失败'}`)
                toast(r.ok ? r.message || '已切换' : r.message || '切换失败')
                reload()
              },
            }, st.pluginConfigured ? '重新配置' : '配置'),
          ),

          cfgMsg
            ? h('div', {
                className: 'roost-mono',
                style: {
                  marginTop: -10, marginBottom: 14, paddingLeft: 40,
                  color: cfgMsg.startsWith('✗') ? 'var(--bad)' : cfgMsg.startsWith('✓') ? 'var(--ok)' : 'inherit',
                },
              }, cfgMsg)
            : null,

          h(Step, {
            n: 6, state: s.ready, title: '在群里说句话',
            desc: st.pluginConfigured
              ? '还差两件手工的事：开放平台开「接收所有消息」，机器人先进群'
              : '前面五步走完就能试了',
          },
            st.pluginConfigured
              ? h('button', { className: 'roost-btn', onClick: () => window.open('https://q.qq.com', '_blank', 'noopener') }, '开放平台')
              : null,
          ),
        ),

        h('div', { className: 'roost-card', style: { marginTop: 6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '常见卡点'),
          h('ul', { className: 'roost-desc', style: { margin: 0, paddingLeft: 18 } },
            h('li', null, `启动后马上退出：多半是 AppID/AppSecret 填错了，或 ${st.port} 被占`),
            h('li', null, '群里没反应：开放平台没开「接收所有消息」，或机器人不在群里'),
            h('li', null, '有反应但答非所问：ai-chat 的「什么时候接话」被设成了「只在被 @ 时」'),
          ),
        ),
      )
    }

    /* ---------------- 概览 ---------------- */

    const Stat = ({ n, label, tone }) =>
      h('div', { className: 'roost-card', style: { margin: 0, padding: '12px 14px' } },
        h('div', {
          style: {
            fontSize: 20, fontWeight: 650, letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            color: tone === 'bad' ? 'var(--bad)' : tone === 'ok' ? 'var(--ok)' : 'inherit',
          },
        }, n),
        h('div', { className: 'roost-desc', style: { marginTop: 1 } }, label),
      )

    /** 一行状态提示：只在真有问题时出现 */
    function Banner({ st }) {
      if (!st.listening) {
        return h('div', { className: 'roost-card', style: { borderColor: 'var(--bad)' } },
          h('b', null, '宿主没在听。'),
          h('span', { className: 'roost-desc' },
            ` 端口 ${st.port} 没起来，ai-chat 推过来的消息会全部失败。`
            + (st.serverError ? `原因：${st.serverError}。` : '')
            + ' 重启 DSH 让端口释放，或者去「接入」看看。'))
      }
      if (!st.chats) {
        return h('div', { className: 'roost-card' },
          h('b', null, '还没有 QQ 会话接进来。'),
          h('span', { className: 'roost-desc' }, ' 在群里说一句话就会自动建一个。没说之前这里当然是空的。'))
      }
      if (st.lastTurn && !st.lastTurn.ok) {
        return h('div', { className: 'roost-card', style: { borderColor: 'var(--bad)' } },
          h('b', null, '最近一轮失败了。'),
          h('span', { className: 'roost-desc' }, ` ${st.lastTurn.error} —— 细节看「日志」。`))
      }
      return null
    }

    /**
     * 端口怎么显示。
     *
     * 配置是**意愿**，实际 bind 的是**现实**，被占后会顺延。
     * 「配置 17321，实际 17322」必须让用户看见——否则他按 17321 去连，
     * 怎么都连不上还以为是插件坏了。
     */
    const portCell = (st) => {
      const actual = st?.actualPort
      if (!actual) return st?.port ?? '—'
      return st.wantPort && st.wantPort !== actual ? `${actual}（配置 ${st.wantPort}，被占了）` : String(actual)
    }

    function OverviewTab({ st, setupSt, toast, reload }) {
      const [logs, setLogs] = useState(null)
      const perms = st.permissions || {}
      const toolable = ['owner', 'admin', 'member'].filter((k) => perms[k] === 'all')
      const lt = st.lastTurn

      useEffect(() => {
        let alive = true
        const load = () => get('/logs?limit=6').then((r) => alive && setLogs(r.entries || []))
        load()
        const t = setInterval(load, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      const selftest = async () => {
        toast('正在自测…')
        const r = await post('/selftest', {})
        toast(r.ok ? `自测通过（${r.ms}ms）：${String(r.reply).slice(0, 40)}` : `自测失败：${r.message}`)
      }

      return h('div', null,
        h(Banner, { st }),

        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, marginBottom: 12 } },
          h(Stat, { n: st.chats ?? 0, label: 'QQ 会话' }),
          h(Stat, { n: st.waiting ?? 0, label: '正在等回复' }),
          h(Stat, {
            n: lt ? `${lt.ms}ms` : '—',
            label: lt ? (lt.ok ? `最近一轮回了 ${lt.len} 字` : '最近一轮失败') : '还没跑过',
            tone: lt ? (lt.ok ? 'ok' : 'bad') : null,
          }),
          h(Stat, { n: toolable.length ? toolable.length : 1, label: '能用本地工具的档位' }),
        ),

        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '快捷操作'),
          h('div', { className: 'roost-desc', style: { marginBottom: 10 } },
            '自测不经过 QQ，直接跑一轮 DSH 对话——验的是「会话建得起来、AI 回得来」。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { className: 'roost-primary', onClick: selftest }, '跑一次自测'),
            h('button', {
              className: 'roost-btn',
              disabled: !st.listening,
              onClick: () => {
                // Roost 面板的地址来自 /setup（它有真实的 webui 端口），
                // 不是 st.port——那是 dsh-roost 自己的监听端口，打开是错的网页
                const url = setupSt?.webui;
                if (url) window.open(url, '_blank', 'noopener');
                else toast('还没装好 Roost，没有面板可开');
              },
            }, '打开 Roost 面板 ↗'),
            h('button', { className: 'roost-btn', onClick: reload }, '刷新'),
          ),
        ),

        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '最近动态'),
          logs === null
            ? h('div', { className: 'roost-desc' }, '读取中…')
            : logs.length === 0
              ? h('div', { className: 'roost-desc' }, '还没有动静。群里说句话，或者跑一次自测。')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  logs.slice(-6).reverse().map((e, i) =>
                    h('div', { key: i, style: { display: 'flex', gap: 8, fontSize: 12 } },
                      h('span', { className: 'roost-mono roost-dim', style: { flexShrink: 0 } }, e.time),
                      h('span', {
                        style: {
                          flexShrink: 0, width: 6, height: 6, borderRadius: 9, marginTop: 7,
                          background: e.level === 'error' ? 'var(--bad)' : e.level === 'warn' ? 'var(--warn)' : 'var(--ok)',
                        },
                      }),
                      h('span', { style: { opacity: e.level === 'error' ? 1 : 0.85 } }, e.text),
                    ),
                  ),
                ),
        ),

        /* —— 端口：全部来自配置，列出来方便核对 —— */
        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '端口'),
          [
            ['dsh-roost 监听', portCell(st), 'dsh-roost 的 server.port（实际 bind 的）'],
            ['Roost 面板', setupSt?.port ?? '—', 'Roost 的 webui.port（实际 bind 的）'],
            ['ai-chat 指向', setupSt?.pluginConfig?.dshUrl || '未配置', 'ai-chat 的 dshUrl，应等于监听端口'],
          ].map(([k, v, why]) =>
            h('div', { key: k, style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' } },
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontSize: 12.5 } }, k),
                h('div', { className: 'roost-desc', style: { marginTop: 0 } }, why),
              ),
              h('span', { className: 'roost-mono', style: { flexShrink: 0 } }, String(v)),
            ),
          ),
          (() => {
            // 比对用**实际端口**，不是配置里的——配置是意愿，实际可能被占后顺延了
            const actual = st.actualPort || st.port
            const want = `http://127.0.0.1:${actual}`
            const got = setupSt?.pluginConfig?.dshUrl
            if (!got) return h('div', { className: 'roost-desc', style: { marginTop: 6 } }, 'ai-chat 还没配，去「接入」第 5 步')
            return got === want
              ? h('div', { className: 'roost-desc', style: { marginTop: 6, color: 'var(--ok)' } }, '✓ 两端端口一致')
              : h('div', { className: 'roost-desc', style: { marginTop: 6, color: 'var(--bad)' } },
                  `✗ 对不上：ai-chat 指向 ${got}，我们监听 ${want}。消息推不过来，去「接入」第 5 步重新配置。`)
          })(),
        ),
      )
    }

    /* ---------------- 日志 ---------------- */

    function LogsTab() {
      const [items, setItems] = useState(null)
      const [level, setLevel] = useState('')
      const [auto, setAuto] = useState(true)

      const load = useCallback(
        () => get('/logs?limit=300' + (level ? '&level=' + level : '')).then((r) => setItems(r.entries || [])),
        [level],
      )

      useEffect(() => {
        load()
        if (!auto) return
        const t = setInterval(load, 3000)
        return () => clearInterval(t)
      }, [load, auto])

      return h('div', { className: 'roost-card' },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 } },
          h('div', { style: { fontWeight: 600 } }, '日志'),
          h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
            h('select', {
              className: 'roost-input', style: { width: 110 },
              value: level, onChange: (e) => setLevel(e.target.value),
            },
              h('option', { value: '' }, '全部'),
              h('option', { value: 'info' }, '一般'),
              h('option', { value: 'warn' }, '警告'),
              h('option', { value: 'error' }, '错误'),
            ),
            h('button', { className: 'roost-btn', onClick: () => setAuto((v) => !v) }, auto ? '暂停刷新' : '自动刷新'),
            h('button', { className: 'roost-btn', onClick: load }, '刷新'),
          ),
        ),
        h('div', { className: 'roost-desc', style: { marginBottom: 10 } },
          '内存里保留最近 400 条，DSH 重启就清空。完整日志在 DSH 自己的日志里。'),
        items === null
          ? h('div', { className: 'roost-desc' }, '读取中…')
          : items.length === 0
            ? h('div', { className: 'roost-desc' }, '没有符合条件的日志')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 460, overflowY: 'auto' } },
                items.slice().reverse().map((e, i) =>
                  h('div', { key: i, style: { display: 'flex', gap: 8, fontSize: 12 } },
                    h('span', { className: 'roost-mono roost-dim', style: { flexShrink: 0 } }, e.time),
                    h('span', {
                      style: {
                        flexShrink: 0, width: 6, height: 6, borderRadius: 9, marginTop: 7,
                        background: e.level === 'error' ? 'var(--bad)' : e.level === 'warn' ? 'var(--warn)' : 'var(--ok)',
                      },
                    }),
                    h('span', { style: { opacity: e.level === 'error' ? 1 : 0.85 } }, e.text),
                  ),
                ),
              ),
      )
    }

    /* ---------------- 功能：她现在 / 她记得 / 她能做 ---------------- */

    /**
     * 这一页不按「能力清单」排，按用户真正会问的三个问题排：
     *   ① 她现在什么状态 —— 情绪，只读
     *   ② 她记得什么     —— 两层记忆，能加能删
     *   ③ 她能做什么     —— 人格 / 表情 / 搭话 / 授权
     *
     * 为什么改：原来四张卡（人格 / 表情 / 语音 / 搭话）是「后端有什么就列什么」，
     * 用户看完仍然不知道她此刻在想什么、记住了什么。能力是**手段**，状态才是他想知道的。
     *
     * 视觉上刻意**不堆卡片**：DSH 自己是深色仪表盘，一层层圆角方块摞起来会把
     * 宿主原本的层次压平。这里用「分节 + 细线」的账本式排版，只有情绪用条形图——
     * 数字（0.35 / 0.80）用户不关心，形态才说明问题。
     */

    /** 三个维度怎么翻成人话。阈值和 mood.js 的注入语气对齐，别各说各的 */
    const MOOD = [
      {
        key: 'valence', label: '心情', bi: true,
        words: [[0.5, '很好'], [0.15, '还不错'], [-0.15, '一般'], [-0.5, '有点烦'], [-9, '很烦']],
      },
      {
        key: 'energy', label: '精力',
        words: [[0.75, '很足'], [0.45, '还行'], [0.25, '有点累'], [-9, '很累']],
      },
      {
        key: 'sociability', label: '想聊天',
        words: [[0.75, '很想'], [0.45, '一般'], [0.25, '不太想'], [-9, '想安静']],
      },
    ]

    const wordOf = (v, words) => (words.find(([t]) => v > t) || words[words.length - 1])[1]

    const SCOPE_LABEL = { group_push: '群聊主动', c2c_push: '私聊主动' }

    const Sec = ({ n, title, children }) =>
      h('section', { className: 'roost-sec' },
        h('div', { className: 'roost-sec-h' },
          h('span', { className: 'roost-sec-n' }, n),
          h('span', { className: 'roost-sec-t' }, title),
        ),
        children,
      )

    const Row = ({ k, children }) =>
      h('div', { className: 'roost-row' },
        h('div', { className: 'roost-k' }, k),
        h('div', { className: 'roost-v' }, children),
      )

    /**
     * 破坏性操作用「点两次」代替弹窗。
     *
     * 弹窗会被无脑点掉（impeccable 那条：Undo > Confirm），但这几件事没有 undo——
     * 记忆清掉就没了。折中：第一次点变成「确认？」，3.5 秒不点自己退回。
     * 比弹窗轻，又比直接执行安全。
     */
    function ConfirmLink({ label, confirmLabel, onConfirm, disabled }) {
      const [armed, setArmed] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => clearTimeout(timer.current), [])
      return h('button', {
        type: 'button',
        className: 'roost-link' + (armed ? ' roost-link-warn' : ''),
        disabled: Boolean(disabled),
        onClick: () => {
          if (armed) {
            clearTimeout(timer.current)
            setArmed(false)
            onConfirm()
          } else {
            setArmed(true)
            timer.current = setTimeout(() => setArmed(false), 3500)
          }
        },
      }, armed ? confirmLabel || '确认？' : label)
    }

    /**
     * 一行情绪条：双向的（心情）从中线往两边长，单向的从左边长。
     *
     * **零态最容易画错**：valence≈0 时填充宽度是 0，之前用「最小 1.2% 宽度」
     * 兜底，结果是一块浮在中线上的小方块——看着像渲染坏了，而不是「她心情一般」。
     *
     * 现在的画法：条上永远有一个游标表示「现在在哪」，双向条中间再加一段淡的中性区。
     * 中性时游标停在中性区里，读作「在中间」；单向条游标停在填充的右端，读作「到这儿」。
     * 两种条因此是同一套视觉语言，不再是「一条有方块、两条有长条」。
     */
    function MoodBar({ v, bi }) {
      const x = bi ? (v + 1) / 2 : v
      const left = bi ? Math.min(0.5, x) : 0
      const width = bi ? Math.abs(x - 0.5) : x
      // 游标别贴死在两端，否则会被圆角裁掉一半
      const knob = Math.min(0.988, Math.max(0.012, x))
      return h('div', { className: 'roost-bar', 'aria-hidden': 'true' },
        bi ? h('span', { className: 'roost-bar-zone' }) : null,
        h('span', {
          className: 'roost-bar-fill',
          style: { left: left * 100 + '%', width: width * 100 + '%' },
        }),
        h('span', { className: 'roost-bar-knob', style: { left: knob * 100 + '%' } }),
      )
    }

    function MoodBlock({ mood }) {
      if (!mood) {
        return h('div', { className: 'roost-empty' },
          '读不到情绪——插件刚起来时这里会空几秒，等一下再看。')
      }
      return h('div', null,
        h('div', { className: 'roost-mood' },
          MOOD.map((m) => {
            const v = Math.max(-1, Math.min(1, Number(mood[m.key] ?? 0)))
            return h('div', { key: m.key, className: 'roost-mood-row' },
              h('span', { className: 'roost-mood-k' }, m.label),
              h(MoodBar, { v, bi: m.bi }),
              h('span', { className: 'roost-mood-w' }, wordOf(v, m.words)),
            )
          }),
        ),
        h('div', { className: 'roost-note' },
          mood.reason ? '原因：' + mood.reason : '还没被什么事影响过',
          mood.updatedAt ? ' · ' + ago(mood.updatedAt) : '',
        ),
        h('div', { className: 'roost-note' },
          '心情左边是差、右边是好；另两条从左到右是程度。这三项只决定她接不接话、说多长，不会当成数字喂给模型；没人理她，几小时后会自己回到中间。'),
      )
    }

    /** 一层记忆：标题 + 条目 + 清空 */
    function MemLayer({ title, hint, items, onForget, onClear, empty }) {
      return h('div', { style: { marginBottom: 16 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 } },
          h('span', { style: { fontSize: 12, fontWeight: 600, flexShrink: 0 } }, title),
          h('span', { className: 'roost-note', style: { marginTop: 0, flex: 1, minWidth: 0 } }, hint),
          items.length
            ? h(ConfirmLink, { label: '清空', confirmLabel: '确认清空？', onConfirm: onClear })
            : null,
        ),
        items.length
          ? h('div', { className: 'roost-list' },
              items.map((f, i) =>
                h('div', { key: i, className: 'roost-fact' },
                  h('span', { style: { flex: 1, minWidth: 0 } }, f),
                  h('button', {
                    type: 'button', className: 'roost-fact-x',
                    title: '忘掉这条', 'aria-label': '忘掉这条',
                    onClick: () => onForget(f),
                  }, '×'),
                ),
              ),
            )
          : h('div', { className: 'roost-empty' }, empty),
      )
    }

    function MemoryBlock({ mem, quick, reload, toast }) {
      const [fact, setFact] = useState('')
      const [scope, setScope] = useState('global')
      const [saving, setSaving] = useState(false)

      const g = mem?.global || []
      const c = mem?.chat || []
      const chatName = mem?.scene?.name || (mem?.scene?.kind === 'c2c' ? '当前私聊' : '本群')

      /**
       * 还没有任何会话进来时，chatId 是空串。
       * 这时选「本处」写进去，后端 `memory.add` 会因为没 chatId 直接返回 false，
       * 但接口照样回 ok——用户看到「记进这一处了」，其实什么都没存。
       * 所以这里不让他选，也不让他发。
       */
      const canChat = Boolean(mem?.chatId)
      const effScope = canChat ? scope : 'global'

      const add = async () => {
        const f = fact.trim()
        if (!f || saving) return
        if (effScope === 'chat' && !canChat) {
          toast('还没有会话进来，先记到「跨群」')
          return
        }
        setSaving(true)
        const body = { fact: f, scope: effScope }
        // 空 chatId 会被后端当成「就是这个会话」，宁可传对也不传空
        if (effScope === 'chat' && mem?.chatId) body.chatId = mem.chatId
        const r = await post('/memory/add', body)
        setSaving(false)
        if (r.ok === false) return toast(r.message || '没记上')
        setFact('')
        toast(effScope === 'chat' ? '记进这一处了' : '记进跨群了')
        reload()
      }

      const forget = async (text) => {
        const r = await quick('memory.remove', text)
        toast(r.ok ? r.message || '忘了' : r.message || '没删掉')
        reload()
      }

      const clearGlobal = async () => {
        const r = await quick('memory.clearGlobal')
        toast(r.message || '清空了')
        reload()
      }

      const clearChat = async () => {
        const r = await quick('memory.clear')
        toast(r.message || '清空了')
        reload()
      }

      if (!mem) return h('div', { className: 'roost-empty' }, '读取记忆…')

      return h('div', null,
        h(MemLayer, {
          title: '跨群',
          hint: `走到哪个群都带着 · ${g.length} 条`,
          items: g,
          onForget: forget,
          onClear: clearGlobal,
          empty: '还没有跨群记忆。关于「他是谁」的事应该放这儿。',
        }),
        h(MemLayer, {
          title: chatName,
          hint: mem.scene ? `只在这里生效 · ${c.length} 条` : `还没有消息进来 · ${c.length} 条`,
          items: c,
          onForget: forget,
          onClear: clearChat,
          empty: '这个会话还没记下什么。群里的梗、绰号、小圈子关系放这儿，不会串到别的群。',
        }),
        h('div', { className: 'roost-add' },
          h('input', {
            className: 'roost-input',
            value: fact,
            placeholder: '记一条，比如「他养了只叫豆豆的猫」',
            onChange: (e) => setFact(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') add()
            },
          }),
          h('select', {
            className: 'roost-input', style: { width: 84, flexShrink: 0 },
            value: effScope, onChange: (e) => setScope(e.target.value),
            'aria-label': '记到哪一层',
          },
            h('option', { value: 'global' }, '跨群'),
            h('option', { value: 'chat', disabled: !canChat }, '本处'),
          ),
          h('button', { className: 'roost-btn', disabled: !fact.trim() || saving, onClick: add },
            saving ? '记…' : '记住'),
        ),
        h('div', { className: 'roost-note' },
          canChat
            ? '在群里说「记住……」她也会自己记。删是按内容匹配的，两层一起删。'
            : '还没有会话进来，只能先记「跨群」；等这个群说过话，「本处」才能选。'),
      )
    }

    function FeaturesTab({ config, st, setupSt, toast, save, reload }) {
      const [personas, setPersonas] = useState(null)
      const [stickers, setStickers] = useState(null)
      const [sp, setSp] = useState(null)
      const [mem, setMem] = useState(null)
      const [pickPersona, setPickPersona] = useState(false)
      const [openSu, setOpenSu] = useState(false)

      const load = useCallback(() => {
        get('/personas').then((r) => setPersonas(r.ok === false ? null : r))
        get('/stickers').then((r) => setStickers(r.ok === false ? null : r))
        get('/speakup').then((r) => setSp(r.ok === false ? null : r))
        get('/memory').then((r) => setMem(r.ok === false ? null : r))
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 8000)
        return () => clearInterval(t)
      }, [load])

      /**
       * 快捷操作统一从这里走 `/quick`。
       *
       * 那个接口的第二道门是校验 `actor.bucket`——防的是「QQ 那边转过来的请求
       * 谎称自己是主人」。面板不是转发方，它就是主人自己在本机点的界面，
       * 所以这里如实标 owner；ai-chat 转发那条路一点没松。
       */
      const quick = useCallback(
        (op, arg) =>
          post('/quick', {
            op, arg,
            chatId: mem?.chatId || '',
            actor: { bucket: 'owner', openid: 'panel' },
          }),
        [mem?.chatId],
      )

      if (!config) return h('div', { className: 'roost-empty' }, '读取配置…')

      const p = config.persona || {}
      const su = config.speakUp || {}
      const setSu = (k, v) => save({ ...config, speakUp: { ...su, [k]: v } })

      const byChat = personas?.byChat || {}
      const curId = byChat[mem?.chatId] || p.current || 'default'
      const curPersona = personas?.personas?.find((x) => x.id === curId)
      const byChatCount = Object.keys(byChat).length
      const override = mem?.personaOverride || ''
      const authz = mem?.authz
      const tts = setupSt?.pluginConfig?.ttsVoice

      const pick = (id) => save({ ...config, persona: { ...p, current: id } })

      return h('div', null,

        /* —— ① 状态 —— */
        h(Sec, { n: '①', title: '她现在什么状态' },
          h(MoodBlock, { mood: st?.mood }),
        ),

        /* —— ② 记忆 —— */
        h(Sec, { n: '②', title: '她记得什么' },
          h(MemoryBlock, { mem, quick, reload: load, toast }),
        ),

        /* —— ③ 能力 —— */
        h(Sec, { n: '③', title: '她能做什么' },

          h(Row, { k: '人格' },
            h('div', { className: 'roost-v-h' },
              h('span', { style: { fontWeight: 600 } },
                curPersona ? curPersona.name : personas ? '没读到人格文件' : '读取中…'),
              personas && personas.personas.length > 1
                ? h('button', { className: 'roost-link', onClick: () => setPickPersona((v) => !v) },
                    pickPersona ? '收起' : '换')
                : null,
              byChatCount
                ? h('span', { className: 'roost-note', style: { marginTop: 0 } },
                    `另有 ${byChatCount} 个会话单独指定了人格`)
                : null,
            ),
            pickPersona && personas
              ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
                  personas.personas.map((x) =>
                    h('button', {
                      key: x.id, type: 'button', className: 'roost-chip',
                      'data-on': x.id === curId ? '1' : '0',
                      onClick: () => { pick(x.id); setPickPersona(false) },
                    }, x.name),
                  ),
                )
              : null,
            override
              ? h('div', { className: 'roost-note', style: { marginTop: 7, display: 'flex', gap: 8, alignItems: 'baseline' } },
                  h('span', { style: { minWidth: 0 } },
                    '本群已覆盖：',
                    h('span', { style: { opacity: 0.88 } }, override.slice(0, 40) + (override.length > 40 ? '…' : '')),
                  ),
                  h(ConfirmLink, {
                    label: '恢复默认', confirmLabel: '确认恢复？',
                    onConfirm: async () => {
                      const r = await quick('persona.set', '')
                      toast(r.ok ? r.message || '回到默认人格' : r.message || '没恢复')
                      load()
                    },
                  }),
                )
              : null,
            override
              ? h('div', { className: 'roost-note' },
                  '覆盖是模型自己用 <<persona:>> 写的，存在记忆文件里，不是配置。清掉就回到上面那个人格。')
              : null,
          ),

          h(Row, { k: '表情包' },
            stickers === null
              ? h('div', { className: 'roost-empty' }, '读取中…')
              : h('div', null,
                  h('div', { className: 'roost-v-h' },
                    h('span', null, stickers.items.length ? `${stickers.items.length} 张` : '一张都没有'),
                    h('button', {
                      className: 'roost-link',
                      onClick: () => {
                        try {
                          navigator.clipboard?.writeText(stickers.dir)
                          toast('目录路径已复制')
                        } catch { toast('复制失败，手动选一下吧') }
                      },
                    }, '复制目录'),
                    h('button', { className: 'roost-link', onClick: load }, '刷新'),
                  ),
                  stickers.items.length === 0
                    ? h('div', { className: 'roost-note' },
                        '目录已经建好了，把图丢进去就行——文件名当标签：',
                        h('code', { className: 'roost-mono' }, '开心_猫.png'),
                        ' 她会理解成「开心 / 猫」。丢完点上面的「刷新」。')
                    : h('div', { className: 'roost-note' },
                        stickers.items.slice(0, 6).map((x) => x.file).join('、')
                        + (stickers.items.length > 6 ? ' …' : '')),
                  h('div', { className: 'roost-mono roost-dim', style: { marginTop: 4 } }, stickers.dir),
                ),
          ),

          h(Row, { k: '主动搭话' },
            h('div', { className: 'roost-v-h' },
              h('button', {
                type: 'button', className: 'roost-switch', role: 'switch',
                'aria-checked': su.enabled ? 'true' : 'false',
                'aria-label': '主动搭话',
                'data-on': su.enabled ? '1' : '0',
                onClick: () => setSu('enabled', !su.enabled),
              }),
              h('span', null, su.enabled ? '开着' : '关着'),
              h('span', { className: 'roost-note', style: { marginTop: 0 } }, '只在私聊'),
              sp ? h('span', { className: 'roost-note', style: { marginTop: 0 } },
                `今天已说 ${sp.state?.todayCount || 0} 次`) : null,
              h('button', { className: 'roost-link', onClick: () => setOpenSu((v) => !v) },
                openSu ? '收起设置' : '设置'),
            ),
            h('div', { className: 'roost-note' },
              '她多久没听到你说话就主动开口。群里不会——群里的主动是另一件事，要 group_push 授权，见下一行。'),
            openSu
              ? h('div', { style: { marginTop: 10 } },
                  h(Field, { label: '发给谁（私聊 openid）', desc: '留空就不工作' },
                    h('input', { className: 'roost-input', value: su.chatId || '', onChange: (e) => setSu('chatId', e.target.value) })),
                  h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                    h(Field, { label: '最短间隔（分钟）' },
                      h('input', { className: 'roost-input', type: 'number', value: su.minIntervalMinutes ?? 180, onChange: (e) => setSu('minIntervalMinutes', Number(e.target.value) || 0) })),
                    h(Field, { label: '最长间隔（分钟）' },
                      h('input', { className: 'roost-input', type: 'number', value: su.maxIntervalMinutes ?? 480, onChange: (e) => setSu('maxIntervalMinutes', Number(e.target.value) || 0) })),
                    h(Field, { label: '每天最多' },
                      h('input', { className: 'roost-input', type: 'number', value: su.maxPerDay ?? 3, onChange: (e) => setSu('maxPerDay', Number(e.target.value) || 0) })),
                  ),
                  h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
                    h(Field, { label: '几点开始（0–23）' },
                      h('input', { className: 'roost-input', type: 'number', value: su.awakeFrom ?? 8, onChange: (e) => setSu('awakeFrom', Number(e.target.value) || 0) })),
                    h(Field, { label: '几点结束（0–23）' },
                      h('input', { className: 'roost-input', type: 'number', value: su.awakeTo ?? 23, onChange: (e) => setSu('awakeTo', Number(e.target.value) || 0) })),
                  ),
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('button', {
                      className: 'roost-btn',
                      disabled: !su.enabled || !su.chatId,
                      onClick: async () => {
                        toast('正在让她说一句…')
                        const r = await post('/speakup/fire', {})
                        toast(r.ok ? `说了：${String(r.text).slice(0, 30)}` : r.message || '没说出来')
                        load()
                      },
                    }, '现在说一句'),
                    sp?.state?.lastBotAt
                      ? h('span', { className: 'roost-note', style: { marginTop: 0 } },
                          `上次 ${ago(sp.state.lastBotAt)}`)
                      : null,
                  ),
                )
              : null,
          ),

          h(Row, { k: '授权' },
            authz
              ? h('div', { className: 'roost-v-h' },
                  h('span', null, `${SCOPE_LABEL[authz.scope] || authz.scope} · 已授权`),
                  h('span', { className: 'roost-note', style: { marginTop: 0 } }, ago(authz.at)),
                )
              : h('div', null,
                  h('div', null, '这个会话还没授权'),
                  h('div', { className: 'roost-note' },
                    '群里的主动消息必须先拿到 group_push——这是官方前置，不是限频问题。她发授权卡时点「允许」就会记在这儿。'),
                ),
          ),

          h(Row, { k: '语音条' },
            setupSt?.pluginInstalled === false
              ? h('div', { className: 'roost-note', style: { marginTop: 0 } }, 'ai-chat 还没装')
              : tts === undefined
                ? h('div', { className: 'roost-note', style: { marginTop: 0 } }, '读不到 ai-chat 的配置（Roost 没在跑？）')
                : h('div', null,
                    h('div', null, tts ? '开 · ' + tts : '关着'),
                    tts ? null : h('div', { className: 'roost-note' }, '音色是 ai-chat 的设置项，这里只读。'),
                  ),
          ),

          h(Row, { k: '撤回' },
            h('div', null,
              h('div', null, '开'),
              h('div', { className: 'roost-note' },
                '她说错话会撤回上一条，2 分钟内有效。ai-chat 侧的固定行为，没有开关。'),
            ),
          ),

          h(Row, { k: '重置' },
            h('div', { className: 'roost-v-h' },
              h(ConfirmLink, {
                label: '清上下文', confirmLabel: '确认断开？',
                onConfirm: async () => {
                  const r = await quick('context.clear')
                  toast(r.message || '上下文清了')
                },
              }),
              h('span', { className: 'roost-note', style: { marginTop: 0 } },
                '断开会话映射，下一条重新开始；旧会话还在，能回溯'),
            ),
          ),
        ),
      )
    }

    /* ---------------- 会话 ---------------- */

    function ChatsTab({ chats, reload, toast }) {
      if (!chats.length) {
        return h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '还没有会话'),
          h('div', { className: 'roost-desc' }, '群里说第一句话时会自动建一个 DSH 会话。每个 QQ 会话对应一个，上下文互不串。'))
      }
      return h('div', null, chats.map((c) =>
        h('div', { key: c.chatId, className: 'roost-card' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, c.title || c.chatId),
              h('div', { className: 'roost-mono roost-dim', style: { marginTop: 3 } }, `${c.chatId} · ${c.preset}`),
              h('div', { className: 'roost-desc' }, `最后活跃 ${ago(c.at)} · DSH 会话 ${String(c.sessionId).slice(-8)}`),
            ),
            h('button', {
              className: 'roost-btn',
              onClick: async () => {
                const r = await post('/chats/clear', { chatId: c.chatId })
                toast(r.ok ? '已清掉映射' : r.message)
                reload()
              },
            }, '清空'),
          ),
        ),
      ))
    }

    /* ---------------- 设置 ---------------- */

    function ConfigTab({ config, save, toast }) {
      const [draft, setDraft] = useState(config)
      useEffect(() => setDraft(config), [config])
      const set = (p, v) => setDraft((d) => setPath(d, p, v))
      const val = (p) => getPath(draft, p)

      return h('div', null,
        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '连接'),
          h(Field, { label: '监听端口', desc: 'ai-chat 的「DSH 地址」要指向这个端口' },
            h('input', { className: 'roost-input', value: val('server.port') ?? '', onChange: (e) => set('server.port', Number(e.target.value) || 0) })),
          h(Field, { label: '共享密钥', desc: '请求要带 X-Roost-Token 头。留空表示不校验（只绑本机时可行）' },
            h('input', { className: 'roost-input', value: val('server.token') ?? '', onChange: (e) => set('server.token', e.target.value), placeholder: '留空则不校验' })),
          h(Field, { label: 'Roost 安装目录', desc: '已经装过就填这里，指向含 src/main.js 的目录；留空用默认位置' },
            h('input', { className: 'roost-input', value: val('setup.roostDir') ?? '', onChange: (e) => set('setup.roostDir', e.target.value), placeholder: '留空 = <数据目录>/roost' })),
        ),

        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '权限'),
          h('div', { className: 'roost-desc', style: { marginBottom: 12 } },
            '默认只有主人能用本地工具。权限按每一条消息判定——同一个群里主人问完、路人接着问，待遇不一样。'),
          [
            ['owner', '主人'], ['admin', '管理员'], ['member', '普通成员'], ['unknown', '身份不明（兜底）'],
          ].map(([k, label]) =>
            h('div', { key: k, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' } },
              h('div', null,
                h('div', { style: { fontWeight: 500 } }, label),
                k === 'unknown' ? h('div', { className: 'roost-desc' }, '拿不到权限信息时用这一档，不建议放开') : null),
              h('select', {
                className: 'roost-input', style: { width: 124 },
                value: getPath(draft, 'permissions.' + k) ?? (k === 'owner' ? 'all' : 'chat'),
                onChange: (e) => set('permissions.' + k, e.target.value),
              },
                h('option', { value: 'all' }, '全部工具'),
                h('option', { value: 'chat' }, '只能聊天'),
              ),
            ),
          ),
        ),

        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '行为'),
          h(Field, { label: '一轮最多等多久（秒）', desc: '要小于 ai-chat 那边的 180 秒，才能赶在它超时前回话' },
            h('input', { className: 'roost-input', value: val('chat.turnTimeoutSec') ?? '', onChange: (e) => set('chat.turnTimeoutSec', Number(e.target.value) || 0) })),
        ),

        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '人格'),
          h(Field, { label: '名字' },
            h('input', { className: 'roost-input', value: val('persona.name') ?? '', onChange: (e) => set('persona.name', e.target.value) })),
          h(Field, { label: '人设' },
            h('textarea', { className: 'roost-input', style: { minHeight: 72, resize: 'vertical' }, value: val('persona.text') ?? '', onChange: (e) => set('persona.text', e.target.value) })),
          h(Field, { label: '私聊追加' },
            h('input', { className: 'roost-input', value: val('persona.rulesPrivate') ?? '', onChange: (e) => set('persona.rulesPrivate', e.target.value) })),
          h(Field, { label: '群聊追加' },
            h('input', { className: 'roost-input', value: val('persona.rulesSocial') ?? '', onChange: (e) => set('persona.rulesSocial', e.target.value) })),
        ),

        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'roost-primary', onClick: () => save(draft) }, '保存'),
          h('button', { className: 'roost-btn', onClick: () => { setDraft(clone(config)); toast('已撤销') } }, '撤销'),
        ),
      )
    }

    /* ---------------- 整页 ---------------- */

    function RoostPage() {
      useStyle()
      const rootRef = useRef(null)
      const dark = useDark(rootRef)

      const [tab, setTab] = useState('overview')
      const [setupSt, setSetupSt] = useState({})
      const [st, setSt] = useState({})
      const [chats, setChats] = useState([])
      const [config, setConfig] = useState(null)
      const [toastMsg, setToastMsg] = useState('')
      const [busy, setBusy] = useState('')
      const timer = useRef(null)

      const toast = useCallback((m) => {
        setToastMsg(m)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setToastMsg(''), 2600)
      }, [])

      const loadSetup = useCallback(() => {
        get('/setup').then((r) => setSetupSt(r.ok === false ? {} : r))
      }, [])
      const loadStatus = useCallback(() => {
        get('/status').then((r) => setSt(r.ok === false ? {} : r))
      }, [])
      const loadChats = useCallback(() => get('/chats').then((r) => setChats(r.chats || [])), [])
      const loadConfig = useCallback(() => get('/config').then((r) => setConfig(r.config || null)), [])

      const reload = useCallback(() => {
        loadSetup()
        loadStatus()
      }, [loadSetup, loadStatus])

      useEffect(() => {
        reload()
        const t = setInterval(reload, 4000)
        return () => clearInterval(t)
      }, [reload])

      useEffect(() => {
        if (tab === 'chats') loadChats()
        if ((tab === 'config' || tab === 'features') && !config) loadConfig()
      }, [tab, config, loadChats, loadConfig])

      const run = useCallback(async ({ only, appId, secret } = {}) => {
        const s = await get('/setup')
        if (s.ok === false) return toast(s.message || '读不到状态')

        const step = async (label, path, body) => {
          setBusy(label)
          const r = await post(path, body)
          toast(r.ok ? r.message || label + '完成' : r.message || label + '失败')
          setBusy('')
          reload()
          return r.ok
        }

        if (only === 'install') return step('安装', '/setup/install')
        if (only === 'start') return step('启动', '/setup/start')
        if (only === 'plugin') return step('安装插件', '/setup/plugin')
        if (only === 'configure') return step('配置', '/setup/configure')

        if (!s.installed && !(await step('安装', '/setup/install'))) return

        if (!s.hasBot) {
          if (!appId || !secret) {
            toast('先填 AppID 和 AppSecret（开放平台拿）')
            return
          }
          if (!(await step('写入配置', '/setup/bot', { name: 'main', appId, secret }))) return
        }

        if (!s.running && !(await step('启动', '/setup/start'))) return
        if (!s.pluginInstalled && !(await step('安装插件', '/setup/plugin'))) return
        if (!s.pluginConfigured && !(await step('配置', '/setup/configure'))) return

        toast('全部就绪，去群里说句话试试')
        reload()
      }, [reload, toast])

      const save = async (draft) => {
        const r = await post('/config', draft)
        if (r.ok) {
          setConfig(r.config)
          loadStatus()
          loadSetup()
          toast(r.message || '已保存')
        } else {
          toast(r.message || '保存失败')
        }
      }

      return h('div', {
        ref: rootRef,
        className: 'roost-root',
        'data-dark': dark ? '1' : '0',
        style: { padding: '22px 24px 40px', maxWidth: 760 },
      },
        h('div', { style: { fontSize: 17, fontWeight: 650, letterSpacing: '-0.01em' } }, 'Roost'),
        h('div', { className: 'roost-desc', style: { marginTop: 3 } }, 'QQ 消息从这里交给 DSH 会话回答。'),

        h('div', { style: { display: 'flex', gap: 2, margin: '18px 0 16px', borderBottom: '1px solid var(--line-soft)' } },
          [['overview', '概览'], ['setup', '接入'], ['features', '功能'], ['chats', '会话'], ['config', '设置'], ['logs', '日志']].map(([id, label]) =>
            h('button', {
              key: id, type: 'button', className: 'roost-tab',
              'data-on': tab === id ? '1' : '0',
              onClick: () => setTab(id),
            }, label),
          ),
        ),

        h('div', { className: 'roost-fade', key: tab },
          tab === 'setup' ? h(SetupTab, { st: setupSt, reload, toast, busy, run }) : null,
          tab === 'overview' ? h(OverviewTab, { st, setupSt, toast, reload }) : null,
          tab === 'logs' ? h(LogsTab, null) : null,
          tab === 'features' ? h(FeaturesTab, { config, st, setupSt, toast, save, reload: loadConfig }) : null,
          tab === 'chats' ? h(ChatsTab, { chats, reload: loadChats, toast }) : null,
          tab === 'config' ? (config ? h(ConfigTab, { config, save, toast }) : h('div', { className: 'roost-desc' }, '读取配置…')) : null,
        ),

        /**
         * 提示条固定在屏幕底部。
         *
         * 之前是普通 div 放在内容最后——「接入」页很长，
         * 点了第 5 步的按钮，提示出现在屏幕外，看起来就是「点了没反应」。
         */
        toastMsg
          ? h('div', {
              style: {
                position: 'fixed', left: '50%', bottom: 30, transform: 'translateX(-50%)',
                zIndex: 2147483000, maxWidth: 520, padding: '10px 18px',
                borderRadius: 9, border: '1px solid var(--line)',
                background: 'var(--surface)', color: 'inherit',
                boxShadow: '0 8px 28px rgba(0,0,0,.32)', fontSize: 13, lineHeight: 1.5,
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
    return module.exports
  },
})
