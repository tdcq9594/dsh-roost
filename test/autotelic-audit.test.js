// 自驱会话审计：只记自驱会话、危险工具第二道门、写路径限制、哈希链校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditor, isAutotelicChat, verifyAuditChain, AUTOTELIC_CHAT_PREFIX } from '../src/autotelic-audit.js';

const chatOf = (sid) => (sid === 'self-session' ? `${AUTOTELIC_CHAT_PREFIX}:main` : 'c2c:owner');
const isOwned = () => true;
const mk = (dir, over = {}) => createAuditor({
  dir, chatOfSession: chatOf, isOwnedSession: isOwned,
  now: () => new Date('2026-01-15T10:00:00Z'), flushMs: 10, log: {},
  ownRoot: join(dir, 'own'), ...over,
});

test('isAutotelicChat：只认自驱前缀', () => {
  assert.equal(isAutotelicChat(`${AUTOTELIC_CHAT_PREFIX}:main`), true);
  assert.equal(isAutotelicChat('c2c:owner'), false);
});

test('record：非自驱会话不记（关键过滤）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au-'));
  try {
    const a = mk(dir);
    await a.preExecute({ agent: { session: { id: 'owner-session' } }, name: 'read', arguments: {} }, async () => ({ kind: 'ok' }));
    await a.flush();
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch {}
    assert.equal(files.length, 0, '主人会话的工具调用不该进她的审计');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preExecute：她的会话调 shell 被拒并留痕', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au2-'));
  try {
    const a = mk(dir);
    const r = await a.preExecute({ agent: { session: { id: 'self-session' } }, name: 'bash', arguments: { cmd: 'rm -rf /' } }, async () => ({ kind: 'ok' }));
    assert.equal(r.kind, 'deny');
    assert.match(r.reason, /不在你的动作菜单/);
    await a.flush();
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length > 0, '拒绝也要留痕');
    assert.match(readFileSync(join(dir, files[0]), 'utf8'), /tool\/denied/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preExecute：写工具落到自己目录外被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au3-'));
  try {
    const a = mk(dir);
    const bad = await a.preExecute({
      agent: { session: { id: 'self-session' } }, name: 'write',
      arguments: { file_path: 'C:/Windows/system32/evil.dll' },
    }, async () => ({ kind: 'ok' }));
    assert.equal(bad.kind, 'deny');
    assert.match(bad.reason, /只能写你自己数据目录/);

    const good = await a.preExecute({
      agent: { session: { id: 'self-session' } }, name: 'write',
      arguments: { file_path: join(dir, 'own', 'notes', 'a.md') },
    }, async () => ({ kind: 'ok' }));
    assert.notEqual(good.kind, 'deny', '自己目录里要放行');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preExecute：只读工具正常放行且记一条 tool/call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au4-'));
  try {
    const a = mk(dir);
    let called = false;
    const r = await a.preExecute({ agent: { session: { id: 'self-session' } }, name: 'read', arguments: { path: 'x' } }, async () => { called = true; return { kind: 'ok' }; });
    assert.equal(called, true, '必须继续执行');
    assert.notEqual(r?.kind, 'deny');
    await a.flush();
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.match(readFileSync(join(dir, files[0]), 'utf8'), /tool\/call/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verifyAuditChain：完好链通过，改一行被抓', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au5-'));
  try {
    const a = mk(dir);
    await a.preExecute({ agent: { session: { id: 'self-session' } }, name: 'read', arguments: {} }, async () => ({ kind: 'ok' }));
    await a.preExecute({ agent: { session: { id: 'self-session' } }, name: 'read', arguments: {} }, async () => ({ kind: 'ok' }));
    await a.flush();
    const ok = await verifyAuditChain(dir);
    assert.equal(ok.ok, true, JSON.stringify(ok.brokenAt));
    assert.ok(ok.total >= 2);

    /** 改一个字节：哈希对不上 */
    const f = readdirSync(dir).filter((x) => x.endsWith('.jsonl'))[0];
    const p = join(dir, f);
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const rec = JSON.parse(lines[0]);
    rec.tool = 'tampered';
    lines[0] = JSON.stringify(rec);
    writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    const bad = await verifyAuditChain(dir);
    assert.equal(bad.ok, false);
    assert.match(bad.brokenAt.reason, /哈希对不上/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('note：模块侧显式记账进审计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'au6-'));
  try {
    const a = mk(dir);
    a.note({ kind: 'autotelic/tune', args: { maxPerDay: 3 }, outcome: '调参' });
    await a.flush();
    const f = readdirSync(dir).filter((x) => x.endsWith('.jsonl'))[0];
    assert.match(readFileSync(join(dir, f), 'utf8'), /autotelic\/tune/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
