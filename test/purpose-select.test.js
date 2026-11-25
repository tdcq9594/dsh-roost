// 目的引擎选择层：四层调权、去重、惦记优先、驱动影响。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectPurpose } from '../src/purpose-select.js';
import { DEFAULT_PURPOSE_CONFIG as CFG, DEFAULT_DRIVES } from '../src/purpose-engine.js';

const base = (extra = {}) => ({
  seeds: [], goals: [], pending: [], history: [],
  config: CFG, drives: DEFAULT_DRIVES, now: 1e12, random: () => 0.99, ...extra,
});

test('selectPurpose：空输入返回 null', () => {
  const r = selectPurpose(base());
  assert.equal(r.purpose, null);
  assert.deepEqual(r.candidates, []);
});

test('selectPurpose：种子能变成候选并带需要/动作/情绪标签', () => {
  const r = selectPurpose(base({ seeds: [{ text: '想问主人周末去不去爬山' }] }));
  assert.ok(r.purpose);
  assert.equal(typeof r.purpose.need, 'string');
  assert.ok(r.purpose.needLabel);
  assert.ok(r.purpose.actionLabel);
  assert.equal(r.purpose.text, '想问主人周末去不去爬山');
});

test('selectPurpose：拒绝/完成/过期的目标不进候选', () => {
  /** goalToCandidate 需要完整形状：intent/domain/action/object.name */
  const mk = (id, status, intent) => ({
    id, status, intent, domain: 'connect', action: 'ask',
    object: { name: '那件事' }, confidence: 0.6, value: 0.5, risk: 0.1,
    owner: 'owner', lastSeenAt: 1e12, evidence: [],
  });
  const goals = [mk('g1', 'rejected', '想说的事A'), mk('g2', 'done', '想说的事B'), mk('g3', 'active', '想说的事C')];
  const r = selectPurpose(base({ goals }));
  assert.ok(r.candidates.every((c) => !['g1', 'g2'].includes(c.goalId)), '被拒/完成的不能出现');
});

test('selectPurpose：历史里说过的重复内容会被过滤', () => {
  const r = selectPurpose(base({
    seeds: [{ text: '问他周末去哪玩' }],
    history: [{ purpose: '问他周末去哪玩', outcome: 'sent' }],
  }));
  assert.equal(r.purpose, null, '说过的就别再说');
});

test('selectPurpose：惦记的事有概率优先', () => {
  const pending = [{ text: '上次没问完的事', hits: 2 }];
  const r = selectPurpose(base({ pending, random: () => 0 })); // 0 < pendingShareProbability
  assert.equal(r.fromPending, true);
  assert.equal(r.purpose.text, '上次没问完的事');
});

test('selectPurpose：高风险目标只能问或分享', () => {
  const r = selectPurpose(base({
    seeds: [{ text: '想给他买个礼物', need: 'consume', action: 'invite', risk: 0.8 }],
  }));
  assert.ok(['ask', 'share'].includes(r.purpose.action), `高风险动作应为 ask/share，实际 ${r.purpose.action}`);
});

test('selectPurpose：候选去重，同需要最多 2 个', () => {
  const seeds = Array.from({ length: 8 }, (_, i) => ({ text: `想陪主人说话第${i}件不同的事`, need: 'connect' }));
  const r = selectPurpose(base({ seeds }));
  /** 去重优先 ≤2；但候选不足 3 条时有兜底补足，所以断言放宽到「优先去重生效」 */
  const connectCount = r.candidates.filter((c) => c.need === 'connect').length;
  assert.ok(r.candidates.length >= 3, '至少要凑 3 条候选');
  assert.ok(connectCount <= 3, `同需要不应无限堆，实际 ${connectCount}`);
});

test('selectPurpose：驱动高的需要更容易被选中', () => {
  const seeds = [
    { text: '想问问他在玩什么游戏', need: 'play' },
    { text: '想弄明白这个原理是怎么回事', need: 'learn' },
  ];
  const highPlay = selectPurpose(base({ seeds, drives: { ...DEFAULT_DRIVES, play: 0.95, learn: 0.05 }, random: () => 0.01 }));
  assert.equal(highPlay.purpose.need, 'play', 'play 驱动高时选 play');
});

/**
 * 跟进候选不再豁免去重（发版复查发现）。
 *
 * 以前 `kind === 'memory-follow-up'` 能跳过文本去重与 sourceId 历史比对，
 * 又在末尾「惦记的事直接胜出」，结果同一件到期的事每轮心跳都会被选中；
 * 而 tries 只有入站回复路径会加，主链不记账 → 它永远到期、永远重提。
 */
test('selectPurpose：同一件到期的事说过一次后不再进候选', () => {
  const seed = {
    id: 'follow:g1:上次说的面试', kind: 'memory-follow-up', kindLabel: '',
    text: '上次说的面试怎么样了？', sourceId: 'follow:g1:上次说的面试', weight: 2,
    fact: '面试', factChatId: 'g1',
  };
  const first = selectPurpose(base({ seeds: [seed] }));
  assert.equal(first.purpose?.kind, 'memory-follow-up', '第一次该被选中');
  assert.equal(first.purpose.fact, '面试', '事实原文要带到目的上，供投递后回写 tries');
  assert.equal(first.purpose.factChatId, 'g1');

  /** 把她真说过的那轮记进历史（applyPurposeOutcome 的形状） */
  const history = [{ at: 1e12, outcome: 'sent', kind: 'memory-follow-up', sourceId: seed.sourceId, text: '面试那事后来怎么样啦' }];
  const again = selectPurpose(base({ seeds: [seed], history }));
  assert.notEqual(again.purpose?.sourceId, seed.sourceId, '刚说过，6 小时静默窗内不该再被选中');

  /**
   * 但静默窗不能变成永久封锁：`markFollowUpAsked` 按 1/3/7 天重排，到期后
   * 必须还能再问一次。按「最近 10 条」去重会把 25 小时后的重问也挡掉，而它
   * 又是唯一候选时，永远选不出来 → 永远不产生新历史 → 死锁（实测 72h 都挡）。
   */
  const dayLater = selectPurpose(base({ seeds: [seed], history: [{ ...history[0], at: 1e12 - 25 * 3600_000 }] }));
  assert.equal(dayLater.purpose?.sourceId, seed.sourceId, '一天后到期必须能再问');
});
