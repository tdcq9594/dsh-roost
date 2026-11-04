/**
 * 把 inbound payload 变成「给 AI 看的一段话」。
 *
 * 优先用 ai-chat 给的 `rendered`——它那边已经做过整形（语音 ASR、引用、
 * 合并转发、卡片都拼好了），宿主不该再写一遍。
 * 老版本插件没有这个字段时，这里兜底自己拼。
 */

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
  const kind = chat?.kind === 'c2c' ? 'c2c' : 'group';
  // 私聊只有一个人，给 id 没有意义，反而白占 token
  if (kind !== 'group') return '';

  /**
   * 多人批次（连着几句攒成一批）不套外层标签。
   *
   * ai-chat 那边已经把每条拼成 `昵称(openid)：正文` 了，这里再套一层
   * `[最后那个人 (id)]` 会让人以为整段都是他说的——而批次里明明有别人。
   */
  if (payload?.batch?.multi) return '';

  const id = String(payload?.sender?.id ?? '').trim();
  if (!id) return '';

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
  return `[${name} (${uin ? `QQ ${uin} / ${id}` : id})] `;
}

/** 会话标识：群和私聊要分开，同一个 openid 在两种场景下不是一回事 */
export function chatOf(payload) {
  const chatId = String(payload?.chat?.chatId ?? '');
  const kind = payload?.chat?.kind === 'c2c' ? 'c2c' : 'group';

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

  return {
    kind,
    chatId,
    groupId: String(payload?.chat?.groupId ?? ''),
    name: String(payload?.chat?.name ?? ''),
    preset: kind === 'c2c' ? 'roost-private' : 'roost-social',
    uin,
    groupUin,
    aliases,
    identityId: kind === 'c2c' ? (uin ? `u:${uin}` : '') : groupUin ? `g:${groupUin}` : '',
  };
}
