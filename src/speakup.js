/**
 * 主动搭话：主人一阵子没找你，你主动在私聊里说句话。
 *
 * 照 Aurabot（`features/companion.js`）的做法，几条关键设计都是抄的：
 *
 *   1. **只在私聊，不在群里**——群里主动说话就是骚扰
 *   2. **随机间隔**，不是固定周期——固定周期一眼就是机器人
 *   3. **免打扰时段**——半夜三点找你聊天是灾难
 *   4. **只看私聊冷场**——群里再热闹，只要你没私聊她，她照样来找你
 *   5. **追问只追一次**——上次主动说了你没理，就不再追，免得像催债
 *   6. **首次只排期不触发**——不能让 DSH 一启动就收到一句「在吗」
 *
 * 我们自己加一条：**每日上限**。官方主动消息有配额（20 条/分、每群 1000 条/天），
 * 而且这是私聊，多了比不说更烦。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MINUTE = 60_000;

/** 默认配置 */
export const DEFAULTS = {
  enabled: false,
  /** 主人私聊的 openid。空 = 不工作（不知道怎么发） */
  chatId: '',
  /** 免打扰：只在 [awakeFrom, awakeTo) 之间说话，小时 */
  awakeFrom: 8,
  awakeTo: 23,
  /** 随机间隔范围（分钟）。太小会烦，太大会忘 */
  minIntervalMinutes: 180,
  maxIntervalMinutes: 480,
  /** 每天最多主动几次 */
  maxPerDay: 3,
  /**
   * 上次主动说了、主人没回，最多再追几次。
   *
   * `1` = 说了没回可以再追一次，追完还没回就闭嘴（注释里第 5 条
   * 「追问只追一次」）。`0` = 说一次没回就不再开口。
   * **不设上限的话**，不回她就每 3–8 小时追一次，一路追满 `maxPerDay`，
   * 那是最典型的「像催债」。
   */
  followUps: 1,
  /** 给 AI 的指令 */
  prompt:
    '主人有一阵子没找你了。主动发一条私聊消息给他，简短、自然，像朋友随口搭话。'
    + '不要问「在吗」，不要解释你为什么突然说话，不要提这是定时任务。一句话就够。',
};

