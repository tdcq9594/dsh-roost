import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildMindModel, renderMindModel } from '../src/mind-model.js';

const facts = [
  { text: '主人住在杭州', w: 3, kind: 'world', trend: 'stable', evidence: [{ quote: '我住杭州', journalId: 'm1' }] },
  { text: '杭州的冬天很冷', w: 1, kind: 'observation', trend: 'weakening', evidence: [] },
  { text: '朋友住在上海', w: 2, kind: 'world', trend: 'stale', evidence: [{ quote: '他住上海', journalId: 'm2' }] },
  { text: '没有实体的散记', w: 1, trend: 'new', evidence: [] },
  { text: '旧说法', w: 5, until: 123, evidence: [] },
  { text: '已归档', w: 5, archivedAt: 456, evidence: [] },
];

test('B2-1 按实体聚类：最长名字优先；无实体归其他；已取代/归档排除', () => {
  const tree = buildMindModel(facts, ['杭州', '上海']);
  assert.deepEqual(tree.groups.map((g) => g.entity).sort(), ['上海', '其他', '杭州'].sort());
  assert.equal(tree.total, 4, '6 条里 2 条已失效，剩 4 条');
  const hz = tree.groups.find((g) => g.entity === '杭州');
  assert.equal(hz.facts.length, 2);
  assert.equal(hz.facts[0].text, '主人住在杭州', '权重高的在前');
  assert.equal(tree.groups.find((g) => g.entity === '其他').facts[0].text, '没有实体的散记');
  assert.ok(!JSON.stringify(tree).includes('旧说法'));
  assert.ok(!JSON.stringify(tree).includes('已归档'));
});

test('B2-2 最长实体名优先，不被短词抢走', () => {
  const tree = buildMindModel(
    [{ text: '杭州的朋友来了', w: 1, evidence: [] }],
    ['杭州', '杭州的朋友'],
  );
  assert.equal(tree.groups[0].entity, '杭州的朋友');
});

test('B2-3 trend 计数 + markdown 可导出、可注入', () => {
  const tree = buildMindModel(facts, ['杭州', '上海']);
  assert.equal(tree.staleCount, 2, 'weakening + stale 各一条');
  const md = renderMindModel(tree);
  assert.ok(md.includes('# 她现在相信什么'));
  assert.ok(md.includes('## 杭州'));
  assert.ok(md.includes('证据走弱'), '过时提醒要在');
  assert.ok(md.includes('我住杭州'), '引文要在，可核验');
  assert.ok(md.includes('[observation]'), '种类标注要在');
  assert.ok(!md.includes('旧说法'));
});

test('B2-4 maxChars 截断保整组，不把一组切一半', () => {
  const tree = buildMindModel(facts, ['杭州', '上海']);
  const md = renderMindModel(tree, { maxChars: 120 });
  assert.ok(md.length <= 200, `截断生效，实际 ${md.length}`);
  assert.ok(md.startsWith('# 她现在相信什么'));
});

test('B2-5 空输入不炸', () => {
  const tree = buildMindModel([], []);
  assert.equal(tree.total, 0);
  assert.ok(renderMindModel(tree).includes('共 0 条'));
});

test('B2 接线：host 提供 mind.model 只读 op，scope 表登记为 memory:read', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const scopes = readFileSync(new URL('../src/ext-quick-scopes.js', import.meta.url), 'utf8');
  assert.match(host, /case 'mind\.model'/, 'host 要有只读 op');
  assert.match(host, /buildMindModel\(/, 'op 要真调建树，不能空壳');
  assert.match(scopes, /'mind\.model': 'memory:read'/, 'scope 要登记，否则扩展调不到');
});

test('B3 接线：过时提醒只在 deep 段注入，且只标注不改正文', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(host, /if \(deep\) \{[\s\S]*staleSec =/, '只在 deep 段算过时提醒');
  assert.match(host, /factsChat, staleSec, selfSec/, '过时提醒排在事实之后');
  assert.match(host, /别当准信/, '措辞是提醒模型拿不准就问，不是改写结论');
  assert.match(host, /!x\.until && !x\.archivedAt/, '已取代/归档的不提醒');
});

test('E1 接线：显式指令段在 deep 注入、排在事实之前', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(host, /directiveSec = /, '要有指令段');
  assert.match(host, /rules, directiveSec, factsGlobal/, '指令排在普通事实之前');
  assert.match(host, /她交代过的规矩/, '措辞是规矩不是建议');
});

test('自检-B2：maxChars 很小时也吐一条截断事实，不只空标题；换行不能伪造标题', () => {
  const tree = buildMindModel([
    { text: '第一行\n## 伪造的标题', w: 5, evidence: [{ quote: '引\n## 假标题' }] },
  ], ['杭州']);
  const md = renderMindModel(tree, { maxChars: 60 });
  assert.ok(md.includes('伪造的标题'), '截断版仍要给事实内容');
  assert.ok(!md.includes('\n## 伪造的标题'), '正文换行被压平，不能伪造标题');
  assert.ok(!md.includes('\n## 假标题'), '引文也不能带换行');
});
