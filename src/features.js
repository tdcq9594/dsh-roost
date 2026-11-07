/**
 * 功能开关清单：**哪些功能开着、关掉会发生什么、关了要让哪些工具消失**。
 *
 * 和 `capabilities.js` 的分工，一句话：
 *   · `capabilities` 管「**谁**能用」——同一批工具，主人能调、群友不能；
 *   · `features`   管「**有没有**这个功能」——关掉之后，所有人都没有。
 *
 * 两层叠起来才是完整答案：`deny = pool − (策略允许 ∩ 功能仍在)`。
 *
 * ## 为什么不统一存到 capabilities.json
 *
 * 这些开关本来就散在 `config.json` 里（`tts.enabled` / `stickers.enabled` …），
 * 设置页也在读写它们。再抄一份进能力策略，就是第二个真相：
 * 用户在设置页关了语音，能力页还显示开着，然后谁也说不清哪个算数。
 *
 * 所以规则是：
 *   · **config 里已有的布尔** → 直接读写 config，能力页只是另一个入口；
 *   · **config 里没有对应字段的**（目前只有「发文件」）→ 存 `capabilities.json`
 *     的 `features` 段，这是它唯一的家，不构成两份。
 *
 * ## 为什么「关掉功能」要顺带 deny 工具
 *
 * 有些功能关了之后工具还挂在池里，调用时才报错（`memory.enabled=false` 时
 * `memory_search` 返回「记忆功能关着」）。模型看不见这条限制，会先调一次、
 * 拿到失败、再换说法——白烧一轮，还容易对群友说“我查一下”然后没下文。
 * 直接把工具收走，它从一开始就知道没这回事。
 */

/** 空数组 = 不依赖别的功能 */
const NONE = [];

/**
 * 开关有三种形态，靠 `kind` 区分：
 *
 *   · `toggle`（默认）—— 开 / 关，写布尔；
 *   · `select` —— 从固定选项里挑一个（可带 `custom` 允许填自定义值）；
 *   · `number` —— 填一个数（目前两个实例：`queueMax` / `queueMinBudgetSec`）。
 *
 * `select` 的后端校验与前端渲染都已备好，但**当前没有实例**：账本保留期
 * 存在 **bot 的 config**，而能力页读写的是 dsh-roost 的 config，放这里会
 * 「面板显示永久、实际按 7 天删」。那个下拉在 roost 框架面板「数据 → 账本」页。
 * 以后真有属于本仓的下拉项，加一条定义即可，不用再改前端。
 *
 * 后两种**不参与 `on` 语义**：数值项里 `0` 可能是合法值
 * （`queueMax: 0` = 关掉排队），不是「关」。所以 `readFeatures()` 只算 toggle，
 * `readSettings()` 单独给它们取值。混在一起算会把合法值误读成开关状态。
 */
export function kindOf(f) {
  return f?.kind || 'toggle';
}

