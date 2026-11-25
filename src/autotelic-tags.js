/** 自驱 tag 封闭词表——移植自 aurabot-beta `src/autotelic/tags.js`（MIT, Aurabot contributors）。只保留出厂 tag 列表。 */

export const DEFAULT_TAGS = [
  '未完成', // 答应过没做完的事会冒头
  '牵挂',   // 主人提过的忙/烦/喜欢
  '好奇',   // 反复碰到还不懂的东西
  '得意',   // 刚学会想找机会用
  '余韵',   // 久未用的技能想再试试
  '学习',
  '创作',
  '练习',   // 练已会的技能防退步（决策环需要）
  '整理',   // 收拾自己的记忆/技能/草稿（决策环需要）
  '生活',
  '分享',
  '问候',   // 向主人或朋友开口（touch-owner 类）
  '陪伴',   // 回应式之外的一次主动陪伴（touch-owner 类）
  '关怀',
  '探索',
]

/** 用户扩展文件的默认文件名（配合 api.dataDir 使用）。 */

/** tag 是否在生效词表里（P1 · observe 层用；与对方 tags.js:73 同口径）。 */
export function isValidTag(tag, tags = DEFAULT_TAGS) {
  const s = String(tag ?? '').trim();
  return Boolean(s) && tags.includes(s);
}
