/**
 * 批次 5：四批遗留 P2 回归（2026-11-06）
 * =====================================
 *
 * 只锁「本仓可自证、不碰历史数据、不改架构」的那几条：
 *  · 批次 4：手动巩固 toast 渲染撤销数
 *  · 批次 3：chat_look 的死分支 / 日记源误导文案 / 字符串 "false" 判开
 *  · 批次 2：cleanBotText 嵌套标记残骸 / L2 也作废 bot 回声
 *
 * 跑法：node --test test/batch5-p2.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readFeatures, rawFeature, forcedDenyTools } from '../src/features.js';
import { buildToolDefs } from '../src/tools.js';
import { cleanBotText, pickRevocationTargets } from '../src/journal-bridge.js';
import { createJournal } from '../src/journal.js';

const clientSrc = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

/* ---------- 批次 4：手动巩固 toast ---------- */

test('面板手动巩固 toast 渲染撤销数，且带 || 0 兜底', () => {
  assert.match(clientSrc, /巩固完成[^\n]*r\.revoked \|\| 0/);
});

/* ---------- 批次 3：chat_look 文案与 toggle 判据 ---------- */

function lookRig({
  bucket = 'owner', kind = 'c2c', chatId = 'g1', ledgerOk = true, cfg = {}, sessions = {},
} = {}) {
  const ledger = { available: () => ledgerOk, recent: () => [], chats: () => [] };
  const journal = { recentTimeline: () => [] };
  const defs = buildToolDefs({
    journal,
    graphOf: () => ({}),
    callerOf: () => ({ bucket, chatId, kind, aliases: [] }),
    cfgOf: () => cfg,
    ledgerOf: () => ledger,
    sessionOf: (id) => sessions[id] ?? null,
  });
  return Object.fromEntries(defs.map((d) => [d.name, d])).chat_look;
}

test('目标不存在时仍给完整引导文案（死分支收敛后不变）', async () => {
  /** callerOf 的 chatId 是当前会话 g1；execute 传 g2 才算跨会话，才会走到 missing */
  const look = lookRig({ bucket: 'owner', kind: 'c2c' });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.match(r.message, /先列一遍能看的会话再挑 chatId/);
});

test('日记源 + what=chats 不回「账本没开」', async () => {
  const r = await lookRig().execute({ what: 'chats', source: 'journal' });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, /账本没开/);
  assert.match(r.message, /日记源不提供会话清单/);
});

test('账本源但账本真没开时仍回「账本没开」', async () => {
  const r = await lookRig({ ledgerOk: false }).execute({ what: 'chats' });
  assert.equal(r.ok, false);
  assert.match(r.message, /账本没开/);
});

test('主人在群里 + 跨群关：拒绝文案保留动态状态，砍掉能力页尾巴', async () => {
  const look = lookRig({ bucket: 'owner', kind: 'group', cfg: { chat: { crossChatInGroup: false } } });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.match(r.message, /当前设置不允许/);
  assert.doesNotMatch(r.message, /能力页|设置决定/);
});

test('主人在频道 + 跨群开：同样不暴露能力页尾巴', async () => {
  const look = lookRig({ bucket: 'owner', kind: 'channel', cfg: { chat: { crossChatInGroup: true } } });
  const r = await look.execute({ chatId: 'g2' });
  assert.equal(r.ok, false);
  assert.match(r.message, /当前设置允许/);
  assert.doesNotMatch(r.message, /能力页|设置决定/);
});

test('readFeatures / rawFeature 把字符串 "false" 判成关', () => {
  const cfg = { chat: { tools: 'false', chatLookForMembers: 'false' } };
  assert.equal(readFeatures(cfg).chatTools, false);
  assert.equal(readFeatures(cfg).chatLookForMembers, false);
  assert.equal(rawFeature(cfg, {}, 'chatTools'), false);
});

test('字符串 "true" 与布尔 false 的既有语义不变', () => {
  assert.equal(readFeatures({ chat: { tools: 'true' } }).chatTools, true);
  assert.equal(readFeatures({ chat: { tools: false } }).chatTools, false);
  assert.equal(readFeatures({}).chatLookForMembers, false, 'default:false 仍按关');
});

test('sendFile 的 store 写成字符串 "false" 时收走 qq_send_file', () => {
  const store = { features: { sendFile: 'false' } };
  assert.equal(readFeatures({}, store).sendFile, false);
  assert.ok(forcedDenyTools({}, store).includes('qq_send_file'));
});

