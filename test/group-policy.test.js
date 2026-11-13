// 2.2b 群聊策略补充层：插话概率 / 按群覆写 / 决策链。
//
// 这一层最容易出的事故不是「功能不生效」，而是「升级后她悄悄变安静了」——
// 所以第一组测试专门拿「完全没有 group 段的老配置」和「带默认 group 段」
// 对照着跑，逐条判定必须一模一样。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS, loadConfig, saveConfig } from '../src/config.js';
import { createDecider, resolveGroupPolicy, OVERRIDE_KEYS } from '../src/roost-decide.js';

const group = (chatId = 'G', extra = {}) => ({
  chat: { kind: 'group', chatId }, content: '随便聊点什么', ...extra,
});
const c2c = { chat: { kind: 'c2c', chatId: 'U' }, content: '你好' };

const mk = (cfg, random = () => 0.42, now = () => 1_700_000_000_000) =>
  createDecider({ cfg: () => cfg, random, now });

/* ------------------------------------------------------------------ */
/* 配置形状                                                            */
/* ------------------------------------------------------------------ */

test('DEFAULTS.group：默认值等于升级前行为，overrides 是开放字典', () => {
  assert.equal(DEFAULTS.group.interruptChance, 100, '100 = 句句都接，不能默认让她变安静');
  assert.equal(DEFAULTS.group.briefMaxItems, 20);
  assert.deepEqual(DEFAULTS.group.overrides, {});
  assert.ok(OVERRIDE_KEYS.includes('interruptChance'));
  assert.ok(OVERRIDE_KEYS.includes('maxPerHour'));
  assert.ok(OVERRIDE_KEYS.includes('quietStartHour'));
});

test('按群覆写存得下去：pruneTo 不会把开放字典裁掉，也不会污染别处', () => {
  const d = mkdtempSync(join(tmpdir(), 'roost-group-cfg-'));
  process.env.DSH_ROOST_DATA = d;
  const ov = {
    G_AAAA: { mode: 'mention', maxPerHour: 7, interruptChance: 30 },
    G_BBBB: { quietStartHour: 22, quietEndHour: 7 },
  };
  const cfg = saveConfig({ server: { token: 'REAL' }, group: { interruptChance: 60, overrides: ov } });
  assert.equal(cfg.group.interruptChance, 60);
  assert.deepEqual(cfg.group.overrides, ov, '两个群、任意键都要原样留下');
  assert.equal(loadConfig().server.token, 'REAL', '局部保存不许把 token 冲掉');
});

/* ------------------------------------------------------------------ */
/* 只增不减：老配置的行为一字不变                                       */
/* ------------------------------------------------------------------ */

test('老配置没有 group 段时，判定与「带默认 group 段」逐条一致', () => {
  const base = {
    roostHost: { decide: { mode: 'ai', cooldownSec: 20, maxRepliesPerMin: 3, ignoreWords: ['/'] } },
  };
  const withDefaults = { ...base, group: structuredClone(DEFAULTS.group) };
  const cases = [
    c2c,
    group('G', { mentioned: true }),
    group('G', { content: '' }),
    group('G', { content: '/roll' }),
    group('G', { addressed: true }),
    group('G', { content: '在吗？' }),
    group('G', { content: '', attachments: [{ type: 'image', url: 'http://x/1.png' }] }),
    group('G'),
  ];
  for (const evt of cases) {
    const a = mk(base).check(evt);
    const b = mk(withDefaults).check(evt);
    assert.deepEqual(
      { go: a.go, force: a.force, cooling: a.cooling, reason: a.reason },
      { go: b.go, force: b.force, cooling: b.cooling, reason: b.reason },
      `老配置与默认配置在「${evt.content || '(空)'}${evt.mentioned ? ' @' : ''}」上不一致`,
    );
  }
});

test('resolveGroupPolicy：没覆写时原样返回 decide，chance 缺省 100', () => {
  const r = resolveGroupPolicy({ roostHost: { decide: { mode: 'window' } } }, 'G');
  assert.equal(r.decide.mode, 'window');
  assert.equal(r.chance, 100);
  assert.equal(r.overridden, false);
  /** 不能改到原对象：cfg 是共享的现读配置 */
  assert.notEqual(r.decide, undefined);
});

test('resolveGroupPolicy：只认白名单键，错键 / 原型键不许混进判据', () => {
  /** 用 JSON.parse 造出自有的 __proto__ 键（对象字面量里它会被当成原型设置） */
  const ov = JSON.parse('{"G":{"maxPerHr":1,"__proto__":{"polluted":true},"mode":"mention"}}');
  const r = resolveGroupPolicy({ group: { overrides: ov } }, 'G');
  assert.equal(r.decide.mode, 'mention');
  assert.equal(r.decide.maxPerHr, undefined);
  assert.equal(r.decide.polluted, undefined);
  assert.equal(r.overridden, true);
});

/* ------------------------------------------------------------------ */
/* 插话概率                                                            */
/* ------------------------------------------------------------------ */

test('插话概率：0 = 普通群消息全不接，100 = 全接', () => {
  const zero = mk({ group: { interruptChance: 0 }, roostHost: { decide: {} } });
  const full = mk({ group: { interruptChance: 100 }, roostHost: { decide: {} } });
  assert.equal(zero.check(group()).go, false);
  assert.match(zero.check(group()).reason, /插话概率 0%/);
  assert.equal(full.check(group()).go, true);
});

