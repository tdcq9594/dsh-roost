/**
 * 消息合并：连着发的几句话攒成一段再回。
 *
 * 为什么必须有：真人不会在你打字打到一半时插话。不合并的话
 * 「在吗」→「问你个事」→「那个报错怎么办」会被回三次，
 * 或者更糟——第一条还在想，后两条被排队锁当成「同一轮」丢掉。
 *
 * 规则抄 ai-chat 的 `merge.js`（用户已经习惯那个手感）：
 *   · `waitSec`  停多久算说完，每来一条重新计时
 *   · `maxSec`   最多等多久，从第一条算，对方一直发也不会无限等
 *   · **私聊 / 被 @ / 命令不等待**——那是在明确叫你，再等 1.5 秒就是迟钝
 *
 * 与 ai-chat 的差别：那边是「等待者」模型（`add()` 返回 Promise，只有第一个
 * 拿到 batch），这边是纯事件驱动，用回调 `onFlush` 把整批交出去。
 * 语义一样，但少一层 Promise 挂起，卸载时也不会有永远等着的 handler。
 */

import { decodeFaceTags } from './face-table.js';

/** 一批消息里，附件要跨条合并——用户先发图、再补一句话，图不能凭空消失 */
function batchOf(items) {
  const last = items[items.length - 1];
  return {
    items,
    /** 回复挂到最后一条：它的 msgId 最新，被动窗口最稳 */
    msg: last,
    text: items.length === 1 ? textOf(items[0]) : items.map(lineOf).join('\n'),
    count: items.length,
    /** 多条就算「批次」。上层据此不再在外面套统一的发送者标签 */
    multi: items.length > 1,
    attachments: items.flatMap((it) => it.attachments ?? []),
    elements: items.flatMap((it) => it.elements ?? []),
    senders: [...new Set(items.map((it) => it?.sender?.name).filter(Boolean))],
  };
}

/**
 * 这条消息「说了什么」。
 *
 * **纯语音 / 纯图片消息的 `content` 是空串**，内容全在 attachments 里
 * （语音看 `asrText`，官方白给的转写）。不看这里的话，用户发一段语音
 * 模型收到的是空字符串。
 *
 * 表情在这一层就转成 `【表情: 名字】`，**不能留到渲染层**：
 * journal、记忆、摘要、决策全都从这份 text 派生，晚一步转，历史里就
 * 永久存着 `<faceType=6,faceId="0" ext="…">` 原文，模型只能照着抄。
 * dsh-qqbot 在 `middleware-setup.ts` 里也标了同一件事
 * （"若解析放后面, 历史里存的就是原文"）。
 */
