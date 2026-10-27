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

/**
 * 把 turn/end 的 reason 归类成人能看懂的 kind。
 *
 * **为什么要多这一层分类。**
 *
 * DSH 自己会先重试模型请求（policyKey 里 SERVER/TIMEOUT/TRANSPORT 都在列，
 * 实测 502 会重试 5 次，退避 483ms→949ms→2093ms→3625ms→7813ms）。
 * 5 次全挂之后，它把 `turn/end` 的 reason 写成：
 *
 *   { kind:'error', error:{ message:'DeepSeek Messages request failed (502)',
 *                          code:'SERVER', status:502 } }
 *
 * 我们如果只认 `kind === 'error'`，就会把这坨 JSON 原文当成错误消息
 * 回到 QQ 群里——用户看到的是「这边出了点问题：{"kind":"error",...}」，
 * 既难看又没信息量。这里把它归成 `upstream`，宿主再决定怎么回话。
 *
 * 分类规则：
 *   - HTTP 5xx            → upstream（上游服务端挂了/限流）
 *   - 429 / RATE_LIMIT    → upstream（限流，同属「等会儿就好」）
 *   - TIMEOUT / TRANSPORT → upstream（网络层，跟服务端一样等重试）
 *   - 其余 error          → error（保留原 kind）
 *
 * @returns {{kind:string, status:number, code:string, message:string}}
 */
export function classifyReason(reason) {
  const raw = reason?.kind ?? 'unknown';
  const err = reason?.error ?? {};
  const status = Number(err.status ?? err.statusCode ?? 0) || 0;
  const code = String(err.code ?? '');
  const message = String(err.message ?? reason?.message ?? '');

  const upstreamCode = /^(SERVER|RATE_LIMIT|TIMEOUT|TRANSPORT|OVERLOADED)$/i.test(code);
  const upstreamStatus = status >= 500 || status === 429 || status === 408;

  if (raw === 'error' && (upstreamCode || upstreamStatus)) {
    return { kind: 'upstream', status, code, message };
  }
  return { kind: raw, status, code, message };
}

/** 从 assistant 的失败原因里取状态码（有的错误不带 error 字段） */
export function statusOf(reason) {
  return classifyReason(reason).status || 0;
}

