/**
 * 扩展页面里的 `fetch` 垫片
 * =======================
 *
 * 沙箱之后页面是 opaque origin，直接 `fetch('/roost/api/quick')` 会被 CORS 挡。
 * 但 5 个存量页面都是「`fetch` + `.json()`」的写法，为了不改它们，这里覆写
 * `window.fetch`：把打到 `/roost/api/quick` 的请求转成 `postMessage` 交给父窗口，
 * 由面板按**该扩展声明过的 scope** 转发。
 *
 * 只拦 `/roost/api/quick`。其它请求（读自己目录下的 JSON、图片、字体）原样放行，
 * 靠 `/ext-pages` 上的 `access-control-allow-origin` 允许跨源读取。
 *
 * 这段脚本由宿主**注入到页面最前面**（`/ext-pages` 发 HTML 时拼进去），
 * 所以它一定先于页面自己的脚本执行。
 */

export const PAGE_SHIM = `<script>(function(){
"use strict";
if (window.__roostBridge) return;
window.__roostBridge = true;
var seq = 0, waiting = {};

function mk(ok, status, body) {
  var text = JSON.stringify(body == null ? {} : body);
  if (typeof Response === "function") {
    try { return new Response(text, { status: status, headers: { "content-type": "application/json" } }); } catch (e) {}
  }
  return { ok: ok, status: status,
    json: function(){ return Promise.resolve(body); },
    text: function(){ return Promise.resolve(text); } };
}

window.addEventListener("message", function (e) {
  /** 只认父窗口的回信：别的 frame 也能 postMessage 到我们 */
  if (e.source && e.source !== parent) return;
  var d = e.data;
  if (!d) return;

  /**
   * 跟随面板主题（可选，个性化页开关）。
   * 只接受白名单变量 + 安全值：这是从父窗口写进页面根的 CSS 变量，
   * 不设防的话别人 postMessage 一段 url(...) 也能借我们的页面发起请求。
   * 页面自己的 CSS 读不读这些变量由扩展决定——我们不改它的样式，只递值。
   */
  if (d.type === "roost:theme") {
    var doc = window && window.document;
    var root = doc && doc.documentElement;
    if (!root || !root.style) return;
    var vars = { "--accent": 1, "--accent-light": 1, "--card-fill": 1 };
    var vals = d.vars && typeof d.vars === "object" ? d.vars : {};
    var applied = 0;
    for (var k in vals) {
      if (!Object.prototype.hasOwnProperty.call(vars, k)) continue;
      var v = String(vals[k] == null ? "" : vals[k]);
      /** 只挡注入通道（多写声明 / url 外链 / 尖括号）；color-mix 嵌套括号放行 */
      if (!v || /[;{}<>"']/.test(v) || /url|expression/i.test(v)) continue;
      root.style.setProperty(k, v);
      applied++;
    }
    if (applied && root.classList && root.classList.add) root.classList.add("roost-themed");
    return;
  }

  if (d.type !== "roost:reply" || !d.id) return;
  var done = waiting[d.id];
  if (!done) return;
  delete waiting[d.id];
  done(d.ok, d.status, d.body);
});

function call(op, arg) {
  return new Promise(function (resolve) {
    var id = ++seq;
    var timer = setTimeout(function () {
      delete waiting[id];
      resolve(mk(false, 504, { ok: false, message: "面板没有响应（超时）" }));
    }, 20000);
    waiting[id] = function (ok, status, body) {
      clearTimeout(timer);
      resolve(mk(ok, status, body));
    };
    try {
      parent.postMessage({ type: "roost:quick", id: id, op: op, arg: arg }, "*");
    } catch (e) {
      clearTimeout(timer);
      delete waiting[id];
      resolve(mk(false, 500, { ok: false, message: String((e && e.message) || e) }));
    }
  });
}

/**
 * 自己是谁。页面地址形如 /ext-pages?id=<自己>&file=...，从 query 里读。
 */
var SELF = "";
try { SELF = new URLSearchParams(location.search).get("id") || ""; } catch (e) {}

/**
 * 把 /ext-pages 的 id 强制成自己。
 *
 * 这条路由对沙箱页面是放行的（它要读自己目录下的 JSON / 截图），但不认人：
 * 任何扩展的页面都能填别人的 id 去读别人的文件。页面里能改的地方只有这一层
 * （fetch 和 XHR），改不了 <img src>——但图片读不出像素（画布会污染），
 * 真正的数据外泄通道是 JSON，堵住这里就够了。
 */
function pinSelf(abs) {
  if (!SELF || abs.pathname.indexOf("/roost/api/ext-pages") !== 0) return false;
  if (abs.searchParams.get("id") === SELF) return false;
  abs.searchParams.set("id", SELF);
  return true;
}

var orig = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
window.fetch = function (input, init) {
  var url = typeof input === "string" ? input : ((input && input.url) || "");
  var abs = null;
  try { abs = new URL(url, location.href); } catch (e) {}
  if (abs && abs.pathname.indexOf("/roost/api/quick") === 0) {
    var body = null;
    try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch (e) {}
    return call(String((body && body.op) || ""), (body && body.arg) || {});
  }
  if (!orig) return Promise.reject(new Error("这个页面没有 fetch"));
  if (abs && pinSelf(abs)) return orig(abs.toString(), init);
  return orig(input, init);
};

/** XHR 也要管：不补这一段，垫片就只是「防君子」 */
if (typeof XMLHttpRequest === "function" && XMLHttpRequest.prototype && XMLHttpRequest.prototype.open) {
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, u) {
    var args = Array.prototype.slice.call(arguments);
    try {
      var abs = new URL(String(u), location.href);
      if (pinSelf(abs)) args[1] = abs.toString();
    } catch (e) {}
    return xhrOpen.apply(this, args);
  };
}
})();</script>`;

/** 把垫片插到页面最前面：有 `<head>` 就紧跟其后，没有就直接拼在最前。 */
export function injectShim(html) {
  const s = String(html ?? '');
  if (!s) return s;
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + PAGE_SHIM);
  return PAGE_SHIM + s;
}
