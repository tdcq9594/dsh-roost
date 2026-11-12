/**
 * 模型清单（`model.list`）/ 能力探测 / 测速（`model.ping`）。
 *
 * 这三件事都依赖宿主 `ctx.llm`，在测试里用假宿主喂数据。要盯住的是三条边界：
 *
 *   1. **探测失败 = 未知，不是「不支持」**。宿主没暴露 `resolveModelInfo`、
 *      或者它抛错，都不能说成「这个模型不能思考 / 不能看图」——面板会据此
 *      禁用按钮，用户就在一个其实能用的模型上选不了了。
 *   2. **单个 provider 挂了不能连累整页**。一个没登录的 provider 不该让
 *      「可用的模型」变成空表。
 *   3. **缓存必须能被 refresh 打破**。刚装的模型如果 10 分钟内不出现，
 *      用户只会以为功能坏了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createModelCatalog, pingModel } from '../src/model-catalog.js';

/** 假宿主：按 provider 名单吐模型，能力按 `provider::model` 查表 */
function fakeLlm({ providers = ['p1'], models = {}, infos = {}, fail = [] } = {}) {
  const calls = { listProviders: 0, listModels: 0, resolveModelInfo: 0 };
  return {
    calls,
    listProviders() {
      calls.listProviders += 1;
      return providers;
    },
    async listModels(provider) {
      calls.listModels += 1;
      if (fail.includes(provider)) throw new Error(`${provider} 没登录`);
      return models[provider] || [];
    },
    async resolveModelInfo(provider, model) {
      calls.resolveModelInfo += 1;
      const k = `${provider}::${model}`;
      if (k in infos) {
        const v = infos[k];
        if (v instanceof Error) throw v;
        return v;
      }
      return {};
    },
  };
}

test('清单：形状、能力、名字都归一好了', async () => {
  const llm = fakeLlm({
    models: { p1: [{ id: 'm1', name: '模型一' }, { model: 'm2' }] },
    infos: {
      'p1::m1': {
        reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' },
        inputModalities: ['text', 'image'],
      },
      'p1::m2': { reasoning: { efforts: [] }, inputModalities: ['text'] },
    },
  });
  const cat = createModelCatalog({ getLlm: () => llm });
  const r = await cat.list();

  assert.equal(r.cached, false);
  assert.equal(r.list.length, 2);
  assert.deepEqual(r.list[0], {
    provider: 'p1',
    model: 'm1',
    name: '模型一',
    reasoning: { efforts: ['low', 'high'], default: 'low' },
    vision: true,
  });
  /** 没给 id 的模型退回 `model` 字段；`name` 缺省就是 model 本身 */
  assert.equal(r.list[1].model, 'm2');
  assert.equal(r.list[1].name, 'm2');
  /** 档位是空数组 = 没公布，按「没有思考强度」展示 */
  assert.equal(r.list[1].reasoning, null);
  /** 明确声明只有文本 → 看不了图（和「未知」不一样） */
  assert.equal(r.list[1].vision, false);
});

test('清单：宿主没声明看图 = 未知（null），不能当成「看不了」', async () => {
  const llm = fakeLlm({ models: { p1: [{ id: 'm1' }] }, infos: { 'p1::m1': {} } });
  const r = await createModelCatalog({ getLlm: () => llm }).list();
  assert.equal(r.list[0].vision, null, '缺省 inputModalities 是未知，不是不支持');
  assert.equal(r.list[0].reasoning, null);
});

test('清单：探测抛错也只当未知，不让整个 provider 消失', async () => {
  const llm = fakeLlm({
    models: { p1: [{ id: 'm1' }] },
    infos: { 'p1::m1': new Error('probe failed') },
  });
  const r = await createModelCatalog({ getLlm: () => llm }).list();
  assert.equal(r.list.length, 1);
  assert.deepEqual(r.list[0].reasoning, null);
  assert.equal(r.list[0].vision, null);
});

