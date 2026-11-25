// 超大图压缩：失败面必须全部收敛成 null，不能把这一轮聊天弄挂。
//
// 正常压缩要真 ffmpeg（CI 上没装，装不装取决于用户选的功能包），所以这里只钉
// 「不压 / 压不了」的几条确定性路径；正常路径由 image-cache.test.js 用注入实现覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { shrinkImage } from '../src/image-compress.js';

const MB = 1024 * 1024;
const big = Buffer.alloc(6 * MB, 0xff);

test('没装 ffmpeg：返回 null，不抛（调用方据此告诉模型「图太大」）', async () => {
  let asked = 0;
  const r = await shrinkImage({ buf: big, ffmpeg: () => { asked += 1; return ''; } });
  assert.equal(r, null);
  assert.equal(asked, 1, '每次超限都现问一次，用户装完不用重启');
});

test('没超过上限：根本不去找 ffmpeg', async () => {
  let asked = 0;
  const r = await shrinkImage({ buf: Buffer.alloc(1024), ffmpeg: () => { asked += 1; return 'x'; } });
  assert.equal(r, null);
  assert.equal(asked, 0);
});

test('gif 不压：压成 jpeg 会丢动画，宁可请对方重发', async () => {
  let asked = 0;
  const r = await shrinkImage({ buf: big, mime: 'image/gif', ffmpeg: () => { asked += 1; return 'x'; } });
  assert.equal(r, null);
  assert.equal(asked, 0);
});

test('exe 不存在 / spawn 失败：按 null 收敛，不冒泡', async () => {
  const r = await shrinkImage({
    buf: big,
    ffmpeg: () => join(tmpdir(), 'roost-no-such-ffmpeg.exe'),
  });
  assert.equal(r, null);
});

test('不是 Buffer：直接 null', async () => {
  assert.equal(await shrinkImage({ buf: 'not-a-buffer', ffmpeg: () => 'x' }), null);
  assert.equal(await shrinkImage({ ffmpeg: () => 'x' }), null);
});

test('目标上限可调：上限比图大就不压', async () => {
  let asked = 0;
  const r = await shrinkImage({
    buf: Buffer.alloc(2 * MB),
    maxBytes: 5 * MB,
    ffmpeg: () => { asked += 1; return 'x'; },
  });
  assert.equal(r, null);
  assert.equal(asked, 0);
});
