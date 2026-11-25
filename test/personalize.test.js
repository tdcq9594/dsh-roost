// 个性化页：菜单显隐 / 顺序 / 强调色 / 动效 的守门测试。
//
// 为什么要单独一份：这些行为全在**纯函数 + 初始渲染**上，不需要点按钮。
// 渲染测试用的假 React 不跑 effect、也不会重渲染，所以「点一下之后」的事
// 在这里测不到——那部分靠人工点一遍（见方案 §7.1 的人工清单）。
//
// 覆盖三条最容易写错的：
//   1. 显隐的 fail-open：没读到 / 接口失败，一律不藏；
//   2. 名字是 `hiddenTabIds`（返回要藏的），不是 visible；
//   3. 被藏起来的页仍能深链打开，且在导航里留一个「当前页」标记。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function makeReact() {
  const hooks = []
  let i = 0
  return {
    reset() { i = 0; hooks.length = 0 },
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useState: (init) => {
        const k = i++
        if (!(k in hooks)) hooks[k] = typeof init === 'function' ? init() : init
        return [hooks[k], (v) => { hooks[k] = v }]
      },
      useEffect: () => { i++ },
      useCallback: (fn) => { i++; return fn },
      useRef: (v) => { const k = i++; if (!(k in hooks)) hooks[k] = { current: v }; return hooks[k] },
      Fragment: 'fragment',
    },
  }
}

const store = {}
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v) },
}

function loadClient() {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod = null
  const rt = makeReact()
  const win = { __ModuleLoader__: { load: (cfg) => { mod = cfg.factory((n) => (n === 'react' ? rt.React : {})) } } }
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return { mod, rt }
}

/** 把函数组件真执行掉（与 client-render.test.js 同一套做法） */
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
const textOf = (node) => {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const kids = node.props?.children
  return kids ? (Array.isArray(kids) ? kids.map(textOf).join('') : textOf(kids)) : ''
}
const resetStore = (tab = 'overview') => {
  for (const k of Object.keys(store)) delete store[k]
  store['roost.tab'] = tab
}

const { mod } = loadClient()

test('hiddenTabIds：featOn 没读到就不藏（fail-open）', () => {
  assert.equal(mod.hiddenTabIds(null, null, false, null).size, 0)
  assert.equal(mod.hiddenTabIds(undefined, undefined, false, { hidden: [] }).size, 0)
})

test('hiddenTabIds：关表情包只多藏 stickers', () => {
  const s = mod.hiddenTabIds({ stickers: false }, null, false, null)
  assert.ok(s.has('stickers'))
  assert.equal(s.size, 1, '别顺手藏别的页')
  assert.equal(mod.hiddenTabIds({ stickers: true }, null, false, null).size, 0)
})

test('hiddenTabIds：已安装页常驻，空清单也不自动藏 ext', () => {
  assert.ok(!mod.hiddenTabIds(null, [], true, null).has('ext'), '读成功且为空也不能藏')
  assert.ok(!mod.hiddenTabIds(null, [], false, null).has('ext'), '还没读到更不能藏')
  assert.ok(!mod.hiddenTabIds(null, [{ id: 'a' }], true, null).has('ext'))
  assert.ok(!mod.hiddenTabIds(null, null, true, null).has('ext'), 'null 不是空清单')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(!/out\.add\('ext'\)/.test(src), '源码里不许再有自动藏 ext 的分支')
})

test('hiddenTabIds：用户隐藏生效，但保护名单不许藏', () => {
  const prefs = { hidden: ['mood', 'config', 'personalize', 'express', 'caps', 'overview', 'ext-market', 'ext-api'] }
  const s = mod.hiddenTabIds(null, null, false, prefs)
  assert.deepEqual([...s], ['mood'], '只有非保护页能藏')
  for (const id of mod.PROTECTED_TABS) assert.ok(!s.has(id), `${id} 在保护名单里却被藏了`)
})

