/**
 * 3.1 token 折算金额：价目匹配 + 手算对账 + 老文件兼容。
 *
 * 验收（路线图 §批次3）：价目表用**已知 token 数**手算对账。
 * 价格来源：api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-11-13 核）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { priceRowFor, costOf, costOfModels } from '../src/pricing.js';
import { createUsage } from '../src/usage.js';

test('3.1：价目行匹配——pro 要赢过泛化的 deepseek，别的厂商不猜', () => {
  const flash = priceRowFor('deepseek-flash');
  assert.equal(flash.key, 'deepseek');
  assert.equal(flash.idle.uncached, 1);
  assert.equal(flash.peak.output, 8);

  const pro = priceRowFor('deepseek-v4-pro-0813');
  assert.equal(pro.key, 'deepseek-v4-pro', '最长键优先');
  assert.equal(pro.idle.output, 13.5);
  assert.equal(pro.peak.output, 27.0);

  assert.equal(priceRowFor('gpt-5.4'), null, '未定价就是未定价');
  assert.equal(priceRowFor(''), null);
  assert.equal(priceRowFor('claude-opus-4.8'), null);

  /** 用户覆盖：换个价或加一个新模型都行 */
  const u = { 'my-model': { idle: { uncached: 10, cacheRead: 1, cacheWrite: 10, output: 20 } } };
  const mine = priceRowFor('my-model-v2', u);
  assert.equal(mine.key, 'my-model');
  assert.equal(priceRowFor('deepseek-flash', u).idle.uncached, 1, '覆盖表不影响内置行');
});

test('3.1：手算对账——flash 空闲档，输入各 1M + 输出 0.5M = 3.02 元', () => {
  const row = priceRowFor('deepseek-flash');
  const tokens = { uncached: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 500_000 };
  const idle = costOf(tokens, row, 'idle');
  /** 1×1 + 1×0.02 + 0.5×4 = 3.02 */
  assert.ok(Math.abs(idle.yuan - 3.02) < 1e-9, `空闲档 ${idle.yuan}`);
  const peak = costOf(tokens, row, 'peak');
  /** 1×2 + 1×0.04 + 0.5×8 = 6.04（空闲恰好是一半） */
  assert.ok(Math.abs(peak.yuan - 6.04) < 1e-9, `高峰档 ${peak.yuan}`);
});

test('3.1：cacheWrite 按未命中价计（DeepSeek 没有缓存写入档）', () => {
  const row = priceRowFor('deepseek-flash');
  const tokens = { uncached: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 };
  assert.ok(Math.abs(costOf(tokens, row, 'idle').yuan - 1) < 1e-9, '1M 写入 = 1 元（未命中价）');
});

test('3.1：pro 空闲档手算——4.5 / 0.15 / 13.5', () => {
  const row = priceRowFor('deepseek-v4-pro');
  const tokens = { uncached: 2_000_000, cacheRead: 4_000_000, cacheWrite: 0, output: 1_000_000 };
  /** 2×4.5 + 4×0.15 + 1×13.5 = 9 + 0.6 + 13.5 = 23.1 */
  assert.ok(Math.abs(costOf(tokens, row, 'idle').yuan - 23.1) < 1e-9);
});

test('3.1：costOfModels 分档求和，未定价的 token 如实报', () => {
  const flash = { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, idle: { uncached: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 0 } };
  const r = costOfModels({ 'deepseek-flash': flash, 'some-other': { idle: { uncached: 500_000, cacheRead: 0, cacheWrite: 0, output: 0 } } }, null);
  /** 1×2（峰） + 2×0.02（谷） = 2.04 */
  assert.ok(Math.abs(r.yuan - 2.04) < 1e-9, `${r.yuan}`);
  assert.equal(r.priced, true);
  assert.equal(r.unpricedTokens, 500_000, '未定价的只报 token 数');
  assert.ok(Math.abs(r.byModel['deepseek-flash'].yuan - 2.04) < 1e-9);
});

test('3.1：usage 记账带模型与档位，summary 的金额与手算一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-pricing-'));
  try {
    const file = join(dir, 'usage.json');
    /** 档位写死：第一条峰、第二条谷 */
    const tiers = ['peak', 'idle'];
    const u = createUsage({
      file,
      tierOf: () => tiers.shift() ?? 'idle',
    });
    u.record({
      chatId: 'c1', model: 'deepseek-flash',
      usage: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    u.record({
      chatId: 'c1', model: 'deepseek-flash',
      usage: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
    const s = u.summary({ days: 1, pricing: null });
    /** 第二条是累计读数：增量只有 1M。峰 1M×2 + 谷 1M×1 = 3 */
    assert.ok(Math.abs(s.cost.yuan - 3) < 1e-9, `峰谷分别折价：${s.cost.yuan}`);
    assert.equal(s.cost.priced, true);
    assert.equal(s.days[0].cost.priced, true);
    /** token 总数不受金额逻辑影响（第二条是累计读数，增量只有 1M） */
    assert.equal(s.total.uncached, 2_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('3.1：升级前的老 usage.json（没有分档）——token 照读，金额标未定价', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roost-pricing-old-'));
  try {
    mkdirSync(dir, { recursive: true });
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const legacy = {
      days: {
        [today]: {
          total: { uncached: 800_000, cacheRead: 200_000, cacheWrite: 0, output: 50_000, turns: 3 },
          chats: {},
        },
      },
      last: {},
    };
    writeFileSync(join(dir, 'usage.json'), JSON.stringify(legacy), 'utf8');
    const u = createUsage({ file: join(dir, 'usage.json') });
    const s = u.summary({ days: 7, pricing: null });
    assert.equal(s.total.uncached, 800_000, '老数据 token 照常进汇总');
    assert.equal(s.cost.priced, false, '没有分档就不猜价');
    assert.equal(s.cost.unpricedTokens, 1_050_000, '老数据的 token 在未定价里如实报');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
