/**
 * 情绪：**三维内部状态 + 语气指令**。
 *
 * 两个关键设计（都是被实证逼出来的）：
 *
 * 1. **三维只做内部决策，不注入数字**
 *    valence（心情好坏 -1~1）/ energy（精力 0~1）/ sociability（社交意愿 0~1）
 *    这些用来算：主动概率、接话门槛。
 *    **注入给模型的是自然语言语气指令**，不是 `0.35 / 0.80 / 0.60`。
 *    实测带数字"像在演"，去掉反而自然。
 *
 * 2. **必须能自己回中性**
 *    只增不减 = 永远生气，是这类系统最常见的死法。
 *    所以按时间差做指数衰减，外加上下界 clamp。
 *
 * 情绪怎么变：
 *   · 被点赞/点踩（interaction type 13）→ valence
 *   · 聊得多、被 @ → energy / sociability 回升
 *   · 长时间没人理 → 慢慢回中性（**不会低于中性**，见下）
 *   · 模型自己也能改（`<<mood: ...>>` 标记）
 *
 * ## 三个数值的语义（2026-10-28 修过一轮，之前的实现自相矛盾）
 *
 *   NEUTRAL = 0.5  —— 衰减的落点，也是面板上「一般」那一档
 *   LOW     = 0.4  —— 低于它才算「低」，才会说"不想搭话 / 有点累"
 *   HIGH    = 0.8  —— 高于它才算「高」
 *
 * **关键约束：衰减只能把数值拉回 0.5，永远到不了 0.4 以下。**
 * 这是有意的——「没人理她」应该是慢慢平静，不是越晾越抑郁。
 * 所以「低情绪」只能由**事件**造成（被踩、模型自己写 `<<mood:>>`），
 * 而且会自己衰减回来。
 *
 * 以前这里是个真 bug：衰减目标写 0.5、低阈值写 0.3，
 * 数学上 0.3 永远够不到 → 「有点累」「不想搭话」和 ai-chat 的
 * 低情绪闸门**全是死分支**，跑一年也触发不了一次。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

/** 3.5：回中性的半衰期与衰减落点可调（`config.mood.halfLifeHours` / `baseline`），默认 4h / 0.5 */

/** 衰减落点 / 面板「一般」那一档 */
export const NEUTRAL = 0.5;
/** 低于它才算「低」。**衰减到不了这里**，只能由事件造成 */
export const LOW = 0.4;
/** 高于它才算「高」 */
export const HIGH = 0.8;

/**
 * 有人说话时，精力和社交意愿往哪儿靠、靠多快。
 *
 * 为什么不是线性 `+0.1 / +0.15`：那样**三条消息就顶满 1.0**，
 * 然后要 12 小时才掉回 0.56——聊天时永远显示"很想说"，
 * 情绪就成了装饰。改成「向目标渐近」，聊再久也只稳定在目标附近，
 * 真正的极端值只能靠明确事件（点赞/被凶）到达。
 */
const TOUCH_TARGET = { energy: 0.8, sociability: 0.75 };
const TOUCH_RATE = { energy: 0.25, sociability: 0.3 };

/**
 * 两次「有人说话」之间至少隔这么久才算一次。
 *
 * 没有这个冷却的话，一场 10 分钟的对话会调几十次 `touched()`，
 * 不管每次加多小都会顶到天花板。
 */
const TOUCH_COOLDOWN = 5 * 60 * 1000;

/**
 * `reason` 的保质期。
 *
 * 以前它永不过期：一次点赞之后，每轮都往语气指令里追加「（原因：被夸了）」，
 * 过了三天还在因为三天前那句夸奖而"心情好"。
 */
const REASON_TTL = 6 * 60 * 60 * 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 向目标渐近：离得远就多走一点，快到了就少走一点 */
const rise = (cur, target, rate) => cur + (target - cur) * rate;

/**
 * 把各种写法归一成 `LIKE` / `UNLIKE`。
 *
 * 为什么需要：面板按钮发的是 `up` / `down`，QQ 官方 `feedback_opt` 的
 * 大小写也没保证，而这里原来只认全大写的 `LIKE` / `UNLIKE`——
 * 结果**面板上那个赞/踩按钮点了完全没反应**，还照样弹"记了个赞"。
 */
export function normalizeFeedback(kind) {
  const s = String(kind ?? '').trim().toLowerCase();
  if (!s) return '';
  if (['like', 'up', 'good', 'thumb_up', '点赞', '赞'].includes(s)) return 'LIKE';
  if (['unlike', 'down', 'bad', 'thumb_down', '点踩', '踩', '嫌弃'].includes(s)) return 'UNLIKE';
  return '';
}

