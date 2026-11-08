/**
 * D11 接线的集成测试：确认 host.js 真的把双路 retention 挂上了。
 *
 * 纯函数的边界在 dry-run.test.js、数据层在 retention-store.test.js；
 * 这里盯四件最容易「代码写了但没接上」的事：
 *   · 开关能看能改，两路互不干扰；
 *   · 预览是纯读，默认开的档位**不会自动改盘上数据**；
 *   · 应用分 expire / purge，purge 前必备份且备份带原文；
 *   · 一键恢复只放本功能作废的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';

const noop = () => () => {};
const DAY = 86400000;
const OLD = Date.now() - 200 * DAY;
const FACT = '约定：很久没提的旧约定';

async function boot({ factsMode = 'expire', journalMode = 'off', seedJournal = true, seedFacts = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-ret-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];

  writeFileSync(join(data, 'config.json'), JSON.stringify({
    memory: { retention: { factsMode, journalMode, thresholdPct: 5, minProtectDays: 0 } },
  }), 'utf8');

  const mfile = join(data, 'memory.json');
  if (seedFacts) {
    writeFileSync(mfile, JSON.stringify({
      global: [FACT],
      chats: {},
      meta: { global: { [FACT]: { w: 1, at: OLD, src: null } }, chats: {} },
      personas: {}, authz: {},
    }, null, 2), 'utf8');
  }
  if (seedJournal) {
    const j = createJournal({ file: join(data, 'journal.sqlite'), log: () => {} });
    j.add({ id: 'j1', at: OLD, chatId: 'g1', sender: '甲', role: 'user', kind: 'chat', text: '今天随口聊了几句', level: 'normal' });
    j.close();
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
  const host = await import(`../src/host.js?ret=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body, method = 'POST') => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      method,
      url: path,
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
    quick, call, data, mfile,
    mem: () => (existsSync(mfile) ? readFileSync(mfile, 'utf8') : null),
    backups: () => {
      const d = join(data, 'backups');
      return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith('pre-retention-')) : [];
    },
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
    },
  };
}

test('D11：四个开关都上线了，两路能各自单独改', async (t) => {
  const b = await boot();
  t.after(b.done);
  const all = await b.quick('features.get');
  assert.equal(all.body.ok, true);
  for (const id of ['retentionFactsMode', 'retentionJournalMode', 'retentionThresholdPct', 'retentionMinProtectDays']) {
    assert.ok(all.body.features.some((f) => f.id === id), `${id} 该出现在能力页`);
  }
  assert.equal(all.body.settings.retentionFactsMode, 'expire');
  assert.equal(all.body.settings.retentionJournalMode, 'off');
  const p = await b.quick('features.patch', { id: 'retentionFactsMode', value: 'off' });
  assert.equal(p.body.ok, true, `patch 被拒：${p.body.message}`);
  assert.equal(p.body.value, 'off');
  const again = await b.quick('features.get');
  assert.equal(again.body.settings.retentionFactsMode, 'off');
  assert.equal(again.body.settings.retentionJournalMode, 'off', '改 facts 不能顺带改 journal');
});

test('D11：预览是纯读，默认开的档位没点应用前盘上一条记忆都不变', async (t) => {
  const b = await boot();
  t.after(b.done);
  const before = b.mem();
  const pv = await b.quick('features.preview');
  assert.equal(pv.body.ok, true);
  assert.equal(pv.body.facts.mode, 'expire');
  assert.equal(pv.body.facts.affected, 1);
  assert.equal(pv.body.journal.enabled, false, '默认 journal 关，一步都不该跑');
  assert.equal(pv.body.journal.affected, 0);
  assert.equal(pv.body.affected, 1);
  assert.match(pv.body.text, /事实 1 条/);
  assert.equal(pv.body.expiredFacts, 0);
  assert.equal(b.mem(), before, '预览不该写盘');
  assert.equal(b.backups().length, 0, '没到 purge 就不该产生备份文件');
});

test('D11：应用只作废不删行，再预览不重复算，一键恢复放得回来', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('retention.apply');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(r.body.facts.expired, 1);
  assert.equal(r.body.facts.purged, 0);
  assert.equal(r.body.journal.expired, 0, 'journal 关着，一行都不许动');
  const after = JSON.parse(b.mem());
  assert.equal(after.global.length, 1, '原文还留在库里');
  assert.ok(after.meta.global[FACT].until > 0);
  assert.equal(after.meta.global[FACT].expiredBy, 'retention');

  const pv2 = await b.quick('features.preview');
  assert.equal(pv2.body.facts.affected, 0, '已作废的不该再算一次');
  assert.equal(pv2.body.expiredFacts, 1);

  const back = await b.quick('retention.restore');
  assert.equal(back.body.ok, true);
  assert.equal(back.body.facts, 1);
  const restored = JSON.parse(b.mem());
  assert.equal(restored.meta.global[FACT].until, undefined);
  assert.equal(restored.meta.global[FACT].expiredBy, undefined);
});

test('D11：只开 journal 一路时，facts 一条都不动', async (t) => {
  const b = await boot({ factsMode: 'off', journalMode: 'expire' });
  t.after(b.done);
  const before = b.mem();
  const pv = await b.quick('features.preview');
  assert.equal(pv.body.facts.enabled, false);
  assert.equal(pv.body.facts.affected, 0);
  assert.equal(pv.body.journal.affected, 1);
  const r = await b.quick('retention.apply');
  assert.equal(r.body.facts.expired, 0);
  assert.equal(r.body.journal.expired, 1);
  assert.equal(b.mem(), before, 'facts 盘上逐字节不变');
  const back = await b.quick('retention.restore');
  assert.equal(back.body.journal, 1);
});

test('D11：purge 前必备份，备份带原文，真删后行确实没了', async (t) => {
  const b = await boot({ factsMode: 'purge' });
  t.after(b.done);
  const r = await b.quick('retention.apply');
  assert.equal(r.body.ok, true, r.body.message);
  assert.equal(r.body.facts.purged, 1);
  assert.ok(r.body.backup, '要返回备份文件名');
  const files = b.backups();
  assert.equal(files.length, 1);
  const snap = JSON.parse(readFileSync(join(b.data, 'backups', files[0]), 'utf8'));
  assert.equal(snap.facts[0].text, FACT, '备份必须带原文，不能只存 id');
  const after = JSON.parse(b.mem());
  assert.equal(after.global.length, 0, '真删把行去掉了');
  assert.equal(after.meta.global[FACT], undefined);
});
