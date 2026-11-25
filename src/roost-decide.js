/**
 * 接话策略：这条群消息要不要理。
 * ============================
 *
 * 走 ai-chat 时这一层是它做的（`decide.js` 的 `shouldConsider`）。直连之后
 * 框架会把**每条群消息**都推过来，没有这层就等于：
 *
 *   · 群里每句话都触发一轮模型调用（费用直接爆）
 *   · 别人发个 `!/roll` 也被接走，插件之间抢活
 *   · 刚回完一句，下一句又立刻回，看起来像刷屏
 *
 * 所以规则逐条搬过来，行为对齐，只在两处刻意不搬：
 *   · **relevance 模式**（关键词相关度打分）——它省的是模型调用，不是能力；
 *     要搬得连词表一起搬，收益不抵复杂度。
 *   · 框架的「免 @ 窗口」（`sticky`）——那个是 `mentioned || isCommand || sticky`
 *     的合并布尔，认它就等于「@ 过一次之后句句都接」，用户设的「只在被 @ 时」
 *     形同虚设（ai-chat 线上真实反馈过）。
 *
 * 判定顺序（和 ai-chat 一致，**顺序本身是语义**）：
 *   私聊 → 被 @ → 空消息 → 忽略词 → 模式收敛 → 免@窗口 → 冷却 → 每分钟配额 → 刹车策略 → 插话概率
 *
 * 2.2b 加的两层：**按群覆写**（`group.overrides[chatId]`，在入口把全局
 * 判据换掉）和**插话概率**（`group.interruptChance`，最后一道，只管「群里
 * 没人叫她的普通一句」）。两者默认都不生效，升级前后行为完全一致。
 */

/**
 * 总开关的判据**复用** `features.js` 的 `isOff`——那份认布尔 `false`，
 * 也认手改成字符串的 `"false"`。在这里再写一遍 `=== false` 就会漏后者：
 * 面板显示关着、实际还在接话。`features.js` 本身零 import，不循环。
 */
import { isOff } from './features.js';

/** 默认忽略词：别的插件靠这些前缀干活，别抢 */
export const DEFAULT_IGNORE = ['/'];

/**
 * 按群覆写允许改的键。
 *
 * 白名单而不是整份 spread：overrides 是用户手填的开放字典，把整个对象
 * 铺进判据等于让一个错键（比如 `__proto__` 或者拼错的 `maxPerHr`）悄悄
 * 影响她接不接话，而且面板上完全看不出来。只认这张表里的键。
 */
export const OVERRIDE_KEYS = Object.freeze([
  'mode', 'engagedMaxTurns', 'windowMin', 'cooldownSec', 'maxRepliesPerMin',
  'maxPerHour', 'burstMax', 'quietStartHour', 'quietEndHour',
  /** 对外静默窗口（这段内只有主人叫得醒）——单群可单独设或关掉 */
  'guestQuietFrom', 'guestQuietTo',
  'shortAskMustReply', 'silent', 'ignoreWords',
  /** group 层自己的键也允许按群覆写 */
  'interruptChance',
  /** 话题与群活跃度（逐群可单独设） */
  'interests', 'minRelevance', 'minRecentMessages', 'activeWindowSec', 'burstWindowSec',
]);

/** 群响应模式：只决定「这个群让不让她说话」，不碰「说话时怎么判断该不该接」 */
export const GROUP_RESPONSE_MODES = Object.freeze(['chat', 'observe', 'off']);

/** 话题与群活跃度：全局值放在 `group` 段，可按群覆写（不走 roostHost.decide） */
const TOPIC_KEYS = Object.freeze(['interests', 'minRelevance', 'minRecentMessages', 'activeWindowSec']);

/**
 * 最近这段群聊和她感兴趣的话题有多相关（0–1）。
 *
 * 只做**子串命中**：命中的词数 × 0.3，封顶 1。不做分词、不做向量——
 * 这条路要的是「便宜且可解释」（决策链里能写出为什么），不是语义相似度。
 * 词表为空返回 0，调用方靠「词表空就不启用门槛」来兜底。
 *
 * @param {string[]} recentTexts 最近若干条群消息正文
 * @param {string[]} interests 感兴趣的话题词
 */
