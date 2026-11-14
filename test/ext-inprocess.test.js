/**
 * 进程内动作：宿主 import 扩展的 `.mjs` 直接调函数。
 *
 * 这里最该守住的两条：
 *   · **日志形态**：宿主内部 `log` 是对象，扩展按函数用。2026-11-14 连着
 *     两次因为没转换，面板点按钮就报 `log is not a function`。所以有一条
 *     专门的回归用例。
 *   · **入口边界**：入口必须落在扩展目录内，`../` 一律拒 —— 这条是
 *     「跑扩展代码」这个形态唯一还能自己把控的地方。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInProcessAction, clearInProcessCache } from '../src/ext-inprocess.js';

let seq = 0;
/** 每个用例一个独立扩展目录 + 唯一 id（模块缓存按 id 存） */
function makeExt(source) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inproc-'));
  writeFileSync(join(root, 'main.mjs'), source, 'utf8');
  return { root, id: `t${++seq}`, entry: 'main.mjs' };
}

const cleanup = (root) => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* Windows 上偶尔 EBUSY，清理失败不该判红 */ }
};

const OK_MODULE = `
export function createActions({ log }) {
  return {
    async ping(p) { log('ping ' + JSON.stringify(p || {})); return { ok: true, message: 'pong', data: p || null }; },
  };
}
`;

test('正常调用：返回值原样带回', async () => {
  const ext = makeExt(OK_MODULE);
  try {
    clearInProcessCache(ext.id);
    const r = await runInProcessAction({ ...ext, action: 'ping', payload: { a: 1 } });
    assert.equal(r.handled, true);
    assert.equal(r.result.ok, true);
    assert.deepEqual(r.result.data, { a: 1 });
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('log 传对象也不能炸（回归：log is not a function）', async () => {
  const ext = makeExt(OK_MODULE);
  try {
    clearInProcessCache(ext.id);
    const seen = [];
    const r = await runInProcessAction({
      ...ext,
      action: 'ping',
      /** 宿主里的真实形态：对象，不是函数 */
      log: { info: () => {}, warn: (m) => seen.push(String(m)) },
    });
    assert.equal(r.handled, true, '对象形态的 log 不该让动作失败');
    assert.equal(r.result.message, 'pong');
    assert.deepEqual(seen, ['ping {}'], '对象 log 的 warn 应收到扩展打的那条');
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('没实现的动作 handled:false，交给队列回落', async () => {
  const ext = makeExt(OK_MODULE);
  try {
    clearInProcessCache(ext.id);
    const r = await runInProcessAction({ ...ext, action: 'nope' });
    assert.equal(r.handled, false);
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('入口越界（../）直接拒', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inproc-'));
  try {
    await assert.rejects(
      () => runInProcessAction({ id: `t${++seq}`, root, entry: '../evil.mjs', action: 'x' }),
      /必须在扩展目录内/,
    );
  } finally {
    cleanup(root);
  }
});

test('入口没有 createActions → handled:false，不抛', async () => {
  const ext = makeExt('export const nothing = 1;\n');
  try {
    clearInProcessCache(ext.id);
    const r = await runInProcessAction({ ...ext, action: 'ping' });
    assert.equal(r.handled, false);
    assert.match(r.reason, /createActions/);
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('动作超时：给出可读原因，不把请求永远挂住', async () => {
  const ext = makeExt(`
export function createActions() {
  return { async slow() { await new Promise((r) => setTimeout(r, 5_000)); return { ok: true }; } };
}
`);
  try {
    clearInProcessCache(ext.id);
    await assert.rejects(
      () => runInProcessAction({ ...ext, action: 'slow', timeoutMs: 60 }),
      /超过 0 秒没返回|超过 1 秒没返回/,
    );
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('配置是活引用：改了 config 下一次调用就是新值', async () => {
  const ext = makeExt(`
export function createActions({ config }) {
  return { async read() { return { ok: true, message: String(config.limit ?? '') }; } };
}
`);
  try {
    clearInProcessCache(ext.id);
    const first = await runInProcessAction({ ...ext, action: 'read', config: { limit: 5 } });
    assert.equal(first.result.message, '5');

    /** 面板上把设置改成 9：不用重建模块，下一次点击就该读到 9 */
    const second = await runInProcessAction({ ...ext, action: 'read', config: { limit: 9 } });
    assert.equal(second.result.message, '9', '配置必须原地更新，不能只用创建时那份');
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('配置里删掉的键也要跟着消失（不能留旧值）', async () => {
  const ext = makeExt(`
export function createActions({ config }) {
  return { async keys() { return { ok: true, message: Object.keys(config).sort().join(',') }; } };
}
`);
  try {
    clearInProcessCache(ext.id);
    await runInProcessAction({ ...ext, action: 'keys', config: { a: 1, b: 2 } });
    const r = await runInProcessAction({ ...ext, action: 'keys', config: { a: 1 } });
    assert.equal(r.result.message, 'a', 'b 被取消勾选后不该还留在配置里');
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});

test('宿主侧 env 会传进去（共享依赖目录只有宿主知道）', async () => {
  const ext = makeExt(`
export function createActions({ env }) {
  return { async deps() { return { ok: true, message: String(env.ROOST_DEPS_DIR ?? '') }; } };
}
`);
  try {
    clearInProcessCache(ext.id);
    const r = await runInProcessAction({ ...ext, action: 'deps', env: { ROOST_DEPS_DIR: 'C:/deps' } });
    assert.equal(r.result.message, 'C:/deps');
  } finally {
    clearInProcessCache(ext.id);
    cleanup(ext.root);
  }
});
