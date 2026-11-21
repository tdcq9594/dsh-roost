/**
 * `/quick` 的 op → scope 映射
 * ========================
 *
 * 这块的错法都是「静默放行」：少登记一个 op，那个 op 就调不到（还能发现）；
 * 登记错一个 scope，就是**越权**（发现不了）。所以断言盯三件事：
 *  1. 覆盖面：`/quick` 里每个 case 都要在表里，表里也不能有已经删掉的 op；
 *  2. 合法性：表里出现的 scope 必须是 `EXT_ALLOWED_SCOPES` 里的，防拼错；
 *  3. 语义：`null` = 只碰自己（不需要 scope）；有值 = 必须声明。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OP_SCOPE, SELF_ONLY_OPS, scopeOfOp, allowsOp, isSelfOnlyOp,
} from '../src/ext-quick-scopes.js';
import { EXT_ALLOWED_SCOPES, EXT_SENSITIVE_SCOPES } from '../src/ext-registry.js';

const HOST = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');

/** 从 host.js 里抠出 `/quick` 的所有 `case 'xxx':` */
function quickOps() {
  const at = HOST.indexOf("route('/quick'");
  assert.ok(at > 0, '找不到 /quick 路由');
  const end = HOST.indexOf('不认识的 op', at);
  const body = HOST.slice(at, end > 0 ? end : at + 60_000);
  return [...new Set([...body.matchAll(/case '([a-zA-Z.]+)':/g)].map((m) => m[1]))];
}

test('op 映射：/quick 里每个 op 都登记了，表里也没有多余的', () => {
  const ops = quickOps();
  assert.ok(ops.length >= 50, `只抠到 ${ops.length} 个 op，解析可能坏了`);

  const missing = ops.filter((o) => !Object.prototype.hasOwnProperty.call(OP_SCOPE, o));
  assert.deepEqual(missing, [], `这些 op 没登记（会被 fail-closed 拒掉）：${missing.join('、')}`);

  const extra = Object.keys(OP_SCOPE).filter((k) => !ops.includes(k));
  assert.deepEqual(extra, [], `这些登记项在 /quick 里已经不存在了：${extra.join('、')}`);
});

test('op 映射：用到的 scope 都是合法 scope（防拼错）', () => {
  const used = [...new Set(Object.values(OP_SCOPE).filter(Boolean))];
  for (const s of used) {
    assert.ok(EXT_ALLOWED_SCOPES.includes(s), `${s} 不在 EXT_ALLOWED_SCOPES 里`);
  }
});

test('op 映射：管理面那五个 scope 都是敏感项（安装要确认）', () => {
  for (const s of ['groups:read', 'model:write', 'host:maintenance', 'memory:purge', 'ext:manage']) {
    assert.ok(EXT_SENSITIVE_SCOPES.includes(s), `${s} 应该要求安装确认`);
  }
});

test('op 映射：不认识的 op 一律拒绝（fail-closed）', () => {
  assert.equal(scopeOfOp('').ok, false);
  assert.equal(scopeOfOp('model.set2').ok, false);
  assert.equal(scopeOfOp('__proto__').ok, false, '别让原型链上的键混进来');
  assert.equal(scopeOfOp('toString').ok, false);

  const r = allowsOp('nope', ['model:write']);
  assert.equal(r.ok, false);
});

test('op 映射：自己那几个不需要 scope，别的一律要声明', () => {
  for (const op of SELF_ONLY_OPS) {
    assert.equal(scopeOfOp(op).scope, null, `${op} 应该只碰自己`);
    assert.equal(allowsOp(op, []).ok, true, `${op} 不该要求 scope`);
    assert.equal(isSelfOnlyOp(op), true);
  }

  /** 没声明 → 拒；声明了 → 放 */
  assert.equal(allowsOp('model.set', []).ok, false);
  assert.equal(allowsOp('model.set', ['model:write']).ok, true);
  assert.equal(allowsOp('groups.list', ['state:read']).ok, false, 'state:read 不等于 groups:read');
  assert.equal(allowsOp('groups.list', ['groups:read']).ok, true);

  /** 一个 scope 声明都不给，也能用自己的 config / 自己的 action */
  assert.equal(allowsOp('extensions.config.save', []).ok, true);
  assert.equal(allowsOp('extensions.ui.action', []).ok, true);
});

test('op 映射：五个新 scope 覆盖了原本没有 scope 的管理面', () => {
  const by = (scope) => Object.entries(OP_SCOPE).filter(([, v]) => v === scope).map(([k]) => k);
  assert.ok(by('model:write').includes('model.set'));
  assert.ok(by('model:write').includes('quota.patch'));
  assert.ok(by('model:write').includes('capabilities.patch'));
  assert.ok(by('host:maintenance').includes('backup.restoreRetention'));
  assert.ok(by('host:maintenance').includes('sharedDeps.install'));
  assert.ok(by('memory:purge').includes('memory.purge'));
  assert.ok(by('memory:purge').includes('memory.clearGlobal'));
  assert.ok(by('ext:manage').includes('extensions.market.install'));
  assert.ok(by('ext:manage').includes('extensions.clients.create'));
  assert.ok(by('groups:read').includes('groups.list'));
});
