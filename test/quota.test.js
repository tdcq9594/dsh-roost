import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createQuota, QUOTA_DEFAULTS } from '../src/quota.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-roost-quota-'));

/**
 * 这些用例测的是「配了额度之后怎么拦」。
 *
 * 2026-11-05 起 `QUOTA_DEFAULTS` 的 `max` 全是 `-1`（不限）——默认不再拦人，
 * 这是为了守住「升级后行为不变」。所以额度要在 `defaults` 里显式给，
 * 这反而更接近真实用法：用户在面板上填的数字就是这份 defaults。
 */
const cap = (extra = {}) => ({ voice: { max: 3 }, sticker: { max: 1 }, ...extra });

/** 固定时间，方便跨天：2026-11-05 10:00 本地时间 */
const T = (h = 10, day = 5, min = 0) => new Date(2026, 10, day, h, min, 0, 0).getTime();

test('quota：到上限就拒绝，且说清用了几次', () => {
  const q = createQuota({ dir: tmp(), now: () => T(), defaults: cap() });
  const args = { feature: 'voice', id: 'U1', key: 'k1' };

  assert.equal(q.charge(args).ok, true);
  assert.equal(q.charge({ ...args, key: 'k2' }).ok, true);
  assert.equal(q.charge({ ...args, key: 'k3' }).ok, true);

  const over = q.charge({ ...args, key: 'k4' });
  assert.equal(over.ok, false);
  assert.equal(over.used, 3);
  assert.equal(over.max, 3);
  assert.ok(over.message.includes('语音条'), `提示要人话：${over.message}`);
});

test('quota：同一个幂等键重试不重复扣', () => {
  /**
   * 这条是「重试不能重复扣次数」的直接体现。
   * 发一条语音失败了重发，用的是同一个 requestId——那就不该扣第二次。
   */
  const q = createQuota({ dir: tmp(), now: () => T(), defaults: cap() });
  const one = { feature: 'voice', id: 'U1', key: 'sp-abc' };

  assert.equal(q.charge(one).ok, true);
  const again = q.charge(one);
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true);
  assert.equal(again.used, 1, '重试之后用量还是 1');

  // 再扣两次不同的 key，第三次不同的就超了（上限 3）
  assert.equal(q.charge({ ...one, key: 'sp-b' }).ok, true);
  assert.equal(q.charge({ ...one, key: 'sp-c' }).ok, true);
  assert.equal(q.charge({ ...one, key: 'sp-d' }).ok, false);
});

test('quota：跨天自动重置，不用清文件', () => {
  const dir = tmp();
  let now = T(23, 5, 50);
  const q = createQuota({ dir, now: () => now, defaults: cap() });
  const args = { feature: 'voice', id: 'U1' };

  for (let i = 0; i < 3; i++) assert.equal(q.charge({ ...args, key: `k${i}` }).ok, true);
  assert.equal(q.charge({ ...args, key: 'k9' }).ok, false);

  now = T(0, 6, 5); // 第二天零点五分
  assert.equal(q.charge({ ...args, key: 'k9' }).ok, true, '新的一天应当重新有额度');
});

test('quota：max=0 是全禁，max 缺失是不限', () => {
  const dir = tmp();
  const q = createQuota({ dir, now: () => T(), defaults: { sticker: { max: 0 } } });
  const r = q.charge({ feature: 'sticker', id: 'G1' });
  assert.equal(r.ok, false);
  assert.equal(r.max, 0);

  // 没登记的功能一律放行——新功能忘了配额度不能变成「一次都用不了」
  const any = createQuota({ dir, now: () => T(), defaults: cap() });
  assert.equal(any.charge({ feature: '压根没这个功能', id: 'x' }).ok, true);
});

test('quota：文件坏了从空开始，不抛也不锁死', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'quota.json'), '{ 这不是 JSON', 'utf8');
  const q = createQuota({ dir, now: () => T(), defaults: cap() });
  const r = q.charge({ feature: 'voice', id: 'U1', key: 'k1' });
  assert.equal(r.ok, true, '坏文件必须当作「还没用过」');
  // 写一次之后文件应当被修好
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8')));
});

