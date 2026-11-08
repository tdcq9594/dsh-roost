import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observe, behaviorHint, moodPrompt } from '../src/mood-observe.js';
import { createHistoryRing } from '../src/history-ring.js';

test('B1 观察：被夸 / 被凶才动心情，闲聊不动', () => {
  assert.equal(observe('今天好热'), null);
  assert.equal(observe('嗯'), null);
  assert.equal(observe(''), null);
  assert.ok(observe('谢谢你呀，好棒')?.valence > 0);
  assert.ok(observe('你真笨，闭嘴')?.valence < 0);
});

test('B1 观察：主人权重 1.5 倍，长句不猜', () => {
  const a = observe('好棒');
  const b = observe('好棒', { owner: true });
  assert.ok(b.valence > a.valence);
  assert.ok(Math.abs(b.valence / a.valence - 1.5) < 1e-9);
  assert.equal(observe('好棒'.padEnd(200, '啊')), null, '长篇大论不靠关键词判情绪');
  assert.equal(observe(null), null);
});

test('B2 行为提示：默认关；开启后低落少发、高兴多配图', () => {
  assert.equal(behaviorHint({ valence: -0.8 }, false), '');
  assert.match(behaviorHint({ valence: -0.8, energy: 0.5 }, true), /少配图/);
  assert.match(behaviorHint({ valence: 0.8, energy: 0.7, sociability: 0.8 }, true), /配张图/);
  assert.equal(behaviorHint({ valence: 0, energy: 0.5, sociability: 0.5 }, true), '',
    '中性时不该多注入一句噪声（B3 同一条原则）');
  assert.equal(behaviorHint(null, true), '', '坏状态不抛错');
});

test('B2/B3 组合：默认关时与现状逐字一致，中性时整块为空', () => {
  const neutral = { valence: 0, energy: 0.5, sociability: 0.5 };
  assert.equal(moodPrompt('', neutral, false), '');
  assert.equal(moodPrompt('', neutral, true), '');
  const low = { valence: -0.8, energy: 0.5, sociability: 0.5 };
  /** 关着时只给语气指令，一个字都不多 */
  assert.equal(moodPrompt('你现在有点烦，别勉强热情，句子短一点。', low, false),
    '你现在有点烦，别勉强热情，句子短一点。');
  /** 打开后接上行为提示 */
  assert.match(moodPrompt('你现在有点烦，别勉强热情，句子短一点。', low, true), /少配图/);
  assert.equal(moodPrompt(null, null, false), '', '坏输入不抛错');
});

test('环形历史：上限 200，最新在前，只留结构化字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ring-'));
  const file = join(dir, 'recall-log.json');
  const ring = createHistoryRing({ file, max: 5 });
  for (let i = 0; i < 8; i += 1) ring.push({ n: i });
  assert.equal(ring.size, 5);
  assert.deepEqual(ring.list(2).map((r) => r.n), [7, 6]);
  assert.deepEqual(ring.list(0).map((r) => r.n), [7, 6, 5, 4, 3]);
  assert.ok(ring.list(1)[0].at > 0, '自动补时间戳');

  /** 换一个实例读同一文件：确实落盘了，不是只在内存里 */
  const again = createHistoryRing({ file, max: 5 });
  assert.equal(again.size, 5);
  assert.equal(again.list(1)[0].n, 7);
});

test('环形历史：clear 后盘上也是空的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ring-'));
  const file = join(dir, 'mood-history.json');
  const ring = createHistoryRing({ file });
  ring.push({ valence: 0.2, reason: '被夸了一句' });
  assert.equal(ring.size, 1);
  ring.clear();
  assert.equal(ring.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
});

test('环形历史：坏文件 / 写不进去都不许抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ring-'));
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const ring = createHistoryRing({ file: bad });
  assert.equal(ring.size, 0);
  assert.doesNotThrow(() => ring.push({ a: 1 }));

  /** 目标是目录 → 写盘失败，push 仍要返回、不能把聊天弄挂 */
  const blocked = createHistoryRing({ file: dir });
  assert.doesNotThrow(() => blocked.push({ a: 1 }));
});