/** 这一小时在不在清醒时段内（跨零点也支持，比如 22 → 6） */
export function inAwakeWindow(hour, from, to) {
  if (from === to) return true; // 全天
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * 该不该现在说话。
 *
 * 抽成纯函数是为了能测——时间相关的逻辑最容易写错，
 * 而它错了的表现是「半夜三点被机器人叫醒」，代价太大。
 *
 * @param {object} state { nextAt, todayCount, day, lastOwnerAt, lastBotAt }
 * @param {object} cfg
 * @param {number} now
 * @returns {{fire:boolean, why:string}}
 */
export function shouldFire(state, cfg, now) {
  if (!cfg.enabled) return { fire: false, why: '没开' };
  if (!cfg.chatId) return { fire: false, why: '没配 chatId' };

  const hour = new Date(now).getHours();
  if (!inAwakeWindow(hour, cfg.awakeFrom, cfg.awakeTo)) {
    return { fire: false, why: `免打扰（${cfg.awakeFrom}–${cfg.awakeTo} 点）` };
  }

  /**
   * 她自己要求安静（`<<silence:2h>>`）。
   *
   * 框架那边的会话闸也记了一份（拦收到的消息），这里必须**再记一份**：
   * 主动搭话走的是 outbound，不经过 pipeline，闸拦不到它。
   * 两边都记，才是「安静就是真的安静」。
   */
  if (state.silenceUntil && now < state.silenceUntil) {
    const mins = Math.ceil((state.silenceUntil - now) / MINUTE);
    return { fire: false, why: `她自己要求安静（还剩 ${mins} 分钟）` };
  }

  // 跨天了就把计数归零
  const day = new Date(now).toDateString();
  const count = state.day === day ? state.todayCount || 0 : 0;
  if (count >= (cfg.maxPerDay ?? DEFAULTS.maxPerDay)) {
    return { fire: false, why: `今天已经说了 ${count} 次` };
  }

  // 主人刚说过话，不用主动
  if (state.lastOwnerAt && now - state.lastOwnerAt < (cfg.minIntervalMinutes ?? 180) * MINUTE) {
    return { fire: false, why: '主人刚说过话' };
  }

  /**
   * **追问只追一次**（文件头第 5 条）。
   *
   * 以前这里只看 `lastOwnerAt`，于是主人一直不回就每 3–8 小时追一次，
   * 一路追满 `maxPerDay: 3`——三句话全都石沉大海，最像催债。
   * `lastBotAt` 早在 `fire()` 里就记了，但**全仓没有一处读它**，
   * 等于这条设计写在注释里、从没实现过。
   *
   * `unanswered` 是「连续几条主动消息没被回」，`noteOwner` 归零。
   * 老状态文件里没有这个字段时按 0 算，下一次 `fire()` 会从时间戳补回来
   * （见 `fire()` 里那段推导），所以升级不会卡在「永远 0」。
   */
  const followUps = Math.max(0, Number(cfg.followUps ?? DEFAULTS.followUps) || 0);
  if (Number(state.unanswered || 0) > followUps) {
    return {
      fire: false,
      why: `上次主动说了主人还没回（连着 ${state.unanswered} 条），不再追`,
    };
  }

  if (!state.nextAt || now < state.nextAt) {
    return { fire: false, why: '还没到时间' };
  }

  return { fire: true, why: '到点了' };
}

/**
 * 从模型输出里取 `<<silence:2h>>` 的毫秒数。没有返回 0。
 *
 * 为什么在 dsh-roost 这边也要解析一遍：主动搭话的文本由她生成，走的是
 * `speakup → channel → /r/send`，中间没有 ai-chat 的 `parseActions` 参与；
 * 而 `fire()` 里那句 `raw.replace(/<<[^>]*>>/g, '')` 会把标记**全部**抹平，
 * 抹掉之后时长就找不回来了。所以必须**先提取，再摘掉**。
 *
 * 单位默认分钟（`<<silence:30>>` 比 `<<silence:30m>>` 更可能是人想写的），
 * 上限 30 天——`<<silence:9999h>>` 那种等于永久静默，恢复只能靠面板。
 */
export function silenceMsOf(text) {
  const m = String(text ?? '').match(/<<silence:\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)?\s*>>/i);
  if (!m) return 0;
  const mul = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE }[
    (m[2] || 'm').toLowerCase()
  ];
  return Math.min(Math.round(Number(m[1]) * mul), 30 * 24 * 60 * MINUTE);
}

/** 下一次什么时候（在 [min, max] 之间随机） */
export function scheduleNext(cfg, now = Date.now()) {
  const min = Math.max(1, cfg.minIntervalMinutes ?? DEFAULTS.minIntervalMinutes);
  const max = Math.max(min, cfg.maxIntervalMinutes ?? DEFAULTS.maxIntervalMinutes);
  return now + (min + Math.random() * (max - min)) * MINUTE;
}

/**
 * 下一次什么时候 —— 跨天版。
 *
 * 给「今天的主动额度用完了」用。官方额度是**按天**算的，等一分钟没用，
 * 只能等跨天重置。推到下一个清醒时段开始（`awakeFrom` 点），
 * 再加 0–30 分钟随机：不加随机的话每天都会在同一个整点撞上去，一眼就是机器。
 */
export function scheduleNextDay(cfg, now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(cfg.awakeFrom ?? DEFAULTS.awakeFrom, 0, 0, 0);
  return d.getTime() + Math.random() * 30 * MINUTE;
}

