/**
 * G10 来源统计（对齐 aurabot `platformStats()`，用我方数据来源）。
 *
 * 对方按 `meta.platform`/`via` 统计 episodes/gists/seen 三类；我方记忆条目没有
 * platform 维度，但有 **`src`**（主记忆 `src:null|'tool'|...`，扩展记忆
 * `src:'ext:<extId>'`）。所以这里统计的是「记忆来自哪个来源（扩展 id / 面板 /
 * 聊天 / 主库）」，不是「来自哪个社交平台」——**语义不同，不冒充平台统计**。
 *
 * 用户目的：「看各来源记了多少条，确认扩展写进去的记忆真的进来了」。
 * 纯函数：host 传入已读好的数据，本模块不连库、不写盘、不注入。
 *
 * 对方口径继承：①多来源行在每个来源各计一次；②无来源兜底 'unknown'；
 * ③只读、按来源名排序；④已忘/失效内容不计（由调用方 visibleRows 过滤）。
 */
export const UNKNOWN_SOURCE = 'unknown';

/** 常见来源显示名。扩展 id 不在表里时原样显示（不编造中文名） */
export const SOURCE_LABELS = Object.freeze({
  qq: 'QQ',
  panel: '面板手记',
  tool: '工具写入',
  said: '聊天里记的',
  auto: '自动提炼',
  event: '经历过的事',
  gist: '摘要',
  [UNKNOWN_SOURCE]: '来源未知',
});

/** 显示名：ext:<id> → 扩展 id（若有 label 映射则用）；其它查表，兜底原样 */
export function sourceLabel(src, labels = {}) {
  const s = String(src ?? '').trim();
  if (!s) return SOURCE_LABELS[UNKNOWN_SOURCE];
  if (s.startsWith('ext:')) {
    const id = s.slice(4);
    return labels[id] || labels[s] || id || SOURCE_LABELS[UNKNOWN_SOURCE];
  }
  return labels[s] || SOURCE_LABELS[s] || s;
}

/**
 * 一行属于哪些来源。现在每行只有一个来源（src 或 extId），
 * 但返回数组以便将来多来源时每行各计一次（对齐对方 memoryPlatforms）。
 */
export function sourcesOf(row) {
  if (!row || typeof row !== 'object') return [UNKNOWN_SOURCE];
  const src = String(row.src ?? '').trim();
  if (src) return [src];
  const extId = String(row.extId ?? '').trim();
  if (extId) return [`ext:${extId}`];
  return [UNKNOWN_SOURCE];
}

/**
 * 纯统计。输入都是已读好的数据：
 *   extRows: extMemoryStore.listAll() 的 [{extId, rows:[{src,text,...}]}]
 *   journals: 可选，journal 行（按 kind/role 分类）
 *   labels: 可选，来源 id → 显示名
 * 输出 [{source, label, extFacts, episodes, digest, total}] 按 source 排序。
 */
export function sourceStats({ extRows = [], journals = [], labels = {} } = {}) {
  const counts = new Map();
  const ensure = (src) => {
    if (!counts.has(src)) {
      counts.set(src, { source: src, label: sourceLabel(src, labels), extFacts: 0, episodes: 0, digest: 0, total: 0 });
    }
    return counts.get(src);
  };
  const count = (row, kind) => {
    for (const src of sourcesOf(row)) {
      const c = ensure(src);
      c[kind]++;
      c.total++;
    }
  };

  for (const group of Array.isArray(extRows) ? extRows : []) {
    const extId = String(group?.extId ?? '');
    for (const row of Array.isArray(group?.rows) ? group.rows : []) {
      if (!row || !String(row.text ?? '').trim()) continue;
      count({ ...row, extId: row.extId || extId }, 'extFacts');
    }
  }

  for (const row of Array.isArray(journals) ? journals : []) {
    if (!row || !String(row.text ?? '').trim()) continue;
    const kind = String(row.kind ?? '');
    const role = String(row.role ?? '');
    if (kind === 'digest' || role === 'digest') count(row, 'digest');
    else if (kind === 'chat' || role === 'user' || role === 'bot') count(row, 'episodes');
  }

  return [...counts.values()].sort((a, b) => a.source.localeCompare(b.source));
}
