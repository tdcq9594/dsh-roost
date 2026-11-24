// 前端渲染冒烟：把 client.js 在 Node 里真跑一遍。
//
// 为什么需要这一层：`node --check` 只查语法。这一轮就踩到过
// 「`TABS` 声明在 useState 之后」的 TDZ——语法完全合法，一渲染就抛。
// 还有一类是空数据崩溃：新装的用户所有状态都是 null，
// `mem.global.map` 这种少写一个 `?.` 也是语法合法、运行必炸。
//
// 做法：造一个极简 React（createElement 出普通对象，hooks 按调用顺序存），
// 用 localStorage 控制初始页签，把十个页面各渲染一次。
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
 * 只调 `RoostPage()` 是不够的——它返回的树里，十个页面都是
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

/* 与 client.js 的 TABS 同序：频道 7 页收成 4 页 + 新增「资料」「自身设置」后 31 个可见页签 */
const TABS = ['overview', 'personalize', 'her', 'profile', 'mood', 'awake', 'memory', 'people', 'caps', 'express', 'stickers', 'ch-post', 'model', 'ext', 'ext-market', 'ext-api', 'groupchat', 'groupadmin', 'ch-home', 'ch-policy', 'ch-api', 'ch-diag', 'connect', 'bot-self', 'chats', 'account', 'sim', 'logs', 'update', 'config', 'backup', 'security', 'about']
/* 隐藏页：老 localStorage 存着时仍要能正常渲染（chats / account 已提升为正式页） */
const HIDDEN_TABS = ['context', 'setup']

/**
 * 两层导航（2026-11-12）：一级分组 + 组内二级页面。
 *
 * 这里把结构抄一份，是为了在「页签改成两层」时**测试先红**——
 * 以前那版断言的是「8 个 label 同时出现在一行里」，两层之后这条
 * 自动失效，如果不重写就会变成「测试通过但导航其实坏了」。
 *
 * **2026-11-13 结构改造**：表达从「能力」里独立成组（语音 / 表情包两页）、
 * 新增「群聊」组（群聊策略 + 群管两页，群管从系统组搬来）、系统组加「关于」。
 * 「身份」改名「会话」。
 * 这里是特意抄的死结构：页签改动必须同步改这里，改不动就说明导航真坏了。
 */
const NAV = {
  home: { label: '概览', tabs: ['overview', 'personalize'] },
  /* 2026-11-16：人设组新增「资料」（她长什么样、能不能自己改） */
  self: { label: '人设', tabs: ['her', 'profile', 'mood', 'awake', 'memory', 'people'] },
  express: { label: '表达', tabs: ['express', 'stickers', 'ch-post'] },
  /**
   * 2026-11-16：**群聊并入「群与频道」**（一级 8 → 7）。两页回答同一个问题
   * 「在这个渠道里怎么说话」，配置层 `roostHost.decide/merge` 本来就是共用的。
   * 老 id `group` 走 `GROUP_ALIAS` 归一，已发布扩展不用改。
   */
  channel: { label: '群与频道', tabs: ['groupchat', 'groupadmin', 'ch-home', 'ch-policy', 'ch-api', 'ch-diag'] },
  power: { label: '能力', tabs: ['caps', 'model'] },
  mods: { label: '扩展', tabs: ['ext', 'ext-market', 'ext-api'] },
  system: { label: '系统', tabs: ['connect', 'bot-self', 'chats', 'account', 'sim', 'logs', 'update', 'config', 'backup', 'security', 'about'] },
}
const TAB_LABEL = {
  overview: '概览', personalize: '个性化', her: '人格', mood: '心情', awake: '主动搭话', memory: '记忆', people: '人物',
  caps: '权限', express: '语音', stickers: '图库', 'ch-post': '发帖', model: '模型', profile: '资料',
  ext: '已安装', 'ext-market': '市场', 'ext-api': '接口',
  groupchat: '群聊策略', groupadmin: '群管',
  'ch-home': '频道总览', 'ch-policy': '频道策略', 'ch-api': '频道接口', 'ch-diag': '频道排障',
  'bot-self': '自身设置',
  chats: '会话', account: '账号迁移', sim: '模拟测试', logs: '排障', update: '更新', config: '设置', backup: '备份', about: '关于',
  connect: '接入', security: '安全防护',
}
const HIDDEN_LABEL = { context: '上下文', setup: '接入' }

/** 收集渲染树里所有 role=tab 按钮的文字，以及 aria-current 标记 */
function navTexts(tree) {
  const tabs = []
  let current = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.role === 'tab') tabs.push(textOf(n))
    if (n.props?.['aria-current'] === 'page') current = textOf(n)
    walk(n.props?.children)
  })(tree)
  return { tabs, current }
}

/**
 * 只收集**二级**页签（`.roost-tab`）的文字，保留渲染顺序。
 *
 * `navTexts` 把一级分组按钮和二级页签混在一起（两者都是 role=tab），
 * 断言「顺序」时必须分开——一级的顺序由 `NAV_GROUPS` 数组定，
 * 二级的顺序由组内 `tabs` 声明定，这是两件不同的事。
 */
function subTabTexts(tree) {
  const out = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.className === 'roost-tab') out.push(textOf(n))
    walk(n.props?.children)
  })(tree)
  return out
}

/**
 * 按组件名在树里找元素。
 *
 * 2026-11-12 起滚动区多了一层 `.roost-body-inner`（限宽居中用），
 * 不能再靠「滚动区的第一个孩子就是目标组件」——那一层现在是 div。
 */
function findComponent(node, name) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const c of node) {
      const r = findComponent(c, name)
      if (r) return r
    }
    return null
  }
  if (typeof node.type === 'function' && node.type.name === name) return node
  return findComponent(node.props?.children, name)
}

for (const tab of TABS.concat(HIDDEN_TABS)) {
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

    const { tabs, current } = navTexts(tree)
    // 一级分组永远全在：它们是进任何一页的入口，少一个就有一组页面点不到
    for (const g of Object.values(NAV)) {
      assert.ok(tabs.includes(g.label), `一级分组缺「${g.label}」`)
    }
    const groupId = Object.keys(NAV).find((id) => NAV[id].tabs.includes(tab))
    if (groupId) {
      // 当前组要把组内页面全列出来，否则组里有一页点了没反应
      for (const id of NAV[groupId].tabs) {
        assert.ok(tabs.includes(TAB_LABEL[id]), `「${NAV[groupId].label}」组缺「${TAB_LABEL[id]}」`)
      }
    } else {
      // 隐藏页不属于任何组：一级没有高亮，靠 aria-current 标位置
      assert.equal(current, HIDDEN_LABEL[tab], `隐藏页「${HIDDEN_LABEL[tab]}」没有位置标记`)
    }
  })
}

/**
 * A1（第三轮报告）：组内页签的顺序要听 `NAV_GROUPS[x].tabs`，不是 `TABS`。
 *
 * 症状：`groupTabs` 原来是「拿 `dynamicTabs`（= `TABS` 顺序）过滤一遍」，
 * 于是 `TABS` 的书写顺序覆盖了分组声明——`NAV_GROUPS.system` 把 `connect`
 * 排首位，实际渲染成**倒数第二**，「关于」跑到中间，`SYSTEM_SEG` 的分段
 * 标记也跟着错位（「安全防护」落到「关于」后面）。
 *
 * 为什么值得一条测试：这类错**不会报错、不会白屏**，只是顺序不对，
 * 肉眼要逐个数才发现；而下次谁往 `TABS` 里插一行就可能再错一次。
 */
test('导航：组内页签顺序听分组声明，不听 TABS 书写顺序（A1）', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'connect'
  rt.reset()
  const sub = subTabTexts(expand(mod.RoostPage(), rt))

  const want = NAV.system.tabs.map((id) => TAB_LABEL[id])
  assert.deepEqual(sub, want, '系统组二级页签顺序与 NAV_GROUPS.system 声明不一致')
  assert.equal(sub[0], '接入', '「接入」不在首位——组内顺序又被 TABS 书写顺序覆盖了')
  assert.ok(
    sub.indexOf('安全防护') < sub.indexOf('关于'),
    '「安全防护」应排在「关于」之前（分段：接入/身份 → 诊断 → 运维 → 安全 → 关于）',
  )
})

test('前端渲染：人格页的分节要把并列的多块内容都渲染出来', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'her'
  rt.reset()
  const txt = textOf(expand(mod.RoostPage(), rt))

  /**
   * 这几块以前全丢了：`sec()` 只声明了一个 `children` 形参，
   * 而调用处是并列传进去的（人格列表 + 仓库面板 + 预览 + 覆盖提示
   * + 两段说明 + 新建输入框），多出来的参数被 JS 静默忽略。
   *
   * 表现就是「仓库」「新建」**按了没反应**：onClick 执行了、state 变了、
   * 按钮文案也变成「收起仓库」，但面板永远不渲染——看起来像按钮坏了。
   */
  assert.ok(txt.includes('正文可以分四段'), '四段说明没渲染出来（分节的并列子节点被丢了）')
  assert.ok(txt.includes('人格正文在 personas/*.md'), '人格正文说明没渲染出来')
})

test('前端渲染：安全防护页要有能点的开关，不是两行只读文字', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'security'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)

  const switches = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.role === 'switch') switches.push(n)
    walk(n.props?.children)
  })(tree)

  /**
   * 1.3.1 这页是纯只读（「已开启 / 已关闭」两行字），用户的原话是
   * 「这些功能的开关怎么没有」。全仓又找不到第三个写 `security` 的地方，
   * 等于这两道闸只能手改 config.json。这条测试钉住「开关真的在」。
   */
  assert.equal(switches.length, 2, '危险命令确认 + 内网放行各一个开关')
  assert.ok(switches.every((s) => typeof s.props.onClick === 'function'), '开关要能点')
  assert.ok(textOf(tree).includes('白名单'), '白名单要能从面板改')
  assert.ok(!textOf(tree).includes('这一页只读'), '不能再是只读页')
})

