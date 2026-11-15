/**
 * 把 inbound payload 变成「给 AI 看的一段话」。
 *
 * 优先用 ai-chat 给的 `rendered`——它那边已经做过整形（语音 ASR、引用、
 * 合并转发、卡片都拼好了），宿主不该再写一遍。
 * 老版本插件没有这个字段时，这里兜底自己拼。
 */

/**
 * 会话类型契约（2026-11-15 加频道能力时统一）
 * ==========================================
 *
 * 框架 `chat.kind` 有四种：`group` / `c2c` / `guild` / `dm`。
 * 但 dsh-roost 内部大量逻辑只分「多人场景 / 私聊场景」（scene），
 * 以前到处写 `c2c ? ... : group`，频道消息一进来就会被当群聊。
 *
 * 统一在这里定义映射，别再各自二分：
 *   · `guild`（文字子频道，多人）→ scene `group`、人设 social、需要说话人标签
 *   · `dm`（频道私信，一对一）  → scene `c2c`、人设 private、不需要说话人标签
 */
export const CHAT_KINDS = Object.freeze(['group', 'c2c', 'guild', 'dm']);
export function normalizeKind(k) {
  return CHAT_KINDS.includes(k) ? k : 'group';
}
/** 一对一场景：c2c 与频道私信 */
export function isPrivateKind(k) {
  return k === 'c2c' || k === 'dm';
}
/** 多人场景：普通群与文字子频道 */
export function sceneOfKind(k) {
  return k === 'group' || k === 'guild' ? 'group' : 'c2c';
}
/** 人设档位 */
export function presetOfKind(k) {
  return isPrivateKind(k) ? 'roost-private' : 'roost-social';
}

export function renderInbound(p) {
  if (typeof p?.rendered === 'string' && p.rendered.trim()) return p.rendered;

  const parts = [];
  const said = String(p?.text ?? '').trim();
  if (said) parts.push(said);

  if (p?.quoted) parts.push(`（引用了这句：${String(p.quoted).slice(0, 500)}）`);

  for (const a of p?.attachments ?? []) {
    if (a?.type === 'voice') {
      parts.push(a.asrText ? `（语音，转成文字是：${a.asrText}）` : '（发了一条语音，没转出文字）');
    } else if (a?.type === 'image') {
      parts.push(a?.url ? `（发了一张图：${a.url}）` : '（发了一张图）');
    } else if (a?.type === 'video') {
      parts.push('（发了一段视频）');
    } else if (a?.type === 'file') {
      parts.push(`（发了个文件：${a.filename || '未命名'}）`);
    }
  }

  for (const el of p?.elements ?? []) {
    if (el?.type === 'chatRecord') {
      const body = String(el.content ?? '').trim();
      if (body) parts.push(`（合并转发的内容：\n${body.slice(0, 1200)}）`);
    } else if (el?.type === 'ark') {
      parts.push(`（卡片消息：${el?.ark?.title || '无标题'}）`);
    }
  }

  return parts.filter(Boolean).join('\n') || '（一条空消息）';
}

/**
 * 群聊消息的「发送者标签」——`[昵称 (openid)] `，私聊返回空串。
 *
 * 抄的是腾讯官方 `@tencent-connect/dsh-qqbot` 的做法
 * （`dist/transport/inbound.js` 的 `buildUserMessage`）：
 * 模型看到的是 `[小明 (A1B2C3…)] 今天吃啥`，括号里是 `member_openid`。
 *
 * 为什么必须给：官方群聊 @ 只认 `<qqbot-at-user id="member_openid" />`，
 * 没有 openid 就没法 @ 人。而昵称是**不可靠的**——群里两个「小明」很正常，
 * 昵称也能随便改，拿它当身份会 @ 错人。
 *
 * 为什么挂在消息上而不是场景块（`sceneText`）里：场景块每轮被覆盖，
 * 只留得住「最后说话的那个人」；挂在消息上，模型读历史时每个人天然带 id，
 * 想 @ 刚才插话那位也拿得到。
 *
 * 昵称和 id 都要清洗：`]` `(` `)` 会把标签结构搞坏，换行会把一条消息劈成两行。
 */
