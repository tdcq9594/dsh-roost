/**
 * 回调型按钮通道（`<<pick: 标签|值>>`）
 * =====================================
 *
 * 现有 `<<button: 标签|指令>>` 是 `action.type: 2` **指令型**：点击后 data
 * 当作一条用户消息发出，走 message → 命令系统，**不产生 INTERACTION**。
 * 它没有「点一个其余变灰」这回事，也没办法知道是谁点的。
 *
 * 这里补第二种按钮：`action.type: 1` **回调型**，靠 QQ 原生
 * `group_id` + `click_limit: 1` 实现互斥变灰，点击产生 INTERACTION_CREATE，
 * 经 E1（WS 回执）→ E2（notice 放行）→ 本模块按 nonce 结算。
 *
 * ## 刻意不做的两件事
 *
 * 1. **不改 `ext-tier` / `ext-proactive`**。方案初稿写「用 nonce 绑到已有的
 *    那条 pending 记录上」，但实核发现：`ext-proactive` 的 `approve()` 是按
 *    **序号**批量批准 `awaiting` 列表、`ext-tier` 的 confirm 是安装时勾选，
 *    两处都没有 nonce 字段、也没有运行时的单条 pending 表。硬编一个绑定
 *    等于要改它们的状态机 —— 那是「减少/改变现有功能」，不是加法。
 *
 *    所以这里做成**通用通道 + 注册点**：`arm()` 登记一组选项并给 nonce，
 *    `handle()` 校验后调 `onPick`。将来要把审批接到 QQ 按钮，只需注入
 *    `onPick` 去调 `proactiveQueue.approve()`（nonce 可直接用 `item.id`），
 *    状态机一行不用动，面板与 QQ 仍是同一个批准动作，不会各批一半。
 *
 * 2. **不自维护「谁选了哪个」的状态**。互斥变灰是平台侧能力，点过就是点过；
 *    本模块只留「还没结算的那一组按钮」，结算完立刻删。这样旧卡片、重复
 *    事件、错会话点击都自然失效，不需要额外的一致性维护。
 *
 * ## 身份（fail-closed）
 *
 * `arm()` 可传 `allowed`（openid 数组）。传了就只有这些人点了才算，
 * 其余静默忽略（群里不回「你没权限」，沿用现有约定）；没传则与现有
 * 指令按钮 `permission.type: 2` 的口径一致，不额外收紧。
 */

import { randomBytes } from 'node:crypto';
import { decodeButtonData } from './roost-interaction.js';

/** 一组按钮等答复的默认时长；超时由本通道自己结算，不依赖调用方 */
export const DEFAULT_PICK_TTL_MS = 5 * 60 * 1000;
/** 最多同时挂多少组，防扩展刷屏把内存吃满 */
const MAX_PENDING = 32;

