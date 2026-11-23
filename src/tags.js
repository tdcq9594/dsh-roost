/**
 * 事实标签（阶段 2，对齐 Hindsight 的 tags 用途）
 * ================================================
 *
 * Hindsight 把 tags 做成 bank 级的一等实体（/tags 端点 + 通配符 + 直方图），
 * 我们是单进程零依赖、事实存字符串数组，所以**只借语义不借形态**：
 *   · 标签落在 `meta[正文].tags`（旁路字段，老库没有 = []，不写回盘）；
 *   · 匹配大小写不敏感（同 Hindsight），支持 any / all 两档；
 *   · 列举走直方图（count 降序、tag 升序），不另开 store 方法。
 *
 * 为什么不做成独立实体：一条事实的标签就是它自己的属性，另立一张表
 * 会出现"标签还在、事实没了"的孤儿。Hindsight 有多租户 bank 才需要
 * 那套索引，我们没有。
 *
 * 本模块是纯函数：不读文件、不碰 store，输入什么返回什么，便于单测。
 */

/** 单标签长度上限：超长标签基本是误粘贴，挡住免得悄悄撑大 memory.json */
export const TAG_MAX_LEN = 40;
/** 一条事实最多挂几个标签：与证据账本 EVIDENCE_MAX 同量级 */
export const TAG_MAX_COUNT = 12;

/**
 * 归一化标签数组：trim、限长、去空、按小写去重（保留首次出现的原样）。
 *
 * 返回 [] 表示"没有标签"——调用方据此**不落盘**，老库升级前后逐字节一致。
 * 大小写不敏感去重是因为匹配也不敏感：留着 `Work` 和 `work` 两条只会
 * 让直方图出现两行同一个标签。
 */
export function normalizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const t = String(v ?? '').trim().slice(0, TAG_MAX_LEN);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= TAG_MAX_COUNT) break;
  }
  return out;
}

/**
 * 一条事实的标签是否命中查询条件。
 *
 * `wanted` 为空 = **不过滤**（返回 true）。这一条不能省：listRanked
 * 是注入路径，默认不传 tags，空数组若判成"不匹配"会把全部事实滤光，
 * 等于升级即失忆。
 *
 * @param {string[]} tags     事实自带的标签
 * @param {string[]} wanted   查询标签
 * @param {'any'|'all'} [mode] any=命中其一（默认，同 Hindsight 的 tags_match='any'）；all=全部命中
 */
export function matchTags(tags, wanted, mode = 'any') {
  const w = normalizeTags(wanted);
  if (!w.length) return true;
  const have = new Set(normalizeTags(tags).map((t) => t.toLowerCase()));
  const keys = w.map((t) => t.toLowerCase());
  return mode === 'all'
    ? keys.every((k) => have.has(k))
    : keys.some((k) => have.has(k));
}

/**
 * 通配符匹配：`*` 匹配任意字符（大小写不敏感），对标 Hindsight `/tags?q=user:*`。
 * 没有 `*` 时是大小写不敏感的包含匹配——比精确匹配好用，用户不必记全名。
 */
export function tagPatternMatch(tag, pattern) {
  const p = String(pattern ?? '').trim().toLowerCase();
  if (!p) return true;
  const text = String(tag ?? '').toLowerCase();
  if (!p.includes('*')) return text.includes(p);
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(text);
}

/**
 * 标签直方图：从一批带 tags 的对象里统计用量。
 *
 * 排序同 Hindsight list_tags：count 降序、tag 升序。分页参数在这里就做完，
 * 不把整张直方图传给调用方再裁（老库的标签数可能比想象中多）。
 *
 * @param {Array<{tags?:string[]}>} items
 * @param {{pattern?:string, limit?:number, offset?:number}} [opts]
 * @returns {{items:Array<{tag:string,count:number}>, total:number, limit:number, offset:number}}
 */
export function tagHistogram(items, opts = {}) {
  const counts = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    for (const t of normalizeTags(it?.tags)) {
      const k = t.toLowerCase();
      const hit = counts.get(k);
      if (hit) hit.count += 1;
      else counts.set(k, { tag: t, count: 1 });
    }
  }
  const matched = [...counts.values()]
    .filter((x) => tagPatternMatch(x.tag, opts?.pattern))
    /** tag 升序也按小写比：大小写不敏感的标签，排序不该让大写全排前面 */
    .sort((a, b) => b.count - a.count || (a.tag.toLowerCase() < b.tag.toLowerCase() ? -1
      : a.tag.toLowerCase() > b.tag.toLowerCase() ? 1 : 0));
  const rawLimit = Number(opts?.limit);
  const rawOffset = Number(opts?.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit >= 0 ? Math.min(400, Math.floor(rawLimit)) : 100;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
  return {
    items: matched.slice(offset, offset + limit),
    total: matched.length,
    limit,
    offset,
  };
}
