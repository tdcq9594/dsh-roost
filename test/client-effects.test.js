// 面板的加载 effect：进页拉一次就够，**不能自激**；失败了要能重试。
//
// 为什么要单独一个文件：`client-render.test.js` 的假 React 里
// `useEffect: () => { i++ }` 只占位、不执行。所以「`setMem({...})` 造新对象 →
// `mem` 在依赖里 → effect 重跑 → 再 `setMem`」这种**死循环**永远测不出来——
// 850 条全绿也照样发现不了。
//
// 这里用一个**会重渲染**的极简 React：状态一变就重跑渲染 + 重新执行依赖变了的 effect。
// 断言是「渲染次数有上限、请求数有上限」——循环会被轮数上限直接打红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ---------------- 会重渲染的假 React ---------------- */

function makeReact() {
  const hooks = [];
  let cursor = 0;
  let dirty = false;
  let pending = [];

  const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

  return {
    reset() {
      hooks.length = 0;
      cursor = 0;
      dirty = false;
      pending = [];
    },
    get dirty() {
      return dirty;
    },
    clearDirty() {
      dirty = false;
    },
    takePending() {
      const p = pending;
      pending = [];
      return p;
    },
    beginRender() {
      cursor = 0;
    },
    /** 外部改状态后强制重渲染（切页要用） */
    markDirty() {
      dirty = true;
    },
    runEffect(k) {
      return hooks[k].fn();
    },
    hooks,
    React: {
      createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
      useState: (init) => {
        const k = cursor++;
        if (!(k in hooks)) hooks[k] = { v: typeof init === 'function' ? init() : init };
        const slot = hooks[k];
        return [
          slot.v,
          (next) => {
            const val = typeof next === 'function' ? next(slot.v) : next;
            if (!Object.is(val, slot.v)) {
              slot.v = val;
              dirty = true;
            }
          },
        ];
      },
      useEffect: (fn, deps) => {
        const k = cursor++;
        const prev = hooks[k];
        if (!prev || !same(deps, prev.deps)) {
          hooks[k] = { deps, fn };
          pending.push(k);
        }
      },
      useCallback: (fn, deps) => {
        const k = cursor++;
        const prev = hooks[k];
        if (prev && same(deps, prev.deps)) return prev.fn;
        hooks[k] = { deps, fn };
        return fn;
      },
      useRef: (v) => {
        const k = cursor++;
        if (!(k in hooks)) hooks[k] = { current: v };
        return hooks[k];
      },
      Fragment: 'fragment',
    },
  };
}

/* ---------------- 环境桩 ---------------- */

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
};

const CANNED = {
  '/memory': { ok: true, facts: [], diary: [], graph: {} },
  '/graph': { ok: true, stats: {}, entities: [], edges: [], ended: [] },
  '/closing': { ok: true, items: [] },
  '/chats': { ok: true, chats: [] },
  '/stickers': { ok: true, dir: '/x', items: [], chars: 0 },
  // 必须带 config 字段：loadConfig 读的是 r.config，缺了会 setConfig(undefined)，下一轮又拉
  '/config': { ok: true, config: { server: {}, persona: { current: 'default' } } },
};

let calls = [];
/** 在飞请求数：夹具要等它们落地，否则测不到「第二次进页」的真实状态 */
let active = 0;
/** 让某几个接口失败（测「失败后能不能重试」） */
let failing = new Set();

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '');
  calls.push(p.split('?')[0]);
  active++;
  /** CANNED / failing 用的是去掉 /roost/api 前缀的短键 */
  const key = p.replace(/^\/roost\/api/, '').split('?')[0];
  const body = failing.has(key) ? { ok: false, message: '假的失败' } : (CANNED[key] ?? { ok: true });
  return {
    ok: true,
    status: 200,
    text: async () => {
      active--;
      return JSON.stringify(body);
    },
  };
};
test.after(() => {
  globalThis.fetch = realFetch;
});