test('orderTabs：用户排过的在前，没排过的按声明顺序接后', () => {
  const g = { id: 'self', tabs: ['her', 'profile', 'mood', 'awake', 'memory', 'people'] }
  const prefs = { order: { self: ['memory', 'her'] } }
  assert.deepEqual(
    mod.orderTabs(g, ['her', 'profile', 'mood', 'awake', 'memory', 'people'], prefs),
    ['memory', 'her', 'profile', 'mood', 'awake', 'people'],
  )
  assert.deepEqual(
    mod.orderTabs(g, ['mood', 'people'], prefs),
    ['mood', 'people'],
    '用户顺序里的页没出现在这一组时不能凭空插进来',
  )
})

test('readUiPref：扩展页 ext:<id> 的隐藏/排序能存住，垃圾 key 仍被过滤', () => {
  resetStore()
  store['roost.ui.v1'] = JSON.stringify({
    hidden: ['ext:imagegen', 'ext:../evil', 'ext:', 'ext:a b', 'nope'],
    order: { mods: ['ext:imagegen', 'ext:bad<script>', 'ext:gpt-voice'] },
  })
  const p = mod.readUiPref()
  assert.deepEqual(p.hidden, ['ext:imagegen'], '只放行形如 ext:xxx 的安全 key')
  assert.deepEqual(p.order.mods, ['ext:imagegen', 'ext:gpt-voice'], '排序同理，恶意 key 丢掉')
  const s = mod.hiddenTabIds(null, null, false, p)
  assert.ok(s.has('ext:imagegen'), '隐藏扩展页要真的生效')
})

test('readUiPref：坏 JSON / 错字段一律回落默认，不整份丢', () => {
  resetStore()
  assert.deepEqual(mod.readUiPref(), { hidden: [], order: {}, accent: 'host', anim: true, cardBg: { color: '', alpha: 50 }, extTheme: false })

  store['roost.ui.v1'] = '{oops'
  assert.deepEqual(mod.readUiPref(), { hidden: [], order: {}, accent: 'host', anim: true, cardBg: { color: '', alpha: 50 }, extTheme: false })

  store['roost.ui.v1'] = JSON.stringify({
    hidden: ['mood', 'nope', 42, 'config'],
    order: { self: ['people', 'ghost'], bad: 'x' },
    accent: 'rainbow',
    anim: false,
  })
  const p = mod.readUiPref()
  assert.deepEqual(p.hidden, ['mood'], '非法 id 与保护名单都要过滤')
  assert.deepEqual(p.order, { self: ['people'] }, '非数组的组直接丢')
  assert.equal(p.accent, 'host', '不认识的强调色回落宿主')
  assert.equal(p.anim, false)
  assert.deepEqual(p.cardBg, { color: '', alpha: 50 }, '缺卡片背景字段时补默认值，不整份丢')
  assert.equal(p.extTheme, false, '扩展页跟随主题默认关，存量页面样式不动')
})

test('readUiPref：extTheme 只认布尔 true，字符串 / 数字一律回落默认', () => {
  resetStore()
  store['roost.ui.v1'] = JSON.stringify({ extTheme: 'true' })
  assert.equal(mod.readUiPref().extTheme, false)
  store['roost.ui.v1'] = JSON.stringify({ extTheme: 1 })
  assert.equal(mod.readUiPref().extTheme, false)
  store['roost.ui.v1'] = JSON.stringify({ extTheme: true })
  assert.equal(mod.readUiPref().extTheme, true)
})

test('渲染：隐藏的页从导航消失，但不影响 TABS 本身', () => {
  resetStore('her')
  store['roost.ui.v1'] = JSON.stringify({ hidden: ['mood'] })
  const { mod: m, rt } = loadClient()
  const tree = expand(m.RoostPage(), rt)
  const tabs = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.role === 'tab') tabs.push(textOf(n))
    walk(n.props?.children)
  })(tree)
  assert.ok(tabs.includes('人格'), '没藏的不该受影响')
  assert.ok(!tabs.includes('心情'), '心情应该从导航里消失')
})

test('渲染：当前页被隐藏时留在原地，并标「（已隐藏）」', () => {
  resetStore('mood')
  store['roost.ui.v1'] = JSON.stringify({ hidden: ['mood'] })
  const { mod: m, rt } = loadClient()
  const tree = expand(m.RoostPage(), rt)
  let cur = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.['aria-current'] === 'page') cur = n
    walk(n.props?.children)
  })(tree)
  assert.ok(cur, '被隐藏的当前页必须有位置标记（深链/Alt+K 打开时也一样）')
  assert.match(textOf(cur), /心情（已隐藏）/, '标记要写清楚它被藏了')
})

