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

import { createPayloadBuilder, isImageAttachment } from '../src/roost-payload.js';

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

test('附件判定：图片与「以文件形式发的图」都算，压缩包不算', () => {
  assert.equal(isImageAttachment({ type: 'image', url: 'u' }), true);
  assert.equal(isImageAttachment({ type: 'file', url: 'u', filename: 'a.PNG' }), true);
  assert.equal(isImageAttachment({ type: 'file', url: 'u', filename: 'a.zip' }), false);
  /** 没 url 的一律不下载：没有地址就抓不到 */
  assert.equal(isImageAttachment({ type: 'image', url: '' }), false);
});
