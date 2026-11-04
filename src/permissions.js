/**
 * 权限：这一句话是谁说的、他能让 AI 干到什么程度。
 *
 * 为什么需要：群聊里给 AI 挂了 shell 和文件工具，但**说话的人不一定是主人**。
 * 路人一句「帮我删掉 ~/Documents」跟主人说同样的话，不该一个待遇。
 *
 * 分两层：
 *   1. **告诉 AI**：这一轮是谁在说话、什么权限。模型自己就会拒绝过分的要求
 *   2. **硬限制**：按档位收走工具。模型被绕过时这层还在
 *
 * 兜底原则：**认不出来就当最低档**。缺字段、字段是脏的、框架改了名字——
 * 一律 `unknown`，只给聊天能力。宁可少给，不可多给。
 */

/**
 * 档位，从高到低。**对齐框架的等级空间**（`bot/src/levels.js`）：
 *
 *   0 主人 / 1 管理员 / 2 群管 / 3 助手 / 9999 无权限（= member）
 *
 * 2026-11-05 之前这里只有 owner/admin/member 三档，把群管和助手一起
 * 折进了 member。后果是主人特意配了 3 级的人，到 QQ 这边跟路人拿同一套工具。
 *
 * `unknown` 是「拿不到权限信息」的兜底，不在这个列表里——
 * 它由 `bucketOf()` 返回，永远按最严处理。
 */
export const BUCKETS = ['owner', 'admin', 'manager', 'helper', 'member'];

/**
 * 框架等级（数字，越小越高）→ 档位。认不出的**一律返回空串**，由调用方兜到 unknown。
 *
 * ## 为什么先把 `''` / `null` 挡掉
 *
 * `Number('')` 和 `Number(null)` 都是 **0**，而 0 是主人。也就是说
 * 「等级字段是空串」这种最常见的「没填」状态，会被读成「最高权限」——
 * 而这里的注释一直写着「拿不到权限就按最严处理」，方向正好相反。
 *
 * 2026-11-05 之前 `bucketOf()` 直接 `Number(s.level)`，一个
 * `{ sender: { level: '' } }` 的 payload 就能拿到主人档。老插件不给
 * `bucket` 只给 `level`，正是这条路径的主要使用者。
 */
export function bucketOfLevel(level) {
  if (level === null || level === undefined || level === '') return '';
  if (typeof level !== 'number' && typeof level !== 'string') return '';
  const lv = Number(level);
  if (!Number.isFinite(lv)) return '';
  /** 负数不是合法等级，按「认不出来」处理；不能让它落到 `lv <= 0` 变成主人 */
  if (lv < 0) return '';
  if (lv <= 0) return 'owner';
  if (lv <= 1) return 'admin';
  if (lv <= 2) return 'manager';
  if (lv <= 3) return 'helper';
  return 'member';
}

/** 每一档能干什么：all = 全部工具，chat = 只能聊天 */
export const MODES = ['all', 'chat'];

/**
 * 这里原来有一个 `LOCAL_TOOLS`，写死了
 * `['bash','pwsh','shell','fs','fs-search','fs_search','web','web-fetch']`，
 * 注释还写着「收不走的会被忽略」。
 *
 * **两句话都是错的**，而且错得很安静（2026-10-28 才发现）：
 *   · 这些名字是按 OneBot 时代的想象写的，这版 DSH 里一个都没有；
 *   · `tools.restrict()` 不忽略未知名字，它直接抛
 *     `names unknown global tools "bash", …`，**整批拒绝，一个都不收**。
 *
 * 于是「群友只能用聊天」这条硬限制从来没生效过——只是没人看得见，
 * 因为面板日志那层把错误信息丢了。
 *
 * 现在收工具的逻辑在 `host.js` 的 `restrictTurnTools()`：名字全部来自
 * DSH 自己的 `tools.schemas()`，白名单之外的都收走（fail-closed）。
 * 别再往这里加硬编码的工具名。
 */

