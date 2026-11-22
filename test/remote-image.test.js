/**
 * `remote-image.js` 的护栏测试。
 *
 * 这个文件是**唯一**能把模型给的字串变成一次出站请求的地方，所以测的重点
 * 不是「能不能取到图」（那是功能），而是「不该取的有没有被拦住」。
 *
 * 真正取图的那几条只能对着本地服务器跑，所以 `fetchImage` 有一个
 * `allowPrivateForTests` 开关；测试里必须只在这种情况下用它。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { fetchImage, isForbiddenAddress, sniffImage, MAX_BYTES } from '../src/remote-image.js';

/** 1x1 透明 PNG（真图，魔数也是真的） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/'
  + 'AoFj3wAAAABJRU5ErkJggg==',
  'base64',
);

/* ---------------------------- 地址判定 ---------------------------- */

test('isForbiddenAddress：私有 / 保留段一律拦', () => {
  for (const ip of [
    '127.0.0.1', '127.255.0.9',
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', // 云元数据，最经典的那一个
    '100.64.0.1', // CGNAT
    '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '198.18.0.5', '192.0.2.1', '203.0.113.9',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    // 6to4：2002:7f00:0001:: 里嵌的就是 127.0.0.1
    '2002:7f00:0001::1', '2002::1',
    // NAT64：末 32 位是 IPv4，64:ff9b::a00:1 就是 10.0.0.1
    '64:ff9b::a00:1', '64:ff9b::7f00:1',
  ]) {
    assert.equal(isForbiddenAddress(ip), true, `${ip} 应该被拦`);
  }
});

test('isForbiddenAddress：公网放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '104.16.0.1', '2001:4860:4860::8888']) {
    assert.equal(isForbiddenAddress(ip), false, `${ip} 不该被拦`);
  }
});

test('isForbiddenAddress：IPv4-mapped 与认不出的写法一律拦（fail-closed）', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fe80::1%eth0', 'not-an-ip', '', ' ']) {
    assert.equal(isForbiddenAddress(ip), true, `${JSON.stringify(ip)} 应该被拦`);
  }
});

/* ---------------------------- 魔数 ---------------------------- */

test('sniffImage：认四种常见格式，认不出就 null', () => {
  assert.equal(sniffImage(PNG)?.mime, 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(20)]))?.ext, '.jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a' + '\0'.repeat(20)))?.ext, '.gif');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(sniffImage(webp)?.ext, '.webp');

  /** 网页 / 文本 / 太短：都不是图 */
  assert.equal(sniffImage(Buffer.from('<!DOCTYPE html><html>…'.repeat(4))), null);
  assert.equal(sniffImage(Buffer.from('hello')), null);
  assert.equal(sniffImage(PNG.subarray(0, 10)), null);
  assert.equal(sniffImage(null), null);
});

/* ---------------------------- URL 前置检查（不联网） ---------------------------- */

test('fetchImage：协议 / 账号密码 / 端口 三道前置检查', async () => {
  const bad = [
    ['ftp://example.com/a.png', /只支持 http/],
    ['file:///C:/a.png', /只支持 http/],
    ['http://user:pass@example.com/a.png', /不要带账号密码/],
    ['http://example.com:8080/a.png', /80 \/ 443/],
    ['http://example.com:22/a.png', /80 \/ 443/],
    ['不是网址', /看不懂/],
  ];
  for (const [url, re] of bad) {
    const r = await fetchImage(url);
    assert.equal(r.ok, false, url);
    assert.match(r.message, re, url);
  }
});

test('fetchImage：本机与内网直连地址被拒（不发请求）', async () => {
  for (const url of [
    'http://127.0.0.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1:80/a.png',
    'http://[::1]/a.png',
  ]) {
    const r = await fetchImage(url, { timeoutMs: 500 });
    assert.equal(r.ok, false, url);
    assert.match(r.message, /内网|不支持/, url);
  }
});

