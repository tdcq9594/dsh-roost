/**
 * 把 inbound payload 变成「给 AI 看的一段话」。
 *
 * 优先用上游给的 `rendered`——`roost-payload.js` 的 `buildRendered` 已经做过整形
 * （语音 ASR、引用、合并转发、卡片都拼好了），这里不该再写一遍。
 * 没有这个字段时（老版本 / 模拟器）才兜底自己拼。
 */

/**
 * 引用正文最多带多少字。
 *
 * 500 字对长引用（一整段话、一小段帖子）不够用，模型只看到开头就得猜后半句说了什么。
 * 2000 字覆盖绝大多数引用，又不至于把每轮 token 顶上去——openclaw 是全文注入，
 * 我们不跟：那等于把上下文预算交给对方那张嘴。
 *
 * **定义在这个文件而不是 `roost-payload.js`**：`inbound.js` 是零 import 的纯函数模块，
 * 反向依赖会把 `fs/os/path` 拖进它的依赖链。方向定成 `roost-payload → inbound`。
 */
export const QUOTE_MAX_CHARS = 2000;

/** 引用正文截断。两个调用点（这里和 `buildRendered`）必须同一口径，所以抽出来共用 */
export function clipQuote(s) {
  const t = String(s ?? '');
  return t.length > QUOTE_MAX_CHARS ? `${t.slice(0, QUOTE_MAX_CHARS)}…` : t;
}

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

  if (p?.quoted) parts.push(`（引用了这句：${clipQuote(p.quoted)}）`);

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
export function chatOf(payload, { sessionMode = 'guild' } = {}) {
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
  const channelId = String(payload?.chat?.channelId ?? '');
  /**
   * 频道私信用**用户 ID** 作键（一人一个）。
   *
   * 不能拿 `chatId`：那是 `createDms` 返回的私信会话 id，官方按
   * 「机器人 + 用户 + 源频道」三元组生成 —— 同一用户从不同源频道进来
   * 会拿到不同 id，一个人就开出好几个会话。`sender.id` 才是人。
   */
  const senderId = String(payload?.sender?.id ?? '').trim();
  const sessionKey = kind === 'guild'
    ? (sessionMode === 'channel'
      ? `guild:${guildId || chatId}:ch:${channelId || chatId}`
      : `guild:${guildId || chatId}`)
    : kind === 'dm' ? `dm:${senderId || chatId}`
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
    channelId,
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

/**
 * 这条消息是不是频道场景（`guild` / `dm`）。
 *
 * **不能只靠 `chatOf().kind`**：`normalizeKind()` 对缺失 / 拼错的 kind 会回落
 * `'group'`，频道 payload 少一个字段就会被当群聊放过去。所以双保险：
 * 原始 kind 命中白名单，或带频道维度字段（`guildId` / `channelId`），任一成立即判频道。
 *
 * 只给**消息帧**用。notice 帧没有 `chat` 字段（`serializeNotice` 只给
 * `{ at, event, data }`），那边走 `isChannelEvent()`。
 */
export function isChannelChat(payload) {
  const raw = String(payload?.chat?.kind ?? '').trim().toLowerCase();
  if (raw === 'guild' || raw === 'dm') return true;
  return Boolean(
    String(payload?.chat?.guildId ?? '').trim()
    || String(payload?.chat?.channelId ?? '').trim(),
  );
}

/**
 * 这个事件是不是频道类（`onNotice` 入口过滤用）。
 *
 * 按官方 intents 表归类，**不能只按事件名前缀**：`AT_MESSAGE_CREATE` /
 * `MESSAGE_CREATE` / `MESSAGE_DELETE` / `PUBLIC_MESSAGE_DELETE` 都没有频道前缀。
 *
 * 前缀兜住 `GUILD_*` / `CHANNEL_*` / `FORUM_*` / `AUDIO_*` /
 * `MESSAGE_REACTION_*` / `MESSAGE_AUDIT_*` / `DIRECT_MESSAGE_*`；
 * 无前缀的用显式名单补。`INTERACTION_CREATE`、群聊 / 好友事件不在此列，不过滤。
 */
const CHANNEL_EVENT_PREFIX = /^(GUILD_|CHANNEL_|FORUM_|AUDIO_|MESSAGE_REACTION_|MESSAGE_AUDIT_|DIRECT_MESSAGE_)/;
const CHANNEL_EVENTS_NO_PREFIX = new Set([
  'AT_MESSAGE_CREATE', 'MESSAGE_CREATE', 'MESSAGE_DELETE', 'PUBLIC_MESSAGE_DELETE',
]);

export function isChannelEvent(name) {
  const n = String(name ?? '').trim();
  if (!n) return false;
  return CHANNEL_EVENT_PREFIX.test(n) || CHANNEL_EVENTS_NO_PREFIX.has(n);
}
