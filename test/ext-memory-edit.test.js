/**
 * 扩展记忆编辑（`/v1/memory/facts` + `/v1/memory/facts/edit`）
 *
 * 守的是「面板能改、扩展只能看」这个缺口的反面：
 *   · 读要带 id（否则「改哪一条」表达不了）；
 *   · 写要有白名单（text / pin / tier / archived），且**没有硬删**；
 *   · 改全局记忆必须显式写 `scope:"global"`，不能靠默认值悄悄扩大影响面。
 *
 * 跑法：node --test test/ext-memory-edit.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createExtMemoryEdit, MAX_FACT_ROWS, DEFAULT_FACT_ROWS, MAX_FACT_CHARS, MAX_CHAT_ID,
} from '../src/ext-memory-edit.js';

function makeMemory({ global = [], chat = [], editResult = null, throwOn = '' } = {}) {
  const calls = [];
  return {
    calls,
    listFull: (chatId) => {
      if (throwOn === 'listFull') throw new Error('记忆文件坏了');
      return { global, chat: chatId ? chat : [] };
    },
    editFact: (chatId, scope, key, patch, aliases) => {
      calls.push({ chatId, scope, key, patch, aliases });
      if (throwOn === 'editFact') throw new Error('写盘失败');
      return editResult ?? { ok: true, id: 'f1', text: '新正文', tier: 'long', pin: 0, archivedAt: null };
    },
  };
}

const fact = (id, text, extra = {}) => ({ id, text, at: 100, tier: 'long', pin: 0, brightness: 0.5, ...extra });

function build(opts = {}) {
  const memory = makeMemory(opts);
  const logs = [];
  const api = createExtMemoryEdit({
    memoryOf: () => memory,
    aliasesOf: () => ['alias1'],
    log: (m) => logs.push(m),
  });
  return { api, memory, logs };
}

/* ── memory.facts ────────────────────────────────────────────────────── */

test('M1 facts：看会话记忆要给 chatId；只要全局就传 scope=global', async () => {
  const { api } = build();
  assert.equal((await api['memory.facts']({ query: {} })).status, 400);
  assert.equal((await api['memory.facts']({ query: { scope: 'chat' } })).status, 400);

  const g = await api['memory.facts']({ query: { scope: 'global' } });
  assert.equal(g.status, 200);
});

