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
 * 打开这一项之后，任何一次改动都先私聊主人问一句，**主人回码才执行**。
 *
 * ## 为什么用「4 位数字码」而不是「回确认就行」
 *
 * 私聊里「好」「可以」「嗯」太常见。如果只看确认词，主人一句「好，那你继续」
 * 就会把头像换掉。码要求消息里**完整出现那 4 位数字**（且前后不是数字），
 * 误命中概率极低，而且主人看一眼就知道在确认哪一条。
 *
 * ## 为什么放内存
 *
 * 待确认是个**短时**状态（10 分钟）。落盘会让「重启后还挂着一条三天前的请求」
 * 变成一种真实可能，而那种请求主人早就忘了。重启丢掉、主人回码时收到
 * 「确认请求已失效，让她重新发起」是更好的失败方式。
 */

import { KIND_LABELS, CONFIRM_KINDS } from './self-expression.js';

/** 请求有效期。10 分钟：够主人看到消息、也短到不会在他睡觉时一直挂着 */
export const CONFIRM_TTL_MS = 10 * 60_000;

/** 取消词：主人不想改时最可能说的几个 */
const CANCEL_RE = /^\s*(不用|算了|取消|不改|别改|不要)/;

/** 码的边界：前后不能是数字，免得 12345 命中 1234 */
const codeRe = (code) => new RegExp(`(^|\\D)${code}(\\D|$)`);

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

  /** code → 请求 */
  const pending = new Map();

  function prune() {
    const t = now();
    for (const [code, req] of pending) {
      if (t - req.at > ttlMs) pending.delete(code);
    }
  }

  function newCode() {
    for (let i = 0; i < 20; i += 1) {
      const code = String(Math.floor(1000 + Math.random() * 9000));
      if (!pending.has(code)) return code;
    }
    /** 连续 20 次撞码只可能是 pending 里塞了几千条，这时候再加也没意义 */
    return '';
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

    for (const req of pending.values()) {
      if (req.kind === k) {
        return { ok: true, code: req.code, reused: true };
      }
    }

    const owner = String(ownerOf() || '').trim();
    if (!owner) {
      return { ok: false, message: '没配主人的私聊地址，没法发起确认。' };
    }

    const code = newCode();
    if (!code) return { ok: false, message: '待确认的请求太多了，等一会儿再试。' };

    const label = KIND_LABELS[k];
    const text = [
      `她想改${label}：${String(summary || '').trim() || '（没说明）'}`,
      `确认请回「确认 ${code}」，不改回「不用」。${Math.round(ttlMs / 60_000)} 分钟内有效。`,
    ].join('\n');

    try {
      const r = await send({ scene: 'c2c', target: owner, text });
      /** 主动私聊可能被拒（额度、好友关系）；拒了就别记 pending，否则主人永远收不到 */
      if (r && r.ok === false) throw new Error(r.message || r.reason || '发送被拒');
    } catch (e) {
      log(`[profile-confirm] 发确认私聊失败：${e?.message ?? e}`);
      return { ok: false, message: `没法私聊主人（${e?.message ?? e}），这次先不改。` };
    }

    pending.set(code, { code, kind: k, payload, summary: String(summary || ''), at: now(), owner });
    log(`[profile-confirm] 已请求确认 ${k}（${code}）`);
    return { ok: true, code };
  }

  function hasPending() {
    prune();
    return pending.size > 0;
  }

  /**
   * 主人说了句话：命中码就取出那条请求（并移除）。
   *
   * 只返回**第一条**命中的：一条消息里出现两个码是极小概率，真出现了
   * 说明主人在引用旧编号，先执行他先提到的那个更符合直觉。
   */
  function take(said) {
    prune();
    const t = String(said ?? '');
    if (!t) return null;
    for (const [code, req] of pending) {
      if (codeRe(code).test(t)) {
        pending.delete(code);
        return req;
      }
    }
    return null;
  }

  /** 主人说了「不用」：取消最近一条，返回被取消的请求（没有就 null） */
  function cancelLatest(said) {
    prune();
    if (!CANCEL_RE.test(String(said ?? ''))) return null;
    let latest = null;
    for (const req of pending.values()) {
      if (!latest || req.at > latest.at) latest = req;
    }
    if (!latest) return null;
    pending.delete(latest.code);
    return latest;
  }

  /** 面板/调试用：当前挂着的请求（不含 payload 细节） */
  function list() {
    prune();
    return [...pending.values()].map((r) => ({ code: r.code, kind: r.kind, at: r.at, summary: r.summary }));
  }

  return { ask, take, cancelLatest, hasPending, list, _pending: pending };
}
