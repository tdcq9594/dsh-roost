/**
 * 出站清洗：把「模型顺手抄进来的东西」从要发出去的话里剥掉。
 *
 * 为什么需要这一层：模型在 DSH 里看得到一大堆**由宿主注入**的内容
 * （消息头 `[昵称 (openid)]`、场景块、`# 输出协议`、系统提醒），
 * 它写正文时偶尔会顺着往下续写，把那些东西一起带进 `qq_send` 的 text。
 * 一旦发出去，群里看到的就是「【系统提醒，不是主人说的话】…」这种。
 *
 * 对照的是 aurabot beta 的两个修复（2026-11-17 核验后确认我们也没有）：
 *   · `fix/thinking-leak`：`src/chat/reply.js` 的 `thinkingTextRanges()`
 *   · `fix(#395)`：`src/security/leak-guard.js` 的 `cleanOutboundText()`
 *
 * 设计原则：**宁可漏删，不可误删**。
 *   · 只删「有明确标记」的思考段（【思考】…【/思考】、（思考：…）、
 *     「思考过程：」单独成行），不猜「哪些句子像思考」；
 *   · 注入块只从**行首**或**明确标记**处截断，不从正文中间剪；
 *   · 清洗后如果什么都不剩，返回空串，由调用方决定是否拒发。
 */

/** 显式包裹的思考块：【思考】…【/思考】、[analysis]…[/analysis] 这类 */
const THINK_BLOCK_RE = /(?:【|\[)\s*(?:思考|分析|推理|内心|思路|thinking|analysis|reasoning)\s*(?:】|\])[\s\S]*?(?:【|\[)\s*\/\s*(?:思考|分析|推理|内心|思路|thinking|analysis|reasoning)\s*(?:】|\])/gi;

/** 括号里的内心段：（思考：…）/（分析：…），限制长度避免吃掉整段正文 */
const THINK_PAREN_RE = /[（(]\s*(?:思考|分析|推理|内心活动)\s*[：:][\s\S]{0,1200}?[）)]/g;

/**
 * 单独成行的「思考过程：…」。
 *
 * 只在**同一行里出现元信息词**（用户/对方/需要/回复/意图…）时才删——
 * 否则会把正常回答里的「分析：这个方案有两个问题」误删。
 */
const THINK_LINE_RE = /(^|\n)([ \t]{0,4}(?:\*\*)?(?:思考过程|分析过程|推理过程|思考|分析|推理|内心活动|内心|思路|回复策略|回答策略|意图分析|用户意图)\s*[：:][^\n]*)(?=\n|$)/g;
const META_HINT_RE = /(?:用户|对方|她|他|我|需要|先|然后|回复|回答|意图|情绪|场景|判断|想)/;

/**
 * 「最终回答：」之前全是推理 —— 只在前面确实有元信息时才截。
 */
const FINAL_LINE_RE = /(?:^|\n)[ \t]*(?:最终回答|最终回复|最终答复|回复用户|答复)\s*[：:][ \t]*/;
const FINAL_PREFIX_RE = /(?:用户|对方|提问者|需要|让我|首先|接下来|分析|判断|回复|回答)/;

/**
 * 注入块标记：命中就从**这里**截到结尾。
 *
 * 这些都是宿主自己塞进上下文的，模型续写时会连它们一起抄下来。
 * `# 场景` / `# 输出协议` 只在**行首**才算（正文里出现的 # 不算）。
 */
/**
 * 消息头回显：`[小明 (AbC123…)]`。
 *
 * 这是**我们自己**的注入格式（每条消息前面那串），openid 是二十多位的随机串。
 * 模型顺着续写时会把整行抄进去，发到群里的就是「[小明 (AbC…)] 你好」——
 * 既是噪音，也是把一个不该公开的标识符甩出去。
 *
 * 只认「方括号 + 圆括号 + 8~64 位 base64url」，和 `AT_ID_RE` 同一个口径；
 * 正常聊天里几乎不会出现这个形状。
 */
const SPEAKER_TAG_RE = /\[[^\]\n]{1,40}\s*\(\s*[A-Za-z0-9_-]{8,64}\s*\)\]/g;

const INJECT_HEADS = [
  /【系统提醒[^】\n]*】/,
  /【你在自己家里[^】\n]*】/,
  /(?:^|\n)[ \t]*#\s*(?:场景|输出协议|输出（当轮）|输出\(当轮\))/,
];

/**
 * 清洗一段要发出去的话。
 *
 * @param {string} raw 模型给的正文
 * @returns {string} 清洗后的文本（可能为空串）
 */
export function cleanOutbound(raw) {
  let t = String(raw ?? '');
  if (!t) return '';

  // 1) 注入块：从这里截断。先做这一步，后面的清理才有意义——
  //    否则「# 输出协议」后面的整段规则会被当成正文保留下来。
  for (const re of INJECT_HEADS) {
    const m = re.exec(t);
    if (m && m.index !== undefined) {
      // 行首标记的 index 含前导换行，别把换行一起留成空行
      const cut = m[0].startsWith('\n') ? m.index + 1 : m.index;
      if (cut > 0) {
        t = t.slice(0, cut);
        break;
      }
      // 出现在最开头 = 整段都是注入内容
      return '';
    }
  }

  // 2) 消息头回显（带 openid 的那种）
  t = t.replace(SPEAKER_TAG_RE, '').replace(/^[ \t]+/gm, '');

  // 3) 显式思考块
  t = t.replace(THINK_BLOCK_RE, '');
  t = t.replace(THINK_PAREN_RE, '');

  // 3) 单独成行的「思考过程：…」
  t = t.replace(THINK_LINE_RE, (full, lead, line) => (META_HINT_RE.test(line) ? lead : full));

  // 4) 「最终回答：」前缀 —— 只保留它后面
  const final = FINAL_LINE_RE.exec(t);
  if (final) {
    const prefix = t.slice(0, final.index);
    /** 在开头（prefix 为空）是模型明显写错了标记；前面是推理时就整段截掉 */
    if (final.index === 0 || FINAL_PREFIX_RE.test(prefix)) {
      t = t.slice(final.index + final[0].length);
    }
  }

  // 5) 收尾：去掉因删除产生的连续空行与首尾空白
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