export const FEATURES = [
  {
    id: 'speakUp',
    label: '主动搭话',
    desc: '一阵子没聊，她在私聊里主动说句话',
    source: 'config',
    path: ['speakUp', 'enabled'],
    /** 总闸：关掉之后 `awake` 也不会再排期，所以它排第一 */
    requires: NONE,
    affects: NONE,
    offHint: '不再主动找你。你说话她照常回，只是不会自己开口。',
  },
  {
    id: 'awake',
    label: '先想想要不要开口',
    desc: '到点了不直接发，先判断值不值得说',
    source: 'config',
    path: ['awake', 'enabled'],
    /** 关掉会退回「到点就发一句」的老行为，所以主动搭话必须开着 */
    requires: ['speakUp'],
    affects: NONE,
    offHint: '退回定时器：到点就发，不再判断该不该说。群主动也会一起停。',
  },
  {
    id: 'memory',
    label: '三层记忆',
    desc: '记人、记约定、翻旧账',
    source: 'config',
    path: ['memory', 'enabled'],
    requires: NONE,
    affects: ['memory_search', 'memory_note'],
    offHint: '不再记新的事，也想不起旧的。已有记录**不会被删**，重新打开还在。',
  },
  {
    id: 'memoryTools',
    label: '让她自己翻记忆',
    desc: '给她两个工具，需要时自己去查/去记',
    source: 'config',
    path: ['memory', 'tools'],
    /** 记忆总开关关着时，这两个工具调了也是「功能关着」 */
    requires: ['memory'],
    affects: ['memory_search', 'memory_note'],
    offHint: '她不能再主动查，但每轮自动带上的那几条记忆照常。',
  },
  {
    id: 'chatTools',
    label: '让她自己翻聊天记录',
    desc: '给她一个工具，需要时按会话看最近聊了什么',
    source: 'config',
    path: ['chat', 'tools'],
    /**
     * **不依赖 `memory`**：翻的是账本/日记原文，不是记忆注入。
     * 记忆关着时她照样该知道「群里刚才在聊什么」——这是两件事。
     */
    requires: NONE,
    affects: ['chat_look'],
    offHint: '她不能再主动翻记录，只能看到当前这一轮的内容。记录本身不会被删。',
  },
  {
    id: 'crossChatInGroup',
    label: '在群里也能查别的群',
    desc: '打开后，主人在群里问「别的群刚才聊了啥」也能答',
    source: 'config',
    path: ['chat', 'crossChatInGroup'],
    /**
     * 不依赖 `chatTools`：工具关着时这个开关开着也没意义，但不必互相绑——
     * 绑了之后面板会出现「先开 A 才能开 B」的连锁提示，用户反而更困惑。
     */
    requires: NONE,
    /**
     * **affects 必须留空**（23:4x 独立复核抓到的 P0）。
     *
     * `forcedDenyTools()`（本文件 :341）遇到「开关 = false」就把 `affects`
     * 里的工具全部强制收走。这个开关默认 false，原先写 `affects:['chat_look']`
     * 的后果是：默认/老配置下 `chat_look` 对所有人（含主人）都被收掉，
     * 20:42 的 `chatLookForMembers` 开关、`chatTools` 功能、验收 2 全部静默失效。
     *
     * 同理，`crossChatInGroup` 是**放宽跨群权限**的开关，不是「关掉就没这工具」：
     * 关着时 `chat_look` 仍要能查当前会话，跨群的硬判定在 `tools.js` 的 execute。
     */
    affects: NONE,
    /**
     * 默认关。这句提示要写清代价：群里的回复所有人都看得见，
     * 打开等于允许「把 B 群的对话说给 A 群听」。
     */
    offHint: '跨群只在主人私聊里可用。打开后主人在群里也能查，但群友会看到那些内容。',
  },
  {
    id: 'chatLookForMembers',
    label: '群友也能翻聊天记录',
    desc: '打开后群友能用 chat_look 看当前会话；跨群和别人的私聊仍然一律拒绝',
    source: 'config',
    path: ['chat', 'chatLookForMembers'],
    /** 放宽权限类开关，缺省必须是关（见 readFeatures 的 `default:false` 支持） */
    default: false,
    requires: ['chatTools'],
    /**
     * **affects 必须留空**。这是「放宽权限」的开关，不是「关掉就收工具」的功能开关：
     * `forcedDenyTools()`（本文件 :314）遇到 `on[f.id] === false` 就会把 `affects`
     * 里的工具全部收走。默认 false 时若写了 `affects: ['chat_look']`，
     * 连主人自己的 chat_look 都会被收掉，而且页面上看不出为什么。
     * 真正的放权在 capabilities / GUEST_KEEP_TOOLS 两条路径里按 bucket 做。
     */
    affects: NONE,
    /**
     * 默认关。readFeatures() 对 toggle 的缺省值是 true（:273），
     * 所以「默认关」必须靠 config.js 里显式写 false，不能靠「没配」。
     */
    offHint: '默认关：只有主人能用 chat_look。打开后群友也能翻当前会话，但查别的群、查别人的私聊仍然一律拒绝。',
  },
  {
    id: 'queueMax',
    label: '同一会话最多排几条',
    desc: '她还在想上一条时，后面这几条排队等着；设 0 = 不排队，直接回「上一条还在想」',
    source: 'config',
    path: ['chat', 'queueMax'],
    /**
     * 非布尔项。默认 2：实测单轮中位 2–3 秒，第二条最多等几秒，
     * 成本远小于「连发三条丢两条」。
     *
     * `min: 0` 是特意留的——`turnqueue.js` 里 `maxPending <= 0`
     * 就是「全部拒绝入队」，正好等于关掉排队、回到旧行为。
     */
    kind: 'number',
    min: 0,
    max: 10,
    default: 2,
    requires: NONE,
    affects: NONE,
    offHint: '',
  },
  {
    id: 'queueMinBudgetSec',
    label: '排队至少留多少秒',
    desc: '轮到它时，剩余回话时间不足这么多秒就不跑了（说了也发不出去，白烧一次模型）',
    source: 'config',
    path: ['chat', 'queueMinBudgetSec'],
    kind: 'number',
    min: 5,
    max: 180,
    default: 30,
    requires: NONE,
    affects: NONE,
    offHint: '',
  },
  {
    id: 'closing',
    label: '对话收尾',
    desc: '聊完了会退场，并记下「下次从哪接」',
    source: 'config',
    path: ['closing', 'enabled'],
    requires: NONE,
    affects: NONE,
    offHint: '不再判断「聊完了」，也就没有「上次聊到哪儿」可以接。',
  },
  {
    id: 'qqTools',
    label: '分段说话 / 退场 / @人',
    desc: '把「说几句、什么时候停」交给她自己决定',
    source: 'config',
    path: ['qqTools', 'enabled'],
    requires: NONE,
    affects: ['qq_send', 'qq_close', 'qq_send_file'],
    offHint: '退回老行为：一整段发出去，不能分段、不能退场、不能 @ 人。',
  },
  {
    id: 'sendFile',
    label: '发文件',
    desc: '把工作区里的文件发到群里',
    /**
     * 唯一没有 config 字段的功能。
     *
     * 以前靠 `qqTools.enabled` 顺带管，但那和「分段说话」是两件事：
     * 有人想让她分段说、但不想让她发文件。所以单独一个开关，
     * 存在 `capabilities.json` 的 `features` 段——那是它唯一的家。
     */
    source: 'store',
    path: ['features', 'sendFile'],
    requires: NONE,
    affects: ['qq_send_file'],
    offHint: '不能发文件了，文字和语音不受影响。',
  },
  {
    id: 'stickers',
    label: '表情包',
    desc: '从图库里挑一张配着发',
    source: 'config',
    path: ['stickers', 'enabled'],
    requires: NONE,
    affects: ['sticker_pick'],
    offHint: '不再发表情包，`<<image:>>` 与 `<<image-alone:>>` 都不会再发图。',
  },
  {
    id: 'voice',
    label: '语音条',
    desc: '把一段话念出来发语音',
    source: 'config',
    path: ['tts', 'enabled'],
    requires: NONE,
    affects: NONE,
    offHint: '不再念语音，提示词里也不会教它写 `<<say:>>`（否则会漏出标记）。',
  },
  {
    id: 'compact',
    label: '上下文压缩',
    desc: '聊太长了自动换新会话，带摘要开场',
    source: 'config',
    path: ['compact', 'enabled'],
    requires: NONE,
    affects: NONE,
    offHint: '会话只增不减，越聊越慢，最后会撑爆上下文。**除非在排查问题，别关。**',
    risky: true,
  },
  {
    id: 'personaCommand',
    label: '聊天里切人格',
    desc: '用 `/persona 名字` 临时换一个（只对主人生效，重启失效）',
    source: 'config',
    path: ['persona', 'command', 'enabled'],
    requires: NONE,
    affects: NONE,
    offHint: '只能在面板上换人格，聊天里换不了。',
  },
];