export function topicRelevance(recentTexts, interests) {
  const words = (Array.isArray(interests) ? interests : []).filter((w) => w && String(w).trim());
  if (!words.length) return 0;
  const text = (Array.isArray(recentTexts) ? recentTexts : []).join(' ').toLowerCase();
  let hits = 0;
  for (const w of words) {
    if (text.includes(String(w).trim().toLowerCase())) hits += 1;
  }
  return Math.min(1, hits * 0.3);
}

/**
 * 某个群当前响应模式。缺省 / 配坏一律 `chat`——升级前所有群都能接话，
 * 不能因为新增字段把老群弄哑。
 */
export function responseModeOf(cfg, chatId = '') {
  const group = cfg?.group ?? {};
  const id = String(chatId ?? '');
  const modes = group.responseModes;
  if (id && modes && typeof modes === 'object' && !Array.isArray(modes)) {
    const mode = modes[id];
    if (GROUP_RESPONSE_MODES.includes(mode)) return mode;
  }
  return GROUP_RESPONSE_MODES.includes(group.responseDefault) ? group.responseDefault : 'chat';
}

/**
 * 不回应的人：按 openid 匹配，群范围可选「全部群 / 指定群」。
 *
 * 为什么不按 QQ 号：官方事件只给 openid；`uin` 是管理员在「身份」页
 * 手动绑定后才有的反查值，不能拿它当默认键。主人永远豁免——主人被误加进
 * 名单会让「她怎么不理我」变成最难查的一类问题。
 */
export function memberFiltered(cfg, chatId, sender, ownerIds = []) {
  const filter = cfg?.group?.memberFilter;
  if (!filter || filter.enabled !== true) return false;
  const id = String(chatId ?? '');
  const openid = String(sender?.openid ?? sender?.id ?? '').trim();
  if (!id || !openid) return false;
  const owners = (Array.isArray(ownerIds) ? ownerIds : [ownerIds])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  if (owners.includes(openid)) return false;
  const rules = Array.isArray(filter.rules) ? filter.rules : [];
  return rules.some((rule) => rule?.openid === openid
    && (rule.scope === 'all'
      || (rule.scope === 'groups' && Array.isArray(rule.groups) && rule.groups.includes(id))));
}

