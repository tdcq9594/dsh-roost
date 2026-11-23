/**
 * `/quick` 的 op → scope 映射
 * ==========================
 *
 * 面板 API（`/roost/api/quick`）共 60 个 op。以前它们只判「调用方是不是主人」，
 * 于是**扩展页面只要同源就能调**——绕过了整套 scope 机制（`/v1` 那边是逐条判的）。
 *
 * 这张表把每个 op 归到一个 scope 上，实现「**声明即授权**」：
 *   · 清单里声明了 scope，页面与进程都能用；
 *   · 没声明，一点都拿不到。
 *
 * **fail-closed**：不在表里的 op 一律拒绝。将来新增 op 忘了登记，
 * 结果是「调不到」而不是「默认全开」——这个方向的错更容易被发现。
 *
 * 值为 `null` 的 op 只碰调用方自己（自己的配置、自己的动作、自己的用量），
 * 不需要 scope；跨扩展访问要 `ext:manage`（见 `needsCrossExt()`）。
 */

/** 只操作调用方自己的 op：不需要 scope，但 `arg.id` 会被强制成自己。 */
export const SELF_ONLY_OPS = Object.freeze([
  'extensions.get',
  'extensions.usage.save',
  'extensions.config.get',
  'extensions.config.save',
  'extensions.ui.action',
  'extensions.forms',
  'extensions.status',
  'extensions.diagnose',
  'extensions.buckets',
]);

/** 需要 `ext:manage` 的 op：跨扩展或管理面。 */
const EXT_MANAGE_OPS = Object.freeze([
  'extensions.market.list', 'extensions.market.progress', 'extensions.market.install',
  'extensions.market.remove', 'extensions.market.updates', 'extensions.market.revoke',
  'extensions.market.source',
  'extensions.clients.list', 'extensions.clients.create', 'extensions.clients.revoke',
]);

/** 只读的宿主状态：`state:read` 就够（和 `/v1/state` 同口径）。 */
const STATE_READ_OPS = Object.freeze([
  'model.get', 'model.list', 'model.ping',
  'quota.get',
  'capabilities.get', 'capabilities.preview',
  'features.get', 'features.preview',
  'recall.log',
  /** 3.4 向量/重排状态：只读状态查询 */
  'memory.vector.status',
  'backup.list',
  /** A2 记忆统计快照：只读聚合，和 `/v1/state` 同口径 */
  'stats.snapshot',
  'stats.sources',
]);

/** 调教类：改模型 / 配额 / 能力档位 / 保留策略。 */
const MODEL_WRITE_OPS = Object.freeze([
  'model.set',
  'quota.patch', 'quota.reset',
  'capabilities.init', 'capabilities.patch', 'capabilities.ack',
  'features.patch',
  'retention.apply', 'retention.restore',
]);

/** 宿主维护：备份还原 / 共享依赖。 */
const HOST_MAINT_OPS = Object.freeze([
  'backup.restoreRetention', 'backup.cancelRestore',
  /**
   * 共享依赖（功能包）：装 / 卸 / 查 / 扫都在这一组。
   *
   * `remove` 和 `install` 同级：都是「改这台机器的依赖」，不是读一下就走。
   * `scan` 虽然只读，但它和 `status` 一样暴露宿主目录结构，归在同一道闸门
   * 比单独开一个 scope 更好审——扩展要「看看有什么」也得先说清用途。
   */
  'sharedDeps.status', 'sharedDeps.install', 'sharedDeps.remove', 'sharedDeps.scan',
  /** 本地 ONNX 运行时（记忆增强前置）：装/卸/查/取消，和共享依赖同级维护面 */
  'onnx.status', 'onnx.install', 'onnx.cancel', 'onnx.uninstall',
  'onnx.modelInstall', 'onnx.modelCancel', 'onnx.modelUninstall',
  'onnx.rerankInstall', 'onnx.rerankCancel', 'onnx.rerankUninstall',
  /**
   * A1 审计日志查询：虽然只读，但含 chatId / peer / peerId（谁在什么时候动了什么），
   * 比 `memory:read` 更敏感——和备份还原同归 host:maintenance，最小授权。
   */
  'audit.query',
]);

/** 不可逆的删除类。 */
const MEMORY_PURGE_OPS = Object.freeze([
  'memory.purge', 'memory.clearGlobal',
  'self.clear', 'events.clear', 'profiles.clear',
  'mood.history.clear',
  /** 清掉压缩开场 / 会话上下文（不可恢复） */
  'context.clear',
]);

