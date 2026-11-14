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
import { buildGroupToolDefs } from './group-tools.js';

/**
 * `qq_send` 里**仍然要拦**的标记：`say` / `button` / `silence`。
 *
 * 为什么以前连 `image` / `voice` 也拦：注释里写的理由是「直发通道不做解析，
 * 标记会原样进群」。**这条理由不成立**——`sendOf` 走 `postReply()`，
 * 最终仍会跑一遍动作标记解析，标记会被消费掉，不会漏给用户。
 *
 * 拦它们的真实代价（2026-11 外部实测）：DSH 模式下模型主要在 `qq_send` 里说话，
 * 而「调过 qq_send，回复正文就不会再发出去」——于是**图片和语音根本没有
 * 能到达出站动作层的通道**：写正文被丢弃，写 qq_send 被工具拒。用户那边是靠
 * 改这里（放行 image/voice）绕过去的，属于在补我们的洞。
 *
 * 所以现在放行 `image` / `image-alone` / `voice`（都由出站动作层解析执行）。
 * `<<card:>>` 一并放行：它是**独立一条消息**（`channel.send({ card })`），
 * 不依赖分段里的 markdown / keyboard，不存在上面那三个的未验证行为。
 * 剩下三个继续拦，理由各不相同：
 *   · `say`：本机 TTS 关掉时 ai-chat 会把它摘掉，有正文的情况下那句话
 *     会彻底消失（只留一行 warn）。宁可在工具这一层明确拒绝，让模型改用
 *     `<<voice: 路径>>`，也不要静默吞掉用户本该听到的话。
 *   · `button` / `silence`：只在正文链路上验证过，`qq_send` 分段时挂按钮 /
 *     设静默没有真机结论，先不放开。
 *
 * 标准 markdown 图片 `![说明](路径)` 仍然拦：模型侧协议已经换成标记，
 * 写 markdown 属于旧习惯；这里给一个明确错误（并告诉它正确写法）比
 * 让它猜「为什么图没出来」好。
 */
const SEND_BLOCKED = ['say', 'button', 'silence'];
const DOWNSTREAM_RE = new RegExp(`<<\\s*(?:${SEND_BLOCKED.join('|')})\\b`, 'i');
const INLINE_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/;

/** 单轮最多发几段。QQ 被动回复同一条消息只让回 5 次（msg_seq 1–5），留余量 */
export const MAX_PARTS = 3;

/**
 * 段数上限的唯一来源。
 *
 * 工具（`qq_send` 的拒绝判据 + 描述）和提示词里的「一轮最多 N 段」
 * **必须用同一个值**。以前提示词写死 3、这里读配置：配置大于 3 时模型白
 * 浪费两格；配置小于 3 时更糟——模型按 3 组织内容，第 3 段被工具拒掉，
 * 用户只觉得「话说一半没了」，而且不报错（2026-11 外部实测）。
 *
 * 上限夹到 8：再大就会撞「被动回复 5 次」的硬顶，调上去也没用。
 *
 * @param {object} [cfg] 完整配置（只读 `qqTools.maxParts`）
 * @param {string} [kind='group'] 会话类型；被动回复硬上限是群 5 / 私聊 4
 * @returns {number}
 */
export function maxPartsOf(cfg, kind = 'group') {
  const hardMax = kind === 'c2c' ? 4 : 5;
  const n = Number(cfg?.qqTools?.maxParts);
  return Number.isFinite(n) && n > 0 ? Math.min(n, hardMax) : Math.min(MAX_PARTS, hardMax);
}

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
    return { prefix: `@${name} `, note: `markdown 关着，@ 退化成纯文字「@${name}」（要真 @ 到人得走 markdown 出口）` };
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
export function buildQqToolDefs({ callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, groupOf, ledgerOf = null, sessionOf = null }) {
  const caller = () => callerOf?.() || { chatId: '', kind: '', said: '', hasPayload: false, bucket: '' };
  const maxParts = () => maxPartsOf(cfgOf?.(), caller().kind);

  const send = {
    name: 'qq_send',
    description:
      '把一段话发出去。想分两句说就调两次（每次一段），想只回一句就调一次。'
      + '一轮上限按当前会话和配置执行，超额会被拒；以本轮系统提示中的具体段数为准。'
      + '**调过这个工具之后，回复正文就不会再自动发出去了**（正文只当思考用）——'
      + '所以要么调工具、要么直接写正文，别两边都写。不想说话就一次都别调。'
      /**
       * 图片和语音**必须在这一段里说清楚能写**。
       *
       * 以前这里写的是「只发文字，别写标记」——在 DSH 模式下的实际后果是
       * 图片永远发不出去：正文被丢弃（上一句刚承诺的），`qq_send` 又不让写。
       * 标记由出站动作层解析，不会原样进群，所以这里放开 image/voice。
       */
      + '这一段里可以带图片和语音标记：`<<image: 路径>>` 让图和这句话排在同一条，'
      + '`<<image-alone: 路径>>` 单独发一条图，`<<voice: 路径>>` 发语音条。'
      + '分享视频 / 文章时写 `<<card: 标题|描述|https://链接|https://图片地址>>`：'
      + '卡片单独占一条消息，四项都要有、链接和图片地址必须是 https，一轮最多一张。'
      + '但 `<<say: …>>` 不要写在这里——宿主 TTS 关着时它会被丢掉，'
      + '改用 setsuna-tts 合成后拿路径写 `<<voice: …>>`。',
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
       * 只剩 `say` / `button` / `silence` 要拦（`image` / `image-alone` /
       * `voice` 已放行，见 `SEND_BLOCKED` 上方那段口径）。
       *
       * 拒绝而不是「剥掉照发」：剥掉只是把「标记泄漏」换成「该发语音却发了
       * 文字」，模型依然不知道自己用错了通道。直接拒绝并把正确写法说清楚，
       * 让它这一轮就改过来。
       */
      if (DOWNSTREAM_RE.test(t) || INLINE_IMAGE_RE.test(t)) {
        return {
          ok: false,
          message: '`<<say>>` / `<<button>>` / `<<silence>>` 不能通过 qq_send 发，'
            + '标准 markdown 图片 `![](路径)` 也不行。'
            + '图片用 `<<image: 路径>>`（和这句话同条）或 `<<image-alone: 路径>>`（单独一条），'
            + '语音用 `<<voice: 路径>>`——这三个写在**同一次 qq_send 的 text 里**就行，'
            + '不要改写成正文（调过 qq_send 之后正文不会发出去）。',
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
    /** 群管：和发言工具一起挂，但实现放在 group-tools.js（语义不同，也都依赖外接协议） */
    ...(typeof groupOf === 'function'
      ? buildGroupToolDefs({ groupOf, callerOf, ledgerOf, sessionOf, cfgOf })
      : []),
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
export async function registerQqTools({ agent, callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, groupOf, ledgerOf = null, sessionOf = null, log = () => {} }) {
  const defs = buildQqToolDefs({ callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, groupOf, ledgerOf, sessionOf });
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
