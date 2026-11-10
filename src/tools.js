/**
 * 记忆工具：给模型两把"拉"的手。
 *
 * 为什么要有（而注入已经存在）：
 *   注入是**推**——每轮自动塞 top-3 命中。问"上周说的那个方案"时，
 *   只要没进 top-3，她就没有任何办法自己去翻，只能答"不记得"。
 *   mem0 / Letta / Open WebUI 都提供 search 类工具，就是补这一手。
 *
 * 两条安全边界（比功能更重要）：
 *   1. **群友不能写长期记忆**。给他 `memory_note`，等于允许往每轮都注入的
 *      记忆里投毒——写一句"主人讨厌张三"，以后每次对话都带着这句。
 *      所以 `memory_note` 只给 owner，且 execute 里再验一遍档位（纵深防御）。
 *   2. **群友的检索不许跨群**。`crossCritical` 强制 false，且结果不带 sender。
 *      否则 A 群的人能借她翻出 B 群的对话。
 *
 * 依赖处理：工具定义要用 DSH 的 `defineTool`（`@deepseek-ai/dsh-tools`）。
 * 外部插件不一定能解析到这个包，所以这里**三级降级**：
 *   ① 用真正的 defineTool（最理想）
 *   ② 拿不到就交一个同形状的普通对象，让注册器自己判断
 *   ③ 注册失败就明确记日志 + 面板上显示"工具没装上"，不静默
 * 上一轮的教训：功能写好了没人调 = 死代码。所以"没装上"必须看得见。
 */

/** 记住解析结果，避免每次 mount 都 import 一次 */
let defineToolCache;

/**
 * 试着拿 DSH 的 defineTool。
 *
 * 导出给 `qq-tools.js` 用——两个文件都要这套「有就用真的、没有就交普通对象」
 * 的降级，复制一份必然漂。
 *
 * @returns {Promise<Function|null>}
 */
export async function loadDefineTool() {
  if (defineToolCache !== undefined) return defineToolCache;
  try {
    const m = await import('@deepseek-ai/dsh-tools');
    defineToolCache = typeof m?.defineTool === 'function' ? m.defineTool : null;
  } catch {
    defineToolCache = null;
  }
  return defineToolCache;
}

/** 只有这两档能由工具写入；critical 只能由用户在对话里明确要求 */
const WRITABLE_LEVELS = ['normal', 'important'];

/**
 * 扁平参数表 → 标准 JSON Schema。
 *
 * **为什么需要这一步**：DSH 的 `defineTool` 要的参数表是**扁平 map**，
 * 参数名直接当键、`required` 写在每个参数自己身上：
 *
 * ```js
 * defineTool({ parameters: { title: { type: 'string', required: true } } })
 * ```
 *
 * 而走 `ctx.tools.register` 的普通对象要的是标准 JSON Schema
 * （`{ type:'object', properties:{…}, required:[…] }`）——本机的
 * `dsh-ops/lib/shells/tool.js` 就是这么写的。
 *
 * 以前我们只写了后者。本机因为解析不到 `@deepseek-ai/dsh-tools`
 * （它打包在 app.asar 里），一直走普通对象那条路，所以看不出问题；
 * 别人的机器上 defineTool 解析成功，注册器把 `parameters` 当「参数名 →
 * schema」遍历，撞到键 `type` 的值是字符串 `'object'`，报：
 *
 *   `unsupported JSON schema: parameters.type must be a value schema object`
 *
 * 四个工具全中，只是注册遇到第一个失败就 return，面板只显示 `memory_search`。
 *
 * 现在**只维护扁平这一份**（DSH 的原生形状），需要 JSON Schema 时现转，
 * 两种注册路径都不会漂。
 *
 * @param {object} params 扁平参数表
 * @returns {{type:'object', properties:object, required?:string[]}}
 */
