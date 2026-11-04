// 别名合并：换机器人之后还能读到旧日记、旧关系。
//
// 背景：官方给的 openid 是**每个 AppID 一套**的，换机器人就全变。
// 号码（QQ号/群号）不变，identity.json 记着「这个号码名下有哪些 openid」。
// 读取时把这些键一起查，存量数据一个字节都不用改。
//
// 这里盯的是**读取路径**：memory / journal / graph 三个地方都要认别名。
// 少改一处不会报错，只会「AI 突然想不起以前的事」——最难发现的那种失效。
//
// 两条纪律：
//   1. 只用**公开 API**（`j.recent` / `j.search` / `g.nowEdges`…）。
//      直接戳 `j.listChat` 会 `not a function`——那些挂在内部 store 上，
//      公开层只有 `recent` / `top` / `digests` / `search` 几个口子。
//      用公开口子测才有意义：内部方法合上了、公开层没往下传，线上照样失效。
//   2. 不带别名的那条断言必须一起写。只测「带别名能读到」的话，
//      把别名忽略掉也能过——那就等于没测。
//
// 注意：JSONL 后端只在没有 node:sqlite 时才启用（Node 22.0~22.4），
// 这里的断言两种后端通用，跑的时候看 `backend()` 是哪一种。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import { createGraph } from '../src/graph.js';
import { createMemory } from '../src/memory.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-alias-'));
const OLD = 'AAAA1111BBBB2222CCCC3333DDDD4444';
const NEW = 'EEEE5555FFFF6666AAAA7777BBBB8888';

/** 一条日记。id 显式给，方便后面 setVec */
function note(j, chatId, text, extra = {}) {
  const id = extra.id || `${chatId.slice(0, 4)}-${Math.random().toString(36).slice(2, 8)}`;
  j.add({ id, chatId, text, role: 'user', kind: 'chat', at: Date.now(), ...extra });
  return id;
}

/* ---------------- journal：recent（会话边界那块） ---------------- */

test('日记 recent：不带别名只看到当前会话', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '旧机器人时期说过的话');
  note(j, NEW, '新机器人时期说的话');

  const rows = j.recent(NEW, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, '新机器人时期说的话');
  j.close();
});

test('日记 recent：带上别名能读到旧会话', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '旧机器人时期说过的话');
  note(j, NEW, '新机器人时期说的话');

  const rows = j.recent(NEW, 10, 'chat', [OLD]);
  assert.equal(rows.length, 2, `后端 ${j.backend()} 没合上: ${JSON.stringify(rows.map((r) => r.text))}`);
  assert.ok(rows.some((r) => r.text === '旧机器人时期说过的话'));
  j.close();
});

test('日记 recent：别名重复 / 空值不会翻倍', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, NEW, '只有一条');
  const rows = j.recent(NEW, 10, 'chat', [NEW, '', null, NEW]);
  assert.equal(rows.length, 1);
  j.close();
});

test('日记 recent：合并之后 limit 仍然生效（别名不能变成「全读」）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  for (let i = 0; i < 3; i++) note(j, OLD, `旧${i}`);
  for (let i = 0; i < 2; i++) note(j, NEW, `新${i}`);

  assert.equal(j.recent(NEW, 500).length, 2, '不带别名只看到新会话');
  assert.equal(j.recent(NEW, 500, 'chat', [OLD]).length, 5, `后端 ${j.backend()}`);
  assert.equal(j.recent(NEW, 2, 'chat', [OLD]).length, 2, 'limit 不能因为合并而失效');
  j.close();
});

/* ---------------- journal：top / digests（注入路径） ---------------- */

test('日记 top：别名要能把旧会话的重要记忆拉进注入', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '主人对花生过敏，很严重', { level: 'critical' });
  note(j, NEW, '今天天气不错', { level: 'normal' });

  const without = j.top(NEW, { limit: 6 });
  assert.equal(without.length, 0, '不带别名：新会话没有重要条目');

  const withAlias = j.top(NEW, { limit: 6, aliases: [OLD] });
  assert.equal(withAlias.length, 1, `后端 ${j.backend()} 的 top 没合上`);
  assert.match(withAlias[0].text, /花生/);
  j.close();
});

