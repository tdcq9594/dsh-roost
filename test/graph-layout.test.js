// 记忆星图（2026-11-13 替换掉独立关系图）的纯函数测试。
//
// 星图里最容易"看代码看不出来"的三件事：3D 透视投影对不对、2D/3D 是不是
// 同一批星、亮度是不是真按权重算。全抽成纯函数，不起浏览器就能断言。
// 画布本身用无头 Chrome 另看一眼成图（不进测试）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function makeReact() {
  const hooks = []
  let i = 0
  return {
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

function loadClient() {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod = null
  const win = { __ModuleLoader__: { load: (cfg) => { mod = cfg.factory((n) => (n === 'react' ? makeReact().React : {})) } } }
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return mod
}

const mod = loadClient()
const NOW = Date.UTC(2026, 10, 13)
const DAY = 86_400_000

/** 一份形状与 /memory 快照一致的夹具 */
function sampleMem() {
  return {
    chatId: 'abcdef0123456789abcdef0123456789',
    factsDetail: {
      global: [
        { text: '主人住在杭州', w: 3, at: NOW - DAY, src: { manual: true } },
        { text: '主人怕花生', w: 1, at: NOW - 40 * DAY },
        { text: '旧说法：主人住上海', w: 2, at: NOW - 300 * DAY, until: NOW - 200 * DAY },
      ],
      chat: [{ text: '这个群爱发猫图', w: 2, at: NOW - 2 * DAY }],
    },
    journal: {
      top: [{ id: 'j1', text: '昨天一起看了雪', score: 0.9, at: NOW - DAY, accessed: 4 }],
    },
    graph: {
      entities: [
        { name: '大肥鱼', lastSeen: NOW - DAY },
        { name: '猫', lastSeen: NOW - 3 * DAY },
        { name: '竹子', lastSeen: NOW - 10 * DAY },
      ],
      edges: [
        { src: '大肥鱼', dst: '猫', rel: '喜欢' },
        { src: '猫', dst: '不存在的人', rel: '认识' },
      ],
    },
    profiles: [{ name: '阿岚', impression: '爱在半夜发图', at: NOW - DAY }],
  }
}

test('亮度公式：权重 × 40 天半衰期，被取代的打折，重要片段用现成分数', () => {
  const fresh = mod.starScoreOf({ w: 2, at: NOW }, NOW)
  const half = mod.starScoreOf({ w: 2, at: NOW - 40 * DAY }, NOW)
  assert.ok(Math.abs(half - fresh / 2) < 1e-9, `40 天该衰减一半：${fresh} → ${half}`)
  const hist = mod.starScoreOf({ w: 2, at: NOW, until: NOW }, NOW)
  assert.ok(hist < fresh, '被取代的说法要更暗')
  assert.equal(mod.starScoreOf({ score: 0.9 }, NOW), 0.9, '重要片段直接用 journal.top 的分数')
})

test('建星图：六种真实来源都进星，空快照不炸', () => {
  const built = mod.buildStarMap(sampleMem(), { now: NOW })
  const groups = new Set(built.stars.map((s) => s.group))
  for (const g of ['global', 'chat', 'history', 'episode', 'entity', 'profile']) {
    assert.ok(groups.has(g), `缺「${g}」这一类星`)
  }
  assert.equal(built.stats.total, built.stars.length)
  assert.equal(built.stats.archived, 1, '被取代的事实算归档')
  assert.equal(built.stats.live, built.stars.length - 1)
  for (const s of built.stars) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z), `${s.id} 坐标不是有限数`)
    assert.ok(s.brightness >= 0.14 && s.brightness <= 1, `${s.id} 亮度越界：${s.brightness}`)
  }
  /** 空快照：不能抛，也得给一份能渲染的空星图 */
  const empty = mod.buildStarMap(null, { now: NOW })
  assert.equal(empty.stars.length, 0)
  assert.equal(empty.stats.total, 0)
})

