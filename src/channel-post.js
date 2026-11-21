/**
 * 频道发帖：每天挑几个时间，往频道的一个论坛版块里写一篇短文。
 *
 * 骨架照 aurabot 的空间日记（`features/qzone.js`）搬过来，七步一步不少：
 *   排期 → 到期 tick → 取材 → 生成 → 清洗 → 发布 → 记账 → 对账
 * 其中 `planDiaryTimes`、重试节奏、清洗链、对账的"不判死"口径是**原样复制**，
 * 改的只有首尾两环：发布从 `send_qzone_msg` 换成 `putThread`，取材从
 * `hub.chatLogOf` 换成"频道下各文字子频道的账本"。
 *
 * ## 和空间日记必须不同的四处（都是官方接口决定的，不是取舍）
 *
 * 1. **异步 + 审核**：`putThread` 只回 `task_id`，帖子能不能上线要另外拉列表确认。
 *    所以状态是 `pending → live / stale` 三态，界面上永远不出现"成功"两个字。
 * 2. **列表不能完整枚举**：官方 `GET /channels/{id}/threads` 没有分页参数，只有
 *    `is_finish`。拿不到全量列表 → **不做"已删除"对账**，只做单向确认。
 * 3. **没有可见范围**：空间的五档（所有人/好友/部分/仅自己）在频道里没有等价物，
 *    想控制谁能看只能用私密子频道（那是频道设置，不在这里管）。
 * 4. **必须有标题**：`503005` 标题为空直接拒。所以让模型直接出 `{title,text}`，
 *    出不来再拿正文首句兜底。
 *
 * ## 为什么素材不取"发帖那个版块"
 *
 * 论坛版块里本来就没有聊天记录。而框架里 guild 场景的账本 `chat_id` 是**子频道 id**
 * （`bot/src/message.js`：`groupId = d.channel_id`），表里也没有 guild_id 列。
 * 所以要"这个频道里今天聊了什么"，只能先列子频道、再逐个查账本——见 `material()`。
 * 素材为空就写心情（与 aurabot 的"今天还没怎么聊天"同一处理），
 * **绝不为了凑素材去读私聊或别的群**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic.js';

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/**
 * 默认值。**每一项的默认都是"不动作"**：关着、不真发、不让她自己发。
 *
 * `timesPerDay` 是唯一的"每天几篇"——自动排期与她自己发共用这一个数，
 * 不再另设 `perDay`。两个"每天几篇"只会让用户问"这两个有什么区别"。
 */
export const POST_DEFAULTS = Object.freeze({
  enabled: false,
  /** 目标频道（面板从 kind=guild 的会话里选，官方没有"我加入了哪些频道"接口） */
  guildId: '',
  /** 目标版块，必须是论坛子频道（type=10007） */
  channelId: '',
  /** 每天几篇 */
  timesPerDay: 2,
  windowStart: '10:00',
  windowEnd: '23:30',
  /** 两篇之间至少隔多久，防"挤在同一分钟" */
  minGapMinutes: 180,
  minChars: 80,
  maxChars: 600,
  /** 1 文本 / 3 Markdown；HTML(2) 与 JSON(4) 不开放——排版收益低，出错面大 */
  format: 3,
  /** 试运行：只记账不外发。默认开——频道是公开场合，第一篇该让人看一眼 */
  dryRun: true,
  /** 允许她在对话里自己发（工具 `qq_post_thread`） */
  allowTools: false,
  /** 每次发之前等她点头（走待发队列，不是对话里多轮确认） */
  askFirst: true,
  /** 拿到 task_id 的时刻。不等于"已上线"，界面据此判断"试过没有" */
  verifiedAt: 0,
});

const MAX_HISTORY = 100;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日键 `YYYY-MM-DD`。日记按本地日算，不按 UTC。 */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/* ------------------------------------------------------------------ *
 * 排期：从 aurabot `features/qzone.js` 原样搬（含 windowMinutes）
 * ------------------------------------------------------------------ */

const DAY_MINUTES = 1440;
const mod = (v, base) => ((v % base) + base) % base;
const asNum = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * 分钟窗口跨度（跨天自动绕回；from === to 为全天 1440 分钟）。
 *
 * 搬自 aurabot `core/time-window.js`。roost 里没有这份工具，而 `planDiaryTimes`
 * 的跨天处理依赖它，所以连它一起搬——自己重写必然漏掉「22:00–02:00」这种窗口。
 */
export function windowMinutes(fromMin, toMin) {
  const f = mod(asNum(fromMin, 0), DAY_MINUTES);
  const t = mod(asNum(toMin, 0), DAY_MINUTES);
  if (f === t) return DAY_MINUTES;
  return t > f ? t - f : DAY_MINUTES - f + t;
}

