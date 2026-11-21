// 会话映射存盘的并发安全（对照方案 A 批）：
// 写前合并、原子替换、墓碑、损坏备份、内存视图语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessions, chatSessionKey } from '../src/sessions.js';

/** 每个用例一个干净目录，避免互相污染（这份文件是整份覆盖的，共用目录会串） */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-sessions-'));
  const file = join(dir, 'sessions.json');
  const logs = [];
  const make = () => createSessions({ dataDir: dir, log: (m) => logs.push(m) });
  return {
    dir,
    file,
    logs,
    make,
    read: () => JSON.parse(readFileSync(file, 'utf8')),
    write: (v) => writeFileSync(file, JSON.stringify(v, null, 2), 'utf8'),
    /** 造「别的写者刚写下去」的磁盘状态 */
    disk: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { chats: {} }),
  };
}

test('A1 写盘是原子替换，不留 .tmp', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a', { title: '群一', kind: 'group' });
  assert.equal(t.read().chats.A.sessionId, 'sid-a');
  assert.equal(readdirSync(t.dir).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('A2 写前合并：磁盘上别的写者新增的键不被抹掉', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a');
  const d = t.disk();
  d.chats.B = { sessionId: 'sid-b', at: 1 };
  t.write(d);
  s.set('A', 'sid-a2');
  const after = t.read();
  assert.equal(after.chats.B?.sessionId, 'sid-b', '别的写者的键要留着');
  assert.equal(after.chats.A.sessionId, 'sid-a2', '同名键以内存为准');
});

test('A3 空 sessionId 是合法记录，不能被当成缺失丢掉', () => {
  const t = fresh();
  const s = t.make();
  /** host.js 会 set(chatId,'') 建「只登记不绑定」的条目 */
  s.set('E', '', { title: '空绑定' });
  assert.equal(t.read().chats.E.sessionId, '');
  const s2 = t.make();
  assert.equal(s2.entry('E')?.sessionId, '', '重启后还在');
  s2.set('F', 'sid-f');
  assert.equal(t.read().chats.E.sessionId, '', '合并时也不能丢');
});

test('A4 墓碑：remove 之后磁盘旧版本不许复活', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a');
  s.remove('A');
  assert.equal(t.read().chats.A, undefined);
});

test('A5 墓碑落盘即清：别人重建同名键后，我们下次写盘不该删它', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a');
  s.remove('A');
  /** 另一个写者（面板 / 一键改写）刚重建了 A */
  const d = t.disk();
  d.chats.A = { sessionId: 'sid-a-new', at: 2 };
  t.write(d);
  s.set('B', 'sid-b');
  assert.equal(t.read().chats.A?.sessionId, 'sid-a-new', '墓碑不该持续压制别人的写入');
});

test('A6 墓碑不拦显式 set：清上下文之后必须能重新绑定', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a');
  s.remove('A');
  assert.equal(t.read().chats.A, undefined);
  s.set('A', 'sid-a2');
  assert.equal(t.read().chats.A.sessionId, 'sid-a2');
});

test('A7 reload 是权威重置：跟随磁盘、并清掉墓碑', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a');
  s.remove('A');
  /** 一键回退：磁盘被整份换回带 A 的版本 */
  const d = t.disk();
  d.chats.A = { sessionId: 'sid-restored', at: 3 };
  t.write(d);
  s.reload();
  assert.equal(s.entry('A')?.sessionId, 'sid-restored');
  s.set('B', 'sid-b');
  assert.equal(t.read().chats.A?.sessionId, 'sid-restored', '重载后旧的删除意图不该再压制');
});

test('A8 损坏文件：先备份、再降级为空、并且记日志（不静默）', () => {
  const t = fresh();
  writeFileSync(t.file, '{bad', 'utf8');
  const s = t.make();
  assert.equal(s.size, 0);
  const baks = readdirSync(t.dir).filter((n) => n.startsWith('sessions.json.corrupted.'));
  assert.equal(baks.length, 1, '必须留备份');
  assert.equal(readFileSync(join(t.dir, baks[0]), 'utf8'), '{bad', '备份是原文');
  assert.equal(t.logs.length, 1);
  assert.match(t.logs[0], /损坏/);
});

test('A9 结构不对（数组 / chats 不是对象）也算损坏', () => {
  const t = fresh();
  writeFileSync(t.file, '[]', 'utf8');
  const s = t.make();
  assert.equal(s.size, 0);
  assert.ok(readdirSync(t.dir).some((n) => n.startsWith('sessions.json.corrupted.')));

  const t2 = fresh();
  writeFileSync(t2.file, '{"chats":[]}', 'utf8');
  const s2 = t2.make();
  assert.equal(s2.size, 0);
  assert.ok(readdirSync(t2.dir).some((n) => n.startsWith('sessions.json.corrupted.')));
});

test('A10 文件不存在：当空、不备份、不告警', () => {
  const t = fresh();
  const s = t.make();
  assert.equal(s.size, 0);
  assert.equal(t.logs.length, 0);
  assert.deepEqual(readdirSync(t.dir), []);
});

