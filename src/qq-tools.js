/**
 * QQ 动作工具：把「发言」从**模型吐文本**变成**模型自己调工具**。
 *
 * 为什么值得改（抄的是 SurfCore 的 `reserved2` 模式，MIT）：
 *
 *   改造前的链路是「模型输出一整段 → 宿主 postReply → ai-chat 按长度切段发」。
 *   模型对这一轮**没有任何控制权**：它不能决定"分两句说"、
 *   不能说一半停下看看对方反应、也不能说完就明确退场。
 *
 *   改成工具之后：
 *     · `qq_send` 调一次 = 一段话。调几次由它自己定（上限 3 段）
 *     · `qq_close` = 明确收尾，不用再在正文里夹 `<<close:>>` 标记
 *     · 两者都不调 = 这一轮不说话（真正的"看了但不接"）
 *
 * 为什么不走主动发送接口（`channels.active().send`）：
 *   那是**主动消息**，私聊有 20 条/分、群里还要 `group_push` 授权，
 *   而我们正处在「对方刚说完话」的被动窗口里，用主动接口既浪费配额
 *   又可能被官方拒。所以这里走 `postReply(..., done:false)` ——
 *   同一个事件的多段回话，ai-chat 那边原生支持（`bridge.js` 的 `MAX_PARTS`）。
 *
 * **调几次就发几条**：`qq_send` 每调一次是一段，ai-chat 那边拿到的是
 * `parts` 数组（`bridge.js` 的 `MAX_PARTS`），会**逐条 `replyNow` 发出去**，
 * 不是拼成一段。这条链路 2026-10 改的，改之前多段会被 `planChunks` 合并
 * （它只在超过 1800 字时才切），"分两句说"等于没分。
 *
 * 上限对齐官方硬限制（群聊 5 次 / 单聊 4 次，见框架 `outbound.js` 的
 * `PASSIVE_MAX_REPLIES`）：ai-chat 侧预算按 `maxSegmentsOf(msg)` 分场景取，
 * `MAX_SEGMENTS = 5` 只是群聊口径兼段数硬顶；这里默认 3 是留余量。
 */

import { loadDefineTool, shapeTool } from './tools.js';
import { acceptClose } from './closing.js';
import { DOWNSTREAM_MARKERS } from './markers.js';

/**
 * 只有 ai-chat 才认识的标记（发图 / 发语音 / 按钮 / 语音条 / 静默）。
 *
 * 这些标记在**回复正文**里会被 ai-chat 的 `parseActions` 执行；
 * 但 `qq_send` 走的是 `/r/reply` 直发通道，那边**不做标记解析**，
 * 于是它们会被当成普通文字原样发进群。
 */
const DOWNSTREAM_RE = new RegExp(`<<\\s*(?:${DOWNSTREAM_MARKERS.join('|')})\\b`, 'i');

/** 单轮最多发几段。QQ 被动回复同一条消息只让回 5 次（msg_seq 1–5），留余量 */
export const MAX_PARTS = 3;

/**
 * openid 的合法形状：QQ 官方的 `member_openid` / `user_openid` 是
 * base64url 风格的长串（大写字母、数字，偶有 `-` `_`）。
 *
 * **必须白名单校验**：这个值最终会拼进 `<qqbot-at-user id="…" />` 的
 * 属性里，模型只要塞一个引号进来就能把标签拆坏，往群里吐半截 HTML。
 * 长度下限 8 是为了挡掉「@小明」这种把昵称当 id 传上来的情况。
 */
export const AT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 算出这段发言要不要带 @ 前缀。**纯函数**，所有判断都在这里，
 * 因为每条规则错了都是社交事故：
 *   · 私聊发 @ 标签 → 官方不支持，标签原样露出
 *   · 非第一段发 @ → 那段是纯文本消息，标签同样露出
 *   · markdown 关掉还发标签 → 同上
 *   · id 抄错 → 静默 @ 不到人，比报错更难查
 *
 * @param {object} o
 * @param {string} [o.at] 模型给的：`sender` 或原始 openid
 * @param {string} o.kind `group` / `c2c`
 * @param {boolean} [o.markdown] 通道当前是否走 markdown 消息类型（默认 true）
 * @param {number} [o.parts] 这一轮已经发了几段（0 = 这句是第一段）
 * @param {string} [o.senderId] 当前说话人的 openid
 * @param {string} [o.senderName] 当前说话人的昵称（降级成纯文字 @ 时用）
 * @returns {{prefix:string, note:string}} `note` 非空时带回给模型解释为什么没 @
 */
