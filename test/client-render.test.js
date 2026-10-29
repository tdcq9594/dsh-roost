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
    for (const label of ['概览', '接入', '人格与情绪', '记忆', '主动搭话', '上下文', '会话', '设置', '日志']) {
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

test('前端渲染：页签条不许设 overflow（会长出拖不动的竖向滚动条）', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'overview'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)

  // 找到 tablist 那个节点
  let bar = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.role === 'tablist') bar = n
    walk(n.props?.children)
  })(tree)

  assert.ok(bar, '没找到页签条')
  const style = bar.props.style || {}
  assert.equal(style.overflow, undefined, '页签条不能设 overflow')
  assert.equal(style.overflowX, undefined, 'overflowX:auto 会让另一轴也算成 auto，凭空长出竖滚动条')
  assert.equal(style.overflowY, undefined)
  assert.equal(style.flexWrap, 'wrap', '窄窗口应该换行，而不是横向滚')
})

test('前端渲染：页头与页签在滚动区之外，只有正文滚', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'memory'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)

  const kids = tree.props.children
  const cls = (n) => (n && n.props && n.props.className) || ''
  const head = kids.find((n) => cls(n).includes('roost-head'))
  const body = kids.find((n) => cls(n).includes('roost-scroll-body'))
  assert.ok(head, '缺 roost-head（页头 + 页签）')
  assert.ok(body, '缺 roost-scroll-body（正文滚动区）')

  // 页签必须在页头里，不能跟着正文滚走
  let sawTablistInHead = false
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.role === 'tablist') sawTablistInHead = true
    walk(n.props?.children)
  })(head)
  assert.ok(sawTablistInHead, '页签不在页头里，会跟着正文一起滚走')

  // 正文区里不许再有页签（那会让页签被滚两次）
  let tablistInBody = false
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.role === 'tablist') tablistInBody = true
    walk(n.props?.children)
  })(body)
  assert.equal(tablistInBody, false, '页签不该出现在滚动区里')
})

/**
 * 她页：给了人格数据之后，每行的**名字**必须出现。
 *
 * 截图里那一列只剩右边三个按钮、左边一片空，我先按"名字没渲染"怀疑过——
 * 用假数据真渲染一遍才确认名字是在的（那是被别的窗口盖住了）。
 * 但「名字被右侧按钮挤没」是真会发生的，所以还是钉一条：
 * 名字、字数、标签、正在用标签，四样都得在。
 */
test('前端渲染：她页人格列表显示名字/字数/标签', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'her'
  rt.reset()

  // 从渲染树里把 HerTab 那个元素拎出来，喂真实形状的数据再渲染一次
  const raw = mod.RoostPage()
  const body = raw.props.children.find((n) => String(n?.props?.className || '').includes('roost-scroll-body'))
  const el = body.props.children.find(Boolean)
  assert.equal(el.type.name, 'HerTab', '滚动区第一个组件应该就是 HerTab')

  rt.reset()
  const tree = expand(
    el.type({
      ...el.props,
      personas: {
        ok: true,
        current: 'default',
        byChat: { g1: 'lazycat' },
        personas: [
          { id: 'default', name: '小栖', tags: ['日常', '温和'], chars: 87 },
          { id: 'lazycat', name: '懒猫', tags: ['懒'], chars: 120 },
        ],
      },
      config: { persona: { current: 'default' } },
      mem: { chatId: 'g1', personaOverride: '', authz: null },
      mood: { valence: -0.3, energy: 0.2, sociability: 0.7, updatedAt: Date.now() },
      stickers: { dir: 'C:/x/stickers', items: [] },
      setupSt: { pluginInstalled: true, pluginConfig: { ttsVoice: '' } },
      quick: () => {},
      save: () => {},
      reload: () => {},
      toast: () => {},
    }),
    rt,
  )

  const txt = textOf(tree)
  for (const must of ['小栖', '懒猫', '87 字', '日常 / 温和', '正在用', '用这个', '编辑']) {
    assert.ok(txt.includes(must), `人格列表缺少「${must}」`)
  }
  // 默认人格不给删，别的给
  assert.equal((txt.match(/删除/g) || []).length, 1, '只有非默认人格才应该出现删除')
})

