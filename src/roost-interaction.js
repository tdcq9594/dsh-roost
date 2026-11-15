/**
 * roost 外接协议的交互事件解析
 * ============================
 *
 * `INTERACTION_CREATE`（按钮回调）从框架到本插件要剥好几层，写错一层就
 * 什么都收不到：
 *
 *   QQ 事件体 d
 *     → bot/src/host/index.js    onEvent(eventName, d)
 *     → bot/src/host/serialize.js serializeNotice → { at, event, data: d }
 *     → SSE 帧                  { type:'event', event:'notice', data: {at,event,data} }
 *     → roost-host.js:271       onNotice(frame.data, frame)
 *     → host.js                 deliverNoticeFromRoost(data)
 *
 * 所以到 `deliverNoticeFromRoost` 手里的是 `{at, event, data}`，其中
 * `event` 是 `INTERACTION_CREATE`、`data` 是 QQ 的事件体 d；而 `button_data`
 * 还在 d 内部的 `d.data.resolved.button_data`
 * ——即完整路径 `notice.data.data.resolved.button_data`。
 *
 * 本模块的入参就是这个 notice（不是里面的 d），所以先取 `notice.data` 得 d。
 *
 * 这里只做「剥层 + 归一化」，不猜业务语义、不做授权判断、不碰任何状态机。
 * 未知字段一律留在 `raw` 里，交给上层按需取，避免把平台字段写死。
 */

/** 点击者身份的候选字段，按可信度排（群聊优先用群成员 openid） */
const OPERATOR_KEYS = [
  'group_member_openid', 'user_openid', 'user_id', 'openid',
  'group_member_id', 'member_openid',
];

/** 会话标识的候选字段 */
const CHAT_KEYS = ['group_openid', 'channel_id', 'chat_id', 'group_id'];

/**
 * 从 notice 帧里剥出交互事件的关键字段。
 *
 * @param {object} notice `deliverNoticeFromRoost` 收到的 `{at, event, data}`
 * @returns {null|{event:string,id:string,type:number,buttonData:string,
 *   buttonId:string,operatorId:string,chatId:string,scene:string,raw:object}}
 *   不是交互事件、或结构完全不对时返回 null（上层据此静默忽略）
 */
export function parseInteractionNotice(notice) {
  const event = String(notice?.event ?? '').trim();
  if (event !== 'INTERACTION_CREATE') return null;

  /** 事件体：notice.data 是 serializeNotice 的 data 字段，里面才是真正的 d */
  const body = notice?.data;
  if (!body || typeof body !== 'object') return null;

  const resolved = body?.data?.resolved ?? {};
  const pick = (obj, keys) => {
    for (const k of keys) {
      const v = obj?.[k];
      if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
    }
    return '';
  };

  const groupOpenid = String(body.group_openid ?? resolved.group_openid ?? '').trim();
  const chatId = groupOpenid || pick(body, CHAT_KEYS) || pick(resolved, CHAT_KEYS);
  return {
    event,
    id: String(body.id ?? '').trim(),
    type: Number(body.type ?? 0),
    buttonData: String(resolved.button_data ?? '').trim(),
    buttonId: String(resolved.button_id ?? '').trim(),
    operatorId: pick(resolved, OPERATOR_KEYS) || pick(body, OPERATOR_KEYS),
    chatId,
    scene: groupOpenid ? 'group' : 'c2c',
    raw: body,
  };
}

/**
 * 解析回调按钮的 data。
 *
 * 对齐 dsh-qqbot `button-utils.ts` 的「顶层判别字段」思路：所有回调按钮都带
 * `t`，通道按它路由，避免多通道各自 try 导致误判。
 *
 * @param {string} raw `resolved.button_data` 原文
 * @returns {null|{t:string,n:string,v:string,raw:object}}
 */
export function decodeButtonData(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const t = String(obj.t ?? '').trim();
  if (!t) return null;
  return {
    t,
    n: String(obj.n ?? '').trim(),
    v: obj.v === undefined || obj.v === null ? '' : String(obj.v),
    raw: obj,
  };
}

/** 编码回调按钮 data。字段刻意短：QQ 对 data 长度有限制 */
export function encodeButtonData(data) {
  return JSON.stringify(data);
}

/* ------------------------------------------------------------------ */
/* 交互事件路由                                                        */
/* ------------------------------------------------------------------ */

/**
 * 交互事件路由器。
 *
 * 为什么是「可注册」而不是在 host.js 里写死：notice 通道要先能独立上线
 * （E2 纯加法，此时系统里没有任何回调按钮，处理器缺失也不该报错），等 E3
 * 把回调按钮接上，再由那一侧注册真正的处理逻辑。两边互不依赖。
 *
 * 没有注册处理器时，命中的事件只记一条 debug，不产生任何行为。
 */
export function createInteractionRouter({ log = () => {}, debug = () => {} } = {}) {
  /** @type {(parsed:object)=>boolean|void} */
  let handler = null;

  return {
    /** 注册处理器；重复注册以最后一个为准（单实例，正常只会调一次） */
    register(fn) {
      if (typeof fn !== 'function') throw new TypeError('交互处理器必须是函数');
      handler = fn;
    },
    /** 当前有没有处理器 */
    get size() { return handler ? 1 : 0; },
    /**
     * 分发。解析不出来、或者解析出来但没有处理器，都静默返回 false。
     * 处理器抛错不能顺着 SSE 事件流往上冒（那条链断了后面消息全收不到）。
     */
    dispatch(notice) {
      const parsed = parseInteractionNotice(notice);
      if (!parsed) return false;
      if (!handler) {
        debug(`收到交互事件但没有处理器：type=${parsed.type} id=${parsed.id} buttonData=${parsed.buttonData.slice(0, 60)}`);
        return false;
      }
      try {
        return handler(parsed) !== false;
      } catch (e) {
        log(`交互事件处理失败（已吞）：${e?.message ?? e}`);
        return false;
      }
    },
    /** 仅供测试：重置回无处理器状态 */
    reset() { handler = null; },
  };
}

/**
 * 模块级单例。
 *
 * 外接协议的事件只有一条入口（host.js 的 `deliverNoticeFromRoost`），回调用
 * 按钮的注册方却在另一处（E3 的 pick 通道）。用单例让两边不必互相 import，
 * 也避免 apply() 被重复调用时建出两个互不相通的路由表。
 */
export const interactionRouter = createInteractionRouter();
