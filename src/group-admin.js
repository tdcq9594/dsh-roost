/**
 * 群管（面板半边）
 * ================
 *
 * 协议侧是 bot 的 `group.info` / `group.mute` / `group.kick` / `group.join`
 * （scope 是 `message`，装了就能用，不需要开 `host.allowManage` 总闸）。
 *
 * 这一层只做三件事，别在这里重写业务：
 *   1. **收窄参数**：面板传来的是字符串和手填的数字，脏数据不往下丢；
 *   2. **翻译结果**：协议已经给了 `reason`（need_invite / not_admin / rate_limited…），
 *      原样带出去，面板据此给不同指引——混成一句「失败」等于没报错；
 *   3. **留痕**：每次写操作落审计，并按天计数（防手滑、防被拿去刷）。
 *
 * 为什么日上限放内存：面板操作是人在点，一天几十次；重启清零的代价远小于
 * 为此再维护一个落盘文件。真需要跨重启记账时，把它并进 `quota` 那一套。
 */

/** 官方硬限，和协议侧保持一致；这里是双保险，别只靠一边 */
export const MAX_MUTE_SEC = 30 * 24 * 3600;
export const MAX_BATCH = 20;

/** 每天每种动作的上限。改这里就是改全局面板口径 */
export const DAILY_LIMITS = Object.freeze({ mute: 50, kick: 10, join: 100 });

const REASON_TEXT = Object.freeze({
  need_invite: '踢人/成员列表要「群管内邀」白名单，去开放平台申请；禁言不需要',
  not_admin: '机器人得先是这个群的管理员（群设置 → 群机器人 → 管理员）',
  protected: '对方是群主或管理员，官方不允许动',
  rate_limited: '太频繁了，等一会儿再试',
  too_many: `一次最多 ${MAX_BATCH} 人`,
  too_long: '禁言最长 30 天',
  daily_limit: '今天这个动作的次数用完了（防手滑，明天再来）',
});

/** 面板文案：把 reason 摊成人话，认不出的原样返回 */
export const reasonText = (reason, fallback = '') => REASON_TEXT[reason] ?? fallback;

