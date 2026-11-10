/**
 * 阶段 3.2 / 门 G3 专项：方案 L 的 launcher 注入与 env 隔离。
 *
 * 用 `planLaunch()` 纯函数验形状，再用一次**真 spawn** 验扩展进程实际拿到的
 * env（不是只看我们拼出来的对象）。零外部依赖。
 *
 * 跑法：node --test test/ext-launcher.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { planLaunch } from '../src/ext-launcher.mjs';

const LAUNCHER = pathToFileURL(join(process.cwd(), 'src', 'ext-launcher.mjs')).href;

function tmpHome(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'roost-launcher-'));
  t.after(() => {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略 */ }
  });
  return d;
}

function fixture(t, over = {}) {
  const dir = tmpHome(t);
  const ext = join(dir, 'extensions', 'bili');
  fs.mkdirSync(ext, { recursive: true });
  fs.mkdirSync(join(dir, 'secrets'), { recursive: true });
  const manifest = {
    api: 1, kind: 'dsh-extension', id: 'bili', name: 'B', description: 'd',
    transport: 'stdio', command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify(process.env))'],
    serverName: 'bili', ...over.manifest,
  };
  fs.writeFileSync(join(ext, 'plugin.json'), JSON.stringify(manifest), 'utf8');
  if (over.withSecret !== false) {
    fs.writeFileSync(join(dir, 'secrets', 'bili.json'), JSON.stringify({ token: 'SECRET-TOKEN-123', ref: 'ROOST_EXT_BILI_TOKEN' }), 'utf8');
  }
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    ROOST_EXT_ID: 'bili', ROOST_API_URL: 'http://127.0.0.1:17321/v1',
    ROOST_LAUNCHER_DIR: dir,
    // 故意塞父环境敏感变量，验 launcher 不 scrub 遗漏
    ROOST_PARENT_SECRET: 'MUST-NOT-LEAK', SOME_TOKEN: 'MUST-NOT-LEAK',
    HOME: '/home/should-not-leak', USERPROFILE: 'C:/Users/should-not-leak',
    TEMP: '/tmp/should-not-leak', TMP: '/tmp/should-not-leak',
    ...over.env,
  };
  return { dir, ext, manifest, env };
}

test('G3-11 注入令牌：子进程 env 只有三个业务变量，无 dataDir / launcherDir / 私有路径', (t) => {
  const f = fixture(t);
  const p = planLaunch({ env: f.env });
  assert.equal(p.token, 'SECRET-TOKEN-123');
  assert.equal(p.missingSecret, false);
  assert.equal(p.childEnv.ROOST_API_TOKEN, 'SECRET-TOKEN-123');
  assert.equal(p.childEnv.ROOST_API_URL, 'http://127.0.0.1:17321/v1');
  assert.equal(p.childEnv.ROOST_EXT_ID, 'bili');
  assert.equal(p.childEnv.ROOST_LAUNCHER_DIR, undefined);
  assert.equal(p.childEnv.ROOST_PARENT_SECRET, undefined);
  assert.equal(p.childEnv.SOME_TOKEN, undefined);
  assert.equal(p.childEnv.HOME, undefined, 'HOME 能让扩展拼出私有目录位置');
  assert.equal(p.childEnv.USERPROFILE, undefined);
  assert.equal(p.childEnv.TEMP, undefined);
  assert.equal(p.childEnv.TMP, undefined);
  assert.ok(!JSON.stringify(p.childEnv).includes(f.dir.replace(/\\/g, '/')));
  assert.equal(p.command, process.execPath);
});

test('G3-12 缺 secrets 不崩：注入空串，missingSecret=true', (t) => {
  const f = fixture(t, { withSecret: false });
  const p = planLaunch({ env: f.env });
  assert.equal(p.token, '');
  assert.equal(p.missingSecret, true);
  assert.equal(p.childEnv.ROOST_API_TOKEN, '');
});

test('G3-13 拒绝坏输入：非法 id / 缺 launcherDir / 坏清单 / streamable-http', (t) => {
  const f = fixture(t);
  assert.throws(() => planLaunch({ env: { ...f.env, ROOST_EXT_ID: '../evil' } }), /不合法/);
  assert.throws(() => planLaunch({ env: { ...f.env, ROOST_LAUNCHER_DIR: '' } }), /ROOST_LAUNCHER_DIR/);
  fs.writeFileSync(join(f.ext, 'plugin.json'), '{ bad', 'utf8');
  assert.throws(() => planLaunch({ env: f.env }), /plugin.json/);
  fs.writeFileSync(join(f.ext, 'plugin.json'), JSON.stringify({ ...f.manifest, transport: 'streamable-http' }), 'utf8');
  assert.throws(() => planLaunch({ env: f.env }), /不由宿主注入/);
});

test('G3-14 相对 cwd 按扩展目录解析，args 只留字符串', (t) => {
  const f = fixture(t, { manifest: { cwd: './sub', args: ['ok', 42, null] } });
  const p = planLaunch({ env: f.env });
  assert.equal(p.cwd, join(f.ext, 'sub'));
  assert.deepEqual(p.args, ['ok']);
});

test('G3-15 真 spawn：扩展进程拿到令牌，且读不到父环境敏感变量与私有路径', (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [join(process.cwd(), 'src', 'ext-launcher.mjs')], {
    env: f.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const line = r.stdout.trim().split('\n').find((x) => x.startsWith('{'));
  assert.ok(line, `子进程未输出 env JSON：${r.stdout}`);
  const child = JSON.parse(line);
  assert.equal(child.ROOST_API_TOKEN, 'SECRET-TOKEN-123');
  assert.equal(child.ROOST_API_URL, 'http://127.0.0.1:17321/v1');
  assert.equal(child.ROOST_EXT_ID, 'bili');
  assert.equal(child.ROOST_LAUNCHER_DIR, undefined);
  assert.equal(child.ROOST_PARENT_SECRET, undefined);
  assert.equal(child.SOME_TOKEN, undefined);
  assert.ok(!line.includes(f.dir.replace(/\\/g, '/')), '私有目录全路径不能出现在扩展进程 env 里');
  assert.ok(!line.includes('secrets'));
});

test('G3-16 缺 secrets 真 spawn：仍启动成功，扩展拿到空令牌', (t) => {
  const f = fixture(t, { withSecret: false });
  const r = spawnSync(process.execPath, [join(process.cwd(), 'src', 'ext-launcher.mjs')], {
    env: f.env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stderr, /令牌缺失/);
  const child = JSON.parse(r.stdout.trim().split('\n').find((x) => x.startsWith('{')));
  assert.equal(child.ROOST_API_TOKEN, '');
  assert.equal(typeof LAUNCHER, 'string');
});
