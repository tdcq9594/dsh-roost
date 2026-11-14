/**
 * 扩展权限分级守门。
 * 跑法：node --test test/ext-tier.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveTier, riskLines, installNotice, TIERS, FORMS, SCOPE_INFO, DEFAULT_SCOPES,
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
