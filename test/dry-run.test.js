import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRY_RUN_FEATURES, RETENTION_MODES, retentionR, normalizeEntry,
  canExpire, canExpireFacts, canExpireJournal,
  planRetention, planRetentionAll, formatImpact, formatImpactAll,
} from '../src/dry-run.js';
/** 判据不能和真实数据层漂移：直接拿这边的常量当输入来验 */
import { W_EXPLICIT } from '../src/memory.js';
import { ERASED, CLEARED, LEVELS } from '../src/journal.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 8);
const OLD = NOW - 120 * DAY;

const fact = (text, over = {}) => normalizeEntry({ text, at: OLD, w: 1, ...over }, 'facts', over.chatId || '');
const jrow = (id, over = {}) => normalizeEntry({
  id, text: '今天随口聊了几句', at: OLD, level: 'normal', kind: 'chat', accessed: 0, ...over,
}, 'journal', over.chatId || 'g1');

const cfg = (over = {}) => ({ factsMode: 'off', journalMode: 'off', thresholdPct: 5, minProtectDays: 30, ...over });

test('dry-run：两路模式、预览清单、真实常量对齐', () => {
  assert.deepEqual(RETENTION_MODES, ['off', 'expire', 'purge']);
  for (const id of ['retentionFactsMode', 'retentionJournalMode', 'profiles', 'events', 'extensions']) {
    assert.ok(DRY_RUN_FEATURES.includes(id), `${id} 该登记进预览清单`);
  }
  assert.ok(LEVELS.includes('normal'));
  /** 用户明说/手记的权重线、抹正文占位符，必须与数据层用同一个值 */
  assert.equal(canExpireFacts(fact('x', { w: W_EXPLICIT })), false);
  assert.equal(canExpireFacts(fact('x', { w: W_EXPLICIT - 1 })), true);
  assert.equal(canExpireJournal(jrow('a', { text: ERASED })), false);
  assert.equal(canExpireJournal(jrow('b', { text: CLEARED })), false);
});

test('dry-run：两路都关时一条都不动（默认关等价基线）', () => {
  const sources = { facts: [fact('a'), fact('b')], journal: [jrow('j1'), jrow('j2')] };
  for (const mode of [undefined, 'off', '', 'bogus']) {
    const s = planRetentionAll(sources, cfg({ factsMode: mode, journalMode: mode }), NOW);
    assert.equal(s.enabled, false);
    assert.equal(s.affected, 0);
    assert.equal(s.facts.affected, 0);
    assert.equal(s.journal.affected, 0);
    assert.deepEqual(s.facts.items, []);
    assert.deepEqual(s.journal.items, []);
    assert.equal(s.purge, false);
  }
  assert.match(formatImpactAll(planRetentionAll(sources, cfg(), NOW)), /两路都是「关」/);
  assert.match(formatImpact(planRetention([fact('a')], { mode: 'off' }, NOW)), /不会动任何记忆/);
});

test('dry-run：facts 只碰自动提炼的，用户明说/手记/已作废一律不碰', () => {
  const list = [
    fact('约定：以后周末不排会'),
    fact('主人住在杭州', { w: W_EXPLICIT }),
    fact('面板手记', { src: { manual: true, by: 'owner' } }),
    fact('被新说法取代的', { until: NOW - DAY }),
    fact('critical', { critical: true }),
  ];
  const plan = planRetention(list, { mode: 'expire', target: 'facts', thresholdPct: 5, minProtectDays: 30 }, NOW);
  assert.equal(plan.affected, 1);
  assert.equal(plan.items[0].id, '约定：以后周末不排会');
  assert.equal(plan.target, 'facts');
});

test('dry-run：journal 只碰 normal 的普通行，重要行/摘要/已失效一律不碰', () => {
  const list = [
    jrow('normal-old'),
    jrow('important', { level: 'important' }),
    jrow('critical', { level: 'critical' }),
    jrow('digest', { kind: 'digest' }),
    jrow('invalid', { invalidAt: NOW - DAY }),
    jrow('erased', { text: ERASED }),
    jrow('cleared', { text: CLEARED }),
    jrow('is-critical', { critical: true }),
  ];
  const plan = planRetention(list, { mode: 'expire', target: 'journal', thresholdPct: 5, minProtectDays: 30 }, NOW);
  assert.equal(plan.affected, 1);
  assert.equal(plan.items[0].id, 'normal-old');
  assert.equal(plan.target, 'journal');
});

test('dry-run：被检索过的旧事更黏（用现有 lastAccess/accessed，不新增 hitDays）', () => {
  const cold = jrow('cold', { at: NOW - 200 * DAY, lastAccess: 0, accessed: 0 });
  const warm = jrow('warm', { at: NOW - 200 * DAY, lastAccess: NOW - 3 * DAY, accessed: 12 });
  assert.ok(retentionR(warm, NOW) > retentionR(cold, NOW));
  assert.ok(warm.importance > cold.importance, '检索次数只进 importance，不改 RRF 名次');
  const opts = { mode: 'expire', target: 'journal', minProtectDays: 0 };
  assert.equal(planRetention([cold], opts, NOW).affected, 1);
  assert.equal(planRetention([warm], opts, NOW).affected, 0);
  /** facts 没有访问时间，保证是纯时间衰减而不是伪造 lastAccess */
  const f = fact('约定：x', { at: NOW - 200 * DAY });
  assert.equal(f.lastAccess, 0);
  assert.equal(f.importance, 0.5);
});

