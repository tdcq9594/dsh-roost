// 她跑 Python（批次3）安全边界：环境白名单、超时击杀、路径限制、无解释器拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, envUsable, runPython, probePython } from '../src/autotelic-python.js';

test('cleanEnv：只继承运行必需项，密钥/cookie/token 一律不传', () => {
  const base = {
    PATH: '/usr/bin', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe',
    OPENAI_API_KEY: 'sk-secret', DSH_TOKEN: 'tok', QQ_COOKIE: 'uin=o123',
    AWS_SECRET_ACCESS_KEY: 'aws', HOME: '/home/x',
  };
  const env = cleanEnv(base);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.OPENAI_API_KEY, undefined, 'API key 不能继承');
  assert.equal(env.DSH_TOKEN, undefined, 'token 不能继承');
  assert.equal(env.QQ_COOKIE, undefined, 'cookie 不能继承');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.HOME, undefined, '家目录也不给（防读到 ssh 等）');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
});

test('envUsable：过期/不可用/空解释器都判 false', () => {
  const now = 1e12;
  assert.equal(envUsable({ pythonBin: '/py', probedAt: now }, now), true);
  assert.equal(envUsable({ pythonBin: '', probedAt: now }, now), false);
  assert.equal(envUsable({ pythonBin: '/py', unavailable: true, probedAt: now }, now), false);
  assert.equal(envUsable({ pythonBin: '/py', probedAt: now - 25 * 3600_000 }, now), false, '超过24h要重探');
  assert.equal(envUsable(null, now), false);
});

test('runPython：无解释器 / 空脚本 / 超大脚本都拒绝', async () => {
  assert.match(runPython({ dir: '/tmp', pythonBin: '', code: 'print(1)' }).error, /没有可用/);
  assert.match(runPython({ dir: '/tmp', pythonBin: '/py', code: '   ' }).error, /空的/);
  assert.match(runPython({ dir: '/tmp', pythonBin: '/py', code: 'x'.repeat(300 * 1024) }).error, /太大/);
});

test('runPython：真跑（用 node 冒充解释器验证 spawn/落盘/cwd）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'py-'));
  try {
    // 用 node 当"解释器"，脚本内容是一段 JS —— 只为验证子进程机制与落盘，不验 Python 语义
    const r = await runPython({
      dir, pythonBin: process.execPath,
      code: 'console.log("hello-from-child")',
      timeoutMs: 10000,
    });
    assert.equal(r.ok, true, r.error || r.stderr);
    assert.match(r.stdout, /hello-from-child/);
    assert.ok(existsSync(join(dir, 'scripts')), '脚本要落 scripts/');
    assert.ok(existsSync(join(dir, 'out')), '产物目录要建好');
    assert.equal(readdirSync(join(dir, 'scripts')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runPython：超时被强杀，不悬挂', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'py-t-'));
  try {
    const started = Date.now();
    const r = await runPython({
      dir, pythonBin: process.execPath,
      code: 'setTimeout(()=>{}, 60000)', // 故意不退出
      timeoutMs: 400,
    });
    const ms = Date.now() - started;
    assert.ok(ms < 5000, `应被强杀（实际 ${ms}ms）`);
    assert.ok(r.timedOut === true || r.ok === false, '超时要标记');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probePython：探测失败返回 null，不抛', async () => {
  const r = await probePython({ configured: '', run: async () => ({ code: -1, out: 'not found' }) });
  assert.equal(r, null, '探测不到就是 null（调用方判空，envUsable 会返回 false）');
  assert.equal(envUsable(r), false);
});
