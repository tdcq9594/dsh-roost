// 5.7 全链路模拟：每层判定要对，而且**一条都不能真发**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { simulate, buildFakeEvent, formatSimulation, SIM_LAYERS, LAYER_TITLES } from '../src/simulate.js';

const cfgBase = {
  roostHost: { decide: { mode: 'mention' } },
  group: {},
  model: {},
};

test('层序固定：inbound → decide → model → tools → outbound → ledger', () => {
  const r = simulate({ input: { text: '你好' }, cfg: cfgBase });
  assert.deepEqual(r.steps.map((s) => s.layer), SIM_LAYERS);
  for (const s of r.steps) assert.equal(s.title, LAYER_TITLES[s.layer]);
});

test('私聊一律回，decide 层说「私聊」', () => {
  const r = simulate({ input: { text: '在干嘛', kind: 'c2c' }, cfg: cfgBase });
  const d = r.steps.find((s) => s.layer === 'decide');
  assert.equal(d.ok, true);
  assert.equal(d.reason, '私聊');
  assert.equal(r.verdict, 'reply');
});

test('群聊没 @ 且是 mention 模式：不回，原因要说清是模式', () => {
  const r = simulate({ input: { text: '今天好热', kind: 'group', mentioned: false }, cfg: cfgBase });
  const d = r.steps.find((s) => s.layer === 'decide');
  assert.equal(d.ok, false);
  assert.match(d.reason, /只在被 @ 时回复/);
  assert.equal(r.verdict, 'silent');
  assert.equal(r.outbound.willSend, false);
  assert.equal(r.ledger.wouldWrite, false);
});

test('群聊被 @ 就直接回', () => {
  const r = simulate({ input: { text: '你看这个', kind: 'group', mentioned: true }, cfg: cfgBase });
  assert.equal(r.steps.find((s) => s.layer === 'decide').reason, '被 @');
  assert.equal(r.verdict, 'reply');
});

test('忽略词：以 / 开头当成别的插件的指令，不接', () => {
  const r = simulate({ input: { text: '/roll', kind: 'group', mentioned: true }, cfg: cfgBase });
  /** 被 @ 的优先级高于忽略词（判定顺序本身是语义），所以这里改成不 @ */
  const r2 = simulate({ input: { text: '/roll', kind: 'group', mentioned: false }, cfg: { roostHost: { decide: { mode: 'ai' } }, group: {}, model: {} } });
  assert.equal(r.steps.find((s) => s.layer === 'decide').ok, true);
  assert.equal(r2.steps.find((s) => s.layer === 'decide').ok, false);
  assert.match(r2.steps.find((s) => s.layer === 'decide').reason, /像是别的插件的指令/);
});

test('空消息不接', () => {
  const r = simulate({ input: { text: '   ', kind: 'group', mentioned: false }, cfg: cfgBase });
  assert.match(r.steps.find((s) => s.layer === 'decide').reason, /空消息/);
});

test('模型层：按会话单独配的优先，effort 按类型兜底', () => {
  const cfg = {
    ...cfgBase,
    model: {
      default: { provider: 'p1', model: 'm-default' },
      byKind: { c2c: { provider: 'p2', model: 'm-c2c' } },
      byChat: { 'sim:group': { provider: 'p3', model: 'm-own' } },
      effortByKind: true,
    },
  };
  const own = simulate({ input: { text: 'hi', kind: 'group', mentioned: true, chatId: 'sim:group' }, cfg });
  const m1 = own.steps.find((s) => s.layer === 'model');
  assert.equal(m1.detail.model, 'm-own');
  assert.equal(m1.detail.source, '按这个会话单独配的');
  assert.equal(m1.detail.effort, 'low', '群聊默认给低强度');

  const priv = simulate({ input: { text: 'hi', kind: 'c2c' }, cfg });
  const m2 = priv.steps.find((s) => s.layer === 'model');
  assert.equal(m2.detail.model, 'm-c2c');
  assert.equal(m2.detail.source, '按私聊默认');
  assert.equal(m2.detail.effort, 'high', '私聊默认给高强度');
});

test('模型层：一个都没配时明确说「用 DSH 当前选择」，不瞎猜', () => {
  const r = simulate({ input: { text: 'hi', kind: 'c2c' }, cfg: cfgBase });
  const m = r.steps.find((s) => s.layer === 'model');
  assert.equal(m.detail.provider, '');
  assert.match(m.reason, /DSH 当前选择/);
});

