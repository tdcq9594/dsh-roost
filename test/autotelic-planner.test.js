// 三段决策运行时：注入我方 turn 通道，验证意图→把关→行动单闭环。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanner } from '../src/autotelic-planner.js';
import { TAG_VOCAB } from '../src/autotelic-plan.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'planner-'));
const tag = TAG_VOCAB[0].tag;
const observations = [
  { id: 'o1', at: 1000, text: '她昨天提到想整理笔记' },
  { id: 'o2', at: 2000, text: '她今天又提起整理笔记' },
];

test('三段决策闭环：合法候选过关、落 ticket、写 decision 审计', async () => {
  const d = tmp();
  try {
    const file = join(d, 'decisions.jsonl');
    const planner = createPlanner({
      decisionFile: file,
      intentTurn: async () => JSON.stringify([{
        title: '整理自己的笔记', tag, reason: '她两次提到想整理', evidence: ['o1', 'o2'],
      }]),
      gateTurn: async () => JSON.stringify([{ i: 1, verdict: 'pass', why: '是她自己在乎的事' }]),
    });
    const r = await planner.decideRound({ round: 1, observations });
    assert.equal(r.outcome, 'tickets');
    assert.equal(r.candidates.length, 1);
    assert.equal(r.tickets.length, 1);
    assert.equal(r.verdicts[0], 'pass');
    const text = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(text.length, 2, 'intent + gate 各落一行');
    assert.deepEqual(text.map((l) => JSON.parse(l).phase), ['intent', 'gate']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('无出处候选直接作废（硬校验，不靠提示词）', async () => {
  const d = tmp();
  try {
    const planner = createPlanner({
      decisionFile: join(d, 'decisions.jsonl'),
      intentTurn: async () => JSON.stringify([{
        title: '凭空捏造的目标', tag, reason: '没有出处', evidence: ['不存在1', '不存在2'],
      }]),
      gateTurn: async () => { throw new Error('全灭轮不该调把关'); },
    });
    const r = await planner.decideRound({ round: 1, observations });
    assert.equal(r.outcome, 'all-dead');
    assert.equal(r.candidates.length, 0);
    assert.ok(r.deadReasons.some((x) => x.includes('观察窗口之外')), '给出作废原因');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('四态 verdict：reject 不立项，rework 带改写提示', async () => {
  const d = tmp();
  try {
    const mk = (gateTurn) => createPlanner({
      decisionFile: join(d, `d${Math.random()}.jsonl`),
      intentTurn: async () => JSON.stringify([{
        title: '整理自己的笔记', tag, reason: '两次提到', evidence: ['o1', 'o2'],
      }]),
      gateTurn,
    });
    const rejected = await mk(async () => JSON.stringify([{ i: 1, verdict: 'reject', why: '违反约束' }]))
      .decideRound({ round: 1, observations });
    assert.equal(rejected.outcome, 'all-dead');
    assert.equal(rejected.verdicts[0], 'reject');
    const reworked = await mk(async () => JSON.stringify([{ i: 1, verdict: 'rework', why: '说清具体用途' }]))
      .decideRound({ round: 1, observations });
    assert.equal(reworked.outcome, 'tickets');
    assert.equal(reworked.tickets[0].reworked, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('复盘 reviewRound：真跑不抛错，四态终态与建议成形', async () => {
  const { reviewRound } = await import('../src/autotelic-planner.js');
  const out = await reviewRound({
    roundId: 'r1', ts: 1000, ticketId: 't1', intentTitle: '整理笔记', tag,
    steps: [{ desc: '读一遍', status: 'done' }], finalStatus: 'done',
    ownerSide: false, ownerResponse: 'none', evidence: ['o1', 'o2'], lesson: '',
  }, {
    reviewTurn: async () => JSON.stringify({ summary: '做完了', lessons: ['下次先列提纲'], next: 'retry', memoryDrafts: [] }),
  });
  assert.equal(out.finalStatus, 'done');
  assert.equal(out.summary, '做完了');
  assert.equal(out.suggestions.next, 'retry');
});

test('复盘超预算：estimateTokens 裁剪步骤不抛 ReferenceError（回归）', async () => {
  const { reviewRound } = await import('../src/autotelic-planner.js');
  // 极小预算 + 很多步骤，强制走 while(steps.length && estimateTokens(...)) 裁剪分支
  const steps = Array.from({ length: 40 }, (_, i) => ({ desc: `第${i}步做一件很长的事情`.repeat(5), status: 'done' }));
  const out = await reviewRound({
    roundId: 'r2', ticketId: 't2', intentTitle: '大工程', tag, steps,
    finalStatus: 'done', evidence: [], lesson: '',
  }, {
    settings: () => ({ reviewMaxInputTokens: 100 }),
    reviewTurn: async () => JSON.stringify({ summary: '裁剪过了', next: 'drop' }),
  });
  assert.ok(out.steps.length < steps.length, '超预算的步骤被裁掉');
  assert.equal(out.summary, '裁剪过了');
});