/**
 * 抽出某一页里所有分节的「编号 + 标题」。
 *
 * 分节在 DOM 上是 `div.roost-sec > div.roost-sec-h > span.roost-sec-n / span.roost-sec-t`。
 */
function sectionsOf(node) {
  const out = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (String(n.props?.className || '').includes('roost-sec')) {
      const h = n.props?.children
      const head = Array.isArray(h) ? h.find((c) => String(c?.props?.className || '').includes('roost-sec-h')) : null
      const kids = Array.isArray(head?.props?.children) ? head.props.children : []
      const num = kids.find((c) => String(c?.props?.className || '').includes('roost-sec-n'))
      const title = kids.find((c) => String(c?.props?.className || '').includes('roost-sec-t'))
      out.push({ n: textOf(num), title: textOf(title) })
      return
    }
    walk(n.props?.children)
  })(node)
  return out
}

/**
 * 分节编号必须连号，且从 01 起。
 *
 * 之前编号是硬写在标题里的（`n: '03'`），于是删掉/合并一节之后，
 * 后面全部错位——情绪跳到 03、中间空着一个 02，看着像少了一节。
 * 现在编号按渲染顺序算，这条断言就是防止它再退回去。
 */
test('前端渲染：每页分节编号连号，从 01 起', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)

  for (const tab of TABS) {
    store['roost.tab'] = tab
    rt.reset()
    const tree = expand(mod.RoostPage(), rt)
    const secs = sectionsOf(tree).filter((s) => s.n)
    if (!secs.length) continue // 这一页本来就没编号节（接入页用 1–6 圆点向导）
    secs.forEach((s, i) => {
      assert.equal(s.n, String(i + 1).padStart(2, '0'),
        `${tab} 页第 ${i + 1} 节编号应为 ${String(i + 1).padStart(2, '0')}，实际「${s.n} ${s.title}」`)
    })
  }
})

/**
 * 不许有空占位节。
 *
 * 「编辑人格」那一节以前无论有没有打开都渲染，空的时候只留一句
 * 「点上面某一行的编辑读正文」——占版面又占编号。
 * 现在编辑区只在真的打开了某个人格时才出现。
 */
test('前端渲染：她页没有打开人格时不出现「编辑人格」占位节', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'her'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)
  const titles = sectionsOf(tree).map((s) => s.title)
  assert.ok(!titles.includes('编辑人格'), '「编辑人格」占位节还在')
  assert.ok(titles.includes('人格'), '「人格」节没了')
})

/**
 * 危险操作不能跟日常操作混在一节。
 *
 * 「从旧版导入」是加法（把老记忆搬进来），「清空」是减法（抹掉），
 * 原来两者同处「清空与迁移」一节，容易误点。现在必须分开，
 * 且清空在最后。
 */
/**
 * 第五层（她自己写的）必须看得见。
 *
 * 它是唯一一层「关于她」而不是「关于用户」的记忆。不显示出来的话，
 * 用户没法判断她是变好了还是在重复同一个错，也没法在写歪的时候清掉。
 * 位置也有讲究：它是**跨群汇总**的一份，不属于任何单个会话，
 * 所以「重置自我叙述」不能并进会话级清空那一排里冒充同一种操作。
 */
test('前端渲染：记忆页有「她自己」一节，且在清空之前', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'memory'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)
  const titles = sectionsOf(tree).map((s) => s.title)
  const iSelf = titles.indexOf('她自己')
  const iClr = titles.indexOf('清空')
  assert.ok(iSelf >= 0, '没有「她自己」节——第五层在面板上不可见')
  assert.ok(iSelf < iClr, '自述是日常内容，不该排在危险区之后')
});

