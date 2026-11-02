/**
 * 会话标题：名字拿不到时用「群/私聊 + id 尾号」，**不要把 openid 原样摆出来**。
 *
 * 群名不在官方事件里，ai-chat 以前又用发送者昵称兜底，结果群标题变成「我的昵称」；
 * 私聊没有昵称就退成 openid。两头都看不出是哪个会话。
 *
 * 抽成独立模块的理由：这段逻辑原来埋在 host.js 的闭包里，**没法单测**——
 * 上一轮修了「不降级」「不抖」几个边界，测试全绿，因为根本没有测试碰它。
 */

/**
 * 主动搭话 / 自测的哨兵名不是真会话名，不能拿来当标题。
 *
 * 注意**不要**把「巩固」加进来：那是记忆巩固的后台会话，标题就叫「QQ · 巩固」，
 * 用户一眼知道它是什么，比「QQ · 私聊 olidate」好得多。
 */
export const SENTINEL_NAMES = new Set(['主动搭话', '自测']);

/** 压缩换会话的标记，不是名字的一部分 */
export const CONTINUED_SUFFIX = '（续）';

/**
 * 给标题补上「（续）」。
 *
 * 不能直接拼：群名本身就可能以「（续）」结尾（有人真会这么起名），
 * 再拼一次会变成「（续）（续）」，而且下一条消息会一直判成「要改名」。
 */
export function withContinued(title) {
  const t = String(title || '');
  return t.endsWith(CONTINUED_SUFFIX) ? t : t + CONTINUED_SUFFIX;
}

export const isPlaceholderTitle = (t) => /^QQ · (群|私聊) [0-9A-Za-z]{6}$/.test(String(t));

export const isSentinelTitle = (t) => {
  const s = String(t);
  for (const n of SENTINEL_NAMES) if (s === `QQ · ${n}`) return true;
  return false;
};

/** 过滤掉哨兵名后的真实名字（空串表示没有） */
export function realChatName(chat) {
  const raw = String(chat?.name ?? '').trim();
  return SENTINEL_NAMES.has(raw) ? '' : raw;
}

export function sessionTitle(chat) {
  const name = realChatName(chat);
  if (name) return `QQ · ${name}`;
  return `QQ · ${chat?.kind === 'c2c' ? '私聊' : '群'} ${String(chat?.chatId || '').slice(-6)}`;
}

/**
 * 这一轮该不该改标题，以及改成什么。
 *
 * 只在「名字确实更好」时改，别把已有好名字降级成占位符：
 *   · 有真名字 → 改；
 *   · 旧标题是 openid / 占位符 / 哨兵 / 旧版裸昵称 → 改；
 *   · 旧标题是「QQ · 真群名」而这次没拿到名字 → 不动。
 *
 * 「旧版裸昵称」（`QQ · 张三`）而这次仍没拿到名字时**故意不改**：
 * DSH 里用户可以手动重命名会话，我们分不出「旧版遗留」和「用户自己起的名字」，
 * 强行改会覆盖用户的操作。等真名字来了再修。
 *
 * 同理，`!old.startsWith('QQ · ')` 这条会把用户手改成「工作群」的标题也改回占位符——
 * 这是已知限制：那条规则原本是为了把 DSH 自动生成的标题统一成 `QQ · 名字`，
 * 代价是分不出「自动生成」和「用户手改」。改不动的部分认了，别再往上加规则。
 *
 * @param {{chatId?:string, name?:string, kind?:string}} chat
 * @param {string} oldTitle 会话映射里记的上一个标题
 * @returns {{want:string, rename:boolean}} rename=false 时 want 就是 oldTitle（调用方不用再看 rename）
 */
export function nextTitle(chat, oldTitle) {
  const old = String(oldTitle || '');
  const continued = old.endsWith(CONTINUED_SUFFIX);
  const oldBase = continued ? old.slice(0, -CONTINUED_SUFFIX.length) : old;
  const wantBase = sessionTitle(chat);
  /** 压缩换会话的「（续）」是标记：改名时要跟着走，但不能叠两层 */
  const want = continued ? withContinued(wantBase) : wantBase;

  const chatId = String(chat?.chatId || '');
  /**
   * 判 `old !== want`（最终要写进去的字符串），不是 `oldBase !== wantBase`：
   * 后者在「群名本身以（续）结尾」时永远不相等，会导致每条消息都 rename 一次。
   */
  const rename = old !== want && (
    Boolean(realChatName(chat))
    || !old
    /** chatId 为空时 `includes('')` 恒真，会白白判成「旧标题含 openid」 */
    || (chatId ? old.includes(chatId) : false)
    || isPlaceholderTitle(old)
    /** 判 base：`QQ · 主动搭话（续）` 也要认出来 */
    || isSentinelTitle(oldBase)
    || !old.startsWith('QQ · ')
  );
  /** 不改就把旧值原样返回，免得调用方不看 rename 直接拿 want 写坏 */
  return { want: rename ? want : old, rename };
}