/** 目标 openid 归一化：去空、去重、保序；也接受单个字符串 */
export function normalizeTargets(v) {
  const src = Array.isArray(v) ? v : v ? [v] : [];
  const out = [];
  for (const x of src) {
    const s = String(x ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * @param {object} p
 * @param {(m:string,p?:object)=>Promise<any>} p.rpc  外接协议调用
 * @param {(e:object)=>void} [p.audit]                审计（失败不影响操作）
 * @param {(m:string)=>void} [p.log]
 * @param {()=>number} [p.now]                        注入时钟，测试用
 */
export function createGroupAdmin({ rpc, audit = () => {}, log = () => {}, now = () => Date.now() } = {}) {
  if (typeof rpc !== 'function') throw new Error('群管需要 rpc 函数');

  /** `${YYYY-MM-DD}:${action}` → 次数 */
  const used = new Map();
  const day = () => new Date(now()).toISOString().slice(0, 10);

  const usedOf = (action) => used.get(`${day()}:${action}`) ?? 0;
  const bump = (action) => {
    const k = `${day()}:${action}`;
    used.set(k, (used.get(k) ?? 0) + 1);
    // 只留今天的键，别让 Map 无限长
    for (const key of used.keys()) if (!key.startsWith(`${day()}:`)) used.delete(key);
  };

  const fail = (reason, extra = {}) => ({ ok: false, reason, message: reasonText(reason), ...extra });

  /**
   * 群状态。`group.info` 是 read scope：没内邀、不是管理员都能看到
   * 公开信息与「能不能管」，所以这一屏永远有内容，不会白。
   */
  async function info(groupId) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return { ok: false, reason: 'bad_params', message: '缺群号（groupId）' };
    try {
      const r = await rpc('group.info', { groupOpenid: gid });
      return { ok: true, ...(r ?? {}), used: { mute: usedOf('mute'), kick: usedOf('kick'), join: usedOf('join') } };
    } catch (e) {
      log(`群状态读不到：${e?.message ?? e}`);
      return { ok: false, reason: e?.code || 'unknown', message: String(e?.message ?? e) };
    }
  }

  /** 禁言 / 解禁。seconds=0 是解禁 */
  async function mute({ groupId, targets, seconds } = {}) {
    const gid = String(groupId ?? '').trim();
    const list = normalizeTargets(targets);
    if (!gid) return { ok: false, reason: 'bad_params', message: '缺群号（groupId）' };
    if (!list.length) return { ok: false, reason: 'bad_params', message: '先选一个要禁言的人' };
    if (list.length > MAX_BATCH) return fail('too_many');
    const sec = Math.max(0, Math.floor(Number(seconds) || 0));
    if (sec > MAX_MUTE_SEC) return fail('too_long');
    if (usedOf('mute') >= DAILY_LIMITS.mute) return fail('daily_limit');

    try {
      const r = await rpc('group.mute', { groupOpenid: gid, memberOpenids: list, seconds: sec });
      if (r?.ok === false) {
        audit({ op: 'group.mute', chatId: gid, note: `失败：${r.reason || 'unknown'}` });
        return fail(r.reason || 'unknown', { raw: r });
      }
      bump('mute');
      audit({ op: 'group.mute', chatId: gid, note: `${sec ? `禁言 ${sec}s` : '解禁'} · ${list.length} 人` });
      return { ok: true, seconds: sec, targets: list };
    } catch (e) {
      log(`禁言失败：${e?.message ?? e}`);
      return { ok: false, reason: e?.code || 'unknown', message: String(e?.message ?? e) };
    }
  }

  /** 踢人（需要群管内邀）。`addToBlacklist` 勾了才拉黑 */
  async function kick({ groupId, targets, addToBlacklist = false } = {}) {
    const gid = String(groupId ?? '').trim();
    const list = normalizeTargets(targets);
    if (!gid) return { ok: false, reason: 'bad_params', message: '缺群号（groupId）' };
    if (!list.length) return { ok: false, reason: 'bad_params', message: '先选一个要踢的人' };
    if (list.length > MAX_BATCH) return fail('too_many');
    if (usedOf('kick') >= DAILY_LIMITS.kick) return fail('daily_limit');

    try {
      const r = await rpc('group.kick', {
        groupOpenid: gid,
        memberOpenids: list,
        addToBlacklist: addToBlacklist === true,
      });
      if (r?.ok === false) {
        audit({ op: 'group.kick', chatId: gid, note: `失败：${r.reason || 'unknown'}` });
        return fail(r.reason || 'unknown', { raw: r });
      }
      bump('kick');
      audit({ op: 'group.kick', chatId: gid, note: `${list.length} 人${addToBlacklist ? '（并拉黑）' : ''}` });
      return { ok: true, targets: list };
    } catch (e) {
      log(`踢人失败：${e?.message ?? e}`);
      return { ok: false, reason: e?.code || 'unknown', message: String(e?.message ?? e) };
    }
  }

  /**
   * 入群申请：`action` 只有 list / approve / decline。
   * list 不计次数（只读），审批才算。
   */
  async function join({ groupId, action = 'list', memberOpenid = '', joinRequestId = '', reason = '', addToBlacklist = false } = {}) {
    const gid = String(groupId ?? '').trim();
    if (!gid) return { ok: false, reason: 'bad_params', message: '缺群号（groupId）' };
    const act = action === 'approve' || action === 'decline' ? action : 'list';
    if (act === 'list') {
      try {
        const r = await rpc('group.join', { groupOpenid: gid, action: 'list' });
        return { ok: true, ...(r ?? {}) };
      } catch (e) {
        log(`读入群申请失败：${e?.message ?? e}`);
        return { ok: false, reason: e?.code || 'unknown', message: String(e?.message ?? e) };
      }
    }
    const who = String(memberOpenid ?? '').trim();
    const rid = String(joinRequestId ?? '').trim();
    if (!who || !rid) return { ok: false, reason: 'bad_params', message: '要通过或拒绝，得先选中一条申请' };
    if (usedOf('join') >= DAILY_LIMITS.join) return fail('daily_limit');

    try {
      const r = await rpc('group.join', {
        groupOpenid: gid,
        action: act,
        memberOpenid: who,
        joinRequestId: rid,
        reason: String(reason ?? ''),
        addToBlacklist: addToBlacklist === true,
      });
      if (r?.ok === false) {
        audit({ op: 'group.join', chatId: gid, note: `${act} 失败：${r.reason || 'unknown'}` });
        return fail(r.reason || 'unknown', { raw: r });
      }
      bump('join');
      audit({ op: 'group.join', chatId: gid, peerId: who, note: act === 'approve' ? '通过入群申请' : '拒绝入群申请' });
      return { ok: true, action: act, memberOpenid: who };
    } catch (e) {
      log(`审批失败：${e?.message ?? e}`);
      return { ok: false, reason: e?.code || 'unknown', message: String(e?.message ?? e) };
    }
  }

  return { info, mute, kick, join, usedOf, dailyLimits: DAILY_LIMITS };
}
