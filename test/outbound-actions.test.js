// 出站动作层：移除 ai-chat 之后，模型写的标记必须在这里摘干净并执行。
//
// 这一层错了不会抛错，只会「群里多出一行 <<voice: C:\…>>」或者
// 「直接发出去一个字面量 <skip>」。所以每条都对着真实发送结果断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRoostHostChannel } from '../src/channel.js';
import { stripUnknown, stripUnclosed, markerRe, VALUE_MARKERS } from '../src/markers.js';
import {
  parseOutboundActions, parseDurationMs, parseButton, buildKeyboard,
  createActionRunner, looksLikeSource, normalizeSource,
} from '../src/outbound-actions.js';

/* ---------------- 解析 ---------------- */

test('动作解析：六类标记全摘干净，正文不残留本地路径', () => {
  const raw = '给你看图 <<image: C:/pic/a.png>>，还有 <<image-alone: D:/b.jpg>>'
    + ' <<voice: E:/c.silk>> <<say: 你好呀>> <<button: 再来|/again>>'
    + ' <<silence:2h>> <<retract>> <<file: C:/secret.env>>';
  const { text, actions, wantSkip } = parseOutboundActions(raw);
  assert.equal(wantSkip, false);
  assert.doesNotMatch(text, /<<|C:\\|\.env|qqbot-media/);
  assert.match(text, /给你看图/);
  const types = actions.map((a) => a.type);
  for (const t of ['inlineImage', 'imageAlone', 'voice', 'say', 'button', 'silence', 'retract', 'file']) {
    assert.ok(types.includes(t), `缺 ${t}`);
  }
});

test('动作解析：代码块/行内代码里的标记不执行（模型举例时不误发图）', () => {
  const raw = '```\n<<image: C:/a.png>>\n```\n和 `<<voice: E:/b.silk>>`，真的要发 <<image: D:/c.png>>';
  const { text, actions } = parseOutboundActions(raw);
  assert.equal(actions.filter((a) => a.type === 'inlineImage').length, 1);
  assert.equal(actions.filter((a) => a.type === 'voice').length, 0);
  assert.match(text, /<<image: C:\/a\.png>>/);
  assert.match(text, /<<voice: E:\/b\.silk>>/);
});

test('动作解析：占位词不像路径就不当指令，也不留在正文里', () => {
  const { text, actions } = parseOutboundActions('比如写 <<image: 图片路径>> 就能发图');
  assert.equal(actions.filter((a) => a.type === 'inlineImage').length, 0);
  assert.doesNotMatch(text, /<<image/);
  assert.match(text, /比如写/);
});

test('动作解析：<skip> 永远不出现在正文里', () => {
  const a = parseOutboundActions('<skip>');
  assert.equal(a.wantSkip, true);
  assert.equal(a.text, '');
  const b = parseOutboundActions('<skip> 不过这个我可以答');
  assert.equal(b.wantSkip, true);
  assert.equal(b.text, '不过这个我可以答');
});

test('动作解析：全角冒号也认，未知标记兜底摘掉', () => {
  const { text, actions } = parseOutboundActions('好 <<say：念这句>> <<some-new-thing: 值>>');
  assert.match(text, /^好/);
  assert.doesNotMatch(text, /<<some-new-thing/);
  assert.equal(actions.filter((x) => x.type === 'say').length, 1);
});

test('时长/按钮/路径工具与旧 ai-chat 语义一致', () => {
  assert.equal(parseDurationMs('2h'), 7_200_000);
  assert.equal(parseDurationMs('30'), 30 * 60_000);
  assert.equal(parseDurationMs('999d'), 30 * 86_400_000);
  assert.equal(parseDurationMs('随便'), 0);
  assert.deepEqual(parseButton('再来|/again'), { label: '再来', data: '/again' });
  const kb = buildKeyboard([{ label: 'A', data: 'a' }]);
  /**
   * 官方结构是 `{ content: { rows } }`。少包一层 `content` 腾讯不报错，
   * 只是把整个 keyboard 丢掉——消息能发、按钮没了、日志一片绿。
   */
  assert.ok(kb.content, '必须包一层 content：{ content: { rows } }');
  assert.deepEqual(Object.keys(kb), ['content']);
  assert.equal(kb.content.rows[0].buttons[0].action.permission.type, 2);
  assert.equal(looksLikeSource('C:/a.png'), true);
  assert.equal(looksLikeSource('图片路径'), false);
  assert.equal(normalizeSource('file:///C:/a%20b.png'), 'C:/a b.png');
});

