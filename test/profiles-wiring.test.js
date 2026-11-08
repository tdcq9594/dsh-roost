/**
 * D7 接线测试：确认「人档案」真的挂在了巩固 / 稳定段 / 面板上，
 * 而不只是多了一个没人调的模块。
 *
 * 纯数据层在 profiles.test.js；这里盯四件最容易「写了没接」的事：
 *   · 默认关时巩固 prompt 逐字节不变、不写盘、稳定段没有档案块；
 *   · 开着时凌晨巩固才提炼，openid 经 aliasesOf 归一；
 *   · 面板能只读查看 + 独立清空，且 `memory.clear` 不连带清档案（契约 §3④）；
 *   · 功能开关已上线（staged 删了），能看能改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJournal } from '../src/journal.js';
import { createMemory } from '../src/memory.js';
import { createProfiles } from '../src/profiles.js';
import { createConsolidate, yesterdayOf } from '../src/consolidate.js';

const noop = () => {};
const NOW = Date.now();

/* ---------------- 巩固这一侧 ---------------- */

function scene({ plan = {}, enabled = false, dry = false, seedProfiles = [], aliases = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-prof-cons-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;

  const day = yesterdayOf(NOW);
  const j = createJournal({ file: join(data, 'j.sqlite'), log: noop });
  j.add({ id: 'a', at: Date.parse(`${day}T10:00:00`), chatId: 'g1', sender: '小明', role: 'user', kind: 'chat', text: '又直接给了结论' });
  const m = createMemory();
  const p = createProfiles({ file: join(data, 'profiles.json') });
  for (const s of seedProfiles) p.note(s);

  const prompts = [];
  const generate = async (prompt) => { prompts.push(prompt); return JSON.stringify(plan); };
  const c = createConsolidate({
    journal: j, graph: null, memory: m, generate,
    aliasesOf: () => aliases, log: noop, now: () => NOW,
    profiles: p, profilesEnabled: () => enabled,
  });
  return {
    p, prompts,
    run: () => c.run({ day, dry }),
    file: join(data, 'profiles.json'),
    done: () => {
      try { j.close(); } catch {}
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

const PLAN = {
  summary: '聊了小明的说话方式',
  profiles: [{ who: '小明', openid: 'old-openid', impression: '说话直', tips: '先给结论' }],
};

test('D7：默认关时巩固 prompt 一个字都不变，也不写档案', async (t) => {
  const s = scene({ plan: PLAN, enabled: false, aliases: ['main-openid', 'old-openid'] });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.profiles, 0);
  assert.ok(s.prompts.length >= 1);
  assert.ok(!s.prompts[0].includes('8. profiles'));
  assert.ok(!s.prompts[0].includes('"profiles":['));
  assert.equal(s.p.size, 0);
  assert.equal(existsSync(s.file), false, '默认关等价：盘上零改动');
});

test('D7：开着时巩固才提炼，openid 经别名归一到主 id', async (t) => {
  const s = scene({ plan: PLAN, enabled: true, aliases: ['main-openid', 'old-openid'] });
  t.after(s.done);
  const r = await s.run();
  assert.equal(r.profiles, 1);
  assert.match(s.prompts[0], /8\. profiles/);
  assert.match(s.prompts[0], /"profiles":\[/);
  assert.equal(s.p.size, 1);
  assert.equal(s.p.recent()[0].key, 'main-openid');
  assert.equal(s.p.recent()[0].impression, '说话直');
  assert.equal(s.p.recent()[0].tips, '先给结论');
});

test('D7：已有档案进 prompt 让模型能改口，dry-run 只算不写', async (t) => {
  const seeded = scene({
    plan: PLAN, enabled: true, dry: true,
    seedProfiles: [{ who: '小明', openid: 'main-openid', impression: '以前挺委婉', aliases: ['main-openid'] }],
    aliases: ['main-openid'],
  });
  t.after(seeded.done);
  const r = await seeded.run();
  assert.equal(r.dry, true);
  assert.equal(r.profiles, 1, '预览也要报条数');
  assert.match(seeded.prompts[0], /已经写过的熟人档案/);
  assert.match(seeded.prompts[0], /以前挺委婉/);
  assert.deepEqual(seeded.p.recent().map((x) => x.impression), ['以前挺委婉'], 'dry 不许改已有档案');
});

/* ---------------- host 这一侧 ---------------- */

async function boot({ enabled = false, seedProfile = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'roost-prof-host-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];

  writeFileSync(join(data, 'config.json'), JSON.stringify({ profiles: { enabled } }), 'utf8');
  if (seedProfile) {
    writeFileSync(join(data, 'profiles.json'), JSON.stringify([
      { key: 'u1', name: '小明', impression: '说话直', tips: '先给结论', at: NOW, hits: 1 },
    ]), 'utf8');
  }

  const routes = new Map();
  const noopOff = () => noop;
  const ctx = {
    agents: { get: () => null, list: () => [], create: async () => ({ id: 'a', ctx: {} }) },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's' }) },
    systemPrompt: { context: () => noopOff },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noopOff; } },
    config: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    effect: (cb) => {
      const off = typeof cb === 'function' ? cb() : null;
      if (typeof off === 'function') cleanups.push(off);
      return noopOff;
    },
    on: () => noopOff,
    dataDir: data,
    dir,
  };
  const host = await import(`../src/host.js?prof=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const call = async (path, body, method = 'POST') => {
    const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
    const req = {
      method, url: path, headers: { host: '127.0.0.1:8931' },
      async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); },
    };
    const key = routes.has(path) ? path : [...routes.keys()].find((k) => k.endsWith(path));
    assert.ok(key, `路由没注册：${path}`);
    await routes.get(key)(req, res);
    return res;
  };
  const quick = (op, arg) => call('/roost/api/quick', { op, arg });
  return {
    quick, call, routes, data,
    file: join(data, 'profiles.json'),
    disk: () => (existsSync(join(data, 'profiles.json')) ? readFileSync(join(data, 'profiles.json'), 'utf8') : null),
    done: () => {
      for (const c of cleanups) { try { c(); } catch {} }
      if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = oldEnv;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

test('D7：默认关时稳定段没有档案块，但面板仍看得到旧数据', async (t) => {
  const b = await boot({ enabled: false });
  t.after(b.done);
  const mind = await b.call('/roost/api/mind', null, 'GET');
  assert.equal(mind.body.memoryStaticText.includes('熟人小档案'), false, '关着时一个字都不进 system prompt');
  assert.equal(mind.body.memoryStaticText.includes('小明'), false);

  const mem = await b.call('/roost/api/memory', null, 'GET');
  assert.equal(mem.body.profilesEnabled, false);
  assert.equal(mem.body.profiles.length, 1, '关着也要能查看，否则用户清不掉旧数据');
  assert.equal(mem.body.profiles[0].name, '小明');
});

test('D7：开着时档案进稳定段，且带防漏出/防串话的台头', async (t) => {
  const b = await boot({ enabled: true });
  t.after(b.done);
  const mind = await b.call('/roost/api/mind', null, 'GET');
  assert.match(mind.body.memoryStaticText, /熟人小档案/);
  assert.match(mind.body.memoryStaticText, /小明/);
  assert.match(mind.body.memoryStaticText, /只是印象，别原样念出来/);
  assert.match(mind.body.memoryStaticText, /别把别处的事当这个群发生过/);
  const mem = await b.call('/roost/api/memory', null, 'GET');
  assert.equal(mem.body.profilesEnabled, true);
});

test('D7：profiles.clear 独立生效，memory.clear 不连带清档案', async (t) => {
  const b = await boot({ enabled: true });
  t.after(b.done);
  const before = b.disk();
  assert.match(before, /小明/);

  const mc = await b.call('/roost/api/quick', { op: 'memory.clear', chatId: 'g1' });
  assert.equal(mc.body.ok, true, mc.body.message);
  assert.match(b.disk(), /小明/, '契约 §3④：跨群档案不挂会话级清空');

  const r = await b.quick('profiles.clear');
  assert.equal(r.body.ok, true);
  assert.deepEqual(JSON.parse(b.disk()), []);
  const mem = await b.call('/roost/api/memory', null, 'GET');
  assert.equal(mem.body.profiles.length, 0);
});

test('D7：开关已上线（staged 删了），能看也能改', async (t) => {
  const b = await boot({ enabled: false, seedProfile: false });
  t.after(b.done);
  const all = await b.quick('features.get');
  assert.equal(all.body.ok, true);
  assert.ok(all.body.features.some((f) => f.id === 'profiles'), '能力页要能看见这个开关');
  const p = await b.quick('features.patch', { id: 'profiles', on: true });
  assert.equal(p.body.ok, true, `patch 被拒：${p.body.message}`);
  /** 验盘上真相，不绑死 features.get 的返回形状（config.json 才是唯一真相） */
  const onDisk = JSON.parse(readFileSync(join(b.data, 'config.json'), 'utf8'));
  assert.equal(onDisk.profiles.enabled, true);
  assert.equal(existsSync(b.file), false, '只改开关不写数据文件');
});
