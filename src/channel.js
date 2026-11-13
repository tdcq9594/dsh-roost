/**
 * 通道抽象：把「怎么把话说出去」和「说什么」分开。
 *
 * 为什么抽这一层：主动说话、面板测试消息、扩展回话三处都要发消息，
 * 散着写必然重复；能力表和降级链也只该维护一份。
 *
 * **capabilities 必须如实声明**，这是这层最重要的东西：
 * QQ 没有"拍一拍"、没有"合并转发"、没有历史消息接口。
 * 上层如果不知道，就会写出"调一个根本不存在的功能"的代码，
 * 而失败方式还是静默的（`poke: false` 之后什么都不发生）。
 * 所以能力表先摆出来，上层用之前先问。
 *
 * 这一层不做重试、不做限频——那是调用方的事（官方配额是按关系/按群算的，
 * 只有调用方知道自己在花谁的额度）。这里只负责：能发、不能说清楚为什么不能发。
 */

/**
 * QQ 的真实能力表。**每一项都要有出处**（`docs/官方接口限制.md` / `src/endpoints.js`）。
 *
 * `stream` / `retract` 是分场景的，所以给的是值不是布尔：
 *   stream: 'c2c'   —— 流式消息只支持单聊（50 QPS），群聊没有
 *   retract: '2min' —— 群聊撤回限 2 分钟，单聊也有限制
 */
export const QQ_CAPABILITIES = Object.freeze({
  text: true,
  image: true,
  voice: true,
  file: true,
  video: true,
  markdown: true,
  button: true,
  panel: true,
  stream: 'c2c',
  retract: '2min',
  /** 以下都是"官方没有"，写 false 是为了让上层能明确判断，而不是 try 一下看报错 */
  poke: false,
  forward: false,
  space: false,
  history: false,
  /** 群主动需要 group_push 授权，否则发不出去 */
  groupPushNeedsAuthz: true,
});

/**
 * 判一个能力能不能在当前场景用。
 *
 * 为什么不让上层直接读 `capabilities.markdown`：`stream` 是 `'c2c'` 这种
 * 带条件的值，"真值即支持"会在群聊里误判。统一走这个函数。
 *
 * @param {object} caps
 * @param {string} name 能力名
 * @param {'c2c'|'group'} [scene]
 */
export function can(caps, name, scene = 'c2c') {
  const v = caps?.[name];
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  // 带场景的值：'c2c' 表示只有单聊能用
  if (typeof v === 'string') return v === scene || v === 'all';
  return Boolean(v);
}

/**
 * 降级链：某个能力用不了时，退成什么。
 *
 * 为什么能力表不够（第 3 批 E4）：`capabilities` 只回答"能不能"，
 * 不回答"不能时怎么办"。结果是降级逻辑散在发消息的地方
 * （框架里 `mdToPlain` 就在 `message.js` 里自己判一次），
 * 加平台就得再写一遍。
 *
 * 对照：NoneBot-Alconna 用 adapter + exporter 做段类型映射，
 * Satori 把平台差异收在协议层——上层都不自己判。
 */
export const QQ_FALLBACKS = Object.freeze({
  markdown: 'text',
  button: 'text',
  panel: 'text',
  stream: 'text',
  voice: 'text',
  image: 'text',
  file: 'text',
  video: 'text',
  retract: 'none',
});

/**
 * 把"想用什么"降级成"这个场景真能用什么"。
 *
 * @param {object} caps 能力表
 * @param {string} intent 想用的能力
 * @param {'c2c'|'group'} [scene]
 * @param {object} [fallbacks]
 * @returns {string|null} 能用的能力名；连 text 都不行（理论上不会）返回 null
 */
