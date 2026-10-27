// 第 4 期（记忆）的测试：分词 / 日记 / 图谱 / 巩固。
//
// 这几块最容易"看起来跑通了其实没生效"——压了但原文没了、改了但旧边删了、
// 忘了但第二天又想起来。所以这里的断言基本都在盯**副作用**，不盯返回值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  indexTerms,
  queryTerms,
  coverage,
  passesCoverage,
  matchExpr,
  normalize,
} from '../src/tokenize.js';
import { createJournal, classify, dayOf, scoreOf, cosine, DEFAULT_KEEP_DAYS } from '../src/journal.js';
import { createGraph } from '../src/graph.js';
import {
  createConsolidate,
  parseJsonLoose,
  mechanicalDigest,
  pickRows,
  yesterdayOf,
  buildPrompt,
} from '../src/consolidate.js';
import { createEmbedder } from '../src/embed.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-mem-'));
const DAY = 86_400_000;

/* ---------------- 分词 ---------------- */

test('分词：中文切成二元组，任意两字都能命中', () => {
  const t = indexTerms('我住在杭州');
  assert.ok(t.includes('杭州'), '两字词要能切出来');
  assert.ok(t.includes('住在'));
  assert.equal(indexTerms('').length, 0);
});

test('分词：整串汉字的查询也能拆开（unicode61 做不到这件事）', () => {
  const q = queryTerms('杭州');
  assert.deepEqual(q, ['杭州']);
});

test('分词：查询侧剥疑问词，索引侧绝不剥（原文相邻关系不变）', () => {
  // 索引侧保留「么获」→ 说明「怎么」是原样留在文本里的，没被挖掉
  assert.ok(indexTerms('魂骨怎么获得').includes('么获'), '文档侧不能把疑问词挖走');
  // 查询侧把「怎么」换成断点 → 只会得到「魂骨」「获得」
  assert.deepEqual(queryTerms('魂骨怎么获得'), ['魂骨', '获得']);
});

test('分词：疑问词替换成断点，不造假词', () => {
  // 直接删掉会得到「骨获」这种原文里不存在的二元组
  assert.ok(!queryTerms('魂骨怎么获得').includes('骨获'));
});

test('分词：单字「哪」也算语气词（我住哪 → 我住）', () => {
  assert.deepEqual(queryTerms('我住哪'), ['我住']);
});

test('分词：全虚的二元组被丢掉，不会制造误命中', () => {
  // 「我们」在任何文档里都有
  assert.ok(!indexTerms('我们').includes('我们'));
});

test('分词：只说了疑问词时退回原句，不让查询变空', () => {
  assert.ok(queryTerms('怎么').length > 0);
});

test('分词：拉丁词和数字保留', () => {
  const t = indexTerms('用 gpt-4o 跑');
  assert.ok(t.some((x) => x.includes('gpt')));
});

test('分词：归一化全角和大写', () => {
  assert.equal(normalize('ＨＥＬＬＯ　世界'), 'hello 世界');
});

test('覆盖率：短查询要求全中，长查询允许只中三分之一', () => {
  const doc = indexTerms('我住在杭州，喜欢喝龙井茶');
  assert.equal(coverage(queryTerms('杭州'), doc), 1);
  assert.ok(passesCoverage(queryTerms('杭州'), doc));
  // 短查询少中一个就不算命中，否则「杭州天气」会把只提天气的也拉进来
  assert.equal(passesCoverage(['杭州', '上海'], doc), false);
  // 长查询放宽
  assert.ok(passesCoverage(['杭州', '龙井', '咖啡', '电影'], doc));
});

test('覆盖率：完全无关的查询过不了', () => {
  assert.equal(passesCoverage(queryTerms('上海的房价'), indexTerms('我住在杭州')), false);
});

test('FTS 表达式：词要加引号，否则带 - 的拉丁词会报语法错', () => {
  assert.equal(matchExpr(['gpt-4o']), '"gpt-4o"');
  assert.equal(matchExpr(['a', 'b']), '"a" OR "b"');
  assert.equal(matchExpr([]), '');
});

/* ---------------- 日记 ---------------- */

test('日记：三级判级', () => {
  assert.equal(classify('记住我生日是三月五号'), 'critical');
  assert.equal(classify('说好周末一起看电影'), 'important');
  assert.equal(classify('嗯'), 'normal');
});

