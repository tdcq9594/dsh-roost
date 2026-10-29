/**
 * 通道抽象：把「怎么把话说出去」和「说什么」分开。
 *
 * 为什么现在才抽：第 4 期之前只有一家（QQ 走 ai-chat 的 `/send`），
 * 直接 fetch 最省事。但从第 5 期起要开始"主动说话"（私聊 + 群），
 * 一旦有两处要发消息，散着写必然重复；再往后接别的平台更没边。
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
 * QQ 通道：真正的发送动作在 ai-chat 那边（它持有 QQ 连接）。
 *
 * 为什么走 HTTP 而不是进程内调用：dsh-roost 和 ai-chat 分属两个进程
 * （DSH 插件 vs Roost 插件），中间只有 HTTP 这一条已有的通路。
 * 这也是为什么 `baseUrl` + `keyQuery` 要传进来——端口和密钥都归配置管。
 *
 * @param {object} o
 * @param {() => string} o.baseUrl  ai-chat 所在地址，每次现读（端口会变）
 * @param {() => string} [o.keyQuery] 例如 `?token=xxx`，空串表示不校验
 * @param {(m:string)=>void} [o.log]
 * @param {typeof fetch} [o.fetchImpl] 测试替换用
 */
export function createQqChannel({ baseUrl, keyQuery = () => '', log = () => {}, fetchImpl = fetch } = {}) {
  async function post(payload) {
    const url = `${String(baseUrl() || '').replace(/\/+$/, '')}/api/plugins/ai-chat/r/send${keyQuery()}`;
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json().catch(() => null);
    if (!body) return { ok: false, message: `ai-chat 没回 JSON（HTTP ${r.status}）` };
    return body;
  }

  return {
    name: 'qq',
    capabilities: QQ_CAPABILITIES,
    /** 能力用不了时退成什么，和 capabilities 一起交给上层 */
    fallbacks: QQ_FALLBACKS,

    /**
     * 主动发一条。
     *
     * 为什么把「群主动要先有 group_push 授权」写在这里而不是上层：
     * 这是通道的硬前置（没授权官方直接拒），不是业务策略。
     * 上层只管"我想说"，能不能说是这一层的事。
     *
     * `silenceMs`：她在这条消息里要求安静一阵子（`<<silence:2h>>`）。
     * 主动搭话的文本会先被 speakup 摘掉所有标记，所以时长只能单独传，
     * 由 ai-chat 转成框架的会话静默。
     *
     * @returns {Promise<{ok:boolean, message?:string, scene?:string}>}
     */
    async send({ scene = 'c2c', target, text, hasGroupAuthz = true, silenceMs = 0 } = {}) {
      const t = String(text ?? '').trim();
      if (!target) return { ok: false, message: '缺 target' };
      /**
       * 只有静默、没有正文是合法的——`<<silence:2h>>` 单独出现就是
       * 「我要安静，没什么要说的」。这时候不该拦，也不该发空消息。
       */
      if (!t && !(Number(silenceMs) > 0)) return { ok: false, message: '没有内容可发' };
      if (scene === 'group' && !hasGroupAuthz) {
        return { ok: false, message: '这个群没有 group_push 授权，主动消息发不出去' };
      }
      try {
        const r = await post({
          scene: scene === 'group' ? 'group' : 'c2c',
          target,
          text: t,
          ...(Number(silenceMs) > 0 ? { silenceMs: Number(silenceMs) } : {}),
        });
        if (!r?.ok) log(`通道发送失败：${r?.message ?? '未知原因'}`);
        return r;
      } catch (e) {
        // 网络类错误单独包一层：上层据此区分"对方拒绝"和"根本没连上"
        return { ok: false, message: `发不出去：${e?.message ?? e}`, network: true };
      }
    },

    /** 健康检查：ai-chat 在不在。用于面板显示，不参与发送决策 */
    async ping() {
      try {
        const r = await fetchImpl(`${String(baseUrl() || '').replace(/\/+$/, '')}/api/plugins/ai-chat/r/status${keyQuery()}`, {
          signal: AbortSignal.timeout(3000),
        });
        return { ok: r.ok, status: r.status };
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
export function createFakeChannel({ failWith = '' } = {}) {
  const sent = [];
  return {
    name: 'fake',
    capabilities: { ...QQ_CAPABILITIES },
    sent,
    async send(payload) {
      if (failWith) {
        sent.push({ ...payload, ok: false, message: failWith });
        return { ok: false, message: failWith };
      }
      sent.push({ ...payload, ok: true });
      return { ok: true, scene: payload?.scene, target: payload?.target };
    },
    async ping() {
      return { ok: true, status: 200 };
    },
  };
}

/**
 * 通道注册表：按名字存实现，按配置挑一个。
 *
 * 现在只有 `qq` 一个实现，看起来是多余的间接层。留它的理由是
 * **以后加平台时上层不用改**：`awake` / `speakup` 只认 `registry.active()`，
 * 新平台注册进来即可，不必回头改调用点。
 *
 * @param {object} o
 * @param {Record<string, object>} o.impls
 * @param {() => string} [o.pick] 当前用哪个（配置项）
 */
export function createChannelRegistry({ impls = {}, pick = () => 'qq', log = () => {} } = {}) {
  function resolve(name) {
    const n = String(name || '') || pick();
    const impl = impls[n];
    if (!impl) {
      log(`没有叫「${n}」的通道，可用的有：${Object.keys(impls).join('、') || '（空）'}`);
      return null;
    }
    return impl;
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
