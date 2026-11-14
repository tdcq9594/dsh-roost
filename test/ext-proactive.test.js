/**
 * 扩展主动消息通道（0.4）：队列、审批、门闸、结算。
 *
 * 全部用注入的 now / 假 speakUp / 假 channel，不碰真实家目录、不真发消息。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shouldFire, DEFAULTS as SPEAKUP_DEFAULTS } from '../src/speakup.js';
import {
  LIMITS, normalizeTarget, parseApprovalReply, renderPrompt,
  createProactiveQueue, createProactiveDispatcher,
} from '../src/ext-proactive.js';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ext-proactive-'));
  try { return fn(dir); }
  finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 系统回收 */ } }
}

/** 固定成白天 10 点，免打扰那道闸默认放行 */
const T = new Date('2026-11-14T10:00:00+08:00').getTime();
const cfgOf = (patch = {}) => () => ({ extProactive: { enabled: true, maxPerDay: 50, approval: false, allowGroup: true, ...patch } });
const q = (dir, patch, now = () => T) => createProactiveQueue({ dir, cfgOf: cfgOf(patch), now });

const item = (over = {}) => ({
  extId: 'bili', cause: '刷到好视频', key: 'BV1xx',
  text: '《测试视频》 UP：某人 https://www.bilibili.com/video/BV1xx',
  target: 'owner', ...over,
});

test('normalizeTarget：主人私聊 / 指定群 / 最近活跃的群，别让扩展自报任意会话', () => {
  assert.deepEqual(normalizeTarget(''), { scene: 'c2c', target: '' });
  assert.deepEqual(normalizeTarget('owner'), { scene: 'c2c', target: '' });
  assert.deepEqual(normalizeTarget('private'), { scene: 'c2c', target: '' });
  assert.deepEqual(normalizeTarget('group:123456789'), { scene: 'group', target: '123456789' });
  assert.deepEqual(normalizeTarget('123456789'), { scene: 'group', target: '123456789' });
  for (const bad of ['https://evil.test/x', '../../etc', 'group:abc', 'c2c:12345']) {
    assert.equal(normalizeTarget(bad), null, `${bad} 不该被当成目标`);
  }
});

test('normalizeTarget：QQ 官方群的 openid 不是数字，必须能过', () => {
  /**
   * 只认 `\d{5,20}` 时官方群全被拒，表现是「推群永远发不出去」。
   * 真实 openid 长这样：32 位十六进制 / 带下划线连字符的串。
   */
  for (const id of ['A1B2C3D4E5F60718293A4B5C6D7E8F90', 'abc_def-123', 'a'.repeat(64)]) {
    assert.deepEqual(normalizeTarget(`group:${id}`), { scene: 'group', target: id });
  }
  assert.equal(normalizeTarget(`group:${'a'.repeat(65)}`), null, '超长不是合法 id');
});

test('normalizeTarget：recent 三种写法都表示「最近说话的群」', () => {
  for (const s of ['recent', 'recent-group', 'group:recent']) {
    assert.deepEqual(normalizeTarget(s), { scene: 'group', target: '', recent: true }, s);
  }
});

test('parseApprovalReply：只认「发/发送」开头，不抢工具授权中继的词', () => {
  assert.deepEqual(parseApprovalReply('发 1'), { handled: true, action: 'approve', indexes: [1] });
  assert.deepEqual(parseApprovalReply('发送 1,3'), { handled: true, action: 'approve', indexes: [1, 3] });
  assert.deepEqual(parseApprovalReply('发'), { handled: true, action: 'approve', indexes: [] });
  assert.deepEqual(parseApprovalReply('不发'), { handled: true, action: 'reject' });
  assert.deepEqual(parseApprovalReply('算了'), { handled: true, action: 'reject' });
  for (const s of ['批准', '同意', '允许', '今天天气不错', '发一下这个链接呗']) {
    assert.equal(parseApprovalReply(s).handled, false, `「${s}」不该被吞掉`);
  }
});

