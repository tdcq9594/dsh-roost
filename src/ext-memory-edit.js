/**
 * 扩展侧的记忆编辑（`GET /v1/memory/facts` + `POST /v1/memory/facts/edit`）
 * ========================================================================
 *
 * ## 为什么单独一组，不并进 `/v1/memory`
 *
 * 老的 `GET /v1/memory` 把事实映射成**纯字符串数组**（`listRanked` 出来就
 * `.map(t => str(t, 300))`），id 被丢掉了。于是扩展「读到了」却**没法表达
 * 『改哪一条』**——这正是「面板能改、扩展只能看」的根源。
 *
 * 但那个形状有存量扩展在用，不能改。所以另开 `/v1/memory/facts`：
 * 带 id、带层级、带归档状态，可以按会话/全局筛，可以分页。
 *
 * ## 为什么「删除」是归档而不是抹掉
 *
 * 记忆系统本来就是「归档不删」：`editFact({archivedAt})` 让一条事实不再注入
 * 提示词，但原文还在，用户反悔能捞回来（面板的「归档」就是这件事）。
 * 真删只有 `memory.remove(chatId, word)`，它是**关键词 `includes` 匹配**，
 * 删「约定：A」会顺手删掉「约定：A 补充」——这种破坏性不该开给扩展。
 * 所以这里只暴露归档 / 恢复。
 *
 * ## 安全
 *
 * · **只能改会话那一层**：`memory:write` 是扩展的默认 scope，放开全局等于
 *   让任何装上就有的扩展污染所有会话共享的记忆（`/v1/memory` 早就禁止了，
 *   这里不另开口子）。读全局可以，改不行；
 * · `chatId` 会进 `chatKeys()` 拼键，挡原型污染三个名字；
 * · `chatId` **不截断**：超长报错。截短后的 id 可能正好等于另一个真实会话，
 *   于是「改 A 群记忆」变成「改 B 群」；
 * · 定位只认 id / 完全相等的正文（`editFact` 内部就是这么判的），
 *   不做模糊匹配——模糊匹配会误伤相近的两条。
 */

/** 一次最多返回多少条（再多调用方该分页了） */
export const MAX_FACT_ROWS = 200;
/** 默认一页 */
export const DEFAULT_FACT_ROWS = 50;
/** 一条事实的正文上限（字符）：记忆条目本来就该短，写成长文说明该进日记 */
export const MAX_FACT_CHARS = 2000;
/** 会话 id 上限。官方 openid 三四十字符，128 已经很宽松 */
export const MAX_CHAT_ID = 128;

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FACT_TIERS = ['short', 'long', 'core'];

function bad(message, status = 400, error = 'bad_request') {
  return { status, body: { ok: false, error, message } };
}

const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);

/**
 * 读会话 id：**不截断**，超长直接报错。
 * 截断后的 id 可能正好等于另一个真实会话，于是「改 A 群记忆」变成「改 B 群」。
 */
function readChatId(raw) {
  const v = String(raw ?? '').trim();
  if (v.length > MAX_CHAT_ID) {
    return { error: `chatId 太长了（${v.length} 字符，上限 ${MAX_CHAT_ID}）` };
  }
  return { value: v };
}

/** 统一一条事实的形状，别把内部字段（until / src / w）漏出去 */
function shape(scope, chatId, x) {
  return {
    id: String(x?.id ?? ''),
    scope,
    ...(chatId ? { chatId } : {}),
    text: String(x?.text ?? ''),
    at: Number(x?.at) || 0,
    tier: String(x?.tier || 'long'),
    pin: Number(x?.pin) || 0,
    brightness: Number(x?.brightness) || 0,
    /** 归档 = 不再注入提示词，但原文还在 */
    archived: Boolean(x?.until || x?.archivedAt),
  };
}

/**
 * @param {object} p
 * @param {()=>object} p.memoryOf        `createMemory()` 实例（listFull / editFact）
 * @param {(chatId:string)=>string[]} p.aliasesOf
 * @param {(m:string)=>void} [p.log]
 */
