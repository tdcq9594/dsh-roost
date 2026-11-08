// D11 retention 的数据层接口：精确作废 / 一键恢复 / 真删
//
// 这一层最怕两件事：
//  · 误伤——「约定：A」和「约定：A 补充」长得像，关键词匹配会把两条都办了；
//  · 恢复过头——「被新说法取代」的历史也打着 `until`，一键恢复不能把它放回来。
// 两个后端（SQLite / JSONL）都得同口径，否则回落到 JSONL 的用户恢复不了。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory, W_EXPLICIT } from '../src/memory.js';
import { createJournal } from '../src/journal.js';
import { normalizeEntry, planRetentionAll } from '../src/dry-run.js';

const DAY = 86400000;
const noop = () => {};

function freshData() {
  const d = mkdtempSync(join(tmpdir(), 'roost-ret-m-'));
  process.env.DSH_ROOST_DATA = d;
  return d;
}

function journalRig(t, forceJsonl = false) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ret-j-'));
  const file = join(dir, 'j.sqlite');
  /** 库路径本身是个目录 → SQLite 打不开 → 回落 `<同名>.jsonl`，父目录仍可写 */
  if (forceJsonl) mkdirSync(file);
  const j = createJournal({ file, log: noop });
  t.after(() => {
    try { j.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } catch {}
  });
  return j;
}

test('retention：facts 只作废点名的条目，相似正文与高权重条目不受影响', () => {
  const dir = freshData();
  const m = createMemory();
  const OLD = Date.now() - 200 * DAY;
  m.add('', '约定：周末不排会', 'global', { at: OLD });
  m.add('', '约定：周末不排会（补充）', 'global', { at: OLD });
  m.add('', '主人住在杭州', 'global', { w: W_EXPLICIT, at: OLD });
  m.add('g1', '这个群管阿离叫小离', 'chat', { at: OLD });

  const entries = m.retention.entries();
  assert.equal(entries.length, 4);
  const plan = planRetentionAll(
    { facts: entries.map((e) => normalizeEntry(e, 'facts', e.chatId)), journal: [] },
    { factsMode: 'expire', journalMode: 'off', thresholdPct: 5, minProtectDays: 0 },
  );
  assert.equal(plan.facts.affected, 3,
    '两条 global 自动提炼 + 一条 chat 自动提炼命中；w=2 的用户明说记住不碰');
  assert.deepEqual(
    plan.facts.items.map((x) => x.id).sort(),
    ['约定：周末不排会', '约定：周末不排会（补充）', '这个群管阿离叫小离'].sort(),
    '相似的两条都该各自精确命中，不因关键词相近被合并/漏掉',
  );
  assert.ok(plan.facts.items.some((x) => x.scope === 'chat'), 'chat 层的条目要带上作用域，供精确定位');
  assert.equal(plan.journal.affected, 0);
});

test('retention：expire 打 until 不删行，restore 只放自己作废的', () => {
  const dir = freshData();
  const m = createMemory();
  const OLD = Date.now() - 200 * DAY;
  m.add('', '约定：A', 'global', { at: OLD });
  m.add('', '约定：A 补充', 'global', { at: OLD });
  m.add('', '主人住在杭州', 'global', { w: W_EXPLICIT, at: OLD });

  const picked = [{ scope: 'global', chatId: '', text: '约定：A' }];
  assert.equal(m.retention.expire(picked, Date.now()), 1);
  assert.ok(!m.list('').global.includes('约定：A'), '作废后不进注入');
  assert.ok(m.list('').global.includes('约定：A 补充'), '相似正文没被误伤');
  assert.ok(m.retention.entries().some((e) => e.text === '约定：A'), '原文仍在库里');
  assert.equal(m.retention.expired().length, 1);

  /** 这条是「被新说法取代」，不是本功能作废的，恢复时不能碰 */
  assert.equal(m.supersede('', '主人住在杭州').ok, true);
  assert.equal(m.retention.restore(), 1);
  assert.ok(m.list('').global.includes('约定：A'), '自己作废的放回来了');
  assert.ok(!m.list('').global.includes('主人住在杭州'), '改口作废的仍留着 until');
  assert.equal(m.retention.expired().length, 0);
});