test('接线：进安全防护页要先拉 config，否则开关和输入框全是 disabled', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  /**
   * 面板按需拉配置，`security` 一开始不在名单里：开关与白名单框都挂着
   * `disabled: !config`，于是用户看到的是「点了没反应、填不进去」，
   * 而状态字仍按默认值写着「已开启」——像是页面坏了。
   */
  assert.ok(
    src.includes("if (tab === 'security' && !config) once('config', loadConfig)"),
    'security 页必须在按需拉配置的列表里',
  )
  /** 顶到页首的提示：说清为什么点不动，而不是只在第 03 段提一句 */
  assert.ok(src.includes('配置还在读（开关暂时点不动）'), 'config 为空时要有显眼提示')
})

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
  const el = findComponent(body, 'HerTab')
  assert.ok(el, '滚动区里应该有 HerTab')

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
      setupSt: { installed: true, running: true, hasCreds: true },
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
    /**
     * 「排障」页把 日志 / 上下文 / 会话清理 三个组件合到一页，
     * 每个组件各自从 01 起编号；遇到 01 就把计数归零，别把第二组判成错。
     */
    let k = 0
    secs.forEach((s) => {
      if (s.n === '01') k = 0
      k++
      assert.equal(s.n, String(k).padStart(2, '0'),
        `${tab} 页第 ${k} 节编号应为 ${String(k).padStart(2, '0')}，实际「${s.n} ${s.title}」`)
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
test('前端渲染：「她自己」归人格页，记忆页只剩数据', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const at = (t) => { store['roost.tab'] = t; rt.reset(); return expand(mod.RoostPage(), rt) }

  /**
   * 2026-11-12 从记忆页搬来：前四节记的是「关于用户」的事，
   * 「她自己」回答的是「她最近怎么样、错在哪」——属于「她是谁」。
   */
  const herTitles = sectionsOf(at('her')).map((s) => s.title)
  assert.ok(herTitles.includes('她自己'), '人格页没有「她自己」节——第五层在面板上不可见')
  assert.ok(herTitles.indexOf('她自己') > herTitles.indexOf('人格'), '「她自己」应排在人设之后')

  const memTitles = sectionsOf(at('memory')).map((s) => s.title)
  assert.ok(!memTitles.includes('她自己'), '记忆页不该再有「她自己」')
  assert.ok(!memTitles.includes('对话收尾'), '记忆页不该再有「对话收尾」')

  /* 收尾归「开口时机」，和排期同一页 */
  const awakeTitles = sectionsOf(at('awake')).map((s) => s.title)
  assert.ok(awakeTitles.includes('对话收尾'), '主动搭话页缺「对话收尾」')
})

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
  const el = findComponent(body, 'MemoryTab')
  assert.ok(el, '滚动区里应该有 MemoryTab')

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

/* ---------------- 直连状态那一节：不许撒谎 ---------------- */

/**
 * 移除 ai-chat 之后不再有「两端端口对不对得上」这件事。
 * 但「面板在撒谎」的教训仍然适用：不知道状态就说不知道，
 * 不能拿配置值、默认值或一个绿灯冒充「真的连上了」。
 */
const pvOf = () => {
  const rt = makeReact()
  return loadClient(rt.React).portView
}

test('直连状态：还没上报状态时说不知道，不装成正常', () => {
  const pv = pvOf()({})
  assert.equal(pv.kind, 'unknown')
  assert.match(pv.text, /还没开始|状态/)
  assert.equal(pv.cell, '—')
})

test('直连状态：online 才是绿的，并带出 seq', () => {
  const pv = pvOf()({ roost: { state: 'online', seq: 42 } })
  assert.equal(pv.kind, 'ok')
  assert.equal(pv.cell, 'seq 42')
  assert.match(pv.text, /已连上/)
})

test('直连状态：报错要说清原因，不能只说「连不上」', () => {
  const pv = pvOf()({ roost: { state: 'error', lastError: 'token 不对' } })
  assert.equal(pv.kind, 'bad')
  assert.match(pv.text, /token 不对/)
})

test('直连状态：重连中要说明会补拉，别让人以为消息丢了', () => {
  const pv = pvOf()({ roost: { state: 'reconnecting' } })
  assert.equal(pv.kind, 'unknown')
  assert.match(pv.text, /补拉/)
})

test('直连状态：停了就直说停了，不给绿灯', () => {
  const pv = pvOf()({ roost: { state: 'stopped' } })
  assert.equal(pv.kind, 'unknown')
  assert.match(pv.text, /已停止/)
})

test('移除 ai-chat：portView 不再接受对端 URL，也不再有 sync 动作', async () => {
  const pv = pvOf()({ channel: { current: 'roost' }, roost: { state: 'online', seq: 1 } }, 'http://ignored')
  assert.equal(pv.kind, 'ok', '第二个参数即使传了也必须被忽略')
  assert.equal(pv.action, undefined)
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const a = src.indexOf('function portView(')
  const b = src.indexOf('function OverviewTab(', a)
  assert.doesNotMatch(src.slice(a, b), /ai-chat|gotUrl|action: 'sync'/)
})

/**
 * 合并清单：装了的一律在前，仓库里没装的接在后，行内直接装。
 *
 * 这里取代了原来的「市场页」两条测试。原来本地和仓库是两页，
 * 同一个名字在两边各出现一次，用户得先判断自己在哪一页才能动手；
 * 现在是一张表，所以断言也变成「一张表里两类行都在、顺序对、动作对」。
 */
test('前端渲染：装了的人格在前，仓库里没装的接在后，且能直接装', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()

  const txt = textOf(expand(h(mod.HerTab, {
    config: { persona: { current: 'default' } },
    personas: {
      ok: true,
      current: 'default',
      byChat: {},
      usage: {},
      personas: [
        { id: 'default', label: '大肥鱼', tags: ['短句'], chars: 290 },
        { id: 'xiaoqi', label: '小栖', tags: ['日常'], chars: 103 },
        { id: 'mine', label: '自建的', tags: [], chars: 66 },
      ],
    },
    mem: { chatId: 'g1', personaOverride: '', authz: null },
    toast: () => {}, save: async () => ({ ok: true }), reload: async () => {}, quick: null,
    repoSeed: {
      ok: true, pending: 1, stale: false, gate: { ok: true },
      personas: [
        { id: 'default', label: '大肥鱼', chars: 320, localChars: 290, state: 'update' },
        { id: 'xiaoqi', label: '小栖', chars: 100, localChars: 103, state: 'same' },
        { id: 'remote', label: '仓库里的', tags: ['吐槽'], chars: 210, state: 'missing' },
        { id: 'gone', label: '删掉的', tags: [], chars: 90, state: 'deleted' },
      ],
    },
  }), rt))

  /**
   * **默认只列本地的**（2026-11-05 改）。
   *
   * 用户的诉求是「我本地就想列我下载/同步过来的那几个」——三百多份卡里
   * 绝大多数这辈子不会装，全铺出来会把在用的挤出屏幕。
   *
   * 所以仓库那批收成一行折叠条；搜索时（`pq` 非空）才两边都搜。
   * `pq` 是内部 state，这里测不到搜索态，只测默认态 + 折叠条。
   */
  for (const must of ['大肥鱼', '小栖', '自建的']) {
    assert.ok(txt.includes(must), `清单里缺「${must}」`)
  }
  assert.ok(!txt.includes('仓库里的'), '默认不该把仓库里没装的铺出来')
  assert.ok(txt.includes('在线仓库还有 1 个没装'), '要告诉用户仓库里还有几个（否则他以为没了）')
  assert.ok(txt.includes('有更新'), '本地那份有更新时要标出来')
  // 计数要把两边都说清
  assert.ok(txt.includes('3 个 · 仓库还有 1 个没装'), '头部要写清「已装几个、仓库还有几个」')
  // 删过的不默认挂在清单里，但要给捞回来的入口
  assert.ok(!txt.includes('删掉的'), '删过的人格不该默认显示')
  assert.ok(txt.includes('已删 1'), '要给一个「已删 N」的入口')
})

/**
 * 仓库出问题时，本地清单不能被一起吞掉。
 *
 * 门槛不过（老版本解析不了新格式）时仓库行**必须整体不参与**——
 * 列出来点「装」只会装进半个人格。但本地那几份照常能切换、能编辑。
 */
test('前端渲染：仓库读不了时，本地人格照常显示', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()

  const txt = textOf(expand(h(mod.HerTab, {
    config: null,
    personas: {
      ok: true, current: 'xiaoqi', byChat: {}, usage: {},
      personas: [{ id: 'xiaoqi', label: '小栖', tags: ['日常'], chars: 103 }],
    },
    mem: { chatId: 'g1', personaOverride: '', authz: null },
    toast: () => {}, save: async () => ({ ok: true }), reload: async () => {}, quick: null,
    repoSeed: {
      ok: true, pending: 0, stale: true,
      gate: { ok: false, why: '这批人格需要 dsh-roost 9.9 以上（你装的是 0.1）' },
      personas: [{ id: 'remote', label: '装不了的', tags: [], chars: 200, state: 'missing' }],
    },
  }), rt))

  assert.ok(txt.includes('小栖'), '仓库门槛不过时，本地人格必须照常显示')
  assert.ok(txt.includes('这批人格需要 dsh-roost 9.9 以上'), '要把门槛原因说出来')
  assert.ok(txt.includes('缓存的仓库清单'), '用的是缓存要说一声')
  assert.ok(!txt.includes('装不了的'), '门槛不过时不许把仓库里的人格拉出来诱人点击')
})

test('前端渲染：人格页不再分「我的人格 / 人格仓库」两段', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'her'
  rt.reset()
  const txt = textOf(expand(mod.RoostPage(), rt))

  assert.ok(!txt.includes('人格仓库'), '分段控件「人格仓库」应该没了')
  assert.ok(!txt.includes('我的人格'), '分段控件「我的人格」应该没了')
  assert.ok(txt.includes('从仓库更新'), '合并后仍要有「从仓库更新」按钮')
  assert.ok(txt.includes('新建'), '合并后仍要有「新建」')
  assert.ok(txt.includes('整理'), '批量整理要有入口')
})

test('前端渲染：心情独立成页，「主动搭话」里不再有情绪块', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const at = (t) => { store['roost.tab'] = t; rt.reset(); return textOf(expand(mod.RoostPage(), rt)) }

  const moodTxt = at('mood')
  assert.ok(moodTxt.includes('此刻情绪'), '心情页缺「此刻情绪」')
  assert.ok(moodTxt.includes('变化记录'), '心情页缺变化记录')
  assert.ok(moodTxt.includes('清空心情历史'), '心情页缺清空入口')

  const awake = at('awake')
  assert.ok(!awake.includes('此刻情绪'), '主动搭话页不该再有情绪块（已拆成心情页）')
  assert.ok(awake.includes('这一轮算出来的机会'), '主动搭话页丢了排期内容')

  const her = at('her')
  assert.ok(!her.includes('此刻情绪'), '人格页不该有情绪块')
  assert.ok(!her.includes('语音条'), '人格页不该有语音条')
})

test('前端渲染：表情包与语音合成搬到「表达」页', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement

  /**
   * 这两块从「设置」搬到「表达」（2026-11-12）：它们说的是
   * **她怎么出声、怎么发表情**，和「配置文件在哪」没有关系。
   *
   * 语音这一段现在有**专用表单**（不再是只读地显示 ai-chat 的音色）：
   * provider、地址、模型、音色都在这里配，所以断言换成这些字段。
   */
  const txt = textOf(
    expand(
      h(mod.ExpressTab, {
        config: { stickers: { enabled: true, dir: '' }, tts: { enabled: false, provider: 'openai' } },
        saveCfg: async () => ({ ok: true }),
        toast: () => {},
        reload: () => {},
        stickers: { dir: 'C:/x/stickers', items: [{ file: 'a.png', tags: [] }], chars: 42 },
      }),
      rt,
    ),
  )

  assert.ok(txt.includes('表情包'), '表达页缺「表情包」卡片')
  assert.ok(txt.includes('语音合成'), '表达页缺「语音合成」卡片')
  assert.ok(txt.includes('42 字'), '表情包要显示它占多少提示词预算')
  assert.ok(txt.includes('启用语音合成'), '语音合成要有一个明确的启用开关')
  assert.ok(txt.includes('OpenAI 兼容'), '语音合成要能选 provider')
  assert.ok(txt.includes('默认关闭'), '要说明默认关闭，否则用户会以为坏了')

  /**
   * 本地模型分支要有一键安装。
   *
   * 这条单独渲染一次：默认 provider 是 openai，走不到 sherpa 那段。
   * 用户最关心的就是「点一下能不能装好」，所以按钮文案必须真的出现在页面上。
   */
  const localTxt = textOf(
    expand(
      h(mod.ExpressTab, {
        config: { stickers: { enabled: true, dir: '' }, tts: { enabled: true, provider: 'sherpa', sherpa: { model: 'aishell3', sid: 88 } } },
        save: async () => ({ ok: true }),
        saveCfg: async () => ({ ok: true }),
        toast: () => {},
        stickers: { dir: 'C:/x/stickers', items: [], chars: 0 },
        setupSt: { pluginInstalled: true, pluginConfig: {} },
      }),
      rt,
    ),
  )
  assert.ok(localTxt.includes('本地模型'), 'provider 列表要有本地模型')
  assert.ok(localTxt.includes('一键安装'), '本地模型要有「一键安装」按钮')
  assert.ok(localTxt.includes('说话人编号'), '本地模型要能换音色（sid）')
  assert.ok(localTxt.includes('完全离线'), '要说明本地模型不联网')

  /**
   * GPT-SoVITS 分支：填目录 + 探测 + 一键启动。
   *
   * 这条以前根本没有——用户得自己 cd 到安装目录、起 python、挑端口、
   * 再把地址抄回面板。这四项每一件都能让人卡住。
   */
  const gptTxt = textOf(
    expand(
      h(mod.ExpressTab, {
        config: {
          stickers: { enabled: true, dir: '' },
          tts: { enabled: true, provider: 'gpt-sovits', gptSovits: { installDir: 'D:/GPT-SoVITS' } },
        },
        save: async () => ({ ok: true }),
        saveCfg: async () => ({ ok: true }),
        toast: () => {},
        stickers: { dir: 'C:/x/stickers', items: [], chars: 0 },
        setupSt: { pluginInstalled: true, pluginConfig: {} },
      }),
      rt,
    ),
  )
  assert.ok(gptTxt.includes('安装目录'), 'GPT-SoVITS 要有「安装目录」输入')
  assert.ok(gptTxt.includes('探测'), 'GPT-SoVITS 要能先探测目录')
  assert.ok(gptTxt.includes('一键启动'), 'GPT-SoVITS 要能一键启动')

  /**
   * MiMo 分支：它没有 /audio/speech，字段形态和 openai 不一样。
   *
   * 用户最容易踩的两件事——Key 是必填、语速对它无效——都必须在页面上
   * 说出来，否则只会得到「填了地址也没声」。
   */
  const mimoTxt = textOf(
    expand(
      h(mod.ExpressTab, {
        config: {
          stickers: { enabled: true, dir: '' },
          tts: { enabled: true, provider: 'mimo', mimo: { apiKey: 'sk-x' } },
        },
        save: async () => ({ ok: true }),
        saveCfg: async () => ({ ok: true }),
        toast: () => {},
        stickers: { dir: 'C:/x/stickers', items: [], chars: 0 },
        setupSt: { pluginInstalled: true, pluginConfig: {} },
      }),
      rt,
    ),
  )
  assert.ok(mimoTxt.includes('小米 MiMo'), 'provider 列表要有 MiMo')
  assert.ok(mimoTxt.includes('API Key'), 'MiMo 要能填 Key')
  assert.ok(mimoTxt.includes('语气提示'), 'MiMo 要能填语气提示（它决定 assistant 那条的语气）')
  assert.ok(mimoTxt.includes('不支持语速'), '要说明语速对 MiMo 无效')
})

test('前端渲染：老的 market 页签状态会回退到人格页', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'market'
  rt.reset()
  const txt = textOf(expand(mod.RoostPage(), rt))
  // 锚点用「从仓库更新」：分段的「我的人格」已经删了，而概览页没有这个按钮
  assert.ok(txt.includes('从仓库更新'), 'market 应该回退到人格页，而不是概览')
})

test('前端渲染：接入页有「组件版本」块（框架 / ai-chat 更新提示）', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'setup'
  rt.reset()
  const txt = textOf(expand(mod.RoostPage(), rt))

  assert.ok(txt.includes('组件版本'), '接入页缺「组件版本」块')
  assert.ok(txt.includes('重新检查'), '缺「重新检查」按钮')
})

test('前端渲染：组件版本块能显示「当前 → 最新」和更新提示', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement

  // 直接渲染组件：放在接入页里时它读内部 state，假 React 不跑 effect，只能看到「读着…」
  const txt = textOf(
    expand(
      h(mod.DepsBlock, {
        busy: false,
        onCheck: () => {},
        info: {
          framework: { installed: '0.9.9', latest: '0.9.10', hasUpdate: true },
        },
      }),
      rt,
    ),
  )

  assert.ok(txt.includes('v0.9.9') && txt.includes('→ v0.9.10'), '框架要显示当前 → 最新')
  assert.ok(txt.includes('有更新'), '框架有新版要提示')
  assert.ok(txt.includes('下载 tar 包解压覆盖'), '框架更新要给具体做法')
  assert.ok(!txt.includes('ai-chat 插件'), '移除 ai-chat 后不该再有插件版本行')
  assert.ok(!txt.includes('插件有新版'), '不该出现插件更新提示')
})

