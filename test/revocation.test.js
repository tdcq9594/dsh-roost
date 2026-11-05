// 批次 2 回归：表情包停不下来（2.1 剥动作标记 + 2.2 三级撤销 + 2.3 不 append）。
//
// 真机 P4：19:17:20「让她记住每发一句话一定要发个表情包」被判 critical，
// 之后 19:17:42「你就不用了」、19:25:39「别再发」只写出 normal 新事实，
// 旧约定没作废，于是连续 8 轮照样带图。
//
// 独立复核抓到两条 P0，这组测试特意锁住修复：
//   · 约定之后夹了别的 important 消息，也必须精确作废约定本身；
//   · 「不用了谢谢 / 取消订单」不能静默丢消息，更不能误作废旧约定。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal, dayOf } from '../src/journal.js';
import {
  createJournalBridge,
  cleanBotText,
  isRevocation,
  quotedOf,
  pickRevocationTargets,
} from '../src/journal-bridge.js';
import { createLedgerReader } from '../src/ledger-read.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'roost-revoke-'));
const DAY = 86_400_000;
const noop = () => {};
const idsOf = (rows) => rows.map((r) => r.id);

/**
 * 强制走 JSONL 回落，且**父目录仍可写**。
 *
 * `memory.test.js:545` 用「父目录其实是个文件」来逼回落，那样 JSONL 也
 * 写不进盘，只能测内存行为。这里改成让库路径本身是个目录：SQLite 打不开，
 * 而回落后的 `<同名>.jsonl` 落在可写的 `dir` 里，才能验「重开还在」。
 */
function jsonlFile() {
  const dir = tmp();
  const file = join(dir, 'journal.sqlite');
  mkdirSync(file);
  return file;
}

/** 生产形态的 bridge：journal 是真 createJournal，chat 带可选 aliases */
function liveBridge(journal, chat = { chatId: 'g1' }) {
  return createJournalBridge({ journal, memoryOff: () => false, log: { info() {}, warn() {} } });
}

/* ---------------- 老库补列 ---------------- */

