// 4.6 互动召回 is_wakeup。
//
// 周期规则来自 QQ 开放平台官方文档（2026-11-13 用户给的截图）：
// 「用户主动与机器人对话之后，未来 30 天内可下发互动召回消息，
//   每个周期内可下发一条：当天、1–3 天、3–7 天、7–30 天，合计 4 个周期」。
// 这不是等分的 4 段，也不是按绝对时间切——做错就是超发违规，所以逐条钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WAKEUP_WINDOWS, WAKEUP_DEFAULTS,
  wakeupCycleOf, wakeupPlan, createWakeupLedger,
} from '../src/wakeup.js';

const DAY = 86_400_000;
/** 固定一个北京时间白天（15:00 CST = 07:00 UTC），避开 9–22 点之外的时段 */
const NOW = Date.UTC(2026, 10, 13, 7, 0, 0);
const ON = { ...WAKEUP_DEFAULTS, enabled: true, idleHours: 0 };

test('官方四个窗口：当天 / 1–3 天 / 3–7 天 / 7–30 天，边界左闭右开', () => {
  assert.deepEqual(WAKEUP_WINDOWS.map((w) => w.label), ['当天', '1–3 天', '3–7 天', '7–30 天']);
  const cases = [
    [0, 0, '当天'], [0.9, 0, '当天'],
    [1, 1, '1–3 天'], [2.9, 1, '1–3 天'],
    [3, 2, '3–7 天'], [6.9, 2, '3–7 天'],
    [7, 3, '7–30 天'], [29.9, 3, '7–30 天'],
  ];
  for (const [days, cycle, label] of cases) {
    const r = wakeupCycleOf(NOW, NOW - days * DAY);
    assert.equal(r.within, true, `${days} 天该有窗口`);
    assert.equal(r.cycle, cycle, `${days} 天落在第 ${cycle} 档`);
    assert.equal(r.label, label);
  }
  /** 30 天整就没额度了：不能靠时钟一直开新窗口 */
  assert.equal(wakeupCycleOf(NOW, NOW - 30 * DAY).within, false, '超过 30 天不能发');
  assert.equal(wakeupCycleOf(NOW, NOW - 90 * DAY).within, false);
  /** 没互动过就没有窗口 */
  assert.equal(wakeupCycleOf(NOW, 0).anchor, 0);
  assert.equal(wakeupCycleOf(NOW, 0).within, false);
});

test('判据：默认关、没互动、超 30 天、静默不足、夜里都不发', () => {
  const anchor = NOW - 10 * DAY;
  assert.equal(wakeupPlan({ now: NOW, lastActiveAt: anchor, cfg: {} }).fire, false, '默认必须关');
  assert.match(wakeupPlan({ now: NOW, lastActiveAt: 0, cfg: ON }).why, /还没主动说过话/);
  assert.match(wakeupPlan({ now: NOW, lastActiveAt: NOW - 40 * DAY, cfg: ON }).why, /超出官方 30 天/);
  const idle = { ...ON, idleHours: 24 * 20 };
  assert.match(wakeupPlan({ now: NOW, lastActiveAt: anchor, cfg: idle }).why, /没到 480 小时/);
  /** 北京时间凌晨 3 点（UTC 前一天 19:00） */
  const night = Date.UTC(2026, 10, 12, 19, 0, 0);
  assert.match(wakeupPlan({ now: night, lastActiveAt: night - 10 * DAY, cfg: ON }).why, /不在 9–22 点/);
});