test('前端渲染：组件版本块查不到时不报错，只写「查不到最新版」', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement

  const txt = textOf(
    expand(
      h(mod.DepsBlock, {
        busy: false,
        onCheck: () => {},
        info: {
          framework: { installed: '0.9.9', latest: '', hasUpdate: false, error: '网络不通' },
          plugin: { installed: '', latest: '', hasUpdate: false, error: '网络不通' },
        },
      }),
      rt,
    ),
  )

  assert.ok(txt.includes('查不到最新版'), '没有最新版时要写明')
  assert.ok(txt.includes('不影响使用'), '要说明不影响使用')
})

test('前端渲染：扫码 / 填配置那块要提示「换账号去 Roost 面板」', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'setup'
  rt.reset()
  const txt = textOf(expand(mod.RoostPage(), rt))

  // 这个页面只建第一个机器人；改已有账号得去 Roost 面板的「配置」
  assert.ok(txt.includes('要换账号'), '缺换账号提示')
  assert.ok(txt.includes('Roost 面板的「配置」'), '要指明去哪儿改')
})

test('前端渲染：能力页要能显示四档结论，且缺数据不炸', () => {
  /**
   * 这一页最容易犯的错是**读空数据就炸**：新装用户没有 `seen`、
   * 没启用时没有 `results`，任何一处少写 `?.` 就是白屏。
   *
   * 同时盯住内容真的渲染出来了——只断言"不抛"的话，
   * 把整个 return 换成 null 也能过。
   */
  const rt = makeReact()
  const mod = loadClient(rt.React)
  assert.equal(typeof mod.CapsTab, 'function', '必须导出 CapsTab')

  const base = {
    enabled: true,
    store: {
      seen: { tools: { edit: 1, read: 1, gh_repo: 1, mcp__graphflow__gf_exec: 1 } },
      /**
       * **`defaults` 必须给**，而且五种形态都要覆盖。
       *
       * 2026-11-05 02:41 的黑屏就出在这里：`defaults` 为空时
       * `roleOf(undefined)` 直接 early return，测试全绿；
       * 但真实用户有配置，`roleOf` 会走到 `ROLES.find`，
       * 而「跟随」那一项没有 `allow` → `[...undefined]` → TypeError → 整页黑屏。
       *
       * 所以这里刻意给全：
       *   owner  → `['*']`（匹配「全权」）
       *   admin  → 四项（匹配「只聊天」）
       *   manager → **不写 allow**（走「跟随」）
       *   member → 三项（匹配「只聊天」）
       *   unknown → 空数组（走「自定义」）
       */
      defaults: {
        owner: { allow: ['*'] },
        admin: { allow: ['memory_search', 'memory_note', 'qq_send', 'sticker_pick'] },
        manager: {},
        member: { allow: ['memory_search', 'qq_send', 'sticker_pick'] },
        unknown: { allow: [] },
      },
    },
    pending: { added: ['gh_repo'], gone: [] },
  }
  const preview = {
    danger: { edit: 'edit', mcp__graphflow__gf_exec: 'mcp__*__*_exec' },
    pool: ['edit', 'read', 'gh_repo', 'mcp__graphflow__gf_exec'],
    results: [
      { bucket: 'owner', allow: ['edit', 'read', 'gh_repo', 'mcp__graphflow__gf_exec'], deny: [] },
      { bucket: 'admin', allow: ['read'], deny: ['edit', 'gh_repo', 'mcp__graphflow__gf_exec'] },
      { bucket: 'manager', allow: ['read'], deny: ['edit', 'gh_repo', 'mcp__graphflow__gf_exec'] },
      { bucket: 'helper', allow: ['read'], deny: ['edit', 'gh_repo', 'mcp__graphflow__gf_exec'] },
      { bucket: 'member', allow: ['read'], deny: ['edit', 'gh_repo', 'mcp__graphflow__gf_exec'] },
      { bucket: 'unknown', allow: [], deny: ['edit', 'read', 'gh_repo', 'mcp__graphflow__gf_exec'] },
    ],
  }

  const feat = {
    on: { memory: true, qqTools: false, speakUp: false, awake: false },
    raw: { qqTools: false },
    features: [
      { id: 'qqTools', label: '分段说话 / 退场 / @人', desc: '把说几句交给她', offHint: '退回一整段', risky: false, source: 'config', affects: ['qq_send'], requires: [] },
      { id: 'memory', label: '三层记忆', desc: '记人', offHint: '不再记', risky: false, source: 'config', affects: [], requires: [] },
    ],
    groups: [
      { id: 'talk', label: '怎么说话', ids: ['qqTools'] },
      { id: 'memory', label: '记不记得', ids: ['memory'] },
    ],
    blocked: { awake: '主动搭话' },
    wouldRemove: ['qq_send', 'qq_close'],
  }

  rt.reset()
  let tree
  assert.doesNotThrow(() => {
    const quota = {
      builtin: ['voice', 'file', 'sticker', 'tool', 'memory'],
      /** 工具池：故意留一个没配额度的（gh_search），它也要被列出来 */
      pool: ['web_search', 'gh_search'],
      poolSource: 'live',
      rows: [
        { feature: 'voice', label: '语音条', window: 'day', per: 'person', max: 3, peak: 3, buckets: 1, byBucket: { member: 3 } },
        { feature: 'file', label: '发文件', window: 'hour', per: 'person', max: 2, peak: 0, buckets: 0 },
        { feature: 'web_search', label: 'web_search', window: 'day', per: 'person', max: 20, peak: 7, buckets: 2 },
      ],
    }
    tree = expand(mod.CapsTab({ caps: base, preview, chats: [{ chatId: 'G1', title: '测试群' }], feat, quota, toast: () => {}, reload: () => {}, quick: async () => ({}), busy: false }), rt)
  })

  const txt = textOf(tree)
  assert.ok(txt.includes('主人'), '缺主人档')
  assert.ok(txt.includes('群成员'), '缺群成员档')
  assert.ok(txt.includes('新增 1 个'), '没提示新增的工具')
  assert.ok(txt.includes('MCP'), '工具清单没分组')
  assert.ok(txt.includes('已启用'), '启用状态没渲染')
  // 四档角色按钮：没有这排按钮，用户就只能去手改 JSON
  for (const role of ['只聊天', '能查能看', '能干活', '全权']) {
    assert.ok(txt.includes(role), `缺角色「${role}」`)
  }
  // 五档要对齐框架的 0/1/2/3，少一张卡就等于少一个能配的身份
  for (const b of ['主人', '管理员', '群管', '助手', '群成员']) {
    assert.ok(txt.includes(b), `缺档位「${b}」`)
  }
  assert.ok(txt.includes('五个档位'), '标题要改成五档')
  assert.ok(txt.includes('跟随'), '缺「跟随」这个继承态')
  // 角色判定要能同时处理「有 allow」「没有 allow」「匹配不上」三种情况
  assert.ok(txt.includes('跟随更低档'), 'manager 没 allow 时要显示「跟随更低档」，不能显示成自定义')
  assert.ok(txt.includes('自定义'), 'unknown 的 allow 是空数组、匹配不上任何角色，要显示「自定义」')
  assert.ok(txt.includes('固定'), '兜底档要标成固定不可配')
  // 明细已收进弹窗，页面上只留入口
  assert.ok(txt.includes('逐个调整'), '缺打开工具面板的按钮')
  // 分群例外：没这句说明用户会以为"每个群都得配一遍"
  assert.ok(txt.includes('跟随默认'), '缺分群入口')
  assert.ok(txt.includes('测试群'), '群名没渲染出来')
  // 功能开关：分组、关掉的说明、被依赖挡住的原因
  assert.ok(txt.includes('她会做什么'), '缺功能开关区')
  assert.ok(txt.includes('怎么说话'), '功能开关没按分组渲染')
  assert.ok(txt.includes('关掉之后'), '关着的开关要说明后果')
  assert.ok(txt.includes('收走'), '要显示这些关闭会收走哪些工具')
  // 次数限制：功能名、单位、用满提示
  assert.ok(txt.includes('次数限制'), '缺次数限制区')
  assert.ok(txt.includes('语音条'), '配额行没渲染')
  assert.ok(txt.includes('每人 · 每天'), '单位和窗口要用中文')
  assert.ok(txt.includes('用满了'), '用满的要标出来')
  // 工具那组：内置/工具分开、池里没配过的也要列、不限要写出来
  assert.ok(txt.includes('工具（只填想限的）'), '缺工具配额组')
  assert.ok(txt.includes('web_search'), '已配的工具没渲染')
  // 未配的工具不铺在列表里（那样又变回一米长），但要能从下拉里选到
  assert.ok(txt.includes('gh_search'), '没配过的工具也要能从下拉里选到')
  assert.ok(JSON.stringify(tree).includes('＋ 给某个工具加次数限制'), '缺「添加工具」下拉')
  assert.ok(txt.includes('不限'), '留空的含义要写出来')
  // 按档位设额度：下拉在、单独设过的档位要能看出来
  assert.ok(JSON.stringify(tree).includes('"value":"member"'), '缺档位下拉')
  assert.ok(txt.includes('这一档单独设了'), '单独设过的档位没有标识')

  // 空数据（刚装、还没观察过）不能炸
  rt.reset()
  assert.doesNotThrow(() => {
    expand(mod.CapsTab({ caps: { enabled: false, store: {}, pending: {} }, preview: null, toast: () => {}, reload: () => {}, quick: async () => ({}), busy: false }), rt)
  })
  // caps 整个是 null 时给一句占位，而不是白屏
  rt.reset()
  const empty = textOf(expand(mod.CapsTab({ caps: null, preview: null, toast: () => {}, reload: () => {}, quick: async () => ({}), busy: false }), rt))
  assert.ok(empty.includes('正在读'), '没有数据时要有占位文案')
  // 扩展已拆成独立页，能力页不再混放扩展块
  assert.ok(!empty.includes('扩展 · 说明编辑与凭据状态'), '能力页不该再放扩展说明编辑')
})

test('拆分后每页分节编号都从 01 起、连续', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const ns = (node) => sectionsOf(node).filter((s) => s.n).map((s) => s.n)

  /* 设置页：工作区 / 配置全文 / 各段说明 */
  rt.reset()
  assert.deepEqual(ns(expand(mod.ConfigTab({
    config: {}, save: () => {}, saveCfg: () => {}, toast: () => {},
    stickers: null, setupSt: null, reload: () => {},
  }), rt)), ['01', '02', '03'], '设置页编号应 01–03 连续')

  /* 表达页：语音合成 / 表情包（两边原本是 05 和 04，拆出来后各自的编号要归一） */
  rt.reset()
  assert.deepEqual(ns(expand(mod.ExpressTab({
    config: {}, saveCfg: () => {}, toast: () => {}, reload: () => {}, stickers: null,
  }), rt)), ['01', '02'], '表达页编号应 01–02 连续')

  /* 心情页：此刻情绪 / 3.5 衰减与基线 / 变化记录 */
  rt.reset()
  assert.deepEqual(ns(expand(mod.MoodTab({
    mood: null, reloadMood: () => {}, toast: () => {}, quick: async () => ({}),
  }), rt)), ['01', '02', '03'], '心情页编号应 01–03 连续')

  /* 群聊策略页：2.2a 五张 + 2.2b 三张，01 起连续 */
  rt.reset()
  assert.deepEqual(ns(expand(mod.GroupChatTab({
    config: { roostHost: { decide: { mode: 'ai' }, merge: {} }, chat: {}, group: {} },
    saveCfg: () => {}, toast: () => {}, setTab: () => {},
  }), rt)), ['01', '02', '03', '04', '05', '06', '07', '08'], '群聊策略页编号应 01–08 连续')
})

test('2.7 工作区挪进首次设置：设置页留链接，卡片本体控件一个不少', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)

  /* 设置页：01 工作区只剩一行链接，没有编辑框；02/03 照旧 */
  rt.reset()
  const tree = expand(mod.ConfigTab({
    config: {}, save: () => {}, saveCfg: () => {}, toast: () => {},
    stickers: null, setupSt: null, reload: () => {}, setTab: () => {},
  }), rt)
  const txt = textOf(tree)
  assert.ok(txt.includes('去首次设置页改'), '设置页要留一行跳转链接')
  assert.ok(txt.includes('首次设置'), '链接文案要说清去哪')
  assert.ok(!txt.includes('目录（留空=数据目录'), '设置页不该再有工作区编辑框')

  /* 卡片本体：在首次设置页不带编号徽标（那页的 1–6 是接入步骤圆圈号） */
  rt.reset()
  const card = expand(mod.WorkspaceCard({
    saveCfg: () => {}, toast: () => {}, numbered: false,
  }), rt)
  const secs = sectionsOf(card).filter((s) => s.n).map((s) => s.n)
  assert.deepEqual(secs, [], 'numbered=false 时不该有编号徽标')
  const ctxt = textOf(card)
  for (const must of ['工作区', '保存', '改名', '换目录只影响之后新建的会话']) {
    assert.ok(ctxt.includes(must), `工作区卡片少了「${must}」`)
  }

  /* 带编号时仍是 01：旧用法不被顺手改坏 */
  rt.reset()
  const numbered = expand(mod.WorkspaceCard({ saveCfg: () => {}, toast: () => {} }), rt)
  assert.deepEqual(sectionsOf(numbered).filter((s) => s.n).map((s) => s.n), ['01'])
})

