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
 * 5.4：按聊天取思考强度（群低 / 私聊高，也能按会话单独覆盖）。
 *
 * 优先级：本会话 > 会话类型 > 全局 > 按类型推荐 > 模型自带。
 * 单独抽一层而不是塞进 pickModelFor：`pick()` 要求 provider+model 齐全，
 * 只给 effort 的补丁层会被整层丢掉。
 *
 * `recommendByKind` 是「没任何显式配置时」的推荐（私聊 high / 群聊 low），
 * 只作兜底：显式写过的 `byChat` / `byKind` / `effort` 一律优先；关掉开关
 * 则这一层完全不参与，回落到「显式配置 > 模型自带」。
 * 注意它默认开，所以**未配置的会话升级后会拿到推荐档**——这是 5.4 的
 * 功能本身；如果要逐字保持旧行为，把 `model.effortByKind` 设为 false，
 * 并且别写 `model.effort`（写了就比模型自带优先）。
 */
export function pickEffortFor({
  byChat = {}, byKind = {}, globalEffort = '', modelEffort = '',
  chatId = '', kind = '', recommendByKind = true,
} = {}) {
  const s = (v) => String(v ?? '').trim();
  const k = s(kind);
  const own = s(chatId) ? byChat?.[s(chatId)]?.reasoningEffort : '';
  const byType = k ? byKind?.[k]?.reasoningEffort : '';
  /** 推荐只作兜底：用户显式写过的全局 effort 优先，关掉开关则完全不参与 */
  const recommend = recommendByKind ? (k === 'c2c' ? 'high' : k === 'group' ? 'low' : '') : '';
  return s(own) || s(byType) || s(globalEffort) || recommend || s(modelEffort);
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