export function createPickChannel({
  log = () => {}, debug = () => {}, now = () => Date.now(),
  ttlMs = DEFAULT_PICK_TTL_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) {
  /** nonce → { values, chatId, scene, allowed, onPick, timer, expiresAt } */
  const pending = new Map();

  const mint = () => randomBytes(6).toString('hex');

  function drop(nonce) {
    const e = pending.get(nonce);
    if (!e) return null;
    if (e.timer) clearTimeoutFn(e.timer);
    pending.delete(nonce);
    return e;
  }

  /**
   * 登记一组回调按钮。
   *
   * @param {object} o
   * @param {string[]} o.values   每个选项回传的值（与 `<<pick:>>` 的「值」一一对应）
   * @param {string}  [o.chatId]  绑定会话，空串表示不校验
   * @param {string}  [o.scene]   'c2c' | 'group'
   * @param {string[]}[o.allowed] 允许点击的 openid；传了才校验
   * @param {(r:object)=>void} [o.onPick] 结算回调，收到 `{value, nonce, operatorId, chatId, scene, at}`
   * @param {number}  [o.timeoutMs]
   * @returns {{nonce:string, expiresAt:number, promise:Promise<object|null>}}
   */
  function arm({
    values = [], chatId = '', scene = 'c2c', allowed = [], onPick = null, timeoutMs = ttlMs,
  } = {}) {
    const nonce = mint();
    const life = Math.max(0, Number(timeoutMs) || 0);
    const expiresAt = now() + life;
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });

    const finish = (result) => {
      const e = drop(nonce);
      if (!e) return false; // 已经结算过（重复点击 / 旧卡片）
      if (result) {
        if (typeof e.onPick === 'function') {
          try { e.onPick(result); } catch (err) { log(`回调按钮 onPick 失败（已吞）：${err?.message ?? err}`); }
        }
        settle(result);
      } else {
        settle(null);
      }
      return true;
    };

    const entry = {
      values: values.map(String), chatId: String(chatId || ''), scene: String(scene || 'c2c'),
      allowed: Array.isArray(allowed) ? allowed.map(String).filter(Boolean) : [],
      onPick: typeof onPick === 'function' ? onPick : null,
      expiresAt, settle, finish, timer: null,
    };
    pending.set(nonce, entry);

    /** 超上限先淘汰最旧的，别让恶意/异常扩展无限堆 */
    while (pending.size > MAX_PENDING) {
      const oldest = pending.keys().next().value;
      const e = drop(oldest);
      if (e) e.settle(null);
    }

    if (life > 0) {
      entry.timer = setTimeoutFn(() => {
        debug(`回调按钮超时未作答：nonce=${nonce}`);
        finish(null);
      }, life);
      /** 定时器不该吊住进程 */
      if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    }

    return { nonce, expiresAt, promise };
  }

  /**
   * 处理一条已解析的 INTERACTION_CREATE。
   *
   * @returns {boolean} 是否命中并结算（false = 交给别的通道 / 静默忽略）
   */
  function handle(parsed) {
    const btn = decodeButtonData(parsed?.buttonData);
    if (!btn || btn.t !== 'pick') return false;

    const e = pending.get(btn.n);
    if (!e) {
      debug(`回调按钮 nonce 不匹配（旧卡片/已结算/错通道）：${btn.n}`);
      return false;
    }
    /** 值必须在登记时的选项里，防止伪造 data 注入任意指令 */
    if (!e.values.includes(btn.v)) {
      debug(`回调按钮值不在选项里：${btn.v}`);
      return false;
    }
    /** 绑定了会话就必须对得上，别让 A 群的卡片批准 B 群的事 */
    if (e.chatId && parsed.chatId && e.chatId !== String(parsed.chatId)) {
      debug(`回调按钮会话不匹配：${parsed.chatId} != ${e.chatId}`);
      return false;
    }
    /** 白名单模式 fail-closed：拿不到点击者身份也拒 */
    const operatorId = String(parsed?.operatorId ?? '').trim();
    if (e.allowed.length && (!operatorId || !e.allowed.includes(operatorId))) {
      log(`回调按钮点击者不在授权名单里（已忽略）：${operatorId || '身份未知'}`);
      return false;
    }

    return e.finish({
      value: btn.v, nonce: btn.n, operatorId,
      chatId: String(parsed?.chatId ?? e.chatId), scene: e.scene, at: now(),
    });
  }

  /** 主动取消（会话回收 / 扩展卸载时用） */
  function cancel(nonce) {
    const e = drop(nonce);
    if (e) e.settle(null);
    return Boolean(e);
  }

  /** 按会话清掉挂起的一组，返回清掉几条 */
  function cancelChat(chatId) {
    const key = String(chatId || '');
    if (!key) return 0;
    let n = 0;
    for (const [nonce, e] of pending) {
      if (e.chatId === key) { drop(nonce); e.settle(null); n += 1; }
    }
    return n;
  }

  function clear() {
    for (const [nonce, e] of pending) { drop(nonce); e.settle(null); }
  }

  return {
    arm, handle, cancel, cancelChat, clear,
    get size() { return pending.size; },
    /** 只读快照，面板/测试用 */
    list() {
      return [...pending.entries()].map(([nonce, e]) => ({
        nonce, values: [...e.values], chatId: e.chatId, scene: e.scene,
        allowed: [...e.allowed], expiresAt: e.expiresAt,
      }));
    },
  };
}
