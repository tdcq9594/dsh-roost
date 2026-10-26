// dsh-roost · 网页半边：侧栏「Roost」入口 + 整页面板
//
// 只读写宿主半边的 /roost/api/* 接口，不直接碰会话和 QQ。
//
// 设计取向：这是一块**仪表盘**，不是营销页。
//   · 首屏回答一个问题：「我卡在哪一步」
//   · 用一条竖直的「归巢路径」把六步串起来，节点本身就是进度条
//   · 颜色只用来表达状态，装饰一律不加
//   · 视觉沿用 DSH 的主题变量（--dsw-alias-*），浅色深色自动跟随

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

    const get = (p) =>
      fetch(API + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    const post = (p, body) =>
      fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

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

    /* ---------------- 设计令牌 ---------------- */

    const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace'
    const C = {
      text: 'var(--dsw-alias-text-primary, #1f2328)',
      dim: 'var(--dsw-alias-text-secondary, #6b7280)',
      line: 'var(--dsw-alias-border, #e5e7eb)',
      card: 'var(--dsw-alias-bg-elevated, transparent)',
      input: 'var(--dsw-alias-bg-input, transparent)',
      accent: 'var(--dsw-alias-accent, #2563eb)',
      ok: '#12855a',
      warn: '#b45309',
      bad: '#b42318',
    }

    const S = {
      wrap: { padding: '22px 24px 40px', color: C.text, fontSize: 13, lineHeight: 1.62, maxWidth: 760 },
      h1: { fontSize: 17, fontWeight: 650, margin: 0, letterSpacing: '-0.01em' },
      sub: { color: C.dim, fontSize: 12, marginTop: 3 },
      card: { border: `1px solid ${C.line}`, borderRadius: 10, padding: '14px 16px', marginBottom: 12, background: C.card },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
        border: `1px solid ${C.line}`, background: C.input, color: 'inherit', fontSize: 13, fontFamily: 'inherit',
      },
      btn: {
        padding: '5px 12px', borderRadius: 7, border: `1px solid ${C.line}`, background: C.card,
        color: 'inherit', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', whiteSpace: 'nowrap',
      },
      btnPrimary: {
        padding: '7px 16px', borderRadius: 7, border: '1px solid transparent', background: C.accent,
        color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 550, fontFamily: 'inherit',
      },
      tabs: { display: 'flex', gap: 2, margin: '18px 0 16px', borderBottom: `1px solid ${C.line}` },
      mono: { fontFamily: MONO, fontSize: 11.5 },
      muted: { color: C.dim, fontSize: 12 },
    }

    /* ---------------- 全局样式（动画与节点） ---------------- */

    function useStyle() {
      useEffect(() => {
        if (document.getElementById('roost-style')) return
        const el = document.createElement('style')
        el.id = 'roost-style'
        el.textContent = `
.roost-node{position:relative;flex:0 0 26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:${MONO};font-size:11px;font-weight:600;transition:transform .18s cubic-bezier(.2,.8,.2,1),background .18s,border-color .18s}
.roost-node.done{background:${C.ok};border:1px solid ${C.ok};color:#fff}
.roost-node.todo{border:1px dashed ${C.line};color:${C.dim};background:transparent}
.roost-node.current{border:1px solid ${C.warn};color:${C.warn};background:transparent}
.roost-node.bad{border:1px solid ${C.bad};color:${C.bad};background:transparent}
.roost-node.current::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:1px solid ${C.warn};opacity:.45;animation:roost-breathe 2.4s cubic-bezier(.4,0,.6,1) infinite}
@keyframes roost-breathe{0%{transform:scale(.92);opacity:.5}50%{transform:scale(1.12);opacity:0}100%{transform:scale(.92);opacity:0}}
.roost-step{display:flex;gap:14px;padding:0 0 20px;position:relative}
.roost-step:last-child{padding-bottom:2px}
.roost-rail{position:absolute;left:12.5px;top:28px;bottom:2px;width:1px;background:${C.line}}
.roost-step:last-child .roost-rail{display:none}
.roost-step.done .roost-rail{background:${C.ok};opacity:.35}
.roost-body{flex:1;min-width:0;padding-top:2px}
.roost-title{font-weight:600;font-size:13px}
.roost-desc{color:${C.dim};font-size:12px;margin-top:2px}
.roost-fade{animation:roost-in .22s cubic-bezier(.2,.8,.2,1)}
@keyframes roost-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.roost-node.current::after{animation:none}.roost-fade{animation:none}}
`
        document.head.appendChild(el)
      }, [])
    }

    /* ---------------- 控件 ---------------- */

    const Field = ({ label, desc, children }) =>
      h('label', { style: { display: 'block', marginBottom: 14 } },
        h('div', { style: { marginBottom: 5, fontWeight: 550, fontSize: 12.5 } }, label),
        children,
        desc ? h('div', { style: { ...S.muted, marginTop: 5 } }, desc) : null,
      )

    const Tab = ({ id, cur, onClick, children }) =>
      h('button', {
        type: 'button', onClick: () => onClick(id),
        style: {
          padding: '8px 14px', border: 'none',
          borderBottom: cur === id ? `2px solid ${C.accent}` : '2px solid transparent',
          background: 'transparent', color: 'inherit', cursor: 'pointer',
          fontSize: 13, fontWeight: cur === id ? 600 : 400, marginBottom: -1, fontFamily: 'inherit',
        },
      }, children)

    /** 路径上的一个节点 */
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

      // 六步状态全部从 st 推出来，不做本地状态机——刷新就是真相
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

      return h('div', null,

        h('div', { style: { ...S.card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          h('div', null,
            h('div', { style: { fontWeight: 600 } }, st.pluginConfigured ? '链路已就绪' : '还没配好'),
            h('div', { style: S.muted }, st.pluginConfigured
              ? '群里说一句话试试。没反应就看下面的「常见卡点」。'
              : '点右边的按钮，能自动做的都会做掉。'),
          ),
          h('button', {
            style: { ...S.btnPrimary, opacity: busy ? 0.6 : 1 },
            disabled: Boolean(busy),
            onClick: () => run({ appId, secret }),
          }, busy ? busy + '…' : st.pluginConfigured ? '重新检查' : '一键就绪'),
        ),

        h('div', { style: { padding: '4px 2px 0' } },

          h(Step, {
            n: 1, state: s.install, title: '装 Roost',
            desc: st.installed ? `已装 v${st.version || '?'}` : '下载解压就行——Roost 零依赖，不用 npm install',
          },
            st.installed
              ? h('button', { style: S.btn, onClick: () => copy(st.dir), title: st.dir }, '复制路径')
              : h('button', { style: S.btn, disabled: Boolean(busy), onClick: () => run({ only: 'install' }) }, '安装'),
          ),
          st.installed ? h('div', { style: { ...S.mono, ...S.muted, marginTop: -12, marginBottom: 14, paddingLeft: 40 } }, st.dir) : null,

          h(Step, {
            n: 2, state: s.bot, title: '填 AppID / AppSecret',
            desc: '开放平台 → 你的机器人 → 开发设置。这一步没法自动，只能你填',
          }),
          st.hasBot
            ? h('div', { style: { ...S.mono, ...S.muted, marginTop: -12, marginBottom: 14, paddingLeft: 40 } },
                '已配置：' + st.bots.map((b) => `${b.name}（${b.appId || '无 AppID'}）`).join('、'))
            : h('div', { style: { marginTop: -8, marginBottom: 18, paddingLeft: 40, maxWidth: 420 } },
                h('input', { style: { ...S.input, marginBottom: 8 }, placeholder: 'AppID', value: appId, onChange: (e) => setAppId(e.target.value) }),
                h('input', { style: { ...S.input, marginBottom: 8 }, placeholder: 'AppSecret', type: 'password', value: secret, onChange: (e) => setSecret(e.target.value) }),
                h('button', {
                  style: S.btn, disabled: !appId || !secret || Boolean(busy),
                  onClick: async () => {
                    const r = await post('/setup/bot', { name: 'main', appId, secret })
                    toast(r.ok ? '已写入配置' : r.message)
                    reload()
                  },
                }, '保存'),
              ),

          h(Step, {
            n: 3, state: s.start, title: '启动 Roost',
            desc: st.running ? '在跑，面板已就绪' : '启动后它的面板在本机 8080',
          },
            st.running
              ? h('button', { style: S.btn, onClick: () => window.open(st.webui, '_blank', 'noopener') }, '打开面板')
              : h('button', { style: S.btn, disabled: !st.hasBot || Boolean(busy), onClick: () => run({ only: 'start' }) }, '启动'),
          ),

          h(Step, {
            n: 4, state: s.plugin, title: '装 ai-chat 插件',
            desc: st.pluginInstalled ? '已装' : 'Roost 那边负责收发 QQ 消息的插件',
          },
            st.pluginInstalled
              ? null
              : h('button', { style: S.btn, disabled: !st.running || Boolean(busy), onClick: () => run({ only: 'plugin' }) }, '安装'),
          ),

          h(Step, {
            n: 5, state: s.configure, title: '切到 DSH 适配器',
            desc: st.pluginConfigured
              ? `ai-chat 已经指向 ${st.pluginConfig?.dshUrl || st.dshUrl}`
              : '把 ai-chat 的「交给谁去想」改成 DSH，并填好回话地址',
          },
            st.pluginConfigured
              ? null
              : h('button', { style: S.btn, disabled: !st.pluginInstalled || Boolean(busy), onClick: () => run({ only: 'configure' }) }, '配置'),
          ),

          h(Step, {
            n: 6, state: s.ready, title: '在群里说句话',
            desc: st.pluginConfigured
              ? '还差两件手工的事：开放平台开「接收所有消息」，机器人先进群'
              : '前面五步走完就能试了',
          },
            st.pluginConfigured
              ? h('button', { style: S.btn, onClick: () => window.open('https://q.qq.com', '_blank', 'noopener') }, '开放平台')
              : null,
          ),
        ),

        h('div', { style: { ...S.card, marginTop: 6 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '常见卡点'),
          h('ul', { style: { margin: 0, paddingLeft: 18, ...S.muted } },
            h('li', null, '启动后马上退出：多半是 AppID/AppSecret 填错了，或 8080 被占'),
            h('li', null, '群里没反应：开放平台没开「接收所有消息」，或机器人不在群里'),
            h('li', null, '有反应但答非所问：ai-chat 的「什么时候接话」被设成了「只在被 @ 时」'),
          ),
        ),
      )
    }

    /* ---------------- 状态 ---------------- */

    function StatusTab({ st, reload }) {
      const perms = st.permissions || {}
      const toolable = ['owner', 'admin', 'member'].filter((k) => perms[k] === 'all')
      const rows = [
        ['监听', st.listening ? `127.0.0.1:${st.port}` : '未启动', st.listening],
        ['共享密钥', st.tokenSet ? '已设置' : '未设置（仅本机可访问）', st.tokenSet],
        ['已连 QQ 会话', `${st.chats} 个`, st.chats > 0],
        ['正在等回复', `${st.waiting} 个`, null],
        ['能用本地工具', toolable.length ? toolable.join(' / ') : '只有主人', null],
      ]

      return h('div', null,
        h('div', { style: S.card }, rows.map(([k, v, ok]) =>
          h('div', { key: k, style: S.row },
            h('span', { style: S.muted }, k),
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              ok === null ? null : h('i', { style: { width: 6, height: 6, borderRadius: 9, background: ok ? C.ok : C.dim } }),
              v,
            ),
          ),
        )),

        st.lastTurn
          ? h('div', { style: S.card },
              h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '最近一轮'),
              h('div', { style: S.muted },
                `${st.lastTurn.chatId.slice(0, 8)} · ${st.lastTurn.bucket || '?'}/${st.lastTurn.mode || '?'} · `
                + `${st.lastTurn.ok ? `回了 ${st.lastTurn.len} 字` : `失败：${st.lastTurn.error}`} · ${st.lastTurn.ms}ms · ${ago(st.lastTurn.at)}`),
            )
          : null,

        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btn, onClick: reload }, '刷新'),
        ),

        h('div', { style: { ...S.muted, marginTop: 14 } },
          'ai-chat 的「DSH 地址」要填 ',
          h('code', { style: S.mono }, `http://127.0.0.1:${st.port}`),
          '，两边端口一致才连得上。'),
      )
    }

    /* ---------------- 会话 ---------------- */

    function ChatsTab({ chats, reload, toast }) {
      if (!chats.length) {
        return h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '还没有会话'),
          h('div', { style: S.muted }, '群里说第一句话时会自动建一个 DSH 会话。每个 QQ 会话对应一个，上下文互不串。'))
      }
      return h('div', null, chats.map((c) =>
        h('div', { key: c.chatId, style: S.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' } }, c.title || c.chatId),
              h('div', { style: { ...S.mono, ...S.muted, marginTop: 3 } }, `${c.chatId} · ${c.preset}`),
              h('div', { style: S.muted }, `最后活跃 ${ago(c.at)} · DSH 会话 ${String(c.sessionId).slice(-8)}`),
            ),
            h('button', {
              style: S.btn,
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
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '连接'),
          h(Field, { label: '监听端口', desc: 'ai-chat 的「DSH 地址」要指向这个端口' },
            h('input', { style: S.input, value: val('server.port') ?? '', onChange: (e) => set('server.port', Number(e.target.value) || 0) })),
          h(Field, { label: '共享密钥', desc: '请求要带 X-Roost-Token 头。留空表示不校验（只绑本机时可行）' },
            h('input', { style: S.input, value: val('server.token') ?? '', onChange: (e) => set('server.token', e.target.value), placeholder: '留空则不校验' })),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '权限'),
          h('div', { style: { ...S.muted, marginBottom: 12 } },
            '默认只有主人能用本地工具。权限按每一条消息判定——同一个群里主人问完、路人接着问，待遇不一样。'),
          [
            ['owner', '主人'], ['admin', '管理员'], ['member', '普通成员'], ['unknown', '身份不明（兜底）'],
          ].map(([k, label]) =>
            h('div', { key: k, style: S.row },
              h('div', null,
                h('div', { style: { fontWeight: 500 } }, label),
                k === 'unknown' ? h('div', { style: S.muted }, '拿不到权限信息时用这一档，不建议放开') : null),
              h('select', {
                style: { ...S.input, width: 124 },
                value: getPath(draft, 'permissions.' + k) ?? (k === 'owner' ? 'all' : 'chat'),
                onChange: (e) => set('permissions.' + k, e.target.value),
              },
                h('option', { value: 'all' }, '全部工具'),
                h('option', { value: 'chat' }, '只能聊天'),
              ),
            ),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '行为'),
          h(Field, { label: '一轮最多等多久（秒）', desc: '要小于 ai-chat 那边的 180 秒，才能赶在它超时前回话' },
            h('input', { style: S.input, value: val('chat.turnTimeoutSec') ?? '', onChange: (e) => set('chat.turnTimeoutSec', Number(e.target.value) || 0) })),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '人格'),
          h(Field, { label: '名字' },
            h('input', { style: S.input, value: val('persona.name') ?? '', onChange: (e) => set('persona.name', e.target.value) })),
          h(Field, { label: '人设' },
            h('textarea', { style: { ...S.input, minHeight: 72, resize: 'vertical' }, value: val('persona.text') ?? '', onChange: (e) => set('persona.text', e.target.value) })),
          h(Field, { label: '私聊追加' },
            h('input', { style: S.input, value: val('persona.rulesPrivate') ?? '', onChange: (e) => set('persona.rulesPrivate', e.target.value) })),
          h(Field, { label: '群聊追加' },
            h('input', { style: S.input, value: val('persona.rulesSocial') ?? '', onChange: (e) => set('persona.rulesSocial', e.target.value) })),
        ),

        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btnPrimary, onClick: () => save(draft) }, '保存'),
          h('button', { style: S.btn, onClick: () => { setDraft(clone(config)); toast('已撤销') } }, '撤销'),
        ),
      )
    }

    /* ---------------- 整页 ---------------- */

    function RoostPage() {
      useStyle()
      const [tab, setTab] = useState('setup')
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
        if (tab === 'config' && !config) loadConfig()
      }, [tab, config, loadChats, loadConfig])

      /** 跑一键流程：能自动做的依次做，卡在需要人填的地方就停 */
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

        // 全部
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
          toast(r.message || '已保存')
        } else {
          toast(r.message || '保存失败')
        }
      }

      return h('div', { style: S.wrap },
        h('div', { style: S.h1 }, 'Roost'),
        h('div', { style: S.sub }, 'QQ 消息从这里交给 DSH 会话回答。'),

        h('div', { style: S.tabs },
          h(Tab, { id: 'setup', cur: tab, onClick: setTab }, '接入'),
          h(Tab, { id: 'status', cur: tab, onClick: setTab }, '状态'),
          h(Tab, { id: 'chats', cur: tab, onClick: setTab }, '会话'),
          h(Tab, { id: 'config', cur: tab, onClick: setTab }, '设置'),
        ),

        h('div', { className: 'roost-fade', key: tab },
          tab === 'setup' ? h(SetupTab, { st: setupSt, reload, toast, busy, run }) : null,
          tab === 'status' ? h(StatusTab, { st, reload: loadStatus }) : null,
          tab === 'chats' ? h(ChatsTab, { chats, reload: loadChats, toast }) : null,
          tab === 'config' ? (config ? h(ConfigTab, { config, save, toast }) : h('div', { style: S.muted }, '读取配置…')) : null,
        ),

        toastMsg ? h('div', { style: { marginTop: 14, ...S.muted } }, toastMsg) : null,
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
