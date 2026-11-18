import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGraph } from '../src/graph.js';
import { createJournal } from '../src/journal.js';
import { readFeatures, visibleGroups, FEATURES } from '../src/features.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-adj-'));
const G1 = 'G1G1G1G1G1G1G1G1G1G1G1G1G1G1G1G1';
const G2 = 'G2G2G2G2G2G2G2G2G2G2G2G2G2G2G2G2';
const OLD = 'OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD';
const NEW = 'NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW';

/** 造一条「人 / 事」的边，并给它一条来源日记（二跳靠 episode.journal_id 反查） */
function link(g, { src, rel, dst, chatId = '', journalId, at = Date.now() }) {
  const ep = g.addEpisode({ at, chatId, text: `${src}${rel}${dst}`, journalId });
  g.addEdge({ src, rel, dst, chatId, at, episodeId: ep });
  return ep;
}

/* ---------------- 二跳本体 ---------------- */

test('P1 邻接：顺着邻接实体再取一层日记', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  link(g, { src: '张三', rel: '一起', dst: '李四', chatId: G1, journalId: 'j-zhang', at: t });
  link(g, { src: '李四', rel: '在忙', dst: '搬家', chatId: G1, journalId: 'j-li', at: t + 1 });

  const hop1 = g.linkedJournalIds('张三', { chatId: G1 });
  assert.deepEqual(hop1, ['j-zhang'], '第一跳只拿自己边上的日记');

  const hop2 = g.adjacentJournalIds('张三', { chatId: G1 });
  const fresh = hop2.filter((id) => !hop1.includes(id));
  assert.deepEqual(fresh, ['j-li'], '二跳要顺着李四拿到他自己的日记，且不重复第一跳');
  g.close();
});

test('P1 邻接：keys 为空直接不启用（私聊不许全表扫）', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  link(g, { src: '张三', rel: '一起', dst: '李四', chatId: G1, journalId: 'j1' });
  link(g, { src: '李四', rel: '在忙', dst: '搬家', chatId: G1, journalId: 'j2' });
  assert.deepEqual(g.adjacentJournalIds('张三', { chatId: '' }), [],
    'chatScope 在 keys 为空时不过滤 = 全表扫，二跳必须自己挡住');
  g.close();
});

test('P1 邻接：全局边能参与，但只带出本会话的日记', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  /** 全局边 + 别的会话的日记：都是「看着能联想、实际会串味」的样本 */
  link(g, { src: '张三', rel: '认识', dst: '王五', chatId: '', journalId: 'j-global', at: t });
  link(g, { src: '王五', rel: '在忙', dst: '别的群的事', chatId: G2, journalId: 'j-g2', at: t + 1 });
  /** 本群这一串才是该被找到的 */
  link(g, { src: '张三', rel: '一起', dst: '李四', chatId: G1, journalId: 'j-g1a', at: t + 2 });
  link(g, { src: '李四', rel: '在忙', dst: '搬家', chatId: G1, journalId: 'j-g1b', at: t + 3 });

  const out = g.adjacentJournalIds('张三', { chatId: G1 }).sort();
  assert.deepEqual(out, ['j-g1a', 'j-g1b'], '第二跳边和日记都卡在本会话，别群的日记进不来');
  g.close();
});

test('P1 邻接：全局实体（主人这类跨会话的人）能参与本群联想', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  /**
   * 真实库的形态：跨会话的人挂在 `chat_id=''` 下，边也常常是全局的。
   * 如果连实体和边都限定本会话，这一路在真实数据上恒为空——那 P1 就等于没做。
   * 所以只卡日记归属：episode 在哪个会话，就只联想那个会话的日记。
   */
  const e1 = g.addEpisode({ at: t, chatId: '', text: '主人是倦飞之鸟', journalId: 'j-global' });
  g.addEdge({ src: '主人', rel: '是', dst: '倦飞之鸟', chatId: '', at: t, episodeId: e1 });
  const e2 = g.addEpisode({ at: t + 1, chatId: G1, text: '倦飞之鸟在优化她的程序', journalId: 'j-g1' });
  g.addEdge({ src: '倦飞之鸟', rel: '在优化', dst: '她的程序', chatId: '', at: t + 1, episodeId: e2 });

  const out = g.adjacentJournalIds('主人', { chatId: G1 });
  assert.equal(out.includes('j-g1'), true, '全局实体经全局边走到本群 episode，要能拿到');
  assert.equal(out.includes('j-global'), false, '但全局 episode 的日记不属于这个群，不能带进来');
  g.close();
});

