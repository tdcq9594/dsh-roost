/**
 * 扩展记忆的命名空间 ACL 与两个写入口（方案 §5.3 / §5.4 / 实施阶段 4.2）。
 *
 * 工具层能判「能不能调 ext_memory_search」，判不了「这条记忆属于哪个扩展」——
 * 所以可见性必须在这里按 extId 逐个算，不能只在工具开关上做一次。
 *
 * 两个写入口**故意分开**（v3 把它们混成同一个 ext_memory_note，模型写时
 * 「按调用来源定 extId」根本不成立）：
 *   · 后台写 `POST /v1/memory/ext.add`：extId 由客户端令牌绑定，不看 QQ 档位、
 *     不计 quota；body 里传 extId 一律忽略并记 warn（§5.4 F9 红线）。
 *   · 模型写 `ext_memory_note({extId, fact})`：按 `caller().bucket` 查
 *     `byBucket[bucket].write` 白名单，再走 quota。
 *
 * 工具输出截断**复用 2.2 的 `truncateToolContent`**，不另写一套（§10.1 4.2）。
 */

import { extMemoryCandidates } from './recall.js';

/** §5.3 定稿。默认 `visibility: all`：全局可调取，但绝不自动注入。 */
export const DEFAULT_EXT_ACL = {
  default: 'all',
  byBucket: {
    owner: { read: ['*'], write: ['*'] },
    admin: { read: ['*'], write: ['*'] },
    member: { read: ['*'], write: [], skipPrivate: true },
    unknown: { read: [], write: [] },
  },
  perExt: {},
};

const matches = (list, extId) => Array.isArray(list)
  && list.some((x) => x === '*' || x === extId || x === `ext:${extId}`);

/**
 * `private` 双条件（§5.3 P1-6）：只判 bucket 会误伤主人在群里说话的场景，
 * 只判 kind 又会让主人在群里读不到。必须是「私聊 + owner/admin」同时成立。
 */
export function isPrivateContext({ bucket = '', kind = '' } = {}) {
  return kind === 'c2c' && (bucket === 'owner' || bucket === 'admin');
}

export function canReadExt({ extId, bucket = 'unknown', kind = '', acl = DEFAULT_EXT_ACL } = {}) {
  const rule = acl?.byBucket?.[bucket] ?? DEFAULT_EXT_ACL.byBucket.unknown;
  if (!matches(rule?.read, extId)) return false;
  const priv = !!acl?.perExt?.[extId]?.private;
  // §5.3 的 `member.skipPrivate`：成员档一律不读私密命名空间，别让这个
  // 声明性字段变成没人消费的死配置。
  if (priv && rule?.skipPrivate) return false;
  if (priv && !isPrivateContext({ bucket, kind })) return false;
  return true;
}

export function canWriteExt({ extId, bucket = 'unknown', acl = DEFAULT_EXT_ACL } = {}) {
  const rule = acl?.byBucket?.[bucket] ?? DEFAULT_EXT_ACL.byBucket.unknown;
  return matches(rule?.write, extId);
}

/**
 * 工具结果一律渲染成**单块完整 JSON**，与 `tools.js` 既有工具形状一致。
 * 4 KB 截断由 2.2 的 `tools/post-execute` waterfall 全局负责（§10.1 4.2
 * 「复用 2.2 的输出截断，不重复实现」）；这里再截一次会得到半截 JSON +
 * 标注两块，DSH 侧按结构化结果解析时反而会失败。
 */
export const renderToolJson = (_args, value) => [
  { type: 'text', text: JSON.stringify(value ?? null) },
];