test('日记：她自己的话降一档，短回复不收', () => {
  assert.equal(classify('记住他生日是三月五号', { role: 'bot' }), 'important');
  assert.equal(classify('嗯', { role: 'bot' }), 'normal');
});

test('日记：按 msg_id 幂等（同一条来两次只写一条）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const a = j.add({ id: 'm1', at: Date.now(), chatId: 'g1', text: '你好' });
  const b = j.add({ id: 'm1', at: Date.now(), chatId: 'g1', text: '你好' });
  assert.equal(a.added, true);
  assert.equal(b.added, false);
  assert.equal(j.stats().total, 1);
});

test('日记：空文本不写', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  assert.equal(j.add({ id: 'x', chatId: 'g1', text: '   ' }).added, false);
});

test('日记：关键词检索命中，跨群按 chatId 隔离', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  // 两条都是普通/重要档（不是身份事实），所以互不可见
  j.add({ id: 'a', at: t, chatId: 'g1', text: '今天去西湖边散步了' });
  j.add({ id: 'b', at: t, chatId: 'g2', text: '今天去西湖边散步了' });
  return (async () => {
    const g1 = await j.search('西湖', { chatId: 'g1' });
    assert.equal(g1.length, 1);
    assert.equal(g1[0].chatId, 'g1');
    const g2 = await j.search('西湖', { chatId: 'g2' });
    assert.equal(g2.length, 1);
    assert.equal(g2[0].chatId, 'g2');
  })();
});

test('日记：疑问词查询也能命中（剥词后仍然搜得到）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '我住在杭州' });
  return (async () => {
    const r = await j.search('我住哪', { chatId: 'g1' });
    assert.equal(r.length, 1);
  })();
});

test('日记：无关查询不误命中', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '我住在杭州' });
  return (async () => {
    assert.equal((await j.search('上海的房价', { chatId: 'g1' })).length, 0);
  })();
});

test('日记：遗忘 = 压缩不删除，原文永远留着', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '昨天吃了火锅很开心' });
  j.compress('a', '吃了火锅');
  const row = j.get('a');
  assert.equal(row.text, '昨天吃了火锅很开心', '原文不能被改写');
  assert.equal(row.digest, '吃了火锅');
  // 压过之后照样搜得到——这是"一周后还能答上来"的根据
  return (async () => {
    assert.equal((await j.search('火锅', { chatId: 'g1' })).length, 1);
  })();
});

test('日记：critical 永不到期，普通的到期', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const old = Date.now() - 30 * DAY;
  j.add({ id: 'crit', at: old, chatId: 'g1', text: '记住我叫张三' });
  j.add({ id: 'norm', at: old, chatId: 'g1', text: '今天天气一般般吧，没什么特别的' });
  const due = j.dueToCompress(Date.now()).map((r) => r.id);
  assert.ok(due.includes('norm'));
  assert.ok(!due.includes('crit'), '非常重要的永不压缩');
});

test('日记：到期天数可配', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.setKeepDays({ normal: 1 });
  const t = Date.now() - 2 * DAY;
  j.add({ id: 'n', at: t, chatId: 'g1', text: '随便聊聊今天吃了什么吧' });
  assert.ok(j.dueToCompress(Date.now()).some((r) => r.id === 'n'));
});

test('日记：critical 不许被降级（护栏）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'c', at: Date.now(), chatId: 'g1', text: '记住我生日是三月五号' });
  assert.equal(j.get('c').level, 'critical');
  assert.equal(j.setLevel('c', 'normal'), false);
  assert.equal(j.get('c').level, 'critical');
});

test('日记：显式"别记这个"是真忘（正文抹掉、检索不回来）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '我前女友叫小美' });
  const n = j.forget({ chatId: 'g1', word: '小美' });
  assert.equal(n, 1);
  assert.match(j.get('a').text, /已按用户要求遗忘/);
  return (async () => {
    assert.equal((await j.search('小美', { chatId: 'g1' })).length, 0);
  })();
});

test('日记：TopK 按"重要性×衰减+访问"排，critical 排前面', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({ id: 'n', at: t, chatId: 'g1', text: '今天天气一般般吧，没什么特别的' });
  j.add({ id: 'i', at: t, chatId: 'g1', text: '说好周末一起看电影' });
  j.add({ id: 'c', at: t, chatId: 'g1', text: '记住我生日是三月五号' });
  const top = j.top('g1', { limit: 3 }).map((r) => r.id);
  assert.equal(top[0], 'c');
});

