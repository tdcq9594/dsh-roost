/**
 * 能力策略：**谁、在哪个群、能调哪些工具**。
 *
 * 设计文档见 `docs/能力页方案.md`。这里只放纯逻辑，不碰 DSH 上下文——
 * 原因和 `permissions.js` 一样：`tools.restrict()` 会校验名字，
 * 只要有一个不存在就**整批拒绝**（0.10.10 踩过，白名单从来没生效过）。
 * 所以这个模块的铁律是：
 *
 *   **任何 allow / deny 都必须先和 pool 求交，绝不直接把配置里的数组丢给 restrict。**
 *
 * pool 来自 `tools.schemas()`（本轮真实挂着的工具），allow 来自配置。
 * 两者相减才得到要收走的名单。
 */

/**
 * 身份档位，**对齐框架的 0/1/2/3 等级**（`bot/src/levels.js` 的 `CORE`）。
 *
 * 框架里 `0 主人 / 1 管理员 / 2 群管 / 3 助手`，`9999` 是「从没配过权限的人」。
 * 之前这里只有 owner/admin/member 三档，把**群管和助手一起折进了群成员**——
 * 主人特意给某人配了 3 级，到 QQ 这边跟路人拿同一套工具，等于没配。
 *
 * `unknown` 不在框架等级里，它是 `bucketOf()` 拿不到权限信息时的兜底，
 * 排在最末、页面上不可配（见 `docs/能力页方案.md` 第五节）。
 */
export const BUCKETS = ['owner', 'admin', 'manager', 'helper', 'member', 'unknown'];

/**
 * 从高到低。**权限高的档继承所有更低的档**（栈式），见 `accumulateAllow()`。
 *
 * 为什么必须继承：六档各自独立的话，用户给「管理员」加一个工具，
 * 群管、助手、群成员三档都得再改一遍，改漏一处就是「同一个人换个身份
 * 反而少了个功能」这种没人查得出来的 bug。
 */
export const BUCKET_ORDER = ['owner', 'admin', 'manager', 'helper', 'member', 'unknown'];

/** 面板上可配的那几档。`unknown` 是兜底，写死不可改——那是最后一道闸。 */
export const EDITABLE_BUCKETS = ['owner', 'admin', 'manager', 'helper', 'member'];

/**
 * 硬钉：**任何档位、任何配置都收不走**。
 *
 * 只有两个，判据是「没了它，机器人就完全说不出话」：
 *   · `qq_send`  —— 唯一的发言出口
 *   · `qq_close` —— 主动收尾，没了它每轮都被迫憋一句，读起来很怪
 *
 * 注意 `qq_send_file` **不在**这里——关了它还能发文字，只是不能发文件，
 * 那是合理配置。它属于「危险动作」，归 danger 名单管。
 *
 * ## 为什么把 `memory_*` / `sticker_pick` / `roost_skill` 从这里删掉
 *
 * 它们原来也在这张表里，后果是**档位的 `deny` 永远无效**：
 * `resolvePolicy` 先算档位白名单、再无条件把钉住项加回来，
 * 于是「不让助手翻记忆」这种配法写进去也不生效，页面上看不出任何区别。
 *
 * 真正的判据应该是「用户能不能明确不要它」：
 *   · 忘了记忆 → 它还能正常聊天，只是不记得你。**这是用户的选择，要尊重。**
 *   · 不发表情 → 只影响语气。
 *   · 不能用技能 → 只少一类动作。
 *
 * 想全局关记忆请用「功能」页的开关（`features.js` 的 `memoryTools`），
 * 那是「所有人都不给」；档位的 `deny` 是「这一档不给」。两者分工不同。
 */
export const PINNED_KEEP = ['qq_send', 'qq_close'];

/**
 * 建议保留：默认值里都给了，但**用户明确 `deny` 就让它生效**。
 *
 * 这张表只用于面板上标一个「🔒 建议」，不参与解析。
 */
export const PINNED_SOFT = ['memory_search', 'memory_note', 'sticker_pick', 'roost_skill'];

/**
 * 不许开：DSH 原生的 `skill` 工具和我们自管的技能目录会打架
 * （见 `docs/能力页方案.md` 第八节）。只有 `skills.mode === 'self'` 时才拦。
 */
