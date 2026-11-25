/**
 * 「空正文从思考里捞定稿」的不变量测试。
 *
 * 背景：推理型模型偶尔把要说的话全写在思考里，正文块是空的，这一轮就什么
 * 都发不出去。补法是**默认关**的：只有开了开关、且思考里真有「定稿 / 最后
 * N 行」这类标记时才捞——捞不到仍按 `empty` 收尾，绝不把内心独白发出去。
 *
 * 这里锁住三件事：开关关着不捞、有标记才捞、没标记仍不发。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTurnRunner, reasoningOf, rescueFromThinking } from '../src/turn.js';

/** 搭一个最小宿主：只认 `session/event`，手动 emit 事件来驱动一轮 */
function makeRunner(opts = {}) {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-turn-rescue-'));
  let handler = null;
  const ctx = {
    on: (type, fn) => {
      if (type === 'session/event') handler = fn;
      return () => {};
    },
    sessions: {},
  };
  const runner = createTurnRunner({ ctx, log: { info: () => {}, warn: () => {} }, ...opts });
  const agent = { session: { id: 'S1' }, followup: async () => {} };
  const emit = (event) => handler(agent.session, event);
  return { runner, agent, emit };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const reasoningMsg = (text, turn = 1) => ({
  type: 'assistant/message',
  data: { turn, message: { content: [{ type: 'reasoning', text }] } },
});

test('reasoningOf：只取思考块，正文块不算', () => {
  assert.equal(reasoningOf(null), '');
  assert.equal(reasoningOf({ content: [{ type: 'text', text: '正文' }] }), '');
  assert.equal(reasoningOf({ content: [{ type: 'reasoning', text: '想一想' }] }), '想一想');
  assert.equal(reasoningOf({
    content: [{ type: 'reasoning', text: '一' }, { type: 'text', text: '正文' }, { type: 'thinking', text: '二' }],
  }), '一\n二', '两种块名都认');
});

test('rescueFromThinking：只认定稿标记，取最后一个，截掉后面的自检', () => {
  assert.equal(rescueFromThinking(''), '');
  assert.equal(rescueFromThinking('她可能会想这么说，但我再想想'), '', '没有标记就不发');
  assert.equal(
    rescueFromThinking('Reply:\n草稿版\nCareful: 太长了\n3 lines:\n今天真的好热\n要不要开空调'),
    '今天真的好热\n要不要开空调',
  );
  assert.equal(
    rescueFromThinking('Final: 好的\n注意：这句是旁白'),
    '好的',
    '定稿后面的旁白要截掉',
  );
  assert.equal(rescueFromThinking('定稿：\n第一版\n定稿：\n第二版'), '第二版', '改过几版取最后一个');
});

test('思考兜底：开关关着时，空正文仍按 empty 收尾', async () => {
  const { runner, agent, emit } = makeRunner();
  const p = runner.run(agent, '你好').catch((e) => e);
  await tick();
  emit(reasoningMsg('定稿：\n今天好热'));
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const err = await p;
  assert.equal(err.kind, 'empty');
});

test('思考兜底：开关打开且思考里有定稿 → 按定稿发出去', async () => {
  const { runner, agent, emit } = makeRunner({ rescueEnabled: () => true });
  const p = runner.run(agent, '你好');
  await tick();
  emit(reasoningMsg('Reply:\n草稿\n定稿：\n今天真的好热'));
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(await p, '今天真的好热');
});

test('思考兜底：开关打开但思考里没有定稿标记 → 仍不发', async () => {
  const { runner, agent, emit } = makeRunner({ rescueEnabled: () => true });
  const p = runner.run(agent, '你好').catch((e) => e);
  await tick();
  emit(reasoningMsg('她好像不太想说话，随便想想'));
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  const err = await p;
  assert.equal(err.kind, 'empty');
});

test('思考兜底：有正文时完全不走兜底（正文优先）', async () => {
  const { runner, agent, emit } = makeRunner({ rescueEnabled: () => true });
  const p = runner.run(agent, '你好');
  await tick();
  emit(reasoningMsg('定稿：\n这条不该被用上'));
  emit({
    type: 'assistant/message',
    data: { turn: 1, message: { content: [{ type: 'text', text: '正文在这儿' }] } },
  });
  emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(await p, '正文在这儿');
});
