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
  /**
   * 触发阈值**按场景分开**。
   *
   * 为什么不抄业界那个 70%~90%：那是编码 agent 的数字（工具输出巨大、
   * 质量下滑来得早，所以撑到最后才压）。聊天场景不一样——单轮几百字，
   * 而且我们有日记兜底，压掉的内容查得回来。
   *
   * 也不能沿用早期的 25%：用到四分之一就换会话，等于反复重铺上下文，
   * **每次换会话都会让 prompt cache 整段失效**（Claude Code 把"压缩后
   * 前缀仍可复用缓存"当招牌特性）。省下的 token 可能不够赔缓存。
   *
   * 60/40 后来也证明偏低：对照 `qq-dsh-bridge` 实测（阈值 15% → 95%，
   * 单步 45–55 秒 → 3–4 秒），压得越勤、命中率越低、每一步都变慢。
   * 现在抬到 85/75，留 15%/25% 余量容纳一次长回复的突增。
   * 真正的数字得看 `cacheHit`（`tokenUsage` 投影里现成的），
   * 面板「上下文 → 压缩」能直接看到压之前那一下的命中率。
   */
  atPercentGroup: 85,
  atPercentC2C: 75,
  /** 兼容旧配置：写了它就用它（两个场景同值） */
  atPercent: 0,
  /** 新会话开场里带几条最近原话（旧字段，被 keepRecent 覆盖后仅作兜底） */
  keepRecent: 8,
  /**
   * 开场配额：用户说的多留、她自己说的少留。
   *
   * 依据：Codex CLI 选择"用户消息永久逐字保留、只压缩模型回复"；
   * SillyTavern 的 Summaryception 用 3/9/27 分层。共同点是**用户原话权重更高**
   * ——指代（"那个""上面第二个"）几乎都出现在用户话里。
   */
  keepRecentUser: 8,
  keepRecentBot: 3,
  /** 没有用量数据时，聊到多少轮就压 */
  maxTurns: 40,
  /** 开场摘要最多带几条每日摘要 */
  keepDigests: 3,
};

const DAY = 86_400_000;

/**
 * 从 `session/projections` 的返回值里按字段名找一个投影。
 *
 * 为什么用"递归找"而不是取值路径：那个对象是 DSH 内部的投影集合
 * （`values.inbox` / `values.workingDirectory` / …），`contextPressure` 挂在
 * 哪一层取决于他们怎么组织投影，换个版本就可能搬位置。
 * 按字段名找，比写死路径耐受得多。
 */
function findProjection(value, name) {
  if (!value || typeof value !== 'object') return null;
  const seen = new Set();
  let found = null;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || found) return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === name && v && typeof v === 'object') {
        found = v;
        return;
      }
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(value, 0);
  return found;
}

/**
 * 从投影里读 `contextPressure`。
 *
 * @returns {{tokens:number|null, projected:number|null, window:number|null, percent:number|null}}
 */
