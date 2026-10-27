/**
 * 上下文压缩：**开新会话 + 摘要开场**，旧会话不删。
 *
 * ── 为什么不用 `session/fork`（设计稿 P1 的结论要修） ──
 * 前置验证 P1 写的是「能指定精确事件边界 → 等于从第 N 个事件处截断，开新会话」，
 * 于是 C5 设计成「fork(boundary=最近 16% 之前)」。
 * 实测 asar 里 `session/fork` 的原文描述是：
 *
 *   "Fork one cold-readable exact event **prefix** into a new Session.
 *    An omitted boundary selects the latest completed-turn prefix"
 *
 * **prefix** —— 它复制的是「从头到 atSeq」这一段，不是「从 atSeq 往后」。
 * 也就是说 fork(边界) 拿到的是**老的那一半**，"省略边界就取最后一个完整轮次的前缀"
 * 更是把整个会话原样复制一份。按 C5 那么用，得到的是"只留旧的、丢掉最近 16%"，
 * 正好和压缩要的效果相反。
 *
 * 所以这里改成不需要 fork 的做法：
 *   1. 用 `controller.create` 开一个新会话
 *   2. 新会话第一条消息 = **摘要 + 最近几轮原话 + 没办完的约定**（从日记里取）
 *   3. `chatId → sessionId` 改成指向新会话
 *   4. 旧会话**不动**（可回溯，正好是"压不是删"）
 *
 * 好处：不依赖一个语义容易搞错的接口；摘要内容来自我们自己的日记，
 * 不依赖 DSH 生成，可控。代价：摘要那一条是我们拼的，不是模型写的——
 * 但日记里的每日摘要是巩固时模型写的，等于间接用上了模型。
 *
 * ── 什么时候压 ──
 * DSH 的 `session/projections` 里有 `contextPressure`：
 *   pressureTokens   最近一次请求的 prompt 大小（服务商回报的实数）
 *   projectedTokens  下一次请求预计要多少
 *   contextWindow    当前路由的容量
 * 有它就不用猜。取不到（服务商还没回报过 usage）时退回**轮数**兜底——
 * 宁可早一点压，也不要等到被截断。
 */

import { dayOf } from './journal.js';

export const DEFAULTS = {
  enabled: true,
  /** 占用到多少就压（百分比） */
  atPercent: 25,
  /** 新会话开场里带几条最近原话 */
  keepRecent: 8,
  /** 没有用量数据时，聊到多少轮就压 */
  maxTurns: 40,
  /** 开场摘要最多带几条每日摘要 */
  keepDigests: 3,
};

const DAY = 86_400_000;

/**
 * 从 `session/projections` 的返回值里找 `contextPressure`。
 *
 * 为什么用"递归找"而不是取值路径：那个对象是 DSH 内部的投影集合
 * （`values.inbox` / `values.workingDirectory` / …），`contextPressure` 挂在
 * 哪一层取决于他们怎么组织投影，换个版本就可能搬位置。
 * 按字段名找，比写死路径耐受得多。
 *
 * @returns {{tokens:number|null, projected:number|null, window:number|null, percent:number|null}}
 */
export function readPressure(value) {
  const empty = { tokens: null, projected: null, window: null, percent: null };
  if (!value || typeof value !== 'object') return empty;

  const seen = new Set();
  let found = null;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || found) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === 'contextPressure' && v && typeof v === 'object') {
        found = v;
        return;
      }
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(value, 0);
  if (!found) return empty;

  const num = (x) => (Number.isFinite(x) && Number(x) > 0 ? Number(x) : null);
  /**
   * 优先用 projectedTokens：它把"sample 之后新增/移除的东西"也估进去了，
   * 是"下一次请求真的要花多少"。pressureTokens 只是上一次的实数，会滞后。
   */
  const projected = num(found.projectedTokens);
  const tokens = num(found.pressureTokens);
  const window = num(found.contextWindow);
  const used = projected ?? tokens;
  const percent = used && window ? Math.min(100, (used / window) * 100) : null;
  return { tokens, projected, window, percent };
}

/**
 * 该不该压。
 *
 * 两个入口取"或"：有百分比就按百分比（准），没有就按轮数（粗但不会不触发）。
 * 轮数兜底是必要的——`contextPressure` 在服务商第一次回报 usage 之前是空的，
 * 而"没上报"不等于"没涨"。
 */
export function shouldCompact({ percent = null, turnsSince = 0, cfg = {} } = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  if (!c.enabled) return { compact: false, why: '没开' };
  if (percent != null && percent >= c.atPercent) {
    return { compact: true, why: `占用 ${percent.toFixed(1)}% ≥ ${c.atPercent}%` };
  }
  if (percent == null && turnsSince >= c.maxTurns) {
    return { compact: true, why: `没有用量数据，已聊 ${turnsSince} 轮 ≥ ${c.maxTurns}` };
  }
  return {
    compact: false,
    why: percent == null ? `没有用量数据，${turnsSince}/${c.maxTurns} 轮` : `占用 ${percent.toFixed(1)}% < ${c.atPercent}%`,
  };
}

const hhmm = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 新会话的开场。
 *
 * 三条硬要求，少一条她就会"失忆"或"露馅"：
 *   1. **必须有最近几轮原话**。只给摘要，「刚才那个」「上面说的第二个」就没了指代对象
 *      （实证 3.6.x-5：摘要要保留最近 N 轮的指代名词）。
 *   2. **明说这是接着聊**。不说明的话，模型看到一段摘要会当成"用户先发了一大段话"，
 *      回一句"好的，我了解了"——最尴尬的那种开场。
 *   3. **不许提"摘要"二字**。群里出现"根据上文摘要"这种话，一眼就是机器人换了窗口。
 */
