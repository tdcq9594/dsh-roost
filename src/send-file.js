/**
 * 发文件的路径判断。
 *
 * 抽成独立模块的唯一理由是**能单测**：这段逻辑错了，表现是「该发的发不出去」
 * 或者更糟的「不该发的发出去了」，两种都只能靠人肉试才发现。
 *
 * 默认**不限制**（`restrictPaths: false`）：这台机器只有主人能调工具
 * （`permissions.owner = 'all'`，其余档位轮开始前就把工具收走了），
 * 所以「能发哪些文件」本来就等价于「主人想让发哪些」。再套一层只会挡自己。
 * 需要把机器人借给别人用时再打开限制。
 *
 * 打开限制时用的是**目录白名单**，不是扩展名白名单 —— 跟腾讯官方
 * `dsh-qqbot` 的 `sendFile.restrictPaths` 同一套语义：限制的是「能碰哪个目录」，
 * 而不是「能发哪种后缀」。按扩展名拦会把 `.csv`、`.zip`、无扩展名的文件
 * 全挡掉，那些恰恰是最常要发的。
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

/**
 * 发文件的硬上限。跟框架的 `MEDIA_HARD_LIMIT` 对齐（200MB）——
 * 那是官方绝对上限（`file_type=4` 的软限也是 200MB），超了连分片上传都救不了。
 *
 * 在宿主这一侧挡一道的唯一意义是：**这是全链路唯一能当场告诉模型"太大"的地方**。
 * 放过去的话，失败只会出现在 ai-chat 的日志里，而模型已经跟人说了「发你了」。
 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

/**
 * 解析出「尽量真实」的路径。
 *
 * 存在的部分走 realpath（防目录级符号链接逃逸——`workspace/link` 指到 `/etc`
 * 时，光比字符串前缀是查不出来的）；不存在的尾部保持词法拼接。
 *
 * 为什么不用官方的 `/` 分割写法：那是 POSIX 专有的。Windows 上把 `C:\a\b`
 * 按 `/` 切会得到一整段，`realpathSync('C:')` 返回的是**当前目录**而不是
 * C 盘根——前缀就整个错位了。所以这里用 `parse().root` 拿真正的根。
 */
export function realishPath(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    /* 不存在就走下面的逐级回退 */
  }
  const { root } = parse(abs);
  const segs = abs.slice(root.length).split(sep).filter(Boolean);
  for (let i = segs.length; i > 0; i -= 1) {
    try {
      return join(realpathSync(join(root, ...segs.slice(0, i))), ...segs.slice(i));
    } catch {
      /* 再往上退一级 */
    }
  }
  return abs;
}

/**
 * filePath 是否位于 root 之内（含 root 本身）。
 *
 * root 不可解析（不存在 / 坏链接）时返回 false——**无效的根不应该放行任何东西**。
 * 文件本身不存在不算「越权」：那由调用方按 missing 处理，
 * 否则「文件不存在」会被误报成「路径不允许」，排查时方向全错。
 */
export function isWithinRoot(filePath, root) {
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realishPath(filePath));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  /**
   * 逃逸判断不能只写 `startsWith('..')`：`root/..资料/a.txt` 的 relative 是
   * `..资料\a.txt`，那是 root **里面**一个以两个点开头的目录，不是越权。
   * 按官方的 `startsWith('..')` 写会把它拒掉——文件名以点开头在 Windows 上
   * 虽不常见，但 `..` 后面直接跟分隔符才是唯一的真逃逸形态。
   */
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * 这个路径能不能发。
 *
 * @param {string} filePath 绝对路径
 * @param {object} [cfg]
 * @param {boolean} [cfg.restrictPaths] false（默认）= 不限制
 * @param {string[]} [cfg.extraRoots] 额外允许的根目录
 * @param {string[]} [cfg.roots] 内置允许的根（workspace / images）
 * @returns {{ok:true} | {ok:false, reason:'denied', message:string}}
 */
export function pathAllowed(filePath, { restrictPaths = false, extraRoots = [], roots = [] } = {}) {
  if (!restrictPaths) return { ok: true };
  const all = [...(roots || []), ...(extraRoots || [])].map(String).filter(Boolean);
  if (all.some((root) => isWithinRoot(filePath, root))) return { ok: true };
  return {
    ok: false,
    reason: 'denied',
    /**
     * 报错只说「不在允许的目录内」，**不列具体白名单**——
     * 这句话会进模型的工具结果，再被它复述到群里。
     */
    message: `这个路径不在允许发送的目录内：${filePath}`,
  };
}