test('群聊策略页：露的是已有配置键，配色走本项目令牌', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const cfg = {
    roostHost: {
      decide: {
        mode: 'window', windowMin: 5, engagedMaxTurns: 6, cooldownSec: 20,
        maxRepliesPerMin: 3, maxPerHour: 0, burstMax: 0,
        quietStartHour: 22, quietEndHour: 7, shortAskMustReply: false,
        silent: false, ignoreWords: ['/'],
      },
      merge: { waitSec: 1.5, maxSec: 6 },
    },
    chat: { turnTimeoutSec: 150 },
  }
  const tree = expand(mod.GroupChatTab({
    config: cfg, saveCfg: () => {}, toast: () => {}, setTab: () => {},
  }), rt)
  const txt = textOf(tree)
  for (const must of [
    '什么时候接话', '连发合并', '安全刹车', '静默时段与忽略词', '一轮与队列',
    '接话方式', '最多等多久', '两分钟内最多接几次', '去权限页', '去排障页',
    /** 2.2b 三张卡；2.2a 的十项一个都不能被顺手删掉 */
    '插话概率', '按群覆写', '刚才为什么回', '保存这个群的例外', '恢复成全局',
  ]) {
    assert.ok(txt.includes(must), `群聊策略页缺少「${must}」`)
  }
  /* 形态借 aurabot 的 Card/Row，但类名和配色不能把它的 ab-* 蓝带进来 */
  const cls = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.className) cls.push(String(n.props.className))
    walk(n.props?.children)
  })(tree)
  const classTxt = cls.join(' ')
  assert.ok(classTxt.includes('roost-g-card'), '卡片要走本项目样式类')
  assert.ok(!classTxt.includes('ab-card') && !classTxt.includes('ab-sea'), '不该残留 aurabot 的配色/类名')

  /* 配置没到时只给占位，绝不能在空对象上渲染控件（点了会把 roostHost 冲掉） */
  rt.reset()
  const empty = textOf(expand(mod.GroupChatTab({
    config: null, saveCfg: () => {}, toast: () => {}, setTab: () => {},
  }), rt))
  assert.ok(empty.includes('读取配置'), '配置未到要有占位')
  assert.ok(!empty.includes('接话方式'), '配置未到不该渲染可点的控件')
})

test('群聊页 v2：按群覆写 / 决策链都在，配色仍走本项目令牌', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const cfg = {
    roostHost: { decide: { mode: 'ai' }, merge: {} },
    chat: {},
    group: {
      interruptChance: 60, briefMaxItems: 12,
      overrides: { G_1: { mode: 'mention', maxPerHour: 3 } },
    },
  }
  const tree = expand(mod.GroupChatTab({
    config: cfg,
    chats: [{ chatId: 'G_1', kind: 'group', title: 'QQ · 斗罗内测' }],
    saveCfg: () => {}, saveAll: () => {}, toast: () => {}, setTab: () => {},
  }), rt)
  const txt = textOf(tree)
  for (const must of [
    '插话概率', '群聊摘要回几条', '按群覆写', '给哪个群设', '每小时最多',
    '保存这个群的例外', '恢复成全局', '已经设了例外的群', '刚才为什么回 / 不回',
  ]) {
    assert.ok(txt.includes(must), `群聊页 v2 缺少「${must}」`)
  }
  assert.ok(txt.includes('读取中'), '决策链没读到数据时要有加载态')
  /** 已经设了例外的群要显示群名与项数，别只显示一串 openid */
  assert.ok(txt.includes('斗罗内测'), '覆写列表要用会话名，不是裸 openid')
  assert.ok(txt.includes('2 项'), '覆写项数要跟着配置走')

  const cls = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.className) cls.push(String(n.props.className))
    walk(n.props?.children)
  })(tree)
  const classTxt = cls.join(' ')
  assert.ok(classTxt.includes('roost-g-card') && classTxt.includes('roost-g-ov'))
  assert.ok(!classTxt.includes('ab-card') && !classTxt.includes('ab-sea'), '不该残留 aurabot 的配色/类名')
})

test('后端缺口已接入：市场 / 模型 / 召回 / 心情历史 / 危险操作', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const at = (t) => { store['roost.tab'] = t; rt.reset(); return textOf(expand(mod.RoostPage(), rt)) }
  /* 扩展在 2026-11-12 独立成组并拆成三页：市场 / 已安装 / 接口 */
  assert.ok(at('ext-market').includes('扩展市场'), '市场页缺市场')
  assert.ok(at('ext-market').includes('检查更新'), '市场页缺检查更新入口')
  assert.ok(at('ext-api').includes('扩展 /v1 客户端令牌'), '接口页缺令牌块')
  /* 模型块已从设置页拆出（2026-11-12），这里跟着换到模型页验 */
  rt.reset()
  const modelTxt = textOf(expand(mod.ModelTab({ toast: () => {}, currentChatId: '' }), rt))
  /**
   * 模型页 2026-11-13 改成「从 DSH 清单里选」：provider/model 手填降级成
   * 清单拉不到时的退路，主路径变成三张卡。断言跟着换成这些必须出现的入口。
   */
  assert.ok(modelTxt.includes('聊天用的模型'), '模型页缺「聊天用的模型」卡')
  assert.ok(modelTxt.includes('思考强度'), '模型页缺思考强度')
  assert.ok(modelTxt.includes('视觉能力'), '模型页缺视觉能力')
  assert.ok(modelTxt.includes('按聊天选模型'), '模型页缺按聊天选模型')
  assert.ok(modelTxt.includes('单个 QQ / 群的例外'), '模型页缺单个聊天的例外入口')
  assert.ok(modelTxt.includes('可用的模型'), '模型页缺可用模型清单')
  assert.ok(at('config').includes('危险操作'), '设置页缺危险操作总入口')
  assert.ok(at('memory').includes('召回记录'), '记忆页缺 recall.log 入口')
  assert.ok(at('mood').includes('清空心情历史'), '心情页缺 mood.history.clear 入口')
  assert.ok(at('update').includes('交流反馈群'), '更新页缺反馈群')
})

/**
 * 2026-11-13：账号迁移从「设置 → 危险操作」底部的弹窗提成正式页签。
 *
 * 换机器人（换 AppID）是真实高频需求，藏在弹窗里等于没有入口。这里钉三件事：
 *   1. 页签栏里能点到「账号迁移」（不再靠隐藏页标记）
 *   2. 内容渲染在正文里，**不在弹窗里**（弹窗形态已撤销）
 *   3. 设置页那颗「账号迁移…」按钮还在，但改成跳页签而不是开弹窗
 */
test('账号迁移是正式页签：正文渲染，不走弹窗', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(!src.includes("setPageModal('account')"), '账号迁移还留着弹窗入口')
  assert.ok(!HIDDEN_TABS.includes('account'), '账号迁移不该再是隐藏页')

  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'account'
  rt.reset()

  /* 未展开的树上找组件：展开之后函数组件会被执行掉，元素本身就不在了 */
  const raw = mod.RoostPage()
  const body = raw.props.children.find((n) => String(n?.props?.className || '').includes('roost-scroll-body'))
  assert.ok(findComponent(body, 'AccountTab'), '账号迁移页没渲染在正文滚动区里')

  rt.reset()
  const tree = expand(raw, rt)
  const { tabs, current } = navTexts(tree)
  assert.ok(tabs.includes('账号迁移'), '页签栏里找不到「账号迁移」')
  assert.equal(current, null, '正式页签不该再走隐藏页标记')

  let modal = false
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (String(n.props?.className || '').includes('cap-modal')) modal = true
    walk(n.props?.children)
  })(tree)
  assert.equal(modal, false, '账号迁移还在弹窗里')

  /* 设置页那颗按钮保留（老用户的肌肉记忆），文案不变、改成跳页签 */
  store['roost.tab'] = 'config'
  rt.reset()
  const cfg = expand(mod.RoostPage(), rt)
  let btn = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'button' && textOf(n) === '账号迁移…') btn = n
    walk(n.props?.children)
  })(cfg)
  assert.ok(btn, '设置页缺「账号迁移…」入口')
  assert.equal(typeof btn.props.onClick, 'function', '「账号迁移…」没有点击入口')
})

test('隐藏页有当前位置标记，页签栏不会看起来一个都没选', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'setup'
  rt.reset()
  let found = false
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.props?.className === 'roost-nav-current') found = true
    walk(n.props?.children)
  })(expand(mod.RoostPage(), rt))
  assert.ok(found, '隐藏页没有当前位置标记')
})

test('扩展独立成组：已安装 / 市场 / 接口三页各管一件事', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const at = (t) => { store['roost.tab'] = t; rt.reset(); return textOf(expand(mod.RoostPage(), rt)) }

  /* 已安装：档位矩阵 + 已装清单；不再混市场条目 */
  const installed = at('ext')
  assert.ok(installed.includes('已装扩展'), '已安装页缺已装清单')
  assert.ok(installed.includes('扩展能力分组'), '已安装页缺档位矩阵')
  assert.ok(!installed.includes('检查更新'), '已安装页不该再有市场操作')

  /* 市场：能装什么、装/更新 */
  const market = at('ext-market')
  assert.ok(market.includes('扩展市场'), '市场页缺标题')
  assert.ok(market.includes('检查更新'), '市场页缺检查更新入口')
  assert.ok(!market.includes('扩展能力分组'), '市场页不该有档位矩阵')

  /* 接口：令牌 */
  assert.ok(at('ext-api').includes('扩展 /v1 客户端令牌'), '接口页缺令牌块')
})

test('页签顺序：权限排在设置左边', () => {
  /**
   * 位置是需求的一部分，所以要断言。
   *
   * 只断言「两页都在」是不够的——顺序调错了测试照样绿，
   * 而页签顺序是用户每天都要扫一遍的东西。
   */
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const caps = src.indexOf("['caps', '权限']")
  const config = src.indexOf("['config', '设置']")
  assert.ok(caps > 0, '找不到能力页签')
  assert.ok(config > 0, '找不到设置页签')
  assert.ok(caps < config, '「能力」必须在「设置」左边')
})


test('前端渲染：工具权限弹窗能搜索、能标出危险与钉住项', () => {
  /**
   * 弹窗默认是关着的，混在 CapsTab 里永远测不到里面的内容——
   * 「打开之后一片空白」这种问题只能靠肉眼发现。所以单独渲染一次。
   */
  const rt = makeReact()
  const mod = loadClient(rt.React)
  assert.equal(typeof mod.ToolsModal, 'function', '必须导出 ToolsModal')

  const pool = ['edit', 'read', 'memory_search', 'gh_repo']
  const allowedIn = (b, n) => b === 'owner' || n === 'memory_search'
  const base = {
    pool,
    caps: { enabled: true },
    busy: false,
    danger: { edit: 'edit' },
    pinned: ['memory_search'],
    riskGroups: [
      ['会改你的电脑', (n) => n === 'edit'],
      ['只看不改', (n) => n !== 'edit'],
    ],
    allowedIn,
    onToggle: () => {},
    q: '',
    setQ: () => {},
    onClose: () => {},
  }

  rt.reset()
  const tree = expand(mod.ToolsModal(base), rt)
  const txt = textOf(tree)
  assert.ok(txt.includes('工具权限（4 个）'), '标题要带数量')
  assert.ok(txt.includes('会改你的电脑'), '没按危险度分组')
  assert.ok(txt.includes('🔴'), '危险工具没标红')
  assert.ok(txt.includes('🔒'), '钉住项没标锁')
  /**
   * 搜索框是 `type=search` 的 input，`placeholder` 在属性上——
   * `textOf` 只收文本节点，拿不到它。所以直接看树里有没有这个类型的 input。
   */
  assert.ok(JSON.stringify(tree).includes('"type":"search"'), '缺搜索框')
  // 表头五档写全，且与下方刻度共用同一套 grid 列宽
  for (const k of ['主人', '管理员', '群管', '助手', '群成员']) {
    assert.ok(txt.includes(k), `表头缺「${k}」`)
  }
  const raw = JSON.stringify(tree)
  assert.ok(raw.includes('cap-tier'), '档位应是一条连续轨道上的滑块热区')
  assert.ok(!raw.includes('"type":"checkbox"'), '不该再留五列勾选框')
  // 全英文工具名要有中文 / 来源注释
  assert.ok(txt.includes('改文件'), 'edit 该标中文说明')
  assert.ok(txt.includes('GitHub'), 'gh_ 该标来源')

  // 搜不到时给一句人话，而不是空白
  rt.reset()
  const none = textOf(expand(mod.ToolsModal({ ...base, q: '不存在的东西' }), rt))
  assert.ok(none.includes('没有匹配'), '搜不到要有提示')

  // 搜索过滤：只留命中项
  rt.reset()
  const hit = textOf(expand(mod.ToolsModal({ ...base, q: 'gh_' }), rt))
  assert.ok(hit.includes('gh_repo'))
  assert.ok(!hit.includes('memory_search'), '不该留下没命中的')
})

test('前端渲染：本地一份都没有时，不能说「没有匹配「」」', () => {
  /**
   * 新装用户就是这个状态：本地 0 份、仓库 349 份。
   *
   * 旧逻辑只看 `rows.length`，而折叠后 rows 只剩本地的 → 0 →
   * 走进「没有匹配「${pq}」」，而 pq 是空的，页面上出现一对空引号，
   * 用户会以为页面坏了。必须单独一条分支把话说明白。
   */
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()

  const txt = textOf(expand(h(mod.HerTab, {
    config: { persona: { current: 'default' } },
    personas: { ok: true, current: 'default', byChat: {}, usage: {}, personas: [] },
    mem: { chatId: '', personaOverride: '', authz: null },
    toast: () => {}, save: async () => ({ ok: true }), reload: async () => {}, quick: null,
    repoSeed: {
      ok: true, pending: 0, stale: false, gate: { ok: true },
      personas: [
        { id: 'r1', label: '仓库甲', chars: 100, state: 'missing' },
        { id: 'r2', label: '仓库乙', chars: 200, state: 'missing' },
        { id: 'r3', label: '仓库丙', chars: 300, state: 'missing' },
      ],
    },
  }), rt))

  assert.ok(txt.includes('本地还没有人格'), '要说清是「本地没有」而不是「搜不到」')
  assert.ok(!txt.includes('没有匹配「」'), '空搜索词配「没有匹配」是明显的坏文案')
  assert.ok(txt.includes('看看仓库里的 3 个'), '要给一个能立刻点开的入口')
})

