// 对话收尾（第 1 条）的测试。
//
// 这块的坑跟 mood 一样：**算错了不会有报错，只会表现成"她刚说完晚安又冒出来"**。
// 所以断言都盯状态和边界（过期、冷却、群里拒绝），不盯返回值好不好看。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseClose,
  looksLikeQuestion,
  acceptClose,
  coolMs,
  createClosing,
  DEFAULTS,
} from '../src/closing.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 每个用例一个干净的 data 目录（dataDir() 每次读 env，所以换 env 就够） */
function fresh() {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-close-'));
  return createClosing();
}

/* ---------------- 标记解析 ---------------- */

test('parseClose：竖线分两段', () => {
  const r = parseClose('聊到她说要去睡了 | 明天问她睡得好不好');
  assert.equal(r.point, '聊到她说要去睡了');
  assert.equal(r.resume, '明天问她睡得好不好');
});

test('parseClose：中文竖线也认', () => {
  const r = parseClose('在聊考研的事｜下次问问出分没');
  assert.equal(r.point, '在聊考研的事');
  assert.equal(r.resume, '下次问问出分没');
});

test('parseClose：没竖线时整段当「收在哪」', () => {
  const r = parseClose('聊完了一个话题，对方说要去看书');
  assert.equal(r.point, '聊完了一个话题，对方说要去看书');
  assert.equal(r.resume, '');
});

test('parseClose：空内容返回两个空串，不抛', () => {
  assert.deepEqual(parseClose(''), { point: '', resume: '' });
  assert.deepEqual(parseClose(null), { point: '', resume: '' });
});

/* ---------------- 提问判定 ---------------- */

test('looksLikeQuestion：问号结尾算提问', () => {
  assert.equal(looksLikeQuestion('这个怎么弄？'), true);
  assert.equal(looksLikeQuestion('真的吗?'), true);
  assert.equal(looksLikeQuestion(' 还在吗 ？  '), true);
});

test('looksLikeQuestion：明确疑问词算提问（没问号也算）', () => {
  assert.equal(looksLikeQuestion('你帮我看看这个报错'), true);
  assert.equal(looksLikeQuestion('为什么会这样'), true);
  assert.equal(looksLikeQuestion('能不能再讲一遍'), true);
});

test('looksLikeQuestion：普通陈述不算提问', () => {
  assert.equal(looksLikeQuestion('我去睡了'), false);
  assert.equal(looksLikeQuestion('今天好累啊'), false);
  assert.equal(looksLikeQuestion('晚安'), false);
  assert.equal(looksLikeQuestion(''), false);
});

/* ---------------- 接不接受这次收尾（宿主侧三条闸门） ---------------- */

test('acceptClose：私聊 + 有内容 + 对方没提问 → 接受', () => {
  const r = acceptClose({ point: '聊到他要睡了', kind: 'c2c', said: '我先去睡啦' });
  assert.equal(r.ok, true);
});

test('acceptClose：群聊一律拒（只做私聊）', () => {
  const r = acceptClose({ point: '群里聊完了', kind: 'group', said: '散了吧' });
  assert.equal(r.ok, false);
  assert.match(r.why, /私聊/);
});

test('acceptClose：没写「收在哪」就拒', () => {
  assert.equal(acceptClose({ point: '   ', kind: 'c2c' }).ok, false);
  assert.equal(acceptClose({ kind: 'c2c' }).ok, false);
});

test('acceptClose：对方还在提问时拒——问题没答完不能跑', () => {
  const r = acceptClose({ point: '聊到报错', kind: 'c2c', said: '这个报错怎么修？' });
  assert.equal(r.ok, false);
  assert.match(r.why, /提问/);
});

test('acceptClose：不传 kind 时按群聊拒（安全默认）', () => {
  const r = acceptClose({ point: '什么都没说' });
  assert.equal(r.ok, false);
  assert.match(r.why, /私聊/);
});

/* ---------------- 存取 ---------------- */

test('set / get：基本往返', () => {
  const c = fresh();
  const r = c.set('u1', { point: '聊到要去睡了', resume: '明天问睡得好不好', why: '自然收尾' });
  assert.equal(r.ok, true);

  const rec = c.get('u1');
  assert.equal(rec.point, '聊到要去睡了');
  assert.equal(rec.resume, '明天问睡得好不好');
  assert.equal(rec.why, '自然收尾');
  assert.ok(rec.at > 0);
});

test('set：同一个会话是覆盖，不是追加', () => {
  const c = fresh();
  c.set('u1', { point: '第一次收尾' });
  c.set('u1', { point: '第二次收尾' });
  assert.equal(c.get('u1').point, '第二次收尾');
  assert.equal(c.stat().total, 1);
});

