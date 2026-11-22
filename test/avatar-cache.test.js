// 头像本地缓存。
//
// 这条链路的错法都很安静：缓存没写成功 → 模型拿到一个不存在的路径 →
// 发图时才发现（或者干脆发不出去）；TTL 判错 → 每轮都去 qlogo 拉一次，
// 群里刷屏时就是一串公网请求。所以断言盯「请求次数」和「文件真的在」。
//
// 主人 2026-11-16 定的两条规则也是测试重点：
//   · TTL 内同一个 openid 不再下载（哪怕 URL 变了）；
//   · 强制查询（force）必须重新下载。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAvatarCache } from '../src/avatar-cache.js';

/** 一字节的假图，够用来验「落盘内容对不对」 */
const IMG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/**
 * 起一个假图床，返回 { url, hits }。
 *
 * `hits` 是请求计数——缓存是否生效只能靠它判断，光看文件 mtime 看不出
 * 「又下了一次、内容一样」这种情况。
 */
async function fakeImage(t, { type = 'image/jpeg', status = 200, body = IMG } = {}) {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const { port } = srv.address();
  return { url: `http://127.0.0.1:${port}/a.jpg`, hits };
}

const tmpDir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-av-'));
  t.after(() => fsp.rm(d, { recursive: true, force: true }));
  return d;
};

test('头像：首次下载写成本地文件，返回绝对路径', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t);
  const av = createAvatarCache({ dir });

  const p = await av.pathOf({ openid: 'U1', url: img.url });
  assert.equal(path.isAbsolute(p), true, '必须给绝对路径，模型要能直接用');
  assert.equal(p.startsWith(dir), true);
  assert.deepEqual(await fsp.readFile(p), IMG);
  assert.equal(img.hits.length, 1);
});

test('头像：TTL 内不再下载（哪怕 URL 变了）', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t);
  const av = createAvatarCache({ dir, ttlMs: 60_000 });

  const p1 = await av.pathOf({ openid: 'U1', url: img.url });
  /**
   * qlogo 每次下发的 key 都不一样，所以第二条 URL 必然「不同」。
   * 如果实现按 URL 比对，这里就会再下一次——而规则是 TTL 内不更新。
   */
  const p2 = await av.pathOf({ openid: 'U1', url: `${img.url}?key=other` });
  assert.equal(p2, p1);
  assert.equal(img.hits.length, 1, 'TTL 内不该再打图床');
});

test('头像：force 无视 TTL，重新下载', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t);
  const av = createAvatarCache({ dir, ttlMs: 60_000 });

  await av.pathOf({ openid: 'U1', url: img.url });
  await av.pathOf({ openid: 'U1', url: img.url, force: true });
  assert.equal(img.hits.length, 2, 'qq_who 查询要拿最新的');
});

test('头像：过期后自然重新下载', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t);
  /**
   * `ttlMs=0` → 每次都已过期，等价于「等了一天」。
   *
   * 这是整组用例里最尖的一条：`mtimeMs` 带亚毫秒小数，同一毫秒内写完再读，
   * `Date.now() - at` 会是负数，没取整就会被当成「还没过期」。CI 上它曾随机
   * 只打了一次图床（Node 22 过 / Node 24 挂），修法见 `avatar-cache.js` 里
   * `aged` 那段注释。**别把这条改成 ttlMs=1 加 sleep 绕过去**——那等于把
   * 「精确到毫秒」这个语义丢了。
   */
  const av = createAvatarCache({ dir, ttlMs: 0 });

  await av.pathOf({ openid: 'U1', url: img.url });
  await av.pathOf({ openid: 'U1', url: img.url });
  assert.equal(img.hits.length, 2);
});

test('头像：没有新地址时用旧文件（不误清缓存）', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t);
  const av = createAvatarCache({ dir, ttlMs: 60_000 });

  const p1 = await av.pathOf({ openid: 'U1', url: img.url });
  const p2 = await av.pathOf({ openid: 'U1' });
  assert.equal(p2, p1);
  const p3 = await av.pathOf({ openid: 'U1', url: '' });
  assert.equal(p3, p1);
});

test('头像：下载失败又没有旧文件 → 空串，不抛', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t, { status: 403 });
  const av = createAvatarCache({ dir });
  assert.equal(await av.pathOf({ openid: 'U1', url: img.url }), '');
});

test('头像：下载失败但有旧文件 → 退回旧文件', async (t) => {
  const dir = tmpDir(t);
  const ok = await fakeImage(t);
  const av = createAvatarCache({ dir, ttlMs: 60_000 });
  const p1 = await av.pathOf({ openid: 'U1', url: ok.url });

  const bad = await fakeImage(t, { status: 500 });
  const p2 = await av.pathOf({ openid: 'U1', url: bad.url, force: true });
  assert.equal(p2, p1, '拿不到新的就用旧的，别把已有缓存丢了');
});

test('头像：扩展名按 content-type 走（png 不会被存成 jpg）', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t, { type: 'image/png' });
  const av = createAvatarCache({ dir });
  const p = await av.pathOf({ openid: 'U1', url: img.url });
  assert.equal(path.extname(p), '.png');
});

test('头像：没 openid 直接空串（不拿别人的图顶）', async (t) => {
  const dir = tmpDir(t);
  const av = createAvatarCache({ dir });
  assert.equal(await av.pathOf({ openid: '', url: 'http://x/a.jpg' }), '');
});

test('头像：同一个人的并发请求只下载一次', async (t) => {
  const dir = tmpDir(t);
  const img = await fakeImage(t);
  const av = createAvatarCache({ dir });

  const [a, b, c] = await Promise.all([
    av.pathOf({ openid: 'U1', url: img.url }),
    av.pathOf({ openid: 'U1', url: img.url }),
    av.pathOf({ openid: 'U1', url: img.url }),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(img.hits.length, 1, '并发去重没生效');
});

test('头像：换扩展名时旧文件被清掉，目录里只留一份', async (t) => {
  const dir = tmpDir(t);
  const jpg = await fakeImage(t, { type: 'image/jpeg' });
  const png = await fakeImage(t, { type: 'image/png' });
  const av = createAvatarCache({ dir, ttlMs: 60_000 });

  const p1 = await av.pathOf({ openid: 'U1', url: jpg.url });
  const p2 = await av.pathOf({ openid: 'U1', url: png.url, force: true });
  assert.notEqual(p1, p2);
  assert.equal(fs.existsSync(p1), false, '旧格式文件该删掉');

  const names = (await fsp.readdir(dir)).filter((n) => !n.endsWith('.tmp'));
  assert.equal(names.length, 1);
});
