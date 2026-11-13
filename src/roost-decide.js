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
  'shortAskMustReply', 'silent', 'ignoreWords',
  /** group 层自己的键也允许按群覆写 */
  'interruptChance',
]);

/** 概率夹紧到 0–100；没配 / 配坏了都当 100（= 不拦，保持原行为） */
function chanceOf(v) {
  const n = Number(v);
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

/** 这条消息的正文。纯语音要走 asrText（content 是空串） */
function saidOf(evt) {
  const said = String(evt?.content ?? '').trim();
  if (said) return said;
  return (evt?.attachments ?? []).map((a) => String(a?.asrText ?? '').trim()).filter(Boolean).join(' ');
}

/**
 * @param {object} o
 * @param {() => object} o.cfg 现读配置（`roostHost.decide` + `group`）
 * @param {() => number} [o.now]
 * @param {() => number} [o.random] 0–1 的随机数，注入给单测用
 */
export function createDecider({ cfg, now = () => Date.now(), random = Math.random } = {}) {
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
      };
      state.set(chatId, s);
    }
    return s;
  }

  /**
   * 真正的判定收在 `impl.judge` 里，外面再包一层 `check` 只为记
   * 「这条为什么回 / 不回」——这里有二十多个 return，挨个插日志必漏一处。
   *
   * @param {object} evt roost 的 message 事件 data
   * @returns {{go:boolean, force?:boolean, cooling?:boolean, delayMs?:number, reason:string}}
   */
  const impl = {
    judge(evt) {
      const chatId = String(evt?.chat?.chatId ?? '');
      /** 按群覆写在这里生效；chance 是这一层的插话概率 */
      const { decide: c, chance } = conf(chatId);
      const kind = evt?.chat?.kind === 'c2c' ? 'c2c' : 'group';
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
      const policyOn = Number(c.burstMax) > 0 || Number(c.maxPerHour) > 0
        || Boolean(c.quietStartHour) || Boolean(c.quietEndHour)
        || c.shortAskMustReply === true || c.silent === true || chance < 100;
      if (!policyOn) return { go: true, reason: '交给模型判断' };

      if (c.silent === true) return { go: false, reason: '主人设了静默' };

      s.policyTimes = s.policyTimes.filter((x) => t - x < 3_600_000);
      const shortAsk = isShortAsk(text, c.shortAskMustReply === true);

      /** 明确被追问时刹车不拦 */
      if (!shortAsk) {
        const hour = new Date().getHours();
        if (inQuietHours(c, hour)) return { go: false, reason: '静默时段' };
        const burstMax = Number(c.burstMax) || 0;
        if (burstMax > 0 && s.policyTimes.filter((x) => t - x < 120_000).length >= burstMax) {
          return { go: false, reason: `两分钟内最多接 ${burstMax} 次` };
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
       * 插话概率：走到这里的是「群里普普通通一句、没人叫她、也不在连聊中」。
       *
       * 私聊、被 @、命令、短问、纯附件、engaged 连聊都在上面各自 return 了——
       * 那些是明确在叫她 / 已经聊开了，随机丢掉一句会很怪。概率只管「她
       * 要不要主动插这句嘴」，这也是 aurabot 那个「插话」旋钮的本意。
       *
       * 没中时**不** push policyTimes：没接的话不该占掉刹车额度。
       */
      if (chance < 100 && random() * 100 >= chance) {
        return { go: false, reason: `插话概率 ${chance}%，这次没中` };
      }
      s.policyTimes.push(t);
      return { go: true, reason: '交给模型判断' };
    },
  };

  return {
    /**
     * @param {object} evt roost 的 message 事件 data
     * @returns {{go:boolean, force?:boolean, cooling?:boolean, delayMs?:number, reason:string}}
     */
    check(evt) {
      const v = impl.judge(evt);
      /** 决策链：每条都记，包括不接的那些（排障最想看的恰恰是「为什么没回」） */
      recent.push({
        at: now(),
        chatId: String(evt?.chat?.chatId ?? ''),
        kind: evt?.chat?.kind === 'c2c' ? 'c2c' : 'group',
        text: saidOf(evt).slice(0, 40),
        go: v.go === true,
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
