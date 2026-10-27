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
.roost-bar{position:relative;flex:1;height:6px;border-radius:3px;background:var(--field)}
.roost-bar i{position:absolute;top:0;bottom:0;border-radius:3px;background:var(--accent);transition:width .3s ease,left .3s ease}
.roost-bar i.bi{background:var(--warn)}

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

    /** 双向条形：从中线往两边长。数字不显示，形态就是信息 */
    const Bar = ({ v, bi }) => {
      const val = Math.max(-1, Math.min(1, Number(v) || 0))
      if (bi) {
        const w = Math.abs(val) * 50
        return h('div', { className: 'roost-bar' },
          h('i', { className: 'bi', style: { left: val >= 0 ? '50%' : 50 - w + '%', width: w + '%' } }),
        )
      }
      const w = Math.max(0, Math.min(1, val)) * 100
      return h('div', { className: 'roost-bar' }, h('i', { style: { left: '0%', width: w + '%' } }))
    }

    /** 二次确认的行内按钮：删/清这类不可逆动作都要过一次 */
    function ConfirmLink({ label, confirmLabel, onConfirm, disabled }) {
      const [arm, setArm] = useState(false)
      useEffect(() => {
        if (!arm) return
        const t = setTimeout(() => setArm(false), 4000)
        return () => clearTimeout(t)
      }, [arm])
      return h('button', {
        type: 'button',
        className: 'roost-btn',
        disabled,
        style: arm ? { color: 'var(--bad)', borderColor: 'var(--bad)' } : null,
        onClick: () => {
          if (!arm) return setArm(true)
          setArm(false)
          onConfirm()
        },
      }, arm ? confirmLabel : label)
    }

    /* ---------------- 概览 ---------------- */

    function OverviewTab({ st, setupSt, toast, reload, busy, run, onGo }) {
      const listening = st?.listening
      const steps = setupSt?.steps || []
      const doneCount = steps.filter((s) => s.state === 'done').length

      return h('div', null,
        h(Sec, { n: '01', title: '现在这样' },
          h(Row, { k: '收消息' },
            listening
              ? h('span', null, '在听 ', h('span', { className: 'roost-code' }, ':' + (st.actualPort || st.port)))
              : h('span', { style: { color: 'var(--bad)' } }, st?.serverError || '端口没起来'),
          ),
          h(Row, { k: 'DSH 会话' },
            st?.lastTurn
              ? h('span', null,
                  h(Pill, { tone: st.lastTurn.ok ? 'ok' : 'bad' }, st.lastTurn.ok ? '正常' : '出错'),
                  ' ',
                  h('span', { className: 'roost-muted' }, ago(st.lastTurn.at)),
                  st.lastTurn.ok
                    ? h('span', { className: 'roost-muted' }, ` · ${st.lastTurn.len} 字 · ${st.lastTurn.ms}ms`)
                    : h('span', { style: { color: 'var(--bad)' } }, ' · ' + (st.lastTurn.error || '未知错误')),
                )
              : h('span', { className: 'roost-empty' }, '还没收到过消息'),
          ),
          h(Row, { k: '接入进度' },
            h('span', null, `${doneCount} / ${steps.length || 4} 步完成`),
            doneCount < (steps.length || 4)
              ? h('button', { type: 'button', className: 'roost-btn', style: { marginLeft: 10 }, onClick: () => onGo('setup') }, '去接入')
              : null,
          ),
        ),

        h(Sec, { n: '02', title: '归途', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          h('div', null,
            steps.map((s, i) =>
              h('div', { key: s.key || i, className: 'roost-step ' + s.state },
                h('div', { className: 'roost-node ' + s.state }, s.state === 'done' ? '✓' : s.state === 'bad' ? '!' : i + 1),
                h('div', { className: 'roost-rail' }),
                h('div', { className: 'roost-body' },
                  h('div', { className: 'roost-title' }, s.title),
                  h('div', { className: 'roost-desc roost-muted' }, s.desc),
                ),
              ),
            ),
            !steps.length ? h('div', { className: 'roost-empty' }, '读不到接入状态') : null,
          ),
        ),

        h(Sec, { n: '03', title: '自测' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '往下发一句「你收到我了吗」。它不经过 QQ，只验证「插件 → DSH 会话 → 回话」这条链。'),
          h('button', {
            type: 'button',
            className: 'roost-primary',
            disabled: busy,
            onClick: () => run('/selftest', '自测'),
          }, busy ? '跑着…' : '跑一次自测'),
        ),
      )
    }

    /* ---------------- 接入 ---------------- */

    function SetupTab({ st, reload, toast, busy, run, reg, onSaved }) {
      const [qr, setQr] = useState(null)
      const [taskId, setTaskId] = useState('')
      const [appId, setAppId] = useState('')
      const [appSecret, setAppSecret] = useState('')
      const [dirDraft, setDirDraft] = useState('')
      const mode = reg?.current || 'qr'

      /**
       * 扫码轮询。
       *
       * 三态就够：pending 继续等、done 拿凭证、别的都当失败停下。
       * 拿到凭证必须**立刻**落配置——框架不解密第二次。
       */
      useEffect(() => {
        if (!taskId) return
        let alive = true
        const tick = async () => {
          const r = await post('/setup/qr/poll', { taskId })
          if (!alive) return
          if (r.status === 'done') {
            setTaskId('')
            toast('扫码成功，机器人已写好')
            reload()
            onSaved?.()
            return
          }
          if (r.status === 'expired' || r.status === 'error') {
            setTaskId('')
            setQr(null)
            toast(r.message || '二维码失效，重新生成一个')
            return
          }
          setTimeout(tick, 1800)
        }
        const t = setTimeout(tick, 800)
        return () => {
          alive = false
          clearTimeout(t)
        }
      }, [taskId])

      const startQr = async () => {
        const r = await post('/setup/qr/start', {})
        if (!r.ok) return toast(r.message || '生成二维码失败')
        setQr(r.qrSvg || r.qrUrl)
        setTaskId(r.taskId)
      }

      return h('div', null,
        h(Sec, { n: '01', title: '机器人凭证' },
          h('div', { className: 'roost-note', style: { marginBottom: 10 } },
            reg?.list?.length
              ? '接入方式：' + reg.list.map((x) => x.label).join(' / ') + '（当前：' + (reg.list.find((x) => x.name === mode)?.label || mode) + '）'
              : '读不到接入方式'),

          mode === 'manual'
            ? h('div', null,
                h('input', {
                  className: 'roost-input', placeholder: 'AppID', value: appId,
                  onChange: (e) => setAppId(e.target.value), style: { marginBottom: 8 },
                }),
                h('input', {
                  className: 'roost-input', placeholder: 'AppSecret', type: 'password', value: appSecret,
                  onChange: (e) => setAppSecret(e.target.value), style: { marginBottom: 8 },
                }),
                h('button', {
                  type: 'button', className: 'roost-primary',
                  onClick: async () => {
                    const r = await post('/setup/bot', { appId, appSecret })
                    toast(r.ok === false ? (r.message || '没写成') : '写好了')
                    if (r.ok !== false) { setAppSecret(''); reload(); onSaved?.() }
                  },
                }, '保存凭证'),
              )
            : h('div', null,
                qr
                  ? h('div', { style: { marginBottom: 10 } },
                      typeof qr === 'string' && qr.startsWith('<')
                        ? h('div', { dangerouslySetInnerHTML: { __html: qr }, style: { width: 190, background: '#fff', padding: 8, borderRadius: 8 } })
                        : h('a', { href: qr, target: '_blank', rel: 'noreferrer' }, '打开二维码'),
                      h('div', { className: 'roost-note' }, '用手机 QQ 扫，扫完这里会自动继续'),
                    )
                  : null,
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', className: 'roost-primary', onClick: startQr },
                    qr ? '重新生成' : '扫码添加机器人'),
                  h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新状态'),
                ),
              ),
        ),

        h(Sec, { n: '02', title: 'Roost 本体' },
          h(Row, { k: '位置' },
            st?.dir
              ? h('span', { className: 'roost-mono' }, st.dir)
              : h('span', { className: 'roost-empty' }, '还没装'),
          ),
          h('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
            h('input', {
              className: 'roost-input',
              placeholder: '换一个安装目录（留空/填已有 Roost 目录可绑定）',
              value: dirDraft, onChange: (e) => setDirDraft(e.target.value), style: { flex: 1 },
            }),
            h('button', {
              type: 'button', className: 'roost-btn',
              onClick: async () => {
                const r = await post('/setup/dir', { dir: dirDraft.trim() })
                toast(r.ok === false ? (r.message || '没改成') : (r.message || '改好了'))
                reload()
              },
            }, '应用'),
          ),
          h(Row, { k: '进程' },
            st?.running
              ? h('span', null, h(Pill, { tone: 'ok' }, '在跑'),
                  h('button', { type: 'button', className: 'roost-btn', style: { marginLeft: 10 }, onClick: () => run('/setup/stop', '停止') }, '停止'))
              : h('span', null, h(Pill, null, '没跑'),
                  h('button', { type: 'button', className: 'roost-btn', style: { marginLeft: 10 }, onClick: () => run('/setup/start', '启动') }, '启动')),
          ),
          h(Row, { k: '插件' },
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: () => run('/setup/plugin', '装插件') }, '安装 / 更新 ai-chat'),
          ),
          h(Row, { k: '一键' },
            h('button', { type: 'button', className: 'roost-primary', disabled: busy, onClick: () => run('/setup/install', '一键接入') },
              busy ? '跑着…' : '一键装好（装 Roost + 配插件）'),
          ),
        ),

        h(Sec, { n: '03', title: '配置对接' },
          h('div', { className: 'roost-note' },
            '把 dsh-roost 的地址写进 ai-chat，它才知道把消息推到哪。端口换了会自动同步，手动再点一次也无害。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', { type: 'button', className: 'roost-btn', disabled: busy, onClick: () => run('/setup/configure', '写入配置') }, '重新写入'),
            h('button', { type: 'button', className: 'roost-btn', onClick: () => get('/setup/webui').then((r) => {
              if (r.ok && r.url) window.open(r.url, '_blank', 'noreferrer')
              else toast('拿不到面板地址')
            }) }, '打开 Roost 面板'),
          ),
        ),
      )
    }

    /* ---------------- 她 ---------------- */

    function HerTab({ config, personas, mood, stickers, toast, save, reload }) {
      const curId = personas?.current || config?.persona?.current || 'default'
      const [editId, setEditId] = useState('')
      const [raw, setRaw] = useState('')
      const [newId, setNewId] = useState('')
      const [dirty, setDirty] = useState(false)

      /** 打开一个人格的正文。列表里没有 raw，得单独读一次 */
      const openPersona = async (id) => {
        const r = await get('/personas/read?id=' + encodeURIComponent(id))
        if (r.ok === false) return toast(r.message || '读不到正文')
        setEditId(id)
        setRaw(r.raw || '')
        setDirty(false)
      }

      return h('div', null,
        h(Sec, { n: '01', title: '人格' },
          h('div', { className: 'roost-list' },
            (personas?.personas || []).map((p) =>
              h('div', { key: p.id, className: 'roost-item' },
                h('span', { className: 't' },
                  h('span', { style: { fontWeight: p.id === curId ? 600 : 400 } }, p.name || p.id),
                  p.id === curId ? h(Pill, { tone: 'ok' }, '正在用') : null,
                  h('span', { className: 'd' }, ` ${p.chars} 字`),
                  (p.tags || []).length ? h('span', { className: 'd' }, ' · ' + p.tags.join('/')) : null,
                ),
                h('button', {
                  type: 'button', className: 'roost-btn', disabled: p.id === curId,
                  onClick: async () => {
                    const r = await save({ persona: { current: p.id } })
                    toast(r.ok === false ? '没换成' : '换好了')
                  },
                }, p.id === curId ? '当前' : '用这个'),
                h('button', { type: 'button', className: 'roost-btn', onClick: () => openPersona(p.id) }, '编辑'),
                p.id === 'default'
                  ? null
                  : h(ConfirmLink, {
                      label: '删', confirmLabel: '确认删除',
                      onConfirm: async () => {
                        const r = await post('/personas/remove', { id: p.id })
                        toast(r.ok === false ? (r.message || '没删掉') : '删了')
                        if (editId === p.id) { setEditId(''); setRaw('') }
                        reload()
                      },
                    }),
              ),
            ),
            !(personas?.personas || []).length ? h('div', { className: 'roost-empty' }, '读不到人格列表') : null,
          ),
          h('div', { className: 'roost-note' },
            '人格正文在 personas/*.md。按群覆盖（模型用 <<persona:>> 写的）优先级更高，要清掉去「记忆 → 清空」。'),
        ),

        h(Sec, { n: '02', title: editId ? '编辑「' + editId + '」' : '编辑人格' },
          editId
            ? h('div', null,
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
                  h('button', { type: 'button', className: 'roost-btn', onClick: () => openPersona(editId) }, '放弃改动'),
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '文件头 --- 之间是 name/tags，下面是正文'),
                ),
              )
            : h('div', null,
                h('div', { className: 'roost-empty' }, '点上面某一行的「编辑」读正文。'),
                h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
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
                      toast('建好了，接着改正文')
                      await reload()
                      openPersona(id)
                    },
                  }, '新建'),
                ),
              ),
        ),

        h(Sec, { n: '03', title: '此刻情绪' },
          mood
            ? h('div', null,
                h('div', { className: 'roost-mood' },
                  h('div', { className: 'roost-mood-row' },
                    h('span', { className: 'roost-mood-k' }, '心情'),
                    h(Bar, { v: mood.valence, bi: true }),
                    h('span', { className: 'roost-mood-w' }, (mood.valence >= 0 ? '+' : '') + Number(mood.valence || 0).toFixed(2)),
                  ),
                  h('div', { className: 'roost-mood-row' },
                    h('span', { className: 'roost-mood-k' }, '精力'),
                    h(Bar, { v: mood.energy }),
                    h('span', { className: 'roost-mood-w' }, Number(mood.energy || 0).toFixed(2)),
                  ),
                  h('div', { className: 'roost-mood-row' },
                    h('span', { className: 'roost-mood-k' }, '想说话'),
                    h(Bar, { v: mood.sociability }),
                    h('span', { className: 'roost-mood-w' }, Number(mood.sociability || 0).toFixed(2)),
                  ),
                ),
                h('div', { className: 'roost-note' },
                  '只做内部决策用（主动概率、接话门槛）。注入给模型的是语气指令，不是这些数字。',
                  mood.reason ? ` 当前原因：${mood.reason}` : '',
                ),
                /* 后端接受 feedback（QQ 里点赞/点踩会打到这），这里给手动入口方便调 */
                h('div', { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
                  h('span', { className: 'roost-note', style: { margin: 0 } }, '手动喂一次反馈：'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: async () => { await post('/mood', { feedback: 'up' }); toast('记了个赞'); reload() },
                  }, '👍 赞'),
                  h('button', {
                    type: 'button', className: 'roost-btn',
                    onClick: async () => { await post('/mood', { feedback: 'down' }); toast('记了个踩'); reload() },
                  }, '👎 踩'),
                ),
              )
            : h('div', { className: 'roost-empty' }, '读不到情绪'),
        ),

        h(Sec, { n: '04', title: '表情包' },
          stickers?.items?.length
            ? h('div', null,
                h('div', { className: 'roost-muted' }, `${stickers.items.length} 张`),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } },
                  stickers.items.slice(0, 40).map((s, i) =>
                    h('span', { key: i, className: 'roost-pill' }, s.tags?.join(' / ') || s.name || '图'),
                  ),
                ),
              )
            : h('div', { className: 'roost-empty' },
                '还没有图。往 ',
                h('span', { className: 'roost-code' }, stickers?.dir || 'stickers/'),
                ' 丢图片，文件名当标签（开心_猫.png → 开心、猫）。'),
          h('div', { className: 'roost-note' }, '她只在合适的时候发，不会每句都配图。'),
        ),
      )
    }

    /* ---------------- 记忆（三层） ---------------- */

    function MemoryTab({ mem, toast, reload, quick, busy }) {
      const [q, setQ] = useState('')
      const [hits, setHits] = useState(null)
      const [fact, setFact] = useState('')
      const [scope, setScope] = useState('global')
      const jr = mem?.journal
      const gp = mem?.graph
      const canChat = Boolean(mem?.chatId)

      const doSearch = async () => {
        const term = q.trim()
        if (!term) return
        const r = await get('/journal?q=' + encodeURIComponent(term) + (mem?.chatId ? '&chatId=' + encodeURIComponent(mem.chatId) : ''))
        if (r.ok === false) return toast(r.message || '搜不了')
        setHits(r.results || [])
      }

      return h('div', null,
        /* ── 第一层：事实 ── */
        h(Sec, { n: '01', title: '事实', right: h('button', { type: 'button', className: 'roost-btn', onClick: reload }, '刷新') },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '跨群的事实她带去任何会话；本群特有的只在这个群提。串场就是从这条线漏出去的，所以要分开看。'),

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
              canChat ? '本群特有' : '本群特有（还没有活跃会话，先聊一句才会有）'),
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
              h('option', { value: 'chat' }, '本群'),
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

        /* 危险区放最后 */
        h(Sec, { n: '04', title: '清空与迁移' },
          h('div', { className: 'roost-note', style: { marginBottom: 8 } },
            '清空会同时抹掉事实和日记正文（行还留着，时间线不断），不可恢复。'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(ConfirmLink, {
              label: '清空本群记忆', confirmLabel: '确认清空本群',
              onConfirm: async () => {
                const r = await quick('memory.clear')
                toast(r.message || '清了')
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
          ),
          /**
           * 一次性迁移：记忆以前放在 ai-chat 的 storage 里，4.0 之后搬到这里。
           * 幂等（重复导不会重复），所以留着入口没有副作用；
           * 但**默认折叠**——它不属于日常操作，摆在台面上会让人以为每次都要点。
           */
          h('details', { style: { marginTop: 14 } },
            h('summary', { className: 'roost-muted', style: { fontSize: 12, cursor: 'pointer' } },
              '从旧版导入（只有从 ai-chat 4.0 之前升级上来的才用得上）'),
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
      )

      function doAdd() {
        const text = fact.trim()
        if (!text) return
        post('/memory/add', { fact: text, scope, chatId: mem?.chatId || '' }).then((r) => {
          toast(r.ok === false ? (r.message || '没记上') : '记下了')
          if (r.ok !== false) { setFact(''); reload() }
        })
      }
    }

    /* ---------------- 醒着（主动） ---------------- */

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
        ),

        h(Sec, { n: '02', title: '上次的决定' },
          aw?.lastKind
            ? h('div', null,
                h(Row, { k: '机会' }, aw.lastKind === 'agreement' ? '约定' : aw.lastKind === 'miss' ? '想你' : '随性'),
                h(Row, { k: '理由' }, aw.lastWhy || '—'),
              )
            : h('div', { className: 'roost-empty' }, '还没醒过'),
        ),

        /* 私聊排期：speakup.js 管"什么时候轮到她"，awake 只管"要不要说" */
        h(Sec, { n: '03', title: '私聊排期', right: h('button', { type: 'button', className: 'roost-btn', onClick: reloadSp }, '刷新') },
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

        h(Sec, { n: '05', title: '现在试一次' },
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
            `群聊到 ${th.atPercentGroup ?? 60}%、私聊到 ${th.atPercentC2C ?? 40}% 就换新会话。` +
            '阈值刻意比编码 agent 的 70~90% 低一档：聊天单轮小、压掉的内容日记里查得回来；' +
            '但也不能太低——每换一次会话，prompt 缓存就整段失效。'),
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
      ['persona', '人格', '当前用哪个人格、按群指定'],
      ['stickers', '表情包', '图放哪、要不要注入'],
      ['permissions', '权限', '主人/管理员/成员各能用什么工具'],
      ['channel', '通道', '当前用哪个通道'],
      ['chat', '会话', '一轮最多等多久'],
      ['server', '服务', '端口与密钥'],
      ['setup', '接入', '装在哪、用哪种接入方式'],
    ]

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
        h(Sec, { n: '01', title: '这一段是干什么的' },
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
      )
    }

    /* ---------------- 日志 ---------------- */

    function LogsTab() {
      const [logs, setLogs] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          const r = await get('/logs')
          if (alive) setLogs(r.ok === false ? [] : r.logs || [])
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

    function RoostPage() {
      useStyle()
      const [tab, setTab] = useState('overview')
      const [st, setSt] = useState(null)
      const [setupSt, setSetupSt] = useState(null)
      const [config, setConfig] = useState(null)
      const [mem, setMem] = useState(null)
      const [mood, setMood] = useState(null)
      const [personas, setPersonas] = useState(null)
      const [stickers, setStickers] = useState(null)
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

      const loadMemory = useCallback(async () => {
        /**
         * 两个接口一起拉，合并成一份。
         *
         * `/memory` 给的是三层概览（facts + 日记 + 图谱的现在）；
         * `/graph` 额外带 `ended`（以前成立、现在不成立的关系）。
         * 只读 `/memory` 的话"她改过什么主意"那块永远是空的——
         * 字段缺失不会报错，只会静默少一块内容，这种最容易漏。
         */
        const [r, g] = await Promise.all([get('/memory'), get('/graph')])
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
        })
      }, [])

      const loadHer = useCallback(async () => {
        const [p, m, s] = await Promise.all([get('/personas'), get('/mood'), get('/stickers')])
        setPersonas(p.ok === false ? null : p)
        setMood(m.ok === false ? null : m)
        setStickers(s.ok === false ? null : s)
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

      const TABS = [
        ['overview', '概览'],
        ['setup', '接入'],
        ['her', '她'],
        ['memory', '记忆'],
        ['awake', '醒着'],
        ['context', '上下文'],
        ['chats', '会话'],
        ['config', '设置'],
        ['logs', '日志'],
      ]

      return h('div', { className: 'roost-root', style: { padding: '18px 22px 40px', maxWidth: 860 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
          h('div', { style: { fontSize: 17, fontWeight: 650, letterSpacing: '-0.01em' } }, 'Roost'),
          st
            ? h(Pill, { tone: st.listening ? 'ok' : 'bad' }, st.listening ? `:${st.actualPort || st.port}` : '端口没起')
            : null,
          ch?.current ? h(Pill, null, '通道 ' + ch.current) : null,
        ),
        h('div', { className: 'roost-note', style: { marginTop: 3 } }, 'QQ 消息从这里交给 DSH 会话回答。'),

        h('div', { style: { display: 'flex', gap: 2, margin: '18px 0 16px', borderBottom: '1px solid var(--line-soft)', overflowX: 'auto' } },
          TABS.map(([id, label]) =>
            h('button', {
              key: id, type: 'button', className: 'roost-tab',
              'data-on': tab === id ? '1' : '0',
              onClick: () => setTab(id),
            }, label),
          ),
        ),

        h('div', { className: 'roost-fade', key: tab },
          tab === 'overview' ? h(OverviewTab, { st, setupSt, toast, reload: loadStatus, busy, run, onGo: setTab }) : null,
          tab === 'setup' ? h(SetupTab, { st: setupSt, reload: loadStatus, toast, busy, run, reg, onSaved: loadSetupMeta }) : null,
          tab === 'her' ? h(HerTab, { config, personas, mood, stickers, toast, save: saveCfg, reload: loadHer }) : null,
          tab === 'memory' ? h(MemoryTab, { mem, toast, reload: loadMemory, quick, busy }) : null,
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
    return module.exports
  },
})
