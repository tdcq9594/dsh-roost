/**
 * 跑一轮：把一段话投给 DSH 会话，等它说完，拿到最终文本。
 *
 * DSH 没有「发一句、返回一句」的同步接口——它是事件驱动的：
 *   `assistant/message`  这一轮 AI 说的话（**可能来多次**，工具调用前后各一次）
 *   `turn/end`           这一轮结束，`reason.kind === 'completed'` 才算正常说完
 *
 * 所以这里要维护一张「谁在等」的表，按 sessionId 对上号。
 *
 * 为什么不用固定 sleep 然后去读 session.messages：
 * 读消息列表拿不到「这一轮是哪一轮」，上一轮的尾巴会混进来。
 * 事件里的 `turn` 号正好解决这个问题。
 */

import { randomUUID } from 'node:crypto';

/** 从 assistant 消息里把文本块拼起来 */
export function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function createTurnRunner({ ctx, log = () => {}, timeoutSec = 150 }) {
  /** @type {Map<string, {turn:number, text:string, resolve:Function, reject:Function, timer:any}>} */
  const waiters = new Map();

  function finish(sid, ok, text, reason) {
    const w = waiters.get(sid);
    if (!w) return;
    waiters.delete(sid);
    if (w.timer) clearTimeout(w.timer);

    if (!ok) {
      const kind = reason?.kind ?? 'unknown';
      w.reject(Object.assign(new Error(`这一轮没正常结束（${kind}）`), { kind }));
      return;
    }
    if (!text) {
      // AI 说完了但没输出文字（只调了工具，或者干脆沉默）
      w.reject(Object.assign(new Error('AI 这一轮没有输出文字'), { kind: 'empty' }));
      return;
    }
    w.resolve(text);
  }

  const off = ctx.on('session/event', (session, event) => {
    const sid = session?.id;
    if (!sid || !waiters.has(sid) || !event) return;

    if (event.type === 'assistant/message') {
      const d = event.data || {};
      // 被打断的那条不算数
      if (d.interrupted) return;
      const t = textOf(d.message);
      if (!t) return;
      const w = waiters.get(sid);
      if (!w) return;
      w.turn = d.turn;
      w.text = t;
      return;
    }

    if (event.type === 'turn/end') {
      const d = event.data || {};
      const w = waiters.get(sid);
      if (!w) return;
      // 只认「这一轮」的文本，上一轮残留的不要
      const text = w.turn === d.turn ? w.text : '';
      finish(sid, d.reason?.kind === 'completed', text, d.reason);
    }
  });

  /**
   * 跑一轮。
   *
   * @param {object} agent 活的 DSH agent
   * @param {string} text 要投给 AI 的话（已经整形好的）
   * @param {object} [opts]
   * @returns {Promise<string>} AI 的最终文本
   */
  async function run(agent, text, { source = { kind: 'roost' } } = {}) {
    const sid = agent?.session?.id ?? agent?.sessionId;
    if (!sid) throw new Error('拿不到 DSH 会话 id，没法投递');

    if (waiters.has(sid)) {
      // 同一会话同时只跑一轮：DSH 那边也是一轮一轮来的，并发投递会乱
      throw Object.assign(new Error('这个会话上一轮还没结束'), { kind: 'busy' });
    }

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(sid, false, '', { kind: 'timeout' });
      }, timeoutSec * 1000);
      timer.unref?.();
      waiters.set(sid, { turn: -1, text: '', resolve, reject, timer });
    });

    // 先挂上等待，再投递——反过来的话可能「AI 秒回」而我们还没开始等
    try {
      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source,
      });
      await ctx.sessions?.flush?.(agent.session);
    } catch (e) {
      finish(sid, false, '', { kind: 'send-failed' });
      throw e;
    }

    return promise;
  }

  return {
    run,
    get waiting() {
      return waiters.size;
    },
    dispose() {
      for (const [sid, w] of waiters) {
        if (w.timer) clearTimeout(w.timer);
        w.reject(Object.assign(new Error('插件已卸载'), { kind: 'disposed' }));
        waiters.delete(sid);
      }
      try {
        if (typeof off === 'function') off();
      } catch {}
    },
  };
}
