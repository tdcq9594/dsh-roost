/**
 * 同会话排队
 * ==========
 *
 * 为什么需要：`turn.js` 的锁是**会话级**的，上一轮没跑完时新消息撞上去会抛
 * `busy`，宿主回一句「上一条还在想」——那条消息就再也没有第二次机会。
 * 群里更糟：一个群共用一个 DSH 会话，别人说话也会被踢。
 *
 * 这个模块只做一件事：**同一个会话一次只跑一个任务，后来的排队**。
 *
 * ## 为什么 key 要「钉住」
 *
 * 直觉写法是每次 `push` 时现算 key：`sessions.get(chatId) || chatId`。
 * 但 `agentFor()` 里 `sessions.set` 发生在 `resolveAgent` **之前**，于是：
 *
 *   msg1 → 还没会话，key = chatId，开跑，agentFor 里 set 了 sid1
 *   msg2 → 现在有 sid1 了，key = sid1 → 另一条空队列 → 立刻开跑 → 撞锁
 *
 * 新群/新私聊的**第一波消息**恰恰是最容易连发的时刻，现算等于没修。
 * 所以：一个 chatId 第一次 push 时算一次 key 并记住，队列彻底空了才忘掉。
 *
 * ## 纯逻辑
 *
 * 不 import 任何东西、不碰 fs / ctx / 时钟（`now` 可注入），所以能单测。
 * `task` 约定自己吞异常——队列永远不 reject，出错只记日志，
 * 排队层不该变成新的错误来源。
 */

/**
 * @param {object} o
 * @param {number} [o.maxPending]      每个会话最多排几条（0 = 不排队，直接跑）
 * @param {number} [o.minBudgetMs]     出队时剩余预算低于这个就不跑了
 * @param {number} [o.capMs]           单个任务最长多久，超了强放槽位
 * @param {() => number} [o.now]       时钟（测试注入假时钟）
 * @param {(chatId:string) => string} [o.resolveKey] 首次 push 时怎么解析 key
 * @param {boolean} [o.unref]         看门狗定时器要不要 `unref`（生产要，测试不要）
 * @param {(msg:string) => void} [o.log]
 */