/* ---------- 批次 2：清洗与撤销目标 ---------- */

test('cleanBotText 剥净嵌套标记，不留 >> 残骸', () => {
  assert.doesNotMatch(cleanBotText('<<image: <<image: x>> y>>'), />>/);
});

test('cleanBotText 不误吞两段标记之间的正常正文', () => {
  const out = cleanBotText('<<image: A>> 你好 <<image: B>>');
  assert.match(out, /你好/);
  assert.match(out, /（发了图片 ×2）/);
});

test('L2 也作废与约定字面重合的 high-level bot 回声', () => {
  const rows = [
    { id: 'agree', at: 100, role: 'user', level: 'critical', text: '每句话都要配表情包' },
    { id: 'echo', at: 101, role: 'bot', level: 'important', text: '好呀，每句话都配表情包' },
  ];
  const r = pickRevocationTargets(rows, { text: '别再发表情包了', before: 200 });
  assert.equal(r.level, 'L2');
  assert.ok(r.ids.includes('echo'));
});

test('L2 不作废只共享 1 个字（或更少）的无关 bot 行', () => {
  const rows = [
    { id: 'agree', at: 100, role: 'user', level: 'critical', text: '每句话都要配表情包' },
    { id: 'other', at: 101, role: 'bot', level: 'important', text: '明天提醒我买牛奶' },
  ];
  const r = pickRevocationTargets(rows, { text: '别再发表情包了', before: 200 });
  assert.ok(!r.ids.includes('other'));
});

/* ---------- 批次 2：forget 扫不到失效行 → 只提示不抹 ---------- */

function forgetRig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-forget-'));
  const logs = [];
  const j = createJournal({ file: join(dir, 'j.sqlite'), log: (m) => logs.push(String(m)) });
  /** 先关库再删目录，否则 Windows 上 sqlite 文件还锁着会 EBUSY */
  t.after(() => {
    try { j.close(); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  });
  return { j, logs };
}

test('forget 扫不到失效行时给提示，且不动失效行原文', (t) => {
  const { j, logs } = forgetRig(t);
  const at = Date.now() - 10000;
  j.add({ id: 'agree', at, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '每句话都要配表情包', level: 'critical' });
  /** 这条**不含关键词**：只有它不含，才能证明「提示里的条数」数的是失效行 */
  j.add({ id: 'live', at: at + 1, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '今天天气不错', level: 'normal' });
  assert.equal(j.invalidate(['agree'], { supersededBy: 'msg-42' }), 1);

  const notes = [];
  assert.equal(
    j.forget({ chatId: 'g1', word: '表情包', onStale: (c) => notes.push(c) }),
    0,
    '失效行不该被抹，所以抹除数必须是 0',
  );
  assert.equal(j.get('agree').text, '每句话都要配表情包', '失效行原文必须留着（溯源链）');
  assert.ok(j.get('agree').invalidAt > 0);
  assert.deepEqual(notes, [1], '回调要报出失效条数，用户才不会以为没生效');

  const hint = logs.find((x) => x.includes('已作废'));
  assert.ok(hint, `应当提示失效行，实际日志：${JSON.stringify(logs)}`);
  assert.match(hint, /1 条已作废记录含这个词/);
});

test('forget：有效行照抹、失效行只计数，两边不混', (t) => {
  const { j } = forgetRig(t);
  const at = Date.now() - 10000;
  j.add({ id: 'old', at, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '每句话都要配表情包', level: 'critical' });
  j.add({ id: 'now', at: at + 1, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '今天表情包太多了', level: 'normal' });
  j.invalidate(['old'], { supersededBy: 'msg-42' });

  const notes = [];
  assert.equal(j.forget({ chatId: 'g1', word: '表情包', onStale: (c) => notes.push(c) }), 1, '只抹有效行');
  assert.equal(j.get('now').text, '（已按用户要求遗忘）');
  assert.equal(j.get('old').text, '每句话都要配表情包');
  assert.deepEqual(notes, [1]);
});

test('forget：没有失效行命中时不打多余日志、也不调回调', (t) => {
  const { j, logs } = forgetRig(t);
  const at = Date.now() - 5000;
  j.add({ id: 'a', at, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '明天买牛奶', level: 'normal' });
  const notes = [];
  j.forget({ chatId: 'g1', word: '牛奶', onStale: (c) => notes.push(c) });
  assert.equal(notes.length, 0);
  assert.equal(logs.filter((x) => x.includes('已作废')).length, 0);
});
