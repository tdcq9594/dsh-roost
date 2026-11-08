/**
 * 心情的「零成本观察」与行为提示（调研报告 B1 / B2）。
 *
 * 为什么单独一层：`mood.js` 管状态与衰减，这里全是纯函数——关键词表和
 * 提示语可以随便改、随便测，不用搭一个带文件 IO 的 mood 实例。
 *
 * 和 aurabot 的差别：它用固定词表把三轴按整数推，我们只在**明确被夸/被凶**
 * 时给一点 valence 增量，其余交给模型自己的 `<<mood:>>` 标记（本来就接好了）。
 * 理由是我们的人格独占系统提示词、AI 自决接话，规则替她判定情绪越界太多
 * 反而像在演。词表只补「模型没意识到该改心情」的那一小块。
 */

const PRAISE = /(谢谢|感谢|好棒|太棒了|厉害|喜欢你|好可爱|可爱|辛苦了|真棒|么么哒|爱你|好评|牛|绝了|👍|❤)/i;
const SCOLD = /(笨|傻|闭嘴|滚|烦死|讨厌你|垃圾|别吵|差评|拉黑|无语|👎|生气)/i;

/** 主人说的话权重大一些：被主人夸一句，比群里十句闲聊都管用 */
const OWNER_GAIN = 1.5;

/**
 * 看一句话要不要轻轻推一下心情。
 *
 * @returns {{valence:number, reason:string}|null} null = 这句不值得动心情
 */
export function observe(text, { owner = false } = {}) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 120) return null;
  const gain = owner ? OWNER_GAIN : 1;
  if (SCOLD.test(s)) return { valence: -0.08 * gain, reason: '被凶了一句' };
  if (PRAISE.test(s)) return { valence: 0.06 * gain, reason: '被夸了一句' };
  return null;
}

/**
 * B2：心情影响发送习惯的**提示**，不是硬概率。
 *
 * aurabot 把心情做成四个乘子直接改「表情/语音概率、回复延迟、插话积极性」，
 * 但我们的表情与语音是模型在回复里写 `<<image:>>` / `<<say:>>` 标记、
 * 由 ai-chat 抽成动作。在出站链上按概率**删标记**会变成「她以为发过图了、
 * 其实没发」，和报告 §18.3 里 `files` 那次事故同构。
 *
 * 所以这里只给一句软提示，让她自己少写/多写标记——不改变已经生成的任何内容，
 * 也不需要往 `/r/reply` 回包加字段（省掉跨进程握手）。delay 乘子严禁用于
 * 被动回复（群窗口 5 分钟），要抖只能抖 awake 的主动间隔。
 */
export function behaviorHint(m, enabled = false) {
  if (!enabled) return '';
  const valence = Number(m?.valence ?? 0);
  const energy = Number(m?.energy ?? 0.5);
  const sociability = Number(m?.sociability ?? 0.5);
  if (valence < -0.4 || energy < 0.4) return '今天没什么兴致，少配图、少发语音，话也短些。';
  if (valence > 0.4 && sociability > 0.6) return '今天兴致不错，想配张图或说段语音都可以。';
  return '';
}

/**
 * 情绪注入块的最终文本。
 *
 * `toneText` 来自 `mood.text()`（B3 之后中性时是空串），`hint` 来自上面。
 * 两者都是完整句，直接拼；都为空时返回空串，让挂载点跳过这一块。
 * 抽成纯函数是为了能单测「默认关时与现状逐字一致」——情绪块挂在
 * `mount(agent, chat)` 里，假 ctx 到不了那一层。
 */
export function moodPrompt(toneText, m, enabled = false) {
  return [String(toneText ?? ''), behaviorHint(m, enabled)].filter(Boolean).join('');
}
