// 她的小闹钟 · 数据层（A1）：照对方口径验校验/上限/兼容/重试状态机。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createReminderStore, parseReminderTime, reminderText, normalizeReminder,
  REMINDER_GRACE_MS, REMINDER_RETRY_MS,
} from '../src/reminder-store.js';

test('时间解析：严格格式、拒绝溢出日期、格式化回原文', () => {
  const at = parseReminderTime('2026-11-26 17:30');
  assert.ok(at > 0);
  assert.equal(reminderText(at), '2026-11-26 17:30');
  assert.equal(parseReminderTime('2026-02-30 10:00'), 0, '2月30日不存在');
  assert.equal(parseReminderTime('2026-11-26'), 0);
  assert.ok(parseReminderTime('2026-11-26T17:30') > 0, 'T 分隔也认');
});

test('normalizeReminder：脏数据丢掉，字段钳制', () => {
  assert.equal(normalizeReminder(null), null);
  assert.equal(normalizeReminder({ id: '', at: 1, note: 'x' }), null);
  assert.equal(normalizeReminder({ id: 'a', at: NaN, note: 'x' }), null);
  const r = normalizeReminder({ id: 'a', at: 1000, note: ' x '.repeat(300), attempts: -5 });
  assert.equal(r.note.length, 500, 'note 截到 500');
  assert.equal(r.attempts, 0, 'attempts 不为负');
  assert.ok(r.expiresAt > r.at);
});

test('add 校验：格式/过去/空 note/上限', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    assert.match(s.add('bad', 'note', { at: now }).message, /格式不对/);
    assert.match(s.add('2026-11-24 10:00', 'note', { at: now }).message, /过去了/);
    assert.match(s.add('2026-11-26 10:00', '  ', { at: now }).message, /note/);
    const r = s.add('2026-11-26 10:00', '提醒我', { at: now });
    assert.equal(r.ok, true);
    assert.equal(r.id, 'id1');
    assert.match(s.add('2026-11-27 10:00', '第二条', { at: now, limit: 1 }).message, /太多/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('close / prune：关掉即无、过期自动清', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    let now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    s.add('2026-11-26 10:00', '提醒我', { at: now });
    assert.equal(s.list(now).length, 1);
    s.close('nope').ok === false && assert.equal(s.close('nope').ok, false, '关不存在的报错');
    s.close('id1');
    assert.equal(s.list(now).length, 0);

    const dueAt = parseReminderTime('2026-11-26 10:00');
    s.add('2026-11-26 10:00', '会过期的', { at: now });
    now = dueAt + REMINDER_GRACE_MS + 1;
    assert.equal(s.list(now).length, 0, '过宽限期自动清掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fail 重试状态机：首次失败延宽限期、耗尽则放弃', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    let now = new Date('2026-11-25T00:00:00').getTime();
    const s = createReminderStore({ file, now: () => now, newId: () => 'id1' });
    s.add('2026-11-25T00:00:00'.replace('T', ' ').slice(0, 16), '到点了', { at: now - 1000 });
    const r1 = s.fail('id1', '超时', now);
    assert.equal(r1.drop, false);
    assert.equal(r1.reminder.attempts, 1);
    assert.equal(r1.reminder.nextAt, now + REMINDER_RETRY_MS);
    // 推进到接近宽限期尽头：再失败应放弃
    now += REMINDER_GRACE_MS - REMINDER_RETRY_MS;
    const r2 = s.fail('id1', '又失败', now);
    assert.equal(r2.drop, true, '重试窗口耗尽则放弃');
    assert.equal(s.list(now).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy 兼容：新文件不存在时只读旧文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  try {
    const file = join(dir, 'reminders.json');
    const legacy = join(dir, 'speakup-reminders.json');
    writeFileSync(legacy, JSON.stringify([{ id: 'old', at: Date.now() + 60000, note: '老提醒' }]), 'utf8');
    const s = createReminderStore({ file, legacyFile: legacy });
    assert.equal(s.list().length, 1);
    assert.equal(s.list()[0].id, 'old');
    assert.equal(existsLegacyUntouched(file), false, '新文件还没建');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function existsLegacyUntouched(file) {
  try { readFileSync(file); return true; } catch { return false; }
}