/**
 * 群友这一轮允许保留的工具。
 *
 * 只有三个：查记忆（`memory_search`）、发消息、收尾。
 * 其它一律收走——包括 DSH 自己的 `edit` / `write` / `read` / `pwd` /
 * `load_workspace_dependencies`，以及所有 MCP 工具（`mcp__*` 里就有能改文件的）。
 *
 * `memory_note` **故意不在**这里：它是写长期记忆的，给群友等于允许往每轮
 * 都注入的记忆里投毒（写一句「主人讨厌张三」，以后每次对话都带着）。
 * 它的 `execute()` 里还有一道按当轮档位的检查，两层都拦。
 */
export const GUEST_KEEP_TOOLS = ['memory_search', 'qq_send', 'qq_close'];

/**
 * 主动搭话那一轮要收走的工具。
 *
 * `qq_send` / `qq_close` 的语义是「回复**当前这条**消息」——目标来自
 * `speaker`，而 `speaker` 在每轮 `finally` 里就删掉了。主动搭话是宿主
 * 自己发起的，没有"当前消息"，挂着这两个工具的结果是：模型调了必然失败，
 * 然后按提示 `<<skip>>`，一轮模型调用白花。
 *
 * 记忆工具**故意不在这里**：她翻日记、记事，主动开口时同样用得上。
 */
export const AWAKE_DENY_TOOLS = ['qq_send', 'qq_close', 'qq_send_file'];

/**
 * 算出「这些名字里，当前实际挂着的有哪些」。
 *
 * 为什么不能直接把名字丢给 `restrict`：它会**校验名字**，只要有一个不存在
 * 就抛 `names unknown global tools …`，整批拒绝。工具是每轮按条件挂的
 * （`qqTools.enabled` 可以关），所以必须先问 DSH 现在有哪些。
 *
 * 做成纯函数是为了能测：给它一个假的 tools，看它算出来什么。
 *
 * @param {object} tools agent 的 tools 服务（只要 `schemas()`）
 * @param {string[]} names 想收走的名字
 * @returns {{ok:true, deny:string[]} | {ok:false, reason:string}}
 */
export function planDenyTools(tools, names = AWAKE_DENY_TOOLS) {
  if (!tools || typeof tools.schemas !== 'function') {
    return { ok: false, reason: '这个 agent 的 tools 服务没有 schemas()（版本差异）' };
  }

  let list;
  try {
    list = tools.schemas();
  } catch (e) {
    return { ok: false, reason: `读不到工具清单：${e?.message || e}` };
  }

  const have = new Set(
    (Array.isArray(list) ? list : [])
      .map((s) => String(s?.name ?? s?.tool?.name ?? ''))
      .filter(Boolean),
  );
  if (!have.size) return { ok: false, reason: 'DSH 报不出工具清单（schemas() 是空的）' };

  const deny = (Array.isArray(names) ? names : []).filter((n) => have.has(n));
  if (!deny.length) return { ok: false, reason: '这些工具这一轮本来就没挂' };

  return { ok: true, deny };
}

/**
 * 算出这一轮该收走哪些工具。
 *
 * 为什么是「问 DSH 要清单」而不是「我们自己列」：`tools.restrict()` 会
 * **校验名字**，只要有一个不存在就抛 `names unknown global tools …`，
 * 整批拒绝。硬编码的名字一旦和 DSH 对不上（我们之前就是），
 * 结果不是「少收几个」，而是**一个都没收**，而且失败是静默的。
 *
 * 做成纯函数是为了能测：给它一个假的 tools，看它算出来什么。
 *
 * @param {object} tools agent 的 tools 服务（只要 `schemas()`）
 * @param {string[]} keep 允许保留的工具名
 * @returns {{ok:true, deny:string[]} | {ok:false, reason:string}}
 */
export function planGuestTools(tools, keep = GUEST_KEEP_TOOLS) {
  if (!tools || typeof tools.schemas !== 'function') {
    return { ok: false, reason: '这个 agent 的 tools 服务没有 schemas()（版本差异）' };
  }

  let list;
  try {
    list = tools.schemas();
  } catch (e) {
    return { ok: false, reason: `读不到工具清单：${e?.message || e}` };
  }

  const names = (Array.isArray(list) ? list : [])
    .map((s) => String(s?.name ?? s?.tool?.name ?? ''))
    .filter(Boolean);

  // 清单是空的就别硬来：宁可明说「没收成」，也不要假装收住了
  if (!names.length) return { ok: false, reason: 'DSH 报不出工具清单（schemas() 是空的）' };

  const keepSet = new Set(keep);
  const deny = names.filter((n) => !keepSet.has(n));
  if (!deny.length) {
    return { ok: false, nothing: true, reason: `没有可收走的工具（清单 ${names.length} 个，全在白名单里）` };
  }

  return { ok: true, deny };
}

