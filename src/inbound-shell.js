/**
 * 入站薄壳
 * ========
 *
 * `host.js` 的 `onInbound` 原本一口气干完：算会话、跑一轮、出错兜底回话。
 * 排队要在它外面加一层，而那一层**只需要三件事**：算 deadline、入队、按结果回话。
 *
 * 抽成这个文件是为了能单测——`onInbound` 是 `apply()` 里的闭包，
 * 而且真要跑一轮还得造一个活的 DSH agent，成本比这层逻辑本身高得多。
 *
 * ## 三条不能动的规矩
 *
 * 1. **入队不吭声**。大部分排队几秒就轮到，发「排队中」是纯噪音。
 * 2. **队列满 / 预算不够要说话**，但**不能伪造 `busy` 异常**——
 *    抛异常会走 `handleTurn` 的 catch，把「排满了」记成「这一轮失败了」，
 *    事后看数据分不清是模型挂了还是只是排队。
 * 3. **预算从 ai-chat 的 `expiresAt` 起算**。它比「入站那一刻 + 180s」更保守
 *    （payload 是在合并窗口之后才建的，晚 1.5–6 秒），方向是对的。
 */

/**
 * @param {object} o
 * @param {object} o.q             `createTurnQueue` 的实例
 * @param {(payload:any)=>Promise<void>} o.handleTurn  真正干活的那一轮（自己吞异常）
 * @param {(payload:any, text:string, done:boolean)=>Promise<any>} o.postReply
 * @param {(payload:any)=>string} o.chatOf  从 payload 取 chatId（同步）
 * @param {() => number} [o.now]
 * @param {(msg:string)=>void} [o.log]
 */
export function createInboundShell({
  q,
  handleTurn,
  postReply,
  chatOf,
  now = () => Date.now(),
  log = () => {},
}) {
  /** 队列满：确实是堆着了，这句话才诚实 */
  const BUSY_TEXT = '上一条还在想，稍等一下。';
  /** 过窗口：明说没赶上，比沉默强——用户知道不是没听见 */
  const EXPIRED_TEXT = '这条等太久了没赶上，再说一次？';

  return {
    onInbound(payload) {
      const chatId = String(chatOf(payload) || '').trim();
      if (!chatId) return;

      /**
       * 截止时间：优先用 ai-chat 给的回话窗口（`reply.expiresAt`），
       * 缺省（老版本插件 / webhook 适配器）按 180 秒兜底。
       */
      const expiresAt = Number(payload?.reply?.expiresAt);
      const deadline = Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : now() + 180_000;

      const r = q.push(chatId, () => handleTurn(payload), { deadline, label: chatId });
      if (r.accepted) {
        /** `handleTurn` 约定自己吞异常；这里再兜一次，避免 unhandled rejection */
        r.promise?.catch?.((e) => log(`排队任务异常（已吞）：${e?.message ?? e}`));
        return;
      }

      const text = r.reason === 'expired' ? EXPIRED_TEXT : BUSY_TEXT;
      log(`排队：${chatId.slice(0, 8)} 未入队（${r.reason}），回了「${text}」`);
      Promise.resolve()
        .then(() => postReply(payload, text, true))
        .catch((e) => log(`排队回话失败：${e?.message ?? e}`));
    },
  };
}