test('dry-run：两路各自自由开关，只开一路时另一路一步都不跑', () => {
  const sources = { facts: [fact('约定：a'), fact('约定：b')], journal: [jrow('j1'), jrow('j2')] };
  const onlyFacts = planRetentionAll(sources, cfg({ factsMode: 'expire' }), NOW);
  assert.equal(onlyFacts.facts.affected, 2);
  assert.equal(onlyFacts.journal.enabled, false);
  assert.equal(onlyFacts.journal.affected, 0);
  const onlyJournal = planRetentionAll(sources, cfg({ journalMode: 'expire' }), NOW);
  assert.equal(onlyJournal.facts.enabled, false);
  assert.equal(onlyJournal.facts.affected, 0);
  assert.equal(onlyJournal.journal.affected, 2);
  assert.match(formatImpactAll(onlyJournal), /日记 2 条/);
  assert.doesNotMatch(formatImpactAll(onlyJournal), /事实/);
});

test('dry-run：推荐默认档位 = facts 作废、journal 关', () => {
  const sources = { facts: [fact('约定：很久没提的旧约定')], journal: [jrow('j1')] };
  const s = planRetentionAll(sources, cfg({ factsMode: 'expire', journalMode: 'off' }), NOW);
  assert.equal(s.facts.affected, 1);
  assert.equal(s.journal.affected, 0);
  assert.equal(s.purge, false, '默认档位只能作废，不能真删');
});

test('dry-run：最短保护期内的新记忆不参与', () => {
  const fresh = fact('约定：刚说的', { at: NOW - 3 * DAY });
  assert.equal(planRetention([fresh], { mode: 'expire', target: 'facts', minProtectDays: 30 }, NOW).affected, 0);
  assert.equal(planRetention([fresh], { mode: 'expire', target: 'facts', minProtectDays: 0 }, NOW).affected, 0,
    '刚记 3 天，保留度还很高，开不开放保护期都不该中');
});

test('dry-run：阈值按整数百分数理解，越界值夹紧而不是全删', () => {
  for (const pct of [0, -5, 'abc', 999, null, undefined]) {
    const plan = planRetention([fact('a')], { mode: 'expire', target: 'facts', thresholdPct: pct, minProtectDays: 0 }, NOW);
    assert.ok(plan.affected === 0 || plan.affected === 1, '不能因为坏配置抛错');
  }
  /** 90 天 / importance 0.5 → R≈1.11%，正好卡在 1% 与 5% 之间，能验出阈值真的在生效 */
  const borderline = fact('a', { at: NOW - 90 * DAY });
  assert.equal(planRetention([borderline], { mode: 'expire', target: 'facts', thresholdPct: 1, minProtectDays: 0 }, NOW).affected, 0,
    '阈值 1% 比 5% 更宽松，这条该留');
  assert.equal(planRetention([borderline], { mode: 'expire', target: 'facts', thresholdPct: 5, minProtectDays: 0 }, NOW).affected, 1,
    '阈值 5% 会命中它');
  assert.equal(planRetention([fact('a')], { mode: 'expire', target: 'facts', thresholdPct: 50, minProtectDays: 0 }, NOW).affected, 1,
    '阈值 50% 更严格');
});

test('dry-run：purge 只是标记，返回的仍是同一批 id（真删由调用方先备份）', () => {
  const list = [fact('a'), fact('b')];
  const opts = { target: 'facts', minProtectDays: 0 };
  const expire = planRetention(list, { ...opts, mode: 'expire' }, NOW);
  const purge = planRetention(list, { ...opts, mode: 'purge' }, NOW);
  assert.deepEqual(purge.items.map((x) => x.id), expire.items.map((x) => x.id));
  assert.equal(purge.purge, true);
  assert.equal(expire.purge, false);
  assert.match(formatImpact(purge), /真删/);
  assert.match(formatImpact(expire), /作废不删行/);
});

test('dry-run：normalizeEntry 把两路真实字段映射对', () => {
  const f = normalizeEntry({ text: '约定：x', at: 123, w: 1, src: { journalId: 'j1' }, until: 0 }, 'facts', 'g1');
  assert.equal(f.id, '约定：x', 'facts 没有独立 id，用正文精确定位');
  assert.equal(f.chatId, 'g1');
  assert.equal(f.scope, 'global');
  assert.equal(f.lastAccess, 0);
  const j = normalizeEntry({ id: 'm1', at: 123, level: 'normal', kind: 'chat', accessed: 4, last_access: 456 }, 'journal', 'g2');
  assert.equal(j.lastAccess, 456, 'SQLite 的蛇形字段名也要认');
  assert.equal(j.importance > 0.5, true);
  assert.equal(canExpire(f, 'facts'), true);
  assert.equal(canExpire(j, 'journal'), true);
  assert.equal(canExpire(f, 'journal'), false, '拿 facts 的字段去 journal 判据不该误放行');
});
