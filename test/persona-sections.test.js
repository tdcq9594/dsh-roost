/**
 * 5.5 人格分节编辑：切分 / 重组 / 只改一段 / 草稿接线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  splitPersonaText, joinPersonaText, joinPersonaBlocks, sanitizeBlocks,
  looseTitleOf, PERSONA_SECTIONS, MAX_BLOCKS,
} from '../src/persona-sections.js';
import { parsePersona } from '../src/personas.js';

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const RAW = `---
name: test
tags: [a, b]
tools: []
---

你是小栖，说话轻快。

## 性格底色
不要写「首先其次总之」。

## 开场白
嗨，我来啦。

## 说话示例
群友：在吗
小栖：在呀

## 世界书
考试, 期末 | 她记得你上周说要复习
`;

test('切成四段，frontmatter 与未命名小节原样留在性格里', () => {
  const s = splitPersonaText(RAW);
  assert.match(s.front, /tools: \[\]/, '头部一行不能丢（丢了限制会静默失效）');
  assert.match(s.sections.body, /^你是小栖/);
  assert.match(s.sections.body, /## 性格底色/, '没被认成命名段的标题要留在正文');
  assert.equal(s.sections.firstMes, '嗨，我来啦。');
  assert.match(s.sections.demos, /群友：在吗/);
  assert.match(s.sections.lore, /考试, 期末/);
  assert.deepEqual(s.order, ['firstMes', 'demos', 'lore']);
  assert.deepEqual(PERSONA_SECTIONS.map((x) => x.key), ['body', 'firstMes', 'demos', 'lore']);
});

test('三种标题格式与「回复示例」别名都认', () => {
  const alt = `---\nname: x\n---\n\n正文\n\n一、开场白\n你好\n\n第一部分 · 回复示例\nA：1\nB：2\n\n二、世界书\n关键词 | 内容\n`;
  const s = splitPersonaText(alt);
  assert.equal(s.sections.firstMes, '你好');
  assert.match(s.sections.demos, /A：1/);
  assert.match(s.sections.lore, /关键词 \| 内容/);
  assert.equal(s.sections.body, '正文');
  /** 原标题行要留着，重组后才知道用哪种写法 */
  assert.match(s.titles.firstMes, /一、开场白/);
  assert.match(s.titles.demos, /第一部分/);
});

test('round-trip：原样拼回去内容不丢，parsePersona 语义一致', () => {
  const snap = splitPersonaText(RAW);
  const joined = joinPersonaText(snap, snap.sections);
  const again = splitPersonaText(joined);
  assert.deepEqual(again.sections, snap.sections, '切→拼→切 幂等');
  assert.equal(again.front.trim(), snap.front.trim());

  const before = parsePersona('x', RAW);
  const after = parsePersona('x', joined);
  assert.equal(after.body, before.body);
  assert.equal(after.firstMes, before.firstMes);
  assert.equal(after.demos, before.demos);
  assert.deepEqual(after.lore, before.lore);
  assert.deepEqual(after.tools, before.tools, '头部 tools 限制不能变');
});