export function createExtMemoryEdit({ memoryOf, aliasesOf = () => [], log = () => {} } = {}) {
  if (typeof memoryOf !== 'function') throw new Error('记忆编辑接口需要 memoryOf');
  const mem = () => memoryOf();

  return {
    /**
     * `GET /v1/memory/facts` —— 带 id 的事实列表。
     *
     * 参数：`chatId`（给了才看会话层）、`scope=global|chat|both`（默认 both）、
     * `q`（正文包含，大小写不敏感）、`limit`（默认 50，上限 200）、`offset`、
     * `includeArchived=1`（默认不返回已归档的）。
     */
    async 'memory.facts'({ query } = {}) {
      const got = readChatId(query?.chatId);
      if (got.error) return bad(got.error);
      const chatId = got.value;
      if (chatId && BAD_KEYS.has(chatId)) return bad('chatId 不合法');
      const scope = ['global', 'chat', 'both'].includes(str(query?.scope, 10))
        ? str(query?.scope, 10)
        : 'both';
      if (scope !== 'global' && !chatId) return bad('看会话记忆要给 chatId；只想看全局就传 scope=global');

      const limit = Math.min(Math.max(Number(query?.limit) || DEFAULT_FACT_ROWS, 1), MAX_FACT_ROWS);
      const offset = Math.max(Number(query?.offset) || 0, 0);
      const kw = str(query?.q, 200).toLowerCase();
      const includeArchived = String(query?.includeArchived ?? '') === '1'
        || String(query?.includeArchived ?? '') === 'true';

      let full = { global: [], chat: [] };
      try {
        full = mem().listFull(chatId, aliasesOf(chatId)) ?? full;
      } catch (e) {
        return bad(`读记忆失败：${e?.message ?? e}`, 500, 'internal');
      }

      const rows = [];
      if (scope !== 'chat') for (const x of full.global ?? []) rows.push(shape('global', '', x));
      if (scope !== 'global') for (const x of full.chat ?? []) rows.push(shape('chat', chatId, x));

      const filtered = rows
        .filter((r) => (includeArchived ? true : !r.archived))
        .filter((r) => (kw ? r.text.toLowerCase().includes(kw) : true))
        .sort((a, b) => (b.at || 0) - (a.at || 0));

      return {
        status: 200,
        body: {
          ok: true,
          chatId: chatId || null,
          scope,
          total: filtered.length,
          hasMore: offset + limit < filtered.length,
          items: filtered.slice(offset, offset + limit),
        },
      };
    },

    /**
     * `POST /v1/memory/facts/edit` —— 改一条事实。
     *
     * 入参：`{ id | key, scope?, chatId?, text?, pin?, tier?, archived? }`
     *
     * `archived: true` = 归档（不再注入，可恢复）；`archived: false` = 恢复。
     * **没有「硬删」**，理由见文件头。
     */
    async 'memory.edit'({ body } = {}) {
      const b = body && typeof body === 'object' ? body : {};
      const key = str(b.id ?? b.key, 400);
      if (!key) return bad('缺 id（或 key = 完全相等的正文）');

      /**
       * **不许改全局记忆。** 和 `POST /v1/memory` 同一条线。
       *
       * `memory:write` 是扩展的**默认 scope**（`EXT_DEFAULT_SCOPES` 就带它），
       * 也就是说：一旦允许改全局，**任何装上就有的扩展**都能归档 / 改写
       * 「所有会话共享」的那层事实，主人根本没被问过。这是权限放大，不是
       * 便利。要记自己的东西走 `/v1/memory/ext.add`（extId 由令牌绑定）。
       *
       * 读全局是允许的（`memory.facts` + `scope:global`）——读不改变任何状态。
       */
      if (b.scope === 'global') {
        return bad(
          '扩展不能改全局记忆（会影响所有会话）；要记自己的东西请用 /v1/memory/ext.add',
          403,
          'forbidden',
        );
      }

      const scope = 'chat';
      const got = readChatId(b.chatId);
      if (got.error) return bad(got.error);
      const chatId = got.value;
      if (chatId && BAD_KEYS.has(chatId)) return bad('chatId 不合法');
      if (!chatId) return bad('改记忆要给 chatId（只能改某个会话的那层）');

      const patch = {};
      if (b.text !== undefined) {
        /** 同样不 `slice`：按码点判长度，超了报错而不是悄悄截短 */
        const text = String(b.text ?? '').trim();
        if (!text) return bad('text 不能是空的（要让它不再出现请用 archived: true）');
        const chars = Array.from(text).length;
        if (chars > MAX_FACT_CHARS) {
          return bad(`这条事实太长了（${chars} 字，上限 ${MAX_FACT_CHARS}）`);
        }
        patch.text = text;
      }
      if (b.pin !== undefined) {
        const pin = Number(b.pin);
        if (!Number.isFinite(pin) || pin < 0 || pin > 1) return bad('pin 是 0–1 的数');
        patch.pin = pin;
      }
      if (b.tier !== undefined) {
        if (!FACT_TIERS.includes(String(b.tier))) return bad(`tier 只能是 ${FACT_TIERS.join(' / ')}`);
        patch.tier = String(b.tier);
      }
      if (b.archived !== undefined) patch.archivedAt = b.archived === true ? Date.now() : 0;

      if (!Object.keys(patch).length) return bad('没有要改的项：text / pin / tier / archived 至少给一个');

      let r;
      try {
        r = mem().editFact(chatId, scope, key, patch, aliasesOf(chatId));
      } catch (e) {
        return bad(`改记忆失败：${e?.message ?? e}`, 500, 'internal');
      }
      if (!r?.ok) return bad(r?.message || '没改成功');
      log(`[ext-memory] 扩展改记忆 ${scope}：${Object.keys(patch).join(',')}`);
      return {
        status: 200,
        body: {
          ok: true,
          id: String(r.id ?? ''),
          scope,
          text: String(r.text ?? ''),
          tier: String(r.tier ?? ''),
          pin: Number(r.pin) || 0,
          archived: Boolean(r.archivedAt),
          message: '已保存',
        },
      };
    },
  };
}