test('quota：per 决定算谁的，人和群分开计', () => {
  const dir = tmp();
  const q = createQuota({ dir, now: () => T(), defaults: cap() });

  // 语音按人算：U1 用满不影响 U2
  for (let i = 0; i < 3; i++) q.charge({ feature: 'voice', id: 'U1', key: `a${i}` });
  assert.equal(q.charge({ feature: 'voice', id: 'U1', key: 'a9' }).ok, false);
  assert.equal(q.charge({ feature: 'voice', id: 'U2', key: 'b1' }).ok, true, '别人不受影响');

  // 表情包按群算：G1 一轮一张
  assert.equal(q.charge({ feature: 'sticker', id: 'G1', turnKey: 't1' }).ok, true);
  assert.equal(q.charge({ feature: 'sticker', id: 'G1', turnKey: 't1' }).ok, false, '同一轮第二张要拦');
  assert.equal(q.charge({ feature: 'sticker', id: 'G1', turnKey: 't2' }).ok, true, '下一轮可以再发');
  assert.equal(q.charge({ feature: 'sticker', id: 'G2', turnKey: 't1' }).ok, true, '别的群不受影响');
});

test('quota：usage 报的是「用得最多的那个人」，不是总和', () => {
  /**
   * 总和没有意义：语音是每人每天 3 条，10 个人各用 1 条，总和 10
   * 会显示成「超了 3 倍」，把主人吓一跳。要看的是「有没有人快用满」。
   */
  const dir = tmp();
  const q = createQuota({ dir, now: () => T(), defaults: cap() });
  q.charge({ feature: 'voice', id: 'U1', key: 'a' });
  q.charge({ feature: 'voice', id: 'U1', key: 'b' });
  q.charge({ feature: 'voice', id: 'U2', key: 'c' });

  const u = q.usage();
  assert.equal(u.ok, true);
  const voice = u.rows.find((r) => r.feature === 'voice');
  assert.equal(voice.peak, 2, `peak 应当是 2，实际 ${voice.peak}`);
  assert.equal(voice.max, 3, '面板要显示的是**真正生效**的上限（用例里显式配的 3），不是代码里的默认值');
  assert.equal(voice.buckets, 2, '两个桶（U1 / U2）');
});

test('quota：旧桶会被清掉，文件不会一直长', () => {
  const dir = tmp();
  let now = T(10, 1);
  const q = createQuota({ dir, now: () => now, defaults: cap() });
  q.charge({ feature: 'voice', id: 'U1', key: 'old' });

  now = T(10, 5); // 四天后
  q.charge({ feature: 'voice', id: 'U1', key: 'new' });

  const raw = JSON.parse(readFileSync(join(dir, 'quota.json'), 'utf8'));
  const voiceKeys = Object.keys(raw.counts).filter((k) => k.startsWith('voice|'));
  assert.equal(voiceKeys.length, 1, `应当只剩今天的桶，实际 ${voiceKeys.join(', ')}`);
  assert.ok(voiceKeys[0].includes('2026-11-05'));
});

test('quota：reset 连带清去重键，否则重置后重试还认老 key', () => {
  const dir = tmp();
  const q = createQuota({ dir, now: () => T(), defaults: cap() });
  q.charge({ feature: 'voice', id: 'U1', key: 'same' });
  q.reset('voice');

  const r = q.charge({ feature: 'voice', id: 'U1', key: 'same' });
  assert.equal(r.ok, true);
  assert.notEqual(r.deduped, true, '重置之后同一个 key 应当重新计');
});

test('quota：写不进去也不让对话失败', () => {
  /**
   * 用一个不存在的目录当数据目录，`mkdirSync` 那步还能成功，
   * 所以这里直接传一个「路径被文件占住」的 dir，让写盘真的失败。
   */
  const dir = tmp();
  writeFileSync(join(dir, 'blocker'), 'x', 'utf8');
  const warns = [];
  const q = createQuota({ dir: join(dir, 'blocker', 'sub'), now: () => T(), defaults: cap(), log: { warn: (m) => warns.push(m) } });

  const r = q.charge({ feature: 'voice', id: 'U1', key: 'k' });
  assert.equal(r.ok, true, '写盘失败必须放行');
  assert.ok(warns.length, '要留一句 warn，不能静默');
  assert.equal(existsSync(join(dir, 'blocker', 'quota.json')), false);
});

test('quota：每个内置项都要明确「接没接上」，不能含糊', async () => {
  /**
   * 额度表里有五项，但只有接了调用点的才真的会拦。
   * 少写一个 `wired` 就会让面板默认显示成生效——那是骗用户。
   */
  const { QUOTA_WIRED, QUOTA_LABELS } = await import('../src/quota.js');
  for (const k of Object.keys(QUOTA_DEFAULTS)) {
    assert.equal(typeof QUOTA_WIRED[k], 'boolean', `${k} 没标 wired`);
    assert.ok(QUOTA_LABELS[k], `${k} 没中文名`);
  }

  const q = createQuota({ dir: tmp(), now: () => T(), defaults: cap() });
  const u = q.usage();
  for (const r of u.rows) {
    assert.equal(typeof r.wired, 'boolean', `${r.feature} 的 rows 里缺 wired`);
  }
});

