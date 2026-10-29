// QQ 动作工具（`qq_send` / `qq_close`）的测试。
//
// 这两个工具出错的表现都是**社交事故**：段数没上限就是刷屏，
// 收尾判错就是「问题没答完就跑了」。所以断言盯拒绝路径，不盯成功路径的措辞。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQqToolDefs, buildAtPrefix, MAX_PARTS, AT_ID_RE } from '../src/qq-tools.js';

/**
 * 造一套工具，返回 { send, close } 和记账用的箱子。
 *
 * @param {object} [o]
 */
function make({ kind = 'c2c', said = '', hasPayload = true, maxParts = MAX_PARTS, sendFails = false, note = '' } = {}) {
  const box = { sent: [], opts: [], parts: 0, closed: false, closedWith: null };

  const defs = buildQqToolDefs({
    callerOf: () => ({
      chatId: 'u1',
      kind,
      said,
      hasPayload,
      bucket: 'owner',
    }),
    sendOf: async (text, opts = {}) => {
      if (sendFails) return { ok: false, message: '通道断了' };
      box.sent.push(text);
      box.opts.push(opts);
      box.parts += 1;
      return note ? { ok: true, note } : { ok: true };
    },
    closeOf: (r) => {
      box.closed = true;
      box.closedWith = r;
      return { ok: true, why: r.point };
    },
    cfgOf: () => ({ qqTools: { maxParts } }),
    stateOf: () => ({ parts: box.parts }),
  });

  const by = (n) => defs.find((d) => d.name === n);
  return { box, send: by('qq_send'), close: by('qq_close'), defs };
}

/* ---------------- 形状 ---------------- */

test('工具：两个都注册了，名字对', () => {
  const { defs } = make();
  assert.deepEqual(defs.map((d) => d.name).sort(), ['qq_close', 'qq_send']);
});

test('工具：都有 parameters 和 execute', () => {
  const { defs } = make();
  for (const d of defs) {
    assert.equal(typeof d.execute, 'function', `${d.name} 缺 execute`);
    assert.ok(d.parameters && typeof d.parameters === 'object', `${d.name} 缺 parameters`);
    /**
     * 参数表必须是**扁平 map**，不能是标准 JSON Schema。
     *
     * DSH 的 `defineTool` 把 `parameters` 当「参数名 → schema」遍历，
     * 撞到键 `type` 的值是字符串 `'object'` 就报
     * `unsupported JSON schema: parameters.type must be a value schema object`。
     * 别人机器上四个工具全挂在这，本机因为解析不到 defineTool 一直没暴露。
     */
    assert.equal(
      d.parameters.type, undefined,
      `${d.name} 的 parameters 是标准 JSON Schema——defineTool 要的是扁平表`,
    );
    for (const [k, v] of Object.entries(d.parameters)) {
      assert.equal(typeof v, 'object', `${d.name}.${k} 不是 schema 对象`);
      assert.ok(v.type, `${d.name}.${k} 缺 type`);
    }
    assert.ok(d.description, `${d.name} 缺 description`);
  }
});

/**
 * `output.render` 必须返回**内容块数组**。
 *
 * 返回字符串会让 DSH 的 `content.some()` 炸成
 * `content.some is not a function`，模型看到的是「接口报错了」。
 * 0.9.x 两轮检索全挂在这，所以这条必须有测试。
 */
test('工具：output.render 返回内容块数组，不是字符串', () => {
  const { defs } = make();
  for (const d of defs) {
    const out = d.output.render({}, { ok: true });
    assert.ok(Array.isArray(out), `${d.name} 的 render 不是数组`);
    assert.equal(out[0]?.type, 'text');
    assert.equal(typeof out[0]?.text, 'string');
  }
});

/* ---------------- qq_send ---------------- */

test('qq_send：正常发一段', async () => {
  const { send, box } = make();
  const r = await send.execute({ text: '在的' });
  assert.equal(r.ok, true);
  assert.equal(r.part, 1);
  assert.deepEqual(box.sent, ['在的']);
});

