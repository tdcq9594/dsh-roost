/**
 * 入站消息去重：同一条消息只处理一次。
 *
 * ## 为什么需要
 *
 * QQ 官方明说「相同 msg_id 可能重复推送」。框架账本用 dedupe 唯一约束接住了
 * 它，但协议层历史上会在去重之前广播（2026-11-26 之前），所以 dsh-roost 可能
 * 连续收到同一份消息 2~4 次。攒批窗口把它们拼成一段，模型一次看到
 * 「你是谁」三遍，还以为对方复读了。
 *
 * 框架侧修好之后，这里仍是**纵深防御**：
 *   · 用户跑的是旧框架，拿不到 duplicate 标记；
 *   · 宿主开了多条事件连接（WS + SSE / 多 profile），一帧会被投递多份；
 *   · 断线补拉与实时推送叠在一起。
 *
 * ## 键怎么选
 *
 * `eventId` 优先——它是框架账本主键，重推时还是同一个（`append()` 撞 dedupe
 * 会返回已有那条的 id）。没有账本时退回 `chatId + msgId`：msgId 是 QQ 官方
 * 消息 id，重推同样不变。
 *
 * **不用正文指纹**：同一个人隔几秒再说一句「在吗」是两个真实事件，
 * 按内容去重会把第二句吞掉。宁可漏判重复，也不能吞真消息。
 *
 * ## 为什么是纯工厂
 *
 * `host.js` 的闭包拉不起单测；这里不碰 fs / ctx / 全局时钟，`now` 可注入，
 * 能直接钉住 TTL、上限、无键三种边界。
 *
 * @param {object} [o]
 * @param {number} [o.ttlMs] 同一键多久内算重复（默认 10 分钟，覆盖官方重推与重连补拉）
 * @param {number} [o.max]   最多记多少个键（防长跑进程无限涨）
 * @param {() => number} [o.now]
 */
export function createInboundDedupe({ ttlMs = 10 * 60_000, max = 500, now = () => Date.now() } = {}) {
  /** key → 首次见到的时间。Map 按插入序，过期清理可以从头 break */
  const seen = new Map();
  const ttl = Math.max(0, Number(ttlMs) || 0);
  const cap = Math.max(1, Number(max) || 1);

  /**
   * 这条消息的稳定标识。两个都拿不到就返回空串——**空串不做去重**：
   * 拿一个假键去比对，会把后面所有同样「没有 id」的消息全吞掉。
   */
  function keyOf(evt) {
    const eventId = String(evt?.eventId ?? '').trim();
    if (eventId) return `e:${eventId}`;
    const msgId = String(evt?.msgId ?? '').trim();
    if (msgId) return `m:${String(evt?.chat?.chatId ?? '')}:${msgId}`;
    return '';
  }

  /** 先按 TTL 从头清（插入有序），再按上限淘汰最旧 */
  function prune(t) {
    for (const [k, at] of seen) {
      if (t - at < ttl) break;
      seen.delete(k);
    }
    while (seen.size > cap) seen.delete(seen.keys().next().value);
  }

  return {
    keyOf,

    /**
     * @param {object} evt 宿主协议的 message 事件
     * @returns {boolean} true = 这个窗口内已经见过，别再处理
     */
    isDuplicate(evt) {
      const key = keyOf(evt);
      if (!key) return false;
      const t = now();
      const at = seen.get(key);
      if (at !== undefined && t - at < ttl) return true;
      /** 过期后重新计时：把键移到队尾，后面的 prune 才能按时间 break */
      seen.delete(key);
      seen.set(key, t);
      prune(t);
      return false;
    },

    get size() {
      return seen.size;
    },

    clear() {
      seen.clear();
    },
  };
}