test('set：群聊直接拒绝（只做私聊）', () => {
  const c = fresh();
  const r = c.set('g1', { point: '群里收尾', kind: 'group' });
  assert.equal(r.ok, false);
  assert.match(r.why, /群/);
  assert.equal(c.get('g1'), null);
});

test('set：没写「收在哪」就拒绝——空收尾没有意义', () => {
  const c = fresh();
  const r = c.set('u1', { point: '   ' });
  assert.equal(r.ok, false);
  assert.equal(c.get('u1'), null);
});

test('get：不存在的会话返回 null', () => {
  const c = fresh();
  assert.equal(c.get('nobody'), null);
});

test('clear：清掉之后 get 为 null', () => {
  const c = fresh();
  c.set('u1', { point: '聊完了' });
  assert.equal(c.clear('u1'), true);
  assert.equal(c.get('u1'), null);
  assert.equal(c.clear('u1'), false); // 再清一次返回 false，不抛
});

/* ---------------- 注入 ---------------- */

test('text：没有记录返回空串（不注入废话）', () => {
  const c = fresh();
  assert.equal(c.text('u1'), '');
});

test('text：有记录时包含两段和「不用重新自我介绍」', () => {
  const c = fresh();
  c.set('u1', { point: '聊到考研出分', resume: '问问考得怎么样' });
  const t = c.text('u1');
  assert.match(t, /【上次这段聊到】/);
  assert.match(t, /收在：聊到考研出分/);
  assert.match(t, /可以这么接：问问考得怎么样/);
  assert.match(t, /不用重新自我介绍/);
});

test('text：没有 resume 时不出现「可以这么接」', () => {
  const c = fresh();
  c.set('u1', { point: '就聊到这里' });
  const t = c.text('u1');
  assert.doesNotMatch(t, /可以这么接/);
});

test('text：超过 ttlDays 就不再注入——太旧的接不上', () => {
  const c = fresh();
  c.set('u1', { point: '很久以前收的尾' });
  // 手动把时间推到 8 天前（ttlDays 默认 7）
  const db = JSON.parse(JSON.stringify(c.get('u1')));
  db.at = Date.now() - 8 * DAY;
  // 直接改文件，模拟"放了很久"
  writeFileSync(join(process.env.DSH_ROOST_DATA, 'closing.json'), JSON.stringify({ chats: { u1: db } }));
  const c2 = createClosing();
  assert.equal(c2.get('u1'), null);
  assert.equal(c2.text('u1'), '');
});

/* ---------------- 冷却（给 awake 用的刹车） ---------------- */

test('coolingDown：刚收完尾是 true', () => {
  const c = fresh();
  c.set('u1', { point: '晚安' });
  assert.equal(c.coolingDown('u1'), true);
});

test('coolingDown：过了 coolMinutes 就是 false', () => {
  const c = fresh();
  c.set('u1', { point: '晚安' });
  const later = Date.now() + (DEFAULTS.coolMinutes + 1) * MINUTE;
  assert.equal(c.coolingDown('u1', later), false);
});

test('coolingDown：没记录过是 false（不能拦正常搭话）', () => {
  const c = fresh();
  assert.equal(c.coolingDown('nobody'), false);
});

test('coolMs：配置能改冷却时长', () => {
  assert.equal(coolMs({ coolMinutes: 30 }), 30 * MINUTE);
  assert.equal(coolMs({}), DEFAULTS.coolMinutes * MINUTE);
  assert.equal(coolMs({ coolMinutes: -5 }), 0); // 负数当 0，不出现"负冷却"
});

/* ---------------- 清理 ---------------- */

test('prune：清掉过期记录，保留新鲜的', () => {
  const c = fresh();
  c.set('old', { point: '很旧的' });
  c.set('new', { point: '新鲜的' });

  // 把 old 推到 30 天前
  const p = join(process.env.DSH_ROOST_DATA, 'closing.json');
  const db = JSON.parse(readFileSync(p, 'utf8'));
  db.chats.old.at = Date.now() - 30 * DAY;
  writeFileSync(p, JSON.stringify(db));

  const c2 = createClosing();
  c2.prune();
  assert.equal(c2.get('old'), null);
  assert.equal(c2.get('new').point, '新鲜的');
});

test('stat：只数还活着的记录', () => {
  const c = fresh();
  assert.equal(c.stat().total, 0);
  c.set('u1', { point: 'a' });
  c.set('u2', { point: 'b' });
  assert.equal(c.stat().total, 2);
});

test('enabled=false 时 set 被拒（总开关）', () => {
  process.env.DSH_ROOST_DATA = mkdtempSync(join(tmpdir(), 'roost-close-'));
  const c = createClosing({ enabled: false });
  assert.equal(c.set('u1', { point: '不该记' }).ok, false);
  assert.equal(c.get('u1'), null);
});
