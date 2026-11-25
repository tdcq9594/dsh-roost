/**
 * 到期跟进 → 独立主动候选（阶段 5）。
 *
 * 为什么独立：现有 `memory.followUp` 只是往常规 prompt 里塞一段提示，
 * 依赖「有人说话才有回合」。这里把到期的事做成**独立候选**——即使没人开口，
 * 主动搭话也能拿它当理由。两者开关分开，互不影响（现有默认关，这个默认开）。
 *
 * 纯函数：输入 memory.dueFollowUps() 的行，输出候选数组，不碰存储、不投递。
 */

/**
 * @param {object[]} dueRows memory.dueFollowUps(chatId, aliases, {limit:0}) 的结果
 * @returns {{id:string, kind:string, chatId:string, text:string, question:string, dueAt:number, tries:number}[]}
 */
export function buildFollowUpCandidates(dueRows = []) {
  const rows = Array.isArray(dueRows) ? dueRows : [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const question = String(r?.question ?? '').trim();
    /** 没有 question 的不算「可问的事」——和 followUpSection 的口径一致 */
    if (!question) continue;
    const text = String(r?.text ?? '').trim();
    const chatId = String(r?.chatId || 'global');
    const id = `follow:${chatId}:${text.slice(0, 32)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: 'follow-up',
      /**
       * 会话与事实原文要带上：投递成功后运行时按它们回写 `markFollowUpAsked`
       * （tries + 1、重排下次）。只留 id 的话事实文本被截断到 32 字，回写对不上。
       */
      chatId,
      text,
      question,
      dueAt: Number(r?.at) || 0,
      tries: Math.max(0, Number(r?.tries) || 0),
    });
  }
  /** 最先到期（也最该问）的排前 */
  return out.sort((a, b) => a.dueAt - b.dueAt);
}
