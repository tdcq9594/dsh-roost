import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GPT_PROFILE_LIMIT,
  defaultProfileValues,
  profileValuesFrom,
  normalizeProfileValues,
  normalizeProfiles,
  profilePatch,
  applyProfileOp,
} from '../src/gpt-profiles.js';

const baseValues = (over = {}) => ({
  speed: 1.1,
  baseUrl: 'http://127.0.0.1:17860',
  model: '角色A',
  gptWeights: 'D:/gpt.pth',
  sovitsWeights: 'D:/sovits.pth',
  referWavPath: 'D:/ref.wav',
  promptText: '你好，这是参考音频原文。',
  promptLanguage: 'zh',
  textLanguage: 'ja',
  textSplitMethod: 'cut5',
  fragmentInterval: 0.3,
  topK: 15,
  topP: 1,
  temperature: 1,
  batchSize: 1,
  freeze: false,
  ...over,
});

test('音色方案：从配置抽快照时兼容中文语种并夹住越界数字', () => {
  const snap = profileValuesFrom({
    tts: {
      speed: 9,
      gptSovits: {
        promptLanguage: '中文',
        textLanguage: '日语',
        textSplitMethod: 'cut9',
        fragmentInterval: 5,
        topK: 999,
        topP: -1,
        temperature: 0,
        batchSize: 0,
        freeze: 1,
      },
    },
  });
  assert.equal(snap.speed, 2);
  assert.equal(snap.promptLanguage, 'zh', '老配置写中文词，快照里折算成 zh');
  assert.equal(snap.textLanguage, 'ja');
  assert.equal(snap.textSplitMethod, 'cut5', '不在白名单的切句方式回 cut5');
  assert.equal(snap.fragmentInterval, 1);
  assert.equal(snap.topK, 100);
  assert.equal(snap.topP, 0);
  assert.equal(snap.temperature, 0.01);
  assert.equal(snap.batchSize, 1);
  assert.equal(snap.freeze, false, '只有布尔 true 才算开');
});

test('音色方案：normalizeProfileValues 与扩展的 RANGE_FIELDS 同边界', () => {
  const v = normalizeProfileValues({
    speed: '0.2',
    fragmentInterval: '0.001',
    topK: '3.7',
    topP: '2',
    temperature: '9',
    batchSize: '99',
    promptText: 123,
  });
  assert.equal(v.speed, 0.5);
  assert.equal(v.fragmentInterval, 0.01);
  assert.equal(v.topK, 4);
  assert.equal(v.topP, 1);
  assert.equal(v.temperature, 2);
  assert.equal(v.batchSize, 8);
  assert.equal(v.promptText, '123');
});

test('音色方案：normalizeProfiles 限 50 套、丢重复 id、补默认值', () => {
  const items = normalizeProfiles([
    { id: 'a', name: 'A', values: { speed: 1.2 } },
    { id: 'a', name: '重复', values: {} },
    null,
    ...Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, values: {} })),
  ]);
  assert.equal(items.length, GPT_PROFILE_LIMIT);
  assert.equal(items[0].name, 'A');
  assert.equal(items[0].values.speed, 1.2);
  assert.ok(items.every((p) => p.values.topK === 15), '缺字段的方案要补默认值');
});

test('音色方案：保存要参考音频和参考文本，但不要求手填权重（可按角色自动配对）', () => {
  const miss = applyProfileOp({ tts: { gptSovits: {} } }, {
    op: 'save', name: '半成品', values: baseValues({ referWavPath: '' }),
  });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /参考音频/);

  const ok = applyProfileOp({ tts: { gptSovits: {} } }, {
    op: 'save', id: 'p1', name: 'A', values: baseValues({ gptWeights: '', sovitsWeights: '' }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.id, 'p1');
  assert.equal(ok.patch.tts.gptSovits.profiles.length, 1);
  assert.equal(ok.patch.tts.gptSovits.activeProfileId, undefined, '保存不该改变正在用的方案');
});

test('音色方案：保存后更新同一套，不另起一份', () => {
  const cfg = { tts: { gptSovits: { profiles: [{ id: 'p1', name: '旧', values: baseValues() }] } } };
  const r = applyProfileOp(cfg, { op: 'save', id: 'p1', name: '新', values: baseValues({ speed: 1.5 }) });
  assert.equal(r.patch.tts.gptSovits.profiles.length, 1);
  assert.equal(r.patch.tts.gptSovits.profiles[0].name, '新');
  assert.equal(r.patch.tts.gptSovits.profiles[0].values.speed, 1.5);
});

test('音色方案：应用一次性写语速 + 全套 GPT 字段 + activeId', () => {
  const cfg = { tts: { gptSovits: { profiles: [{ id: 'p1', name: 'A', values: baseValues() }] } } };
  const r = applyProfileOp(cfg, { op: 'apply', id: 'p1' });
  assert.equal(r.ok, true);
  assert.equal(r.patch.tts.speed, 1.1, '方案里的语速要一起应用，不能只换音色');
  const g = r.patch.tts.gptSovits;
  assert.equal(g.activeProfileId, 'p1');
  assert.equal(g.model, '角色A');
  assert.equal(g.referWavPath, 'D:/ref.wav');
  assert.equal(g.promptLanguage, 'zh');
  assert.equal(g.textLanguage, 'ja');
  assert.equal(g.topK, 15);
  assert.equal(g.batchSize, 1);
});

test('音色方案：删除方案会清 activeId，但当前音色配置不动', () => {
  const cfg = {
    tts: {
      gptSovits: {
        activeProfileId: 'p1',
        profiles: [{ id: 'p1', name: 'A', values: baseValues() }],
      },
    },
  };
  const r = applyProfileOp(cfg, { op: 'remove', id: 'p1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch.tts.gptSovits.profiles, []);
  assert.equal(r.patch.tts.gptSovits.activeProfileId, '');
  assert.equal(r.patch.tts.gptSovits.referWavPath, undefined, '删除不能顺手改当前音色');
});

test('音色方案：profilePatch 不含密钥字段', () => {
  const patch = profilePatch({ ...baseValues(), apiKey: 'sk-secret' });
  assert.equal(JSON.stringify(patch).includes('sk-secret'), false);
  assert.equal(JSON.stringify(patch).includes('apiKey'), false);
});

test('音色方案：new 只给默认值，不碰配置', () => {
  const r = applyProfileOp({ tts: { gptSovits: {} } }, { op: 'new' });
  assert.equal(r.ok, true);
  assert.equal(r.patch, null);
  assert.deepEqual(r.values, defaultProfileValues());
});