/** 概率夹紧到 0–100；没配 / 配坏了都当 100（= 不拦，保持原行为） */
function chanceOf(v) {  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

/**
 * 解析某个会话真正生效的接话配置。
 *
 * 导出给单测和面板共用：同一份「谁覆盖谁」的逻辑只写一遍，别在三个地方
 * 各推一次。优先级：`group.overrides[chatId]` > `roostHost.decide` 全局。
 * `interruptChance` 单独走 group 层（decide 里没有这个键）。
 *
 * @returns {{decide:object, chance:number, overridden:boolean}}
 */
export function resolveGroupPolicy(cfg, chatId = '') {
  const decide = { ...(cfg?.roostHost?.decide ?? {}) };
  const group = cfg?.group ?? {};
  const raw = group.overrides?.[chatId];
  const ov = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (const k of OVERRIDE_KEYS) {
    if (k === 'interruptChance' || ov[k] === undefined) continue;
    decide[k] = ov[k];
  }
  /**
   * 话题与群活跃度的全局值在 `group` 段（和 `interruptChance` 同一套路），
   * 不在 `roostHost.decide` 里。单群覆写了就用覆写的，没覆写才落回全局。
   */
  for (const k of TOPIC_KEYS) {
    if (ov[k] !== undefined) continue;
    if (group[k] !== undefined) decide[k] = group[k];
  }
  const chance = chanceOf(ov.interruptChance === undefined
    ? group.interruptChance : ov.interruptChance);
  return { decide, chance, overridden: Object.keys(ov).length > 0 };
}

/** 短问：明确在叫人，刹车不该拦它 */
export function isShortAsk(text, on = false) {
  if (!on) return false;
  const t = String(text ?? '').trim();
  if (!t || [...t].length > 12) return false;
  if (/^[?？!！]{1,3}$/.test(t)) return true;
  /** 去掉句尾语气标点后**整串**匹配：只写 `$` 会把「今天好热在吗」也算成叫人 */
  const core = t.replace(/[?？!！。.、,，~～\s]+$/g, '');
  return /^(在吗|在不在|人呢|还在吗|喂|醒醒|出来)$/i.test(core);
}

/** 静默时段：起止相同表示关闭。跨零点（22→7）也要对 */
export function inQuietHours(p, hour = new Date().getHours()) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const a = Number(p?.quietStartHour) || 0;
  const b = Number(p?.quietEndHour) || 0;
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * 对外静默窗口是否生效：`[from, to)`，`HH:mm`，支持跨夜。
 *
 * 与 `quietStartHour/quietEndHour` **正交**：那个管「她别插话」（对主人），
 * 这个管「别人别叫醒她」。所以两套并存，不合并——合成一个键之后，
 * 「深夜别插嘴但主人喊我还在」这种最常见的配置就表达不出来了。
 *
 * 为什么用分钟比较而不是整点：`01:30–08:00` 这种半小时边界必须精确生效。
 * 解析不出来 / 起止相同，一律当「没设」（fail-open，宁可多回一句）。
 */
export function guestQuietActive(ts, from, to) {
  const parse = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const a = parse(from);
  const b = parse(to);
  if (a === null || b === null || a === b) return false;
  const d = new Date(Number(ts) || Date.now());
  const cur = d.getHours() * 60 + d.getMinutes();
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/**
 * 这条消息要不要因为「对外静默」被拦下（不起轮次）。
 *
 * **为什么不在 `judge()` 里判**：那里是同步路径，拿不到 `bucket`——框架的
 * message 事件只带 `sender.openid`，档位要 `roles.resolve` 异步查。
 * 硬在 judge 里判就只剩两条路：要么一律当成「不是主人」（**把主人也关在门外**），
 * 要么 fail-open 放行（窗口对谁都失效）。两条都不能要。
 *
 * 所以判定放在宿主拿到 `payload` 之后：那里 `sender.bucket` 已经是
 * `roles.resolve` 的结果，判定同步、精确，而且仍在**起轮之前**。
 *
 * @param {number} now
 * @param {{guestQuietFrom?:string, guestQuietTo?:string}} decide 该群生效的接话配置
 * @param {string} bucket `owner` / `admin` / `member` / …
 * @param {string} kind 框架四态（`c2c`/`dm` 是一对一）
 */
export function guestQuietSkip(now, decide, bucket, kind = 'group') {
  /**
   * **只管群**。一对一里不存在「别人叫醒她」——那是用户专门点开来跟自己说话，
   * 深夜私聊自己的机器人却被拦一句，属于明显的坏体验。
   */
  if (kind === 'c2c' || kind === 'dm') return { skip: false, reason: '' }
  const from = decide?.guestQuietFrom;
  const to = decide?.guestQuietTo;
  if (!guestQuietActive(now, from, to)) return { skip: false, reason: '' }
  if (bucket === 'owner') return { skip: false, reason: '' }
  return { skip: true, reason: `对外静默（${from}–${to}），只有主人叫得醒她` }
}

/** 这条消息的正文。纯语音要走 asrText（content 是空串） */
/**
 * 这条消息「说了什么」：正文优先，没有正文就取附件里的语音转写。
 *
 * 导出给 `roost-observe.js` 共用：旁听写日记的正文和判定用的正文必须是
 * 同一份，否则「判定说有内容、日记写空」——纯语音消息会被悄悄漏记。
 */
export function saidOf(evt) {
  const said = String(evt?.content ?? '').trim();
  if (said) return said;
  /** `?? []` 挡不住「attachments 是对象」——非数组直接 `.map` 会抛，判定这条路不能炸 */
  const atts = Array.isArray(evt?.attachments) ? evt.attachments : [];
  return atts.map((a) => String(a?.asrText ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * @param {object} o
 * @param {() => object} o.cfg 现读配置（`roostHost.decide` + `group`）
 * @param {() => number} [o.now]
 * @param {() => number} [o.random] 0–1 的随机数，注入给单测用
 */
export function createDecider({
  cfg,
  now = () => Date.now(),
  random = Math.random,
  /** 主人 openid（含 ownerAliases）——不回应名单的豁免用；不传就只按配置豁免不了 */
  ownerIds = () => [],
} = {}) {
  /** chatId → 每会话运行时状态 */
  const state = new Map();
  /**
   * 最近判定（决策链可视化，2.2b）。只存结构化数据，时间格式化交给面板。
   * 环形上限 40 条：这是给人看的排障记录，不是账本，不该无限长。
   */
  const recent = [];

  /** 现读 + 按群覆写：面板改了覆写，下一句就生效，不用重启 */
  const conf = (chatId) => resolveGroupPolicy(cfg(), chatId);

  function stOf(chatId) {
    let s = state.get(chatId);
    if (!s) {
      s = {
        windowUntil: 0,
        lastReplyAt: 0,
        replyTimes: [],
        policyTimes: [],
        engagedAt: 0,
        engagedCount: 0,
        /**
         * 最近入站群消息（时间戳 / 截断正文），只给「群冷清」和「话题相关度」用。
         * 只存内存、不落盘：重启后为空，冷清闸按「不知道就放行」处理。
         */
        msgTimes: [],
        msgTexts: [],
        /** 这个群第一条被记录的消息时间：观察窗口没走满之前不下「冷清」结论 */
        msgFirstAt: 0,
      };
      state.set(chatId, s);
    }
    return s;
  }

  /**
   * 记一条入站群消息，供「群冷清」和「话题相关度」判据使用。
   *
   * **在判定之前记**：当前这条也算「群里在聊」的一条，否则群里刚好第 3 条
   * 触发门槛时会永远差一条。只记有正文的群消息——纯图/纯表情不算话题，
   * 也不该把冷清计数灌满。
   */
  function noteInbound(evt) {
    const chatId = String(evt?.chat?.chatId ?? '');
    const k = evt?.chat?.kind;
    if (!chatId || k === 'c2c' || k === 'dm') return;
    const text = saidOf(evt).slice(0, 80);
    if (!text) return;
    const s = stOf(chatId);
    const t = now();
    if (!s.msgFirstAt) s.msgFirstAt = t;
    s.msgTimes.push(t);
    s.msgTexts.push(text);
    if (s.msgTimes.length > 200) s.msgTimes = s.msgTimes.slice(-200);
    if (s.msgTexts.length > 40) s.msgTexts = s.msgTexts.slice(-40);
  }

  /**
   * 真正的判定收在 `impl.judge` 里，外面再包一层 `check` 只为记
   * 「这条为什么回 / 不回」——这里有二十多个 return，挨个插日志必漏一处。
   *
   * **只拦 `message` 事件**。`onNotice` 那条路上的框架事件
   * （`capabilities.changed` / `ext.call.request` / 审核结果通知 / 按钮回调）
   * 不受总开关影响：那些是宿主内部的通知与对账，不是她说话；拦了会让待确认
   * 的提案卡死、能力表停止刷新。以后别把这条当漏洞「补」上。
   *
   * @param {object} evt roost 的 message 事件 data
   * @returns {{go:boolean, force?:boolean, cooling?:boolean, delayMs?:number, reason:string}}
   */
  const impl = {
    judge(evt) {
      /**
       * 总开关排第一：关着时**连判定都不做**——不占配额、不动冷却状态、
       * 不给 runtime 记一笔「刚回过」。私聊也在这里被挡住（下面那条
       * 「私聊一律理」在它后面）。
       */
      if (isOff(cfg()?.enabled)) return { go: false, reason: '总开关关着' };

      const chatId = String(evt?.chat?.chatId ?? '');
      /** 按群覆写在这里生效；chance 是这一层的插话概率 */
      const { decide: c, chance } = conf(chatId);
      /** 四态投影：频道私信（dm）和普通单聊一样是「专门点开来跟你说话」 */
      const k = evt?.chat?.kind;
      const kind = (k === 'c2c' || k === 'dm') ? 'c2c' : 'group';

      /**
       * 不回应名单排在最前：被屏蔽的人 @、引用、喊名字都不该起一轮。
       * 主人豁免在 memberFiltered 里做；私聊完全不参与。
       */
      if (kind === 'group' && memberFiltered(cfg(), chatId, evt?.sender, ownerIds())) {
        return { go: false, reason: '不回应名单' };
      }

      /**
       * 群响应模式：off 不接也不旁听；observe 只旁听（由宿主写日记）。
       * `chat` 继续往下走原有策略，一行行为都不改。
       */
      if (kind === 'group') {
        const mode = responseModeOf(cfg(), chatId);
        if (mode === 'off') return { go: false, reason: '这个群设为不接话' };
        if (mode === 'observe') return { go: false, reason: '这个群只旁听', observe: true };
      }

      const s = stOf(chatId);
      const t = now();

      /** 私聊一律理：用户专门点开来跟你说话，没有「打扰」的问题 */
      if (kind === 'c2c') return { go: true, force: true, reason: '私聊' };

      const winMs = Math.max(1, Number(c.windowMin) || 3) * 60_000;
      /**
       * 真 @ 了：任何模式都直接接，`window` 模式顺手续窗。
       * **窗口只由真 @ 打开，不由命令打开**——否则发一条 `/roll` 也能让她
       * 接下来三分钟句句接话。
       */
      if (evt?.mentioned) {
        if (c.mode === 'window') s.windowUntil = t + winMs;
        return { go: true, force: true, reason: '被 @' };
      }

      const text = saidOf(evt);
      const atts = Array.isArray(evt?.attachments) ? evt.attachments : [];
      /** 纯图片 / 纯语音：文本空但附件有东西，不能算空消息 */
      if (!text && !atts.length) return { go: false, reason: '空消息' };

      const ignore = Array.isArray(c.ignoreWords) ? c.ignoreWords : DEFAULT_IGNORE;
      for (const w of ignore) {
        if (w && text.startsWith(w)) return { go: false, reason: `以「${w}」开头，像是别的插件的指令` };
      }

      if (c.mode === 'mention') return { go: false, reason: '当前是「只在被 @ 时回复」模式' };
      if (c.mode === 'window') {
        if (s.windowUntil && t < s.windowUntil) return { go: true, reason: '在 @ 之后的窗口内' };
        return { go: false, reason: '不在 @ 之后的窗口内' };
      }

      /** `ai` 模式：框架的「免@窗口 / 命令」仍算在叫她 */
      if (evt?.addressed) return { go: true, force: true, reason: '在免@窗口内 / 命令' };

      /**
       * 冷却：刚回过就别急着再回。
       *
       * **不丢消息**——冷却期内说的话要攒着，等冷却结束一起交出去。
       * 以前这里直接不接，用户在这 20 秒里说的三句全凭空消失，体感极差。
       */
      const cooldownSec = Number(c.cooldownSec) || 0;
      if (cooldownSec > 0 && s.lastReplyAt && t - s.lastReplyAt < cooldownSec * 1000) {
        const left = cooldownSec * 1000 - (t - s.lastReplyAt);
        return {
          go: true,
          cooling: true,
          delayMs: Math.max(0, left),
          reason: `冷却中（还剩 ${Math.ceil(left / 1000)} 秒，攒着）`,
        };
      }

      /** 每分钟配额：群里聊得热火朝天时别跟着狂刷 */
      const perMin = Number(c.maxRepliesPerMin) || 0;
      if (perMin > 0) {
        s.replyTimes = s.replyTimes.filter((x) => t - x < 60_000);
        if (s.replyTimes.length >= perMin) {
          return { go: false, reason: `每分钟最多 ${perMin} 条，已经用满` };
        }
      }

      /** ---- 刹车策略 ---- */
      /**
       * 插话概率也算「策略开着」：不加这一项，`chance < 100` 时会在下面
       * 提前 return「交给模型判断」，概率永远轮不到判（面板上改了没反应）。
       */
      const minRecent = Math.max(0, Math.round(Number(c.minRecentMessages) || 0))
      const topicWords = Array.isArray(c.interests)
        ? c.interests.filter((w) => w && String(w).trim()) : []
      const minRel = Math.min(1, Math.max(0, Number(c.minRelevance) || 0))
      /** 话题闸只有在「门槛 > 0 且词表非空」时才启用：只调门槛不填词会整片沉默 */
      const topicGate = minRel > 0 && topicWords.length > 0
      const policyOn = Number(c.burstMax) > 0 || Number(c.maxPerHour) > 0
        || Boolean(c.quietStartHour) || Boolean(c.quietEndHour)
        || c.shortAskMustReply === true || c.silent === true || chance < 100
        || minRecent > 0 || topicGate;
      if (!policyOn) return { go: true, reason: '交给模型判断' };

      if (c.silent === true) return { go: false, reason: '主人设了静默' };

      s.policyTimes = s.policyTimes.filter((x) => t - x < 3_600_000);
      const shortAsk = isShortAsk(text, c.shortAskMustReply === true);

      /** 明确被追问时刹车不拦 */
      if (!shortAsk) {
        const hour = new Date().getHours();
        if (inQuietHours(c, hour)) return { go: false, reason: '静默时段' };
        const burstMax = Number(c.burstMax) || 0;
        if (burstMax > 0) {
          /** 窗口可调（默认 120 秒 = 以前写死的值），夹在 30–600 秒 */
          const burstWinSec = Math.min(600, Math.max(30, Number(c.burstWindowSec) || 120));
          if (s.policyTimes.filter((x) => t - x < burstWinSec * 1000).length >= burstMax) {
            return { go: false, reason: `${burstWinSec} 秒内最多接 ${burstMax} 次` };
          }
        }
        const perHour = Number(c.maxPerHour) || 0;
        if (perHour > 0 && s.policyTimes.length >= perHour) {
          return { go: false, reason: `每小时最多接 ${perHour} 次` };
        }
      }

      if (shortAsk) {
        s.policyTimes.push(t);
        return { go: true, force: true, reason: '被追问（在吗 / 人呢）' };
      }
      /** 纯图 / 纯语音没有正文，相关度没法算，直接放行 */
      if (atts.length && !text) {
        s.policyTimes.push(t);
        return { go: true, reason: '有附件，交给模型看' };
      }

      /** `engaged`：她刚说过话的 3 分钟内算「在聊」，接着聊 */
      if (c.mode === 'engaged' && s.lastReplyAt && t - s.lastReplyAt < 3 * 60_000) {
        if (s.engagedAt !== s.lastReplyAt) {
          s.engagedAt = s.lastReplyAt;
          s.engagedCount = 0;
        }
        s.engagedCount += 1;
        /** 默认 6，和旧 ai-chat 的 policyEngagedMaxTurns 一致（配置里可改） */
        const max = Number(c.engagedMaxTurns) || 6;
        if (s.engagedCount > max) {
          return { go: false, reason: `已经连着接了 ${max} 次没人接，先停一下` };
        }
        s.policyTimes.push(t);
        return { go: true, reason: `连聊中（第 ${s.engagedCount} 次）` };
      }

      /**
       * 群冷清时不插话：最近 `activeWindowSec` 秒内群消息条数不够就不插。
       *
       * 只拦「主动插话」——被 @、短问、连聊、纯附件都在上面 return 了。
       * **观察窗口没走满时放行**：刚启动 / 新群时环里没有历史，「不知道」
       * 不能当成「冷清」，否则每次重启都会哑上几分钟；等窗口攒满（这时
       * 群里真有话也早该有记录了）再开始判。
       */
      if (minRecent > 0) {
        const winMs = Math.min(3600, Math.max(30, Number(c.activeWindowSec) || 300)) * 1000;
        if (s.msgFirstAt && t - s.msgFirstAt >= winMs) {
          const count = s.msgTimes.filter((x) => t - x < winMs).length;
          if (count < minRecent) {
            return {
              go: false,
              reason: `群里没在聊（近 ${Math.round(winMs / 1000)} 秒 ${count} 条 < ${minRecent} 条）`,
            };
          }
        }
      }

      /**
       * 话题相关度门槛：和她感兴趣的话题关系不大就不插嘴。
       *
       * 是**硬闸**（低于门槛直接不接），过了闸才走概率；概率为 100 时仍然
       * 100（「100 = 不筛」是既有语义）。概率 < 100 时相关度会把概率放大
       * 到 `chance × (1 + 4 × 相关度)`，最多 100。
       */
      let relevance = null;
      let chanceEff = chance;
      if (topicGate) {
        relevance = topicRelevance(s.msgTexts, topicWords);
        if (relevance < minRel) {
          return {
            go: false,
            reason: `话题和她关系不大（相关度 ${relevance.toFixed(2)} < ${minRel}）`,
          };
        }
        chanceEff = Math.min(100, chance * (1 + 4 * relevance));
      }

      /**
       * 插话概率：走到这里的是「群里普普通通一句、没人叫她、也不在连聊中」。
       *
       * 私聊、被 @、命令、短问、纯附件、engaged 连聊都在上面各自 return 了——
       * 那些是明确在叫她 / 已经聊开了，随机丢掉一句会很怪。概率只管「她
       * 要不要主动插这句嘴」，这也是 aurabot 那个「插话」旋钮的本意。
       *
       * 没中时**不** push policyTimes：没接的话不该占掉刹车额度。
       */
      if (chanceEff < 100 && random() * 100 >= chanceEff) {
        return {
          go: false,
          reason: relevance === null
            ? `插话概率 ${chance}%，这次没中`
            : `插话概率 ${Math.round(chanceEff)}%（相关度 ${relevance.toFixed(2)} 放大），这次没中`,
        };
      }
      s.policyTimes.push(t);
      return { go: true, reason: relevance === null ? '交给模型判断' : `话题相关（${relevance.toFixed(2)}）` };
    },
  };

  return {
    /**
     * @param {object} evt roost 的 message 事件 data
     * @returns {{go:boolean, force?:boolean, cooling?:boolean, delayMs?:number, reason:string}}
     */
    check(evt) {
      /** 先记账再判：话题/冷清看的是「含当前这条」的最近一段 */
      if (!isOff(cfg()?.enabled)) noteInbound(evt);
      const v = impl.judge(evt);
      /** 决策链：每条都记，包括不接的那些（排障最想看的恰恰是「为什么没回」） */
      recent.push({
        at: now(),
        chatId: String(evt?.chat?.chatId ?? ''),
        kind: (evt?.chat?.kind === 'c2c' || evt?.chat?.kind === 'dm') ? 'c2c' : 'group',
        text: saidOf(evt).slice(0, 40),
        go: v.go === true,
        observe: v.observe === true,
        reason: String(v.reason ?? ''),
      });
      if (recent.length > 40) recent.shift();
      return v;
    },

    /** 最近判定（决策链可视化）：新的在前，只在内存里，不落盘 */
    recent(limit = 20) {
      const n = Number(limit);
      const take = Number.isFinite(n) ? Math.min(Math.max(n, 1), 40) : 20;
      return recent.slice(-take).reverse();
    },

    /** 真的发出去了才记——没发出去就记，冷却会白白吃掉下一句 */
    noteReplied(chatId) {
      const s = stOf(String(chatId ?? ''));
      const t = now();
      s.lastReplyAt = t;
      s.replyTimes.push(t);
      if (s.replyTimes.length > 60) s.replyTimes = s.replyTimes.slice(-60);
    },

    /** 面板/测试用：当前攒着的会话数与状态快照 */
    snapshot() {
      const out = {};
      for (const [id, s] of state) out[id] = { ...s };
      return out;
    },
  };
}
