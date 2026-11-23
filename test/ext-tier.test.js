/**
 * 扩展权限分级守门。
 * 跑法：node --test test/ext-tier.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveTier, riskLines, installNotice, TIERS, FORMS, SCOPE_INFO, DEFAULT_SCOPES,
  isReviewed, REVIEWED_MAX_LEVEL,
} from '../src/ext-tier.js';
import { EXT_DEFAULT_SCOPES, EXT_ALLOWED_SCOPES } from '../src/ext-registry.js';
import { V1_SCOPES } from '../src/api-v1.js';

test('默认权限要与 ext-registry 对齐（存量扩展不虚低）', () => {
  assert.deepEqual([...DEFAULT_SCOPES], [...EXT_DEFAULT_SCOPES]);
  const t = deriveTier({});
  assert.equal(t.id, 'L1', '没写 scopes 的老扩展实际会拿到 memory:write，应显示 L1');
  assert.deepEqual(t.scopes, [...EXT_DEFAULT_SCOPES]);
});

test('所有已允许 scope 都有人话风险文案，V1_SCOPES 与 SCOPE_INFO 不漂移', () => {
  for (const s of EXT_ALLOWED_SCOPES) {
    assert.ok(SCOPE_INFO[s], `${s} 缺风险文案`);
  }
  for (const s of V1_SCOPES) {
    assert.ok(SCOPE_INFO[s], `${s} 在路由表里却没风险文案`);
  }
  /** core:write 是本轮新增的最高等级能力，也要在路由表白名单里（阶段 2 加） */
  assert.ok(SCOPE_INFO['core:write']);
});

test('L0 只读：只读 scope 不抬级', () => {
  const t = deriveTier({ scopes: ['state:read', 'context:read', 'memory:read'] });
  assert.equal(t.id, 'L0');
  assert.equal(t.confirm, 'none');
  assert.equal(t.form, 'mcp', '未声明 form 按外部扩展推断，存量扩展零改动');
});

test('L1 常规：写记忆 / 发消息', () => {
  assert.equal(deriveTier({ scopes: ['memory:write'] }).id, 'L1');
  assert.equal(deriveTier({ scopes: ['message:write'] }).id, 'L1');
  assert.equal(deriveTier({ scopes: ['state:read', 'memory:write'] }).id, 'L1');
});

test('L2 敏感：主动开口 / 改人格 / 开独立会话，需勾选确认', () => {
  for (const s of ['proactive:write', 'say:write', 'prompt:write', 'agent:write']) {
    const t = deriveTier({ scopes: [s] });
    assert.equal(t.id, 'L2', `${s} 应抬到 L2`);
  }
  const t = deriveTier({ scopes: ['state:read', 'agent:write'] });
  assert.equal(t.confirm, 'checkbox');
  assert.equal(t.level, 2);
});

test('L3 核心接管：overrides / core 形态 / core:write，需二次确认', () => {
  const a = deriveTier({ scopes: ['state:read'], overrides: ['memory'] });
  assert.equal(a.id, 'L3');
  assert.equal(a.confirm, 'type-name');
  assert.ok(a.reasons.some((r) => r.kind === 'override' && /记忆/.test(r.text)));

  assert.equal(deriveTier({ scopes: [], form: 'core' }).id, 'L3');
  assert.equal(deriveTier({ scopes: ['core:write'] }).id, 'L3');
});

test('保守默认：未知 scope / 未知形态一律抬到 L3，并写明「无法确认」', () => {
  const a = deriveTier({ scopes: ['state:read', 'system:root'] });
  assert.equal(a.id, 'L3');
  assert.deepEqual(a.unknownScopes, ['system:root']);
  assert.ok(a.reasons.some((r) => /无法确认/.test(r.text)));

  const b = deriveTier({ scopes: ['state:read'], form: 'wasm-sandbox' });
  assert.equal(b.id, 'L3');
  assert.equal(b.form, 'mcp');
});

test('等级不可由作者自填：清单里写 permissionTier 也不认', () => {
  const t = deriveTier({
    scopes: ['state:read'], overrides: ['memory'],
    permissionTier: 'L0', risk: 'safe', level: 0,
  });
  assert.equal(t.id, 'L3');
});

test('风险清单按风险从高到低，且都是人话（不含裸 scope 名）', () => {
  const t = deriveTier({ scopes: ['state:read', 'agent:write'], overrides: ['memory'] });
  const lines = riskLines(t);
  assert.ok(lines.length >= 3);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i - 1].level >= lines[i].level);
  assert.ok(lines.some((x) => /记忆/.test(x.text)));
  assert.ok(!lines.some((x) => /^agent:write$/.test(x.text)));
});

test('安装文案：L0 不打扰，L2 要确认，L3 明说可恢复与不兼容', () => {
  const l0 = installNotice(deriveTier({ scopes: ['state:read'] }), { name: '天气' });
  assert.match(l0, /L0/);
  assert.ok(!l0.includes('请确认'));

  const l2 = installNotice(deriveTier({ scopes: ['agent:write'] }), { name: '刷 B 站' });
  assert.match(l2, /L2/);
  assert.match(l2, /请确认/);
  assert.match(l2, /消耗你的额度/);

  const l3 = installNotice(deriveTier({ scopes: [], overrides: ['memory'] }), { name: '我的记忆' });
  assert.match(l3, /L3/);
  assert.match(l3, /停用扩展才能恢复/);
  assert.match(l3, /数据可能不兼容/);
});

test('四级元数据与形态枚举完整', () => {
  assert.deepEqual(Object.keys(TIERS), ['L0', 'L1', 'L2', 'L3']);
  for (const [id, t] of Object.entries(TIERS)) {
    assert.ok(t.label && t.summary && t.badge && t.color && t.confirm, `${id} 元数据不全`);
  }
  assert.deepEqual([...FORMS], ['builtin', 'inprocess', 'mcp', 'core']);
});

