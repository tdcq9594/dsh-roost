// 第 4 期（记忆）的测试：分词 / 日记 / 图谱 / 巩固。
//
// 这几块最容易"看起来跑通了其实没生效"——压了但原文没了、改了但旧边删了、
// 忘了但第二天又想起来。所以这里的断言基本都在盯**副作用**，不盯返回值。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { createJournal, classify, dayOf, scoreOf, cosine, DEFAULT_KEEP_DAYS, ERASED } from '../src/journal.js';
import { createGraph } from '../src/graph.js';
import { createMemory, scoreOfFact, W_EXPLICIT, normalizeSrc } from '../src/memory.js';
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

test('日记：摘要里提到的人也要忘（原文和 digest 一起抹）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '我前女友叫小美' });
  j.add({
    id: 'day:2026-10-28:g1',
    at: t,
    chatId: 'g1',
    kind: 'digest',
    level: 'important',
    text: '他说前女友小美要结婚了。',
  });

  /**
   * 以前 `forget` 只放行 kind='chat'，于是原文抹了、当天的摘要还在。
   * 「原文忘了、结论还记得」比不删更让人不安，所以这两条必须一起走。
   */
  const n = j.forget({ chatId: 'g1', word: '小美' });
  assert.equal(n, 2, '原文和摘要都要抹');
  assert.match(j.get('day:2026-10-28:g1').text, /已按用户要求遗忘/);
  assert.equal(j.digests('g1', 5).length, 0, '抹掉的摘要不该再进【这几天】');
});

test('日记：抹掉的条目不再喂给巩固（byDay 跳过占位符）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = new Date(2026, 9, 20, 10, 0, 0).getTime();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '我前女友叫小美' });
  j.add({ id: 'b', at: t + 60_000, chatId: 'g1', text: '今天天气不错' });

  /**
   * 巩固按天取料（`byDay`）。占位符要是被当成原话喂进去，
   * 模型会抽出「主人—说过→ 已按用户要求遗忘」这种三元组——
   * 用户上午要求忘掉的事，凌晨被巩固重新「记住」。
   */
  j.forget({ chatId: 'g1', word: '小美' });
  const rows = j.byDay(dayOf(t));
  assert.equal(rows.length, 1, '被抹掉的那条不该出现在这一天里');
  assert.equal(rows[0].id, 'b');
});

test('日记：忘掉关键词不受旧窗口限制（超过 2000 条也要扫到）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const base = new Date(2026, 9, 1, 10, 0, 0).getTime();

  /**
   * 以前 `forget` 只扫最近 2000 条。先写一条最早的，再堆 2100 条把它
   * 挤出窗口——那条就会「搜不到也删不掉」，而用户以为已经忘了。
   */
  j.add({ id: 'old', at: base, chatId: 'g1', text: '我前女友叫小美' });
  for (let i = 0; i < 2100; i += 1) {
    j.add({ id: `n${i}`, at: base + 1000 * (i + 1), chatId: 'g1', text: `第 ${i} 句闲聊` });
  }

  const n = j.forget({ chatId: 'g1', word: '小美' });
  assert.equal(n, 1, '超过 2000 条也要能忘掉最早那条');
  assert.match(j.get('old').text, /已按用户要求遗忘/);
});

test('日记：清空留行、彻底删不留行（两档语义）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  /** 没删过行时压库是空转（巩固的定时器每十分钟调一次，不能白锁库） */
  assert.equal(j.vacuum(), false, '没删过行就不该跑');

  const t = new Date(2026, 9, 21, 10, 0, 0).getTime();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '第一句' });
  j.add({ id: 'b', at: t + 1000, chatId: 'g1', text: '第二句' });
  j.add({ id: 'c', at: t + 2000, chatId: 'g2', text: '别的群' });

  /** 软抹：行还在（时间线连续），正文变占位符 */
  assert.equal(j.clearChat('g1'), 2);
  assert.equal(j.get('a').text, '（已清空）');
  assert.ok(j.get('b'), '软抹不删行');

  /** 彻底删：行没了，软抹过的也一起删；别的群不受影响 */
  j.add({ id: 'd', at: t + 3000, chatId: 'g1', text: '第三句' });
  assert.equal(j.purgeChat('g1'), 3);
  assert.equal(j.get('a'), null);
  assert.equal(j.get('d'), null);
  assert.ok(j.get('c'), '别的群不受影响');

  /** 删过之后压一次库，标记随即清掉 */
  j.vacuum();
  assert.equal(j.vacuum(), false, '压过一次标记要清掉，不能每次巩固都锁库');
});

test('日记：按 id 删只掉点的那一条（不再拿正文当关键词）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = new Date(2026, 9, 22, 10, 0, 0).getTime();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '小美的生日是三月五号' });
  j.add({ id: 'b', at: t + 1000, chatId: 'g1', text: '小美的生日是三月六号（记错了）' });

  /**
   * 以前面板点「忘」是拿 `text.slice(0, 12)` 当关键词交给 `forget`，
   * 而命中判据 `passesCoverage` 的覆盖率门槛只有 0.34——
   * 这两条只差一个字，会被一起抹掉。用户点的是**这一条**。
   */
  assert.equal(j.remove('a'), true);
  assert.equal(j.get('a'), null, '点的那条要真没了');
  assert.equal(j.get('b').text, '小美的生日是三月六号（记错了）', '措辞相近的别的条不许被带走');
  assert.equal(j.remove('nope'), false, 'id 不存在就是没删掉，不能返回 true');
  return (async () => {
    assert.equal((await j.search('生日', { chatId: 'g1' })).length, 1, 'FTS 索引也要跟着删');
  })();
});

test('日记：chatId 为空一律拒绝（空串在库里等于"不过滤"）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '群一的事' });
  j.add({ id: 'b', at: t + 1, chatId: 'g2', text: '群二的事' });

  /**
   * `clearChat('')` / `forget({chatId:''})` 在查询层是「不过滤」，
   * 而调用方的 chatId 来自 `body.chatId || lastScene.chatId || ''`，
   * 面板刚打开、还没收过消息时正好是空串——
   * 于是「清空这个群」变成清空所有群，接口还回一句「这个群的记忆清了」。
   */
  assert.throws(() => j.clearChat(''), /缺 chatId/);
  assert.throws(() => j.forget({ chatId: '', word: '事' }), /缺 chatId/);
  assert.throws(() => j.purgeChat('  '), /缺 chatId/);
  assert.equal(j.stats().total, 2, '一条都不许被抹');
  assert.equal(j.get('a').text, '群一的事');
  assert.equal(j.get('b').text, '群二的事');
});