export const PINNED_DENY_SELF_SKILLS = ['skill'];

/**
 * 「只能聊天」这一档的工具集：群覆盖里选了 `chatOnly` 就用它，**不看默认档位**。
 *
 * 为什么不复用 `defaults.member`：那个是可以被用户改成「全权」的。
 * 「这个群只能聊天」必须是一个**不随全局配置漂移**的硬承诺，
 * 否则用户改了群成员档，回头发现公开群也跟着开了。
 */
export const CHAT_ONLY = [
  'memory_search',
  'memory_note',
  'qq_send',
  'qq_close',
  'sticker_pick',
  'roost_skill',
];

/** 默认标签：面板上给人看的名字，解析时不用。 */
export const BUCKET_LABELS = {
  owner: '主人',
  admin: '管理员',
  manager: '群管',
  helper: '助手',
  member: '群成员',
  unknown: '身份不明',
};

/** 框架等级 ↔ 档位。`9999`（NO_PERM）和任何认不出的数字都是 member。 */
export const LEVEL_TO_BUCKET = {
  0: 'owner',
  1: 'admin',
  2: 'manager',
  3: 'helper',
};

/**
 * 默认策略。
 *
 * `allow: ['*']` 表示「pool 里全部」，展开时会被 PINNED_DENY 和 `newTools` 再削一次。
 * 其余档位是白名单——**没写 = 不给**（fail-closed）。
 */
export function defaultStore() {
  return {
    version: 1,
    /** `owner-only`：新工具默认给主人（`*` 直接包含）；`nobody`：`*` 只包含「见过的」工具 */
    newTools: 'owner-only',
    /**
     * 档位默认值。**写了 `allow` 就是完整白名单，没写就继承所有更低的档**
     * （见 `accumulateAllow()`）。
     *
     * 所以 `manager` / `helper` 故意不写：它们默认等于「群成员的权限」，
     * 要加东西就自己在面板上加。**默认一律保守**——群管、助手也是别人，
     * 不能因为「他有个头衔」就默认给他读文件的能力。
     *
     * `deny` 是可选的：低权限能用的东西，这一档反而不给（比如「助手」是外部
     * 临时人员，不该看记忆）。它作用于累积后的结果，所以会盖住低档的 allow。
     */
    defaults: {
      owner: { allow: ['*'] },
      admin: { allow: ['memory_search', 'memory_note', 'qq_send', 'sticker_pick'] },
      manager: {},
      helper: {},
      member: { allow: ['memory_search', 'qq_send', 'sticker_pick'] },
      unknown: { allow: ['qq_send'] },
    },
    /** 分组只用于展示与批量开关；解析时按 match 展开成工具名 */
    groups: {
      github: { match: ['gh_*', 'pr_*', 'issue_*', 'review_*'], label: 'GitHub' },
      ops: { match: ['ops_*'], label: '运维' },
      files: { match: ['edit', 'read', 'write', 'read_image', 'working_directory'], label: '文件' },
      mcp: { match: ['mcp__*'], label: 'MCP' },
    },
    /** 群覆盖：只存例外。键优先用绑定的群号，拿不到才用 group_openid */
    chats: {},
    skills: {
      mode: 'self',
      /** 技能和工具一样按栈继承：没写的档跟着更低的档走 */
      defaults: { owner: ['*'], admin: [], manager: [], helper: [], member: [], unknown: [] },
      chats: {},
    },
    /** 危险动作：只用于 UI 标红 + 二次确认，不参与解析 */
    danger: ['edit', 'write', 'pwsh', 'ops_bash', 'qq_send_file', 'mcp__*__*_exec', 'mcp__*__*_edit'],
    /** 上次看到的 pool，用来算「新增 / 失效」 */
    seen: { tools: {}, skills: {}, lastScan: 0 },
  };
}

/**
 * 通配匹配：`*` 匹配任意字符（含 `_`），其余按字面。
 *
 * 明确这一点是因为 `mcp__*__*_exec` 这种模式：如果 `*` 不跨 `_`，
 * 它连 `mcp__graphflow__gf_exec` 都匹配不上——那就是个永远不生效的规则。
 * 这里刻意选「跨」的语义，和 URL 通配的直觉一致。
 */
