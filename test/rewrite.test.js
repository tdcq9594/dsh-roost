// 一键改写：备份 → 合并后删旧键 → 回退。
//
// 这是唯一会动记忆数据的模块，所以测试必须是**端到端真跑**：
// 真的造 memory.json / journal.sqlite / graph.sqlite / sessions.json，
// 真的改写，真的检查旧键没了，真的从备份恢复回来。
// 只读代码猜是看不出「回退之后内存缓存又把旧数据写回去」这类问题的。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemory } from '../src/memory.js';
import { createJournal } from '../src/journal.js';
import { createGraph } from '../src/graph.js';
import { createSessions } from '../src/sessions.js';
import { createRewriter, claimsOf, REWRITE_CONFIRM } from '../src/rewrite.js';

const OLD = 'AAAA1111BBBB2222CCCC3333DDDD4444';
const OLD2 = 'BBBB2222CCCC3333DDDD4444EEEE5555';
const UIN = '10001';

/** 每个用例一套干净的四份存储 + 独立的备份根 */
function rig({ record = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-rewrite-'));
  const bak = mkdtempSync(join(tmpdir(), 'roost-rewrite-bak-'));
  process.env.DSH_ROOST_DATA = dir;

  const memory = createMemory();
  const journal = createJournal({ file: join(dir, 'journal.sqlite') });
  const graph = createGraph({ file: join(dir, 'graph.sqlite') });
  const sessions = createSessions({ dataDir: dir });

  const boundList = async () => ({
    ok: true,
    users: [record || { uin: UIN, claims: [{ botId: 'main', openid: OLD, state: 'active' }] }],
    groups: [],
  });

  const rw = createRewriter({ memory, journal, graph, sessions, boundList, backupRoot: bak });
  return { dir, bak, memory, journal, graph, sessions, rw };
}

/** 造一份「旧 openid 键下有记忆」的数据 */
function seed({ dir, memory, journal, graph, sessions }) {
  memory.add(OLD, '旧键的约定', 'chat');
  memory.setAuthz(OLD, 'group_push');
  memory.setPersonaOverride(OLD, '旧键的人设');
  journal.add({ chatId: OLD, text: '旧键的一篇日记', role: 'user', kind: 'chat', at: Date.now() });
  graph.addEdge({ src: '阿离', rel: '住在', dst: '杭州', chatId: OLD, at: Date.now() });
  sessions.set(OLD, 's-old', { title: '旧群', kind: 'group' });
  assert.ok(existsSync(join(dir, 'memory.json')), '前提：memory.json 得真的落盘');
}

/* ---------------- claimsOf ---------------- */

test('claimsOf：只取 active、去重、号码本身不算旧键', () => {
  const r = claimsOf({
    uin: UIN,
    claims: [
      { botId: 'a', openid: OLD, state: 'active' },
      { botId: 'b', openid: OLD, state: 'active' },
      { botId: 'a', openid: OLD2, state: 'revoked' },
      { botId: 'a', openid: UIN, state: 'active' },
    ],
  });
  assert.deepEqual(r, { uin: UIN, keys: [OLD] });
});

/* ---------------- plan ---------------- */

test('预览：只读，列出绝对路径与条数，不改任何文件', async () => {
  const r = rig();
  seed(r);
  const before = readFileSync(join(r.dir, 'memory.json'), 'utf8');

  const p = await r.rw.plan({});
  assert.equal(p.ok, true);
  assert.equal(p.dataDir, r.dir);
  assert.equal(p.backupRoot, r.bak);
  assert.equal(p.totals.keys, 1);
  assert.equal(p.totals.facts, 1);
  assert.equal(p.totals.journal, 1);
  assert.equal(p.totals.edges, 1);
  assert.equal(p.items[0].uin, UIN);
  assert.equal(p.items[0].keys[0].key, OLD);
  assert.equal(p.items[0].keys[0].session, true);
  assert.ok(p.files.some((f) => f.exists && f.abs === join(r.dir, 'memory.json')), '要列出绝对路径');
  assert.match(p.warning, /停掉旧机器人/);

  assert.equal(readFileSync(join(r.dir, 'memory.json'), 'utf8'), before, '预览不能改文件');
  assert.equal(existsSync(join(r.bak, 'anything')), false);
  r.journal.close();
  r.graph.close();
});

/* ---------------- 二次确认 ---------------- */

test('执行：确认词不对一律拒绝，不备份也不改写', async () => {
  const r = rig();
  seed(r);
  /** trim 是刻意的宽松处理（用户多打一个空格不该被卡），所以不算「不对」 */
  for (const confirm of ['', 'REWRITE', '改写吗', 'gai-xie']) {
    // eslint-disable-next-line no-await-in-loop
    const out = await r.rw.apply({ confirm });
    assert.equal(out.ok, false, `confirm=${JSON.stringify(confirm)} 不该通过`);
    assert.equal(out.code, 'CONFIRM_REQUIRED');
  }
  assert.equal(readFileSync(join(r.dir, 'memory.json'), 'utf8').includes(OLD), true);
  r.journal.close();
  r.graph.close();
});

/* ---------------- 改写 + 回退（核心） ---------------- */

test('改写：四份存储都搬到号码键，旧键消失，备份可一键回退', async () => {
  const r = rig();
  seed(r);

  const out = await r.rw.apply({ confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, true, `改写失败：${JSON.stringify(out)}`);
  assert.ok(out.backup.startsWith(r.bak), '备份要落在指定的归档根下');
  assert.ok(out.changed.keys >= 1);
  assert.ok(out.changed.journal >= 1, '日记要跟着搬');
  assert.ok(out.changed.graph.edges >= 1, '图谱要跟着搬');
  assert.ok(out.changed.sessions >= 1, '会话映射要跟着搬');

  /** 号码键下什么都在 */
  assert.ok(r.memory.list(UIN).chat.includes('旧键的约定'));
  assert.equal(r.memory.hasAuthz(UIN, 'group_push'), true);
  assert.equal(r.memory.getPersonaOverride(UIN), '旧键的人设');
  assert.ok(r.journal.recent(UIN, 10, 'chat').some((x) => x.text === '旧键的一篇日记'));
  assert.equal(r.graph.nowEdges({ chatId: UIN }).length, 1);
  assert.ok(r.sessions.entry(UIN), '会话映射要归到号码键');

  /** 旧键真的没了 */
  assert.equal(r.memory.list(OLD).chat.length, 0);
  assert.equal(r.journal.recent(OLD, 10, 'chat').length, 0);
  assert.equal(r.graph.nowEdges({ chatId: OLD }).length, 0);
  assert.equal(r.sessions.entry(OLD), null);

  /** 备份文件齐全 */
  const manifest = JSON.parse(readFileSync(join(out.backup, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((f) => f.name === 'memory.json'));
  assert.ok(manifest.files.some((f) => f.name === 'journal.sqlite'));
  assert.equal(r.rw.listBackups().length, 1);

  /** 回退 */
  const rb = r.rw.rollback({ backup: out.backup });
  assert.equal(rb.ok, true, `回退失败：${JSON.stringify(rb)}`);
  assert.equal(rb.restored.length, manifest.files.length);
  /**
   * 关键：回退后内存缓存必须清掉，否则下一次 save() 会把改写后的数据
   * 又写回刚恢复的文件——「点了回退，一刷新还是改写后的」。
   */
  assert.ok(r.memory.list(OLD).chat.includes('旧键的约定'));
  assert.equal(r.memory.list(UIN).chat.length, 0);
  assert.ok(r.journal.recent(OLD, 10, 'chat').some((x) => x.text === '旧键的一篇日记'));
  assert.equal(r.journal.recent(UIN, 10, 'chat').length, 0);
  assert.equal(r.graph.nowEdges({ chatId: OLD }).length, 1);
  assert.ok(r.sessions.entry(OLD));
  assert.equal(r.sessions.entry(UIN), null);

  r.journal.close();
  r.graph.close();
});

test('回退：只认自己备份根下的目录，拒绝任意路径', () => {
  const r = rig();
  for (const backup of ['', 'C:\\Windows', '/tmp', join(r.dir, '..')]) {
    const out = r.rw.rollback({ backup });
    assert.equal(out.ok, false, `不该接受 ${backup}`);
    assert.equal(out.code, 'INVALID_BACKUP');
  }
});

test('改写：一个旧键都没有时直接拒，不产生空备份', async () => {
  const r = rig({ record: { uin: UIN, claims: [] } });
  seed(r);
  const out = await r.rw.apply({ confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'NOTHING_TO_DO');
  assert.equal(r.rw.listBackups().length, 0);
  r.journal.close();
  r.graph.close();
});

/* ---------------- 底层 rekey ---------------- */

test('底层：journal.rekey 改归属不改行 id，两个后端口径一致', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-rekey-j-'));
  const j = createJournal({ file: join(dir, 'journal.sqlite') });
  j.add({ id: 'a1', chatId: OLD, text: '旧键日记', role: 'user', kind: 'chat', at: Date.now() });
  j.add({ id: 'a2', chatId: OLD2, text: '另一个旧键', role: 'user', kind: 'chat', at: Date.now() });
  assert.equal(j.rekey([OLD, OLD2], UIN), 2);
  assert.equal(j.recent(OLD, 10, 'chat').length, 0);
  assert.equal(j.recent(UIN, 10, 'chat').length, 2);
  assert.ok(j.get('a1'), '行 id 要保留，不能重建');
  assert.equal(j.rekey([OLD], UIN), 0, '再改一次不该重复计数');
  j.close();
});

test('底层：graph.rekey 处理同名实体与重复活边，不撞唯一索引', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-rekey-g-'));
  const g = createGraph({ file: join(dir, 'graph.sqlite') });
  const t = Date.now() - 1000;
  /** 旧键有一条「住在杭州」，号码键下已经有同名实体 + 同一条活边 → 会撞两个唯一约束 */
  g.addEdge({ src: '阿离', rel: '住在', dst: '杭州', chatId: OLD, at: t });
  g.addEdge({ src: '阿离', rel: '住在', dst: '杭州', chatId: UIN, at: t });
  g.addEdge({ src: '阿离', rel: '喜欢', dst: '猫', chatId: OLD, at: t });

  const out = g.rekey([OLD], UIN);
  assert.equal(out.mergedEntities > 0, true, '同名实体要合并');
  assert.equal(g.nowEdges({ chatId: OLD }).length, 0, '旧键不该再有边');
  const live = g.nowEdges({ chatId: UIN });
  assert.equal(live.filter((e) => e.rel === '住在').length, 1, '重复活边要去掉');
  assert.equal(live.filter((e) => e.rel === '喜欢').length, 1, '不重复的要保留');
  g.close();
});

test('底层：备份缺文件时回退要拒，不能覆盖成半个状态', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-rb-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: [] }), 'utf8');
  const rw = createRewriter({ backupRoot: dir });
  const out = rw.rollback({ backup: dir });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_BACKUP');
});

