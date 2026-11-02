/**
 * 表情包工具：把「挑哪张图」从**提示词里的一大串路径**变成**模型自己调一次工具**。
 *
 * 为什么要有这个工具：
 *
 *   平铺清单的方式（把所有文件名和路径写进系统提示词）只有几十张图时还行，
 *   上百张就是几千字，而且**每加一张图都会换掉整段前缀**——prompt 缓存全部失效。
 *
 *   改成工具之后，提示词里只留分类名和张数（几十字），模型真要用图时再问，
 *   拿到的是 1~3 个真实路径。**ai-chat 那边完全不用改**：它认的还是
 *   `<<image: 路径>>`，路径由这个工具给。
 *
 * 为什么不让模型自己拼路径：文件名是中文、带空格括号、还要拼盘符，
 * 模型抄错一个字符就是「发图失败」而界面上看不出来。让宿主给绝对路径，
 * 错不了。
 */

import { loadDefineTool, shapeTool } from './tools.js';

/**
 * 拼工具定义。抽成纯函数是为了能单测：工具描述写错的表现是
 * 「模型该调的时候不调」或者「调了却不用返回的路径」，都只能靠线上观察。
 *
 * @param {object} o
 * @param {(o:{category:string, limit:number}) => object} o.pickOf 表情库的 pick()
 */
export function buildStickerToolDefs({ pickOf }) {
  const pick = {
    name: 'sticker_pick',
    description:
      '从表情包里挑几张图，返回**真实文件路径**。'
      + '想发图/发表情的时候调它：先用 category 说明想要什么种类，拿到路径后'
      + '再用 `<<image: 路径>>` 把图发出去。'
      + '**没有合适的分类就不要调**——宁可这轮不配图，也不要随便挑一张。',
    /** 扁平参数表（DSH defineTool 原生形状），普通注册时由 `shapeTool` 转换 */
    parameters: {
      category: {
        type: 'string',
        required: true,
        description:
          '要哪一类表情，填提示词里列出的分类名（例如「开心」「无语」）。'
          + '不确定有哪些分类时，先按提示词里列的填；填错了会返回现有分类清单。',
      },
      n: {
        /**
         * 用 **string** 不用 number。
         *
         * 这个项目里所有工具参数都是 string——QQ 那两个、记忆那几个都一样。
         * DSH 的 `defineTool` 收的是扁平参数表，number 类型没有先例可循；
         * 万一它只认 string，表现是「工具注册失败」或者「模型传 1 却被当成 undefined」，
         * 两种都只在运行时才看得出来。反正这里最终要转成数字，不如让它进来就是字符串。
         */
        type: 'string',
        description: '要几张，1~3，默认 1。一般一张就够，别一次要三张全发出去。',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      /** 必须是内容块数组——字符串会让 DSH 的 content.some 炸掉 */
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value ?? null) }],
    },
    async execute({ category, n } = {}) {
      const cat = String(category ?? '').trim();
      if (!cat) return { ok: false, message: '要指定一个分类，比如「开心」。' };

      /** 参数是字符串（见上面 `n` 的说明），这里统一转数字；转不出来就当 1 */
      const want = Number.parseInt(String(n ?? '1'), 10);

      let r;
      try {
        r = pickOf?.({ category: cat, limit: Number.isFinite(want) ? want : 1 });
      } catch (e) {
        return { ok: false, message: `挑图失败：${e?.message ?? e}` };
      }
      if (!r?.ok) return { ok: false, message: r?.message || '这一类里没有图' };

      /**
       * 返回值里必须带 `path` 和一句「怎么发」。
       *
       * 只给路径不给用法，模型有时会把路径写进正文（群里就是一段
       * `C:\...\开心.png` 的文字），用户看到一串盘符，图没发出去。
       */
      return {
        ok: true,
        category: r.category,
        items: r.items,
        /**
         * **必须点明「写在正文里」**。
         *
         * ai-chat 的多段路径（`qq_send` 逐段发）只对每段取清理后的文本，
         * 段里的 `<<image>>` 会被摘掉但**不进发送队列**——图就静默消失了。
         * 只有「整段正文」那条路才会把 `<<image>>` 收进 media 去发。
         * 这两个行为都不是这个仓库能改的，所以只能在这里把用法说死。
         */
        how: '把 <<image: 路径>> **写在回复正文里**发出去。不要放进 qq_send 的参数——那条路不会发图。'
          + '一次一张；路径原样抄，不要改盘符和斜杠。',
        ...(r.items.some((x) => x.degrade)
          ? { note: '标了 degrade 的图超过 20MB，发出去会变成文件而不是表情，能换一张就换。' }
          : {}),
      };
    },
  };

  return [pick];
}

/**
 * 把表情工具挂到一个 agent 上。
 *
 * 失败**不抛错**：工具是增强，装不上不能让整轮对话挂掉；但要把原因带出去，
 * 否则就是「看着装了、其实没装」的死代码（qq-tools 踩过同样的坑）。
 *
 * @returns {Promise<{ok:boolean, names:string[], reason?:string, mode?:string, off?:Function}>}
 */
export async function registerStickerTools({ agent, pickOf, log = () => {} }) {
  const defs = buildStickerToolDefs({ pickOf });
  const registry = agent?.ctx?.tools;
  if (!registry?.register) {
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
      log(`表情工具 ${def.name} 没装上：${e.message}`);
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
