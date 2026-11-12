/**
 * E6 按聊天选模型 + E8 思考强度/看图能力探测。
 *
 * 官方接口（deepseek-ai/deepseek-harness 文档）：
 *   · `agent.model.select({provider, model, reasoningEffort?})`
 *   · `ctx.llm.resolveModelInfo(provider, model)` → `{reasoning:{efforts:[{id,name}]}, inputModalities?}`
 *   · 显式 effort 不支持会在任何 provider I/O 之前失败 → 必须先校验
 *   · `inputModalities` 缺省 = 未知（不是「不支持」）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pickModelFor, pickReasoningEffort } from '../src/model-pick.js';
import { DEFAULTS } from '../src/config.js';

test('E6：单个聊天覆盖优先，没配才用全局默认', () => {
  const globalSel = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' };
  const byChat = { g1: { provider: 'aliyun', model: 'qwen-max' } };

  assert.deepEqual(pickModelFor({ byChat, chatId: 'g1', globalSel }), {
    provider: 'aliyun', model: 'qwen-max', reasoningEffort: '',
  }, '覆盖项没写 effort 就是空（不继承全局）');
  assert.deepEqual(pickModelFor({ byChat, chatId: 'g2', globalSel }), {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high',
  });
  assert.deepEqual(pickModelFor({ byChat, chatId: '', globalSel })?.provider, 'deepseek');
});

test('E6：覆盖项残缺 / 空值 / 两边都没有', () => {
  const globalSel = { provider: 'deepseek', model: 'deepseek-chat' };
  assert.equal(pickModelFor({ byChat: { g1: { provider: '', model: 'x' } }, chatId: 'g1', globalSel })?.provider, 'deepseek');
  assert.equal(pickModelFor({ byChat: { g1: { provider: 'p' } }, chatId: 'g1', globalSel })?.provider, 'deepseek');
  assert.equal(pickModelFor({ byChat: {}, chatId: 'g1' }), null);
  assert.equal(pickModelFor({ byChat: null, chatId: 'g1', globalSel: null }), null);
  assert.equal(pickModelFor(), null);
});

test('E6：会话类型默认夹在单会话与全局之间', () => {
  const globalSel = { provider: 'g', model: 'gm' };
  const byKind = { c2c: { provider: 'c', model: 'cm' }, group: { provider: 'G', model: 'GM' } };
  const byChat = { g1: { provider: 'x', model: 'xm' } };
  assert.equal(pickModelFor({ byChat, byKind, chatId: 'g1', kind: 'c2c', globalSel }).provider, 'x', '单会话最优先');
  assert.equal(pickModelFor({ byChat, byKind, chatId: 'g2', kind: 'c2c', globalSel }).provider, 'c', '没单会话用私聊默认');
  assert.equal(pickModelFor({ byChat, byKind, chatId: 'g2', kind: 'group', globalSel }).provider, 'G', '群默认');
  assert.equal(pickModelFor({ byChat, byKind, chatId: 'g2', kind: 'unknown', globalSel }).provider, 'g', '未知类型回退全局');
  assert.equal(pickModelFor({ byKind: { c2c: {} }, chatId: 'g2', kind: 'c2c', globalSel }).provider, 'g', '空的类型默认回退全局');
});

test('E6：「所有聊天的默认模型」夹在类型默认与 DSH 全局之间', () => {
  const globalSel = { provider: 'g', model: 'gm' };
  const defaultSel = { provider: 'd', model: 'dm' };
  const byKind = { c2c: { provider: 'c', model: 'cm' } };
  const byChat = { g1: { provider: 'x', model: 'xm' } };

  assert.equal(pickModelFor({ byChat, byKind, defaultSel, chatId: 'g1', kind: 'c2c', globalSel }).provider, 'x', '单个聊天最优先');
  assert.equal(pickModelFor({ byKind, defaultSel, chatId: 'g2', kind: 'c2c', globalSel }).provider, 'c', '类型默认次之');
  assert.equal(pickModelFor({ defaultSel, chatId: 'g2', kind: 'group', globalSel }).provider, 'd', '没有类型默认就用默认模型');
  assert.equal(pickModelFor({ defaultSel, globalSel }).provider, 'd', '不指定聊天时也用默认模型');
  assert.equal(pickModelFor({ defaultSel: {}, globalSel }).provider, 'g', '空默认模型 = 跳过这一层');
  assert.equal(pickModelFor({ defaultSel: { provider: 'd' }, globalSel }).provider, 'g', '残缺的默认模型也要跳过');
});
test('E6：字段去空格，provider/model 必须都有', () => {
  const r = pickModelFor({ byChat: { g1: { provider: '  deepseek ', model: ' deepseek-chat ' } }, chatId: 'g1' });
  assert.deepEqual(r, { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: '' });
});

test('E8：effort 不支持就不传；未知（没公布档位）保持原值', async () => {
  const sel = { provider: 'p', model: 'm', reasoningEffort: 'high' };

  /** 支持 → 原样传 */
  assert.equal(await pickReasoningEffort(sel, async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })), 'high');
  /** 不支持 → 空串（不传，用 adapter 默认） */
  assert.equal(await pickReasoningEffort(sel, async () => ({ reasoning: { efforts: [{ id: 'low' }] } })), '');
  /** 没公布档位 = 未知，不是不支持 */
  assert.equal(await pickReasoningEffort(sel, async () => ({ reasoning: { efforts: [] } })), 'high');
  assert.equal(await pickReasoningEffort(sel, async () => ({})), 'high');
  /** 宿主没暴露探测接口 / 探测抛错：维持原值 */
  assert.equal(await pickReasoningEffort(sel, null), 'high');
  assert.equal(await pickReasoningEffort(sel, async () => { throw new Error('boom'); }), 'high');
  /** 本来没配 effort 就不用探测 */
  assert.equal(await pickReasoningEffort({ provider: 'p', model: 'm' }, async () => { throw new Error('不该被调'); }), '');
});

