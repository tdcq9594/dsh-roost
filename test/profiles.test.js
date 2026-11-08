// D7：人物小档案的纯数据层。
//
// 最容易静默出错的几处：换机器人后 openid 变了档案裂成两个人、
// 同一天里写一笔就让 system prompt 变一次（prompt cache 全废）、
// 用户点了清空但注入里还留着旧印象、默认关时偷偷建了文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createProfiles, canonicalKey, accumulate, dayKey, clipChars,
  shouldInjectProfiles, PROFILE_MAX, IMPRESSION_MAX,
} from '../src/profiles.js';

function fresh(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-prof-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return { file: join(dir, 'profiles.json'), dir };
}

const DAY = '2026-11-08';
const LATER = '2026-11-09';

/* ---------------- 纯函数 ---------------- */

test('D7：canonicalKey 走 openid + 别名归一，换号不裂成两个人', () => {
  const aliases = ['OPENID-MAIN', 'openid-old-a', 'openid-old-b'];
  assert.equal(canonicalKey('OPENID-MAIN', aliases), 'openid-main');
  assert.equal(canonicalKey('  openid-old-b ', aliases), 'openid-main', '命中旧别名 → 归到主 openid');
  assert.equal(canonicalKey('@小明', aliases), '小明', '没命中别名时退回显示名（去 @、去空白）');
  assert.equal(canonicalKey('', aliases), '');
  assert.equal(canonicalKey('小明'), '小明', '没别名表也不崩');
});

test('D7：accumulate 去重、只留最近 3 句、不切坏 emoji', () => {
  assert.equal(accumulate('说话直', '说话直；喜欢直接给结论', 80), '说话直；喜欢直接给结论');
  assert.equal(accumulate('a；b；c', 'd', 80), 'b；c；d', '超过 3 句丢最旧的');
  const long = accumulate('', '很'.repeat(200), IMPRESSION_MAX);
  assert.equal(Array.from(long).length, IMPRESSION_MAX);
  assert.equal(clipChars('🙂🙂🙂', 2), '🙂🙂', '按码点截，不能留半个代理项');
});

test('D7：dayKey 与本地 Date 的年月日一致', () => {
  const ts = Date.now();
  const d = new Date(ts);
  assert.equal(dayKey(ts),
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
});

test('D7：shouldInjectProfiles 只认真布尔 true', () => {
  assert.equal(shouldInjectProfiles({ enabled: true }), true);
  assert.equal(shouldInjectProfiles({ enabled: false }), false);
  assert.equal(shouldInjectProfiles({ enabled: 1 }), false);
  assert.equal(shouldInjectProfiles(), false);
});

/* ---------------- 存储与缓存 ---------------- */

test('D7：默认关时一个字都不给，连文件都不建', (t) => {
  const { file } = fresh(t);
  const p = createProfiles({ file });
  assert.equal(p.text({ enabled: false, day: DAY }), '');
  assert.equal(existsSync(file), false, '默认关等价：盘上零改动');
  assert.equal(p.size, 0);
});

test('D7：同一天写多少笔，注入文本都不变；跨天才重算', (t) => {
  const { file } = fresh(t);
  const p = createProfiles({ file });
  assert.equal(p.text({ enabled: true, day: DAY }), '', '没档案时别占 system prompt 的地方');

  p.note({ who: '小明', openid: 'u1', impression: '说话直', tips: '先给结论', aliases: [] });
  assert.equal(p.text({ enabled: true, day: DAY }), '', '当天不重写，保 prompt cache');

  p.note({ who: '小红', openid: 'u2', impression: '爱讲冷笑话', aliases: [] });
  assert.equal(p.text({ enabled: true, day: DAY }), '');

  const next = p.text({ enabled: true, day: LATER });
  assert.match(next, /小明/);
  assert.match(next, /小红/);
  assert.match(next, /只是印象，别原样念出来/);
  assert.match(next, /别把别处的事当这个群发生过/, '跨群档案要带防串话提醒');
  assert.match(next, /相处：先给结论/);
  assert.equal(p.text({ enabled: true, day: LATER }), next, '同一天重复调用返回同一串');
});

test('D7：清空当场生效，不会继续注入旧印象（隐私优先）', (t) => {
  const { file } = fresh(t);
  const p = createProfiles({ file });
  p.note({ who: '小明', openid: 'u1', impression: '说话直', aliases: [] });
  const rendered = p.text({ enabled: true, day: DAY });
  assert.match(rendered, /小明/);

  p.clear();
  assert.equal(p.text({ enabled: true, day: DAY }), '', '缓存必须跟着清作废');
  assert.equal(p.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), []);
});

test('D7：两个 openid 归一到同一条，印象按句累积不重复', (t) => {
  const { file } = fresh(t);
  const p = createProfiles({ file });
  const aliases = ['main-openid', 'old-openid'];
  p.note({ who: '小明', openid: 'main-openid', impression: '说话直', aliases });
  p.note({ who: '小明', openid: 'old-openid', impression: '说话直；爱喝咖啡', aliases });
  assert.equal(p.size, 1);
  const r = p.recent()[0];
  assert.equal(r.key, 'main-openid');
  assert.equal(r.hits, 2);
  assert.equal(r.impression, '说话直；爱喝咖啡');
});

test('D7：写盘持久化，重建实例还读得到', (t) => {
  const { file } = fresh(t);
  const a = createProfiles({ file });
  a.note({ who: '小明', openid: 'u1', impression: '说话直', aliases: [] });
  const b = createProfiles({ file });
  assert.equal(b.size, 1);
  assert.match(b.text({ enabled: true, day: DAY }), /说话直/);
});

test('D7：人数上限按最久未更新的淘汰', (t) => {
  const { file } = fresh(t);
  const p = createProfiles({ file, max: 3 });
  for (let i = 1; i <= 4; i += 1) {
    p.note({ who: `人${i}`, openid: `u${i}`, impression: `特点${i}`, aliases: [] });
  }
  assert.equal(p.size, 3);
  const keys = p.recent().map((r) => r.key);
  assert.ok(!keys.includes('u1'));
  assert.ok(keys.includes('u4'));
  assert.equal(PROFILE_MAX, 50);
});

test('D7：开关从关切到开，第一次渲染就给内容', (t) => {
  const { file } = fresh(t);
  const p = createProfiles({ file });
  p.note({ who: '小明', openid: 'u1', impression: '说话直', aliases: [] });
  assert.equal(p.text({ enabled: false, day: DAY }), '');
  assert.match(p.text({ enabled: true, day: DAY }), /说话直/, '关着的时候没缓存过空串');
});