/**
 * C3：官方点赞点踩 → `awake.feedback()` 的参数。
 *
 * `/mood` 路由以前直接写 `{ positive: normalizeFeedback(raw) === 'LIKE' }`，
 * 这一行埋路由里没有单测。抽出来之后「raw 到底算不算正反馈」可以单独测，
 * 也保证全仓只有 `normalizeFeedback` 一份判方向逻辑。
 *
 * @returns {{positive:boolean}|null} 认不出来返回 null（调用方别结算）
 */
export function feedbackArgsOf(raw) {
  const dir = normalizeFeedback(raw);
  if (!dir) return null;
  return { positive: dir === 'LIKE' };
}

/**
 * 解析 `<<mood: ...>>` 里的参数。
 *
 * 支持 `valence=-0.3, reason=被凶了`；只有一段文字时整段当原因。
 *
 * **为什么不用「按逗号切」**：`reason=被凶了，有点难受` 会被切成两段，
 * 第二段没有 key，而 reason 已经有值了 → 直接丢掉，
 * 结果原因只剩「被凶了」。这里改成「按 key 定位、值取到下一个 key 之前」，
 * 原因里带逗号也不怕。
 *
 * @param {string} raw
 * @returns {{valence?:number, energy?:number, sociability?:number, reason?:string}}
 */