test('M2 facts：每条都带 id / scope / 归档标记，按时间倒序', async () => {
  const { api } = build({
    global: [fact('g1', '全局1', { at: 100 }), fact('g2', '全局2', { at: 300 })],
    chat: [fact('c1', '会话1', { at: 200 })],
  });
  const r = await api['memory.facts']({ query: { chatId: 'g1' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map((x) => x.id), ['g2', 'c1', 'g1'], '最新在前');
  assert.equal(r.body.items.find((x) => x.id === 'c1').scope, 'chat');
  assert.equal(r.body.items.find((x) => x.id === 'c1').chatId, 'g1');
  assert.equal(r.body.items.find((x) => x.id === 'g1').archived, false);
});

test('M3 facts：默认不返回已归档的，includeArchived=1 才给', async () => {
  const { api } = build({
    global: [fact('g1', '活的'), fact('g2', '归档的', { archivedAt: 999 })],
  });
  const def = await api['memory.facts']({ query: { scope: 'global' } });
  assert.deepEqual(def.body.items.map((x) => x.id), ['g1']);

  const all = await api['memory.facts']({ query: { scope: 'global', includeArchived: '1' } });
  assert.deepEqual(all.body.items.map((x) => x.id).sort(), ['g1', 'g2']);
  assert.equal(all.body.items.find((x) => x.id === 'g2').archived, true);
});

test('M4 facts：q 过滤 + 分页 hasMore', async () => {
  const { api } = build({
    global: [
      fact('g1', '主人喜欢猫', { at: 3 }),
      fact('g2', '主人喜欢狗', { at: 2 }),
      fact('g3', '主人喜欢猫和狗', { at: 1 }),
    ],
  });
  const q = await api['memory.facts']({ query: { scope: 'global', q: '猫' } });
  assert.deepEqual(q.body.items.map((x) => x.id), ['g1', 'g3']);

  const page = await api['memory.facts']({ query: { scope: 'global', limit: '1', offset: '1' } });
  assert.equal(page.body.total, 3);
  assert.equal(page.body.hasMore, true);
  assert.equal(page.body.items.length, 1);
});

test('M5 facts：limit 超上限被夹紧，不会一次拉全库', async () => {
  const many = Array.from({ length: MAX_FACT_ROWS + 50 }, (_, i) => fact(`g${i}`, `第 ${i} 条`, { at: i }));
  const { api } = build({ global: many });
  const r = await api['memory.facts']({ query: { scope: 'global', limit: '99999' } });
  assert.equal(r.body.items.length, MAX_FACT_ROWS);
  assert.ok(DEFAULT_FACT_ROWS < MAX_FACT_ROWS);
});

test('M6 facts：chatId 是原型污染的名字 → 400', async () => {
  const { api } = build();
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal((await api['memory.facts']({ query: { chatId: bad } })).status, 400);
  }
});

test('M7 facts：底层抛错要如实回 500，不假装空列表', async () => {
  const { api } = build({ throwOn: 'listFull' });
  const r = await api['memory.facts']({ query: { scope: 'global' } });
  assert.equal(r.status, 500);
  assert.match(r.body.message, /读记忆失败/);
});

/* ── memory.edit ─────────────────────────────────────────────────────── */

test('M8 edit：缺 id / 缺 chatId / 没有可改项 都拒', async () => {
  const { api, memory } = build();
  assert.equal((await api['memory.edit']({ body: {} })).status, 400);
  assert.equal((await api['memory.edit']({ body: { id: 'f1' } })).status, 400, '缺 chatId');
  assert.equal((await api['memory.edit']({ body: { id: 'f1', chatId: 'g1' } })).status, 400, '没有可改项');
  assert.equal(memory.calls.length, 0, '被拒的请求不该落到 editFact');
});

test('M8b edit：不许改全局记忆（memory:write 是默认 scope，放开就是权限放大）', async () => {
  const { api, memory } = build();
  const r = await api['memory.edit']({ body: { id: 'f1', scope: 'global', text: 'x' } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'forbidden');
  assert.match(r.body.message, /全局/);
  assert.equal(memory.calls.length, 0, '一个字节都不该动');

  /** 读全局仍然可以——读不改变状态 */
  assert.equal((await api['memory.facts']({ query: { scope: 'global' } })).status, 200);
});

test('M9 edit：text 空串 → 400，并提示改用 archived', async () => {
  const { api } = build();
  const r = await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', text: '   ' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /archived/);
});

test('M10 edit：pin 越界 / tier 不认识 都拒', async () => {
  const { api } = build();
  assert.equal((await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', pin: 2 } })).status, 400);
  assert.equal((await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', pin: -0.1 } })).status, 400);
  assert.equal((await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', tier: 'huge' } })).status, 400);
  const ok = await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', tier: 'core' } });
  assert.equal(ok.status, 200);
});

test('M11 edit：archived 是软删/恢复，映射成 archivedAt 时间戳 / 0', async () => {
  const { api, memory } = build();
  await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', archived: true } });
  assert.ok(memory.calls[0].patch.archivedAt > 0);

  await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', archived: false } });
  assert.equal(memory.calls[1].patch.archivedAt, 0);
});

test('M12 edit：把 aliases 一起传下去（不然换过机器人的群会「删了又想起来」）', async () => {
  const { api, memory } = build();
  await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', text: '新' } });
  assert.equal(memory.calls[0].scope, 'chat');
  assert.equal(memory.calls[0].chatId, 'g1');
  assert.deepEqual(memory.calls[0].aliases, ['alias1']);
});

test('M13 edit：editFact 说没找到 → 400 带原因，不是 500', async () => {
  const { api } = build({ editResult: { ok: false, message: '没找到这条事实（可能已删或换了会话）' } });
  const r = await api['memory.edit']({ body: { id: 'nope', chatId: 'g1', text: 'x' } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /没找到/);
});

test('M14 edit：editFact 抛错 → 500，不吞成成功', async () => {
  const { api } = build({ throwOn: 'editFact' });
  const r = await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', text: 'x' } });
  assert.equal(r.status, 500);
  assert.match(r.body.message, /写盘失败/);
});

test('M15 edit：成功时回显新状态（含 archived）', async () => {
  const { api, logs } = build({
    editResult: { ok: true, id: 'f9', text: '改好了', tier: 'core', pin: 0.8, archivedAt: 123 },
  });
  const r = await api['memory.edit']({ body: { id: 'f1', chatId: 'g1', text: '改好了' } });
  assert.equal(r.status, 200);
  assert.deepEqual(
    { id: r.body.id, text: r.body.text, tier: r.body.tier, pin: r.body.pin, archived: r.body.archived },
    { id: 'f9', text: '改好了', tier: 'core', pin: 0.8, archived: true },
  );
  assert.ok(logs.some((m) => m.includes('改记忆')));
});

test('M16 edit：正文超长要报错，不能悄悄截短', async () => {
  const { api, memory } = build();
  const r = await api['memory.edit']({
    body: { id: 'f1', chatId: 'g1', text: '字'.repeat(MAX_FACT_CHARS + 1) },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /太长了/);
  assert.equal(memory.calls.length, 0);

  /** emoji 按码点算：2001 个 = 4002 个 UTF-16 码元，仍该按 2001 判 */
  const emoji = await api['memory.edit']({
    body: { id: 'f1', chatId: 'g1', text: '😺'.repeat(MAX_FACT_CHARS + 1) },
  });
  assert.equal(emoji.status, 400);
});

test('M17 chatId 超长要报错，不能截短了改到另一个会话', async () => {
  const { api, memory } = build();
  const long = 'g'.repeat(MAX_CHAT_ID + 1);
  assert.equal((await api['memory.facts']({ query: { chatId: long } })).status, 400);
  assert.equal((await api['memory.edit']({ body: { id: 'f1', chatId: long, text: 'x' } })).status, 400);
  assert.equal(memory.calls.length, 0);
});

test('M18 构造时缺 memoryOf 要立刻炸', () => {
  assert.throws(() => createExtMemoryEdit({}), /memoryOf/);
});
