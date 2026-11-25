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
 * 从 assistant 消息里把「思考」块拼起来。
 *
 * 推理型模型会把草稿写在 reasoning（有的版本叫 thinking）块里，正文块可能
 * 整轮都是空的。这里只**采集**，要不要拿它当话发出去由 `rescueFromThinking`
 * 和开关决定——采集本身不影响任何现有行为。
 */
export function reasoningOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b && (b.type === 'reasoning' || b.type === 'thinking') && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * 从思考里捞出「定稿」。
 *
 * 只认行数 / 定稿标记后面那段——模型常见的写法是「Reply: 起草 → Careful: 自检
 * → 3 lines: 定稿」，只有最后那版才是过完自检、准备说出口的。**没有标记就
 * 返回空**：宁可这一轮不发，也不能把草稿或内心独白当成她的话发到群里。
 */
const FINAL_MARK_RE = /(?:^|\n)[ \t]*(?:最终(?:回复)?|定稿|Final|(?:[0-9０-９]+|[一二三四五六七八九十两]+)[ \t]*(?:lines?|行))[ \t]*[:：]/gi;
const TRAILING_RE = /\n[ \t]*(?:Careful|Note|Watch|Beware|自检|注意)[ \t]*[:：]/i;

export function rescueFromThinking(thinking) {
  const s = String(thinking || '').trim();
  if (!s) return '';
  /** 定稿可能改过几版，取最后一个标记之后的内容 */
  let last = null;
  for (const m of s.matchAll(FINAL_MARK_RE)) last = m;
  if (!last) return '';
  const body = s.slice(last.index + last[0].length);
  /** 定稿后面又跟了一段自检/旁白时截掉：那不是要说的话 */
  const cut = body.search(TRAILING_RE);
  return (cut >= 0 ? body.slice(0, cut) : body).trim();
}

/**
 * 这一条 assistant 消息里有没有工具调用块。
 *
 * **只看结构，不猜语义**：DSH 的 `message.content` 是块数组，工具轮就是
 * text + tool-call 混排。`tool-call` / `tool_use` 两种写法都认（不同版本
 * 的 DSH 用过不同名字）。
 */
export function hasToolCall(message) {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some((b) => b && (b.type === 'tool-call' || b.type === 'tool_use'));
}

/**
 * 同一轮里多条 assistant 消息的正文合并。
 *
 * DSH 的 `assistant/message` 在一轮里**可能来多次**：工具调用前后各一次，
 * 纯对话轮也可能「先问一句、再给结论」。这里以前是无脑覆盖 `w.text = t`，
 * 于是后一种情况只剩结论，提问那一段整段丢了（2026-11-25 用真实
 * turn runner 复现：两段正文只返回后者，用户看到的就是「她答了但没接上话」）。
 *
 * 合并规则与 aurabot 的 `mergeStepText` 一致——**只去重拼接，不改措辞**：
 *   · 新段为空 → 保留旧的（空消息不算说话）
 *   · 相等 / 旧段以新段结尾 → 保留旧的（同一句话）
 *   · 新段已包含旧段 → 用新段（模型重写了完整版，旧的是半截）
 *   · 否则换行拼接
 */