test('集成：记忆清洗必须放行动作标记，出站层才有得执行（含 <<retract>>）', () => {
  /** 复刻 applyMemoryMarkers 的清洗顺序 */
  const clean = (s) => {
    let out = String(s ?? '');
    for (const name of VALUE_MARKERS) out = out.replace(markerRe(name), '');
    out = stripUnknown(out);
    return stripUnclosed(out).trim();
  };
  const raw = '说错了 <<retract>> 安静会儿 <<silence:2h>> 看图 <<image: C:/a.png>>';
  const cleaned = clean(raw);
  assert.match(cleaned, /<<retract>>/);
  assert.match(cleaned, /<<silence:2h>>/);
  assert.match(cleaned, /<<image: C:\/a\.png>>/);
  const { text, actions } = parseOutboundActions(cleaned);
  assert.doesNotMatch(text, /<<|C:\/a\.png/);
  assert.ok(actions.some((a) => a.type === 'retract'));
  assert.ok(actions.some((a) => a.type === 'silence'));
  assert.ok(actions.some((a) => a.type === 'inlineImage'));
});

/* ---------------- 执行器 ---------------- */

function fakeChannel(over = {}) {
  const calls = [];
  const ch = {
    calls,
    async send(p) { calls.push(['send', p]); return { ok: true, id: `m${calls.length}` }; },
    async sendFile(p) { calls.push(['file', p]); return { ok: true, id: `f${calls.length}` }; },
    async sendVoice(p) { calls.push(['voice', p]); return { ok: true, id: `v${calls.length}` }; },
    async uploadMarkdownImage(p) { calls.push(['upload', p]); return { url: 'qqbot-media://abc', imageId: 'img1' }; },
    async retract(p) { calls.push(['retract', p]); return { ok: true }; },
    ...over,
  };
  return ch;
}

test('执行：默认走 Markdown，@ 标签与按钮都还在', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  const r = await run({ text: '张三 <qqbot-at-user id="ABCD1234"/> 看这个 <<button: 再来|/again>>', target: 'g1' });
  assert.equal(r.ok, true);
  const p = ch.calls.find((c) => c[0] === 'send')[1];
  assert.equal(p.markdown, true);
  assert.match(p.text, /<qqbot-at-user/);
  assert.equal(p.keyboard.content.rows[0].buttons[0].action.data, '/again');
});

test('执行：就地插图先上传再换引用，路径绝不进正文', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '看 <<image: C:/pic/a.png>> 这张', target: 'g1' });
  const p = ch.calls.find((c) => c[0] === 'send')[1];
  assert.match(p.text, /!\[\]\(qqbot-media:\/\/abc\)/);
  assert.doesNotMatch(p.text, /C:\/pic/);
});

test('执行：上传失败只删占位符，不把本地路径发出去', async () => {
  const ch = fakeChannel({ uploadMarkdownImage: async () => { throw new Error('上传失败'); } });
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '看 <<image: C:/pic/a.png>> 这张', target: 'g1' });
  const p = ch.calls.find((c) => c[0] === 'send')[1];
  assert.doesNotMatch(p.text, /C:\/pic|<<image/);
});

test('执行：正文先发、单图后发；同一标记在一轮里只发一次', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '给你图 <<image-alone: C:/a.png>>', target: 'g1' });
  await run({ text: '再补一句 <<image-alone: C:/a.png>>', target: 'g1' });
  const order = ch.calls.map((c) => c[0]);
  assert.deepEqual(order.slice(0, 2), ['send', 'file'], '正文先发、图后发');
  assert.equal(order.filter((x) => x === 'file').length, 1, '同一路径一轮只发一次');
});

test('执行：静默走闸，撤回的是这一轮之前自己发的那条', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '第一条', target: 'g1' });
  await run({ text: '说错了 <<retract>> <<silence:2h>>', target: 'g1' });
  const second = ch.calls.filter((c) => c[0] === 'send')[1][1];
  assert.equal(second.silenceMs, 7_200_000);
  const ret = ch.calls.find((c) => c[0] === 'retract');
  assert.equal(ret[1].msgId, 'm1');
});