const toMin = (str) => {
  const [h, m] = String(str).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

/**
 * 给某一天排发帖时间：窗口内随机 n 个时刻，两两间隔 ≥ gap 分钟。
 * 纯函数（`rand` 可注入，测试用固定序列）。
 *
 * 三个边界照 aurabot 的做法：
 *   · 跨天窗口（22:00–02:00）按绕回后的跨度排；
 *   · `from === to` 视为全天（与 proactive-policy 口径一致）；
 *   · 200 次随机都排不开就均分兜底，绝不返回少于 n 个（否则当天会少发）。
 */
export function planDiaryTimes({ timesPerDay, windowStart, windowEnd, minGapMinutes }, rand = Math.random) {
  const a = toMin(windowStart);
  const b = toMin(windowEnd);
  const n = Math.max(0, Math.round(timesPerDay));
  const span = windowMinutes(a, b);
  if (n === 0 || span <= 0) return [];
  const gap = Math.min(minGapMinutes, Math.floor(span / Math.max(n, 1)));
  for (let attempt = 0; attempt < 200; attempt++) {
    const offsets = Array.from({ length: n }, () => Math.floor(rand() * span)).sort((x, y) => x - y);
    if (offsets.every((p, i) => i === 0 || p - offsets[i - 1] >= gap)) {
      return offsets.map((off) => ((a + off) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES).sort((x, y) => x - y);
    }
  }
  return Array.from({ length: n }, (_, i) => Math.floor((span / n) * (i + 0.5)))
    .map((off) => ((a + off) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES)
    .sort((x, y) => x - y);
}

/** 分钟数 → `HH:MM`，面板和日志共用 */
export const asHHMM = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

/* ------------------------------------------------------------------ *
 * 配置归一化
 * ------------------------------------------------------------------ */

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const hhmmOf = (v, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim()) ? String(v).trim() : fallback);

/**
 * 把面板/旧配置写进来的值夹到合法范围。
 *
 * **坏 id 一律清空而不是保留**：带一个不存在的 channelId 去发，只会得到
 * `10003 UnknownChannel`，用户看不出是自己填错了；清空之后面板会显示"还没选版块"。
 */
export function normalizePostCfg(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const minChars = clamp(r.minChars, 20, 1000, POST_DEFAULTS.minChars);
  const maxChars = Math.max(minChars, clamp(r.maxChars, 20, 2000, POST_DEFAULTS.maxChars));
  return {
    enabled: r.enabled === true,
    guildId: /^\d{1,20}$/.test(String(r.guildId || '').trim()) ? String(r.guildId).trim() : '',
    channelId: /^\d{1,20}$/.test(String(r.channelId || '').trim()) ? String(r.channelId).trim() : '',
    timesPerDay: clamp(r.timesPerDay, 0, 24, POST_DEFAULTS.timesPerDay),
    windowStart: hhmmOf(r.windowStart, POST_DEFAULTS.windowStart),
    windowEnd: hhmmOf(r.windowEnd, POST_DEFAULTS.windowEnd),
    minGapMinutes: clamp(r.minGapMinutes, 0, 1440, POST_DEFAULTS.minGapMinutes),
    minChars,
    maxChars,
    format: Number(r.format) === 1 ? 1 : 3,
    dryRun: r.dryRun !== false,
    allowTools: r.allowTools === true,
    askFirst: r.askFirst !== false,
    verifiedAt: Math.max(0, Number(r.verifiedAt) || 0),
  };
}

/* ------------------------------------------------------------------ *
 * 生成结果的清洗与兜底
 * ------------------------------------------------------------------ */

/**
 * 清洗：与 aurabot 同一套正则链，另外去掉 Markdown 标题/引用前缀。
 *
 * 为什么连 Markdown 前缀也要去：频道帖子的 `format` 由我们自己决定（3 = Markdown），
 * 但模型偶尔会自己写 `# 标题`，正文里再出现一次标题会显得重复。
 */
export function cleanDraft(text) {
  return String(text ?? '')
    .replace(/\|\|\|/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^["「“]|["」”]$/g, '')
    .trim();
}

/**
 * 从正文提炼标题（模型没给 / 给坏了的兜底）。
 *
 * 频道帖子必须有标题（`503005`），而空间说说没有——这是两边的形态差异，
 * 不是可以商量的地方。取第一句话、去标点、限 20 字；实在没有就用日期。
 */
export function pickTitle(text, at = Date.now()) {
  const d = new Date(at);
  const fallback = `${d.getMonth() + 1}月${d.getDate()}日 随手记`;
  const first = String(text || '')
    .split(/[。！？!?\n]/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!first) return fallback;
  const t = first.replace(/[，,、：:；;"'“”‘’（）()《》【】…—\s]+$/g, '').slice(0, 20);
  return t || fallback;
}

/**
 * 解析模型输出，得到 `{ title, text }`。
 *
 * 按**模型实际能做到的**顺序退让，不是按我想要的顺序：
 *   1. JSON 对象（旧格式，仍兼容）；
 *   2. `标题\n---\n正文` —— 现在的主动格式。比 JSON 好写得多，模型几乎不会写错；
 *   3. 纯文本兜底：整段当正文，标题从首句取。
 *
 * 2026-11-17 实机教训：要求 JSON 时，同一个模型连续两次都没给出合法 JSON，
 * 面板上只剩一句"模型没按格式输出"——用户完全无法推进。**格式要求必须按
 * 模型的能力来定，而不是按实现的方便来定。**
 *
 * 只有一种情况仍然硬拒：文本以 `{` 或 `[` 开头（说明它想给 JSON 但写坏了）——
 * 那种必须失败，否则会把 `{"title":…` 原文发到公开版块。
 */
export function parseDraft(raw, { maxChars = POST_DEFAULTS.maxChars, at = Date.now() } = {}) {
  const src = String(raw ?? '').trim();
  if (!src) throw new Error('模型没有输出内容，本次未发布');

  const stripFence = (t) => t.replace(/^```(?:json|JSON|text)?\s*/i, '').replace(/\s*```$/, '');
  const tryParse = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  /**
   * 去掉模型爱加的开场白。只砍**明确是元话语**的那几种前缀，
   * 不动正文本身（正文里出现"好的"是正常的）。
   */
  const stripPreamble = (t) => t
    .replace(/^(好的|好呀|嗯|OK|ok)[，,。！!]?\s*/, '')
    .replace(/^(以下是|这是|下面是我写的|我写一篇)[^。\n]{0,20}[：:]\s*/, '')
    .trim();

  /* ---- 1) JSON ---- */
  let obj = tryParse(stripFence(src));
  if (!obj) {
    const a = src.indexOf('{');
    const b = src.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParse(src.slice(a, b + 1));
  }
  if (Array.isArray(obj) && obj.length) obj = obj[0];
  if (obj && typeof obj === 'object') {
    const text = cleanDraft(obj?.text);
    if (!text) throw new Error('日记正文是空的，本次未发布');
    if (text.length > maxChars + 20) throw new Error(`日记正文超过 ${maxChars} 字，本次未发布`);
    return { title: (cleanDraft(obj?.title) || pickTitle(text, at)).slice(0, 20), text };
  }

  /**
   * 想给 JSON 却写坏了（以 `{` / `[` 开头）：必须失败。
   * 直接落到纯文本兜底会把半截 JSON 当正文发出去，比"这次没写成"难看得多。
   */
  if (/^[{[]/.test(stripFence(src))) {
    throw new Error('模型想输出 JSON 但没写完整，本次未发布');
  }

  /* ---- 2) 标题 / --- / 正文 ---- */
  const bar = src.split(/\n\s*-{3,}\s*\n/);
  if (bar.length >= 2) {
    const title = cleanDraft(stripPreamble(bar[0])).replace(/^["'「『]|["'」』]$/g, '');
    const text = cleanDraft(bar.slice(1).join('\n\n'));
    if (text) {
      if (text.length > maxChars + 20) throw new Error(`日记正文超过 ${maxChars} 字，本次未发布`);
      return { title: (title || pickTitle(text, at)).slice(0, 20), text };
    }
  }

  /* ---- 3) 纯文本：整段当正文 ---- */
  const plain = cleanDraft(stripPreamble(stripFence(src)));
  if (!plain) throw new Error('模型没有输出可用的内容，本次未发布');
  if (plain.length > maxChars + 20) {
    /** 超一点就截到句号，别整篇丢掉——模型写长了是常事 */
    const cut = plain.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
    const text = end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut;
    return { title: pickTitle(text, at).slice(0, 20), text };
  }
  return { title: pickTitle(plain, at).slice(0, 20), text: plain };
}

/* ------------------------------------------------------------------ *
 * 错误码人话
 * ------------------------------------------------------------------ */

/**
 * 官方业务错误码 → 「发生了什么 / 你现在做什么」。
 *
 * 只收**确定含义**的码，认不出的一律原样显示。宁可显得笨，也不要给错建议——
 * 错建议的代价可能是用户把机器人移出频道、配置全丢。
 *
 * 表放在模块级而不是函数里，是为了让 `pickErrorCode` 用**同一份码表**去 message
 * 里反查（老框架不透传 `qqCode` 时的唯一退路）。
 */
export const ERROR_HINTS = Object.freeze({
  11253: {
    title: '这个机器人还没拿到「论坛」权限',
    /**
     * 位置要写死到"哪个后台、哪个菜单"，因为这是唯一一个**必须离开本产品**才能修的问题。
     * 开放平台改过几次版，所以给出的是"找这个名字"而不是固定的第几级菜单。
     */
    todo: [
      '在 QQ 开放平台（q.qq.com）选中这个机器人，进「开发 → 接口权限 / 能力配置」，把「论坛」勾上',
      '回到频道设置 → 机器人 / 成员管理，把机器人移出频道，再重新添加（少了这步，勾了也不生效）',
      '回来点「重新体检」',
    ],
    url: 'https://q.qq.com/',
  },
  11264: {
    title: '管理员没给这个机器人「论坛」权限',
    todo: ['确认是在正确的频道里操作', '把机器人移出频道再重新添加一次', '回来点「重新体检」'],
  },
  11282: {
    title: '你在频道里不是管理员',
    todo: ['只有频道主/管理员能建版块或改设置', '找频道主操作，或者改用一个已经建好的论坛版块'],
  },
  11265: { title: '这个机器人被平台限制了', todo: ['去开放平台看机器人状态；这不是配置问题'] },
  610007: { title: '机器人不在这个频道里了', todo: ['重新把机器人拉进频道，然后点「重新体检」'] },
  304018: { title: '机器人没连上 QQ', todo: ['去「频道排障」看连接状态', '等它自动重连，或重启框架后再试'] },
  503004: { title: '发得太频了', todo: ['等十分钟再发', '把「每天几篇」调小一点'] },
  503005: { title: '帖子没有标题', todo: ['重新生成一篇（标题是模型给的，这次可能漏了）'] },
  503006: { title: '帖子正文是空的', todo: ['重新生成一篇'] },
  503017: { title: '正文太长', todo: ['把「字数上限」调小，或让她写短一点'] },
  503020: { title: '标题太长', todo: ['重新生成一篇（标题会截到 20 字）'] },
  503016: { title: '链接太多', todo: ['这一版不发文内链接，重新生成一篇'] },
  10003: { title: '这个版块不存在了', todo: ['回「发到哪」重新选一个版块'] },
});

const HINT_CODES = Object.keys(ERROR_HINTS);
/** 只在已知码里找：否则 `PUT /channels/2224603/threads` 里的 id 会被当成错误码 */
const HINT_RE = new RegExp(`\\b(?:${HINT_CODES.join('|')})\\b`);

/**
 * 从错误对象里取业务码，三层按可靠性排：
 *   1. `e.qqCode` —— 框架 2026-11-17 起在 rpc 错误里透传的官方业务码；
 *   2. `e.code` / `e.status` —— 可能是我们自己的 FORBIDDEN，也可能是数字；
 *   3. 从 message 里**只认已知码** —— 老框架（不透传 qqCode）的唯一退路。
 *
 * 第 3 层是兜底不是主路：官方 message 通常只有中文描述，能捞到码算运气好。
 */
export function pickErrorCode(e) {
  const direct = Number(e?.qqCode ?? e?.code ?? e?.status);
  if (Number.isFinite(direct) && ERROR_HINTS[direct]) return String(direct);
  const hit = String(e?.message || '').match(HINT_RE);
  if (hit) return hit[0];
  return String(e?.qqCode ?? e?.code ?? '').trim();
}

/**
 * 把官方错误码翻成人话。返回的 `say` 是**一句可以直接转述**的话：
 * 模型拿到 `{ok:false, message, todo, say}` 时，`say` 里已经写好了"该让主人做什么"，
 * 它只要复述，不必自己猜原因——这条是「链路不通时用户能不能被正确指引」的关键。
 */
export function humanError(code, message = '') {
  const c = String(code ?? '').trim();
  const raw = String(message || '').trim();
  /**
   * 创建子频道被拒。
   *
   * 2026-11-17 实测两次（不同频道、参数已和官方示例对齐）都回这一句，
   * 说明**不是参数问题**。官方 NodeSDK 文档对这个接口有三条前置条件：
   *   · 私域接口，**公域机器人暂不支持申请**；
   *   · 机器人必须是频道管理员；
   *   · 开通后需要**先把机器人移出频道再重新添加**才生效。
   * 所以提示要给这三条自查，而不是让人继续调参数。
   */
  if (/channel type create not support/i.test(raw)) {
    return {
      code: 0,
      title: '创建子频道被拒：这个接口对你没开放',
      todo: [
        '开放平台里确认这个机器人是「私域」——公域机器人申请不了创建子频道接口',
        '确认机器人在频道里是管理员（频道设置 → 成员 → 机器人）',
        '如果是刚开通的权限：把机器人从频道移出，再重新添加一次才生效',
        '上面三条都满足了还是这句错：那就是官方没给这个机器人开这个接口，别再试参数了，直接手动建',
        '手动建：频道设置 → 新建子频道 → 类型选「论坛」，建好回来点「重新体检」',
      ],
      url: 'https://bot.q.qq.com/wiki/develop/nodesdk/channel/post_channels.html',
      raw,
      say: `创建子频道被拒（${raw}）。请告诉主人：这个接口只对私域机器人开放，且要求机器人是频道管理员、开通后重新添加过；最快的方式是手动建一个论坛子频道。`,
    };
  }

  /**
   * 连不上 roost 框架：外接协议没开 / 进程退了 / 端口填错。
   *
   * 这是**最常见**的一种失败，而且用户自己就能修。以前它落到「没见过的错误 +
   * 把原文发给开发者」——把一句「你框架没开」说成了「这是个未知 bug」，
   * 方向完全错了（2026-11-19 截图反馈：发帖页体检里出现「没见过的错误」）。
   *
   * 判据两条：`roost-host.js` 抛错时带的 `code: 'NETWORK'`，或消息以「连不上 roost」
   * 开头（老版本没透传 code 时的退路）。这条必须先于 `ERROR_HINTS` 判。
   */
  if (c === 'NETWORK' || /^连不上 roost/.test(raw)) {
    return {
      code: 'NETWORK',
      title: '连不上 roost 框架',
      todo: [
        '确认 roost 还在跑：回「概览」看顶上的连接状态，或者去「接入」页点一次重连',
        '确认开了「外接协议」，端口和「设置」里填的一致——以「接入」页显示的为准，别照着猜',
        '起来之后点「重新体检」——这一步不用去开放平台，也不是权限问题',
      ],
      raw,
      say: '连不上 roost 框架（外接协议没开、进程退了，或端口填错）。'
        + '请告诉主人：先确认 roost 在运行、外接协议开着、端口对得上，然后点「重新体检」。'
        + '这不是权限问题，不用去开放平台。',
    };
  }

  const hit = ERROR_HINTS[c];
  if (hit) {
    return {
      code: c,
      title: hit.title,
      todo: hit.todo,
      /** 需要去外部后台才能修的，带上地址，面板渲染成可点的链接 */
      url: hit.url || '',
      raw,
      say: `${hit.title}。请告诉主人：${hit.todo.map((x, i) => `${i + 1}) ${x}`).join(' ')}`,
    };
  }
  /**
   * 兜底：真的不认识的码。
   *
   * `todo` 里**不再抄一遍原文**——面板会把 `raw` 单独渲染成红字，抄一遍就是
   * 同一句话在一屏里出现两次（2026-11-19 截图）。`say` 仍带原文：模型转述时
   * 需要它，否则只能自己编一个原因。
   */
  const detail = raw ? `${c} ${raw}`.trim() : (c || '（没有错误码）');
  return {
    code: c,
    title: '没见过的错误',
    todo: ['把下面这行原样发给开发者（截图或复制都行）'],
    raw,
    say: `没见过的错误。请把原文转述给主人，不要自己猜原因：${detail}`,
  };
}

/**
 * 前置条件不满足时的统一返回（和 `humanError` 同构，也带 `say`）。
 *
 * 这些拒绝几乎都是"还没配好"，而**怎么做**只有面板上那几句话说得清。
 * 模型自己编一句"发帖功能好像没开"没用；把操作路径写进 `say`，它照读就行。
 */
export function guide(title, todo = []) {
  return {
    ok: false,
    message: title,
    todo,
    say: todo.length ? `${title}。请告诉主人：${todo.map((x, i) => `${i + 1}) ${x}`).join(' ')}` : title,
  };
}

/**
 * 账本里这一行是谁说的。
 *
 * **不能靠 `kind === 'bot'` 判断**——踩过：机器人自己发言写进账本时，`kind` 存的是
 * 会话类型（`group` / `c2c` / `guild`），空的是 `user_name`（见 `bot/src/outbound.js`
 * 的 `#recordOutbound`：`userId: ''`, `userName: ''`）。所以判据只能是
 * **有没有用户名**：人说话必有名字，她自己说的必然没有。
 *
 * 没名字时还要分两种：`notice`（入群/撤回这类系统事件）是 `（系统）`，
 * 其余才是 `我`。把它们混成"我说过"，她会开始在日记里复述系统通知。
 */
/**
 * 「把机器人加进频道」那条链接 —— **二维码的内容就是它**。
 *
 * 2026-11-17 实测解出开放平台那张码：
 * `https://qun.qq.com/qunpro/robot/share?robot_appid=102056878`
 *
 * 既然只是 appid 拼出来的，就不必再让用户存图：面板显示这条链接，
 * 手机上点开会打开机器人资料卡，选「添加至频道」即可。
 */
export function shareUrlOf(appid) {
  const id = String(appid ?? '').replace(/\D/g, '').slice(0, 20);
  return id ? `https://qun.qq.com/qunpro/robot/share?robot_appid=${id}` : '';
}

export function whoOf(row) {
  const name = String(row?.who ?? '').trim();
  if (name && name !== '（未知）') return name;
  return String(row?.kind || '') === 'notice' ? '（系统）' : '我';
}

/* ------------------------------------------------------------------ *
 * 体检：四条结论
 * ------------------------------------------------------------------ */

/**
 * 面板顶部那条"能不能发"的状态机。**纯函数**：探测结果由宿主传进来。
 *
 * 为什么不在这里直接探测：探测要走网络（`qq.call`），纯函数才能单测；
 * 而且面板开页时要能"先渲染、再异步刷新"，不能卡在请求上。
 *
 * @param {object} cfg   channelPost 配置
 * @param {object} probe 探测结果 `{ guildEnabled, inGuild, forumChannels, perm, permError }`
 */
export function postSteps(cfg, probe = {}) {
  const steps = [];
  const forum = Array.isArray(probe.forumChannels) ? probe.forumChannels : null;

  /**
   * 第 1 盏灯**只回答一件事：总开关开着没**。
   *
   * 曾经把"有没有选频道"也塞进这里，后果是主人实测遇到的：
   * `guild.enabled=true` 明明开了，灯却是空心圈，因为配置里还没有 `guildId`。
   * 他看到"第一步没亮"，跑去反复确认开关——开关没错，是判据混了。
   * "选频道/选版块"归第 3 盏灯，那才是它们该待的地方。
   */
  if (probe.guildEnabled !== true) {
    steps.push({
      id: 'guild',
      state: 'todo',
      jump: 'ch-home',
      detail: '频道总开关还关着：去「频道总览」的 01 卡「总开关与粒度」，把「启用频道」打开',
    });
  } else {
    steps.push({ id: 'guild', state: 'ok', detail: '总开关已打开' });
  }

  // 权限：读一次帖子列表就知道；`perm === null` 表示还没探测
  if (probe.perm === true) steps.push({ id: 'perm', state: 'ok', detail: '有论坛权限' });
  else if (probe.perm === false) {
    /**
     * 失败项**必须把 `todo` 一并带出去**。
     *
     * 以前只给 `title`（"还没拿到论坛权限"），那三步走去哪看？没有。
     * 而其中"把机器人移出频道再重新添加"正是最容易漏、也最决定成败的一步。
     */
    const hi = humanError(probe.permError?.code, probe.permError?.message);
    steps.push({ id: 'perm', state: 'fail', detail: hi.title, todo: hi.todo, url: hi.url });
  } else steps.push({ id: 'perm', state: 'todo', detail: '还没查：点右上角「重新体检」' });

  /**
   * 第 3 盏：选频道 → 频道可读 → 选版块。四件事按这个顺序问，
   * 因为后一件都依赖前一件。
   */
  if (!cfg.guildId) {
    steps.push({
      id: 'channel',
      state: 'todo',
      detail: '还没选频道：在下面 03 卡「发到哪」里选一个。列表是空的，就先把机器人拉进频道、在频道里 @ 它一次，再回来点「重新体检」',
    });
  } else if (probe.inGuild === false) {
    steps.push({
      id: 'channel',
      state: 'fail',
      detail: '这个频道读不到，机器人可能被移出去了：重新把它拉进频道，再点「重新体检」',
    });
  } else if (forum && !cfg.channelId) {
    steps.push({
      id: 'channel',
      state: 'todo',
      detail: forum.length
        ? `这个频道里有 ${forum.length} 个论坛版块：在下面 03 卡「发到哪」里选一个`
        : '这个频道里还没有论坛版块：在下面 03 卡点「试着建一个」；建不出来就自己建（频道设置 → 新建子频道 → 类型选「论坛」）',
    });
  } else if (forum && cfg.channelId && !forum.some((c) => String(c.id) === String(cfg.channelId))) {
    steps.push({ id: 'channel', state: 'fail', detail: '选中的版块不在列表里了：回下面 03 卡重新选一个' });
  } else if (cfg.channelId) {
    steps.push({ id: 'channel', state: 'ok', detail: '已选发帖版块' });
  } else {
    steps.push({ id: 'channel', state: 'todo', detail: '还没选版块：在下面 03 卡「发到哪」里选一个' });
  }

  /**
   * 第 4 盏不是**配置项**，是"试过没有"的验证状态。
   *
   * 它原来跟前面三盏一样算 `todo`，后果很要命：配置全对、只差没发过一篇的人，
   * 体检永远显示「还差 1 项」，于是以为哪里没配好，翻来翻去找不到问题。
   * 现在它是 `info`（中性灰点）：**不影响 ready**，只在界面上提示"建议发一篇确认"。
   */
  steps.push(cfg.verifiedAt > 0
    ? { id: 'sent', state: 'ok', detail: '已经发过一篇了' }
    : {
      id: 'sent',
      state: 'info',
      detail: '还没真发过（不算配置问题）：去 04 卡点「现在真发一篇」确认一次，成功之后她才能在对话里自己发',
    });

  /** `ready` 只看**配置**那三项：能不能发，不取决于"你有没有点过按钮" */
  const cfgSteps = steps.filter((s) => s.id !== 'sent');
  const blocked = cfgSteps.some((s) => s.state === 'fail');
  const pending = cfgSteps.filter((s) => s.state !== 'ok').length;
  return {
    steps,
    blocked,
    pending,
    verified: cfg.verifiedAt > 0,
    ready: !blocked && pending === 0,
  };
}

/* ------------------------------------------------------------------ *
 * 落盘
 * ------------------------------------------------------------------ */

/**
 * 状态文件：`<数据目录>/channel-posts.json`，形如
 * `{ plan: { day, times, done, retry }, history: [] }`。
 *
 * 与 aurabot 的 `diary.json` 同构，只是没有 `readJson/writeJson` 那两个 helper
 * （roost 里各模块都是自己 `readFileSync` + `renameSync`）。
 * 历史**不进 config.json**：那是可变长数据，放配置里每次都要整份落盘。
 */
export function createPostStore({ dirOf, now = () => Date.now(), log = () => {} } = {}) {
  const fileOf = () => join(dirOf(), 'channel-posts.json');

  function read() {
    const empty = { plan: { day: '', times: [], done: [], retry: {} }, history: [] };
    try {
      const f = fileOf();
      if (!existsSync(f)) return empty;
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      return {
        plan: {
          day: String(raw?.plan?.day ?? ''),
          times: Array.isArray(raw?.plan?.times) ? raw.plan.times.filter((x) => Number.isFinite(Number(x))) : [],
          done: Array.isArray(raw?.plan?.done) ? raw.plan.done : [],
          retry: raw?.plan?.retry && typeof raw.plan.retry === 'object' ? raw.plan.retry : {},
        },
        history: Array.isArray(raw?.history) ? raw.history.filter((x) => x && typeof x === 'object') : [],
      };
    } catch (e) {
      // 读坏了不能让整个发帖功能瘫掉：回空状态，下一篇重新排期
      log(`发帖记录读不出来（${e.message}），本次按空记录处理`);
      return empty;
    }
  }

  function save(s) {
    const body = { plan: s.plan, history: (s.history || []).slice(0, MAX_HISTORY) };
    writeFileAtomic(fileOf(), JSON.stringify(body, null, 2));
    return body;
  }

  return { file: fileOf, read, save };
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * @param {object} o
 * @param {() => object} o.cfgOf            读完整配置（取 `.channelPost`）
 * @param {(patch:object)=>void} o.patchCfg 写配置（深合并，只传要改的键）
 * @param {() => string} o.dirOf            数据目录
 * @param {(method:string, args:any[])=>Promise<any>} o.callQq   `qq.call` 的薄包装
 * @param {(name:string, text:string, opts?:object)=>Promise<string>} o.systemTurn
 * @param {(q:{chatId:string, limit?:number})=>object[]} o.ledgerRecent
 * @param {(row:object)=>void} o.journalAdd
 */
export function createChannelPost({
  cfgOf, patchCfg = () => {}, dirOf, callQq, systemTurn, ledgerRecent, journalAdd, log = () => {}, now = () => Date.now(),
  /**
   * 宿主注入的两个运行态判据（2026-11-18）。**不在这里 import `features.js`**：
   * 这个模块只依赖 `node:fs` / `node:path`，它是发帖引擎，不是配置消费者；
   * 口径统一由宿主维持（`paused()` 已含总开关与断线冷却）。
   *
   *   · `pausedOf()`  —— 总开关关着 / 刚断线失败过 → 不发
   *   · `dryRunOf()`  —— 试运行 → 只生成不发布（与短记自己的 `channelPost.dryRun` 是 OR）
   */
  pausedOf = () => false,
  dryRunOf = () => false,
}) {
  const store = createPostStore({ dirOf, now, log });
  const cfgOfPost = () => normalizePostCfg(cfgOf()?.channelPost);
  /** 同一时间只写一篇：tick 与手动点"现在发一篇"可能撞上 */
  let busy = false;
  /** 子频道列表缓存：5 分钟内不重复打接口（体检 + 取材都要用） */
  let chanCache = { at: 0, guildId: '', list: null };

  /**
   * 今天真发了几篇。
   *
   * 只数**真的提交成功过**的：`pending`（已受理等审核）/ `live`（已上线）/ `stale`（没看到）。
   * 其余一律不算：
   *   · `draft` —— 她写好等人点头，还没发；
   *   · `dryRun` —— 试运行只记账；
   *   · `failed` —— **没发出去**（这条踩过：失败的记录占了额度，
   *     于是失败后的重试被"今天已经发满"直接跳过，等于一次失败就吞掉当天那一篇）。
   */
  const POSTED_STATES = new Set(['pending', 'live', 'stale']);
  const dayCount = (history, at = now()) => {
    const day = dayKey(new Date(at));
    return (history || []).filter((r) => r
      && dayKey(new Date(Number(r.at) || 0)) === day
      && POSTED_STATES.has(String(r.state || ''))
      && r.dryRun !== true).length;
  };

  /* ---------------- 版块 ---------------- */

  async function listGuildChannels(guildId, { fresh = false } = {}) {
    if (!guildId) return null;
    const stale = now() - chanCache.at > 5 * 60_000 || chanCache.guildId !== guildId;
    if (!fresh && !stale && Array.isArray(chanCache.list)) return chanCache.list;
    const list = await callQq('getGuildChannels', [guildId]);
    const arr = Array.isArray(list) ? list : [];
    chanCache = { at: now(), guildId, list: arr };
    return arr;
  }

  /**
   * 机器人加入的频道（`GET /users/@me/guilds`）。
   *
   * **不依赖会话映射**——这一点很关键：以前频道下拉是从 `chats`（收到过消息的会话）
   * 里反推的，机器人刚拉进频道、还没人说话时列表就是空的，而"选频道"又发生在
   * 收到消息之前，形成死锁。这个接口直接给机器人所在的频道，没有那条依赖。
   */
  async function listGuilds() {
    const list = await callQq('getMyGuilds', []);
    const arr = Array.isArray(list) ? list : Array.isArray(list?.guilds) ? list.guilds : [];
    return arr
      .map((g) => ({ id: String(g?.id || ''), name: String(g?.name || '') }))
      .filter((g) => g.id);
  }

  /**
   * 某个频道下的**全部**子频道（不只是论坛）。
   *
   * 面板要让人看清"这个频道里都有哪些子频道、哪个能发帖"。只回论坛版块的话，
   * 用户会以为"我的子频道怎么没列出来"——他看到的应该是完整的频道结构，
   * 发不了的类型标出来并禁选。
   */
  async function listSubChannels(guildId) {
    const gid = String(guildId || '').trim();
    if (!/^\d{1,20}$/.test(gid)) return [];
    const all = await listGuildChannels(gid, { fresh: true });
    return (all || [])
      .map((c) => {
        const type = Number(c?.type) || 0;
        return { id: String(c?.id || ''), name: String(c?.name || ''), type, isForum: type === 10007 };
      })
      .filter((c) => c.id);
  }

  /**
   * 试着建一个论坛版块。
   *
   * **不承诺成功**：官方「创建子频道」的请求体 `type` 没给枚举（只有响应里列了 10007），
   * 示例也只有文字/语音；而且该接口需要管理员权限。失败时把错误码原样带回去，
   * 由面板改说"你手动建一个"。
   */
  /**
   * 建一个论坛子频道。
   *
   * **论坛类型是支持的。** 官方 NodeSDK 文档写着「目前不支持创建的子频道类型：
   * 子频道分组」（GoSDK 版本多一条「私密子频道」），`ChannelType` 列表里
   * 10007=论坛 也是创建参数之一；另有实现者反馈"新建子频道默认就是 10007"。
   *
   * 第一版只传了 `{ name, type, position }`，服务端回
   * `channel type create not support` —— 那不是"论坛不支持"，而是缺字段：
   * SDK 里 `sub_type` 标的是**必填**（api-v2 文档写"否"，以 SDK 为准更安全），
   * 另外 `parent_id` / `private_type` / `speak_permission` 也按官方示例补齐，
   * 让请求和示例长得一样，排除参数形态造成的歧义。
   */
  async function createForumChannel(name = '她的日记本') {
    const cfg = cfgOfPost();
    if (!cfg.guildId) return { ok: false, message: '还没选频道' };
    const clean = String(name || '').trim().slice(0, 20) || '她的日记本';
    try {
      const r = await callQq('createGuildChannel', [cfg.guildId, {
        name: clean,
        type: 10007,
        /** 论坛没有二级分类，但 SDK 标必填；给 0 与"闲聊"同值，不影响类型判定 */
        sub_type: 0,
        position: 1,
        /** "0" = 不放进任何分组（官方示例用的就是字符串 "0"） */
        parent_id: '0',
        private_type: 0,
        speak_permission: 1,
      }]);
      chanCache = { at: 0, guildId: '', list: null };
      return { ok: true, id: String(r?.id || ''), name: String(r?.name || clean) };
    } catch (e) {
      const h = humanError(pickErrorCode(e), e?.message);
      return {
        ok: false, message: h.title, todo: h.todo, say: h.say,
        /** 原文必须带出去：这一条是"参数到底哪不对"的唯一线索 */
        raw: String(e?.message || e),
      };
    }
  }

  /* ---------------- 取材 ---------------- */

  /**
   * 这个频道今天聊了什么。
   *
   * 走"列子频道 → 逐个查账本"而不是直接查一个 chatId：论坛版块里没有聊天，
   * 而账本的 chat_id 是子频道 id、没有 guild 维度（见文件头注释）。
   * 只取文字子频道（type=0），最多 8 个，够写一篇短记了。
   */
  async function material({ limitPerChat = 12, maxLines = 60 } = {}) {
    const cfg = cfgOfPost();
    if (!cfg.guildId) return '';
    let all = [];
    try { all = (await listGuildChannels(cfg.guildId)) || []; } catch { return ''; }
    const talk = all.filter((c) => Number(c?.type) === 0).slice(0, 8);
    const rows = [];
    for (const c of talk) {
      try {
        const part = ledgerRecent({ chatId: String(c.id), limit: limitPerChat });
        if (Array.isArray(part)) rows.push(...part);
      } catch { /* 单个子频道查不到不影响整篇 */ }
    }
    return rows
      .filter((r) => r && Number.isFinite(Number(r.at)) && String(r.text || '').trim())
      /** 系统事件（入群/撤回之类）不是"聊过的话"，写进日记素材只会让她开始复述通知 */
      .filter((r) => String(r.kind || '') !== 'notice')
      .sort((a, b) => Number(a.at) - Number(b.at))
      .slice(-maxLines)
      .map((r) => `${hhmm(new Date(Number(r.at)))} ${whoOf(r)}：${String(r.text).replace(/\s+/g, ' ').slice(0, 120)}`)
      .join('\n');
  }

  /* ---------------- 生成 ---------------- */

  /**
   * 写一篇「留着的东西」的提示词。
   *
   * **对齐 aurabot 的空间日记**（`dsh-aurabot-qq/src/features/qzone.js:178`），
   * 它原来就是：
   *   `今天你在 QQ 上的聊天片段（「我」是你自己）：…`
   *   `请用你自己的口吻写一条 QQ 空间说说，第一人称，N~M 个字，像真人随手发的动态：`
   *   `可以写今天发生的小事、心情、想吃的白米饭。`
   *
   * 2026-11-17 主人指出：这东西是**代替 QQ 空间**的个人表达。我们上一版把
   * `QQ 上` 写成了`频道里`，等于把场景锁在频道，模型就写成"群里今天聊了啥"。
   * 素材同样是聊天，差别只在措辞——**别替用户定义"这些聊天发生在哪个渠道"**。
   *
   * 和 aurabot 的唯一实质差别：论坛帖必须有标题（没标题官方回 503005），
   * 所以多一段标题 + `---` 的格式要求。
   */
  function buildPrompt(cfg, excerpt) {
    const d = new Date(now());
    return [
      `【写一篇留着的东西】现在是 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hhmm(d)}。`,
      excerpt ? `今天你在 QQ 上的聊天片段（「我」是你自己）：\n${excerpt}` : '今天还没怎么聊天。',
      `请用你自己的口吻写一篇短的，第一人称，${cfg.minChars}~${cfg.maxChars} 个字，像真人随手记下的：可以写今天发生的小事、一点心情、想吃的白米饭。`,
      '这些聊天只是背景，不用总结它们，也不用点明是在哪儿聊的。',
      '输出格式（照这个来，别用 JSON）：第一行只写标题（20 字内、不带日期、不要和正文第一句重复）；',
      '第二行单独写三个减号 ---；从第三行起是正文。',
      '不要分条、不要 Markdown、不要 |||、不要 <voice>/<sticker> 标记、不要加引号，不要解释或前后缀。',
    ].join('\n\n');
  }

  /**
   * 生成一篇草稿，**不发布**。
   *
   * 与 aurabot 的 preview 语义完全一致：不调发布接口、不改历史、不写记忆、
   * 不消耗当天次数。差别只有一处——我们没有 `noTools`：
   * 所以发布动作只由宿主做，`system:channel-post` 会话拿不到任何 QQ 工具
   * （host 侧 `mount()` 对 `kind === 'system'` 不注册）。
   */
  async function preview() {
    const cfg = cfgOfPost();
    const excerpt = await material();
    const prompt = buildPrompt(cfg, excerpt);
    let raw = '';
    try {
      raw = await systemTurn('channel-post', prompt, { windowName: '她的短记' });
    } catch (e) {
      return { ok: false, message: `生成失败：${e?.message || e}` };
    }
    try {
      const draft = parseDraft(raw, { maxChars: cfg.maxChars });
      return { ok: true, preview: true, ...draft, excerptLines: excerpt ? excerpt.split('\n').length : 0 };
    } catch (e) {
      /** 预览是手点的，失败就让人再点一次；技术细节放 `raw` 给排障用，不占提示位 */
      return { ok: false, message: '这次没写出来（模型没按格式输出），再点一次「先看草稿」试试', raw: String(raw || '').slice(0, 400) };
    }
  }

  /* ---------------- 发布 ---------------- */

  /**
   * 真发一篇。
   *
   * 照 aurabot `post()` 的顺序：清洗 → 开关 → 试运行 → **发布前重取配置** → 发。
   * "发布前重取"这条是防"生成过程中改了目标版块/关了开关，还按旧的发出去"。
   *
   * 返回值里 `state` 恒为 `pending`：`putThread` 只代表"已受理"。
   */
  async function publish({ title, text, dryRun } = {}) {
    const cfg = cfgOfPost();
    const clean = cleanDraft(text);
    if (!clean) return { ok: false, message: '正文是空的' };
    const t = cleanDraft(title).slice(0, 20) || pickTitle(clean, now());
    /**
     * **总开关**（2026-11-18）。注意判的是顶层 `cfgOf()?.enabled`，不是上面的
     * `cfg.enabled`——`cfg` 是 `cfgOfPost()` 裁出来的 channelPost 子树，
     * 它的 `enabled` 是「允许发帖」，同名不同层，写混就等于没判。
     *
     * 为什么这里必须单独判：短记发帖走 `callQq('putThread')` 的 HTTP，
     * **连 `channel.send` 都不经过**，是全仓唯一完全绕开出站口的外发路径。
     */
    if (pausedOf()) return { ok: false, message: '现在不能发：总开关关着，或者刚断线还没恢复' };
    if (!cfg.enabled) return { ok: false, message: '「允许发帖」的总开关还关着' };
    if (!cfg.channelId) return { ok: false, message: '还没选发帖版块' };

    /**
     * 两种试运行取并集：短记自己的 `channelPost.dryRun`（面板上那个），
     * 和全局的「试运行」。后者不 OR 进来就是「全局试运行开着、短记照样真发」。
     */
    const isDry = (dryRun === undefined ? cfg.dryRun : Boolean(dryRun)) || dryRunOf() === true;
    if (isDry) {
      log(`试运行：本来要发《${t}》到版块 ${cfg.channelId}`);
      return { ok: true, dryRun: true, title: t, text: clean, state: 'dry' };
    }

    const latest = cfgOfPost();
    /** 生成期间被关掉也一样不发：这里补的第二道闸，`enabled` 与总开关都判 */
    if (pausedOf() || !latest.enabled || !latest.channelId) return { ok: false, message: '发布前开关已变化，本次未发布' };

    const at = now();
    try {
      const r = await callQq('putThread', [latest.channelId, { title: t, content: clean, format: latest.format }]);
      const taskId = String(r?.task_id ?? '');
      patchCfg({ channelPost: { verifiedAt: at } });
      return { ok: true, title: t, text: clean, taskId, createTime: String(r?.create_time ?? ''), state: 'pending' };
    } catch (e) {
      const h = humanError(pickErrorCode(e), e?.message);
      /**
       * `network` 必须传出来：`tick()` 靠它区分「今天这篇废了」和「网断了，
       * 下一轮接着发」。不传的话断线一天会把三档全部烧成失败。
       */
      return {
        ok: false, message: h.title, todo: h.todo, say: h.say, code: h.code,
        network: e?.code === 'NETWORK', raw: String(e?.message || e),
      };
    }
  }

  /** 写一条历史。发布与草稿共用，`state` 区分。 */
  function remember(entry) {
    const s = store.read();
    s.history.unshift({ at: now(), ...entry });
    store.save(s);
    return s;
  }

  /**
   * 记一条**待发**草稿（不发布）。
   *
   * 这是 `askFirst` 的落地方式：她在对话里写好一篇，只落一条 `draft`，
   * 面板上出现「《标题》 发 / 不发」，人点了才真发。
   *
   * 为什么不做"对话里多轮确认"：那要维护一个跨轮状态机（谁在等、等多久、
   * 超时怎么办），而面板本来就是宿主唯一有"显式操作"语义的地方。
   * 同一套代码在 `askFirst` 关掉时只是跳过这一步，不是第二条流程。
   */
  function addDraft({ title, text, source = 'tool' } = {}) {
    const cfg = cfgOfPost();
    const clean = cleanDraft(text);
    if (!clean) return { ok: false, message: '正文是空的' };
    remember({
      title: cleanDraft(title).slice(0, 20) || pickTitle(clean, now()),
      text: clean,
      state: 'draft',
      taskId: '',
      dryRun: false,
      error: '',
      channelId: cfg.channelId,
      source,
    });
    return { ok: true, title: cleanDraft(title).slice(0, 20) || pickTitle(clean, now()) };
  }

  /**
   * 发一篇**已经写好的**草稿，并记账。
   *
   * 抽出来是因为有两个入口：定时/手动生成（`write`）、以及面板上"预览过、
   * 确认要发"的那一篇（路由直接把 title/text 递进来）。两个入口必须走同一段
   * 记账逻辑，否则面板发出去的那篇不会出现在历史里，也就永远对不上账。
   *
   * @param {object} o
   * @param {string} o.title
   * @param {string} o.text
   * @param {boolean} [o.force]   只忽略**短记自己的** `channelPost.dryRun`；
   *   全局「试运行」仍由 `publish()` 里的 `dryRunOf()` 判，传 `force` 也穿不过去
   * @param {string} [o.source]   `auto`（定时/手动生成）/ `panel`（预览后确认）
   */
  async function sendDraft({ title, text, force = false, source = 'panel' } = {}) {
    const cfg = cfgOfPost();
    if (!cfg.channelId) return { ok: false, message: '还没选发帖版块' };
    const r = await publish({ title, text, dryRun: force ? false : undefined });
    // 试运行也记一笔：面板要显示"本来要发什么"，否则试运行等于什么都没发生
    remember({
      title: r.title || cleanDraft(title),
      text: r.text || cleanDraft(text),
      state: r.ok ? r.state || 'pending' : 'failed',
      taskId: r.taskId || '',
      dryRun: Boolean(r.dryRun),
      error: r.ok ? '' : String(r.message || ''),
      code: r.code || '',
      channelId: cfg.channelId,
      source,
    });
    // 记忆回流：只有真的发出去了（不是试运行）才记，否则她会"记得自己写过"但其实没人看见
    if (r.ok && !r.dryRun) {
      try {
        journalAdd({
          chatId: cfg.guildId ? `guild:${cfg.guildId}` : '',
          role: 'bot',
          level: 'normal',
          text: `我在频道里写过一篇《${r.title}》：${r.text}`,
        });
      } catch (e) { log(`频道日记写记忆失败：${e.message}`); }
    }
    return r;
  }

  /**
   * 写一篇（生成 + 发布 + 记账）。手动点"现在写一篇"和定时 tick 都走这里。
   *
   * @param {object} o
   * @param {boolean} [o.preview]  只要草稿
   * @param {boolean} [o.force]    只忽略短记自己的 dryRun（面板上"真发"按钮）
   */
  async function write({ preview: wantPreview = false, force = false } = {}) {
    /**
     * 上一次还在写就**不算失败**：`code:'BUSY'` 让 `tick()` 直接跳过，
     * 不写重试记录、不占重试档位。以前它和真失败一样被记成「发帖失败，
     * 2 分钟后再试（上一篇还在写）」，日志会误导排障。
     */
    if (busy) return { ok: false, code: 'BUSY', message: '上一篇还在写' };
    busy = true;
    try {
      const cfg = cfgOfPost();
      if (!cfg.channelId) return { ok: false, message: '还没选发帖版块' };

      const excerpt = await material();
      const prompt = buildPrompt(cfg, excerpt);
      let raw = '';
      try {
        raw = await systemTurn('channel-post', prompt, { windowName: '她的短记' });
      } catch (e) {
        /**
         * 生成失败也要记账。定时的这一篇失败时**没人在场**，
         * 不记账的话面板 00 卡不会亮、用户只会觉得"今天怎么没写"。
         * 预览（`preview()`）失败不记——那不是一次发布尝试，记了会污染历史。
         */
        const message = `生成失败：${e?.message || e}`;
        remember({ title: '', text: '', state: 'failed', error: message, channelId: cfg.channelId, source: 'auto' });
        return { ok: false, message };
      }

      let draft;
      try {
        draft = parseDraft(raw, { maxChars: cfg.maxChars, at: now() });
      } catch (e) {
        /**
         * **再要一次**，这一次把格式要求说得更硬。
         *
         * 模型偶发在 JSON 前后加一句"好的，我写一篇…"，旧版直接判死，
         * 用户看到「日记草稿不是合法 JSON」——他改不了模型输出，这句提示对他无用。
         * 只重试一次：第二次还不行说明是这个模型的问题，继续重试只是烧钱。
         */
        try {
          raw = await systemTurn(
            'channel-post',
            `${prompt}\n\n【上一次的输出不能用，已经作废。这一次请严格按格式：第一行标题，第二行单独写 ---，之后是正文。不要 JSON，不要任何解释。】`,
            { windowName: '她的短记' },
          );
          draft = parseDraft(raw, { maxChars: cfg.maxChars, at: now() });
        } catch (e2) {
          const message = '这篇没写出来：模型这次没按格式输出，自动重试一次也没成。可以再点一次「现在发一篇」，或者换一个更听话的模型';
          /**
           * 原文必须留痕。只有一句"格式不对"谁都定位不了——
           * 是模型没给正文？还是被截断了？还是给了半截 JSON？
           */
          const rawTail = String(raw || '').slice(0, 300);
          log(`频道日记解析失败（已重试）：${e2.message}｜原文：${rawTail}`);
          remember({ title: '', text: '', state: 'failed', error: message, raw: rawTail, channelId: cfg.channelId, source: 'auto' });
          return { ok: false, message, raw: rawTail };
        }
      }
      if (wantPreview) return { ok: true, preview: true, ...draft };

      const r = await sendDraft({ title: draft.title, text: draft.text, force, source: 'auto' });
      return { ...r, ...draft, text: r.text || draft.text };
    } finally {
      busy = false;
    }
  }

  /* ---------------- 对账 ---------------- */

  /**
   * 拉一次帖子列表，把 `pending` 认领成 `live`。
   *
   * 两条硬限制（官方接口决定，不是偷懒）：
   *   · `GET /threads` **没有分页参数**，只能拿到"最近这一批"→ 不做删除对账；
   *   · `thread_info.content` 返回的是 RichText JSON，不是原文 → 只能按
   *     `title + date_time` 最近邻认领（标题可能重复，所以再加 10 分钟时间窗）。
   *
   * 认领不到也不判失败：30 分钟后转 `stale`，含义是"这批里没看到"。
   */
  async function sync() {
    const cfg = cfgOfPost();
    if (!cfg.channelId) return { ok: false, message: '还没选发帖版块' };
    let list;
    try {
      list = await callQq('getThreadsList', [cfg.channelId]);
    } catch (e) {
      return { ok: false, warning: `拉帖子列表失败：${e?.message || e}` };
    }
    const threads = Array.isArray(list?.threads) ? list.threads : Array.isArray(list) ? list : null;
    // 照 aurabot 的第一条守则：格式不完整一律不动数据
    if (!threads) return { ok: false, warning: '帖子列表格式不完整，保留原记录' };

    const s = store.read();
    let changed = 0;
    for (const row of s.history) {
      if (!row || row.state !== 'pending') continue;
      const hit = threads.find((t) => {
        const info = t?.thread_info || {};
        if (String(info.title || '').trim() !== String(row.title || '').trim()) return false;
        const at = Date.parse(String(info.date_time || ''));
        return Number.isFinite(at) && Math.abs(at - Number(row.at || 0)) < 10 * 60_000;
      });
      if (hit) {
        row.state = 'live';
        row.threadId = String(hit.thread_info?.thread_id || '');
        row.liveAt = now();
        changed++;
      } else if (now() - Number(row.at || 0) > 30 * 60_000) {
        row.state = 'stale';
        changed++;
      }
    }
    if (changed) store.save(s);
    return { ok: true, changed, live: s.history.filter((r) => r.state === 'live').length, pending: s.history.filter((r) => r.state === 'pending').length };
  }

  /* ---------------- 定时 ---------------- */

  /** 失败重试节奏：与 aurabot 完全一致（2 / 5 / 15 分钟，第 4 次放弃） */
  const RETRY_DELAY_MIN = [2, 5, 15];

  /**
   * 每分钟调一次。到期就写一篇；失败按 2/5/15 分钟重试。
   *
   * 与 aurabot `tick()` 的差别只有两处：
   *   · 多判一个 `channelId`（没选版块就不排期，否则每篇都白生成）；
   *   · 没有 onebot 连接状态判断（频道走官方接口，断线时 `qq.call` 自己会报错并进重试）。
   */
  async function tick() {
    const cfg = cfgOfPost();
    if (!cfg.enabled || !cfg.channelId || cfg.timesPerDay === 0) return;
    const s = store.read();
    const today = dayKey(new Date(now()));
    if (s.plan.day !== today) {
      s.plan = { day: today, times: planDiaryTimes(cfg), done: [], retry: {} };
      store.save(s);
      log(`今天的发帖时间：${s.plan.times.map(asHHMM).join('、') || '（不写）'}`);
    }
    const d = new Date(now());
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const due = s.plan.times.find((m) => m <= nowMin && !s.plan.done.includes(m));
    if (due === undefined) return;
    /**
     * 每日上限是**总量**，不是"排期额度"。
     *
     * `timesPerDay` 说好是"每天最多几篇"，而她自己在对话里发的（§9 的
     * `qq_post_thread`）也占这个数。不在这里判，最坏情况是：排期 2 篇
     * + 她自己发 2 篇 = 一天 4 篇，用户设的"2"形同虚设。
     * 已经发满就把这一档直接标 done，不再补，也不排重试。
     */
    if (dayCount(s.history) >= cfg.timesPerDay) {
      s.plan.done.push(due);
      store.save(s);
      log(`今天已经发满 ${cfg.timesPerDay} 篇，这一档跳过`);
      return;
    }
    const retry = s.plan.retry && s.plan.retry[due];
    if (retry && retry.at > now()) return;

    log(retry ? `发帖没成功，再试一次（第 ${retry.count + 1} 次）` : '到点了，往频道发一篇');
    const r = await write();
    const s2 = store.read();
    if (r && (r.ok || r.preview)) {
      s2.plan.done.push(due);
      if (s2.plan.retry) delete s2.plan.retry[due];
      store.save(s2);
      return;
    }
    const count = ((retry && retry.count) || 0) + 1;
    /**
     * 断线：**不占重试档位、不标 done**（2026-11-18）。
     *
     * 以前 `NETWORK` 和业务失败一样处理，每档 2/5/15 分钟重试、每次都重新
     * 生成一遍正文，然后当天这篇放弃——断线一天＝三档全丢，还白烧 12 次模型。
     * 现在直接留在待发：定时器本身有断线冷却（`paused()`）挡着，不会每分钟空转。
     */
    if (r && r.network) {
      log('发帖时连不上，这一档留着下一轮再发');
      return;
    }
    /** 上一篇还没写完：不是失败，别写重试记录、别计次 */
    if (r && r.code === 'BUSY') {
      log('上一篇还没写完，这一档下一轮再看');
      return;
    }
    const delayMin = RETRY_DELAY_MIN[count - 1];
    if (!delayMin) {
      s2.plan.done.push(due);
      if (s2.plan.retry) delete s2.plan.retry[due];
      store.save(s2);
      log(`发帖连续失败 ${count} 次，今天这一篇先跳过`);
      return;
    }
    s2.plan.retry = { ...(s2.plan.retry || {}), [due]: { at: now() + delayMin * 60_000, count } };
    store.save(s2);
    log(`发帖失败，${delayMin} 分钟后再试（${(r && r.message) || '未知错误'}）`);
  }

  /** 下一次发帖时刻 `HH:MM`（面板显示用；空串 = 今天没有了） */
  function nextTime() {
    const s = store.read();
    const d = new Date(now());
    const nowMin = d.getHours() * 60 + d.getMinutes();
    const m = s.plan.day === dayKey(d)
      ? s.plan.times.find((x) => !s.plan.done.includes(x) && x >= nowMin)
      : undefined;
    return m === undefined ? '' : asHHMM(m);
  }

  /* ---------------- 体检 ---------------- */

  /**
   * 串一次只读探测，给面板的体检条用。
   *
   * 权限判据**刻意不用 `getGuildApiPermission`**：那个接口自己就需要权限，
   * 查它会制造第二层失败。直接"能不能读帖子列表"一步到位，而且不会骗人。
   */
  async function diagnose() {
    const cfg = cfgOfPost();
    const probe = { guildEnabled: false, inGuild: null, forumChannels: null, perm: null, permError: null };

    probe.guildEnabled = Boolean(cfgOf()?.guild?.enabled);
    if (!cfg.guildId) {
      /** 还没选频道。**不要**报成"机器人不在频道里"——那是另一件事。 */
      probe.inGuild = null;
    } else {
      try {
        const all = await listGuildChannels(cfg.guildId, { fresh: true });
        probe.inGuild = Array.isArray(all) && all.length > 0;
        probe.forumChannels = (all || [])
          .filter((c) => Number(c?.type) === 10007)
          .map((c) => ({ id: String(c.id || ''), name: String(c.name || '') }));
      } catch (e) {
        const code = pickErrorCode(e);
        /**
         * 读不到列表**不等于**机器人不在频道里：可能是没权限（11253/11264）、
         * 没连上网关（304018），也可能只是网络抖动。一律保持"未知"，
         * 只有认出是已知业务码时才判"权限不过"。
         */
        probe.inGuild = null;
        if (ERROR_HINTS[code]) probe.perm = false;
        probe.permError = { code, message: String(e?.message || e) };
      }
    }

    if (cfg.channelId) {
      try {
        await callQq('getThreadsList', [cfg.channelId]);
        probe.perm = true;
      } catch (e) {
        probe.perm = false;
        probe.permError = { code: pickErrorCode(e), message: String(e?.message || e) };
      }
    }

    const steps = postSteps(cfg, probe);
    return { ok: true, ...steps, forumChannels: probe.forumChannels, permError: probe.permError };
  }

  return {
    /** 面板一把回：配置 + 今日已发 + 下次时间 + 历史 + 最近一次失败 */
    state: () => {
      const cfg = cfgOfPost();
      const s = store.read();
      /**
       * 最近一次失败。
       *
       * 定时发帖失败时**没人在场**，模型也不可能来提醒（那一轮没有会话）——
       * 面板是唯一的出口。所以这里把"最近一条 failed，且比最近一条成功更晚"
       * 单独拎出来，00 卡据此亮红并给出下一步；老失败不会被一直亮着。
       */
      const bad = s.history.find((r) => r && r.state === 'failed');
      const good = s.history.find((r) => r && (r.state === 'live' || r.state === 'pending'));
      const lastError = bad && (!good || Number(bad.at) > Number(good.at))
        ? { at: Number(bad.at) || 0, message: String(bad.error || bad.message || ''), code: String(bad.code || '') }
        : null;
      return {
        cfg,
        today: dayCount(s.history),
        next: nextTime(),
        /**
         * 只回**今天**的排期。
         *
         * 跨零点后 `plan` 里还是昨天那张表 —— 直接回给面板，界面会显示
         * 「今天的排期：昨天那些时刻」，用户以为今天已经排过了。真正的
         * 重排发生在下一次 `tick()`，这之前面板应该显示空。
         */
        plan: s.plan.day === dayKey(new Date(now())) ? s.plan : { day: dayKey(new Date(now())), times: [], done: [], retry: {} },
        lastError,
        history: s.history.slice(0, 50),
      };
    },
    tick, write, preview, publish, sendDraft, sync, diagnose, addDraft,
    listGuilds, listSubChannels, createForumChannel,
    nextTime,
    history: () => store.read().history,
  };
}