test('日记 digests：别名要能把旧的每日摘要拉进注入', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '那天聊了搬家的事', { kind: 'digest' });
  note(j, NEW, '今天聊了别的', { kind: 'digest' });

  assert.equal(j.digests(NEW, 5).length, 1, '不带别名');
  const merged = j.digests(NEW, 5, [OLD]);
  assert.equal(merged.length, 2, `后端 ${j.backend()} 的 digests 没合上`);
  j.close();
});

/* ---------------- journal：检索 ---------------- */

test('日记检索：带上别名能搜到旧会话里的关键词', async () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '主人对花生过敏，很严重');
  note(j, NEW, '今天天气不错');

  assert.equal((await j.search('花生过敏', { chatId: NEW, limit: 10 })).length, 0, '不带别名搜不到');
  const hits = await j.search('花生过敏', { chatId: NEW, limit: 10, aliases: [OLD] });
  assert.equal(hits.length, 1, `后端 ${j.backend()} 检索没合上`);
  assert.match(hits[0].text, /花生/);
  j.close();
});

test('日记检索：别名不影响「跨群 critical」那条口子', async () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, 'OTHERGROUP', '别人的群在聊花生过敏', { level: 'critical' });
  note(j, 'THIRDCROUP', '第三个群的普通闲聊提到花生过敏', { level: 'normal' });

  const hits = await j.search('花生过敏', { chatId: NEW, limit: 10, crossCritical: true, aliases: [OLD] });
  assert.ok(hits.some((r) => r.chatId === 'OTHERGROUP'), 'critical 仍然要跨群');
  assert.ok(!hits.some((r) => r.chatId === 'THIRDCROUP'), '普通条目仍然不能跨群');
  j.close();
});

test('日记检索：向量那一路也认别名（漏了就是语义召回整段失效）', async () => {
  /**
   * 造一个假 embedder：查询向量固定 `[1,0,0,0]`，条目也写同一个向量，
   * 于是余弦恒为 1，必然过阈值。这样就能只测「withVec 的 SQL 有没有合上别名」，
   * 不受真模型和网络影响。
   */
  const fakeEmbed = {
    enabled: () => true,
    one: async () => [1, 0, 0, 0],
    minScore: () => 0.1,
  };
  const j = createJournal({ file: join(tmp(), 'j.sqlite'), embed: fakeEmbed });
  const oldId = note(j, OLD, '旧会话里的一句话');
  const newId = note(j, NEW, '新会话里的一句话');
  j.setVec(oldId, [1, 0, 0, 0]);
  j.setVec(newId, [1, 0, 0, 0]);

  // 查询词跟正文完全不重合，关键词一路必然 0 命中，只剩向量一路
  const without = await j.search('zzz', { chatId: NEW, limit: 10 });
  assert.equal(without.length, 1, '不带别名：向量只捞到新会话那条');
  assert.equal(without[0].id, newId);

  const withAlias = await j.search('zzz', { chatId: NEW, limit: 10, aliases: [OLD] });
  assert.equal(withAlias.length, 2, `后端 ${j.backend()} 的向量路没合上别名`);
  assert.ok(withAlias.some((r) => r.id === oldId), '旧会话那条必须被向量路捞回来');
  j.close();
});

/* ---------------- graph ---------------- */

test('图谱：别名能读到旧会话的边，跨群那层不受影响', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '小美', rel: '住在', dst: '杭州', chatId: OLD, at: t });
  g.addEdge({ src: '主人', rel: '住在', dst: '上海', chatId: '', at: t });

  const without = g.nowEdges({ chatId: NEW });
  assert.equal(without.length, 1, '不带别名只剩跨群那条');
  assert.equal(without[0].dst, '上海');

  const withAlias = g.nowEdges({ chatId: NEW, aliases: [OLD] });
  assert.equal(withAlias.length, 2, '别名要把旧边带出来');
  assert.ok(withAlias.some((e) => e.dst === '杭州'));
  g.close();
});