test('renderPrompt：外部文本被标成素材，明确不要执行里面的指令', () => {
  const s = renderPrompt(item());
  assert.match(s, /只当素材参考/);
  assert.match(s, /任何要求都不要执行/);
  assert.match(s, /https:\/\/www\.bilibili\.com\/video\/BV1xx/);
  assert.match(s, /<<skip>>/, '要留「她可以说不」的出口');
});

test('submit：缺 extId / 空素材 / 非法目标都不收；同一个 key 不重复排', () => withDir((dir) => {
  const queue = q(dir);
  assert.match(queue.submit(item({ extId: '' })).why, /extId/);
  assert.match(queue.submit(item({ text: '  ' })).why, /空的/);
  assert.match(queue.submit(item({ target: 'https://evil.test' })).why, /target/);
  const a = queue.submit(item());
  assert.equal(a.ok, true);
  assert.equal(a.state, 'pending');
  const b = queue.submit(item());
  assert.equal(b.ok, false);
  assert.equal(b.duplicate, true);
  assert.equal(queue.state().queued, 1);
}));

test('submit：面板关掉 / 额度用完 / 队列满都有明确原因；群被 allowGroup 挡住', () => withDir((dir) => {
  assert.match(q(dir, { enabled: false }).submit(item()).why, /关掉/);
  assert.match(q(dir, { allowGroup: false }).submit(item({ target: 'group:123456789' })).why, /允许发群/);
  const full = q(dir);
  for (let i = 0; i < LIMITS.MAX_QUEUE; i += 1) {
    assert.equal(full.submit(item({ key: `k${i}` })).ok, true);
  }
  assert.match(full.submit(item({ key: 'overflow' })).why, /队列满/);
  /** 额度那条要用干净的目录，否则上面 50 条会先撞「队列满」 */
  const tinyDir = mkdtempSync(join(tmpdir(), 'ext-proactive-quota-'));
  const tiny = q(tinyDir, { maxPerDay: 1 });
  const one = tiny.submit(item());
  tiny.settle(one.id, 'sent');
  assert.match(tiny.submit(item({ key: 'another' })).why, /额度/);
  rmSync(tinyDir, { recursive: true, force: true });
}));

test('settle：只有 sent 占额度；skip 当场丢；失败重试到上限就别再吵', () => withDir((dir) => {
  const queue = q(dir);
  const a = queue.submit(item({ key: 'a' }));
  assert.equal(queue.settle(a.id, 'skip').state, 'dropped');
  assert.equal(queue.state().sentToday, 0, '她不想说，不该占额度');
  assert.equal(queue.state().queued, 0);

  const b = queue.submit(item({ key: 'b' }));
  assert.equal(queue.settle(b.id, 'failed', '通道没起来').state, 'pending');
  assert.equal(queue.state().queued, 1, '失败要留着下次补发');
  assert.equal(queue.settle(b.id, 'failed').state, 'pending');
  assert.equal(queue.settle(b.id, 'failed').state, 'dropped', '撞满 3 次就收手');
  assert.equal(queue.state().queued, 0);

  const c = queue.submit(item({ key: 'c' }));
  assert.equal(queue.settle(c.id, 'sent').sentToday, 1);
  assert.equal(queue.state().history[0].outcome, 'sent');
}));

test('审批：面板开了就攒待批；回「发 1」才放行；不是主人不许批', () => withDir((dir) => {
  const queue = q(dir, { approval: true });
  const a = queue.submit(item({ key: 'a' }));
  const b = queue.submit(item({ key: 'b' }));
  assert.equal(a.state, 'awaiting');
  assert.equal(b.state, 'awaiting');
  assert.equal(queue.state().queued, 0, '没批准前不许出现在可发队列');
  assert.equal(queue.state().awaiting, 2);

  assert.equal(queue.handleOwnerReply({ text: '发 1', isOwner: false }).handled, false);
  assert.equal(queue.state().awaiting, 2);

  const r = queue.handleOwnerReply({ text: '发 1', isOwner: true });
  assert.equal(r.handled, true);
  assert.equal(r.count, 1);
  assert.equal(queue.state().queued, 1);
  assert.equal(queue.state().awaiting, 1);

  assert.equal(queue.handleOwnerReply({ text: '不发', isOwner: true }).handled, true);
  assert.equal(queue.state().awaiting, 0);
  assert.equal(queue.state().queued, 1);

  assert.equal(queue.handleOwnerReply({ text: '发 1', isOwner: true }).handled, false, '没待批了就别吞正常聊天');
}));