test('判据：同一个窗口只发 1 条；用户再说话开启新一轮，四个窗口重新可用', () => {
  const anchor = NOW - 10 * DAY;
  const used = [{ anchor, cycle: 3, at: NOW - 1 }];
  const again = wakeupPlan({ now: NOW, lastActiveAt: anchor, used, cfg: ON });
  assert.equal(again.fire, false, '7–30 天这档已经发过');
  assert.match(again.why, /已经召回过了/);

  /** 别的窗口仍可发 */
  const other = wakeupPlan({ now: NOW, lastActiveAt: NOW - 4 * DAY, used, cfg: ON });
  assert.equal(other.cycle, 2);
  assert.equal(other.fire, true, '3–7 天是另一个窗口');

  /** anchor 变了 = 用户又说话了，新一轮 30 天，额度重新开始 */
  const fresh = NOW - 2 * 3_600_000;
  const reset = wakeupPlan({ now: NOW, lastActiveAt: fresh, used, cfg: ON });
  assert.equal(reset.fire, true, '新 anchor 不该被上一轮的账挡住');
  assert.equal(reset.cycle, 0);
});

test('账本：只认同一个 anchor 的同一个窗口，落盘可回读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-wakeup-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'wakeup.json');
  const a = NOW - 10 * DAY;
  const led = createWakeupLedger({ file });
  assert.equal(led.mark(a, 3), true);
  assert.equal(led.mark(a, 3), false, '同一窗口不能记两次');
  assert.equal(led.mark(a, 2), true, '不同窗口各算各的');
  assert.equal(led.mark(0, 1), false, '没有 anchor 不能记');
  assert.equal(led.mark(a, 9), false, '越界的窗口号不能记');
  assert.ok(existsSync(file), '要真的落盘');

  const reread = createWakeupLedger({ file });
  assert.equal(reread.used().length, 2, '重启后额度还在');
  assert.equal(wakeupPlan({ now: NOW, lastActiveAt: a, used: reread.used(), cfg: ON }).fire, false);
  reread.clear();
  assert.equal(createWakeupLedger({ file }).used().length, 0);
});

/** 路由层：真的把 host 跑起来（与 routes.test.js 同一套假 ctx） */
globalThis.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'));
const noop = () => () => {};

async function bootHost() {
  const dir = mkdtempSync(join(tmpdir(), 'roost-wakeup-host-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({}), 'utf8');
  process.env.DSH_ROOST_DATA = dir;
  const routes = new Map();
  const fakeCtx = {
    agents: { get: () => null, create: async () => ({ id: 'a1', ctx: { systemPrompt: { context: noop }, tools: {} } }), list: () => [] },
    sessions: { get: () => null, list: () => [], create: () => ({ id: 's1' }) },
    systemPrompt: { context: () => noop },
    webServer: { register: (r) => { routes.set(r.path, r.handler); return noop; } },
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    effect: (cb, label) => {
      if (String(label).includes('收消息服务')) return noop;
      const off = cb();
      return typeof off === 'function' ? off : noop;
    },
    on: () => noop,
  };
  const url = new URL('../src/host.js', import.meta.url);
  url.searchParams.set('t', String(Date.now()) + Math.random());
  const host = await import(url.href);
  const off = host.apply(fakeCtx);
  const call = async (path, { method = 'GET', body = null } = {}) => {
    const handler = routes.get('/roost/api' + path.split('?')[0]);
    if (!handler) throw new Error(`路由没注册：${path}`);
    let out = '';
    const res = { statusCode: 0, setHeader() {}, end(v) { out = v; } };
    const req = {
      url: path, method,
      headers: { host: '127.0.0.1:17321', 'sec-fetch-site': 'same-origin' },
      [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); },
    };
    await handler(req, res);
    return { status: res.statusCode, json: out ? JSON.parse(out) : null };
  };
  return { call, off, routes };
}

test('路由：/wakeup/status 与 /wakeup/run-now 都注册了，状态默认关', async () => {
  const { call, off, routes } = await bootHost();
  assert.ok(routes.has('/roost/api/wakeup/status'));
  assert.ok(routes.has('/roost/api/wakeup/run-now'));
  const r = await call('/wakeup/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false, '默认必须关');
  assert.equal(r.json.windows.length, 4, '四个官方窗口都要列出来');
  /** 没互动过，手动走一次也不能凭空发一条 */
  const now = await call('/wakeup/run-now', { method: 'POST', body: {} });
  assert.equal(now.json.ok, false);
  off?.();
});