test('日记：压过的降权（还记着，但不再抢注入预算）', () => {
  const row = { at: Date.now(), level: 'important', accessed: 0, digest: null };
  const before = scoreOf(row);
  const after = scoreOf({ ...row, digest: '压过的一句' });
  assert.ok(after < before);
});

test('日记：日期按本地时区归组', () => {
  assert.equal(dayOf(new Date(2026, 0, 2, 3, 0, 0).getTime()), '2026-01-02');
});

test('验收1：这个群说过的身份事实，换个群问得出来', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', sender: '张三', text: '我住在杭州' });
  assert.equal(j.get('a').level, 'critical', '「我住哪」这类要被判成身份事实');
  return (async () => {
    const r = await j.search('我住哪', { chatId: 'g2' });
    assert.equal(r.length, 1, '换个群也要答得上来');
  })();
});

test('验收2：A 群的内部梗，B 群不提（串场拦住）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  // 群内梗只会是普通/重要，进不了 critical 那一档
  j.add({ id: 'a', at: t, chatId: 'g1', sender: '张三', text: '鱼头今天又迟到啦哈哈哈' });
  assert.notEqual(j.get('a').level, 'critical');
  return (async () => {
    assert.equal((await j.search('鱼头', { chatId: 'g2' })).length, 0, 'B 群不该知道 A 群的梗');
    assert.equal((await j.search('鱼头', { chatId: 'g1' })).length, 1, '本群照样记得');
  })();
});

test('验收5：日记摘要能按会话取出来（/memory 的三层之一）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'day:2026-10-26:g1', at: Date.now(), chatId: 'g1', kind: 'digest', text: '这天聊了搬家的事。' });
  const d = j.digests('g1', 7);
  assert.equal(d.length, 1);
  assert.match(d[0].text, /搬家/);
});


test('日记：检索一次会记一次访问（access_count 参与排序）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '我住在杭州' });
  return (async () => {
    await j.search('杭州', { chatId: 'g1' });
    assert.equal(j.get('a').accessed, 1);
  })();
});

test('日记：SQLite 用不了时回落 JSONL，功能不变', () => {
  const dir = tmp();
  // 让 sqlite 打不开：父"目录"其实是个文件
  const blocker = join(dir, 'blocked');
  writeFileSync(blocker, 'x');
  const file = join(blocker, 'journal.sqlite');
  const j = createJournal({ file, log: () => {} });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '我住在杭州' });
  assert.equal(j.backend(), 'jsonl');
  assert.equal(j.recent('g1', 5).length, 1);
  return (async () => {
    assert.equal((await j.search('杭州', { chatId: 'g1' })).length, 1);
  })();
});

test('日记：没配向量时纯关键词，不报错', () => {
  const embed = createEmbedder({ cfgOf: () => null });
  assert.equal(embed.enabled(), false);
  const j = createJournal({ file: join(tmp(), 'j.sqlite'), embed });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '我住在杭州' });
  return (async () => {
    const r = await j.search('杭州', { chatId: 'g1' });
    assert.equal(r.length, 1);
    assert.equal(r[0].why, '关键词');
  })();
});

test('余弦：相同为 1，正交为 0', () => {
  assert.ok(Math.abs(cosine(Float32Array.from([1, 0]), Float32Array.from([2, 0])) - 1) < 1e-6);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
});

/* ---------------- 向量 ---------------- */

test('向量：没配就 enabled=false，many 返回 null 而不是抛错', () => {
  const e = createEmbedder({ cfgOf: () => ({}) });
  assert.equal(e.enabled(), false);
  return (async () => assert.equal(await e.many(['x']), null))();
});

test('向量：填了 model 和 baseUrl 才算启用', () => {
  const e = createEmbedder({ cfgOf: () => ({ model: 'bge-m3', baseUrl: 'http://x/v1/' }) });
  assert.equal(e.enabled(), true);
});

/* ---------------- 图谱 ---------------- */

