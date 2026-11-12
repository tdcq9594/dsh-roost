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
 *   私聊 → 被 @ → 空消息 → 忽略词 → 模式收敛 → 免@窗口 → 冷却 → 每分钟配额 → 刹车策略
 */

/** 默认忽略词：别的插件靠这些前缀干活，别抢 */
export const DEFAULT_IGNORE = ['/'];

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
 * @param {() => object} o.cfg 现读配置（`roostHost.decide`）
 * @param {() => number} [o.now]
 */
export function createDecider({ cfg, now = () => Date.now() } = {}) {
  /** chatId → 每会话运行时状态 */
  const state = new Map();

  const conf = () => cfg()?.roostHost?.decide ?? {};

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

  return {
    /**
     * @param {object} evt roost 的 message 事件 data
     * @returns {{go:boolean, force?:boolean, cooling?:boolean, delayMs?:number, reason:string}}
     */
    check(evt) {
      const c = conf();
      const chatId = String(evt?.chat?.chatId ?? '');
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
      const policyOn = Number(c.burstMax) > 0 || Number(c.maxPerHour) > 0
        || Boolean(c.quietStartHour) || Boolean(c.quietEndHour)
        || c.shortAskMustReply === true || c.silent === true;
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

      s.policyTimes.push(t);
      return { go: true, reason: '交给模型判断' };
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
