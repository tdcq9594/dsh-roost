/**
 * 3.3/3.4：召回参数化 + 召回预览（dry）。
 *
 * 验收（路线图 §批次3）：
 *   · 召回参数改完之后，同一句话的召回结果**默认应与改之前一致**（默认值取原写死值）；
 *   · 预览不写 access_count（用测试断言）——试一下不等于被想起。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 每个用例独立数据目录：journal 是有状态的 sqlite，共用目录会互相污染 */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-recall-'));
  process.env.DSH_ROOST_DATA = dir;
  return {
    dir,
    done: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch { /* Windows 句柄未释放，系统会自己清 */ }
    },
  };
}

test('3.3：perPath 默认 40；limit 生效；同一句话默认结果与写死时代一致', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    for (let i = 0; i < 30; i++) {
      j.add({ id: `a${i}`, chatId: 'g1', text: `杭州搬家第${i}次提到的细节`, level: 'normal' });
    }
    j.add({ id: 'z', chatId: 'g1', text: '完全不相关的一句话', level: 'normal' });
    /** 不传 perPath = 默认 40，与写死时代逐字一致 */
    const def = await j.search('杭州 搬家', { chatId: 'g1', limit: 5 });
    const p20 = await j.search('杭州 搬家', { chatId: 'g1', limit: 5, perPath: 20 });
    assert.ok(def.length > 0 && def.length <= 5);
    assert.deepEqual(def.map((r) => r.id), p20.map((r) => r.id),
      '候选远多于取数上限时，缩小每路条数不该改变最终前几名');
    assert.ok(def[0].why.includes('关键词'), '命中原因要标得出来');
  } finally {
    done();
  }
});

test('3.4：touch=false 不计访问次数（预览不等于被想起）', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    j.add({ id: 'm1', chatId: 'g1', text: '和张三约好周六去爬山，约定不改', level: 'important' });
    /** 预演：touch=false */
    const dryHits = await j.search('爬山 约好', { chatId: 'g1', limit: 5, touch: false });
    assert.ok(dryHits.some((r) => r.id === 'm1'), '预演也要真命中，否则测的是空气');
    const dry = j.get('m1');
    assert.equal(dry.accessed ?? 0, 0, '预演不该写 access_count');
    /** 正式检索：照旧计数 */
    await j.search('爬山 约好', { chatId: 'g1', limit: 5 });
    const real = j.get('m1');
    assert.equal(real.accessed ?? 0, 1, '正式检索照旧计一次访问');
  } finally {
    done();
  }
});

test('3.4：entityNames 让命中原因标出「从谁联想来」', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    /** 正文不含「张三」字面，只能靠实体路拉进来 */
    j.add({ id: 'm2', chatId: 'g1', text: '他把方案改到第三版了', level: 'normal' });
    const names = new Map([['m2', '张三']]);
    const rows = await j.search('方案', { chatId: 'g1', limit: 5, entityNames: names });
    const hit = rows.find((r) => r.id === 'm2');
    assert.ok(hit, '实体路该把这条拉进来');
    assert.ok(hit.why.includes('张三'), `命中原因要带实体名：${hit.why}`);
    assert.ok(hit.why.includes('联想'), '原因要说清是联想来的');
  } finally {
    done();
  }
});

test('3.3：config.recall 默认值 = 原写死值（升级前后行为一致）', async () => {
  const { DEFAULTS } = await import('../src/config.js');
  assert.equal(DEFAULTS.recall.perPath, 40);
  assert.equal(DEFAULTS.recall.entityLimit, 40);
  assert.equal(DEFAULTS.recall.linkLimit, 5);
  assert.equal(DEFAULTS.recall.residentMax, 600);
  assert.equal(DEFAULTS.recall.deepMax, 1200);
  assert.equal(DEFAULTS.recall.dynMax, 480);
});