test('清单：一个 provider 挂了，别的照列；全挂才抛错', async () => {
  const llm = fakeLlm({
    providers: ['bad', 'good'],
    fail: ['bad'],
    models: { good: [{ id: 'm1' }] },
  });
  const r = await createModelCatalog({ getLlm: () => llm }).list();
  assert.deepEqual(r.list.map((m) => m.provider), ['good']);

  const allBad = fakeLlm({ providers: ['a', 'b'], fail: ['a', 'b'] });
  await assert.rejects(() => createModelCatalog({ getLlm: () => allBad }).list(), /都没列出来/);
});

test('清单：宿主没有 ctx.llm 时给一句人话，面板据此退回手填', async () => {
  await assert.rejects(
    () => createModelCatalog({ getLlm: () => null }).list(),
    /ctx\.llm/,
  );
  /** 只有 listProviders、没 listModels 的旧宿主也别崩在类型错误上 */
  await assert.rejects(
    () => createModelCatalog({ getLlm: () => ({ listProviders: () => [] }) }).list(),
    /没有列出任何模型/,
  );
});

test('清单：缓存 10 分钟，refresh 能打破（新装的模型不用等）', async () => {
  let clock = 0;
  const llm = fakeLlm({ models: { p1: [{ id: 'm1' }] } });
  const cat = createModelCatalog({ getLlm: () => llm, now: () => clock });

  await cat.list();
  await cat.list();
  assert.equal(llm.calls.listProviders, 1, '第二次命缓存，不该再问宿主');

  await cat.list({ refresh: true });
  assert.equal(llm.calls.listProviders, 2, 'refresh 必须真的重拉');

  clock = 11 * 60_000;
  await cat.list();
  assert.equal(llm.calls.listProviders, 3, '过期后自己重拉');
});

test('canSee：拿能力缓存回答「能不能看图」，问不出来的返回 null', async () => {
  const llm = fakeLlm({
    models: { p1: [{ id: 'm1' }, { id: 'm2' }] },
    infos: {
      'p1::m1': { inputModalities: ['image'] },
      'p1::m2': { inputModalities: ['text'] },
    },
  });
  const cat = createModelCatalog({ getLlm: () => llm });
  assert.equal(await cat.canSee('p1', 'm1'), true);
  assert.equal(await cat.canSee('p1', 'm2'), false);
  assert.equal(await cat.canSee('p1', 'nope'), null, '没这个模型 = 未知');
  assert.equal(await cat.canSee('', 'm1'), null);
});

test('测速：真的跑一次流，返回耗时与首句内容', async () => {
  const llm = {
    stream(params) {
      assert.equal(params.provider, 'p1');
      assert.equal(params.model, 'm1');
      assert.ok(Array.isArray(params.messages) && params.messages.length, '要带一条消息');
      return (async function* gen() {
        yield { type: 'text-delta', text: '在' };
        yield { type: 'text-delta', text: '呢' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const r = await pingModel(() => llm, { provider: 'p1', model: 'm1' });
  assert.equal(r.text, '在呢');
  assert.ok(r.ms >= 0);
});

test('测速：流里报错要抛出来，参数缺失 / 宿主没 stream 也不静默', async () => {
  const failing = {
    stream: () => (async function* gen() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'E_AUTH', message: '没登录' } } };
    })(),
  };
  await assert.rejects(() => pingModel(() => failing, { provider: 'p1', model: 'm1' }), /没登录/);

  await assert.rejects(() => pingModel(() => ({}), { provider: 'p1', model: 'm1' }), /llm\.stream/);
  await assert.rejects(() => pingModel(() => failing, { provider: '', model: 'm1' }), /provider/);
});

test('接线：quick 有 model.list / model.ping，且按聊天改不会被当成改全部', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8');
  assert.match(src, /case 'model\.list'/);
  assert.match(src, /case 'model\.ping'/);
  assert.match(src, /modelCatalog\.list\(\{ refresh/, '清单要支持 refresh');
  /**
   * `{chatId, kind}`（面板「给这个聊天选模型」）必须走单会话分支。
   * 以前只判 `if (kind)`，会顺手把所有私聊/群都改掉。
   */
  assert.match(src, /if \(kind && !cid0\)/, '带 chatId 时优先按单会话改');
});
