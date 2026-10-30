// 配置的默认值升级
//
// 这类逻辑最容易"看起来做了、其实没生效"：`saveConfig` 写的是整份合并后的
// 配置，所以老部署盘上躺着当时那份默认值，只改 DEFAULTS 对它们完全无效。
// 而失效的表现是"压缩阈值还是 60/40"，没有任何报错。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, saveConfig, DEFAULTS, dataDir } from '../src/config.js';

/** 每个用例一个干净的 data 目录（dataDir() 每次读 env） */
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'roost-cfg-'));
  process.env.DSH_ROOST_DATA = d;
  return d;
}

function writeCfg(dir, obj) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(obj, null, 2), 'utf8');
}

test('配置：没有配置文件时用新默认值（85/75）', () => {
  freshDir();
  const c = loadConfig();
  assert.equal(c.compact.atPercentGroup, 85);
  assert.equal(c.compact.atPercentC2C, 75);
});

/**
 * 老部署盘上写着 60/40——那是我们当初写进去的默认值，不是用户选的。
 * 不升级的话，改 DEFAULTS 等于只对全新安装生效。
 */
test('配置：盘上还是旧默认值 60/40 时自动升级', () => {
  const d = freshDir();
  writeCfg(d, { compact: { atPercentGroup: 60, atPercentC2C: 40 } });
  const c = loadConfig();
  assert.equal(c.compact.atPercentGroup, 85);
  assert.equal(c.compact.atPercentC2C, 75);
});

test('配置：用户自己调过的值不许动', () => {
  const d = freshDir();
  writeCfg(d, { compact: { atPercentGroup: 70, atPercentC2C: 50 } });
  const c = loadConfig();
  assert.equal(c.compact.atPercentGroup, 70);
  assert.equal(c.compact.atPercentC2C, 50);
});

/**
 * 升级要能落盘。
 *
 * 只在 `loadConfig` 里改内存的话，下一次 `saveConfig` 会把它写下去——
 * 但"下一次"可能是很久以后，中间重启一次又回到 60/40。
 * 这里验的是 `saveConfig` 走的是升级后的值，而不是把它写回旧的。
 */
test('配置：存一次就把升级后的值写下去（不会写回 60/40）', () => {
  const d = freshDir();
  writeCfg(d, { compact: { atPercentGroup: 60, atPercentC2C: 40 } });
  saveConfig({ server: { port: 17321 } });
  const onDisk = JSON.parse(readFileSync(join(d, 'config.json'), 'utf8'));
  assert.equal(onDisk.compact.atPercentGroup, 85);
  assert.equal(onDisk.compact.atPercentC2C, 75);
});

test('配置：升级是幂等的（读两次结果一样）', () => {
  const d = freshDir();
  writeCfg(d, { compact: { atPercentGroup: 60, atPercentC2C: 40 } });
  assert.deepEqual(loadConfig().compact, loadConfig().compact);
});

test('配置：DEFAULTS 与 dataDir 都对得上（别把默认值写回旧数字）', () => {
  freshDir();
  assert.equal(DEFAULTS.compact.atPercentGroup, 85);
  assert.equal(DEFAULTS.compact.atPercentC2C, 75);
  assert.ok(dataDir());
});

/**
 * 按会话关记忆（`memory.offChats`）。
 *
 * 这一项特别容易在「保存」这一步出事：面板开关只发 `{memory:{offChats}}`，
 * 如果 `saveConfig` 不是深合并，`keepDays` / `deepEvery` / `tools` 会被整段冲掉，
 * 而症状是「关了一次记忆，压缩阈值和注入条数全变了」，没有任何报错。
 */
test('配置：offChats 默认是空数组（等于所有会话照常记忆）', () => {
  freshDir();
  assert.deepEqual(DEFAULTS.memory.offChats, []);
  assert.deepEqual(loadConfig().memory.offChats, []);
});

test('配置：写 offChats 不会把 memory 其他项冲掉', () => {
  const d = freshDir();
  const merged = saveConfig({ memory: { offChats: ['g1'] } });
  assert.deepEqual(merged.memory.offChats, ['g1']);
  assert.equal(merged.memory.deepEvery, DEFAULTS.memory.deepEvery, 'deepEvery 被冲掉了');
  assert.equal(merged.memory.tools, DEFAULTS.memory.tools, 'tools 被冲掉了');
  assert.deepEqual(merged.memory.keepDays, DEFAULTS.memory.keepDays, 'keepDays 被冲掉了');

  const onDisk = JSON.parse(readFileSync(join(d, 'config.json'), 'utf8'));
  assert.deepEqual(onDisk.memory.offChats, ['g1'], '盘上没写进去');
});

test('配置：offChats 是数组，整体替换而不是合并', () => {
  freshDir();
  saveConfig({ memory: { offChats: ['g1', 'g2'] } });
  const next = saveConfig({ memory: { offChats: ['g3'] } });
  assert.deepEqual(next.memory.offChats, ['g3'], '数组必须整体替换，否则取消勾选永远去不掉');
});