test('时间定位：journal.search 的 from/to 只收范围内的日记，不传就全收', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const DAY = 86_400_000;
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    j.add({ id: 'old', chatId: 'g1', text: '上个月搬家到杭州', at: NOW - 40 * DAY });
    j.add({ id: 'new', chatId: 'g1', text: '最近搬家到杭州', at: NOW - 2 * DAY });

    /** 不传时间窗：两条都在（逐字等价于改之前） */
    const all = await j.search('杭州 搬家', { chatId: 'g1', limit: 5 });
    assert.deepEqual(new Set(all.map((r) => r.id)), new Set(['old', 'new']));

    /** 只收最近 7 天：过滤掉 40 天前那条 */
    const recent = await j.search('杭州 搬家', {
      chatId: 'g1', limit: 5, from: NOW - 7 * DAY, to: NOW + DAY,
    });
    assert.deepEqual(recent.map((r) => r.id), ['new']);

    /** 只收 30~50 天前：只留旧那条 */
    const older = await j.search('杭州 搬家', {
      chatId: 'g1', limit: 5, from: NOW - 50 * DAY, to: NOW - 30 * DAY,
    });
    assert.deepEqual(older.map((r) => r.id), ['old']);

    /** 只传一边不算数，避免手滑把范围搜飞 */
    const half = await j.search('杭州 搬家', { chatId: 'g1', limit: 5, from: NOW - 7 * DAY });
    assert.deepEqual(new Set(half.map((r) => r.id)), new Set(['old', 'new']));
  } finally {
    done();
  }
});

test('时间窗必须在 LIMIT 之前生效：热门词命中 >perPath 也不漏掉窗内老日记', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
  const DAY = 86_400_000;
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    /** 50 条近期"杭州"（把 perPath=5 的候选占满）+ 1 条 40 天前的老日记 */
    for (let i = 0; i < 50; i++) {
      j.add({ id: `recent${i}`, chatId: 'g1', text: `杭州今天的新闻${i}`, at: NOW - i * 60_000 });
    }
    j.add({ id: 'old', chatId: 'g1', text: '杭州那次搬家', at: NOW - 40 * DAY });

    /** 只找 45~30 天前：只能命中 old。若窗口在 LIMIT 之后才过滤，这里会是 []。 */
    const r = await j.search('杭州', {
      chatId: 'g1', limit: 5, perPath: 5, from: NOW - 45 * DAY, to: NOW - 30 * DAY,
    });
    assert.deepEqual(r.map((x) => x.id), ['old'], '窗口要下推到 SQL，不能被近期 50 条挤掉');
  } finally {
    done();
  }
});

test('A3 撤回级联：activeIds 只留未失效的日记 id，失效的行不回召回', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    j.add({ id: 'old-saying', chatId: 'g1', text: '他住在杭州' });
    j.add({ id: 'new-saying', chatId: 'g1', text: '他搬到上海了' });
    j.add({ id: 'neutral', chatId: 'g1', text: '无关的事' });

    assert.deepEqual(
      j.activeIds(['old-saying', 'new-saying', 'neutral', 'not-exist']),
      ['old-saying', 'new-saying', 'neutral'],
      '未失效的都留下，不存在的去掉',
    );

    /** 改口：旧说法被作废 */
    j.invalidate(['old-saying'], { at: Date.now(), supersededBy: 'new-saying' });
    assert.deepEqual(
      j.activeIds(['old-saying', 'new-saying', 'neutral']),
      ['new-saying', 'neutral'],
      '作废的那条不再"活动"——图谱联想拿到它也会被滤掉',
    );
    assert.equal(j.get('old-saying').supersededBy, 'new-saying', '溯源仍在');
    assert.equal(j.get('old-saying').text, '他住在杭州', '原文不删');
  } finally {
    done();
  }
});

test('A3 接线：图谱联想（一跳/二跳）都经过 activeIds 过滤', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const filtered = (host.match(/journal\.activeIds\(/g) || []).length;
  assert.ok(filtered >= 2, `一跳和二跳都要过滤失效日记，实际 ${filtered} 处`);
  assert.match(host, /A3 撤回级联/, '要有说明为什么过滤');
});