test('日记：拒绝空 chatId 之后，正常会话的批量抹除照旧', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({ id: 'a', at: t, chatId: 'g1', text: '我前女友叫小美' });
  j.add({ id: 'b', at: t + 1, chatId: 'g2', text: '别的群也提到小美' });
  assert.equal(j.forget({ chatId: 'g1', word: '小美' }), 1);
  assert.match(j.get('a').text, /已按用户要求遗忘/);
  assert.equal(j.get('b').text, '别的群也提到小美', '别的群不受影响');
});

test('日记：抹掉的条目连原文快照和向量一起清（否则等于没忘）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({
    id: 'a', at: t, chatId: 'g1', text: '我前女友叫小美',
    evidence: [{ eventId: 'ev-1', at: t, sender: 'x', excerpt: '我前女友叫小美' }],
  });
  j.setVec('a', [1, 0, 0]);
  assert.ok(j.get('a').vec, '前提：写进去了');

  j.forget({ chatId: 'g1', word: '小美' });
  const r = j.get('a');

  /**
   * 只抹 `text` 是不够的：`evidence` 里存着原文快照、`vec` 是原文算出来的
   * 向量，语义检索照样能命中——用户问一句不相干的话，她都能"想起"这条。
   */
  assert.equal(r.text, ERASED);
  assert.equal(r.vec, null, '向量必须清，否则语义检索还能把它捞出来');
  assert.deepEqual(r.evidence, [], '原文快照必须清，否则原文还在库里');

  /** 清空后的占位符不该被巩固重新算一遍向量 */
  assert.equal(j.noVec(20).some((x) => x.id === 'a'), false, '占位符别补算向量');
});

test('日记：占位符不进"到期压缩"，也不进索引', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.setKeepDays({ normal: 1 });
  const t = Date.now() - 3 * DAY;
  j.add({ id: 'a', at: t, chatId: 'g1', text: '随便聊聊今天那件事' });

  j.forget({ chatId: 'g1', word: '随便聊聊' });
  /**
   * 抹过之后 `level` 降成 normal、`keepUntil` 还是原来那个（已过期），
   * 不过滤的话会被挑去"压缩"——给一句「（已按用户要求遗忘）」生成摘要。
   */
  assert.equal(j.dueToCompress(Date.now()).length, 0, '占位符不压');

  return (async () => {
    /** 索引只删不回填：否则搜「遗忘」能搜出一堆占位符 */
    assert.equal((await j.search('遗忘', { chatId: 'g1' })).length, 0);
  })();
});

test('日记：图谱里指向已删日记的死 id，不能让这一轮检索整段失效', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '张三换了工作，去了新公司' });

  /**
   * 「彻底删除」删了 journal 行，但 graph 的 `episode.journal_id` 可能还指着它。
   * 以前实体路先加分后查行，`byId` 里没有这个 id，拼结果时读 `r.text`
   * 直接抛 TypeError，被 host 的 catch 吞掉 —— 这一轮日记检索整段变空，
   * 用户只看到"她突然想不起以前的事"。
   */
  return (async () => {
    const hits = await j.search('工作', { chatId: 'g1', entityJournalIds: ['已被彻底删除的id'] });
    assert.ok(hits.length >= 1, '关键词那一路要照常出结果');
  })();
});

test('日记：待压库的标记跨重启有效（十分钟内重启也要压）', () => {
  const file = join(tmp(), 'j.sqlite');
  const j = createJournal({ file });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '一句话' });
  j.purgeChat('g1');
  /**
   * 标记原来只是闭包变量。DSH 更新/手动重载比"十分钟后"更常见，
   * 一重启就丢，VACUUM 永不执行，库里那些页一直留着原文。
   */
  j.close();

  const j2 = createJournal({ file });
  assert.equal(j2.vacuum(), true, '重启后仍要压一次库');
  assert.equal(j2.vacuum(), false, '压完标记要清掉，不能每轮都锁库');
  j2.close();
});

test('图谱：按会话彻底清理会清掉原文片段、边和实体，但保留墓碑', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  const ep = g.addEpisode({ at: t, chatId: 'g1', text: '小美说她住在杭州', journalId: 'j1' });
  g.addEdge({ src: '小美', rel: '住在', dst: '杭州', chatId: 'g1', episodeId: ep, at: t });
  g.addEdge({ src: '主人', rel: '住在', dst: '上海', chatId: '', at: t });
  g.suppressEdge({ src: '小美', rel: '住在', dst: '北京', chatId: 'g1', why: '用户删过', at: t });

  const r = g.purgeChat('g1');
  assert.equal(r.episodes, 1, '原文片段要清');
  assert.equal(r.edges, 1, '这个群的关系要清');
  assert.equal(g.episodes({ chatId: 'g1' }).length, 0, '原文片段要清干净');
  /** `nowEdges(chatId)` 本来就会带上跨群那层，所以这里只剩那条全局边 */
  const left = g.nowEdges({ chatId: 'g1' });
  assert.equal(left.length, 1, '这个群自己的关系要清掉');
  assert.equal(left[0].dst, '上海', '跨群的别动');
  /**
   * 墓碑必须留着：它是"这条关系别再记"的指令，
   * 删了之后巩固会把用户明确删掉的关系重新抽回来。
   */
  assert.equal(g.suppressed({ chatId: 'g1' }).length, 1, '墓碑不许删');
  g.close();
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

test('日记：访问加分随时间淡出（不会一次搜到就永久加分）', () => {
  const now = Date.now();
  const base = { at: now - 100 * DAY, level: 'important', accessed: 20, digest: null };
  const justNow = scoreOf({ ...base, lastAccess: now - DAY }, now);
  const longAgo = scoreOf({ ...base, lastAccess: now - 200 * DAY }, now);
  assert.ok(justNow > longAgo, `最近搜过的该更高：${justNow} vs ${longAgo}`);
});

test('日记：刚搜过的确实加分（别把 access 项一起删了）', () => {
  const now = Date.now();
  const base = { at: now - 100 * DAY, level: 'important', digest: null };
  const hit = scoreOf({ ...base, accessed: 5, lastAccess: now - DAY }, now);
  const never = scoreOf({ ...base, accessed: 0, lastAccess: 0 }, now);
  assert.ok(hit > never);
});

test('日记：一年前搜过 20 次的老事，不该压过今天的新事', () => {
  const now = Date.now();
  const oldButHot = scoreOf(
    { at: now - 400 * DAY, level: 'important', accessed: 20, lastAccess: now - 365 * DAY },
    now,
  );
  const fresh = scoreOf({ at: now, level: 'important', accessed: 0, lastAccess: 0 }, now);
  assert.ok(oldButHot < fresh, `古代条目靠历史访问反超 = 永久霸榜：${oldButHot} vs ${fresh}`);
});

test('日记：注入不算"被想起"（否则注入得越勤越霸榜）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'c', at: Date.now(), chatId: 'g1', text: '记住我生日是三月五号' });
  for (let i = 0; i < 20; i += 1) j.top('g1', { limit: 6 });
  assert.equal(j.get('c').accessed, 0, 'top() 只是把东西摆到眼前，不是她想起来了');
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
  /**
   * 约定归**这个会话**，不进全局。
   *
   * 以前写死 `scope='global'`，于是群里的约定会出现在每一个会话里——
   * 包括私聊主动搭话的提示词。线上表现是她在私聊里对着「替某人喊话给
   * 某个群」这种只有群里才有意义的事做决策，最后往往选择不说。
   */
  assert.ok(
    (mem.chats.g1 || []).some((f) => f.includes('周末一起看电影')),
    '约定要落在本会话',
  );
  assert.ok(
    !mem.global.some((f) => f.includes('周末一起看电影')),
    '约定不该进全局——进了就会串到别的群和私聊',
  );
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

test('巩固：压缩提示词必须逐条点名要保留的类别', () => {
  const p = buildPrompt({ day: '2026-10-26', chatName: 'g1', items: [] });
  /**
   * 为什么要逐条断言：只说"保留重要信息"时，模型会把
   * 「答应下周三前给答复」这种带时间的承诺压掉——它在模型看来不够"重要"。
   * 所以类别必须是显式清单，少一类就漏一类。
   */
  for (const cat of ['人名', '地名', '物品名', '数字', '日期', '待办', '承诺', '否定', '金额']) {
    assert.ok(p.includes(cat), `提示词里缺类别：${cat}`);
  }
  assert.match(p, /scope/);
  assert.match(p, /summary/);
});

/* ---------------- 第三路检索 / 改主意（优化批次 2） ---------------- */

test('检索第三路：实体能把没有字面命中的日记拉进来', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  // 这句里没有"张三"两个字，关键词路搜不到
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '他最近换工作了，忙得很' });
  return (async () => {
    const without = await j.search('张三', { chatId: 'g1' });
    assert.equal(without.length, 0, '没有实体路时确实搜不到');
    const withEnt = await j.search('张三', { chatId: 'g1', entityJournalIds: ['a'] });
    assert.equal(withEnt.length, 1, '实体路要能把它拉进来');
    assert.equal(withEnt[0].id, 'a');
  })();
});

