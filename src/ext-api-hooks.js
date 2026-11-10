/**
 * `/v1` 业务端点实现（阶段 8：把自重查出来的「10 条恒 501」补上）。
 *
 * 为什么单开一个模块而不是往 `host.js` 里塞 9 个 hook：
 *   1. 这些 hook 要碰 mood / memory / journal / channel / speakUp / agentFor，
 *      全塞进 `host.js` 会让那个已经 7000 行的文件再胀一圈；
 *   2. 抽出来后每个端点都能用假依赖单测，不必起整个宿主；
 *   3. **安全守卫集中在一处**，review 时一眼能看完。
 *
 * 四条硬约束（都是自查时发现的，别改回去）：
 *
 *  1. **`sender` 绝不能来自请求体。** `bucketOf()` 直接信任 `payload.sender.bucket`
 *     （`permissions.js:355`），把外部输入透进去等于「扩展自报 owner 就拿到主人档」。
 *     这里一律写成最低档 `member`，扩展想要更高能力只能靠 scope，不靠自称。
 *  2. **主动消息必须先过 `shouldFire()`。** `speakUp.fire()` 本身跳过清醒时段 /
 *     今日次数 / 静默 / 免打扰（`speakup.js:225` 的注释写明面板「立刻走一次」
 *     就是直调它）。绕过去就是刷屏入口。
 *  3. **群主动必须真算 `group_push` 授权。** `channel.send()` 的 `hasGroupAuthz`
 *     默认 `true`，传默认值等于跳过官方硬前置。
 *  4. **`/v1/message` 的回复走通道回退**，不让扩展指定回话地址 ——
 *     `postReply` 收的是 `payload.reply.url` 的 HTTP 地址，外部可控就是 SSRF 面。
 */
import { shouldFire } from './speakup.js';

const MAX_TEXT = 4000;
const MAX_FACT = 500;
const MAX_ROWS = 20;

const str = (v, max = MAX_TEXT) => String(v ?? '').slice(0, max);
const sceneOf = (body) => (body?.scene === 'group' ? 'group' : 'c2c');
/** 目标优先 `target`，退回 `chatId`（两个名字都收，减少扩展写错的概率）。 */
const targetOf = (body, query) => String(body?.target ?? body?.chatId ?? query?.target ?? query?.chatId ?? '').trim();

/**
 * @param {object} deps 全部是**函数**，在调用时才求值 ——
 *   `host.js` 里这些实例（mood / memory / channels / speakUp）都声明在本模块
 *   之后，直接传值会撞 TDZ。
 */
