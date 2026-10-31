/**
 * 四段耗时的计算
 * ==============
 *
 * 一条消息要穿过四段：
 *
 *   queue  内核收到事件 → 插件拿到        （内核分发排队）
 *   prep   插件准备 → 宿主开始处理        （组 payload、网络往返）
 *   gen    宿主这一轮                    （模型生成 + 落盘）
 *   send   宿主回完 → 真正发到群里        （在 ai-chat 那边量，宿主看不到）
 *
 * 宿主只能算前三段：`recv`/`start` 是 ai-chat 带过来的时间点，
 * `started` 是宿主自己开始处理的时间。第四段宿主拿不到，不假装有。
 *
 * ## 两个必须防的边界
 *
 * 1. **时间点缺失**：老版本插件不带 `t`，或者只带一个。缺就给 `null`，
 *    不能给 0——0 会被读成「这一段耗时 0ms」，比没有更误导。
 * 2. **时钟回拨**：`recv`/`start` 来自另一台机器的进程（插件和宿主可能不同机），
 *    系统时间不同步时差值可能是负的。负值一律夹到 0，不输出「-3ms」。
 */

/**
 * @param {object} payload 入站载荷（可能带 `t: { recv, start }`）
 * @param {number} started 宿主开始处理这一轮的时间
 * @param {number} [now]
 * @returns {{queue:number|null, prep:number|null, gen:number}}
 */
export function segmentsOf(payload, started, now = Date.now()) {
  const t = payload?.t || {};
  /**
   * 只认**正数**。`Number(-1) || 0` 会得到 -1（truthy），于是两个负数相减
   * 得到 0，输出「0ms」——又是一个把「没有」显示成「0」的坑。
   */
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
  const recv = num(t.recv);
  const prep = num(t.start);
  return {
    // 两个时间点都有才敢算：只拿一个，差值就是「从 1970 年到现在」
    queue: recv && prep ? Math.max(0, prep - recv) : null,
    prep: prep ? Math.max(0, started - prep) : null,
    gen: Math.max(0, now - started),
  };
}
