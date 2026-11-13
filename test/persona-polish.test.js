// 5.5 可选：AI 润色。重点测「清洗模型输出」和「不自动覆盖」这两件容易出错的事。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanPolished, buildPolishPrompt, polishText, POLISH_PRESETS, POLISH_PRESET_IDS, MAX_POLISH_CHARS,
} from '../src/persona-polish.js';

/** 假 llm：按给定文本流式返回，可选抛错 / 报错块 */
function fakeLlm(text, { throwOnStream = false, failChunk = null } = {}) {
  return {
    stream: () => {
      if (throwOnStream) throw new Error('网络断了');
      return (async function* gen() {
        for (const piece of String(text).match(/[\s\S]{1,8}/g) || []) {
          yield { type: 'text-delta', text: piece };
        }
        if (failChunk) yield { type: 'finish', reason: { kind: 'error', failure: failChunk } };
        else yield { type: 'finish', reason: { kind: 'ok' } };
      })();
    },
  };
}

const sel = { provider: 'p', model: 'm' };

test('清洗：去掉代码围栏与「好的，以下是…」客套行', () => {
  assert.equal(cleanPolished('```markdown\n她说话很轻。\n```'), '她说话很轻。');
  assert.equal(cleanPolished('好的，以下是改写后的版本：\n\n她说话很轻。'), '她说话很轻。');
  assert.equal(cleanPolished('改写后：\n她说话很轻。'), '她说话很轻。');
});

test('清洗：正文第一句「好的，我记住了」不能被当成客套话删掉', () => {
  /**
   * 这是最容易写错的一处：只看开头几个字就把第一行删了，
   * 会让人格第一句凭空消失。所以要求「第一行以冒号/句号结尾且很短」。
   */
  const kept = cleanPolished('好的，我记住了\n\n她从不迟到。');
  assert.match(kept, /好的，我记住了/, '第一行没有冒号结尾，是正文');
});

test('清洗：模型带回来的 `## 段名` 要去掉（段名由调用方保留）', () => {
  assert.equal(cleanPolished('## 性格底色\n她安静，但不软弱。'), '她安静，但不软弱。');
});

test('清洗：多余空行收敛成两个换行', () => {
  assert.equal(cleanPolished('第一段。\n\n\n\n第二段。'), '第一段。\n\n第二段。');
});

test('prompt：带上预设的具体指令、额外要求、段名，但不带其它段', () => {
  const p = buildPolishPrompt({
    text: '她说话很轻。', preset: 'concise', instruction: '别用感叹号',
    section: '性格底色', personaName: '小栖',
  });
  assert.match(p, /小栖/);
  assert.match(p, /删掉重复、空话/);
  assert.match(p, /别用感叹号/);
  assert.match(p, /性格底色/);
  assert.match(p, /她说话很轻。/);
  assert.match(p, /只输出改写后的正文/);
});

test('prompt：预设 id 不认识时回落到第一个，不报错', () => {
  const p = buildPolishPrompt({ text: 'x', preset: '不存在的预设' });
  assert.match(p, new RegExp(POLISH_PRESETS[0].hint.slice(0, 8)));
});

test('润色：正常返回改写结果，并报告耗时', async () => {
  const r = await polishText({
    getLlm: () => fakeLlm('她说话很轻，句子短。'),
    sel, text: '她说话很轻，而且句子比较短，不太爱用长句。',
  });
  assert.equal(r.ok, true);
  assert.equal(r.text, '她说话很轻，句子短。');
  assert.equal(typeof r.ms, 'number');
  assert.deepEqual(r.warnings, []);
});

test('润色：空文本 / 超长 / 没模型 都给明确原因，不抛', async () => {
  assert.match((await polishText({ getLlm: () => fakeLlm('x'), sel, text: '   ' })).reason, /空的/);

  const long = '啊'.repeat(MAX_POLISH_CHARS + 1);
  assert.match((await polishText({ getLlm: () => fakeLlm('x'), sel, text: long })).reason, /太长/);

  assert.match((await polishText({ getLlm: () => null, sel, text: 'x' })).reason, /llm\.stream/);
  assert.match((await polishText({ getLlm: () => fakeLlm('x'), sel: {}, text: 'x' })).reason, /选模型/);
});

test('润色：模型报错 / 流抛错都转成 ok:false，不把异常抛给调用方', async () => {
  const a = await polishText({
    getLlm: () => fakeLlm('', { failChunk: { message: '余额不足', code: 'insufficient_quota' } }),
    sel, text: '她说话很轻。',
  });
  assert.equal(a.ok, false);
  assert.match(a.reason, /余额不足/);

  const b = await polishText({
    getLlm: () => fakeLlm('', { throwOnStream: true }),
    sel, text: '她说话很轻。',
  });
  assert.equal(b.ok, false);
  assert.match(b.reason, /网络断了/);
});

test('润色：模型只回空白时给「换个模型」，不是静默成功', async () => {
  const r = await polishText({ getLlm: () => fakeLlm('   \n  '), sel, text: '她说话很轻。' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没返回内容/);
});

test('润色：扩写太多 / 删得太多 / 带回标题 都要警告', async () => {
  const grow = await polishText({
    getLlm: () => fakeLlm('她说话很轻。'.repeat(20)),
    sel, text: '她说话很轻。',
  });
  assert.equal(grow.ok, true);
  assert.match(grow.warnings.join('；'), /倍/);

  const shrink = await polishText({
    getLlm: () => fakeLlm('她。'),
    sel, text: '她说话很轻，做事很稳，从不迟到，也不爱解释。'.repeat(4),
  });
  assert.match(shrink.warnings.join('；'), /不到原文三成/);

  const heading = await polishText({
    getLlm: () => fakeLlm('开头一句。\n## 中间小标题\n后面一句。'),
    sel, text: '开头一句。后面一句。',
  });
  assert.match(heading.warnings.join('；'), /标题行/);
});

test('预设清单稳定：id 与 label 都在，别在 UI 里另抄一份', () => {
  assert.deepEqual(POLISH_PRESET_IDS, ['concise', 'spoken', 'inCharacter', 'detail']);
  for (const p of POLISH_PRESETS) {
    assert.ok(p.label && p.hint, `${p.id} 缺 label 或 hint`);
  }
});