test('插话概率：注入随机源后边界确定，且没中不占刹车额度', () => {
  const cfg = {
    group: { interruptChance: 40 },
    roostHost: { decide: { maxPerHour: 1 } },
  };
  /** random=0.39 → 39 < 40 中；0.40 → 不中（用 >= 比较，等号算没中） */
  const hit = mk(cfg, () => 0.39);
  assert.equal(hit.check(group()).go, true);
  const miss = mk(cfg, () => 0.40);
  const first = miss.check(group('G1'));
  assert.equal(first.go, false);
  assert.match(first.reason, /插话概率 40%/);
  /** 没中不该 push policyTimes，否则「每小时 1 条」会被一句没接的话吃光 */
  const snap = miss.snapshot().G1.policyTimes;
  assert.equal(snap.length, 0);
});

test('插话概率：明确在叫她 / 已经聊开了，一律不掷骰子', () => {
  const cfg = {
    group: { interruptChance: 0 },
    roostHost: { decide: { shortAskMustReply: true, ignoreWords: ['/'] } },
  };
  const d = mk(cfg);
  assert.equal(d.check(c2c).go, true, '私聊');
  assert.equal(d.check(group('G', { mentioned: true })).go, true, '被 @');
  assert.equal(d.check(group('G', { addressed: true })).go, true, '免@窗口 / 命令');
  assert.equal(d.check(group('G', { content: '在吗？' })).go, true, '短问必答');
  assert.equal(d.check(group('G', {
    content: '', attachments: [{ type: 'image', url: 'http://x/1.png' }],
  })).go, true, '纯图没有正文，走附件分支，不该被随机丢掉');
  /**
   * 语音一旦有 asrText 就算**正文**（saidOf 的既有语义，否则空消息判断会
   * 把语音丢掉），于是它和一句普通发言一样受概率管，这是刻意的。
   */
  assert.equal(d.check(group('G', {
    content: '', attachments: [{ type: 'voice', asrText: '听我说' }],
  })).go, false, '语音转出文字后按普通一句处理');
  assert.equal(d.check(group('G', { content: '/roll' })).go, false, '忽略词仍生效');
});

test('插话概率：engaged 连聊中不被概率拦', () => {
  let t = 1_700_000_000_000;
  const d = createDecider({
    cfg: () => ({
      group: { interruptChance: 0 },
      roostHost: { decide: { mode: 'engaged', engagedMaxTurns: 6, cooldownSec: 0, maxPerHour: 0 } },
    }),
    random: () => 0.99, now: () => t,
  });
  d.noteReplied('G');
  t += 1000;
  const v = d.check(group());
  assert.equal(v.go, true);
  assert.match(v.reason, /连聊中/);
});

/* ------------------------------------------------------------------ */
/* 按群覆写                                                            */
/* ------------------------------------------------------------------ */

test('按群覆写：只影响那一个群，别的群照用全局', () => {
  const cfg = {
    roostHost: { decide: { mode: 'ai', cooldownSec: 0, maxRepliesPerMin: 0 } },
    group: { interruptChance: 100, overrides: { G_QUIET: { mode: 'mention' } } },
  };
  const d = mk(cfg);
  assert.equal(d.check(group('G_QUIET')).go, false, '这个群设了只在被 @ 时回');
  assert.equal(d.check(group('G_OTHER')).go, true, '别的群不受影响');
});

test('按群覆写：静默时段 / 每小时上限 / 插话概率都能单群设', () => {
  const h = new Date().getHours();
  const cfg = {
    group: {
      interruptChance: 100,
      overrides: {
        G_SILENT: { quietStartHour: h, quietEndHour: (h + 2) % 24 },
        G_CAP: { maxPerHour: 1 },
        G_CHANCE: { interruptChance: 0 },
      },
    },
    roostHost: { decide: { cooldownSec: 0, maxRepliesPerMin: 0 } },
  };
  const d = mk(cfg, () => 0.99);
  assert.match(d.check(group('G_SILENT')).reason, /静默时段/);
  assert.equal(d.check(group('G_CAP')).go, true);
  assert.match(d.check(group('G_CAP', { content: '第二句' })).reason, /每小时最多接 1 次/);
  assert.match(d.check(group('G_CHANCE')).reason, /插话概率 0%/);
  assert.equal(d.check(group('G_NORMAL')).go, true, '没覆写的群完全不受影响');
});

/* ------------------------------------------------------------------ */
/* 决策链                                                              */
/* ------------------------------------------------------------------ */

test('决策链：每条判定都记下来（含不接的），新的在前，有上限', () => {
  const d = mk({ group: { interruptChance: 0 }, roostHost: { decide: {} } });
  for (let i = 0; i < 50; i += 1) d.check(group('G', { content: `第 ${i} 句` }));
  const r = d.recent(8);
  assert.equal(r.length, 8);
  assert.match(r[0].text, /第 49 句/, '最新一条在最前面');
  assert.equal(r[0].go, false);
  assert.match(r[0].reason, /插话概率/);
  assert.ok(r[0].at > 0);
  assert.equal(d.recent().length, 20, '默认给最近 20 条');
  assert.equal(d.recent(40).length, 40, '环形缓冲最多 40 条，50 次判定不会无限长');
  d.check(c2c);
  assert.equal(d.recent(1)[0].kind, 'c2c');
});
