// `<<card:>>`：模型侧的官方图文卡片（msg_type=8）。
//
// 这一层出错的表现不是抛异常，而是「群里多出一行 <<card: 标题|…>>」、
// 「发出一条空白卡片」或者「正文发了、卡片没了」。所以每条都对着
// 解析结果 / 真调用到的 ch.send 参数断言，不测文案措辞。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCardValue, tuwenProblem } from '../src/tuwen.js';
import { tuwenProblem as hookTuwenProblem } from '../src/ext-api-hooks.js';
import { DOWNSTREAM_MARKERS, stripUnknown, stripUnclosed, markerRe, VALUE_MARKERS } from '../src/markers.js';
import { parseOutboundActions, createActionRunner, MAX_CARDS } from '../src/outbound-actions.js';
import { cleanBotText } from '../src/journal-bridge.js';
import { roostCardHintText } from '../src/host.js';

const GOOD = '一只猫|窗台上打盹，很治愈|https://b23.tv/abc|https://i0.hdslb.com/cover.jpg';

/* ---------------- 字段规则 ---------------- */

test('卡片解析：四段、全角竖线、描述里带竖线都要对得上', () => {
  const c = parseCardValue(GOOD);
  assert.deepEqual(c, {
    title: '一只猫',
    description: '窗台上打盹，很治愈',
    url: 'https://b23.tv/abc',
    picUrl: 'https://i0.hdslb.com/cover.jpg',
  });
  assert.deepEqual(parseCardValue('标题｜描述｜https://a.com/x｜https://a.com/p.png'), {
    title: '标题', description: '描述', url: 'https://a.com/x', picUrl: 'https://a.com/p.png',
  });
  /** 描述里的竖线并回去，不能把字段整体挪位 */
  const d = parseCardValue('标题|猫｜在窗台|https://a.com/x|https://a.com/p.png');
  assert.equal(d.url, 'https://a.com/x');
  assert.equal(d.picUrl, 'https://a.com/p.png');
  assert.match(d.description, /猫/);
  assert.match(d.description, /在窗台/);
  assert.equal(parseCardValue('标题|描述|https://a.com/x'), null);
  assert.equal(parseCardValue(''), null);
});

test('卡片校验：/v1/send 与 <<card:>> 用的是同一份函数', () => {
  assert.equal(hookTuwenProblem, tuwenProblem, '规则一漂移，平台只回笼统的 304061，没法查');
  assert.equal(tuwenProblem(parseCardValue(GOOD)), '');
  assert.equal(tuwenProblem(parseCardValue('|描述|https://a.com/x|https://a.com/p.png')), '缺 title');
  assert.match(tuwenProblem(parseCardValue(`标题|描述|http://a.com/x|https://a.com/p.png`)), /url 必须是 https/);
  assert.match(tuwenProblem(parseCardValue(`${'x'.repeat(51)}|描述|https://a.com/x|https://a.com/p.png`)), /title 最多 50 字/);
});

/* ---------------- 解析动作 ---------------- */

test('解析：卡片摘干净、正文保留、字段进 action', () => {
  const raw = `这个挺好看 <<card: ${GOOD}>> 你要不要看`;
  const { text, actions } = parseOutboundActions(raw);
  assert.equal(text, '这个挺好看  你要不要看');
  assert.doesNotMatch(text, /<<card|https:\/\//);
  const cards = actions.filter((a) => a.type === 'card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card.title, '一只猫');
});

test('解析：半角/全角冒号都认，代码块里的是举例不是指令', () => {
  const full = parseOutboundActions(`<<card：${GOOD}>>`);
  assert.equal(full.actions.filter((a) => a.type === 'card').length, 1);
  const raw = '```\n' + `<<card: ${GOOD}>>` + '\n```\n真的要发 ' + `<<card: ${GOOD}>>`;
  const { text, actions } = parseOutboundActions(raw);
  assert.equal(actions.filter((a) => a.type === 'card').length, 1);
  assert.match(text, /```/);
  assert.doesNotMatch(text, /真的要发\s*<<card/);
});

test('解析：不合格的只摘掉，留一条能照着改的原因', () => {
  for (const [value, why] of [
    ['标题|描述|https://a.com/x', '要写成'],
    ['标题|描述|http://a.com/x|https://a.com/p.png', 'url 必须是 https'],
    [`${'x'.repeat(51)}|描述|https://a.com/x|https://a.com/p.png`, 'title 最多 50 字'],
    /** 占位词也能给出具体是哪一项不合格，比笼统的「格式不对」好用 */
    ['标题|描述|链接|图片', 'url 必须是 https'],
  ]) {
    const { text, actions } = parseOutboundActions(`给 <<card: ${value}>>`);
    assert.equal(text, '给', `标记不能漏：${value}`);
    assert.equal(actions.filter((a) => a.type === 'card').length, 0, `${value} 不该变成卡片`);
    const bad = actions.find((a) => a.type === 'cardInvalid');
    assert.ok(bad, `${value} 要留下原因`);
    assert.match(bad.value, new RegExp(why));
  }
});

test('语法层：card 放行给动作层，未闭合的仍要清', () => {
  assert.ok(DOWNSTREAM_MARKERS.includes('card'));
  const raw = `<<card: ${GOOD}>>`;
  assert.equal(stripUnknown(raw), raw, '记忆清洗不能把卡片吃掉');
  assert.equal(stripUnclosed(`<<card: ${GOOD}`), '', '没闭合的不能原样进群');
  /** 复刻 applyMemoryMarkers 的清洗顺序，确认整条链路能走通 */
  const clean = (s) => {
    let out = String(s ?? '');
    for (const name of VALUE_MARKERS) out = out.replace(markerRe(name), '');
    return stripUnclosed(stripUnknown(out)).trim();
  };
  const cleaned = clean(`看看 <<remember: 她喜欢猫>> <<card: ${GOOD}>>`);
  assert.match(cleaned, /<<card:/);
  assert.equal(parseOutboundActions(cleaned).actions.filter((a) => a.type === 'card').length, 1);
});

/* ---------------- 执行 ---------------- */

function fakeChannel(over = {}) {
  const calls = [];
  return {
    calls,
    async send(p) { calls.push(['send', p]); return { ok: true, id: `m${calls.length}` }; },
    async sendFile(p) { calls.push(['file', p]); return { ok: true }; },
    async sendVoice(p) { calls.push(['voice', p]); return { ok: true }; },
    async uploadMarkdownImage(p) { calls.push(['upload', p]); return { url: 'qqbot-media://abc', imageId: 'img1' }; },
    async retract(p) { calls.push(['retract', p]); return { ok: true }; },
    ...over,
  };
}

test('执行：正文先发、卡片独占一条，卡片参数原样交给通道', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  let sent = 0;
  const r = await run({
    text: `这个挺好看 <<card: ${GOOD}>>`,
    target: 'g1', scene: 'group', msgId: 'msg-1', receivedAt: 1234,
    onSent: () => { sent += 1; },
  });
  assert.equal(r.ok, true);
  assert.equal(sent, 2, '正文 + 卡片各算一次送达');
  const sends = ch.calls.filter((c) => c[0] === 'send').map((c) => c[1]);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].text, '这个挺好看');
  assert.equal(sends[0].card, undefined, '正文那条不能带卡片');
  assert.equal(sends[1].markdown, false, '卡片和 markdown 互斥');
  assert.deepEqual(sends[1].card, parseCardValue(GOOD));
  assert.equal(sends[1].msgId, 'msg-1', '被动回复参数要带过去，不然白白消耗主动额度');
  assert.equal(sends[1].receivedAt, 1234);
});

