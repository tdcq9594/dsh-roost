/**
 * C1 + C4 的接线层：`wakeContext()` 从哪儿取、取哪些 kind、怎么排序。
 *
 * 用真 journal（SQLite）+ 真 events，不造假 ctx。重点锁住 2026-11-08 审查
 * 抓到的坑：只取 `chat` 会漏掉 `proactive`，防复读看不到自己上次主动说过什么。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import { createEvents, EVENT_LABELS } from '../src/events.js';
import { wakeContext } from '../src/wake-context.js';

const T = Date.parse('2026-11-08T12:00:00');

function rig(t, { eventsOn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-wake-ctx-'));
  const journal = createJournal({ file: join(dir, 'j.sqlite'), log: () => {} });
  /** 先关库再删目录：Windows 上 SQLite 还开着时 rmSync 会失败 */
  t.after(() => {
    try { journal.close(); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  journal.add({ id: 'u1', at: T - 3000, chatId: 'g1', sender: '甲', role: 'user', text: '在吗' });
  journal.add({ id: 'b1', at: T - 2000, chatId: 'g1', sender: '', role: 'bot', text: '在的' });
  journal.add({
    id: 'p1', at: T - 1000, chatId: 'g1', sender: '', role: 'bot', text: '今天想你了', kind: 'proactive',
  });
  const events = createEvents({ file: join(dir, 'events.json'), now: () => T, log: () => {} });
  if (eventsOn) events.push({ kind: 'proactive', scene: 'c2c' });
  return { journal, events };
}

test('C1：chat 与 proactive 两个 kind 的 bot 行都要进素材，最新在前', (t) => {
  const { journal, events } = rig(t);
  const r = wakeContext({ journal, events, chatId: 'g1', eventsEnabled: true, labels: EVENT_LABELS });
  assert.equal(r.recentBot.length, 2, JSON.stringify(r.recentBot));
  assert.ok(r.recentBot[0].includes('想你了'), `最新的主动话该排最前：${JSON.stringify(r.recentBot)}`);
  assert.ok(r.recentBot[1].includes('在的'));
});

test('C1：【刚才说到】只取对话原文，不把主动搭话混进去', (t) => {
  const { journal, events } = rig(t);
  const r = wakeContext({ journal, events, chatId: 'g1', eventsEnabled: true, labels: EVENT_LABELS });
  assert.equal(r.recent.length, 2, JSON.stringify(r.recent));
  assert.ok(r.recent[0].startsWith('甲：'), '最旧在前');
  assert.ok(!r.recent.join('\n').includes('想你了'), 'proactive 不该进「刚才说到」');
});

test('C4：events 开关关着时 done 恒为空；开着才给', (t) => {
  const { journal, events } = rig(t);
  const off = wakeContext({ journal, events, chatId: 'g1', eventsEnabled: false, labels: EVENT_LABELS });
  assert.deepEqual(off.done, [], '关着不能把旧动作翻出来');
  const on = wakeContext({ journal, events, chatId: 'g1', eventsEnabled: true, labels: EVENT_LABELS });
  assert.equal(on.done.length, 1);
  assert.match(on.done[0], /主动找过你/);
});

test('chatId 为空时全空，不去查全库（防串场）', (t) => {
  const { journal, events } = rig(t);
  const r = wakeContext({ journal, events, chatId: '', eventsEnabled: true, labels: EVENT_LABELS });
  assert.deepEqual(r, { recent: [], recentBot: [], done: [] });
});