test('执行：<skip> 单独出现时不发这条消息', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  const r = await run({ text: '<skip>', target: 'g1' });
  assert.equal(r.sent, false);
  assert.deepEqual(ch.calls, []);
});

test('执行：<<say>> 走 TTS 合成后发语音（base64 交给协议转码）', async () => {
  const ch = fakeChannel();
  const tts = { synthesize: async () => ({ audio: Buffer.from('RIFFfake'), contentType: 'audio/wav' }) };
  const run = createActionRunner({ channel: () => ch, tts });
  await run({ text: '<<say: 你好>>', target: 'g1' });
  const v = ch.calls.find((c) => c[0] === 'voice');
  assert.ok(v);
  assert.ok(v[1].dataBase64);
  assert.equal(v[1].fileType, undefined);
});

/* ---------------- 通道：Markdown 与降级 ---------------- */

test('通道：默认发 markdown（msg_type=2 由框架判定），4xx 才降级纯文本且不带按钮', async () => {
  const seen = [];
  const host = {
    rpc: async (method, p) => {
      seen.push({ method, p });
      if (seen.length === 1) {
        const e = new Error('40034008 markdown 和 content 不能同时给');
        e.http = 400;
        throw e;
      }
      return { id: 'ok', requestId: p.requestId };
    },
  };
  const ch = createRoostHostChannel({ host });
  const r = await ch.send({ target: 'g1', text: '**加粗** <qqbot-at-user id="ABCD1234"/>', keyboard: { content: { rows: [] } } });
  assert.equal(r.ok, true);
  assert.equal(r.markdown, false);
  assert.equal(seen[0].p.markdown.content, '**加粗** <qqbot-at-user id="ABCD1234"/>');
  assert.equal(seen[1].p.markdown, undefined, '降级不带 markdown');
  assert.equal(seen[1].p.keyboard, undefined, '降级不带 keyboard');
  assert.equal(seen[1].p.content, '加粗', '降级要去掉 Markdown 记号');
});

test('通道：5xx / 网络错误不重发（可能已经送达，重发就是两条）', async () => {
  let n = 0;
  const host = {
    rpc: async () => {
      n += 1;
      const e = new Error('上游 500');
      e.http = 500;
      throw e;
    },
  };
  const ch = createRoostHostChannel({ host });
  const r = await ch.send({ target: 'g1', text: '你好' });
  assert.equal(r.ok, false);
  assert.equal(n, 1);
});

/* ---------------- 语音条配额（以前扣在 ai-chat 侧，拿不到 openid） ---------------- */

test('配额：语音条额度用完时这句退化成文字，内容不丢', async () => {
  const ch = fakeChannel();
  const charged = [];
  const quota = {
    charge(p) {
      charged.push(p);
      return { ok: false, used: 3, max: 3, message: '语音条这次用完了（3/3）' };
    },
  };
  const run = createActionRunner({ channel: () => ch, quota, tts: { synthesize: async () => ({ audio: Buffer.from('x') }) } });
  await run({ text: '好的 <<say: 我想说的那句话>>', target: 'g1', senderId: 'u1' });

  /** 扣的时候按人算，且 id 是发送者而不是群号 */
  assert.equal(charged.length, 1);
  assert.equal(charged[0].feature, 'voice');
  assert.equal(charged[0].per, 'person');
  assert.equal(charged[0].id, 'u1');

  /** 不该发语音，但那句话要以文字发出去 */
  assert.equal(ch.calls.filter((c) => c[0] === 'voice').length, 0);
  const sent = ch.calls.filter((c) => c[0] === 'send').map((c) => c[1].text);
  assert.ok(sent.some((t) => t.includes('我想说的那句话')), '额度用完不能把这句吞掉');
});

test('配额：语音发出失败要把额度退回去（那次语音没真的出去）', async () => {
  const ch = fakeChannel({ async sendVoice() { return { ok: false, message: '上传失败' }; } });
  let undone = 0;
  const quota = {
    charge() { return { ok: true, undo: () => { undone += 1; } }; },
  };
  const run = createActionRunner({ channel: () => ch, quota, tts: { synthesize: async () => ({ audio: Buffer.from('x'), contentType: 'audio/mpeg' }) } });
  await run({ text: '<<say: 一句>>', target: 'g1', senderId: 'u1' });
  assert.equal(undone, 1, '发送失败必须回退配额');
});