/* ---------------- 回退的路径安全（公开路由，能直接 POST） ---------------- */

test('回退：`..` 穿越绕不过备份根校验', () => {
  const r = rig();
  const evil = join(r.bak, '..', '..', '..', 'Windows');
  const out = r.rw.rollback({ backup: evil });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_BACKUP');
});

test('回退：备份不属于当前数据目录时拒绝（防止把记忆库换成另一份）', () => {
  const r = rig();
  const dir = mkdtempSync(join(r.bak, 'other'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ dataDir: 'D://somewhere-else', files: [{ abs: join('D://somewhere-else', 'memory.json') }] }),
    'utf8',
  );
  const out = r.rw.rollback({ backup: dir });
  assert.equal(out.ok, false);
  assert.match(out.error, /不属于当前数据目录/);
});

test('回退：manifest 里的条目必须在白名单内，不能借它写任意路径', () => {
  const r = rig();
  const dir = mkdtempSync(join(r.bak, 'evil'));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      dataDir: r.dir,
      files: [{ abs: join(r.dir, 'evil.dll') }],
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'evil.dll'), 'x', 'utf8');
  const out = r.rw.rollback({ backup: dir });
  assert.equal(out.ok, false);
  assert.match(out.error, /不认识的条目/);
  assert.equal(existsSync(join(r.dir, 'evil.dll')), false, '不该真的写出这个文件');
});

