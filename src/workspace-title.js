/**
 * 工作区的默认名字（主人 2026-11-14：「只有第一次创建的改，就是改向导里面的默认」）
 * ==========================================================================
 *
 * 不写进 `DEFAULTS.workspace.name`：那个字段一旦有值，`workspaceId()` 每次
 * 建会话都会拿它去 rename，用户后来自己改的名字会被盖回去。这里只在
 * 「工作区还带着自动生成的名字」时给一次默认名，改过就再也不碰。
 *
 * 目录仍然是 `<数据目录>/workspace` —— 改目录会动 `send-file.js` 的文件根
 * 白名单和已有数据，跟「只改名字」是两回事。
 */

export const DEFAULT_WORKSPACE_TITLE = 'Roost·QQ';

/**
 * 决定这次要不要给工作区改名，以及改成什么。
 *
 * @returns {string} 目标名字；空串 = 不改名
 */
export function workspaceTitleFor({
  configuredName = '', currentTitle = '', dirName = '',
} = {}) {
  /** 用户在面板里显式填过名字：它最大，且一直生效 */
  const want = String(configuredName ?? '').trim();
  if (want) return want;

  const cur = String(currentTitle ?? '').trim();
  const auto = String(dirName ?? '').trim();
  /** 还没建好 / 没拿到 title：按第一次创建处理 */
  if (!cur) return DEFAULT_WORKSPACE_TITLE;
  /**
   * 「没被命名过」的两种形态：
   *   · DSH 按目录名自动取的（默认目录时就是 `workspace`）
   *   · 历史版本建成的「QQ」（老代码会把它纠正成 `workspace`）
   */
  if (cur === 'QQ' || (auto && cur === auto)) return DEFAULT_WORKSPACE_TITLE;
  /** 用户自己改过名 → 一个字都不碰 */
  return '';
}