test('retention：purge 真删一条，不动相似正文与 meta', () => {
  const dir = freshData();
  const m = createMemory();
  const OLD = Date.now() - 200 * DAY;
  m.add('', '约定：A', 'global', { at: OLD });
  m.add('', '约定：A 补充', 'global', { at: OLD });
  assert.equal(m.retention.purge([{ scope: 'global', chatId: '', text: '约定：A' }]), 1);
  const left = m.retention.entries().map((e) => e.text);
  assert.ok(!left.includes('约定：A'));
  assert.ok(left.includes('约定：A 补充'));
  assert.equal(m.retention.purge([{ scope: 'global', chatId: '', text: '约定：A' }]), 0, '重复删不报错也不虚报');
});

test('retention：空操作不写盘（默认关等价基线）', () => {
  const dir = freshData();
  const f = join(dir, 'memory.json');
  const m = createMemory();
  m.retention.entries();
  m.retention.expired();
  m.retention.expire([], Date.now());
  m.retention.restore([]);
  m.retention.purge([]);
  assert.equal(existsSync(f), false, '没改动就不该凭空写出 memory.json');
});

test('retention：expire 写盘后重开仍在，restore 落盘也持久', () => {
  const dir = freshData();
  const OLD = Date.now() - 200 * DAY;
  const a = createMemory();
  a.add('', '约定：A', 'global', { at: OLD });
  a.retention.expire([{ scope: 'global', chatId: '', text: '约定：A' }], Date.now());
  const b = createMemory();
  assert.equal(b.retention.expired().length, 1, 'until/expiredBy 落盘了');
  assert.equal(b.retention.restore(), 1);
  const c = createMemory();
  assert.equal(c.retention.expired().length, 0, '恢复也落盘了');
  assert.ok(c.list('').global.includes('约定：A'));
});

for (const backend of ['sqlite', 'jsonl']) {
  test(`retention：journal ${backend} 一键恢复只放本功能作废的行`, (t) => {
    const j = journalRig(t, backend === 'jsonl');
    assert.equal(j.backend(), backend);
    const at = Date.now() - 1000;
    j.add({ id: 'a', at, chatId: 'g1', text: '今天聊了会儿天', level: 'normal' });
    j.add({ id: 'b', at: at + 1, chatId: 'g1', text: '又聊了会儿', level: 'normal' });
    j.add({ id: 'c', at: at + 2, chatId: 'g1', text: '改口作废的旧约定', level: 'critical' });

    assert.equal(j.invalidate(['a', 'b'], { at: at + 3, supersededBy: 'retention' }), 2);
    assert.equal(j.invalidate(['c'], { at: at + 3, supersededBy: 'msg-42' }), 1);
    assert.equal(j.listChat('g1', 0).length, 0, '三条都退出注入了');

    assert.equal(j.restore(), 2);
    assert.equal(j.get('a').invalidAt, 0);
    assert.equal(j.get('b').invalidAt, 0);
    assert.ok(j.get('c').invalidAt > 0, '改口作废的不该被一键恢复放回来');
    assert.equal(j.listChat('g1', 0).length, 2);
    assert.equal(j.restore(), 0, '重复恢复不虚报');
  });

  test(`retention：journal ${backend} 支持只恢复指定 id，且 rewrite 后仍持久`, (t) => {
    const j = journalRig(t, backend === 'jsonl');
    const at = Date.now() - 1000;
    j.add({ id: 'a', at, chatId: 'g1', text: 'A', level: 'normal' });
    j.add({ id: 'b', at: at + 1, chatId: 'g1', text: 'B', level: 'normal' });
    j.invalidate(['a', 'b'], { at: at + 2, supersededBy: 'retention' });
    assert.equal(j.restore(['a']), 1);
    assert.equal(j.get('a').invalidAt, 0);
    assert.ok(j.get('b').invalidAt > 0);
    assert.equal(j.listChat('g1', 0).length, 1);
  });
}