test('建星图：确定性（黄金角球面，不用 random）+ 关系线不造假端点', () => {
  const mem = sampleMem()
  const a = mod.buildStarMap(mem, { now: NOW })
  const b = mod.buildStarMap(mem, { now: NOW })
  assert.deepEqual(a.stars.map((s) => [s.id, s.x, s.y, s.z]), b.stars.map((s) => [s.id, s.x, s.y, s.z]))
  assert.equal(a.links.length, 1, '只有两端都是实体的关系才连')
  assert.equal(a.links[0].rel, '喜欢')
})

test('筛选：搜索 / 星团 / 只看快忘了 / 最近 7 天可叠加', () => {
  const { stars } = mod.buildStarMap(sampleMem(), { now: NOW })
  assert.equal(mod.filterStars(stars, {}, { now: NOW }).stars.length, stars.length)
  const q = mod.filterStars(stars, { q: '花生' }, { now: NOW })
  assert.equal(q.stars.length, 1)
  assert.ok(q.matched.has(q.stars[0].id))

  const g = mod.filterStars(stars, { group: 'entity' }, { now: NOW })
  assert.ok(g.stars.length >= 3)
  for (const s of g.stars) assert.equal(s.group, 'entity')

  const dim = mod.filterStars(stars, { quick: 'dim' }, { now: NOW })
  for (const s of dim.stars) assert.ok(s.brightness < 0.35)

  const recent = mod.filterStars(stars, { quick: 'recent' }, { now: NOW })
  assert.ok(recent.stars.length > 0)
  for (const s of recent.stars) assert.ok(s.at && NOW - s.at <= 7 * DAY)

  const both = mod.filterStars(stars, { group: 'entity', quick: 'recent' }, { now: NOW })
  for (const s of both.stars) assert.equal(s.group, 'entity')
})

test('3D 投影：透视除法、深度裁剪、yaw 转得动，且都是有限数', () => {
  const stars = [{ id: 'a', x: 0, y: 0, z: 0, brightness: 1 }, { id: 'b', x: 120, y: 60, z: 200, brightness: 1 }]
  const base = { yaw: 0, pitch: 0, zoom: 1, pan: { x: 0, y: 0 }, cam: { x: 0, y: 0, z: 0 } }
  const p = mod.projectStars(stars, base, { W: 640, H: 420, mode: '3d', radius: 240 })
  assert.equal(p.length, 2)
  for (const v of p) assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && v.k > 0)
  /** 近的点 k 更大（近大远小） */
  const near = p.find((v) => v.star.id === 'b')
  const far = p.find((v) => v.star.id === 'a')
  assert.ok(near.k > far.k, `近星该更大：${near.k} vs ${far.k}`)
  /** yaw 变化要真的改变横坐标 */
  const turned = mod.projectStars(stars, { ...base, yaw: 1.2 }, { W: 640, H: 420, mode: '3d', radius: 240 })
  assert.notEqual(Math.round(turned.find((v) => v.star.id === 'b').x), Math.round(near.x))
  /** 相机背后的点必须丢掉，否则会画到画布外 */
  const behind = mod.projectStars([{ id: 'x', x: 0, y: 0, z: 240 * 3 - 10 }], base, { W: 640, H: 420, mode: '3d', radius: 240 })
  assert.equal(behind.length, 0, 'depth < 60 的点必须被裁掉')
  /** 远的先画：返回按 depth 降序 */
  assert.ok(p[0].depth >= p[1].depth)
})

test('2D 投影：正交、不受 yaw/pitch 影响、与 3D 是同一批星', () => {
  const stars = [{ id: 'a', x: 100, y: 40, z: 0 }, { id: 'b', x: -80, y: -30, z: 200 }]
  const base = { yaw: 0.9, pitch: 0.5, zoom: 1, pan: { x: 0, y: 0 } }
  const a = mod.projectStars(stars, base, { W: 640, H: 420, mode: '2d' })
  const b = mod.projectStars(stars, { ...base, yaw: 0, pitch: 0 }, { W: 640, H: 420, mode: '2d' })
  assert.deepEqual(a.map((v) => [v.star.id, v.x, v.y]), b.map((v) => [v.star.id, v.x, v.y]), '2D 不该受旋转影响')
  const c = mod.projectStars(stars, base, { W: 640, H: 420, mode: '3d' })
  assert.deepEqual(a.map((v) => v.star.id).sort(), c.map((v) => v.star.id).sort(), '两版必须是同一批星')
  /** pan 要真的平移 */
  const moved = mod.projectStars(stars, { ...base, pan: { x: 30, y: -10 } }, { W: 640, H: 420, mode: '2d' })
  assert.equal(moved.find((v) => v.star.id === 'a').x - a.find((v) => v.star.id === 'a').x, 30)
})

