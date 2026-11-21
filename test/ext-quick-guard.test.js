/**
 * 扩展页面转发 `/quick` 的判权 + 垫片注入
 * ======================================
 *
 * 两块都是「错了不会报错」的那种：判权错了是**越权**（静默），垫片错了是
 * **页面悄悄失灵**（`fetch` 返回 404/跨域失败，页面只显示「连不上面板」）。
 * 所以断言盯行为，不盯实现。
 */

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { guardQuickCall, PANEL_MARK } from '../src/ext-quick-guard.js';
import { PAGE_SHIM, injectShim } from '../src/ext-page-shim.js';

/* ---------------- 判权 ---------------- */

test('判权：面板带 @panel，保持全权', () => {
  for (const op of ['model.set', 'memory.purge', 'extensions.market.install']) {
    const r = guardQuickCall({ op, arg: { a: 1 }, viaExt: PANEL_MARK });
    assert.equal(r.ok, true, `${op} 面板自己应该能调`);
    assert.deepEqual(r.arg, { a: 1 }, '不该改面板传的参数');
  }
});

/**
 * 「没带标记」必须拒绝，不能默认当面板（2026-11-21 复核）。
 *
 * 以前用「`viaExt` 为空」表示面板——任何漏传这个字段的调用都会拿到全权，
 * 而漏传是很容易犯的错。
 */
test('判权：没带标记一律 400，不当面板', () => {
  for (const viaExt of [undefined, '', '   ', null]) {
    const r = guardQuickCall({ op: 'model.set', arg: {}, viaExt });
    assert.equal(r.ok, false, `${JSON.stringify(viaExt)} 应该被拒`);
    assert.equal(r.status, 400);
    assert.match(r.why, /缺少调用方标记/);
  }
});

test('判权：扩展没声明的 scope 一律拒', () => {
  const r = guardQuickCall({ op: 'model.set', arg: {}, viaExt: 'bili', scopes: ['state:read'] });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.why, /model:write/);
});

