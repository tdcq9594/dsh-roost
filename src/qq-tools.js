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
 *     · `qq_send` 调一次 = 一段话，按需要可以分多次
 *       （代码不设硬上限；提示词只说明用法，不写「不限」也不下节约指令）
 *     · `qq_close` = 明确收尾，不用再在正文里夹 `<<close:>>` 标记
 *     · 两者都不调 = 这一轮不说话（真正的"看了但不接"）
 *
 * 为什么不走主动发送接口（`channels.active().send`）：
 *   那是**主动消息**，私聊有 20 条/分、群里还要 `group_push` 授权，
 *   而我们正处在「对方刚说完话」的被动窗口里，用主动接口既浪费配额
 *   又可能被官方拒。所以这里走 `postReply(..., done:false)` ——
 *   同一个事件的多段回话由宿主逐条投递。
 *
 * **调一次就是一条独立消息**：`qq_send` 每调一次是一段，宿主按段发出去，
 * 不是拼成一段。这条链路 2026-10 改的，改之前多段会被 `planChunks` 合并
 * （它只在超过 1800 字时才切），"分两句说"等于没分。
 *
 * 段数不设本地上限。官方 2026-11-17 起群消息在开发者为群主 / 管理员时每条可达
 * 50 次，框架侧超限会自动改发主动消息；单聊官方仍是 4 次回话，同样由框架改发
 * 主动消息。dsh-roost 再卡一道只会把话说一半：2026-11 实测配置写着 3 段时，
 * 第 4 段被工具拒掉，而模型写在正文里的收尾又不会再发——用户只看到半截话。
 * 所以这里彻底不拦，由模型和平台额度自己收口。
 * 提示词只做中性描述：一次一段、按需多次。不写「不限」，也不额外下节约指令。
 */

import { loadDefineTool, shapeTool } from './tools.js';
import { acceptClose } from './closing.js';
import { buildGroupToolDefs } from './group-tools.js';
import { searchScopeOf } from './search-scope.js';
import { cleanOutbound } from './outbound-clean.js';

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

/**
 * `qqTools.maxParts` 已作废：老配置里可能还躺着 `3` / `50`，读到也忽略。
 * 段数不再由 dsh-roost 限制（理由见文件头）；下次保存配置时该键会被 pruneTo 清掉。
 */

/**
 * 这个会话该不该挂 QQ 动作工具。
 *
 * 抽成纯函数而不是写在 `mount()` 里，是因为这条判据有两个真后果、必须能单测：
 *
 *   · **系统会话不挂**（2026-11-17）：`systemTurn()` 建的是 `system:*` 会话
 *     （巩固、频道日记的生成），它没有 QQ 场景。`qq_send` 会往一个不存在的
 *     chatId 发（静默失败）；更糟的是生成日记那一轮里模型手上有 `qq_post_thread`，
 *     能自己再发一篇 —— 变成"一次触发、两篇帖子"。
 *   · **总开关关着一律不挂**：`qqTools.enabled=false` 是主人的明确意思，
 *     不能因为会话类型不同就绕过。
 *
 * 自驱会话（`autotelic`）**不在这条判据里，因为它压根不经过 QQ 会话上下文**：
 * 挂载点是 `host.js` 的 `chat.kind`，而自驱走 `agentV1.prompt(sid, …)`，
 * 手里没有 `qq_send` / `qq_post_thread`。所以那边"绝不往主人私聊推"是**技术上成立**的，
 * 提示词里的「不要发任何 QQ 消息」只是第二道防线。
 * ⚠️ 将来若把自驱改成 QQ 会话（带上 chat.kind）跑，必须同时加进这里的排除名单，
 * 否则它就有了发消息的手。
 *
 * @param {{ cfg?: object, kind?: string }} o
 * @returns {boolean}
 */