export function downgrade(caps, intent, scene = 'c2c', fallbacks = QQ_FALLBACKS) {
  if (can(caps, intent, scene)) return intent;
  let cur = intent;
  const seen = new Set();
  while (fallbacks?.[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = fallbacks[cur];
    if (cur === 'none') return null;
    if (can(caps, cur, scene)) return cur;
  }
  return null;
}

/**
 * Markdown 被服务端明确拒（4xx 且非 429）时才降级纯文本。
 *
 * 5xx / 网络错误可能已经送达，重发就是重复消息——和框架 `replyMarkdown`
 * 里那条规则保持一致。协议层的 `BAD_PARAMS` / `NO_SCOPE` 是参数或权限问题，
 * 重发纯文本也不会成功，别白花一次调用。
 */
function isMarkdownRejection(e) {
  if (['BAD_PARAMS', 'NO_SCOPE', 'NOT_FOUND', 'NOT_READY'].includes(String(e?.code ?? ''))) return false;
  const status = Number(e?.http ?? 0);
  if (status >= 400 && status < 500 && status !== 429) return true;
  return /(40034008|304061|22006|40034\d{3}|markdown)/i.test(String(e?.message ?? e ?? ''));
}

/** 降级时把 Markdown 记号去掉，别把 `**加粗**` 原样发给用户 */
function plainOf(s) {
  return String(s ?? '')
    .replace(/<qqbot-at-user\b[^>]*\/?>/gi, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按扩展名判 `fileType`（1 图 / 2 视频 / 3 语音 / 4 文件）。
 *
 * 协议默认是 1（图片），所以**判错会把 zip 当图片发**，官方回 40035001，
 * 而报错点离调用处很远（要翻到协议侧才看得见）。这里一次判准。
 *
 * 语音只认 `silk` / `amr`：协议对 `fileType=3` 会走语音上传链路，
 * 给个 mp3 会在转码那一步失败，不如当普通文件发出去（对方能听）。
 */
function fileTypeOfName(p) {
  const path = String(p ?? '').toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(path)) return 1;
  if (/\.(mp4|mov|avi|mkv|flv)$/.test(path)) return 2;
  if (/\.(silk|amr)$/.test(path)) return 3;
  return 4;
}

/**
 * 框架外接协议通道：直连 Roost，不经过任何中间层。
 *
 * 通道实现对外接口固定为 `send` / `delivery` / `ping` / `sendFile`，
 * 上层（`awake` / `speakup` / 面板发测试消息 / 扩展回话）只认这一套。
 * 能力表按官方接口如实声明——换的是入口不是能力。
 *
 * @param {object} o
 * @param {object} o.host  `createRoostHost()` 的实例（要有 rpc）
 * @param {(m:string)=>void} [o.log]
 */
export function createRoostHostChannel({ host, log = () => {}, markdownEnabled = true } = {}) {
  if (!host?.rpc) throw new Error('roost 通道需要 createRoostHost 实例');
  /** 旧 ai-chat 面板的 `markdown` 开关；热读，面板关掉下一轮就生效 */
  const wantMarkdown = () => (typeof markdownEnabled === 'function' ? markdownEnabled() : markdownEnabled);

  return {
    name: 'roost',
    capabilities: { ...QQ_CAPABILITIES },
    fallbacks: QQ_FALLBACKS,

    /**
     * 发一条。
     *
     * `msgId` / `receivedAt` 是可选的**被动回复**参数：带上它们，框架会把这条
     * 当成对某条消息的回复（不占主动额度）；不带就是主动消息。
     * 是否被动回复显式传，不靠 payload 里的隐式字段，更好排查。
     *
     * `silenceMs` 先设再发：她决定的是「别说话」，不是「发完这条再说」，
     * 所以发送失败也该生效。
     */
    async send({
      scene = 'c2c', target, text, hasGroupAuthz = true,
      silenceMs = 0, requestId = '', msgId = '', receivedAt = 0,
      /** 3.7：事件被动回复（好友申请/入群审核等只有 event_id 的事件），
       *  同样不占主动额度；msgId 与 eventId 二选一，都有时优先 msgId */
      eventId = '',
      /** 4.6：互动召回（官方 is_wakeup）；和 eventId 一样只加字段，不改别的 */
      isWakeup = false,
      markdown = true, keyboard = null,
    } = {}) {
      const t = String(text ?? '').trim();
      if (!target) return { ok: false, message: '缺 target' };
      /**
       * 只有静默、没有正文是合法的——`<<silence:2h>>` 单独出现就是
       * 「我要安静，没什么要说的」。不该拦，也不该发一条空消息。
       */
      if (!t && !(Number(silenceMs) > 0)) return { ok: false, message: '没有内容可发' };
      if (scene === 'group' && !hasGroupAuthz) {
        return { ok: false, message: '这个群没有 group_push 授权，主动消息发不出去' };
      }

      /**
       * 幂等键。前缀 `rh-`（roost host）和前两个通道分开，日志里一眼能看出谁发的。
       * 允许调用方传进来：重试同一条要复用同一个 id，否则账本记成两条、还会真发两遍。
       */
      const rid = String(requestId || '').trim()
        || `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      if (Number(silenceMs) > 0) {
        await host.rpc('gate.silence', { chatId: String(target), ms: Number(silenceMs) })
          .catch((e) => log(`设静默失败（不影响这条发送）：${e?.message ?? e}`));
      }
      if (!t) return { ok: true, scene, target, id: '', pending: false, requestId: rid, silentOnly: true };

      const base = {
        kind: scene === 'group' ? 'group' : 'c2c',
        chatId: String(target),
        content: t,
        requestId: rid,
        ...(msgId ? { msgId: String(msgId) } : {}),
        /** 3.7：msgId 缺席时用 event_id 走被动——两条路框架都认（bot methods 已支持） */
        ...(eventId && !msgId ? { eventId: String(eventId) } : {}),
        ...(receivedAt ? { receivedAt: Number(receivedAt) } : {}),
        ...(isWakeup ? { isWakeup: true } : {}),
      };
      /**
       * Markdown 是 ai-chat 时代的默认出口：`@` 标签、图文同条、按钮都只在
       * `msg_type=2` 里生效。框架的 `buildSendPayload` 看到 `markdown` 会自己
       * 把 `content` 置空并改成 2，所以这里只管传，不去猜 msgType。
       */
      const useMd = markdown !== false && wantMarkdown() !== false;
      const okResult = (r, usedRid) => ({
        ok: true,
        scene,
        target,
        id: String(r?.id ?? ''),
        pending: Boolean(r?.pending),
        requestId: String(r?.requestId || usedRid),
        markdown: useMd,
      });

      try {
        const r = await host.rpc('msg.send', useMd
          ? { ...base, markdown: { content: t }, ...(keyboard ? { keyboard } : {}) }
          : base);
        return okResult(r, rid);
      } catch (e) {
        /**
         * 4xx 且非 429 = 服务端明确拒了 markdown（官方 40034008 / 304061）。
         * 降级成纯文本重发，**不带 keyboard**（框架那条规则也是这样）。
         * 用派生幂等键：失败的那条可能已经进了投递账本，复用原键会被吞。
         */
        if (useMd && isMarkdownRejection(e)) {
          const plain = plainOf(t);
          if (plain) {
            try {
              const r = await host.rpc('msg.send', { ...base, content: plain, requestId: `${rid}:md` });
              log('markdown 被拒，已降级纯文本重发');
              return { ...okResult(r, `${rid}:md`), markdown: false };
            } catch (e2) {
              log(`降级纯文本也失败：${e2?.message ?? e2}`);
            }
          }
        }
        const network = e?.code === 'NETWORK';
        log(`roost 发送失败：${e?.message ?? e}`);
        return { ok: false, message: e?.message ?? String(e), code: e?.code ?? '', network, requestId: rid };
      }
    },

    /**
     * 上传 Markdown 素材图，返回 `qqbot-media://` 引用。
     *
     * `retain:false` 是**必须的**：占位符是每轮现传现用，若登记成「保留素材」
     * 会一直占官方 100 张配额，发几十张图就满了（旧 ai-chat 是发完立刻删）。
     */
    async uploadMarkdownImage({ scene = 'c2c', target, path: p, retain = false } = {}) {
      if (!p) return { url: '' };
      return await host.rpc('media.markdownImage', {
        scene: scene === 'group' ? 'group' : 'c2c',
        target: String(target || 'markdown'),
        path: String(p),
        retain: retain === true,
      });
    },

    /**
     * 5.13 单聊「正在输入」（`msg_type=6`）。
     *
     * 只对私聊有意义：群里没有这个语义，官方也不支持。
     * 直连协议侧、**不走 outbound**——它不是消息，不该占主动额度、
     * 也不该进投递账本（进了会让幂等和「待确认」判断错乱）。
     */
    async sendTyping({ scene = 'c2c', target } = {}) {
      if (scene === 'group') return { ok: false, message: '群聊没有「正在输入」' };
      if (!target) return { ok: false, message: '缺 target' };
      try {
        return await host.rpc('msg.typing', { chatId: String(target) });
      } catch (e) {
        return { ok: false, message: String(e?.message || e) };
      }
    },

    /**
     * 发一条语音。`path` 是已经是 silk/amr 的本地文件；`dataBase64` 给 TTS
     * 刚合成出来的 WAV/MP3，协议侧会转码成 silk（要可选的 silk-wasm）。
     * 两条都走 `media.send` → `outbound`，额度、账本、被动窗口一样不缺。
     */
    async sendVoice({ scene = 'c2c', target, path: p = '', dataBase64 = '', fileName = '', msgId = '', receivedAt = 0, eventId = '', isWakeup = false } = {}) {
      if (!target || (!p && !dataBase64)) return { ok: false, message: '缺 target 或音频' };
      try {
        const r = await host.rpc('media.send', {
          scene: scene === 'group' ? 'group' : 'c2c',
          target: String(target),
          ...(p ? { path: String(p) } : { dataBase64: String(dataBase64) }),
          fileType: 3,
          voice: true,
          ...(fileName ? { fileName: String(fileName) } : {}),
          ...(msgId ? { msgId: String(msgId) } : {}),
          ...(eventId && !msgId ? { eventId: String(eventId) } : {}),
          ...(receivedAt ? { receivedAt: Number(receivedAt) } : {}),
        ...(isWakeup ? { isWakeup: true } : {}),
        }, { timeout: 120_000 });
        return { ok: true, id: String(r?.id ?? ''), pending: Boolean(r?.pending) };
      } catch (e) {
        log(`roost 发语音失败：${e?.message ?? e}`);
        return { ok: false, message: e?.message ?? String(e) };
      }
    },

    /** `<<retract>>`：撤回自己上一条（消息 id 由出站动作层记着） */
    async retract({ chatId, msgId, kind = 'c2c' } = {}) {
      if (!chatId || !msgId) return { ok: false, message: '缺 chatId 或 msgId' };
      try {
        await host.rpc('msg.retract', {
          chatId: String(chatId), msgId: String(msgId),
          kind: kind === 'group' ? 'group' : 'c2c',
        });
        return { ok: true };
      } catch (e) {
        log(`roost 撤回失败：${e?.message ?? e}`);
        return { ok: false, message: e?.message ?? String(e) };
      }
    },

    /**
     * 直接问框架的投递账本，且多分块会聚合（`parts` 是切片数）。
     */
    async delivery(requestId) {
      const rid = String(requestId ?? '').trim();
      if (!rid) return { ok: false, gone: true, message: '缺 requestId' };
      try {
        return await host.rpc('delivery.get', { requestId: rid });
      } catch (e) {
        return { ok: false, message: `查不了：${e?.message ?? e}`, network: e?.code === 'NETWORK' };
      }
    },

    /**
     * 发一个本地文件 / 图片 / 视频。
     *
     * 直连没有「轮末统一上传」的回调，所以直接调协议 `media.send`。
     * 协议内部会 `uploadLocalFileSharded` → `outbound`，所以额度、账本、
     * 被动窗口、审核识别照样参与——不是绕过调度器直发。
     *
     * `fileType` **必须传对**：协议默认按 1（图片）处理，把 `.zip` 当图片
     * 上传会被官方拒（40035001），而且报错点离调用处很远。
     *
     * @param {object} o
     * @param {string} o.path 框架本机路径（dsh-roost 与 roost 同机时才有意义）
     */
    async sendFile({ scene = 'c2c', target, path, fileName = '', msgId = '', receivedAt = 0, eventId = '', isWakeup = false, requestId = '' } = {}) {
      const p = String(path ?? '').trim();
      if (!target) return { ok: false, message: '缺 target' };
      if (!p) return { ok: false, message: '缺 path' };
      const rid = String(requestId || '').trim()
        || `rf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const r = await host.rpc('media.send', {
          scene: scene === 'group' ? 'group' : 'c2c',
          target: String(target),
          path: p,
          fileType: fileTypeOfName(p),
          ...(fileName ? { fileName: String(fileName) } : {}),
          ...(msgId ? { msgId: String(msgId) } : {}),
          ...(eventId && !msgId ? { eventId: String(eventId) } : {}),
          ...(receivedAt ? { receivedAt: Number(receivedAt) } : {}),
          ...(isWakeup ? { isWakeup: true } : {}),
          requestId: rid,
        }, { timeout: 120_000 });
        return {
          ok: true,
          id: String(r?.id ?? ''),
          pending: Boolean(r?.pending),
          requestId: String(r?.requestId || rid),
        };
      } catch (e) {
        log(`roost 发文件失败：${e?.message ?? e}`);
        return { ok: false, message: e?.message ?? String(e), code: e?.code ?? '', requestId: rid };
      }
    },

    /** 健康检查：问一句 `system.ping`。不参与发送决策，只给面板看 */
    async ping() {
      const t0 = Date.now();
      try {
        await host.rpc('system.ping', {}, { timeout: 3000 });
        return { ok: true, status: 200, ms: Date.now() - t0 };
      } catch (e) {
        return { ok: false, message: e?.message ?? String(e) };
      }
    },
  };
}

/**
 * 假通道：测试用，把发出去的东西记下来。
 *
 * 为什么需要它：主动说话的逻辑（该不该说、说几次、什么时候说）
 * 全靠"有没有真的发出去"来判断，真发就会往群里扔消息。
 * 这个实现让整条链路在测试里跑通而一个字节都不出机器。
 */
export function createFakeChannel({ failWith = '', pending = false, states = {} } = {}) {
  const sent = [];
  /** 假账本：`delivery()` 从这里查，测「等确认 → 有结果」整条链路 */
  const ledger = new Map(Object.entries(states));
  return {
    name: 'fake',
    capabilities: { ...QQ_CAPABILITIES },
    sent,
    ledger,
    async send(payload) {
      const requestId = String(payload?.requestId || `fake-${sent.length + 1}`);
      if (failWith) {
        sent.push({ ...payload, ok: false, message: failWith });
        return { ok: false, message: failWith, requestId };
      }
      sent.push({ ...payload, ok: true, pending });
      return { ok: true, scene: payload?.scene, target: payload?.target, pending, requestId };
    },
    async delivery(requestId) {
      const id = String(requestId ?? '').trim();
      if (!id) return { ok: false, gone: true, message: '缺 requestId' };
      const st = ledger.get(id);
      if (!st) return { ok: false, gone: true, message: '没有这条投递记录' };
      return typeof st === 'string' ? { ok: true, state: st, parts: 1 } : { ok: true, ...st };
    },
    async ping() {
      return { ok: true, status: 200 };
    },
  };
}

/**
 * 通道注册表：按名字存实现，按配置挑一个。
 *
 * 现在只有 `roost` 一个实现，看起来是多余的间接层。留它的理由是
 * **以后加平台时上层不用改**：`awake` / `speakup` 只认 `registry.active()`，
 * 新平台注册进来即可，不必回头改调用点。
 *
 * @param {object} o
 * @param {Record<string, object>} o.impls
 * @param {() => string} [o.pick] 当前用哪个（配置项）
 */
export function createChannelRegistry({ impls = {}, pick = () => 'roost', log = () => {} } = {}) {
  function resolve(name) {
    const n = String(name || '') || pick();
    if (impls[n]) return impls[n];
    /**
     * 只注册了一个实现时，配置里写着别的名字（例如老配置的 `qq`）也回退到它。
     *
     * 这不是为了兼容旧通道，而是为了**不让升级变成哑巴**：移除 ai-chat 之后
     * 老配置仍可能带 `channel.current='qq'`，返回 null 会让主动搭话、面板测试
     * 消息全在 `channel.send` 处抛错，而用户只看到「突然一个字都不回」。
     * 配置层另有 `migrateChannel()` 负责把它改回 `roost`，这里是第二道兜底。
     */
    const keys = Object.keys(impls);
    if (keys.length === 1) return impls[keys[0]];
    log(`没有叫「${n}」的通道，可用的有：${keys.join('、') || '（空）'}`);
    return null;
  }
  return {
    get: resolve,
    active: () => resolve(pick()),
    names: () => Object.keys(impls),
    /** 面板用：每个通道的能力表，让人一眼看出"这个平台能干什么" */
    describe: () =>
      Object.fromEntries(Object.entries(impls).map(([k, v]) => [k, v?.capabilities ?? {}])),
  };
}