test('只改一段：其它段、头部、未命名小节一个字不动', () => {
  const snap = splitPersonaText(RAW);
  const joined = joinPersonaText(snap, { ...snap.sections, demos: '群友：晚安\n小栖：好梦' });
  assert.match(joined, /tools: \[\]/);
  assert.match(joined, /## 性格底色/);
  assert.match(joined, /嗨，我来啦。/);
  assert.match(joined, /考试, 期末/);
  assert.match(joined, /群友：晚安/);
  assert.equal(joined.includes('群友：在吗'), false);
});

test('清空一段 = 删掉那一段（连标题一起），不会留空壳', () => {
  const snap = splitPersonaText(RAW);
  const joined = joinPersonaText(snap, { ...snap.sections, lore: '' });
  assert.equal(joined.includes('## 世界书'), false);
  assert.equal(joined.includes('考试, 期末'), false);
});

test('接线：两条路由、服务端当骨架、任意段数、草稿都在，整份编辑没删', () => {
  const host = src('src/host.js');
  assert.ok(host.includes("route('/personas/sections'"), '要有读分节');
  assert.ok(host.includes("route('/personas/sections/save'"), '要有存分节');
  assert.ok(host.includes('blocks: snap.blocks'), '读接口要回逐段视图');
  assert.ok(host.includes('joinPersonaBlocks(snap, blocks)'), '保存要支持任意段数');
  assert.ok(host.includes('const snap = splitPersonaText(p.raw)'), '必须用服务端当前文件当骨架');

  const client = src('client/client.js');
  assert.ok(client.includes('function SectionEditor'), '分节编辑器要在');
  assert.ok(client.includes("const PERSONA_SECTIONS = ["), '四段定义要在（内置段仍给提示）');
  assert.ok(client.includes("'roost.persona.draft.'"), '草稿要落 localStorage');
  assert.ok(client.includes("post('/personas/sections/save', { id, blocks })"), '保存逐段');
  assert.ok(client.includes('自动识别出'), '要说清是自动识别，不是手敲');
  assert.ok(client.includes("'加一段'"), '要有加段按钮');
  assert.ok(client.includes("'删掉这段'"), '要有删段按钮');
  assert.ok(client.includes('段名（留空 = 无标题正文）'), '段名可编辑');
  assert.ok(client.includes('恢复草稿'), '要有草稿恢复入口');
  assert.ok(client.includes("editMode === 'sections'"), '模式切换要在');
  assert.ok(client.includes("post('/personas/save', { id: editId, raw })"), '原来的整份编辑一个都不能删');
});

test('自动识别：每个标题各占一段，段名和内容都从原文来', () => {
  const s = splitPersonaText(RAW);
  assert.equal(s.blocks.length, 5, '开头正文 + 性格底色 + 三个内置段');
  assert.equal(s.blocks[0].key, 'body');
  assert.equal(s.blocks[0].title, '', '开头是无标题正文');
  assert.match(s.blocks[0].text, /你是小栖/);
  assert.equal(s.blocks[1].title, '性格底色');
  assert.equal(s.blocks[1].custom, true, '不是四个内置关键词，但不能丢');
  assert.match(s.blocks[1].text, /不要写/);
  assert.deepEqual(s.blocks.slice(2).map((b) => b.title), ['开场白', '说话示例', '世界书']);
});

test('宽松标题也自动识别：括号 / 加粗 / 编号 / 冒号', () => {
  const raw = `---\nname: x\n---\n\n你是小栖。\n\n【禁忌】\n不许说教\n\n**边界**\n不聊政治\n\n1. 节奏\n短句为主\n\n性格：\n轻快但不吵\n`;
  assert.equal(looseTitleOf('【禁忌】'), '禁忌');
  assert.equal(looseTitleOf('**边界**'), '边界');
  assert.equal(looseTitleOf('1. 节奏'), '节奏');
  assert.equal(looseTitleOf('性格：'), '性格');
  assert.equal(looseTitleOf('考试, 期末 | 内容'), '', '世界书表格行不是标题');
  assert.equal(looseTitleOf('- 一条列表项'), '', '列表项不是标题');

  const s = splitPersonaText(raw);
  assert.deepEqual(s.blocks.map((b) => b.title), ['', '禁忌', '边界', '节奏', '性格']);
  assert.equal(s.blocks[2].text, '不聊政治');
  /** 这些都不是内置关键词，四段视图里也要原样留着 */
  for (const t of ['【禁忌】', '不许说教', '**边界**', '不聊政治', '1. 节奏', '短句为主', '性格：', '轻快但不吵']) {
    assert.ok(s.sections.body.includes(t), `四段视图里也要留着 ${t}`);
  }
});

test('逐段写回：没改段名就沿用原始标题行，头部不丢，切→拼→切幂等', () => {
  const s = splitPersonaText(RAW);
  const out = joinPersonaBlocks(s, s.blocks);
  assert.match(out, /## 性格底色/);
  assert.match(out, /tools: \[\]/);
  const again = splitPersonaText(out);
  assert.deepEqual(
    again.blocks.map((b) => ({ title: b.title, text: b.text })),
    s.blocks.map((b) => ({ title: b.title, text: b.text })),
  );

  const alt = splitPersonaText('---\nname: x\n---\n\n正文\n\n一、开场白\n你好\n\n【禁忌】\n不许说教\n');
  const out2 = joinPersonaBlocks(alt, alt.blocks);
  assert.match(out2, /一、开场白/, '没改段名就不要偷偷换成 ## ');
  assert.match(out2, /【禁忌】/, '宽松格式同样原样保留');
});

test('自定义：加段 / 改段名 / 清空段名 / 删段', () => {
  const s = splitPersonaText(RAW);
  const added = [...s.blocks, { title: '我的新段', titleLine: '', text: '新内容' }];
  assert.match(joinPersonaBlocks(s, added), /## 我的新段\n新内容/);

  const renamed = s.blocks.map((b) => (b.key === 'demos' ? { ...b, title: '对话样例' } : b));
  const out2 = joinPersonaBlocks(s, renamed);
  assert.match(out2, /## 对话样例/);
  assert.equal(out2.includes('## 说话示例'), false);

  /** 段名清空 = 这段变成无标题正文，内容不删 */
  const noTitle = s.blocks.map((b) => (b.key === 'lore' ? { ...b, title: '' } : b));
  const out3 = joinPersonaBlocks(s, noTitle);
  assert.equal(out3.includes('## 世界书'), false);
  assert.match(out3, /考试, 期末/);

  const removed = s.blocks.filter((b) => b.key !== 'firstMes');
  const out4 = joinPersonaBlocks(s, removed);
  assert.equal(out4.includes('嗨，我来啦'), false);
  assert.match(out4, /tools: \[\]/, '删段也不能把头部弄丢');
});

test('sanitizeBlocks：段名不许带换行，段数有上限', () => {
  const got = sanitizeBlocks([{ title: 'A\nB', titleLine: '## X', text: 'hi' }]);
  assert.equal(got[0].title, 'A B');
  assert.equal(got[0].text, 'hi');
  const many = sanitizeBlocks(Array.from({ length: 200 }, (_, i) => ({ title: 's' + i, text: 'x' })));
  assert.equal(many.length, MAX_BLOCKS);
});
