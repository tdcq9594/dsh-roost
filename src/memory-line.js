/**
 * 记忆行的格式化：时间 + 出处 + 「当时：」。
 *
 * 为什么单独一个文件：`host.js` 的易变段、面板调试接口、以后的
 * 人物档案都要用同一句话描述「这是什么时候、在哪记的旧事」，
 * 各写一份迟早不一样。纯函数、零依赖，方便单测。
 *
 * 「当时：」不是装饰：模型看到一句光秃秃的旧话，很容易当成
 * 这一轮刚说的、直接接上去答。前面挂个时间和出处，它才知道
 * 那是过去的事，该当背景而不是当新问题。
 *
 * **说话人按档位裁**：`member`（群成员）档的检索结果不带 sender，
 * 与「member 的 memory_search 不返回 sender」同一条边界。只有
 * `owner` 档才告诉她「这是谁说的」。默认按最保守的档位算，
 * 调用方忘了传也不会漏身份。
 */

function dayStr(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 与 host.js 的 clip 同款：超了留一位给省略号 */
function clip(text, max = 60) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * 出处只回答两件事：这记忆是不是这个群的、是不是她自己说的。
 * 不写 openid、不写消息 id——注入块里那些字符串是纯噪音，
 * 还会让模型拿它当身份去 @ 人。
 */
function sourceOf(r, chatId) {
  const place = !r.chatId ? '通用' : (chatId && r.chatId !== chatId ? '别处' : '这个群');
  if (r.role === 'bot') return `${place}·你说过`;
  if (r.kind === 'digest') return `${place}·那些天的摘要`;
  return place;
}

/**
 * @param {object} row journal.search 返回的一行（at/sender/role/kind/chatId/digest/text）
 * @param {{bucket?:string, chatId?:string, max?:number}} [opts]
 * @returns {string} 一行正文；空内容返回 ''，调用方直接 filter(Boolean)
 */
export function memoryLine(row, { bucket = 'member', chatId = '', max = 60 } = {}) {
  const r = row && typeof row === 'object' ? row : {};
  const body = clip(r.digest || r.text || '', max);
  if (!body) return '';

  const head = [];
  const day = Number(r.at) > 0 ? dayStr(Number(r.at)) : '';
  if (day) head.push(day);
  head.push(sourceOf(r, chatId));

  const who = bucket === 'owner' && r.role !== 'bot' && String(r.sender ?? '').trim()
    ? `${String(r.sender).trim()}说：`
    : '';
  return `· ${head.join(' · ')} · 当时：${who}${body}`;
}

/** 一批命中行；坏行、空行直接跳过，不让整段注入崩掉 */
export function memoryLines(rows, opts = {}) {
  return (Array.isArray(rows) ? rows : [])
    .map((r) => memoryLine(r, opts))
    .filter(Boolean);
}
