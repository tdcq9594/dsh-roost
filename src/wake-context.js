/**
 * 主动搭话的上下文取数（C1 + C4 的接线层）
 * ========================================
 *
 * `wakeMaterials()` 是纯函数（挑几行、拼文案），但它前面「从哪儿取、取哪些
 * kind、怎么排序」一直埋在 `host.js` 的闭包里，只有代码审查没有测试。
 * 2026-11-08 审查抓到的「只取 chat 漏 proactive」就是这一层的问题——
 * 纯函数测试全绿，实际防复读看不到主动说过的话。
 *
 * 抽出来之后可以拿真 journal / 真 events 直接测，不用造假 ctx。
 */

import { wakeMaterials } from './awake.js';

/**
 * @param {{journal:object, events?:object, chatId?:string, aliases?:string[],
 *          eventsEnabled?:boolean, labels?:object, limit?:number}} opts
 * @returns {{recent:string[], recentBot:string[], done:string[]}}
 */
export function wakeContext({
  journal,
  events,
  chatId = '',
  aliases = [],
  eventsEnabled = false,
  labels = {},
  limit = 16,
} = {}) {
  const cid = String(chatId ?? '').trim();
  /**
   * 没有会话 id 时**返回空**，不要去查全库：`journal.recent('')` 不是
   * 「查不到」，而是返回所有会话的最近几条——私聊主动会引用群里的对话（串场）。
   */
  if (!cid) return { recent: [], recentBot: [], done: [] };

  /**
   * C1：对话原文（`chat`）和主动搭话（`proactive`）**两个 kind 都要取**。
   * 合并后按时间倒序取最近 `limit` 条，交给 `wakeMaterials` 再挑 bot 行。
   */
  const rows = [
    ...journal.recent(cid, limit, 'chat', aliases),
    ...journal.recent(cid, limit, 'proactive', aliases),
  ]
    .sort((a, b) => Number(b.at) - Number(a.at))
    .slice(0, limit);

  /** 【刚才说到】按时间正序（最旧在前），提示词里读起来才顺 */
  const recent = journal
    .recent(cid, 4, 'chat', aliases)
    .reverse()
    .map((r) => `${r.role === 'bot' ? '你' : r.sender || '对方'}：${String(r.digest || r.text).slice(0, 60)}`);

  return {
    recent,
    ...wakeMaterials({
      journalRows: rows,
      eventRows: eventsEnabled ? (events?.recent?.(3) ?? []) : [],
      eventsEnabled,
      labels,
    }),
  };
}