test('接线：DEFAULTS 有 model.byChat；applyDefaultModel 用纯函数 + 官方 select 优先', () => {
  assert.deepEqual(DEFAULTS.model.byChat, {});
  assert.deepEqual(DEFAULTS.model.byKind, { c2c: {}, group: {} });
  /** 2026-11-13 新增的两层：默认模型 + 全局思考强度 */
  assert.deepEqual(DEFAULTS.model.default, {}, '没设默认模型 = 跟随 DSH 全局');
  assert.equal(DEFAULTS.model.effort, '', '默认不传思考强度（保持直连后的旧行为）');
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function applyDefaultModel');
  assert.ok(at > 0);
  const block = src.slice(at, src.indexOf('async function agentFor', at));
  assert.match(block, /pickModelFor\(/, '要走回退顺序');
  assert.match(block, /pickReasoningEffort\(/, 'E8 必须先校验思考强度');
  assert.match(block, /defaultSel: cfg\.model\?\.default/, '要读「所有聊天的默认模型」这一层');
  assert.match(block, /cfg\.model\?\.effort/, '某一级没写 effort 时用全局思考强度兜底');
  assert.match(block, /agent\?\.model\?\.select/, '官方入口优先');
  assert.match(block, /remote\?\.selectModel/, '桌面版旧接口作回退');
  assert.match(src, /applyDefaultModel\(sid, chat\.chatId, chat\.kind\)/);
  assert.match(src, /applyDefaultModel\(newSid, chat\.chatId, chat\.kind\)/);
});

test('E10：quick 有 model.get / model.set，写 byChat 用整体替换并清缓存', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(src, /case 'model\.get'/);
  assert.match(src, /case 'model\.set'/);
  /** 必须是整体替换：patchConfig 是深合并，删掉的 chatId 会被合回来 */
  assert.match(src, /cur\.model = \{ \.\.\.\(cur\.model \|\| \{\}\), byChat: next \}/);
  assert.match(src, /modelApplied\.delete\(sid\)/, '改完要让已存在的会话重新套模型');
});