test('能力页：勾工具要保住 deny，继承档取消要写 deny（不是 allow: []）', () => {
  /**
   * 这是 2026-11-05 检查里最隐蔽的一处。原来 `toggleTool` 一行
   * `defaults[bucket] = { allow: next }`，把两件事同时做错了：
   *
   *  1. **`deny` 整段丢失**：用户在「助手」档配了「不给记忆」，
   *     去弹窗里勾任意一个工具，这条例外就无声消失了。
   *  2. **继承档取消写成了 `allow: []`**：`accumulateAllow` 把空数组
   *     当成「没写」继续继承低档，于是取消等于没点——勾选框变空，
   *     刷新后又勾回来。
   *
   * 两种错都「渲染正常、不报错」，所以只能断言算出来的配置本身。
   */
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const plan = mod.planToolToggle
  assert.equal(typeof plan, 'function', '必须导出 planToolToggle 才能测')

  // ① 有具体 allow + deny：勾一个新工具，deny 不能丢
  const a = plan({ cur: { allow: ['read'], deny: ['memory_search'] }, name: 'edit', on: true, expanded: [] })
  assert.deepEqual(a.allow, ['read', 'edit'], '勾上要追加')
  assert.deepEqual(a.deny, ['memory_search'], 'deny 不能被这次勾选冲掉')

  // ② 继承档（没有 allow）：取消一项只能写 deny
  const b = plan({ cur: {}, name: 'read', on: false, expanded: ['read', 'qq_send'] })
  assert.equal(b.allow, undefined, '不能写 allow: []，那语义是「这一档整档清零」')
  assert.deepEqual(b.deny, ['read'], '继承档取消要靠 deny 盖住低档')

  // ③ 继承档：勾一项写增量 allow，不把低档的清单抄进来
  const c = plan({ cur: {}, name: 'read', on: true, expanded: [] })
  assert.deepEqual(c.allow, ['read'], '`allow` 是增量：只写多出来的那个')

  // ④ 被 deny 盖着的工具，勾上要把那条 deny 去掉，否则勾了也没用
  const d = plan({ cur: { allow: [], deny: ['gh_*'] }, name: 'gh_repo', on: true, expanded: [] })
  assert.equal(d.deny, undefined, '通配 deny 盖住的项，勾上时要清掉（清空后连字段一起删）')
  assert.deepEqual(d.allow, ['gh_repo'])

  // ⑤ `*` 里取消一项：展开成具体清单再减（`*` 是无限集，删不掉）
  const e = plan({ cur: { allow: ['*'] }, name: 'read', on: false, expanded: ['read', 'edit'] })
  assert.deepEqual(e.allow, ['edit'])

  // ⑥ 重复勾同一个不产生重复项
  const f = plan({ cur: { allow: ['read'] }, name: 'read', on: true, expanded: [] })
  assert.deepEqual(f.allow, ['read'])

  // ⑦ deny 清空之后要删掉字段，别在文件里留一个空数组
  const g = plan({ cur: { allow: ['read'], deny: ['edit'] }, name: 'edit', on: true, expanded: [] })
  assert.equal(g.deny, undefined)
})

test('能力页：前端通配匹配必须和后端同语义（`*` 跨下划线）', () => {
  /**
   * 前端要判断「这条 deny 有没有盖住这个工具」，拿不到后端的 `matchPattern`，
   * 只能自己实现一份。语义一旦漂了，表现是「配置写了但那个工具还在」——
   * 所以用同一组样例两边各跑一遍。
   */
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const cases = [
    ['mcp__graphflow__gf_exec', 'mcp__*__*_exec', true],
    ['mcp__graphflow__gf_read', 'mcp__*__*_exec', false],
    ['gh_repo', 'gh_*', true],
    ['gh_repo', 'pr_*', false],
    ['edit', 'edit', true],
    ['edit', '*', true],
    ['editx', 'edit', false],
  ]
  for (const [name, pat, want] of cases) {
    assert.equal(mod.matchPat(name, pat), want, `matchPat(${name}, ${pat})`)
  }
})

/* ---------------- 2026-11-11 重设计：功能不变量 ---------------- */

/**
 * 页签改成两层后（2026-11-12），这里钉两件事：
 *   1. 8 个可见页仍然**都能点到**（在所属组的二级里，或在概览这一组里）
 *   2. 每一页都**恰好高亮一个**一级分组——高亮两个说明 tab 被分进了两次
 * 隐藏页由上面的循环逐个验渲染不炸。
 */
test('重设计：两层导航里 8 个可见页都可达', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)

  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  for (const id of TABS) {
    assert.ok(src.includes("['" + id + "',"), `页签 ${id} 从 TABS 里消失了`)
  }

  for (const id of TABS) {
    store['roost.tab'] = id
    rt.reset()
    const tree = expand(mod.RoostPage(), rt)

    const { tabs } = navTexts(tree)
    assert.ok(tabs.includes(TAB_LABEL[id]), `${id} 页在导航里找不到「${TAB_LABEL[id]}」入口`)

    let on = 0
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      if (n.props?.role === 'tab') {
        assert.equal(typeof n.props.onClick, 'function', '页签没有点击入口')
      }
      if (String(n.props?.className || '').includes('roost-grp') && n.props?.['data-on'] === '1') on++
      walk(n.props?.children)
    })(tree)

    assert.equal(on, 1, `${id} 页应恰好高亮一个一级分组，实际 ${on}`)
  }
})

/**
 * 折叠只由 CSS 隐藏，children 常驻 DOM：收起时组件不卸载，
 * 输入框里没提交的内容、弹窗开关都还在，功能一条不少。
 */
test('重设计：分节默认全展开，折叠不卸载任何功能元素', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(
    src.includes('.roost-sec.is-folded > *:not(.roost-sec-h){display:none}'),
    '折叠必须只用 CSS 隐藏，不能在 JS 里条件渲染掉 children',
  )

  const rt = makeReact()
  const mod = loadClient(rt.React)
  for (const tab of TABS) {
    store['roost.tab'] = tab
    rt.reset()
    const tree = expand(mod.RoostPage(), rt)
    let secs = 0
    let folds = 0
    let folded = 0
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) return n.forEach(walk)
      const cls = String(n.props?.className || '')
      if (cls.split(/\s+/).includes('roost-sec')) secs++
      if (cls.includes('roost-sec-fold')) {
        folds++
        /** 记忆页允许长分节默认收起（日记 / 关系 / 召回记录），别的页仍要全展开 */
        const want = tab === 'memory' ? n.props['aria-expanded'] : 'true'
        assert.ok(
          n.props['aria-expanded'] === 'true' || (tab === 'memory' && n.props['aria-expanded'] === 'false'),
          `${tab} 页分节默认状态不对：${n.props['aria-expanded']}`,
        )
        void want
      }
      if (cls.includes('is-folded')) folded++
      walk(n.props?.children)
    })(tree)
    if (tab === 'memory') {
      /** 主人要求：关系等容易太长的分节默认折叠，一进来别是一屏几千字 */
      assert.ok(folded >= 3, `记忆页长分节应默认收起，实际 ${folded}`)
    } else {
      assert.equal(folded, 0, `${tab} 页不该有默认收起的分节`)
    }
    assert.equal(folds, secs, `${tab} 页分节数 ${secs} 与折叠开关数 ${folds} 不一致`)
  }
  // 概览固定 6 节：保证上面不是「两边都是 0」的假通过
  store['roost.tab'] = 'overview'
  rt.reset()
  const overview = textOf(expand(mod.RoostPage(), rt))
  assert.ok(overview.includes('现在这样') && overview.includes('接入进度'), '概览页的分节内容没渲染出来')
})

/* ---------------- 首次接入向导 ---------------- */

test('向导：新装与升级两种文案都渲染得出来，链路对比不炸', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  for (const upgraded of [false, true]) {
    rt.reset()
    const txt = textOf(expand(
      h(mod.SetupWizard, {
        st: { wizard: { needed: true, upgraded } },
        toast: () => {}, onDone: () => {}, reload: () => {},
      }), rt,
    ))
    assert.ok(txt.includes('首次接入'), '要有向导标题')
    assert.ok(txt.includes('第 1 / 4 步'), '要显示步骤进度')
    assert.ok(txt.includes('QQ') && txt.includes('Roost 框架') && txt.includes('外接协议'),
      '链路对比图要把两端和新通道都画出来')
    assert.ok(txt.includes('ai-chat 插件'), '旧链路里要标出被移除的中间层')
    assert.ok(txt.includes('接下来三步'), '要有步骤清单')
    assert.ok(txt.includes('暂时跳过'), '老版 Roost 用户必须有逃生口')
    assert.ok(txt.includes('下一步'), '要能往下走')
    if (upgraded) assert.ok(txt.includes('从旧版升级'), '升级用户要看到专门说明')
    else assert.ok(txt.includes('欢迎使用'), '新装用户要看到欢迎语')
  }
})

test('向导：遮罩条件只看后端 needed，源码里不许自己拼判断', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("if (st?.wizard?.needed)"), '缺全屏遮罩分支')
  assert.ok(src.includes('h(SetupWizard,'), '遮罩必须挂向导组件')
  // 遮罩分支里不能把整棵面板树一起挂回去
  // 边界取「挂向导组件」而不是判断语句的下一行：根节点的 className 会随外观注入变
  // （个性化页的 `rootClass` / `rootStyle`），用字面量定位会一改就红。
  const a = src.indexOf("if (st?.wizard?.needed)")
  const b = src.indexOf('h(SetupWizard', a)
  const block = src.slice(a, b)
  assert.ok(block.length < 500, '遮罩分支不该夹带面板正文')
  assert.ok(!block.includes('roost-head'), '向导时不该渲染页头')
  assert.ok(!block.includes('roost-scroll-body'), '向导时不该渲染正文滚动区')
})

test('接入页：可点选项有独立样式，选中态看得出（不能和状态标签同款）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const tag = 'const CSS = `'
  const a = src.indexOf(tag) + tag.length
  const css = src.slice(a, src.indexOf('`', a))

  /** `.on` 必须是全局规则：之前只在 `.roost-wizard-card` 下定义，接入页选了看不出来 */
  assert.match(css, /(^|\n)\.roost-pill\.on\{/, '缺全局 .roost-pill.on 选中态')
  assert.match(css, /\.roost-pill\.on\{[^}]*border-color:var\(--accent\)/, '选中态要用主色边框')
  assert.match(css, /\.roost-pill\.on\{[^}]*font-weight:600/, '选中态要加粗')
  /** 可点与纯状态必须能区分 */
  assert.match(css, /\.roost-pill\.as-btn\{/, '缺可点样式 .as-btn')
  assert.match(css, /\.roost-pill\.as-btn\{[^}]*cursor:pointer/, '可点要有 pointer')

  /** JSX 里三个通道选项必须带 as-btn，否则又变成看不出能点 */
  const sel = src.slice(src.indexOf("['auto', '自动"), src.indexOf("['auto', '自动") + 600)
  assert.ok(sel.includes('as-btn'), '通道选项要用 as-btn')
  assert.ok(sel.includes("' on'"), '通道选项要有选中态')
})

test('向导：CSS 垂直居中且窄栏不裁掉按钮', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const css = src.slice(src.indexOf('const CSS = `') + 'const CSS = `'.length,
    src.indexOf('`', src.indexOf('const CSS = `') + 'const CSS = `'.length))
  assert.match(css, /\.roost-wizard\{[^}]*align-items:center/, '卡片要垂直居中，否则大屏下半屏空白')
  assert.match(css, /\.roost-wizard\{[^}]*overflow:auto/, '内容超高要能滚')
  assert.ok(css.includes('@container (max-width: 420px)'), '窄侧栏要有专门规则')
  assert.ok(css.includes('.roost-wiz-chain'), '链路对比图要有样式')
})

test('向导第 2 步：装 / 启动 / 指定目录都在本页，不把人支去别的页', async () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  const render = (setup) => {
    rt.reset()
    return textOf(expand(
      h(mod.SetupWizard, {
        st: { wizard: { needed: true, upgraded: false } },
        toast: () => {}, onDone: () => {}, reload: () => {},
        initialSetup: setup, initialStep: 1,
      }), rt,
    ))
  }

  // ① 没装：只给「一键安装」，不给「一键启动」（装了才有东西可启）
  const fresh = render({ installed: false, running: false, dir: '', dirHow: '' })
  assert.ok(fresh.includes('一键安装 Roost'), '未安装时要有「一键安装」')
  assert.ok(!fresh.includes('一键启动 Roost'), '没装就不该出现「一键启动」')
  assert.ok(fresh.includes('已经装过？指定目录'), '要有绑定已有安装的入口')

  // ② 已装未跑：给「一键启动」，不再提示安装
  const stopped = render({ installed: true, version: '1.0.14', running: false, dir: 'D://bots//roost', dirHow: '自动找到', port: 15210 })
  assert.ok(stopped.includes('一键启动 Roost'), '已装未跑必须能就地启动')
  assert.ok(!stopped.includes('一键安装 Roost'), '已经装了就别再催安装')
  assert.ok(stopped.includes('D://bots//roost'), '要显示装在哪，便于确认')
  assert.ok(stopped.includes('自动找到'), '要说明目录是怎么来的')

  // ③ 在跑：不再给启动按钮，直接告诉可以下一步
  const running = render({ installed: true, version: '1.0.14', running: true, dir: 'D://bots//roost', dirHow: '自动找到', port: 15210 })
  assert.ok(running.includes('已在运行'), '在跑时要明确说一句')
  assert.ok(!running.includes('一键启动 Roost'), '在跑就不该再给启动按钮')
  assert.ok(!running.includes('一键安装 Roost'))

  // ④ 绑定目录的说明必须点明「目录里要已有 src/main.js」，否则用户会填空目录
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const a = src.indexOf('// 1 装好 Roost')
  const b = src.indexOf('// 2 一键直连', a)
  const block = src.slice(a, b)
  assert.ok(block.includes('src/main.js'), '绑定目录必须说明目录里要有 src/main.js')
  assert.ok(block.includes('/setup/install') === false, '第 2 步不该自己拼接口路径')
  assert.ok(block.includes('doInstall') && block.includes('doStart') && block.includes('doBindDir'),
    '三个动作都要挂上')
})