export function toJsonSchema(params) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(params || {})) {
    const { required: req, ...rest } = spec || {};
    properties[name] = rest;
    if (req) required.push(name);
  }
  /**
   * `additionalProperties: false` 是**硬要求**，不是修饰。
   *
   * 新版 DSH 对「裸 JSON Schema」有一套严格子集校验：凡是 `type: 'object'`
   * 的节点，`additionalProperties` 必须显式写成布尔值，缺了直接抛
   * `unsupported JSON schema: schema.additionalProperties must be explicitly true or false`，
   * 工具**注册即被拒**，连面板都挂不上去。
   *
   * 这里用 `false`（参数表是封闭的，只有声明过的键）；`output.schema` 那边
   * 用 `true`（返回值是自由 JSON，结构不固定）。
   */
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  };
}

/**
 * 按 DSH 有没有 `defineTool` 挑一种形状。
 *
 * 有就用扁平表直接交（DSH 自己认）；没有就转成 JSON Schema 交给
 * `ctx.tools.register`。**不要反过来**——把 JSON Schema 交给 defineTool
 * 就是上面那个报错的来源。
 *
 * @param {object} def 工具定义（`parameters` 是扁平表）
 * @param {Function|null} defineTool
 */
export function shapeTool(def, defineTool) {
  if (defineTool) return defineTool(def);
  return { ...def, parameters: toJsonSchema(def.parameters) };
}

/**
 * 拼工具定义。抽成纯函数是为了能单测——权限判断写错的表现是
 * "群友也能写记忆"，那是最不能靠人工试出来的那种错。
 *
 * @param {object} o
 * @param {object} o.journal
 * @param {(chatId:string)=>object} o.graphOf
 * @param {() => {bucket:string, chatId:string, aliases?:string[]}} o.callerOf  当前这一轮是谁在说
 * @param {() => object} o.cfgOf
 */