test('失效机制：老库没有两列也能开，ALTER 补列、老行默认 0', () => {
  const file = join(tmp(), 'old.sqlite');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE journal (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, day TEXT NOT NULL,
    chat_id TEXT NOT NULL DEFAULT '', sender TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user', text TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'normal', kind TEXT NOT NULL DEFAULT 'chat',
    digest TEXT, keep_until INTEGER NOT NULL DEFAULT 0,
    accessed INTEGER NOT NULL DEFAULT 0, last_access INTEGER NOT NULL DEFAULT 0,
    vec BLOB, event_ids TEXT, evidence TEXT
  )`);
  d.exec(
    `INSERT INTO journal(id,at,day,chat_id,text,level) VALUES ('old-1', ${Date.now()}, '${dayOf(Date.now())}', 'g1', '老约定', 'critical')`,
  );
  d.close();

  const j = createJournal({ file, log: noop });
  assert.equal(j.get('old-1').invalidAt, 0, '老行默认有效');
  assert.equal(j.get('old-1').supersededBy, '');
  assert.equal(j.invalidate(['old-1'], { at: 123, supersededBy: 'msg-42' }), 1);
  assert.equal(j.get('old-1').invalidAt, 123);
  assert.equal(j.get('old-1').text, '老约定', '原文不删不抹');
  assert.equal(j.invalidated({ chatId: 'g1' })[0].supersededBy, 'msg-42');
  j.add({ id: 'new-1', at: Date.now(), chatId: 'g1', text: '新数据' });
  assert.equal(j.get('new-1').invalidAt, 0, '迁移后照样能写新数据');
});

/* ---------------- 全部读路径过滤 ---------------- */

test('失效机制：失效行不进注入/检索/巩固，但 get 仍能溯源；重复作废不改写', async () => {
  const j = createJournal({ file: join(tmp(), 'j.sqlite'), log: noop });
  const at = Date.now();
  j.add({ id: 'a', at, chatId: 'g1', sender: '甲', role: 'user', text: '每句话都要配表情包', level: 'critical', eventIds: ['ev-1'], evidence: [{ excerpt: '原文快照' }] });
  j.add({ id: 'b', at: at + 1, chatId: 'g1', sender: '甲', role: 'user', text: '今天吃了面', level: 'important' });
  j.add({ id: 'c', at: at + 2, chatId: 'g1', role: 'bot', text: '好呀' });
  j.add({ id: 'd', at: at + 3, chatId: 'g1', text: '每天摘要', kind: 'digest', level: 'important' });

  assert.equal(j.invalidate(['a', 'b'], { at: at + 10, supersededBy: 'msg-42' }), 2);
  assert.equal(j.invalidate(['a'], { at: at + 20, supersededBy: 'msg-43' }), 0, 'WHERE invalid_at=0 防重复改写');

  const gone = j.get('a');
  assert.equal(gone.invalidAt, at + 10);
  assert.equal(gone.supersededBy, 'msg-42', '重复作废不能把溯源改掉');
  assert.equal(gone.text, '每句话都要配表情包');
  assert.deepEqual(gone.eventIds, ['ev-1']);
  assert.deepEqual(gone.evidence, [{ excerpt: '原文快照' }]);

  assert.ok(!idsOf(j.top('g1', { limit: 10 })).includes('a'), 'top（注入【记得比较深的】）');
  assert.ok(!idsOf(j.recent('g1', 10)).includes('a'), 'recent（摘要 / 刚才说到）');
  assert.ok(!idsOf(j.recentTimeline('g1', { limit: 10 })).includes('a'), 'recentTimeline（chat_look 时间线）');
  assert.ok(!idsOf(j.byDay(dayOf(at))).includes('a'), 'byDay（巩固取料）');
  assert.ok(!idsOf(j.listChat('g1', 0)).includes('a'), 'listChat（top / forget 的原料）');
  assert.ok(!idsOf(j.digests('g1', 10)).includes('a'));
  assert.ok(!idsOf(await j.search('表情包', { chatId: 'g1' })).includes('a'), 'FTS 仍命中，但 JOIN 要过滤掉');
  assert.ok(!idsOf(j.noVec(64)).includes('a'), 'noVec（补向量，别让失效行复活）');
  assert.ok(!idsOf(j.dueToCompress(at + 100 * DAY, 500)).includes('b'), 'due（别把失效行压成 digest）');
  assert.equal(j.dueCount(at + 100 * DAY), 1, 'dueCount 同口径（只剩 c）');
  assert.equal(j.scanChats().find((x) => x.chatId === 'g1').journal, 2);
  assert.equal(j.stats().total, 2);
  assert.equal(j.stats().invalidated, 2);
  assert.equal(j.invalidated({ chatId: 'g1' }).length, 2);
});

test('失效机制：JSONL 后端同口径，rewrite 之后失效字段不丢', () => {
  const file = jsonlFile();
  const j = createJournal({ file, log: noop });
  const at = Date.now();
  j.add({ id: 'a', at, chatId: 'g1', text: '每句配表情包', level: 'critical' });
  j.add({ id: 'b', at: at + 1, chatId: 'g1', text: '今天吃了面', level: 'important' });
  assert.equal(j.backend(), 'jsonl');
  assert.equal(j.invalidate(['a'], { at: at + 2, supersededBy: 'msg-42' }), 1);
  assert.equal(j.get('a').invalidAt, at + 2);
  assert.equal(j.recent('g1', 10).length, 1);
  assert.equal(j.top('g1', { limit: 10 }).length, 1);
  assert.equal(j.invalidated({ chatId: 'g1' }).length, 1);
  j.close();

  const j2 = createJournal({ file, log: noop });
  assert.equal(j2.backend(), 'jsonl');
  assert.equal(j2.get('a').invalidAt, at + 2, 'normRow 必须认驼峰，否则 rewrite 会丢字段');
  assert.equal(j2.get('a').supersededBy, 'msg-42');
  assert.equal(j2.recent('g1', 10).length, 1);
});

/* ---------------- 2.1 剥动作标记 ---------------- */

test('2.1：bot 行剥动作标记，但补上「发过图」的痕迹', () => {
  assert.equal(cleanBotText('你好<<image: C:\\stickers\\希露.jpg>>'), '你好\n（发了图片）');
  assert.equal(cleanBotText('<<image: a>><<image: b>>'), '（发了图片 ×2）');
  assert.equal(cleanBotText('早上好<<voice: a.mp3>>'), '早上好\n（发了语音）');
  assert.equal(cleanBotText('<<say: 晚安>>'), '晚安', 'say 里念出来的那句话是正文');
  assert.equal(cleanBotText('<<say: 内容里有 > 号>>'), '内容里有 > 号', '值里的 > 不该截断');
  assert.equal(cleanBotText('在吗<<silence:2h>><<button: x>><<remember: y>>'), '在吗');
  assert.equal(cleanBotText('1 < 2 > 0'), '1 < 2 > 0', '普通尖括号不能误伤');
  assert.equal(cleanBotText('a << b >> c'), 'a << b >> c', '双尖括号正文不能误伤');
  assert.equal(cleanBotText('<<image: 没闭合'), '', '半截标记摘干净，不写空行');
  assert.equal(
    cleanBotText('你好<<image: 断了，后面还有正常正文'),
    '你好，后面还有正常正文',
    '半截标记不能把同一行后面的正文吃掉',
  );
  assert.equal(cleanBotText('<<image: 断了\n第二行正常正文'), '第二行正常正文', '换行后的正文要留着');
});

/* ---------------- 2.3 撤销判定 ---------------- */

test('2.3：撤销正则收紧，新约定 / 普通话不再被当撤销句', () => {
  assert.equal(isRevocation('你就不用了'), true);
  assert.equal(isRevocation('别再发表情包了'), true);
  assert.equal(isRevocation('取消吧'), false, '「取消」既能撤销也能下单，已从正则移除');
  assert.equal(isRevocation('不许迟到'), false, '「不许迟到」是在下新约定');
  assert.equal(isRevocation('记住，以后每句话都要发表情包'), false);
  assert.equal(isRevocation('在吗'), false);
  assert.equal(isRevocation('不用了谢谢'), true, '第一道筛子会命中，靠「指不出旧约定」兜底');
});

test('P1-1：payload.quoted 缺失时从「（引用了这句：…）」文本兜底', () => {
  assert.equal(quotedOf({ quoted: '直接给' }, '随便'), '直接给');
  assert.equal(
    quotedOf({}, '你就不用了\n（引用了这句：好呀，那我每次说话都带张图）'),
    '好呀，那我每次说话都带张图',
  );
  assert.equal(quotedOf({}, '在吗'), '');
  assert.equal(
    quotedOf({}, '你就不用了\n（引用了这句：好呀（笑），那我每次说话都带张图）\n'),
    '好呀（笑），那我每次说话都带张图',
    '引用内容里的全角右括号不能提前截断',
  );
});

test('L1：引用定位到 bot 行，作废最像被推翻的那条约定', () => {
  const rows = [
    { id: 'identity', at: 100, role: 'user', level: 'critical', text: '我叫小明' },
    { id: 'agree', at: 200, role: 'user', level: 'critical', text: '每句话都要配表情包' },
    { id: 'bot', at: 300, role: 'bot', level: 'normal', text: '好呀，那我每次说话都带张图' },
  ];
  const r = pickRevocationTargets(rows, {
    quoted: '好呀，那我每次说话都带张图',
    text: '你就不用了',
    before: 400,
  });
  assert.equal(r.level, 'L1');
  assert.deepEqual(r.ids, ['agree'], '身份事实必须跳过');
});

test('L2：没有引用时按词面重叠选目标，跳过身份事实与已失效行', () => {
  const rows = [
    { id: 'identity', at: 100, role: 'user', level: 'critical', text: '我叫小明' },
    { id: 'old', at: 200, role: 'user', level: 'important', text: '明天见' },
    { id: 'gone', at: 300, role: 'user', level: 'critical', text: '以前的约定', invalidAt: 123 },
    { id: 'latest', at: 400, role: 'user', level: 'critical', text: '每句配表情' },
  ];
  const r = pickRevocationTargets(rows, { text: '别再发表情包了', before: 500 });
  assert.equal(r.level, 'L2');
  assert.deepEqual(r.ids, ['latest']);
  assert.deepEqual(pickRevocationTargets([], { text: '别再发', before: 500 }).ids, []);
});

/* ---------------- P0-1 / P0-2：真机时序与误伤 ---------------- */

test('P0-1：约定之后夹了别的 important 消息，仍能精确作废约定', () => {
  const j = createJournal({ file: join(tmp(), 'p0-1.sqlite'), log: noop });
  const at = Date.now() - 10_000;
  /** 用真机 19:17:20 的 15 字原话：二次复核证明短约定会掩盖归一化门槛的 P0 */
  j.add({ id: 'agree', at, chatId: 'g1', sender: '甲', role: 'user', text: '让她记住每发一句话一定要发个表情包', level: 'critical' });
  j.add({ id: 'other', at: at + 1, chatId: 'g1', sender: '甲', role: 'user', text: '明天提醒我买牛奶', level: 'important' });
  j.add({ id: 'bot0', at: at + 2, chatId: 'g1', role: 'bot', text: '好呀，那我每次说话都带张图', level: 'important' });

  liveBridge(j).add(
    { id: 'msg-42' },
    { chatId: 'g1' },
    '你就不用了\n（引用了这句：好呀，那我每次说话都带张图）',
    'user',
  );

  assert.ok(!idsOf(j.top('g1', { limit: 10 })).includes('agree'), 'critical 约定必须离开注入集');
  assert.ok(j.get('agree').invalidAt > 0);
  assert.equal(j.get('agree').supersededBy, 'msg-42');
  assert.equal(j.get('other').invalidAt, 0, '无关的 important 不能被误作废');
  assert.ok(j.get('bot0').invalidAt > 0, '被引用且 high-level 的 bot 回声一起失效');
});

test('P0-2：指不出旧约定时按普通句写日记，不丢消息也不误作废', () => {
  const j = createJournal({ file: join(tmp(), 'p0-2.sqlite'), log: noop });
  const at = Date.now() - 10_000;
  j.add({ id: 'agree', at, chatId: 'g1', role: 'user', text: '每句话都要配表情包', level: 'critical' });
  const bridge = liveBridge(j);

  bridge.add({ id: 'm-thanks' }, { chatId: 'g1' }, '不用了谢谢', 'user');
  assert.equal(j.get('agree').invalidAt, 0, '客套话不能作废旧约定');
  assert.equal(j.get('m-thanks').text, '不用了谢谢', '普通消息必须写进日记');

  bridge.add({ id: 'm-late' }, { chatId: 'g1' }, '不许迟到', 'user');
  assert.equal(j.get('agree').invalidAt, 0);
  assert.equal(j.get('m-late').text, '不许迟到', '下新约定就是下新约定');

  bridge.add({ id: 'm-mixed' }, { chatId: 'g1' }, '别再发了，另外明天提醒我开会', 'user');
  const mixed = j.get('m-mixed');
  assert.ok(mixed, '混合消息不能整条丢失');
  assert.match(mixed.text, /明天提醒我开会/);
});

/* ---------------- bridge：两道关口都生效 ---------------- */

function bridgeRig({ rows = [] } = {}) {
  const added = [];
  const calls = [];
  const seen = [];
  const journal = {
    add: (row) => { added.push(row); return { added: true }; },
    listChat: (chatId, limit, aliases) => { seen.push({ chatId, limit, aliases }); return rows; },
    invalidate: (ids, opts) => { calls.push({ ids, opts }); return ids.length; },
  };
  const bridge = createJournalBridge({ journal, memoryOff: () => false, log: { info() {}, warn() {} } });
  return { bridge, added, calls, seen };
}

test('2.1：写进日记的 bot 正文与快照都是清洗后的', () => {
  const { bridge, added } = bridgeRig();
  bridge.add({ id: 'm1', eventIds: ['ev-1'] }, { chatId: 'g1' }, '好呀<<image: a.jpg>>', 'bot');
  assert.equal(added[0].text, '好呀\n（发了图片）');
  assert.equal(added[0].evidence[0].excerpt, '好呀\n（发了图片）', '快照不能抄标记');
});

test('2.1：剥完只剩标记时不写空行', () => {
  const { bridge, added } = bridgeRig();
  bridge.add({ id: 'm' }, { chatId: 'g1' }, '<<silence:2h>>', 'bot');
  assert.equal(added.length, 0);
});

test('2.3：撤销句作废旧约定，不 append 成新事实', () => {
  const rows = [{ id: 'agree', at: 100, role: 'user', level: 'critical', text: '每句话都要配表情包' }];
  const { bridge, added, calls } = bridgeRig({ rows });
  bridge.add(
    { id: 'msg-42' },
    { chatId: 'g1' },
    '你就不用了\n（引用了这句：好呀，那我每次说话都带张图）',
    'user',
  );
  assert.equal(added.length, 0, '撤销句不能变成一条新事实');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['agree'], 'quotedOf 的文本兜底让 L1 不悬空');
  assert.equal(calls[0].opts.supersededBy, 'msg-42', '溯源指向推翻它的那条消息');
});

test('2.3：没有旧约定时不误作废，按普通句写日记', () => {
  const { bridge, added, calls } = bridgeRig({ rows: [] });
  bridge.add({ id: 'm' }, { chatId: 'g1' }, '不用了谢谢', 'user');
  assert.equal(calls.length, 0, '没有可指向的旧约定就不作废');
  assert.equal(added.length, 1, '也不能把用户这句话丢掉');
  assert.equal(added[0].text, '不用了谢谢');
});

test('P1-4：撤销判定把 aliases 传给 listChat（换过机器人也能作废旧约定）', () => {
  const { bridge, seen } = bridgeRig({ rows: [] });
  bridge.add({ id: 'm' }, { chatId: 'new-key', aliases: ['old-key'] }, '别再发表情包了', 'user');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].chatId, 'new-key');
  assert.equal(seen[0].limit, 0, '全量扫描，不设窗口');
  assert.deepEqual(seen[0].aliases, ['old-key']);
});

/* ---------------- L1 引用列：老库不能静默查空 ---------------- */

function eventsDb(dir, withRefs) {
  const bots = join(dir, 'data', 'bots', 'main');
  mkdirSync(bots, { recursive: true });
  const file = join(bots, 'events.db');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE events (
    seq INTEGER PRIMARY KEY, kind TEXT, chat_id TEXT, user_name TEXT,
    content TEXT, payload TEXT, at INTEGER, time_basis TEXT
    ${withRefs ? ', quoted TEXT, ref_msg_idx TEXT' : ''}
  )`);
  if (withRefs) {
    d.exec(`INSERT INTO events(kind,chat_id,user_name,content,payload,at,time_basis,quoted,ref_msg_idx)
      VALUES ('group','g1','甲','你好','{}',${Date.now()},'message','被引用的那句','7')`);
  } else {
    d.exec(`INSERT INTO events(kind,chat_id,user_name,content,payload,at,time_basis)
      VALUES ('group','g1','甲','你好','{}',${Date.now()},'message')`);
  }
  d.close();
}

