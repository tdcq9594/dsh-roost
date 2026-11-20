// 压缩开场的持久化暂存。
//
// 三条最要紧：
//   1. **重启后开场还能拼出来**（否则映射指向新会话、开场没了 = 失忆）；
//   2. **取走即删**（否则同一段开场会被重复拼进每一轮）；
//   3. **盘上只有指针**（`{ at }`），正文一个字都不落盘——正文是从日记
//      确定性重建的，存一份只会让「清空记忆」清不干净。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPendingOpenings } from '../src/pending-opening.js';

const HOUR = 3_600_000;

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'pending-opening-')), 'opening-pending.json');
}

/** 重启后的正文来源：测试里固定回一个串，便于断言「走的是重建而不是盘上正文」 */
const fixed = (text) => (chatId) => `${text}:${chatId}`;

test('开场：set 之后 get 得到，take 之后就没有了', () => {
  const p = createPendingOpenings({ file: tmpFile() });
  p.set('c1', '（接着上面继续聊）');
  assert.equal(p.get('c1'), '（接着上面继续聊）');
  assert.equal(p.take('c1'), '（接着上面继续聊）');
  assert.equal(p.get('c1'), '');
  assert.equal(p.size, 0);
});

test('开场：重启后还能拼出来（映射已落盘、开场不能只活在内存里）', () => {
  const file = tmpFile();
  createPendingOpenings({ file }).set('c1', '开场 A');

  const calls = [];
  const again = createPendingOpenings({
    file,
    rebuild: (chatId) => { calls.push(chatId); return '重建的开场'; },
  });
  assert.equal(again.get('c1'), '重建的开场');
  assert.deepEqual(calls, ['c1'], '重启后必须走重建');
});

test('开场：**盘上不存正文**（清空日记后重建为空，不能还留着聊天片段）', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', '用户原话：我下周要去杭州出差');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.version, 2);
  assert.ok(raw.chats.c1.at > 0, '指针要带时间戳（TTL 用）');
  assert.equal(raw.chats.c1.text, undefined, '正文绝不能落盘');
  assert.ok(!readFileSync(file, 'utf8').includes('杭州'), '盘上不该出现聊天原文');

  /** 日记被清掉之后重建为空：开场就没有了，指针也顺手删掉 */
  const after = createPendingOpenings({ file, rebuild: () => '' });
  assert.equal(after.take('c1'), '');
  assert.equal(after.size, 0, '拼不出内容的指针不该留着');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).chats.c1, undefined);
});

test('开场：重建抛错时**保留指针**（一次瞬时读故障不能变成永久失忆）', () => {
  const file = tmpFile();
  createPendingOpenings({ file }).set('c1', '开场 A');
  const again = createPendingOpenings({
    file,
    log: () => {},
    rebuild: () => { throw new Error('日记打不开'); },
  });
  assert.equal(again.get('c1'), '', '这次看不到');
  assert.equal(again.take('c1'), '', '这次拿不到');
  assert.equal(again.size, 1, '指针必须留着，下一条消息还能再试');
  /** 日记恢复之后，同一个指针还能拼出来 */
  const healed = createPendingOpenings({ file, rebuild: () => '恢复后的开场' });
  assert.equal(healed.take('c1'), '恢复后的开场');
});

test('开场：没有 rebuild 时重启后读不到正文（不假装有）', () => {
  const file = tmpFile();
  createPendingOpenings({ file }).set('c1', '开场 A');
  assert.equal(createPendingOpenings({ file }).get('c1'), '');
});

test('开场：取走之后重启不再出现（不能重复拼开场）', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', '开场 A');
  assert.equal(p.take('c1'), '开场 A');

  assert.equal(createPendingOpenings({ file, rebuild: fixed('重建') }).get('c1'), '');
});

test('开场：不同会话互不覆盖', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', 'A');
  p.set('c2', 'B');
  assert.equal(p.get('c1'), 'A');
  assert.equal(p.get('c2'), 'B');
});

test('开场：同一会话重复 set 以最后一次为准', () => {
  const p = createPendingOpenings({ file: tmpFile() });
  p.set('c1', '旧');
  p.set('c1', '新');
  assert.equal(p.get('c1'), '新');
});

test('开场：空键/空文本不写（避免污染公共槽位）', () => {
  const p = createPendingOpenings({ file: tmpFile() });
  p.set('', 'x');
  p.set('c1', '');
  assert.equal(p.size, 0);
});

test('开场：超过 24 小时未消费就丢弃', () => {
  const file = tmpFile();
  let t = 1_000_000;
  const p = createPendingOpenings({ file, now: () => t });
  p.set('c1', '旧开场');
  t += 25 * HOUR;

  const again = createPendingOpenings({ file, now: () => t, rebuild: fixed('重建') });
  assert.equal(again.get('c1'), '', '过期条目连指针都不该留');
  assert.equal(again.size, 0);
});

test('开场：损坏文件不抛错，且先备份再降级', () => {
  const file = tmpFile();
  writeFileSync(file, '{ 这不是 JSON', 'utf8');

  const p = createPendingOpenings({ file });
  assert.equal(p.size, 0);
  const baks = readdirSync(join(file, '..')).filter((n) => n.includes('.corrupted.'));
  assert.equal(baks.length, 1);
});

test('开场：写盘是完整 JSON，且只有指针', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('c1', '开场');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw.chats.c1), ['at']);
});