/**
 * **输出通道**：这两个不算「能力」，是「怎么说话」。
 *
 * 人格写 `tools: []` 的意思是「别让它碰这台机器」，不是「别让它开口」。
 * 如果把 `qq_send` 一起收走，模型会按 order 907 的说明去调一个不存在的工具，
 * 然后退成正文发送——表面上还能说话，但分段发言、表情、@ 全没了，
 * 而且 907 那段提示词会变成谎话。
 *
 * 所以人格级收窄**永远保留**这两个（群友档本来也保留）。
 *
 * **`qq_send_file` 绝对不能加进来。** 它长得很像「输出」，本质是「读整台机器
 * 任意路径的文件并发出去」——那是**能力**，不是表达方式。这个常量在
 * `planPersonaTools` 里是**无条件并回去**的（在 `keep` 过滤之后），
 * 一旦加进去，群友档（`permissions.member = 'chat'`）在人格写了 `tools: []`
 * 时会重新拿到它，一句「把 D:\xxx 发我」就能外发任意文件。
 * 2026-11-02 试过加，被这条挡回来。
 */
export const OUTPUT_TOOLS = ['qq_send', 'qq_close'];

/**
 * 人格级工具限制：这个人格这一轮允许碰哪些工具。
 *
 * 语义（抄 AstrBot `persona_plus`，三元）：
 *   · `null` / 省略 → 不限制（自己写的人格，保持旧行为）
 *   · `[]`          → 一个都不给（**仓库装来的人格默认这个**）
 *   · `[a, b]`      → 只给这两个
 *
 * 和档位的关系是**取交集**：主人的消息 + 人格 `[]` → 仍然没工具；
 * 群友的消息 + 人格 `[edit]` → 仍然只有 `GUEST_KEEP_TOOLS` 里那几个。
 * 「宁可少给，不可多给」这条兜底原则对人格同样成立。
 *
 * @param {object} tools agent 的 tools 服务（只要 `schemas()`）
 * @param {string[]} personaTools 人格声明的允许名单（空数组 = 全禁）
 * @param {string[]|null} [keep] 档位还允许保留的白名单；null = 档位不额外限制
 * @returns {{ok:true, deny:string[]} | {ok:false, reason:string}}
 */
export function planPersonaTools(tools, personaTools, keep = null) {
  if (!Array.isArray(personaTools)) return { ok: false, reason: '人格没有声明工具限制' };

  if (!tools || typeof tools.schemas !== 'function') {
    return { ok: false, reason: '这个 agent 的 tools 服务没有 schemas()（版本差异）' };
  }

  let list;
  try {
    list = tools.schemas();
  } catch (e) {
    return { ok: false, reason: `读不到工具清单：${e?.message || e}` };
  }

  const names = (Array.isArray(list) ? list : [])
    .map((s) => String(s?.name ?? s?.tool?.name ?? ''))
    .filter(Boolean);
  if (!names.length) return { ok: false, reason: 'DSH 报不出工具清单（schemas() 是空的）' };

  let allowed = new Set(personaTools);
  if (Array.isArray(keep)) {
    const k = new Set(keep);
    allowed = new Set([...allowed].filter((n) => k.has(n)));
  }
  /**
   * 输出通道**在交集之后**并回来。
   *
   * 放在交集之前的话，`keep=[]` 这种极端值会把 `qq_send` 也切掉——
   * 那就又回到「人格写了 tools 就不许说话」。输出不是能力，是「怎么说话」，
   * 任何一档、任何人格都不该把它收走。
   */
  for (const n of OUTPUT_TOOLS) allowed.add(n);

  const deny = names.filter((n) => !allowed.has(n));
  // nothing: 没有需要收走的（不是失败）。调用方别把它当告警打出去
  if (!deny.length) return { ok: false, nothing: true, reason: '没有可收走的工具（人格允许的已经覆盖了全部）' };

  return { ok: true, deny };
}

