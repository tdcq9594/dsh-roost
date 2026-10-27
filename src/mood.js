/**
 * 情绪：**三维内部状态 + 语气指令**。
 *
 * 两个关键设计（都是被实证逼出来的）：
 *
 * 1. **三维只做内部决策，不注入数字**
 *    valence（心情好坏 -1~1）/ energy（精力 0~1）/ sociability（社交意愿 0~1）
 *    这些用来算：主动概率、回复长度倾向、接话门槛。
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
 *   · 长时间没人理 → energy / sociability 慢慢掉
 *   · 模型自己也能改（`<<mood: ...>>` 标记，后续接）
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';

/** 回到中性的半衰期（毫秒）。4 小时：聊完一场，半天后基本平复 */
const HALF_LIFE = 4 * 60 * 60 * 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function createMood() {
  const file = () => join(dataDir(), 'mood.json');
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(file(), 'utf8'));
      cache = {
        valence: clamp(Number(raw?.valence ?? 0), -1, 1),
        energy: clamp(Number(raw?.energy ?? 0.6), 0, 1),
        sociability: clamp(Number(raw?.sociability ?? 0.6), 0, 1),
        updatedAt: Number(raw?.updatedAt ?? Date.now()),
        reason: String(raw?.reason ?? ''),
      };
    } catch {
      cache = { valence: 0, energy: 0.6, sociability: 0.6, updatedAt: Date.now(), reason: '' };
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
   */
  function decay() {
    const m = load();
    const dt = Date.now() - m.updatedAt;
    if (dt < 60_000) return m; // 一分钟内不动，省得频繁写盘
    const k = Math.pow(0.5, dt / HALF_LIFE);
    // 往各自的中性值靠（valence→0，energy/sociability→0.5）
    m.valence = m.valence * k;
    m.energy = 0.5 + (m.energy - 0.5) * k;
    m.sociability = 0.5 + (m.sociability - 0.5) * k;
    m.updatedAt = Date.now();
    save();
    return m;
  }

  /** 把三维翻成人话。**这是注入给模型的东西**，不是数字。 */
  function toInstruction(m) {
    const parts = [];
    if (m.valence > 0.4) parts.push('你现在心情不错，说话轻快些');
    else if (m.valence < -0.4) parts.push('你现在有点烦，别勉强热情，句子短一点');
    else parts.push('你心情一般');

    if (m.energy < 0.3) parts.push('有点累，不太想长篇大论');
    else if (m.energy > 0.8) parts.push('精神很好');

    if (m.sociability < 0.3) parts.push('不太想主动搭话，别人不找你你就安静待着');
    else if (m.sociability > 0.8) parts.push('挺想聊天的');

    if (m.reason) parts.push(`（原因：${m.reason}）`);
    return parts.join('；') + '。';
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

    /** 被点赞/点踩（interaction type 13） */
    feedback(kind) {
      const m = decay();
      if (kind === 'LIKE') {
        m.valence = clamp(m.valence + 0.25, -1, 1);
        m.sociability = clamp(m.sociability + 0.1, 0, 1);
        m.reason = '被夸了';
      } else if (kind === 'UNLIKE') {
        m.valence = clamp(m.valence - 0.3, -1, 1);
        m.sociability = clamp(m.sociability - 0.15, 0, 1);
        m.reason = '被嫌弃了';
      }
      m.updatedAt = Date.now();
      save();
      return { ...m };
    },

    /** 被 @ / 被点名：精力和社交意愿回升 */
    touched() {
      const m = decay();
      m.energy = clamp(m.energy + 0.1, 0, 1);
      m.sociability = clamp(m.sociability + 0.15, 0, 1);
      m.updatedAt = Date.now();
      save();
      return { ...m };
    },

    /** 模型自己改（`<<mood: 心情好了一点，因为被夸了>>` 之类） */
    set({ valence, energy, sociability, reason } = {}) {
      const m = decay();
      if (Number.isFinite(valence)) m.valence = clamp(Number(valence), -1, 1);
      if (Number.isFinite(energy)) m.energy = clamp(Number(energy), 0, 1);
      if (Number.isFinite(sociability)) m.sociability = clamp(Number(sociability), 0, 1);
      if (reason) m.reason = String(reason).slice(0, 60);
      m.updatedAt = Date.now();
      save();
      return { ...m };
    },
  };
}
