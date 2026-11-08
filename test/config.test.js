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

import { loadConfig, saveConfig, patchConfig, readRawConfig, DEFAULTS, dataDir, publicConfig, migrateRetentionMode } from '../src/config.js';

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

/* ---------------- 局部保存（patchConfig） ---------------- */

/**
 * 这条钉的是一个真实事故级缺陷。
 *
 * `saveConfig(next)` 的基线是 DEFAULTS，而 `merge` 只遍历 next 里的键——
 * 提交局部 patch 时，**其它段全部回落到默认值**。实测：先存
 * `{server:{token:'REAL',port:4321}}`，再存 `{memory:{offChats:['g1']}}`，
 * 磁盘上 token 变成空串、port 变成 17321。也就是「静音一个会话」会把
 * QQ 的 token 和端口一起重置。
 *
 * 所以凡是「改一个键」的快捷操作都必须走 `patchConfig`。
 */
test('配置：patchConfig 只改一个键，token / 端口不许被冲回默认值', () => {
  const d = freshDir();
  saveConfig({ server: { token: 'REAL_TOKEN', port: 4321 } });

  const c = patchConfig({ memory: { offChats: ['g1'] } });
  assert.equal(c.server.token, 'REAL_TOKEN', 'token 被冲掉了');
  assert.equal(c.server.port, 4321, '端口被冲掉了');
  assert.deepEqual(c.memory.offChats, ['g1']);

  const onDisk = JSON.parse(readFileSync(join(d, 'config.json'), 'utf8'));
  assert.equal(onDisk.server.token, 'REAL_TOKEN', '盘上的 token 被冲掉了');
  assert.equal(onDisk.server.port, 4321, '盘上的端口被冲掉了');
});

test('配置：patchConfig 也尊重「删掉 = 回默认」（它最终仍走 saveConfig 的裁剪）', () => {
  freshDir();
  saveConfig({ server: { token: 'T', port: 4321 } });
  // 显式把 token 写成空串 = 用户想清掉它，不该被旧值补回来
  const c = patchConfig({ server: { token: '' } });
  assert.equal(c.server.token, '');
  assert.equal(c.server.port, 4321, '其它键仍然不动');
});

test('默认名字是「大肥鱼」（0.11：名字是账号身份）', () => {
  assert.equal(DEFAULTS.persona.name, '大肥鱼');
});

test('readRawConfig：没写过的键不会被默认值污染（迁移靠它判断）', () => {
  const d = freshDir();
  // 老配置：没有 persona.name
  writeCfg(d, { persona: { current: 'snarky' } });
  const raw = readRawConfig();
  assert.equal(raw.persona.name, undefined, '原始配置里就是没有，不能合并出「大肥鱼」');
  assert.equal(loadConfig().persona.name, '大肥鱼', '合并后的默认值是新装的默认');
});

test('聊天内切人格指令默认关闭（只对主人、不落盘）', () => {
  assert.equal(DEFAULTS.persona.command.enabled, false);
  assert.equal(DEFAULTS.persona.command.prefix, '/persona');
});

test('TTS 配置默认关闭且 provider 为配置项', () => {
  freshDir();
  assert.equal(DEFAULTS.tts.enabled, false);
  assert.equal(loadConfig().tts.enabled, false);
  assert.equal(loadConfig().tts.provider, 'openai');
});

test('配置全文：所有 secret 路径遮罩，保存掩码不会覆盖真值', () => {
  freshDir();
  saveConfig({
    server: { token: 'server-secret' },
    memory: { embedding: { model: 'embed', baseUrl: 'http://localhost/v1', apiKey: 'embed-secret' } },
    tts: { enabled: true, apiKey: 'tts-secret', gptSovits: { apiKey: 'gpt-secret' }, mimo: { apiKey: 'mimo-secret' } },
  });

  const view = publicConfig(loadConfig());
  assert.equal(view.server.token, '******');
  assert.equal(view.memory.embedding.apiKey, '******');
  assert.equal(view.tts.apiKey, '******');
  assert.equal(view.tts.gptSovits.apiKey, '******');
  assert.equal(view.tts.mimo.apiKey, '******');

  saveConfig(view);
  const disk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8'));
  assert.equal(disk.server.token, 'server-secret');
  assert.equal(disk.memory.embedding.apiKey, 'embed-secret');
  assert.equal(disk.tts.apiKey, 'tts-secret');
  assert.equal(disk.tts.gptSovits.apiKey, 'gpt-secret');
  assert.equal(disk.tts.mimo.apiKey, 'mimo-secret', 'MiMo 的 Key 也要落盘且不被掩码覆盖');
});

