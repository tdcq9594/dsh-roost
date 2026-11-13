/**
 * D10 offpeak：峰谷判据 + host 可见性。
 *
 * 报告标「可做可不做」，本轮只做「显式化 + 可观测」，**不改调度**。
 * 所以这里除了判据本身，还要锁死一件事：/mind 能看到状态，
 * 但默认配置下没有任何后台任务因为它而被推迟（见 host.js 的 consolidateTick）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OFFPEAK_DEFAULTS, hourIsOffpeak, offpeakState, shouldDeferHeavy,
  beijingParts, officialIsPeak, priceTierOf, CN_HOLIDAY_TABLE,
} from '../src/offpeak.js';

const HOUR = 3_600_000;
/** 固定到本地时间 14:30，避开时区边界 */
const at = (h, m = 30) => {
  const d = new Date(2026, 10, 8, h, m, 0);
  return d.getTime();
};

/**
 * 3.2 官方判据用的是北京时间，测试必须与时区无关。
 * 这些时刻的 UTC 值是写死的，对应的北京时间由此唯一确定：
 * `Date.UTC(y, m, d, 2)` = 北京时间当天 10:00（UTC+8）。
 */
const bjAt = (dateStr, hourBj = 10, minuteBj = 0) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hourBj - 8, minuteBj);
};

test('D10：默认谷时窗口 0–6 点，边界是左闭右开', () => {
  assert.equal(OFFPEAK_DEFAULTS.startHour, 0);
  assert.equal(OFFPEAK_DEFAULTS.endHour, 6);
  assert.equal(hourIsOffpeak(0), true);
  assert.equal(hourIsOffpeak(4), true, '巩固默认就在这个点');
  assert.equal(hourIsOffpeak(5), true);
  assert.equal(hourIsOffpeak(6), false);
  assert.equal(hourIsOffpeak(14), false);
  assert.equal(hourIsOffpeak(23), false);
});

test('D10：跨午夜窗口（22→6）与空窗口', () => {
  assert.equal(hourIsOffpeak(23, 22, 6), true);
  assert.equal(hourIsOffpeak(3, 22, 6), true);
  assert.equal(hourIsOffpeak(12, 22, 6), false);
  assert.equal(hourIsOffpeak(21, 22, 6), false);
  assert.equal(hourIsOffpeak(4, 3, 3), false, 'start=end 是空窗口，不当成全天放行');
});

test('D10：高峰期只要安静够久也算谷，但「没有活跃记录」不算', () => {
  const now = at(14);
  assert.equal(offpeakState({ now, lastActiveAt: 0 }).offpeak, false);
  assert.equal(offpeakState({ now, lastActiveAt: now - 19 * 60_000 }).offpeak, false, '19 分钟不算安静');
  const quiet = offpeakState({ now, lastActiveAt: now - 21 * 60_000 });
  assert.equal(quiet.offpeak, true);
  assert.equal(quiet.reason, '安静期');
  assert.equal(quiet.quiet, true);
  assert.equal(offpeakState({ now, lastActiveAt: now - 3 * HOUR, quietMinutes: 0 }).offpeak, false,
    'quietMinutes=0 关掉安静期');
});

test('D10：谷时窗口优先于安静期；shouldDeferHeavy 只看 offpeak', () => {
  const now = at(4);
  const s = offpeakState({ now, lastActiveAt: now });
  assert.equal(s.reason, '谷时窗口');
  assert.equal(s.hour, 4);
  assert.equal(shouldDeferHeavy(s), false);
  assert.equal(shouldDeferHeavy(offpeakState({ now: at(14), lastActiveAt: 0 })), true);
  assert.equal(shouldDeferHeavy(null), true, '没状态一律推迟，别默认放行');
});

