// 注入预算：按优先级把若干块塞进字数上限。
//
// 为什么不是"整段截断"：记忆块每轮都注入，写多了直接吃 token。
// 一刀切会把最要紧的那块也切掉一半；按优先级砍，至少保住重要的。
//
// 单独成文件是为了能测——它原来埋在 createHost 的闭包里，
// 而"砍多砍少"恰恰是出问题也不会报错的那类逻辑。

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
      out.push(text);
      used += text.length + sep.length;
    } else {
      /**
       * 截断时留一个 `…`：模型看到它就知道"这里被截了"，
       * 比拿到半句没有标记的话更容易说错（以为是完整的一句）。
       */
      out.push(text.slice(0, Math.max(0, room - 1)) + '…');
      break;
    }
  }
  return out.join(sep);
}
