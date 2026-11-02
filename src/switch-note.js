/**
 * 「说话方式刚换了」的一次性提示。
 *
 * 面板换人格后，模型仍可能沿用旧语气：DSH 在 system prompt 变化时可能**追加**
 * 一条新 system message（旧的还在历史里），再加上几十轮旧语气的对话，惯性很大。
 * 所以换完给下一轮注一句提示。
 *
 * 为什么要单独成模块：这段原来写在 host.js 闭包里，只能靠「全局单变量 lastHit」
 * 记「这一轮注入过没有」。两个会话并发时 A 的记录会被 B 的轮末抹掉，
 * 结果是两边 5 分钟内每轮都重复提示——而且没有任何测试能发现。
 */

/**
 * @param {{ttlMs?:number, now?:() => number}} [o]
 * @returns {{set:(label:string)=>void, text:(chatId:string)=>string, consume:(chatId:string)=>void, clear:()=>void, peek:()=>object|null}}
 */
export function createSwitchNote({ ttlMs = 5 * 60_000, now = Date.now } = {}) {
  /** @type {{text:string, at:number, seen:Set<string>, hit:Set<string>}|null} */
  let note = null;

  return {
    set(label) {
      if (!label) return;
      note = {
        text: `说话方式刚换成「${label}」，从这一轮起按新的来，别延续之前的语气。`,
        at: now(),
        seen: new Set(),
        hit: new Set(),
      };
    },

    /** 取这一轮的提示；同一会话取过一次就记进 hit，等轮末确认 */
    text(chatId) {
      if (!note) return '';
      if (now() - note.at > ttlMs) {
        note = null;
        return '';
      }
      if (note.seen.has(chatId)) return '';
      note.hit.add(chatId);
      return note.text;
    },

    /**
     * 轮末调用（必须在 finally 里）。
     *
     * 只有**真的注入过**才标记 seen：被 keywordNote 抢先、或者轮次在注入前就失败，
     * 都不算——否则这个会话 5 分钟内就永久错过提示了。
     */
    consume(chatId) {
      if (!note) return;
      if (note.hit.delete(chatId)) note.seen.add(chatId);
    },

    clear() {
      note = null;
    },

    /** 测试用：看一眼内部状态 */
    peek() {
      return note ? { text: note.text, at: note.at, seen: [...note.seen], hit: [...note.hit] } : null;
    },
  };
}