export function buildToolDefs({ journal, graphOf, callerOf, cfgOf, contextOf = null, ledgerOf = null, sessionOf = null, allowMemory = true, extMemory = null }) {
  /** 当前调用者的档位、所属会话、以及这个会话的别名键 */
  const caller = () => {
    const s = callerOf?.() || {};
    return {
      bucket: String(s.bucket || 'unknown'),
      chatId: String(s.chatId || ''),
      /**
       * 群 / 私聊。**隐私判定要用它**：`bucket === 'owner'` 在主人所在的群里
       * 同样成立（`permissions.js` 的 `bucketOf()` 根本不看 chat kind），
       * 只判 bucket 会让「主人在群里随口一句」变成「群友能查别群」。
       * 缺省给空串——7 处老测试只传 `{bucket, chatId}`，不容缺省会全红。
       */
      kind: String(s.kind || ''),
      /**
       * 别名键（号码 + 该号码名下所有 openid）。
       *
       * **工具这条路最容易漏**：注入那边带了别名，工具这边不带，
       * 模型问「上次说的那个方案」时会拿到 `count: 0` 加一句
       * 「没查到，可以换个说法」，而同一时刻系统提示词里正注入着那条记忆。
       * 模型据此回一句「我不记得了」——用户以为她失忆了，实际是检索没合上。
       */
      aliases: Array.isArray(s.aliases) ? s.aliases : [],
    };
  };

  /** 只有主人能写长期记忆 */
  const canWrite = () => caller().bucket === 'owner';

  /** 群友检索不许跨群 */
  const canCrossGroup = () => {
    const b = caller().bucket;
    return b === 'owner' || b === 'admin';
  };

  const search = {
    name: 'memory_search',
    description:
      '在自己过去的记录里检索。当对方提到"上次""之前说过""那个方案"而你没有把握时，用它查，不要凭印象编。'
      + '只返回真实发生过的对话片段。',
    /**
     * 扁平参数表——DSH `defineTool` 的原生形状，`required` 写在参数自己身上。
     * 走普通注册时由 `toJsonSchema()` 转成标准 JSON Schema（见 `shapeTool`）。
     */
    parameters: {
      query: { type: 'string', required: true, description: '要查的内容，用几个关键词就够（如"杭州 搬家""电影 约定"）' },
      scope: {
        type: 'string',
        enum: ['chat', 'global'],
        description: 'chat=只查当前会话（默认）；global=连跨群的身份事实一起查（只有主人/管理员可用）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /**
       * render 必须返回**内容块数组**（`[{type:'text',text:...}]`），
       * 不能返回字符串——DSH 拿到结果会对 content 调 `.some()`，
       * 字符串没有这个方法，直接炸成 `content.some is not a function`，
       * 模型看到的就是「接口报错了」。真实事故：0.9.x 两轮检索全挂在这。
       */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ query, scope } = {}) {
      const q = String(query || '').trim();
      if (!q) return { ok: false, message: '要查什么？给个关键词' };
      if (cfgOf?.()?.memory?.enabled === false) return { ok: false, message: '记忆功能关着' };
      const { chatId, bucket, aliases } = caller();
      const cross = scope === 'global' && canCrossGroup();
      try {
        const rows = await journal.search(q, { chatId, limit: 5, crossCritical: cross, aliases });
        /**
         * 场景片段（阶段 4）：命中之后把**原文和前后文**也带出来。
         *
         * 为什么值得多跑几次 HTTP：检索给的是摘要，而模型要判断「这条到底是不是
         * 他在说的那件事」，必须看到原话和上下文。只给摘要它只能猜，
         * 猜错就说成另一件事——**比「不记得」更糟**。
         *
         * 只给前 2 条补邻文：5 条 × 5 段邻文 = 25 段，会把这个工具的返回撑得
         * 比它要回答的问题还大。
         */
        const results = await Promise.all(
          rows.map(async (r, i) => {
            const base = {
              when: new Date(r.at).toISOString().slice(0, 10),
              level: r.level,
              text: String(r.digest || r.text).slice(0, 200),
              /**
               * 群友看不到是谁说的——`sender` 会把别的群的人名漏出去。
               * 主人/管理员才给，方便判断可信度。
               */
              ...(bucket === 'owner' || bucket === 'admin' ? { who: r.role === 'bot' ? '我' : r.sender } : {}),
            };
            const eid = r.eventIds?.[0];
            if (i >= 2 || !eid || !contextOf) return base;
            const ctx = await contextOf(eid, { before: 2, after: 2 }).catch(() => null);
            if (!ctx?.items?.length) return base;
            return {
              ...base,
              /**
               * `role` 是 `hit` 还是 `neighbor` —— **相邻不等于同一话题**，
               * 提示词里要写清楚，不能因为挨着就当因果。
               */
              around: ctx.items.map((x) => ({
                role: x.role,
                when: new Date(x.at).toISOString().slice(0, 10),
                text: String(x.content || '').slice(0, 200),
              })),
            };
          }),
        );
        return {
          ok: true,
          count: rows.length,
          results,
          hint: rows.length ? '' : '没查到。可以换个说法，或者直接说不记得。',
        };
      } catch (e) {
        return { ok: false, message: `检索失败：${e.message}` };
      }
    },
  };

  const note = {
    name: 'memory_note',
    description:
      '把一件值得长期记住的事写进日记。只记关于对方本人的事实、约定、偏好；'
      + '不要记一次性的闲聊。"非常重要"这一档不能由这个工具写，需要对方明确要求。',
    parameters: {
      text: { type: 'string', required: true, description: '一句话，写清楚是什么事（含人名/地点/时间）' },
      level: {
        type: 'string',
        enum: WRITABLE_LEVELS,
        description: 'normal=普通（几天后压成半句）；important=重要（两三周后压成一句）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /** 同 memory_search：必须是内容块数组，字符串会让 DSH 的 content.some 炸掉 */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ text, level } = {}) {
      /**
       * **执行时再验一次档位。**
       *
       * 为什么不在注册时就决定：注册是按 agent 一次性的，而"这一句是谁说的"
       * 是每轮变的（同一个群里主人问完、路人接着问）。所以权限必须在
       * execute 里按当轮的 caller 判，不能烤进定义。
       */
      if (!canWrite()) return { ok: false, message: '只有主人能让我主动记东西' };
      const t = String(text || '').trim();
      if (!t) return { ok: false, message: '要记什么？' };
      const lv = WRITABLE_LEVELS.includes(level) ? level : 'normal';
      try {
        const { chatId } = caller();
        const r = journal.add({
          id: `tool:${chatId}:${Date.now()}`,
          at: Date.now(),
          chatId,
          role: 'user',
          sender: '（她记下的）',
          text: t,
          level: lv,
        });
        return { ok: Boolean(r.added), level: r.level };
      } catch (e) {
        return { ok: false, message: `没写进去：${e.message}` };
      }
    },
  };

  /**
   * 翻聊天记录。
   *
   * 和 `memory_search` 的分工要说清，否则模型会拿它当检索用：
   *   · `memory_search` = 给几个词，命中几条摘要（检索式）
   *   · `chat_look`     = 某个会话最近发生了什么（时间线式）
   *
   * 两个源：`ledger`（账本，全量入站，7 天或永久）和 `journal`（日记，
   * 只记触发过她的轮次，长期）。默认账本——只有它能回答「群里刚才聊了什么」，
   * 因为群里没叫她的消息不进日记。
   */
  const look = {
    name: 'chat_look',
    /**
     * 描述要用**正面、鼓励调用**的写法。
     *
     * 真机实测：原来写「查别的群只有主人私聊里可以」，模型在主人私聊里
     * 也把它读成「这件事大概不许做」，reasoning 直接写「Better answer simply」
     * 然后凭印象回「看不着呀」，一次都没调工具。权限判定在 execute 里做，
     * 描述层不该先替模型把门关上——越界时 execute 会明确拒绝并说明原因。
     */
    description:
      '翻聊天记录。被问到"刚才在聊什么""别的群说了啥""上次那个话题"时，'
      + '先调这个工具再答，不要凭印象说自己看不见。'
      + '不知道有哪些会话就先用 what=chats 列一遍，拿到 chatId 再查具体内容。'
      + '它给的是时间线（谁在什么时候说了什么），不是关键词检索——找特定内容用 memory_search。',
    parameters: {
      what: {
        type: 'string',
        enum: ['recent', 'chats'],
        description: 'recent=某会话最近的记录（默认）；chats=有哪些会话',
      },
      chatId: {
        type: 'string',
        /**
         * 3.2：不写「只有私聊可以」「群里一定不行」这类硬编码条件。
         * 条件会随能力页开关变化，写死在描述里就会像真机 P6 那样——
         * 开关已经打开，模型却仍凭描述里的旧条件答「看不了呀」。
         * 能不能看、能看哪些，一律由 execute() 的返回值说明。
         */
        description: '要查哪个会话。不传 = 当前会话；能不能查别处、能查哪些，以工具返回值为准',
      },
      limit: { type: 'number', description: 'recent 取几条，默认 20，上限 50' },
      cursor: { type: 'string', description: '翻页游标：用上一次返回的 next' },
      source: {
        type: 'string',
        enum: ['ledger', 'journal'],
        description: 'ledger=账本（全量，默认）；journal=日记（长期，但只含叫过她的轮次）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /** 同 memory_search：必须是内容块数组，字符串会让 DSH 的 content.some 炸掉 */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ what = 'recent', chatId, limit = 20, cursor = '', source = 'ledger' } = {}) {
      if (cfgOf?.()?.chat?.tools === false) return { ok: false, message: '翻记录这个功能关着' };

      const me = caller();
      const want = String(chatId || '').trim() || me.chatId;
      if (!want) return { ok: false, message: '不知道该查哪个会话' };

      /**
       * 隐私：跨会话只有「主人的私聊」可以，而且只能查群。
       *
       * 两个条件缺一不可——`bucket === 'owner'` 在主人所在的群里也成立，
       * 只判它的话，主人在群里说一句，模型就能把 B 群的内容拉进 A 群。
       * 传入的 chatId 还必须真的是群（查 `sessions` 映射，不靠 openid 长相猜）。
       */
      const cross = want !== me.chatId;
      if (cross) {
        /**
         * 跨群的两道门，缺一不可：
         *   ① 只有主人——`bucket === 'owner'` 在群里也成立，所以这条要单独判；
         *   ② 场景：私聊一律可以；群里要看 `chat.crossChatInGroup`（默认关）。
         *      为什么默认关：群里的回复所有人都看得见，允许「在 A 群问 B 群」
         *      等于把 B 群的对话说给 A 群听。
         *
         * 3.2 / 3.5 拒绝文案：按当前开关状态 + 身份动态生成，不再静态写
         * 「到能力页打开 XX 开关」。静态那句有两个毛病：开关名会随配置改，
         * 而且等于教模型去劝用户改设置；对群友还暴露了开关的存在性。
         * 非 owner 一律只给中性原因，连「当前设置」都不提。
         */
        const allowInGroup = cfgOf?.()?.chat?.crossChatInGroup === true;
        const isOwner = me.bucket === 'owner';
        const denyCross = (why) => {
          if (why === 'private-target') return '只能查群聊。别人的私聊任何情况下都不查。';
          /**
           * 目标不存在和「别人的私聊」是两回事，别共用一句会误导的文案。
           * 调用点前面已经拦掉非 owner，这里再按身份分叉是死代码，收敛成一句。
           */
          if (why === 'missing') return '找不到这个会话，先列一遍能看的会话再挑 chatId。';
          const base = '只能查当前这个会话。换个群的事，在跟主人的私聊里问。';
          if (!isOwner) return base;
          /**
           * 群里 / 频道的回复会被旁听：「当前设置」只是本轮是否放开的事实，可以说；
           * 但「权限由能力页设置决定」等于当众教人改权限，这半句按**输出位置**砍掉，
           * 不能只看调用者是不是 owner——主人在群里说话时 bucket 也是 owner。
           */
          const status = `（当前设置${allowInGroup ? '允许' : '不允许'}在群里查别的群）`;
          if (me.kind === 'group' || me.kind === 'channel') return `${base}${status}`;
          return `${base}${status}；权限由主人自己的能力页设置决定。`;
        };
        if (!isOwner) {
          return { ok: false, message: denyCross('bucket') };
        }
        const fromPrivate = me.kind === 'c2c';
        if (!fromPrivate && !(me.kind === 'group' && allowInGroup)) {
          return { ok: false, message: denyCross('in-group') };
        }
        const ent = sessionOf?.(want);
        if (!ent) return { ok: false, message: denyCross('missing') };
        if (String(ent.kind ?? '') !== 'group') {
          return { ok: false, message: denyCross('private-target') };
        }
      }

      const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
      const nameOf = (id) => {
        const t = String(sessionOf?.(id)?.title ?? '').replace(/^QQ · /, '').trim();
        return t || `${String(id).slice(0, 8)}…`;
      };

      try {
        if (what === 'chats') {
          /** 会话清单只有账本源提供；日记源不是「账本没开」，别用那句把模型带偏 */
          if (source === 'journal') {
            return {
              ok: false,
              message: '日记源不提供会话清单；要列会话请用默认的账本源，或用 what=recent 直接查当前会话',
            };
          }
          const src = ledgerOf?.();
          if (!src?.available?.()) {
            return { ok: false, message: '账本没开（或没找到库），只能查当前会话' };
          }
          /**
           * 3.3（20:42「会话清单 / 跨群内容两个开关合并」）：不新增 `chatsInGroup`。
           *
           * `what='chats'` 时 want = me.chatId → cross=false，上面那段隐私判定
           * 根本不触发，所以「群里能不能列别的会话」必须在这个分支里自己判，
           * 复用 `chat.crossChatInGroup`：关着时群里只返回当前会话一条，
           * 打开时才列全部。真机 P7 就是这么漏出去的。
           *
           * 过滤下推到 `ledger-read.js` 的 SQL（`onlyChatId`），不能只对取回的
           * 12 行做 filter —— 当前会话若不在最近 12 个活跃会话里，会静默返回空清单。
           */
          const listOthers = me.kind !== 'group'
            || cfgOf?.()?.chat?.crossChatInGroup === true;
          const rows = src.chats(listOthers
            ? { limit: 12 }
            : { limit: 12, onlyChatId: me.chatId });
          return {
            ok: true,
            what: 'chats',
            count: rows.length,
            chats: rows.map((r) => ({
              chatId: r.chatId,
              name: nameOf(r.chatId),
              kind: r.kind,
              count: r.count,
              lastAt: new Date(r.lastAt).toISOString().slice(0, 16).replace('T', ' '),
            })),
            hint: rows.length
              ? (listOthers
                ? '把 chatId 传给下一次 chat_look 就能看具体内容'
                /**
                 * 别在这里鼓励「再查一次」：开关关着时列不出别的会话，
                 * 而 V3.1 让模型「列不出就照它给的说法回答」。给一个能收尾的结论。
                 */
                : '这一轮在群里只列得出当前会话，别的会话的内容拿不到')
              : '账本里还没有记录',
          };
        }

        const before = Number(String(cursor || '').replace(/[^\d]/g, '')) || 0;

        if (source === 'journal') {
          const rows = journal.recentTimeline(want, { limit: lim, before, aliases: me.aliases });
          const items = rows.reverse().map((r) => ({
            at: r.at,
            time: new Date(r.at).toISOString().slice(11, 16),
            who: r.role === 'bot' ? '我' : r.sender || '（未知）',
            text: String(r.digest || r.text).slice(0, 200),
          }));
          return {
            ok: true,
            what: 'recent',
            source: 'journal',
            chatId: want,
            name: nameOf(want),
            count: items.length,
            items,
            next: items.length >= lim ? String(items[0].at) : '',
          };
        }

        const src = ledgerOf?.();
        if (!src?.available?.()) return { ok: false, message: '账本没开（或没找到库）' };
        const items = src.recent({ chatId: want, limit: lim, beforeSeq: before });
        return {
          ok: true,
          what: 'recent',
          source: 'ledger',
          chatId: want,
          name: nameOf(want),
          count: items.length,
          /**
           * 白名单式重映射（历史如此）。`ledger-read.js` 新补的引用两列
           * 不在这里显式带出来就会被丢掉，L1 与面板都看不到「这条引用了谁」。
           * 只在有值时加键，老库 / 无引用的行输出形状保持原样。
           */
          items: items.map((x) => ({
            at: x.at,
            time: x.time,
            who: x.who,
            text: String(x.text).slice(0, 200),
            ...(x.quoted ? { quoted: String(x.quoted).slice(0, 200) } : {}),
            ...(x.refMsgIdx ? { refMsgIdx: String(x.refMsgIdx) } : {}),
          })),
          next: items.length >= lim ? String(items[0].seq) : '',
          hint: items.length ? '' : '这个会话在这段时间里没有记录',
        };
      } catch (e) {
        return { ok: false, message: `翻记录失败：${e.message}` };
      }
    },
  };

  /**
   * 按功能开关挑要挂哪几个。
   *
   * 记忆工具和翻记录是**两个开关**：记忆关着时她照样该知道「群里刚才聊了什么」，
   * 反过来也一样。所以不能因为一个关了就全不挂。
   */
  const cfg = cfgOf?.() || {};
  const defs = [];
  if (allowMemory && cfg.memory?.tools !== false) defs.push(search, note);
  if (cfg.chat?.tools !== false) defs.push(look);
  /**
   * 阶段 4.2：扩展记忆的两个模型工具由 `ext-memory.js` 提供定义，这里只负责
   * 挂上去，不重复实现 ACL / 截断。`extMemory` 没注入时（老测试夹具）两个工具
   * 就不存在，行为与阶段 3 完全一致。
   */
  if (extMemory && typeof extMemory.toolDefs === 'function' && allowMemory && cfg.memory?.tools !== false) {
    defs.push(...extMemory.toolDefs({ callerOf: caller, cfgOf }));
  }
  return defs;
}

/**
 * 把工具挂到一个 agent 上。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, off?:Function}>}
 *   失败**不抛错**——工具是增强，装不上不能让整轮对话挂掉；但必须把原因带出去。
 */
export async function registerMemoryTools({
  agent,
  journal,
  graphOf,
  callerOf,
  cfgOf,
  contextOf = null,
  ledgerOf = null,
  sessionOf = null,
  allowMemory = true,
  extMemory = null,
  log = () => {},
}) {
  const defs = buildToolDefs({ journal, graphOf, callerOf, cfgOf, contextOf, ledgerOf, sessionOf, allowMemory, extMemory });
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    /**
     * 注意：这里用的是 **agent 的** ctx，不是插件的 ctx。
     * 插件的 `inject` 里千万不要加 `'tools'`——声明一个不存在的服务
     * 会让整个插件激活失败（连收消息都起不来），而工具只是增强功能。
     */
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }

  /**
   * 先看一眼现有工具名。
   *
   * `memory_search` 这种名字是全局的，别的插件（mem0、OpenViking 之类）也可能
   * 抢注。等 `register` 抛错的报错往往只有一句「already registered」，
   * 用户看不出是谁占的、该怎么办。这里提前查一遍，把名字点出来。
   *
   * 拿不到清单（老宿主没有 `schemas()`）就退回「注册时再报错」那条路，
   * 不能因为查不了就拒绝挂工具。
   */
  const taken = new Set();
  try {
    const list = typeof registry.schemas === 'function' ? registry.schemas() : [];
    for (const item of Array.isArray(list) ? list : []) {
      // 三种形状都认：字符串、`{name}`、OpenAI 风格的 `{function:{name}}`
      const n = typeof item === 'string' ? item : (item?.name ?? item?.function?.name);
      if (n) taken.add(String(n));
    }
  } catch {
    // 查不到就算了，后面 register 仍会兜底
  }
  const clash = defs.filter((d) => taken.has(d.name));
  if (clash.length) {
    return {
      ok: false,
      names: [],
      reason:
        `工具名被占用：${clash.map((d) => d.name).join('、')}。` +
        '多半是别的插件先注册了同名工具——停用它，或改名后再试。',
    };
  }

  const defineTool = await loadDefineTool();
  const made = [];

  for (const def of defs) {
    try {
      /**
       * 有真 defineTool 就用它（会打上 marker，沙箱那条路也认）；
       * 没有就转成标准 JSON Schema 交普通对象——注册器若不校验 marker，一样能用。
       *
       * 两条路的参数形状**不一样**，见 `shapeTool` 的注释。
       */
      const tool = shapeTool(def, defineTool);
      const off = registry.register(tool);
      made.push({ off, name: def.name });
    } catch (e) {
      log(`记忆工具 ${def.name} 没装上：${e.message}`);
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
    /** 卸妆：插件停用时把工具收回去，否则重载会重复注册 */
    off: () => {
      for (const m of made) {
        try {
          m.off?.();
        } catch {}
      }
    },
  };
}
