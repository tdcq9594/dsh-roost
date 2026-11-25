import { saidOf } from './roost-decide.js';

/**
 * 「只旁听」的字段整形。
 *
 * 旁听不建会话、不过合并窗口、不调模型，只把这一条写进日记；但 journalAdd
 * 需要的字段和正常入站不同：它要 payload.id / eventIds / sender，chat.chatId /
 * aliases。把这些映射单独收在这里，host 里只负责调 journalAdd，测试也能直接
 * 盯住字段名（evt 是 openid，payload 是 sender.id，混了就会写空）。
 */
export function observeFieldsOf(evt) {
  /**
   * 正文和判定共用 `saidOf`：它认 `content`，也认附件里的语音转写（asrText）。
   * 只读 `content` 时，纯语音消息在旁听群里会被当成空消息漏记。
   */
  const text = saidOf(evt);
  const chatId = String(evt?.chat?.chatId ?? '');
  if (!chatId || !text) return null;
  return {
    text,
    chat: {
      chatId,
      kind: 'group',
      aliases: Array.isArray(evt?.chat?.groupAliases) ? evt.chat.groupAliases : [],
    },
    payload: {
      id: String(evt?.msgId || evt?.eventId || ''),
      eventIds: evt?.eventId ? [String(evt.eventId)] : [],
      sender: {
        id: String(evt?.sender?.openid ?? ''),
        name: String(evt?.sender?.name ?? ''),
        uin: String(evt?.sender?.uin ?? ''),
      },
    },
  };
}
