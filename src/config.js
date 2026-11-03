/**
 * 插件配置。存在 DSH 的数据目录里，不碰 Roost 的配置。
 *
 * 为什么不复用 Roost 的 config/bot.json：那份里是 AppID / Secret 这类凭证，
 * 属于「机器人运行环境」；这里是「DSH 这边怎么被找到、用什么人格」，
 * 生命周期不一样，混在一起升级和迁移都麻烦。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  /**
   * 可选语音合成。默认关闭：不请求上游、不加载本地模型。
   * provider 的输出通过固定回环服务交给调用方，音频格式由响应 Content-Type 指明。
   */
  tts: {
    enabled: false,
    /** openai = OpenAI-compatible /audio/speech；gpt-sovits = 原生 API；sherpa = 本地 ONNX（离线） */
    provider: 'openai',
    /** OpenAI-compatible API 根地址，需包含版本前缀（例如 /v1） */
    baseUrl: '',
    apiKey: '',
    model: '',
    voice: '',
    timeoutSec: 30,
    maxChars: 300,
    gptSovits: {
      /** GPT-SoVITS 安装目录（含 api_v2.py 和 runtime 的那层）。填了就能在面板一键启动 */
      installDir: '',
      /** 要用的角色名（面板扫描出来的下拉）。留空 = 用 tts_infer.yaml 里已经加载的那个 */
      model: '',
      /** GPT-SoVITS API 根地址，例如 http://127.0.0.1:9880 */
      baseUrl: '',
      /** 反向代理可选 Bearer 密钥；原生本地 API 通常留空 */
      apiKey: '',
      /** GPT-SoVITS 服务进程能读取到的参考音频路径 */
      referWavPath: '',
      promptText: '',
      promptLanguage: '中文',
      textLanguage: '中文',
      /** api.py 常见协议字段命名：v1=refer_wav_path，v2=ref_audio_path */
      apiVersion: 'v1',
      /** 原生 API 默认根路由；兼容 fork 可指定其固定相对路由 */
      endpointPath: '/',
    },
    /**
     * 本地 ONNX 推理（sherpa-onnx-node）。
     *
     * 引擎和模型都不进插件目录，放在数据目录里：
     *   · `dataDir/tts-runtime/node_modules` —— 原生模块（23MB），删目录即卸载
     *   · `dataDir/tts-models/<模型>`         —— 模型文件（aishell3 约 30MB）
     *
     * 这样 DSH 更新插件时不会把用户装的东西覆盖掉，也方便一键安装/卸载。
     */
    sherpa: {
      /** 目前只有 aishell3（30MB / 8kHz / 174 个音色），加模型要在 tts.js 的 SHERPA_MODELS 里登记 */
      model: 'aishell3',
      /** 留空 = 数据目录/tts-models/vits-icefall-zh-aishell3；填了就按填的找 */
      modelDir: '',
      /** 说话人编号（aishell3 是 0-173），换一个就是换一个音色 */
      sid: 88,
      /** 语速倍率，1 是原速 */
      speed: 1,
      /** CPU 线程数。2 已经够快，加多了在小机器上反而抢 CPU */
      numThreads: 2,
    },
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
    /** 工作区名字。留空 = 跟随目录名（DSH 默认）；填了就按这个名字建/改 */
    name: '',
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
   * 发文件（`qq_send_file`）。
   *
   * **默认不限制路径**：这台机器只有主人能调工具（`permissions.owner = 'all'`，
   * 其余档位是 `chat`，工具在轮开始前就被收走），所以"能发哪些文件"本来就
   * 等价于"主人想让发哪些文件"。再套一层白名单只会挡住他自己的正当操作。
   *
   * `restrictPaths` 留给需要收紧的场景（比如把机器人借给别人用）：
   * 打开后只允许 `<数据目录>/workspace`、`<数据目录>/images` 和 `extraRoots`。
   */
  sendFile: {
    /** true = 只允许白名单目录；false（默认）= 全盘可发 */
    restrictPaths: false,
    /**
     * 额外允许的根目录（绝对路径）。
     *
     * 只在 `restrictPaths` 为 true 时有意义——默认配置下填了也不看。
     * 典型用途：模型把文件生成在某个固定的项目目录里。
     */
    extraRoots: [],
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
     * **她的名字，全局唯一。**
     *
     * 0.11 起名字是「账号身份」而不是「人格属性」：换人格只换说话方式，
     * 名字不变（和 QQ-agent 的 botName 同款）。人格文件里的 `name` 已废弃，
     * 只当面板标签用（`label`）。
     *
     * 默认给「大肥鱼」——新装用户直接用这个；老用户由迁移读一次原人格名。
     */
    name: '大肥鱼',
    /**
     * 聊天内切人格指令（抄 AstrBot 的 /persona）：默认关、只对主人生效、
     * **不落盘**（进程重启失效），只影响当前会话。
     * 支持 `前缀`（列表）、`前缀 off`（回全局）、`前缀 <名字>`（切换，名字可带空格）。
     */
    command: { enabled: false, prefix: '/persona' },
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
      /**
       * 例：["https://raw.githubusercontent.com/我/我的fork/main"]
       *
       * **填人格目录的地址**（index.json 就在它下面），不是仓库 URL 本身。
       * 官方仓库的根目录就是人格目录，所以结尾到 `main` 为止；如果你 fork 后
       * 把人格放在子目录里，这里要带上那个子目录名。
       */
      sources: [],
    },
    /**
     * 每轮注入的人格正文字符上限。
     *
     * 角色卡类人格（QQ-Agent 那批）动辄上万字符，全量注入会把上下文吃光、
     * 历史被挤掉。超了按小节优先级裁剪（见 `personas.js` 的 `trimPersonaBody`），
     * 不超则原样注入——内置那 8 份都在 300 字符内，走不到裁剪分支。
     * 设 0 表示不裁剪（回到以前的全量注入）。
     */
    maxChars: 8000,
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

/**
 * 磁盘上的**原始**配置，不合并默认值。
 *
 * 迁移必须用它判断「用户到底设过没有」：`loadConfig()` 会把 `DEFAULTS`
 * 合并进来，于是老用户配置里明明没有 `persona.name`，读出来却是「大肥鱼」——
 * 拿合并结果判断就会误以为用户选过，永远读不到他原来的「小栖」。
 */
export function readRawConfig() {
  try {
    const j = JSON.parse(readFileSync(FILE(), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return j;
  } catch {
    /**
     * 没有文件、或者 JSON 坏了，都返回 null。
     *
     * 两者对迁移的意义一样：**配置不可信，别拿默认值去覆盖它**。
     * 区分开的话，坏配置会被当成「新装」，然后 `patchConfig` 一把写成默认值，
     * 用户那份「坏但还能手工救」的配置就没了。
     */
    return null;
  }
}

/**
 * 配置文件的版本号（mtime）。整份保存前用它做冲突检测：
 * 面板打开后别处又改过配置，直接覆盖会把别人的修改抹掉。
 */
export function configRevision() {
  try {
    // 用内容哈希而不是 mtime：同一毫秒内的两次写，mtime 分不出来
    return createHash('sha256').update(readFileSync(FILE())).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
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

/**
 * 按 DEFAULTS 的形状裁剪：DEFAULTS 里没有的键一律丢掉。
 *
 * 为什么需要：`merge` 只对**对象值**递归合并，key 本身照样写进去——所以
 * `merge(DEFAULTS, { tokenSet: true })` 反而会把 `tokenSet` 加上。展示字段
 * 和用户手写的错键都得靠这一步挡掉。
 *
 * 两条特殊规则：
 *   · **空对象当开放字典**（`persona.byChat` 的键是群 openid，形状不可知）→ 整份保留
 *   · **数组整体保留**（元素类型不可知，只校验它确实是数组）
 */
function pruneTo(shape, value) {
  if (Array.isArray(shape)) return Array.isArray(value) ? value : structuredClone(shape);
  if (shape && typeof shape === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(shape);
    const keys = Object.keys(shape);
    if (keys.length === 0) return value;
    const out = {};
    for (const k of keys) out[k] = pruneTo(shape[k], value[k]);
    return out;
  }
  return value === undefined ? shape : value;
}

const SECRET_MASK = '******';
const SECRET_PATHS = [
  ['server', 'token'],
  ['memory', 'embedding', 'apiKey'],
  ['tts', 'apiKey'],
  ['tts', 'gptSovits', 'apiKey'],
];

function valueAt(root, path) {
  return path.reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, root);
}

function putAt(root, path, value) {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
    node = node[key];
  }
  node[path.at(-1)] = value;
}

/** Masked values in a config-editor submission mean "keep existing", not a new secret. */
function restoreMaskedSecrets(next, stored) {
  const out = structuredClone(next && typeof next === 'object' ? next : {});
  for (const path of SECRET_PATHS) {
    if (valueAt(out, path) !== SECRET_MASK) continue;
    const previous = valueAt(stored, path);
    putAt(out, path, typeof previous === 'string' ? previous : '');
  }
  return out;
}

/**
 * 密钥路径上只允许字符串。
 *
 * 上面那个回填只认**恰好等于 `******` 的字符串**——如果配置编辑器提交的是
 * `{"apiKey": ["******"]}`（数组、对象），它既不会被回填、也不会被拦，
 * 会原样写进磁盘，之后每次读配置都拿到一个非字符串的"密钥"，
 * 发请求时拼出 `Bearer ******,******` 这种鬼东西（2026-11-03 审查发现）。
 * 这里统一拍平：非字符串一律当"没设置"。
 */
function coerceSecrets(cfg) {
  for (const path of SECRET_PATHS) {
    const v = valueAt(cfg, path);
    if (v !== undefined && typeof v !== 'string') putAt(cfg, path, '');
  }
  return cfg;
}

function maskSecrets(value) {
  const out = structuredClone(value);
  for (const path of SECRET_PATHS) {
    const secret = valueAt(out, path);
    if (typeof secret === 'string' && secret) putAt(out, path, SECRET_MASK);
  }
  return out;
}

export function saveConfig(next) {
  /**
   * 基线用 **DEFAULTS**，不用 `loadConfig()`。
   *
   * 面板的「配置全文」允许直接编辑 JSON，用户删掉一个字段就是想让它没了。
   * 但以前基线是磁盘上的旧配置，而 `merge` 只遍历用户提交的 key —— 删掉的字段
   * 会从旧配置里原样补回来，**删除操作静默失效**（实测：删 `memory.injectCount`
   * 和整个 `workspace` 段，保存后都还在）。
   *
   * 换成 DEFAULTS 做基线后：删掉 = 回落到默认值，既尊重删除动作，又保证结构完整
   * （不会出现 `cfg.xxx` 是 undefined）。
   *
   * 再用 `pruneTo` 裁一遍，把 DEFAULTS 之外的键（展示字段 `tokenSet`、手写错键）
   * 挡在磁盘外面。
   *
   * 前提是 DEFAULTS 覆盖所有合法字段。已核对真实配置：除了 `tokenSet`，
   * 没有任何 DEFAULTS 之外的路径。
   */
  const safeNext = restoreMaskedSecrets(next, readRawConfig() || {});
  const merged = merge(structuredClone(DEFAULTS), safeNext);
  const cfg = coerceSecrets(pruneTo(DEFAULTS, merged));
  writeFileSync(FILE(), JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}

/**
 * 改一个键，其它不动。
 *
 * 为什么必须有它
 * --------------
 * `saveConfig(next)` 的基线是 **DEFAULTS**，而 `merge` 只遍历 `next` 里的键
 * （见上面两处注释）。也就是说：**提交一个局部 patch，其它段全部回落到默认值**。
 *
 * 实测（临时数据目录）：先存 `{server:{token:'REAL', port:4321}}`，
 * 再存 `{memory:{offChats:['g1']}}` → 磁盘上 `token` 变成空串、`port` 变成 17321。
 * 也就是说「静音一个会话」会把 QQ 的 token 和端口一起重置。
 *
 * 所以约定：
 *   · **整份替换**（面板「配置全文」）用 `saveConfig` —— 删字段才会真的删掉；
 *   · **改一个键**（快捷操作、`/personas/use`、关键词配置）用 `patchConfig`。
 *
 * 实现上以**当前磁盘配置**为基线合并，再交给 `saveConfig` 走一遍 DEFAULTS 裁剪，
 * 这样既有「其它段不动」，又保住「结构完整、DEFAULTS 之外的键进不来」。
 */
export function patchConfig(patch) {
  return saveConfig(merge(loadConfig(), patch));
}

/** 给面板看：密钥打码 */
export function publicConfig(cfg) {
  /**
   * 先按 DEFAULTS 裁一遍，再统一遮住所有密钥路径。
   *
   * 不额外加 tokenSet / apiKeySet 字段：空串表示未设置，****** 表示已经设置。
   * `saveConfig` 会把这些掩码回填成磁盘中的原值；显式提交空串仍能清除密钥。
   */
  return maskSecrets(pruneTo(DEFAULTS, cfg));
}
