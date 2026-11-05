import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FEATURES, FEATURE_GROUPS, readFeatures, rawFeature, forcedDenyTools, patchForFeature, cannotEnable, featureDef, kindOf, readSettings, normalizeSetting } from '../src/features.js';
import { resolvePolicy, defaultStore, PINNED_KEEP } from '../src/capabilities.js';

const POOL = [
  'memory_search',
  'memory_note',
  'qq_send',
  'qq_close',
  'qq_send_file',
  'sticker_pick',
  'edit',
  'read',
  'gh_repo',
];

const ALL_ON = {
  speakUp: { enabled: true },
  awake: { enabled: true },
  memory: { enabled: true, tools: true },
  closing: { enabled: true },
  qqTools: { enabled: true },
  sendFile: { enabled: true },
  stickers: { enabled: true },
  tts: { enabled: true },
  compact: { enabled: true },
  persona: { command: { enabled: true } },
};

test('features：每个开关的 path 都能在对应来源里找到，没有空指路牌', () => {
  /**
   * 这条看起来像废话，但它挡住的是最尴尬的一类 bug：
   * 界面上一排开关，其中一个读的是不存在的字段，于是永远显示「开」，
   * 关掉了什么也没发生，还没人发现。
   */
  for (const f of FEATURES) {
    assert.ok(f.id, 'id 必填');
    assert.ok(f.label, `${f.id} 缺 label`);
    assert.ok(Array.isArray(f.path) && f.path.length, `${f.id} 缺 path`);
    assert.ok(f.source === 'config' || f.source === 'store', `${f.id} 的 source 只能是 config/store`);
    assert.ok(Array.isArray(f.affects), `${f.id} 的 affects 必须是数组`);
    assert.ok(Array.isArray(f.requires), `${f.id} 的 requires 必须是数组`);
  }

  // 分组要覆盖全部，漏一个就说明有个开关在界面上永远不出现
  const grouped = new Set(FEATURE_GROUPS.flatMap((g) => g.ids));
  for (const f of FEATURES) assert.ok(grouped.has(f.id), `${f.id} 没进任何分组`);
  for (const id of grouped) assert.ok(featureDef(id), `分组里有个不存在的开关 ${id}`);
});

test('features：数值项拒空值（Number(\'\') === 0 会静默关掉排队）', () => {
  /**
   * 真实 bug：能力页的数字输入框清空后失焦，前端把 `''` 提交上来，
   * 后端 `Number('')` 得 0，而 `queueMax.min` 恰好是 0（0 = 关掉排队，合法），
   * 于是写进 config 并回「已保存」——排队被静默关掉，用户完全看不出来。
   */
  const f = featureDef('queueMax');
  for (const v of ['', '  ', null, undefined, false, [], {}]) {
    assert.equal(normalizeSetting(f, v), null, `空值 ${JSON.stringify(v)} 必须被拒`);
    assert.equal(patchForFeature('queueMax', v), null, `patch 也必须拒 ${JSON.stringify(v)}`);
  }
  /** 0 本身是合法值，别为了挡空串把它一起误伤 */
  assert.equal(normalizeSetting(f, 0), 0, '0 = 关掉排队，是合法值');
  assert.equal(normalizeSetting(f, 4), 4);
  assert.equal(normalizeSetting(f, 11), null, '超过 max 要拒');
  assert.equal(normalizeSetting(f, -1), null, '低于 min 要拒');
  assert.equal(normalizeSetting(f, 2.5), null, '非整数要拒');
});

test('features：全开时什么都不收', () => {
  const deny = forcedDenyTools(ALL_ON, { features: { sendFile: true } }, POOL);
  assert.deepEqual(deny, []);
});

test('features：关「分段说话」要收掉 qq_send 和 qq_close（钉住项也拦不住）', () => {
  /**
   * 这条是功能层的**根本语义**：钉住项约束的是「用户策略不许乱关」，
   * 而功能整个关掉是更上层的事。两者顺序写反，就会出现
   * 「页面上关着分段说话，模型还在调 qq_send」。
   */
  const cfg = { ...ALL_ON, qqTools: { enabled: false } };
  const deny = forcedDenyTools(cfg, {}, POOL);
  assert.ok(deny.includes('qq_send'));
  assert.ok(deny.includes('qq_close'));
  assert.ok(!deny.includes('sticker_pick'), '不该连累别的');

  // 钉住项里确实有 qq_send，所以这条真的在测覆盖关系
  assert.ok(PINNED_KEEP.includes('qq_send'));

  const store = defaultStore();
  const r = resolvePolicy({ pool: POOL, bucket: 'owner', store, forceDeny: deny });
  assert.ok(r.ok);
  assert.ok(!r.allow.includes('qq_send'), '功能关了，主人也不该还能调');
  assert.ok(r.forced.includes('qq_send'), '要能说清「是被功能关掉的」');
});

