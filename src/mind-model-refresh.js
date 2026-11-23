/**
 * 心智模型 refresh 编排（阶段 4，B2）
 * =====================================
 *
 * 照 Hindsight `mental_model_refresh.py` 的两档：
 *   · full   —— 用全部活事实重建机械投影（我们的默认值，零模型调用）
 *   · delta  —— 只看 watermark 之后的事实；模型模式可用它省 token
 *
 * 但**照搬模式名不照搬 AI 生成**：Hindsight 让模型改写整篇 model document，
 * 我们是单进程 QQ 机器人，`buildMindModel` 已经是"她现在相信什么"的结构化
 * 投影，让模型自由重写只会引入幻觉与自我强化。所以：
 *   · **mechanical（默认）**：纯投影写盘，不调模型、不进 journal；
 *   · **model（默认关，显式开启）**：调注入的 generate，但给它的是"逐组核对、
 *     只输出精简版 markdown"的严格 prompt，输出只作为快照落 mind-model.json，
 *     绝不回灌 journal / self / facts。
 *
 * dry-run 跑同一条 pipeline 但不写盘（对标 Hindsight 的 dry-run 可重复性）。
 */

import { buildMindModel, renderMindModel } from './mind-model.js';

/** 模型模式的最大输入字符：事实多时只取前面这些，避免烧 token */
const MAX_INPUT = 6000;

/**
 * 收集刷新素材：活事实（排除 until/archivedAt）+ 实体名。
 * `listFull` 的输出已经是纯投影，这里只做筛选，不改存储。
 */
export function collectModelInput(full = {}, entities = [], watermark = 0) {
  const rows = [...(Array.isArray(full.global) ? full.global : []), ...(Array.isArray(full.chat) ? full.chat : [])];
  const fresh = rows
    .filter((r) => r && !Number(r.until) && !Number(r.archivedAt) && String(r.text ?? '').trim())
    /** delta：只看 watermark 之后有变化的事实（at 或 reviewedAt） */
    .filter((r) => !watermark || Math.max(Number(r.at) || 0, Number(r.reviewedAt) || 0) > watermark);
  return {
    rows: fresh,
    entities: (Array.isArray(entities) ? entities : []).map((e) => String(e?.name ?? e)).filter(Boolean),
    total: fresh.length,
  };
}

/**
 * 严格 prompt：只让它精简/重组**给定**内容，不许新增事实。
 * 输出必须是 markdown，且明确禁止回写记忆/发消息（工具在调用侧已被裁掉）。
 */
export function buildRefreshPrompt({ markdown = '', baseline = '', delta = false, name = '她' } = {}) {
  const head = [
    `你是「${name}」的心智模型整理器。下面的内容已经过核实，不要质疑真伪。`,
  ];
  if (delta) {
    /**
     * 照搬 Hindsight `reflect/prompts.py:1488-1526` 的关键一句：
     * delta 只看到半窗，可能比文档已记的更旧，**不许说 current / latest / still true**，
     * 也不许断言某事没发生。否则半窗会被当成"完整当前状态"，这是最隐蔽的回音。
     */
    head.push(
      '这是一次增量刷新：你只看到上次更新以来的新信息，它可能比文档已记录的更旧。',
      '用带日期的事件陈述（如「2026 年 4 月，她搬到了杭州」）；',
      '不要说「当前」「最新」「仍然」「依旧如此」，也不要断言某件事没发生过。',
      '下面是基线全文（保留它的结构与未涉及的条目）+ 本次新增的事实：',
      '--- 基线 ---', String(baseline ?? '').slice(0, MAX_INPUT),
      '--- 本次新增 ---',
    );
  } else {
    head.push('这是一次全量刷新：下面是完整的当前事实，不要引入下面的内容之外的任何判断。');
  }
  return [
    ...head,
    String(markdown ?? '').slice(0, MAX_INPUT),
    delta ? '--- 新增结束 ---' : '--- 投影结束 ---',
    '你的唯一任务：把同样的内容重新组织成更清晰的 markdown，删掉重复、合并同义分组。',
    '铁律：① 不得新增任何上面没有的事实或评价；② 不得输出解释、寒暄或"好的"；③ 只输出 markdown 正文。',
  ].join('\n');
}

/**
 * 模型输出清洗：只接受 markdown 正文，剥掉可能的 ``` 围栏与前后废话。
 * 空输出一律失败——宁可保留上一版，也不写一份空快照覆盖掉。
 */
export function cleanRefreshOutput(raw) {
  let s = String(raw ?? '').trim();
  /** 末尾可能没换行（模型常见输出），\n? 宽容一点，别把合法围栏判成空 */
  const fence = s.match(/^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fence) s = fence[1].trim();
  if (!s || s.length < 20) return '';
  return s.slice(0, 8000);
}

