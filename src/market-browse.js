/**
 * 5.6 扩展市场：搜索 / 分类 / 能力标签 / 安装进度
 * ============================================
 *
 * 抽成纯函数是为了让「筛出哪些行」「现在到哪一步」都能直接测，
 * 面板不自己再写一份筛选规则（写两份必然和索引字段漂移）。
 */

/** 索引里 tags 可能是数组、逗号串，也可能压根没有 */
export function normalizeTags(entry) {
  const raw = entry?.tags;
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' ? raw.split(/[,，\s]+/) : [];
  return [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))].slice(0, 12);
}

/**
 * 主分类：索引将来有 `category` 就听它的；现在只有 tags，用第一个标签。
 * 没有标签的归「其它」，不伪装成 0 个分类。
 */
export function categoryOf(entry) {
  const explicit = String(entry?.category ?? '').trim();
  if (explicit) return explicit;
  return normalizeTags(entry)[0] || '其它';
}

/**
 * 搜索命中范围：id / 名字 / 描述 / 作者 / 分类 / 标签 / 命令。
 * 中文不做分词，直接小写包含——市场条目就几十条，够用且不会漏。
 */
export function filterMarketRows(rows, { q = '', category = '', tag = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = String(q ?? '').trim().toLowerCase();
  const cat = String(category ?? '').trim();
  const one = String(tag ?? '').trim();
  return list.filter((r) => {
    if (cat && String(r?.category ?? '') !== cat) return false;
    if (one && !(Array.isArray(r?.tags) && r.tags.includes(one))) return false;
    if (!needle) return true;
    const hay = [
      r?.id, r?.name, r?.description, r?.author, r?.category,
      ...(Array.isArray(r?.tags) ? r.tags : []),
      ...(Array.isArray(r?.commands) ? r.commands : []),
    ].join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

/** 下拉与徽标的可选项，按「出现次数多的在前」，带条数 */
export function facetsOf(rows) {
  const cats = new Map();
  const tags = new Map();
  const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
  for (const r of Array.isArray(rows) ? rows : []) {
    bump(cats, String(r?.category ?? '').trim());
    for (const t of Array.isArray(r?.tags) ? r.tags : []) bump(tags, t);
  }
  const toRows = (m) => [...m.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'zh'))
    .map(([value, count]) => ({ value, count }));
  return { categories: toRows(cats), tags: toRows(tags) };
}

/** 安装阶段 → 百分比与中文标签；顺序就是 install() 的真实执行顺序 */
export const MARKET_PHASES = {
  idle: 0,
  index: 10,
  download: 35,
  verify: 65,
  scopes: 75,
  confirm: 75,
  install: 85,
  finalize: 95,
  done: 100,
  failed: 100,
};

export const PHASE_LABELS = {
  idle: '没有在装',
  index: '拉取索引',
  download: '下载扩展包',
  verify: '校验哈希',
  scopes: '检查权限声明',
  confirm: '等你确认权限',
  install: '落位',
  finalize: '写权限组与受管块',
  done: '完成',
  failed: '结束（未成功）',
};

/** 给面板的进度视图；未知阶段一律按 idle，别让进度条倒退或越界 */
export function phaseView(p) {
  const phase = Object.hasOwn(MARKET_PHASES, String(p?.phase ?? '')) ? String(p.phase) : 'idle';
  return {
    phase,
    id: String(p?.id ?? ''),
    message: String(p?.message ?? ''),
    percent: MARKET_PHASES[phase],
    label: PHASE_LABELS[phase],
    at: Number(p?.at ?? 0) || 0,
  };
}
