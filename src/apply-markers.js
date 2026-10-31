/**
 * 动作标记的执行
 * ==============
 *
 * 从 `host.js` 里拆出来的第一个域（阶段 8）。原来它是个 160 行的内联函数，
 * 直接闭包引用 memory / journal / self / closing / mood —— 想测它就得把
 * 整个 host 拉起来，于是**一直没人测**。
 *
 * 现在依赖从参数进来，测试里给几个假对象就能验证「标记真的产生了副作用」：
 * 记了没有、忘干净没有、人设改没改、约定收没收。
 *
 * 语法层（怎么匹配、怎么摘干净）在 `markers.js`，这里只负责**执行**。
 */
import { markerRe, stripUnknown, stripUnclosed, parseReplace } from './markers.js';
import { parseMoodMark } from './mood.js';
import { parseClose, acceptClose } from './closing.js';
import { W_EXPLICIT } from './memory.js';

/**
 * @param {{memory:object, journal:object, self:object, closing:object, mood:object, log?:object}} deps
 *   `log` 是 logger **对象**（`log.debug` / `log.warn`），不是函数——和 host 里一致。
 */
export function createMarkerApplier({ memory, journal, self, closing, mood, log = () => {} }) {
  return function applyMemoryMarkers(text, chatId, said = '', kind = 'group', src = null) {
    let out = String(text ?? '');
    let touched = '';

    out = out.replace(markerRe('remember-here'), (_, v) => {
      const f = String(v || '').trim();
      if (f) {
        /**
         * 明确要求记的给更高权重（`W_EXPLICIT`）。
         *
         * 淘汰是按「权重 × 时间衰减」算的，全给 1 就等于退回 FIFO：
         * 「记住我花生过敏」会因为今天记了 40 条杂事被挤掉。
         */
        memory.add(chatId, f, 'chat', { w: W_EXPLICIT, src });
        touched = '记住了（只这个群）';
      }
      return '';
    });

    out = out.replace(markerRe('remember'), (_, v) => {
      const f = String(v || '').trim();
      if (f) {
        memory.add(chatId, f, 'global', { w: W_EXPLICIT, src });
        touched = '记住了';
      }
      return '';
    });

    /**
     * `<<replace: 旧说法 | 新说法>>`：语义改口。
     *
     * 为什么需要它：同槽位取代（`addInto` 里那个 0.75 相似度）只抓
     * 「同一句改了个尾巴」，抓不到「住在杭州」→「搬到上海」。
     * 这条路上模型能帮上忙——它知道自己在纠正哪句。
     *
     * 定位失败**不猜**：命中 0 条就只记新的（旧的可能本来就没记过）；
     * 命中多条也记新的，但日志里留一条，方便事后查"为什么没替换掉"。
     */
    out = out.replace(markerRe('replace'), (_, v) => {
      const parsed = parseReplace(v);
      if (!parsed) {
        touched = 'replace 要写成「旧说法 | 新说法」';
        return '';
      }
      const { old: oldNeedle, next } = parsed;
      const r = memory.supersede(chatId, oldNeedle);
      if (!r.ok) log.debug(`replace 没定位到「${oldNeedle}」：${r.why}`);
      memory.add(chatId, next, 'global', { w: W_EXPLICIT, src });
      touched = r.ok ? '旧说法换成了新的' : `没找到「${oldNeedle}」，只记了新的`;
      return '';
    });

    out = out.replace(markerRe('persona'), (_, v) => {
      const t = String(v || '').trim();
      if (t) {
        memory.setPersonaOverride(chatId, t);
        touched = '人设改了（只这个群）';
      }
      return '';
    });

    out = out.replace(/<<clear>>/gi, () => {
      memory.clearChat(chatId);
      memory.setPersonaOverride(chatId, '');
      /**
       * **日记也要清。**
       *
       * 只清 facts 的话会出现："她说清了这个群的记忆，可我一问上周的事她又答上来了"——
       * 因为日记里原文还在，检索照样命中。用户要的"清掉"是清干净。
       * `journal.clearChat` 抹正文但不删行：时间线仍连续（哪天真有纠纷能看出
       * "这天有过东西，是被人清掉的"），内容本身已经没了。
       */
      try {
        journal.clearChat(chatId);
      } catch (e) {
        log.warn(`清日记失败：${e.message}`);
      }
      touched = '清了这个群的记忆和人设';
      return '';
    });

    out = out.replace(markerRe('mood'), (_, v) => {
      /**
       * 解析交给 `parseMoodMark`，别在这里自己按逗号切。
       *
       * 按逗号切的后果：`reason=被凶了，有点难受` 被切成两段，
       * 第二段没有 key 而 reason 已经有值 → 直接丢掉，原因只剩「被凶了」。
       */
      const kv = parseMoodMark(v);
      if (Object.keys(kv).length) {
        mood.set({
          valence: kv.valence,
          energy: kv.energy,
          sociability: kv.sociability,
          reason: kv.reason,
        });
        touched = '情绪变了';
      }
      return '';
    });

    out = out.replace(markerRe('forget'), (_, v) => {
      const word = String(v || '').trim();
      /**
       * **三边都要忘。**
       *
       * 只删 facts 不删日记，会出现"她嘴上说不记得了，一检索又想起来"——
       * 用户说"别记这个"要的是真的不存在，所以日记里那几条正文也抹掉
       * （`journal.forget` 是抹正文不删行，时间线还连着）。
       *
       * 第五层的自述也要扫：她可能写过「今天聊到 X，我记错了」，
       * 用户要求忘掉 X 之后那句自述还留着，等于换个说法继续记着。
       */
      const n = memory.remove(chatId, word);
      let j = 0;
      try {
        j = journal.forget({ chatId, word });
      } catch (e) {
        log.warn(`日记遗忘失败：${e.message}`);
      }
      let s = 0;
      try {
        s = self.forget(word);
      } catch (e) {
        log.warn(`自述遗忘失败：${e.message}`);
      }
      if (n || j || s) touched = `忘掉了 ${n + j + s} 条`;
      return '';
    });

    /**
     * 对话收尾（`<<close: 收在哪 | 下次怎么接>>`）。
     *
     * **不发消息、不动记忆**，只把"这段聊到哪结束"记下来，给两处用：
     *   · 下一轮进来的提示词（`roost-closing`）——接得上，不用重新自我介绍
     *   · 主动搭话的刹车（`awake.js`）——刚说完晚安不该十分钟后又冒出来
     *
     * 三条拒绝，任何一条命中都不收尾（**标记照样摘掉**，不能漏给用户看）：
     *   1. 群聊——群里没有"聊完"这回事，一直有人说话
     *   2. 没写"收在哪"——空收尾对下一轮毫无价值
     *   3. 对方这一轮还在提问——问题没答完就退场，是最让人恼火的一种
     *
     * 注意**不要求**收尾必须带正文：`qq_close_conversation` 本来就是
     * "不说话地退场"，说完晚安、下一轮只留一个 close 标记是正确的用法。
     */
    out = out.replace(markerRe('close'), (_, v) => {
      const { point, resume } = parseClose(v);
      const gate = acceptClose({ point, kind, said });
      if (!gate.ok) {
        /**
         * 「对方还在提问」用 info：它意味着她问题没答完就想跑，
         * 是唯一值得事后翻日志的一种；另外两条（群聊 / 空收尾）是常态。
         */
        if (gate.why.includes('提问')) log.info(`收尾被忽略：${gate.why}`);
        else log.debug(`收尾被忽略：${gate.why}`);
        return '';
      }
      const r = closing.set(chatId, { point, resume, kind });
      if (r.ok) touched = `收尾：${point}`;
      else log.debug(`收尾没记上：${r.why}`);
      return '';
    });

    /**
     * 兜底：任何剩下的 `<<名字>>` / `<<名字: 值>>` 都当标记摘掉。
     *
     * 标记协议是**两个仓库各自实现**的（这里是这套正则，ai-chat 的 `parseActions`
     * 是另一套）。哪一边加了新标记、另一边没跟上，标记就会原样进群——
     * `mood` 已经这么漏过一次（写进 `qq_send` 参数里，工具通道直接 `postReply`）。
     * 只匹配「字母开头 + 可选冒号值」的形状，不会误伤正文里的尖括号。
     *
     * **负向前瞻 `(?!image|voice|button|say|silence)\b` 是本次修复的关键**：
     * 这几个是**下游 ai-chat** 的 `parseActions` 负责执行的标记（发图 / 发语音 /
     * 按钮 / 语音条 / 静默），宿主这边不认识、也不该碰，必须原样保留让它们
     * 随文本传到 ai-chat 去执行。
     *
     * 真实事故：模型把 `<<image: 路径>>` 写进 `qq_send` 的 text 参数，
     * 这里没保护 → 被兜底当成「未知标记」静默删掉 → ai-chat 拿到的
     * 是纯文本、解析不出 image 动作 → 图根本没发出去，模型却以为「发你了」。
     */
    out = stripUnknown(out);

    /**
     * 最后再清一遍**未闭合**的标记。
     *
     * 顺序必须在所有正常替换之后：截断的标记没有闭合位置，
     * 提前清会把它后面的正常文本一起吃掉。
     */
    out = stripUnclosed(out);

    return { text: out.trim(), touched };
  };
}
