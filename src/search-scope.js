/**
 * 「搜聊天记录」的权限收窄。
 *
 * 这个工具是模型能碰到的**唯一**历史消息入口，所以权限不能交给模型自觉，
 * 必须在工具里按「这一轮是谁在说话」把它钉死：
 *
 *   · 主人 / 管理员：可以按别人查（他们本来就能在面板里看全部）；
 *   · 其他人：**只能搜自己的消息**，但**允许跨会话**（主人 2026-11-16 定：
 *     「其他人也要可以跨会话」——限制的是「能不能看别人的话」，不是「能看几个群」）。
 *
 * 上下文（`around`）另有一条判据：非特权只能围绕**自己发的**那条消息看前后，
 * 因为前后文里必然夹着别人的话，围绕别人的消息看等于把别人的对话翻出来。
 *
 * 抽成纯函数是为了单测：这类判断写错不会报错，只会**静默多给一点**。
 */

/** 能看别人消息的档位。`owner` 是主人，`admin` 是管理员（群主/管理员或面板里指定） */
export const SEARCH_PRIVILEGED = ['owner', 'admin'];

/**
 * @param {{bucket?:string, senderId?:string, openid?:string, chatId?:string}} caller
 *        当前这一轮的调用方（`host.js` 的 `callerOf()`）
 * @returns {{privileged:boolean, selfOpenid:string, ignorePerson:boolean, canSeeOthers:boolean}}
 */
export function searchScopeOf(caller = {}) {
  const bucket = String(caller?.bucket || '');
  const privileged = SEARCH_PRIVILEGED.includes(bucket);
  const selfOpenid = String(caller?.senderId || caller?.openid || '');
  return {
    privileged,
    /** 非特权档强制按这个 openid 过滤；空串表示「拿不到身份，应该直接拒」 */
    selfOpenid: privileged ? '' : selfOpenid,
    /** 非特权档一律忽略 `person` 参数（否则就是「按昵称搜别人」的后门） */
    ignorePerson: !privileged,
    /**
     * 能不能看别人的消息。
     *
     * **不再锁会话**：跨会话本身不泄露「别人的话」，只泄露「这个群存在」——
     * 而群名/群存在对群里的人本来就不是秘密。真正的边界是「谁的消息」。
     */
    canSeeOthers: privileged,
  };
}

