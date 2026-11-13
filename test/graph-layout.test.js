// 4.2 关系图重做（2026-11-13）的三个纯函数。
//
// 为什么要单独测：星图的可读性全压在这三件事上——节点排开、标签不叠、
// 筛选不漏。上一版「所有节点都写字 + 每条边都标关系」糊成一片，
// 但 canvas 绘制在 Node 里跑不了，只能把决策部分抽成纯函数钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 够用的 React 替身：只占 hook 位，不执行副作用 */
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

function loadClient() {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod = null
  const win = { __ModuleLoader__: { load: (cfg) => { mod = cfg.factory((n) => (n === 'react' ? makeReact().React : {})) } } }
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return mod
}

const mod = loadClient()

/** 造一份边表：10 个实体、30 条关系，形状和 /memory 的 graph.edges 一致 */
function sampleEdges() {
  const names = ['大肥鱼', '阿岚', '猫', '主人', '小栖', '机器猫', '竹子', 'QQ', '群友A', '群友B']
  const rels = ['喜欢', '讨厌', '认识', '约定']
  const out = []
  for (let i = 0; i < 30; i++) {
    out.push({ id: `e${i}`, src: names[i % names.length], dst: names[(i * 3 + 1) % names.length], rel: rels[i % rels.length], from: 1_700_000_000_000 })
  }
  return out
}

test('关系图布局：节点去重、度数计数、自环与空名丢掉', () => {
  const lay = mod.graphLayout([
    { src: '阿岚', dst: '猫', rel: '喜欢' },
    { src: '阿岚', dst: '猫', rel: '认识' },
    { src: '阿岚', dst: '阿岚', rel: '自恋' },
    { src: '', dst: '猫', rel: '空名' },
    { src: '猫', dst: '主人', rel: '认识' },
  ], { w: 400, h: 300 })
  assert.deepEqual(lay.nodes.map((n) => n.name).sort(), ['主人', '猫', '阿岚'].sort())
  const a = lay.nodes.find((n) => n.name === '阿岚')
  /** 两条边都指向猫，度数各算一次；自环不算 */
  assert.equal(a.deg, 2)
  assert.equal(lay.links.length, 3)
  assert.equal(lay.degMax, 3)
})

