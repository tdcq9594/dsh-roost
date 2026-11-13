/**
 * 群管工具（给模型用的那一层）
 * ============================
 *
 * 和面板共用 `src/group-admin.js`（参数收窄、原因翻译、审计、日上限都一样），
 * 差别只在**谁在调**：面板是主人亲手点，这里是模型自己在群里说话时决定用。
 *
 * 四条克制：
 *   1. `qq_group_info` 只读，谁都能问——她得能回答「我在这个群算不算管理员」。
 *   2. `qq_mute` / `qq_join_request` **只有主人**能用，且都是可逆动作。
 *   3. **踢人不给模型**。不可逆、错一次就是事故，面板里有人看着才做。
 *      模型真需要踢人时，让它说一句「这个得你去面板点一下」——比给它权限安全。
 *   4. `qq_group_brief`（2.2b / C5-1）**只在主人私聊里**能查，且目标只能是群。
 *      它读的是消息账本（全量入站，含没叫她的那些话），所以「主人不在群里
 *      也知道发生了什么」——正因如此，群里的回复是所有人看得见的，
 *      群里一律不给，连「主人在群里问」也不给，避免把别群的话当众说出来。
 *
 * 为什么不在这里做「QQ 里回确认」：那套流程是给不可逆动作准备的，
 * 现在模型手上没有不可逆动作，加一层确认只会让正常禁言变慢。
 */

/** 主人档：其余档位直接拒，不往下走 */
const OWNER_ONLY = '只有主人能让你做这个。别人问起就说不方便。';

