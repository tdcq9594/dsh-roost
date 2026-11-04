/**
 * `capabilities.json` 的读写与观察。
 *
 * 盯两件静默出错的事：
 *  1. **第一次观察**：既不写基线（以后永远报不出新增），也不该报「新增 34 个」。
 *  2. **文件不存在时必须完全不用它**——老用户升级后行为不能变。
 *
 * 跑法：node --test test/capability-store.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCapabilityStore } from '../src/capability-store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-roost-cap-'));

test('文件不存在：未启用，observe 不写盘', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  assert.equal(s.enabled(), false);
  assert.equal(s.observe(['edit', 'read']).skipped, true);
  assert.equal(existsSync(join(dir, 'capabilities.json')), false, '读一次不该建文件');
});

test('init 之后启用，且带默认策略', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  const st = s.init();
  assert.equal(s.enabled(), true);
  assert.deepEqual(st.defaults.owner.allow, ['*']);
  assert.ok(existsSync(join(dir, 'capabilities.json')));
});

test('init 用种子覆盖默认值（老用户从 permissions 迁移时不降权）', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  const st = s.init({ defaults: { member: { allow: ['*'] } } });
  assert.deepEqual(st.defaults.member.allow, ['*']);
  assert.deepEqual(st.defaults.owner.allow, ['*'], '没写的档位要保留默认');
});

test('第一次 observe 写基线但不报新增；第二次才报', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  s.init();

  const first = s.observe(['edit', 'read'], 1000);
  assert.deepEqual(first.added, [], '第一次不能报新增');
  assert.equal(first.baseline, true);
  assert.equal(s.get().seen.tools.edit, 1000, '基线要落盘');

  const second = s.observe(['edit', 'read', 'gh_repo'], 2000);
  assert.deepEqual(second.added, ['gh_repo']);
  assert.equal(s.get().seen.tools.gh_repo, 2000);
  assert.equal(s.get().seen.tools.edit, 1000, '老工具保留首次见到的时间');
});

test('工具消失：进 pending.gone，并从 seen 里删掉（否则提示永远清不掉）', () => {
  /**
   * 2026-11-05 之前 `seen` 不删：本意是「装回来不该再报新增」，
   * 实际后果是每一轮都重新算出同一个 `gone` 再塞回 `pending`——
   * 用户点「我知道了」清掉，说一句话又冒出来，最后只能无视整条提示栏。
   *
   * 现在选的是另一头：删掉快照，装回来时报一次「新增」。
   * 多报一次新增无害，永远清不掉的失效提示会让提示栏彻底失去意义。
   */
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  s.init();
  s.observe(['edit', 'read'], 1000);
  const snap0 = s.snapshot();

  const r = s.observe(['edit'], 2000);
  assert.deepEqual(r.gone, ['read']);

  const snap = s.snapshot();
  assert.deepEqual(snap.pending.gone, ['read']);
  assert.equal(Object.hasOwn(s.get().seen.tools, 'read'), false, 'seen 要删，不能留着');
  assert.equal(snap0.pending.added.length, 0);

  // 用户点过「我知道了」，之后说话不该又弹出来
  s.ack();
  assert.deepEqual(s.observe(['edit'], 3000).gone, [], '第二轮不该重复报同一个失效工具');
  assert.deepEqual(s.snapshot().pending.gone, []);

  // 装回来会报一次新增——这是上面那个取舍的代价，认了
  assert.deepEqual(s.observe(['edit', 'read'], 4000).added, ['read']);
});

test('snapshot 读一次就清 pending（面板不该反复弹同一个提示）', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  s.init();
  s.observe(['edit'], 1000);
  s.observe(['edit', 'gh_repo'], 2000);

  assert.deepEqual(s.snapshot().pending.added, ['gh_repo']);
  assert.deepEqual(s.snapshot().pending.added, [], '第二次读应当是空的');
});

test('ack 清 pending 但不动策略', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  s.init();
  s.observe(['edit'], 1000);
  s.observe(['edit', 'gh_repo'], 2000);
  const before = s.get().defaults;

  s.ack();
  assert.deepEqual(s.snapshot().pending.added, []);
  assert.deepEqual(s.get().defaults, before);
});

test('patch 是顶层浅合并', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  s.init();
  const next = s.patch({ newTools: 'nobody' });
  assert.equal(next.newTools, 'nobody');
  assert.deepEqual(next.defaults.owner.allow, ['*'], '没提到的键要保住');
});

test('坏 JSON：退回默认值，不抛', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'capabilities.json'), '{这不是 json', 'utf8');
  const s = createCapabilityStore({ dir });
  assert.equal(s.enabled(), true, '文件在就算启用（只是内容坏了）');
  const st = s.get();
  assert.deepEqual(st.defaults.owner.allow, ['*']);
});

test('落盘内容里不含临时文件残留', () => {
  const dir = tmp();
  const s = createCapabilityStore({ dir });
  s.init();
  s.patch({ newTools: 'nobody' });
  assert.equal(existsSync(join(dir, 'capabilities.json.tmp')), false);
  const raw = readFileSync(join(dir, 'capabilities.json'), 'utf8');
  assert.ok(raw.trim().endsWith('}'));
});