test('qq_send：空文本不发', async () => {
  const { send, box } = make();
  const r = await send.execute({ text: '   ' });
  assert.equal(r.ok, false);
  assert.equal(box.sent.length, 0);
});

test('qq_send：超过上限就拒，并说清还剩几段', async () => {
  const { send, box } = make({ maxParts: 2 });
  await send.execute({ text: '一' });
  await send.execute({ text: '二' });
  const r = await send.execute({ text: '三' });
  assert.equal(r.ok, false);
  assert.match(r.message, /上限 2 段/);
  assert.equal(box.sent.length, 2, '超限那次不该发出去');
});

test('qq_send：这一轮没有 payload 时拒（不该发生，但别静默）', async () => {
  const { send, box } = make({ hasPayload: false });
  const r = await send.execute({ text: '喂' });
  assert.equal(r.ok, false);
  assert.equal(box.sent.length, 0);
});

test('qq_send：底层发送失败要把原因带出去', async () => {
  const { send } = make({ sendFails: true });
  const r = await send.execute({ text: '喂' });
  assert.equal(r.ok, false);
  assert.match(r.message, /通道断了/);
});

test('qq_send：maxParts 配成 0 或负数时退回默认值（不能变成"永远发不出去"）', async () => {
  const { send, box } = make({ maxParts: 0 });
  const r = await send.execute({ text: '一' });
  assert.equal(r.ok, true);
  assert.equal(box.sent.length, 1);
});

/* ---------------- qq_send 的 at 参数 ---------------- */

const OPENID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';

test('qq_send：at 原样交给宿主（工具自己不管拼标签）', async () => {
  const { send, box } = make({ kind: 'group' });
  await send.execute({ text: '在的', at: 'sender' });
  assert.equal(box.opts[0].at, 'sender');
  /**
   * 每次 `qq_send` 调用都带一个幂等键（阶段 5）。
   * **每次新生成**——模型重试是新调用，它可能就是想再说一遍；
   * 这个 id 的用途是让账本记得住「这一段发没发出去」。
   */
  assert.match(box.opts[0].requestId, /^qs-[a-z0-9]+-[a-z0-9]+$/);
  assert.deepEqual(box.sent, ['在的'], '工具不该自己往正文里塞标签');
});

test('qq_send：不传 at 时也带一个空串（宿主不用判 undefined）', async () => {
  const { send, box } = make();
  await send.execute({ text: '嗯' });
  assert.equal(box.opts[0].at, '');
  assert.ok(box.opts[0].requestId, '不传 at 也要带幂等键');
});

/**
 * 宿主说「@ 没挂上」时，理由必须回到模型手里。
 *
 * 不回的话模型会以为 @ 到了，下一句还用同样的方式——错到底而且看不出来。
 */
test('qq_send：宿主的 note 要透传给模型', async () => {
  const { send } = make({ note: '@ 只能挂在这一轮的第一段上' });
  const r = await send.execute({ text: '嗯', at: 'sender' });
  assert.equal(r.ok, true);
  assert.match(r.note, /第一段/);
});

test('qq_send：宿主没给 note 时用默认提示', async () => {
  const { send } = make();
  const r = await send.execute({ text: '嗯' });
  assert.match(r.note, /发出去了/);
});

/* ---------------- buildAtPrefix ---------------- */

test('@：不传就不加前缀', () => {
  const r = buildAtPrefix({ at: '', kind: 'group', senderId: OPENID });
  assert.equal(r.prefix, '');
  assert.equal(r.note, '');
});

test('@：群聊 + sender + markdown → 官方标签', () => {
  const r = buildAtPrefix({ at: 'sender', kind: 'group', senderId: OPENID });
  assert.equal(r.prefix, `<qqbot-at-user id="${OPENID}" />\n`);
  assert.equal(r.note, '');
});

test('@：可以直接给 openid（@ 刚才插话的那个人）', () => {
  const other = 'ZZ99887766554433221100AABBCCDDEE';
  const r = buildAtPrefix({ at: other, kind: 'group', senderId: OPENID });
  assert.equal(r.prefix, `<qqbot-at-user id="${other}" />\n`);
});