test('fetchImage：localhost 解析到回环也拒（防的是「看起来像域名」）', async () => {
  const r = await fetchImage('http://localhost:80/a.png', { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.match(r.message, /内网|解析/);
});

/* ---------------------------- 真取（本地服务器） ---------------------------- */

/** 起一个只在 127.0.0.1 上监听的小服务器，返回 { base, close } */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    const fn = routes[req.url];
    if (!fn) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    fn(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('取到图：返回字节 + 按魔数认出的格式', async () => {
  const s = await serve({ '/a': (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); } });
  try {
    /** 只有测试会传这个开关；宿主永远不传 */
    const r = await fetchImage(`${s.base}/a`, { allowPrivateForTests: true });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.mime, 'image/png');
    assert.equal(r.ext, '.png');
    assert.equal(r.bytes, PNG.length);
    assert.equal(r.buf.equals(PNG), true);
  } finally { await s.close(); }
});

test('返回网页（哪怕是 200）不认：只信魔数，不信 Content-Type', async () => {
  const s = await serve({
    /** 故意把 content-type 写成图片：仍然要靠魔数拦下 */
    '/html': (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<!doctype html><h1>hi</h1>'); },
    '/ct-html': (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PNG); },
  });
  try {
    const a = await fetchImage(`${s.base}/html`, { allowPrivateForTests: true });
    assert.equal(a.ok, false);
    assert.match(a.message, /不是图片/);

    const b = await fetchImage(`${s.base}/ct-html`, { allowPrivateForTests: true });
    assert.equal(b.ok, false);
    assert.match(b.message, /网页/);
  } finally { await s.close(); }
});

test('超限就断：Content-Length 先拦，没声明的边收边数', async () => {
  const s = await serve({
    '/big': (req, res) => { res.writeHead(200, { 'content-length': String(MAX_BYTES + 10) }); res.end('x'); },
    '/stream': (req, res) => {
      /** 不声明长度，一路推：这条走的是「边收边数」那个分支 */
      res.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.alloc(64 * 1024, 0);
      const pump = () => {
        if (res.destroyed) return;
        if (res.write(chunk)) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    },
  });
  try {
    const a = await fetchImage(`${s.base}/big`, { allowPrivateForTests: true });
    assert.equal(a.ok, false);
    assert.match(a.message, /图太大/);

    const b = await fetchImage(`${s.base}/stream`, { allowPrivateForTests: true, maxBytes: 256 * 1024 });
    assert.equal(b.ok, false);
    assert.match(b.message, /图太大/);
  } finally { await s.close(); }
});

test('重定向：跟随一次能取到，超次数就停', async () => {
  const s = await serve({
    '/r1': (req, res) => { res.writeHead(302, { location: '/r2' }); res.end(); },
    '/r2': (req, res) => { res.writeHead(301, { location: '/a' }); res.end(); },
    '/a': (req, res) => { res.writeHead(200); res.end(PNG); },
    '/loop': (req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); },
  });
  try {
    const ok = await fetchImage(`${s.base}/r1`, { allowPrivateForTests: true });
    assert.equal(ok.ok, true, ok.message);

    const loop = await fetchImage(`${s.base}/loop`, { allowPrivateForTests: true });
    assert.equal(loop.ok, false);
    assert.match(loop.message, /跳转太多次/);
  } finally { await s.close(); }
});

test('非 200 / 空内容：给一句能看懂的话', async () => {
  const s = await serve({
    '/404': (req, res) => { res.writeHead(404); res.end('x'); },
    '/empty': (req, res) => { res.writeHead(200); res.end(); },
  });
  try {
    const a = await fetchImage(`${s.base}/404`, { allowPrivateForTests: true });
    assert.equal(a.ok, false);
    assert.match(a.message, /返回 404/);

    const b = await fetchImage(`${s.base}/empty`, { allowPrivateForTests: true });
    assert.equal(b.ok, false);
    assert.match(b.message, /空内容/);
  } finally { await s.close(); }
});
