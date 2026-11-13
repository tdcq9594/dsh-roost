/**
 * 3.3/3.4：召回参数化 + 召回预览（dry）。
 *
 * 验收（路线图 §批次3）：
 *   · 召回参数改完之后，同一句话的召回结果**默认应与改之前一致**（默认值取原写死值）；
 *   · 预览不写 access_count（用测试断言）——试一下不等于被想起。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
