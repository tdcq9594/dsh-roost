// 注入预算：按优先级把若干块塞进字数上限。
//
// 为什么不是"整段截断"：记忆块每轮都注入，写多了直接吃 token。
// 一刀切会把最要紧的那块也切掉一半；按优先级砍，至少保住重要的。
//
// 单独成文件是为了能测——它原来埋在 createHost 的闭包里，
// 而"砍多砍少"恰恰是出问题也不会报错的那类逻辑。

/** 孤立代理字符（高代理后面没接低代理，或低代理前面没高代理）。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 按 UTF-16 码元截断，但绝不在代理对中间下刀。
 *
 * 预算和上游的 `text.length` 都按码元算，所以不能改成按码点截断
 * （一个 emoji 占 2 码元，会把总长度撑过 max）。切开 surrogate pair
 * 会留下孤立代理字符，这种字符串发给模型会让**之后所有请求都 400**、
 * 表现是她突然不再回话（aurabot #151 踩过）。
 *
 * 顺带把输入里本来就有的孤立代理也清掉：注入块来自多处拼接，
 * 光修截断这一处挡不住别的来源。
 */
export function clipForBudget(text, room) {
  const s = String(text ?? '');
  const clean = (part) => (part.isWellFormed() ? part : part.replace(LONE_SURROGATE, ''));
  if (room <= 0) return '';
  if (s.length <= room) return clean(s);
  let end = room;
  const last = s.charCodeAt(end - 1);
  // 末位是高位代理 → 再退一位，别把它单独留在末尾
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return clean(s.slice(0, end));
}

/**
 * @param {string[]} sections 按优先级从高到低
 * @param {number} max 字数上限
 * @param {string} sep 连接符（稳定段用空行，易变段用单换行）
 * @returns {string}
 */
export function fitBudget(sections, max, sep = '\n\n') {
  const out = [];
  let used = 0;
  for (const s of sections) {
    const text = String(s || '');
    if (!text) continue;
    const room = max - used;
    if (room <= 0) break;
    if (text.length <= room) {
      const kept = clipForBudget(text, room);
      out.push(kept);
      used += kept.length + sep.length;
    } else {
      /**
       * 截断时留一个 `…`：模型看到它就知道"这里被截了"，
       * 比拿到半句没有标记的话更容易说错（以为是完整的一句）。
       */
      out.push(clipForBudget(text, room - 1) + '…');
      break;
    }
  }
  return out.join(sep);
}
