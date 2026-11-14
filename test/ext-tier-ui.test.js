/**
 * 扩展分级：后端算出来的东西必须真的走到用户眼前
 * ================================================
 *
 *   node --test test/ext-tier-ui.test.js
 *
 * 2026-11-14 踩到的坑：`ext-tier.js` / `ext-market.js` 早就把
 * `tier / tierLabel / tierColor / risks / installNotice()` 全算好并返回了，
 * 但 `client/client.js` 的市场卡片只画名字和标签、确认弹窗只列英文 scope，
 * L3 声明的 `type-name` 二次确认也没接 —— 主人问「分级做完了吗」时，
 * 后端说做完了，界面上一点都看不见。
 *
 * 这里做的是**字段契约守门**：把后端 list / install 两个出口返回的字段名，
 * 和前端实际读取的字段名逐一对上。以后谁加字段、谁改名、谁把渲染删了，
 * 测试会先炸，而不是等主人在市场页上发现「怎么没有等级」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveTier, installNotice } from '../src/ext-tier.js';

const CLIENT = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
const MARKET = readFileSync(new URL('../src/ext-market.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/ext-panel.js', import.meta.url), 'utf8');

/** marketAct 里「收到确认回执 → 弹窗 → return」这一段（用相对锚点，别被前面的同名 toast 截胡） */
const ASK_START = CLIENT.indexOf("r?.reason === 'needs_scope_confirm'");
const ASK = CLIENT.slice(ASK_START, CLIENT.indexOf('toast(r.message || (r.ok', ASK_START));

/** 从一段源码里抓 `foo.bar` 形式读到的字段名 */
function fieldsOf(src, obj) {
  const re = new RegExp(`\\b${obj}\\.([A-Za-z_$][\\w$]*)`, 'g');
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))];
}

test('L3 是「核心接管」：必须输入扩展名，且告知停用才能恢复', () => {
  const d = deriveTier({
    form: 'core',
    scopes: ['core:write'],
    overrides: ['memory'],
  });
  assert.equal(d.id, 'L3');
  assert.equal(d.confirm, 'type-name');
  assert.match(installNotice(d, { name: '我的记忆' }), /停用扩展才能恢复/);
  assert.ok(d.reasons.some((r) => r.kind === 'override'), '接管内置功能要单独列一条');
});

test('市场列表：后端给的等级字段，前端卡片全都读了', () => {
  /** ext-market.js 的 list row（tier: ... 到 formLabel 那一段） */
  const row = MARKET.slice(MARKET.indexOf('tier: tier.id'), MARKET.indexOf('formLabel: tier.formLabel') + 40);
  const produced = [...row.matchAll(/(\w+):/g)].map((m) => m[1]);
  /** 卡片渲染那一段（从「等级徽章」注释到风险行结束） */
  const card = CLIENT.slice(CLIENT.indexOf('等级徽章：装之前'), CLIENT.indexOf('/** 能力标签'));
  for (const key of ['tierLabel', 'tierColor', 'tier', 'tierSummary', 'risks']) {
    assert.ok(new RegExp(`x\\.${key}\\b`).test(card), `市场卡片没读 x.${key}`);
    assert.ok(produced.includes(key), `后端 list row 没给 ${key}`);
  }
  assert.match(card, /tierColorOf\(x\.tierColor\)/, '等级配色要走主题变量，别写死深色');
});

test('安装确认：后端的人话风险 / 等级 / 确认方式都进了弹窗', () => {
  for (const key of ['scopes', 'tier', 'tierLabel', 'tierColor', 'confirm', 'risks', 'message']) {
    assert.ok(new RegExp(`r\\.${key}\\b`).test(ASK), `marketAct 没把 r.${key} 收进弹窗`);
  }
  /** 后端确实返回这些字段（needs_scope_confirm 分支） */
  const ret = MARKET.slice(MARKET.indexOf("reason: 'needs_scope_confirm'"), MARKET.indexOf("if (confirmTier !== undefined"));
  for (const key of ['scopes', 'tier', 'tierLabel', 'tierColor', 'confirm', 'risks', 'message']) {
    assert.ok(new RegExp(`\\b${key}[:,]`).test(ret), `后端 needs_scope_confirm 没返回 ${key}`);
  }
  assert.match(CLIENT, /needs_tier_confirm/, '后端 L3 的二次确认回执前端要认');
  assert.match(CLIENT, /scopeAsk\.message/, '弹窗优先展示 installNotice() 的人话文案');
});

test('L3 必须手打扩展 id，且确认请求带上 confirmTier', () => {
  assert.match(CLIENT, /ask\.confirm === 'type-name' && String\(tierTyped/, '没打对 id 不许发请求');
  assert.match(CLIENT, /toast\(`请输入扩展 id/, '要给明确提示，别静默不响应');
  assert.match(CLIENT, /confirmTier: ask\.tier/, '后端要求明确确认到具体等级');
  /** 绝不自动重试：第一次回 needs_scope_confirm 只能弹窗，连 confirmScopes 都不许带 */
  assert.match(ASK, /\breturn\b/, '确认前必须 return');
  assert.doesNotMatch(ASK, /confirmScopes/, '确认分支里不许出现 confirmScopes');
});

test('已装页按实际授予的 scopes 现算等级，不是看清单上写什么', () => {
  assert.match(PANEL, /deriveTier\(/, 'ext-panel 要现算');
  assert.match(PANEL, /tier: \(/, '把等级对象返回给前端');
  const installed = CLIENT.slice(CLIENT.indexOf('已装页按实际授予'), CLIENT.indexOf('h(\'textarea\'', CLIENT.indexOf('已装页按实际授予')));
  assert.match(installed, /x\.tier\?\.label/, '已装行要画等级徽章');
  assert.match(installed, /tierColorOf\(x\.tier\.color\)/, '已装行配色同样走主题变量');
});
