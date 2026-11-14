/**
 * 扩展看图：只把「一批 base64 图 + 一段提示词」换成一段文字。
 *
 * 这里测的都是**不该烧 token 的情形**（没图、模型看不了、附件服务不在），
 * 因为那几种最容易写成「照样发一次请求，让模型回一句我看不到图」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLlmVision } from '../src/ext-llm.js';

const B64 = 'A'.repeat(2000);

/** 一个够用的假 ctx：llm.stream 逐块吐文本 */
function fakeCtx({ deltas = ['画面里', '有一只猫'], failFinish = false, admitted = null, vision = null } = {}) {
  const calls = { stream: 0, admit: 0, content: null };
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream(params) {
            calls.stream += 1;
            calls.content = params.messages[0].content;
            calls.params = params;
            return (async function* gen() {
              for (const d of deltas) yield { type: 'text-delta', text: d };
              if (failFinish) yield { type: 'finish', reason: { kind: 'error', failure: { message: '上游 429' } } };
              else yield { type: 'finish', reason: { kind: 'stop' } };
            })();
          },
        };
      }
      if (name === 'attachments') {
        return {
          async admitPromptContent(content) {
            calls.admit += 1;
            calls.admitted = content;
            return admitted ? admitted(content) : content;
          },
        };
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      }
      return null;
    },
  };
  return { ctx, calls, vision };
}

const base = { prompt: '这些是视频截图', images: [{ data: B64, mediaType: 'image/jpeg' }], extId: 'bili' };

test('正常：content 里先文字后图片，图片经附件服务登记后才交给模型', async () => {
  const { ctx, calls } = fakeCtx();
  const vision = createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) });
  const r = await vision(base);
  assert.equal(r.ok, true);
  assert.equal(r.text, '画面里有一只猫');
  assert.equal(calls.admit, 1, '图片必须先登记');
  const content = calls.content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].data, B64);
  assert.equal(content[1].mediaType, 'image/jpeg');
});

test('没有图片：直接拒，不发请求', async () => {
  const { ctx, calls } = fakeCtx();
  const vision = createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) });
  const r = await vision({ prompt: 'x', images: [] });
  assert.equal(r.ok, false);
  assert.match(r.message, /没有可用的图片/);
  assert.equal(calls.stream, 0);
});

test('单张太大：拒（宿主 body 上限 1 MB，塞不下就别试）', async () => {
  const { ctx, calls } = fakeCtx();
  const vision = createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) });
  const r = await vision({ images: [{ data: 'A'.repeat(500_000), mediaType: 'image/jpeg' }] });
  assert.equal(r.ok, false);
  assert.equal(calls.stream, 0);
});

test('模型不支持图片：明确拒绝，不烧一次注定被忽略的请求', async () => {
  const { ctx, calls } = fakeCtx();
  const vision = createLlmVision({
    getCtx: () => ctx,
    cfgOf: () => ({}),
    modelCatalog: { canSee: async () => false },
  });
  const r = await vision(base);
  assert.equal(r.ok, false);
  assert.match(r.message, /不支持图片输入/);
  assert.equal(calls.stream, 0);
});

test('模型能力未知（null）时不拦，交给上游判断', async () => {
  const { ctx, calls } = fakeCtx();
  const vision = createLlmVision({
    getCtx: () => ctx,
    cfgOf: () => ({}),
    modelCatalog: { canSee: async () => null },
  });
  const r = await vision(base);
  assert.equal(r.ok, true);
  assert.equal(calls.stream, 1);
});

test('没有附件服务：说清楚，不静默失败', async () => {
  const ctx = {
    get(name) {
      if (name === 'llm') return { stream: () => (async function* () {})() };
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return null;
    },
  };
  const r = await createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) })(base);
  assert.equal(r.ok, false);
  assert.match(r.message, /附件服务/);
});

test('流里报错：把上游原因带出来', async () => {
  const { ctx } = fakeCtx({ failFinish: true });
  const r = await createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) })(base);
  assert.equal(r.ok, false);
  assert.match(r.message, /429/);
});

test('模型一个字都没写：算失败（预算被思考吃掉时就是这样）', async () => {
  const { ctx } = fakeCtx({ deltas: [] });
  const r = await createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) })(base);
  assert.equal(r.ok, false);
  assert.match(r.message, /一个字都没写/);
});

test('最多 4 张：多的丢掉，不报错', async () => {
  const { ctx, calls } = fakeCtx();
  const images = Array.from({ length: 9 }, () => ({ data: B64, mediaType: 'image/jpeg' }));
  const r = await createLlmVision({ getCtx: () => ctx, cfgOf: () => ({}) })({ ...base, images });
  assert.equal(r.ok, true);
  assert.equal(calls.content.filter((x) => x.type === 'image').length, 4);
});
