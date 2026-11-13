/**
 * 4.3 定时备份 + 4.4 加密云备份。
 *
 * 验收（路线图批次 4）：云备份失败要说清是「鉴权失败」还是「网络失败」；
 * `private===true` 校验是硬闸；先加密再推；passphrase 没配拒推不推明文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scheduleDue, encryptBuffer, decryptBuffer, pushBackup } from '../src/backup-remote.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 本地某天某点的固定时刻（本地时区——scheduleDue 就按本地日历天判） */
const at = (day, h) => new Date(2026, 10, day, h, 0).getTime();

test('4.3：scheduleDue——到点且今天没跑过才算到期', () => {
  assert.equal(scheduleDue({ now: at(13, 10), hour: 4, lastAt: 0 }), true, '没备份过=到期');
  assert.equal(scheduleDue({ now: at(13, 3), hour: 4, lastAt: at(12, 4) }), false, '还没到点');
  assert.equal(scheduleDue({ now: at(13, 4), hour: 4, lastAt: at(12, 4) }), true, '今天到点了、昨天跑过');
  assert.equal(scheduleDue({ now: at(13, 4), hour: 4, lastAt: at(13, 0) }), false, '今天已经跑过');
  assert.equal(scheduleDue({ now: at(13, 4), hour: 4, lastAt: at(13, 5) }), false, 'lastAt 在未来也不重跑');
  /** 边界：hour 0（凌晨零点）与 23 */
  assert.equal(scheduleDue({ now: at(13, 0), hour: 0, lastAt: at(12, 20) }), true);
  assert.equal(scheduleDue({ now: at(13, 22), hour: 23, lastAt: at(12, 20) }), false);
});

test('4.4：加密往返；口令错解不开；不是加密文件要拒绝', () => {
  const buf = Buffer.from('PK\u0003\u0004 这是假装的 zip 内容'.repeat(100));
  const enc = encryptBuffer(buf, '口令 abc');
  assert.ok(enc.length > buf.length, '要带盐/iv/魔数开销');
  assert.ok(!enc.subarray(0, 8).equals(buf.subarray(0, 8)), '加密后不能一眼看出 zip 头');
  const dec = decryptBuffer(enc, '口令 abc');
  assert.ok(dec.equals(buf), '解密要还原原文');

  assert.throws(() => decryptBuffer(enc, '错的口令'), () => true, 'GCM tag 校验失败要抛');
  assert.throws(() => decryptBuffer(buf, '口令 abc'), () => true, '没魔数的普通文件要拒绝');

  assert.throws(() => encryptBuffer(buf, ''), () => true, 'passphrase 没配就拒——不推明文');
});

test('4.4：pushBackup——配置缺失、体积超限、passphrase 空都分好类', async () => {
  const buf = Buffer.from('x'.repeat(10));
  const r1 = await pushBackup({ buf, name: 'b1', remote: { kind: '' } });
  assert.equal(r1.reason, 'config');
  const r2 = await pushBackup({ buf, name: 'b2', remote: { kind: 'gitee', gitee: { owner: 'a', repo: 'b', token: 't' } } });
  assert.equal(r2.reason, 'config', 'passphrase 没配=config 缺失');
  const r3 = await pushBackup({
    buf, name: 'b3',
    remote: { kind: 'gitee', passphrase: 'p', gitee: { owner: 'a', repo: 'b', token: 't' }, maxBytes: 5 },
  });
  assert.equal(r3.reason, 'too_large', '超过 maxBytes 拒推，说明怎么调');
});

/** 假 fetch：按 URL 分流，记录调用 */
function fakeGitee({ meta = { private: true }, putOk = true, putStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('/repos/') && !url.includes('/contents/')) {
      return { ok: true, status: 200, json: async () => meta };
    }
    return { ok: putOk, status: putStatus, json: async () => ({}) };
  };
  return { impl, calls };
}