export function buildOpening({ digests = [], recent = [], agreements = [], now = Date.now() } = {}) {
  const parts = ['（接着上面继续聊，这不是新话题。）'];

  if (digests.length) {
    parts.push(
      '【这几天】\n' +
        digests
          .slice(-3)
          .map((d) => `· ${dayOf(d.at || now)} ${String(d.text || '').trim()}`)
          .join('\n'),
    );
  }

  if (recent.length) {
    parts.push(
      '【刚才说到】\n' +
        recent
          .map((r) => `· ${r.role === 'bot' ? '你' : r.sender || '对方'}（${hhmm(r.at || now)}）：${String(r.digest || r.text || '').slice(0, 120)}`)
          .join('\n'),
    );
  }

  if (agreements.length) {
    parts.push('【答应过还没做的】\n' + agreements.map((a) => `· ${a}`).join('\n'));
  }

  parts.push('不要重新自我介绍，也不要说"根据摘要"之类的话，直接接着聊。');
  return parts.join('\n\n');
}

/**
 * 压缩的执行体。
 *
 * @param {object} o
 * @param {() => object} o.controllerOf  拿 DSH sessionController
 * @param {() => Promise<string>} o.workspaceIdOf
 * @param {object} o.sessions  createSessions()
 * @param {object} o.journal
 * @param {object} o.agreementsOf  (chatId) => string[]
 * @param {(chatId:string, text:string)=>void} [o.onOpening] 把开场交给宿主，等下一轮拼进消息
 */
export function createCompact({
  controllerOf,
  workspaceIdOf,
  sessions,
  journal,
  agreementsOf = () => [],
  onOpening = () => {},
  log = () => {},
  cfgOf = () => ({}),
  now = () => Date.now(),
} = {}) {
  /** 每个会话上次压缩之后的轮数（重启归零，可接受：重启后本来就要重新观察） */
  const turns = new Map();
  let last = null;

  const cfg = () => ({ ...DEFAULTS, ...(cfgOf()?.compact ?? {}) });

  function noteTurn(chatId) {
    turns.set(chatId, Number(turns.get(chatId) || 0) + 1);
  }

  /** 读这个会话的上下文占用。取不到就是 null，不抛错 */
  async function pressure(chatId) {
    const sid = sessions.get(chatId);
    if (!sid) return { tokens: null, projected: null, window: null, percent: null };
    try {
      const c = controllerOf();
      const v = await c.projections({ sessionId: sid });
      return readPressure(v);
    } catch (e) {
      log(`读上下文占用失败（不影响对话）：${e?.message ?? e}`);
      return { tokens: null, projected: null, window: null, percent: null };
    }
  }

  /**
   * 压一次。
   *
   * 顺序是刻意的：**先建新会话、落映射，再交开场**。
   * 反过来的话，中间失败会出现"开场给了但映射还指旧会话"，
   * 下一句话就进到旧窗口里，等于白压。
   */
  async function compact(chatId, chat = {}) {
    const sid = sessions.get(chatId);
    if (!sid) return { ok: false, why: '这个会话还没有 DSH 会话' };

    const c = cfg();
    let opening = '';
    try {
      opening = buildOpening({
        digests: journal.digests(chatId, c.keepDigests),
        recent: journal.recent(chatId, c.keepRecent).reverse(),
        agreements: agreementsOf(chatId) || [],
        now: now(),
      });
    } catch (e) {
      log(`拼开场失败：${e.message}`);
    }

    try {
      const ctrl = controllerOf();
      const r = await ctrl.create({ workspaceId: await workspaceIdOf(), agentPreset: chat.preset });
      const newSid = String(r.sessionId);
      if (!newSid) return { ok: false, why: '新会话没拿到 sessionId' };

      try {
        await ctrl.rename({ sessionId: newSid, title: `QQ · ${chat.name || chatId}（续）` });
      } catch {}

      sessions.set(chatId, newSid, { preset: chat.preset, title: chat.name });
      turns.set(chatId, 0);
      onOpening(chatId, opening);

      last = { at: now(), chatId, from: sid, to: newSid, openingLen: opening.length };
      log(`压缩 ${chatId.slice(0, 8)}：${sid.slice(-8)} → ${newSid.slice(-8)}，开场 ${opening.length} 字（旧会话保留）`);
      return { ok: true, from: sid, sessionId: newSid, opening };
    } catch (e) {
      log(`压缩失败：${e?.message ?? e}`);
      return { ok: false, why: e?.message ?? String(e) };
    }
  }

  /**
   * 收完一条消息后调一下：够阈值就压。
   *
   * **不抛错**：压缩是优化，不是主链路。压失败最多是上下文长一点，
   * 让它把对话弄挂就是本末倒置。
   */
  async function maybe(chatId, chat = {}) {
    const c = cfg();
    if (!c.enabled) return { compacted: false, why: '没开' };
    const p = await pressure(chatId);
    const d = shouldCompact({ percent: p.percent, turnsSince: turns.get(chatId) || 0, cfg: c });
    if (!d.compact) return { compacted: false, why: d.why, percent: p.percent };
    const r = await compact(chatId, chat);
    return { ...r, compacted: Boolean(r.ok), percent: p.percent, trigger: d.why };
  }

  return {
    noteTurn,
    pressure,
    maybe,
    compact,
    status: () => ({ last, turns: Object.fromEntries(turns), cfg: cfg() }),
  };
}
