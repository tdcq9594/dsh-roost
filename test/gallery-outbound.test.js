// 序号出站：模型写 `<<image: #3>>`，宿主自己换成真实路径。
//
// 这条链最重要的是「路径永不进模型上下文、序号永不进群」：
//   · 解析出来是路径 → 模型看不到，它只会写序号；
//   · 序号查不到 → 整段摘掉 + 记日志，群里不能出现 `#3` 这种字样。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOutboundActions, createActionRunner } from '../src/outbound-actions.js';

const PATH = 'C:/图库/开心/熊猫.png';
const resolve = (seq) => (seq === 3 ? PATH : '');

test('`<<image: #3>>` 解析成真实路径，并带上序号', () => {
  const { text, actions } = parseOutboundActions('看这个 <<image: #3>> 好吧', { resolveImage: resolve });
  assert.doesNotMatch(text, /#3/);
  const a = actions.find((x) => x.type === 'inlineImage');
  assert.equal(a.value, PATH);
  assert.equal(a.seq, 3);
  /** 占位符要留着等上传成功再填，不能让路径提前进正文 */
  assert.match(text, /\u0001IMG0\u0001/);
});

test('`<<image-alone: #3>>` 同理', () => {
  const { actions } = parseOutboundActions('<<image-alone: #3>>', { resolveImage: resolve });
  const a = actions.find((x) => x.type === 'imageAlone');
  assert.equal(a.value, PATH);
  assert.equal(a.seq, 3);
});

test('号不存在：占位符摘掉、正文干净，留一条 imageMiss 供日志', () => {
  const { text, actions } = parseOutboundActions('这个 <<image: #99>> 没了', { resolveImage: resolve });
  assert.equal(actions.filter((x) => x.type === 'inlineImage').length, 0);
  assert.deepEqual(actions.filter((x) => x.type === 'imageMiss').map((x) => x.value), ['#99']);
  assert.doesNotMatch(text, /#99|\u0001IMG/);
  assert.match(text, /这个.*没了/);
});

test('没注入图库时 #3 一律摘掉：老调用方行为不变，也不残留序号', () => {
  const { text, actions } = parseOutboundActions('看 <<image: #3>>');
  assert.equal(actions.filter((x) => x.type === 'inlineImage').length, 0);
  assert.doesNotMatch(text, /#3/);
});

test('`#3.png` 不算序号：模型在猜的时候不能当真的', () => {
  const { text, actions } = parseOutboundActions('<<image: #3.png>>', { resolveImage: resolve });
  assert.equal(actions.filter((x) => x.type === 'inlineImage').length, 0, '不能真发图');
  /**
   * 但**必须留一条 `imageBad`**。原来的实现这里返回 `null`，占位符被摘掉、
   * 日志一个字都不写：用户只看到「图没发」，模型下一轮还在用同样的写法。
   * 「什么都没发生」是最难查的那种失败。
   */
  const bad = actions.filter((x) => x.type === 'imageBad');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].value, '#3.png');
  assert.doesNotMatch(text, /#3\.png/, '标记本身不能漏进正文');
});

test('`#3,#5` 不算序号：一次一张，和 MAX_MEDIA 口径一致', () => {
  const { actions } = parseOutboundActions('<<image: #3,#5>>', { resolveImage: resolve });
  assert.equal(actions.filter((x) => x.type === 'inlineImage').length, 0);
});

test('代码块里的 #3 不解析（模型举例时不能真发图）', () => {
  const raw = '例如写 `<<image: #3>>` 就行\n```\n<<image: #3>>\n```';
  const { actions } = parseOutboundActions(raw, { resolveImage: resolve });
  assert.equal(actions.filter((x) => x.type === 'inlineImage').length, 0);
  assert.equal(actions.filter((x) => x.type === 'imageMiss').length, 0);
});

function fakeChannel() {
  const calls = [];
  return {
    calls,
    async send(p) { calls.push(['send', p]); return { ok: true, id: `m${calls.length}` }; },
    async sendFile(p) { calls.push(['file', p]); return { ok: true }; },
    async uploadMarkdownImage(p) { calls.push(['upload', p]); return { url: 'qqbot-media://abc', imageId: 'img1' }; },
  };
}

test('发送成功才记一次使用（发失败不污染热度）', async () => {
  const ch = fakeChannel();
  const seen = [];
  const run = createActionRunner({
    channel: () => ch,
    resolveImage: resolve,
    onImageUsed: (seq) => seen.push(seq),
  });
  await run({ text: '图来 <<image-alone: #3>>', target: 'g1', scene: 'group' });
  assert.deepEqual(seen, [3]);
  assert.equal(ch.calls.find((c) => c[0] === 'file')[1].path, PATH);
});

test('发送失败不记使用', async () => {
  const ch = fakeChannel();
  ch.sendFile = async () => ({ ok: false, message: '素材上传失败' });
  const seen = [];
  const run = createActionRunner({
    channel: () => ch,
    resolveImage: resolve,
    onImageUsed: (seq) => seen.push(seq),
  });
  await run({ text: '<<image-alone: #3>>', target: 'g1', scene: 'group' });
  assert.deepEqual(seen, [], '发失败算「用过」会让模型绕开根本没发出去的图');
});

test('就地插图上传成功后也记使用，正文换成安全引用', async () => {
  const ch = fakeChannel();
  const seen = [];
  const run = createActionRunner({ channel: () => ch, resolveImage: resolve, onImageUsed: (s) => seen.push(s) });
  const r = await run({ text: '前 <<image: #3>> 后', target: 'g1', scene: 'group' });
  assert.deepEqual(seen, [3]);
  const sent = ch.calls.find((c) => c[0] === 'send')[1];
  assert.match(sent.text, /!\[\]\(qqbot-media:\/\/abc\)/);
  assert.doesNotMatch(sent.text, /#3|图库|\.png/, '正文里不能留路径');
  assert.equal(r.ok, true);
});

test('序号解析失败会记日志，用户能看出图为什么没发', async () => {
  const ch = fakeChannel();
  const logs = [];
  const run = createActionRunner({
    channel: () => ch,
    resolveImage: () => '',
    log: (m) => logs.push(m),
  });
  await run({ text: '这个 <<image: #77>> 看看', target: 'g1', scene: 'group' });
  assert.ok(logs.some((m) => m.includes('#77')), `日志里要有 #77，实际：${logs.join(' | ')}`);
  assert.equal(ch.calls.filter((c) => c[0] === 'upload').length, 0);
});

test('文件名里带 `#` 的图照样发得出去（`图#1.png` 不能被当成查询串切掉）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch, resolveImage: resolve });
  const weird = PATH.replace(/\.png$/, '#1.png');
  const { actions } = parseOutboundActions(`<<image-alone: ${weird}>>`, { resolveImage: resolve });
  assert.equal(actions.filter((x) => x.type === 'imageAlone').length, 1, '解析阶段就要认出这是图');
  await run({ text: `<<image-alone: ${weird}>>`, target: 'g1', scene: 'group' });
  assert.ok(ch.calls.some((c) => c[0] === 'file'), '要真的走发送，而不是静默 continue');
});

test('就地插图：正文没发出去就不记使用（上传成功 ≠ 发出去）', async () => {
  const seen = [];
  const calls = [];
  const run = createActionRunner({
    channel: () => ({
      async uploadMarkdownImage(p) { calls.push(['upload', p]); return { url: 'qqbot-media://abc', imageId: 'i1' }; },
      async send() { calls.push(['send']); return { ok: false, message: '通道限频' }; },
      async deleteImage() { return { ok: true }; },
    }),
    resolveImage: resolve,
    onImageUsed: (seq) => seen.push(seq),
  });
  await run({ text: '图 <<image: #3>>', target: 'g1', scene: 'group' });
  assert.deepEqual(seen, [], '发失败不能污染热度排序');
  assert.ok(calls.some((c) => c[0] === 'upload'), '上传确实发生了——所以「忘记回滚」才是个真问题');
});

test('就地插图：正文发成功才记使用', async () => {
  const seen = [];
  const run = createActionRunner({
    channel: () => ({
      async uploadMarkdownImage() { return { url: 'qqbot-media://abc', imageId: 'i1' }; },
      async send() { return { ok: true, id: 'm1' }; },
      async deleteImage() { return { ok: true }; },
    }),
    resolveImage: resolve,
    onImageUsed: (seq) => seen.push(seq),
  });
  await run({ text: '图 <<image: #3>>', target: 'g1', scene: 'group' });
  assert.deepEqual(seen, [3]);
});
