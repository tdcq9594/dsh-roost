/**
 * 出站动作层：把模型写的标记变成「干净正文 + 可执行动作」。
 * ==========================================================
 *
 * 移除 ai-chat 之前，这一层在插件里（`decide.js:parseActions` +
 * `outbound.js:sendMedia`）：宿主 `applyMemoryMarkers` 只处理记忆类标记，
 * 把 image / voice / say / button / silence 原样放行给 ai-chat 执行。
 * 直连之后没有下游了，`markers.js` 又还在放行 ⇒ 标记会原样进群。
 *
 * 这里补上同一个分界线，但不改上游 `applyMemoryMarkers` 的行为：
 * 它照旧只摘记忆类，本模块在**真正发送前**再摘一次动作类，然后执行。
 * 所有出站路径（主回复 / `qq_send` 分段直发 / `/v1/message` 扩展投递）
 * 都经过 `deliverBatch` 的 `send()`，一处收口不会漏。
 *
 * 设计上刻意对齐旧 ai-chat 的语义，保证「原有体验不变」：
 *   · `<<image: 路径>>`      就地插图 → 上传 Markdown 素材，换成 `![](qqbot-media://…)`
 *   · `<<image-alone: 路径>>` 单独发一条图（正文先发、图后发）
 *   · 两者都能带显示尺寸：`<<image: #3|320x200>>`（末尾 `|宽x高`）。
 *     只写一边时另一边按**原图比例**补（读文件头，不猜）；两边都写就照写
 *     显示，允许放大、缩小、变形。见 `parseImageSize` / `sizeBoxOf`。
 *   · `<<voice: 路径>>`      单独发一条语音
 *   · `<<say: 文本>>`        宿主 TTS 合成后发语音条（没开语音就静默跳过）
 *   · `<<button: 标签|指令>>` 挂到本条 Markdown 的 keyboard（type:2 指令型）
 *   · `<<pick: 标签|值>>`    回调型按钮（type:1），同组点一个其余变灰
 *   · `<<quote: 引用索引>>`  让这条回复挂引用样式（不写就不挂）
 *   · `<<card: 标题|描述|https://链接|https://图片>>`
 *                            官方图文卡片（`msg_type=8`），**独占一条消息**：
 *                            正文先发、卡片后发，一轮最多一张
 *   · `<<silence: 2h>>`      走框架闸 `gate.silence`
 *   · `<<retract>>`          撤回这一轮之前自己发的最后一条
 *   · `<skip>`               永不外发；正文只剩它时不发这条消息
 *   · 代码块 / 行内代码里的标记不执行（模型讲解写法时不会误发图）
 *
 * 路径只做「形状」判据，不做存在性检查——存在性归框架（它才知道文件在
 * 哪台机器上）。**任何上传失败都把占位符换成空串**，绝不把本地绝对路径
 * 以 `![](C:\…)` 的形式发进群。
 */

import { writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseCardValue, tuwenProblem } from './tuwen.js';
import { encodeButtonData } from './roost-interaction.js';
import { dimsOfPath } from './image-size.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i;
const VOICE_EXT = /\.(silk|amr|mp3|wav|ogg|m4a)(?:[?#].*)?$/i;
const SOURCE_PREFIX = /^(?:[a-z][a-z0-9+.-]*:\/\/|\\\\|\/|[a-z]:[\\/]|\.{1,2}[\\/])/i;

/**
 * 后缀判断：**先试原样，再试剥掉 `?query` / `#frag` 的部分**。
 *
 * 原来只测剥掉之后的部分，于是文件名里合法地带 `#`（`图#1.png`，`safeFileName`
 * 明确允许）会被切成 `图`、后缀判断失败，这张图**静默不发**——`continue` 连
 * 日志都没有，用户只看到少一张图。反过来 `a.png?v=2` 这种带缓存参数的链接
 * 又必须剥了才认。两种写法都得支持，所以两条路都试。
 */
const hasExt = (v, re) => re.test(v) || re.test(String(v).split(/[?#]/)[0]);

/**
 * 图库序号：`#3`。
 *
 * **这是模型唯一该抄的东西**。绝对路径带盘符、中文、空格、括号，抄错一个字符
 * 就是「图没发出去」而界面上毫无提示；`#3` 只有两个字符，抄不错。
 *
 * 只认纯序号：`#3` 对，`#3.png`、`#3,#5` 都不对——多图一次一张，和
 * `MAX_MEDIA` 的口径一致；带后缀说明模型在猜，猜的不能当真的。
 */
const SEQ_SOURCE = /^#(\d{1,6})$/;

/* ---------------- 显示尺寸 ---------------- */

/**
 * 尺寸位：`320x200` / `320×200` / `320*200` / `320x` / `x200`，允许带 `px`。
 *
 * **必须有一个分隔符**：只写 `320` 不算尺寸——文件名、序号都可能正好是数字，
 * 拿它当尺寸会把「`<<image: #1>>` 后面跟了一个数字」误判成尺寸，那张图反而
 * 按奇怪的比例显示。
 */
const SIZE_SPEC = /^(\d{1,5})?\s*(?:px)?\s*[x×*]\s*(\d{1,5})?\s*(?:px)?$/i;

/**
 * 上限。官方尺寸位取值是 5 位数，但真有人写 `99999x99999` 只会得到一张
 * 加载不出来的图；4096 已经超过任何正常显示需求（手机屏宽普遍 1080~1440）。
 */
const SIZE_MAX = 4096;

/**
 * 解析尺寸位。写不出来（`宽高都不给`、只有分隔符、含非法字符）返回 `null`。
 *
 * 只给一边时另一边是 **0**，表示「按原图比例算」——这一步要读图才知道真实
 * 比例，所以放在执行器里做（见 `sizeBoxOf`），解析层保持纯函数。
 *
 * @param {string} spec 比如 `320x200`、`320x`、`x200`
 * @returns {{w:number,h:number}|null} `w`/`h` 为 0 表示这一边不指定
 */
export function parseImageSize(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return null;
  const m = SIZE_SPEC.exec(s);
  if (!m) return null;
  const clampN = (v) => {
    const n = Math.floor(Number(v) || 0);
    return n > 0 ? Math.min(n, SIZE_MAX) : 0;
  };
  const w = clampN(m[1]);
  const h = clampN(m[2]);
  if (!w && !h) return null;
  return { w, h };
}

/**
 * 把标记值拆成「来源 + 尺寸」。
 *
 * 两种写法都认：
 *   · `#3|320x200`、`D:/a.png|320x` —— **竖线**是首选。Windows 文件名里没有
 *     `|`，路径带空格也不会被拆错；
 *   · `#3 320x200` —— 空格分隔只对**序号**生效。路径里空格太常见
 *     （`C:/Program Files/a.png`），按空格拆会把路径本身切断。
 *
 * 竖线后面不是合法尺寸时（`#3|abc`）整段当值原样返回，交给 `sourceOf` 判——
 * 结果是「序号写法不对」，日志会明确说清，而不是静默当成尺寸吃掉了。
 *
 * @returns {{value:string, size:{w:number,h:number}|null}}
 */
export function splitImageSize(raw) {
  const s = String(raw ?? '').trim();
  const bar = /^(.*?)\s*[|｜]\s*([^|｜]*)$/.exec(s);
  if (bar) {
    const size = parseImageSize(bar[2]);
    return size ? { value: bar[1].trim(), size } : { value: s, size: null };
  }
  const seq = /^(#\d{1,6})\s+(.+)$/.exec(s);
  if (seq) {
    const size = parseImageSize(seq[2]);
    if (size) return { value: seq[1], size };
  }
  return { value: s, size: null };
}

/**
 * 拼 markdown 图片的尺寸位：` #320px #200px`。
 *
 * 只给一边时**读原图算另一边**（`dimsOfPath` 只看文件头 64KB）。这是
 * `<<image: #3|320x>>` 能用的关键：模型不必知道原图比例，也能得到一个
 * 不变形的尺寸。
 *
 * 读不出原图尺寸（格式不认 / 文件读不了）时返回空串，调用方退回不含尺寸的
 * `![](url)`——框架会按 480 宽兜底，**绝不猜一个比例把图压变形**。
 *
 * @param {{w:number,h:number}} size
 * @param {string} p 本地图片路径
 * @returns {string}
 */
export function sizeBoxOf(size, p) {
  let w = Math.floor(Number(size?.w) || 0);
  let h = Math.floor(Number(size?.h) || 0);
  if ((!w || !h) && p) {
    const real = dimsOfPath(p);
    if (real.w > 0 && real.h > 0) {
      if (w && !h) h = Math.max(1, Math.round((real.h * w) / real.w));
      else if (h && !w) w = Math.max(1, Math.round((real.w * h) / real.h));
    }
  }
  if (!w || !h) return '';
  return ` #${w}px #${h}px`;
}

/** 单轮最多发几个独立媒体，和旧 ai-chat 的 MAX_MEDIA 一致 */
export const MAX_MEDIA = 3;
/** 单轮最多几张官方图文卡片：一张占一整屏，多来几张就是刷屏 */
export const MAX_CARDS = 1;
/** 同一轮里多段直发可能重复带同一个标记，按 type+value 去重 */
const DEDUPE_MS = 60_000;

export function codeRanges(text) {
  const s = String(text ?? '');
  const ranges = [];
  const fence = /^[ \t]*(`{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;
  for (const m of s.matchAll(fence)) ranges.push([m.index, m.index + m[0].length]);
  for (const m of s.matchAll(/`[^`\n]+`/g)) {
    const at = m.index ?? 0;
    if (ranges.some(([a, b]) => at >= a && at < b)) continue;
    ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

const inCode = (at, ranges) => ranges.some(([a, b]) => at >= a && at < b);

/** 值像不像真能拿去的地址（模型举例时会写「图片路径」这种占位词） */
export function looksLikeSource(p) {
  const s = String(p ?? '').trim();
  return Boolean(s) && (SOURCE_PREFIX.test(s) || IMAGE_EXT.test(s));
}

/** `file:///C:/…` 还原成本地路径；其它协议原样不动 */
export function normalizeSource(p) {
  const s = String(p ?? '').trim();
  if (!/^file:\/\//i.test(s)) return s;
  try {
    return decodeURIComponent(new URL(s).pathname.replace(/^\/([a-z]):/i, '$1:'));
  } catch {
    return s;
  }
}

/** `<<silence:2h>>`：默认单位是分钟，上限 30 天（与旧实现一致） */
export function parseDurationMs(v) {
  const m = String(v ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i);
  if (!m) return 0;
  const mul = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || 'm').toLowerCase()];
  return Math.min(Math.round(Number(m[1]) * mul), 30 * 86_400_000);
}

/** `<<button: 标签|指令>>`，最多 4 个、每行 2 个 */
export function parseButton(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*[|｜]\s*/);
  const label = String(parts[0] ?? '').trim().slice(0, 12);
  const data = String(parts[1] ?? label).trim().slice(0, 100);
  return label ? { label, data } : null;
}

/**
 * `<<button: 标签|指令>>`，最多 4 个、每行 2 个。
 *
 * **形状必须是 `{ content: { rows } }`**，不是 `{ rows }`。
 *
 * 官方把按钮挂在 Markdown 消息的 `keyboard` 字段上，这个字段是二选一：
 * `{ "id": "模板 id" }` 或者 `{ "content": { "rows": [...] } }`（自定义按钮）。
 * 少包一层 `content` 的时候腾讯不会报错，**只会把整个 keyboard 当没看见**——
 * 消息正常发出去、图也在、就是没有按钮，日志里一个字都不留（2026-11-13 实机：
 * 「按钮怎么没了」）。同仓 `bot/src/message.js` 的 `replyCard` 注释里写的就是
 * `keyboard: { content: { rows: [...] } }`。
 */
export function buildKeyboard(buttons, { max = 4, perRow = 2 } = {}) {
  const list = (buttons ?? []).filter((b) => b && b.label).slice(0, max);
  if (!list.length) return null;
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) {
    rows.push({
      buttons: list.slice(i, i + perRow).map((b, j) => ({
        id: String(i + j + 1),
        render_data: { label: b.label, visited_label: b.label, style: 1 },
        action: { type: 2, permission: { type: 2 }, data: b.data },
      })),
    });
  }
  return { content: { rows } };
}

/**
 * `<<pick: 标签|值>>`：回调型按钮的选项。
 *
 * 与 `parseButton` 刻意分开：按钮点击后的去向完全不同（一个是当作用户消息
 * 发出、一个是回传发起方），共用一套解析迟早会把两者混起来。
 */
export function parsePick(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(/\s*[|｜]\s*/);
  const label = String(parts[0] ?? '').trim().slice(0, 12);
  const val = String(parts[1] ?? label).trim().slice(0, 100);
  return label ? { label, value: val } : null;
}

/**
 * 把若干 `{content:{rows}}` 键盘合成一个，并重新编号所有按钮 id。
 *
 * 一条消息只能挂一个 keyboard。`<<button:>>` 和 `<<pick:>>` 同时出现时不能
 * 丢掉任何一方，但两处各自从 1 编号会撞 id，所以合并后统一重排。
 */
export function combineKeyboards(list) {
  const rows = [];
  for (const kb of list) {
    for (const row of kb?.content?.rows ?? []) {
      if (Array.isArray(row?.buttons) && row.buttons.length) rows.push(row);
    }
  }
  if (!rows.length) return null;
  let n = 0;
  return {
    content: {
      rows: rows.map((row) => ({
        buttons: row.buttons.map((b) => ({ ...b, id: String(++n) })),
      })),
    },
  };
}

/**
 * 回调型按钮键盘（`action.type: 1`）。
 *
 * 三个字段是「点一个其余变灰」的全部秘密，都是 QQ 原生能力，插件不维护状态：
 *   · `group_id`     同一组选项共享 → 组内互斥
 *   · `click_limit`  每人只能点一次
 *   · `visited_label` 点过之后显示的文案
 *
 * `data` 用 `{t,n,v}`：顶层 `t` 供交互路由判别通道，`n` 是本组 nonce
 * （旧卡片/重复点击靠它失效），`v` 是这一项回传的值。
 */
export function buildPickKeyboard(picks, nonce, { max = 4, perRow = 2 } = {}) {
  const list = (picks ?? []).filter((p) => p && p.label).slice(0, max);
  if (!list.length || !nonce) return null;
  const groupId = `pick-${nonce}`;
  const rows = [];
  for (let i = 0; i < list.length; i += perRow) {
    rows.push({
      buttons: list.slice(i, i + perRow).map((p, j) => ({
        id: String(i + j + 1),
        render_data: { label: p.label, visited_label: '✓ 已选', style: 1 },
        action: {
          type: 1,
          permission: { type: 2 },
          click_limit: 1,
          data: encodeButtonData({ t: 'pick', n: nonce, v: p.value }),
        },
        group_id: groupId,
      })),
    });
  }
  return { content: { rows } };
}

/**
 * 解析正文里的动作标记。
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {(seq:number) => string} [opts.resolveImage]
 *        图库序号 → 真实路径。**返回空串表示解析失败**（号不存在 / 已进回收站 /
 *        文件已删），此时占位符整段摘掉并记日志，绝不留 `#3` 在正文里。
 *        不注入时 `#3` 一律按「不是地址」处理——老调用方行为不变。
 * @returns {{text:string, actions:Array<{type:string,value?:string,seq?:number,size?:{w:number,h:number}}>, wantSkip:boolean}}
 */
export function parseOutboundActions(raw, opts = {}) {
  const actions = [];
  let out = String(raw ?? '');
  const resolveImage = typeof opts?.resolveImage === 'function' ? opts.resolveImage : null;

  /** `<skip>` 先摘：它影响「这条要不要发」，不是动作 */
  const wantSkip = /<skip>/i.test(out);
  if (wantSkip) out = out.replace(/<skip>/gi, '');

  /**
   * 语音标记混写时只保留「要念的文字」：
   * `<voice>` 里再套 `<<voice: 路径>>` 不能把路径念出来；成对 say 里再套 `<voice>`
   * 会留下一条空 say（发一条 0 字节语音）。这里统一剥嵌套、丢空值。
   */
  const cleanSayValue = (v) => String(v ?? '')
    .replace(/<voice>([\s\S]*?)<\/voice>/gi, '$1')
    .replace(/<<voice[:：][\s\S]*?>>/gi, '')
    .replace(/<<say[:：]\s*([\s\S]*?)>>/gi, '$1')
    .trim();

  const take = (re, type, hasValue = true) => {
    const ranges = codeRanges(out);
    out = out.replace(re, (...args) => {
      const offset = args[args.length - 2];
      if (typeof offset === 'number' && inCode(offset, ranges)) return args[0];
      if (type === 'say') {
        const value = cleanSayValue(args[1]);
        /** 空语音等价于没说，不能合成出一条空音频 */
        if (value) actions.push({ type, value });
        return '';
      }
      actions.push(hasValue ? { type, value: String(args[1] ?? '').trim() } : { type });
      return '';
    });
  };

  take(/<<retract>>/gi, 'retract', false);
  take(/<<silence[:：]\s*([\s\S]*?)>>/gi, 'silence');
  take(/<<button[:：]\s*([\s\S]*?)>>/gi, 'button');
  /** pick 必须在通用兜底之前摘掉，否则会被 `<<[a-z]…>>` 那条整段吃掉 */
  take(/<<pick[:：]\s*([\s\S]*?)>>/gi, 'pick');
  /** quote 的值允许留空：留空时用入站消息的 replyTo 自动补 */
  take(/<<quote[:：]\s*([\s\S]*?)>>/gi, 'quote');
  /**
   * `<voice>内容</voice>`：对面 aurabot 的语音格式，2026-11-24 对齐。
   *
   * 和 `<<voice: 路径>>`（发**已有音频文件**）不是一回事——这里包的是
   * **要念的文字**，走 `say` 分支让宿主 TTS 合成。映射成 `say` 而不是新
   * action type，是为了复用下面那条已经跑通的「按人扣语音条额度 →
   * TTS 合成 → sendVoice → 失败退额度」完整链路。
   *
   * 必须在 `<<voice:>>` 之前摘：两者都叫 voice，但形状不同、语义也不同。
   * `<voice>...</voice>` 是单尖括号成对标签，`stripUnknown` 只清 `<<...>>`，
   * 所以它能原样活到这一层（已在 markers 上验证）。
   */
  take(/<voice>([\s\S]*?)<\/voice>/gi, 'say');
  take(/<<say[:：]\s*([\s\S]*?)>>/gi, 'say');
  take(/<<voice[:：]\s*([\s\S]*?)>>/gi, 'voice');

  /**
   * `<<card: 标题|描述|https://链接|https://图片>>`：官方图文卡片。
   *
   * 和 `/v1/send { card }` 用同一份校验（`tuwen.js`）。不合格的**只摘掉**，
   * 并留一条 `cardInvalid` 动作让执行器记日志：平台对坏卡片只回一个
   * 笼统的 `304061`，日志里得有「title 最多 50 字」这种能照着改的原因。
   * 绝不能把半截参数发成一条空白卡片，那比不发更糟。
   *
   * 值里不许出现 `<` / `>`：URL 里没有，模型举例时写的「<链接>」也不该
   * 被当成真卡片。
   */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<card[:：]\s*([^<>]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      const card = parseCardValue(v);
      const why = card ? tuwenProblem(card) : '要写成「标题|描述|https://链接|https://图片」';
      actions.push(why ? { type: 'cardInvalid', value: why } : { type: 'card', card });
      return '';
    });
  }
  {
    /**
     * 兜底：值里写了 `<` / `>`（模型常把示例写成 `<链接>`）时，上面那条
     * `[^<>]*?` 根本不匹配，旧版会整段 `<<card: …>>` 原样发到群里。
     * 这里全部摘掉，并留一条能照着改的原因。
     */
    const ranges = codeRanges(out);
    out = out.replace(/<<card[:：]([\s\S]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      actions.push({
        type: 'cardInvalid',
        value: '卡片参数里不能出现 < 或 >，要写成「标题|描述|https://链接|https://图片」',
      });
      return '';
    });
  }

  /**
   * 标记值 → 可发送的路径。
   *
   * 三种写法：绝对路径 / `file://` 原样用；`#3` 查图库；其它（模型偶尔写
   * 「图片路径」这种占位词）当无效。返回 `{path, seq, bad}`，`path` 为空表示
   * 解析失败——失败原因分三种，`seq` 非 0 是「号不存在」，`bad` 非空是
   * 「`#` 打头但写法不对」，两种都值得记日志给用户看。
   */
  const sourceOf = (v) => {
    const s = normalizeSource(String(v ?? '').trim());
    /**
     * `#` 打头的一律按图库序号处理，**先于**「像不像路径」判断。
     *
     * 否则 `#3.png` 会被 `IMAGE_EXT` 认成相对文件名（`.png` 结尾），一路
     * 走到 `uploadMarkdownImage` 才失败——日志里是「文件不存在」而不是
     * 「序号写错了」，用户根本查不到原因。带后缀说明模型在猜，猜的不算。
     *
     * 格式不对时返回 `bad` 而不是 `null`：`null` 在调用方等价于「这个标记
     * 根本不该存在」，会连日志一起静默掉。而「写了 `#3.png`」是**模型犯的
     * 具体错误**，得让它本人（下一轮的提示词里）和用户都看得见。
     */
    if (s.startsWith('#')) {
      const m = SEQ_SOURCE.exec(s);
      if (!m) return { path: '', seq: 0, bad: s };
      const seq = Number(m[1]);
      const path = resolveImage ? String(resolveImage(seq) || '') : '';
      return { path, seq };
    }
    if (looksLikeSource(s)) return { path: s, seq: 0 };
    return null;
  };

  /** 序号没查到 / 写法不对：统一推一条动作，两个标记走同一套日志 */
  const missOf = (hit) => {
    if (hit.seq) return { type: 'imageMiss', value: `#${hit.seq}` };
    if (hit.bad) return { type: 'imageBad', value: hit.bad };
    return null;
  };

  /** `<<image-alone: 路径>>`：单图单独发；值不像路径就只摘掉，别把占位词留群里 */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<image-alone[:：]\s*([^<>]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      /** `#3|320x` 先拆尺寸，再按剩下的值认来源 */
      const sp = splitImageSize(v);
      const hit = sourceOf(sp.value);
      if (!hit) return '';
      if (!hit.path) {
        /** 序号没查到 / 写法不对：留一条动作让执行器记日志，用户才知道「图为什么没发」 */
        const miss = missOf(hit);
        if (miss) actions.push(miss);
        return '';
      }
      actions.push({
        type: 'imageAlone', value: hit.path,
        ...(hit.seq ? { seq: hit.seq } : {}),
        ...(sp.size ? { size: sp.size } : {}),
      });
      return '';
    });
  }

  /**
   * `<<image: 路径>>`：就地插图。先换成不含路径的占位符，等上传成功再填
   * `qqbot-media://`。**不能先写成 `![](C:\…)`**——上传失败时那串会原样进群。
   */
  {
    const ranges = codeRanges(out);
    let n = 0;
    out = out.replace(/<<image[:：]\s*([^<>]*?)>>/gi, (m, v, offset) => {
      if (inCode(offset, ranges)) return m;
      const sp = splitImageSize(v);
      const hit = sourceOf(sp.value);
      if (!hit) return '';
      if (!hit.path) {
        const miss = missOf(hit);
        if (miss) actions.push(miss);
        return '';
      }
      const key = `\u0001IMG${n++}\u0001`;
      actions.push({
        type: 'inlineImage', value: hit.path, key,
        ...(hit.seq ? { seq: hit.seq } : {}),
        ...(sp.size ? { size: sp.size } : {}),
      });
      return key;
    });
  }

  /** `<<file:>>` 只摘不执行：发文件必须走 `qq_send_file` 工具 */
  take(/<<file[:：]\s*([\s\S]*?)>>/gi, 'file');

  /** 兜底：剩下的已知/未知 `<<名字>>` 全摘（代码块里的不动） */
  {
    const ranges = codeRanges(out);
    out = out.replace(/<<[a-z][a-z-]{0,20}(?:[:：][^<>]{0,2000})?>>/gi, (m, offset) => {
      if (typeof offset === 'number' && inCode(offset, ranges)) return m;
      return '';
    });
  }

  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, actions, wantSkip };
}