export function buildAtPrefix({ at, kind, markdown = true, parts = 0, senderId = '', senderName = '' } = {}) {
  const want = String(at ?? '').trim();
  if (!want) return { prefix: '', note: '' };

  // 官方文档：群聊 @用户 只在 markdown 消息里生效，文字子频道才支持文本消息
  if (kind !== 'group') {
    return { prefix: '', note: '私聊里没有 @ 这回事（官方只在群聊的 markdown 消息里支持），这句按普通消息发了' };
  }

  /**
   * `qq_send` 每调一次是一段独立消息，而 ai-chat 那边**只有第一段**
   * 走 `replyMarkdown`（`outbound.js` 的 `i === 0 && markdown`）。
   * 所以第二段起拼标签等于往群里贴源码。
   */
  if (parts > 0) {
    return { prefix: '', note: '@ 只能挂在这一轮的第一段上，这句没 @（想 @ 就把那句话放第一段）' };
  }

  const id = want === 'sender' ? String(senderId ?? '').trim() : want;
  if (!id) return { prefix: '', note: '不知道要 @ 谁（这一轮没拿到对方的 openid）' };

  if (!AT_ID_RE.test(id)) {
    return { prefix: '', note: `「${id.slice(0, 40)}」不像 openid（要填消息头括号里那串，或者填 sender），没 @` };
  }

  /**
   * markdown 关着的时候不能拼标签，但也不能什么都不做——
   * 模型以为 @ 到了、用户什么都没看到，是最难查的那种。
   * 降级成纯文字的 `@昵称 `：至少人能看懂在跟谁说话。
   */
  if (markdown === false) {
    const name = String(senderName ?? '').replace(/[\s@]/g, '').slice(0, 24);
    if (!name) return { prefix: '', note: 'markdown 关着，@ 发不出去（也没昵称可以退成纯文字）' };
    return { prefix: `@${name} `, note: `markdown 关着，@ 退化成纯文字「@${name}」（要真 @ 到人得在 ai-chat 面板打开 markdown）` };
  }

  return { prefix: `<qqbot-at-user id="${id}" />\n`, note: '' };
}

/**
 * `qq_send_file`：把本地文件发出去。
 *
 * 为什么是**工具**而不是正文里的 `<<file: 路径>>` 标记（腾讯官方
 * `dsh-qqbot` 的 `qqbot_send_file` 也是工具形态，不是巧合）：
 *   ① 路径里有空格、中文、反斜杠，靠正则对抗迟早出岔子；
 *   ② `qq_send` 逐段发时每段只取 `parseActions().text`，标记会被摘掉而
 *      **不进 media** —— 文件静默消失（2026-11-02 记过的真事，图片同此病）；
 *   ③ 工具能当场回「这个文件不存在」，标记方案只能靠事后翻日志。
 *
 * 参数只收路径：发给谁由宿主从这一轮的消息上下文取（`callerOf` 的 payload）。
 * 不让模型填 openid —— 那是二十多位随机串，抄错一位官方照样 200，
 * 只是没人收到，比报错难查得多。
 *
 * @param {object} o
 * @param {() => {hasPayload:boolean}} o.caller
 * @param {(path:string, opts:{name:string}) => Promise<object>} o.fileOf
 */
function buildSendFileDef({ caller, fileOf }) {
  return {
    name: 'qq_send_file',
    description:
      '把一个**已经存在**的本地文件发给对方（图片、文档、表格、压缩包都行，按扩展名自动分类）。'
      + '参数给绝对路径，比如 C:\\Users\\me\\Desktop\\报告.docx 或 /home/me/a.pdf。'
      + '一轮最多发 1 个，文件夹不行——要发多个就分几轮说。'
      + '路径要来自你真正看到过的文件（列过目录、刚生成过），**不要凭印象拼**。'
      + '文件不存在会当场告诉你；所以别先答应对方「马上发给你」，试过再说。',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: '文件的绝对路径（带扩展名）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /** 必须是内容块数组——返回字符串会让 DSH 在结果投影处炸掉 */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ file_path } = {}) {
      const c = caller();
      if (!c.hasPayload) {
        return {
          ok: false,
          message: '这一轮是主动开口，没有"正在回的那条消息"，发不了文件。',
        };
      }
      const p = String(file_path ?? '').trim();
      if (!p) return { ok: false, message: '要发哪个文件？给绝对路径。' };
      try {
        return await fileOf(p);
      } catch (e) {
        return { ok: false, message: `发文件失败：${e?.message ?? e}` };
      }
    },
  };
}

/**
 * 拼工具定义。抽成纯函数是为了能单测——
 * 次数上限和「群聊不能收尾」这类判断写错，表现是刷屏或者群里莫名退场，
 * 都是只能靠线上观察才会发现的那种错。
 *
 * @param {object} o
 * @param {() => {chatId:string, kind:string, said:string, hasPayload:boolean, bucket:string}} o.callerOf
 *        当前这一轮是谁、在哪儿说（每轮变，所以必须是函数）
 * @param {(text:string)=>Promise<{ok:boolean, message?:string}>} o.sendOf
 * @param {(r:{chatId:string, point:string, resume:string, kind:string})=>{ok:boolean, why:string}} o.closeOf
 * @param {() => object} o.cfgOf
 * @param {() => {parts:number}} o.stateOf 本轮已发段数
 */
