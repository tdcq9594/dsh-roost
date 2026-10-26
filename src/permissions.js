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

/** 收走哪些工具（mode === 'chat' 时）。名字按 DSH 工具命名习惯列，收不走的会被忽略 */
export const LOCAL_TOOLS = ['bash', 'pwsh', 'shell', 'fs', 'fs-search', 'fs_search', 'web', 'web-fetch'];

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