export function createSpeakUp({ dataDir, cfgOf, ownerOf, generate, send, log = () => {} }) {
  const file = () => join(dataDir, 'speakup.json');

  /**
   * 当前配置，**已把「发给谁」补好**。
   *
   * `speakUp.chatId` 只是其中一种来源：Roost 那边本来就有一份更权威的
   * 主人 openid（`config/bots/<bot>.json` 的 `owners`）。以前这里只读
   * 自己那份，于是「Roost 认得主人、DSH 说没配」——用户没有任何理由
   * 知道要填两遍。
   *
   * 三级兜底，越靠前越优先：
   *   1. `speakUp.chatId`（面板显式填的，认人）
   *   2. `ownerOf()`（宿主给的：Roost 配置 / 从真实消息里学到的）
   *   3. 空 → 上层判定「没配」，什么都不做
   *
   * 抽成一个函数是因为原来三处（noteOwner / fire / tick）各拼了一遍，
   * 任何一处漏改就会出现「排期认了主人、发送却说不认识」。
   */
  function cfgNow() {
    const c = { ...DEFAULTS, ...(cfgOf().speakUp ?? {}) };
    if (!String(c.chatId || '').trim()) {
      const auto = String(ownerOf?.() || '').trim();
      if (auto) c.chatId = auto;
    }
    return c;
  }

  let state = {
    nextAt: 0, todayCount: 0, day: '', lastOwnerAt: 0, lastBotAt: 0,
    lastText: '', silenceUntil: 0, unanswered: 0,
  };
  try {
    state = { ...state, ...JSON.parse(readFileSync(file(), 'utf8')) };
  } catch {}

  function save() {
    try {
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(state), 'utf8');
    } catch (e) {
      log(`主动搭话状态存不下来：${e.message}`);
    }
  }

  /** 收到主人的消息时调一下，用来算冷场 */
  function noteOwner(chatId) {
    const cfg = cfgNow();
    if (!cfg.chatId || chatId !== cfg.chatId) return;
    state.lastOwnerAt = Date.now();
    // 主人回来了，「连着几条没被回」的账清零——追问额度重新攒
    state.unanswered = 0;
    // 主人回来了，重新排期
    state.nextAt = scheduleNext(cfg);
    save();
  }

  async function fire(reason = '定时') {
    const cfg = cfgNow();

    /**
     * 没配主人 openid 就**什么都不做**：不建会话、不跑模型、不排期。
     *
     * `tick()` 和 `shouldFire()` 都检查过这一条，但面板上的「立刻走一次」
     * 是**直接调 `fire()`** 的，绕过前面所有门。以前这里没有检查，于是：
     *   1. 宿主那边拿字面量 `'speakup'` 当 chatId 建了一个假会话
     *      （会话列表里凭空多出一个叫「主动搭话」的会话）
     *   2. 跑了一轮模型（真的花钱）
     *   3. `compose` 拿到空 chatId，`journal.recent('')` 返回**所有会话**的
     *      最近几条，可能引用群里的对话（串场）
     *   4. 最后才在发送那一步报「缺 target」
     * 顺序整个是反的：该在第一行拦住的事，拖到最后一行才报。
     */
    if (!cfg.chatId) {
      return { ok: false, why: '不知道该发给谁：Roost 没配主人（owners），DSH 也没填 chatId' };
    }

    try {
      const raw = String((await generate(cfg.prompt)) ?? '').trim();

      /**
       * **她自己决定不说** —— 这是正常结局，不是失败。
       *
       * 第 5 期把"到点就发一句"改成了"到点问她要不要说"，她能说不。
       * 两种情况（空回答 / `<<skip>>`）都必须**重新排期**：
       * 不排的话 `tick` 每分钟都会再问她一次，等于每 60 秒叫醒一次，
       * 正好违反"只唤醒"这条铁律。
       *
       * 也不计入今日次数——她没说，就不该占掉今天开口的额度。
       */
      const skipped = !raw || /<<\s*skip\s*>>/i.test(raw);
      if (skipped) {
        state.nextAt = scheduleNext(cfg);
        save();
        log(`醒了但决定不说（${reason}）：${raw ? '模型给了 skip' : '没内容'}`);
        return { ok: false, skipped: true, why: raw ? '她自己决定不说' : 'AI 没说话' };
      }

      /**
       * 静默标记要**先提取再摘掉**——下一行的 replace 会把所有 `<<...>>`
       * 一起抹平，抹掉之后再想拿时长就没处找了。
       */
      const silenceMs = silenceMsOf(raw);
      const text = raw.replace(/<<[^>]*>>/g, '').trim();
      if (!text && silenceMs <= 0) {
        state.nextAt = scheduleNext(cfg);
        save();
        return { ok: false, skipped: true, why: '去掉标记后没内容' };
      }

      const r = await send({ scene: 'c2c', target: cfg.chatId, text, silenceMs });

      /**
       * 只要求安静、没有要说的话：这不是「说了一次」，不能占今日额度，
       * 但要把 `silenceUntil` 记下来——否则下一分钟又问她一遍，
       * 她每分钟都说一次「让我静静」，比不静默还吵。
       */
      if (r?.ok && !text && silenceMs > 0) {
        state.silenceUntil = Date.now() + silenceMs;
        state.nextAt = state.silenceUntil + scheduleNext(cfg, 0);
        save();
        log(`她自己要求安静 ${Math.round(silenceMs / MINUTE)} 分钟（没说话）`);
        return { ok: true, silent: true, silenceMs };
      }
      if (!r?.ok) {
        /**
         * 发失败也要排下一次。否则失败会变成每分钟重试，直到把配额打满。
         *
         * 但「多久之后」要看失败原因——一律用随机间隔会让两种相反的情况
         * 都处理错：
         *   `quota` 今天这个会话的主动额度用完了，等一分钟也没用，
         *           按随机间隔（3–8 小时）重试就是一天空撞好几次，直接推到明天；
         *   `rate`  这一分钟发得太密，等一分钟就好，
         *           按随机间隔处理等于白白少说一次话。
         * 其余（离线/超窗/接口报错）按正常随机间隔，下次再说。
         *
         * 注意 quota 不是「她说得太多」——是**这个会话**今天的总额度被用掉了，
         * 面板手动发、别的插件 `ctx.push` 都记同一本账，所以跟 maxPerDay 无关。
         */
        const now = Date.now();
        state.nextAt =
          r?.code === 'quota' ? scheduleNextDay(cfg, now)
          : r?.code === 'rate' ? now + MINUTE
          : scheduleNext(cfg, now);
        save();
        log(`主动搭话没发出去（${r?.code || 'unknown'}）：${r?.message || '未知原因'}`);
        return { ok: false, code: r?.code, message: r?.message || '发失败' };
      }

      /**
       * 「连着几条没被回」的账。
       *
       * 三种情况要分开，只写 `+1` 会把第三种算错：
       *   1. 上一条被回了（或从没说过）→ 重新从 1 开始
       *   2. 有账（`unanswered > 0`）→ 往上加
       *   3. **老状态文件没有这个字段**（默认 0），但从 `lastBotAt > lastOwnerAt`
       *      看得出上一条确实欠着 → 这次是第 2 条
       * 少了第 3 条，升级后的第一次追问会被当成「第 1 条」，
       * 于是又能追满一整轮——等于这次修复对存量数据不生效。
       *
       * 必须在写新的 `lastBotAt` **之前**取旧值，否则比较永远成立。
       */
      const prevBotAt = Number(state.lastBotAt || 0);
      if (prevBotAt <= Number(state.lastOwnerAt || 0)) {
        state.unanswered = 1;
      } else if (Number(state.unanswered || 0) > 0) {
        state.unanswered = Number(state.unanswered) + 1;
      } else {
        state.unanswered = 2;
      }
      state.lastBotAt = Date.now();
      state.lastText = text.slice(0, 100);
      state.todayCount = (state.day === new Date().toDateString() ? state.todayCount : 0) + 1;
      state.day = new Date().toDateString();
      state.nextAt = scheduleNext(cfg);
      /**
       * 「说完这句，让我静静」——两个动作可以同时发生。
       * 排期取两者较大的那个，省得静默期内每分钟空问一遍。
       */
      if (silenceMs > 0) {
        state.silenceUntil = Date.now() + silenceMs;
        state.nextAt = Math.max(state.nextAt, state.silenceUntil);
        log(`顺带要求安静 ${Math.round(silenceMs / MINUTE)} 分钟`);
      }
      save();

      log(`主动找主人说话了（${reason}）：${text.slice(0, 40)}`);
      return { ok: true, text };
    } catch (e) {
      log(`主动搭话失败：${e?.message ?? e}`);
      // 失败了也排下一次，不然会每分钟重试一次
      state.nextAt = scheduleNext(cfg);
      save();
      return { ok: false, message: e?.message ?? String(e) };
    }
  }

  /** 每分钟跑一次 */
  async function tick(now = Date.now()) {
    const cfg = cfgNow();
    // 「没开」和「没配 chatId」是两件事，报同一个 why 会让人查错方向
    if (!cfg.enabled) return { ok: false, why: '没开' };
    if (!cfg.chatId) return { ok: false, why: '不知道该发给谁：Roost 没配主人（owners），DSH 也没填 chatId' };

    // 第一次只排期，不触发——不能让 DSH 一启动就发一句「在吗」
    if (!state.nextAt) {
      state.nextAt = scheduleNext(cfg, now);
      save();
      return { ok: false, why: '首次排期' };
    }

    const d = shouldFire(state, cfg, now);
    if (!d.fire) return { ok: false, why: d.why };
    return fire('定时');
  }

  return {
    tick,
    fire,
    noteOwner,
    state: () => ({ ...state }),
  };
}