test('A11 size / list 语义不变：磁盘上内存没碰过的键不计入', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a');
  const d = t.disk();
  d.chats.Z = { sessionId: 'sid-z', at: 4 };
  t.write(d);
  assert.equal(s.size, 1, 'size 只算本进程管过的会话');
  assert.ok(!s.list().some((c) => c.chatId === 'Z'));
  s.set('D', 'sid-d');
  assert.equal(t.read().chats.Z?.sessionId, 'sid-z', '但落盘要保留 Z');
});

test('A12 保留 chats 之外的顶层字段（为 overrides 留位）', () => {
  const t = fresh();
  t.write({ chats: {}, overrides: { x: { mounts: ['a'] } } });
  const s = t.make();
  s.set('A', 'sid-a');
  const after = t.read();
  assert.deepEqual(after.overrides, { x: { mounts: ['a'] } });
  assert.equal(after.chats.A.sessionId, 'sid-a');
});

test('A13 损坏备份不堆积：最多留 3 份', () => {
  const t = fresh();
  for (let i = 0; i < 5; i += 1) {
    writeFileSync(t.file, `{bad${i}`, 'utf8');
    t.make();
  }
  const baks = readdirSync(t.dir).filter((n) => n.startsWith('sessions.json.corrupted.'));
  assert.ok(baks.length <= 3, `备份份数 ${baks.length} 应 ≤ 3`);
});

test('A14 forgetSession 走同一套删除路径（当次落盘就删干净）', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-x');
  s.set('B', 'sid-x');
  s.set('K', 'sid-keep');
  const n = s.forgetSession('sid-x');
  assert.equal(n, 2);
  /** 关键：删除当次写盘就要把两条从磁盘抹掉，不能靠"下次再说" */
  assert.equal(t.read().chats.A, undefined);
  assert.equal(t.read().chats.B, undefined);
  assert.equal(t.read().chats.K?.sessionId, 'sid-keep', '别的会话不受影响');
  assert.equal(s.get('A'), '');
  assert.equal(s.forgetSession('sid-x'), 0, '再删一次就没有了');
});

test('A15 patch 只补空字段、不动 sessionId，返回是否脏', () => {
  const t = fresh();
  const s = t.make();
  s.set('A', 'sid-a', { kind: 'group' });
  assert.equal(s.patch('A', { title: '群一', kind: 'c2c' }), true);
  const e = s.entry('A');
  assert.equal(e.title, '群一');
  assert.equal(e.kind, 'group', '已有字段不覆盖');
  assert.equal(e.sessionId, 'sid-a');
  assert.equal(s.patch('A', { title: '群一' }), false, '已存在就不脏');
  assert.equal(s.patch('nope', { title: 'x' }), false);
});

test('A16 重启后映射还在（最基本的那个诉求）', () => {
  const t = fresh();
  t.make().set('A', 'sid-a', { title: '群一', kind: 'group', preset: 'roost-social' });
  const s2 = t.make();
  assert.equal(s2.get('A'), 'sid-a');
  assert.equal(s2.entry('A')?.title, '群一');
  assert.equal(s2.size, 1);
});

/**
 * A17 空键一律不写。
 *
 * 真机现场（2026-11-17）：几处手写的 chat 字面量漏了 `sessionKey`，
 * `sessions.set(undefined, …)` 把键名落成了字符串 `"undefined"`。
 * 那个键谁都会命中，于是「她的短记」窗口里冒出了主动搭话的整段提示词，
 * 刷B站的结果也往同一个会话里塞——症状要到很久以后才看得出来。
 */
test('A17 空键不写盘，别把 undefined 变成公共槽位', () => {
  const t = fresh();
  const s = t.make();
  s.set(undefined, 'sid-x', { title: '她的短记', kind: 'system' });
  s.set(null, 'sid-y');
  s.set('', 'sid-z');
  assert.equal(s.size, 0, '一个都不该记下来');
  assert.deepEqual(t.disk().chats, {}, '磁盘上也不能出现 "undefined" / "null" / "" 键');
  assert.ok(t.logs.some((m) => /空键/.test(m)), '要留一条日志，别静默吞掉');
});

/** A18 键的兜底：有 sessionKey 用它，没有就用 chatId —— 手写字面量不会互相串 */
test('A18 chatSessionKey 优先 sessionKey，其次 chatId', () => {
  assert.equal(chatSessionKey({ sessionKey: 'guild:1', chatId: 'abc' }), 'guild:1');
  assert.equal(chatSessionKey({ chatId: 'system:bili' }), 'system:bili', '漏 sessionKey 时不能返回 undefined');
  assert.equal(chatSessionKey({}), '');
  assert.equal(chatSessionKey(null), '');
});

test('A8b 损坏文件：load 与首次 save 只隔离一份（不是两份副本）', () => {
  const t = fresh();
  writeFileSync(t.file, '{bad', 'utf8');
  const s = t.make();
  /** 触发一次写盘：以前 `save()` 会再隔离一份，同一个坏文件留两份副本 */
  s.set('g1', 'sid-1');
  const baks = readdirSync(t.dir).filter((n) => n.startsWith('sessions.json.corrupted.'));
  assert.equal(baks.length, 1, `只该留一份，实际 ${baks.length}`);
  assert.equal(t.logs.filter((m) => /损坏/.test(m)).length, 1, '日志也别重复');
});