test('开场：超过上限时淘汰最旧的，不无限增长', () => {
  const file = tmpFile();
  let t = 1_000_000;
  const p = createPendingOpenings({ file, now: () => t });
  for (let i = 0; i < 60; i += 1) {
    t += 1;
    p.set(`c${i}`, `开场 ${i}`);
  }
  assert.equal(p.size, 50);
  assert.equal(p.get('c0'), '');
  assert.equal(p.get('c59'), '开场 59');
  /** 盘上也只能有 50 条指针 */
  assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).chats).length, 50);
});

test('开场：盘上是 {"chats":[]} 时不能静默永久失忆', () => {
  const file = tmpFile();
  writeFileSync(file, '{"chats":[]}', 'utf8');

  const p = createPendingOpenings({ file });
  p.set('c1', '开场 A');
  /** 数组也是 object：漏判会让 map 变数组，字符串键被 JSON.stringify 丢掉 */
  const again = createPendingOpenings({ file, rebuild: fixed('重建') });
  assert.equal(again.size, 1, '键不能丢');
  assert.equal(again.get('c1'), '重建:c1');
});

test('开场：旧格式（带 text）读进来只留 at，正文不再上盘', () => {
  const file = tmpFile();
  writeFileSync(
    file,
    JSON.stringify({ chats: { c1: { text: '旧正文，不该被读回来', at: Date.now() } } }),
    'utf8',
  );
  const p = createPendingOpenings({ file, rebuild: () => '重建的' });
  /** 旧正文被丢掉，走重建——这正是「盘上只存指针」想要的迁移结果 */
  assert.equal(p.take('c1'), '重建的');
});

test('开场：旧格式读到就立刻回写，别让正文在盘上躺到 TTL', () => {
  const file = tmpFile();
  writeFileSync(
    file,
    JSON.stringify({ chats: { c1: { text: '旧正文，不该留在盘上', at: Date.now() } } }),
    'utf8',
  );
  /** 只是构造一下，不 set / 不 take：光「启动」就该把正文抹掉 */
  createPendingOpenings({ file, rebuild: () => '重建的' });
  assert.ok(!readFileSync(file, 'utf8').includes('旧正文'), '启动时就要迁移落盘');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).chats.c1), ['at']);
});

test('开场：没有 rebuild 时旧正文留在内存里（删了就回不来）', () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ chats: { c1: { text: '旧正文', at: Date.now() } } }), 'utf8');
  const p = createPendingOpenings({ file });
  assert.equal(p.take('c1'), '旧正文', '不能重建就把正文留着用');
});

test('开场：损坏备份最多留 3 份（不能每次启动都新增）', () => {
  const file = tmpFile();
  writeFileSync(file, '坏文件', 'utf8');
  for (let i = 0; i < 6; i += 1) createPendingOpenings({ file });

  const baks = readdirSync(join(file, '..')).filter((n) => n.includes('.corrupted.'));
  assert.ok(baks.length <= 3, `备份 ${baks.length} 份，应 ≤3`);
});

test('开场：读盘失败时仍写内存（不能把读故障升级成当场失忆）', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pending-opening-')), 'opening-pending.json');
  /** 用目录占住文件名：readFileSync 会报 EISDIR，触发 ioFailed */
  mkdirSync(file);

  const p = createPendingOpenings({ file });
  p.set('c1', '开场 A');
  assert.equal(p.get('c1'), '开场 A');
  assert.equal(p.take('c1'), '开场 A');
});

test('开场：__proto__ 当普通键处理，不能变成原型上的幽灵条目', () => {
  const file = tmpFile();
  const p = createPendingOpenings({ file });
  p.set('__proto__', 'payload');

  assert.equal(p.size, 1);
  assert.equal(p.get('__proto__'), 'payload');
  /** 重启读回也不能走原型链：指针在，正文靠重建 */
  const again = createPendingOpenings({ file, rebuild: fixed('重建') });
  assert.equal(again.size, 1);
  assert.equal(again.get('__proto__'), '重建:__proto__');
  assert.equal(p.take('__proto__'), 'payload');
  assert.equal(p.size, 0);
});

test('开场：文件损坏降级后，__proto__ 也不能变幽灵', () => {
  const file = tmpFile();
  writeFileSync(file, '这不是 JSON', 'utf8');

  const p = createPendingOpenings({ file });
  p.set('__proto__', 'GHOST');
  assert.equal(p.size, 1);
  assert.equal(p.get('__proto__'), 'GHOST');
  assert.equal(p.take('__proto__'), 'GHOST');
});

test('开场：迁移那次启动也要清理过期条目（`||` 短路会漏掉）', () => {
  const file = tmpFile();
  const t = Date.now();
  writeFileSync(
    file,
    JSON.stringify({ chats: { c1: { text: '旧正文', at: t }, old: { at: 1 } } }),
    'utf8',
  );
  /**
   * 写成 `if (needMigrate || prune()) save()` 时 `prune()` 会被短路，
   * 迁移那次启动不但不清理过期条目，还会把它原样写回去。
   */
  createPendingOpenings({ file, rebuild: () => '重建的', now: () => t });
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.chats.old, undefined, '过期条目必须清掉');
  assert.deepEqual(Object.keys(disk.chats.c1), ['at'], '迁移与清理要一次做完');
});
