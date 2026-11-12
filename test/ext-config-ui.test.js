/**
 * 扩展设置表单的渲染与交互（前端）。
 *
 * 为什么单开一个文件：`client-render.test.js` 只管「空数据下不炸」，
 * 它的 `useEffect` 是空实现，所以 `extensions.get` 从没真跑过 ——
 * 「设置」按钮和表单在那套测试里根本没被渲染到。
 *
 * 这里做真一点的替身：effect 会被收集并执行，fetch 被 mock，
 * 于是「加载 → 出现设置按钮 → 点击 → 出现表单」这条链能走完。
 *
 * 跑法：node --test test/ext-config-ui.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * React 替身：**每个函数组件各自一份 state 槽**。
 *
 * 不能共用一个数组：父组件和子组件的 hook 序号会互相踩，两轮渲染时状态错位。
 * 用 `Map<组件函数, {state, cursor}>` 隔离，重渲染时按同一游标顺序读回。
 */
function makeReact() {
  const slots = new Map()
  const pending = []
  let cur = null

  const enter = (fn) => {
    if (!slots.has(fn)) slots.set(fn, { state: [], cursor: 0 })
    cur = slots.get(fn)
    cur.cursor = 0
    return cur
  }

  return {
    enter,
    takeEffects() { const out = pending.slice(); pending.length = 0; return out },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useState: (init) => {
        const s = cur
        const k = s.cursor++
        if (!(k in s.state)) s.state[k] = typeof init === 'function' ? init() : init
        return [s.state[k], (v) => { s.state[k] = typeof v === 'function' ? v(s.state[k]) : v }]
      },
      useEffect: (fn) => { const k = cur.cursor++; pending.push({ slot: cur, k, fn }) },
      useCallback: (fn) => { cur.cursor++; return fn },
      useRef: (v) => {
        const s = cur
        const k = s.cursor++
        if (!(k in s.state)) s.state[k] = { current: v }
        return s.state[k]
      },
      Fragment: 'fragment',
    },
  }
}

/** 展开函数组件（每个组件进自己的 state 槽）。 */
function expand(node, rt) {
  if (node == null || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, rt))
  if (typeof node.type === 'function') {
    rt.enter(node.type)
    return expand(node.type(node.props || {}), rt)
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children, rt) } }
}

function walk(node, fn) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n) => walk(n, fn)); return }
  fn(node)
  walk(node.props?.children, fn)
}

function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

function loadClient(react) {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod = null
  const win = {
    __ModuleLoader__: { load: (cfg) => { mod = cfg.factory((name) => (name === 'react' ? react : {})) } },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return mod
}

const EXT_ROW = {
  id: 'demo', name: '演示扩展', usage: '演示用', bytes: 9, chars: 9, cap: 200,
  truncated: false, foreign: false, locallyModified: false, sha256Valid: true,
  label: '', hasToken: true, scopes: ['state:read'], hasConfig: true,
}

const CONFIG_GET = {
  ok: true, id: 'demo', canEdit: true, message: '',
  values: { threshold: 5, region: '热门', enabled: true },
  secretSet: { apiKey: true },
  spec: [
    { key: 'threshold', type: 'number', label: '阈值', hint: '', required: false, secret: false, min: 1, max: 10, integer: true },
    { key: 'region', type: 'select', label: '分区', hint: '', required: false, secret: false, options: [{ value: '热门', label: '热门' }, { value: '动画', label: '动画区' }] },
    { key: 'enabled', type: 'boolean', label: '启用', hint: '', required: false, secret: false },
    { key: 'apiKey', type: 'string', label: 'API Key', hint: '', required: true, secret: true, maxLength: 512 },
    { key: 'tags', type: 'array', label: '标签', hint: '', required: false, secret: false, itemsType: 'string', maxItems: 8 },
    { key: 'adv', type: 'object', label: '高级', hint: '', required: false, secret: false, properties: [{ key: 'n', type: 'number', label: '重试', hint: '', required: false, secret: false }] },
  ],
}

/** 造一次完整渲染：mock fetch → 渲染 → 跑 effect → 再渲染。 */
async function renderExtTab(react, calls, bodies = []) {
  const rt = makeReact()
  globalThis.localStorage = { getItem: (k) => (k === 'roost.tab' ? 'ext' : null), setItem: () => {} }
  /**
   * 最小 document：client.js 的样式注入 effect 会 `getElementById('roost-style')`，
   * 返回一个存在的节点让它早退，就不必实现 createElement / head。
   */
  globalThis.document = {
    getElementById: () => ({ id: 'roost-style' }),
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
  }
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push(body.op)
    bodies.push(body)
    const data = body.op === 'extensions.get'
      ? { ok: true, enabled: true, rows: [EXT_ROW], totalBytes: 9, status: {} }
      : body.op === 'extensions.market.list'
        ? { ok: true, rows: [], repo: 'x/y', branch: 'main' }
        : body.op === 'extensions.config.get'
          ? CONFIG_GET
          : body.op === 'extensions.config.save'
            ? { ok: true, id: 'demo', values: CONFIG_GET.values, restarted: false, message: '已保存' }
            : { ok: true }
    return { ok: true, status: 200, text: async () => JSON.stringify(data) }
  }
  const mod = loadClient(rt.React)
  const render = () => {
    rt.enter(mod.RoostPage)
    return expand(mod.RoostPage(), rt)
  }
  let tree = render()
  // effect 里有 await 的接口调用：跑完再渲染一轮
  for (const e of rt.takeEffects()) e.fn()
  await new Promise((r) => setTimeout(r, 30))
  tree = render()
  for (const e of rt.takeEffects()) e.fn()
  await new Promise((r) => setTimeout(r, 30))
  return { tree: render(), rt, render }
}