export function matchPattern(name, pattern) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('[\\s\\S]*') + '$');
  return re.test(name);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 allow 里的一项展开成工具名数组。
 *
 * 支持三种写法：
 *   - `*`            → pool 里全部（再按 pinned / newTools 削）
 *   - `group:xxx`    → 按 groups 表里的 match 展开，组名不存在则记 warn
 *   - 具体工具名      → 原样返回（是否存在于 pool 由调用方判，进 removed）
 */
export function expandAllow(list, pool, groups = {}) {
  const out = new Set();
  const warnings = [];
  const unknown = [];

  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string' || !item) continue;

    if (item === '*') {
      for (const n of pool) out.add(n);
      continue;
    }

    if (item.startsWith('group:')) {
      const key = item.slice('group:'.length);
      const g = groups[key];
      if (!g || !Array.isArray(g.match)) {
        warnings.push(`分组「${key}」不存在`);
        continue;
      }
      for (const n of pool) {
        if (g.match.some((p) => matchPattern(n, p))) out.add(n);
      }
      continue;
    }

    // 具体名字：先记下，最后由 resolvePolicy 用 pool 判断是否失效
    out.add(item);
    unknown.push(item);
  }

  return { allow: out, warnings, unknown };
}

/**
 * 算一份策略。
 *
 * @param {object} o
 * @param {string[]} o.pool      本轮 `tools.schemas()` 的工具名
 * @param {string}   o.bucket    owner / admin / member / unknown
 * @param {string}   [o.chatId]  群 openid 或绑定的群号；私聊传空
 * @param {object}   o.store     capabilities.json 的内容
 * @param {string[]} [o.personaTools] 人格里允许的工具（只能是收窄）
 * @returns {{ok:true, allow:string[], deny:string[], pinned:string[], removed:string[], warnings:string[], isNew:string[]}
 *          |{ok:false, reason:string}}
 */
/**
 * @param {object} o
 * @param {string[]} [o.forceDeny] 上层强制收走的工具（功能关掉的那种）。
 *   **优先级最高**，连钉住项都拦不住——因为「这个功能整个关了」比
 *   「这一档不许用」更根本。计算方式见 `features.js` 的 `forcedDenyTools()`。
 */
/**
 * 把某一档的 `allow` 累加成实际白名单：**这一档 + 所有更低的档**。
 *
 * 五档（主人 / 管理员 / 群管 / 助手 / 群成员）如果各自独立配，用户给管理员加一个
 * 工具就得在四档里各改一遍，改漏一处就是「同一个人换个身份反而少个功能」——
 * 这种 bug 没人查得出来。所以高档自动包含低档。
 *
 * ## `allow` 是「增量」，不是「完整清单」
 *
 * `admin: { allow: ['memory_note'] }` 的意思是「管理员比下一档多一个 memory_note」，
 * 不是在说「管理员只有 memory_note」。这条约定让存量数据**不需要迁移**：
 * 老文件里那些「看起来是完整清单」的数组（member 三项、admin 四项）当增量用，
 * 结果和以前完全一样，因为它们的值本来就已经包含了低档的内容。
 *
 * ## 「没写 allow」和「`allow: []`」是两件事
 *
 *   · 没有这个字段 → **继承**更低的档（群管 / 助手的默认形态）
 *   · `allow: []`   → **这一档清零**，到此为止，不再往下继承
 *
 * 这两种形态必须区分，`normalizeStore()` 也是按这个语义保留值的。
 * 2026-11-05 之前这里把空数组也当成「没写」，导致面板上给继承档取消一个工具
 * 写进去的 `allow: []` 完全不起作用——勾选框变空，实际权限一点没变。
 *
 * ## `deny` 是例外，作用于累积结果
 *
 * 低权限能用的东西，这一档反而不给（比如「助手」是外部临时人员，不该翻记忆）。
 * 它会盖住低档的 `allow`，所以「群成员能给、助手不能给」是写得出来的。
 *
 * @returns {{allow: string[], deny: string[], from: string[]}}
 *   `from` 是参与累加的档位名，面板上用来解释「这个工具是跟着谁来的」。
 */