test('4.4：Gitee——公开仓硬拒绝；鉴权失败分清类；成功路径真的 PUT', async () => {
  const base = { kind: 'gitee', passphrase: 'p', gitee: { owner: 'me', repo: 'bk', token: 'tok' } };
  const buf = Buffer.from('zip');

  /** 公开仓：硬闸 */
  const f1 = fakeGitee({ meta: { private: false } });
  const r1 = await pushBackup({ buf, name: 'b1', remote: base, fetchImpl: f1.impl });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'public', '公开仓=全量泄露，拒绝');
  assert.equal(f1.calls.filter((c) => c.method === 'PUT').length, 0, '拒绝时不能有上传');

  /** 令牌失效：查元数据 401 → auth */
  const f2 = fakeGitee();
  f2.impl = async (url) => (url.includes('/repos/') && !url.includes('/contents/')
    ? { ok: false, status: 401, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({}) });
  const r2 = await pushBackup({ buf, name: 'b2', remote: base, fetchImpl: f2.impl });
  assert.equal(r2.reason, 'auth', '元数据 401 是鉴权失败');

  /** PUT 403 → auth；500 → upstream */
  const f3 = fakeGitee({ putOk: false, putStatus: 403 });
  const r3 = await pushBackup({ buf, name: 'b3', remote: base, fetchImpl: f3.impl });
  assert.equal(r3.reason, 'auth');
  const f4 = fakeGitee({ putOk: false, putStatus: 500 });
  const r4 = await pushBackup({ buf, name: 'b4', remote: base, fetchImpl: f4.impl });
  assert.equal(r4.reason, 'upstream');

  /** 成功：PUT 内容是加密后的（解密还原=真加密了再推） */
  const f5 = fakeGitee();
  const r5 = await pushBackup({ buf, name: 'b5', remote: base, fetchImpl: f5.impl });
  assert.equal(r5.ok, true, `${r5.message}`);
  const put = f5.calls.find((c) => c.method === 'PUT');
  assert.ok(put, '要有上传调用');
  const round = decryptBuffer(Buffer.from(put.body.content, 'base64'), 'p');
  assert.ok(round.equals(buf), '推上去的必须是密文，且口令对得上');
});

test('4.4：WebDAV——401 是鉴权，500 是上游，成功路径带 Basic 认证', async () => {
  const base = { kind: 'webdav', passphrase: 'p', webdav: { url: 'https://dav.example/home', user: 'u', pass: 'w' } };
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', status: opts.__status ?? 200, headers: opts.headers || {} });
    return { ok: (opts.__status ?? 200) < 400, status: opts.__status ?? 200, json: async () => ({}) };
  };
  let implSt = { __status: 200 };
  const make = () => (url, opts = {}) => impl(url, { ...opts, __status: implSt.__status });

  implSt = { __status: 200 };
  const r1 = await pushBackup({ buf: Buffer.from('zip'), name: 'w1', remote: base, fetchImpl: make() });
  assert.equal(r1.ok, true, `${r1.message}`);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put.url.startsWith('https://dav.example/home/dsh-roost-backups/'), '要挂到配置的目录下');
  assert.ok(put.headers.authorization?.startsWith('Basic '), 'Basic 认证要带上');

  calls.length = 0;
  implSt = { __status: 401 };
  const r2 = await pushBackup({ buf: Buffer.from('zip'), name: 'w2', remote: base, fetchImpl: make() });
  assert.equal(r2.reason, 'auth', '401 要说是鉴权失败');
  calls.length = 0;
  implSt = { __status: 502 };
  const r3 = await pushBackup({ buf: Buffer.from('zip'), name: 'w3', remote: base, fetchImpl: make() });
  assert.equal(r3.reason, 'upstream', '502 是上游问题，不是鉴权');

  /** 网络层抛错 → network */
  const r4 = await pushBackup({
    buf: Buffer.from('zip'), name: 'w4', remote: base,
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.equal(r4.reason, 'network', '连接不上要说是网络失败');
});