/**
 * 面板页面与进程内运行**也是权限**，但按敏感 L2 算（2026-11 调整）。
 *
 * 早期把同源 iframe 当成和「接管内置记忆」同级的最高风险（L3），导致官方
 * 扩展带个设置页就被弹「手打扩展名」的二次确认。实际上 ui.page / inprocess
 * 和 scopes 里的 config:write 是同一类「能改配置 / 读写本机」能力，够不着
 * 「关闭内置功能」，所以两者都降到 L2（勾选确认），风险明细仍逐条列出。
 */
test('分级：带 ui.page 的扩展算 L2（同源页面是敏感，不是核心接管）', () => {
  const t = deriveTier({ ui: { nav: { label: '小工具' }, page: 'p.html' } });
  assert.equal(t.level, 2, '有面板页是敏感级');
  assert.equal(t.id, 'L2');
  assert.equal(t.confirm, 'checkbox', '勾选确认即可，不用手打扩展名');
  assert.ok(t.reasons.some((r) => r.kind === 'ui' && r.key === 'page' && r.level === 2), '要说清为什么');
  assert.ok(
    riskLines(t).some((r) => r.text.includes('同源')),
    '确认清单里仍要出现「同源」——用户才知道它能做什么',
  );
});

test('分级：runtime:inprocess 抬到 L2', () => {
  const t = deriveTier({ ui: { runtime: 'inprocess', entry: 'index.js' } });
  assert.equal(t.level, 2, '进程内运行是敏感级');
  assert.equal(t.id, 'L2');
  assert.equal(t.form, 'inprocess');
  assert.ok(t.reasons.some((r) => r.key === 'inprocess' && r.level === 2));
});

test('分级：没有 ui.page 的普通扩展仍是 L1（别把门关死）', () => {
  const t = deriveTier({ ui: { nav: { label: '设置页' } } });
  assert.equal(t.id, 'L1', '只有菜单没有页面，不该抬级');
});

/**
 * 审核封顶（2026-11）：审核过的扩展无论声明什么权限，最高只到 L2。
 * verified 只认索引灌入的 official/reviewed；self（作者自证）和空值都算未审核。
 */
test('审核封顶：只有 official/reviewed 算审核过，self / 空值不算', () => {
  assert.equal(isReviewed('official'), true);
  assert.equal(isReviewed('reviewed'), true);
  assert.equal(isReviewed('self'), false, '作者自证不算审核');
  assert.equal(isReviewed(undefined), false, '没列出不算审核');
  assert.equal(REVIEWED_MAX_LEVEL, 2);
});

test('审核过的扩展：核心接管声明也封顶 L2，风险明细不隐藏', () => {
  const core = { form: 'core', scopes: ['core:write'], overrides: ['memory'] };
  const unverified = deriveTier(core);
  assert.equal(unverified.id, 'L3', '未审核的照常是 L3');
  assert.equal(unverified.confirm, 'type-name');

  for (const v of ['official', 'reviewed']) {
    const t = deriveTier(core, { verified: v });
    assert.equal(t.id, 'L2', `${v} 封顶 L2`);
    assert.equal(t.level, 2);
    assert.equal(t.confirm, 'checkbox', '不用手打扩展名');
    assert.ok(
      t.reasons.some((r) => r.kind === 'override' && r.level === 3),
      '封顶不隐藏风险：接管内置记忆仍要列在确认清单里',
    );
  }
  assert.equal(deriveTier(core, { verified: 'self' }).id, 'L3', 'self 自证不封顶');
});

test('审核封顶同样压住未知 scope / 未知形态的 L3', () => {
  assert.equal(deriveTier({ scopes: ['root:all'] }).id, 'L3');
  assert.equal(deriveTier({ scopes: ['root:all'] }, { verified: 'official' }).id, 'L2');
  assert.equal(deriveTier({ form: 'wasm' }).id, 'L3');
  assert.equal(deriveTier({ form: 'wasm' }, { verified: 'reviewed' }).id, 'L2');
});

/**
 * 市场卡片 / 安装确认 / 已装页三处一致（2026-11-23 issue 的市场分级不一致）。
 *
 * 三处的数据来源不同：市场卡片读索引条目，安装确认读下载来的 plugin.json，
 * 已装页读实际授予的 scope。但同一扩展必须显示出同一个等级。索引里带着
 * ui / scopes / form 原始声明（由 build-index 灌入），所以只要喂同一份声明
 * + 同一个 verified，三处 deriveTier 必然同值。这里守住这条契约。
 */
test('市场卡片与安装确认：同一扩展的索引条目和清单算出同一等级', () => {
  /** 模拟 build-index 输出的索引条目：只带分级用的原始声明子集 */
  const indexEntry = {
    id: 'voice-reply', verified: 'official',
    scopes: [], form: undefined,
    ui: { page: 'page.html', runtime: 'inprocess' },
  };
  /** 模拟 plugin.json：同样的声明（外加一堆和分级无关的配置） */
  const manifest = {
    id: 'voice-reply', scopes: [], usage: '...',
    ui: { page: 'page.html', runtime: 'inprocess', actions: [{ id: 'status' }] },
  };
  const fromIndex = deriveTier(indexEntry, { verified: indexEntry.verified });
  const fromManifest = deriveTier(manifest, { verified: indexEntry.verified });
  assert.equal(fromIndex.id, fromManifest.id, '市场和安装的等级必须一致');
  assert.equal(fromIndex.id, 'L2', '带设置页的官方扩展是 L2');
});
