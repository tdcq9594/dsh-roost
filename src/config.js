// 插件配置。存在 DSH 的数据目录里，不碰 Roost 的配置。
//
// 为什么要单独一份：Roost 的 config/bot.json 里是 AppID/Secret 这类凭证，
// 属于「机器人运行环境」；这里是「AI 侧怎么连它」，两边生命周期不同，
// 混在一起会让升级/迁移都变麻烦。

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
  roost: {
    baseUrl: 'http://127.0.0.1:8080',
    /** 面板访问密钥，对应 Roost 的 webui.accessKey；只监听本机时可以留空 */
    accessKey: '',
    /** 多机器人时只接这一个；留空=全部 */
    bot: '',
  },
  chat: {
    /** 总开关。默认关——不手动打开，一句都不会真的发到 QQ */
    enabled: false,
    /** 群聊里是否响应没 @ 的消息（需要 Roost 开启「接收所有消息」） */
    replyWithoutAt: false,
    /** 单条回复的字数上限，超了截断（QQ 单条有长度限制） */
    maxReplyChars: 1500,
  },
  persona: {
    name: '小栖',
    /** 注入到系统提示词最前面 */
    text: '你住在 QQ 群里，是个话不多但有意思的人。回答简短口语化，通常两三句话。别用「作为 AI」这类说法。',
    /** 私聊时的补充规则 */
    rulesPrivate: '这是和主人的私聊，可以放开聊，能用的工具也多。',
    /** 群聊时的补充规则 */
    rulesSocial: '这是群聊，说话要短，别刷屏。不要透露任何本地文件、路径、密钥信息。',
  },
};

/** 深合并：只覆盖传进来的键 */
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

/** 给面板看的：密钥打码 */
export function publicConfig(cfg) {
  return {
    ...cfg,
    roost: { ...cfg.roost, accessKey: cfg.roost.accessKey ? '******' : '' },
    accessKeySet: Boolean(cfg.roost.accessKey),
  };
}
