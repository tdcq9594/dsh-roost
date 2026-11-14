/**
 * 聊天图片缓存：下载 → 落盘 → 7 天自动清。
 *
 * 这条链路是**移除 ai-chat 之后仍要独立成立**的：ai-chat 时代图片由它下载，
 * 直连之后由 `roost-payload.js` 的 `collectImages()` 自己抓 QQ 的 URL。
 * 这里用假 `fetchImpl` 把整条路跑通，证明它不依赖任何外部进程——
 * 真机上「别人发的图模型看不见」时，第一个要怀疑的就是这里断了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPayloadBuilder, describeAttachments, isImageAttachment } from '../src/roost-payload.js';

/** 1×1 的合法 PNG：`guessMime` 靠文件头认格式，随便一段字节会被拒 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }); } catch { /* 系统回收 */ } };

/** 每次用独立的 dataDir，别碰用户真实目录 */
function freshDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-imgcache-'));
  process.env.DSH_ROOST_DATA = dir;
  return dir;
}

const evtOf = (n = 1, msgId = 'MSG1') => ({
  chat: { kind: 'group', chatId: 'g1' },
  sender: { openid: 'u1' },
  msgId,
  content: '看图',
  attachments: Array.from({ length: n }, (_, i) => ({
    type: 'image',
    url: `http://img.local/${i + 1}.png`,
    contentType: 'image/png',
  })),
});

test('图片链路：下载 → 落盘 images/ → payload 带 base64，且清掉 7 天前的旧图', async () => {
  const dir = freshDataDir();
  try {
    const imgDir = join(dir, 'images');
    mkdirSync(imgDir, { recursive: true });

    /** 预置一张 8 天前的旧图：sweep 应该把它清掉（保留期 7 天） */
    const stale = join(imgDir, 'old.png');
    writeFileSync(stale, PNG);
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 3600;
    utimesSync(stale, eightDaysAgo, eightDaysAgo);

    let fetches = 0;
    const build = createPayloadBuilder({
      rpc: async () => ({ bucket: 'member', level: '', role: '' }),
      vision: () => true,
      maxImages: () => 2,
      fetchImpl: async (url) => {
        fetches += 1;
        assert.match(url, /^http:\/\/img\.local\//, '必须直接抓附件里的 URL，不经过别的服务');
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => PNG,
        };
      },
    });

    const payload = await build(evtOf(2), { send: async () => ({}) });

    assert.equal(fetches, 2, '两张图各下载一次');
    assert.equal(existsSync(stale), false, '7 天前的旧图要被清掉');

    const files = readdirSync(imgDir).filter((n) => n.startsWith('qq-')).sort();
    assert.equal(files.length, 2, `落盘文件名要用消息 id：${files.join(',')}`);
    assert.deepEqual(files, ['qq-MSG1-1.png', 'qq-MSG1-2.png']);

    /** 内容要对得上（不是写了个空文件） */
    assert.equal(statSync(join(imgDir, files[0])).size, PNG.length);

    /** payload 里要带 base64 给模型看，文本里也要说明有几张图 */
    assert.equal(payload.images.length, 2);
    assert.equal(payload.images[0].mediaType, 'image/png');
    assert.equal(Buffer.from(payload.images[0].data, 'base64').length, PNG.length);
    assert.match(payload.rendered, /图/);
  } finally {
    cleanup(dir);
  }
});

test('图片链路：vision 关掉就一次都不下载，目录里不留任何东西', async () => {
  const dir = freshDataDir();
  try {
    let fetches = 0;
    const build = createPayloadBuilder({
      rpc: async () => ({ bucket: 'member' }),
      vision: () => false,
      maxImages: 4,
      fetchImpl: async () => { fetches += 1; return { ok: false }; },
    });

    const payload = await build(evtOf(3), { send: async () => ({}) });
    assert.equal(fetches, 0, '关了看图就不该产生任何下载');
    assert.deepEqual(payload.images, []);
    /** 目录可能根本没建——建了也不能有图 */
    const imgDir = join(dir, 'images');
    assert.equal(existsSync(imgDir) ? readdirSync(imgDir).length : 0, 0);
  } finally {
    cleanup(dir);
  }
});

test('图片链路：下载失败/非图片都不影响这一轮，消息照样进模型', async () => {
  const dir = freshDataDir();
  try {
    const build = createPayloadBuilder({
      rpc: async () => ({ bucket: 'member' }),
      vision: () => true,
      maxImages: 4,
      fetchImpl: async (url) => {
        /** 第一张 404，第二张返回 HTML（不是图），第三张正常 */
        if (url.endsWith('1.png')) return { ok: false, status: 404, headers: { get: () => '' } };
        if (url.endsWith('2.png')) {
          return { ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>') };
        }
        return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG };
      },
    });

    const payload = await build(evtOf(3), { send: async () => ({}) });
    assert.equal(payload.text, '看图', '图片全挂也不能把正文弄丢');
    assert.equal(payload.images.length, 1, '只有那张真图片进来');
    assert.equal(readdirSync(join(dir, 'images')).filter((n) => n.startsWith('qq-')).length, 1);
  } finally {
    cleanup(dir);
  }
});