test('图谱：edgesAsOf 也认别名', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now() - 86_400_000;
  g.addEdge({ src: '小美', rel: '住在', dst: '杭州', chatId: OLD, at: t });
  assert.equal(g.edgesAsOf(Date.now(), { chatId: NEW }).length, 0);
  assert.equal(g.edgesAsOf(Date.now(), { chatId: NEW, aliases: [OLD] }).length, 1);
  g.close();
});

test('图谱：实体路也认别名（不认的话实体检索整段失效）', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  const ep = g.addEpisode({ at: t, chatId: OLD, text: '小美说她住在杭州', journalId: 'j-old' });
  g.addEdge({ src: '小美', rel: '住在', dst: '杭州', chatId: OLD, episodeId: ep, at: t });

  assert.equal(g.entities({ chatId: NEW }).filter((e) => e.name === '小美').length, 0);
  assert.equal(g.entities({ chatId: NEW, aliases: [OLD] }).filter((e) => e.name === '小美').length, 1);
  assert.deepEqual(g.linkedJournalIds('小美', { chatId: NEW }), []);
  assert.deepEqual(g.linkedJournalIds('小美', { chatId: NEW, aliases: [OLD] }), ['j-old']);
  g.close();
});

test('图谱：注入用的一段文字（text）也认别名', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '小美', rel: '住在', dst: '杭州', chatId: OLD, at: t });

  assert.equal(g.text({ chatId: NEW }), '', '不带别名时注入段是空的');
  assert.match(g.text({ chatId: NEW, aliases: [OLD] }), /杭州/, '带上别名要把旧关系写进注入');
  g.close();
});

test('图谱：没有别名时行为和以前完全一致', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '主人', rel: '住在', dst: '上海', chatId: 'g1', at: t });
  g.addEdge({ src: '主人', rel: '喜欢', dst: '猫', chatId: '', at: t });
  const a = g.nowEdges({ chatId: 'g1' });
  const b = g.nowEdges({ chatId: 'g1', aliases: [] });
  assert.deepEqual(a, b);
  g.close();
});

/* ================= 写路径也必须认别名 =================
 *
 * 读路径带别名把旧键的事读出来了（面板看得见、提示词里也注入了），
 * 写路径不带就会出现**「删不掉」**：用户说「忘掉这个」，
 * 返回 `0 条`，一刷新它还在。`journal.js` 开头那句
 * 「用户说忘掉三个月前那件事，实际没忘，是最不能接受的一种失败」
 * 在别名机制下说的就是这个。
 *
 * 这几条都是对抗性验证里真跑出来的坑，不是假想。
 */

/** 每个用例一个干净的 data 目录（memory 读 env） */
function freshMemory() {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-alias-mem-'));
  return createMemory();
}

test('facts：remove 带别名能把旧键的事一起删掉', () => {
  const m = freshMemory();
  m.add(OLD, '这个群讨厌香菜', 'chat');
  m.add(NEW, '这个群喜欢猫', 'chat');

  // 先确认读得到（不带别名读不到，说明这个用例的前提成立）
  assert.equal(m.list(NEW).chat.length, 1);
  assert.equal(m.list(NEW, [OLD]).chat.length, 2);

  assert.equal(m.remove(NEW, '香菜'), 0, '不带别名删不到旧键（这条记录不在 NEW 下面）');
  assert.equal(m.list(NEW, [OLD]).chat.length, 2, '旧键那条还在（预期：删不到）');

  assert.equal(m.remove(NEW, '香菜', [OLD]), 1, '带别名应该删到');
  assert.deepEqual(m.list(NEW, [OLD]).chat, ['这个群喜欢猫']);
});

test('facts：clearChat 带别名能清干净（只清当前键等于没清）', () => {
  const m = freshMemory();
  m.add(OLD, '旧键的事', 'chat');
  m.add(NEW, '新键的事', 'chat');

  m.clearChat(NEW);
  assert.deepEqual(m.list(NEW, [OLD]).chat, ['旧键的事'], '不带别名：旧键那条还在');

  m.clearChat(NEW, [OLD]);
  assert.deepEqual(m.list(NEW, [OLD]).chat, [], '带别名应该清空');
});