test('quota：默认一个都不限——装上新版本不能突然开始拦人', () => {
  /**
   * 这条守的是「升级后行为不变」。
   *
   * 之前默认值写的是「语音 3 / 发文件 2 / 表情 1」，看着合理，实际后果是
   * 老用户装上新版本、什么配置都没动，群友发第二个文件就被拒了——
   * 排障时会先怀疑权限策略，而配额的默认值根本不在面板上显眼的位置。
   *
   * 现在默认 `max` 全是 -1，数字挪到 `QUOTA_SUGGEST` 当建议值。
   */
  for (const [k, spec] of Object.entries(QUOTA_DEFAULTS)) {
    assert.equal(spec.max, -1, `${k} 的默认值必须是 -1（不限）`);
    assert.equal(spec.byBucket, undefined, `${k} 不该带默认的 byBucket：顶层不限时它只会把某一档单独限住`);
  }

  const dir = tmp();
  const q = createQuota({ dir, now: () => T() });
  for (let i = 0; i < 50; i++) {
    assert.equal(q.charge({ feature: 'file', id: 'U1', key: `f${i}` }).ok, true, '默认状态下发文件不该被拦');
    assert.equal(q.charge({ feature: 'voice', id: 'U1', key: `v${i}` }).ok, true, '默认状态下语音不该被拦');
  }
  // 也没写盘：`-1` 在 charge 里是提前返回，连 load 都不做
  assert.equal(existsSync(join(dir, 'quota.json')), false);
});

test('quota：usage 只算当前窗口的桶，昨天的残桶不能算进来', () => {
  /**
   * `sweep()` 只在 `charge()` 里跑。某天完全没人用，前几天的桶就还躺在
   * `counts` 里——不过滤的话面板会显示「目前最多用到 3」，用户以为今天已经用满了。
   */
  const dir = tmp();
  let now = T(10, 4);
  const q = createQuota({ dir, now: () => now, defaults: { voice: { max: 5 } } });
  q.charge({ feature: 'voice', id: 'U1', key: 'a' });
  q.charge({ feature: 'voice', id: 'U1', key: 'b' });

  now = T(10, 5); // 第二天，什么都没做
  const row = q.usage().rows.find((r) => r.feature === 'voice');
  assert.equal(row.peak, 0, `新的一天应当是 0，实际 ${row.peak}`);
  assert.equal(row.buckets, 0);
});

test('quota：max 写成非法值时按「不限」处理，别把 NaN 送到界面', () => {
  const q = createQuota({ dir: tmp(), now: () => T(), defaults: { voice: { max: '每天三次' } } });
  const row = q.usage().rows.find((r) => r.feature === 'voice');
  assert.equal(row.max, -1);
  assert.equal(q.charge({ feature: 'voice', id: 'U1', key: 'k' }).ok, true);
});

test('quota：工具调用总量默认不限，不能一上来就把群卡死', () => {
  /**
   * 这一项是「总闸」。默认给个 20，群里稍微活跃一点就超，
   * 表现是「刚刚还能用，突然什么都不能干了」——比不设还糟。
   */
  assert.equal(QUOTA_DEFAULTS.tool.max, -1);
  const q = createQuota({ dir: tmp(), now: () => T(), defaults: cap() });
  for (let i = 0; i < 200; i++) {
    assert.equal(q.charge({ feature: 'tool', id: 'G1', key: `k${i}` }).ok, true);
  }
});

test('quota：任意工具名都能当配额项，且默认按人按天', () => {
  const dir = tmp();
  const q = createQuota({ dir, now: () => T(), defaults: { web_search: { max: 2 } } });

  assert.equal(q.charge({ feature: 'web_search', id: 'U1', key: 'a' }).ok, true);
  assert.equal(q.charge({ feature: 'web_search', id: 'U1', key: 'b' }).ok, true);
  assert.equal(q.charge({ feature: 'web_search', id: 'U1', key: 'c' }).ok, false);
  assert.equal(q.charge({ feature: 'web_search', id: 'U2', key: 'd' }).ok, true, '换个人应当有独立额度');

  const row = q.usage().rows.find((r) => r.feature === 'web_search');
  assert.equal(row.window, 'day', '没写窗口默认每天');
  assert.equal(row.per, 'person', '没写单位默认每人');
});