export function buildGroupToolDefs({ groupOf, callerOf, ledgerOf = null, sessionOf = null, cfgOf = null }) {
  const caller = () => callerOf?.() || {};
  const admin = () => groupOf?.() || null;
  const isOwner = () => String(caller().bucket || '') === 'owner';
  /**
   * 目标群：只有**群聊**才拿当前会话兜底。
   * 私聊的 `chatId` 是用户的 openid，当成群号会打到完全不相干的地方，
   * 所以私聊必须显式给 `groupId`，否则一律拒。
   */
  const gidOf = (v) => {
    const explicit = String(v || '').trim();
    if (explicit) return explicit;
    const c = caller();
    return String(c.kind || '') === 'group' ? String(c.chatId || '').trim() : '';
  };

  const info = {
    name: 'qq_group_info',
    description:
      '查当前这个群的情况：群名、你在群里的角色（群主/管理员/普通成员）、'
      + '能不能管理（禁言/踢人需要你是管理员）、有没有开通「群管内邀」、群人数。'
      + '被问到「你能不能管这个群」「你是不是管理员」时用它，不要凭感觉答。',
    parameters: {
      groupId: { type: 'string', description: '群 openid；不填就是当前会话所在的群' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null) }],
    },
    async execute({ groupId } = {}) {
      const adm = admin();
      if (!adm) return { ok: false, message: '还没连上 Roost 框架，查不了' };
      const gid = gidOf(groupId);
      if (!gid) return { ok: false, message: '不知道是哪个群：这个会话不是群聊，也没给 groupId' };
      const r = await adm.info(gid);
      if (!r.ok) return { ok: false, message: r.message || '查不到这个群' };
      return {
        ok: true,
        groupId: gid,
        name: r.name || '',
        role: r.role || 'unknown',
        canManage: r.canManage === true,
        invited: r.invited === true,
        memberCount: r.memberCount || 0,
        note: r.canManage ? '你是管理员，能禁言/踢人' : (r.manageReason || '你不是管理员，只能看不能管'),
      };
    },
  };

  const mute = {
    name: 'qq_mute',
    description:
      '禁言或解禁群里的人（需要你是群管理员）。'
      + '`seconds` 是时长秒数，0 表示解禁；单个最多 30 天。'
      + '**只在主人明确要求时用**，别自己决定去禁言谁。'
      + '禁言对象要写对方的 openid（消息里带的那串），拿不准就问一句，不要猜。',
    parameters: {
      memberOpenids: { type: 'string', required: true, description: '要处理的 openid，多个用逗号分开（一次最多 20 人）' },
      seconds: { type: 'number', required: true, description: '禁言多少秒；0 = 解禁；上限 2592000（30 天）' },
      groupId: { type: 'string', description: '群 openid；不填就是当前群' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null) }],
    },
    async execute({ memberOpenids, seconds, groupId } = {}) {
      if (!isOwner()) return { ok: false, message: OWNER_ONLY };
      const adm = admin();
      if (!adm) return { ok: false, message: '还没连上 Roost 框架，做不了' };
      const gid = gidOf(groupId);
      if (!gid) return { ok: false, message: '不知道是哪个群：这个会话不是群聊，也没给 groupId' };
      const list = String(memberOpenids || '')
        .split(/[\s,，、;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await adm.mute({ groupId: gid, targets: list, seconds });
      if (!r.ok) return { ok: false, message: r.message || '没成功', reason: r.reason };
      const sec = Number(r.seconds) || 0;
      return {
        ok: true,
        note: sec ? `已禁言 ${r.targets.length} 人，${sec} 秒` : `已解禁 ${r.targets.length} 人`,
        seconds: sec,
        targets: r.targets,
      };
    },
  };

  const join = {
    name: 'qq_join_request',
    description:
      '看 / 审批入群申请（需要你是群管理员）。'
      + 'action=list 列出现有申请（含 memberOpenid 和 joinRequestId，审批时要用这两个）；'
      + 'action=approve 通过；action=decline 拒绝（可带理由）。'
      + '**只有主人能让你审批**；列出来给主人看是可以的。',
    parameters: {
      action: { type: 'string', enum: ['list', 'approve', 'decline'], description: '默认 list' },
      memberOpenid: { type: 'string', description: 'approve/decline 时必填' },
      joinRequestId: { type: 'string', description: 'approve/decline 时必填，list 里能看到' },
      reason: { type: 'string', description: '拒绝理由（可空）' },
      groupId: { type: 'string', description: '群 openid；不填就是当前群' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null) }],
    },
    async execute({ action = 'list', memberOpenid = '', joinRequestId = '', reason = '', groupId } = {}) {
      const act = action === 'approve' || action === 'decline' ? action : 'list';
      if (act !== 'list' && !isOwner()) return { ok: false, message: OWNER_ONLY };
      const adm = admin();
      if (!adm) return { ok: false, message: '还没连上 Roost 框架，做不了' };
      const gid = gidOf(groupId);
      if (!gid) return { ok: false, message: '不知道是哪个群：这个会话不是群聊，也没给 groupId' };
      const r = await adm.join({ groupId: gid, action: act, memberOpenid, joinRequestId, reason });
      if (!r.ok) return { ok: false, message: r.message || '没成功', reason: r.reason };
      if (act === 'list') {
        const list = Array.isArray(r.requests) ? r.requests : Array.isArray(r.items) ? r.items : [];
        return { ok: true, count: list.length, requests: list.slice(0, 20) };
      }
      return { ok: true, note: act === 'approve' ? '已通过' : '已拒绝' };
    },
  };

  /**
   * C5-1 主人私聊·群聊摘要（aurabot 叫 ownerBrief）。
   *
   * 数据来源复用 `chat_look` 那一套账本，不新开文件、不新造缓冲：
   * `ledger-read.js` 的 `recent()` 是正序（老在前）的全量入站记录，
   * 群里没叫她的那些话也在里面——这正是「主人不在群里也想知道」的关键。
   *
   * 和 `chat_look` 的分工：它给逐条时间线（要翻页、要精确原文），
   * 这里给「一眼看完」的摘要（谁在说、说了几句、各自最后一句）。
   * 列会话仍交给 `chat_look what=chats`，不在这里再抄一份清单。
   *
   * 描述用正面写法：真机实测过，权限条件写进描述会让模型连主人私聊里
   * 都不敢调（chat_look 那次踩过）。能不能查一律由 execute 说明。
   */
  const brief = {
    name: 'qq_group_brief',
    description:
      '某个群最近聊了什么：时间段、谁在说话、各自说了哪几句，一眼能看完的摘要。'
      + '主人在私聊里问「XX 群刚才聊啥了」「我不在的时候群里说了什么」时先调它，别凭印象说不知道。'
      + '群 openid 不知道就先用 chat_look 的 what=chats 列一遍。'
      + '想要逐条原文 / 翻更早的用 chat_look；这个只读账本，不会发消息也不会记任何东西。',
    parameters: {
      groupId: { type: 'string', required: true, description: '群 openid，也就是会话清单里的 chatId' },
      limit: { type: 'number', description: '最多看最近几条，默认跟随设置、上限 50' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v ?? null) }],
    },
    async execute({ groupId, limit } = {}) {
      const me = caller();
      /**
       * 两道门缺一不可：`bucket === 'owner'` 在主人所在的群里也成立，
       * 只判它的话，主人在 A 群问一句就能把 B 群的话拉进 A 群。
       * 非主人 / 群里一律给同一句中性话，不解释开关、不暴露存在性。
       */
      if (String(me.bucket || '') !== 'owner' || String(me.kind || '') !== 'c2c') {
        return { ok: false, message: '这个只能主人在私聊里查，别处不方便说。' };
      }
      const gid = String(groupId || '').trim();
      if (!gid) {
        return { ok: false, message: '要给出群 openid：先用 chat_look 的 what=chats 列一遍能看的会话。' };
      }
      /** 目标是不是群查会话映射，不靠 openid 长相猜（和 chat_look 同一口径） */
      const ent = sessionOf?.(gid);
      if (!ent) return { ok: false, message: '找不到这个会话，先列一遍能看的会话再挑 chatId。' };
      if (String(ent.kind ?? '') !== 'group') {
        return { ok: false, message: '只能查群聊。别人的私聊任何情况下都不查。' };
      }
      const src = ledgerOf?.();
      if (!src?.available?.()) return { ok: false, message: '账本没开（或没找到库），暂时看不了。' };

      const cap = Math.min(Math.max(Number(cfgOf?.()?.group?.briefMaxItems) || 20, 1), 50);
      const lim = Math.min(Math.max(Number(limit) || cap, 1), 50);
      try {
        const rows = src.recent({ chatId: gid, limit: lim });
        const items = rows.map((x) => ({
          time: x.time,
          who: x.who,
          text: String(x.text).slice(0, 120),
        }));
        /** 按人聚合，顺序按第一次出现排（时间线是正序的） */
        const byWho = new Map();
        for (const it of items) {
          const e = byWho.get(it.who) || { who: it.who, count: 0, last: '' };
          e.count += 1;
          e.last = it.text;
          byWho.set(it.who, e);
        }
        const title = String(ent.title ?? '').replace(/^QQ · /, '').trim();
        return {
          ok: true,
          groupId: gid,
          name: title || `${gid.slice(0, 8)}…`,
          count: items.length,
          from: items.length ? items[0].time : '',
          to: items.length ? items[items.length - 1].time : '',
          people: [...byWho.values()],
          items,
          audience: '只给主人',
          hint: items.length
            ? '只是最近这些条，更早的没带进来；要逐条原文用 chat_look。'
            : '这个群在这段账本里没有记录。',
        };
      } catch (e) {
        return { ok: false, message: `群聊摘要读取失败：${e.message}` };
      }
    },
  };

  return [info, mute, join, brief];
}