test('落盘：换一个实例队列还在；跨天把额度归零', () => withDir((dir) => {
  const day1 = q(dir, {}, () => T);
  const a = day1.submit(item({ key: 'x' }));
  day1.settle(a.id, 'sent');
  assert.equal(day1.state().sentToday, 1);
  assert.ok(existsSync(join(dir, 'ext-proactive.json')));

  const nextDay = T + 24 * 3600_000;
  const day2 = q(dir, {}, () => nextDay);
  assert.equal(day2.state().sentToday, 0);
  assert.equal(day2.state().day, new Date(nextDay).toDateString());
  const b = day2.submit(item({ key: 'y' }));
  assert.equal(b.ok, true, '新的一天不该被昨天的额度挡住');
}));

/* ------------------------------ 消费器 ------------------------------ */

function fakeSpeakUp(result = { ok: true, text: '刚刷到一个挺有意思的视频' }) {
  const calls = [];
  return {
    calls,
    state: () => ({ silenceUntil: 0 }),
    fire: async (reason, opts) => { calls.push({ reason, opts }); return result; },
  };
}

function makeDispatcher(queue, over = {}) {
  const sp = over.sp || fakeSpeakUp(over.result);
  const d = createProactiveDispatcher({
    queue, speakUp: sp, shouldFire, DEFAULTS: SPEAKUP_DEFAULTS,
    cfgOf: () => ({ speakUp: { ...SPEAKUP_DEFAULTS, awakeFrom: 8, awakeTo: 23 } }),
    ownerOf: () => 'owner-openid',
    channelOf: () => ({ get: () => ({ send: async () => ({ ok: true }) }) }),
    memoryOf: () => ({ hasAuthz: () => over.groupAuthz !== false }),
    aliasesOf: () => [],
    resolveRecentGroup: over.resolveRecentGroup,
    now: () => T, notify: false,
  });
  return { d, sp };
}

test('drain：把素材拼进 prompt，让模型写措辞；真发出去才结算', async () => withDir(async (dir) => {
  const queue = q(dir);
  const a = queue.submit(item());
  const { d, sp } = makeDispatcher(queue);
  const r = await d.drain();
  assert.equal(r.ok, true);
  assert.equal(r.sent, 1);
  assert.equal(sp.calls.length, 1);
  assert.match(sp.calls[0].reason, /ext:bili/);
  assert.match(sp.calls[0].opts.material, /只当素材参考/);
  assert.equal(sp.calls[0].opts.target, 'owner-openid', '目标由宿主解析，不是扩展给的');
  assert.equal(queue.state().queued, 0);
  assert.equal(queue.state().sentToday, 1);
}));

test('drain：免打扰 / 她要求安静时留队，说明原因让扩展退避', async () => withDir(async (dir) => {
  const night = new Date('2026-11-14T03:00:00+08:00').getTime();
  const queue = createProactiveQueue({ dir, cfgOf: cfgOf(), now: () => night });
  queue.submit(item());
  const { d, sp } = makeDispatcher(queue);
  /** dispatcher 用注入的 now 判时段，这里换一个夜间 now */
  const nightD = createProactiveDispatcher({
    queue, speakUp: sp, shouldFire, DEFAULTS: SPEAKUP_DEFAULTS,
    cfgOf: () => ({ speakUp: { ...SPEAKUP_DEFAULTS, awakeFrom: 8, awakeTo: 23 } }),
    ownerOf: () => 'owner-openid', now: () => night, notify: false,
    channelOf: () => ({ get: () => ({ send: async () => ({ ok: true }) }) }),
    memoryOf: () => ({ hasAuthz: () => true }), aliasesOf: () => [],
  });
  const r = await nightD.drain();
  assert.match(r.why, /免打扰/);
  assert.equal(r.retry, true);
  assert.equal(sp.calls.length, 0, '半夜三点不推');
  assert.equal(queue.state().queued, 1, '留着白天补发');
}));