test('判权：声明了就能用（声明即授权）', () => {
  const r = guardQuickCall({ op: 'model.set', arg: { v: 1 }, viaExt: 'bili', scopes: ['model:write'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.arg, { v: 1 });
});

test('判权：只碰自己的 op 不需要 scope，但 id 会被补成自己', () => {
  const r = guardQuickCall({ op: 'extensions.config.save', arg: { values: { a: 1 } }, viaExt: 'bili', scopes: [] });
  assert.equal(r.ok, true);
  assert.equal(r.arg.id, 'bili', '漏传 id 时补上自己的');
  assert.deepEqual(r.arg.values, { a: 1 }, '别的字段不能动');
});

test('判权：传别人的 id 直接拒（不悄悄改）', () => {
  const r = guardQuickCall({
    op: 'extensions.config.save', arg: { id: 'imagegen', values: {} }, viaExt: 'bili', scopes: [],
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /ext:manage/);
});

test('判权：声明了 ext:manage 就能跨扩展', () => {
  const r = guardQuickCall({
    op: 'extensions.config.save', arg: { id: 'imagegen', values: {} }, viaExt: 'bili', scopes: ['ext:manage'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.arg.id, 'imagegen', '有 ext:manage 时不该被改成自己');
});

test('判权：未知 op 拒绝（fail-closed）', () => {
  for (const op of ['', 'nope', 'model.set2', 'toString']) {
    const r = guardQuickCall({ op, arg: {}, viaExt: 'bili', scopes: ['ext:manage', 'model:write'] });
    assert.equal(r.ok, false, `${op || '(空)'} 应该被拒`);
  }
});

test('判权：scopes 不是数组时按空处理（别炸）', () => {
  for (const scopes of [undefined, null, 'model:write', {}]) {
    const r = guardQuickCall({ op: 'model.set', arg: {}, viaExt: 'bili', scopes });
    assert.equal(r.ok, false, `${JSON.stringify(scopes)} 应该按「没声明」处理`);
  }
});

/* ---------------- 垫片 ---------------- */

test('垫片：有 <head> 时插在它后面（先于页面脚本执行）', () => {
  const html = '<!doctype html><html><head><title>t</title><script>window.x=1</script></head><body></body></html>';
  const out = injectShim(html);
  assert.ok(out.includes(PAGE_SHIM), '垫片要在');
  assert.ok(out.indexOf('__roostBridge') < out.indexOf('<title>'), '要排在页面自己的东西之前');
  assert.ok(out.indexOf('__roostBridge') < out.indexOf('window.x=1'), '必须早于页面脚本');
  assert.ok(out.includes('window.x=1'), '页面原内容不能丢');
});

test('垫片：没有 <head> 时直接拼在最前', () => {
  const out = injectShim('<div>裸片段</div>');
  assert.ok(out.startsWith('<script>'), '要拼在最前');
  assert.ok(out.endsWith('<div>裸片段</div>'), '原内容要在后面');
});

test('垫片：只拦 /roost/api/quick，别的请求原样放行', () => {
  assert.match(PAGE_SHIM, /pathname\.indexOf\("\/roost\/api\/quick"\)/);
  /**
   * 读自己目录下的 JSON 不能被**转成 postMessage**（靠 CORS 直连）。
   * 垫片只把它的 `id` 钉成自己，请求本身照旧走 fetch。
   */
  assert.equal(/call\([^)]*ext-pages/.test(PAGE_SHIM), false, '不该把 /ext-pages 转成 postMessage');
});

test('垫片：20 秒没回音要回超时，别让页面永远等', () => {
  assert.match(PAGE_SHIM, /20000/);
  assert.match(PAGE_SHIM, /504/);
  /** 只认父窗口的回信：别的 frame 也能往我们这里 postMessage */
  assert.match(PAGE_SHIM, /e\.source !== parent/);
});

test('垫片：空输入不炸', () => {
  assert.equal(injectShim(''), '');
  assert.equal(injectShim(null), '');
  assert.equal(injectShim(undefined), '');
});

/* ---------------- 前端接线 ---------------- */

const CLIENT = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('前端：iframe 带 sandbox，且放行了 5 个页面实测要用的能力', () => {
  const m = CLIENT.match(/sandbox: '([^']+)'/);
  assert.ok(m, '要加 sandbox 属性');
  assert.match(m[1], /allow-scripts/, '要能跑脚本');
  assert.match(m[1], /allow-modals/, 'confirm() 要靠它');
  assert.match(m[1], /allow-popups/, '外链要靠它');
  assert.match(m[1], /allow-forms/, '表单提交要靠它');
  /** 给了 allow-same-origin 就等于没沙箱（同源 + 可跑脚本 = 完全逃逸） */
  assert.equal(m[1].includes('allow-same-origin'), false, '绝不能给 allow-same-origin');
  assert.match(CLIENT, /allow: 'clipboard-write'/, '剪贴板要单独授权');
  assert.match(CLIENT, /ref: frameRef/, '要能拿到 contentWindow');
});

test('前端：消息通道只认自己那个 iframe 发来的', () => {
  const at = CLIENT.indexOf('const onMsg = async (e) => {');
  assert.ok(at > 0, '找不到消息处理');
  const block = CLIENT.slice(at, at + 1400);
  assert.match(block, /e\.source !== f\.contentWindow/, '要校验来源');
  /** viaExt 只由父窗口填，页面载荷里的同名字段不能采信 */
  assert.match(block, /viaExt: id/, 'viaExt 要用面板记住的 id');
  assert.equal(/m\.viaExt|msg\.viaExt/.test(block), false, '不能采信页面传的 viaExt');
});

/**
 * 垫片是**注入的字符串**，光看源码不算数——真跑一遍：
 * `fetch('/roost/api/quick')` 要变成 `postMessage`，回来还要还原成能 `.json()` 的响应。
 */
test('垫片：真的把 /roost/api/quick 转成 postMessage，并把回复还原成 Response', async () => {
  const code = PAGE_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const posted = [];
  const listeners = [];
  const origCalls = [];

  const win = {
    addEventListener: (t, fn) => listeners.push(fn),
    fetch: async (u) => {
      origCalls.push(String(u));
      return new Response('{"raw":1}', { status: 200 });
    },
  };
  const fakeParent = {
    postMessage: (m) => {
      posted.push(m);
      /** 模拟父窗口：转给服务端判权后回消息 */
      setTimeout(() => {
        for (const fn of listeners) {
          fn({ data: { type: 'roost:reply', id: m.id, ok: true, status: 200, body: { ok: true, groups: ['g1'] } } });
        }
      }, 0);
    },
  };

  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'location', 'Response', 'setTimeout', 'clearTimeout', 'URL', 'Promise', code)(
    win, fakeParent,
    { href: 'http://panel/roost/api/ext-pages?id=bili&file=ui/index.html' },
    Response, setTimeout, clearTimeout, URL, Promise,
  );

  const r = await win.fetch('/roost/api/quick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'groups.list', arg: { q: 1 } }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, groups: ['g1'] }, '回复要能 .json()');

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'roost:quick');
  assert.equal(posted[0].op, 'groups.list', 'op 要透传');
  assert.deepEqual(posted[0].arg, { q: 1 }, 'arg 要透传');

  /** 非 quick 的请求（读自己目录下的 JSON）原样走真实 fetch */
  const r2 = await win.fetch('/roost/api/ext-pages?id=bili&file=shots/index.json');
  assert.deepEqual(await r2.json(), { raw: 1 });
  assert.equal(origCalls.length, 1, '不该拦 /ext-pages');
});

/**
 * `/ext-pages` 对沙箱页面是放行的（要读自己目录下的 JSON / 截图），但它**不认人**：
 * 任何扩展的页面都能填别人的 id 去读别人的文件。垫片把 id 强制成自己。
 */
test('垫片：/ext-pages 的 id 被强制成自己，读不到别人的文件', async () => {
  const code = PAGE_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const seen = [];
  const win = {
    addEventListener: () => {},
    fetch: async (u) => { seen.push(String(u)); return new Response('{}'); },
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'location', 'Response', 'setTimeout', 'clearTimeout', 'URL', 'URLSearchParams', 'XMLHttpRequest', 'Promise', code)(
    win, { postMessage: () => {} },
    { href: 'http://p/roost/api/ext-pages?id=bili&file=ui/index.html', search: '?id=bili&file=ui/index.html' },
    Response, setTimeout, clearTimeout, URL, URLSearchParams, undefined, Promise,
  );

  await win.fetch('/roost/api/ext-pages?id=imagegen&file=gallery.json');
  await win.fetch('/roost/api/ext-pages?id=bili&file=shots/index.json');
  await win.fetch('https://i0.hdslb.com/x.jpg');

  assert.match(seen[0], /id=bili/, '别人的 id 要被换掉');
  assert.equal(/imagegen/.test(seen[0]), false, '换掉之后不能还留着别人的 id');
  assert.match(seen[1], /id=bili/, '自己的 id 原样');
  assert.equal(seen[2], 'https://i0.hdslb.com/x.jpg', '外站资源不许改');
});

test('垫片：XHR 也要管（不补就只是防君子）', () => {
  assert.match(PAGE_SHIM, /XMLHttpRequest\.prototype\.open/, '要覆写 XHR.open');
});