test('渲染：概览组变成两页，二级行出现「概览 · 个性化」', () => {
  resetStore('personalize')
  const { mod: m, rt } = loadClient()
  const tree = expand(m.RoostPage(), rt)
  let sub = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (String(n.props?.className || '') === 'roost-nav-sub' && n.props?.role === 'tablist') {
      sub = textOf(n)
    }
    walk(n.props?.children)
  })(tree)
  assert.equal(sub, '概览个性化', '概览组现在有两页，二级行必须出来（顺序按声明）')
})

test('渲染：强调色注入根节点，未选时不注入', () => {
  resetStore()
  store['roost.ui.v1'] = JSON.stringify({ accent: 'purple' })
  {
    const { mod: m, rt } = loadClient()
    const tree = expand(m.RoostPage(), rt)
    assert.equal(tree.props.className, 'roost-root')
    assert.equal(tree.props.style?.['--roost-accent'], '#a371f7', '深色值要注入')
    assert.equal(tree.props.style?.['--roost-accent-light'], '#7c3aed', '浅色值也要给，否则浅色主题下是荧光色')
  }
  resetStore()
  {
    const { mod: m, rt } = loadClient()
    const tree = expand(m.RoostPage(), rt)
    assert.equal(tree.props.style?.['--roost-accent'], undefined, '跟随宿主时不写强调色，让 CSS 回落宿主令牌')
    assert.equal(tree.props.style?.['--roost-accent-light'], undefined, '浅色值同样不注入')
    assert.equal(tree.props.style?.['--roost-card-fill'], undefined,
      '卡片背景也留空，由 CSS 的 50% 默认值接管')
  }
})

test('渲染：关动效给根节点加 no-anim', () => {
  resetStore()
  store['roost.ui.v1'] = JSON.stringify({ anim: false })
  const { mod: m, rt } = loadClient()
  const tree = expand(m.RoostPage(), rt)
  assert.match(tree.props.className, /\bno-anim\b/)
})

test('渲染：整组都被隐藏时，一级分组不再出现', () => {
  resetStore('overview')
  /* 用人设组测整组消失：能力组的 `caps` 在保护名单里，永远藏不掉（开关总入口）。
     这条同时也钉住「保护页让所在组不会变成空壳」这个副作用。 */
  /** autotelic 已从 awake 页拆成独立 tab，也归人设组，整组隐藏测试要一起藏 */
  store['roost.ui.v1'] = JSON.stringify({ hidden: ['her', 'profile', 'mood', 'awake', 'autotelic', 'memory', 'people'] })
  const { mod: m, rt } = loadClient()
  const tree = expand(m.RoostPage(), rt)
  const groups = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (String(n.props?.className || '').includes('roost-grp')) groups.push(textOf(n))
    walk(n.props?.children)
  })(tree)
  assert.ok(!groups.includes('人设'), '整组都藏了就该整组不渲染，别留空壳按钮')
  assert.ok(groups.includes('概览'), '其它组照常')
})

test('源码：Alt+K 里隐藏页带「（已隐藏）」后缀', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const a = src.indexOf('const paletteTabs = () =>')
  const b = src.indexOf('const [navLast', a)
  const block = src.slice(a, b)
  assert.ok(block.includes('hiddenIds.has(id)'), 'paletteTabs 要读同一份隐藏集')
  assert.ok(block.includes('（已隐藏）'), '藏起来的页也要能搜到，并标清楚')
})

test('源码：隐藏集只有一处计算，七处消费不许各判各的', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.equal((src.match(/const hiddenIds = hiddenTabIds\(/g) || []).length, 1, '只算一次')
  for (const use of [
    '.filter(([id]) => !hiddenIds.has(id))', // dynamicTabs
    'hiddenIds.has(tab)',                    // 当前页标记
  ]) assert.ok(src.includes(use), `少了消费点：${use}`)
})