export function mergeStepText(prev, next) {
  const a = String(prev || '').trim();
  const b = String(next || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (a === b || a.endsWith(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n\n${b}`;
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

export function createTurnRunner({ ctx, log = () => {}, timeoutSec = 150, upstreamRetry = null, rescueEnabled = () => false }) {
  /**
   * 一轮时限允许传函数：host 传的是「现读 cfg 的箭头函数」。
   * 面板把 `chat.turnTimeoutSec` 露出来之后，只在插件启动时读一次的话，
   * 改了要重启才生效；传数字的老调用方（和它的测试）行为不变。
   */
  const timeoutMsOf = () => {
    const n = Number(typeof timeoutSec === 'function' ? timeoutSec() : timeoutSec);
    return (Number.isFinite(n) && n > 0 ? n : 150) * 1000;
  };
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

  /**
   * `text` 是这一轮**最后一条**正文，`merged` 是整轮拼接（见 `mergeStepText`），
   * `sawToolCall` 决定 turn/end 用哪一份（工具轮只认最后一条）。
   *
   * @type {Map<string, {turn:number, text:string, merged:string, sawToolCall:boolean, afterToolCount:number, afterToolText:string, thinking:string, resolve:Function, reject:Function, timer:any}>}
   */
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
    /**
     * 这个回调是 Cordis 的 session observer：里面抛出去的任何东西都会经
     * `Session.commit → ReactLoopAgent.turn` 冒泡成 DSH 的
     * `fatal load failure`，**把整个宿主进程干掉**。一轮模型报错就该只是
     * 这一轮失败，绝不能连带崩宿主。所以整段包住，异常只记日志 + 解掉
     * 等待者，不往外抛。
     */
    try {
      const sid = session?.id;
      if (!sid || !waiters.has(sid) || !event) return;

      if (event.type === 'assistant/message') {
        const d = event.data || {};
        // 被打断的那条不算数
        if (d.interrupted) return;
        const w = waiters.get(sid);
        if (!w) return;
        /**
         * 换轮了就清零。`waiters` 按会话复用，上一轮的累积不能混进来——
         * 旧代码是 `w.text = t` 顺带覆盖，累积之后必须显式重置。
         */
        if (w.turn !== d.turn) {
          w.turn = d.turn;
          w.text = '';
          w.merged = '';
          w.sawToolCall = false;
          w.afterToolCount = 0;
          w.afterToolText = '';
          w.thinking = '';
        }
        /** 思考块先收：纯思考、没正文的那条消息以前会在这里被 `if (!t) return` 丢掉 */
        const th = reasoningOf(d.message);
        if (th) w.thinking = th;
        const toolCall = hasToolCall(d.message);
        if (toolCall) {
          w.sawToolCall = true;
          /** 工具调用那条里带的文字是过程话（「我先查一下」），不算工具之后的正文 */
          w.afterToolCount = 0;
          w.afterToolText = '';
        }
        const t = textOf(d.message);
        // 只有工具调用的消息没有正文：不算说话，但上面的 sawToolCall 已经记下
        if (!t) return;
        w.text = t;
        w.merged = mergeStepText(w.merged, t);
        if (w.sawToolCall && !toolCall) {
          /**
           * 工具之后连着吐了几段正文（没走 qq_send）：这些才是最终答复，
           * 只取最后一段又会丢前半截——与本轮修的纯对话轮丢段是同一类问题。
           */
          w.afterToolCount = (w.afterToolCount || 0) + 1;
          w.afterToolText = mergeStepText(w.afterToolText || '', t);
        }
        return;
      }

      if (event.type === 'turn/end') {
        const d = event.data || {};
        const w = waiters.get(sid);
        if (!w) return;
        /**
         * 只认「这一轮」的文本，上一轮残留的不要。取哪一份要看这一轮的形态：
         *
         *   · 纯对话轮（一轮里没出现工具调用）→ **合并后的全文**。模型先说
         *     一句、再说结论时两段都要发，这就是本轮修的那个丢段。
   *   · 工具轮 → 工具调用那条里的话是过程话（「我先查一下」），不算；
   *     **工具之后只吐了一段**就取那一段，连着吐了几段才拼起来。
   *     真正要说的话通常走 `qq_send` 逐段发（host.js 用 `used.texts.join`），
   *     这份返回只是兜底：既不能把旁白发到群里，也不能再把最终答复的前半段丢掉。
         */
        let text = '';
        if (w.turn === d.turn) {
          if (!w.sawToolCall) text = w.merged || w.text;
          else if ((w.afterToolCount || 0) > 1) text = w.afterToolText || w.text;
          else text = w.text;
        }
        /**
         * 整轮一段正文都没有、但思考里写了定稿：开了开关就捞出来发。
         * 捞不到仍走 `empty`（现有兜底：这一轮记日志、不再发消息）。
         *
         * `w.turn === d.turn` 不能少：`w.thinking` 是**按消息覆盖**的最后一份，
         * 迟到的旧轮 end 事件如果不校验轮次，会把新一轮的思考当旧轮的定稿发出去。
         */
        if (!text && w.turn === d.turn && d.reason?.kind === 'completed' && rescueEnabled()) {
          const rescued = rescueFromThinking(w.thinking);
          if (rescued) {
            logger.info(`正文为空，从思考里捞回 ${rescued.length} 字`);
            text = rescued;
          }
        }
        finish(sid, d.reason?.kind === 'completed', text, d.reason);
      }
    } catch (e) {
      logger.warn(`session/event 回调异常（已吞掉，不让它冒泡成 fatal）：${e?.message ?? e}`);
      const sid = session?.id;
      const w = sid ? waiters.get(sid) : null;
      if (w) {
        waiters.delete(sid);
        if (w.timer) clearTimeout(w.timer);
        try { w.reject(e); } catch { /* 已经解过就算了 */ }
      }
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
  async function run(agent, text, { source = { kind: 'roost' }, images = [], timeoutMs = 0, flush = true } = {}) {
    /**
     * 单次尝试的超时。
     *
     * 默认用实例化时的 `timeoutSec`（150 秒）；排队那边会在剩余预算不多时
     * 传一个更小的值——**只查「剩余 31 秒」就放进去跑 150 秒，等于没查**。
     * 注意这是**每次 attempt** 的上限，重试仍按 `retryCfg` 走。
     */
    const attemptMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : timeoutMsOf();
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
      }, attemptMs);
      timer.unref?.();
      waiters.set(sid, {
        turn: -1, text: '', merged: '', sawToolCall: false,
        afterToolCount: 0, afterToolText: '', thinking: '', resolve, reject, timer,
      });
    });
    /**
     * 2026-11-14：一轮失败的 rejection 在被 `await` 接住之前，DSH 会把它当
     * 未处理异常并判 `fatal load failure`（宿主进程直接退出）。挂一个空
     * handler 只是告诉 Node「这个 rejection 有人管」，不改变原 promise 的
     * 状态——`run()` 里 `await promise` 照样拿得到错误。
     */
    promise.catch(() => {});

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
      /**
       * `flush` 只对「宿主自己维护的 QQ 会话」有意义。独立会话（/v1/agent.*）
       * 拿到的 `agents.create()` handle 在 DSH 里可能已经是 closed，硬 flush 会抛
       * `session "xxx": flush on a closed handle`，整轮直接 502。aurabot 的
       * `runSystemTurn` 也只 followup、不 flush —— 事件驱动的一轮不需要它。
       * 默认 true，QQ 私聊那六个调用点行为不变。
       */
      if (flush) await ctx.sessions?.flush?.(agent.session);
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

  /**
   * 私聊插话（照 aurabot 的 steer）：把新消息塞进**正在跑的那一轮**，
   * 不新开 turn/end。DSH 原生支持 `agent.steer()`——aurabot 作为同类 DSH
   * 插件已经在用（`chat/hub.js` 的 pushToSession），dsh-roost 拿到的 agent
   * 是同一个类型，同样能用。
   *
   * 三个前提缺一就返回 false，让调用方退回「攒着等这一轮结束再开新轮」：
   *   · 拿得到 sid
   *   · agent 真的有 steer（老版本 DSH 没有 → 自动降级）
   *   · 这一轮真的在跑（waiters 有它）——空闲时 steer 不会开新轮，等于丢消息
   *
   * `waitReadyMs`：忙时插话有个时序坑——merger 在 flush 那一刻就置了 busy，
   * 但 waiters.set 要等投递链（deliverBatch → handleTurn → run → attempt）
   * 走完才发生。突发第二条消息往往先到，若立刻判 waiters 就会白降级成攒批，
   * 体感上「私聊插话」几乎永不触发。给一个短轮询窗口等锁就绪，超时再降级。
   * 默认 0：老调用方（和单测）不传就没有等待，行为不变。
   *
   * @returns {Promise<boolean>} 插话成功与否（成功则这条消息已被这一轮接走）
   */
  async function steer(agent, text, { chatId = '', source = { kind: 'roost' }, waitReadyMs = 0 } = {}) {
    const sid = agent?.session?.id ?? agent?.sessionId;
    if (!sid) return false;
    if (typeof agent.steer !== 'function') return false;
    const key = String(sid);
    if (!waiters.has(key) && Number(waitReadyMs) > 0) {
      const deadline = Date.now() + Number(waitReadyMs);
      while (!waiters.has(key) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    if (!waiters.has(key)) return false;
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(text ?? '') }],
      source: { ...source, chatId },
    };
    try {
      await agent.steer(message);
      return true;
    } catch (e) {
      logger.warn(`插话失败（这轮结束后照常处理）：${e?.message ?? e}`);
      return false;
    }
  }

  return {
    run,
    steer,
    /**
     * 这个会话有没有一轮在跑。
     *
     * 给「主动搭话/觉醒让路」用：它们不入队，只能问锁本身。
     * **参数必须是 sid**（`waiters` 的键就是它），传 chatId 会恒为 false——
     * 而新会话首轮时队列的 key 恰好就是 chatId，两者长得一样，最容易写错。
     */
    isWaiting(sid) {
      return waiters.has(String(sid ?? ''));
    },
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
