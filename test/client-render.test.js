// 前端渲染冒烟：把 client.js 在 Node 里真跑一遍。
//
// 为什么需要这一层：`node --check` 只查语法。这一轮就踩到过
// 「`TABS` 声明在 useState 之后」的 TDZ——语法完全合法，一渲染就抛。
// 还有一类是空数据崩溃：新装的用户所有状态都是 null，
// `mem.global.map` 这种少写一个 `?.` 也是语法合法、运行必炸。
//
// 做法：造一个极简 React（createElement 出普通对象，hooks 按调用顺序存），
// 用 localStorage 控制初始页签，把九个页面各渲染一次。
// 断言只有两条：不抛异常、出得来树。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 够用的 React 替身：只实现本插件用到的那几个 hook */
function makeReact() {
  const hooks = []
  let i = 0
  return {
    reset() {
      i = 0
      hooks.length = 0
    },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useState: (init) => {
        const k = i++
        if (!(k in hooks)) hooks[k] = typeof init === 'function' ? init() : init
        return [hooks[k], (v) => { hooks[k] = v }]
      },
      // 副作用在 Node 里不跑（会去打接口、起定时器）；只占住 hook 位保证顺序
      useEffect: () => { i++ },
      useCallback: (fn) => { i++; return fn },
      useRef: (v) => {
        const k = i++
        if (!(k in hooks)) hooks[k] = { current: v }
        return hooks[k]
      },
      Fragment: 'fragment',
    },
  }
}

/** 把 client.js 灌进当前上下文，返回它导出的模块 */
function loadClient(react) {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod = null
  const win = {
    __ModuleLoader__: {
      load: (cfg) => {
        mod = cfg.factory((name) => (name === 'react' ? react : {}))
      },
    },
  }
  // new Function 在全局作用域里跑，所以 localStorage / setInterval 从 globalThis 取
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return mod
}

/**
 * 把函数组件真的执行掉。
 *
 * 只调 `RoostPage()` 是不够的——它返回的树里，九个页面都是
 * `{type: OverviewTab, ...}` 这样的元素对象，**子组件根本没被调用**，
 * 于是「渲染不炸」是假的（我第一版就写成了这样，9 个页面全"通过"）。
 * 这里遇到函数类型就执行它，每个组件各自 reset 一次 hook 游标。
 */
function expand(node, rt) {
  if (node == null || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, rt))
  if (typeof node.type === 'function') {
    rt.reset()
    return expand(node.type(node.props || {}), rt)
  }
  return { ...node, props: { ...node.props, children: expand(node.props?.children, rt) } }
}

/** 把（已展开的）树摊平成字符串，方便断言内容真的渲染出来了 */
function textOf(node) {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const kids = node.props?.children
  return kids ? (Array.isArray(kids) ? kids.map(textOf).join('') : textOf(kids)) : ''
}

const store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
}

const TABS = ['overview', 'setup', 'her', 'memory', 'awake', 'context', 'chats', 'config', 'logs']

for (const tab of TABS) {
  test(`前端渲染：${tab} 页在空数据下不炸`, () => {
    const rt = makeReact()
    const mod = loadClient(rt.React)
    assert.equal(typeof mod.RoostPage, 'function', '必须导出 RoostPage')

    store['roost.tab'] = tab
    rt.reset()

    let tree
    assert.doesNotThrow(() => {
      tree = expand(mod.RoostPage(), rt)
    }, `${tab} 页渲染抛异常`)

    assert.equal(tree?.props?.className, 'roost-root', '根节点不对')
    // 页签条必须在每一页都在，且九个都在
    const txt = textOf(tree)
    for (const label of ['概览', '接入', '记忆', '醒着', '上下文', '会话', '设置', '日志']) {
      assert.ok(txt.includes(label), `页签缺「${label}」`)
    }
  })
}

test('前端渲染：默认页签是概览，不是上次的残留', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  delete store['roost.tab']
  rt.reset()
  const head = textOf(expand(mod.RoostPage(), rt))
  assert.ok(head.includes('现在这样'), '没落到概览页')
})

test('前端渲染：localStorage 写坏了也退回概览，不白屏', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'no-such-tab'
  rt.reset()
  let tree
  assert.doesNotThrow(() => { tree = expand(mod.RoostPage(), rt) })
  assert.ok(textOf(tree).includes('现在这样'))
})
