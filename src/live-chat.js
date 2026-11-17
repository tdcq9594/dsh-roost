// 每轮把「这一轮的 chat」刷新进「挂载时捕获的那个 chat 对象」。
//
// 为什么需要这一步：`mount(agent, chat)` 对一个 agent 只跑一次——挂载副作用
// （工具注册、usage section、权限上下文）重复跑会翻倍，所以只能挂一次。可闭包
// 捕获的是**第一轮**的 chat 对象，而群里换个人说话时 `chatOf()` 会造一个新对象
// （`senderId` 不同），会话键却一致 → 落到同一个 agent → `mount()` 直接 return，
// 于是一整串读 `chat` 的地方都停在第一轮的取值上：`persona.bySender`（按人指定
// 人格）只在第一个说话的人身上生效，`shouldRegisterQqTools` 的 kind 也不跟着变。
//
// 修法是保留首挂那个对象、每轮把新值灌进去：闭包一行都不用改，读到的就是当轮的值。
//
// 抽成纯函数不是为了好看：`mount()` 埋在 `apply()` 闭包里，假 ctx 到不了那一层，
// 这段逻辑留在闭包里就只能靠真机碰运气（见 `test/live-chat.test.js`）。

/**
 * 把 `prev` 原地变成 `next` 的**浅拷贝**——值对齐，形状也要对齐。
 *
 * 只 `Object.assign` 是不够的：它只覆盖 `next` 里**有**的键，`prev` 独有的键会
 * 一直留着上一轮的值。而 `chat` 有两种来源，形状并不一致：
 *
 *   - `chatOf()` 给全套 14 个字段（kind / scene / chatId / senderId / sessionKey /
 *     groupId / guildId / channelId / name / preset / uin / groupUin / aliases /
 *     identityId）；
 *   - 手写的字面量只给 5 个（主动搭话 / 巩固 / 自测 / 系统窗口）。
 *
 * 这两者会落到**同一个 agent** 上：主人的私聊会话 `sessionKey` 就是他的 openid，
 * 和「主动搭话」字面量写的 `chatId: owner, sessionKey: owner` 同值。于是只覆盖不删
 * 会出现这种事：真实消息先挂载（`senderId` 是主人）→ 主动搭话那一轮的字面量没有
 * `senderId` → 闭包里的 `personaCfgFor(chat)` 仍读到主人的 openid → **「按人指定
 * 的人格」被套到她自己主动开口的那一轮上**（`pickPersonaId` 里「按人」压过
 * 「按会话」和「全局」）。同理 `uin` / `groupUin` / `aliases` 会长期停在旧会话上，
 * 今天没人读，但不变量已经破了——以后谁加一个读 `chat.aliases` 的地方就是 bug。
 *
 * 所以刷新要**形状对齐**：`next` 没有的自有键，从 `prev` 删掉。删完的语义也更准：
 * 「这一轮没有真人说话」就该是 `senderId` 缺席，而不是留着上一位说话人。
 *
 * @param {object|null|undefined} prev 首挂时捕获的 chat 对象（会被**原地**修改）
 * @param {object|null|undefined} next 这一轮的 chat 对象
 * @returns {boolean} 是否刷新成功。`false` = 目标被 `Object.freeze` / `seal` 或只读
 *   属性锁住，调用方按旧值继续（与引入本函数之前的行为一致），不该当成错误抛出。
 */
export function refreshLiveChat(prev, next) {
  if (!prev || !next || prev === next) return true;
  try {
    /**
     * 先删多余键、再覆盖值。
     *
     * 顺序不能反：反过来的话，`next` 里值为 `undefined` 的键和「本来没有这个键」
     * 在结果上长得一样，`delete` 删不干净也无从判断。先删一遍等于把 `prev` 的
     * 形状收成 `next` 的子集，`Object.assign` 之后两者就是同一个形状。
     *
     * 只遍历自有可枚举键：`chat` 全是字面量，没有原型链上的东西要清。
     */
    for (const key of Object.keys(prev)) {
      if (!Object.hasOwn(next, key)) delete prev[key];
    }
    Object.assign(prev, next);
    return true;
  } catch {
    /** 冻结 / 密封对象：严格模式下 `delete` 与赋值都会抛 TypeError，退化成旧行为 */
    return false;
  }
}