test('features：关「记忆」收记忆工具，但不动别的档位配置', () => {
  const cfg = { ...ALL_ON, memory: { enabled: false, tools: true } };
  const deny = forcedDenyTools(cfg, {}, POOL).sort();
  assert.deepEqual(deny, ['memory_note', 'memory_search']);

  // 记性关了但表情包还在
  assert.ok(!deny.includes('sticker_pick'));
});

test('features：依赖项关着时，本项显示为关（只影响显示，不改配置）', () => {
  /**
   * `awake` 是「先想想要不要开口」，它靠 `speakUp` 排期。
   * 总闸关了，判断层就是个空转的开关，界面上不该显示成「开」。
   */
  const cfg = { ...ALL_ON, speakUp: { enabled: false } };
  const on = readFeatures(cfg, {});
  assert.equal(on.speakUp, false);
  assert.equal(on.awake, false, '依赖 speakUp，应连带显示为关');

  // 但配置原文没被改：rawFeature 仍然是用户填的那个值
  assert.equal(rawFeature(cfg, {}, 'awake'), true);
});

test('features：没写过的字段当「开」，写了 false 才是关', () => {
  /**
   * 老配置里 `tts.enabled` 可能整个不存在。若把 `undefined` 当关，
   * 用户升级之后会发现语音、表情包全没了——而他从没关过。
   */
  const on = readFeatures({}, {});
  for (const f of FEATURES) {
    /** 非布尔项（保留期下拉）不参与开关语义，`0` 是「永久」不是「关」 */
    if (kindOf(f) !== 'toggle') continue;
    /**
     * 例外：声明了 `default: false` 的「放宽权限」类开关，没配过也必须当关。
     * 其余 toggle 保持历史语义（老配置升级不丢功能）。
     */
    assert.equal(
      on[f.id],
      f.default === false ? false : true,
      f.default === false ? `${f.id} 默认关，空配置下也应当是关` : `${f.id} 在空配置下应当是开`,
    );
  }
  assert.equal(on.chatLookForMembers, false, '群友查记录默认关，不能靠「没配」变成开');
  assert.equal(rawFeature({}, {}, 'chatLookForMembers'), false, '面板显示的原始值也按默认关');
  assert.equal(
    readFeatures({ chat: { chatLookForMembers: true } }, {}).chatLookForMembers,
    true,
    '显式写了 true 才真的放行',
  );
  /**
   * 非布尔项的默认值单独验一次。
   *
   * 这里用一个**临时**定义验机制本身：账本的保留期不在 dsh-roost 的 config 里
   * （它在 bot 那边），所以不能拿它当例子——那会变成「面板显示永久、实际按 7 天删」。
   */
  assert.deepEqual(readSettings({}, {}), { queueMax: 2, queueMinBudgetSec: 30 }, '非布尔项取定义里的默认值');

  assert.equal(readFeatures({ tts: { enabled: false } }, {}).voice, false);
});

test('features：发文件存在 store 里，其余存 config，不混', () => {
  const p = patchForFeature('sendFile', false);
  assert.deepEqual(p, { store: { features: { sendFile: false } } });

  const q = patchForFeature('qqTools', false);
  assert.deepEqual(q, { config: { qqTools: { enabled: false } } });

  // 三层路径要折对，写错一层就是「改了没反应」
  const m = patchForFeature('memoryTools', false);
  assert.deepEqual(m, { config: { memory: { tools: false } } });
});

test('features：想开但前置没满足时，给一句人话', () => {
  const cfg = { ...ALL_ON, speakUp: { enabled: false } };
  const why = cannotEnable(cfg, {}, 'awake');
  assert.ok(why.includes('主动搭话'), `应当指出要先开哪一项，实际：${why}`);

  assert.equal(cannotEnable(ALL_ON, {}, 'awake'), '');
  assert.equal(cannotEnable(ALL_ON, {}, '没这个开关'), '没有这个开关');
});

test('features：forcedDenyTools 只返回池子里真有的名字', () => {
  /**
   * `tools.restrict` 一个名字不认识就整批拒绝（0.10.10 那次，
   * 白名单从没生效过）。所以功能层也只能吐池内名字。
   */
  const cfg = { ...ALL_ON, memory: { enabled: false, tools: false } };
  const deny = forcedDenyTools(cfg, {}, ['edit', 'read']);
  assert.deepEqual(deny, [], '池子里没有记忆工具，就不该吐那几个名字');

  // 不传 pool 时给全集，交给调用方按实际挂载过滤
  const all = forcedDenyTools(cfg, {}).sort();
  assert.deepEqual(all, ['memory_note', 'memory_search']);
});
