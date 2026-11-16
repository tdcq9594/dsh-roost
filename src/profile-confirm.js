/**
 * 改资料前的「私聊主人确认」
 * ==========================
 *
 * 为什么需要它：`qq_sign` / `qq_name` / `qq_avatar` 改的是**所有人共用的那张脸**。
 * 默认情况下只要主人这一轮开口就能改，但有两种场景不该这么松：
 *
 *   · 主人把资料权限放给了群管（能力页可放开），群管一句话就能换掉她的头像
 *   · 她自己在对话里「觉得该换」，虽然工具层要求 owner 在场，但那一轮说话的
 *     可能只是主人随口一句玩笑
 *
 * 打开这一项之后，任何一次改动都先私聊主人问一句，**主人点「确认改」按钮才执行**。
 *
 * ## 为什么是按钮（2026-11-16 主人定）
 *
 * 先用过 4 位数字码：能压住误命中，但太机械——主人得回头翻那条私聊、照着抄
 * 四个数字，抄错还要重来。后来改成认「确认」这类强意图短语，靠正则整句匹配，
 * 结果是一串同义词表加一条「好+动作词」的组合规则——那不是识别，是赌。
 *
 * 现在发的是**回调型按钮**（`action.type: 1`）：点击产生 `INTERACTION_CREATE`，
 * 带 `button_data` 回到宿主，按 nonce 精确对上那一条请求。点了就是点了，
 * 没有「主人正好说了句确认」这种误批，也不用维护同义词表。
 *
 * 文本通道只留「确认」「不用」两个字面兜底，覆盖按钮显示不出来的老客户端；
 * 它**不是**主路径，也**不再**认「好 / 行 / 可以 / 确定 / ok」这些。
 *
 * 同时只挂一条（新请求顶掉旧的），按钮的 nonce 随之失效——旧卡片点了也不会
 * 改到新请求上去。
 *
 * ## 为什么放内存
 *
 * 待确认是个**短时**状态（10 分钟）。落盘会让「重启后还挂着一条三天前的请求」
 * 变成一种真实可能，而那种请求主人早就忘了。重启丢掉、主人回「确认」时收到
 * 「确认请求已失效，让她重新发起」是更好的失败方式。
 */

import { randomBytes } from 'node:crypto';
import { KIND_LABELS, CONFIRM_KINDS } from './self-expression.js';
import { encodeButtonData, decodeButtonData } from './roost-interaction.js';

/** 请求有效期。10 分钟：够主人看到消息、也短到不会在他睡觉时一直挂着 */
export const CONFIRM_TTL_MS = 10 * 60_000;

/**
 * 按钮 data 里的通道判别字段。
 *
 * 交互事件是**单入口**（`interactionRouter` 只有一个处理器），所有回调按钮
 * 都从这一条链进来。`t` 就是分流用的：`pick` 归 pick 通道，`pf` 归这里。
 * 加新通道只加一个新 `t`，不用再动路由。
 */
export const CONFIRM_BUTTON_TAG = 'pf';

/** 按钮回传值：y = 改，n = 不改。刻意用单字符，QQ 对 data 长度有限制 */
const APPROVE = 'y';
const DENY = 'n';

/**
 * 文本兜底：**只认这两个字面**，不再猜同义词。
 *
 * 以前这里塞了「确认/确定/同意/批准/准了/没问题/可以改/改吧/改/就这么改/
 * ok/yes」一大串，还带一条「好+动作词」的组合规则——那不是识别，是赌。
 * 现在主通道是按钮（点了就是点了，没有歧义），文本这条只在按钮显示不出来
 * （老客户端、markdown 被降级）时兜底，所以只留「确认」「不用」两个词。
 */
const APPROVE_RE = /^\s*确认\s*[!！。.~～…]*\s*$/;
const DENY_RE = /^\s*不用\s*[!！。.~～…]*\s*$/;

/**
 * 主人这句话算不算「批准」。
 *
 * 保留这个导出是因为面板和测试还在用；**判定口径已经收窄到字面等值**，
 * 真正的批准路径是 `handleInteraction()`。
 */
export function isConfirmWord(said) {
  return APPROVE_RE.test(String(said ?? ''));
}

/**
 * 确认卡片的两颗按钮。
 *
 * `action.type: 1` 是**回调型**：点击产生 `INTERACTION_CREATE`，不会变成一条
 * 用户消息。`click_limit: 1` 让点过的那颗变灰，避免连点两次走两条路径。
 *
 * @param {string} nonce 本次请求的随机串
 * @param {{approveLabel?:string, denyLabel?:string}} [labels]
 */
