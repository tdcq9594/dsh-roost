/**
 * 扩展令牌的 scope 策略（阶段 8 授权链）。
 *
 * 盯三件事：
 *  1. 默认值只给「写自己记忆 + 读状态」——放开发消息等于装上就能以机器人身份说话；
 *  2. 清单能声明 scope，但未知项要拒（写错一个字母静默少一个权限最难查）；
 *  3. 轮换 / 备份还原重建令牌时**保持原 scope**，不能把主人授的权限悄悄收回。
 *
 * 跑法：node --test test/ext-scopes.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import {
  EXT_DEFAULT_SCOPES, EXT_ALLOWED_SCOPES, EXT_SENSITIVE_SCOPES,
  normalizeScopes, sensitiveScopesOf, validateManifest,
  createClientStore, createExtSecrets, createExtRegistry,
} from '../src/ext-registry.js';
import { V1_SCOPES } from '../src/api-v1.js';

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-ext-scopes-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

const manifestOf = (over = {}) => ({
  api: 1, kind: 'dsh-extension', id: 'bili', serverName: 'bili',
  name: '扩展bili', description: '说明', transport: 'stdio', command: 'node', args: ['server.mjs'],
  ...over,
});

test('S1 扩展可申请的 scope 集合与 api-v1 的 V1_SCOPES 逐项一致', () => {
  // 两边各写一份是为了避免循环依赖；这条断言保证它们不会漂。
  assert.deepEqual([...EXT_ALLOWED_SCOPES].sort(), [...V1_SCOPES].sort());
  for (const s of EXT_DEFAULT_SCOPES) {
    assert.ok(EXT_ALLOWED_SCOPES.includes(s), `默认 scope「${s}」不在允许集合里`);
  }
  for (const s of EXT_SENSITIVE_SCOPES) {
    assert.ok(EXT_ALLOWED_SCOPES.includes(s), `敏感 scope「${s}」不在允许集合里`);
  }
});

test('S2 默认只给「写自己记忆 + 读状态」，不含任何会对外说话的 scope', () => {
  assert.deepEqual([...EXT_DEFAULT_SCOPES], ['memory:write', 'state:read']);
  for (const s of ['message:write', 'say:write', 'proactive:write', 'session:write', 'prompt:write', 'agent:write']) {
    assert.ok(!EXT_DEFAULT_SCOPES.includes(s), `默认值里不该有 ${s}`);
  }
});

test('S3 normalizeScopes：过滤未知项、去重、空值退回默认', () => {
  assert.deepEqual(normalizeScopes(['memory:write', 'memory:write', 'nope']), ['memory:write']);
  assert.deepEqual(normalizeScopes([]), [...EXT_DEFAULT_SCOPES], '空数组退回默认，不能给「无 scope 的有效令牌」');
  assert.deepEqual(normalizeScopes(null), [...EXT_DEFAULT_SCOPES]);
  assert.deepEqual(normalizeScopes('memory:write'), [...EXT_DEFAULT_SCOPES], '非数组一律退回默认');
});

test('S4 清单 scopes：合法数组通过，未知项 / 非数组拒绝', () => {
  assert.equal(validateManifest(manifestOf({ scopes: ['memory:write', 'say:write'] })).ok, true);
  const bad = validateManifest(manifestOf({ scopes: ['memory:write', 'say:wirte'] }));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('；'), /scopes 含未知项/);
  const notArr = validateManifest(manifestOf({ scopes: 'say:write' }));
  assert.equal(notArr.ok, false);
  assert.match(notArr.errors.join('；'), /scopes 必须是字符串数组/);
});

test('S5 sensitiveScopesOf：只挑出需要主人确认的那几个', () => {
  assert.deepEqual(sensitiveScopesOf({ scopes: ['memory:write', 'say:write', 'state:read'] }), ['say:write']);
  assert.deepEqual(sensitiveScopesOf({ scopes: ['memory:write'] }), []);
  assert.deepEqual(sensitiveScopesOf({}), []);
});

test('S6 发放令牌：带清单 scope 就按清单，不带就是默认', (t) => {
  const dir = tmpHome(t);
  const store = createClientStore({ dir });
  const secrets = createExtSecrets({ dir });

  secrets.issue('aa', store);
  assert.deepEqual(store.get('ext:aa').scopes, [...EXT_DEFAULT_SCOPES]);

  secrets.issue('bb', store, { scopes: ['memory:write', 'say:write'] });
  assert.deepEqual(store.get('ext:bb').scopes, ['memory:write', 'say:write']);

  // 非法 scope 被过滤后仍要有可用集合
  secrets.issue('cc', store, { scopes: ['nope'] });
  assert.deepEqual(store.get('ext:cc').scopes, [...EXT_DEFAULT_SCOPES]);
});

test('S7 轮换令牌保持原 scope，不能把主人授的权限悄悄收回', (t) => {
  const dir = tmpHome(t);
  const store = createClientStore({ dir });
  const secrets = createExtSecrets({ dir });

  secrets.issue('aa', store, { scopes: ['memory:write', 'say:write'] });
  const before = [...store.get('ext:aa').scopes];
  secrets.rotate('aa', store);
  assert.deepEqual(store.get('ext:aa').scopes, before, '轮换后 scope 变了 = 扩展突然 403');
});

test('S8 备份还原重建令牌（ensure）同样保持原 scope', (t) => {
  const dir = tmpHome(t);
  const store = createClientStore({ dir });
  const secrets = createExtSecrets({ dir });

  secrets.issue('aa', store, { scopes: ['memory:write', 'proactive:write'] });
  // 模拟 E4 还原：secrets 没了，api.clients 还在
  fs.rmSync(secrets.fileOf('aa'), { force: true });
  const r = secrets.ensure('aa', store);
  assert.equal(r.regenerated, true);
  assert.deepEqual(store.get('ext:aa').scopes, ['memory:write', 'proactive:write']);
});

test('S9 安装链路：清单声明的 scope 真的落到令牌上', (t) => {
  const dir = tmpHome(t);
  // 目录名必须等于 id：`install()` 用 basename 做 expectedId 校验
  const src = join(dir, 'bili');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(join(src, 'plugin.json'), `${JSON.stringify(manifestOf({
    scopes: ['memory:write', 'state:read', 'say:write'],
  }), null, 2)}\n`, 'utf8');
  fs.writeFileSync(join(src, 'server.mjs'), '// x\n', 'utf8');

  const store = createClientStore({ dir });
  const secrets = createExtSecrets({ dir });
  const reg = createExtRegistry({ dir: join(dir, 'data'), secrets, clientStore: store });
  const r = reg.install(src, { source: { repo: 'market' } });
  assert.equal(r.ok, true);
  assert.equal(r.tokenIssued, true);
  assert.deepEqual(store.get('ext:bili').scopes, ['memory:write', 'state:read', 'say:write']);
});