/** 把 client.js 灌进当前上下文 */
function loadClient(react) {
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  let mod = null;
  const win = {
    __ModuleLoader__: {
      load: (cfg) => {
        mod = cfg.factory((name) => (name === 'react' ? react : {}));
      },
    },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', src)(win);
  return mod;
}

/**
 * 一个「面板会话」：同一个模块 + 同一份 hooks，可以连续访问多页。
 * 这样才能测「第一次失败 → 第二次进页会不会重试」。
 */
function session() {
  const rt = makeReact();
  const mod = loadClient(rt.React);
  rt.reset();
  calls = [];
  /** 上一次停在哪一页：切页时靠它找到 tab 那个 state 槽 */
  let lastTab = null;

  return {
    rt,
    mod,
    /** 访问某一页，跑到状态稳定或撞轮数上限 */
    async visit(tab, { maxRenders = 20 } = {}) {
      const from = calls.length;
      store['roost.tab'] = tab;
      /**
       * 必须改 **state**，不是 localStorage——改 localStorage 不会触发重渲染，
       * 第二次 visit 会一个请求都不发（第一版夹具就栽在这儿，还以为是代码的问题）。
       *
       * 又不能写死下标：tab 前面还有一个 useCallback 槽。按「值等于上一页」定位最稳。
       */
      if (lastTab) {
        const k = rt.hooks.findIndex((h) => h && h.v === lastTab);
        if (k >= 0) {
          rt.hooks[k].v = tab;
          rt.markDirty();
        }
      }
      lastTab = tab;
      let renders = 0;
      do {
        rt.clearDirty();
        rt.beginRender();
        mod.RoostPage();
        renders++;

        for (const k of rt.takePending()) {
          try {
            await rt.runEffect(k);
          } catch {
            /* 页面里的 effect 出错不该让测试挂，这里只关心循环与重试 */
          }
        }
        // 等所有在飞请求落地 + 让 setState 生效
        for (let i = 0; i < 50 && active > 0; i++) await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      } while (rt.dirty && renders < maxRenders);

      return { renders, calls: calls.slice(from) };
    },
  };
}

const count = (list, key) => list.filter((x) => x === key).length;

/* ---------------- 用例 ---------------- */

test('加载 effect：记忆页只拉一轮，不会自激', async () => {
  const s = session();
  const { renders, calls: c } = await s.visit('memory');

  assert.ok(renders <= 2, `记忆页渲染了 ${renders} 次（>2 说明 effect 在自激）`);
  assert.equal(count(c, '/roost/api/memory'), 1, '/memory 只该拉一次');
  assert.equal(count(c, '/roost/api/graph'), 1);
  assert.equal(count(c, '/roost/api/closing'), 1);
});

test('加载 effect：会话页只拉一轮，不会自激', async () => {
  const s = session();
  const { renders, calls: c } = await s.visit('chats');

  assert.ok(renders <= 2, `会话页渲染了 ${renders} 次（>2 说明 effect 在自激）`);
  assert.equal(count(c, '/roost/api/chats'), 1, '/chats 只该拉一次');
});

test('加载 effect：人格页也只拉一轮', async () => {
  const s = session();
  const { renders, calls: c } = await s.visit('her');

  assert.ok(renders <= 3, `人格页渲染了 ${renders} 次`);
  assert.equal(count(c, '/roost/api/personas'), 1);
});

test('加载 effect：上下文页会顺带拉表情包（那行字要靠它）', async () => {
  const s = session();
  const { calls: c } = await s.visit('context');
  assert.equal(count(c, '/roost/api/stickers'), 1, '上下文页要拉 /stickers，否则表情包那行不显示');
});

test('加载 effect：接口失败过的话，下次进页要重试（不能永久卡在「读不到」）', async () => {
  const s = session();
  failing = new Set(['/stickers']);

  const first = await s.visit('context');
  assert.equal(count(first.calls, '/roost/api/stickers'), 1, '第一次要尝试');
  assert.equal(count(first.calls, '/roost/api/personas'), 1, 'loadHer 会一起拉人格');

  // 接口恢复了，换一页再看：stickers 还是 null，应该重拉
  failing = new Set();
  const second = await s.visit('config');
  assert.equal(
    count(second.calls, '/roost/api/stickers'),
    1,
    '上次没拿到 stickers，这次必须重试——只看 `!her` 的话这里会是 0',
  );

  failing = new Set();
});

test('加载 effect：同一份数据在飞时，切页不会重复请求', async () => {
  const s = session();
  // 第一次访问人格页，把数据拉下来
  await s.visit('her');
  calls = [];

  // 立刻切到设置页：config 已经在第一轮拉过、her 也有了，不该再打
  const { calls: c } = await s.visit('config');
  assert.equal(count(c, '/roost/api/personas'), 0, '人格数据已有，不该重拉');
  assert.equal(count(c, '/roost/api/config'), 0, '配置已有，不该重拉');
});