/**
 * 执行器。持有「每个会话自己发的最后一条」与媒体去重表，跨轮有效。
 *
 * @param {object} o
 * @param {() => object} o.channel   取当前通道（延迟取，热切换通道不会拿到旧的）
 * @param {object} [o.tts]          `createTts()` 实例，给 `<<say>>` 用
 * @param {object} [o.quota]        `createQuota()` 实例，给 `<<say>>` 扣「语音条」额度
 * @param {object} [o.picks]        `createPickChannel()` 实例，给 `<<pick:>>` 登记 nonce。
 *                                  没注入时 `<<pick:>>` 只摘掉不发按钮——纯加法，不产生孤儿回调
 * @param {(m:string)=>void} [o.log]
 */
export function createActionRunner({
  channel, tts = null, quota = null, picks = null, onPick = null, log = () => {},
  dryRunOf = () => false,
  /**
   * Markdown 通道是否可用（宿主注入，热读）。只有带尺寸的独立图会问它：
   * 那条路把图换成 `![](…)` 交给 markdown 通道，**面板把 markdown 关掉时
   * 这段会当纯文本发进群里**（`![](…)` 原样可见）。关着就退回富媒体——
   * 图还能发，只是尺寸按原图。
   */
  markdownOf = () => true,
  /**
   * `#3` → 真实路径。宿主把图库的 `pathOf` 注进来；不注时 `<<image: #3>>`
   * 按无效值处理（和以前一样摘掉），老调用方行为不变。
   */
  resolveImage = null,
  /**
   * 图真的发出去了之后回调序号。**只在成功后调**：发失败不该算一次使用，
   * 否则「用过 -3」的排序会被失败的尝试污染，模型会绕开根本没发出去的图。
   */
  onImageUsed = null,
  /**
   * `#3` 在图库里的**线上副本**（官方素材池那份）：`seq → { imageId, url }`。
   *
   * 有就直接拿 `qqbot-media://` 引用发，省一次上传（几秒）也省一次配额占用；
   * 没有就照常上传。注不进来时退化成「每次都传」，行为跟以前一致。
   */
  resolveRemote = null,
  /** 上传成功后记下线上副本，下次发同一张就不重传。 */
  markRemote = null,
  /**
   * 上传后**是否留着**这份线上副本。默认 `true`。
   *
   * 框架 `media.markdownImage` 的默认语义本来就是「可复用、默认保留」，我们
   * 以前写死了 `retain:false` + 发完即删，把它降级成临时车道——于是同一张图
   * 每发一次就白占一格配额、白传一遍。配额紧（100 张机器人级共享）时才该
   * 用 `false`，那是**一种模式**，不是唯一做法。
   *
   * 收函数而不是布尔：宿主配置是热的，用户在面板改完不该等重启。
   */
  keepUploadsOf = () => true,
  /**
   * 上传前腾配额（宿主注入）。
   *
   * 官方素材池是机器人级共享的 100 张，满了以后**每一次上传都失败**，而错误
   * 只有「上传失败」四个字。宿主那边会按「最久没动过的先走」淘汰自己的副本
   * （钉住的不碰）；这里只负责在撞墙之前问一句。
   *
   * 返回 `{ ok:false, message }` 时**不要上传**：上传必然失败，而占位符会先被
   * 摘掉，用户只会看到「图没了」。抛出把原因带到日志里。
   */
  ensureQuota = null,
} = {}) {
  /** 试运行：正文 / 文件 / 语音的发送在通道层已经拦了，这里只管**发送之前**那几步 */
  const isDry = () => dryRunOf() === true;
  /** chatId → { id, kind, at } */
  const lastSent = new Map();
  /** `chatId|type|value` → at */
  const mediaSeen = new Map();

  const seen = (chatId, type, value) => {
    const k = `${chatId}\0${type}\0${value}`;
    const now = Date.now();
    if (now - (mediaSeen.get(k) ?? 0) < DEDUPE_MS) return true;
    mediaSeen.set(k, now);
    if (mediaSeen.size > 500) {
      for (const [key, at] of mediaSeen) if (now - at > DEDUPE_MS) mediaSeen.delete(key);
    }
    return false;
  };

  /**
   * 发一轮（一段）内容。
   *
   * @returns {Promise<{ok:boolean, sent:boolean, ...}>} 发送结果，供调用方记日记/冷却
   */
  return async function run({
    /** kind 是框架四态（group/c2c/guild/dm），scene 仍是两态投影 */
    text, extra = {}, scene = 'c2c', kind = '', target = '', msgId = '', receivedAt = 0,
    /** 3.7：事件被动回复（只有 event_id 的事件）；msgId 优先 */
    eventId = '',
    /** 4.6：互动召回，官方 is_wakeup 消息（不校验 msg_id/event_id 有效期） */
    isWakeup = false,
    /** `<<quote:>>` 留空时的兜底：入站 `replyTo`（被引用那条的 message_id） */
    replyTo = '',
    /**
     * `senderId` 是**说话的人**，不是会话 id——`<<say>>` 的语音额度按人扣。
     * 没有真人（主动搭话 / 事件轮）时留空，配额退回按会话算。
     */
    requestId = '', senderId = '', bucket = '', onSent = () => {},
  } = {}) {
    const ch = channel();
    const { text: body0, actions, wantSkip } = parseOutboundActions(text, { resolveImage });
    let body = body0;

    /** 序号解析失败的图：必须留一句日志，否则用户只看到「图没发出来」 */
    for (const a of actions.filter((x) => x.type === 'imageMiss')) {
      log(`图库里的 ${a.value} 用不了（号不存在 / 已进回收站 / 已停用 / 文件已删），这张已跳过`);
    }
    /**
     * `<<image: #3.png>>` 这种写法：序号部分合法，但整段不是纯数字。
     *
     * 以前这里返回 `null`，占位符被摘掉、日志一个字都不写——用户只看到
     * 「图没发」，模型下一轮还在用同样的写法。现在明确说清正确写法。
     */
    for (const a of actions.filter((x) => x.type === 'imageBad')) {
      /** 值来自模型，可能很长还带换行：日志里压成一行、截断，别把日志刷烂 */
      const shown = String(a.value ?? '').replace(/\s+/g, ' ').trim();
      log(`图库序号写法不对：「${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}」——只能写 #3 这种纯数字（不要加后缀），这张已跳过`);
    }

    /** 图发成功才记一次使用（见 `onImageUsed` 的说明） */
    const used = (a) => {
      if (!a?.seq || typeof onImageUsed !== 'function') return;
      try {
        onImageUsed(a.seq);
      } catch (e) {
        log(`记图库使用失败（不影响发送）：${e?.message ?? e}`);
      }
    };

    /** 本轮之前自己发的最后一条，`<<retract>>` 撤的是它 */
    const previous = lastSent.get(target) ?? null;
    const wantRetract = actions.some((a) => a.type === 'retract');

    /** 1. 就地插图：上传成 Markdown 素材，占位符换成安全引用 */
    const uploaded = [];
    /**
     * 就地插图里带序号的，**等消息真发出去**才记使用。
     * 原来在上传成功那一刻就记，而上传成功 ≠ 发出去（见下面第 3 步之后的说明）。
     */
    const usedAfterSend = [];
    /** 整轮媒体预算：就地插图 + 后面的独立图 / 语音 / 念出来的话 合计不超 MAX_MEDIA */
    let inlineUsed = 0;

    /**
     * 图 → 可发送的 `qqbot-media://` 引用。**就地插图和带尺寸的独立图共用**：
     *
     *   1. 图库里的图先看线上有没有副本（同一张图第二次发不用重传，省一格配额）；
     *      **快过期的不用**——宁可重传，也不要拿一个马上失效的引用去发，
     *      那种失败在群里表现成「图没出来」，日志只有一句「发送失败」。
     *   2. 没有就上传，必要时先确认配额（满了以后每次上传都失败，而错误只有
     *      「上传失败」四个字）。
     *
     * 抽出来的原因很实际：两条路各写一遍的话，「配额不足怎么报」和
     * 「用完即删要不要记待删」迟早只改到一处。
     *
     * 失败**抛错**，由调用方决定是删占位符还是跳过这条——两处的善后不一样。
     */
    const resolveMediaUrl = async (a) => {
      /** 「用完即删」模式下不存在可复用的副本：那份每次都会被删掉 */
      const keep = keepUploadsOf() !== false;
      if (keep && a.seq && typeof resolveRemote === 'function') {
        const hit = resolveRemote(a.seq);
        const u = String(hit?.url ?? '').trim();
        /** `expireAt` 为 0 表示官方没给 ttl，无从判断，按「还能用」处理 */
        const exp = Number(hit?.expireAt) || 0;
        const soon = exp > 0 && Date.now() > exp - 60_000;
        if (!soon && /^qqbot-media:\/\//i.test(u)) {
          log(`#${a.seq} 复用了线上副本（没重传）`);
          return u;
        }
        if (soon) log(`#${a.seq} 的线上副本快过期了，这次重新上传`);
      }
      if (typeof ensureQuota === 'function') {
        const g = await ensureQuota(1).catch(() => ({ ok: true }));
        if (g && g.ok === false) throw new Error(g.message || '官方素材池配额不足');
      }
      const r = await ch.uploadMarkdownImage({ scene, target, path: a.value, retain: keep });
      const url = String(r?.url ?? '').trim();
      if (!/^qqbot-media:\/\//i.test(url)) throw new Error('没拿到素材引用');
      /**
       * 只有「留着」才记映射：`keep=false` 时这份马上要删，记下来只会让
       * 下次拿着一个失效的 `imageId` 去复用。
       */
      if (keep && a.seq && typeof markRemote === 'function') markRemote(a.seq, r);
      /** 只有「用完即删」模式才记进待删列表；留着复用的那份绝不能删 */
      if (!keep) uploaded.push(String(r?.imageId ?? ''));
      return url;
    };

    for (const a of actions.filter((x) => x.type === 'inlineImage')) {
      if (inlineUsed >= MAX_MEDIA) {
        /** 超预算的占位符直接删掉，绝不能把本地路径留在正文里 */
        body = body.split(a.key).join('');
        log('就地插图超过单轮上限（已跳过）');
        continue;
      }
      inlineUsed += 1;
      try {
        const url = await resolveMediaUrl(a);
        /**
         * 尺寸位：模型显式写了就照它写（`sizeBoxOf` 负责只给一边时按原图
         * 比例补另一边）。没写就留 `![](url)`，由框架按 480 宽兜底——
         * 那套逻辑在框架侧（`md-image.js`），两处都补会算出两个值。
         */
        const box = a.size ? sizeBoxOf(a.size, a.value) : '';
        body = body.split(a.key).join(box ? `![图片${box}](${url})` : `![](${url})`);
        if (a.seq) usedAfterSend.push(a);
      } catch (e) {
        /** 失败只把占位符删掉，绝不留本地路径 */
        body = body.split(a.key).join('');
        log(`就地插图没上传成功（已跳过）：${e?.message ?? e}`);
      }
    }

    /** 2. 按钮 / 静默 */
    const buttons = actions.filter((a) => a.type === 'button').map((a) => parseButton(a.value)).filter(Boolean);
    /**
     * `pick` 单独分组，**绝不能混进 `buttons`**：`buildKeyboard` 里
     * `action.type: 2` 是硬编码的，混进去所有回调按钮都会退化成指令型，
     * 点了不产生 INTERACTION，整条通道就白做了。
     */
    const pickList = actions.filter((a) => a.type === 'pick').map((a) => parsePick(a.value)).filter(Boolean);
    let pickKeyboard = null;
    if (pickList.length && picks && typeof picks.arm === 'function') {
      const armed = picks.arm({
        values: pickList.map((p) => p.value),
        chatId: target,
        scene,
        /** 没注入业务回调时只留一条可见日志，不静默吞掉点击 */
        onPick: typeof onPick === 'function' ? onPick : (r) => log(`回调按钮已选：${r.value}`),
      });
      pickKeyboard = buildPickKeyboard(pickList, armed.nonce);
    } else if (pickList.length) {
      log('本轮有 <<pick:>> 但没接回调通道，已摘掉不发按钮');
    }
    const keyboard = combineKeyboards([buildKeyboard(buttons), pickKeyboard]);

    /**
     * `<<quote: 索引>>`：这条回复挂引用样式。
     *
     * **默认不挂**——只有模型/扩展显式写了标记才生效。原因：官方
     * `message_reference` 要 `REFIDX_xxx`（取自 message_scene.ext.msg_idx），
     * 而入站 `replyTo` 是被引用那条的 message_id，两者不是同一个东西；
     * 而且 `markdown(msg_type=2) + message_reference` 能否共存没有源码可证。
     * 自动给所有回复挂引用，最坏情况是整条发不出去——那是减功能，不是加功能。
     *
     * 显式标记让调用方自己保证索引格式：写了值就用值，留空则退回 `replyTo`。
     * 只取最后一个标记，多个没有意义。
     */
    const quoteActions = actions.filter((a) => a.type === 'quote');
    const quoteRef = quoteActions.length
      ? String(quoteActions[quoteActions.length - 1].value || replyTo || '').trim().slice(0, 128)
      : '';
    const messageReference = quoteRef ? { message_id: quoteRef } : null;
    if (quoteActions.length && !messageReference) {
      log('<<quote:>> 没给索引、入站也没有 replyTo，这条按普通回复发');
    }

    const silenceMs = Math.max(
      0,
      ...actions.filter((a) => a.type === 'silence').map((a) => parseDurationMs(a.value)),
      Number(extra?.silenceMs) || 0,
    );

    /** 3. 发正文（含 Markdown / keyboard / 静默） */
    let r = { ok: true, sent: false };
    const skipOnly = wantSkip && !body.trim();
    if (!skipOnly && (body.trim() || silenceMs > 0)) {
      r = await ch.send({
        scene, kind, target, text: body, msgId, receivedAt, eventId, isWakeup, requestId,
        markdown: true, keyboard, silenceMs, messageReference,
      });
      if (r?.ok) {
        r.sent = true;
        /** 存四态 kind：撤回频道消息要带 guild/dm，否则会打到群/单聊撤回端点 */
        if (r.id) lastSent.set(target, { id: String(r.id), kind: kind || scene, at: Date.now() });
        onSent();
      }
    } else if (skipOnly) {
      log('这一轮是 <skip>：不发消息');
    }

    /**
     * 就地插图的使用记录，**等正文那条真的发成功**之后才记。
     *
     * 上传成功不等于发出去：通道报错、静默跳过、正文被拦，这几种情况下图已经
     * 挂在服务器上而群里什么都没有。记错了的后果是排序被污染——`hits*2` 会把
     * 根本没露面的图顶上来，模型下一轮还选它。独立图（`imageAlone`）那条路
     * 本来就是在 `sent?.ok` 之后记的，这里对齐。
     */
    if (r?.sent) for (const a of usedAfterSend) used(a);

    /** 4. 这一轮要发的文件（原来就在 send() 里，搬过来保持顺序） */
    const files = Array.isArray(extra?.files) ? extra.files.map(String).filter(Boolean) : [];
    /**
     * 文件发送的结果要**带出去**。
     *
     * 以前只 `log` 一句、`rf` 直接丢掉，而返回值是正文那条的结果——
     * 正文为空（`qq_send_file` 就是这样：`postReply(payload, '', false, {files})`）
     * 时 `r` 恒为 `{ok:true, sent:false}`，调用方再怎么判都判不出失败，
     * 于是 `turnSt.files` / 配额不回滚、工具还回 `ok:true`。
     *
     * 用 `filesOk` 而不是覆盖 `ok`：正文可能已经发出去了，把 `ok` 打成 false
     * 会让上层以为整条都没发、再发一遍正文。
     */
    let filesOk = true;
    const fileErrors = [];
    for (const f of files) {
      if (typeof ch.sendFile !== 'function') break;
      const rf = await ch.sendFile({ scene, target, path: f, msgId, receivedAt, eventId, isWakeup, requestId: String(extra?.requestId ?? '') })
        .catch((e) => ({ ok: false, message: e?.message ?? String(e) }));
      if (!rf?.ok) {
        filesOk = false;
        fileErrors.push({ path: f, message: rf?.message ?? '未知原因', network: rf?.network === true });
        log(`发文件失败（${f}）：${rf?.message ?? '未知原因'}`);
      } else onSent();
    }

    /**
     * 4.5 官方图文卡片：正文之后独占一条。
     *
     * 为什么不是「有 card 就不发正文」（`/v1/send` 是这么做的）：那是**一次
     * API 调用**里的互斥（一条消息只能有一种富文本），不是一轮回复只能发
     * 一条消息。模型说「这个视频挺好看 <<card:…>>」时，那句话和卡片都该在，
     * 所以发两条消息，顺序与 `/v1/send` 的 text→files→card 保持一致。
     * 只想发卡片就写 `<skip>` + `<<card:>>`：`<skip>` 管的是正文那一条。
     *
     * 卡片不写进 `lastSent`：和 `imageAlone` / `voice` 一样，`<<retract>>`
     * 撤的仍是「这一轮之前自己发的最后一条正文」。让它撤到卡片上会
     * 出现「撤回没反应」（卡片消息有的场景撤不了）。
     */
    const cards = actions.filter((a) => a.type === 'card');
    for (const a of actions.filter((x) => x.type === 'cardInvalid')) {
      log(`图文卡片没发（已跳过）：${a.value}`);
    }
    if (cards.length > MAX_CARDS) log(`这一轮有 ${cards.length} 张卡片，只发第一张`);
    for (const a of cards.slice(0, MAX_CARDS)) {
      /** 解析时已验过一次，这里再兜一次：动作数组也可能从别处进来 */
      const why = tuwenProblem(a.card);
      if (why) { log(`图文卡片没发（已跳过）：${why}`); continue; }
      if (seen(target, 'card', a.card.url)) continue;
      try {
        const rc = await ch.send({
          scene, kind, target, card: a.card, markdown: false,
          msgId, receivedAt, eventId, isWakeup,
        });
        if (rc?.ok) onSent();
        else log(`图文卡片没发出去：${rc?.message ?? '未知原因'}`);
      } catch (e) {
        /** 卡片发失败不能把这一轮带崩，正文已经发出去了 */
        log(`图文卡片执行失败（已跳过）：${e?.message ?? e}`);
      }
    }

    /** 5. 正文之后的独立媒体：图 / 语音 / 念出来的话 */
    let mediaSent = 0;
    const media = actions.filter((a) => ['imageAlone', 'voice', 'say'].includes(a.type));
    for (const a of media) {
      if (inlineUsed + mediaSent >= MAX_MEDIA) break;
      if (a.type === 'imageAlone' && !hasExt(a.value, IMAGE_EXT)) continue;
      if (a.type === 'voice' && !hasExt(a.value, VOICE_EXT)) continue;
      if (seen(target, a.type, a.value)) continue;
      /**
       * 试运行：`<<say>>` 在真正发送之前还有两步副作用——按人扣语音条额度
       * （落盘 `quota.json`）、调 TTS 合成（配了云端就要钱）。通道层只拦得住
       * 「发出去」，这两步都在 `sendVoice` 之前，所以必须在这里提前让开。
       *
       * 仍然记一条 `mediaSent` + `onSent()`：试运行的语义是「记忆照写、只是
       * 不打扰人」，和正文那条口径一致。`<<voice:>>` / `<<image>>` 不用这一步，
       * 它们发送前的动作就是读本地文件，通道层已经拦住了。
       */
      if (a.type === 'say' && isDry()) {
        log(`试运行：本来要念「${a.value}」，已拦下（不合成、不扣额度）`);
        mediaSent += 1;
        onSent();
        continue;
      }
      try {
        let sent = null;
        if (a.type === 'imageAlone' && a.size && markdownOf() !== false) {
          /**
           * **带尺寸的独立图走 markdown，不走富媒体。**
           *
           * `sendFile` 是 `msg_type=7` 富媒体，官方没有尺寸字段，只能按原图
           * 铺满——一张 1080×4000 的长图在手机上要划好几屏。而「单独发一条图」
           * 恰恰是表情包最常用的形态，尺寸在这条路上比就地插图更该生效。
           *
           * 所以模型写了 `|宽x高` 就换成「一条只有 markdown 图片的消息」：
           * 视觉上仍是单独一张图，尺寸由 `![… #wpx #hpx](url)` 决定。
           */
          const url = await resolveMediaUrl(a);
          const box = sizeBoxOf(a.size, a.value);
          sent = await ch.send({
            scene, kind, target,
            text: box ? `![图片${box}](${url})` : `![](${url})`,
            markdown: true, msgId, receivedAt, eventId, isWakeup,
          });
          /**
           * 这条消息**只有图**：官方拒 markdown 时通道的降级是「`plainOf()`
           * 之后重发纯文本」，而纯文本里图被剥得一个字不剩（见 `channel.js`），
           * 等于整条丢掉。退回富媒体——图至少发得出去，代价是尺寸按原图。
           */
          if (sent && sent.ok === false && typeof ch.sendFile === 'function') {
            log(`带尺寸的独立图没发出去（markdown 被拒？），改按原图重发：${sent.message ?? '未知原因'}`);
            sent = await ch.sendFile({ scene, target, path: a.value, msgId, receivedAt, eventId, isWakeup });
          }
        } else if (a.type === 'imageAlone' && typeof ch.sendFile === 'function') {
          /** markdown 关着时带尺寸的图也落到这里（上一支进不来），尺寸没生效要说一声 */
          if (a.size) log('markdown 关着，这张按原图发（尺寸没生效）');
          sent = await ch.sendFile({ scene, target, path: a.value, msgId, receivedAt, eventId, isWakeup });
        } else if (a.type === 'voice' && typeof ch.sendVoice === 'function') {
          sent = await ch.sendVoice({ scene, target, path: a.value, msgId, receivedAt, eventId, isWakeup });
        } else if (a.type === 'say' && tts && typeof ch.sendVoice === 'function') {
          /**
           * 「语音条」次数配额。
           *
           * 以前扣在 ai-chat 侧，那边不传 openid，按人算不了，所以
           * `QUOTA_WIRED.voice` 一直是 false、面板显示「暂不生效」。
           * 直连之后 `<<say>>` 在这里执行，发送者身份是现成的。
           *
           * **没有发送者就按会话算，不能拿 `target` 顶成一个人**：群里 `target`
           * 是**群 openid**，顶上去等于「整群共用一个「人」的额度」，面板上却
           * 还写着「按人」。主动搭话那种没有真人的轮次就会走到这里。
           *
           * **不通过就退化成文字**：这是「防刷屏」不是「不许说话」，
           * 用户还能看到内容；静默丢弃会让她这一句凭空消失。
           */
          /**
           * 按 aurabot 的口径：语音只是「这句话的发送形态」，失败/关掉都必须还能说话。
           * 静默吞掉是最坏的分支——用户看到的是她明明回了、那句却凭空消失。
           */
          let q = null;
          const sendAsText = async (why) => {
            q?.undo?.();
            log(`${why}，这句改发文字`);
            const rt = await ch.send({ scene, kind, target, text: a.value, msgId, receivedAt, eventId, isWakeup });
            if (rt?.ok) { mediaSent += 1; onSent(); }
          };
          /** TTS 关闭时连额度都不该扣；status 拿不到时保守当成开着 */
          let enabled = true;
          try {
            const st = await tts.status?.();
            enabled = !st || st.enabled !== false;
          } catch {}
          if (!enabled) { await sendAsText('语音合成没启用'); continue; }

          /**
           * `bucket` 决定用哪一档额度（主人那档更松，见 `quota` 的 `byBucket`）。
           * 以前不传，面板上「主人单独一套额度」配了也不生效——静默失效。
           */
          q = quota && typeof quota.charge === 'function'
            ? quota.charge(senderId
              ? { feature: 'voice', per: 'person', id: String(senderId), bucket }
              : { feature: 'voice', per: 'chat', id: String(target), bucket })
            : null;
          if (q && q.ok === false) { await sendAsText(`语音条额度用完（${q.message}）`); continue; }

          let audio;
          try {
            audio = await tts.synthesize(a.value);
          } catch (e) {
            await sendAsText(`语音没合成出来（${e?.message ?? e}）`);
            continue;
          }
          const buf = Buffer.from(audio?.audio ?? []);
          if (!buf.length) { await sendAsText('合成结果为空'); continue; }
          const ext = /\bwav\b/i.test(String(audio?.contentType ?? '')) ? '.wav' : '.mp3';
          const file = path.join(os.tmpdir(), `roost-say-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
          try {
            await writeFile(file, buf);
            sent = await ch.sendVoice({ scene, target, dataBase64: buf.toString('base64'), fileName: path.basename(file), msgId, receivedAt, eventId, isWakeup });
          } finally {
            await rm(file, { force: true }).catch(() => {});
          }
          /** 合成成功但 QQ 没发出去：退额度并改发文字，和其余失败分支同一口径 */
          if (sent && sent.ok === false) {
            await sendAsText(`语音没发出去（${sent?.message ?? '未知原因'}）`);
            continue;
          }
        } else if (a.type === 'say') {
          /**
           * 调用方没注入 TTS / 通道不支持语音时也不能闷声吞掉——那句话是用户真正要说的内容。
           * 生产宿主总会注入 tts，这条是给旧调用方与测试替身的兜底。
           */
          log('没有语音合成通道，这句改发文字');
          const rt = await ch.send({ scene, kind, target, text: a.value, msgId, receivedAt, eventId, isWakeup });
          if (rt?.ok) { mediaSent += 1; onSent(); }
          continue;
        }
        if (sent?.ok) { mediaSent += 1; onSent(); used(a); }
        else if (sent) log(`${a.type} 没发出去：${sent?.message ?? '未知原因'}`);
      } catch (e) {
        /** 语音没开 / 文件不存在 / 上传失败：和旧实现一样不打断这一轮 */
        log(`${a.type} 执行失败（已跳过）：${e?.message ?? e}`);
      }
    }

    /** 6. 撤回上一条（在正文之后，和旧 ai-chat 一致） */
    if (wantRetract && previous?.id && typeof ch.retract === 'function') {
      await ch.retract({ chatId: target, msgId: previous.id, kind: previous.kind || scene })
        .catch((e) => log(`撤回上一条失败：${e?.message ?? e}`));
    }

    /** 7. 用完即删素材（有这个能力才删；失败不影响这轮） */
    if (typeof ch.deleteImage === 'function') {
      for (const id of uploaded.filter(Boolean)) {
        await ch.deleteImage(id).catch(() => {});
      }
    }

    /** 文件失败不覆盖 `ok`（正文可能已发），单独用 `filesOk` 告诉调用方 */
    return filesOk ? { ...r, filesOk: true } : { ...r, filesOk: false, fileErrors };
  };
}