export function createTurnQueue({
  maxPending = 2,
  minBudgetMs = 30_000,
  capMs = 210_000,
  now = () => Date.now(),
  resolveKey = (chatId) => chatId,
  unref = true,
  log = () => {},
} = {}) {
  /** chatId → key。**钉住表**：队列彻底空了才删 */
  const pinned = new Map();
  /** key → { chatId, running, pending[] } */
  const lanes = new Map();
  const timers = new Set();
  let disposed = false;

  /**
   * 配置项允许传函数。
   *
   * 面板改完 `queueMax` 立刻生效，不用重启插件——`cfg` 在 host 里是 `let`，
   * 会被 `patchConfig` 整体换掉，传值等于把旧对象焊死在闭包里。
   */
  const val = (v, fallback) => {
    const n = Number(typeof v === 'function' ? v() : v);
    /**
     * 不能用 `|| fallback`：`maxPending: 0` 是「关掉排队」的**合法值**，
     * 会被 `||` 吃成默认 2。只在非有限数时才兜底。
     */
    return Number.isFinite(n) ? n : fallback;
  };

  function keyOf(chatId) {
    let k = pinned.get(chatId);
    if (!k) {
      k = String(resolveKey(chatId) || chatId);
      pinned.set(chatId, k);
    }
    return k;
  }

  function laneOf(chatId) {
    const key = keyOf(chatId);
    let lane = lanes.get(key);
    if (!lane) {
      lane = { chatId, key, running: null, pending: [] };
      lanes.set(key, lane);
    }
    return lane;
  }

  function settle(item, result) {
    try {
      item.resolve?.(result);
    } catch {}
  }

  function start(lane, item) {
    lane.running = item;
    item.startedAt = now();

    /**
     * 看门狗：串行化之后「一条卡住」会拖死整个群，所以必须有兜底。
     * `turns.run` 自己有 150 秒超时，这条防的是它之前的前段
     * （agentFor / 检索 / followup 卡在 DSH 里不返回）。
     */
    const timer = setTimeout(() => {
      if (lane.running !== item) return;
      log(`排队：${item.label || lane.chatId} 超时 ${capMs}ms，强放槽位`);
      lane.running = null;
      settle(item, { ok: false, reason: 'timeout' });
      drain(lane);
    }, Math.max(1, val(capMs, 210_000)));
    /**
     * 生产环境必须 `unref`：不能因为一个排队任务让进程退不出去。
     * 但**测试里要关掉**——没有别的活任务时，unref 的定时器不会触发，
     * 看门狗那条用例会永远等下去（node:test 报「event loop has already resolved」）。
     */
    if (unref) timer.unref?.();
    timers.add(timer);

    Promise.resolve()
      .then(() => item.task())
      .catch((e) => log(`排队：任务抛错（已吞掉）${e?.message ?? e}`))
      .finally(() => {
        clearTimeout(timer);
        timers.delete(timer);
        /** 看门狗已经释放过就不再重复释放 */
        if (lane.running !== item) return;
        lane.running = null;
        settle(item, { ok: true });
        drain(lane);
      });
  }

  function drain(lane) {
    while (lane.pending.length) {
      const next = lane.pending.shift();
      if (disposed) {
        settle(next, { ok: false, reason: 'disposed' });
        continue;
      }
      /** 出队时再查一次预算：排队期间可能已经过窗口了 */
      const left = next.deadline ? next.deadline - now() : Infinity;
      if (left < val(minBudgetMs, 30_000)) {
        log(`排队：${next.label || lane.chatId} 剩余 ${Math.max(0, left)}ms 不够，丢弃`);
        settle(next, { ok: false, reason: 'expired' });
        continue;
      }
      start(lane, next);
      return;
    }
    /**
     * 队列彻底空了才解除钉住——`running` 也在判据里。
     * 只看 `pending` 会在「任务返回了但尾巴还没跑完」时提前解锁，
     * 新任务立刻起跑，尾段（postReply / 记日记）就和它重叠了。
     */
    if (!lane.running) {
      lanes.delete(lane.key);
      pinned.delete(lane.chatId);
    }
  }

  return {
    /**
     * @param {string} chatId
     * @param {() => Promise<any>} task 约定自己吞异常
     * @param {{deadline?: number, label?: string}} [opts]
     * @returns {{accepted:boolean, queued?:boolean, promise?:Promise, reason?:string}}
     */
    push(chatId, task, { deadline = 0, label = '' } = {}) {
      if (disposed) return { accepted: false, reason: 'disposed' };
      if (typeof task !== 'function') return { accepted: false, reason: 'bad-task' };

      const lane = laneOf(chatId);
      const item = { task, deadline, label, chatId, resolve: null };

      /** `maxPending = 0` 表示关掉排队：和以前一样直接跑，不等 */
      if (!lane.running) {
        const promise = new Promise((r) => {
          item.resolve = r;
        });
        start(lane, item);
        return { accepted: true, queued: false, promise };
      }

      const cap = val(maxPending, 2);
      const budget = val(minBudgetMs, 30_000);
      if (!Number.isFinite(cap) || cap <= 0) return { accepted: false, reason: 'full' };
      if (lane.pending.length >= cap) return { accepted: false, reason: 'full' };
      if (deadline && deadline - now() < budget) return { accepted: false, reason: 'expired' };

      const promise = new Promise((r) => {
        item.resolve = r;
      });
      lane.pending.push(item);
      return { accepted: true, queued: true, promise };
    },

    /** 主动搭话/觉醒用：这个会话有没有任务在跑（不含排队） */
    isBusy(chatId) {
      const lane = lanes.get(pinned.get(chatId) ?? String(resolveKey(chatId) || chatId));
      return Boolean(lane?.running);
    },

    stats() {
      let busy = 0;
      let pending = 0;
      for (const lane of lanes.values()) {
        if (lane.running) busy += 1;
        pending += lane.pending.length;
      }
      return { busy, pending, lanes: lanes.size };
    },

    dispose() {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const lane of lanes.values()) {
        for (const it of lane.pending) settle(it, { ok: false, reason: 'disposed' });
        lane.pending.length = 0;
      }
      lanes.clear();
      pinned.clear();
    },
  };
}
