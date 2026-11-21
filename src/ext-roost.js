/**
 * 扩展 ↔ 框架直连协议（roost-host/1）的转发策略
 * ==============================================
 *
 * 宿主是协议客户端，框架是服务端。扩展既没有框架地址，也没有框架令牌，
 * 想用协议能力（发消息、调框架插件注册的工具、读运行状态…）只能由宿主代转。
 *
 * 这一层是**纯函数**，不碰 fetch / 配置 / 进程状态，方便单测把边界钉死：
 *
 *   1. 白名单：只读能力 + 框架插件投影的 `tool.*` 沿用 `roost-capabilities.js`
 *      那份（AI 工具也在用，别维护两份）。写 / 管理面（`config.set`、
 *      `plugin.install`、`qq.call`…）一律不开放给扩展。
 *   2. `msg.send` 单独开一个口子，但**参数要收窄**：扩展不许自报 chatId
 *      发到任意会话、不许伪造被动回复窗口、不许带 requestId 顶账本。
 *   3. `owner` 目标别名在这里解析：扩展不该知道主人的 openid。
 *
 * 为什么不让扩展直接调 `tool.*` 之外的写方法：装扩展时就给了它一份
 * 有 scope 的宿主令牌，扩展作者不等于主人。`message:write` 是敏感 scope，
 * 主人点过头才发得下来，但「点头」不等于「同意它改框架配置」。
 */

import { READONLY_METHODS, PRIVILEGED_METHODS } from './roost-capabilities.js';

/** 主人/管理员专属的只读方法也不给扩展（日志、插件运行数据、配置快照） */
const PRIVILEGED = new Set(PRIVILEGED_METHODS);

/**
 * 「只读」不等于「可以给扩展」（2026-11 复核）。
 *
 * `roost.read` 只要求 `state:read`，而它在**默认 scope** 里——安装时不需要
 * 主人确认。以前这些方法全在放行名单里，等于任何装上的扩展都能按 chatId
 * 读**任意会话的消息原文**、拿 openid ↔ QQ 号 ↔ 群号的映射、枚举会话键。
 * 在 `roost.read` 出现之前它们走 `roost.call`，要求 `message:write`（敏感、
 * 安装时二次确认），门槛不该因为拆了个只读端点就降到零。
 *
 * 另外这也和本文件自己的原则冲突（见 `OWNER_ALIASES` 的注释）：
 * 「扩展不该拿到主人的 openid」——`identity.resolve` 正是在交出去。
 */
const PRIVATE = new Set([
  'identity.list', 'identity.resolve',
  'ledger.recent', 'ledger.timeline', 'ledger.stats',
  'msg.get',
  'delivery.recent', 'delivery.get',
  'roles.resolve', 'reach.get',
  /** 「按会话键」返回额度快照 = 把有哪些会话列出来 */
  'quota.get',
]);

/**
 * 经 `roost.call`（要 `message:write`）能调的只读方法。
 *
 * **`PRIVATE` 不在这里过滤**：这些方法本来就是要 `message:write` 这道门槛的，
 * 拆出只读端点不该把它们从 `roost.call` 上也一起拿掉（2026-11 复核：
 * 第一版就是这么错的，等于把门槛从「敏感」改成「不存在」）。
 */
export const EXT_ROOST_CALLABLE = Object.freeze(
  READONLY_METHODS.map((m) => m.name).filter((n) => !PRIVILEGED.has(n)),
);

/**
 * 经 `roost.read`（只要默认的 `state:read`）能调的方法。
 *
 * = 上表再减掉 `PRIVATE`：这些方法读的是**别人的会话原文和身份映射**，
 * 默认权限不该够得着。
 */
export const EXT_ROOST_READONLY = Object.freeze(
  EXT_ROOST_CALLABLE.filter((n) => !PRIVATE.has(n)),
);

/** 扩展可调用的消息发送方法 */
export const EXT_ROOST_SEND = Object.freeze(['msg.send']);

/** `target` 里认的别名：扩展不该拿到主人的 openid */
const OWNER_ALIASES = new Set(['owner', 'private', 'me', '@owner']);

export function isOwnerAlias(v) {
  return OWNER_ALIASES.has(String(v ?? '').trim().toLowerCase());
}

/**
 * 这个方法能不能由扩展经 `/v1/roost.call` 调用。
 *
 * `caps` 是 `createCapabilityClient()` 的产物：它的 `has()` 会按连上之后
 * 拉到的真实能力表判断，框架老版本没有的方法、已卸载插件的工具都会 404，
 * 而不是把请求打到一个不存在的闭包上。
 *
 * @param {'call'|'read'} [o.surface] 哪个入口在问。`read` 会把 `PRIVATE`
 *   那批方法判成「需要 message:write」，而不是「不存在」——扩展作者才知道
 *   该换哪个端点。
 * @returns {{ok:true, kind:'readonly'|'tool'|'send'}|{ok:false, why:string}}
 */