test('滚轮缩放：上下方向正确、边界夹紧，且只用原生 passive:false 监听', () => {
  assert.ok(mod.wheelZoom(1, -100) > 1, '向上滚放大')
  assert.ok(mod.wheelZoom(1, 100) < 1, '向下滚缩小')
  assert.equal(mod.wheelZoom(2.6, -100), 2.6, '不能越过上限')
  assert.equal(mod.wheelZoom(0.6, 100), 0.6, '不能越过下限')
  assert.equal(mod.wheelZoom(0, -100), 1.1, '非法当前值退回 1 再算')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes("addEventListener('wheel', onWheel, { passive: false })"), '必须原生非被动监听，否则拦不住页面滚动')
  assert.ok(!src.includes('onWheel: (ev)'), '不能再挂 React onWheel（会缩放两次，且拦不住滚动）')
})

test('标签避让：数量封顶、两两不重叠、优先亮星', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({
    name: `星星${i}`, x: 40 + (i % 8) * 70, y: 40 + Math.floor(i / 8) * 80,
    brightness: (40 - i) / 40, r: 4 + (40 - i) / 10,
  }))
  const picked = mod.placeLabels(nodes, { maxLabels: 18, font: 11, maxChars: 7 })
  assert.ok(picked.length <= 18)
  assert.ok(picked.length >= 1)
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      const a = picked[i], b = picked[j]
      assert.equal(!(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y), false, '标签重叠了')
    }
  }
  assert.ok(picked.some((p) => p.full === '星星0'), '最亮的星必须拿到标签')
  /** 全挤在一起时宁可少放，也不硬叠 */
  const dense = Array.from({ length: 30 }, (_, i) => ({ name: `人${i}`, x: 20 + (i % 3) * 8, y: 20 + Math.floor(i / 3) * 3, brightness: 1, r: 4 }))
  assert.ok(mod.placeLabels(dense, { maxLabels: 30 }).length < 30)
})

test('星图组件：2D/3D 开关、3D 专属开关、420px 画布、交互都在', () => {
  assert.equal(typeof mod.StarMap, 'function')
  const tree = mod.StarMap({ mem: sampleMem(), toast: () => {}, reload: () => {}, quick: async () => ({ ok: true }), busy: false })
  const flat = []
  ;(function walk(n) {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) return n.forEach(walk)
    flat.push(n)
    walk(n.props?.children)
  })(tree)
  const textOf = (n) => {
    if (n == null || n === false) return ''
    if (typeof n === 'string' || typeof n === 'number') return String(n)
    if (Array.isArray(n)) return n.map(textOf).join('')
    return textOf(n.props?.children)
  }
  const txt = textOf(tree)
  for (const must of ['2D', '3D', '全部区域', '只看快忘了', '只看最近 7 天', '重置视角', '自动旋转（仅 3D）', '辉光', '关系线', '显示名字', '加上去']) {
    assert.ok(txt.includes(must), `缺「${must}」`)
  }
  const canvas = flat.find((n) => n.type === 'canvas')
  assert.ok(canvas)
  assert.equal(canvas.props.style.height, 420)
  for (const ev of ['onMouseDown', 'onMouseMove', 'onMouseLeave']) {
    assert.equal(typeof canvas.props[ev], 'function', `画布缺 ${ev}`)
  }
  assert.equal(canvas.props.onWheel, undefined, '滚轮必须走原生监听')
  /** 3D 专属功能要标明只在 3D，不能在 2D 假装能用 */
  assert.ok(txt.includes('仅 3D'))
})

test('记忆页挂了星图，人物页不再挂独立关系图', () => {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('h(StarMap, {'), '记忆页没挂星图')
  assert.ok(!src.includes('h(RelGraph, {'), '人物页还挂着独立关系图')
  assert.ok(!src.includes('function RelGraph'), '关系图组件没撤干净')
})
