/**
 * 版本号比较。放一个单独的文件，是因为它被三处用到
 * （人格仓库的 `minVersion` 门槛、本体自更新的"有没有新版"、装完核对实际版本），
 * 抄三遍迟早会有一处写错——尤其是"按数字比而不是按字符串比"这条
 * （`0.10.10` > `0.10.9`，字符串比较会得出反的结论）。
 */
export function compareVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