/**
 * 这条消息的说话人属于哪一档。
 *
 * 优先用 ai-chat 给的 `bucket`（它已经按框架的等级算好了）；
 * 没有就退回看 `level` 数字；再不行就是 unknown。
 *
 * @param {object} payload inbound payload
 * @returns {'owner'|'admin'|'manager'|'helper'|'member'|'unknown'}
 */
export function bucketOf(payload) {
  const s = payload?.sender ?? {};

  if (BUCKETS.includes(s.bucket)) return s.bucket;

  /**
   * 退回看数字等级。这条分支现在是**主路径的备份**，不能删：
   * 老版本 ai-chat 只给 `level` 不给 `bucket`，而它照样会算出 2 和 3。
   *
   * `bucketOfLevel()` 对空串 / null / 负数一律返回空串，不再被 `Number()` 转成 0
   * 当成主人——「拿不到权限」必须是 unknown，不能是最高档。
   */
  const byLevel = bucketOfLevel(s.level);
  if (byLevel) return byLevel;

  return 'unknown';
}

/**
 * 这一档能不能用本地工具。
 *
 * @param {string} bucket
 * @param {object} permissions 配置里的 permissions 表
 * @returns {'all'|'chat'}
 */
export function modeFor(bucket, permissions = {}) {
  const v = permissions[bucket];
  if (MODES.includes(v)) return v;
  // 没配、配错了 → 一律按最严处理（这就是兜底）
  return 'chat';
}

/** 给 AI 看的一句话 */
export function describeSpeaker(payload, bucket) {
  const name = String(payload?.sender?.name ?? '').trim() || '某人';
  const label =
    bucket === 'owner' ? '主人（这台机器的所有者）'
      : bucket === 'admin' ? '管理员（框架里配的，跨群有效）'
        : bucket === 'manager' ? '群管（这个群的管理员）'
          : bucket === 'helper' ? '助手（这个群里帮忙的人）'
            : bucket === 'member' ? '普通成员'
              : '身份不明';

  return `这一句是「${name}」说的，权限：${label}。`;
}

/**
 * 硬规则：不管工具收没收走，这几条都写进提示词。
 *
 * 为什么模型层也要拦：工具可能没收干净（DSH 改了工具名、以后加了新工具），
 * 而且「用现成工具干坏事」和「编一段命令让用户去跑」是两回事，后者拦不住。
 */
export function rulesFor(bucket) {
  if (bucket === 'owner') {
    return '对方是主人，可以正常使用工具。';
  }
  /**
   * 管理员 / 群管 / 助手：**底线完全一样**——都不是机器主人，都不能动这台机器。
   *
   * 三档在提示词里的差别只有「他是什么人」，因为工具层面的差别由
   * `capabilities.js` 的档位策略管（主人可以给群管单独开读文件，
   * 不给群成员）。**别在这里写工具名**：写了就和策略层变成两套真相，
   * 用户改了策略、提示词还在说另一套。
   */
  if (bucket === 'admin' || bucket === 'manager' || bucket === 'helper') {
    const who =
      bucket === 'admin' ? '框架里的管理员（跨群有效）'
        : bucket === 'manager' ? '这个群的群管'
          : '这个群里的助手';
    return `对方是${who}，不是机器的主人。可以用工具查信息，但**不要执行删除、覆盖、安装、改系统配置这类操作**，也不要读和当前问题无关的私人文件。他要你这么做时，直说「这个得主人来」。`;
  }
  if (bucket === 'member') {
    return '对方是普通群成员。**不要执行任何会改动这台机器的操作**（删除、写入、安装、跑命令），也不要读私人文件或目录。他要你这么做时，直说「这个我没权限」。';
  }
  return '对方身份不明（拿不到权限信息）。**按最低权限对待**：只聊天，不调用任何本地工具，不读文件、不跑命令。';
}