/**
 * 2026-11-14 真机：主人发了一张图，模型回「发来一张图，但没取到——可以让对方重发」。
 * 事后用同一个 URL 实测 HTTP 200 / 313888 字节，配置 vision:true，本机复现也能取到，
 * 所以是**偶发下载失败**，而旧代码每张图只 fetch 一次、失败即跳过，没有重试。
 * 下面钉住「可恢复错误重试 / 确定性错误不重试」这条边界。
 */
function retryHarness(fetchImpl, { vision = true } = {}) {
  const dir = freshDataDir();
  const logs = [];
  const build = createPayloadBuilder({
    rpc: async () => ({ bucket: 'member' }),
    vision: () => vision,
    maxImages: 4,
    fetchImpl,
    log: (m) => logs.push(String(m)),
    retryDelayMs: () => 0,
  });
  return { dir, logs, build };
}

const okRes = (buf = PNG, type = 'image/png') => ({
  ok: true, status: 200,
  headers: { get: () => type },
  arrayBuffer: async () => buf,
});

test('网络抖动：第一次连接被重置，第二次成功，图照样进模型', async () => {
  let fetches = 0;
  const h = retryHarness(async () => {
    fetches += 1;
    if (fetches === 1) throw new Error('fetch failed / ECONNRESET');
    return okRes();
  });
  try {
    const p = await h.build(evtOf(1), { send: async () => ({}) });
    assert.equal(fetches, 2, '第一次失败要重试一次');
    assert.equal(p.images.length, 1, '重试成功就不能再说「没取到」');
    assert.match(h.logs.join('\n'), /稍后重试/, '失败要留可查的日志');
    assert.doesNotMatch(p.rendered, /没取到/);
  } finally { cleanup(h.dir); }
});

test('HTTP 5xx 重试，404 / 403 不重试（链接过期重试也没用）', async () => {
  let calls503 = 0;
  const h503 = retryHarness(async () => {
    calls503 += 1;
    return calls503 === 1
      ? { ok: false, status: 503, headers: { get: () => '' } }
      : okRes();
  });
  try {
    const p = await h503.build(evtOf(1), { send: async () => ({}) });
    assert.equal(calls503, 2);
    assert.equal(p.images.length, 1);
  } finally { cleanup(h503.dir); }

  let calls404 = 0;
  const h404 = retryHarness(async () => {
    calls404 += 1;
    return { ok: false, status: 404, headers: { get: () => '' } };
  });
  try {
    await h404.build(evtOf(1), { send: async () => ({}) });
    assert.equal(calls404, 1, '404 是确定性失败，不该白等两轮');
  } finally { cleanup(h404.dir); }
});

test('连续失败到上限就停：不会无限重试拖住这一轮消息', async () => {
  let fetches = 0;
  const h = retryHarness(async () => {
    fetches += 1;
    throw new Error('socket hang up');
  });
  try {
    const p = await h.build(evtOf(1), { send: async () => ({}) });
    assert.equal(fetches, 3, '最多 3 次');
    assert.deepEqual(p.images, []);
    assert.match(describeAttachments(evtOf(1), p.images).join(''), /没取到/, '仍要给模型一句人话说明');
    assert.match(h.logs.join('\n'), /1\/1 张图没取到（已重试 3 次）/, '把失败张数写进日志，别甩锅给用户重发');
  } finally { cleanup(h.dir); }
});

test('确定性失败不重试：非图片格式 / 超大文件只请求一次', async () => {
  let html = 0;
  const h1 = retryHarness(async () => {
    html += 1;
    return okRes(Buffer.from('<html>not an image</html>'), 'text/html');
  });
  try {
    const p = await h1.build(evtOf(1), { send: async () => ({}) });
    assert.equal(html, 1);
    assert.deepEqual(p.images, []);
  } finally { cleanup(h1.dir); }

  let big = 0;
  const h2 = retryHarness(async () => {
    big += 1;
    return okRes(Buffer.alloc(3 * 1024 * 1024, 0xff));
  });
  try {
    const p = await h2.build(evtOf(1), { send: async () => ({}) });
    assert.equal(big, 1, '3MB 的图每次都一样大，重试没有意义');
    assert.deepEqual(p.images, []);
  } finally { cleanup(h2.dir); }
});

test('多张图各自独立重试：一张抖动不影响另一张', async () => {
  const seen = [];
  const h = retryHarness(async (url) => {
    seen.push(url);
    if (url.endsWith('1.png') && seen.filter((x) => x.endsWith('1.png')).length === 1) {
      throw new Error('ETIMEDOUT');
    }
    return okRes();
  });
  try {
    const p = await h.build(evtOf(2), { send: async () => ({}) });
    assert.equal(p.images.length, 2);
    assert.deepEqual(p.images.map((x) => x.index), [0, 1], 'index 要跟 describeAttachments 的计数对齐');
    assert.equal(p.rendered.includes('没取到'), false);
  } finally { cleanup(h.dir); }
});

test('附件判定：图片与「以文件形式发的图」都算，压缩包不算', () => {
  assert.equal(isImageAttachment({ type: 'image', url: 'u' }), true);
  assert.equal(isImageAttachment({ type: 'file', url: 'u', filename: 'a.PNG' }), true);
  assert.equal(isImageAttachment({ type: 'file', url: 'u', filename: 'a.zip' }), false);
  /** 没 url 的一律不下载：没有地址就抓不到 */
  assert.equal(isImageAttachment({ type: 'image', url: '' }), false);
});