export function buildConfirmKeyboard(nonce, labels = {}) {
  const n = String(nonce || '');
  if (!n) return null;
  const groupId = `pf-${n}`;
  const btn = (id, label, value) => ({
    id,
    render_data: {
      label,
      /**
       * `style` 只有两个合法值：**0 = 灰色线框、1 = 蓝色线框**。
       * 这里踩过一次：写成 `2` 想区分「危险操作」的红色，平台不认这个值，
       * 整条消息被拒 —— 表现是「点了改资料，主人什么都没收到」，而不是
       * 「按钮颜色不对」。宁可两颗都普通，也不要整条发不出去。
       */
      style: value === APPROVE ? 1 : 0,
      /** 点过之后的文案：`click_limit: 1` 会让它变灰，这里把状态说清楚 */
      visited_label: value === APPROVE ? '✓ 已确认' : '✓ 已取消',
    },
    action: {
      type: 1,
      permission: { type: 2 },
      click_limit: 1,
      data: encodeButtonData({ t: CONFIRM_BUTTON_TAG, n, v: value }),
    },
    group_id: groupId,
  });
  return {
    content: {
      rows: [{
        buttons: [
          btn('1', labels.approveLabel || '确认改', APPROVE),
          btn('2', labels.denyLabel || '不用了', DENY),
        ],
      }],
    },
  };
}

/**
 * @param {object} p
 * @param {(payload:{scene:string,target:string,text:string})=>Promise<any>} p.send 主动私聊
 * @param {()=>string} p.ownerOf 主人 c2c chatId
 * @param {()=>number} [p.now]
 * @param {number} [p.ttlMs]
 * @param {(m:string)=>void} [p.log]
 */
