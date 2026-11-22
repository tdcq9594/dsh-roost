// 「让 AI 看一眼」：解析模型回答 + 跑增量任务。
//
// 这里最贵的错误是「解析失败」——一次假失败就是白花一次视觉调用。
// 所以解析要宽容：代码块包裹、前后加废话、tags 写成字符串，都得认。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDescribe, createOrganizeJob, mediaTypeOf, imageForVision } from '../src/gallery-organize.js';

test('parseDescribe 认标准 JSON', () => {
  const r = parseDescribe('{"name":"熊猫大笑","meaning":"笑得很夸张","scenes":"接梗","avoid":"正事","tags":["笑","熊猫"]}');
  assert.deepEqual(r, {
    name: '熊猫大笑', meaning: '笑得很夸张', scenes: '接梗', avoid: '正事', tags: ['笑', '熊猫'],
  });
});

test('parseDescribe 剥掉 ```json 包裹与前后废话', () => {
  const withFence = '```json\n{"name":"猫","meaning":"无语"}\n```';
  assert.equal(parseDescribe(withFence).name, '猫');

  const chatty = '好的，我看了一下：{"name":"猫","meaning":"无语"} 就这样。';
  assert.equal(parseDescribe(chatty).name, '猫');
});

test('parseDescribe 把 tags 字符串拆成数组，最多 4 个', () => {
  const r = parseDescribe('{"name":"x","tags":"笑、熊猫, 猫 狗"}');
  assert.deepEqual(r.tags, ['笑', '熊猫', '猫', '狗']);
});

test('parseDescribe 对全空回答返回 null（不写空标注）', () => {
  assert.equal(parseDescribe('{"name":"","meaning":"","tags":[]}'), null);
  assert.equal(parseDescribe(''), null);
  assert.equal(parseDescribe('   '), null);
});

test('parseDescribe 对坏 JSON 返回 null 而不是抛', () => {
  assert.equal(parseDescribe('{"name":'), null);
  assert.equal(parseDescribe('这不是 JSON'), null);
});

test('parseDescribe 截断超长字段（模型偶尔会写小作文）', () => {
  const long = '一'.repeat(200);
  const r = parseDescribe(JSON.stringify({ name: long, meaning: long, scenes: long, avoid: long }));
  assert.equal([...r.name].length, 20);
  assert.equal([...r.meaning].length, 80);
  assert.equal([...r.scenes].length, 60);
  assert.equal([...r.avoid].length, 40);
});

test('mediaTypeOf 认常见图片扩展名，猜不出按 jpeg', () => {
  assert.equal(mediaTypeOf('a.PNG'), 'image/png');
  assert.equal(mediaTypeOf('a.gif'), 'image/gif');
  assert.equal(mediaTypeOf('a.webp'), 'image/webp');
  assert.equal(mediaTypeOf('a.jpg'), 'image/jpeg');
  assert.equal(mediaTypeOf('a.unknown'), 'image/jpeg');
});

test('任务：每张成功都写回去，进度到 100%', async () => {
  const applied = [];
  const job = createOrganizeJob({
    items: [{ seq: 1, path: '/a.png', file: 'a.png' }, { seq: 2, path: '/b.png', file: 'b.png' }],
    worker: async (it) => ({ name: `图${it.seq}` }),
    apply: (seq, patch) => applied.push([seq, patch]),
  });
  await job.start();
  const p = job.progress();
  assert.equal(p.done, 2);
  assert.equal(p.failed, 0);
  assert.equal(p.running, false);
  assert.equal(p.percent, 100);
  assert.deepEqual(applied, [[1, { name: '图1' }], [2, { name: '图2' }]]);
});

test('任务：一张失败不影响后面，失败原因带序号', async () => {
  const applied = [];
  const logs = [];
  const job = createOrganizeJob({
    items: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    worker: async (it) => {
      if (it.seq === 2) throw new Error('图太大');
      return { name: `图${it.seq}` };
    },
    apply: (seq, patch) => applied.push([seq, patch]),
    log: (m) => logs.push(m),
  });
  await job.start();
  const p = job.progress();
  assert.equal(p.done, 2);
  assert.equal(p.failed, 1);
  assert.equal(p.errors[0].seq, 2);
  assert.match(p.errors[0].reason, /图太大/);
  assert.equal(applied.length, 2, '失败的不能写回去');
  assert.ok(logs.some((m) => m.includes('#2')));
});

test('任务：cancel 之后不再处理后面的', async () => {
  const applied = [];
  const job = createOrganizeJob({
    items: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
    worker: async (it) => {
      if (it.seq === 1) job.cancel();
      return { name: `图${it.seq}` };
    },
    apply: (seq) => applied.push(seq),
    concurrency: 1,
  });
  await job.start();
  assert.deepEqual(applied, [], '取消后连第一张也不写');
  assert.equal(job.progress().running, false);
});

test('任务：空列表立刻结束，percent 是 100 不是 0', async () => {
  const job = createOrganizeJob({ items: [], worker: async () => ({}), apply: () => {} });
  await job.start();
  const p = job.progress();
  assert.equal(p.running, false);
  assert.equal(p.percent, 100);
});

test('imageForVision 超限直接报「图太大」，不是含糊的「没有可用图片」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-vision-'));
  try {
    const big = join(dir, 'big.png');
    /** 400KB base64 上限 ≈ 300KB 原始字节 */
    writeFileSync(big, Buffer.alloc(320 * 1024, 1));
    assert.throws(() => imageForVision(big), /图太大/);

    const ok = join(dir, 'ok.png');
    writeFileSync(ok, Buffer.from('tiny'));
    const r = imageForVision(ok);
    assert.equal(r.mediaType, 'image/png');
    assert.ok(r.data.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
