// A1 审计日志查询的单测：真行为，不断言源码文本。
//
// 对齐 Hindsight `/audit-logs` 的查询形态：按 op/时间过滤 + limit/offset 分页，
// 最新在前。我方额外两条铁律：读侧再脱敏一次、只扫末尾窗口（不全量读）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { queryAudit } = await import('../src/audit-query.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roost-audit-query-'));
const file = path.join(tmp, 'audit.log');
const now = 1_700_000_000_000;

function write(rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

test('A1-1 最新在前；op / chatId 精确过滤', () => {
  write([
    { at: now, op: 'memory.clear', chatId: 'g1' },
    { at: now + 1, op: 'memory.mute', chatId: 'g2' },
    { at: now + 2, op: 'memory.clear', chatId: 'g2' },
  ]);
  const all = queryAudit({ file });
  assert.deepEqual(all.rows.map((r) => r.op), ['memory.clear', 'memory.mute', 'memory.clear']);
  assert.equal(all.total, 3);
  assert.equal(all.scanned, 3);
  assert.deepEqual(queryAudit({ file, op: 'memory.clear' }).rows.map((r) => r.chatId), ['g2', 'g1']);
  assert.deepEqual(queryAudit({ file, chatId: 'g2' }).rows.map((r) => r.at), [now + 2, now + 1]);
});

test('A1-2 since/until 左闭右开（和 Hindsight start_date/end_date 同口径）', () => {
  write([
    { at: now, op: 'a' }, { at: now + 1, op: 'b' }, { at: now + 2, op: 'c' },
  ]);
  assert.deepEqual(queryAudit({ file, since: now + 1, until: now + 2 }).rows.map((r) => r.op), ['b']);
  assert.equal(queryAudit({ file, until: now }).total, 0);
});

test('A1-3 limit/offset 分页，limit 夹到上限', () => {
  write(Array.from({ length: 6 }, (_, i) => ({ at: now + i, op: 'x', note: String(i) })));
  const p1 = queryAudit({ file, limit: 2 });
  const p2 = queryAudit({ file, limit: 2, offset: 2 });
  assert.deepEqual(p1.rows.map((r) => r.note), ['5', '4']);
  assert.deepEqual(p2.rows.map((r) => r.note), ['3', '2']);
  assert.equal(p1.total, 6, 'total 是过滤后总数，不是本页数');
  assert.ok(queryAudit({ file, limit: 99999 }).rows.length <= 500);
});

test('A1-4 读侧再脱敏：历史日志里的裸 token 不会显示到面板', () => {
  fs.writeFileSync(file, JSON.stringify({
    at: now, op: 'ext.token_regenerated', note: 'Authorization: Bearer abcd1234efgh5678', chatId: 'Bearer token=abcdefgh12345678',
  }) + '\n', 'utf8');
  const [row] = queryAudit({ file }).rows;
  assert.ok(!row.note.includes('abcd1234efgh5678'), 'note 脱敏');
  assert.ok(!row.chatId.includes('abcdefgh12345678'), 'chatId 同样脱敏（E7 口径）');
  assert.ok(row.note.includes('***'));
});

test('A1-5 坏行跳过不挂；空文件/缺文件给空结果', () => {
  fs.writeFileSync(file, ['{坏 JSON', JSON.stringify({ at: now, op: 'ok' }), 'null', '[1,2]'].join('\n') + '\n', 'utf8');
  const r = queryAudit({ file });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].op, 'ok');
  assert.deepEqual(queryAudit({ file: path.join(tmp, 'nope.log') }).rows, []);
});

test('A1-6 大文件只读末尾窗口，并如实标记 truncated', () => {
  // 先写超过 256KB 的噪音，再在末尾写一条目标行
  fs.writeFileSync(file, 'x'.repeat(257 * 1024) + '\n' + JSON.stringify({ at: now, op: 'target' }) + '\n', 'utf8');
  const r = queryAudit({ file, op: 'target' });
  assert.equal(r.total, 1, '末尾的目标行能查到');
  assert.equal(r.truncated, true, '前面的老日志看不到，要明确告诉用户');
  assert.ok(r.scanned < 50, '没有全量扫文件');
});

test('A1-7 白名单字段：多传的秘密字段不透出', () => {
  fs.writeFileSync(file, JSON.stringify({ at: now, op: 'x', arg: '不该透出', secret: 's3cr3t' }) + '\n', 'utf8');
  const [row] = queryAudit({ file }).rows;
  assert.ok(!('arg' in row));
  assert.ok(!('secret' in row));
});

test('A1-8 查询是纯读：不改源文件一个字节', () => {
  write([{ at: now, op: 'a' }]);
  const before = fs.readFileSync(file);
  queryAudit({ file, op: 'a' });
  assert.deepEqual(fs.readFileSync(file), before);
});
