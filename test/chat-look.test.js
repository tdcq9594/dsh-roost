// `chat_look`：隐私边界是这块唯一真正重要的东西。
//
// 功能错了顶多是"查不到"，边界错了是"群友能读到别的群、甚至别人的私聊"。
// 后者不会报错、不会有人发现——所以每条边界都单独锁一遍。
//
// 特别锁「主人在群里」这一条：`bucketOf()` 只看 sender 的等级、不看 chat kind，
// 所以主人在群里说话时 `bucket === 'owner'` 也成立。只判 bucket 的实现会在这里漏。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildToolDefs } from '../src/tools.js';

/** 假环境：只关心「谁在哪儿问、问哪儿」 */
function rig({
  bucket = 'member',
  kind = 'group',
  chatId = 'g1',
  ledgerRows = [],
  chatsRows = [],
  journalRows = [],
  ledgerOk = true,
  sessions = {},
  cfg = {},
  /** 这一轮的 `speaker` 记录（`lookCalls` 挂在上面）；null = 宿主轮次，不限次数 */
  turnRef = null,
} = {}) {
  const asked = [];
  const ledger = {
    available: () => ledgerOk,
    recent(o) {
      asked.push({ src: 'ledger', ...o });
      return ledgerRows;
    },
    chats() {
      asked.push({ src: 'ledger-chats' });
      return chatsRows;
    },
  };
  const journal = {
    recentTimeline(id, o) {
      asked.push({ src: 'journal', chatId: id, ...o });
      return journalRows;
    },
  };
  const defs = buildToolDefs({
    journal,
    graphOf: () => ({}),
    callerOf: () => ({ bucket, chatId, kind, aliases: [], turnRef }),
    cfgOf: () => cfg,
    ledgerOf: () => ledger,
    sessionOf: (id) => sessions[id] ?? null,
  });
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  return { look: byName.chat_look, asked, defs };
}

test('chat_look：不传 chatId 就是当前会话', async () => {
  const { look, asked } = rig({ ledgerRows: [] });
  const r = await look.execute({});
  assert.equal(r.ok, true);
  assert.equal(r.chatId, 'g1');
  assert.equal(asked[0].chatId, 'g1');
});

test('chat_look：群友查别的群 → 拒，而且不碰库', async () => {
  const { look, asked } = rig({ bucket: 'member', kind: 'group' });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.equal(asked.length, 0, '拒绝了就不该再查库');
});

test('chat_look：主人在【群里】查别的群 → 也必须拒', async () => {
  // 这条是重点：bucket 是 owner，但 kind 是 group。
  const { look, asked } = rig({ bucket: 'owner', kind: 'group' });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false, '只判 bucket 的实现会在这里放行');
  assert.equal(asked.length, 0);
});

test('chat_look：主人在群里 + 开关打开 → 放行', async () => {
  const { look } = rig({
    bucket: 'owner',
    kind: 'group',
    chatId: 'g1',
    cfg: { chat: { tools: true, crossChatInGroup: true } },
    sessions: { g2: { kind: 'group', title: 'QQ · 别的群' } },
    ledgerRows: [],
  });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, true, '开关打开了就该放行');
});

test('chat_look：群友在群里 + 开关打开 → 仍然拒', async () => {
  // 开关是「主人自己担风险」，不是「给群友开权限」。
  const { look, asked } = rig({
    bucket: 'member',
    kind: 'group',
    chatId: 'g1',
    cfg: { chat: { tools: true, crossChatInGroup: true } },
    sessions: { g2: { kind: 'group' } },
  });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.equal(asked.length, 0);
});

test('chat_look：主人私聊查群 → 放行', async () => {
  const { look } = rig({
    bucket: 'owner',
    kind: 'c2c',
    chatId: 'owner',
    sessions: { g2: { kind: 'group', title: 'QQ · roost交流群' } },
    ledgerRows: [{ seq: 7, at: 1, time: '10:00', who: '某人', text: '你好' }],
  });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'roost交流群', 'QQ · 前缀要剥掉');
  assert.equal(r.items.length, 1);
});

test('chat_look：主人私聊查【别人的私聊】→ 拒', async () => {
  const { look } = rig({
    bucket: 'owner',
    kind: 'c2c',
    chatId: 'owner',
    sessions: { u9: { kind: 'c2c', title: 'QQ · 私聊 某人' } },
  });
  const r = await look.execute({ chatId: 'u9' });
  assert.equal(r.ok, false);
  assert.match(r.message, /私聊/);
});

test('chat_look：sessions 里没有这个 chatId → 当不合法（fail closed）', async () => {
  const { look } = rig({ bucket: 'owner', kind: 'c2c', chatId: 'owner' });
  const r = await look.execute({ chatId: 'g-unknown' });
  assert.equal(r.ok, false);
});

test('chat_look：账本没开时明确说，而不是回空数组', async () => {
  const { look } = rig({ ledgerOk: false });
  const r = await look.execute({});
  assert.equal(r.ok, false);
  assert.match(r.message, /账本/);
});

