// 旧 ai-chat 设置项的体验对齐：直连之后曾经写死/丢失的三个值，重新可配且默认值不变。
//
// 关键不只是「DEFAULTS 里多几个键」：面板保存会按 DEFAULTS 形状 pruneTo，
// 键不在 DEFAULTS 里就会被静默裁掉，用户改了也存不住。所以这里直接钉 DEFAULTS。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../src/config.js';
import { createDecider } from '../src/roost-decide.js';
import { createPayloadBuilder } from '../src/roost-payload.js';
import { createRoostHostChannel } from '../src/channel.js';

test('配置形状：三个旧设置项都在 DEFAULTS 里（否则面板保存会被 pruneTo 裁掉）', () => {
  assert.equal(DEFAULTS.roostHost.decide.engagedMaxTurns, 6, '旧 ai-chat policyEngagedMaxTurns 默认 6');
  assert.equal(DEFAULTS.roostHost.maxImages, 4, '旧 ai-chat maxImages 默认 4');
  assert.equal(DEFAULTS.roostHost.markdown, true, '旧 ai-chat markdown 默认开');
  assert.equal(DEFAULTS.roostHost.merge.waitSec, 1.5);
  assert.equal(DEFAULTS.roostHost.merge.maxSec, 6);
});

test('连聊上限：按配置走，不再硬编码 3', () => {
  const group = { chat: { kind: 'group', chatId: 'g1' }, sender: { openid: 'u1' }, content: '继续聊' };
  const d = createDecider({
    cfg: () => ({
      roostHost: {
        decide: { mode: 'engaged', engagedMaxTurns: 2, maxPerHour: 100 },
      },
    }),
  });
  d.noteReplied('g1');
  assert.equal(d.check(group).go, true);
  assert.equal(d.check(group).go, true);
  const third = d.check(group);
  assert.equal(third.go, false, '超过上限要停');
  assert.match(third.reason, /连着接了 2 次/);

  /** 不传就用旧默认 6，不是 3 */
  const d2 = createDecider({
    cfg: () => ({ roostHost: { decide: { mode: 'engaged', maxPerHour: 100 } } }),
  });
  d2.noteReplied('g2');
  const g2 = { ...group, chat: { kind: 'group', chatId: 'g2' } };
  for (let i = 0; i < 6; i++) assert.equal(d2.check(g2).go, true);
  assert.equal(d2.check(g2).go, false);
});

test('图片上限：maxImages 热读，0 = 一次都不下图，函数值生效', async () => {
  const atts = Array.from({ length: 6 }, (_, i) => ({ type: 'image', url: `http://img.local/${i}.png` }));
  const evt = {
    chat: { kind: 'group', chatId: 'g1' }, sender: { openid: 'u1' },
    content: '看图', attachments: atts,
  };
  const rpc = async () => ({ bucket: 'member', level: '', role: '' });

  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; return { ok: false }; };
  const build0 = createPayloadBuilder({ rpc, vision: () => true, maxImages: 0, fetchImpl });
  await build0(evt, { send: async () => ({}) });
  assert.equal(fetches, 0, 'maxImages=0 不该下载任何图');

  let n = 2;
  const build2 = createPayloadBuilder({ rpc, vision: () => true, maxImages: () => n, fetchImpl });
  await build2(evt, { send: async () => ({}) });
  assert.equal(fetches, 2, '函数形式要热读');
});

test('markdown 开关：payload.channel.markdown 跟着配置，@ 标签才知道该不该拼', async () => {
  const rpc = async () => ({ bucket: 'member' });
  const evt = { chat: { kind: 'group', chatId: 'g1' }, sender: { openid: 'u1' }, content: '你好' };
  const on = createPayloadBuilder({ rpc, markdown: () => true });
  const off = createPayloadBuilder({ rpc, markdown: () => false });
  const a = await on(evt, { send: async () => ({}) });
  const b = await off(evt, { send: async () => ({}) });
  assert.equal(a.channel.markdown, true);
  assert.equal(b.channel.markdown, false);
});

test('markdown 开关：关掉后 msg.send 不带 markdown（@ 与加粗会按纯文字发）', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'm1' }; } };
  const off = createRoostHostChannel({ host, markdownEnabled: () => false });
  await off.send({ target: 'g1', text: '**加粗**' });
  assert.equal(calls[0][1].markdown, undefined);
  assert.equal(calls[0][1].content, '**加粗**');

  const on = createRoostHostChannel({ host, markdownEnabled: () => true });
  await on.send({ target: 'g1', text: '**加粗**' });
  assert.equal(calls[1][1].markdown.content, '**加粗**');
});

test('视觉能力三态：auto 才去问模型；「未知」和探测失败一律照发', async () => {
  /**
   * `vision: 'auto'` 是 2026-11-13 加的第三态（面板「视觉能力」的「自动」）。
   *
   * 这里要钉住的是**降级的方向**：只有宿主明确说「这个模型看不了图」才不发图。
   * 未知（`inputModalities` 缺省）和探测失败都必须照发——把用户发的图悄悄丢掉，
   * 比多带一张图糟得多，而且模型那边往往只是多几个 token。
   */
  const evt = {
    chat: { kind: 'c2c', chatId: 'c1' }, sender: { openid: 'u1' },
    content: '看图', attachments: [{ type: 'image', url: 'http://img.local/1.png' }],
  };
  const rpc = async () => ({ bucket: 'member' });
  /** 下载必然失败：这样「发不发图」只看 vision 判定，不受网络影响 */
  const fetchImpl = async () => ({ ok: false });
  const asked = [];
  const mk = (answer) => createPayloadBuilder({
    rpc,
    vision: () => 'auto',
    canSee: async (o) => { asked.push(o); return answer(); },
    fetchImpl,
  });

  const off = await mk(async () => false)(evt, { send: async () => ({}) });
  assert.match(off.rendered, /这一轮没开看图/, '明确看不了图 → 只给文字提示');
  assert.deepEqual(off.images, []);
  assert.deepEqual(asked[0], { chatId: 'c1', kind: 'c2c' }, '要按这个聊天问');

  for (const [label, answer] of [
    ['未知', async () => null],
    ['探测抛错', async () => { throw new Error('boom'); }],
    ['能看', async () => true],
  ]) {
    const p = await mk(answer)(evt, { send: async () => ({}) });
    assert.doesNotMatch(p.rendered, /这一轮没开看图/, `${label} 时必须照发`);
  }

  /** 老的两态不受影响：true 永远发、false 永远不发 */
  const always = createPayloadBuilder({ rpc, vision: () => true, fetchImpl });
  assert.doesNotMatch((await always(evt, { send: async () => ({}) })).rendered, /这一轮没开看图/);
  const never = createPayloadBuilder({ rpc, vision: () => false, fetchImpl });
  assert.match((await never(evt, { send: async () => ({}) })).rendered, /这一轮没开看图/);
});
