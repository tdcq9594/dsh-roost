/**
 * 3.4 召回预览投影（只读纯函数）。
 * 对齐 aurabot /memory/assoc/preview 的返回口径：
 * G11 升级后 hop 0（直接）/1（实体直接关联）/2（实体邻接二跳，权重0.3），
 * 不编造三跳。二跳的图 SQL 是 entity→邻居→episode 真两跳遍历。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viaOf, reasonsOf, projectRecallPreview } from '../src/recall-preview.js';

test('viaOf：从 why 文本抽实体联想来源', () => {
  assert.equal(viaOf('关键词+经「小明」联想'), '小明');
  assert.equal(viaOf('向量#1'), '');
  assert.equal(viaOf(''), '');
  assert.equal(viaOf(undefined), '');
});

test('reasonsOf：拆来源数组，去空不去序', () => {
  assert.deepEqual(reasonsOf('向量#1+关键词+那段时间'), ['向量#1', '关键词', '那段时间']);
  assert.deepEqual(reasonsOf('  关键词  +  '), ['关键词']);
  assert.deepEqual(reasonsOf(''), []);
});

test('projectRecallPreview：直接命中 hop=0，实体联想 hop=1', () => {
  const r = projectRecallPreview({
    hits: [
      { id: 'a', text: '主人喜欢喝咖啡', score: 0.91, why: '关键词+向量#1' },
      { id: 'b', digest: '小明爱打球', score: 0.63, why: '经「小明」联想' },
    ],
  });
  assert.equal(r.total, 2);
  assert.equal(r.counts.direct, 1);
  assert.equal(r.counts.hop1, 1);
  assert.equal(r.items[0].hop, 0);
  assert.equal(r.items[0].via, '');
  assert.deepEqual(r.items[0].why, ['关键词', '向量#1']);
  assert.equal(r.items[1].hop, 1);
  assert.equal(r.items[1].via, '小明');
  assert.equal(r.items[1].text, '小明爱打球'); // digest 兜底
  assert.equal(r.items[1].score, 0.63);
});

test('projectRecallPreview：limit 截断 + 分数四舍五入', () => {
  const hits = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, text: `t${i}`, score: i / 10, why: '关键词' }));
  const r = projectRecallPreview({ hits }, { limit: 3 });
  assert.equal(r.total, 3);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].score, 0);
  assert.equal(r.items[2].score, 0.2);
});

test('projectRecallPreview：脏输入不炸，空结果 counts 全 0', () => {
  const r = projectRecallPreview({ hits: [null, { id: 1, score: NaN, why: null }] });
  assert.equal(r.total, 1);
  assert.equal(r.counts.direct, 1);
  assert.equal(r.items[0].score, 0);
  assert.deepEqual(projectRecallPreview(null).counts, { direct: 0, hop1: 0, hop2: 0 });
  assert.deepEqual(projectRecallPreview({ hits: 'not-array' }).items, []);
});

test('projectRecallPreview：纯函数不改入参', () => {
  const hits = [{ id: 'a', text: 'x', score: 0.5, why: '关键词' }];
  const preview = { hits };
  const snap = JSON.stringify(preview);
  projectRecallPreview(preview);
  assert.equal(JSON.stringify(preview), snap);
});

test('G11：权重0.3的实体联想标 hop2，via 仍是起点实体，why 加「2 跳」', () => {
  const preview = {
    hits: [
      { id: 'a', text: '直接', why: '关键词', score: 0.9 },
      { id: 'b', text: '一跳实体', why: '经「小明」联想', score: 0.7 },
      { id: 'c', text: '二跳邻接', why: '经「小明」联想', score: 0.5 },
    ],
    /** 只有 c 是邻接二跳（graph.adjacentJournalIds 打的 0.3 权重） */
    entityWeights: { b: 0.5, c: 0.3 },
  };
  const r = projectRecallPreview(preview);
  assert.equal(r.counts.direct, 1);
  assert.equal(r.counts.hop1, 1);
  assert.equal(r.counts.hop2, 1);
  assert.equal(r.items[0].hop, 0);
  assert.equal(r.items[1].hop, 1);
  assert.equal(r.items[2].hop, 2);
  assert.equal(r.items[2].via, '小明');
  assert.ok(r.items[2].why.some((x) => x.includes('2 跳')), 'why 标出二跳');
  assert.ok(!r.items[1].why.some((x) => x.includes('2 跳')), '一跳不误标');
});

test('G11：没有 entityWeights 时全部按旧口径（via→hop1），向后兼容', () => {
  const r = projectRecallPreview({ hits: [{ id: 'x', text: '联想', why: '经「小红」联想', score: 0.6 }] });
  assert.equal(r.items[0].hop, 1);
  assert.equal(r.counts.hop1, 1);
  assert.equal(r.counts.hop2, 0);
});

test('G11：权重接近0.3才算二跳，脏权重不误判', () => {
  const preview = {
    hits: [{ id: 'x', text: 'x', why: '经「X」联想', score: 0.5 }],
    entityWeights: { x: '0.3' }, // 字符串 '0.3' 转成数字也该识别
  };
  assert.equal(projectRecallPreview(preview).items[0].hop, 2);
});