test('facts：hasAuthz 带别名能读到旧键的授权', () => {
  /**
   * 不认别名的后果很具体：换机器人后群 `group_push` 授权读不到 →
   * 这个群**永久不主动说话**，而面板上什么都看不出来。
   * 迁移页特意把「只授权过、一句话没记」的键列出来让人绑，就是为这一步铺路。
   */
  const m = freshMemory();
  m.setAuthz(OLD, 'group_push');
  assert.equal(m.hasAuthz(NEW, 'group_push'), false, '不带别名读不到');
  assert.equal(m.hasAuthz(NEW, 'group_push', [OLD]), true, '带别名应该读得到');
  assert.equal(m.hasAuthz(NEW, 'c2c_push', [OLD]), false, 'scope 不匹配仍然是 false');
});

test('facts：getPersonaOverride 带别名能读到旧键的人设', () => {
  const m = freshMemory();
  m.setPersonaOverride(OLD, '对这个人要更耐心');
  assert.equal(m.getPersonaOverride(NEW), '', '不带别名读不到');
  assert.equal(m.getPersonaOverride(NEW, [OLD]), '对这个人要更耐心');
});

test('日记：forget 带别名能抹掉旧键的正文', async () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '主人对花生过敏，很严重');
  note(j, NEW, '今天天气不错');

  assert.equal(j.forget({ chatId: NEW, word: '花生' }), 0, '不带别名抹不到');
  assert.equal((await j.search('花生过敏', { chatId: NEW, aliases: [OLD] })).length, 1, '还在（预期）');

  assert.equal(j.forget({ chatId: NEW, word: '花生', aliases: [OLD] }), 1, '带别名应该抹掉');
  assert.equal((await j.search('花生过敏', { chatId: NEW, aliases: [OLD] })).length, 0, '抹掉之后搜不到');
  j.close();
});

test('日记：clearChat 带别名能清掉旧键', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, OLD, '旧键的一条');
  note(j, NEW, '新键的一条');

  /**
   * `clearChat` 是**抹正文留行**（时间线不断），所以不能数条数——
   * 行还在，只是 `text` 变成占位符。断言要看正文。
   */
  assert.equal(j.clearChat(NEW), 1, '不带别名只清当前键');
  assert.ok(j.recent(NEW, 10, 'chat', [OLD]).some((r) => r.text === '旧键的一条'), '旧键那条还在（预期）');

  assert.equal(j.clearChat(NEW, [OLD]), 1, '带别名应该再清掉一条');
  assert.ok(!j.recent(NEW, 10, 'chat', [OLD]).some((r) => r.text === '旧键的一条'), '旧键那条也该被抹掉');
  j.close();
});

test('图谱：suppressEdge 带别名能真删掉旧键的边（否则删了又长回来）', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '阿离', rel: '讨厌', dst: '香菜', chatId: OLD, at: t });

  assert.equal(g.nowEdges({ chatId: NEW, aliases: [OLD] }).length, 1, '先确认读得到');

  const r0 = g.suppressEdge({ src: '阿离', rel: '讨厌', dst: '香菜', chatId: NEW });
  assert.equal(r0.removed, 0, '不带别名删不到');
  assert.equal(g.nowEdges({ chatId: NEW, aliases: [OLD] }).length, 1, '还在（预期）');

  const r1 = g.suppressEdge({ src: '阿离', rel: '讨厌', dst: '香菜', chatId: NEW, aliases: [OLD] });
  assert.equal(r1.removed, 1, '带别名应该真删掉');
  assert.equal(g.nowEdges({ chatId: NEW, aliases: [OLD] }).length, 0);
  g.close();
});

test('图谱：全局屏蔽（chatId 空）仍然删所有会话的边', () => {
  /**
   * 这是个容易改坏的回归点：`chatId=''` 的语义是「所有会话都别写」。
   * 改成按键循环之后，如果只删 `chat_id=''` 那几条，
   * 「全局删除」就变成「几乎什么都没删」，而面板上照样报成功。
   */
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '阿离', rel: '讨厌', dst: '香菜', chatId: 'g1', at: t });
  g.addEdge({ src: '阿离', rel: '讨厌', dst: '香菜', chatId: 'g2', at: t });
  const r = g.suppressEdge({ src: '阿离', rel: '讨厌', dst: '香菜', chatId: '' });
  assert.equal(r.removed, 2, '全局屏蔽要删掉所有会话的边');
  assert.equal(g.nowEdges({ chatId: 'g1' }).length, 0);
  g.close();
});

