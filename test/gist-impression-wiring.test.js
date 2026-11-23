/**
 * §1.10 Gist 两档接线测试：确认 gist.impression.* 真挂在 host 上，
 * 且 dry 不写盘、结晶走 memory.add、scope fail-closed。
 *
 * 模型生成走 backgroundGenerate（真 host 依赖配置里的模型，测试里不接真模型）：
 *   · dry 预览：验证能从 journal 旧 digest 收出待压数据 + prompt，不写印象文件；
 *   · 无模型：generate 返回明确错误，不静默降级；
 *   · 结晶/清空/列表：不依赖模型，端到端跑通。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import { scopeOfOp } from '../src/ext-quick-scopes.js';

const noop = () => {};
const OLD = Date.now() - 200 * 86400_000;

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-gist-wire-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];

  // 预置：两条够旧的 digest + 一条新鲜的（新鲜的不该被收）
  const j = createJournal({ file: join(data, 'journal.sqlite'), log: noop });
  j.add({ id: 'd1', at: OLD, day: new Date(OLD).toISOString().slice(0, 10), chatId: 'g1', role: 'digest', kind: 'digest', level: 'important', text: '对方提醒我文件容易丢，记得保存' });
  j.add({ id: 'd2', at: OLD + 1000, day: new Date(OLD + 1000).toISOString().slice(0, 10), chatId: 'g1', role: 'digest', kind: 'digest', level: 'important', text: '群里又聊起游戏版本兼容' });
  j.add({ id: 'fresh', at: Date.now(), day: new Date().toISOString().slice(0, 10), chatId: 'g1', role: 'digest', kind: 'digest', level: 'important', text: '今天的摘要' });
  j.close();

  writeFileSync(join(data, 'config.json'), JSON.stringify({ server: { port: 17331 }, memory: {} }), 'utf8');
  writeFileSync(join(data, 'memory.json'), JSON.stringify({ global: [], chats: {}, meta: { global: {}, chats: {} }, personas: {}, authz: {} }), 'utf8');
  writeFileSync(join(data, 'impressions.json'), JSON.stringify({
    imps: [{ id: 'imp:old', text: '对方很细心', at: OLD, chatId: 'g1', hits: 0, crystallizedAt: 0, sourceKey: 'gist:g1' }],
    done: {},
  }), 'utf8');

  const routes = new Map();
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => { if (typeof cb === 'function') { const off = cb(); if (typeof off === 'function') cleanups.push(off); } return noop; },
    on: () => noop,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?gist=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = JSON.parse(s); } };
    const req = { method: 'POST', url: path, headers: { host: '127.0.0.1:8931' }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const h = routes.get(path);
    assert.ok(h, `路由没注册：${path}`);
    await h(req, res);
    return res.body;
  };
  const quick = (op, arg) => call('/roost/api/quick', { viaExt: '@panel', op, arg });
  return {
    quick, data,
    imps: () => JSON.parse(readFileSync(join(data, 'impressions.json'), 'utf8')),
    mem: () => JSON.parse(readFileSync(join(data, 'memory.json'), 'utf8')),
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('gist.impression.list 返回印象 + 结晶候选（真 host）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const r = await b.quick('gist.impression.list', {});
  assert.equal(r.ok, true, r.message);
  assert.equal(r.impressions.length, 1);
  assert.equal(r.impressions[0].text, '对方很细心');
  assert.equal(r.candidates.length, 0, 'hits=0 时不进候选（结晶靠真实「又想起」驱动）');
});

test('gist.impression.hit：显式想起驱动 hits，攒够才进结晶候选（真 host）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const h1 = await b.quick('gist.impression.hit', { id: 'imp:old' });
  assert.equal(h1.ok, true);
  assert.equal(h1.hits, 1);
  const h2 = await b.quick('gist.impression.hit', { id: 'imp:old' });
  const h3 = await b.quick('gist.impression.hit', { id: 'imp:old' });
  assert.equal(h3.hits, 3);
  const list = await b.quick('gist.impression.list', {});
  assert.equal(list.candidates.length, 1, '3 次想起后才进候选');
  assert.equal(b.imps().imps[0].hits, 3, '真落盘');
});

test('gist.impression.generate dry：从旧 digest 收数据 + prompt，不写盘（真 host）', async (t) => {
  const b = await boot();
  t.after(b.done);
  const before = readFileSync(join(b.data, 'impressions.json'), 'utf8');
  const r = await b.quick('gist.impression.generate', { dry: true, days: 180 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.dry, true);
  assert.ok(r.groups.length >= 1);
  const g = r.groups.find((x) => x.chatId === 'g1');
  assert.equal(g.count, 2, '只收两条够旧的 digest，新鲜那条不收');
  assert.match(g.prompt, /第一人称/);
  assert.match(g.prompt, /不是指令/);
  assert.equal(readFileSync(join(b.data, 'impressions.json'), 'utf8'), before, 'dry 一个字节都不写');
});

test('gist.impression.generate 无模型：逐组明确失败，不静默写盘', async (t) => {
  const b = await boot();
  t.after(b.done);
  const before = readFileSync(join(b.data, 'impressions.json'), 'utf8');
  const r = await b.quick('gist.impression.generate', { days: 180 });
  // backgroundGenerate 总存在，但没配 agent 时 turns.run 会抛错 → 每组报 ok:false，
  // 顶层 ok:true（逐组报告，跟 mind.refresh 一致）。关键是失败可见、不写盘。
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.results) && r.results.length >= 1);
  assert.ok(r.results.every((x) => x.ok === false && x.reason), '每组都有明确失败原因');
  assert.equal(readFileSync(join(b.data, 'impressions.json'), 'utf8'), before, '失败不写盘');
});

test('gist.impression.crystallize：候选写进 memory + 标记已结晶（真 host）', async (t) => {
  const b = await boot();
  t.after(b.done);
  // 真实路径：先点 3 次「又想起」，hits 攒够才结晶（不再手工塞 hits）
  const zero = await b.quick('gist.impression.crystallize', { days: 180 });
  assert.equal(zero.added, 0, 'hits=0 时结晶 added:0');
  for (let i = 0; i < 3; i++) await b.quick('gist.impression.hit', { id: 'imp:old' });
  const r = await b.quick('gist.impression.crystallize', { days: 180 });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.added, 1);
  const m = b.mem();
  assert.match(JSON.stringify(m.chats?.g1 || []), /对方很细心/, '印象结晶回来源群 g1');
  assert.ok(!JSON.stringify(m.global || []).includes('对方很细心'), '不污染全局事实');
  assert.ok(b.imps().imps[0].crystallizedAt > 0, '标记已结晶');
  const again = await b.quick('gist.impression.crystallize', { days: 180 });
  assert.equal(again.added, 0, '重复结晶不重复加');
});

test('结晶全局印象写 global scope，不造 m.chats["global"] 伪会话（真 host）', async (t) => {
  const b = await boot();
  t.after(b.done);
  // 把种子印象改成全局（chatId=''）+ 攒够 hits
  const st = b.imps();
  st.imps[0].chatId = '';
  st.imps[0].hits = 3;
  writeFileSync(join(b.data, 'impressions.json'), JSON.stringify(st), 'utf8');
  const r = await b.quick('gist.impression.crystallize', { days: 180 });
  assert.equal(r.added, 1);
  const m = b.mem();
  assert.match(JSON.stringify(m.global || []), /对方很细心/, '全局印象进 global 事实');
  assert.ok(!(m.chats || {}).global, '不造 chats["global"] 伪会话（无人能读到）');
});

test('gist.impression.crystallize dry：不写盘', async (t) => {
  const b = await boot();
  t.after(b.done);
  for (let i = 0; i < 3; i++) await b.quick('gist.impression.hit', { id: 'imp:old' });
  const before = readFileSync(join(b.data, 'impressions.json'), 'utf8');
  const r = await b.quick('gist.impression.crystallize', { dry: true, days: 180 });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].dry, true);
  assert.equal(readFileSync(join(b.data, 'impressions.json'), 'utf8'), before);
});

test('gist.impression.clear：只清 impressions.json，不碰 memory', async (t) => {
  const b = await boot();
  t.after(b.done);
  const memBefore = readFileSync(join(b.data, 'memory.json'), 'utf8');
  const r = await b.quick('gist.impression.clear', {});
  assert.equal(r.ok, true);
  assert.equal(b.imps().imps.length, 0);
  assert.equal(readFileSync(join(b.data, 'memory.json'), 'utf8'), memBefore, '不误伤记忆');
});

test('审计纯读排除：list 不写审计噪音，写操作保留', () => {
  const hostSrc = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const m = hostSrc.match(/if \(op && op !== 'memory\.list'[\s\S]*?\) audit\(\{ op,/);
  assert.ok(m, '找到 quick op 审计条件');
  assert.match(m[0], /op !== 'gist\.impression\.list'/, '纯读列表排除审计');
  assert.ok(!/op !== 'gist\.impression\.(generate|crystallize|clear)'/.test(m[0]), '写操作仍记审计');
});

test('scope 登记：list 只读、其余 memory:write（fail-closed）', () => {
  assert.equal(scopeOfOp('gist.impression.list').scope, 'memory:read');
  assert.equal(scopeOfOp('gist.impression.hit').scope, 'memory:write');
  assert.equal(scopeOfOp('gist.impression.generate').scope, 'memory:write');
  assert.equal(scopeOfOp('gist.impression.crystallize').scope, 'memory:write');
  assert.equal(scopeOfOp('gist.impression.clear').scope, 'memory:write');
});
