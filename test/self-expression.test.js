/**
 * 「她自己改资料」的配置与历史。
 *
 * 这个模块是**纯数据**：归一化、patch、冷却判断、历史读写。
 * 真正的写平台在工具层，所以这里能离线测——也正是为了离线测才把它拆出来。
 *
 * 重点守住三件事：
 *   1. 缺键/脏值进来，出去必须是结构完整的（面板和工具都直接读它）
 *   2. patch 是白名单，未知键**静默丢弃**（不能把配置写成垃圾场）
 *   3. 历史超过上限要丢最旧的，而不是无限长
 *
 * 跑法：node --test test/self-expression.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeSelfExpression, patchSelfExpression, cooldownCheck, waitText,
  createHistory, historyFileOf, MAX_HISTORY, MAX_COOLDOWN_MIN,
} from '../src/self-expression.js';

/** 每个用例一份独立目录：历史是有状态的，共用会互相污染 */
function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-selfexpr-'));
  /** Windows 上刚写完的文件偶尔还占着句柄，直接 rm 会 ENOTEMPTY —— 不是被测代码的问题 */
  return { dir, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test('N1 空配置归一化出完整结构', () => {
  const c = normalizeSelfExpression(undefined);
  assert.deepEqual(Object.keys(c).sort(), ['avatar', 'awareness', 'menu', 'name', 'proactive', 'sign']);
  for (const k of ['menu', 'sign', 'name', 'avatar']) {
    assert.equal(c[k].enabled, true, `${k} 默认应开`);
    assert.equal(c[k].cooldownMin, 0, `${k} 默认不限`);
  }
  assert.deepEqual(c.awareness, { mood: true, silence: true });
  assert.deepEqual(c.proactive, { enabled: false, fields: ['menu'] });
});

test('N2 只有明确 false 才算关，脏值当缺省', () => {
  const c = normalizeSelfExpression({
    menu: { enabled: false, cooldownMin: '30' },
    sign: { enabled: 0, cooldownMin: -5 },
    name: 'not-an-object',
    avatar: { enabled: null, cooldownMin: 'abc' },
  });
  assert.equal(c.menu.enabled, false);
  assert.equal(c.menu.cooldownMin, 30);
  /** `enabled: 0` 不是 false，按「没说」处理 → 开 */
  assert.equal(c.sign.enabled, true);
  /** 负数当 0（不限），不是「立刻可改」以外的语义 */
  assert.equal(c.sign.cooldownMin, 0);
  /** 整段不是对象 → 回落默认 */
  assert.equal(c.name.enabled, true);
  assert.equal(c.avatar.cooldownMin, 0);
});

test('N3 冷却夹到上限，防止一个十进制错误变成永远改不了', () => {
  const c = normalizeSelfExpression({ name: { cooldownMin: 99999999 } });
  assert.equal(c.name.cooldownMin, MAX_COOLDOWN_MIN);
});

test('P1 patch 只认白名单，未知键丢弃', () => {
  const cur = normalizeSelfExpression({});
  const next = patchSelfExpression(cur, {
    menu: { enabled: false, cooldownMin: 10, bogus: 'x' },
    name: { enabled: true },
    hacker: { enabled: false },
    proactive: { enabled: true, fields: ['menu', 'name', 'nope'] },
  });
  assert.equal(next.menu.enabled, false);
  assert.equal(next.menu.cooldownMin, 10);
  assert.equal('bogus' in next.menu, false);
  assert.equal('hacker' in next, false);
  assert.deepEqual(next.proactive.fields, ['menu', 'name'], '非法出口被过滤，名字去重保序');
  /** 没提到的字段保持原值 */
  assert.equal(next.sign.enabled, true);
});

test('P2 patch 不会把 false 写成字符串 "false" 的反面', () => {
  const next = patchSelfExpression(normalizeSelfExpression({}), { avatar: { enabled: 'false' } });
  /** 只有真正的 false 才关；字符串 'false' 不是 false → 开（宁可放行可回滚的那类） */
  assert.equal(next.avatar.enabled, true);
});

test('P3 proactive.fields 空数组合法（等于什么都不让她自己动）', () => {
  const next = patchSelfExpression(normalizeSelfExpression({}), { proactive: { fields: [] } });
  assert.deepEqual(next.proactive.fields, []);
});

test('C1 冷却 0 = 不检查；有值才按时间算', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(cooldownCheck(0, 0, now), { ok: true, waitMs: 0 });
  assert.deepEqual(cooldownCheck(now - 1000, 0, now), { ok: true, waitMs: 0 });
  /** 30 分钟冷却，刚过 1 分钟 → 还差 29 分钟 */
  assert.deepEqual(cooldownCheck(now - 60_000, 30, now), { ok: false, waitMs: 29 * 60_000 });
  /** 已经超过冷却 */
  assert.deepEqual(cooldownCheck(now - 31 * 60_000, 30, now), { ok: true, waitMs: 0 });
});