test('4.3：host 定时备份落盘 + keep 删旧（备份一条龙）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-bksched-'));
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  /**
   * **必须先写 config.json 再导 host**：host 的 `cfg` 来自 `loadConfig()`
   * （dataDir 下的 config.json），不是 ctx.config。ctx.config 里放参数
   * 在这里不生效——keep 会回默认 7，删旧逻辑看着跑其实没删。
   */
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    backup: { schedule: { enabled: true, hour: 4, keep: 2 }, remote: { kind: '' } },
  }), 'utf8');
  t.after(() => {
    /** 必须调 effect 收的清理：里面有 sqlite 句柄与定时器，不关就让 runner 一直等 */
    for (const c of cleanups) { try { c(); } catch {} }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {}
  });
  const host = await import(`../src/host.js?bksched=${Date.now()}-${Math.random()}`);
  const noop = () => {};
  const noopOff = () => noop;
  const routes = new Map();
  const cleanups = [];
  mkdirSync(dir, { recursive: true });
  host.apply({
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noopOff },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noopOff; } },
    config: { backup: { schedule: { enabled: true, hour: 4, keep: 2 }, remote: { kind: '' } } },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = typeof cb === 'function' ? cb() : null;
      if (typeof off === 'function') cleanups.push(off);
      return noopOff;
    },
    on: () => noopOff,
    dataDir: dir,
    dir,
  });
  /**
   * 造两份旧备份，keep=2 时加上这次新的应只剩 2 份。
   * **mtime 必须设成不同时间**：listBackups 按 mtime 排序，
   * 两个刚写出来的夹具与本次新备份 mtime 几乎相同，删谁就变成碰运气。
   */
  const bdir = join(dir, 'backups');
  mkdirSyncBk(bdir);
  /** 前缀必须与 src/backup.js 的 BACKUP_PREFIX（`dsh-roost-backup-`）一致，
   *  否则 listBackups 根本不把它们当「完整备份」，keep 也就轮不到它们 */
  const old1 = join(bdir, 'dsh-roost-backup-20260101-0400.zip');
  const old2 = join(bdir, 'dsh-roost-backup-20260102-0400.zip');
  writeFileSync(old1, Buffer.from('old1'));
  writeFileSync(old2, Buffer.from('old2'));
  utimesSync(old1, new Date('2026-01-01T04:00:00'), new Date('2026-01-01T04:00:00'));
  utimesSync(old2, new Date('2026-01-02T04:00:00'), new Date('2026-01-02T04:00:00'));

  const key = [...routes.keys()].find((k) => k.endsWith('/backup/run-now'));
  assert.ok(key, '/backup/run-now 没注册');
  const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
  /** Host 必须是回环地址——面板围栏（防 DNS rebinding）会拒绝 'x' 这类占位值 */
  await routes.get(key)({ method: 'POST', url: '/backup/run-now', headers: { host: '127.0.0.1:8931' } }, res);
  assert.equal(res.body.ok, true, '立即备份要成功');
  assert.ok(res.body.name?.endsWith('.zip'), '要返回备份文件名');
  const left = listBk(bdir).filter((n) => n.startsWith('dsh-roost-backup-') && n.endsWith('.zip'));
  assert.equal(left.length, 2, `keep=2 要把最旧的删掉（剩 ${left.length} 份）`);
  assert.ok(!left.includes('dsh-roost-backup-20260101-0400.zip'), '删的是最旧那份');
});

/** 测试里不能引 backup.js 之外的相对路径麻烦，直接给两个小助手 */
import { mkdirSync, readdirSync, statSync, utimesSync } from 'node:fs';
function mkdirSyncBk(p) { mkdirSync(p, { recursive: true }); }
function listBk(p) {
  try { return readdirSync(p).filter((n) => statSync(join(p, n)).isFile()); } catch { return []; }
}
