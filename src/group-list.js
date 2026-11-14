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
 * @param {{chatId?: string, name?: string, lastSeenAt?: number}[]} configured 已配置的群
 * @param {{openid?: string, name?: string, lastSeenAt?: number}[]} seen 框架见过消息的群
 * @returns {{chatId: string, name: string, source: 'awake'|'seen', lastSeenAt: number}[]}
 */
export function mergeGroupCandidates(configured, seen) {
  const out = [];
  const norm = (v) => String(v ?? '').trim();
  const at = (v) => Math.max(0, Number(v) || 0);

  for (const g of Array.isArray(configured) ? configured : []) {
    const chatId = norm(g?.chatId);
    if (!chatId) continue;
    /** 同一个群配了两遍只留第一条 */
    if (out.some((x) => x.chatId === chatId)) continue;
    out.push({ chatId, name: norm(g?.name), source: 'awake', lastSeenAt: at(g?.lastSeenAt) });
  }

  for (const g of Array.isArray(seen) ? seen : []) {
    const chatId = norm(g?.openid);
    if (!chatId) continue;
    const hit = out.find((x) => x.chatId === chatId);
    if (hit) {
      if (!hit.name) hit.name = norm(g?.name);
      /** 已配置的群本来没有活跃时间，从「见过消息」那边补上 */
      if (!hit.lastSeenAt) hit.lastSeenAt = at(g?.lastSeenAt);
      continue;
    }
    out.push({ chatId, name: norm(g?.name), source: 'seen', lastSeenAt: at(g?.lastSeenAt) });
  }

  return out;
}

/**
 * 从**宿主自己**的会话表里列「收到过消息的群」。
 *
 * ## 为什么必须有这一路
 *
 * 原来 `groups.list` 只问框架的 `/api/identity`，可它有两个硬前提：
 *   1. Roost 正在跑 —— 框架没开（比如只在 DSH 面板里调设置），接口直接连不上；
 *   2. 群没被绑定过 —— `unresolved.groups` 按定义**只列没绑过的**，用户正常
 *      用起来早把群绑了，这份清单反而是空的。
 *
 * 于是「推送到哪个群」下拉永远是空的，用户以为功能坏了。而 `sessions.json`
 * 是宿主每收到一条消息就写的，框架在不在线都在，且明确带 `kind: 'group'`
 * 和群名 —— 这才是「收到过消息的群」的真相。
 *
 * @param {{chatId?: string, kind?: string, title?: string, at?: number}[]} list `sessions.list()`
 * @param {(chatId: string) => {lastUserAt?: number}} groupStateOf `awake.groupState`
 * @returns {{openid: string, name: string, lastSeenAt: number}[]} 与框架 people.groups 同形态
 */
export function localGroupCandidates(list, groupStateOf = () => ({})) {
  const out = [];
  const at = (v) => Math.max(0, Number(v) || 0);

  for (const e of Array.isArray(list) ? list : []) {
    /** 私聊、以及早期没写 kind 的记录，一律不当群推 */
    if (String(e?.kind || '') !== 'group') continue;
    const openid = String(e?.chatId || '').trim();
    if (!openid) continue;
    /** title 是宿主加的 `QQ · xxx`，剥掉前缀更好认 */
    const name = String(e?.title || '').replace(/^QQ\s*[·:：-]\s*/i, '').trim();

    let lastUserAt = 0;
    try {
      lastUserAt = at(groupStateOf(openid)?.lastUserAt);
    } catch { /* 单个群查不到不影响别的 */ }
    /**
     * 没有觉醒记录（比如那个群从来没人发过言、只有系统消息）就退回会话
     * 建立时间：总比 0 强，至少能排在「完全没时间」的前面。
     */
    out.push({ openid, name, lastSeenAt: lastUserAt || at(e?.at) });
  }
  return out;
}

/**
 * 合并两路「见过消息的群」：本地会话表为主，框架 identity 补名字/时间。
 *
 * 本地先放，所以框架那份不会用空名字盖掉本地学到的群名；反过来本地
 * 没有活跃时间时，框架的 `lastActiveAt` 能补上。返回形态与
 * `people().groups` 一致（`openid`），可以直接喂给 `mergeGroupCandidates`。
 */
export function mergeSeenGroups(local, remote) {
  const out = [];
  const at = (v) => Math.max(0, Number(v) || 0);

  for (const g of [
    ...(Array.isArray(local) ? local : []),
    ...(Array.isArray(remote) ? remote : []),
  ]) {
    const openid = String(g?.openid || '').trim();
    if (!openid) continue;
    const hit = out.find((x) => x.openid === openid);
    if (hit) {
      if (!hit.name) hit.name = String(g?.name || '').trim();
      if (!hit.lastSeenAt) hit.lastSeenAt = at(g?.lastSeenAt);
      continue;
    }
    out.push({ openid, name: String(g?.name || '').trim(), lastSeenAt: at(g?.lastSeenAt) });
  }
  return out;
}