test('局部配置保存：掩码保留旧值，显式空串能清除 TTS key', () => {
  freshDir();
  saveConfig({ tts: { apiKey: 'old-secret' } });
  patchConfig({ tts: { apiKey: '******' } });
  assert.equal(loadConfig().tts.apiKey, 'old-secret');
  patchConfig({ tts: { apiKey: '' } });
  assert.equal(loadConfig().tts.apiKey, '');
});

test('密钥：数组/对象这类非字符串值不会写进磁盘', () => {
  freshDir();
  /**
   * 掩码回填只认「恰好等于 `******` 的字符串」，数组既不会被回填也不会被拦，
   * 会原样落盘，之后发请求就拼出 `Bearer ******,******`（审查发现）。
   */
  saveConfig({ tts: { apiKey: ['******'] } });
  assert.equal(loadConfig().tts.apiKey, '', '数组要当没设置');

  saveConfig({ server: { token: { nested: 1 } } });
  assert.equal(loadConfig().server.token, '', '对象也要当没设置');

  saveConfig({ tts: { gptSovits: { apiKey: 12345 } } });
  assert.equal(loadConfig().tts.gptSovits.apiKey, '', '数字同样不行');
});

test('配置：阶段 2 新增的开关字段存得下去（pruneTo 不会把它们裁掉）', () => {
  /**
   * `saveConfig()` 按 DEFAULTS 的形状裁剪，DEFAULTS 里没有的键一律丢。
   * 能力页写 `memory.retention.factsMode = 'purge'`，如果忘了在 DEFAULTS 登记，
   * 现象是「面板提示已保存，刷新又变回原值」，而且不报错。
   */
  const d = freshDir();
  const c = patchConfig({
    memory: { retention: { factsMode: 'purge', journalMode: 'expire', thresholdPct: 8, minProtectDays: 14 } },
    mood: { effects: true },
    profiles: { enabled: true },
    events: { enabled: true },
    extensions: { enabled: true },
  });
  assert.equal(c.memory.retention.factsMode, 'purge');
  assert.equal(c.memory.retention.journalMode, 'expire');
  assert.equal(c.memory.retention.thresholdPct, 8);
  assert.equal(c.memory.retention.minProtectDays, 14);
  assert.equal(c.mood.effects, true);
  assert.equal(c.profiles.enabled, true);
  assert.equal(c.events.enabled, true);
  assert.equal(c.extensions.enabled, true);

  /** 重新读一次（走合并 + 裁剪），值必须还在 */
  const again = loadConfig();
  assert.equal(again.memory.retention.factsMode, 'purge');
  assert.equal(again.mood.effects, true);
  const onDisk = JSON.parse(readFileSync(join(d, 'config.json'), 'utf8'));
  assert.equal(onDisk.memory.retention.factsMode, 'purge', '盘上也得是真的');
});

test('配置：阶段 2 单 mode 的老配置迁到双路，日记那路不许被顺手打开', () => {
  const d = freshDir();
  /** 阶段 2 的开关是 staged，只有手改 config.json 的人会留下 `mode` */
  writeCfg(d, { memory: { retention: { mode: 'purge', thresholdPct: 9 } } });
  const c = loadConfig();
  assert.equal(c.memory.retention.factsMode, 'purge', '老档位带到 facts 路');
  assert.equal(c.memory.retention.journalMode, 'off', 'journal 一律保持默认关');
  assert.equal(c.memory.retention.mode, undefined);
  assert.equal(c.memory.retention.thresholdPct, 9, '共用参数不能丢');
  const legacy = { memory: { retention: { mode: 'bogus' } } };
  assert.equal(migrateRetentionMode(legacy), true);
  assert.equal(legacy.memory.retention.factsMode, 'off', '坏档位退回 off');
  assert.equal(legacy.memory.retention.journalMode, 'off');
  assert.equal(legacy.memory.retention.mode, undefined, '老字段要删，别留两份真相');
});
