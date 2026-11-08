/**
 * 对外联动（实验，默认关）
 * ======================
 *
 * 让**别的 DSH 插件**通过 `ctx.get('aurabot')` 拿到她：主动发一条、读只读状态。
 * 报告 §13.3-6 的 `[A]/src/core/bridge.js` 是这条线的原型；我们只做最小面：
 *
 *   · **只给主动发送 + 只读状态**，不给记忆写接口（写记忆的风险太大）；
 *   · 发送一律走 `sendOut`，主动额度、审核识别、投递账本照旧生效；
 *   · **默认关**（`config.bridge.enabled`），面板上标注「实验」。
 *
 * 刻意不做：外部程序 Bearer HTTP 接口（`/api/open/*`）——那是新攻击面，
 * 要单独做密钥、白名单、总开关，等这层稳定了再说。
 *
 * 抽成工厂是为了能单测「转发有没有走 sendOut、状态读失败会不会崩」。
 */

/**
 * @param {{sendOut:Function, statusOf?:Function, log?:Function}} deps
 */
export function createBridge({ sendOut, statusOf, log = () => {} } = {}) {
  if (typeof sendOut !== 'function') throw new Error('bridge 需要 sendOut');
  return {
    /** 接口版本：以后加方法只加不改，消费方按它判能力 */
    api: 1,
    /**
     * 主动发一条。返回精简结果——调用方不需要知道通道内部字段。
     * @param {{scene?:string, target:string, text:string}} payload
     */
    async send(payload) {
      const r = await sendOut(payload);
      return {
        ok: Boolean(r?.ok),
        pending: Boolean(r?.pending),
        requestId: String(r?.requestId || ''),
      };
    },
    /** 只读状态。读失败返回空对象，不抛给别的插件 */
    status() {
      try {
        return statusOf?.() ?? {};
      } catch (e) {
        log(`bridge.status 读失败：${e?.message ?? e}`);
        return {};
      }
    },
  };
}
