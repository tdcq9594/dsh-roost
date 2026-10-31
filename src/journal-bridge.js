/**
 * 写日记
 * ======
 *
 * 从 `host.js` 拆出来的第二个域（阶段 8）。负责把「这一轮说了什么」变成一条
 * 日记，带出处（eventIds + 原文快照）。
 *
 * 依赖从参数进来：`journal`（落盘）、`memoryOff`（这个会话关没关记忆）、`log`。
 * 这样能用假 journal 验证「记了什么、什么时候不记」，不用把整个宿主拉起来。
 */

/**
 * @param {{journal:object, memoryOff:(chatId:string)=>boolean, log:object}} deps
 */
export function createJournalBridge({ journal, memoryOff, log }) {
  function add(payload, chat, text, role) {
    if (memoryOff(chat?.chatId)) return;
    try {
      const base = String(payload?.id ?? '').trim();
      /**
       * 这一轮对应事件账本里的哪几条（场景片段，阶段 4）。
       *
       * 合并窗口攒过几句时是多条——一批消息合成一轮对话，出处也该是这一批。
       * 没开事件账本时这个数组是空的，日记照写，只是以后查不回原文。
       */
      const eventIds = (Array.isArray(payload?.eventIds) ? payload.eventIds : [])
        .map(String)
        .filter(Boolean);
      journal.add({
        // 没有 msg_id 时给空串，journal 内部会生成随机 id（宁可重复也不丢）
        id: base ? `${base}${role === 'bot' ? ':bot' : ''}` : '',
        at: Date.now(),
        chatId: chat.chatId,
        sender: role === 'bot' ? '' : String(payload?.sender?.name ?? '').trim(),
        role,
        text,
        eventIds,
        /**
         * 原文快照。**存的是整段，不是逐条**——合并批的正文已经被拼成一段，
         * 拆不回原来那几条。快照的用途是「events 7 天后删了还能看到当时说了什么」，
         * 整段正好满足；要逐条回看原文，用 `eventIds` 调 `/r/context`。
         */
        evidence: eventIds.length
          ? [{
              eventId: eventIds[eventIds.length - 1],
              at: Date.now(),
              sender: role === 'bot' ? 'bot' : String(payload?.sender?.name ?? '').trim(),
              excerpt: String(text ?? '').slice(0, 200),
            }]
          : [],
      });
    } catch (e) {
      log.warn(`日记没写进去（不影响这轮）：${e.message}`);
    }
  }

  return { add };
}
