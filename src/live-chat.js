// 每轮把「这一轮的 chat」刷新进「挂载时捕获的那个 chat 对象」。
//
// 为什么需要这一步：`mount(agent, chat)` 对一个 agent 只跑一次——挂载副作用
// （工具注册、usage section、权限上下文）重复跑会翻倍，所以只能挂一次。可闭包
// 捕获的是**第一轮**的 chat 对象，而群里换个人说话时 `chatOf()` 会造一个新对象
// （`senderId` 不同），会话键却一致 → 落到同一个 agent → `mount()` 直接 return，
// 于是一整串读 `chat` 的地方都停在第一轮的取值上：`persona.bySender`（按人指定
// 人格）只在第一个说话的人身上生效，`shouldRegisterQqTools` 的 kind 也不跟着变。
//
// 修法是保留首挂那个对象、每轮把新值原地灌进去：闭包一行都不用改，读到的就是
// 当轮的值。
//
// 抽成纯函数不是为了好看：`mount()` 埋在 `apply()` 闭包里，假 ctx 到不了那一层，
// 这段逻辑留在闭包里就只能靠真机碰运气（见 `test/live-chat.test.js`）。

/**
 * @param {object|null|undefined} prev 首挂时捕获的 chat 对象（会被**原地**修改）
 * @param {object|null|undefined} next 这一轮的 chat 对象
 * @returns {boolean} 是否刷新成功。`false` = 目标被 `Object.freeze` / 只读属性
 *   锁住，调用方按旧值继续（与引入本函数之前的行为一致），不该当成错误抛出。
 */
export function refreshLiveChat(prev, next) {
  if (!prev || !next || prev === next) return true;
  /**
   * 只覆盖 `next` 有的键，**不删** `prev` 独有的键。
   *
   * `chatOf()` 每轮给的是全套字段，少键只出现在手写的 chat 字面量里（主动搭话、
   * 巩固、自测、系统窗口）。那种场景下留着旧值比抹成 `undefined` 安全：闭包里
   * `chat.uin`、`chat.groupUin`、`chat.aliases` 都按「可能没有」写好了兜底，
   * 但 `undefined` 会让 `aliasesOf(chat.chatId)` 那一层连带少读别名，旧值更贴近事实。
   *
   * 反过来说，这里**不会**把「上一轮的会话名」留给这一轮吗？会，但只在调用方
   * 传的是一个缺 `name` 的字面量时；而 `name` 决定的是会话标题，下一轮真消息
   * 立刻覆盖回来。
   */
  try {
    Object.assign(prev, next);
    return true;
  } catch {
    /** 冻结对象：`Object.assign` 在严格模式下抛 TypeError，这里退化成旧行为 */
    return false;
  }
}
