/**
 * 插件生命周期内的定时器登记表。
 *
 * ## 为什么要有它
 *
 * `teardown` 一直是**手写 clear 清单**：加一个定时器就得记得回来看一眼补一行。
 * 2026-11 就漏了备份 / 发帖 / 投递回查三个，而 `unref()` 只保证「不阻进程退出」，
 * **不保证重载后不重复**——插件重载会再 `apply()` 一次，旧实例的定时器还在跑，
 * 表现是同一时刻备份两遍、同一条帖发两次、同一条投递查两次。
 *
 * 改成注册式之后，`teardown` 里只剩一句 `clearAll()`，新增定时器不可能漏。
 *
 * ## 不接管的两类
 *
 * - `ctx.effect(() => { const t = setInterval(...); return () => clearInterval(t) })`
 *   里的定时器：宿主已经负责清理，再登记一份会让两套生命周期打架。
 * - **任务级**定时器（如表情补标签）：跟着单个任务结束，比插件生命周期短，
 *   自己清比集中清更准。
 *
 * ## 关闭之后的行为
 *
 * `clearAll()` 之后实例永久关闭：再登记会被立刻清掉并 warn。这不是洁癖——
 * teardown 与「某个异步回调恰好在此刻决定排个定时器」是会撞车的，撞上就该
 * 拒掉，而不是让它在卸载后偷偷跑起来。
 */

/** 定时器回调里抛错不该带崩进程；日志走调用方传进来的 logger */
function messageOf(e) {
  return String(e?.message ?? e).slice(0, 200);
}

/**
 * @param {object} [opts]
 * @param {{ warn?: (m: string) => void }} [opts.log]
 */
export function createTimers({ log } = {}) {
  /** @type {Set<{ handle: any, kind: 'i'|'t', label: string }>} */
  const live = new Set();
  let closed = false;

  const warn = (m) => {
    try {
      log?.warn?.(m);
    } catch {}
  };

  function drop(handle) {
    for (const e of live) {
      if (e.handle === handle) {
        live.delete(e);
        return;
      }
    }
  }

  function kill(entry) {
    try {
      if (entry.kind === 'i') clearInterval(entry.handle);
      else clearTimeout(entry.handle);
    } catch {}
  }

  /**
   * 跑一次回调。
   *
   * 同步抛错以前是**未捕获异常**——`setInterval` 的回调里抛出去没人接，直接把
   * 进程带走。这里接住并 warn：定时任务失败不该等于机器人下线。
   * 返回 Promise 的，顺手挂一个 catch（调用方自己已 `.catch` 的不会被重复处理）。
   */
  function fire(fn, label) {
    let out;
    try {
      out = fn();
    } catch (e) {
      warn(`${label}异常：${messageOf(e)}`);
      return;
    }
    if (out && typeof out.then === 'function' && typeof out.catch === 'function') {
      out.catch((e) => warn(`${label}失败：${messageOf(e)}`));
    }
  }

  function register(handle, kind, label) {
    if (closed) {
      kill({ handle, kind });
      warn(`${label}在 teardown 之后才登记，已丢弃`);
      return null;
    }
    live.add({ handle, kind, label });
    return handle;
  }

  /**
   * 周期任务。
   * @param {() => any} fn
   * @param {number} ms
   * @param {string} label 出错时进日志的名字
   */
  function every(fn, ms, label = '定时任务') {
    const handle = setInterval(() => fire(fn, label), ms);
    handle.unref?.();
    return register(handle, 'i', label);
  }

  /**
   * 一次性延时任务（启动补跑那一类）。
   * @param {() => any} fn
   * @param {number} ms
   * @param {string} label
   */
  function after(fn, ms, label = '延时任务') {
    const handle = setTimeout(() => {
      /** 先摘掉再跑：`size()` 要能反映「还挂着几个」 */
      drop(handle);
      fire(fn, label);
    }, ms);
    handle.unref?.();
    return register(handle, 't', label);
  }

  /** 清空并永久关闭。重复调用安全。 */
  function clearAll() {
    closed = true;
    for (const entry of live) kill(entry);
    live.clear();
  }

  /** 当前还挂着的定时器数量（测试与自检用） */
  function size() {
    return live.size;
  }

  return { every, after, clearAll, size };
}