/**
 * 跑一次 refresh。
 *
 * @param {object} p
 * @param {object} p.full          memory.listFull 的输出
 * @param {string[]} p.entities    实体名数组
 * @param {object} p.store         createMindModelStore 实例
 * @param {string} [p.id]          模型 id（默认 default）
 * @param {'full'|'delta'} [p.mode]
 * @param {boolean} [p.dry]        true=跑 pipeline 但不写盘
 * @param {boolean} [p.useModel]   默认 false；true 才调 generate（默认关）
 * @param {function} [p.generate]  注入的模型调用，签名 (prompt)=>Promise<string>
 * @returns {Promise<object>}  {ok, id, mode, effectiveMode, markdown, watermark, facts, persisted, reason}
 */
export async function refreshMindModel({
  full = {}, entities = [], store, id = 'default', mode = 'full',
  dry = false, useModel = false, generate = null, now = () => Date.now(),
} = {}) {
  const key = String(id || 'default');
  const prev = store?.get?.(key) || null;
  const requested = mode === 'delta' ? 'delta' : 'full';

  /**
   * 坑 #3875（Hindsight）：范围内没有可读记忆就**短路**，连空跑都不做。
   * 有基线时更要短路——否则空树渲染出的"共 0 条"会覆盖上一版完整快照。
   */
  const all = collectModelInput(full, entities, 0);
  if (!all.rows.length) {
    return {
      ok: false, id: key, mode: requested, effectiveMode: requested,
      reason: '没有可整理的事实，已跳过（上一版快照保持不动）',
      persisted: false, shortCircuited: true,
    };
  }

  /**
   * delta 的两个 fallback（Hindsight #3112 的教训）：
   *   · 没有基线内容 → full（no_baseline_content）
   *   · delta 模型输出不可用 → full，并且**不推进水位、不写半窗候选**
   * 水位只在整份快照真正落盘时才前移，否则那批新事实会被永久漏掉。
   */
  const canDelta = requested === 'delta' && Boolean(prev?.markdown);
  const watermark = canDelta ? Number(prev?.watermark) || 0 : 0;
  const delta = canDelta ? collectModelInput(full, entities, watermark) : null;
  /** 机械投影永远用全量活事实；delta 只影响"给模型看什么"，不用来拼整篇快照 */
  const tree = buildMindModel(all.rows, all.entities);
  const fullMarkdown = renderMindModel(tree);

  let markdown = fullMarkdown;
  let effectiveMode = canDelta ? 'delta' : 'full';
  let fallbackReason = requested === 'delta' && !canDelta ? 'no_baseline_content' : null;
  let usedModel = false;
  let reason = '';

  const modelOn = useModel && typeof generate === 'function';
  if (modelOn) {
    try {
      /**
       * delta 时 prompt 里同时给基线全文 + 本次新增，并要求保留基线结构；
       * full 时只给全量投影。两种都要求"输出整篇"，绝不输出只覆盖半窗的候选。
       */
      const prompt = buildRefreshPrompt({
        markdown: canDelta ? renderMindModel(buildMindModel(delta.rows, delta.entities)) : fullMarkdown,
        baseline: canDelta ? prev.markdown : '',
        delta: canDelta,
      });
      const out = cleanRefreshOutput(await generate(prompt));
      if (out) {
        markdown = out;
        usedModel = true;
      } else {
        /** 输出不可用：整篇退回全量机械，模式也退回 full（绝不写半窗） */
        effectiveMode = 'full';
        fallbackReason = canDelta ? 'delta_ops_failed' : null;
        reason = '模型输出为空或不合法，已用全量机械投影（水位不动）';
      }
    } catch (e) {
      effectiveMode = 'full';
      fallbackReason = canDelta ? 'delta_ops_failed' : null;
      reason = `模型调用失败，已用全量机械投影（水位不动）：${e?.message ?? e}`;
    }
  }

  /**
   * 水位 = 这次看到的**全部**活事实里最新的时间，不是 now()：
   * 用 now() 会把快照之后、DB 提交尚未可见的事实永久漏掉（Hindsight #3531 同款）。
   */
  const nextWatermark = all.rows.reduce((mx, r) => Math.max(mx, Number(r?.at) || 0, Number(r?.reviewedAt) || 0), 0)
    || now();
  const result = {
    ok: true,
    id: key,
    mode: requested,
    effectiveMode,
    fallbackReason,
    markdown,
    watermark: nextWatermark,
    facts: all.total,
    deltaFacts: delta?.total ?? 0,
    groups: tree.groups.length,
    usedModel,
    reason,
    persisted: false,
  };
  if (!dry && store?.put) {
    const put = store.put(key, {
      markdown, watermark: nextWatermark,
      mode: effectiveMode, reason: usedModel ? 'model' : 'mechanical',
    });
    result.persisted = Boolean(put?.ok);
    result.archived = Boolean(put?.archived);
  }
  return result;
}
