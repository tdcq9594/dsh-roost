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
import { createDecider, resolveGroupPolicy, OVERRIDE_KEYS, topicRelevance } from '../src/roost-decide.js';

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

test('群聊扩展配置：默认 chat / 名单关闭，非法值与超长规则被夹紧', () => {
  const d = mkdtempSync(join(tmpdir(), 'roost-group-extra-'));
  process.env.DSH_ROOST_DATA = d;
  const raw = {
    responseDefault: 'bogus',
    responseModes: {
      G1: 'observe',
      G2: 'off',
      G3: 'not-a-mode',
      '': 'off',
    },
    memberFilter: {
      enabled: 'true',
      rules: [
        { openid: 'U1', scope: 'all', groups: [] },
        { openid: 'U1', scope: 'groups', groups: ['G1'] },
        { openid: 'U2', scope: 'groups', groups: [] },
        { openid: '', scope: 'all', groups: [] },
        { openid: 'U3', scope: 'weird', groups: [] },
        { openid: 'U4', scope: 'groups', groups: ['G1', 'G1', 'G2'] },
      ],
    },
  };
  const cfg = saveConfig({ group: raw });
  assert.equal(cfg.group.responseDefault, 'chat', '非法默认值回落到升级前行为');
  assert.deepEqual(cfg.group.responseModes, { G1: 'observe', G2: 'off' });
  assert.equal(cfg.group.memberFilter.enabled, false, '字符串 true 不算开启');
  assert.deepEqual(cfg.group.memberFilter.rules, [
    { openid: 'U1', scope: 'all', groups: [], note: '' },
    { openid: 'U3', scope: 'all', groups: [], note: '' },
    { openid: 'U4', scope: 'groups', groups: ['G1', 'G2'], note: '' },
  ]);
  assert.equal(loadConfig().group.responseDefault, 'chat');
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

/* ------------------------------------------------------------------ */
/* 总开关（2026-11-18）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 总开关排在任何判定之前：关掉就是「一条都不接」，私聊也一样。
 * 这是刻意不留暗门——「关掉」如果还能私聊回，用户会以为开关坏了。
 */
test('总开关：关着时私聊和群消息都不接', () => {
  const d = mk({ enabled: false });
  for (const evt of [c2c, group()]) {
    const v = d.check(evt);
    assert.equal(v.go, false);
    assert.match(v.reason, /总开关/);
  }
});

/**
 * 手改 `config.json` 写成字符串 `"false"` 的情况。
 * 用 `=== false` 判会漏掉它 → 面板显示关着、实际还在接话。
 */
test('总开关：字符串 "false" 也算关（与 features.js 同一口径）', () => {
  const d = mk({ enabled: 'false' });
  assert.equal(d.check(c2c).go, false);
  assert.match(d.check(c2c).reason, /总开关/);
});

/** 老配置没有这个键：必须与升级前逐字节一致，一条都不能少接 */
test('总开关：没配这个键 / 显式 true 时行为完全不变', () => {
  assert.equal(mk({}).check(c2c).go, true, '老配置（没有 enabled）要照常接');
  assert.equal(mk({ enabled: true }).check(c2c).go, true);
  const g = mk({}); 
  /** 群里那条走的是「模式收敛」，这里只确认没被总开关提前掐掉 */
  assert.doesNotMatch(g.check(group()).reason, /总开关/);
});

/* ------------------------------------------------------------------ */
/* 群响应模式 / 不回应名单（2026-11-25）                                 */
/* ------------------------------------------------------------------ */

const mkOwners = (cfg, owners = []) => createDecider({
  cfg: () => cfg,
  ownerIds: () => owners,
  random: () => 0.42,
  now: () => 1_700_000_000_000,
});

test('响应模式：缺省 chat 完全走老逻辑，off 不接，observe 只旁听', () => {
  const base = { roostHost: { decide: {} } };
  assert.equal(mk(base).check(group()).go, true, '没配新模式时仍按老逻辑接');
  assert.equal(mk({ ...base, group: { responseDefault: 'off' } }).check(group()).go, false);
  const observe = mk({ ...base, group: { responseDefault: 'observe' } }).check(group());
  assert.equal(observe.go, false);
  assert.equal(observe.observe, true);
  assert.match(observe.reason, /旁听/);
  /** 私聊永远不受群响应模式影响 */
  assert.equal(mk({ ...base, group: { responseDefault: 'off' } }).check(c2c).go, true);
});

test('响应模式：逐群覆写优先于默认，非法值回落到默认', () => {
  const cfg = {
    roostHost: { decide: {} },
    group: {
      responseDefault: 'chat',
      responseModes: { G_OFF: 'off', G_OBS: 'observe', G_BAD: 'bogus' },
    },
  };
  assert.equal(mk(cfg).check(group('G_OFF')).go, false);
  assert.equal(mk(cfg).check(group('G_OBS')).observe, true);
  assert.equal(mk(cfg).check(group('G_BAD')).go, true, '非法值不能把群弄哑');
  assert.equal(mk(cfg).check(group('G_OTHER')).go, true);
});

test('不回应名单：按 openid 命中、按群范围生效，私聊不受影响', () => {
  const cfg = {
    roostHost: { decide: {} },
    group: {
      memberFilter: {
        enabled: true,
        rules: [
          { openid: 'U_ALL', scope: 'all', groups: [] },
          { openid: 'U_G2', scope: 'groups', groups: ['G2'] },
        ],
      },
    },
  };
  const d = mk(cfg);
  assert.equal(d.check(group('G1', { sender: { openid: 'U_ALL' } })).go, false);
  assert.match(d.check(group('G1', { sender: { openid: 'U_ALL' } })).reason, /不回应名单/);
  assert.equal(d.check(group('G1', { sender: { openid: 'U_G2' } })).go, true, '指定群之外不拦');
  assert.equal(d.check(group('G2', { sender: { openid: 'U_G2' } })).go, false);
  assert.equal(d.check({ ...c2c, sender: { openid: 'U_ALL' } }).go, true, '私聊不参与名单');
});

test('不回应名单：主人 openid / ownerAliases 永久豁免；关闭时完全不生效', () => {
  const cfg = {
    roostHost: { decide: {} },
    group: {
      memberFilter: { enabled: true, rules: [{ openid: 'OWNER', scope: 'all', groups: [] }] },
    },
  };
  assert.equal(mkOwners(cfg, ['OWNER', 'OWNER_ALIAS']).check(group('G', { sender: { openid: 'OWNER' } })).go, true);
  assert.equal(mkOwners(cfg, ['OWNER_ALIAS']).check(group('G', { sender: { openid: 'OWNER_ALIAS' } })).go, true);
  assert.equal(mkOwners(cfg, []).check(group('G', { sender: { openid: 'OWNER' } })).go, false);

  const off = {
    ...cfg,
    group: { ...cfg.group, memberFilter: { ...cfg.group.memberFilter, enabled: false } },
  };
  assert.equal(mk(off).check(group('G', { sender: { openid: 'OWNER' } })).go, true);
});

test('决策链：旁听写入 observe 标记，不接的其它理由不带', () => {
  const d = mk({ roostHost: { decide: {} }, group: { responseDefault: 'observe' } });
  d.check(group());
  const row = d.recent(1)[0];
  assert.equal(row.go, false);
  assert.equal(row.observe, true);
  assert.match(row.reason, /旁听/);
});

/* ------------------------------------------------------------------ */
/* 话题与群活跃度（2.2c）                                              */
/* ------------------------------------------------------------------ */

test('话题与群活跃度：默认全关，等于升级前行为', () => {
  assert.deepEqual(DEFAULTS.group.interests, []);
  assert.equal(DEFAULTS.group.minRelevance, 0);
  assert.equal(DEFAULTS.group.minRecentMessages, 0);
  assert.equal(DEFAULTS.group.activeWindowSec, 300);
  assert.equal(DEFAULTS.roostHost.decide.burstWindowSec, 120, '默认仍是写死那版的 120 秒');
  for (const k of ['interests', 'minRelevance', 'minRecentMessages', 'activeWindowSec', 'burstWindowSec']) {
    assert.ok(OVERRIDE_KEYS.includes(k), `${k} 要能按群覆写`);
  }
  const withDefaults = { roostHost: { decide: {} }, group: { ...DEFAULTS.group } };
  assert.equal(mk(withDefaults).check(group()).go, true, '带着默认值也必须句句都接');
});

test('话题相关度：命中过闸、不命中被拦；@ 和私聊不受影响', () => {
  const cfg = {
    roostHost: { decide: {} },
    group: { interests: ['游戏', '追剧'], minRelevance: 0.25 },
  };
  assert.equal(mk(cfg).check(group('G', { content: '今晚一起打游戏' })).go, true);
  const miss = mk(cfg).check(group('G', { content: '今天股票又跌了' }));
  assert.equal(miss.go, false);
  assert.match(miss.reason, /话题和她关系不大/);
  assert.equal(mk(cfg).check(group('G', { content: '今天股票又跌了', mentioned: true })).go, true, '@ 仍然必回');
  assert.equal(mk(cfg).check({ ...c2c, content: '今天股票又跌了' }).go, true, '私聊不受影响');
});

test('话题相关度：只调门槛不填词表时不生效（防整片沉默）', () => {
  const cfg = { roostHost: { decide: {} }, group: { interests: [], minRelevance: 0.8 } };
  assert.equal(mk(cfg).check(group('G', { content: '随便说点什么' })).go, true);
});

test('话题相关度：过闸后把概率放大；prob=100 仍然不筛', () => {
  /** 无话题闸：概率 50、random 0.6 → 不中 */
  const plain = { roostHost: { decide: {} }, group: { interruptChance: 50 } };
  assert.equal(mk(plain, () => 0.6).check(group('G', { content: '打游戏' })).go, false);
  /** 有话题闸：相关度 0.30 → 50 × 2.2 = 110 → 夹到 100 → 必中 */
  const gated = {
    roostHost: { decide: {} },
    group: { interruptChance: 50, interests: ['游戏'], minRelevance: 0.25 },
  };
  assert.equal(mk(gated, () => 0.6).check(group('G', { content: '打游戏' })).go, true);
});

test('群冷清：窗口攒满后条数不够就不插，够数就放行', () => {
  let t = 1_700_000_000_000;
  const cfg = { roostHost: { decide: {} }, group: { minRecentMessages: 3, activeWindowSec: 60 } };
  const d = createDecider({ cfg: () => cfg, now: () => t, random: () => 0.42 });
  /** 第一条：观察窗口还没走满 → 放行（刚启动不能哑） */
  assert.equal(d.check(group('G', { content: '一' })).go, true);
  t += 61_000;
  const cold = d.check(group('G', { content: '二' }));
  assert.equal(cold.go, false);
  assert.match(cold.reason, /群里没在聊/);
  /** 再补两条，窗口内到 3 条 → 放行 */
  t += 5_000;
  assert.equal(d.check(group('G', { content: '三' })).go, false);
  t += 5_000;
  assert.equal(d.check(group('G', { content: '四' })).go, true);
});

test('突发窗口：burstWindowSec 可调，默认仍是 120 秒', () => {
  const run = (windowSec) => {
    let t = 1_700_000_000_000;
    const decide = windowSec ? { burstMax: 1, burstWindowSec: windowSec } : { burstMax: 1 };
    const cfg = { roostHost: { decide } };
    const d = createDecider({ cfg: () => cfg, now: () => t, random: () => 0.42 });
    assert.equal(d.check(group('G')).go, true);
    t += 90_000;
    return d.check(group('G'));
  };
  const byDefault = run(0);
  assert.equal(byDefault.go, false);
  assert.match(byDefault.reason, /120 秒内最多接 1 次/);
  assert.equal(run(60).go, true, '窗口缩到 60 秒后，90 秒前那次不再计入');
});

test('按群覆写：话题与活跃度只影响那一个群', () => {
  const cfg = {
    roostHost: { decide: {} },
    group: {
      interests: [],
      minRelevance: 0,
      overrides: { G_TALK: { interests: ['游戏'], minRelevance: 0.25 } },
    },
  };
  assert.equal(mk(cfg).check(group('G_TALK', { content: '打游戏' })).go, true);
  assert.equal(mk(cfg).check(group('G_TALK', { content: '股票' })).go, false, '该群启用了话题闸');
  assert.equal(mk(cfg).check(group('G_OTHER', { content: '股票' })).go, true, '别的群不受影响');
});

test('topicRelevance：子串命中每个词算 0.3，封顶 1，空词表为 0', () => {
  assert.equal(topicRelevance([], ['游戏']), 0);
  assert.equal(topicRelevance(['打游戏'], []), 0);
  assert.equal(topicRelevance(['打游戏'], ['游戏']), 0.3);
  assert.ok(Math.abs(topicRelevance(['打游戏 追剧 吃饭'], ['游戏', '追剧', '吃饭']) - 0.9) < 1e-9, '三个词 = 0.9');
  assert.equal(topicRelevance(['游戏 游戏 游戏'], ['游戏']), 0.3, '同一个词命中多次只算一次');
  assert.equal(topicRelevance(['a b c d'], ['a', 'b', 'c', 'd']), 1, '四个词封顶到 1');
});

test('配置归一化：词表去重限长、门槛夹紧、坏值退回不生效', () => {
  const d = mkdtempSync(join(tmpdir(), 'roost-group-topic-'));
  process.env.DSH_ROOST_DATA = d;
  const interests = ['游戏', ' 游戏 ', '', '追剧'];
  for (let i = 0; i < 60; i += 1) interests.push(`词${i}`);
  const cfg = saveConfig({
    group: {
      interests,
      minRelevance: 5,
      minRecentMessages: -3,
      activeWindowSec: 5,
    },
  });
  assert.deepEqual(cfg.group.interests.slice(0, 2), ['游戏', '追剧'], '去空、去重、保序');
  assert.equal(cfg.group.interests.length, 50, '词表最多 50 条');
  assert.equal(cfg.group.minRelevance, 1, '门槛夹到 0–1');
  assert.equal(cfg.group.minRecentMessages, 0, '负数退回 0 = 不判');
  assert.equal(cfg.group.activeWindowSec, 30, '窗口最小 30 秒');
});