export function accumulateAllow(store, bucket) {
  const idx = BUCKET_ORDER.indexOf(bucket);
  if (idx < 0) return { allow: [], deny: [], from: [] };

  const allow = [];
  const deny = [];
  const from = [];

  // 只往**下**走：不碰比当前档更高的档，否则「主人 * 全给」会漏到所有人身上
  for (const b of BUCKET_ORDER.slice(idx)) {
    const d = store?.defaults?.[b];
    /**
     * `deny` 要在 `allow` 判断**之前**收。
     *
     * `helper: { deny: ['memory_search'] }` 这种「跟随低档、但去掉一个」的写法里
     * 没有 `allow` 字段——把 deny 收在 `continue` 之后就会让它彻底失效，
     * 而这正是文档里承诺支持的用法。
     */
    if (Array.isArray(d?.deny) && d.deny.length) deny.push(...d.deny);
    if (!Array.isArray(d?.allow)) continue;
    /** 显式空数组 = 这一档什么都不给，继承链在这里断掉（见上面那段注释） */
    if (!d.allow.length) break;
    allow.push(...d.allow);
    from.push(b);
  }

  return { allow, deny, from };
}

export function resolvePolicy({ pool, bucket, chatId = '', store, personaTools, forceDeny = [], forceAllow = [] }) {
  if (!Array.isArray(pool)) return { ok: false, reason: 'pool 不是数组' };
  if (!pool.length) return { ok: false, reason: 'DSH 报不出工具清单（schemas 是空的）' };

  const S = normalizeStore(store);
  const bk = BUCKETS.includes(bucket) ? bucket : 'unknown';
  const warnings = [];

  const poolSet = new Set(pool);

  // ① 档位基线：**累加**这一档和所有更低的档（见 accumulateAllow）
  const acc = accumulateAllow(S, bk);
  const rawAllow = acc.deny.length
    ? acc.allow.filter((n) => !acc.deny.some((p) => matchPattern(n, p)))
    : acc.allow;
  const exp = expandAllow(rawAllow, pool, S.groups);
  let allow = exp.allow;
  warnings.push(...exp.warnings);
  const unknown = exp.unknown;

  // ② `newTools: 'nobody'` —— `*` 只包含「上次已经见过」的工具，
  //    新装的插件不会因为 `*` 自动拿到权限。
  //    这是「`*` 与 newTools 不可共存」那个矛盾的解法：不靠 `*` 表达排除，靠展开时收窄。
  if (S.newTools === 'nobody' && rawAllow.includes('*')) {
    const seen = S.seen?.tools || {};
    allow = new Set([...allow].filter((n) => Object.hasOwn(seen, n)));
    warnings.push('newTools=nobody：未见过的新工具不会自动给这一档');
  }

  /**
   * ②.5 运行期放宽（能力页「群友也能翻聊天记录」）。
   *
   * 只补**档位白名单**这一层，不碰更硬的边界：后面的 `chatOnly` 硬承诺、
   * 人格 `tools` 收窄、群级 `deny`、⑤.5 功能开关强制收走都能盖过它。
   * 调用方负责只给非 owner 档传值（主人档本来就是 `*`）。
   * 名字先和 pool 求交——`tools.restrict` 不认识的名字会让整批拒绝。
   */
  const extraAllow = (Array.isArray(forceAllow) ? forceAllow : []).filter((n) => poolSet.has(n));
  for (const n of extraAllow) allow.add(n);

  // ③ 群覆盖（增量，deny 优先）
  const chat = chatId ? S.chats?.[chatId] : null;
  /**
   * 「只能聊天」对**主人无效**。
   *
   * 这条硬承诺的目的是「别让群成员在公开群里用工具」，它要防的是
   * `defaults.member` 被改成全权之后连带放开，而不是防主人自己。
   * 主人是这个装置的配置者，他在这个群里也调不了工具、只能私聊才能干活，
   * 属于莫名其妙——而且他会以为自己配错了。
   */
  if (chat?.chatOnly && bk !== 'owner') {
    // 硬承诺：不看默认档位，只给聊天必需的那几个
    allow = new Set(CHAT_ONLY.filter((n) => poolSet.has(n)));
    warnings.push('这个群设成了「只能聊天」，默认档位对它无效');
  } else if (chat && !chat.chatOnly) {
    const add = expandAllow(chat.allowAdd, pool, S.groups);
    warnings.push(...add.warnings);
    unknown.push(...add.unknown);
    for (const n of add.allow) allow.add(n);
    /**
     * 群级 `deny` 也走通配匹配，和 `allowAdd` 对齐。
     *
     * 以前这里是 `allow.delete(n)`，只认字面名——用户写 `gh_*` 想把这个群的
     * GitHub 工具全禁掉，结果一个都没禁。而 `allowAdd` 支持分组和通配，
     * 一个支持一个不支持，是最容易让人以为「配置没生效」的那种不对称。
     */
    const denyList = (Array.isArray(chat.deny) ? chat.deny : []).filter((x) => typeof x === 'string' && x);
    if (denyList.length) {
      allow = new Set([...allow].filter((n) => !denyList.some((p) => matchPattern(n, p))));
    }
  }

  // ④ 与人格求交：人格只能收窄。
  /**
   * `personaTools` 的三种取值，语义完全不同，**空数组不是「没声明」**：
   *
   *   · `null` / 不是数组 → 这张卡没写 `tools`，不参与（保持旧行为）
   *   · `[]`             → 这张卡写了 `tools: []`，意思是**一个工具都不许用**
   *   · `[a, b]`         → 只能用这些（支持 `memory_*` 这种通配）
   *
   * 2026-11-05 之前这里写的是 `personaTools.length`，于是 `[]` 和 `null`
   * 走了同一条路：**人格明确写「不许用工具」，结果它拿到了整档默认权限**。
   * 主人档是 `*`，那就是全放开。`personaToolsFor()` 用 `[]` 表达全禁，
   * `planPersonaTools()` 也是这么读的——只有这里读错了。
   */
  if (Array.isArray(personaTools)) {
    const keep = new Set();
    for (const p of personaTools) {
      for (const n of pool) if (matchPattern(n, p)) keep.add(n);
    }
    allow = new Set([...allow].filter((n) => keep.has(n)));
  }

  // ⑤ 钉住项
  const pinnedKeep = PINNED_KEEP.filter((n) => poolSet.has(n));
  for (const n of pinnedKeep) allow.add(n);

  const pinnedDeny = [];
  if (S.skills?.mode === 'self') {
    for (const n of PINNED_DENY_SELF_SKILLS) if (poolSet.has(n)) pinnedDeny.push(n);
  }
  for (const n of pinnedDeny) allow.delete(n);

  /**
   * ⑤.5 功能关闭 → 强制收走。
   *
   * 必须排在钉住项**之后**：`PINNED_KEEP` 会把 `qq_send` 之类加回来，
   * 而「分段发言」关了的时候它本来就该消失。顺序反了就是功能开关失灵，
   * 且看不出来（页面上关着，工具还在）。
   */
  const forced = (Array.isArray(forceDeny) ? forceDeny : []).filter((n) => poolSet.has(n));
  for (const n of forced) allow.delete(n);

  // ⑥ 只保留 pool 里真有的名字；其余记为「失效」，不参与 restrict
  const removed = [...new Set([...unknown, ...[...allow].filter((n) => !poolSet.has(n))])].filter(
    (n) => !poolSet.has(n),
  );
  const finalAllow = [...allow].filter((n) => poolSet.has(n));

  // ⑦ 差集。deny 必须全部来自 pool —— 这条是这个模块存在的理由
  const allowSet = new Set(finalAllow);
  const deny = pool.filter((n) => !allowSet.has(n));

  // ⑧ 「本轮新给出去的工具」：池里有、但上次没见过、且这轮给了
  const seenAt = S.seen?.tools || {};
  const isNew = finalAllow.filter((n) => !Object.hasOwn(seenAt, n));

  return { ok: true, allow: finalAllow.sort(), deny, pinned: pinnedKeep.sort(), removed, warnings, isNew, forced: forced.sort(), inheritedFrom: acc.from };
}

