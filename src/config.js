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
   * **默认只有主人能用工具。** 群聊里说话的是谁不受你控制，
   * 所以默认收紧——想让普通群友也能用（比如让他帮你看个文件），
   * 自己把 member 改成 all。
   *
   * `unknown` 是兜底：拿不到权限信息时按最严处理。不建议放开。
   */
  permissions: {
    owner: 'all',
    admin: 'chat',
    member: 'chat',
    unknown: 'chat',
  },
  /** 一键流程用：装到哪、装哪个版本 */
  setup: {
    /** 留空 = <数据目录>/roost */
    roostDir: '',
    version: 'v0.8.3',
    /**
     * 用哪种方式接入机器人（第 7 期起可切）。
     * `qr` = 官方扫码；`manual` = 自己填 AppID / AppSecret。
     */
    registration: 'qr',
  },
  /**
   * 记忆：日记（三级）/ 知识图谱 / 检索 / 凌晨巩固。
   *
   * 全部默认开着且**不花白天的钱**：日记写入是本地 SQLite，巩固在凌晨做，
   * 向量默认关（要额外一个 /embeddings 端点，不配就纯关键词）。
   */
  memory: {
    enabled: true,
    /** 到期天数：普通几天后压成半句，重要两三周后压成一句。critical 永不到期 */
    keepDays: { normal: 3, important: 21 },
    /**
     * 每多少轮**全量**重注一次记忆。
     *
     * 为什么不全量每轮注：`systemPrompt.context` 每个请求都要重发一遍，
     * 全量记忆几百字，15 轮就是白烧十几倍 token。平时只给"最近说的 + 检索引擎命中的几条"，
     * 每 15 轮把全量铺一次，防止细节被上下文压缩吃掉。
     */
    deepEvery: 15,
    /** 注入的条数 */
    topK: 6,
    hits: 3,
    /**
     * 给模型注册记忆工具（`memory_search` / `memory_note`），让她能主动翻日记。
     * 关掉只是不注册，自动注入那条路照常。
     */
    tools: true,
    /** 凌晨几点巩固（本地时间）。错过就下次检查时补跑 */
    consolidateHour: 4,
    /** 巩固用的会话标识（内部用，不连 QQ） */
    consolidateChat: 'consolidate',
    /**
     * 向量检索（可选）。填成 `{ model:'bge-m3', baseUrl:'http://x/v1', apiKey:'k' }`
     * 才开；留空就是纯关键词，不报错。
     */
    embedding: null,
  },
  /**
   * 觉醒（第 5 期）：**只唤醒，做不做她自己定**。
   *
   * 以前 `speakUp` 是"到点就发一句"，现在是"到点问她一句，她可以说不"。
   * 总开关仍是 `speakUp.enabled`；这里管的是"怎么判断值不值得说"。
   */
  awake: {
    enabled: true,
    /** 清醒时段（小时）。半夜叫醒人是最糟的一种主动 */
    awakeFrom: 8,
    awakeTo: 23,
    /** 多久没聊才算「想你」 */
    missAfterHours: 6,
    /** 机会分低于这个值，连模型都不问 */
    minScore: 0.35,
    /** 「随性」每天最多几次。最尴尬的一类，必须限量 */
    casualPerDay: 1,
    /**
     * 群聊主动白名单：`[{ chatId, name, enabled }]`。
     * **默认空 = 群主动全关**。群里主动极易被踢，必须手动一个个开。
     */
    groups: [],
    /** 每个群每天最多几次 */
    maxPerGroupPerDay: 3,
    /** 群里冷场多少分钟才考虑插话 */
    groupQuietMinutes: 45,
  },
  /**
   * 上下文压缩（第 6 期）：到阈值就开新会话 + 摘要开场，旧会话保留。
   * 不用 `session/fork`（它是复制前缀，方向相反，见 compact.js 文件头）。
   */
  compact: {
    enabled: true,
    /** 群聊到多少占用就压。60% 是折中：业界 70~90% 是编码 agent 的数字 */
    atPercentGroup: 60,
    /** 私聊长任务早一点压，避免生成质量下滑 */
    atPercentC2C: 40,
    /** 新会话开场带几条最近原话（用户多留、她自己少留） */
    keepRecentUser: 8,
    keepRecentBot: 3,
    /** 读不到用量时的兜底：聊到这么多轮就压 */
    maxTurns: 40,
  },
  /** 通道：以后接别的平台时切这里 */
  channel: {
    current: 'qq',
  },
  /**
   * 主动搭话：主人一阵子没找你，你主动在私聊里说句话。
   * **只在私聊，不在群里**；默认关着。
   */
  speakUp: {
    enabled: false,
    /** 主人私聊的 openid，空 = 不工作 */
    chatId: '',
    awakeFrom: 8,
    awakeTo: 23,
    minIntervalMinutes: 180,
    maxIntervalMinutes: 480,
    maxPerDay: 3,
    prompt: '',
  },
  /**
   * 表情包库：往目录里丢图就行，文件名当标签（`开心_猫.png` → 开心、猫）。
   * 插件把清单写进提示词，AI 用 `<<image: 完整路径>>` 发。
   */
  stickers: {
    enabled: true,
    /** 留空 = <数据目录>/stickers */
    dir: '',
  },
  persona: {
    /** 当前用哪个人格（对应 personas/<id>.md） */
    current: 'default',
    /** 按会话指定：{ "群openid": "personaId" }，留空就用 current */
    byChat: {},
    /** 名字留空时用文件里 `---` 头的 name */
    name: '',
    /** 追加到人格正文后面的内容（旧配置兼容，也可以当「补充说明」用） */
    text: '',
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
