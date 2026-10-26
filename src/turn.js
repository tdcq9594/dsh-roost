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
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, loadConfig } from './config.js';

/**
 * 把 base64 图片存到本地，返回路径。
 *
 * 按内容哈希命名：同一张图发两次只存一份，也不会覆盖别的图。
 * 存不下（磁盘满/权限）就返回 null——**不能因为存图失败把整轮弄挂**。
 */
function saveImage(data, mediaType) {
  try {
    const b64 = String(data).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return null;
    const ext = String(mediaType || 'image/jpeg').split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const dir = join(dataDir(), 'images');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext);
    writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

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
   * @param {Array<{data:string,mediaType:string,name?:string}>} [opts.images]
   *   图片块（base64）。插件那边下载好的，直接当 image 内容块投进去——
   *   模型这才「看得见」图，否则它只看到一行「（发了一张图）」。
   * @returns {Promise<string>} AI 的最终文本
   */
  async function run(agent, text, { source = { kind: 'roost' }, images = [] } = {}) {
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
      /**
       * 文字在前、图片在后。
       *
       * **图片默认存盘，不内联 base64。**
       *
       * 一张 QQ 图 base64 出来 32 万字符（约 320KB），整段塞进请求体，
       * 实测会导致 `DeepSeek Messages transport failed`（重试 5 次全挂）。
       * 存成本地文件、把路径写进文本，DSH 是编码代理，有读文件的工具，
       * 需要看图时自己读就行——请求体也就几百字节。
       *
       * `images.mode` 可调：
       *   'file'  存盘 + 文本给路径（默认）
       *   'block' 老做法，直接塞 base64 块
       *   'both'  两个都要
       */
      const cfg = loadConfig();
      const mode = String(cfg?.images?.mode || 'file');
      const content = [{ type: 'text', text }];
      const saved = [];
      for (const img of images ?? []) {
        if (!img?.data) continue;
        const file = saveImage(img.data, img.mediaType);
        if (file) saved.push(file);
        if (mode === 'block' || mode === 'both') {
          content.push({ type: 'image', data: img.data, mediaType: img.mediaType, name: img.name || 'qq-image' });
        }
      }
      if (saved.length) {
        content[0].text += `\n\n（图已存到本地，需要看就直接读：${saved.join('、')}）`;
      }

      await agent.followup({
        id: randomUUID(),
        role: 'user',
        content,
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
