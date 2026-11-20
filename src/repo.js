/**
 * 仓库归属（唯一出口）
 * ====================
 * GitHub 的 roost 仓库在组织 `roost-qq` 下，Gitee 镜像仍在 `tdcq9594`
 * 个人账号下。两边 owner 不同，所有 Gitee 地址必须经 giteeRepoOf() 换算，
 * 不要在别处把 GitHub slug 直接拼进 gitee.com。
 *
 * 组织或账号改名只改这里；调用方一律引用常量。
 */
export const GH_OWNER = 'roost-qq';
export const GITEE_OWNER = 'tdcq9594';

export const FW_REPO = `${GH_OWNER}/qq-bot-roost`;
export const GITEE_FW_REPO = `${GITEE_OWNER}/qq-bot-roost`;
export const EXT_REPO = `${GH_OWNER}/qq-bot-roost-plugins`;
export const PERSONA_REPO = `${GH_OWNER}/dsh-roost-personas`;
export const GITEE_PERSONA_REPO = `${GITEE_OWNER}/dsh-roost-personas`;

/** GitHub slug（owner/name）→ Gitee 同名仓库的 slug */
export function giteeRepoOf(repo) {
  const slug = String(repo ?? '');
  return slug.startsWith(`${GH_OWNER}/`)
    ? `${GITEE_OWNER}/${slug.slice(GH_OWNER.length + 1)}`
    : slug;
}
