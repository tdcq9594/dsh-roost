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
 * 拼工具定义。抽成纯函数是为了能单测——权限判断写错的表现是
 * "群友也能写记忆"，那是最不能靠人工试出来的那种错。
 *
 * @param {object} o
 * @param {object} o.journal
 * @param {(chatId:string)=>object} o.graphOf
 * @param {() => {bucket:string, chatId:string}} o.callerOf  当前这一轮是谁在说
 * @param {() => object} o.cfgOf
 */
export function buildToolDefs({ journal, graphOf, callerOf, cfgOf, contextOf = null }) {
  /** 当前调用者的档位与所属会话 */
  const caller = () => {
    const s = callerOf?.() || {};
    return { bucket: String(s.bucket || 'unknown'), chatId: String(s.chatId || '') };
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
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的内容，用几个关键词就够（如"杭州 搬家""电影 约定"）' },
        scope: {
          type: 'string',
          enum: ['chat', 'global'],
          description: 'chat=只查当前会话（默认）；global=连跨群的身份事实一起查（只有主人/管理员可用）',
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'object' },
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
      const { chatId, bucket } = caller();
      const cross = scope === 'global' && canCrossGroup();
      try {
        const rows = await journal.search(q, { chatId, limit: 5, crossCritical: cross });
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
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句话，写清楚是什么事（含人名/地点/时间）' },
        level: {
          type: 'string',
          enum: WRITABLE_LEVELS,
          description: 'normal=普通（几天后压成半句）；important=重要（两三周后压成一句）',
        },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'object' },
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

  return [search, note];
}

/**
 * 把工具挂到一个 agent 上。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, off?:Function}>}
 *   失败**不抛错**——工具是增强，装不上不能让整轮对话挂掉；但必须把原因带出去。
 */
export async function registerMemoryTools({ agent, journal, graphOf, callerOf, cfgOf, contextOf = null, log = () => {} }) {
  const defs = buildToolDefs({ journal, graphOf, callerOf, cfgOf, contextOf });
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
    /**
     * 注意：这里用的是 **agent 的** ctx，不是插件的 ctx。
     * 插件的 `inject` 里千万不要加 `'tools'`——声明一个不存在的服务
     * 会让整个插件激活失败（连收消息都起不来），而工具只是增强功能。
     */
    return { ok: false, names: [], reason: '这个 agent 的 tools 服务没有 register（版本差异）' };
  }

  const defineTool = await loadDefineTool();
  const made = [];

  for (const def of defs) {
    try {
      /**
       * 有真 defineTool 就用它（会打上 marker，沙箱那条路也认）；
       * 没有就交同形状的普通对象——注册器若不校验 marker，一样能用。
       */
      const tool = defineTool ? defineTool(def) : def;
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