test('关系图布局：坐标有限、不出画布、同一份数据画两次完全一样', () => {
  const edges = sampleEdges()
  const one = mod.graphLayout(edges, { w: 640, h: 420 })
  const two = mod.graphLayout(edges, { w: 640, h: 420 })
  for (const n of one.nodes) {
    assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${n.name} 坐标不是有限数`)
    assert.ok(n.x >= 0 && n.x <= 640, `${n.name} 跑出画布：x=${n.x}`)
    assert.ok(n.y >= 0 && n.y <= 420, `${n.name} 跑出画布：y=${n.y}`)
  }
  /** 确定性：初始位置用黄金角螺旋而不是 Math.random */
  assert.deepEqual(one.nodes.map((n) => [n.name, n.x, n.y]), two.nodes.map((n) => [n.name, n.x, n.y]))
})

test('关系图布局：节点不叠在一起（上一版最大的问题）', () => {
  const lay = mod.graphLayout(sampleEdges(), { w: 640, h: 420 })
  let min = Infinity
  for (let i = 0; i < lay.nodes.length; i++) {
    for (let j = i + 1; j < lay.nodes.length; j++) {
      const a = lay.nodes[i]; const b = lay.nodes[j]
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y))
    }
  }
  /** 节点半径最大 10，两圆心 24 以内就一定叠 */
  assert.ok(min > 24, `最近两个节点只差 ${min.toFixed(1)}px，会叠在一起`)
})

test('关系图布局：70 个实体也不炸、不挤', () => {
  const edges = []
  for (let i = 0; i < 70; i++) edges.push({ src: `实体${i}`, dst: `实体${(i * 7 + 3) % 70}`, rel: ['喜欢', '认识', '约定'][i % 3] })
  const t0 = Date.now()
  const lay = mod.graphLayout(edges, { w: 900, h: 420 })
  const dt = Date.now() - t0
  assert.equal(lay.nodes.length, 70)
  /** 220 轮迭代在 70 节点上必须远低于一帧预算；超过 500ms 就是算法退化了 */
  assert.ok(dt < 500, `布局耗时 ${dt}ms，太慢`)
  let min = Infinity
  for (let i = 0; i < lay.nodes.length; i++) {
    for (let j = i + 1; j < lay.nodes.length; j++) {
      min = Math.min(min, Math.hypot(lay.nodes[i].x - lay.nodes[j].x, lay.nodes[i].y - lay.nodes[j].y))
    }
  }
  assert.ok(min > 16, `70 个实体时最近两点只差 ${min.toFixed(1)}px`)
})

test('标签避让：数量封顶、两两不重叠、优先高度数节点', () => {
  const lay = mod.graphLayout(sampleEdges(), { w: 640, h: 420 })
  const picked = mod.placeLabels(lay.nodes, { maxLabels: 6, font: 11, maxChars: 6 })
  assert.ok(picked.length <= 6, `超过 maxLabels：${picked.length}`)
  for (let i = 0; i < picked.length; i++) {
    for (let j = i + 1; j < picked.length; j++) {
      const a = picked[i]; const b = picked[j]
      const overlap = !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y)
      assert.equal(overlap, false, `「${a.name}」和「${b.name}」的标签叠了`)
    }
  }
  /** 度数最高的那个必须在，否则等于把「中心人物」藏起来 */
  const top = [...lay.nodes].sort((a, b) => b.deg - a.deg)[0]
  assert.ok(picked.some((p) => p.full === top.name), `度数最高的「${top.name}」没拿到标签`)
  /** 名字按 maxChars 截断（画布上放不下全名） */
  for (const p of picked) assert.ok([...p.name].length <= 6, `「${p.name}」超过 6 个字`)
})

test('标签避让：放不下就跳过，不硬挤', () => {
  /** 30 个节点全挤在 40×40 里，能放下的标签必然远少于 30 */
  const nodes = Array.from({ length: 30 }, (_, i) => ({ name: `人${i}`, x: 20 + (i % 3) * 8, y: 20 + Math.floor(i / 3) * 3, deg: 30 - i, r: 4 }))
  const picked = mod.placeLabels(nodes, { maxLabels: 30 })
  assert.ok(picked.length < 30, '挤在一起还能全放下，说明避让没生效')
  assert.ok(picked.length >= 1, '至少放得下一个')
})

test('关系筛选：关键字命中任一端、类型精确匹配、空条件返回全部', () => {
  const edges = sampleEdges()
  const all = mod.filterRels(edges, {})
  assert.equal(all.edges.length, edges.length)
  assert.equal(all.hit.size, 0, '没搜索词时不该有命中集合')

  const byName = mod.filterRels(edges, { q: '阿岚' })
  assert.ok(byName.edges.length > 0)
  for (const e of byName.edges) assert.ok(e.src === '阿岚' || e.dst === '阿岚')
  assert.deepEqual([...byName.hit], ['阿岚'])

  const byRel = mod.filterRels(edges, { kind: '喜欢' })
  assert.ok(byRel.edges.length > 0)
  for (const e of byRel.edges) assert.equal(e.rel, '喜欢')

  /** 大小写不敏感：实体名里可能有英文 */
  const upper = mod.filterRels([{ src: 'QQ', dst: '猫', rel: '认识' }], { q: 'qq' })
  assert.equal(upper.edges.length, 1)
})

test('关系图组件仍然导出，且人物页 04 还在用它', () => {
  assert.equal(typeof mod.RelGraph, 'function')
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.ok(src.includes('h(RelGraph, {'), '人物页没挂关系图')
  /** 上一版的死结构不能回来：每条边都写关系字 */
  assert.ok(!src.includes('ctx.fillText(l.rel ||'), '关系字又画回线上了')
})