test('图谱：closeEdge 带别名能关掉旧键的活边', () => {
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const t = Date.now();
  g.addEdge({ src: '阿离', rel: '约定', dst: '周末看电影', chatId: OLD, at: t });

  assert.equal(g.closeEdge({ src: '阿离', rel: '约定', dst: '周末看电影', chatId: NEW }), 0, '不带别名关不掉');
  assert.equal(g.nowEdges({ chatId: NEW, aliases: [OLD] }).length, 1, '还是活边（预期）');

  assert.equal(g.closeEdge({ src: '阿离', rel: '约定', dst: '周末看电影', chatId: NEW, aliases: [OLD] }), 1);
  assert.equal(g.nowEdges({ chatId: NEW, aliases: [OLD] }).length, 0);
  g.close();
});

test('注入：top 的窗口按每个键各算（新键攒满也不能把旧键挤掉）', () => {
  /**
   * `top` 以前是「一次 IN (...) 取最新 400 条，再按等级过滤」。
   * 迁移之后新键一两天就能攒满 400 条普通日记，旧键那条 `important`
   * 排在第 401 位被截掉——而且是在**过滤之前**被截掉的，
   * 于是【记得比较深的】永远只有换机器人之后的事。
   */
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const base = Date.now() - 100 * 86_400_000;
  note(j, OLD, '换机器人之前的要紧事', { level: 'important', at: base });
  for (let i = 0; i < 400; i++) note(j, NEW, `换机器人之后的日常 ${i}`, { level: 'normal', at: base + i * 1000 });

  const top = j.top(NEW, { limit: 6, aliases: [OLD] });
  assert.ok(top.some((r) => r.text === '换机器人之前的要紧事'), `旧键的 important 被挤掉了：${JSON.stringify(top.map((r) => r.text))}`);
  j.close();
});

test('注入：digests 认别名，但「这几天」仍然只取最近的（旧摘要不该挤进来）', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const base = Date.now() - 100 * 86_400_000;
  note(j, OLD, '换机器人之前的摘要', { kind: 'digest', at: base });
  note(j, NEW, '昨天的摘要', { kind: 'digest', at: Date.now() - 86_400_000 });

  assert.equal(j.digests(NEW, 5).length, 1, '不带别名只有新键');
  const ds = j.digests(NEW, 5, [OLD]);
  assert.equal(ds.length, 2, '带别名两条都读得到');
  assert.equal(ds[0].text, '昨天的摘要', '最近的排前面');
  /**
   * 一百天前那条**不该**因为「能读到」就挤掉最近的。
   * 【这几天】说的是这几天，把三个月前的摘要塞进去比漏掉更让人困惑。
   */
  assert.equal(j.digests(NEW, 1, [OLD])[0].text, '昨天的摘要', 'limit=1 时给的必须是最新的那条');
  j.close();
});

test('衰减：没有 meta 的老事实不能以 1e-9 之差赢过刚记的', () => {
  /**
   * 早期版本的 facts 只有字符串、没有 meta。别名事实按「刚记的」算分数 1，
   * 而刚记的那条是 `1 × 0.5^(几毫秒/30天) ≈ 0.999999999`——
   * 老数据恰恰最可能没有 meta，于是「不知道多久以前的老事实」压过刚说的话。
   */
  const m = freshMemory();
  // 直接写文件造一条没有 meta 的老事实
  const dir = process.env.DSH_ROOST_DATA;
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({ chats: { [OLD]: ['很久以前的老事'] } }), 'utf8');
  const m2 = createMemory();
  m2.add(NEW, '刚刚说的事', 'chat');

  const rows = m2.listRanked(NEW, [OLD]).chat;
  assert.equal(rows[0], '刚刚说的事', `排序反了：${JSON.stringify(rows)}`);
  assert.ok(m);
});

/* ================= 第二轮复验补的回归 ================= */