test('D10：/mind 能看到峰谷状态，但调度没被它改动', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-offpeak-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const oldEnv = process.env.DSH_ROOST_DATA;
  process.env.DSH_ROOST_DATA = data;
  const cleanups = [];
  t.after(() => {
    for (const c of cleanups) { try { c(); } catch {} }
    if (oldEnv === undefined) delete process.env.DSH_ROOST_DATA;
    else process.env.DSH_ROOST_DATA = oldEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  const noop = () => {};
  const noopOff = () => noop;
  const routes = new Map();
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
  const host = await import(`../src/host.js?offpeak=${Date.now()}-${Math.random()}`);
  host.apply(ctx);

  const key = [...routes.keys()].find((k) => k.endsWith('/mind'));
  assert.ok(key, '/mind 路由没注册');
  const res = { statusCode: 0, setHeader() {}, end(s) { this.body = JSON.parse(s); } };
  await routes.get(key)({ method: 'GET', url: '/mind', headers: { host: '127.0.0.1:8931' } }, res);

  const s = res.body.offpeak;
  assert.ok(s && typeof s === 'object', '/mind 要给出峰谷状态');
  assert.equal(typeof s.hour, 'number');
  assert.equal(typeof s.offpeak, 'boolean');
  assert.equal(s.startHour, 0);
  assert.equal(s.endHour, 6);
  assert.equal(s.quietMinutes, 20);
  assert.equal(s.quiet, false, '刚启动没有 inbound，安静期不该被当成成立');
  assert.equal(s.offpeak, hourIsOffpeak(s.hour, 0, 6));
});

/* ============ 3.2：官方峰时判据（DeepSeek 官方口径，与计价同表） ============ */

test('3.2：beijingParts 把时间戳换成北京时间，日期会滚过午夜', () => {
  /** UTC 2026-01-05 16:30 = 北京 01-06 00:30 */
  const p = beijingParts(Date.UTC(2026, 0, 5, 16, 30));
  assert.equal(p.date, '2026-01-06');
  assert.equal(p.hour, 0);
  /** 2026-01-06 是周二（01-01 周四） */
  assert.equal(p.weekday, 2);
  assert.equal(p.date, beijingParts(Date.UTC(2026, 0, 5, 16, 30)).date, '同一时刻两次调用结果一致');
});

test('3.2：官方峰时——工作日 9–12/14–18 高峰，周末与节假日全天空闲', () => {
  /** 2026-01-05 周一（非节假日） */
  const mon = { date: '2026-01-05', weekday: 1 };
  assert.equal(officialIsPeak({ ...mon, hour: 9 }), true, '9 点整进峰');
  assert.equal(officialIsPeak({ ...mon, hour: 11 }), true);
  assert.equal(officialIsPeak({ ...mon, hour: 12 }), false, '12 点出峰（左闭右开）');
  assert.equal(officialIsPeak({ ...mon, hour: 13 }), false, '12–14 是午休空闲');
  assert.equal(officialIsPeak({ ...mon, hour: 14 }), true, '14 点进峰');
  assert.equal(officialIsPeak({ ...mon, hour: 17 }), true);
  assert.equal(officialIsPeak({ ...mon, hour: 18 }), false, '18 点出峰');
  assert.equal(officialIsPeak({ ...mon, hour: 3 }), false, '凌晨空闲');
  /** 周末全天空闲 */
  assert.equal(officialIsPeak({ date: '2026-01-10', hour: 10, weekday: 6 }), false, '周六');
  assert.equal(officialIsPeak({ date: '2026-01-11', hour: 15, weekday: 0 }), false, '周日');
  /** 节假日（元旦 1/1–1/3）全天空闲，即使是工作日位 */
  assert.equal(officialIsPeak({ date: '2026-01-02', hour: 10, weekday: 5 }), false, '元旦放假');
  /** 调休上班日（2/14 周六上班）按工作日判 */
  assert.equal(officialIsPeak({ date: '2026-02-14', hour: 10, weekday: 6 }), true, '调休上班日的周六 10 点是高峰');
  assert.equal(officialIsPeak({ date: '2026-02-14', hour: 20, weekday: 6 }), false, '调休日也只在工作窗口进峰');
  /** 表里没有的年份：退回只看周末 */
  assert.equal(officialIsPeak({ date: '2027-03-03', hour: 10, weekday: 3 }), true, '无表年份按工作日判');
});

test('3.2：priceTierOf 与官方判据同表同函数；节假日全天是空闲价', () => {
  assert.equal(priceTierOf({ now: bjAt('2026-01-05', 10) }), 'peak', '周一 10 点');
  assert.equal(priceTierOf({ now: bjAt('2026-01-05', 13) }), 'idle', '午休');
  assert.equal(priceTierOf({ now: bjAt('2026-01-10', 10) }), 'idle', '周六');
  assert.equal(priceTierOf({ now: bjAt('2026-10-02', 10) }), 'idle', '国庆放假');
  assert.equal(priceTierOf({ now: bjAt('2026-10-10', 10) }), 'peak', '调休上班日 10/10');
  /** 用户覆盖表：2027 年春节自行声明（表只内置核过源的 2026） */
  const u = { 2027: { holidays: ['2027-02-01'], workdays: [] } };
  assert.equal(priceTierOf({ now: bjAt('2027-02-01', 10), holidays: u }), 'idle', '覆盖表命中');
  assert.equal(priceTierOf({ now: bjAt('2027-03-03', 10), holidays: u }), 'peak', '覆盖表外的日子照常');
});

test('3.2：official 模式——峰时不算谷，空闲算谷；安静期在任何模式都成立', () => {
  const peakNow = bjAt('2026-01-05', 10); // 北京周一 10:00 高峰
  const idleNow = bjAt('2026-01-10', 10); // 北京周六 10:00 空闲
  const s1 = offpeakState({ now: peakNow, lastActiveAt: 0, mode: 'official' });
  assert.equal(s1.offpeak, false, '官方高峰不许跑重活');
  assert.equal(s1.reason, '官方高峰');
  assert.equal(s1.bjHour, 10);
  const s2 = offpeakState({ now: idleNow, lastActiveAt: 0, mode: 'official' });
  assert.equal(s2.offpeak, true, '官方空闲=谷');
  assert.equal(s2.reason, '官方空闲时段');
  /** 高峰但安静了 30 分钟：本地实据优先 */
  const s3 = offpeakState({ now: peakNow, lastActiveAt: peakNow - 30 * 60_000, mode: 'official' });
  assert.equal(s3.offpeak, true);
  assert.equal(s3.reason, '安静期');
  /** 同一时刻 self 模式（默认）走的是原判据：14 点窗口外+无活跃 = 高峰 */
  assert.equal(offpeakState({ now: bjAt('2026-01-05', 10), lastActiveAt: 0 }).offpeak, hourIsOffpeak(new Date(bjAt('2026-01-05', 10)).getHours(), 0, 6));
});