test('图谱：改主意不删旧边，只给 valid_to 打时间', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const T1 = Date.parse('2026-09-01T10:00:00');
  const T2 = Date.parse('2026-10-20T10:00:00');
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', at: T1 });
  g.addEdge({ src: '主人', rel: '住在', dst: '上海', at: T2 });

  const now = g.nowEdges({});
  const live = now.filter((e) => e.rel === '住在').map((e) => e.dst);
  assert.deepEqual(live, ['上海'], '现在只成立上海');

  // 问"九月住哪"还能答杭州——这就是双时态的价值
  const sep = g.edgesAsOf(T1 + DAY).filter((e) => e.rel === '住在').map((e) => e.dst);
  assert.deepEqual(sep, ['杭州']);

  const ended = g.endedEdges({}).filter((e) => e.rel === '住在');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].dst, '杭州');
});

test('图谱：同一关系可以并存（喜欢不是功能性的）', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '主人', rel: '喜欢', dst: '龙井', at: t });
  g.addEdge({ src: '主人', rel: '喜欢', dst: '火锅', at: t });
  const live = g.nowEdges({}).filter((e) => e.rel === '喜欢').map((e) => e.dst);
  assert.equal(live.length, 2);
});

test('图谱：同一条边重复加不会插两条', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  const a = g.addEdge({ src: 'A', rel: '认识', dst: 'B', at: t });
  const b = g.addEdge({ src: 'A', rel: '认识', dst: 'B', at: t });
  assert.equal(a, b);
  assert.equal(g.nowEdges({}).length, 1);
});

test('图谱：群内的事不串到别的群', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '张三', rel: '外号', dst: '鱼头', at: t, chatId: 'g1' });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', at: t, chatId: '' });
  const g1 = g.nowEdges({ chatId: 'g1' }).map((e) => e.dst);
  const g2 = g.nowEdges({ chatId: 'g2' }).map((e) => e.dst);
  assert.ok(g1.includes('鱼头'));
  assert.ok(!g2.includes('鱼头'), 'B 群不该看见 A 群的外号');
  assert.ok(g2.includes('杭州'), '跨群的事实两边都该看见');
});

test('图谱：约定办完是关边，不是删边', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '主人', rel: '约定', dst: '看电影', at: t });
  const n = g.closeEdge({ src: '主人', rel: '约定', dst: '看电影', at: t + 1000 });
  assert.equal(n, 1);
  assert.equal(g.nowEdges({}).length, 0);
  assert.equal(g.endedEdges({}).length, 1, '办完的约定要留档');
});

test('图谱：清图保留 episode（抽错能重建）', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  const ep = g.addEpisode({ at: t, chatId: '', text: '我住在杭州' });
  g.addEdge({ src: 'A', rel: '住在', dst: '杭州', at: t, episodeId: ep });
  g.reset();
  assert.equal(g.stats().entities, 0);
  assert.equal(g.stats().episodes, 1, '原始片段必须留着');
});

test('图谱：注入文本只给还成立的关系', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const T1 = Date.parse('2026-09-01T10:00:00');
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', at: T1 });
  g.addEdge({ src: '主人', rel: '住在', dst: '上海', at: T1 + DAY });
  const txt = g.text({ chatId: '' });
  assert.match(txt, /上海/);
  assert.doesNotMatch(txt, /杭州/);
});

/* ---------------- 巩固 ---------------- */

function fakeMemory() {
  const global = [];
  const chats = {};
  return {
    global,
    chats,
    add(chatId, fact, scope = 'global') {
      const list = scope === 'chat' ? (chats[chatId] = chats[chatId] || []) : global;
      if (!list.includes(fact)) list.push(fact);
      return true;
    },
    list(chatId) {
      return { global: [...global], chat: [...(chats[chatId] || [])] };
    },
  };
}

const Y = (now) => yesterdayOf(now);

test('巩固：模型的建议落到库里（摘要/压缩/三元组/约定）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const mem = fakeMemory();

  j.add({ id: 'a1', at: base, chatId: 'g1', sender: '张三', text: '我住在杭州' });
  j.add({ id: 'a2', at: base + 1000, chatId: 'g1', sender: '李四', text: '嗯嗯' });

  const gen = async () =>
    JSON.stringify({
      summary: '张三说住在杭州。',
      ranks: [['a2', 'normal']],
      compress: [{ id: 'a2', digest: '李四应了一声' }],
      triples: [{ s: '张三', rel: '住在', o: '杭州', scope: 'global' }],
      agreements: ['周末一起看电影'],
      closed: [],
    });

  const c = createConsolidate({ journal: j, graph: g, memory: mem, generate: gen, now: () => now });
  const r = await c.run({ day });

  assert.equal(r.ok, true);
  assert.equal(j.get('a2').digest, '李四应了一声');
  assert.equal(j.get('day:' + day + ':g1').text, '张三说住在杭州。');
  assert.equal(g.nowEdges({}).filter((e) => e.rel === '住在').length, 1);
  assert.ok(mem.global.some((f) => f.includes('周末一起看电影')));
});