export function readPressure(value) {
  const empty = { tokens: null, projected: null, window: null, percent: null };
  const found = findProjection(value, 'contextPressure');
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
 * 从投影里读 `tokenUsage` —— **prompt cache 的命中情况**。
 *
 * 这是"压缩阈值该定多少"唯一能拿来判断的实数。没有它，调阈值等于猜：
 * 压早了浪费缓存，压晚了溢出，两种都不报错。
 *
 * 字段来自 DSH 的 `tokenUsage` 投影（**整个会话累计**，不是单次请求）：
 *   uncachedInputTokens  没命中缓存、按全价计的输入
 *   cacheReadTokens      命中缓存读到的（约 1/10 价）
 *   cacheWriteTokens     写入缓存的（比全价还贵，1.25 倍）
 *   outputTokens         输出
 *
 * 命中率的分母是**三个互不重叠的计费桶之和**（和 DSH 自己的口径一致）：
 * 只除以 uncached 会算出 >100%，只除以全部输入会漏掉写入成本。
 *
 * @returns {{uncached:number|null, cacheRead:number|null, cacheWrite:number|null,
 *            output:number|null, billed:number|null, cacheHit:number|null}}
 */
export function readUsage(value) {
  const empty = {
    uncached: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    billed: null,
    cacheHit: null,
  };
  const found = findProjection(value, 'tokenUsage');
  if (!found) return empty;

  /** 这里 0 是合法值（还没发生过任何请求），不能像 pressure 那样把 0 当"没有" */
  const num = (x) => (Number.isFinite(x) && Number(x) >= 0 ? Number(x) : null);
  const uncached = num(found.uncachedInputTokens);
  const cacheRead = num(found.cacheReadTokens);
  const cacheWrite = num(found.cacheWriteTokens);
  const output = num(found.outputTokens);
  const parts = [uncached, cacheRead, cacheWrite];
  const billed = parts.every((x) => x != null) ? parts.reduce((a, b) => a + b, 0) : null;
  return {
    uncached,
    cacheRead,
    cacheWrite,
    output,
    billed,
    cacheHit: billed ? (cacheRead / billed) * 100 : null,
  };
}

/**
 * 这个场景用哪个阈值。
 *
 * 抽成函数是为了让"哪个群聊按多少、哪个私聊按多少"这件事可测——
 * 阈值写错的表现是"该压的时候没压"或"刚聊两句就换会话"，两种都不报错。
 *
 * 顺手挡一类配置写法事故：有人会写 `0.75` 想表达 75%。
 * 不认分数的话，阈值就成了 0.75% → **每轮都压**，而日志上只显示
 * "占用 12% ≥ 0.75%"，看起来还挺合理。所以小于 1 的一律按分数理解。
 * 边界取严格小于：`1` 有歧义（1% 还是 100%？），按 1% 算再抬到 10%——
 * 宁可多压一次也不要"永远不压"，那是会真的撑爆窗口的那个方向。
 * 再夹到 [10, 95]：低于 10 等于不停地换会话，高于 95 就来不及了。
 */
export function thresholdFor(cfg = {}, scene = 'c2c') {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const norm = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    const pct = n < 1 ? n * 100 : n;
    return Math.min(95, Math.max(10, pct));
  };
  if (Number(c.atPercent) > 0) return norm(c.atPercent, DEFAULTS.atPercentC2C); // 旧配置优先
  return norm(scene === 'group' ? c.atPercentGroup : c.atPercentC2C, DEFAULTS.atPercentC2C);
}

/**
 * 该不该压。
 *
 * 两个入口取"或"：有百分比就按百分比（准），没有就按轮数（粗但不会不触发）。
 * 轮数兜底是必要的——`contextPressure` 在服务商第一次回报 usage 之前是空的，
 * 而"没上报"不等于"没涨"。
 */