export function buildQqToolDefs({ callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf }) {
  const caller = () => callerOf?.() || { chatId: '', kind: '', said: '', hasPayload: false, bucket: '' };
  const maxParts = () => {
    const n = Number(cfgOf?.()?.qqTools?.maxParts);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : MAX_PARTS;
  };

  const send = {
    name: 'qq_send',
    description:
      '把一段话发出去。想分两句说就调两次（每次一段），想只回一句就调一次。'
      + `一轮最多 ${maxParts()} 段，调多了会被拒。`
      + '**调过这个工具之后，回复正文就不会再自动发出去了**（正文只当思考用）——'
      + '所以要么调工具、要么直接写正文，别两边都写。不想说话就一次都别调。'
      + '**这条通道只发文字**：不要在这里写 `<<say: …>>` 之类的语音标记，'
      + '标记会被原样发进群里。要发语音就写在回复正文里，这一轮别调这个工具。',
    /** 扁平参数表（DSH defineTool 原生形状），普通注册时由 `shapeTool` 转换 */
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要发出去的话。口语、简短；一段一个意思，别把两件事塞进一段',
      },
      /**
       * @ 人。**只给「要 @ 谁」，不给「怎么拼标签」**——
       * 标签由宿主拼，模型碰不到那串 id 的语法。
       *
       * 为什么不让模型自己写 `<qqbot-at-user id="…"/>`：openid 是二十多位的
       * 随机串，抄错一位官方不报错、只是 @ 不到人，线上根本看不出来。
       * 而模型只要吐 `sender` 就行，错了宿主还能拦住并告诉它。
       */
      at: {
        type: 'string',
        description:
          '要 @ 谁。**群聊里默认不填**（不 @）——正常接话、闲聊、连续对话都不 @。'
          + '只有需要明确点名某个人时才填："sender" = @ 刚说话的那个人，'
          + '或填消息头括号里那串 openid。'
          + '只有群聊、只有这一轮第一段有效。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /** 必须是内容块数组——字符串会让 DSH 的 content.some 炸掉（0.9.x 的真实事故） */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ text, at } = {}) {
      const t = String(text ?? '').trim();
      if (!t) return { ok: false, message: '要说什么？' };
      /**
       * 下游标记在这条通道上发不出去，必须拦住。
       *
       * `<<say>>` / `<<image>>` / `<<voice>>` / `<<button>>` / `<<silence>>`
       * 都是 **ai-chat** 解析的，而它只解析「模型最终回复的正文」；
       * `qq_send` 走的是 `/r/reply` 直发通道，那边**不做标记解析**。
       * 于是这些标记会被当成普通文字原样发进群——用户看到 `<<say: …>>`
       * 或者一个本地文件路径，模型却以为语音/图片已经发出去了
       * （2026-11-03 线上真实发生，用户当场问「为什么发出来的是文字」）。
       *
       * 不能「剥掉标记照发」：那只是把「标记泄漏」换成「该发语音却发了
       * 文字」，模型依然不知道自己用错了通道，下次还这么干。直接拒绝，
       * 并把正确写法说清楚，让它这一轮改用正文。
       */
      if (DOWNSTREAM_RE.test(t)) {
        return {
          ok: false,
          message: '语音条 / 图片 / 按钮这类标记不能通过 qq_send 发：这条通道只发文字，'
            + '标记会原样出现在群里。要发这些东西，就把标记写在**回复正文**里'
            + '（正文会自动执行），并且这一轮不要调 qq_send。',
        };
      }
      const c = caller();
      /**
       * 没有"正在回的那条消息"时**引导她改用正文**，别让她以为这轮不能说话。
       *
       * 这句文案原本是「不该发生，记一下」——对模型毫无帮助：它看到"失败"，
       * 按提示里的 `<<skip>>` 就放弃了，一轮模型调用白花。线上真实发生过
       * （主动搭话那一轮调了 `qq_send`）。
       *
       * 正常情况下宿主已经在这一轮把 `qq_send` 收走了（`restrictTurnTools` 的
       * `denyExtra: AWAKE_DENY_TOOLS`），走到这里说明收工具失败了（版本差异）——
       * 那至少别让她白白放弃。
       */
      if (!c.hasPayload) {
        return {
          ok: false,
          message: '这一轮是主动开口，没有"正在回的那条消息"。'
            + '直接把要说的话写成正文就行，不要用这个工具。',
        };
      }

      const st = stateOf?.() || { parts: 0 };
      if (st.parts >= maxParts()) {
        return {
          ok: false,
          message: `这一轮已经发了 ${st.parts} 段，上限 ${maxParts()} 段。剩下的并进上一段，或者别说了。`,
        };
      }

      try {
        /**
         * 每次 `qq_send` 调用生成一个幂等键（阶段 5）。
         *
         * **每次新生成，不复用**——模型重试是一次新调用，它可能就是想再说一遍。
         * 这个 id 的用途是让账本记得住「这一段发没发出去」，
         * 而不是拦模型重试。
         */
        const requestId = `qs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const r = await sendOf(t, { at: String(at ?? '').trim(), requestId });
        if (!r?.ok) return { ok: false, message: r?.message || '没发出去' };
        /**
         * 宿主可能**没 @ 成**（私聊 / 非第一段 / markdown 关 / id 不像）。
         * 这种情况不能只说「发出去了」——模型会以为 @ 到了，
         * 下一句继续用同样的方式，错到底。
         */
        return {
          ok: true,
          part: st.parts + 1,
          note: r.note || '发出去了，正文不用再写一遍',
        };
      } catch (e) {
        return { ok: false, message: `发送失败：${e?.message ?? e}` };
      }
    },
  };

  const close = {
    name: 'qq_close',
    description:
      '给这段对话收个尾：记一句「收在哪、下次怎么接」，**不发言、不动记忆**。'
      + '对方说要睡了/要出门、或者话题自然聊完了的时候用。'
      + '**对方还在问你问题时不要用**；只有私聊能用。'
      + '收尾之后这一轮可以什么都不发。',
    parameters: {
      point: { type: 'string', required: true, description: '这段聊到哪儿停的，一句话' },
      resume: { type: 'string', description: '下次可以怎么接，一句话（可省）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ point, resume } = {}) {
      const c = caller();
      /**
       * 三条拒绝跟标记那条路**共用同一个函数**（`acceptClose`）。
       *
       * 为什么不让工具和标记各判一套：两条路各写一份判断，
       * 迟早会出现「标记收尾被拒、工具收尾却成功」这种事，
       * 而用户只会觉得"她有时候讲道理有时候不讲"。
       */
      const gate = acceptClose({ point, kind: c.kind, said: c.said });
      if (!gate.ok) return { ok: false, message: gate.why };

      try {
        const r = closeOf({
          chatId: c.chatId,
          point: String(point).trim(),
          resume: String(resume ?? '').trim(),
          kind: c.kind,
        });
        if (!r?.ok) return { ok: false, message: r?.why || '没记上' };
        return { ok: true, message: '收尾记下了。这一轮可以不说话，也可以只说一句。' };
      } catch (e) {
        return { ok: false, message: `收尾失败：${e?.message ?? e}` };
      }
    },
  };

  return [
    send,
    close,
    /**
     * 没给 `fileOf` 就**不注册**这个工具，而不是注册一个调了就炸的壳子。
     *
     * 提示词那边是按「清单里有没有 `qq_send_file`」决定要不要教模型用它，
     * 所以这里少注册一个，等于自动闭嘴；注册了却是坏的，就是「教了它一个
     * 必然失败的操作」——那种一轮模型调用直接白花。
     */
    ...(typeof fileOf === 'function' ? [buildSendFileDef({ caller, fileOf })] : []),
  ];
}

/**
 * 把 QQ 动作工具挂到一个 agent 上。
 *
 * 失败**不抛错**——工具是增强，装不上不能让整轮对话挂掉；但必须把原因带出去
 * （面板要能看见"没装上"，静默失败等于死代码）。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, mode?:string, off?:Function}>}
 */
export async function registerQqTools({ agent, callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, log = () => {} }) {
  const defs = buildQqToolDefs({ callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf });
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    /**
     * 同 tools.js：用 **agent 的** ctx，不是插件的 ctx。
     * 插件的 `inject` 里千万别加 `'tools'`——声明不存在的服务会让整个插件激活失败。
     */
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }

  const defineTool = await loadDefineTool();
  const made = [];

  for (const def of defs) {
    try {
      const tool = shapeTool(def, defineTool);
      const off = registry.register(tool);
      made.push({ off, name: def.name });
    } catch (e) {
      log(`QQ 工具 ${def.name} 没装上：${e.message}`);
      return {
        ok: false,
        names: made.map((m) => m.name),
        reason: `${def.name} 注册失败：${e.message}${defineTool ? '' : '（拿不到 @deepseek-ai/dsh-tools，交的是普通对象）'}`,
      };
    }
  }

  return {
    ok: true,
    names: made.map((m) => m.name),
    mode: defineTool ? 'defineTool' : 'plain',
    off: () => {
      for (const m of made) {
        try {
          m.off?.();
        } catch {}
      }
    },
  };
}
