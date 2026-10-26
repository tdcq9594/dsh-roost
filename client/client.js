// dsh-roost · 网页半边：侧栏「Roost」入口 + 整页面板
//
// 只读写宿主半边的 /roost/api/* 接口，不直接碰会话和 QQ。
// 视觉沿用 DSH 的主题变量（--dsw-alias-*），浅色 / 深色自动跟随。

window.__ModuleLoader__.load({
  id: 'dsh-roost',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'roost'
    const API = '/roost/api'

    /* ---------------- 小工具 ---------------- */

    const get = (p) =>
      fetch(API + p, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    const post = (p, body) =>
      fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))

    const setPath = (obj, path, value) => {
      const next = JSON.parse(JSON.stringify(obj))
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

    /* ---------------- 通用控件 ---------------- */

    const S = {
      wrap: { padding: '18px 20px', color: 'var(--dsw-alias-text-primary, #1f2328)', fontSize: 13, lineHeight: 1.6 },
      h1: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' },
      muted: { color: 'var(--dsw-alias-text-secondary, #6b7280)', fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border, #e5e7eb)',
        borderRadius: 8,
        padding: '12px 14px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-elevated, transparent)',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '5px 0' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, #d0d7de)',
        background: 'var(--dsw-alias-bg-input, transparent)',
        color: 'inherit',
        fontSize: 13,
        fontFamily: 'inherit',
      },
      btn: {
        padding: '5px 12px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, #d0d7de)',
        background: 'var(--dsw-alias-bg-elevated, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      },
      btnPrimary: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-accent, #2563eb)',
        color: '#fff',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: 500,
      },
      tabs: { display: 'flex', gap: 4, margin: '14px 0', borderBottom: '1px solid var(--dsw-alias-border, #e5e7eb)' },
      dot: (on) => ({
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: 99,
        marginRight: 6,
        background: on ? '#16a34a' : '#9ca3af',
      }),
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      warn: {
        border: '1px solid #f0b429',
        background: 'rgba(240,180,41,0.10)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 12,
        fontSize: 12,
        lineHeight: 1.65,
      },
    }

    const Field = ({ label, desc, children }) =>
      h(
        'label',
        { style: { display: 'block', marginBottom: 12 } },
        h('div', { style: { marginBottom: 4, fontWeight: 500 } }, label),
        children,
        desc ? h('div', { style: { ...S.muted, marginTop: 4 } }, desc) : null,
      )

    const Tab = ({ id, cur, onClick, children }) =>
      h(
        'button',
        {
          type: 'button',
          onClick: () => onClick(id),
          style: {
            padding: '7px 14px',
            border: 'none',
            borderBottom: cur === id ? '2px solid var(--dsw-alias-accent, #2563eb)' : '2px solid transparent',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: cur === id ? 600 : 400,
            marginBottom: -1,
          },
        },
        children,
      )

    /* ---------------- 状态页 ---------------- */

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

      return h(
        'div',
        null,
        h('div', { style: S.card }, rows.map(([k, v, ok]) =>
          h('div', { key: k, style: S.row },
            h('span', { style: S.muted }, k),
            h('span', null, ok === null ? null : h('i', { style: S.dot(ok) }), v),
          ),
        )),

        st.lastTurn
          ? h('div', { style: S.card },
              h('div', { style: { fontWeight: 500, marginBottom: 6 } }, '最近一轮'),
              h('div', { style: S.muted },
                `${st.lastTurn.chatId.slice(0, 8)} · ${st.lastTurn.bucket || '?'}/${st.lastTurn.mode || '?'} · `
                + `${st.lastTurn.ok ? `回了 ${st.lastTurn.len} 字` : `失败：${st.lastTurn.error}`} · ${st.lastTurn.ms}ms · ${ago(st.lastTurn.at)}`,
              ),
            )
          : null,

        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btn, onClick: reload }, '刷新'),
        ),

        h('div', { style: { ...S.muted, marginTop: 14 } },
          'ai-chat 插件里的「DSH 地址」要填 ',
          h('code', { style: S.code }, `http://127.0.0.1:${st.port}`),
          '，两边端口一致才连得上。',
        ),
      )
    }

    /* ---------------- 会话页 ---------------- */

    function ChatsTab({ chats, reload, toast }) {
      if (!chats.length) {
        return h('div', { style: S.card }, h('div', { style: S.muted }, '还没有 QQ 会话连过来。群里说一句就会自动建一个。'))
      }
      return h(
        'div',
        null,
        chats.map((c) =>
          h('div', { key: c.chatId, style: S.card },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 } },
              h('div', { style: { minWidth: 0 } },
                h('div', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' } }, c.title || c.chatId),
                h('div', { style: { ...S.muted, ...S.code, marginTop: 3 } }, `${c.chatId} · ${c.preset}`),
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
        ),
      )
    }

    /* ---------------- 设置页 ---------------- */

    function ConfigTab({ config, save, toast }) {
      const [draft, setDraft] = useState(config)
      useEffect(() => setDraft(config), [config])
      const set = (p, v) => setDraft((d) => setPath(d, p, v))
      const val = (p) => getPath(draft, p)

      return h(
        'div',
        null,

        h('div', { style: S.warn },
          h('b', null, '关于本地工具'),
          h('br'),
          '默认「普通成员」也能用本地工具——意味着群里任何人都能通过对话让 AI 读这台机器的文件、执行命令。',
          '想收紧就把下面的「普通成员」改成「只能聊天」。',
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '连接'),
          h(Field, { label: '监听端口', desc: 'ai-chat 的「DSH 地址」要指向这个端口，改完两边都要对' },
            h('input', { style: S.input, value: val('server.port') ?? '', onChange: (e) => set('server.port', Number(e.target.value) || 0) }),
          ),
          h(Field, { label: '共享密钥', desc: '请求要带 X-Roost-Token 头。留空表示不校验（只绑本机时可行）' },
            h('input', { style: S.input, value: val('server.token') ?? '', onChange: (e) => set('server.token', e.target.value), placeholder: '留空则不校验' }),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '权限'),
          h('div', { style: { ...S.muted, marginBottom: 10 } },
            '每一档能用什么：all = 全部工具，chat = 只能聊天。权限按**每一条消息**生效，' +
            '同一个群里主人问完、路人接着问，待遇不一样。',
          ),
          [
            ['owner', '主人'],
            ['admin', '管理员'],
            ['member', '普通成员'],
            ['unknown', '身份不明（兜底）'],
          ].map(([k, label]) =>
            h('div', { key: k, style: S.row },
              h('div', null,
                h('div', { style: { fontWeight: 500 } }, label),
                k === 'unknown'
                  ? h('div', { style: S.muted }, '拿不到权限信息时用这一档。不建议放开')
                  : null,
              ),
              h('select', {
                style: { ...S.input, width: 120 },
                value: getPath(draft, 'permissions.' + k) ?? (k === 'unknown' ? 'chat' : 'all'),
                onChange: (e) => set('permissions.' + k, e.target.value),
              },
                h('option', { value: 'all' }, '全部工具'),
                h('option', { value: 'chat' }, '只能聊天'),
              ),
            ),
          ),
          h('div', { style: { ...S.muted, marginTop: 8 } },
            '担心安全就把「普通成员」也改成「只能聊天」——群里就只剩主人和管理员能用工具。',
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '行为'),
          h(Field, { label: '一轮最多等多久（秒）', desc: '要小于 ai-chat 那边的 180 秒，才能赶在它超时前回话' },
            h('input', { style: S.input, value: val('chat.turnTimeoutSec') ?? '', onChange: (e) => set('chat.turnTimeoutSec', Number(e.target.value) || 0) }),
          ),
        ),

        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 10 } }, '人格'),
          h(Field, { label: '名字' },
            h('input', { style: S.input, value: val('persona.name') ?? '', onChange: (e) => set('persona.name', e.target.value) }),
          ),
          h(Field, { label: '人设' },
            h('textarea', { style: { ...S.input, minHeight: 70, resize: 'vertical' }, value: val('persona.text') ?? '', onChange: (e) => set('persona.text', e.target.value) }),
          ),
          h(Field, { label: '私聊追加' },
            h('input', { style: S.input, value: val('persona.rulesPrivate') ?? '', onChange: (e) => set('persona.rulesPrivate', e.target.value) }),
          ),
          h(Field, { label: '群聊追加' },
            h('input', { style: S.input, value: val('persona.rulesGroup') ?? val('persona.rulesSocial') ?? '', onChange: (e) => set('persona.rulesSocial', e.target.value) }),
          ),
        ),

        h('div', { style: { display: 'flex', gap: 8 } },
          h('button', { style: S.btnPrimary, onClick: () => save(draft) }, '保存'),
          h('button', { style: S.btn, onClick: () => { setDraft(JSON.parse(JSON.stringify(config))); toast('已撤销') } }, '撤销'),
        ),
      )
    }

    /* ---------------- 整页 ---------------- */

    function RoostPage() {
      const [tab, setTab] = useState('status')
      const [st, setSt] = useState({})
      const [chats, setChats] = useState([])
      const [config, setConfig] = useState(null)
      const [toastMsg, setToastMsg] = useState('')

      const toast = useCallback((m) => {
        setToastMsg(m)
        setTimeout(() => setToastMsg(''), 2200)
      }, [])

      const loadStatus = useCallback(() => {
        get('/status').then((r) => setSt(r.ok === false ? {} : r))
      }, [])
      const loadChats = useCallback(() => {
        get('/chats').then((r) => setChats(r.chats || []))
      }, [])
      const loadConfig = useCallback(() => {
        get('/config').then((r) => setConfig(r.config || null))
      }, [])

      useEffect(() => {
        loadStatus()
        const t = setInterval(loadStatus, 3000)
        return () => clearInterval(t)
      }, [loadStatus])

      useEffect(() => {
        if (tab === 'chats') loadChats()
        if (tab === 'config' && !config) loadConfig()
      }, [tab, config, loadChats, loadConfig])

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
        h('div', { style: S.muted }, 'QQ 消息从 ai-chat 插件推到这里，交给 DSH 会话回答。'),

        h('div', { style: S.tabs },
          h(Tab, { id: 'status', cur: tab, onClick: setTab }, '状态'),
          h(Tab, { id: 'chats', cur: tab, onClick: setTab }, '会话'),
          h(Tab, { id: 'config', cur: tab, onClick: setTab }, '设置'),
        ),

        tab === 'status' ? h(StatusTab, { st, reload: loadStatus }) : null,
        tab === 'chats' ? h(ChatsTab, { chats, reload: loadChats, toast }) : null,
        tab === 'config' ? (config ? h(ConfigTab, { config, save, toast }) : h('div', { style: S.muted }, '读取配置…')) : null,

        toastMsg ? h('div', { style: { ...S.muted, marginTop: 12 } }, toastMsg) : null,
      )
    }

    /* ---------------- 侧栏图标 ---------------- */

    const RoostIcon = () =>
      h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        // 一个简化的鸟巢：三道弧 + 中间一个点，暗示「栖」
        h('path', { d: 'M2 10.5c1.6 2 3.6 3 6 3s4.4-1 6-3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M3.2 9.2c1.2 1 2.9 1.6 4.8 1.6s3.6-.6 4.8-1.6', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', opacity: 0.55 }),
        h('circle', { cx: 8, cy: 5.6, r: 1.9, stroke: 'currentColor', strokeWidth: 1.3 }),
      )

    /* ---------------- 挂载 ---------------- */

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 排在「自动化任务」(order 10) 和「插件」(order 0) 后面
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
