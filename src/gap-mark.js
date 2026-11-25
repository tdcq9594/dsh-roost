/**
 * 「刚才说到」的水位线：每个会话记住了哪一条账本消息**已经露给模型看过**。
 *
 * ## 为什么需要它
 *
 * 缺口补齐的判据是「账本里有、日记 `eventIds` 里没有」= 模型确实没见过。
 * 这个判据本身对，但有个**不动点问题**：补进去的那几条，没有任何地方记成
 * 「已见」——它们只是被拼进这一轮的 user message，不会回到日记的 `eventIds`。
 * 于是下一轮它们还是「没见过」，再下一轮还是……缺口永远合不上。
 *
 * 2026-11-25 主人报的真实现象：群里聊到账本 seq 2067，注入块却一直停在
 * seq 2048–2055 那 8 条，一个字都不变。那 8 条是机器人没被叫到时群友说的话，
 * 只存在账本里、永远不会进日记，所以它们每轮都被当成「新缺口」重念一遍。
 *
 * 所以补一条水位线：**露过就算见过**。每轮只取 `seq` 高于它的行，
 * 真拼出去了再把它推到这批里最大的 `seq`。
 *
 * ## 语义上的三个边界
 *
 * · **只前移，不回退**：`set` 比当前值小就忽略。多轮并发、乱序调用都不会把它
 *   拉回去，退回去的后果是同一段话被反复念。
 * · **预览不推进**：面板 `/mind` 只是看，不真注入。这条由调用方用
 *   `commit` 参数控制，别在这儿猜。
 * · **账本滚动删除后自然清空**：`seq` 只增不减，旧会话的水位永远失效，
 *   不影响新会话；文件里最多留 `MAX_CHATS` 个会话，按最后写入时间淘汰。
 *
 * ## 为什么落盘
 *
 * 只放内存也能自愈（重启后补一次就往前走了），但那一轮还是会念一段早就不该
 * 提的旧话——正是这个文件要修的那个症状。文件很小、写一次几十字节，
 * 不值得为它省一次 IO。写失败一律吞掉：这块是增强，不能影响回话。
 */

import { readJson, writeJson } from './autotelic-store.js';

/** 最多记多少个会话的水位。群多、私聊多也不怕，淘汰的是最久没动静的 */
const MAX_CHATS = 200;

/**
 * @param {object} o
 * @param {string} o.file 水位文件（`dataDir()/gap-mark.json`）；空串 = 纯内存
 */
export function createGapMark({ file = '' } = {}) {
  /** 没给文件时的临时状态（测试 / 关掉落盘）：同一实例内照样有效 */
  let memory = null;

  /**
   * 不缓存：这文件只有几十行，每轮读一次比维护缓存失效便宜，
   * 还能让「测试直接改文件」和「用户手改」都立刻生效。
   */
  function load() {
    if (!file) {
      if (!memory) memory = { chats: {} };
      return memory;
    }
    const raw = readJson(file, {});
    const chats = raw && typeof raw === 'object' && raw.chats && typeof raw.chats === 'object'
      ? raw.chats
      : {};
    return { chats };
  }

  function save(state) {
    if (!file) return;
    try {
      writeJson(file, { v: 1, chats: state.chats });
    } catch {
      /** 写不进去只影响「下一轮再念一遍」，不该让这一轮回不了话 */
    }
  }

  /** 该会话已经露到哪一条（`0` = 还没露过，全算缺口） */
  function get(chatId) {
    const id = String(chatId || '');
    if (!id) return 0;
    const row = load().chats[id];
    return Number(row?.seq) || 0;
  }

  /**
   * 把水位推到 `seq`。**只前移**：比当前值小就原样返回。
   *
   * @returns {number} 推进之后的实际水位
   */
  function set(chatId, seq) {
    const id = String(chatId || '');
    const next = Number(seq) || 0;
    if (!id || next <= 0) return get(id);
    const state = load();
    const prev = Number(state.chats[id]?.seq) || 0;
    if (next <= prev) return prev;
    state.chats[id] = { seq: next, at: Date.now() };
    /** 超量就丢最久没写过的，别让文件无限长 */
    const keys = Object.keys(state.chats);
    if (keys.length > MAX_CHATS) {
      keys
        .sort((a, b) => (Number(state.chats[a]?.at) || 0) - (Number(state.chats[b]?.at) || 0))
        .slice(0, keys.length - MAX_CHATS)
        .forEach((k) => { delete state.chats[k]; });
    }
    save(state);
    return next;
  }

  /** 忘掉某个会话的水位（重放 / 调试用） */
  function clear(chatId) {
    const id = String(chatId || '');
    if (!id) return;
    const state = load();
    if (!(id in state.chats)) return;
    delete state.chats[id];
    save(state);
  }

  return { get, set, clear, file };
}