export function createExtApiHooks({
  cfgOf = () => ({}),
  moodOf = () => ({}),
  moodTextOf = () => '',
  memoryOf = null,
  journalOf = null,
  aliasesOf = () => [],
  capStoreOf = () => null,
  channelOf = null,
  speakUpOf = null,
  agentFor = null,
  mount = null,
  onInbound = null,
  bucketOfFn = null,
  lastBucketOf = () => '',
  setupOf = () => ({}),
  usedChatMemoryOf = null,
  log = () => {},
} = {}) {
  const memory = () => {
    if (typeof memoryOf !== 'function') throw new Error('记忆服务不可用');
    return memoryOf();
  };
  const journal = () => {
    if (typeof journalOf !== 'function') throw new Error('日记服务不可用');
    return journalOf();
  };
  const channel = () => {
    if (typeof channelOf !== 'function') throw new Error('发送通道不可用');
    return channelOf();
  };

  /** 统一的业务错误返回（400 = 参数问题，可让扩展自己改；500 才是宿主故障）。 */
  const bad = (message, status = 400, error = 'bad_request') => ({ status, body: { ok: false, error, message } });

  return {
    /** 只读：在线 / 绑定 / 心情 / 最近一次说话的档位。 */
    async state() {
      const setup = setupOf() ?? {};
      let owner = false;
      try { owner = Boolean(String(setup.roostOwner?.() ?? '').trim()); } catch { /* 未就绪 */ }
      return {
        status: 200,
        body: {
          ok: true,
          mood: moodOf() ?? {},
          moodText: String(moodTextOf() ?? ''),
          bindings: {
            roostOwner: owner,
            ownersConfigured: Boolean(setup.ownersConfigured),
          },
          /**
           * 档位只给「最近一次真实说话的档位」，并显式标注它不是当前请求的。
           * 扩展没有 QQ 身份，硬编一个档位回去只会让人误会。
           */
          lastBucket: String(lastBucketOf() ?? ''),
          lastBucketNote: '这是宿主最近一次处理真实消息时的档位，不代表本请求的身份',
        },
      };
    },

    /** 只读：心情。 */
    async mood() {
      return { status: 200, body: { ok: true, ...(moodOf() ?? {}) } };
    },

    /** 只读：会话上下文摘要（最近 N 条，正文截断）。 */
    async context({ body, query }) {
      const chatId = targetOf(body, query);
      if (!chatId) return bad('缺 chatId / target');
      const limit = Math.min(Math.max(Number(body?.limit) || 10, 1), MAX_ROWS);
      let rows = [];
      try { rows = journal().recent(chatId, limit, 'chat', aliasesOf(chatId)) ?? []; }
      catch (e) { return bad(`读上下文失败：${e?.message ?? e}`, 500, 'internal'); }
      return {
        status: 200,
        body: {
          ok: true,
          chatId,
          count: rows.length,
          recent: rows.map((r) => ({
            at: Number(r?.at) || 0,
            text: str(r?.text, 200),
          })),
        },
      };
    },

    /** 只读：会话记忆（重要度 × 时间衰减排序，**只给活的**）。 */
    async 'memory.read'({ body, query }) {
      const chatId = targetOf(body, query);
      if (!chatId) return bad('缺 chatId / target');
      const scope = body?.scope === 'global' ? 'global' : 'both';
      let ranked = { global: [], chat: [] };
      try { ranked = memory().listRanked(chatId, aliasesOf(chatId)) ?? ranked; }
      catch (e) { return bad(`读记忆失败：${e?.message ?? e}`, 500, 'internal'); }
      const out = {
        ok: true,
        chatId,
        global: scope === 'chat' ? [] : (ranked.global ?? []).slice(0, MAX_ROWS).map((t) => str(t, 300)),
        chat: scope === 'global' ? [] : (ranked.chat ?? []).slice(0, MAX_ROWS).map((t) => str(t, 300)),
      };
      return { status: 200, body: out };
    },

    /** 写：往会话记忆里加一条（走既有 `memory.add`，不另开存储）。 */
    async 'memory.write'({ body, query }) {
      const chatId = targetOf(body, query);
      if (!chatId) return bad('缺 chatId / target');
      const fact = String(body?.fact ?? body?.text ?? '').trim().slice(0, MAX_FACT);
      if (!fact) return bad('缺 fact / text');
      const scope = body?.scope === 'global' ? 'global' : 'chat';
      try { memory().add(chatId, fact, scope, { w: 1, src: { via: 'ext-api' } }); }
      catch (e) { return bad(`写记忆失败：${e?.message ?? e}`, 500, 'internal'); }
      return { status: 200, body: { ok: true, chatId, scope, chars: [...fact].length } };
    },

    /**
     * 让机器人主动说一句。
     *
     * 群场景**必须**真算 `group_push` 授权：`channel.send()` 的默认值是 `true`，
     * 照默认传等于跳过官方硬前置，发不出去还要等到上游报错。
     */
    async say({ body, query }) {
      const scene = sceneOf(body);
      const target = targetOf(body, query);
      if (!target) return bad('缺 target / chatId');
      const text = String(body?.text ?? '').trim();
      if (!text) return bad('缺 text');

      let hasGroupAuthz = true;
      if (scene === 'group') {
        try { hasGroupAuthz = Boolean(memory().hasAuthz(target, 'group_push', aliasesOf(target))); }
        catch (e) { return bad(`查群授权失败：${e?.message ?? e}`, 500, 'internal'); }
        if (!hasGroupAuthz) {
          return bad('这个群没有 group_push 授权，主动消息发不出去', 403, 'forbidden');
        }
      }

      try {
        const ch = channel().get?.();
        if (!ch?.send) return bad('发送通道不可用', 500, 'internal');
        const r = await ch.send({
          scene,
          target,
          text,
          hasGroupAuthz,
          requestId: str(body?.requestId, 80),
        });
        return { status: r?.ok ? 200 : 400, body: r ?? { ok: false, message: '发送通道没有返回结果' } };
      } catch (e) {
        return bad(`发送失败：${e?.message ?? e}`, 500, 'internal');
      }
    },

    /**
     * 投递一条消息进 QQ 会话，跑完整一轮，回复发回同一目标。
     *
     * `sender.bucket` **写死 `member`**：`bucketOf()` 信任 payload 里的这个字段，
     * 一旦让它来自请求体，扩展自报 `owner` 就能以主人身份跑这一轮（拿到
     * `edit` / `write` / `bash` 这些工具）。要更高能力请走 scope，不靠自称。
     */
    async message({ body, client }) {
      const scene = sceneOf(body);
      const target = targetOf(body);
      if (!target) return bad('缺 target / chatId');
      const text = String(body?.text ?? '').trim();
      if (!text) return bad('缺 text');
      if (typeof onInbound !== 'function') return bad('入站链路不可用', 500, 'internal');

      const payload = {
        chat: {
          chatId: target,
          kind: scene,
          uin: '',
          groupUin: scene === 'group' ? target : '',
          aliases: [],
        },
        sender: { bucket: 'member', level: '', name: str(body?.senderName, 40) || '扩展消息' },
        said: text,
        /**
         * 扩展没有 ai-chat 的回话窗口，`reply` 留空；`postReply` 见到
         * `__channel.send` 就改走发送通道（`server.js` 的回退分支）。
         * 这里给的是**函数**而不是 URL —— 回话地址一旦外部可控就是 SSRF 面。
         */
        reply: null,
        __channel: {
          send: async (replyText) => {
            const ch = channel().get?.();
            if (!ch?.send) return { ok: false, message: '发送通道不可用' };
            let authz = true;
            if (scene === 'group') {
              try { authz = Boolean(memory().hasAuthz(target, 'group_push', aliasesOf(target))); }
              catch { authz = false; }
            }
            return await ch.send({ scene, target, text: replyText, hasGroupAuthz: authz });
          },
        },
        __fromApi: { extId: client?.extId ?? null },
      };

      try { onInbound(payload); }
      catch (e) { return bad(`投递失败：${e?.message ?? e}`, 500, 'internal'); }
      return {
        status: 202,
        body: {
          ok: true,
          accepted: true,
          target,
          note: '已入队；这一轮结束后回复会发到同一目标（异步，不在本响应里返回正文）',
        },
      };
    },

    /**
     * 主动消息。
     *
     * **先 `shouldFire()` 再 `fire()`**：`fire()` 自身跳过清醒时段、今日次数、
     * 静默期、免打扰、主人刚说过话这五道门。直调它等于给扩展一个刷屏开关。
     */
    async proactive() {
      if (typeof speakUpOf !== 'function') return bad('主动消息模块不可用', 500, 'internal');
      const sp = speakUpOf();
      if (!sp?.fire) return bad('主动消息模块不可用', 500, 'internal');
      let decision;
      try {
        decision = shouldFire(sp.state?.() ?? {}, cfgOf()?.speakUp ?? {}, Date.now());
      } catch (e) {
        return bad(`判定主动消息能否发送失败：${e?.message ?? e}`, 500, 'internal');
      }
      if (!decision?.fire) {
        return {
          status: 429,
          body: { ok: false, error: 'rate_limited', message: `现在不能主动说话：${decision?.why ?? '未到时间'}` },
        };
      }
      try {
        const r = await sp.fire('api');
        return { status: r?.ok ? 200 : 400, body: r ?? { ok: false, message: '没有返回结果' } };
      } catch (e) {
        return bad(`主动消息发送失败：${e?.message ?? e}`, 500, 'internal');
      }
    },

    /** 确保会话存在（建/复用 DSH 会话并挂好工具），不跑模型。 */
    async 'session.ensure'({ body, query }) {
      const chatId = targetOf(body, query);
      if (!chatId) return bad('缺 chatId / target');
      if (typeof agentFor !== 'function') return bad('会话服务不可用', 500, 'internal');
      const chat = {
        kind: body?.kind === 'c2c' ? 'c2c' : 'group',
        chatId,
        name: str(body?.name, 60) || chatId,
      };
      try {
        const { agent } = await agentFor(chat);
        if (typeof mount === 'function' && agent) mount(agent, chat);
        /**
         * 工具是异步挂的：不等这一下，扩展紧接着发 `/v1/message` 会拿到空工具表。
         * 这里只等「挂完」，不跑任何模型轮次。
         */
        return { status: 200, body: { ok: true, chatId, kind: chat.kind, ready: true } };
      } catch (e) {
        return bad(`确保会话失败：${e?.message ?? e}`, 500, 'internal');
      }
    },
  };
}