test('P1 邻接：只走活边', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  link(g, { src: '张三', rel: '一起', dst: '李四', chatId: G1, journalId: 'j-a', at: t });
  link(g, { src: '李四', rel: '在忙', dst: '搬家', chatId: G1, journalId: 'j-b', at: t + 1 });
  assert.ok(g.adjacentJournalIds('张三', { chatId: G1 }).includes('j-b'));

  g.closeEdge({ src: '李四', rel: '在忙', chatId: G1 });
  assert.equal(g.adjacentJournalIds('张三', { chatId: G1 }).includes('j-b'), false,
    '关系已经结束，不该再被联想出来');
  g.close();
});

test('P1 邻接：limit 生效，且按日记时间倒序', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  link(g, { src: '张三', rel: '一起', dst: '李四', chatId: G1, journalId: 'j-hub', at: t });
  for (let i = 0; i < 5; i += 1) {
    link(g, { src: '李四', rel: `事${i}`, dst: `东西${i}`, chatId: G1, journalId: `j-n${i}`, at: t + i + 1 });
  }
  const out = g.adjacentJournalIds('张三', { chatId: G1, limit: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out, ['j-n4', 'j-n3'], '取最新两条');
  g.close();
});

test('P1 邻接：换机器人后靠别名仍能联想', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  link(g, { src: '张三', rel: '一起', dst: '李四', chatId: OLD, journalId: 'j-old1', at: t });
  link(g, { src: '李四', rel: '在忙', dst: '搬家', chatId: OLD, journalId: 'j-old2', at: t + 1 });

  assert.deepEqual(g.adjacentJournalIds('张三', { chatId: NEW }), [], '只看新键，什么都没有');
  const out = g.adjacentJournalIds('张三', { chatId: NEW, aliases: [OLD] });
  assert.ok(out.includes('j-old2'), '带上别名要能读到旧键下的二跳');
  g.close();
});

/* ---------------- 融合权重 ---------------- */

test('P1 邻接：弱关联的融合权重必须低于直接关联', async () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const at = Date.now();
  j.add({ id: 'strong', chatId: G1, text: '主人说张三今天来', role: 'user', kind: 'chat', at });
  j.add({ id: 'weak', chatId: G1, text: '李四搬家的事', role: 'user', kind: 'chat', at });

  const out = await j.search('张三', {
    chatId: G1,
    entityJournalIds: ['strong', 'weak'],
    entityWeights: new Map([['weak', 0.3]]),
    limit: 5,
    touch: false,
  });
  const s = out.find((r) => r.id === 'strong');
  const w = out.find((r) => r.id === 'weak');
  assert.ok(s && w, '两条都该进候选');
  assert.ok(s.score > w.score, `直接关联该压过邻接联想：${s.score} vs ${w.score}`);
  assert.ok(Math.abs(w.score - 0.3 / 61) < 1e-12, `弱关联只拿 0.3 的权重：${w.score}`);
  j.close();
});

test('P1 邻接：不传 entityWeights 时仍按 0.5（老调用点逐字节不变）', async () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const at = Date.now();
  j.add({ id: 'only', chatId: G1, text: '李四搬家的事', role: 'user', kind: 'chat', at });
  const out = await j.search('张三', {
    chatId: G1, entityJournalIds: ['only'], limit: 3, touch: false,
  });
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].score - 0.5 / 61) < 1e-12, `缺省仍是 0.5：${out[0].score}`);
  j.close();
});

/* ---------------- 开关 ---------------- */

test('P1 邻接：开关默认关，记忆关着时也关，面板能看见', () => {
  assert.ok(FEATURES.some((f) => f.id === 'graphAdjacent'), '开关要注册');
  assert.equal(readFeatures({}, {}).graphAdjacent, false, '默认关');
  assert.equal(readFeatures({}, { features: { graphAdjacent: true } }).graphAdjacent, true);
  assert.equal(
    readFeatures({ memory: { enabled: false } }, { features: { graphAdjacent: true } }).graphAdjacent,
    false,
    '记忆总开关关着时，没有日记可联想',
  );
  const groups = visibleGroups();
  assert.ok(groups.some((g) => g.ids.includes('graphAdjacent')), '不可见就等于没做');
});
