/**
 * 扩展只读一组（日记 / 用量 / 自我表达 / 表情库）
 *
 * 守的是「只读也不该漏」：这一组不改变任何状态，所以真正的风险是
 * **泄得太多**——绝对路径、整份日记原文、密钥。用例逐条盯这些。
 *
 * 跑法：node --test test/ext-observe.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  createExtObserve, JOURNAL_CLIP, MAX_JOURNAL_ROWS, MAX_STICKER_ROWS, MAX_STICKER_BYTES,
  MAX_CHAT_ID,
} from '../src/ext-observe.js';

const DIRS = [];
function tmpDir() {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-observe-'));
  DIRS.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  }
});

const journalRow = (id, text, extra = {}) => ({ id, at: 100, level: 'chat', text, ...extra });

function build({ journal, usage, stickers, cfg, history, throwOn = '' } = {}) {
  return createExtObserve({
    journalOf: () => journal ?? {
      backend: () => 'sqlite',
      recent: () => [],
      search: async () => [],
      digests: () => [],
    },
    usageOf: () => usage ?? { summary: () => ({ total: 0 }) },
    stickersOf: () => stickers ?? { snapshot: () => ({ roots: [], items: [], cats: [], missing: [] }) },
    cfgOf: () => cfg ?? {},
    selfHistoryOf: () => history ?? { read: () => [] },
    aliasesOf: () => [],
    ...(throwOn ? {} : {}),
  });
}

/* ── journal ─────────────────────────────────────────────────────────── */

