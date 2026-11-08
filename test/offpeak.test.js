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
} from '../src/offpeak.js';

const HOUR = 3_600_000;
/** 固定到本地时间 14:30，避开时区边界 */
const at = (h, m = 30) => {
  const d = new Date(2026, 10, 8, h, m, 0);
  return d.getTime();
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