test('扩展页：有 config 声明的扩展会画「设置」按钮', async () => {
  const calls = []
  const { tree } = await renderExtTab(makeReact(), calls)
  assert.ok(calls.includes('extensions.get'), '应该真的去拉了扩展列表')
  const texts = []
  walk(tree, (n) => { if (n.type === 'button') texts.push(textOf(n)) })
  assert.ok(texts.includes('设置'), `按钮里应有「设置」，实际：${texts.join(' | ')}`)
})

test('扩展页：点「设置」后展开表单，字段与类型齐全', async () => {
  const calls = []
  const rt = makeReact()
  const { tree, render } = await renderExtTab(rt, calls)

  let openBtn = null
  walk(tree, (n) => {
    if (n.type === 'button' && textOf(n) === '设置') openBtn = n
  })
  assert.ok(openBtn, '找不到「设置」按钮')
  openBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  const filled = render()

  assert.ok(calls.includes('extensions.config.get'), '点击后应拉取配置声明')
  const txt = textOf(filled)
  for (const label of ['设置 · demo', '阈值', '分区', '启用', 'API Key', '标签', '高级', '重试']) {
    assert.ok(txt.includes(label), `表单缺「${label}」`)
  }
  // 类型对应的控件
  const tags = []
  const inputTypes = []
  walk(filled, (n) => {
    tags.push(n.type)
    if (n.type === 'input' && n.props?.type) inputTypes.push(n.props.type)
  })
  assert.ok(inputTypes.includes('number'), 'number 字段应渲染数字输入框')
  assert.ok(inputTypes.includes('checkbox'), 'boolean 字段应渲染复选框')
  assert.ok(inputTypes.includes('password'), 'secret 字段应渲染密码框')
  assert.ok(tags.includes('select'), 'select 字段应渲染下拉框')
  assert.ok(tags.includes('textarea'), 'array 字段应渲染逐行文本域')
  // 已设置的密钥不给明文，只显示状态
  assert.ok(txt.includes('已设置'), '密钥状态应显示「已设置」')
  assert.ok(!txt.includes('sk-'), '明文不该出现在界面里')
})

test('扩展页：保存时把密钥 patch 与非敏感值分开提交', async () => {
  const calls = []
  const bodies = []
  const rt = makeReact()
  const { tree, render } = await renderExtTab(rt, calls, bodies)

  let openBtn = null
  walk(tree, (n) => { if (n.type === 'button' && textOf(n) === '设置') openBtn = n })
  openBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))
  const filled = render()

  /** 在密码框里输入新密钥，再提交 */
  let pwd = null
  walk(filled, (n) => { if (n.type === 'input' && n.props?.type === 'password') pwd = n })
  assert.ok(pwd, '找不到密码框')
  pwd.props.onChange({ target: { value: 'sk-new' } })
  const typed = render()

  let saveBtn = null
  walk(typed, (n) => { if (n.type === 'button' && textOf(n) === '保存设置') saveBtn = n })
  assert.ok(saveBtn, '找不到「保存设置」按钮')
  saveBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 30))

  assert.ok(calls.includes('extensions.config.save'), '应调用保存接口')
  const save = bodies.find((b) => b.op === 'extensions.config.save')
  assert.deepEqual(save.arg.secrets, { apiKey: 'sk-new' }, '密钥走独立 patch');
  assert.ok(!Object.hasOwn(save.arg.values || {}, 'apiKey'), 'values 里不能带密钥');
  assert.equal(save.arg.values.threshold, 5, '非敏感值原样提交');
})