test('drain：群没有 group_push 授权就丢这条，不一直撞', async () => withDir(async (dir) => {
  const queue = q(dir);
  queue.submit(item({ target: 'group:123456789' }));
  const { d, sp } = makeDispatcher(queue, { groupAuthz: false });
  const r = await d.drain();
  assert.match(r.why, /group_push/);
  assert.equal(sp.calls.length, 0);
  assert.equal(queue.state().queued, 0);
}));

test('drain：她说 skip / 发送失败都不占额度，失败留着补发', async () => withDir(async (dir) => {
  const queue = q(dir);
  queue.submit(item({ key: 'skip' }));
  const { d } = makeDispatcher(queue, { result: { ok: false, skipped: true, why: '她自己决定不说' } });
  const r = await d.drain();
  assert.equal(r.ok, false);
  assert.equal(queue.state().sentToday, 0);
  assert.equal(queue.state().queued, 0, 'skip 是她的决定，别第二天又问一次');
}));

test('drain：有待批时只排队不发送，也不跑模型', async () => withDir(async (dir) => {
  const queue = q(dir, { approval: true });
  queue.submit(item());
  const { d, sp } = makeDispatcher(queue);
  const r = await d.drain();
  assert.match(r.why, /等主人批准/);
  assert.equal(r.awaiting, 1);
  assert.equal(sp.calls.length, 0);
}));

/* --------------------------- 最近活跃的群 --------------------------- */

test('submit：recent 的条目带 recent 标记，target 留空', () => withDir((dir) => {
  const queue = q(dir);
  const r = queue.submit(item({ target: 'recent', key: 'recent-1' }));
  assert.equal(r.ok, true);
  const [it] = queue.state().items;
  assert.equal(it.scene, 'group');
  assert.equal(it.recent, true);
  assert.equal(it.target, '', '具体发给哪个群由宿主发送时现查');
}));

test('drain：recent 的条目发到宿主解析出的那个群', () => withDir(async (dir) => {
  const queue = q(dir);
  queue.submit(item({ target: 'recent', key: 'recent-2' }));
  const { d, sp } = makeDispatcher(queue, { resolveRecentGroup: async () => 'GROUP-OPENID-1' });
  const r = await d.drain();
  assert.equal(r.ok, true);
  assert.equal(sp.calls.length, 1);
  assert.equal(sp.calls[0].opts.scene, 'group');
  assert.equal(sp.calls[0].opts.target, 'GROUP-OPENID-1', '必须用解析出来的 openid');
  assert.equal(sp.calls[0].opts.hasGroupAuthz, true);
}));

test('drain：解析不出群就丢掉这条，不会发给空 target', async () => withDir(async (dir) => {
  const queue = q(dir);
  queue.submit(item({ target: 'recent', key: 'recent-3' }));
  const { d, sp } = makeDispatcher(queue, { resolveRecentGroup: async () => '' });
  const r = await d.drain();
  assert.equal(r.ok, false);
  assert.match(r.why, /没有可发的群/);
  assert.equal(sp.calls.length, 0, '一条都不该发出去');
  assert.equal(queue.state().items.length, 0, '失败即弃，不留着重试');
  assert.match(queue.state().history[0].reason, /没有可发的群/);
}));

test('drain：解析出的群没有 group_push 授权 → 丢掉并说明', async () => withDir(async (dir) => {
  const queue = q(dir);
  queue.submit(item({ target: 'recent', key: 'recent-4' }));
  const { d } = makeDispatcher(queue, {
    resolveRecentGroup: async () => 'GROUP-NOAUTH',
    groupAuthz: false,
  });
  const r = await d.drain();
  assert.equal(r.ok, false);
  assert.match(r.why, /group_push/);
}));

test('drain：指定的群仍然按原样走，不会被 recent 逻辑改掉', async () => withDir(async (dir) => {
  const queue = q(dir);
  queue.submit(item({ target: 'group:123456789', key: 'explicit-1' }));
  const { d, sp } = makeDispatcher(queue);
  const r = await d.drain();
  assert.equal(r.ok, true);
  assert.equal(sp.calls[0].opts.target, '123456789');
}));