test('检索第三路：实体权重低于关键词（不会盖过字面命中）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const t = Date.now();
  j.add({ id: 'kw', at: t, chatId: 'g1', text: '张三说他下周搬家' });   // 字面命中
  j.add({ id: 'ent', at: t, chatId: 'g1', text: '他最近换工作了' });     // 只有实体命中
  return (async () => {
    const r = await j.search('张三', { chatId: 'g1', entityJournalIds: ['ent'] });
    assert.equal(r[0].id, 'kw', '字面命中要排在实体命中前面');
  })();
});

test('图谱：linkedJournalIds 能顺着 episode.journal_id 反查', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  const ep = g.addEpisode({ at: t, chatId: '', text: '张三换了工作', journalId: 'j-1' });
  g.addEdge({ src: '张三', rel: '工作于', dst: '某公司', at: t, chatId: '', episodeId: ep });
  assert.deepEqual(g.linkedJournalIds('张三'), ['j-1']);
  assert.deepEqual(g.linkedJournalIds('李四'), []);
});

test('图谱：hasActive 只在有活边时返回 true', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  assert.equal(g.hasActive('主人', '住在'), false);
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', at: t });
  assert.equal(g.hasActive('主人', '住在'), true);
  g.closeEdge({ src: '主人', rel: '住在', at: t + 1 });
  assert.equal(g.hasActive('主人', '住在'), false, '关掉之后就不算活边');
});

test('改主意：op=update 作废旧值（不靠关系名里有没有"住"字）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });

  // 先有一条旧事实
  g.addEdge({ src: '主人', rel: '定居', dst: '杭州', at: base - 30 * DAY });

  j.add({ id: 'a1', at: base, chatId: 'g1', text: '我搬到上海了' });
  // 「定居」不含"住/在"，旧的正则 FUNCTIONAL 判不出来——这正是要修的漏判
  const gen = async () =>
    JSON.stringify({
      summary: '搬到上海。',
      triples: [{ s: '主人', rel: '定居', o: '上海', scope: 'global', op: 'update' }],
    });
  const c = createConsolidate({ journal: j, graph: g, memory: fakeMemory(), generate: gen, now: () => now });
  await c.run({ day });

  const live = g.nowEdges({ chatId: '' }).filter((e) => e.rel === '定居').map((e) => e.dst);
  assert.deepEqual(live, ['上海'], '旧值必须被作废，不能两条并存');
  assert.equal(g.endedEdges({ chatId: '' }).filter((e) => e.rel === '定居').length, 1, '旧边保留可回溯');
});

test('改主意：op=add 不许动旧值（护栏，防止模型滥用作废）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.addEdge({ src: '主人', rel: '喜欢', dst: '龙井', at: base });

  j.add({ id: 'a1', at: base, chatId: 'g1', text: '我也喜欢火锅' });
  const gen = async () =>
    JSON.stringify({ summary: '喜欢火锅。', triples: [{ s: '主人', rel: '喜欢', o: '火锅', scope: 'global', op: 'add' }] });
  const c = createConsolidate({ journal: j, graph: g, memory: fakeMemory(), generate: gen, now: () => now });
  await c.run({ day });

  const live = g.nowEdges({ chatId: '' }).filter((e) => e.rel === '喜欢').map((e) => e.dst).sort();
  assert.deepEqual(live, ['火锅', '龙井'], 'add 不该关掉任何旧值');
});

test('改主意：没有活边时 op=update 退化成 add（不能因为多写一个 update 就丢数据）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  j.add({ id: 'a1', at: base, chatId: 'g1', text: '我养了只猫' });
  const gen = async () =>
    JSON.stringify({ summary: '养猫。', triples: [{ s: '主人', rel: '养了', o: '猫', scope: 'global', op: 'update' }] });
  const c = createConsolidate({ journal: j, graph: g, memory: fakeMemory(), generate: gen, now: () => now });
  await c.run({ day });
  assert.equal(g.nowEdges({ chatId: '' }).filter((e) => e.rel === '养了').length, 1, '退化为 add，事实要留下');
});

/**
 * 场景片段（阶段 4）：记忆要记得「自己是从哪几条消息来的」。
 *
 * 两个字段各管一件事：
 *   `eventIds` 用来**回查原文**（事件账本在框架侧，只能靠 id 去问）
 *   `evidence` 是**原文快照**（events 7 天后滚动删了，它还留着）
 */