test('J1 journal：没有 q 走 recent，带 limit 与 chatId', async () => {
  const seen = [];
  const api = build({
    journal: {
      backend: () => 'sqlite',
      recent: (chatId, n) => { seen.push({ chatId, n }); return [journalRow('j1', '今天很开心')]; },
      search: async () => [],
      digests: () => [],
    },
  });
  const r = await api['journal.read']({ query: { chatId: 'g1', limit: '5' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.backend, 'sqlite');
  assert.deepEqual(seen, [{ chatId: 'g1', n: 5 }]);
  assert.equal(r.body.items[0].text, '今天很开心');
});

test('J2 journal：有 q 走全文检索，带 score / why', async () => {
  const api = build({
    journal: {
      backend: () => 'fts',
      recent: () => [],
      search: async (q) => [{ id: 'j1', at: 9, level: 'chat', text: `${q} 的结果`, score: 0.5, why: 'bm25', digest: '摘要' }],
      digests: () => [],
    },
  });
  const r = await api['journal.read']({ query: { q: '猫', chatId: 'g1' } });
  assert.equal(r.body.q, '猫');
  assert.equal(r.body.items[0].score, 0.5);
  assert.equal(r.body.items[0].why, 'bm25');
});

test('J3 journal：正文按码点截断，超长不整篇塞给扩展', async () => {
  const long = '啊'.repeat(JOURNAL_CLIP + 100);
  const api = build({
    journal: {
      backend: () => 'sqlite',
      recent: () => [journalRow('j1', long)],
      search: async () => [],
      digests: () => [],
    },
  });
  const r = await api['journal.read']({ query: {} });
  assert.equal(Array.from(r.body.items[0].text).length, JOURNAL_CLIP + 1, '截断后加一个省略号');
  assert.ok(r.body.items[0].text.endsWith('…'));
});

test('J4 journal：limit 夹在 1–上限之间；digests=1 才带摘要', async () => {
  const seen = [];
  const api = build({
    journal: {
      backend: () => 'sqlite',
      recent: (c, n) => { seen.push(n); return []; },
      search: async () => [],
      digests: () => [{ at: 1, text: '一周摘要' }],
    },
  });
  await api['journal.read']({ query: { limit: '99999' } });
  /** `0` 是「没给」，退回默认 20（和面板 `/journal` 同一套夹紧公式） */
  await api['journal.read']({ query: { limit: '0' } });
  /** 负数才是「给了但不合法」，夹到下限 1 */
  await api['journal.read']({ query: { limit: '-5' } });
  assert.deepEqual(seen, [MAX_JOURNAL_ROWS, 20, 1]);

  const withD = await api['journal.read']({ query: { digests: '1' } });
  assert.equal(withD.body.digests.length, 1);
  const without = await api['journal.read']({ query: {} });
  assert.equal(without.body.digests, undefined);
});

test('J5 journal：底层抛错回 500，不假装没日记', async () => {
  const api = build({
    journal: {
      backend: () => 'sqlite',
      recent: () => { throw new Error('库锁住了'); },
      search: async () => [],
      digests: () => [],
    },
  });
  const r = await api['journal.read']({ query: {} });
  assert.equal(r.status, 500);
  assert.match(r.body.message, /读日记失败/);
});

/* ── usage ───────────────────────────────────────────────────────────── */

test('J6 journal：chatId 超长要报错，不能截短了读另一个群', async () => {
  const api = build();
  const long = 'g'.repeat(MAX_CHAT_ID + 1);
  assert.equal((await api['journal.read']({ query: { chatId: long } })).status, 400);
});

test('U1 usage：days 夹在 1–90，pricing 从配置读', async () => {
  const got = [];
  const api = build({
    usage: { summary: (o) => { got.push(o); return { total: 3, cost: 1.5 }; } },
    cfg: { usage: { pricing: { in: 1, out: 2 } } },
  });
  const r = await api['usage.read']({ query: { days: '999' } });
  assert.equal(r.body.days, 90);
  assert.equal(r.body.total, 3);
  assert.deepEqual(got[0].pricing, { in: 1, out: 2 });

  await api['usage.read']({ query: { days: '0' } });
  assert.equal(got[1].days, 7, '0 是「没给」，退回默认 7（和面板 /usage 一致）');
  await api['usage.read']({ query: { days: '-3' } });
  assert.equal(got[2].days, 1, '负数夹到下限 1');
  await api['usage.read']({ query: {} });
  assert.equal(got[3].days, 7);
});

/* ── self ────────────────────────────────────────────────────────────── */

test('S1 self：给归一后的 selfExpression + 最近历史（新的在前）', async () => {
  const api = build({
    cfg: { selfExpression: { name: { enabled: true }, avatar: { anyPath: false } } },
    history: { read: () => [{ kind: 'name', at: 1 }, { kind: 'sign', at: 2 }] },
  });
  const r = await api['self.read']();
  assert.equal(r.status, 200);
  assert.equal(r.body.cfg.avatar.anyPath, false);
  assert.equal(r.body.history[0].kind, 'sign', '最近改的在最前');
});

test('S2 self：历史读不到不影响当前值', async () => {
  const api = build({
    cfg: { selfExpression: {} },
    history: { read: () => { throw new Error('文件坏了'); } },
  });
  const r = await api['self.read']();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.history, []);
});

/* ── stickers ────────────────────────────────────────────────────────── */

test('K1 stickers：列表**不给绝对路径**（path / root 一律不出现）', async () => {
  const api = build({
    stickers: {
      snapshot: () => ({
        roots: ['/home/user/表情'],
        items: [{ file: 'a.png', path: '/home/user/表情/开心/a.png', rel: '开心/a.png', cat: '开心', root: '/home/user/表情', tags: ['开心'], size: 12 }],
        cats: ['开心'],
        missing: [],
      }),
    },
  });
  const r = await api['stickers.list']({ query: {} });
  assert.equal(r.status, 200);
  const it = r.body.items[0];
  assert.equal(it.rel, '开心/a.png');
  assert.equal(it.path, undefined, '绝对路径不该给扩展');
  assert.equal(it.root, undefined);
  assert.ok(!JSON.stringify(r.body).includes('/home/user'), '整份响应里都不能出现家目录');
});

test('K2 stickers：q / category 过滤与 limit 夹紧', async () => {
  const items = [
    { file: '开心1.png', rel: '开心/开心1.png', cat: '开心', tags: ['开心'], size: 1 },
    { file: '伤心1.png', rel: '伤心/伤心1.png', cat: '伤心', tags: [], size: 1 },
  ];
  const api = build({ stickers: { snapshot: () => ({ roots: [], items, cats: ['开心', '伤心'], missing: [] }) } });

  assert.deepEqual((await api['stickers.list']({ query: { category: '开心' } })).body.items.map((x) => x.rel), ['开心/开心1.png']);
  assert.deepEqual((await api['stickers.list']({ query: { q: '伤心' } })).body.items.map((x) => x.rel), ['伤心/伤心1.png']);
  const many = Array.from({ length: MAX_STICKER_ROWS + 10 }, (_, i) => ({ file: `f${i}.png`, rel: `f${i}.png`, cat: '', tags: [], size: 1 }));
  const capped = await api['stickers.list']({ query: { limit: '99999' } });
  assert.ok(capped.body.items.length <= MAX_STICKER_ROWS);
  assert.equal(capped.body.total, items.length, 'total 是库里的总数');
  assert.equal(capped.body.matched, items.length, 'matched 是这次筛选命中的数');
  assert.ok(many.length > MAX_STICKER_ROWS);
});

test('K3 stickers：打不开的目录要单独报出来', async () => {
  const api = build({
    stickers: { snapshot: () => ({ roots: [], items: [], cats: [], missing: ['D:\\没了'] }) },
  });
  const r = await api['stickers.list']({ query: {} });
  assert.deepEqual(r.body.missing, ['D:\\没了'], '只回「0 张」看不出是路径错还是真没图');
});

test('K4 stickers/file：缺 path 400；找不到 404；越界路径由 locate 挡', async () => {
  const root = tmpDir();
  const api = build({ stickers: { snapshot: () => ({ roots: [root], items: [], cats: [], missing: [] }) } });

  assert.equal((await api['stickers.file']({ query: {} })).status, 400);

  const miss = await api['stickers.file']({ query: { path: 'nope.png' } });
  assert.equal(miss.status, 404);
  assert.equal(miss.body.error, 'not_found');

  /** 三层路径 / `..` 都不该被放行 */
  assert.equal((await api['stickers.file']({ query: { path: 'a/b/c.png' } })).status, 404);
  assert.equal((await api['stickers.file']({ query: { path: '../../etc/passwd' } })).status, 404);
});

test('K5 stickers/file：成功时给 base64 + MIME', async () => {
  const root = tmpDir();
  fs.mkdirSync(join(root, '开心'));
  fs.writeFileSync(join(root, '开心', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const api = build({ stickers: { snapshot: () => ({ roots: [root], items: [], cats: [], missing: [] }) } });
  const r = await api['stickers.file']({ query: { path: '开心/a.png' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.contentType, 'image/png');
  assert.equal(r.body.bytes, 4);
  assert.equal(Buffer.from(r.body.data, 'base64').toString('hex'), '89504e47');
  assert.ok(MAX_STICKER_BYTES > 1024 * 1024, '上限至少得装得下普通表情');
});

test('K6 stickers：快照抛错回 500，不假装空库', async () => {
  const api = build({ stickers: { snapshot: () => { throw new Error('盘符不存在'); } } });
  const r = await api['stickers.list']({ query: {} });
  assert.equal(r.status, 500);
  assert.match(r.body.message, /读表情库失败/);
});

test('K7 构造时缺依赖要立刻炸', () => {
  assert.throws(() => createExtObserve({}), /journalOf/);
  assert.throws(() => createExtObserve({ journalOf: () => ({}) }), /stickersOf/);
});