export function createTurnRunner({ ctx, log = () => {}, timeoutSec = 150, upstreamRetry = null }) {
  /**
   * 日志对象规整。
   *
   * 默认值是 `() => {}`（一个函数），但代码里用的是 `log.warn(...)`——
   * 传默认值的调用方一进来就 `log.warn is not a function`。
   * 这里统一补齐四个级别，缺哪个补哪个（缺就当 info）。
   */
  const rawLog = typeof log === 'function' ? {} : log || {};
  const logger = {
    debug: typeof rawLog.debug === 'function' ? rawLog.debug.bind(rawLog) : () => {},
    info: typeof rawLog.info === 'function' ? rawLog.info.bind(rawLog) : () => {},
    warn: typeof rawLog.warn === 'function' ? rawLog.warn.bind(rawLog) : () => {},
    error: typeof rawLog.error === 'function' ? rawLog.error.bind(rawLog) : () => {},
  };

  /** @type {Map<string, {turn:number, text:string, resolve:Function, reject:Function, timer:any}>} */
  const waiters = new Map();

  function finish(sid, ok, text, reason) {
    const w = waiters.get(sid);
    if (!w) return;
    waiters.delete(sid);
    if (w.timer) clearTimeout(w.timer);

    if (!ok) {
      const cls = classifyReason(reason);
      const kind = cls.kind;
      /**
       * 把完整 reason 一起打出来。
       *
       * 只报 kind 等于什么都没说：'blocked' 可能是审批没通过、可能是模型被拦、
       * 也可能是会话状态不对。DSH 在 reason 里通常还带 message/detail，
       * 不打印的话只能靠猜（前面就猜错了一次，怪到「模型去读图片」头上）。
       *
       * 但**上游错误（upstream）不打印全文**——那是一坨 JSON，
       * 打日志没用，回给用户更难看。只留状态码和一句话。
       */
      let extra = '';
      if (kind === 'upstream') {
        extra = cls.status ? `（${cls.status}）` : '';
      } else {
        try {
          const j = JSON.stringify(reason);
          if (j && j !== '{}') extra = '：' + (j.length > 300 ? j.slice(0, 300) + '…' : j);
        } catch {}
      }
      const msg =
        kind === 'upstream'
          ? `模型服务暂时不可用${extra}`
          : `这一轮没正常结束（${kind}）${extra}`;
      /**
       * `hadOutput`：这一轮**已经吐过字**没有。
       *
       * 这是补重试的闸门。上游报错有两种位置：
       *   - 请求刚发出去就 502（常见）→ 一个字都没吐 → 重投安全
       *   - 吐了一半才断（流式中断）→ 已经说出去一半 → **重投会让人收到两条**
       * 所以只有前者能重投。
       */
      w.reject(
        Object.assign(new Error(msg), { kind, reason, status: cls.status, code: cls.code, hadOutput: Boolean(w.text) }),
      );
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
    /**
     * 投一次，等它说完。
     *
     * 拆出来是为了能重试——**重试必须重新走一遍完整的投递**，
     * 因为失败的那一轮已经在 DSH 那边以 error 收尾了，
     * 光等着是等不到结果的。
     */
    async function attempt() {
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
      // 默认不发图片块：实测带图的那一轮会被 DSH 判成 requires_action（blocked），
      // 不带图的都正常。先保证对话能通，块格式以后再单独试。
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
        /**
         * **不要引导模型去读文件。**
         * 群消息里普通成员的工具是被收走的（permissions 的 chat 档），
         * 它真去调 fs 会失败，DSH 直接把这一轮判成 blocked：
         *   「这一轮没正常结束（blocked）」
         * 所以只陈述「存了一份」，别让它动工具。
         */
        content[0].text += `\n\n（另外存了一份到本地：${saved.join('、')}）`;
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
    } // attempt()

    /**
     * **上游错误（502/429/超时）在插件层再试一次。**
     *
     * 为什么 DSH 重试 5 次了还要我们再试：
     * DSH 的重试是**同一个请求**连发 5 次，退避最长 7.8 秒，
     * 全程都在同一个连接上——上游要是整个网关挂了 30 秒，它 5 次全挂。
     * 我们这里等几秒**重新投一轮**，等于给它一个「上游恢复了」的窗口。
     *
     * 只对 upstream 重试：blocked（要人工处理）、empty（模型没说话）、
     * busy（上一轮还在跑）重试都没意义，重投只会让群里刷屏。
     *
     * **只在这一轮一个字都没吐出来时才重投**（`hadOutput`）。
     * 吐了一半才断的，重投等于让人收到两条半截话——
     * 那不是「间隔太短」，那是自己制造重复回复。
     */
    const cfg = loadConfig();
    const retryCfg = upstreamRetry ?? cfg?.chat?.upstreamRetry ?? {};
    /**
     * `attempts` 的语义是「**补**几次」，不是「总共几轮」。
     *
     * attempts=1 → 失败后再补 1 轮，总共 2 轮。
     * 所以循环上界是 attempts + 1，写成 attempts 就等于没补过——
     * 这个坑我踩过一次：配置写着 attempts:1，实际一轮都没补。
     */
    const extraAttempts = retryCfg.enabled === false ? 0 : Math.max(0, Number(retryCfg.attempts) || 0);
    const totalAttempts = extraAttempts + 1;
    const delayMs = Math.max(0, Number(retryCfg.delayMs) || 3000);

    /**
     * **总时限**。
     *
     * 每一次 attempt 各自有 `timeoutSec`（默认 150 秒）的超时，
     * 补一次重试就变成 150 + 3 + 150 = 303 秒——
     * 而 ai-chat 那边只等 180 秒。超了它就报「宿主没回话」，
     * 我们这边回得再晚也没意义（群里已经两条都发过了）。
     *
     * 所以留一个**整体预算**：默认 170 秒（比 ai-chat 的 180 留 10 秒余量），
     * 重投前先看还剩多少，够才投。
     */
    const budgetMs = Math.max(0, (Number(retryCfg.budgetSec) || 170) * 1000);
    const startedAt = Date.now();

    let lastErr = null;
    for (let i = 1; i <= totalAttempts; i++) {
      try {
        return await attempt();
      } catch (e) {
        lastErr = e;
        if (e?.kind !== 'upstream' || i >= totalAttempts) throw e;
        if (e.hadOutput) {
          logger.warn('这一轮已经吐过字，不重投（避免重复回复）');
          throw e;
        }
        const elapsed = Date.now() - startedAt;
        const left = budgetMs - elapsed;
        if (left <= delayMs + 5000) {
          logger.warn(
            `模型服务不可用，但总时限只剩 ${Math.round(left / 1000)}s，不够再投一轮（会撞穿 ai-chat 的 180s 等待）`,
          );
          throw e;
        }
        logger.warn(
          `模型服务不可用（第 ${i}/${totalAttempts} 轮，${e.status || '?'}），${delayMs}ms 后重投一轮`,
        );
        await new Promise((r) => {
          const t = setTimeout(r, delayMs);
          t.unref?.();
        });
      }
    }
    throw lastErr;
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
