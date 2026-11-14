/**
 * 扩展页面「动作按钮」的投递队列。
 * ============================================================
 *
 * 背景：扩展页面的按钮不能直接把代码塞进面板（那就是 6.1 挡掉的东西），
 * 也不能由宿主替它执行——宿主不认识扩展的业务。所以做成「按钮 → 排队 →
 * 扩展自己来取」：
 *
 *   面板点按钮 → 宿主校验「这个 action 在清单里声明过」→ 入队
 *   扩展轮询 `GET /v1/ext-ui/actions` → 取走并执行 → 下次刷新页面看到结果
 *
 * 为什么是内存队列而不是写文件：
 *   · 动作是「此刻的意图」，宿主重启后补发昨天的「现在刷一轮」没有意义；
 *   · 不落盘就不会有清理问题，也不会污染扩展目录（索引 sha256 按整目录算）。
 *
 * 边界：
 *   · 按 `extId` 隔离，扩展只能取自己的（`extId` 来自令牌，不信请求体）；
 *   · 有 TTL（默认 2 分钟），过期的动作取不出来，避免扩展离线一小时后
 *     一上线把攒着的十几个「刷一轮」全跑一遍；
 *   · 有容量上限，防止某个扩展被反复点击把内存撑大。
 */

import { randomUUID } from 'node:crypto';

export const ACTION_TTL_MS = 120_000;
export const MAX_ACTIONS = 32;
export const MAX_PER_EXT = 8;

export function createUiActionQueue({
  now = () => Date.now(),
  ttlMs = ACTION_TTL_MS,
  max = MAX_ACTIONS,
  maxPerExt = MAX_PER_EXT,
  log = () => {},
} = {}) {
  /** extId -> [{ action, nonce, at }] */
  const store = new Map();

  const alive = (it, t) => it && t - it.at <= ttlMs;
  const prune = (t) => {
    let removed = 0;
    for (const [extId, list] of store) {
      const next = list.filter((it) => alive(it, t));
      removed += list.length - next.length;
      if (next.length) store.set(extId, next);
      else store.delete(extId);
    }
    return removed;
  };
  const total = () => {
    let n = 0;
    for (const list of store.values()) n += list.length;
    return n;
  };

  /**
   * 入队。`action` 必须是清单里声明过的 id（校验在路由层做，这里只做形状校验，
   * 因为队列不该知道某个扩展声明了什么）。
   */
  function push(extId, action) {
    const key = String(extId ?? '').trim();
    const act = String(action ?? '').trim();
    if (!key || !act) return { ok: false, reason: 'bad_request', message: '缺扩展 id 或动作名' };
    const t = now();
    prune(t);
    if (total() >= max) {
      return { ok: false, reason: 'busy', message: '动作队列满了，等扩展取走再点' };
    }
    const list = store.get(key) || [];
    if (list.length >= maxPerExt) {
      return { ok: false, reason: 'busy', message: '这个扩展还有没处理完的点击，稍等几秒' };
    }
    /** 同一个动作连点只留一条：用户手抖点三下不该刷三轮 */
    if (list.some((it) => it.action === act)) {
      return { ok: true, deduped: true, pending: list.length, message: '这个动作已经在排队了' };
    }
    const item = { action: act, nonce: randomUUID(), at: t };
    store.set(key, [...list, item]);
    log(`扩展 ${key} 的动作已排队：${act}`);
    return { ok: true, nonce: item.nonce, pending: list.length + 1, message: '已交给扩展，几秒后刷新看结果' };
  }

  /** 读即消费：扩展取走后队列清空，避免它每轮都重复执行同一个点击。 */
  function take(extId) {
    const key = String(extId ?? '').trim();
    if (!key) return { ok: false, reason: 'bad_request', message: '缺扩展 id' };
    const t = now();
    const list = store.get(key) || [];
    const actions = list.filter((it) => alive(it, t));
    store.delete(key);
    return {
      ok: true,
      actions: actions.map((it) => ({ action: it.action, nonce: it.nonce, at: it.at })),
      dropped: list.length - actions.length,
    };
  }

  /** 只读快照，面板显示「有几个待处理」用；不消费。 */
  function peek(extId) {
    const key = String(extId ?? '').trim();
    const t = now();
    const list = (store.get(key) || []).filter((it) => alive(it, t));
    return { ok: true, pending: list.length, actions: list.map((it) => it.action) };
  }

  function clear(extId) {
    const key = String(extId ?? '').trim();
    const had = store.get(key)?.length ?? 0;
    store.delete(key);
    return { ok: true, cleared: had };
  }

  return { push, take, peek, clear, prune, total, sizeOf: (extId) => (store.get(String(extId ?? '').trim()) || []).length };
}
