// 目的引擎（移植自 aurabot beta，MIT）：目标假设生成的核心行为。
// 这些场景照对方 purpose.test.js 的口径，确认抽取版与生产版等价。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formGoalHypotheses, goalToCandidate, DEFAULT_DRIVES, PURPOSE_NEEDS,
  updateObservations, applyGoalFeedback, GOAL_STATUSES, deriveDrives,
} from '../src/purpose-engine.js';

const persona = { hasText: false, traits: [], text: '', bias: {} };

test('归属：群友聊一次只记 member 目标，重复 ≥3 次升出 self', () => {
  const now = Date.now();
  const msg = (n) => ({
    id: `qq:group:1:${1000 + n}`, source: 'qq', kind: 'member', at: now + n,
    who: '群友', text: ['那个养鱼游戏，怎么玩啊', '那个养鱼游戏，联机开黑真快乐', '那个养鱼游戏，出攻略了吗'][n] ?? '那个养鱼游戏，还在吗',
  });
  const first = formGoalHypotheses({
    materials: [msg(0)], goals: [], observations: [], now,
    lastMasterAt: now - 10 * 3600_000, roleName: '大肥鱼', persona,
  });
  const owners1 = first.goals.filter((g) => g.domain === 'play').map((g) => g.owner);
  assert.ok(owners1.includes('member'), '第一次记成 member');
  assert.ok(!owners1.includes('self'), '第一次不该有 self');

  let goals = [], observations = [];
  for (let i = 0; i < 3; i++) {
    const r = formGoalHypotheses({
      materials: [msg(i)], goals, observations, now,
      lastMasterAt: now - 10 * 3600_000, roleName: '大肥鱼', persona,
    });
    goals = r.goals; observations = r.observations;
  }
  const self = goals.find((g) => g.owner === 'self' && g.domain === 'play');
  assert.ok(self, '重复 3 次后升出 self 目标');
  assert.ok(goals.find((g) => g.owner === 'member' && g.domain === 'play'), 'member 目标仍在');
  const cand = goalToCandidate(self);
  assert.ok(PURPOSE_NEEDS.includes(cand.need), '候选 need 在封闭词表里');
});

test('置信度：单条记忆保守；主人私聊的事形成 owner/care 目标', () => {
  const now = Date.now();
  const mem = formGoalHypotheses({
    materials: [{ id: 'm1', source: 'memory', kind: 'memory', at: now, who: '记忆', text: '想起一个叫星穹列车的游戏' }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000, roleName: '大肥鱼', persona,
  });
  const g = mem.goals.find((x) => x.source === 'memory');
  assert.ok(g && g.confidence < 0.7, `单条记忆置信度保守（实际 ${g?.confidence}）`);

  const owner = formGoalHypotheses({
    materials: [{ id: 'q1', source: 'qq', kind: 'owner', at: now, who: '主人', text: '我明天要去医院复查，有点紧张', meta: { key: 'private:10000001' } }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000, roleName: '大肥鱼', persona,
  });
  const care = owner.goals.find((x) => x.owner === 'owner' && x.domain === 'care');
  assert.ok(care, '主人私聊的事形成 owner/care 目标');
});

test('证据硬校验：目标带 evidence id；旧素材重复不抬置信', () => {
  const now = Date.now();
  const mat = { id: 'e1', source: 'qq', kind: 'member', at: now, who: '群友', text: '那个养鱼游戏，联机开黑真快乐' };
  const a = formGoalHypotheses({
    materials: [mat], goals: [], observations: [], now,
    lastMasterAt: now - 3600_000, roleName: '测试', persona,
  });
  assert.ok(a.goals.length, '至少产出一个目标');
  assert.ok(a.goals.some((g) => g.evidence?.some((e) => e.id === 'e1')), '目标带证据 id');
  assert.ok(GOAL_STATUSES.includes(a.goals[0].status));

  /** seenIds 记录已见素材：第二批相同素材不该再抬 sightings */
  const obs = updateObservations(a.observations, [mat], now, DEFAULT_DRIVES);
  const b = formGoalHypotheses({
    materials: [mat], goals: a.goals, observations: obs, now,
    lastMasterAt: now - 3600_000, roleName: '测试', persona,
  });
  const before = a.goals[0].sightings || 1;
  const after = b.goals.find((g) => g.id === a.goals[0].id)?.sightings || 1;
  assert.equal(after, before, '旧素材重复出现不抬 sightings');
});

test('主人反馈结算：确认/拒绝改变目标状态，不改状态词表', () => {
  const now = Date.now();
  const made = formGoalHypotheses({
    materials: [{ id: 'o1', source: 'qq', kind: 'owner', at: now, who: '主人', text: '我明天要去医院复查', meta: { key: 'private:10000001' } }],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000, roleName: '测试', persona,
  });
  assert.ok(made.goals.length);
  const stats = {};
  const next = applyGoalFeedback(made.goals, [], now, stats);
  assert.ok(Array.isArray(next));
  assert.ok(next.every((g) => GOAL_STATUSES.includes(g.status)), '状态仍在六态词表内');
});

test('deriveDrives（P0 第三批）：半衰回归默认、久不联系抬 connect、素材推高对应需要', () => {
  const now = 1e12;
  /** ① 半衰：极端值在长时间后回到默认附近 */
  const far = deriveDrives({ drives: { ...DEFAULT_DRIVES, play: 1 }, drivesAt: now - 48 * 3600_000, now });
  assert.ok(Math.abs(far.drives.play - DEFAULT_DRIVES.play) < 0.05, '48h 后应接近默认');

  /** ② 久不联系：connect 抬高 */
  const lonely = deriveDrives({ drives: { ...DEFAULT_DRIVES }, drivesAt: now, now, lastMasterAt: now - 48 * 3600_000 });
  const fresh = deriveDrives({ drives: { ...DEFAULT_DRIVES }, drivesAt: now, now, lastMasterAt: now });
  assert.ok(lonely.drives.connect > fresh.drives.connect, '久不联系 connect 更高');

  /** ③ 素材刺激：游戏类素材推高 play */
  const before = deriveDrives({ drives: { ...DEFAULT_DRIVES }, drivesAt: now, now });
  const after = deriveDrives({
    drives: { ...DEFAULT_DRIVES }, drivesAt: now, now,
    materials: [{ title: '好玩的游戏推荐', text: '这个游戏超好玩' }],
  });
  assert.ok(after.drives.play > before.drives.play, '游戏素材推高 play');

  /** ④ 全部钳在 0~1 */
  for (const need of PURPOSE_NEEDS) {
    assert.ok(after.drives[need] >= 0 && after.drives[need] <= 1, `${need} 越界`);
  }
});
