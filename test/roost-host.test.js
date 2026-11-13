// 直连 roost 外接协议：客户端（RPC + SSE）、事件整形、通道。
//
// 这一层替换掉的是 ai-chat 的**全部**上游职责，所以测试重点不是"能连通"，
// 而是**两条线上踩过的整形坑不能复发**：
//   1. 语音有转写时还写「（发了条语音）」→ 模型把说明当正文
//   2. 以文件形式发的图说成「发了个文件」→ 模型只看到文件名
//
// 另外要验「回话不走 HTTP 回调」：payload 里没有 `reply.url`，
// 靠 `__channel.send` 直接走通道——这是和 ai-chat 唯一的真差异。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createRoostHost, protocolAlive } from '../src/roost-host.js';
import { createRoostHostChannel } from '../src/channel.js';
import { createMerger, textOf } from '../src/roost-merge.js';
import {
  buildRendered, describeAttachments, isImageAttachment, createPayloadBuilder,
} from '../src/roost-payload.js';

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function json(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** 起一个假 roost，返回 baseUrl */
async function withFake(t, handler) {
  const srv = createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  /**
   * 收尾必须强制断开：SSE 是长连接，`server.close()` 会一直等它自己结束，
   * 而客户端要等 host.stop() 才断——两边互等就死锁。
   */
  t.after(() => new Promise((r) => {
    srv.closeAllConnections?.();
    srv.close(() => r());
  }));
  return `http://127.0.0.1:${srv.address().port}`;
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等待超时');
}

/* ------------------------------------------------------------------ */
/* 整形：两个线上踩过的坑                                              */
/* ------------------------------------------------------------------ */

test('整形：语音**有转写时一个字都不写**，没转写才提示', () => {
  assert.deepEqual(
    describeAttachments({ attachments: [{ type: 'voice', asrText: '你好呀' }] }, []),
    [],
    '转写本身就是正文，再补一句说明会把它的分量稀释掉',
  );
  const noAsr = describeAttachments({ attachments: [{ type: 'voice' }] }, []);
  assert.match(noAsr[0], /没转出文字/);
});

test('整形：以文件形式发的图要按图说，不能说成「发了个文件」', () => {
  assert.equal(isImageAttachment({ type: 'file', url: 'u', filename: 'a.png' }), true);
  assert.equal(isImageAttachment({ type: 'file', url: 'u', filename: 'a.zip' }), false);
  assert.equal(isImageAttachment({ type: 'image', url: 'u' }), true);
  assert.equal(isImageAttachment({ type: 'file', url: '' }), false);

  const out = describeAttachments({ attachments: [{ type: 'file', url: 'u', filename: 'a.png' }] }, []);
  assert.match(out[0], /发来一张图/);
  assert.doesNotMatch(out[0], /发了个文件/);
});

test('整形：正文顺序是先说的话、再引用、再附件/卡片', () => {
  const text = buildRendered({
    quoted: '上一句',
    attachments: [{ type: 'file', url: 'u', filename: 'x.zip', size: 2048 }],
    elements: [{ type: 'ark', ark: { title: '卡片', desc: '说明' } }],
    ark: { title: '顶层卡' },
  }, '看这个', { images: [] });
  const lines = text.split('\n');
  assert.equal(lines[0], '看这个');
  assert.match(lines[1], /引用了这句/);
  assert.match(text, /x\.zip/);
  assert.match(text, /卡片消息/);
});

test('整形：空消息也有兜底文案，不会传个空串给模型', () => {
  assert.equal(buildRendered({}, ''), '（发来一条空消息）');
});

/* ------------------------------------------------------------------ */
/* payload                                                             */
/* ------------------------------------------------------------------ */

test('payload：回话走 __channel 而不是 HTTP 回调，id 用 eventId', async () => {
  const calls = [];
  const build = createPayloadBuilder({
    rpc: async (m, p) => { calls.push([m, p]); return { bucket: 'member', level: 10, role: '成员' }; },
    vision: false,
  });
  const send = () => {};
  const p = await build({
    eventId: 'EVT_1', msgId: 'MSG_1', traceId: 'TR_1', at: 1700000000000,
    content: '在吗',
    chat: { kind: 'group', chatId: 'G1', groupId: 'G1', name: '测试群', groupUin: '100', groupAliases: ['GA'] },
    sender: { openid: 'U1', name: '小明', uin: '20001', aliases: ['UA'] },
    attachments: [], elements: [], quoted: '',
  }, { send });

  assert.equal(p.id, 'EVT_1', 'id 要能反查账本，随机 UUID 查不到');
  assert.equal(p.eventIds[0], 'EVT_1');
  assert.equal(p.reply.url, undefined, '直连没有 HTTP 回调地址');
  assert.equal(typeof p.reply.expiresAt, 'number', '排队预算还是要给');
  assert.equal(typeof p.__channel.send, 'function');

  assert.equal(p.chat.kind, 'group');
  assert.equal(p.chat.name, '测试群');
  assert.deepEqual(p.chat.aliases, ['GA'], '群会话读群的别名，别混进人的');
  assert.equal(p.sender.bucket, 'member', '权限档位要算出来，否则按身份不明处理');
  assert.equal(calls[0][0], 'roles.resolve');
  assert.equal(p.rendered, '在吗');
  assert.equal(p.system, '', '人格归 dsh-roost 自己管');
});

test('payload：私聊时 chat.name 用昵称，不拿群名兜底', async () => {
  const build = createPayloadBuilder({ rpc: async () => null, vision: false });
  const p = await build({
    eventId: 'E', msgId: 'M', content: 'hi',
    chat: { kind: 'c2c', chatId: 'U1', groupId: '', name: '', groupUin: '' },
    sender: { openid: 'U1', name: '小明', uin: '', aliases: ['UA'] },
    attachments: [], elements: [],
  }, { send: () => {} });
  assert.equal(p.chat.name, '小明');
  assert.deepEqual(p.chat.aliases, ['UA'], '私聊读人的别名');
});

test('payload：权限查不到就不带 bucket（按身份不明，比错报成普通成员安全）', async () => {
  const build = createPayloadBuilder({
    rpc: async () => { throw new Error('boom'); },
    vision: false,
    log: () => {},
  });
  const p = await build({
    eventId: 'E', msgId: 'M', content: 'x',
    chat: { kind: 'group', chatId: 'G', groupId: 'G', name: 'g' },
    sender: { openid: 'U', name: 'u', uin: '' },
    attachments: [], elements: [],
  }, { send: () => {} });
  assert.equal('bucket' in p.sender, false);
});

/* ------------------------------------------------------------------ */
/* 客户端                                                              */
/* ------------------------------------------------------------------ */

test('rpc：成功取 data，失败带 code（上层要靠它区分权限/未就绪/参数错）', async (t) => {
  const base = await withFake(t, (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = JSON.parse(body);
      if (f.method === 'system.ping') return json(res, { id: f.id, ok: true, data: { pong: 1 } });
      return json(res, { id: f.id, ok: false, error: { code: 'NO_SCOPE', message: '没权限' } }, 403);
    });
  });
  const h = createRoostHost({ baseUrl: base });
  assert.deepEqual(await h.rpc('system.ping'), { pong: 1 });
  await assert.rejects(
    () => h.rpc('config.set', {}),
    (e) => e.code === 'NO_SCOPE' && /没权限/.test(e.message),
  );
});

