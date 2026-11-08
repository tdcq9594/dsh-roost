/**
 * E4 接线测试（7b）：确认 host.js 真的把备份接上了。
 *
 * 纯函数在 backup.test.js、两个 store 的 insertRaw 在 retention-store.test.js
 * 风格的真库里跑。这里盯「代码写了但没接上」的几件事：
 *   · 启动时恢复挂在 loadConfig() **之前**（源码切片 + 真行为）；
 *   · 面板能导出 zip、能列清单、能按份还原、能取消待生效恢复；
 *   · 还原是原样插回（不误伤相似事实、不丢 accessed）、幂等、停自动 sweep。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../src/journal.js';

const noop = () => () => {};
const FACT = '约定：每周日一起看电影';
const SIMILAR = '约定：每周日一起看电影吧';
const OLD = Date.now() - 200 * 86400000;

async function boot({ stage = null, retentionBackup = null, appliedAt = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-backup-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];

  writeFileSync(join(data, 'config.json'), JSON.stringify({
    server: { port: 17321 },
    memory: { retention: { factsMode: 'off', journalMode: 'off', appliedAt } },
  }), 'utf8');
  writeFileSync(join(data, 'memory.json'), JSON.stringify({
    global: [SIMILAR],
    chats: {},
    meta: { global: { [SIMILAR]: { w: 2, at: OLD, src: null } }, chats: {} },
    personas: {}, authz: {},
  }, null, 2), 'utf8');

  if (retentionBackup) {
    mkdirSync(join(data, 'backups'), { recursive: true });
    writeFileSync(join(data, 'backups', 'pre-retention-2026-11-08.json'),
      JSON.stringify(retentionBackup, null, 2), 'utf8');
  }
  if (stage) {
    mkdirSync(join(data, '.restore'), { recursive: true });
    for (const [name, content] of Object.entries(stage.files)) {
      writeFileSync(join(data, '.restore', name), content, 'utf8');
    }
    writeFileSync(join(data, '.restore-pending.json'), JSON.stringify({
      at: Date.now(), files: Object.keys(stage.files).length,
      createdAt: '2026-11-08T00:00:00.000Z', dataDir: stage.oldDataDir || data,
    }), 'utf8');
  }

  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = typeof cb === 'function' ? cb() : null;
      if (typeof off === 'function') cleanups.push(off);
      return noop;
    },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?bak=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body, method = 'POST', raw = false) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { this.body = raw ? s : JSON.parse(s); },
    };
    const req = {
      method, url: path,
      headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); },
    };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res;
  };
  const quick = (op, arg) => call('/roost/api/quick', { op, arg });
  return {
    quick, call, data,
    cfg: () => JSON.parse(readFileSync(join(data, 'config.json'), 'utf8')),
    mem: () => JSON.parse(readFileSync(join(data, 'memory.json'), 'utf8')),
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

const backupPayload = () => ({
  at: Date.now(),
  facts: [{
    id: FACT, text: FACT, scope: 'global', chatId: '',
    w: 1, at: OLD, src: null, until: 0, expiredBy: '',
  }],
  journal: [{
    id: 'j-old', at: OLD, day: '2026-04-22', chatId: 'g1', sender: '甲',
    role: 'user', text: '那天聊了很久', level: 'important', kind: 'chat',
    digest: null, keepUntil: 0, accessed: 7, lastAccess: OLD,
    vec: null, eventIds: ['e1'], evidence: [], invalidAt: 0, supersededBy: '',
  }],
});

test('启动时恢复挂在 loadConfig() 之前（源码切片 + 真行为）', async (t) => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const atRestore = src.indexOf('applyPendingRestore({ root: dataDir() })');
  const atLoad = src.indexOf('let cfg = loadConfig();');
  assert.ok(atRestore > 0, 'applyPendingRestore 没接进 host');
  assert.ok(atRestore < atLoad, '恢复必须在第一次 loadConfig() 之前');

  const b = await boot({
    stage: {
      files: {
        'config.json': JSON.stringify({ server: { port: 19999 }, memory: { retention: { appliedAt: 0 } } }),
        'memory.json': JSON.stringify({ global: ['从备份来的'], chats: {}, meta: { global: {}, chats: {} } }),
      },
    },
  });
  t.after(b.done);
  assert.equal(b.cfg().server.port, 19999, '盘上配置已被换上');
  assert.deepEqual(b.mem().global, ['从备份来的']);
  assert.equal(existsSync(join(b.data, '.restore')), false);
  assert.equal(existsSync(join(b.data, '.restore-pending.json')), false);
  const keeps = readdirSync(join(b.data, 'backups')).filter((n) => n.startsWith('pre-restore-'));
  assert.equal(keeps.length, 1);
  assert.equal(JSON.parse(readFileSync(join(b.data, 'backups', keeps[0], 'config.json'), 'utf8')).server.port, 17321);
});

test('backup.list 只读清单与待生效恢复状态', async (t) => {
  const b = await boot({ retentionBackup: backupPayload() });
  t.after(b.done);
  const r = await b.quick('backup.list');
  assert.equal(r.body.ok, true);
  assert.ok(r.body.items.some((x) => x.kind === 'retention' && x.name.startsWith('pre-retention-')));
  const m = await b.call('/roost/api/memory', null, 'GET');
  assert.equal(m.body.ok, true);
  assert.ok(Array.isArray(m.body.backups));
  assert.ok(m.body.backups.some((x) => x.label === '记忆淡出前的原文'));
});

test('按份还原：原样插回、不误伤相似事实、幂等、停自动 sweep', async (t) => {
  const b = await boot({ retentionBackup: backupPayload(), appliedAt: 123456 });
  t.after(b.done);

  const r = await b.quick('backup.restoreRetention', { name: 'pre-retention-2026-11-08.json' });
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(r.body.facts, 1);
  assert.equal(r.body.journal, 1);
  assert.equal(r.body.skipped, 0);
  assert.equal(r.body.autoSweep, false, '还原后不能重开自动淡出');
  assert.equal(b.cfg().memory.retention.appliedAt, 0, '凭据要撤掉');

  const m = b.mem();
  assert.ok(m.global.includes(FACT), '旧事实已插回');
  assert.equal(m.meta.global[FACT].w, 1, '权重原样保留');
  assert.equal(m.meta.global[FACT].at, OLD);
  assert.ok(!m.meta.global[SIMILAR].until, '不能顺手作废相似活事实（不走 supersede）');

  // journal 行保留 accessed / level / invalidAt，不是 add() 重算过的新行
  const j = createJournal({ file: join(b.data, 'journal.sqlite'), log: () => {} });
  const row = j.get('j-old');
  assert.ok(row, '日记行已插回');
  assert.equal(row.accessed, 7);
  assert.equal(row.level, 'important');
  assert.equal(row.text, '那天聊了很久');
  j.close();

  // 重复还原：全部 skipped，不产生第二行
  const again = await b.quick('backup.restoreRetention', { name: 'pre-retention-2026-11-08.json' });
  assert.equal(again.body.facts, 0);
  assert.equal(again.body.journal, 0);
  assert.equal(again.body.skipped, 2);
  assert.equal(b.mem().global.filter((x) => x === FACT).length, 1);
});

test('还原的名字过白名单：路径穿越被拒，不读备份目录外的文件', async (t) => {
  const b = await boot({ retentionBackup: backupPayload() });
  t.after(b.done);
  const bad = await b.quick('backup.restoreRetention', { name: '../config.json' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.message, /不是一份记忆淡出备份/);
  const missing = await b.quick('backup.restoreRetention', { name: 'pre-retention-nope.json' });
  assert.equal(missing.statusCode, 404);
});

test('cancelRestore 取消待生效恢复，不动现有数据', async (t) => {
  const b = await boot({
    stage: { files: { 'memory.json': JSON.stringify({ global: ['换上来的'], chats: {}, meta: { global: {}, chats: {} } }) } },
  });
  t.after(b.done);
  // 启动时已应用过一次，这里重新放一份 pending 再取消
  mkdirSync(join(b.data, '.restore'), { recursive: true });
  writeFileSync(join(b.data, '.restore', 'memory.json'), '{"global":[]}', 'utf8');
  writeFileSync(join(b.data, '.restore-pending.json'), JSON.stringify({ at: Date.now(), files: 1 }), 'utf8');
  const before = readFileSync(join(b.data, 'memory.json'), 'utf8');
  const r = await b.quick('backup.cancelRestore');
  assert.equal(r.body.ok, true);
  assert.match(r.body.message, /已取消/);
  assert.equal(readFileSync(join(b.data, 'memory.json'), 'utf8'), before);
  assert.equal(existsSync(join(b.data, '.restore')), false);
});

test('/backup/export 真返回 zip 二进制，不是 JSON', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.call('/roost/api/backup/export', null, 'GET', true);
  assert.equal(r.statusCode, 200);
  assert.ok(Buffer.isBuffer(r.body), '下载体必须是 Buffer');
  assert.equal(r.body.subarray(0, 4).toString('hex'), '504b0304', 'zip 文件头 PK\\x03\\x04');
  assert.match(r.headers['content-type'] || '', /application\/zip/);
  assert.match(r.headers['content-disposition'] || '', /attachment/);
});

test('完整包里带着行级备份，恢复后清单仍看得见（统一包格式）', async (t) => {
  const b = await boot({ retentionBackup: backupPayload() });
  t.after(b.done);
  const exp = await b.call('/roost/api/backup/export', null, 'GET', true);
  // 把导出的 zip 落盘，用 stageRestore 解到一个新数据目录
  const zip = join(b.data, 'backups', 'exported.zip');
  writeFileSync(zip, exp.body);
  const { stageRestore, listBackups } = await import('../src/backup.js');
  const target = mkdtempSync(join(tmpdir(), 'roost-restore-target-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const st = stageRestore({ zip, root: target });
  assert.equal(st.ok, true);
  assert.ok(existsSync(join(target, '.restore', 'backups', 'pre-retention-2026-11-08.json')),
    '行级备份要一起解到暂存区');
  const { applyPendingRestore } = await import('../src/backup.js');
  const r = applyPendingRestore({ root: target, now: 1700000000099 });
  assert.ok(r.applied >= 2);
  assert.ok(listBackups(target).some((x) => x.kind === 'retention'), '行级备份随整包一起回来了');
  assert.ok(existsSync(join(target, 'backups', 'pre-retention-2026-11-08.json')));
});

test('P1 回归：vec 经备份 JSON 往返后仍能算余弦（Uint8Array → 数字键对象）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-vec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const { createJournal, cosine } = await import('../src/journal.js');
  const src = createJournal({ file: join(dir, 'a.sqlite'), log: () => {} });
  src.add({ id: 'v1', at: Date.now(), chatId: 'g1', kind: 'chat', text: '带向量的一行' });
  src.setVec('v1', [0.1, 0.2, 0.3, 0.4]);
  const row = src.get('v1');
  assert.ok(row.vec, '源行得有 vec');
  src.close();

  /** 这就是 `backupRetention()` 里 `JSON.stringify` 之后备份文件里的形状 */
  const wire = JSON.parse(JSON.stringify(row));
  assert.equal(typeof wire.vec, 'object');
  assert.equal(Buffer.isBuffer(wire.vec), false);
  assert.ok(Object.keys(wire.vec).every((k) => /^\d+$/.test(k)), 'node:sqlite 的 BLOB 会变成数字键对象');

  const back = createJournal({ file: join(dir, 'b.sqlite'), log: () => {} });
  assert.equal(back.insertRaw(wire), true, '原样插回要成功');
  const restored = back.get('v1');
  assert.ok(restored.vec, 'vec 不能丢');
  const v = back.vecOf(restored);
  assert.ok(v && v.length === 4, `向量维数不对：${v?.length}`);
  assert.ok(cosine(Float32Array.from([0.1, 0.2, 0.3, 0.4]), v) > 0.999, '还原后的向量要能算余弦');
  back.close();
});

test('P1 回归：导出时快照失败回 500，异常不穿透 handler', async (t) => {
  const b = await boot();
  t.after(b.done);
  /** 放一个 host 不会打开的坏 sqlite，createBackup 会对它做 VACUUM INTO 并抛错 */
  writeFileSync(join(b.data, 'broken.sqlite'), 'not a sqlite file');
  const r = await b.call('/roost/api/backup/export', null, 'GET');
  assert.equal(r.statusCode, 500, '不能让同步异常穿过 route 包装');
  assert.equal(r.body.ok, false);
  assert.match(r.body.message, /备份没生成/);
});