export function shouldRegisterQqTools({ cfg, kind } = {}) {
  if (cfg?.qqTools?.enabled === false) return false;
  return String(kind || '') !== 'system';
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
 * `qq_who`：按 openid 查一个人的资料（昵称、群昵称、QQ 号、头像本地路径）。
 *
 * 为什么需要它：场景块每轮只带**当前说话人**，模型想认「刚才 @ 的那位是谁」
 * 或者「这个 openid 对应谁」时没有任何入口。昵称又不可靠（重名、能随便改），
 * 身份只能靠 openid / QQ 号 —— 而这两个对模型来说只是随机串，得有地方换成人话。
 *
 * 头像是**本地文件路径**：模型拿 URL 既读不了也发不出去（qlogo 的 key 会过期），
 * 路径可以直接 `<<image: 路径>>`。每次调用都强制刷新缓存（主人要求：
 * 查询要拿最新的），日常对话走 TTL，不重复下载。
 */
function buildWhoDef({ caller, infoOf }) {
  return {
    name: 'qq_who',
    description:
      '查一个人的 QQ 资料：昵称、群昵称、QQ 号、openid、**头像的本地文件路径**。'
      + '不传 openid 就是查当前正在说话的人。'
      + '每次调用都会刷新头像缓存，拿最新的那张。'
      + '要在回复里用他的头像（发图）、或者拿不准「这个人在群里是谁」时用它；'
      + '昵称不可靠（重名、能随便改），身份以 QQ 号 / openid 为准。',
    /**
     * 可选参数**不写 `required` 键**——写 `required:false` 会让 DSH 的
     * `defineTool` 抛 `parameters.openid.required must be true when present`：
     * 注册一个失败就整组 `{ok:false}`，连带【发言方式】提示词都不注入。
     * 2026-11-24 实测事故，详见 `test/qq-tools.test.js` 的护栏。
     */
    parameters: {
      openid: {
        type: 'string',
        description: '要查的人的 openid（消息头括号里那串）。不传就是当前说话的人。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /** 必须是内容块数组——返回字符串会让 DSH 在结果投影处炸掉 */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ openid } = {}) {
      const c = caller();
      const id = String(openid ?? '').trim() || String(c.openid || c.senderId || '');
      if (!id) {
        return { ok: false, message: '这一轮没有正在说话的人，得显式给一个 openid。' };
      }
      try {
        return await infoOf({ openid: id });
      } catch (e) {
        return { ok: false, message: `查资料失败：${e?.message ?? e}` };
      }
    },
  };
}

/**
 * `qq_search`：跨会话搜聊天记录（账本）。
 *
 * 权限由 `searchScopeOf` 按「这一轮谁在说话」钉死——普通群成员只能搜
 * **自己**，而且**只在当前会话**；主人 / 管理员才能跨会话、按别人查。
 * 这条边界写在工具里，不写在描述里：模型可能被群里的话术诱导，权限不能
 * 靠它自觉。
 *
 * 为什么值得给模型：它记得「我之前说过什么」靠的是上下文和记忆条目，
 * 一旦超出窗口就只能说「不记得了」。有了搜索，用一句关键词就能把当时的
 * 原话捞出来——比让模型猜一句摘要可靠得多。
 */
function buildSearchDef({ caller, searchOf }) {
  return {
    name: 'qq_search',
    description:
      '搜聊天记录（框架账本，重启后仍在）：按关键词、发言人、时间、会话查以前说过什么。'
      + '**所有人（包括普通群成员）都能跨会话搜**，但普通成员**只能搜到自己的消息**；'
      + '主人和管理员才能按别人查。'
      + '关键词空格分隔，多个词默认要同时命中；一条都没有时会自动放宽成任一命中（结果里 relaxed=true 说明放宽了）。'
      + '返回按时间倒序，每条带 seq / 会话名 / 发言人 / 时间 / 正文 / openid。'
      + '想看「那条消息前后到底怎么聊的」，把它的 seq 传给 `around`，会返回前后几条（普通成员只能看自己发的那条）。'
      + '适合「上次说的那个东西叫什么」「我之前答应过什么」这类回溯；一次给准关键词比反复换词有用。',
    /** 这一组全是可选参数，一律不写 `required`（理由见 `qq_who` 上方注释） */
    parameters: {
      q: {
        type: 'string',
        description: '关键词，空格分隔多个词（例如「杭州 天气」）。疑问词会被自动剥掉。',
      },
      person: {
        type: 'string',
        description: '发言人：昵称 / QQ 号 / openid。只有主人和管理员有效，其他人传了也会被忽略。',
      },
      kind: {
        type: 'string',
        description: 'group（群聊）/ c2c（私聊）；不填=全部。',
      },
      days: {
        type: 'number',
        description: '只看最近几天；不填=全部时间。',
      },
      chatId: {
        type: 'string',
        description: '限定某个会话的 openid。只有主人和管理员有效。',
      },
      limit: {
        type: 'number',
        description: '返回条数，默认 20，最多 50。',
      },
      around: {
        type: 'number',
        description:
          '看某条消息的**前后文**：传搜索结果里那条的 seq。'
          + '普通成员只能围绕自己发的消息看前后（别人发的会被拒）。',
      },
      before: {
        type: 'number',
        description: '配合 around：往前取几条，默认 3，最多 20。',
      },
      after: {
        type: 'number',
        description: '配合 around：往后取几条，默认 3，最多 20。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ q, person, kind, days, chatId, around, before, after, limit } = {}) {
      const c = caller();
      const sc = searchScopeOf(c);

      /**
       * 看上下文：和「搜索」是两条路，**不走 openids 过滤**——前后文里必然
       * 夹着别人的话，按 openid 过滤就把对话滤成独白了，没有意义。
       * 所以这里的边界换成「围绕谁的消息」：
       *   · 主人 / 管理员：任意一条；
       *   · 其他人：只能围绕**自己发的**那条（`anchor.userId` 严格等于自己）。
       * 拿不到 anchor 的 userId（老数据缺字段）时**直接拒**，fail-closed。
       */
      if (around) {
        const seq = Number(around) || 0;
        if (!seq) return { ok: false, message: 'around 要给搜索结果里那条的 seq。' };
        if (!sc.privileged && !sc.selfOpenid) {
          return { ok: false, message: '这一轮认不出你是谁（没有发送者 openid），没法看上下文。' };
        }
        try {
          const r = await searchOf({ around: seq, before, after });
          const anchorUser = String(r?.anchor?.userId ?? '');
          if (!sc.privileged && anchorUser !== sc.selfOpenid) {
            return { ok: false, message: '这条不是你发的，看不了它的上下文。' };
          }
          return {
            ok: true,
            scope: sc.privileged ? 'all' : 'self',
            anchor: r?.anchor ?? null,
            items: Array.isArray(r?.items) ? r.items : [],
          };
        } catch (e) {
          return { ok: false, message: `取上下文失败：${e?.message ?? e}` };
        }
      }

      const args = {
        q: String(q ?? '').trim(),
        kind: String(kind ?? '').trim(),
        limit: Math.max(1, Math.min(50, Number(limit) || 20)),
      };
      const d = Math.max(0, Math.min(3650, Number(days) || 0));
      if (d) args.since = Date.now() - d * 86_400_000;

      if (sc.privileged) {
        if (person) args.person = String(person).trim();
        if (chatId) args.chatId = String(chatId).trim();
      } else {
        /**
         * 非特权：**不管传了什么，都用当前说话人的 openid 覆盖**。
         * 这里刻意不 merge，而是直接赋值——merge 就是「多给一点」的来源。
         *
         * 会话**不锁**：主人 2026-11-16 定「其他人也要可以跨会话」。跨会话
         * 只暴露「这个群存在」，不暴露别人的消息；边界是「谁的消息」。
         */
        if (!sc.selfOpenid) {
          return { ok: false, message: '这一轮认不出你是谁（没有发送者 openid），没法按「只看自己的消息」查。' };
        }
        args.openids = [sc.selfOpenid];
        if (chatId) args.chatId = String(chatId).trim();
      }

      if (!args.q && !args.person && !(args.openids ?? []).length && !args.kind) {
        return { ok: false, message: '给个条件：关键词 / 发言人 / 类型。' };
      }

      try {
        const r = await searchOf(args);
        return {
          ok: true,
          /** `all` = 跨会话；`self` = 只有自己的消息 —— 让模型知道自己的视野边界 */
          scope: sc.privileged ? 'all' : 'self',
          items: Array.isArray(r?.items) ? r.items : [],
          terms: Array.isArray(r?.terms) ? r.terms : [],
          relaxed: Boolean(r?.relaxed),
          hasMore: Boolean(r?.hasMore),
        };
      } catch (e) {
        return { ok: false, message: `搜索失败：${e?.message ?? e}` };
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
export function buildQqToolDefs({ callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, groupOf, ledgerOf = null, sessionOf = null, infoOf = null, searchOf = null, postThreadOf = null }) {
  const caller = () => callerOf?.() || { chatId: '', kind: '', said: '', hasPayload: false, bucket: '' };

  const send = {
    name: 'qq_send',
    description:
      '把一段话发出去。一次调用发一段，可以按需要分多次调用；每调用一次就是一条独立消息。'
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
      /**
       * 出站清洗：模型偶尔会把宿主注入的内容（消息头、场景块、输出协议）
       * 顺着正文续写进来，或者把「（思考：…）」「最终回答：」写在里面。
       * 先洗再判空——洗完什么都不剩，说明整段都是不该发的。
       */
      const t = cleanOutbound(String(text ?? '').trim());
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
    /**
     * 查资料：同样「没给实现就不注册」——注册一个必然失败的工具，
     * 等于教模型去做一件做不成的事，白烧一轮。
     */
    ...(typeof infoOf === 'function' ? [buildWhoDef({ caller, infoOf })] : []),
    /** 搜历史：同样「没给实现就不注册」 */
    ...(typeof searchOf === 'function' ? [buildSearchDef({ caller, searchOf })] : []),
    /**
     * 频道发帖：**给了实现才注册**（宿主没接 channelPost 时不该出现这个工具）。
     * 注册之后具体能不能发，由 `execute` 每次现判——主人随时会改开关。
     */
    ...(typeof postThreadOf === 'function' ? [buildPostThreadDef({ postThreadOf })] : []),
    /** 群管：和发言工具一起挂，但实现放在 group-tools.js（语义不同，也都依赖外接协议） */
    ...(typeof groupOf === 'function'
      ? buildGroupToolDefs({ groupOf, callerOf, ledgerOf, sessionOf, cfgOf })
      : []),
  ];
}

/**
 * `qq_post_thread`：往频道版块里发一篇帖子（标题 + 正文）。
 *
 * **只在 QQ 会话注册**（`system:*` 会话由 `shouldRegisterQqTools` 挡掉），
 * 而且**不接受 channelId**——目标版块由主人在面板里定死。这是安全边界：
 * 被提示注入一次，最多让她写一篇烂文章，做不到"发到任意子频道"。
 *
 * 条件不满足时**不是不注册，而是拒绝并说明原因**：注册级开关读的是
 * 挂载那一刻的配置，而主人随时可能在面板上打开/关闭；用 execute 内判定
 * 才不会出现"改了设置要重启才生效"的怪事。
 */
function buildPostThreadDef({ postThreadOf }) {
  return {
    name: 'qq_post_thread',
    description:
      '在频道的一个版块里发一篇**帖子**（有标题、会一直留着，别人刷版块能看到）。'
      + '这和 `qq_send` 不是一回事：`qq_send` 是现在这段对话里说一句，说完就过去了。'
      +       '只在主人打开「允许她在对话里发帖」之后可用；发到哪个版块由主人定，你改不了。'
      + '内容会被审核，所以「已提交」不等于「已经能看见」。'
      /**
       * 这一句是「链路不通时用户能不能被正确指引」的最后一环：
       * 拒绝时宿主会把「去哪个面板点哪里」写进 `say`，模型只要照读。
       * 不写这句，模型倾向于自己编一句"发帖功能好像没开"——那等于什么都没说。
       */
      + '**返回 `ok:false` 时，`say` 里已经写好了该告诉主人什么、去哪个面板点哪里——照它复述，不要自己猜原因，也不要编一个。**',
    parameters: {
      title: {
        type: 'string',
        description: '帖子标题，20 字内，不要带日期前缀、不要和正文第一句重复',
      },
      text: {
        type: 'string',
        required: true,
        description: '正文。第一人称、口语、分段写；不要写 Markdown 标题、不要写标记',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ title, text } = {}) {
      const t = String(text ?? '').trim();
      if (!t) return { ok: false, message: '要写点什么再发' };
      try {
        return await postThreadOf({ title: String(title ?? '').trim(), text: t });
      } catch (e) {
        return { ok: false, message: String(e?.message || e) };
      }
    },
  };
}

/**
 * 把 QQ 动作工具挂到一个 agent 上。
 *
 * 失败**不抛错**——工具是增强，装不上不能让整轮对话挂掉；但必须把原因带出去
 * （面板要能看见"没装上"，静默失败等于死代码）。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, mode?:string, off?:Function}>}
 */
export async function registerQqTools({ agent, callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, groupOf, ledgerOf = null, sessionOf = null, infoOf = null, searchOf = null, postThreadOf = null, log = () => {} }) {
  const defs = buildQqToolDefs({ callerOf, sendOf, closeOf, fileOf, cfgOf, stateOf, groupOf, ledgerOf, sessionOf, infoOf, searchOf, postThreadOf });
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
