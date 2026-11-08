/**
 * 阶段 6b：C2 pending 惦记清单。
 *
 * 最容易静默出错的几处：进审核的消息被当成「问过了」、
 * 清 pending 顺手把「上次聊到」的收尾记录也删了、
 * 惦记的 TTL 跟着收尾的 7 天一起消失、群里也被抬分。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClosing, shouldNotePending, DEFAULTS,
} from '../src/closing.js';
import {
  opportunities, pickOpportunity, buildWakePrompt,
} from '../src/awake.js';

const DAY = 86400000;
const noon = () => {
  const d = new Date();
  d.setHours(14, 0, 0, 0);
  return d.getTime();
};

function fresh(cfg = {}) {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-c2-'));
  return createClosing(cfg);
}

/* ---------------- 记入闸门 ---------------- */

test('C2：只有「确实送达的私聊问句」才记成惦记', () => {
  const base = { ok: true, pending: false, scene: 'c2c', text: '周末去看电影吗？' };
  assert.equal(shouldNotePending(base), true);
  assert.equal(shouldNotePending({ ...base, ok: false }), false, '没发成功不算问过');
  assert.equal(shouldNotePending({ ...base, pending: true }), false, '进审核还没人看见');
  assert.equal(shouldNotePending({ ...base, scene: 'group' }), false, '群里不惦记谁没回');
  assert.equal(shouldNotePending({ ...base, text: '今天天气不错' }), false, '陈述句没有等答复');
  assert.equal(shouldNotePending(), false);
});

/* ---------------- closing 数据层 ---------------- */

test('C2：notePending / pending / clearPending 往返，且不碰收尾记录', () => {
  const c = fresh();
  c.set('u1', { point: '聊到一半', resume: '下次接着说' });
  assert.equal(c.notePending('u1', '周末去看电影吗'), true);
  assert.equal(c.pending('u1').text, '周末去看电影吗');
  assert.equal(c.get('u1').point, '聊到一半', '记惦记不能覆盖收尾');

  assert.equal(c.clearPending('u1'), true);
  assert.equal(c.pending('u1'), null);
  assert.equal(c.get('u1').point, '聊到一半', '清惦记绝不能删掉收尾');
  assert.equal(c.clearPending('u1'), false);
});

test('C2：惦记 TTL 独立 14 天，不跟收尾的 7 天一起消失', () => {
  const c = fresh();
  c.notePending('u1', '那本书看完了吗');
  const at = c.pending('u1').at;
  assert.equal(DEFAULTS.pendingTtlDays, 14);
  assert.ok(c.pending('u1', at + 8 * DAY), '第 8 天收尾已过期，惦记还在');
  assert.equal(c.pending('u1', at + 13 * DAY).text, '那本书看完了吗');
  assert.equal(c.pending('u1', at + 15 * DAY), null, '第 15 天该忘了');
});

test('C2：群聊 / 空文本 / 关掉收尾功能都不记', () => {
  const c = fresh();
  assert.equal(c.notePending('g1', '在吗？', 'group'), false);
  assert.equal(c.notePending('u1', '   '), false);
  assert.equal(c.notePending('', '在吗？'), false);
  assert.equal(c.pending('u1'), null);

  const off = fresh({ enabled: false });
  assert.equal(off.notePending('u2', '在吗？'), false);
});

test('C2：老 closing.json 没有 pending 字段也能读，不写迁移脚本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-c2-old-'));
  process.env.DSH_ROOST_DATA = dir;
  writeFileSync(join(dir, 'closing.json'), JSON.stringify({
    chats: { u1: { at: Date.now(), point: '旧收尾', resume: '' } },
  }), 'utf8');
  const c = createClosing();
  assert.equal(c.get('u1').point, '旧收尾');
  assert.equal(c.pending('u1'), null);
  c.notePending('u1', '后来又问了一句？');
  assert.equal(c.pending('u1').text, '后来又问了一句？');
  assert.ok(JSON.parse(readFileSync(join(dir, 'closing.json'), 'utf8')).pending);
});

test('C2：pendingMax 上限淘汰最旧的，prune 清过期的', () => {
  const c = fresh({ pendingMax: 2 });
  c.notePending('u1', '第一句？');
  c.notePending('u2', '第二句？');
  c.notePending('u3', '第三句？');
  assert.equal(c.pending('u1'), null);
  assert.equal(c.pending('u3').text, '第三句？');

  const db = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'closing.json'), 'utf8'));
  db.pending.u3.at = Date.now() - 30 * DAY;
  writeFileSync(join(process.env.DSH_ROOST_DATA, 'closing.json'), JSON.stringify(db), 'utf8');
  const again = createClosing({ pendingMax: 2 });
  assert.equal(again.prune(), true);
  assert.equal(again.pending('u3'), null);
});

/* ---------------- 机会与提示词 ---------------- */

const BASE = {
  now: noon(),
  mood: { energy: 0.5, sociability: 0.5 },
  agreements: [],
  state: { lastOwnerAt: noon() },
  cfg: {},
};

test('C2：惦记给随性 +0.35 并打优先标记，没惦记时分数与老版本一致', () => {
  const plain = opportunities(BASE).find((o) => o.kind === 'casual');
  const withP = opportunities({ ...BASE, pending: '周末去看电影吗' }).find((o) => o.kind === 'casual');
  assert.ok(plain && withP);
  assert.equal(plain.pendingBoost, undefined);
  assert.equal(Math.round((withP.score - plain.score) * 100) / 100, 0.35);
  assert.equal(withP.pendingBoost, true);
  assert.match(withP.reason, /心里还惦记着/);
});

test('C2：pickOpportunity 一半机会让惦记插队，另一半照常加权', () => {
  const list = [{ kind: 'agreement', score: 1 }, { kind: 'casual', score: 0.74, pendingBoost: true }];
  assert.equal(pickOpportunity(list, () => 0).kind, 'casual', '前半段直接插队');
  assert.equal(pickOpportunity(list, () => 0.55).kind, 'agreement', '后半段仍按分数加权');
  /** 没有 boost 标记时不该多摇一次随机数（老部署随机序列不变） */
  let calls = 0;
  pickOpportunity([{ kind: 'casual', score: 0.4 }], () => { calls += 1; return 0; });
  assert.equal(calls, 1);
});

test('C2：提示词带上惦记，并明确不许催回复；没惦记时一字不加', () => {
  const plain = buildWakePrompt({ opp: { kind: 'casual', reason: 'x' }, ctx: {} });
  assert.ok(!plain.includes('心里还惦记着'));

  const p = buildWakePrompt({
    opp: { kind: 'casual', reason: 'x' },
    ctx: { pending: '周末去看电影吗' },
  });
  assert.match(p, /心里还惦记着/);
  assert.match(p, /周末去看电影吗/);
  assert.match(p, /别追问「怎么不回我」/);
  assert.match(p, /<<skip>>/, '惦记不该顶掉「可以不说话」的出口');
});
