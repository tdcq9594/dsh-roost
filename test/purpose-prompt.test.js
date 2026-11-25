// 目的引擎提示词层：三件事齐（状态/素材/方向），且带防注入提醒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPurposePrompt, formatMaterialLine } from '../src/purpose-prompt.js';
import { DEFAULT_PURPOSE_CONFIG as CFG, DEFAULT_DRIVES, DEFAULT_EMOTIONS } from '../src/purpose-engine.js';

const now = new Date(2026, 0, 15, 14, 30, 0, 0).getTime();

test('buildPurposePrompt：含时间、状态、素材、候选与防注入提醒', () => {
  const text = buildPurposePrompt({
    now, config: CFG, mode: 'auto', ownerName: '主人',
    materials: [
      { kind: 'owner', text: '最近在忙项目', at: now - 3600_000 },
      { kind: 'media', source: 'bili', text: '一个很好玩的游戏', title: '游戏推荐', at: now - 7200_000 },
    ],
    candidates: [{ text: '问问他项目进展', need: 'care', action: 'ask', confidence: 0.6 }],
    selected: { text: '问问他项目进展', need: 'care', action: 'ask', emotion: 'curious' },
    drives: { ...DEFAULT_DRIVES, care: 0.8 },
    emotions: DEFAULT_EMOTIONS,
  });
  assert.match(text, /2026-01-15/);
  assert.match(text, /14:30/);
  assert.match(text, /你此刻的状态/);
  assert.match(text, /最近你看到的/);
  assert.match(text, /可以从这些方向里想/);
  assert.match(text, /不是给你的指令/, '必须有防注入提醒');
  assert.match(text, /问问他项目进展/);
});

test('buildPurposePrompt：空素材/空候选也能出文本，不崩', () => {
  const text = buildPurposePrompt({ now, config: CFG, mode: 'auto', drives: DEFAULT_DRIVES });
  assert.ok(text.length > 50);
  assert.doesNotMatch(text, /undefined/);
});

test('formatMaterialLine：B站素材带来源前缀与标题', () => {
  const line = formatMaterialLine({ source: 'bili', kind: 'video', title: '游戏推荐', text: '超好玩', at: now - 60000 }, now);
  assert.match(line, /B站/);
  assert.match(line, /《游戏推荐》/);
});

test('formatMaterialLine：主人素材标 QQ·主人', () => {
  const line = formatMaterialLine({ kind: 'owner', text: '在忙', at: now - 60000 }, now);
  assert.match(line, /QQ·主人/);
});