test('日记: 记下这条记忆来自哪几条消息', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({
    id: 'm-src',
    at: Date.now(),
    chatId: 'g1',
    text: '他说明天去杭州',
    eventIds: ['ev-1', 'ev-2'],
    evidence: [{ eventId: 'ev-2', at: Date.now(), sender: '小明', excerpt: '明天去杭州' }],
  });
  const row = j.get('m-src');
  assert.deepEqual(row.eventIds, ['ev-1', 'ev-2']);
  assert.equal(row.evidence.length, 1);
  assert.equal(row.evidence[0].sender, '小明');
});

test('日记: 没有出处时是空数组，不是 undefined', () => {
  // 上层会直接 `row.eventIds?.[0]`，返回 undefined 和返回 [] 都能用；
  // 但 `[]` 让「没开账本」和「字段丢了」表现一致，省得到处判空
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({ id: 'm-plain', at: Date.now(), chatId: 'g1', text: '随口一句' });
  const row = j.get('m-plain');
  assert.deepEqual(row.eventIds, []);
  assert.deepEqual(row.evidence, []);
});

test('日记: 出处数组有上限，别把一条记忆撑爆', () => {
  // 合并窗口理论上能攒很多条；一条记忆带 500 个 eventId 没有意义，
  // 而且会让 SQLite 那列变得又长又没用
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  j.add({
    id: 'm-many',
    at: Date.now(),
    chatId: 'g1',
    text: '一长串',
    eventIds: Array.from({ length: 200 }, (_, i) => `ev-${i}`),
  });
  assert.equal(j.get('m-many').eventIds.length, 50);
});

