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
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

import { shouldFire } from './speakup.js';
import { chatOf } from './inbound.js';

const MAX_TEXT = 4000;
const MAX_FACT = 500;
const MAX_ROWS = 20;

/**
 * 一次最多发几个文件。
 *
 * 上限不是为了省流量，是为了防「扩展写错循环把整个目录发出去」——
 * 4 个足够「一张图 + 一句语音」，再多就该让扩展自己合并或分批发。
 */
const MAX_FILES = 4;
/** 单个文件上限，与官方软限对齐：再大也会被降级成文件发送，且传得极慢 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * 不许扩展发出去的扩展名。
 *
 * 扩展是第三方代码，`/v1/media` 等于给了它一个「往用户群里投递任意文件」的口子。
 * 允许图片 / 语音 / 视频 / 文档是功能需要；可执行文件没有任何正当用途，
 * 而收到的人点一下就是本机执行——这条黑名单比白名单宽松，但挡住了真正的风险面。
 */
const DENY_EXT = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.jar', '.dll', '.sh', '.app',
]);

const str = (v, max = MAX_TEXT) => String(v ?? '').slice(0, max);
const sceneOf = (body) => (body?.scene === 'group' ? 'group' : 'c2c');
/** 目标优先 `target`，退回 `chatId`（两个名字都收，减少扩展写错的概率）。 */
const targetOf = (body, query) => String(body?.target ?? body?.chatId ?? query?.target ?? query?.chatId ?? '').trim();

/**
 * 官方图文卡片（`msg_type=8`）的字段校验。
 *
 * 平台侧对卡片参数不合格只会回一句笼统的 `304061`，从错误码看不出是
 * 标题超了还是链接不是 https。所以在这里逐条挡，把具体原因回给扩展——
 * 扩展的作者看到「title 最多 50 字」才知道怎么改。
 *
 * 四个字段全必填是官方口径（`msg.replyTuwen` 的注释也写着），少一个
 * 发出去就是一条空白卡片，比不发更糟。
 *
 * @returns {string} 空串 = 没问题
 */
