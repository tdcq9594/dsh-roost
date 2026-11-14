/**
 * 面板「选一个群」的候选合并。
 *
 * 为什么要有这一步：QQ 官方只给群 openid（32 位），人根本记不住，让用户
 * 手填等于逼他去日志里抄。所以候选来自两处：
 *
 *   1. 已配置的群（「群聊 → 唤醒」里加过的，可能带名字）；
 *   2. 框架里**收到过消息的群**（identity 接口的 `unresolved.groups`，
 *      名字是从群消息里学到的）。
 *
 * 规则：已配置的优先、顺序保持（用户配过的排在前面），第二处只补缺；
 * 名字缺失时用第二处的补上——不覆盖已有名字，因为用户可能手动改过。
 *
 * @param {{chatId?: string, name?: string}[]} configured 已配置的群
 * @param {{openid?: string, name?: string}[]} seen 框架见过消息的群
 * @returns {{chatId: string, name: string, source: 'awake'|'seen'}[]}
 */
export function mergeGroupCandidates(configured, seen) {
  const out = [];
  const norm = (v) => String(v ?? '').trim();

  for (const g of Array.isArray(configured) ? configured : []) {
    const chatId = norm(g?.chatId);
    if (!chatId) continue;
    /** 同一个群配了两遍只留第一条 */
    if (out.some((x) => x.chatId === chatId)) continue;
    out.push({ chatId, name: norm(g?.name), source: 'awake' });
  }

  for (const g of Array.isArray(seen) ? seen : []) {
    const chatId = norm(g?.openid);
    if (!chatId) continue;
    const hit = out.find((x) => x.chatId === chatId);
    if (hit) {
      if (!hit.name) hit.name = norm(g?.name);
      continue;
    }
    out.push({ chatId, name: norm(g?.name), source: 'seen' });
  }

  return out;
}
