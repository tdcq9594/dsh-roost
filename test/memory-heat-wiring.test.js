/**
 * G8 注入热度接线：真 memory 实例端到端（迁移→heatOf→planHeat→bumpHeat→再读）
 * + 静态契约钉住 host 的"只有 live:true 真实注入才记账，预览不涨"。
 *
 * provider.text() 的活体测试需要完整 mount(agent, chat) 上下文（workspace/session/turn），
 * 这里用 memory 层链路 + host 源码契约覆盖，避免假宿主把测试带偏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/memory.js';
import { planHeat } from '../src/memory-heat.js';

const noop = () => {};

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-heat-'));
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    global: ['主人住在杭州', '次要的事'],
    chats: {},
    meta: {
      global: {
        '主人住在杭州': { w: 2, at: Date.now() - 86400e3 },
        '次要的事': { w: 1, at: Date.now() - 86400e3 },
      },
      chats: {},
    },
    personas: {}, authz: {},
  }), 'utf8');
  return {
    dir,
    done: () => {
      if (old === undefined) delete process.env.DSH_ROOST_DATA;
      else process.env.DSH_ROOST_DATA = old;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

test('G8 端到端：v1 迁移→注入涨 hitDays→同日不重复→热度写盘', () => {
  const f = fresh();
  try {
    const m = createMemory({ log: noop, now: () => Date.parse('2026-11-24T12:00:00') });
    assert.equal(m.migrateIfNeeded().migrated, true, '老库一次性适配');

    // 模拟 memoryStatic 注入了这两条（live:true 路径）
    const injected = ['主人住在杭州', '次要的事'];
    let prev = { recent: [] };
    const round1 = planHeat({ injected, heat: m.heatOf(injected), recent: prev.recent }, { now: Date.parse('2026-11-24T12:00:00') });
    assert.equal(round1.updates.length, 2);
    assert.equal(m.bumpHeat(round1.updates), 2);
    prev = { recent: round1.recent };

    const disk1 = JSON.parse(readFileSync(join(f.dir, 'memory.json'), 'utf8'));
    assert.equal(disk1.meta.global['主人住在杭州'].hitDays, 1, '热度落盘');
    assert.ok(disk1.meta.global['主人住在杭州'].lastHitDay, '记自然日');

    // 同一天再注入：planHeat 挡住，不再涨
    const round2 = planHeat({ injected, heat: m.heatOf(injected), recent: prev.recent }, { now: Date.parse('2026-11-24T18:00:00') });
    assert.equal(round2.updates.length, 0, '同日+最近窗口双重挡住');
    assert.equal(m.bumpHeat(round2.updates), 0);
    const disk2 = JSON.parse(readFileSync(join(f.dir, 'memory.json'), 'utf8'));
    assert.equal(disk2.meta.global['主人住在杭州'].hitDays, 1);
  } finally { f.done(); }
});

test('G8：hitDays 拉长 τ 后 brightness 提高（双信号分工生效）', () => {
  const f = fresh();
  try {
    const m = createMemory({ log: noop, now: () => Date.parse('2026-11-24T12:00:00') });
    const before = m.listFull('').global.find((x) => x.text === '主人住在杭州').brightness;
    m.bumpHeat([{ text: '主人住在杭州', hitDays: 5, lastHitDay: '2026-11-24', lastHit: Date.parse('2026-11-24T12:00:00') }]);
    const after = m.listFull('').global.find((x) => x.text === '主人住在杭州').brightness;
    assert.ok(after > before, `常被想起更亮：${before} → ${after}`);
  } finally { f.done(); }
});

test('G8 静态契约：只有 live:true 真实注入记账，面板预览走无 live 路径', () => {
  const host = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(host, /if \(live === true && chatId\)/, '热度记账只在 live 注入分支');
  assert.match(host, /planHeat\(\{ injected: keys, heat, recent: prev\.recent \}/, '接线调用 planHeat（剥 annotate 后缀的 key）');
  assert.match(host, /memory\.bumpHeat\(plan\.updates, \{ scope: batch\.scope/, '热度按 scope 精确写回（不跨群串场）');
  assert.match(host, /t\.replace\(\/（听说的）\$\/, ''\)/, '剥掉 annotate 后缀再记账');
  assert.match(host, /memoryStatic\(panelChat, forced\)/, '面板预览仍走无 live 的 memoryStatic');
});

test('G8 跨群不串场：A/B 群同名 fact，A 群注入只涨 A 群的热度', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-heat-cross-'));
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  try {
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({
      global: [],
      chats: { gA: ['群里聊游戏'], gB: ['群里聊游戏'] },
      meta: {
        global: {},
        chats: {
          gA: { '群里聊游戏': { w: 1, at: Date.now() } },
          gB: { '群里聊游戏': { w: 1, at: Date.now() } },
        },
      },
      personas: {}, authz: {}, schemaVersion: 2,
    }), 'utf8');
    const m = createMemory({ log: noop });
    const injected = ['群里聊游戏'];
    // A 群注入：heatOf/bumpHeat 都按 scope+chatId 精确定位
    const heatA = m.heatOf(injected, { scope: 'chat', chatId: 'gA' });
    const planA = planHeat({ injected, heat: heatA, recent: [] }, { now: Date.now() });
    assert.equal(m.bumpHeat(planA.updates, { scope: 'chat', chatId: 'gA' }), 1);

    const disk = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
    assert.equal(disk.meta.chats.gA['群里聊游戏'].hitDays, 1, 'A 群涨了');
    assert.equal(disk.meta.chats.gB['群里聊游戏'].hitDays, undefined, 'B 群同名 fact 不受影响');

    // B 群 heatOf 读到的仍是 0（不会被 A 群热度串过去）
    assert.deepEqual(m.heatOf(injected, { scope: 'chat', chatId: 'gB' }), {}, 'B 群读不到 A 群热度');
  } finally {
    if (old === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = old;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('G8 annotate 后缀不占 recent 窗口：听说/普通切换仍能配上也只涨一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-heat-anno-'));
  const old = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = dir;
  try {
    writeFileSync(join(dir, 'memory.json'), JSON.stringify({
      global: ['听说的事'], chats: {},
      meta: { global: { '听说的事': { w: 1, at: Date.now(), status: 'hearsay' } }, chats: {} },
      personas: {}, authz: {}, schemaVersion: 2,
    }), 'utf8');
    const m = createMemory({ log: noop });
    const today = Date.now();
    // 第一轮：annotate 后的文本
    const p1 = planHeat({ injected: ['听说的事（听说的）'], heat: m.heatOf(['听说的事（听说的）']), recent: [] }, { now: today });
    assert.equal(p1.updates.length, 1, '剥后缀后能找到 meta');
    m.bumpHeat(p1.updates);
    // 第二轮：status 变成普通，注入文本没后缀，但 recent 里是剥过后缀的 key → 仍被挡
    const p2 = planHeat({ injected: ['听说的事'], heat: m.heatOf(['听说的事']), recent: p1.recent }, { now: today + 1000 });
    assert.equal(p2.updates.length, 0, '后缀切换不绕过防霸榜/自然日去重');
    assert.equal(m.heatOf(['听说的事'])['听说的事'].hitDays, 1, '热度记在原文 key 上');
  } finally {
    if (old === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = old;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