/** id → 定义。查不到返回 undefined 而不是抛错：调用方常来自面板参数 */
export function featureDef(id) {
  return FEATURES.find((f) => f.id === id);
}

/** 按 `path` 从对象里取值，任一层缺失返回 undefined */
function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * 功能当下的开关状态。
 *
 * `requires` 的连带：依赖项关着时，本项**显示为关**。
 * 这不是「帮你改配置」，只是别在界面上显示一个开着却什么也不做的开关。
 *
 * 默认值取「配置里是 `false` 才算关」：`tts.enabled` 可能压根没写过，
 * 那时 `undefined` 要当作可用的（不然老配置升级后全是关）。
 * 但 `speakUp` 这类默认就是 false 的，`DEFAULTS` 里写着 false，读出来也是 false，没问题。
 *
 * **例外**：`default: false` 的开关（放宽权限类）在配置里没写过时也按关算。
 * 只影响声明了该字段的项，其余 toggle 的历史缺省 true 不变。这样即使调用方
 * 传的是没经过 `loadConfig()` 补默认值的裸 cfg，面板也不会显示「开着却没生效」。
 */
/**
 * toggle 的「关」判据。配置可能来自手改的 JSON，写成字符串 `"false"` 时
 * 旧口径会判成开（面板显示开着、实际却收走了工具），所以字符串也要认。
 * 只服务布尔项：`pick()` 还被 `readSettings()` 和非布尔项复用，不动它。
 */