/**
 * 对比 pool 快照。
 *
 * `seen` 缺失（老用户第一次升级）时**不能**把所有工具当成「新增」，
 * 否则一升级就弹「新增 34 个能力」。所以 calling code 要传 `initialized`。
 */
export function diffSeen(seenTools = {}, pool = []) {
  const prev = seenTools && typeof seenTools === 'object' ? seenTools : {};
  const poolSet = new Set(pool);
  const added = pool.filter((n) => !Object.hasOwn(prev, n));
  const gone = Object.keys(prev).filter((n) => !poolSet.has(n));
  const initialized = Object.keys(prev).length > 0;
  return { added, gone, initialized };
}

/** 更新快照：新增记时间戳，已有的保留首次见到的时间。 */
export function touchSeen(seenTools = {}, pool = [], now = Date.now()) {
  const next = { ...(seenTools && typeof seenTools === 'object' ? seenTools : {}) };
  for (const n of pool) if (!Object.hasOwn(next, n)) next[n] = now;
  return next;
}

/**
 * 容错读：坏 JSON / 缺字段都退回默认值，**不抛**。
 * 策略文件是用户可手改的，写坏了不能让机器人起不来。
 */
export function normalizeStore(raw) {
  const D = defaultStore();
  if (!raw || typeof raw !== 'object') return D;

  const out = { ...D, ...raw };
  /**
   * 每档只保留**真的写了的**字段。
   *
   * 关键在第 2 行「不写 `allow` 就留空对象」：`accumulateAllow()` 靠
   * 「`allow` 不是数组」判断这一档要不要继承下一档。如果这里给个
   * `allow: []`，语义就变成「这一档什么都不给」，继承会被无声地关掉——
   * 而界面上看不出任何区别。
   *
   * 老文件没有 `manager` / `helper` 两档，这里自然得到空对象，
   * 于是它们继承「群成员」——不需要迁移代码。
   */
  out.defaults = {};
  for (const b of BUCKETS) {
    const v = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults[b] : null;
    const d = D.defaults[b] || {};
    const one = {};
    /**
     * 三种情况要**分清**，混掉任何一对都会出大事：
     *
     *   · `allow: []`        → 这一档什么都不给（用户故意的）
     *   · 没有 `allow` 字段   → 继承更低的档（manager / helper 的默认形态）
     *   · `allow` 是**坏的**  → 退回默认值
     *
     * 第三条是这里最关键的一行：`{defaults:'nope'}` 这种坏文件下，
     * 若不退回默认值，`owner` 会变成空对象 → 继承低档 → **主人丢掉 `*`**，
     * 全权配置静默失效，而界面上只显示「主人不能用什么」。
     */
    if (Array.isArray(v?.allow)) one.allow = v.allow;
    else if (Array.isArray(d.allow)) one.allow = d.allow;
    // 两边都没有 → 不设 allow，靠 accumulateAllow 继承低档
    if (Array.isArray(v?.deny) && v.deny.length) one.deny = v.deny;
    out.defaults[b] = one;
  }
  out.groups = raw.groups && typeof raw.groups === 'object' ? { ...D.groups, ...raw.groups } : D.groups;
  out.chats = raw.chats && typeof raw.chats === 'object' ? raw.chats : {};
  out.skills = { ...D.skills, ...(raw.skills && typeof raw.skills === 'object' ? raw.skills : {}) };
  out.danger = Array.isArray(raw.danger) ? raw.danger : D.danger;
  out.seen = {
    tools: raw.seen?.tools && typeof raw.seen.tools === 'object' ? raw.seen.tools : {},
    skills: raw.seen?.skills && typeof raw.seen.skills === 'object' ? raw.seen.skills : {},
    lastScan: Number.isFinite(raw.seen?.lastScan) ? raw.seen.lastScan : 0,
  };
  out.newTools = raw.newTools === 'nobody' ? 'nobody' : 'owner-only';
  /**
   * 功能开关里**没有 config 字段**的那几个（目前只有发文件）。
   *
   * 只留布尔值：`readFeatures` 的判据是 `=== false`，混进字符串或对象
   * 会让它当成「开」，而写进去的人以为是「关」。
   */
  out.features = raw.features && typeof raw.features === 'object' && !Array.isArray(raw.features)
    ? Object.fromEntries(Object.entries(raw.features).filter(([, v]) => typeof v === 'boolean'))
    : {};
  return out;
}

/** 某工具是不是危险动作（给 UI 标红用）。命中就返回命中的模式，方便说明「因为它是 mcp__*__*_exec」。 */
export function dangerOf(name, store) {
  const list = normalizeStore(store).danger;
  for (const p of list) if (matchPattern(name, p)) return p;
  return '';
}
