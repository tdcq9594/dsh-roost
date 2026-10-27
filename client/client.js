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
@media (prefers-reduced-motion: reduce){
  .roost-node.current::after{animation:none}
  .roost-fade{animation:none}
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

    /* ---------------- 功能（人格 / 表情 / 语音 / 搭话） ---------------- */

    /**
     * 这一页是「后端做好了但面板没入口」的补课。
     *
     * 人格库、表情包、主动搭话的后端和接口早就有了，但面板上只能去「设置」里
     * 改原始字段——等于没有。这里给每个功能一块卡：看到状态，能直接操作。
     */
    function FeaturesTab({ config, toast, save, reload }) {
      const [personas, setPersonas] = useState(null)
      const [stickers, setStickers] = useState(null)
      const [sp, setSp] = useState(null)

      const load = useCallback(() => {
        get('/personas').then((r) => setPersonas(r.ok === false ? null : r))
        get('/stickers').then((r) => setStickers(r.ok === false ? null : r))
        get('/speakup').then((r) => setSp(r.ok === false ? null : r))
      }, [])

      useEffect(() => {
        load()
        const t = setInterval(load, 8000)
        return () => clearInterval(t)
      }, [load])

      if (!config) return h('div', { className: 'roost-desc' }, '读取配置…')

      const p = config.persona || {}
      const su = config.speakUp || {}
      const pick = (id) => save({ ...config, persona: { ...p, current: id } })
      const setSu = (k, v) => save({ ...config, speakUp: { ...su, [k]: v } })

      return h('div', null,

        /* —— 人格 —— */
        h('div', { className: 'roost-card' },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 } },
            h('div', { style: { fontWeight: 600 } }, '人格'),
            h('button', { className: 'roost-btn', onClick: load }, '刷新'),
          ),
          h('div', { className: 'roost-desc', style: { marginBottom: 10 } },
            '一个人格一个 Markdown 文件，放在数据目录 personas/ 下。按群指定在「设置 → 人格」里改 byChat。'),
          personas
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
                personas.personas.map((x) =>
                  h('button', {
                    key: x.id,
                    className: x.id === personas.current ? 'roost-primary' : 'roost-btn',
                    onClick: () => pick(x.id),
                  }, `${x.name}${x.tags.length ? ' · ' + x.tags.join('/') : ''}`),
                ),
              )
            : h('div', { className: 'roost-desc' }, '读取中…'),
        ),

        /* —— 表情包 —— */
        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '表情包'),
          h('div', { className: 'roost-desc', style: { marginBottom: 8 } },
            stickers
              ? `共 ${stickers.items.length} 张。把图丢进下面这个目录就行，文件名当标签（开心_猫.png → 开心、猫）。`
              : '读取中…'),
          stickers
            ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                h('code', { className: 'roost-mono', style: { flex: 1, minWidth: 200 } }, stickers.dir),
                h('button', {
                  className: 'roost-btn',
                  onClick: () => {
                    try {
                      navigator.clipboard?.writeText(stickers.dir)
                      toast('路径已复制')
                    } catch { toast('复制失败，手动选一下') }
                  },
                }, '复制路径'),
              )
            : null,
          stickers && stickers.items.length
            ? h('div', { className: 'roost-mono roost-dim', style: { marginTop: 8 } },
                stickers.items.slice(0, 12).map((x) => x.file).join('、') + (stickers.items.length > 12 ? ' …' : ''))
            : null,
        ),

        /* —— 语音 —— */
        h('div', { className: 'roost-card' },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '语音条'),
          h('div', { className: 'roost-desc' },
            '语音是在 Roost 那边的 ai-chat 里开的：面板 → 插件 → ai-chat → 设置 → 「语音音色」，'
            + '填 zh-CN-XiaoxiaoNeural（女）或 zh-CN-YunxiNeural（男）。留空就是关闭。'),
          h('div', { className: 'roost-desc', style: { marginTop: 6 } },
            '要能出声还得在插件目录装三个依赖（纯 JS，不要 Python）：',
            h('code', { className: 'roost-mono' }, ' npm i @andresaya/edge-tts mpg123-decoder silk-wasm'),
            '。QQ 语音只认 silk，所以中间会转两道。'),
        ),

        /* —— 主动搭话 —— */
        h('div', { className: 'roost-card' },
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 } },
            h('div', { style: { fontWeight: 600 } }, '主动搭话'),
            h('button', {
              className: su.enabled ? 'roost-btn' : 'roost-primary',
              onClick: () => setSu('enabled', !su.enabled),
            }, su.enabled ? '关闭' : '开启'),
          ),
          h('div', { className: 'roost-desc', style: { marginBottom: 12 } },
            '主人一阵子没找你，你在私聊里主动说句话。只在私聊，群里不会。'),
          h(Field, { label: '发给谁（私聊 openid）', desc: '填主人的 openid。留空就不工作' },
            h('input', { className: 'roost-input', value: su.chatId || '', onChange: (e) => setSu('chatId', e.target.value) })),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            h(Field, { label: '最短间隔（分钟）' },
              h('input', { className: 'roost-input', type: 'number', value: su.minIntervalMinutes ?? 180, onChange: (e) => setSu('minIntervalMinutes', Number(e.target.value) || 0) })),
            h(Field, { label: '最长间隔（分钟）' },
              h('input', { className: 'roost-input', type: 'number', value: su.maxIntervalMinutes ?? 480, onChange: (e) => setSu('maxIntervalMinutes', Number(e.target.value) || 0) })),
            h(Field, { label: '每天最多几次' },
              h('input', { className: 'roost-input', type: 'number', value: su.maxPerDay ?? 3, onChange: (e) => setSu('maxPerDay', Number(e.target.value) || 0) })),
          ),
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap' } },
            h(Field, { label: '几点开始（0–23）' },
              h('input', { className: 'roost-input', type: 'number', value: su.awakeFrom ?? 8, onChange: (e) => setSu('awakeFrom', Number(e.target.value) || 0) })),
            h(Field, { label: '几点结束（0–23）' },
              h('input', { className: 'roost-input', type: 'number', value: su.awakeTo ?? 23, onChange: (e) => setSu('awakeTo', Number(e.target.value) || 0) })),
          ),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
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
            sp
              ? h('span', { className: 'roost-desc' },
                  `今天已说 ${sp.state?.todayCount || 0} 次${sp.state?.lastBotAt ? '，上次 ' + ago(sp.state.lastBotAt) : ''}`)
              : null,
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
          tab === 'features' ? h(FeaturesTab, { config, toast, save, reload: loadConfig }) : null,
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