test('C2 等待文案不报小数分钟', () => {
  assert.equal(waitText(20_000), '1 分钟');
  assert.equal(waitText(37 * 60_000), '37 分钟');
  assert.equal(waitText(3 * 3600_000), '3 小时');
  assert.equal(waitText(72 * 3600_000), '3 天');
});

test('H1 历史追加后能读回，新的在后', () => {
  const { dir, done } = fresh();
  try {
    const h = createHistory({ dataDir: () => dir, now: () => 1000 });
    h.push({ kind: 'sign', before: '旧', after: '新' });
    h.push({ kind: 'name', before: { name: 'A', selfName: 'A', personaId: 'p' }, after: { name: 'B' } });
    const rows = h.read();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, 'sign');
    assert.equal(rows[1].kind, 'name');
    assert.equal(rows[1].before.selfName, 'A', '昵称的快照必须带 selfName，否则回滚会破坏一致性');
  } finally { done(); }
});

test('H2 超过上限丢最旧的', () => {
  const { dir, done } = fresh();
  try {
    const h = createHistory({ dataDir: () => dir });
    for (let i = 0; i < MAX_HISTORY + 5; i += 1) {
      h.push({ kind: 'menu', before: `b${i}`, after: `a${i}` });
    }
    const rows = h.read();
    assert.equal(rows.length, MAX_HISTORY);
    assert.equal(rows[0].before, 'b5', '最旧 5 条被丢掉');
  } finally { done(); }
});

test('H3 失败记录也留（要能回答"为什么没改成功"）', () => {
  const { dir, done } = fresh();
  try {
    const h = createHistory({ dataDir: () => dir });
    h.push({ kind: 'sign', ok: false, note: '未登录' });
    assert.equal(h.read().length, 1);
    /** 但 lastOf（回滚用）要跳过失败记录 */
    assert.equal(h.lastOf('sign'), null);
  } finally { done(); }
});

test('H4 lastAt 跳过失败记录，按 kind 各算各的', () => {
  const { dir, done } = fresh();
  try {
    let t = 1000;
    const h = createHistory({ dataDir: () => dir, now: () => t });
    h.push({ kind: 'sign', at: 5000, before: 'a', after: 'b' });
    h.push({ kind: 'sign', at: 9000, ok: false, before: 'b', after: 'c' });
    h.push({ kind: 'name', at: 7000, before: 'x', after: 'y' });
    assert.equal(h.lastAt('sign'), 5000);
    assert.equal(h.lastAt('name'), 7000);
    /** 不传 kind：取最近一条**成功**的（9000 那条是失败的，要跳过） */
    assert.equal(h.lastAt(), 7000);
  } finally { done(); }
});

test('H5 坏文件当空，不让面板打不开', () => {
  const { dir, done } = fresh();
  try {
    writeFileSync(historyFileOf(dir), '{ this is not json', 'utf8');
    const h = createHistory({ dataDir: () => dir });
    assert.deepEqual(h.read(), []);
    /** 而且还能继续写（覆盖掉坏内容） */
    h.push({ kind: 'menu', before: 'x', after: 'y' });
    const raw = JSON.parse(readFileSync(historyFileOf(dir), 'utf8'));
    assert.equal(raw.entries.length, 1);
  } finally { done(); }
});

test('H6 清空后文件还在、只是空表', () => {
  const { dir, done } = fresh();
  try {
    const h = createHistory({ dataDir: () => dir });
    h.push({ kind: 'avatar', before: { url: 'u1' }, after: { url: 'u2' } });
    assert.equal(h.clear(), true);
    assert.deepEqual(h.read(), []);
    const raw = JSON.parse(readFileSync(historyFileOf(dir), 'utf8'));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.entries, []);
  } finally { done(); }
});
