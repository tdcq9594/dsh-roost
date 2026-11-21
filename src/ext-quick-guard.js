/**
 * `/quick` 的调用方判权
 * ===================
 *
 * 面板 API 有两种调用方：
 *
 *   1. **面板自己的界面**（主人点的按钮）——不带 `viaExt`，全权；
 *   2. **扩展页面**（沙箱 iframe 里，经父窗口转发）——带 `viaExt`，
 *      只能用它**令牌上实际授予的 scope** 换来的那些 op。
 *
 * 为什么不靠页面自己声明身份：页面里的任何字段都可伪造。`viaExt` 由父窗口
 * （面板代码）从自己的状态里填，页面的 `postMessage` 载荷里即使带了也会被忽略。
 * 沙箱上线后页面根本调不到 `/quick`（`Origin: null` 被拒），这道判权是第二层。
 *
 * 判据在 `ext-quick-scopes.js` 的 `OP_SCOPE` 表：**表里没有的 op 一律拒**
 * （fail-closed）。
 */

import { allowsOp, isSelfOnlyOp, SELF_ONLY_OPS } from './ext-quick-scopes.js';

/**
 * 只能操作「自己」的那批 op：`arg.id` 必须是调用方自己。
 *
 * **从 `SELF_ONLY_OPS` 派生**，不要另抄一份——两份清单迟早漂：
 * 新加一个只碰自己的 op，改了一处忘了另一处，表现是「判权放行但 id 没被纠正」。
 */
const SELF_ID_OPS = new Set(SELF_ONLY_OPS);

/**
 * @param {object} o
 * @param {string} o.op
 * @param {any} o.arg
 * @param {string} [o.viaExt] 调用方是哪个扩展（父窗口填的；空 = 面板自己）
 * @param {string[]} [o.scopes] 该扩展令牌上**实际授予**的 scope
 * @returns {{ ok:true, arg:any } | { ok:false, status:number, why:string }}
 */
/**
 * 面板自己的标记。
 *
 * 为什么不用「`viaExt` 为空」表示面板：那样一来，任何**漏传**这个字段的调用
 * 都会拿到全权，而漏传是很常见的错误。用 `@` 开头是因为扩展 id 的正则是
 * `/^[a-z][a-z0-9-]{1,31}$/`，撞不上。
 */
export const PANEL_MARK = '@panel';

export function guardQuickCall({ op, arg, viaExt = '', scopes = [] } = {}) {
  const id = String(viaExt ?? '').trim();
  /** 面板自己：主人点按钮，一直是全权（这套判权只管扩展页面） */
  if (id === PANEL_MARK) return { ok: true, arg };
  /** 没带标记 = 不认识调用方：拒绝，不要默认当面板 */
  if (!id) return { ok: false, status: 400, why: '缺少调用方标记（面板要带 viaExt=@panel）' };

  const verdict = allowsOp(op, scopes);
  if (!verdict.ok) return { ok: false, status: 403, why: verdict.why };

  if (SELF_ID_OPS.has(op) && !scopes.includes('ext:manage')) {
    const given = String(arg?.id ?? '').trim();
    /**
     * 传了**别人**的 id 就直接拒，不要悄悄改成一个对的——
     * 悄悄改会让扩展作者以为「传 id 有用」，排查时看不到任何痕迹。
     */
    if (given && given !== id) {
      return {
        ok: false,
        status: 403,
        why: `只能操作自己的配置与动作（当前扩展是 ${id}）；要操作别的扩展需要 ext:manage`,
      };
    }
    /** 没传就补上自己的 id（页面本来就知道自己是谁，漏传是常见写法） */
    return { ok: true, arg: { ...(arg && typeof arg === 'object' ? arg : {}), id } };
  }

  return { ok: true, arg };
}

export { isSelfOnlyOp };