test('回退：manifest 里 abs 被改成别的目录，实际仍写回当前数据目录', async () => {
  const r = rig();
  seed(r);
  const out = await r.rw.apply({ confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, true);

  const mf = join(out.backup, 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  /** 把 abs 全指到别的目录，name 不变 */
  m.files = m.files.map((f) => ({ ...f, abs: join('D://hijack', f.name) }));
  writeFileSync(mf, JSON.stringify(m), 'utf8');

  const rb = r.rw.rollback({ backup: out.backup });
  assert.equal(rb.ok, true);
  assert.ok(rb.restored.every((p) => p.startsWith(r.dir)), '只能写回当前数据目录');
  assert.ok(r.memory.list(OLD).chat.includes('旧键的约定'), '数据要真的回来');
  r.journal.close();
  r.graph.close();
});

/* ---------------- 第三轮对抗验证报的 P1 ---------------- */

test('作用域：uins 传字符串只改指定号码，不能静默放大成全部', async () => {
  /**
   * 以前非数组一律当空集，而空集 = 「没指定 = 改全部」。
   * `POST {"uins":"10001"}` 会把**所有**号码的记忆一起改掉。
   */
  const r = rig({
    record: { uin: UIN, claims: [{ botId: 'main', openid: OLD, state: 'active' }] },
  });
  seed(r);
  /** 第二个号码，不该被动 */
  r.memory.add(OLD2, '第二个号码的记忆', 'chat');
  const boundList2 = async () => ({
    ok: true,
    users: [
      { uin: UIN, claims: [{ botId: 'main', openid: OLD, state: 'active' }] },
      { uin: '20002', claims: [{ botId: 'main', openid: OLD2, state: 'active' }] },
    ],
    groups: [],
  });
  const rw2 = createRewriter({
    memory: r.memory, journal: r.journal, graph: r.graph, sessions: r.sessions,
    boundList: boundList2, backupRoot: r.bak,
  });

  const p = await rw2.plan({ uins: '10001' });
  assert.deepEqual(p.items.map((x) => x.uin), [UIN], '字符串形态也要只选中 10001');

  const out = await rw2.apply({ uins: '10001', confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, true);
  assert.ok(r.memory.list(OLD2).chat.includes('第二个号码的记忆'), '20002 的记忆不能被改');
  assert.equal(r.sessions.entry(OLD2), null, '20002 本来就没有会话映射，这里只确认没被塞东西');
  r.journal.close();
  r.graph.close();
});

test('并发：第二次 apply 直接 BUSY，不会产出「改写后」的假备份', async () => {
  const r = rig();
  seed(r);
  const [a, b] = await Promise.all([
    r.rw.apply({ confirm: REWRITE_CONFIRM }),
    r.rw.apply({ confirm: REWRITE_CONFIRM }),
  ]);
  const okCount = [a, b].filter((x) => x.ok).length;
  const busy = [a, b].find((x) => x.code === 'BUSY');
  assert.equal(okCount, 1, '只允许一次成功');
  assert.ok(busy, '另一次应该明确报 BUSY');
  assert.equal(r.rw.listBackups().length, 1, '只能留下一份真备份');
  r.journal.close();
  r.graph.close();
});

test('回退：准备阶段失败时原文件一个都不动', async () => {
  const r = rig();
  seed(r);
  const out = await r.rw.apply({ confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, true);

  /**
   * 让 `copyFileSync(src, target + '.restore.tmp')` 失败：
   * 预先在那个路径上建一个**目录**，覆盖同名文件就会 EISDIR/EPERM。
   */
  mkdirSync(join(r.dir, 'memory.json.restore.tmp'));

  const before = readFileSync(join(r.dir, 'sessions.json'), 'utf8');
  const rb = r.rw.rollback({ backup: out.backup });
  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'RESTORE_FAILED');
  assert.match(rb.error, /原文件一个都没动/);
  /** 改写后的状态原样留着，不是「一半恢复」 */
  assert.equal(readFileSync(join(r.dir, 'sessions.json'), 'utf8'), before);
  assert.equal(r.memory.list(UIN).chat.includes('旧键的约定'), true, '仍是改写后的状态');
  r.journal.close();
  r.graph.close();
});

test('回退：白名单外条目在动手之前就被拦下', async () => {
  const r = rig();
  seed(r);
  const out = await r.rw.apply({ confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, true);

  const mf = join(out.backup, 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  /** 把 config.json 排在 memory.json 前面：老实现会先把 memory 写脏再报错 */
  m.files = [{ abs: join(r.dir, 'config.json') }, ...m.files];
  writeFileSync(mf, JSON.stringify(m), 'utf8');

  const before = readFileSync(join(r.dir, 'memory.json'), 'utf8');
  const rb = r.rw.rollback({ backup: out.backup });
  assert.equal(rb.ok, false);
  assert.equal(rb.code, 'INVALID_BACKUP');
  assert.equal(readFileSync(join(r.dir, 'memory.json'), 'utf8'), before, '校验失败不能留下半改状态');
  r.journal.close();
  r.graph.close();
});

test('备份根写不了时退到数据目录，功能不整体失效', async () => {
  /**
   * `BACKUP_ROOT` 写死在 D 盘。没有 D 盘的机器上 mkdir 直接 EPERM，
   * 一键改写整个功能不可用，报错还是一句看不懂的 EPERM。
   * 这里用一个「已存在的文件」当备份根，稳定复现「写不了」。
   */
  const r = rig();
  seed(r);
  const notDir = join(r.bak, 'i-am-a-file');
  writeFileSync(notDir, 'x', 'utf8');

  const rw = createRewriter({
    memory: r.memory,
    journal: r.journal,
    graph: r.graph,
    sessions: r.sessions,
    boundList: async () => ({
      ok: true,
      users: [{ uin: UIN, claims: [{ botId: 'main', openid: OLD, state: 'active' }] }],
      groups: [],
    }),
    backupRoot: notDir,
  });

  const out = await rw.apply({ confirm: REWRITE_CONFIRM });
  assert.equal(out.ok, true, `改写应该照常完成：${JSON.stringify(out)}`);
  assert.ok(out.backup.includes('rewrite-backups'), `应该退到数据目录下：${out.backup}`);
  assert.ok(existsSync(join(out.backup, 'manifest.json')));

  /** 列表要能看到 fallback 里的备份 */
  assert.equal(rw.listBackups().some((b) => b.dir === out.backup), true);

  /** 回退也要认这个 fallback 目录 */
  const rb = rw.rollback({ backup: out.backup });
  assert.equal(rb.ok, true, JSON.stringify(rb));
  assert.ok(r.memory.list(OLD).chat.includes('旧键的约定'), '回退后旧记忆要回来');
  r.journal.close();
  r.graph.close();
});
