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

import { loadConfig, saveConfig, patchConfig, readRawConfig, DEFAULTS, dataDir, publicConfig, migrateRetentionMode, restoreMaskedSecrets } from '../src/config.js';

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
    tts: {
      enabled: true, apiKey: 'tts-secret',
      gptSovits: { apiKey: 'gpt-secret' }, mimo: { apiKey: 'mimo-secret' },
      volcano: { apiKey: 'volcano-secret' }, breeze: { key: 'breeze-secret' },
      minimax: { apiKey: 'minimax-secret' }, fishApiKey: 'fish-secret',
    },
  });

  const view = publicConfig(loadConfig());
  assert.equal(view.server.token, '******');
  assert.equal(view.memory.embedding.apiKey, '******');
  assert.equal(view.tts.apiKey, '******');
  assert.equal(view.tts.gptSovits.apiKey, '******');
  assert.equal(view.tts.mimo.apiKey, '******');
  assert.equal(view.tts.volcano.apiKey, '******', '豆包 Key 不能回给扩展');
  assert.equal(view.tts.breeze.key, '******', 'Breeze Key 不能回给扩展');
  assert.equal(view.tts.minimax.apiKey, '******', 'MiniMax Key 不能回给扩展');
  assert.equal(view.tts.fishApiKey, '******', 'Fish Key 不能回给扩展');

  saveConfig(view);
  const disk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8'));
  assert.equal(disk.server.token, 'server-secret');
  assert.equal(disk.memory.embedding.apiKey, 'embed-secret');
  assert.equal(disk.tts.apiKey, 'tts-secret');
  assert.equal(disk.tts.gptSovits.apiKey, 'gpt-secret');
  assert.equal(disk.tts.mimo.apiKey, 'mimo-secret', 'MiMo 的 Key 也要落盘且不被掩码覆盖');
  assert.equal(disk.tts.volcano.apiKey, 'volcano-secret');
  assert.equal(disk.tts.breeze.key, 'breeze-secret');
  assert.equal(disk.tts.minimax.apiKey, 'minimax-secret');
  assert.equal(disk.tts.fishApiKey, 'fish-secret');
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

  /**
   * **数字和布尔保留成字符串**（2026-11-21 调整）。
   *
   * 原来这里是「数字同样不行 → 空串」。改的理由：备份口令常被手写成纯数字
   * （`"passphrase": 123456`），`backup-remote.js` 本来就会 `String()` 一下，
   * 清空反而让「推备份失败：passphrase 没配」变得莫名其妙。
   * 数组/对象才是真正会拼出垃圾的形态（上面两条），那两类继续清空。
   */
  saveConfig({ tts: { gptSovits: { apiKey: 12345 } } });
  assert.equal(loadConfig().tts.gptSovits.apiKey, '12345', '数字要保留成字符串');
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

/**
 * 2.2b：按群覆写是开放字典，`merge` 只遍历提交的键，所以「删掉某个群」
 * 用局部 patch 会静默失效（盘上那份还在，界面却说已恢复全局）。
 * 群聊页的「恢复成全局」因此必须走 saveAll / ?mode=full 整份保存。
 */
test('配置：按群覆写增改可用局部 patch，删除必须整份保存', () => {
  const d = freshDir();
  writeCfg(d, { group: { overrides: { G1: { mode: 'mention' }, G2: { maxPerHour: 5 } } } });
  patchConfig({ group: { overrides: { G2: { maxPerHour: 7 } } } });
  assert.deepEqual(loadConfig().group.overrides, {
    G1: { mode: 'mention' }, G2: { maxPerHour: 7 },
  }, '改一个群不该动别的群');

  patchConfig({ group: { overrides: { G2: { maxPerHour: 7 } } } });
  assert.ok(loadConfig().group.overrides.G1, '局部 patch 删不掉 G1，这正是要用整份保存的原因');

  const full = loadConfig();
  const rest = { ...full.group.overrides };
  delete rest.G1;
  saveConfig({ ...full, group: { ...full.group, overrides: rest } });
  assert.equal(loadConfig().group.overrides.G1, undefined, '整份保存才真的删掉');
  assert.deepEqual(loadConfig().group.overrides.G2, { maxPerHour: 7 });
});