test('@：私聊不加（官方只在群聊支持，加了就是露源码）', () => {
  const r = buildAtPrefix({ at: 'sender', kind: 'c2c', senderId: OPENID });
  assert.equal(r.prefix, '');
  assert.match(r.note, /私聊/);
});

test('@：非第一段不加（那段是纯文本消息）', () => {
  const r = buildAtPrefix({ at: 'sender', kind: 'group', parts: 1, senderId: OPENID });
  assert.equal(r.prefix, '');
  assert.match(r.note, /第一段/);
});

test('@：markdown 关着时退化成纯文字 @昵称', () => {
  const r = buildAtPrefix({
    at: 'sender', kind: 'group', markdown: false, senderId: OPENID, senderName: '小明',
  });
  assert.equal(r.prefix, '@小明 ');
  assert.match(r.note, /markdown/);
});

test('@：markdown 关着又没昵称，就什么都不加并说明原因', () => {
  const r = buildAtPrefix({ at: 'sender', kind: 'group', markdown: false, senderId: OPENID });
  assert.equal(r.prefix, '');
  assert.match(r.note, /markdown/);
});

/**
 * 注入防护：id 会拼进 HTML 属性，一个引号就能把标签拆坏。
 * 这条不测就会变成「模型往群里吐半截标签」。
 */
test('@：id 里带引号/尖括号一律拒绝', () => {
  for (const bad of ['A1B2"><script>x</script>', 'A1B2C3D4E5" onload="x', '小明']) {
    const r = buildAtPrefix({ at: bad, kind: 'group' });
    assert.equal(r.prefix, '', `${bad} 不该通过`);
    assert.ok(r.note, '拒绝时必须说明原因');
  }
});

test('@：太短的值不当 openid（挡「把昵称当 id」）', () => {
  const r = buildAtPrefix({ at: 'abcdefg', kind: 'group' });
  assert.equal(r.prefix, '');
  assert.match(r.note, /openid/);
});

test('@：sender 但这一轮没拿到 senderId → 不加并说明', () => {
  const r = buildAtPrefix({ at: 'sender', kind: 'group', senderId: '' });
  assert.equal(r.prefix, '');
  assert.match(r.note, /不知道/);
});

test('@：AT_ID_RE 认官方 openid 的形状，不认中文和空格', () => {
  assert.equal(AT_ID_RE.test(OPENID), true);
  assert.equal(AT_ID_RE.test('a-b_c1234567'), true);
  assert.equal(AT_ID_RE.test('小明12345678'), false);
  assert.equal(AT_ID_RE.test('has space 1234'), false);
});

/* ---------------- qq_close ---------------- */

test('qq_close：私聊正常收尾', async () => {
  const { close, box } = make({ said: '我先去睡啦' });
  const r = await close.execute({ point: '聊到他要睡了', resume: '明天问他睡得好不好' });
  assert.equal(r.ok, true);
  assert.equal(box.closed, true);
  assert.equal(box.closedWith.point, '聊到他要睡了');
  assert.equal(box.closedWith.resume, '明天问他睡得好不好');
});

test('qq_close：群聊拒绝（跟标记那条路共用同一个判断）', async () => {
  const { close, box } = make({ kind: 'group' });
  const r = await close.execute({ point: '群里聊完了' });
  assert.equal(r.ok, false);
  assert.equal(box.closed, false);
});

test('qq_close：对方还在提问时拒绝', async () => {
  const { close, box } = make({ said: '这个报错怎么修？' });
  const r = await close.execute({ point: '聊到报错' });
  assert.equal(r.ok, false);
  assert.match(r.message, /提问/);
  assert.equal(box.closed, false);
});

test('qq_close：没写「收在哪」拒绝', async () => {
  const { close, box } = make();
  const r = await close.execute({ point: '  ' });
  assert.equal(r.ok, false);
  assert.equal(box.closed, false);
});

test('qq_close：resume 可以不给', async () => {
  const { close, box } = make();
  const r = await close.execute({ point: '聊完了' });
  assert.equal(r.ok, true);
  assert.equal(box.closedWith.resume, '');
});