/** 会话记忆的写与清（可恢复的那种）。 */
const MEMORY_WRITE_OPS = Object.freeze([
  'memory.remove', 'memory.mute', 'memory.unmute',
  'memory.clear',
  /** 待跟进：设/撤某条事实的到期提醒（只动 meta，不加内容） */
  'memory.followUp',
  /** 做梦：跑一次（写 dreams/*.md + 自述，不碰 facts） */
  'memory.dream',
  /** E4：撤销某人雷区（改，不是清库） */
  'profiles.clearDislikes',
  'graph.suppress', 'graph.unsuppress', 'graph.close',
  'extensions.memory.clear',
]);

/**
 * 完整映射。key 是 op 名，value 是所需 scope（`null` = 只碰自己）。
 * @type {Readonly<Record<string, string|null>>}
 */
export const OP_SCOPE = Object.freeze({
  ...Object.fromEntries(SELF_ONLY_OPS.map((o) => [o, null])),
  ...Object.fromEntries(EXT_MANAGE_OPS.map((o) => [o, 'ext:manage'])),
  ...Object.fromEntries(STATE_READ_OPS.map((o) => [o, 'state:read'])),
  ...Object.fromEntries(MODEL_WRITE_OPS.map((o) => [o, 'model:write'])),
  ...Object.fromEntries(HOST_MAINT_OPS.map((o) => [o, 'host:maintenance'])),
  ...Object.fromEntries(MEMORY_PURGE_OPS.map((o) => [o, 'memory:purge'])),
  ...Object.fromEntries(MEMORY_WRITE_OPS.map((o) => [o, 'memory:write'])),

  'memory.list': 'memory:read',
  /** B1：单条事实的历史说法 + 证据引文（只读投影，不改存储） */
  'memory.history': 'memory:read',
  /** 读：最近的梦（只读，不该要写权限） */
  'memory.dream.list': 'memory:read',
  'mind.model': 'memory:read',
  /** B2：读快照只读；refresh/clear 写的是独立 mind-model.json，归 memory:write */
  'mind.snapshot': 'memory:read',
  'mind.refresh': 'memory:write',
  'mind.clear': 'memory:write',
  /** §1.10 Gist 两档：读印象只读；generate/crystallize/clear 写独立文件，归 memory:write */
  'gist.impression.list': 'memory:read',
  'gist.impression.hit': 'memory:write',
  'gist.impression.generate': 'memory:write',
  'gist.impression.crystallize': 'memory:write',
  'gist.impression.clear': 'memory:write',
  'persona.set': 'prompt:write',
  /** 阶段6：人物墙人工编辑/不再记住——改的是档案，归 prompt:write */
  'persona.edit': 'prompt:write',
  'persona.noMemory': 'prompt:write',
  /** 阶段7：群印象档案读写，改的是独立档案文件，归 prompt:write */
  'chatprofile.save': 'prompt:write',
  'chatprofile.clear': 'prompt:write',
  'groups.list': 'groups:read',
});

/**
 * 这个 op 需要哪个 scope。
 *
 * @param {string} op
 * @returns {{ ok:true, scope:string|null } | { ok:false, why:string }}
 *   未知 op 返回 `ok:false`——**不要默认放行**。
 */
export function scopeOfOp(op) {
  const key = String(op ?? '').trim();
  if (!key) return { ok: false, why: '缺 op' };
  if (!Object.prototype.hasOwnProperty.call(OP_SCOPE, key)) {
    return { ok: false, why: `不认识的 op：${key}` };
  }
  return { ok: true, scope: OP_SCOPE[key] };
}

/** 这个 op 是不是只操作自己（`arg.id` 必须等于调用方）。 */
export function isSelfOnlyOp(op) {
  return SELF_ONLY_OPS.includes(String(op ?? '').trim());
}

/**
 * 声明的 scope 够不够调这个 op。
 *
 * @param {string} op
 * @param {string[]} scopes 清单里声明的 scope
 */
export function allowsOp(op, scopes) {
  const r = scopeOfOp(op);
  if (!r.ok) return r;
  if (r.scope === null) return { ok: true, scope: null };
  const have = Array.isArray(scopes) ? scopes : [];
  if (!have.includes(r.scope)) {
    return { ok: false, why: `这个操作需要 ${r.scope}，清单里没有声明` };
  }
  return { ok: true, scope: r.scope };
}
