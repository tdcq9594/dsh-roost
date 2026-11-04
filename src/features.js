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
    offHint: '不再发表情包，`<<image:>>` 标记也不再生效。',
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
 */
export function readFeatures(cfg = {}, store = {}) {
  const out = {};
  for (const f of FEATURES) {
    const raw = f.source === 'store' ? pick(store, f.path) : pick(cfg, f.path);
    out[f.id] = raw === false ? false : true;
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
  return raw === false ? false : true;
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
  const on = value !== false;
  if (f.source === 'store') {
    return { store: { features: { [id]: on } } };
  }
  /** 把 `['memory','enabled']` 折成 `{ memory: { enabled: true } }` */
  const build = (path, v) => (path.length === 1 ? { [path[0]]: v } : { [path[0]]: build(path.slice(1), v) });
  return { config: build(f.path, on) };
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
  { id: 'memory', label: '记不记得', ids: ['memory', 'memoryTools', 'closing', 'compact'] },
  { id: 'proactive', label: '会不会主动找你', ids: ['speakUp', 'awake'] },
  { id: 'work', label: '干不干活', ids: ['sendFile', 'personaCommand'] },
];