test('前端渲染：记忆页把导入和清空分成两节，清空在最后', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'memory'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)
  const titles = sectionsOf(tree).map((s) => s.title)
  const iImp = titles.indexOf('从旧版导入')
  const iClr = titles.indexOf('清空')
  assert.ok(iImp >= 0, '没有独立的「从旧版导入」节')
  assert.ok(iClr >= 0, '没有独立的「清空」节')
  assert.ok(iImp < iClr, '清空（危险）应在导入（无害）之后')
  assert.ok(!titles.some((t) => t.includes('清空与迁移')), '「清空与迁移」这种混装节还在')
})

/**
 * 记忆页的会话下拉必须能分出「群」和「私聊」。
 *
 * QQ 官方事件里群名是空的（只有 openid），ai-chat 取不到群名就回退成
 * 发消息那个人的昵称——于是群和私聊的 title 变成**同一个人名**。
 * 不标类型的话，下拉里两行字一模一样，用户根本不知道自己在看哪个。
 */
test('前端渲染：会话下拉标出「群 / 私聊」，且标题旁不再重复短码', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'memory'
  rt.reset()

  const raw = mod.RoostPage()
  const body = raw.props.children.find((n) => String(n?.props?.className || '').includes('roost-scroll-body'))
  const el = body.props.children.find(Boolean)
  assert.equal(el.type.name, 'MemoryTab', '滚动区第一个组件应该就是 MemoryTab')

  rt.reset()
  const tree = expand(
    el.type({
      ...el.props,
      mem: {
        chatId: 'g1',
        chats: [
          { chatId: 'g1', title: '倦飞之鸟', preset: 'roost-social', kind: 'group' },
          { chatId: 'u1', title: '倦飞之鸟', preset: 'roost-private', kind: 'c2c' },
        ],
        scene: { chatId: 'g1', title: '倦飞之鸟', kind: 'group' },
        global: [],
        chat: [],
        journal: null,
        graph: null,
      },
      toast: () => {},
      reload: () => {},
      quick: () => {},
      busy: false,
      onPickChat: () => {},
    }),
    rt,
  )

  const txt = textOf(tree)
  assert.ok(txt.includes('（群）'), '下拉里没有标出「群」')
  assert.ok(txt.includes('（私聊）'), '下拉里没有标出「私聊」')
  assert.ok(txt.includes('正在看'), '当前会话应有「正在看」标记')
  // 标题旁那个短码徽章已经删了——它和标题里的是同一个值，并排像两串不同的数字
  assert.ok(!txt.includes('g1'), '短码不该在正文里再出现一次（完整 openid 去会话页看）')
})

/**
 * 样式表是**模板字符串**：里面出现反引号会直接截断 JS，出现 `${` 会被求值。
 * 前者 `node --check` 能抓到，后者不会——它会安静地把样式变成一个奇怪的值。
 * 今天就在 CSS 注释里写了反引号，整段样式被截断，语法检查当场报错。
 */
test('样式：CSS 里不许出现 ${（模板字符串插值）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const a = src.indexOf('const CSS = `') + 'const CSS = `'.length
  const b = src.indexOf('`', a)
  const css = src.slice(a, b)
  assert.ok(css.length > 4000, '没提到样式表，锚点可能失效了')
  assert.equal(css.includes('${'), false, 'CSS 里出现 ${ 会被求值，样式会坏')
  assert.equal(css.includes('`'), false, 'CSS 里出现反引号会截断模板字符串')
})

/**
 * CSS 里混进 JS 注释 → 整条规则被粘成非法选择器 → 规则静默失效。
 *
 * 这次的真实事故：写了 `// 条形（只读…）` 这一行，
 * `.roost-bar{...}` 就被当成同一个选择器的一部分，`position:relative` 没了；
 * 而它的绝对定位子元素 `i{position:absolute;top:0;bottom:0}` 仍然生效，
 * 于是那根 8px 的填充条按**视口**铺满整页、还吃掉了所有点击。
 * 语法检查、括号平衡检查都发现不了，只有渲染出来才看得见。
 */
