/**
 * 动作标记的语法层
 * ================
 *
 * 模型会在回复里写 `<<remember: 内容>>` 这类标记。**这些标记绝不能漏到群里**——
 * 用户看到 `<<remember：...>>` 只会觉得机器人坏了。
 *
 * 这里只放**纯语法**：怎么匹配、怎么清理。副作用（写记忆、改人设、清上下文）
 * 留在 `host.js` 的 `applyMemoryMarkers` 里，那边依赖 memory / journal / self，
 * 拉进来就测不动了。
 *
 * ## 为什么单独抽出来
 *
 * 2026-10-31 实测：`applyMemoryMarkers` **零测试**，而它对畸形写法不设防——
 * 全角冒号、缺 `>>` 都会原样漏到群里。而这个函数的触发率马上要提高
 * （见记忆方案 P0），泄漏次数会跟着线性上升，所以先把语法层钉住。
 *
 * ## 已知的三种写法都要认
 *
 *   `<<remember: 内容>>`    半角冒号（模型最常用）
 *   `<<remember：内容>>`    **全角冒号**——中文输入法下很容易打出来
 *   `<<remember: 内容`      没闭合（截断、模型手滑）
 */

/** 带值的标记名。`clear` 没有值，不在此列。 */
export const VALUE_MARKERS = ['remember-here', 'remember', 'replace', 'persona', 'mood', 'forget', 'close'];

/**
 * 下游（ai-chat）负责执行的标记，宿主必须原样放行闭合写法。
 *
 * 摘了它们，ai-chat 就发不出图 / 语音 / 按钮了（真实事故见 `stripUnknown`）。
 * 但**未闭合的必须摘**：它没有闭合位置，ai-chat 的正则也匹配不到，
 * 留着就是原样进群。反正缺 `>>` 的标记本来就执行不了。
 *
 * 两个图片标记分工（2026-11-07 起模型侧只教这两种）：
 *   `<<image: 路径>>`        就地插图，图和文字同一条
 *   `<<image-alone: 路径>>`  单独发一条图
 * 两者都是 `<<>>` 标记，宿主**不能摘**——摘了 ai-chat 就拿不到位置/意图。
 */
export const DOWNSTREAM_MARKERS = ['image', 'image-alone', 'voice', 'button', 'say', 'silence'];

/**
 * 一个标记的匹配式。**半角冒号和全角冒号都认**。
 *
 * 用函数生成而不是常量数组：每个标记各用一次，带 `g` 的正则不能复用
 * （`lastIndex` 会串）。
 *
 * @param {string} name
 * @returns {RegExp}
 */
export function markerRe(name) {
  return new RegExp(`<<${name}[:：]\\s*([\\s\\S]*?)>>`, 'gi');
}

/**
 * 清掉「未闭合」的已知标记：从 `<<name[:：]` 一直吞到行尾。
 *
 * 只在**所有正常标记都摘完之后**调用。截断的标记没有闭合位置，
 * 后面那截就是它的内容——留给用户看是纯噪音。
 *
 * 只认已知标记名，避免把正文里偶尔出现的 `<<` 一起吃掉。
 *
 * @param {string} text
 */
export function stripUnclosed(text) {
  const names = [...VALUE_MARKERS, ...DOWNSTREAM_MARKERS].map((n) => n.replace(/-/g, '\\-')).join('|');
  return String(text ?? '').replace(new RegExp(`<<(?:${names})[:：](?![^\\n]*>>)[^\\n]*`, 'gi'), '');
}

/**
 * 解析 `<<replace: 旧说法 | 新说法>>` 的值。
 *
 * 分隔符半角 `|` 和全角 `｜` 都认（中文输入法下后者很常见）。
 * 用 `slice` 而不是 `split`：新说法里可能还有竖线，split 会把它们切碎。
 *
 * @param {string} value
 * @returns {{old:string, next:string}|null} 格式不对返回 null（调用方负责提示）
 */
export function parseReplace(value) {
  const raw = String(value ?? '').trim();
  const sep = raw.search(/[|｜]/);
  if (sep < 0) return null;
  const oldNeedle = raw.slice(0, sep).trim();
  const next = raw.slice(sep + 1).trim();
  if (!oldNeedle || !next) return null;
  return { old: oldNeedle, next };
}

/**
 * 兜底：剩下的 `<<名字>>` / `<<名字: 值>>` 一律摘掉。
 *
 * 标记协议是**两个仓库各自实现**的（这里是这套，ai-chat 的 `parseActions`
 * 是另一套）。哪边加了新标记、另一边没跟上，标记就会原样进群。
 *
 * 负向前瞻放行 `DOWNSTREAM_MARKERS`——那几个由 **ai-chat** 执行
 * （单独发图 / 语音 / 按钮 / 语音条 / 静默），宿主不认识也不该碰。
 * 名单从常量动态生成，别再手写一遍导致两边漂移。
 *
 * @param {string} text
 */
export function stripUnknown(text) {
  const preserve = DOWNSTREAM_MARKERS.map((n) => n.replace(/-/g, '\\-')).join('|');
  const re = new RegExp(
    `<<(?!${preserve})\\b[a-z][a-z-]{0,20}(?:[:：][^<>]{0,2000})?>>`,
    'gi',
  );
  return String(text ?? '').replace(re, '');
}