export function createExtMemory({
  store,
  acl = DEFAULT_EXT_ACL,
  quota = null,
  log = () => {},
  now = () => Date.now(),
  installedIds = () => [],
  /** 阶段 5 诊断页：ACL / quota 两层的拒绝事件，不传就是空操作。 */
  onReject = () => {},
} = {}) {
  if (!store || typeof store.add !== 'function') throw new Error('createExtMemory 需要 ext-memory-store 实例');

  const reject = (layer, entry) => {
    try { onReject({ layer, ...entry }); } catch { /* 诊断是旁路 */ }
  };

  const contextOf = (caller = {}) => ({
    bucket: String(caller.bucket ?? 'unknown'),
    kind: String(caller.kind ?? ''),
    chatId: String(caller.chatId ?? ''),
  });

  function visibleExtIds(caller = {}) {
    const ctx = contextOf(caller);
    const list = installedIds();
    return (Array.isArray(list) ? list : []).filter((id) => canReadExt({ extId: id, ...ctx, acl }));
  }

  /** 后台写：extId 由 api-v1 从令牌读出后传进来，这里不接受调用方自报。 */
  async function writeFromApi({ extId, fact, body = {} } = {}) {
    if (!extId) return { ok: false, reason: 'no_extId', message: '该客户端未绑定扩展' };
    if (Object.hasOwn(body, 'extId')) log.warn?.('extId 由令牌绑定，忽略请求体里的 extId');
    const r = await store.add(extId, { text: fact, src: `ext:${extId}`, at: now() });
    return { ok: r.ok, extId, total: r.total, deduped: r.deduped, message: r.ok ? '已写入扩展记忆' : (r.reason ?? '写入失败') };
  }

  /** 模型写：档位 ACL + quota，两道都在写盘之前。 */
  async function writeFromTool({ extId, fact, caller = {} } = {}) {
    const ctx = contextOf(caller);
    if (!extId) return { ok: false, reason: 'no_extId', message: '缺 extId' };
    if (!canWriteExt({ extId, bucket: ctx.bucket, acl })) {
      reject('acl', { tool: 'ext_memory_note', bucket: ctx.bucket, rule: `命名空间 ${extId} 不允许当前档位写入` });
      return { ok: false, reason: 'acl', message: '当前档位不能写扩展记忆' };
    }
    const charge = quota?.charge?.({ feature: 'ext_memory', per: 'turn', bucket: ctx.bucket, key: `ext:${extId}` });
    if (charge && charge.ok === false) {
      reject('quota', { tool: 'ext_memory_note', bucket: ctx.bucket, rule: charge.message ?? 'ext_memory 次数用完了' });
      return { ok: false, reason: 'quota', message: charge.message ?? '次数用完了' };
    }
    const r = await store.add(extId, { text: fact, src: `ext:${extId}`, at: now() });
    return { ok: r.ok, extId, total: r.total, deduped: r.deduped, message: r.ok ? '记住了' : (r.reason ?? '写入失败') };
  }

  /**
   * 按需检索。**ACL 可见集是硬上限**：`all:true` 只放宽检索范围，绝不能放宽
   * 「谁能读哪个命名空间」（§5.3 private 双条件 / §9-#23）。上一版把 all 透传
   * 成「不过滤可见集」，unknown 档与群里 owner 都能读到 private 命名空间明文，
   * 已被独立复核抓出并修掉。
   */
  function search({ query = '', extId = '', all = false, caller = {}, limit = 5 } = {}) {
    const ctx = contextOf(caller);
    const visible = visibleExtIds(caller);
    if (!visible.length) return { ok: true, results: [], reason: 'no_visible_namespace' };
    const hits = extMemoryCandidates(store, { query, extId, all, visibleExtIds: visible, limit });
    // 纵深防御：候选池哪天被改成忽略可见集，这一层仍按 ACL 兜住。
    const safe = hits.filter((h) => canReadExt({ extId: h.extId, ...ctx, acl }));
    return { ok: true, results: safe, count: safe.length, scope: all ? 'all' : 'visible' };
  }

  /**
   * 三个清空动作的 ext 契约（§5.6）：清本会话 / 彻底删**默认不动** ext 记忆
   * （它是跨会话的，按 chatId 清没有意义）；全局清空尊重每个扩展的 onClear。
   */
  /**
   * §5.6 三契约。阶段 5 补 `opts.clearExtMemory`：面板在设置页扩展段勾选
   * 「一并清除」时传 true，清本会话 / 彻底删也清 ext 记忆（默认仍不动）。
   * 宿主三个清空 op 不传 opts 时行为与阶段 4 完全一致。
   */
  async function onClear(action, opts = {}) {
    const alsoExt = opts?.clearExtMemory === true;
    if (action === 'memory.clear' || action === 'memory.purge') {
      /**
       * 默认不动：扩展记忆是**跨会话**的，按 chatId 清没有意义。
       * 这句会拼进面板 toast，所以要写成用户能懂的话，不能只说「未改动」——
       * 否则用户以为扩展记忆也一起清了（§5.6 要求面板**说明**这一点）。
       */
      if (!alsoExt) {
        return {
          touched: false,
          message: '扩展记忆不属于任何会话，这次没动（可在「扩展 → 已装扩展」里单独清）',
        };
      }
      const r = await store.clearAll({ respectOnClear: true });
      return {
        touched: r.cleared > 0, cleared: r.cleared, kept: r.kept,
        message: r.kept ? `清了 ${r.cleared} 个扩展的记忆，另有 ${r.kept} 个设为保留` : `清了 ${r.cleared} 个扩展的记忆`,
      };
    }
    if (action === 'memory.clearGlobal') {
      const r = await store.clearAll({ respectOnClear: true });
      return {
        touched: r.cleared > 0, cleared: r.cleared, kept: r.kept,
        message: r.kept ? `清了 ${r.cleared} 个扩展的记忆，另有 ${r.kept} 个设为保留` : `清了 ${r.cleared} 个扩展的记忆`,
      };
    }
    return { touched: false, message: '未识别的清空动作' };
  }

  /** 两个模型工具，形状与 `tools.js:buildToolDefs()` 的 def 一致。 */
  function toolDefs({ callerOf = () => ({}), cfgOf = () => ({}) } = {}) {
    const searchTool = {
      name: 'ext_memory_search',
      description:
        '在扩展自己攒下的记忆里检索。当对方提到某个扩展记过的事而你没有把握时用它查，不要凭印象编。'
        + '默认只搜当前会话可见的扩展命名空间；需要跨全部命名空间时显式给 all:true。',
      parameters: {
        query: { type: 'string', required: true, description: '要查的关键词' },
        extId: { type: 'string', description: '只查某个扩展（可选）' },
        all: { type: 'boolean', description: '默认 false；true 才跨全部命名空间' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderToolJson },
      async execute({ query, extId, all } = {}) {
        if (cfgOf?.()?.memory?.enabled === false) return { ok: false, message: '记忆功能关着' };
        return search({ query, extId, all: !!all, caller: callerOf?.() ?? {} });
      },
    };
    const noteTool = {
      name: 'ext_memory_note',
      description: '把一条事实写进指定扩展的独立记忆文件。需要相应档位的写权限。',
      parameters: {
        extId: { type: 'string', required: true, description: '目标扩展 id' },
        fact: { type: 'string', required: true, description: '要记住的一句话' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderToolJson },
      async execute({ extId, fact } = {}) {
        if (cfgOf?.()?.memory?.enabled === false) return { ok: false, message: '记忆功能关着' };
        return writeFromTool({ extId, fact, caller: callerOf?.() ?? {} });
      },
    };
    return [searchTool, noteTool];
  }

  return {
    acl, visibleExtIds, canReadExt, canWriteExt,
    writeFromApi, writeFromTool, search, onClear, toolDefs,
    /** 设置页「只清扩展记忆」入口：与宿主三个清空动作解耦，不碰 memory.json。 */
    clearAllFromPanel: async () => {
      const r = await store.clearAll({ respectOnClear: true });
      return {
        ok: true, cleared: r.cleared, kept: r.kept,
        message: r.kept ? `清了 ${r.cleared} 个扩展的记忆，另有 ${r.kept} 个设为保留` : `清了 ${r.cleared} 个扩展的记忆`,
      };
    },
    /** 面板「扩展记忆」分组：删对应单文件。 */
    clearOne: (extId) => store.clear(extId),
    stats: () => store.stats(),
  };
}