test('L1：新 events.db 能把 quoted / refMsgIdx 带出来', () => {
  const dir = tmp();
  eventsDb(dir, true);
  const rows = createLedgerReader({ roostDirOf: () => dir, log: noop }).recent({ chatId: 'g1', limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quoted, '被引用的那句');
  assert.equal(rows[0].refMsgIdx, '7');
});

test('L1：老 events.db 缺引用列时仍能读出记录，不会静默变空', () => {
  const dir = tmp();
  eventsDb(dir, false);
  const rows = createLedgerReader({ roostDirOf: () => dir, log: noop }).recent({ chatId: 'g1', limit: 10 });
  assert.equal(rows.length, 1, '缺列不能被 catch 吞成空数组');
  assert.equal(rows[0].text, '你好');
  assert.equal(rows[0].quoted, undefined, '缺列时整组字段不出现');
});

/* ---------------- 二次复核 P0：长约定 / 短引用不再静默失效 ---------------- */

test('P0-1 补：真机 15 字长约定 + 短引用「好呀」也能撤销（L1 保底）', () => {
  const rows = [
    { id: 'agree', at: 100, role: 'user', level: 'critical', text: '让她记住每发一句话一定要发个表情包' },
    { id: 'other', at: 101, role: 'user', level: 'important', text: '明天提醒我买牛奶' },
    { id: 'bot0', at: 102, role: 'bot', level: 'important', text: '好呀，那我每次说话都带张图' },
  ];
  const r = pickRevocationTargets(rows, { quoted: '好呀', text: '你就不用了', before: 200 });
  assert.equal(r.level, 'L1');
  assert.deepEqual(r.ids, ['agree', 'bot0']);
});

test('P0-1 补：真机 15 字长约定 + 无引用「别再发」也能撤销（L2）', () => {
  const rows = [
    { id: 'agree', at: 100, role: 'user', level: 'critical', text: '让她记住每发一句话一定要发个表情包' },
    { id: 'other', at: 101, role: 'user', level: 'important', text: '明天提醒我买牛奶' },
  ];
  const r = pickRevocationTargets(rows, { text: '别再发', before: 200 });
  assert.equal(r.level, 'L2');
  assert.deepEqual(r.ids, ['agree']);
});

/* ---------------- 第三轮复核的两条 P1：不许静默误作废 ---------------- */

test('P1：撤销词 + 引用了无关的 bot 行，不能误作废 critical 约定', () => {
  const rows = [
    { id: 'agree', at: 100, role: 'user', level: 'critical', text: '让她记住每发一句话一定要发个表情包' },
    { id: 'noise', at: 101, role: 'bot', level: 'normal', text: '嗯嗯，收到啦' },
  ];
  const r = pickRevocationTargets(rows, { quoted: '嗯嗯', text: '不用了谢谢', before: 200 });
  assert.deepEqual(r.ids, [], 'anchor 与候选零共享时，L1 保底不能无条件放行');
});

test('P1：纯客套「不用了谢谢」即使与约定共享字，也不撤销', () => {
  const j = createJournal({ file: join(tmp(), 'polite.sqlite'), log: noop });
  const at = Date.now() - 10_000;
  j.add({ id: 'agree', at, chatId: 'g1', role: 'user', text: '记住谢绝一切推销', level: 'critical' });
  liveBridge(j).add({ id: 'm-thanks' }, { chatId: 'g1' }, '不用了谢谢', 'user');
  assert.equal(j.get('agree').invalidAt, 0, '不能因为共享一个「谢」字就作废');
  assert.equal(j.get('m-thanks').text, '不用了谢谢', '客套话照常写进日记');
});