test('日记: 老库没有新列也能开（ALTER TABLE 迁移）', () => {
  // 模拟阶段 4 之前的库：建表时不带 event_ids/evidence，然后让 createJournal 打开它。
  // 不迁移的话 insert 会报「no such column」，而新装的人是好的——
  // 这种只影响升级用户的错最难查
  const file = join(tmp(), 'old.sqlite');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE journal (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL,
    chat_id TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user', text TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'normal', kind TEXT NOT NULL DEFAULT 'chat',
    digest TEXT, keep_until INTEGER NOT NULL DEFAULT 0,
    accessed INTEGER NOT NULL DEFAULT 0, last_access INTEGER NOT NULL DEFAULT 0, vec BLOB
  )`);
  d.exec(`INSERT INTO journal(id,at,day,chat_id,text) VALUES ('old-1', ${Date.now()}, 'd', 'g1', '老数据')`);
  d.close();

  const j = createJournal({ file });
  const old = j.get('old-1');
  assert.equal(old.text, '老数据', '老数据要读得出来');
  assert.deepEqual(old.eventIds, [], '新列对老行是空');
  // 迁移之后能写新数据
  j.add({ id: 'new-1', at: Date.now(), chatId: 'g1', text: '新数据', eventIds: ['ev-9'] });
  assert.deepEqual(j.get('new-1').eventIds, ['ev-9']);
});

/* ---------------- facts（memory.js） ----------------
 *
 * 这块以前一条测试都没有，而它是**每轮都注入**、模型能写、面板能删的一层。
 * 它的错法全是静默的：记了没生效、删了没删掉、本群的事串到别的群。
 */

/** 每个用例一个干净的 data 目录（dataDir() 每次读 env，所以换 env 就够） */
function freshFacts() {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-facts-'));
  return createMemory();
}

/** 直接看盘上的文件 —— 有些事（孤儿元数据）只有看文件才验得出来 */
const readRaw = () => JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'memory.json'), 'utf8'));

test('facts：默认记到跨群层（用户说"记住"多半是关于他自己）', () => {
  const m = freshFacts();
  m.add('g1', '主人住在杭州');
  assert.deepEqual(m.list('g1').global, ['主人住在杭州']);
  assert.deepEqual(m.list('g1').chat, [], '不该顺手写进本群层');
});

test('facts：本群层不串场（别的群看不到）', () => {
  const m = freshFacts();
  m.add('g1', '这个群管阿离叫小离', 'chat');
  assert.deepEqual(m.list('g1').chat, ['这个群管阿离叫小离']);
  assert.deepEqual(m.list('g2').chat, [], '换个群就该看不见');
  assert.deepEqual(m.list('g2').global, [], '也不该跑到跨群层');
});

test('facts：本群层没 chatId 就记不上（别写进 undefined 这个群）', () => {
  const m = freshFacts();
  assert.equal(m.add('', '孤儿事实', 'chat'), false);
  assert.deepEqual(m.list('').chat, []);
});

test('facts：同一条重复记只留一条', () => {
  const m = freshFacts();
  m.add('g1', '主人住在杭州');
  m.add('g1', '主人住在杭州');
  assert.equal(m.list('g1').global.length, 1);
});

test('facts：空白不记，超长截到 200 字', () => {
  const m = freshFacts();
  m.add('g1', '   ');
  assert.equal(m.list('g1').global.length, 0);
  m.add('g1', '啊'.repeat(500));
  assert.equal(m.list('g1').global[0].length, 200);
});

test('facts：一层最多 40 条，超了淘汰最旧的', () => {
  const m = freshFacts();
  for (let i = 1; i <= 45; i++) m.add('g1', `事实${i}`);
  const g = m.list('g1').global;
  assert.equal(g.length, 40);
  assert.equal(g[0], '事实6', '最旧的 5 条被挤掉');
  assert.equal(g[39], '事实45');
});

test('facts：list 给的是副本，外面改它不该改到库', () => {
  // 注入路径会把 list 的结果拼进提示词，中间任何一处 push 都不该污染库
  const m = freshFacts();
  m.add('g1', '一条');
  const r = m.list('g1');
  r.global.push('偷偷加的');
  r.chat.push('也加一条');
  assert.deepEqual(m.list('g1').global, ['一条']);
  assert.deepEqual(m.list('g1').chat, []);
});

test('facts：按关键词删，两层都搜，不相干的不动', () => {
  const m = freshFacts();
  m.add('g1', '主人住在杭州');
  m.add('g1', '主人喜欢猫');
  m.add('g1', '这个群在杭州聚会', 'chat');
  assert.equal(m.remove('g1', '杭州'), 2);
  assert.deepEqual(m.list('g1').global, ['主人喜欢猫']);
  assert.deepEqual(m.list('g1').chat, []);
});

test('facts：空关键词不误伤（不然一次误调用就清空全部）', () => {
  const m = freshFacts();
  m.add('g1', '一条');
  assert.equal(m.remove('g1', ''), 0);
  assert.equal(m.remove('g1', null), 0);
  assert.equal(m.list('g1').global.length, 1);
});

test('facts：清本群不动跨群，清跨群不动本群', () => {
  const m = freshFacts();
  m.add('g1', '跨群的');
  m.add('g1', '本群的', 'chat');
  m.add('g2', '另一个群的', 'chat');

  m.clearChat('g1');
  assert.deepEqual(m.list('g1').chat, []);
  assert.deepEqual(m.list('g1').global, ['跨群的'], '清本群不该动跨群层');
  assert.deepEqual(m.list('g2').chat, ['另一个群的'], '更不该动别的群');

  m.clearGlobal();
  assert.deepEqual(m.list('g1').global, []);
  assert.deepEqual(m.list('g2').chat, ['另一个群的']);
});

test('facts：存盘后重开还在（不是只活在内存里）', () => {
  const m = freshFacts();
  m.add('g1', '主人住在杭州');
  m.add('g1', '本群的梗', 'chat');
  const again = createMemory(); // 同一个 DSH_ROOST_DATA，模拟重启
  assert.deepEqual(again.list('g1').global, ['主人住在杭州']);
  assert.deepEqual(again.list('g1').chat, ['本群的梗']);
});

test('facts：文件坏了不该把插件带崩（读不出就当空的）', () => {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-facts-'));
  writeFileSync(join(process.env.DSH_ROOST_DATA, 'memory.json'), '{ 这不是 JSON', 'utf8');
  const m = createMemory();
  assert.deepEqual(m.list('g1').global, []);
  m.add('g1', '还能写');
  assert.deepEqual(createMemory().list('g1').global, ['还能写'], '坏文件要被覆盖成好的');
});

test('facts：按群的人设覆盖，设/读/清三件套', () => {
  const m = freshFacts();
  assert.equal(m.getPersonaOverride('g1'), '', '没设过就是空串（回落到 personas/*.md）');
  m.setPersonaOverride('g1', '这个群里她话少一点');
  assert.equal(m.getPersonaOverride('g1'), '这个群里她话少一点');
  assert.equal(m.getPersonaOverride('g2'), '', '别的群不受影响');
  m.setPersonaOverride('g1', '   ');
  assert.equal(m.getPersonaOverride('g1'), '', '传空就是清掉');
});

test('facts：人设覆盖截到 500 字', () => {
  const m = freshFacts();
  m.setPersonaOverride('g1', '啊'.repeat(900));
  assert.equal(m.getPersonaOverride('g1').length, 500);
});

test('facts：授权记录能写能查（群主动的硬前置）', () => {
  const m = freshFacts();
  assert.equal(m.hasAuthz('g1', 'group_push'), false, '没给过就是没有');
  assert.equal(m.authz('g1'), null);

  m.setAuthz('g1', 'group_push', { type: 'group' });
  assert.equal(m.hasAuthz('g1'), true, '不带 scope 时只问"有没有授权"');
  assert.equal(m.hasAuthz('g1', 'group_push'), true);
  assert.equal(m.hasAuthz('g1', 'c2c_push'), false, 'scope 不对就是没有');
  assert.equal(m.authz('g1').scope, 'group_push');
  assert.equal(m.authz('g1').type, 'group', '面板要能看见是什么类型的授权');
});

test('facts：授权记录重启后还在（不然群主动永远"没授权"）', () => {
  // load() 以前只重建 global/chats/personas 三个字段，authz 不在里面：
  // 重启后读不到授权，而下一次 save() 会把盘上整段 authz 抹掉 ——
  // 表现是「重启一次群主动就永久失效」，且面板上看不出任何异常
  const m = freshFacts();
  m.setAuthz('g1', 'group_push');
  assert.equal(createMemory().hasAuthz('g1', 'group_push'), true, '重启后授权不能丢');
  createMemory().add('g1', '随便记一条'); // 任意一次保存
  assert.equal(createMemory().hasAuthz('g1', 'group_push'), true, '保存不该把 authz 抹掉');
});

test('facts：从旧版导入是幂等的（重复导入不翻倍）', () => {
  const m = freshFacts();
  const payload = { global: ['跨群的 A', '跨群的 B'], chats: { g1: ['本群的 C'] } };
  assert.equal(m.import(payload), 3);
  assert.equal(m.import(payload), 0, '第二次一条都不该新增');
  assert.equal(m.list('g1').global.length, 2);
  assert.equal(m.list('g1').chat.length, 1);
});

/* ---------------- 权重与淘汰（M3） ----------------
 *
 * 以前是纯 FIFO：第 41 条进来，第 1 条无条件走。
 * 于是「主人对花生过敏」会因为今天记了 40 条杂事而消失。
 */

test('facts：分数 = 权重 × 时间衰减（30 天减半）', () => {
  const t0 = Date.parse('2026-01-01T00:00:00');
  assert.equal(scoreOfFact(null, t0), 1, '没元数据就按 1 算');
  assert.equal(scoreOfFact({ w: 2, at: t0 }, t0), 2);
  assert.equal(scoreOfFact({ w: 2, at: t0 }, t0 + 30 * DAY), 1, '30 天减半');
  assert.equal(scoreOfFact({ w: 2, at: t0 }, t0 + 60 * DAY), 0.5);
  assert.ok(scoreOfFact({ w: 2 }, t0) > scoreOfFact({ w: 1 }, t0), '权重高的分高');
});

test('facts：同一条被反复提到会加权重，但不加条目', () => {
  const m = freshFacts();
  m.add('g1', '主人对花生过敏');
  m.add('g1', '主人对花生过敏');
  m.add('g1', '主人对花生过敏');
  const full = m.listFull('g1').global;
  assert.equal(full.length, 1, '还是只有一条');
  assert.equal(full[0].w, 2, '1 + 0.5 + 0.5');
});

test('facts：权重有上限，反复提到不会无限涨', () => {
  const m = freshFacts();
  for (let i = 0; i < 30; i++) m.add('g1', '同一句话');
  assert.equal(m.listFull('g1').global[0].w, 5, '封顶 5');
});

test('facts：明确「记住」的比巩固抽出来的权重高', () => {
  const m = freshFacts();
  m.add('g1', '明确记的', 'global', { w: W_EXPLICIT });
  m.add('g1', '巩固抽的');
  const full = m.listFull('g1').global;
  assert.equal(full.find((x) => x.text === '明确记的').w, 2);
  assert.equal(full.find((x) => x.text === '巩固抽的').w, 1);
});

test('facts：老的高权重事实不会被新杂事挤掉（FIFO 会）', () => {
  // 这条是 M3 的核心断言。以前是 FIFO：第 41 条进来，最早那条无条件走，
  // 所以「对花生过敏」会因为今天记了 40 条杂事而消失。
  let t = Date.parse('2026-01-01T00:00:00');
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-facts-'));
  const m = createMemory({ now: () => t });

  m.add('g1', '主人对花生过敏', 'global', { w: W_EXPLICIT }); // 第 1 条，权重 2
  for (let i = 2; i <= 40; i++) m.add('g1', `杂事${i}`);
  assert.equal(m.list('g1').global.length, 40);

  // 30 天后：权重 2 的那条衰减到 1.0，其余衰减到 0.5
  t += 30 * DAY;
  m.add('g1', '新杂事');

  const g = m.list('g1').global;
  assert.equal(g.length, 40);
  assert.ok(g.includes('主人对花生过敏'), '高权重的那条要留住');
  assert.ok(g.includes('新杂事'), '刚记的当然也留');
  assert.ok(!g.includes('杂事2'), '被挤掉的是最旧的低权重杂事');
  assert.equal(Object.keys(readRaw().meta.global).length, 40, '被淘汰的不能留孤儿元数据');
});

test('facts：被用上会加权重，不认识的文本不算', () => {
  const m = freshFacts();
  m.add('g1', '一条');
  assert.equal(m.touch('g1', ['一条', '不存在']), 1);
  assert.equal(m.listFull('g1').global[0].w, 1.5);
  assert.equal(m.touch('', ['一条'], 'chat'), 0, '本群层里没有这条');
});

test('facts：删掉正文，元数据也要跟着删（不然文件只会越来越长）', () => {
  // 这条必须看盘上的文件才验得出来：listFull 只遍历正文，
  // 孤儿元数据在内存里完全看不见 —— 但它会一直堆在 memory.json 里
  const m = freshFacts();
  m.add('g1', '主人住在杭州');
  m.add('g1', '主人住在杭州'); // w = 1.5
  assert.equal(m.listFull('g1').global[0].w, 1.5);

  m.remove('g1', '杭州');
  assert.deepEqual(Object.keys(readRaw().meta.global), [], '删正文时元数据不能留孤儿');

  m.add('g1', '主人住在杭州');
  assert.equal(m.listFull('g1').global[0].w, 1, '再记是全新的一条，不继承旧权重');
});

test('facts：能记下出处（回查原文靠它）', () => {
  const m = freshFacts();
  m.add('g1', '主人对花生过敏', 'global', { src: { journalId: 'j1', eventIds: ['ev-1'], at: 123 } });
  const x = m.listFull('g1').global[0];
  assert.equal(x.src.journalId, 'j1');
  assert.deepEqual(x.src.eventIds, ['ev-1']);
});

test('facts：老文件没有 meta 也能读，默认 w=1、无出处', () => {
  // 升级路径：阶段 3 之前的库只有 global/chats，不该因为缺 meta 就读不出来
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-facts-'));
  writeFileSync(
    join(process.env.DSH_ROOST_DATA, 'memory.json'),
    JSON.stringify({ global: ['老事实'], chats: { g1: ['老本群'] } }),
    'utf8',
  );
  const m = createMemory();
  assert.deepEqual(m.list('g1').global, ['老事实']);
  const full = m.listFull('g1');
  assert.equal(full.global[0].w, 1);
  assert.equal(full.global[0].src, null);
  assert.equal(full.chat[0].text, '老本群');
});

/* ---------------- 出处收口（normalizeSrc） ---------------- */

test('出处：垃圾输入返回 null，不往文件里塞空壳', () => {
  // 这条盯的是「别存一个什么都为空的 {}」：那会让面板显示
  // 「来源不明」，而其实连来源都没传过 —— 两者含义不同，不能混。
  assert.equal(normalizeSrc(null), null);
  assert.equal(normalizeSrc(undefined), null);
  assert.equal(normalizeSrc('j1'), null, '字符串不是出处');
  assert.equal(normalizeSrc({}), null);
  assert.equal(normalizeSrc({ journalId: '   ', eventIds: [] }), null, '全空白等于没传');
  assert.equal(normalizeSrc({ eventIds: ['', '  '] }), null);
});

test('出处：只留白名单字段，多余的原样丢掉', () => {
  const s = normalizeSrc({
    journalId: 'j1',
    eventIds: ['ev-1'],
    at: 123,
    by: 'owner',
    manual: true,
    // 下面这些是模型/上游可能顺手塞进来的，不该跟着落盘
    token: 'secret',
    raw: { huge: 'x'.repeat(1000) },
  });
  assert.deepEqual(s, { journalId: 'j1', eventIds: ['ev-1'], at: 123, by: 'owner', manual: true });
  assert.equal('token' in s, false);
  assert.equal('raw' in s, false);
});

test('出处：超长和超量都夹住，不让一条出处把文件撑爆', () => {
  const s = normalizeSrc({
    journalId: 'j'.repeat(500),
    eventIds: Array.from({ length: 80 }, (_, i) => `ev-${i}`),
    at: 1,
    by: 'b'.repeat(100),
  });
  assert.equal(s.journalId.length, 120);
  assert.equal(s.eventIds.length, 50, 'eventIds 最多 50 个');
  assert.equal(s.by.length, 20);
});

test('出处：eventIds 去重，重复的 id 只算一个', () => {
  const s = normalizeSrc({ eventIds: ['ev-1', 'ev-1', 'ev-2'] });
  assert.deepEqual(s.eventIds, ['ev-1', 'ev-2']);
});

test('出处：manual 只认严格的 true，字符串 "true" 不算', () => {
  // 面板靠这个字段显示「你手动记的」。如果宽松匹配，
  // 上游传个 "true" 字符串就会把模型自己记的事实标成人手动记的。
  assert.equal(normalizeSrc({ manual: 'true' }), null);
  assert.equal(normalizeSrc({ manual: 1 }), null);
  assert.equal(normalizeSrc({ manual: true }).manual, true);
});

test('出处：时间戳非数字就丢掉，不存 NaN', () => {
  // NaN 落盘会变成 null，读回来是 0，面板会显示「1970 年前」——
  // 宁可不显示，也别显示一个假时间
  assert.equal(normalizeSrc({ at: 'abc', journalId: 'j1' }).at, undefined);
  assert.equal(normalizeSrc({ at: 0, journalId: 'j1' }).at, undefined, '0 当没传');
  assert.equal(normalizeSrc({ at: -5, journalId: 'j1' }).at, undefined);
  assert.equal(normalizeSrc({ at: 1700000000000 }).at, 1700000000000);
});

test('出处：add 时传垃圾 src 不会写坏库，且不覆盖已有的好出处', () => {
  // 真实场景：模型这一轮没带 eventIds（srcOf 返回 null），
  // 但这条事实上一轮已经记过并带了出处 —— 不该被这次的空值抹掉
  const m = freshFacts();
  m.add('g1', '主人住在杭州', 'global', { src: { journalId: 'j1', at: 123 } });
  m.add('g1', '主人住在杭州', 'global', { src: { token: 'x' } });
  assert.equal(m.listFull('g1').global[0].src.journalId, 'j1', '老出处要留着');
});

test('出处：手动记的会被标成 manual', () => {
  const m = freshFacts();
  m.add('g1', '主人不喜欢被叫全名', 'global', { src: { manual: true, by: 'owner' } });
  const x = m.listFull('g1').global[0];
  assert.equal(x.src.manual, true);
  assert.equal(x.src.by, 'owner');
});



/**
 * 群里的约定不能漏进私聊。
 *
 * 以前 `apply()` 写死 `scope='global'` + `chatId: ''`，于是「替某人喊话给
 * 某个群」「群主要求用 Markdown 回复」这类只有群里才有意义的事，会出现在
 * **每一个**会话的提示词里——包括私聊主动搭话。线上表现是她在私聊里对着
 * 这些事做决策，自己都觉得别扭（"喊话对象是群，但对方是主人，我在这里说也没用"），
 * 最后往往选择不说。
 */
test('巩固：群里说的约定不会漏进私聊', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const mem = fakeMemory();

  j.add({ id: 'b1', at: base, chatId: 'group1', sender: '张三', text: '帮我跟主人说一声' });
  const gen = async () => JSON.stringify({ summary: '张三让带话。', agreements: ['替张三给主人带句话'], closed: [] });
  const c = createConsolidate({ journal: j, graph: g, memory: mem, generate: gen, now: () => now });
  await c.run({ day });

  assert.equal(
    g.nowEdges({ chatId: 'group1' }).filter((e) => e.rel === '约定').length, 1,
    '这个群自己要看得见',
  );
  assert.equal(
    g.nowEdges({ chatId: 'private1' }).filter((e) => e.rel === '约定').length, 0,
    '别的会话不该看见——看见了就是串场',
  );
  assert.ok((mem.chats.group1 || []).some((f) => f.includes('替张三给主人带句话')));
  assert.ok(!mem.global.some((f) => f.includes('替张三给主人带句话')), 'facts 也不能进全局');
});

/**
 * 办完的约定要真的关得掉。
 *
 * 这里有个容易踩的坑：实体是**按会话**存的（`entity WHERE key=? AND chat_id=?`），
 * `closeEdge` 靠 `src_id` 定位。建边用 `chatId`、关边用 `''`，就会拿到另一行
 * 「主人」实体，`src_id` 对不上 → 一条都关不掉，约定永远留在"没办完"里，
 * 而且**不报错**，只是数字一直是 0。
 */
test('巩固：办完的约定能关掉（建边和关边必须同一个 chatId）', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const mem = fakeMemory();

  j.add({ id: 'd1', at: base, chatId: 'group1', text: '说好周末看电影' });
  const first = async () => JSON.stringify({ summary: '约了看电影。', agreements: ['周末一起看电影'], closed: [] });
  await createConsolidate({ journal: j, graph: g, memory: mem, generate: first, now: () => now }).run({ day });
  assert.equal(g.nowEdges({ chatId: 'group1' }).filter((e) => e.rel === '约定').length, 1);

  // 第二天：同一件事办完了
  const now2 = now + 86_400_000;
  const day2 = Y(now2);
  const base2 = Date.parse(`${day2}T10:00:00`);
  j.add({ id: 'd2', at: base2, chatId: 'group1', text: '电影看完了' });
  const second = async () => JSON.stringify({
    summary: '看完了。',
    closed: [{ s: '主人', rel: '约定', o: '周末一起看电影' }],
  });
  const r = await createConsolidate({
    journal: j, graph: g, memory: mem, generate: second, now: () => now2,
  }).run({ day: day2 });

  assert.equal(r.closed, 1, '要真的关掉一条');
  assert.equal(
    g.nowEdges({ chatId: 'group1' }).filter((e) => e.rel === '约定').length, 0,
    '关掉之后不该还在「没办完」里',
  );
});

/* ---------------- 删关系：墓碑 ---------------- */

/**
 * 删一条关系必须**留个记号**，否则第二天又被巩固抽回来。
 *
 * 这是用户报的那个问题的核心：「记忆里面她知道的关系怎么删」——
 * 光 DELETE 是删不掉的，日记原文还在，凌晨巩固一跑就回来了。
 */
test('图谱：删掉的关系不会被巩固写回来', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  assert.equal(g.nowEdges({ chatId: 'g1' }).length, 1);

  const r = g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1', why: '记错了' });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 1, '边要真的删掉');
  assert.equal(g.nowEdges({ chatId: 'g1' }).length, 0);
  assert.equal(g.isSuppressed({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' }), true);

  // 巩固再来一次：这条不许写回来
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  assert.equal(g.isSuppressed({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' }), true, '写之前该被拦住');
});

test('图谱：删掉的是同名全部边，活边和已结束的一起删', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', at: t - 1000 });
  g.closeEdge({ src: '主人', rel: '住在', dst: '杭州', at: t });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', at: t });
  assert.equal(g.nowEdges({}).length, 1);
  assert.equal(g.endedEdges({}).length, 1);

  const r = g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州' });
  assert.equal(r.removed, 2, '「以前成立」那栏里还留着一条一模一样的，等于没删掉');
  assert.equal(g.nowEdges({}).length + g.endedEdges({}).length, 0);
});

test('图谱：只删这个会话，别的会话照旧', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g2' });

  g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  assert.equal(g.isSuppressed({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' }), true);
  assert.equal(g.isSuppressed({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g2' }), false, '别的群不该受影响');
  assert.equal(g.nowEdges({ chatId: 'g2' }).length, 1);
});

test('图谱：全局屏蔽对所有会话都生效', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: '' });
  for (const c of ['g1', 'g2', '']) {
    assert.equal(g.isSuppressed({ src: '主人', rel: '住在', dst: '杭州', chatId: c }), true, `${c || '(空)'} 该被拦`);
  }
});

test('图谱：删两次不报错，也不会多出一条墓碑', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  const r = g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 0, '第二次没有边可删');
  assert.equal(g.suppressed({ chatId: 'g1' }).length, 1, '墓碑只有一条');
});

test('图谱：撤销之后能重新记', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  const list = g.suppressed({ chatId: 'g1' });
  assert.equal(list.length, 1);

  const r = g.unsuppressEdge({ id: list[0].id });
  assert.equal(r.removed, 1);
  assert.equal(g.isSuppressed({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' }), false);
});

test('图谱：删关系要 src/rel/dst 齐全，缺一个就明说', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const r = g.suppressEdge({ src: '主人', rel: '住在', dst: '' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /src \/ rel \/ dst/);
});

/**
 * 巩固必须真的去问墓碑。
 *
 * 只加 API 不问，等于墓碑是摆设——这条用例就是防止 `apply()` 里那句
 * `isSuppressed` 被谁顺手删掉。
 */
test('巩固：被屏蔽的三元组不写进图谱', async () => {
  const now = Date.now();
  const day = Y(now);
  const base = Date.parse(`${day}T10:00:00`);
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const mem = fakeMemory();

  g.suppressEdge({ src: '张三', rel: '住在', dst: '杭州', chatId: 'g1', why: '记错了' });

  j.add({ id: 'e1', at: base, chatId: 'g1', sender: '张三', text: '我住在杭州' });
  const gen = async () => JSON.stringify({
    summary: '张三说住在杭州。',
    triples: [{ s: '张三', rel: '住在', o: '杭州', scope: 'chat' }],
  });
  const r = await createConsolidate({ journal: j, graph: g, memory: mem, generate: gen, now: () => now }).run({ day });

  assert.equal(r.ok, true);
  assert.equal(r.suppressed, 1, '要记一笔「被墓碑挡了」');
  assert.equal(g.nowEdges({ chatId: 'g1' }).length, 0, '不许写回来');
});

/**
 * 删全局关系时，作用域必须用**这条边自己的** chat_id。
 *
 * 面板上点「删」时如果顺手传当前会话的 id，`suppressEdge` 里那句
 * `(?='' OR chat_id=?)` 一条都匹配不上——边还在，看起来像"点了没反应"。
 * 所以 `edgeView` 必须带 chatId，面板也必须把它传回来。
 */
test('图谱：拿会话 id 删全局边删不到（面板要传这条边自己的作用域）', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: '' });
  const e = g.nowEdges({ chatId: 'g1' })[0];
  assert.equal(e.chatId, '', '全局边的 chatId 是空串，面板据此判断作用域');

  const wrong = g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: 'g1' });
  assert.equal(wrong.removed, 0, '拿会话 id 删不到全局边');
  assert.equal(g.nowEdges({ chatId: 'g1' }).length, 1, '边还在');

  const right = g.suppressEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: e.chatId });
  assert.equal(right.removed, 1);
  assert.equal(g.nowEdges({ chatId: 'g1' }).length, 0);
});

/* ---------------- 过期压缩（去掉 5000 条窗口） ---------------- */

test('日记：超过 5000 条时，最老的到期条目也要能被挑出来', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const now = Date.now();
  /** 最早 20 条是 30 天前说的，3 天保留期早过了 */
  for (let i = 0; i < 20; i += 1) {
    j.add({ id: 'old' + i, at: now - 30 * DAY + i, chatId: 'g1', text: '老记录' + i });
  }
  /** 再堆 5180 条新的，把老的挤出"最新 5000 条"这个窗口 */
  for (let i = 0; i < 5180; i += 1) {
    j.add({ id: 'new' + i, at: now - 1000 + i, chatId: 'g1', text: '闲聊' + i });
  }

  /**
   * 旧实现是 `listChat('', 5000)` 取**最新** 5000 条再过滤，这 20 条在窗口外，
   * 到期也不会被压——「普通 3 天压成一句」对老数据直接失效。
   */
  const due = j.dueToCompress(now, 500);
  assert.equal(due.length, 20, '20 条过期条目一条都不能漏');
  assert.equal(due[0].id, 'old0', '最该压的（最早到期的）排最前');
});

test('日记：到期队列按"谁先到期"排，limit 一次只给这么多', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) {
    j.add({ id: 'd' + i, at: now - (10 - i) * DAY, chatId: 'g1', text: '过期' + i });
  }
  const one = j.dueToCompress(now, 1);
  assert.equal(one.length, 1, 'limit 要生效');
  assert.equal(one[0].id, 'd0', '越早到期越先压');
  assert.equal(j.dueCount(now), 5, '还剩多少要数得出来');
});

test('巩固：compressDue 只写 digest、不动原文，压过的下一轮不再返回', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) {
    j.add({ id: 'c' + i, at: now - 10 * DAY, chatId: 'g1', text: '这是一句要过期的话' + i });
  }
  const c = createConsolidate({ journal: j, graph: null, memory: fakeMemory(), generate: null, now: () => now });

  return (async () => {
    const r1 = await c.compressDue({ limit: 2 });
    assert.equal(r1.compressed, 2);
    assert.equal(r1.remaining, 1, '压不完要报还剩多少，下一轮接着来');

    const one = j.get('c0');
    assert.ok(one.digest, '要写 digest');
    assert.equal(one.text, '这是一句要过期的话0', '正文不许动（遗忘靠压缩，不是删除）');

    const r2 = await c.compressDue({ limit: 2 });
    assert.equal(r2.compressed, 1, '压过的不会被重复挑出来');
    assert.equal(j.dueCount(now), 0);
  })();
});

test('日记：补向量先补最老的（DESC 会让老条目永远轮不到）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const now = Date.now();
  for (let i = 0; i < 3; i += 1) j.add({ id: 'v' + i, at: now + i, chatId: 'g1', text: '向量' + i });
  j.setVec('v2', [1, 0, 0]);
  const ids = j.noVec(10).map((r) => r.id);
  assert.deepEqual(ids, ['v0', 'v1'], '老的在前面；已经有向量的不再出现');
});

test('日记：老库打开时会补上 journal_due 索引', () => {
  const file = join(tmp(), 'j.sqlite');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');

  /** 手工造一个"上一版建的"库：表在、索引不在 */
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE journal(
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL,
    chat_id TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
    text TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'normal', kind TEXT NOT NULL DEFAULT 'chat',
    digest TEXT, keep_until INTEGER NOT NULL DEFAULT 0, accessed INTEGER NOT NULL DEFAULT 0,
    last_access INTEGER NOT NULL DEFAULT 0, vec BLOB, event_ids TEXT, evidence TEXT)`);
  assert.equal(
    d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='journal_due'").get().c,
    0,
    '前提：造出来的库确实没有这个索引',
  );
  d.close();

  /** 打开一次（懒建库发生在第一次读写时）→ 索引应当被补上 */
  const j = createJournal({ file });
  j.add({ id: 'a', at: Date.now(), chatId: 'g1', text: '一句话' });
  j.close();

  const d2 = new DatabaseSync(file);
  const n = d2.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='journal_due'").get().c;
  d2.close();
  assert.equal(n, 1, '老库升级后必须有这个索引，否则按 keep_until 直查会退化成全表扫');
});