/* ---------------- 2.3 / 2.7：人物页、备份页、编号断层 ---------------- */

/** 两页共用的假快照：字段形状照 /memory 返回 */
const memFixture = {
  chatId: 'G1',
  profiles: [{ name: '阿岚', impression: '爱在半夜发图', tips: '别催她睡' }],
  events: [{ at: Date.now(), where: '群 G1', label: '发了张图', count: 2 }],
  graph: {
    stats: { entities: 3, edges: 2, ended: 1, episodes: 9 },
    edges: [{ id: 'e1', src: '阿岚', rel: '喜欢', dst: '猫', from: Date.now() }],
    suppressed: [], ended: [],
  },
  backups: [
    { at: Date.now(), label: '定时备份', bytes: 2048, kind: 'retention', name: 'pre-retention-a.json' },
    /** 整包备份：清单里要有「用它恢复」那一条（导入/恢复是 1.3.12 补的） */
    { at: Date.now(), label: '完整备份', bytes: 4096, kind: 'full', name: 'dsh-roost-backup-20261117-221500.zip' },
  ],
  restorePending: null,
  chats: [], scene: null,
}

const tabProps = (extra = {}) => ({
  mem: memFixture, toast: () => {}, reload: () => {},
  quick: async () => ({ ok: true }), busy: false, setTab: () => {},
  ...extra,
})
const numsOf = (node) => sectionsOf(node).filter((s) => s.n).map((s) => s.n)

test('4.1：人物页五节 01–05，人物墙 + 详情四栏 + 原三节全保留', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const tree = expand(mod.PeopleTab(tabProps()), rt)
  /** 4.1 新增人物墙（01）与详情（02），原三节顺延 03/04/05 */
  assert.deepEqual(numsOf(tree), ['01', '02', '03', '04', '05'], '人物页编号应 01–05 连续')
  const txt = textOf(tree)
  for (const must of [
    /** 01 人物墙（「搜名字」是 placeholder 属性不进 textOf，用源码断言补在下面） */
    '人物墙（1）', '全部', '7 天内', '久未联系', '不造假维度',
    /** 02 详情（未选中时的空态） */
    '点一个人，看档案', '只读',
    /** 03/04/05 原三节一块不少 */
    '熟人小档案（1）', '阿岚', '爱在半夜发图', '别催她睡',
    '她知道的关系', '3 个实体', '阿岚 —喜欢→ 猫',
    '她最近做过的事（1）', '发了张图', '去记忆页',
    '清空人物档案', '清空这些经历',
  ]) {
    assert.ok(txt.includes(must), `人物页缺少「${must}」`)
  }
  assert.ok(!txt.includes('删掉这条关系'), '关系在人物页只读，写操作留在记忆页')

  /** 搜名字输入框（placeholder 不进 textOf，查源码） */
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("placeholder: '搜名字'"), '人物墙要有搜索框')
  /**
   * 2026-11-13：独立关系图撤掉，人物/实体/关系连线全部并进「记忆」页的
   * 记忆星图。人物页只留文字清单，别再出现第二个可视化入口。
   */
  assert.ok(src.includes('function StarMap'), '记忆星图组件要在')
  assert.ok(!src.includes('function RelGraph'), '独立关系图不该再存在')
  assert.ok(src.includes('h(StarMap, {'), '记忆页要挂记忆星图')
})

test('2.3/4.3：备份页五节 01–05，导出 / 待生效 / 清单 / 不带过去的 / 定时与云备份', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const tree = expand(mod.BackupTab(tabProps()), rt)
  assert.deepEqual(numsOf(tree), ['01', '02', '03', '04', '05'], '备份页编号应 01–05 连续')
  const txt = textOf(tree)
  for (const must of [
    '导出备份（zip）', 'config.json', '导入备份（zip）', '重启 DSH 才换上',
    '没有待生效的恢复', '定时备份', '还原这一份', '用它恢复',
    '不会带过去的', 'secrets/', '扩展长期令牌明文', 'zip 炸弹',
    /** 4.3/4.4 第五节 */
    '每天自动备份', '留最近几份', '立即备份并推送', '口令没配就拒推', 'Gitee',
  ]) {
    assert.ok(txt.includes(must), `备份页缺少「${must}」`)
  }
})

test('2.3：人物 / 备份两页没数据时给加载占位和重试，不炸', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  for (const [label, Comp, word] of [
    ['人物', mod.PeopleTab, '读取人物数据'],
    ['备份', mod.BackupTab, '读取备份状态'],
  ]) {
    const txt = textOf(expand(Comp(tabProps({ mem: null })), rt))
    assert.ok(txt.includes(word), `${label}页缺加载占位`)
    assert.ok(txt.includes('重试'), `${label}页缺重试入口`)
    assert.ok(txt.includes('排障'), `${label}页要指明去哪查错`)
  }
})

test('2.7：记忆页三块内容仍在同一个折叠入口里，编号 01–07 连续', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const tree = expand(mod.MemoryTab(tabProps({ onPickChat: () => {} })), rt)
  /** 3.3/3.4 新增 05 召回预览与参数，原 05/06 顺延为 06/07 */
  assert.deepEqual(numsOf(tree), ['01', '02', '03', '04', '05', '06', '07'], '记忆页编号不该再断')
  const txt = textOf(tree)
  for (const must of [
    '仍保留原样', '去人物页', '去备份页',
    '熟人小档案', '她最近做过的事', '备份与恢复',
    '清空人物档案', '清空这些经历', '导出备份（zip）',
  ]) {
    assert.ok(txt.includes(must), `记忆页折叠后少了「${must}」`)
  }
  /** 三块要一起收进同一个 details，只折一块等于没修编号断层 */
  let wrapped = false
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'details') {
      const t = textOf(n)
      if (t.includes('熟人小档案') && t.includes('她最近做过的事') && t.includes('备份与恢复')) wrapped = true
    }
    walk(n.props?.children)
  })(tree)
  assert.ok(wrapped, '三块要一起收进同一个 details')
})

test('2.7：排障页只剩一组编号，context 隐藏页仍保留 01–05', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'logs'
  rt.reset()
  const logs = expand(mod.RoostPage(), rt)
  assert.deepEqual(numsOf(logs), ['01'], '排障页不该出现两组 01')
  assert.ok(textOf(logs).includes('窗口占用'), '上下文分区的内容仍要在')

  store['roost.tab'] = 'context'
  rt.reset()
  const ctx = expand(mod.RoostPage(), rt)
  assert.deepEqual(numsOf(ctx), ['01', '02', '03', '04', '05'], '隐藏页单独进入时编号照旧')
})

/* ---------------- 2.8 授权名单 / 2.6 双入口 ---------------- */

test('2.8：名单预演四类统计各归各位，老条目的启用状态不被冲掉', () => {
  const mod = loadClient(makeReact().React)
  const r = mod.planGroupWhitelist(
    ['GROUP_A 测试群', 'GROUP_A', 'OWNER_C2C', 'GROUP_B', '不是 id', '', 'GROUP_C 名字带空格 也行'].join('\n'),
    {
      groups: [{ chatId: 'GROUP_B', name: '老群', enabled: false }],
      chats: [{ chatId: 'OWNER_C2C', kind: 'c2c' }],
    },
  )
  assert.deepEqual(r.stats, { added: 2, duplicate: 2, skippedOwner: 1, invalid: 1 })
  assert.deepEqual(r.items.map((x) => x.chatId), ['GROUP_A', 'GROUP_C'])
  assert.equal(r.items[1].name, '名字带空格 也行', '备注名允许空格')
  assert.equal(r.next.length, 3, 'next 是合并后的整份名单（老 1 + 新 2）')
  assert.equal(r.next.find((x) => x.chatId === 'GROUP_B').enabled, false)
  assert.ok(r.notes.some((n) => n.includes('主人与群组')), '跳过原因要说清归谁管')
})

test('2.8：混排分隔符、格式错与空输入都不炸', () => {
  const mod = loadClient(makeReact().React)
  const a = mod.planGroupWhitelist('  GROUP_A , GROUP_B；GROUP_C; GROUP_D  ')
  assert.equal(a.stats.added, 4)
  assert.equal(a.stats.invalid, 0)
  const b = mod.planGroupWhitelist(['https://example.com/x', '<@12345>', 'a'.repeat(200), 'GROUP_OK'].join('\n'))
  assert.equal(b.stats.invalid, 3, 'URL / @ / 超长串都要挡掉')
  assert.equal(b.stats.added, 1)
  assert.deepEqual(mod.planGroupWhitelist(null, { groups: null, chats: null }).next, [])
})

test('2.8：从最近会话导入只带群、不带私聊和名单里已有的', () => {
  const mod = loadClient(makeReact().React)
  const chats = [
    { chatId: 'G1', kind: 'group', title: '一群' },
    { chatId: 'P1', kind: 'c2c', title: '主人' },
    { chatId: 'G2', kind: 'group', title: '二 群' },
  ]
  assert.deepEqual(mod.suggestGroupWhitelist(chats, [{ chatId: 'G1' }]), ['G2 二 群'])
  assert.deepEqual(mod.suggestGroupWhitelist(null, null), [])
})

test('2.8：权限页多出 07 授权名单，主人只读、群名单可批量添加', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const props = {
    caps: { tools: [] }, preview: null, chats: [{ chatId: 'G1', kind: 'group', title: '一群' }],
    feat: null, retention: null, quota: null,
    toast: () => {}, reload: () => {}, quick: async () => ({ ok: true }), busy: false,
    config: { awake: { groups: [] } }, saveCfg: async () => ({ ok: true }),
    setupSt: { ownersConfigured: true, ownerCount: 1, bots: [{ id: 'b1', name: '小鸟', ownerCount: 1, appId: 'x' }] },
    setTab: () => {},
  }
  let tree
  assert.doesNotThrow(() => { tree = expand(mod.CapsTab(props), rt) }, '权限页带名单数据时不能炸')
  assert.ok(numsOf(tree).includes('07'), '权限页要有 07 授权名单')
  const txt = textOf(tree)
  for (const must of [
    '授权名单', '主人 / 私聊对象（框架管）', '框架里已设 1 个主人',
    '去接入页第 6 步', '群白名单（0）', '从最近会话导入',
    '新增 0 · 重复 0 · 跳过主人/私聊 0 · 格式错 0',
    '名单是空的', 'group_push',
  ]) {
    assert.ok(txt.includes(must), `权限页名单节缺少「${must}」`)
  }
  assert.ok(txt.includes('config/bots/<id>.json'), '要说清主人名单存在框架侧，不是本页配置')
})

test('2.6：概览会话表收进 details，搜索 / 筛选 / 排序 / 分类一个不少', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'overview'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)
  let box = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'details' && textOf(n).includes('折叠 / 展开整张表')) box = n
    walk(n.props?.children)
  })(tree)
  assert.ok(box, '会话表要有一层 details 折叠')
  /** placeholder 是 prop 不是 children，textOf 收不到，按节点找 */
  const found = new Set()
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    const cls = String(n.props?.className || '')
    if (String(n.props?.placeholder || '').includes('搜名称')) found.add('搜索框')
    if (cls.includes('ov-cover')) found.add('时间范围')
    if (cls.includes('ov-gran')) found.add('排序')
    if (cls.includes('ov-groups')) found.add('群/私聊分类')
    if (cls.includes('ov-sessions')) found.add('会话表')
    walk(n.props?.children)
  })(box)
  for (const k of ['搜索框', '时间范围', '排序', '群/私聊分类', '会话表']) {
    assert.ok(found.has(k), `折叠后少了「${k}」`)
  }
  const t = textOf(box)
  for (const must of ['全部时间', '最近更新', 'Token 用量', '全部']) {
    assert.ok(t.includes(must), `折叠后少了「${must}」`)
  }
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('ov-pager'), '分页控件不许被压成一行摘要')
})

test('2.6：排障页是正门，context 老链接仍可用，两颗打开面板按钮各标用途', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const at = (t) => { store['roost.tab'] = t; rt.reset(); return textOf(expand(mod.RoostPage(), rt)) }
  const logs = at('logs')
  assert.ok(logs.includes('这一页是查问题的正门'), '排障页没写明自己是正门')
  assert.ok(logs.includes('?tab=context'), '排障页要提到老链接仍在')
  const ctx = at('context')
  assert.ok(ctx.includes('老链接 ?tab=context 的落脚点'), 'context 页没说清自己是老链接')
  assert.ok(ctx.includes('去「排障」页'), 'context 页要指回正门')

  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('打开面板看启动状态'), '第 2 步那颗要写清是看启动')
  assert.ok(src.includes('打开「主人与群组」'), '第 6 步那颗要写清直达主人名单')
})