test('样式：CSS 里不许出现 JS 风格的 // 注释', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const tag = 'const CSS = `'
  const a = src.indexOf(tag) + tag.length
  const css = src.slice(a, src.indexOf('`', a))
  const bad = css
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.trim().startsWith('//'))
  assert.deepEqual(bad, [], `CSS 里有 // 注释，会让下一条规则失效：${JSON.stringify(bad)}`)
})

test('样式：条形不能依赖绝对定位（父规则一失效就会铺满整页）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const tag = 'const CSS = `'
  const a = src.indexOf(tag) + tag.length
  const css = src.slice(a, src.indexOf('`', a))

  assert.ok(css.includes('.roost-bar{'), '缺 .roost-bar 主规则')
  const fill = css.match(/\.roost-bar i\{([^}]*)\}/)
  assert.ok(fill, '缺 .roost-bar i 规则')
  assert.equal(/position\s*:\s*absolute/.test(fill[1]), false, '填充条不许用绝对定位')
})

/* ---------------- 端口那一节：不许撒谎 ---------------- */

/**
 * 这一段出过一次「面板在撒谎」的事故。
 *
 * 旧代码 `const actual = st?.actualPort || st?.port`：actualPort 还是 0
 * （服务刚起、或重启那几百毫秒）时退回配置里的 17321，然后拿它去跟
 * ai-chat 的 17322 比，报出「我们监听 http://127.0.0.1:17321」——
 * 可我们根本没在 17321 上听。用户照着它改，反而把本来对的值改坏了。
 *
 * 教训：**不知道就说不知道**，别拿「意愿」冒充「现实」。
 */
const pvOf = () => {
  const rt = makeReact()
  return loadClient(rt.React).portView
}

test('端口：拿不到实际端口时不许报「我们监听 <配置端口>」', () => {
  const portView = pvOf()
  const pv = portView({ actualPort: 0, port: 17321, wantPort: 17321 }, 'http://127.0.0.1:17322')
  assert.equal(pv.kind, 'unknown')
  assert.equal(
    pv.text.includes('17321'), false,
    `不知道实际端口就不该提 17321（那是配置值）：${pv.text}`,
  )
  assert.equal(pv.action, undefined, '不知道的时候不该给「改过来」按钮')
})

test('端口：服务没起来时说「没在听」，不装成正常', () => {
  const portView = pvOf()
  const pv = portView({ actualPort: 0, listening: false, port: 17321 }, 'http://127.0.0.1:17322')
  assert.equal(pv.kind, 'unknown')
  assert.equal(pv.cell, '没在听')
  assert.match(pv.text, /还没在听/)
})

test('端口：真对不上才报红，并给一键修复', () => {
  const portView = pvOf()
  const pv = portView({ actualPort: 17321, wantPort: 17321 }, 'http://127.0.0.1:17322')
  assert.equal(pv.kind, 'bad')
  assert.match(pv.text, /对不上/)
  assert.equal(pv.wantUrl, 'http://127.0.0.1:17321')
  assert.equal(pv.action, 'sync', '对不上必须给「现在就改过来」，别让用户跑去接入页重走一遍')
})

test('端口：对得上就是绿的，不给按钮', () => {
  const portView = pvOf()
  const pv = portView({ actualPort: 17322 }, 'http://127.0.0.1:17322')
  assert.equal(pv.kind, 'ok')
  assert.match(pv.text, /两端一致/)
  assert.equal(pv.action, undefined)
})

test('端口：被占顺延时要标出配置值，别让用户以为配错了', () => {
  const portView = pvOf()
  const pv = portView({ actualPort: 17322, wantPort: 17321 }, 'http://127.0.0.1:17322')
  assert.equal(pv.kind, 'ok')
  assert.match(pv.cell, /17322/)
  assert.match(pv.cell, /配置 17321/)
})

test('端口：ai-chat 没配时不报红，指去接入第 5 步', () => {
  const portView = pvOf()
  const pv = portView({ actualPort: 17321 }, '')
  assert.equal(pv.kind, 'unset')
  assert.match(pv.text, /第 5 步/)
  assert.equal(pv.action, undefined)
})