export function classifyRoostCall(method, caps = null, { surface = 'call' } = {}) {
  const key = String(method ?? '').trim();
  if (!key) return { ok: false, why: '缺 method' };
  if (key.length > 120) return { ok: false, why: 'method 太长' };

  /** 名字先过格式：别让奇怪的键去撞 `__proto__` / 原型链上的东西 */
  if (!/^[a-z][a-z0-9_.-]*$/i.test(key)) {
    return { ok: false, why: `method 名字不合法：${key.slice(0, 60)}` };
  }

  if (EXT_ROOST_SEND.includes(key)) return { ok: true, kind: 'send' };

  if (key.startsWith('tool.')) {
    if (key.length < 6) return { ok: false, why: 'tool. 后面要有工具名' };
    if (caps && !caps.has(key)) return { ok: false, why: `框架没有这个插件工具：${key}` };
    return { ok: true, kind: 'tool' };
  }

  const allowed = surface === 'read' ? EXT_ROOST_READONLY : EXT_ROOST_CALLABLE;
  if (allowed.includes(key)) {
    if (caps && !caps.has(key)) return { ok: false, why: `框架没有这个能力：${key}` };
    return { ok: true, kind: 'readonly' };
  }
  /**
   * 只读端点撞上「需要 message:write」的那批：给可操作的提示，别报「不存在」。
   * 这条分支同时也保证了 `roost.call` 不会被误伤。
   */
  if (surface === 'read' && EXT_ROOST_CALLABLE.includes(key)) {
    return { ok: false, why: `${key} 读的是别人的会话/身份，需要 message:write：请改用 roost.call` };
  }

  return { ok: false, why: `方法 ${key} 不对扩展开放（只开只读能力、tool.* 与 msg.send）` };
}

/**
 * 解析发送目标。
 *
 * `owner` / `private` / `me` / 空 → 主人（由宿主解析，扩展拿不到 openid）；
 * `group:<id>` / `recent` 交由调用方按既有规则处理，这里只标出意图；
 * 其余原样返回（已有的 `/v1/send` 行为不变）。
 *
 * @returns {{ok:true, scene:'c2c'|'group', target:string, ownerAlias:boolean}
 *          |{ok:false, why:string}}
 */
export function resolveExtTarget(raw, {
  scene = 'c2c', ownerOf = () => '', resolveRecentGroup = null, allowEmpty = false,
} = {}) {
  const s = String(raw ?? '').trim();
  /**
   * 空 target 默认仍是错误（保持 `/v1/send` 原有行为）：漏填参数时静默发到
   * 主人私聊比报错危险。调用方明确要「不填就发主人」时才开 `allowEmpty`。
   */
  if (isOwnerAlias(s) || (!s && allowEmpty)) {
    const owner = String(ownerOf() ?? '').trim();
    if (!owner) return { ok: false, why: '宿主没配主人（owners / chatId），不知道该发给谁' };
    return { ok: true, scene: 'c2c', target: owner, ownerAlias: true };
  }
  if (!s) return { ok: false, why: '缺 target / chatId' };
  if (s === 'recent' || s === 'group:recent' || s === 'recent-group') {
    if (typeof resolveRecentGroup !== 'function') {
      return { ok: false, why: '这个调用方不支持「最近说话的群」' };
    }
    return { ok: true, scene: 'group', target: '', recent: true, ownerAlias: false };
  }
  const m = s.match(/^group:(.+)$/i);
  if (m) return { ok: true, scene: 'group', target: m[1].trim(), ownerAlias: false };
  return { ok: true, scene: scene === 'group' ? 'group' : 'c2c', target: s, ownerAlias: false };
}

/**
 * 收窄 `msg.send` 的参数：**只保留扩展该有的那几个**。
 *
 * 框架的 `msg.send` 能带 `msgId` / `eventId`（蹭被动回复窗口、绕过主动额度）、
 * `requestId`（顶账本）、`isWakeup`（互动召回）、以及任意富媒体对象。
 * 这些要么该由宿主决定，要么要过 `/v1/send` 的校验，不该从透传口子直接进去。
 *
 * @returns {{ok:true, params:object}|{ok:false, why:string}}
 */
export function narrowMsgSend(input, { scene, target, ownerAlias } = {}) {
  const p = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const content = String(p.content ?? p.text ?? '').slice(0, 4000).trim();
  const card = p.card && typeof p.card === 'object' && !Array.isArray(p.card) ? p.card : null;
  const markdown = p.markdown && typeof p.markdown === 'object' && !Array.isArray(p.markdown) ? p.markdown : null;
  if (!content && !card && !markdown) {
    return { ok: false, why: 'content / card / markdown 至少给一个（不收文件与被动回复参数）' };
  }
  if (!target) return { ok: false, why: '解析不出发送目标' };

  const params = {
    kind: scene === 'group' ? 'group' : 'c2c',
    chatId: String(target),
    /** 卡片消息的正文必须是空的，官方 msg_type=8 不带 content */
    content: card ? '' : content,
  };
  if (card) params.card = {
    title: String(card.title ?? '').slice(0, 200),
    description: String(card.description ?? '').slice(0, 500),
    url: String(card.url ?? '').slice(0, 1024),
    picUrl: String(card.picUrl ?? card.pic_url ?? '').slice(0, 1024),
  };
  if (markdown && !card) params.markdown = markdown;
  /** 幂等键由宿主按「扩展 id + 调用内容」生成，不许扩展自报 */
  return { ok: true, params, ownerAlias: Boolean(ownerAlias) };
}