test('4.5：人格页把「旧记忆归谁」做成三个可选项，代码不代选', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const tree = expand(h(mod.HerTab, {
    config: { persona: { current: 'default' } },
    personas: {
      ok: true, current: 'default', byChat: {}, usage: {},
      personas: [{ id: 'default', label: '大肥鱼', tags: [], chars: 10 }],
    },
    mem: { chatId: 'g1', personaOverride: '' },
    toast: () => {}, save: async () => ({ ok: true }), reload: async () => {}, quick: null,
  }), rt)
  const txt = textOf(tree)
  for (const must of [
    '人格隔离', '开启人格隔离（默认关）', '保存选择',
    'A 共享', 'B 归某一个人格', 'C 逐会话指定',
    '只写归属标记', '不搬动旧数据',
  ]) {
    assert.ok(txt.includes(must), `人格页缺「${must}」`)
  }
  /** 三个策略必须是 radio，且没有一个被默认选中（选择权交回使用者） */
  const radios = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'input' && n.props?.type === 'radio') radios.push(n.props)
    walk(n.props?.children)
  })(tree)
  assert.equal(radios.length, 3, `应有三个策略单选项，实际 ${radios.length}`)
  assert.deepEqual(radios.map((r) => r.value), ['shared', 'owner', 'perChat'])
  assert.equal(radios.some((r) => r.checked), false, '不能替使用者预选一个')

  /**
   * 面板文案不许出现内部记号：路线图的批次号（4.5）、官方字段名
   * （is_wakeup）、store 物理键（::p:）。截图里「人格隔离（4.5）」就是
   * 照着内部任务号写进 UI 的，用户看不懂也不该看到。
   */
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(!/title: '[^']*（\d+\.\d+）/.test(src), '面板标题带了路线图批次编号')
  assert.ok(!/title: '[^']*is_wakeup/.test(src), '面板标题带了官方字段名')
  assert.ok(!/title: '[^']*::p:/.test(src), '面板标题带了内部物理键记号')

  /** 保存按钮：次要按钮、独占一行，旁边不能再拖一长串重复说明 */
  let saveBtn = null
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (n.type === 'button' && textOf(n) === '保存选择') saveBtn = n
    walk(n.props?.children)
  })(tree)
  assert.ok(saveBtn, '缺保存选择按钮')
  assert.equal(saveBtn.props.className, 'roost-btn', '配置卡里用次要按钮，别放一块黑色主按钮')
  assert.ok(!txt.includes('专属键里的内容仍在盘上不丢。只写归属标记'), '说明文字重复了两遍')
})


test('5.1 Alt+K 全局查找：页名与中文别名都能搜到', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  const TABS = [['overview', '概览'], ['memory', '记忆'], ['groupadmin', '群管'], ['context', '上下文']]
  const GROUPS = [{ id: 'self', label: '人设', tabs: ['memory'] }, { id: 'sys', label: '系统', tabs: ['groupadmin'] }]

  const byAlias = mod.matchTabs('日记', TABS, GROUPS)
  assert.deepEqual(byAlias.map((x) => x.id), ['memory'], '搜「日记」要能找到记忆页');
  assert.equal(byAlias[0].group, '人设');

  const byLabel = mod.matchTabs('群管', TABS, GROUPS)
  assert.deepEqual(byLabel.map((x) => x.id), ['groupadmin']);

  const all = mod.matchTabs('', TABS, GROUPS)
  assert.equal(all.length, TABS.length, '空查询给全部');
  assert.equal(all.find((x) => x.id === 'context').group, '', '隐藏页没有分组');

  assert.deepEqual(mod.matchTabs('不存在的东西', TABS, GROUPS), []);

  /** 快捷键与面板都在 */
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("e.altKey && (e.key === 'k' || e.key === 'K')"), '要监听 Alt+K');
  assert.ok(src.includes("e.key === 'Escape'"), 'Esc 要能关');
  assert.ok(src.includes("e.key === 'Enter'"), '回车要能跳');
  assert.ok(src.includes('搜页面：页名或别名'), '要有查找面板');
  void h
})

/**
 * A8（第三轮报告）：扩展页也要进 Alt+K。
 *
 * 以前候选源是 `ALL_TABS`（只有内置页），扩展页 `ext:<id>` 根本不在里面；
 * 就算被传进来，组标签原来靠 `GROUPS.find(g => g.tabs.includes(id))` 求，
 * 扩展页不在任何组的 `tabs` 里 → 组名是空串，搜索结果看着像没挂到任何组。
 */
test('A8：扩展页进 Alt+K，组标签取它自己声明的 nav.group', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  /** 用老写法 `group`：它已并入「群与频道」，别名归一在这里也要生效 */
  const extPages = [{ id: 'bili', nav: { label: '刷 B 站', group: 'group' } }]

  const all = mod.matchTabs('', [['ext:bili', '刷 B 站']], [], extPages)
  assert.equal(all.length, 1, '扩展页要出现在候选里')
  assert.equal(all[0].group, '群与频道', '老 group 要归一到合并后的组名')

  const byWord = mod.matchTabs('刷', [['ext:bili', '刷 B 站']], [], extPages)
  assert.deepEqual(byWord.map((x) => x.id), ['ext:bili'], '按页名要能搜到扩展页')
})

/** 搜组名要列出该组所有页：记不住「群管」在哪，至少记得「群与频道」 */
test('A8：Alt+K 支持按一级组名搜，列出组内全部页', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const tabs = [['groupchat', '群聊策略'], ['groupadmin', '群管'], ['ch-home', '频道总览'], ['memory', '记忆']]
  const list = mod.matchTabs('群与频道', tabs, [], null)
  assert.deepEqual(list.map((x) => x.id), ['groupchat', 'groupadmin', 'ch-home'],
    '搜「群与频道」应列出该组三页（「记忆」在别的组）')
  assert.equal(list[0].group, '群与频道')
})

/**
 * A7（第三轮报告）：群聊并入「群与频道」，一级组 8 → 7。
 *
 * 直接盯源码而不是渲染结果：组多一个少一个，渲染仍然「每页都点得到」，
 * 肉眼看不出来，只有把结构钉死才拦得住。
 */
test('A7：一级组群聊并入「群与频道」，且老 id 留了别名', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /[{] id: 'channel', label: '群与频道'/, '一级组名要改')
  assert.doesNotMatch(src, /[{] id: 'group', label: '群聊'/, '群聊组应已并入，不该还在')
  assert.match(src, /tabs: \['groupchat', 'groupadmin', 'ch-home', 'ch-policy', 'ch-api', 'ch-diag'\]/,
    '频道组只留渠道相关：群聊 / 群管 / 频道总览 / 频道策略 / 接口台 / 排障')
  /**
   * 发帖 2026-11-17 移到「表达」：它是她的表达出口（代替 QQ 空间），不是频道运维。
   * 混在频道组里会让人以为「得先搞懂频道才能用」。
   */
  assert.match(src, /tabs: \['express', 'stickers', 'ch-post'\]/,
    '发帖要归「表达」（语音 / 表情包 / 发帖 都是"她怎么出声"）')
  assert.match(src, /const GROUP_ALIAS = [{] group: 'channel' [}]/,
    '老组 id 必须留别名——已发布扩展的 ui.nav.group 还写着 group，删了页面会从导航里消失')
})


test('发帖页：没有数据也不白屏，六张卡都在', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  /**
   * 不传 st / diag（`useEffect` 在 Node 里不跑），模拟"刚打开面板、还没拉到数据"。
   * 这一层专抓空数据崩溃：新装用户所有状态都是 null，少写一个 `?.` 就白屏。
   */
  const txt = textOf(expand(h(mod.ChannelPostTab, { chats: [], toast: () => {} }), rt))
  for (const must of [
    '频道发帖', '正在体检',
    '总开关与排期', '写什么', '发到哪', '现在发一篇', '发过什么', '交给她自己发',
    '先看草稿', '重新体检',
  ]) {
    assert.ok(txt.includes(must), `发帖页缺「${must}」`)
  }
  /** 没有频道会话时不能露出一堆空下拉，要告诉用户下一步做什么 */
  /** 拉不到频道列表时要说清下一步（不是丢一个空下拉在那儿） */
  assert.ok(txt.includes('拉不到频道列表'), '缺「确认机器人已被拉进频道」的提示')
})

test('频道总览：加机器人排最前；两张新卡不能用别的页面的变量（会 ReferenceError）', () => {
  /**
   * 踩过：`me` / `qr` 的 state 加在总览页，但 05/06 两张卡被插进了 `ChannelPolicyTab`，
   * 打开策略页直接 `ReferenceError: me is not defined`；总览页也只剩 4 张卡。
   * 这条同时锁住「卡在总览页」和「顺序：加机器人在最前」。
   */
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const txt = textOf(expand(h(mod.ChannelHomeTab, {
    config: { guild: { enabled: true } },
    saveCfg: async () => ({ ok: true }),
    toast: () => {},
    chats: [],
    setTab: () => {},
  }), rt))

  const iAdd = txt.indexOf('把机器人加进频道')
  const iSwitch = txt.indexOf('总开关与粒度')
  const iMe = txt.indexOf('我在频道里是谁')
  assert.ok(iAdd >= 0, '总览页要有「把机器人加进频道」')
  assert.ok(iSwitch >= 0, '总开关那张卡还在')
  assert.ok(iMe >= 0, '「我在频道里是谁」也要在总览页')
  assert.ok(iAdd < iSwitch, '加机器人要排在总开关前面，否则用户注意不到')

  /** 策略页不该再引用总览页的 state */
  rt.reset()
  const policy = textOf(expand(h(mod.ChannelPolicyTab, {
    config: { guild: {}, roostHost: {} },
    saveCfg: async () => ({ ok: true }),
    saveAll: async () => ({ ok: true }),
    toast: () => {},
    chats: [],
    setTab: () => {},
  }), rt))
  assert.ok(policy.length > 0, '策略页要能渲染（渲染期间抛错会被这里捕获）')
})

test('发帖页：体检区能就地选频道、也有常用动作按钮（不用滚到下面的卡）', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const txt = textOf(expand(h(mod.ChannelPostTab, {
    chats: [],
    toast: () => {},
    setTab: () => {},
    seed: {
      diag: {
        ok: true, blocked: false, ready: false, verified: false, pending: 1,
        steps: [
          { id: 'guild', state: 'ok', detail: '总开关已打开' },
          { id: 'perm', state: 'ok', detail: '有论坛权限' },
          { id: 'channel', state: 'todo', detail: '还没选频道：在下面 03 卡里选一个' },
          { id: 'sent', state: 'info', detail: '还没真发过' },
        ],
      },
      st: { cfg: {}, history: [], plan: { times: [] }, today: 0, lastError: null },
      guilds: [{ id: '123456789', name: '我的频道' }],
      subs: [],
    },
  }), rt))

  /** 就地选频道：这一行直接给下拉，不必滚到 03 卡 */
  assert.ok(txt.includes('选频道'), '体检区要有就地的频道下拉')
  /** 常用动作也在这一区 */
  for (const must of ['先看草稿', '现在发一篇', '重新体检']) {
    assert.ok(txt.includes(must), `体检区缺快捷入口「${must}」`)
  }
})

test('发帖页：顶部有一键打开「加机器人」的链接（没加频道就什么都做不了）', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const txt = textOf(expand(h(mod.ChannelPostTab, {
    chats: [],
    toast: () => {},
    setTab: () => {},
    seed: {
      share: { ok: true, appid: '102056878', url: 'https://qun.qq.com/qunpro/robot/share?robot_appid=102056878' },
      st: { cfg: {}, history: [], plan: { times: [] }, today: 0, lastError: null },
      diag: null,
    },
  }), rt))
  assert.ok(txt.includes('还没把机器人加进频道'), '要有一句直白的入口提示')
  assert.ok(txt.includes('打开链接'), '要能一键打开（浏览器里腾讯会给二维码）')
})

test('发帖页：频道候选只取 guild_id 那一段，并按频道去重', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  /**
   * 会话可能是子频道粒度（`guild:<guildId>:ch:<channelId>`）。整串当 guildId
   * 存进去会被 normalize 的纯数字校验清空，用户的表现是「选了频道，保存完又变回未选」。
   */
  const out = mod.guildChoicesOf([
    { kind: 'guild', chatId: 'guild:123456789', title: '闲聊' },
    { kind: 'guild', chatId: 'guild:123456789:ch:998877', title: '另一个子频道' },
    { kind: 'guild', chatId: 'guild:555000111:ch:222333', title: '公告' },
    { kind: 'group', chatId: 'group:abc', title: '群' },
    { kind: 'dm', chatId: 'guild:777', title: '私信' },
    { kind: 'guild', chatId: 'guild:坏掉的' },
  ])
  assert.deepEqual(out, [
    { id: '123456789', title: '闲聊' },
    { id: '555000111', title: '公告' },
  ], '同频道的多个子频道要合成一条，非数字 id 要丢掉')
})

test('发帖页：频道 / 子频道两个下拉要真的列出东西，非论坛类型标出来', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const txt = textOf(expand(h(mod.ChannelPostTab, {
    chats: [],
    toast: () => {},
    setTab: () => {},
    seed: {
      st: { cfg: { guildId: '123456789' }, history: [], plan: { times: [] }, today: 0, lastError: null },
      diag: null,
      guilds: [{ id: '123456789', name: '我的频道' }],
      subs: [
        { id: '900', name: '综合讨论', type: 0, isForum: false },
        { id: '901', name: '日记本', type: 10007, isForum: true },
      ],
    },
  }), rt))

  /**
   * 主人反馈过：「发在哪个频道、哪个子频道怎么都没有选项」。
   * 以前只列论坛版块，非论坛的子频道一个都不显示，看起来就像"我的子频道没被认出来"。
   */
  assert.ok(txt.includes('我的频道'), '频道下拉要有频道名')
  assert.ok(txt.includes('综合讨论'), '非论坛子频道也要列出来')
  assert.ok(txt.includes('发不了'), '要标注为什么选不了')
  assert.ok(txt.includes('日记本'), '论坛子频道要在列表里')
  assert.ok(txt.includes('可以发'), '论坛子频道要标出可用')
})

