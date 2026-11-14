/**
 * 最近几条语音的官方转写 —— 给面板「听语音」卡看的排障读数。
 *
 * 官方 Bot API 已经把语音转成 `asrText` 直接给了，面板以前看不到，
 * 用户只能猜「她到底听没听清」。这里只做一件事：把刚才转成了什么记下来。
 *
 * 三条硬边界（和「纯净模式 / 不落盘」的口径一致）：
 *  1. **只在内存里留一圈**（最多 20 条），不写文件、不进记忆库、不进日记；
 *  2. 转写正文**截断到 120 字**，只够判断「转对没有」，不做内容留存；
 *  3. 没转出文字的也要记一条（`ok:false`），否则「她没听清」这种情况查不到。
 *
 * 这个模块是纯函数 + 闭包，不依赖 fs / 网络 / 配置，方便单测。
 */

const MAX_ROWS = 20;
const MAX_CHARS = 120;

export function createAsrRecent({ maxRows = MAX_ROWS, maxChars = MAX_CHARS, now = () => Date.now() } = {}) {
  const rows = [];

  return {
    /**
     * 只认 voice 附件；一条消息里有多段语音就各记一条。
     *
     * **这条挂在入站热路径上**：payload 可能来自框架事件对象 / 扩展 /v1 投递，
     * 带 getter、Proxy、自定义 toString 都可能抛。所以每个字段读取都单独兜住，
     * 单个畸形附件只跳过自己，既不影响其它附件，更不能把整条消息链路带崩。
     */
    note(payload) {
      let list = [];
      try { list = Array.isArray(payload?.attachments) ? payload.attachments : []; }
      catch { return; }
      let chatId = '';
      try { chatId = String(payload?.chat?.chatId ?? '').slice(-10); } catch {}
      try {
        for (const a of list) {
          try {
            if (!a || a.type !== 'voice') continue;
            const text = String(a.asrText ?? '').trim();
            rows.push({
              at: now(),
              /** 只留后缀：面板不需要完整 openid，也避免把会话 key 铺到界面上 */
              chatId,
              text: text.slice(0, maxChars),
              chars: text.length,
              ok: Boolean(text),
            });
            if (rows.length > maxRows) rows.shift();
          } catch {
            /** 读数失败就跳过这一条，绝不让排障用的读数影响回话 */
          }
        }
      } catch {
        /** Proxy 数组的迭代器本身也可能抛：连 for...of 一起兜住 */
      }
    },
    /**
     * 新的在前；**每条都要复制**：`slice().reverse()` 只复制了数组，
     * 里面的对象还是同一份，调用方改一行就把内部读数也改了。
     */
    list() {
      return rows.slice().reverse().map((r) => ({ ...r }));
    },
  };
}