export function speakerTag(payload, chat) {
  const kind = normalizeKind(chat?.kind);
  // 一对一场景（c2c / 频道私信）只有一个人，给 id 没有意义，反而白占 token
  if (isPrivateKind(kind)) return '';

  /**
   * 同一个频道的文字子频道 / 论坛 / 公告等**共用一个会话**
   * （sessionKey 按 guild_id 聚合），所以每条消息都要带上子频道标识，
   * 否则 AI 会把不同版块的话当成同一处连着读，分不清是谁在哪说的。
   */
  const channelTag = kind === 'guild'
    ? `[子频道 ${String(chat?.channelId || chat?.chatId || '?').trim().slice(0, 32)}] `
    : '';

  /**
   * 多人批次（连着几句攒成一批）不套外层标签。
   *
   * ai-chat 那边已经把每条拼成 `昵称(openid)：正文` 了，这里再套一层
   * `[最后那个人 (id)]` 会让人以为整段都是他说的——而批次里明明有别人。
   * 频道批次仍要保留子频道标识。
   */
  if (payload?.batch?.multi) return channelTag;

  const id = String(payload?.sender?.id ?? '').trim();
  if (!id) return channelTag;

  const name = String(payload?.sender?.name ?? '')
    .replace(/[[\]()\r\n]/g, ' ')
    .trim()
    .slice(0, 24) || id.slice(0, 6);

  /**
   * **有 QQ号 时号码排在前面**：`[小明 (QQ 10001 / CBF1E6B3…)] `。
   *
   * openid 是每个 AppID 一套的，换机器人就全变；号码不会。
   * 两个都给，模型才会「有号码按号码认人，没有才退回 openid」——
   * 只给 openid 的话，换一次机器人它就把老朋友当陌生人了。
   * openid 仍然保留（@ 人只认它，见上面的注释）。
   */
  const uin = String(payload?.sender?.uin ?? '').replace(/\D/g, '');
  return channelTag + `[${name} (${uin ? `QQ ${uin} / ${id}` : id})] `;
}

/** 会话标识：群和私聊要分开，同一个 openid 在两种场景下不是一回事 */
export function chatOf(payload) {
  const chatId = String(payload?.chat?.chatId ?? '');
  const kind = normalizeKind(payload?.chat?.kind);
  /** 下游大量逻辑仍按 group/c2c 两态选人设、@ 标签、上限，统一从这里给映射值 */
  const scene = sceneOfKind(kind);

  /**
   * 身份：QQ号 / 群号 + 读旧记忆的备用键。
   *
   * `uin` 是**说话的人**（私聊时就是对方），`groupUin` 是群号。
   * `aliases` 是「这个号码名下所有 openid」——换过机器人之后，
   * 旧记忆的键是另一个 openid，只有靠它才读得到。
   * 群聊给群的别名、私聊给人的别名，**两组不能混**（混了群会话会读到私聊记忆）。
   *
   * `identityId` 是跨机器人稳定的主键：`g:763366431` / `u:10001`。
   * 没绑号码时是空串——**空串不等于「同一个人」**，不能拿它当键用。
   */
  const uin = String(payload?.chat?.uin ?? '').replace(/\D/g, '');
  const groupUin = String(payload?.chat?.groupUin ?? '').replace(/\D/g, '');
  const aliases = (Array.isArray(payload?.chat?.aliases) ? payload.chat.aliases : [])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x && x !== chatId);

  /**
   * 会话归属（主人 2026-11-15 定）：
   * · 群聊 / 单聊保持原 chatId —— 老会话一条都不能丢；
   * · 频道按 **guild_id 聚合**：同一个频道的文字子频道、论坛、公告等
   *   共用一个会话；不同频道之间分开，也不与群聊 / 单聊共用；
   * · 频道私信按会话 id 独立（一对一上下文不和公开频道混）。
   * 只换会话 / 人格映射的键，**出站 target 仍用 chatId**。
   */
  const guildId = String(payload?.chat?.guildId ?? '');
  const sessionKey = kind === 'guild' ? `guild:${guildId || chatId}`
    : kind === 'dm' ? `dm:${chatId}`
      : chatId;

  return {
    kind,
    /** 两态投影：guild→group、dm→c2c，给只认 scene 的下游用 */
    scene,
    chatId,
    /** 会话 / 人格映射用的键；出站 target 仍用 chatId */
    sessionKey,
    groupId: String(payload?.chat?.groupId ?? ''),
    /** 频道维度：频道 ID / 子频道 ID（群、单聊为空串） */
    guildId,
    channelId: String(payload?.chat?.channelId ?? ''),
    name: String(payload?.chat?.name ?? ''),
    preset: presetOfKind(kind),
    uin,
    groupUin,
    aliases,
    /**
     * 频道没有 QQ 号 / 群号可绑，identityId 会是空串——空串不等于「同一个人」，
     * 别拿它当键。频道会话的隔离靠 chatId（guild 是 channel_id、dm 是会话 id）。
     */
    identityId: isPrivateKind(kind) ? (uin ? `u:${uin}` : '') : groupUin ? `g:${groupUin}` : '',
  };
}