test('C1 时间臂：关键词不匹配时，窗内日记仍作为"那段时间"候选进来', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
  const DAY = 86_400_000;
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    /** 窗内一条，但文本完全不含查询词"烧烤" */
    j.add({ id: 'in-window', chatId: 'g1', text: '上周去看了场电影', at: NOW - 3 * DAY });
    j.add({ id: 'out-window', chatId: 'g1', text: '烧烤真好吃', at: NOW - 60 * DAY });

    const r = await j.search('烧烤', {
      chatId: 'g1', limit: 5, from: NOW - 7 * DAY, to: NOW + DAY,
    });
    assert.ok(r.some((x) => x.id === 'in-window'), '时间臂要把窗内日记带进来');
    assert.ok(r.find((x) => x.id === 'in-window').why.includes('那段时间'), '命中原因要标出来');
    assert.ok(!r.some((x) => x.id === 'out-window'), '窗外那条不该回来');

    /** 没有时间词时，时间臂不跑：关键词只捞到窗外那条 */
    const plain = await j.search('烧烤', { chatId: 'g1', limit: 5 });
    assert.deepEqual(plain.map((x) => x.id), ['out-window'], '无时间窗时行为不变');
  } finally {
    done();
  }
});

test('C2 interleave：显式打开时每路保底一条；默认关时名次不变', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();
  const DAY = 86_400_000;
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    /** 三条都在窗内；关键词只命中前两条，时间臂还能捞到第三条 */
    j.add({ id: 'kw1', chatId: 'g1', text: '咖啡很好喝', at: NOW - 2 * DAY });
    j.add({ id: 'kw2', chatId: 'g1', text: '咖啡和茶', at: NOW - 3 * DAY });
    j.add({ id: 'time1', chatId: 'g1', text: '上周看了电影', at: NOW - 1 * DAY });
    const opts = { chatId: 'g1', limit: 2, from: NOW - 7 * DAY, to: NOW + DAY };

    /** 默认关：只有关键词两条，时间臂那条被挤掉 */
    const plain = await j.search('咖啡', opts);
    assert.deepEqual(plain.map((x) => x.id).sort(), ['kw1', 'kw2']);

    /** 打开：时间臂保底进 top-2 */
    const mixed = await j.search('咖啡', { ...opts, interleave: true });
    assert.ok(mixed.some((x) => x.id === 'time1'), '弱路要保底一条');
    assert.ok(mixed.find((x) => x.id === 'time1').why.includes('保底'));
  } finally {
    done();
  }
});

test('自检-C2：interleave 被挤掉的条目不会被下一路重新捞回', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  const NOW = Date.now();
  const DAY = 86_400_000;
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    j.add({ id: 'kw1', chatId: 'g1', text: '咖啡一杯', at: NOW - DAY });
    j.add({ id: 'kw2', chatId: 'g1', text: '咖啡两杯', at: NOW - 2 * DAY });
    j.add({ id: 'time1', chatId: 'g1', text: '那天看了电影', at: NOW - 3 * DAY });
    const r = await j.search('咖啡', {
      chatId: 'g1', limit: 2, from: NOW - 7 * DAY, to: NOW + DAY, interleave: true,
    });
    const ids = r.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length, '不能重复捞回刚被挤掉的条目');
    assert.equal(ids.length, 2);
  } finally {
    done();
  }
});

test('C4 维度校验：换模型后不同维度的旧向量不参与检索', async () => {
  const { done } = fresh();
  const { createJournal } = await import('../src/journal.js');
  try {
    const j = createJournal({ file: join(process.env.DSH_ROOST_DATA, 'journal.sqlite') });
    j.add({ id: 'a', chatId: 'g1', text: '杭州搬家' });
    j.add({ id: 'b', chatId: 'g1', text: '上海搬家' });
    /** 给 a 一个 3 维向量、b 一个 4 维向量（模拟换模型前后） */
    j.setVec('a', [0.6, 0.8, 0]);
    j.setVec('b', [0.5, 0.5, 0.5, 0.5]);
    const only3 = j.withVec({ chatId: 'g1', dim: 3 });
    assert.deepEqual(only3.map((r) => r.id), ['a'], '只取 3 维的');
    const only4 = j.withVec({ chatId: 'g1', dim: 4 });
    assert.deepEqual(only4.map((r) => r.id), ['b'], '只取 4 维的');
    const all = j.withVec({ chatId: 'g1' });
    assert.equal(all.length, 2, '不传 dim 时都返回（老行为）');
  } finally {
    done();
  }
});