/**
 * 掩码回填：`******` = 「沿用已保存的值」。
 *
 * 这条原来是 `saveConfig` 的私有细节，只在保存路径上生效；面板的**试听**
 * 把草稿直接交给合成，于是 `Authorization: Bearer ******` 换来上游 401，
 * 面板显示「语音服务鉴权失败」，用户以为 Key 被弄丢了。
 * 现在导出给非保存路径复用，行为必须逐条钉住。
 */
test('配置：****** 回填磁盘原值，空串才是清除', () => {
  const stored = { tts: { apiKey: 'sk-openai', mimo: { apiKey: 'sk-mimo' }, gptSovits: { apiKey: 'sk-gpt' } } };

  const kept = restoreMaskedSecrets({
    tts: { apiKey: '******', mimo: { apiKey: '******' }, gptSovits: { apiKey: '******' } },
  }, stored);
  assert.equal(kept.tts.apiKey, 'sk-openai');
  assert.equal(kept.tts.mimo.apiKey, 'sk-mimo', '试听必须拿到真 Key');
  assert.equal(kept.tts.gptSovits.apiKey, 'sk-gpt');

  /** 明确写成空串是「清除」，不能被偷偷补回来 */
  assert.equal(restoreMaskedSecrets({ tts: { mimo: { apiKey: '' } } }, stored).tts.mimo.apiKey, '');
  /** 手填新值按新值存 */
  assert.equal(restoreMaskedSecrets({ tts: { mimo: { apiKey: 'sk-new' } } }, stored).tts.mimo.apiKey, 'sk-new');
  /** 磁盘上本来就没有 Key 时，回填空串而不是把掩码当真 Key */
  assert.equal(restoreMaskedSecrets({ tts: { mimo: { apiKey: '******' } } }, {}).tts.mimo.apiKey, '');

  /** 不能改动调用方传进来的对象（试听草稿还要接着用） */
  const next = { tts: { mimo: { apiKey: '******' } } };
  restoreMaskedSecrets(next, stored);
  assert.equal(next.tts.mimo.apiKey, '******');
});

/**
 * 备份远端凭据必须打码。
 *
 * 漏掉时不是「面板上看得见」这么轻：`GET /v1/config` 只要 `state:read`
 * （默认 scope、安装时不用确认），返回体就是 `publicConfig()` ——
 * Gitee PAT / WebDAV 密码 / 备份口令三份明文会原样交给任何装上的扩展。
 */
test('配置全文：备份远端凭据也要遮罩，且保存掩码不覆盖真值', () => {
  freshDir();
  saveConfig({
    backup: {
      remote: {
        kind: 'gitee',
        gitee: { owner: 'me', repo: 'priv', token: 'gitee-pat', branch: 'master' },
        webdav: { url: 'https://dav.example/x', user: 'me', pass: 'webdav-pass' },
        passphrase: 'backup-pass',
      },
    },
  });

  const view = publicConfig(loadConfig());
  assert.equal(view.backup.remote.gitee.token, '******', 'Gitee PAT 要遮罩');
  assert.equal(view.backup.remote.webdav.pass, '******', 'WebDAV 密码要遮罩');
  assert.equal(view.backup.remote.passphrase, '******', '备份口令要遮罩');
  /** 非密钥字段不该被遮 */
  assert.equal(view.backup.remote.gitee.owner, 'me');

  saveConfig(view);
  const disk = JSON.parse(readFileSync(join(process.env.DSH_ROOST_DATA, 'config.json'), 'utf8'));
  assert.equal(disk.backup.remote.gitee.token, 'gitee-pat', '保存掩码不能把真值冲掉');
  assert.equal(disk.backup.remote.webdav.pass, 'webdav-pass');
  assert.equal(disk.backup.remote.passphrase, 'backup-pass');
});

/**
 * 数字型口令不能被 `coerceSecrets` 清空。
 *
 * 备份口令常被写成纯数字（`123456`），`backup-remote.js` 自己会 `String()`。
 * 如果保存配置时按「非字符串一律当没设置」处理，用户存一次就变成
 * 「passphrase 没配」，推备份直接失败——而且看不出来为什么。
 */
test('配置：数字型备份口令要保留成字符串，不能清空', () => {
  freshDir();
  saveConfig({ backup: { remote: { passphrase: 123456 } } });
  assert.equal(loadConfig().backup.remote.passphrase, '123456');
  /** 数组 / 对象仍然要拍平成空串（那是脏数据，拼进请求头会出事） */
  saveConfig({ backup: { remote: { passphrase: ['x'] } } });
  assert.equal(loadConfig().backup.remote.passphrase, '');
});