export function textOf(evt) {
  const said = decodeFaceTags(String(evt?.content ?? '')).trim();
  if (said) return said;
  return (evt?.attachments ?? [])
    .map((a) => String(a?.asrText ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** 多人批次里每条都带发言人 + openid：模型要 @ 人时得有个 handle */
function lineOf(evt) {
  const text = textOf(evt);
  const name = String(evt?.sender?.name ?? '').trim();
  if (!name) return text;
  const id = String(evt?.sender?.openid ?? '').trim();
  const uin = String(evt?.sender?.uin ?? '').replace(/\D/g, '');
  /**
   * 有 QQ 号时号码排在 openid 前面：openid 换机器人就全变，号码不会。
   * 只给 openid 的话，换一次机器人它就把老朋友当陌生人了。
   */
  if (uin) return id ? `${name}(QQ ${uin} / ${id})：${text}` : `${name}(QQ ${uin})：${text}`;
  return id ? `${name}(${id})：${text}` : `${name}：${text}`;
}

/**
 * ## 她还在回上一条时（照 aurabot 的 hub.js）
 *
 * 老做法是「排队满了就逐条回『上一条还在想』」——突发 @ 时会刷一屏。
 * aurabot 没有这句话：它把这一轮期间来的消息**继续攒在 pending 里**，
 * 等这一轮结束（`release()`）再合成一批交出去；私聊则直接 `steer` 插话。
 * 这里照搬这套：
 *   · busy 为真 → 不另开一轮。能 steer（私聊）就插话，否则打 `waiting`
 *     标记继续攒，**不回任何提示**。
 *   · `release(chatId)` 在 handleTurn 的 finally 里调，把攒着的交出去。
 *   · busy 在 **flush 那一刻同步置上**（不是等 task 真的跑起来）——
 *     deliverBatch 是异步的，两条被 @ 的消息可能都还没到排队那一步，
 *     靠队列自身的 busy 判断会漏。aurabot 也是 flush 时就置。
 *   · 一轮卡死 release 永远不来时有看门狗强放，攒批不会饿死。
 *
 * `trackBusy` 默认关：老的调用方（和单测）多条 add 仍照旧合批、不受影响；
 * 只有 host 打开它，才启用「busy 攒批 + release」这套。
 *
 * @param {object} o
 * @param {number|(()=>number)} [o.waitSec]
 * @param {number|(()=>number)} [o.maxSec]
 * @param {number|(()=>number)} [o.groupWaitSec]  群聊停顿窗口（缺省同 waitSec）
 * @param {number|(()=>number)} [o.groupMaxSec]   群聊最长窗口（缺省同 maxSec）
 * @param {boolean} [o.trackBusy]                 是否启用 busy 攒批（host 打开）
 * @param {number|(()=>number)} [o.busyMaxMs]     一轮多久没 release 就强放
 * @param {(chatId:string)=>boolean} [o.busyOf]   额外的 busy 来源（可选）
 * @param {(chatId:string, batch:object)=>Promise<boolean>|boolean} [o.onSteer]
 *   私聊插话：返回 true 表示这条已被当前轮接走；false/没有就攒着等 release
 * @param {(chatId:string, batch:object)=>void} o.onFlush
 * @param {()=>number} [o.now]
 * @param {(msg:string)=>void} [o.log]
 */
export function createMerger({
  waitSec = 1.5,
  maxSec = 6,
  groupWaitSec = null,
  groupMaxSec = null,
  trackBusy = false,
  busyMaxMs = 210_000,
  busyOf = () => false,
  onSteer = null,
  onFlush = () => {},
  now = () => Date.now(),
  log = () => {},
} = {}) {
  /** chatId → { items, waitTimer, maxTimer, firstAt, notBefore, waiting } */
  const pending = new Map();
  /** chatId → { at, timer }：flush 置上、release 清掉的一轮锁 */
  const busy = new Map();

  const busyMax = () => {
    const n = Number(typeof busyMaxMs === 'function' ? busyMaxMs() : busyMaxMs);
    return Number.isFinite(n) && n > 0 ? n : 210_000;
  };
  const isBusy = (chatId) => busy.has(chatId) || (trackBusy && busyOf(chatId));

  function markBusy(chatId) {
    if (!trackBusy) return;
    const entry = { at: now(), timer: null };
    busy.set(chatId, entry);
    /**
     * 看门狗：batch 没走到 handleTurn（quiet.skip / 没 chatId），或这一轮
     * 真卡死导致 release 不来时，兜底强放——否则攒批永远出不去。
     */
    const t = setTimeout(() => {
      if (busy.get(chatId) !== entry) return;
      log(`${chatId.slice(0, 8)}：一轮 ${Math.round(busyMax() / 1000)}s 没结束，强放攒批`);
      clearBusy(chatId);
      const b = pending.get(chatId);
      if (b?.waiting) { b.waiting = false; flush(chatId, true); }
    }, busyMax());
    t.unref?.();
    entry.timer = t;
  }

  function clearBusy(chatId) {
    const entry = busy.get(chatId);
    if (entry?.timer) clearTimeout(entry.timer);
    busy.delete(chatId);
  }

  /**
   * 两个窗口都允许传函数：host 传的是「现读 cfg 的箭头函数」。
   *
   * 为什么不是构造时读一次：面板把 `roostHost.merge.*` 露出来之后，用户改了
   * 「停顿多久算说完」却要重启才生效，那个输入框就是假的。decider 本来就是
   * `cfg: () => cfg` 现读，合并器跟它对齐；每来一条消息读一次，开销可忽略。
   * 传数字的老调用方（和它的测试）行为不变。
   */
  const secOf = (v, dflt) => {
    const n = Number(typeof v === 'function' ? v() : v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const waitMs = (isGroup) => secOf(isGroup && groupWaitSec != null ? groupWaitSec : waitSec, 1.5) * 1000;
  const maxMs = (isGroup) => secOf(isGroup && groupMaxSec != null ? groupMaxSec : maxSec, 6) * 1000;

  /**
   * 把这条会话攒着的消息交出去（合成一批）。
   *
   * `bypassBusy`：只有 `release()` 会传 true——那一轮已经结束了，busy 锁
   * 此刻还占着（锁的清除在 task 的 finally，比 release 稍晚），放行时必须
   * 跳过 busy 判断，否则攒批会被自己挡住、永远交不出去。
   */
  function flush(chatId, bypassBusy = false) {
    const b = pending.get(chatId);
    if (!b) return false;
    const items = b.items.slice();
    if (!items.length) {
      pending.delete(chatId);
      return false;
    }
    clearTimeout(b.waitTimer);
    clearTimeout(b.maxTimer);

    /** 她还在回上一条：不另开一轮。能插话就插话，否则继续攒着等 release */
    if (!bypassBusy && isBusy(chatId)) {
      /**
       * 只有私聊才插话（aurabot：`p.chat.kind === 'private'`）。
       * 群里一插话等于又刷一条，且多人 MixedSenders 语义乱——群里攒批等 release。
       */
      const kind = String(items[items.length - 1]?.chat?.kind ?? '');
      const privateChat = kind === 'c2c' || kind === 'dm';
      if (onSteer && privateChat) {
        /**
         * 先摘掉 pending 再试：steer 成功 = 这条已被当前轮接走；
         * 失败要原样放回去（连同期间新攒的），等这一轮结束再交。
         */
        pending.delete(chatId);
        Promise.resolve()
          .then(() => onSteer(chatId, batchOf(items)))
          .then((ok) => {
            if (!ok) restoreWaiting(chatId, items);
            else log(`${chatId.slice(0, 8)}：${items.length} 条消息已插进当前轮`);
          })
          .catch((e) => {
            log(`${chatId.slice(0, 8)}：插话失败，改攒着等这轮结束（${e?.message ?? e}）`);
            restoreWaiting(chatId, items);
          });
        return false;
      }
      /** 攒着等 release——不回「还在想」，这是这次要去掉的刷屏根源 */
      b.waiting = true;
      pending.set(chatId, b);
      return false;
    }

    pending.delete(chatId);
    markBusy(chatId);
    try {
      onFlush(chatId, batchOf(items));
      return true;
    } catch {
      /* 单批失败不能影响后面的消息：锁要退回，否则这一会话永远攒着 */
      if (trackBusy) clearBusy(chatId);
      return false;
    }
  }

  /**
   * steer 失败后把消息放回去，和这期间新来的合成一批。
   *
   * 正常路径：这一轮还在跑（busy 还在），设 `waiting=true` 等 release 放行。
   * 抢跑路径：steer 是异步的，`release()` 可能已经先跑完并清掉了 busy——
   *   那一刻 pending 已被摘走，release 扑空；等这里把消息放回去，已经没有
   *   下一次 release 会再来，守门狗也被 release 一起清了 → 消息永久卡死。
   *   所以放回后必须复查 busy：已经不在忙就自己 bypass 放行，别干等。
   */
  function restoreWaiting(chatId, items) {
    let b = pending.get(chatId);
    if (!b) {
      b = { items: [], waitTimer: null, maxTimer: null, firstAt: now(), notBefore: 0, waiting: false };
      pending.set(chatId, b);
    }
    b.items.unshift(...items);
    /** 这一轮已经结束（release 抢跑）：直接放行，不要再设 waiting 干等 */
    if (trackBusy && !isBusy(chatId)) {
      b.waiting = false;
      return flush(chatId, true);
    }
    b.waiting = true;
    /** 不再设定时器：这一轮结束会 release；重复设反而会在忙时反复空转 */
    clearTimeout(b.waitTimer);
    clearTimeout(b.maxTimer);
    b.waitTimer = null;
    b.maxTimer = null;
    return false;
  }

  return {
    /**
     * 放一条进窗口。
     *
     * @param {object} evt roost 的 message 事件 data
     * @param {{force?:boolean, delayMs?:number}} [o]
     *   force   空闲时立刻放行（私聊 / 被 @ / 命令）；**忙时照样攒批**——
     *           这是「一次刷一屏还在想」的根因：被 @ 的几条都 force，
     *           以前各自 onFlush → 各自入队 → 队列满逐条回话
     *   delayMs 冷却期内攒着：压到冷却结束再一起交出去，**不是丢掉**
     */
    add(evt, { force = false, delayMs = 0 } = {}) {
      const chatId = String(evt?.chat?.chatId ?? '');
      if (!chatId) return;

      const kind = String(evt?.chat?.kind ?? '');
      const isGroup = kind !== 'c2c' && kind !== 'dm';

      let b = pending.get(chatId);
      if (!b) {
        b = { items: [], waitTimer: null, maxTimer: null, firstAt: now(), notBefore: 0, waiting: false };
        pending.set(chatId, b);
      }
      b.items.push(evt);

      /**
       * 已经在等这一轮结束的攒批：只往里加消息，不重设窗口。
       * 窗口定时器早就在第一次撞上 busy 时清掉了，重设反而会在忙时
       * 反复触发 flush → 反复看见 busy，纯空转。
       */
      if (b.waiting) return;

      /**
       * force（私聊 / 被 @ / 命令）：**无论忙闲都走 flush**——
       *   · 空闲 → 立刻放行，保持被 @ 的即时性；顺便 markBusy，
       *     紧随其后的几条才会被判为忙、进入攒批（这是不刷屏的关键）
       *   · 忙 → flush 内部走 steer / waiting，不再逐条回「还在想」
       * 以前空闲分支直接 onFlush、不置忙，突发 @ 时每条都当第一条，
       * 各自入队把队列撑满——正是「一次发一堆还在想」的根因。
       */
      if (force) {
        flush(chatId);
        return;
      }

      /**
       * 冷却期攒着的消息：别早于 `notBefore` 放行。
       *
       * 比如冷却还剩 12 秒，这三句就等到 12 秒后再一起交出去——
       * 不是丢掉，也不是立刻回（立刻回等于冷却没生效）。
       */
      if (delayMs > 0) b.notBefore = Math.max(b.notBefore || 0, now() + delayMs);
      const untilNotBefore = Math.max(0, (b.notBefore || 0) - now());

      /** 每来一条重新计时：说到一半就别急着回 */
      clearTimeout(b.waitTimer);
      b.waitTimer = setTimeout(() => flush(chatId), Math.max(0, waitMs(isGroup), untilNotBefore));
      b.waitTimer.unref?.();
      /** 从第一条算的最长等待，只设一次（但也不能早于冷却结束） */
      if (!b.maxTimer) {
        const left = Math.max(0, maxMs(isGroup) - (now() - b.firstAt));
        b.maxTimer = setTimeout(() => flush(chatId), Math.max(left, untilNotBefore));
        b.maxTimer.unref?.();
      }
    },

    /**
     * 这一轮结束了——把期间攒着的消息合成一批交出去。
     * host 在 `handleTurn` 的 finally 里调它（aurabot 的 `release()`）。
     * 没有攒批就是空操作，多调无害。
     */
    release(chatId) {
      if (trackBusy) clearBusy(chatId);
      const b = pending.get(chatId);
      if (!b || !b.waiting) return false;
      b.waiting = false;
      return flush(chatId, true);
    },

    /** 卸载时用：**只清定时器，不触发发送**——插件都卸了，不该再往外说话 */
    dispose() {
      for (const [, b] of pending) {
        clearTimeout(b.waitTimer);
        clearTimeout(b.maxTimer);
      }
      pending.clear();
      for (const [, e] of busy) if (e.timer) clearTimeout(e.timer);
      busy.clear();
    },

    /** 正在攒的会话数，面板/测试用 */
    get size() {
      return pending.size;
    },
  };
}
