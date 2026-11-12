/**
 * 「等一下再试一次」的退避调度。
 *
 * 为什么单独一个模块
 * ----------------
 * 这段逻辑最容易写错、也最难被发现写错：它平时不说话，只在「对端起得比
 * 本进程晚」这种时序下才起作用。埋在一个几千行的主模块里既没法测，
 * 出问题也只能靠用户撞上。
 *
 * 通用的「等一下再试」调度：任何需要等外部服务就绪后重跑一次的动作，
 * 都可以传 `run` 进来。移除 ai-chat 之后当前没有调用方，保留是因为
 * 退避节奏和下面两条性质是独立可测的能力，以后接别的外部服务会再用上。
 *
 * 节奏
 * ----
 * 前 `fastTimes` 次用 `fastMs`（默认 6 次 × 5 秒，覆盖「Roost 慢几秒起来」），
 * 之后 `slowMs`（默认 1 分钟），总时长封顶 `maxMs`（默认 30 分钟）。
 * 超过就说明不是时序问题了，交给用户，别再空转。
 *
 * 两条容易被破坏的性质（测试盯着）：
 *   1. **不叠加**：排队中再来一次 schedule 不该插队，否则失败一次变两条链。
 *   2. **可作废**：外部条件变了（重启、成功、卸载）旧队列必须清掉，
 *      否则过期的重试会把状态改回去。
 */

export function createSyncRetry({
  run,
  log = () => {},
  maxMs = 30 * 60_000,
  fastTimes = 6,
  fastMs = 5_000,
  slowMs = 60_000,
  now = Date.now,
  setT = (fn, ms) => setTimeout(fn, ms),
  clearT = (t) => clearTimeout(t),
} = {}) {
  let timer = null;
  let tries = 0;
  /**
   * 用 `null` 而不是 `0` 当「还没开始」的哨兵。
   *
   * 写 `if (!startedAt) startedAt = now()` 在真机上碰不到问题（Date.now()
   * 不可能是 0），但它把「时间源返回 0」和「还没开始」混成一个值——
   * 假时钟一跑就露馅：第一次记为 0，第二次又被当成没开始，重新计时，
   * 于是「30 分钟封顶」永远不触发，队列无限重试。
   */
  let startedAt = null;

  /** 作废整个队列（重启、成功、卸载时都要调） */
  function reset() {
    if (timer) clearT(timer);
    timer = null;
    tries = 0;
    startedAt = null;
  }

  /**
   * 排下一次尝试。已经在排队就什么都不做。
   * @returns {number|null} 本次延迟毫秒；没排（已在排队 / 已放弃）返回 null
   */
  function schedule(actual) {
    if (startedAt === null) startedAt = now();
    if (now() - startedAt > maxMs) {
      reset();
      log(`重试一直没成功（试了 ${maxMs / 60_000} 分钟），不再自动重试，交给上层处理`);
      return null;
    }
    if (timer) return null;
    tries += 1;
    const delay = tries <= fastTimes ? fastMs : slowMs;
    timer = setT(() => {
      timer = null;
      try {
        run(actual);
      } catch (e) {
        log(`重试同步出错：${e?.message ?? e}`);
      }
    }, delay);
    // 定时器不该拖着进程不退出
    timer?.unref?.();
    return delay;
  }

  return { schedule, reset, get tries() { return tries; }, get pending() { return Boolean(timer); } };
}