export function shouldCompact({ percent = null, turnsSince = 0, cfg = {}, scene = 'c2c' } = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  if (!c.enabled) return { compact: false, why: '没开', threshold: thresholdFor(c, scene) };
  const at = thresholdFor(c, scene);
  if (percent != null && percent >= at) {
    return { compact: true, why: `占用 ${percent.toFixed(1)}% ≥ ${at}%`, threshold: at };
  }
  if (percent == null && turnsSince >= c.maxTurns) {
    return { compact: true, why: `没有用量数据，已聊 ${turnsSince} 轮 ≥ ${c.maxTurns}`, threshold: at };
  }
  return {
    compact: false,
    why:
      percent == null
        ? `没有用量数据，${turnsSince}/${c.maxTurns} 轮`
        : `占用 ${percent.toFixed(1)}% < ${at}%`,
    threshold: at,
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
  /**
   * 最近几次压缩的现场：压的那一刻占用多少、命中率多少。
   *
   * 只留"压之前"的数——`tokenUsage` 是**按会话累计**的，压完就是新会话、
   * 从零开始，所以"压之后"要等新会话聊一阵子才有意义。面板同时显示
   * 旧会话压前的命中率和当前会话的实时命中率，两个数放在一起看才知道
   * 阈值该往上还是往下调。
   */
  const history = [];

  const cfg = () => ({ ...DEFAULTS, ...(cfgOf()?.compact ?? {}) });

  function noteTurn(chatId) {
    turns.set(chatId, Number(turns.get(chatId) || 0) + 1);
  }

  /** 读这个会话的上下文占用和缓存命中。取不到就是 null，不抛错 */
  async function pressure(chatId) {
    const sid = sessions.get(chatId);
    if (!sid) {
      return {
        tokens: null, projected: null, window: null, percent: null, usage: readUsage(null),
      };
    }
    try {
      const c = controllerOf();
      /**
       * `projections(request, signal)` 的第二个参数是**必填**的 AbortSignal。
       * 只传 request 时，DSH 内部 `signal.throwIfAborted()` 读到 undefined，
       * 抛 `Cannot read properties of undefined (reading 'aborted')`——
       * 于是压缩每轮都报「读上下文占用失败」，永远拿不到压力、永远不压。
       */
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5000);
      try {
        const v = await c.projections({ sessionId: sid }, ac.signal);
        // 一次投影调用同时读压力和用量，不为了两个数跑两趟
        return { ...readPressure(v), usage: readUsage(v) };
      } finally {
        clearTimeout(t);
      }
    } catch (e) {
      log(`读上下文占用失败（不影响对话）：${e?.message ?? e}`);
      return {
        tokens: null, projected: null, window: null, percent: null, usage: readUsage(null),
      };
    }
  }

  /**
   * 压一次。
   *
   * 顺序是刻意的：**先建新会话、落映射，再交开场**。
   * 反过来的话，中间失败会出现"开场给了但映射还指旧会话"，
   * 下一句话就进到旧窗口里，等于白压。
   */
  async function compact(chatId, chat = {}, snap = null) {
    const sid = sessions.get(chatId);
    if (!sid) return { ok: false, why: '这个会话还没有 DSH 会话' };

    const c = cfg();
    let opening = '';
    try {
      /**
       * 开场按角色配额挑，不是简单取最近 N 条（第 3 批 C4）。
       *
       * 依据：Codex CLI 是"用户消息永久逐字保留、只压缩模型回复"；
       * SillyTavern 的 Summaryception 用 3/9/27 分层。共同点是
       * **用户原话权重更高**——指代（"那个""上面第二个"）几乎都在用户话里，
       * 而她自己的话被复述错一句，反而是"人设崩塌"。
       *
       * 多取一些再分（40 条），因为 8 条用户消息可能散落在 30 条里。
       */
      const pool = journal.recent(chatId, 40);
      const users = pool.filter((r) => r.role !== 'bot').slice(0, Number(c.keepRecentUser) || 8);
      const bots = pool.filter((r) => r.role === 'bot').slice(0, Number(c.keepRecentBot) || 3);
      const recent = [...users, ...bots].sort((a, b) => a.at - b.at);

      opening = buildOpening({
        digests: journal.digests(chatId, c.keepDigests),
        recent,
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
      /**
       * 记现场：**压那一刻**旧会话的占用和缓存命中率。
       *
       * 这是调阈值唯一的数据来源。压完就换新会话，`tokenUsage` 从零开始，
       * 所以"压之后"永远拿不到——只能拿它跟当前会话的实时命中率对比着看。
       */
      history.push({
        at: last.at,
        chatId,
        percent: snap?.percent ?? null,
        cacheHit: snap?.usage?.cacheHit ?? null,
        tokens: snap?.usage?.billed ?? null,
      });
      if (history.length > 10) history.shift();
      const hit = snap?.usage?.cacheHit;
      log(
        `压缩 ${chatId.slice(0, 8)}：${sid.slice(-8)} → ${newSid.slice(-8)}，` +
          `开场 ${opening.length} 字（旧会话保留）` +
          (hit == null ? '' : `，压前缓存命中 ${hit.toFixed(1)}%`),
      );
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
    const scene = chat.kind === 'group' ? 'group' : 'c2c';
    const p = await pressure(chatId);
    const d = shouldCompact({ percent: p.percent, turnsSince: turns.get(chatId) || 0, cfg: c, scene });
    if (!d.compact) {
      return {
        compacted: false, why: d.why, percent: p.percent, threshold: d.threshold, cacheHit: p.usage.cacheHit,
      };
    }
    const r = await compact(chatId, chat, p);
    return {
      ...r,
      compacted: Boolean(r.ok),
      percent: p.percent,
      trigger: d.why,
      threshold: d.threshold,
      cacheHit: p.usage.cacheHit,
    };
  }

  return {
    noteTurn,
    pressure,
    maybe,
    compact,
    status: () => ({ last, history: [...history], turns: Object.fromEntries(turns), cfg: cfg() }),
  };
}