test('巩固：约定被删之后不会从旧键的日记里被写回来', async () => {
  /**
   * 场景：用户在新键的会话里删掉一条约定（墓碑立在新键上），
   * 第二天巩固按**旧键**跑（昨天的日记还在旧键下）。
   * `isSuppressed` 不带别名就查不到新键的墓碑 → 约定被重新写进 facts 和图谱，
   * 而读路径带别名又能读出来 → 用户看到「删了又长回来」。
   */
  const { createConsolidate, yesterdayOf } = await import('../src/consolidate.js');
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const mem = freshMemory();
  /** 巩固跑的是**昨天**的日记，所以数据也要落在昨天 */
  const now = Date.now();
  const day = yesterdayOf(now);
  j.add({ id: 'a1', at: now - 86_400_000, chatId: OLD, text: '主人说周末去看电影' });

  // 用户在新键里删掉这条约定 → 墓碑立在 NEW
  const del = g.suppressEdge({ src: '主人', rel: '约定', dst: '周末去看电影', chatId: NEW });
  assert.equal(del.ok, true);

  const c = createConsolidate({
    journal: j,
    graph: g,
    memory: mem,
    aliasesOf: (cid) => (cid === OLD ? [NEW] : []),
    generate: async () => JSON.stringify({ agreements: ['周末去看电影'], triples: [], digest: '聊了电影' }),
  });
  const r = await c.run({ day });
  assert.equal(r.suppressed >= 1, true, `约定没被墓碑挡住：${JSON.stringify(r)}`);
  assert.ok(!mem.list(OLD, [NEW]).chat.some((f) => f.includes('周末去看电影')), '约定不该被写回 facts');
  j.close();
  g.close();
});

test('巩固：op=update 时旧键的活边也要关掉（否则留下两个答案）', async () => {
  /**
   * 日记在新键、旧活边在旧键，模型给 `op='update'`。
   * `hasActive(新键)` 为 false → 不关旧边 → 新边加上去，
   * 带别名读出来「住在杭州」和「住在上海」两条。
   */
  const { createConsolidate, yesterdayOf } = await import('../src/consolidate.js');
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  const g = createGraph({ file: join(tmp(), 'g.sqlite') });
  const mem = freshMemory();
  const now = Date.now();
  const day = yesterdayOf(now);
  const base = Date.parse(`${day}T10:00:00`);
  j.add({ id: 'a1', at: base, chatId: NEW, sender: '主人', text: '主人搬到上海了' });
  j.add({ id: 'a2', at: base + 1000, chatId: NEW, sender: '她', text: '嗯嗯' });
  g.addEdge({ src: '主人', rel: '住在', dst: '杭州', chatId: OLD, at: base - 200_000 });

  const c = createConsolidate({
    journal: j,
    graph: g,
    memory: mem,
    aliasesOf: (cid) => (cid === NEW ? [OLD] : []),
    generate: async () =>
      JSON.stringify({
        summary: '主人搬到上海了。',
        ranks: [['a2', 'normal']],
        compress: [{ id: 'a2', digest: '她应了一声' }],
        triples: [{ s: '主人', rel: '住在', o: '上海', op: 'update' }],
        agreements: [],
        closed: [],
      }),
    now: () => now,
  });
  await c.run({ day });

  const live = g.nowEdges({ chatId: NEW, aliases: [OLD] }).filter((e) => e.rel === '住在');
  assert.equal(live.length, 1, `应该只剩一条「住在」：${JSON.stringify(live.map((e) => e.dst))}`);
  assert.equal(live[0].dst, '上海');
  j.close();
  g.close();
});

test('日记：clearChat 不把 forget 过的行再算一次', () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite') });
  note(j, NEW, '讨厌香菜');
  note(j, NEW, '喜欢猫');

  assert.equal(j.forget({ chatId: NEW, word: '香菜' }), 1, '忘掉一条');
  /**
   * 不排除 `ERASED` 的话这里会返回 2——用户看到「忘掉 1 条」之后
   * 紧跟着「清空 2 条」，会以为第一次没清干净。
   */
  assert.equal(j.clearChat(NEW), 1, '只剩「喜欢猫」这一条真的要清');
  assert.equal(j.clearChat(NEW), 0, '再清一次是 0');
  j.close();
});
