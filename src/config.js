/**
 * 插件配置。存在 DSH 的数据目录里，不碰 Roost 的配置。
 *
 * 为什么不复用 Roost 的 config/bot.json：那份里是 AppID / Secret 这类凭证，
 * 属于「机器人运行环境」；这里是「DSH 这边怎么被找到、用什么人格」，
 * 生命周期不一样，混在一起升级和迁移都麻烦。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 数据目录：默认 ~/.dsh/dsh-roost，可用 DSH_ROOST_DATA 覆盖 */
export function dataDir() {
  const d = process.env.DSH_ROOST_DATA || join(homedir(), '.dsh', 'dsh-roost');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const FILE = () => join(dataDir(), 'config.json');

export const DEFAULTS = {
  server: {
    /** ai-chat 的「DSH 地址」默认指向这个端口，两边要一致 */
    port: 17321,
    /** 共享密钥。请求要带 X-Roost-Token 头；留空表示不校验（只绑本机时可行） */
    token: '',
  },
  chat: {
    /** 一轮最多等多久（秒）。ai-chat 那边等 180 秒，这里要更短，才能赶在它之前回话 */
    turnTimeoutSec: 150,
  },
  /**
   * 每一档权限能用什么：`all` = 全部工具，`chat` = 只能聊天。
   *
   * 默认 member 也是 all——这是明确选的「群聊也给本地工具」。
   * 想收紧就把 member 改成 chat。
   *
   * `unknown` 是**兜底**：拿不到权限信息时按最严处理。这一项不建议放开。
   */
  permissions: {
    owner: 'all',
    admin: 'all',
    member: 'all',
    unknown: 'chat',
  },
  persona: {
    name: '小栖',
    text: '你住在 QQ 里，是个话不多但有意思的人。回答简短口语化，通常两三句话。别用「作为 AI」这类说法。',
    rulesPrivate: '这是和主人的私聊，可以放开聊。',
    rulesSocial: '这是群聊，说话要短，别刷屏。',
  },
};

function merge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(FILE(), 'utf8'));
  } catch {
    saved = {};
  }
  return merge(structuredClone(DEFAULTS), saved);
}

export function saveConfig(next) {
  const cfg = merge(loadConfig(), next);
  writeFileSync(FILE(), JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

/** 给面板看：密钥打码 */
export function publicConfig(cfg) {
  return {
    ...cfg,
    server: { ...cfg.server, token: cfg.server.token ? '******' : '' },
    tokenSet: Boolean(cfg.server.token),
  };
}
