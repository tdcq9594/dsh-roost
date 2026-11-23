/**
 * 心智模型树（B2，精简版 Hindsight observation_tree / OKF）。
 *
 * Hindsight 把观察按实体聚类成一棵可导航、可 grep、可导出给 LLM 的树。
 * 我们已经有"观察"的实质——每条事实带 evidence(quote/journalId) 和 trend
 * （PR #41 做的，对齐它的 observations.py）；缺的是**把散落的事实组织成
 * 「她现在相信什么」的结构**。这个模块就补这一层。
 *
 * 纯函数：输入 facts（listFull 的输出）+ entities（图谱实体名），输出树与
 * markdown。不写盘、不调模型、不依赖宿主——LLM 反思循环属于额外一类，
 * 不在这里。
 *
 * 设计取舍：
 *   · 聚类用实体名的最长匹配（"杭州"和"杭州的朋友"同时出现时归后者）
 *   · 没匹配到任何实体的事实归"其他"，不丢
 *   · 已取代(until)/归档(archivedAt)的事实排除——心智模型只写"现在相信的"
 *   · trend 是可解释信号：weakening/stale 的观察标出来，提示可能已过时
 */

import { FACT_KINDS } from './memory.js';
/** 防注入：事实正文来自模型/用户，带换行就能伪造 markdown 标题或条目 */
import { oneLine } from './memory-line.js';

const OTHER = '其他';

/** 一条事实归到哪个实体：最长名字优先，避免短词抢走长词 */
function entityOf(text, entities) {
  const s = String(text ?? '');
  let best = '';
  for (const raw of entities || []) {
    const name = String(raw ?? '').trim();
    if (name.length >= 2 && name.length > best.length && s.includes(name)) best = name;
  }
  return best || OTHER;
}

/** trend 的中文说明（和面板一致），只标非默认态 */
const TREND_NOTE = Object.freeze({
  strengthening: '证据增强中',
  weakening: '证据走弱，可能过时',
  stale: '久无新证据，待核实',
});

/**
 * 建树。返回 { groups: [{ entity, facts: [...] }], total, staleCount }
 * facts 每项：{ text, w, kind, trend, quotes:[{quote, journalId, at}], knownBy }
 */
export function buildMindModel(facts = [], entities = []) {
  const byEntity = new Map();
  let stale = 0;
  for (const f of facts) {
    /** 已取代/归档的不进"现在相信什么" */
    if (Number(f?.until) > 0 || Number(f?.archivedAt) > 0) continue;
    const text = String(f?.text ?? '').trim();
    if (!text) continue;
    const entity = entityOf(text, entities);
    const trend = String(f?.trend ?? '');
    if (trend === 'stale' || trend === 'weakening') stale += 1;
    const quotes = (Array.isArray(f?.evidence) ? f.evidence : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        /** 证据有两种形状：带 quote 的可核验引文 / 只有 detail 的短摘要 */
        quote: String(e.quote ?? e.detail ?? '').slice(0, 120),
        journalId: String(e.journalId ?? ''),
        at: Number(e.at) || 0,
      }))
      .filter((q) => q.quote);
    if (!byEntity.has(entity)) byEntity.set(entity, []);
    byEntity.get(entity).push({
      text,
      w: Number(f?.w) > 0 ? Number(f.w) : 1,
      /** world/experience/observation，默认 world */
      kind: FACT_KINDS.includes(f?.kind) ? f.kind : 'world',
      trend,
      quotes,
    });
  }
  /** 每组内：权重高的在前，同权重按 trend 严重度（越可能过时的越靠前提醒） */
  const rank = { weakening: 2, stale: 1, strengthening: -1 };
  const groups = [...byEntity.entries()]
    .map(([entity, list]) => ({
      entity,
      facts: list.sort((a, b) => (b.w - a.w) || ((rank[b.trend] || 0) - (rank[a.trend] || 0))),
    }))
    .sort((a, b) => (b.facts.length - a.facts.length) || a.entity.localeCompare(b.entity, 'zh-CN'));
  return { groups, total: groups.reduce((n, g) => n + g.facts.length, 0), staleCount: stale };
}

/**
 * 渲染成 markdown（可导出成 index.md，或注入 prompt 当"她相信什么"）。
 * maxChars 截断保整组：宁可少放一组，也不把一组截一半。
 */
export function renderMindModel(tree, { maxChars = 4000, title = '她现在相信什么' } = {}) {
  const out = [`# ${title}`, '', `共 ${tree.total} 条，${tree.staleCount} 条待核实。`, ''];
  const headerLines = out.length;
  for (const g of tree.groups || []) {
    const block = [`## ${oneLine(g.entity)}`, ''];
    for (const f of g.facts) {
      const note = TREND_NOTE[f.trend] ? `（${TREND_NOTE[f.trend]}）` : '';
      const kind = f.kind !== 'world' ? ` [${f.kind}]` : '';
      block.push(`- ${oneLine(f.text)}${kind}${note}`);
      for (const q of f.quotes) {
        block.push(`  - 证据：${oneLine(q.quote)}${q.journalId ? ` (${oneLine(q.journalId)})` : ''}`);
      }
    }
    block.push('');
    const candidate = out.concat(block).join('\n');
    /**
     * 超预算时跳过**这一组**、继续试后面的小组——不能用 break：
     * 第一组超了就 break 会把后面所有组连带丢光（只剩标题）。
     */
    if (candidate.length > maxChars) continue;
    out.push(...block);
  }
  /** 一组都放不下时，至少给一条截断的事实，别只吐个空标题 */
  if (out.length === headerLines && (tree.groups || []).length) {
    const first = tree.groups[0].facts[0];
    if (first) {
      /** 预留量按当前头部实际长度算，不写死 80（maxChars 很小时会截成空串） */
      const used = out.join('\n').length + `## ${oneLine(tree.groups[0].entity)}`.length + 8;
      const room = Math.max(12, maxChars - used);
      const line = `- ${oneLine(first.text).slice(0, room)}…（已截断）`;
      out.push(`## ${oneLine(tree.groups[0].entity)}`, '', line);
    }
  }
  return out.join('\n').trimEnd();
}