export function createProfileConfirm({ send, ownerOf, now = () => Date.now(), ttlMs = CONFIRM_TTL_MS, log = () => {} }) {
  if (typeof send !== 'function') throw new Error('确认通道需要 send 函数');
  if (typeof ownerOf !== 'function') throw new Error('确认通道需要 ownerOf 函数');

  /** kind → 请求。同时只挂一条，用 Map 是为了「同类复用」与「按类清理」 */
  const pending = new Map();

  function prune() {
    const t = now();
    for (const [kind, req] of pending) {
      if (t - req.at > ttlMs) pending.delete(kind);
    }
  }

  /**
   * 发起一次确认。
   *
   * **同一类还有未过期的请求时直接复用**：模型很可能在一轮里把工具调两次
   * （或者用户连点两下），再发一条私聊只会让主人收到两条一模一样的消息。
   */
  async function ask({ kind, payload, summary } = {}) {
    prune();
    const k = String(kind || '');
    /** 只有三类要确认；`menu` 在 `KIND_LABELS` 里但没有确认流程（它一秒能改回来） */
    if (!CONFIRM_KINDS.includes(k)) return { ok: false, message: `这一项不需要确认：${k || '(空)'}` };

    if (pending.has(k)) return { ok: true, reused: true };

    const owner = String(ownerOf() || '').trim();
    if (!owner) {
      return { ok: false, message: '没配主人的私聊地址，没法发起确认。' };
    }

    /**
     * 同时只挂一条：不同类也顶掉旧的。
     * 「确认」不带编号，两条一起挂着时主人回一句就说不清批的是哪条。
     *
     * **发送成功之后才顶**：发失败时旧请求还该留着，不能连它一起丢。
     */
    const label = KIND_LABELS[k];
    const nonce = randomBytes(6).toString('hex');
    const text = [
      `她想改${label}：${String(summary || '').trim() || '（没说明）'}`,
      `点下面的按钮告诉我。${Math.round(ttlMs / 60_000)} 分钟内有效。`,
      /**
       * 这句**必须有**，不能省。
       *
       * `channel.js` 在 markdown 被平台 4xx 拒时会降级成纯文本重发，而降级
       * 那条路**不带 keyboard**（框架的规则也是这样）。只写「点下面的按钮」
       * 的话，按钮没了以后主人看到的就是一句让他点不存在的东西的话 ——
       * 文本兜底又只认「确认」「不用」，他根本猜不到该回什么。
       */
      '（按钮显示不出来时，直接回「确认」或「不用」。）',
    ].join('\n');

    try {
      /**
       * `markdown: true` 是按钮的前提：官方把 keyboard 定位成「挂在 markdown
       * 消息底部」，纯文本挂按钮没验证过。正文里不再写「回确认」——按钮就是
       * 答复方式，写一遍反而让人以为要打字。
       */
      const r = await send({
        scene: 'c2c',
        kind: 'c2c',
        target: owner,
        text,
        markdown: true,
        keyboard: buildConfirmKeyboard(nonce),
      });
      /** 主动私聊可能被拒（额度、好友关系）；拒了就别记 pending，否则主人永远收不到 */
      if (r && r.ok === false) throw new Error(r.message || r.reason || '发送被拒');
    } catch (e) {
      log(`[profile-confirm] 发确认私聊失败：${e?.message ?? e}`);
      return { ok: false, message: `没法私聊主人（${e?.message ?? e}），这次先不改。` };
    }

    pending.clear();
    pending.set(k, {
      kind: k, payload, summary: String(summary || ''), at: now(), owner, nonce,
    });
    log(`[profile-confirm] 已请求确认 ${k}（nonce=${nonce}）`);
    return { ok: true };
  }

  function hasPending() {
    prune();
    return pending.size > 0;
  }

  /**
   * 主人说了句「确认」：取出挂着的那条（并移除）。
   *
   * 正常只有一条；真出现多条（历史遗留或并发）取**最近**那条，
   * 与「新请求顶掉旧的」保持同一个直觉。
   */
  function take(said) {
    prune();
    if (!isConfirmWord(said)) return null;
    let latest = null;
    for (const req of pending.values()) {
      if (!latest || req.at > latest.at) latest = req;
    }
    if (!latest) return null;
    pending.delete(latest.kind);
    return latest;
  }

  /** 主人说了「不用」：取消最近一条，返回被取消的请求（没有就 null） */
  function cancelLatest(said) {
    prune();
    if (!DENY_RE.test(String(said ?? ''))) return null;
    let latest = null;
    for (const req of pending.values()) {
      if (!latest || req.at > latest.at) latest = req;
    }
    if (!latest) return null;
    pending.delete(latest.kind);
    return latest;
  }

  /**
   * 处理一条 `INTERACTION_CREATE`：主人在 QQ 里点了确认卡片上的按钮。
   *
   * 返回值三态，调用方据此决定「执行 / 回一句失效 / 完全不归我管」：
   *   · `null`                → 不是本通道的按钮（`t !== 'pf'`），交给别的通道
   *   · `{ok:false, stale}`   → 是本通道的按钮，但 nonce 对不上（旧卡片 / 已结算 / 过期）
   *   · `{ok:true, approve}`  → 命中，请求已从 pending 里移除
   *
   * 授权 fail-closed：拿不到点击者 openid 就不认，且必须是主人本人。
   * 群里点这颗按钮不算数——确认只能来自主人的私聊，和文本通道同一个口径。
   *
   * @param {{buttonData?:string, operatorId?:string, scene?:string}} parsed
   */
  function handleInteraction(parsed) {
    const btn = decodeButtonData(parsed?.buttonData);
    if (!btn || btn.t !== CONFIRM_BUTTON_TAG) return null;

    prune();
    let hit = null;
    for (const req of pending.values()) {
      if (req.nonce && req.nonce === btn.n) { hit = req; break; }
    }
    if (!hit) return { ok: false, stale: true, message: '这条确认已经失效了（过期或被新的请求顶掉）。' };

    /** 值必须在登记时给的两个里，防止伪造 data 塞第三个值进来 */
    if (btn.v !== APPROVE && btn.v !== DENY) return { ok: false, stale: true, message: '不认识的按钮值。' };

    const operatorId = String(parsed?.operatorId ?? '').trim();
    const chatId = String(parsed?.chatId ?? '').trim();
    /**
     * 身份判定：**拿到的任何一个 id 等于主人就算数，一个都拿不到就拒**。
     *
     * 为什么不是只比 `operatorId`：官方在不同事件里给的字段不一样，c2c 的
     * 交互回调可能只带 `chat_id`、也可能只带 `user_openid`，两者在私聊场景下
     * 都是主人那个 openid。只认一个字段的话，字段一旦换名字，**所有按钮都会
     * 被静默拒掉**——表现是「点了没反应」，比放宽一点糟得多。
     *
     * 仍然严格：必须**等于主人**，群里点的（group_member_openid / group_openid）
     * 与主人的 c2c openid 不是一个作用域，自然对不上。
     */
    const ids = [operatorId, chatId].filter(Boolean);
    const owner = String(hit.owner || '').trim();
    if (!ids.length) {
      log('[profile-confirm] 按钮点击拿不到任何身份字段，已忽略（fail-closed）');
      return { ok: false, denied: true, message: '认不出是谁点的，这次不算。' };
    }
    if (owner && !ids.includes(owner)) {
      log(`[profile-confirm] 按钮点击者不是主人，已忽略：${ids.join(' / ')}`);
      return { ok: false, denied: true, message: '这个按钮只有主人点才算数。' };
    }

    pending.delete(hit.kind);
    return {
      ok: true,
      approve: btn.v === APPROVE,
      kind: hit.kind,
      payload: hit.payload,
      summary: hit.summary,
      /** 只拿到 `chat_id` 时用 chatId 顶上：调用方要的是一个「谁点的」标识 */
      operatorId: operatorId || chatId,
      nonce: btn.n,
      at: now(),
    };
  }

  /** 面板/调试用：当前挂着的请求（不含 payload 细节） */
  function list() {
    prune();
    return [...pending.values()].map((r) => ({ kind: r.kind, at: r.at, summary: r.summary }));
  }

  return { ask, take, cancelLatest, handleInteraction, hasPending, list, _pending: pending };
}
