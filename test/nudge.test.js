// 追问 nudge（A2）：判据口径照对方 maybeNudge，验同名不同物与关键边界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeNudge, createNudgeStore, nudgePrompt, NUDGE_MIN_MS, NUDGE_MAX_MS } from '../src/nudge.js';

const MIN = 60_000;
const base = () => ({
  lastBot: { at: 1000000, text: '这个怎么样？' },
  lastOwnerAt: 0,
  now: 1000000 + 20 * MIN,
  nudgedFor: 0,
  gates: { masterOn: true, speakUpOn: true, nudgeOn: true, inQuiet: false, dailyMax: 0, countToday: 0, cooling: false },
});

test('基本成立：提问 + 20 分钟 + 全开', () => {
  const r = judgeNudge(base());
  assert.equal(r.yes, true, r.why);
});

test('总开关/追问开关关 → 一步不做', () => {
  const a = base(); a.gates.masterOn = false;
  assert.equal(judgeNudge(a).yes, false);
  const b = base(); b.gates.nudgeOn = false;
  assert.equal(judgeNudge(b).yes, false);
});

test('必须是提问：吗/呢/嘛/没锚句尾，陈述句里的嘛不算', () => {
  const a = base(); a.lastBot.text = '这算什么嘛 反正我也不着急 你先忙';
  assert.equal(judgeNudge(a).yes, false, '嘛不在句尾不算提问');
  const b = base(); b.lastBot.text = '你觉得呢';
  assert.equal(judgeNudge(b).yes, true, '呢在句尾算');
  const c = base(); c.lastBot.text = '今天天气真好';
  assert.equal(judgeNudge(c).yes, false);
});

test('时间窗 15-40 分钟，且主人后来回过就不追', () => {
  const a = base(); a.now = a.lastBot.at + 10 * MIN;
  assert.equal(judgeNudge(a).yes, false, '不到15分钟');
  const b = base(); b.now = b.lastBot.at + 50 * MIN;
  assert.equal(judgeNudge(b).yes, false, '超过40分钟');
  const c = base(); c.lastOwnerAt = c.lastBot.at + 1;
  assert.equal(judgeNudge(c).yes, false, '主人回过了');
  const d = base(); d.nudgedFor = d.lastBot.at;
  assert.equal(judgeNudge(d).yes, false, '这条追过了');
});

test('安静时段/上限/冷却都拦', () => {
  const a = base(); a.gates.inQuiet = true;
  assert.equal(judgeNudge(a).yes, false);
  const b = base(); b.gates.dailyMax = 3; b.gates.countToday = 3;
  assert.equal(judgeNudge(b).yes, false);
  const c = base(); c.gates.cooling = true;
  assert.equal(judgeNudge(c).yes, false);
});

test('标记：只记一次；busy/提交失败回滚，超时不回滚防双发', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-'));
  try {
    const file = join(dir, 'nudge.json');
    const s = createNudgeStore({ file });
    assert.equal(s.nudgedFor(), 0);
    s.mark(12345);
    assert.equal(s.nudgedFor(), 12345);
    s.mark(99999);
    assert.equal(s.nudgedFor(), 99999, '后一次覆盖');
    s.rollbackIfNotHappened(99999, 'busy');
    assert.equal(s.nudgedFor(), 0, 'busy 回滚');
    s.mark(77777);
    s.rollbackIfNotHappened(77777, 'timeout');
    assert.equal(s.nudgedFor(), 77777, '超时不回滚');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('提示词只用一个真实静默时长', () => {
  const p = nudgePrompt({ text: '你觉得呢', quietMs: 20 * MIN, owner: '主人', recentLines: ['你好'] });
  assert.match(p, /20 分钟没有回你/);
  assert.match(p, /不要用任何其它来源/);
  assert.match(p, /<<skip>>/);
});

test('独立数据源：老 speakUp 关着也能记 bot 最后发言（P0 回归）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-src-'));
  try {
    const file = join(dir, 'nudge.json');
    const s = createNudgeStore({ file });
    assert.deepEqual(s.lastBot(), { at: 0, text: '' }, '初始为空——旧实现这里读老引擎，恒0永不触发');
    s.recordBot('这个怎么样？', 12345);
    assert.deepEqual(s.lastBot(), { at: 12345, text: '这个怎么样？' });
    s.recordOwner(13000);
    assert.equal(s.lastOwnerAt(), 13000);
    const d = judgeNudge({
      lastBot: s.lastBot(), lastOwnerAt: s.lastOwnerAt(), now: 12345 + 20 * MIN,
      gates: { masterOn: true, speakUpOn: true, nudgeOn: true },
    });
    assert.equal(d.yes, false, '主人后来回过就不追');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('回滚只在标记仍是本条时做；超时退避生效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nudge-cool-'));
  try {
    const file = join(dir, 'nudge.json');
    const s = createNudgeStore({ file });
    s.mark(1000);
    s.recordBot('新的一句', 2000);
    s.mark(2000);
    s.rollbackIfNotHappened(1000, 'busy');
    assert.equal(s.nudgedFor(), 2000, '旧条的 busy 回滚不能抹掉新句标记');
    s.markCool(15, 3000);
    assert.equal(s.cooling(3000), true);
    assert.equal(s.cooling(3000 + 16 * MIN), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
