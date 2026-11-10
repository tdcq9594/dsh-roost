/**
 * 阶段 5：面板后端聚合（扩展清单 / usage / 客户端 / 诊断 / 状态）
 * ============================================================
 *
 * 这一层只做「把已经存在的东西摆到面板上」，不新增权限、不改策略：
 *   · 清单与 usage 来自 1.1 的 `ext-registry`；
 *   · 客户端令牌来自 3.2 的 `createClientStore`（只存 hash）；
 *   · 档位与 deny 规则来自 `capabilities` / `quota` / `ext-memory`；
 *   · 鉴权失败与令牌重建来自 3.2 的审计事件。
 *
 * 设计约束：
 *   · 零外部依赖，`dir` 可注入，测试一律用临时目录；
 *   · 面板响应**永不返回**令牌明文或 hash；明文只在 `createClient()` 的
 *     返回值里出现一次（一次性显示，之后再也读不出来）；
 *   · `usage` 写回是原子写；市场装扩展（有 `.source.json`）编辑后必须让
 *     `sha256` 失效并标注，用户手写目录没有校验和、不适用；
 *   · 「扩展鉴权失败」只认后端审计事件 `ext.auth_failed`，**不认**
 *     官方 `waiting-credentials`（v3.6 已证零命中）。
 */
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { dataDir } from './config.js';
import { BUCKETS, resolvePolicy } from './capabilities.js';
import { V1_SCOPES } from './api-v1.js';
import { USAGE_CHAR_LIMIT } from './ext-usage.js';
import { SOURCE_FILE, MANIFEST_FILE } from './ext-registry.js';
import { DEFAULT_EXT_ACL } from './ext-memory.js';
import { QUOTA_WIRED } from './quota.js';

export const EXT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 统一拒绝诊断页的五层来源。顺序固定，前端按这个顺序渲染。 */
export const REJECTION_LAYERS = Object.freeze({
  fence: '接入栅栏 / 令牌鉴权',
  capabilities: '能力页 deny / forceDeny',
  quota: '次数限制',
  acl: '扩展记忆命名空间 ACL',
  guard: '执行期工具 guard',
});

export const LOCALLY_MODIFIED_LABEL = '已本地修改，不再参与更新校验';

