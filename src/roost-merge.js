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
 */
export function textOf(evt) {
  const said = String(evt?.content ?? '').trim();
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
 * @param {object} o
 * @param {number} [o.waitSec]
 * @param {number} [o.maxSec]
 * @param {(chatId:string, batch:object)=>void} o.onFlush
 * @param {()=>number} [o.now]
 */
export function createMerger({ waitSec = 1.5, maxSec = 6, onFlush = () => {}, now = () => Date.now() } = {}) {
  /** chatId → { items, waitTimer, maxTimer, firstAt } */
  const pending = new Map();

  function flush(chatId) {
    const b = pending.get(chatId);
    if (!b) return;
    pending.delete(chatId);
    clearTimeout(b.waitTimer);
    clearTimeout(b.maxTimer);
    const items = b.items.slice();
    if (!items.length) return;
    try {
      onFlush(chatId, batchOf(items));
    } catch {
      /* 单批失败不能影响后面的消息 */
    }
  }

  return {
    /**
     * 放一条进窗口。
     *
     * @param {object} evt roost 的 message 事件 data
     * @param {{force?:boolean, delayMs?:number}} [o]
     *   force   立刻放行（私聊 / 被 @ / 命令）
     *   delayMs 冷却期内攒着：压到冷却结束再一起交出去，**不是丢掉**
     */
    add(evt, { force = false, delayMs = 0 } = {}) {
      const chatId = String(evt?.chat?.chatId ?? '');
      if (!chatId) return;

      /** 冷却期攒着的消息不该在这里处理（那是策略层的事），但 force 要立刻走 */
      if (force) {
        const held = pending.get(chatId);
        if (held) {
          /** 把已经攒着的和这条一起交出去：拆成两轮等于白白多花一次模型调用 */
          clearTimeout(held.waitTimer);
          clearTimeout(held.maxTimer);
          pending.delete(chatId);
          held.items.push(evt);
          onFlush(chatId, batchOf(held.items));
          return;
        }
        onFlush(chatId, batchOf([evt]));
        return;
      }

      let b = pending.get(chatId);
      if (!b) {
        b = { items: [], waitTimer: null, maxTimer: null, firstAt: now(), notBefore: 0 };
        pending.set(chatId, b);
      }
      b.items.push(evt);

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
      b.waitTimer = setTimeout(() => flush(chatId), Math.max(0, waitSec * 1000, untilNotBefore));
      b.waitTimer.unref?.();
      /** 从第一条算的最长等待，只设一次（但也不能早于冷却结束） */
      if (!b.maxTimer) {
        const left = Math.max(0, maxSec * 1000 - (now() - b.firstAt));
        b.maxTimer = setTimeout(() => flush(chatId), Math.max(left, untilNotBefore));
        b.maxTimer.unref?.();
      }
    },

    /** 卸载时用：**只清定时器，不触发发送**——插件都卸了，不该再往外说话 */
    dispose() {
      for (const [, b] of pending) {
        clearTimeout(b.waitTimer);
        clearTimeout(b.maxTimer);
      }
      pending.clear();
    },

    /** 正在攒的会话数，面板/测试用 */
    get size() {
      return pending.size;
    },
  };
}