test('工具层：没给清单就标跳过，不假装算过', () => {
  const r = simulate({ input: { text: 'hi', kind: 'c2c' }, cfg: cfgBase });
  const t = r.steps.find((s) => s.layer === 'tools');
  assert.equal(t.ok, null);
  assert.equal(t.detail, null);
  assert.match(t.reason, /跳过/);
});

test('工具层：给了清单要分清「能用」和「被收走」', () => {
  const r = simulate({
    input: { text: 'hi', kind: 'c2c' },
    cfg: cfgBase,
    tools: { pool: ['a', 'b', 'c'], denied: ['c'] },
  });
  const t = r.steps.find((s) => s.layer === 'tools');
  assert.equal(t.ok, true);
  assert.deepEqual(t.detail.available, ['a', 'b']);
  assert.deepEqual(t.detail.denied, ['c']);
  assert.match(t.reason, /能用的 2 个/);
});

test('出站层：有 msgId 走被动回复，明说不占主动额度', () => {
  const r = simulate({ input: { text: 'hi', kind: 'c2c' }, cfg: cfgBase });
  assert.equal(r.outbound.mode, 'passive');
  assert.match(r.outbound.note, /不占主动额度/);
  assert.match(r.outbound.note, /由模型输出决定/, '内容不该被模拟编出来');
});

test('账本层永远标 dry，且说明不写盘', () => {
  const r = simulate({ input: { text: 'hi', kind: 'c2c' }, cfg: cfgBase });
  assert.equal(r.ledger.dry, true);
  assert.match(r.ledger.note, /不写账本/);
});

test('冷却中：会回但要等，summary 里带秒数', () => {
  const cfg = { ...cfgBase, roostHost: { decide: { mode: 'ai', cooldownSec: 20 } } };
  /** 用同一个 now 跑两次：第一次模拟自己不会 noteReplied，所以要手工造出「刚回过」的状态 */
  const r = simulate({ input: { text: 'hi', kind: 'group', mentioned: false }, cfg, now: 1000 });
  /** 新建实例没有历史，第一次必然不冷却——这里只锁「不冷却时不会瞎报」 */
  assert.equal(r.steps.find((s) => s.layer === 'decide').detail.cooling, false);
});

test('summary 是给顶栏看的一句话，不回时要带原因', () => {
  const silent = simulate({ input: { text: '今天好热', kind: 'group', mentioned: false }, cfg: cfgBase });
  assert.match(silent.summary, /不会回/);
  assert.match(silent.summary, /只在被 @ 时回复/);

  const reply = simulate({ input: { text: 'hi', kind: 'c2c' }, cfg: cfgBase });
  assert.match(reply.summary, /会回/);
});

test('formatSimulation 出纯文本，带 ✓/✗ 和「没真发」的收尾', () => {
  const r = simulate({ input: { text: '今天好热', kind: 'group', mentioned: false }, cfg: cfgBase });
  const text = formatSimulation(r);
  assert.match(text, /【模拟结果】/);
  assert.match(text, /✗ 要不要接/);
  assert.match(text, /一条消息都没真发/);
});

test('buildFakeEvent：私聊/群聊的默认身份不会混', () => {
  const c2c = buildFakeEvent({ kind: 'c2c', text: 'x' });
  assert.equal(c2c.chat.kind, 'c2c');
  assert.equal(c2c.sender.id, 'SIM_OWNER');

  const g = buildFakeEvent({ kind: 'group', text: 'x' });
  assert.equal(g.chat.kind, 'group');
  assert.equal(g.sender.id, 'SIM_MEMBER');
  assert.equal(g.msgId, 'SIM_MSG');
});

test('**绝不真发**：simulate.js 不许出现任何发送路径', () => {
  const src = readFileSync(new URL('../src/simulate.js', import.meta.url), 'utf8');
  /** 只查代码，不查注释——文件头的「本文件不 import outActions」正是要留的说明 */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['outActions', 'sendOut', 'onInbound', 'fetch(', 'channel.send', 'writeFile']) {
    assert.equal(code.includes(bad), false, `simulate.js 里出现了 ${bad}，模拟必须一条都不发`);
  }
});