test('巩固：模型给的等级不许把 critical 降下去', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'c1', at: base, chatId: 'g1', text: '记住我生日是三月五号' });
  assert.equal(j.get('c1').level, 'critical');

  const gen = async () => JSON.stringify({ summary: '她记住了生日。', ranks: [['c1', 'normal']] });
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: gen, now: () => now });
  await c.run({ day });
  assert.equal(j.get('c1').level, 'critical', '非常重要的记忆不容模型推翻');
});

test('巩固：模型输出不是 JSON 时退回机械压缩，不炸', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a1', at: base, chatId: 'g1', text: '今天聊了好久的天，说了很多乱七八糟的事情' });

  const c = createConsolidate({
    journal: j,
    graph: null,
    memory: fakeMemory(),
    generate: async () => '我觉得今天挺好的呀',
    now: () => now,
  });
  const r = await c.run({ day });
  assert.equal(r.ok, true);
  assert.ok(r.errors.length > 0);
  assert.ok(j.get('day:' + day + ':g1'), '摘要还是要落一条，不然注入那边永远深度');
});

test('巩固：没有模型时也能跑（只做机械压缩）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a1', at: base, chatId: 'g1', text: '一件很普通的小事' });
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: null, now: () => now });
  const r = await c.run({ day });
  assert.equal(r.mode, 'mechanical');
  assert.equal(r.ok, true);
});

test('巩固：跑完之后当天就"不用再跑"（幂等）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a1', at: base, chatId: 'g1', text: '我住在杭州' });
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: null, now: () => now });

  assert.equal(c.dueDay({ hour: 0, at: now }), day);
  await c.run({ day });
  assert.equal(c.dueDay({ hour: 0, at: now }), '');
});

test('巩固：还没到点不跑', () => {
  const now = Date.parse('2026-10-27T02:00:00');
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.parse('2026-10-26T10:00:00'), chatId: 'g1', text: '聊了点东西' });
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: null, now: () => now });
  assert.equal(c.dueDay({ hour: 4, at: now }), '', '四点前不跑');
});

test('巩固：这天没有日记就什么都不做', async () => {
  const now = Date.now();
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: null, now: () => now });
  const r = await c.run({ day: '2000-01-01' });
  assert.equal(r.ok, false);
});

test('巩固：dry 模式只算不写', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a1', at: base, chatId: 'g1', text: '我住在杭州' });
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: null, now: () => now });
  await c.run({ day, dry: true });
  assert.equal(j.get('day:' + day + ':g1'), null);
});

test('巩固：宽松解析能吃下代码块围栏和前后废话', () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('好的，结果如下：{"a":2} 完毕'), { a: 2 });
  assert.equal(parseJsonLoose('没有 json'), null);
});

test('巩固：机械压缩是截断不是丢弃', () => {
  const d = mechanicalDigest('一二三四五六七八九十一二三四五六七八九十', 10);
  assert.equal(d.length, 10);
  assert.ok(d.startsWith('一二三'));
});

test('巩固：喂模型的条目按"等级高+时间新"挑，且不超字数', () => {
  const t = Date.now();
  const rows = [
    { id: '1', at: t, level: 'normal', text: 'a'.repeat(50), sender: 'x', role: 'user' },
    { id: '2', at: t + 1, level: 'critical', text: 'b'.repeat(50), sender: 'x', role: 'user' },
  ];
  // 预算只够一行时，先保重要的那条
  const items = pickRows(rows, { maxChars: 100 });
  assert.equal(items.length, 1);
  assert.equal(items[0].row.id, '2', '字不够时先保重要的');
  // 预算够就都进来，且按时间正序（读起来像一天）
  const both = pickRows(rows, { maxChars: 1000 });
  assert.deepEqual(both.map((i) => i.row.id), ['1', '2']);
});

test('巩固：提示词里必须写"保留具体名词"（指代不能压掉）', () => {
  const p = buildPrompt({ day: '2026-10-26', chatName: 'g1', items: [] });
  assert.match(p, /保留具体名词/);
  assert.match(p, /scope/);
  assert.match(p, /summary/);
});