test('chat_look：chats 给真名、给条数', async () => {
  const { look } = rig({
    bucket: 'owner',
    kind: 'c2c',
    chatId: 'owner',
    sessions: { g1: { kind: 'group', title: 'QQ · 机器人测试' } },
    chatsRows: [{ chatId: 'g1', kind: 'group', count: 97, lastAt: 1793818423000 }],
  });
  const r = await look.execute({ what: 'chats' });
  assert.equal(r.ok, true);
  assert.equal(r.chats[0].name, '机器人测试');
  assert.equal(r.chats[0].count, 97);
});

test('chat_look：账本说自己发的那些署名为「你」，别显示成「（未知）」', async () => {
  const { look } = rig({
    ledgerRows: [
      { seq: 1, at: 1000, time: '10:00', who: '张三', text: '在吗', self: false },
      { seq: 2, at: 2000, time: '10:01', who: '（未知）', text: '在的', self: true },
    ],
  });
  const r = await look.execute({});
  assert.deepEqual(r.items.map((x) => x.who), ['张三', '你']);
});

test('chat_look：journal 源只拿对话行，游标是上一页最早那条', async () => {
  const rows = [
    { at: 2000, role: 'bot', sender: '', text: '嗯', digest: null },
    { at: 1000, role: 'user', sender: '张三', text: '在吗', digest: null },
  ];
  const { look, asked } = rig({ journalRows: rows });
  const r = await look.execute({ source: 'journal', limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.items[0].who, '张三');
  assert.equal(r.items[1].who, '我');
  assert.equal(asked[0].src, 'journal');
  assert.equal(r.next, '1000', '游标要是最早那条的 at');
});

test('chat_look：limit 被夹在 1–50', async () => {
  const { look, asked } = rig({ ledgerRows: [] });
  await look.execute({ limit: 999 });
  assert.equal(asked[0].limit, 50);
  await look.execute({ limit: -3 });
  assert.equal(asked[1].limit, 1);
});

test('chat_look：功能开关关着时干脆不挂这个工具', () => {
  const { defs } = rig({ cfg: { chat: { tools: false } } });
  assert.equal(
    defs.some((d) => d.name === 'chat_look'),
    false,
    '关掉的工具不该出现在注册列表里——挂上去再在 execute 里拒，会让能力页上多一个假开关',
  );
});

/* ---------------- 默认条数 / 翻页次数（配置放的权） ---------------- */

test('chat_look：不传 limit 就用配置的默认条数', async () => {
  const { look, asked } = rig({ ledgerRows: [] });
  await look.execute({});
  assert.equal(asked[0].limit, 5, '默认 5 条（一次取 20 会把上下文挤满）');
});

test('chat_look：lookLimit 改了，默认条数跟着走', async () => {
  const { look, asked } = rig({ cfg: { chat: { lookLimit: 12 } } });
  await look.execute({});
  assert.equal(asked[0].limit, 12);
});

test('chat_look：lookLimit 只是默认值，模型显式多要照给', async () => {
  const { look, asked } = rig({ cfg: { chat: { lookLimit: 5 } } });
  await look.execute({ limit: 30 });
  assert.equal(asked[0].limit, 30, '用户设 5 不该把模型的手脚也捆在 5');
});

test('chat_look：翻到这一轮的上限就拒，而且不再碰库', async () => {
  const turnRef = { lookCalls: 0 };
  const { look, asked } = rig({ cfg: { chat: { lookMaxCalls: 2 } }, turnRef });
  assert.equal((await look.execute({})).ok, true);
  assert.equal((await look.execute({})).ok, true);
  const third = await look.execute({});
  assert.equal(third.ok, false);
  assert.match(third.message, /已经翻过 2 次/);
  assert.equal(asked.length, 2, '被拒那一次不该再查库');
});

test('chat_look：lookMaxCalls = 0 表示不限，也不去动计数', async () => {
  const turnRef = { lookCalls: 0 };
  const { look } = rig({ turnRef });
  for (let i = 0; i < 8; i += 1) assert.equal((await look.execute({})).ok, true);
  assert.equal(turnRef.lookCalls, 0, '不限次数时计数没有意义，别写它');
});

test('chat_look：宿主轮次没有 turnRef，次数限制退化为不限', async () => {
  const { look } = rig({ cfg: { chat: { lookMaxCalls: 1 } }, turnRef: null });
  assert.equal((await look.execute({})).ok, true);
  assert.equal((await look.execute({})).ok, true, '主动搭话那类轮次不该被掐');
});

test('chat_look：查不到东西（账本没开）不吃额度', async () => {
  const turnRef = { lookCalls: 0 };
  const { look, asked } = rig({ cfg: { chat: { lookMaxCalls: 1 } }, ledgerOk: false, turnRef });
  const fail = await look.execute({});
  assert.equal(fail.ok, false);
  assert.match(fail.message, /账本没开/);
  assert.equal(asked.length, 0, '账本没开就别碰库');
  assert.equal(turnRef.lookCalls, 0, '白跑一趟不该扣额度，否则几次就把一轮耗光');
});

test('chat_look：what=chats 只是列会话，不占翻页额度', async () => {
  const turnRef = { lookCalls: 0 };
  const { look } = rig({ cfg: { chat: { lookMaxCalls: 1 } }, chatsRows: [], turnRef });
  await look.execute({ what: 'chats' });
  assert.equal(turnRef.lookCalls, 0, '列清单不算翻消息');
  assert.equal((await look.execute({})).ok, true);
});
