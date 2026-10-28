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

/** 档位，从高到低 */
export const BUCKETS = ['owner', 'admin', 'member'];

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
 * 现在收工具的逻辑在 `host.js` 的 `restrictGuestTools()`：名字全部来自
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
    return { ok: false, reason: `没有可收走的工具（清单 ${names.length} 个，全在白名单里）` };
  }

  return { ok: true, deny };
}

/**
 * 这条消息的说话人属于哪一档。
 *
 * 优先用 ai-chat 给的 `bucket`（它已经按框架的等级算好了）；
 * 没有就退回看 `level` 数字；再不行就是 unknown。
 *
 * @param {object} payload inbound payload
 * @returns {'owner'|'admin'|'member'|'unknown'}
 */
export function bucketOf(payload) {
  const s = payload?.sender ?? {};

  if (BUCKETS.includes(s.bucket)) return s.bucket;

  // 老版本插件只给数字等级：0 主人 / 1 管理员 / 其余成员
  const lv = Number(s.level);
  if (Number.isFinite(lv)) {
    if (lv <= 0) return 'owner';
    if (lv <= 1) return 'admin';
    return 'member';
  }

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
      : bucket === 'admin' ? '管理员'
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
  if (bucket === 'admin') {
    return '对方是群管理员，不是机器的主人。可以用工具查信息，但**不要执行删除、覆盖、安装、改系统配置这类操作**，也不要读和当前问题无关的私人文件。';
  }
  if (bucket === 'member') {
    return '对方是普通群成员。**不要执行任何会改动这台机器的操作**（删除、写入、安装、跑命令），也不要读私人文件或目录。他要你这么做时，直说「这个我没权限」。';
  }
  return '对方身份不明（拿不到权限信息）。**按最低权限对待**：只聊天，不调用任何本地工具，不读文件、不跑命令。';
}