test('发帖页：体检没过时，界面上直接写清「点哪里」（不靠 hover）', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const diag = {
    ok: true, blocked: true, ready: false, pending: 3,
    steps: [
      { id: 'guild', state: 'todo', jump: 'ch-home', detail: '频道总开关还关着：去「频道总览」的 01 卡「总开关与粒度」，把「启用频道」打开' },
      { id: 'perm', state: 'fail', detail: '这个机器人还没拿到「论坛」权限', todo: ['去开放平台勾上论坛', '把机器人移出频道再重新添加', '回来点「重新体检」'] },
      { id: 'channel', state: 'todo', detail: '还没选版块：在下面 03 卡「发到哪」里选一个' },
      { id: 'sent', state: 'todo', detail: '还没真发过：去 04 卡点「现在真发一篇」' },
    ],
  }
  const txt = textOf(expand(h(mod.ChannelPostTab, {
    chats: [],
    toast: () => {},
    setTab: () => {},
    seed: { diag, st: { cfg: {}, history: [], plan: { times: [] }, today: 0, lastError: null }, chans: [] },
  }), rt))

  /**
   * 上一版四盏灯只有名字，具体点哪儿全在 `title` 里——手机点不出来等于没有。
   * 这几条锁住「指引必须印在界面上」。
   */
  for (const must of [
    '接下来做什么',
    '总开关与粒度', '启用频道', '去打开',
    '把机器人移出频道再重新添加',
    '03 卡', '04 卡',
  ]) {
    assert.ok(txt.includes(must), `体检指引缺「${must}」`)
  }
})

test('5.2 排障页：级别 / 模块筛选与自动刷新开关', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  const logs = [
    { time: '10:00:00', level: 'error', area: 'update', text: '更新炸了' },
    { time: '10:00:01', level: 'info', area: 'turn', text: '正常一轮' },
  ]
  rt.reset()
  const txt = textOf(expand(h(mod.LogsTab, {
    logs, auto: true, onToggleAuto: () => {}, onReload: () => {},
  }), rt))
  for (const must of ['全部级别', '调试', '信息', '警告', '错误', '全部模块', '自动刷新', '刷新',
    '显示 2 / 2 条', '[update]', '[turn]']) {
    assert.ok(txt.includes(must), `排障页缺「${must}」`)
  }

  /** 关掉自动刷新要有明确提示，不能让人以为还在刷 */
  rt.reset()
  const off = textOf(expand(h(mod.LogsTab, {
    logs, auto: false, onToggleAuto: () => {}, onReload: () => {},
  }), rt))
  assert.ok(off.includes('自动刷新已关'), '关掉后要说明');

  /** 空日志与「筛选后为空」要区分 */
  rt.reset()
  const empty = textOf(expand(h(mod.LogsTab, { logs: [], auto: true }), rt))
  assert.ok(empty.includes('还没有日志'));

  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("localStorage.setItem('roost.logs.auto'"), '开关要记住');
  assert.ok(src.includes('if (!logAuto) return'), '关掉就不轮询');
})

test('更新页：有「更新历史」入口，不只在版本变时弹一次', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const h = rt.React.createElement
  rt.reset()
  const txt = textOf(expand(h(mod.UpdateTab, { toast: () => {} }), rt))
  assert.ok(txt.includes('更新历史'), '要有一个能往回翻的入口')
  assert.ok(txt.includes('交流反馈群'), '反馈群那张卡还在')
})

/**
 * 页头清理（2026-11-18）：删掉 `:17321` 端口徽章与「通道 roost」徽章。
 *
 * 两个都是死信息：概览页早已改成看外接协议连接状态（连没连上、seq 走没走），
 * 而「通道」只剩一种实现，恒定值等于零信息。
 */
test('前端渲染：页头不再出现端口号与「通道」徽章', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'overview'
  rt.reset()
  const tree = expand(mod.RoostPage(), rt)

  const head = tree.props.children
    .find((n) => ((n && n.props && n.props.className) || '').includes('roost-head'))
  assert.ok(head, '缺页头')

  const texts = []
  ;(function walk(n) {
    if (n == null) return
    if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
    if (Array.isArray(n)) return n.forEach(walk)
    walk(n.props?.children)
  })(head)

  const joined = texts.join(' | ')
  assert.doesNotMatch(joined, /:17321/, '端口徽章该删掉')
  assert.doesNotMatch(joined, /端口没起/, '「端口没起」跟着端口徽章一起删')
  assert.doesNotMatch(joined, /通道\s*roost/, '「通道」是恒定值，删')
  assert.doesNotMatch(joined, /^通道 /, '「通道」是恒定值，删')
});

/**
 * 页头两个开关接的是**现成**的「能力」页接口，不新开 API。
 * 这条是源码级检查：渲染替身不跑 `useEffect`，开关本体渲染不出来，
 * 但「有没有真的接上」必须能被反过来验证（否则删了接线测试还是绿的）。
 */
test('页头开关：走 features.get / features.patch，id 与后端注册的一致', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /quick\('features\.get'\)/, '初值要来自 features.get')
  assert.match(src, /quick\('features\.patch'/, '点击要走 features.patch')
  assert.match(src, /'botEnabled'/, '总开关的 id 是 botEnabled（避开顶层 enabled 撞名）')
  assert.match(src, /'dryRun'/, '试运行的 id 是 dryRun')
});

test('前端渲染：图库页有「批量选择」入口，不再靠缩略图上的小复选框', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'stickers'
  rt.reset()

  const txt = textOf(expand(mod.RoostPage(), rt))
  /**
   * 多选原来是每张图左下角一个 14px 的复选框——缩略图才 140px 宽，
   * 手机上基本点不中。改成显式的「批量选择」开关：打开后整张卡片可点。
   * 这条只保证入口在；选中态的交互靠真机。
   */
  assert.ok(txt.includes('批量选择'), '多选入口要能看见')
  assert.ok(!txt.includes('全选本页'), '「全选本页」搬进批量条了，不在筛选行常驻')
  assert.ok(txt.includes('图库'), '导航上要叫「图库」')
})

/**
 * 对齐 aurabot 表情包页的那几处入口。
 *
 * 只断言「入口在、文案对」：下拉的候选要等 `model.list` 回来（真机才有），
 * 这里渲染的是首帧，看到的是「跟随聊天模型」那一项 + 「正在查模型…」。
 */
test('前端渲染：图库页有「起名用的模型」下拉、上传命名框、刷新', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'stickers'
  rt.reset()

  const txt = textOf(expand(mod.RoostPage(), rt))
  /** 工具条不依赖图库数据，首帧就能看到 */
  assert.ok(txt.includes('刷新'), '往文件夹里丢图之后要有地方重新读')
  assert.ok(txt.includes('上传'), '上传入口')

  /**
   * 模型下拉要等 `/gallery` 回来才渲染（首帧整块是「读着…」），所以这几条
   * 断言源码：文案、默认项、以及它存到哪个配置键。
   */
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(src, /起名用的模型/, '要能单独挑一个视觉模型')
  assert.match(src, /跟随聊天模型/, '留空 = 跟随聊天模型，得写出来')
  assert.match(src, /captionModel: \{ provider: v \? p : ''/, '要存回 stickers.captionModel')
  assert.match(src, /placeholder: '名字（可不填）'/, '上传时可以先填名字')
})

/**
 * 偷表情 / 贴表情两块。
 *
 * 它们只在「图库」独立页出现（`part === 'sticker'`），而且都依赖 `config`
 * 里的 `stickers.steal` / `stickers.post`——所以断言分两路：
 * 首帧能看到文案的断文案，要等 `/stickers` 的数据断源码。
 *
 * 小黄脸码表页**已下线**（出站不再发小黄脸），所以这里反过来钉住它不回来。
 */
test('前端渲染：偷表情、贴表情入口都在，小黄脸码表页不再出现', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  store['roost.tab'] = 'stickers'
  rt.reset()

  const txt = textOf(expand(mod.RoostPage(), rt))
  assert.ok(txt.includes('偷表情'), '偷表情的开关要能看见')
  assert.ok(txt.includes('同步缓存图'), '手动同步的入口不能因为有了自动偷就被挤掉')
  assert.ok(txt.includes('贴表情'), '贴表情的开关要能看见')

  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  /** 三个数字都要能改：只给开关不给参数，等于逼用户去手改 config.json */
  assert.match(src, /post: \{ maxPerDay: n \}/, '每天几次要能存')
  assert.match(src, /post: \{ chance: n \/ 100 \}/, '概率用百分比输入、存成 0~1')
  assert.match(src, /post: \{ minGapMinutes: n \}/, '间隔要能存')
  /** 偷表情的三项 */
  assert.match(src, /steal: \{ maxPerHour: n \}/, '每小时上限要能存')
  assert.match(src, /steal: \{ autoOrganize: on \}/, '顺手起名的勾选要能存')
  /** 码表页不能回来：留着只会引导用户复制一个发不出去的标记 */
  assert.doesNotMatch(src, /FaceMap/, '码表页已下线，别留入口')
})

test('功能包页：ONNX 有独立安装区块，不再误跳语音页；开关能存', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  /** ONNX 三套各自的安装/取消/卸载 op 都接上了 */
  for (const op of [
    'onnx.install', 'onnx.cancel', 'onnx.uninstall',
    'onnx.modelInstall', 'onnx.modelCancel', 'onnx.modelUninstall',
    'onnx.rerankInstall', 'onnx.rerankCancel', 'onnx.rerankUninstall',
  ]) {
    assert.ok(src.includes(`'${op}'`), `ONNX 区块缺了 ${op}`)
  }
  /** 独立区块 + 从语音只读列表里滤掉 ONNX（否则每行都挂"去语音页"） */
  assert.match(src, /title: '本地智能/, 'ONNX 该有自己的区块标题')
  assert.match(src, /\.filter\(\(r\) => !String\(r\.id \|\| ''\)\.startsWith\('onnx'\)\)/, 'ONNX 不该混进语音运行时列表')
  /** load() 把 onnx.status 并进来；轮询兼容三套安装器 */
  assert.match(src, /quick\('onnx\.status'\)/, '功能包页要读 onnx 状态')
  assert.match(src, /ox\.model\?\.install\?\.running/, 'embedding 安装中也要轮询')
  assert.match(src, /ox\.rerankModel\?\.install\?\.running/, 'rerank 安装中也要轮询')
  /** 装完能开：两个开关都要能存进配置 */
  assert.match(src, /embeddingLocal: on/, '本地向量开关要能存')
  assert.match(src, /useLocal: on/, '本地重排开关要能存')
})

test('记忆页：证据趋势/条数/出处明细可见（阶段1 算出的不能只躺在数据里）', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  /** 事实列表行：非默认趋势要标出来，多条证据要显条数 */
  assert.match(src, /const TREND_LABEL = \{ strengthening:/, '趋势档位标签要在事实列表可见')
  assert.match(src, /`\$\{evCount\} 条佐证`/, '多条证据要显条数')
  /** 星图详情：带上趋势/证据/信念字段，并能展开看出处（原文 id + 引文） */
  assert.match(src, /trend: String\(f\.trend \|\| ''\)/, '星点要带趋势字段')
  assert.match(src, /看证据（\$\{detail\.evidence\.length\}）/, '星点详情要有看证据按钮')
  assert.match(src, /原文 \$\{ev\.journalId\}/, '证据要能回查原文 id')
  assert.match(src, /ev\.quote/, '证据要显示引文')
})

test('视觉升级：卡片只给数据页，配置页保留分节标题 + 上边线', () => {
  const rt = makeReact()
  const mod = loadClient(rt.React)
  const findInner = (n) => {
    if (n == null || typeof n !== 'object') return null
    if (Array.isArray(n)) {
      for (const c of n) { const r = findInner(c); if (r) return r }
      return null
    }
    if (String(n.props?.className || '').split(/\s+/).includes('roost-body-inner')) return n
    return findInner(n.props?.children)
  }
  const clsOf = (tab) => {
    store['roost.tab'] = tab
    rt.reset()
    const inner = findInner(expand(mod.RoostPage(), rt))
    assert.ok(inner, `${tab} 页缺少正文容器`)
    return String(inner.props.className || '')
  }
  for (const tab of ['overview', 'memory', 'people']) {
    assert.match(clsOf(tab), /is-data-view/, `${tab} 是数据展示页，应该拿到卡片样式`)
  }
  for (const tab of ['config', 'groupchat', 'security', 'ext']) {
    assert.ok(!clsOf(tab).includes('is-data-view'), `${tab} 是配置页，不该推翻 2026-11-13 的「不要卡片背景」`)
  }
})

test('视觉升级：竖线与卡片底只走自选强调色，不落对方配色', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const from = src.indexOf('/* ── 全局视觉升级')
  const to = src.indexOf('@media (prefers-reduced-motion:reduce){', from)
  assert.ok(from > 0 && to > from, '视觉升级样式块应该还在')
  const visual = src.slice(from, to)
  assert.ok(!visual.includes('#3d7fd6') && !visual.includes('--ab-'), '新样式不该引用 aurabot 的蓝色或变量')
  assert.ok(src.includes('background:linear-gradient(180deg,var(--tone-foam-2),var(--accent))'),
    '标题竖线两端都要来自 --accent，不能掺白色或固定色')
  assert.ok(src.includes('background:color-mix(in srgb,var(--accent) 4%,var(--dsw-alias-bg-l1,'),
    '卡片底要在宿主主题底色上混入自选强调色，不能写死')
  assert.ok(src.includes('--tone-foam-2:color-mix(in srgb,var(--accent) 20%,transparent)'),
    '淡色令牌必须从 --accent 派生')
})
