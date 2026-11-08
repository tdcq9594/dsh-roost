/**
 * 阶段 6a：C1 主动防复读 + C4 casual 真实素材。
 *
 * 最容易静默出错的几处：默认没素材时 prompt 被悄悄改了、
 * 复读检查放过「换个尾巴」、检查命中却还是发了出去、
 * 「想你」那一档被塞进「最近做过的事」变成汇报。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  textSimilarity, isDuplicateText, DUP_THRESHOLD,
  buildWakePrompt, createAwake, wakeMaterials,
} from '../src/awake.js';
import { createFakeChannel } from '../src/channel.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-awake-c1-'));
const noon = () => {
  const d = new Date();
  d.setHours(14, 0, 0, 0);
  return d.getTime();
};
/** 全天清醒，避免测试跟着真实钟点飘 */
const CFG = { enabled: true, awakeFrom: 0, awakeTo: 0, missAfterHours: 6, minScore: 0.35, casualPerDay: 1 };

/* ---------------- C1 纯函数 ---------------- */

test('C1：相似是连续值，不是整句等值判断', () => {
  assert.equal(DUP_THRESHOLD, 0.55);
  assert.equal(textSimilarity('在干嘛', '在干嘛'), 1);
  assert.equal(textSimilarity('（伸懒腰）在干嘛～', '在干嘛'), 1, '括号动作与标点不算正文');
  assert.ok(textSimilarity('在干嘛', '在干嘛呀') > DUP_THRESHOLD, '换个尾巴要能抓住');
  assert.ok(textSimilarity('周末去看电影吗', '记得交房租') < DUP_THRESHOLD, '完全不同的事不该被拦');
  assert.equal(textSimilarity('', '在干嘛'), 0);
  assert.equal(textSimilarity('嗯', ''), 0);
});

test('C1：isDuplicateText 命中任一历史即算复读，阈值可覆盖', () => {
  const recent = ['昨天那部电影看完了吗', '要不要一起吃饭'];
  assert.equal(isDuplicateText('昨天那部电影看完了吗～', recent), true);
  assert.equal(isDuplicateText('明天降温记得加衣', recent), false);
  assert.equal(isDuplicateText('明天降温记得加衣', []), false);
  assert.equal(isDuplicateText('', recent), false, '空正文不算复读，交给 parseVerdict 处理');
  assert.equal(isDuplicateText('要不要一起吃饭', recent, 0.99), true);
  assert.equal(isDuplicateText('要不要一起吃饭呀', recent, 0.99), false, '阈值调高就放宽');
});

/* ---------------- prompt 形状 ---------------- */

test('C1/C4：没素材时 prompt 一个字都不加（默认等价）', () => {
  const plain = buildWakePrompt({ opp: { kind: 'casual', reason: '想随便说句话' }, ctx: {} });
  assert.ok(!plain.includes('最近你已经主动说过'));
  assert.ok(!plain.includes('最近做过的事'));
  assert.match(plain, /<<skip>>/, '不说话的出口还在');
});

test('C1：最近主动说过的话进 prompt，并明确挡住换措辞', () => {
  const p = buildWakePrompt({
    opp: { kind: 'casual', reason: '想随便说句话' },
    ctx: { recentBot: ['在干嘛', '吃饭了吗'] },
  });
  assert.match(p, /最近你已经主动说过/);
  assert.match(p, /· 在干嘛/);
  assert.match(p, /别换个说法再说一遍/);
});

test('C4：做过的事只给 casual / agreement，不给「想你」', () => {
  const ctx = { done: ['在私聊发过文件', '在群里主动找过你'] };
  const casual = buildWakePrompt({ opp: { kind: 'casual', reason: 'x' }, ctx });
  const agreement = buildWakePrompt({ opp: { kind: 'agreement', reason: 'x' }, ctx });
  const miss = buildWakePrompt({ opp: { kind: 'miss', reason: 'x' }, ctx });
  assert.match(casual, /最近做过的事/);
  assert.match(casual, /· 在私聊发过文件/);
  assert.match(agreement, /最近做过的事/);
  assert.ok(!miss.includes('最近做过的事'), '沉默很久就汇报自己做过什么，很不像人');
});

