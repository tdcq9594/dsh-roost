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
    /**
     * 上游模型报 502/429/超时时的**插件层补重试**。
     *
     * 为什么 DSH 自己重试 5 次了还要我们再试：
     * DSH 的重试是同一个请求连发 5 次，退避最长 7.8 秒，全在同一条连接上。
     * 上游要是整个网关挂了 30 秒，它 5 次全挂（实测就是 502 连挂两轮）。
     * 我们等几秒**重新投一轮**，等于给它一个「上游恢复了」的窗口。
     *
     * 只对上游错误重试。blocked（要人工处理）/ empty / busy 重投只会刷屏。
     */
    upstreamRetry: {
      enabled: true,
      /** 补几次。1 = 失败后再补 1 轮，总共 2 轮 */
      attempts: 1,
      /** 补重试前等多久（毫秒） */
      delayMs: 3000,
      /**
       * **整轮的总预算（秒）**。
       *
       * 每一次尝试各自有 `turnTimeoutSec`（150 秒）的超时，
       * 补一次重试就变成 150+3+150=303 秒——而 ai-chat 那边只等 180 秒，
       * 超了它就报「宿主没回话」，群里那边也已经错过时机了。
       *
       * 所以留一个整体预算，重投前先看还剩多少，够才投。
       * 默认 170 秒，比 ai-chat 的 180 留 10 秒余量。
       */
      budgetSec: 170,
    },
  },
  /**
   * QQ 会话挂到哪个 DSH 工作区。
   *
   * 默认给机器人单开一个工作区（`<数据目录>/workspace`），
   * 不跟你的日常会话挤在同一个默认工作区里——否则机器人一开，
   * 满屏都是「QQ · xxx」的会话，还容易点到。
   * 想改回默认工作区，把 dir 设成 `__default__`。
   */
  workspace: {
    /** 工作区目录。留空 = <数据目录>/workspace；`__default__` = 用 DSH 默认工作区 */
    dir: '',
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
    /**
     * 一键装下载的框架版本 —— **现在只是兜底**。
     *
     * 安装时会先问「最新是哪个」（npm latest → Gitee tags），问到就用最新的，
     * 问不到（断网之类）才退回这里。
     *
     * 为什么改成动态：这个字段是人手填的，每次框架发版都要记得改，
     * 漏一次新机器就装回旧版——之前停在 v0.8.1/v0.8.3 而框架已经 0.8.6，
     * 就是这个原因。人手维护的版本号必然会漂。
     */
    version: 'v0.8.6',
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
    /**
     * 这些会话**不记也不读**（纯净模式）。
     *
     * 为什么需要：全局 `enabled` 一关全关，可真实场景往往是"就这个群别带记忆"——
     * 群里有人要求别记，或者不想让她把别处的梗带进来。按会话关，别处照常。
     *
     * 三条语义（照 dsh-pure-mode 的做法）：
     *   · **写入也停**：只挡注入的话，关着时说的话第二天还会从日记里冒出来；
     *   · **不动已有记忆**：关掉 ≠ 清空，关回来还在（要清用「清空本会话记忆」）；
     *   · **整轮一致**：注入、检索、写日记、记忆工具全按同一个判断走。
     * 分散着判必然漏一处 —— 漏在「写日记」上是"关着还照记"，漏在「注入」上是
     * "关了还照说"，两种在面板上都看不出来。
     */
    offChats: [],
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
     * 把易变内容（刚才说到 / 命中 / 条数）移出 system prompt，改拼进用户消息。
     *
     * 为什么要移：system prompt 每个请求都重发，内容一变整段 prompt cache
     * 就失效。`false` 退回旧行为（全部塞 system prompt，前缀每轮都变）。
     */
    freezeSystem: true,
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
   * 对话收尾：**她也会把话说完，然后退场**。
   *
   * 只做私聊——群里没有「聊完」这回事，一直有人说话。
   * 收尾**不发消息、不动记忆**，只记「收在哪 / 下次怎么接」，给两处用：
   * 下一轮提示词（接得上）、主动搭话的刹车（刚说完晚安别又冒出来）。
   */
  closing: {
    enabled: true,
    /** 收尾记录多久后失效。太旧的「上次聊到」接上去反而怪 */
    ttlDays: 7,
    /** 收尾后多久内不「随性搭话」（分钟）。只拦随性，不拦约定 */
    coolMinutes: 90,
    /** 最多留几个会话的收尾记录，防止文件无限长 */
    maxChats: 200,
  },
  /**
   * QQ 动作工具（`qq_send` / `qq_close`）：把「发言」交给模型自己调。
   *
   * 关掉就退回老行为——模型输出一整段，宿主原样 postReply。
   * 开着的话模型可以决定分几段说、说完要不要退场，也可以一句都不说。
   */
  qqTools: {
    enabled: true,
    /** 单轮最多几段。QQ 被动回复同一条消息只让回 5 次（msg_seq 1–5），留余量 */
    maxParts: 3,
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
    /**
     * 群聊到多少占用就压。
     *
     * 60% 是早期折中值，后来证明偏低：每换一次会话 prompt 缓存整段失效，
     * 对照 `qq-dsh-bridge` 实测（阈值 15% → 95%，单步 45–55 秒 → 3–4 秒），
     * 压得越勤越慢。抬到 85%，留 15% 余量容纳一次长回复的突增。
     */
    atPercentGroup: 85,
    /** 私聊单轮更小，75% 已经够早；别学编码 agent 撑到 90% */
    atPercentC2C: 75,
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
    /**
     * 旧字段，**已经不再拼进提示词**。
     *
     * 0.10.0 起人格正文在 `personas/<id>.md` 里，`default.md` 的正文就是
     * 从这两个字段抄过去的。以前提示词末尾无条件追加 `text`，于是换了人格
     * 旧的那段还挂着，且因为排最后而权重最大——表现就是「换了还是原来那个」。
     * 现在只在人格文件读不出正文时才兜底。
     */
    name: '',
    text: '',
    rulesPrivate: '这是和主人的私聊，可以放开聊。',
    rulesSocial: '这是群聊，说话要短，别刷屏。',
    /**
     * 近处指令（SillyTavern `post_history_instructions` 的近似）。
     *
     * DSH 没有「插到对话历史之后」的入口，我们只能把 order 排到最后，
     * 至少在 system 块里离历史最近。留空就用内置那一句。
     */
    near: '',
    /**
     * 人格仓库（「从仓库更新」按钮用的）。
     *
     * 默认源写死在 `persona-repo.js`（GitHub raw → Gitee raw 自动换）。
     * 这里留一个空数组当覆盖口：国内用户想换成自己的镜像或 fork 时填进来，
     * 填了就不再用默认那两个。域名必须在白名单里（只认
     * `raw.githubusercontent.com` / `gitee.com`），否则面板就成了内网探测器。
     */
    repo: {
      /** 例：["https://raw.githubusercontent.com/我/我的fork/main/personas"] */
      sources: [],
    },
  },

  /**
   * 本体自更新（设置页最上面那一块）。
   *
   * 默认走 npm 官方源；国内想换镜像填这里。空 = 用 DSH 自己配的 registry。
   * 只更新 dsh-roost 这一个包，不接受任意包名。
   */
  update: {
    registry: '',
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

/**
 * 改过默认值的字段：值还等于**旧默认**就升级。
 *
 * 为什么需要这一步：`saveConfig` 写的是整份合并后的配置，所以任何在面板上
 * 点过一下的部署，磁盘上都躺着当时那份默认值——那是我们写进去的，不是用户选的。
 * 只改 `DEFAULTS` 对它们完全无效（实测：改完 compact.js 的 85/75，老部署照旧 60/40）。
 *
 * 只在"值还等于旧默认"时才动：用户真调过的一律不碰。代价是"用户恰好也选了 60"
 * 会被顺带升级——压缩阈值改回来只需在面板上点两下，比"改了默认值却没人拿到"轻。
 */
const UPGRADED = [{ path: ['compact', 'atPercentGroup'], from: 60, to: 85 },
  { path: ['compact', 'atPercentC2C'], from: 40, to: 75 }];

function upgradeOldDefaults(cfg) {
  for (const u of UPGRADED) {
    const [a, b] = u.path;
    if (cfg?.[a]?.[b] === u.from) cfg[a][b] = u.to;
  }
  return cfg;
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(FILE(), 'utf8'));
  } catch {
    saved = {};
  }
  return upgradeOldDefaults(merge(structuredClone(DEFAULTS), saved));
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