const isOff = (v) => v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false');

export function readFeatures(cfg = {}, store = {}) {
  const out = {};
  for (const f of FEATURES) {
    if (kindOf(f) !== 'toggle') continue;
    const raw = f.source === 'store' ? pick(store, f.path) : pick(cfg, f.path);
    out[f.id] = isOff(raw) ? false : (raw === undefined ? f.default !== false : true);
  }
  // 依赖项关着 → 本项也失效（只影响返回值，不改配置）
  for (const f of FEATURES) {
    if (!f.requires?.length) continue;
    if (f.requires.some((r) => out[r] === false)) out[f.id] = false;
  }
  return out;
}

/** 只有这一项自己的值，不含依赖连带。面板上判断「用户到底配了什么」用 */
export function rawFeature(cfg = {}, store = {}, id) {
  const f = featureDef(id);
  if (!f) return undefined;
  const raw = f.source === 'store' ? pick(store, f.path) : pick(cfg, f.path);
  if (kindOf(f) !== 'toggle') return raw === undefined ? f.default : raw;
  return isOff(raw) ? false : (raw === undefined ? f.default !== false : true);
}

/**
 * 非布尔项的当前值（面板渲染用）。
 *
 * 缺省取 `f.default`，而不是 `undefined`——面板上出现一个空下拉，
 * 用户不知道「没配」和「配成空」的区别。
 */
export function readSettings(cfg = {}, store = {}) {
  const out = {};
  for (const f of FEATURES) {
    if (kindOf(f) === 'toggle') continue;
    const raw = f.source === 'store' ? pick(store, f.path) : pick(cfg, f.path);
    out[f.id] = raw === undefined ? f.default : raw;
  }
  return out;
}

/**
 * 功能关着时应该从工具池里收走的名字。
 *
 * 返回的是 `pool` 的子集——和 `capabilities` 那条铁律一致：
 * **永远不返回池子里没有的名字**，否则 `tools.restrict` 整批拒绝。
 */
export function forcedDenyTools(cfg = {}, store = {}, pool) {
  const on = readFeatures(cfg, store);
  /**
   * 不传 pool = 「只要名字，不要过滤」。
   *
   * 旧逻辑那条路上拿不到工具清单（只有 `t.restrict` 和几个平面 helper），
   * 但它自己会用 `planDenyTools` 按实际挂载再过滤一遍，所以这里给全集更合适——
   * 多给几个不存在名字的代价是被过滤掉，少给一个就是功能关不掉。
   */
  const poolSet = Array.isArray(pool) && pool.length ? new Set(pool) : null;
  const deny = new Set();
  for (const f of FEATURES) {
    if (on[f.id] !== false) continue;
    for (const n of f.affects || []) if (!poolSet || poolSet.has(n)) deny.add(n);
  }
  return [...deny];
}

/**
 * 打开/关闭某一项要写什么。
 *
 * 返回 `{ config: {...} }` 或 `{ store: {...} }`，由调用方决定写到哪。
 * 不直接写盘：这个模块保持纯函数，好测，也不会在导入时产生副作用。
 */