test('执行：<skip> + 卡片 = 只发卡片', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  const r = await run({ text: `<skip> <<card: ${GOOD}>>`, target: 'u1' });
  assert.equal(r.sent, false, '<skip> 管的是正文那一条');
  assert.equal(ch.calls.length, 1);
  assert.equal(ch.calls[0][0], 'send');
  assert.ok(ch.calls[0][1].card);
});

test('执行：一轮最多一张，60 秒内同链接不重发', async () => {
  const ch = fakeChannel();
  const logs = [];
  const run = createActionRunner({ channel: () => ch, log: (m) => logs.push(m) });
  const second = `另一张|别的描述|https://b23.tv/def|https://i0.hdslb.com/other.jpg`;
  await run({ text: `<<card: ${GOOD}>> <<card: ${second}>>`, target: 'g1' });
  assert.equal(ch.calls.filter((c) => c[0] === 'send' && c[1].card).length, MAX_CARDS);
  assert.ok(logs.some((m) => /只发第一张/.test(m)));
  await run({ text: `<<card: ${GOOD}>>`, target: 'g1' });
  assert.equal(ch.calls.filter((c) => c[0] === 'send' && c[1].card).length, 1, '同一张别再发一遍');
});

test('执行：坏卡片只记日志，卡片发失败也不带崩这一轮', async () => {
  const logs = [];
  const ch = fakeChannel();
  const ok = createActionRunner({ channel: () => ch, log: (m) => logs.push(m) });
  await ok({ text: `先说一句 <<card: 标题|描述|http://a/x|https://a/p.png>>`, target: 'u1' });
  assert.equal(ch.calls.filter((c) => c[0] === 'send').length, 1, '正文照发');
  assert.ok(logs.some((m) => /url 必须是 https/.test(m)), '日志里要有具体原因');

  const badCh = fakeChannel({
    async send(p) {
      if (p.card) return { ok: false, message: '304061' };
      return { ok: true, id: 'm1' };
    },
  });
  const bad = createActionRunner({ channel: () => badCh, log: (m) => logs.push(m) });
  const r = await bad({ text: `先说一句 <<card: ${GOOD}>>`, target: 'u2' });
  assert.equal(r.ok, true, '卡片失败不能把整轮判成失败');
  assert.ok(logs.some((m) => /304061/.test(m)));
});

test('执行：<<retract>> 撤的是本轮之前那条正文，不是卡片', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '第一条', target: 'g1' });
  await run({ text: `给你看 <<card: ${GOOD}>>`, target: 'g1' });
  await run({ text: '说错了 <<retract>>', target: 'g1' });
  const ret = ch.calls.find((c) => c[0] === 'retract');
  assert.ok(ret);
  /** 第二轮正文是 m2、卡片是 m3：撤 m2 才说明卡片没顶掉 lastSent */
  assert.equal(ret[1].msgId, 'm2');
  assert.notEqual(ret[1].msgId, 'm3');
});

/* ---------------- 日记 / 提示词 ---------------- */

test('日记：卡片只留标题，两个 https 地址不许进记忆', () => {
  const clean = cleanBotText(`给你看 <<card: ${GOOD}>>`);
  assert.match(clean, /给你看/);
  assert.match(clean, /一只猫/);
  assert.doesNotMatch(clean, /https:\/\/|<<card|\|/);
});

test('提示词：宿主补的那段真把 card 写法教给模型', () => {
  const hint = roostCardHintText();
  assert.match(hint, /<<card: 标题\|描述\|https:\/\/链接\|https:\/\/图片地址>>/);
  assert.match(hint, /https/);
  assert.match(hint, /一轮最多一张/);
});
