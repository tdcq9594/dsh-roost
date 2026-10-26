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