/* ---------------- compose 真接线 ---------------- */

function scene({ recentBot = [], reply = '明天降温记得加衣' } = {}) {
  const ch = createFakeChannel();
  let calls = 0;
  let prompt = '';
  const a = createAwake({
    dataDir: tmp(),
    cfgOf: () => ({ awake: CFG }),
    channelOf: () => ch,
    authzOf: () => true,
    contextOf: () => ({
      chatId: 'u1',
      mood: { sociability: 1, energy: 1 },
      agreements: ['周末看电影'],
      state: { lastOwnerAt: 0 },
      recent: [],
      recentBot,
    }),
    generate: async (p) => { calls += 1; prompt = p; return reply; },
    log: () => {},
    now: () => noon(),
    rand: () => 0,
  });
  return { a, ch, calls: () => calls, prompt: () => prompt };
}

test('C1：模型换个说法复述最近主动说过的话 → 不发', async () => {
  const s = scene({ recentBot: ['明天降温记得加衣'], reply: '明天降温记得加衣～' });
  const v = await s.a.compose({ kind: 'c2c' });
  assert.equal(s.calls(), 1, '该问还是问了');
  assert.equal(v.speak, false);
  assert.equal(v.duplicate, true);
  assert.match(v.why, /防复读/);
  assert.equal(s.ch.sent.length, 0);
  assert.match(s.prompt(), /最近你已经主动说过/, '素材确实进了提示词');
});

test('C1：说别的事照常发；没有历史素材时行为与老版本一致', async () => {
  const fresh = scene({ recentBot: [], reply: '在干嘛' });
  const a = await fresh.a.compose({ kind: 'c2c' });
  assert.equal(a.speak, true, '没历史可比对，不该凭空拦下');
  assert.equal(a.duplicate, undefined);

  const other = scene({ recentBot: ['昨天那部电影看完了吗'], reply: '明天降温记得加衣' });
  const b = await other.a.compose({ kind: 'c2c' });
  assert.equal(b.speak, true);
  assert.equal(b.text, '明天降温记得加衣');
});

test('C1：模型自己给 <<skip>> 时不该被误标成防复读', async () => {
  const s = scene({ recentBot: ['在干嘛'], reply: '<<skip>>' });
  const v = await s.a.compose({ kind: 'c2c' });
  assert.equal(v.speak, false);
  assert.equal(v.duplicate, undefined, 'skip 是她自己决定不说，不是被相似度拦下');
  assert.match(v.why, /她自己决定不说/);
});

/* ---------------- host 素材拼装（纯函数层） ---------------- */

test('C1：wakeMaterials 只挑 bot 行、最多 3 条、正文截断', () => {
  const rows = [
    { role: 'bot', text: '第一句' },
    { role: 'user', text: '对方说的，不该进清单' },
    { role: 'digest', text: '摘要也不该算' },
    { role: 'bot', digest: '第二句的摘要', text: '第二句原文很长' },
    { role: 'bot', text: '第三句' },
    { role: 'bot', text: '第四句' },
  ];
  const { recentBot } = wakeMaterials({ journalRows: rows });
  assert.deepEqual(recentBot, ['第一句', '第二句的摘要', '第三句']);
});

test('C4：events 关着一定不给素材，开着才用 label 拼', () => {
  const ev = [{ kind: 'file', scene: 'group' }, { kind: 'proactive', scene: 'c2c' }];
  const labels = { file: '发过文件', proactive: '主动找过你' };
  assert.deepEqual(wakeMaterials({ eventRows: ev, eventsEnabled: false, labels }).done, [],
    '功能关了还把旧动作翻出来说，等于关了没关');
  assert.deepEqual(wakeMaterials({ eventRows: ev, eventsEnabled: true, labels }).done,
    ['在群里发过文件', '在私聊主动找过你']);
  assert.deepEqual(wakeMaterials({ journalRows: [], eventRows: [], eventsEnabled: true }).recentBot, []);
});
