/**
 * 时间轴只读投影（aurabot 对齐 G4）。
 *
 * 对方 /memory/timeline 口径（modules/memory/index.js:547 + memory.js:1974）：
 *   · 数据源 = gists（梗概/印象）+ seen（看过的内容）按 saidTime 降序；
 *   · 五维过滤 kind/platform/chatId/level/about；
 *   · facets 基于「完整时间轴」而非当前筛选（否则选了群之后其他群消失）；
 *   · 分页 limit(默认50/上限200) + offset + total + hasMore。
 *
 * 我方适配（诚实标注，不冒充对方能力）：
 *   · 数据源 = journal 的 digest 行（每日摘要，等价对方 level1 梗概）
 *            + impressions.json 的印象（等价对方 level2 印象）；
 *     我方没有 seen（多平台看过的内容），也没有 platform 字段 →
 *     platform 维度无数据（G10 已核：我方只有 src:ext:<id>，语义不同），
 *     facets 只有 chats + levels，不做假的 platforms 维度。
 *   · 排序用 at（digest 的 at 取那天最后一条消息时间，等价对方 saidTime）；
 *   · about 维度我方 journal 无该字段，过滤参数接受但不生效（不编造）。
 *
 * 纯函数，不连库不写盘。入参是已经取好的行数组。
 */

const LEVEL_RANK = { critical: 3, important: 2, normal: 1 };

/** 把 digest 行 + 印象行归一成时间轴条目；过滤掉失效/抹除/空文本 */
export function normalizeTimelineRows(digestRows = [], impressions = []) {
  const out = [];
  for (const r of Array.isArray(digestRows) ? digestRows : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.invalidAt || r.digest === 'ERASED') continue;
    const text = String(r.text ?? '').trim();
    if (!text || text === '（已按用户要求遗忘）' || text === '（已清除）') continue;
    out.push({
      id: String(r.id ?? ''),
      kind: 'digest',
      text,
      at: Number(r.at) || 0,
      day: String(r.day ?? ''),
      chatId: String(r.chatId ?? ''),
      level: String(r.level ?? ''),
      source: 'journal',
    });
  }
  for (const x of Array.isArray(impressions) ? impressions : []) {
    if (!x || typeof x !== 'object') continue;
    if (x.crystallizedAt) continue; // 已结晶成永久事实，不再留在印象时间轴
    const text = String(x.text ?? '').trim();
    if (!text) continue;
    out.push({
      id: String(x.id ?? ''),
      kind: 'impression',
      text,
      at: Number(x.at) || 0,
      day: '',
      chatId: String(x.chatId ?? ''),
      level: '',
      source: 'impressions',
    });
  }
  return out;
}

/**
 * 投影时间轴：过滤 → facets（基于完整集）→ 排序 → 分页。
 * @param {object} input { digestRows, impressions }
 * @param {object} opts { kind, chatId, level, about, q, limit, offset }
 */
export function projectTimeline(input = {}, opts = {}) {
  const all = normalizeTimelineRows(input?.digestRows, input?.impressions);
  const kind = String(opts?.kind || '');
  const chatId = String(opts?.chatId || '');
  const level = String(opts?.level || '');
  const q = String(opts?.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(opts?.limit) || 50)));
  const offset = Math.max(0, Math.trunc(Number(opts?.offset) || 0));

  // facets 基于完整时间轴（对方刻意设计：选群后其他群选项不能消失）
  const chats = [...new Set(all.map((r) => r.chatId).filter(Boolean))].sort();
  const levels = [...new Set(all.map((r) => r.level).filter(Boolean))]
    .sort((a, b) => (LEVEL_RANK[b] || 0) - (LEVEL_RANK[a] || 0));
  const kinds = [...new Set(all.map((r) => r.kind).filter(Boolean))].sort();

  const filtered = all.filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (chatId && r.chatId !== chatId) return false;
    if (level && r.level !== level) return false;
    if (q && !r.text.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (b.at || 0) - (a.at || 0));

  const list = filtered.slice(offset, offset + limit);
  return {
    list,
    total: filtered.length,
    hasMore: offset + list.length < filtered.length,
    facets: { chats, levels, kinds },
  };
}
