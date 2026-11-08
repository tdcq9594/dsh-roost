// 阶段 4a-II：D9 consolidate 可靠性 + 双时态核对。
//
// 对方 aurabot 的 A10③ 是「模型思考吃光预算 → 放宽 maxTokens 重试」，
// 我们从 DSH 宿主会话调模型，输出预算不在调用点手里（turn.run 只认
// source/images/timeoutMs），所以改成「空输出 / 长篇没 JSON → 收紧要求
// 再试一次」。这组测试盯的是：别把「短的非 JSON 输出」也当成要重试，
// 别让重试失败把整轮凌晨巩固带崩。
//
// A10④「双时态扩到 facts」核对后发现**本来就有**：memory.js 的
// meta.at / meta.until 就是 validFrom / validUntil，graph.js 的边也有
// valid_from / valid_to。最后两条用例把这两个事实锁死，防止以后被删。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import {
  createConsolidate, needsJsonRetry, terseJsonPrompt, yesterdayOf,
} from '../src/consolidate.js';
import { createMemory } from '../src/memory.js';

const noop = () => {};

function scene({ outputs = [], now = Date.now() } = {}) {
  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(mkdtempSync(join(tmpdir(), 'roost-retry-')), 'j.sqlite'), log: noop });
  j.add({ at: base, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '明天提醒我买牛奶' });
  j.add({ at: base + 1000, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '好，就周三吧' });
  const prompts = [];
  let i = 0;
  const generate = async (p) => {
    prompts.push(p);
    const out = outputs[Math.min(i, outputs.length - 1)];
    i += 1;
    if (out instanceof Error) throw out;
    return out;
  };
  const c = createConsolidate({
    journal: j, graph: null, memory: { add: () => true },
    generate, log: noop, now: () => now,
  });
  return { j, day, prompts, calls: () => i, run: () => c.run({ day }) };
}

/* ---------------- 纯函数 ---------------- */

test('needsJsonRetry：空输出 / 长篇没有 { 才重试', () => {
  assert.equal(needsJsonRetry('', null), true);
  assert.equal(needsJsonRetry('   \n  ', null), true);
  assert.equal(needsJsonRetry('嗯'.repeat(250), null), true, '长篇思考、一个 { 都没有');
  assert.equal(needsJsonRetry('我觉得 old 该作废吧', null), false, '短的非 JSON 保持原样，不多花一次调用');
  assert.equal(needsJsonRetry('', { summary: 'ok' }), false, '已经解析出来就不重试');
  assert.equal(needsJsonRetry('```json\n{"summary":"好"}\n```', null), false);
});

test('terseJsonPrompt：原提示词一字不丢，只追加硬要求', () => {
  const p = '下面是一天的记录\n· 甲：明天买牛奶';
  const t = terseJsonPrompt(p);
  assert.ok(t.startsWith(p));
  assert.match(t, /直接输出一个 JSON 对象/);
});

/* ---------------- 真库集成 ---------------- */

test('D9：第一次空输出、第二次给 JSON → 摘要按模型给的落盘', async () => {
  const s = scene({ outputs: ['', '{"summary":"周三提醒买牛奶","ranks":[],"compress":[],"agreements":[]}'] });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(s.calls(), 2, '只在真·空输出时重试一次');
  assert.match(s.prompts[1], /直接输出一个 JSON 对象/);
  assert.equal(s.j.get(`day:${s.day}:g1`).text, '周三提醒买牛奶');
});

test('D9：短的非 JSON 输出只调一次，整轮照常成功', async () => {
  const s = scene({ outputs: ['我觉得 old 该作废吧'] });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(s.calls(), 1);
  assert.ok(r.errors.some((e) => e.includes('解析失败')));
  assert.ok(s.j.get(`day:${s.day}:g1`), '机械摘要照样落盘');
});

test('D9：两次都空 / 重试抛错，都不带崩整轮巩固', async () => {
  const empty = scene({ outputs: [''] });
  const r1 = await empty.run();
  assert.equal(r1.ok, true);
  assert.equal(empty.calls(), 2, '最多重试一次，不循环');
  assert.ok(empty.j.get(`day:${empty.day}:g1`));

  const boom = scene({ outputs: ['', new Error('retry offline')] });
  const r2 = await boom.run();
  assert.equal(r2.ok, true);
  assert.ok(r2.errors.some((e) => e.includes('解析失败')));
  assert.ok(boom.j.get(`day:${boom.day}:g1`));
});

test('D9：一次就给 JSON 时不重试（正常路径零额外调用）', async () => {
  const s = scene({ outputs: ['{"summary":"平常的一天","ranks":[],"compress":[],"agreements":[]}'] });
  const r = await s.run();
  assert.equal(r.ok, true);
  assert.equal(s.calls(), 1);
  assert.equal(s.j.get(`day:${s.day}:g1`).text, '平常的一天');
});

/* ---------------- A10④ 核对：双时态本来就有 ---------------- */

test('A10④：facts 的 meta 已有 at/until 双时态，被取代不删行', () => {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-bitemp-'));
  const m = createMemory();
  m.add('g1', '主人住在杭州');
  m.add('g1', '主人住在杭州市');
  const full = m.listFull('g1').global;
  const dead = full.find((x) => x.text === '主人住在杭州');
  assert.ok(dead.at > 0, 'validFrom = 记下的时间');
  assert.ok(dead.until > 0, 'validUntil = 被取代的时间');
  assert.equal(full.length, 2, '不删行，历史还在面板上看得见');
});