export function parseMoodMark(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return {};

  const KEY = /(valence|energy|sociability|reason)\s*[=:：]\s*/gi;
  const hits = [...s.matchAll(KEY)];
  if (!hits.length) return { reason: s.slice(0, 60) };

  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const key = hits[i][1].toLowerCase();
    const from = hits[i].index + hits[i][0].length;
    const to = i + 1 < hits.length ? hits[i + 1].index : s.length;
    // 值末尾可能拖着分隔符（`valence=0.3, reason=x` 里的那个逗号）
    const value = s.slice(from, to).replace(/[,，;；]\s*$/, '').trim();
    if (!value) continue;
    if (key === 'reason') out.reason = value.slice(0, 60);
    else {
      const n = Number(value);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out;
}

/**
 * 3.5：半衰期与衰减落点可调。
 *
 * 两条数学不变量必须守住，调参不许把它们调坏：
 *   · 半衰期至少 0.5 小时——0 等于「聊完立刻归零」，情绪就成了噪声；
 *   · 基线夹在 [0.45, 0.9]——**必须高于 LOW(0.4)**，否则「衰减只能拉回
 *     中性、永远到不了低档」这条设计（见上）就被反过来打破了：
 *     衰减会把 energy/sociability 直接拖进低档，「有点累」从事件分支
 *     变成常态分支。0.45 留了半档余量，0.9 封顶防有人想让她「永远兴奋」。
 */
function paramsOf(cfgOf) {
  const c = (typeof cfgOf === 'function' ? cfgOf() : cfgOf) || {};
  const halfHours = Math.max(0.5, Number(c.halfLifeHours) || 4);
  const rawBase = Number(c.baseline);
  const baseline = Number.isFinite(rawBase) ? Math.min(0.9, Math.max(0.45, rawBase)) : NEUTRAL;
  return { halfMs: halfHours * 3_600_000, baseline };
}

export function createMood(opts = null) {
  /** 3.5：参数现读。两种传法都收：`createMood({ cfgOf })`（与其它模块一致）或直接传函数 */
  const cfgOf = opts && typeof opts === 'object' ? opts.cfgOf : opts;
  const file = () => join(dataDir(), 'mood.json');
  let cache = null;
  /** 上一次真正吃到 `touched()` 的时间（不落盘，重启后从头算） */
  let lastTouchAt = 0;

  function load() {
    if (cache) return cache;
    const base = paramsOf(cfgOf).baseline;
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      cache = {
        valence: clamp(Number(raw?.valence ?? 0), -1, 1),
        energy: clamp(Number(raw?.energy ?? base), 0, 1),
        sociability: clamp(Number(raw?.sociability ?? base), 0, 1),
        updatedAt: Number(raw?.updatedAt ?? Date.now()),
        /** 原因是什么时候写下的。老文件没有这个字段，当 0（= 已过期） */
        reasonAt: Number(raw?.reasonAt ?? 0),
        reason: String(raw?.reason ?? ''),
      };
    } catch {
      cache = {
        valence: 0,
        energy: paramsOf(cfgOf).baseline,
        sociability: paramsOf(cfgOf).baseline,
        updatedAt: Date.now(),
        reasonAt: 0,
        reason: '',
      };
    }
    return cache;
  }

  function save() {
    try {
      mkdirSync(dataDir(), { recursive: true });
      const tmp = file() + '.tmp';
      writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf8');
      renameSync(tmp, file());
    } catch {
      /* 存不下就算了，不能因为情绪把这一轮弄挂 */
    }
  }

  /**
   * 按经过的时间往中性衰减。
   *
   * 为什么不是"直接归零"：隔一周没聊，真人是"有点生疏"，不是失忆。
   * 指数衰减正好——半衰期 4 小时，一天后还剩 ~1/6，一周后接近中性。
   *
   * 注意落点是 `NEUTRAL`（0.5）而不是 0：energy/sociability 是"程度"，
   * 0 等于"死了"，不是"平静"。
   */
  function decay() {
    const m = load();
    const dt = Date.now() - m.updatedAt;
    if (dt < 60_000) return m; // 一分钟内不动，省得频繁写盘
    const { halfMs, baseline } = paramsOf(cfgOf);
    const k = Math.pow(0.5, dt / halfMs);
    // 往各自的中性值靠（valence→0，energy/sociability→基线）
    m.valence = m.valence * k;
    m.energy = baseline + (m.energy - baseline) * k;
    m.sociability = baseline + (m.sociability - baseline) * k;
    m.updatedAt = Date.now();
    save();
    return m;
  }

  /** 原因还在保质期内吗 */
  const reasonFresh = (m) => Boolean(m.reason) && m.reasonAt > 0 && Date.now() - m.reasonAt < REASON_TTL;

  /** 把三维翻成人话。**这是注入给模型的东西**，不是数字。 */
  function toInstruction(m) {
    const parts = [];
    if (m.valence > 0.4) parts.push('你现在心情不错，说话轻快些');
    else if (m.valence < -0.4) parts.push('你现在有点烦，别勉强热情，句子短一点');
    /**
     * B3：中性时**什么都不注入**。
     * 以前恒定给一句「你心情一般」，每轮都进 system prompt，既是噪声、
     * 又会让模型照着「一般」演。没内容就返回空串，挂载点自己会跳过。
     */
    // else 故意留空

    if (m.energy < LOW) parts.push('有点累，不太想长篇大论');
    else if (m.energy > HIGH) parts.push('精神很好');

    if (m.sociability < LOW) parts.push('不太想主动搭话，别人不找你你就安静待着');
    else if (m.sociability > HIGH) parts.push('挺想聊天的');

    // 原因过期就别提了——三天前那句夸奖不该还在影响语气
    if (reasonFresh(m)) parts.push(`（原因：${m.reason}）`);
    return parts.length ? `${parts.join('；')}。` : '';
  }

  return {
    /** 当前状态（先衰减再返回） */
    get() {
      return { ...decay() };
    },

    /** 注入用的一句话 */
    text() {
      return toInstruction(decay());
    },

    /**
     * 被点赞/点踩（interaction type 13，面板也能手动喂）。
     *
     * `kind` 走 `normalizeFeedback`，`up` / `down` / `like` / `LIKE` 都认。
     * 认不出来就**原样返回、不改任何东西**——静默成功最坑人。
     */
    feedback(kind) {
      const k = normalizeFeedback(kind);
      const m = decay();
      if (!k) return { ...m, applied: false };
      if (k === 'LIKE') {
        m.valence = clamp(m.valence + 0.25, -1, 1);
        m.sociability = clamp(m.sociability + 0.1, 0, 1);
        m.reason = '被夸了';
      } else {
        m.valence = clamp(m.valence - 0.3, -1, 1);
        m.sociability = clamp(m.sociability - 0.15, 0, 1);
        m.reason = '被嫌弃了';
      }
      m.reasonAt = Date.now();
      m.updatedAt = Date.now();
      save();
      return { ...m, applied: true };
    },

    /**
     * 有人说话：精力和社交意愿回升。
     *
     * 带冷却 + 渐近，见文件头 `TOUCH_TARGET` / `TOUCH_COOLDOWN` 的说明。
     * 冷却期内直接返回当前值，**连 `updatedAt` 都不动**——
     * 否则等于每来一条消息就把衰减时钟重置一次，衰减永远跑不起来。
     */
    touched() {
      const now = Date.now();
      if (now - lastTouchAt < TOUCH_COOLDOWN) return { ...load() };
      lastTouchAt = now;
      const m = decay();
      m.energy = clamp(rise(m.energy, TOUCH_TARGET.energy, TOUCH_RATE.energy), 0, 1);
      m.sociability = clamp(rise(m.sociability, TOUCH_TARGET.sociability, TOUCH_RATE.sociability), 0, 1);
      m.updatedAt = now;
      save();
      return { ...m };
    },

    /** 模型自己改（`<<mood: valence=-0.3, reason=被凶了>>` 之类） */
    set({ valence, energy, sociability, reason } = {}) {
      const m = decay();
      if (Number.isFinite(valence)) m.valence = clamp(Number(valence), -1, 1);
      if (Number.isFinite(energy)) m.energy = clamp(Number(energy), 0, 1);
      if (Number.isFinite(sociability)) m.sociability = clamp(Number(sociability), 0, 1);
      if (reason) {
        m.reason = String(reason).slice(0, 60);
        m.reasonAt = Date.now();
      }
      m.updatedAt = Date.now();
      save();
      return { ...m };
    },
  };
}