test('rpc：地址没配 / 连不上要给人话，不能只说 fetch failed', async () => {
  const h = createRoostHost({ baseUrl: '' });
  await assert.rejects(() => h.rpc('system.ping'), (e) => e.code === 'NO_ADDR');

  const dead = createRoostHost({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => dead.rpc('system.ping'),
    (e) => e.code === 'NETWORK' && /连不上 roost/.test(e.message),
  );
});

test('SSE：收到 message 事件、记下 seq、注释行与心跳不捣乱', async (t) => {
  const seen = [];
  const base = await withFake(t, (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/events') return json(res, {}, 404);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': roost-host/1\n\n');
    res.write(`id: 1\nevent: welcome\ndata: ${JSON.stringify({ type: 'welcome', seq: 1, bot: { id: 'b1' } })}\n\n`);
    res.write(`id: 2\nevent: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat', seq: 2 })}\n\n`);
    res.write(`id: 3\nevent: message\ndata: ${JSON.stringify({ type: 'event', seq: 3, event: 'message', data: { content: '你好' } })}\n\n`);
    // 故意不关：模拟真实长连接
  });
  const h = createRoostHost({ baseUrl: base, onMessage: (d) => seen.push(d.content) });
  h.start();
  await waitFor(() => seen.length === 1);
  assert.deepEqual(seen, ['你好']);
  assert.equal(h.status().seq, 3, '心跳也会推进 seq，但不会当消息派发');
  assert.equal(h.status().bot.id, 'b1');
  h.stop();
});

test('SSE：重连带 since，补拉不会从头再来', async (t) => {
  const sinces = [];
  const base = await withFake(t, (req, res) => {
    const u = new URL(req.url, 'http://x');
    sinces.push(u.searchParams.get('since'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (sinces.length === 1) {
      res.write(`id: 7\nevent: message\ndata: ${JSON.stringify({ type: 'event', seq: 7, event: 'message', data: { content: 'a' } })}\n\n`);
      /** 第一轮直接断，逼它重连 */
      return setTimeout(() => res.end(), 30);
    }
    res.write(`id: 8\nevent: message\ndata: ${JSON.stringify({ type: 'event', seq: 8, event: 'message', data: { content: 'b' } })}\n\n`);
  });
  const seen = [];
  const h = createRoostHost({ baseUrl: base, onMessage: (d) => seen.push(d.content), log: () => {} });
  h.start();
  await waitFor(() => seen.length >= 2, 5000);
  assert.deepEqual(seen, ['a', 'b']);
  assert.deepEqual(sinces.slice(0, 2), ['0', '7'], '第二次建连要带上一轮的最后 seq');
  h.stop();
});

test('SSE 401：停下来并说清是 token 不对，不无限重试', async (t) => {
  let hits = 0;
  const base = await withFake(t, (req, res) => {
    hits += 1;
    res.writeHead(401);
    res.end();
  });
  const states = [];
  const h = createRoostHost({ baseUrl: base, onState: (s, d) => states.push([s, d]), log: () => {} });
  h.start();
  await waitFor(() => states.some(([s]) => s === 'error'));
  assert.match(h.status().lastError, /token/);
  /** 给退避留一点时间，确认它没有再打第二次 */
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hits, 1, 'token 错了重连一万次还是错，只会刷满日志');
  h.stop();
});

test('SSE：gap 帧要让上层知道（丢消息不能静默）', async (t) => {
  const gaps = [];
  const base = await withFake(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: gap\ndata: ${JSON.stringify({ type: 'gap', seq: 99 })}\n\n`);
  });
  const h = createRoostHost({ baseUrl: base, onGap: (f) => gaps.push(f.seq) });
  h.start();
  await waitFor(() => gaps.length === 1);
  assert.deepEqual(gaps, [99]);
  h.stop();
});

test('事件处理抛错不能把流带崩（后面还有消息要收）', async (t) => {
  const base = await withFake(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`id: 1\nevent: message\ndata: ${JSON.stringify({ type: 'event', seq: 1, event: 'message', data: { content: 'boom' } })}\n\n`);
    res.write(`id: 2\nevent: message\ndata: ${JSON.stringify({ type: 'event', seq: 2, event: 'message', data: { content: 'ok' } })}\n\n`);
  });
  const seen = [];
  const h = createRoostHost({
    baseUrl: base,
    onMessage: (d) => {
      if (d.content === 'boom') throw new Error('处理炸了');
      seen.push(d.content);
    },
    log: () => {},
  });
  h.start();
  /**
   * 8 秒而不是默认 3 秒：全量测试并发几十个文件时，SSE 建连偶尔要等几百毫秒，
   * 3 秒在慢机器上会偶发误报（单文件跑三次都过、全量偶尔红）。断言本身没变。
   */
  await waitFor(() => seen.length === 1, 8000);
  assert.deepEqual(seen, ['ok']);
  h.stop();
});

/* ------------------------------------------------------------------ */
/* 通道                                                                */
/* ------------------------------------------------------------------ */

test('通道：回复带 msgId/receivedAt（被动），主动消息不带', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'MSG_9' }; } };
  const ch = createRoostHostChannel({ host });

  const r = await ch.send({ scene: 'group', target: 'g', text: '回你', msgId: 'M1', receivedAt: 1700 });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'MSG_9');
  assert.equal(calls[0][0], 'msg.send');
  assert.equal(calls[0][1].kind, 'group');
  assert.equal(calls[0][1].msgId, 'M1');
  assert.equal(calls[0][1].receivedAt, 1700);
  assert.ok(calls[0][1].requestId, '每次都要有幂等键，否则投递账本查不到');

  calls.length = 0;
  await ch.send({ scene: 'c2c', target: 'u', text: '在的' });
  assert.equal(calls[0][1].msgId, undefined, '主动消息不能挂别人的 msgId');
});

test('通道：静默先设再发，只静默不说话也算成功', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: '' }; } };
  const ch = createRoostHostChannel({ host });
  const r = await ch.send({ scene: 'group', target: 'g', text: '', silenceMs: 7200_000 });
  assert.equal(r.ok, true);
  assert.equal(r.silentOnly, true);
  assert.equal(calls[0][0], 'gate.silence');
  assert.equal(calls[0][1].ms, 7200_000);
});

test('通道：框架拒了带 code，网络错带 network', async () => {
  const mk = (code) => ({ rpc: async () => { throw Object.assign(new Error('x'), { code }); } });
  const a = await createRoostHostChannel({ host: mk('NO_SCOPE') }).send({ scene: 'group', target: 'g', text: 'x' });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'NO_SCOPE');
  assert.equal(a.network, false);

  const b = await createRoostHostChannel({ host: mk('NETWORK') }).send({ scene: 'group', target: 'g', text: 'x' });
  assert.equal(b.network, true, '上层据此区分「对方拒绝」和「根本没连上」');
});

test('通道：群主动没授权就本地拦下，不去打接口', async () => {
  let called = 0;
  const host = { rpc: async () => { called += 1; return {}; } };
  const ch = createRoostHostChannel({ host });
  const r = await ch.send({ scene: 'group', target: 'g', text: 'x', hasGroupAuthz: false });
  assert.equal(r.ok, false);
  assert.match(r.message, /group_push/);
  assert.equal(called, 0);
});

test('通道：delivery 与 ping 走对应的协议方法', async () => {
  const calls = [];
  const host = {
    rpc: async (m, p) => {
      calls.push([m, p]);
      if (m === 'delivery.get') return { ok: true, state: 'sent', parts: 2 };
      return { pong: 1 };
    },
  };
  const ch = createRoostHostChannel({ host });
  const d = await ch.delivery('rid-1');
  assert.equal(d.state, 'sent');
  assert.equal(d.parts, 2);
  const p = await ch.ping();
  assert.equal(p.ok, true);
  assert.deepEqual(calls.map((c) => c[0]), ['delivery.get', 'system.ping']);
});

/* ------------------------------------------------------------------ */
/* 合并窗口                                                            */
/* ------------------------------------------------------------------ */

const mkEvt = (content, extra = {}) => ({
  content,
  eventId: `E-${content}`,
  msgId: `M-${content}`,
  chat: { chatId: 'G', kind: 'group' },
  sender: { name: '小明', openid: 'U1', uin: '10001' },
  attachments: [],
  elements: [],
  ...extra,
});

test('textOf：纯语音的正文在 asrText 里，不能读成空串', () => {
  assert.equal(textOf({ content: '', attachments: [{ type: 'voice', asrText: '你好' }] }), '你好');
  assert.equal(textOf({ content: '正文优先', attachments: [{ type: 'voice', asrText: '转写' }] }), '正文优先');
  assert.equal(textOf({ content: '', attachments: [] }), '');
});

test('合并：连发两句只触发一轮，附件跨条合并', async () => {
  const flushed = [];
  const m = createMerger({ waitSec: 0.05, maxSec: 0.3, onFlush: (_id, b) => flushed.push(b) });
  m.add(mkEvt('在吗'));
  m.add(mkEvt('问你个事', { attachments: [{ type: 'image', url: 'u' }] }));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(flushed.length, 1, '两句合成一轮，否则等于跑两次模型');
  assert.equal(flushed[0].count, 2);
  assert.equal(flushed[0].multi, true);
  assert.equal(flushed[0].attachments.length, 1, '先发图再补话，图不能丢');
  assert.match(flushed[0].text, /小明\(QQ 10001 \/ U1\)：在吗/);
  assert.equal(flushed[0].msg.msgId, 'M-问你个事', '回复要挂最后一条，被动窗口最稳');
});

test('合并：窗口参数现读，面板改了不用重启 DSH', async () => {
  const flushed = [];
  let waitSec = 0.02;
  const m = createMerger({
    waitSec: () => waitSec, maxSec: 1,
    onFlush: (_id, b) => flushed.push(b),
  });
  m.add(mkEvt('第一批'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(flushed.length, 1, '20ms 的窗口该先放行');

  /** 如果是构造时读一次，这里改了也没用，80ms 就会放行 */
  waitSec = 0.25;
  m.add(mkEvt('第二批'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(flushed.length, 1, '改成 250ms 后，80ms 时不该放行');
  await new Promise((r) => setTimeout(r, 220));
  assert.equal(flushed.length, 2, '250ms 后第二批放行');
  m.dispose();
});

test('合并：私聊 / 被 @ 立刻放行，不等那 1.5 秒', () => {
  const flushed = [];
  const m = createMerger({ waitSec: 5, maxSec: 5, onFlush: (_id, b) => flushed.push(b) });
  m.add({ ...mkEvt('在'), chat: { chatId: 'U', kind: 'c2c' } }, { force: true });
  assert.equal(flushed.length, 1, '私聊还等就是迟钝');
  assert.equal(flushed[0].count, 1);
  m.dispose();
});

test('合并：maxSec 到了必须放行，对方一直发也不能无限等', async () => {
  const flushed = [];
  const m = createMerger({ waitSec: 0.5, maxSec: 0.12, onFlush: (_id, b) => flushed.push(b) });
  const t = setInterval(() => m.add(mkEvt('x')), 30);
  await new Promise((r) => setTimeout(r, 260));
  clearInterval(t);
  assert.ok(flushed.length >= 1, 'maxSec 到点必须交出去');
  m.dispose();
});

test('合并：dispose 只清定时器，不往外发', async () => {
  const flushed = [];
  const m = createMerger({ waitSec: 0.05, maxSec: 0.1, onFlush: (_id, b) => flushed.push(b) });
  m.add(mkEvt('还没说完'));
  m.dispose();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(flushed.length, 0, '插件都卸了，不该再说话');
  assert.equal(m.size, 0);
});

/* ------------------------------------------------------------------ */
/* 接话策略（从 ai-chat 搬过来的那一层）                                */
/* ------------------------------------------------------------------ */

test('策略：私聊与被 @ 一律接，且不走冷却', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  const d = createDecider({ cfg: () => ({ roostHost: { decide: { cooldownSec: 600 } } }), now: () => 1000 });
  const c2c = d.check({ chat: { chatId: 'U', kind: 'c2c' }, content: 'x' });
  assert.equal(c2c.go, true);
  assert.equal(c2c.force, true);
  const at = d.check({ chat: { chatId: 'G', kind: 'group' }, content: 'x', mentioned: true });
  assert.equal(at.go, true);
  assert.equal(at.force, true);
});

test('策略：忽略词与空消息不接（别抢别的插件的指令）', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  const d = createDecider({ cfg: () => ({ roostHost: { decide: {} } }), now: () => 1000 });
  assert.equal(d.check({ chat: { chatId: 'G', kind: 'group' }, content: '/roll' }).go, false);
  assert.equal(d.check({ chat: { chatId: 'G', kind: 'group' }, content: '', attachments: [] }).go, false);
  /** 纯语音有 asrText 就不算空 */
  const voice = d.check({
    chat: { chatId: 'G', kind: 'group' }, content: '',
    attachments: [{ type: 'voice', asrText: '在吗' }],
  });
  assert.equal(voice.go, true);
});

test('策略：mention 模式只在被 @ 时接', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  const d = createDecider({ cfg: () => ({ roostHost: { decide: { mode: 'mention' } } }), now: () => 1000 });
  assert.equal(d.check({ chat: { chatId: 'G', kind: 'group' }, content: '随便聊聊' }).go, false);
});

test('策略：window 模式的窗口只由真 @ 打开', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  let t = 1_000_000;
  const d = createDecider({
    cfg: () => ({ roostHost: { decide: { mode: 'window', windowMin: 3 } } }),
    now: () => t,
  });
  const base = { chat: { chatId: 'G', kind: 'group' }, content: '嗯' };
  assert.equal(d.check(base).go, false, '还没被 @ 过');
  d.check({ ...base, mentioned: true });
  t += 60_000;
  assert.equal(d.check(base).go, true, '窗口内');
  t += 5 * 60_000;
  assert.equal(d.check(base).go, false, '窗口过了要恢复安静');
});

test('策略：冷却期内不丢消息，压到冷却结束再交', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  let t = 1_000_000;
  const d = createDecider({
    cfg: () => ({ roostHost: { decide: { cooldownSec: 20, maxRepliesPerMin: 0 } } }),
    now: () => t,
  });
  const evt = { chat: { chatId: 'G', kind: 'group' }, content: '接着说' };
  d.noteReplied('G');
  t += 5_000;
  const v = d.check(evt);
  assert.equal(v.go, true, '不能丢');
  assert.equal(v.cooling, true);
  assert.ok(v.delayMs > 0 && v.delayMs <= 15_000, `还剩 15 秒左右，实际 ${v.delayMs}`);
});

test('策略：每分钟条数用满就不接', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  let t = 1_000_000;
  const d = createDecider({
    cfg: () => ({ roostHost: { decide: { cooldownSec: 0, maxRepliesPerMin: 2 } } }),
    now: () => t,
  });
  const evt = { chat: { chatId: 'G', kind: 'group' }, content: 'x' };
  d.noteReplied('G'); d.noteReplied('G');
  assert.equal(d.check(evt).go, false);
  t += 61_000;
  assert.equal(d.check(evt).go, true, '过了一分钟额度要恢复');
});

test('策略：静默时段与短问必答', async () => {
  const { createDecider } = await import('../src/roost-decide.js');
  const h = new Date().getHours();
  const d = createDecider({
    cfg: () => ({
      roostHost: {
        decide: {
          cooldownSec: 0, maxRepliesPerMin: 0,
          quietStartHour: h, quietEndHour: (h + 2) % 24,
          shortAskMustReply: true,
        },
      },
    }),
    now: () => 1_000_000,
  });
  assert.equal(d.check({ chat: { chatId: 'G', kind: 'group' }, content: '随便说点什么' }).go, false);
  const ask = d.check({ chat: { chatId: 'G', kind: 'group' }, content: '在吗？' });
  assert.equal(ask.go, true, '明确在叫人时刹车不该拦');
  assert.equal(ask.force, true);
});

test('通道：sendFile 按扩展名判 fileType（判错会把 zip 当图片发，官方直接拒）', async () => {
  const calls = [];
  const host = { rpc: async (m, p) => { calls.push([m, p]); return { id: 'F1' }; } };
  const ch = createRoostHostChannel({ host });

  await ch.sendFile({ scene: 'group', target: 'g', path: '/a/b.zip', msgId: 'M-1', receivedAt: 1700 });
  assert.equal(calls[0][0], 'media.send', '文件要走 media.send，不是 msg.send');
  assert.equal(calls[0][1].fileType, 4, 'zip 是普通文件');
  assert.equal(calls[0][1].msgId, 'M-1', '文件也要挂被动回复');
  assert.equal(calls[0][1].receivedAt, 1700);

  calls.length = 0;
  await ch.sendFile({ scene: 'c2c', target: 'u', path: 'C://a//b.PNG' });
  assert.equal(calls[0][1].fileType, 1, '大小写不影响判图');

  calls.length = 0;
  await ch.sendFile({ scene: 'group', target: 'g', path: '/a/v.mp4' });
  assert.equal(calls[0][1].fileType, 2);

  calls.length = 0;
  await ch.sendFile({ scene: 'group', target: 'g', path: '/a/v.silk' });
  assert.equal(calls[0][1].fileType, 3);

  const bad = await ch.sendFile({ scene: 'group', target: 'g', path: '' });
  assert.equal(bad.ok, false);
});

/* ------------------------------------------------------------------ */
/* 事件通道：WS 优先 / 自动降级 SSE / 强制 WS                         */
/* ------------------------------------------------------------------ */

/** 假 WebSocket：够验「连上、收帧、关闭」就行，不实现握手 */
function fakeWsClass({ failOnOpen = null, frames = [] } = {}) {
  const made = [];
  class FakeWS {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
      this.handlers = {};
      /** 客户端主动发出的帧（hello / ping…），用来验握手有没有补齐 */
      this.sent = [];
      made.push(this);
      setTimeout(() => {
        if (failOnOpen) {
          this.handlers.error?.(failOnOpen);
          return;
        }
        this.handlers.open?.({});
        for (const f of frames) this.handlers.message?.(JSON.stringify(f));
      }, 0);
    }

    on(ev, fn) { (this.handlers[ev] ||= []).push ? null : null; this.handlers[ev] = fn; }

    send(data) { this.sent.push(String(data)); }

    close() { this.handlers.close?.(); }
  }
  FakeWS.made = made;
  return FakeWS;
}

test('没启动 Roost 时不去连：挂 waiting，一个请求都不发', async (t) => {
  /**
   * 框架没启动时反复 fetch 只会刷一屏 `fetch failed`，用户会去查网络和端口，
   * 而真相只是「还没开」。所以先探活，没跑就等着。
   */
  let fetched = 0;
  const states = [];
  const host = createRoostHost({
    baseUrl: () => 'http://127.0.0.1:6807',
    token: () => 'tk',
    transport: 'auto',
    canConnect: async () => false,
    waitPollMs: 20,
    loadWs: async () => null,
    fetchImpl: async () => { fetched += 1; throw new Error('不该发请求'); },
    onState: (st, d) => states.push([st, d]),
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => states.some(([s]) => s === 'waiting'));
  const w = states.find(([s]) => s === 'waiting');
  assert.match(w[1], /没在运行/, '要说清是「没启动」而不是「连不上」');
  assert.equal(fetched, 0, '没跑就一个请求都不该发');
  assert.equal(host.connected, false);
});

test('Roost 起来后自动从 waiting 转成已连接', async (t) => {
  let up = false;
  const base = await withFake(t, (req, res) => {
    if (req.url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"welcome","seq":2}\n\n');
      return;
    }
    json(res, { ok: true });
  });
  const host = createRoostHost({
    baseUrl: () => base,
    token: () => 'tk',
    transport: 'sse',
    canConnect: async () => up,
    waitPollMs: 20,
    onState: () => {},
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => host.status().state === 'waiting');
  up = true;
  await waitFor(() => host.connected, 5000);
  assert.equal(host.status().seq, 2, '起来之后要能正常收事件');
});

test('事件通道：auto + 有 ws 时优先走 WS，并带上 since 与 Bearer', async (t) => {
  const WS = fakeWsClass({ frames: [{ type: 'welcome', seq: 7, bot: { id: 'b1' } }] });
  const host = createRoostHost({
    baseUrl: () => 'http://127.0.0.1:6801',
    token: () => 'tk',
    transport: 'auto',
    loadWs: async () => ({ WebSocket: WS }),
    fetchImpl: async () => { throw new Error('不该走 HTTP'); },
    onState: () => {},
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => host.connected);

  assert.equal(WS.made.length, 1, '应该建了一条 WS');
  assert.ok(WS.made[0].url.startsWith('ws://127.0.0.1:6801/ws'), 'http 要换成 ws 并指向 /ws');
  assert.ok(WS.made[0].url.endsWith('/ws?since=0'), '必须带 since 才能补拉');
  assert.equal(WS.made[0].opts.headers.authorization, 'Bearer tk', 'token 走 header，不进 URL');
  assert.equal(host.status().transport, 'ws');
  assert.equal(host.status().seq, 7, 'WS 帧里的 seq 要正常推进');
});

test('事件通道：auto 下 WS 连不上就降级 SSE，且不再反复试 WS', async (t) => {
  const WS = fakeWsClass({ failOnOpen: Object.assign(new Error('连不上'), { code: 'ECONNREFUSED' }) });
  let sseHits = 0;
  const base = await withFake(t, (req, res) => {
    if (req.url.startsWith('/events')) {
      sseHits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"welcome","seq":3}\n\n');
      return;
    }
    json(res, { ok: true });
  });
  const host = createRoostHost({
    baseUrl: () => base,
    token: () => 'tk',
    transport: 'auto',
    loadWs: async () => ({ WebSocket: WS }),
    onState: () => {},
    log: () => {},
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => host.connected);
  await waitFor(() => host.status().transport === 'sse');

  assert.ok(sseHits >= 1, 'WS 失败后必须落到 SSE');
  assert.equal(host.status().transport, 'sse');
  assert.equal(host.status().seq, 3);
});

test('事件通道：降级 SSE 是暂时的——WS 恢复后会切回去', async (t) => {
  /**
   * 启动顺序经常是「插件先起、框架后起」，第一次 WS 必然失败。
   * 如果因此永久放弃 WS，用户装了 ws 也永远用不上。这里用假定时器把
   * 冷却压缩到 0，验证它会再试一次并切回 WS。
   */
  let failWs = true;
  const WS = fakeWsClass({ frames: [{ type: 'welcome', seq: 9 }] });
  // 第一次连接失败，之后成功
  const Original = WS;
  class FlakyWS extends Original {
    constructor(url, opts) {
      super(url, opts);
      if (failWs) {
        failWs = false;
        setTimeout(() => this.handlers.error?.(new Error('刚起来还没绑好')), 0);
      }
    }
  }

  let sseHits = 0;
  const base = await withFake(t, (req, res) => {
    if (req.url.startsWith('/events')) {
      sseHits += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"welcome","seq":1}\n\n');
      return;
    }
    json(res, { ok: true });
  });

  const host = createRoostHost({
    baseUrl: () => base,
    token: () => 'tk',
    transport: 'auto',
    loadWs: async () => ({ WebSocket: FlakyWS }),
    /**
     * 把 5 分钟冷却压到 400ms，否则这条测试要等 5 分钟。
     * 别压到几十毫秒：全量跑时测试文件是并发调度的，冷却在 SSE 建立之前
     * 就过去的话，WS 会先重连成功，`sseHits` 永远是 0（2026-11-14 实测偶发）。
     */
    wsRetryCooldownMs: 400,
    onState: () => {},
    log: () => {},
  });
  t.after(() => host.stop());
  host.start();

  await waitFor(() => host.connected);
  assert.equal(host.status().transport, 'sse', '第一次 WS 失败应先落到 SSE');
  assert.ok(sseHits >= 1);

  /** 冷却到点会主动断开 SSE 重连，第二次 WS 就能连上 */
  await waitFor(() => host.status().transport === 'ws', 8000);
  assert.equal(host.status().transport, 'ws', 'WS 恢复后必须切回去，不能永久停在 SSE');
});

test('事件通道：强制 ws 但没装依赖 → 明确报错并停止，不静默降级', async (t) => {
  const states = [];
  const host = createRoostHost({
    baseUrl: () => 'http://127.0.0.1:6801',
    token: () => 'tk',
    transport: 'ws',
    loadWs: async () => null,
    fetchImpl: async () => { throw new Error('不该走 HTTP'); },
    onState: (s, d) => states.push([s, d]),
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => states.some(([s]) => s === 'error'));
  const err = states.find(([s]) => s === 'error');
  assert.match(err[1], /没装可选依赖 ws/);
  assert.equal(host.connected, false);
});

test('事件通道：transport=sse 时不加载 ws', async (t) => {
  let loaded = 0;
  const base = await withFake(t, (req, res) => {
    if (req.url.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"type":"welcome","seq":1}\n\n');
      return;
    }
    json(res, { ok: true });
  });
  const host = createRoostHost({
    baseUrl: () => base,
    token: () => 'tk',
    transport: 'sse',
    loadWs: async () => { loaded += 1; return null; },
    onState: () => {},
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => host.connected);
  assert.equal(loaded, 0, '显式选 SSE 就不该去碰 ws');
  assert.equal(host.status().transport, 'sse');
});

/* ---------------- 连接前探活：先问外接协议，别绕面板 ---------------- */

test('protocolAlive：外接协议 /health 通就返回 true，且尾斜杠不会拼出 //health', async () => {
  const calls = [];
  const fetchImpl = async (u) => { calls.push(String(u)); return { ok: true }; };
  assert.equal(await protocolAlive({ url: 'http://127.0.0.1:6807/', fetchImpl }), true);
  assert.deepEqual(calls, ['http://127.0.0.1:6807/health']);
  /** 请求必须带超时：网络挂住时不能把连接循环永远拖在探活上 */
  assert.ok(calls.length === 1);
});

test('protocolAlive：地址为空 / 非 200 / 网络异常都返回 false，绝不抛', async () => {
  assert.equal(await protocolAlive({ url: '', fetchImpl: async () => { throw new Error('不该发请求'); } }), false);
  assert.equal(await protocolAlive({ url: 'http://127.0.0.1:6807', fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await protocolAlive({ url: 'http://127.0.0.1:6807', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), false);
});

test('接线：canConnect 先探外接协议 /health，6807 不通才退回面板探活', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const i = src.indexOf('canConnect: async () => {');
  assert.ok(i > 0, 'host.js 里要有 canConnect');
  const block = src.slice(i, i + 1400);
  assert.match(block, /protocolAlive\(/, '必须先探外接协议自己的 /health');
  assert.match(block, /setup\.isRunning\(\)/, '6807 不通时仍保留面板探活兜底');
  /**
   * 只认**代码行**：上面的说明注释里也提到了 `setup.isRunning()`，
   * 用裸字符串比位置会被注释骗到。
   */
  const probe = block.indexOf('if (await protocolAlive(');
  const fallback = block.indexOf('return await setup.isRunning();');
  assert.ok(probe > 0, '要有「先探 6807」这条判断');
  assert.ok(fallback > 0, '要有「再退回面板探活」这条兜底');
  assert.ok(probe < fallback, '顺序不能反：面板探活失败不该挡住 6807 已就绪的连接');
});

/* ---------------- WS 握手：必须先发 hello 才会被服务端注册为订阅者 ---------------- */

test('WS：连上后必须按协议先发 hello（否则服务端不 attach，事件一条都收不到）', async (t) => {
  /**
   * 框架的 `wss.on('connection')` 把 `attach()` + `sinks.set()` + 回 welcome
   * 放在第一条 hello/req 里。以前客户端连上只把本地状态置成 online，
   * TCP 是通的、订阅表里却没它 —— 症状是：面板显示已连接、测试连接也绿，
   * 但 /health 的 connections 恒为 0，消息一条都推不过来。
   */
  const WS = fakeWsClass({ frames: [{ type: 'welcome', seq: 7, bot: { id: 'b1' } }] });
  const host = createRoostHost({
    baseUrl: () => 'http://127.0.0.1:6801',
    token: () => 'tk',
    transport: 'ws',
    loadWs: async () => ({ WebSocket: WS }),
    fetchImpl: async () => { throw new Error('不该走 HTTP'); },
    onState: () => {},
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => host.connected);
  await waitFor(() => WS.made[0]?.sent.length > 0);

  const hello = JSON.parse(WS.made[0].sent[0]);
  assert.equal(hello.type, 'hello', '框架要收到 hello 才注册订阅者');
  assert.equal(hello.protocol, 1);
  assert.equal(hello.client, 'dsh-roost');
  assert.equal(hello.since, 0, 'hello 的 since 要和 URL 上的一致');
  assert.ok(WS.made[0].url.endsWith('/ws?since=0'));
  assert.equal(WS.made[0].sent.length, 1, '连上只发一条 hello，不要夹带别的帧');
});

test('WS：断线重连时 hello 的 since 要带上已收到的最大 seq', async (t) => {
  const WS = fakeWsClass({ frames: [{ type: 'welcome', seq: 7, bot: { id: 'b1' } }] });
  const host = createRoostHost({
    baseUrl: () => 'http://127.0.0.1:6801',
    token: () => 'tk',
    transport: 'ws',
    loadWs: async () => ({ WebSocket: WS }),
    fetchImpl: async () => { throw new Error('不该走 HTTP'); },
    onState: () => {},
  });
  t.after(() => host.stop());
  host.start();
  await waitFor(() => host.status().seq === 7);

  /** 服务端关掉连接 → pump 退避重连，这时必须拿新 seq 去补拉 */
  WS.made[0].close();
  await waitFor(() => WS.made.length >= 2 && WS.made[1].sent.length > 0);
  const hello2 = JSON.parse(WS.made[1].sent[0]);
  assert.equal(hello2.type, 'hello');
  assert.equal(hello2.since, 7, '重连要补拉断线期间的事件，不能从 0 开始');
  assert.ok(WS.made[1].url.endsWith('/ws?since=7'), 'URL 与 hello 里的 since 要一致');
});
