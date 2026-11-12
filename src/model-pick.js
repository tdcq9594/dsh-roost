/**
 * 按聊天选模型（E6）+ 思考强度能力探测（E8）
 * ==========================================
 *
 * 抽成纯函数是为了能直接测「回退顺序」和「不支持就不传」这两件最容易写错的事；
 * host 里那段只负责取数据、调宿主接口。
 *
 * 官方接口（已核 `deepseek-ai/deepseek-harness` 文档）：
 *   · 读当前选择：`agent.model.current()` → `{provider, model, reasoningEffort?}`
 *   · 写下一个 step：`agent.model.select({provider, model, reasoningEffort?})`
 *   · 模型能力：`ctx.llm.resolveModelInfo(provider, model)` →
 *     `{ reasoning: { efforts: [{id,name}], defaultEffort? }, inputModalities? }`
 *
 * 两条硬规则：
 *   1. `reasoningEffort` 是 **adapter 私有**的不透明 id，没有跨模型统一枚举；
 *      传不支持的值会在**任何 provider I/O 之前**直接失败（文档原文），
 *      所以必须先问 `resolveModelInfo`，不支持就不传、让 adapter 用默认值。
 *   2. `efforts` 为空 = adapter **没公布**档位（未知），**不等于不支持**——
 *      这时保持原值，别擅自删掉用户配的 effort。
 */

/**
 * 选这次要用的模型：单个聊天 > 会话类型默认 > 所有聊天的默认 > 全局默认。
 *
 * 四层顺序对齐 aurabot `chat-model.js` 的「单个私聊 / 单个群 > 私聊默认 /
 * 群默认 > 全局」：QQ 里私聊和群的 chatId 都唯一，所以第一层落到同一个
 * `byChat[chatId]` 键上；第二层是 `byKind[kind]`（`c2c` / `group`）；
 * 第三层 `defaultSel` 是「所有聊天都用它」（`model.default`）；
 * 最后才是 DSH 自己的全局默认模型。
 *
 * @param {{byChat?:object, byKind?:object, defaultSel?:object, chatId?:string, kind?:string, globalSel?:object}} opts
 * @returns {{provider:string, model:string, reasoningEffort:string}|null}
 */
export function pickModelFor({ byChat, byKind, defaultSel, chatId = '', kind = '', globalSel } = {}) {
  const pick = (o) => {
    if (!o || typeof o !== 'object') return null;
    const provider = String(o.provider ?? '').trim();
    const model = String(o.model ?? '').trim();
    if (!provider || !model) return null;
    return {
      provider,
      model,
      reasoningEffort: String(o.reasoningEffort ?? '').trim(),
    };
  };
  const key = String(chatId ?? '').trim();
  const own = key && byChat && typeof byChat === 'object' ? byChat[key] : null;
  const k = String(kind ?? '').trim();
  const byType = k && byKind && typeof byKind === 'object' ? byKind[k] : null;
  return pick(own) || pick(byType) || pick(defaultSel) || pick(globalSel);
}

/**
 * E8：这个模型支不支持当前配的思考强度。
 *
 * @param {{provider:string, model:string, reasoningEffort?:string}} sel
 * @param {(provider:string, model:string) => Promise<object>} [resolveModelInfo]
 *        `ctx.llm.resolveModelInfo`；宿主没暴露就不传（保持原值）
 * @returns {Promise<string>} 可以安全传给宿主的值；空串 = 不传、用 adapter 默认
 */
export async function pickReasoningEffort(sel, resolveModelInfo) {
  const want = String(sel?.reasoningEffort ?? '').trim();
  if (!want) return '';
  if (typeof resolveModelInfo !== 'function') return want;
  try {
    const info = await resolveModelInfo(sel.provider, sel.model);
    const ids = (info?.reasoning?.efforts ?? [])
      .map((e) => String(e?.id ?? '').trim())
      .filter(Boolean);
    /** adapter 没公布档位 = 未知，不是「不支持」：保持原值 */
    if (!ids.length) return want;
    return ids.includes(want) ? want : '';
  } catch {
    /** 探测失败不该拖垮建会话：维持原值，让宿主自己判 */
    return want;
  }
}

/**
 * E8 的「看不了图就换成文字提示」**不由我们做**。
 *
 * 官方 `llm/llm` 文档原文：text-only 路由会收到「确定性的逐图占位符」
 * （deterministic per-image placeholders），且 `inputModalities` **缺省 = 未知**
 * （不等于不支持）。我们若再自己判断一次，既重复又容易把「未知」误判成
 * 「不支持」而丢图。所以这里只保留思考强度探测，看图交给 DSH。
 */