export function tuwenProblem(card) {
  const t = String(card?.title ?? '').trim();
  const d = String(card?.description ?? '').trim();
  const u = String(card?.url ?? '').trim();
  /** `picUrl` 是扩展写的，`pic_url` 是官方字段名，两个都认 */
  const p = String(card?.picUrl ?? card?.pic_url ?? '').trim();
  if (!t) return '缺 title';
  if (!d) return '缺 description';
  if (!u) return '缺 url';
  if (!p) return '缺 picUrl';
  if ([...t].length > 50) return `title 最多 50 字（现在 ${[...t].length} 字）`;
  if ([...d].length > 200) return `description 最多 200 字（现在 ${[...d].length} 字）`;
  for (const [name, v] of [['url', u], ['picUrl', p]]) {
    if (!/^https:\/\//i.test(v)) return `${name} 必须是 https 地址`;
    if (v.length > 1024) return `${name} 最多 1024 字符`;
  }
  return '';
}

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
  channelOf = null,
  speakUpOf = null,
  /**
   * 出站动作层（`createActionRunner` 的产物）。
   *
   * 发文件走它而不是直接 `channel.sendFile`：`outActions` 里还管着「同一张图
   * 不重复发」的去重、`onSent` 的冷却记录、以及 `requestId` 透传给账本。
   * 绕过它自己调 sendFile，这些都会静默缺失。
   */
  outActionsOf = null,
  /** 扩展数据根目录（`<dataDir>/extensions/<id>/` 的上一层）。发文件要校验越界 */
  dataDirOf = () => '',
  agentFor = null,
  mount = null,
  onInbound = null,
  lastBucketOf = () => '',
  setupOf = () => ({}),
  log = () => {},
} = {}) {
  /**
   * 校验「扩展要发的这个文件」确实在它自己的目录里。
   *
   * 三道关，缺一不可：
   *   1. `resolve()` 先挡住 `../` —— 相对路径拼出来跑出目录的直接不认；
   *   2. `realpathSync()` 再解软链 —— 扩展可以在自己目录里建一个指向
   *      `C:\Users\…\身份证.jpg` 的符号链接，只查字符串前缀是挡不住的；
   *   3. 大小与扩展名 —— 见 `DENY_EXT` 的注释。
   *
   * Windows 大小写不敏感，前缀比较统一转小写；`sep` 要带上，否则
   * `…/extensions/bili-evil` 会被认成在 `…/extensions/bili` 下面。
   *
   * @returns {{ok:true, file:string, bytes:number}|{ok:false, reason:string}}
   */
  const checkExtFile = (extId, input) => {
    const raw = String(input ?? '').trim();
    if (!raw) return { ok: false, reason: '文件路径是空的' };

    const base = String(dataDirOf() || '').trim();
    if (!base) return { ok: false, reason: '宿主数据目录不可用', internal: true };

    const rootRaw = join(base, 'extensions', extId);
    if (!existsSync(rootRaw)) return { ok: false, reason: `扩展 ${extId} 的目录不存在` };

    let root;
    try { root = realpathSync(rootRaw); } catch (e) {
      return { ok: false, reason: `读不到扩展目录：${e?.message ?? e}`, internal: true };
    }

    const abs = resolve(root, raw);
    if (!existsSync(abs)) return { ok: false, reason: `文件不存在：${raw}` };

    let real;
    try { real = realpathSync(abs); } catch (e) {
      return { ok: false, reason: `读不到文件：${e?.message ?? e}` };
    }

    const lowerRoot = root.toLowerCase();
    const lowerReal = real.toLowerCase();
    if (lowerReal !== lowerRoot && !lowerReal.startsWith(lowerRoot.endsWith(sep) ? lowerRoot : lowerRoot + sep)) {
      return { ok: false, reason: '只能发扩展自己目录里的文件' };
    }

    let st;
    try { st = statSync(real); } catch (e) {
      return { ok: false, reason: `读不到文件信息：${e?.message ?? e}` };
    }
    if (!st.isFile()) return { ok: false, reason: '只能发文件，不能发目录' };
    if (st.size > MAX_FILE_BYTES) {
      return { ok: false, reason: `文件太大（${Math.round(st.size / 1024 / 1024)}MB，上限 20MB）` };
    }
    if (DENY_EXT.has(extname(real).toLowerCase())) {
      return { ok: false, reason: `不许发可执行文件（${extname(real)}）` };
    }
    return { ok: true, file: real, bytes: st.size };
  };

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
      /**
       * **不许写 `global`。** 全局记忆是所有会话共享的一份，扩展有了
       * `memory:write`（默认就给了）就能污染每一个群 —— 这是权限放大。
       * 要写自己的东西请走 `/v1/memory/ext.add`（extId 由令牌绑定）。
       */
      if (body?.scope === 'global') {
        return bad('扩展不能写全局记忆（会影响所有会话）；要记自己的东西请用 /v1/memory/ext.add', 403, 'forbidden');
      }
      const fact = String(body?.fact ?? body?.text ?? '').trim().slice(0, MAX_FACT);
      if (!fact) return bad('缺 fact / text');
      const scope = 'chat';
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
      const text = String(body?.text ?? '').slice(0, MAX_TEXT).trim();
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
     * 扩展直接往会话发东西：文本 / 文件 / 官方图文卡片，**不跑模型**。
     *
     * 三条内容至少给一个。文本与文件可以同发（先文本后文件，和模型回话的
     * 顺序一致）；卡片独占一条消息——平台侧一条消息只有一种富文本。
     *
     * 文件只认扩展自己目录里的（见 `checkExtFile`）：这是这个端点唯一
     * 能造成「往外投递任意文件」的口子，必须卡死在扩展自己的地盘里。
     */
    async send({ body, client }) {
      const scene = sceneOf(body);
      const target = targetOf(body);
      if (!target) return bad('缺 target / chatId');

      const text = str(body?.text, MAX_TEXT).trim();
      const card = body?.card && typeof body.card === 'object' && !Array.isArray(body.card) ? body.card : null;
      const rawFiles = Array.isArray(body?.files) ? body.files : [];
      if (!text && !card && !rawFiles.length) return bad('text / files / card 至少给一个');
      if (rawFiles.length > MAX_FILES) return bad(`一次最多发 ${MAX_FILES} 个文件`);
      if (card) {
        const why = tuwenProblem(card);
        if (why) return bad(`图文卡片不合格：${why}`);
      }

      /** 文件必须在扩展自己的目录里；没绑 extId 的令牌（面板客户端）一律不许发文件 */
      const checked = [];
      if (rawFiles.length) {
        const extId = String(client?.extId ?? '').trim();
        if (!extId) return bad('这个令牌没有绑定扩展，不能发文件', 403, 'forbidden');
        for (const one of rawFiles) {
          const v = checkExtFile(extId, one);
          if (!v.ok) {
            return v.internal ? bad(v.reason, 500, 'internal') : bad(v.reason, 400);
          }
          checked.push(v.file);
        }
      }

      let hasGroupAuthz = true;
      if (scene === 'group') {
        try { hasGroupAuthz = Boolean(memory().hasAuthz(target, 'group_push', aliasesOf(target))); }
        catch (e) { return bad(`查群授权失败：${e?.message ?? e}`, 500, 'internal'); }
        if (!hasGroupAuthz) {
          return bad('这个群没有 group_push 授权，主动消息发不出去', 403, 'forbidden');
        }
      }

      const requestId = str(body?.requestId, 80);
      const out = { ok: true, scene, target, text: null, files: [], card: null };

      try {
        const ch = channel().get?.();
        if (!ch) return bad('发送通道不可用', 500, 'internal');

        /** ① 文本：有 card 就不发正文（一条消息只能一种富文本） */
        if (text && !card) {
          const r = await ch.send({ scene, target, text, hasGroupAuthz, requestId });
          out.text = { ok: Boolean(r?.ok), id: String(r?.id ?? ''), message: r?.message ?? '' };
          if (!r?.ok) out.ok = false;
        }

        /** ② 文件：走 outActions，它管着去重、冷却记录和账本 requestId */
        if (checked.length) {
          const run = typeof outActionsOf === 'function' ? outActionsOf() : null;
          if (typeof run !== 'function') return bad('出站动作层不可用', 500, 'internal');
          const r = await run({ text: '', extra: { files: checked, requestId }, scene, target });
          out.files = checked.map((f) => ({ file: f, ok: Boolean(r?.ok) }));
          if (!r?.ok) out.ok = false;
        }

        /** ③ 卡片：独占一条 */
        if (card) {
          const r = await ch.send({
            scene,
            target,
            hasGroupAuthz,
            requestId,
            card: {
              title: String(card.title).trim(),
              description: String(card.description).trim(),
              url: String(card.url).trim(),
              picUrl: String(card.picUrl ?? card.pic_url).trim(),
            },
          });
          out.card = { ok: Boolean(r?.ok), id: String(r?.id ?? ''), message: r?.message ?? '' };
          if (!r?.ok) out.ok = false;
        }
      } catch (e) {
        return bad(`发送失败：${e?.message ?? e}`, 500, 'internal');
      }

      return { status: out.ok ? 200 : 400, body: out };
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
      const text = String(body?.text ?? '').slice(0, MAX_TEXT).trim();
      if (!text) return bad('缺 text');
      if (typeof onInbound !== 'function') return bad('入站链路不可用', 500, 'internal');

      const payload = {
        /**
         * `id` 必须给且唯一：`handleTurn` 用它派生 `requestId`（`${payload.id}:main`）
         * 和 journal 的主键。缺了会变成 `undefined:main` —— 所有 `/v1/message`
         * 共用同一个投递 id，从第二条起被框架的幂等账本当重复而静默丢弃。
         */
        id: `api-${String(client?.extId ?? 'ext')}-${randomUUID()}`,
        /** `target` 是宿主的「这条消息发往哪里」，`handleTurn` 用它记 pending / awake。 */
        target,
        /**
         * **正文写在 `text` 里**。`renderInbound()` 只读 `p.text`
         * （`inbound.js:13`）；写成 `said` 会让模型收到空消息 —— 上一版就是
         * 这个错，测试因为断言自己造的字段而没抓到。
         */
        text,
        said: text,
        chat: {
          chatId: target,
          kind: scene,
          uin: '',
          groupUin: scene === 'group' ? target : '',
          aliases: [],
        },
        sender: { bucket: 'member', level: '', name: str(body?.senderName, 40) || '扩展消息' },
        /**
         * 扩展没有 HTTP 回话窗口，`reply` 留空；`postReply` 见到
         * `__channel.send` 就改走发送通道（`server.js` 的回退分支）。
         * 这里给的是**函数**而不是 URL —— 回话地址一旦外部可控就是 SSRF 面。
         */
        reply: null,
        __channel: {
          send: async (replyText, meta) => {
            const ch = channel().get?.();
            if (!ch?.send) return { ok: false, message: '发送通道不可用' };
            let authz = true;
            if (scene === 'group') {
              try { authz = Boolean(memory().hasAuthz(target, 'group_push', aliasesOf(target))); }
              catch { authz = false; }
            }
            return await ch.send({
              scene,
              target,
              text: replyText,
              hasGroupAuthz: authz,
              /** 转交框架投递账本的幂等键（`postReply` 传进来的 `extra.requestId`）。 */
              requestId: str(meta?.requestId, 80),
            });
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
        /**
         * 优先用 `speakUp.canFire()`：它内部用的是 `cfgNow()` —— 已合并 `DEFAULTS`
         * 并从 `ownerOf()` 补好 `chatId`。自己拿 `cfgOf().speakUp` 拼会漏掉这两步，
         * 结果是「配置里没写 chatId」时端点永远回 429，看起来像频次拦的，实际是配置没读到。
         */
        decision = typeof sp.canFire === 'function'
          ? sp.canFire()
          : shouldFire(sp.state?.() ?? {}, cfgOf()?.speakUp ?? {}, Date.now());
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
      /**
       * 用真实的 `chatOf()` 构造，不要手写：
       * 它会按 kind 派生 `preset`（c2c → `roost-private`，group → `roost-social`）
       * 以及 `identityId`。手写漏了 `preset`，`agentFor()` 就会用默认人格建会话 ——
       * 表面上「会话建好了」，实际上跟真人说话时用的不是同一个人格。
       */
      const chat = chatOf({
        chat: {
          chatId,
          kind: body?.kind === 'c2c' ? 'c2c' : 'group',
          name: str(body?.name, 60),
        },
      });
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