export function patchForFeature(id, value) {
  const f = featureDef(id);
  if (!f) return null;
  const build = (path, v) => (path.length === 1 ? { [path[0]]: v } : { [path[0]]: build(path.slice(1), v) });

  /**
   * 非布尔项：值直接写进去，但要**先夹紧/校验**。
   *
   * 这些值会被当成数用（`retentionDays` 直接进 SQL 的 cutoff 计算），
   * 放一个 `'abc'` 或负数进去不会报错，只会让保留策略静默失效——
   * 所以校验放在这里，而不是指望面板永远传对。
   */
  if (kindOf(f) !== 'toggle') {
    const v = normalizeSetting(f, value);
    if (v === null) return null;
    return { config: build(f.path, v), value: v };
  }

  const on = value !== false;
  if (f.source === 'store') {
    return { store: { features: { [id]: on } } };
  }
  /** 把 `['memory','enabled']` 折成 `{ memory: { enabled: true } }` */
  return { config: build(f.path, on) };
}

/**
 * 把面板传来的值夹成合法值；不合法返回 `null`（调用方回 400）。
 *
 * `select` 认三种：选项里的值、`custom` 允许的任意正整数、以及 `0`（如果选项里有）。
 * `number` 认闭区间 `[min, max]`，非整数一律拒——半天的保留期没有意义。
 */
export function normalizeSetting(f, value) {
  const kind = kindOf(f);

  /**
   * **空值必须先挡在这里，不能交给 `Number()`。**
   *
   * `Number('') === 0`、`Number(null) === 0`、`Number('  ') === 0`、
   * `Number(false) === 0`、`Number([]) === 0`——而 `queueMax.min` 恰好是 0
   * （0 = 关掉排队，合法值）。结果：用户把能力页的数字输入框**清空后失焦**，
   * 后端会高高兴兴写进 `chat.queueMax: 0`，回一句「已保存」，
   * 排队被静默关掉，界面上还显示旧值。
   *
   * 这类 bug 不报错、不进日志，只能靠显式挡。面板的 onBlur 也挡一层，
   * 但服务端不能指望前端永远传对（配置还能手改、还能从 API 调）。
   */
  if (
    value === '' || value === null || value === undefined ||
    typeof value === 'boolean' || Array.isArray(value) ||
    (typeof value === 'string' && value.trim() === '')
  ) return null;

  const n = Number(value);
  if (kind === 'number') {
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    const min = Number.isFinite(f.min) ? f.min : 0;
    const max = Number.isFinite(f.max) ? f.max : Number.MAX_SAFE_INTEGER;
    return n < min || n > max ? null : n;
  }
  if (kind === 'select') {
    const opts = (f.options || []).map((o) => Number(o.value));
    if (opts.includes(n)) return n;
    if (f.custom) {
      const min = Number.isFinite(f.min) ? f.min : 1;
      const max = Number.isFinite(f.max) ? f.max : 36500;
      return Number.isInteger(n) && n >= min && n <= max ? n : null;
    }
    return null;
  }
  return null;
}

/**
 * 想开这一项，但前置条件不满足。
 *
 * 目前只有一条：依赖项关着。返回一句人话，面板直接显示，
 * 比把按钮禁掉却不说原因要好——用户会以为是坏了。
 */
export function cannotEnable(cfg = {}, store = {}, id) {
  const f = featureDef(id);
  if (!f) return '没有这个开关';
  /** 非布尔项没有「能不能开」这回事，永远不拦 */
  if (kindOf(f) !== 'toggle') return '';
  const on = readFeatures(cfg, store);
  for (const r of f.requires || []) {
    if (on[r] === false) {
      const rd = featureDef(r);
      return `要先打开「${rd?.label || r}」`;
    }
  }
  return '';
}

/** 面板分组：按「她主动做什么 / 她怎么表达 / 她记不记得住」分，不按代码模块分 */
export const FEATURE_GROUPS = [
  { id: 'talk', label: '怎么说话', ids: ['qqTools', 'stickers', 'voice'] },
  { id: 'memory', label: '记不记得', ids: ['memory', 'memoryTools', 'chatTools', 'crossChatInGroup', 'chatLookForMembers', 'closing', 'compact'] },
  { id: 'queue', label: '消息来不及回的时候', ids: ['queueMax', 'queueMinBudgetSec'] },
  { id: 'proactive', label: '会不会主动找你', ids: ['speakUp', 'awake'] },
  { id: 'work', label: '干不干活', ids: ['sendFile', 'personaCommand'] },
];
