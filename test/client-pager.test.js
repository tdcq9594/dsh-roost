// 「加载更多」的合并规则。
//
// 这一层不测 React，只测纯函数 `mergeClientPage`——它的三个输入（当前 state、
// 服务端响应、发请求那一刻的快照）足以复现「请求在途时列表被重置」这类竞态。
//
// 为什么值得单测：offset 分页在列表变动时必然错位。上一版拿**闭包里的旧快照**
// 覆盖整个 state，吊销一条之后、在途的 append 返回，会把那条**复活**回来，
// 行数还多一条。这种 bug 在浏览器里很难复现，但在纯函数里是一行输入的事。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** 把 client.js 灌进当前上下文，返回它导出的模块（useEffect 等副作用不跑） */
function loadClient() {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  let mod = null
  const win = {
    __ModuleLoader__: { load: (cfg) => { mod = cfg.factory(() => ({})) } },
  }
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win)
  return mod
}

const { mergeClientPage } = loadClient()

const rows = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}` }))
const state = (list, total) => ({ rows: list, total, limit: 20, hasMore: true, availableScopes: [] })
const page = (list, total) => ({ ok: true, rows: list, total, limit: 20, hasMore: false })

test('分页合并：正常情况把下一页接在后面', () => {
  const base = rows(20)
  const merged = mergeClientPage(state(base, 30), page(rows(10, 20), 30), base)
  assert.equal(merged.rows.length, 30);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.total, 30);
});

test('分页合并：服务端返回了已显示过的行，按 id 去重', () => {
  const base = rows(20)
  /** 后端从 offset 20 开始却又带回 r18/r19（offset 错位的典型表现） */
  const merged = mergeClientPage(state(base, 25), page([...rows(2, 18), ...rows(3, 20)], 25), base)
  assert.deepEqual(merged.rows.map((r) => r.id).slice(18), ['r18', 'r19', 'r20', 'r21', 'r22']);
  assert.equal(new Set(merged.rows.map((r) => r.id)).size, merged.rows.length, '不许有重复 id');
});

test('分页合并：请求在途时列表被重置过 → 丢掉这份响应，不复活已删的行', () => {
  const base = rows(20);
  /** 期间吊销了 r0，列表被重置成 19 行 */
  const cur = state(rows(20).slice(1), 29);
  const out = mergeClientPage(cur, page(rows(10, 20), 30), base);
  assert.equal(out, null, '行数对不上就要丢掉，不能拿旧 base 覆盖');
});

test('分页合并：请求在途时服务端增删过（total 变了）→ 丢掉', () => {
  const base = rows(20);
  const out = mergeClientPage(state(base, 30), page(rows(10, 20), 31), base);
  assert.equal(out, null);
});

test('分页合并：cur 还没加载过（null）→ 丢掉，不崩', () => {
  assert.equal(mergeClientPage(null, page(rows(5), 5), []), null);
  assert.equal(mergeClientPage(undefined, page(rows(5), 5), []), null);
});

test('分页合并：响应缺 total 就当对不上，丢掉而不是产出 NaN', () => {
  const base = rows(20);
  /**
   * `Number(undefined)` 是 NaN，`NaN !== 30` → 走「对不上」分支。
   * 这是想要的：缺字段的响应不可信，丢掉比渲染出 `total: NaN` 好。
   */
  assert.equal(mergeClientPage(state(base, 30), { ok: true, rows: rows(5, 20) }, base), null);
});
