// 出站动作层：移除 ai-chat 之后，模型写的标记必须在这里摘干净并执行。
//
// 这一层错了不会抛错，只会「群里多出一行 <<voice: C:\…>>」或者
// 「直接发出去一个字面量 <skip>」。所以每条都对着真实发送结果断言。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRoostHostChannel } from '../src/channel.js';
import { stripUnknown, stripUnclosed, markerRe, VALUE_MARKERS } from '../src/markers.js';
import {
  parseOutboundActions, parseDurationMs, parseButton, buildKeyboard,
  createActionRunner, looksLikeSource, normalizeSource,
  parseImageSize, splitImageSize,
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

test('执行：整轮媒体合计不超 MAX_MEDIA，超出的占位符删干净', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  const text = Array.from({ length: 5 }, (_, i) => `图${i} <<image: C:/p/${i}.png>>`).join(' ')
    + ' 单图 <<image-alone: C:/p/x.png>>';
  await run({ text, target: 'g1' });
  assert.equal(ch.calls.filter((c) => c[0] === 'upload').length, 3, '就地插图最多 3 张');
  assert.equal(ch.calls.filter((c) => c[0] === 'file').length, 0, '预算用完后独立媒体不再发');
  const p = ch.calls.find((c) => c[0] === 'send')[1];
  assert.doesNotMatch(p.text, /<<image|C:\/p\//, '超预算的占位符不能把本地路径留在正文');
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

test('配额：没有发送者时退回按会话算，不能拿群 openid 顶成一个人', async () => {
  /**
   * 用户反馈：「粒度是 chatId 不是发送者，在群里就直接认群的 openid」。
   * 主动搭话 / 事件轮没有真人，旧实现写成 `id: senderId || target`，
   * 群聊里 target 是**群 openid** —— 于是整群共用「一个人」的额度，
   * 面板上还写着「按人」。
   */
  const ch = fakeChannel();
  const charged = [];
  const quota = {
    charge(p) {
      charged.push(p);
      return { ok: false, used: 3, max: 3, message: '用完了' };
    },
  };
  const run = createActionRunner({ channel: () => ch, quota, tts: { synthesize: async () => ({ audio: Buffer.from('x') }) } });
  await run({ text: '<<say: 一句>>', target: 'group-openid', senderId: '' });

  assert.equal(charged.length, 1);
  assert.equal(charged[0].per, 'chat', '没有发送者就按会话算');
  assert.equal(charged[0].id, 'group-openid', 'id 是会话，不是「某个人」');
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

test('配额：按档位给额度（主人那档更松），bucket 要传到 charge', async () => {
  /**
   * 面板上「主人单独一套额度」(`quota.voice.byBucket.owner`) 配了却不生效，
   * 因为出站层拿不到 bucket —— 档位是在 handleTurn 里算的，出站只看得到
   * 原始事件（没有 bucket 字段）。宿主现在存一份 turnBucket 传进来。
   */
  const ch = fakeChannel();
  const charged = [];
  const quota = { charge(p) { charged.push(p); return { ok: true }; } };
  const run = createActionRunner({ channel: () => ch, quota, tts: { synthesize: async () => ({ audio: Buffer.from('x'), contentType: 'audio/mpeg' }) } });
  await run({ text: '<<say: 一句>>', target: 'g1', senderId: 'u1', bucket: 'owner' });
  assert.equal(charged[0].bucket, 'owner', '主人那档要能命中 byBucket');

  /** 拿不到档位时是空串 —— 走默认额度，不会误给高配额 */
  charged.length = 0;
  await run({ text: '<<say: 又一句>>', target: 'g1', senderId: 'u2' });
  assert.equal(charged[0].bucket, '');
});

/* ---------------- 试运行：发送之前的副作用也要让开 ---------------- */

/**
 * `<<say>>` 在真正发出去之前还有两步：按人扣语音条额度（落盘 `quota.json`）、
 * 调 TTS 合成（云端要钱）。通道层只拦得住「发出去」，这两步都在 `sendVoice`
 * 之前——不在出站层让开，试运行就会「没发出去、额度没了、钱花了」。
 */
test('试运行：<<say>> 不合成、不扣额度，但照常记成说过', async () => {
  const ch = fakeChannel();
  let synth = 0;
  const charged = [];
  const tts = { synthesize: async () => { synth += 1; return { audio: Buffer.from('RIFFfake') }; } };
  const quota = { charge(p) { charged.push(p); return { ok: true }; } };
  let sent = 0;
  const run = createActionRunner({
    channel: () => ch, tts, quota, dryRunOf: () => true, log: () => {},
  });
  await run({ text: '<<say: 你好>>', target: 'g1', senderId: 'u1', onSent: () => { sent += 1; } });

  assert.equal(synth, 0, '试运行不该调 TTS（云端要钱）');
  assert.equal(charged.length, 0, '试运行不该扣语音条额度');
  assert.equal(ch.calls.filter((c) => c[0] === 'voice').length, 0, '也不该发语音');
  assert.equal(sent, 1, '但要记成「说过」——试运行是记忆照写');
});

test('试运行：关掉之后 <<say>> 照常合成并发送（判据是热读的）', async () => {
  const ch = fakeChannel();
  let synth = 0;
  const charged = [];
  let dry = true;
  const tts = { synthesize: async () => { synth += 1; return { audio: Buffer.from('RIFFfake') }; } };
  const quota = { charge(p) { charged.push(p); return { ok: true }; } };
  const run = createActionRunner({ channel: () => ch, tts, quota, dryRunOf: () => dry });

  await run({ text: '<<say: 一>>', target: 'g1', senderId: 'u1' });
  assert.equal(synth, 0);

  dry = false;
  await run({ text: '<<say: 二>>', target: 'g1', senderId: 'u1' });
  assert.equal(synth, 1, '开关一关就该恢复合成');
  assert.equal(charged.length, 1, '恢复后额度照扣');
  assert.equal(ch.calls.filter((c) => c[0] === 'voice').length, 1);
});

/**
 * 文件发送失败必须能传到调用方（2026-11 复核抓到的真问题）。
 *
 * `qq_send_file` 走的是 `postReply(payload, '', false, {files})`——正文空串，
 * 于是 `run()` 里那条正文分支根本不进，`r` 恒为 `{ok:true, sent:false}`。
 * 以前文件结果被 `log` 一句就丢掉，调用方再怎么判 `ok` 都判不出失败：
 * `turnSt.files`、配额都不回滚，工具还回 `ok:true`。
 */
test('执行：文件发送失败要回 filesOk=false（正文 ok 不受影响）', async () => {
  const ch = fakeChannel({ sendFile: async () => ({ ok: false, message: '上传失败', network: true }) });
  const run = createActionRunner({ channel: () => ch });
  const r = await run({ text: '', target: 'g1', extra: { files: ['C:/tmp/a.png'] } });

  assert.equal(r.filesOk, false, '文件失败要带出来');
  assert.equal(r.ok, true, '正文那条没发，别把 ok 打成 false（上层会重发正文）');
  assert.equal(r.fileErrors.length, 1);
  assert.equal(r.fileErrors[0].network, true, '网络不确定要能识别');
});

test('执行：文件发成功时 filesOk=true，不留多余字段', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  const r = await run({ text: '', target: 'g1', extra: { files: ['C:/tmp/a.png'] } });
  assert.equal(r.filesOk, true);
  assert.equal(r.fileErrors, undefined);
});

/* ---------------- 显示尺寸（2026-11-22） ---------------- */

/**
 * 造一个只有头部正确的 PNG：`dimsOf` 能读出宽高，体积随便填。
 *
 * 只给宽 / 只给高时，「另一边」必须按**真实比例**算出来——拿不到原图尺寸
 * 就只能不写尺寸（退回 480 宽兜底），猜一个比例等于把图压变形。
 */
function fakePng(w, h, bytes = 64) {
  const b = Buffer.alloc(Math.max(bytes, 33), 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

test('尺寸：常见写法都认，只写一边时另一边是 0（表示按原图比例）', () => {
  assert.deepEqual(parseImageSize('320x200'), { w: 320, h: 200 });
  assert.deepEqual(parseImageSize('320×200'), { w: 320, h: 200 });
  assert.deepEqual(parseImageSize('320*200'), { w: 320, h: 200 });
  assert.deepEqual(parseImageSize('320px x 200px'), { w: 320, h: 200 });
  assert.deepEqual(parseImageSize(' 320 X 200 '), { w: 320, h: 200 });
  assert.deepEqual(parseImageSize('320x'), { w: 320, h: 0 });
  assert.deepEqual(parseImageSize('x200'), { w: 0, h: 200 });
  /** 没有分隔符就不是尺寸：`320` 可能是文件名或序号的一部分 */
  assert.equal(parseImageSize('320'), null);
  assert.equal(parseImageSize('x'), null);
  assert.equal(parseImageSize('320xabc'), null);
  /** 离谱的大数收口，不把 `99999` 原样交给平台 */
  assert.equal(parseImageSize('99999x1').w, 4096);
});

test('尺寸：竖线拆值；路径里的空格不会被当分隔符', () => {
  assert.deepEqual(splitImageSize('#3|320x200'), { value: '#3', size: { w: 320, h: 200 } });
  assert.deepEqual(splitImageSize('#3 320x'), { value: '#3', size: { w: 320, h: 0 } });
  const spaced = splitImageSize('C:/Program Files/a.png|320x');
  assert.equal(spaced.value, 'C:/Program Files/a.png', '路径原样，空格不动');
  assert.deepEqual(spaced.size, { w: 320, h: 0 });
  /** 路径里的空格不拆 */
  assert.deepEqual(splitImageSize('C:/a b.png'), { value: 'C:/a b.png', size: null });
  /** 竖线后面不是尺寸：整段留给 sourceOf 判，日志会说是写法不对 */
  assert.deepEqual(splitImageSize('#3|abc'), { value: '#3|abc', size: null });
});

test('尺寸：两个数都写就照写的来（可以放大、缩小、变形）', async () => {
  const ch = fakeChannel();
  const run = createActionRunner({ channel: () => ch });
  await run({ text: '看 <<image: C:/pic/a.png|320x200>> 这张', target: 'g1' });
  const p = ch.calls.find((c) => c[0] === 'send')[1];
  assert.match(p.text, /!\[图片 #320px #200px\]\(qqbot-media:\/\/abc\)/);
  assert.doesNotMatch(p.text, /C:\/pic/);
});

test('尺寸：只给宽时按原图比例补高（读文件头，不猜）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, fakePng(400, 300));
  try {
    const ch = fakeChannel();
    const run = createActionRunner({ channel: () => ch });
    await run({ text: `看 <<image: ${p}|200x>> 这张`, target: 'g1' });
    const sent = ch.calls.find((c) => c[0] === 'send')[1];
    assert.match(sent.text, /#200px #150px/, '400×300 按 200 宽算，高应是 150');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尺寸：读不出原图宽高就退回不带尺寸（框架按 480 兜底）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, 'not really a png');
  try {
    const ch = fakeChannel();
    const run = createActionRunner({ channel: () => ch });
    await run({ text: `看 <<image: ${p}|200x>> 这张`, target: 'g1' });
    const sent = ch.calls.find((c) => c[0] === 'send')[1];
    assert.match(sent.text, /!\[\]\(qqbot-media:\/\/abc\)/, '不知道比例就别写尺寸');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尺寸：独立图带尺寸改走 markdown 单条，不走富媒体', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, fakePng(600, 600));
  try {
    const ch = fakeChannel();
    const run = createActionRunner({ channel: () => ch });
    await run({ text: `给你 <<image-alone: ${p}|240x240>>`, target: 'g1' });
    assert.equal(ch.calls.filter((c) => c[0] === 'file').length, 0, '富媒体没有尺寸字段，不能走它');
    const sends = ch.calls.filter((c) => c[0] === 'send');
    assert.equal(sends.length, 2, '正文一条 + 图一条');
    assert.match(sends[1][1].text, /!\[图片 #240px #240px\]\(qqbot-media:\/\/abc\)/);
    assert.equal(sends[1][1].markdown, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尺寸：图库序号也能带尺寸（序号换成路径后照样生效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, fakePng(1000, 500));
  try {
    const ch = fakeChannel();
    const used = [];
    const run = createActionRunner({
      channel: () => ch,
      resolveImage: (seq) => (seq === 3 ? p : ''),
      onImageUsed: (seq) => used.push(seq),
    });
    await run({ text: '看 <<image: #3|480x240>> 这张', target: 'g1' });
    const sent = ch.calls.find((c) => c[0] === 'send')[1];
    assert.match(sent.text, /#480px #240px/);
    assert.deepEqual(used, [3], '发成功要记一次使用');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尺寸：markdown 关着时退回富媒体，不能把 ![]() 当纯文本发进群', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, fakePng(600, 600));
  try {
    const ch = fakeChannel();
    const logs = [];
    const run = createActionRunner({
      channel: () => ch,
      markdownOf: () => false,
      log: (m) => logs.push(m),
    });
    await run({ text: `给你 <<image-alone: ${p}|240x240>>`, target: 'g1' });
    /** 正文那条照发；不能发的是**带 `![]()` 的**那条——它在群里就是一段文字 */
    assert.equal(ch.calls.filter((c) => c[0] === 'send' && /!\[/.test(c[1].text)).length, 0,
      'markdown 关着时不能把 ![]() 发出去');
    assert.equal(ch.calls.filter((c) => c[0] === 'file').length, 1, '退回富媒体，图还能发出去');
    assert.ok(logs.some((l) => /markdown 关着/.test(l)), '尺寸没生效要留一句日志');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尺寸：markdown 被拒时改按原图重发，图不能整条丢掉', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, fakePng(600, 600));
  try {
    const ch = fakeChannel();
    /**
     * 模拟官方拒 markdown：真实通道会先 `plainOf()` 再降级重发，
     * 而这条消息只有图，剥完是空的，于是返回 `ok:false`。
     */
    ch.send = async (x) => { ch.calls.push(['send', x]); return { ok: false, message: 'markdown 被拒' }; };
    const run = createActionRunner({ channel: () => ch });
    await run({ text: `给你 <<image-alone: ${p}|240x240>>`, target: 'g1' });
    assert.equal(ch.calls.filter((c) => c[0] === 'file').length, 1, '要退回富媒体');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('尺寸：只写高时按原图比例补宽（和文字齐平的 `|x24` 走这条）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-size-'));
  const p = join(dir, 'a.png');
  writeFileSync(p, fakePng(400, 300));
  try {
    const ch = fakeChannel();
    const run = createActionRunner({ channel: () => ch });
    await run({ text: `这样<<image: ${p}|x150>>就夹在字里了`, target: 'g1' });
    const sent = ch.calls.find((c) => c[0] === 'send')[1];
    /** 400×300 按 150 高算，宽应是 200 */
    assert.match(sent.text, /#200px #150px/);
    /** 行内插图：图仍在原位置，前后文字都还在同一条里 */
    assert.match(sent.text, /^这样!\[.*\]\(qqbot-media:\/\/abc\)就夹在字里了$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
