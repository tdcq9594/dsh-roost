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

  const id = String(payload?.sender?.id ?? '').trim();
  if (!id) return '';

  const name = String(payload?.sender?.name ?? '')
    .replace(/[[\]()\r\n]/g, ' ')
    .trim()
    .slice(0, 24) || id.slice(0, 6);

  return `[${name} (${id})] `;
}

/** 会话标识：群和私聊要分开，同一个 openid 在两种场景下不是一回事 */
export function chatOf(payload) {
  const chatId = String(payload?.chat?.chatId ?? '');
  const kind = payload?.chat?.kind === 'c2c' ? 'c2c' : 'group';
  return {
    kind,
    chatId,
    groupId: String(payload?.chat?.groupId ?? ''),
    name: String(payload?.chat?.name ?? ''),
    preset: kind === 'c2c' ? 'roost-private' : 'roost-social',
  };
}