/** §7「最小授权」+ §12：这几个 scope 要单独授权，不能顺手全勾上。 */
export const SENSITIVE_SCOPES = Object.freeze(['agent:write', 'say:write', 'prompt:write', 'proactive:write']);

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 原子写：随机 .tmp + rename，坏文件不会留在目录里被扫描器当扩展。 */
function writeJsonAtomic(file, value, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${file.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 最近 N 次拒绝的事件日志。
 *
 * 为什么不复用 `audit.log`：那是「面板点击」的追责日志，字段是白名单，
 * 且 `/quick` 每个写操作都记一行；拒绝事件要高得多、还要带工具名与档位，
 * 混进去会把追责日志冲淡。单独一份 jsonl，超上限自动截断。
 */
export function createRejectionLog({ dir = dataDir(), now = () => Date.now(), max = 200, log = () => {} } = {}) {
  const file = join(dir, 'ext-rejections.jsonl');

  function rows() {
    try {
      return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter((r) => r && Object.hasOwn(REJECTION_LAYERS, r.layer));
    } catch { return []; }
  }

  function record(entry = {}) {
    const layer = String(entry?.layer ?? '');
    if (!Object.hasOwn(REJECTION_LAYERS, layer)) return { ok: false, reason: 'unknown_layer' };
    /**
     * 能力页 deny 是「每轮都算一遍」的规则，不是一次性事件；不去重会把
     * 200 条上限瞬间刷满、把 fence / guard 的真事件挤掉。同一条规则 60 秒内只记一次。
     */
    const prior = rows();
    const last = prior[prior.length - 1];
    const dup = last && last.layer === layer
      && last.tool === String(entry.tool ?? '').slice(0, 120)
      && last.rule === String(entry.rule ?? '').slice(0, 160)
      && Number(now()) - Number(last.at || 0) < 60_000;
    if (dup) return { ok: true, row: last, deduped: true };
    const row = {
      at: Number(entry.at ?? now()) || Date.now(),
      layer,
      tool: String(entry.tool ?? '').slice(0, 120),
      bucket: String(entry.bucket ?? '').slice(0, 24),
      rule: String(entry.rule ?? '').slice(0, 160),
    };
    try {
      const next = [...prior, row].slice(-Math.max(1, max));
      const tmp = join(dir, `.ext-rejections.${process.pid}.${randomBytes(3).toString('hex')}.tmp`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, `${next.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      log.warn?.(`拒绝诊断写入失败（旁路，不影响拦截）：${e?.message ?? e}`);
      return { ok: false, reason: 'write_failed', row };
    }
    return { ok: true, row };
  }

  function summary() {
    const all = rows();
    const byLayer = {};
    for (const id of Object.keys(REJECTION_LAYERS)) {
      const one = all.filter((r) => r.layer === id);
      byLayer[id] = { count: one.length, last: one.length ? one[one.length - 1] : null };
    }
    return { total: all.length, byLayer };
  }

  return { file, record, rows, recent: (n = 20) => rows().slice(-Math.max(1, n)).reverse(), summary };
}

/**
 * @param {object} o
 * @param {string} o.dir            数据目录
 * @param {object} o.registry       createExtRegistry() 的实例
 * @param {object} o.clientStore    createClientStore() 的实例
 * @param {object} [o.capStore]     createCapabilityStore() 的实例（诊断用）
 * @param {object} [o.secrets]      createExtSecrets() 的实例（判断令牌是否存在）
 * @param {object} [o.rejections]   createRejectionLog() 的实例
 * @param {object} [o.cfg]          当前 config.json 快照
 * @param {object} [o.quota]        createQuota() 的实例（次数规则摘要）
 * @param {object} [o.extAcl]       覆盖默认 ACL（测试夹具用）
 */
export function createExtPanel({
  dir = dataDir(), registry, clientStore, capStore = null, secrets = null,
  rejections = null, cfg = {}, quota = null, extAcl = DEFAULT_EXT_ACL,
  fallbackProbe = null, now = () => Date.now(), log = () => {},
} = {}) {
  if (!registry || !clientStore) throw new Error('createExtPanel 需要 registry 与 clientStore');

  const manifestPath = (id) => join(registry.pathOf(id), MANIFEST_FILE);
  const sourcePath = (id) => join(registry.pathOf(id), SOURCE_FILE);
  /** cfg 可传快照，也可传 getter（host.js 的 `let cfg` 会在 /config 保存时重读）。 */
  const cfgOf = () => (typeof cfg === 'function' ? cfg() : cfg) ?? {};
  const enabled = () => cfgOf()?.extensions?.enabled === true;

  /** 面板清单：包含总开关状态、usage 预览、字节数、来源与本地修改标注。 */
  function usageRows() {
    const out = registry.list().map((e) => {
      const src = e.source && typeof e.source === 'object' ? e.source : null;
      const usage = String(registry.liveUsage(e.id) ?? '');
      const bytes = Buffer.byteLength(usage, 'utf8');
      /**
       * §3.1：`sha256` 在**清单 plugin.json** 里，`.source.json` 只是来源标记。
       * 上一版读 `src.sha256` 是错的，真实市场装扩展（来源文件只有 repo/tag）
       * 会漏判。清单被改写后校验和必须置空，并在这里如实反映。
       */
      const locallyModified = Boolean(src?.locallyModified || e.manifest?.locallyModified);
      return {
        id: e.id,
        name: String(e.manifest?.name ?? e.id),
        usage,
        bytes,
        chars: Array.from(usage).length,
        cap: USAGE_CHAR_LIMIT,
        truncated: Array.from(usage).length > USAGE_CHAR_LIMIT,
        foreign: Boolean(e.foreign),
        locallyModified,
        sha256Valid: Boolean(e.manifest?.sha256) && !locallyModified,
        label: locallyModified ? LOCALLY_MODIFIED_LABEL : '',
        hasToken: secrets ? Boolean(secrets.read(e.id)?.token) : null,
      };
    });
    return { ok: true, enabled: enabled(), rows: out, totalBytes: out.reduce((n, r) => n + r.bytes, 0) };
  }

  /**
   * 面板保存 usage：写回清单 + 失效市场装扩展的校验和。
   *
   * 顺序很重要：先写 `plugin.json`，再写 `.source.json`。反过来的话，
   * 中途失败会留下「标注已改但正文没改」的状态。两者都是原子写，
   * 但仍按「正文优先」排，最坏情况是校验和没来得及失效（下次编辑会补上）。
   */
  function saveUsage(id, raw) {
    if (!EXT_ID_RE.test(String(id))) return { ok: false, reason: 'bad_id', message: '扩展 id 不合法' };
    /** §8.3：用户手写目录只读，绝不覆盖。install/remove 守住的边界，面板编辑口也得守。 */
    if (registry.isForeign(id)) {
      return { ok: false, reason: 'foreign_readonly', message: '用户手写的扩展只读，面板不改它的清单' };
    }
    const m = readJson(manifestPath(id));
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return { ok: false, reason: 'no_manifest', message: `读不到 ${id} 的 ${MANIFEST_FILE}` };
    }
    const full = String(raw ?? '');
    const chars = Array.from(full);
    const usage = chars.slice(0, USAGE_CHAR_LIMIT).join('');
    const cut = chars.length > USAGE_CHAR_LIMIT;
    if (cut) log.warn?.(`扩展 ${id} 的 usage 超过 ${USAGE_CHAR_LIMIT} 字，已截断保存`);

    /** 有 `.source.json` = 市场装（§8.3）；它里面没有 sha256，校验和在清单里。 */
    const isMarket = fs.existsSync(sourcePath(id));
    const at = now();
    const nextManifest = { ...m, usage };
    if (isMarket) {
      // 清单正文改了，原校验和就等于盖章盖在旧内容上：置空 + 标注。
      nextManifest.sha256 = null;
      nextManifest.locallyModified = true;
      nextManifest.modifiedAt = at;
    }
    try {
      writeJsonAtomic(manifestPath(id), nextManifest, registry.pathOf(id));
    } catch (e) {
      return { ok: false, reason: 'write_manifest_failed', message: `写回清单失败：${e?.message ?? e}` };
    }

    // 「失效」指清单的 sha256 已置空，这一步在上面同步完成；来源文件写失败
    // 只影响标注持久化，不能反过来声称校验和还有效。
    const invalidated = isMarket;
    if (isMarket) {
      try {
        const src = readJson(sourcePath(id));
        writeJsonAtomic(sourcePath(id), {
          ...(src && typeof src === 'object' && !Array.isArray(src) ? src : {}),
          locallyModified: true, modifiedAt: at,
        }, registry.pathOf(id));
        invalidated = true;
      } catch (e) {
        log.warn?.(`扩展 ${id} 的本地修改标注写入失败：${e?.message ?? e}`);
      }
    }

    try { registry.refreshUsage(id); }
    catch (e) { log.warn?.(`扩展 ${id} 的 usage 缓存刷新失败：${e?.message ?? e}`); }

    return {
      ok: true, id, usage, bytes: Buffer.byteLength(usage, 'utf8'),
      truncated: cut, invalidated,
      label: invalidated ? LOCALLY_MODIFIED_LABEL : '',
      message: invalidated ? '已保存；这是市场装的扩展，校验和已失效并标注' : '已保存，下一条消息生效',
    };
  }

  /** 客户端列表：只回非敏感字段，hash / 明文一律不出后端。 */
  function clients() {
    return {
      ok: true,
      availableScopes: [...V1_SCOPES],
      rows: clientStore.list().map((c) => ({
        id: String(c.id ?? ''),
        name: String(c.name ?? ''),
        extId: c.extId ? String(c.extId) : '',
        scopes: Array.isArray(c.scopes) ? [...c.scopes] : [],
        enabled: c.enabled !== false,
        createdAt: Number(c.createdAt) || 0,
        kind: c.extId ? 'ext' : 'panel',
      })),
    };
  }

  /**
   * 面板发放客户端令牌（阶段 3 缺口 2 的落点）。
   *
   * 明文只在**这一次返回值**里出现，`api-clients.json` 只写 hash。
   * 不允许面板创建带 `extId` 的记录：扩展令牌只能由 `install()` 发，
   * 否则面板能自造一个「属于别的扩展」的写入身份，撞 §5.4 的 F9 红线。
   */
  function createClient({ name = '', scopes = [], confirm = false, principal = 'unknown' } = {}) {
    const want = Array.isArray(scopes) ? scopes.map(String) : [];
    const bad = want.filter((s) => !V1_SCOPES.includes(s));
    if (bad.length) return { ok: false, reason: 'bad_scope', message: `未知 scope：${bad.join('、')}` };
    /**
     * §7「最小授权」/ §12「prompt:write / say:write 单独授权、默认关」。
     * 高权限 scope 要「主人 + 二次确认」两道，默认值什么都不给。
     * ⚠️ confirm 是 **UX / 纵深层，不是安全边界**：fence 降级时
     * （§11 坑 5 / fence.js:166-170）本机进程本就能调全部 /quick op、读
     * secrets 明文，自己把 confirm 勾成 true 也拦不住。要真挡需要会话凭证，
     * 那是既有边界、不属本阶段范围，别把这条写成硬承诺。
     */
    const sensitive = want.filter((s) => SENSITIVE_SCOPES.includes(s));
    if (sensitive.length) {
      if (confirm !== true) {
        return { ok: false, reason: 'needs_confirm', message: `高权限 scope 需要二次确认：${sensitive.join('、')}` };
      }
      /**
       * 只挡**明确**的低权档。`fence.js` 已经保证 /quick 的调用方是 owner；
       * 无 PEER 时 `peerSummary()` 返回 'unknown'（§11 坑 5：无 principal 按
       * owner 放行），拿 'unknown' 硬判非 owner 会把正常面板一起挡掉。
       */
      if (['member', 'helper', 'manager', 'admin', 'guest'].includes(String(principal))) {
        return { ok: false, reason: 'not_owner', message: `只有主人能授予高权限 scope：${sensitive.join('、')}` };
      }
    }
    const id = `panel-${randomBytes(6).toString('hex')}`;
    const token = randomBytes(24).toString('base64url');
    try {
      clientStore.add({
        id, name: String(name).slice(0, 60) || id, hash: sha256(token),
        scopes: want, enabled: true, createdAt: now(),
      });
    } catch (e) {
      return { ok: false, reason: 'write_failed', message: `客户端写入失败：${e?.message ?? e}` };
    }
    return {
      ok: true, id, token, scopes: want,
      message: '令牌只显示这一次，请立刻复制保存；服务端只存 hash',
    };
  }

  function revokeClient(id) {
    const one = clientStore.get(String(id ?? ''));
    if (!one) return { ok: false, reason: 'not_found', message: '客户端不存在' };
    if (one.extId) return { ok: false, reason: 'ext_managed', message: '扩展令牌由安装/卸载管理，请卸载该扩展' };
    return { ok: clientStore.revoke(one.id), id: one.id };
  }

  /**
   * 面板状态。判定条件写死为后端审计事件：
   *   · `ext.auth_failed`        → 「扩展鉴权失败」
   *   · `ext.token_regenerated`  → 「令牌已重新生成」
   * **不看** `waiting-credentials`（官方零命中，v3.6 已作废）。
   */
  function status() {
    const authFailed = [];
    const regenerated = [];
    try {
      const lines = fs.readFileSync(join(dir, 'audit.log'), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let r = null;
        try { r = JSON.parse(line); } catch { continue; }
        if (r?.op === 'ext.auth_failed') authFailed.push({ at: Number(r.at) || 0, note: String(r.note ?? '') });
        if (r?.op === 'ext.token_regenerated') regenerated.push({ at: Number(r.at) || 0, note: String(r.note ?? '') });
      }
    } catch { /* 没有审计文件 = 没有事件，不是错误 */ }
    return {
      ok: true,
      authFailed: authFailed.length > 0,
      regenerated: regenerated.length > 0,
      authFailedLast: authFailed.length ? authFailed[authFailed.length - 1] : null,
      regeneratedLast: regenerated.length ? regenerated[regenerated.length - 1] : null,
      hintAuthFailed: '扩展鉴权失败',
      hintRegenerated: '令牌已重新生成',
    };
  }

  /**
   * 「实际生效档位」：把 fallback 退化摆到台面上。
   *
   * §13 记过一条既有边界 —— speaker 缺失路径会静默退回默认档。
   * 这里不猜「会退到哪一档」：用同一份 `resolvePolicy()` 把六档都算一遍，
   * 再显式标出 `speakerKnown === false` 时的兜底档与原因，让退化可见。
   */
  function effectiveBuckets({ chatId = '' } = {}) {
    /**
     * 退化状态**不接受前端自报**：由宿主注入 fallbackProbe 读真实 speaker 表。
     * 上一版靠 `arg.speakerKnown` 传参，前端不传就恒 true，门 G5 的
     * 「bucket fallback 退化可见」在真实面板路径上永远不会出现。
     */
    let probe = { speakerKnown: true, effective: '', activeSessions: null };
    try {
      if (typeof fallbackProbe === 'function') probe = { ...probe, ...(fallbackProbe() ?? {}) };
    } catch (e) {
      log.warn?.(`档位探针失败，按「不退化」展示：${e?.message ?? e}`);
    }
    const store = capStore?.get?.() ?? null;
    const seen = store?.seen?.tools ?? {};
    const pool = Object.keys(seen);
    const rules = {
      deny: [],
      forceDeny: Array.isArray(store?.forceDeny) ? [...store.forceDeny] : [],
    };
    if (store?.defaults && typeof store.defaults === 'object') {
      for (const [b, one] of Object.entries(store.defaults)) {
        if (Array.isArray(one?.deny) && one.deny.length) rules.deny.push({ bucket: b, patterns: [...one.deny] });
      }
    }
    const buckets = BUCKETS.map((b) => {
      const declared = b;
      let allowCount = null;
      let allow = [];
      if (store && pool.length) {
        try {
          const r = resolvePolicy({ pool, bucket: b, chatId, store, forceDeny: rules.forceDeny });
          if (r?.ok && Array.isArray(r.allow)) { allow = [...r.allow]; allowCount = allow.length; }
        } catch { /* 策略算不出来就留 null，不假装知道 */ }
      }
      // allow 给能力页算 dry-run「群友明天会少这 N 个能力」用，不出后端就够。
      return { bucket: b, declared, allowCount, allow };
    });
    const degraded = probe.speakerKnown === false;
    const fallbackBucket = String(probe.effective || 'unknown');
    let fallbackAllow = null;
    if (store && pool.length) {
      try {
        const r = resolvePolicy({ pool, bucket: fallbackBucket, chatId, store, forceDeny: rules.forceDeny });
        if (r?.ok && Array.isArray(r.allow)) fallbackAllow = r.allow.length;
      } catch { /* 算不出就留 null */ }
    }
    return {
      ok: true,
      buckets,
      /** 常驻返回：前端无论退化与否都把兜底档与原因摆出来，不做条件隐藏。 */
      fallback: {
        effective: fallbackBucket,
        degraded,
        activeSessions: probe.activeSessions,
        allowCount: fallbackAllow,
        reason: degraded
          ? '当前没有活跃说话人，档位按兜底值判定（次数限制同样退回默认）；这是 §13 记过的既有边界'
          : '发言人身份正常时按各档自身判定；身份缺失才退到下面的兜底档',
      },
      rules,
      poolSize: pool.length,
    };
  }

  /** 五层来源可分辨：每层给真实规则摘要 + 该层捕获到的事件数。 */
  function diagnose({ limit = 20 } = {}) {
    const snap = rejections?.summary?.() ?? { total: 0, byLayer: {} };
    const store = capStore?.get?.() ?? null;
    const layer = (id, rules, wired = true) => ({
      id,
      label: REJECTION_LAYERS[id],
      rules,
      wired,
      events: snap.byLayer?.[id]?.count ?? 0,
      last: snap.byLayer?.[id]?.last ?? null,
    });
    return {
      ok: true,
      total: snap.total,
      recent: rejections?.recent?.(limit) ?? [],
      layers: [
        layer('fence', [
          `面板 /quick 走 fence() 与 principal 判定；无 principal 按 owner`,
          `/v1 独立 Bearer 令牌体系，401/403/429 均记这一层`,
        ]),
        layer('capabilities', [
          `forceDeny：${JSON.stringify(store?.forceDeny ?? [])}`,
          `各档 deny：${JSON.stringify(store?.defaults ?? {})}`,
          `说明：本层给出的是规则，实际拦截由执行期 guard 兜底并记录`,
        ]),
        layer('quota', [
          `已接线额度项：${JSON.stringify(QUOTA_WIRED)}`,
          `当前覆盖表：${JSON.stringify(quota?.table?.() ?? {})}`,
        ]),
        layer('acl', [
          `四档读写白名单：${JSON.stringify(extAcl?.byBucket ?? {})}`,
          `private 双条件：kind==='c2c' 且档位为 owner/admin`,
        ]),
        layer('guard', [
          `mountToolGuard() 的 ctx.tools.guard 执行期兜底（fail-closed）`,
          `命中规则时返回中文 reason，工具调用被拒`,
        ]),
      ],
    };
  }

  return {
    enabled, usageRows, saveUsage, clients, createClient, revokeClient,
    status, effectiveBuckets, diagnose,
  };
}
