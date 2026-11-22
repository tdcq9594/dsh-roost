// 「让 AI 看一眼」：解析模型回答 + 跑增量任务。
//
// 这里最贵的错误是「解析失败」——一次假失败就是白花一次视觉调用。
// 所以解析要宽容：代码块包裹、前后加废话、tags 写成字符串，都得认。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDescribe, createOrganizeJob, mediaTypeOf, imageForVision, onlyFilled } from '../src/gallery-organize.js';

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

/**
 * 「全部重做」会覆盖已有标注，而提示词允许模型「看不出来就留空」。
 * 不把空字段挡掉的话，一次重做就能把用户手写的含义、场合清空——比不整理更糟。
 */
test('onlyFilled 丢掉空字段，不拿空字符串覆盖已有标注', () => {
  assert.deepEqual(
    onlyFilled({ name: '猫', meaning: '', scenes: '', avoid: '', tags: [] }),
    { name: '猫' },
    '只看得出名字时，不能把其它字段清空',
  );
  assert.deepEqual(onlyFilled({ meaning: '笑', tags: ['笑', '猫'] }), { meaning: '笑', tags: ['笑', '猫'] });
  assert.deepEqual(onlyFilled({}), {});
  assert.deepEqual(onlyFilled(null), {});
  assert.deepEqual(onlyFilled('乱传'), {});
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

test('任务：成功一张就更新 last，面板能显示「刚起好 xxx」', async () => {
  const job = createOrganizeJob({
    items: [{ seq: 7, path: '/a.png', file: 'a.png' }],
    worker: async () => ({ name: '猫猫无语' }),
    apply: () => {},
  });
  await job.start();
  const p = job.progress();
  assert.match(p.last, /#7/, '要带序号，面板才知道是哪一张');
  assert.match(p.last, /猫猫无语/);
});

test('任务：只有描述没短名时 last 退回描述并截断', async () => {
  const job = createOrganizeJob({
    items: [{ seq: 9 }],
    worker: async () => ({ meaning: '一只很大的橘猫趴在键盘上不肯走开' }),
    apply: () => {},
  });
  await job.start();
  const p = job.progress();
  assert.match(p.last, /#9/);
  assert.ok([...p.last].length <= 20, '一条进度不能吃掉整行');
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

test('任务：跳过的也算走完，percent 必须到 100', async () => {
  /**
   * 只按 `done` 算的话，跳过 3 张成功 7 张会停在 70% 就结束，
   * 面板看着像没跑完——用户会反复点「整理」。
   */
  const items = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1 }));
  const job = createOrganizeJob({
    items,
    worker: async (it) => {
      if (it.seq <= 3) throw new Error('看不了这张');
      return { name: `图${it.seq}` };
    },
    apply: () => {},
    concurrency: 1,
    maxStreak: 99,
  });
  await job.start();
  const p = job.progress();
  assert.equal(p.done, 7);
  assert.equal(p.failed, 3);
  assert.equal(p.percent, 100, 'failed 也是处理过的，不能卡在 70%');
});

test('任务：跑完留下人话文案，面板不用自己拼数字', async () => {
  const job = createOrganizeJob({
    items: [{ seq: 1 }, { seq: 2 }],
    worker: async (it) => {
      if (it.seq === 2) throw new Error('图太大');
      return { name: '甲' };
    },
    apply: () => {},
  });
  await job.start();
  assert.match(job.progress().message, /整理完了：补上 1 张，跳过 1 张/);
});

/**
 * 这条是 aurabot 的 `streak` 抄过来的。
 *
 * 为什么必须有：模型看不了图 / 额度用完 / 网络断了时，剩下的一百张只会
 * 一路失败到底，跑成几分钟的假进度，最后也没告诉用户为什么。连续 5 张
 * 就停，并把第一张失败原因写进 message。
 */
test('任务：连续失败 5 张就收手，不再往下烧', async () => {
  const tried = [];
  const job = createOrganizeJob({
    items: Array.from({ length: 20 }, (_, i) => ({ seq: i + 1 })),
    worker: async (it) => {
      tried.push(it.seq);
      throw new Error('当前模型（deepseek-flash）不支持图片输入');
    },
    apply: () => {},
    concurrency: 1,
  });
  await job.start();
  const p = job.progress();
  assert.equal(p.aborted, true, '要标成「不是用户点的停」');
  assert.equal(p.running, false);
  assert.equal(tried.length, 5, '只该试 5 张，第 6 张不该发出去');
  assert.equal(p.failed, 5);
  assert.match(p.message, /连续失败 5 张/);
  assert.match(p.message, /不支持图片/, '原因要带出来，不然用户不知道换模型');
});

test('任务：中间成功一张会重置连续失败计数', async () => {
  const tried = [];
  const job = createOrganizeJob({
    items: Array.from({ length: 9 }, (_, i) => ({ seq: i + 1 })),
    worker: async (it) => {
      tried.push(it.seq);
      /** 1-4 失败、5 成功、6-9 失败：最长连续失败是 4，不该被中止 */
      if (it.seq !== 5) throw new Error('偶发失败');
      return { name: '成功那张' };
    },
    apply: () => {},
    concurrency: 1,
  });
  await job.start();
  const p = job.progress();
  assert.equal(p.aborted, false);
  assert.equal(tried.length, 9, '没到 5 连败就该跑完全部');
  assert.equal(p.done, 1);
  assert.equal(p.failed, 8);
});

test('任务：cancel 也写文案，说清停在哪', async () => {
  const job = createOrganizeJob({
    items: [{ seq: 1 }, { seq: 2 }],
    worker: async (it) => {
      if (it.seq === 1) job.cancel();
      return { name: '甲' };
    },
    apply: () => {},
    concurrency: 1,
  });
  await job.start();
  const p = job.progress();
  assert.equal(p.cancelled, true);
  assert.match(p.message, /停在/);
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
